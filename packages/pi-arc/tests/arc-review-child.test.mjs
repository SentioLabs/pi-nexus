import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ARC_REVIEWER_REPORT_JSON_SCHEMA } from '../extensions/arc/reports.ts';
import { materializeArcReviewGuard } from '../extensions/arc/review-standalone.ts';

const guardSource = fileURLToPath(new URL('../extensions/arc/review-child.ts', import.meta.url));
const canarySource = fileURLToPath(new URL('./fixtures/review/canary-mutation-extension.ts', import.meta.url));
let serial = 0;

function scanRuntimeImports(source) {
  const imports = [];
  for (const line of source.split('\n')) {
    if (/^\s*import\s+type\b/.test(line)) continue;
    const match = line.match(/^\s*import\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/);
    if (match) imports.push(match[1]);
  }
  return imports.sort();
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

function validReport(digest) {
  return {
    schemaVersion: 1,
    reviewInputDigest: digest,
    verdict: 'PASS',
    summary: 'No discrepancy found in the deterministic fixture.',
    findings: [],
    coverage: { reviewedPaths: ['source/a.ts'], reviewedRequirements: ['SC3'] },
    limitations: [],
  };
}

function createHarness() {
  const handlers = new Map();
  const toolRegistry = new Map();
  const emitted = [];
  const pi = {
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool(tool) { toolRegistry.set(tool.name, tool); },
    events: { emit(name, value) { emitted.push({ name, value }); } },
  };
  async function emit(name, event = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, {}));
    return results;
  }
  let lastEvent;
  async function invoke(name, input, callId = `call-${++serial}`) {
    lastEvent = { toolName: name, toolCallId: callId, input };
    for (const handler of handlers.get('tool_call') ?? []) {
      const result = await handler(lastEvent, {});
      if (result?.block) return result;
    }
    return undefined;
  }
  async function dispatchRegisteredTool(name, input) {
    const blocked = await invoke(name, input);
    if (blocked) return { ...blocked, blockedBy: 'review-child' };
    const tool = toolRegistry.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered`);
    return tool.execute(`dispatch-${++serial}`, input, new AbortController().signal);
  }
  return { pi, handlers, toolRegistry, emitted, emit, invoke, dispatchRegisteredTool, get lastEvent() { return lastEvent; } };
}

async function preparedGuard(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-review-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceCheckoutRoot = path.join(root, 'disposable-source');
  const inputRoot = path.join(root, 'input');
  const runtimeRoot = path.join(root, 'runtime');
  const reportRoot = path.join(root, 'reports');
  await Promise.all([
    mkdir(sourceCheckoutRoot, { recursive: true }),
    mkdir(path.join(inputRoot, 'source'), { recursive: true }),
    mkdir(runtimeRoot, { mode: 0o700 }),
    mkdir(reportRoot, { mode: 0o700 }),
  ]);
  const disposableSource = path.join(sourceCheckoutRoot, 'review-child.ts');
  await copyFile(guardSource, disposableSource);
  await writeFile(path.join(inputRoot, 'source/a.ts'), 'const secretSourceContents = 42;\n');
  const attemptId = `attempt-${++serial}`;
  const digest = 'a'.repeat(64);
  const config = {
    version: 1,
    attemptId,
    inputRoots: [inputRoot],
    reportRoot,
    reportPath: path.join(reportRoot, 'review-report.json'),
    reportSchemaPath: path.join(runtimeRoot, 'arc-reviewer-report-schema.json'),
    acknowledgementPath: path.join(reportRoot, 'guard-ack.json'),
    expectedReviewInputDigest: digest,
    allowedTools: ['read', 'grep', 'find', 'ls', 'structured_output', 'arc_review_report'],
    ...overrides,
  };
  const materialized = await materializeArcReviewGuard({ config, runtimeRoot, sourceModulePath: disposableSource, reviewerSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA });
  return { root, sourceCheckoutRoot, inputRoot, runtimeRoot, reportRoot, config, materialized, attemptId, digest };
}

async function loadGuard(prepared) {
  const harness = createHarness();
  const module = await import(`${pathToFileURL(prepared.materialized.extensionPath).href}?case=${++serial}`);
  await module.default(harness.pi);
  return { harness, module };
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
        const current = await readFile(target);
        const changed = changeBytes(current);
        assert.equal(changed.length, current.length);
        await chmod(target, 0o600);
        await writeFile(target, changed, { flag: 'r+' });
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

async function withWrongOwner(target, action) {
  if (typeof process.getuid !== 'function') return;
  const realLstat = fsPromises.lstat;
  fsPromises.lstat = async function(file, options) {
    const result = await realLstat(file, options);
    if (file !== target) return result;
    return new Proxy(result, { get(object, property) { return property === 'uid' ? object.uid + (typeof object.uid === 'bigint' ? 1n : 1) : Reflect.get(object, property); } });
  };
  syncBuiltinESMExports();
  try { await action(); } finally { fsPromises.lstat = realLstat; syncBuiltinESMExports(); }
}

test('materialization is closed over five Node runtime imports and survives source checkout removal', async (t) => {
  const prepared = await preparedGuard(t);
  assert.deepEqual(scanRuntimeImports(await readFile(prepared.materialized.extensionPath, 'utf8')), [
    'node:crypto', 'node:fs', 'node:fs/promises', 'node:path', 'node:url',
  ]);
  const hidden = `${prepared.sourceCheckoutRoot}.hidden`;
  await rename(prepared.sourceCheckoutRoot, hidden);
  const { harness } = await loadGuard(prepared);
  assert.deepEqual([...harness.toolRegistry.keys()], ['arc_review_report']);
  await harness.emit('session_start', { reason: 'startup' });
  const ack = JSON.parse(await readFile(prepared.materialized.acknowledgementPath, 'utf8'));
  assert.equal(ack.guardSourceDigest, prepared.materialized.sourceDigest);
  assert.equal(ack.reportSchemaDigest, prepared.materialized.reportSchemaDigest);
  assert.deepEqual(harness.emitted, [{ name: 'subagent:acknowledge-extension', value: { id: `pi-arc.review-child:v1:${prepared.attemptId}` } }]);
  assert.equal((await lstat(prepared.materialized.extensionPath)).mode & 0o777, 0o400);
  assert.equal((await lstat(prepared.materialized.configPath)).mode & 0o777, 0o400);
  assert.equal((await lstat(prepared.materialized.reportSchemaPath)).mode & 0o777, 0o400);
  assert.equal((await lstat(prepared.materialized.acknowledgementPath)).mode & 0o777, 0o600);
});

test('guard canonicalizes allowed read/search paths and blocks every widened shape with bounded evidence', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  await harness.emit('session_start');
  const absolute = await realpath(path.join(prepared.inputRoot, 'source/a.ts'));
  for (const name of ['read', 'grep', 'find', 'ls']) {
    assert.equal(await harness.invoke(name, { path: absolute }), undefined);
    assert.equal(harness.lastEvent.input.path, absolute);
  }
  assert.equal(await harness.invoke('structured_output', { value: true }), undefined);
  assert.equal(await harness.invoke('arc_review_report', validReport(prepared.digest)), undefined);
  assert.match((await harness.invoke('read', { path: 'source/a.ts' })).reason, /absolute path required/i);

  const sibling = `${prepared.inputRoot}-sibling`;
  const runtimeSentinel = path.join(prepared.runtimeRoot, 'private.txt');
  const outside = path.join(prepared.root, 'outside.txt');
  const escapeLink = path.join(prepared.inputRoot, 'source/escape');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'a.ts'), 'sibling');
  await writeFile(runtimeSentinel, 'runtime');
  await writeFile(outside, 'outside');
  await symlink(outside, escapeLink);
  const denied = [
    ['read', {}],
    ['read', { path: '' }],
    ['read', { path: '../outside.txt' }],
    ['read', { path: `${absolute}\0tail` }],
    ['read', { path: path.join(sibling, 'a.ts') }],
    ['read', { path: escapeLink }],
    ['read', { path: runtimeSentinel }],
    ['read', { path: prepared.reportRoot }],
    ['structured_output', { path: outside }],
    ['arc_review_report', { ...validReport(prepared.digest), path: outside }],
    ['bash', { command: 'git commit' }],
    ['write', { path: outside, content: 'x' }],
    ['edit', { path: outside }],
    ['arc', { command: 'close' }],
    ['arc_agent', { action: 'delegate' }],
    ['subagent', { task: 'fanout' }],
    ['canary_mutate', { path: outside }],
    ['npm', { command: 'install' }],
  ];
  for (const [name, input] of denied) assert.equal((await harness.invoke(name, input)).block, true, name);
  const evidence = await readFile(path.join(prepared.reportRoot, 'guard-evidence.jsonl'), 'utf8');
  assert.match(evidence, /"tool":"bash"/);
  assert.match(evidence, /"callId":"call-/);
  assert.doesNotMatch(evidence, /secretSourceContents|git commit|outside\.txt/);
});

test('fixed report tool enforces exact shape, semantics, digest, limits, and one atomic owner-only report', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  const tool = harness.toolRegistry.get('arc_review_report');
  assert.deepEqual(tool.parameters, ARC_REVIEWER_REPORT_JSON_SCHEMA);
  await assert.rejects(() => tool.execute('before-start', validReport(prepared.digest)), /initialization/i);
  await harness.emit('session_start');
  for (const invalid of [
    { ...validReport(prepared.digest), extra: true },
    { ...validReport(prepared.digest), reviewInputDigest: 'b'.repeat(64) },
    { ...validReport(prepared.digest), summary: 'x'.repeat(64 * 1024 + 1) },
    { ...validReport(prepared.digest), limitations: ['not reviewed'] },
    { ...validReport(prepared.digest), findings: 'none' },
  ]) await assert.rejects(() => tool.execute(`invalid-${++serial}`, invalid), /invalid review report/i);
  const concurrent = await Promise.allSettled([
    tool.execute('valid-a', validReport(prepared.digest)),
    tool.execute('valid-b', validReport(prepared.digest)),
  ]);
  assert.deepEqual(concurrent.map((entry) => entry.status).sort(), ['fulfilled', 'rejected']);
  assert.equal((await lstat(prepared.config.reportPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(prepared.config.reportPath, 'utf8')), validReport(prepared.digest));
  await assert.rejects(() => tool.execute('second', validReport(prepared.digest)), /already submitted/i);
});

test('preexisting acknowledgement/report and tampered source, schema, config, mode, and symlinks fail closed', async (t) => {
  const preexistingAck = await preparedGuard(t);
  await writeFile(preexistingAck.config.acknowledgementPath, 'preserve-me', { mode: 0o600 });
  const loadedAck = await loadGuard(preexistingAck);
  await assert.rejects(() => loadedAck.harness.emit('session_start'), /EEXIST|exist/i);
  assert.equal(await readFile(preexistingAck.config.acknowledgementPath, 'utf8'), 'preserve-me');

  const preexistingReport = await preparedGuard(t);
  await writeFile(preexistingReport.config.reportPath, 'preserve-report', { mode: 0o600 });
  const loadedReport = await loadGuard(preexistingReport);
  await assert.rejects(() => loadedReport.harness.emit('session_start'), /preexisting|exist/i);
  assert.equal(await readFile(preexistingReport.config.reportPath, 'utf8'), 'preserve-report');

  for (const kind of ['source', 'schema', 'config-mode', 'config-extra', 'config-digest', 'schema-symlink', 'runtime-mode']) {
    const prepared = await preparedGuard(t);
    if (kind === 'source') { await chmod(prepared.materialized.extensionPath, 0o600); await writeFile(prepared.materialized.extensionPath, `${await readFile(prepared.materialized.extensionPath, 'utf8')}\n`); await chmod(prepared.materialized.extensionPath, 0o400); }
    if (kind === 'schema') { await chmod(prepared.materialized.reportSchemaPath, 0o600); await writeFile(prepared.materialized.reportSchemaPath, '{}'); await chmod(prepared.materialized.reportSchemaPath, 0o400); }
    if (kind === 'config-mode') await chmod(prepared.materialized.configPath, 0o600);
    if (kind === 'config-extra') { const config = JSON.parse(await readFile(prepared.materialized.configPath, 'utf8')); config.extra = true; await chmod(prepared.materialized.configPath, 0o600); await writeFile(prepared.materialized.configPath, JSON.stringify(config)); await chmod(prepared.materialized.configPath, 0o400); }
    if (kind === 'config-digest') { const config = JSON.parse(await readFile(prepared.materialized.configPath, 'utf8')); config.expectedGuardSourceDigest = '0'.repeat(64); await chmod(prepared.materialized.configPath, 0o600); await writeFile(prepared.materialized.configPath, JSON.stringify(config)); await chmod(prepared.materialized.configPath, 0o400); }
    if (kind === 'schema-symlink') { const target = path.join(prepared.root, 'schema-target'); await copyFile(prepared.materialized.reportSchemaPath, target); await rm(prepared.materialized.reportSchemaPath); await symlink(target, prepared.materialized.reportSchemaPath); }
    if (kind === 'runtime-mode') await chmod(prepared.runtimeRoot, 0o755);
    await assert.rejects(() => loadGuard(prepared), /digest|mode|exactly|regular|canonical|symlink|private/i, kind);
  }
});

test('session startup re-attests config bytes, mode, and canonical root identity before acknowledgement', async (t) => {
  for (const kind of ['config-mode', 'config-bytes', 'input-root-replacement']) {
    await t.test(kind, async (t) => {
      const prepared = await preparedGuard(t);
      const { harness } = await loadGuard(prepared);
      if (kind === 'config-mode') await chmod(prepared.materialized.configPath, 0o600);
      if (kind === 'config-bytes') {
        const bytes = await readFile(prepared.materialized.configPath, 'utf8');
        await chmod(prepared.materialized.configPath, 0o600);
        await writeFile(prepared.materialized.configPath, bytes.replace(prepared.attemptId, `${prepared.attemptId.slice(0, -1)}x`));
        await chmod(prepared.materialized.configPath, 0o400);
      }
      if (kind === 'input-root-replacement') {
        const displaced = `${prepared.inputRoot}-original`;
        await rename(prepared.inputRoot, displaced);
        await mkdir(prepared.inputRoot);
      }
      await assert.rejects(() => harness.emit('session_start'), /changed|mode|identity|config|root/i);
      assert.equal(await exists(prepared.materialized.acknowledgementPath), false);
      assert.equal(harness.emitted.length, 0);
    });
  }
});

test('wrong-owner config metadata is rejected without privileged filesystem changes', async (t) => {
  if (typeof process.getuid !== 'function') return t.skip('ownership is not available on this platform');
  const prepared = await preparedGuard(t);
  await withWrongOwner(prepared.materialized.configPath, async () => {
    await assert.rejects(() => loadGuard(prepared), /wrong owner/i);
  });
});

test('same-size config changes across open/read boundaries fail closed', async (t) => {
  const prepared = await preparedGuard(t);
  const hook = interceptSameSizeChange(prepared.materialized.configPath, (bytes) => Buffer.from(bytes.toString('utf8').replace(prepared.attemptId, `${prepared.attemptId.slice(0, -1)}x`)));
  try {
    await assert.rejects(() => loadGuard(prepared), /changed while reading/i);
    assert.equal(hook.injected, true);
    assert.equal(await exists(prepared.materialized.acknowledgementPath), false);
  } finally {
    hook.restore();
  }
});

test('a blocked call before initialization is recorded and prevents later acknowledgement', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  const result = await harness.invoke('read', { path: await realpath(path.join(prepared.inputRoot, 'source/a.ts')) });
  assert.equal(result.block, true);
  await assert.rejects(() => harness.emit('session_start'), /preexisting|evidence/i);
  assert.equal(await exists(prepared.materialized.acknowledgementPath), false);
  await assert.rejects(() => harness.toolRegistry.get('arc_review_report').execute('after-failure', validReport(prepared.digest)), /not satisfied/i);
});

test('evidence record overflow emits at most one marker and permanently prevents guard satisfaction', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  await harness.emit('session_start');
  for (let index = 0; index < 270; index += 1) await harness.invoke('forbidden', {}, `blocked-${index}`);
  const lines = (await readFile(path.join(prepared.reportRoot, 'guard-evidence.jsonl'), 'utf8')).trim().split('\n');
  assert.ok(lines.length <= 256);
  assert.equal(lines.filter((line) => JSON.parse(line).overflow === true).length, 1);
  await assert.rejects(() => harness.toolRegistry.get('arc_review_report').execute('after-overflow', validReport(prepared.digest)), /not satisfied/i);
});

test('evidence byte overflow is enforced independently before the record cap', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  await harness.emit('session_start');
  const large = '界'.repeat(256);
  for (let index = 0; index < 180; index += 1) await harness.invoke(large, {}, `${large}-${index}`);
  const evidencePath = path.join(prepared.reportRoot, 'guard-evidence.jsonl');
  const bytes = await readFile(evidencePath);
  const lines = bytes.toString('utf8').trim().split('\n');
  assert.ok(bytes.length <= 256 * 1024);
  assert.ok(lines.length < 180, 'byte limit must apply before the 256-record cap');
  assert.equal(lines.filter((line) => JSON.parse(line).overflow === true).length, 1);
  await assert.rejects(() => harness.toolRegistry.get('arc_review_report').execute('after-byte-overflow', validReport(prepared.digest)), /not satisfied/i);
});

test('no-replace publication preserves raced acknowledgement and report destinations', async (t) => {
  for (const channel of ['acknowledgement', 'report']) {
    await t.test(channel, async (t) => {
      const prepared = await preparedGuard(t);
      const { harness } = await loadGuard(prepared);
      const target = channel === 'acknowledgement' ? prepared.config.acknowledgementPath : prepared.config.reportPath;
      if (channel === 'report') await harness.emit('session_start');
      const saved = fsPromises.link;
      let occupant;
      fsPromises.link = async (from, to) => {
        if (to === target) {
          await writeFile(to, 'raced-occupant', { flag: 'wx', mode: 0o600 });
          occupant = await lstat(to);
        }
        return saved(from, to);
      };
      syncBuiltinESMExports();
      try {
        const operation = channel === 'acknowledgement'
          ? () => harness.emit('session_start')
          : () => harness.toolRegistry.get('arc_review_report').execute('race', validReport(prepared.digest));
        await assert.rejects(operation, /publication|exist|failed/i);
        assert.equal((await lstat(target)).ino, occupant.ino);
        assert.equal(await readFile(target, 'utf8'), 'raced-occupant');
        if (channel === 'acknowledgement') assert.equal(harness.emitted.length, 0);
      } finally {
        fsPromises.link = saved;
        syncBuiltinESMExports();
      }
    });
  }
});

test('publication rejects same-content replacement of its temporary source and retains both occupants', async (t) => {
  const prepared = await preparedGuard(t);
  const { harness } = await loadGuard(prepared);
  await harness.emit('session_start');
  const saved = fsPromises.link;
  let held;
  let replacement;
  fsPromises.link = async (from, to) => {
    if (to === prepared.config.reportPath) {
      const bytes = await readFile(from);
      held = `${from}.held`;
      await rename(from, held);
      await writeFile(from, bytes, { flag: 'wx', mode: 0o600 });
      replacement = from;
    }
    return saved(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => harness.toolRegistry.get('arc_review_report').execute('replace-temp', validReport(prepared.digest)),
      /publication|identity|staged|failed/i,
    );
    assert.equal(await exists(held), true);
    assert.equal(await exists(replacement), true);
  } finally {
    fsPromises.link = saved;
    syncBuiltinESMExports();
  }
});

test('actual registered mutation canary is blocked before its callback executes', async (t) => {
  const prepared = await preparedGuard(t);
  const harness = createHarness();
  const canary = await import(`${pathToFileURL(canarySource).href}?case=${++serial}`);
  canary.resetMutationCallbackCalls();
  canary.default(harness.pi);
  const guard = await import(`${pathToFileURL(prepared.materialized.extensionPath).href}?case=${++serial}`);
  await guard.default(harness.pi);
  await harness.emit('session_start');
  const sentinel = path.join(prepared.root, 'mutation-sentinel');
  assert.equal(harness.toolRegistry.has('canary_mutate'), true);
  const result = await harness.dispatchRegisteredTool('canary_mutate', { path: sentinel });
  assert.equal(result.blockedBy, 'review-child');
  assert.equal(canary.mutationCallbackCalls, 0);
  assert.equal(await exists(sentinel), false);
});
