import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-code-quality-plugin.py");

const writeFixtureFile = (root, relativePath, content) => {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const createTemporaryPackage = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-package-"));
  const scriptsDir = path.join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const script = path.join(scriptsDir, "migrate-code-quality-plugin.py");
  copyFileSync(migrationScript, script);
  return { root, script };
};

const promptSource = ({ title, skill, command }) => [
  "---",
  "description: source prompt",
  "---",
  "",
  title,
  "",
  `Run the \`${skill}\` skill against the specified target.`,
  "",
  `Invoke ${command} for this scope.`,
].join("\n") + "\n";

const deepReviewSkillSource = () => [
  "---",
  "name: deep-review",
  "description: fixture deep review skill",
  "---",
  "",
  "# Deep Review",
  "",
  "Read ${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/go.md before scanning.",
  "",
  "Specialized agents scan in parallel for correctness and quality defects, security",
  "vulnerabilities, idiom violations, and solution-fit problems, while a calibration",
  "agent scores every finding, filters false positives, and catches what the scanners",
  "missed.",
  "",
  "## Model Assignment",
  "",
  "| Step | Agent | Model |",
  "|------|-------|-------|",
  "| Step 0 | Scope | Sonnet |",
  "",
  "---",
  "",
  "## Workflow",
  "",
  "### Step 0: Determine scope, reconstruct the problem, gather context, and build idiom baseline",
  "",
  "Launch a subagent with `model: \"sonnet\"` for this step.",
  "",
  "If `.code-quality/review-acceptances.md` exists at the repo root, read it and store the",
  "verbatim contents alongside the rest of Step 0 output. If it is absent, fall back to the",
  "legacy `.code-quality/slop-acceptances.md` (still honored so existing repos don't break).",
  "If neither exists, Phase 2 grades normally with no acceptances applied.",
  "",
  "**Important:** Always use `general-purpose` subagents (or omit the `subagent_type` parameter).",
  "Do NOT use specialized review agents (coderabbit, feature-dev, pr-review-toolkit, etc.) --",
  "this skill provides its own complete review methodology, and specialized agents will blend",
  "their own prompts with these instructions, producing inconsistent results.",
  "",
  "For large reviews (>10 files), split each lens across multiple parallel subagents by",
  "directory or module. Phase 1d should stay cross-cutting unless the PR spans genuinely",
  "independent systems.",
  "",
  "Risk from overestimating only adds one Opus pass.",
  "",
  "#### Phase 1a: Correctness & Quality (model: \"opus\")",
  "#### Phase 1b: Security (model: \"opus\")",
  "#### Phase 1c: Idiom & Best Practices (model: \"opus\")",
  "#### Phase 1d: Architecture and Solution-Fit Review (model: \"fable\" if available, else \"opus\")",
  "#### Phase 1e: AI Slop & Curation Evidence (model: \"sonnet\")",
  "",
  "### Phase 2: Calibration review (model: \"fable\" if available, else \"opus\")",
  "",
  "Launch a **separate, independent** subagent with `model: \"fable\"` when a",
  "Fable/Mythos-class tier is available, otherwise `model: \"opus\"`. This agent receives",
  "ALL findings from all Phase 1 lenses, the original files, the problem reconstruction,",
  "reviewer comments, the codebase context, the idiom baseline, and the curation evidence",
  "bundle.",
  "",
  "> **Accepted deviations.** If Step 0 supplied a `.code-quality/review-acceptances.md`",
  "> file (or the legacy `.code-quality/slop-acceptances.md` fallback), you MUST apply it",
  "> before grading.",
  "",
  "Provide the subagent with:",
  "- Findings from all five lenses (Phase 1a, 1b, 1c, 1d, and 1e)",
  "- The original files under review (so it can re-read them independently)",
  "- The base branch versions of changed files (PR scope)",
  "- The problem reconstruction, reviewer comments, codebase context, and idiom baseline from Step 0",
  "- The curation evidence bundle from Step 0",
  "- The verbatim `.code-quality/review-acceptances.md` contents (or the legacy",
  "  `.code-quality/slop-acceptances.md` fallback), if Step 0 found the file —",
  "  omitting this silently disables the entire acceptances feature",
  "- The language reference file(s) Step 0 loaded",
  "",
  "**Cost optimization — reference file caching.** These reference files are static between",
  "runs against the same codebase. In runtimes that support prompt caching (Claude Code's",
  "session cache, Anthropic SDK `cache_control` markers, etc.), include the loaded language",
  "reference content in a cached prefix so repeat reviews against the same repo amortize",
  "the input cost. In Claude Code this is automatic for skill content. In headless / CI",
  "contexts (GitHub Actions via Claude Agent SDK), set `cache_control: {\"type\": \"ephemeral\"}`",
  "on the reference-file content blocks for the largest savings.",
  "",
  "5. **Acceptances file** -- Has the project pre-registered the concern in",
  "   `.code-quality/review-acceptances.md` (legacy `.code-quality/slop-acceptances.md`",
  "   honored as fallback)? If yes, Phase 2 will dismiss the finding automatically; Phase 1",
  "   still scans blind so the evidence remains visible.",
  "",
  "1. **Detect mode.** Non-interactive (CI) if `CI`/`GITHUB_ACTIONS`/`GITLAB_CI`/",
  "   `BUILDKITE` env vars are set or stdin is not a TTY. Never call `AskUserQuestion`",
  "   in non-interactive mode.",
  "2. **Detect a PR**, in priority order: explicit PR number/URL in the request →",
  "   GitHub Actions event payload (`GITHUB_EVENT_PATH`) → `gh pr view` for the",
  "   current branch.",
  "3. **Interactive + PR found:** `AskUserQuestion` — post PR comment (recommended)",
  "   or write `DEEP_REVIEW.md`. **Interactive + no PR:** write `DEEP_REVIEW.md`",
  "   directly, no menu.",
  "4. **Non-interactive:** PR found → auto-post the PR comment, no confirmation;",
  "   no PR → write `DEEP_REVIEW.md` and print a one-line verdict summary to stdout.",
  "   If posting fails, exit non-zero — never silently fall back.",
].join("\n") + "\n";

const invalidDeepReviewSkillSource = () => [
  "---",
  "name: deep-review",
  "description: fixture deep review skill",
  "---",
  "",
  "# Deep Review",
  "",
  "This valid-frontmatter fixture deliberately omits a required semantic patch anchor.",
].join("\n") + "\n";

const outputActionsSource = () => [
  "# Output Actions — delivery procedure for deep-review",
  "",
  "Read this file when the review is synthesized and ready to deliver. The default flow is:",
  "**detect mode → detect a PR → ask the user (only when interactive) → render and deliver**.",
  "",
  "## 1. Detect interactive vs. non-interactive (CI/CD) mode",
  "",
  "The skill runs in two contexts:",
  "",
  "- **Interactive** — a human is in the loop (Claude Code session, IDE",
  "  extension). `AskUserQuestion` works.",
  "- **Non-interactive** — running headless in CI/CD (GitHub Actions via the",
  "  Claude Agent SDK, scheduled cron job, automation). `AskUserQuestion`",
  "  has no human to answer it; either it errors or it stalls the job.",
  "",
  "Detect non-interactive mode if **any** of these is true:",
  "",
  "```bash",
  "[ \"${CI:-}\"             = \"true\" ] || \\",
  "[ \"${GITHUB_ACTIONS:-}\" = \"true\" ] || \\",
  "[ \"${GITLAB_CI:-}\"      = \"true\" ] || \\",
  "[ \"${BUILDKITE:-}\"      = \"true\" ] || \\",
  "[ ! -t 0 ]   # stdin is not a TTY",
  "```",
  "",
  "If the user passed an explicit non-interactive flag in their request",
  "(\"non-interactive mode\", \"headless\", \"CI mode\", \"auto-post\"), treat it as",
  "non-interactive regardless of env.",
  "",
  "In non-interactive mode:",
  "",
  "- **Skip `AskUserQuestion` entirely.** Never call it — it is interactive",
  "  by design.",
  "- **Default behavior depends on PR detection** (next section):",
  "  - PR detected → post the rendered PR comment automatically.",
  "  - No PR detected → write `DEEP_REVIEW.md` to the working directory and",
  "    additionally print a one-line summary (verdict + grade + final score)",
  "    to stdout so the CI log captures it.",
  "- **Never prompt for confirmation before posting.** In CI the user has",
  "  already opted in to auto-posting by triggering the workflow; an",
  "  unanswered confirm would block the job.",
  "- **Surface failures visibly.** If `gh pr comment` fails (auth, rate",
  "  limit, repo permissions), exit non-zero with the error so the workflow",
  "  step fails loudly. Do not silently fall back.",
  "",
  "## 2. Detect whether a PR exists",
  "",
  "Use an explicit PR, GitHub event payload, or `gh pr view` for the current branch.",
  "",
  "## 3. Ask the user (interactive mode only)",
  "",
  "Legacy interactive delivery instructions.",
  "",
  "## 4. Posting to a PR",
  "",
  "Legacy PR posting instructions.",
  "",
  "## 5. PR Comment Format",
  "",
  "<sub>Generated by `/code-quality:review` · 5-lens parallel scan + calibration</sub>",
  "",
  "## 6. Writing DEEP_REVIEW.md",
  "",
  "Write the full markdown report.",
  "",
  "## 7. Other delivery shapes (when the user picks \"Other\")",
  "",
  "**Review branch with markdown report.** Best for full-codebase audits and",
  "archival. Create a new branch `<user>/deep-review`, write to",
  "`CLAUDE_DEEP_REVIEW.md` at the repo root, commit, and push. Tell the user",
  "the branch is ready and they can open a PR for team discussion.",
].join("\n") + "\n";

const sizeReviewSkillSource = () => [
  "---",
  "name: size-review",
  "description: fixture size review skill",
  "---",
  "",
  "# Size Review",
  "",
  "Read ${CLAUDE_PLUGIN_ROOT}/skills/size-review/references/default-exclusions.md.",
  "",
  "- **Sonnet is sufficient for the mechanical steps** (Steps 1-3: scope discovery,",
  "  exclusions, structural signals). The judgment-heavy steps (Steps 4-6: seam",
  "  viability, effort rating, recommendation) benefit from Opus when available, but",
  "  Sonnet handles them adequately at substantially lower cost.",
  "",
  "For high-volume CI usage (every PR), consider running this skill at Sonnet by default",
  "and reserving Opus only for explicit deep-dive requests or PRs flagged by other gates.",
  "",
  "- **Easy** — Commits already partition along the seam. A `git rebase -i`",
  "  or `gs branch split` produces clean slices with no conflicts.",
  "",
  "- The author can use `gs stack submit` to push the whole stack at once",
  "  and get review on the bottom while writing the top",
  "",
  "### Suggested git-spice flow",
  "",
  "\\`\\`\\`bash",
  "# If the PR has heavy fixup noise, squash by section first:",
  "git rebase -i <base-ref>",
  "# squash fix/lint/CI-debug commits into their parent feature commits",
  "",
  "# Then start the stack from trunk:",
  "git checkout <base-ref>",
  "gs branch create refactor-foo-rename --target main",
  "# cherry-pick or restack the relevant commits",
  "gs branch create feat-bar-add-endpoint --target refactor-foo-rename",
  "# ...",
  "gs stack submit",
  "\\`\\`\\`",
  "",
  "If the author already has git-spice loaded, point them at the",
  "`git-spice:stacking-workflow` skill for the full workflow.",
  "",
  "## Output Actions",
  "",
  "**Detect mode first.** Non-interactive (CI) if any of `CI`, `GITHUB_ACTIONS`,",
  "`GITLAB_CI`, or `BUILDKITE` is `\"true\"`, or stdin is not a TTY, or the user",
  "asked for headless/CI/auto-post mode. In non-interactive mode never prompt:",
  "PR in scope → post the report as a PR comment automatically",
  "(`gh pr comment <num> --body-file <report.md>`), and exit non-zero if the",
  "post fails; no PR → print the report to stdout with a one-line",
  "`size-review: <verdict> · <recommendation>` summary line.",
  "",
  "In interactive mode, ask the user how to surface the report:",
  "",
  "- **Inline** — return the markdown in the chat. Default for ad-hoc reviews.",
  "- **PR comment** — post the report as a top-level review comment on the",
  "  GitHub PR (`gh pr comment <num> --body-file <report.md>`). Default",
  "  for PR-scoped reviews.",
  "- **Branch + markdown** — write to `CLAUDE_SIZE_REVIEW.md` and commit on",
  "  a `<user>/size-review` branch for archival.",
  "",
  "If a stack plan was produced and the user wants to act on it, offer to",
  "hand off to the `git-spice:stacker` agent or the `git-spice:stacking-workflow`",
  "skill, which can drive the actual split end-to-end.",
].join("\n") + "\n";

const createSourceFixture = (overrides = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-source-"));
  const files = {
    "commands/review.md": promptSource({
      title: overrides.reviewPromptTitle ?? "# Deep Review",
      skill: "deep-review",
      command: "/code-quality:review",
    }),
    "commands/size.md": promptSource({
      title: overrides.sizePromptTitle ?? "# Size Review",
      skill: "size-review",
      command: "/code-quality:size",
    }),
    "skills/deep-review/SKILL.md": overrides.deepReviewSkill ?? deepReviewSkillSource(),
    "skills/deep-review/references/go.md": "# Go\n${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/shared.md\n",
    "skills/deep-review/references/python.md": "# Python\n${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/shared.md\n",
    "skills/deep-review/references/rust.md": "# Rust\n${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/shared.md\n",
    "skills/deep-review/references/svelte-ts.md": "# Svelte TypeScript\n${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/shared.md\n",
    "skills/deep-review/references/output-actions.md": outputActionsSource(),
    "skills/size-review/SKILL.md": sizeReviewSkillSource(),
    "skills/size-review/references/default-exclusions.md": "# Exclusions\n${CLAUDE_PLUGIN_ROOT}/skills/size-review/references/shared.md\n",
    ".claude-plugin/plugin.json": "{}\n",
  };

  for (const [relativePath, content] of Object.entries(files)) {
    writeFixtureFile(root, relativePath, content);
  }

  return root;
};

test("migration CLI exposes positional and option source forms", () => {
  const help = execFileSync("python3", [migrationScript, "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.match(help, /Regenerate pi-code-quality resources/);
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
});

test("invalid source fails before rewriting package resources", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-source-"));
  const protectedPath = path.join(packageRoot, "prompts/code-quality-size.md");
  const before = readFileSync(protectedPath, "utf8");
  try {
    mkdirSync(path.join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(fixture, ".claude-plugin/plugin.json"), "{}\n");
    const result = spawnSync("python3", [migrationScript, fixture], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing expected paths/);
    assert.equal(readFileSync(protectedPath, "utf8"), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("semantic patch failures abort before installing generated resources", () => {
  const source = createSourceFixture({ deepReviewSkill: invalidDeepReviewSkillSource() });
  const packageCopy = createTemporaryPackage();
  const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-size.md");
  const protectedSkill = path.join(packageCopy.root, "skills/size-review/SKILL.md");
  const promptBefore = "stable size prompt\n";
  const skillBefore = "stable size skill\n";
  writeFixtureFile(packageCopy.root, "prompts/code-quality-size.md", promptBefore);
  writeFixtureFile(packageCopy.root, "skills/size-review/SKILL.md", skillBefore);

  try {
    const result = spawnSync("python3", [packageCopy.script, source], {
      cwd: packageCopy.root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected source text not found|Expected section markers not found/);
    assert.equal(readFileSync(protectedPrompt, "utf8"), promptBefore);
    assert.equal(readFileSync(protectedSkill, "utf8"), skillBefore);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("prompt heading drift fails before installing generated resources", () => {
  for (const [label, overrides, expectedHeading] of [
    ["review", { reviewPromptTitle: "# Review Drift" }, "# Deep Review"],
    ["size", { sizePromptTitle: "# Size Drift" }, "# Size Review"],
  ]) {
    const source = createSourceFixture(overrides);
    const packageCopy = createTemporaryPackage();
    const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-size.md");
    const promptBefore = `stable ${label} prompt\n`;
    writeFixtureFile(packageCopy.root, "prompts/code-quality-size.md", promptBefore);

    try {
      const result = spawnSync("python3", [packageCopy.script, source], {
        cwd: packageCopy.root,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${label} heading drift should fail before install`);
      assert.match(result.stderr, new RegExp(`Expected prompt heading ${expectedHeading.replace("#", "#")}`));
      assert.equal(readFileSync(protectedPrompt, "utf8"), promptBefore);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(packageCopy.root, { recursive: true, force: true });
    }
  }
});

test("generated deep-review delivery requires gh availability and auth before PR posting", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();

  try {
    const result = spawnSync("python3", [packageCopy.script, source], {
      cwd: packageCopy.root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const skill = readFileSync(path.join(packageCopy.root, "skills/deep-review/SKILL.md"), "utf8");
    const outputActions = readFileSync(
      path.join(packageCopy.root, "skills/deep-review/references/output-actions.md"),
      "utf8",
    );

    for (const content of [skill, outputActions]) {
      assert.match(content, /command -v gh/);
      assert.match(content, /gh auth status/);
      assert.match(content, /unavailable or unauthenticated/);
      assert.match(content, /DEEP_REVIEW\.md/);
    }
    assert.match(outputActions, /Do not offer the PR-post option/);
    assert.match(outputActions, /write `DEEP_REVIEW\.md`, print the one-line summary/);
    assert.match(outputActions, /actual `gh pr comment` post fails/);
    assert.match(outputActions, /exit\s+non-zero/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});
