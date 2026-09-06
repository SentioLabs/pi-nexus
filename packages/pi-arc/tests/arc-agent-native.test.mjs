import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { dispatchArcSubagent } from '../extensions/arc/native-dispatch.ts';
import { ARC_PI_SUBAGENTS } from '../extensions/arc/subagents.ts';

function endpoint(answer) {
  const emitter = new EventEmitter();
  const requests = [];
  const events = {
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn); },
    emit(name, value) { emitter.emit(name, value); },
  };
  emitter.on('subagents:rpc:v1:request', request => {
    requests.push(request);
    answer?.(request, events);
  });
  return { events, requests, emitter };
}

function reply(events, request, data = {}) {
  events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
    version: 1,
    requestId: request.requestId,
    success: true,
    data: {
      text: 'Started',
      details: { runId: `run-${request.requestId}` },
      ...data,
    },
  });
}

const intent = { agent: 'arc-builder', task: 'Inspect only', cwd: '/tmp/arc-native-fixture' };

const arcSource = readFileSync(new URL('../extensions/arc.ts', import.meta.url), 'utf8');
const helperSource = readFileSync(new URL('../extensions/arc/native-dispatch.ts', import.meta.url), 'utf8');

test('one dispatch returns native receipt without waiting for completion', async () => {
  const details = {
    runId: 'native-1',
    asyncId: 'native-1',
    asyncDir: '/native/run',
    outputReference: { path: '/opaque/native/handoff' },
    futureField: { retained: true },
  };
  const bus = endpoint((request, events) => reply(events, request, { text: 'DONE is native receipt text, not a completion signal', details }));

  const result = await dispatchArcSubagent(bus.events, true, intent);

  assert.equal(bus.requests.length, 1);
  assert.deepEqual(bus.requests[0], {
    version: 1,
    requestId: result.requestId,
    method: 'spawn',
    params: {
      agent: 'arc-builder',
      task: 'Inspect only',
      cwd: intent.cwd,
      context: 'fresh',
      async: true,
    },
  });
  assert.equal(result.text, 'DONE is native receipt text, not a completion signal');
  assert.equal(result.details, details);
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${result.requestId}`), 0);

  reply(bus.events, bus.requests[0], { text: 'late duplicate', details: { runId: 'duplicate' } });
  assert.equal(bus.requests.length, 1);
});

test('disabled or missing tool prevents submission', async () => {
  const bus = endpoint();

  await assert.rejects(dispatchArcSubagent(bus.events, false, intent), /pi-subagents/);
  assert.equal(bus.requests.length, 0);
});

test('all seven Arc mappings dispatch one corresponding native agent and preserve selected models', async () => {
  assert.equal(ARC_PI_SUBAGENTS.length, 7);

  for (const [index, mapping] of ARC_PI_SUBAGENTS.entries()) {
    const selectedModel = index === 0 ? 'provider/explicit-model:xhigh' : `provider/${mapping.profileKey}:thinking`;
    const bus = endpoint((request, events) => reply(events, request));

    await dispatchArcSubagent(bus.events, true, {
      agent: mapping.target,
      task: `Task for ${mapping.source}`,
      cwd: intent.cwd,
      model: selectedModel,
    });

    assert.equal(bus.requests.length, 1, mapping.source);
    assert.deepEqual(bus.requests[0].params, {
      agent: mapping.target,
      task: `Task for ${mapping.source}`,
      model: selectedModel,
      cwd: intent.cwd,
      context: 'fresh',
      async: true,
    });
  }
});

test('concurrent dispatches consume only correlated replies in reverse order', async () => {
  const bus = endpoint();
  const first = dispatchArcSubagent(bus.events, true, { ...intent, task: 'first' });
  const second = dispatchArcSubagent(bus.events, true, { ...intent, task: 'second' });
  const [firstRequest, secondRequest] = bus.requests;

  assert.equal(bus.requests.length, 2);
  bus.events.emit(`subagents:rpc:v1:reply:${firstRequest.requestId}`, {
    version: 1,
    requestId: secondRequest.requestId,
    success: true,
    data: { text: 'wrong channel', details: { runId: 'wrong' } },
  });
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${firstRequest.requestId}`), 1);

  reply(bus.events, secondRequest, { text: 'second receipt', details: { runId: 'second-run' } });
  const secondResult = await second;
  assert.equal(secondResult.text, 'second receipt');
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${secondRequest.requestId}`), 0);

  reply(bus.events, firstRequest, { text: 'first receipt', details: { runId: 'first-run' } });
  const firstResult = await first;
  assert.equal(firstResult.text, 'first receipt');
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${firstRequest.requestId}`), 0);
  assert.equal(bus.requests.length, 2);
});

test('worktree dispatch uses one fixed keyed native workflow and keeps hostile strings as data', async () => {
  const maliciousLookingTask = 'Review "quotes", `backticks`, and this newline:\nthrow new Error("must remain text")';
  const selectedModel = 'provider/model:`quoted`:thinking';
  const hostileCwd = '/tmp/path with "quotes"/`ticks`/\nthrow new Error("cwd stays data")';
  const bus = endpoint((request, events) => reply(events, request));

  await dispatchArcSubagent(bus.events, true, {
    agent: 'arc-builder',
    task: maliciousLookingTask,
    model: selectedModel,
    cwd: hostileCwd,
    worktree: true,
  });

  assert.equal(bus.requests.length, 1);
  const request = bus.requests[0];
  const expectedChild = {
    agent: 'arc-builder',
    task: maliciousLookingTask,
    model: selectedModel,
    worktree: true,
  };
  assert.deepEqual(request.params, {
    workflowScript: `return await runs.run("arc-agent", ${JSON.stringify(expectedChild)});`,
    cwd: hostileCwd,
    context: 'fresh',
    async: true,
  });

  const calls = [];
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const execute = new AsyncFunction('runs', request.params.workflowScript);
  await execute({
    run(key, child) {
      calls.push([key, child]);
      return Promise.resolve({ outputReference: { path: '/native/handoff' } });
    },
  });
  assert.deepEqual(calls, [['arc-agent', expectedChild]]);
});

test('omitted and false worktree isolation use structured single-child requests', async () => {
  const task = '"task"\n`script-looking ${value}`';
  const model = 'provider/"model"`suffix`';
  const cwd = '/tmp/"cwd"/`literal`';

  for (const worktree of [undefined, false]) {
    const bus = endpoint((request, events) => reply(events, request));
    await dispatchArcSubagent(bus.events, true, {
      agent: 'arc-evaluator',
      task,
      model,
      cwd,
      ...(worktree === false ? { worktree } : {}),
    });

    assert.equal(bus.requests.length, 1);
    assert.deepEqual(bus.requests[0].params, {
      agent: 'arc-evaluator',
      task,
      model,
      cwd,
      context: 'fresh',
      async: true,
    });
    assert.equal('workflowScript' in bus.requests[0].params, false);
  }
});

test('an already-aborted dispatch emits no request', async () => {
  const controller = new AbortController();
  controller.abort();
  const bus = endpoint();

  await assert.rejects(
    dispatchArcSubagent(bus.events, true, intent, controller.signal),
    /cancelled before submission; no request emitted/,
  );
  assert.equal(bus.requests.length, 0);
});

test('abort during reply wait cleans up without relaunching or claiming child stop', async () => {
  const controller = new AbortController();
  const bus = endpoint();
  const pending = dispatchArcSubagent(bus.events, true, intent, controller.signal, 1_000);
  const request = bus.requests[0];

  controller.abort();

  await assert.rejects(pending, error => {
    assert.match(error.message, /not a child-stop acknowledgement/);
    assert.match(error.message, new RegExp(request.requestId));
    assert.match(error.message, /Submission occurred; launch outcome may be unknown/);
    assert.match(error.message, /Do not retry automatically/);
    return true;
  });
  assert.equal(bus.requests.length, 1);
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${request.requestId}`), 0);
});

test('native spawn errors retain request identity and never trigger fallback', async t => {
  const errors = [
    ['invalid_params', 'Missing or disabled specialist arc-missing'],
    ['invalid_params', 'Specialist arc-builder is disabled'],
    ['execution_failed', 'Native launch failed'],
  ];

  for (const [code, message] of errors) {
    await t.test(`${code}: ${message}`, async () => {
      const bus = endpoint((request, events) => events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: false,
        error: { code, message },
      }));
      const pending = dispatchArcSubagent(bus.events, true, intent);
      const request = bus.requests[0];

      await assert.rejects(pending, error => {
        assert.match(error.message, new RegExp(`Native spawn failed \\(${code}\\): ${message}`));
        assert.match(error.message, new RegExp(request.requestId));
        assert.match(error.message, /Submission occurred; launch outcome may be unknown/);
        assert.doesNotMatch(error.message, /No request was emitted/);
        return true;
      });
      assert.equal(bus.requests.length, 1);
      assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${request.requestId}`), 0);
    });
  }
});

test('malformed consumed reply fields fail once and clean up listeners', async t => {
  const validData = { text: 'Started', details: { runId: 'native-run' } };
  const cases = [
    ['wrong version', request => ({ version: 2, requestId: request.requestId, success: true, data: validData }), /Malformed native dispatch reply/],
    ['missing success', request => ({ version: 1, requestId: request.requestId, data: validData }), /Malformed native dispatch reply/],
    ['missing data', request => ({ version: 1, requestId: request.requestId, success: true }), /receipt missing or malformed/],
    ['tool error success', request => ({ version: 1, requestId: request.requestId, success: true, data: { ...validData, isError: true } }), /receipt missing or malformed/],
    ['non-string text', request => ({ version: 1, requestId: request.requestId, success: true, data: { ...validData, text: 7 } }), /receipt missing or malformed/],
    ['non-record details', request => ({ version: 1, requestId: request.requestId, success: true, data: { ...validData, details: '/native/run' } }), /receipt missing or malformed/],
    ['non-string run id', request => ({ version: 1, requestId: request.requestId, success: true, data: { ...validData, details: { runId: 7 } } }), /receipt missing or malformed/],
    ['blank run id', request => ({ version: 1, requestId: request.requestId, success: true, data: { ...validData, details: { runId: '   ' } } }), /receipt missing or malformed/],
    ['malformed native error', request => ({ version: 1, requestId: request.requestId, success: false, error: 'opaque' }), /Native spawn failed \(unknown\): No error detail/],
  ];

  for (const [name, makePayload, expected] of cases) {
    await t.test(name, async () => {
      const bus = endpoint((request, events) => events.emit(`subagents:rpc:v1:reply:${request.requestId}`, makePayload(request)));
      const pending = dispatchArcSubagent(bus.events, true, intent);
      const request = bus.requests[0];

      await assert.rejects(pending, error => {
        assert.match(error.message, expected);
        assert.match(error.message, new RegExp(request.requestId));
        return true;
      });
      assert.equal(bus.requests.length, 1);
      assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${request.requestId}`), 0);
    });
  }
});

test('missing reply times out with uncertain-launch diagnostics and cleanup', async () => {
  const bus = endpoint();
  const pending = dispatchArcSubagent(bus.events, true, intent, undefined, 5);
  const request = bus.requests[0];

  await assert.rejects(pending, error => {
    assert.match(error.message, /No compatible dispatch reply before the deadline/);
    assert.match(error.message, new RegExp(request.requestId));
    assert.match(error.message, /Submission occurred; launch outcome may be unknown/);
    assert.match(error.message, /Do not retry automatically/);
    return true;
  });
  assert.equal(bus.requests.length, 1);
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${request.requestId}`), 0);
});

test('thrown request emission settles once with conservative diagnostics and cleanup', async () => {
  const bus = endpoint(() => {
    throw new Error('event transport exploded');
  });
  const pending = dispatchArcSubagent(bus.events, true, intent, undefined, 1_000);
  const request = bus.requests[0];

  await assert.rejects(pending, error => {
    assert.match(error.message, /Native request emission failed: event transport exploded/);
    assert.match(error.message, new RegExp(request.requestId));
    assert.match(error.message, /Submission occurred; launch outcome may be unknown/);
    return true;
  });
  assert.equal(bus.requests.length, 1);
  assert.equal(bus.emitter.listenerCount(`subagents:rpc:v1:reply:${request.requestId}`), 0);
});

test('opaque native details and unknown fields are retained without path access', async () => {
  let unknownFieldReads = 0;
  const details = {
    runId: 'opaque-run',
    asyncId: 'opaque-async',
    asyncDir: '../../../../must-not-be-read',
    outputReference: { path: '/not/a/client-readable/result' },
  };
  Object.defineProperty(details, 'futureField', {
    enumerable: true,
    get() {
      unknownFieldReads += 1;
      throw new Error('unknown fields must not be traversed');
    },
  });
  const bus = endpoint((request, events) => reply(events, request, {
    details,
    futureDataField: { ignored: true },
  }));

  const result = await dispatchArcSubagent(bus.events, true, intent);

  assert.equal(result.details, details);
  assert.equal(unknownFieldReads, 0);
  assert.doesNotMatch(helperSource, /node:fs|readFile|statSync|accessSync/);
});

test('arc extension wires model resolution and native dispatch without the Pi runner', () => {
  assert.match(arcSource, /resolveArcModelForAgent/);
  assert.match(arcSource, /ARC_PI_SUBAGENTS/);
  assert.match(arcSource, /dispatchArcSubagent/);
  assert.match(arcSource, /getActiveTools/);
  assert.doesNotMatch(arcSource, /runPiSubprocess|spawn\(["']pi["']/);
  assert.match(arcSource, /runArcWithStdin/);
  assert.match(arcSource, /spawn\("arc"/);
  assert.match(arcSource, /materializeArcSubagentsForContext/);
});

test('arc_agent guidance describes the native async-only boundary', () => {
  assert.match(arcSource, /requires[^.]*pi-subagents/i);
  assert.match(arcSource, /one asynchronous specialist/i);
  assert.match(arcSource, /dispatch receipt, not task completion/i);
  assert.match(arcSource, /native workflows[^.]*coordinated waves/i);
  assert.match(arcSource, /no fallback/i);
  assert.match(arcSource, /automatic retry/i);
  assert.match(arcSource, /provider owns missing-agent and disabled-capability errors/i);
  assert.match(arcSource, /inactive[^.]*fails locally before submission/i);
  assert.match(arcSource, /native status\/stop/i);
  assert.match(arcSource, /one-child-only/i);
  assert.match(arcSource, /isolation[^.]*worktree[^.]*native/i);
});

test('native dispatch helper remains a thin public event-bus client', () => {
  assert.match(helperSource, /subagents:rpc:v1:request/);
  assert.match(helperSource, /subagents:rpc:v1:reply:/);
  assert.match(helperSource, /method: "spawn"/);
  assert.doesNotMatch(helperSource, /pi-subagents\/src|review-provider|subagents-rpc|node:child_process|spawn\(|exec\(|asyncComplete|DONE/);
});
