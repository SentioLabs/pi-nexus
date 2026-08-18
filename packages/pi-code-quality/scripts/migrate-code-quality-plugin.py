#!/usr/bin/env python3
import argparse
import atexit
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_CANDIDATES = (
    Path.home() / "devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/code-quality",
    Path.home() / "devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/code-quality",
)

RUNTIME_MANIFEST = (
    ("commands/review.md", "prompts/code-quality-review.md"),
    ("commands/size.md", "prompts/code-quality-size.md"),
    ("skills/deep-review/SKILL.md", "skills/deep-review/SKILL.md"),
    ("skills/deep-review/references/go.md", "skills/deep-review/references/go.md"),
    ("skills/deep-review/references/output-actions.md", "skills/deep-review/references/output-actions.md"),
    ("skills/deep-review/references/python.md", "skills/deep-review/references/python.md"),
    ("skills/deep-review/references/rust.md", "skills/deep-review/references/rust.md"),
    ("skills/deep-review/references/svelte-ts.md", "skills/deep-review/references/svelte-ts.md"),
    ("skills/size-review/SKILL.md", "skills/size-review/SKILL.md"),
    ("skills/size-review/references/default-exclusions.md", "skills/size-review/references/default-exclusions.md"),
)
REQUIRED_SOURCE_PATHS = tuple(source for source, _ in RUNTIME_MANIFEST) + (".claude-plugin/plugin.json",)
INTENTIONALLY_IGNORED_SOURCE_PATHS = ("CHANGELOG.md", "version.txt")
SOURCE_METADATA_PATH = ".claude-plugin/plugin.json"

# Sections replaced wholesale must match an explicitly reviewed source body. The
# fixture digests are retained only for the self-contained overlay-contract test.
REPLACED_SECTION_DIGESTS = {
    "deep-review model assignment": {
        "714aa2ec20e7b189b534619b62f41907c38e34d16f88838acbd89d342870d3e1",
        "9a24c926519dd11530443564d10c22f5f6d170960fcbaef2a3a1743b6ab2442b",
    },
    "deep-review output actions section 3": {
        "4a2c90334e52080c37d92fcc3a36771c6b293d0ed6b6df98ab79ccb65960f657",
        "ee31e5398d1a68b7165b67def73976ce699801f48208144500f8c0ab3f4ce0c9",
    },
    "deep-review output actions section 4": {
        "8ab1767a533cc561ddcdf4fc7167723415db9efcf8894c5a4e015389df8af333",
        "ca176ffaf05d7488b35dcc8cbe59381aa4e13cf05dc6e437bcd3082902dd1986",
    },
}

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
        "title": "# Deep Review",
        "skill": "deep-review",
        "source_command": "/code-quality:review",
        "target_command": "/code-quality-review",
    },
    "size": {
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

    expected = set(REQUIRED_SOURCE_PATHS) | set(INTENTIONALLY_IGNORED_SOURCE_PATHS)
    actual = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
    unclassified = sorted(actual - expected)
    if unclassified:
        details = "\n".join(f"- {relative}" for relative in unclassified)
        raise SystemExit(
            "Unclassified source file(s) would be omitted from pi-code-quality generation:\n"
            f"{details}"
        )

    metadata_path = source / SOURCE_METADATA_PATH
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid source plugin.json at {metadata_path}: {error}") from error
    if not isinstance(metadata, dict):
        raise SystemExit(f"Invalid source plugin.json at {metadata_path}: expected an object")
    if metadata.get("name") != "code-quality":
        raise SystemExit(
            f"Source plugin.json name must be 'code-quality', got {metadata.get('name')!r}: {metadata_path}"
        )
    if metadata.get("license") != "MIT":
        raise SystemExit(
            f"Source plugin.json license must be 'MIT', got {metadata.get('license')!r}: {metadata_path}"
        )


def require_replace(text: str, old: str, new: str, context: str) -> str:
    occurrences = text.count(old)
    if occurrences != 1:
        raise RuntimeError(
            f"Expected exactly one source text occurrence while patching {context}, found {occurrences}: {old[:120]!r}"
        )
    return text.replace(old, new, 1)


def replace_all(text: str, old: str, new: str, context: str, *, require_match: bool = True) -> str:
    occurrences = text.count(old)
    if occurrences == 0 and require_match:
        raise RuntimeError(f"Expected source text not found while patching {context}: {old[:120]!r}")
    result = text.replace(old, new)
    if old in result:
        raise RuntimeError(f"Source text remained after lexical replacement in {context}: {old[:120]!r}")
    return result


def replace_section(
    text: str,
    start_marker: str,
    end_marker: str,
    replacement: str,
    context: str,
    expected_digests: set[str] | None = None,
) -> str:
    starts = text.count(start_marker)
    ends = text.count(end_marker)
    if starts != 1:
        raise RuntimeError(f"Expected exactly one section start marker while patching {context}, found {starts}: {start_marker!r}")
    if ends != 1:
        raise RuntimeError(f"Expected exactly one section end marker while patching {context}, found {ends}: {end_marker!r}")
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    body = text[start:end]
    if expected_digests and hashlib.sha256(body.encode("utf8")).hexdigest() not in expected_digests:
        raise RuntimeError(
            f"Unexpected source body drift in {context}; review and update the exact section guard before regenerating"
        )
    return text[:start] + replacement + text[end:]


def split_frontmatter(text: str, context: str) -> tuple[str, str]:
    if not text.startswith("---\n"):
        raise RuntimeError(f"Expected frontmatter while patching {context}")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise RuntimeError(f"Expected closing frontmatter delimiter while patching {context}")
    return text[4:end], text[end + len("\n---\n") :].lstrip("\n")


def strip_frontmatter(text: str, context: str) -> str:
    return split_frontmatter(text, context)[1]


def parse_prompt_frontmatter(text: str, context: str) -> tuple[str, str]:
    frontmatter, body = split_frontmatter(text, context)
    lines = frontmatter.splitlines()
    if len(lines) != 1:
        unsupported = [line.partition(":")[0] for line in lines if not line.startswith("description: ")]
        if unsupported:
            raise RuntimeError(f"Unsupported source prompt frontmatter key while patching {context}: {unsupported[0]!r}")
        raise RuntimeError(
            f"Unsupported source prompt frontmatter shape while patching {context}; only one scalar description is supported"
        )
    if not lines[0].startswith("description: "):
        raise RuntimeError(
            f"Unsupported source prompt frontmatter shape while patching {context}; only one scalar description is supported"
        )
    description = lines[0].removeprefix("description: ").strip()
    if not description:
        raise RuntimeError(f"Source prompt description is empty while patching {context}")
    return description, body


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
    description, body = parse_prompt_frontmatter(text, f"{source_name} prompt")
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
    body = replace_all(
        body,
        config["source_command"],
        config["target_command"],
        f"{source_name} prompt command",
    )
    if "$ARGUMENTS" in body:
        raise RuntimeError(f"Unexpected pre-existing $ARGUMENTS marker while patching {source_name} prompt")
    return (
        "---\n"
        f"description: {description}\n"
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
            text = replace_all(text, old, new, context)
    return text


def transform_deep_review(text: str) -> str:
    context = "deep-review skill"
    text = add_license_frontmatter(text, context)
    text = replace_all(
        text,
        "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/references/",
        "references/",
        context,
    )
    text = require_replace(
        text,
        "Perform a comprehensive code review through a 5-lens parallel architecture.",
        "Perform a comprehensive code review through five independent lens passes.\n"
        "Use parallel-capable execution when available, with the same methodology run\n"
        "sequentially when delegation is unavailable.",
        context,
    )
    text = require_replace(
        text,
        "After the parallel scan, a calibration agent scores every finding on a 0-100 scale,\n"
        "cross-references across lenses, and produces a filtered, verdict-bearing report.",
        "After the lens passes, a calibration pass scores every finding on a 0-100 scale,\n"
        "cross-references across lenses, and produces a filtered, verdict-bearing report.",
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
        REPLACED_SECTION_DIGESTS["deep-review model assignment"],
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
        "### Phase 1: Parallel 5-lens scan\n\n"
        "Launch the applicable subagents in parallel. **Tailor each lens's context bundle** to\n"
        "what that lens actually needs — broadcasting the full Step 0 context to every agent\n"
        "multiplies input cost by 5× without adding signal. Each lens's prompt below specifies\n"
        "which context elements to include.",
        "### Phase 1: Five independent lens passes\n\n"
        "When a generic parallel task/subagent tool is available, run the applicable lens\n"
        "passes concurrently. Otherwise, run the exact same lens prompts sequentially with\n"
        "separated outputs. **Tailor each lens's context bundle** to what that lens actually\n"
        "needs — broadcasting the full Step 0 context to every worker multiplies input cost\n"
        "by 5× without adding signal. Each lens's prompt below specifies which context\n"
        "elements to include.",
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
        "is to take findings from the parallel reviewers (Correctness & Quality, Security,\n"
        "> Idiom & Best Practices, Architecture and Solution-Fit, AI Slop & Curation Evidence)",
        "is to take findings from the independent lens reviewers (Correctness & Quality, Security,\n"
        "> Idiom & Best Practices, Architecture and Solution-Fit, AI Slop & Curation Evidence)",
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
        "  Use `ask_user_question` only when the tool is available.\n"
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
        "non-interactive regardless of env. The tool subprocess stdin may be non-TTY during an interactive session;\n"
        "do **not** infer CI from it. Pi tools may run with non-TTY stdin during interactive sessions.\n\n"
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
        "preflight passes. If a PR was detected but `gh` is unavailable or unauthenticated,\n"
        "write `DEEP_REVIEW.md`, print the one-line summary, and\n"
        "surface that PR delivery was unavailable.\n\n"
        "In interactive mode, use `ask_user_question` with the `questions[]` JSON\n"
        "shape only when that tool is available. If it is unavailable, use a plain-chat\n"
        "conversational fallback: ask the user how to deliver the report, or return it\n"
        "inline when no response is needed. When a PR was detected, first verify GitHub\n"
        "delivery availability:\n\n"
        "```bash\n"
        "command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1\n"
        "```\n\n"
        "An equivalent explicit availability/auth check is acceptable. If this\n"
        "preflight fails, **Do not offer the PR-post option**. Offer\n"
        "`Write DEEP_REVIEW.md` and `Return inline` through the available question\n"
        "tool or the plain-chat conversational fallback, and tell the user GitHub PR\n"
        "delivery is unavailable or unauthenticated.\n\n"
        "**PR detected and GitHub delivery available — when `ask_user_question` is\n"
        "available, present two options using its `questions[]` shape:**\n\n"
        "```json\n"
        "{\n"
        "  \"questions\": [\n"
        "    {\n"
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
        "a PR is detected and GitHub delivery is available. The `ask_user_question`\n"
        "tool supplies `Type something.` / `Chat about this` free-form escape hatches;\n"
        "pi-code-quality does not bundle that tool, so do not add manual pseudo-options\n"
        "or claim the package supplies them.\n\n"
        "**No PR detected — skip the question.** Write `DEEP_REVIEW.md` directly and\n"
        "tell the user: \"No open PR found for this branch — wrote findings to\n"
        "`DEEP_REVIEW.md` (untracked).\" If the user wants something else they can\n"
        "ask in their next turn. Do not present a 1-option menu; when the question\n"
        "tool is unavailable, use the plain-chat conversational fallback instead.\n\n"
        "If the user makes a free-form escape-hatch request, parse it. Common requests\n"
        "to handle:\n\n"
        "- Review branch + markdown — see §7\n"
        "- GitHub issues for each confirmed finding — see §7\n"
        "- Inline review comments at specific lines — see §7\n"
        "- Print to terminal only — just emit the markdown report and exit\n",
        context,
        REPLACED_SECTION_DIGESTS["deep-review output actions section 3"],
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
        "5. If the actual `gh pr comment` post fails after preflight passed, exit non-zero with the error.\n"
        "   Do not silently fall back to writing\n"
        "   `DEEP_REVIEW.md` — that hides a real delivery failure.\n\n"
        "**Do not** reference `DEEP_REVIEW.md` or other uncommitted files in the\n"
        "posted comment — links to untracked paths 404 from the PR view. Attribution\n"
        "should be a plain `<sub>` footer with no links.\n",
        context,
        REPLACED_SECTION_DIGESTS["deep-review output actions section 4"],
    )
    text = require_replace(
        text,
        "When the user selects \"Write DEEP_REVIEW.md\" (interactive) OR when running\n"
        "non-interactively with no PR detected (CI), write the full markdown report\n"
        "(per the **Output Format** section of SKILL.md) to `DEEP_REVIEW.md` at the\n"
        "repo root. Do not commit, do not push.",
        "When the user selects \"Write DEEP_REVIEW.md\" (interactive), when no PR is\n"
        "detected non-interactively, **or when a PR was detected but `gh` is unavailable or unauthenticated**,\n"
        "write the full markdown report (per the **Output Format**\n"
        "section of SKILL.md) to `DEEP_REVIEW.md` at the repo root. Do not commit, do not push.\n"
        "The unavailable/unauthenticated-`gh` path is a neutral local-report\n"
        "fallback, not a failed PR-post attempt.",
        context,
    )
    text = require_replace(
        text,
        "- **Non-interactive (CI):** also print a single-line summary to stdout —\n"
        "  `deep-review: <verdict> · grade <letter> · <final_score>/100 · wrote\n"
        "  DEEP_REVIEW.md` — so the workflow log captures the result. If the CI is\n"
        "  expected to upload `DEEP_REVIEW.md` as a workflow artifact, the path\n"
        "  should remain at the repo root unless the workflow specifies otherwise.",
        "- **Non-interactive (CI):** also print a single-line summary to stdout —\n"
        "  `deep-review: <verdict> · grade <letter> · <final_score>/100 · wrote\n"
        "  DEEP_REVIEW.md` — so the workflow log captures the result. When this followed\n"
        "  a PR detection with unavailable or unauthenticated `gh`, also surface that PR\n"
        "  delivery was unavailable. If the CI is expected to upload `DEEP_REVIEW.md` as\n"
        "  a workflow artifact, the path should remain at the repo root unless the\n"
        "  workflow specifies otherwise.",
        context,
    )
    text = require_replace(
        text,
        "## 7. Other delivery shapes (when the user picks \"Other\")\n\n"
        "These are fallbacks — only use when the user explicitly asks via the\n"
        "\"Other\" free-form input.\n\n",
        "## 7. Free-form escape-hatch delivery shapes\n\n"
        "These are fallbacks — only use when the user explicitly makes a free-form\n"
        "escape-hatch request through an available question tool or plain chat.\n\n"
        "### GitHub-backed alternate delivery preflight\n\n"
        "Before every GitHub-backed alternate delivery — creating GitHub issues,\n"
        "posting inline review comments with `gh api`, or a combined action that\n"
        "includes either — both preflight commands must pass:\n\n"
        "```bash\n"
        "command -v gh >/dev/null 2>&1\n"
        "gh auth status >/dev/null 2>&1\n"
        "```\n\n"
        "Run this preflight before each GitHub-backed action, including the\n"
        "actionable part of a combined delivery. If either command fails because\n"
        "`gh` is unavailable or unauthenticated, do not invoke `gh`. Instead\n"
        "retain/report the findings via `DEEP_REVIEW.md` or inline output and state\n"
        "GitHub delivery is unavailable.\n\n"
        "If preflight passed but an actual `gh issue create` or `gh api` post/create\n"
        "fails, let the failure remain loud and non-zero; do not silently fall back.\n\n",
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
    text = replace_all(text, "/code-quality:review", "/code-quality-review", context)
    text = replace_all(text, "AskUserQuestion", "ask_user_question", context, require_match=False)
    text = require_replace(
        text,
        "<sub>Generated by `/code-quality-review` · 5-lens parallel scan + calibration</sub>",
        "<sub>Generated by `/code-quality-review` · 5-lens scan + calibration</sub>",
        context,
    )
    return text


def transform_size_review(text: str) -> str:
    context = "size-review skill"
    text = add_license_frontmatter(text, context)
    text = replace_all(
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
        "\\`\\`\\`bash\n"
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
        "\\`\\`\\`\n\n"
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
        "explicitly asked for headless/CI/auto-post mode. The tool subprocess stdin may be non-TTY during an interactive session;\n"
        "do **not** infer CI from it. Pi tools may run with non-TTY stdin during interactive sessions.\n\n"
        "Before offering or executing GitHub PR delivery, require both preflight commands:\n\n"
        "```bash\n"
        "command -v gh >/dev/null 2>&1\n"
        "gh auth status >/dev/null 2>&1\n"
        "```\n\n"
        "Only a PR plus successful preflight permits `gh pr comment`. If preflight passes\n"
        "but the actual `gh pr comment` post fails, exit non-zero loudly; do not silently\n"
        "fall back.\n\n"
        "In non-interactive mode never prompt. With a PR and successful preflight, post the\n"
        "report as a PR comment automatically. With a PR but `gh` unavailable or unauthenticated,\n"
        "write `SIZE_REVIEW.md`, print the full report to stdout, then print\n"
        "the one-line `size-review: <verdict> · <recommendation>` summary and state PR\n"
        "delivery is unavailable; do not invoke `gh`. With no PR, write `SIZE_REVIEW.md`,\n"
        "print the full report to stdout, then print the one-line\n"
        "`size-review: <verdict> · <recommendation>` summary.\n\n"
        "In interactive mode, use `ask_user_question` with the `questions[]` JSON shape only when that tool is available.\n"
        "If it is unavailable, use a plain chat conversational fallback to ask how the user wants the report delivered.\n"
        "With a PR and successful\n"
        "preflight, offer `Post comment to PR #<N> (Recommended)`, `Write SIZE_REVIEW.md`,\n"
        "and `Return inline` choices. When a PR exists but `gh` is unavailable or unauthenticated,\n"
        "do not offer the PR-post option: offer local or inline delivery\n"
        "and state PR delivery is unavailable. With no PR, offer only available local or\n"
        "inline choices. The `ask_user_question` tool supplies `Type something.` /\n"
        "`Chat about this` free-form escape hatches; pi-code-quality does not bundle that\n"
        "tool, so do not add manual pseudo-options.\n\n"
        "Only after the user explicitly selects **Branch + markdown**, create a\n"
        "`<user>/size-review` branch, write `SIZE_REVIEW.md` at the repo root, commit, and\n"
        "push for archival. Preserve `Write SIZE_REVIEW.md` for local uncommitted delivery\n"
        "and `Return inline` for chat delivery.\n\n"
        "If a stack plan was produced and the user wants to act on it, offer a handoff only to\n"
        "tools or skills that are actually available. GitHub and git-spice delivery are\n"
        "conditional on those tools being installed and authenticated; otherwise keep the\n"
        "stack plan in `SIZE_REVIEW.md` or chat output. Use `SIZE_REVIEW.md`, never a\n"
        "`CLAUDE_*` report filename.\n",
        context,
    )
    text = replace_all(text, "/code-quality:size", "/code-quality-size", context, require_match=False)
    text = replace_all(text, "AskUserQuestion", "ask_user_question", context, require_match=False)
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
    expected_files = {target for _, target in RUNTIME_MANIFEST}
    actual_files = {
        path.relative_to(temporary_root).as_posix()
        for path in temporary_root.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_files:
        missing = sorted(expected_files - actual_files)
        extras = sorted(actual_files - expected_files)
        raise RuntimeError(
            "Generated runtime manifest mismatch: "
            f"missing={missing!r}; extras={extras!r}"
        )

    for relative in sorted(actual_files):
        text = (temporary_root / relative).read_text(encoding="utf8")
        for forbidden in FORBIDDEN_GENERATED:
            if forbidden in text:
                raise RuntimeError(f"Forbidden generated text {forbidden!r} found in {relative}")


def rename_path(source: Path, target: Path) -> None:
    source.rename(target)


def remove_tree(path: Path) -> None:
    shutil.rmtree(path)


def install_generated_tree(temporary_root: Path, package_root: Path, move=rename_path, remove=remove_tree) -> None:
    names = tuple(sorted({target.split("/", 1)[0] for _, target in RUNTIME_MANIFEST}))
    staging = {}
    backups = {}
    installed = set()

    try:
        for name in names:
            stage = Path(tempfile.mkdtemp(prefix=f".{name}.staging-", dir=package_root))
            stage.rmdir()
            staging[name] = stage
            shutil.copytree(temporary_root / name, stage)

        for name in names:
            target = package_root / name
            if target.exists():
                backup = Path(tempfile.mkdtemp(prefix=f".{name}.backup-", dir=package_root))
                backup.rmdir()
                move(target, backup)
                backups[name] = backup

        for name in names:
            move(staging[name], package_root / name)
            installed.add(name)
    except Exception as install_error:
        rollback_errors = []
        for name in reversed(names):
            target = package_root / name
            if name in installed and target.exists():
                try:
                    remove(target)
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)

        for name, backup in backups.items():
            target = package_root / name
            try:
                if target.exists():
                    remove(target)
                if not backup.exists():
                    raise RuntimeError(f"Rollback backup disappeared for {name}: {backup}")
                move(backup, target)
                if not target.exists() or backup.exists():
                    raise RuntimeError(f"Rollback did not restore original {name} root")
            except Exception as rollback_error:
                rollback_errors.append(rollback_error)

        for stage in staging.values():
            if stage.exists():
                try:
                    remove(stage)
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)

        if rollback_errors:
            details = "; ".join(str(error) for error in rollback_errors)
            raise RuntimeError(f"Failed to roll back generated resource installation: {details}") from install_error
        raise
    else:
        for backup in backups.values():
            remove(backup)


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
