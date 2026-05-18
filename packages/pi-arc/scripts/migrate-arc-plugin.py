#!/usr/bin/env python3
import argparse
from pathlib import Path
import shutil
import re

REPO_ROOT = Path(__file__).resolve().parents[1]
ARC_ROOT = REPO_ROOT
DEFAULT_SRC = (REPO_ROOT / "../agent-nexus/claude-marketplace/plugins/arc").resolve()
PI_LOCAL_SKILL_DIRS = set()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Regenerate pi-arc resources from the Claude Arc plugin source.",
    )
    parser.add_argument(
        "source",
        nargs="?",
        help=f"Path to the Claude Arc plugin source directory. Defaults to {DEFAULT_SRC}.",
    )
    parser.add_argument(
        "--source",
        dest="source_option",
        metavar="SOURCE",
        help="Path to the Claude Arc plugin source directory (option form).",
    )
    return parser.parse_args()


def resolve_source_path(args: argparse.Namespace) -> Path:
    if args.source and args.source_option:
        raise SystemExit("Pass the source path either positionally or with --source, not both.")
    raw_source = args.source_option or args.source
    if raw_source:
        return Path(raw_source).expanduser().resolve()
    return DEFAULT_SRC


def validate_source(src: Path) -> None:
    expected_paths = [
        "commands",
        "skills",
        "agents",
        ".claude-plugin/plugin.json",
    ]
    missing = [rel for rel in expected_paths if not (src / rel).exists()]
    if missing:
        missing_text = "\n".join(f"- {rel}" for rel in missing)
        raise SystemExit(
            f"Source plugin does not look like the Claude Arc plugin: {src}\n"
            f"Missing expected paths:\n{missing_text}"
        )


ARGS = parse_args()
SRC = resolve_source_path(ARGS)
validate_source(SRC)

ARC_ROOT.mkdir(parents=True, exist_ok=True)

# Snapshot true Pi-only overlays before regenerating resources.
# Upstream does not ship the devops executor; the tracked file is canonical.
PRESERVED_OVERLAY_FILES = [
    "agents/devops.md",
]

PRESERVED_OVERLAY_SET = set(PRESERVED_OVERLAY_FILES)

overlay_text_by_rel: dict[str, str] = {}
for rel in PRESERVED_OVERLAY_FILES:
    overlay_path = ARC_ROOT / rel
    if not overlay_path.exists():
        raise SystemExit(
            f"Missing required Pi overlay: {rel}. "
            "Restore tracked resources before running migration."
        )
    overlay_text_by_rel[rel] = overlay_path.read_text()

# Clean generated Arc resource directories only. Keep package.json, README,
# extension edits, and Pi-only maintainer skills that are not present upstream.
for name in ["prompts", "agents"]:
    p = ARC_ROOT / name
    if p.exists():
        shutil.rmtree(p)
    p.mkdir(parents=True, exist_ok=True)

skills_root = ARC_ROOT / "skills"
skills_root.mkdir(parents=True, exist_ok=True)
for child in list(skills_root.iterdir()):
    if child.name in PI_LOCAL_SKILL_DIRS:
        continue
    if child.is_dir():
        shutil.rmtree(child)
    else:
        child.unlink()

# Release metadata is managed by this npm package and Release Please.
# Do not copy the source Claude plugin changelog or legacy version.txt.

for f in sorted((SRC / "commands").glob("*.md")):
    dest_name = f"arc-{f.name}"
    text = f.read_text()
    text = re.sub(r"/arc:([a-zA-Z0-9_-]+)", r"/arc-\1", text)
    text = text.replace("Claude Code", "Pi")
    text = text.replace("Claude", "Pi")
    text = text.replace("SessionStart and PreCompact hooks", "the Pi arc extension on session start and before compaction")
    text = re.sub(r"When to use arc vs TodoWrite", "When to use arc vs the bundled `todo` checklist workflow", text, flags=re.IGNORECASE)
    text = re.sub(r"todowrite vs arc", "todo checklist vs arc", text, flags=re.IGNORECASE)
    text = re.sub(r"TodoWrite", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    text = re.sub(r"TaskCreate/TaskUpdate", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    text = re.sub(r"TaskCreate", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    (ARC_ROOT / "prompts" / dest_name).write_text(text)

skill_map = {
    "arc": "arc",
    "brainstorm": "arc-brainstorm",
    "build": "arc-build",
    "debug": "arc-debug",
    "finish": "arc-finish",
    "plan": "arc-plan",
    "review": "arc-review",
    "verify": "arc-verify",
}

def transform_text(text: str) -> str:
    # Slash command references.
    text = re.sub(r"/arc:([a-zA-Z0-9_-]+)", lambda m: f"/arc-{m.group(1)}", text)
    for old, new in skill_map.items():
        if old != "arc":
            text = text.replace(f"/skill:{old}", f"/skill:{new}")

    # Harness naming and Claude-specific tool names.
    text = text.replace("Claude Code", "Pi")
    text = text.replace("Claude", "Pi")
    text = re.sub(r"TaskCreate/TaskUpdate tracks workflow progress in the CLI", "the bundled `todo` checklist tracks in-session workflow progress in the CLI", text, flags=re.IGNORECASE)
    text = re.sub(r"Create a TodoWrite checklist", "Create a checklist using the bundled `todo` tool (or `/todos`)", text, flags=re.IGNORECASE)
    text = re.sub(r"`TaskCreate`", "the bundled `todo` checklist (via `todo` tool / `/todos`)", text, flags=re.IGNORECASE)
    text = re.sub(r"TaskCreate/TaskUpdate", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    text = re.sub(r"TaskCreate", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    text = re.sub(r"TodoWrite", "the bundled `todo` checklist", text, flags=re.IGNORECASE)
    # Ask-user-question migration: Pi uses the bundled @juicesharp package and
    # its questions[] schema rather than an Arc-owned custom selector shape.
    text = text.replace("AskUserQuestion tool", "`ask_user_question` tool")
    text = text.replace("AskUserQuestion", "`ask_user_question`")
    text = text.replace(
        "- **Use the `ask_user_question` tool** for multiple-choice decisions (2-4 options)",
        "- **Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool** for structured decisions using the package `questions[]` schema",
    )
    text = text.replace(
        "**Use the `ask_user_question` tool:**",
        "**Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool with the package `questions[]` schema:**",
    )

    # Subagent migration.
    text = text.replace("Use the Agent tool with subagent_type=\"arc:issue-manager\":", "Use the arc_agent tool with agent=\"issue-manager\":")
    text = text.replace("Agent(subagent_type=\"arc:builder\", model=\"haiku\", prompt=\"...\")", "arc_agent(agent=\"coder\", model=\"haiku\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", prompt=\"...\")", "arc_agent(agent=\"coder\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", model=\"opus\", prompt=\"...\")", "arc_agent(agent=\"coder\", model=\"opus\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 1...\")", "arc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 1...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 2...\")", "arc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 2...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 3...\")", "arc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 3...\")")
    text = text.replace("Agent dispatch", "arc_agent dispatch")
    text = text.replace("Agent tool", "arc_agent tool")
    text = text.replace("Use the Agent", "Use arc_agent")

    # Pi executor rename: builder -> coder (legacy upstream input may still mention builder).
    text = text.replace("arc-builder", "arc-coder")
    text = text.replace("builder-prompt.md", "coder-prompt.md")
    text = text.replace("`builder`", "`coder`")
    text = text.replace("agent=\"builder\"", "agent=\"coder\"")
    text = text.replace("agent: \"builder\"", "agent: \"coder\"")
    text = text.replace("dispatching `builder`", "dispatching `coder`")

    # Relative paths after skill directory renames.
    text = text.replace("../build/", "../arc-build/")
    text = text.replace("../review/", "../arc-review/")
    text = text.replace("skills/brainstorm/SKILL.md", "skills/arc-brainstorm/SKILL.md")
    text = text.replace("skills/plan/SKILL.md", "skills/arc-plan/SKILL.md")
    return text

for src_dir in sorted((SRC / "skills").iterdir()):
    if not src_dir.is_dir():
        continue
    old_name = src_dir.name
    # Claude's team-dispatch skill depends on Claude-only persistent team
    # primitives (TeamCreate/TaskCreate/TaskUpdate/Agent team_name). Pi does
    # not provide equivalent semantics, so do not package a misleading skill.
    if old_name == "team-dispatch":
        continue
    # arc-source-sync is a repo-local maintainer workflow under .pi/skills;
    # never recreate a package-local copy even if an upstream source appears.
    if old_name in {"source-sync", "arc-source-sync"}:
        continue
    new_name = skill_map.get(old_name, f"arc-{old_name}")
    dest_dir = ARC_ROOT / "skills" / new_name
    # Upstream eval fixtures are for the Claude plugin harness and contain
    # Claude-only tool names. Do not package them as Pi skill resources.
    shutil.copytree(src_dir, dest_dir, ignore=shutil.ignore_patterns("evals"))
    skill_file = dest_dir / "SKILL.md"
    if skill_file.exists():
        text = skill_file.read_text()
        text = re.sub(r"(?m)^name:\s*.+$", f"name: {new_name}", text, count=1)
        text = transform_text(text)
        skill_file.write_text(text)
    for md in dest_dir.rglob("*.md"):
        if md.name == "SKILL.md":
            continue
        md.write_text(transform_text(md.read_text()))
        if md.name == "builder-prompt.md":
            coder_prompt = md.with_name("coder-prompt.md")
            md.replace(coder_prompt)

# Patch generated skills for Pi-specific execution semantics.
def patch_file(rel: str, replacements: list[tuple[str, str]]) -> None:
    if rel in PRESERVED_OVERLAY_SET:
        return
    path = ARC_ROOT / rel
    text = path.read_text()
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(f"Expected text not found while patching {rel}: {old[:80]!r}")
        text = text.replace(old, new)
    path.write_text(text)


def replace_section(rel: str, start_marker: str, end_marker: str, replacement: str) -> None:
    if rel in PRESERVED_OVERLAY_SET:
        return
    path = ARC_ROOT / rel
    text = path.read_text()
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    path.write_text(text[:start] + replacement + text[end:])

patch_file("prompts/arc-team.md", [
    (
        "description: Agent team operations",
        "description: Show arc teammate-label context",
    ),
    (
        "Manage agent team operations with `arc team`.",
        "Show teammate-label planning context with `arc team`.\n\nPi does not support Claude-style team deployment. Use this command only to inspect `teammate:*` issue groupings; implementation remains orchestrated through `/arc-build`.",
    ),
    (
        "**Related commands:**\n- `arc prime --role=lead` — Team lead context output\n- `arc prime --role=frontend` — Teammate-specific context (or use `ARC_TEAMMATE_ROLE` env var)",
        "**Related commands:**\n- `arc prime --role=lead` — Lead-oriented context output\n- `arc prime --role=frontend` — Role-filtered context (or use `ARC_TEAMMATE_ROLE` env var)",
    ),
])

patch_file("skills/arc/SKILL.md", [
    (
        "After `plan`, choose:\n- **Single-agent + subagents**: Invoke `implement`. Main agent orchestrates, subagents do TDD. Best for sequential tasks.\n- **Agentic team**: Add `teammate:*` labels, invoke `arc team-deploy`. Best for parallel multi-role work.",
        "After `plan`, choose:\n- **Single-agent + subagents**: Invoke `implement`. Main agent orchestrates, subagents do TDD. Best for sequential tasks.\n- **Parallel Arc build**: For independent task batches, `implement` can use worktree-isolated `pi-subagents` runs when that companion package and Arc agent definitions are available. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
    ),
])

patch_file("skills/arc-plan/SKILL.md", [
    (
        "- Team preparation (teammate labels) is optional — only if user chooses team execution",
        "- `teammate:*` labels may be used as planning metadata, but Pi does not support Claude-style team deployment. Use `/arc-build` for orchestrated sequential work or independent `pi-subagents` parallel batches when available.",
    ),
])

patch_file("skills/arc-review/SKILL.md", [
    (
        "## Contexts\n\nThis skill works in both execution models:\n\n| Context | How review works |\n|---------|-----------------|\n| **Single-agent** | Main agent dispatches `code-reviewer` subagent |\n| **Team mode** | Team lead dispatches QA teammate or `code-reviewer` subagent |",
        "## Contexts\n\nThis skill works in orchestrated Arc execution:\n\n| Context | How review works |\n|---------|-----------------|\n| **Sequential build** | Main agent dispatches `code-reviewer` subagent after the coder reports completion |\n| **Parallel patch batch** | Main agent applies each accepted patch to the main worktree, then dispatches `code-reviewer` against the applied diff |",
    ),
])

patch_file("skills/arc-finish/SKILL.md", [
    (
        "| Session Type | Behavior |\n|-------------|----------|\n| **Single-agent** | Full protocol above |\n| **Team lead** | Verify teammate work → close arc issues → team cleanup → commit → push |\n| **Teammate** | Commit → push (team lead handles arc close and coordination) |",
        "| Session Type | Behavior |\n|-------------|----------|\n| **Single-agent** | Full protocol above |\n| **Parallel subagent patches** | Apply/review accepted patches → verify → close arc issues → commit → push |",
    ),
])

patch_file("skills/arc-build/SKILL.md", [
    (
        "Every arc_agent dispatch can override the subagent's frontmatter model via the `model:` parameter. Use this to match model tier to task complexity. The default floor per agent is set in frontmatter — use these overrides to downgrade for trivial tasks or escalate for complex ones.",
        "Every Arc subagent dispatch can override the subagent's frontmatter model via the `model:` parameter. Use this to match model tier to task complexity. The default floor per agent is set in frontmatter — use these overrides to downgrade for trivial tasks or escalate for complex ones.\n\nPrefer the `subagent` tool from `pi-subagents` when it is available **and** Arc agent definitions such as `arc-coder` are installed. If Arc specialist definitions are missing, run `/arc-subagents-sync` (project default) or `/arc-subagents-sync user`, then re-check with `subagent({ action: \"list\" })`. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; `pi-subagents` adds chains, async runs, and worktree-isolated parallel patch generation.",
    ),
    (
        "```text\narc_agent(agent=\"coder\", model=\"haiku\", task=\"...\")       # mechanical\narc_agent(agent=\"coder\", task=\"...\")                      # standard (sonnet)\narc_agent(agent=\"coder\", model=\"opus\", task=\"...\")        # complex\n```",
        "```text\n# Self-contained fallback:\narc_agent(agent=\"coder\", model=\"haiku\", task=\"...\")       # mechanical\narc_agent(agent=\"coder\", task=\"...\")                      # standard (sonnet)\narc_agent(agent=\"coder\", model=\"opus\", task=\"...\")        # complex\n\n# Preferred when pi-subagents Arc agents are installed:\nsubagent({ agent: \"arc-coder\", task: \"...\", model: \"haiku\", context: \"fresh\" })\nsubagent({ agent: \"arc-coder\", task: \"...\", context: \"fresh\" })\nsubagent({ agent: \"arc-coder\", task: \"...\", model: \"opus\", context: \"fresh\" })\n```",
    ),
    (
        "### Parallel\n\nMultiple tasks dispatched simultaneously using `isolation: \"worktree\"`. Use this **only** when ALL of these are true:\n- 3+ independent tasks remain\n- No shared files between any tasks in the batch\n- No `blocks`/`blockedBy` dependencies between tasks in the batch\n- Each task's scope is clearly defined with no ambiguity\n\n**When NOT to use parallel**: overlapping files, task dependencies, uncertainty about scope, fewer than 3 tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel merge is data loss.",
        "### Parallel\n\nParallel worktree dispatch is available **only** through the optional `pi-subagents` companion package, not through `arc_agent`. Use it only when ALL of these are true:\n- `pi-subagents` is installed and the `subagent` tool is available\n- Arc agent definitions such as `arc-coder` / `arc-doc-writer` are installed for `pi-subagents`\n- 3+ independent tasks remain, or one high-risk evaluator needs a disposable worktree\n- No shared files between any coder/doc-writer tasks in the batch\n- No `blocks`/`blockedBy` dependencies between tasks in the batch\n- Each task's scope is clearly defined with no ambiguity\n\n`pi-subagents` worktree mode returns per-task patch files and cleans up temporary worktrees. It does **not** automatically merge changes into the main working tree. The orchestrator must inspect, apply, verify, commit, and close each patch/task explicitly.\n\n**When NOT to use parallel**: missing `subagent` tool, missing Arc agent definitions, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel patch merge is data loss.",
    ),
    (
        "By default, use sequential dispatch. For independent tasks, see [Parallel Dispatch Protocol](#parallel-dispatch-protocol) below.",
        "By default, use sequential dispatch. For independent batches with `pi-subagents` available, see [Parallel Patch Protocol](#parallel-patch-protocol) below.",
    ),
    (
        "Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs-only work, the agent default (`haiku`) is correct — omit `model:` unless the docs task is unusually complex.\n\n**Otherwise** — spawn an `coder` subagent:\n\nUse the template at `./coder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.",
        "Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs-only work, the agent default (`haiku`) is correct — omit `model:` unless the docs task is unusually complex.\n\nDispatch preference:\n- If `subagent` is available and `arc-doc-writer` is installed: `subagent({ agent: \"arc-doc-writer\", task: \"<filled prompt>\", context: \"fresh\" })`\n- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: \"list\" })`, then retry.\n- Otherwise: `arc_agent(agent=\"doc-writer\", task=\"<filled prompt>\")`\n\n**Otherwise** — spawn an `coder` subagent:\n\nUse the template at `./coder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.\n\nDispatch preference:\n- If `subagent` is available and `arc-coder` is installed: `subagent({ agent: \"arc-coder\", task: \"<filled prompt>\", model: \"<tier-if-needed>\", context: \"fresh\" })`\n- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: \"list\" })`, then retry.\n- Otherwise: `arc_agent(agent=\"coder\", task=\"<filled prompt>\", model=\"<tier-if-needed>\")`",
    ),
    (
        "Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the agent default is appropriate; omit `model:` unless the spec is unusually large or ambiguous.",
        "Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.\n\nDispatch preference:\n- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: \"arc-spec-reviewer\", task: \"<filled prompt>\", model: \"openai-codex/gpt-5.3-codex\", context: \"fresh\" })`\n- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: \"list\" })`, then retry.\n- Otherwise: `arc_agent(agent=\"spec-reviewer\", task=\"<filled prompt>\")`\n\nDo **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled `arc_agent` fallback.",
    ),
    (
        "When dispatched, use `isolation: \"worktree\"` and the existing `evaluator` agent. The evaluator can run **in parallel with Step 6** (code quality review) since they examine orthogonal concerns:",
        "When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:\n\n```ts\nsubagent({\n  tasks: [\n    { agent: \"arc-evaluator\", task: \"<filled evaluator prompt>\", model: \"opus\" }\n  ],\n  worktree: true,\n  concurrency: 1,\n  context: \"fresh\"\n})\n```\n\nIf `pi-subagents` or `arc-evaluator` is not available, fall back to sequential `arc_agent(agent=\"evaluator\", model=\"opus\", task=\"<filled evaluator prompt>\")` and ensure the evaluator does not leave uncommitted artifacts in the main worktree.",
    ),
    (
        "When dispatching alongside the evaluator, update the code quality reviewer's `## Evaluator Status` to `active`.",
        "When you plan to run the evaluator, set the code quality reviewer's `## Evaluator Status` to `active`; otherwise set it to `not dispatched`.",
    ),
    (
        "## Parallel Dispatch Protocol\n\nWhen you have identified a batch of truly independent tasks (see [Dispatch Modes](#dispatch-modes)), switch from the sequential loop to this protocol:",
        "## Parallel Patch Protocol\n\nUse this protocol only with `pi-subagents` worktree mode. Do **not** use `arc_agent(isolation=\"worktree\")`; `arc_agent` intentionally remains sequential-only.",
    ),
    (
        "All parallel arc_agent tool calls with `isolation: \"worktree\"` **must happen in the same orchestrator message**. This ensures they all branch from the same HEAD.\n\n```\n# In a single response, dispatch all parallel tasks:\narc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 1...\")\narc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 2...\")\narc_agent(agent=\"coder\", isolation=\"worktree\", task=\"Task 3...\")\n```\n\n**Never** dispatch worktree agents across multiple turns — HEAD may move between turns, causing stale branches.",
        "Dispatch all parallel tasks in one `subagent` tool call so they branch from the same `PARALLEL_BASE`:\n\n```ts\nsubagent({\n  tasks: [\n    { agent: \"arc-coder\", task: \"<filled coder prompt for task 1>\", model: \"sonnet\" },\n    { agent: \"arc-coder\", task: \"<filled coder prompt for task 2>\", model: \"sonnet\" },\n    { agent: \"arc-doc-writer\", task: \"<filled doc-writer prompt for task 3>\", model: \"haiku\" }\n  ],\n  worktree: true,\n  concurrency: 3,\n  context: \"fresh\"\n})\n```\n\n`pi-subagents` returns diff stats and a `Full patches: <dir>` path. Temporary worktrees are cleaned up; the patches are the handoff artifact.",
    ),
    (
        "- Never proceed after parallel merge without verifying commit history against the recorded HEAD anchor",
        "- Never use parallel patch mode unless `pi-subagents` and Arc `pi-subagents` agent definitions are available\n- Never apply more than one parallel patch at a time; apply, verify, review, commit, and close each task independently\n- Never proceed after a parallel patch batch without verifying commit history against the recorded HEAD anchor",
    ),
])


# The replacement above adjusts the dispatch example, but the original Claude
# protocol still describes automatic worktree merge semantics. Pi-subagents
# returns patch files instead, so replace the whole protocol body.
if "skills/arc-build/SKILL.md" not in PRESERVED_OVERLAY_SET:
    build_path = ARC_ROOT / "skills" / "arc-build" / "SKILL.md"
    text = build_path.read_text()
    start = text.index("## Parallel Patch Protocol")
    end = text.index("\n## When to Invoke Debug", start)
    text = text[:start] + """## Parallel Patch Protocol

Use this protocol only with `pi-subagents` worktree mode. Do **not** use `arc_agent(isolation=\"worktree\")`; `arc_agent` intentionally remains sequential-only.

### P1. Commit Checkpoint

Before switching to parallel, ensure all sequential work is committed and pushed:

```bash
git status          # Must be clean — no unstaged or uncommitted changes
git log -3          # Verify recent sequential commits are present
git push            # Establish a recovery point on the remote
```

**Hard gate**: Do NOT proceed if `git status` shows uncommitted changes.

### P2. Record HEAD Anchor

```bash
PARALLEL_BASE=$(git rev-parse HEAD)
echo \"Parallel base: $PARALLEL_BASE\"
```

This is the baseline all temporary worktrees will branch from. Record it — you'll need it for verification after patch application.

### P3. Verify Independence

For each task in the planned parallel batch:

```bash
arc show <task-id>
```

Confirm:
- No `blocks`/`blockedBy` relationships between tasks in this batch
- No overlapping file paths in task descriptions
- Each task has a clearly scoped, non-ambiguous specification
- Each task can be validated independently after its patch is applied

If any task fails these checks, remove it from the parallel batch and handle it sequentially after.

### P4. Dispatch with `pi-subagents`

Dispatch all parallel tasks in one `subagent` tool call so they branch from the same `PARALLEL_BASE`:

```ts
subagent({
  tasks: [
    { agent: \"arc-coder\", task: \"<filled coder prompt for task 1>\", model: \"openai-codex/gpt-5.3-codex\" },
    { agent: \"arc-coder\", task: \"<filled coder prompt for task 2>\", model: \"openai-codex/gpt-5.3-codex\" },
    { agent: \"arc-doc-writer\", task: \"<filled doc-writer prompt for task 3>\", model: \"openai-codex/gpt-5.4-mini\" }
  ],
  worktree: true,
  concurrency: 3,
  context: \"fresh\",
  async: true,
  clarify: false
})
```

When the async run completes, `pi-subagents` returns diff stats and a `Full patches: <dir>` path. Temporary worktrees are cleaned up; the patches are the handoff artifact.

### P5. Apply and Verify Patches One at a Time

For each returned patch:

```bash
git status --short                    # Must be clean before applying each patch
git apply --3way <patch-file>          # Apply one patch
git diff --stat                       # Inspect applied changes
```

Then run that task through the normal post-implementation gates:
1. Fresh project/task tests — do not trust the subagent report alone.
2. Spec compliance review.
3. Code quality review.
4. Optional high-risk evaluator.
5. Commit the accepted patch.
6. Close the corresponding arc issue.

If a patch fails to apply cleanly or verification fails:
- Do not close the task.
- Revert the partial application (`git apply -R` if possible, or reset with user approval if needed).
- Re-dispatch that task sequentially with the failure details.

### P6. Batch-Level Verification

After all accepted patches are applied and committed, verify the batch:

```bash
# 1. Check work since the recorded anchor
git log --oneline $PARALLEL_BASE..HEAD

# 2. Verify prior sequential commits are still in history
git log --oneline HEAD | head -20

# 3. Run full test suite
make test    # or project-specific test command
```

**If sequential commits are missing** → STOP. Do not continue. Recover from reflog:

```bash
git reflog
git log --oneline <reflog-ref>
# Cherry-pick or reset as appropriate — ask user if unsure
```

### P7. Resume Sequential

After successful verification, return to the normal orchestration loop (step 1) for any remaining tasks.\n""" + text[end:]
    build_path.write_text(text)

# Preserve Pi-native model tier and async pi-subagents guidance that differs from
# the Claude plugin's haiku/sonnet/opus synchronous Agent examples.
replace_section("skills/arc-build/SKILL.md", "## Model Selection\n\n", "\n## Dispatch Modes", """## Model Selection

Every Arc subagent dispatch can override the subagent's frontmatter model via the `model:` parameter. Before dispatching, assess the task size/risk and choose the smallest model tier that is likely to succeed. The default floor per agent is set in frontmatter — use overrides to downgrade trivial tasks or escalate complex/high-risk tasks.

`arc_agent` resolves Arc model tiers through `arc.modelTiers` in Pi settings. Defaults are:

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.4-mini` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.4-mini` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.3-codex` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.5` | Cross-cutting, architectural, security-sensitive, or adversarial review |

Users can override the tier map in `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "arc": {
    "modelTiers": {
      "nano": "openai-codex/gpt-5.4-mini",
      "small": "openai-codex/gpt-5.4-mini",
      "standard": "openai-codex/gpt-5.3-codex",
      "large": "openai-codex/gpt-5.5"
    }
  }
}
```

Legacy aliases still resolve for compatibility: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. Prefer the Pi-native tier names in new prompts, including `nano` for low-reasoning issue-manager work.

Prefer the `subagent` tool from `pi-subagents` when it is available **and** Arc agent definitions such as `arc-coder` are installed. If Arc specialist definitions are missing, run `/arc-subagents-sync` (project default) or `/arc-subagents-sync user`, then re-check with `subagent({ action: "list" })`. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; `pi-subagents` adds chains, async runs, and worktree-isolated parallel patch generation.

**Status visibility:** For long Arc workers after `/arc-plan`, prefer `pi-subagents` launches with `async: true, clarify: false`. The returned run appears in `/subagents-status`; you can also poll it with `subagent({ action: "status", id: "<run-id>" })`. Do not continue to validation, review, patch application, or arc closure until the async run is terminal and you have read its final output. The raw `arc_agent` fallback never appears in `/subagents-status`.

| Task signal | Dispatch `model:` |
|---|---|
| Bulk issue creation or other low-reasoning Arc CLI operations | `nano` |
| Mechanical: 1-2 files, spec unambiguous, no cross-cutting concerns | `small` |
| Standard: integration work, multi-file but contained, unambiguous | omit `model:` (use agent default) or `standard` |
| Complex: 3+ files, cross-layer, design judgment required, migrations, breaking changes | `large` |
| Re-dispatch after `BLOCKED` | escalate one tier (`nano` → `small` → `standard` → `large`); stop at `large` |
| Re-dispatch after `NEEDS_CONTEXT` | same tier, richer context |

Examples:

```text
# Self-contained fallback:
arc_agent(agent="coder", model="small", task="...")       # mechanical
arc_agent(agent="coder", task="...")                      # standard default
arc_agent(agent="coder", model="large", task="...")       # complex

# Preferred when pi-subagents Arc agents are installed:
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.4-mini", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.5", context: "fresh", async: true, clarify: false })
```

**When unsure, omit `model:`** — the agent's frontmatter floor is calibrated for the typical case.

**Escalation rule:** If a subagent returns `BLOCKED` with a reasoning or capability complaint, re-dispatch with the next tier up before asking the human. Stop escalating at `large` — if `large` also returns `BLOCKED`, escalate to the human with the subagent's blocker summary.
""")

replace_section("skills/arc-build/SKILL.md", "### 3. Dispatch Agent\n\n", "\n### 4. Evaluate Result", """### 3. Dispatch Agent

Record the current HEAD before dispatching — needed for review if escalated:

```bash
PRE_TASK_SHA=$(git rev-parse HEAD)
```

Resolve executor from issue labels:

```bash
arc show <task-id> --json | jq -r '.labels[]' | grep '^executor:'
```

Routing contract:
- exactly one `executor:coder` → `coder`
- exactly one `executor:devops` → `devops`
- exactly one `executor:docs` → `doc-writer`
- zero executor labels + old `docs-only` label → `doc-writer` (legacy fallback)
- zero executor labels + no `docs-only` label → `coder` (legacy fallback)
- multiple or unknown executor labels → stop and require issue correction before dispatch

If executor resolution fails, do not dispatch. Add an arc comment describing the invalid labels and request correction.

**If resolved executor is `doc-writer`** — spawn a `doc-writer` subagent:

Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs work, the agent default (`small`) is correct — omit `model:` unless the docs task is unusually complex.

Dispatch preference:
- If `subagent` is available and `arc-doc-writer` is installed: `subagent({ agent: "arc-doc-writer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="doc-writer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**If resolved executor is `devops`** — spawn a `devops` subagent:

Use the task spec directly and include evidence expectations in the prompt (changed files, command output, logs/runbook/config proof, and rollback notes when applicable).

Dispatch preference:
- If `subagent` is available and `arc-devops` is installed: `subagent({ agent: "arc-devops", task: "<task spec and evidence instructions>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="devops", task="<task spec and evidence instructions>")`

Devops tasks may legitimately finish as evidence-only with no commit when no repository files changed. Treat command output and operational evidence as the deliverable in that case.

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**If resolved executor is `coder`** — spawn a `coder` subagent:

Use the template at `./coder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.

Dispatch preference:
- If `subagent` is available and `arc-coder` is installed: `subagent({ agent: "arc-coder", task: "<filled prompt>", model: "<concrete-model-if-needed>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="coder", task="<filled prompt>", model="<tier-if-needed>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.
""")

replace_section("skills/arc-build/SKILL.md", "Dispatch `spec-reviewer`:\n\n", "\nHandle results:", """Dispatch `spec-reviewer`:

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: "list" })`, then retry.
- Otherwise: `arc_agent(agent="spec-reviewer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before handling compliance results.

Do **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled `arc_agent` fallback.
""")

replace_section("skills/arc-build/SKILL.md", "When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run.", "\nTriage evaluator findings:", """When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:

```ts
subagent({
  tasks: [
    { agent: "arc-evaluator", task: "<filled evaluator prompt>", model: "openai-codex/gpt-5.5" }
  ],
  worktree: true,
  concurrency: 1,
  context: "fresh",
  async: true,
  clarify: false
})
```

If `pi-subagents` or `arc-evaluator` is not available, fall back to sequential `arc_agent(agent="evaluator", model="large", task="<filled evaluator prompt>")` and ensure the evaluator does not leave uncommitted artifacts in the main worktree.

```bash
PARENT=$(arc show <task-id> --json | jq -r '.parent_id // empty')
```

Use the template at `./evaluator-prompt.md`. Fill placeholder `{TASK_ID}`. Because evaluation is adversarial verification on high-risk tasks, escalate one tier from the agent default (typically to `large`) — set `model: "large"` on `arc_agent` dispatches unless the task is narrow. For `pi-subagents`, pass the concrete configured large model.

When you plan to run the evaluator, set the code quality reviewer's `## Evaluator Status` to `active`; otherwise set it to `not dispatched`.
""")

patch_file("skills/arc-build/SKILL.md", [
    (
        "Create a the bundled `todo` checklist (via `todo` tool / `/todos`) entry for each, then work through this loop:",
        "Create a `todo` checklist entry for each, then work through this loop:",
    ),
    (
        "Escalate one model tier (haiku → sonnet → opus) per the Model Selection escalation rule",
        "Escalate one model tier (`nano` → `small` → `standard` → `large`) per the Model Selection escalation rule",
    ),
    (
        "Follow Model Selection above for the dispatch `model:` — sonnet default is appropriate for most reviews.",
        "Follow Model Selection above for the dispatch `model:` — `standard` default is appropriate for most reviews.",
    ),
])

patch_file("skills/arc-brainstorm/SKILL.md", [
    (
        "Approaches with more cross-cutting concerns, more files touched, or tighter coupling between components will likely need `opus`-tier dispatches and more review cycles. Approaches that decompose cleanly into single-file, mechanical tasks will run on `haiku`/`sonnet` and iterate faster.",
        "Approaches with more cross-cutting concerns, more files touched, or tighter coupling between components will likely need `large`-tier dispatches and more review cycles. Approaches that decompose cleanly into single-file, mechanical tasks will run on `small`/`standard` and iterate faster.",
    ),
])

patch_file("skills/arc-plan/SKILL.md", [
    (
        "**Model tier:** `issue-manager` defaults to `haiku` — the right tier for CLI formatting and bulk issue creation. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
        "**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
    ),
    (
        "The share keyring entries have `{id, kind, url, key_b64url, plan_file, created_at}` — edit tokens are intentionally redacted. Then dispatch the manifest:\n\n```\nUse the arc_agent tool with agent=\"issue-manager\":\n\nCreate the following epic and tasks.",
        "The share keyring entries have `{id, kind, url, key_b64url, plan_file, created_at}` — edit tokens are intentionally redacted. Then dispatch the manifest. Prefer true `pi-subagents` so long issue-creation runs are visible in `/subagents-status`:\n\nDispatch preference (use **async** so long-running issue creation appears in `/subagents-status`):\n- Primary: `subagent({ agent: \"arc-issue-manager\", task: \"<manifest below>\", context: \"fresh\", async: true, clarify: false })`\n- After launching async, **wait for terminal status** by polling `subagent({ action: \"status\", id: \"<run-id>\" })` until status is `completed` or `failed`\n- Users can monitor progress via `/subagents-status` during the async run\n- If `subagent({ action: \"list\" })` shows `arc-issue-manager`, do **not** use the slower `arc_agent(agent=\"issue-manager\")` fallback for bulk issue creation\n- If `subagent` unavailable or `arc-issue-manager` missing: run `/arc-subagents-sync`, then `subagent({ action: \"list\" })` to verify, then retry primary\n- Fallback only if `pi-subagents` is not installed or cannot load after sync: `arc_agent(agent=\"issue-manager\", task=\"<manifest below>\")`\n\nUse this task payload for whichever dispatcher you choose:\n\n```markdown\nCreate the following epic and tasks.",
    ),
])

replace_section("skills/arc-review/SKILL.md", "### 3. Dispatch Reviewer\n\n", "\n### 4. Triage Feedback", """### 3. Dispatch Reviewer

Fill the template at `./code-reviewer-prompt.md` with the gathered placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESIGN_EXCERPT}`, `{EVALUATOR_STATUS}`). Prefer true `pi-subagents` so longer reviews are visible in `/subagents-status`:

Dispatch preference (use **async** so longer reviews appear in `/subagents-status`):
- Primary: `subagent({ agent: "arc-code-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- After launching async, **wait for terminal status** by polling `subagent({ action: "status", id: "<run-id>" })` until status is `completed` or `failed`
- Users can monitor review progress via `/subagents-status` during the async run
- If `subagent` unavailable or `arc-code-reviewer` missing: run `/arc-subagents-sync`, then `subagent({ action: "list" })` to verify, then retry primary
- Fallback only if `pi-subagents` is not installed: `arc_agent(agent="code-reviewer", task="<filled prompt>")`

**Model tier:** Follow the Model Selection table in `../arc-build/SKILL.md`. For most reviews, omit `model:` (use the agent's `standard` default). Escalate to `large` when the diff is large (10+ files), crosses multiple architectural layers, or involves security-sensitive changes. For `pi-subagents`, pass the configured concrete large model only when escalating.
""")


# Copy agents as bundled prompts for arc_agent.
for f in sorted((SRC / "agents").glob("*.md")):
    text = transform_text(f.read_text())
    dest_name = "coder.md" if f.name == "builder.md" else f.name
    text = text.replace("  - Bash", "  - bash")
    text = text.replace("  - Read", "  - read")
    text = text.replace("  - Write", "  - write")
    text = text.replace("  - Edit", "  - edit")
    text = text.replace("  - Glob", "  - find")
    text = text.replace("  - Grep", "  - grep")
    text = re.sub(r"(?m)^model:\s*haiku\s*$", "model: small", text)
    text = re.sub(r"(?m)^model:\s*sonnet\s*$", "model: standard", text)
    text = re.sub(r"(?m)^model:\s*opus\s*$", "model: large", text)
    if f.name == "issue-manager.md":
        text = re.sub(r"(?m)^model:\s*small\s*$", "model: nano", text)
        if "## Timing / Progress Instrumentation" not in text:
            text = text.replace(
                "## Creating Epics with Tasks",
                "## Timing / Progress Instrumentation\n\nFor bulk operations, print lightweight progress lines before and after each phase so the dispatcher can tell whether time is spent in the model or in the Arc CLI:\n\n```bash\nSTART_MS=$(node -e 'console.log(Date.now())')\necho \"[arc-issue-manager] phase=child_tasks status=start\"\n# phase commands here\nEND_MS=$(node -e 'console.log(Date.now())')\necho \"[arc-issue-manager] phase=child_tasks status=done elapsed_ms=$((END_MS-START_MS))\"\n```\n\nUse phase names such as `epic`, `child_tasks`, `dependencies`, `labels`, and `verification`. Include a final `## Timing` section in the summary with per-phase `elapsed_ms` values when available. This instrumentation is informational only; do not add sleeps, polling loops, or extra verification that the manifest did not request.\n\n## Creating Epics with Tasks",
            )
    (ARC_ROOT / "agents" / dest_name).write_text(text)

# Restore Pi-preserved overlays after upstream resource migration.
for rel, text in overlay_text_by_rel.items():
    target = ARC_ROOT / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)

# Upstream still ships builder prompt names; Pi canonical name is coder-prompt.
builder_prompt_path = ARC_ROOT / "skills" / "arc-build" / "builder-prompt.md"
if builder_prompt_path.exists():
    builder_prompt_path.unlink()

# Final Pi-native overlays for Claude-source changes that need adaptation or
# preservation of Pi-only behavior. Keep these near the end so they override
# the mechanical source transform and remain reproducible on the next sync.
def insert_before_if_missing(rel: str, marker: str, insertion: str, sentinel: str) -> None:
    path = ARC_ROOT / rel
    text = path.read_text()
    if sentinel in text:
        return
    idx = text.index(marker)
    path.write_text(text[:idx] + insertion + text[idx:])


patch_file("skills/arc/_branch-check.md", [
    (
        "3. If the result **is** protected, check the project's `CLAUDE.md` (or `AGENTS.md`) for an explicit opt-out — a line like *\"This project commits directly to main; skip the protected-branch check.\"* If present, you're done — proceed without prompting. (The project owner has consciously chosen trunk-based development.)\n\n4. Otherwise, use the ``ask_user_question`` tool with this exact shape — the wording matters because Pi has to recognise the branching choice and act on it:",
        "3. If the result **is** protected, check the project's `AGENTS.md` (or legacy `CLAUDE.md`) for an explicit opt-out — a line like *\"This project commits directly to main; skip the protected-branch check.\"* If present, you're done — proceed without prompting. (The project owner has consciously chosen trunk-based development.)\n\n4. Otherwise, use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool with the package `questions[]` schema. Do not manually author package sentinel labels (`Type something.`, `Chat about this`, `Other`, `Next`); the package appends its own escape hatches where supported. Use this exact choice shape — the wording matters because the agent has to recognise the branching choice and act on it:",
    ),
    (
        "Earlier drafts had `ARC_MAIN_GUARD=off` and a bypass-token prefix. Both removed: this is a skill-level prompt, not a hook. The opt-out lives in `CLAUDE.md` so it's discoverable, version-controlled, and applies project-wide. If the user is annoyed by the prompt, the right answer is to add the `CLAUDE.md` line — not to teach Pi to skip the check on its own initiative.",
        "Earlier drafts had `ARC_MAIN_GUARD=off` and a bypass-token prefix. Both removed: this is a skill-level prompt, not a hook. The opt-out lives in `AGENTS.md` (or legacy `CLAUDE.md`) so it's discoverable, version-controlled, and applies project-wide. If the user is annoyed by the prompt, the right answer is to add the project instruction line — not to teach the agent to skip the check on its own initiative.",
    ),
    (
        "- Not a hook — there's no harness-level enforcement. If Pi skips this check, the user will only notice at PR time. The pre-flight placement (brainstorm + build) is the mitigation.",
        "- Not a hook — there's no harness-level enforcement. If the agent skips this check, the user will only notice at PR time. The pre-flight placement (brainstorm + build) is the mitigation.",
    ),
])

patch_file("skills/arc/SKILL.md", [
    (
        "- **Parallel Arc build**: For independent task batches, `implement` can use worktree-isolated `pi-subagents` runs when that companion package and Arc agent definitions are available. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
        "- **Parallel Arc build**: For independent task batches, `implement` can use worktree-isolated `pi-subagents` runs when an external `pi-subagents` extension/tool is installed and Arc specialist definitions are available. Custom Arc specialists remain the preferred `pi-subagents` targets, and generic `worker`/`reviewer` agents should not be substituted for Arc gates. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
    ),
])

patch_file("skills/arc-brainstorm/SKILL.md", [
    (
        "- Ask questions **one at a time** — don't dump a list\n- **Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool** for structured decisions using the package `questions[]` schema\n- Use open-ended text questions only when you need freeform feedback\n- Understand: purpose, constraints, success criteria, target users\n- Continue until you have enough to propose approaches",
        "- Ask questions **one at a time** — don't dump a list\n- Use open-ended text questions only when you need freeform feedback\n- Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool for structured decisions with 2-4 authored options per question.\n- Ask one conceptual decision at a time, but when several related structured decisions are already known, group them in one `ask_user_question` invocation using `questions[]`.\n- Do not manually author package sentinel labels (`Type something.`, `Chat about this`, `Other`, `Next`); the package appends its own escape hatches where supported.\n- Where a recommendation is clear, make it the first option, append `(Recommended)` to the label, and explain why in the description.\n- Understand: purpose, constraints, success criteria, target users\n- Continue until you have enough to propose approaches",
    ),
    (
        "**Example `ask_user_question` usage:**\n```\nQuestion: \"How should we handle session persistence?\"\nOptions:\n  - \"In-memory only\" (simplest, lost on restart)\n  - \"SQLite\" (persistent, single-node, matches existing storage)\n  - \"Redis\" (distributed, adds infrastructure dependency)\n```",
        "**Example `ask_user_question` usage:**\n```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Session\",\n      \"question\": \"How should we handle session persistence?\",\n      \"options\": [\n        {\n          \"label\": \"SQLite (Recommended)\",\n          \"description\": \"Persistent, single-node, matches existing storage, and avoids new infrastructure.\"\n        },\n        {\n          \"label\": \"In-memory only\",\n          \"description\": \"Simplest option, but sessions are lost on restart.\"\n        },\n        {\n          \"label\": \"Redis\",\n          \"description\": \"Supports distributed deployments, but adds an infrastructure dependency.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "**Example `ask_user_question` usage:**\n```\nQuestion: \"Which approach should we go with?\"\nOptions:\n  - \"Approach A: ...\" (recommended — trade-offs...)\n  - \"Approach B: ...\" (trade-offs...)\n  - \"Approach C: ...\" (trade-offs...)\n```",
        "**Example `ask_user_question` usage:**\n```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Approach\",\n      \"question\": \"Which approach should we go with?\",\n      \"options\": [\n        {\n          \"label\": \"Approach A (Recommended)\",\n          \"description\": \"Best balance of scope, risk, and implementation speed for the current constraints.\"\n        },\n        {\n          \"label\": \"Approach B\",\n          \"description\": \"Lower short-term code churn, but leaves more long-term maintenance risk.\"\n        },\n        {\n          \"label\": \"Approach C\",\n          \"description\": \"Most flexible, but likely needs larger-model implementation and more review cycles.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "If the design will produce multiple implementation tasks that could run in parallel, explicitly identify the **shared contracts** — types, interfaces, config keys, constants, and function signatures that multiple tasks will reference.\n\nContracts fall into two tiers:",
        "If the design can produce independent implementation tasks, the brainstorm output must include a `## Parallel Readiness` section **before** `/arc-plan` creates Arc issues. Use these exact subsection headings:\n\n```markdown\n## Parallel Readiness\n\n### T0 Foundation Decision\n\n### File Ownership Matrix\n\n### Parallel Batch Manifest\n\n### Validation Matrix\n```\n\n- `T0 Foundation Decision` records the sequential foundation step that must land first when multiple tasks depend on the same shared contracts.\n- `File Ownership Matrix` assigns every implementation file to exactly one task. Any overlap must be moved to T0, serialized with dependencies, or merged into one task.\n- `Parallel Batch Manifest` lists the batches, their prerequisites, the tasks in each batch, the independence proof, and the validation.\n- `Validation Matrix` shows which checks prove each batch or task is safe to merge.\n\nContracts fall into two tiers:",
    ),
    (
        "```\nQuestion: \"Stress-test the design before publishing?\"\nOptions:\n  - \"Yes, grill me\" — interrogate decisions one at a time until we converge\n  - \"No, proceed\" — skip to step 6 register for review\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Grill\",\n      \"question\": \"Stress-test the design before publishing?\",\n      \"options\": [\n        {\n          \"label\": \"Yes, grill me (Recommended)\",\n          \"description\": \"Interrogate decisions one at a time until the design converges; recommended for medium/large work or when clarifying questions were skipped.\"\n        },\n        {\n          \"label\": \"No, proceed\",\n          \"description\": \"Skip the stress-test and register the saved design for review now.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "```\nQuestion: \"How would you like to review this design?\"\nOptions:\n  - \"Legacy planner (solo, plain HTTP, simplest)\" —\n      `arc plan` surface at /planner/<id>. No encryption, no accept-resolve;\n      just a comment thread on a markdown render. Best when you want quick\n      review notes without setting up the share UI.\n  - \"Encrypted local share (solo, but want annotations/accept-resolve)\" —\n      `arc share` on this machine. Plan content + comments are encrypted at\n      rest in ~/.arc/data.db. Reviewer URL only works from this machine.\n  - \"Encrypted remote share (multiple reviewers)\" —\n      `arc share` on the configured remote server (default arcplanner.sentiolabs.io).\n      Reviewers on other machines can open the link.\n  - \"Save for later\" — keep the saved file (from step 5.5) and stop. No\n      server registration; resume in a new session. **Terminates the\n      skill — skip steps 7 and 8.**\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Review\",\n      \"question\": \"How would you like to review this design?\",\n      \"options\": [\n        {\n          \"label\": \"Legacy planner\",\n          \"description\": \"Solo plain-HTTP review at /planner/<id>; simplest, with no encryption or accept/resolve UI.\"\n        },\n        {\n          \"label\": \"Encrypted local\",\n          \"description\": \"Solo encrypted review with annotations and accept/resolve UI on this machine only.\"\n        },\n        {\n          \"label\": \"Encrypted remote\",\n          \"description\": \"Multiple reviewers can open the remote encrypted share; the author URL must stay private.\"\n        },\n        {\n          \"label\": \"Save for later\",\n          \"description\": \"Keep the saved design file and stop without server registration; resume in a new session.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "```\nQuestion: \"Design ready for review at <url> — how would you like to proceed?\"\nOptions:\n  - \"Approve\" — mark the design approved and proceed to step 8\n      routing analysis\n  - \"I've finished review (pull comments now)\" — fetch reviewer feedback,\n      apply edits, re-share if needed, repeat\n  - \"Pause review\" — design is saved; resume in a new session\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Review\",\n      \"question\": \"Design ready for review at <url> — how would you like to proceed?\",\n      \"options\": [\n        {\n          \"label\": \"Approve\",\n          \"description\": \"Mark the design approved and continue to routing analysis.\"\n        },\n        {\n          \"label\": \"I've finished review (pull comments now)\",\n          \"description\": \"Fetch accepted reviewer feedback, apply edits, update the review surface if needed, and repeat review.\"\n        },\n        {\n          \"label\": \"Pause review\",\n          \"description\": \"Leave the design saved in docs/plans and resume in a future session.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "```\nQuestion: \"Design approved! What's next?\"\nOptions:\n  - \"Break into tasks with /arc-plan\" (recommended — <brief reason from analysis>)\n  - \"Implement directly with /arc-build\" (for small, single-task work)\n  - \"Done for now\" (design is saved — continue in a new session)\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Next\",\n      \"question\": \"Design approved! What's next?\",\n      \"options\": [\n        {\n          \"label\": \"Break into tasks (Recommended)\",\n          \"description\": \"Recommended when the design has multiple work items, shared contracts, multiple layers, migrations, breaking changes, or medium/large scale.\"\n        },\n        {\n          \"label\": \"Implement directly\",\n          \"description\": \"Use only for small designs with one work item, one layer, no shared contracts, and no risk areas.\"\n        },\n        {\n          \"label\": \"Done for now\",\n          \"description\": \"The design is approved and saved; continue with /arc-plan in a future session.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
])

replace_section("skills/arc-build/SKILL.md", "## Model Selection\n\n", "\n## Dispatch Modes", """## Model Selection

Every Arc subagent dispatch can override the subagent's frontmatter model via the `model:` parameter. `modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json` are the preferred way to choose role-specific models, and `arc.modelTiers` is a legacy fallback for older setups. Before dispatching, assess the task size/risk and choose the smallest model tier that is likely to succeed. The default floor per agent is set in frontmatter — use overrides to downgrade trivial tasks or escalate complex/high-risk tasks.

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.4-mini` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.4-mini` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.3-codex` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.5` | Cross-cutting, architectural, security-sensitive, or adversarial review |

```markdown
Arc model selection resolves in this order:

1. explicit dispatch `model:` override;
2. configured `modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json`;
3. legacy `arc.modelTiers` from Pi settings;
4. package defaults.

Users should run `/arc-models` to configure role-specific models. Keep `arc.modelTiers` documented only as a compatibility fallback for older setups.
```

Legacy fallback settings can still override the tier map in `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "arc": {
    "modelTiers": {
      "nano": "openai-codex/gpt-5.4-mini",
      "small": "openai-codex/gpt-5.4-mini",
      "standard": "openai-codex/gpt-5.3-codex",
      "large": "openai-codex/gpt-5.5"
    }
  }
}
```

Legacy aliases still resolve for compatibility: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. Prefer the Pi-native tier names in new prompts, including `nano` for low-reasoning issue-manager work.

Arc specialists should be auto-materialized by the Arc extension when `pi-subagents` is installed. If `subagent({ action: "list" })` does not show `arc-coder` or another required specialist, first run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; an external `pi-subagents` install adds chains, async runs, and worktree-isolated parallel patch generation.

**Status visibility:** For long Arc workers after `/arc-plan`, prefer `pi-subagents` launches with `async: true, clarify: false`. The returned run appears in `/subagents-status`; you can also poll it with `subagent({ action: "status", id: "<run-id>" })`. Do not continue to validation, review, patch application, or arc closure until the async run is terminal and you have read its final output. The raw `arc_agent` fallback never appears in `/subagents-status`.

| Task signal | Dispatch `model:` |
|---|---|
| Bulk issue creation or other low-reasoning Arc CLI operations | `nano` |
| Mechanical: 1-2 files, spec unambiguous, no cross-cutting concerns | `small` |
| Standard: integration work, multi-file but contained, unambiguous | omit `model:` (use agent default) or `standard` |
| Complex: 3+ files, cross-layer, design judgment required, migrations, breaking changes | `large` |
| Re-dispatch after `BLOCKED` | escalate one tier (`nano` → `small` → `standard` → `large`); stop at `large` |
| Re-dispatch after `NEEDS_CONTEXT` | same tier, richer context |

Examples:

```text
# Self-contained fallback:
arc_agent(agent="coder", model="small", task="...")       # mechanical
arc_agent(agent="coder", task="...")                      # standard default
arc_agent(agent="coder", model="large", task="...")       # complex

# Preferred when pi-subagents Arc agents are installed:
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.4-mini", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-coder", task: "...", model: "openai-codex/gpt-5.5", context: "fresh", async: true, clarify: false })
```

**When unsure, omit `model:`** — the agent's frontmatter floor is calibrated for the typical case.

**Escalation rule:** If a subagent returns `BLOCKED` with a reasoning or capability complaint, re-dispatch with the next tier up before asking the human. Stop escalating at `large` — if `large` also returns `BLOCKED`, escalate to the human with the subagent's blocker summary.
""")

replace_section("skills/arc-build/SKILL.md", "## Dispatch Modes\n\n", "\n### 1. Find Next Task", """## Dispatch Modes

Choose the manifest-driven parallel path first; if the batch is not ready, fall back to sequential dispatch.

### Parallel (plan-driven)

If the plan includes a `### Parallel Batch Manifest`, read it first. Select a batch only when all prerequisites are complete and the gates below pass. When the batch is ready, use [Parallel Patch Protocol](#parallel-patch-protocol) below.

### Sequential (default)

Tasks are dispatched one at a time through the orchestration loop below. Use this for:
- Most workflows — it's the safe default
- Tasks with any file overlap
- Tasks with dependency ordering (`blocks`/`blockedBy`)
- When you're unsure whether tasks are independent

### Parallel

Parallel worktree dispatch is available **only** through an installed `pi-subagents` extension/tool, not through `arc_agent`. Use it only when ALL of these are true:
- `pi-subagents` loaded and the `subagent` tool is available
- Arc agent definitions such as `arc-coder` / `arc-devops` / `arc-doc-writer` are auto-materialized for `pi-subagents`
- 3+ independent tasks remain, or one high-risk evaluator needs a disposable worktree
- No shared files or operational targets between any coder/devops/doc-writer tasks in the batch
- No `blocks`/`blockedBy` dependencies between tasks in the batch
- Do not parallelize live devops operations; live operations require sequential orchestration even when labels/dependencies look independent
- Each task's scope is clearly defined with no ambiguity

`pi-subagents` worktree mode returns per-task patch files and cleans up temporary worktrees. It does **not** automatically merge changes into the main working tree. The orchestrator must inspect, apply, verify, commit, and close each patch/task explicitly.

**When NOT to use parallel**: missing `subagent` tool, missing Arc agent definitions, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel patch merge is data loss.

## Orchestration Loop

Start here by checking whether the plan's `Parallel Batch Manifest` can be dispatched in parallel.

### 0. Choose Dispatch Mode

Inspect the plan's `Parallel Batch Manifest` first. If it yields a ready batch and the gates below pass, dispatch that batch through [Parallel Patch Protocol](#parallel-patch-protocol). Otherwise, continue with sequential dispatch.

**Task tracking**: At the start of implementation, create a task list using the bundled `todo` checklist (via `todo` tool / `/todos`) with one entry per arc issue to implement. This provides a visible progress tracker in the CLI. Update each task as you work:
- `in_progress` when dispatching the subagent
- `completed` when the task is closed in arc

```bash
# Get the list of tasks to implement
arc list --parent=<epic-id> --status=open --json
```

Create a `todo` checklist entry for each, then work through this loop:
""")

replace_section("skills/arc-build/SKILL.md", "### 3. Dispatch Agent\n\n", "\n### 4. Evaluate Result", """### 3. Dispatch Agent

Record the current HEAD before dispatching — needed for review if escalated:

```bash
PRE_TASK_SHA=$(git rev-parse HEAD)
```

Resolve executor from issue labels:

```bash
arc show <task-id> --json | jq -r '.labels[]' | grep '^executor:'
```

Routing contract:
- exactly one `executor:coder` → `coder`
- exactly one `executor:devops` → `devops`
- exactly one `executor:docs` → `doc-writer`
- zero executor labels + old `docs-only` label → `doc-writer` (legacy fallback)
- zero executor labels + no `docs-only` label → `coder` (legacy fallback)
- multiple or unknown executor labels → stop and require issue correction before dispatch

If executor resolution fails, do not dispatch. Add an arc comment describing the invalid labels and request correction.

**If resolved executor is `doc-writer`** — spawn a `doc-writer` subagent:

Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs work, the agent default (`small`) is correct — omit `model:` unless the docs task is unusually complex.

Dispatch preference:
- If `subagent` is available and `arc-doc-writer` is installed: `subagent({ agent: "arc-doc-writer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="doc-writer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**If resolved executor is `devops`** — spawn a `devops` subagent:

Use the task spec directly and include evidence expectations in the prompt (changed files, command output, logs/runbook/config proof, and rollback notes when applicable).

Dispatch preference:
- If `subagent` is available and `arc-devops` is installed: `subagent({ agent: "arc-devops", task: "<task spec and evidence instructions>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="devops", task="<task spec and evidence instructions>")`

Devops tasks may legitimately finish as evidence-only with no commit when no repository files changed. Treat command output and operational evidence as the deliverable in that case.

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**If resolved executor is `coder`** — spawn a `coder` subagent:

Use the template at `./coder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.

Dispatch preference:
- If `subagent` is available and `arc-coder` is installed: `subagent({ agent: "arc-coder", task: "<filled prompt>", model: "<concrete-model-if-needed>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="coder", task="<filled prompt>", model="<tier-if-needed>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.
""")

replace_section("skills/arc-build/SKILL.md", "Dispatch `spec-reviewer`:\n\n", "\nHandle results:", """Dispatch `spec-reviewer`:

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="spec-reviewer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before handling compliance results.

Do **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled sequential `arc_agent` fallback.
""")

patch_file("skills/arc-build/SKILL.md", [
    (
        "Orchestrate task implementation by dispatching fresh `coder` subagents per task. Each subagent gets a clean context window with just the task description.",
        "Orchestrate task implementation by dispatching fresh executor-specific subagents per task. Each subagent gets a clean context window with just the task description.",
    ),
    (
        "- Never close a task if the implementer reported `BLOCKED`, `NEEDS_CONTEXT`, or unresolved `DONE_WITH_CONCERNS` without re-dispatching",
        "- Never close a task if the resolved executor reported `BLOCKED`, `NEEDS_CONTEXT`, or unresolved `DONE_WITH_CONCERNS` without re-dispatching",
    ),
])

replace_section("skills/arc-build/SKILL.md", "### 4. Evaluate Result\n\n", "\n### 6.5. High-Risk Evaluation", """### 4. Evaluate Result

When the subagent reports back, check its **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Executor Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the subagent's report alone.

For follow-up remediation in steps 5, 6, 6.5, and 8, re-dispatch the resolved executor (`coder`, `devops`, or `doc-writer`) with the specific findings and required fixes.

**On `DONE`:**
- Run the project tests. If they pass → proceed to step 5 (Spec Compliance Review).
- If tests fail despite a `DONE` report, treat as `BLOCKED`: re-dispatch with the failure output.

**On `DONE_WITH_CONCERNS`:**
- Read the concerns carefully.
- If the concerns touch correctness or scope (e.g., "I think this edge case isn't handled", "I modified a file outside the spec") — address before review by re-dispatching with specific guidance, or tightening the review prompt.
- If the concerns are observations (e.g., "this file is getting large") — note them as arc comments on the task and proceed to step 5.

**On `BLOCKED` or `NEEDS_CONTEXT`:**
- Do NOT proceed to review. Do NOT close the task.
- For `NEEDS_CONTEXT`: gather the requested information, re-dispatch with it.
- For `BLOCKED`: assess the blocker per the Handle Executor Status table. Escalate one model tier (`nano` → `small` → `standard` → `large`) per the Model Selection escalation rule, or invoke the `debug` skill if the blocker is a persistent test failure, or split the task if too large, or escalate to the human.
- After 3 re-dispatches on the same task without clean `DONE`, invoke the `debug` skill.

**If the subagent did not include a Status field** (malformed report):
- Treat as `BLOCKED`. Re-dispatch with an explicit reminder to use the four-status Report Format.

When re-dispatching, include the previous report's concerns / blockers so the resolved executor knows exactly what to fix:

```
Continue implementing this task. A previous attempt reported <status> with these concerns:

<paste concerns>

Address each concern and re-report.
```

### 5. Spec Compliance Review

After confirming tests pass, dispatch the `spec-reviewer` to independently verify the implementation matches the spec:

```bash
BASE_SHA=$PRE_TASK_SHA
```

Dispatch `spec-reviewer`:

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="spec-reviewer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before handling compliance results.

Do **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled sequential `arc_agent` fallback.

Handle results:
- `COMPLIANT` → proceed to Step 6
- `ISSUES (Missing)` → re-dispatch the resolved executor with specific gaps listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Extra)` → re-dispatch the resolved executor to remove the extras listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Misunderstood)` → re-dispatch the resolved executor with clarification from the spec reviewer's findings. Re-run spec compliance review after.
- Circuit breaker: 3 spec-review/fix cycles without resolution → escalate to user.

> **Documentation-executor tasks**: Skip this step when the resolved executor is `doc-writer` (including legacy `docs-only`). The spec-reviewer is designed around code verification (file lists, function signatures, test coverage) and doesn't apply to documentation. For these tasks, the orchestrator verifies formatting/completeness directly: check that all files in `## Files` were created/modified, links resolve, heading hierarchy is correct, code blocks have language tags.
>
> **Devops evidence-only tasks**: If executor resolved to `devops` and no repo files changed, a missing diff/commit is acceptable. Verify the reported devops evidence (commands, outputs, config/runbook state, operational proof) against the task spec before proceeding.

### 6. Code Quality Review

Only dispatched after spec compliance passes. Use the `review` skill or dispatch `code-reviewer` directly:

```bash
HEAD_SHA=$(git rev-parse HEAD)
```

Use the template at `../arc-review/reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}` = PRE_TASK_SHA recorded earlier, `{HEAD_SHA}` = current HEAD, `{DESIGN_EXCERPT}` from parent epic or "none", `{EVALUATOR_STATUS}` = "active" if evaluator was dispatched, else "not dispatched"). Follow Model Selection above for the dispatch `model:` — `standard` default is appropriate for most reviews.

**On `{EVALUATOR_STATUS}`:** Decide whether to dispatch the evaluator (step 6.5) BEFORE filling this placeholder. If you plan to run step 6.5 in parallel with step 6, set `{EVALUATOR_STATUS}="active"`. Otherwise set `"not dispatched"`. Step 6.5 has the decision criteria for when to dispatch the evaluator.

Handle findings:

| Finding | Action |
|---------|--------|
| **Critical/Important** | Re-dispatch the resolved executor with fixes. Re-review after. |
| **Minor** | Note in arc comment. Proceed. |
| **Deviation (fix)** | Re-dispatch the resolved executor to match the design. |
| **Deviation (accept)** | Log as arc comment: "Accepted deviation: \\<description\\>. Rationale: \\<why\\>." Proceed. |

Circuit breaker: 3 review/fix cycles on the same finding → escalate to user.

> **Documentation-executor tasks**: Skip code quality review when the resolved executor is `doc-writer` (including legacy `docs-only`). For substantial documentation changes (developer-facing API docs, architecture docs), optionally dispatch `code-reviewer` for a quality check.
>
> **Devops evidence-only tasks**: Reviewers may receive no code diff when no repo files changed. In that case, review the devops evidence package for completeness and task alignment instead of requiring a commit.
""")

replace_section("skills/arc-build/SKILL.md", "### 6.5. High-Risk Evaluation (Optional)\n\n", "\n### 7. Close Task", """### 6.5. High-Risk Evaluation (Optional)

The evaluator is **not dispatched by default**. Dispatch only when:
- Task has a `high-risk` label
- The orchestrator judges the task warrants independent verification (e.g., complex spec with multiple valid interpretations, security-sensitive code, tasks that modify shared contracts)

When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:

```ts
subagent({
  tasks: [
    { agent: "arc-evaluator", task: "<filled evaluator prompt>", model: "openai-codex/gpt-5.5" }
  ],
  worktree: true,
  concurrency: 1,
  context: "fresh",
  async: true,
  clarify: false
})
```

If `pi-subagents` or `arc-evaluator` is not available, fall back to sequential `arc_agent(agent="evaluator", model="large", task="<filled evaluator prompt>")` and ensure the evaluator does not leave uncommitted artifacts in the main worktree.

```bash
PARENT=$(arc show <task-id> --json | jq -r '.parent_id // empty')
```

Use the template at `./evaluator-prompt.md`. Fill placeholder `{TASK_ID}`. Because evaluation is adversarial verification on high-risk tasks, escalate one tier from the agent default (typically to `large`) — set `model: "large"` on `arc_agent` dispatches unless the task is narrow. For `pi-subagents`, pass the concrete configured large model.

When you plan to run the evaluator, set the code quality reviewer's `## Evaluator Status` to `active`; otherwise set it to `not dispatched`.

Triage evaluator findings (for devops tasks, evaluators should also inspect reported devops evidence and can pass evidence-only runs when no repo files changed):

| Evaluator verdict | Orchestrator action |
|---|---|
| `PASS` | No action — evaluator confirms the spec intent is satisfied. |
| `CONCERNS` | Read the concerns. Re-dispatch the resolved executor if the concerns describe substantive behavior gaps. Otherwise note as arc comments and proceed. |
| `FAIL — Spec-Intent Gap` | Re-dispatch the resolved executor with the evaluator's quoted spec text and the failing behavior description. |
| `FAIL — Missing Behavior` | Re-dispatch the resolved executor — the spec requires behavior that wasn't built. |
| `FAIL — Edge Case` | Lower-severity. Re-dispatch the resolved executor if the spec clearly implies the edge case; otherwise record as a known limitation. |
| `ERROR — Cannot Test` | The public API is insufficient. Re-dispatch the resolved executor with a request to expose the needed surface. |
| `BLOCKED` | Evaluator itself is blocked. Escalate per the Model Selection rules or involve the human. |
""")

replace_section("skills/arc-build/SKILL.md", "### 8. Integration Checkpoint\n\n", "\n### 9. Repeat", """### 8. Integration Checkpoint

After closing 2-3 related tasks, or before switching to a new epic phase, run the full integration test suite:

```bash
make test-integration
```

This catches cross-task regressions that individual executor gate checks won't — each executor subagent only validates its own task's scope. Do not wait until all tasks are complete to discover integration failures.

If integration tests fail:
- Identify which task's changes caused the failure
- Re-dispatch the resolved executor with the failing test details and the relevant task context
- If the failure spans multiple tasks, invoke the `debug` skill
""")

replace_section("skills/arc-build/SKILL.md", "## Handle Implementer Status\n\n", "\n## Parallel Patch Protocol", """## Handle Executor Status

Every `coder`, `devops`, and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:

| Status | Orchestrator action |
|---|---|
| `DONE` | Proceed to spec review, then code review. |
| `DONE_WITH_CONCERNS` | Read the concerns. If they're about correctness or scope, address before review (re-dispatch or tighten review prompt). If they're observations (file getting large, naming doubt), note them as arc comments on the task and proceed to review — close only after a later dispatch yields a clean `DONE`. |
| `BLOCKED` | Assess the blocker: (1) context problem → provide missing context, re-dispatch same tier; (2) reasoning limit → re-dispatch one tier up per the Model Selection escalation rule; (3) task too large → split and re-plan; (4) plan is wrong → escalate to human. Never retry the same dispatch unchanged. |
| `NEEDS_CONTEXT` | Gather the specific missing information. Re-dispatch with it in the prompt. |

**Never close a task** whose last report was `BLOCKED`, `NEEDS_CONTEXT`, or `DONE_WITH_CONCERNS` unresolved. Re-dispatch until you have a clean `DONE` — then close.
""")

patch_file("agents/coder.md", [
    (
        "description: Use this agent for implementing a single task using TDD. Dispatched by the implement skill with a task description from arc. Receives task context, implements following RED → GREEN → REFACTOR → GATE, commits results, and reports back.",
        "description: Use this agent for coding a single task using TDD. Dispatched by the arc-build skill with a task description from arc. Receives task context, works through RED → GREEN → REFACTOR → GATE, commits results, and reports back.",
    ),
    ("# Arc Implementer Agent", "# Arc Coder Agent"),
    (
        "You are an implementation agent. You receive a single task, implement it using test-driven development, verify your own work against the spec, and report results back to the dispatching agent.",
        "You are a coder agent. You receive a single task, code it using test-driven development, verify your own work against the spec, and report results back to the dispatching agent.",
    ),
    ("**Build ONLY what the task specifies.**", "**Code ONLY what the task specifies.**"),
    (
        "If the task seems incomplete** (e.g., it builds a function but doesn't wire it up)",
        "If the task seems incomplete** (e.g., it defines a function but doesn't wire it up)",
    ),
])

patch_file("skills/arc-build/coder-prompt.md", [
    ("# Implementer Prompt Template", "# Coder Prompt Template"),
    ("You are implementing arc task {TASK_ID}.", "You are coding arc task {TASK_ID}."),
])

patch_file("skills/arc-build/doc-writer-prompt.md", [
    (
        "Use this template when dispatching `doc-writer` for a task labeled `docs-only`.",
        "Use this template when dispatching `doc-writer` for a task routed to `executor:docs` (or the legacy `docs-only` fallback).",
    ),
])

patch_file("skills/arc-plan/SKILL.md", [
    (
        "## Labels\n- T3: docs-only",
        "## Labels\n- T1: executor:coder\n- T2: executor:devops\n- T3: executor:docs",
    ),
    (
        "For each task, check whether **all** files in its `## Files` section are documentation (`.md`, `.txt`, `README`, `CHANGELOG`, or anything under `docs/`). If so, include it in the `## Labels` section with `docs-only`. Doc-only tasks skip TDD — the `implement` skill routes them to `doc-writer` instead of `coder`.",
        "Every new implementation task must include exactly one executor label: `executor:coder`, `executor:devops`, or `executor:docs`. Multiple or missing executor labels are plan failures.\n\nUse `executor:docs` as the source of truth for new docs tasks. `docs-only` is a legacy input handled by arc-build only and must not be emitted for new tasks.\n\n### Executor Classification\n\n| Task content | Executor label |\n|---|---|\n| Application/library/CLI code changes | `executor:coder` |\n| Kubernetes, Terraform/OpenTofu, Helm, Kustomize, ArgoCD, CI/CD, cloud infra, runbooks, live operational checks | `executor:devops` |\n| Documentation-only changes | `executor:docs` |\n\nLive operations require the `live-ops-approved` label plus explicit task-body authorization.\n\n### DevOps Task Description Format\n\nUse this format for tasks labeled `executor:devops`:\n\n```markdown\n## Executor\nexecutor:devops\n\n## Live Operation Authorization\n- Explicit task-body authorization: <required statement>\n- Requires label: live-ops-approved (for live operations)\n\n## Target Environment\n- <environment>\n\n## Allowed Operations\n- <allowed commands/actions>\n\n## Scope Boundary\n- <in-scope systems>\n- <out-of-scope systems>\n\n## Preflight Checks\n1. <check>\n\n## Execution Steps\n1. <step>\n\n## Rollback Plan\n1. <rollback step>\n\n## Validation/Post-checks\n1. <validation command>\n\n## Evidence to Report\n- <logs/screenshots/command output>\n```",
    ),
    (
        "For `docs-only` tasks, omit `## Test Command` and use `## Verification` instead:",
        "For `executor:docs` tasks, omit `## Test Command` and use `## Verification` instead. `docs-only` is legacy input only:",
    ),
])

patch_file("skills/arc-plan/SKILL.md", [
    (
        "**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
        "**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. Model profile: issue creation uses the issueManager profile when configured via `/arc-models`; otherwise it falls back to the legacy tier/frontmatter behavior. This work is mostly CLI formatting, so the recommended profile uses gpt-5.4-mini with thinking off. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
    ),
    (
        "The share keyring entries have `{id, kind, url, key_b64url, plan_file, created_at}` — edit tokens are intentionally redacted. Then dispatch the manifest. Prefer true `pi-subagents` so long issue-creation runs are visible in `/subagents-status`:",
        "The share keyring entries have `{id, kind, url, key_b64url, plan_file, created_at}` — edit tokens are intentionally redacted.\n\nIssue creation must be phased:\n\n1. Create the epic first and capture the epic ID.\n2. Create all child tasks with the epic as parent before applying dependencies.\n3. Capture the complete task-name-to-ID table.\n4. Apply dependencies only after all child IDs exist.\n5. Apply labels after dependencies, or in the same post-creation phase.\n6. Return the final ID table, dependency summary, and a `## Timing` section with phase-level `elapsed_ms` values when available.\n\nThen dispatch the manifest. Prefer true `pi-subagents` so long issue-creation runs are visible in `/subagents-status`:",
    ),
    (
        "- If `subagent` unavailable or `arc-issue-manager` missing: run `/arc-subagents-sync`, then `subagent({ action: \"list\" })` to verify, then retry primary\n- Fallback only if `pi-subagents` is not installed or cannot load after sync: `arc_agent(agent=\"issue-manager\", task=\"<manifest below>\")`",
        "- Arc issue-manager should be auto-materialized; if it is missing, first run `subagent({ action: \"doctor\" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: \"list\" })`\n- Fallback only if `pi-subagents` is not installed or cannot load after deprecated repair: `arc_agent(agent=\"issue-manager\", task=\"<manifest below>\")`",
    ),
    (
        "Return a summary table mapping task names to arc IDs.",
        "Return a summary table mapping task names to arc IDs, plus a `## Timing` section with phase-level `elapsed_ms` values when available.",
    ),
    (
        "| Epic | ...    | ...   |\n| T1   | ...    | ...   |\n```\n\n**IMPORTANT**: The epic description MUST contain the complete approved design.",
        "| Epic | ...    | ...   |\n| T1   | ...    | ...   |\n\n## Timing\n| Phase | elapsed_ms |\n|-------|------------|\n| epic | ... |\n| child_tasks | ... |\n| dependencies | ... |\n| labels | ... |\n```\n\nThe `## Timing` section is required for bulk issue creation; use `unknown` for a phase only if the issue-manager could not capture a timestamp.\n\n**IMPORTANT**: The epic description MUST contain the complete approved design.",
    ),
    (
        "**Use the `ask_user_question` tool** to let the user choose:\n\n```\nQuestion: \"Epic and tasks created. How should we proceed with implementation?\"\nOptions:\n  - \"Start implementing now\" (invoke /arc-build in this session — subagents handle TDD per task)\n  - \"Implement in a new session\" (provides the exact prompt to use)\n  - \"Done for now\" (tasks are tracked in arc — implement manually or later)\n```",
        "**Use the `ask_user_question` tool** with the package's `questions[]` schema to let the user choose:\n\n```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Next\",\n      \"question\": \"Epic and tasks created. How should we proceed with implementation?\",\n      \"options\": [\n        {\n          \"label\": \"Start now (Recommended)\",\n          \"description\": \"Recommended when you want this session to continue directly into /arc-build with subagents handling TDD per task.\"\n        },\n        {\n          \"label\": \"New session\",\n          \"description\": \"Prints the exact /arc-build <epic-id> command to run in a fresh Pi session.\"\n        },\n        {\n          \"label\": \"Done for now\",\n          \"description\": \"Leaves the tasks tracked in arc for manual or future implementation.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
])

insert_before_if_missing("skills/arc-plan/SKILL.md", "## Task Description Format", """## Parallel Readiness

When a design can split into parallel implementation batches, document the readiness proof before handing off tasks.

### T0 Foundation Decision

State whether the design needs a T0 foundation task. If shared contracts, shared constants, or any other multi-task interface are referenced by more than one task, create T0 first and block every dependent parallel batch on it.

### File Ownership Matrix

Do not mark any task parallelizable until this matrix is complete and every file is owned by exactly one task.

| Task | Owns files | Reads files | Overlap handling |
|---|---|---|---|

### Parallel Batch Manifest

Group only disjoint tasks into parallel batches after file ownership is settled.

| Batch | Prerequisites | Tasks | Independence proof | Validation |
|---|---|---|---|---|

### Validation Matrix

List the validation command(s) for each batch and the result that proves the batch is ready to hand off.

| Check | Scope | Command | Expected result |
|---|---|---|---|

""", "## Parallel Readiness")

replace_section("skills/arc-review/SKILL.md", "### 3. Dispatch Reviewer\n\n", "\n### 4. Triage Feedback", """### 3. Dispatch Reviewer

Fill the template at `./code-reviewer-prompt.md` with the gathered placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESIGN_EXCERPT}`, `{EVALUATOR_STATUS}`). Preserve the template's review-only instruction (`Review only; return findings only. Do not edit files.`) and avoid adding wording that asks the reviewer to apply fixes directly. Prefer true `pi-subagents` so longer reviews are visible in `/subagents-status`:

Dispatch preference (use **async** so longer reviews appear in `/subagents-status`):
- Primary: `subagent({ agent: "arc-code-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- After launching async, **wait for terminal status** by polling `subagent({ action: "status", id: "<run-id>" })` until status is `completed` or `failed`
- Users can monitor review progress via `/subagents-status` during the async run
- Arc code-reviewer should be auto-materialized; if it is missing, first run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`
- Fallback only if `pi-subagents` is not installed or cannot load after deprecated repair: `arc_agent(agent="code-reviewer", task="<filled prompt>")`

**Model tier:** Follow the Model Selection table in `../arc-build/SKILL.md`. Model profile: reviews use the `codeReviewer` profile when configured via `/arc-models`; otherwise they fall back to existing tier/frontmatter behavior. Escalate only for large, cross-layer, or security-sensitive diffs. For most reviews, omit `model:` (use the agent's `standard` default). For `pi-subagents`, pass the configured concrete large model only when escalating.
""")

insert_before_if_missing(
    "skills/arc-review/code-reviewer-prompt.md",
    "## Task Spec",
    "Review only; return findings only. Do not edit files.\n\n",
    "Review only; return findings only. Do not edit files.",
)
patch_file("skills/arc-review/code-reviewer-prompt.md", [
    (
        "- **Critical** (must fix): correctness bugs, security issues, scope violations, spec deviations",
        "- **Critical** (blocking): correctness bugs, security issues, scope violations, spec deviations",
    ),
    (
        "- **Important** (should fix): quality issues, pattern mismatches, naming problems, test gaps",
        "- **Important** (address before proceeding): quality issues, pattern mismatches, naming problems, test gaps",
    ),
])

SUPERVISOR_SECTIONS = {
    "agents/coder.md": ("## When Tests Can't Run", "implementation plan"),
    "agents/code-reviewer.md": ("## Rules", "review plan"),
    "agents/doc-writer.md": ("## Quality Checklist", "documentation plan"),
    "agents/evaluator.md": ("## Rationalizations You Must Reject", "evaluation plan"),
    "agents/issue-manager.md": ("## Output Format", "issue plan"),
    "agents/spec-reviewer.md": ("## Report Format", "review plan"),
}
for rel, (marker, plan_phrase) in SUPERVISOR_SECTIONS.items():
    extra = "Preserve adversarial/read-only expectations and" if rel == "agents/evaluator.md" else "Preserve read-only behavior and" if rel in {"agents/code-reviewer.md", "agents/spec-reviewer.md"} else ""
    if rel in {"agents/coder.md", "agents/doc-writer.md", "agents/issue-manager.md"}:
        routine = "Do not send routine completion handoffs through intercom; return your final task result normally."
    else:
        routine = f"{extra} do not send routine completion handoffs through intercom; return your final {'evaluation result' if rel == 'agents/evaluator.md' else 'review result'} normally."
    insertion = f"""## Supervisor Escalation

If runtime bridge instructions identify `contact_supervisor`, use it only for decisions that block safe completion: product scope, API shape, user approval, or contradictory requirements. Send `reason: "need_decision"` and wait for the reply before continuing.

Use `reason: "progress_update"` only for meaningful unexpected discoveries that change the {plan_phrase} or for explicit progress checkpoints. {routine}

Never invent an intercom target. If bridge instructions are absent, report `BLOCKED` or `NEEDS_CONTEXT` in your normal final output instead of guessing.

"""
    if rel == "agents/issue-manager.md":
        insertion = """## Supervisor Escalation

If runtime bridge instructions identify `contact_supervisor`, use it only for decisions that block safe completion: Arc issue structure, dependency ambiguity, labels, or parent/child hierarchy. Send `reason: "need_decision"` and wait for the reply before continuing.

Use `reason: "progress_update"` only for meaningful unexpected discoveries that change the issue plan or for explicit progress checkpoints. Do not send routine completion handoffs through intercom; return your final task result normally.

Never invent an intercom target. If bridge instructions are absent, report `BLOCKED` or `NEEDS_CONTEXT` in your normal final output instead of guessing.

"""
    insert_before_if_missing(rel, marker, insertion, "## Supervisor Escalation")

replace_section("agents/issue-manager.md", "## Processing Task Manifests\n\n", "\n## Bulk Operations", """## Processing Task Manifests

When receiving a structured manifest from the `plan` or `brainstorm` skills, parse the `## Epic` and `## Tasks` sections to assemble the manifest, then process it in phases:

1. **Create the epic first** and capture the epic ID.
2. **Create all child tasks** with the epic as parent before applying dependencies.
   ```bash
   arc create "Task title" --type=task --parent=<epic-id> --stdin <<'EOF'
   Full multi-line description here.
   EOF
   ```
3. **Capture the complete task-name-to-ID table**.
4. **Apply dependencies only after all child IDs exist**.
   ```bash
   arc dep add <real-later-id> <real-earlier-id> --type=blocks
   ```
5. **Validate executor labels before applying labels**: every child task must carry exactly one executor label.
   - Allowed values: `executor:coder`, `executor:devops`, `executor:docs`
   - Missing executor labels or multiple executor labels on one task are manifest failures.
6. **Apply labels after dependencies**, or in the same post-creation phase.
   ```bash
   # Labels are managed via the REST API (no CLI command exists)
   # If CLI cannot apply labels directly, report the exact labels
   # per task in the summary so the dispatcher can apply them.
   ```
7. **Return the final ID table, dependency summary, and `## Timing` summary**.

Print `[arc-issue-manager] phase=<name> status=start|done elapsed_ms=<n>` progress lines around each phase (`epic`, `child_tasks`, `dependencies`, `labels`, and optional `verification`) so long-running issue creation is observable.

**Concurrency note:** Concurrent child-task creation is future work pending Arc CLI/server concurrency verification. Do not claim true parallel CLI issue creation is safe today.

**Handling partial failures**: If a task creation fails mid-manifest:
- Continue creating the remaining tasks in order — do not abort the manifest
- Report partial results clearly: "Created 4/5 tasks. T3 failed: `<error message>`"
- Include the ID mapping for all successfully created tasks so the dispatcher can act on what exists
- Do not attempt to clean up already-created tasks — the dispatcher will decide

This is the primary interface used by the `plan` and `brainstorm` skills for bulk issue creation.
""")

patch_file("agents/issue-manager.md", [
    (
        "- Summarize any errors encountered\n- Provide next steps if applicable",
        "- Summarize any errors encountered\n- Include a `## Timing` section with phase-level elapsed times for bulk operations when available\n- Provide next steps if applicable",
    ),
])


print(f"Migrated arc plugin resources from {SRC}")
print(f"Package root: {ARC_ROOT}")
print(f"Prompts: {len(list((ARC_ROOT / 'prompts').glob('*.md')))}")
print(f"Skills: {len(list((ARC_ROOT / 'skills').glob('*/SKILL.md')))}")
print(f"Agents: {len(list((ARC_ROOT / 'agents').glob('*.md')))}")
