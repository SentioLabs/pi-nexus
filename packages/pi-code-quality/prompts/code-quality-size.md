---
description: Run a PR/branch size review to decide if the change should be split into multiple PRs
argument-hint: "[scope]"
---

# Size Review

Use the `size-review` skill against the specified target.

## Usage

- `/code-quality-size` -- review the current branch against its base
- `/code-quality-size PR` or `/code-quality-size #123` -- review a pull request
- `/code-quality-size <branch-name>` -- review a specific local branch

## Instructions

Invoke the `size-review` skill with the user's specified scope. If no scope
is given, default to the current branch against its merge-base with the
trunk (`origin/main` or whatever the project's trunk is). Pass any arguments
the user provided as the scope for the review.

Use `$ARGUMENTS` as the requested scope when present.
