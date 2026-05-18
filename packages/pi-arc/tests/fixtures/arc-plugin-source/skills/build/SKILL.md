---
name: build
description: You MUST use this skill to execute implementation tasks from a planning artifact (the design + breakdown produced by /arc:brainstorm and /arc:plan) — especially when the user says "implement this", "build this", "execute the plan", "start coding", or wants to dispatch subagents for TDD execution of arc issues. The main agent orchestrates; it never writes implementation code directly. Always prefer this over generic implementation when the project uses arc issue tracking.
---

# Implement — Subagent-Driven TDD Execution

Orchestrate task implementation by dispatching fresh `builder` subagents per task. Each subagent gets a clean context window with just the task description.

## Core Rule

**The main agent NEVER writes implementation code.** It orchestrates, dispatches, and reviews. If you're tempted to "just quickly fix this" — dispatch a subagent instead.

## Pre-flight: Branch Setup

Before dispatching any task, perform the protected-branch check per `skills/arc/_branch-check.md`.

This catches the case where build was invoked without going through `brainstorm` first. Subagents commit to whatever branch the main agent is on — and the parallel-dispatch checkpoint push (P1) goes there too. Discovering at finish time that an entire epic landed on trunk is not recoverable cheaply. Suggest a branch name from the epic/task title if the user picks "switch."

## Model Selection

Every Agent dispatch can override the subagent's frontmatter model via the `model:` parameter. Use this to match model tier to task complexity. The default floor per agent is set in frontmatter — use these overrides to downgrade for trivial tasks or escalate for complex ones.

| Task signal | Dispatch `model:` |
|---|---|
| Mechanical: 1-2 files, spec unambiguous, no cross-cutting concerns | `haiku` (downgrade from sonnet floor) |
| Standard: integration work, multi-file but contained, unambiguous | omit `model:` (use agent default) |
| Complex: 3+ files, cross-layer, design judgment required, migrations, breaking changes | `opus` |
| Re-dispatch after `BLOCKED` | escalate one tier (haiku → sonnet → opus); stop at opus |
| Re-dispatch after `NEEDS_CONTEXT` | same tier, richer context |

Examples:

```text
Agent(subagent_type="arc:builder", model="haiku", prompt="...")       # mechanical
Agent(subagent_type="arc:builder", prompt="...")                      # standard (sonnet)
Agent(subagent_type="arc:builder", model="opus", prompt="...")        # complex
```

**When unsure, omit `model:`** — the agent's frontmatter floor is calibrated for the typical case.

**Escalation rule:** If a subagent returns `BLOCKED` with a reasoning or capability complaint, re-dispatch with the next tier up before asking the human. Stop escalating at opus — if opus also returns `BLOCKED`, escalate to the human with the subagent's blocker summary.

## Dispatch Modes

### Sequential (default)

Tasks are dispatched one at a time through the orchestration loop below. Use this for:
- Most workflows — it's the safe default
- Tasks with any file overlap
- Tasks with dependency ordering (`blocks`/`blockedBy`)
- When you're unsure whether tasks are independent

### Parallel

Multiple tasks dispatched simultaneously using `isolation: "worktree"`. Use this **only** when ALL of these are true:
- 3+ independent tasks remain
- No shared files between any tasks in the batch
- No `blocks`/`blockedBy` dependencies between tasks in the batch
- Each task's scope is clearly defined with no ambiguity

**When NOT to use parallel**: overlapping files, task dependencies, uncertainty about scope, fewer than 3 tasks. Default to sequential — the cost of serial execution is time; the cost of a bad parallel merge is data loss.

## Orchestration Loop

By default, use sequential dispatch. For independent tasks, see [Parallel Dispatch Protocol](#parallel-dispatch-protocol) below.

**Task tracking**: At the start of implementation, create a task list using `TaskCreate` with one entry per arc issue to implement. This provides a visible progress tracker in the CLI. Update each task as you work:
- `in_progress` when dispatching the subagent
- `completed` when the task is closed in arc

```bash
# Get the list of tasks to implement
arc list --parent=<epic-id> --status=open --json
```

Create a `TaskCreate` entry for each, then work through this loop:

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

**If `docs-only`** (exit code 0) — spawn an `doc-writer` subagent:

Use the template at `./doc-writer-prompt.md`. Fill placeholder `{TASK_ID}`. For docs-only work, the agent default (`haiku`) is correct — omit `model:` unless the docs task is unusually complex.

**Otherwise** — spawn an `builder` subagent:

Use the template at `./builder-prompt.md`. Fill placeholders (`{TASK_ID}`, `{PRE_TASK_SHA}`, `{DESIGN_EXCERPT}`) and apply Model Selection guidance (see `## Model Selection` above) for the dispatch `model:`.

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
- For `BLOCKED`: assess the blocker per the Handle Implementer Status table. Escalate one model tier (haiku → sonnet → opus) per the Model Selection escalation rule, or invoke the `debug` skill if the blocker is a persistent test failure, or split the task if too large, or escalate to the human.
- After 3 re-dispatches on the same task without clean `DONE`, invoke the `debug` skill.

**If the subagent did not include a Status field** (malformed report):
- Treat as `BLOCKED`. Re-dispatch with an explicit reminder to use the four-status Report Format.

When re-dispatching, include the previous report's concerns / blockers so the implementer knows exactly what to fix:

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

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). Spec review is a focused comparison task — the agent default is appropriate; omit `model:` unless the spec is unusually large or ambiguous.

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

Use the template at `../review/reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}` = PRE_TASK_SHA recorded earlier, `{HEAD_SHA}` = current HEAD, `{DESIGN_EXCERPT}` from parent epic or "none", `{EVALUATOR_STATUS}` = "active" if evaluator was dispatched, else "not dispatched"). Follow Model Selection above for the dispatch `model:` — sonnet default is appropriate for most reviews.

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

When dispatched, use `isolation: "worktree"` and the existing `evaluator` agent. The evaluator can run **in parallel with Step 6** (code quality review) since they examine orthogonal concerns:

```bash
PARENT=$(arc show <task-id> --json | jq -r '.parent_id // empty')
```

Use the template at `./evaluator-prompt.md`. Fill placeholder `{TASK_ID}`. Because evaluation is adversarial verification on high-risk tasks, escalate one tier from the agent default (typically to `opus`) — set `model: "opus"` on the dispatch unless the task is narrow.

When dispatching alongside the evaluator, update the code quality reviewer's `## Evaluator Status` to `active`.

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

## Parallel Dispatch Protocol

When you have identified a batch of truly independent tasks (see [Dispatch Modes](#dispatch-modes)), switch from the sequential loop to this protocol:

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
echo "Parallel base: $PARALLEL_BASE"
```

This is the baseline all worktrees will branch from. Record it — you'll need it for verification after merge.

### P3. Verify Independence

For each task in the planned parallel batch:

```bash
arc show <task-id>
```

Confirm:
- No `blocks`/`blockedBy` relationships between tasks in this batch
- No overlapping file paths in task descriptions
- Each task has a clearly scoped, non-ambiguous specification

If any task fails these checks, remove it from the parallel batch and handle it sequentially after.

### P4. Dispatch in Single Turn

All parallel Agent tool calls with `isolation: "worktree"` **must happen in the same orchestrator message**. This ensures they all branch from the same HEAD.

```
# In a single response, dispatch all parallel tasks:
Agent(subagent_type="arc:builder", isolation="worktree", prompt="Task 1...")
Agent(subagent_type="arc:builder", isolation="worktree", prompt="Task 2...")
Agent(subagent_type="arc:builder", isolation="worktree", prompt="Task 3...")
```

**Never** dispatch worktree agents across multiple turns — HEAD may move between turns, causing stale branches.

### P5. Merge-Back Verification

After all parallel agents report back, verify the merge did not lose work:

```bash
# 1. Check HEAD against the recorded anchor
git log --oneline $PARALLEL_BASE..HEAD    # Should show ONLY the parallel agents' commits

# 2. Verify sequential commits are still in history
git log --oneline HEAD | head -20         # All prior sequential commits must be present

# 3. Run full test suite
make test    # or project-specific test command
```

**If sequential commits are missing** → STOP. Do not continue. Recover from reflog:

```bash
git reflog                                # Find the pre-merge state
git log --oneline <reflog-ref>            # Verify it has the missing commits
# Cherry-pick or reset as appropriate — ask user if unsure
```

### P6. Resume Sequential

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
- Never proceed after parallel merge without verifying commit history against the recorded HEAD anchor
- Never mix sequential and parallel dispatch in the same batch — finish one mode before switching to the other
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
