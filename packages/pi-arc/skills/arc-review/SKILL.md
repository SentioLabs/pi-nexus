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

Fill `./code-reviewer-prompt.md` with `{TASK_ID}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESIGN_EXCERPT}`, and `{EVALUATOR_STATUS}`. Preserve `Review only; return findings only. Do not edit files.`

Delegated Arc work requires loaded, enabled `pi-subagents` and the required Arc specialist. Check `subagent({ action: "list", capabilities: true })` first. Dispatch only executable, non-disabled native Arc agents; never substitute a generic agent for Arc review gates. Diagnose missing materialization with native doctor and existing Arc warnings. `/arc-subagents-sync` remains deprecated explicit repair, not automatic activation. If the requirement is still unmet, stop with setup guidance. `arc_agent` uses the same provider and is not an independent fallback.

A single handoff can use `subagent({ agent: "arc-builder", task: "<filled prompt>", context: "fresh", async: true });`; `arc_agent` remains a one-specialist Arc-facing alternative using that same provider. Both return dispatch receipts before completion. Capture the native run reference, then return control for native completion. Do not poll, sleep-loop, or call `bg_wait` merely to wait for ordinary notified runs. Use native status/fleet/transcript only for a deliberate inspection or recovery decision.

On notification, inspect native terminal state and final artifacts before interpreting the Arc specialist's report. Runtime failure, pause, stop, incomplete or malformed result blocks the Arc stage regardless of successful prose. A receipt cannot advance tests, review, patch application or issue closure. Preserve parent verification and review gates.

Native workflow, launch, extension or child-tooling failure is an infrastructure blocker. Record exact run/status, cwd/worktree/branch/HEAD and partial diff; stop and use only explicit same-protocol recovery. Never switch runner/provider/CLI mode or automatically retry an uncertain dispatch. Do not escalate models merely because the harness failed.

Dispatch one fresh review with `subagent({ agent: "arc-code-reviewer", task: "<filled prompt>", context: "fresh", async: true });` or the same-provider Arc-facing `arc_agent(agent="code-reviewer", task="<filled prompt>")`. Omit `model:` so `codeReviewer` profile precedence and its model fallback remain authoritative.

Return control for native completion. On notification, require successful terminal runtime state and a complete final review artifact before triage. Never infer a clean review from a launch receipt, missing findings, or successful prose attached to a failed/paused/stopped/incomplete/malformed run. Reviews after fixes are fresh independent `arc-code-reviewer` runs.

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

**Circuit breaker**: If 3 review/fix cycles on the same task haven't resolved all findings, STOP. Escalate to the user with a summary of what keeps recurring — the reviewer and implementer may disagree on the approach, or the task spec may be ambiguous.

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
