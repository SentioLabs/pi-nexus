# Implementation Task Manifest: Pi Package Monorepo Migration

Plan file: `/home/bfirestone/devspace/personal/sentiolabs/pi-nexus/docs/plans/2026-05-02-pi-package-monorepo-migration.md`
Review surface: legacy `plan.04y435`

## Epic

### Migrate pi-arc into Pi package monorepo

Type: epic
Plan file: `/home/bfirestone/devspace/personal/sentiolabs/pi-nexus/docs/plans/2026-05-02-pi-package-monorepo-migration.md`

The epic description must be the complete plan file content copied verbatim.

## Tasks

### T0: Establish monorepo workspace foundation

Type: task
Priority: 1

Description:

```markdown
## Summary
Create the root npm workspace contract, Release Please package mapping, root validation test, root license, and adapted `packages/pi-arc/package.json` metadata. This task is the sequential foundation for all later package, CI/CD, docs, and validation work.

## Files
- Create: `package.json`
- Create: `.npmrc`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`
- Create: `tests/workspace-contract.test.mjs`
- Create: `packages/pi-arc/package.json`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
Do NOT copy package runtime assets in this task; `agents/`, `extensions/`, `prompts/`, `skills/`, `scripts/`, package tests, package README, package changelog, and package license belong to later tasks.
If `git remote get-url origin` returns a GitHub URL different from `git+https://github.com/SentioLabs/pi-nexus.git`, update only the `repository.url`, `homepage`, and `bugs.url` values in `packages/pi-arc/package.json` to match the actual remote URL case exactly.

## Design Contracts

### Shared (use verbatim — defined in this task)
Root workspace contract:

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

Release Please path contract:

```json
{
  "packages/pi-arc": "@sentiolabs/pi-arc"
}
```

Package metadata contract:

```text
package name: @sentiolabs/pi-arc
package path: packages/pi-arc
package version during migration: 0.7.0
node engine: >=24.0.0
repository.directory: packages/pi-arc
```

### Task-internal
- None.

## Steps
1. Check the current remote URL:
   ```bash
   git remote get-url origin || true
   ```
   Expected output: either prints the remote URL or exits non-zero after printing nothing because this new repo has no remote yet. Continue either way.

2. Create parent directories:
   ```bash
   mkdir -p packages/pi-arc tests
   ```
   Expected output: no output; command exits 0.

3. Create root `package.json` with this exact content:
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

4. Create root `.npmrc` with this exact content:
   ```text
   legacy-peer-deps=true
   ```

5. Create root `.gitignore` with this exact content:
   ```text
   node_modules/
   packages/*/node_modules/
   *.tgz
   .npm/
   .DS_Store
   .pi/
   ```

6. Copy the root license from the source package:
   ```bash
   cp ../pi-arc/LICENSE LICENSE
   ```
   Expected output: no output; command exits 0.

7. Create `release-please-config.json` with this exact content:
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

8. Create `.release-please-manifest.json` with this exact content:
   ```json
   {
     "packages/pi-arc": "0.7.0"
   }
   ```

9. Create `packages/pi-arc/package.json` with this exact content, except for the repository/homepage/bugs URLs if step 1 found a different actual GitHub remote URL:
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

10. Create `tests/workspace-contract.test.mjs` with this exact content:
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

11. Run the contract test:
    ```bash
    node --test tests/workspace-contract.test.mjs
    ```
    Expected output: TAP output with 3 passing tests and exit code 0.

## Test Command
```bash
node --test tests/workspace-contract.test.mjs
```

## Expected Outcome
The repo root has a private npm workspace contract, Release Please tracks `packages/pi-arc` independently, `packages/pi-arc/package.json` has the migration metadata, and the root contract test passes.
```

### T1: Migrate pi-arc package content into workspace

Type: task
Priority: 1
Blocked by: T0

Description:

```markdown
## Summary
Copy the package runtime, prompt, skill, agent, script, test, changelog, and license assets from `../pi-arc` into `packages/pi-arc` without changing runtime behavior. This task intentionally does not own package metadata or package README updates.

## Files
- Create: `packages/pi-arc/agents/**`
- Create: `packages/pi-arc/extensions/**`
- Create: `packages/pi-arc/prompts/**`
- Create: `packages/pi-arc/skills/**`
- Create: `packages/pi-arc/scripts/**`
- Create: `packages/pi-arc/tests/**`
- Create: `packages/pi-arc/CHANGELOG.md`
- Create: `packages/pi-arc/LICENSE`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
Do NOT modify `packages/pi-arc/package.json`; T0 owns it.
Do NOT modify `packages/pi-arc/README.md`; the docs task owns it.
Do NOT copy `../pi-arc/.git`, `../pi-arc/.github`, `../pi-arc/.pi`, `../pi-arc/.npmrc`, `../pi-arc/package-lock.json`, `../pi-arc/release-please-config.json`, `../pi-arc/.release-please-manifest.json`, or `../pi-arc/docs/plans`.

## Design Contracts

### Shared (use verbatim — defined in T0: Foundation)
Package path and package name:

```text
package path: packages/pi-arc
package name: @sentiolabs/pi-arc
package metadata file: packages/pi-arc/package.json
```

### Task-internal
- Source package path: `../pi-arc`.
- Copy directories exactly: `agents`, `extensions`, `prompts`, `skills`, `scripts`, `tests`.
- Copy files exactly: `CHANGELOG.md`, `LICENSE`.

## Steps
1. Confirm the source package exists:
   ```bash
   test -f ../pi-arc/package.json && test -d ../pi-arc/skills && test -d ../pi-arc/prompts && test -d ../pi-arc/extensions
   ```
   Expected output: no output; command exits 0.

2. Remove any stale package asset directories and files owned by this task:
   ```bash
   rm -rf packages/pi-arc/agents packages/pi-arc/extensions packages/pi-arc/prompts packages/pi-arc/skills packages/pi-arc/scripts packages/pi-arc/tests packages/pi-arc/CHANGELOG.md packages/pi-arc/LICENSE
   ```
   Expected output: no output; command exits 0.

3. Copy package directories from the source repo:
   ```bash
   cp -R ../pi-arc/agents packages/pi-arc/agents
   cp -R ../pi-arc/extensions packages/pi-arc/extensions
   cp -R ../pi-arc/prompts packages/pi-arc/prompts
   cp -R ../pi-arc/skills packages/pi-arc/skills
   cp -R ../pi-arc/scripts packages/pi-arc/scripts
   cp -R ../pi-arc/tests packages/pi-arc/tests
   ```
   Expected output: no output; each command exits 0.

4. Copy package changelog and license:
   ```bash
   cp ../pi-arc/CHANGELOG.md packages/pi-arc/CHANGELOG.md
   cp ../pi-arc/LICENSE packages/pi-arc/LICENSE
   ```
   Expected output: no output; each command exits 0.

5. Verify required package resources exist:
   ```bash
   test -f packages/pi-arc/extensions/arc.ts
   test -f packages/pi-arc/skills/arc/SKILL.md
   test -f packages/pi-arc/skills/arc-brainstorm/SKILL.md
   test -f packages/pi-arc/prompts/arc-ready.md
   test -f packages/pi-arc/agents/issue-manager.md
   test -f packages/pi-arc/tests/ask-user-question-package.test.mjs
   ```
   Expected output: no output; each command exits 0.

6. Run package tests directly from the migrated package path:
   ```bash
   node --test packages/pi-arc/tests/*.test.mjs
   ```
   Expected output: TAP output with all migrated package tests passing and exit code 0.

## Test Command
```bash
node --test packages/pi-arc/tests/*.test.mjs
```

## Expected Outcome
All package runtime assets and tests from `../pi-arc` exist under `packages/pi-arc`, excluded standalone repo files are not copied, and the package tests pass from the new path.
```

### T2: Add workspace CI/CD and Release Please publishing

Type: task
Priority: 2
Blocked by: T0

Description:

```markdown
## Summary
Add GitHub Actions workflows for root workspace CI and independent Release Please publishing for `@sentiolabs/pi-arc` with npm provenance.

## Files
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-please.yml`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
Do NOT modify `release-please-config.json` or `.release-please-manifest.json`; T0 owns those files.
Do NOT add a generic publish helper script in this task; the first pass publishes only `@sentiolabs/pi-arc` when Release Please releases `packages/pi-arc`.

## Design Contracts

### Shared (use verbatim — defined in T0: Foundation)
Workspace check command:

```bash
npm run check
```

Release Please package path:

```text
packages/pi-arc
```

npm package name:

```text
@sentiolabs/pi-arc
```

### Task-internal
- CI runtime: Node 24.
- npm install command in CI: `npm ci`.
- npm publish command: `npm publish --workspace @sentiolabs/pi-arc --access public --provenance`.

## Steps
1. Create workflow directory:
   ```bash
   mkdir -p .github/workflows
   ```
   Expected output: no output; command exits 0.

2. Create `.github/workflows/ci.yml` with this exact content:
   ```yaml
   name: CI

   on:
     pull_request:
     push:
       branches:
         - main

   permissions:
     contents: read

   jobs:
     test:
       name: Test and package
       runs-on: ubuntu-latest
       env:
         NPM_CONFIG_LEGACY_PEER_DEPS: "true"

       steps:
         - name: Checkout
           uses: actions/checkout@v4

         - name: Setup Node
           uses: actions/setup-node@v4
           with:
             node-version: 24
             cache: npm

         - name: Install dependencies
           run: npm ci

         - name: Run workspace checks
           run: npm run check
   ```

3. Create `.github/workflows/release-please.yml` with this exact content:
   ```yaml
   name: Release Please

   on:
     push:
       branches:
         - main

   permissions:
     contents: write
     pull-requests: write
     id-token: write

   jobs:
     release:
       name: Release and publish
       runs-on: ubuntu-latest
       env:
         NPM_CONFIG_LEGACY_PEER_DEPS: "true"

       steps:
         - name: Release Please
           id: release
           uses: googleapis/release-please-action@v4
           with:
             config-file: release-please-config.json
             manifest-file: .release-please-manifest.json

         - name: Checkout
           if: ${{ steps.release.outputs['packages/pi-arc--release_created'] == 'true' }}
           uses: actions/checkout@v4

         - name: Setup Node
           if: ${{ steps.release.outputs['packages/pi-arc--release_created'] == 'true' }}
           uses: actions/setup-node@v4
           with:
             node-version: 24
             registry-url: https://registry.npmjs.org
             cache: npm

         - name: Install dependencies
           if: ${{ steps.release.outputs['packages/pi-arc--release_created'] == 'true' }}
           run: npm ci

         - name: Publish pi-arc to npm
           if: ${{ steps.release.outputs['packages/pi-arc--release_created'] == 'true' }}
           run: npm publish --workspace @sentiolabs/pi-arc --access public --provenance
   ```

4. Validate workflow YAML syntax enough for local review by printing both files:
   ```bash
   sed -n '1,220p' .github/workflows/ci.yml
   sed -n '1,260p' .github/workflows/release-please.yml
   ```
   Expected output: both workflow files print with `node-version: 24`, `npm ci`, and the `npm publish --workspace @sentiolabs/pi-arc --access public --provenance` command visible.

## Test Command
```bash
sed -n '1,220p' .github/workflows/ci.yml && sed -n '1,260p' .github/workflows/release-please.yml
```

## Expected Outcome
The monorepo has CI that runs root workspace checks and a Release Please workflow that publishes `@sentiolabs/pi-arc` only when `packages/pi-arc` is released.
```

### T3: Write monorepo and pi-arc documentation

Type: task
Priority: 2
Blocked by: T0
Labels: docs-only

Description:

```markdown
## Summary
Create root monorepo docs and preserve package-level `pi-arc` docs with a short monorepo note. This task is documentation-only.

## Files
- Create: `README.md`
- Create: `docs/development.md`
- Create: `docs/releasing.md`
- Create: `docs/packages/pi-arc.md`
- Create: `packages/pi-arc/README.md`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
Do NOT modify `packages/pi-arc/CHANGELOG.md` or `packages/pi-arc/LICENSE`; the package content migration task owns those files.
Do NOT copy `../pi-arc/docs/plans/*` in this task.

## Design Contracts

### Shared (use verbatim — defined in T0: Foundation)
Workspace commands:

```bash
npm install
npm test
npm run pack:dry-run
npm run check
```

Package local execution command:

```bash
pi -e ./packages/pi-arc
```

Package path:

```text
packages/pi-arc
```

### Task-internal
- Root docs describe the monorepo.
- Package README is copied from `../pi-arc/README.md` and receives a monorepo-location note near the top.

## Steps
1. Create docs directories:
   ```bash
   mkdir -p docs/packages packages/pi-arc
   ```
   Expected output: no output; command exits 0.

2. Create root `README.md` with this exact content:
   ```markdown
   # Pi Nexus

   Monorepo for `@sentiolabs/pi-*` packages.

   This repo uses npm workspaces with one package per directory under `packages/*`. Each package publishes independently to npm and can be installed by Pi by package name.

   ## Packages

   | Package | Path | Description |
   |---|---|---|
   | [`@sentiolabs/pi-arc`](packages/pi-arc) | `packages/pi-arc` | Arc issue tracker integration for Pi: skills, prompts, extension commands, session context, bundled checklist support, and bundled Arc specialist support. |

   Future packages such as `pi-slop` and `pi-frontend-design` should be added under `packages/*` when their sources are ready.

   ## Development

   ```bash
   npm install
   npm test
   npm run pack:dry-run
   npm run check
   ```

   Test the package locally with Pi from the monorepo root:

   ```bash
   pi -e ./packages/pi-arc
   ```

   ## Releasing

   Releases are independent per package through Release Please. See [`docs/releasing.md`](docs/releasing.md).

   ## Documentation

   - [`docs/development.md`](docs/development.md)
   - [`docs/releasing.md`](docs/releasing.md)
   - [`docs/packages/pi-arc.md`](docs/packages/pi-arc.md)
   - [`packages/pi-arc/README.md`](packages/pi-arc/README.md)

   ## License

   MIT © Sentio Labs
   ```

3. Create `docs/development.md` with this exact content:
   ```markdown
   # Development

   ## Prerequisites

   - Node.js 24 or newer.
   - npm 11 or newer.
   - Pi installed for local package loading checks.
   - The `arc` CLI installed when working on `@sentiolabs/pi-arc` behavior.

   ## Install

   Run from the monorepo root:

   ```bash
   npm install
   ```

   npm workspaces install dependencies for all packages under `packages/*` and write one root `package-lock.json`.

   ## Test

   Run all workspace package tests:

   ```bash
   npm test
   ```

   Run the full local CI-equivalent check:

   ```bash
   npm run check
   ```

   Run only `@sentiolabs/pi-arc` tests:

   ```bash
   npm test --workspace @sentiolabs/pi-arc
   ```

   ## Package dry-run

   Verify publish contents for all packages:

   ```bash
   npm run pack:dry-run
   ```

   Verify publish contents for `@sentiolabs/pi-arc` only:

   ```bash
   npm run pack:dry-run --workspace @sentiolabs/pi-arc
   ```

   ## Local Pi loading

   Test the workspace package without installing permanently:

   ```bash
   pi -e ./packages/pi-arc
   ```

   Install the package into the current project's local Pi settings:

   ```bash
   pi install -l ./packages/pi-arc
   ```
   ```

4. Create `docs/releasing.md` with this exact content:
   ```markdown
   # Releasing

   This monorepo uses Release Please for independent package releases.

   ## Release model

   Each package under `packages/*` has its own Release Please entry. A change to one package should only release that package.

   The initial package entry is:

   ```json
   {
     "packages/pi-arc": {
       "component": "pi-arc",
       "package-name": "@sentiolabs/pi-arc",
       "release-type": "node",
       "changelog-path": "CHANGELOG.md"
     }
   }
   ```

   ## npm provenance

   Publishing uses GitHub Actions and npm provenance:

   ```bash
   npm publish --workspace @sentiolabs/pi-arc --access public --provenance
   ```

   npm provenance requires the package `repository.url` to match the GitHub repository URL and case exactly. Before enabling a real publish, verify:

   ```bash
   git remote get-url origin
   node --test tests/workspace-contract.test.mjs
   npm publish --workspace @sentiolabs/pi-arc --access public --dry-run
   ```

   If the GitHub organization or repository casing changes, update `packages/pi-arc/package.json` before publishing.

   ## Adding another package

   To add another independently released package:

   1. Create `packages/<name>/package.json` with `publishConfig.access` set to `public`.
   2. Add a Release Please entry for `packages/<name>`.
   3. Add a manifest entry in `.release-please-manifest.json`.
   4. Add package docs and root README table entry.
   5. Extend the release workflow publish step or replace it with a released-workspace publish helper.
   ```

5. Create `docs/packages/pi-arc.md` with this exact content:
   ```markdown
   # `@sentiolabs/pi-arc`

   `@sentiolabs/pi-arc` packages Arc issue tracker workflows for Pi.

   ## Location

   - Package path: [`packages/pi-arc`](../../packages/pi-arc)
   - Package README: [`packages/pi-arc/README.md`](../../packages/pi-arc/README.md)
   - npm package: `@sentiolabs/pi-arc`

   ## Local development

   ```bash
   npm test --workspace @sentiolabs/pi-arc
   npm run pack:dry-run --workspace @sentiolabs/pi-arc
   pi -e ./packages/pi-arc
   ```

   ## Notes

   The package bundles `@juicesharp/rpiv-todo`, `@juicesharp/rpiv-ask-user-question`, and `pi-subagents` through npm `bundledDependencies` so Arc workflows can load their Pi resources from `node_modules`.
   ```

6. Copy the source package README into the workspace package README:
   ```bash
   cp ../pi-arc/README.md packages/pi-arc/README.md
   ```
   Expected output: no output; command exits 0.

7. Prepend this monorepo note to `packages/pi-arc/README.md` immediately after the first `# Pi Arc Package` heading:
   ```markdown
   > Monorepo location: this package lives at `packages/pi-arc` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-arc` and load it locally with `pi -e ./packages/pi-arc`.
   ```

   Use this command:
   ```bash
   python3 - <<'PY'
   from pathlib import Path

   path = Path('packages/pi-arc/README.md')
   text = path.read_text()
   heading = '# Pi Arc Package\n'
   note = '\n> Monorepo location: this package lives at `packages/pi-arc` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-arc` and load it locally with `pi -e ./packages/pi-arc`.\n'
   if note.strip() not in text:
       text = text.replace(heading, heading + note, 1)
   path.write_text(text)
   PY
   ```
   Expected output: no output; command exits 0.

8. Verify docs files exist:
   ```bash
   test -f README.md
   test -f docs/development.md
   test -f docs/releasing.md
   test -f docs/packages/pi-arc.md
   test -f packages/pi-arc/README.md
   ```
   Expected output: no output; each command exits 0.

## Verification
- `README.md` lists `@sentiolabs/pi-arc` and links to `packages/pi-arc`.
- `docs/development.md` contains `npm install`, `npm test`, `npm run check`, and `pi -e ./packages/pi-arc` commands.
- `docs/releasing.md` documents Release Please, independent package releases, and npm provenance URL-case safety.
- `docs/packages/pi-arc.md` links to `packages/pi-arc/README.md`.
- `packages/pi-arc/README.md` preserves the source README content and includes the monorepo note.
```

### T4: Install dependencies and validate monorepo migration

Type: task
Priority: 1
Blocked by: T1, T2, T3

Description:

```markdown
## Summary
Install root workspace dependencies, generate the root `package-lock.json`, and run the full migration validation suite. This task validates the package migration without changing source, docs, or workflow files.

## Files
- Create: `package-lock.json`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
If a validation command fails because a source/config/docs file is wrong, stop and report the failing command and output. Do not fix files owned by earlier tasks in this task.

## Design Contracts

### Shared (use verbatim — defined in T0: Foundation)
Root check command:

```bash
npm run check
```

Package check commands:

```bash
npm test --workspace @sentiolabs/pi-arc
npm run pack:dry-run --workspace @sentiolabs/pi-arc
```

Package path:

```text
packages/pi-arc
```

### Task-internal
- This task creates only the root `package-lock.json` through `npm install`.
- This task records validation evidence through command output.

## Steps
1. Install workspace dependencies from the monorepo root:
   ```bash
   npm install
   ```
   Expected output: npm completes successfully and creates `package-lock.json` at the repo root.

2. Verify the lockfile exists:
   ```bash
   test -f package-lock.json
   ```
   Expected output: no output; command exits 0.

3. Run root contract tests:
   ```bash
   node --test tests/workspace-contract.test.mjs
   ```
   Expected output: TAP output with 3 passing tests and exit code 0.

4. Run `@sentiolabs/pi-arc` package tests through npm workspaces:
   ```bash
   npm test --workspace @sentiolabs/pi-arc
   ```
   Expected output: Node test output with all package tests passing and exit code 0.

5. Run the root workspace test aggregator:
   ```bash
   npm test
   ```
   Expected output: npm runs workspace tests and exits 0.

6. Verify package dry-run contents through the package script:
   ```bash
   npm run pack:dry-run --workspace @sentiolabs/pi-arc
   ```
   Expected output: npm pack dry-run output for `@sentiolabs/pi-arc` showing package resources such as `agents/`, `extensions/`, `prompts/`, `skills/`, `README.md`, `CHANGELOG.md`, and `LICENSE`.

7. Run the root CI-equivalent check:
   ```bash
   npm run check
   ```
   Expected output: root contract tests, workspace package tests, and workspace pack dry-runs all pass with exit code 0.

8. Run npm publish dry-run for release safety:
   ```bash
   npm publish --workspace @sentiolabs/pi-arc --access public --dry-run
   ```
   Expected output: npm publish dry-run exits 0 and does not publish.

9. Check whether a GitHub remote exists for provenance verification:
   ```bash
   git remote get-url origin || true
   ```
   Expected output: prints the remote URL if configured, or prints nothing if no remote exists. If a remote URL is printed, verify it matches `packages/pi-arc/package.json` repository URL case exactly.

10. Test local Pi loading enough to confirm the package can be resolved:
    ```bash
    pi -e ./packages/pi-arc --help
    ```
    Expected output: Pi starts with the local package loaded or prints Pi help output, then exits 0. If this command launches an interactive session instead of exiting, quit the session and record that local package resolution succeeded.

## Test Command
```bash
npm install && node --test tests/workspace-contract.test.mjs && npm test --workspace @sentiolabs/pi-arc && npm run pack:dry-run --workspace @sentiolabs/pi-arc && npm run check
```

## Expected Outcome
`package-lock.json` exists, workspace installs work, contract tests pass, package tests pass, dry-run pack/publish checks pass, and local Pi package loading is verified or documented.
```

## Dependencies

- T1 blocked by T0
- T2 blocked by T0
- T3 blocked by T0
- T4 blocked by T1
- T4 blocked by T2
- T4 blocked by T3

## Labels

- T3: docs-only

## Required Output

| Task | Arc ID | Title |
|---|---|---|
| Epic | `<id>` | Migrate pi-arc into Pi package monorepo |
| T0 | `<id>` | Establish monorepo workspace foundation |
| T1 | `<id>` | Migrate pi-arc package content into workspace |
| T2 | `<id>` | Add workspace CI/CD and Release Please publishing |
| T3 | `<id>` | Write monorepo and pi-arc documentation |
| T4 | `<id>` | Install dependencies and validate monorepo migration |

Also return the dependency summary after applying dependencies.
