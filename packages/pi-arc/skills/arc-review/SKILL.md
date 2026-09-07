---
name: arc-review
description: You MUST use this skill after implementing a task to get code review — especially when the user says "review this", "check my code", "review the changes", or after any implementation task completes. Dispatches the code-reviewer agent with git diff and task spec, then triages feedback by severity. Always prefer this over generic code review when the project uses arc issue tracking.
---

# Review — Code Review Dispatch

Dispatch the `code-reviewer` subagent to review implementation work, then triage findings.

## Workflow

Create a checklist using the bundled `todo` tool (or `/todos`) with these steps:

### 1. Get Git SHAs

Use the `PRE_TASK_SHA` recorded by the build skill before dispatching the implementer:

```bash
BASE_SHA=$PRE_TASK_SHA
HEAD_SHA=$(git rev-parse HEAD)
```

If `PRE_TASK_SHA` is not available (e.g., standalone review), determine the range manually:

```bash
# Check recent commits to identify where the task's work begins
git log --oneline -10
# Set BASE_SHA to the commit before the task's first change
BASE_SHA=$(git rev-parse <commit-before-task>)
HEAD_SHA=$(git rev-parse HEAD)
```

### 2. Get Design Context

If the review was invoked from the build skill, a design excerpt should be available. Retrieve it:

```bash
# Get the parent epic of this task
arc show <task-id> --json | jq -r '.parent_id // empty'
# If parent exists, get the epic's plan content
arc show <parent-epic-id>
```

Extract the design excerpt relevant to this task — typically the sections covering the types, interfaces, and architectural decisions this task implements. If no parent epic exists or no design is available, skip the design spec section in the dispatch prompt.

### 3. Dispatch Reviewer

Mandatory code review is an Arc acceptance gate, not generic dispatch. It requires the separately installed native provider and exact `arc-code-reviewer` capability. There is no shared-cwd, `arc_agent`, generic-agent, provider-runner, or CLI fallback for this gate. If capability or evidence is unavailable, stop with setup or infrastructure guidance. The obsolete direct shared-cwd form `subagent({ agent: "arc-code-reviewer", task: "<filled reviewer prompt>", context: "fresh", async: true });` is shown only to identify and reject it; never execute it for mandatory review.

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

The Arc issue description is both canonical task input and durable budget storage. On first review, preserve the complete canonical description bytes and byte-concatenate the sentinel directly after them without inserting, removing, or normalizing a delimiter. This keeps the byte slice before the sentinel identical even when Arc has trimmed a trailing newline. The actual ledger boundary is the last exact sentinel because canonical task prose or code may quote earlier sentinel examples. Append exactly this versioned boundary and header:

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

Spec and code review share one combined four-run task budget across sessions and cycles. Before each launch, count all rows carrying a native run identity. Every returned native run identity consumes exactly one row, including a run that later fails; record its row as soon as the launch returns the identity, then update only that row's elapsed time and disposition after completion. A pre-submission failure that returns no native run identity does not consume a row. Reject the fifth launch unless the owner explicitly authorizes a bounded extension recorded as `Owner-authorized additional reviewer runs: <finite-positive-integer>` below the ledger. The allowed total is four plus the sum of those explicit finite grants; open-ended, inferred, or model-authored authorization is invalid. After every ledger append/update, re-read the issue, split at the last exact sentinel, and verify the SHA-256 of the unchanged prefix before continuing. After ledger initialization, no last boundary means the ledger is malformed: fail closed instead of treating the full description as canonical.

#### Immutable parent-supplied input

Materialize `ReviewInput { canonical_spec, canonical_sha256, design_excerpt, diff_path, diff_sha256, prior_findings?, cycle }` in the prompt. The parent supplies the canonical Arc task description above the sentinel and the approved design excerpt; the reviewer never needs Arc CLI or Git. For re-review, include prior findings verbatim and the exact newest fix delta. Outside-delta findings may newly block only when the newest delta exposes a critical latent correctness or safety defect; unrelated noncritical observations become follow-ups.

Small diffs may be inline, with their SHA-256 recorded. For a non-inline diff, create the artifact outside the repository and make it immutable before launch:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
REVIEW_INPUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arc-review-input.XXXXXX")
case "$REVIEW_INPUT_DIR/" in "$REPO_ROOT/"*) echo 'review input must be outside the repository' >&2; exit 1 ;; esac
git diff --binary --find-renames=0 "$BASE_SHA..$HEAD_SHA" > "$REVIEW_INPUT_DIR/diff.patch"
chmod 0444 "$REVIEW_INPUT_DIR/diff.patch"
DIFF_SHA256=$(sha256sum "$REVIEW_INPUT_DIR/diff.patch" | awk '{print $1}')
```

The filled prompt records the external diff path, SHA-256, base, and head. It also records the canonical task hash and design excerpt. The reviewer receives no shell or write-capable tool.

#### One native isolated reviewer

Immediately before outer launch, require `test "$(git rev-parse HEAD)" = "$REVIEW_BASE"`. Then launch exactly one awaited foreground reviewer inside an asynchronous native workflow:

```typescript
subagent({
  workflowScript: `return await runs.run("code-review", {
    agent: "arc-code-reviewer",
    task: "<filled immutable review prompt>",
    worktree: true,
    async: false,
    output: "code-review.md"
  });`,
  context: "fresh",
  async: true,
  globalConcurrencyLimit: 1,
  baseRef: "HEAD"
})
```

The stable inner key, exact agent, foreground `async: false`, `worktree: true`, and string output binding are mandatory. The outer workflow stays `async: true` and returns control for native completion. Omit `model:` so the configured codeReviewer profile and existing model fallback precedence remain authoritative. Do not poll merely to wait.

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

Require successful outer workflow completion and the complete foreground child result. In that result's string-array `artifactPaths`, require exactly one returned path ending in `handoffs/<run-id>.json`; never construct or infer it. Validate the native handoff before reading code review prose:

```bash
HANDOFF_MANIFEST='<exact handoffs/<run-id>.json path returned in artifactPaths>'
test -n "$HANDOFF_MANIFEST" && test -r "$HANDOFF_MANIFEST" &&
  jq -e --arg base "$REVIEW_BASE" --arg key "code-review" --arg agent "arc-code-reviewer" '
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

Missing or malformed output, runtime failure, wrong workflow/agent identity, wrong base, more or fewer than one child, any patch/error evidence, a changed canonical/diff input hash, or a changed primary branch/HEAD/status blocks acceptance. Arc never applies reviewer patches. Only after all native, immutable-input, and post-run evidence passes may Arc interpret the report and apply its finding-disposition policy.

### 4. Triage Feedback

When the reviewer reports back:

| Severity | Action |
|----------|--------|
| **Critical** | Fix immediately — re-dispatch `builder` with the specific fix. Then re-review. |
| **Important** | Fix before moving to next task — re-dispatch `builder`. Then re-review. |
| **Minor** | Note in arc issue comment for later. Proceed. |
| **Deviation (fix)** | Re-dispatch `builder` with the specific deviation to correct. |
| **Deviation (accept)** | Note the deviation as an arc comment on the task for traceability. Proceed. |

### 5. Handle Fixes

If fixes are needed:
1. Re-dispatch `builder` with the specific findings to address
2. After the implementer reports back, re-review (go to step 1 with updated SHAs)
3. Continue until the review is clean (no Critical or Important findings)

**Combined reviewer budget**: Use the combined four-launched-run spec/code budget in the versioned Arc issue ledger. Every native reviewer run identity consumes one row even if it fails. A fifth launch requires explicit owner authorization recorded with a finite additional count; there is no separate three-cycle or per-finding reviewer allowance.

### 6. Proceed

- If all tasks are done → invoke `finish`
- If more tasks remain → return to `build` for the next task

## Response Discipline

Receiving review feedback requires technical evaluation, not emotional performance. Verify before implementing. Ask before assuming.

### Forbidden Responses

Never write:

- "You're absolutely right!"
- "Great point!"
- "Excellent feedback!"
- "Let me implement that now" (before verification)

These are performative and explicitly violate project discipline. They signal acceptance before understanding.

### Instead

- **Restate** the technical requirement in your own words
- **Ask** clarifying questions when the feedback is unclear
- **Push back** with technical reasoning when the feedback is wrong
- **Just start working** — actions beat performative agreement

### The Verification Pattern

Apply this pattern to every finding:

1. **READ** — Read the complete feedback without reacting
2. **UNDERSTAND** — Restate the requirement in your own words (or ask for clarification)
3. **VERIFY** — Check the claim against the actual codebase
4. **EVALUATE** — Is the feedback technically sound for *this* codebase's conventions?
5. **RESPOND** — Technical acknowledgment ("Confirmed, file X line Y has the issue") OR reasoned pushback ("Disagree: file X line Y actually does handle this case — test Z covers it")
6. **IMPLEMENT** — Fix one finding at a time, verify each before moving to the next

### Triage by Severity

When the `code-reviewer` reports findings, triage by severity:

| Severity | Action |
|----------|--------|
| **Critical** | Fix immediately — re-dispatch `builder` with the specific fix. Then re-review. |
| **Important** | Fix before moving to next task — re-dispatch `builder`. Then re-review. |
| **Minor** | Note in arc issue comment for later. Proceed. |
| **Deviation (fix)** | Re-dispatch `builder` with the specific deviation to correct. |
| **Deviation (accept)** | Note the deviation as an arc comment on the task for traceability. Proceed. |

Never agree performatively to Critical or Important findings. Never dismiss them without technical reasoning. If a finding is wrong, show *why* with evidence from the codebase.

## Relationship to the Evaluator

The evaluator is **not always present**. Your dispatch prompt includes an `## Evaluator Status` line that tells you whether the evaluator is running for this task.

**When Evaluator Status is `active`** (high-risk tasks):

The evaluator runs in parallel with you. Your concerns are complementary:

| | Reviewer (you) | Evaluator |
|---|---|---|
| **Focus** | Code quality, conventions, plan adherence | Spec-intent compliance via independent testing |
| **Input** | Git diff + spec | Spec only (no diff) |
| **Modifies code?** | No | Writes ephemeral acceptance tests, then deletes them |

Focus on code quality, naming, structure, conventions, and plan adherence. Defer behavioral verification to the evaluator's actual tests.

**When Evaluator Status is `not dispatched`** (default path):

You are the only reviewer. In addition to code quality and plan adherence, **flag behavioral concerns** — code paths that look like they might not match the spec, edge cases that appear unhandled, logic that seems inconsistent with the task's `## Expected Outcome`. Describe the suspected behavior gap and the code path involved so the orchestrator can decide whether to escalate to the evaluator.

You are not expected to write or run tests — that's still the evaluator's job if escalated. But you should flag what you see.

## Contexts

This skill works in orchestrated Arc execution:

| Context | How review works |
|---------|-----------------|
| **Sequential build** | Main agent dispatches `code-reviewer` subagent after the builder reports completion |
| **Parallel patch batch** | Main agent applies each accepted patch to the main worktree, then dispatches `code-reviewer` against the applied diff |

## Rules

- Always review after implementation — don't skip to close
- Re-review after fixes — don't assume fixes are correct
- The reviewer reports; you decide what to do with the findings
- Never make code changes in the review skill — dispatch the implementer for fixes
- Focus on code quality and conventions. Flag behavioral concerns when no evaluator is present.
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
