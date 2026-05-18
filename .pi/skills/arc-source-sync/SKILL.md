---
name: arc-source-sync
description: Maintainer-only workflow for syncing this pi-arc package from the Claude Arc plugin source. Use when the user asks to sync, port, migrate, or apply changes from agent-nexus/claude-marketplace/plugins/arc or another Arc plugin source checkout. Always prefer this over ad-hoc copying when maintaining pi-arc resources.
---

# Arc Source Sync — Maintainer Workflow

Synchronize the Pi Arc package with changes from the Claude Arc plugin source while preserving Pi-native behavior.

This is a **repo-local maintainer-only** workflow for the `pi-nexus` source checkout. It operates on `packages/pi-arc` and is intentionally not shipped in the `@sentiolabs/pi-arc` npm package; it is not part of the normal end-user Arc issue workflow.

## Core Rule

**Never blindly copy upstream files.** Regenerate mechanical resources, inspect the diff, then adapt only the changes that make sense for Pi.

**Quality bar:** this skill must be enough to run a complete sync without a supplemental prompt. Treat the package tests as executable Pi contracts. If regeneration breaks a test or removes a Pi-specific guard, update `scripts/migrate-arc-plugin.py` so the guard is reproduced on every future sync; do not hand-edit generated files in a way the next migration will erase.

The Claude plugin and Pi package intentionally differ:

| Claude source | Pi package |
|---|---|
| `commands/*.md` | `prompts/arc-*.md` |
| `skills/brainstorm`, `skills/build`, etc. | `skills/arc-brainstorm`, `skills/arc-build`, etc. |
| Claude tool names and hooks | Pi tools, extension commands, and prompt injection |
| Claude team deployment | Omitted unless a Pi-native equivalent exists |
| Claude agents | Bundled `agents/*.md`, `arc_agent`, and optional `pi-subagents` sync |

## 1. Resolve Source Path

If the user provides a source path, use it. Examples:

```text
/skill:arc-source-sync ~/devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/arc
/skill:arc-source-sync ~/foo/bar/arc
```

All package commands below should run from `packages/pi-arc`:

```bash
cd packages/pi-arc
```

If no path is provided, you may try the migration script default, but verify it before using it; in monorepo checkouts an explicit source path is usually clearer.

Expand `~` and verify the source looks like the Claude Arc plugin:

```bash
test -d "$SOURCE/commands"
test -d "$SOURCE/skills"
test -d "$SOURCE/agents"
test -f "$SOURCE/.claude-plugin/plugin.json"
```

Stop and ask the user for the correct path if these checks fail.

## 2. Check Local and Source State

Before running the migration script, understand both repositories.

In the repository root and then in `packages/pi-arc` context:

```bash
git status --short
cd packages/pi-arc
```

If unrelated local changes exist, pause and ask before proceeding. The generator rewrites `prompts/`, `skills/`, and `agents/`.

In the source checkout:

```bash
git -C "$SOURCE" status --short
git -C "$SOURCE" log --oneline -5
find "$SOURCE/commands" "$SOURCE/skills" "$SOURCE/agents" -maxdepth 2 -type f | sort
```

Note which upstream files changed and whether they affect prompts, workflow skills, specialist agents, docs, or Claude-only plugin metadata.

## 3. Regenerate Mechanical Resources

From `packages/pi-arc`, run the migration script with the resolved source path:

```bash
python3 scripts/migrate-arc-plugin.py "$SOURCE"
```

If using the default source, this is also valid:

```bash
python3 scripts/migrate-arc-plugin.py
```

The script should regenerate only generated Arc resource directories and print the resolved source path.

## 4. Review and Classify the Diff

Inspect the resulting changes from multiple angles:

```bash
git diff --stat -- prompts skills agents scripts/migrate-arc-plugin.py README.md extensions/arc.ts tests
git diff --name-status -- prompts skills agents scripts/migrate-arc-plugin.py README.md extensions/arc.ts tests
git diff -- prompts skills agents scripts/migrate-arc-plugin.py README.md extensions/arc.ts tests
```

Classify each change:

- **Directly portable** — source wording or behavior applies to Pi after existing migration transforms.
- **Needs Pi adaptation** — concept applies, but tool names, commands, paths, models, or orchestration need Pi wording.
- **Claude-only / not applicable** — depends on Claude-specific hooks, commands, persistent teams, or tools without Pi equivalents.

Pi behavior to preserve:

- Hyphenated prompt names like `/arc-create`, not colon-form Arc command names.
- Collision-safe skill names like `arc-build`, not bare `build`.
- Bundled `@juicesharp/rpiv-ask-user-question` provides `ask_user_question`; preserve the snake_case tool name, the package `questions[]` schema, package-provided `Type something.` / `Chat about this` escape-hatch guidance, JSON `questions[]` examples in brainstorm/plan, and `(Recommended)` option convention.
- Bundled `todo` checklist guidance, not Claude checklist/task tool names.
- `arc_agent` fallback semantics plus preferred Arc `pi-subagents` definitions when available.
- Arc `modelProfiles` guidance and auto-materialized Arc `pi-subagents` specialists; `/arc-subagents-sync` is deprecated repair/backcompat, not the primary setup path.
- Parallel readiness contract: brainstorm/plan keep `## Parallel Readiness`, `### T0 Foundation Decision`, `### File Ownership Matrix`, `### Parallel Batch Manifest`, and `### Validation Matrix`; build consumes the manifest and applies one patch at a time.
- Review-only code-reviewer dispatch prompt: it must say `Review only; return findings only. Do not edit files.` and must not contain wording that asks the reviewer to edit, fix, patch, or apply changes directly.
- Issue-manager bulk creation remains phased: create epic, create all child tasks, capture IDs, apply dependencies only after all child IDs exist, apply labels after dependencies, and report `## Timing`.
- Optional supervisor escalation sections remain in bundled agents without adding a `pi-intercom` dependency.
- Protected-branch checks use Pi/AGENTS.md wording and the bundled `ask_user_question` package, even when upstream mentions Claude-specific files/tools.
- No Claude-style team deployment unless a Pi-native implementation exists.
- Release Please-managed `package.json`, `package-lock.json`, `CHANGELOG.md`, and npm metadata.

## 5. Adapt Pi-Specific Patches

If upstream changed a section that `scripts/migrate-arc-plugin.py` patches, update the script patch text so future syncs remain reproducible. Do not hand-edit generated files in a way that will be lost on the next migration unless the migration script is updated to reproduce it.

Use this adaptation loop:

1. Run `npm test` early after the first regeneration. Failing tests usually identify Pi contracts that the upstream source overwrote.
2. For each failing contract, inspect the generated file and the old version (`git show HEAD:<path>` is useful) to determine whether the upstream change is portable, needs Pi adaptation, or should be rejected.
3. Update `scripts/migrate-arc-plugin.py` with the smallest reproducible transform/overlay that preserves the Pi contract while still allowing portable upstream wording through.
4. Re-run `python3 scripts/migrate-arc-plugin.py "$SOURCE"` after every migration-script edit.
5. Re-run `npm test`. Repeat until tests pass without weakening tests for existing Pi behavior.
6. Once the diff looks right, prove the generator is deterministic by comparing the diff before and after one final regeneration:

   ```bash
   git diff > /tmp/pi-arc-sync.before.diff
   python3 scripts/migrate-arc-plugin.py "$SOURCE"
   git diff > /tmp/pi-arc-sync.after.diff
   diff -u /tmp/pi-arc-sync.before.diff /tmp/pi-arc-sync.after.diff
   ```

   The final `diff` should be empty. If it is not, fix the migration script or generated outputs until a re-run is stable.

If the upstream change adds a new command, skill, or agent:

1. Add or update the mapping in `scripts/migrate-arc-plugin.py`.
2. Decide whether it should be packaged for Pi.
3. Add Pi-specific exclusions for Claude-only workflows.
4. Update README/tests if the public or maintainer surface changes.

Only update tests when the intended Pi contract has genuinely changed. Do not update tests just to make a lossy migration pass.

## 6. Verification

Run these checks before claiming the sync is complete:

```bash
cd packages/pi-arc
python3 scripts/migrate-arc-plugin.py --help
git diff --check
npm test
npm run pack:dry-run
rg '/arc[:]' skills prompts
rg 'Task(Create)|Todo(Write)|Ask(UserQuestion)|Claude[ ]Code' skills prompts
```

The `rg` checks should return no unintended leftovers. If matches are intentional source terms in this maintainer skill or docs, call that out explicitly.

Also run a final status check:

```bash
git status --short
git diff --stat
```

## 7. Commit, Push, and Handoff

This repository requires landed work, not local-only changes. After verification passes:

```bash
git add <changed-files>
git commit -m "chore(pi-arc): sync arc workflow resources"
git push
git status --short --branch   # must show branch up to date with origin
git worktree list             # confirm no stray sync worktrees
arc prime                     # refresh handoff context when arc is configured
```

If push fails, resolve and retry until it succeeds. Do not tell the user "ready to push"; push it.

## 8. Report Back

Summarize:

- Source path and source commit/branch used.
- Upstream changes that were ported.
- Changes intentionally skipped as Claude-only or not applicable.
- Pi-specific adaptations made.
- Verification commands and results.
- Commit hash pushed and final `git status --short --branch` result.
- Any follow-up issues discovered.
