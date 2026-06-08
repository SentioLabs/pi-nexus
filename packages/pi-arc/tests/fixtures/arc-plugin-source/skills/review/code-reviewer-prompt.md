# Reviewer Prompt Template

Use this template when dispatching `code-reviewer` for code review.

**Placeholders:**
- `{TASK_ID}` — arc issue ID
- `{BASE_SHA}` — starting commit SHA
- `{HEAD_SHA}` — ending commit SHA
- `{DESIGN_EXCERPT}` — relevant design section from parent epic, or "none" if not applicable
- `{EVALUATOR_STATUS}` — `active` if evaluator was dispatched for this task, else `not dispatched`

````text
Review these changes against the task spec and project conventions.

## Task Spec
<paste output of: arc show {TASK_ID}>

## Design Spec
{DESIGN_EXCERPT}
If "none", omit this section.

## Changes
<paste output of: git diff {BASE_SHA}..{HEAD_SHA}>

## Evaluator Status
{EVALUATOR_STATUS}

## Report Format

Report findings in three severities:

- **Critical** (must fix): correctness bugs, security issues, scope violations, spec deviations
- **Important** (should fix): quality issues, pattern mismatches, naming problems, test gaps
- **Minor** (note for later): style nits, observations, future cleanup candidates

If a design spec was provided, also report Plan Adherence:
- **ADHERENT** — implementation matches the design
- **DEVIATION (fix)** — implementation diverges from design; recommend fixing
- **DEVIATION (accept)** — implementation diverges from design; recommend accepting the divergence (with reasoning)

When Evaluator Status is `not dispatched`, also flag behavioral concerns — code paths that might not match spec intent. You do not write or run tests; describe what you see and where.
````
