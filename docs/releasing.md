# Releasing

This monorepo uses Release Please for independent package releases.

## Release model

Each package under `packages/*` has its own Release Please entry. A change to one package should only release that package.

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
  }
}
```

## npm provenance

Publishing uses GitHub Actions and npm provenance through `scripts/npm-publish-workspace-if-needed.mjs`. The helper checks whether the exact workspace package version already exists on npm and skips duplicate publishes, which keeps reruns/idempotent release attempts from failing after a GitHub release has already been cut.

```bash
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-arc
node scripts/npm-publish-workspace-if-needed.mjs @sentiolabs/pi-frontend-design
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
