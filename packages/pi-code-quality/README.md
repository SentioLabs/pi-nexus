# Pi Code Quality Package

> Monorepo location: this package lives at `packages/pi-code-quality` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-code-quality` and load it locally with `pi -e ./packages/pi-code-quality`.

Pi skills and prompts for AI slop and code quality review.

This package ports the Claude Code `code-quality` plugin's `slop-review` workflow to Pi.

## What is included

- `/skill:slop-review` — 4-lens slop review for AI authorship signals, idiom drift, code quality issues, and architecture/solution-fit problems.
- `/code-quality-slop [scope]` — prompt alias for reviewing current changes, files, directories, PRs, or broad codebase scopes.
- Language reference files for Go, Python, Rust, and Svelte/TypeScript.

## Execution behavior

The skill is portable. When the current Pi session exposes a parallel agent tool, the review can run Step 0 first and then run the applicable Phase 1 lenses in parallel. When no parallel tool is available, the same lenses run sequentially in the current agent context with separated findings.

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
```

If no scope is provided, `/code-quality-slop` defaults to the current git diff.

## Output behavior

- In interactive Pi sessions, the skill asks before posting to a PR when a PR is detected.
- If `ask_user_question` is available, the skill uses it for the output choice; otherwise it asks in chat.
- In CI or explicit non-interactive mode, the skill posts to the detected PR or writes `SLOP_REVIEW.md` when no PR is detected.

## Development

```bash
npm test --workspace @sentiolabs/pi-code-quality
npm run pack:dry-run --workspace @sentiolabs/pi-code-quality
pi -e ./packages/pi-code-quality
```
