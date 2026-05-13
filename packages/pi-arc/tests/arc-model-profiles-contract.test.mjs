import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc model profile contract defines stable profile keys and config shape', () => {
  const source = read('extensions/arc/model-profiles.ts');
  for (const key of ['brainstorm', 'plan', 'issueManager', 'builder', 'codeReviewer', 'docWriter', 'specReviewer', 'evaluator']) {
    assert.match(source, new RegExp(`"${key}"`));
  }
  assert.match(source, /export interface ArcModelsConfig/);
  assert.match(source, /modelProfiles: Partial<Record<ArcModelProfileKey, ArcModelProfile>>/);
  assert.match(source, /setup\?: ArcModelsSetupState/);
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
