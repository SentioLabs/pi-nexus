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

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `expected section ${start} ... ${end}`);
  return source.slice(startIndex, endIndex);
}

function swapMarkers(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex, 'expected ordered markers before mutation');
  return source.slice(0, firstIndex)
    + second
    + source.slice(firstIndex + first.length, secondIndex)
    + first
    + source.slice(secondIndex + second.length);
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

test('native worktree guidance never promises automatic cleanup', () => {
  const build = read('skills/arc-build/SKILL.md');
  assert.match(build, /native retention\/cleanup facts/i);
  assert.doesNotMatch(build, /cleans up temporary worktrees|automatically (?:deletes|cleans)(?: up)? (?:temporary )?worktrees/i);
});

test('single-child flow sections use their exact Arc specialist and prompt', () => {
  const review = section(read('skills/arc-review/SKILL.md'), '### 3. Dispatch Reviewer', '### 4. Triage Feedback');
  assert.match(review, /subagent\(\{ agent: "arc-code-reviewer", task: "<filled reviewer prompt>", context: "fresh", async: true \}\);/);
  assert.doesNotMatch(review, /agent: "arc-builder"/);

  const plan = section(read('skills/arc-plan/SKILL.md'), 'Then dispatch the manifest', '```markdown');
  assert.match(plan, /subagent\(\{ agent: "arc-issue-manager", task: "<filled manifest metadata and canonical file paths>", context: "fresh", async: true \}\);/);
  assert.doesNotMatch(plan, /agent: "arc-builder"/);
  assert.doesNotMatch(plan, /agent: "arc-issue-manager"[^}\n]*model:/);
  assert.equal((plan.match(/Use this task payload for whichever dispatcher you choose:/g) ?? []).length, 1);
  assert.match(plan, /Use this task payload for whichever dispatcher you choose:\n\n$/);
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

test('issue-manager persistence phases remain ordered and the check detects a true swap', () => {
  const plan = section(read('skills/arc-plan/SKILL.md'), 'Issue creation must be phased:', 'Then dispatch the manifest');
  const phases = [
    'Create the epic first',
    'Create all child tasks',
    'Apply dependencies only after all child IDs exist',
    'Apply labels after dependencies',
    'Verify descriptions',
  ];
  assertOrdered(plan, phases);
  const reordered = swapMarkers(plan, phases[0], phases[1]);
  for (const phase of phases) {
    assert.equal(reordered.split(phase).length - 1, 1, `mutation must preserve ${phase} exactly once`);
  }
  assert.throws(() => assertOrdered(reordered, phases), /expected/);
});

test('parent delivery gates keep fresh parent verification before spec, code, and closure', () => {
  const build = section(read('skills/arc-build/SKILL.md'), '### 4. Evaluate Result', '### 8. Integration Checkpoint');
  const stages = [
    'run the project test command fresh yourself',
    '### 5. Spec Compliance Review',
    '### 6. Code Quality Review',
    '### 7. Close Task',
  ];
  assertOrdered(build, stages);
  const reordered = swapMarkers(build, stages[0], stages[1]);
  for (const stage of stages) {
    assert.equal(reordered.split(stage).length - 1, 1, `mutation must preserve ${stage} exactly once`);
  }
  assert.throws(() => assertOrdered(reordered, stages), /expected/);
});

test('dispatch receipts and specialist prose cannot satisfy native completion gates', () => {
  const combined = paths.map(read).join('\n');
  const build = read('skills/arc-build/SKILL.md');
  assert.match(combined, /native completion/i);
  assert.match(combined, /receipt cannot advance/i);
  assert.match(combined, /failure, pause, stop, incomplete or malformed result blocks/i);
  assert.match(combined, /regardless of successful prose/i);
  assert.match(combined, /outputReference|outputPathMapping|artifactPaths/);
  assert.match(build, /After native completion confirms successful terminal runtime state[^\n]+interpret the completed Arc specialist report/i);
  assert.doesNotMatch(build, /dispatch returns one of four terminal statuses/i);
});

test('repair guidance uses native resumability or steering while keeping reviews fresh', () => {
  const build = read('skills/arc-build/SKILL.md');
  assert.match(build, /resumab/i);
  assert.match(build, /subagent\(\{ action: "resume", id: "<native-run-id>", message: "<specific verified fixes>" \}\)/);
  assert.match(build, /live child.*native steering/i);
  assert.match(build, /Reviews remain fresh independent Arc specialist runs/);
  assert.match(build, /explicit same-protocol fresh attempt/i);
});
