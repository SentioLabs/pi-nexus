import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const readText = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));

function assertPatternsInOrder(text, patterns, context) {
  let offset = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(offset));
    assert.notEqual(match, null, `${context}: missing ordered pattern ${pattern}`);
    offset += match.index + match[0].length;
  }
}

test("package exposes exactly the review-responder skill", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@sentiolabs/pi-review-responder");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal("prompts" in pkg.pi, false);
  assert.equal(existsSync(new URL("../skills/review-responder/SKILL.md", import.meta.url)), true);
});

test("generated skill preserves source behavior and Pi safety contracts", () => {
  const skill = readText("skills/review-responder/SKILL.md");
  for (const required of [
    /\nlicense: MIT\n/,
    /reviewThreads\(first: 100, after: \$threadCursor\)/,
    /node\(id: \$threadId\)/,
    /comments\(first: 100, after: \$commentCursor\)/,
    /pageInfo \{ hasNextPage endCursor \}/,
    /headRefOid/,
    /base repository/i,
    /fork PR/i,
    /untrusted evidence/i,
    /separate git-publication approval/i,
    /batch.*reply.*approval/i,
    /Won't fix.*confirm/is,
    /gh api user --jq \.login/,
    /gh api --hostname [^\n]* user --jq \.login/,
    /gh auth status --hostname/,
    /pi-review-responder: comment=<databaseId> verdict=<slug> evidence=<oid>/,
    /newly resolved/i,
    /ambiguous.*(?:timeout|failure)/i,
    /partial batch/i,
    /Fixed.*Already fixed.*ancestor/is,
    /file-backed JSON/i,
    /gh api --hostname "\$host" --method POST \\\n  "repos/,
    /does not resolve/i,
    /\| \*\*Valid\*\*/,
    /\| \*\*Already fixed\*\*/,
    /\| \*\*Invalid\*\*/,
    /\| \*\*Won't fix\*\*/,
    /\| \*\*Not applicable\*\*/,
  ]) {
    assert.match(skill, required);
  }
  for (const forbidden of [
    /\$\{CLAUDE_PLUGIN_ROOT\}/,
    /AskUserQuestion/,
    /\[ ! -t 0 \]/,
    /Resolving as not applicable/,
    /## Phase 5: Commit and Push[\s\S]*git add <specific-files>[\s\S]*git push/,
  ]) {
    assert.doesNotMatch(skill, forbidden);
  }
});

test("generated workflow orders retrieval and post-approval safety checks", () => {
  const skill = readText("skills/review-responder/SKILL.md");
  const fetchPhase = skill.slice(
    skill.indexOf("## Phase 2: Fetch Unresolved Review Threads"),
    skill.indexOf("## Phase 3: Evaluate Validity"),
  );
  assertPatternsInOrder(fetchPhase, [
    /retain every thread `id` plus its `isResolved` state without filtering or\s+fetching comments/i,
    /continue[^.]*while `hasNextPage` is true/is,
    /only after[^.]*complete[^.]*filter/is,
    /for each thread that remains unresolved[^.]*comments/is,
  ], "complete thread retrieval before filtering");

  const scopePhase = skill.slice(
    skill.indexOf("## Phase 1: Identify Scope"),
    skill.indexOf("## Phase 2: Fetch Unresolved Review Threads"),
  );
  assertPatternsInOrder(scopePhase, [
    /require `command -v gh` to exit successfully/i,
    /stop without invoking\s+`gh auth status`[^.]*without making an API call/is,
    /only after that success, run `gh auth status`/i,
    /require successful authentication/i,
    /stop before\s+any `gh pr view`, GraphQL, or REST call/is,
    /only after both checks succeed[^.]*GitHub API/is,
  ], "fail-closed gh availability and authentication preflight");

  const replyPhase = skill.slice(
    skill.indexOf("## Phase 6: Preview and Post Replies"),
    skill.indexOf("## Important Notes"),
  );
  assertPatternsInOrder(replyPhase, [
    /explicit approval of\s+the batch/i,
    /after that approval and immediately before each REST post/i,
    /refresh[^.]*headRefOid[^.]*canonical base repository/is,
    /re-check[^.]*verdict[^.]*evidence/is,
    /every \*\*Fixed\*\* and \*\*Already fixed\*\*[^.]*equals[^.]*ancestor/is,
    /evidence changed[^.]*new reply preview[^.]*approval/is,
    /re-fetch that thread[^.]*complete comment pagination/is,
    /gh api --hostname "\$host" --method POST/,
  ], "post-approval refresh before every reply post");

  assert.match(
    replyPhase,
    /\*\*Fixed\*\* and \*\*Already fixed\*\*[^\n]*marker `evidence`[^\n]*exactly the cited fix commit SHA/i,
  );
  assert.match(
    replyPhase,
    /\*\*Invalid\*\*, \*\*Won't fix\*\*, and \*\*Not applicable\*\*[\s\S]{0,120}marker `evidence`[\s\S]{0,120}evaluated and refreshed PR `headRefOid`/i,
  );
});

test("npm pack contains runtime and package docs but no maintainer tooling", () => {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8" },
  ));
  const paths = new Set(packed[0].files.map(({ path }) => path));
  assert.deepEqual(
    [...paths].filter((path) => path.startsWith("skills/")).sort(),
    ["skills/review-responder/SKILL.md"],
  );
  for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE"]) {
    assert.equal(paths.has(required), true, `${required} should be packed`);
  }
  assert.equal(
    [...paths].some((path) =>
      path.startsWith("scripts/") ||
      path.startsWith("tests/") ||
      path.startsWith(".pi/") ||
      path.includes("__pycache__") ||
      path.startsWith(".claude-plugin/")
    ),
    false,
  );
});
