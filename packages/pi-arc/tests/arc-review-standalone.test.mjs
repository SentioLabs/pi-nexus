import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsPromises, { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { ARC_REVIEWER_REPORT_JSON_SCHEMA, canonicalizeArcJson } from '../extensions/arc/reports.ts';
import { verifyArcReviewInput } from '../extensions/arc/review-input.ts';
import { createArcStandaloneReviewAdapter, materializeArcReviewGuard } from '../extensions/arc/review-standalone.ts';

const guardSource = fileURLToPath(new URL('../extensions/arc/review-child.ts', import.meta.url));
const fakePiSource = fileURLToPath(new URL('./fixtures/review/fake-pi.mjs', import.meta.url));
let serial = 0;

async function makeTreeWritable(root) {
  const info = await lstat(root).catch(() => undefined);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await fsPromises.readdir(root)) await makeTreeWritable(path.join(root, entry));
  } else if (info.isFile()) await chmod(root, 0o600);
}

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
  t.after(async () => { await makeTreeWritable(root); await rm(root, { recursive: true, force: true }); });
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
  const instructionCount = additions.instructionCount ?? 1;
  const instructionRelatives = Array.from({ length: instructionCount }, (_, index) => `materials/instructions/${String(index + 1).padStart(4, '0')}.md`);
  const materialRelatives = [
    'materials/design.md',
    'materials/diff.patch',
    ...instructionRelatives,
    'materials/review.md',
    'materials/task.md',
  ].sort();
  const reviewerMaterials = materialRelatives.map((entry) => path.join(inputRoot, ...entry.split('/')));
  const sourceBytes = Buffer.from('export const a = 1;\n');
  const materialBytes = Buffer.from('{}');
  const digestBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    version: 1,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    range: `${'1'.repeat(40)}..${'2'.repeat(40)}`,
    ignoredPolicy: 'excluded',
    source: [{ path: 'a.ts', gitMode: '100644', physicalMode: '0400', size: sourceBytes.length, sha256: digestBytes(sourceBytes) }],
    changes: [],
    materials: materialRelatives.map((entry) => ({ path: entry, physicalMode: '0400', size: materialBytes.length, sha256: digestBytes(materialBytes) })),
  };
  const manifestBytes = Buffer.from(canonicalizeArcJson(manifest));
  await writeFile(path.join(sourceRoot, 'a.ts'), sourceBytes);
  for (let offset = 0; offset < reviewerMaterials.length; offset += 256) {
    await Promise.all(reviewerMaterials.slice(offset, offset + 256).map((file) => writeFile(file, materialBytes)));
  }
  await Promise.all([
    writeFile(materialFiles.manifestPath, manifestBytes),
    writeFile(materialFiles.baselinePath, '{}', { mode: 0o400 }),
    writeFile(materialFiles.inputDescriptorPath, '{}', { mode: 0o400 }),
  ]);
  const inputHash = createHash('sha256');
  inputHash.update(`manifest\0${'0400'}\0${manifestBytes.length}\0`); inputHash.update(manifestBytes);
  const inputRows = [
    { fullPath: 'source/a.ts', physicalMode: '0400', bytes: sourceBytes },
    ...materialRelatives.map((fullPath) => ({ fullPath, physicalMode: '0400', bytes: materialBytes })),
  ].sort((left, right) => Buffer.from(left.fullPath).compare(Buffer.from(right.fullPath)));
  for (const row of inputRows) {
    inputHash.update(`\0${row.fullPath}\0${row.physicalMode}\0${row.bytes.length}\0`); inputHash.update(row.bytes);
  }
  const reviewInputDigest = inputHash.digest('hex');
  const immutableFiles = [path.join(sourceRoot, 'a.ts'), materialFiles.manifestPath, ...reviewerMaterials];
  for (let offset = 0; offset < immutableFiles.length; offset += 256) {
    await Promise.all(immutableFiles.slice(offset, offset + 256).map((file) => chmod(file, 0o400)));
  }
  await Promise.all([inputRoot, sourceRoot, materialsRoot, instructionsRoot].map((directory) => chmod(directory, 0o500)));
  const verification = await verifyArcReviewInput({
    inputRoot, sourceRoot, manifestPath: materialFiles.manifestPath, diffPath: materialFiles.diffPath,
    digest: reviewInputDigest, fileCount: inputRows.length + 1, totalBytes: manifestBytes.length + inputRows.reduce((sum, row) => sum + row.bytes.length, 0),
  }, { maxFiles: 25_000, maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, maxProcessOutputBytes: 1024 * 1024, maxGitOutputBytes: 64 * 1024 * 1024 });
  assert.deepEqual(verification, { state: 'unchanged', differences: [] });
  const attemptId = `attempt-${++serial}`;
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
  const executionTimeoutMs = additions.executionTimeoutMs ?? 1000;
  const effectiveAttemptBudgetMs = executionTimeoutMs + 10_000;
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
    effectiveAttemptBudgetMs,
    executionTimeoutMs,
    dispatchDeadlineAt: new Date(Date.now() + effectiveAttemptBudgetMs).toISOString(),
  };
  const fixedMaterials = ['diff.patch', 'task.md', 'design.md', 'review.md'].map((name) => path.join(materialsRoot, name));
  const compactPromptPaths = [inputRoot, sourceRoot, materialFiles.manifestPath, ...fixedMaterials, instructionsRoot];
  const absoluteReadPaths = compactPromptPaths;
  const controlPath = path.join(root, 'fake-pi-control.json');
  await writeFile(controlPath, JSON.stringify({
    mode,
    recordPath,
    acknowledgementPath,
    reportPath,
    guardPath: materialized.extensionPath,
    schemaPath: materialized.reportSchemaPath,
    attemptId,
    digest: reviewInputDigest,
    guardDigest: materialized.sourceDigest,
    schemaDigest: materialized.reportSchemaDigest,
    absoluteReadPaths,
  }), { flag: 'wx', mode: 0o600 });
  const processEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
  let uuid = 0;
  const options = {
    piCommand: additions.piCommand ?? fakePi,
    selectedModel: 'fixture/model',
    buildPrompt: () => ({
      systemPrompt: compactPromptPaths.map((entry) => `\"${entry}\"`).join('\n'),
      task: 'Read every manifest-indexed instruction and review only the canonical listed inputs.',
    }),
    trustedProviderExtensions: [],
    processEnv,
    randomUUID: () => `${attemptId}-uuid-${++uuid}`,
  };
  return { root, repositoryRoot, stateDir, inputRoot, sourceRoot, runtimeRoot, reportRoot, evidenceRoot, reportPath, acknowledgementPath, recordPath, controlPath, request, attempt, options, materialized, reviewerMaterials, absoluteReadPaths };
}

async function setFixtureControl(value, additions) {
  const control = JSON.parse(await readFile(value.controlPath, 'utf8'));
  await writeFile(value.controlPath, JSON.stringify({ ...control, ...additions }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle within test bound')), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

function interceptPendingRead(target, closeSettlement) {
  const realOpen = fsPromises.open;
  const readEntered = deferred();
  const pendingRead = deferred();
  let handle;
  let originalClose;
  let closeCalls = 0;
  fsPromises.open = async function(file, ...args) {
    const current = await realOpen(file, ...args);
    if (file !== target) return current;
    assert.equal(handle, undefined);
    handle = current;
    originalClose = current.close.bind(current);
    current.read = function() {
      readEntered.resolve();
      return pendingRead.promise;
    };
    current.close = function(...closeArgs) {
      closeCalls += 1;
      const closing = originalClose(...closeArgs);
      if (!closeSettlement) return closing;
      void closing.catch(() => {});
      return closeSettlement.promise;
    };
    return current;
  };
  syncBuiltinESMExports();
  return {
    readEntered,
    pendingRead,
    get closeCalls() { return closeCalls; },
    async descriptorIsOpen() { return handle.stat().then(() => true, () => false); },
    async restore() {
      fsPromises.open = realOpen;
      syncBuiltinESMExports();
      pendingRead.resolve({ bytesRead: 0 });
      if (originalClose) await originalClose().catch(() => {});
    },
  };
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
  assert.equal(observer.calls.some((entry) => entry.kind === 'termination'), false);
  assert.match(execution.boundedDiagnostics.join('\n'), /reconciliation|cancel/i);
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
  assert.equal(execution.lifecycle, 'guard_failed');
  assert.equal(execution.termination.status, 'observed');
  assert.match(execution.boundedDiagnostics.join('\n'), /reconciliation|cancel/i);
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
  for (const [label, quote] of [['double-quoted', '"'], ['single-quoted', "'"], ['backticked', '`'], ['unquoted', '']]) {
    await t.test(`accepts ${label} complete canonical paths`, async (t) => {
      const value = await scenario(t);
      value.options.buildPrompt = () => ({
        systemPrompt: value.absoluteReadPaths.map((entry) => `${quote}${entry}${quote}`).join('\n'),
        task: 'Review the listed canonical paths.',
      });
      const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
      assert.equal(execution.lifecycle, 'succeeded');
    });
  }
  for (const [label, quote, suffix] of [
    ['double-quoted comma suffix', '"', ',copy'],
    ['double-quoted semicolon suffix', '"', ';copy'],
    ['single-quoted punctuation suffix', "'", ',copy'],
    ['backticked punctuation suffix', '`', ';copy'],
    ['double-quoted Unicode suffix', '"', '，副本'],
    ['backticked Unicode suffix', '`', '—複製'],
  ]) {
    await t.test(`rejects ${label}`, async (t) => {
      const value = await scenario(t);
      value.options.buildPrompt = () => ({
        systemPrompt: value.absoluteReadPaths.map((entry) => `${quote}${entry === value.sourceRoot ? entry + suffix : entry}${quote}`).join('\n'),
        task: 'Review the listed canonical paths.',
      });
      const observer = createObserver();
      await assert.rejects(
        () => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer),
        /prompt omitted canonical review path/i,
      );
      assert.equal(observer.calls.some((entry) => entry.kind === 'before-dispatch'), false);
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

test('the copied guard rejects transient authority replacement before module load', async (t) => {
  const value = await scenario(t, 'no-artifacts');
  const originalConfig = await readFile(value.materialized.configPath);
  const changedConfig = JSON.parse(originalConfig);
  changedConfig.inputRoots = [value.repositoryRoot];
  const outsideFile = path.join(value.repositoryRoot, 'outside-original-input.txt');
  const observations = path.join(value.root, 'startup-binding-observations.json');
  await writeFile(outsideFile, 'fixture-only');
  await writeFile(value.options.piCommand, `#!/usr/bin/env node
import { chmod, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const guardPath = ${JSON.stringify(value.materialized.extensionPath)};
const outsideFile = ${JSON.stringify(outsideFile)};
const configPath = ${JSON.stringify(value.materialized.configPath)};
const originalConfig = ${JSON.stringify(originalConfig.toString('base64'))};
const observations = ${JSON.stringify(observations)};
const handlers = new Map();
let acknowledged = false;
let readAllowed = false;
let loadRejected = false;
try {
  const module = await import(pathToFileURL(guardPath).href);
  await module.default({
    on(name, handler) { handlers.set(name, handler); },
    registerTool() {},
    events: { emit() { acknowledged = true; } },
  });
  await handlers.get('session_start')();
  const decision = await handlers.get('tool_call')({
    toolName: 'read',
    toolCallId: 'outside-original-input',
    input: { path: outsideFile },
  });
  readAllowed = decision?.block !== true;
} catch {
  loadRejected = true;
} finally {
  await chmod(configPath, 0o600);
  await writeFile(configPath, Buffer.from(originalConfig, 'base64'));
  await chmod(configPath, 0o400);
}
await writeFile(observations, JSON.stringify({ acknowledged, readAllowed, loadRejected }));
console.log('{}');
`);
  const observer = createObserver({
    before: async () => {
      await chmod(value.materialized.configPath, 0o600);
      await writeFile(value.materialized.configPath, JSON.stringify(changedConfig));
      await chmod(value.materialized.configPath, 0o400);
    },
  });
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
  assert.deepEqual(JSON.parse(await readFile(observations, 'utf8')), { acknowledged: false, readAllowed: false, loadRejected: true });
  assert.deepEqual(await readFile(value.materialized.configPath), originalConfig);
  assert.equal(execution.lifecycle, 'guard_failed');
  assert.equal(execution.termination.status, 'observed');
  assert.equal(execution.structuredReport, undefined);
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

test('environment uses a positive data allowlist and private generated destinations', async (t) => {
  const value = await scenario(t, 'copied-guard');
  const allowedKeys = `PATH LANG LC_ALL LC_CTYPE TZ TERM CI NO_COLOR
ANTHROPIC_API_KEY ANT_LING_API_KEY AZURE_OPENAI_API_KEY OPENAI_API_KEY
DEEPSEEK_API_KEY NVIDIA_API_KEY GEMINI_API_KEY AWS_BEARER_TOKEN_BEDROCK
MISTRAL_API_KEY GROQ_API_KEY CEREBRAS_API_KEY CLOUDFLARE_API_KEY
XAI_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY ZAI_API_KEY
ZAI_CODING_CN_API_KEY OPENCODE_API_KEY RADIUS_API_KEY HF_TOKEN
FIREWORKS_API_KEY TOGETHER_API_KEY BASETEN_API_KEY KIMI_API_KEY
MINIMAX_API_KEY MINIMAX_CN_API_KEY QWEN_TOKEN_PLAN_API_KEY
QWEN_TOKEN_PLAN_CN_API_KEY XIAOMI_API_KEY XIAOMI_TOKEN_PLAN_CN_API_KEY
XIAOMI_TOKEN_PLAN_AMS_API_KEY XIAOMI_TOKEN_PLAN_SGP_API_KEY
AZURE_OPENAI_BASE_URL AZURE_OPENAI_RESOURCE_NAME AZURE_OPENAI_API_VERSION
AZURE_OPENAI_DEPLOYMENT_NAME_MAP CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_GATEWAY_ID
AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION
GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION HTTP_PROXY HTTPS_PROXY`.split(/\s+/);
  const allowedData = Object.fromEntries(allowedKeys.map((name, index) => [name, index === 1 ? '' : `synthetic-${index}`]));
  allowedData.PATH = process.env.PATH;
  allowedData.OPENAI_API_KEY = 'x'.repeat(16_384);
  const preloadSentinel = path.join(value.root, 'preload-sentinel');
  const preload = path.join(value.root, 'harmless-preload.cjs');
  await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloadSentinel)}, 'ran')`);
  const supplied = {
    ...allowedData,
    NODE_OPTIONS: `--require=${preload}`,
    NODE_PATH: path.join(value.root, 'modules'),
    LD_PRELOAD: path.join(value.root, 'missing.so'),
    PI_ARBITRARY_CONTROL: 'blocked',
    PI_PACKAGE_DIR: path.join(value.root, 'packages'),
    AWS_PROFILE: 'blocked-profile',
    GOOGLE_APPLICATION_CREDENTIALS: path.join(value.root, 'credentials.json'),
    SESSION_ID: 'blocked-session',
  };
  const snapshot = { ...supplied };
  value.options.processEnv = supplied;
  await setFixtureControl(value, { allowedData });
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
  assert.equal(execution.lifecycle, 'succeeded');
  assert.deepEqual(supplied, snapshot);
  assert.equal(await access(preloadSentinel).then(() => true, () => false), false);
  const record = JSON.parse(await readFile(value.recordPath, 'utf8'));
  assert.ok(Object.values(record.allowedDataPreserved).every(Boolean));
  assert.deepEqual(record.flags, {
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_PACKAGE_DIR: null,
    NODE_OPTIONS: null, NODE_PATH: null, LD_PRELOAD: null, AWS_PROFILE: null, GOOGLE_APPLICATION_CREDENTIALS: null,
  });
  assert.equal(record.env.TMP, record.env.TMPDIR);
  assert.equal(record.env.TEMP, record.env.TMPDIR);
  for (const destination of Object.values(record.env)) {
    assert.ok(destination.startsWith(`${value.runtimeRoot}${path.sep}`));
    assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  }
});

test('invalid and oversized environment or launch vectors fail before persistence and spawn', async (t) => {
  for (const [label, mutate] of [
    ['non-string', (value) => { value.options.processEnv.OPENAI_API_KEY = 7; }],
    ['NUL', (value) => { value.options.processEnv.OPENAI_API_KEY = 'bad\0value'; }],
    ['scalar bytes', (value) => { value.options.processEnv.OPENAI_API_KEY = '界'.repeat(6000); }],
    ['total environment', (value) => { for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'HF_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) value.options.processEnv[name] = 'x'.repeat(16_384); }],
    ['aggregate argv', (value) => { value.options.selectedModel = 'm'.repeat(190 * 1024); }],
  ]) {
    await t.test(label, async (t) => {
      const value = await scenario(t, 'success');
      mutate(value);
      const observer = createObserver();
      await assert.rejects(() => createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer), /environment|scalar|launch|byte|vector/i);
      assert.equal(observer.calls.length, 0);
      assert.equal(await access(value.recordPath).then(() => true, () => false), false);
    });
  }
});

test('copied guard publication faults leave artifacts but cannot become adapter success', async (t) => {
  for (const [fault, unavailable] of [
    ['report-directory-sync', false],
    ['report-directory-sync', true],
    ['ack-directory-sync', false],
    ['temporary-cleanup', false],
    ['unsupported-link', false],
  ]) {
    await t.test(`${fault}-${unavailable ? 'no-evidence' : 'evidence'}`, { timeout: 5000 }, async (t) => {
      const value = await scenario(t, 'copied-guard');
      await setFixtureControl(value, { publicationFault: fault, failureEvidenceUnavailable: unavailable });
      const execution = await settlesWithin(createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver()), 4000);
      assert.notEqual(execution.lifecycle, 'succeeded');
      assert.equal(execution.structuredReport, undefined);
      assert.equal(execution.termination.status, 'observed');
      const evidence = path.join(value.reportRoot, 'guard-evidence.jsonl');
      if (unavailable) {
        assert.notEqual(execution.exitCode, 0);
        assert.equal(await access(evidence).then(() => true, () => false), false);
      } else assert.equal(await access(evidence).then(() => true, () => false), true);
    });
  }
  await t.test('stuck evidence fail-stops', { timeout: 5000 }, async (t) => {
    const value = await scenario(t, 'copied-guard');
    await setFixtureControl(value, { publicationFault: 'report-directory-sync', evidenceStuck: true });
    const execution = await settlesWithin(createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver()), 4000);
    assert.notEqual(execution.lifecycle, 'succeeded');
    assert.notEqual(execution.exitCode, 0);
    assert.equal(execution.termination.status, 'observed');
  });
});

test('one attempt budget bounds before-dispatch persistence and matching stop before process invocation', async (t) => {
  const value = await scenario(t, 'success', { executionTimeoutMs: 150 });
  const pending = deferred();
  const entered = deferred();
  const observer = createObserver({ before: (identity) => { entered.resolve(identity); return pending.promise; } });
  const adapter = createArcStandaloneReviewAdapter(value.options);
  const running = adapter.execute(value.attempt, new AbortController().signal, observer);
  const identity = await settlesWithin(entered.promise, 1000);
  await adapter.stop(value.attempt, identity);
  const execution = await settlesWithin(running, 1000);
  assert.equal(execution.termination.source, 'not_started');
  assert.notEqual(execution.lifecycle, 'succeeded');
  pending.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await access(value.recordPath).then(() => true, () => false), false);
  assert.equal(observer.calls.some((entry) => entry.kind === 'dispatch-receipt'), false);
});

test('interrupted owned reads initiate descriptor cleanup and observe late read settlement', async (t) => {
  for (const [kind, settleRead] of [
    ['abort', (pending) => pending.resolve({ bytesRead: 0 })],
    ['deadline', (pending) => pending.reject(new Error('late read rejection'))],
  ]) {
    await t.test(kind, async (t) => {
      const value = await scenario(t, 'success', { executionTimeoutMs: 150 });
      const hook = interceptPendingRead(value.attempt.guardConfigPath);
      t.after(() => hook.restore());
      const controller = new AbortController();
      const observer = createObserver();
      const running = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, controller.signal, observer);
      await settlesWithin(hook.readEntered.promise, 1000);
      if (kind === 'abort') controller.abort(new Error('external cancellation'));
      const execution = await settlesWithin(running, 1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(execution.lifecycle, kind === 'abort' ? 'cancelled' : 'timed_out');
      assert.equal(execution.termination.source, 'not_started');
      assert.equal(observer.calls.length, 0);
      assert.equal(hook.closeCalls, 1, 'cleanup must be initiated before test-owned cleanup');
      assert.equal(await hook.descriptorIsOpen(), false, 'the owned descriptor must be closed before test-owned cleanup');
      settleRead(hook.pendingRead);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(hook.closeCalls, 1);
      assert.equal(await hook.descriptorIsOpen(), false);
    });
  }
});

test('descriptor cleanup is bounded and observes late close fulfillment or rejection', async (t) => {
  for (const settlement of ['fulfill', 'reject']) {
    await t.test(settlement, async (t) => {
      const value = await scenario(t, 'success', { executionTimeoutMs: 1000 });
      const pendingClose = deferred();
      const hook = interceptPendingRead(value.attempt.guardConfigPath, pendingClose);
      t.after(() => hook.restore());
      const controller = new AbortController();
      const observer = createObserver();
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const running = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, controller.signal, observer);
        await settlesWithin(hook.readEntered.promise, 1000);
        controller.abort(new Error('external cancellation'));
        const execution = await settlesWithin(running, 1000);
        assert.equal(execution.lifecycle, 'cancelled');
        assert.equal(execution.termination.source, 'not_started');
        assert.equal(observer.calls.length, 0);
        assert.equal(hook.closeCalls, 1, 'cleanup must not await an expired work window');
        assert.equal(await hook.descriptorIsOpen(), false);
        hook.pendingRead.reject(new Error('late read rejection'));
        if (settlement === 'fulfill') pendingClose.resolve();
        else pendingClose.reject(new Error('late close rejection'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  }
});

test('deadline and external abort settle a pending before-dispatch barrier without late dispatch', async (t) => {
  for (const kind of ['deadline', 'abort']) {
    await t.test(kind, async (t) => {
      const value = await scenario(t, 'success', { executionTimeoutMs: 60 });
      const pending = deferred();
      const entered = deferred();
      const controller = new AbortController();
      const observer = createObserver({ before: () => { entered.resolve(); return pending.promise; } });
      const running = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, controller.signal, observer);
      await settlesWithin(entered.promise, 1000);
      if (kind === 'abort') controller.abort(new Error('external cancellation'));
      const execution = await settlesWithin(running, 1000);
      assert.equal(execution.lifecycle, kind === 'abort' ? 'cancelled' : 'timed_out');
      assert.equal(execution.termination.source, 'not_started');
      pending.reject(new Error('late observer rejection'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await access(value.recordPath).then(() => true, () => false), false);
      assert.equal(observer.calls.some((entry) => entry.kind === 'dispatch-receipt'), false);
    });
  }
});

test('invalid or expired timing is rejected or returned not-started before observer persistence', async (t) => {
  for (const [label, mutate, throws] of [
    ['noncanonical deadline', (attempt) => { attempt.dispatchDeadlineAt = 'tomorrow'; }, true],
    ['unsafe budget', (attempt) => { attempt.effectiveAttemptBudgetMs = Number.MAX_SAFE_INTEGER + 1; }, true],
    ['missing grace', (attempt) => { attempt.effectiveAttemptBudgetMs = attempt.executionTimeoutMs; }, true],
    ['expired', (attempt) => { attempt.dispatchDeadlineAt = new Date(Date.now() - 1).toISOString(); }, false],
  ]) {
    await t.test(label, async (t) => {
      const value = await scenario(t);
      mutate(value.attempt);
      const observer = createObserver();
      const running = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, observer);
      if (throws) await assert.rejects(running, /timing|deadline|budget/i);
      else {
        const execution = await running;
        assert.equal(execution.lifecycle, 'timed_out');
        assert.equal(execution.termination.source, 'not_started');
      }
      assert.equal(observer.calls.length, 0);
      assert.equal(await access(value.recordPath).then(() => true, () => false), false);
    });
  }
});

test('observed close is not promoted when terminal persistence misses cancellation or deadline', async (t) => {
  const value = await scenario(t, 'success', { executionTimeoutMs: 250 });
  const entered = deferred();
  const pending = deferred();
  const controller = new AbortController();
  const observer = createObserver({ termination: () => { entered.resolve(); return pending.promise; } });
  const running = createArcStandaloneReviewAdapter(value.options).execute(value.attempt, controller.signal, observer);
  await settlesWithin(entered.promise, 1000);
  controller.abort(new Error('cancel terminal barrier'));
  const execution = await settlesWithin(running, 1000);
  assert.equal(execution.termination.status, 'observed');
  assert.equal(execution.lifecycle, 'guard_failed');
  assert.equal(execution.structuredReport, undefined);
  pending.resolve();
});

test('manifest source paths and duplicates remain bounded and canonical', async (t) => {
  for (const kind of ['traversal', 'duplicate']) {
    await t.test(kind, async (t) => {
      const value = await scenario(t, 'no-artifacts');
      const manifest = JSON.parse(await readFile(value.attempt.manifestPath));
      if (kind === 'traversal') manifest.source[0].path = '../escape.ts';
      else manifest.source.push({ ...manifest.source[0] });
      await chmod(value.attempt.manifestPath, 0o600);
      await writeFile(value.attempt.manifestPath, canonicalizeArcJson(manifest));
      await chmod(value.attempt.manifestPath, 0o400);
      const result = await createArcStandaloneReviewAdapter(value.options).preflight({ request: value.request, preparation: value.attempt });
      assert.equal(result.ok, false);
      assert.match(result.reason, /manifest|source|duplicate|path/i);
    });
  }
});

test('T1 padStart instruction names remain contiguous through five digits and the shared file maximum', { timeout: 180_000 }, async (t) => {
  const value = await scenario(t, 'no-artifacts', { instructionCount: 24_994, executionTimeoutMs: 120_000 });
  value.options.buildPrompt = () => ({
    systemPrompt: [value.inputRoot, value.sourceRoot, value.attempt.manifestPath,
      path.join(value.inputRoot, 'materials/diff.patch'), path.join(value.inputRoot, 'materials/task.md'),
      path.join(value.inputRoot, 'materials/design.md'), path.join(value.inputRoot, 'materials/review.md'),
      path.join(value.inputRoot, 'materials/instructions')].map((entry) => `\"${entry}\"`).join('\n'),
    task: 'Read every manifest-indexed instruction.',
  });
  assert.deepEqual(await createArcStandaloneReviewAdapter(value.options).preflight({ request: value.request, preparation: value.attempt }), { ok: true });
  const manifest = JSON.parse(await readFile(value.attempt.manifestPath));
  assert.equal(manifest.source.length + manifest.materials.length + 1, 25_000);
  assert.ok(manifest.materials.some((row) => row.path === 'materials/instructions/10000.md'));
  assert.ok(manifest.materials.some((row) => row.path === 'materials/instructions/24994.md'));
});

test('compact manifest-indexed prompts execute in one bounded lexical scan and prompt limits fail before dispatch', { timeout: 120_000 }, async (t) => {
  const value = await scenario(t, 'success', { instructionCount: 10_000, executionTimeoutMs: 60_000 });
  const source = await readFile(fileURLToPath(new URL('../extensions/arc/review-standalone.ts', import.meta.url)), 'utf8');
  assert.match(source, /promptPathLiterals/);
  assert.match(source, /new Set<string>/);
  const prompt = value.options.buildPrompt(value.attempt);
  assert.ok(Buffer.byteLength(prompt.systemPrompt) < 64 * 1024);
  const execution = await createArcStandaloneReviewAdapter(value.options).execute(value.attempt, new AbortController().signal, createObserver());
  assert.equal(execution.lifecycle, 'succeeded');

  for (const [label, buildPrompt] of [
    ['code units', () => ({ systemPrompt: 'x'.repeat(65_537), task: 'review' })],
    ['UTF-8 bytes', () => ({ systemPrompt: '界'.repeat(22_000), task: 'review' })],
    ['combined', () => ({ systemPrompt: 'x'.repeat(65_536), task: 'y'.repeat(65_536) })],
    ['dangling quote', () => ({ systemPrompt: `\"${value.sourceRoot}`, task: value.absoluteReadPaths.join('\n') })],
  ]) {
    await t.test(label, async () => {
      const small = await scenario(t, 'success');
      small.options.buildPrompt = buildPrompt;
      const observer = createObserver();
      await assert.rejects(() => createArcStandaloneReviewAdapter(small.options).execute(small.attempt, new AbortController().signal, observer), /prompt|quote|byte|canonical/i);
      assert.equal(observer.calls.length, 0);
      assert.equal(await access(small.recordPath).then(() => true, () => false), false);
    });
  }
});

test('failed guard materialization retains partial and replacement artifacts without rollback deletion', async (t) => {
  for (const replacePath of [false, true]) {
    await t.test(replacePath ? 'replacement survives' : 'partial survives', async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-retain-materialization-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const runtimeRoot = path.join(root, 'runtime');
      const reportRoot = path.join(root, 'reports');
      const inputRoot = path.join(root, 'input');
      await Promise.all([mkdir(runtimeRoot, { mode: 0o700 }), mkdir(reportRoot, { mode: 0o700 }), mkdir(inputRoot)]);
      const destination = path.join(runtimeRoot, 'review-child.ts');
      const held = `${destination}.held`;
      const realOpen = fsPromises.open;
      const realRm = fsPromises.rm;
      const realUnlink = fsPromises.unlink;
      let removalCalls = 0;
      fsPromises.open = async (file, ...args) => {
        const handle = await realOpen(file, ...args);
        if (file !== destination) return handle;
        const realWrite = handle.write.bind(handle);
        handle.write = async (...writeArgs) => {
          await realWrite(Buffer.from('partial'), 0, 7, 0);
          if (replacePath) {
            await fsPromises.rename(destination, held);
            await writeFile(destination, 'replacement', { flag: 'wx', mode: 0o600 });
          }
          const error = new Error('fixture EIO during extension write'); error.code = 'EIO'; throw error;
        };
        return handle;
      };
      fsPromises.rm = async (...args) => { removalCalls += 1; return realRm(...args); };
      fsPromises.unlink = async (...args) => { removalCalls += 1; return realUnlink(...args); };
      syncBuiltinESMExports();
      const config = {
        version: 1, attemptId: 'retained', inputRoots: [inputRoot], reportRoot,
        reportPath: path.join(reportRoot, 'report.json'), reportSchemaPath: path.join(runtimeRoot, 'schema.json'),
        acknowledgementPath: path.join(reportRoot, 'ack.json'), expectedReviewInputDigest: 'a'.repeat(64),
        allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
      };
      try {
        await assert.rejects(() => materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA }), /retained|runtime|review-child|EIO/i);
        assert.equal(removalCalls, 0);
        assert.equal(await access(destination).then(() => true, () => false), true);
        if (replacePath) assert.equal(await readFile(destination, 'utf8'), 'replacement');
        else assert.equal((await readFile(destination)).subarray(0, 7).toString(), 'partial');
        if (replacePath) assert.equal(await access(held).then(() => true, () => false), true);
        await assert.rejects(() => materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA }), /exist|EEXIST|retained/i);
      } finally {
        fsPromises.open = realOpen; fsPromises.rm = realRm; fsPromises.unlink = realUnlink; syncBuiltinESMExports();
      }
    });
  }
});

test('later materialization failure retains a completed or replaced extension and reports every retained path', async (t) => {
  for (const replacePath of [false, true]) {
    await t.test(replacePath ? 'replaced completed extension' : 'completed extension', async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-retain-later-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const runtimeRoot = path.join(root, 'runtime');
      const reportRoot = path.join(root, 'reports');
      const inputRoot = path.join(root, 'input');
      await Promise.all([mkdir(runtimeRoot, { mode: 0o700 }), mkdir(reportRoot, { mode: 0o700 }), mkdir(inputRoot)]);
      const extension = path.join(runtimeRoot, 'review-child.ts');
      const held = `${extension}.held`;
      const schema = path.join(runtimeRoot, 'schema.json');
      const configPath = path.join(runtimeRoot, 'arc-review-guard.json');
      const realOpen = fsPromises.open;
      const realRm = fsPromises.rm;
      const realUnlink = fsPromises.unlink;
      let removalCalls = 0;
      fsPromises.open = async (file, ...args) => {
        if (file === schema) {
          if (replacePath) {
            await fsPromises.rename(extension, held);
            await writeFile(extension, 'replacement', { flag: 'wx', mode: 0o600 });
          }
          const error = new Error('fixture schema open EIO'); error.code = 'EIO'; throw error;
        }
        return realOpen(file, ...args);
      };
      fsPromises.rm = async (...args) => { removalCalls += 1; return realRm(...args); };
      fsPromises.unlink = async (...args) => { removalCalls += 1; return realUnlink(...args); };
      syncBuiltinESMExports();
      const config = {
        version: 1, attemptId: 'retained-later', inputRoots: [inputRoot], reportRoot,
        reportPath: path.join(reportRoot, 'report.json'), reportSchemaPath: schema,
        acknowledgementPath: path.join(reportRoot, 'ack.json'), expectedReviewInputDigest: 'a'.repeat(64),
        allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
      };
      try {
        await assert.rejects(
          () => materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA }),
          (error) => [runtimeRoot, extension, schema, configPath].every((entry) => error.message.includes(entry)),
        );
        assert.equal(removalCalls, 0);
        assert.equal(await access(extension).then(() => true, () => false), true);
        if (replacePath) {
          assert.equal(await readFile(extension, 'utf8'), 'replacement');
          assert.equal(await access(held).then(() => true, () => false), true);
        }
        await assert.rejects(() => materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: guardSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA }), /exist|EEXIST|retained/i);
      } finally {
        fsPromises.open = realOpen; fsPromises.rm = realRm; fsPromises.unlink = realUnlink; syncBuiltinESMExports();
      }
    });
  }
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
  const originalExtension = await readFile(value.materialized.extensionPath);
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
  assert.deepEqual(await readFile(value.materialized.extensionPath), originalExtension);
});
