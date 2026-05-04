# `@sentiolabs/pi-frontend-design`

`@sentiolabs/pi-frontend-design` packages the `pi-frontend-design` skill for Pi.

## Location

- Package path: [`packages/pi-frontend-design`](../../packages/pi-frontend-design)
- Package README: [`packages/pi-frontend-design/README.md`](../../packages/pi-frontend-design/README.md)
- npm package: `@sentiolabs/pi-frontend-design`

## Local development

```bash
npm test --workspace @sentiolabs/pi-frontend-design
npm run pack:dry-run --workspace @sentiolabs/pi-frontend-design
pi -e ./packages/pi-frontend-design
```

## Notes

This is a skills-only package. It exposes `./skills` through the Pi package manifest and does not bundle runtime dependencies or Pi extensions.
