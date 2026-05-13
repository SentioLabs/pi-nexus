import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_MANAGER_PHASE_TERMS,
  PARALLEL_READINESS_HEADINGS,
  PI_SUBAGENTS_INSTALL_COMMAND,
  PI_SUBAGENTS_PACKAGE,
  PI_SUBAGENTS_TOOL_NAME,
} from './parallel-throughput-contract.mjs';

test('pi-subagents optional integration contract is explicit', () => {
  assert.equal(PI_SUBAGENTS_PACKAGE, 'pi-subagents');
  assert.equal(PI_SUBAGENTS_TOOL_NAME, 'subagent');
  assert.equal(PI_SUBAGENTS_INSTALL_COMMAND, 'pi install npm:pi-subagents');
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
