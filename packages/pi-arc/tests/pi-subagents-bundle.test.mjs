import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_SUBAGENTS_EXTENSION_PATH,
  PI_SUBAGENTS_PACKAGE,
  PI_SUBAGENTS_PROMPTS_PATH,
  PI_SUBAGENTS_SKILLS_PATH,
  PI_SUBAGENTS_VERSION_RANGE,
} from './parallel-throughput-contract.mjs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

test('package metadata bundles and loads pi-subagents', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.equal(pkg.dependencies[PI_SUBAGENTS_PACKAGE], PI_SUBAGENTS_VERSION_RANGE);
  assert.ok(pkg.bundledDependencies.includes(PI_SUBAGENTS_PACKAGE));
  assert.ok(pkg.pi.extensions.includes(PI_SUBAGENTS_EXTENSION_PATH));
  assert.ok(pkg.pi.skills.includes(PI_SUBAGENTS_SKILLS_PATH));
  assert.ok(pkg.pi.prompts.includes(PI_SUBAGENTS_PROMPTS_PATH));

  assert.equal(lock.packages[''].dependencies[PI_SUBAGENTS_PACKAGE], PI_SUBAGENTS_VERSION_RANGE);
  assert.ok(lock.packages[''].bundleDependencies.includes(PI_SUBAGENTS_PACKAGE));
  assert.ok(lock.packages[`node_modules/${PI_SUBAGENTS_PACKAGE}`]);
});
