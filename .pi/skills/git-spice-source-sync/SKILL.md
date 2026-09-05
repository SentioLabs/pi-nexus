---
name: git-spice-source-sync
description: Maintainer-only workflow for syncing packages/pi-git-spice from the Claude git-spice plugin source. Use when asked to sync, port, migrate, or apply changes from agent-marketplace/claude-marketplace/plugins/git-spice or another git-spice plugin source checkout. Prefer this workflow over ad-hoc copying when maintaining pi-git-spice resources.
---

# Git Spice Source Sync — Maintainer Workflow

This is a **repo-local maintainer-only** workflow for the `pi-nexus` source checkout. It operates on `packages/pi-git-spice` and is intentionally not shipped in the `@sentiolabs/pi-git-spice` npm package.

**Never blindly copy upstream files.** Regenerate mechanical resources, inspect the diff, and encode every Pi-specific adaptation in `scripts/migrate-git-spice-plugin.py` so a future sync reproduces it. Package tests are executable Pi contracts; do not weaken them to accept a lossy migration.

## Scope and Ownership

- **Generated package paths:** `packages/pi-git-spice/prompts/**`, `packages/pi-git-spice/skills/**`, `packages/pi-git-spice/agents/**`
- **Manual package paths:** `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `tests/**`, `scripts/migrate-git-spice-plugin.py`
- **Repo-only path:** `.pi/skills/git-spice-source-sync/SKILL.md`
- **Source categories:** directly portable, needs Pi adaptation, Claude-only/not applicable

This skill is repository-local only. It is not a generated runtime resource and must not be added to `packages/pi-git-spice/package.json`, its `pi` discovery configuration, or any package-generated root.

## 1. Resolve and Validate Source

Prefer a user-provided source path. Otherwise use the canonical default source, `~/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/git-spice`. Expand a leading `~`, resolve the path, and stop rather than guessing if the source does not have the required shape.

```bash
SOURCE="${1:-${SOURCE:-~/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/git-spice}}"
SOURCE="${SOURCE/#\~/$HOME}"
SOURCE=$(realpath -m "$SOURCE")
```

The following checks are the required source shape. Stop if any command fails.

```bash
SOURCE=$(realpath -m "$SOURCE")
test -f "$SOURCE/commands/continue.md"
test -f "$SOURCE/commands/init.md"
test -f "$SOURCE/commands/new.md"
test -f "$SOURCE/commands/restack.md"
test -f "$SOURCE/commands/stack.md"
test -f "$SOURCE/commands/submit.md"
test -f "$SOURCE/commands/sync.md"
test -f "$SOURCE/skills/git-spice/SKILL.md"
test -f "$SOURCE/skills/stacking-workflow/SKILL.md"
test -f "$SOURCE/agents/stack-doctor.md"
test -f "$SOURCE/agents/stacker.md"
test -f "$SOURCE/.claude-plugin/plugin.json"
```

Both explicit generator forms are supported:

```bash
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py "$SOURCE"
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py --source "$SOURCE"
```

### Review the compiled source trust boundary

Before regeneration, compare the source repository commit and all 12 classified-file digests with `REVIEWED_UPSTREAM_COMMIT` and `PINNED_SOURCE_SHA256` in `packages/pi-git-spice/scripts/migrate-git-spice-plugin.py`. Those compiled values are the 12-source digest trust boundary: the 11 classified runtime Markdown resources plus `.claude-plugin/plugin.json`.

If the source commit or any digest differs, stop. Review the upstream commit and the plugin-scoped diff first. Updating a source pin is a maintainer attestation that those exact bytes were reviewed. Deliberately update `REVIEWED_UPSTREAM_COMMIT`, `PINNED_SOURCE_SHA256`, and any affected source-path-specific, exact-cardinality Pi transforms before regeneration.

Never add a CLI or environment digest bypass, an acceptance flag, or an automatic source-pin updater. Do not require or recreate Markdown occurrence accounting, reference classification, shell parsing, generic argv extraction, or generated-command safety audits. The generator is a deterministic transformer of reviewed bytes, not a parser or safety analyzer for arbitrary Markdown or shell.

## 2. Check Target and Source State

Run these commands before generation:

```bash
git status --short
git status --short -- packages/pi-git-spice .pi/skills/git-spice-source-sync
SOURCE_ROOT=$(git -C "$SOURCE" rev-parse --show-toplevel)
git -C "$SOURCE_ROOT" status --short
git -C "$SOURCE_ROOT" branch --show-current
git -C "$SOURCE_ROOT" rev-parse HEAD
git -C "$SOURCE_ROOT" log --oneline -5 -- "${SOURCE#$SOURCE_ROOT/}"
find "$SOURCE/commands" "$SOURCE/skills" "$SOURCE/agents" -maxdepth 3 -type f | sort
```

Distinguish unrelated repository changes from edits inside the generated roots. Pause if generated paths contain unrelated changes; preserve unrelated work and use scoped staging. Record the source branch, full commit, and cleanliness. A clean source checkout does not replace the deliberate source-pin review when its commit or classified bytes differ.

## 3. Regenerate Runtime Resources

From the repository root, run one generator invocation:

```bash
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py "$SOURCE"
```

The generator owns all three generated roots: `packages/pi-git-spice/prompts`, `packages/pi-git-spice/skills`, and `packages/pi-git-spice/agents`. It validates every source-file classification, source pin, and source-path-specific exact-cardinality transform anchor before installation, and rolls all roots back if installation fails or is interrupted. Do not hand-edit generated output as a durable fix.

Keep the implementation within its approved complexity guardrails: `packages/pi-git-spice/scripts/migrate-git-spice-plugin.py` is at most 1,000 physical lines, and `packages/pi-git-spice/tests/migration.test.mjs` plus `packages/pi-git-spice/tests/package.test.mjs` are at most 1,200 physical lines combined. Exceeding either limit, or reintroducing a Markdown, occurrence, shell, or argv parser, requires a new approved design.

## 4. Review and Classify the Diff

Inspect the scoped diff:

```bash
git diff --stat -- packages/pi-git-spice .pi/skills/git-spice-source-sync
git diff --name-status -- packages/pi-git-spice .pi/skills/git-spice-source-sync
git diff -- packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents packages/pi-git-spice/tests packages/pi-git-spice/scripts packages/pi-git-spice/README.md packages/pi-git-spice/package.json
```

Classify every upstream behavior change:

- directly portable — source behavior is valid in Pi after current transforms;
- needs Pi adaptation — behavior applies but command names, tools, agent discovery, model pinning, interaction, or non-interactive execution differs;
- Claude-only/not applicable — behavior depends on Claude-specific runtime features with no Pi equivalent.

Future syncs must preserve all of these Pi behaviors:

- `/git-spice-*` prompt names, never `/git-spice:*`
- `/skill:git-spice` and `/skill:stacking-workflow`
- optional package agents `git-spice.stacker` and `git-spice.stack-doctor`
- `pi.subagents.agents` package discovery without bundling `pi-subagents`
- lowercase Pi agent tools, `inheritProjectContext: true`, fresh context, and no fixed Claude model
- list/availability checks before subagent dispatch, one mutation-capable agent per checkout, and direct fallback
- explicit arguments and `--no-prompt` for every tool-driven mutation
- `--no-edit` for rebase continuation
- explicit trunk/remote gathering for init and separate confirmation for `repo init --reset`
- explicit commit message or `--no-commit` for branch creation; `-a` only after approval
- explicit submit draft-state resolution before creating Change Requests
- Release Please ownership of package version and changelog
- exact npm tarball exclusion of maintainer scripts, tests, and repo-local skills

Inspect every generated diff after regeneration. The reviewed source-pin boundary plus exact path/cardinality transform contracts and reviewed output hashes are the trust boundary; do not substitute a generic command audit for that review.

## 5. Adapt Pi-Specific Patches

Use this loop:

1. Run package tests immediately after regeneration.
2. For each failure, compare generated output with the source and `git show HEAD:<path>`.
3. Classify the change as portable, Pi-adapted, or Claude-only.
4. Update `scripts/migrate-git-spice-plugin.py`; do not hand-edit generated files.
5. Re-run the generator against the same explicit source.
6. Re-run package tests and repeat until contracts pass without weakening valid tests.

```bash
npm test --workspace @sentiolabs/pi-git-spice
git show HEAD:packages/pi-git-spice/skills/git-spice/SKILL.md > /tmp/git-spice-skill.before.md
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py "$SOURCE"
```

After regeneration, deliberately compute all 11 generated-resource SHA-256 values and compare them with the literal reviewed-output map in `packages/pi-git-spice/tests/package.test.mjs`.

```bash
find packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents -type f | sort | xargs sha256sum
git diff -- packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents
```

Inspect every generated diff, then deliberately update the literal reviewed-output map only for reviewed intended output changes. Package tests must fail until the reviewed output hashes and Pi-delta literal contracts match. Never auto-update output pins or weaken valid tests to make a lossy migration pass.

## 6. Prove Deterministic Regeneration

Use scoped snapshots:

```bash
git diff -- packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents > /tmp/pi-git-spice-sync.before.diff
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py "$SOURCE"
git diff -- packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents > /tmp/pi-git-spice-sync.after.diff
diff -u /tmp/pi-git-spice-sync.before.diff /tmp/pi-git-spice-sync.after.diff
```

`diff -u` must emit nothing. Otherwise fix the generator or generated boundary and repeat; do not normalize the result by hand-editing generated resources.

## 7. Verification

Run the complete package and repository gate set:

```bash
python3 packages/pi-git-spice/scripts/migrate-git-spice-plugin.py --help
git diff --check
npm test --workspace @sentiolabs/pi-git-spice
npm run pack:dry-run --workspace @sentiolabs/pi-git-spice
! rg '/git-spice:|subagent_type|model: sonnet' packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents
rg 'git-spice\.stacker|git-spice\.stack-doctor|--no-prompt|--no-edit' packages/pi-git-spice/prompts packages/pi-git-spice/skills packages/pi-git-spice/agents
npm test
npm run check
git status --short
git diff --stat
```

Expected outcomes: help succeeds; the whitespace check is clean; package and root tests pass; the pack dry-run excludes maintainer tooling; the negative scan returns no matches; and the positive scan prints Pi agent and non-interactive safety contracts. Confirm the pack result excludes `scripts/`, `tests/`, and repo-local `.pi/` skills rather than assuming the package manifest does so.

## 8. Commit, Push, and Handoff

Stage only intended files and push successfully before completion:

```bash
git add .pi/skills/git-spice-source-sync packages/pi-git-spice docs/packages/pi-git-spice.md docs/development.md docs/releasing.md README.md release-please-config.json .release-please-manifest.json .github/workflows/release-please.yml tests/workspace-contract.test.mjs package-lock.json
git diff --cached --name-status
git commit -m "feat(git-spice): sync plugin resources"
git push -u origin HEAD
git status --short --branch
git worktree list
arc prime
```

The staged list must exclude unrelated paths. Push must succeed before completion; never say “ready to push” instead of pushing. If it fails, resolve the failure and retry. For this maintainer-skill-only change, use the narrow variant:

```bash
git add .pi/skills/git-spice-source-sync/SKILL.md
git commit -m "docs(git-spice): add source sync workflow"
```

## 9. Report Back

The handoff must record:

- resolved source path;
- source repository branch, full commit, and cleanliness;
- old and new source commit, plus changed source and output digests;
- upstream behavior ported;
- Claude-only behavior intentionally skipped;
- Pi-specific adaptations encoded in the generator;
- deterministic regeneration result;
- verification commands and results;
- pushed commit hash and final branch status;
- follow-up Arc issues, or an explicit statement that none were discovered.

Report the digest-review decision as provenance: identify the exact reviewed upstream behavior and the deliberate source/output pin changes. This makes the source pin an auditable maintainer attestation rather than an automatic update.

Verify this maintainer skill is repository-local and complete:

```bash
test -f .pi/skills/git-spice-source-sync/SKILL.md
test ! -e packages/pi-git-spice/skills/git-spice-source-sync/SKILL.md
rg 'repo-local maintainer-only|Never blindly copy|migrate-git-spice-plugin\.py|diff -u /tmp/pi-git-spice-sync\.before\.diff|npm run check|git push -u origin HEAD' .pi/skills/git-spice-source-sync/SKILL.md
git diff --check -- .pi/skills/git-spice-source-sync/SKILL.md
```

The expected result is that the file exists only under `.pi/skills`, every required workflow marker is present, and no whitespace errors are reported.
