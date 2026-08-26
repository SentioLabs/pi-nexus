---
name: stacking-workflow
description: >
  Decide whether to stack a piece of work and how to drive the stack end-to-end. This skill should be used whenever a feature naturally decomposes into a chain of dependent changes — refactor-then-feature, scaffold-then-implement, prep-then-build, multi-task plans, or anything where reviewers will want to read piece-by-piece. Also load when the user says "break this up", "split this PR", "stack these", "reviewable chunks", "this PR is too big", "do the refactor first", or signals refactor-then-feature / prep-then-build sequencing. Load proactively when about to execute a multi-step plan (arc, brainstorm, or otherwise) where shipping as one PR would be a review nightmare. This is the workflow companion to the `git-spice` reference skill — load both together when actually building a stack.
license: MIT
---

# Stacking workflow

When a piece of work is *too big for one PR but also genuinely sequential*, stacking is the answer. For the CLI mechanics, load the `git-spice` skill.

## When to stack

| Situation | Stack? | Why |
|---|---|---|
| Refactor that enables a feature | **Yes** | Reviewers can ack the refactor on its own merits, then the feature is small. |
| One feature, ~3+ logical phases (scaffold → core → polish) | **Yes** | Each phase reviewable independently; first phases can merge while later iterate. |
| Bug fix that needs a test-infra change first | **Yes** | The infra change has its own review audience. |
| Several unrelated small fixes | **No** | Send as parallel PRs from trunk. Stacking forces artificial ordering. |
| One self-contained 50-line change | **No** | One PR. Stacking adds ceremony with no payoff. |
| Exploratory spike | **No** | Stacking presumes you'll ship in order. Spikes often discard middle pieces. |
| Migration with N similar steps | **Maybe** | Stack if reviewers benefit from seeing the pattern emerge; otherwise one PR with good commit history. |

The smell test: **would a reviewer thank you for splitting this?** If yes, stack. If they'd rather see it whole, don't.

## Sizing a stack

- **Branches per stack: 2–6 is the sweet spot.** Below 2 isn't a stack; above 6 you spend more time managing the stack than reviewing it.
- **Each branch should make sense on its own.** "Adds the Foo type" + "Uses Foo in Bar" is good. "Adds the first 50 lines of Foo" + "Adds the next 50" is bad.
- **Tests live with the code they test.** Don't create a `tests/` branch on top — tests are part of the change being tested.
- **Each branch should compile and pass its own tests** at HEAD. The whole stack should be reviewable as if each branch were merged in turn.

## Naming branches in a stack

Use a shared prefix so the stack is obvious in `git branch` output and in PR lists. Two patterns work well:

- **Numbered**: `feat/auth-1-types`, `feat/auth-2-middleware`, `feat/auth-3-routes`
- **Topic-suffixed**: `auth/types`, `auth/middleware`, `auth/routes`

Pick one and be consistent within the stack. The numbered form makes ordering obvious in `git log` listings; the topic form reads better in PR titles.

A global prefix is configurable — see `spice.branchCreate.prefix` in the `git-spice` skill's Configuration section.

## End-to-end workflow

### 1. Plan the cuts

Before touching code, write down — in a sentence each — what each branch will contain. If you can't write the sentence, the cut is wrong. Aim for:

```
1. types       — add Session, Token, AuthError types + their tests
2. middleware  — request authentication middleware that consumes those types
3. routes      — wire middleware into /api/* routes; integration tests
```

Confirm the cuts with the user before building. The cost of resequencing later is high — every cut affects every cut above it.

### 2. Build the stack

Two paths:

**(a) You're driving directly.** For each chunk: implement → `git add` → `git-spice --no-prompt branch create <slug> -m "<message>"`. The `branch create` step commits, creates the branch, and records the base in one shot. Run `git-spice --no-prompt log long` between branches to sanity-check the shape.

**(b) You have an arc plan or other task list.** Dispatch the **stacker** subagent — it knows the loop and reports back per branch. Useful when there are 3+ tasks and you want execution to be uninterrupted.

### 3. Iterate on review

Reviewer comments on a mid-stack branch:

```bash
git-spice --no-prompt branch checkout <branch-with-comments>
# fix the issues
git add <files>
git-spice --no-prompt commit amend            # or 'commit create' for a follow-up commit
git-spice --no-prompt stack submit --fill     # idempotent — only the changed branch + its upstack force-push
```

The auto-restack of upstack branches happens during `commit amend`. If a restack hits conflicts, resolve and `git-spice --no-prompt rebase continue --no-edit`.

### 4. Land the stack

Branches at the bottom merge first. After each merge:

```bash
git-spice --no-prompt trunk
git-spice --no-prompt repo sync --restack     # pulls trunk, deletes the merged branch, restacks the rest
```

`repo sync` is the canonical post-merge cleanup. Run it whenever a CR merges. Keep the `--restack` flag: without it the surviving branches are only *retargeted* to the new trunk, not rebased, and stay flagged as needing restack until a separate `repo restack`.

## Failure modes (workflow-level)

For CLI mechanics — restacking after a base moves, resolving rebase conflicts, fixing untracked branches — see the recovery section in the `git-spice` skill. The points below are the *workflow* mistakes that show up at this layer, not the CLI ones.

- **"I committed with `git commit` instead of `git-spice --no-prompt commit create`"** — the branch advanced but upstack didn't restack. Fix: `git-spice --no-prompt upstack restack`.
- **"The stack got too tall."** Sizing problem. Fold the bottom two with `git-spice --no-prompt branch fold`, or — if it's a *time* problem rather than a size one — land the bottom branches now and don't wait for the top.
- **"A branch grew too big and needs splitting."** Sizing problem. `git-spice --no-prompt branch split` at chosen commits (interactive — hand it to the user in unattended runs).
- **"I rebased manually / a teammate force-pushed my base."** This is CLI recovery territory; defer to the `git-spice` skill's recovery section.

## Driving with optional Pi subagents

If the subagent tool is available, list agents first. Dispatch only an executable, non-disabled git-spice.stacker or git-spice.stack-doctor with fresh context and complete inputs. Never run both against the same checkout concurrently. If the tool or named agent is unavailable, run the documented direct workflow instead.

## Don't

- **Don't stack unrelated work.** "Bug fix" + "new feature" is two PRs from trunk, not a stack.
- **Don't stack to avoid writing a coherent PR description.** A stack is more communication overhead, not less — each branch needs its own description.
- **Don't keep a long-lived stack open.** Land the bottom branches as they get acks; don't wait for the whole tower. A 5-branch stack open for two weeks is a merge-conflict generator.
- **Don't restack by hand once the stack exists.** Use `git-spice` so bases stay tracked.
