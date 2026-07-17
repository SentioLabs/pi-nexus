# `@sentiolabs/pi-code-quality`

`@sentiolabs/pi-code-quality` provides Pi-native code-quality skills and prompts for slop review and size review.

## Included resources

- Skill: `/skill:slop-review`
- Prompt alias: `/code-quality-slop [scope]`
- Skill: `/skill:size-review`
- Prompt alias: `/code-quality-size [scope]`
- References: Go, Python, Rust, and Svelte/TypeScript slop-review guidance; default size-review exclusions

## Slop review workflow

`slop-review` reviews code through four lenses: AI authorship signals, idiom fluency, code quality, and architecture/solution fit. It is the workflow for deciding whether the implementation itself looks suspect.

## Size review workflow

`size-review` reviews how a change is packaged for human review: raw versus post-exclusion size, stacked branch shape, viable seams, split effort, and concrete stack plans.

## Usage

```text
/code-quality-slop
/code-quality-slop src/
/code-quality-slop #123
/skill:slop-review

/code-quality-size
/code-quality-size #123
/code-quality-size feature/my-branch
/skill:size-review
```

## Portability

The package does not require Arc or `pi-subagents`. It uses parallel agent tools when available and falls back to sequential lens passes otherwise.

## Local development

```bash
npm test --workspace @sentiolabs/pi-code-quality
npm run pack:dry-run --workspace @sentiolabs/pi-code-quality
pi -e ./packages/pi-code-quality
```
