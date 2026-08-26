# `@sentiolabs/pi-code-quality`

`@sentiolabs/pi-code-quality` provides Pi-native skills and prompts for comprehensive multi-lens code review and PR/branch size analysis.

## Included resources

- Skill: `/skill:deep-review`
- Prompt alias: `/code-quality-review [scope]`
- Skill: `/skill:size-review`
- Prompt alias: `/code-quality-size [scope]`
- References: Go, Python, Rust, Svelte/TypeScript, deep-review output actions, and default size-review exclusions

## Five-lens grading

`deep-review` covers five concerns: correctness and quality, security, idiom and best practices, architecture and solution fit, and advisory AI-slop and driver-curation evidence. Correctness and quality, security, idiom and best practices, and architecture and solution fit determine the review grade. AI-authorship and driver-curation signals are advisory and never raise, lower, or cap the grade.

By default, `/code-quality-review` reviews all changes that differ from the branch merge-base, including staged and unstaged edits while excluding untracked scratch files. The only acceptance filename is `.code-quality/review-acceptances.md`.

## Size-review shape analysis

`size-review` evaluates raw versus post-exclusion size, cumulative versus slice shape for stacked branches, mixed intent, every standard seam category, split effort, reviewer cost, and a concrete stack plan. Its full analysis starts above 10 files, 400 authored additions, 15 commits, three top-level directories, or whenever behavior is mixed with refactor/mechanical churn.

## Portability

The package does not require Arc or any optional subagent package. When a Pi session exposes a generic parallel task/subagent tool, `deep-review` can run its independent lenses in parallel. Otherwise it runs the same lens prompts sequentially with separated findings. Model-tier requests are advisory and used only when the available tool supports model selection.

## Usage

```text
/code-quality-review
/code-quality-review src/
/code-quality-review path/to/file.go
/code-quality-review #123
/skill:deep-review

/code-quality-size
/code-quality-size #123
/code-quality-size feature/my-branch
/skill:size-review
```

## Rename

The review workflow is now named `deep-review`, and its prompt is `/code-quality-review`. The initial slop-named skill and prompt were removed rather than retained as aliases. Projects that use accepted-deviation policy should use `.code-quality/review-acceptances.md`.

## Local development

From the monorepo root:

```bash
npm test --workspace @sentiolabs/pi-code-quality
npm run pack:dry-run --workspace @sentiolabs/pi-code-quality
pi -e ./packages/pi-code-quality
```
