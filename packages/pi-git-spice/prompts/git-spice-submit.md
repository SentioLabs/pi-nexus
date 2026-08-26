---
description: Submit branches as Change Requests (defaults to the whole stack)
argument-hint: [branch|upstack|downstack|stack] [extra flags]
---

# Submit a stack

Parse `$ARGUMENTS` for `branch`, `upstack`, `downstack`, or `stack` (the default), plus explicit extra flags. Confirm authentication with `git-spice auth status`; do not launch interactive login.

Resolve `--draft` or `--no-draft` before creating a Change Request: honor an explicit argument, otherwise read `spice.submit.draft`, then ask through an available user-question tool or plain chat. If no value can be obtained, stop. Use the resolved draft flag in both `git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>` and `git-spice --no-prompt <scope> submit --fill <draft-flag> <extra-flags>`.

If `--update-only` proves that no new Change Request can be created, existing draft state may remain unchanged. Report missing configuration instead of enabling prompts.
