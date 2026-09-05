import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fsPromises, { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ARC_REVIEWER_REPORT_JSON_SCHEMA } from '../extensions/arc/reports.ts';
import { createArcStandaloneReviewAdapter, materializeArcReviewGuard } from '../extensions/arc/review-standalone.ts';

const guardSource = fileURLToPath(new URL('../extensions/arc/review-child.ts', import.meta.url));
const fakePiSource = fileURLToPath(new URL('./fixtures/review/fake-pi.mjs', import.meta.url));
let serial = 0;

async function waitForPath(file, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await access(file).then(() => true, () => false))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createObserver(overrides = {}) {
  const calls = [];
  return {
    calls,
    async persistBeforeDispatch(identity) { calls.push({ kind: 'before-dispatch', identity }); return overrides.before?.(identity); },
    async persistDispatchReceipt(receipt) { calls.push({ kind: 'dispatch-receipt', receipt }); return overrides.receipt?.(receipt); },
    async persistObservedTermination(evidence) { calls.push({ kind: 'termination', evidence }); return overrides.termination?.(evidence); },
    progress(message) { calls.push({ kind: 'progress', message }); },
  };
}

function interceptSameSizeChange(target, changeBytes) {
  const realOpen = fsPromises.open;
  let injected = false;
  fsPromises.open = async function(file, ...args) {
    const handle = await realOpen(file, ...args);
    if (file !== target) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!injected && result.bytesRead > 0) {
        injected = true;
        const before = await lstat(target, { bigint: true });
        const oldBytes = await readFile(target);
        const newBytes = changeBytes(oldBytes);
        assert.equal(newBytes.length, oldBytes.length);
        await chmod(target, 0o600);
        await writeFile(target, newBytes, { flag: 'r+' });
        await chmod(target, Number(before.mode & 0o777n));
        await fsPromises.utimes(target, new Date(Number(before.atimeMs)), new Date(Number(before.mtimeMs) + 1000));
      }
      return result;
    };
    return handle;
  };
  syncBuiltinESMExports();
  return { get injected() { return injected; }, restore() { fsPromises.open = realOpen; syncBuiltinESMExports(); } };
}

async function scenario(t, mode = 'success', additions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-review-standalone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'checkout');
  const stateDir = path.join(root, 'state');
  const inputParent = path.join(stateDir, 'input');
  const inputRoot = path.join(inputParent, 'review-input-fixture');
  const sourceRoot = path.join(inputRoot, 'source');
  const materialsRoot = path.join(inputRoot, 'materials');
  const instructionsRoot = path.join(materialsRoot, 'instructions');
  const runtimeRoot = path.join(stateDir, 'runtime');
  const reportRoot = path.join(stateDir, 'reports');
  const evidenceRoot = path.join(stateDir, 'evidence');
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(instructionsRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    mkdir(reportRoot, { recursive: true, mode: 0o700 }),
    mkdir(evidenceRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(stateDir, 0o700), chmod(inputParent, 0o700)]);
  const materialFiles = {
    manifestPath: path.join(inputRoot, 'manifest.json'),
    diffPath: path.join(materialsRoot, 'diff.patch'),
    baselinePath: path.join(evidenceRoot, 'baseline.json'),
    inputDescriptorPath: path.join(evidenceRoot, 'prepared-input.json'),
  };
  const reviewerMaterials = [
    materialFiles.diffPath,
    path.join(materialsRoot, 'task.md'),
    path.join(materialsRoot, 'design.md'),
    path.join(materialsRoot, 'review.md'),
    path.join(instructionsRoot, '0001.md'),
  ];
  const manifest = {
    version: 1,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    range: `${'1'.repeat(40)}..${'2'.repeat(40)}`,
    ignoredPolicy: 'excluded',
    source: [{ path: 'a.ts', gitMode: '100644', physicalMode: '0400', size: 20, sha256: '0'.repeat(64) }],
    changes: [],
    materials: [
      'materials/design.md',
      'materials/diff.patch',
      'materials/instructions/0001.md',
      'materials/review.md',
      'materials/task.md',
    ].map((entry) => ({ path: entry, physicalMode: '0400', size: 2, sha256: '0'.repeat(64) })),
  };
  await Promise.all([
    writeFile(path.join(sourceRoot, 'a.ts'), 'export const a = 1;\n'),
    writeFile(materialFiles.manifestPath, JSON.stringify(manifest)),
    ...reviewerMaterials.map((file) => writeFile(file, '{}')),
    writeFile(materialFiles.baselinePath, '{}', { mode: 0o400 }),
    writeFile(materialFiles.inputDescriptorPath, '{}', { mode: 0o400 }),
  ]);
  const attemptId = `attempt-${++serial}`;
  const reviewInputDigest = 'a'.repeat(64);
  const reportPath = path.join(reportRoot, 'review-report.json');
  const acknowledgementPath = path.join(reportRoot, 'guard-ack.json');
  const guardConfig = {
    version: 1,
    attemptId,
    inputRoots: [inputRoot],
    reportRoot,
    reportPath,
    reportSchemaPath: path.join(runtimeRoot, 'immutable-reviewer-schema.json'),
    acknowledgementPath,
    expectedReviewInputDigest: reviewInputDigest,
    allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
  };
  const materialized = await materializeArcReviewGuard({ config: guardConfig, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA });
  const fakePi = path.join(root, 'fake-pi');
  await copyFile(fakePiSource, fakePi);
  await chmod(fakePi, 0o700);
  const recordPath = path.join(root, 'record.json');
  const request = {
    repositoryRoot,
    taskKey: 'task',
    scopeKey: 'scope',
    role: 'code',
    adapterSelection: 'standalone',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    reviewedRefs: [],
    taskContext: 'task context',
    designContext: 'design context',
    reviewContext: 'review context',
  };
  const attempt = {
    ...materialFiles,
    stateDir,
    inputRoot,
    runtimeRoot,
    reportRoot,
    guardExtensionPath: materialized.extensionPath,
    guardConfigPath: materialized.configPath,
    reportSchemaPath: materialized.reportSchemaPath,
    guardAcknowledgementPath: materialized.acknowledgementPath,
    reviewInputDigest,
    baselineDigest: 'b'.repeat(64),
    baselineArtifactDigest: 'c'.repeat(64),
    inputDescriptorArtifactDigest: 'd'.repeat(64),
    attemptId,
    repositoryKey: 'repository',
    request,
    reservedAt: new Date().toISOString(),
    attemptNumber: 1,
    effectiveAttemptBudgetMs: 10_050,
    executionTimeoutMs: additions.executionTimeoutMs ?? 1000,
    dispatchDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
  };
  const absoluteReadPaths = [sourceRoot, materialFiles.manifestPath, ...reviewerMaterials];
  const processEnv = {
    ...process.env,
    FAKE_PI_MODE: mode,
    FAKE_PI_RECORD: recordPath,
    FAKE_PI_ACK: acknowledgementPath,
    FAKE_PI_REPORT: reportPath,
    FAKE_PI_GUARD: materialized.extensionPath,
    FAKE_PI_SCHEMA: materialized.reportSchemaPath,
    FAKE_PI_ATTEMPT: attemptId,
    FAKE_PI_DIGEST: reviewInputDigest,
    FAKE_PI_GUARD_DIGEST: materialized.sourceDigest,
    FAKE_PI_SCHEMA_DIGEST: materialized.reportSchemaDigest,
    FAKE_PI_ABSOLUTE_READ_PATHS: absoluteReadPaths.join(path.delimiter),
  };
  let uuid = 0;
  const options = {
    piCommand: additions.piCommand ?? fakePi,
    selectedModel: 'fixture/model',
    buildPrompt: (value) => ({
      systemPrompt: `Review source at ${sourceRoot}; public materials at ${value.manifestPath} and ${reviewerMaterials.join(', ')}.`,
      task: `Review ${sourceRoot} using ${value.manifestPath} and all listed public materials.`,
    }),
    trustedProviderExtensions: [],
    processEnv,
    randomUUID: () => `${attemptId}-uuid-${++uuid}`,
  };
  return { root, repositoryRoot, stateDir, inputRoot, sourceRoot, runtimeRoot, reportRoot, evidenceRoot, reportPath, acknowledgementPath, recordPath, request, attempt, options, materialized, reviewerMaterials, absoluteReadPaths };
}

test('success uses exact isolated argv/cwd/env, receipt ordering, fixed acknowledgement, and validated report', async (t) => {
  const value = await scenario(t);
  const adapter = createArcStandaloneReviewAdapter(value.options);
  assert.deepEqual(await adapter.preflight({ request: value.request, preparation: value.attempt }), { ok: true });
  const observer = createObserver();
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observer);
  assert.equal(execution.lifecycle, 'succeeded');
  assert.equal(execution.termination.status, 'observed');
  assert.equal(execution.termination.source, 'standalone_child_close');
  assert.equal(execution.structuredReport.reviewInputDigest, value.attempt.reviewInputDigest);
  assert.deepEqual(execution.guardAcknowledgements, [`pi-arc.review-child:v1:${value.attempt.attemptId}`]);
  assert.deepEqual(observer.calls.slice(0, 2).map((entry) => entry.kind), ['before-dispatch', 'dispatch-receipt']);
  assert.ok(observer.calls.some((entry) => entry.kind === 'termination'));
  const record = JSON.parse(await readFile(value.recordPath, 'utf8'));
  assert.equal(record.cwd, await realpath(value.attempt.runtimeRoot));
  const expected = [
    '-p', '--no-session', '--mode', 'json',
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--no-builtin-tools', '--tools', 'read,grep,find,ls,arc_review_report',
    '--extension', value.attempt.guardExtensionPath,
    '--model', value.options.selectedModel,
    '--system-prompt', value.options.buildPrompt(value.attempt).systemPrompt,
    '--', value.options.buildPrompt(value.attempt).task,
  ];
  assert.deepEqual(record.argv, expected);
  assert.equal(record.argv.at(-2), '--');
  assert.equal(record.argv.at(-1), value.options.buildPrompt(value.attempt).task);
  assert.ok(record.argv.includes('--no-extensions'));
  assert.ok(record.absoluteReadPaths.every((entry) => path.isAbsolute(entry)));
  for (const destination of Object.values(record.env)) {
    assert.equal(path.isAbsolute(destination), true);
    assert.equal(destination.startsWith(`${value.runtimeRoot}${path.sep}`), true);
    assert.equal(destination.startsWith(`${value.inputRoot}${path.sep}`), false);
    assert.equal(destination.startsWith(`${value.repositoryRoot}${path.sep}`), false);
    assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  }
});

test('preexisting fixed acknowledgement or report fails before dispatch and preserves bytes', async (t) => {
  await t.test('matching stale pair', async (t) => {
    const value = await scenario(t, 'no-artifacts');
    const acknowledgement = Buffer.from(JSON.stringify({
      version: 1,
      attemptId: value.attempt.attemptId,
      id: `pi-arc.review-child:v1:${value.attempt.attemptId}`,
      guardSourceDigest: value.materialized.sourceDigest,
      reportSchemaDigest: value.materialized.reportSchemaDigest,
      loadedAt: '2000-01-01T00:00:00.000Z',
    }));
    const report = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      reviewInputDigest: value.attempt.reviewInputDigest,
      verdict: 'PASS',
      summary: 'Stale but otherwise matching fixture report.',
      findings: [],
      coverage: { reviewedPaths: [], reviewedRequirements: [] },
      limitations: [],
    }));
    await writeFile(value.acknowledgementPath, acknowledgement, { mode: 0o600, flag: 'wx' });
    await writeFile(value.reportPath, report, { mode: 0o600, flag: 'wx' });
    const observer = createObserver();
    await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /preexisting|fresh|absent/i);
    assert.deepEqual(await readFile(value.acknowledgementPath), acknowledgement);
    assert.deepEqual(await readFile(value.reportPath), report);
    assert.equal(observer.calls.some((entry) => entry.kind === 'before-dispatch'), false);
    assert.equal(await access(value.recordPath).then(() => true, () => false), false);
  });
  for (const artifact of ['acknowledgement', 'report']) {
    await t.test(artifact, async (t) => {
      const value = await scenario(t, 'no-artifacts');
      const target = artifact === 'acknowledgement' ? value.acknowledgementPath : value.reportPath;
      const bytes = Buffer.from(`preexisting-${artifact}`);
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      const observer = createObserver();
      await assert.rejects(
        () => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer),
        /preexisting|fresh|absent/i,
      );
      assert.deepEqual(await readFile(target), bytes);
      assert.equal(observer.calls.some((entry) => entry.kind === 'before-dispatch'), false);
      assert.equal(await access(value.recordPath).then(() => true, () => false), false);
    });
  }
});

test('trusted provider extensions retain exact ordering after the guard', async (t) => {
  const value = await scenario(t);
  const trustedA = path.join(value.root, 'trusted-a.ts');
  const trustedB = path.join(value.root, 'trusted-b.ts');
  await writeFile(trustedA, 'export default () => {};');
  await writeFile(trustedB, 'export default () => {};');
  value.options.trustedProviderExtensions = [trustedA, trustedB];
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
  assert.equal(execution.lifecycle, 'succeeded');
  const argv = JSON.parse(await readFile(value.recordPath, 'utf8')).argv;
  const extensionArgs = argv.flatMap((entry, index) => entry === '--extension' ? [argv[index + 1]] : []);
  assert.deepEqual(extensionArgs, [value.attempt.guardExtensionPath, trustedA, trustedB]);
});

test('nonzero, signal, timeout, malformed/oversize protocol, bad reports, ack loss, and mutation evidence never succeed', async (t) => {
  const cases = [
    ['nonzero', 'provider_lost', {}],
    ['signal', 'signaled', {}],
    ['timeout', 'timed_out', { executionTimeoutMs: 40 }],
    ['malformed', 'malformed_report', {}],
    ['oversize', 'malformed_report', {}],
    ['missing-ack', 'guard_failed', {}],
    ['mismatched-ack', 'guard_failed', {}],
    ['missing-report', 'malformed_report', {}],
    ['malformed-report', 'malformed_report', {}],
    ['duplicate', 'malformed_report', {}],
    ['wrong-digest', 'malformed_report', {}],
    ['mutation-request', 'guard_failed', {}],
  ];
  for (const [mode, lifecycle, additions] of cases) {
    await t.test(mode, async (t) => {
      const value = await scenario(t, mode, additions);
      const observer = createObserver();
      const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
      assert.equal(execution.lifecycle, lifecycle);
      assert.notEqual(execution.lifecycle, 'succeeded');
      assert.equal(execution.structuredReport, undefined);
      assert.ok(observer.calls.some((entry) => entry.kind === 'termination'), `${mode} must run observed-close persistence`);
    });
  }
});

test('all bounded stdout remains strict JSON lines after diagnostic retention fills', async (t) => {
  for (const mode of ['malformed-tail-lines', 'malformed-tail-bytes', 'blank-tail-lines']) {
    await t.test(mode, async (t) => {
      const value = await scenario(t, mode);
      const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
      assert.equal(execution.lifecycle, 'malformed_report');
      assert.equal(execution.termination.status, 'observed');
      assert.ok(execution.boundedDiagnostics.length <= 128);
      assert.match(execution.boundedDiagnostics[0], /stdout line/i);
    });
  }
  await t.test('CRLF with one trailing terminator', async (t) => {
    const value = await scenario(t, 'valid-crlf');
    const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
    assert.equal(execution.lifecycle, 'succeeded');
  });
});

test('missing executable has no dispatch receipt and returns not-started spawn failure', async (t) => {
  const value = await scenario(t, 'success', { piCommand: path.join(tmpdir(), `absent-pi-${process.pid}-${++serial}`) });
  const observer = createObserver();
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
  assert.equal(execution.lifecycle, 'spawn_failed');
  assert.equal(execution.termination.status, 'not_applicable');
  assert.equal(execution.termination.source, 'not_started');
  assert.equal(observer.calls.filter((entry) => entry.kind === 'dispatch-receipt').length, 0);
});

test('receipt is a real awaited spawn barrier; delay prevents early settlement and rejection terminates exact child', async (t) => {
  await t.test('delayed', async (t) => {
    const value = await scenario(t);
    let released = false;
    const observer = createObserver({ receipt: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); released = true; } });
    const started = Date.now();
    const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
    assert.equal(execution.lifecycle, 'succeeded');
    assert.equal(released, true);
    assert.ok(Date.now() - started >= 70);
  });
  await t.test('rejected', async (t) => {
    const value = await scenario(t, 'timeout', { executionTimeoutMs: 1000 });
    const observer = createObserver({ receipt: async () => { throw new Error('receipt persistence rejected'); } });
    const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
    assert.equal(execution.lifecycle, 'guard_failed');
    assert.equal(execution.termination.status, 'observed');
    assert.match(execution.boundedDiagnostics.join('\n'), /receipt persistence rejected/i);
    assert.ok(observer.calls.some((entry) => entry.kind === 'termination'));
  });
});

test('a never-resolving receipt observer is bounded and cannot hide exact child close', async (t) => {
  const value = await scenario(t, 'success', { executionTimeoutMs: 20 });
  const observer = createObserver({ receipt: () => new Promise(() => {}) });
  const started = Date.now();
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
  assert.equal(execution.lifecycle, 'guard_failed');
  assert.equal(execution.termination.status, 'observed');
  assert.match(execution.boundedDiagnostics.join('\n'), /observer|settle|deadline/i);
  assert.ok(Date.now() - started < 11_000);
  assert.ok(observer.calls.some((entry) => entry.kind === 'termination'));
});

test('external cancellation while receipt persistence is pending accounts for child and never succeeds', async (t) => {
  const value = await scenario(t, 'timeout', { executionTimeoutMs: 2000 });
  const controller = new AbortController();
  const observer = createObserver({
    receipt: () => new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('receipt cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    }),
  });
  const executionPromise = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, controller.signal, observer);
  await waitForPath(value.recordPath);
  controller.abort(new Error('test cancellation'));
  const execution = await executionPromise;
  assert.notEqual(execution.lifecycle, 'succeeded');
  assert.equal(execution.lifecycle, 'guard_failed');
  assert.equal(execution.termination.status, 'observed');
  assert.ok(observer.calls.some((entry) => entry.kind === 'termination'));
});

test('observer persistence failures cannot become success', async (t) => {
  await t.test('before dispatch', async (t) => {
    const value = await scenario(t);
    const observer = createObserver({ before: async () => { throw new Error('reservation write failed'); } });
    await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /reservation write failed/);
    assert.equal(await access(value.recordPath).then(() => true, () => false), false);
  });
  await t.test('termination evidence', async (t) => {
    const value = await scenario(t);
    const observer = createObserver({ termination: async () => { throw new Error('termination write failed'); } });
    const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
    assert.equal(execution.lifecycle, 'guard_failed');
    assert.equal(execution.structuredReport, undefined);
    assert.match(execution.boundedDiagnostics.join('\n'), /termination write failed/);
  });
});

test('stop is identity-bound, idempotent, and does not act on a mismatched process instance', async (t) => {
  const value = await scenario(t, 'timeout', { executionTimeoutMs: 2000 });
  const adapter = createArcStandaloneReviewAdapter(value.options);
  let identity;
  const observer = createObserver({ before: async (next) => { identity = next; } });
  const executionPromise = adapter.execute(value.attempt, new AbortController().signal, observer);
  await waitForPath(value.recordPath);
  await adapter.stop(value.attempt, { ...identity, runnerProcessInstanceId: 'wrong' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  let settled = false;
  executionPromise.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  await adapter.stop(value.attempt, identity);
  await adapter.stop(value.attempt, identity);
  const execution = await executionPromise;
  assert.equal(execution.lifecycle, 'cancelled');
  assert.equal(execution.termination.status, 'observed');
});

test('ambiguous pre-spawn termination remains unknown and retains identity ownership', { timeout: 15_000 }, async (t) => {
  const value = await scenario(t, 'success', { executionTimeoutMs: 5 });
  const realSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => child.emit('error', new Error('creation observation lost')));
    return child;
  };
  syncBuiltinESMExports();
  const adapter = createArcStandaloneReviewAdapter(value.options);
  let identity;
  try {
    const observer = createObserver({ before: (next) => { identity = next; } });
    const execution = await adapter.execute(value.attempt, new AbortController().signal, observer);
    assert.equal(execution.termination.status, 'unknown');
    assert.equal(execution.termination.source, 'standalone_child_close');
    await assert.rejects(() => adapter.execute(value.attempt, new AbortController().signal, createObserver()), /already owns/i);
    await adapter.stop(value.attempt, { ...identity, runnerProcessInstanceId: 'wrong' });
    await adapter.stop(value.attempt, identity);
    await assert.rejects(() => adapter.execute(value.attempt, new AbortController().signal, createObserver()), /already owns/i);
  } finally {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  }
});

test('prompt requires canonical source and every public material but excludes private evidence metadata', async (t) => {
  const omissions = ['source', 'task', 'design', 'review', 'instruction'];
  for (const omitted of omissions) {
    await t.test(omitted, async (t) => {
      const value = await scenario(t);
      const paths = {
        source: value.sourceRoot,
        task: path.join(value.inputRoot, 'materials/task.md'),
        design: path.join(value.inputRoot, 'materials/design.md'),
        review: path.join(value.inputRoot, 'materials/review.md'),
        instruction: path.join(value.inputRoot, 'materials/instructions/0001.md'),
      };
      value.options.buildPrompt = () => ({
        systemPrompt: [value.attempt.manifestPath, ...value.reviewerMaterials, value.sourceRoot].filter((entry) => entry !== paths[omitted]).join('\n'),
        task: 'Review only the canonical listed inputs.',
      });
      const observer = createObserver();
      await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /prompt omitted canonical review path/i);
      assert.equal(observer.calls.some((entry) => entry.kind === 'before-dispatch'), false);
    });
  }
  for (const [label, changedPath] of [
    ['source-root child', (value) => path.join(value.sourceRoot, 'a.ts')],
    ['source-root filename suffix', (value) => `${value.sourceRoot}.bak`],
    ['material filename suffix', (value) => `${path.join(value.inputRoot, 'materials/task.md')}.bak`],
  ]) {
    await t.test(label, async (t) => {
      const value = await scenario(t);
      const replacedPath = label.startsWith('material') ? path.join(value.inputRoot, 'materials/task.md') : value.sourceRoot;
      value.options.buildPrompt = () => ({
        systemPrompt: [value.attempt.manifestPath, ...value.reviewerMaterials.filter((entry) => entry !== replacedPath), changedPath(value)].join('\n'),
        task: 'Review the listed files.',
      });
      await assert.rejects(
        () => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver()),
        /prompt omitted canonical review path/i,
      );
    });
  }
  const value = await scenario(t);
  const prompt = value.options.buildPrompt(value.attempt);
  assert.equal(`${prompt.systemPrompt}\n${prompt.task}`.includes(value.attempt.baselinePath), false);
  assert.equal(`${prompt.systemPrompt}\n${prompt.task}`.includes(value.attempt.inputDescriptorPath), false);
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
  assert.equal(execution.lifecycle, 'succeeded');
});

test('same-size report changes across open/read boundaries fail closed', async (t) => {
  const value = await scenario(t);
  const hook = interceptSameSizeChange(value.reportPath, (bytes) => Buffer.from(bytes.toString('utf8').replace('"verdict":"PASS"', '"verdict":"FAIL"')));
  try {
    const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
    assert.equal(hook.injected, true);
    assert.notEqual(execution.lifecycle, 'succeeded');
    assert.match(execution.boundedDiagnostics.join('\n'), /changed while reading/i);
  } finally {
    hook.restore();
  }
});

test('ambient private directories and prompts omitting canonical review paths fail before dispatch', async (t) => {
  await t.test('ambient directory', async (t) => {
    const value = await scenario(t);
    await mkdir(path.join(value.runtimeRoot, 'home'));
    await writeFile(path.join(value.runtimeRoot, 'home/settings.json'), '{"ambient":true}');
    const observer = createObserver();
    await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /private|exist|ambient/i);
    assert.equal(observer.calls.some((entry) => entry.kind === 'dispatch-receipt'), false);
  });
  await t.test('omitted paths', async (t) => {
    const value = await scenario(t);
    value.options.buildPrompt = () => ({ systemPrompt: 'review safely', task: 'review now' });
    const observer = createObserver();
    await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /canonical review path/i);
    assert.equal(observer.calls.some((entry) => entry.kind === 'before-dispatch'), false);
  });
});

test('preflight and execute bind guard authority to preparation references and the complete attempt', async (t) => {
  await t.test('changed input authority is never adopted as the baseline', async (t) => {
    const value = await scenario(t);
    const config = JSON.parse(await readFile(value.attempt.guardConfigPath, 'utf8'));
    config.inputRoots = [value.repositoryRoot];
    await chmod(value.attempt.guardConfigPath, 0o600);
    await writeFile(value.attempt.guardConfigPath, JSON.stringify(config));
    await chmod(value.attempt.guardConfigPath, 0o400);
    const preparation = Object.fromEntries([
      'stateDir', 'inputRoot', 'runtimeRoot', 'reportRoot', 'manifestPath', 'diffPath',
      'guardExtensionPath', 'guardConfigPath', 'reportSchemaPath', 'guardAcknowledgementPath',
      'reviewInputDigest', 'baselineDigest', 'baselinePath', 'baselineArtifactDigest',
      'inputDescriptorPath', 'inputDescriptorArtifactDigest',
    ].map((key) => [key, value.attempt[key]]));
    assert.equal(Object.hasOwn(preparation, 'attemptId'), false);
    const adapter = createArcStandaloneReviewAdapter(value.options);
    const preflight = await adapter.preflight({ request: value.request, preparation });
    assert.equal(preflight.ok, false);
    assert.match(preflight.reason, /guard config|inputRoots|prepared input/i);
    await assert.rejects(
      () => adapter.execute(value.attempt, new AbortController().signal, createObserver()),
      /guard config|inputRoots|prepared input/i,
    );
    assert.equal(await access(value.recordPath).then(() => true, () => false), false);
  });

  await t.test('attempt identity is checked only when execute receives it', async (t) => {
    const value = await scenario(t);
    const config = JSON.parse(await readFile(value.attempt.guardConfigPath, 'utf8'));
    config.attemptId = 'different-attempt';
    await chmod(value.attempt.guardConfigPath, 0o600);
    await writeFile(value.attempt.guardConfigPath, JSON.stringify(config));
    await chmod(value.attempt.guardConfigPath, 0o400);
    const preparation = Object.fromEntries([
      'stateDir', 'inputRoot', 'runtimeRoot', 'reportRoot', 'manifestPath', 'diffPath',
      'guardExtensionPath', 'guardConfigPath', 'reportSchemaPath', 'guardAcknowledgementPath',
      'reviewInputDigest', 'baselineDigest', 'baselinePath', 'baselineArtifactDigest',
      'inputDescriptorPath', 'inputDescriptorArtifactDigest',
    ].map((key) => [key, value.attempt[key]]));
    const adapter = createArcStandaloneReviewAdapter(value.options);
    assert.deepEqual(await adapter.preflight({ request: value.request, preparation }), { ok: true });
    await assert.rejects(
      () => adapter.execute(value.attempt, new AbortController().signal, createObserver()),
      /attemptId|attempt identity/i,
    );
    assert.equal(await access(value.recordPath).then(() => true, () => false), false);
  });
});

test('preflight rejects relative, checkout/input-overlapping, symlink, and non-private destinations', async (t) => {
  const value = await scenario(t);
  const adapter = createArcStandaloneReviewAdapter(value.options);
  const badAttempts = [
    { ...value.attempt, runtimeRoot: 'relative' },
    { ...value.attempt, runtimeRoot: value.inputRoot },
    { ...value.attempt, reportRoot: value.inputRoot },
    { ...value.attempt, baselinePath: value.attempt.manifestPath },
    { ...value.attempt, inputDescriptorPath: path.join(value.sourceRoot, 'a.ts') },
    { ...value.attempt, guardAcknowledgementPath: path.join(value.inputRoot, 'ack.json') },
    { ...value.attempt, guardExtensionPath: `${value.runtimeRoot}${path.sep}reports${path.sep}..${path.sep}review-child.ts` },
  ];
  for (const attempt of badAttempts) {
    const result = await adapter.preflight({ request: value.request, preparation: attempt });
    assert.equal(result.ok, false);
    assert.equal(result.classification, 'incompatible');
  }
  await chmod(value.runtimeRoot, 0o755);
  const publicRuntime = await adapter.preflight({ request: value.request, preparation: value.attempt });
  assert.equal(publicRuntime.ok, false);
  await chmod(value.runtimeRoot, 0o700);
  const link = path.join(value.root, 'runtime-link');
  await (await import('node:fs/promises')).symlink(value.runtimeRoot, link);
  const result = await adapter.preflight({ request: value.request, preparation: { ...value.attempt, runtimeRoot: link } });
  assert.equal(result.ok, false);
});

test('materialization rejects malformed guard config before writing artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-invalid-materialization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const reportRoot = path.join(runtimeRoot, 'reports');
  const inputRoot = path.join(root, 'input');
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(reportRoot, { mode: 0o700 });
  await mkdir(inputRoot);
  const base = {
    version: 1,
    attemptId: 'attempt-invalid',
    inputRoots: [inputRoot],
    reportRoot,
    reportPath: path.join(reportRoot, 'report.json'),
    reportSchemaPath: path.join(runtimeRoot, 'arc-reviewer-report-schema.json'),
    acknowledgementPath: path.join(reportRoot, 'ack.json'),
    expectedReviewInputDigest: 'a'.repeat(64),
    allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
  };
  for (const config of [
    { ...base, version: 2 },
    { ...base, extra: true },
    { ...base, expectedReviewInputDigest: 'bad' },
    { ...base, allowedTools: [...base.allowedTools, 'bash'] },
    { ...base, inputRoots: [runtimeRoot] },
  ]) {
    await assert.rejects(() => materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA }), /config|version|digest|allowlist|exact|disjoint/i);
    assert.equal(await access(path.join(runtimeRoot, 'review-child.ts')).then(() => true, () => false), false);
  }
});

test('materialization rejects preexisting destinations and preserves unrelated bytes', async (t) => {
  const value = await scenario(t);
  const unrelated = path.join(value.runtimeRoot, 'unrelated.txt');
  await writeFile(unrelated, 'preserve');
  await assert.rejects(() => materializeArcReviewGuard({
    config: {
      version: 1,
      attemptId: 'again',
      inputRoots: [value.inputRoot],
      reportRoot: value.reportRoot,
      reportPath: path.join(value.reportRoot, 'again.json'),
      reportSchemaPath: value.materialized.reportSchemaPath,
      acknowledgementPath: path.join(value.reportRoot, 'again-ack.json'),
      expectedReviewInputDigest: 'e'.repeat(64),
      allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
    },
    runtimeRoot: value.runtimeRoot,
    sourceModulePath: guardSource,
    reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA,
  }), /EEXIST|exist/i);
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve');
  assert.equal(await readFile(value.materialized.extensionPath, 'utf8'), await readFile(guardSource, 'utf8'));
});
