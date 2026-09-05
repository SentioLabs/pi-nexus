import assert from "node:assert/strict";

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

const joinedLine = (...parts) => parts.join("");
const manualOnly = "terminal-only; do not execute via a Pi/tool subprocess.";
const manualSourceLines = {
  initAuth: joinedLine(
    "4. After init, run `git-spice auth status` and report whether the user is logged in. ",
    "If not, suggest `git-spice auth login` — do NOT run it yourself (it's an interactive browser flow).",
  ),
  submitAuth: joinedLine(
    "1. Confirm auth: `git-spice auth status`. If not logged in, stop and instruct the user to run ",
    "`git-spice auth login` themselves (interactive). Don't proceed with an unauthenticated submit.",
  ),
  skillAuth: "| Log in to GitHub/GitLab/Bitbucket | `git-spice auth login` |",
  skillCommitSplit: "| Split a commit interactively | `git-spice commit split` (`git-spice csp`) |",
  skillBranchSplit: "| Split this branch at chosen commits | `git-spice branch split` (`git-spice bsp`) |",
  skillBranchEdit: joinedLine(
    "| Interactively edit/reorder this branch's commits | `git-spice branch edit` (`git-spice be`) ",
    "— interactive; restacks upstack after |",
  ),
  skillStackEdit: "| Reorder branches in the stack | `git-spice stack edit` (`git-spice se`) — interactive |",
  skillDownstackEdit: joinedLine(
    "| Reorder branches below the current one | `git-spice downstack edit` (`git-spice dse`) — interactive |",
  ),
  skillBranchEditWarning: joinedLine(
    "- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. ",
    "Use `git-spice upstack restack`, or `git-spice branch edit` when the user is driving interactively.",
  ),
  stackingBranchSplit: joinedLine(
    "- **\"A branch grew too big and needs splitting.\"** Sizing problem. `git-spice branch split` ",
    "at chosen commits (interactive — hand it to the user in unattended runs).",
  ),
  doctorAuth: joinedLine(
    "| Submit errors with auth message | token expired or scope insufficient | `git-spice auth login` ",
    "(user must run interactively) |",
  ),
};
const manualTargetLines = {
  initAuth: joinedLine(
    "4. After init, run `git-spice --no-prompt auth status` and report whether the user is logged in. ",
    "If not, suggest `git-spice auth login` — ", manualOnly,
  ),
  submitAuth: joinedLine(
    "1. Confirm auth: `git-spice --no-prompt auth status`. If not logged in, stop and instruct the user to run ",
    "`git-spice auth login` themselves — ", manualOnly,
    " Don't proceed with an unauthenticated submit.",
  ),
  skillAuth: "| Log in to GitHub/GitLab/Bitbucket | `git-spice auth login` — " + manualOnly + " |",
  skillCommitSplit: joinedLine(
    "| Split a commit interactively | `git-spice commit split` (`git-spice csp`) — ", manualOnly, " |",
  ),
  skillBranchSplit: joinedLine(
    "| Split this branch at chosen commits | `git-spice branch split` (`git-spice bsp`) — ", manualOnly, " |",
  ),
  skillBranchEdit: joinedLine(
    "| Interactively edit/reorder this branch's commits | `git-spice branch edit` (`git-spice be`) — ",
    manualOnly, " Restacks upstack after. |",
  ),
  skillStackEdit: joinedLine(
    "| Reorder branches in the stack | `git-spice stack edit` (`git-spice se`) — ", manualOnly, " |",
  ),
  skillDownstackEdit: joinedLine(
    "| Reorder branches below the current one | `git-spice downstack edit` (`git-spice dse`) — ", manualOnly, " |",
  ),
  skillBranchEditWarning: joinedLine(
    "- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. ",
    "Use `git-spice --no-prompt upstack restack`, or `git-spice branch edit` — ", manualOnly,
  ),
  stackingBranchSplit: joinedLine(
    "- **\"A branch grew too big and needs splitting.\"** Sizing problem. `git-spice branch split` ",
    "at chosen commits — ", manualOnly,
  ),
  doctorAuth: joinedLine(
    "| Submit errors with auth message | token expired or scope insufficient | `git-spice auth login` — ",
    manualOnly, " |",
  ),
};
export const manualInteractiveTransforms = [
  ["auth login", "commands/init.md", "initAuth"],
  ["auth login", "commands/submit.md", "submitAuth"],
  ["auth login", "skills/git-spice/SKILL.md", "skillAuth"],
  ["commit split", "skills/git-spice/SKILL.md", "skillCommitSplit"],
  ["branch split", "skills/git-spice/SKILL.md", "skillBranchSplit"],
  ["branch edit", "skills/git-spice/SKILL.md", "skillBranchEdit"],
  ["stack edit", "skills/git-spice/SKILL.md", "skillStackEdit"],
  ["downstack edit", "skills/git-spice/SKILL.md", "skillDownstackEdit"],
  ["branch edit guidance", "skills/git-spice/SKILL.md", "skillBranchEditWarning"],
  ["branch split", "skills/stacking-workflow/SKILL.md", "stackingBranchSplit"],
  ["auth login", "agents/stack-doctor.md", "doctorAuth"],
].map(([name, relative, key]) => [name, relative, manualSourceLines[key], manualTargetLines[key]]);

export const rawSourceFiles = () => ({
  "commands/continue.md": prompt("Resume a git-spice operation after resolving rebase conflicts (or abort with --abort)", [
    "# Continue",
    "Resume — or abort — a git-spice operation that was paused on a rebase conflict.",
    "Parse `$ARGUMENTS` and run `git-spice rebase continue`.",
    "To abandon a rebase, run `git-spice rebase abort`.",
    joinedLine(
      "Why `git-spice rebase continue` and not `git rebase --continue`? git-spice's wrapper resumes the ",
      "*outer* operation (e.g., a stack restack across N branches). Plain `git rebase --continue` only ",
      "finishes the current branch's rebase and leaves git-spice's queue stalled.",
    ),
  ].join("\n"), "[--abort]"),
  "commands/init.md": prompt("Initialize git-spice in the current repo (sets trunk + remote, checks auth)", [
    "# Init",
    "Initialize git-spice for this repository.",
    "Confirm you're inside a git repository:",
    joinedLine(
      "2. Check whether git-spice is already initialized: `git-spice log long 2>&1`. If it succeeds and ",
      "shows a trunk, tell the user it's already initialized and offer to re-init with `git-spice repo init ",
      "--reset` only if they ask.",
    ),
    joinedLine(
      "3. Run `git-spice repo init`. If `$ARGUMENTS` was provided, treat it as either a trunk branch name ",
      "or `--trunk=<name> --remote=<name>` flags and pass it through. Otherwise let the interactive prompt run.",
    ),
    manualSourceLines.initAuth,
  ].join("\n"), "[trunk-name | --trunk=<name> --remote=<name>]"),
  "commands/new.md": prompt("Create a stacked branch", [
    "# New",
    "Create a new branch on top of the current one with `git-spice branch create`.",
    joinedLine(
      "1. Parse `$ARGUMENTS` as the branch name. If empty, ask the user for one (or note that git-spice ",
      "will auto-generate from the commit message if `--no-commit` isn't used).",
    ),
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
    manualSourceLines.submitAuth,
    "2. Parse `$ARGUMENTS` and resolve the scope.",
    "   - Remaining tokens are passed through as flags.",
    "3. Run a dry run first: `git-spice <scope> submit --dry-run --fill`.",
    joinedLine(
      "4. Then run the real submit: `git-spice <scope> submit --fill <extra-flags>`. The `--fill` flag ",
      "populates title/body from commit messages so the run is non-interactive.",
    ),
    "Use `/git-spice:submit` to submit again.",
    "5. After submit, summarize: which CRs were created vs updated, and the URLs (git-spice prints them).",
  ].join("\n"), "[branch|upstack|downstack|stack] [extra flags]"),
  "commands/sync.md": prompt("Sync merged branches", [
    "# Sync",
    "Sync with the remote: pull trunk, delete merged branches, restack survivors.",
    "Run `git-spice repo sync --restack` and recover with `/git-spice:continue`.",
  ].join("\n")),
  "skills/git-spice/SKILL.md": skill(
    "git-spice",
    joinedLine(
      "Reference for the git-spice CLI — stacked-branch workflows, command map, and recovery from interrupted ",
      "rebases. This skill should be used whenever the user mentions git-spice, `gs`, stacked PRs, stacked diffs, ",
      "branch stacks, dependent branches, PRs that depend on each other, or says things like \"stack this\", ",
      "\"check the stack\", \"submit the stack\", \"submit my stacked PRs\", \"restack\", \"rebase failed\", ",
      "\"sync after merge\", \"what's on top of <branch>\", \"branch above/below\". Also load when a multi-step ",
      "plan would naturally produce a chain of dependent branches and you need to drive that with the CLI, or ",
      "when an interrupted rebase needs recovery.",
    ),
    [
    "# git-spice",
    "",
    joinedLine(
      "git-spice is a CLI for managing **stacks of dependent Git branches**. Each branch (except the trunk) has ",
      "a recorded *base* — the branch it was created from. git-spice tracks those relationships, restacks ",
      "(rebases) dependents automatically when a base changes, and submits the whole chain as separate-but-linked ",
      "Change Requests (CRs — PRs on GitHub, MRs on GitLab).",
    ),
    joinedLine(
      "The official shorthand is `gs`, but on many systems `gs` is **Ghostscript**. **Always invoke `git-spice` ",
      "directly** in scripts, commands, and tool calls — never assume `gs` is git-spice. (If a user types `gs` in ",
      "chat, mentally map it to `git-spice`.)",
    ),
    "- **base** — the branch a given branch was created from. Stored as metadata by git-spice.",
    "",
    "## Command map",
    joinedLine(
      "> **Interactive prompts**: several commands open an interactive prompt when arguments are omitted ",
      "(`branch checkout` with no name, `branch delete` with no name, `repo init` without `--trunk`, `commit pick` ",
      "with no ref) or are inherently interactive (`stack edit`, `downstack edit`, `branch edit`, `commit split`, ",
      "`branch split` without flags). In non-interactive runs — scripts, tool calls, subagents — always pass explicit ",
      "arguments, and add the global `--no-prompt` flag to fail fast instead of hanging on a prompt. Leave the ",
      "inherently-interactive commands to the user.",
    ),
    "git-spice operations are *local-first*. Auth is only needed for `submit`/`sync` (network operations).",
    "| Initialize git-spice in this repo | `git-spice repo init --trunk=<name> --remote=<name>` (`git-spice r i`) |",
    manualSourceLines.skillAuth,
    "| Commit staged changes here | `git-spice commit create` (`git-spice cc`) |",
    "| Amend the tip commit | `git-spice commit amend` (`git-spice ca`) |",
    "| Squash this branch's commits into one | `git-spice branch squash` (`git-spice bsq`) |",
    manualSourceLines.skillCommitSplit,
    manualSourceLines.skillBranchSplit,
    manualSourceLines.skillBranchEdit,
    manualSourceLines.skillStackEdit,
    manualSourceLines.skillDownstackEdit,
    joinedLine(
      "> Prefer `git-spice commit ...` over raw `git commit` while inside a stack. The git-spice variants restack ",
      "everything above the current branch automatically; `git commit` leaves upstack branches misaligned and ",
      "you'll have to run `git-spice upstack restack` yourself.",
    ),
    "git-spice rebases run `git rebase` under the hood. Conflicts pause the operation. **Resolve with the git-spice variants, not raw git:**",
    "2. Run `git-spice rebase continue`. git-spice resumes its multi-branch operation (e.g., a stack restack continues onto the next branch).",
    "Using raw `git rebase --continue` works for the *current* rebase only; git-spice won't auto-advance to the next branch in a multi-step operation.",
    joinedLine(
      "- **Don't `git push --force`** on a tracked branch. Use `git-spice <scope> submit <draft-flag>` — ",
      "git-spice uses `--force-with-lease` semantics and updates only the branches that need it.",
    ),
    "- **Don't assume `gs`** is git-spice in commands you write. Always `git-spice`.",
    manualSourceLines.skillBranchEditWarning,
    "Use `git-spice log long` to inspect a stack.",
    "For work run `git-spice branch create <slug>` (`git-spice bc`).",
    "After conflicts, run `git-spice rebase continue` (`git-spice rbc`).",
    "```bash",
    "git-spice branch create feat-a",
    "git-spice commit amend          # or commit create — both auto-restack upstack",
    "git-spice commit amend",
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
    "git-spice commit amend            # or 'commit create' for a follow-up commit",
    "- I committed with `git commit` instead of `git-spice commit create`.",
    manualSourceLines.stackingBranchSplit,
    "",
    "## Driving with subagents",
    "Dispatch via the Task tool with `subagent_type: git-spice:stacker` or `subagent_type: git-spice:stack-doctor`.",
    "",
    "## Don't",
  ].join("\n")),
  "agents/stack-doctor.md": agent(
    joinedLine(
      "Use this agent to diagnose and repair a wedged git-spice stack — interrupted rebases, branches diverged ",
      "from their bases, untracked branches that should be tracked, wrong trunk recorded, or generally confused ",
      "state. Dispatch when manual fixes aren't working or when the failure mode isn't obvious. Read-mostly during ",
      "diagnosis; mutations only after explaining the plan in the report.",
    ),
    ["Bash", "Read", "Glob", "Grep"],
    [
    "# Stack Doctor Agent",
    "",
    joinedLine(
      "You diagnose and repair broken git-spice stacks. Default to *read-only* during diagnosis. Mutations are ",
      "deliberate, narrowly scoped, and explained in your final report. You have a fresh context — everything you ",
      "need is in the dispatch prompt and what you discover by inspecting the repo.",
    ),
    joinedLine(
      "2. **Never `git rebase --continue` directly during a git-spice operation.** Use `git-spice rebase ",
      "continue`. Plain git only finishes the inner rebase and leaves git-spice's outer queue stalled.",
    ),
    "## Diagnosis checklist",
    "Run `git-spice rebase continue` only after a diagnosis.",
    "For a known repair, run `git-spice <scope> submit --fill`.",
    "| Branches exist in git but not in `log long --all` | untracked | `git-spice branch track` per branch, or `git-spice downstack track` from the top |",
    manualSourceLines.doctorAuth,
    "## Repair principles",
    "Final state:",
    "<paste git-spice log long and git status>",
  ].join("\n")),
  "agents/stacker.md": agent(
    joinedLine(
      "Use this agent to build a stack of dependent git-spice branches from an ordered list of changes. Dispatch ",
      "when you have a multi-step plan whose pieces must ship in order and you want the execution loop (implement ",
      "→ stage → branch create → repeat) handled in a single pass. Receives the task list and the starting branch ",
      "in its prompt; reports back per-branch results.",
    ),
    ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    [
    "# Stacker Agent",
    "",
    joinedLine(
      "You build a stack of git-spice branches from an ordered list of changes. You receive the list, the ",
      "starting branch, and any context the dispatcher chose to include. You have a fresh context — everything ",
      "you need is in the dispatch prompt.",
    ),
    joinedLine(
      "You run unattended — an interactive prompt will hang you. Always pass explicit arguments (branch names, ",
      "commit messages) and add the global `--no-prompt` flag to git-spice commands so missing information fails ",
      "fast instead of prompting. A `--no-prompt` failure is a `BLOCKED`/`NEEDS_CONTEXT` signal, not something to ",
      "work around.",
    ),
    "## Non-interactive discipline",
    joinedLine(
      "`git-spice branch create <prefix><slug>` (uses staged changes as the commit). The commit message defaults ",
      "to the staged changes; if the task description maps to a clean conventional-commit subject, prefer ",
      "`git-spice branch create <name> -m \"<subject>\"`.",
    ),
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

const commandNames = "(?:repo|auth|log|branch|commit|upstack|downstack|stack|rebase|trunk|top|bottom|up|down|<scope>)";
export const commandAnchorPattern = new RegExp(
  `(?<![\\w-])git-spice(?= ${commandNames}(?:\\s|\`|$))`,
  "g",
);
export const mutationAnchorPatterns = {
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
  "commands/continue.md": 4, "commands/init.md": 6, "commands/new.md": 5,
  "commands/restack.md": 5, "commands/stack.md": 2, "commands/submit.md": 4, "commands/sync.md": 3,
  "skills/git-spice/SKILL.md": 96, "skills/stacking-workflow/SKILL.md": 12,
  "agents/stack-doctor.md": 24, "agents/stacker.md": 10,
};
const expectedMutationAnchorCounts = {
  "commands/continue.md": { rebaseContinue: 2, rebaseAbort: 1 }, "commands/init.md": { init: 1, reset: 1 },
  "commands/new.md": { branchCreate: 4 }, "commands/restack.md": { restack: 4 },
  "commands/submit.md": { submit: 2 }, "commands/sync.md": { sync: 1 },
  "skills/git-spice/SKILL.md": { init: 3, reset: 2, branchCreate: 12, rebaseContinue: 3, rebaseAbort: 2, restack: 11, sync: 3, submit: 8 },
  "skills/stacking-workflow/SKILL.md": { branchCreate: 1, rebaseContinue: 1, restack: 1, sync: 1, submit: 1 },
  "agents/stack-doctor.md": { init: 2, rebaseContinue: 3, restack: 7, submit: 3 }, "agents/stacker.md": { branchCreate: 3, submit: 2 },
};
const aliasNames = [
  "r", "ls", "ll", "bdi", "bc", "btr", "dstr", "cc", "ca", "csp", "cf", "cp", "bco", "br",
  "usr", "dsr", "sr", "rr", "bsq", "bsp", "be", "bfo", "bon", "uso", "se", "dse", "brn", "bd",
  "sd", "usd", "buntr", "bs", "dss", "uss", "ss", "rs", "rbc", "rba",
];
const aliasCommandAnchorPattern = new RegExp(
  `(?<![\\w-])git-spice(?= (?:${aliasNames.join("|")})(?:\\s|\`|\\)))`,
  "g",
);
const expectedAliasNames = {
  r: 1, ls: 2, ll: 2, bdi: 1, bc: 1, btr: 1, dstr: 1, cc: 1, ca: 1, csp: 1, cf: 1, cp: 1,
  bco: 1, br: 1, usr: 1, dsr: 1, sr: 1, rr: 1, bsq: 1, bsp: 1, be: 1, bfo: 1, bon: 1, uso: 1,
  se: 1, dse: 1, brn: 1, bd: 1, sd: 1, usd: 1, buntr: 1, bs: 1, dss: 1, uss: 1, ss: 1, rs: 1,
  rbc: 1, rba: 1,
};
const expectedAliasCommandAnchorCounts = { "skills/git-spice/SKILL.md": 40 };
export const editorOpeningAnchors = [
  ["commit create", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? commit create(?=[^\w-]|$)/g],
  ["commit create alias", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? cc(?=[^\w-]|$)/g],
  ["commit amend", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? commit amend(?=[^\w-]|$)/g],
  ["commit amend alias", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? ca(?=[^\w-]|$)/g],
  ["branch squash", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? branch squash(?=[^\w-]|$)/g],
  ["branch squash alias", "skills/git-spice/SKILL.md", /git-spice(?: --no-prompt)? bsq(?=[^\w-]|$)/g],
  ["commit create", "skills/stacking-workflow/SKILL.md", /git-spice(?: --no-prompt)? commit create(?=[^\w-]|$)/g],
  ["commit amend", "skills/stacking-workflow/SKILL.md", /git-spice(?: --no-prompt)? commit amend(?=[^\w-]|$)/g],
  ["direct commit create alternative", "skills/git-spice/SKILL.md", /# or commit create —/g],
  ["direct commit create alternative", "skills/stacking-workflow/SKILL.md", /# or 'commit create' for/g],
];

const mutationPadding = {
  reset: "Fixture reset mutation: `git-spice repo init --reset`.", init: "Fixture init mutation: `git-spice repo init`.",
  branchCreate: "Fixture branch mutation: `git-spice branch create <fixture> -m \"fixture\"`.",
  rebaseContinue: "Fixture continue mutation: `git-spice rebase continue`.", rebaseAbort: "Fixture abort mutation: `git-spice rebase abort`.",
  restack: "Fixture restack mutation: `git-spice branch restack`.", sync: "Fixture sync mutation: `git-spice repo sync`.",
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

export const sourceFiles = () => Object.fromEntries(Object.entries(rawSourceFiles()).map(([relative, content]) => [
  relative,
  relative.endsWith(".md") && !relative.endsWith("CHANGELOG.md") ? padExpectedAnchors(relative, content) : content,
]));

export const manualInteractiveOutput = manualInteractiveTransforms.map(
  ([name, source, , target]) => [
    name,
    source.startsWith("commands/")
      ? `prompts/git-spice-${source.slice("commands/".length)}`
      : source,
    target,
  ],
);

export const forbiddenManualSubprocessCommands = [
  "auth login", "commit split", "csp", "branch split", "bsp",
  "branch edit", "be", "stack edit", "se", "downstack edit", "dse",
];

const validPluginMetadata = () => JSON.parse(rawSourceFiles()[".claude-plugin/plugin.json"]);
const changedPluginMetadata = (change) => {
  const metadata = validPluginMetadata();
  change(metadata);
  return JSON.stringify(metadata);
};
const metadataVariants = [
  [
    "plugin metadata missing field",
    () => changedPluginMetadata((metadata) => { delete metadata.homepage; }),
    /fields must exactly match.*missing=.*homepage/s,
  ],
  [
    "plugin metadata duplicate top-level key",
    () => rawSourceFiles()[".claude-plugin/plugin.json"].replace(
      '"name": "git-spice",',
      '"name": "git-spice",\n  "name": "duplicate",',
    ),
    /Duplicate JSON key.*name/,
  ],
  [
    "plugin metadata duplicate nested key",
    () => rawSourceFiles()[".claude-plugin/plugin.json"].replace(
      '"name": "Fixture",',
      '"name": "Fixture",\n    "name": "duplicate",',
    ),
    /Duplicate JSON key.*name/,
  ],
  [
    "plugin metadata unknown field",
    () => changedPluginMetadata((metadata) => { metadata.future = true; }),
    /fields must exactly match.*unknown=.*future/s,
  ],
  ["plugin metadata malformed JSON", () => "{ not-json\n", /Invalid source plugin\.json/],
  [
    "plugin metadata whitespace-only scalar",
    () => changedPluginMetadata((metadata) => { metadata.description = "   \t"; }),
    /description must be a non-empty string/,
  ],
  [
    "plugin metadata whitespace-only author scalar",
    () => changedPluginMetadata((metadata) => { metadata.author.url = "  "; }),
    /author must have non-empty string name and url/,
  ],
  [
    "plugin metadata whitespace-only keyword",
    () => changedPluginMetadata((metadata) => { metadata.keywords = ["git-spice", "  "]; }),
    /keywords must be a string array of non-empty values/,
  ],
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

const frontmatterFailures = (prefix, relative, variants) => variants.map(
  ([name, mutate, diagnostic]) => [
    `${prefix} ${name}`,
    relative,
    () => mutate(sourceFiles()[relative]),
    diagnostic,
  ],
);
export const failureVariants = [
  ...metadataVariants.map(([name, makeContent, diagnostic]) => [
    name,
    ".claude-plugin/plugin.json",
    makeContent,
    diagnostic,
  ]),
  ...frontmatterFailures("prompt frontmatter", "commands/continue.md", promptFrontmatterVariants),
  ...frontmatterFailures("skill frontmatter", "skills/git-spice/SKILL.md", skillFrontmatterVariants),
  ...frontmatterFailures("agent frontmatter", "agents/stacker.md", agentFrontmatterVariants),
  [
    "agent frontmatter invalid fixed model",
    "agents/stacker.md",
    () => sourceFiles()["agents/stacker.md"].replace("model: sonnet", "model: opus"),
    /model must be exactly/,
  ],
  [
    "removed semantic prose anchor",
    "commands/init.md",
    () => sourceFiles()["commands/init.md"].replace("Confirm you're inside a git repository:", "Confirm setup:"),
    /Expected exactly one source text occurrence/,
  ],
  [
    "duplicated semantic prose anchor",
    "commands/init.md",
    () => sourceFiles()["commands/init.md"] + "Confirm you're inside a git repository:\n",
    /Expected exactly one source text occurrence/,
  ],
];
