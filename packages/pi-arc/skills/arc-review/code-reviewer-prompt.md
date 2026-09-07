# Reviewer Prompt Template

Use this template only for the native isolated mandatory reviewer workflow.

**Placeholders:**
- `{TASK_ID}` — Arc issue ID
- `{CANONICAL_SPEC}` — canonical task-description bytes above the review-ledger sentinel
- `{CANONICAL_SHA256}` — SHA-256 of those canonical bytes
- `{DESIGN_EXCERPT}` — relevant approved design text, or `none`
- `{BASE_SHA}` / `{HEAD_SHA}` — exact implementation diff range
- `{DIFF_PATH}` — absolute read-only external artifact path, or `inline`
- `{DIFF_SHA256}` — SHA-256 of the exact diff bytes
- `{DIFF_CONTENT}` — exact diff when inline, otherwise `read {DIFF_PATH}`
- `{PRIOR_FINDINGS}` — exact prior findings for re-review, or `none`
- `{LATEST_FIX_DELTA}` — exact newest fix delta for re-review, or `none`
- `{CYCLE}` — shared spec/code review cycle number
- `{EVALUATOR_STATUS}` — code review only: `active` or `not dispatched`; otherwise `not applicable`

````text
Review the implementation for Arc task {TASK_ID} against the canonical task spec, approved design, and project conventions.

Review only; return findings only. Do not edit files.

Repository writes or artifacts, Git/ref changes, Arc mutation, package installation, cache/build generation, and writer delegation are prohibited. Do not run Git, Arc, tests, package managers, generators, or delegated writers. Any mutation invalidates the review.

## Review Input

Task: {TASK_ID}
Canonical description SHA-256: {CANONICAL_SHA256}
Diff base: {BASE_SHA}
Diff head: {HEAD_SHA}
Diff path: {DIFF_PATH}
Diff SHA-256: {DIFF_SHA256}
Cycle: {CYCLE}

### Canonical Task Spec
{CANONICAL_SPEC}

### Approved Design Excerpt
{DESIGN_EXCERPT}

### Changes
{DIFF_CONTENT}

### Prior Findings
{PRIOR_FINDINGS}

### Exact Newest Fix Delta
{LATEST_FIX_DELTA}

### Evaluator Status
{EVALUATOR_STATUS}

Use only the supplied canonical task, design excerpt, diff bytes, and repository reads. The parent has already captured Git and Arc state; do not retrieve or mutate either. On re-review, verify the prior findings against the exact newest fix delta, then evaluate the resulting implementation. Findings outside that delta may newly block only for a critical latent correctness or safety defect exposed by the delta; report unrelated noncritical observations as follow-ups.

## Report Format

Report findings in three severities:

- **Critical** (blocking): correctness bugs, security issues, scope violations, spec deviations
- **Important** (address before proceeding): quality issues, pattern mismatches, naming problems, test gaps
- **Minor** (note for later): style nits, observations, future cleanup candidates

If a design excerpt was provided, also report Plan Adherence:
- **ADHERENT** — implementation matches the design
- **DEVIATION (fix)** — implementation diverges from design; recommend fixing
- **DEVIATION (accept)** — implementation diverges from design; recommend accepting the divergence with reasoning

When Evaluator Status is `not dispatched`, flag behavioral concerns by describing the code path and suspected gap. Do not write or run tests.
````
