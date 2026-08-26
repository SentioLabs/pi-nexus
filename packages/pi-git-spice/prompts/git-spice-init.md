---
description: Initialize git-spice in the current repo (sets trunk + remote, checks auth)
argument-hint: [trunk-name | --trunk=<name> --remote=<name>]
---

Initialize git-spice for this repository.

1. Confirm you're inside a git repository: run `git rev-parse --show-toplevel`. If it fails, stop and tell the user this isn't a git repo.
2. Check whether git-spice is already initialized: `git-spice --no-prompt log long 2>&1`. If it succeeds and shows a trunk, tell the user it's already initialized and offer to re-init with `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset` only if they ask.
3. Resolve `$ARGUMENTS` to explicit `--trunk=<name> --remote=<name>` values. If either value is absent, gather it through an available user-question tool or plain chat; stop if it remains unavailable. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`.
4. After init, run `git-spice --no-prompt auth status` and report whether the user is logged in. If not, suggest `git-spice --no-prompt auth login` — do NOT run it yourself (it's an interactive browser flow).
5. Show the result of `git-spice --no-prompt log long` so the user sees the starting state.

## Pi execution safety

Do not run argumentless initialization in Pi. Gather an explicit trunk and remote through an available user-question tool, or through plain chat when that tool is unavailable; if either value is unavailable, stop. Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. For `--reset`, disclose that it forgets all git-spice tracking relationships while leaving Git branches, and obtain a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.
