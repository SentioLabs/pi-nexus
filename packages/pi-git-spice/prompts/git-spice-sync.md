---
description: Pull trunk and clean up branches whose CRs were merged
---

Sync with the remote: pull trunk, delete merged branches, restack survivors.

1. Run `git status --porcelain`. If the working tree is dirty, stop and tell the user to commit/stash first — `repo sync` will rebase tracked branches and a dirty tree will block it.
2. `git-spice --no-prompt auth status`. If not logged in, sync still works locally but won't query CR merge status accurately; warn the user.
3. Run `git-spice --no-prompt repo sync --restack`. Show the output verbatim — it lists which branches it deleted and which it kept. (`--restack` matters: without it, branches above a deleted branch are only retargeted to trunk, not rebased, and the stack is left flagged as needing restack.)
4. After it completes, run `git-spice --no-prompt log long` so the user sees the new shape (the bottom of any open stack now sits on the updated trunk).

If `repo sync` fails partway through (typically a restack conflict), instruct the user to resolve the conflicts and run `/git-spice-continue`.

## Pi execution safety

Execute `git-spice --no-prompt repo sync --restack`; report missing configuration rather than enabling prompts.
