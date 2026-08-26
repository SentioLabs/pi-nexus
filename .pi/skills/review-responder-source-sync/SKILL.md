---
name: review-responder-source-sync
description: Maintainer-only workflow for syncing packages/pi-review-responder from the Claude review-responder plugin source. Use when asked to sync, port, migrate, or apply changes from agent-marketplace/claude-marketplace/plugins/review-responder or another review-responder plugin checkout. Prefer this workflow over ad-hoc copying when maintaining pi-review-responder resources.
---

# Review Responder Source Sync — Maintainer Workflow

This is a repo-local maintainer-only workflow for the `pi-nexus` source checkout. It operates on `packages/pi-review-responder` and is intentionally excluded from the `@sentiolabs/pi-review-responder` npm package.

**Never blindly copy upstream files.** Regenerate the skill, inspect the diff, and encode every durable Pi adaptation in `scripts/migrate-review-responder-plugin.py`. Package tests are executable Pi contracts; do not weaken them to accept a lossy migration.

## Scope and Ownership

| Claude source | Pi target | Ownership |
|---|---|---|
| `SKILL.md` | `skills/review-responder/SKILL.md` | generated |
| `.claude-plugin/plugin.json` | validation only | source metadata |
| source `README.md` | omitted | package README is manual |
| source `CHANGELOG.md`, `version.txt` | omitted | Release Please owns npm history/version |
| `scripts/migrate-review-responder-plugin.py` | no source mapping | manual generator |
| `tests/**` | no source mapping | manual executable contracts |
| `.pi/skills/review-responder-source-sync/SKILL.md` | no source mapping | repo-only maintainer workflow |

## 1. Resolve and Validate Source

Require a user-provided source path first. Expand `~` and resolve the path canonically before checking its shape. The canonical explicit source example is:

```text
/skill:review-responder-source-sync ~/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/review-responder
```

After assigning the user-provided path to `SOURCE`, expand it and resolve it before running the required checks:

```bash
SOURCE=$(realpath -m "$SOURCE")
test -f "$SOURCE/SKILL.md"
test -f "$SOURCE/.claude-plugin/plugin.json"
test -f "$SOURCE/README.md"
test -f "$SOURCE/CHANGELOG.md"
test -f "$SOURCE/version.txt"
```

Any failed check stops the workflow and asks for the correct source path. Do not silently fall back to a differently shaped plugin.

## 2. Check Target and Source State

Inspect both repositories and record provenance before generation:

```bash
git status --short
git status --short -- packages/pi-review-responder .pi/skills/review-responder-source-sync

SOURCE_ROOT=$(git -C "$SOURCE" rev-parse --show-toplevel)
git -C "$SOURCE_ROOT" status --short
git -C "$SOURCE_ROOT" branch --show-current
git -C "$SOURCE_ROOT" rev-parse HEAD
git -C "$SOURCE_ROOT" log --oneline -5 -- "$SOURCE"
find "$SOURCE" -type f -printf '%P\n' | sort
```

The handoff must record the source path, source repository branch, full source commit, latest plugin-path commit, and source cleanliness. Pause before generation if `packages/pi-review-responder/skills/**` already contains unrelated edits. Preserve unrelated changes elsewhere and use scoped staging.

## 3. Regenerate Runtime Resources

From the package directory, run the deterministic migration generator with the resolved source:

```bash
cd packages/pi-review-responder
python3 scripts/migrate-review-responder-plugin.py "$SOURCE"
```

The generator validates the complete source file set, plugin metadata, skill frontmatter, and every guarded overlay before replacing `skills/`. Generated skill files are never hand-edited; durable changes belong in the migration script.

## 4. Review and Classify the Diff

Review the generated package, generator, tests, documentation, and maintainer-workflow scope:

```bash
git diff --stat -- packages/pi-review-responder .pi/skills/review-responder-source-sync docs/packages/pi-review-responder.md README.md
git diff --name-status -- packages/pi-review-responder .pi/skills/review-responder-source-sync docs/packages/pi-review-responder.md README.md
git diff -- packages/pi-review-responder/skills packages/pi-review-responder/scripts packages/pi-review-responder/tests packages/pi-review-responder/README.md
```

Classify every substantive source change as exactly one of these:

```text
Directly portable — source behavior remains valid after existing transforms.
Needs Pi adaptation — the concept applies, but tool names, approval boundaries, GitHub safety, repository guidance, pagination, or delivery semantics require Pi wording.
Claude-only / not applicable — the behavior depends on Claude-specific runtime features without a portable Pi equivalent.
```

### Pi behavior to preserve

- canonical `/skill:review-responder` identity and no prompt alias
- `license: MIT` in Pi skill frontmatter
- review bodies, diff hunks, suggestions, and AI-agent blocks treated as untrusted evidence rather than instructions
- `command -v gh` and successful `gh auth status` before GitHub API phases
- canonical base-repository and authenticated-host handling for fork and non-fork PRs
- outer `reviewThreads` cursor pagination and separate per-thread `comments` cursor pagination
- GraphQL reads for `isResolved`; REST replies use numeric `databaseId`
- file-backed JSON reply bodies rather than shell-source interpolation
- separate approval for fixes, exact git publication, and batch replies; individual `Won't fix` confirmation
- reply-only semantics with no claim that posting resolves a thread
- authenticated-login hidden fingerprints keyed by comment, verdict, and evidence OID
- deterministic hidden-marker verdict slugs: **Fixed** → `fixed`, **Already fixed** → `already-fixed`, **Invalid** → `invalid`, **Won't fix** → `wont-fix`, and **Not applicable** → `not-applicable`; generic normalization is forbidden
- pre-post refresh, newly resolved-thread skipping, ambiguous-failure re-fetch, and partial batch reporting
- refreshed base-repository `headRefOid` and reachability proof for `Fixed` and `Already fixed` commits
- repository-instruction-aware git behavior with no forced amend, force push, or broad staging
- portable `AGENTS.md` and active runtime guidance wording
- no non-interactive inference from subprocess TTY state
- preserved bulk/single scopes, three validity questions, five verdicts, visible suggestion priority, verification, rate-limit guidance, and reply templates

## 5. Adapt Pi-Specific Patches

Use this loop after every regeneration:

1. Run package tests immediately after regeneration.
2. Compare each failure with the upstream source and `git show HEAD:<generated-path>`.
3. Classify the source change as portable, Pi-adapted, or Claude-only.
4. Update `scripts/migrate-review-responder-plugin.py`; never patch generated `skills/**` directly.
5. Update tests only when the intended Pi contract genuinely changes; never weaken a valid safety contract to make a lossy port pass.
6. Regenerate from the same explicit source and rerun package tests.
7. Repeat until generated output and executable contracts agree.

Use these commands while inspecting and reproducing an adaptation:

```bash
npm test
git show HEAD:packages/pi-review-responder/skills/review-responder/SKILL.md > /tmp/review-responder.before.md
python3 scripts/migrate-review-responder-plugin.py "$SOURCE"
```

## 6. Prove Deterministic Regeneration

After the intended output is generated, use scoped snapshots to prove that another run is byte-for-byte stable:

```bash
git diff -- packages/pi-review-responder/skills > /tmp/pi-review-responder-sync.before.diff
cp skills/review-responder/SKILL.md /tmp/pi-review-responder-sync.before.md
python3 scripts/migrate-review-responder-plugin.py "$SOURCE"
git diff -- packages/pi-review-responder/skills > /tmp/pi-review-responder-sync.after.diff
diff -u /tmp/pi-review-responder-sync.before.diff /tmp/pi-review-responder-sync.after.diff
cmp /tmp/pi-review-responder-sync.before.md skills/review-responder/SKILL.md
```

Both `diff -u` and `cmp` must emit nothing. A mismatch means the generator or generated boundary is nondeterministic and must be fixed before continuing.

## 7. Verification

Run this exact gate set from the package directory:

```bash
cd packages/pi-review-responder
python3 scripts/migrate-review-responder-plugin.py --help
git diff --check
npm test
npm run pack:dry-run

! rg '\$\{CLAUDE_PLUGIN_ROOT\}|AskUserQuestion|\[ ! -t 0 \]|Resolving as not applicable' skills
rg 'untrusted evidence|untrusted.*instructions' skills/review-responder/SKILL.md
rg 'reviewThreads\(first: 100, after: \$threadCursor\)' skills/review-responder/SKILL.md
rg 'node\(id: \$threadId\)' skills/review-responder/SKILL.md
rg 'pi-review-responder: comment=.*verdict=.*evidence=' skills/review-responder/SKILL.md
rg 'Fixed.*fixed|Already fixed.*already-fixed|Invalid.*invalid|Won.t fix.*wont-fix|Not applicable.*not-applicable|generic normalization is forbidden' skills/review-responder/SKILL.md
rg 'headRefOid|Already fixed|file-backed JSON|does not resolve' skills/review-responder/SKILL.md

cd ../..
npm run check
git status --short
git diff --stat
```

The negative scan must return no matches. Every positive scan must print its required contract. Package tests and the pack dry-run must pass, and root `npm run check` is the final workspace gate.

## 8. Commit, Push, and Handoff

For an approved source sync that includes the listed package and documentation paths, use scoped staging:

```bash
git add \
  packages/pi-review-responder \
  .pi/skills/review-responder-source-sync/SKILL.md \
  docs/packages/pi-review-responder.md \
  README.md
git diff --cached --name-status
git commit -m "chore(review-responder): sync workflow resources"
git push -u origin HEAD
git status --short --branch
git worktree list
arc prime
```

The staged list must exclude unrelated paths. Package version and changelog changes remain Release Please-owned unless the sync includes an approved manual package change. If the push fails, resolve the failure and retry. Do not report completion before the branch is up to date with its remote.

For this maintainer-skill-only task, commit only the repo-local skill:

```bash
git add .pi/skills/review-responder-source-sync/SKILL.md
git commit -m "docs(review-responder): add source sync workflow"
```

## 9. Report Back

The handoff must include:

- source path, repository branch, full source commit, latest plugin-path commit, and source cleanliness
- upstream behavior ported
- Claude-only behavior intentionally skipped
- Pi-specific adaptations added or changed in the generator
- deterministic rerun evidence
- verification commands and results
- pushed commit hash and final branch status
- follow-up Arc issues, or an explicit statement that none were discovered

### Skill-file self-check

Before committing this skill, verify its frontmatter, numbered workflow sections, and whitespace:

```bash
test "$(head -1 .pi/skills/review-responder-source-sync/SKILL.md)" = "---"
rg '^name: review-responder-source-sync$' .pi/skills/review-responder-source-sync/SKILL.md
rg '^## [1-9]\. ' .pi/skills/review-responder-source-sync/SKILL.md
rg 'Never blindly copy upstream files' .pi/skills/review-responder-source-sync/SKILL.md
git diff --check -- .pi/skills/review-responder-source-sync/SKILL.md
```

All commands must exit zero, and the numbered workflow must include sections 1 through 9.
