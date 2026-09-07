---
description: Restack branches after a base moved
argument-hint: [branch|upstack|stack|repo]
---

Rebase one or more branches onto their (current) bases.

1. Parse `$ARGUMENTS`:
   - `branch` → restack only the current branch (`git-spice --no-prompt branch restack`).
   - `upstack` → restack current + everything above (`git-spice --no-prompt upstack restack`).
   - `stack` (default) → restack the whole stack (`git-spice --no-prompt stack restack`).
   - `repo` → restack every tracked branch in the repo (`git-spice --no-prompt repo restack`). Use when multiple stacks are affected (e.g., shared base updated).
2. Run the chosen command.
3. If the run completes cleanly, run `git-spice --no-prompt log long` so the user sees the result.
4. If it stops on a conflict, do NOT run `git rebase --continue` yourself. Instead:
   - List the conflicted files (`git status`).
   - Tell the user: resolve the conflicts, `git add` the resolutions, then run `/git-spice-continue` to resume.

Restacking is *re-entrant* — running it again after a successful restack is a no-op, so it's safe to suggest as a "make sure everything is clean" step.

## Pi execution safety

Execute only an explicit restack scope with `--no-prompt`. If configuration is missing, report it rather than enabling prompts.
