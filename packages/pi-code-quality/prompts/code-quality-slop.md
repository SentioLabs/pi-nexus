---
description: Run an AI slop/code-quality review on files, directories, PRs, current changes, or the full codebase
argument-hint: "[scope]"
---

Use the `slop-review` skill for this code quality request.

If no scope is provided, default to reviewing the current git diff. Treat `$ARGUMENTS` as the requested scope when present.
