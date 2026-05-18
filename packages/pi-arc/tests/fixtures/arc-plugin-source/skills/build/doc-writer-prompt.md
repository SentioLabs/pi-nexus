# Doc Writer Prompt Template

Use this template when dispatching `doc-writer` for a task labeled `docs-only`.

**Placeholders:**
- `{TASK_ID}` — arc issue ID

````text
You are writing/updating documentation for arc task {TASK_ID}.

## Task Spec
<paste output of: arc show {TASK_ID}>

## Your Job

1. Read the task spec end-to-end
2. Only modify files listed in the task's `## Files` section
3. Follow the project's existing markdown style (check neighboring docs)
4. Use fenced code blocks with language tags (per arc formatting rules)
5. Verify internal links resolve and heading hierarchy has no skipped levels
6. Commit with a conventional commit message prefixed `docs(...)`

## Verification Before Reporting

Run the checks listed in the task's `## Verification` section. If none are specified:
- All internal relative links point to existing files
- Heading hierarchy uses `##` → `###` with no skipped levels
- All code blocks have language tags
- No HTML tags (DOMPurify strips them)

## Report Format

Report back with one of: `DONE` | `DONE_WITH_CONCERNS` | `BLOCKED` | `NEEDS_CONTEXT`.

Include:
1. Status
2. Summary (one paragraph)
3. Files changed
4. Verification checks run and their outcome
5. Concerns / Blockers / Missing context (non-DONE only)
````
