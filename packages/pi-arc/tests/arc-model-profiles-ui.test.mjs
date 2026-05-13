import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

function extractConstBlock(source, constName, stopToken) {
  const start = source.indexOf(`const ${constName}`);
  assert.notEqual(start, -1, `missing ${constName}`);
  const end = source.indexOf(stopToken, start);
  assert.notEqual(end, -1, `missing stop token ${stopToken}`);
  return source.slice(start, end);
}

const EXPECTED_RECOMMENDATIONS = [
  ['brainstorm', 'gpt-5.5', 'high', 'design exploration and architecture judgment'],
  ['plan', 'gpt-5.5', 'high', 'task breakdown and sequencing'],
  ['issueManager', 'gpt-5.4-mini', 'off', 'Arc CLI formatting and issue updates'],
  ['builder', 'gpt-5.3-codex', 'medium', 'implementation and code navigation'],
  ['codeReviewer', 'gpt-5.5', 'high', 'review judgment and risk detection'],
  ['docWriter', 'gpt-5.4-mini', 'low', 'documentation prose and light reasoning'],
  ['specReviewer', 'gpt-5.5', 'high', 'spec compliance and ambiguity detection'],
  ['evaluator', 'gpt-5.5', 'high', 'adversarial validation'],
];

const ALLOWED_RECOMMENDED_MODEL_IDS = new Set(['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex']);

test('arc model profiles UI exports the editor entrypoint and section-style labels', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /openArcModelProfilesEditor/);
  assert.match(source, /Arc Model Profiles/);
  assert.match(source, /Config:/);
  assert.match(source, /Setup:/);
  assert.match(source, /Available:/);
  assert.match(source, /selected:/);
  assert.match(source, /thinking:/);
  assert.match(source, /recommended:/);
  assert.match(source, /reason:/);
  assert.match(source, /status:/);
  assert.match(source, /\[m\]odel/);
  assert.match(source, /\[t\]hinking/);
  assert.match(source, /\[r\]ecommended/);
  assert.match(source, /\[d\]isable/);
  assert.match(source, /\[s\]ave/);
});

test('arc model profiles UI uses centered overlay options', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /ctx\.ui\.custom/);
  assert.match(source, /overlay:\s*true/);
  assert.match(source, /anchor:\s*"center"/);
  assert.match(source, /width:\s*84/);
  assert.match(source, /maxHeight:\s*"80%"/);
});

test('arc model profiles UI constrains profile rows to a cursor-following viewport', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /const maxVisibleProfiles = 3/);
  assert.match(source, /this\.cursor - Math\.floor\(maxVisibleProfiles \/ 2\)/);
  assert.match(source, /rows\.length - maxVisibleProfiles/);
  assert.match(source, /↑ \$\{start\} more/);
  assert.match(source, /↓ \$\{rows\.length - end\} more/);
});

test('arc model profiles UI renders readable blocks with independent truncated detail lines', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /: this\.theme\.fg\("dim", profile\.label\)/);
  assert.match(source, /profileDetailLines/);
  assert.match(source, /truncateToWidth\(value\.replace\(\/\[\\r\\n\]\+\/g, " "\), width\)/);
  assert.match(source, /selected \? content : this\.theme\.fg\("dim", content\)/);
  assert.doesNotMatch(source, /model: \$\{pad\(model, valueWidth\)\} thinking: \$\{pad\(thinking, 10\)\} status:/);
});

test('arc model profiles UI uses exact allowed profile recommendations', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  const block = extractConstBlock(source, 'PROFILE_RECOMMENDATIONS', 'const THINKING_DESCRIPTIONS');

  for (const [key, modelId, thinking, reason] of EXPECTED_RECOMMENDATIONS) {
    assert.match(
      block,
      new RegExp(`${key}:\\s*{[^}]*modelId: "${modelId}"[^}]*thinking: "${thinking}"[^}]*reason: "${reason}"`),
    );
  }

  const recommendedIds = [...block.matchAll(/modelId:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(recommendedIds.length > 0, 'expected recommendation model IDs');
  assert.ok(recommendedIds.every((id) => ALLOWED_RECOMMENDED_MODEL_IDS.has(id)), `unexpected IDs: ${recommendedIds.join(', ')}`);
  assert.doesNotMatch(block, /gpt-5\.1|gpt-5\.4-(?!mini\b)[a-z0-9-]+|claude|haiku|opus|sonnet/i);
});

test('arc model profiles UI applies recommended thinking and does not fall back to unrelated models', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /const levels = getSupportedArcThinkingLevels\(recommended\.model\)/);
  assert.match(source, /profile\.thinking = levels\.includes\(recommendation\.thinking\) \? recommendation\.thinking : "off"/);
  assert.doesNotMatch(source, /return candidates\[0\]/);
});

test('arc model profiles UI uses Pi available models and thinking helpers', () => {
  const source = read('extensions/arc/model-profiles-ui.ts');
  assert.match(source, /ctx\.modelRegistry\.getAvailable\(\)\.map\(toArcModelInfo\)/);
  assert.match(source, /getSupportedArcThinkingLevels/);
  assert.match(source, /findArcModelInfo/);
  assert.match(source, /preferredProvider/);
  assert.match(source, /unavailable/i);
  assert.match(source, /recommended/i);
});
