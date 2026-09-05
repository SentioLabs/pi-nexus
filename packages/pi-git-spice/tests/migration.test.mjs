import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-git-spice-plugin.py");
const requiredSourcePaths = [
  "commands/continue.md",
  "commands/init.md",
  "commands/new.md",
  "commands/restack.md",
  "commands/stack.md",
  "commands/submit.md",
  "commands/sync.md",
  "skills/git-spice/SKILL.md",
  "skills/stacking-workflow/SKILL.md",
  "agents/stack-doctor.md",
  "agents/stacker.md",
  ".claude-plugin/plugin.json",
];
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
    "2. Parse `$ARGUMENTS` and resolve the scope.",
    "   - Remaining tokens are passed through as flags.",
    "3. Run a dry run first: `git-spice <scope> submit --dry-run --fill`.",
    "4. Then run the real submit: `git-spice <scope> submit --fill <extra-flags>`. The `--fill` flag populates title/body from commit messages so the run is non-interactive.",
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
    "Final state:",
    "<paste git-spice log long and git status>",
  ].join("\n")),
  "agents/stacker.md": agent("Use this agent to build a stack of dependent git-spice branches from an ordered list of changes. Dispatch when you have a multi-step plan whose pieces must ship in order and you want the execution loop (implement → stage → branch create → repeat) handled in a single pass. Receives the task list and the starting branch in its prompt; reports back per-branch results.", ["Bash", "Read", "Write", "Edit", "Glob", "Grep"], [
    "# Stacker Agent",
    "",
    "You build a stack of git-spice branches from an ordered list of changes. You receive the list, the starting branch, and any context the dispatcher chose to include. You have a fresh context — everything you need is in the dispatch prompt.",
    "You run unattended — an interactive prompt will hang you. Always pass explicit arguments (branch names, commit messages) and add the global `--no-prompt` flag to git-spice commands so missing information fails fast instead of prompting. A `--no-prompt` failure is a `BLOCKED`/`NEEDS_CONTEXT` signal, not something to work around.",
    "## Non-interactive discipline",
    "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit message defaults to the staged changes; if the task description maps to a clean conventional-commit subject, prefer `git-spice branch create <name> -m \"<subject>\"`.",
    "Final stack:",
    "<paste git-spice log long>",
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

const sourceDigestMap = (source) => Object.fromEntries(requiredSourcePaths.map((relative) => [
  relative,
  createHash("sha256").update(readFileSync(path.join(source, relative))).digest("hex"),
]));

const migrationImportHarness = [
  "import importlib.util, json, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "module.migrate(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), json.loads(sys.argv[4]))",
].join("; ");

const runMigration = (
  script,
  source,
  cwd,
  { expectedDigests = sourceDigestMap(source), productionCli = false } = {},
) => spawnSync(
  "python3",
  productionCli
    ? ["-B", script, source]
    : ["-B", "-c", migrationImportHarness, script, source, cwd, JSON.stringify(expectedDigests)],
  { cwd, encoding: "utf8" },
);

const runtimeSnapshot = (root) => {
  const snapshot = new Map();
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else {
      snapshot.set(relative, readFileSync(absolute));
    }
  };
  for (const generatedRoot of ["agents", "prompts", "skills"]) visit(generatedRoot);
  return snapshot;
};

const assertRuntimeSnapshot = (root, expected) => {
  assert.deepEqual(runtimeSnapshot(root), expected);
};

const assertNoTransactionDebris = (root) => {
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".pi-git-spice-install-")),
    [],
    "transaction staging and backup directories",
  );
};

const installedSentinels = (root) => {
  for (const name of ["prompts", "skills", "agents"]) writeFixtureFile(root, `${name}/sentinel.txt`, `${name} original\n`);
  return new Map(["prompts", "skills", "agents"].map((name) => [name, readFileSync(path.join(root, name, "sentinel.txt"))]));
};

const assertRollback = (root, sentinels) => {
  for (const [name, bytes] of sentinels) assert.deepEqual(readFileSync(path.join(root, name, "sentinel.txt")), bytes, name);
  assertNoTransactionDebris(root);
};

for (const relative of requiredSourcePaths) {
  test(`source digest drift for ${relative} fails before installed-root mutation`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    installedSentinels(packageCopy.root);
    const expectedDigests = sourceDigestMap(source);
    const before = runtimeSnapshot(packageCopy.root);
    writeFileSync(path.join(source, relative), Buffer.concat([
      readFileSync(path.join(source, relative)),
      Buffer.from("\nreview drift\n"),
    ]));
    const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(relative.replaceAll("/", "\\/")));
    assert.match(result.stderr, /expected=[a-f0-9]{64}/);
    assert.match(result.stderr, /actual=[a-f0-9]{64}/);
    assertRuntimeSnapshot(packageCopy.root, before);
    assertNoTransactionDebris(packageCopy.root);
  });
}

test("production CLI rejects synthetic source bytes with compiled-in pins", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const before = runtimeSnapshot(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root, { productionCli: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commands\/continue\.md/);
  assert.match(result.stderr, /expected=[a-f0-9]{64}/);
  assert.match(result.stderr, /actual=[a-f0-9]{64}/);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

for (const [name, mutate, diagnostic] of [
  ["missing", (digests) => { delete digests[requiredSourcePaths[0]]; }, /digest keys.*missing.*commands\/continue\.md/is],
  ["extra", (digests) => { digests["commands/future.md"] = "0".repeat(64); }, /digest keys.*extra.*commands\/future\.md/is],
]) {
  test(`${name} source digest-map keys fail before installed-root mutation`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    installedSentinels(packageCopy.root);
    const expectedDigests = sourceDigestMap(source);
    mutate(expectedDigests);
    const before = runtimeSnapshot(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assertRuntimeSnapshot(packageCopy.root, before);
    assertNoTransactionDebris(packageCopy.root);
  });
}

test("reviewed fixture digest seam still reaches transform anchor cardinality checks", () => {
  const relative = "commands/continue.md";
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const drifted = readFileSync(path.join(source, relative), "utf8")
    .replace("git-spice rebase continue", "git-spice  rebase continue");
  writeFileSync(path.join(source, relative), drifted);
  const expectedDigests = sourceDigestMap(source);
  const before = runtimeSnapshot(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rebase continue mutation anchor cardinality/);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

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

test("migration CLI parses positional and option source forms without a digest bypass", () => {
  const help = execFileSync("python3", [migrationScript, "--help"], { encoding: "utf8" });
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const positional = runMigration(packageCopy.script, source, packageCopy.root, { productionCli: true });
  const option = spawnSync("python3", ["-B", packageCopy.script, "--source", source], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  for (const result of [positional, option]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Source digest drift/);
  }
  const duplicate = spawnSync("python3", ["-B", packageCopy.script, source, "--source", source], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /either positionally or with --source/);
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
  const result = runMigration(packageCopy.script, source, packageCopy.root, {
    expectedDigests: {},
    productionCli: true,
  });
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
  assert.match(prompts["commands/submit.md"], /submit --dry-run --fill <draft-flag>/);
  assert.match(prompts["commands/submit.md"], /reject prompt controls and conflicting draft controls/i);
  assert.doesNotMatch(prompts["commands/submit.md"], /<extra-flags>/);

  for (const relative of ["skills/git-spice/SKILL.md", "skills/stacking-workflow/SKILL.md"]) {
    const output = readFileSync(path.join(packageCopy.root, relative), "utf8");
    assert.match(output, /If the subagent tool is available, list agents first/);
    assert.match(output, /git-spice\.stacker/);
    assert.match(output, /direct workflow instead/);
    assert.doesNotMatch(output, /subagent_type|Task tool/);
    if (relative === "skills/git-spice/SKILL.md") assert.doesNotMatch(output, /git-spice --no-prompt commit \.\.\./);
    assertSafeBranchCreation(output, relative);
    assertSafeRebaseContinuation(output, relative);
  }

  const stacker = readFileSync(path.join(packageCopy.root, "agents/stacker.md"), "utf8");
  assert.match(stacker, /name: stacker/);
  assert.match(stacker, /package: git-spice/);
  assert.match(stacker, /description: Use this agent to build a stack of dependent git-spice branches/);
  assert.match(stacker, /tools: bash, read, write, edit, find, grep/);
  assert.doesNotMatch(stacker, /model: sonnet/);
  assert.match(stacker, /<paste final stack log output>/);
  assertSafeBranchCreation(stacker, "stacker agent");

  const doctor = readFileSync(path.join(packageCopy.root, "agents/stack-doctor.md"), "utf8");
  assert.match(doctor, /<paste final stack log and git status output>/);
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

const runProbe = (python, packageCopy, source) => spawnSync(
  "python3",
  ["-B", "-c", python, packageCopy.script, source, JSON.stringify(sourceDigestMap(source))],
  { cwd: packageCopy.root, encoding: "utf8" },
);

const generatedTreeProbe = (body) => [
  "import importlib.util, json, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "source = pathlib.Path(sys.argv[2])",
  "temporary = pathlib.Path(module.PACKAGE_ROOT) / 'validator-probe'",
  "temporary.mkdir()",
  "module.validate_source(source, json.loads(sys.argv[3]))",
  "generated = module.build_generated_tree(source, temporary)",
  body,
  "module.validate_generated_tree(generated)",
].join("\n");

test("generated-tree validation rejects required Pi literal cardinality drift", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const mutation = [
    "target = generated / 'prompts/git-spice-continue.md'",
    "text = target.read_text()",
    "target.write_text(text.replace('git-spice --no-prompt rebase continue --no-edit', 'git spice removed', 1))",
  ].join("\n");
  const result = runProbe(generatedTreeProbe(mutation), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required literal.*cardinality/i);
});

test("generated-tree validation rejects forbidden Pi-delta literals", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const mutation = [
    "target = generated / 'prompts/git-spice-stack.md'",
    "target.write_text(target.read_text() + '\\n<extra-flags>\\n')",
  ].join("\n");
  const result = runProbe(generatedTreeProbe(mutation), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden generated content/i);
});

const installationProbe = (injection) => [
  "import importlib.util, json, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "source = pathlib.Path(sys.argv[2])",
  "temporary = pathlib.Path(module.PACKAGE_ROOT) / 'installation-probe'",
  "temporary.mkdir()",
  "module.validate_source(source, json.loads(sys.argv[3]))",
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
