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

`@sentiolabs/pi-arc` does **not** bundle or load `pi-subagents` itself as of the imported `0.10.0` baseline. Non-delegating Arc CLI, context, and planning features remain usable without it. Every delegated specialist requires the separately installed, loaded, enabled provider; Arc auto-materializes its generated `arc-*` definitions for that provider:

```bash
pi install npm:pi-subagents
```

`arc_agent` is a thin asynchronous one-specialist Arc-facing wrapper over the same provider, not an independent execution fallback. It supports `isolation: "worktree"` for a single child. Its return is a dispatch receipt; native completion and final artifacts are separate, and failed/paused/stopped/incomplete/malformed runtime state blocks Arc progress regardless of specialist prose. Coordinated waves use one native `workflowScript`, ordered `runs.all` results, and explicit `outputReference`, `outputPathMapping`, or `artifactPaths` handoffs. Parent verification, review, handoff application, acceptance, and publication remain explicit.
