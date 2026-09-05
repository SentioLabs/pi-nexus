import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function scenario(t, mode = 'success', additions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-review-standalone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'checkout');
  const inputRoot = path.join(root, 'input');
  const sourceRoot = path.join(inputRoot, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  const reportRoot = path.join(runtimeRoot, 'reports');
  await Promise.all([mkdir(repositoryRoot), mkdir(sourceRoot, { recursive: true }), mkdir(runtimeRoot, { mode: 0o700 })]);
  await mkdir(reportRoot, { mode: 0o700 });
  const materialFiles = {
    manifestPath: path.join(inputRoot, 'manifest.json'),
    diffPath: path.join(inputRoot, 'review.diff'),
    baselinePath: path.join(inputRoot, 'baseline.json'),
    inputDescriptorPath: path.join(inputRoot, 'descriptor.json'),
  };
  await Promise.all([
    writeFile(path.join(sourceRoot, 'a.ts'), 'export const a = 1;\n'),
    ...Object.values(materialFiles).map((file) => writeFile(file, '{}')),
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
    stateDir: runtimeRoot,
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
  const absoluteReadPaths = [sourceRoot, materialFiles.manifestPath, materialFiles.diffPath];
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
      systemPrompt: `Review source at ${sourceRoot}; materials at ${value.manifestPath}, ${value.diffPath}, ${value.baselinePath}, and ${value.inputDescriptorPath}.`,
      task: `Review ${sourceRoot} using ${value.manifestPath}.`,
    }),
    trustedProviderExtensions: [],
    processEnv,
    randomUUID: () => `${attemptId}-uuid-${++uuid}`,
  };
  return { root, repositoryRoot, inputRoot, sourceRoot, runtimeRoot, reportRoot, reportPath, acknowledgementPath, recordPath, request, attempt, options, materialized, absoluteReadPaths };
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

test('preflight rejects relative, checkout/input-overlapping, symlink, and non-private destinations', async (t) => {
  const value = await scenario(t);
  const adapter = createArcStandaloneReviewAdapter(value.options);
  const badAttempts = [
    { ...value.attempt, runtimeRoot: 'relative' },
    { ...value.attempt, runtimeRoot: value.inputRoot },
    { ...value.attempt, reportRoot: value.inputRoot },
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
