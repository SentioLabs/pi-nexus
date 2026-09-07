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
  assert.ok(results.every((result) => result.ok === true));
  assert.ok(results.every((result) => typeof result.outputReference === 'string'));
  assert.ok(results.every((result) => Array.isArray(result.artifactPaths)));
  assert.ok(results.every((result) => result.artifactPaths.every((path) => typeof path === 'string')));
  assert.ok(results.every((result) => exactHandoffManifestPaths(result).length === 1));
}

function nativeResult(key, request = {}) {
  const runId = `${key}-run`;
  const artifactPaths = request.async === false
    ? [
        `/native/outputs/${key}.md`,
        `/native/sessions/${runId}.jsonl`,
        `/native/handoffs/${runId}.json`,
      ]
    : [
        `/native/async/${runId}`,
        `/native/async/${runId}/output.md`,
        `/native/async/${runId}/session.jsonl`,
      ];
  return {
    key,
    ok: true,
    outputReference: request.async === false
      ? `/native/outputs/${key}.md`
      : `/native/async/${runId}/output.md`,
    artifactPaths,
  };
}

function exactHandoffManifestPaths(result) {
  return result.artifactPaths.filter((path) => /\/handoffs\/[^/]+\.json$/.test(path));
}

function handoffManifestMatchesBase(manifest, baseCommit) {
  return Boolean(
    manifest
      && typeof manifest === 'object'
      && !Array.isArray(manifest)
      && manifest.version === 1
      && Array.isArray(manifest.groups)
      && manifest.groups.length > 0
      && manifest.groups.every((group) => (
        group
        && typeof group === 'object'
        && typeof group.baseCommit === 'string'
        && group.baseCommit.length > 0
        && group.baseCommit === baseCommit
      )),
  );
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
  assert.match(
    review,
    /workflowScript: `return await runs.run\("code-review", \{\s*agent: "arc-code-reviewer",\s*task: "<filled immutable review prompt>",\s*worktree: true,\s*async: false,\s*output: "code-review\.md"\s*\}\);`/,
  );
  assert.match(review, /context: "fresh",\s*async: true,\s*globalConcurrencyLimit: 1,\s*baseRef: "HEAD"/);
  assert.doesNotMatch(review, /agent: "arc-builder"/);

  const plan = section(read('skills/arc-plan/SKILL.md'), 'Then dispatch the manifest', '```markdown');
  assert.match(plan, /subagent\(\{ agent: "arc-issue-manager", task: "<filled manifest metadata and canonical file paths>", context: "fresh", async: true \}\);/);
  assert.doesNotMatch(plan, /agent: "arc-builder"/);
  assert.doesNotMatch(plan, /agent: "arc-issue-manager"[^}\n]*model:/);
  assert.equal((plan.match(/Use this task payload for whichever dispatcher you choose:/g) ?? []).length, 1);
  assert.match(plan, /Use this task payload for whichever dispatcher you choose:\n\n$/);
});

test('documented workflowScript bodies execute and retain realistic native handoffs', async () => {
  const build = read('skills/arc-build/SKILL.md');
  const scripts = workflowScripts(build);
  const expectedSingle = {
    'spec-review': {
      agent: 'arc-spec-reviewer',
      output: 'spec-review.md',
    },
    evaluate: {
      agent: 'arc-evaluator',
      output: 'evaluator.md',
    },
  };
  const seenSingleKeys = [];
  assert.ok(scripts.length >= 3, 'expected spec-review, evaluator, and coordinated-wave workflowScript examples');

  for (const script of scripts) {
    const seen = [];
    const runs = {
      run(key, item) {
        seen.push([key, item]);
        return Promise.resolve(nativeResult(key, item));
      },
      all(items) {
        seen.push(...items.map((item) => [item.key, item]));
        return Promise.resolve(items.map((item) => nativeResult(item.key, item)));
      },
    };
    const result = await new AsyncFunction('runs', script)(runs);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(([, item]) => item.worktree === true));
    assert.ok(seen.every(([, item]) => item.async === false), 'every awaited inner child must be foreground');
    assert.ok(result);

    if (seen.length > 1) {
      const requests = seen.map(([, item]) => item);
      assert.equal(new Set(requests.map((item) => item.key)).size, requests.length);
      assert.ok(requests.every((item) => typeof item.output === 'string' && item.output.length > 0));
      assert.ok(Array.isArray(result), 'parallel workflow must return the complete runs.all array');
      assertCompleteOrderedHandoffs(requests, result);
    } else {
      const [key, request] = seen[0];
      const expected = expectedSingle[key];
      seenSingleKeys.push(key);
      assert.ok(expected, `unexpected single-child workflow ${key}`);
      assert.equal(request.agent, expected.agent);
      assert.equal(request.output, expected.output);
      assert.equal(typeof request.task, 'string');
      assert.ok(request.task.length > 0);
      assert.equal(result.ok, true);
      assert.equal(result.outputReference, `/native/outputs/${key}.md`);
      assert.deepEqual(result.artifactPaths, [
        `/native/outputs/${key}.md`,
        `/native/sessions/${key}-run.jsonl`,
        `/native/handoffs/${key}-run.json`,
      ]);
    }
  }

  assert.deepEqual(
    seenSingleKeys.sort(),
    ['evaluate', 'spec-review'],
  );
});

test('outer workflow calls retain a full-SHA evidence anchor but launch from symbolic HEAD', () => {
  const build = read('skills/arc-build/SKILL.md');
  const outerSections = [
    {
      source: section(build, '#### One native isolated reviewer', '#### Terminal evidence before prose'),
      baseVariable: 'REVIEW_BASE',
    },
    {
      source: section(build, '### 6.5. High-Risk Evaluation (Optional)', 'Triage evaluator findings:'),
      baseVariable: 'PARALLEL_BASE',
    },
    {
      source: section(build, '### P4. Dispatch with `pi-subagents`', '### P5. Apply and Verify Patches One at a Time'),
      baseVariable: 'PARALLEL_BASE',
    },
  ];

  for (const { source: outerSection, baseVariable } of outerSections) {
    assert.match(
      outerSection,
      new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = "\\$${baseVariable}"[\\s\\S]*?subagent\\(\\{`),
    );
    assert.deepEqual(
      [...outerSection.matchAll(/baseRef:\s*([^,\r\n]+)/g)].map((match) => match[1].trim()),
      ['"HEAD"'],
      'outer call must use only the supported literal symbolic ref',
    );
    assert.match(outerSection, /symbolic `HEAD`.*resolved at (?:worktree )?allocation/i);
    assert.doesNotMatch(outerSection, /baseRef:\s*["'][a-f0-9]{40,64}["']/i);
    assert.equal((outerSection.match(/\basync:\s*true/g) ?? []).length, 1, 'outer workflow must remain async');
    assert.match(outerSection, /context: "fresh", async: true/);
    assert.match(outerSection, /outer workflow remains asynchronous[\s\S]*awaited inner foreground child/i);
  }
  assert.equal(
    (build.match(/baseRef: "HEAD"/g) ?? []).length,
    outerSections.length,
    'every and only expected outer workflow must use literal symbolic HEAD',
  );
});

test('explicit inner foreground mode exposes the exact native handoff path while default async does not', () => {
  const foreground = nativeResult('build-a', { async: false });
  const defaultAsync = nativeResult('build-a');

  assert.deepEqual(exactHandoffManifestPaths(foreground), ['/native/handoffs/build-a-run.json']);
  assert.deepEqual(exactHandoffManifestPaths(defaultAsync), []);
  assert.equal(defaultAsync.outputReference, '/native/async/build-a-run/output.md');
  assert.match(defaultAsync.artifactPaths[0], /\/async\/build-a-run$/);
  assert.ok(defaultAsync.artifactPaths.some((path) => path.endsWith('/output.md')));
  assert.ok(defaultAsync.artifactPaths.some((path) => path.endsWith('/session.jsonl')));
});

test('handoff manifest base predicate rejects missing, empty, and mismatched baseCommit evidence', () => {
  const baseCommit = 'a'.repeat(40);
  const valid = {
    version: 1,
    groups: [{ baseCommit }, { baseCommit }],
  };

  assert.equal(handoffManifestMatchesBase(valid, baseCommit), true);
  assert.equal(handoffManifestMatchesBase(undefined, baseCommit), false, 'missing manifest');
  assert.equal(handoffManifestMatchesBase({ version: 1, groups: 'malformed' }, baseCommit), false, 'malformed groups');
  assert.equal(handoffManifestMatchesBase({ version: 1, groups: [] }, baseCommit), false, 'empty groups');
  assert.equal(handoffManifestMatchesBase({ version: 1, groups: [{}] }, baseCommit), false, 'missing baseCommit');
  assert.equal(handoffManifestMatchesBase({ version: 1, groups: [{ baseCommit: '' }] }, baseCommit), false, 'empty baseCommit');
  assert.equal(
    handoffManifestMatchesBase({ version: 1, groups: [{ baseCommit }, { baseCommit: 'b'.repeat(40) }] }, baseCommit),
    false,
    'any mismatched group must fail',
  );
});

test('returned handoff manifests gate evaluator findings and parallel patch application', () => {
  const build = read('skills/arc-build/SKILL.md');
  const flows = [
    {
      text: section(build, '### 6.5. High-Risk Evaluation (Optional)', 'Triage evaluator findings:'),
      acceptance: /before accepting or triaging evaluator findings/i,
      relevantResults: /completed evaluator child result's string-array `artifactPaths`/i,
    },
    {
      text: section(build, '### P4. Dispatch with `pi-subagents`', '### P5. Apply and Verify Patches One at a Time'),
      acceptance: /before inspecting or applying any parallel patch/i,
      relevantResults: /every relevant child result's string-array `artifactPaths`/i,
    },
  ];
  const jqPredicate = '\'.version == 1 and (.groups | type == "array") and (.groups | length > 0) and all(.groups[]; (.baseCommit | type == "string") and (.baseCommit | length > 0) and .baseCommit == $base)\'';

  for (const flow of flows) {
    assertOrdered(flow.text, ['subagent({', 'HANDOFF_MANIFEST', 'jq -e --arg base "$PARALLEL_BASE"']);
    assert.match(flow.text, flow.acceptance);
    assert.match(flow.text, flow.relevantResults);
    assert.match(flow.text, /actual returned path ending in `handoffs\/<run-id>\.json`/i);
    assert.match(flow.text, /test -n "\$HANDOFF_MANIFEST" && test -r "\$HANDOFF_MANIFEST"/);
    assert.ok(flow.text.includes(jqPredicate), 'must validate version, nonempty groups, and every baseCommit');
    assert.match(flow.text, /missing, unreadable, malformed, empty, or mismatched/i);
    assert.match(flow.text, /blocks (?:evaluator finding|patch) acceptance[\s\S]*explicit native inspection\/recovery/i);
    assert.match(flow.text, /not permission to apply, retry or switch modes/i);
    assert.match(flow.text, /never fabricate or infer base identity from current `HEAD`/i);
  }
});

test('ordered-handoff contract rejects dropped and reordered results', () => {
  const requests = [{ key: 'a' }, { key: 'b' }, { key: 'docs' }];
  const results = requests.map(({ key }) => nativeResult(key, { async: false }));
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

test('every BLOCKED escalation site applies the complete classification-first rule', () => {
  const build = read('skills/arc-build/SKILL.md');
  const blockedEscalationLines = build.split('\n').filter((line) => (
    /BLOCKED/i.test(line) && /escalat|model(?: selection)?|tier/i.test(line)
  ));

  assert.ok(blockedEscalationLines.length >= 4, 'expected implementer, evaluator, status-table, and final-rule sites');
  for (const line of blockedEscalationLines) {
    assert.match(line, /classif(?:y|ication)[^\r\n]*verified reasoning-limit/i);
    assert.match(line, /Infrastructure(?: or |\/)tooling[^\r\n]*same-protocol[^\r\n]*without model escalation/i);
    assert.match(line, /context[^\r\n]*scope[^\r\n]*plan/i);
  }

  const implementer = section(build, '**On `BLOCKED` or `NEEDS_CONTEXT`:**', '**If the subagent did not include a Status field**');
  assert.match(implementer, /For `BLOCKED`:[^\r\n]*classif(?:y|ication)[^\r\n]*verified reasoning-limit/i);
  const evaluator = section(build, 'Triage evaluator findings:', '### 7. Close Task');
  assert.match(evaluator, /\| `BLOCKED` \|[^\r\n]*classif(?:y|ication)[^\r\n]*verified reasoning-limit/i);
});

test('code review retrieves design context directly without a stale step cross-reference', () => {
  const build = read('skills/arc-build/SKILL.md');
  const codeReview = section(build, '### 6. Code Quality Review', '### 6.5. High-Risk Evaluation (Optional)');
  assert.doesNotMatch(build, /per step 3's design-context block/i);
  assert.match(codeReview, /`\{DESIGN_EXCERPT\}`[^\r\n]*`arc show <parent-epic-id>`[^\r\n]*"none"/i);
});
