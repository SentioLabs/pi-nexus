---
name: arc-summarize
description: You MUST use this skill to summarize an arc issue into an external tracker (Jira, Linear, GitHub, or any tracker with a connected integration) when the user says "summarize <arc-id> for <tracker>", "create a <tracker> issue from arc <id>", "push/mirror this arc issue to <tracker>", or indicates they want to mirror an arc issue to an external system. The skill produces a lossy, directional summary (not a verbatim paste) that points back to arc as the source of truth, detects which connected tool (MCP server or CLI) can fulfill the request, creates the ticket, backlinks both directions, and verifies the result. One-way snapshot only in v1 — no two-way status sync.
---

# Summarize — Mirror an Arc Issue to an External Tracker

Summarize an arc issue into an external tracker with intelligent field mapping, capability detection, and verification.

## Iron Law

**The external ticket is a lossy, directional summary that points back to arc.** Arc remains the source of truth. Never paste the full arc issue verbatim. Condense, preserve intent and scope, drop internal tactics.

## Workflow

Follow these 10 steps in sequence:

### 1. Parse the Request

Extract from the user's input:
- **Arc ID** — the issue to summarize
- **Target tracker** — explicitly named (jira, linear, github, etc.) or implied from context
- **Inline specifics** — board/project, sprint/cycle/milestone, assignee, labels, issue type — anything the user stated. Honor these; do not re-ask.

Example:
```text
User: "summarize agentmarke-0qex.04hl1w for jira in the BT board"
Parsed: id=agentmarke-0qex.04hl1w, tracker=jira, board=BT
```

### 2. Extract Arc Issue Data

Fetch the arc issue in JSON:

```bash
arc show <id> --json
```

Extract and clean:
- Title
- Body (markdown, full)
- Type (feature / bug / task / chore)
- Priority (0–4 scale)
- Labels (array)
- Status
- Origin PR/branch (if present)

Store these for downstream use.

### 3. Detect Capability — By Reasoning, Not a Lookup Table

**Determine which connected capability can write to the named tracker.** Do not hardcode an MCP namespace. Use Pi's `mcp` gateway to inspect server status and search available tools by tracker/action, then call the selected tool through the same gateway.

- **Jira / Atlassian** → Search connected MCP tools for Atlassian/Jira issue creation.
- **Linear** → Search connected MCP tools for Linear issue creation.
- **GitHub / GitHub Issues** → Prefer an authenticated GitHub MCP tool when present; otherwise verify `gh auth status` and use `gh`.
- **Other trackers** → Use a connected MCP write tool or authenticated CLI wrapper; otherwise stop.

A server that is installed but unauthenticated is not usable. Prefer an authenticated provider when several exist. If authentication is required, use Pi's MCP authentication flow or tell the user to open `/mcp`; never guess a raw `mcp__...` tool namespace.

**If no connected tool can satisfy the request:**
- **STOP. Do not create anything.**
- Name the missing capability: *"Jira write requires the Atlassian MCP server."*
- Tell the user how to enable it: *"Run `/mcp` to authenticate an Atlassian connector, or `gh auth login` for GitHub."*
- Create no ticket; let the user take the action and re-invoke.

### 4. Load Cache

Read `~/.arc/tracker-map.yaml`. This file accumulates discovered constants across all projects on this machine:

```yaml
# ~/.arc/tracker-map.yaml
trackers:
  jira:bactrack.atlassian.net:
    instance:
      cloud_id: <uuid>
      sprint_field: customfield_10020
      issue_type_map:
        feature: { name: Story, id: "10001" }
        bug:     { name: Bug,   id: "10004" }
        task:    { name: Task,  id: "10002" }
        chore:   { name: Task,  id: "10002" }
      priority_map: { 0: Highest, 1: High, 2: Medium, 3: Low, 4: Lowest }
      assignee_aliases: { "ben firestone": <accountId> }
    prefs:
      last_project: BT
```

**Tolerance:**
- File does not exist → create it on first use (step 8).
- Entry for this tracker:instance does not exist → discover-then-cache (step 7).
- Keys missing within an entry → fall back to discover (step 7).
- `prefs` → optional; used only to pre-select prompts, never silently applied.

### 5. Summarize — The Heart of the Skill

Condense the verbose arc body into **tracker-idiomatic copy**. This is lossy by design.

**Keep:**
- Intent (why this work matters)
- Scope (what problem is solved, what is in/out of scope)
- Acceptance criteria (what done looks like)
- Origin (link to original arc issue)
- PR / branch link (if present)

**Drop:**
- Arc-internal IDs (bacst-xxxx, agentmarke-yyyy)
- Implementation tactics (technical approach, tools, frameworks)
- Dev-only notes (debugging steps, internal debugging context)
- Commit SHAs, worktree details
- Internal tracker links

**Example:**

Arc issue:
```
# proj-1a2b.3c4d — CLI docs for OpenCode installer

## Description
The OpenCode installer is live but undocumented. Users don't know the CLI flags, how to set auth, or what to do when installation fails.

## Acceptance Criteria
- [ ] CLI help text for `opencode-installer install`
- [ ] Auth troubleshooting guide
- [ ] Example: install w/ GITHUB_TOKEN

## Implementation Notes
Used bactrack/sentinel for auth detection. See arc bacst-05ca.09y0bs for the shared pattern.
```

Summarized for Jira:
```
## OpenCode CLI: Installation Guide

Update the OpenCode installer CLI documentation to cover setup, authentication, and troubleshooting.

### Acceptance Criteria
- CLI help text for `opencode-installer install` command
- Authentication troubleshooting guide
- Example: install with GITHUB_TOKEN

**Origin:** arc issue proj-1a2b.3c4d
```

### 6. Map Fields

For ambiguous structured decisions, use the bundled `@juicesharp/rpiv-ask-user-question` `ask_user_question` tool with the package `questions[]` schema and 2-4 authored options. Do not author sentinel labels such as `Type something.`, `Chat about this`, `Other`, or `Next`; the package supplies escape hatches. Put the recommended option first and append `(Recommended)` when one is clear.

Resolve the tracker fields you need. This requires user input for ambiguous cases — never guess.

#### **Issue Type**

1. **User input wins.** If the user said "create a bug", use that.
2. Else, **translate arc type through the cache's `issue_type_map`:**
   - Arc `bug` → Jira `Bug` (id from cache)
   - Arc `feature` → Jira `Story` (id from cache)
   - Arc `task` → Jira `Task` (id from cache)
   - Arc `chore` → Jira `Task` (id from cache)
3. If the map does not cover it or the cache is empty → **ask the user:**
   ```json
   {
     "questions": [
       {
         "header": "Issue type",
         "question": "What issue type should be created?",
         "options": [
           { "label": "Story (Recommended)", "description": "Use the tracker's feature-oriented issue type." },
           { "label": "Bug", "description": "Use the tracker's defect issue type." },
           { "label": "Task", "description": "Use the tracker's general work-item type." }
         ]
       }
     ]
   }
   ```

#### **Board / Project**

1. **User stated it in the request** → use it (e.g., "in the BT board").
2. Else, **prompt with real discovered projects:**
   ```json
   {
     "questions": [
       {
         "header": "Project",
         "question": "Which discovered project or board should receive the issue?",
         "options": [
           { "label": "BT (Recommended)", "description": "Use the previously selected Bactrack project." },
           { "label": "ARCH", "description": "Use the discovered Arc project." }
         ]
       }
     ]
   }
   ```
   Use the tool's live discovery (Jira JQL, Linear API, `gh` CLI) to list real projects; pre-select `prefs.last_project` if set.
3. After the user picks → **cache the choice to `prefs.last_project`** for next run.

#### **Sprint**

- "Current / active sprint" is **resolved live** against the board each run — **never cached** (active sprints roll over every few weeks; a cached id goes stale).
- Since active sprint is almost always the intent, it rarely needs asking.
- When ambiguous (e.g., "which of the 3 open sprints?"), ask from **live sprint data only:**
  ```json
  {
    "questions": [
      {
        "header": "Sprint",
        "question": "Which live sprint should receive the issue?",
        "options": [
          { "label": "Sprint 47 (Recommended)", "description": "Use the current active sprint discovered from the tracker." },
          { "label": "Sprint 48", "description": "Use the next open sprint discovered from the tracker." }
        ]
      }
    ]
  }
  ```

#### **Assignee**

- **Never guess.** Always ask.
- Populate from discovered team members + the tool's "Unassigned" default.
- Translate user input through `assignee_aliases` if cached; otherwise probe live.

#### **Labels / Tags**

- Pre-populate from the arc issue's labels if the cache has a mapped equivalent.
- Ask the user if labels are ambiguous or the map is empty.

### 7. Discover Only What Is Missing, Then Cache It

For any field that is not in the prompt, cache, or arc issue, probe **live** from the tracker's API.

**Examples:**

- **Jira sprint custom field ID:** Use JQL probe to find `customfield_10020`.
- **Jira issue type IDs:** Call `createmeta` to resolve type names to instance-specific IDs.
- **Linear team members:** Fetch live team roster to populate assignee list.
- **GitHub assignees:** `gh api repos/<owner>/<repo>/collaborators` to list potential assignees.

After each probe, **write newly discovered constants to `~/.arc/tracker-map.yaml`** under the `instance` key. The next run will skip the probe.

```bash
# Example: cache a discovered Jira sprint field
# in ~/.arc/tracker-map.yaml under trackers[jira:<host>][instance]
sprint_field: customfield_10020
```

### 8. Create

Call the tracker's API via the connected tool (MCP server or CLI) to create the issue.

**Required fields:**
- Title (from summary in step 5)
- Body (from summary in step 5)
- Issue type (from step 6)
- Project / Board (from step 6)

**Optional fields (set if resolved):**
- Sprint (from step 6)
- Assignee (from step 6)
- Labels (from step 6)
- Priority (from arc priority, via cache map)

**Example — Jira via Pi's MCP gateway:**
```text
mcp({ search: "Jira create issue" })
mcp({
  tool: "<discovered-create-tool>",
  args: '{"project":"BT","type":"Story","summary":"OpenCode CLI: Installation Guide","description":"<summarized markdown>","sprint":"<resolved-sprint-id>","assignee":"<resolved-account-id>","labels":["doc","cli"]}'
})
```

Use the exact schema returned by `mcp({ describe: "<discovered-create-tool>" })`; the fields above are illustrative, not a raw function call.

**Example — GitHub via gh CLI:**
```bash
gh issue create \
  --repo owner/repo \
  --title "OpenCode CLI: Installation Guide" \
  --body "<summarized markdown>" \
  --label "doc,cli" \
  --assignee ben-firestone
# Returns: tracker URL
```

Record the created **tracker key** (e.g., `BT-3014`) and **tracker URL** for the next step.

### 9. Backlink Both Directions

**Arc → Tracker:** Stamp the new tracker key onto the arc issue.

Preserve the current Arc description mechanically: write it to a temporary file, append only the backlink, then pipe the file back through `--stdin`. Never retype the existing body through the model:

```bash
TMP=$(mktemp)
arc show <arc-id> --json | jq -j .description > "$TMP"
cat >> "$TMP" <<'EOF'

---
**Tracker:** [BT-3014](https://bactrack.atlassian.net/browse/BT-3014)
EOF
arc update <arc-id> --stdin < "$TMP"
rm -f "$TMP"
```

**Caution:** `arc update --description`/`--stdin` REPLACES the whole description — never pass only the link, or you erase the issue body.

Or use an arc field if one exists for tracker links.

**Tracker → Arc:** Stamp the arc ID and link into the created tracker issue.

```
**Origin:** arc issue agentmarke-0qex.04hl1w

Include an Arc URL only when `arc show` or project configuration provides a canonical base URL; never fabricate a host.
```

Or use the tracker's "Linked Issues" / "Related" feature if available.

### 10. Verify — Non-Negotiable

**Re-read both records.** Fetch the updated Arc issue and confirm its complete prior body plus the new tracker backlink remain present. Then re-read the created external issue and confirm its Arc origin plus sprint, labels, and assignee landed.

**Why this is non-negotiable — the create *response* is not proof.** The fields most likely to matter (sprint, labels) are routinely **absent from the create call's response payload even when they were applied correctly**. Trusting the response would falsely report a failure — and a naive "fix" would double-apply the field. Only a fresh read of the issue is ground truth.

1. **Fetch the created issue, requesting the flaky fields by name.** Default field sets often omit custom fields (e.g. the sprint custom field), so ask for them explicitly:
   ```bash
   # Jira: re-read with an explicit field list, e.g. fields=[summary, issuetype,
   #       assignee, labels, customfield_XXXXX]  (the sprint custom field id)
   # Linear: query the issue's cycle / labels / assignee fields explicitly
   # GitHub: gh issue view <number> --json labels,assignees,milestone
   ```

2. **For each known-flaky field (sprint, labels, assignee), compare requested vs. landed:**
   ```
   Requested sprint: "Sprint 47"
   Landed sprint: null  ← DISCREPANCY
   ```

3. **Report every discrepancy:**
   ```
   Warning: Sprint did not land on create. Attempted fix and re-verify.
   ```

4. **Attempt one auto-fix-and-re-verify:**
   - If sprint is missing, call update to set it, then re-read.
   - If labels are missing, call update to set them, then re-read.
   - If assignee is missing, call update to set it, then re-read.

5. **If a discrepancy survives the single retry, surface it clearly to the user:**
   ```
   Warning: BT-3014 — Sprint "Sprint 48" failed to land even after retry.
   Please set it by hand in Jira, or check your project's sprint configuration.
   ```
   Include the tracker key so the user can fix it manually. Do not loop; move on.

## Cache Schema — Explicit Contract

The cache file `~/.arc/tracker-map.yaml` is the durable interface between runs. It must tolerate missing files, missing entries, and missing keys (all gracefully fall back to discover-then-cache).

```yaml
# ~/.arc/tracker-map.yaml
trackers:
  jira:bactrack.atlassian.net:
    instance:                          # facts — expensive to rediscover, applied automatically
      cloud_id: <uuid>
      sprint_field: customfield_10020  # found via JQL probe
      issue_type_map:                  # createmeta probe to resolve; ids are instance-specific
        feature: { name: Story, id: "10001" }
        bug:     { name: Bug,   id: "10004" }
        task:    { name: Task,  id: "10002" }
        chore:   { name: Task,  id: "10002" }
      priority_map: { 0: Highest, 1: High, 2: Medium, 3: Low, 4: Lowest }
      assignee_aliases: { "ben firestone": <accountId> }
    prefs:                             # remembered choices — only pre-select a confirmable prompt
      last_project: BT
      # no sprint here — "current sprint" is resolved live each run
  linear:linear.app:
    instance:
      team_id: <uuid>
      issue_type_map:
        feature: { name: Feature, id: "..." }
        bug:     { name: Bug,     id: "..." }
      priority_map: { 0: Urgent, 1: High, 2: Medium, 3: Low, 4: Backlog }
      assignee_aliases: { "ben firestone": <user-id> }
    prefs:
      last_project: Arc
  github:github.com:
    instance:
      owner: bfirestone
      repo: agent-marketplace
    prefs: {}
```

**Rules:**
- Create the file on first run if it does not exist.
- If an entry for `<tracker>:<instance>` does not exist, discover and create it.
- If keys are missing within an entry, probe live and fill in.
- `instance` keys are applied automatically; `prefs` keys are used only to pre-select prompts.

## Scope (v1)

- **In scope:** One-way summarized snapshot, field mapping, backlinks, verification.
- **Out of scope:** Two-way status/comment sync, bulk export, scheduled mirroring.

Two-way sync is deferred to a future iteration.

## Rules

- Never paste the full arc issue verbatim. Summarize lossy.
- Always detect capability by reasoning over connected tools, not a hardcoded lookup.
- Never create a ticket if the required tool is not connected. Stop and guide the user.
- Always ask for ambiguous fields (issue type, assignee, project). Never guess.
- Resolve "current sprint" live every run; never use a cached sprint ID.
- Always verify the created issue. Report and attempt one auto-fix for flaky fields (sprint, labels, assignee).
- Cache discovered constants to `~/.arc/tracker-map.yaml` to skip probes on the next run.
- Format all arc content (descriptions, comments) per `skills/arc/_formatting.md`.
