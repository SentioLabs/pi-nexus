---
description: Show arc teammate-label context
argument-hint: context [epic-id] [--json]
---

Show teammate-label planning context with `arc team`.

Pi does not support Claude-style team deployment. Use this command only to inspect `teammate:*` issue groupings; implementation remains orchestrated through `/arc-build`.

**Team context:**
```bash
arc team context                    # All teammate-labeled issues
arc team context <epic-id>          # Children of specific epic
arc team context --json             # JSON output for machine consumption
arc team context <epic-id> --json   # JSON for a specific epic
```

**Output:** Issues grouped by their `teammate:*` labels (e.g., `teammate:frontend`, `teammate:backend`).

| Column | Description |
|--------|-------------|
| ROLE | Teammate role extracted from `teammate:*` label |
| ISSUES | Count of issues assigned to that role |
| IDS | Issue IDs for that role |

**JSON output** includes full issue details with plans and dependencies for each role group.

**Related commands:**
- `arc prime --role=lead` — Lead-oriented context output
- `arc prime --role=frontend` — Role-filtered context (or use `ARC_TEAMMATE_ROLE` env var)
