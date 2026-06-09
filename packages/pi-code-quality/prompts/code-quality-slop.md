---
description: Run an AI slop/code-quality review on files, directories, PRs, current changes, or the full codebase
argument-hint: "[scope]"
---

# Slop Review

Use the `slop-review` skill against the specified target.

## Usage

- `/code-quality-slop` -- review current git diff (unstaged changes)
- `/code-quality-slop src/` -- review a directory
- `/code-quality-slop path/to/file.go` -- review specific files
- `/code-quality-slop PR` or `/code-quality-slop #123` -- review a pull request

## Instructions

Invoke the `slop-review` skill with the user's specified scope.
If no scope is provided, default to reviewing the current git diff.
Pass any arguments the user provided as the scope for the review.

Use `$ARGUMENTS` as the requested scope when present.
