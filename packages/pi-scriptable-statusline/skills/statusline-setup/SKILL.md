---
name: statusline-setup
description: Configure the scriptable Pi statusline renderer. Use when the user wants to customize Pi's footer, statusline, model/context display, git/repo display, provider limit display, or above/below-editor status widgets through @sentiolabs/pi-scriptable-statusline.
license: MIT
---

# Statusline Setup

Configure `@sentiolabs/pi-scriptable-statusline` by creating or editing the user's renderer at `~/.pi/agent/scriptable-statusline/render.ts`.

## Rules

- Treat `~/.pi/agent/scriptable-statusline/render.ts` as user-owned code.
- Read the existing renderer before editing it.
- Preserve custom helper functions and comments when practical.
- Ask a concise clarifying question only when the desired layout is ambiguous.
- Prefer simple JS/TS code over a generated framework.
- Use `import type { StatuslineRenderer } from "@sentiolabs/pi-scriptable-statusline";` for type hints.
- Return footer lines through `footer`, above-editor lines through `widgets.aboveEditor`, and below-editor lines through `widgets.belowEditor`.
- If the user wants this package to own the footer, remind them to disable other footer replacement packages such as `pi-powerline-footer`.
- After editing, tell the user to run `/statusline reload` if the extension does not reload automatically.

## Renderer template

```typescript
import type { StatuslineRenderer } from "@sentiolabs/pi-scriptable-statusline";

const render: StatuslineRenderer = async (input) => ({
  footer: [
    `${input.model.label} · ${input.repo.name} · ${input.git.branch ?? "no-git"}`,
    `ctx ${input.context.percent ?? "?"}% · ${input.tokens.totalLabel} · ${input.cost.totalLabel}`,
  ],
  widgets: {
    belowEditor: input.extensionStatuses.map((status) => status.text),
  },
});

export default render;
```

## Verification

- The renderer exports a default function.
- The renderer returns strings only.
- The renderer handles `null` branch, context, and limits values.
- The renderer does not import project-local files unless the user explicitly asks for project-specific behavior.
