import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-git-spice-plugin.py");
const temporaryRoots = new Set();

const makeTemporaryDirectory = (prefix) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
};

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

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
  "/git-spice:stack",
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

const rawSourceFiles = () => ({
  "commands/continue.md": prompt("Resume a git-spice operation after resolving rebase conflicts (or abort with --abort)", [
    "# Continue",
    "Resume — or abort — a git-spice operation that was paused on a rebase conflict.",
    "Parse `$ARGUMENTS` and run `git-spice rebase continue`.",
    "To abandon a rebase, run `git-spice rebase abort`.",
    "Why `git-spice rebase continue` and not `git rebase --continue`? git-spice's wrapper resumes the *outer* operation (e.g., a stack restack across N branches). Plain `git rebase --continue` only finishes the current branch's rebase and leaves git-spice's queue stalled.",
  ].join("\n"), "[--abort]"),
  "commands/init.md": prompt("Initialize git-spice in the current repo (sets trunk + remote, checks auth)", [
    "# Init",
    "Initialize git-spice for this repository.",
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
    "- If a restack appears pending (git-spice may flag this): note that and suggest `/git-spice-restack`.",
  ].join("\n")),
  "commands/submit.md": prompt("Submit a stack", [
    "# Submit",
    "Submit the stack (or a slice of it) as PRs/MRs.",
    "Parse `$ARGUMENTS` and run `git-spice stack submit --dry-run --fill` before `git-spice stack submit --fill`.",
    "Use `/git-spice:submit` to submit again.",
    "5. After submit, summarize: which CRs were created vs updated, and the URLs (git-spice prints them).",
  ].join("\n"), "[branch|upstack|downstack|stack] [extra flags]"),
  "commands/sync.md": prompt("Sync merged branches", [
    "# Sync",
    "Sync with the remote: pull trunk, delete merged branches, restack survivors.",
    "Run `git-spice repo sync --restack` and recover with `/git-spice:continue`.",
  ].join("\n")),
  "skills/git-spice/SKILL.md": skill("git-spice", "Reference for the git-spice CLI — stacked-branch workflows, command map, and recovery from interrupted rebases. This skill should be used whenever the user mentions git-spice, `gs`, stacked PRs, stacked diffs, branch stacks, dependent branches, PRs that depend on each other, or says things like \"stack this\", \"check the stack\", \"submit the stack\", \"submit my stacked PRs\", \"restack\", \"rebase failed\", \"sync after merge\", \"what's on top of <branch>\", \"branch above/below\". Also load when a multi-step plan would naturally produce a chain of dependent branches and you need to drive that with the CLI, or when an interrupted rebase needs recovery.", [
    "# git-spice",
    "",
    "git-spice is a CLI for managing **stacks of dependent Git branches**. Each branch (except the trunk) has a recorded *base* — the branch it was created from. git-spice tracks those relationships, restacks (rebases) dependents automatically when a base changes, and submits the whole chain as separate-but-linked Change Requests (CRs — PRs on GitHub, MRs on GitLab).",
    "The official shorthand is `gs`, but on many systems `gs` is **Ghostscript**. **Always invoke `git-spice` directly** in scripts, commands, and tool calls — never assume `gs` is git-spice. (If a user types `gs` in chat, mentally map it to `git-spice`.)",
    "- **base** — the branch a given branch was created from. Stored as metadata by git-spice.",
    "",
    "## Command map",
    "git-spice operations are *local-first*. Auth is only needed for `submit`/`sync` (network operations).",
    "| Initialize git-spice in this repo | `git-spice repo init --trunk=<name> --remote=<name>` (`git-spice r i`) |",
    "> Prefer `git-spice commit ...` over raw `git commit` while inside a stack. The git-spice variants restack everything above the current branch automatically; `git commit` leaves upstack branches misaligned and you'll have to run `git-spice upstack restack` yourself.",
    "git-spice rebases run `git rebase` under the hood. Conflicts pause the operation. **Resolve with the git-spice variants, not raw git:**",
    "2. Run `git-spice rebase continue`. git-spice resumes its multi-branch operation (e.g., a stack restack continues onto the next branch).",
    "Using raw `git rebase --continue` works for the *current* rebase only; git-spice won't auto-advance to the next branch in a multi-step operation.",
    "- **Don't `git push --force`** on a tracked branch. Use `git-spice <scope> submit <draft-flag>` — git-spice uses `--force-with-lease` semantics and updates only the branches that need it.",
    "- **Don't assume `gs`** is git-spice in commands you write. Always `git-spice`.",
    "- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. Use `git-spice upstack restack`, or `git-spice branch edit` when the user is driving interactively.",
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
  "agents/stack-doctor.md": agent("Use this agent to diagnose and repair a wedged git-spice stack — interrupted rebases, branches diverged from their bases, untracked branches that should be tracked, wrong trunk recorded, or generally confused state. Dispatch when manual fixes aren't working or when the failure mode isn't obvious. Read-mostly during diagnosis; mutations only after explaining the plan in the report.", ["Bash", "Read", "Glob", "Grep"], [
    "# Stack Doctor Agent",
    "",
    "You diagnose and repair broken git-spice stacks. Default to *read-only* during diagnosis. Mutations are deliberate, narrowly scoped, and explained in your final report. You have a fresh context — everything you need is in the dispatch prompt and what you discover by inspecting the repo.",
    "2. **Never `git rebase --continue` directly during a git-spice operation.** Use `git-spice rebase continue`. Plain git only finishes the inner rebase and leaves git-spice's outer queue stalled.",
    "## Diagnosis checklist",
    "Run `git-spice rebase continue` only after a diagnosis.",
    "For a known repair, run `git-spice <scope> submit --fill`.",
    "| Branches exist in git but not in `log long --all` | untracked | `git-spice branch track` per branch, or `git-spice downstack track` from the top |",
    "## Repair principles",
  ].join("\n")),
  "agents/stacker.md": agent("Use this agent to build a stack of dependent git-spice branches from an ordered list of changes. Dispatch when you have a multi-step plan whose pieces must ship in order and you want the execution loop (implement → stage → branch create → repeat) handled in a single pass. Receives the task list and the starting branch in its prompt; reports back per-branch results.", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], [
    "# Stacker Agent",
    "",
    "You build a stack of git-spice branches from an ordered list of changes. You receive the list, the starting branch, and any context the dispatcher chose to include. You have a fresh context — everything you need is in the dispatch prompt.",
    "You run unattended — an interactive prompt will hang you. Always pass explicit arguments (branch names, commit messages) and add the global `--no-prompt` flag to git-spice commands so missing information fails fast instead of prompting. A `--no-prompt` failure is a `BLOCKED`/`NEEDS_CONTEXT` signal, not something to work around.",
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

const commandAnchorPattern = /(?<![\w-])git-spice(?= (?:repo|auth|log|branch|commit|upstack|downstack|stack|rebase|trunk|top|bottom|up|down|<scope>)(?:\s|`|$))/g;
const mutationAnchorPatterns = {
  reset: /git-spice(?: --no-prompt)? repo init(?=[^`\n]*--reset)/g,
  init: /git-spice(?: --no-prompt)? repo init(?![^`\n]*--reset)(?=[\s`])/g,
  branchCreate: /git-spice(?: --no-prompt)? branch create(?=[\s`])/g,
  rebaseContinue: /git-spice(?: --no-prompt)? rebase continue(?=[\s`])/g,
  rebaseAbort: /git-spice(?: --no-prompt)? rebase abort(?=[\s`])/g,
  restack: /git-spice(?: --no-prompt)? (?:branch|upstack|downstack|stack|repo) restack(?=[\s`])/g,
  sync: /git-spice(?: --no-prompt)? repo sync(?=[\s`])/g,
  submit: /git-spice(?: --no-prompt)? (?:branch|upstack|downstack|stack|<scope>) submit(?=[\s`])/g,
};
const expectedCommandAnchorCounts = {
  "commands/continue.md": 4,
  "commands/init.md": 6,
  "commands/new.md": 5,
  "commands/restack.md": 5,
  "commands/stack.md": 2,
  "commands/submit.md": 4,
  "commands/sync.md": 3,
  "skills/git-spice/SKILL.md": 96,
  "skills/stacking-workflow/SKILL.md": 12,
  "agents/stack-doctor.md": 24,
  "agents/stacker.md": 10,
};
const expectedMutationAnchorCounts = {
  "commands/continue.md": { rebaseContinue: 2, rebaseAbort: 1 },
  "commands/init.md": { init: 1, reset: 1 },
  "commands/new.md": { branchCreate: 4 },
  "commands/restack.md": { restack: 4 },
  "commands/submit.md": { submit: 2 },
  "commands/sync.md": { sync: 1 },
  "skills/git-spice/SKILL.md": { init: 3, reset: 2, branchCreate: 12, rebaseContinue: 3, rebaseAbort: 2, restack: 11, sync: 3, submit: 8 },
  "skills/stacking-workflow/SKILL.md": { branchCreate: 1, rebaseContinue: 1, restack: 1, sync: 1, submit: 1 },
  "agents/stack-doctor.md": { init: 2, rebaseContinue: 3, restack: 7, submit: 3 },
  "agents/stacker.md": { branchCreate: 3, submit: 2 },
};
const aliasCommandAnchorPattern = /(?<![\w-])git-spice(?= (?:r|ls|ll|bdi|bc|btr|dstr|cc|ca|csp|cf|cp|bco|br|usr|dsr|sr|rr|bsq|bsp|be|bfo|bon|uso|se|dse|brn|bd|sd|usd|buntr|bs|dss|uss|ss|rs|rbc|rba)(?:\s|`|\)))/g;
const expectedAliasNames = {
  r: 1, ls: 2, ll: 2, bdi: 1, bc: 1, btr: 1, dstr: 1, cc: 1, ca: 1, csp: 1, cf: 1, cp: 1,
  bco: 1, br: 1, usr: 1, dsr: 1, sr: 1, rr: 1, bsq: 1, bsp: 1, be: 1, bfo: 1, bon: 1, uso: 1,
  se: 1, dse: 1, brn: 1, bd: 1, sd: 1, usd: 1, buntr: 1, bs: 1, dss: 1, uss: 1, ss: 1, rs: 1,
  rbc: 1, rba: 1,
};
const expectedAliasCommandAnchorCounts = { "skills/git-spice/SKILL.md": 40 };

const mutationPadding = {
  reset: "Fixture reset mutation: `git-spice repo init --reset`.",
  init: "Fixture init mutation: `git-spice repo init`.",
  branchCreate: "Fixture branch mutation: `git-spice branch create <fixture> -m \"fixture\"`.",
  rebaseContinue: "Fixture continue mutation: `git-spice rebase continue`.",
  rebaseAbort: "Fixture abort mutation: `git-spice rebase abort`.",
  restack: "Fixture restack mutation: `git-spice branch restack`.",
  sync: "Fixture sync mutation: `git-spice repo sync`.",
  submit: "Fixture submit mutation: `git-spice stack submit --fill`.",
};

const countMatches = (text, pattern) => Array.from(text.matchAll(pattern)).length;

const padExpectedAnchors = (relative, content) => {
  let padded = content;
  const body = () => padded.slice(padded.indexOf("\n---\n", 4) + 5);
  const expectedMutations = expectedMutationAnchorCounts[relative] ?? {};
  for (const name of ["reset", "init", "branchCreate", "rebaseContinue", "rebaseAbort", "restack", "sync", "submit"]) {
    const expected = expectedMutations[name] ?? 0;
    const actual = countMatches(body(), mutationAnchorPatterns[name]);
    assert.ok(actual <= expected, `${relative} ${name} fixture starts within expected cardinality`);
    padded += `${Array.from({ length: expected - actual }, () => mutationPadding[name]).join("\n")}\n`;
  }
  if (relative === "skills/git-spice/SKILL.md") {
    for (const [alias, expected] of Object.entries(expectedAliasNames)) {
      const pattern = new RegExp(`(?<![\\w-])git-spice ${alias}(?=\\s|\\\`|\\))`, "g");
      const actual = countMatches(body(), pattern);
      assert.ok(actual <= expected, `${relative} ${alias} alias fixture starts within expected cardinality`);
      const invocation = alias === "r" ? "r i" : alias;
      padded += `${Array.from({ length: expected - actual }, () => `Fixture alias command anchor: \`git-spice ${invocation}\`.`).join("\n")}\n`;
    }
  }
  const expectedAliases = expectedAliasCommandAnchorCounts[relative] ?? 0;
  const actualAliases = countMatches(body(), aliasCommandAnchorPattern);
  assert.equal(actualAliases, expectedAliases, `${relative} alias command fixture cardinality`);
  const expectedCommands = expectedCommandAnchorCounts[relative];
  const actualCommands = countMatches(body(), commandAnchorPattern);
  assert.ok(actualCommands <= expectedCommands, `${relative} command fixture starts within expected cardinality`);
  padded += `${Array.from({ length: expectedCommands - actualCommands }, () => "Fixture command anchor: `git-spice log long`.").join("\n")}\n`;
  return padded;
};

const sourceFiles = () => Object.fromEntries(Object.entries(rawSourceFiles()).map(([relative, content]) => [
  relative,
  relative.endsWith(".md") && !relative.endsWith("CHANGELOG.md") ? padExpectedAnchors(relative, content) : content,
]));

const createSourceFixture = (overrides = {}) => {
  const root = makeTemporaryDirectory("pi-git-spice-source-");
  const files = { ...sourceFiles(), ...overrides };
  for (const [relative, content] of Object.entries(files)) writeFixtureFile(root, relative, content);
  return root;
};

const createTemporaryPackage = () => {
  const root = makeTemporaryDirectory("pi-git-spice-package-");
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
  const source = makeTemporaryDirectory("pi-git-spice-invalid-");
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
    assert.match(output, /\/git-spice-stack/);
  }
  assertSafeBranchCreation(prompts["commands/new.md"], "new prompt");
  assertSafeRebaseContinuation(prompts["commands/continue.md"], "continue prompt");
  assert.match(prompts["commands/continue.md"], /missing configuration[\s\S]*report[\s\S]*rather than enabling prompts/i);

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
  assert.match(doctor, /git-spice --no-prompt branch track <branch>/);
  assert.match(doctor, /git-spice --no-prompt downstack track <top-branch>/);
  assert.match(doctor, /gather or derive[\s\S]*branch name/i);
  assert.match(doctor, /ambiguous[\s\S]*missing configuration[\s\S]*rather than enabling prompts/i);
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

const validPluginMetadata = () => JSON.parse(rawSourceFiles()[".claude-plugin/plugin.json"]);
const metadataVariants = [
  ["plugin metadata missing field", () => {
    const metadata = validPluginMetadata();
    delete metadata.homepage;
    return JSON.stringify(metadata);
  }, /fields must exactly match.*missing=.*homepage/s],
  ["plugin metadata duplicate top-level key", () => rawSourceFiles()[".claude-plugin/plugin.json"].replace('"name": "git-spice",', '"name": "git-spice",\n  "name": "duplicate",'), /Duplicate JSON key.*name/],
  ["plugin metadata duplicate nested key", () => rawSourceFiles()[".claude-plugin/plugin.json"].replace('"name": "Fixture",', '"name": "Fixture",\n    "name": "duplicate",'), /Duplicate JSON key.*name/],
  ["plugin metadata unknown field", () => {
    const metadata = validPluginMetadata();
    metadata.future = true;
    return JSON.stringify(metadata);
  }, /fields must exactly match.*unknown=.*future/s],
  ["plugin metadata malformed JSON", () => "{ not-json\n", /Invalid source plugin\.json/],
  ["plugin metadata whitespace-only scalar", () => {
    const metadata = validPluginMetadata();
    metadata.description = "   \t";
    return JSON.stringify(metadata);
  }, /description must be a non-empty string/],
  ["plugin metadata whitespace-only author scalar", () => {
    const metadata = validPluginMetadata();
    metadata.author.url = "  ";
    return JSON.stringify(metadata);
  }, /author must have non-empty string name and url/],
  ["plugin metadata whitespace-only keyword", () => {
    const metadata = validPluginMetadata();
    metadata.keywords = ["git-spice", "  "];
    return JSON.stringify(metadata);
  }, /keywords must be a string array of non-empty values/],
];

const promptFrontmatterVariants = [
  ["missing field", (text) => text.replace(/^description:.*\n/m, ""), /description is required/],
  ["duplicate field", (text) => text.replace(/^description:.*$/m, (line) => `${line}\n${line}`), /Duplicate source prompt frontmatter key/],
  ["unknown field", (text) => text.replace(/^description:/m, "unknown:"), /Unsupported source prompt frontmatter key/],
  ["malformed field", (text) => text.replace(/^description:/m, "description ="), /Unsupported source prompt frontmatter shape/],
  ["whitespace-only field", (text) => text.replace(/^description:.*$/m, "description:    "), /description is required and non-empty/],
  ["whitespace-only optional field", (text) => text.replace(/^argument-hint:.*$/m, "argument-hint:    "), /argument-hint must be non-empty/],
];

const skillFrontmatterVariants = [
  ["missing field", (text) => text.replace(/^description:.*\n/m, ""), /description is required/],
  ["duplicate field", (text) => text.replace(/^name:.*$/m, (line) => `${line}\n${line}`), /Duplicate source skill frontmatter key/],
  ["unknown field", (text) => text.replace(/^name:/m, "unknown:"), /Unsupported source skill frontmatter key/],
  ["malformed field", (text) => text.replace(/^description:/m, "description ="), /Unsupported source skill frontmatter shape/],
  ["whitespace-only field", (text) => text.replace(/^description:.*$/m, "description:    "), /description is required and non-empty/],
];

const agentFrontmatterVariants = [
  ["missing field", (text) => text.replace(/^description:.*\n/m, ""), /missing=.*description/s],
  ["duplicate field", (text) => text.replace(/^description:.*$/m, (line) => `${line}\n${line}`), /Duplicate source agent frontmatter key/],
  ["unknown field", (text) => text.replace(/^description:.*$/m, (line) => `${line}\nfuture: value`), /Unsupported source agent frontmatter key/],
  ["malformed field", (text) => text.replace(/^  - Bash$/m, " - Bash"), /Unsupported source agent frontmatter shape|Malformed source agent tool/],
  ["whitespace-only field", (text) => text.replace(/^description:.*$/m, "description:    "), /description must be a non-empty scalar/],
  ["list item before description", (text) => text.replace(/^---$/m, "---\n  - Bash"), /List item outside source agent tools block/],
  ["list item in description field", (text) => text.replace(/^description:.*$/m, (line) => `${line}\n  - Bash`), /List item outside source agent tools block/],
  ["list item after model", (text) => text.replace(/^model: sonnet$/m, "model: sonnet\n  - Bash"), /List item outside source agent tools block/],
];

const failureVariants = [
  ...metadataVariants.map(([name, makeContent, diagnostic]) => [name, ".claude-plugin/plugin.json", makeContent, diagnostic]),
  ...promptFrontmatterVariants.map(([name, mutate, diagnostic]) => [`prompt frontmatter ${name}`, "commands/continue.md", () => mutate(sourceFiles()["commands/continue.md"]), diagnostic]),
  ...skillFrontmatterVariants.map(([name, mutate, diagnostic]) => [`skill frontmatter ${name}`, "skills/git-spice/SKILL.md", () => mutate(sourceFiles()["skills/git-spice/SKILL.md"]), diagnostic]),
  ...agentFrontmatterVariants.map(([name, mutate, diagnostic]) => [`agent frontmatter ${name}`, "agents/stacker.md", () => mutate(sourceFiles()["agents/stacker.md"]), diagnostic]),
  ["agent frontmatter invalid fixed model", "agents/stacker.md", () => sourceFiles()["agents/stacker.md"].replace("model: sonnet", "model: opus"), /model must be exactly/],
  ["removed semantic prose anchor", "commands/init.md", () => sourceFiles()["commands/init.md"].replace("Confirm you're inside a git repository:", "Confirm setup:"), /Expected exactly one source text occurrence/],
  ["duplicated semantic prose anchor", "commands/init.md", () => sourceFiles()["commands/init.md"] + "Confirm you're inside a git repository:\n", /Expected exactly one source text occurrence/],
];

for (const [name, relative, makeContent, diagnostic] of failureVariants) {
  test(`${name} fails before installation`, () => {
    const source = createSourceFixture({ [relative]: `${makeContent()}\n` });
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assertRollback(packageCopy.root, sentinels);
  });
}

const autoAdvanceSourceText = "git-spice won't auto-advance";
for (const [variant, mutate, expectedCount] of [
  ["zero", (text) => text.replace(/^Using raw .*git-spice.*auto-advance.*\n/m, ""), 0],
  ["duplicate", (text) => text.replace(autoAdvanceSourceText, `${autoAdvanceSourceText}; ${autoAdvanceSourceText}`), 2],
  ["drifted", (text) => text.replace(autoAdvanceSourceText, "git-spice does not auto-advance"), 0],
]) {
  test(`git-spice auto-advance transform rejects ${variant} source cardinality before installation`, () => {
    const relative = "skills/git-spice/SKILL.md";
    const source = createSourceFixture({ [relative]: mutate(sourceFiles()[relative]) });
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Expected exactly one source text occurrence.*${relative.replaceAll("/", "\\/")}.*found ${expectedCount}`));
    assertRollback(packageCopy.root, sentinels);
  });
}

const guardedMutationAnchors = [
  ["init/reset", "commands/init.md", mutationAnchorPatterns.reset, /reset mutation anchor cardinality/],
  ["init/reconfiguration", "commands/init.md", mutationAnchorPatterns.init, /init mutation anchor cardinality/],
  ["branch create", "commands/new.md", mutationAnchorPatterns.branchCreate, /branch create mutation anchor cardinality/],
  ["rebase continue", "commands/continue.md", mutationAnchorPatterns.rebaseContinue, /rebase continue mutation anchor cardinality/],
  ["rebase abort", "commands/continue.md", mutationAnchorPatterns.rebaseAbort, /rebase abort mutation anchor cardinality/],
  ["restack", "commands/restack.md", mutationAnchorPatterns.restack, /restack mutation anchor cardinality/],
  ["sync", "commands/sync.md", mutationAnchorPatterns.sync, /sync mutation anchor cardinality/],
  ["submit draft injection", "commands/submit.md", mutationAnchorPatterns.submit, /submit mutation anchor cardinality/],
  ["other command mutation", "commands/stack.md", commandAnchorPattern, /command anchor cardinality/],
];

const mutateAnchorCardinality = (content, pattern, variant) => {
  const matches = Array.from(content.matchAll(pattern), (match) => match[0]);
  assert.ok(matches.length > 0);
  if (variant === "zero") return content.replace(pattern, "git spice disabled-anchor");
  if (variant === "duplicate") {
    if (pattern === commandAnchorPattern) return `${content}\nDuplicated mutation: \`git-spice commit amend\`.\n`;
    const suffix = pattern === mutationAnchorPatterns.reset ? " --reset" : " fixture";
    return `${content}\nDuplicated mutation: \`${matches[0]}${suffix}\`.\n`;
  }
  if (pattern === commandAnchorPattern) return content.replace(new RegExp(pattern.source), "git-spice  ");
  return content.replace(new RegExp(pattern.source), matches[0].replace("git-spice ", "git-spice  "));
};

for (const [operation, relative, pattern, diagnostic] of guardedMutationAnchors) {
  for (const variant of ["zero", "duplicate", "drifted"]) {
    test(`${operation} rejects ${variant} mutation anchors before installation`, () => {
      const source = createSourceFixture({ [relative]: mutateAnchorCardinality(sourceFiles()[relative], pattern, variant) });
      const packageCopy = createTemporaryPackage();
      const sentinels = installedSentinels(packageCopy.root);
      const result = runMigration(packageCopy.script, source, packageCopy.root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, diagnostic);
      assertRollback(packageCopy.root, sentinels);
    });
  }
}

const runProbe = (python, packageCopy, source) => spawnSync("python3", ["-B", "-c", python, packageCopy.script, source], {
  cwd: packageCopy.root,
  encoding: "utf8",
});

const generatedTreeProbe = (body) => [
  "import importlib.util, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "source = pathlib.Path(sys.argv[2])",
  "temporary = pathlib.Path(module.PACKAGE_ROOT) / 'validator-probe'",
  "temporary.mkdir()",
  "module.validate_source(source)",
  "generated = module.build_generated_tree(source, temporary)",
  body,
  "module.validate_generated_tree(generated)",
].join("\n");

const unsafeContextCases = [
  ["bare line", "git-spice future mutate"],
  ["list prefix", "- git-spice future mutate"],
  ["quote prefix", "> git-spice future mutate"],
  ["and chain", "true && git-spice future mutate"],
  ["uppercase arbitrary shell text", "TRUE && git-spice future mutate"],
  ["or chain", "false || git-spice future mutate"],
  ["semicolon", "true; git-spice future mutate"],
  ["pipeline", "printf x | git-spice future mutate"],
  ["subshell", "(git-spice future mutate)"],
  ["environment", "MODE=test git-spice future mutate"],
  ["environment with Markdown-like value", "MODE=some_value git-spice future mutate"],
  ["capitalized wrapper", "Use sudo git-spice future mutate"],
  ["capitalized wrapper in a list", "- Use sudo git-spice future mutate"],
  ["Markdown-formatted capitalized wrapper", "Use **sudo** git-spice future mutate"],
  ["tabular capitalized wrapper", "| Use sudo git-spice future mutate |"],
  ["capitalized imperative sentence", "Run git-spice future mutate."],
  ["lowercase imperative sentence", "run git-spice future mutate."],
  ["uppercase imperative sentence", "RUN git-spice future mutate!"],
  ["question-punctuated imperative sentence", "Run git-spice future mutate?"],
  ["colon-punctuated imperative sentence", "Run git-spice future mutate:"],
  ["custom Markdown table instruction", "| Run **custom** git-spice future mutate | `other` |"],
  ["inline one tick", "`git-spice future mutate`"],
  ["inline two ticks", "``git-spice future mutate``"],
  ["unlabeled fence", "```\ngit-spice future mutate\n```"],
  ["text fence", "```text\ngit-spice future mutate\n```"],
  ["misleading fence", "```json\ngit-spice future mutate\n```"],
  ["longer closer", "```bash\ntrue && git-spice future mutate\n````"],
  ["tilde fence", "~~~text\ngit-spice future mutate\n~~~~"],
  ["comment prior line", "# ignored\ngit-spice future mutate"],
  ["inline comment then later", "true # ignored\ngit-spice future mutate"],
];

const runUnsafeSourceMigration = (snippet) => {
  const relative = "commands/stack.md";
  const source = createSourceFixture({ [relative]: `${sourceFiles()[relative]}\n${snippet}\n` });
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  return { packageCopy, result: runMigration(packageCopy.script, source, packageCopy.root), sentinels };
};

const assertDiscoveryFailureBeforeMutation = (snippet, diagnostic = null) => {
  const { packageCopy, result, sentinels } = runUnsafeSourceMigration(snippet);
  assert.notEqual(result.status, 0, `unsafe snippet unexpectedly passed:\n${snippet}`);
  assert.match(result.stderr, /prompts\/git-spice-stack\.md/);
  assert.match(result.stderr, /line \d+, column \d+/);
  assert.match(result.stderr, /excerpt=.*git-spice/);
  if (diagnostic) assert.match(result.stderr, diagnostic);
  assertRollback(packageCopy.root, sentinels);
};

for (const [name, snippet] of unsafeContextCases) {
  test(`whole-document inventory rejects unsafe ${name} context before mutation`, () => {
    assertDiscoveryFailureBeforeMutation(snippet);
  });
}

test("review blocker: command after arbitrary shell text is inventoried", () => {
  assertDiscoveryFailureBeforeMutation("true && git-spice future mutate");
});

test("review blocker: longer closing fence retains unsafe fenced command", () => {
  assertDiscoveryFailureBeforeMutation("```bash\ntrue && git-spice future mutate\n````");
});

for (const [name, snippet] of [
  ["inline period argument", "`git-spice .`"],
  ["inline question-mark argument", "`git-spice ?`"],
  ["inline closing-parenthesis argument", "`git-spice )`"],
  ["fenced period argument", "```text\ngit-spice .\n```"],
  ["fenced question-mark argument", "```text\ngit-spice ?\n```"],
  ["fenced closing-parenthesis argument", "```text\ngit-spice )\n```"],
]) {
  test(`code-region punctuation reaches command validation for ${name}`, () => {
    assertDiscoveryFailureBeforeMutation(snippet, /unclassified git-spice subcommand/);
  });
}

for (const [name, snippet] of [
  ["inline attached period", "`git-spice.`"],
  ["inline attached question", "`git-spice?`"],
  ["inline attached close paren", "`git-spice)`"],
  ["fenced attached period", "```text\ngit-spice.\n```"],
  ["fenced attached question", "```text\ngit-spice?\n```"],
  ["fenced attached close paren", "```text\ngit-spice)\n```"],
]) {
  test(`attached punctuation reaches command validation: ${name}`, () => {
    assertDiscoveryFailureBeforeMutation(snippet, /unclassified git-spice subcommand/);
  });
}

for (const snippet of [
  "`prefix git-spice`",
  "`prefix git-spice future mutate`",
  "```text\nprefix git-spice\n```",
  "```text\nprefix git-spice future mutate\n```",
  "```bash\n# git-spice future mutate\n```",
]) {
  test(`prefixed/code-comment occurrence reaches validation: ${JSON.stringify(snippet)}`, () => {
    assertDiscoveryFailureBeforeMutation(snippet, /unclassified git-spice subcommand/);
  });
}

for (const snippet of [
  "Run git-spice. future mutate",
  "RUN git-spice? future mutate",
  "# Run git-spice future mutate",
  "## run git-spice. future mutate",
  "### RUN git-spice? future mutate",
]) {
  test(`plain heading/prose cannot bypass manifest: ${JSON.stringify(snippet)}`, () => {
    assertDiscoveryFailureBeforeMutation(snippet);
  });
}

test("review blocker: capitalized prose cannot hide an ambiguous wrapper invocation", () => {
  assertDiscoveryFailureBeforeMutation("Use sudo git-spice future mutate");
});

test("static prose references reject exact capitalized and custom-table review bypasses", () => {
  assertDiscoveryFailureBeforeMutation("Run git-spice future mutate.");
  assertDiscoveryFailureBeforeMutation("| Run **custom** git-spice future mutate | `other` |");
});

for (const [name, description] of [
  ["capitalized punctuated", "Run `git-spice future mutate`."],
  ["lowercase unpunctuated", "run `git-spice future mutate`"],
  ["uppercase question-punctuated", "RUN `git-spice future mutate`?"],
]) {
  test(`argument-bearing inline code in frontmatter rejects ${name} variants before mutation`, () => {
    const relative = "commands/stack.md";
    const content = sourceFiles()[relative].replace(/^description:.*$/m, `description: ${description}`);
    const source = createSourceFixture({ [relative]: content });
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /prompts\/git-spice-stack\.md/);
    assert.match(result.stderr, /line \d+, column \d+/);
    assert.match(result.stderr, /excerpt=.*git-spice/);
    assertRollback(packageCopy.root, sentinels);
  });
}

for (const [name, heading] of [
  ["capitalized punctuated", "# Run `git-spice future mutate`."],
  ["lowercase unpunctuated", "## run `git-spice future mutate`"],
  ["uppercase question-punctuated", "### RUN `git-spice future mutate`?"],
]) {
  test(`argument-bearing inline code in headings rejects ${name} variants before mutation`, () => {
    assertDiscoveryFailureBeforeMutation(heading);
  });
}

const totalAccountingUnsafeCases = [
  ["unsafe before safe invocation", "`git-spice future mutate && git-spice --no-prompt log long`"],
  ["unsafe after safe invocation", "`git-spice --no-prompt log long && git-spice future mutate`"],
  ["unknown with global flag before command", "`git-spice --verbose --no-prompt future mutate`"],
  ["unknown with global flags interspersed", "`git-spice --verbose future --no-prompt mutate`"],
  ["unknown with no-prompt final", "`git-spice --verbose future mutate --no-prompt`"],
  ["first invocation in snippet", "`git-spice future mutate; git-spice --no-prompt log long; git-spice --no-prompt auth status`"],
  ["middle invocation in snippet", "`git-spice --no-prompt log long; git-spice future mutate; git-spice --no-prompt auth status`"],
  ["final invocation in snippet", "`git-spice --no-prompt log long; git-spice --no-prompt auth status; git-spice future mutate`"],
  ["multiple inline and fenced regions", "`git-spice --no-prompt log long`\n\n```text\ngit-spice --no-prompt auth status\n```\n\n``git-spice future mutate``"],
  ["quoted comment marker", "```bash\nprintf '%s\\n' '# still data' && git-spice future mutate\n```"],
  ["comment-only prior line", "```bash\n# git-spice future mutate is ignored in this comment\ngit-spice future mutate\n```"],
  ["pipeline and subshell", "```bash\nprintf x | (git-spice future mutate)\n```"],
  ["continued command", "```bash\ntrue && \\\n  git-spice future mutate\n```"],
  ["own arguments continued to an unknown command", "git-spice --no-prompt branch \\\n  future mutate"],
  ["continued safe command followed by an unknown invocation after a comment", "git-spice --no-prompt branch \\\n  restack # safe first invocation\ngit-spice --no-prompt future mutate"],
  ["shorter closing fence", "````text\ngit-spice future mutate\n```"],
  ["mismatched closing fence", "```text\ngit-spice future mutate\n~~~"],
  ["unterminated fence", "```text\ngit-spice future mutate"],
  ["ambiguous wrapper", "sudo git-spice future mutate"],
  ["ambiguous multi-token wrapper", "sudo -u root git-spice future mutate"],
];

for (const [name, snippet] of totalAccountingUnsafeCases) {
  test(`occurrence accounting rejects ${name} before mutation`, () => {
    assertDiscoveryFailureBeforeMutation(snippet);
  });
}

const auditSyntheticText = (text) => {
  const packageCopy = createTemporaryPackage();
  const python = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `text = ${JSON.stringify(text)}`,
    "module.PROSE_REFERENCE_MANIFEST = {target: () for _, target in module.RUNTIME_MANIFEST}",
    "occurrences = module.audit_git_spice_occurrences(pathlib.Path('prompts/git-spice-stack.md'), text)",
    "print(json.dumps([{'classification': item.classification, 'reason': item.reason} for item in occurrences]))",
  ].join("\n");
  return spawnSync("python3", ["-B", "-c", python, packageCopy.script], { cwd: packageCopy.root, encoding: "utf8" });
};

for (const [name, text, expectedReason] of [
  ["prompt continue", "Use /git-spice-continue.", "exact registered git-spice prompt identifier"],
  ["prompt init", "Use /git-spice-init.", "exact registered git-spice prompt identifier"],
  ["prompt new", "Use /git-spice-new.", "exact registered git-spice prompt identifier"],
  ["prompt restack", "Use /git-spice-restack.", "exact registered git-spice prompt identifier"],
  ["prompt stack", "Use /git-spice-stack.", "exact registered git-spice prompt identifier"],
  ["prompt submit", "Use /git-spice-submit.", "exact registered git-spice prompt identifier"],
  ["prompt sync", "Use /git-spice-sync.", "exact registered git-spice prompt identifier"],
  ["agent stacker", "Dispatch git-spice.stacker.", "exact registered git-spice agent identifier"],
  ["agent stack doctor", "Dispatch git-spice.stack-doctor.", "exact registered git-spice agent identifier"],
  ["upstream issue with committed punctuation", "abhinav/git-spice#1050.)", "exact registered git-spice upstream identifier"],
]) {
  test(`exact registered identifier classifies with its typed reason: ${name}`, () => {
    const result = auditSyntheticText(text);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ classification: "reference", reason: expectedReason }]);
  });
}

for (const [identifier, snippet] of [
  ["x/git-spice-continue", "Use x/git-spice-continue."],
  ["/git-spice-continue-extra", "Use /git-spice-continue-extra."],
  ["git-spice.stacker.evil", "Use git-spice.stacker.evil."],
  ["xgit-spice.stack-doctor", "Use xgit-spice.stack-doctor."],
  ["abhinav/git-spice#1051", "See abhinav/git-spice#1051."],
  ["evil/abhinav/git-spice#1050", "See evil/abhinav/git-spice#1050."],
  ["git-spice.", "Bare sentence-final git-spice."],
]) {
  test(`near-miss registered identifier fails before mutation: ${identifier}`, () => {
    assertDiscoveryFailureBeforeMutation(snippet);
  });
}

for (const [kind, identifier] of [
  ["prompt", "/git-spice-stack"],
  ["agent", "git-spice.stacker"],
  ["upstream", "abhinav/git-spice#1050"],
]) {
  for (const punctuation of [":", ",", ";", "!", "?"]) {
    const nearMiss = `${identifier}.${punctuation}evil`;
    test(`terminal dot before ${punctuation} does not complete a registered ${kind} identifier`, () => {
      assertDiscoveryFailureBeforeMutation(`See ${nearMiss}`);
    });
  }
}

for (const [kind, nearMiss] of [
  ["prompt", "/git-spice-stack.)evil"],
  ["agent", "git-spice.stacker.\"evil"],
  ["upstream", "abhinav/git-spice#1050.>evil"],
]) {
  test(`closing delimiters before identifier text do not complete a registered ${kind} identifier`, () => {
    assertDiscoveryFailureBeforeMutation(`See ${nearMiss}`);
  });
}

for (const [name, text, expectedReason] of [
  ["closing run reaches whitespace", "Use /git-spice-stack.) next", "exact registered git-spice prompt identifier"],
  ["closing run reaches end-of-line", "Dispatch git-spice.stacker.\"]", "exact registered git-spice agent identifier"],
  ["closing run reaches explicit terminal boundary", "See abhinav/git-spice#1050.)!evil", "exact registered git-spice upstream identifier"],
]) {
  test(`terminal dot accepts an approved boundary when its ${name}`, () => {
    const result = auditSyntheticText(text);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ classification: "reference", reason: expectedReason }]);
  });
}

for (const [kind, nearMiss] of [
  ["prompt", "/git-spice-stack-extra"],
  ["agent", "git-spice.stacker.evil"],
  ["upstream", "abhinav/git-spice#10500"],
]) {
  test(`registered ${kind} boundary policy rejects its identifier-kind continuation`, () => {
    assertDiscoveryFailureBeforeMutation(`See ${nearMiss}`);
  });
}

test("exact standalone ATX heading uses its named structural reason", () => {
  const result = auditSyntheticText("# git-spice");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{
    classification: "reference",
    reason: "exact standalone git-spice Markdown heading",
  }]);
});

for (const heading of [
  "## git-spice",
  "# git-spice #",
  " # git-spice",
  "# git-spice \nTrailing source content",
  "#\tgit-spice",
]) {
  test(`non-exact git-spice heading fails before mutation: ${JSON.stringify(heading)}`, () => {
    assertDiscoveryFailureBeforeMutation(heading);
  });
}

for (const [snippet, expectedArguments] of [
  ["`git-spice.`", ["."]],
  ["`git-spice#future`", ["#future"]],
  ["`prefix git-spice`", []],
  ["`prefix git-spice future mutate`", ["future", "mutate"]],
]) {
  test(`occurrence-anchored extraction reaches command classification: ${snippet}`, () => {
    const packageCopy = createTemporaryPackage();
    const python = [
      "import importlib.util, json, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `text = ${JSON.stringify(snippet)}`,
      "module.PROSE_REFERENCE_MANIFEST = {target: () for _, target in module.RUNTIME_MANIFEST}",
      "captured = []",
      "def capture(arguments):",
      "    captured.append(arguments)",
      "    raise ValueError('instrumented classifier stop')",
      "module.classify_git_spice_command = capture",
      "try:",
      "    module.audit_git_spice_occurrences(pathlib.Path('prompts/git-spice-stack.md'), text)",
      "except RuntimeError:",
      "    pass",
      "print(json.dumps(captured))",
    ].join("\n");
    const result = spawnSync("python3", ["-B", "-c", python, packageCopy.script], { cwd: packageCopy.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expectedArguments]);
  });
}

test("malformed occurrence tail quoting fails closed with target diagnostics", () => {
  assertDiscoveryFailureBeforeMutation('`prefix git-spice "unterminated`', /malformed executable occurrence/);
});

test("inventory classifies every reference and executable occurrence exactly once with a reason", () => {
  const packageCopy = createTemporaryPackage();
  const text = [
    "package: git-spice",
    "`git-spice`",
    "`git-spice --no-prompt log long`",
    "Dispatch git-spice.stacker.",
    "Use /git-spice-stack.",
  ].join("\n");
  const python = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `text = ${JSON.stringify(text)}`,
    "module.PROSE_REFERENCE_MANIFEST = {target: () for _, target in module.RUNTIME_MANIFEST}",
    "occurrences = module.audit_git_spice_occurrences(pathlib.Path('prompts/git-spice-stack.md'), text)",
    "print(json.dumps([{'classification': item.classification, 'reason': item.reason, 'line': item.line, 'column': item.column} for item in occurrences]))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", python, packageCopy.script], { cwd: packageCopy.root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const occurrences = JSON.parse(result.stdout);
  assert.equal(occurrences.length, 5);
  assert.equal(occurrences.filter(({ classification }) => classification === "reference").length, 4);
  assert.equal(occurrences.filter(({ classification }) => classification === "executable").length, 1);
  assert.ok(occurrences.every(({ classification, reason }) => ["reference", "executable"].includes(classification) && reason.length > 0));
  assert.ok(occurrences.every(({ reason }) => !/capitalized|tabular|Markdown-formatted|cue word|frontmatter|heading|punctuation/i.test(reason)), "classification reasons are mechanical or manifest-backed");
});

const proseManifestContextCases = [
  ["delete", "text = text.replace(entry.exact_physical_line + '\\n', '', 1)"],
  ["duplicate", "text = text.replace(entry.exact_physical_line, entry.exact_physical_line + '\\n' + entry.exact_physical_line, 1)"],
  ["add", "text += '\\nUnlisted git-spice prose reference.\\n'"],
  ["drift", "text = text.replace(entry.exact_physical_line, entry.exact_physical_line.replace('git-spice', 'git-spice drifted'), 1)"],
];

for (const [name, mutation] of proseManifestContextCases) {
  test(`static prose manifest rejects ${name} context changes with target diagnostics`, () => {
    const packageCopy = createTemporaryPackage();
    const relative = "agents/stacker.md";
    const python = [
      "import importlib.util, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `relative = ${JSON.stringify(relative)}`,
      "text = pathlib.Path(sys.argv[2], relative).read_text(encoding='utf8')",
      "entry = module.PROSE_REFERENCE_MANIFEST[relative][0]",
      mutation,
      "module.audit_git_spice_occurrences(pathlib.Path(relative), text)",
    ].join("\n");
    const result = spawnSync("python3", ["-B", "-c", python, packageCopy.script, packageRoot], { cwd: packageCopy.root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agents\/stacker\.md/);
    assert.match(result.stderr, /prose reference manifest|prose manifest/i);
    assert.match(result.stderr, /line \d+, column \d+|excerpt=/);
  });
}

for (const [name, manifestMutation, diagnostic] of [
  ["deleted entry", "entries.pop(0)", /unlisted prose reference/],
  ["duplicated entry", "entries.append(entries[0])", /duplicate prose reference manifest entry/],
  ["stale added entry", "entries.append(module.ProseReferenceManifestEntry('Stale git-spice manifest line.', 1))", /unused or stale prose reference manifest entry/],
  ["textually drifted entry", "entries[0] = module.ProseReferenceManifestEntry(entries[0].exact_physical_line + ' drift', entries[0].expected_count)", /unlisted prose reference/],
]) {
  test(`static prose manifest rejects ${name}`, () => {
    const packageCopy = createTemporaryPackage();
    const relative = "agents/stacker.md";
    const python = [
      "import importlib.util, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `relative = ${JSON.stringify(relative)}`,
      "entries = list(module.PROSE_REFERENCE_MANIFEST[relative])",
      manifestMutation,
      "module.PROSE_REFERENCE_MANIFEST = {**module.PROSE_REFERENCE_MANIFEST, relative: tuple(entries)}",
      "text = pathlib.Path(sys.argv[2], relative).read_text(encoding='utf8')",
      "module.audit_git_spice_occurrences(pathlib.Path(relative), text)",
    ].join("\n");
    const result = spawnSync("python3", ["-B", "-c", python, packageCopy.script, packageRoot], { cwd: packageCopy.root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /agents\/stacker\.md/);
    assert.match(result.stderr, /line \d+, column \d+|excerpt=/);
  });
}

for (const [failure, classifyBody, diagnostic] of [
  ["inventory mapping", "raise RuntimeError('forced inventory mapping failure')", /inventory did not reconcile/],
  ["reconciliation invariant", "result = original(text, occurrence, *args); result.classification = 'other'; result.reason = 'forced accounting gap'; return result", /inventory did not reconcile/],
  ["missing-reason invariant", "result = original(text, occurrence, *args); result.reason = None; return result", /classification is missing a reason/],
]) {
  test(`${failure} diagnostics include target path and source location`, () => {
    const packageCopy = createTemporaryPackage();
    const python = [
      "import importlib.util, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "text = 'git-spice --no-prompt log long\\n'",
      failure === "inventory mapping"
        ? "def forced_inventory(text, regions):\n    raise RuntimeError('forced inventory mapping failure')\nmodule.inventory_git_spice_occurrences = forced_inventory"
        : `original = module.classify_occurrence\ndef forced_classify(text, occurrence, *args):\n    ${classifyBody}\nmodule.classify_occurrence = forced_classify`,
      "module.audit_git_spice_occurrences(pathlib.Path('prompts/diagnostic.md'), text)",
    ].join("\n");
    const result = spawnSync("python3", ["-B", "-c", python, packageCopy.script], { cwd: packageCopy.root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /prompts\/diagnostic\.md/);
    assert.match(result.stderr, /line 1, column 1|excerpt=.*git-spice/);
  });
}

for (const [name, unsafeCommand] of [
  ["bare mutation", "git-spice branch restack"],
  ["branch creation without commit mode", "git-spice --no-prompt branch create <name>"],
  ["branch creation with empty commit message", "git-spice --no-prompt branch create <name> -m \"\""],
  ["rebase continuation without no-edit", "git-spice --no-prompt rebase continue"],
  ["init without explicit remote", "git-spice --no-prompt repo init --trunk=<name>"],
  ["init with empty trunk placeholder", "git-spice --no-prompt repo init --trunk=<> --remote=<name>"],
  ["sync without restack", "git-spice --no-prompt repo sync"],
  ["sync with empty restack value", "git-spice --no-prompt repo sync --restack="],
  ["submit without draft state", "git-spice --no-prompt stack submit --fill"],
  ["unknown subcommand", "git-spice --no-prompt future mutate"],
]) {
  test(`generated runtime validation rejects ${name}`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const unsafeFragment = name === "bare mutation" ? `\n${unsafeCommand}\n` : `\nUnsafe validator fixture: \`${unsafeCommand}\`.\n`;
    const command = JSON.stringify(unsafeFragment);
    const result = runProbe(generatedTreeProbe(`target = generated / 'prompts/git-spice-stack.md'\ntarget.write_text(target.read_text() + ${command})`), packageCopy, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe generated executable git-spice command/);
  });
}

const adversarialGeneratedSnippets = [
  ["argumentless bare invocation", "prompts/git-spice-stack.md", "git-spice"],
  ["reviewer bare unknown command", "prompts/git-spice-stack.md", "git-spice future mutate"],
  ["bare unknown command after global option", "prompts/git-spice-stack.md", "git-spice --verbose future mutate"],
  ["bare unknown command with no-prompt after command", "prompts/git-spice-stack.md", "git-spice future --no-prompt mutate"],
  ["bare unknown command already containing no-prompt", "prompts/git-spice-stack.md", "git-spice --no-prompt future mutate"],
  ["capitalized wrapper unknown invocation", "prompts/git-spice-stack.md", "Use sudo git-spice future mutate"],
  ["own arguments continuation unknown invocation", "prompts/git-spice-stack.md", "git-spice --no-prompt branch \\\n  future mutate"],
  ["prompt && unknown second invocation", "prompts/git-spice-stack.md", "`git-spice --no-prompt log long && git-spice --no-prompt future mutate`"],
  ["prompt || unsafe second invocation", "prompts/git-spice-stack.md", "`git-spice --no-prompt log long || git-spice branch restack`"],
  ["prompt multi-backtick unknown later invocation", "prompts/git-spice-stack.md", "``git-spice --no-prompt log long && git-spice --no-prompt future mutate``"],
  ["skill semicolon unknown later invocation", "skills/git-spice/SKILL.md", "`git-spice --no-prompt log long; git-spice --no-prompt future mutate`"],
  ["skill pipeline unsafe later invocation", "skills/stacking-workflow/SKILL.md", "`git-spice --no-prompt log long | git-spice --no-prompt branch create <name>`"],
  ["agent subshell unknown later invocation", "agents/stack-doctor.md", "`(git-spice --no-prompt log long && git-spice --no-prompt future mutate)`"],
  ["agent multiline continuation unsafe later invocation", "agents/stacker.md", "```bash\ngit-spice --no-prompt log long && \\\n  git-spice --no-prompt branch create <name>\n```"],
  ["reviewer commented multiline chain", "agents/stack-doctor.md", "```bash\n# Diagnose the tracking failure before repair\ntrue && git-spice future mutate && git-spice branch restack\n```"],
  ["inline comment before unsafe later invocation", "agents/stack-doctor.md", "```sh\ngit-spice --no-prompt log long # inspect first\ntrue | git-spice --no-prompt future mutate\n```"],
  ["comment-only continuation before unsafe later invocation", "agents/stacker.md", "```shell\n# This comment ends on this physical line \\\ntrue && git-spice branch restack\n```"],
  ["multiple fences with unsafe invocation in later fence", "skills/stacking-workflow/SKILL.md", "```bash\ngit-spice --no-prompt log long\n```\n\n```zsh\ngit-spice --no-prompt future mutate\n```"],
  ["quoted comment marker before later unknown invocation", "agents/stacker.md", "```bash\nprintf '%s\\n' '# not a comment' && git-spice --no-prompt log long\ntrue && git-spice --verbose future mutate\n```"],
  ["long backtick shell fence unknown invocation", "agents/stack-doctor.md", "````bash\ntrue && git-spice --no-prompt future mutate\n````"],
  ["tilde shell fence unsafe invocation", "agents/stacker.md", "~~~sh\ntrue && git-spice branch restack\n~~~"],
  ["stack-doctor branch tracking without target", "agents/stack-doctor.md", "`git-spice --no-prompt branch track`"],
  ["stack-doctor whole-stack tracking without target", "agents/stack-doctor.md", "`git-spice --no-prompt downstack track`"],
];

for (const [name, relative, snippet] of adversarialGeneratedSnippets) {
  test(`generated runtime validation rejects ${name}`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const fragment = JSON.stringify(`\nAdversarial validator fixture:\n${snippet}\n`);
    const result = runProbe(generatedTreeProbe(`target = generated / ${JSON.stringify(relative)}\ntarget.write_text(target.read_text() + ${fragment})`), packageCopy, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe generated executable git-spice command/);
  });
}

test("generated runtime validation classifies commands with interspersed global options", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const fragment = JSON.stringify("\nGlobal option placement fixture: `git-spice --verbose branch --no-prompt restack`.\n");
  const result = runProbe(generatedTreeProbe(`target = generated / 'prompts/git-spice-stack.md'\ntarget.write_text(target.read_text() + ${fragment})`), packageCopy, source);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, snippet] of [
  ["own arguments continuation", "git-spice --no-prompt branch \\\n  restack"],
  ["own arguments continuation with physical-line comments", "# comment before the invocation\ngit-spice --no-prompt branch \\\n  restack # trailing comment"],
]) {
  test(`generated runtime validation accepts safe ${name}`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const fragment = JSON.stringify(`\n${snippet}\n`);
    const result = runProbe(generatedTreeProbe(`target = generated / 'prompts/git-spice-stack.md'\ntarget.write_text(target.read_text() + ${fragment})`), packageCopy, source);
    assert.equal(result.status, 0, result.stderr);
  });
}

const installationProbe = (injection) => [
  "import importlib.util, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "source = pathlib.Path(sys.argv[2])",
  "temporary = pathlib.Path(module.PACKAGE_ROOT) / 'installation-probe'",
  "temporary.mkdir()",
  "module.validate_source(source)",
  "generated = module.build_generated_tree(source, temporary)",
  injection,
].join("\n");

const transactionDirectories = (root) => readdirSync(root).filter((name) => name.startsWith(".pi-git-spice-install-"));

for (const swap of [1, 2, 3, 4, 5, 6]) {
  test(`failure during atomic root swap ${swap} restores all originals and cleans artifacts`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const injection = [
      "calls = {'moves': 0}",
      "original_move = module.rename_path",
      "def failing_move(source, destination):",
      "    calls['moves'] += 1",
      `    if calls['moves'] == ${swap}: raise OSError('injected swap ${swap}')`,
      "    return original_move(source, destination)",
      "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=module.remove_tree)",
    ].join("\n");
    const result = runProbe(installationProbe(injection), packageCopy, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`injected swap ${swap}`));
    assertRollback(packageCopy.root, sentinels);
  });
}

test("KeyboardInterrupt during staging preserves installed roots and removes staging artifacts", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'copies': 0}",
    "original_copytree = module.shutil.copytree",
    "def failing_copytree(source, destination):",
    "    calls['copies'] += 1",
    "    if calls['copies'] == 2: raise KeyboardInterrupt()",
    "    return original_copytree(source, destination)",
    "module.shutil.copytree = failing_copytree",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=module.rename_path, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KeyboardInterrupt/);
  assertRollback(packageCopy.root, sentinels);
});

test("installed-root verification failure restores all originals", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "def corrupting_move(source, destination):",
    "    result = original_move(source, destination)",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 3: next(path for path in destination.rglob('*') if path.is_file()).unlink()",
    "    return result",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=corrupting_move, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed generated resource verification failed/);
  assertRollback(packageCopy.root, sentinels);
});

test("interrupted committed cleanup is retried without hiding the committed state", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'cleanup': 0}",
    "original_remove = module.remove_tree",
    "def interrupted_remove(target):",
    "    if target.name.startswith('.pi-git-spice-install-'):",
    "        calls['cleanup'] += 1",
    "        if calls['cleanup'] == 1: raise KeyboardInterrupt()",
    "    return original_remove(target)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=module.rename_path, remove=interrupted_remove)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installation committed and verified.*cleanup was interrupted/is);
  assert.deepEqual(transactionDirectories(packageCopy.root), []);
  for (const relative of runtimeSnapshot(packageCopy.root).keys()) assert.equal(existsSync(path.join(packageCopy.root, relative)), true, relative);
});

test("rollback deletion failure retains recoverable backups and reports their path", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "original_remove = module.remove_tree",
    "def failing_move(source, destination):",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 2: raise OSError('trigger rollback')",
    "    return original_move(source, destination)",
    "def failing_remove(target):",
    "    if target == module.PACKAGE_ROOT / 'agents': raise OSError('cannot delete installed agents')",
    "    return original_remove(target)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=failing_remove)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to roll back generated resource installation/);
  assert.match(result.stderr, /Recovery artifacts retained at/);
  const transactions = transactionDirectories(packageCopy.root);
  assert.equal(transactions.length, 1);
  assert.equal(readFileSync(path.join(packageCopy.root, transactions[0], "backups/agents/sentinel.txt"), "utf8"), "agents original\n");
});

test("backup restoration failure never deletes the last recoverable original", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "def failing_move(source, destination):",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 2: raise OSError('trigger rollback')",
    "    if source.parent.name == 'backups' and source.name == 'agents': raise OSError('cannot restore agents')",
    "    return original_move(source, destination)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot restore agents/);
  assert.match(result.stderr, /Recovery artifacts retained at/);
  const transactions = transactionDirectories(packageCopy.root);
  assert.equal(transactions.length, 1);
  assert.equal(readFileSync(path.join(packageCopy.root, transactions[0], "backups/agents/sentinel.txt"), "utf8"), "agents original\n");
});

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
