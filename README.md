# Pi Nexus

Monorepo for `@sentiolabs/pi-*` packages.

This repo uses npm workspaces with one package per directory under `packages/*`. Each package publishes independently to npm and can be installed by Pi by package name.

## Packages

| Package | Path | Description |
|---|---|---|
| [`@sentiolabs/pi-arc`](packages/pi-arc) | `packages/pi-arc` | Arc issue tracker integration for Pi: skills, prompts, extension commands, session context, bundled checklist/question support, and optional Arc specialist integration through external `pi-subagents`. |
| [`@sentiolabs/pi-code-quality`](packages/pi-code-quality) | `packages/pi-code-quality` | Pi skills and prompts for AI slop/code quality review, including the 4-lens `slop-review` workflow. |
| [`@sentiolabs/pi-frontend-design`](packages/pi-frontend-design) | `packages/pi-frontend-design` | Frontend design skill for distinctive, production-grade Pi UI work. |
| [`@sentiolabs/pi-scriptable-statusline`](packages/pi-scriptable-statusline) | `packages/pi-scriptable-statusline` | Scriptable footer and statusline UI package for Pi: owns the footer, supports scriptable above/below-editor widgets, and includes a natural-language setup skill. |

Future packages should be added under `packages/*` when their sources are ready.

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
pi -e ./packages/pi-frontend-design
pi -e ./packages/pi-scriptable-statusline
```

## Releasing

Releases are independent per package through Release Please. See [`docs/releasing.md`](docs/releasing.md).

## Documentation

- [`docs/development.md`](docs/development.md)
- [`docs/releasing.md`](docs/releasing.md)
- [`docs/packages/pi-arc.md`](docs/packages/pi-arc.md)
- [`docs/packages/pi-code-quality.md`](docs/packages/pi-code-quality.md)
- [`docs/packages/pi-frontend-design.md`](docs/packages/pi-frontend-design.md)
- [`docs/packages/pi-scriptable-statusline.md`](docs/packages/pi-scriptable-statusline.md)
- [`packages/pi-arc/README.md`](packages/pi-arc/README.md)
- [`packages/pi-scriptable-statusline/README.md`](packages/pi-scriptable-statusline/README.md)

## License

MIT © Sentio Labs
