---
name: arc-source-sync
description: Maintainer-only workflow for syncing this pi-arc package from the Claude Arc plugin source. Use when the user asks to sync, port, migrate, or apply changes from agent-nexus/claude-marketplace/plugins/arc or another Arc plugin source checkout. Always prefer this over ad-hoc copying when maintaining pi-arc resources.
---

# Arc Source Sync — Maintainer Workflow

Synchronize the Pi Arc package with changes from the Claude Arc plugin source while preserving Pi-native behavior.

This is a **maintainer-only** workflow for this repository. Run it from a `pi-arc` source checkout where `scripts/migrate-arc-plugin.py` exists; it is not part of the normal end-user Arc issue workflow.

## Core Rule

**Never blindly copy upstream files.** Regenerate mechanical resources, inspect the diff, then adapt only the changes that make sense for Pi.

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
/arc-source-sync ~/devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/arc
/skill:arc-source-sync ~/foo/bar/arc
```

If no path is provided, use the migration script default:

```bash
../agent-nexus/claude-marketplace/plugins/arc
```

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

In `pi-arc`:

```bash
git status --short
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

Run the migration script with the resolved source path:

```bash
python3 scripts/migrate-arc-plugin.py "$SOURCE"
```

If using the default source, this is also valid:

```bash
python3 scripts/migrate-arc-plugin.py
```

The script should regenerate only generated Arc resource directories and print the resolved source path.

## 4. Review and Classify the Diff

Inspect the resulting changes:

```bash
git diff -- prompts skills agents scripts/migrate-arc-plugin.py README.md extensions/arc.ts tests
```

Classify each change:

- **Directly portable** — source wording or behavior applies to Pi after existing migration transforms.
- **Needs Pi adaptation** — concept applies, but tool names, commands, paths, models, or orchestration need Pi wording.
- **Claude-only / not applicable** — depends on Claude-specific hooks, commands, persistent teams, or tools without Pi equivalents.

Pi behavior to preserve:

- Hyphenated prompt names like `/arc-create`, not colon-form Arc command names.
- Collision-safe skill names like `arc-build`, not bare `build`.
- Bundled `@juicesharp/rpiv-ask-user-question` provides `ask_user_question`; preserve the snake_case tool name, the package `questions[]` schema, package-provided `Type something.` / `Chat about this` escape-hatch guidance, and `(Recommended)` option convention.
- Bundled `todo` checklist guidance, not Claude checklist/task tool names.
- `arc_agent` fallback semantics plus preferred Arc `pi-subagents` definitions when available.
- No Claude-style team deployment unless a Pi-native implementation exists.
- Release Please-managed `package.json`, `package-lock.json`, `CHANGELOG.md`, and npm metadata.

## 5. Adapt Pi-Specific Patches

If upstream changed a section that `scripts/migrate-arc-plugin.py` patches, update the script patch text so future syncs remain reproducible. Do not hand-edit generated files in a way that will be lost on the next migration unless the migration script is updated to reproduce it.

If the upstream change adds a new command, skill, or agent:

1. Add or update the mapping in `scripts/migrate-arc-plugin.py`.
2. Decide whether it should be packaged for Pi.
3. Add Pi-specific exclusions for Claude-only workflows.
4. Update README/tests if the public or maintainer surface changes.

## 6. Verification

Run these checks before claiming the sync is complete:

```bash
python3 scripts/migrate-arc-plugin.py --help
npm test
npm run pack:dry-run
rg '/arc[:]' skills prompts
rg 'Task(Create)|Todo(Write)|Ask(UserQuestion)|Claude[ ]Code' skills prompts
```

The `rg` checks should return no unintended leftovers. If matches are intentional source terms in this maintainer skill or docs, call that out explicitly.

## 7. Report Back

Summarize:

- Source path and source commit/branch used.
- Upstream changes that were ported.
- Changes intentionally skipped as Claude-only or not applicable.
- Pi-specific adaptations made.
- Verification commands and results.
- Any follow-up issues discovered.
