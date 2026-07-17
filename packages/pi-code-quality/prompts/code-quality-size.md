---
description: Run a PR or branch size review to decide whether the change should be split, stacked, cleaned up, or shipped as-is
argument-hint: "[scope]"
---

Use the `size-review` skill for this code quality size request.

If no scope is provided, review the current branch against its merge-base with trunk. Treat `$ARGUMENTS` as the requested scope when present; it may be a PR number, PR URL, branch name, or explicit branch/base scope.
