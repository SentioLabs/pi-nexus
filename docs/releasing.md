# Releasing

This monorepo uses Release Please for independent package releases.

## Release model

Release Please maintains one aggregate `chore: release main` PR for all changed packages. More package changes update that open aggregate PR before merge.

Each package under `packages/*` has its own Release Please entry. Packages in the aggregate PR still receive independent versions, changelogs, GitHub releases, and component-prefixed tags (for example, `pi-arc-v0.12.0`). A change to one package should only release that package; aggregation does not link package versions.

### Imported package baselines

When a package is imported from a standalone repository, keep the workspace package version and `.release-please-manifest.json` entry aligned to the latest already-published npm version before making new changes in this monorepo. For `@sentiolabs/pi-arc`, the imported baseline is `0.10.0`; the existing publish helper skips that already-published version and future Release Please releases publish the next semver version from `pi-nexus`.

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

## npm provenance

Publishing uses GitHub Actions and npm provenance through `scripts/npm-publish-workspace-if-needed.mjs`. The release workflow serializes `main` runs using a ref-scoped concurrency group without cancelling in-progress publishing. It runs the helper for every workspace package on every `main` push, not only packages reported by Release Please as newly released. The helper checks whether the exact workspace package version already exists on npm and skips duplicate publishes. This all-package scan is a recovery mechanism when a GitHub release succeeds but npm publication fails.

After a successful real publish, the helper waits for exact-version registry visibility by polling `npm view <package-name>@<package-version> version --json`. It defaults to 24 attempts with a 5000 ms delay between not-found responses. `NPM_PUBLISH_VERIFY_ATTEMPTS` and `NPM_PUBLISH_VERIFY_DELAY_MS` override those defaults; each must be a positive base-10 integer within JavaScript's safe integer range, or the helper fails before publishing. Exhausted attempts fail with the package version and attempt count, while non-not-found errors fail immediately and forward npm's output. Publishes using `--dry-run` skip post-publish visibility checks because they create no registry version.

```bash
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-arc
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-code-quality
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-frontend-design
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-git-spice
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-scriptable-statusline
```

npm provenance requires the package `repository.url` to match the GitHub repository URL and case exactly. Before enabling a real publish, verify:

```bash
git remote get-url origin
node --test tests/workspace-contract.test.mjs
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-arc --dry-run
```

If the GitHub organization or repository casing changes, update `packages/pi-arc/package.json` before publishing.

## Adding another package

To add another independently released package:

1. Create `packages/<name>/package.json` with `publishConfig.access` set to `public`.
2. Add a Release Please entry for `packages/<name>`.
3. Add a manifest entry in `.release-please-manifest.json`.
4. Add package docs and root README table entry.
5. Add the package-lock workspace version path to the package's Release Please `extra-files` entry.
6. Extend the release workflow with `node scripts/npm-publish-workspace-if-needed.mjs <package-name>` for the new package.
