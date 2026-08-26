---
description: Restack branches after a base moved
argument-hint: [branch|upstack|stack|repo]
---

# Restack branches

Use `$ARGUMENTS` to choose one explicit scope: `branch`, `upstack`, `stack` (the default), or `repo`. Execute one of `git-spice --no-prompt branch restack`, `git-spice --no-prompt upstack restack`, `git-spice --no-prompt stack restack`, or `git-spice --no-prompt repo restack`.

If configuration is missing or a conflict stops the command, report the blocker rather than enabling prompts. After resolving conflicts, use `/git-spice-continue`.
