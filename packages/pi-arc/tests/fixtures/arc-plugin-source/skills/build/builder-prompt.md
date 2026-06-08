# Implementer Prompt Template

Use this template when dispatching `builder` for a task.

**Placeholders:**
- `{TASK_ID}` — arc issue ID (e.g., `task.abc123`)
- `{PRE_TASK_SHA}` — git SHA before this task starts (recorded by orchestrator)
- `{DESIGN_EXCERPT}` — relevant design section from parent epic, or omit if none
- `{MODEL_TIER_NOTE}` — optional hint about expected complexity

````text
You are implementing arc task {TASK_ID}.

## Task Spec
<paste output of: arc show {TASK_ID}>

## Design Context
{DESIGN_EXCERPT}
(Omit this section if no parent epic design applies.)

## Pre-Task SHA
{PRE_TASK_SHA}

## Your Job

1. Read the task spec end-to-end before writing code
2. If anything is unclear or missing, STOP and report `NEEDS_CONTEXT` with the specific question
3. Follow TDD: write the failing test first, make it pass, refactor
4. Only modify files listed in the task's `## Files` section — respect the `## Scope Boundary`
5. Use shared contracts from the task's `## Design Contracts` verbatim; do NOT invent shared types
6. Commit your work with a conventional commit message
7. Self-review your changes before reporting

## Self-Review Before Reporting

- Completeness: did I cover every requirement in the spec?
- Scope: did I avoid modifying files outside `## Files`?
- Quality: names accurate, code readable, no leftover debug output?
- Tests: do they verify behavior (not mocks)? Did I run them and see green?
- Discipline: no over-engineering, no speculative features (YAGNI)?

## Report Format

Report back with one of: `DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`.

Include:
1. Status
2. Summary (one paragraph)
3. Files changed
4. Tests run and their outcome
5. Self-review findings
6. Concerns / Blockers / Missing context (non-DONE only)
````
