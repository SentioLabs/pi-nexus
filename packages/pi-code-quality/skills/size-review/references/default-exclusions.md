# Universal default exclusions for size-review

Files that match these globs are excluded from PR-size threshold checks
and seam analysis. They represent generated content, lockfiles, or
machine output rather than reviewable human authorship.

Repos can supply additional exclusions in `.code-quality/size-review-exclude`
at the repo root using the same gitignore-style format. The repo file
*augments* this list (does not replace).

Format: gitignore-style globs. `**` matches any directory depth.
Lines starting with `#` are comments. Blank lines are ignored.

```gitignore
# --- Lockfiles ---
go.sum
**/go.sum
go.work.sum
**/uv.lock
**/poetry.lock
**/Pipfile.lock
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/bun.lockb
**/Cargo.lock
**/composer.lock
**/Gemfile.lock

# --- Common Go generated patterns ---
**/*.gen.go
**/*_gen.go
**/zz_generated_*.go
**/zz_generated.*.go
**/mock_*.go
**/*_mock.go
**/mocks/*.go

# --- Protobuf / gRPC generated bindings ---
**/*.pb.go
**/*.pb.gw.go
**/*_pb2.py
**/*_pb2_grpc.py
**/*.pb.cc
**/*.pb.h

# --- TypeScript / JavaScript generated ---
**/*.d.ts.map
**/*.js.map
**/*.css.map
**/dist/**
**/build/**

# --- Python compiled / cache ---
**/__pycache__/**
**/*.pyc

# --- Generated OpenAPI / Swagger output ---
# Note: hand-written OpenAPI source files (api_index.yaml, etc.) should NOT
# be excluded; only the generated bundle output. Repos that use Redocly or
# similar bundlers should add the bundle path to their repo override file.

# --- Generated GraphQL schemas / clients ---
**/*.generated.ts
**/*.generated.tsx
**/__generated__/**
```

## Notes for skill consumers

- These defaults bias toward **safe exclusions** — patterns that are generated
  in nearly every repo that uses the language/tool. Repo-specific generated
  trees (ent ORM, Atlas migrations, custom codegen output, Postman bundles,
  vendored SDK output) belong in the per-repo override file.
- When in doubt, *don't* exclude something at the universal level. A
  false negative (counting generated code as size) is recoverable with a
  repo override. A false positive (silently dropping a hand-written file
  from review-size analysis) is harder to catch.
- The repo override file at `.code-quality/size-review-exclude` is where
  teams encode their own conventions. Examples of patterns that commonly
  belong there:
  - `apps/*/ent/*.go` (Ent ORM generated tree, except `schema/` which is hand-written)
  - `**/migrations/*.sql` (Atlas-generated migrations)
  - `**/postman/*.json` (Postman collection exports)
  - `**/api.yaml` if it's a Redocly-bundled output (but not if it's the source of truth)
  - Vendored SDKs, generated client libraries, build artifacts checked into the repo
