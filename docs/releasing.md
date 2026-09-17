# Releasing

This monorepo uses Release Please for independent package releases.

## Release model

Release Please maintains one aggregate `chore: release main` PR for all changed packages. More package changes update that open aggregate PR before merge.

Each package under `packages/*` has its own Release Please entry. Packages in the aggregate PR still receive independent versions, changelogs, GitHub releases, and component-prefixed tags (for example, `pi-arc-v0.12.0`). A change to one package should only release that package; aggregation does not link package versions.

### Imported package baselines

When a package is imported from a standalone repository, keep the workspace package version and `.release-please-manifest.json` entry aligned to the latest already-published npm version before making new changes in this monorepo. For `@sentiolabs/pi-arc`, the imported baseline is `0.10.0`; future Release Please releases publish the next semver version from `pi-nexus` only when that package path is newly released.

Current package entries include:

```json
{
  "packages/pi-arc": {
    "component": "pi-arc",
    "package-name": "@sentiolabs/pi-arc",
    "release-type": "node",
    "changelog-path": "CHANGELOG.md",
    "extra-files": [
      {
        "type": "json",
        "path": "/package-lock.json",
        "jsonpath": "$.packages['packages/pi-arc'].version"
      }
    ]
  },
  "packages/pi-code-quality": {
    "component": "pi-code-quality",
    "package-name": "@sentiolabs/pi-code-quality",
    "release-type": "node",
    "initial-version": "0.1.0",
    "changelog-path": "CHANGELOG.md",
    "extra-files": [
      {
        "type": "json",
        "path": "/package-lock.json",
        "jsonpath": "$.packages['packages/pi-code-quality'].version"
      }
    ]
  },
  "packages/pi-frontend-design": {
    "component": "pi-frontend-design",
    "package-name": "@sentiolabs/pi-frontend-design",
    "release-type": "node",
    "changelog-path": "CHANGELOG.md",
    "extra-files": [
      {
        "type": "json",
        "path": "/package-lock.json",
        "jsonpath": "$.packages['packages/pi-frontend-design'].version"
      }
    ]
  },
  "packages/pi-git-spice": {
    "component": "pi-git-spice",
    "package-name": "@sentiolabs/pi-git-spice",
    "release-type": "node",
    "initial-version": "0.1.0",
    "changelog-path": "CHANGELOG.md",
    "extra-files": [
      {
        "type": "json",
        "path": "/package-lock.json",
        "jsonpath": "$.packages['packages/pi-git-spice'].version"
      }
    ]
  },
  "packages/pi-scriptable-statusline": {
    "component": "pi-scriptable-statusline",
    "package-name": "@sentiolabs/pi-scriptable-statusline",
    "release-type": "node",
    "initial-version": "0.1.0",
    "changelog-path": "CHANGELOG.md",
    "extra-files": [
      {
        "type": "json",
        "path": "/package-lock.json",
        "jsonpath": "$.packages['packages/pi-scriptable-statusline'].version"
      }
    ]
  }
}
```

## Package-specific publishing

The `.github/workflows/release-please.yml` workflow serializes `main` runs using a ref-scoped concurrency group without cancelling in-progress publishing. Its `release-please` job maintains the aggregate release PR and exposes `releases_created` and `paths_released`. After a release PR merge, only paths in `paths_released` receive publisher jobs, and only when `releases_created` is `true`. An ordinary `main` push does not scan or republish workspace versions.

| Publisher job | Released path | Workspace package |
|---|---|---|
| `publish-pi-arc` | `packages/pi-arc` | `@sentiolabs/pi-arc` |
| `publish-pi-code-quality` | `packages/pi-code-quality` | `@sentiolabs/pi-code-quality` |
| `publish-pi-git-spice` | `packages/pi-git-spice` | `@sentiolabs/pi-git-spice` |
| `publish-pi-frontend-design` | `packages/pi-frontend-design` | `@sentiolabs/pi-frontend-design` |
| `publish-pi-scriptable-statusline` | `packages/pi-scriptable-statusline` | `@sentiolabs/pi-scriptable-statusline` |

Each package job independently checks out the repository, sets up Node 24 with npm caching, installs dependencies, tests its workspace, dry-runs its package contents, and publishes. For example, the Git Spice job runs these commands in order:

```bash
npm ci
npm test --workspace @sentiolabs/pi-git-spice
npm run pack:dry-run --workspace @sentiolabs/pi-git-spice
npm publish --workspace @sentiolabs/pi-git-spice --access public --provenance
```

`npm publish` acceptance (exit status zero) is the completion boundary. The workflow does not poll registry visibility or retry publication. A nonzero exit status fails that package job.

Publisher jobs depend only on `release-please`, never on each other, so a failed package does not block unrelated publisher jobs. Rerun only the failed package job (or use **Re-run failed jobs**), not **Re-run all jobs**, to avoid republishing unrelated packages. Direct publication does not skip existing versions: if npm already accepted a version, investigate before rerunning that package's publish step.

### Merge ordering

Merge the workflow-alignment changes before aggregate release PR #20 so its newly released paths use the independent publisher jobs. Do not merge the release PR first and rely on a later ordinary `main` push to recover publication.

## npm provenance

Publishing uses GitHub Actions and npm provenance. Only publisher jobs receive `contents: read` and `id-token: write`; the Release Please job receives `contents: write` and `pull-requests: write`. All jobs stay in `.github/workflows/release-please.yml`, preserving the workflow filename used by npm Trusted Publisher settings.

npm provenance requires the package `repository.url` to match the GitHub repository URL and case exactly. Before enabling a real publish, verify:

```bash
git remote get-url origin
node --test tests/workspace-contract.test.mjs
npm run pack:dry-run --workspace @sentiolabs/pi-arc
```

If the GitHub organization or repository casing changes, update the affected workspace package manifests before publishing.

## Adding another package

To add another independently released package:

1. Create `packages/<name>/package.json` with `publishConfig.access` set to `public`.
2. Add a Release Please entry for `packages/<name>`.
3. Add a manifest entry in `.release-please-manifest.json`.
4. Add package docs and root README table entry.
5. Add the package-lock workspace version path to the package's Release Please `extra-files` entry.
6. Add an independent publisher job to `.github/workflows/release-please.yml`, gated by `releases_created` and the exact `packages/<name>` path in `paths_released`. Include workspace tests, a package dry-run, and `npm publish --workspace <package-name> --access public --provenance`. Extend the workspace contract tests for the new job.
