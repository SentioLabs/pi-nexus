---
description: Stack a new branch on top of the current branch from staged changes
argument-hint: <branch-name>
---

# Create a stacked branch

Use `$ARGUMENTS` as the branch name. If it is missing, gather an explicit name through an available user-question tool or plain chat; stop if it cannot be obtained.

For staged or explicitly approved auto-staged changes, gather an explicit commit message and run `git-spice --no-prompt branch create <name> -m <message>`. Add `-a` only after explicit approval for unstaged tracked changes. Do not invoke a commit editor through Pi.

For a clean working tree, run `git-spice --no-prompt branch create <name> --no-commit`. Honor explicit `--insert` or `--below` only after collecting the branch name and, when committing, the message. Finish with `git-spice log long`.
