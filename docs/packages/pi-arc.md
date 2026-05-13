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

The package bundles `@juicesharp/rpiv-todo` and `@juicesharp/rpiv-ask-user-question` through npm `bundledDependencies` so Arc workflows can load checklist and structured-question resources from `node_modules`.

`@sentiolabs/pi-arc` does **not** bundle or load `pi-subagents` itself as of the imported `0.10.0` baseline. Instead, Arc auto-materializes generated `arc-*` specialist definitions for an installed external `pi-subagents` provider. Install `pi-subagents` separately when async/background runs, chains, or worktree-isolated parallel batches are needed:

```bash
pi install npm:pi-subagents
```

If `pi-subagents` is unavailable, Arc workflows fall back to the bundled sequential `arc_agent` tool.
