---
description: Initialize git-spice in the current repo (sets trunk + remote, checks auth)
argument-hint: [trunk-name | --trunk=<name> --remote=<name>]
---

# Initialize git-spice

Use `$ARGUMENTS` when it provides a trunk or explicit `--trunk=<name> --remote=<name>` values. First confirm this is a repository with `git rev-parse --show-toplevel`.

Do not run an argumentless initialization command in a Pi tool. Gather an explicit trunk and remote through an available user-question tool, or through plain chat when that tool is unavailable. If either value cannot be obtained, stop and show the manual terminal command.

Run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. Then run `git-spice auth status` and `git-spice log long`; never run interactive `auth login` yourself.

For `--reset`, explain that branches remain but all git-spice tracking relationships are forgotten. Require a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.
