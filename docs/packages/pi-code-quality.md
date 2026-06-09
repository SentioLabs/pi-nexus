# @sentiolabs/pi-code-quality

`@sentiolabs/pi-code-quality` provides Pi-native code quality skills and prompts.

## Included resources

- Skill: `/skill:slop-review`
- Prompt alias: `/code-quality-slop [scope]`
- References: Go, Python, Rust, and Svelte/TypeScript slop-review guidance

## Slop review workflow

The `slop-review` skill reviews code through four lenses:

1. AI authorship signals.
2. Idiom fluency.
3. Code quality.
4. Architecture and solution fit.

A calibration pass filters and scores findings before the final report.

## Portability

The package does not require Arc or `pi-subagents`. It uses parallel agent tools when available and falls back to sequential lens passes otherwise.

## Development

```bash
npm test --workspace @sentiolabs/pi-code-quality
npm run pack:dry-run --workspace @sentiolabs/pi-code-quality
pi -e ./packages/pi-code-quality
```
