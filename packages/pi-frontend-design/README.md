# Pi Frontend Design Package

> Monorepo location: this package lives at `packages/pi-frontend-design` in the `pi-nexus` workspace. From the monorepo root, test it with `npm test --workspace @sentiolabs/pi-frontend-design` and load it locally with `pi -e ./packages/pi-frontend-design`.

Frontend design skill for [Pi](https://pi.dev) that helps coding agents create distinctive, production-grade interfaces without generic AI aesthetics.

This package is a Pi-native adaptation of Anthropic's `frontend-design` Claude plugin from `claude-plugins-official/plugins/frontend-design`.

## What is included

- **`frontend-design` skill** for frontend UI/UX implementation:
  - Bold aesthetic direction before coding.
  - Distinctive typography and color choices.
  - High-impact animation and visual detail guidance.
  - Context-aware implementation that avoids generic AI-generated layouts.
- **`/frontend-design` prompt alias** so the package name can stay Pi-prefixed while the user-facing workflow remains concise.

## Install from npmjs.org

Install globally through Pi:

```bash
pi install npm:@sentiolabs/pi-frontend-design
```

Install into the current project's `.pi/settings.json` instead of global settings:

```bash
pi install -l npm:@sentiolabs/pi-frontend-design
```

Test without installing permanently:

```bash
pi -e npm:@sentiolabs/pi-frontend-design
```

## Install locally

From the `pi-nexus` monorepo root:

```bash
pi -e ./packages/pi-frontend-design
```

Install the local package into the current project's Pi settings:

```bash
pi install -l ./packages/pi-frontend-design
```

## Usage

Ask Pi for frontend implementation work, invoke the prompt alias, or invoke the skill directly:

```text
/frontend-design Create a dashboard for a music streaming app
/frontend-design Build a landing page for an AI security startup
/frontend-design Design a settings panel with dark mode
/skill:frontend-design Create a distinctive product page
```

The prompt alias routes the request to the `frontend-design` skill, which guides the agent to choose a clear aesthetic direction and implement production code with careful attention to visual detail.

## Local development

```bash
npm test --workspace @sentiolabs/pi-frontend-design
npm run pack:dry-run --workspace @sentiolabs/pi-frontend-design
pi -e ./packages/pi-frontend-design --help
```

## Learn more

See the [Frontend Aesthetics Cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb) for detailed guidance on prompting for high-quality frontend design.

## Attribution

Adapted from Anthropic's `frontend-design` Claude plugin under the Apache License 2.0.

Original authors:

- Prithvi Rajasekaran (prithvi@anthropic.com)
- Alexander Bricken (alexander@anthropic.com)
