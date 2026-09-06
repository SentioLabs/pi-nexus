import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ARC_REVIEWER_REPORT_JSON_SCHEMA,
  ARC_REVIEW_GUARD_ACK_PREFIX,
  ARC_RUNTIME_REGISTER_EVENT,
  ARC_SUBAGENTS_RPC_REQUEST_EVENT,
} from '../extensions/arc/reports.ts';
import { createArcNativeReviewAdapter } from '../extensions/arc/review-provider.ts';
import { createFakeEventBus } from './fixtures/review/fake-event-bus.mjs';

const RPC_REPLY_PREFIX = 'subagents:rpc:v1:reply:';
const ASYNC_COMPLETE = 'fixture:async-complete';
const PROCESS_TERMINAL = 'fixture:process-terminal';
const READY = 'fixture:ready';
let serial = 0;

async function makeTreeWritable(root) {
  const info = await lstat(root).catch(() => undefined);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeTreeWritable(path.join(root, entry));
  } else if (info.isFile()) await chmod(root, 0o600);
}

function reviewerReport(digest, additions = {}) {
  return {
    schemaVersion: 1,
    reviewInputDigest: digest,
    verdict: 'PASS',
    summary: 'The guarded fixture review passed.',
    findings: [],
    coverage: { reviewedPaths: ['source/a.ts'], reviewedRequirements: ['task'] },
    limitations: [],
    ...additions,
  };
}

async function scenario(t, additions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-native-review-'));
  t.after(async () => { await makeTreeWritable(root); await rm(root, { recursive: true, force: true }); });
  const repositoryRoot = path.join(root, 'checkout');
  const stateDir = path.join(root, 'state');
  const inputRoot = path.join(stateDir, 'input', 'attempt-input');
  const runtimeRoot = path.join(stateDir, 'runtime');
  const reportRoot = path.join(stateDir, 'reports');
  const evidenceRoot = path.join(stateDir, 'evidence');
  const asyncRoot = path.join(root, 'provider-async');
  const sourceRoot = path.join(inputRoot, 'source');
  const materialsRoot = path.join(inputRoot, 'materials');
  await Promise.all([
    mkdir(repositoryRoot), mkdir(sourceRoot, { recursive: true }), mkdir(materialsRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }), mkdir(reportRoot, { recursive: true }), mkdir(evidenceRoot, { recursive: true }), mkdir(asyncRoot),
  ]);
  for (const directory of [stateDir, path.join(stateDir, 'input'), runtimeRoot, reportRoot, evidenceRoot]) await chmod(directory, 0o700);
  const files = {
    manifestPath: path.join(inputRoot, 'manifest.json'),
    diffPath: path.join(materialsRoot, 'diff.patch'),
    guardExtensionPath: path.join(runtimeRoot, 'review-child.ts'),
    guardConfigPath: path.join(runtimeRoot, 'arc-review-guard.json'),
    reportSchemaPath: path.join(runtimeRoot, 'reviewer-schema.json'),
    baselinePath: path.join(evidenceRoot, 'baseline.json'),
    inputDescriptorPath: path.join(evidenceRoot, 'input.json'),
  };
  await Promise.all(Object.values(files).map((file) => writeFile(file, '{}', { mode: 0o400 })));
  await Promise.all([inputRoot, sourceRoot, materialsRoot].map((directory) => chmod(directory, 0o500)));
  const trustedExtension = path.join(root, 'trusted-provider.ts');
  await writeFile(trustedExtension, 'export default () => {};', { mode: 0o400 });
  const attemptId = `attempt-${++serial}`;
  const request = {
    repositoryRoot: await realpath(repositoryRoot),
    taskKey: 'task', scopeKey: 'scope', role: additions.role ?? 'code', adapterSelection: 'native',
    baseSha: '1'.repeat(40), headSha: '2'.repeat(40), reviewedRefs: [],
    taskContext: 'task', designContext: 'design', reviewContext: 'review',
  };
  const executionTimeoutMs = additions.executionTimeoutMs ?? 250;
  const attempt = {
    stateDir: await realpath(stateDir), inputRoot: await realpath(inputRoot), runtimeRoot: await realpath(runtimeRoot), reportRoot: await realpath(reportRoot),
    ...Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [key, await realpath(file)]))),
    guardAcknowledgementPath: path.join(await realpath(reportRoot), 'guard-ack.json'),
    reviewInputDigest: 'a'.repeat(64), baselineDigest: 'b'.repeat(64),
    baselineArtifactDigest: 'c'.repeat(64), inputDescriptorArtifactDigest: 'd'.repeat(64),
    attemptId, repositoryKey: 'repository', request, reservedAt: new Date().toISOString(), attemptNumber: 1,
    effectiveAttemptBudgetMs: executionTimeoutMs + 100,
    executionTimeoutMs,
    dispatchDeadlineAt: new Date(Date.now() + executionTimeoutMs + 100).toISOString(),
  };
  const prompt = {
    systemPrompt: 'You are a fresh read-only Arc reviewer. Use only supplied absolute paths and return the required structured report.',
    task: [
      `Review committed ${request.baseSha}..${request.headSha}.`,
      `Source root (absolute; pass unchanged to tools): ${attempt.inputRoot}/source`,
      `Materials manifest: ${attempt.manifestPath}`,
      'Relative paths are invalid.',
      'Dirty and ignored primary bytes are intentionally excluded.',
      `Return schema version 1 with reviewInputDigest ${attempt.reviewInputDigest}.`,
    ].join('\n'),
  };
  let uuid = 0;
  const options = {
    events: createFakeEventBus(),
    trustedProviderExtensions: additions.trustedProviderExtensions ?? [await realpath(trustedExtension)],
    buildPrompt: () => prompt,
    resolvedModel: additions.resolvedModel ?? 'fixture/model',
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
  };
  return { root, asyncRoot: await realpath(asyncRoot), repositoryRoot, attempt, request, prompt, options };
}

function ping(ownerSessionId = 'owner-session', additions = {}) {
  return {
    version: 1,
    methods: ['spawn', 'status', 'stop', 'resume'],
    capabilities: {
      asyncSpawn: true,
      stop: true,
      runtimeAcknowledgedExtensions: { version: 1, source: 'child-runtime', event: 'subagent:acknowledge-extension' },
      processTerminalProof: { version: 1, lifecycleArtifactVersion: 3 },
    },
    events: { asyncComplete: ASYNC_COMPLETE, processTerminal: PROCESS_TERMINAL, ready: READY, request: ARC_SUBAGENTS_RPC_REQUEST_EVENT, replyPrefix: RPC_REPLY_PREFIX },
    session: { cwd: '/fixture', sessionId: ownerSessionId, sessionFile: '/fixture/parent.jsonl' },
    ...additions,
  };
}

function rpcReply(bus, request, data) {
  bus.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data });
}

function rpcError(bus, request, code, message) {
  bus.emit(`${RPC_REPLY_PREFIX}${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: false, error: { code, message } });
}

function installProvider(value, behavior = {}) {
  const { events } = value.options;
  const calls = { pings: [], registrations: [], spawns: [], stops: [], statuses: [], disposed: 0 };
  let pingIndex = 0;
  const pingValues = behavior.pings ?? [ping(), ping()];
  const offRpc = events.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => {
    if (request.method === 'ping') {
      calls.pings.push(request);
      const answer = pingValues[Math.min(pingIndex++, pingValues.length - 1)];
      if (answer === 'silence') return;
      if (answer === 'rpc-timeout') {
        rpcError(events, request, 'timed_out', 'readiness ping timed out');
        return;
      }
      if (behavior.readyOnPing === pingIndex) events.emit(READY, answer);
      rpcReply(events, request, answer);
      return;
    }
    if (request.method === 'spawn') {
      calls.spawns.push(request);
      if (behavior.onSpawn) return behavior.onSpawn(request, value, calls);
      const runId = `run-${value.attempt.attemptId}`;
      const asyncDir = path.join(value.asyncRoot, runId);
      void mkdir(asyncDir).then(() => {
        rpcReply(events, request, { text: 'diagnostic only', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
      });
      return;
    }
    if (request.method === 'stop') {
      calls.stops.push(request);
      if (behavior.onStop) behavior.onStop(request, value, calls);
      else rpcReply(events, request, { runId: request.params.id, state: 'stopping' });
      return;
    }
    if (request.method === 'status') {
      calls.statuses.push(request);
      rpcReply(events, request, { text: 'diagnostic only', details: { mode: 'single', results: [] } });
    }
  });
  const offRegistration = behavior.noRegistration ? () => {} : events.on(ARC_RUNTIME_REGISTER_EVENT, (request) => {
    calls.registrations.push(request);
    if (behavior.registrationResult === 'collision') request.result = { ok: false, error: new Error('runtime name collision') };
    else if (behavior.registrationResult === 'malformed') request.result = { ok: true, registration: {} };
    else request.result = { ok: true, registration: { dispose() { calls.disposed += 1; } } };
  });
  return { calls, dispose() { offRpc(); offRegistration(); } };
}

function completion(value, runId, additions = {}) {
  return {
    runId,
    id: runId,
    toolCallId: additions.toolCallId ?? additions.expectedToolCallId,
    sessionId: additions.sessionId ?? 'owner-session',
    mode: 'single', state: 'complete', success: true,
    results: [{ success: true, structuredOutput: reviewerReport(value.attempt.reviewInputDigest) }],
    runtimeAcknowledgedExtensions: { version: 1, source: 'child-runtime', ids: ['unrelated-extension', `${ARC_REVIEW_GUARD_ACK_PREFIX}${value.attempt.attemptId}`], omitted: 0 },
    ...Object.fromEntries(Object.entries(additions).filter(([key]) => !['expectedToolCallId', 'toolCallId', 'sessionId'].includes(key))),
  };
}

function proof(runId, runnerProcessInstanceId = `runner-${runId}`, additions = {}) {
  const observedAt = Date.now();
  return {
    version: 1, runId, runnerProcessInstanceId, state: 'observed', observedAt,
    instances: [{ kind: 'runner', processInstanceId: runnerProcessInstanceId, closeObservedAt: observedAt, exitCode: 0, signal: null }],
    ...additions,
  };
}

function observer(overrides = {}) {
  const calls = [];
  return {
    calls,
    async persistBeforeDispatch(value) { calls.push({ kind: 'before-dispatch', value: structuredClone(value) }); return overrides.before?.(value); },
    async persistDispatchReceipt(value) { calls.push({ kind: 'dispatch-receipt', value: structuredClone(value) }); return overrides.receipt?.(value, calls.filter((x) => x.kind === 'dispatch-receipt').length); },
    async persistObservedTermination(value) { calls.push({ kind: 'observed-termination', value: structuredClone(value) }); return overrides.termination?.(value); },
    progress(message) { calls.push({ kind: 'progress', value: message }); },
  };
}

async function preflight(adapter, value) {
  return adapter.preflight({ request: value.request, preparation: value.attempt });
}

async function successfulExecution(t, eventOrder) {
  const value = await scenario(t);
  let registration;
  const provider = installProvider(value, {
    readyOnPing: 1,
    onSpawn(request) {
      const runId = `run-${value.attempt.attemptId}`;
      const asyncDir = path.join(value.asyncRoot, runId);
      return mkdir(asyncDir).then(() => {
        const terminal = proof(runId);
        const complete = completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` });
        for (const kind of eventOrder) value.options.events.emit(kind === 'proof' ? PROCESS_TERMINAL : ASYNC_COMPLETE, kind === 'proof' ? terminal : complete);
        const spawnData = { text: 'diagnostic only', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } };
        assert.equal('sessionId' in spawnData.details, false);
        assert.equal('runnerProcessInstanceId' in spawnData.details, false);
        rpcReply(value.options.events, request, spawnData);
      });
    },
  });
  const capture = value.options.events.on(ARC_RUNTIME_REGISTER_EVENT, (request) => { registration = structuredClone({ version: request.version, name: request.name, definition: request.definition }); });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const observed = observer();
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observed);
  capture();
  provider.dispose();
  return { value, adapter, provider, registration, observed, execution };
}

test('preflight requires two matching current public pings; ready is corroborating only', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value, { readyOnPing: 1 });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  assert.equal(provider.calls.pings.length, 2);
  assert.equal(provider.calls.registrations.length, 0);
  assert.equal(provider.calls.spawns.length, 0);
  provider.dispose();
});

test('preflight classifies malformed/inconsistent pings as ambiguous and missing capabilities as incompatible', async (t) => {
  const cases = [
    ['changed owner', [ping('owner-a'), ping('owner-b')], 'ambiguous', /matching|owner|changed/i],
    ['changed capability', [ping(), ping('owner-session', { capabilities: { ...ping().capabilities, stop: false } })], 'ambiguous', /matching|changed/i],
    ['malformed', [null, null], 'ambiguous', /malformed|ping/i],
    ['timed out', ['rpc-timeout'], 'ambiguous', /timed out/i],
    ['missing capability', [ping('owner-session', { capabilities: { ...ping().capabilities, asyncSpawn: false } }), ping('owner-session', { capabilities: { ...ping().capabilities, asyncSpawn: false } })], 'incompatible', /async|capability/i],
    ['missing owner', [ping('owner-session', { session: {} }), ping('owner-session', { session: {} })], 'ambiguous', /owner|session/i],
    ['nested events only', [ping('owner-session', { events: {}, capabilities: { ...ping().capabilities, events: ping().events } }), ping('owner-session', { events: {}, capabilities: { ...ping().capabilities, events: ping().events } })], 'incompatible', /event/i],
  ];
  for (const [name, pings, classification, reason] of cases) {
    await t.test(name, async (t) => {
      const value = await scenario(t);
      const provider = installProvider(value, { pings });
      const adapter = createArcNativeReviewAdapter(value.options);
      const result = await preflight(adapter, value);
      assert.equal(result.ok, false);
      assert.equal(result.classification, classification);
      assert.match(result.reason, reason);
      assert.equal(provider.calls.spawns.length, 0);
      provider.dispose();
    });
  }
});

test('completion-first and proof-first early events persist monotonic exact identity before success', async (t) => {
  for (const order of [['completion', 'proof'], ['proof', 'completion']]) {
    await t.test(order.join('-'), async (t) => {
      const { value, provider, registration, observed, execution } = await successfulExecution(t, order);
      assert.equal(execution.lifecycle, 'succeeded');
      assert.equal(execution.termination.status, 'observed');
      const durableCalls = observed.calls.filter((x) => x.kind !== 'progress');
      assert.deepEqual(durableCalls.map((x) => x.kind), [
        'before-dispatch', 'dispatch-receipt', 'dispatch-receipt', 'observed-termination',
      ]);
      const spawn = provider.calls.spawns[0];
      assert.equal(durableCalls[0].value.requestId, spawn.requestId);
      assert.equal(durableCalls[0].value.ownerSessionId, 'owner-session');
      assert.equal('childSessionId' in durableCalls[0].value, false);
      assert.equal(durableCalls[1].value.identity.runId, execution.identity.runId);
      assert.equal('runnerProcessInstanceId' in durableCalls[1].value.identity, false);
      assert.equal('childSessionId' in durableCalls[1].value.identity, false);
      assert.equal(durableCalls[2].value.dispatchedAt, durableCalls[1].value.dispatchedAt);
      assert.equal(durableCalls[2].value.receivedAt, durableCalls[1].value.receivedAt);
      assert.equal(durableCalls[2].value.identity.ownerSessionId, 'owner-session');
      assert.equal(durableCalls[2].value.identity.runnerProcessInstanceId, execution.termination.runnerProcessInstanceId);
      assert.equal(provider.calls.disposed, 1);
      assert.equal(value.options.events.listenerCount(ASYNC_COMPLETE), 0);
      assert.equal(value.options.events.listenerCount(PROCESS_TERMINAL), 0);
      assert.equal(registration.name, durableCalls[0].value.privateAgentName);
      assert.equal('name' in registration.definition, false);
      assert.deepEqual(registration.definition, {
        description: `Private guarded Arc code reviewer for ${value.attempt.attemptId}`,
        systemPrompt: value.prompt.systemPrompt,
        model: 'fixture/model',
        tools: ['read', 'grep', 'find', 'ls'],
        systemPromptMode: 'replace', inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
        defaultContext: 'fresh', allowNestedSubagents: false, maxSubagentDepth: 0,
        extensions: [], subagentOnlyExtensions: [value.attempt.guardExtensionPath, ...value.options.trustedProviderExtensions],
        defaultTimeoutMs: value.attempt.executionTimeoutMs, completionGuard: false,
      });
      assert.deepEqual(spawn.params, {
        agent: observed.calls[0].value.privateAgentName, task: value.prompt.task, cwd: value.attempt.runtimeRoot,
        context: 'fresh', async: true, timeoutMs: value.attempt.executionTimeoutMs,
        outputSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA,
      });
    });
  }
});

test('wrong and duplicate public events are ignored while exact duplicates remain idempotent', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value, { onSpawn(request) {
    const runId = `run-${value.attempt.attemptId}`;
    const asyncDir = path.join(value.asyncRoot, runId);
    return mkdir(asyncDir).then(() => {
      const exactCompletion = completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` });
      const exactProof = proof(runId);
      value.options.events.emit(ASYNC_COMPLETE, completion(value, 'wrong-run', { expectedToolCallId: `rpc-spawn-${request.requestId}` }));
      value.options.events.emit(ASYNC_COMPLETE, completion(value, runId, { expectedToolCallId: 'rpc-spawn-wrong' }));
      value.options.events.emit(PROCESS_TERMINAL, proof('wrong-run'));
      value.options.events.emit(ASYNC_COMPLETE, exactCompletion);
      value.options.events.emit(ASYNC_COMPLETE, structuredClone(exactCompletion));
      value.options.events.emit(PROCESS_TERMINAL, exactProof);
      value.options.events.emit(PROCESS_TERMINAL, structuredClone(exactProof));
      rpcReply(value.options.events, request, { text: 'ignored', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
    });
  } });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const observed = observer();
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observed);
  assert.equal(execution.lifecycle, 'succeeded');
  assert.equal(observed.calls.filter((x) => x.kind === 'dispatch-receipt').length, 2);
  assert.equal(observed.calls.filter((x) => x.kind === 'observed-termination').length, 1);
  provider.dispose();
});

test('conflicting, child-scoped, and malformed root proof fail closed', async (t) => {
  for (const mode of ['conflict', 'child', 'missing-runner']) {
    await t.test(mode, async (t) => {
      const value = await scenario(t);
      const provider = installProvider(value, { onSpawn(request) {
        const runId = `run-${value.attempt.attemptId}`;
        const asyncDir = path.join(value.asyncRoot, runId);
        return mkdir(asyncDir).then(() => {
          value.options.events.emit(ASYNC_COMPLETE, completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` }));
          const terminal = mode === 'child'
            ? proof(runId, 'runner-a', { childIndex: 0 })
            : mode === 'missing-runner'
              ? proof(runId, 'runner-a', { instances: [] })
              : proof(runId, 'runner-a');
          value.options.events.emit(PROCESS_TERMINAL, terminal);
          if (mode === 'conflict') value.options.events.emit(PROCESS_TERMINAL, proof(runId, 'runner-b'));
          rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
        });
      } });
      const adapter = createArcNativeReviewAdapter(value.options);
      assert.deepEqual(await preflight(adapter, value), { ok: true });
      const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
      assert.notEqual(execution.lifecycle, 'succeeded');
      assert.equal(execution.termination.status, 'unknown');
      assert.match(execution.boundedDiagnostics.join('\n'), /conflict|child|proof/i);
      assert.equal(provider.calls.disposed, 0, 'unresolved proof retains registration');
      provider.dispose();
    });
  }
});

test('terminal success still rejects stopped/paused/failed/malformed output and missing guard acknowledgement', async (t) => {
  const cases = [
    ['stopped', { state: 'stopped', success: false, stopped: true }, 'provider_lost'],
    ['paused', { state: 'paused', success: false }, 'provider_lost'],
    ['failed', { state: 'failed', success: false }, 'provider_lost'],
    ['wrong owner', { ownerSessionId: 'foreign-owner' }, 'provider_lost'],
    ['malformed report', { results: [{ success: true, structuredOutput: { schemaVersion: 9 } }] }, 'malformed_report'],
    ['missing ack', { runtimeAcknowledgedExtensions: { version: 1, source: 'child-runtime', ids: ['unrelated'], omitted: 0 } }, 'guard_failed'],
  ];
  for (const [name, completionAdditions, lifecycle] of cases) {
    await t.test(name, async (t) => {
      const value = await scenario(t);
      const provider = installProvider(value, { onSpawn(request) {
        const runId = `run-${value.attempt.attemptId}`;
        const asyncDir = path.join(value.asyncRoot, runId);
        return mkdir(asyncDir).then(() => {
          value.options.events.emit(ASYNC_COMPLETE, completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}`, ...completionAdditions }));
          value.options.events.emit(PROCESS_TERMINAL, proof(runId));
          rpcReply(value.options.events, request, { text: 'not parsed', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
        });
      } });
      const adapter = createArcNativeReviewAdapter(value.options);
      assert.deepEqual(await preflight(adapter, value), { ok: true });
      const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
      assert.equal(execution.lifecycle, lifecycle);
      assert.equal(execution.termination.status, 'observed');
      assert.equal(execution.structuredReport, undefined);
      assert.equal(provider.calls.disposed, 1);
      provider.dispose();
    });
  }
});

test('registration provider loss, collision, malformed handle, spawn rejection, timeout, and malformed receipt never retry spawn', async (t) => {
  const cases = [
    ['provider loss', { noRegistration: true }, 'provider_lost', 0],
    ['collision', { registrationResult: 'collision' }, 'provider_lost', 0],
    ['malformed registration', { registrationResult: 'malformed' }, 'provider_lost', 0],
    ['spawn rejection', { onSpawn(request, value) { rpcError(value.options.events, request, 'launch_rejected', 'rejected'); } }, 'spawn_failed', 1],
    ['malformed receipt', { onSpawn(request, value) { rpcReply(value.options.events, request, { text: 'x', details: { mode: 'single', runId: 'a', asyncId: 'b', asyncDir: value.asyncRoot, results: [] } }); } }, 'provider_lost', 1],
    ['spawn silence', { onSpawn() {} }, 'provider_lost', 1],
  ];
  for (const [name, behavior, lifecycle, spawnCount] of cases) {
    await t.test(name, async (t) => {
      const value = await scenario(t, { executionTimeoutMs: name === 'spawn silence' ? 25 : 100 });
      const provider = installProvider(value, behavior);
      const adapter = createArcNativeReviewAdapter(value.options);
      assert.deepEqual(await preflight(adapter, value), { ok: true });
      const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
      assert.equal(execution.lifecycle, lifecycle);
      assert.equal(provider.calls.spawns.length, spawnCount);
      assert.equal(execution.termination.status, spawnCount ? (name === 'spawn rejection' ? 'not_applicable' : 'unknown') : 'not_applicable');
      await assert.rejects(() => adapter.execute(value.attempt, new AbortController().signal, observer()), /already|attempted|execute/i);
      assert.equal(provider.calls.spawns.length, spawnCount);
      provider.dispose();
    });
  }
});

test('timeout requests exact stop and persists process proof emitted during the bounded stop window', async (t) => {
  const value = await scenario(t, { executionTimeoutMs: 25 });
  const runId = `run-${value.attempt.attemptId}`;
  const provider = installProvider(value, {
    onSpawn(request) {
      const asyncDir = path.join(value.asyncRoot, runId);
      return mkdir(asyncDir).then(() => rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } }));
    },
    onStop(request) {
      value.options.events.emit(PROCESS_TERMINAL, proof(runId));
      rpcReply(value.options.events, request, { runId, state: 'stopping' });
    },
  });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const observed = observer();
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observed);
  assert.equal(execution.lifecycle, 'timed_out');
  assert.equal(execution.termination.status, 'observed');
  assert.equal(provider.calls.stops.length, 1);
  assert.deepEqual(observed.calls.filter((entry) => entry.kind !== 'progress').map((entry) => entry.kind), [
    'before-dispatch', 'dispatch-receipt', 'dispatch-receipt', 'observed-termination',
  ]);
  assert.equal(provider.calls.disposed, 1);
  provider.dispose();
});

test('invalid or unknown exact terminal proof cannot be inferred from successful completion', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value, { onSpawn(request) {
    const runId = `run-${value.attempt.attemptId}`;
    const asyncDir = path.join(value.asyncRoot, runId);
    return mkdir(asyncDir).then(() => {
      value.options.events.emit(ASYNC_COMPLETE, completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` }));
      value.options.events.emit(PROCESS_TERMINAL, { version: 1, runId, runnerProcessInstanceId: 'runner', state: 'unknown', reason: 'observer-unavailable' });
      rpcReply(value.options.events, request, { text: 'Status: complete; PID absent', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
    });
  } });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
  assert.equal(execution.lifecycle, 'provider_lost');
  assert.equal(execution.termination.status, 'unknown');
  assert.equal(execution.structuredReport, undefined);
  assert.equal(provider.calls.disposed, 0);
  provider.dispose();
});

test('abort bounds pending before-dispatch persistence and prevents registration or spawn', async (t) => {
  const value = await scenario(t, { executionTimeoutMs: 100 });
  const provider = installProvider(value);
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const controller = new AbortController();
  const pending = adapter.execute(value.attempt, controller.signal, observer({ before: () => new Promise(() => {}) }));
  setTimeout(() => controller.abort(new Error('fixture abort')), 10);
  const execution = await pending;
  assert.equal(execution.lifecycle, 'cancelled');
  assert.equal(execution.termination.status, 'not_applicable');
  assert.equal(provider.calls.registrations.length, 0);
  assert.equal(provider.calls.spawns.length, 0);
  assert.equal(value.options.events.listenerCount(ASYNC_COMPLETE), 0);
  assert.equal(value.options.events.listenerCount(PROCESS_TERMINAL), 0);
  provider.dispose();
});

test('terminal refinement and termination persistence failures stop the exact run and never succeed', async (t) => {
  for (const stage of ['refinement', 'termination']) {
    await t.test(stage, async (t) => {
      const value = await scenario(t);
      const provider = installProvider(value, { onSpawn(request) {
        const runId = `run-${value.attempt.attemptId}`;
        const asyncDir = path.join(value.asyncRoot, runId);
        return mkdir(asyncDir).then(() => {
          value.options.events.emit(ASYNC_COMPLETE, completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` }));
          value.options.events.emit(PROCESS_TERMINAL, proof(runId));
          rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
        });
      } });
      const adapter = createArcNativeReviewAdapter(value.options);
      assert.deepEqual(await preflight(adapter, value), { ok: true });
      const observed = observer({
        receipt(_value, count) { if (stage === 'refinement' && count === 2) throw new Error('refinement persistence failed'); },
        termination() { if (stage === 'termination') throw new Error('termination persistence failed'); },
      });
      const execution = await adapter.execute(value.attempt, new AbortController().signal, observed);
      assert.equal(execution.lifecycle, 'guard_failed');
      assert.equal(execution.termination.status, 'observed');
      assert.equal(provider.calls.stops.length, 1);
      assert.equal(provider.calls.stops[0].params.id, execution.identity.runId);
      assert.equal(provider.calls.disposed, 0, 'durably unresolved terminal handoff retains only its own registration');
      provider.dispose();
    });
  }
});

test('receipt persistence failure requests bounded exact stop with an independent request ID', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value, { onSpawn(request) {
    const runId = `run-${value.attempt.attemptId}`;
    const asyncDir = path.join(value.asyncRoot, runId);
    return mkdir(asyncDir).then(() => rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } }));
  } });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observer({ receipt() { throw new Error('durable receipt failed'); } }));
  assert.notEqual(execution.lifecycle, 'succeeded');
  assert.equal(provider.calls.stops.length, 1);
  assert.equal(provider.calls.stops[0].params.id, execution.identity.runId);
  assert.notEqual(provider.calls.stops[0].requestId, provider.calls.spawns[0].requestId);
  assert.match(execution.boundedDiagnostics.join('\n'), /receipt|persist|durable/i);
  provider.dispose();
});

test('stop targets only an exact known run and never reuses the spawn request ID', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value);
  const adapter = createArcNativeReviewAdapter(value.options);
  const identity = { adapter: 'native', attemptId: value.attempt.attemptId, requestId: '00000000-0000-4000-8000-000000000099', runId: 'exact-run' };
  await adapter.stop(value.attempt, identity);
  assert.equal(provider.calls.stops.length, 1);
  assert.deepEqual(provider.calls.stops[0].params, { id: 'exact-run' });
  assert.notEqual(provider.calls.stops[0].requestId, identity.requestId);
  await adapter.stop(value.attempt, { ...identity, runId: undefined });
  await adapter.stop(value.attempt, { ...identity, attemptId: 'foreign-attempt' });
  await adapter.stop(value.attempt, { ...identity, adapter: 'standalone' });
  assert.equal(provider.calls.stops.length, 1);
  provider.dispose();
});

test('unsafe trusted extensions, unsafe returned async paths, and invalid prompts fail closed', async (t) => {
  await t.test('writable trusted extension', async (t) => {
    const value = await scenario(t);
    await chmod(value.options.trustedProviderExtensions[0], 0o600);
    const provider = installProvider(value);
    const result = await preflight(createArcNativeReviewAdapter(value.options), value);
    assert.equal(result.ok, false);
    assert.equal(result.classification, 'incompatible');
    assert.match(result.reason, /read-only|writ/i);
    provider.dispose();
  });
  await t.test('async directory in checkout', async (t) => {
    const value = await scenario(t);
    const provider = installProvider(value, { onSpawn(request) {
      rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId: 'unsafe', asyncId: 'unsafe', asyncDir: value.repositoryRoot, results: [] } });
    } });
    const adapter = createArcNativeReviewAdapter(value.options);
    assert.deepEqual(await preflight(adapter, value), { ok: true });
    const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
    assert.equal(execution.lifecycle, 'provider_lost');
    assert.match(execution.boundedDiagnostics.join('\n'), /checkout|input|path|async/i);
    provider.dispose();
  });
  await t.test('completion output path inside immutable input', async (t) => {
    const value = await scenario(t);
    const provider = installProvider(value, { onSpawn(request) {
      const runId = `run-${value.attempt.attemptId}`;
      const asyncDir = path.join(value.asyncRoot, runId);
      return mkdir(asyncDir).then(() => {
        const payload = completion(value, runId, { expectedToolCallId: `rpc-spawn-${request.requestId}` });
        payload.results[0].structuredOutputPath = value.attempt.manifestPath;
        value.options.events.emit(ASYNC_COMPLETE, payload);
        value.options.events.emit(PROCESS_TERMINAL, proof(runId));
        rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
      });
    } });
    const adapter = createArcNativeReviewAdapter(value.options);
    assert.deepEqual(await preflight(adapter, value), { ok: true });
    const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
    assert.equal(execution.lifecycle, 'guard_failed');
    assert.equal(execution.termination.status, 'observed');
    provider.dispose();
  });
  await t.test('relative-path prompt', async (t) => {
    const value = await scenario(t);
    value.options.buildPrompt = () => ({ systemPrompt: 'review', task: 'Read source/a.ts' });
    const provider = installProvider(value);
    const adapter = createArcNativeReviewAdapter(value.options);
    assert.deepEqual(await preflight(adapter, value), { ok: true });
    const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
    assert.equal(execution.lifecycle, 'provider_lost');
    assert.equal(provider.calls.registrations.length, 0);
    assert.equal(provider.calls.spawns.length, 0);
    provider.dispose();
  });
});

test('bounded early-event overflow fails closed and retains unresolved registration', async (t) => {
  const value = await scenario(t);
  const provider = installProvider(value, { onSpawn(request) {
    const runId = `run-${value.attempt.attemptId}`;
    const asyncDir = path.join(value.asyncRoot, runId);
    return mkdir(asyncDir).then(() => {
      for (let index = 0; index < 129; index += 1) value.options.events.emit(ASYNC_COMPLETE, { runId: `noise-${index}`, index });
      rpcReply(value.options.events, request, { text: '', details: { mode: 'single', runId, asyncId: runId, asyncDir, results: [] } });
    });
  } });
  const adapter = createArcNativeReviewAdapter(value.options);
  assert.deepEqual(await preflight(adapter, value), { ok: true });
  const execution = await adapter.execute(value.attempt, new AbortController().signal, observer());
  assert.equal(execution.lifecycle, 'provider_lost');
  assert.equal(execution.termination.status, 'unknown');
  assert.match(execution.boundedDiagnostics.join('\n'), /128|buffer/i);
  assert.equal(provider.calls.spawns.length, 1);
  assert.equal(provider.calls.disposed, 0);
  provider.dispose();
});
