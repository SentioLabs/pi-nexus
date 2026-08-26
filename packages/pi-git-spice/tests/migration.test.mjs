import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-git-spice-plugin.py");

const writeFixtureFile = (root, relativePath, content) => {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const prompt = (description, body, argumentHint) => [
  "---",
  `description: ${description}`,
  ...(argumentHint ? [`argument-hint: ${argumentHint}`] : []),
  "---",
  "",
  body,
  "Fixture source body remains.",
  "/git-spice:custom-source-reference",
  "",
].join("\n");

const skill = (name, description, body) => [
  "---",
  `name: ${name}`,
  `description: ${description}`,
  "---",
  "",
  body,
  "",
].join("\n");

const agent = (description, tools, body) => [
  "---",
  `description: ${description}`,
  "tools:",
  ...tools.map((tool) => `  - ${tool}`),
  "model: sonnet",
  "---",
  "",
  body,
  "",
].join("\n");

const sourceFiles = () => ({
  "commands/continue.md": prompt("Resume a git-spice operation", [
    "# Continue",
    "Resume — or abort — a git-spice operation that was paused on a rebase conflict.",
    "Parse `$ARGUMENTS` and run `git-spice rebase continue`.",
    "To abandon a rebase, run `git-spice rebase abort`.",
  ].join("\n"), "[--abort]"),
  "commands/init.md": prompt("Initialize git-spice", [
    "# Init",
    "Confirm you're inside a git repository:",
    "2. Check whether git-spice is already initialized: `git-spice log long 2>&1`. If it succeeds and shows a trunk, tell the user it's already initialized and offer to re-init with `git-spice repo init --reset` only if they ask.",
    "3. Run `git-spice repo init`. If `$ARGUMENTS` was provided, treat it as either a trunk branch name or `--trunk=<name> --remote=<name>` flags and pass it through. Otherwise let the interactive prompt run.",
  ].join("\n"), "[trunk-name | --trunk=<name> --remote=<name>]"),
  "commands/new.md": prompt("Create a stacked branch", [
    "# New",
    "Create a new branch on top of the current one with `git-spice branch create`.",
    "1. Parse `$ARGUMENTS` as the branch name. If empty, ask the user for one (or note that git-spice will auto-generate from the commit message if `--no-commit` isn't used).",
    "Clean trees use `git-spice branch create <name> --no-commit`.",
  ].join("\n"), "<branch-name>"),
  "commands/restack.md": prompt("Restack branches", [
    "# Restack",
    "Rebase one or more branches onto their (current) bases.",
    "Run `git-spice stack restack` and direct conflicts to `/git-spice:continue`.",
  ].join("\n"), "[branch|upstack|stack|repo]"),
  "commands/stack.md": prompt("Show the current stack", [
    "# Stack",
    "Run `git-spice log long` and present the output to the user verbatim.",
    "Use `/git-spice:restack` when needed.",
  ].join("\n")),
  "commands/submit.md": prompt("Submit a stack", [
    "# Submit",
    "Submit the stack (or a slice of it) as PRs/MRs.",
    "Parse `$ARGUMENTS` and run `git-spice stack submit --dry-run --fill` before `git-spice stack submit --fill`.",
    "Use `/git-spice:submit` to submit again.",
  ].join("\n"), "[branch|upstack|downstack|stack] [extra flags]"),
  "commands/sync.md": prompt("Sync merged branches", [
    "# Sync",
    "Sync with the remote: pull trunk, delete merged branches, restack survivors.",
    "Run `git-spice repo sync --restack` and recover with `/git-spice:continue`.",
  ].join("\n")),
  "skills/git-spice/SKILL.md": skill("git-spice", "Reference for git-spice stacked branches.", [
    "# git-spice",
    "",
    "## Command map",
    "Use `git-spice log long` to inspect a stack.",
    "For work run `git-spice branch create <slug>` (`git-spice bc`).",
    "After conflicts, run `git-spice rebase continue` (`git-spice rbc`).",
    "```bash",
    "git-spice branch create feat-a",
    "```",
    "",
    "## Dispatching the subagents",
    "Dispatch via the Task tool with `subagent_type: git-spice:stacker` or `subagent_type: git-spice:stack-doctor`.",
    "",
    "## Configuration",
  ].join("\n")),
  "skills/stacking-workflow/SKILL.md": skill("stacking-workflow", "Build reviewable dependent branch stacks.", [
    "# Stacking workflow",
    "",
    "Use `git-spice branch create <slug>` for a completed task.",
    "After conflicts, run `git-spice rebase continue`.",
    "",
    "## Driving with subagents",
    "Dispatch via the Task tool with `subagent_type: git-spice:stacker` or `subagent_type: git-spice:stack-doctor`.",
    "",
    "## Don't",
  ].join("\n")),
  "agents/stack-doctor.md": agent("Use this agent to diagnose and repair a wedged git-spice stack.", ["Bash", "Read", "Glob", "Grep"], [
    "# Stack Doctor Agent",
    "",
    "## Diagnosis checklist",
    "Run `git-spice rebase continue` only after a diagnosis.",
    "For a known repair, run `git-spice <scope> submit --fill`.",
    "## Repair principles",
  ].join("\n")),
  "agents/stacker.md": agent("Use this agent to build a stack of dependent git-spice branches from an ordered list of changes.", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], [
    "# Stacker Agent",
    "",
    "## Non-interactive discipline",
    "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit message defaults to the staged changes; if the task description maps to a clean conventional-commit subject, prefer `git-spice branch create <name> -m \"<subject>\"`.",
  ].join("\n")),
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "git-spice",
    description: "Fixture git-spice plugin.",
    version: "1.0.0",
    author: { name: "Fixture", url: "https://example.test" },
    repository: "https://example.test/repository",
    homepage: "https://example.test/home",
    license: "MIT",
    keywords: ["git-spice"],
  }, null, 2) + "\n",
  "CHANGELOG.md": "# Upstream changelog\n",
  "version.txt": "1.0.0\n",
});

const createSourceFixture = (overrides = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-git-spice-source-"));
  const files = { ...sourceFiles(), ...overrides };
  for (const [relative, content] of Object.entries(files)) writeFixtureFile(root, relative, content);
  return root;
};

const createTemporaryPackage = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-git-spice-package-"));
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "migrate-git-spice-plugin.py");
  copyFileSync(migrationScript, script);
  return { root, script };
};

const runMigration = (script, source, cwd) => spawnSync("python3", ["-B", script, source], {
  cwd,
  encoding: "utf8",
});

const runtimeSnapshot = (root) => {
  const manifest = JSON.parse(execFileSync("python3", ["-B", "-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([target for _, target in module.RUNTIME_MANIFEST]))",
  ].join("; "), migrationScript], { encoding: "utf8" }));
  return new Map(manifest.map((relative) => [relative, readFileSync(path.join(root, relative))]));
};

const installProbe = (exceptionExpression) => [
  "import importlib.util, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  `fail_at = ${exceptionExpression.includes("KeyboardInterrupt") ? 3 : 2}`,
  "calls = {'swaps': 0}",
  "original = module.rename_path",
  "def failing_move(source, destination):",
  "    if source.parent.name == 'staged':",
  "        calls['swaps'] += 1",
  `        if calls['swaps'] == fail_at: raise ${exceptionExpression}`,
  "    return original(source, destination)",
  "module.rename_path = failing_move",
  "sys.argv = [sys.argv[1], sys.argv[2]]",
  "module.main()",
].join("\n");

const installedSentinels = (root) => {
  for (const name of ["prompts", "skills", "agents"]) writeFixtureFile(root, `${name}/sentinel.txt`, `${name} original\n`);
  return new Map(["prompts", "skills", "agents"].map((name) => [name, readFileSync(path.join(root, name, "sentinel.txt"))]));
};

const assertRollback = (root, sentinels) => {
  for (const [name, bytes] of sentinels) assert.deepEqual(readFileSync(path.join(root, name, "sentinel.txt")), bytes, name);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".pi-git-spice-install-")),
    [],
    "transaction staging and backup directories",
  );
};

const inlineGitSpiceCommands = (text, operation) => Array.from(
  text.matchAll(new RegExp("`(git-spice(?: --no-prompt)? " + operation + "[^`]*)`", "g")),
  ([, command]) => command,
);

const assertSafeBranchCreation = (text, context) => {
  const commands = Array.from(text.matchAll(/git-spice(?: --no-prompt)? branch create[^\n`]*/g), ([command]) => command.trim());
  assert.ok(commands.length > 0, `${context} contains branch creation guidance`);
  for (const command of commands) {
    assert.match(command, /^git-spice --no-prompt branch create /, command);
    assert.match(command, /(?:^| )-m (?:"[^"]+"|<[^>]+>)|--no-commit/, command);
  }
};

const assertSafeRebaseContinuation = (text, context) => {
  const commands = inlineGitSpiceCommands(text, "rebase continue");
  assert.ok(commands.length > 0, `${context} contains rebase continuation guidance`);
  for (const command of commands) assert.equal(command, "git-spice --no-prompt rebase continue --no-edit", context);
};

test("migration CLI accepts positional and option source forms", () => {
  const help = execFileSync("python3", [migrationScript, "--help"], { encoding: "utf8" });
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const optionResult = spawnSync("python3", ["-B", packageCopy.script, "--source", source], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  assert.equal(optionResult.status, 0, optionResult.stderr);
});

test("invalid source fails before rewriting installed resources", () => {
  const source = mkdtempSync(path.join(os.tmpdir(), "pi-git-spice-invalid-"));
  const packageCopy = createTemporaryPackage();
  writeFixtureFile(packageCopy.root, "prompts/sentinel.txt", "original prompts\n");
  writeFixtureFile(packageCopy.root, "skills/sentinel.txt", "original skills\n");
  writeFixtureFile(packageCopy.root, "agents/sentinel.txt", "original agents\n");
  const sentinels = new Map([
    ["prompts", Buffer.from("original prompts\n")],
    ["skills", Buffer.from("original skills\n")],
    ["agents", Buffer.from("original agents\n")],
  ]);
  const result = runMigration(packageCopy.script, source, packageCopy.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing expected paths/);
  assert.equal(readFileSync(path.join(packageCopy.root, "prompts/sentinel.txt"), "utf8"), "original prompts\n");
  assertRollback(packageCopy.root, sentinels);
});

test("unclassified source files fail closed", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  writeFixtureFile(source, "commands/future.md", "# Future\n");
  const result = runMigration(packageCopy.script, source, packageCopy.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unclassified source file/);
  assertRollback(packageCopy.root, sentinels);
});

test("fixture regeneration is byte-for-byte deterministic", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const first = runtimeSnapshot(packageCopy.root);
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  for (const [relative, bytes] of first) assert.deepEqual(readFileSync(path.join(packageCopy.root, relative)), bytes, relative);
});

test("migration transforms source bodies while applying Pi safety adaptations", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const prompts = Object.fromEntries(Object.keys(sourceFiles())
    .filter((relative) => relative.startsWith("commands/"))
    .map((relative) => [relative, readFileSync(path.join(packageCopy.root, "prompts", `git-spice-${path.basename(relative)}`), "utf8")]));
  const combinedPrompts = Object.values(prompts).join("\n");
  assert.match(combinedPrompts, /git-spice --no-prompt repo init --trunk=<name> --remote=<name>/);
  assert.match(combinedPrompts, /separate explicit confirmation/i);
  assert.match(combinedPrompts, /draft/i);
  assert.doesNotMatch(combinedPrompts, /\/git-spice:/);
  for (const [relative, output] of Object.entries(prompts)) {
    assert.match(output, /Fixture source body remains\./);
    assert.match(output, /\/git-spice-custom-source-reference/);
  }
  assertSafeBranchCreation(prompts["commands/new.md"], "new prompt");
  assertSafeRebaseContinuation(prompts["commands/continue.md"], "continue prompt");

  for (const relative of ["skills/git-spice/SKILL.md", "skills/stacking-workflow/SKILL.md"]) {
    const output = readFileSync(path.join(packageCopy.root, relative), "utf8");
    assert.match(output, /If the subagent tool is available, list agents first/);
    assert.match(output, /git-spice\.stacker/);
    assert.match(output, /direct workflow instead/);
    assert.doesNotMatch(output, /subagent_type|Task tool/);
    assertSafeBranchCreation(output, relative);
    assertSafeRebaseContinuation(output, relative);
  }

  const stacker = readFileSync(path.join(packageCopy.root, "agents/stacker.md"), "utf8");
  assert.match(stacker, /name: stacker/);
  assert.match(stacker, /package: git-spice/);
  assert.match(stacker, /description: Use this agent to build a stack of dependent git-spice branches/);
  assert.match(stacker, /tools: bash, read, write, edit, find, grep/);
  assert.doesNotMatch(stacker, /model: sonnet/);
  assertSafeBranchCreation(stacker, "stacker agent");

  const doctor = readFileSync(path.join(packageCopy.root, "agents/stack-doctor.md"), "utf8");
  assertSafeRebaseContinuation(doctor, "stack-doctor agent");
  const submitMutations = inlineGitSpiceCommands(doctor, "(?:branch|upstack|downstack|stack|<scope>) submit");
  assert.ok(submitMutations.length > 0, "stack-doctor contains submit guidance");
  for (const command of submitMutations) {
    assert.match(command, /^git-spice --no-prompt /, command);
    if (!command.endsWith(" submit")) assert.match(command, /--draft|--no-draft|<draft-flag>/, command);
  }
  assert.match(doctor, /--draft.*--no-draft|--no-draft.*--draft/s);
  assert.match(doctor, /never rely on an implicit draft state/i);
});

test("prompt source revisions and every git-spice reference survive semantic transformation", () => {
  const revised = sourceFiles()["commands/restack.md"]
    .replace("Run `git-spice stack restack`", "Fixture prompt revision: preserve this instruction. Run `git-spice stack restack`")
    .replace("/git-spice:continue", "/git-spice:continue and /git-spice:continue");
  const source = createSourceFixture({ "commands/restack.md": revised });
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const output = readFileSync(path.join(packageCopy.root, "prompts/git-spice-restack.md"), "utf8");
  assert.match(output, /Fixture prompt revision: preserve this instruction/);
  assert.equal((output.match(/\/git-spice-continue/g) ?? []).length, 2);
  assert.doesNotMatch(output, /\/git-spice:continue/);
});

for (const [name, overrides, diagnostic] of [
  ["invalid plugin metadata", { ".claude-plugin/plugin.json": "[]\n" }, /expected an object/],
  ["unsupported prompt frontmatter", { "commands/init.md": prompt("init", "git-spice repo init", "[x]").replace("description: init", "unknown: value") }, /Unsupported source prompt frontmatter/],
  ["unsupported skill frontmatter", { "skills/git-spice/SKILL.md": skill("git-spice", "valid", "# git-spice").replace("name: git-spice", "unknown: nope") }, /Unsupported source skill frontmatter|Source skill name/],
  ["unsupported agent frontmatter", { "agents/stacker.md": agent("valid", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], "# Stacker Agent\n## Non-interactive discipline").replace("model: sonnet", "model: opus") }, /Source agent model/],
  ["removed semantic anchor", { "commands/init.md": sourceFiles()["commands/init.md"].replace("Confirm you're inside a git repository:", "Confirm setup:") }, /Expected exactly one source text occurrence/],
  ["duplicated semantic anchor", { "commands/init.md": sourceFiles()["commands/init.md"] + "Confirm you're inside a git repository:\n" }, /Expected exactly one source text occurrence/],
]) {
  test(`${name} fails before installation`, () => {
    const source = createSourceFixture(overrides);
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assertRollback(packageCopy.root, sentinels);
  });
}

for (const [name, exceptionExpression, rootSwap] of [["OSError", "OSError('injected move failure')", "second"], ["KeyboardInterrupt", "KeyboardInterrupt()", "third"]]) {
  test(`${name} during the ${rootSwap} root swap restores every installed root`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const result = spawnSync("python3", ["-B", "-c", installProbe(exceptionExpression), packageCopy.script, source], {
      cwd: packageCopy.root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected move failure|KeyboardInterrupt/);
    assertRollback(packageCopy.root, sentinels);
  });
}
