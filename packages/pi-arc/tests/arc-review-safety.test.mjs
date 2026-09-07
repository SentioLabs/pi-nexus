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

function workflowExample(source, workflowKey) {
  const marker = `return await runs.run("${workflowKey}"`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${workflowKey} inner workflow`);
  const fenceStart = source.lastIndexOf('```typescript\n', markerIndex);
  assert.notEqual(fenceStart, -1, `missing ${workflowKey} TypeScript fence`);
  const expressionStart = fenceStart + '```typescript\n'.length;
  const fenceEnd = source.indexOf('\n```', markerIndex);
  assert.notEqual(fenceEnd, -1, `missing ${workflowKey} workflow fence terminator`);
  return source.slice(expressionStart, fenceEnd);
}

async function executeWorkflowExample(source, workflowKey) {
  const expression = workflowExample(source, workflowKey);
  const outerRequests = [];
  const innerRequests = [];
  const childResult = { key: workflowKey, ok: true };
  const evaluateOuter = Function('subagent', `"use strict"; return (${expression});`);
  const outerResult = evaluateOuter((request) => {
    outerRequests.push(request);
    return request;
  });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const executeInner = new AsyncFunction('runs', outerResult.workflowScript);
  const returned = await executeInner({
    async run(key, request) {
      innerRequests.push({ key, request });
      return childResult;
    },
  });
  return { expression, outerRequests, innerRequests, returned, childResult };
}

function acceptsReview({ runtime, manifest, outputEvidence, baseline, workflowKey = 'spec-review', agent = 'arc-spec-reviewer', output = 'spec-review.md' }) {
  const child = runtime?.workflow?.value;
  const outputReference = child?.outputReference;
  const expectedHandoffSuffix = typeof child?.runId === 'string' ? `/handoffs/${child.runId}.json` : undefined;
  const handoffPaths = Array.isArray(child?.artifactPaths) && expectedHandoffSuffix
    ? child.artifactPaths.filter((artifactPath) => typeof artifactPath === 'string' && artifactPath.endsWith(expectedHandoffSuffix))
    : [];
  return runtime?.state === 'complete'
    && runtime?.success === true
    && runtime?.error == null
    && child?.key === workflowKey
    && child?.agent === agent
    && child?.ok === true
    && child?.error == null
    && child?.stopped !== true
    && child?.detached !== true
    && child?.interrupted !== true
    && child?.terminalOutcome == null
    && typeof child?.runId === 'string'
    && child.runId.length > 0
    && typeof child?.output === 'string'
    && child.output.trim().length > 0
    && typeof outputReference === 'string'
    && outputReference.endsWith(`/${output}`)
    && Array.isArray(child?.artifactPaths)
    && child.artifactPaths.includes(outputReference)
    && outputEvidence instanceof Map
    && typeof outputEvidence.get(outputReference) === 'string'
    && outputEvidence.get(outputReference) === child.output
    && outputEvidence.get(outputReference).trim().length > 0
    && handoffPaths.length === 1
    && manifest?.version === 1
    && Array.isArray(manifest.groups)
    && manifest.groups.length > 0
    && manifest.groups.every((group) => group?.baseCommit === baseline?.head
      && Array.isArray(group.children)
      && group.children.length === 1
      && group.children.every((manifestChild) => manifestChild?.workflowKey === workflowKey
        && manifestChild?.agent === agent
        && manifestChild?.status === 'completed'
        && manifestChild?.patch?.changed === false
        && manifestChild?.patch?.filesChanged === 0
        && manifestChild?.patch?.insertions === 0
        && manifestChild?.patch?.deletions === 0
        && manifestChild?.patch?.error == null));
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

function serializeReviewDescription(ledger) {
  const rows = ledger.entries.map((entry) => `| ${entry.sequence} | ${entry.reviewer} | ${entry.run_id} | ${entry.base} | ${entry.head} | ${entry.elapsed_ms} | ${entry.disposition} |`);
  const grants = ledger.additionalAuthorizations.map((grant) => `Owner-authorized additional reviewer runs: ${grant}`);
  return [
    `${ledger.canonical}${LEDGER_SENTINEL}`,
    '## Review Ledger',
    `Canonical description SHA-256: \`${sha256(ledger.canonical)}\``,
    'Authorized reviewer runs: 4',
    ...grants,
    '| sequence | reviewer | run_id | base | head | elapsed_ms | disposition |',
    '|---:|---|---|---|---|---:|---|',
    ...rows,
    '',
  ].join('\n');
}

function loadReviewDescription(description) {
  const canonical = canonicalBytes(description);
  const ledgerText = description.slice(description.lastIndexOf(LEDGER_SENTINEL) + LEDGER_SENTINEL.length);
  const hashMatch = ledgerText.match(/Canonical description SHA-256: `([a-f0-9]{64})`/);
  assert.ok(hashMatch, 'missing canonical description hash');
  assert.equal(hashMatch[1], sha256(canonical), 'canonical description hash mismatch');
  assert.match(ledgerText, /Authorized reviewer runs: 4/);
  const additionalAuthorizations = [...ledgerText.matchAll(/^Owner-authorized additional reviewer runs: (\S+)$/gm)].map((match) => Number(match[1]));
  const entries = [...ledgerText.matchAll(/^\|\s*(\d+)\s*\|\s*(spec|code)\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|$/gm)].map((match) => ({
    sequence: Number(match[1]),
    reviewer: match[2],
    run_id: match[3],
    base: match[4],
    head: match[5],
    elapsed_ms: Number(match[6]),
    disposition: match[7],
  }));
  const ledger = { canonical, entries, additionalAuthorizations };
  authorizedRuns(ledger);
  return ledger;
}

function appendNativeRun(description, reviewer, runId) {
  const ledger = loadReviewDescription(description);
  recordNativeRun(ledger, reviewer, runId);
  return serializeReviewDescription(ledger);
}

function appendOwnerAuthorization(description, grant) {
  const ledger = loadReviewDescription(description);
  ledger.additionalAuthorizations.push(grant);
  authorizedRuns(ledger);
  return serializeReviewDescription(ledger);
}

function artifactHashMatches(artifact, expectedHash) {
  assert.equal(statSync(artifact).mode & 0o777, 0o444, 'review artifact mode must remain 0444');
  assert.equal(sha256(readFileSync(artifact)), expectedHash, 'review artifact hash changed');
  return true;
}

function outsideDeltaFindingMayBlock({ severity, latent, exposedByNewestDelta }) {
  return severity === 'critical' && latent === true && exposedByNewestDelta === true;
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

test('mandatory workflow examples execute as one isolated foreground reviewer inside an async HEAD workflow', async () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    const execution = await executeWorkflowExample(source, review.workflowKey);

    assert.equal(execution.outerRequests.length, 1);
    assert.deepEqual(execution.outerRequests[0], {
      workflowScript: execution.outerRequests[0].workflowScript,
      context: 'fresh',
      async: true,
      globalConcurrencyLimit: 1,
      baseRef: 'HEAD',
    });
    assert.equal(execution.innerRequests.length, 1, 'mandatory workflow must launch exactly one reviewer');
    assert.deepEqual(execution.innerRequests[0], {
      key: review.workflowKey,
      request: {
        agent: review.agent,
        task: '<filled immutable review prompt>',
        worktree: true,
        async: false,
        output: review.output,
      },
    });
    assert.equal(execution.returned, execution.childResult, 'outer workflow must return the awaited foreground child result');
    assert.match(execution.expression, /\n  workflowScript: `return await runs\.run/);
    assert.match(execution.expression, /\n  baseRef: "HEAD"/);
    assert.doesNotMatch(execution.expression, /\["(?:workflowScript|baseRef)"\]/);
  }
});

test('review acceptance combines successful runtime output with exact no-change handoff evidence', () => {
  const baseline = { branch: 'main', head: 'a'.repeat(40), porcelainV2: '' };
  const outputReference = '/native/outputs/spec-review.md';
  const handoffPath = '/native/handoffs/spec-run.json';
  const validRuntime = {
    state: 'complete',
    success: true,
    error: null,
    workflow: {
      value: {
        key: 'spec-review',
        agent: 'arc-spec-reviewer',
        ok: true,
        runId: 'spec-run',
        output: '## Result: COMPLIANT',
        outputReference,
        artifactPaths: [outputReference, '/native/sessions/spec-run.jsonl', handoffPath],
      },
    },
  };
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
  const valid = {
    runtime: validRuntime,
    manifest: validNoChangeManifest,
    outputEvidence: new Map([[outputReference, '## Result: COMPLIANT']]),
    baseline,
  };

  assert.equal(acceptsReview(valid), true);
  for (const runtime of [
    undefined,
    { ...validRuntime, state: 'failed' },
    { ...validRuntime, success: false },
    { ...validRuntime, error: 'workflow failed' },
    { ...validRuntime, workflow: undefined },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, key: 'wrong-review' } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, ok: false } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, error: 'child failed' } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, stopped: true } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, detached: true } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, interrupted: true } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, terminalOutcome: { state: 'partial', reason: 'timeout' } } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, output: '' } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, output: '   ' } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, output: 42 } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, outputReference: undefined } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, outputReference: '/native/outputs/wrong.md' } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, artifactPaths: ['/native/sessions/spec-run.jsonl', handoffPath] } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, artifactPaths: [outputReference] } } },
    { ...validRuntime, workflow: { value: { ...validRuntime.workflow.value, artifactPaths: 'malformed' } } },
  ]) {
    assert.equal(acceptsReview({ ...valid, runtime }), false);
  }
  assert.equal(acceptsReview({ ...valid, outputEvidence: new Map() }), false);
  assert.equal(acceptsReview({ ...valid, outputEvidence: {} }), false);
  assert.equal(acceptsReview({ ...valid, outputEvidence: new Map([[outputReference, '']]) }), false);
  assert.equal(acceptsReview({ ...valid, outputEvidence: new Map([[outputReference, 'malformed different bytes']]) }), false);

  for (const manifest of [
    undefined,
    'malformed',
    {},
    { ...validNoChangeManifest, groups: undefined },
    { ...validNoChangeManifest, groups: [] },
    { ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], baseCommit: 'b'.repeat(40) }] },
    { ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [] }] },
    { ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [{ ...validNoChangeManifest.groups[0].children[0], workflowKey: 'wrong-review' }] }] },
    { ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [{ ...validNoChangeManifest.groups[0].children[0], agent: 'arc-code-reviewer' }] }] },
    { ...validNoChangeManifest, groups: [{ ...validNoChangeManifest.groups[0], children: [{ ...validNoChangeManifest.groups[0].children[0], status: 'failed' }] }] },
  ]) {
    assert.equal(acceptsReview({ ...valid, manifest }), false);
  }

  for (const patch of [
    { changed: true, filesChanged: 0, insertions: 0, deletions: 0, error: null },
    { changed: false, filesChanged: 1, insertions: 0, deletions: 0, error: null },
    { changed: false, filesChanged: 0, insertions: 1, deletions: 0, error: null },
    { changed: false, filesChanged: 0, insertions: 0, deletions: 1, error: null },
    { changed: false, filesChanged: 0, insertions: 0, deletions: 0, error: 'capture failed' },
  ]) {
    const changedPatchManifest = structuredClone(validNoChangeManifest);
    changedPatchManifest.groups[0].children[0].patch = patch;
    assert.equal(acceptsReview({ ...valid, manifest: changedPatchManifest }), false);
  }
});

test('documented acceptance predicates combine runtime output and handoff evidence', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /RUNTIME_RESULT/);
    assert.match(source, /CHILD_RESULT/);
    assert.match(source, /\.state == "complete"/);
    assert.match(source, /\.success == true/);
    assert.match(source, /\.key == \$key/);
    assert.match(source, /\.terminalOutcome == null/);
    assert.match(source, /\.output \| type == "string"/);
    assert.match(source, /\.outputReference \| type == "string"/);
    assert.match(source, /test -s "\$OUTPUT_REFERENCE"/);
    assert.match(source, /RUNTIME_OUTPUT_SHA256/);
    assert.match(source, /SAVED_OUTPUT_SHA256/);
    assert.match(source, /test "\$SAVED_OUTPUT_SHA256" = "\$RUNTIME_OUTPUT_SHA256"/);
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
    assert.match(source, /runtime and output evidence.*handoff evidence|handoff evidence.*runtime and output evidence/i);
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

test('versioned issue description persists combined reviewer runs and bounded owner authorization across sessions', () => {
  const canonical = '# Canonical task\n\nExact task bytes.';
  const canonicalHash = sha256(canonical);
  let description = serializeReviewDescription({ canonical, entries: [], additionalAuthorizations: [] });

  assert.equal(canonicalBytes(description), canonical);
  assert.equal(sha256(canonicalBytes(description)), canonicalHash);

  for (const [reviewer, runId] of [
    ['spec', 'run-1'],
    ['code', 'run-2'],
    ['spec', 'run-3'],
    ['code', 'run-4'],
  ]) {
    description = appendNativeRun(description, reviewer, runId);
    const reloadedByNextSession = loadReviewDescription(description);
    assert.equal(launchedRuns(reloadedByNextSession.entries).length, Number(runId.at(-1)));
    assert.equal(sha256(reloadedByNextSession.canonical), canonicalHash);
  }

  const fourthSession = loadReviewDescription(description);
  assert.deepEqual(fourthSession.entries.map((entry) => entry.reviewer), ['spec', 'code', 'spec', 'code']);
  assert.equal(canLaunchReviewer(fourthSession), false);
  assert.throws(() => appendNativeRun(description, 'spec', 'run-5'), /budget exhausted/);
  assert.equal(appendNativeRun(description, 'spec', undefined), description, 'a run without native identity must not persist a row');

  description = appendOwnerAuthorization(description, 1);
  const ownerAuthorizedSession = loadReviewDescription(description);
  assert.deepEqual(ownerAuthorizedSession.additionalAuthorizations, [1]);
  assert.equal(authorizedRuns(ownerAuthorizedSession), 5);
  assert.equal(canLaunchReviewer(ownerAuthorizedSession), true);

  description = appendNativeRun(description, 'spec', 'run-5');
  const fifthSession = loadReviewDescription(description);
  assert.equal(launchedRuns(fifthSession.entries).length, 5);
  assert.equal(canLaunchReviewer(fifthSession), false);
  assert.match(description, /^Owner-authorized additional reviewer runs: 1$/m);
  assert.throws(() => appendOwnerAuthorization(description, Number.POSITIVE_INFINITY), /finite positive/);

  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /persist(?:ed|ing).*issue description.*re-read|re-read.*persist(?:ed|ing).*issue description/is);
    assert.match(source, /never rely on an in-memory count/i);
    assert.match(source, /owner authorization.*persist.*re-read|persist.*owner authorization.*re-read/is);
  }
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

test('re-review permits outside-delta expansion only for a critical latent issue exposed by the newest delta', () => {
  const priorFindings = '- Critical: validation absent';
  const latestFixDelta = 'diff --git a/a.js b/a.js\n+validate();\n';
  const input = reviewInput({ priorFindings, latestFixDelta, cycle: 2 });

  assert.equal(input.prior_findings, priorFindings);
  assert.equal(input.latest_fix_delta, latestFixDelta);
  assert.equal(input.cycle, 2);
  assert.equal(outsideDeltaFindingMayBlock({ severity: 'important', latent: true, exposedByNewestDelta: true }), false);
  assert.equal(outsideDeltaFindingMayBlock({ severity: 'minor', latent: true, exposedByNewestDelta: true }), false);
  assert.equal(outsideDeltaFindingMayBlock({ severity: 'critical', latent: false, exposedByNewestDelta: true }), false);
  assert.equal(outsideDeltaFindingMayBlock({ severity: 'critical', latent: true, exposedByNewestDelta: false }), false);
  assert.equal(outsideDeltaFindingMayBlock({ severity: 'critical', latent: true, exposedByNewestDelta: true }), true);

  for (const review of Object.values(REVIEWERS)) {
    const prompt = read(review.promptPath);
    assert.match(prompt, /\{PRIOR_FINDINGS\}/);
    assert.match(prompt, /\{LATEST_FIX_DELTA\}/);
    assert.match(prompt, /exact newest fix delta/i);
    assert.match(prompt, /newly block only if all three conditions hold/i);
    assert.match(prompt, /critical.*latent.*exposed by the newest delta/is);
    assert.match(prompt, /unrelated noncritical.*must not expand|must not expand.*unrelated noncritical/is);
  }
});

test('documented Git diff materialization is external, mode-0444, hash-addressed, and rejects changed bytes', () => {
  for (const review of Object.values(REVIEWERS)) {
    const source = read(review.skillPath);
    assert.match(source, /REVIEW_INPUT_DIR=\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/arc-review-input\.XXXXXX"\)/);
    assert.match(source, /git diff --binary --find-renames=0 "\$BASE_SHA\.\.\$HEAD_SHA" > "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /chmod 0444 "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /DIFF_SHA256=\$\(sha256sum "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /test "\$\(sha256sum "\$REVIEW_INPUT_DIR\/diff\.patch"/);
    assert.match(source, /outside the repository/i);
    assert.match(source, /path, SHA-256, base, and head/i);
    assert.match(source, /mode 0444 alone does not prove.*unchanged|unchanged.*mode 0444 alone does not prove/is);
    assert.match(source, /hash mismatch.*blocks acceptance/i);
  }

  const repository = initializeRepository();
  const externalRoot = mkdtempSync(path.join(tmpdir(), 'arc-review-artifact-test-'));
  try {
    const baseSha = git(repository, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repository, 'tracked.txt'), 'reviewed implementation\n');
    git(repository, 'add', 'tracked.txt');
    git(repository, 'commit', '-qm', 'implementation');
    const headSha = git(repository, 'rev-parse', 'HEAD');
    const artifact = path.join(externalRoot, 'diff.patch');
    const diffBytes = execFileSync('git', ['diff', '--binary', '--find-renames=0', `${baseSha}..${headSha}`], { cwd: repository });
    writeFileSync(artifact, diffBytes);
    chmodSync(artifact, 0o444);
    const expectedHash = sha256(readFileSync(artifact));

    assert.equal(path.relative(repository, artifact).startsWith(`..${path.sep}`), true, 'artifact must remain outside the repository');
    assert.match(read(artifact), /-base\n\+reviewed implementation/);
    assert.equal(artifactHashMatches(artifact, expectedHash), true);

    chmodSync(artifact, 0o644);
    writeFileSync(artifact, Buffer.concat([readFileSync(artifact), Buffer.from('\nmutated after review\n')]));
    chmodSync(artifact, 0o444);
    assert.equal(statSync(artifact).mode & 0o777, 0o444);
    assert.throws(() => artifactHashMatches(artifact, expectedHash), /hash changed/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
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
