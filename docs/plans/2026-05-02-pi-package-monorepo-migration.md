<!-- arc-review: kind=legacy id=plan.04y435 -->
# Pi Package Monorepo Migration

## Context and Decisions

This design migrates the standalone `../pi-arc` package into the current repository as the first package in a new Pi package monorepo.

Observed context:

- Current repo: `/home/bfirestone/devspace/personal/sentiolabs/pi-nexus`
  - Clean, no commits yet.
  - Contains `AGENTS.md` and `CLAUDE.md` only before this plan.
  - Arc has no existing issues.
- Source package: `../pi-arc`
  - Published package name: `@sentiolabs/pi-arc`.
  - Current version: `0.7.0`.
  - Contains Pi `skills`, `prompts`, `extensions`, Arc specialist `agents`, tests, GitHub Actions, Release Please config, README, changelog, and license.
  - Bundles `@juicesharp/rpiv-todo`, `@juicesharp/rpiv-ask-user-question`, and `pi-subagents` through `dependencies` + `bundledDependencies`.
- Reference only: `/home/bfirestone/devspace/personal/github/rpiv-mono`
  - Use its `packages/*` workspace layout, package table README style, root tooling shape, and `repository.directory` metadata pattern as references.
  - Do not copy its lockstep release model or package code.

User decisions:

- Use the **current cwd** as the new monorepo root.
- Use **independent package releases**, not lockstep versions.
- Use **Release Please + npm provenance** for CI/CD.
- Create/preserve **root + package docs**; do not do a full historical `docs/plans` copy in the first pass.
- Use the **workspace migration** approach.

## Goals

- Create a private npm workspace monorepo at the current repo root.
- Move `@sentiolabs/pi-arc` to `packages/pi-arc` without changing runtime behavior.
- Preserve package install behavior for Pi:
  - `pi install npm:@sentiolabs/pi-arc`
  - `pi -e ./packages/pi-arc`
- Adapt CI to test and pack workspace packages from the repo root.
- Adapt Release Please for independent per-package releases.
- Publish released packages to npmjs.org with provenance from GitHub Actions.
- Add root-level docs explaining the monorepo and package development workflow.

## Non-goals

- Do not migrate `pi-slop` or `pi-frontend-design` yet; reserve structure for them.
- Do not copy `rpiv-mono` package implementations.
- Do not adopt `rpiv-mono` lockstep versioning.
- Do not change Arc runtime features while moving files.
- Do not publish from CI until the GitHub remote URL is verified and package metadata matches it exactly.
- Do not migrate historical `../pi-arc/docs/plans/*` in the first pass unless a later review explicitly requests it.

## Approaches Considered

| Approach | Summary | Trade-offs | Model tier implication |
|---|---|---|---|
| Workspace migration | Move `pi-arc` into `packages/pi-arc`, add root workspaces, workspace-aware CI, and per-package Release Please. | Best balance of clean repo shape and controlled scope. | Medium; decomposes into small/standard tasks. |
| Minimal lift-and-shift | Copy `pi-arc` mostly intact under `packages/pi-arc` with minimal root wrapper. | Fast, but release/docs cleanup is deferred and future packages inherit ambiguity. | Small; mostly mechanical. |
| Full platform setup | Build an `rpiv-mono`-style platform with shared scripts and stricter tooling now. | More complete, but risks overfitting and importing lockstep assumptions. | Medium/large; more cross-cutting review. |

Recommendation: **Workspace migration**.

## Proposed Repository Layout

```text
pi-nexus/
  .github/
    workflows/
      ci.yml
      release-please.yml
  .npmrc
  .release-please-manifest.json
  AGENTS.md
  CLAUDE.md
  LICENSE
  README.md
  docs/
    development.md
    releasing.md
    packages/
      pi-arc.md
    plans/
      2026-05-02-pi-package-monorepo-migration.md
  package-lock.json
  package.json
  packages/
    pi-arc/
      agents/
      extensions/
      prompts/
      skills/
      scripts/
      tests/
      CHANGELOG.md
      LICENSE
      README.md
      package.json
  release-please-config.json
  tests/
    workspace-contract.test.mjs
```

Future package slots:

```text
packages/pi-slop/
packages/pi-frontend-design/
```

Those directories should not be created until their package sources exist.

## `packages/pi-arc` Migration

Copy these from `../pi-arc` into `packages/pi-arc`:

- `agents/`
- `extensions/`
- `prompts/`
- `skills/`
- `scripts/`
- `tests/`
- `CHANGELOG.md`
- `LICENSE`
- `README.md`, updated only for monorepo paths and links
- `package.json`, updated by the T0 foundation task below

Do not copy these from `../pi-arc` into `packages/pi-arc`:

- `.git/`
- `.github/`
- `.pi/`
- `.npmrc`
- `.release-please-manifest.json`
- root `release-please-config.json`
- root `package-lock.json`
- old `docs/plans/*` historical design artifacts

Package metadata changes:

- Keep `name: "@sentiolabs/pi-arc"`.
- Keep `version: "0.7.0"` during migration.
- Update `engines.node` to `>=24.0.0` to match Pi package policy and CI.
- Preserve `dependencies`, `bundledDependencies`, `peerDependencies`, `peerDependenciesMeta`, `files`, and `pi` manifest entries.
- Update `repository.url`, `repository.directory`, `homepage`, and `bugs.url` for the new monorepo.

> Important: npm provenance requires the package repository URL to match the actual GitHub repository URL and case exactly. The implementation must verify `git remote get-url origin` before finalizing `repository.url` or enabling publish.

## Root Workspace Tooling

The root is private and owns shared workspace commands. Package code remains package-local.

Shared root commands:

- `npm install` installs all workspaces and creates the root `package-lock.json`.
- `npm test` runs package tests with `--workspaces --if-present`.
- `npm run pack:dry-run` runs package pack checks with `--workspaces --if-present`.
- `npm run check` runs contract tests, package tests, and package dry-run packs.

No TypeScript or Biome gate is required in the first pass because `../pi-arc` currently validates with Node's built-in test runner and package dry-run checks. A later issue can add shared lint/type tooling when multiple packages need it.

## CI/CD and Release Please

### CI

Adapt `../pi-arc/.github/workflows/ci.yml` to run at the monorepo root:

- Trigger on pull requests and pushes to `main`.
- Use Node `24`.
- Set `NPM_CONFIG_LEGACY_PEER_DEPS=true` because Pi peer dependencies are optional and not installable from npm in the normal way.
- Run:
  - `npm ci`
  - `npm run check`

### Release Please

Adapt `../pi-arc/release-please-config.json` from package path `.` to `packages/pi-arc`.

Use independent package tags by setting:

- `include-component-in-tag: true`
- `component: "pi-arc"`
- manifest entry: `"packages/pi-arc": "0.7.0"`

Initial package map:

```json
{
  "packages/pi-arc": "@sentiolabs/pi-arc"
}
```

Future packages get their own entries without forcing a `pi-arc` release.

### npm publish

The release workflow should publish only packages that Release Please released.

For the first pass, `release-please.yml` can publish `@sentiolabs/pi-arc` when `packages/pi-arc` has a release. As more packages are added, replace the package-specific publish step with a small `scripts/publish-released-workspaces.mjs` helper that maps Release Please released paths to npm workspace names.

Publish command shape:

```bash
npm publish --workspace @sentiolabs/pi-arc --access public --provenance
```

## Documentation Plan

Root docs:

- `README.md`
  - Explain this is the `@sentiolabs/pi-*` monorepo.
  - List packages in a table.
  - Link to `packages/pi-arc`.
  - Document root install/test/check commands.
- `docs/development.md`
  - Local setup.
  - Workspace commands.
  - How to test package installs locally with `pi -e ./packages/pi-arc`.
- `docs/releasing.md`
  - Independent Release Please model.
  - npm provenance requirement.
  - How package metadata must match GitHub remote URL case exactly.
- `docs/packages/pi-arc.md`
  - Short package-specific overview pointing to `packages/pi-arc/README.md`.

Package docs:

- Preserve and update `packages/pi-arc/README.md`.
- Preserve `packages/pi-arc/CHANGELOG.md`.
- Preserve `packages/pi-arc/LICENSE`.

Historical `../pi-arc/docs/plans/*` are intentionally not copied in the first pass. If one is still active, create a follow-up issue to archive or migrate it explicitly.

## Migration Steps

1. **T0 workspace foundation**
   - Add root workspace config.
   - Add root `.npmrc`.
   - Add Release Please config and manifest for `packages/pi-arc`.
   - Add root contract tests.
   - Add adapted `packages/pi-arc/package.json` metadata.
2. **Copy package content**
   - Copy package runtime/test assets from `../pi-arc` into `packages/pi-arc`.
   - Exclude standalone repo files that now belong at monorepo root.
3. **Add CI/CD workflows**
   - Add root `.github/workflows/ci.yml`.
   - Add root `.github/workflows/release-please.yml`.
4. **Add docs**
   - Add root README and docs.
   - Update package README paths/links.
5. **Install and validate**
   - Run `npm install` at root.
   - Run root checks.
   - Verify package contents with dry-run pack.
   - Verify local Pi package loading.
6. **Commit/push**
   - Commit and push after validation per project completion protocol.

## Validation

Required checks before claiming migration complete:

```bash
npm install
npm run check
npm run pack:dry-run --workspace @sentiolabs/pi-arc
pi -e ./packages/pi-arc --help
```

Additional metadata checks:

```bash
node --test tests/workspace-contract.test.mjs
npm pack --workspace @sentiolabs/pi-arc --dry-run
```

Release safety checks before enabling publish:

```bash
git remote get-url origin
npm publish --workspace @sentiolabs/pi-arc --access public --dry-run
```

Do not run a real publish unless Release Please created a release in GitHub Actions and the repository metadata URL matches the GitHub repo exactly.

## Parallel Readiness

### T0 Foundation Decision

Create a sequential T0 foundation task before any parallel implementation. T0 owns the shared workspace and release contracts that later package, CI, and docs tasks reference.

T0 writes these files first:

- `package.json`
- `.npmrc`
- `.gitignore`
- `release-please-config.json`
- `.release-please-manifest.json`
- `tests/workspace-contract.test.mjs`
- `packages/pi-arc/package.json`

Shared contract: root `package.json`:

```json
{
  "name": "pi-nexus",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "npm@11.12.1",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "pack:dry-run": "npm run pack:dry-run --workspaces --if-present",
    "check": "node --test tests/*.test.mjs && npm test && npm run pack:dry-run"
  }
}
```

Shared contract: root `.npmrc`:

```text
legacy-peer-deps=true
```

Shared contract: root `release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": true,
  "separate-pull-requests": true,
  "packages": {
    "packages/pi-arc": {
      "component": "pi-arc",
      "package-name": "@sentiolabs/pi-arc",
      "release-type": "node",
      "initial-version": "0.1.0",
      "changelog-path": "CHANGELOG.md"
    }
  }
}
```

Shared contract: root `.release-please-manifest.json`:

```json
{
  "packages/pi-arc": "0.7.0"
}
```

Shared contract: adapted `packages/pi-arc/package.json` metadata. The `repository.url` below is a placeholder contract and must be replaced with the exact `origin` URL/case before publishing.

```json
{
  "name": "@sentiolabs/pi-arc",
  "version": "0.7.0",
  "description": "Arc issue tracker integration for Pi.",
  "keywords": [
    "pi-package",
    "arc",
    "issue-tracker",
    "agent-memory",
    "ai-workflow"
  ],
  "license": "MIT",
  "author": {
    "name": "Sentio Labs",
    "url": "https://github.com/sentiolabs"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/SentioLabs/pi-nexus.git",
    "directory": "packages/pi-arc"
  },
  "homepage": "https://github.com/SentioLabs/pi-nexus/tree/main/packages/pi-arc#readme",
  "bugs": {
    "url": "https://github.com/SentioLabs/pi-nexus/issues"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "pack:dry-run": "npm pack --dry-run",
    "prepublishOnly": "npm test && npm run pack:dry-run"
  },
  "files": [
    "agents/",
    "extensions/",
    "prompts/",
    "skills/",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "publishConfig": {
    "access": "public"
  },
  "dependencies": {
    "@juicesharp/rpiv-ask-user-question": "^1.0.14",
    "@juicesharp/rpiv-todo": "^0.12.5",
    "pi-subagents": "^0.23.0"
  },
  "bundledDependencies": [
    "@juicesharp/rpiv-todo",
    "@juicesharp/rpiv-ask-user-question",
    "pi-subagents"
  ],
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "typebox": "*"
  },
  "peerDependenciesMeta": {
    "@mariozechner/pi-ai": {
      "optional": true
    },
    "@mariozechner/pi-coding-agent": {
      "optional": true
    },
    "@mariozechner/pi-tui": {
      "optional": true
    },
    "typebox": {
      "optional": true
    }
  },
  "pi": {
    "skills": [
      "./skills",
      "./node_modules/pi-subagents/skills"
    ],
    "prompts": [
      "./prompts/*.md",
      "./node_modules/pi-subagents/prompts"
    ],
    "extensions": [
      "./extensions/*.ts",
      "./node_modules/@juicesharp/rpiv-todo/index.ts",
      "./node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
      "./node_modules/pi-subagents/src/extension/index.ts"
    ]
  }
}
```

Contract test assertions: `tests/workspace-contract.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("root package declares private npm workspaces", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.workspaces, ["packages/*"]);
  assert.equal(pkg.engines.node, ">=24.0.0");
});

test("release-please tracks pi-arc as an independent package", () => {
  const config = readJson("release-please-config.json");
  const manifest = readJson(".release-please-manifest.json");
  const piArc = config.packages["packages/pi-arc"];

  assert.ok(piArc);
  assert.equal(piArc.component, "pi-arc");
  assert.equal(piArc["package-name"], "@sentiolabs/pi-arc");
  assert.equal(manifest["packages/pi-arc"], "0.7.0");
});

test("pi-arc package metadata points at the workspace package", () => {
  const pkg = readJson("packages/pi-arc/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-arc");
  assert.equal(pkg.version, "0.7.0");
  assert.equal(pkg.repository.directory, "packages/pi-arc");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-todo"));
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-ask-user-question"));
  assert.ok(pkg.bundledDependencies.includes("pi-subagents"));
});
```

### File Ownership Matrix

| Task | Files/directories owned | Notes |
|---|---|---|
| T0 workspace foundation | `package.json`, `.npmrc`, `.gitignore`, `release-please-config.json`, `.release-please-manifest.json`, `tests/workspace-contract.test.mjs`, `packages/pi-arc/package.json` | Must land first. Verifies repo/package/release contracts. |
| T1 package content migration | `packages/pi-arc/agents/**`, `packages/pi-arc/extensions/**`, `packages/pi-arc/prompts/**`, `packages/pi-arc/skills/**`, `packages/pi-arc/scripts/**`, `packages/pi-arc/tests/**`, `packages/pi-arc/CHANGELOG.md`, `packages/pi-arc/LICENSE` | Copies package content from `../pi-arc`; does not edit package metadata or README. |
| T2 CI/CD | `.github/workflows/ci.yml`, `.github/workflows/release-please.yml` | Adapts `../pi-arc` workflows to root workspace commands and per-package publish. |
| T3 docs | `README.md`, `docs/development.md`, `docs/releasing.md`, `docs/packages/pi-arc.md`, `packages/pi-arc/README.md` | Root + package docs only. Historical `../pi-arc/docs/plans` excluded. |
| T4 install/lock/validation | `package-lock.json` | Runs install and validation after T0-T3 land. Should not edit source/docs except lockfile. |

### Parallel Batch Manifest

| Batch | Prerequisites | Tasks | Independence proof | Validation |
|---|---|---|---|---|
| Batch 0 | None | T0 workspace foundation | Sequential because all later tasks reference workspace paths, package metadata, and release config. | `node --test tests/workspace-contract.test.mjs` after package metadata exists. |
| Batch 1 | T0 | T1 package content, T2 CI/CD, T3 docs | File ownership is disjoint. T1 owns package assets, T2 owns workflows, T3 owns docs/README files. | Review diff by ownership; no overlapping files. |
| Batch 2 | T1, T2, T3 | T4 install/lock/validation | Needs all files before generating lockfile and running package checks. | Full validation matrix below. |

### Validation Matrix

| Scope | Command/check | Proves |
|---|---|---|
| Workspace contract | `node --test tests/workspace-contract.test.mjs` | Root workspace, Release Please, and package metadata contracts match the design. |
| Dependency install | `npm install` | Root workspace can resolve package dependencies and bundled dependencies. |
| Package tests | `npm test --workspace @sentiolabs/pi-arc` | Migrated package tests still pass from workspace location. |
| Root tests | `npm test` | Root delegates to all workspace package tests. |
| Package contents | `npm run pack:dry-run --workspace @sentiolabs/pi-arc` | Published package contents still include Pi resources and exclude repo-only files. |
| Local Pi execution | `pi -e ./packages/pi-arc --help` | Pi can load the migrated package locally. |
| CI parity | `npm run check` | Local equivalent of CI passes. |
| Release safety | `git remote get-url origin` and metadata review | Repository URL/case is safe for npm provenance before publish. |
