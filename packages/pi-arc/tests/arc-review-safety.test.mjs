import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LEDGER_SENTINEL = '<!-- arc-review-ledger:v1 -->';
const REVIEWERS = {
  spec: {
    agentPath: 'agents/spec-reviewer.md',
    skillPath: 'skills/arc-build/SKILL.md',
    promptPath: 'skills/arc-build/spec-reviewer-prompt.md',
    workflowKey: 'spec-review',
    agent: 'arc-spec-reviewer',
    output: 'spec-review.md',
  },
  code: {
    agentPath: 'agents/code-reviewer.md',
    skillPath: 'skills/arc-review/SKILL.md',
    promptPath: 'skills/arc-review/code-reviewer-prompt.md',
    workflowKey: 'code-review',
    agent: 'arc-code-reviewer',
    output: 'code-review.md',
  },
};

function read(filePath) {
  return readFileSync(filePath, 'utf8');
}

function reviewerTools(source) {
  const match = source.match(/^tools:\n((?:  - .+\n)+)/m);
  assert.ok(match, 'reviewer frontmatter must define a tools list');
  return [...match[1].matchAll(/^  - (.+)$/gm)].map((entry) => entry[1]);
}

function workflowRequest(source, workflowKey) {
  const marker = `runs.run("${workflowKey}", {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${workflowKey} inner workflow`);
  const end = source.indexOf('});`', start);
  assert.notEqual(end, -1, `missing ${workflowKey} workflow terminator`);
  return source.slice(start, end);
}

function outerRequest(source, workflowKey) {
  const request = workflowRequest(source, workflowKey);
  const start = source.lastIndexOf('subagent({', source.indexOf(request));
  assert.notEqual(start, -1, `missing ${workflowKey} outer workflow`);
  const end = source.indexOf('\n})', source.indexOf(request));
  assert.notEqual(end, -1, `missing ${workflowKey} outer workflow terminator`);
  return source.slice(start, end);
}

function acceptsReview(manifest, baseline, workflowKey = 'spec-review', agent = 'arc-spec-reviewer') {
  return manifest?.version === 1
    && Array.isArray(manifest.groups)
    && manifest.groups.length > 0
    && manifest.groups.every((group) => group?.baseCommit === baseline.head
      && Array.isArray(group.children)
      && group.children.length === 1
      && group.children.every((child) => child?.workflowKey === workflowKey
        && child?.agent === agent
        && child?.status === 'completed'
        && child?.patch?.changed === false
        && child?.patch?.filesChanged === 0
        && child?.patch?.insertions === 0
        && child?.patch?.deletions === 0
        && child?.patch?.error == null));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();
}

function initializeRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'arc-review-safety-'));
  git(cwd, 'init', '-q', '-b', 'review-base');
  git(cwd, 'config', 'user.name', 'Arc Review Test');
  git(cwd, 'config', 'user.email', 'arc-review@example.invalid');
  writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-qm', 'base');
  return cwd;
}

function reviewBaseline(cwd) {
  return {
    branch: git(cwd, 'branch', '--show-current'),
    head: git(cwd, 'rev-parse', 'HEAD'),
    porcelainV2: git(cwd, 'status', '--porcelain=v2', '--untracked-files=all', '--', ':!.pi/subagents'),
  };
}

function isCleanReviewState(cwd) {
  return reviewBaseline(cwd).porcelainV2 === '';
}

function preservesReviewBaseline(cwd, baseline) {
  return assert.deepEqual(reviewBaseline(cwd), baseline) === undefined;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalBytes(description) {
  const index = description.lastIndexOf(LEDGER_SENTINEL);
  if (index === -1) throw new Error('initialized review ledger boundary is missing');
  return description.slice(0, index);
}

function launchedRuns(entries) {
  return entries.filter((entry) => typeof entry.run_id === 'string' && entry.run_id.length > 0);
}

function authorizedRuns(ledger) {
  return 4 + ledger.additionalAuthorizations.reduce((total, grant) => {
    assert.ok(Number.isSafeInteger(grant) && grant > 0, 'owner authorization must grant a finite positive run count');
    return total + grant;
  }, 0);
}

function canLaunchReviewer(ledger) {
  return launchedRuns(ledger.entries).length < authorizedRuns(ledger);
}

function recordNativeRun(ledger, reviewer, runId) {
  if (!runId) return;
  assert.ok(canLaunchReviewer(ledger), 'reviewer run budget exhausted');
  ledger.entries.push({
    sequence: ledger.entries.length + 1,
    reviewer,
    run_id: runId,
    base: 'base',
    head: 'head',
    elapsed_ms: 0,
    disposition: 'launched',
  });
}

function reviewInput({ priorFindings, latestFixDelta, cycle }) {
  return {
    canonical_spec: 'canonical task',
    canonical_sha256: sha256('canonical task'),
    design_excerpt: 'approved design',
    diff_path: '/tmp/arc-review-input/diff.patch',
    diff_sha256: sha256(latestFixDelta),
    prior_findings: priorFindings,
    latest_fix_delta: latestFixDelta,
    cycle,
  };
}

test('reviewer agents expose only read, find, and grep', () => {
  assert.deepEqual(reviewerTools(read(REVIEWERS.spec.agentPath)), ['read', 'find', 'grep']);
  assert.deepEqual(reviewerTools(read(REVIEWERS.code.agentPath)), ['read', 'find', 'grep']);
});

test('mandatory review guidance defines one stable isolated foreground reviewer inside an async workflow', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    const request = workflowRequest(source, review.workflowKey);
    const outer = outerRequest(source, review.workflowKey);

    assert.match(request, new RegExp(`agent: "${review.agent}"`));
    assert.match(request, /worktree: true/);
    assert.match(request, /async: false/);
    assert.match(request, new RegExp(`output: "${review.output.replace('.', '\\.')}"`));
    assert.match(outer, /context: "fresh"/);
    assert.match(outer, /async: true/);
    assert.match(outer, /globalConcurrencyLimit: 1/);
    assert.match(outer, /(?:baseRef|\["baseRef"\]): "HEAD"/);
    assert.match(outer, /return await runs\.run/);
    assert.equal((outer.match(/runs\.run\(/g) ?? []).length, 1, 'mandatory workflow must launch exactly one reviewer');
  }
});

test('review acceptance rejects wrong identity, base, status, and every patch mutation', () => {
  const baseline = { branch: 'main', head: 'a'.repeat(40), porcelainV2: '' };
  const validNoChangeManifest = {
    version: 1,
    groups: [{
      baseCommit: baseline.head,
      children: [{
        workflowKey: 'spec-review',
        agent: 'arc-spec-reviewer',
        status: 'completed',
        patch: { changed: false, filesChanged: 0, insertions: 0, deletions: 0, error: null },
      }],
    }],
  };

  assert.equal(acceptsReview(validNoChangeManifest, baseline), true);
  assert.equal(acceptsReview({ ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], baseCommit: 'b'.repeat(40) }] }, baseline), false);
  assert.equal(acceptsReview({ ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [{ ...validNoChangeManifest.groups[0].children[0], agent: 'arc-code-reviewer' }] }] }, baseline), false);
  assert.equal(acceptsReview({ ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [{ ...validNoChangeManifest.groups[0].children[0], status: 'failed' }] }] }, baseline), false);

  for (const patch of [
    { changed: true, filesChanged: 0, insertions: 0, deletions: 0, error: null },
    { changed: false, filesChanged: 1, insertions: 0, deletions: 0, error: null },
    { changed: false, filesChanged: 0, insertions: 1, deletions: 0, error: null },
    { changed: false, filesChanged: 0, insertions: 0, deletions: 1, error: null },
    { changed: false, filesChanged: 0, insertions: 0, deletions: 0, error: 'capture failed' },
  ]) {
    const changedPatchManifest = structuredClone(validNoChangeManifest);
    changedPatchManifest.groups[0].children[0].patch = patch;
    assert.equal(acceptsReview(changedPatchManifest, baseline), false);
  }
});

test('documented handoff predicate checks exact identity, base, completion, and no-change evidence', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /\.version == 1/);
    assert.match(source, /\.baseCommit == \$base/);
    assert.match(source, /\.children \| type == "array" and length == 1/);
    assert.match(source, /\.workflowKey == \$key/);
    assert.match(source, /\.agent == \$agent/);
    assert.match(source, /\.status == "completed"/);
    assert.match(source, /\.patch\.changed == false/);
    assert.match(source, /\.patch\.filesChanged == 0/);
    assert.match(source, /\.patch\.insertions == 0/);
    assert.match(source, /\.patch\.deletions == 0/);
    assert.match(source, /\.patch\.error == null/);
    assert.match(source, /artifactPaths/);
    assert.match(source, /exactly one returned path ending in `handoffs\/<run-id>\.json`/i);
  }
});

test('clean-state predicate accepts clean state and rejects staged, tracked, and untracked changes', async (t) => {
  const mutations = {
    staged(cwd) {
      writeFileSync(path.join(cwd, 'staged.txt'), 'staged\n');
      git(cwd, 'add', 'staged.txt');
    },
    tracked(cwd) {
      writeFileSync(path.join(cwd, 'tracked.txt'), 'modified\n');
    },
    untracked(cwd) {
      writeFileSync(path.join(cwd, 'untracked.txt'), 'untracked\n');
    },
  };

  await t.test('clean state', () => {
    const cwd = initializeRepository();
    try {
      assert.equal(isCleanReviewState(cwd), true);
      mkdirSync(path.join(cwd, '.pi', 'subagents'), { recursive: true });
      writeFileSync(path.join(cwd, '.pi', 'subagents', 'provider.json'), '{}\n');
      assert.equal(isCleanReviewState(cwd), true, 'provider-owned .pi/subagents state must be excluded');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const cwd = initializeRepository();
      try {
        mutate(cwd);
        assert.equal(isCleanReviewState(cwd), false);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

test('post-run invariant rejects branch, HEAD, and status mutations after success and failure', async (t) => {
  const mutations = {
    branch(cwd) {
      git(cwd, 'switch', '-qc', 'mutated-branch');
    },
    HEAD(cwd) {
      git(cwd, 'commit', '--allow-empty', '-qm', 'mutated head');
    },
    status(cwd) {
      writeFileSync(path.join(cwd, 'tracked.txt'), 'mutated status\n');
    },
  };

  for (const terminalOutcome of ['success', 'failure']) {
    await t.test(`${terminalOutcome} without mutation`, () => {
      const cwd = initializeRepository();
      try {
        const baseline = reviewBaseline(cwd);
        assert.equal(preservesReviewBaseline(cwd, baseline), true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    for (const [name, mutate] of Object.entries(mutations)) {
      await t.test(`${terminalOutcome}: ${name} mutation`, () => {
        const cwd = initializeRepository();
        try {
          const baseline = reviewBaseline(cwd);
          mutate(cwd);
          assert.throws(() => preservesReviewBaseline(cwd, baseline));
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });
    }
  }
});

test('mandatory review guidance fails closed on dirty state and preserves every post-run invariant', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /REVIEW_BRANCH=\$\(git branch --show-current\)/);
    assert.match(source, /REVIEW_BASE=\$\(git rev-parse HEAD\)/);
    assert.match(source, /REVIEW_STATE=\$\(git status --porcelain=v2 --untracked-files=all -- ':!\.pi\/subagents'\)/);
    assert.match(source, /test -n "\$REVIEW_BRANCH"/);
    assert.match(source, /review requires a clean source checkout/);
    assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$REVIEW_BASE"/);
    assert.match(source, /test "\$\(git branch --show-current\)" = "\$REVIEW_BRANCH"/);
    assert.match(source, /test -z "\$\(git status --porcelain=v2 --untracked-files=all -- ':!\.pi\/subagents'\)"/);
    assert.match(source, /after every terminal outcome/i);
    assert.match(source, /CURRENT_CANONICAL_SHA256/);
    assert.match(source, /test "\$CURRENT_CANONICAL_SHA256" = "\$CANONICAL_SHA256"/);
    assert.match(source, /Never reset, restore, clean, stash, commit, or switch execution mode automatically/);
  }
});

test('versioned ledger preserves canonical bytes and shares one four-run budget across reviewers', () => {
  const canonical = '# Canonical task\n\nExact task bytes.';
  const canonicalHash = sha256(canonical);
  const description = `${canonical}${LEDGER_SENTINEL}\n## Review Ledger\nCanonical description SHA-256: \`${canonicalHash}\`\nAuthorized reviewer runs: 4\n`;
  const ledger = { entries: [], additionalAuthorizations: [] };

  assert.equal(canonicalBytes(description), canonical);
  assert.equal(sha256(canonicalBytes(description)), canonicalHash);

  recordNativeRun(ledger, 'spec', 'run-1');
  recordNativeRun(ledger, 'code', 'run-2');
  recordNativeRun(ledger, 'spec', 'run-3');
  recordNativeRun(ledger, 'code', 'run-4');
  recordNativeRun(ledger, 'spec', undefined);

  assert.equal(launchedRuns(ledger.entries).length, 4);
  assert.deepEqual(ledger.entries.map((entry) => entry.reviewer), ['spec', 'code', 'spec', 'code']);
  assert.equal(canLaunchReviewer(ledger), false);
  assert.throws(() => recordNativeRun(ledger, 'spec', 'run-5'), /budget exhausted/);
  assert.equal(sha256(canonicalBytes(`${description}| 1 | spec | run-1 | base | head | 0 | launched |\n`)), canonicalHash);

  ledger.additionalAuthorizations.push(1);
  assert.equal(canLaunchReviewer(ledger), true);
  recordNativeRun(ledger, 'spec', 'run-5');
  assert.equal(canLaunchReviewer(ledger), false);
  assert.throws(() => authorizedRuns({ ...ledger, additionalAuthorizations: [Number.POSITIVE_INFINITY] }), /finite positive/);
});

test('canonical extraction uses the final sentinel when task prose quotes earlier examples', () => {
  const canonical = [
    '# Canonical task',
    '',
    `The protocol documents ${LEDGER_SENTINEL} inline.`,
    '',
    'It also includes the exact example:',
    LEDGER_SENTINEL,
    '## Review Ledger',
    'Authorized reviewer runs: 4',
    '',
    'The canonical task continues after both quoted examples.',
  ].join('\n');
  const canonicalHash = sha256(canonical);
  const initializedDescription = `${canonical}${LEDGER_SENTINEL}\n## Review Ledger\nCanonical description SHA-256: \`${canonicalHash}\`\nAuthorized reviewer runs: 4\n`;
  const firstBoundary = initializedDescription.indexOf(LEDGER_SENTINEL);
  const firstOccurrenceExtraction = initializedDescription.slice(0, firstBoundary);

  assert.equal((canonical.match(new RegExp(LEDGER_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 2);
  assert.notEqual(firstOccurrenceExtraction, canonical, 'first-occurrence extraction must truncate this fixture');
  assert.notEqual(sha256(firstOccurrenceExtraction), canonicalHash, 'the truncated first-occurrence hash must be wrong');
  assert.equal(canonicalBytes(initializedDescription), canonical);
  assert.equal(sha256(canonicalBytes(initializedDescription)), canonicalHash);
  assert.throws(() => canonicalBytes('# ledger initialization lost its boundary'), /ledger boundary/i);

  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /actual ledger boundary is the last exact sentinel/i);
    assert.match(source, /canonical task prose (?:or|and) code may quote earlier sentinel examples/i);
    assert.match(source, /rpartition\(marker\)/);
    assert.match(source, /assert found/);
    assert.match(source, /no last boundary.*fail closed|fail closed.*no last boundary/i);
    assert.doesNotMatch(source, /data\.partition\(marker\)|split (?:its description )?at the first exact (?:ledger )?sentinel/i);
  }
});

test('guidance defines canonical ledger sentinel, launched-run accounting, and bounded owner authorization', () => {
  const source = `${read(REVIEWERS.spec.skillPath)}\n${read(REVIEWERS.code.skillPath)}`;
  assert.match(source, /<!-- arc-review-ledger:v1 -->\n## Review Ledger\nCanonical description SHA-256: `<sha256>`\nAuthorized reviewer runs: 4/);
  assert.match(source, /ReviewLedgerEntry.*sequence.*reviewer.*run_id.*base.*head.*elapsed_ms.*disposition/s);
  assert.match(source, /pre-submission failure.*does not consume/i);
  assert.match(source, /native run identity.*consume/i);
  assert.match(source, /spec and code review.*combined|combined.*spec and code review/i);
  assert.match(source, /fifth launch/i);
  assert.match(source, /explicit owner authorization.*finite additional count/i);
  assert.match(source, /above the sentinel.*never change/i);

  const reviewFixSection = read(REVIEWERS.code.skillPath).slice(
    read(REVIEWERS.code.skillPath).indexOf('### 5. Handle Fixes'),
    read(REVIEWERS.code.skillPath).indexOf('### 6. Proceed'),
  );
  assert.match(reviewFixSection, /combined four-launched-run spec\/code budget/i);
  assert.doesNotMatch(reviewFixSection, /3 review\/fix cycles/i);
});

test('re-review input carries prior findings and the exact latest fix delta', () => {
  const priorFindings = '- Critical: validation absent';
  const latestFixDelta = 'diff --git a/a.js b/a.js\n+validate();\n';
  const input = reviewInput({ priorFindings, latestFixDelta, cycle: 2 });

  assert.equal(input.prior_findings, priorFindings);
  assert.equal(input.latest_fix_delta, latestFixDelta);
  assert.equal(input.cycle, 2);

  for (const review of Object.values(REVIEWERS)) {
    const prompt = read(review.promptPath);
    assert.match(prompt, /\{PRIOR_FINDINGS\}/);
    assert.match(prompt, /\{LATEST_FIX_DELTA\}/);
    assert.match(prompt, /exact newest fix delta/i);
  }
});

test('non-inline review input is immutable, external, hash-addressed, and rechecked', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /REVIEW_INPUT_DIR=\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/arc-review-input\.XXXXXX"\)/);
    assert.match(source, /git diff --binary --find-renames=0 "\$BASE_SHA\.\.\$HEAD_SHA" > "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /chmod 0444 "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /DIFF_SHA256=\$\(sha256sum "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /test "\$\(sha256sum "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /outside the repository/i);
    assert.match(source, /path, SHA-256, base, and head/i);
  }

  const root = mkdtempSync(path.join(tmpdir(), 'arc-review-artifact-test-'));
  try {
    const artifact = path.join(root, 'diff.patch');
    writeFileSync(artifact, 'immutable diff\n');
    const expectedHash = sha256(readFileSync(artifact));
    chmodSync(artifact, 0o444);
    assert.equal(statSync(artifact).mode & 0o777, 0o444);
    assert.equal(sha256(readFileSync(artifact)), expectedHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewers and prompts prohibit all mutation and delegation paths', () => {
  for (const review of Object.values(REVIEWERS)) {
    const combined = `${read(review.agentPath)}\n${read(review.promptPath)}`;
    assert.match(combined, /repository writes? (?:or|and) artifacts?/i);
    assert.match(combined, /Git\/ref changes/i);
    assert.match(combined, /Arc mutation/i);
    assert.match(combined, /package installation/i);
    assert.match(combined, /cache\/build generation/i);
    assert.match(combined, /writer delegation/i);
    assert.match(combined, /any mutation invalidates the review/i);
  }
});

test('review compatibility floor is documented without bundling the provider', () => {
  for (const filePath of ['README.md', '../../docs/packages/pi-arc.md']) {
    const source = read(filePath);
    assert.match(source, /pi-subagents 0\.66\.0\+ is the tested delegated-review compatibility floor/);
    assert.match(source, /separately installed and unbundled/i);
    assert.match(source, /capability and native handoff evidence, not semver alone/i);
    assert.match(source, /Mandatory reviews require a clean checkout and native isolated worktrees/);
  }
});
