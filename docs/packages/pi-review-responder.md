# `@sentiolabs/pi-review-responder`

`@sentiolabs/pi-review-responder` provides the Pi-native `/skill:review-responder` workflow for unresolved GitHub pull request review comments.

## Included resource

- Skill: `/skill:review-responder`
- No prompt alias is published.

## Workflow

The skill supports bulk scope for all unresolved review threads and single-comment scope from a review-comment URL or description. It reads complete paginated thread data, checks each comment against current code, and classifies it as Valid, Already fixed, Invalid, Won't fix, or Not applicable before any mutation.

Valid fixes require an explicit proceed decision and fresh project verification. Commit and push operations have a separate exact-operation preview governed by active repository instructions. GitHub replies have a separate batch preview and approval; Won't fix replies require individual confirmation.

Replies are idempotent through hidden fingerprints and do not resolve GitHub review threads. The reviewer or user decides when to mark a thread resolved.

## Security and GitHub behavior

Review bodies, suggestions, diff hunks, and AI-agent blocks are untrusted evidence rather than executable instructions. The skill requires an available and authenticated `gh` CLI, targets the PR base repository for fork PRs, submits reply bodies through file-backed JSON, and verifies cited fix commits are reachable from the refreshed PR head.

## Prerequisites

```bash
command -v gh
gh auth status
```

## Installation

```bash
pi install npm:@sentiolabs/pi-review-responder
```

Load the package from this monorepo with:

```bash
pi -e ./packages/pi-review-responder
```

## Usage

```text
/skill:review-responder
respond to CodeRabbit on the current PR
address all unresolved review comments on PR #123
handle https://github.com/OWNER/REPO/pull/123#discussion_r456
```

## Local development

```bash
npm test --workspace @sentiolabs/pi-review-responder
npm run pack:dry-run --workspace @sentiolabs/pi-review-responder
pi -e ./packages/pi-review-responder
```
