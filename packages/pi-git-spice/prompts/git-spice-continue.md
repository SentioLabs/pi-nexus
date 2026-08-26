---
description: Resume a git-spice operation after resolving rebase conflicts (or abort with --abort)
argument-hint: [--abort]
---

Resume — or abort — a git-spice operation that was paused on a rebase conflict.

1. Parse `$ARGUMENTS`. If it contains `--abort` or the user clearly wants to bail, run `git-spice --no-prompt rebase abort` and tell them the pre-rebase state has been restored.
2. Otherwise (continue path):
   - Run `git status --porcelain`. If there are unmerged paths (lines starting with `UU`, `AA`, `DU`, `UD`, etc.), stop and list them — the user hasn't finished resolving. Don't continue while files are still conflicted.
   - If there are resolved files that aren't staged, ask the user whether to `git add` them. Don't auto-stage silently.
   - Once the index is clean of conflict markers and resolutions are staged, run `git-spice --no-prompt rebase continue --no-edit`.
3. If continuing succeeds and the multi-step operation finishes, run `git-spice --no-prompt log long` to show the result.
4. If continuing hits *another* conflict (common in multi-branch restacks), repeat: report the new conflicted files and wait for the user.

Why `git-spice --no-prompt rebase continue --no-edit` and not `git rebase --continue`? git-spice's wrapper resumes the *outer* operation (e.g., a stack restack across N branches). Plain `git rebase --continue` only finishes the current branch's rebase and leaves git-spice's queue stalled.

## Pi execution safety

For unattended continuation, use `git-spice --no-prompt rebase continue --no-edit`. Interactive commit-message editing is terminal-only; do not open an editor through Pi.
