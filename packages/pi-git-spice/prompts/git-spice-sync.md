---
description: Pull trunk and clean up branches whose CRs were merged
---

# Sync after merged Change Requests

Check `git status --porcelain` first; stop on a dirty tree. Check `git-spice auth status` and report missing authentication rather than enabling prompts. Then run `git-spice --no-prompt repo sync --restack` and show `git-spice log long`.

If sync stops on a conflict, report the blocker, let the user resolve it, and direct them to `/git-spice-continue`. Never retry a mutation by enabling CLI prompts.
