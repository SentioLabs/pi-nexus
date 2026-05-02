import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_MANAGER_PHASE_TERMS,
  PARALLEL_READINESS_HEADINGS,
  PI_SUBAGENTS_EXTENSION_PATH,
  PI_SUBAGENTS_PACKAGE,
  PI_SUBAGENTS_PROMPTS_PATH,
  PI_SUBAGENTS_SKILLS_PATH,
  PI_SUBAGENTS_VERSION_RANGE,
} from './parallel-throughput-contract.mjs';

test('pi-subagents package contract is explicit', () => {
  assert.equal(PI_SUBAGENTS_PACKAGE, 'pi-subagents');
  assert.equal(PI_SUBAGENTS_VERSION_RANGE, '^0.23.0');
  assert.equal(PI_SUBAGENTS_EXTENSION_PATH, './node_modules/pi-subagents/src/extension/index.ts');
  assert.equal(PI_SUBAGENTS_SKILLS_PATH, './node_modules/pi-subagents/skills');
  assert.equal(PI_SUBAGENTS_PROMPTS_PATH, './node_modules/pi-subagents/prompts');
});

test('parallel readiness headings are stable', () => {
  assert.deepEqual(PARALLEL_READINESS_HEADINGS, [
    '## Parallel Readiness',
    '### T0 Foundation Decision',
    '### File Ownership Matrix',
    '### Parallel Batch Manifest',
    '### Validation Matrix',
  ]);
});

test('issue-manager phase terms are stable', () => {
  assert.deepEqual(ISSUE_MANAGER_PHASE_TERMS, [
    'Create the epic first',
    'Create all child tasks',
    'Apply dependencies only after all child IDs exist',
    'Apply labels after dependencies',
  ]);
});
