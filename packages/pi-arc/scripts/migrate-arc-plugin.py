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

patch_file("skills/arc/SKILL.md", [
    (
        "- **Parallel Arc build**: For independent task batches, `build` can use worktree-isolated `pi-subagents` runs when that companion package and Arc agent definitions are available. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
        "- **Parallel Arc build**: For independent task batches, `build` can use worktree-isolated `pi-subagents` runs when an external `pi-subagents` extension/tool is installed and Arc specialist definitions are available. Custom Arc specialists remain the preferred `pi-subagents` targets, and generic `worker`/`reviewer` agents should not be substituted for Arc gates. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.",
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

1. Record `git status --short` before touching files. If it is not clean, report `BLOCKED` instead of risking unrelated work.
2. Track every file you create or modify.
3. Run the evaluation.
4. Restore modified tracked files and remove only the temporary files you created.
5. Verify `git status --short` exactly matches the clean baseline before returning.

Never claim cleanup is unnecessary unless runtime instructions explicitly confirm a disposable worktree. Never commit evaluation artifacts.
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


# Native pi-subagents workflow refresh. Keep these overlays after the older
# compatibility transforms so the pinned source deterministically produces the
# current public execution contract.
NATIVE_PROVIDER_REQUIREMENT = """Delegated Arc work requires loaded, enabled `pi-subagents` and the required Arc specialist. Check `subagent({ action: "list", capabilities: true })` first. Dispatch only executable, non-disabled native Arc agents; never substitute a generic agent for Arc review gates. Diagnose missing materialization with native doctor and existing Arc warnings. `/arc-subagents-sync` remains deprecated explicit repair, not automatic activation. If the requirement is still unmet, stop with setup guidance. `arc_agent` uses the same provider and is not an independent fallback.
"""

NATIVE_COMPLETION_REQUIREMENT = """On notification, inspect native terminal state and final artifacts before interpreting the completed Arc specialist report. Runtime failure, pause, stop, incomplete or malformed result blocks the Arc stage regardless of successful prose. A receipt cannot advance tests, review, patch application or issue closure. Preserve parent verification and review gates.
"""

NATIVE_FAILURE_REQUIREMENT = """Native workflow, launch, extension or child-tooling failure is an infrastructure blocker. Record exact run/status, cwd/worktree/branch/HEAD and partial diff; stop and use only explicit same-protocol recovery. Never switch runner/provider/CLI mode or automatically retry an uncertain dispatch. Do not escalate models merely because the harness failed.
"""

replace_section("skills/arc-build/SKILL.md", "## Model Selection\n\n", "\n## Dispatch Modes", """## Model Selection

Arc model selection resolves in this order: explicit dispatch override → configured `modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json` → legacy `arc.modelTiers` / frontmatter → package defaults. Removing an execution fallback does not remove model fallback. Users should run `/arc-models`; omit `model:` when the configured role profile should remain authoritative.

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.6-luna` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.6-luna` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.6-terra` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.6-sol` | Cross-cutting, architectural, security-sensitive, or adversarial review |

Legacy aliases remain compatible: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. The dedicated `devopsBuilder` profile uses `large`; `issueManager` normally uses `nano`.

""" + NATIVE_PROVIDER_REQUIREMENT + """
A single implementation handoff can use `subagent({ agent: "arc-builder", task: "<filled builder prompt>", context: "fresh", async: true });`; `arc_agent(agent="builder", task="<filled builder prompt>")` is the one-specialist Arc-facing alternative using that same provider. Both return dispatch receipts before completion. Capture the native run reference, then return control for native completion. Do not poll, sleep-loop, or call `bg_wait` merely to wait for ordinary notified runs. Use native status/fleet/transcript only for a deliberate inspection or recovery decision.

""" + NATIVE_COMPLETION_REQUIREMENT + """

""" + NATIVE_FAILURE_REQUIREMENT + """

| Task signal | Dispatch `model:` |
|---|---|
| Bulk issue creation or other low-reasoning Arc CLI operations | `nano` |
| Mechanical: 1-2 files, unambiguous | `small` |
| Standard contained implementation | omit `model:` or use `standard` |
| Cross-layer, architectural, security-sensitive | `large` |
| `NEEDS_CONTEXT` | same model, richer context |

Do not escalate a model merely because execution infrastructure failed. For a genuine reasoning limit, follow the existing bounded tier escalation and stop at `large`.
""")

replace_section("skills/arc-build/SKILL.md", "### 3. Dispatch Agent\n\n", "\n### 4. Evaluate Result", """### 3. Dispatch Agent

Record `PRE_TASK_SHA=$(git rev-parse HEAD)`, fetch the parent design excerpt, and inspect labels. Route with exact precedence `docs-only` → `devops` → normal builder:

- `docs-only`: fill `./doc-writer-prompt.md`; use `arc-doc-writer` (profile `docWriter`).
- `devops`: fill `./devops-builder-prompt.md`; use `arc-devops-builder` (profile `devopsBuilder`). It follows PLAN → SAFEGUARD → APPLY → VERIFY → GATE. Never put live-system work in a parallel patch batch.
- otherwise: fill `./builder-prompt.md`; use `arc-builder` (profile `builder`).

For one handoff, call `subagent({ agent: "<required-arc-agent>", task: "<filled prompt>", context: "fresh", async: true });`. The Arc-facing `arc_agent(agent="<role>", task="<filled prompt>")` alternative is also asynchronous and uses the same provider; for the DevOps route that is `arc_agent(agent="devops-builder", task="<filled prompt>")`. Omit `model:` to preserve the configured profile; use an explicit override only for deliberate model selection.

""" + NATIVE_PROVIDER_REQUIREMENT + """

""" + NATIVE_COMPLETION_REQUIREMENT + """

""" + NATIVE_FAILURE_REQUIREMENT + """

Do not evaluate the specialist report until native completion identifies a terminal successful run and the final result/artifacts are present.
""")

replace_section("skills/arc-build/SKILL.md", "Dispatch `spec-reviewer`:\n\n", "\nHandle results:", """Dispatch `spec-reviewer`:

Fill `./spec-reviewer-prompt.md` with `{TASK_ID}`, `{BASE_SHA}`, and `{HEAD_SHA}`. Preserve review-only behavior. Use `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", context: "fresh", async: true });` or the same-provider Arc-facing `arc_agent(agent="spec-reviewer", task="<filled prompt>")`. Omit `model:` so the configured `specReviewer` profile wins; `large` frontmatter/model fallback remains available.

The call returns a dispatch receipt, not review success. Return control for native completion, then require successful terminal runtime state and a complete final review artifact. Failure, pause, stop, incomplete or malformed output blocks the stage regardless of compliance prose. Do not substitute generic `worker` or `reviewer` agents.
""")

replace_section("skills/arc-build/SKILL.md", "When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run.", "\nTriage evaluator findings:", """Evaluations use explicitly requested native worktree isolation. Record the full SHA with `PARALLEL_BASE=$(git rev-parse HEAD)` from the clean checkpoint as immutable verification evidence, then fill `./evaluator-prompt.md`. Do not pass that commit ID as the native `baseRef`; the launch uses symbolic `HEAD`, resolved at worktree allocation.

Immediately before launch, prove the checkout still matches the recorded SHA:

```bash
test "$(git rev-parse HEAD)" = "$PARALLEL_BASE" || { echo "HEAD moved after evaluator anchor" >&2; exit 1; }
```

```typescript
subagent({
  workflowScript: `return await runs.run("evaluate", { agent: "arc-evaluator", task: "<filled evaluator prompt>", worktree: true, output: "evaluator.md", async: false });`,
  context: "fresh", async: true, globalConcurrencyLimit: 1,
  baseRef: "HEAD",
})
```

The outer workflow remains asynchronous and returns a launch receipt. Setting `async: false` on each awaited inner foreground child is deliberate: pi-subagents can expose the exact worktree handoff manifest path in that child's returned string-array `artifactPaths` for mandatory `baseCommit` validation.

Return control for native completion. Require a successful terminal child result and consume its returned `outputReference`, `outputPathMapping`, or `artifactPaths`; the receipt and evaluator prose alone cannot pass the gate.

After native completion and before accepting or triaging evaluator findings, locate the actual returned path ending in `handoffs/<run-id>.json` in the completed evaluator child result's string-array `artifactPaths`. Set `HANDOFF_MANIFEST` to that exact returned path; never fabricate or infer base identity from current `HEAD`. Fail closed if the path or manifest is missing, unreadable, malformed, empty, or mismatched:

```bash
HANDOFF_MANIFEST='<exact handoffs/<run-id>.json path returned in artifactPaths>'
test -n "$HANDOFF_MANIFEST" && test -r "$HANDOFF_MANIFEST" &&
  jq -e --arg base "$PARALLEL_BASE" \\
    '.version == 1 and (.groups | type == "array") and (.groups | length > 0) and all(.groups[]; (.baseCommit | type == "string") and (.baseCommit | length > 0) and .baseCommit == $base)' \\
    "$HANDOFF_MANIFEST"
```

The command must succeed before the evaluator report is interpreted. Any failure or base mismatch blocks evaluator finding acceptance and requires explicit native inspection/recovery; it is not permission to apply, retry or switch modes.

Ephemeral tests/dependency edits remain isolated and are not commits or merge handoffs. Follow native retention and cleanup facts rather than promising automatic deletion. The configured `evaluator` profile remains authoritative and `large` is its model fallback.
""")

replace_section("skills/arc-build/SKILL.md", "### P4. Dispatch with `pi-subagents`\n\n", "\n### P5. Apply and Verify Patches One at a Time", """### P4. Dispatch with `pi-subagents`

The full SHA recorded earlier with `PARALLEL_BASE=$(git rev-parse HEAD)` is immutable verification evidence for later history and HEAD checks. Do not pass that commit ID as the native `baseRef`; the launch uses symbolic `HEAD`, resolved at worktree allocation.

Immediately before launch, prove the checkout still matches the recorded SHA:

```bash
test "$(git rev-parse HEAD)" = "$PARALLEL_BASE" || { echo "HEAD moved after parallel anchor" >&2; exit 1; }
```

Launch one top-level native workflow for the coordinated wave, with stable keys and declared output bindings:

```typescript
subagent({
  workflowScript: `
    const results = await runs.all([
      { key: "build-a", agent: "arc-builder", task: "<filled builder prompt A>", worktree: true, output: "builder-a.md", async: false },
      { key: "build-b", agent: "arc-builder", task: "<filled builder prompt B>", worktree: true, output: "builder-b.md", async: false },
      { key: "docs", agent: "arc-doc-writer", task: "<filled doc prompt>", worktree: true, output: "docs.md", async: false }
    ]);
    return results;
  `,
  context: "fresh", async: true, globalConcurrencyLimit: 3,
  baseRef: "HEAD",
})
```

The outer workflow remains asynchronous and returns a launch receipt. Setting `async: false` on each awaited inner foreground child is deliberate: pi-subagents can expose the exact worktree handoff manifest path in that child's returned string-array `artifactPaths` for mandatory `baseCommit` validation.

`runs.all` returns the complete ordered array. On native completion, preserve every child result in that order and consume each child's actual `outputReference`, `outputPathMapping`, or `artifactPaths`. A filename mentioned only in prose is not an output binding.

After native completion and before inspecting or applying any parallel patch, locate the actual returned path ending in `handoffs/<run-id>.json` in every relevant child result's string-array `artifactPaths`. Every relevant result must supply that path; validate every distinct returned manifest. Set `HANDOFF_MANIFEST` only from those exact returned paths, never fabricate or infer base identity from current `HEAD`. For each path, fail closed if the path or manifest is missing, unreadable, malformed, empty, or mismatched:

```bash
HANDOFF_MANIFEST='<exact handoffs/<run-id>.json path returned in artifactPaths>'
test -n "$HANDOFF_MANIFEST" && test -r "$HANDOFF_MANIFEST" &&
  jq -e --arg base "$PARALLEL_BASE" \\
    '.version == 1 and (.groups | type == "array") and (.groups | length > 0) and all(.groups[]; (.baseCommit | type == "string") and (.baseCommit | length > 0) and .baseCommit == $base)' \\
    "$HANDOFF_MANIFEST"
```

Every distinct manifest check must succeed, proving `version: 1`, nonempty `groups`, and that every relevant `groups[].baseCommit` equals `$PARALLEL_BASE`. Any failure or base mismatch blocks patch acceptance and requires explicit native inspection/recovery; it is not permission to apply, retry or switch modes.

There is no implicit merge or cleanup: follow the validated native handoff manifest and retention/cleanup facts. A failed, paused, stopped, incomplete, or malformed child blocks its handoff regardless of `DONE` prose, and a rejected handoff is not permission to switch mode.
""")

patch_file("skills/arc-build/SKILL.md", [
    (
        "- Re-dispatch that task sequentially with the failure details.",
        "- Use the native targeted-fix protocol below; do not silently switch execution mode.",
    ),
    (
        "`pi-subagents` worktree mode returns per-task patch files and cleans up temporary worktrees. It does **not** automatically merge changes into the main working tree. The orchestrator must inspect, apply, verify, commit, and close each patch/task explicitly.",
        "Native worktree runs return handoff metadata such as `outputReference`, `outputPathMapping`, or `artifactPaths`. They do not implicitly apply or merge changes. Inspect each handoff and its native retention/cleanup facts, then explicitly apply, verify, commit, and close accepted work.",
    ),
    (
        "Use this protocol only with `pi-subagents` worktree mode. Do **not** use `arc_agent(isolation=\"worktree\")`; `arc_agent` intentionally remains sequential-only.",
        "Use this protocol only for a coordinated `pi-subagents` worktree wave. `arc_agent(isolation=\"worktree\")` supports one child through the same provider, not a coordinated multi-child wave.",
    ),
    (
        "This is the baseline all temporary worktrees will branch from. Record it — you'll need it for verification after patch application.",
        "This full SHA is immutable verification evidence for later history and HEAD checks, not the native `baseRef`. Immediately before worktree allocation, verify symbolic `HEAD` still resolves to it.",
    ),
    (
        "When the subagent reports back, check its **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Implementer Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the subagent's report alone.",
        "After native completion confirms successful terminal runtime state and final artifacts, interpret the completed Arc specialist report's **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Implementer Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the specialist report alone.",
    ),
    (
        "Every `builder`, `devops-builder`, and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:",
        "After native completion/runtime success is established, interpret each completed `builder`, `devops-builder`, or `doc-writer` Arc specialist report as one of four statuses. Handle each explicitly:",
    ),
    (
        "- When re-dispatching after `BLOCKED`, escalate one model tier per the Model Selection table — never retry the same dispatch unchanged",
        "- Classify every `BLOCKED` report before choosing a response. Only a verified reasoning-limit blocker may escalate one model tier. Infrastructure or tooling failures must stop for same-protocol diagnosis or recovery without model escalation; context, scope, or plan blockers follow their specific handling above.",
    ),
    (
        "- For `BLOCKED`: assess the blocker per the Handle Implementer Status table. Escalate one model tier (`nano` → `small` → `standard` → `large`) per the Model Selection escalation rule, or invoke the `debug` skill if the blocker is a persistent test failure, or split the task if too large, or escalate to the human.",
        "- For `BLOCKED`: classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths.",
    ),
    (
        "| `BLOCKED` | Evaluator itself is blocked. Escalate per the Model Selection rules or involve the human. |",
        "| `BLOCKED` | Classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths. |",
    ),
    (
        "| `BLOCKED` | Assess the blocker: (1) context problem → provide missing context, re-dispatch same tier; (2) reasoning limit → re-dispatch one tier up per the Model Selection escalation rule; (3) task too large → split and re-plan; (4) plan is wrong → escalate to human. Never retry the same dispatch unchanged. |",
        "| `BLOCKED` | Classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths. Never retry an eligible dispatch unchanged. |",
    ),
    (
        "fetch it per step 3's design-context block",
        "retrieve it directly with `arc show <parent-epic-id>` and use \"none\" when no parent design context exists",
    ),
])
insert_before_if_missing("skills/arc-build/SKILL.md", "\n## When to Invoke Debug", """## Targeted Fix and Recovery

For a requested repair, consult native retained-child/resumability information. If the appropriate latest writer is resumable, use `subagent({ action: "resume", id: "<native-run-id>", message: "<specific verified fixes>" });`; for a live child use native steering. Capture the returned native identity. Do not fabricate continuity or implement Arc session validation. If native recovery is unavailable, stop for an explicit same-protocol fresh attempt with current scope and prior findings. Reviews remain fresh independent Arc specialist runs. Keep existing fix-cycle limits.

A recovery result must pass the same native terminal-state, artifact, parent-test, spec-review, and code-review gates. Provider failure is not a reasoning failure and does not justify model escalation.

""", "## Targeted Fix and Recovery")

replace_section("skills/arc-plan/SKILL.md", "Then dispatch the manifest — titles, metadata, and file paths only, no description bodies.", "\nUse this task payload for whichever dispatcher you choose:", """Then dispatch the manifest — titles, metadata, and canonical file paths only, never description bodies.

""" + NATIVE_PROVIDER_REQUIREMENT + """

Use the `arc-issue-manager` as one direct child and omit `model:` so its configured profile remains authoritative:

`subagent({ agent: "arc-issue-manager", task: "<filled manifest metadata and canonical file paths>", context: "fresh", async: true });`

The Arc-facing `arc_agent(agent="issue-manager", task="<filled manifest metadata and canonical file paths>")` alternative uses the same provider. Either call returns only a dispatch receipt. Capture the native run reference and return control for native completion; do not poll merely to wait. Only after successful terminal runtime state and final artifacts may the parent verify canonical description hashes, phase ordering, IDs, dependencies, labels, and timing. Unknown or malformed completion blocks issue acceptance; never issue a duplicate launch automatically.

""" + NATIVE_COMPLETION_REQUIREMENT + """

""" + NATIVE_FAILURE_REQUIREMENT)

replace_section("skills/arc-review/SKILL.md", "### 3. Dispatch Reviewer\n\n", "\n### 4. Triage Feedback", """### 3. Dispatch Reviewer

Fill `./code-reviewer-prompt.md` with `{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESIGN_EXCERPT}`, and `{EVALUATOR_STATUS}`. Preserve `Review only; return findings only. Do not edit files.`

""" + NATIVE_PROVIDER_REQUIREMENT + """

Dispatch one fresh review with `subagent({ agent: "arc-code-reviewer", task: "<filled reviewer prompt>", context: "fresh", async: true });` or the same-provider Arc-facing `arc_agent(agent="code-reviewer", task="<filled reviewer prompt>")`. Omit `model:` so `codeReviewer` profile precedence and its model fallback remain authoritative. Either call returns only a dispatch receipt. Capture the native run reference and return control for native completion; do not poll merely to wait.

""" + NATIVE_COMPLETION_REQUIREMENT + """

""" + NATIVE_FAILURE_REQUIREMENT + """

Require successful terminal runtime state and a complete final review artifact before triage. Never infer a clean review from a launch receipt, missing findings, or successful prose attached to a failed/paused/stopped/incomplete/malformed run. Reviews after fixes are fresh independent `arc-code-reviewer` runs.
""")

replace_section("skills/arc/SKILL.md", "## Agent Mode\n\n", "\n## Dependency Types", """## Agent Mode

For bulk operations, use the `arc-issue-manager` specialist. Non-delegating Arc commands continue without `pi-subagents`; every delegated specialist requires loaded, enabled `pi-subagents`.

""" + NATIVE_PROVIDER_REQUIREMENT + """

Issue-manager dispatch is a direct single-child handoff: `subagent({ agent: "arc-issue-manager", task: "<filled manifest metadata and canonical file paths>", context: "fresh", async: true });`. Omit `model:` so the configured profile remains authoritative. Capture the receipt's native run reference, return control for native completion, and inspect final runtime state and artifacts before interpreting the specialist report.

""" + NATIVE_COMPLETION_REQUIREMENT + """

""" + NATIVE_FAILURE_REQUIREMENT + """

Coordinated build waves use one `workflowScript`; Arc does not implement scheduling, session, worktree, lifecycle, cancellation, completion-notification, or cleanup machinery already owned by `pi-subagents`.
""")

replace_section("agents/evaluator.md", "## Sandbox Model\n\n", "\n## Information Asymmetry", """## Sandbox Model

Evaluations use explicitly requested native worktree isolation. Ephemeral acceptance tests, dependency edits, and build-file changes remain isolated and are not commits or merge handoffs. Follow native retention and cleanup facts rather than promising automatic deletion.

If explicitly authorized to evaluate in the shared cwd, first require a clean baseline with `git status --short`; if it is not clean, report `BLOCKED`. Track every evaluator-owned change, restore only those changes, and verify the final status exactly matches that baseline. Never remove or reset unrelated work. Never commit evaluation artifacts.
""")
patch_file("agents/evaluator.md", [
    (
        "Report your findings to the dispatching agent. Do not commit. In a disposable worktree, runtime cleanup handles artifacts; in the `arc_agent` fallback, complete the tracked-file restoration and temporary-file cleanup from the Sandbox Model before reporting.",
        "Report your findings to the dispatching agent. Do not commit. Keep ephemeral artifacts isolated; for an explicitly authorized shared-cwd evaluation, complete the evaluator-owned restoration from the Sandbox Model before reporting.",
    ),
])


# Mandatory acceptance reviews are a policy-owned Arc gate executed through one
# native pi-subagents workflow. Keep this final overlay after generic delegated
# execution guidance so generation cannot restore shared-cwd or arc_agent review
# alternatives in the mandatory gate sections.
REVIEWER_MUTATION_POLICY = """## Read-Only Safety Boundary

Repository writes or artifacts, Git/ref changes, Arc mutation, package installation, cache/build generation, and writer delegation are prohibited. Use only the parent-supplied canonical task, design excerpt, immutable diff input, and repository reads needed to evaluate them. Do not invoke Git or Arc commands. Any mutation invalidates the review.

"""

for rel in ("agents/spec-reviewer.md", "agents/code-reviewer.md"):
    path = ARC_ROOT / rel
    text = path.read_text()
    text = re.sub(
        r"(?m)^tools:\n(?:  - .+\n)+",
        "tools:\n  - read\n  - find\n  - grep\n",
        text,
        count=1,
    )
    marker = "## Iron Law" if rel.endswith("spec-reviewer.md") else "## Workflow"
    text = text.replace(marker, REVIEWER_MUTATION_POLICY + marker, 1)
    if rel.endswith("spec-reviewer.md"):
        text = text.replace(
            "3. Check for files changed that aren't in `## Files` (use `git diff --name-only` if a base SHA is provided)",
            "3. Check the parent-supplied immutable diff for files changed outside `## Files`; do not invoke Git",
        )
    else:
        text = text.replace(
            "3. **Read the git diff** provided or retrieve via `git diff <base>..<head>`",
            "3. **Read the parent-supplied immutable diff** inline or from its read-only external artifact; do not invoke Git",
        )
    path.write_text(text)


def write_review_prompt(rel: str, title: str, opening: str, report: str) -> None:
    (ARC_ROOT / rel).write_text(f"""# {title}

Use this template only for the native isolated mandatory reviewer workflow.

**Placeholders:**
- `{{TASK_ID}}` — Arc issue ID
- `{{CANONICAL_SPEC}}` — canonical task-description bytes above the review-ledger sentinel
- `{{CANONICAL_SHA256}}` — SHA-256 of those canonical bytes
- `{{DESIGN_EXCERPT}}` — relevant approved design text, or `none`
- `{{BASE_SHA}}` / `{{HEAD_SHA}}` — exact implementation diff range
- `{{DIFF_PATH}}` — absolute read-only external artifact path, or `inline`
- `{{DIFF_SHA256}}` — SHA-256 of the exact diff bytes
- `{{DIFF_CONTENT}}` — exact diff when inline, otherwise `read {{DIFF_PATH}}`
- `{{PRIOR_FINDINGS}}` — exact prior findings for re-review, or `none`
- `{{LATEST_FIX_DELTA}}` — exact newest fix delta for re-review, or `none`
- `{{CYCLE}}` — shared spec/code review cycle number
- `{{EVALUATOR_STATUS}}` — code review only: `active` or `not dispatched`; otherwise `not applicable`

````text
{opening}

Review only; return findings only. Do not edit files.

Repository writes or artifacts, Git/ref changes, Arc mutation, package installation, cache/build generation, and writer delegation are prohibited. Do not run Git, Arc, tests, package managers, generators, or delegated writers. Any mutation invalidates the review.

## Review Input

Task: {{TASK_ID}}
Canonical description SHA-256: {{CANONICAL_SHA256}}
Diff base: {{BASE_SHA}}
Diff head: {{HEAD_SHA}}
Diff path: {{DIFF_PATH}}
Diff SHA-256: {{DIFF_SHA256}}
Cycle: {{CYCLE}}

### Canonical Task Spec
{{CANONICAL_SPEC}}

### Approved Design Excerpt
{{DESIGN_EXCERPT}}

### Changes
{{DIFF_CONTENT}}

### Prior Findings
{{PRIOR_FINDINGS}}

### Exact Newest Fix Delta
{{LATEST_FIX_DELTA}}

### Evaluator Status
{{EVALUATOR_STATUS}}

Use only the supplied canonical task, design excerpt, diff bytes, and repository reads. The parent has already captured Git and Arc state; do not retrieve or mutate either. On re-review, verify the prior findings against the exact newest fix delta, then evaluate the resulting implementation. A finding outside that delta may newly block only if all three conditions hold: it is critical, it is a latent correctness or safety defect, and it was exposed by the newest delta. Unrelated noncritical findings must not expand the blocking review scope; report them as follow-ups.

{report}
````
""")


write_review_prompt(
    "skills/arc-build/spec-reviewer-prompt.md",
    "Spec Reviewer Prompt Template",
    "Verify that the implementation for Arc task {TASK_ID} matches its canonical task spec exactly.",
    """## Your Job

Compare the supplied diff and readable implementation files against the canonical spec. For each requirement:
- If implemented, cite the file and line.
- If absent or partial, flag the gap.
- Flag anything not requested and every file outside the spec's `## Files` list.

## Report Format

```text
## Result: COMPLIANT | ISSUES

### Missing (only if ISSUES)
- <what's missing, with file:line references>

### Extra (only if ISSUES)
- <what was added beyond spec, with file:line references>

### Misunderstood (only if ISSUES)
- <what was misinterpreted, with spec quote vs actual behavior>
```""",
)

write_review_prompt(
    "skills/arc-review/code-reviewer-prompt.md",
    "Reviewer Prompt Template",
    "Review the implementation for Arc task {TASK_ID} against the canonical task spec, approved design, and project conventions.",
    """## Report Format

Report findings in three severities:

- **Critical** (blocking): correctness bugs, security issues, scope violations, spec deviations
- **Important** (address before proceeding): quality issues, pattern mismatches, naming problems, test gaps
- **Minor** (note for later): style nits, observations, future cleanup candidates

If a design excerpt was provided, also report Plan Adherence:
- **ADHERENT** — implementation matches the design
- **DEVIATION (fix)** — implementation diverges from design; recommend fixing
- **DEVIATION (accept)** — implementation diverges from design; recommend accepting the divergence with reasoning

When Evaluator Status is `not dispatched`, flag behavioral concerns by describing the code path and suspected gap. Do not write or run tests.""",
)


MANDATORY_REVIEW_PROTOCOL = r'''### __HEADING__

Mandatory __LABEL__ is an Arc acceptance gate, not generic dispatch. It requires the separately installed native provider and exact `__AGENT__` capability. There is no shared-cwd, `arc_agent`, generic-agent, provider-runner, or CLI fallback for this gate. If capability or evidence is unavailable, stop with setup or infrastructure guidance.

#### Clean source preflight

Run from the repository root before materializing input or launching a reviewer:

```bash
REVIEW_BRANCH=$(git branch --show-current)
REVIEW_BASE=$(git rev-parse HEAD)
REVIEW_STATE=$(git status --porcelain=v2 --untracked-files=all -- ':!.pi/subagents')
test -n "$REVIEW_BRANCH"
test -z "$REVIEW_STATE" || {
  printf '%s\n' "$REVIEW_STATE" >&2
  echo 'review requires a clean source checkout' >&2
  exit 1
}
```

Dirty source state blocks review. Never stash, reset, restore, clean, or fall back to shared-cwd review. Capture these exact values as `ReviewBaseline { branch, head, porcelainV2 }`; `REVIEW_BASE` is the native worktree handoff base while `BASE_SHA..HEAD_SHA` remains the implementation range under review.

#### Durable combined review budget

The Arc issue description is both canonical task input and durable budget storage. Bootstrap and reload are distinct. On first review, inspect the last exact sentinel. First-time bootstrap may preserve and hash the **entire** original description bytes only when that last sentinel's terminal suffix is ordinary quoted/task prose with no review-ledger signature; byte-concatenate the actual sentinel directly after those bytes without inserting, removing, or normalizing a delimiter. This keeps the byte slice before the actual ledger boundary identical even when Arc has trimmed a trailing newline. Earlier sentinel/header examples are canonical quoted prose because only the last exact sentinel can be the boundary. If the terminal suffix contains any review-ledger signature — the exact `## Review Ledger` header, a `Canonical description SHA-256` field, `Authorized reviewer runs: 4`, `Owner-authorized additional reviewer runs: <finite-positive-integer>`, or ledger table syntax (header, separator, or row) — it is durable ledger state and must be a structurally valid terminal review-ledger trailer (versioned header, valid canonical SHA-256, fixed authorization, table header/separator, and valid rows) whose recorded hash matches the exact prefix. Missing, invalid, or mismatched hashes and every other malformed terminal trailer fail closed; never absorb prior ledger data into canonical bytes or reset the budget. After initialization, the actual ledger boundary is the last exact sentinel because canonical task prose or code may quote earlier sentinel examples. Append exactly this versioned boundary and header:

```markdown
<!-- arc-review-ledger:v1 -->
## Review Ledger
Canonical description SHA-256: `<sha256>`
Authorized reviewer runs: 4
```

Bytes above the sentinel are canonical and must never change. Compute and verify their SHA-256 before every launch. Content below the sentinel is the ledger only. Use rows with the conceptual shape `ReviewLedgerEntry { sequence, reviewer, run_id, base, head, elapsed_ms, disposition }`:

```markdown
| sequence | reviewer | run_id | base | head | elapsed_ms | disposition |
|---:|---|---|---|---|---:|---|
```

Spec and code review share one combined four-run task budget across sessions and cycles. The persisted Arc issue description is the only budget source of truth: before each launch, re-read it and count all persisted rows carrying a native run identity; never rely on an in-memory count from the current session. Every returned native run identity consumes exactly one row, including a run that later fails; persist its row as soon as the launch returns the identity, then re-read the issue and update only that row's elapsed time and disposition after completion. A pre-submission failure that returns no native run identity does not consume a row. Reject the fifth launch unless the owner explicitly authorizes a bounded extension recorded as `Owner-authorized additional reviewer runs: <finite-positive-integer>` below the ledger. Persist owner authorization, re-read it from the issue description, and validate the finite positive count before using it. The allowed total is four plus the sum of those explicit persisted grants; open-ended, inferred, or model-authored authorization is invalid. After every ledger append/update, re-read the issue, split at the last exact sentinel, and verify the SHA-256 of the unchanged prefix before continuing. After ledger initialization, no last boundary means the ledger is malformed: fail closed instead of treating the full description as canonical.

#### Immutable parent-supplied input

Materialize `ReviewInput { canonical_spec, canonical_sha256, design_excerpt, diff_path, diff_sha256, prior_findings?, cycle }` in the prompt. The parent supplies the canonical Arc task description above the sentinel and the approved design excerpt; the reviewer never needs Arc CLI or Git. For re-review, include prior findings verbatim and the exact newest fix delta. Outside-delta findings may newly block only when the newest delta exposes a critical latent correctness or safety defect; unrelated noncritical observations become follow-ups.

Small diffs may be inline, with their SHA-256 recorded. For a non-inline diff, create the artifact physically outside the repository and make it immutable before launch:

```bash
REPO_ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd -P) || {
  echo 'unable to resolve repository root physically' >&2
  exit 1
}
TMP_PARENT=${TMPDIR:-/tmp}
case "$TMP_PARENT" in
  /*) ;;
  *) echo 'TMPDIR must be an absolute path' >&2; exit 1 ;;
esac
TMP_PARENT=$(cd "$TMP_PARENT" && pwd -P) || {
  echo 'unable to resolve temporary parent physically' >&2
  exit 1
}
case "$TMP_PARENT/" in "$REPO_ROOT/"*) echo 'review input must be physically outside the repository' >&2; exit 1 ;; esac
REVIEW_INPUT_DIR=$(mktemp -d "$TMP_PARENT/arc-review-input.XXXXXX") || {
  echo 'unable to create review input directory' >&2
  exit 1
}
REVIEW_INPUT_DIR=$(cd "$REVIEW_INPUT_DIR" && pwd -P) || {
  echo 'unable to resolve review input directory physically' >&2
  exit 1
}
case "$REVIEW_INPUT_DIR/" in "$REPO_ROOT/"*) echo 'review input must be physically outside the repository' >&2; exit 1 ;; esac
git diff --binary --find-renames=0 "$BASE_SHA..$HEAD_SHA" > "$REVIEW_INPUT_DIR/diff.patch" || {
  echo 'review diff materialization failed' >&2
  exit 1
}
chmod 0444 "$REVIEW_INPUT_DIR/diff.patch" || {
  echo 'unable to make review diff artifact read-only' >&2
  exit 1
}
REVIEW_INPUT_MODE=$(stat -c '%a' "$REVIEW_INPUT_DIR/diff.patch") || {
  echo 'unable to verify review diff artifact mode' >&2
  exit 1
}
test "$REVIEW_INPUT_MODE" = 444 || {
  echo 'review diff artifact mode is not 0444' >&2
  exit 1
}
DIFF_SHA256_OUTPUT=$(sha256sum "$REVIEW_INPUT_DIR/diff.patch") || {
  echo 'unable to hash review diff artifact' >&2
  exit 1
}
DIFF_SHA256=${DIFF_SHA256_OUTPUT%%[[:space:]]*}
case "$DIFF_SHA256" in
  ''|*[!0-9a-f]*) echo 'review diff artifact hash is malformed' >&2; exit 1 ;;
esac
test "${#DIFF_SHA256}" -eq 64 || {
  echo 'review diff artifact hash is malformed' >&2
  exit 1
}
```

Physically resolve and contain-check the absolute temporary parent before `mktemp`; reject a relative `TMPDIR` or a symlinked `TMPDIR` that resolves inside the repository before any artifact directory exists. After creation, physically resolve and contain-check the created directory again as race defense. External physical parents remain valid. Failed diff materialization exits before chmod or hashing. Do not remove the created review-input directory or partial diff artifact on failure; retain it as failure evidence.

The filled prompt records the external diff path, SHA-256, base, and head. It also records the canonical task hash and design excerpt. The reviewer receives no shell or write-capable tool. Mode 0444 is defense in depth, but mode 0444 alone does not prove the bytes remained unchanged; the post-review SHA-256 check is authoritative, and any hash mismatch blocks acceptance.

#### One native isolated reviewer

Immediately before outer launch, require `test "$(git rev-parse HEAD)" = "$REVIEW_BASE"`. Then launch exactly one awaited foreground reviewer inside an asynchronous native workflow:

```typescript
subagent({
  workflowScript: `return await runs.run("__KEY__", {
    agent: "__AGENT__",
    task: "<filled immutable review prompt>",
    worktree: true,
    async: false,
    output: "__OUTPUT__"
  });`,
  context: "fresh",
  async: true,
  globalConcurrencyLimit: 1,
  baseRef: "HEAD"
})
```

The stable inner key, exact agent, foreground `async: false`, `worktree: true`, and string output binding are mandatory. The outer workflow stays `async: true` and returns control for native completion. Capture the current outer launch's exact returned receipt before returning control; do not use a later notification or a discovered async directory as a substitute:

```bash
OUTER_LAUNCH_RECEIPT='<exact outer launch receipt returned by subagent>'
OUTER_RUN_ID=$(printf '%s' "$OUTER_LAUNCH_RECEIPT" | jq -er '.runId | strings | select(length > 0)')
NATIVE_ASYNC_DIR=$(printf '%s' "$OUTER_LAUNCH_RECEIPT" | jq -er '.details.asyncDir | strings | select(length > 0)')
NATIVE_STATUS_PATH="$NATIVE_ASYNC_DIR/status.json"
test -r "$NATIVE_STATUS_PATH"
```

`NATIVE_ASYNC_DIR` comes only from this launch receipt's exact `details.asyncDir`; read only its `status.json`. Omit `model:` so the configured __PROFILE__ profile and existing model fallback precedence remain authoritative. Do not poll merely to wait.

#### Terminal evidence before prose

After every terminal outcome, success or failure, run this invariant before retry, builder dispatch, issue closure, or publication:

```bash
test "$(git branch --show-current)" = "$REVIEW_BRANCH"
test "$(git rev-parse HEAD)" = "$REVIEW_BASE"
test -z "$(git status --porcelain=v2 --untracked-files=all -- ':!.pi/subagents')"
```

Any failure invalidates the review and stops for explicit inspection. Never reset, restore, clean, stash, commit, or switch execution mode automatically. This post-run invariant is required even when native launch, execution, output capture, or reviewer completion fails.

Re-read the Arc issue after completion, split its description at the last exact ledger sentinel without normalizing bytes, and recompute the prefix hash. The last occurrence is the actual boundary; earlier occurrences belong to quoted canonical task prose or code. A parent may use this byte-preserving pipeline; the reviewer itself never receives Arc access. `assert found` makes a missing boundary fail closed:

```bash
CURRENT_CANONICAL_SHA256=$(arc show "$TASK_ID" --json | jq -j .description | python3 -c 'import hashlib, sys; data=sys.stdin.buffer.read(); marker=b"<!-- arc-review-ledger:v1 -->"; before, found, _=data.rpartition(marker); assert found; print(hashlib.sha256(before).hexdigest())')
test "$CURRENT_CANONICAL_SHA256" = "$CANONICAL_SHA256"
```

For a non-inline diff, recheck its immutable bytes after completion and before acceptance:

```bash
POST_REVIEW_SHA256_OUTPUT=$(sha256sum "$REVIEW_INPUT_DIR/diff.patch") || {
  echo 'unable to hash review diff artifact after review' >&2
  exit 1
}
POST_REVIEW_SHA256=${POST_REVIEW_SHA256_OUTPUT%%[[:space:]]*}
case "$POST_REVIEW_SHA256" in
  ''|*[!0-9a-f]*) echo 'post-review diff artifact hash is malformed' >&2; exit 1 ;;
esac
test "${#POST_REVIEW_SHA256}" -eq 64 || {
  echo 'post-review diff artifact hash is malformed' >&2
  exit 1
}
test "$POST_REVIEW_SHA256" = "$DIFF_SHA256"
```

Acceptance combines runtime and output evidence with handoff evidence; none substitutes for another. Require the exact persisted native async `status.json` after the completion notification or status observation, before reading __LABEL__ prose. The persisted status JSON is the durable exact native evidence for both terminal state and the complete foreground child result: its top-level `.runId` must equal the current `$OUTER_RUN_ID`, `.state == "complete"` is workflow success, `.error == null` is required, and `.workflow.value` is `CHILD_RESULT`. The public completion notification is projected prose, not JSON; it does not carry `.workflow.value` and must not be parsed, merged with, or reconstructed into status evidence. Preserve the exact persisted status JSON as `NATIVE_STATUS_JSON`; never merge or reconstruct evidence fields. In the child result's string-array `artifactPaths`, require exactly one returned path ending in `handoffs/<run-id>.json`; never construct or infer it:

```bash
NATIVE_STATUS_JSON=$(cat "$NATIVE_STATUS_PATH")
printf '%s' "$NATIVE_STATUS_JSON" | jq -e --arg outerRunId "$OUTER_RUN_ID" '
  .runId == $outerRunId
  and .state == "complete"
  and (.error == null)
' >/dev/null
CHILD_RESULT=$(printf '%s' "$NATIVE_STATUS_JSON" | jq -ce '.workflow.value')
printf '%s' "$CHILD_RESULT" |
  jq -e --arg key "__KEY__" --arg agent "__AGENT__" --arg output "/__OUTPUT__" '
    .key == $key
    and .agent == $agent
    and .ok == true
    and (.error == null)
    and (.stopped != true)
    and (.detached != true)
    and (.interrupted != true)
    and (.terminalOutcome == null)
    and (.runId | type == "string" and length > 0)
    and (.output | type == "string" and test("\\S"))
    and (.outputReference | type == "string" and endswith($output))
    and (.outputReference as $reference | .artifactPaths | type == "array" and index($reference) != null)
  ' >/dev/null
OUTPUT_REFERENCE=$(printf '%s' "$CHILD_RESULT" | jq -er '.outputReference')
test -r "$OUTPUT_REFERENCE" && test -s "$OUTPUT_REFERENCE"
RUNTIME_OUTPUT_SHA256=$(printf '%s' "$CHILD_RESULT" | jq -j '.output' | sha256sum | awk '{print $1}')
SAVED_OUTPUT_SHA256=$(sha256sum "$OUTPUT_REFERENCE" | awk '{print $1}')
test "$SAVED_OUTPUT_SHA256" = "$RUNTIME_OUTPUT_SHA256"
HANDOFF_COUNT=$(printf '%s' "$CHILD_RESULT" | jq -r --arg run "$(printf '%s' "$CHILD_RESULT" | jq -r '.runId')" '[.artifactPaths[] | select(endswith("/handoffs/" + $run + ".json"))] | length')
test "$HANDOFF_COUNT" -eq 1
HANDOFF_MANIFEST=$(printf '%s' "$CHILD_RESULT" | jq -r --arg run "$(printf '%s' "$CHILD_RESULT" | jq -r '.runId')" '.artifactPaths[] | select(endswith("/handoffs/" + $run + ".json"))')
test -n "$HANDOFF_MANIFEST" && test -r "$HANDOFF_MANIFEST" &&
  jq -e --arg base "$REVIEW_BASE" --arg key "__KEY__" --arg agent "__AGENT__" '
    .version == 1
    and (.groups | type == "array" and length > 0)
    and all(.groups[];
      .baseCommit == $base
      and (.children | type == "array" and length == 1)
      and all(.children[];
        .workflowKey == $key
        and .agent == $agent
        and .status == "completed"
        and .patch.changed == false
        and .patch.filesChanged == 0
        and .patch.insertions == 0
        and .patch.deletions == 0
        and (.patch.error == null)
      )
    )
  ' "$HANDOFF_MANIFEST"
```

Missing or malformed runtime or reviewer output, missing or empty handoff groups, missing output evidence, runtime failure, wrong workflow/agent identity, wrong base, more or fewer than one child, any patch/error evidence, a changed canonical/diff input hash, or a changed primary branch/HEAD/status blocks acceptance. Arc never applies reviewer patches. Only after all runtime and output evidence, native handoff evidence, immutable-input evidence, and post-run evidence passes may Arc interpret the report and apply its finding-disposition policy.
'''


def mandatory_review_protocol(heading: str, label: str, key: str, agent: str, output: str, profile: str) -> str:
    return (MANDATORY_REVIEW_PROTOCOL
        .replace("__HEADING__", heading)
        .replace("__LABEL__", label)
        .replace("__KEY__", key)
        .replace("__AGENT__", agent)
        .replace("__OUTPUT__", output)
        .replace("__PROFILE__", profile))


spec_review_protocol = mandatory_review_protocol(
    "5. Spec Compliance Review",
    "spec review",
    "spec-review",
    "arc-spec-reviewer",
    "spec-review.md",
    "specReviewer",
)
spec_review_protocol = spec_review_protocol.replace(
    "#### Durable combined review budget",
    """#### Implementation diff range

After the clean-source preflight and before materializing the spec-review input, define the committed implementation range anchored at the pre-task SHA and the immutable review base:

```bash
BASE_SHA=$PRE_TASK_SHA
HEAD_SHA=$REVIEW_BASE
test -n \"$BASE_SHA\"
test -n \"$HEAD_SHA\"
```

#### Durable combined review budget""",
).replace(
    "  context: \"fresh\",\n  async: true,",
    "  context: \"fresh\", async: true,",
).replace(
    "The outer workflow stays `async: true` and returns control for native completion.",
    "The literal outer base ref uses symbolic `HEAD`, resolved at worktree allocation by `pi-subagents`; `REVIEW_BASE` remains the immutable full-SHA verification anchor. The outer workflow remains asynchronous while its exactly one awaited inner foreground child completes.",
)
replace_section(
    "skills/arc-build/SKILL.md",
    "### 5. Spec Compliance Review\n\n",
    "\nHandle results:",
    spec_review_protocol,
)

code_review_protocol = mandatory_review_protocol(
    "3. Dispatch Reviewer",
    "code review",
    "code-review",
    "arc-code-reviewer",
    "code-review.md",
    "codeReviewer",
)
replace_section(
    "skills/arc-review/SKILL.md",
    "### 3. Dispatch Reviewer\n\n",
    "\n### 4. Triage Feedback",
    code_review_protocol,
)

patch_file("skills/arc-review/SKILL.md", [
    (
        "**Circuit breaker**: If 3 review/fix cycles on the same task haven't resolved all findings, STOP. Escalate to the user with a summary of what keeps recurring — the reviewer and implementer may disagree on the approach, or the task spec may be ambiguous.",
        "**Combined reviewer budget**: Use the combined four-launched-run spec/code budget in the versioned Arc issue ledger. Every native reviewer run identity consumes one row even if it fails. A fifth launch requires explicit owner authorization recorded with a finite additional count; there is no separate three-cycle or per-finding reviewer allowance.",
    ),
])

# Arc-build routes its mandatory code-quality gate through the standalone review
# skill, which owns the exact same isolated code-review protocol and finding
# disposition semantics.
patch_file("skills/arc-build/SKILL.md", [
    (
        "Only dispatched after spec compliance passes. Use the `review` skill or dispatch `code-reviewer` directly:",
        "Only after spec compliance passes, invoke the `review` skill and follow its mandatory isolated `code-review` workflow exactly. Do not dispatch `code-reviewer` directly and do not use `arc_agent` for this acceptance gate:",
    ),
    (
        "Use the template at `../arc-review/code-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}` = PRE_TASK_SHA recorded earlier, `{HEAD_SHA}` = current HEAD, `{DESIGN_EXCERPT}` from parent epic or \"none\" — retrieve it directly with `arc show <parent-epic-id>` and use \"none\" when no parent design context exists, `{EVALUATOR_STATUS}` = \"active\" if evaluator was dispatched, else \"not dispatched\"). Follow Model Selection above for the dispatch `model:` — the configured `codeReviewer` profile is authoritative and `large` frontmatter is the fallback.",
        "Use `../arc-review/code-reviewer-prompt.md` and supply its complete immutable `ReviewInput`. The parent obtains `{DESIGN_EXCERPT}` directly with `arc show <parent-epic-id>` and uses \"none\" when no parent design exists; the reviewer never runs Arc. Include canonical task/hash, exact diff path/hash/base/head, prior findings, exact newest fix delta for re-review, cycle, and evaluator status. The configured `codeReviewer` profile remains authoritative through the review skill's native workflow.",
    ),
    (
        "- Circuit breaker: 3 spec-review/fix cycles without resolution → escalate to user.",
        "- Apply the combined four-launched-run spec/code budget from this gate's versioned issue ledger; there is no separate per-finding or per-reviewer circuit breaker.",
    ),
    (
        "Circuit breaker: 3 review/fix cycles on the same finding → escalate to user.",
        "Use the combined four-launched-run spec/code budget from the versioned issue ledger. A fifth reviewer launch requires explicit owner authorization recorded with a finite additional count.",
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
