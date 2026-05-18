# Pi Arc Package

> Monorepo location: this package lives at `packages/pi-arc` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-arc` and load it locally with `pi -e ./packages/pi-arc`.

Arc issue tracker integration for [Pi](https://pi.dev): packaged Arc skills, prompt templates, session context injection, workflow command aliases, bundled checklist support via `@juicesharp/rpiv-todo`, and optional Arc specialist integration with `pi-subagents`.

This package is a Pi-native port of the Claude Code Arc plugin at https://github.com/sentiolabs/arc

## What is included

- **Prompt templates** for common Arc CLI workflows:
  - `/arc-create`
  - `/arc-list`
  - `/arc-ready`
  - `/arc-show`
  - `/arc-update`
  - `/arc-close`
  - `/arc-docs`
  - and more under `prompts/`
- **Skills** for Arc workflows:
  - `/skill:arc` — general Arc reference
  - `/skill:arc-brainstorm`
  - `/skill:arc-plan`
  - `/skill:arc-build`
  - `/skill:arc-debug`
  - `/skill:arc-review`
  - `/skill:arc-verify`
  - `/skill:arc-finish`
- **Extension commands**:
  - `/arc-onboard` — run `arc onboard`
  - `/arc-which` — run `arc which`
  - `/arc-prime` — show cached `arc prime` context
  - `/arc-refresh` — refresh cached `arc prime` context
  - `/arc-plan`, `/arc-build`, `/arc-review`, etc. — friendly aliases for the corresponding skills
- **Auto-materialized Arc specialists for `pi-subagents`**:
  - `@sentiolabs/pi-arc` writes generated `arc-*` agent files into pi-subagents user discovery scope on session start.
  - Users do not need to run `/arc-subagents-sync` after install.
  - `/arc-subagents-sync` is deprecated for normal activation and remains a repair/backcompat command.
- **Session context injection**:
  - On session start, the extension runs `arc prime` and injects its output into the system prompt as `<arc-context>`.
  - Before compaction, the extension refreshes `arc prime`.
- **Bundled `@juicesharp/rpiv-todo` integration** (auto-installed + auto-loaded):
  - `todo` tool for managing in-session checklist items.
  - `/todos` command for a quick checklist view/workflow.
  - Persistent overlay widget for visible, session-level task progress.
- **Bundled `@juicesharp/rpiv-ask-user-question` integration** (auto-installed + auto-loaded):
  - Provides the `ask_user_question` tool for Arc workflow decisions using the package `questions[]` schema.
  - Supports multi-question dialogs, single-select and multi-select questions, optional per-option previews, and per-option notes.
  - Preserves package-provided escape hatches where supported, including `Type something.` for custom text and `Chat about this` for returning to free-form conversation.
  - Arc docs should not manually author reserved sentinel labels such as `Type something.`, `Chat about this`, `Other`, or `Next` as normal options.
  - When Arc recommends an option, list it first, append `(Recommended)` to the label, and explain why in the description.
- **`arc_agent` tool**:
  - Runs bundled Arc specialist prompts from `agents/*.md` in fresh Pi subprocesses.
  - Supports `coder`, `code-reviewer`, `doc-writer`, `evaluator`, `issue-manager`, and `spec-reviewer`.
  - Resolves Arc model tiers (`small`, `standard`, `large`) to concrete Pi models so orchestrators can right-size subagent dispatches.
  - Current limitation: `isolation: "worktree"` is recognized but not implemented yet.
- **Optional `pi-subagents` companion support**:
  - `@sentiolabs/pi-arc` auto-materializes Arc specialist definitions for any installed `pi-subagents` provider, but does not bundle or load the `subagent` tool itself.
  - Install `pi-subagents` once if you want async/background runs, chains, or worktree-isolated parallel Arc batches: `pi install npm:pi-subagents`.
  - If `pi-subagents` is unavailable, Arc workflows fall back to the bundled sequential `arc_agent` tool.

## Prerequisites

- Pi installed.
- The `arc` CLI available on `PATH`.
- An Arc project initialized or registered for the working directory:

```bash
arc init
# or
arc onboard
```

The package fails gracefully when `arc` is unavailable or the current directory is not an Arc project.

## Install from npmjs.org

`@sentiolabs/pi-arc` is published publicly on npmjs.org, so npm installs do not require GitHub Packages registry configuration or a GitHub token.

Install globally through Pi:

```bash
pi install npm:@sentiolabs/pi-arc
```

Install into the current project's `.pi/settings.json` instead of global settings:

```bash
pi install -l npm:@sentiolabs/pi-arc
```

Pin to a released version:

```bash
pi install npm:@sentiolabs/pi-arc@0.10.0
```

Test without installing permanently:

```bash
pi -e npm:@sentiolabs/pi-arc
```

## Install from git

Git installs are supported for source checkouts and unreleased refs:

```bash
pi install git:git@github.com:sentiolabs/pi-arc
pi install git:git@github.com:sentiolabs/pi-arc@main
pi install git:git@github.com:sentiolabs/pi-arc@v0.10.0
```

HTTPS works too if your Git credentials are configured:

```bash
pi install https://github.com/sentiolabs/pi-arc
```

## Install locally

From a local checkout:

```bash
pi install -l .
```

Use temporary installation for testing:

```bash
pi -e .
```

## Usage

Start Pi in an Arc-enabled project and run:

```text
/arc-onboard
/arc-ready
/arc-create "Fix login bug" --type bug --priority 1
/arc-show <issue-id>
/arc-brainstorm
/arc-plan docs/plans/<file>.md
/arc-build <epic-id>
/arc-finish
```

You can also invoke skills directly:

```text
/skill:arc
/skill:arc-plan
/skill:arc-build
```

## Arc vs `todo` boundary

Use Arc for persistent, auditable issue tracking across sessions (`arc create`, `arc update`, dependencies, plan shares, and closure history). Use bundled `rpiv-todo` (`todo` tool + `/todos` + overlay) for visible, in-session checklists while you execute the current workflow.

## Plan review surfaces

`/skill:arc-brainstorm` writes design docs under `docs/plans/` and asks how to register them for review:

- Legacy local planner: `arc plan create <file>` for a simple local-only comment thread.
- Encrypted local share: `arc share create <file>` for encrypted local review with annotations.
- Encrypted remote share: `arc share create <file> --remote` for reviewers on other machines.

The brainstorm skill writes a first-line marker like `<!-- arc-review: kind=share-remote id=<id> -->`; `/skill:arc-plan` reads that marker to choose the matching `arc plan` or `arc share` commands.

## Arc model profiles

Use `/arc-models` to configure Arc's recommended Pi model and thinking level per workflow role. Arc stores profile preferences at `${XDG_CONFIG_HOME:-~/.config}/pi-arc/models.json`, with top-level `modelProfiles`.

Profile keys map directly to the workflow roles: `brainstorm`, `plan`, `issueManager`, `coder`, `codeReviewer`, `docWriter`, `specReviewer`, and `evaluator`.

```json
{
  "version": 1,
  "modelProfiles": {
    "brainstorm": {
      "model": "openai-codex/gpt-5.5",
      "thinking": "high"
    },
    "issueManager": {
      "model": "openai-codex/gpt-5.4-mini",
      "thinking": "off"
    },
    "coder": {
      "model": "openai-codex/gpt-5.3-codex",
      "thinking": "medium"
    },
    "codeReviewer": {
      "model": "openai-codex/gpt-5.5",
      "thinking": "high"
    }
  }
}
```

`/arc-models` lists only models returned by Pi's active model registry. If a configured model is unavailable, it prompts you to choose a replacement before saving.

The same `modelProfiles` shape works for `plan`, `docWriter`, `specReviewer`, and `evaluator` profiles.

Legacy `arc.modelTiers` settings in `~/.pi/agent/settings.json` or project `.pi/settings.json` remain supported as a compatibility fallback, but new configuration should use `/arc-models` and `modelProfiles`.

<!-- Legacy section marker retained for older checks: ## Sync Arc specialists -->
## Arc specialists in pi-subagents

Arc writes generated specialists to `~/.agents/` by default. Legacy user scope `~/.pi/agent/agents/` is reserved for compatibility. Project `.pi/agents/arc-*.md` files have higher precedence and can shadow fresh user-scope files; if Arc warns about a shadow, inspect or remove the project-local generated file intentionally.

`@sentiolabs/pi-arc` does not bundle or load `pi-subagents`; install `pi-subagents` separately when you want the `subagent` tool. The Arc extension still auto-materializes Arc specialists into pi-subagents user scope, so `/arc-subagents-sync` is deprecated for normal activation and remains only a repair/backcompat command.

Generated specialists include:

- `arc-coder`
- `arc-doc-writer`
- `arc-spec-reviewer`
- `arc-code-reviewer`
- `arc-evaluator`
- `arc-issue-manager`

Install `pi-subagents` as a normal Pi package if you want these specialists available through the `subagent` tool:

```bash
pi install npm:pi-subagents
```

Existing standalone installs under `~/.pi/agent/extensions/subagent` also work. Because `@sentiolabs/pi-arc` no longer loads its own copy, project-local Arc installs should not conflict with a global `subagent` tool.

For repair/backcompat only, `/arc-subagents-sync project` can explicitly refresh legacy project-scope generated files under `<cwd>/.pi/agents/`; normal activation writes user-scope files automatically.

The `issue-manager` agent uses the issueManager profile (recommended gpt-5.4-mini with thinking off) and stays phased: create the epic first, then child tasks next, then dependencies/labels after all IDs exist. It prints phase-level timing/progress lines for bulk issue creation. This is sequencing only; true parallel issue creation is not enabled yet.

Generated files include a marker comment so reruns can safely update Arc-managed files while preserving manual edits in user-authored files.

<!-- Legacy test phrase: After syncing, verify agent registration -->
To confirm installed/discovered agents, use:

```text
subagent({ action: "list" })
/agents
```

Use `/subagents-status` to monitor active/recent async Arc specialist runs after launch. It does not list idle installed agents.

For Arc gates (especially spec compliance), use Arc specialists (`arc-spec-reviewer`, etc.) instead of generic `worker`/`reviewer` agents.

- Keep `arc_agent` as the self-contained fallback when Arc `pi-subagents` definitions are unavailable.
- Claude-style team deployment is intentionally not ported to Pi.

## Execution lanes

- Sequential Arc build: use when tasks overlap, dependencies are linear, or `pi-subagents` is unavailable.
- Parallel Arc batch: use when `/arc-plan` provides a T0 foundation, file ownership matrix, parallel batch manifest, and validation matrix.
- Ant Colony: future/optional lane for large exploratory work; not a replacement for Arc gates in this iteration.

## Naming differences from the Claude plugin

Claude plugin commands used names like `/arc:create`. Pi prompt templates are filename-based, so this package uses hyphenated names:

| Claude plugin | Pi package |
|---|---|
| `/arc:create` | `/arc-create` |
| `/arc:list` | `/arc-list` |
| `/arc:ready` | `/arc-ready` |
| `/arc:show` | `/arc-show` |
| `/arc:plan` | `/arc-plan` or `/skill:arc-plan` |
| `/arc:build` | `/arc-build` or `/skill:arc-build` |

## Current implementation status

Implemented:

- Pi package manifest
- Prompt template migration with `/arc-*` names
- Skill migration with collision-safe `arc-*` skill names
- Arc context extension (`arc prime` cache + system prompt injection)
- Workflow command aliases
- Bundled agent prompt references under `agents/`
- Bundled `@juicesharp/rpiv-ask-user-question` package for interactive workflow decisions
- Pi-native `arc_agent` custom tool for sequential subagent execution
- Auto-materialized Arc specialists in pi-subagents user scope; `/arc-subagents-sync` is deprecated repair/backcompat only
- Optional `pi-subagents` integration for worktree-isolated evaluator runs, independent parallel coder batches, and phased issue-manager creation

Not yet implemented:

- Native `arc_agent` worktree isolation for parallel Arc coders.
- Arc issue autocomplete in the Pi editor.

Intentionally not ported:

- Claude-style team deployment. Pi does not provide Claude's persistent team/task primitives.

## Development

Install package dependencies without auto-installing Pi peer dependencies:

```bash
npm ci
```

Run tests and inspect the publish tarball:

```bash
npm test
npm run pack:dry-run
```

### Maintainer source sync

Source checkouts of the `pi-nexus` monorepo include a repo-local maintainer skill at `.pi/skills/arc-source-sync/SKILL.md` for syncing Pi resources from the Claude Arc plugin source while preserving Pi-specific behavior. This maintainer skill is intentionally not shipped in the `@sentiolabs/pi-arc` package.

Use the repo-local skill when asking an agent to evaluate and apply upstream changes:

```text
/skill:arc-source-sync ~/devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/arc
```

Regenerate migrated resources directly from the default source path:

```bash
python3 scripts/migrate-arc-plugin.py
```

Or pass an explicit Claude Arc plugin source path:

```bash
python3 scripts/migrate-arc-plugin.py ~/foo/bar/arc
python3 scripts/migrate-arc-plugin.py --source ~/foo/bar/arc
```

Smoke test in Pi:

```bash
PI_OFFLINE=1 pi -e . --list-models
```

Useful checks:

```bash
rg '/arc:' skills prompts
rg 'TaskCreate|TodoWrite|AskUserQuestion|Claude Code' skills prompts
```

## Release process

Release Please manages `package.json`, `package-lock.json`, Git tags, GitHub releases, and `CHANGELOG.md`. The first official release is bootstrapped to `v0.1.0`.

Use Conventional Commits on `main` so Release Please can determine the next version:

```text
feat: add an Arc workflow capability
fix: correct an Arc command edge case
```

When a Release Please PR is merged, `.github/workflows/release-please.yml` creates the GitHub release and publishes the package to npmjs.org using npm Trusted Publishing (OIDC) with provenance.

Before the first automated npm release, configure npm Trusted Publishing for the package:

- Package: `@sentiolabs/pi-arc`
- Publisher: GitHub Actions
- Repository owner/user: `SentioLabs`
- Repository: `pi-arc`
- Workflow filename: `release-please.yml`
- Environment: leave blank unless a GitHub Environment is intentionally required

npm Trusted Publishing requires an existing package to configure from package settings. If `@sentiolabs/pi-arc` has not been published before, publish a one-time public `0.0.0` bootstrap version or configure the trusted publisher with `npm trust` after the package exists, then let Release Please publish the first official `v0.1.0` release.
