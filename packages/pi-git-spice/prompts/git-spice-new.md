---
description: Stack a new branch on top of the current branch from staged changes
argument-hint: <branch-name>
---

Create a new branch on top of the current one with `git-spice --no-prompt branch create <name> -m "<message>"`.

1. Parse `$ARGUMENTS` as the branch name. If empty, gather an explicit name through an available user-question tool or plain chat; stop if it remains unavailable.
2. Check `git status --porcelain`. Decide:
   - **Staged changes present** → run `git-spice --no-prompt branch create <name> -m "<message>"`. It commits the staged changes onto the new branch.
   - **Only unstaged changes** → ask the user: stage them all (`-a` flag) or stop so they can stage selectively? Don't decide silently.
   - **Working tree clean** → run `git-spice --no-prompt branch create <name> --no-commit` (creates an empty branch ready for work) and tell the user it's empty.
3. If the user wants the new branch *between* current and its upstack (insertion), pass `--insert`. If they want it *below* current, pass `--below`. Only do this if the user signals it explicitly.
4. After creating, run `git-spice --no-prompt log long` and show the new shape.

Don't run `git commit` directly — `git-spice --no-prompt branch create <name> -m "<message>"` handles the commit *and* records the base relationship. A raw commit would split the two steps and leave the stack metadata out of sync.

## Pi execution safety

Gather an explicit branch name and commit message through an available user-question tool or plain chat before a populated branch creation. Use `git-spice --no-prompt branch create <name> -m <message>` for populated changes; add `-a` only after explicit approval. On a clean tree, use `git-spice --no-prompt branch create <name> --no-commit`.
