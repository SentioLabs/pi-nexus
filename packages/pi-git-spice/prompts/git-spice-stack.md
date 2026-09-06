---
description: Show the current stack (branches + commits, with current branch highlighted)
---

Run `git-spice --no-prompt log long` and present the output to the user verbatim — it's already formatted as a tree. Then add a one-line interpretation:

- If on trunk with no tracked branches: "No stack yet. Create the first branch with `/git-spice-new <name>` after staging changes."
- If on a tracked branch: state which branch is current and how many branches are above/below it.
- If a restack appears pending (git-spice may flag this): note that and suggest `/git-spice-restack`.

If `git-spice --no-prompt log long` errors with "not initialized", suggest running `/git-spice-init` first.

## Pi execution safety

Inspect with `git-spice --no-prompt log long`; report missing configuration rather than enabling prompts.
