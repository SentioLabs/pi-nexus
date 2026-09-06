# VCS Detection and git→jj Operation Map

Shared reference for arc workflow skills (brainstorm, build, finish, the builder agents). When a skill says "consult `skills/arc/_vcs.md`", do exactly what's here.

This file exists because arc must prefer jj (Jujutsu) over git when a repo uses jj, including colocated `.jj`+`.git` repos where running raw `git` mutations is unsafe — jj keeps git in sync from its own snapshot, and raw git mutations can desync the two and fight jj's working-copy snapshot.

## Detecting the VCS

The detection contract is enforced in every skill that handles version control:

```bash
arc which --json | jq -r '.vcs'        # ["git","jj"] | ["git"] | ["jj"] | []
```

The `.vcs` field returns an array of VCS identifiers the repo uses. Apply this rule:

**If the `vcs` array contains `"jj"` → use jj; else if it contains `"git"` → use git; else neither.**

This rule ensures that jj is "higher preference than git" and correctly handles the colocated `["git","jj"]` case — when both are present, jj takes precedence because it's the ground truth for that repo.

For older `arc` versions that lack the `.vcs` field or when `arc which` errors, use this inline fallback:

```bash
# Fallback when `arc which --json` has no .vcs field or errors:
if jj root >/dev/null 2>&1; then echo jj
elif git rev-parse --show-toplevel >/dev/null 2>&1; then echo git
else echo none; fi
```

Note: arc-project context is presupposed whenever these skills run, so `arc which` itself failing to resolve a project is not a concern in practice.

## git → jj operation map

| arc operation | git | jj |
|---|---|---|
| Stage specific files | `git add <files>` | *(no-op — jj's working copy auto-snapshots; scope the change by what you edit, there is no index)* |
| Commit a task's work | `git commit -m "msg"` | `jj commit -m "msg"` (describes `@` and opens a fresh empty change on top) |
| Current branch / context | `git branch --show-current` | `jj log -r @ -T bookmarks --no-graph` (jj has a working-copy change, not a checked-out branch) |
| Start feature work | `git checkout -b feat/x` | `jj new <trunk>` then, when ready to name it, `jj bookmark create feat/x -r @` |
| Push completed work | `git push` | after `jj commit`, run `jj bookmark move feat/x --to @-`, then `jj git push --bookmark feat/x` |
| Status | `git status` | `jj st` |
| "Up to date with origin" gate | `git status` reports up-to-date | compare `jj log -r feat/x -T commit_id --no-graph` with `jj log -r feat/x@origin -T commit_id --no-graph`; IDs must match |
| List worktrees / workspaces | `git worktree list` | `jj workspace list` |
| Add isolated workspace | `git worktree add <path> -b <b>` | hybrid: `path=$(jw switch --print-path <name>)` if `command -v jw` succeeds, else `jj workspace add --name <name> <path>` |
| Remove isolated workspace | `git worktree remove <path>` | hybrid: `jw remove <name> --force` if `command -v jw`, else `jj workspace forget <name>` |
| Is a branch merged? (cleanup) | `git branch --merged \| grep <b>` | forge status `gh pr view <bm> --json state` (squash-merge-safe); revset `jj log -r 'bookmarks(feat/x) & ::trunk()'` only as a fallback when no PR exists |
| Delete a merged branch | `git branch -d feat/x` | `jj bookmark delete feat/x` |

## jj caveats (read before using the jj column)

- There is no staging index — `git add` has no jj equivalent; the working copy is auto-snapshotted into the change `@`.
- `@` (the working-copy commit) *is* a commit; "uncommitted work" is already a change. `jj commit` finalizes it as `@-` and starts a new empty `@`. Move the feature bookmark to `@-` before pushing; do not auto-create a push bookmark on the new empty `@`.
- In a **colocated** repo (`["git","jj"]`), never run raw `git add`/`git commit`/`git checkout` — jj keeps git in sync from its own snapshot, and raw git mutations desync the two. Always use the jj column.
- Merged-state detection must use the forge (`gh pr view`), not a revset, because squash-merge rewrites commits so content-matching gives false negatives.
