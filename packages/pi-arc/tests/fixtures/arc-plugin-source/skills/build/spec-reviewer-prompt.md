# Spec Reviewer Prompt Template

Use this template when dispatching `spec-reviewer` after an implementer reports `DONE`.

**Placeholders:**
- `{TASK_ID}` — arc issue ID
- `{BASE_SHA}` — pre-task SHA (recorded before dispatching the implementer)
- `{HEAD_SHA}` — current HEAD after implementer's commit

````text
You are verifying that arc task {TASK_ID}'s implementation matches its spec exactly.

## Task Spec
<paste output of: arc show {TASK_ID}>

## Changes
<paste output of: git diff {BASE_SHA}..{HEAD_SHA}>

## Your Job

Compare the diff against the spec. For each requirement in the spec:
- Is it implemented? If yes, cite the file and line.
- If no, flag the gap.

For the diff:
- Is anything present that the spec did NOT ask for? Flag it.
- Are files modified outside the task's `## Files` section? Flag as scope violation.

You do NOT write code. You do NOT run tests. You do NOT close issues.

## Report Format

```text
## Result: COMPLIANT | ISSUES

### Missing (only if ISSUES)
- <what's missing, with file:line references>

### Extra (only if ISSUES)
- <what was added beyond spec, with file:line references>

### Misunderstood (only if ISSUES)
- <what was misinterpreted, with spec quote vs actual behavior>
```
````
