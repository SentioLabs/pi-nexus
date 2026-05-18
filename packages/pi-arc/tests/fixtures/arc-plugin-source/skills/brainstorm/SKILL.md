---
name: brainstorm
description: You MUST use this skill for any design exploration, architecture decision, or trade-off analysis before implementation begins — especially when the user says "brainstorm", "explore the design", "think through", "what approach should we take", or describes a feature with multiple valid strategies. This is the arc-native brainstorming skill that writes designs to docs/plans/ and registers them on one of three review surfaces (legacy `arc plan`, encrypted local `arc share`, or encrypted remote `arc share --remote`), depending on who's reviewing and whether encryption is needed. Always prefer this over generic brainstorming when the project uses arc issue tracking.
---

# Brainstorm — Design Discovery

Explore requirements through Socratic dialogue before any implementation begins.

## Hard Gate

**Do NOT write any implementation code, scaffold any project, or take any implementation action until the design is approved.** Brainstorming produces a design document — not code.

## Pre-flight: Branch Setup

Before starting the design dialogue, perform the protected-branch check per `skills/arc/_branch-check.md`.

Brainstorm itself doesn't commit code, but the design doc, the planned tasks, the eventual implementation, and the final commits will all land on whatever branch you start from. Catching trunk *now* avoids "we built three hours of work and it's all on main" at finish time. If the user picks "switch to a feature branch", suggest a name based on the brief they just gave you (e.g. `feat/<topic>`).

## Workflow

Create a task for each step below using `TaskCreate`. Mark each as `in_progress` when starting and `completed` when done. This creates a visible progress list in the CLI that carries forward into the plan skill. Step 5.5 gets its own task whether or not the user opts into grilling — "No, proceed" still counts as completing the step.

### 1. Explore Project Context

- Check existing files, docs, recent commits
- Review existing arc issues (`arc list`)
- Understand what already exists and what constraints are in play

**Scope check before proceeding:** Before asking detailed clarifying questions, assess whether the request describes multiple independent subsystems (e.g., "build a platform with chat, storage, billing, and analytics"). If so, help the user decompose into sub-projects first — each sub-project gets its own brainstorm → plan → implement cycle. Don't spend questions refining details of a project that needs to be split. A decomposition sketch (what are the independent pieces, how do they relate, what order should they be built) is more valuable than a half-specified monolith.

### 2. Ask Clarifying Questions

- Ask questions **one at a time** — don't dump a list
- **Use the AskUserQuestion tool** for multiple-choice decisions (2-4 options)
- Use open-ended text questions only when you need freeform feedback
- Understand: purpose, constraints, success criteria, target users
- Continue until you have enough to propose approaches

**If the user forecloses clarifying questions up front** (e.g., "no clarifying questions, just proceed", "skip to the design", "don't ask, just build"), keep this step's questions to a minimum or skip them. Step 5.5 is the explicit recovery loop in that case — depth-first interrogation against a draft, which is harder to skip past than a soft Q&A. Default 5.5's recommendation to *"Yes, grill me"* whenever step 2 was foreclosed, regardless of scale.

**Example AskUserQuestion usage:**
```
Question: "How should we handle session persistence?"
Options:
  - "In-memory only" (simplest, lost on restart)
  - "SQLite" (persistent, single-node, matches existing storage)
  - "Redis" (distributed, adds infrastructure dependency)
```

### 3. Propose 2-3 Approaches

- Each approach: summary, trade-offs, estimated complexity
- Include a recommendation with reasoning
- **Use the AskUserQuestion tool** to present approaches as structured choices
- Apply YAGNI — remove features from all designs that aren't explicitly required

**Example AskUserQuestion usage:**
```
Question: "Which approach should we go with?"
Options:
  - "Approach A: ..." (recommended — trade-offs...)
  - "Approach B: ..." (trade-offs...)
  - "Approach C: ..." (trade-offs...)
```

**Capability-aware hint:** When comparing approaches, surface which imply heavier subagent model tiers during implementation. Approaches with more cross-cutting concerns, more files touched, or tighter coupling between components will likely need `opus`-tier dispatches and more review cycles. Approaches that decompose cleanly into single-file, mechanical tasks will run on `haiku`/`sonnet` and iterate faster. This is a soft consideration, not a deciding factor — but the user should see it.

### 4. Present Design Section by Section

- Break the design into logical sections (data model, API, UI, etc.)
- Present each section and get user approval before moving to the next
- Iterate on sections as needed based on feedback

**Design for isolation and clarity:** Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently. For each unit, you should be able to answer three questions: what does it do, how do you use it, and what does it depend on. Smaller, well-bounded units are also easier for subagents to work with — they reason better about code they can hold in context at once, and their edits are more reliable when files are focused. If a file in the design is projected to grow large, that's often a signal that it's doing too much — consider splitting the responsibility at design time.

**In existing codebases:** Follow existing patterns. Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design — the way a good developer improves code they're working in. Don't propose unrelated refactoring. Stay focused on what serves the current goal.

### 5. Identify Shared Contracts (Parallel Readiness)

If the design will produce multiple implementation tasks that could run in parallel, explicitly identify the **shared contracts** — types, interfaces, config keys, constants, and function signatures that multiple tasks will reference.

Contracts fall into two tiers:

- **Shared contracts** (referenced by 2+ tasks): produce **exact, copy-pasteable code blocks** including the type definition AND a contract test assertion. The T0 foundation task will write these verbatim.
- **Task-internal types** (used within a single task): use typed pseudocode (e.g., `FeedbackRequest { memory_id: i64, rating: i8 }`) — the subagent adapts to language idioms during implementation.

Present shared contracts to the user as a "foundation layer" with exact code:

```go
// internal/types/config.go

// SessionConfig holds session-related settings.
type SessionConfig struct {
	Timeout  time.Duration `json:"timeout"`
	MaxIdle  int           `json:"max_idle"`
	Secure   bool          `json:"secure"`
}
```

```go
// internal/storage/storage.go

// GetSession retrieves a session by ID.
// Returns nil and no error if the session does not exist.
GetSession(ctx context.Context, id string) (*Session, error)
```

Contract test assertions verify that the shared types satisfy compile-time expectations. Place these **inline in each relevant test file** with a clear separator:

```go
// internal/types/config_test.go

// --- Contract assertions ---

// Verify SessionConfig fields exist with expected types.
var _ time.Duration = SessionConfig{}.Timeout
var _ int = SessionConfig{}.MaxIdle
var _ bool = SessionConfig{}.Secure
```

```go
// internal/storage/sqlite/sqlite_test.go

// --- Contract assertions ---

// Verify SQLiteStore satisfies the Storage interface.
var _ storage.Storage = (*SQLiteStore)(nil)
```

These exact definitions and contract tests become the **T0 foundation task** during planning — implemented sequentially before any parallel work begins. The T0 task writes the shared type files and embeds contract test assertions inline in each relevant test file, so that parallel agents can import these types immediately and any drift is caught at compile time.

**Skip this step** if the design maps to a single task or purely sequential work.

### 5.5. Grill the Design (Optional Stress-Test)

Before publishing the design for review, save the draft to disk and offer a stress-test pass. Both this step and step 6 need the design as a file on disk, so first:

- **Write the design document** to `docs/plans/` using `YYYY-MM-DD-<topic>.md` naming. Do this whether or not the user opts into grilling — step 6 picks it up either way.

Then run a relentless-interrogation pass that probes the drafted design for unresolved *internal* decisions before publishing. This is a distinct job from step 7's review loop: that one processes external reviewer feedback you receive back; this one finds gaps the design didn't fully resolve, which become expensive to fix once implementation starts — and prevents publishing a version that's already known to be incomplete.

**When to recommend it.** This is opt-in. Mark "grill" as recommended when the design appears Medium/Large per the Scale Detection table (multiple work items, multiple layers crossed, or migrations/breaking changes). For Small-scale single-task work, default the recommendation to "skip" — the overhead isn't worth it.

**Always recommend grilling when step 2 was foreclosed.** If the user shut down clarifying questions up front, this is the recovery loop — override the scale-based default and mark *"Yes, grill me"* as recommended regardless of how small the design looks.

**Use the AskUserQuestion tool:**

```
Question: "Stress-test the design before publishing?"
Options:
  - "Yes, grill me" — interrogate decisions one at a time until we converge
  - "No, proceed" — skip to step 6 register for review
```

If "Yes", run the loop:

**Loop rules:**

- Walk the design's decision tree **depth-first, ordered by dependency**. Resolve decisions that constrain later answers first (e.g., "what storage layer?" before "how do we serialize sessions?"). When a resolution opens new branches, recurse into them before backtracking.
- **One question per turn** via `AskUserQuestion`. Mark the recommended option. When the choice is genuinely contested, offer 2-3 options; when one option is objectively dominant, a single recommendation is fine — but never rubber-stamp open questions just because you have an opinion.
- **Codebase-first rule.** Before each question, name the symbol, file, or pattern that would answer it. If you can name one, search first (Grep / Read / symbol search) and only ask when the codebase doesn't — or can't — answer. This is the single biggest difference from step 2's clarifying questions, where you don't yet have a draft to ground against.
- **Capture resolutions in-place.** Each resolved decision is an edit to `docs/plans/<file>.md` — update the relevant section, don't maintain a separate Q&A log. The design doc is the artifact.

**Stop when ANY of:**

- The user says "done", "enough", or "stop"
- Two consecutive rounds surface no new unresolved branches (the tree is exhausted)
- The loop has run ~10 rounds (hard cap — if you still have open branches at this point, surface them as a "remaining open questions" note in the design doc instead of asking another)

Then proceed to step 6.

### 6. Register for Review

The design doc already exists on disk from step 5.5. This step registers it for review on the surface the user picks.

Arc supports three review surfaces. They differ along two axes — *who reviews* (just you vs. teammates on other machines) and *do you want encryption + the new annotation/accept-resolve UI* (legacy planner is plain HTTP and simpler; `arc share` is encrypted and richer). Pick based on how the design will actually be reviewed, not which command you happen to remember.

**Use the AskUserQuestion tool:**

```
Question: "How would you like to review this design?"
Options:
  - "Legacy planner (solo, plain HTTP, simplest)" —
      `arc plan` surface at /planner/<id>. No encryption, no accept-resolve;
      just a comment thread on a markdown render. Best when you want quick
      review notes without setting up the share UI.
  - "Encrypted local share (solo, but want annotations/accept-resolve)" —
      `arc share` on this machine. Plan content + comments are encrypted at
      rest in ~/.arc/data.db. Reviewer URL only works from this machine.
  - "Encrypted remote share (multiple reviewers)" —
      `arc share` on the configured remote server (default arcplanner.sentiolabs.io).
      Reviewers on other machines can open the link.
  - "Save for later" — keep the saved file (from step 5.5) and stop. No
      server registration; resume in a new session. **Terminates the
      skill — skip steps 7 and 8.**
```

Route on the answer:

| Choice | CLI to run | Marker `kind=` | URL printed |
|---|---|---|---|
| Legacy planner | `arc plan create docs/plans/<file>.md` | `legacy` | `Review at: http://localhost:7432/planner/<id>` |
| Encrypted local | `arc share create docs/plans/<file>.md` | `share-local` | `Preview URL (local-only — not reachable by others):` |
| Encrypted remote | `arc share create docs/plans/<file>.md --remote` | `share-remote` | `Author URL (keep private — open it, then use the in-page Share link button to copy a reviewer URL):` |
| Save for later | (no command) | (no marker) | n/a |

**Capture the ID and write the review marker.** After the create call succeeds, prepend a single HTML-comment line to the design doc so `/arc:plan` (and any future skill that queries review state) knows which CLI to call. Today only `/arc:plan` reads it — `/arc:build` and the dispatched implementer/reviewer agents read design content from the parent epic's description, not from the share/plan CLIs — but the marker is the canonical record of which surface this doc lives on. Without it, downstream falls back to `arc share list --json | jq` which doesn't cover legacy plans.

```bash
# Run the chosen CLI and capture stdout.
OUT=$(arc share create docs/plans/2026-05-01-foo.md --remote)
echo "$OUT"   # ALWAYS print verbatim — the user needs to see the URL

# Extract the ID:
#   - share-local / share-remote: the URL fragment contains /share/<id>#...
#   - legacy: the first line is "Plan created: <id> (file: ..., status: ...)"
ID=$(echo "$OUT" | grep -oE '/share/[^#]+' | head -1 | sed 's|/share/||')
# For legacy, instead:  ID=$(echo "$OUT" | grep -oE 'Plan created: \S+' | awk '{print $3}')

KIND="share-remote"   # legacy | share-local | share-remote (matches the chosen branch)

# Prepend the marker idempotently. If line 1 already starts with "<!-- arc-review:",
# replace it; otherwise prepend a new line.
FILE="docs/plans/2026-05-01-foo.md"
if head -1 "$FILE" | grep -q '^<!-- arc-review:'; then
  sed -i.bak "1s|.*|<!-- arc-review: kind=$KIND id=$ID -->|" "$FILE" && rm "$FILE.bak"
else
  { echo "<!-- arc-review: kind=$KIND id=$ID -->"; cat "$FILE"; } > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
fi
```

The marker format is fixed: `<!-- arc-review: kind=<legacy|share-local|share-remote> id=<id> -->`. Always line 1, always exactly one space between fields.

**URL handling rules — print exactly what the CLI printed, then add a kind-specific instruction:**

- **Legacy** — print the `Review at:` line. Tell the user this URL is local-only (their browser must reach `http://localhost:7432`).
- **Encrypted local** — print the Preview URL line. Tell the user it's not reachable from other machines; if they need a reviewer on a different machine, re-create the share with `--remote` instead.
- **Encrypted remote** — print the Author URL line. Then tell the user: *"Open this URL yourself; that's the author view. To send a reviewer link, click the **Share link** button in the page header — it strips `&t=` and copies a reviewer URL to your clipboard. Don't paste the Author URL into chat or tickets — the `&t=` token gives the recipient your edit privileges."*

The encrypted-share CLI persists the edit_token + key into the local arc keyring (a `shares` table in `~/.arc/data.db`, served by the local arc-server — never written to disk as JSON). If a share Author URL is lost, regenerate it with `arc share show <id> --author-url`. Legacy plans don't have this — the URL is just `<base>/planner/<id>` and there are no edit tokens.

### 7. Review Loop

**Skip this step entirely if step 6's answer was "Save for later"** — no surface was registered, no URL exists, no marker was written. Step 6 already terminated the skill in that case.

Otherwise, print the URL from step 6 again as a reminder. **Use the AskUserQuestion tool:**

```
Question: "Design ready for review at <url> — how would you like to proceed?"
Options:
  - "Approve" — mark the design approved and proceed to step 8
      routing analysis
  - "I've finished review (pull comments now)" — fetch reviewer feedback,
      apply edits, re-share if needed, repeat
  - "Pause review" — design is saved; resume in a new session
```

Branch the CLI by the marker's `kind`:

| kind | Approve | Pull comments |
|---|---|---|
| `legacy` | `arc plan approve <id>` | `arc plan comments <id>` (no accepted-only filter — review the thread inline) |
| `share-local` | `arc share approve <id>` | `arc share pull <id>` (accepted-only by default) |
| `share-remote` | `arc share approve <id>` | `arc share pull <id>` (accepted-only by default) |

**Why the legacy path lacks `pull`:** legacy plan comments don't have an Accept/Resolve/Reject state — they're a flat thread. The trade-off was made when picking legacy in step 6; if the volume of comments grows, suggest re-creating the design as `share-local` so the user gets the accepted-only filter.

**For `share-local` / `share-remote`** — only `accepted` comments flow into refinement when pulled. The author is the only one who can mark comments as `accepted` (verified by the plan's `author_name`). For `share-remote`, reviewers comment via the reviewer URL (the in-page Share link button; *not* the Author URL).

After a refinement pass, if the design changed materially, update the review surface to match the new content. The CLI and marker handling differ by `kind`:

| kind | Update CLI | ID stable? | Marker action |
|---|---|---|---|
| `share-local` / `share-remote` | `arc share update <id> <plan-file>` | yes | leave marker as-is |
| `legacy` | `arc plan create <plan-file>` (no in-place update — re-creates with a new ID) | **no — new ID** | rewrite line 1 with the new ID |

For legacy, after re-creating, replace the `id=<old>` portion of line 1 with the new ID — the idempotent `sed` snippet from step 6 works as-is: set `KIND=legacy` and `ID=<new>` and the "marker already present" branch overwrites line 1. Then loop back to step 7.

### 8. Routing Analysis & Transition

After the design is approved (step 7's Approve), **you MUST produce a routing analysis before presenting options**. This analysis helps the user make an informed decision about what to do next.

#### Routing Analysis

Evaluate the approved design against these criteria and present a summary:

| Factor | Assessment |
|--------|------------|
| **Work items** | Count of distinct implementation tasks identified in the design |
| **Parallel readiness** | Were shared contracts identified in step 5? (yes = plan needed for T0 sequencing) |
| **Files touched** | Approximate number of files created or modified |
| **Layers crossed** | Which architecture layers are involved (storage, API, CLI, frontend, tests) |
| **Risk areas** | Any migrations, API changes, or breaking changes? |
| **Scale** | Small / Medium / Large (from Scale Detection table) |

Then produce a **recommendation** with reasoning:

```
📊 Routing Analysis
───────────────────
Work items:       N tasks identified
Parallel ready:   Yes/No (shared contracts in step 5)
Files touched:    ~N files across N directories
Layers crossed:   [storage, API, CLI, ...]
Risk areas:       [migrations, breaking changes, none, ...]
Scale:            Small / Medium / Large

➤ Recommendation: /arc:plan | /arc:build
  Reason: <1-2 sentence justification based on the factors above>
```

**Routing rules** (use these to drive the recommendation):
- **→ arc:plan** when ANY of: 2+ work items, shared contracts exist, multiple layers crossed, migrations or breaking changes present, medium/large scale
- **→ arc:build** when ALL of: single work item, no shared contracts, single layer, no risk areas, small scale
- When borderline, recommend `arc:plan` — the overhead of planning is low, but the cost of a disorganized multi-task implementation is high

After the analysis, use the **AskUserQuestion tool** — mark the recommended option:
```
Question: "Design approved! What's next?"
Options:
  - "Break into tasks with /arc:plan" (recommended — <brief reason from analysis>)
  - "Implement directly with /arc:build" (for small, single-task work)
  - "Done for now" (design is saved — continue in a new session)
```

If `/arc:build` is recommended instead, swap which option gets the "(recommended)" tag.

- **Break into tasks**: invoke the `plan` skill, passing the review ID from the line-1 marker (the `id=…` value; whether it's a legacy plan ID or a share ID depends on `kind=…`)
- **Implement directly**: invoke the `implement` skill
- **Done for now**: tell the user the design is approved and they can run `/arc:plan` in a new session

## Scale Detection

| Indicator | Scale | Structure |
|-----------|-------|-----------|
| Multiple phases, weeks of work, cross-cutting concerns | Large | Meta epic → phase epics → tasks |
| Single feature, days of work, contained scope | Medium | Epic → tasks |
| One task, hours of work, obvious approach | Small | Single issue |

## Rules

- The ONLY next skill after brainstorm is `plan` (or `implement` for small work)
- Never invoke implementation skills from brainstorm
- Design documents go in `docs/plans/` and are registered via one of three review surfaces (`arc plan create` for legacy, `arc share create` for encrypted local, `arc share create … --remote` for encrypted remote). The skill writes a `<!-- arc-review: kind=… id=… -->` marker as line 1 of the doc so downstream skills can route their CLI calls.
- Arc issues track persistent work; TaskCreate/TaskUpdate tracks workflow progress in the CLI
- YAGNI: if the user didn't ask for it, don't design it
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
