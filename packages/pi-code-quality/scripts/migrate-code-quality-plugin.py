#!/usr/bin/env python3
import argparse
import atexit
from pathlib import Path
import re
import shutil
import tempfile

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_CANDIDATES = (
    Path.home() / "devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/code-quality",
    Path.home() / "devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/code-quality",
)

REQUIRED_SOURCE_PATHS = (
    "commands/review.md",
    "commands/size.md",
    "skills/deep-review/SKILL.md",
    "skills/deep-review/references/go.md",
    "skills/deep-review/references/python.md",
    "skills/deep-review/references/rust.md",
    "skills/deep-review/references/svelte-ts.md",
    "skills/deep-review/references/output-actions.md",
    "skills/size-review/SKILL.md",
    "skills/size-review/references/default-exclusions.md",
    ".claude-plugin/plugin.json",
)

FORBIDDEN_GENERATED = (
    "${CLAUDE_PLUGIN_ROOT}",
    "AskUserQuestion",
    "/code-quality:",
    "[ ! -t 0 ]",
    'model: "fable"',
    'model: "opus"',
    'model: "sonnet"',
    "CLAUDE_DEEP_REVIEW.md",
    "CLAUDE_SIZE_REVIEW.md",
    ".code-quality/slop-acceptances.md",
)

PROMPT_CONFIG = {
    "review": {
        "description": "Run a deep multi-lens code review on files, directories, PRs, or all changes versus the base branch",
        "title": "# Deep Review",
        "skill": "deep-review",
        "source_command": "/code-quality:review",
        "target_command": "/code-quality-review",
    },
    "size": {
        "description": "Run a PR/branch size review to decide if the change should be split into multiple PRs",
        "title": "# Size Review",
        "skill": "size-review",
        "source_command": "/code-quality:size",
        "target_command": "/code-quality-size",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Regenerate pi-code-quality resources from the Claude code-quality plugin source.",
    )
    parser.add_argument("source", nargs="?", help="Path to the Claude code-quality plugin source.")
    parser.add_argument("--source", dest="source_option", metavar="SOURCE", help="Source path (option form).")
    return parser.parse_args()


def resolve_source_path(args: argparse.Namespace) -> Path:
    if args.source and args.source_option:
        raise SystemExit("Pass the source path either positionally or with --source, not both.")
    raw = args.source_option or args.source
    if raw:
        return Path(raw).expanduser().resolve()
    return next(
        (candidate.expanduser().resolve() for candidate in DEFAULT_SOURCE_CANDIDATES if candidate.exists()),
        DEFAULT_SOURCE_CANDIDATES[0].expanduser().resolve(),
    )


def validate_source(source: Path) -> None:
    missing = [relative for relative in REQUIRED_SOURCE_PATHS if not (source / relative).is_file()]
    if missing:
        details = "\n".join(f"- {relative}" for relative in missing)
        raise SystemExit(
            f"Source plugin does not look like the Claude code-quality plugin: {source}\n"
            f"Missing expected paths:\n{details}"
        )


def require_replace(text: str, old: str, new: str, context: str) -> str:
    if old not in text:
        raise RuntimeError(f"Expected source text not found while patching {context}: {old[:120]!r}")
    return text.replace(old, new)


def replace_section(text: str, start_marker: str, end_marker: str, replacement: str, context: str) -> str:
    try:
        start = text.index(start_marker)
        end = text.index(end_marker, start)
    except ValueError as error:
        raise RuntimeError(
            f"Expected section markers not found while patching {context}: "
            f"{start_marker!r} -> {end_marker!r}"
        ) from error
    return text[:start] + replacement + text[end:]


def strip_frontmatter(text: str, context: str) -> str:
    if not text.startswith("---\n"):
        raise RuntimeError(f"Expected frontmatter while patching {context}")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise RuntimeError(f"Expected closing frontmatter delimiter while patching {context}")
    return text[end + len("\n---\n") :].lstrip("\n")


def add_license_frontmatter(text: str, context: str) -> str:
    if not text.startswith("---\n"):
        raise RuntimeError(f"Expected frontmatter while patching {context}")
    end_match = re.search(r"^---$", text, flags=re.MULTILINE)
    if not end_match or end_match.start() != 0:
        raise RuntimeError(f"Expected opening frontmatter delimiter while patching {context}")
    closing = re.search(r"^---$", text[4:], flags=re.MULTILINE)
    if not closing:
        raise RuntimeError(f"Expected closing frontmatter delimiter while patching {context}")
    closing_start = 4 + closing.start()
    frontmatter = text[:closing_start]
    if re.search(r"^license:\s*MIT$", frontmatter, flags=re.MULTILINE):
        return text
    return text[:closing_start] + "license: MIT\n" + text[closing_start:]


def transform_prompt(source_name: str, text: str) -> str:
    if source_name not in PROMPT_CONFIG:
        raise RuntimeError(f"Unknown prompt source: {source_name}")
    config = PROMPT_CONFIG[source_name]
    body = strip_frontmatter(text, f"{source_name} prompt")
    title = config["title"]
    first_line, separator, remainder = body.partition("\n")
    if first_line != title:
        raise RuntimeError(f"Expected prompt heading {title} while patching {source_name} prompt")
    body = title + (separator + remainder if separator else "\n")
    old_invocation = f"Run the `{config['skill']}` skill against the specified target."
    body = require_replace(
        body,
        old_invocation,
        f"Use the `{config['skill']}` skill against the specified target.",
        f"{source_name} prompt invocation",
    )
    body = require_replace(
        body,
        config["source_command"],
        config["target_command"],
        f"{source_name} prompt command",
    )
    if "$ARGUMENTS" in body:
        raise RuntimeError(f"Unexpected pre-existing $ARGUMENTS marker while patching {source_name} prompt")
    return (
        "---\n"
        f"description: {config['description']}\n"
        "argument-hint: \"[scope]\"\n"
        "---\n\n"
        f"{body.rstrip()}\n\n"
        "Use `$ARGUMENTS` as the requested scope when present.\n"
    )


def replace_reference_roots(text: str, context: str) -> str:
    replacements = (
        ("${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/", "references/"),
        ("${CLAUDE_PLUGIN_ROOT}/skills/size-review/references/", "references/"),
    )
    for old, new in replacements:
        if old in text:
            text = text.replace(old, new)
    return text


def transform_deep_review(text: str) -> str:
    context = "deep-review skill"
    text = add_license_frontmatter(text, context)
    text = require_replace(
        text,
        "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/",
        "references/",
        context,
    )
    text = require_replace(
        text,
        "Specialized agents scan in parallel for correctness and quality defects, security\n"
        "vulnerabilities, idiom violations, and solution-fit problems, while a calibration\n"
        "agent scores every finding, filters false positives, and catches what the scanners\n"
        "missed.",
        "Generic workers can scan in parallel for correctness and quality defects, security\n"
        "vulnerabilities, idiom violations, and solution-fit problems when a parallel\n"
        "task/subagent tool is available. Otherwise, run the same lenses sequentially with\n"
        "separated outputs. A calibration pass scores every finding, filters false positives,\n"
        "and catches what the scanners missed.",
        context,
    )
    text = replace_section(
        text,
        "## Model Assignment\n",
        "\n---\n\n## Workflow",
        "## Execution Model and Model Tier Intent\n\n"
        "| Step | Review role | Model-tier intent |\n"
        "|---|---|---|\n"
        "| Step 0 | Scope, reconstruction, context, idiom baseline | standard tier |\n"
        "| Phase 1a | Correctness and Quality | large tier |\n"
        "| Phase 1b | Security | large tier |\n"
        "| Phase 1c | Idiom and Best Practices | large tier |\n"
        "| Phase 1d | Architecture and Solution-Fit | strongest available reasoning tier, falling back to large |\n"
        "| Phase 1e | AI Slop and Curation Evidence | standard tier |\n"
        "| Phase 2 | Calibration | strongest available reasoning tier, falling back to large |\n"
        "| Phase 3-4 | Synthesis and output | inline in the current agent |\n\n"
        "Use a generic parallel task/subagent tool when one is available. Keep workers\n"
        "generic: this skill supplies the complete review methodology, so do not require\n"
        "Arc specialists, pi-subagents, or any other optional Pi package. If no delegation\n"
        "tool is available, run the same five lens prompts sequentially and keep each lens's\n"
        "output separated for calibration. Request model tiers only when the available tool\n"
        "supports tier selection; otherwise run with the current agent's configured model.\n\n"
        "### Context window\n\n"
        "Default to **base 200k context** for every step. Only escalate to a larger\n"
        "context window when Step 0's gathered context bundle (files under review +\n"
        "base branch files + project guidance + idiom baseline + reviewer comments)\n"
        "exceeds ~150k tokens. Most reviews fit comfortably in 200k. Larger context\n"
        "windows carry a real per-token premium and are wasted capacity for typical PRs.\n\n"
        "If a larger context window is needed, only escalate the *specific* steps that\n"
        "need it (usually Phase 2 calibration, which sees the union of all Phase 1\n"
        "findings) — not every worker. Use the runtime's portable context-window option\n"
        "when it provides one; otherwise reduce the bundle to the review-critical files\n"
        "and evidence.\n\n"
        "### Output budget per lens\n\n"
        "Cap each Phase 1 lens at roughly **5,000 output tokens**. Findings should be\n"
        "terse: 2-4 sentences per finding plus the structured fields. Phase 2 calibration\n"
        "consumes structured findings, not essays — verbose lens output inflates Phase 2\n"
        "input cost without adding signal.\n\n"
        "Phase 1d may run slightly longer (~7,000 tokens) because solution-fit analysis\n"
        "often needs to explain architectural reasoning. Phase 2 calibration may run up\n"
        "to 10,000 tokens because it covers all lenses plus cross-lens analysis.\n",
        context,
    )
    text = require_replace(
        text,
        "### Step 0: Determine scope, reconstruct the problem, gather context, and build idiom baseline\n\n"
        "Launch a subagent with `model: \"sonnet\"` for this step.",
        "### Step 0: Determine scope, reconstruct the problem, gather context, and build idiom baseline\n\n"
        "Run this step with standard-tier intent. Use a generic worker if delegation is\n"
        "available; otherwise perform the step inline before the lens reviews.",
        context,
    )
    text = require_replace(
        text,
        "If `.code-quality/review-acceptances.md` exists at the repo root, read it and store the\n"
        "verbatim contents alongside the rest of Step 0 output. If it is absent, fall back to the\n"
        "legacy `.code-quality/slop-acceptances.md` (still honored so existing repos don't break).\n"
        "If neither exists, Phase 2 grades normally with no acceptances applied.",
        "If `.code-quality/review-acceptances.md` exists at the repo root, read it and store the\n"
        "verbatim contents alongside the rest of Step 0 output. If it is absent, Phase 2 grades\n"
        "normally with no acceptances applied.",
        context,
    )
    text = require_replace(
        text,
        "**Important:** Always use `general-purpose` subagents (or omit the `subagent_type` parameter).\n"
        "Do NOT use specialized review agents (coderabbit, feature-dev, pr-review-toolkit, etc.) --\n"
        "this skill provides its own complete review methodology, and specialized agents will blend\n"
        "their own prompts with these instructions, producing inconsistent results.\n\n"
        "For large reviews (>10 files), split each lens across multiple parallel subagents by\n"
        "directory or module. Phase 1d should stay cross-cutting unless the PR spans genuinely\n"
        "independent systems.",
        "**Important:** Use generic workers when delegation exists, or omit any worker-type\n"
        "selection parameter. This skill provides its own complete review methodology, so do\n"
        "not require Arc specialists, optional Pi packages, or package-specific review agents.\n"
        "If no generic parallel task/subagent tool exists, run the same five lenses sequentially\n"
        "and keep each lens's output separated for Phase 2 calibration.\n\n"
        "For large reviews (>10 files), split each lens across multiple parallel generic workers\n"
        "by directory or module when the runtime supports it. In the sequential fallback, process\n"
        "the same directory/module batches one lens at a time. Phase 1d should stay cross-cutting\n"
        "unless the PR spans genuinely independent systems.",
        context,
    )
    text = require_replace(
        text,
        "overestimating only adds one Opus pass.",
        "overestimating only adds one large-tier pass.",
        context,
    )
    text = require_replace(
        text,
        "#### Phase 1a: Correctness & Quality (model: \"opus\")",
        "#### Phase 1a: Correctness & Quality (large-tier intent)",
        context,
    )
    text = require_replace(
        text,
        "#### Phase 1b: Security (model: \"opus\")",
        "#### Phase 1b: Security (large-tier intent)",
        context,
    )
    text = require_replace(
        text,
        "#### Phase 1c: Idiom & Best Practices (model: \"opus\")",
        "#### Phase 1c: Idiom & Best Practices (large-tier intent)",
        context,
    )
    text = require_replace(
        text,
        "#### Phase 1d: Architecture and Solution-Fit Review (model: \"fable\" if available, else \"opus\")",
        "#### Phase 1d: Architecture and Solution-Fit Review (strongest available reasoning tier, falling back to large)",
        context,
    )
    text = require_replace(
        text,
        "#### Phase 1e: AI Slop & Curation Evidence (model: \"sonnet\")",
        "#### Phase 1e: AI Slop & Curation Evidence (standard-tier intent)",
        context,
    )
    text = require_replace(
        text,
        "### Phase 2: Calibration review (model: \"fable\" if available, else \"opus\")\n\n"
        "Launch a **separate, independent** subagent with `model: \"fable\"` when a\n"
        "Fable/Mythos-class tier is available, otherwise `model: \"opus\"`. This agent receives\n"
        "ALL findings from all Phase 1 lenses, the original files, the problem reconstruction,\n"
        "reviewer comments, the codebase context, the idiom baseline, and the curation evidence\n"
        "bundle.",
        "### Phase 2: Calibration review (strongest available reasoning tier, falling back to large)\n\n"
        "Run a **separate, independent** calibration pass with the strongest available\n"
        "reasoning tier, falling back to large-tier intent when tier selection is unavailable.\n"
        "This pass receives ALL findings from all Phase 1 lenses, the original files, the\n"
        "problem reconstruction, reviewer comments, the codebase context, the idiom baseline,\n"
        "and the curation evidence bundle.",
        context,
    )
    text = require_replace(
        text,
        "> **Accepted deviations.** If Step 0 supplied a `.code-quality/review-acceptances.md`\n"
        "> file (or the legacy `.code-quality/slop-acceptances.md` fallback), you MUST apply it\n"
        "> before grading.",
        "> **Accepted deviations.** If Step 0 supplied a `.code-quality/review-acceptances.md`\n"
        "> file, you MUST apply it before grading.",
        context,
    )
    text = require_replace(
        text,
        "Provide the subagent with:\n"
        "- Findings from all five lenses (Phase 1a, 1b, 1c, 1d, and 1e)\n"
        "- The original files under review (so it can re-read them independently)\n"
        "- The base branch versions of changed files (PR scope)\n"
        "- The problem reconstruction, reviewer comments, codebase context, and idiom baseline from Step 0\n"
        "- The curation evidence bundle from Step 0\n"
        "- The verbatim `.code-quality/review-acceptances.md` contents (or the legacy\n"
        "  `.code-quality/slop-acceptances.md` fallback), if Step 0 found the file —\n"
        "  omitting this silently disables the entire acceptances feature\n"
        "- The language reference file(s) Step 0 loaded",
        "Provide the calibration pass with:\n"
        "- Findings from all five lenses (Phase 1a, 1b, 1c, 1d, and 1e)\n"
        "- The original files under review (so it can re-read them independently)\n"
        "- The base branch versions of changed files (PR scope)\n"
        "- The problem reconstruction, reviewer comments, codebase context, and idiom baseline from Step 0\n"
        "- The curation evidence bundle from Step 0\n"
        "- The verbatim `.code-quality/review-acceptances.md` contents, if Step 0 found the file —\n"
        "  omitting this silently disables the entire acceptances feature\n"
        "- The language reference file(s) Step 0 loaded",
        context,
    )
    text = require_replace(
        text,
        "**Cost optimization — reference file caching.** These reference files are static between\n"
        "runs against the same codebase. In runtimes that support prompt caching (Claude Code's\n"
        "session cache, Anthropic SDK `cache_control` markers, etc.), include the loaded language\n"
        "reference content in a cached prefix so repeat reviews against the same repo amortize\n"
        "the input cost. In Claude Code this is automatic for skill content. In headless / CI\n"
        "contexts (GitHub Actions via Claude Agent SDK), set `cache_control: {\"type\": \"ephemeral\"}`\n"
        "on the reference-file content blocks for the largest savings.",
        "**Cost optimization — reference file caching.** These reference files are static between\n"
        "runs against the same codebase. In runtimes that support prompt caching, include the\n"
        "loaded language reference content in a cached prefix so repeat reviews against the same\n"
        "repo amortize the input cost. In headless or CI contexts, use the runtime's portable\n"
        "cache-control mechanism when one is available.",
        context,
    )
    text = require_replace(
        text,
        "5. **Acceptances file** -- Has the project pre-registered the concern in\n"
        "   `.code-quality/review-acceptances.md` (legacy `.code-quality/slop-acceptances.md`\n"
        "   honored as fallback)? If yes, Phase 2 will dismiss the finding automatically; Phase 1\n"
        "   still scans blind so the evidence remains visible.",
        "5. **Acceptances file** -- Has the project pre-registered the concern in\n"
        "   `.code-quality/review-acceptances.md`? If yes, Phase 2 will dismiss the finding\n"
        "   automatically; Phase 1 still scans blind so the evidence remains visible.",
        context,
    )
    text = require_replace(
        text,
        "1. **Detect mode.** Non-interactive (CI) if `CI`/`GITHUB_ACTIONS`/`GITLAB_CI`/\n"
        "   `BUILDKITE` env vars are set or stdin is not a TTY. Never call `AskUserQuestion`\n"
        "   in non-interactive mode.",
        "1. **Detect mode.** Non-interactive (CI) only if `CI`/`GITHUB_ACTIONS`/\n"
        "   `GITLAB_CI`/`BUILDKITE` equals `true`, or if the user explicitly requested\n"
        "   headless/CI/auto-post mode. Never call `ask_user_question` in non-interactive mode.",
        context,
    )
    text = require_replace(
        text,
        "3. **Interactive + PR found:** `AskUserQuestion` — post PR comment (recommended)\n"
        "   or write `DEEP_REVIEW.md`. **Interactive + no PR:** write `DEEP_REVIEW.md`\n"
        "   directly, no menu.",
        "3. **Interactive + PR found + `gh` available/authenticated:** `ask_user_question`\n"
        "   may offer post PR comment (recommended) or write `DEEP_REVIEW.md`. Before\n"
        "   offering the PR-post option, require `command -v gh` and successful\n"
        "   `gh auth status` (or an equivalent explicit availability/auth check).\n"
        "   **Interactive + PR found but `gh` unavailable or unauthenticated:** do not\n"
        "   offer the PR-post option; write `DEEP_REVIEW.md` or allow inline/free-form\n"
        "   output. **Interactive + no PR:** write `DEEP_REVIEW.md` directly, no menu.",
        context,
    )
    text = require_replace(
        text,
        "4. **Non-interactive:** PR found → auto-post the PR comment, no confirmation;\n"
        "   no PR → write `DEEP_REVIEW.md` and print a one-line verdict summary to stdout.\n"
        "   If posting fails, exit non-zero — never silently fall back.",
        "4. **Non-interactive:** PR found + `gh` available/authenticated → auto-post\n"
        "   the PR comment, no confirmation, after the same `command -v gh` /\n"
        "   `gh auth status` preflight; PR found but `gh` unavailable or\n"
        "   unauthenticated → write `DEEP_REVIEW.md`, print the one-line verdict\n"
        "   summary to stdout, and surface that PR delivery was unavailable; no PR →\n"
        "   write `DEEP_REVIEW.md` and print the one-line verdict summary to stdout.\n"
        "   If preflight passed but the actual `gh pr comment` post fails, exit\n"
        "   non-zero — never silently fall back.",
        context,
    )
    return text


def transform_output_actions(text: str) -> str:
    context = "deep-review output actions"
    text = require_replace(
        text,
        "## 1. Detect interactive vs. non-interactive (CI/CD) mode\n\n"
        "The skill runs in two contexts:\n\n"
        "- **Interactive** — a human is in the loop (Claude Code session, IDE\n"
        "  extension). `AskUserQuestion` works.\n"
        "- **Non-interactive** — running headless in CI/CD (GitHub Actions via the\n"
        "  Claude Agent SDK, scheduled cron job, automation). `AskUserQuestion`\n"
        "  has no human to answer it; either it errors or it stalls the job.\n\n"
        "Detect non-interactive mode if **any** of these is true:\n\n"
        "```bash\n"
        "[ \"${CI:-}\"             = \"true\" ] || \\\n"
        "[ \"${GITHUB_ACTIONS:-}\" = \"true\" ] || \\\n"
        "[ \"${GITLAB_CI:-}\"      = \"true\" ] || \\\n"
        "[ \"${BUILDKITE:-}\"      = \"true\" ] || \\\n"
        "[ ! -t 0 ]   # stdin is not a TTY\n"
        "```\n\n"
        "If the user passed an explicit non-interactive flag in their request\n"
        "(\"non-interactive mode\", \"headless\", \"CI mode\", \"auto-post\"), treat it as\n"
        "non-interactive regardless of env.\n\n"
        "In non-interactive mode:\n\n"
        "- **Skip `AskUserQuestion` entirely.** Never call it — it is interactive\n"
        "  by design.",
        "## 1. Detect interactive vs. non-interactive (CI/CD) mode\n\n"
        "The skill runs in two contexts:\n\n"
        "- **Interactive** — a human is in the loop in a Pi session or IDE extension.\n"
        "  `ask_user_question` works.\n"
        "- **Non-interactive** — running headless in CI/CD, a scheduled job, or automation.\n"
        "  `ask_user_question` has no human to answer it; either it errors or it stalls\n"
        "  the job.\n\n"
        "Detect non-interactive mode only if **any** of these is true:\n\n"
        "```bash\n"
        "[ \"${CI:-}\"             = \"true\" ] || \\\n"
        "[ \"${GITHUB_ACTIONS:-}\" = \"true\" ] || \\\n"
        "[ \"${GITLAB_CI:-}\"      = \"true\" ] || \\\n"
        "[ \"${BUILDKITE:-}\"      = \"true\" ]\n"
        "```\n\n"
        "If the user passed an explicit non-interactive flag in their request\n"
        "(\"non-interactive mode\", \"headless\", \"CI mode\", \"auto-post\"), treat it as\n"
        "non-interactive regardless of env. Do **not** infer CI from subprocess stdin\n"
        "being non-TTY; Pi tools may run with non-TTY stdin during interactive sessions.\n\n"
        "In non-interactive mode:\n\n"
        "- **Skip `ask_user_question` entirely.** Never call it — it is interactive\n"
        "  by design.",
        context,
    )
    text = require_replace(
        text,
        "- **Default behavior depends on PR detection** (next section):\n"
        "  - PR detected → post the rendered PR comment automatically.\n"
        "  - No PR detected → write `DEEP_REVIEW.md` to the working directory and\n"
        "    additionally print a one-line summary (verdict + grade + final score)\n"
        "    to stdout so the CI log captures it.\n"
        "- **Never prompt for confirmation before posting.** In CI the user has\n"
        "  already opted in to auto-posting by triggering the workflow; an\n"
        "  unanswered confirm would block the job.\n"
        "- **Surface failures visibly.** If `gh pr comment` fails (auth, rate\n"
        "  limit, repo permissions), exit non-zero with the error so the workflow\n"
        "  step fails loudly. Do not silently fall back.",
        "- **Default behavior depends on PR detection and GitHub delivery preflight**\n"
        "  (next sections):\n"
        "  - PR detected and `command -v gh` plus `gh auth status` succeed → post\n"
        "    the rendered PR comment automatically.\n"
        "  - PR detected but `gh` is unavailable or unauthenticated → write\n"
        "    `DEEP_REVIEW.md`, print the one-line summary, and surface that PR\n"
        "    delivery was unavailable.\n"
        "  - No PR detected → write `DEEP_REVIEW.md` to the working directory and\n"
        "    additionally print a one-line summary (verdict + grade + final score)\n"
        "    to stdout so the CI log captures it.\n"
        "- **Never prompt for confirmation before posting.** In CI the user has\n"
        "  already opted in to auto-posting by triggering the workflow; an\n"
        "  unanswered confirm would block the job.\n"
        "- **Surface failures visibly.** If the preflight passes but the actual\n"
        "  `gh pr comment` post fails (auth, rate limit, repo permissions), exit\n"
        "  non-zero with the error so the workflow step fails loudly. Do not\n"
        "  silently fall back.",
        context,
    )
    text = replace_section(
        text,
        "## 3. Ask the user (interactive mode only)\n",
        "\n## 4. Posting to a PR",
        "## 3. Ask the user (interactive mode only)\n\n"
        "**Skip this section entirely in non-interactive mode** (per §1). In CI,\n"
        "post the PR comment via §4 only when a PR was detected and GitHub delivery\n"
        "preflight passes. If a PR was detected but `gh` is unavailable or\n"
        "unauthenticated, write `DEEP_REVIEW.md`, print the one-line summary, and\n"
        "surface that PR delivery was unavailable.\n\n"
        "In interactive mode, use the `ask_user_question` tool. When a PR was\n"
        "detected, first verify GitHub delivery availability:\n\n"
        "```bash\n"
        "command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1\n"
        "```\n\n"
        "An equivalent explicit availability/auth check is acceptable. If this\n"
        "preflight fails, **Do not offer the PR-post option**. Offer\n"
        "`Write DEEP_REVIEW.md` and `Return inline` (or use the package free-form\n"
        "escape hatches), and tell the user GitHub PR delivery is unavailable or\n"
        "unauthenticated.\n\n"
        "**PR detected and GitHub delivery available — present two options using\n"
        "the package `questions[]` shape:**\n\n"
        "```json\n"
        "{\n"
        "  \"questions\": [\n"
        "    {\n"
        "      \"id\": \"delivery\",\n"
        "      \"question\": \"How would you like to surface these findings?\",\n"
        "      \"header\": \"Output\",\n"
        "      \"options\": [\n"
        "        {\n"
        "          \"label\": \"Post comment to PR #<N> (Recommended)\",\n"
        "          \"description\": \"Post the rendered review as a single PR comment via gh pr comment.\"\n"
        "        },\n"
        "        {\n"
        "          \"label\": \"Write DEEP_REVIEW.md\",\n"
        "          \"description\": \"Write the full markdown report to DEEP_REVIEW.md at the repo root without committing.\"\n"
        "        }\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "```\n\n"
        "Use 2-4 concise options. Mark the PR option as `(Recommended)` only when\n"
        "a PR is detected and GitHub delivery is available. The package provides the\n"
        "`Type something.` and `Chat about this` escape hatches; do not add manual\n"
        "pseudo-options for those choices.\n\n"
        "**No PR detected — skip the question.** Write `DEEP_REVIEW.md` directly and\n"
        "tell the user: \"No open PR found for this branch — wrote findings to\n"
        "`DEEP_REVIEW.md` (untracked).\" If the user wants something else they can\n"
        "ask in their next turn. Do not present a 1-option menu; the question tool\n"
        "requires at least 2 options and a single-choice ask is friction without\n"
        "information.\n\n"
        "If the user uses the free-form escape hatch, parse their request. Common\n"
        "requests to handle:\n\n"
        "- Review branch + markdown — see §7\n"
        "- GitHub issues for each confirmed finding — see §7\n"
        "- Inline review comments at specific lines — see §7\n"
        "- Print to terminal only — just emit the markdown report and exit\n",
        context,
    )
    text = replace_section(
        text,
        "## 4. Posting to a PR\n",
        "\n## 5. PR Comment Format",
        "## 4. Posting to a PR\n\n"
        "Only post when a PR was detected and GitHub delivery preflight succeeds.\n"
        "Run the preflight before offering a PR-post option and again immediately\n"
        "before posting in non-interactive mode:\n\n"
        "```bash\n"
        "command -v gh >/dev/null 2>&1\n"
        "gh auth status >/dev/null 2>&1\n"
        "```\n\n"
        "An equivalent explicit availability/auth check is acceptable. If preflight\n"
        "fails:\n\n"
        "- **Interactive:** Do not offer the PR-post option. Write `DEEP_REVIEW.md`,\n"
        "  return inline output, or honor a free-form delivery request; tell the user\n"
        "  GitHub PR delivery is unavailable or unauthenticated.\n"
        "- **Non-interactive:** write `DEEP_REVIEW.md`, print the one-line summary,\n"
        "  and surface that PR delivery was unavailable. Do not attempt\n"
        "  `gh pr comment`.\n\n"
        "When preflight passes and the user selects \"Post comment to PR\"\n"
        "(interactive) OR when running non-interactively with a PR detected, render\n"
        "the report using the **PR Comment Format** in §5. **This is structurally\n"
        "different from the full markdown report** — the report is exhaustive; the\n"
        "PR comment is glanceable with collapsibles for the deep tables.\n\n"
        "Steps:\n\n"
        "1. Render the comment to a temp file (e.g., `/tmp/deep-review-<pr>.md`).\n"
        "2. **Interactive mode only:** show the user a brief preview hint (top 5\n"
        "   lines + section list) and confirm — even though they already chose\n"
        "   this option, the comment contents weren't visible at the time of\n"
        "   choice. A confirmation here avoids posting a comment they wouldn't\n"
        "   have approved. **Skip the confirm in non-interactive mode** — the user\n"
        "   pre-authorized auto-posting by triggering the workflow.\n"
        "3. Post:\n\n"
        "   ```bash\n"
        "   gh pr comment <PR_NUMBER> --body-file <path> --repo <owner>/<repo>\n"
        "   ```\n\n"
        "   `--repo` is required when the PR is in a different repository than the\n"
        "   current working directory; §2's detection returns the value to use.\n"
        "   In GitHub Actions the value is `$GITHUB_REPOSITORY`.\n"
        "4. Echo the comment URL returned by `gh pr comment` back to the user (or\n"
        "   to stdout in CI) so they can verify.\n"
        "5. If the actual `gh pr comment` post fails after preflight passed, exit\n"
        "   non-zero with the error. Do not silently fall back to writing\n"
        "   `DEEP_REVIEW.md` — that hides a real delivery failure.\n\n"
        "**Do not** reference `DEEP_REVIEW.md` or other uncommitted files in the\n"
        "posted comment — links to untracked paths 404 from the PR view. Attribution\n"
        "should be a plain `<sub>` footer with no links.\n",
        context,
    )
    text = require_replace(
        text,
        "**Review branch with markdown report.** Best for full-codebase audits and\n"
        "archival. Create a new branch `<user>/deep-review`, write to\n"
        "`CLAUDE_DEEP_REVIEW.md` at the repo root, commit, and push. Tell the user\n"
        "the branch is ready and they can open a PR for team discussion.",
        "**Review branch with markdown report.** Best for full-codebase audits and\n"
        "archival. Create a new branch `<user>/deep-review`, write to\n"
        "`DEEP_REVIEW.md` at the repo root, commit, and push. Tell the user\n"
        "the branch is ready and they can open a PR for team discussion. Use\n"
        "`DEEP_REVIEW.md`, never a `CLAUDE_*` report filename.",
        context,
    )
    text = text.replace("/code-quality:review", "/code-quality-review")
    text = text.replace("AskUserQuestion", "ask_user_question")
    return text


def transform_size_review(text: str) -> str:
    context = "size-review skill"
    text = add_license_frontmatter(text, context)
    text = require_replace(
        text,
        "${CLAUDE_PLUGIN_ROOT}/skills/size-review/references/",
        "references/",
        context,
    )
    text = require_replace(
        text,
        "- **Sonnet is sufficient for the mechanical steps** (Steps 1-3: scope discovery,\n"        "  exclusions, structural signals). The judgment-heavy steps (Steps 4-6: seam\n"
        "  viability, effort rating, recommendation) benefit from Opus when available, but\n"
        "  Sonnet handles them adequately at substantially lower cost.",
        "- **Standard-tier intent is sufficient for the mechanical steps** (Steps 1-3:\n"
        "  scope discovery, exclusions, structural signals). The judgment-heavy steps\n"
        "  (Steps 4-6: seam viability, effort rating, recommendation) benefit from\n"
        "  large-tier intent when available, but standard tier handles them adequately\n"
        "  at substantially lower cost.",
        context,
    )
    text = require_replace(
        text,
        "For high-volume CI usage (every PR), consider running this skill at Sonnet by default\n"
        "and reserving Opus only for explicit deep-dive requests or PRs flagged by other gates.",
        "For high-volume CI usage (every PR), consider standard-tier intent by default\n"
        "and reserve large-tier intent for explicit deep-dive requests or PRs flagged by\n"
        "other gates when the runtime supports tier selection.",
        context,
    )
    text = require_replace(
        text,
        "- **Easy** — Commits already partition along the seam. A `git rebase -i`\n"
        "  or `gs branch split` produces clean slices with no conflicts.",
        "- **Easy** — Commits already partition along the seam. A `git rebase -i`\n"
        "  or an available stack/split tool such as `gs branch split` produces clean\n"
        "  slices with no conflicts.",
        context,
    )
    text = require_replace(
        text,
        "- The author can use `gs stack submit` to push the whole stack at once\n"
        "  and get review on the bottom while writing the top",
        "- The author can use an available stacking tool such as `gs stack submit`\n"
        "  to push the whole stack at once and get review on the bottom while writing\n"
        "  the top; if no such tool exists, translate the same dependency plan to the\n"
        "  repository's branch and PR workflow",
        context,
    )
    text = require_replace(
        text,
        "### Suggested git-spice flow\n\n"
        "\\`\\`\\`bash\n"
        "# If the PR has heavy fixup noise, squash by section first:\n"
        "git rebase -i <base-ref>\n"
        "# squash fix/lint/CI-debug commits into their parent feature commits\n\n"
        "# Then start the stack from trunk:\n"
        "git checkout <base-ref>\n"
        "gs branch create refactor-foo-rename --target main\n"
        "# cherry-pick or restack the relevant commits\n"
        "gs branch create feat-bar-add-endpoint --target refactor-foo-rename\n"
        "# ...\n"
        "gs stack submit\n"
        "\\`\\`\\`\n\n"
        "If the author already has git-spice loaded, point them at the\n"
        "`git-spice:stacking-workflow` skill for the full workflow.",
        "### Optional git-spice-style flow when available\n\n"
        "Use these commands only when git-spice is available. Otherwise, keep the same\n"
        "stack plan and translate it to the repository's available branch and PR workflow.\n\n"
        "```bash\n"
        "# If the PR has heavy fixup noise, squash by section first:\n"
        "git rebase -i <base-ref>\n"
        "# squash fix/lint/CI-debug commits into their parent feature commits\n\n"
        "# Then start the stack from trunk when git-spice is installed:\n"
        "git checkout <base-ref>\n"
        "gs branch create refactor-foo-rename --target main\n"
        "# cherry-pick or restack the relevant commits\n"
        "gs branch create feat-bar-add-endpoint --target refactor-foo-rename\n"
        "# ...\n"
        "gs stack submit\n"
        "```\n\n"
        "Do not require git-spice or any optional Pi package; use available tools.",
        context,
    )
    text = require_replace(
        text,
        "## Output Actions\n\n"
        "**Detect mode first.** Non-interactive (CI) if any of `CI`, `GITHUB_ACTIONS`,\n"
        "`GITLAB_CI`, or `BUILDKITE` is `\"true\"`, or stdin is not a TTY, or the user\n"
        "asked for headless/CI/auto-post mode. In non-interactive mode never prompt:\n"
        "PR in scope → post the report as a PR comment automatically\n"
        "(`gh pr comment <num> --body-file <report.md>`), and exit non-zero if the\n"
        "post fails; no PR → print the report to stdout with a one-line\n"
        "`size-review: <verdict> · <recommendation>` summary line.\n\n"
        "In interactive mode, ask the user how to surface the report:\n\n"
        "- **Inline** — return the markdown in the chat. Default for ad-hoc reviews.\n"
        "- **PR comment** — post the report as a top-level review comment on the\n"
        "  GitHub PR (`gh pr comment <num> --body-file <report.md>`). Default\n"
        "  for PR-scoped reviews.\n"
        "- **Branch + markdown** — write to `CLAUDE_SIZE_REVIEW.md` and commit on\n"
        "  a `<user>/size-review` branch for archival.\n\n"
        "If a stack plan was produced and the user wants to act on it, offer to\n"
        "hand off to the `git-spice:stacker` agent or the `git-spice:stacking-workflow`\n"
        "skill, which can drive the actual split end-to-end.\n",
        "## Output Actions\n\n"
        "**Detect mode first.** Non-interactive (CI) only if any of `CI`,\n"
        "`GITHUB_ACTIONS`, `GITLAB_CI`, or `BUILDKITE` equals `true`, or the user\n"
        "explicitly asked for headless/CI/auto-post mode. Do **not** infer CI from\n"
        "subprocess stdin being non-TTY; Pi tools may run with non-TTY stdin during\n"
        "interactive sessions. In non-interactive mode never prompt: PR in scope →\n"
        "post the report as a PR comment automatically when `gh` is available\n"
        "(`gh pr comment <num> --body-file <report.md>`), and exit non-zero if the\n"
        "post fails; no PR → write `SIZE_REVIEW.md` and print a one-line\n"
        "`size-review: <verdict> · <recommendation>` summary line.\n\n"
        "In interactive mode, use `ask_user_question` with the package `questions[]`\n"
        "JSON shape and 2-4 concise options:\n\n"
        "```json\n"
        "{\n"
        "  \"questions\": [\n"
        "    {\n"
        "      \"id\": \"delivery\",\n"
        "      \"question\": \"How would you like to surface this size review?\",\n"
        "      \"header\": \"Output\",\n"
        "      \"options\": [\n"
        "        {\n"
        "          \"label\": \"Post comment to PR #<N> (Recommended)\",\n"
        "          \"description\": \"Post the rendered report as a top-level PR comment when a PR is in scope.\"\n"
        "        },\n"
        "        {\n"
        "          \"label\": \"Write SIZE_REVIEW.md\",\n"
        "          \"description\": \"Write the markdown report to SIZE_REVIEW.md at the repo root without committing.\"\n"
        "        },\n"
        "        {\n"
        "          \"label\": \"Return inline\",\n"
        "          \"description\": \"Return the markdown in chat for ad-hoc reviews.\"\n"
        "        }\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}\n"
        "```\n\n"
        "The package provides the `Type something.` and `Chat about this` escape\n"
        "hatches; do not add manual pseudo-options for those choices. If a stack plan\n"
        "was produced and the user wants to act on it, offer a handoff only to tools or\n"
        "skills that are actually available. GitHub and git-spice delivery are\n"
        "conditional on those tools being installed and authenticated; otherwise keep\n"
        "the stack plan in `SIZE_REVIEW.md` or the chat output. Use `SIZE_REVIEW.md`,\n"
        "never a `CLAUDE_*` report filename.\n",
        context,
    )
    text = text.replace("/code-quality:size", "/code-quality-size")
    text = text.replace("AskUserQuestion", "ask_user_question")
    return text


def copy_text_file(source: Path, destination: Path, transform) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = source.read_text(encoding="utf8")
    destination.write_text(transform(text), encoding="utf8")


def build_generated_tree(source: Path, temporary_root: Path) -> Path:
    prompts_root = temporary_root / "prompts"
    skills_root = temporary_root / "skills"
    prompts_root.mkdir(parents=True)
    skills_root.mkdir(parents=True)

    copy_text_file(
        source / "commands/review.md",
        prompts_root / "code-quality-review.md",
        lambda text: transform_prompt("review", text),
    )
    copy_text_file(
        source / "commands/size.md",
        prompts_root / "code-quality-size.md",
        lambda text: transform_prompt("size", text),
    )

    copy_text_file(source / "skills/deep-review/SKILL.md", skills_root / "deep-review/SKILL.md", transform_deep_review)
    for reference in ("go.md", "python.md", "rust.md", "svelte-ts.md"):
        copy_text_file(
            source / "skills/deep-review/references" / reference,
            skills_root / "deep-review/references" / reference,
            lambda text, context=reference: replace_reference_roots(text, f"deep-review reference {context}"),
        )
    copy_text_file(
        source / "skills/deep-review/references/output-actions.md",
        skills_root / "deep-review/references/output-actions.md",
        transform_output_actions,
    )

    copy_text_file(source / "skills/size-review/SKILL.md", skills_root / "size-review/SKILL.md", transform_size_review)
    copy_text_file(
        source / "skills/size-review/references/default-exclusions.md",
        skills_root / "size-review/references/default-exclusions.md",
        lambda text: replace_reference_roots(text, "size-review default exclusions"),
    )

    validate_generated_tree(temporary_root)
    return temporary_root


def validate_generated_tree(temporary_root: Path) -> None:
    prompts_root = temporary_root / "prompts"
    skills_root = temporary_root / "skills"
    prompt_entries = sorted(path.name for path in prompts_root.iterdir())
    skill_entries = sorted(path.name for path in skills_root.iterdir())
    expected_prompts = ["code-quality-review.md", "code-quality-size.md"]
    expected_skills = ["deep-review", "size-review"]
    if prompt_entries != expected_prompts:
        raise RuntimeError(f"Generated prompt root mismatch: {prompt_entries!r}")
    if skill_entries != expected_skills:
        raise RuntimeError(f"Generated skill root mismatch: {skill_entries!r}")
    for relative in expected_prompts:
        if not (prompts_root / relative).is_file():
            raise RuntimeError(f"Generated prompt missing: {relative}")
    for relative in expected_skills:
        if not (skills_root / relative).is_dir():
            raise RuntimeError(f"Generated skill missing: {relative}/")

    for file_path in sorted(path for path in temporary_root.rglob("*") if path.is_file()):
        text = file_path.read_text(encoding="utf8")
        for forbidden in FORBIDDEN_GENERATED:
            if forbidden in text:
                relative = file_path.relative_to(temporary_root)
                raise RuntimeError(f"Forbidden generated text {forbidden!r} found in {relative}")


def install_generated_tree(temporary_root: Path, package_root: Path) -> None:
    for name in ("prompts", "skills"):
        target = package_root / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(temporary_root / name, target)


def main() -> None:
    args = parse_args()
    source = resolve_source_path(args)
    validate_source(source)
    temporary_root = Path(tempfile.mkdtemp(prefix="pi-code-quality-generated-"))
    atexit.register(shutil.rmtree, temporary_root, ignore_errors=True)
    try:
        build_generated_tree(source, temporary_root)
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    install_generated_tree(temporary_root, PACKAGE_ROOT)
    print(f"Migrated code-quality plugin from: {source}")


if __name__ == "__main__":
    main()
