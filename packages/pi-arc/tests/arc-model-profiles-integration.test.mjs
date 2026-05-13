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

test('arc extension wires model profiles into commands and agent dispatch', () => {
  const source = read('extensions/arc.ts');

  for (const token of [
    'registerCommand("arc-models"',
    'openArcModelProfilesEditor',
    'loadArcModelsConfig',
    'saveArcModelsConfig',
    'resolveArcModelProfile',
    'ARC_AGENT_PROFILE_KEYS',
    'builder',
    'codeReviewer',
    'docWriter',
    'evaluator',
    'issueManager',
    'specReviewer',
    'maybeEnsureBrainstormProfileReady',
    'arc-brainstorm',
    'Use recommended defaults',
    'Customize',
    'Skip for now',
    'Reconfigure now',
    'Use fallback once',
    'Disable profile',
    'resolveArcModelForAgent',
    'applyArcThinkingSuffix',
    'profileKey',
    'modelPattern',
    'buildArcSubagentMarkdown',
    'materializeArcSubagentsForContext',
    'saveArcModelsConfigWithMaterialization',
  ]) {
    assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('arc extension recommended profile defaults use exact allowed models and thinking', () => {
  const source = read('extensions/arc.ts');
  const block = extractConstBlock(source, 'ARC_PROFILE_RECOMMENDATIONS', 'type BrainstormProfilePromptAction');

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

test('model profile saves refresh generated Arc subagents', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /openAndMaybeSaveArcModelProfiles/);
  assert.match(source, /async function saveArcModelsConfigWithMaterialization/);
  assert.match(source, /saveArcModelsConfigWithMaterialization\(ctx, result\.config, configPath\)/);
  assert.match(source, /materializeArcSubagentsForContext\(ctx, "arc_models_save"\)/);
  assert.match(source, /notifyArcSubagentMaterialization\(ctx, materialized\)/);
  assert.match(source, /action === "recommended"\)[\s\S]*saveArcModelsConfigWithMaterialization\(ctx, config, configPath\)/);
  assert.match(source, /action === "customize"\) return openAndMaybeSaveArcModelProfiles\(ctx, config, configPath, preferredProvider, true\)/);
  assert.match(source, /registerCommand\("arc-models"[\s\S]*openAndMaybeSaveArcModelProfiles\(ctx, config, configPath, ctx\.model\?\.provider, false\)/);
});

test('arc brainstorm setup applies recommended thinking and avoids unrelated fallback models', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /getSupportedArcThinkingLevels/);
  assert.match(source, /const levels = getSupportedArcThinkingLevels\(recommended\.model\)/);
  assert.match(source, /thinking: levels\.includes\(recommendation\.thinking\) \? recommendation\.thinking : "off"/);
  assert.doesNotMatch(source, /return candidates\[0\]/);
});

test('README modelProfiles example stays within the recommended model set', () => {
  const source = read('README.md');
  const start = source.indexOf('## Arc model profiles');
  assert.notEqual(start, -1, 'missing Arc model profiles section');
  const end = source.indexOf('## Sync Arc specialists', start);
  assert.notEqual(end, -1, 'missing next README section');
  const section = source.slice(start, end);
  assert.doesNotMatch(section, /gpt-5\.4-(?!mini\b)[a-z0-9-]+|gpt-5\.1|claude|haiku|opus|sonnet/i);
  assert.match(section, /openai-codex\/gpt-5\.5/);
  assert.match(section, /openai-codex\/gpt-5\.4-mini/);
  assert.match(section, /openai-codex\/gpt-5\.3-codex/);
});

test('issue-manager docs recommend gpt-5.4-mini while preserving legacy fallback guidance', () => {
  const readme = read('README.md');
  assert.match(readme, /issueManager profile \(recommended gpt-5\.4-mini with thinking off\)/);
  assert.doesNotMatch(readme, /issueManager profile \(nano tier, thinking off\)/);

  const source = read('skills/arc-plan/SKILL.md');
  assert.match(source, /issueManager profile/);
  assert.match(source, /gpt-5\.4-mini with thinking off/);
  assert.match(source, /defaults to `nano`/);
  assert.match(source, /legacy tier\/frontmatter behavior/);
  assert.doesNotMatch(source, /recommended profile uses a nano-tier model with thinking off/);
});
