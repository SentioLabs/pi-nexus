---
name: git-spice
description: >
  Reference for the git-spice CLI — stacked-branch workflows, command map, and recovery from interrupted rebases. This skill should be used whenever the user mentions git-spice, `gs`, stacked PRs, stacked diffs, branch stacks, dependent branches, PRs that depend on each other, or says things like "stack this", "check the stack", "submit the stack", "submit my stacked PRs", "restack", "rebase failed", "sync after merge", "what's on top of <branch>", "branch above/below". Also load when a multi-step plan would naturally produce a chain of dependent branches and you need to drive that with the CLI, or when an interrupted rebase needs recovery.
license: MIT
---

# git-spice

git-spice is a CLI for managing **stacks of dependent Git branches**. Each branch (except the trunk) has a recorded *base* — the branch it was created from. git-spice tracks those relationships, restacks (rebases) dependents automatically when a base changes, and submits the whole chain as separate-but-linked Change Requests (CRs — PRs on GitHub, MRs on GitLab).

Use this skill whenever you need to translate user intent ("stack this", "submit the stack", "rebase everything", "what's on top of feat-1?") into the right CLI invocations.

## Binary name

The official shorthand is `gs`, but on many systems `gs` is **Ghostscript**. **Always invoke `git-spice` directly** in scripts, commands, and tool calls — never assume `gs` is git-spice. (If a user types `gs` in chat, mentally map it to `git-spice`.)

The subcommand abbreviations shown in parentheses below — `r i`, `b c`, `ls`, `ll`, `bc`, etc. — work natively under `git-spice` itself (e.g. `git-spice --no-prompt ls` runs `log short`). They're not a `gs`-only thing. Use the full forms in scripts you check in; abbreviations are fine for one-off commands.

## Mental model

```
        ┌── feat-c       ← upstack of feat-b
      ┌─┴ feat-b         ← upstack of feat-a, downstack of feat-c
    ┌─┴ feat-a           ← stacked on trunk
    main (trunk)
```

- **trunk** — the repo's default branch (usually `main`/`master`). The only branch without a base.
- **base** — the branch a given branch was created from. Stored as metadata by git-spice.
- **upstack** — every branch transitively above this one.
- **downstack** — every branch between this one and trunk (exclusive of trunk).
- **restack** — rebase a branch (or set of branches) onto its current base. Run after the base moves.

git-spice operations are *local-first*. Auth is only needed for `submit`/`sync` (network operations).

## Command map

Sorted by intent, not alphabet — find the verb you mean, copy the command. Long forms shown; both built-in shorthands and one-letter aliases are listed.

> **Interactive prompts**: several commands open an interactive prompt when arguments are omitted (`branch checkout` with no name, `branch delete` with no name, `repo init` without `--trunk`, `commit pick` with no ref) or are inherently interactive (`stack edit`, `downstack edit`, `branch edit`, `commit split`, `branch split` without flags). In non-interactive runs — scripts, tool calls, subagents — always pass explicit arguments, and add the global `--no-prompt` flag to fail fast instead of hanging on a prompt. Leave the inherently-interactive commands to the user.

### Setup

| Intent | Command |
|---|---|
| Initialize git-spice in this repo | `git-spice --no-prompt repo init --trunk=<name> --remote=<name>` (`git-spice --no-prompt r i --trunk=<name> --remote=<name>`) |
| Re-init / change trunk or remote | `git-spice --no-prompt repo init --trunk=<b> --remote=<r>` |
| Reset all tracking, keep branches | `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset` |
| Log in to GitHub/GitLab/Bitbucket | `git-spice --no-prompt auth login` |
| Check who you're logged in as | `git-spice --no-prompt auth status` |
| Log out | `git-spice --no-prompt auth logout` |

Supported forges: **GitHub, GitLab, Bitbucket** only (self-hosted instances work via `spice.forge.<forge>.url`/`apiURL`). Forgejo/Codeberg/Gitea are **not** supported — don't point the GitHub forge config at them; their APIs aren't compatible. (Upstream feature request: abhinav/git-spice#1050.)

### Inspect

| Intent | Command |
|---|---|
| Show the current stack | `git-spice --no-prompt log short` (`git-spice --no-prompt ls`) |
| Show stack with commit details | `git-spice --no-prompt log long` (`git-spice --no-prompt ll`) |
| Show **all** tracked branches, not just the current stack | `git-spice --no-prompt log long --all` (`git-spice --no-prompt ll -a`) |
| Machine-readable stack state (for scripts/agents) | `git-spice --no-prompt log long --json` |
| Diff this branch vs its base | `git-spice --no-prompt branch diff` (`git-spice --no-prompt bdi`) |

`log` commands only show the current branch's stack by default — when hunting for branches that "disappeared", always check with `--all` before concluding they're untracked.

### Create / extend a stack

| Intent | Command |
|---|---|
| Stack a new branch on top of HEAD with staged changes | `git-spice --no-prompt branch create <name> -m "<message>"` (`git-spice --no-prompt bc <name> -m "<message>"`) |
| Same, auto-naming the branch from the commit message | `git-spice --no-prompt branch create -m "subject"` (name is optional) |
| Same, but auto-stage tracked-but-modified files (like `git commit -a`) | `git-spice --no-prompt branch create <name> -a -m "<message>"` |
| Same, with an explicit commit message | `git-spice --no-prompt branch create <name> -m "subject"` |
| Create branch without committing | `git-spice --no-prompt branch create <name> --no-commit` |
| Insert a branch *between* current and its upstack | `git-spice --no-prompt branch create <name> --insert -m "<message>"` |
| Create branch *below* current (push current upstack) | `git-spice --no-prompt branch create <name> --below -m "<message>"` |
| Track an existing git branch | `git-spice --no-prompt branch track` (`git-spice --no-prompt btr`) |
| Track every untracked branch below current | `git-spice --no-prompt downstack track` (`git-spice --no-prompt dstr`) |

### Commit on the current branch (auto-restacks upstack)

| Intent | Command |
|---|---|
| Commit staged changes here | `git-spice --no-prompt commit create` (`git-spice --no-prompt cc`) |
| Amend the tip commit | `git-spice --no-prompt commit amend` (`git-spice --no-prompt ca`) |
| Split a commit interactively | `git-spice --no-prompt commit split` (`git-spice --no-prompt csp`) |
| Apply staged changes as fixup to commit X | `git-spice --no-prompt commit fixup <ref>` (`git-spice --no-prompt cf`) |
| Cherry-pick a commit onto this branch | `git-spice --no-prompt commit pick <ref>` (`git-spice --no-prompt cp`) |

> Prefer the concrete git-spice commit commands listed above over raw `git commit` while inside a stack. The git-spice variants restack everything above the current branch automatically; `git commit` leaves upstack branches misaligned and you'll have to run `git-spice --no-prompt upstack restack` yourself.

### Navigate

| Intent | Command |
|---|---|
| Up one branch (prompts on fork) | `git-spice --no-prompt up` |
| Down one branch | `git-spice --no-prompt down` |
| Top of stack | `git-spice --no-prompt top` |
| Bottom of stack | `git-spice --no-prompt bottom` |
| Trunk | `git-spice --no-prompt trunk` |
| Check out a branch by name (prompts if omitted) | `git-spice --no-prompt branch checkout [name]` (`git-spice --no-prompt bco`) |

### Reshape

| Intent | Command |
|---|---|
| Restack just this branch onto its base | `git-spice --no-prompt branch restack` (`git-spice --no-prompt br`) |
| Restack this branch + everything above | `git-spice --no-prompt upstack restack` (`git-spice --no-prompt usr`) |
| Restack this branch + everything below | `git-spice --no-prompt downstack restack` (`git-spice --no-prompt dsr`) |
| Restack the whole stack | `git-spice --no-prompt stack restack` (`git-spice --no-prompt sr`) |
| Restack every tracked branch in the repo | `git-spice --no-prompt repo restack` (`git-spice --no-prompt rr`) |
| Squash this branch's commits into one | `git-spice --no-prompt branch squash` (`git-spice --no-prompt bsq`) |
| Split this branch at chosen commits | `git-spice --no-prompt branch split` (`git-spice --no-prompt bsp`) |
| Interactively edit/reorder this branch's commits | `git-spice --no-prompt branch edit` (`git-spice --no-prompt be`) — interactive; restacks upstack after |
| Fold (merge) this branch into its base | `git-spice --no-prompt branch fold` (`git-spice --no-prompt bfo`) |
| Move this branch onto a new base, leave upstack alone | `git-spice --no-prompt branch onto <base>` (`git-spice --no-prompt bon`) |
| Move this branch + upstack onto a new base | `git-spice --no-prompt upstack onto <base>` (`git-spice --no-prompt uso`) |
| Reorder branches in the stack | `git-spice --no-prompt stack edit` (`git-spice --no-prompt se`) — interactive |
| Reorder branches below the current one | `git-spice --no-prompt downstack edit` (`git-spice --no-prompt dse`) — interactive |
| Rename | `git-spice --no-prompt branch rename <new>` (`git-spice --no-prompt brn`) |
| Delete branch (retargets upstack; add `--restack` to also rebase it) | `git-spice --no-prompt branch delete <name>` (`git-spice --no-prompt bd`) |
| Delete every branch in the current stack | `git-spice --no-prompt stack delete` (`git-spice --no-prompt sd`) |
| Delete everything above the current branch | `git-spice --no-prompt upstack delete` (`git-spice --no-prompt usd`) |
| Untrack only (keep the git branch) | `git-spice --no-prompt branch untrack <name>` (`git-spice --no-prompt buntr`) |

### Submit (push + open/update PRs)

All submit commands are **idempotent**: re-running on an existing stack updates PRs in place.

| Intent | Command |
|---|---|
| Submit just this branch | `git-spice --no-prompt branch submit <draft-flag>` (`git-spice --no-prompt bs <draft-flag>`) |
| Submit this branch and below | `git-spice --no-prompt downstack submit <draft-flag>` (`git-spice --no-prompt dss <draft-flag>`) |
| Submit this branch and above | `git-spice --no-prompt upstack submit <draft-flag>` (`git-spice --no-prompt uss <draft-flag>`) |
| Submit the whole stack | `git-spice --no-prompt stack submit <draft-flag>` (`git-spice --no-prompt ss <draft-flag>`) |

Common flags on submit:
- `--fill` / `-c` — populate title + body from commit messages (skip the prompt). Use this for non-interactive runs.
- `--dry-run` / `-n` — preview what would be submitted.
- `--draft` / `--no-draft` — set draft state.
- `--update-only` — only update branches that already have CRs; skip new ones.
- `--no-publish` — push branches without opening CRs.
- `--web` / `-w` — open the resulting CRs in a browser.
- `--nav-comment=false|true|multiple` — control the auto-generated stack-navigation comment.
- `-l/--label`, `-r/--reviewer`, `--assign` — set CR metadata (comma-separated or repeated).
- `--no-verify` — skip pre-push hooks.
- `--force` — escalate from the default `--force-with-lease` to a hard force-push. Use only when the lease check is rejecting a push you've confirmed is safe. The default already handles the normal force-push case.

### Sync with remote

| Intent | Command |
|---|---|
| Pull trunk + delete merged branches | `git-spice --no-prompt repo sync --restack` (`git-spice --no-prompt rs --restack`) |
| Same, and also rebase the survivors | `git-spice --no-prompt repo sync --restack` |

`repo sync` is the canonical "after my PR merged, clean up" command. It pulls trunk, finds branches whose CRs were merged, and deletes them. Branches that sat on top of a deleted branch are **retargeted** to trunk but **not rebased** — they'll show as needing restack. Pass `--restack` to rebase them in the same run (`--restack=aboves` limits it to direct upstacks of deleted branches), or set `spice.repoSync.restack=upstack` to make it the default. Prefer `--restack` unless there's a reason to defer the rebase.

### Recover from an interrupted rebase

git-spice rebases run `git rebase` under the hood. Conflicts pause the operation. **Resolve with the git-spice variants, not raw git:**

| Intent | Command |
|---|---|
| Continue after resolving conflicts | `git-spice --no-prompt rebase continue --no-edit` (`git-spice --no-prompt rbc --no-edit`) |
| Abort and restore pre-rebase state | `git-spice --no-prompt rebase abort` (`git-spice --no-prompt rba`) |

Workflow during a conflict:
1. Edit conflicted files, `git add` them.
2. Run `git-spice --no-prompt rebase continue --no-edit`. git-spice resumes its multi-branch operation (e.g., a stack restack continues onto the next branch).

Using raw `git rebase --continue` works for the *current* rebase only; git-spice won't auto-advance to the next branch in a multi-step operation.

## Common workflows

### Build a stack from staged changes

```bash
# On trunk, with the first chunk staged
git-spice --no-prompt branch create feat-a -m "<message>"
# Stage the next chunk
git-spice --no-prompt branch create feat-b -m "<message>"
# And so on
git-spice --no-prompt branch create feat-c -m "<message>"
git-spice --no-prompt log long   # confirm the shape
```

### Update a mid-stack branch

```bash
git-spice --no-prompt down                  # drop down to feat-b
# edit files, git add
git-spice --no-prompt commit amend          # or commit create — both auto-restack upstack
```

### Submit and iterate

```bash
git-spice --no-prompt stack submit --fill <draft-flag> # push all, open PRs, fill from commit messages
# Reviewer leaves feedback on feat-b
git-spice --no-prompt branch checkout feat-b
# fix, git add
git-spice --no-prompt commit amend
git-spice --no-prompt stack submit --fill <draft-flag> # idempotent — only changed branches force-push
```

### Sync after a merge

```bash
git-spice --no-prompt trunk
git-spice --no-prompt repo sync --restack # pulls main, deletes merged branches, restacks survivors
```

Without `--restack`, survivors are only retargeted to the new trunk and remain misaligned until a separate `git-spice --no-prompt repo restack`.

### Insert a new branch into an existing stack

```bash
git-spice --no-prompt branch checkout feat-b
git-spice --no-prompt branch create --insert feat-b2 -m "<message>" # feat-b2 sits between feat-b and feat-c
```

### Move a sub-stack onto a different base

```bash
git-spice --no-prompt branch checkout feat-b
git-spice --no-prompt upstack onto main     # detach feat-b + everything above; rebase onto main
```

## Recovery / triage

Stacks get into wedged states. Common ones:

- **Restack stopped on conflict** → `git add` resolutions, `git-spice --no-prompt rebase continue --no-edit`. If you want out, `git-spice --no-prompt rebase abort`.
- **Branch silently diverged from base** → `git-spice --no-prompt branch restack` for one, `git-spice --no-prompt repo restack` for all.
- **Branches "missing" from `log long`** → first check `git-spice --no-prompt log long --all`; by default `log` only shows the current stack. If genuinely untracked, `git-spice --no-prompt branch track` on each, or `git-spice --no-prompt downstack track` from the top.
- **Upstack flagged "needs restack" after a sync** → `repo sync` ran without `--restack`. Run `git-spice --no-prompt repo restack` (or `stack restack` if it's one stack).
- **Wrong trunk recorded** → `git-spice --no-prompt repo init --trunk=<correct> --remote=<name>`.
- **Want to start over** → `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset` (forgets tracking, leaves git branches intact).

For non-trivial recovery (multiple wedged branches, lost work, divergence after a force-push from someone else), dispatch the **stack-doctor** subagent — it has a structured triage protocol.

## Building a stack programmatically (driving from a plan)

When you need to translate a sequence of dependent tasks into a stack:

1. Confirm the repo is initialized: `git-spice --no-prompt auth status` (network ops will need it) and that trunk is set (`git-spice --no-prompt log long` — should show the trunk root).
2. Start on trunk: `git-spice --no-prompt trunk`.
3. For each task: implement → `git add` → `git-spice --no-prompt branch create <slug> -m "<message>"` (this commits + creates + tracks in one step).
4. After the last task: `git-spice --no-prompt stack submit --fill <draft-flag>` to open the chain of PRs.

The **stacker** subagent encapsulates this loop and is what you should dispatch when handed a multi-step plan that should ship as a stack.

## Don't

- **Don't `git rebase` inside a stack** without going through git-spice. You'll desync the recorded bases. Use `git-spice --no-prompt upstack restack`, or `git-spice --no-prompt branch edit` when the user is driving interactively.
- **Don't `git push --force`** on a tracked branch. Use `git-spice --no-prompt <scope> submit <draft-flag>` — git-spice uses `--force-with-lease` semantics and updates only the branches that need it.
- **Don't delete tracked branches with `git branch -D`.** Use `git-spice --no-prompt branch delete` so upstack branches get re-parented.
- **Don't assume `gs`** is git-spice in commands you write. Always `git-spice`.

## Dispatching optional Pi subagents

If the subagent tool is available, list agents first. Dispatch only an executable, non-disabled git-spice.stacker or git-spice.stack-doctor with fresh context and complete inputs. Never run both against the same checkout concurrently. If the tool or named agent is unavailable, run the documented direct workflow instead.

## Configuration

Per-repo config lives in `git config` under the `spice.*` namespace:

- `spice.submit.draft=true` — open new CRs as drafts by default.
- `spice.submit.navigationComment=false` — don't post the stack-navigation comment.
- `spice.submit.label=stack` — auto-label new CRs.
- `spice.submit.reviewers=alice,bob` — auto-request reviewers.
- `spice.branchCreate.prefix=user/` — prefix all new branches.
- `spice.repoSync.restack=upstack` — make `repo sync` restack survivors by default.

Set with `git config spice.submit.draft true` (add `--global` for user-wide).

## Explicit initialization and reset safety

For every initialization, reconfiguration, or recovery path, gather both trunk and remote from explicit arguments, a Pi user-question tool, or plain chat. Always run `git-spice --no-prompt repo init --trunk=<name> --remote=<name>`. A reset forgets all git-spice tracking relationships while leaving Git branches; disclose that impact and require a separate explicit confirmation before running `git-spice --no-prompt repo init --trunk=<name> --remote=<name> --reset`.

## Explicit submit draft state

Before every create-capable direct submit workflow, resolve draft state from an explicit argument, then `spice.submit.draft`, then a Pi user-question tool or plain chat. Execute with an explicit `<draft-flag>` chosen as `--draft` or `--no-draft`; never rely on an implicit draft state. The `--update-only` exception applies only when that flag proves no new Change Request can be created; otherwise never omit the draft flag.
