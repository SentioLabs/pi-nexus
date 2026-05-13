import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PI_SUBAGENTS_PACKAGE } from './parallel-throughput-contract.mjs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

function resourcePaths(pkg) {
  return [
    ...(pkg.pi?.extensions ?? []),
    ...(pkg.pi?.skills ?? []),
    ...(pkg.pi?.prompts ?? []),
  ];
}

test('package metadata treats pi-subagents as an optional external integration', () => {
  const pkg = readJson('package.json');
  const lock = readJson('../../package-lock.json');
  const packageLockEntry = lock.packages['packages/pi-arc'];

  assert.equal(pkg.dependencies[PI_SUBAGENTS_PACKAGE], undefined);
  assert.equal(pkg.dependencies['pi-intercom'], undefined);
  assert.ok(!pkg.bundledDependencies.includes(PI_SUBAGENTS_PACKAGE));
  assert.ok(!pkg.bundledDependencies.includes('pi-intercom'));
  assert.ok(resourcePaths(pkg).every((entry) => !entry.includes(`node_modules/${PI_SUBAGENTS_PACKAGE}`)));

  assert.equal(packageLockEntry.dependencies?.[PI_SUBAGENTS_PACKAGE], undefined);
  assert.equal(packageLockEntry.dependencies?.['pi-intercom'], undefined);
  assert.ok(!packageLockEntry.bundleDependencies.includes(PI_SUBAGENTS_PACKAGE));
  assert.ok(!packageLockEntry.bundleDependencies.includes('pi-intercom'));
  assert.equal(lock.packages[`node_modules/${PI_SUBAGENTS_PACKAGE}`], undefined);
});
