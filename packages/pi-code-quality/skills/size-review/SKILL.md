---
name: size-review
description: >
  Decide whether a pull request or branch should be split into multiple smaller
  PRs (preferring git-spice-style stacked Change Requests) and rate the effort
  to do so. Use this skill when the user asks "should I split this PR", "is
  this PR too big", "can this be stacked", "review the size of this PR", "is
  this reviewable", or describes a branch with many files, many commits, or
  cross-cutting changes that resist single-pass review. Trigger proactively
  when a PR exceeds 10 changed files or 400 added lines and the user asks for
  any kind of pre-merge review. Produces a verdict, an effort rating
  (easy/moderate/difficult), and — if a split is recommended — a concrete
  stack plan with CR titles, file mapping, and dependency direction.
license: MIT
---

# Size Review

Decide whether a PR or branch should be split into multiple smaller PRs and
rate the effort to do so. The output is a verdict, an effort rating, and — if
splitting is recommended — a concrete stack plan the author can execute.

This skill is shape analysis, not content review. It pairs naturally with
`deep-review` (which evaluates *what* the code does) — this one evaluates
*how the change is packaged for review*.

## Why this matters

Large PRs cost teams real time. Reviewers fatigue past ~400 lines of diff,
miss bugs, and rubber-stamp later sections. Authors lose momentum waiting
for a single approval that gates everything. Stacked CRs (git-spice
`gs branch create`, Graphite, Sapling) let the author keep shipping in
small slices while reviewers see the full intent — without the all-or-nothing
review thread of one mega-PR.

But splitting isn't always the right call. Some PRs are large because the
underlying change is genuinely indivisible (cross-cutting refactor where
each layer depends on the layer below). Some are part of an existing stack
already. Some are large only because of generated code that reviewers will
skim. The job of this skill is to make a *calibrated* call, not to
reflexively flag everything over a threshold.

**Where the burden of proof sits.** Reviewer attention is the scarcest
resource in the loop. A split costs one author some git work, once; an
oversized PR taxes every reviewer on every revision cycle, degrades review
quality past the first few hundred lines, and coarsens rollback granularity
forever. So the default tilts: **over threshold, "ship as-is" is the verdict
that must be earned** — by sweeping the full seam catalog (Step 4) and
showing each seam fails — not the verdict the analysis falls back to when
splitting looks like work. "It's cohesive" is a conclusion, not an argument.
When the call is close, the tie goes to splitting.

---

## Threshold

Run the full analysis when ANY of these hold against the PR's base branch
*after exclusions are applied* (see Step 2):

- More than **10 files changed**
- More than **400 lines added** (deletions don't count toward "size" — pure
  deletions almost always make a PR easier to review, not harder. 400 is
  where careful-review comprehension measurably degrades in a single
  sitting; it is the budget for one review session, not a generous limit)
- More than **15 commits** in the branch (review fatigue from rebase noise
  and fixup commits, even if total LOC is modest)
- **3 or more top-level directories touched** (cross-cutting blast radius
  matters even if line count is modest)
- The diff **mixes a behavior change with a refactor or mechanical churn**
  (renames, reformatting, import sorting) at any size — see the
  mixed-intent rule in Step 6

Below all of these, write a one-line "Appropriately sized — ship as-is" report
and stop. Don't manufacture concerns where there are none.

**Hard ceiling — presumption of split.** Over **1,000 authored lines added**
or **30 files** (post-exclusions), the verdict *starts at* "Split required"
and only moves to ship-as-is if the Step 4 seam sweep demonstrates that every
catalog seam is fake or n/a. At this size, the analysis is no longer asking
"should this be split?" but "what stops it from being split?" — and the
report must answer that question explicitly.

If the threshold check passes *only because* exclusions removed most of the
size (e.g., a 50-file PR that's 48 generated files plus 2 hand-written
changes), say so in the report — the size signal was dominated by generated
content, which is useful context for the reviewer.

---

## Cost and runtime guidance

This skill is **shape analysis, not content review**. The default workflow needs only
file *names*, *line counts*, *commit titles*, *PR body*, and *reviewer comments* — not
full file contents. Most reviews fit comfortably in 50-100k tokens of input.

- **Default to base 200k context.** The `[1M]` context tier is wasted capacity for
  shape analysis; do not escalate unless a specific seam check requires reading large
  source files. Most reviews don't.
- **Standard-tier intent is sufficient for the mechanical steps** (Steps 1-3:
  scope discovery, exclusions, structural signals). The judgment-heavy steps
  (Steps 4-6: seam viability, effort rating, recommendation) benefit from
  large-tier intent when available, but standard tier handles them adequately
  at substantially lower cost.
- **Don't fetch full file contents** unless verifying a specific seam viability check
  (Step 4). A name + commit-title + PR-body view is the load-bearing input.
- **Run as a single-pass analysis.** Unlike deep-review, this skill doesn't need
  parallel subagents — the steps are sequential and each consumes the previous step's
  output.

For high-volume CI usage (every PR), consider standard-tier intent by default
and reserve large-tier intent for explicit deep-dive requests or PRs flagged by
other gates when the runtime supports tier selection.

---

## Workflow

### Step 1: Scope, base, and stack detection

Determine what to analyze. **Before running stats**, check whether the
branch is already part of a stack — this changes how stats should be
reported.

**For a PR review:**

```bash
gh pr view <num> --json title,body,additions,deletions,changedFiles,commits,baseRefName,url
gh pr diff <num> --name-only
```

If `baseRefName` is not the trunk (typically `main` or `master`), the
branch is **stacked on a non-trunk parent**. Also scan the body for
phrases like "Builds on #X", "Stacked on #Y", "Supersedes #Z" — these
are author-provided stack hints even when `baseRefName` happens to be
trunk (e.g., the parent already merged).

**For a branch review:**

Identify the trunk (`git symbolic-ref refs/remotes/origin/HEAD` or check
project conventions). Then check whether the user has named a base
explicitly, or whether the branch was created on top of a non-trunk
parent. `git for-each-ref refs/remotes/origin/` and the local branch
graph can help.

**If the branch is stacked, compute and report two stat views:**

- **Cumulative** (vs trunk): how big is the whole stack of work this
  branch contributes to? This is the question reviewers face if they
  squash-merge the whole stack.
- **Slice** (vs immediate parent): how big is *this* PR's slice? This
  is the question for reviewing this CR alone.

Both matter. Cumulative shows scope; slice shows reviewability. The
verdict and recommendation should usually weight the slice view more
heavily — if the slice is reasonably sized, the work has already been
properly stacked even if the cumulative view is large.

If not stacked, just compute against trunk.

**Capture for downstream steps:**

- Title and full body
- `+adds` / `-dels` / files-changed / commit count (per base view)
- Commit list with subject lines
- Full file list

### Step 2: Apply file exclusions

Some files inflate raw size stats without representing reviewable human
authorship — generated code, lockfiles, mock outputs, vendored
dependencies. Exclude them from the threshold check, the seam analysis,
and the file counts. **Report them separately** so reviewers know they
were considered (transparency, not silent dropping).

Build the exclusion glob list from up to three sources, in this order:

1. **Bundled universal defaults** — read
   `references/default-exclusions.md`.
   Covers patterns generated in nearly every repo (lockfiles, common
   Go/Python/JS generated outputs, protobuf bindings).
2. **Repo-local overrides** — if `.code-quality/size-review-exclude`
   exists at the repo root, read it. Gitignore-style globs, comments
   with `#`, blank lines OK. These *augment* the defaults (do not
   replace). The repo file is where teams encode their own
   conventions: ent ORM trees, Atlas migrations, OpenAPI bundles,
   vendored SDKs.
3. **`.gitattributes` `linguist-generated=true`** — if the repo marks
   files as generated via the GitHub linguist attribute, honor that.
   Optional convenience layer.

After resolving the union of globs, partition the diff file list:

- **Excluded files**: drop from the threshold check and seam analysis.
  Track them so the report can show counts and a brief sample.
- **Included files**: continue with these for everything downstream.

When reporting stats post-exclusion, the report should show *both* the
raw counts and the post-exclusion counts so the impact of exclusions is
visible. Example:

```
Stats (slice): 33 files raw → 27 after exclusions, +1938/-209 raw → +697/-92 after exclusions
Excluded 6 files: openapi.gen.go (881 lines), openapi.apiclient.gen.go (322 lines),
go.sum (38 lines), apps/core-api/internal/mocks/firmware_service_mock.go (140 lines),
docker-compose.yaml (12 lines), .gitignore (4 lines)
```

### Step 3: Structural signals

The strongest splittability signals are *structural*, not size-based. Read
each one and write down what you find:

1. **Author-signaled stages** (strongest signal). Does the PR body
   enumerate sub-sections like "Core Feature / S3 Integration / CLI
   Uploader / Infrastructure / Testing / Documentation"? That's the
   author already sketching a stack — they just shipped it as one PR.
   Each section in their description is a candidate CR.

2. **Commit phase structure**. Group commits by intent: refactor / feat /
   test / chore / fix. Phases like "scaffold → implement → wire up" or
   "rename → adapt → extend" indicate clean staging. Many "address
   reviewer feedback" / "fix lint" / "merge from main" commits indicate
   fixup noise — separable concern from the underlying intent. A long
   commit history with phase boundaries (group of feats followed by
   group of tests followed by group of fixups) is splittable; an
   interleaved soup of commits is not.

3. **File grouping by top-level directory**. Count files per top-level dir
   (`apps/foo`, `tools/bar`, `infra/`, `pkg/`, `docs/`). Spread across
   many top-level dirs is a strong split signal. Concentration in one
   top-level dir is a weaker signal — the seams are subtler.

4. **File-type taxonomy**. Source code / tests / infra-as-code / docs /
   config / generated. Mixing infra-as-code (Pulumi, Terraform, helm)
   with feature code is a common split point — infra can usually land
   first or last independently.

5. **Existing stacking signal**. From Step 1 — if the branch is already
   stacked or the body says "Builds on #X", the author already practices
   stacking and *this* PR may be the right size for its slice. The
   recommendation should bias toward "no further split needed" unless
   the slice itself is over threshold.

### Step 4: Seam analysis

**Sweep the whole catalog — no opportunistic seam-spotting.** Evaluate
*every* seam type in the catalog below against this PR and record a
one-line verdict for each: **viable**, **fake** (why), or **n/a** (why the
category doesn't apply). The humans reading this report are deciding where
to cut; an unexamined seam category is a hole in the analysis, and "no
seams found" is only credible when the report shows each category was
actually checked. The seams table in the output must cover the full
catalog, not just the seams that jumped out.

For each candidate seam, verify it before recommending it:

- Which **files and which commits** go on which side?
- **Direction of dependency**: what merges first?
- **Can the lower slice compile and test alone?** (If no, the seam is
  fake and forcing a split there will produce broken intermediate states.)

Common splittable seams (in rough order of how often they apply):

- **Per-layer**: repository → service → handler → middleware/controller.
  Common in layered backends. Each layer's tests can live in its own CR.
- **Per-app**: `apps/core-api` vs `apps/web` vs `tools/cli` vs `infra/`.
  Multi-app PRs almost always have natural app-boundary seams.
- **Refactor-then-feature**: prep commits (renames, type changes,
  introducing a helper) before feature commits that consume them. The
  refactor lands first as a no-behavior-change CR, the feature builds on it.
- **Scaffold-then-implement**: stub handler / interface / type definition
  before the real implementation. The scaffold can be reviewed for shape;
  the implementation for correctness.
  - **Watch out:** if the "stub" gets *replaced* rather than *built upon*
    by the real implementation, this seam is fake — you'd be asking
    reviewers to read code that's about to be thrown away. Genuine
    scaffold-then-implement leaves the scaffold in place.
- **Test-infra-as-CR**: reusable test scaffolding (LocalStack helpers,
  fixture factories, mock generators) merged before the tests that use
  it. The test infra is a small, reviewable CR; the tests are noise once
  you have the helpers.
- **Infra-vs-app-code**: Pulumi/Terraform/helm changes can almost always
  land independently of application code, either before (provisioning
  the resource) or after (wiring up the new endpoint).
- **Docs-as-separate-CR**: when docs add >100 lines and don't gate the
  code behavior. Skip this seam if docs are small or tightly coupled
  (e.g., openapi spec changes that drive code generation).
- **Drive-by extraction**: changes that don't belong in this PR at all —
  schema renames, tangentially related fixes, unrelated cleanups
  introduced by a merge or convenience commit. These should ship as
  their own **independent PRs** (not as stack members of the main work),
  because they carry no logical dependency on the main feature. Sign:
  a commit or set of files that, if you removed them, the rest of the
  PR would still hang together. Strong sign: the PR title doesn't
  mention them.

For each catalog category, record: **viable** (passes the three checks),
**fake** (fails one — say which), or **n/a** (category doesn't apply —
say why). Only viable seams enter the stack plan.

### Step 5: Effort rating

Rate the effort to actually perform the split. This step *measures* the
restructuring cost honestly — it does not decide whether to split. The
go/no-go call belongs to Step 6, where effort is weighed against reviewer
cost using the split-leaning defaults. Don't pre-judge here by inflating
the rating to make ship-as-is look inevitable.

- **Easy** — Commits already partition along the seam. A `git rebase -i`
  or an available stack/split tool such as `gs branch split` produces clean
  slices with no conflicts. Each
  slice independently compilable and testable. Author can execute the
  split in under 30 minutes.

- **Moderate** — Some commits need to be split (one commit touches files
  on both sides of the seam). 1-2 cross-cutting fixups need extraction.
  Tests partially mixed with code but separable. Author needs an hour
  or two and some `git rebase -i` comfort. No deep conflict risk.

- **Difficult** — Deeply intermixed commits (every commit touches both
  sides of every seam). Schema migrations coupled with code changes.
  Very large commit count (50+) with heavy fixup noise that must be
  squashed before slicing. Cross-cutting refactor where each layer
  depends on the layer below — seams exist but each slice is still
  large. Author needs half a day or more, with real conflict risk and
  the chance of breaking intermediate states.

**Critical distinction: file-level seams vs commit-level seams.**

A seam can be **viable at the file level** (Slice A's files are clean and
self-contained, Slice B's files are clean and self-contained, no shared
files) but **fake at the commit level** (every commit touches files in
both slices, so cherry-picking commits would produce broken or partial
slices). When this happens, the author has to **rewrite** the commits,
not reorder them — squash everything down, then re-split along the file
seam by hand. This is the single most common reason effort jumps from
moderate to difficult.

If file seams are clean but commit seams are tangled, say so explicitly
in the report. Example: "Files partition cleanly along [per-layer], but
the 23 feature commits each touch both repository and service layers —
splitting requires rewriting commit history (squash + re-split), not
reordering."

Effort and splittability are independent axes. A PR can have very strong
file-level seams but be **difficult** to split because commits are
tangled. Conversely, a PR can be borderline splittable but **easy** to
split because the author already staged commits cleanly.

### Step 6: Recommendation

First, estimate the review cost and put it in the report. Careful review
proceeds at roughly 300-400 lines/hour and comprehension degrades sharply
past ~400 lines in one sitting, so:

```
review_sessions ≈ ceil(authored_lines_added / 400)
```

Frame the recommendation in these terms — "as-is this costs ~3 review
sittings with degrading attention; split, it's 4 CRs of one focused
sitting each". That comparison is what the human in the loop actually
needs to weigh.

**Mixed-intent rule (automatic).** If the diff mixes a behavior change
with a refactor or with mechanical churn (renames, reformatting, import
sorting), and the refactor-then-feature seam is viable, recommend the
split regardless of total size. A reviewer cannot verify
behavior-preservation and new behavior in the same pass — the refactor
needs a "this changes nothing" review and the feature needs a "this
changes exactly this" review.

Then combine splittability and effort:

| Splittable | Effort | Recommendation |
|------------|--------|----------------|
| No (under threshold post-exclusions) | n/a | Ship as-is. |
| No (over threshold, full seam sweep shows every catalog seam fake/n-a) | n/a | Ship as-is — but the report must show the sweep, not assert cohesion. "Indivisible" is only credible next to the per-category seam table. |
| Yes | Easy | **Split now.** Under 30 minutes of author time buys every reviewer a readable stack. There is no good reason to skip this. |
| Yes | Moderate | **Split by default.** Ship-as-is only with a named exemption: genuine urgency (hotfix, security embargo) or review already substantially complete (sunk reviewer cost). State which exemption applies; absent one, recommend the split. |
| Yes | Difficult | **Split when the stakes or the timing justify it**: high-stakes changes (security-sensitive, schema migrations on prod data, public API surface) or review not yet started. Ship-and-learn is acceptable only for lower-risk changes where review is already sunk — and even then, record the seams in the report so the next PR in this area is shaped right from the start. |

**Two pre-merge improvements, not one.** Splitting into multiple PRs and
cleaning up commit history are *separable* concerns:

- **PR split** = restructure the work into multiple Change Requests with
  their own review threads. Often medium-to-high effort, sometimes high
  value (review fatigue, blast radius, rollback granularity).
- **Commit cleanup** = squash fixup/lint/CI-debug/merge-from-main commits
  into the feature commits they correspond to. Always low effort
  (5-30 minutes with `git rebase -i`), reliably high value (reviewers
  see intent, not iteration noise).

If a PR has heavy fixup noise (10+ "address review feedback", "fix lint",
"CI debug" commits) but is otherwise the right size and shape, the
recommendation should be **commit cleanup, not split**. Both can also
apply — commit cleanup often needs to happen *before* a split is
mechanically possible.

**Prefer git-spice-style stacked CRs over independent PRs when**:
- Slices share a logical thread (refactor enabling feature)
- Lower slice is small enough to land fast, but reviewers can see the
  end goal in the stack
- The author can use an available stacking tool such as `gs stack submit`
  to push the whole stack at once and get review on the bottom while writing
  the top; if no such tool exists, translate the same dependency plan to the
  repository's branch and PR workflow

**Prefer independent PRs when**:
- Slices have no dependency (e.g., `apps/core-api` change vs
  `tools/bacstackcli` change with no shared code)
- One slice could reasonably land days or weeks before the other
- Slices have different reviewers or owners
- The seam is a drive-by extraction (unrelated work that snuck in)

### Step 7: Stack plan (only if recommending split)

Produce a concrete plan the author can execute. Each row in the stack:

- A **draft CR title** (conventional commits style if the repo uses it)
- The **files or path globs** that belong in the CR
- The **kind** (refactor / scaffold / feature / infra / tests / docs)
- **Depends on** — the parent CR (or `trunk` for the bottom of the stack)

Order the stack from base to top. Bottom CR depends on trunk; each
subsequent CR depends on the previous (or any earlier CR if the stack
branches).

---

## Output Format

For PRs over threshold:

```markdown
## Size Review: <PR#X — title> or <branch-name>

**Stats:**
- vs trunk (cumulative): N files raw → M after exclusions, +adds/-dels raw → +adds/-dels after exclusions, K commits
- vs <parent-branch> (slice): N files raw → M after exclusions, +adds/-dels raw → +adds/-dels after exclusions, K commits
  (omit slice line if not stacked)
- Excluded N files: <brief sample with line counts>
- Review cost: ~N review sittings as-is (at ~400 lines/sitting) vs M × 1-sitting CRs if split

**Verdict:** [Splittable — easy / Splittable — moderate / Splittable — difficult / Over threshold but indivisible (seam sweep below) / Already split — appropriately sized at slice level]
**Recommendation:** [Split now / Split by default — no exemption applies / Note seams for next time / Commit cleanup only / Ship as-is]

### Shape

<3-5 bullet observations from Step 3's structural signals. What shape is
this PR? Why is it the size it is? What did the author signal? If
existing stack, note that.>

### Seam Sweep

Cover **every** catalog category from Step 4 — one row each, including the
n/a rows. This table is how the human in the loop judges where to cut (and
trusts a "no seams" verdict).

| # | Seam type | Slice A | Slice B | Direction | Verdict |
|---|-----------|---------|---------|-----------|---------|
| 1 | per-layer | — | — | — | n/a — single-layer change |
| 2 | per-app | — | — | — | n/a — one app touched |
| 3 | refactor-then-feature | rename commits in pkg/foo/ | feat commits in apps/bar/ | A first | **viable** |
| 4 | scaffold-then-implement | — | — | — | fake — stub is replaced, not built on |
| 5 | test-infra-as-CR | fixture factories | tests using them | A first | **viable** |
| 6 | infra-vs-app-code | — | — | — | n/a — no infra files |
| 7 | docs-as-separate-CR | — | — | — | n/a — 12 doc lines, tightly coupled |
| 8 | drive-by extraction | unrelated phone validation files | rest of PR | independent PR | **viable** |

Only viable seams drive the stack plan. Every fake/n-a row needs its
one-line reason.

### Effort: [Easy / Moderate / Difficult]

<One paragraph explaining the rating. Specifically address:>
- Commit-level vs file-level fakeness (the critical distinction from Step 5)
- Conflict risk if commits get reordered or split
- Test-infra coupling (do tests need to move with the code they cover?)
- Drive-by extractions that need to come out separately

### Stack Plan

(Only present this section if the recommendation is "Split now" or "Split
by default" — any recommendation that asks the author to actually split.)

| CR | Title | Files | Kind | Depends on |
|----|-------|-------|------|------------|
| 1 | refactor(foo): rename Bar to Baz | pkg/foo/*.go | refactor | trunk |
| 2 | feat(bar): add new endpoint | apps/bar/api/*.go | feature | CR1 |
| 3 | test(bar): cover new endpoint | apps/bar/api/*_test.go | tests | CR2 |

If the recommendation involves drive-by extraction, list those as
**independent PRs** in a separate sub-section, not as stack members.

### Optional git-spice-style flow when available

Use these commands only when git-spice is available. Otherwise, keep the same
stack plan and translate it to the repository's available branch and PR workflow.

```bash
# If the PR has heavy fixup noise, squash by section first:
git rebase -i <base-ref>
# squash fix/lint/CI-debug commits into their parent feature commits

# Then start the stack from trunk when git-spice is installed:
git checkout <base-ref>
gs branch create refactor-foo-rename --target main
# cherry-pick or restack the relevant commits
gs branch create feat-bar-add-endpoint --target refactor-foo-rename
# ...
gs stack submit
```

Do not require git-spice or any optional Pi package; use available tools.
```

For PRs under threshold:

```markdown
## Size Review: <PR#X> or <branch-name>

**Stats:** N files raw → M after exclusions, +adds/-dels, K commits
(if exclusions were significant: "size signal dominated by N excluded
generated files")
**Verdict:** Appropriately sized
**Recommendation:** Ship as-is.
```

---

## Common pitfalls to avoid

- **Don't anchor on raw size**. A 900-line cohesive feature with clean
  commits is more reviewable than a 400-line cross-cutting refactor with
  50 fixup commits. Use the structural signals from Step 3. (Over the
  1,000-line hard ceiling this intuition no longer buys a pass — the
  seam sweep still has to earn ship-as-is.)
- **Don't recommend splits that produce broken intermediate states**.
  Verify the lower slice can compile and test alone before listing it
  as CR1.
- **Don't ignore an existing stack**. If the branch is already stacked
  on a non-trunk parent or the PR body says "Builds on #X", the author
  already practices stacking. Don't tell them to split unless the slice
  itself is too big.
- **Don't conflate effort with value**. A high-effort split can be the
  right call for high-stakes changes; a low-effort split with no viable
  seam is wasted motion. (When a viable seam exists and the split is
  easy, do it — that combination has no good counterargument.)
- **Don't recommend stacking when independence is the right shape**. If
  two slices truly don't depend on each other (different apps, different
  concerns, drive-by extraction), separate independent PRs are simpler
  than a stack — reviewers don't have to track the dependency.
- **Don't manufacture seams**. If the full sweep reveals no viable seam,
  say so directly and recommend ship-as-is. A "splittable but not
  worth the effort" verdict is honest; inventing a contrived split is
  not. Ruthlessness means exhaustive checking and split-leaning defaults,
  not fabricated cuts.
- **Don't be charitable about "cohesive"**. Cohesion is the most-claimed
  and least-verified property of large PRs. Over threshold, ship-as-is is
  earned by the per-category seam sweep, never by assertion — if the
  report says "indivisible" without showing each catalog seam failing,
  the analysis is incomplete.
- **Don't forget commit cleanup as a separate lever**. If the PR is the
  right size but the commit history is noisy, recommend a `git rebase -i`
  squash pass — that's a reviewability win independent of any split.
- **Don't silently drop excluded files**. The report should always show
  what was excluded and why so the reviewer can sanity-check the
  exclusion list.

---

## Output Actions

**Detect mode first.** Non-interactive (CI) only if any of `CI`,
`GITHUB_ACTIONS`, `GITLAB_CI`, or `BUILDKITE` equals `true`, or the user
explicitly asked for headless/CI/auto-post mode. The tool subprocess stdin may be non-TTY during an interactive session;
do **not** infer CI from it. Pi tools may run with non-TTY stdin during interactive sessions.

Before offering or executing GitHub PR delivery, require both preflight commands:

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
```

Only a PR plus successful preflight permits `gh pr comment`. If preflight passes
but the actual `gh pr comment` post fails, exit non-zero loudly; do not silently
fall back.

In non-interactive mode never prompt. With a PR and successful preflight, post the
report as a PR comment automatically. With a PR but `gh` unavailable or
unauthenticated, write `SIZE_REVIEW.md`, print the one-line summary, and state PR
delivery is unavailable; do not invoke `gh`. With no PR, write `SIZE_REVIEW.md`
and print `size-review: <verdict> · <recommendation>` to stdout.

In interactive mode with a PR and successful preflight, use `ask_user_question`
with the package `questions[]` JSON shape and 2-4 concise options. Include
`Post comment to PR #<N> (Recommended)`, `Write SIZE_REVIEW.md`, and
`Return inline` options when PR delivery is available. When a PR exists but
`gh` is unavailable or unauthenticated, do not offer the PR-post option: offer
`Write SIZE_REVIEW.md`, `Return inline`, or package free-form output and state
PR delivery is unavailable. With no PR, offer only available local or inline
delivery. The package provides the `Type something.` and `Chat about this`
free-form guidance; do not add manual pseudo-options.

If a stack plan was produced and the user wants to act on it, offer a handoff only to
tools or skills that are actually available. GitHub and git-spice delivery are
conditional on those tools being installed and authenticated; otherwise keep the
stack plan in `SIZE_REVIEW.md` or chat output. Use `SIZE_REVIEW.md`, never a
`CLAUDE_*` report filename.
