---
name: arc-finish
description: You MUST use this skill at the end of any session, when the user says "land the plane", "wrap up", "done for the day", "finish up", "session complete", "push and close", or indicates work is complete. This is the arc-native session completion protocol that captures remaining work as arc issues, runs quality gates, updates arc issue statuses, commits, and pushes. Always prefer this over generic branch-finishing when the project uses arc issue tracking.
---

# Finish — Unified Session Completion

Complete the session: capture remaining work, pass quality gates, update arc, commit, push. One protocol for all contexts.

## Iron Law

**Work is NOT done until the selected VCS push succeeds. No exceptions.**

Local-only work is not complete. The remote is the source of truth.

## VCS Selection

Before any VCS operation, determine the VCS by running:

```bash
arc which --json | jq -r '.vcs'
```

If the result contains `"jj"`, you are in a jj repo — use jj commands shown below. Otherwise, use git commands. **In a colocated repo (`["git","jj"]`), you MUST use jj — never raw git mutations.** The jj column of `skills/arc/_vcs.md` is the source of truth for equivalent commands.

## Protocol

Create a checklist using the bundled `todo` tool (or `/todos`) with all steps and work through them:

### Phase 1: Capture Remaining Work

1. Review what was planned vs what was completed
2. For any unfinished work or newly discovered tasks:
   ```bash
   arc create "Remaining: <description>" --type=task
   ```
3. Add context notes to new issues so the next session can pick up:
   ```bash
   arc update <id> --description "CONTEXT: <what was done, what remains, any gotchas>"
   ```

### Phase 2: Quality Gates

*Skip this phase if no code was changed in this session.*

4. Run project test suite:
   ```bash
   make test    # or: go test ./..., npm test, etc.
   ```
5. Run linter/formatter if configured:
   ```bash
   make lint    # or: golangci-lint run, eslint, etc.
   ```
6. Run build if applicable:
   ```bash
   make build
   ```
7. **Hard gate**: If tests fail, fix them. Do NOT skip to commit. Invoke `debug` if needed.

### Phase 3: Update Arc Issues

8. Close completed issues:
    ```bash
    arc close <id> -r "Done: <summary of what was completed>"
    ```
9. Update in-progress issues with progress notes:
    ```bash
    arc update <id> --description "PROGRESS: <what's done>. NEXT: <what remains>"
    ```
10. Verify issue states match reality — don't leave stale statuses

### Phase 4: Commit and Push

11. Stage changed files (specific files, not `git add -A`):
    ```bash
    git add <file1> <file2> ...
    ```
    **jj:** No staging step needed — jj's working copy automatically snapshots all edited files. Changes are scoped by what you edited in the filesystem.
12. **Protected-branch check** — perform the check per `skills/arc/_branch-check.md`. This is the *last* place to catch trunk-direct work; ideally `brainstorm` or `build` already established a feature branch earlier, but check anyway because some flows skip those skills.
13. Commit with conventional commit message:
    ```bash
    git commit -m "feat(scope): summary of changes"
    ```
    **jj:** `jj commit -m "feat(scope): summary of changes"` (describes the current working-copy change `@` and opens a fresh empty change on top)
14. Push:
    ```bash
    git push
    ```
    **jj:** After `jj commit`, the completed change is `@-`. Move its feature bookmark with `jj bookmark move <feature-bookmark> --to @-`, then push it with `jj git push --bookmark <feature-bookmark>`. Do not use `jj git push -c @` here because `@` is the new empty working-copy change.
15. Verify push succeeded:
    ```bash
    git status    # Must show "up to date with origin"
    ```
    **jj:** Compare exact commit IDs and require equality: `LOCAL=$(jj log -r '<bm>' -T commit_id --no-graph); REMOTE=$(jj log -r '<bm>@origin' -T commit_id --no-graph); test "$LOCAL" = "$REMOTE"`. The remote must be in sync with the local bookmark.
16. If push fails → resolve the issue → retry → succeed. Do not leave unpushed commits.
17. Clean up worktrees / workspaces:
    ```bash
    git worktree list
    ```
    **jj:** `jj workspace list`

    If only the main working tree / workspace is listed, skip ahead. Otherwise, for each extra worktree/workspace:

    **a. Check for uncommitted work:**
    ```bash
    git -C <worktree-path> status
    git -C <worktree-path> stash list
    ```
    **jj:** `jj st` in the workspace context (or check `jj workspace list` and manually verify no pending changes in that workspace's bookmark)

    If there are uncommitted changes or stashes → do NOT remove. Create an arc issue to track the unmerged work:
    ```bash
    arc create "Recover unmerged worktree work: <branch>" --type=task
    ```

    **b. Check if the branch / bookmark was merged:**
    ```bash
    git branch --merged | grep <worktree-branch>
    ```
    **jj:** Use the forge to check if the PR is merged (safer than revsets because squash-merge rewrites commits):
    ```bash
    gh pr view <bookmark> --json state -q .state
    ```
    If the state is `MERGED` (or if the workspace is clean with no unique commits), safe to remove.

    For the git path, if merged:
    ```bash
    git worktree remove <worktree-path>
    git branch -d <worktree-branch>    # Delete the merged branch
    ```

    **jj:** If merged, remove the workspace and the bookmark:
    ```bash
    if command -v jw >/dev/null 2>&1; then
      jw remove <workspace-name> --force
    else
      jj workspace forget <workspace-name>
    fi
    jj bookmark delete <bookmark>
    ```

    **c. If the branch has unmerged commits but no uncommitted changes:**
    Check whether the commits exist on a remote:
    ```bash
    git log origin/<worktree-branch> 2>/dev/null
    ```
    **jj:** Check if the bookmark has been pushed:
    ```bash
    jj log -r '<bookmark>@origin' --no-graph >/dev/null 2>&1
    ```
    If pushed → safe to remove locally. If not pushed → do NOT remove; create an arc issue.

    **d. Prune stale worktree references:**
    ```bash
    git worktree prune
    ```
    **jj:** No direct equivalent; jj workspace references are managed automatically. Ensure all stale workspace data is cleaned via `jj workspace forget` as needed.

### Phase 5: Verify and Hand Off

18. Confirm the commit:
    ```bash
    git log -1    # Verify latest commit is visible
    ```
    **jj:** `jj log -r @- --no-graph` verifies the completed change immediately below the new empty working-copy change.
19. Output context for next session:
    ```bash
    arc prime
    ```

## Context-Aware Behavior

| Session Type | Behavior |
|-------------|----------|
| **Single-agent** | Full protocol above |
| **Parallel subagent patches** | Apply/review accepted patches → verify → close arc issues → commit → push |

## What's NOT in This Protocol

- `git stash clear`, `git remote prune origin` — housekeeping, not gates
- Worktree directory `.gitignore` verification — assumed to be configured at project setup
- Merge/PR/keep/discard choice — arc workflow always commits and pushes
- Performative session summaries — `arc prime` handles handoff context

## Rules

- Never skip Phase 2 (quality gates) when code has changed
- When Git is selected, never commit with `git add -A` — stage specific files
- Never leave completed work local-only; push it with the selected VCS
- Never close arc issues without completing the work
- Always run `arc prime` at the end for next-session context
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
