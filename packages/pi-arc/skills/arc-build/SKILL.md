---
name: arc-build
description: You MUST use this skill to execute implementation tasks from a planning artifact (the design + breakdown produced by /arc-brainstorm and /arc-plan) — especially when the user says "implement this", "build this", "execute the plan", "start coding", or wants to dispatch subagents for TDD execution of arc issues. The main agent orchestrates; it never writes implementation code directly. Always prefer this over generic implementation when the project uses arc issue tracking.
---

# Implement — Subagent-Driven TDD Execution

Orchestrate task implementation by dispatching fresh `builder` subagents per task. Each subagent gets a clean context window with just the task description.

## Core Rule

**The main agent NEVER writes implementation code.** It orchestrates, dispatches, and reviews. If you're tempted to "just quickly fix this" — dispatch a subagent instead.

## Pre-flight: Branch Setup

Before dispatching any task, perform the protected-branch check per `skills/arc/_branch-check.md`.

This catches the case where build was invoked without going through `brainstorm` first. Subagents commit to whatever branch the main agent is on — and the parallel-dispatch checkpoint push (P1) goes there too. Discovering at finish time that an entire epic landed on trunk is not recoverable cheaply. Suggest a branch name from the epic/task title if the user picks "switch."

## Model Selection

`modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json` are the preferred role-specific policy. Resolution is: explicit dispatch `model:` override, configured role profile, legacy `arc.modelTiers`, then package defaults. Existing profiles, including Sol or custom models, remain authoritative; recommendations never rewrite them. The legacy tier map remains model-only.

| Role / tier | Recommended model and effort | Use for |
|---|---|---|
| issueManager / `nano` | Luna, `off` | Low-reasoning Arc CLI work |
| docWriter / `small` | Luna, `low` | Documentation and mechanical edits |
| builder / `standard` | Terra, `medium` | Contained implementation |
| brainstorm, plan | Astra, `high` | Design exploration and task sequencing |
| devopsBuilder, codeReviewer, specReviewer, evaluator / `large` | Astra, `high` | Operations, review, and adversarial validation |

Package defaults are Luna for `nano`/`small`, Terra for `standard`, and Astra for `large`. Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; it does not support `off`/`none`, so `low` is its minimum effective effort. The picker only offers levels advertised by the active model. `xhigh` and `max` are deliberate exceptional escalations, not default retries; fix missing context or failing tools rather than blindly increasing effort.

Terra at `high` is the cost-sensitive option for harder but bounded implementation. Astra at `low` or `medium` is an explicit choice when stronger model capability is needed without maximum effort; no direct Arc benchmark exists showing Terra-high and Astra-low/medium are equivalent. API prices are not Codex quota prices—compare accepted-task quality, retries, total tokens/cost, and elapsed time on representative work before changing cost-sensitive defaults.

Examples use Pi-native `model:effort` suffixes when an explicit override is intended:

```text
# Preferred pi-subagents dispatches; omit model to preserve the configured role profile.
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-5.6-terra:high", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-6-astra:low", context: "fresh", async: true, clarify: false })
subagent({ agent: "arc-builder", task: "...", model: "openai-codex/gpt-6-astra:high", context: "fresh", async: true, clarify: false })
```

Use `openai-codex/gpt-6-astra:xhigh` or `openai-codex/gpt-6-astra:max` only for exceptional, explicitly bounded work. Do not create an automatic max retry ladder. The existing bounded retry ceiling remains: re-dispatches stop at `large`; if that does not resolve the blocker, escalate with the blocker summary rather than increasing effort automatically.

Arc specialists should be auto-materialized by the Arc extension when `pi-subagents` is installed. If `subagent({ action: "list" })` does not show a required Arc specialist, first run `subagent({ action: "doctor" })` and inspect Arc's materialization warning. Use `/arc-subagents-sync` only as a deprecated repair command. Otherwise use the bundled sequential `arc_agent` fallback.

| Task signal | Dispatch `model:` |
|---|---|
| Bulk issue creation or other low-reasoning Arc CLI operations | omit (issueManager profile) or `nano` fallback |
| Mechanical, unambiguous work | omit (docWriter profile) or `small` fallback |
| Standard contained implementation | omit (builder profile) or `standard` fallback |
| Cross-layer, high-risk, or adversarial work | omit (configured role profile) or `large` fallback |
| Re-dispatch after `BLOCKED` | fix context/tools or move one tier up, stopping at `large` |
| Re-dispatch after `NEEDS_CONTEXT` | same tier with richer context |

**When unsure, omit `model:`** so the configured role profile remains authoritative.

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

### 1. Find Next Task

```bash
arc ready
# or for a specific epic, include resumed/blocked/deferred children:
arc list --parent=<epic-id> --json | jq '.[] | select(.status != "closed")'
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

### 4. Evaluate Result

When the subagent reports back, check its **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Implementer Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the subagent's report alone.

> **DevOps tasks** (from `devops-builder`): there may be no project test command — the artifact is the live system's state. Verify by re-running the task's `## Verification` commands yourself and confirming each asserts the desired state, then confirm the report's **Rollback path** names a backup/revision that actually exists. Treat a missing or unverifiable rollback path the same as a failing test: do not proceed to review until it's resolved.

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

Use the template at `./spec-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`). The configured `specReviewer` profile is authoritative; the agent's `large` frontmatter is the fallback.

Dispatch preference:
- If `subagent` is available and `arc-spec-reviewer` is installed: `subagent({ agent: "arc-spec-reviewer", task: "<filled prompt>", context: "fresh", async: true, clarify: false })`
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

> **DevOps tasks**: If the task committed IaC/config/manifests (non-empty `$PRE_TASK_SHA..HEAD` diff), dispatch the `spec-reviewer` as normal — it compares the committed diff to the spec. If the change was **imperative-only** (empty diff), there's nothing for a diff-based reviewer to read; instead the orchestrator verifies spec compliance directly: for each step in `## Steps` and each assertion in `## Verification`, confirm the report's verification evidence shows it was done against the live system. Flag any spec step with no corresponding evidence as a gap and re-dispatch.

### 6. Code Quality Review

Only dispatched after spec compliance passes. Use the `review` skill or dispatch `code-reviewer` directly:

```bash
HEAD_SHA=$(git rev-parse HEAD)
```

Use the template at `../arc-review/code-reviewer-prompt.md`. Fill placeholders (`{TASK_ID}`, `{BASE_SHA}` = PRE_TASK_SHA recorded earlier, `{HEAD_SHA}` = current HEAD, `{DESIGN_EXCERPT}` from parent epic or "none" — fetch it per step 3's design-context block, `{EVALUATOR_STATUS}` = "active" if evaluator was dispatched, else "not dispatched"). Follow Model Selection above for the dispatch `model:` — the configured `codeReviewer` profile is authoritative and `large` frontmatter is the fallback.

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

> **DevOps tasks**: When the task committed IaC/config/manifests, dispatch `code-reviewer` — review it through an ops lens: no hardcoded secrets or credentials, least-privilege (IAM/RBAC), pinned versions/digests, idempotency, and resource limits where applicable. When the change was imperative-only (no diff), skip `code-reviewer` and instead confirm the `devops-builder`'s gate evidence directly: idempotency (a clean second dry-run), no leftover debris (uncordoned nodes, no debug pods/port-forwards), and a reachable rollback path.

### 6.5. High-Risk Evaluation (Optional)

The evaluator is **not dispatched by default**. Dispatch only when:
- Task has a `high-risk` label
- The orchestrator judges the task warrants independent verification (e.g., complex spec with multiple valid interpretations, security-sensitive code, tasks that modify shared contracts)

When `pi-subagents` is available, dispatch the evaluator through a one-task worktree-isolated parallel run. This gives it a disposable repository copy so it can write acceptance tests and add temporary dependencies without dirtying the main worktree:

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

After closing 2-3 related tasks, or before switching to a new epic phase, run the full integration test suite. Use the project's integration test command — check the design's `## Test Command`, the project `CLAUDE.md`/`AGENTS.md`, or the `Makefile`/`package.json` for the real target (e.g., `make test-integration`, `npm run test:integration`, `go test -tags=integration ./...`):

```bash
make test-integration   # example — substitute the project's actual command
```

This catches cross-task regressions that individual implementer gate checks won't — each implementer only validates its own task's scope. Do not wait until all tasks are complete to discover integration failures.

If integration tests fail:
- Identify which task's changes caused the failure
- Re-dispatch `builder` with the failing test details and the relevant task context
- If the failure spans multiple tasks, invoke the `debug` skill

### 9. Repeat

Go to step 1 for the next task. Continue until all tasks in the epic are closed.

### 10. Completion Gate

For a standalone task, verify its task-specific command (or live `## Verification` for DevOps), confirm it is closed, skip all epic-only commands, and hand off to `finish`.

For an epic, closing the last selected task is not the same as the epic being done. Before declaring the build complete, verify the epic as a whole — per-task gates only validate each task's own scope:

1. **All tasks closed:** `arc list --parent=<epic-id> --json | jq '[.[] | select(.status != "closed")] | length'` returns `0`. Any `open`, `in_progress`, `blocked`, or `deferred` child keeps the epic open.
2. **Epic-wide verification:** for code/docs epics, run the project's full test command and confirm exit 0. For DevOps-only epics, re-run each task's live `## Verification` and confirm rollback evidence; for mixed epics, run both.
3. **Success criteria met:** re-read the epic description's `## Success Criteria` section (carried from the design). Confirm each criterion is satisfied by the closed tasks. If a criterion has no implementing task, that's a planning gap — surface it to the user rather than closing the epic.
4. **Close the epic** with a summary: `arc close <epic-id> -r "Implemented: <one-line summary of what shipped>"`.
5. **Hand off to `finish`:** the build skill does not commit/push the final state or run the session-close protocol. Invoke the `finish` skill to capture remaining work, run quality gates, and push. Work is not done until `git push` succeeds.

## Handle Implementer Status

Every `builder`, `devops-builder`, and `doc-writer` dispatch returns one of four terminal statuses. Handle each explicitly:

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
    { agent: "arc-builder", task: "<filled builder prompt for task 1>" },
    { agent: "arc-builder", task: "<filled builder prompt for task 2>" },
    { agent: "arc-doc-writer", task: "<filled doc-writer prompt for task 3>" }
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
