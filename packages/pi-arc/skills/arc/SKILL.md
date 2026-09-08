---
name: arc
description: General arc CLI reference and workflow context. Use when the user asks about arc commands, issue tracking workflows, when to use arc vs the bundled `todo` checklist, or needs help with arc configuration.
---

# Arc Issue Tracker

Track complex, multi-session work with a central issue tracking system.

## Setup

**For Pi users** (recommended):
1. Install the arc plugin (provides hooks, skills, agents)
2. Run `arc onboard` in any project - it will:
   - Resolve project from server-side path registration (primary mechanism)
   - Or detect from local project config (`~/.arc/projects/`)
   - Or prompt you to run `arc init` for new projects

**For non-Pi users**:
```bash
arc init                    # Initialize project
```

The plugin is the single source of truth for Pi integration. It provides:
- **Pi extension session-start and before-compaction handlers** - runs `arc prime` automatically
- **Prompt configuration** - reminds Pi to run `arc onboard`
- **Skills and resources** - detailed guides and reference
- **Agents** - for bulk operations

## When to Use Arc vs the bundled `todo` checklist

| Use Arc | Use the bundled `todo` checklist |
|---------|---------------|
| Multi-session work | Single-session tasks |
| Complex dependencies | Linear task lists |
| Discovered work patterns | Simple checklists |
| Work needing audit trail | Quick, disposable lists |

**Rule of thumb**: When in doubt, prefer arc—persistence you don't need beats lost context.

**Deep dive**: Run `arc docs boundaries` for detailed decision criteria.

## Workflow Skills

Arc includes workflow skills that guide you through the development lifecycle with built-in process discipline.

| Skill | Purpose | Invoke when |
|-------|---------|-------------|
| `brainstorm` | Design discovery through Socratic dialogue | Starting new features or significant work |
| `plan` | Break design into implementation tasks | After brainstorm approves a design |
| `build` | TDD execution via fresh subagents per task | Ready to implement planned tasks |
| `debug` | 4-phase root cause investigation | Encountering bugs or test failures |
| `verify` | Evidence-based completion gates | Before claiming any work is done |
| `review` | Code review dispatch and triage | After implementing a task |
| `finish` | Session completion protocol | Ending a work session |

### Pipeline

```
brainstorm → plan → build (per task) → review → finish
                        ↕          ↕
                      debug      verify
```

### Execution Paths

After `plan`, choose:
- **Single-agent + subagents**: Invoke `build`. Main agent orchestrates, subagents do TDD. Best for sequential tasks.
- **Parallel Arc build**: For independent task batches, `build` can use worktree-isolated `pi-subagents` runs when an external `pi-subagents` extension/tool is installed and Arc specialist definitions are available. Custom Arc specialists remain the preferred `pi-subagents` targets, and generic `worker`/`reviewer` agents should not be substituted for Arc gates. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.
- **Stacked PRs (arc + git-spice)**: When the epic is 3+ tasks with linear dependencies and each task is independently reviewable, ship as a stack of PRs instead of one. See [`STACKING.md`](../../STACKING.md) for the integration playbook (concept mapping, per-task loop, review iteration).

## Model policy

Arc recommends Luna for low-cost issue-manager/docs work, Terra at medium for standard builders, and Astra at high for planning and large-tier operations/review. Existing role profiles and explicit dispatch overrides remain authoritative. See [arc-build model selection](../arc-build/SKILL.md#model-selection) for role/effort guidance, supported-effort limits, and explicit `model:effort` dispatch examples.

## Quick Start

Run `arc onboard` at session start to get project context and available issues.

**Project Recovery**: If local project config is missing, `arc onboard` resolves the project via server-side path registration. The server is the source of truth for project-to-directory mappings.

## CLI Reference

Run `arc prime --session-id "${PI_SESSION_ID:?PI_SESSION_ID is required}"` for full workflow context, or `arc <command> --help` for specific commands.

## Session Binding

Operational claim commands and manual `arc prime` commands must pass `--session-id "${PI_SESSION_ID:?PI_SESSION_ID is required}"`. `PI_SESSION_ID` is the current shell session-manager identity; do not substitute an agent ID or another runtime's session value. The Pi extension captures its current session-manager identity for registration and its own prime command without mutating the process environment.

**Essential commands:**
- `arc ready` - Find unblocked work
- `arc create` - Create issues
- `arc update` - Update status/fields
- `arc close` - Complete work
- `arc show` - View details
- `arc dep` - Manage dependencies
- `arc plan` - Manage design plan reviews on the planner (create, show, approve, comments)
- `arc which` - Show active project and resolution source
- `arc paths` - Manage workspace path registrations
- `arc project` - Manage projects (list, create, delete, rename, merge)
- `arc self update` - Update arc CLI to latest version
- `arc db backup` - Create database backup

## Deep Dive Documentation

**Two-step workflow:**
1. **Search** to find which topic has the info: `arc docs search "query"`
2. **Read** the full topic for details: `arc docs <topic>`

```bash
# Search returns [topic] in brackets - tells you where to look
arc docs search "create issue"
# Results show: [workflows] Discovery and Issue Creation...

# Then read that topic for full content
arc docs workflows
```

Fuzzy matching handles typos - "dependncy" finds "dependency" docs.

**Available topics** with `arc docs <topic>`:

| Command | Purpose |
|---------|---------|
| `arc docs boundaries` | When to use arc vs the bundled `todo` checklist - decision matrix, integration patterns, common mistakes |
| `arc docs workflows` | Step-by-step checklists for session start, epic planning, side quests, handoff |
| `arc docs dependencies` | Dependency types (blocks, related, parent-child, discovered-from) and when to use each |
| `arc docs resumability` | Writing notes that survive compaction - templates and anti-patterns |
| `arc docs plans` | Plan patterns (inline, parent-epic, shared) with examples |
| `arc docs plugin` | Pi plugin and Codex CLI integration guide |

Run `arc docs` without a topic to see an overview.

## Agent Mode

For bulk operations, use the `arc-issue-manager` specialist. Non-delegating Arc commands continue without `pi-subagents`; every delegated specialist requires loaded, enabled `pi-subagents`.

Delegated Arc work requires loaded, enabled `pi-subagents` and the required Arc specialist. Check `subagent({ action: "list", capabilities: true })` first. Dispatch only executable, non-disabled native Arc agents; never substitute a generic agent for Arc review gates. Diagnose missing materialization with native doctor and existing Arc warnings. `/arc-subagents-sync` remains deprecated explicit repair, not automatic activation. If the requirement is still unmet, stop with setup guidance. `arc_agent` uses the same provider and is not an independent fallback.


Issue-manager dispatch is a direct single-child handoff: `subagent({ agent: "arc-issue-manager", task: "<filled manifest metadata and canonical file paths>", context: "fresh", async: true });`. Omit `model:` so the configured profile remains authoritative. Capture the receipt's native run reference, return control for native completion, and inspect final runtime state and artifacts before interpreting the specialist report.

On notification, inspect native terminal state and final artifacts before interpreting the completed Arc specialist report. Runtime failure, pause, stop, incomplete or malformed result blocks the Arc stage regardless of successful prose. A receipt cannot advance tests, review, patch application or issue closure. Preserve parent verification and review gates.


Native workflow, launch, extension or child-tooling failure is an infrastructure blocker. Record exact run/status, cwd/worktree/branch/HEAD and partial diff; stop and use only explicit same-protocol recovery. Never switch runner/provider/CLI mode or automatically retry an uncertain dispatch. Do not escalate models merely because the harness failed.


Coordinated build waves use one `workflowScript`; Arc does not implement scheduling, session, worktree, lifecycle, cancellation, completion-notification, or cleanup machinery already owned by `pi-subagents`.

## Dependency Types

Arc supports four dependency types:

| Type | Purpose | Affects Ready? |
|------|---------|----------------|
| **blocks** | Hard blocker - B can't start until A complete | Yes |
| **related** | Soft link - informational only | No |
| **parent-child** | Epic/subtask hierarchy | Yes |
| **discovered-from** | Track provenance of discovered work | No |

**Deep dive**: Run `arc docs dependencies` for examples and patterns.

## Design Reviews

Design docs live in `docs/plans/` as filesystem markdown. Arc registers them on the planner — a plain-HTTP review surface — at create time via the `/arc-brainstorm` skill. `/arc-plan` and any other consumer reads line 1 of the doc — `<!-- arc-review: id=<id> -->` — to get the plan ID.

**Surface:**

| Create command | URL pattern | Best for |
|---|---|---|
| `arc plan create --no-frontmatter <file>` | `http://localhost:7432/planner/<id>` | Design review via a markdown render with a comment thread |

The planner is plain HTTP with no encryption, edit tokens, or keys to manage; the URL is just the planner path.

### `arc plan` commands

| Command | Purpose |
|---------|---------|
| `arc plan create --no-frontmatter <file-path>` | Register a plan on the `/planner/<id>` surface (plain HTTP). There's no in-place update — re-running `create` produces a new ID. |
| `arc plan show <id>` | Print plan metadata + content (the metadata header includes `File: <path>`, useful for plan-file lookups) |
| `arc plan approve <id>` | Mark the plan as approved |
| `arc plan comments <id>` | List comments on the plan (flat thread; no Accept/Resolve/Reject states) |

### Review cycle

create → reviewers leave comments → author reads the thread inline and decides which to act on → approved design content is written into the epic's description field when creating implementation tasks. Run `arc docs plans` for full details.

The `<!-- arc-review: id=… -->` marker on line 1 of every registered design doc gives downstream skills the plan ID for the CLI calls above. See `skills/arc-brainstorm/SKILL.md` step 6 for the marker-write contract and `skills/arc-plan/SKILL.md` step 1 for the read pattern.

## Labels

Labels are global (shared across all projects) and support colors and descriptions. Use labels for cross-cutting categorization like `security`, `performance`, `tech-debt`.

## Session Protocol

**At session start:**
```bash
arc onboard  # Get context, recover project if needed
```

**Before ending any session:**
Invoke the `finish` skill — it handles capturing remaining work, quality gates, arc updates, commit, and push. Work is NOT done until `git push` succeeds.

**Writing notes for resumability:**
```bash
arc update <id> --stdin <<'EOF'
COMPLETED: X. IN PROGRESS: Y. NEXT: Z
EOF
```

**Deep dive**: Run `arc docs resumability` for templates.

## Common Workflows

### Starting Work
```bash
arc onboard                         # Get context (recovers project if needed)
arc ready                           # Find available work
arc show <id>                       # View details
arc update <id> --take --session-id "${PI_SESSION_ID:?PI_SESSION_ID is required}" # Claim work (sets session ID + in_progress)
```

### Creating Issues
```bash
arc create "Title" -t task          # Create task
arc create "Epic title" -t epic     # Create epic
arc create "Subtask" --parent <epic-id>  # Create child issue
arc dep add child-id parent-id --type parent-child  # Or link existing issue to epic

# With multi-line description (use --stdin flag):
arc create "Title" -t task --stdin <<'EOF'
Description with context, acceptance criteria, etc.
EOF
```

### Completing Work
```bash
arc close <id> --reason "done"      # Complete issue
arc ready                           # See what unblocked
```

**Deep dive**: Run `arc docs workflows` for complete checklists.
