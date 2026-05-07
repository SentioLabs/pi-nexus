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

Run only `@sentiolabs/pi-frontend-design` tests:

```bash
npm test --workspace @sentiolabs/pi-frontend-design
```

Run only `@sentiolabs/pi-scriptable-statusline` tests:

```bash
npm test --workspace @sentiolabs/pi-scriptable-statusline
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

Verify publish contents for `@sentiolabs/pi-frontend-design` only:

```bash
npm run pack:dry-run --workspace @sentiolabs/pi-frontend-design
```

Verify publish contents for `@sentiolabs/pi-scriptable-statusline` only:

```bash
npm run pack:dry-run --workspace @sentiolabs/pi-scriptable-statusline
```

## Local Pi loading

Test the workspace package without installing permanently:

```bash
pi -e ./packages/pi-arc
pi -e ./packages/pi-frontend-design
pi -e ./packages/pi-scriptable-statusline
```

Install the package into the current project's local Pi settings:

```bash
pi install -l ./packages/pi-arc
pi install -l ./packages/pi-frontend-design
```
