# @sentiolabs/pi-git-spice

Pi skills, prompt templates, and optional subagents for [git-spice](https://abhinav.github.io/git-spice/) stacked-branch workflows.

## What is included

- Prompts: `/git-spice-continue`, `/git-spice-init`, `/git-spice-new`, `/git-spice-restack`, `/git-spice-stack`, `/git-spice-submit`, and `/git-spice-sync`.
- Skills: `/skill:git-spice` and `/skill:stacking-workflow`.
- Optional package-scoped agents: `git-spice.stacker` and `git-spice.stack-doctor`.

## Prerequisites

`git-spice` is an external CLI prerequisite. Install and configure it for the repository before using these workflows. This package does not bundle the CLI.

## Install from npmjs.org

```bash
pi install npm:@sentiolabs/pi-git-spice
```

## Install locally

```bash
pi -e ./packages/pi-git-spice
```

## Usage

Use the prompts for daily stack operations and load the skills for CLI reference or planning a reviewable stack. The generated workflows gather missing values through an available question tool or plain chat and never enable interactive `git-spice` CLI prompts in a Pi tool subprocess.

## Optional Pi subagents

`pi-subagents` is optional. When installed, it can discover `git-spice.stacker` and `git-spice.stack-doctor` through this package's metadata. Without it, the prompts and skills retain documented direct workflows.

## Non-interactive safety

Tool-driven git-spice mutations use `--no-prompt`. Branch creation requires an explicit name and commit message, or `--no-commit` for a clean tree. Rebase continuation uses `--no-edit`; destructive initialization reset requires a separately confirmed action.

## Development

```bash
npm test --workspace @sentiolabs/pi-git-spice
npm run pack:dry-run --workspace @sentiolabs/pi-git-spice
```

## Maintainer source sync

Generated prompts, skills, and agents are derived from the upstream Claude plugin. Do not hand-edit them; encode adaptations in the migration script and regenerate:

```bash
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py ~/path/to/claude-marketplace/plugins/git-spice
```
