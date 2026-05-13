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
- **SessionStart/PreCompact hooks** - runs `arc prime` automatically
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
| `implement` | TDD execution via fresh subagents per task | Ready to implement planned tasks |
| `debug` | 4-phase root cause investigation | Encountering bugs or test failures |
| `verify` | Evidence-based completion gates | Before claiming any work is done |
| `review` | Code review dispatch and triage | After implementing a task |
| `finish` | Session completion protocol | Ending a work session |

### Pipeline

```
brainstorm → plan → implement (per task) → review → finish
                        ↕          ↕
                      debug      verify
```

### Execution Paths

After `plan`, choose:
- **Single-agent + subagents**: Invoke `implement`. Main agent orchestrates, subagents do TDD. Best for sequential tasks.
- **Parallel Arc build**: For independent task batches, `implement` can use worktree-isolated `pi-subagents` runs when an external `pi-subagents` extension/tool is installed and Arc specialist definitions are available. Custom Arc specialists remain the preferred `pi-subagents` targets, and generic `worker`/`reviewer` agents should not be substituted for Arc gates. This is not Claude-style team deployment; the orchestrator still owns verification, patch application, issue closure, and handoff.
- **Stacked PRs (arc + git-spice)**: When the epic is 3+ tasks with linear dependencies and each task is independently reviewable, ship as a stack of PRs instead of one. See [`STACKING.md`](../../STACKING.md) for the integration playbook (concept mapping, per-task loop, review iteration).

## Quick Start

Run `arc onboard` at session start to get project context and available issues.

**Project Recovery**: If local project config is missing, `arc onboard` resolves the project via server-side path registration. The server is the source of truth for project-to-directory mappings.

## CLI Reference

Run `arc prime` for full workflow context, or `arc <command> --help` for specific commands.

**Essential commands:**
- `arc ready` - Find unblocked work
- `arc create` - Create issues
- `arc update` - Update status/fields
- `arc close` - Complete work
- `arc show` - View details
- `arc dep` - Manage dependencies
- `arc share` - Manage encrypted plan shares (create, show, approve, comments, pull, list, update, delete)
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

For bulk operations (creating epics with tasks, batch updates), use the **issue-manager** agent via the Task tool. This runs arc commands without consuming main conversation context.

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

Design docs live in `docs/plans/` as filesystem markdown. Arc registers them on one of three review surfaces, chosen at create time by the `/arc-brainstorm` skill based on who's reviewing and whether encryption is needed. Each surface has its own CLI verb set; `/arc-plan` and any other consumer reads line 1 of the doc — `<!-- arc-review: kind=<legacy|share-local|share-remote> id=<id> -->` — to know which CLI to call.

**Surfaces:**

| `kind` | Create command | URL pattern | Encrypted? | Best for |
|---|---|---|---|---|
| `legacy` | `arc plan create <file>` | `http://localhost:7432/planner/<id>` | no | Solo, plain HTTP, simplest comment thread |
| `share-local` | `arc share create <file>` | `http://localhost:7432/share/<id>#k=<key>` | yes | Solo, but want annotations + accept-resolve UI |
| `share-remote` | `arc share create <file> --remote` | `<remote>/share/<id>#k=<key>` (default `https://arcplanner.sentiolabs.io`) | yes | Reviewers on other machines |

`arc share create --server <url>` overrides `--remote` to target an explicit server.

For the encrypted surfaces, the author's edit tokens live in the arc-server's local keyring (a `shares` table in `~/.arc/data.db`) — multi-client accessible via `/api/v1/shares`, never written to disk as JSON. Legacy plans don't have edit tokens; the URL is just the planner path.

### `arc share` commands (share-local, share-remote)

| Command | Purpose |
|---------|---------|
| `arc share create <file-path> [--remote]` | Encrypt a plan and create a share, returns share ID. Default is local; `--remote` targets the configured share server. Output prints a single URL: `Preview URL` (local) or `Author URL` (shared) — the reviewer URL is obtained from the in-page **Share link** button on the share page header, not the CLI. |
| `arc share show <id>` | Decrypt and print plan content (use `--author-url` to reprint the Author URL) |
| `arc share approve <id>` | Mark the share as approved |
| `arc share comments <id>` | All review comments + statuses |
| `arc share pull <id>` | Accepted-only comments (the agent-input form) |
| `arc share list` | List shares known to this machine (incl. `plan_file` mapping). Add `--json` for `[{id, kind, url, key_b64url, plan_file, created_at}]` — pipe to `jq` to look up a share's local file path |
| `arc share update <id> <plan-file>` | Replace the encrypted plan content (in-place; ID stays stable) |
| `arc share delete <id>` | Delete a share (`--force` cleans up local keyring entries when the server is already gone) |

### `arc plan` commands (legacy)

| Command | Purpose |
|---------|---------|
| `arc plan create <file-path>` | Register a plan on the legacy `/planner/<id>` surface (plain HTTP, no encryption). There's no in-place update — re-running `create` produces a new ID. |
| `arc plan show <id>` | Print plan metadata + content (the metadata header includes `File: <path>`, useful for plan-file lookups) |
| `arc plan approve <id>` | Mark the plan as approved |
| `arc plan comments <id>` | List comments on the plan (flat thread; no Accept/Resolve/Reject states) |

### Review cycle

create → reviewers leave annotations → author Accepts/Resolves/Rejects (encrypted surfaces) or replies inline (legacy) → `arc share pull` surfaces accepted comments to the implementation flow (legacy reads the comments thread inline since it has no accepted-only filter). Approved design content is written into the epic's description field when creating implementation tasks. Run `arc docs plans` for full details.

The `<!-- arc-review: kind=… id=… -->` marker on line 1 of every registered design doc tells downstream skills which CLI table above to use. See `skills/arc-brainstorm/SKILL.md` step 6 for the marker-write contract and `skills/arc-plan/SKILL.md` step 1 for the read pattern.

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
arc update <id> --take                  # Claim work (sets session ID + in_progress)
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
