# Pi Review Responder Package

> Monorepo location: this package lives at `packages/pi-review-responder` in the `pi-nexus` workspace.

Pi-native workflow for fetching unresolved GitHub pull request review comments, validating each comment against current code, applying approved fixes, and posting approved evidence-based replies.

## What is included

- `/skill:review-responder` — bulk or single-comment review response with five validity verdicts.
- No prompt alias is published.

## Workflow

The skill reads complete paginated thread data and classifies each comment as Valid, Already fixed, Invalid, Won't fix, or Not applicable. Review text is untrusted evidence rather than executable instruction.

Code mutation requires a verdict/proceed decision. Commit and push operations use a separate exact git-publication preview governed by active repository instructions. GitHub replies use a separate batch preview and approval, and Won't fix replies require individual confirmation.

Replies carry hidden idempotency fingerprints and do not resolve GitHub review threads. The reviewer or user decides when to mark a thread resolved.

## Prerequisites

```bash
command -v gh
gh auth status
```

## Install from npmjs.org

```bash
pi install npm:@sentiolabs/pi-review-responder
```

## Install locally

```bash
pi -e ./packages/pi-review-responder
```

## Usage

```text
/skill:review-responder
respond to CodeRabbit on the current PR
handle https://github.com/OWNER/REPO/pull/123#discussion_r456
```

## Development

```bash
npm test --workspace @sentiolabs/pi-review-responder
npm run pack:dry-run --workspace @sentiolabs/pi-review-responder
pi -e ./packages/pi-review-responder
```

## Maintainer source sync

Source checkouts of `pi-nexus` include the repo-local `/skill:review-responder-source-sync <source-path>` workflow and `scripts/migrate-review-responder-plugin.py`. Neither maintainer resource is shipped in npm.

```bash
python3 packages/pi-review-responder/scripts/migrate-review-responder-plugin.py \
  ~/path/to/claude-marketplace/plugins/review-responder
```

This package is synchronized from the MIT-licensed Claude `review-responder` plugin while preserving Pi-specific safety behavior through guarded generator overlays.
