import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('normalizeArcModelsConfig migrates legacy builder profile to coder when coder is unset', async () => {
  const mod = await import('../extensions/arc/model-profiles.ts');
  const normalized = mod.normalizeArcModelsConfig({
    version: mod.ARC_MODELS_CONFIG_VERSION,
    modelProfiles: {
      builder: {
        model: 'openai-codex/gpt-5.3-codex',
        thinking: 'medium',
      },
    },
  });

  assert.deepEqual(normalized.modelProfiles.coder, {
    model: 'openai-codex/gpt-5.3-codex',
    thinking: 'medium',
  });
});

test('normalizeArcModelsConfig keeps coder profile when both coder and legacy builder are set', async () => {
  const mod = await import('../extensions/arc/model-profiles.ts');
  const normalized = mod.normalizeArcModelsConfig({
    version: mod.ARC_MODELS_CONFIG_VERSION,
    modelProfiles: {
      builder: {
        model: 'openai-codex/gpt-5.5',
        thinking: 'high',
      },
      coder: {
        model: 'openai-codex/gpt-5.3-codex',
        thinking: 'low',
      },
    },
  });

  assert.deepEqual(normalized.modelProfiles.coder, {
    model: 'openai-codex/gpt-5.3-codex',
    thinking: 'low',
  });
});

test('normalizeArcModelsConfig does not migrate builder over an explicit invalid coder profile', async () => {
  const mod = await import('../extensions/arc/model-profiles.ts');
  const normalized = mod.normalizeArcModelsConfig({
    version: mod.ARC_MODELS_CONFIG_VERSION,
    modelProfiles: {
      builder: {
        model: 'openai-codex/gpt-5.5',
        thinking: 'high',
      },
      coder: {
        model: '   ',
        thinking: 'definitely-not-valid',
      },
    },
  });

  assert.equal(normalized.modelProfiles.coder, undefined);
});

test('loadArcModelsConfig does not persist migration when coder key is explicitly present but invalid', async () => {
  const mod = await import('../extensions/arc/model-profiles.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'arc-model-profiles-'));
  const configPath = path.join(root, 'models.json');

  try {
    const rawConfig = {
      version: mod.ARC_MODELS_CONFIG_VERSION,
      modelProfiles: {
        builder: {
          model: 'openai-codex/gpt-5.5',
          thinking: 'high',
        },
        coder: {
          model: '   ',
          thinking: 'definitely-not-valid',
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');

    const loaded = await mod.loadArcModelsConfig(configPath);
    assert.equal(loaded.modelProfiles.coder, undefined);

    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(persisted, rawConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadArcModelsConfig persists legacy builder migration as coder config', async () => {
  const mod = await import('../extensions/arc/model-profiles.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'arc-model-profiles-'));
  const configPath = path.join(root, 'models.json');

  try {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: mod.ARC_MODELS_CONFIG_VERSION,
          modelProfiles: {
            builder: {
              model: 'openai-codex/gpt-5.3-codex',
              thinking: 'medium',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const loaded = await mod.loadArcModelsConfig(configPath);
    assert.deepEqual(loaded.modelProfiles.coder, {
      model: 'openai-codex/gpt-5.3-codex',
      thinking: 'medium',
    });

    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(persisted.modelProfiles.coder, {
      model: 'openai-codex/gpt-5.3-codex',
      thinking: 'medium',
    });
    assert.equal('builder' in persisted.modelProfiles, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
