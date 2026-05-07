# `@sentiolabs/pi-scriptable-statusline`

`@sentiolabs/pi-scriptable-statusline` packages a scriptable footer/statusline extension, setup skill, and prompt alias for Pi.

## Location

- Package path: [`packages/pi-scriptable-statusline`](../../packages/pi-scriptable-statusline)
- Package README: [`packages/pi-scriptable-statusline/README.md`](../../packages/pi-scriptable-statusline/README.md)
- npm package: `@sentiolabs/pi-scriptable-statusline`

## Local development

```bash
npm test --workspace @sentiolabs/pi-scriptable-statusline
npm run pack:dry-run --workspace @sentiolabs/pi-scriptable-statusline
pi -e ./packages/pi-scriptable-statusline
```

## Notes

This package owns Pi's footer via `ctx.ui.setFooter()` and also supports scriptable above/below-editor widgets. Users customize `~/.pi/agent/scriptable-statusline/render.ts`, usually through the `statusline-setup` skill.
