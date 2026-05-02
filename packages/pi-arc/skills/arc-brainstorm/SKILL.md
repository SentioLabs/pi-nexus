---
name: arc-brainstorm
description: You MUST use this skill for any design exploration, architecture decision, or trade-off analysis before implementation begins — especially when the user says "brainstorm", "explore the design", "think through", "what approach should we take", or describes a feature with multiple valid strategies. This is the arc-native brainstorming skill that writes designs to docs/plans/ and registers them on one of three review surfaces (legacy `arc plan`, encrypted local `arc share`, or encrypted remote `arc share --remote`), depending on who's reviewing and whether encryption is needed. Always prefer this over generic brainstorming when the project uses arc issue tracking.
---

# Brainstorm — Design Discovery

Explore requirements through Socratic dialogue before any implementation begins.

## Hard Gate

**Do NOT write any implementation code, scaffold any project, or take any implementation action until the design is approved.** Brainstorming produces a design document — not code.

## Workflow

Create a task for each step below using the bundled `todo` checklist (via `todo` tool / `/todos`). Mark each as `in_progress` when starting and `completed` when done. This creates a visible progress list in the CLI that carries forward into the plan skill.

### 1. Explore Project Context

- Check existing files, docs, recent commits
- Review existing arc issues (`arc list`)
- Understand what already exists and what constraints are in play

**Scope check before proceeding:** Before asking detailed clarifying questions, assess whether the request describes multiple independent subsystems (e.g., "build a platform with chat, storage, billing, and analytics"). If so, help the user decompose into sub-projects first — each sub-project gets its own brainstorm → plan → implement cycle. Don't spend questions refining details of a project that needs to be split. A decomposition sketch (what are the independent pieces, how do they relate, what order should they be built) is more valuable than a half-specified monolith.

### 2. Ask Clarifying Questions

- Ask questions **one at a time** — don't dump a list
- Use open-ended text questions only when you need freeform feedback
- Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool for structured decisions with 2-4 authored options per question.
- Ask one conceptual decision at a time, but when several related structured decisions are already known, group them in one `ask_user_question` invocation using `questions[]`.
- Do not manually author package sentinel labels (`Type something.`, `Chat about this`, `Other`, `Next`); the package appends its own escape hatches where supported.
- Where a recommendation is clear, make it the first option, append `(Recommended)` to the label, and explain why in the description.
- Understand: purpose, constraints, success criteria, target users
- Continue until you have enough to propose approaches

**Example `ask_user_question` usage:**
```json
{
  "questions": [
    {
      "header": "Session",
      "question": "How should we handle session persistence?",
      "options": [
        {
          "label": "SQLite (Recommended)",
          "description": "Persistent, single-node, matches existing storage, and avoids new infrastructure."
        },
        {
          "label": "In-memory only",
          "description": "Simplest option, but sessions are lost on restart."
        },
        {
          "label": "Redis",
          "description": "Supports distributed deployments, but adds an infrastructure dependency."
        }
      ]
    }
  ]
}
```

### 3. Propose 2-3 Approaches

- Each approach: summary, trade-offs, estimated complexity
- Include a recommendation with reasoning
- **Use the `ask_user_question` tool** to present approaches as structured choices
- Apply YAGNI — remove features from all designs that aren't explicitly required

**Example `ask_user_question` usage:**
```json
{
  "questions": [
    {
      "header": "Approach",
      "question": "Which approach should we go with?",
      "options": [
        {
          "label": "Approach A (Recommended)",
          "description": "Best balance of scope, risk, and implementation speed for the current constraints."
        },
        {
          "label": "Approach B",
          "description": "Lower short-term code churn, but leaves more long-term maintenance risk."
        },
        {
          "label": "Approach C",
          "description": "Most flexible, but likely needs larger-model implementation and more review cycles."
        }
      ]
    }
  ]
}
```

**Capability-aware hint:** When comparing approaches, surface which imply heavier subagent model tiers during implementation. Approaches with more cross-cutting concerns, more files touched, or tighter coupling between components will likely need `large`-tier dispatches and more review cycles. Approaches that decompose cleanly into single-file, mechanical tasks will run on `small`/`standard` and iterate faster. This is a soft consideration, not a deciding factor — but the user should see it.

### 4. Present Design Section by Section

- Break the design into logical sections (data model, API, UI, etc.)
- Present each section and get user approval before moving to the next
- Iterate on sections as needed based on feedback

**Design for isolation and clarity:** Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently. For each unit, you should be able to answer three questions: what does it do, how do you use it, and what does it depend on. Smaller, well-bounded units are also easier for subagents to work with — they reason better about code they can hold in context at once, and their edits are more reliable when files are focused. If a file in the design is projected to grow large, that's often a signal that it's doing too much — consider splitting the responsibility at design time.

**In existing codebases:** Follow existing patterns. Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design — the way a good developer improves code they're working in. Don't propose unrelated refactoring. Stay focused on what serves the current goal.

### 5. Identify Shared Contracts (Parallel Readiness)

If the design can produce independent implementation tasks, the brainstorm output must include a `## Parallel Readiness` section **before** `/arc-plan` creates Arc issues. Use these exact subsection headings:

```markdown
## Parallel Readiness

### T0 Foundation Decision

### File Ownership Matrix

### Parallel Batch Manifest

### Validation Matrix
```

- `T0 Foundation Decision` records the sequential foundation step that must land first when multiple tasks depend on the same shared contracts.
- `File Ownership Matrix` assigns every implementation file to exactly one task. Any overlap must be moved to T0, serialized with dependencies, or merged into one task.
- `Parallel Batch Manifest` lists the batches, their prerequisites, the tasks in each batch, the independence proof, and the validation.
- `Validation Matrix` shows which checks prove each batch or task is safe to merge.

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

### 6. Save Design and Register for Review

Write the design document to `docs/plans/` using `YYYY-MM-DD-<topic>.md` naming.

Arc supports three review surfaces. They differ along two axes — *who reviews* (just you vs. teammates on other machines) and *do you want encryption + the new annotation/accept-resolve UI* (legacy planner is plain HTTP and simpler; `arc share` is encrypted and richer). Pick based on how the design will actually be reviewed, not which command you happen to remember.

**Use the `ask_user_question` tool:**

```json
{
  "questions": [
    {
      "header": "Review",
      "question": "How would you like to review this design?",
      "options": [
        {
          "label": "Legacy planner",
          "description": "Solo plain-HTTP review at /planner/<id>; simplest, with no encryption or accept/resolve UI."
        },
        {
          "label": "Encrypted local",
          "description": "Solo encrypted review with annotations and accept/resolve UI on this machine only."
        },
        {
          "label": "Encrypted remote",
          "description": "Multiple reviewers can open the remote encrypted share; the author URL must stay private."
        },
        {
          "label": "Save for later",
          "description": "Write the design file to docs/plans and skip server registration for now."
        }
      ]
    }
  ]
}
```

Route on the answer:

| Choice | CLI to run | Marker `kind=` | URL printed |
|---|---|---|---|
| Legacy planner | `arc plan create docs/plans/<file>.md` | `legacy` | `Review at: http://localhost:7432/planner/<id>` |
| Encrypted local | `arc share create docs/plans/<file>.md` | `share-local` | `Preview URL (local-only — not reachable by others):` |
| Encrypted remote | `arc share create docs/plans/<file>.md --remote` | `share-remote` | `Author URL (keep private — open it, then use the in-page Share link button to copy a reviewer URL):` |
| Save for later | (no command) | (no marker) | n/a |

**Capture the ID and write the review marker.** After the create call succeeds, prepend a single HTML-comment line to the design doc so `/arc-plan` (and any future skill that queries review state) knows which CLI to call. Today only `/arc-plan` reads it — `/arc-build` and the dispatched implementer/reviewer agents read design content from the parent epic's description, not from the share/plan CLIs — but the marker is the canonical record of which surface this doc lives on. Without it, downstream falls back to `arc share list --json | jq` which doesn't cover legacy plans.

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

Print the URL from step 6 again as a reminder. **Use the `ask_user_question` tool:**

```json
{
  "questions": [
    {
      "header": "Review",
      "question": "Plan ready for review at <url> — how would you like to proceed?",
      "options": [
        {
          "label": "Approve",
          "description": "Mark the design approved and continue to routing analysis."
        },
        {
          "label": "Pull comments",
          "description": "Fetch reviewer feedback, apply accepted changes, update the review surface, and repeat review."
        },
        {
          "label": "Save for later",
          "description": "Leave the design saved in docs/plans and resume in a future session."
        }
      ]
    }
  ]
}
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

After the plan is approved, **you MUST produce a routing analysis before presenting options**. This analysis helps the user make an informed decision about what to do next.

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

```text
📊 Routing Analysis
───────────────────
Work items:       N tasks identified
Parallel ready:   Yes/No (shared contracts in step 5)
Files touched:    ~N files across N directories
Layers crossed:   [storage, API, CLI, ...]
Risk areas:       [migrations, breaking changes, none, ...]
Scale:            Small / Medium / Large

➤ Recommendation: /arc-plan | /arc-build
  Reason: <1-2 sentence justification based on the factors above>
```

**Routing rules** (use these to drive the recommendation):
- **→ arc:plan** when ANY of: 2+ work items, shared contracts exist, multiple layers crossed, migrations or breaking changes present, medium/large scale
- **→ arc:build** when ALL of: single work item, no shared contracts, single layer, no risk areas, small scale
- When borderline, recommend `arc:plan` — the overhead of planning is low, but the cost of a disorganized multi-task implementation is high

After the analysis, use the **`ask_user_question` tool** — mark the recommended option:
```json
{
  "questions": [
    {
      "header": "Next",
      "question": "Design approved! What's next?",
      "options": [
        {
          "label": "Break into tasks (Recommended)",
          "description": "Recommended when the design has multiple work items, shared contracts, multiple layers, migrations, breaking changes, or medium/large scale."
        },
        {
          "label": "Implement directly",
          "description": "Use only for small designs with one work item, one layer, no shared contracts, and no risk areas."
        },
        {
          "label": "Done for now",
          "description": "The design is approved and saved; continue with /arc-plan in a future session."
        }
      ]
    }
  ]
}
```

If `/arc-build` is recommended instead, swap which option gets the "(recommended)" tag.

- **Break into tasks**: invoke the `plan` skill, passing the plan ID
- **Implement directly**: invoke the `implement` skill
- **Done for now**: tell the user the plan is approved and they can run `/arc-plan` in a new session

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
- Arc issues track persistent work; the bundled `todo` checklist tracks in-session workflow progress in the CLI
- YAGNI: if the user didn't ask for it, don't design it
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
