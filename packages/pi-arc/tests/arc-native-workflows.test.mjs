import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

const paths = [
  'skills/arc-build/SKILL.md',
  'skills/arc-plan/SKILL.md',
  'skills/arc-review/SKILL.md',
  'skills/arc/SKILL.md',
];

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function workflowScripts(markdown) {
  return [...markdown.matchAll(/workflowScript:\s*`([\s\S]*?)`/g)].map((match) => match[1]);
}

function assertOrdered(source, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `expected ${JSON.stringify(marker)} after prior stage`);
    cursor = next;
  }
}

function assertCompleteOrderedHandoffs(requests, results) {
  assert.deepEqual(results.map((result) => result.key), requests.map((request) => request.key));
  assert.ok(results.every((result) => result.outputReference?.path));
}

test('Arc workflow guidance removes obsolete execution inputs and ordinary polling', () => {
  for (const path of paths) {
    const text = read(path);
    assert.doesNotMatch(text, /clarify\s*:\s*false/);
    assert.doesNotMatch(text, /subagent\(\{\s*tasks\s*:/);
    assert.doesNotMatch(text, /poll(?:ing)?\s+(?:it|with|`subagent)/i);
  }
});

test('delegated Arc flows require the enabled native provider without an independent runner fallback', () => {
  const combined = paths.map(read).join('\n');
  assert.match(combined, /requires loaded, enabled `?pi-subagents`?/i);
  assert.match(combined, /subagent\(\{ action: "list", capabilities: true \}\)/);
  assert.match(combined, /same provider/i);
  assert.match(combined, /stop with setup guidance/i);
  assert.doesNotMatch(combined, /arc_agent[^\n]*(?:self-contained|works without `?pi-subagents`?|if `?pi-subagents`? is unavailable)/i);
});

test('documented workflowScript bodies execute and retain ordered native handoffs', async () => {
  const build = read('skills/arc-build/SKILL.md');
  const scripts = workflowScripts(build);
  assert.ok(scripts.length >= 2, 'expected evaluator and coordinated-wave workflowScript examples');

  for (const script of scripts) {
    const seen = [];
    const runs = {
      run(key, item) {
        seen.push([key, item]);
        return Promise.resolve({ key, outputReference: { path: `/native/${key}` } });
      },
      all(items) {
        seen.push(...items.map((item) => [item.key, item]));
        return Promise.resolve(items.map((item) => ({ key: item.key, outputReference: { path: `/native/${item.key}` } })));
      },
    };
    const result = await new AsyncFunction('runs', script)(runs);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(([, item]) => item.worktree === true));
    assert.ok(result);

    if (seen.length > 1) {
      const requests = seen.map(([, item]) => item);
      assert.equal(new Set(requests.map((item) => item.key)).size, requests.length);
      assert.ok(requests.every((item) => typeof item.output === 'string' && item.output.length > 0));
      assert.ok(Array.isArray(result), 'parallel workflow must return the complete runs.all array');
      assertCompleteOrderedHandoffs(requests, result);
    } else {
      assert.equal(seen[0][1].output, 'evaluator.md');
      assert.equal(result.outputReference.path, '/native/evaluate');
    }
  }
});

test('ordered-handoff contract rejects dropped and reordered results', () => {
  const requests = [{ key: 'a' }, { key: 'b' }, { key: 'docs' }];
  const results = requests.map(({ key }) => ({ key, outputReference: { path: `/native/${key}` } }));
  assert.doesNotThrow(() => assertCompleteOrderedHandoffs(requests, results));
  assert.throws(() => assertCompleteOrderedHandoffs(requests, results.slice(1)), /deep-equal/);
  assert.throws(() => assertCompleteOrderedHandoffs(requests, [results[1], results[0], results[2]]), /deep-equal/);
});

test('issue-manager persistence phases remain ordered and the check detects reordering', () => {
  const plan = read('skills/arc-plan/SKILL.md');
  const phases = [
    'Create the epic first',
    'Create all child tasks',
    'Apply dependencies only after all child IDs exist',
    'Apply labels after dependencies',
    'Verify descriptions',
  ];
  assertOrdered(plan, phases);
  assert.throws(
    () => assertOrdered(plan.replace(phases[1], 'Create all child tasks').replace(phases[0], phases[1]), phases),
    /expected/,
  );
});

test('parent delivery gates remain tests then spec review then code review then close', () => {
  const build = read('skills/arc-build/SKILL.md');
  const stages = [
    '### 4. Evaluate Result',
    '### 5. Spec Compliance Review',
    '### 6. Code Quality Review',
    '### 7. Close Task',
  ];
  assertOrdered(build, stages);
  const reordered = build.replace(stages[1], '__SPEC__').replace(stages[2], stages[1]).replace('__SPEC__', stages[2]);
  assert.throws(() => assertOrdered(reordered, stages), /expected/);
});

test('dispatch receipts and specialist prose cannot satisfy native completion gates', () => {
  const combined = paths.map(read).join('\n');
  assert.match(combined, /native completion/i);
  assert.match(combined, /receipt cannot advance/i);
  assert.match(combined, /failure, pause, stop, incomplete or malformed result blocks/i);
  assert.match(combined, /regardless of successful prose/i);
  assert.match(combined, /outputReference|outputPathMapping|artifactPaths/);
});

test('repair guidance uses native resumability or steering while keeping reviews fresh', () => {
  const build = read('skills/arc-build/SKILL.md');
  assert.match(build, /resumab/i);
  assert.match(build, /subagent\(\{ action: "resume", id: "<native-run-id>", message: "<specific verified fixes>" \}\)/);
  assert.match(build, /live child.*native steering/i);
  assert.match(build, /Reviews remain fresh independent Arc specialist runs/);
  assert.match(build, /explicit same-protocol fresh attempt/i);
});
