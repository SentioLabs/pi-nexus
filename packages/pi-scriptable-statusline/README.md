# `@sentiolabs/pi-scriptable-statusline`

Scriptable footer and statusline UI package for Pi.

## What it does

`@sentiolabs/pi-scriptable-statusline` owns Pi's footer with `ctx.ui.setFooter()` and can render scriptable widgets above or below the editor with `ctx.ui.setWidget()`.

This package is for users who want to customize the whole footer/statusline experience with code instead of selecting from fixed presets.

> **Footer ownership:** this package replaces Pi's footer. Disable other footer replacement packages such as `pi-powerline-footer` when using it. Status entries from non-footer extensions are still available through `input.extensionStatuses`.

## Installation

```bash
pi install npm:@sentiolabs/pi-scriptable-statusline
```

For local development from this monorepo:

```bash
pi -e ./packages/pi-scriptable-statusline
```

## Quick start

```text
/statusline init
/statusline doctor
```

Edit:

```text
~/.pi/agent/scriptable-statusline/render.ts
```

## Renderer API

```typescript
import type { StatuslineRenderer } from "@sentiolabs/pi-scriptable-statusline";

const render: StatuslineRenderer = async (input) => ({
  footer: [
    `${input.model.label} · ${input.repo.name} · ${input.git.branch ?? "no-git"}`,
    `ctx ${input.context.percent ?? "?"}% · ${input.tokens.totalLabel} · ${input.cost.totalLabel}`,
  ],
  widgets: {
    belowEditor: input.extensionStatuses.length
      ? [`statuses: ${input.extensionStatuses.map((status) => status.text).join(" · ")}`]
      : [],
  },
});

export default render;
```

## Commands

- `/statusline init` creates the global renderer if missing.
- `/statusline reload` clears the renderer cache and rerenders.
- `/statusline doctor` prints renderer diagnostics.
- `/statusline disable` clears footer/widgets for the current session.
- `/statusline enable` re-registers footer/widgets for the current session.

## Natural-language setup

Use `/statusline <request>` to delegate your layout request to the `statusline-setup` workflow.

Example request:

```text
/statusline show context on the first footer line, daily and weekly limits on the second line, and model/repo/branch below the editor.
```

## Development

```bash
npm test --workspace @sentiolabs/pi-scriptable-statusline
npm run pack:dry-run --workspace @sentiolabs/pi-scriptable-statusline
```
