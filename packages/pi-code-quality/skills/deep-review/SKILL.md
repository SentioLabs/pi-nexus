---
name: deep-review
description: >
  Comprehensive multi-lens code review covering correctness, security, best
  practices, idiom, and architecture/solution-fit, plus an advisory AI-slop
  assessment and a driver-curation verdict (did the author review the AI's
  output?). Use when the user asks for a code review, security review, quality
  audit, pre-PR readiness check, "review my changes", "review this PR", "is this
  code good?", or legacy slop phrasings like "review this for slop", "is this
  idiomatic?", "does this look AI-generated?", "find AI patterns". Trigger
  proactively after large AI-assisted generation sessions when the user asks for
  a quality check. Language references for Go, Python, Rust, and
  Svelte/TypeScript; universal signals apply to any language.
license: MIT
---

# Deep Review

Perform a comprehensive code review through five independent lens passes.
Use parallel-capable execution when available, with the same methodology run
sequentially when delegation is unavailable.
Generic workers can scan in parallel for correctness and quality defects, security
vulnerabilities, idiom violations, and solution-fit problems when a parallel
task/subagent tool is available. Otherwise, run the same lenses sequentially with
separated outputs. A calibration pass scores every finding, filters false positives,
and catches what the scanners missed. Only findings that survive calibration appear in the final report. This is
the primary output: an honest, calibrated judgment of whether the code is sound and
whether the solution is right.

As a secondary, advisory output, the review also assesses AI-slop signals and
renders a **driver-curation verdict** — a best-effort answer to "did the person
driving the AI assistant actually review and curate its output?" — which never
affects the review grade. This assessment is forensic and advisory. Taken together,
the review answers three questions: Is the code locally sound? Is the solution
itself right? Did the author curate what the AI produced?

## Why five lenses matter

A single reviewer either blurs concerns together (mixing "is this correct?" with
"is this secure?", "is this idiomatic?", and "is this the right solution?") or
anchors too heavily on one dimension. The 5-lens architecture separates these
concerns so each agent can focus deeply:

- **Phase 1a (Correctness & Quality):** Hunts for concrete defects — logic errors,
  broken error propagation, race conditions, resource leaks — plus test quality,
  maintainability, and dead code. Reads the code as an executor, not a skimmer.
- **Phase 1b (Security):** Adversarial, attacker-mindset review. Kept separate
  because security review is a different cognitive mode from "is this good code?" —
  it traces untrusted input and asks how each surface could be abused.
- **Phase 1c (Idiom & Best Practices):** Checks whether the code reads like it was
  written by someone fluent in the language and its ecosystem. Compares against the
  project's own idiom baseline, not abstract ideals.
- **Phase 1d (Architecture & Solution-Fit):** Asks whether the implementation should
  exist in this shape. Locally clean code can still be the wrong solution if it
  patches a symptom, chooses the wrong owner, or ignores an existing tool or
  framework mechanism.
- **Phase 1e (AI Slop & Curation Evidence):** Advisory forensics — best-effort
  detection of AI-authorship signals and collection of curation evidence. Kept
  separate so authorship speculation never contaminates the four review lenses.

After the lens passes, a calibration pass scores every finding on a 0-100 scale,
cross-references across lenses, and produces a filtered, verdict-bearing report.

## Execution Model and Model Tier Intent

| Step | Review role | Model-tier intent |
|---|---|---|
| Step 0 | Scope, reconstruction, context, idiom baseline | standard tier |
| Phase 1a | Correctness and Quality | large tier |
| Phase 1b | Security | large tier |
| Phase 1c | Idiom and Best Practices | large tier |
| Phase 1d | Architecture and Solution-Fit | strongest available reasoning tier, falling back to large |
| Phase 1e | AI Slop and Curation Evidence | standard tier |
| Phase 2 | Calibration | strongest available reasoning tier, falling back to large |
| Phase 3-4 | Synthesis and output | inline in the current agent |

Use a generic parallel task/subagent tool when one is available. Keep workers
generic: this skill supplies the complete review methodology, so do not require
Arc specialists, pi-subagents, or any other optional Pi package. If no delegation
tool is available, run the same five lens prompts sequentially and keep each lens's
output separated for calibration. Request model tiers only when the available tool
supports tier selection; otherwise run with the current agent's configured model.

### Context window

Default to **base 200k context** for every step. Only escalate to a larger
context window when Step 0's gathered context bundle (files under review +
base branch files + project guidance + idiom baseline + reviewer comments)
exceeds ~150k tokens. Most reviews fit comfortably in 200k. Larger context
windows carry a real per-token premium and are wasted capacity for typical PRs.

If a larger context window is needed, only escalate the *specific* steps that
need it (usually Phase 2 calibration, which sees the union of all Phase 1
findings) — not every worker. Use the runtime's portable context-window option
when it provides one; otherwise reduce the bundle to the review-critical files
and evidence.

### Output budget per lens

Cap each Phase 1 lens at roughly **5,000 output tokens**. Findings should be
terse: 2-4 sentences per finding plus the structured fields. Phase 2 calibration
consumes structured findings, not essays — verbose lens output inflates Phase 2
input cost without adding signal.

Phase 1d may run slightly longer (~7,000 tokens) because solution-fit analysis
often needs to explain architectural reasoning. Phase 2 calibration may run up
to 10,000 tokens because it covers all lenses plus cross-lens analysis.

---

## Workflow

### Step 0: Determine scope, reconstruct the problem, gather context, and build idiom baseline

Run this step with standard-tier intent. Use a generic worker if delegation is
available; otherwise perform the step inline before the lens reviews.

**Scope:** Determine what to review based on the user's request:
- If the user specifies files/directories, use those
- If the user says "review this PR", use the PR's changed-file list
- If the user says "review my changes" or gives no scope, review everything that
  differs from the base branch: enumerate files with
  `git diff --name-only $(git merge-base origin/<default-branch> HEAD)`. This
  covers commits on the current branch plus staged and unstaged edits in one
  diff. **Untracked files are deliberately excluded** (`git diff` never lists
  them) — the review covers what will ship, not scratch files. On the default
  branch itself, fall back to `git diff HEAD` (staged + unstaged, untracked
  still excluded)
- If the user says "review the codebase" or similar broad request, scan `src/` or the main
  source directory, applying the exclusion list defined under "Definition of 'after
  exclusions'" below. Hand-authored schema sources (e.g. `pkg/ent/schema/`,
  `prisma/schema.prisma`, `*.proto`, `migrations/*.sql`) are always in scope even when
  the rest of their generated output is excluded

**Problem reconstruction** (do this before any review -- it prevents solution-level false negatives):

For PRs and non-trivial changes, produce a short problem statement before launching Phase 1:

1. Identify the stated problem from PR title, description, linked issues, commits, and
   human reviewer comments
2. Identify the inferred actual failure mode from changed code, tests, logs, commands,
   and reproduction evidence
3. Identify existing mechanisms that already own the problem area: framework features,
   package managers, build tools, platform APIs, repo scripts, or established team flows
4. Identify the minimal solution that would solve the problem without new abstractions
5. Record unanswered questions where the PR does not explain why the chosen approach is necessary

For PR reviews, always read human reviewer comments before final grading. Treat comments
as context signals about requirements, missing evidence, tool mental models, and
solution-level objections -- not just as line-level code review inputs.

When PR comments include phrases like "why", "what problem", "anti-pattern", "wrong
layer", "should just work", "too much baggage", "AI fix this", or "do we need this",
route them to Phase 1d. These are usually architecture or solution-fit objections.

**Context gathering** (do this before any review -- it prevents false positives):

1. Read any project guidance files in the repo root and relevant subdirectories, especially
   `CLAUDE.md`, `AGENTS.md`, `README.md`, and contributor docs that define conventions,
   style rules, or architectural decisions
2. Sample 2-3 existing files in the same directory/package as the code under review to
   establish the project's baseline patterns:
   - Error handling style (how does this project handle errors?)
   - Import conventions (aliased? grouped? sorted?)
   - Naming patterns (camelCase? snake_case? abbreviations?)
   - Logging approach (which logger? structured? what level conventions?)
   - Test style (table-driven? fixtures? mocks? what framework?)
3. Detect the primary language(s) and load the appropriate reference file(s) from
   `references/` -- only read reference files
   for languages actually present in the review scope

**Idiom baseline** (document this explicitly so Phase 1c has a concrete reference):

Produce a structured idiom baseline for each language in scope. This baseline is the
authority for Phase 1c -- anything matching it is NOT flagged. Include:

- **Language version:** e.g., Go 1.22, Python 3.12, Rust 2021 edition
- **Modern features in use:** e.g., `slog` vs `log`, `itertools` usage, `?` operator patterns
- **Stdlib preferences:** which standard library packages the project favors over third-party alternatives
- **Error handling convention:** e.g., sentinel errors vs custom types, `errors.Is`/`As` usage, bare `except` policy
- **Test framework:** e.g., `testing` + `testify`, `pytest`, `rstest`
- **Import conventions:** grouping order, aliasing patterns, relative vs absolute
- **Naming conventions:** abbreviation norms, exported/unexported patterns, file naming

**Acceptance file** (skip if absent):

If `.code-quality/review-acceptances.md` exists at the repo root, read it and store the
verbatim contents alongside the rest of Step 0 output. If it is absent, Phase 2 grades
normally with no acceptances applied. The file is a
project-level "do not bring this up again" list, written by the maintainers, that tells
Phase 2 calibration to dismiss findings that match an entry. Only Phase 2 needs the file —
Phase 1 lenses scan blind so they still produce evidence the maintainers can re-evaluate
when removing an entry.

Do not fabricate acceptances; do not infer them from CLAUDE.md or other docs.

**Scope adaptation for PR reviews:**

When reviewing a PR, also gather the base branch versions of changed files so that
Phase 1 agents can distinguish between pre-existing patterns and newly introduced ones.
Use `git show <base>:<path>` for each changed file.

Also gather the PR title, description, linked issues, commit list, changed-file list, and
human reviewer comments. Prefer `gh pr view --comments` plus the appropriate `gh api`
review-comment endpoints when available.

**What Step 0 returns (transport rule).** Step 0's report back to the orchestrator
must be compact: the problem reconstruction, the idiom baseline, the Phase 1d
Decision block, the curation evidence summary, the verbatim acceptances contents
(if found), and — for file contents — **paths and retrieval commands, not the
contents themselves** (the changed-file list, and the exact `git show <base>:<path>`
commands for base-branch versions). Emitting whole file contents through the
subagent's report would truncate on any non-trivial review. The orchestrator then
builds each lens's prompt per the per-lens context budget table in Phase 1: small
artifacts are inlined, and each lens subagent is instructed to read the listed
files / run the listed `git show` commands itself. Phase 2 gets the union.

**Curation evidence bundle** (for Phase 1e and the Phase 2 curation verdict):

Gather branch-level authorship forensics:

1. `git log <base>..HEAD` with full commit messages and trailers. Record
   `Co-Authored-By:` trailers and AI-tool signatures (Claude, Copilot,
   Cursor, etc.) per commit.
2. The per-commit authorship timeline: which commits are AI-assisted, and
   whether human-authored commits *follow* AI-assisted ones amending the
   same files (fixup evidence — a strong curation signal).
3. Commit messages and the PR description (when one exists) as
   divergence-justification surfaces: places where the author may have
   documented why the change deviates from established project patterns.

For non-PR scope (local diff, directory, codebase), gather what git offers
and note what is unavailable. The curation verdict degrades honestly — it
never fabricates evidence.

**Phase 1d decision** (required output of Step 0):

Before launching Phase 1, emit a structured `Phase 1d Decision` block that evaluates
the force-include triggers and skip criteria from the "Phase 1d decision" section
below. The block must show the file count, authored line count, exclusions applied,
which trigger (if any) fired, and the verdict. A skip with no checklist evaluation
is not allowed — when in doubt, mark `REQUIRED`. This block exists so the decision
is auditable rather than buried inside one orchestrator turn.

---

### Phase 1: Five independent lens passes

When a generic parallel task/subagent tool is available, run the applicable lens
passes concurrently. Otherwise, run the exact same lens prompts sequentially with
separated outputs. **Tailor each lens's context bundle** to what that lens actually
needs — broadcasting the full Step 0 context to every worker multiplies input cost
by 5× without adding signal. Each lens's prompt below specifies which context
elements to include.

**Important:** Use generic workers when delegation exists, or omit any worker-type
selection parameter. This skill provides its own complete review methodology, so do
not require Arc specialists, optional Pi packages, or package-specific review agents.
If no generic parallel task/subagent tool exists, run the same five lenses sequentially
and keep each lens's output separated for Phase 2 calibration.

For large reviews (>10 files), split each lens across multiple parallel generic workers
by directory or module when the runtime supports it. In the sequential fallback, process
the same directory/module batches one lens at a time. Phase 1d should stay cross-cutting
unless the PR spans genuinely independent systems.

**Per-lens context budget** (deliver these subsets to each lens, not the full bundle):

| Lens | Files under review | Base branch files | Project guidance | Idiom baseline | Reviewer comments | Problem reconstruction | Language refs | Curation bundle | Acceptances |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Phase 1a (Correctness & Quality) | ✓ | ✓* | ✓ | – | – | – | – | – | – |
| Phase 1b (Security) | ✓ | ✓ | ✓ | – | – | – | – | – | – |
| Phase 1c (Idiom) | ✓ | ✓ | ✓ | ✓ | – | – | ✓ | – | – |
| Phase 1d (Solution-Fit) | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | – | – |
| Phase 1e (Slop & Curation) | ✓ | ✓ | ✓ | ✓ | – | – | – | ✓ | – |
| Phase 2 (Calibration) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

The "✓" columns are required for that lens's analysis; "–" elements would be ignored or
add noise. Phase 1a's base-branch cell (✓*) applies to PR scope only — its test-gaming
signals need the *before* state to tell a loosened assertion from a pre-existing one.
Phase 2 calibration receives the union (it's the cross-lens synthesis step and must see
what every lens saw). Acceptances are deliberately Phase-2-only: Phase 1 lenses scan
blind so the underlying evidence stays visible to maintainers reviewing whether to keep
an acceptance.

### Phase 1d decision: when to require, when to skip

Phase 1d is the most reasoning-heavy lens, but it is also the only one that asks
*"should this code exist in this shape?"*. Skip it too eagerly and you grade
locally clean code as A while the solution itself was misframed.

**Step 0 MUST emit a `Phase 1d Decision` block** in its output containing:

- File count and authored line count after exclusions (show the math, not just
  the result)
- Which exclusions were applied (list the paths/categories dropped)
- Which force-include trigger fired, if any
- Verdict: `REQUIRED` or `SKIPPED`
- One-sentence justification

If the verdict cannot be expressed as a checklist evaluation in this block, default
to `REQUIRED`. The decision is auditable; do not skip silently.

#### Force-include triggers (any one fires → Phase 1d is REQUIRED)

If any of these is true, Phase 1d runs regardless of size:

- The diff adds or modifies a **schema definition** — ORM schemas
  (ent/Prisma/SQLAlchemy/GORM/Diesel models), GraphQL schemas, OpenAPI specs,
  protobuf, JSON Schema, or any file under `migrations/`, `db/migrate/`, or
  matching `*.sql`
- The diff adds a new **repository, service, handler, controller, command, or
  background-worker** file — these are abstraction-boundary decisions even at
  small line counts
- The diff modifies **build/tooling/dev-experience config** — `Makefile`,
  `mise.toml`, `.tool-versions`, `package.json` scripts, `pyproject.toml` build
  config, CI workflow files (`.github/workflows/*`, `.gitlab-ci.yml`),
  `Dockerfile`, devcontainer, or `*.nix` files
- The diff touches **multiple architectural layers** in a single change
  (schema + repository + migration; or handler + service + repository; etc.)
- Reviewer comments include solution-level signals — phrases like "why",
  "what problem", "anti-pattern", "wrong layer", "should just use", "do we
  need", "too much baggage", "AI fix this"

#### Skip criteria (Phase 1d may be skipped only when ALL hold AND no trigger fired)

- Fewer than 5 **authored** files changed (after exclusions, see below)
- Fewer than 100 **authored** lines added (after exclusions)
- No PR title/body mention of: workflow, CI, scripts, infra, deploy, migration,
  refactor, dependency, build, tooling, abstraction, layer, pattern, schema,
  data-layer
- No reviewer comments raising solution-level objections (see trigger list above)

Soft-sounding rationalizations like "pure data-layer add" or "just adding an
entity" are themselves Phase 1d judgments — if you find yourself reaching for
one, the answer is that Phase 1d should run, not that it can be skipped.

#### Definition of "after exclusions"

This definition is shared with the "review the codebase" scope rule above —
applying different exclusion lists in those two places is a known failure mode:
a hand-authored schema directory (e.g. `pkg/ent/schema/`) gets dropped from the
count even though it is the *source* the rest of the generated tree is built from.

The principle: **exclude generator output, never exclude generator inputs.**
ORMs and codegen tools have a small hand-authored source surface (the schema)
and a large generated surface. Phase 1d cares about the source.

When counting authored files and lines, **exclude**:

- Suffix-tagged generated files: `*_generated.go`, `*.gen.go`, `*.pb.go`,
  `*_pb2.py`, `*_pb2_grpc.py`, `*_mock.go`, `*.g.dart`, `*.freezed.dart`
- Whole generated directories — everything under the directory **except** the
  hand-authored schema subdirectory:
  - **ent (Go):** everything under `pkg/ent/` (or wherever ent generates) **except
    `pkg/ent/schema/`**, which is the hand-authored source and is in scope
  - **Prisma:** `node_modules/.prisma/`, `**/generated/` — but `prisma/schema.prisma`
    is in scope
  - **sqlc:** generated `db/sqlc/*.go` (or wherever the config emits) — but the
    `*.sql` query files and `sqlc.yaml` are in scope
  - **oapi-codegen / openapi-generator:** the generated client/server code — but
    the OpenAPI spec is in scope
  - **protobuf:** the generated `*.pb.go` / `*_pb2.py` — but the `*.proto` files
    are in scope
  - **Diesel (Rust):** `src/schema.rs` (printed by `diesel print-schema`) — but
    the migration SQL is in scope
- Atlas/migration tool emissions: `atlas.sum`, `migrate.sum`
- Lockfiles: `go.sum`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `Cargo.lock`, `poetry.lock`, `uv.lock`, `Gemfile.lock`
- Snapshot test fixtures, golden files, and large data fixtures
- Vendored dependencies: `vendor/`, `third_party/`, `node_modules/`

**Do NOT exclude** (keep in scope even if they live under a "generated" tree):

- Hand-authored schema sources: `pkg/ent/schema/*`, `prisma/schema.prisma`,
  `*.proto`, `*.graphql`, `*.sql` query files, hand-edited migration SQL
- Build/tooling config: `Makefile`, `mise.toml`, `.tool-versions`, CI workflows,
  `Dockerfile`, codegen config (`sqlc.yaml`, `oapi-codegen.yaml`, `buf.yaml`)
- Tests, domain types, repositories, services, handlers, business logic

If you cannot tell whether a file is generated, default to **including** it.
Underestimating authored surface drops Phase 1d for changes it should review;
overestimating only adds one large-tier pass. Quick generated-file tells: a header
comment like `// Code generated by ... DO NOT EDIT.`, file size disproportionate
to apparent intent (a 600-line CRUD file from a 40-line schema), or sibling
files that share suspiciously uniform structure.

For tiny local edits that pass all skip criteria with no force-include trigger
(the prototypical case: a one-file bug fix or a comment cleanup), Phase 1a + 1b
+ 1c + 1e are sufficient — solution-fit objections don't apply at that scope.

#### Phase 1a: Correctness & Quality (large-tier intent)

> You are a senior code reviewer hunting for concrete defects. Your job is a
> deep correctness and quality review. Do not speculate about whether code is
> AI-generated — that is another reviewer's job.
>
> Focus, in priority order:
>
> 1. **Correctness** — logic errors, inverted or off-by-one conditions, wrong
>    operators, unhandled edge cases (nil/null/empty/zero/overflow), broken
>    error propagation, race conditions and incorrect concurrency, resource
>    leaks (unclosed files/connections/goroutines), incorrect state handling.
>    This is your primary mandate — read the code as an executor, not a skimmer.
> 2. **Failure masking** — catch/except blocks that swallow errors and continue,
>    broad `except Exception` / `catch (e) {}` that log-and-proceed past failures the
>    caller needs to know about, silent fallback chains (`x or DEFAULT`, `x ?? y ?? z`)
>    that hide misconfiguration, error returns replaced with zero values or empty
>    collections, retries wrapping deterministic failures
> 3. **Test quality** — tests that don't test behavior, missing edge case coverage,
>    mocks that mock too much, tests that would pass even if the code were broken
> 4. **Test gaming** — assertions weakened or deleted to make tests pass, numeric
>    tolerances widened, tests newly skipped/disabled (`skip`, `xfail`, `.todo`,
>    `t.Skip`), tests rewritten to assert current (possibly broken) behavior instead
>    of intended behavior, mocks that replace the unit under test itself. For PR
>    scope, compare against the base branch -- a loosened assertion is invisible
>    without the before
> 5. **Dead code** — unused imports, unreachable branches, commented-out code, unused
>    variables/functions
> 6. **Stale documentation** — comments/docstrings that don't match the current code
>    behavior, outdated README sections, wrong parameter descriptions
> 7. **Debug artifacts** — leftover print statements, hardcoded test values, disabled
>    tests, temporary workarounds marked TODO with no tracking
> 8. **DRY violations** — copy-pasted logic that should be extracted, duplicated
>    constants, repeated patterns that indicate missing abstractions
> 9. **Suppression directives** — newly added `# type: ignore`, `# noqa`,
>    `//nolint`, `// eslint-disable`, `@ts-ignore`/`@ts-expect-error`, `as any`,
>    `#[allow(...)]`, or lint-config rule disabling introduced to silence a checker
>    rather than fix the underlying issue
>
> **Verify, don't trust.** When a finding rests on a claim about the codebase -- "this
> function is unused", "this duplicates a nearby helper", "this API doesn't exist" --
> check the claim with a search before reporting it, and cite what you checked. Never
> treat comments or docstrings as evidence of what the code does; read the code.
>
> For each finding, report:
> - **File** and **line number(s)**
> - The specific **code snippet**
> - **Signal category** (one of the nine above)
> - **Reasoning** -- what the concrete quality issue is
> - **Evidence** -- what you checked to verify any codebase-level claim (or "direct read" for local findings)
> - **Confidence** (0-100)
>
> Tag every finding with `[CORRECTNESS_QUALITY]`. Keep findings terse: 2-4 sentences each.
> Aim for under 5,000 tokens of total output.

#### Phase 1b: Security (large-tier intent)

> You are an adversarial application security reviewer. Think like an attacker:
> for every external input, trace where it flows (taint analysis) and ask how you
> would abuse it. You are NOT a general code reviewer — ignore style, idiom, and
> maintainability. Focus exclusively on security:
>
> 1. **Injection** — SQL, command, template, log, and header injection; string
>    concatenation into interpreters of any kind
> 2. **AuthN/AuthZ** — missing authentication or authorization checks, IDOR,
>    privilege escalation paths, confused-deputy patterns
> 3. **Secrets** — hardcoded credentials, tokens, or keys; secrets written to
>    logs, error messages, or version control
> 4. **Unsafe deserialization and parsing** of untrusted data (pickle, yaml.load,
>    unchecked JSON→struct trust boundaries, XML entity expansion)
> 5. **Path traversal and file handling** — user-influenced paths, zip-slip,
>    symlink following, world-writable outputs
> 6. **SSRF and unvalidated outbound requests** — user-influenced URLs, redirect
>    handling, internal-network reachability
> 7. **Input validation at trust boundaries** — public APIs, CLI arguments,
>    environment variables, file formats, IPC. Internal-only functions called
>    from trusted code do NOT need defensive validation — flagging those is
>    another lens's false-positive, not yours
> 8. **Dependency risk** — newly added dependencies in manifests (`go.mod`,
>    `package.json`, `pyproject.toml`, `Cargo.toml`): typosquat-adjacent names,
>    abandoned or single-maintainer packages for critical paths, install
>    scripts, suspiciously broad version ranges. Best-effort without a CVE
>    database — flag what a careful human reviewer would question
> 9. **Crypto misuse** — homemade crypto, weak password hashing (MD5/SHA1/plain),
>    ECB mode, non-cryptographic randomness used for security purposes
>
> For each finding, report: **File** and **line number(s)**, the **code
> snippet**, **Signal category** (one of the nine), **Severity** (Low / Medium /
> High / Critical), a concrete **exploit scenario** (attacker does X → system
> does Y), **Reasoning**, and **Confidence** (0-100). Verify claims by reading
> the code, never by trusting comments. If the diff touches no security-relevant
> surface, say so explicitly rather than inventing findings.
>
> Tag every finding with `[SECURITY]`. Keep findings terse: 2-4 sentences each.
> Aim for under 5,000 tokens of total output.

#### Phase 1c: Idiom & Best Practices (large-tier intent)

> You are a language idiom expert. Your job is to identify code that is not idiomatic
> for its language, framework, and project context. You have the project's idiom baseline
> -- do NOT flag patterns that match the project's idiom baseline. Only flag deviations
> from established project conventions or from modern language best practices that the
> project has adopted.
>
> Focus on:
>
> 1. **Modern language features** -- using old patterns when the project's language version
>    supports better alternatives (e.g., `os.Open` error handling without `errors.Is` in a
>    Go 1.20+ project, manual loops instead of comprehensions in Python 3.10+)
> 2. **Stdlib usage** -- using third-party libraries for things the stdlib handles well,
>    or using deprecated stdlib APIs when modern replacements exist in the project's version
> 3. **Error handling** -- patterns that deviate from the project's established convention
>    (not from abstract ideals)
> 4. **Framework conventions** -- using a framework against its grain (e.g., fighting
>    Dagster's asset model, bypassing Django's ORM patterns when the project uses them)
> 5. **Naming and structure** -- names that don't follow the project's conventions,
>    file organization that breaks the established module structure
>
> For each finding, report:
> - **File** and **line number(s)**
> - The specific **code snippet**
> - **Signal category** (one of the five above)
> - **Idiomatic alternative** -- what the code should look like
> - **Reasoning** -- why the current code is non-idiomatic in this project's context
> - **Confidence** (0-100)
>
> Tag every finding with `[IDIOM]`. Keep findings terse: 2-4 sentences each. Aim for
> under 5,000 tokens of total output.

#### Phase 1d: Architecture and Solution-Fit Review (strongest available reasoning tier, falling back to large)

Required for PRs and non-trivial changes. Optional for tiny single-file edits where the
user only asks about local code style and no architecture or workflow choice is involved.

> You are an adversarial architecture and solution-fit reviewer. Your job is to decide
> whether the implementation is the right solution to the problem, regardless of whether
> the changed code is locally correct.
>
> Do NOT focus on formatting, style, or small bugs. Focus on whether the PR should exist
> in this shape.
>
> Review these dimensions:
>
> 1. **Problem fit** -- Does the PR solve the actual problem, or only a symptom?
> 2. **Abstraction boundary** -- Is the solution implemented at the right layer, or does
>    it bypass the component, tool, or owner that should own the behavior?
> 3. **Existing mechanisms** -- Does the repo, framework, platform, package manager, or
>    third-party tool already provide a better solution?
> 4. **Scope control** -- Does the PR spread one issue across too many files, docs,
>    scripts, configs, workflows, or user surfaces?
> 5. **Maintenance cost** -- Does the solution create custom code that must track external
>    behavior, file formats, CLI output, or conventions unnecessarily?
> 6. **Operational behavior** -- Does the solution change user workflows, CI behavior,
>    failure modes, or target semantics in ways not justified by the problem?
> 7. **Evidence quality** -- Does the PR prove the problem and chosen solution, or does it
>    look like an "AI fix this" response to a guessed root cause?
> 8. **Education opportunity** -- If the author seems to misunderstand a tool, framework,
>    or architecture boundary, identify the missing mental model factually and
>    non-personally.
>
> For each finding, report:
> - **File(s) or PR area involved**
> - The **claimed or inferred problem**
> - Why the solution is **mismatched or over-scoped**
> - The **existing mechanism or simpler alternative**
> - **Evidence** from the repo, docs, commands, or reviewer comments
> - **Confidence** (0-100)
> - **Severity**: Low, Medium, High
>
> At the end, produce a per-dimension table. Score with quality polarity —
> **higher = better fit, lower = worse fit**:
>
> | Dimension | Score (0-100) | Finding | Better Direction |
> |-----------|--------------:|---------|------------------|
>
> Tag every finding with `[SOLUTION_FIT]`. Keep findings terse: 3-5 sentences each
> (slightly longer than other lenses because architectural reasoning often needs
> explanation). Aim for under 7,000 tokens of total output.

#### Phase 1e: AI Slop & Curation Evidence (standard-tier intent)

> You are an AI-authorship forensic analyst and curation-evidence collector.
> Your output is **advisory** — it never affects the code review grade. You have
> two jobs.
>
> **Job 1 — AI authorship signals.** Identify code likely generated by an AI
> assistant. Ignore human-style mistakes (typos, quick hacks — those are human
> signals). Focus on:
>
> 1. **Contextual blindness** -- code that is locally coherent but unaware of its
>    surroundings: different error handling than the file it lives in, a utility that
>    duplicates one nearby, an abstraction that ignores established patterns, a different
>    logger/serializer/HTTP client than everything else uses. This is the strongest signal.
> 2. **Boilerplate residue** -- scaffolding, placeholder comments, template structure that
>    was never customized. Code that looks like it was accepted from a suggestion without
>    adaptation.
> 3. **Aspirational documentation** -- docstrings/comments that describe what the code
>    *should* do rather than what it *does*. README sections that describe features not
>    yet implemented. Comments that are more detailed than the code warrants.
> 4. **Over-engineering** -- abstractions with one implementation, factory patterns used
>    once, configuration for single-use code, defensive checks for impossible conditions.
>    AI models build for generality; humans build for the case at hand.
> 5. **Uniform mechanical style** -- suspiciously consistent formatting, identical
>    try/catch shapes across unrelated functions, uniform comment density. Human code
>    has texture and variation.
>
> Tag these findings `[AI_AUTHORSHIP]`. Produce the per-file authorship table. Score
> with quality polarity — **higher = more human-like, lower = more AI-generated**:
> | File | Authorship Score (0-100) | Primary Signals | Notes |
> |------|-------------------------|-----------------|-------|
>
> **Job 2 — curation evidence.** Collect evidence bearing on whether the
> author/driver reviewed and curated the AI output:
>
> 1. **Divergence documentation** — for each place the code deviates from the
>    project's idiom baseline or established patterns, check whether a
>    justification exists in a code comment, commit message, or the PR
>    description. Record each divergence as DOCUMENTED (quote the
>    justification) or UNDOCUMENTED.
> 2. **Surviving AI artifacts** — aspirational docs, orphan boilerplate,
>    utilities duplicating ones nearby: things a driver who actually read the
>    output would have caught. Their presence is negative curation evidence.
> 3. **Commit forensics** — from the curation evidence bundle: AI-assisted
>    commits followed by human fixup commits on the same files are positive
>    curation evidence; a single monolithic AI commit with no human amendments
>    is weakly negative.
>
> Tag these findings `[CURATION_EVIDENCE]`, each marked positive or negative.
> Do NOT render the curation verdict yourself — Phase 2 composes it from your
> evidence plus the other lenses' findings.
>
> Keep findings terse. Aim for under 5,000 tokens of total output.

---

### Phase 2: Calibration review (strongest available reasoning tier, falling back to large)

Run a **separate, independent** calibration pass with the strongest available
reasoning tier, falling back to large-tier intent when tier selection is unavailable.
This pass receives ALL findings from all Phase 1 lenses, the original files, the
problem reconstruction, reviewer comments, the codebase context, the idiom baseline,
and the curation evidence bundle.

> You are a senior staff engineer performing calibration review. You are fair, precise,
> and allergic to false positives -- and equally allergic to false negatives. Your job
> is to take findings from the independent lens reviewers (Correctness & Quality, Security,
> Idiom & Best Practices, Architecture and Solution-Fit, AI Slop & Curation Evidence)
> and produce a unified, calibrated assessment.
>
> You are not rewarded for dismissing findings, and not rewarded for confirming them.
> Calibration means moving each finding to exactly where the evidence puts it -- and
> catching what the scanners missed. A review that rubber-stamps the scanners is as
> useless as one that dismisses everything.
>
> **Accepted deviations.** If Step 0 supplied a `.code-quality/review-acceptances.md`
> file, you MUST apply it before grading. For each pending finding from Phase 1a/1b/1c/1d/1e:
>
> 1. Read the acceptances file as plain prose.
> 2. Decide whether the finding is substantively the same concern as any entry in
>    the file. Use semantic judgment, not literal match — entries describe a class
>    of finding (e.g., "plugin marketplace pinning"), not a specific finding ID.
> 3. If yes, set verdict = `DISMISSED (Accepted)` with a reason of the form
>    "Accepted in review-acceptances.md: <topic>".
> 4. Do NOT include accepted findings in the main report tables, in the borderline
>    appendix, or in the dismissed-findings collapse. Instead, list them once in a
>    new "Accepted Deviations" section near the bottom of the report (see Output
>    Format).
> 5. Acceptance-dismissed findings still influence the per-file authorship table
>    (they are evidence of AI-shaping the code) but do NOT contribute to per-file
>    Quality, Security, or Idiom scores, and the matched solution-fit findings do
>    NOT contribute to `solution_fit_score`.
>
> The acceptance file is the project owner's pre-registered "do not bring this up
> again" list. Trust it. If you genuinely think an entry is unsafe (e.g., it
> suppresses a real security issue or masks a regression), include a single
> `ESCALATED` finding flagging the acceptance itself with a clear reason — but the
> default posture is to honor the file. Never silently ignore an acceptance you
> disagree with; surface it.
>
> If no acceptances file was supplied, skip this step entirely and grade as normal.
>
> **For each finding, you must:**
>
> 1. Read the actual code at the referenced file:line
> 2. Read the surrounding context (the full function, the file's imports, nearby code)
> 3. Check the codebase context and idiom baseline -- does this project have a convention
>    that makes this OK?
> 4. Assign a **confidence score (0-100)** using this rubric (bands align with the
>    Phase 3 inclusion thresholds: <50 dismissed, 50-69 borderline, ≥70 main report):
>    - **0-25:** False positive. The finding is wrong or irrelevant.
>    - **26-49:** Nitpick. Technically true but not worth acting on.
>    - **50-69:** Low severity. Real issue but minor impact.
>    - **70-85:** Verified real. Clear problem that should be fixed.
>    - **86-100:** Confirmed critical. Significant issue affecting correctness, security,
>      or maintainability.
> 5. Render a **verdict**:
>    - **CONFIRMED** -- this is a real finding. Explain why it survives scrutiny.
>    - **DOWNGRADED** -- real but less severe than the scanner claimed. Adjust score and explain.
>    - **DISMISSED** -- false positive or nitpick. Explain what the scanner got wrong.
>    - **ESCALATED** -- worse than the scanner realized. Explain the additional concern.
>
>    **Evidence standard.** A CONFIRMED verdict requires checkable evidence: the
>    actual code at file:line, plus -- when the finding makes a claim about the wider
>    codebase (duplication, dead code, convention deviation, "this API doesn't
>    exist") -- the search or read result that verifies the claim. If the claim
>    cannot be verified from the materials provided, the ceiling is DOWNGRADED with
>    a note of exactly what remains unverified. Never CONFIRM on plausibility alone.
>
>    A DISMISSED verdict requires naming the specific counter-evidence -- the project
>    convention, idiom-baseline entry, or code fact the scanner missed. "Seems too
>    pedantic" is not a dismissal; that is a DOWNGRADE to nitpick (26-49).
> 6. **Re-tag** if the finding was categorized under the wrong lens (e.g., an idiom
>    finding tagged `[CORRECTNESS_QUALITY]` should be re-tagged `[IDIOM]`).
> 7. Explicitly answer the solution-fit questions:
>    - Could this code be locally acceptable but still the wrong solution?
>    - Did the implementation choose the wrong owner or abstraction boundary?
>    - Did reviewer comments reveal a system-level objection the code lenses missed?
>    - Are there signs the engineer or AI assistant misunderstood a tool, framework, or
>      repo convention?
>    - Should the grade change because the solution is strategically poor even if the diff
>      is small?
>
> **Cross-finding analysis:**
>
> After processing individual findings, perform cross-lens analysis:
> - **False-negative sweep (mandatory):** Select the two files with the worst
>   preliminary scores plus the single largest changed file (by authored lines), and
>   re-read each end-to-end hunting for issues every Phase 1 lens missed. The
>   scanners anchor on their checklists; you are the last line of defense against
>   issues hiding in plain sight. Report new findings with the same structure as
>   Phase 1 findings, tagged `[CALIBRATION_CATCH]`, and grade them like any other
>   finding. If the sweep finds nothing, state "sweep performed on <files>: nothing
>   found" -- never silently omit it.
> - **Cross-lens patterns:** Identify cases where findings from different lenses
>   reinforce each other (e.g., an `[AI_AUTHORSHIP]` contextual blindness finding
>   combined with an `[IDIOM]` finding on the same code strongly suggests AI generation).
>   Note these correlations explicitly.
> - **Solution-fit patterns:** Do not treat `[SOLUTION_FIT]` findings as optional
>   appendices. If the implementation strategy is wrong, it must affect the top-line grade.
> - **Reviewer comment classification:** Classify each substantive human reviewer comment:
>
> | Status | Meaning |
> |--------|---------|
> | Supported | Evidence confirms the reviewer is raising a real solution or code issue. |
> | Partially supported | The concern is directionally right, but narrower or lower severity. |
> | Not supported | The reviewer concern does not hold after checking repo reality. |
> | Needs clarification | The PR does not contain enough evidence to decide. |
>
> **File-level authorship table:**
>
> Produce a per-file authorship assessment for EVERY file in scope, incorporating
> Phase 1e's assessments and your own calibration. Authorship Score uses quality
> polarity — **higher = more human-like, lower = more AI-generated**:
>
> | File | Authorship Score (0-100) | Calibrated Confidence | Key Signals | Verdict |
> |------|-------------------------|----------------------|-------------|---------|
>
> Your output is the complete calibrated finding list with scores, verdicts, reasoning,
> cross-lens correlations, reviewer-comment classifications, solution_fit_score, the
> file-level authorship table, and the driver-curation verdict.
>
> **Driver-curation verdict composition.** After grading findings, compose the
> curation verdict — the answer to "did the person driving the AI assistant
> review and curate its output?" — from four signal families:
>
> 1. **Pattern adherence** — confirmed `[IDIOM]` findings and contextual-blindness
>    `[AI_AUTHORSHIP]` findings are negative adherence evidence; their absence in
>    AI-authored files is positive
> 2. **Divergence documentation** — `[CURATION_EVIDENCE]` divergence records:
>    documented divergences are positive; undocumented ones negative
> 3. **Surviving artifacts** — confirmed artifact findings are strongly negative
> 4. **Commit forensics** — human fixups amending AI commits are positive
>    corroboration; never required for a good verdict
>
> Render exactly one verdict for the change-set (with per-file notes where files
> differ materially):
>
> - `CURATED` — patterns followed; divergences are better and documented; no
>   meaningful surviving artifacts
> - `PARTIALLY_CURATED` — mostly follows patterns; some unexplained divergences
>   or minor surviving artifacts
> - `UNCURATED` — contextual blindness, undocumented divergences, surviving
>   artifacts; no signs the driver read the output
> - `INDETERMINATE` — diff too small or signal too weak to judge honestly
> - `N/A (appears human-authored)` — no meaningful AI-authorship signals; a
>   curation verdict would be meaningless, so say so
>
> Every verdict MUST list which signal families drove it. The verdict is
> advisory: it never caps, raises, or otherwise alters the review grade.

Provide the calibration pass with:
- Findings from all five lenses (Phase 1a, 1b, 1c, 1d, and 1e)
- The original files under review (so it can re-read them independently)
- The base branch versions of changed files (PR scope)
- The problem reconstruction, reviewer comments, codebase context, and idiom baseline from Step 0
- The curation evidence bundle from Step 0
- The verbatim `.code-quality/review-acceptances.md` contents, if Step 0 found the file —
  omitting this silently disables the entire acceptances feature
- The language reference file(s) Step 0 loaded

---

### Phase 3: Synthesize, grade, and report

Merge the calibrated findings into the output format below. Apply these
thresholds for finding inclusion. **These gate on per-finding *confidence*
(reviewer certainty that the finding is real), not on the file/quality
scores defined later in this section** — confidence and quality use the
same polarity (higher = stronger), but they're different axes.

- **Confidence >= 70:** Include in the main report sections
- **Confidence 50-69:** Include in a borderline appendix
- **Confidence < 50:** Include in the dismissed findings section

`[CALIBRATION_CATCH]` findings from Phase 2's false-negative sweep flow into the
lens table that matches their nature (security/quality/idiom/solution-fit/authorship),
with `CALIBRATION_CATCH` noted in the Verdict column. **For grading, count each
calibration catch under its matching dimension exactly as if the owning lens had
found it** — a sweep-caught security hole enters the Security Score like any
`[SECURITY]` finding. The sweep statement itself ("sweep performed on <files>:
N new findings" or "nothing found") goes in the Evidence Checked table.

#### Grading algorithm

The review grade is computed ONLY from review findings. AI-slop and curation
signals contribute nothing to any formula in this section.

Throughout this section, **"confirmed findings" means findings whose calibration
verdict is CONFIRMED or ESCALATED**, taken at their calibrated confidence.
DOWNGRADED, DISMISSED, and acceptance-dismissed findings never enter any formula.

**Step 1: Per-file dimension scores (quality polarity — higher = better)**

Compute each dimension from its confirmed findings via
`defect = min(100, mean(finding_confidences) * (1 + log2(count)))`, then
`score = 100 - defect`. No findings → score 100.

- **Quality Score** — over confirmed `[CORRECTNESS_QUALITY]` findings
- **Security Score** — over confirmed `[SECURITY]` findings (typically 100 —
  it only moves when something real was found)
- **Idiom Score** — over confirmed `[IDIOM]` findings

**Step 2: Weighted file score**

```
file_score = (0.45 * quality_score) + (0.35 * security_score) + (0.20 * idiom_score)
```

**Step 3: Local code rollup** — LOC-weighted so a 500-line file with issues
matters more than a 10-line utility:

```
code_local_score = Σ(file_score * file_loc) / Σ(file_loc)
```

**Step 4: Solution-fit blend.** `solution_fit_score` is the mean of the
calibrated per-dimension scores from Phase 1d's dimension table (0-100, higher =
better fit), after excluding acceptance-dismissed findings. Then:

```
final_score = (0.60 * code_local_score) + (0.40 * solution_fit_score)
```

For PRs whose purpose is architecture, tooling, workflows, infrastructure,
developer experience, or process, weight them equally:

```
final_score = (0.50 * code_local_score) + (0.50 * solution_fit_score)
```

Tiny local edits where Phase 1d was skipped: `final_score = code_local_score`
and report Solution-Fit as "Not applicable for this scope".

**Step 5: Grade caps** (applied to `final_score` after Step 4 — caps exist so a
critical finding sets a floor on concern that density-weighted averages cannot
wash out):

| Condition | Cap |
|-----------|-----|
| Any CONFIRMED or ESCALATED **security or correctness** finding with confidence ≥ 86 | C (score ≤ 60) |
| Any CONFIRMED **test-gaming** finding (assertions weakened, tests disabled to pass) | C (score ≤ 60) |
| `solution_fit_score` < 40 on a PR whose purpose is architecture/tooling/workflow | C (score ≤ 60) |
| Two or more CONFIRMED/ESCALATED **security, correctness, or test-gaming** findings with confidence ≥ 86 | D (score ≤ 40) |

When a cap fires, report both numbers so the math stays auditable:
`final_score: 74 → capped to 60 (confirmed security finding #3)`. Caps never
raise a score, and acceptance-dismissed findings never trigger caps.

**Step 6: Letter grade and verdict**

| Grade | Score | Verdict |
|-------|-------|---------|
| A | 81-100 | Clean |
| B | 61-80 | Mild concerns |
| C | 41-60 | Significant concerns |
| D | 21-40 | Serious problems |
| F | 0-20 | Do not merge |

---

## Universal Slop Signals

These signals feed Phase 1e and the slop assessment; overlapping quality signals
(failure masking, test gaming, suppression) are ALSO review-grade material via Phase 1a.

These apply to every language. The language-specific reference files add to these,
they don't replace them.

### Structural tells
- Functions named after *what they do* rather than *what they represent*
  (`processDataAndValidateInput`, `handleRequestAndReturnResponse`)
- Comments that restate the code verbatim -- no "why", only "what"
- Abstractions with exactly one implementation (premature interface/protocol/trait invention)
- Happy-path-only logic -- edge cases (nil/null/empty/zero/overflow) simply absent
- Hardcoded values that belong in config or named constants
- Inconsistent error message casing/formatting vs. the rest of the codebase

### Defensive over-engineering
- `try/except` or error handling around operations that cannot fail in context
- Redundant nil/null checks on values the type system or caller already guarantees
- Validation of internal function arguments that are only called from trusted code
- Feature flags, backwards-compatibility shims, or configuration for single-use code
- Factory/builder/strategy patterns used exactly once

### Documentation noise
- Docstrings that restate the function signature in prose ("Takes an X and returns a Y")
- `# increment counter` above `counter += 1`
- Module-level docstrings that describe what the file contains rather than why it exists
- Every function documented even when the name + signature is self-explanatory
- Type annotations in docstrings that duplicate the actual type annotations

### Copy-paste signatures
- Multiple functions with near-identical parameter lists suggesting generated boilerplate
- Repeated structural patterns (same try/catch shape, same logging preamble) across
  unrelated functions -- human code tends to vary more
- Suspiciously uniform formatting that doesn't match the rest of the file

### Test quality signals
- Tests named `TestSuccess` / `TestFailure` / `test_basic` with no scenario specificity
- Mocks that mock so much they don't test anything real
- No property-based, table-driven, or parametrized tests where the problem calls for them
- Assertions that only check happy-path return values, never error payloads or side effects
- Missing coverage for concurrency, timeout, and cancellation paths
- Test functions that verify the code compiles/runs, not that it *behaves* correctly

### Failure masking
- Catch/except blocks that log and continue past errors the caller needed to know about
- Silent fallback chains (`config.get(...) or DEFAULT`, `x ?? y ?? z`) that turn
  misconfiguration into mystery behavior
- Error returns replaced with zero values, empty collections, or `None` so callers
  can't distinguish failure from absence
- Retries wrapped around deterministic failures — the AI "fixed" a flake by hiding it

### Test gaming
- Assertions weakened, deleted, or replaced with tautologies to make a suite pass
- Numeric tolerances widened without justification
- Tests newly marked skip/xfail/`.todo`/`t.Skip` that previously ran
- Tests rewritten to assert the code's *current* behavior rather than its *intended*
  behavior — locking in a bug as a spec
- Mocking the unit under test itself

These are among the highest-severity signals in this skill: they degrade the safety
net while making the dashboard look greener. A confirmed test-gaming finding caps
the final grade at C (see grading Step 5).

### Suppression and churn
- Newly added suppression directives (`# type: ignore`, `# noqa`, `//nolint`,
  `// eslint-disable`, `@ts-ignore`, `as any`, `#[allow(...)]`) instead of fixes
- Lint/type-checker config rules disabled in the same PR that introduces violations
- Unrelated reformatting or import-churn inflating the diff and burying the real change
- Parallel "v2" functions appended next to the code they should have modified —
  integration avoided, duplication shipped

### The strongest signal: contextual blindness

Code that would pass review in isolation but is clearly unaware of its surroundings:
- Different error handling style than the file it lives in
- A new utility function that duplicates one nearby
- A new abstraction that ignores the established codebase pattern
- A different logger, serializer, HTTP client, or ORM pattern than everything else uses
- Import style that doesn't match the rest of the project

AI generates locally coherent code. It rarely generates *contextually* coherent code.
This is the single most reliable signal and should be weighted heavily.

### Solution-level slop signals

Generated work can look competent file-by-file while still choosing the wrong solution.
**Routing exception:** unlike the rest of this section, these signals are Phase 1d
material — flag them as `[SOLUTION_FIT]` (grade-bearing), not as advisory Phase 1e
findings. They are listed here because generated code exhibits them so often; Phase 1e
may cite them as curation evidence, but the findings themselves belong to Phase 1d:

| Signal | Description |
|--------|-------------|
| Symptom patching | The PR fixes the observed error but not the root cause. |
| Wrong owner | Logic is added outside the component, tool, or layer that should own it. |
| Custom wrapper over managed tool | New scripts parse or enforce behavior already owned by a package manager, framework, or platform. |
| Multi-surface workaround | One issue is patched in code, scripts, docs, and CI without proving why all are needed. |
| Evidence-free root cause | The PR assumes a cause but does not reproduce or verify it. |
| Defensive generality | A generic framework is created before there is a repeated need. |
| Policy split | Two commands or code paths now enforce different rules for the same concern. |
| Documentation as retrofit | Docs are updated to justify the new workaround rather than explain established team workflow. |

Worked example of the pattern: a PR adds a custom `scripts/check_tool_version.sh`
wrapper to enforce tool versions in a repo whose toolchain is already managed by
`mise`. The right review identifies the actual problem (PATH/tool-resolution drift),
checks whether `mise exec -- ...` already provides the execution boundary, marks the
custom wrapper as the wrong solution boundary if evidence confirms it, treats
reviewer comments like "should just work" as solution-level signals, and downgrades
the overall grade even though the shell script itself is locally clean.

When identifying a skill or mental-model gap, phrase it as an education opportunity, not
personal criticism. Good: "The PR suggests a mise mental-model gap: `mise.toml` was
treated as a manifest to parse manually rather than making `mise exec` the execution
boundary for managed tools." Bad: "The author does not understand mise."

---

## Output Format

Two rendering rules applied outside the template: (1) the ⚠️ Caution blockquote is
rendered ONLY when Driver Curation is `UNCURATED` and the grade is B or above —
omit it entirely otherwise; (2) the **AI Slop Assessment** scale maps from the
calibrated per-file authorship scores: **None** (no confirmed `[AI_AUTHORSHIP]`
findings and mean authorship ≥ 85), **Mild** (isolated findings, mean 70-84),
**Moderate** (recurring findings, mean 40-69), **Strong** (pervasive findings,
mean < 40).

```markdown
## Deep Review: <filename, directory, or PR scope>

**Scope:** <what was reviewed — files, line count, language(s)>
**Grade:** [A-F] (<final_score>/100; if a cap fired: "74 → capped to 60 (reason)")
**Local Code Score:** <code_local_score>/100
**Solution-Fit Score:** <solution_fit_score>/100 or "Not applicable for this scope"
**Verdict:** [Clean / Mild concerns / Significant concerns / Serious problems / Do not merge]
**AI Slop Assessment:** [None / Mild / Moderate / Strong slop signals] | **Driver Curation:** [CURATED / PARTIALLY_CURATED / UNCURATED / INDETERMINATE / N/A (appears human-authored)] (signals: <families>)

> ⚠️ **Caution:** The code looks clean, but shows no evidence the driver reviewed
> the AI output. Clean-looking and reviewed are not the same.
> <include this blockquote only per rendering rule 1 above>

> **Reading the scores:** all /100 scores are higher-is-better; per-finding
> Confidence is reviewer certainty the finding is real.

### Must-Fix
<items whose conditions match the grade caps: CONFIRMED/ESCALATED security or
correctness with confidence ≥ 86, confirmed test-gaming, cap-triggering
solution-fit findings. Checklist form. Omit the section when empty.>

### Solution-Level Assessment
<Phase 1d's calibrated per-dimension table>
| Dimension | Score (0-100) | Finding | Better Direction |
|-----------|--------------:|---------|------------------|

### Evidence Checked
<one row per verification performed: commands run, repo facts checked, reviewer
comments traced, plus the mandatory false-negative sweep statement>
| Check | Observed Result | Assessment |
|-------|-----------------|------------|

### Reviewer Comment Classification
<PR scope with human comments only — omit otherwise>
| Comment | Status | Evidence | Assessment |
|---------|--------|----------|------------|

### Education Opportunity
<factual, non-personal description of a tool/framework mental-model gap and the
missing concept — omit when none>

### Security Findings
| # | File:Line | Category | Severity | Finding | Confidence | Verdict |
|---|-----------|----------|----------|---------|------------|---------|

### Correctness & Quality Findings
| # | File:Line | Signal | Finding | Confidence | Verdict |
|---|-----------|--------|---------|------------|---------|

### Idiom & Best Practices Findings
| # | File:Line | Signal | Finding | Idiomatic Alternative | Confidence | Verdict |
|---|-----------|--------|---------|----------------------|------------|---------|

### Solution-Fit Findings
| # | Area | Signal | Finding | Better Direction | Confidence | Verdict |
|---|------|--------|---------|------------------|------------|---------|

### File-Level Assessment
| File | LOC | Quality (0.45) | Security (0.35) | Idiom (0.20) | Score | Grade |
|------|-----|----------------|-----------------|--------------|-------|-------|

### Positive Signals
- <things done well>

---

### AI Slop Assessment
<advisory. Per-file authorship table (0-100, higher = more human-like) +
confirmed [AI_AUTHORSHIP] findings table. State plainly when signals are weak.>

### Driver Curation
<the composed verdict, the signal families that drove it, and what was checked
(adherence / divergence documentation / artifacts / commit forensics). Honest
about missing evidence — INDETERMINATE beats a guess.>

### Borderline Findings (confidence 50-69)
| # | File:Line | Lens | Finding | Confidence | Verdict |
|---|-----------|------|---------|------------|---------|

### Accepted Deviations
<only when an acceptances file was supplied AND at least one finding matched an
entry — lists concerns the scanners raised that the project pre-registered as
accepted. Do NOT duplicate these in Dismissed Findings.>
| Topic | Phase 1 confidence | Lens | Acceptance reason |
|-------|-------------------:|------|-------------------|

### Dismissed Findings
<brief or collapsed — what the scanners flagged but calibration removed
(confidence < 50), so the review's thoroughness stays visible without noise>
```

If the code is clean, say so directly. The goal is an honest, calibrated
assessment — not finding problems for their own sake.

---

## Language Reference Files

Language-specific signals live in `references/`.
Only read the ones relevant to the code under review. Each reference file includes a
"What Idiomatic Looks Like" section that Phase 1c uses alongside the project's idiom baseline:

- `references/go.md` -- Go idioms, error handling, context propagation, concurrency
- `references/python.md` -- Python idioms, type hints, async, common footguns
- `references/rust.md` -- Rust ownership, error handling, type system, unsafe
- `references/svelte-ts.md` -- Svelte reactivity, SvelteKit patterns, TypeScript usage

If the code is in a language not covered by a reference file, rely on the universal
signals and your general knowledge of that language's idioms.

**Cost optimization — reference file caching.** These reference files are static between
runs against the same codebase. In runtimes that support prompt caching, include the
loaded language reference content in a cached prefix so repeat reviews against the same
repo amortize the input cost. In headless or CI contexts, use the runtime's portable
cache-control mechanism when one is available.

---

## Adapting to the codebase

Every codebase has its own conventions. Before confirming any finding — in any
lens — check:

1. **Project guidance** -- Do `CLAUDE.md`, `AGENTS.md`, `README.md`, or nearby contributor docs make this pattern OK?
2. **Existing code** -- Is this pattern used elsewhere in the project? If yes, it's a
   convention, not slop -- even if it wouldn't be idiomatic in a greenfield project.
3. **Framework conventions** -- Some frameworks encourage patterns that look odd in
   isolation (e.g., Dagster's `@asset` decorators, Django's class-based views).
   Don't flag framework-conventional code as slop.
4. **Team size and stage** -- A 2-person startup codebase has different quality norms
   than a 50-person team's production system. Calibrate accordingly.
5. **Acceptances file** -- Has the project pre-registered the concern in
   `.code-quality/review-acceptances.md`? If yes, Phase 2 will dismiss the finding
   automatically; Phase 1 still scans blind so the evidence remains visible.

The Phase 1 scanners should flag potential issues regardless. The Phase 2 calibration
reviewer is where this nuance gets applied.

---

## Phase 4: Output Actions

After Phase 3 synthesis, deliver the findings. Read
`references/output-actions.md` for the full
delivery procedure (mode detection, PR detection, the PR comment format, file outputs,
and fallback delivery shapes). Summary of the flow:

1. **Detect mode.** Non-interactive (CI) only if `CI`/`GITHUB_ACTIONS`/
   `GITLAB_CI`/`BUILDKITE` equals `true`, or if the user explicitly requested
   headless/CI/auto-post mode. Never call `ask_user_question` in non-interactive mode.
2. **Detect a PR**, in priority order: explicit PR number/URL in the request →
   GitHub Actions event payload (`GITHUB_EVENT_PATH`) → `gh pr view` for the
   current branch.
3. **Interactive + PR found + `gh` available/authenticated:** use `ask_user_question`
   only when the tool is available to offer post PR comment (recommended) or write
   `DEEP_REVIEW.md`; otherwise ask the same delivery choice in plain chat. Before
   offering the PR-post option, require `command -v gh` and successful `gh auth status`
   (or an equivalent explicit availability/auth check). **Interactive + PR found but
   `gh` unavailable or unauthenticated:** do not offer the PR-post option; use the
   available question tool or plain chat for local/inline delivery. **Interactive +
   no PR:** write `DEEP_REVIEW.md` directly, no menu.
4. **Non-interactive:** PR found + `gh` available/authenticated → auto-post
   the PR comment, no confirmation, after the same `command -v gh` /
   `gh auth status` preflight; PR found but `gh` unavailable or
   unauthenticated → write `DEEP_REVIEW.md`, print the one-line verdict
   summary to stdout, and surface that PR delivery was unavailable; no PR →
   write `DEEP_REVIEW.md` and print the one-line verdict summary to stdout.
   If preflight passed but the actual `gh pr comment` post fails, exit
   non-zero — never silently fall back.

The PR comment uses a dedicated skimmable format (score table, must-fix checklist,
collapsible lens tables) defined in the reference file. Do not paste the full
markdown report as a PR comment, and do not link to uncommitted files from it.
