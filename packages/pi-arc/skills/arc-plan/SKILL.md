---
name: arc-plan
description: You MUST use this skill to break a design or feature into implementation tasks — especially after brainstorming, when the user says "plan this", "break this down", "create tasks", or wants to turn a design into actionable arc issues with exact file paths. Creates self-contained arc issues that subagents can implement with zero prior context. Always prefer this over generic planning when the project uses arc issue tracking.
---

# Plan — Implementation Task Breakdown

Break an approved design into bite-sized, self-contained tasks with exact file paths and steps.

## Review Commands

Design docs live in `docs/plans/<file>.md`. The brainstorm skill registers each doc on the planner and writes a marker as line 1 of the doc itself recording the plan ID:

```
<!-- arc-review: id=<id> -->
```

The planner CLI verbs are:

| Show content | List comments | Approve | Update content |
|---|---|---|---|
| `arc plan show <id>` | `arc plan comments <id>` | `arc plan approve <id>` | re-create the plan (no in-place update) |

Read the plan ID from the marker with one shell call:

```bash
MARKER=$(head -1 docs/plans/<file>.md)
ID=$(echo "$MARKER" | grep -oE 'id=\S+' | sed 's/id=//' | tr -d '>' | xargs)
```

The planner is plain HTTP with no edit tokens or keys to manage; the URL is just `<base>/planner/<id>`.

**Fallback for unmarked design docs.** Older design docs created before the marker contract may not have line 1 set. If the marker is missing, read the file directly and ask the user for the plan ID (or re-register the doc via brainstorm step 6).

## Granularity Rule

Each task step is **ONE action, 2-5 minutes**. Assume the implementer has **zero codebase context** and fresh context without codebase familiarity. If a step says "add validation" without showing the code, it's too vague.

## No Placeholders

Every step in a task description must contain the actual content an implementer needs. These are **plan failures** — never write them:

- `"Add appropriate error handling"` / `"add validation"` / `"handle edge cases"` — show the actual code
- `"Write tests for the above"` without test code — include the test code
- `"Similar to Task N"` — repeat the content; the implementer has zero context of other tasks
- Steps that describe what to do without showing how — code blocks required for code steps
- References to types, functions, or methods not defined in any task or already on HEAD
- `"TBD"`, `"TODO"`, `"implement later"`, `"fill in details"`

Code blocks represent the **intent, structure, and behavior** — not a character-for-character mandate. The implementer follows the code block's signatures, logic, and patterns but adapts naming, error handling, and scaffolding to match project conventions (consistent with the implementer's Gate Check 4: Idiomatic Code Quality). Task-internal Design Contracts remain pseudocode that the implementer adapts to language idioms. The anti-placeholder rule prevents *missing* guidance, not idiomatic adaptation.

## Workflow

Add tasks for each step below using the bundled `todo` checklist (via `todo` tool / `/todos`). If continuing from the brainstorm skill, the brainstorm tasks will already be visible — add the planning tasks alongside them so the user sees the full brainstorm→plan progression. Mark each as `in_progress` when starting and `completed` when done.

### 1. Read the Design

You're handed a plan-file path (typically `docs/plans/<file>.md`) by the brainstorm skill. Read line 1 to get the plan ID, then show its content:

```bash
MARKER=$(head -1 docs/plans/<file>.md)
ID=$(echo "$MARKER" | grep -oE 'id=\S+' | sed 's/id=//' | tr -d '>' | xargs)

if [ -n "$ID" ]; then
  arc plan show "$ID"
else
  echo "No review marker; reading file directly"; cat docs/plans/<file>.md
fi
```

The full content is what you'll break down in the next steps. If the file has no marker (an older design doc), reading the file directly is fine — but warn the user the review-state CLI calls (approve) won't work without a registered plan, and offer to register it via brainstorm step 6.

### 2. Identify Shared Contracts (Foundation Task)

Check the design for **shared contracts** — types, interfaces, config keys, constants, or function signatures referenced by multiple tasks. If the brainstorm design includes a shared contracts section, use it as input.

If shared contracts exist and parallel execution is likely:

1. Create a **T0: Foundation** task that establishes all shared contracts
2. Mark all parallelizable tasks as **blocked by T0**
3. T0 runs sequentially before any parallel batch begins

This ensures parallel agents inherit shared definitions from HEAD rather than inventing them independently.

**T0 task descriptions must be literal, not prose.** The description should contain:
- **Exact type/interface code** to write to specific files (sourced from the brainstorm design's shared contracts)
- **Inline contract test assertions** to write in each relevant test file, so downstream tasks can verify they are using the correct types
- Steps that say "write this exact code to this exact file" — not vague instructions like "define the memory type"

Example T0 task description:

```markdown
## Summary
Establish shared types and contract tests for the memory feature.

## Files
- Create: `internal/types/memory.go`
- Create: `internal/memory/memory_test.go`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.

## Steps
1. Create `internal/types/memory.go` with this exact content:
   ```go
   package types

   import "time"

   type Memory struct {
       ID        int64     `json:"id" db:"id"`
       Content   string    `json:"content" db:"content"`
       CreatedAt time.Time `json:"created_at" db:"created_at"`
   }
   ```
2. Create contract assertions in `internal/memory/memory_test.go`:
   ```go
   package memory

   import (
       "testing"
       "time"

       "yourmodule/internal/types"
   )

   // --- Contract assertions ---
   // These verify the design spec. Do NOT modify
   // without updating the approved plan.

   func TestMemoryContract(t *testing.T) {
       m := types.Memory{}
       var _ int64 = m.ID
       var _ string = m.Content
       var _ time.Time = m.CreatedAt
   }

   // --- Behavior tests (added by implementer) ---
   ```
3. Run `go build ./internal/types/...` — confirm it compiles
4. Run `go test ./internal/memory/...` — confirm contract tests pass
5. Commit: `feat(types): add foundation types and contract tests`

## Test Command
go test ./internal/memory/...

## Expected Outcome
Shared types compile and contract assertions pass. Parallel tasks can now import these types from HEAD.
```

**Skip this step** if the work is purely sequential or no shared contracts were identified.

### 3. Identify Tasks

Break the design into self-contained implementation units. Each task should:
- Have a clear, testable outcome
- Be implementable without knowledge of other tasks
- Include exact file paths for all files to create or modify
- Follow a logical dependency order
- **Not overlap in file ownership with other parallelizable tasks**

When identifying tasks, assign **file ownership** — each file should be owned by exactly one task. If two tasks need to modify the same file, either merge them into one task, serialize them with a dependency, or extract the shared file into the foundation task.

### 4. Create Epic and Tasks via issue-manager

**Model tier:** `issue-manager` defaults to `nano` — the right tier for low-reasoning CLI formatting and bulk issue creation. Model profile: issue creation uses the issueManager profile when configured via `/arc-models`; otherwise it falls back to the legacy tier/frontmatter behavior. This work is mostly CLI formatting, so the recommended profile uses gpt-5.6-luna with thinking off. For this dispatch, omit `model:`. See the Model Selection table in `../arc-build/SKILL.md` for the full guidance.

**Never run `arc create` directly** — always delegate to the `issue-manager` agent. This keeps bulk CLI output in a disposable subagent context.

**Never put description content in the agent prompt — descriptions travel as canonical files.** Arc normalizes leading/trailing whitespace from `--stdin`, so canonicalize each file with outer whitespace removed before dispatch. The issue-manager then transfers those canonical bytes with shell redirection; description bodies never pass through the model.

Before dispatching:

1. Create a manifest directory: `mkdir -p /tmp/arc-manifest-<epic-slug>`.
2. Write every task's full self-contained draft to `/tmp/arc-manifest-<epic-slug>/T0.md`, `T1.md`, and so on with the `write` tool.
3. Copy the approved plan to `/tmp/arc-manifest-<epic-slug>/epic.md`. If only the plan ID is known, recover the source path with `arc plan show <id> | grep -oE '^File: \S+' | awk '{print $2}'`.
4. Canonicalize only outer whitespace so the files match Arc's `--stdin` normalization while preserving every internal byte:
   ```bash
   python3 - /tmp/arc-manifest-<epic-slug> <<'PY'
   from pathlib import Path
   import sys
   for path in Path(sys.argv[1]).glob('*.md'):
       path.write_text(path.read_text().strip())
   PY
   ```
5. From this point onward, hash, dispatch, repair, and verify only these canonical files.

Before persistence, self-review the canonical description files against the approved design:

1. **Spec coverage:** Every design requirement maps to a task.
2. **Success-criteria coverage:** Every `## Success Criteria` item maps to at least one task's `## Expected Outcome`.
3. **T0 contract coverage:** Shared contract blocks match the T0 definitions exactly.
4. **Type consistency:** Names and signatures agree across tasks.
5. **Placeholder scan:** No TBD/TODO/vague implementation placeholders remain.
6. **Step completeness:** Every code or command step includes concrete content.

Fix the canonical files now, then repeat this review. Do not create any Arc issue until it passes.

Issue creation must be phased:

1. Create the epic first and capture the epic ID.
2. Create all child tasks with the epic as parent before applying dependencies.
3. Capture the complete task-name-to-ID table.
4. Apply dependencies only after all child IDs exist.
5. Apply labels after dependencies with `arc update <id> --label-add=<label>`.
6. Verify descriptions and return the final ID table, dependency summary, and a `## Timing` section with phase-level `elapsed_ms` values.

Then dispatch the manifest — titles, metadata, and file paths only, no description bodies. Prefer true `pi-subagents` so long issue-creation runs are visible in `/subagents-status`:

Dispatch preference:
- Primary: `subagent({ agent: "arc-issue-manager", task: "<manifest below>", context: "fresh", async: true, clarify: false })`
- Wait for terminal status by polling `subagent({ action: "status", id: "<run-id>" })` until `completed` or `failed`
- Users can monitor progress via `/subagents-status`
- If `subagent({ action: "list" })` shows `arc-issue-manager`, do **not** use the slower `arc_agent(agent="issue-manager")` fallback
- If it is missing, run `subagent({ action: "doctor" })` and inspect Arc's materialization warning; use `/arc-subagents-sync` only as a deprecated repair command
- Fallback only when `pi-subagents` is unavailable after repair: `arc_agent(agent="issue-manager", task="<manifest below>")`

Use this task payload for whichever dispatcher you choose:

```markdown
Create the following epic and tasks using the arc CLI.

RULES (mechanical, not stylistic):
- Create the epic first, then create every child with its description piped from the listed file:
  arc create "<title>" --type=<type> [--parent=<id>] --stdin < "<description file>"
- Create all children and capture every ID before applying dependencies.
- Apply dependencies only after all child IDs exist.
- Apply manifest labels only after dependencies with `arc update <id> --label-add=<label>`.
- NEVER read a description file and retype its contents into a heredoc or a
  --description flag. Shell redirection only. You may not summarize, trim,
  reformat, or "clean up" description content under any circumstances.
- After each create, verify the stored description equals the canonical file:
  `sha256sum < "<description file>"` must equal
  `arc show <id> --json | jq -j .description | sha256sum`.
  Treat any mismatch as a failed verification phase; repair from the canonical file and re-check.

## Epic

### <epic title>
Type: epic
Description file: /tmp/arc-manifest-<epic-slug>/epic.md

## Tasks

### T1: <title>
Type: task
Parent: <epic-id from above>
Labels: none
Description file: /tmp/arc-manifest-<epic-slug>/T1.md

### T2: <title>
Type: task
Parent: <epic-id from above>
Labels: docs-only
Description file: /tmp/arc-manifest-<epic-slug>/T2.md

## Dependencies
- T2 blocked by T1
- T4 blocked by T3

## Required Output
| Task | Arc ID | Title | File SHA-256 | Arc SHA-256 |
|------|--------|-------|-------------|------------|
| Epic | ...    | ...   | ...        | ...       |
| T1   | ...    | ...   | ...        | ...       |

## Timing
| Phase | elapsed_ms |
|-------|------------|
| epic | ... |
| child_tasks | ... |
| dependencies | ... |
| labels | ... |
| verification | ... |
```

The `## Timing` section is required for bulk issue creation; use `unknown` only when a phase timestamp could not be captured.

**IMPORTANT**: The epic description MUST contain the complete approved design. The plan file is ephemeral; the epic description is the permanent record. Piping the file into `--stdin` guarantees no summarization or content loss.

For each task, check whether **all** files in its `## Files` section are documentation (`.md`, `.txt`, `README`, `CHANGELOG`, or anything under `docs/`). If so, set `Labels: docs-only` on that task in the manifest. Doc-only tasks skip TDD — the `build` skill routes them to `doc-writer` instead of `builder`. Keep `Labels:` in the manifest, but apply labels only after dependencies with `arc update <id> --label-add=<label>` so the phased creation contract remains observable and recoverable.

For each task whose work is **infrastructure/operations** rather than application code — cluster upgrades, Terraform/Helm/Ansible changes, cloud provisioning, CI/CD pipeline edits, anything where success means a *live system reaching a desired state* rather than a passing unit test — set `Labels: devops` on that task in the manifest. DevOps tasks skip TDD — the `build` skill routes them to `devops-builder` (PLAN → SAFEGUARD → APPLY → VERIFY → GATE) instead of `builder`. Use the **DevOps task format** (see `## Task Description Format` below) for these: it replaces `## Test Command` with `## Verification` and adds `## Safeguards` and `## Rollback`. A task is either `devops` or a normal code task — don't apply both labels.

### 5. Validate Returned Results

Before proceeding, verify the agent's output. Do not trust the agent's self-reported line counts — re-check independently:

1. **Count check**: The number of returned IDs must match the number of tasks in your manifest
2. **Verbatim check**: For the epic and every task, compare line counts between the description file and what arc stores:
   ```bash
   wc -l < "<description file>"
   arc show <id> --json | jq -r .description | wc -l
   ```
   First compare byte hashes: `sha256sum < "<description file>"` must equal `arc show <id> --json | jq -j .description | sha256sum`. Line counts and, for T0, code-fence counts are diagnostics only. Any hash mismatch is a plan failure — repair with file redirection and re-check before continuing.
3. **Label check**: `arc show <id> --json | jq .labels` for each task with labels in the manifest (`docs-only`, `devops`) — missing labels misroute tasks at build time
4. **Parent/dependency spot-check**: Run `arc show <id>` on one task to confirm parentage and one dependency edge
5. **If any description fails the verbatim check**: Do NOT re-dispatch the agent — repair mechanically yourself: `arc update <id> --stdin < "<description file>"`, then re-verify. For missing tasks, re-dispatch the agent for those tasks only
6. **Cleanup**: After all checks pass, remove the manifest directory: `rm -rf /tmp/arc-manifest-<epic-slug>`

### 6. Append Task Breakdown to Epic Description

The epic was created in step 4 with the full design content. Now append the task breakdown table (with actual arc IDs from step 5) to the epic's description. Build the new description by *concatenating*, never by retyping the existing content:

```bash
{
  arc show <epic-id> --json | jq -r .description
  cat <<'EOF'

---

## Implementation Tasks

<task breakdown table with arc IDs, titles, statuses, and dependency info>
EOF
} | arc update <epic-id> --stdin
```

**IMPORTANT**: Preserve the full design content already in the description — do not replace it with a summary. The epic description is the permanent record of the design. Only append the task breakdown table at the end. The concatenation pattern above guarantees this: only the new table passes through your output; the existing design content round-trips through the shell.


### 7. Choose Execution Path

**Use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool** with the package `questions[]` schema to let the user choose. Do not manually author package sentinel labels (`Type something.`, `Chat about this`, `Other`, `Next`):

```json
{
  "questions": [
    {
      "header": "Next",
      "question": "Epic and tasks created. How should we proceed with implementation?",
      "options": [
        {
          "label": "Start now (Recommended)",
          "description": "Continue directly into /arc-build in this session."
        },
        {
          "label": "New session",
          "description": "Print the exact /arc-build <epic-id> command for a fresh Pi session."
        },
        {
          "label": "Done for now",
          "description": "Leave the tasks tracked in arc for future implementation."
        }
      ]
    }
  ]
}
```

After the user chooses:

**Start implementing now**: Invoke the `build` skill immediately with the epic ID.

**Implement in a new session**: Output the exact command for the user to copy-paste:
```
Run this in a new Pi session:

  /arc-build <epic-id>

```
Replace `<epic-id>` with the actual epic ID.

**Done for now**: Confirm the epic and tasks are saved in arc. The user can run `/arc-build <epic-id>` whenever they're ready.
## Parallel Readiness

When a design can split into parallel implementation batches, document the readiness proof before handing off tasks.

### T0 Foundation Decision

State whether the design needs a T0 foundation task. If shared contracts, shared constants, or any other multi-task interface are referenced by more than one task, create T0 first and block every dependent parallel batch on it.

### File Ownership Matrix

Do not mark any task parallelizable until this matrix is complete and every file is owned by exactly one task.

| Task | Owns files | Reads files | Overlap handling |
|---|---|---|---|

### Parallel Batch Manifest

Group only disjoint tasks into parallel batches after file ownership is settled. Never place a `devops` task or other live-system mutation in a parallel batch; those tasks must remain sequential.

| Batch | Prerequisites | Tasks | Independence proof | Validation |
|---|---|---|---|---|

### Validation Matrix

List the validation command(s) for each batch and the result that proves the batch is ready to hand off.

| Check | Scope | Command | Expected result |
|---|---|---|---|


## Task Description Format

Each task's `--description` must be **self-contained** (~3-5k tokens). The task description IS the implementation context — the implementer loads `arc show <task-id>` and nothing else.

Include in every task description:

```
## Files
- Create: `path/to/new_file.go`
- Modify: `path/to/existing_file.go`
- Test: `path/to/file_test.go`

## Scope Boundary
Do NOT create or modify any files outside the Files section above.
If you need a type, interface, or constant that doesn't exist, do NOT create it —
the foundation task or a prior task is responsible for shared definitions.

## Design Contracts

### Shared (use verbatim — defined in T0: Foundation)
```go
type Memory struct {
    ID        int64     `json:"id" db:"id"`
    Content   string    `json:"content" db:"content"`
    CreatedAt time.Time `json:"created_at" db:"created_at"`
}
```

### Task-internal
- `FeedbackRequest { memory_id: i64, rating: i8, comment: String? }`
- `MemoryStore.InsertMemory(content string) → (int64, error)`

## Steps
1. Write failing test for <specific behavior> in `path/to/file_test.go`
2. Run `go test ./path/to/...` — confirm it fails with <expected error>
3. Implement <specific function> in `path/to/new_file.go`:
   ```go
   func specificFunction(arg Type) (Result, error) {
       // exact implementation code — not prose descriptions
   }
   ```
4. Run `go test ./path/to/...` — confirm it passes
5. Commit: `feat(module): add <feature>`

## Test Command
go test ./path/to/...

## Expected Outcome
<what should work when this task is done>
```

**Hard rule:** Every code step requires a code block. Every command step requires the exact command and expected output. Steps without these are plan failures — see the No Placeholders section above.

### Design Contracts guidance

Include a `## Design Contracts` section in every non-T0 task description, placed after `## Scope Boundary` and before `## Steps`. This section has two subsections:

- **Shared (use verbatim)**: Exact type definitions copied from the T0 foundation task. The subagent MUST use these types exactly as written — same field names, same tags, same package. These are the canonical contracts established by T0 and committed to HEAD.
- **Task-internal**: Pseudocode descriptions of types and signatures that are private to this task. The subagent adapts these to language idioms (naming conventions, error handling patterns, etc.) as appropriate.

If a type the subagent needs is not listed in Design Contracts and is not already on HEAD from T0, the subagent must NOT create it. This rule complements the Scope Boundary section — Scope Boundary restricts file ownership, Design Contracts restricts type ownership.

For `docs-only` tasks, omit `## Test Command` and use `## Verification` instead:

```
## Verification
- All internal links resolve to existing files
- Heading hierarchy has no skipped levels
- Code blocks have language tags
```

### DevOps task format

For `devops` tasks, the implementer executes a change against a live system, so the description is a **runbook**, not a code spec. Keep `## Summary` and `## Steps`, but adapt the rest:

- **`## Files`** lists committed IaC/config/manifests the task changes (Terraform, Helm values, k8s YAML, pipeline config). If the change is purely imperative (e.g. `kubectl drain`/`cordon` with no committed artifact), write `n/a (imperative change)`.
- **`## Target`** names the exact environment the task is authorized to touch — cluster/context, namespace, Terraform workspace, cloud account/project. This is mandatory: the `devops-builder` reports `NEEDS_CONTEXT` if the target is ambiguous, so resolve it at plan time.
- **`## Steps`** are ordered runbook actions, each with the **exact command** (dry-run before apply) — e.g. `terraform plan -out=tfplan`, then `terraform apply tfplan`. Stage multi-unit changes (one node/replica/canary at a time). Same anti-placeholder rule as code tasks: show the real commands, not "apply the change."
- **`## Safeguards`** — what to back up and pre-flight before mutating (e.g. `kubectl get <res> -o yaml > backup.yaml`, snapshot the state, record the current Helm revision). This is the SAFEGUARD phase made concrete.
- **`## Verification`** (replaces `## Test Command`) — commands that assert the **live desired state**, each with the expected result: e.g. `kubectl get nodes -o wide` → all nodes report v1.29 + `Ready`; `terraform plan` → "No changes"; endpoint returns 200.
- **`## Rollback`** — the exact command(s) to undo the change (e.g. `helm rollback <release> <prev-revision>`, `kubectl apply -f backup.yaml`), referencing the backup/revision captured in `## Safeguards`. A `devops` task with no rollback path is a plan failure — the implementer is required to have one.

Example skeleton:

```markdown
## Summary
Upgrade the staging `payments` Helm release with a staged, reversible rollout.

## Target
Cluster context: `arn:aws:eks:us-east-1:123456789012:cluster/staging-eks`; namespace: `payments`; release: `payments`.

## Files
- Modify: `deploy/values-staging.yaml`

## Safeguards
- `kubectl config current-context` must equal the target context above.
- `PREV_REV=$(helm history payments -n payments -o json | jq -r 'map(.revision) | max')`
- `helm get values payments -n payments -o yaml > /tmp/payments-values-before.yaml`

## Steps
1. Preview: `helm diff upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml` and confirm only the intended image/config changes appear.
2. Apply with rollback-on-failure: `helm upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml --atomic --timeout 10m`.
3. Observe: `kubectl rollout status deployment/payments -n payments --timeout=10m`.

## Verification
- `helm diff upgrade payments ./deploy/payments -n payments -f deploy/values-staging.yaml` → empty diff.
- `kubectl get deployment payments -n payments -o jsonpath='{.status.readyReplicas}/{.status.replicas}'` → equal counts.
- `kubectl get pods -n payments` → no `CrashLoopBackOff` or `ImagePullBackOff`.

## Rollback
`helm rollback payments "$PREV_REV" -n payments --wait --timeout 10m`; verify rollout and pod health again.

## Expected Outcome
The staging release converges to the intended chart values, all replicas are Ready, the post-apply diff is empty, and the recorded prior revision remains available for rollback.
```

The task must contain concrete target values and executable commands like this example. If the provider has no preview/change-set mechanism or the recovery path cannot be verified, stop for explicit authorization rather than weakening the dry-run/rollback law.

## Rules

- Never reference external docs or the full plan in task descriptions — everything needed is in the description
- Design documents live in `docs/plans/` and are registered on the planner via `arc plan create --no-frontmatter`. The brainstorm skill writes a `<!-- arc-review: id=… -->` marker as line 1 of the doc — read it to get the plan ID before invoking review CLIs
- Task descriptions must include actual code guidance, not vague instructions
- `teammate:*` labels may be used as planning metadata, but Pi does not support Claude-style team deployment. Use `/arc-build` for orchestrated sequential work or independent `pi-subagents` parallel batches when available.
- The plan skill creates tasks; it does not implement them
- The plan skill never runs `arc create` directly — always delegate to `issue-manager`
- Description content travels by file + `--stdin < file` redirection — never inline in a subagent prompt, never retyped by a subagent. A model re-emitting long content will compress it regardless of instructions; only shell redirection is verbatim
- Every task must include a `## Scope Boundary` section — no file modifications outside the `## Files` list
- No two parallelizable tasks may own the same file — resolve overlaps via foundation task, merging, or serialization
- Format all arc content (descriptions, plans, comments) per `skills/arc/_formatting.md`
