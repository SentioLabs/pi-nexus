---
name: arc-build
description: You MUST use this skill to execute implementation tasks from a planning artifact (the design + breakdown produced by /arc-brainstorm and /arc-plan) — especially when the user says "implement this", "build this", "execute the plan", "start coding", or wants to dispatch subagents for TDD execution of arc issues. The main agent orchestrates; it never writes implementation code directly. Always prefer this over generic implementation when the project uses arc issue tracking.
---

# Implement — Subagent-Driven TDD Execution

Orchestrate task implementation by dispatching fresh `builder` subagents per task. Each subagent gets a clean context window with just the task description.

## Core Rule

**The main agent NEVER writes implementation code.** It orchestrates, dispatches, and reviews. If you're tempted to "just quickly fix this" — dispatch a subagent instead.

## Model Selection

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
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.4-mini", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.3-codex", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.5", context: "fresh", async: true, clarify: false })
```

**When unsure, omit `model:`** — the agent's frontmatter floor is calibrated for the typical case.

**Escalation rule:** If a subagent returns `BLOCKED` with a reasoning or capability complaint, re-dispatch with the next tier up before asking the human. Stop escalating at `large` — if `large` also returns `BLOCKED`, escalate to the human with the subagent's blocker summary.

## Dispatch Modes

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

### 1. Find Next Task

```bash
arc ready
# or for a specific epic:
arc list --parent=<epic-id> --status=open
```

### 2. Claim Task

```bash
arc update <task-id> --take
```

### 3. Dispatch Agent

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
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="doc-writer", task="<filled prompt>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

**Otherwise** — spawn a `builder` subagent:

Use the template at `./builder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.

Dispatch preference:
- If `subagent` is available and `arc-builder` is installed: `subagent({ agent: "arc-builder", task: "<filled prompt>", model: "<concrete-model-if-needed>", context: "fresh", async: true, clarify: false })`
- If `subagent` is available but Arc specialists are missing: Arc specialists should already be auto-materialized. First run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command, then re-check with `subagent({ action: "list" })`.
- Otherwise: `arc_agent(agent="builder", task="<filled prompt>", model="<tier-if-needed>")`

For async `pi-subagents` dispatches, immediately capture the returned run ID, poll with `subagent({ action: "status", id: "<run-id>" })` or watch `/subagents-status` until terminal, then read the final output before evaluating the report or moving to validation.

### 4. Evaluate Result

When the subagent reports back, check its **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Implementer Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the subagent's report alone.

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
- For `BLOCKED`: assess the blocker per the Handle Implementer Status table. Escalate one model tier (`nano` → `small` → `standard` → `large`) per the Model Selection escalation rule, or invoke the `debug` skill if the blocker is a persistent test failure, or split the task if too large, or escalate to the human.
- After 3 re-dispatches on the same task without clean `DONE`, invoke the `debug` skill.

**If the subagent did not include a Status field** (malformed report):
- Treat as `BLOCKED`. Re-dispatch with an explicit reminder to use the four-status Report Format.

When re-dispatching, include the previous report's concerns / blockers so the implementer knows exactly what to fix:

```text
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
- `ISSUES (Missing)` → re-dispatch `builder` with specific gaps listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Extra)` → re-dispatch `builder` to remove the extras listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Misunderstood)` → re-dispatch `builder` with clarification from the spec reviewer's findings. Re-run spec compliance review after.
- Circuit breaker: 3 spec-review/fix cycles without resolution → escalate to user.

> **Docs-only tasks**: Skip this step. The spec-reviewer is designed around code verification (file lists, function signatures, test coverage) and doesn't apply to documentation. For docs-only tasks, the orchestrator verifies formatting/completeness directly: check that all files in `## Files` were created/modified, links resolve, heading hierarchy is correct, code blocks have language tags.

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
| **Critical/Important** | Re-dispatch `builder` with fixes. Re-review after. |
| **Minor** | Note in arc comment. Proceed. |
| **Deviation (fix)** | Re-dispatch `builder` to match the design. |
| **Deviation (accept)** | Log as arc comment: "Accepted deviation: \<description\>. Rationale: \<why\>." Proceed. |

Circuit breaker: 3 review/fix cycles on the same finding → escalate to user.

> **Docs-only tasks**: Skip code quality review. For substantial documentation changes (developer-facing API docs, architecture docs), optionally dispatch `code-reviewer` for a quality check.

### 6.5. High-Risk Evaluation (Optional)

The evaluator is **not dispatched by default**. Dispatch only when:
- Task has a `high-risk` label
- The orchestrator judges the task warrants independent verification (e.g., complex spec with multiple valid interpretations, security-sensitive code, tasks that modify shared contracts)

When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:

```text
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

Triage evaluator findings:

| Evaluator verdict | Orchestrator action |
|---|---|
| `PASS` | No action — evaluator confirms the spec intent is satisfied. |
| `CONCERNS` | Read the concerns. Re-dispatch `builder` if the concerns describe substantive behavior gaps. Otherwise note as arc comments and proceed. |
| `FAIL — Spec-Intent Gap` | Re-dispatch `builder` with the evaluator's quoted spec text and the failing behavior description. |
| `FAIL — Missing Behavior` | Re-dispatch `builder` — the spec requires behavior that wasn't built. |
| `FAIL — Edge Case` | Lower-severity. Re-dispatch if the spec clearly implies the edge case; otherwise record as a known limitation. |
| `ERROR — Cannot Test` | The public API is insufficient. Re-dispatch with a request to expose the needed surface. |
| `BLOCKED` | Evaluator itself is blocked. Escalate per the Model Selection rules or involve the human. |

### 7. Close Task

```bash
arc close <task-id> -r "Implemented: <summary>"
```

### 8. Integration Checkpoint

After closing 2-3 related tasks, or before switching to a new epic phase, run the full integration test suite:

```bash
make test-integration
```

This catches cross-task regressions that individual implementer gate checks won't — each implementer only validates its own task's scope. Do not wait until all tasks are complete to discover integration failures.

If integration tests fail:
- Identify which task's changes caused the failure
- Re-dispatch `builder` with the failing test details and the relevant task context
- If the failure spans multiple tasks, invoke the `debug` skill

### 9. Repeat

Go to step 1 for the next task. Continue until all tasks in the epic are closed.

## Handle Implementer Status

Every `builder` and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:

| Status | Orchestrator action |
|---|---|
| `DONE` | Proceed to spec review, then code review. |
| `DONE_WITH_CONCERNS` | Read the concerns. If they're about correctness or scope, address before review (re-dispatch or tighten review prompt). If they're observations (file getting large, naming doubt), note them as arc comments on the task and proceed to review — close only after a later dispatch yields a clean `DONE`. |
| `BLOCKED` | Assess the blocker: (1) context problem → provide missing context, re-dispatch same tier; (2) reasoning limit → re-dispatch one tier up per the Model Selection escalation rule; (3) task too large → split and re-plan; (4) plan is wrong → escalate to human. Never retry the same dispatch unchanged. |
| `NEEDS_CONTEXT` | Gather the specific missing information. Re-dispatch with it in the prompt. |

**Never close a task** whose last report was `BLOCKED`, `NEEDS_CONTEXT`, or `DONE_WITH_CONCERNS` unresolved. Re-dispatch until you have a clean `DONE` — then close.

## Parallel Patch Protocol

Use this protocol only with `pi-subagents` worktree mode. Do **not** use `arc_agent(isolation="worktree")`; `arc_agent` intentionally remains sequential-only.

### P1. Commit Checkpoint

Before switching to parallel, ensure all sequential work is committed and pushed. Run this exact gate:

```bash
git status --short
git push
PARALLEL_BASE=$(git rev-parse HEAD)
echo "Parallel base: $PARALLEL_BASE"
```

If `git status --short` reports changes, stop and clean the tree first.

### P2. Record HEAD Anchor

This anchor is the baseline all temporary worktrees will branch from. Record it before dispatching the batch.

### P3. Re-check Batch Gates Before Dispatch

Re-check these gates immediately before dispatching the batch:
- `subagent({ action: "list" })` shows Arc specialists such as `arc-builder` and `arc-doc-writer`.
- Each task in the batch is ready in Arc.
- No task in the batch blocks another task in the batch.
- No builder/doc-writer task owns the same file as another task in the batch.
- Each task has a clear validation command.

For each task in the manifest, `arc show <task-id>` and confirm the batch is still independent.

### P4. Dispatch with `pi-subagents`

Dispatch the selected batch in one `subagent` tool call so the tasks branch from the same `PARALLEL_BASE`:

```text
subagent({
  tasks: [
    { agent: "arc-builder", task: "<filled builder prompt>", model: "<configured standard model>" }
  ],
  worktree: true,
  concurrency: 3,
  context: "fresh",
  async: true,
  clarify: false
})
```

When the async run completes, `pi-subagents` returns diff stats and a `Full patches: <dir>` path. Temporary worktrees are cleaned up; the patches are the handoff artifact.

### P5. Apply and Verify Patches One at a Time

Apply, validate, review, commit, and close exactly one returned patch at a time.

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

After successful verification, return to the normal orchestration loop (step 1) for any remaining tasks.

## When to Invoke Debug

- Subagent reports test failures it can't resolve after reasonable effort
- 3+ implementation attempts fail on the same issue
- A regression appears that isn't explained by the current task's changes

## Arc Commands Used

```bash
arc ready                           # Find next task
arc update <id> --take                  # Claim task (sets session ID + in_progress)
arc show <id>                        # Get task description for subagent
arc close <id> -r "reason"            # Close completed task
```

## Rules

- Never write implementation code as the main agent — always dispatch
- Never close a task without confirming tests pass yourself (fresh run)
- Never close a task if the implementer reported `BLOCKED`, `NEEDS_CONTEXT`, or unresolved `DONE_WITH_CONCERNS` without re-dispatching
- When re-dispatching after `BLOCKED`, escalate one model tier per the Model Selection table — never retry the same dispatch unchanged
- If in doubt about the result, re-dispatch rather than fixing manually
- Never dispatch parallel agents without committing and pushing all sequential work first
- Never dispatch parallel agents on tasks that share files
- Never use parallel patch mode unless `pi-subagents` and Arc `pi-subagents` agent definitions are available
- Never apply more than one parallel patch at a time; apply, verify, review, commit, and close each task independently
- Never proceed after a parallel patch batch without verifying commit history against the recorded HEAD anchor
- Never mix sequential and parallel dispatch in the same batch — finish one mode before switching to the other
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
