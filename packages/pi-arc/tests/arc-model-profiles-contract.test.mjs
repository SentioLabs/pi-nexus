import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as profiles from '../extensions/arc/model-profiles.ts';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc model profile contract defines stable profile keys and config shape', () => {
  const source = read('extensions/arc/model-profiles.ts');
  for (const key of ['brainstorm', 'plan', 'issueManager', 'builder', 'devopsBuilder', 'codeReviewer', 'docWriter', 'specReviewer', 'evaluator']) {
    assert.match(source, new RegExp(`"${key}"`));
  }
  assert.match(source, /export interface ArcModelsConfig/);
  assert.match(source, /modelProfiles: Partial<Record<ArcModelProfileKey, ArcModelProfile>>/);
  assert.match(source, /setup\?: ArcModelsSetupState/);
});

test('max survives config normalization and model suffix lookup', () => {
  const normalized = profiles.normalizeArcModelsConfig({
    version: 1,
    modelProfiles: { builder: { model: 'openai-codex/gpt-6-astra', thinking: 'max' } },
  });
  assert.equal(normalized.modelProfiles.builder?.thinking, 'max');
  assert.equal(
    profiles.findArcModelInfo('openai-codex/gpt-6-astra:max', [profiles.toArcModelInfo({
      provider: 'openai-codex', id: 'gpt-6-astra',
    })])?.fullId,
    'openai-codex/gpt-6-astra',
  );
  assert.equal(profiles.applyArcThinkingSuffix('openai-codex/gpt-6-astra', 'max'), 'openai-codex/gpt-6-astra:max');
});

test('omitted capability maps do not imply xhigh or max support', () => {
  assert.deepEqual(
    profiles.getSupportedArcThinkingLevels(profiles.toArcModelInfo({ provider: 'openai-codex', id: 'gpt-5.6-terra' })),
    ['off', 'minimal', 'low', 'medium', 'high'],
  );
});

test('capability maps only offer explicitly supported levels and unsupported Astra effort falls back to low', () => {
  const astra = {
    provider: 'openai-codex',
    id: 'gpt-6-astra',
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  };
  const info = profiles.toArcModelInfo(astra);
  assert.deepEqual(profiles.getSupportedArcThinkingLevels(info), ['low', 'medium', 'high', 'xhigh', 'max']);

  const resolution = profiles.resolveArcModelProfile({
    profileKey: 'builder',
    config: { version: 1, modelProfiles: { builder: { model: 'openai-codex/gpt-6-astra', thinking: 'off' } } },
    availableModels: [info],
  });
  assert.equal(resolution.model, 'openai-codex/gpt-6-astra');
  assert.equal(resolution.thinking, 'low');
  assert.match(resolution.warning ?? '', /unsupported/);
});

test('explicit dispatch and configured profiles remain authoritative', () => {
  const terra = profiles.toArcModelInfo({ provider: 'openai-codex', id: 'gpt-5.6-terra' });
  const input = {
    profileKey: 'builder',
    config: { version: 1, modelProfiles: { builder: { model: 'openai-codex/gpt-5.6-terra', thinking: 'medium' } } },
    availableModels: [terra],
    tierModel: 'openai-codex/gpt-6-astra',
    fallbackModel: 'openai-codex/gpt-5.6-luna',
  };
  assert.deepEqual(profiles.resolveArcModelProfile(input), {
    profileKey: 'builder', source: 'profile', model: 'openai-codex/gpt-5.6-terra', thinking: 'medium', shouldPrompt: false, warning: undefined,
  });
  assert.deepEqual(profiles.resolveArcModelProfile({ ...input, explicitModel: 'openai-codex/custom:max' }), {
    profileKey: 'builder', source: 'explicit', model: 'openai-codex/custom:max', shouldPrompt: false,
  });
});

test('arc model profile contract exposes resolver and thinking helpers', () => {
  const source = read('extensions/arc/model-profiles.ts');
  for (const name of ['resolveArcModelsConfigPath', 'loadArcModelsConfig', 'saveArcModelsConfig', 'normalizeArcModelsConfig', 'toArcModelInfo', 'findArcModelInfo', 'getSupportedArcThinkingLevels', 'applyArcThinkingSuffix', 'resolveArcModelProfile']) {
    assert.match(source, new RegExp(`export function ${name}|export async function ${name}`));
  }
  assert.match(source, /XDG_CONFIG_HOME/);
  assert.match(source, /pi-arc/);
  assert.match(source, /models\.json/);
  assert.match(source, /reasoning === false/);
  assert.match(source, /thinkingLevelMap/);
  assert.match(source, /shouldPrompt: true/);
  assert.match(source, /unavailableModel/);
});
