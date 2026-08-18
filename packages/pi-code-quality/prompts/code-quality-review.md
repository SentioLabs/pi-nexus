---
description: Run a deep code review on files, directories, PRs, or the full codebase — correctness, security, best practices, idiom, and architecture/solution-fit, plus an advisory AI-slop assessment and driver-curation verdict
argument-hint: "[scope]"
---

# Deep Review

Use the `deep-review` skill against the specified target.

## Usage

- `/code-quality-review` -- review all changes vs the base branch (default):
  branch commits plus staged and unstaged edits; untracked files are excluded
- `/code-quality-review src/` -- review a directory
- `/code-quality-review path/to/file.go` -- review specific files
- `/code-quality-review PR` or `/code-quality-review #123` -- review a pull request

## Instructions

Invoke the `deep-review` skill with the user's specified scope. If no scope is
given, default to reviewing everything that differs from the base branch —
`git diff $(git merge-base origin/<default-branch> HEAD)` — which covers commits
on the current branch plus staged and unstaged edits, while excluding untracked
files (the review covers what will ship, not scratch files). On the default
branch itself, use `git diff HEAD` instead. Pass any arguments the user provided
as the scope for the review.

Use `$ARGUMENTS` as the requested scope when present.
