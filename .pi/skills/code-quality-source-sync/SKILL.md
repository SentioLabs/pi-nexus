---
name: code-quality-source-sync
description: Maintainer-only workflow for syncing packages/pi-code-quality from the Claude code-quality plugin source. Use when asked to sync, port, migrate, or apply changes from agent-marketplace/claude-marketplace/plugins/code-quality or another code-quality plugin source checkout. Prefer this workflow over ad-hoc copying when maintaining pi-code-quality resources.
---

# Code Quality Source Sync — Maintainer Workflow

This is a **repo-local maintainer-only** workflow for the `pi-nexus` source checkout. It operates on `packages/pi-code-quality` and is intentionally not shipped in the `@sentiolabs/pi-code-quality` npm package.

**Never blindly copy upstream files.** Regenerate mechanical resources, inspect the diff, and encode every Pi-specific adaptation in `scripts/migrate-code-quality-plugin.py` so a future sync reproduces it.

The skill must be sufficient to complete a sync without a supplemental prompt. Package tests are executable Pi contracts; do not weaken them to accept a lossy migration.

## Scope and Ownership

- **Generated package paths:** `packages/pi-code-quality/prompts/**`, `packages/pi-code-quality/skills/**`
- **Manual package paths:** `package.json`, `README.md`, `tests/**`
- **Repo-only path:** `.pi/skills/code-quality-source-sync/SKILL.md`
- **Source categories:** directly portable, needs Pi adaptation, Claude-only/not applicable

## Source/Pi Mapping

| Claude source | Pi package |
|---|---|
| `commands/review.md` | `prompts/code-quality-review.md` |
| `commands/size.md` | `prompts/code-quality-size.md` |
| `skills/deep-review/**` | `skills/deep-review/**` with Pi execution overlays |
| `skills/size-review/**` | `skills/size-review/**` with Pi execution overlays |
| Claude model/tool names | Portable Pi tier intent, generic parallel execution, sequential fallback |
| Source changelog/version | Omitted; npm metadata is Release Please-managed |

## 1. Resolve and Validate Source

Use a user-provided source path first. Expand `~`, resolve the path, and then validate its shape. The normal explicit source example is:

```text
/skill:code-quality-source-sync ~/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/code-quality
```

After assigning the user-provided path to `SOURCE`, expand it and resolve it before running the checks:

```bash
SOURCE=$(realpath -m "$SOURCE")
test -f "$SOURCE/commands/review.md"
test -f "$SOURCE/commands/size.md"
test -f "$SOURCE/skills/deep-review/SKILL.md"
test -f "$SOURCE/skills/deep-review/references/output-actions.md"
test -f "$SOURCE/skills/size-review/SKILL.md"
test -f "$SOURCE/.claude-plugin/plugin.json"
```

Stop and ask for the correct path when any check fails. From `packages/pi-code-quality`, the migration CLI accepts either of these equivalent forms:

```bash
cd packages/pi-code-quality
python3 scripts/migrate-code-quality-plugin.py "$SOURCE"
python3 scripts/migrate-code-quality-plugin.py --source "$SOURCE"
```

## 2. Check Target and Source State

Inspect the target and source repositories before generation:

```bash
git status --short
git status --short -- packages/pi-code-quality .pi/skills/code-quality-source-sync
git -C "$(git -C "$SOURCE" rev-parse --show-toplevel)" status --short
git -C "$(git -C "$SOURCE" rev-parse --show-toplevel)" branch --show-current
git -C "$(git -C "$SOURCE" rev-parse --show-toplevel)" log --oneline -5 -- "$SOURCE"
find "$SOURCE/commands" "$SOURCE/skills" -maxdepth 3 -type f | sort
```

Distinguish unrelated repository changes from changes inside the package/generated scope. Pause before regeneration if generated package paths already have unrelated edits. Preserve unrelated changes elsewhere and use scoped staging throughout.

## 3. Regenerate Runtime Resources

From the package directory, run the generator with the resolved source:

```bash
cd packages/pi-code-quality
python3 scripts/migrate-code-quality-plugin.py "$SOURCE"
```

The generator owns `prompts/` and `skills/`, validates all patch anchors before installing output, removes stale slop-named runtime resources, and intentionally recognizes only `.code-quality/review-acceptances.md`. Do not hand-edit generated resources; encode durable Pi behavior in `scripts/migrate-code-quality-plugin.py`.

## 4. Review and Classify the Diff

Review the full generated and approved package scope:

```bash
git diff --stat -- packages/pi-code-quality .pi/skills/code-quality-source-sync
git diff --name-status -- packages/pi-code-quality .pi/skills/code-quality-source-sync
git diff -- packages/pi-code-quality/prompts packages/pi-code-quality/skills packages/pi-code-quality/tests packages/pi-code-quality/README.md packages/pi-code-quality/package.json
```

Classify every substantive change as one of the following:

- **Directly portable** — source behavior is valid in Pi after existing transforms.
- **Needs Pi adaptation** — the concept applies, but tools, models, paths, CI detection, command names, or output actions require Pi wording.
- **Claude-only / not applicable** — the behavior depends on Claude-specific runtime features with no portable Pi equivalent.

### Pi behavior to preserve

- canonical `deep-review`, `size-review`, `/code-quality-review`, and `/code-quality-size` names
- no slop-named skill/prompt alias and no legacy slop-acceptance filename
- five separate lenses with AI-slop/curation advisory only
- false-negative calibration sweep and grade caps
- strict size thresholds, hard ceiling, full seam sweep, and split-leaning recommendations
- relative `references/` paths and `license: MIT`
- generic parallel task/subagent execution when available plus sequential same-methodology fallback
- no Arc or optional package requirement
- `ask_user_question` with `questions[]`, package-provided escape hatches, and `(Recommended)` convention
- no stdin-TTY probe for CI detection; explicit CI environment values or explicit headless request only
- Pi-neutral `DEEP_REVIEW.md` and `SIZE_REVIEW.md` report names
- Release Please ownership of package version/changelog

## 5. Adapt Pi-Specific Patches

Use this loop after every regeneration:

1. Run package tests immediately after regeneration.
2. For each failure, compare generated output with the source and `git show HEAD:<path>`.
3. Classify the change as portable, Pi-adapted, or Claude-only.
4. Update `scripts/migrate-code-quality-plugin.py`; do not hand-edit generated files.
5. Rerun the generator against the same explicit source.
6. Rerun package tests and repeat until contracts pass without weakening valid tests.

Use these commands when inspecting and reproducing an adaptation:

```bash
npm test --workspace @sentiolabs/pi-code-quality
git show HEAD:packages/pi-code-quality/skills/deep-review/SKILL.md > /tmp/deep-review.before.md
python3 packages/pi-code-quality/scripts/migrate-code-quality-plugin.py "$SOURCE"
```

### Deterministic regeneration

After the generator and its overlays produce the intended output, prove a second run is identical using scoped snapshots:

```bash
git diff -- packages/pi-code-quality/prompts packages/pi-code-quality/skills > /tmp/pi-code-quality-sync.before.diff
python3 packages/pi-code-quality/scripts/migrate-code-quality-plugin.py "$SOURCE"
git diff -- packages/pi-code-quality/prompts packages/pi-code-quality/skills > /tmp/pi-code-quality-sync.after.diff
diff -u /tmp/pi-code-quality-sync.before.diff /tmp/pi-code-quality-sync.after.diff
```

`diff -u` must emit nothing; otherwise the generator or generated output is not stable. Fix the generator or its generated boundary and repeat the loop rather than accepting nondeterministic output.

## 6. Verification

Run this exact gate set from the package directory:

```bash
cd packages/pi-code-quality
python3 scripts/migrate-code-quality-plugin.py --help
git diff --check
npm test
npm run pack:dry-run
! rg '\$\{CLAUDE_PLUGIN_ROOT\}|AskUserQuestion|/code-quality:|model: "(fable|opus|sonnet)"|CLAUDE_(DEEP|SIZE)_REVIEW|\.code-quality/slop-acceptances\.md' skills prompts
! rg 'name: slop-review|/code-quality-slop|Use the `slop-review` skill' skills prompts
rg 'Phase 1a \(Correctness & Quality\)|Phase 1b \(Security\)|Phase 1e \(AI Slop & Curation Evidence\)|False-negative sweep \(mandatory\)|Grade caps' skills/deep-review/SKILL.md
rg 'More than \*\*10 files changed\*\*|More than \*\*400 lines added\*\*|Sweep the whole catalog|Split by default' skills/size-review/SKILL.md
```

The help command must succeed and describe the migration CLI. `git diff --check` must produce no whitespace errors, package tests must pass, and `npm run pack:dry-run` must succeed without including repo-only maintainer tooling. Both `! rg` negative scans must find no forbidden Claude-specific or slop-named runtime content and therefore exit successfully with no matches. The first positive `rg` scan must print the required five-lens, calibration, and grading content. The second positive `rg` scan must print the required size thresholds, catalog sweep, and split recommendation content.

After the package checks, return to the repository root and run a final root-level `npm test`, then inspect the final state:

```bash
cd ../..
npm test
git status --short
git diff --stat
```

## 7. Commit, Push, and Handoff

Use scoped staging rather than `git add .` when unrelated changes exist. For an approved source sync that includes the listed package and documentation paths, use:

```bash
git add .pi/skills/code-quality-source-sync packages/pi-code-quality docs/packages/pi-code-quality.md README.md
git diff --cached --name-status
git commit -m "feat(code-quality): sync deep review workflow"
git push -u origin HEAD
git status --short --branch
git worktree list
arc prime
```

Review the staged-file list and require it to exclude unrelated paths. Require push success before completion. Do not instruct the agent to stage `.gitignore` or `packages/pi-arc/` unless those paths belong to a separate approved task. Never use a broad staging command that can capture pre-existing unrelated work.

For this maintainer-skill-only change, stage and commit only the repo-local skill:

```bash
git add .pi/skills/code-quality-source-sync/SKILL.md
git commit -m "docs(code-quality): add source sync workflow"
```

## 8. Report Back

Record all of the following in the handoff:

- source path, repository branch, full source commit, and source cleanliness
- upstream behavior ported
- Claude-only behavior intentionally skipped
- Pi-specific adaptations encoded in the generator
- clean-rename behavior, including acceptance-file compatibility removed
- verification commands and results
- pushed commit hash and final branch status
- follow-up Arc issues, or an explicit statement that none were discovered
