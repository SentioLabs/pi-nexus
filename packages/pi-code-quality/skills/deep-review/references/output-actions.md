# Output Actions — delivery procedure for deep-review

Read this file when the review is synthesized and ready to deliver. The default flow is:
**detect mode → detect a PR → ask the user (only when interactive) → render and deliver**.

## 1. Detect interactive vs. non-interactive (CI/CD) mode

The skill runs in two contexts:

- **Interactive** — a human is in the loop in a Pi session or IDE extension.
  Use `ask_user_question` only when the tool is available.
- **Non-interactive** — running headless in CI/CD, a scheduled job, or automation.
  `ask_user_question` has no human to answer it; either it errors or it stalls
  the job.

Detect non-interactive mode only if **any** of these is true:

```bash
[ "${CI:-}"             = "true" ] || \
[ "${GITHUB_ACTIONS:-}" = "true" ] || \
[ "${GITLAB_CI:-}"      = "true" ] || \
[ "${BUILDKITE:-}"      = "true" ]
```

If the user passed an explicit non-interactive flag in their request
("non-interactive mode", "headless", "CI mode", "auto-post"), treat it as
non-interactive regardless of env. The tool subprocess stdin may be non-TTY during an interactive session;
do **not** infer CI from it. Pi tools may run with non-TTY stdin during interactive sessions.

In non-interactive mode:

- **Skip `ask_user_question` entirely.** Never call it — it is interactive
  by design.
- **Default behavior depends on PR detection and GitHub delivery preflight**
  (next sections):
  - PR detected and `command -v gh` plus `gh auth status` succeed → post
    the rendered PR comment automatically.
  - PR detected but `gh` is unavailable or unauthenticated → write
    `DEEP_REVIEW.md`, print the one-line summary, and surface that PR
    delivery was unavailable.
  - No PR detected → write `DEEP_REVIEW.md` to the working directory and
    additionally print a one-line summary (verdict + grade + final score)
    to stdout so the CI log captures it.
- **Never prompt for confirmation before posting.** In CI the user has
  already opted in to auto-posting by triggering the workflow; an
  unanswered confirm would block the job.
- **Surface failures visibly.** If the preflight passes but the actual
  `gh pr comment` post fails (auth, rate limit, repo permissions), exit
  non-zero with the error so the workflow step fails loudly. Do not
  silently fall back.

## 2. Detect whether a PR exists

Determine whether a pull request is in scope, in priority order:

1. **Explicit PR in the original request.** If the user passed a PR number
   (`/code-quality-review #436`) or URL, use it directly.
2. **GitHub Actions event payload.** If running under GitHub Actions and
   the triggering event is a pull request, read the PR number from
   `GITHUB_EVENT_PATH`:

   ```bash
   if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
     jq -r '.pull_request.number // empty' "$GITHUB_EVENT_PATH"
     # repo: $GITHUB_REPOSITORY (owner/name)
   fi
   ```

   This works on `pull_request` and `pull_request_target` triggers without
   requiring a checked-out PR branch.
3. **Current branch's open PR.** Otherwise run:

   ```bash
   gh pr view --json number,url,headRepository,baseRepository \
     --jq '{number, url, repo: (.baseRepository.owner.login + "/" + .baseRepository.name)}' \
     2>/dev/null
   ```

   If this returns a PR number, "Post comment to PR" is available. If it
   fails (no PR open, not a GitHub repo, no `gh` auth), the option is
   unavailable.

## 3. Ask the user (interactive mode only)

**Skip this section entirely in non-interactive mode** (per §1). In CI,
post the PR comment via §4 only when a PR was detected and GitHub delivery
preflight passes. If a PR was detected but `gh` is unavailable or unauthenticated,
write `DEEP_REVIEW.md`, print the one-line summary, and
surface that PR delivery was unavailable.

In interactive mode, use `ask_user_question` with the `questions[]` JSON
shape only when that tool is available. If it is unavailable, use a plain-chat
conversational fallback: ask the user how to deliver the report, or return it
inline when no response is needed. When a PR was detected, first verify GitHub
delivery availability:

```bash
command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
```

An equivalent explicit availability/auth check is acceptable. If this
preflight fails, **Do not offer the PR-post option**. Offer
`Write DEEP_REVIEW.md` and `Return inline` through the available question
tool or the plain-chat conversational fallback, and tell the user GitHub PR
delivery is unavailable or unauthenticated.

**PR detected and GitHub delivery available — when `ask_user_question` is
available, present two options using its `questions[]` shape:**

```json
{
  "questions": [
    {
      "question": "How would you like to surface these findings?",
      "header": "Output",
      "options": [
        {
          "label": "Post comment to PR #<N> (Recommended)",
          "description": "Post the rendered review as a single PR comment via gh pr comment."
        },
        {
          "label": "Write DEEP_REVIEW.md",
          "description": "Write the full markdown report to DEEP_REVIEW.md at the repo root without committing."
        }
      ]
    }
  ]
}
```

Use 2-4 concise options. Mark the PR option as `(Recommended)` only when
a PR is detected and GitHub delivery is available. The `ask_user_question`
tool supplies `Type something.` / `Chat about this` free-form escape hatches;
pi-code-quality does not bundle that tool, so do not add manual pseudo-options
or claim the package supplies them.

**No PR detected — skip the question.** Write `DEEP_REVIEW.md` directly and
tell the user: "No open PR found for this branch — wrote findings to
`DEEP_REVIEW.md` (untracked)." If the user wants something else they can
ask in their next turn. Do not present a 1-option menu; when the question
tool is unavailable, use the plain-chat conversational fallback instead.

If the user makes a free-form escape-hatch request, parse it. Common requests
to handle:

- Review branch + markdown — see §7
- GitHub issues for each confirmed finding — see §7
- Inline review comments at specific lines — see §7
- Print to terminal only — just emit the markdown report and exit

## 4. Posting to a PR

Only post when a PR was detected and GitHub delivery preflight succeeds.
Run the preflight before offering a PR-post option and again immediately
before posting in non-interactive mode:

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
```

An equivalent explicit availability/auth check is acceptable. If preflight
fails:

- **Interactive:** Do not offer the PR-post option. Write `DEEP_REVIEW.md`,
  return inline output, or honor a free-form delivery request; tell the user
  GitHub PR delivery is unavailable or unauthenticated.
- **Non-interactive:** write `DEEP_REVIEW.md`, print the one-line summary,
  and surface that PR delivery was unavailable. Do not attempt
  `gh pr comment`.

When preflight passes and the user selects "Post comment to PR"
(interactive) OR when running non-interactively with a PR detected, render
the report using the **PR Comment Format** in §5. **This is structurally
different from the full markdown report** — the report is exhaustive; the
PR comment is glanceable with collapsibles for the deep tables.

Steps:

1. Render the comment to a temp file (e.g., `/tmp/deep-review-<pr>.md`).
2. **Interactive mode only:** show the user a brief preview hint (top 5
   lines + section list) and confirm — even though they already chose
   this option, the comment contents weren't visible at the time of
   choice. A confirmation here avoids posting a comment they wouldn't
   have approved. **Skip the confirm in non-interactive mode** — the user
   pre-authorized auto-posting by triggering the workflow.
3. Post:

   ```bash
   gh pr comment <PR_NUMBER> --body-file <path> --repo <owner>/<repo>
   ```

   `--repo` is required when the PR is in a different repository than the
   current working directory; §2's detection returns the value to use.
   In GitHub Actions the value is `$GITHUB_REPOSITORY`.
4. Echo the comment URL returned by `gh pr comment` back to the user (or
   to stdout in CI) so they can verify.
5. If the actual `gh pr comment` post fails after preflight passed, exit non-zero with the error.
   Do not silently fall back to writing
   `DEEP_REVIEW.md` — that hides a real delivery failure.

**Do not** reference `DEEP_REVIEW.md` or other uncommitted files in the
posted comment — links to untracked paths 404 from the PR view. Attribution
should be a plain `<sub>` footer with no links.

## 5. PR Comment Format

The PR comment is rendered for fast skimming inside a PR conversation.
Use this exact structure:

```markdown
## 🤖 Deep Review — `<branch-name>`

| | |
|---|---|
| **Grade** | **B** (72/100) |
| **Local code** | 74/100 |
| **Solution fit** | 68/100 |
| **Verdict** | Mild concerns |
| **AI slop / curation** | Moderate signals · Driver curation: PARTIALLY_CURATED |

> ⚠️ Include a one-line caution here ONLY when Driver Curation is UNCURATED
> and the grade is B or above.

### 🔥 Must-fix before merge
<checklist of cap-triggering findings: confirmed security/correctness ≥ 86,
test-gaming, cap-triggering solution-fit. Omit heading when empty.>

### 💡 Worth considering
<top 3-5 non-blocking confirmed findings, one line each>

### 🏗️ <Architectural concern headline, if any>
<2-3 sentences + better direction>

<details>
<summary>🛡️ Security findings (N)</summary>

| # | File:Line | Category | Severity | Finding | Confidence |
|---|-----------|----------|----------|---------|------------|
</details>

<details>
<summary>🔍 Correctness & quality findings (N)</summary>

| # | File:Line | Signal | Finding | Confidence |
|---|-----------|--------|---------|------------|
</details>

<details>
<summary>📐 Idiom & best-practices findings (N)</summary>

| # | File:Line | Signal | Finding | Idiomatic Alternative | Confidence |
|---|-----------|--------|---------|----------------------|------------|
</details>

<details>
<summary>🏗️ Solution-fit findings (N)</summary>

| # | Area | Signal | Finding | Better Direction | Confidence |
|---|------|--------|---------|------------------|------------|
</details>

<details>
<summary>🤖 AI slop assessment & driver curation (advisory)</summary>

**Driver curation:** <verdict> — driven by <signal families>.

| File | Authorship score (higher = more human-like) | Key signals |
|------|--------------------------------------------:|-------------|

<curation evidence summary: documented vs undocumented divergences,
surviving artifacts, commit forensics>
</details>

### 📚 Education opportunity
<omit when none>

<sub>Generated by `/code-quality-review` · 5-lens scan + calibration</sub>
```

**Rendering rules for the PR comment:**

1. **Lead with the grade table.** Most informative thing in a 5-line glance
   — grade, local code, solution fit, verdict, and the slop/curation line.
2. **Reserve the ⚠️ caution blockquote** for the one case it exists to flag:
   Driver Curation is UNCURATED and the grade is B or above. Omit it
   otherwise — don't reach for GitHub alert syntax elsewhere in the comment.
3. **Use task-list checkboxes** (`- [ ]`) for fixable items. They become
   interactive in the PR UI so the author can check them off as they fix —
   the comment doubles as a punch list.
4. **Push lens detail tables into `<details>` blocks.** A skimmable comment
   beats an exhaustive one. Open by default only the grade table and the
   must-fix list — the AI-slop/curation collapsible is advisory and always
   goes last.
5. **Trim file paths.** If every entry shares a common prefix, drop it.
   Narrow viewports collapse long paths and lose the file name.
6. **Use the emoji vocabulary consistently.** 🔥 must-fix · 💡 worth
   considering · 🏗️ architecture / solution-fit · 🛡️ security ·
   🔍 correctness & quality · 📐 idiom & best-practices · 🤖 AI slop /
   driver curation · 📚 education. Don't reach for emoji elsewhere.
7. **No broken links.** Do not reference `DEEP_REVIEW.md` or any other
   uncommitted file. The `<sub>` footer is enough attribution.
8. **Footer attribution** uses `<sub>` for de-emphasis. Keep it one line
   with no links.

## 6. Writing DEEP_REVIEW.md

When the user selects "Write DEEP_REVIEW.md" (interactive), when no PR is
detected non-interactively, **or when a PR was detected but `gh` is unavailable or unauthenticated**,
write the full markdown report (per the **Output Format**
section of SKILL.md) to `DEEP_REVIEW.md` at the repo root. Do not commit, do not push.
The unavailable/unauthenticated-`gh` path is a neutral local-report
fallback, not a failed PR-post attempt.

- **Interactive:** tell the user the file was written and that it is
  currently untracked.
- **Non-interactive (CI):** also print a single-line summary to stdout —
  `deep-review: <verdict> · grade <letter> · <final_score>/100 · wrote
  DEEP_REVIEW.md` — so the workflow log captures the result. When this followed
  a PR detection with unavailable or unauthenticated `gh`, also surface that PR
  delivery was unavailable. If the CI is expected to upload `DEEP_REVIEW.md` as
  a workflow artifact, the path should remain at the repo root unless the
  workflow specifies otherwise.

If `DEEP_REVIEW.md` already exists:

- **Interactive:** ask whether to overwrite, append, or write to a
  date-stamped filename (e.g., `DEEP_REVIEW.<YYYY-MM-DD>.md`).
- **Non-interactive:** overwrite without prompting. CI runs are expected
  to be reproducible; appending across runs would corrupt artifacts.

## 7. Free-form escape-hatch delivery shapes

These are fallbacks — only use when the user explicitly makes a free-form
escape-hatch request through an available question tool or plain chat.

### GitHub-backed alternate delivery preflight

Before every GitHub-backed alternate delivery — creating GitHub issues,
posting inline review comments with `gh api`, or a combined action that
includes either — both preflight commands must pass:

```bash
command -v gh >/dev/null 2>&1
gh auth status >/dev/null 2>&1
```

Run this preflight before each GitHub-backed action, including the
actionable part of a combined delivery. If either command fails because
`gh` is unavailable or unauthenticated, do not invoke `gh`. Instead
retain/report the findings via `DEEP_REVIEW.md` or inline output and state
GitHub delivery is unavailable.

If preflight passed but an actual `gh issue create` or `gh api` post/create
fails, let the failure remain loud and non-zero; do not silently fall back.

**Review branch with markdown report.** Best for full-codebase audits and
archival. Create a new branch `<user>/deep-review`, write to
`DEEP_REVIEW.md` at the repo root, commit, and push. Tell the user
the branch is ready and they can open a PR for team discussion. Use
`DEEP_REVIEW.md`, never a `CLAUDE_*` report filename.

**GitHub issues.** Best for tech-debt tracking. For each confirmed finding
(or group of related findings), create a GitHub issue with: descriptive
title, SHA-pinned permalink(s) to the offending code, signal category and
severity, suggested fix, and appropriate labels (`ai-slop`, severity
labels). Group related findings into single issues where it makes sense
("4 instances of bare except Exception: pass" is one issue, not four).
Ask whether to create a milestone (e.g., "AI Slop Cleanup") before opening
issues.

**Inline PR review comments.** Best when findings map to specific changed
lines and the team prefers per-line review. For each confirmed finding,
post an inline review comment at the exact file and line using
`gh api repos/{owner}/{repo}/pulls/{pr}/reviews`:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews -f event=COMMENT \
  -f body="Deep Review: found N issues" \
  -f 'comments[][path]=...' -f 'comments[][line]=...' \
  -f 'comments[][body]=...'
```

Group related findings into a single review submission. Format each
inline comment as:

```text
**[Signal: <category>]** <finding description>

<why this matters and what idiomatic code would look like>
```

Keep inline comments concise — a reviewer, not an essay writer.

**Combined.** The user may want both an archival markdown AND actionable
items. If so, do the markdown delivery first, then the actionable
delivery. Update issue/comment bodies to reference the markdown only if
that file has been committed and pushed (otherwise the link 404s).
