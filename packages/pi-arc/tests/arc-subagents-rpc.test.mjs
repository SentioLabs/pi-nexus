import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARC_SUBAGENTS_RPC_REQUEST_EVENT,
} from '../extensions/arc/reports.ts';
import { createArcSubagentsRpcClient } from '../extensions/arc/subagents-rpc.ts';
import { createFakeEventBus } from './fixtures/review/fake-event-bus.mjs';

const replyPrefix = 'subagents:rpc:v1:reply:';
const ids = {
  one: '00000000-0000-4000-8000-000000000001',
  two: '00000000-0000-4000-8000-000000000002',
  three: '00000000-0000-4000-8000-000000000003',
};

function validPing(overrides = {}) {
  return {
    version: 1,
    methods: ['spawn', 'status', 'stop', 'resume'],
    capabilities: {
      asyncSpawn: true,
      stop: true,
      runtimeAcknowledgedExtensions: { version: 1, source: 'child-runtime', event: 'subagent:acknowledge-extension' },
      processTerminalProof: { version: 1, lifecycleArtifactVersion: 3 },
    },
    events: {
      ready: 'subagents:rpc:v1:ready',
      request: ARC_SUBAGENTS_RPC_REQUEST_EVENT,
      replyPrefix,
      asyncComplete: 'subagent:async-complete',
      processTerminal: 'subagent:process-terminal',
    },
    session: { cwd: '/tmp/project', sessionId: 'owner-session', sessionFile: null },
    ...overrides,
  };
}

function reply(bus, request, data, additions = {}) {
  bus.emit(`${replyPrefix}${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    method: request.method,
    success: true,
    data,
    ...additions,
  });
}

test('request preserves the caller durable ID, listens before synchronous emit, and accepts the first exact reply', async () => {
  const bus = createFakeEventBus();
  const seen = [];
  bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => {
    seen.push(structuredClone(request));
    reply(bus, request, { accepted: true });
    reply(bus, request, { accepted: false });
  });
  const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
  const result = await client.request(ids.one, 'spawn', { async: true });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(seen, [{ version: 1, requestId: ids.one, method: 'spawn', params: { async: true } }]);
  assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
  client.dispose();
});

test('delayed replies ignore wrong request IDs and malformed/duplicate envelopes, then clean up', async () => {
  const bus = createFakeEventBus();
  bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => {
    queueMicrotask(() => {
      bus.emit(`${replyPrefix}${request.requestId}`, { version: 1, requestId: ids.two, method: request.method, success: true, data: 'wrong' });
      bus.emit(`${replyPrefix}${request.requestId}`, { version: 1, requestId: request.requestId, method: 'status', success: true, data: 'wrong-method' });
      reply(bus, request, 'right');
      reply(bus, request, 'duplicate');
    });
  });
  const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
  assert.equal(await client.request(ids.one, 'spawn', {}), 'right');
  assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
  client.dispose();
});

test('error replies reject with provider details and remove the listener', async () => {
  const bus = createFakeEventBus();
  bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => {
    bus.emit(`${replyPrefix}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: false,
      error: { code: 'collision', message: 'name already exists' },
    });
  });
  const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
  await assert.rejects(() => client.request(ids.one, 'spawn', {}), /collision.*name already exists/i);
  assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
  client.dispose();
});

test('timeout, abort, invalid UUID, and disposal fail bounded requests with listener cleanup', async (t) => {
  await t.test('timeout', async () => {
    const bus = createFakeEventBus();
    const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 15 });
    await assert.rejects(() => client.request(ids.one, 'status', {}), /timed out/i);
    assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
    client.dispose();
  });
  await t.test('abort', async () => {
    const bus = createFakeEventBus();
    const controller = new AbortController();
    const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
    const pending = client.request(ids.one, 'status', {}, controller.signal);
    controller.abort(new Error('caller stopped'));
    await assert.rejects(() => pending, /aborted|caller stopped/i);
    assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
    client.dispose();
  });
  await t.test('dispose', async () => {
    const bus = createFakeEventBus();
    const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
    const pending = client.request(ids.one, 'status', {});
    client.dispose();
    await assert.rejects(() => pending, /disposed/i);
    assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
    await assert.rejects(() => client.request(ids.two, 'status', {}), /disposed/i);
  });
  await t.test('invalid UUID', async () => {
    const bus = createFakeEventBus();
    const client = createArcSubagentsRpcClient({ events: bus });
    await assert.rejects(() => client.request('../reply', 'status', {}), /UUID/i);
    assert.equal(bus.listenerCount(`${replyPrefix}../reply`), 0);
    client.dispose();
  });
});

test('ping generates a UUID, validates the public top-level events projection, and returns a detached value', async () => {
  const bus = createFakeEventBus();
  bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => reply(bus, request, validPing()));
  const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100, randomUUID: () => ids.three });
  const ping = await client.ping();
  assert.equal(ping.events.asyncComplete, 'subagent:async-complete');
  assert.equal(ping.session.sessionId, 'owner-session');
  ping.methods.push('mutated');
  const second = await client.ping();
  assert.equal(second.methods.includes('mutated'), false);
  client.dispose();
});

test('ping rejects malformed payloads and capabilities.events cannot replace top-level events', async (t) => {
  const malformed = [
    null,
    { version: 2, methods: [], capabilities: {}, events: {} },
    { version: 1, methods: ['spawn'], capabilities: {}, events: null },
    { version: 1, methods: ['spawn'], capabilities: { events: validPing().events } },
    { ...validPing(), methods: ['spawn', 4] },
  ];
  for (const [index, value] of malformed.entries()) {
    await t.test(String(index), async () => {
      const bus = createFakeEventBus();
      bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => reply(bus, request, value));
      const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100, randomUUID: () => ids.one });
      await assert.rejects(() => client.ping(), /malformed|ping|version|events|methods/i);
      client.dispose();
    });
  }
});

test('RPC success data is structurally bounded before cloning and always cleans its listener', async (t) => {
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 80; index += 1) cursor = cursor.next = {};
  const cyclic = {};
  cyclic.self = cyclic;
  const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, index]));
  let getterReads = 0;
  const oversized = { payload: 'x'.repeat(1024 * 1024 + 1) };
  Object.defineProperty(oversized, 'mustNotRead', { enumerable: true, get() { getterReads += 1; return 'unsafe'; } });

  for (const [name, data] of [['deep', deep], ['cyclic', cyclic], ['wide', wide], ['oversized', oversized]]) {
    await t.test(name, async () => {
      const bus = createFakeEventBus();
      bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => reply(bus, request, data));
      const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
      await assert.rejects(() => client.request(ids.one, 'spawn', {}), /bound|structur|cycle|depth|count|size|payload|plain|clone|accessor/i);
      assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
      client.dispose();
    });
  }
  assert.equal(getterReads, 0, 'oversized payload must fail before clone/accessor evaluation');
});

test('RPC error details and every ping string projection are bounded', async (t) => {
  await t.test('oversized error', async () => {
    const bus = createFakeEventBus();
    bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => {
      bus.emit(`${replyPrefix}${request.requestId}`, {
        version: 1, requestId: request.requestId, method: request.method, success: false,
        error: { code: 'x'.repeat(5000), message: 'message' },
      });
    });
    const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100 });
    await assert.rejects(() => client.request(ids.one, 'spawn', {}), /malformed|bound|error/i);
    assert.equal(bus.listenerCount(`${replyPrefix}${ids.one}`), 0);
    client.dispose();
  });

  for (const [name, mutate] of [
    ['method', (value) => { value.methods[0] = 'x'.repeat(5000); }],
    ['sessionFile', (value) => { value.session.sessionFile = 'x'.repeat(5000); }],
  ]) {
    await t.test(name, async () => {
      const bus = createFakeEventBus();
      const value = validPing();
      mutate(value);
      bus.on(ARC_SUBAGENTS_RPC_REQUEST_EVENT, (request) => reply(bus, request, value));
      const client = createArcSubagentsRpcClient({ events: bus, requestTimeoutMs: 100, randomUUID: () => ids.one });
      await assert.rejects(() => client.ping(), /malformed|bound|method|sessionFile|payload/i);
      client.dispose();
    });
  }
});
