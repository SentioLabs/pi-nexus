---
description: Submit branches as Change Requests (defaults to the whole stack)
argument-hint: [branch|upstack|downstack|stack] [extra flags]
---

Submit the stack (or a slice of it) as PRs/MRs.

1. Confirm auth: `git-spice --no-prompt auth status`. If not logged in, stop and instruct the user to run `git-spice --no-prompt auth login` themselves (interactive). Don't proceed with an unauthenticated submit.
2. Parse `$ARGUMENTS`:
   - First word, if one of `branch`, `upstack`, `downstack`, `stack` → that's the scope.
   - No scope given → default to `stack`.
   - Remaining tokens are passed through as flags.
3. Run a dry run first if the user hasn't been here before this session: `git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>`. Show the user what would happen.
4. Then run the real submit: `git-spice --no-prompt <scope> submit --fill <draft-flag> <extra-flags>`. The `--fill` flag populates title/body from commit messages so the run is non-interactive.
5. After submit, summarize: which CRs were created vs updated, and the URLs (git-spice prints them).

Useful flags to surface to the user when relevant:
- `--draft` — open as drafts.
- `--update-only` — only update existing CRs, skip new ones.
- `--no-publish` — push branches without creating CRs.
- `--web` — open the resulting CRs in a browser.
- `--force` — force-push (only if non-forced was rejected for a known reason).

Submits are idempotent — re-running `/git-spice-submit` after fixing review feedback is the normal flow.

## Pi execution safety

Resolve `--draft` or `--no-draft` from arguments, then `spice.submit.draft`, then an available user-question tool or plain chat; stop if no value is available. Use the resolved flag for both `git-spice --no-prompt <scope> submit --dry-run --fill <draft-flag>` and `git-spice --no-prompt <scope> submit --fill <draft-flag> <extra-flags>`. Do not enable prompts for missing configuration.
