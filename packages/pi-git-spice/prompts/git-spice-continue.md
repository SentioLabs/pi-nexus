---
description: Resume a git-spice operation after resolving rebase conflicts (or abort with --abort)
argument-hint: [--abort]
---

# Continue a git-spice rebase

Use `$ARGUMENTS` to select the path. Run `git status --porcelain` first and stop if unresolved paths remain. Do not stage resolutions without explicit approval.

- For an abort request, run `git-spice --no-prompt rebase abort` and report that the pre-rebase state was restored.
- Otherwise, once resolutions are staged, run `git-spice --no-prompt rebase continue --no-edit`.

If continuing reaches another conflict, report the files and wait. Interactive commit-message editing is terminal-only: stop and show the user `git-spice rebase continue` to run in their own terminal instead of opening an editor through Pi. When the operation finishes, run `git-spice log long` and report the result.
