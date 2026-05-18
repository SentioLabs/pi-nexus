# Protected-Branch Check

Shared reference for arc workflow skills (brainstorm, build, finish). When a skill says "perform the protected-branch check per `skills/arc/_branch-check.md`", do exactly what's in this file.

## Why this check exists

Direct commits to trunk (`main` / `master` / `release` / `production`) bypass review, can't be undone without a force-push that destroys teammates' history, and are how releases get broken. The cost of asking the user one question is far smaller than the cost of an unintended trunk commit — especially after they've spent an hour brainstorming or building work that now has to be rebased onto a feature branch.

## When to run the check

| Skill | When |
|---|---|
| `brainstorm` | Pre-flight, before any design dialogue. Sets up the branch context for everything downstream. |
| `build` | Pre-flight, before dispatching any task. Subagents will commit to whatever branch you're on. |
| `finish` | Phase 4, immediately before staging/committing. Last line of defense. |

Run it **every time the skill runs** — don't assume a previous answer carries forward across sessions. Branch state changes; cost of asking again is one click.

## How to run the check

1. Get the current branch:

   ```bash
   git branch --show-current
   ```

2. If the result is **not** in the protected list (`main`, `master`, `release`, `production`), you're done — proceed with the skill.

3. If the result **is** protected, check the project's `CLAUDE.md` (or `AGENTS.md`) for an explicit opt-out — a line like *"This project commits directly to main; skip the protected-branch check."* If present, you're done — proceed without prompting. (The project owner has consciously chosen trunk-based development.)

4. Otherwise, use the `AskUserQuestion` tool with this exact shape — the wording matters because Claude has to recognise the branching choice and act on it:

   - **question**: `"You're on '<branch>'. Continue here, or switch to a feature branch first?"`
   - **options**:
     - `Switch to a feature branch` — recommended; you should run `git checkout -b <suggested-name>` (suggest a name from the work context — e.g. `feat/<topic>` for brainstorm, the arc task slug for build, a summary of the diff for finish) and proceed on the new branch
     - `Stay on '<branch>'` — the user has consciously chosen trunk-direct work for this session
     - `Cancel` — abort the current skill; user wants to handle branching manually first

5. Branch on the answer:
   - **Switch** → create the branch, then continue the skill on it
   - **Stay** → continue on trunk
   - **Cancel** → stop the skill; do not commit, do not dispatch tasks, do not write design docs

## Why no env-var or CLI flag opt-out

Earlier drafts had `ARC_MAIN_GUARD=off` and a bypass-token prefix. Both removed: this is a skill-level prompt, not a hook. The opt-out lives in `CLAUDE.md` so it's discoverable, version-controlled, and applies project-wide. If the user is annoyed by the prompt, the right answer is to add the `CLAUDE.md` line — not to teach Claude to skip the check on its own initiative.

## What this check is NOT

- Not a substitute for branch protection rules on the remote (GitHub/GitLab) — those are the actual enforcement layer
- Not a check that the *target* of `git push` is main; only that the *current* branch is. Pushing a feature branch from a main checkout is rare and not covered.
- Not a hook — there's no harness-level enforcement. If Claude skips this check, the user will only notice at PR time. The pre-flight placement (brainstorm + build) is the mitigation.
