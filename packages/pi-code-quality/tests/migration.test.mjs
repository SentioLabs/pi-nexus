import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-code-quality-plugin.py");
const runtimeManifest = JSON.parse(execFileSync(
  "python3",
  [
    "-B",
    "-c",
    "import importlib.util, json, sys; spec = importlib.util.spec_from_file_location('migration', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps([target for _, target in module.RUNTIME_MANIFEST]))",
    migrationScript,
  ],
  { encoding: "utf8" },
));

test("real migration-script manifest probes leave no package bytecode cache", () => {
  assert.equal(existsSync(path.join(packageRoot, "scripts", "__pycache__")), false);
});

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
  "Perform a comprehensive code review through a 5-lens parallel architecture.",
  "",
  "Read ${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/go.md before scanning.",
  "",
  "Specialized agents scan in parallel for correctness and quality defects, security",
  "vulnerabilities, idiom violations, and solution-fit problems, while a calibration",
  "agent scores every finding, filters false positives, and catches what the scanners",
  "missed.",
  "",
  "After the parallel scan, a calibration agent scores every finding on a 0-100 scale,",
  "cross-references across lenses, and produces a filtered, verdict-bearing report.",
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
  "### Phase 1: Parallel 5-lens scan",
  "",
  "Launch the applicable subagents in parallel. **Tailor each lens's context bundle** to",
  "what that lens actually needs — broadcasting the full Step 0 context to every agent",
  "multiplies input cost by 5× without adding signal. Each lens's prompt below specifies",
  "which context elements to include.",
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
  "> You are a senior staff engineer performing calibration review. Your job",
  "> is to take findings from the parallel reviewers (Correctness & Quality, Security,",
  "> Idiom & Best Practices, Architecture and Solution-Fit, AI Slop & Curation Evidence)",
  "> and produce a unified, calibrated assessment.",
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
  "```bash",
  "gh pr view --json number,url,headRepository,baseRepository \\",
  "  --jq '{number, url, repo: (.headRepository.owner.login + \"/\" + .headRepository.name)}' \\",
  "  2>/dev/null",
  "```",
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
  "When the user selects \"Write DEEP_REVIEW.md\" (interactive) OR when running",
  "non-interactively with no PR detected (CI), write the full markdown report",
  "(per the **Output Format** section of SKILL.md) to `DEEP_REVIEW.md` at the",
  "repo root. Do not commit, do not push.",
  "",
  "- **Interactive:** tell the user the file was written and that it is",
  "  currently untracked.",
  "- **Non-interactive (CI):** also print a single-line summary to stdout —",
  "  `deep-review: <verdict> · grade <letter> · <final_score>/100 · wrote",
  "  DEEP_REVIEW.md` — so the workflow log captures the result. If the CI is",
  "  expected to upload `DEEP_REVIEW.md` as a workflow artifact, the path",
  "  should remain at the repo root unless the workflow specifies otherwise.",
  "",
  "If `DEEP_REVIEW.md` already exists:",
  "",
  "- **Interactive:** ask whether to overwrite, append, or write to a",
  "  date-stamped filename (e.g., `DEEP_REVIEW.<YYYY-MM-DD>.md`).",
  "- **Non-interactive:** overwrite without prompting. CI runs are expected",
  "  to be reproducible; appending across runs would corrupt artifacts.",
  "",
  "## 7. Other delivery shapes (when the user picks \"Other\")",
  "",
  "These are fallbacks — only use when the user explicitly asks via the",
  "\"Other\" free-form input.",
  "",
  "**Review branch with markdown report.** Best for full-codebase audits and",
  "archival. Create a new branch `<user>/deep-review`, write to",
  "`CLAUDE_DEEP_REVIEW.md` at the repo root, commit, and push. Tell the user",
  "the branch is ready and they can open a PR for team discussion.",
  "",
  "**GitHub issues.** Best for tech-debt tracking. For each confirmed finding",
  "(or group of related findings), create a GitHub issue with: descriptive",
  "title, SHA-pinned permalink(s) to the offending code, signal category and",
  "severity, suggested fix, and appropriate labels (`ai-slop`, severity",
  "labels). Group related findings into single issues where it makes sense",
  "(\"4 instances of bare except Exception: pass\" is one issue, not four).",
  "Ask whether to create a milestone (e.g., \"AI Slop Cleanup\") before opening",
  "issues.",
  "",
  "**Inline PR review comments.** Best when findings map to specific changed",
  "lines and the team prefers per-line review. For each confirmed finding,",
  "post an inline review comment at the exact file and line using",
  "`gh api repos/{owner}/{repo}/pulls/{pr}/reviews`:",
  "",
  "```bash",
  "gh api repos/{owner}/{repo}/pulls/{pr}/reviews -f event=COMMENT \\",
  "  -f body=\"Deep Review: found N issues\" \\",
  "  -f 'comments[][path]=...' -f 'comments[][line]=...' \\",
  "  -f 'comments[][body]=...'",
  "```",
  "",
  "Group related findings into a single review submission.",
  "",
  "**Combined.** The user may want both an archival markdown AND actionable",
  "items. If so, do the markdown delivery first, then the actionable",
  "delivery. Update issue/comment bodies to reference the markdown only if",
  "that file has been committed and pushed (otherwise the link 404s).",
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
  "## Output Format",
  "",
  "For PRs over threshold:",
  "",
  "```markdown",
  "## Size Review: <PR#X — title> or <branch-name>",
  "",
  "### Stack Plan",
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
  "```",
  "",
  "For PRs under threshold:",
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

const pluginMetadata = (overrides = {}) => ({
  name: "code-quality",
  version: "0.11.0",
  description: "fixture code-quality plugin",
  author: { name: "SentioLabs", url: "https://example.test" },
  homepage: "https://example.test",
  repository: "https://example.test/repository",
  license: "MIT",
  keywords: ["code-quality", "code-review"],
  ...overrides,
});

// Focused overlay-contract fixture; the maintainer real-source smoke/determinism check remains authoritative.
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
    ".claude-plugin/plugin.json": `${JSON.stringify(overrides.pluginMetadata ?? pluginMetadata())}\n`,
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
    assert.match(result.stderr, /Expected (?:source text not found|section markers not found|exactly one source text occurrence)/);
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

test("staged installation restores both live roots when the second swap fails", () => {
  const packageCopy = createTemporaryPackage();
  const generated = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-generated-"));
  const promptBefore = Buffer.from("live prompts\n", "utf8");
  const skillBefore = Buffer.from("live skills\n", "utf8");
  writeFixtureFile(packageCopy.root, "prompts/sentinel.txt", promptBefore);
  writeFixtureFile(packageCopy.root, "skills/sentinel.txt", skillBefore);
  writeFixtureFile(generated, "prompts/new.txt", "new prompts\n");
  writeFixtureFile(generated, "skills/new.txt", "new skills\n");
  const probe = [
    "import importlib.util, sys",
    "from pathlib import Path",
    "script, package_root, generated = map(Path, sys.argv[1:])",
    "spec = importlib.util.spec_from_file_location('migration', script)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "def move_with_second_swap_failure(source, target):",
    "    source = Path(source)",
    "    target = Path(target)",
    "    if source.name.startswith('.skills.staging-') and target == package_root / 'skills':",
    "        raise OSError('simulated skills swap failure')",
    "    source.rename(target)",
    "module.install_generated_tree(generated, package_root, move=move_with_second_swap_failure)",
  ].join("\n");

  try {
    const result = spawnSync("python3", ["-c", probe, packageCopy.script, packageCopy.root, generated], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /simulated skills swap failure/);
    assert.deepEqual(readFileSync(path.join(packageCopy.root, "prompts/sentinel.txt")), promptBefore);
    assert.deepEqual(readFileSync(path.join(packageCopy.root, "skills/sentinel.txt")), skillBefore);
    assert.equal(existsSync(path.join(packageCopy.root, "prompts/new.txt")), false);
    assert.equal(existsSync(path.join(packageCopy.root, "skills/new.txt")), false);
    assert.deepEqual(
      readdirSync(packageCopy.root).filter((entry) => entry.includes(".staging-") || entry.includes(".backup-")),
      [],
    );
  } finally {
    rmSync(generated, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("interruption during the second staged swap restores originals and propagates", () => {
  const packageCopy = createTemporaryPackage();
  const generated = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-generated-"));
  const promptBefore = Buffer.from("original prompts\n", "utf8");
  const skillBefore = Buffer.from("original skills\n", "utf8");
  writeFixtureFile(packageCopy.root, "prompts/sentinel.txt", promptBefore);
  writeFixtureFile(packageCopy.root, "skills/sentinel.txt", skillBefore);
  writeFixtureFile(generated, "prompts/new.txt", "new prompts\n");
  writeFixtureFile(generated, "skills/new.txt", "new skills\n");
  const probe = [
    "import importlib.util, sys",
    "from pathlib import Path",
    "script, package_root, generated = map(Path, sys.argv[1:])",
    "spec = importlib.util.spec_from_file_location('migration', script)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "def move_with_second_swap_interrupt(source, target):",
    "    source, target = Path(source), Path(target)",
    "    if source.name.startswith('.skills.staging-') and target == package_root / 'skills':",
    "        raise KeyboardInterrupt('simulated skills swap interruption')",
    "    source.rename(target)",
    "module.install_generated_tree(generated, package_root, move=move_with_second_swap_interrupt)",
  ].join("\n");

  try {
    const result = spawnSync("python3", ["-c", probe, packageCopy.script, packageCopy.root, generated], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KeyboardInterrupt: simulated skills swap interruption/);
    assert.deepEqual(readFileSync(path.join(packageCopy.root, "prompts/sentinel.txt")), promptBefore);
    assert.deepEqual(readFileSync(path.join(packageCopy.root, "skills/sentinel.txt")), skillBefore);
    assert.equal(existsSync(path.join(packageCopy.root, "prompts/new.txt")), false);
    assert.equal(existsSync(path.join(packageCopy.root, "skills/new.txt")), false);
    assert.deepEqual(
      readdirSync(packageCopy.root).filter((entry) => entry.includes(".staging-") || entry.includes(".backup-")),
      [],
    );
  } finally {
    rmSync(generated, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("generated deep- and size-review delivery requires gh availability and auth before PR posting", () => {
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
    const sizeReview = readFileSync(path.join(packageCopy.root, "skills/size-review/SKILL.md"), "utf8");

    for (const content of [skill, outputActions]) {
      assert.match(content, /command -v gh/);
      assert.match(content, /gh auth status/);
      assert.match(content, /unavailable or unauthenticated/);
      assert.match(content, /DEEP_REVIEW\.md/);
    }
    assert.match(sizeReview, /command -v gh/);
    assert.match(sizeReview, /gh auth status/);
    assert.match(sizeReview, /unavailable or unauthenticated/);
    assert.match(sizeReview, /SIZE_REVIEW\.md/);
    assert.match(outputActions, /Do not offer the PR-post option/);
    assert.match(outputActions, /write `DEEP_REVIEW\.md`, print the one-line summary/);
    assert.match(outputActions, /actual `gh pr comment` post fails/);
    assert.match(outputActions, /exit non-zero/);
    assert.match(outputActions, /tool subprocess stdin may be non-TTY during an interactive session/i);
    assert.match(sizeReview, /tool subprocess stdin may be non-TTY during an interactive session/i);
    assert.match(outputActions, /\.baseRepository\.owner\.login \+ "\/" \+ \.baseRepository\.name/);
    assert.doesNotMatch(outputActions, /\.headRepository\.owner\.login \+ "\/" \+ \.headRepository\.name/);

    const noPrDirectWriteParagraph = [
      "**No PR detected — skip the question.** Write `DEEP_REVIEW.md` directly and",
      "tell the user: \"No open PR found for this branch — wrote findings to",
      "`DEEP_REVIEW.md` (untracked).\" If the user wants something else they can",
      "ask in their next turn. Do not present a 1-option menu. Direct-write does not",
      "depend on question-tool availability. Use plain chat only for the PR path, where",
      "an actual interactive delivery choice is needed.",
    ].join("\n");
    assert.ok(outputActions.includes(noPrDirectWriteParagraph));
    assert.match(
      outputActions,
      /When a PR was detected and an interactive\s+delivery choice is needed, if it is\s+unavailable, use a plain-chat conversational\s+fallback to ask how to deliver the report\./,
    );

    assert.match(sizeReview, /With a PR but `gh` unavailable or\s+unauthenticated/);
    assert.match(sizeReview, /do not\s+offer the PR-post option/);
    assert.match(sizeReview, /write `SIZE_REVIEW\.md`,\s+print the full report to stdout, then print/);
    assert.match(sizeReview, /do not invoke `gh`/);
    assert.match(sizeReview, /PR\s+delivery is unavailable/);
    assert.match(sizeReview, /preflight passes\s+but the actual `gh pr comment` post fails/);
    assert.doesNotMatch(sizeReview, /PR in scope →\s*post the report as a PR comment automatically/);
    assert.match(sizeReview, /use `ask_user_question` with the `questions\[\]` JSON shape only when that tool is available/i);

    const interactiveChoices = sizeReview.match(/### Interactive delivery choice sets\n([\s\S]*?)\nOnly after the user explicitly selects/)?.[1];
    assert.ok(interactiveChoices, "interactive delivery choices should be grouped before archival execution");
    for (const [deliveryPath, expectedChoices] of [
      ["ask_user_question: PR + successful gh", ["Post comment to PR #<N> (Recommended)", "Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
      ["ask_user_question: PR + unavailable gh", ["Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
      ["ask_user_question: no PR", ["Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
      ["plain chat: PR + successful gh", ["Post comment to PR #<N> (Recommended)", "Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
      ["plain chat: PR + unavailable gh", ["Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
      ["plain chat: no PR", ["Write SIZE_REVIEW.md", "Return inline", "Branch + markdown"]],
    ]) {
      const choices = interactiveChoices.match(
        new RegExp(`- \\*\\*${deliveryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\* — ([\\s\\S]*?)(?=\\n- \\*\\*|$)`),
      )?.[1];
      assert.ok(choices, `${deliveryPath} choices should be explicit`);
      assert.deepEqual(
        [...choices.matchAll(/`([^`]+)`/g)].map(([, choice]) => choice),
        expectedChoices,
        `${deliveryPath} should offer exactly its permitted choices`,
      );
    }

    const sizeReviewTemplate = sizeReview.match(
      /```markdown\n([\s\S]*?)\n```\n\nFor PRs under threshold:/,
    )?.[1];
    assert.ok(sizeReviewTemplate, "the over-threshold output template should remain fenced as markdown");
    const optionalGitSpiceFlow = sizeReviewTemplate.match(
      /### Optional git-spice-style flow when available[\s\S]*?Do not require git-spice or any optional Pi package; use available tools\./,
    )?.[0];
    assert.ok(optionalGitSpiceFlow, "the optional git-spice flow should remain in the output template");
    assert.match(optionalGitSpiceFlow, /\\`\\`\\`bash/);
    assert.match(optionalGitSpiceFlow, /gs stack submit\n\\`\\`\\`/);
    assert.doesNotMatch(optionalGitSpiceFlow, /\n```(?:bash)?\n/);

    const alternateDelivery = outputActions.match(/## 7\. Free-form escape-hatch delivery shapes[\s\S]*/)?.[0];
    assert.ok(alternateDelivery, "alternate delivery instructions should be generated");
    assert.match(alternateDelivery, /Before every GitHub-backed alternate delivery/);
    assert.match(alternateDelivery, /GitHub issues/);
    assert.match(alternateDelivery, /inline review comments/);
    assert.match(alternateDelivery, /combined action/i);
    assert.match(alternateDelivery, /command -v gh/);
    assert.match(alternateDelivery, /gh auth status/);
    assert.match(alternateDelivery, /do not invoke `gh`/i);
    assert.match(alternateDelivery, /DEEP_REVIEW\.md`?\s+or inline output/);
    assert.match(alternateDelivery, /GitHub delivery is unavailable/);
    assert.match(alternateDelivery, /preflight passed[\s\S]*remain loud and non-zero/i);
    assert.match(alternateDelivery, /do not silently fall back/i);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("migration preserves source prompt descriptions and rejects unsupported prompt frontmatter", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  try {
    const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(packageCopy.root, "prompts/code-quality-review.md"), "utf8"), /description: source prompt/);

    const reviewPrompt = path.join(source, "commands/review.md");
    writeFileSync(reviewPrompt, readFileSync(reviewPrompt, "utf8").replace("description: source prompt", "description: source prompt\nfuture-key: future value"));
    const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-review.md");
    const before = readFileSync(protectedPrompt, "utf8");
    const invalid = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Unsupported source prompt frontmatter key/);
    assert.equal(readFileSync(protectedPrompt, "utf8"), before);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("migration fails closed for unknown source files and invalid plugin metadata", () => {
  for (const [relativePath, content, expected] of [
    ["skills/deep-review/references/new.md", "# new\n", /Unclassified source file/],
    [".claude-plugin/plugin.json", `${JSON.stringify(pluginMetadata({ name: "not-code-quality" }))}\n`, /plugin\.json name must be/],
    [".claude-plugin/plugin.json", `${JSON.stringify(pluginMetadata({ license: "Apache-2.0" }))}\n`, /plugin\.json license must be/],
  ]) {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-review.md");
    writeFixtureFile(packageCopy.root, "prompts/code-quality-review.md", "unchanged\n");
    try {
      writeFixtureFile(source, relativePath, content);
      const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(protectedPrompt, "utf8"), "unchanged\n");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(packageCopy.root, { recursive: true, force: true });
    }
  }
});

test("fork PR repository derivation is guarded and generated from baseRepository", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-review.md");
  writeFixtureFile(packageCopy.root, "prompts/code-quality-review.md", "unchanged\n");
  try {
    const outputActions = path.join(source, "skills/deep-review/references/output-actions.md");
    writeFileSync(
      outputActions,
      readFileSync(outputActions, "utf8").replace(
        ".headRepository.owner.login + \"/\" + .headRepository.name",
        ".forkRepository.owner.login + \"/\" + .forkRepository.name",
      ),
    );
    const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected exactly one source text occurrence while patching deep-review output actions/);
    assert.equal(readFileSync(protectedPrompt, "utf8"), "unchanged\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("duplicate or drifted wholesale source sections abort before installation", () => {
  for (const [file, needle, injection, expected] of [
    ["skills/deep-review/SKILL.md", "| Step 0 | Scope | Sonnet |", "\nnew source model assignment line", /Unexpected source body drift/],
    ["skills/deep-review/references/output-actions.md", "Legacy interactive delivery instructions.", "\nnew source delivery line", /Unexpected source body drift/],
    ["skills/deep-review/references/output-actions.md", "Legacy PR posting instructions.", "\nnew source posting line", /Unexpected source body drift/],
    ["commands/review.md", "Run the `deep-review` skill against the specified target.", "\nRun the `deep-review` skill against the specified target.", /Expected exactly one source text occurrence/],
    ["skills/deep-review/SKILL.md", "## Workflow", "\n## Model Assignment\n\nduplicate", /Expected exactly one section start marker/],
  ]) {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const protectedSkill = path.join(packageCopy.root, "skills/deep-review/SKILL.md");
    writeFixtureFile(packageCopy.root, "skills/deep-review/SKILL.md", "unchanged\n");
    try {
      const sourcePath = path.join(source, file);
      writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace(needle, `${needle}${injection}`));
      const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(protectedSkill, "utf8"), "unchanged\n");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(packageCopy.root, { recursive: true, force: true });
    }
  }
});

test("generated delivery contracts use a guarded question schema and neutral execution wording", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  try {
    const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const skill = readFileSync(path.join(packageCopy.root, "skills/deep-review/SKILL.md"), "utf8");
    const actions = readFileSync(path.join(packageCopy.root, "skills/deep-review/references/output-actions.md"), "utf8");
    const size = readFileSync(path.join(packageCopy.root, "skills/size-review/SKILL.md"), "utf8");

    const questionExample = actions.match(/```json\n([\s\S]*?)\n```/)?.[1];
    assert.ok(questionExample);
    assert.doesNotMatch(questionExample, /"id"\s*:/);
    assert.match(actions, /only when that tool is available/i);
    assert.match(actions, /plain chat|conversational fallback/i);
    assert.match(actions, /tool supplies `Type something\.`\s*\/\s*`Chat about this`/i);
    assert.doesNotMatch(actions, /picks "Other"|"Other" free-form input|automatically appends an \*\*"Other"\*\*/i);
    assert.match(actions, /## 7\. Free-form escape-hatch delivery shapes/);
    assert.match(actions, /5-lens scan \+ calibration/);
    assert.match(actions, /PR was detected but `gh` is unavailable or unauthenticated/i);
    assert.match(actions, /Do not commit, do not push/);
    assert.match(actions, /overwrite without prompting/i);
    assert.match(size, /only when that tool is available/i);
    assert.match(size, /plain chat|conversational fallback/i);
    assert.match(size, /write `SIZE_REVIEW\.md`, print the full report to stdout, then print/i);
    assert.match(size, /`<user>\/size-review` branch/i);
    assert.doesNotMatch(skill, /5-lens parallel architecture|After the parallel scan|Launch the applicable subagents in parallel|parallel reviewers/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("fixture regeneration is byte-for-byte deterministic across two runs", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const runtimeFiles = runtimeManifest;
  try {
    const first = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = new Map(runtimeFiles.map((relative) => [relative, readFileSync(path.join(packageCopy.root, relative))]));
    const second = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    for (const [relative, bytes] of firstBytes) {
      assert.deepEqual(readFileSync(path.join(packageCopy.root, relative)), bytes, relative);
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("rollback reports a deletion failure after restoring original resource roots", () => {
  const packageCopy = createTemporaryPackage();
  const generated = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-generated-"));
  writeFixtureFile(packageCopy.root, "prompts/sentinel.txt", "original prompts\n");
  writeFixtureFile(packageCopy.root, "skills/sentinel.txt", "original skills\n");
  writeFixtureFile(generated, "prompts/new.txt", "new prompts\n");
  writeFixtureFile(generated, "skills/new.txt", "new skills\n");
  const probe = [
    "import importlib.util, shutil, sys",
    "from pathlib import Path",
    "script, package_root, generated = map(Path, sys.argv[1:])",
    "spec = importlib.util.spec_from_file_location('migration', script)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "failed = False",
    "def move_with_second_swap_failure(source, target):",
    "    source, target = Path(source), Path(target)",
    "    if source.name.startswith('.skills.staging-') and target == package_root / 'skills':",
    "        raise OSError('simulated skills swap failure')",
    "    source.rename(target)",
    "def remove_with_one_failure(target):",
    "    global failed",
    "    if target == package_root / 'prompts' and not failed:",
    "        failed = True",
    "        raise OSError('simulated prompt removal failure')",
    "    shutil.rmtree(target)",
    "module.install_generated_tree(generated, package_root, move=move_with_second_swap_failure, remove=remove_with_one_failure)",
  ].join("\n");
  try {
    const result = spawnSync("python3", ["-c", probe, packageCopy.script, packageCopy.root, generated], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to roll back generated resource installation: simulated prompt removal failure/);
    assert.equal(readFileSync(path.join(packageCopy.root, "prompts/sentinel.txt"), "utf8"), "original prompts\n");
    assert.equal(readFileSync(path.join(packageCopy.root, "skills/sentinel.txt"), "utf8"), "original skills\n");
  } finally {
    rmSync(generated, { recursive: true, force: true });
    rmSync(packageCopy.root, { recursive: true, force: true });
  }
});

test("skill frontmatter requires meaningful block descriptions and rejects tab indentation", () => {
  const validSource = createSourceFixture({
    deepReviewSkill: deepReviewSkillSource().replace(
      "description: fixture deep review skill",
      "description: >\n  fixture deep review skill\n  across two lines",
    ),
  });
  const validPackage = createTemporaryPackage();
  try {
    const result = spawnSync("python3", [validPackage.script, validSource], { cwd: validPackage.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(path.join(validPackage.root, "skills/deep-review/SKILL.md"), "utf8"),
      /description: >\n  fixture deep review skill\n  across two lines\nlicense: MIT/,
    );
  } finally {
    rmSync(validSource, { recursive: true, force: true });
    rmSync(validPackage.root, { recursive: true, force: true });
  }

  for (const [replacement, expected] of [
    ["description: >", /Source skill description is required/],
    ["description: |\n  \n    ", /Source skill description is required/],
    ["description: >\n\tfixture deep review skill", /Tab-indented source skill frontmatter line/],
  ]) {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const protectedPrompt = path.join(packageCopy.root, "prompts/code-quality-review.md");
    writeFixtureFile(packageCopy.root, "prompts/code-quality-review.md", "unchanged\n");
    try {
      const skill = path.join(source, "skills/deep-review/SKILL.md");
      writeFileSync(skill, readFileSync(skill, "utf8").replace("description: fixture deep review skill", replacement));
      const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(protectedPrompt, "utf8"), "unchanged\n");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(packageCopy.root, { recursive: true, force: true });
    }
  }
});

test("source skill frontmatter and plugin metadata schema fail closed before installation", () => {
  const cases = [
    ["skills/deep-review/SKILL.md", (text) => text.replace("name: deep-review", "name: renamed-review"), /skill name must be/],
    ["skills/size-review/SKILL.md", (text) => text.replace("name: size-review", "name: renamed-size"), /skill name must be/],
    ["skills/deep-review/SKILL.md", (text) => text.replace("description: fixture deep review skill", "unknown: value\ndescription: fixture deep review skill"), /Unsupported source skill frontmatter key/],
    ["skills/deep-review/SKILL.md", (text) => text.replace("name: deep-review", "name: deep-review\nname: duplicate"), /Duplicate source skill frontmatter key/],
    ["skills/size-review/SKILL.md", (text) => text.replace("description: fixture size review skill", "license: Apache-2.0\ndescription: fixture size review skill"), /skill license must be/],
  ];
  for (const [relative, mutate, expected] of cases) {
    const source = createSourceFixture(); const packageCopy = createTemporaryPackage();
    writeFixtureFile(packageCopy.root, "prompts/code-quality-review.md", "unchanged\n");
    try {
      const target = path.join(source, relative); writeFileSync(target, mutate(readFileSync(target, "utf8")));
      const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" });
      assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
      assert.equal(readFileSync(path.join(packageCopy.root, "prompts/code-quality-review.md"), "utf8"), "unchanged\n");
    } finally { rmSync(source, { recursive: true, force: true }); rmSync(packageCopy.root, { recursive: true, force: true }); }
  }
  for (const [metadata, expected] of [
    [((value) => { delete value.version; return value; })(pluginMetadata()), /missing required fields/],
    [{ ...pluginMetadata(), extra: true }, /unknown fields/],
    [{ ...pluginMetadata(), keywords: "code-quality" }, /keywords must be a list of strings/],
    [{ ...pluginMetadata(), author: "SentioLabs" }, /author must be an object/],
  ]) {
    const source = createSourceFixture({ pluginMetadata: metadata }); const packageCopy = createTemporaryPackage();
    try { const result = spawnSync("python3", [packageCopy.script, source], { cwd: packageCopy.root, encoding: "utf8" }); assert.notEqual(result.status, 0); assert.match(result.stderr, expected); }
    finally { rmSync(source, { recursive: true, force: true }); rmSync(packageCopy.root, { recursive: true, force: true }); }
  }
});
