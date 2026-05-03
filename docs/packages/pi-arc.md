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
