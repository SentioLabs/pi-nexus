# Pi Code Quality Package

> Monorepo location: this package lives at `packages/pi-code-quality` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-code-quality` and load it locally with `pi -e ./packages/pi-code-quality`.

Pi skills and prompts for AI slop review, PR/branch size review, and code reviewability analysis.

This package ports the Claude Code `code-quality` plugin's `slop-review` and `size-review` workflows to Pi.

## What is included

- `/skill:slop-review` — 4-lens slop review for AI authorship signals, idiom drift, code quality issues, and architecture/solution-fit problems.
- `/code-quality-slop [scope]` — prompt alias for reviewing current changes, files, directories, PRs, or broad codebase scopes.
- `/skill:size-review` — PR/branch size review that decides whether a change should be split, stacked, cleaned up, or shipped as-is.
- `/code-quality-size [scope]` — prompt alias for reviewing the current branch, a PR, or a named branch for reviewability and stack seams.
- Slop-review language references for Go, Python, Rust, and Svelte/TypeScript.
- Size-review default exclusions for generated files, lockfiles, vendored output, and common machine-generated artifacts.

## Workflow distinction

`slop-review` evaluates what the code does and whether the implementation quality or solution fit is suspect. `size-review` evaluates how the change is packaged for human review: raw vs post-exclusion size, stacked branch shape, viable seams, split effort, and concrete stack plans.

## Portable execution

The `slop-review` skill is portable. When the current Pi session exposes a parallel agent tool, the review can run Step 0 first and then run the applicable Phase 1 lenses in parallel. When no parallel tool is available, the same lenses run sequentially in the current agent context with separated findings.

Parallelism is opportunistic; the review methodology, calibration, scoring, and output format are the contract.

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
/code-quality-slop
/code-quality-slop src/
/code-quality-slop path/to/file.go
/code-quality-slop #123
/skill:slop-review

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
