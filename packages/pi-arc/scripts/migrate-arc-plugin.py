#!/usr/bin/env python3
import argparse
import atexit
from pathlib import Path
import shutil
import tempfile
import re

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_CANDIDATES = (
    Path.home() / "devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/arc",
    REPO_ROOT.parents[1].parent / "agent-nexus/claude-marketplace/plugins/arc",
    Path.home() / "devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/arc",
)
DEFAULT_SRC = next((path.resolve() for path in DEFAULT_SOURCE_CANDIDATES if path.exists()), DEFAULT_SOURCE_CANDIDATES[0].resolve())
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

ARC_ROOT = Path(tempfile.mkdtemp(prefix=".pi-arc-migration-", dir=REPO_ROOT.parent))
atexit.register(shutil.rmtree, ARC_ROOT, ignore_errors=True)
ARC_ROOT.mkdir(parents=True, exist_ok=True)

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
# The source root STACKING.md is also intentionally omitted: it depends on the
# separately shipped Claude git-spice/jj-spice plugins. The generated Arc
# reference is patched below to point users at an installed Pi-native stacking
# workflow instead of shipping a broken cross-plugin playbook.

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
    "summarize": "arc-summarize",
    "verify": "arc-verify",
}

def transform_text(text: str) -> str:
    # Slash command references.
    text = re.sub(r"/arc:([a-zA-Z0-9_-]+)", lambda m: f"/arc-{m.group(1)}", text)
    text = re.sub(r"`arc:([a-zA-Z0-9_-]+)`", lambda m: f"`/arc-{m.group(1)}`", text)
    text = text.replace("→ arc:", "→ /arc-")
    for old, new in skill_map.items():
        if old != "arc":
            text = text.replace(f"/skill:{old}", f"/skill:{new}")

    # Harness naming and Claude-specific tool names.
    text = text.replace("Claude Code", "Pi")
    text = text.replace("Claude", "Pi")
    text = text.replace("SessionStart/PreCompact hooks", "Pi extension session-start and before-compaction handlers")
    text = text.replace("SessionStart and PreCompact hooks", "Pi extension session-start and before-compaction handlers")
    text = text.replace("via the Task tool", "through the auto-materialized `arc-issue-manager` pi-subagent when available, or the bundled `arc_agent` fallback")
    text = text.replace("implement skill", "build skill")
    text = text.replace("using the Write tool", "using the `write` tool")
    text = text.replace("with the Write tool", "with the `write` tool")
    text = text.replace("Grep / Read / symbol search", "`grep` / `read` / symbol search")
    text = text.replace("arc plan create", "arc plan create --no-frontmatter")
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
    text = text.replace("Agent(subagent_type=\"arc:builder\", model=\"haiku\", prompt=\"...\")", "arc_agent(agent=\"builder\", model=\"haiku\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", prompt=\"...\")", "arc_agent(agent=\"builder\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", model=\"opus\", prompt=\"...\")", "arc_agent(agent=\"builder\", model=\"opus\", task=\"...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 1...\")", "arc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 1...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 2...\")", "arc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 2...\")")
    text = text.replace("Agent(subagent_type=\"arc:builder\", isolation=\"worktree\", prompt=\"Task 3...\")", "arc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 3...\")")
    text = text.replace("Agent dispatch", "arc_agent dispatch")
    text = text.replace("Agent tool", "arc_agent tool")
    text = text.replace("Use the Agent", "Use arc_agent")

    # Relative paths after skill directory renames.
    text = text.replace("../build/", "../arc-build/")
    text = text.replace("../review/", "../arc-review/")
    text = text.replace("skills/brainstorm/SKILL.md", "skills/arc-brainstorm/SKILL.md")
    text = text.replace("skills/build/", "skills/arc-build/")
    text = text.replace("skills/plan/SKILL.md", "skills/arc-plan/SKILL.md")
    # Keep generated Markdown compatible with `git diff --check` even when the
    # source plugin contains whitespace-only separators.
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
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

# Patch generated skills for Pi-specific execution semantics.
def patch_file(rel: str, replacements: list[tuple[str, str]]) -> None:
    path = ARC_ROOT / rel
    text = path.read_text()
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(f"Expected text not found while patching {rel}: {old[:80]!r}")
        text = text.replace(old, new)
    path.write_text(text)


def replace_section(rel: str, start_marker: str, end_marker: str, replacement: str) -> None:
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
        "- **Agentic team**: Add `teammate:*` labels, invoke `/arc-team-dispatch`. Best for parallel multi-role work.",
        "- **Parallel Arc build**: For independent task batches, `build` can use worktree-isolated `pi-subagents` runs when that companion package and Arc agent definitions are available. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
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
        "## Contexts\n\nThis skill works in orchestrated Arc execution:\n\n| Context | How review works |\n|---------|-----------------|\n| **Sequential build** | Main agent dispatches `code-reviewer` subagent after the builder reports completion |\n| **Parallel patch batch** | Main agent applies each accepted patch to the main worktree, then dispatches `code-reviewer` against the applied diff |",
    ),
])

patch_file("skills/arc-finish/SKILL.md", [
    (
        "**Work is NOT done until `git push` succeeds. No exceptions.**",
        "**Work is NOT done until the selected VCS push succeeds. No exceptions.**",
    ),
    (
        "Uncommitted code doesn't exist. Unpushed commits are local fiction. The remote is the source of truth.",
        "Local-only work is not complete. The remote is the source of truth.",
    ),
    (
        "    **jj:** `jj git push --bookmark <feature-bookmark>` or `jj git push -c @` to auto-create and push the current change's bookmark.",
        "    **jj:** After `jj commit`, the completed change is `@-`. Move its feature bookmark with `jj bookmark move <feature-bookmark> --to @-`, then push it with `jj git push --bookmark <feature-bookmark>`. Do not use `jj git push -c @` here because `@` is the new empty working-copy change.",
    ),
    (
        "    **jj:** Confirm the pushed bookmark equals its remote-tracking state: run `jj log -r '<bm>@origin' --no-graph` and verify it resolves and matches your local `<bm>`. The remote must be in sync with your local state.",
        "    **jj:** Compare exact commit IDs and require equality: `LOCAL=$(jj log -r '<bm>' -T commit_id --no-graph); REMOTE=$(jj log -r '<bm>@origin' -T commit_id --no-graph); test \"$LOCAL\" = \"$REMOTE\"`. The remote must be in sync with the local bookmark.",
    ),
    (
        "18. Confirm the commit:\n    ```bash\n    git log -1    # Verify latest commit is visible\n    ```",
        "18. Confirm the commit:\n    ```bash\n    git log -1    # Verify latest commit is visible\n    ```\n    **jj:** `jj log -r @- --no-graph` verifies the completed change immediately below the new empty working-copy change.",
    ),
    (
        "- Never commit with `git add -A` — stage specific files\n- Never leave unpushed commits",
        "- When Git is selected, never commit with `git add -A` — stage specific files\n- Never leave completed work local-only; push it with the selected VCS",
    ),
    (
        "| Session Type | Behavior |\n|-------------|----------|\n| **Single-agent** | Full protocol above |\n| **Team lead** | Verify teammate work → close arc issues → team cleanup → commit → push |\n| **Teammate** | Commit → push (team lead handles arc close and coordination) |",
        "| Session Type | Behavior |\n|-------------|----------|\n| **Single-agent** | Full protocol above |\n| **Parallel subagent patches** | Apply/review accepted patches → verify → close arc issues → commit → push |",
    ),
])

patch_file("skills/arc-build/SKILL.md", [
    (
        "Every arc_agent dispatch can override the subagent's frontmatter model via the `model:` parameter. Use this to match model tier to task complexity. The default floor per agent is set in frontmatter — use these overrides to downgrade for trivial tasks or escalate for complex ones.",
        "Every Arc subagent dispatch can override the subagent's frontmatter model via the `model:` parameter. Use this to match model tier to task complexity. The default floor per agent is set in frontmatter — use these overrides to downgrade for trivial tasks or escalate for complex ones.\n\nPrefer the `subagent` tool from `pi-subagents` when it is available **and** Arc agent definitions such as `arc-builder` are installed. If Arc specialist definitions are missing, run `/arc-subagents-sync` (project default) or `/arc-subagents-sync user`, then re-check with `subagent({ action: \"list\" })`. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; `pi-subagents` adds chains, async runs, and worktree-isolated parallel patch generation.",
    ),
    (
        "```text\narc_agent(agent=\"builder\", model=\"haiku\", task=\"...\")       # mechanical\narc_agent(agent=\"builder\", task=\"...\")                      # standard (sonnet)\narc_agent(agent=\"builder\", model=\"opus\", task=\"...\")        # complex\n```",
        "```text\n# Self-contained fallback:\narc_agent(agent=\"builder\", model=\"haiku\", task=\"...\")       # mechanical\narc_agent(agent=\"builder\", task=\"...\")                      # standard (sonnet)\narc_agent(agent=\"builder\", model=\"opus\", task=\"...\")        # complex\n\n# Preferred when pi-subagents Arc agents are installed:\nsubagent({ agent: \"arc-builder\", task: \"...\", model: \"haiku\", context: \"fresh\" })\nsubagent({ agent: \"arc-builder\", task: \"...\", context: \"fresh\" })\nsubagent({ agent: \"arc-builder\", task: \"...\", model: \"opus\", context: \"fresh\" })\n```",
    ),
    (
        "### Parallel\n\nMultiple tasks dispatched simultaneously using `isolation: \"worktree\"`. Use this **only** when ALL of these are true:\n- 3+ independent tasks remain\n- No shared files between any tasks in the batch\n- No `blocks`/`blockedBy` dependencies between tasks in the batch\n- Each task's scope is clearly defined with no ambiguity\n\n**When NOT to use parallel**: overlapping files, task dependencies, uncertainty about scope, fewer than 3 tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel merge is data loss.",
        "### Parallel\n\nParallel worktree dispatch is available **only** through the optional `pi-subagents` companion package, not through `arc_agent`. Use it only when ALL of these are true:\n- `pi-subagents` is installed and the `subagent` tool is available\n- Arc agent definitions such as `arc-builder` / `arc-doc-writer` are installed for `pi-subagents`\n- 3+ independent tasks remain, or one high-risk evaluator needs a disposable worktree\n- No shared files between any builder/doc-writer tasks in the batch\n- No `blocks`/`blockedBy` dependencies between tasks in the batch\n- Each task's scope is clearly defined with no ambiguity\n\n`pi-subagents` worktree mode returns per-task patch files and cleans up temporary worktrees. It does **not** automatically merge changes into the main working tree. The orchestrator must inspect, apply, verify, commit, and close each patch/task explicitly.\n\n**When NOT to use parallel**: missing `subagent` tool, missing Arc agent definitions, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel patch merge is data loss.",
    ),
    (
        "By default, use sequential dispatch. For independent tasks, see [Parallel Dispatch Protocol](#parallel-dispatch-protocol) below.",
        "By default, use sequential dispatch. For independent batches with `pi-subagents` available, see [Parallel Patch Protocol](#parallel-patch-protocol) below.",
    ),
    (
        "Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the agent default is appropriate; omit `model:` unless the spec is unusually large or ambiguous.",
        "Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.\n\nDispatch preference:\n- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: \"arc-spec-reviewer\", task: \"<filled prompt>\", context: \"fresh\" })`\n- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: \"list\" })`, then retry.\n- Otherwise: `arc_agent(agent=\"spec-reviewer\", task=\"<filled prompt>\")`\n\nDo **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled `arc_agent` fallback.",
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
        "All parallel arc_agent tool calls with `isolation: \"worktree\"` **must happen in the same orchestrator message**. This ensures they all branch from the same HEAD.\n\n```\n# In a single response, dispatch all parallel tasks:\narc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 1...\")\narc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 2...\")\narc_agent(agent=\"builder\", isolation=\"worktree\", task=\"Task 3...\")\n```\n\n**Never** dispatch worktree agents across multiple turns — HEAD may move between turns, causing stale branches.",
        "Dispatch all parallel tasks in one `subagent` tool call so they branch from the same `PARALLEL_BASE`:\n\n```ts\nsubagent({\n  tasks: [\n    { agent: \"arc-builder\", task: \"<filled builder prompt for task 1>\", model: \"sonnet\" },\n    { agent: \"arc-builder\", task: \"<filled builder prompt for task 2>\", model: \"sonnet\" },\n    { agent: \"arc-doc-writer\", task: \"<filled doc-writer prompt for task 3>\", model: \"haiku\" }\n  ],\n  worktree: true,\n  concurrency: 3,\n  context: \"fresh\"\n})\n```\n\n`pi-subagents` returns diff stats and a `Full patches: <dir>` path. Temporary worktrees are cleaned up; the patches are the handoff artifact.",
    ),
    (
        "- Never proceed after parallel merge without verifying commit history against the recorded HEAD anchor",
        "- Never use parallel patch mode unless `pi-subagents` and Arc `pi-subagents` agent definitions are available\n- Never apply more than one parallel patch at a time; apply, verify, review, commit, and close each task independently\n- Never proceed after a parallel patch batch without verifying commit history against the recorded HEAD anchor",
    ),
])


# The replacement above adjusts the dispatch example, but the original Claude
# protocol still describes automatic worktree merge semantics. Pi-subagents
# returns patch files instead, so replace the whole protocol body.
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
- No task has a `devops` label or any live-system mutation scope; those tasks are always sequential
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
    { agent: \"arc-builder\", task: \"<filled builder prompt for task 1>\" },
    { agent: \"arc-builder\", task: \"<filled builder prompt for task 2>\" },
    { agent: \"arc-doc-writer\", task: \"<filled doc-writer prompt for task 3>\" }
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

`arc_agent` resolves Arc model tiers through `arc.modelTiers` in Pi settings. Defaults map the GPT-5.6 family by role: Luna for fast/affordable work, Terra for balanced implementation, and Sol for high-risk reasoning.

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.6-luna` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.6-luna` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.6-terra` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.6-sol` | Cross-cutting, architectural, security-sensitive, or adversarial review |

Users can override the tier map in `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "arc": {
    "modelTiers": {
      "nano": "openai-codex/gpt-5.6-luna",
      "small": "openai-codex/gpt-5.6-luna",
      "standard": "openai-codex/gpt-5.6-terra",
      "large": "openai-codex/gpt-5.6-sol"
    }
  }
}
```

Legacy aliases still resolve for compatibility: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. Prefer the Pi-native tier names in new prompts, including `nano` for low-reasoning issue-manager work.

Prefer the `subagent` tool from `pi-subagents` when it is available **and** Arc agent definitions such as `arc-builder` are installed. If Arc specialist definitions are missing, run `/arc-subagents-sync` (project default) or `/arc-subagents-sync user`, then re-check with `subagent({ action: "list" })`. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; `pi-subagents` adds chains, async runs, and worktree-isolated parallel patch generation.

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
arc_agent(agent="builder", model="small", task="...")       # mechanical
arc_agent(agent="builder", task="...")                      # standard default
arc_agent(agent="builder", model="large", task="...")       # complex

# Preferred when pi-subagents Arc agents are installed:
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-luna", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-terra", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-sol", context: "fresh", async: true, clarify: false })
```

**When unsure, omit `model:`** — the agent's frontmatter floor is calibrated for the typical case.

**Escalation rule:** If a subagent returns `BLOCKED` with a reasoning or capability complaint, re-dispatch with the next tier up before asking the human. Stop escalating at `large` — if `large` also returns `BLOCKED`, escalate to the human with the subagent's blocker summary.
""")

replace_section("skills/arc-build/SKILL.md", "### 3. Dispatch Agent\n\n", "\n### 4. Evaluate Result", """### 3. Dispatch Agent

Record the current HEAD before dispatching — needed for review if escalated:

```bash
PRE_TASK_SHA=$(git rev-parse HEAD)
```

Check whether the task has a `docs-only` label:

```bash
arc show <task-id> --json | jq -e '.labels[] | select(. == "docs-only")' > /dev/null 2>&1
```

**If `docs-only`** (exit code 0) — spawn a `doc-writer` subagent:

Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs-only work, the agent default (`small`) is correct — omit `model:` unless the docs task is unusually complex.

Dispatch preference:
- If `subagent` is available and `arc-doc-writer` is installed: `subagent({ agent: "arc-doc-writer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: "list" })`, then retry.
- Otherwise: `arc_agent(agent="doc-writer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**Otherwise** — spawn a `builder` subagent:

Use the template at `./builder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.

Dispatch preference:
- If `subagent` is available and `arc-builder` is installed: `subagent({ agent: "arc-builder", task: "<filled prompt>", model: "<concrete-model-if-needed>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: "list" })`, then retry.
- Otherwise: `arc_agent(agent="builder", task="<filled prompt>", model="<tier-if-needed>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.
""")

replace_section("skills/arc-build/SKILL.md", "Dispatch `spec-reviewer`:\n\n", "\nHandle results:", """Dispatch `spec-reviewer`:

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: run `/arc-subagents-sync`, verify with `subagent({ action: "list" })`, then retry.
- Otherwise: `arc_agent(agent="spec-reviewer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before handling compliance results.

Do **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled `arc_agent` fallback.
""")

replace_section("skills/arc-build/SKILL.md", "When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run.", "\nTriage evaluator findings:", """When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:

```ts
subagent({
  tasks: [
    { agent: "arc-evaluator", task: "<filled evaluator prompt>" }
  ],
  worktree: true,
  concurrency: 1,
  context: "fresh",
  async: true,
  clarify: false
})
```

If `pi-subagents` or `arc-evaluator` is not available, fall back to sequential `arc_agent(agent="evaluator", task="<filled evaluator prompt>")`. The configured `evaluator` profile remains authoritative and the agent's `large` frontmatter is the fallback. Because this runs in the main checkout, require the evaluator to remove every temporary test, dependency, and build-file edit and verify `git status --short` matches its pre-evaluation baseline before returning.

```bash
PARENT=$(arc show <task-id> --json | jq -r '.parent_id // empty')
```

Use the template at `./evaluator-prompt.md`. Fill `{TASK_ID}` and `{DESIGN_EXCERPT}` from the parent epic fetched above; use `none` only when there is no parent design. Because evaluation is adversarial verification on high-risk tasks, use the `evaluator` model profile when configured or the `large` tier fallback.

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
        "Follow Model Selection above for the dispatch `model:` — the configured `codeReviewer` profile is authoritative and `large` frontmatter is the fallback.",
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
])

replace_section("skills/arc-review/SKILL.md", "### 3. Dispatch Reviewer\n\n", "\n### 4. Triage Feedback", """### 3. Dispatch Reviewer

Fill the template at `./code-reviewer-prompt.md` with the gathered placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESIGN_EXCERPT}`, `{EVALUATOR_STATUS}`). Prefer true `pi-subagents` so longer reviews are visible in `/subagents-status`:

Dispatch preference (use **async** so longer reviews appear in `/subagents-status`):
- Primary: `subagent({ agent: "arc-code-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- After launching async, **wait for terminal status** by polling `subagent({ action: "status", id: "<run-id>" })` until status is `completed` or `failed`
- Users can monitor review progress via `/subagents-status` during the async run
- If `subagent` unavailable or `arc-code-reviewer` missing: run `/arc-subagents-sync`, then `subagent({ action: "list" })` to verify, then retry primary
- Fallback only if `pi-subagents` is not installed: `arc_agent(agent="code-reviewer", task="<filled prompt>")`

**Model tier:** Follow the Model Selection table in `../arc-build/SKILL.md`. For most reviews, omit `model:` so the configured `codeReviewer` profile wins; the agent's `large` frontmatter is the fallback. Escalate only by changing the configured/explicit model when the diff is large, cross-layer, or security-sensitive.
""")


patch_file("skills/arc-summarize/SKILL.md", [
    (
        "**Determine which connected tool can write to the named tracker.** This is not a hardcoded list; reason over what the user has connected.\n\n- **Jira / Atlassian** → Look for a connected **Atlassian MCP server** (authenticate via `/mcp`). Requires cloud instance + API token.\n- **Linear** → Look for a connected **Linear MCP server** (authenticate via `/mcp`). Requires API key.\n- **GitHub / GitHub Issues** → Look for a connected **`gh` CLI** (`gh auth login`). The `gh` CLI is often pre-installed; verify with `gh auth status`.\n- **Other trackers** (Azure DevOps, YouTrack, Plane, etc.) → If an MCP server or CLI wrapper exists and is connected, use it. Otherwise, stop.\n\n**A tracker may expose more than one provider.** The same tracker can be served by different connected sources with different tool namespaces — e.g. Atlassian may appear as a claude.ai connector (`mcp__claude_ai_Atlassian__*`) *and/or* a plugin MCP server (`mcp__plugin_atlassian_atlassian__*`). Reason over the actual tool names available; don't match a single hardcoded server name. **An installed-but-unauthenticated provider is not a usable capability** — if a provider only exposes `authenticate` / `complete_authentication` tools, treat it as unauthenticated and prefer an authenticated provider; if none is authenticated, that is the stop-and-guide case below.",
        "**Determine which connected capability can write to the named tracker.** Do not hardcode an MCP namespace. Use Pi's `mcp` gateway to inspect server status and search available tools by tracker/action, then call the selected tool through the same gateway.\n\n- **Jira / Atlassian** → Search connected MCP tools for Atlassian/Jira issue creation.\n- **Linear** → Search connected MCP tools for Linear issue creation.\n- **GitHub / GitHub Issues** → Prefer an authenticated GitHub MCP tool when present; otherwise verify `gh auth status` and use `gh`.\n- **Other trackers** → Use a connected MCP write tool or authenticated CLI wrapper; otherwise stop.\n\nA server that is installed but unauthenticated is not usable. Prefer an authenticated provider when several exist. If authentication is required, use Pi's MCP authentication flow or tell the user to open `/mcp`; never guess a raw `mcp__...` tool namespace.",
    ),
    (
        "   ```\n   `ask_user_question`:\n   - title: \"What issue type?\"\n   - options: [\"Story\", \"Bug\", \"Task\", \"Other\"]\n   ```",
        "   ```json\n   {\n     \"questions\": [\n       {\n         \"header\": \"Issue type\",\n         \"question\": \"What issue type should be created?\",\n         \"options\": [\n           { \"label\": \"Story (Recommended)\", \"description\": \"Use the tracker's feature-oriented issue type.\" },\n           { \"label\": \"Bug\", \"description\": \"Use the tracker's defect issue type.\" },\n           { \"label\": \"Task\", \"description\": \"Use the tracker's general work-item type.\" }\n         ]\n       }\n     ]\n   }\n   ```",
    ),
    (
        "   ```\n   `ask_user_question`:\n   - title: \"Which project/board?\"\n   - options: [\n       { label: \"BT (Bactrack)\", recommended: true },  # recommended = last_project from cache\n       { label: \"ARCH (Arc)\" },\n       { label: \"Other\" }\n     ]\n   ```",
        "   ```json\n   {\n     \"questions\": [\n       {\n         \"header\": \"Project\",\n         \"question\": \"Which discovered project or board should receive the issue?\",\n         \"options\": [\n           { \"label\": \"BT (Recommended)\", \"description\": \"Use the previously selected Bactrack project.\" },\n           { \"label\": \"ARCH\", \"description\": \"Use the discovered Arc project.\" }\n         ]\n       }\n     ]\n   }\n   ```",
    ),
    (
        "  ```\n  `ask_user_question`:\n  - title: \"Which sprint?\"\n  - options: [\"Sprint 47 (May 20–Jun 2)\", \"Sprint 48 (Jun 3–Jun 16)\", \"Other\"]\n  ```",
        "  ```json\n  {\n    \"questions\": [\n      {\n        \"header\": \"Sprint\",\n        \"question\": \"Which live sprint should receive the issue?\",\n        \"options\": [\n          { \"label\": \"Sprint 47 (Recommended)\", \"description\": \"Use the current active sprint discovered from the tracker.\" },\n          { \"label\": \"Sprint 48\", \"description\": \"Use the next open sprint discovered from the tracker.\" }\n        ]\n      }\n    ]\n  }\n  ```",
    ),
    (
        "**Example — Jira via MCP:**\n```bash\n# Pseudocode; MCP server translates to Jira API\njira_create(\n  project: \"BT\",\n  type: \"Story\",\n  summary: \"OpenCode CLI: Installation Guide\",\n  description: \"<summarized markdown>\",\n  sprint: <resolved_sprint_id>,\n  assignee: <resolved_account_id>,\n  customfield_10014: [\"doc\", \"cli\"]  # labels\n)\n# Returns: { key: \"BT-3014\", id: \"12345\" }\n```",
        "**Example — Jira via Pi's MCP gateway:**\n```text\nmcp({ search: \"Jira create issue\" })\nmcp({\n  tool: \"<discovered-create-tool>\",\n  args: '{\"project\":\"BT\",\"type\":\"Story\",\"summary\":\"OpenCode CLI: Installation Guide\",\"description\":\"<summarized markdown>\",\"sprint\":\"<resolved-sprint-id>\",\"assignee\":\"<resolved-account-id>\",\"labels\":[\"doc\",\"cli\"]}'\n})\n```\n\nUse the exact schema returned by `mcp({ describe: \"<discovered-create-tool>\" })`; the fields above are illustrative, not a raw function call.",
    ),
    (
        "### 6. Map Fields\n\nResolve the tracker fields you need. This requires user input for ambiguous cases — never guess.",
        "### 6. Map Fields\n\nFor ambiguous structured decisions, use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool with the package `questions[]` schema and 2-4 authored options. Do not author sentinel labels such as `Type something.`, `Chat about this`, `Other`, or `Next`; the package supplies escape hatches. Put the recommended option first and append `(Recommended)` when one is clear.\n\nResolve the tracker fields you need. This requires user input for ambiguous cases — never guess.",
    ),
    (
        "**Origin:** arc issue agentmarke-0qex.04hl1w (https://arc.bactrack.com/browse/agentmarke-0qex.04hl1w)",
        "**Origin:** arc issue agentmarke-0qex.04hl1w\n\nInclude an Arc URL only when `arc show` or project configuration provides a canonical base URL; never fabricate a host.",
    ),
    (
        "### 10. Verify — Non-Negotiable\n\n**Re-read the created issue from the tracker.** Confirm that sprint, labels, and assignee actually landed.",
        "### 10. Verify — Non-Negotiable\n\n**Re-read both records.** Fetch the updated Arc issue and confirm its complete prior body plus the new tracker backlink remain present. Then re-read the created external issue and confirm its Arc origin plus sprint, labels, and assignee landed.",
    ),
    (
        "The full current description was already captured in Step 2 (`arc show <id> --json`). To safely backlink, re-supply that **complete existing body** with the tracker link appended, using `--stdin` to avoid shell-escaping or clobbering:\n\n```bash\narc update <arc-id> --stdin <<'EOF'\n<full existing description, unchanged from arc show>\n\n---\n**Tracker:** [BT-3014](https://bactrack.atlassian.net/browse/BT-3014)\nEOF\n```",
        "Preserve the current Arc description mechanically: write it to a temporary file, append only the backlink, then pipe the file back through `--stdin`. Never retype the existing body through the model:\n\n```bash\nTMP=$(mktemp)\narc show <arc-id> --json | jq -j .description > \"$TMP\"\ncat >> \"$TMP\" <<'EOF'\n\n---\n**Tracker:** [BT-3014](https://bactrack.atlassian.net/browse/BT-3014)\nEOF\narc update <arc-id> --stdin < \"$TMP\"\nrm -f \"$TMP\"\n```",
    ),
])

# Copy agents as bundled prompts for arc_agent.
for f in sorted((SRC / "agents").glob("*.md")):
    text = transform_text(f.read_text())
    text = text.replace("  - Bash", "  - bash")
    text = text.replace("  - Read", "  - read")
    text = text.replace("  - Write", "  - write")
    text = text.replace("  - Edit", "  - edit")
    text = text.replace("  - Glob", "  - find")
    text = text.replace("  - Grep", "  - grep")
    text = re.sub(r"(?m)^model:\s*haiku\s*$", "model: small", text)
    text = re.sub(r"(?m)^model:\s*sonnet\s*$", "model: standard", text)
    text = re.sub(r"(?m)^model:\s*opus\s*$", "model: large", text)
    if f.name in {"code-reviewer.md", "devops-builder.md", "evaluator.md", "spec-reviewer.md"}:
        text = re.sub(r"(?m)^model:\s*standard\s*$", "model: large", text)
    if f.name == "doc-writer.md":
        text = text.replace(
            "5. **Commit** with a conventional commit message (e.g., `docs(module): update README`)",
            "5. **Commit** using the VCS detection from `skills/arc/_vcs.md`. If jj is detected, use `jj commit -m \"docs(module): update README\"`; in a colocated repo never use raw Git mutations. Otherwise stage only the documentation files from the task scope with `git add <files>` and run `git commit -m \"docs(module): update README\"`.",
        )
    if f.name == "devops-builder.md":
        text = text.replace(
            "- Never assume you are on a specific git branch — commit IaC changes to whatever branch you find yourself on.",
            "- Never assume a specific VCS context. Detect it via `skills/arc/_vcs.md` and commit IaC changes using the selected branch/bookmark and VCS; in a colocated repo never use raw Git mutations.",
        )
    if f.name == "issue-manager.md":
        text = re.sub(r"(?m)^model:\s*small\s*$", "model: nano", text)
        if "## Timing / Progress Instrumentation" not in text:
            text = text.replace(
                "## Creating Epics with Tasks",
                "## Timing / Progress Instrumentation\n\nFor bulk operations, print lightweight progress lines before and after each phase so the dispatcher can tell whether time is spent in the model or in the Arc CLI:\n\n```bash\nSTART_MS=$(node -e 'console.log(Date.now())')\necho \"[arc-issue-manager] phase=child_tasks status=start\"\n# phase commands here\nEND_MS=$(node -e 'console.log(Date.now())')\necho \"[arc-issue-manager] phase=child_tasks status=done elapsed_ms=$((END_MS-START_MS))\"\n```\n\nUse phase names such as `epic`, `child_tasks`, `dependencies`, `labels`, and `verification`. Include a final `## Timing` section in the summary with per-phase `elapsed_ms` values when available. This instrumentation is informational only; do not add sleeps, polling loops, or extra verification that the manifest did not request.\n\n## Creating Epics with Tasks",
            )
    (ARC_ROOT / "agents" / f.name).write_text(text)

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

replace_section("skills/arc/_branch-check.md", "## jj repos\n\n", "\n## Why no env-var or CLI flag opt-out", """## jj repos

If `skills/arc/_vcs.md` selects **jj**, inspect the working-copy change and bookmark placement before deciding whether the protected condition applies:

```bash
jj st
jj log -r 'trunk() | @ | @-' --no-graph
jj bookmark list
```

The protected condition applies when the session's intended change is based on trunk but is not named by a non-protected feature bookmark. If a non-protected bookmark already names the intended change, proceed. If the protected trunk bookmark itself points at a change containing session edits, do not move it automatically; choose Cancel and ask the user to recover the bookmark explicitly.

For the **Switch to a feature branch** choice, preserve existing work instead of blindly starting a new change:

- If the intended edits are in the current working-copy change `@`, run `jj bookmark create <name> -r @`.
- If `@` is the fresh empty change created by `jj commit` and the completed session work is `@-`, run `jj bookmark create <name> -r @-` (or `jj bookmark move <name> --to @-` when that feature bookmark already exists).
- If `jj st` shows unrelated changes or the correct target is ambiguous, stop and ask the user rather than guessing.

Do **not** use `jj new <trunk>` as a blanket switch remedy after work exists: that creates a new child but leaves the existing edited change where it was. Do **not** move a protected bookmark backward automatically.

The `ask_user_question` choice shape remains Switch / Stay / Cancel. Update its wording to say "your work is based on the `<trunk>` bookmark without a feature bookmark" rather than "you're on `<branch>`":

- **Switch** → create or move only the feature bookmark as described above, then continue.
- **Stay** → continue knowingly without a feature bookmark.
- **Cancel** → stop the skill without committing, dispatching, or writing additional files.
""")

patch_file("skills/arc/_vcs.md", [
    (
        "| Push | `git push` | `jj git push --bookmark feat/x` (or `jj git push -c @` to auto-create a bookmark for the current change) |",
        "| Push completed work | `git push` | after `jj commit`, run `jj bookmark move feat/x --to @-`, then `jj git push --bookmark feat/x` |",
    ),
    (
        "| \"Up to date with origin\" gate | `git status` reports up-to-date | the bookmark equals `feat/x@origin` in `jj log` (compare local vs. remote-tracking) |",
        "| \"Up to date with origin\" gate | `git status` reports up-to-date | compare `jj log -r feat/x -T commit_id --no-graph` with `jj log -r feat/x@origin -T commit_id --no-graph`; IDs must match |",
    ),
    (
        "- `@` (the working-copy commit) *is* a commit; \"uncommitted work\" is already a change. `jj commit` finalizes it and starts a new empty `@`.",
        "- `@` (the working-copy commit) *is* a commit; \"uncommitted work\" is already a change. `jj commit` finalizes it as `@-` and starts a new empty `@`. Move the feature bookmark to `@-` before pushing; do not auto-create a push bookmark on the new empty `@`.",
    ),
])

patch_file("skills/arc/SKILL.md", [
    (
        "- **Parallel Arc build**: For independent task batches, `build` can use worktree-isolated `pi-subagents` runs when that companion package and Arc agent definitions are available. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
        "- **Parallel Arc build**: For independent task batches in Git repositories, `build` can use worktree-isolated `pi-subagents` runs when an external `pi-subagents` extension/tool is installed and Arc specialist definitions are available. Custom Arc specialists remain the preferred `pi-subagents` targets, and generic `worker`/`reviewer` agents should not be substituted for Arc gates. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
    ),
    (
        "- **Stacked PRs (arc + git-spice)**: When the epic is 3+ tasks with linear dependencies and each task is independently reviewable, ship as a stack of PRs instead of one. See [`STACKING.md`](../../STACKING.md) for the integration playbook (concept mapping, per-task loop, review iteration).",
        "- **Stacked change requests**: For 3+ linearly dependent, independently reviewable tasks, use a compatible Pi-native stacking workflow if one is installed. This package does not bundle the Claude marketplace's `git-spice` or `jj-spice` plugins; otherwise use the normal sequential `build` path.",
    ),
    (
        "Work is NOT done until `git push` succeeds.",
        "Work is NOT done until the selected VCS push succeeds.",
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
        "**Example — full approach write-ups as text, then:**\n```\nQuestion: \"Which approach should we go with?\"\nOptions:\n  - \"A: <short name>\" (recommended — <one-line reason>)\n  - \"B: <short name>\" (<one-line trade-off>)\n  - \"C: <short name>\" (<one-line trade-off>)\n```",
        "**Example — after presenting the full approach write-ups as text:**\n```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Approach\",\n      \"question\": \"Which approach should we go with?\",\n      \"options\": [\n        {\n          \"label\": \"Approach A (Recommended)\",\n          \"description\": \"Recommended for the reasons analyzed above.\"\n        },\n        {\n          \"label\": \"Approach B\",\n          \"description\": \"Choose the second approach analyzed above.\"\n        },\n        {\n          \"label\": \"Approach C\",\n          \"description\": \"Choose the third approach analyzed above.\"\n        }\n      ]\n    }\n  ]\n}\n```",
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
        "```\nQuestion: \"Register this design on the planner for review?\"\nOptions:\n  - \"Register on the planner\" — comment thread at /planner/<id>\n  - \"Save for later\" — keep the local file (from step 5.5) and stop\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Review\",\n      \"question\": \"Register this design on the planner for review?\",\n      \"options\": [\n        {\n          \"label\": \"Register (Recommended)\",\n          \"description\": \"Create a local planner comment thread at /planner/<id>.\"\n        },\n        {\n          \"label\": \"Save for later\",\n          \"description\": \"Keep the local design file and stop without registering it.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "```\nQuestion: \"Design ready for review at <url> — how would you like to proceed?\"\nOptions:\n  - \"Approve\" — proceed to step 8 routing analysis\n  - \"Pull review comments\" — fetch feedback, apply edits, repeat\n  - \"Pause review\" — design is saved; resume in a new session\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Review\",\n      \"question\": \"Design ready for review at <url> — how would you like to proceed?\",\n      \"options\": [\n        {\n          \"label\": \"Approve\",\n          \"description\": \"Approve the design and continue to routing analysis.\"\n        },\n        {\n          \"label\": \"Pull comments\",\n          \"description\": \"Read planner feedback, apply edits, re-register if needed, and repeat review.\"\n        },\n        {\n          \"label\": \"Pause review\",\n          \"description\": \"Leave the design saved in docs/plans and resume later.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "```\nQuestion: \"Design approved! What's next?\"\nOptions:\n  - \"Break into tasks with /arc-plan\" (recommended — <brief reason from analysis>)\n  - \"Implement directly with /arc-build\" (for small, single-task work)\n  - \"Done for now\" (design is saved — continue in a new session)\n```",
        "```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Next\",\n      \"question\": \"Design approved! What's next?\",\n      \"options\": [\n        {\n          \"label\": \"Break into tasks (Recommended)\",\n          \"description\": \"Recommended when the design has multiple work items, shared contracts, multiple layers, migrations, breaking changes, or medium/large scale.\"\n        },\n        {\n          \"label\": \"Implement directly\",\n          \"description\": \"Use only for small designs with one work item, one layer, no shared contracts, and no risk areas.\"\n        },\n        {\n          \"label\": \"Done for now\",\n          \"description\": \"The design is approved and saved; continue with /arc-plan in a future session.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
    (
        "First create a single self-contained task capturing the approved design by piping the design doc directly: `arc create \"<title>\" -t task --stdin < docs/plans/<file>.md` (file redirection keeps the description byte-exact — never retype or summarize it, and don't route long content through a subagent prompt).",
        "First canonicalize the approved design to match Arc's outer-whitespace normalization, then create one self-contained task without passing the body through the model: `TMP=$(mktemp); python3 -c 'from pathlib import Path; import sys; Path(sys.argv[2]).write_text(Path(sys.argv[1]).read_text().strip())' docs/plans/<file>.md \"$TMP\"; arc create \"<title>\" -t task --stdin < \"$TMP\"; rm -f \"$TMP\"`.",
    ),
])

replace_section("skills/arc-build/SKILL.md", "## Model Selection\n\n", "\n## Dispatch Modes", """## Model Selection

Every Arc subagent dispatch can override the subagent's frontmatter model via the `model:` parameter. `modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json` are the preferred way to choose role-specific models, and `arc.modelTiers` is a legacy fallback for older setups. GPT-5.6 maps naturally onto Arc's roles: Luna for fast/affordable work, Terra for balanced implementation, and Sol for high-risk reasoning. The dedicated `devopsBuilder` profile uses Sol because live-system changes require blast-radius, staging, and rollback judgment. Before dispatching, assess the task size/risk and choose the smallest model tier that is likely to succeed. The default floor per agent is set in frontmatter — use overrides to downgrade trivial tasks or escalate complex/high-risk tasks.

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.6-luna` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.6-luna` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.6-terra` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.6-sol` | Cross-cutting, architectural, security-sensitive, or adversarial review |

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
      "nano": "openai-codex/gpt-5.6-luna",
      "small": "openai-codex/gpt-5.6-luna",
      "standard": "openai-codex/gpt-5.6-terra",
      "large": "openai-codex/gpt-5.6-sol"
    }
  }
}
```

Legacy aliases still resolve for compatibility: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. Prefer the Pi-native tier names in new prompts, including `nano` for low-reasoning issue-manager work.

Arc specialists should be auto-materialized by the Arc extension when `pi-subagents` is installed. If `subagent({ action: "list" })` does not show `arc-builder` or another required specialist, first run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command. Otherwise use the bundled `arc_agent` fallback. `arc_agent` is self-contained and sequential only; an external `pi-subagents` install adds chains, async runs, and worktree-isolated parallel patch generation.

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
arc_agent(agent="builder", model="small", task="...")       # mechanical
arc_agent(agent="builder", task="...")                      # standard default
arc_agent(agent="builder", model="large", task="...")       # complex

# Preferred when pi-subagents Arc agents are installed:
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-luna", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-terra", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-sol", context: "fresh", async: true, clarify: false })
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
- Arc agent definitions such as `arc-builder` / `arc-doc-writer` are auto-materialized for `pi-subagents`
- 3+ independent tasks remain, or one high-risk evaluator needs a disposable worktree
- No shared files between any builder/doc-writer tasks in the batch
- No `blocks`/`blockedBy` dependencies between tasks in the batch
- Each task's scope is clearly defined with no ambiguity

`pi-subagents` worktree mode returns per-task patch files and cleans up temporary worktrees. It does **not** automatically merge changes into the main working tree. The orchestrator must inspect, apply, verify, commit, and close each patch/task explicitly.

**When NOT to use parallel**: missing `subagent` tool, missing Arc agent definitions, `devops` tasks that touch live systems, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel patch merge is data loss.

## Orchestration Loop

Start here by checking whether the plan's `Parallel Batch Manifest` can be dispatched in parallel.

### 0. Choose Dispatch Mode

Inspect the plan's `Parallel Batch Manifest` first. If it yields a ready batch and the gates below pass, dispatch that batch through [Parallel Patch Protocol](#parallel-patch-protocol). Otherwise, continue with sequential dispatch.

**Task tracking**: At the start of implementation, create a task list using the bundled `todo` checklist (via `todo` tool / `/todos`) with one entry per arc issue to implement. This provides a visible progress tracker in the CLI. Update each task as you work:
- `in_progress` when dispatching the subagent
- `completed` when the task is closed in arc

```bash
# Get every unfinished child, including resumed/blocked/deferred work
arc list --parent=<epic-id> --json | jq '.[] | select(.status != "closed")'
```

If you were handed an epic ID, use its children. If you were handed one standalone task ID from the brainstorm-direct path, use `arc ready` / `arc show <task-id>` and run the loop once. If no Arc task exists, stop and route the user to `/arc-plan`; build dispatches existing tasks and does not invent them.

Create a `todo` checklist entry for each, then work through this loop:
""")

replace_section("skills/arc-build/SKILL.md", "### 3. Dispatch Agent\n\n", "\n### 4. Evaluate Result", """### 3. Dispatch Agent

Record the current HEAD before dispatching — needed for review if escalated:

```bash
PRE_TASK_SHA=$(git rev-parse HEAD)
```

Fetch the design excerpt once for the implementer, evaluator, and code reviewer:

```bash
PARENT=$(arc show <task-id> --json | jq -r '.parent_id // empty')
[ -n "$PARENT" ] && arc show "$PARENT"
```

Extract the sections relevant to this task into `{DESIGN_EXCERPT}`. If the task has no parent epic, use `none`.

Check task labels with precedence `docs-only` → `devops` → `builder`:

```bash
arc show <task-id> --json | jq -e '.labels[] | select(. == "docs-only")' > /dev/null 2>&1
arc show <task-id> --json | jq -e '.labels[] | select(. == "devops")' > /dev/null 2>&1
```

**If `docs-only`** — use `./doc-writer-prompt.md` and dispatch:
- Preferred: `subagent({ agent: "arc-doc-writer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- Fallback: `arc_agent(agent="doc-writer", task="<filled prompt>")`

**Else if `devops`** — use `./devops-builder-prompt.md`, filling `{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`, and `{MODEL_TIER_NOTE}`. The `devopsBuilder` model profile is recommended at the `large` tier because operations work has live blast radius and partial-failure modes. Dispatch:
- Preferred: `subagent({ agent: "arc-devops-builder", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- Fallback: `arc_agent(agent="devops-builder", task="<filled prompt>")` (the configured `devopsBuilder` profile is authoritative; `large` frontmatter is the fallback)

The devops builder follows PLAN → SAFEGUARD → APPLY → VERIFY → GATE. Never route `devops` tasks through the normal TDD builder, and never include live-system operations tasks in a parallel patch batch.

**Otherwise** — use `./builder-prompt.md`, filling `{TASK_ID}`, `{PRE_TASK_SHA}`, and `{DESIGN_EXCERPT}`. Dispatch:
- Preferred: `subagent({ agent: "arc-builder", task: "<filled prompt>", model: "<concrete-model-if-needed>", context: "fresh", async: true, clarify: false })`
- Fallback: `arc_agent(agent="builder", task="<filled prompt>", model="<tier-if-needed>")`

Arc specialists should already be auto-materialized. If a required specialist is missing, first run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.

For async `pi-subagents` dispatches, capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, and read the final output before validation.
""")

replace_section("skills/arc-build/SKILL.md", "Dispatch `spec-reviewer`:\n\n", "\nHandle results:", """Dispatch `spec-reviewer`:

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="spec-reviewer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before handling compliance results.

Do **not** substitute the generic `worker` or `reviewer` agent for spec compliance gates. Generic `pi-subagents` agents are not Arc specialists, and manually passing an Anthropic model bypasses Arc's Pi-native model tier policy. If Arc `pi-subagents` definitions are unavailable, use the bundled sequential `arc_agent` fallback.
""")

patch_file("skills/arc-build/SKILL.md", [
    (
        "Every `builder` and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:",
        "Every `builder`, `devops-builder`, and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:",
    ),
    (
        "Spec review is a focused comparison task — the Arc `standard` tier is appropriate unless the spec is unusually large or ambiguous.",
        "The configured `specReviewer` profile is authoritative; the agent's `large` frontmatter is the fallback.",
    ),
    (
        "# or for a specific epic:\narc list --parent=<epic-id> --status=open",
        "# or for a specific epic, include resumed/blocked/deferred children:\narc list --parent=<epic-id> --json | jq '.[] | select(.status != \"closed\")'",
    ),
    (
        "### 10. Epic Completion Gate\n\nClosing the last task is not the same as the epic being done.",
        "### 10. Completion Gate\n\nFor a standalone task, verify its task-specific command (or live `## Verification` for DevOps), confirm it is closed, skip all epic-only commands, and hand off to `finish`.\n\nFor an epic, closing the last selected task is not the same as the epic being done.",
    ),
    (
        "1. **All tasks closed:** `arc list --parent=<epic-id> --status=open` returns nothing.\n2. **Full suite green:** run the project's full test command (not a per-task subset) and confirm exit 0.",
        "1. **All tasks closed:** `arc list --parent=<epic-id> --json | jq '[.[] | select(.status != \"closed\")] | length'` returns `0`. Any `open`, `in_progress`, `blocked`, or `deferred` child keeps the epic open.\n2. **Epic-wide verification:** for code/docs epics, run the project's full test command and confirm exit 0. For DevOps-only epics, re-run each task's live `## Verification` and confirm rollback evidence; for mixed epics, run both.",
    ),
    (
        "Choose the manifest-driven parallel path first; if the batch is not ready, fall back to sequential dispatch.",
        "Determine the repository VCS first using `skills/arc/_vcs.md`. Pi's managed `pi-subagents` patch isolation currently requires Git worktrees. If VCS detection selects jj (including colocated repositories), use sequential dispatch and jj mutations; do not invoke `worktree: true`. For Git, choose the manifest-driven parallel path first and fall back to sequential dispatch when the batch is not ready.",
    ),
    (
        "Parallel worktree dispatch is available **only** through an installed `pi-subagents` extension/tool, not through `arc_agent`. Use it only when ALL of these are true:\n- `pi-subagents` loaded and the `subagent` tool is available",
        "Parallel worktree dispatch is available **only** through an installed `pi-subagents` extension/tool, not through `arc_agent`, and only when `skills/arc/_vcs.md` selects Git. Use it only when ALL of these are true:\n- VCS detection selects Git, not jj (including colocated repositories)\n- `pi-subagents` loaded and the `subagent` tool is available",
    ),
    (
        "**When NOT to use parallel**: missing `subagent` tool, missing Arc agent definitions, `devops` tasks that touch live systems, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks.",
        "**When NOT to use parallel**: VCS detection selects jj, missing `subagent` tool, missing Arc agent definitions, `devops` tasks that touch live systems, overlapping files, task dependencies, uncertainty about scope, or fewer than 3 implementation tasks.",
    ),
    (
        "Use this protocol only with `pi-subagents` worktree mode. Do **not** use `arc_agent(isolation=\"worktree\")`; `arc_agent` intentionally remains sequential-only.",
        "Use this protocol only when `skills/arc/_vcs.md` selects Git and `pi-subagents` managed worktree mode is available. The managed handoff is Git-specific: if VCS detection selects jj, use the sequential path instead of recreating upstream's Claude-only manual jj-workspace dispatch. Do **not** use `arc_agent(isolation=\"worktree\")`; `arc_agent` intentionally remains sequential-only.",
    ),
    (
        "When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run.",
        "When `pi-subagents` is available and `skills/arc/_vcs.md` selects Git, dispatch the evaluator through a one-task worktree-isolated parallel run.",
    ),
    (
        "If `pi-subagents` or `arc-evaluator` is not available, fall back to sequential `arc_agent(agent=\"evaluator\", task=\"<filled evaluator prompt>\")`.",
        "If VCS detection selects jj, or if `pi-subagents` / `arc-evaluator` is unavailable, fall back to sequential `arc_agent(agent=\"evaluator\", task=\"<filled evaluator prompt>\")`.",
    ),
    (
        "Because this runs in the main checkout, require the evaluator to remove every temporary test, dependency, and build-file edit and verify `git status --short` matches its pre-evaluation baseline before returning.",
        "Because this runs in the main checkout, require the evaluator to remove every temporary test, dependency, and build-file edit and verify the selected VCS status (`git status --short` or `jj st`) matches its pre-evaluation baseline before returning.",
    ),
    (
        "Work is not done until `git push` succeeds.",
        "Work is not done until the selected VCS push succeeds.",
    ),
])

patch_file("skills/arc-plan/SKILL.md", [
    (
        "**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
        "**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. Model profile: issue creation uses the issueManager profile when configured via `/arc-models`; otherwise it falls back to the legacy tier/frontmatter behavior. This work is mostly CLI formatting, so the recommended profile uses gpt-5.6-luna with thinking off. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.",
    ),
    (
        "Then dispatch the manifest — titles, metadata, and file paths only, no description bodies:\n\n```\nUse the arc_agent tool with agent=\"issue-manager\":\n\nCreate the following epic and tasks using the arc CLI.",
        "Before persistence, self-review the canonical description files against the approved design:\n\n1. **Spec coverage:** Every design requirement maps to a task.\n2. **Success-criteria coverage:** Every `## Success Criteria` item maps to at least one task's `## Expected Outcome`.\n3. **T0 contract coverage:** Shared contract blocks match the T0 definitions exactly.\n4. **Type consistency:** Names and signatures agree across tasks.\n5. **Placeholder scan:** No TBD/TODO/vague implementation placeholders remain.\n6. **Step completeness:** Every code or command step includes concrete content.\n\nFix the canonical files now, then repeat this review. Do not create any Arc issue until it passes.\n\nIssue creation must be phased:\n\n1. Create the epic first and capture the epic ID.\n2. Create all child tasks with the epic as parent before applying dependencies.\n3. Capture the complete task-name-to-ID table.\n4. Apply dependencies only after all child IDs exist.\n5. Apply labels after dependencies with `arc update <id> --label-add=<label>`.\n6. Verify descriptions and return the final ID table, dependency summary, and a `## Timing` section with phase-level `elapsed_ms` values.\n\nThen dispatch the manifest — titles, metadata, and file paths only, no description bodies. Prefer true `pi-subagents` so long issue-creation runs are visible in `/subagents-status`:\n\nDispatch preference:\n- Primary: `subagent({ agent: \"arc-issue-manager\", task: \"<manifest below>\", context: \"fresh\", async: true, clarify: false })`\n- Wait for terminal status by polling `subagent({ action: \"status\", id: \"<run-id>\" })` until `completed` or `failed`\n- Users can monitor progress via `/subagents-status`\n- If `subagent({ action: \"list\" })` shows `arc-issue-manager`, do **not** use the slower `arc_agent(agent=\"issue-manager\")` fallback\n- If it is missing, run `subagent({ action: \"doctor\" })` and inspect Arc's materialization warning; use `/arc-subagents-sync` only as a deprecated repair command\n- Fallback only when `pi-subagents` is unavailable after repair: `arc_agent(agent=\"issue-manager\", task=\"<manifest below>\")`\n\nUse this task payload for whichever dispatcher you choose:\n\n```markdown\nCreate the following epic and tasks using the arc CLI.",
    ),
    (
        "- Create every issue with its description piped from the listed file:\n  arc create \"<title>\" --type=<type> [--parent=<id>] [--label=<label>] --stdin < \"<description file>\"",
        "- Create the epic first, then create every child with its description piped from the listed file:\n  arc create \"<title>\" --type=<type> [--parent=<id>] --stdin < \"<description file>\"\n- Create all children and capture every ID before applying dependencies.\n- Apply dependencies only after all child IDs exist.\n- Apply manifest labels only after dependencies with `arc update <id> --label-add=<label>`.",
    ),
    (
        "| Epic | ...    | ...   | ...        | ...       |\n| T1   | ...    | ...   | ...        | ...       |\n```",
        "| Epic | ...    | ...   | ...        | ...       |\n| T1   | ...    | ...   | ...        | ...       |\n\n## Timing\n| Phase | elapsed_ms |\n|-------|------------|\n| epic | ... |\n| child_tasks | ... |\n| dependencies | ... |\n| labels | ... |\n| verification | ... |\n```\n\nThe `## Timing` section is required for bulk issue creation; use `unknown` only when a phase timestamp could not be captured.",
    ),
    (
        "Labels are applied at creation time via the repeatable `--label` flag — never as a separate follow-up pass that can be skipped.",
        "Keep `Labels:` in the manifest, but apply labels only after dependencies with `arc update <id> --label-add=<label>` so the phased creation contract remains observable and recoverable.",
    ),
    (
        "Counts must match (±1 for a trailing newline). For tasks with code blocks (T0 especially), also compare code-fence counts — ``grep -c '^```' <file>`` vs the same grep over `arc show <id> --json | jq -r .description`. A summarized description is a plan failure — detail dropped here is detail the implementer never sees.",
        "First compare byte hashes: `sha256sum < \"<description file>\"` must equal `arc show <id> --json | jq -j .description | sha256sum`. Line counts and, for T0, code-fence counts are diagnostics only. Any hash mismatch is a plan failure — repair with file redirection and re-check before continuing.",
    ),
    (
        "**Never put description content in the agent prompt — descriptions travel as files.** Any content that passes through the subagent's prompt or output gets re-emitted token-by-token, and smaller models compress long content when re-emitting it, *even when explicitly told not to*. The defense is mechanical, not instructional: write each description to a file, and the agent pipes it into arc with shell redirection (`--stdin < file`) so the bytes never flow through the model.",
        "**Never put description content in the agent prompt — descriptions travel as canonical files.** Arc normalizes leading/trailing whitespace from `--stdin`, so canonicalize each file with outer whitespace removed before dispatch. The issue-manager then transfers those canonical bytes with shell redirection; description bodies never pass through the model.",
    ),
    (
        "1. Create a manifest directory: `mkdir -p /tmp/arc-manifest-<epic-slug>`\n2. Write each task's full self-contained description to its own file with the `write` tool: `/tmp/arc-manifest-<epic-slug>/T0.md`, `T1.md`, … You authored these descriptions, so writing them yourself is verbatim by construction.\n3. The **epic's** description file is the plan file itself. You typically already have its path from the brainstorm hand-off; if you only have the ID, `arc plan show` prints it in its metadata header:\n\n```bash\narc plan show <id> | grep -oE '^File: \\S+' | awk '{print $2}'\n```",
        "1. Create a manifest directory: `mkdir -p /tmp/arc-manifest-<epic-slug>`.\n2. Write every task's full self-contained draft to `/tmp/arc-manifest-<epic-slug>/T0.md`, `T1.md`, and so on with the `write` tool.\n3. Copy the approved plan to `/tmp/arc-manifest-<epic-slug>/epic.md`. If only the plan ID is known, recover the source path with `arc plan show <id> | grep -oE '^File: \\S+' | awk '{print $2}'`.\n4. Canonicalize only outer whitespace so the files match Arc's `--stdin` normalization while preserving every internal byte:\n   ```bash\n   python3 - /tmp/arc-manifest-<epic-slug> <<'PY'\n   from pathlib import Path\n   import sys\n   for path in Path(sys.argv[1]).glob('*.md'):\n       path.write_text(path.read_text().strip())\n   PY\n   ```\n5. From this point onward, hash, dispatch, repair, and verify only these canonical files.",
    ),
    (
        "Description file: <absolute path to the plan markdown file>",
        "Description file: /tmp/arc-manifest-<epic-slug>/epic.md",
    ),
    (
        "- After each create, verify the description landed verbatim:\n  arc show <id> --json | jq -r .description | wc -l\n  must match `wc -l < \"<description file>\"` (±1 for a trailing newline).\n  Report any mismatch in your summary — do not silently continue.",
        "- After each create, verify the stored description equals the canonical file:\n  `sha256sum < \"<description file>\"` must equal\n  `arc show <id> --json | jq -j .description | sha256sum`.\n  Treat any mismatch as a failed verification phase; repair from the canonical file and re-check.",
    ),
    (
        "| Task | Arc ID | Title | File lines | Arc lines |\n|------|--------|-------|------------|-----------|",
        "| Task | Arc ID | Title | File SHA-256 | Arc SHA-256 |\n|------|--------|-------|-------------|------------|",
    ),
    (
        "**Use the `ask_user_question` tool** to let the user choose:\n\n```\nQuestion: \"Epic and tasks created. How should we proceed with implementation?\"\nOptions:\n  - \"Start implementing now\" (invoke /arc-build in this session — subagents handle TDD per task)\n  - \"Implement in a new session\" (provides the exact prompt to use)\n  - \"Done for now\" (tasks are tracked in arc — implement manually or later)\n```",
        "**Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool** with the package `questions[]` schema to let the user choose. Do not manually author package sentinel labels (`Type something.`, `Chat about this`, `Other`, `Next`):\n\n```json\n{\n  \"questions\": [\n    {\n      \"header\": \"Next\",\n      \"question\": \"Epic and tasks created. How should we proceed with implementation?\",\n      \"options\": [\n        {\n          \"label\": \"Start now (Recommended)\",\n          \"description\": \"Continue directly into /arc-build in this session.\"\n        },\n        {\n          \"label\": \"New session\",\n          \"description\": \"Print the exact /arc-build <epic-id> command for a fresh Pi session.\"\n        },\n        {\n          \"label\": \"Done for now\",\n          \"description\": \"Leave the tasks tracked in arc for future implementation.\"\n        }\n      ]\n    }\n  ]\n}\n```",
    ),
])

replace_section(
    "skills/arc-plan/SKILL.md",
    "### 6.5. Self-Review\n\n",
    "\n### 7. Choose Execution Path",
    "",
)

replace_section(
    "skills/arc-plan/SKILL.md",
    "Example skeleton:\n\n",
    "\n## Rules",
    """Example skeleton:

```markdown
## Summary
Upgrade the staging `payments` Helm release with a staged, reversible rollout.

## Target
Cluster context: `arn:aws:eks:us-east-1:123456789012:cluster/staging-eks`; namespace: `payments`; release: `payments`.

## Files
- Modify: `deploy/values-staging.yaml`

## Safeguards
- `kubectl config current-context` must equal the target context above.
- `PREV_REV=$(helm history payments -n payments -o json | jq -r 'map(.revision) | max')`
- `helm get values payments -n payments -o yaml > /tmp/payments-values-before.yaml`

## Steps
1. Preview: `helm diff upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml` and confirm only the intended image/config changes appear.
2. Apply with rollback-on-failure: `helm upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml --atomic --timeout 10m`.
3. Observe: `kubectl rollout status deployment/payments -n payments --timeout=10m`.

## Verification
- `helm diff upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml` → empty diff.
- `kubectl get deployment payments -n payments -o jsonpath='{.status.readyReplicas}/{.status.replicas}'` → equal counts.
- `kubectl get pods -n payments` → no `CrashLoopBackOff` or `ImagePullBackOff`.

## Rollback
`helm rollback payments "$PREV_REV" -n payments --wait --timeout 10m`; verify rollout and pod health again.

## Expected Outcome
The staging release converges to the intended chart values, all replicas are Ready, the post-apply diff is empty, and the recorded prior revision remains available for rollback.
```

The task must contain concrete target values and executable commands like this example. If the provider has no preview/change-set mechanism or the recovery path cannot be verified, stop for explicit authorization rather than weakening the dry-run/rollback law.
""",
)

insert_before_if_missing("skills/arc-plan/SKILL.md", "\n## Task Description Format\n", """## Parallel Readiness

When a design can split into parallel implementation batches, document the readiness proof before handing off tasks.

### T0 Foundation Decision

State whether the design needs a T0 foundation task. If shared contracts, shared constants, or any other multi-task interface are referenced by more than one task, create T0 first and block every dependent parallel batch on it.

### File Ownership Matrix

Do not mark any task parallelizable until this matrix is complete and every file is owned by exactly one task.

| Task | Owns files | Reads files | Overlap handling |
|---|---|---|---|

### Parallel Batch Manifest

Group only disjoint tasks into parallel batches after file ownership is settled. Never place a `devops` task or other live-system mutation in a parallel batch; those tasks must remain sequential.

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

**Model tier:** Follow the Model Selection table in `../arc-build/SKILL.md`. Reviews use the `codeReviewer` profile when configured via `/arc-models`; otherwise the agent's `large` frontmatter is the fallback. Omit `model:` so the configured profile remains authoritative. Use an explicit override only for deliberate escalation beyond the configured profile.
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

patch_file("skills/arc-build/references/devops-patterns.md", [
    (
        "| GATE (idempotency) | re-run `--dry-run` → expect no changes |",
        "| GATE (idempotency) | run `helm diff upgrade <release> <chart> -f values.yaml` and expect an empty diff; if the plugin is unavailable, compare `helm template` output with `helm get manifest` |",
    ),
    (
        "For raw CLI mutations with no dry-run, describe the current state first so you have a before/after.",
        "If a raw CLI mutation has no provider-supported preview or change set, STOP and require explicit authorization plus a verified recovery procedure; describing current state alone is not a safe preview.",
    ),
])

patch_file("skills/arc-build/devops-builder-prompt.md", [
    (
        "For tool-specific dry-run / verify / rollback command idioms, Read:",
        "For tool-specific dry-run / verify / rollback command idioms, use `read` on:",
    ),
])

patch_file("agents/devops-builder.md", [
    (
        "if its path was provided in your dispatch prompt, e.g. `Read` `skills/arc-build/references/devops-patterns.md`.",
        "if its path was provided in your dispatch prompt, using `read` on `skills/arc-build/references/devops-patterns.md`.",
    ),
])

replace_section("agents/evaluator.md", "## Sandbox Model\n\n", "\n## Information Asymmetry", """## Sandbox Model

The preferred `pi-subagents` dispatch runs in a disposable git worktree. In that mode you may write acceptance tests, add temporary test dependencies, and modify build configuration; do not commit.

The bundled `arc_agent` fallback runs in the main checkout. In fallback mode:

1. Determine the VCS using `skills/arc/_vcs.md`, then record its status before touching files: `git status --short` for Git or `jj st` for jj. If the selected VCS status is not clean, report `BLOCKED` instead of risking unrelated work.
2. Track every file you create or modify.
3. Run the evaluation.
4. Restore modified tracked files and remove only the temporary files you created.
5. Verify the selected VCS status exactly matches the clean baseline before returning.

Never claim cleanup is unnecessary unless runtime instructions explicitly confirm a disposable Git worktree. Never commit evaluation artifacts.
""")

patch_file("agents/evaluator.md", [
    (
        "Report your findings to the dispatching agent. Do NOT commit or clean up — the worktree is discarded automatically.",
        "Report your findings to the dispatching agent. Do not commit. In a disposable worktree, runtime cleanup handles artifacts; in the `arc_agent` fallback, complete the tracked-file restoration and temporary-file cleanup from the Sandbox Model before reporting.",
    ),
])

patch_file("agents/code-reviewer.md", [
    (
        "Read the project's CLAUDE.md if it exists.",
        "Read the project's AGENTS.md (or legacy CLAUDE.md) if it exists.",
    ),
])

SUPERVISOR_SECTIONS = {
    "agents/builder.md": ("## When Tests Can't Run", "implementation plan"),
    "agents/code-reviewer.md": ("## Rules", "review plan"),
    "agents/devops-builder.md": ("## When Verification Can't Run", "operations plan"),
    "agents/doc-writer.md": ("## Quality Checklist", "documentation plan"),
    "agents/evaluator.md": ("## Rationalizations You Must Reject", "evaluation plan"),
    "agents/issue-manager.md": ("## Output Format", "issue plan"),
    "agents/spec-reviewer.md": ("## Report Format", "review plan"),
}
for rel, (marker, plan_phrase) in SUPERVISOR_SECTIONS.items():
    extra = "Preserve adversarial/read-only expectations and" if rel == "agents/evaluator.md" else "Preserve read-only behavior and" if rel in {"agents/code-reviewer.md", "agents/spec-reviewer.md"} else ""
    if rel in {"agents/builder.md", "agents/devops-builder.md", "agents/doc-writer.md", "agents/issue-manager.md"}:
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

When receiving a manifest from the `plan` or `brainstorm` skills, parse titles, metadata, labels, dependencies, and canonical description-file paths. Arc normalizes outer whitespace from `--stdin`; the planner has already canonicalized these files to match. Never summarize, trim, paraphrase, or retype their content. Transfer canonical bytes only with shell redirection.

Process every manifest in these phases:

1. **Create the epic first** and capture the epic ID.
   ```bash
   arc create "Epic title" --type=epic --stdin < "/path/to/plan.md"
   ```
2. **Create all child tasks** with the epic as parent before applying dependencies. Create them in manifest order; do not claim concurrent Arc writes are safe.
   ```bash
   arc create "Task title" --type=task --parent=<epic-id> --stdin < "/path/to/T1.md"
   ```
3. **Capture the complete task-name-to-ID table** before any dependency command.
4. **Apply dependencies only after all child IDs exist**.
   ```bash
   arc dep add <real-later-id> <real-earlier-id> --type=blocks
   ```
5. **Apply labels after dependencies** using the CLI's repeatable update flag.
   ```bash
   arc update <id> --label-add=docs-only
   arc update <id> --label-add=devops
   ```
6. **Verify every stored description equals its canonical file** and return the final ID table, dependency summary, label summary, and `## Timing` section.
   ```bash
   wc -l < "/path/to/T1.md"
   arc show <id> --json | jq -r .description | wc -l
   ```
   Compare `sha256sum < "/path/to/T1.md"` with `arc show <id> --json | jq -j .description | sha256sum`; the hashes must match. Line counts are diagnostic only. On mismatch, repair mechanically with `arc update <id> --stdin < "/path/to/T1.md"` and re-check.

Print `[arc-issue-manager] phase=<name> status=start|done elapsed_ms=<n>` around `epic`, `child_tasks`, `dependencies`, `labels`, and `verification`. Include all phase values in `## Timing`; use `unknown` only when a timestamp cannot be captured.

**Handling partial failures**: If a task creation fails mid-manifest:
- Continue creating the remaining tasks in order — do not abort the manifest
- Report partial results clearly: "Created 4/5 tasks. T3 failed: `<error message>`"
- Include the ID mapping for all successfully created tasks
- Do not clean up already-created tasks; the dispatcher decides recovery

This is the primary interface used by the `plan` and `brainstorm` skills for bulk issue creation.
""")

patch_file("agents/issue-manager.md", [
    (
        "# With description from a file (preferred for long content — byte-exact):",
        "# With a canonical description file (preferred for long content and lossless internal content):",
    ),
    (
        "# Replace description from a file (preferred for long content — byte-exact):",
        "# Replace description from a canonical file (preserves all internal content):",
    ),
    (
        "- Summarize any errors encountered\n- Provide next steps if applicable",
        "- Summarize any errors encountered\n- Include a `## Timing` section with phase-level elapsed times for bulk operations when available\n- Provide next steps if applicable",
    ),
])


def install_generated_resources() -> None:
    backup_root = Path(tempfile.mkdtemp(prefix=".pi-arc-backup-", dir=REPO_ROOT.parent))
    moved_old: list[str] = []
    installed: list[str] = []
    try:
        for name in ("prompts", "skills", "agents"):
            target = REPO_ROOT / name
            backup = backup_root / name
            staged = ARC_ROOT / name
            if target.exists():
                target.rename(backup)
                moved_old.append(name)
            staged.rename(target)
            installed.append(name)
    except Exception:
        for name in reversed(installed):
            target = REPO_ROOT / name
            if target.exists():
                shutil.rmtree(target)
        for name in reversed(moved_old):
            backup = backup_root / name
            if backup.exists():
                backup.rename(REPO_ROOT / name)
        raise
    finally:
        shutil.rmtree(backup_root, ignore_errors=True)


install_generated_resources()

print(f"Migrated arc plugin resources from {SRC}")
print(f"Package root: {REPO_ROOT}")
print(f"Prompts: {len(list((REPO_ROOT / 'prompts').glob('*.md')))}")
print(f"Skills: {len(list((REPO_ROOT / 'skills').glob('*/SKILL.md')))}")
print(f"Agents: {len(list((REPO_ROOT / 'agents').glob('*.md')))}")
