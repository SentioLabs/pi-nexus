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
    "changelog-path": "CHANGELOG.md"
  },
  "packages/frontend-design": {
    "component": "pi-frontend-design",
    "package-name": "@sentiolabs/pi-frontend-design",
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

The release workflow also publishes the frontend design package when Release Please creates a `packages/frontend-design` release:

```bash
npm publish --workspace @sentiolabs/pi-frontend-design --access public --provenance
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
5. Extend the release workflow publish step for the new package or replace the per-package publish steps with a released-workspace publish helper if package count grows.
