# `@sentiolabs/pi-git-spice`

## Included resources

- Seven `/git-spice-*` prompt templates: `/git-spice-continue`, `/git-spice-init`, `/git-spice-new`, `/git-spice-restack`, `/git-spice-stack`, `/git-spice-submit`, and `/git-spice-sync`.
- `/skill:git-spice` and `/skill:stacking-workflow`.
- Optional `git-spice.stacker` and `git-spice.stack-doctor` package agents when `pi-subagents` is installed.

## Prerequisites

The external `git-spice` CLI must be installed. `pi-subagents` is optional and is not bundled.

## Non-interactive safety

Tool-driven mutations use explicit arguments and `--no-prompt`; rebase continuation also uses `--no-edit`. Init, branch creation, submit draft state, and destructive reset gather or confirm missing intent through Pi before executing.

## Local development

```bash
npm test --workspace @sentiolabs/pi-git-spice
npm run pack:dry-run --workspace @sentiolabs/pi-git-spice
pi -e ./packages/pi-git-spice
```
