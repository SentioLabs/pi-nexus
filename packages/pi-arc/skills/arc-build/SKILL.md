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

Arc model selection resolves in this order: explicit dispatch override → configured `modelProfiles` from `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json` → legacy `arc.modelTiers` / frontmatter → package defaults. Removing an execution fallback does not remove model fallback. Users should run `/arc-models`; omit `model:` when the configured role profile should remain authoritative.

| Tier | Default concrete model | Use for |
|---|---|---|
| `nano` | `openai-codex/gpt-5.6-luna` | Bulk CLI issue creation and other low-reasoning issue-manager work |
| `small` | `openai-codex/gpt-5.6-luna` | Mechanical edits and docs |
| `standard` | `openai-codex/gpt-5.6-terra` | Normal contained implementation/review |
| `large` | `openai-codex/gpt-5.6-sol` | Cross-cutting, architectural, security-sensitive, or adversarial review |

Legacy aliases remain compatible: `haiku` → `small`, `sonnet` → `standard`, `opus` → `large`. The dedicated `devopsBuilder` profile uses `large`; `issueManager` normally uses `nano`.

Delegated Arc work requires loaded, enabled `pi-subagents` and the required Arc specialist. Check `subagent({ action: "list", capabilities: true })` first. Dispatch only executable, non-disabled native Arc agents; never substitute a generic agent for Arc review gates. Diagnose missing materialization with native doctor and existing Arc warnings. `/arc-subagents-sync` remains deprecated explicit repair, not automatic activation. If the requirement is still unmet, stop with setup guidance. `arc_agent` uses the same provider and is not an independent fallback.

A single implementation handoff can use `subagent({ agent: "arc-builder", task: "<filled builder prompt>", context: "fresh", async: true });`; `arc_agent(agent="builder", task="<filled builder prompt>")` is the one-specialist Arc-facing alternative using that same provider. Both return dispatch receipts before completion. Capture the native run reference, then return control for native completion. Do not poll, sleep-loop, or call `bg_wait` merely to wait for ordinary notified runs. Use native status/fleet/transcript only for a deliberate inspection or recovery decision.

On notification, inspect native terminal state and final artifacts before interpreting the completed Arc specialist report. Runtime failure, pause, stop, incomplete or malformed result blocks the Arc stage regardless of successful prose. A receipt cannot advance tests, review, patch application or issue closure. Preserve parent verification and review gates.


Native workflow, launch, extension or child-tooling failure is an infrastructure blocker. Record exact run/status, cwd/worktree/branch/HEAD and partial diff; stop and use only explicit same-protocol recovery. Never switch runner/provider/CLI mode or automatically retry an uncertain dispatch. Do not escalate models merely because the harness failed.


| Task signal | Dispatch `model:` |
|---|---|
| Bulk issue creation or other low-reasoning Arc CLI operations | `nano` |
| Mechanical: 1-2 files, unambiguous | `small` |
| Standard contained implementation | omit `model:` or use `standard` |
| Cross-layer, architectural, security-sensitive | `large` |
| `NEEDS_CONTEXT` | same model, richer context |

Do not escalate a model merely because execution infrastructure failed. For a genuine reasoning limit, follow the existing bounded tier escalation and stop at `large`.

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

Native worktree runs return handoff metadata such as `outputReference`, `outputPathMapping`, or `artifactPaths`. They do not implicitly apply or merge changes. Inspect each handoff and its native retention/cleanup facts, then explicitly apply, verify, commit, and close accepted work.

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

Record `PRE_TASK_SHA=$(git rev-parse HEAD)`, fetch the parent design excerpt, and inspect labels. Route with exact precedence `docs-only` → `devops` → normal builder:

- `docs-only`: fill `./doc-writer-prompt.md`; use `arc-doc-writer` (profile `docWriter`).
- `devops`: fill `./devops-builder-prompt.md`; use `arc-devops-builder` (profile `devopsBuilder`). It follows PLAN → SAFEGUARD → APPLY → VERIFY → GATE. Never put live-system work in a parallel patch batch.
- otherwise: fill `./builder-prompt.md`; use `arc-builder` (profile `builder`).

For one handoff, call `subagent({ agent: "<required-arc-agent>", task: "<filled prompt>", context: "fresh", async: true });`. The Arc-facing `arc_agent(agent="<role>", task="<filled prompt>")` alternative is also asynchronous and uses the same provider; for the DevOps route that is `arc_agent(agent="devops-builder", task="<filled prompt>")`. Omit `model:` to preserve the configured profile; use an explicit override only for deliberate model selection.

Delegated Arc work requires loaded, enabled `pi-subagents` and the required Arc specialist. Check `subagent({ action: "list", capabilities: true })` first. Dispatch only executable, non-disabled native Arc agents; never substitute a generic agent for Arc review gates. Diagnose missing materialization with native doctor and existing Arc warnings. `/arc-subagents-sync` remains deprecated explicit repair, not automatic activation. If the requirement is still unmet, stop with setup guidance. `arc_agent` uses the same provider and is not an independent fallback.


On notification, inspect native terminal state and final artifacts before interpreting the completed Arc specialist report. Runtime failure, pause, stop, incomplete or malformed result blocks the Arc stage regardless of successful prose. A receipt cannot advance tests, review, patch application or issue closure. Preserve parent verification and review gates.


Native workflow, launch, extension or child-tooling failure is an infrastructure blocker. Record exact run/status, cwd/worktree/branch/HEAD and partial diff; stop and use only explicit same-protocol recovery. Never switch runner/provider/CLI mode or automatically retry an uncertain dispatch. Do not escalate models merely because the harness failed.


Do not evaluate the specialist report until native completion identifies a terminal successful run and the final result/artifacts are present.

### 4. Evaluate Result

After native completion confirms successful terminal runtime state and final artifacts, interpret the completed Arc specialist report's **Status** (one of `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`) and **Gate Results**. Follow the `## Handle Implementer Status` table below for the status-specific action. In all cases, run the project test command fresh yourself — do NOT trust the specialist report alone.

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
- For `BLOCKED`: classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths.
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

Mandatory spec review is an Arc acceptance gate, not generic dispatch. It requires the separately installed native provider and exact `arc-spec-reviewer` capability. There is no shared-cwd, `arc_agent`, generic-agent, provider-runner, or CLI fallback for this gate. If capability or evidence is unavailable, stop with setup or infrastructure guidance.

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

#### Implementation diff range

After the clean-source preflight and before materializing the spec-review input, define the committed implementation range anchored at the pre-task SHA and the immutable review base:

```bash
BASE_SHA=$PRE_TASK_SHA
HEAD_SHA=$REVIEW_BASE
test -n "$BASE_SHA"
test -n "$HEAD_SHA"
```

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
chmod 0444 "$REVIEW_INPUT_DIR/diff.patch"
DIFF_SHA256=$(sha256sum "$REVIEW_INPUT_DIR/diff.patch" | awk '{print $1}')
```

Physically resolve and contain-check the absolute temporary parent before `mktemp`; reject a relative `TMPDIR` or a symlinked `TMPDIR` that resolves inside the repository before any artifact directory exists. After creation, physically resolve and contain-check the created directory again as race defense. External physical parents remain valid. Failed diff materialization exits before chmod or hashing. Do not remove the created review-input directory or partial diff artifact on failure; retain it as failure evidence.

The filled prompt records the external diff path, SHA-256, base, and head. It also records the canonical task hash and design excerpt. The reviewer receives no shell or write-capable tool. Mode 0444 is defense in depth, but mode 0444 alone does not prove the bytes remained unchanged; the post-review SHA-256 check is authoritative, and any hash mismatch blocks acceptance.

#### One native isolated reviewer

Immediately before outer launch, require `test "$(git rev-parse HEAD)" = "$REVIEW_BASE"`. Then launch exactly one awaited foreground reviewer inside an asynchronous native workflow:

```typescript
subagent({
  workflowScript: `return await runs.run("spec-review", {
    agent: "arc-spec-reviewer",
    task: "<filled immutable review prompt>",
    worktree: true,
    async: false,
    output: "spec-review.md"
  });`,
  context: "fresh", async: true,
  globalConcurrencyLimit: 1,
  baseRef: "HEAD"
})
```

The stable inner key, exact agent, foreground `async: false`, `worktree: true`, and string output binding are mandatory. The literal outer base ref uses symbolic `HEAD`, resolved at worktree allocation by `pi-subagents`; `REVIEW_BASE` remains the immutable full-SHA verification anchor. The outer workflow remains asynchronous while its exactly one awaited inner foreground child completes. Capture the current outer launch's exact returned receipt before returning control; do not use a later notification or a discovered async directory as a substitute:

```bash
OUTER_LAUNCH_RECEIPT='<exact outer launch receipt returned by subagent>'
OUTER_RUN_ID=$(printf '%s' "$OUTER_LAUNCH_RECEIPT" | jq -er '.runId | strings | select(length > 0)')
NATIVE_ASYNC_DIR=$(printf '%s' "$OUTER_LAUNCH_RECEIPT" | jq -er '.details.asyncDir | strings | select(length > 0)')
NATIVE_STATUS_PATH="$NATIVE_ASYNC_DIR/status.json"
test -r "$NATIVE_STATUS_PATH"
```

`NATIVE_ASYNC_DIR` comes only from this launch receipt's exact `details.asyncDir`; read only its `status.json`. Omit `model:` so the configured specReviewer profile and existing model fallback precedence remain authoritative. Do not poll merely to wait.

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
test "$(sha256sum "$REVIEW_INPUT_DIR/diff.patch" | awk '{print $1}')" = "$DIFF_SHA256"
```

Acceptance combines runtime and output evidence with handoff evidence; none substitutes for another. Require the exact persisted native async `status.json` after the completion notification or status observation, before reading spec review prose. The persisted status JSON is the durable exact native evidence for both terminal state and the complete foreground child result: its top-level `.runId` must equal the current `$OUTER_RUN_ID`, `.state == "complete"` is workflow success, `.error == null` is required, and `.workflow.value` is `CHILD_RESULT`. The public completion notification is projected prose, not JSON; it does not carry `.workflow.value` and must not be parsed, merged with, or reconstructed into status evidence. Preserve the exact persisted status JSON as `NATIVE_STATUS_JSON`; never merge or reconstruct evidence fields. In the child result's string-array `artifactPaths`, require exactly one returned path ending in `handoffs/<run-id>.json`; never construct or infer it:

```bash
NATIVE_STATUS_JSON=$(cat "$NATIVE_STATUS_PATH")
printf '%s' "$NATIVE_STATUS_JSON" | jq -e --arg outerRunId "$OUTER_RUN_ID" '
  .runId == $outerRunId
  and .state == "complete"
  and (.error == null)
' >/dev/null
CHILD_RESULT=$(printf '%s' "$NATIVE_STATUS_JSON" | jq -ce '.workflow.value')
printf '%s' "$CHILD_RESULT" |
  jq -e --arg key "spec-review" --arg agent "arc-spec-reviewer" --arg output "/spec-review.md" '
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
  jq -e --arg base "$REVIEW_BASE" --arg key "spec-review" --arg agent "arc-spec-reviewer" '
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

Handle results:
- `COMPLIANT` → proceed to Step 6
- `ISSUES (Missing)` → re-dispatch `builder` with specific gaps listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Extra)` → re-dispatch `builder` to remove the extras listed by the spec reviewer. Re-run spec compliance review after.
- `ISSUES (Misunderstood)` → re-dispatch `builder` with clarification from the spec reviewer's findings. Re-run spec compliance review after.
- Apply the combined four-launched-run spec/code budget from this gate's versioned issue ledger; there is no separate per-finding or per-reviewer circuit breaker.

> **Docs-only tasks**: Skip this step. The spec-reviewer is designed around code verification (file lists, function signatures, test coverage) and doesn't apply to documentation. For docs-only tasks, the orchestrator verifies formatting/completeness directly: check that all files in `## Files` were created/modified, links resolve, heading hierarchy is correct, code blocks have language tags.

> **DevOps tasks**: If the task committed IaC/config/manifests (non-empty `$PRE_TASK_SHA..HEAD` diff), dispatch the `spec-reviewer` as normal — it compares the committed diff to the spec. If the change was **imperative-only** (empty diff), there's nothing for a diff-based reviewer to read; instead the orchestrator verifies spec compliance directly: for each step in `## Steps` and each assertion in `## Verification`, confirm the report's verification evidence shows it was done against the live system. Flag any spec step with no corresponding evidence as a gap and re-dispatch.

### 6. Code Quality Review

Only after spec compliance passes, invoke the `review` skill and follow its mandatory isolated `code-review` workflow exactly. Do not dispatch `code-reviewer` directly and do not use `arc_agent` for this acceptance gate:

```bash
HEAD_SHA=$(git rev-parse HEAD)
```

Use `../arc-review/code-reviewer-prompt.md` and supply its complete immutable `ReviewInput`. The parent obtains `{DESIGN_EXCERPT}` directly with `arc show <parent-epic-id>` and uses "none" when no parent design exists; the reviewer never runs Arc. Include canonical task/hash, exact diff path/hash/base/head, prior findings, exact newest fix delta for re-review, cycle, and evaluator status. The configured `codeReviewer` profile remains authoritative through the review skill's native workflow.

**On `{EVALUATOR_STATUS}`:** Decide whether to dispatch the evaluator (step 6.5) BEFORE filling this placeholder. If you plan to run step 6.5 in parallel with step 6, set `{EVALUATOR_STATUS}="active"`. Otherwise set `"not dispatched"`. Step 6.5 has the decision criteria for when to dispatch the evaluator.

Handle findings:

| Finding | Action |
|---------|--------|
| **Critical/Important** | Re-dispatch `builder` with fixes. Re-review after. |
| **Minor** | Note in arc comment. Proceed. |
| **Deviation (fix)** | Re-dispatch `builder` to match the design. |
| **Deviation (accept)** | Log as arc comment: "Accepted deviation: \<description\>. Rationale: \<why\>." Proceed. |

Use the combined four-launched-run spec/code budget from the versioned issue ledger. A fifth reviewer launch requires explicit owner authorization recorded with a finite additional count.

> **Docs-only tasks**: Skip code quality review. For substantial documentation changes (developer-facing API docs, architecture docs), optionally dispatch `code-reviewer` for a quality check.

> **DevOps tasks**: When the task committed IaC/config/manifests, dispatch `code-reviewer` — review it through an ops lens: no hardcoded secrets or credentials, least-privilege (IAM/RBAC), pinned versions/digests, idempotency, and resource limits where applicable. When the change was imperative-only (no diff), skip `code-reviewer` and instead confirm the `devops-builder`'s gate evidence directly: idempotency (a clean second dry-run), no leftover debris (uncordoned nodes, no debug pods/port-forwards), and a reachable rollback path.

### 6.5. High-Risk Evaluation (Optional)

The evaluator is **not dispatched by default**. Dispatch only when:
- Task has a `high-risk` label
- The orchestrator judges the task warrants independent verification (e.g., complex spec with multiple valid interpretations, security-sensitive code, tasks that modify shared contracts)

Evaluations use explicitly requested native worktree isolation. Record the full SHA with `PARALLEL_BASE=$(git rev-parse HEAD)` from the clean checkpoint as immutable verification evidence, then fill `./evaluator-prompt.md`. Do not pass that commit ID as the native `baseRef`; the launch uses symbolic `HEAD`, resolved at worktree allocation.

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
  jq -e --arg base "$PARALLEL_BASE" \
    '.version == 1 and (.groups | type == "array") and (.groups | length > 0) and all(.groups[]; (.baseCommit | type == "string") and (.baseCommit | length > 0) and .baseCommit == $base)' \
    "$HANDOFF_MANIFEST"
```

The command must succeed before the evaluator report is interpreted. Any failure or base mismatch blocks evaluator finding acceptance and requires explicit native inspection/recovery; it is not permission to apply, retry or switch modes.

Ephemeral tests/dependency edits remain isolated and are not commits or merge handoffs. Follow native retention and cleanup facts rather than promising automatic deletion. The configured `evaluator` profile remains authoritative and `large` is its model fallback.

Triage evaluator findings:

| Evaluator verdict | Orchestrator action |
|---|---|
| `PASS` | No action — evaluator confirms the spec intent is satisfied. |
| `CONCERNS` | Read the concerns. Re-dispatch `builder` if the concerns describe substantive behavior gaps. Otherwise note as arc comments and proceed. |
| `FAIL — Spec-Intent Gap` | Re-dispatch `builder` with the evaluator's quoted spec text and the failing behavior description. |
| `FAIL — Missing Behavior` | Re-dispatch `builder` — the spec requires behavior that wasn't built. |
| `FAIL — Edge Case` | Lower-severity. Re-dispatch if the spec clearly implies the edge case; otherwise record as a known limitation. |
| `ERROR — Cannot Test` | The public API is insufficient. Re-dispatch with a request to expose the needed surface. |
| `BLOCKED` | Classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths. |

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

After native completion/runtime success is established, interpret each completed `builder`, `devops-builder`, or `doc-writer` Arc specialist report as one of four statuses. Handle each explicitly:

| Status | Orchestrator action |
|---|---|
| `DONE` | Proceed to spec review, then code review. |
| `DONE_WITH_CONCERNS` | Read the concerns. If they're about correctness or scope, address before review (re-dispatch or tighten review prompt). If they're observations (file getting large, naming doubt), note them as arc comments on the task and proceed to review — close only after a later dispatch yields a clean `DONE`. |
| `BLOCKED` | Classify first; only a verified reasoning-limit blocker may cause a one-tier model escalation. Infrastructure or tooling failures stop for same-protocol diagnosis/recovery without model escalation; context, scope, and plan blockers follow their specific paths. Never retry an eligible dispatch unchanged. |
| `NEEDS_CONTEXT` | Gather the specific missing information. Re-dispatch with it in the prompt. |

**Never close a task** whose last report was `BLOCKED`, `NEEDS_CONTEXT`, or `DONE_WITH_CONCERNS` unresolved. Re-dispatch until you have a clean `DONE` — then close.

## Parallel Patch Protocol

Use this protocol only for a coordinated `pi-subagents` worktree wave. `arc_agent(isolation="worktree")` supports one child through the same provider, not a coordinated multi-child wave.

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

This full SHA is immutable verification evidence for later history and HEAD checks, not the native `baseRef`. Immediately before worktree allocation, verify symbolic `HEAD` still resolves to it.

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
  jq -e --arg base "$PARALLEL_BASE" \
    '.version == 1 and (.groups | type == "array") and (.groups | length > 0) and all(.groups[]; (.baseCommit | type == "string") and (.baseCommit | length > 0) and .baseCommit == $base)' \
    "$HANDOFF_MANIFEST"
```

Every distinct manifest check must succeed, proving `version: 1`, nonempty `groups`, and that every relevant `groups[].baseCommit` equals `$PARALLEL_BASE`. Any failure or base mismatch blocks patch acceptance and requires explicit native inspection/recovery; it is not permission to apply, retry or switch modes.

There is no implicit merge or cleanup: follow the validated native handoff manifest and retention/cleanup facts. A failed, paused, stopped, incomplete, or malformed child blocks its handoff regardless of `DONE` prose, and a rejected handoff is not permission to switch mode.

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
- Use the native targeted-fix protocol below; do not silently switch execution mode.

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
## Targeted Fix and Recovery

For a requested repair, consult native retained-child/resumability information. If the appropriate latest writer is resumable, use `subagent({ action: "resume", id: "<native-run-id>", message: "<specific verified fixes>" });`; for a live child use native steering. Capture the returned native identity. Do not fabricate continuity or implement Arc session validation. If native recovery is unavailable, stop for an explicit same-protocol fresh attempt with current scope and prior findings. Reviews remain fresh independent Arc specialist runs. Keep existing fix-cycle limits.

A recovery result must pass the same native terminal-state, artifact, parent-test, spec-review, and code-review gates. Provider failure is not a reasoning failure and does not justify model escalation.


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
- Classify every `BLOCKED` report before choosing a response. Only a verified reasoning-limit blocker may escalate one model tier. Infrastructure or tooling failures must stop for same-protocol diagnosis or recovery without model escalation; context, scope, or plan blockers follow their specific handling above.
- If in doubt about the result, re-dispatch rather than fixing manually
- Never dispatch parallel agents without committing and pushing all sequential work first
- Never dispatch parallel agents on tasks that share files
- Never use parallel patch mode unless `pi-subagents` and Arc `pi-subagents` agent definitions are available
- Never apply more than one parallel patch at a time; apply, verify, review, commit, and close each task independently
- Never proceed after a parallel patch batch without verifying commit history against the recorded HEAD anchor
- Never mix sequential and parallel dispatch in the same batch — finish one mode before switching to the other
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
