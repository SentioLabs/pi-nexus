# Pi Code Quality Package

> Monorepo location: this package lives at `packages/pi-code-quality` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-code-quality` and load it locally with `pi -e ./packages/pi-code-quality`.

Pi-native skills and prompts for comprehensive multi-lens code review and PR/branch size analysis.

## What is included

- `/skill:deep-review` — five-lens review for correctness and quality, security, idiom and best practices, architecture and solution fit, plus advisory AI-slop and driver-curation evidence.
- `/code-quality-review [scope]` — prompt alias for reviewing all changes versus the base branch by default, or explicit files, directories, branches, and pull requests.
- `/skill:size-review` — PR/branch size review that decides whether a change should be split, stacked, cleaned up, or shipped as-is.
- `/code-quality-size [scope]` — prompt alias for reviewing a current branch, pull request, or named branch for reviewability and stack seams.
- Deep-review language references for Go, Python, Rust, and Svelte/TypeScript, plus output-delivery guidance.
- Size-review default exclusions for generated files, lockfiles, vendored output, and common machine-generated artifacts.

## Deep review workflow

`deep-review` separates five concerns: correctness and quality, security, idiom and best practices, architecture and solution fit, and AI-slop/driver-curation evidence. The first four determine the review grade. AI-authorship and curation signals are advisory and never raise, lower, or cap the grade.

With no explicit scope, `/code-quality-review` reviews everything that differs from the branch merge-base, including staged and unstaged edits while excluding untracked scratch files.

## Size review workflow

`size-review` evaluates how a change is packaged for human review: raw versus post-exclusion size, cumulative versus slice shape for stacked branches, mixed intent, every standard seam category, split effort, reviewer cost, and a concrete stack plan. Its full analysis starts above 10 files, 400 authored additions, 15 commits, three top-level directories, or whenever behavior is mixed with refactor/mechanical churn.

## Rename from the initial Pi package

The review workflow is now named `deep-review`, and its prompt is `/code-quality-review`. The initial slop-named skill and prompt were removed rather than retained as aliases. Projects that use accepted-deviation policy should use `.code-quality/review-acceptances.md`.

## Portable execution

The package does not require Arc or any optional subagent package. When a Pi session exposes a generic parallel task/subagent tool, `deep-review` can run its independent lenses in parallel. Otherwise it runs the same lens prompts sequentially with separated findings. Model-tier requests are advisory and used only when the available tool supports model selection.

## Install from npmjs.org

```bash
pi install npm:@sentiolabs/pi-code-quality
```

## Install locally

From this monorepo:

```bash
pi -e ./packages/pi-code-quality
```

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

## Development

```bash
npm test --workspace @sentiolabs/pi-code-quality
npm run pack:dry-run --workspace @sentiolabs/pi-code-quality
pi -e ./packages/pi-code-quality
```

### Maintainer source sync

Source checkouts of the `pi-nexus` monorepo include a repo-local maintainer skill at `.pi/skills/code-quality-source-sync/SKILL.md`. The skill and `scripts/migrate-code-quality-plugin.py` synchronize runtime resources from the Claude code-quality plugin while preserving Pi-specific behavior; neither is shipped as package runtime tooling.

```text
/skill:code-quality-source-sync ~/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/code-quality
```

```bash
# From the pi-nexus repository root:
python3 packages/pi-code-quality/scripts/migrate-code-quality-plugin.py ~/path/to/claude-marketplace/plugins/code-quality
```
