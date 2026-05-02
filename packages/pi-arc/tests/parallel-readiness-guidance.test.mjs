import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_MANAGER_PHASE_TERMS,
  PARALLEL_READINESS_HEADINGS,
  PI_SUBAGENTS_PACKAGE,
} from './parallel-throughput-contract.mjs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function assertIncludesAll(source, terms) {
  for (const term of terms) {
    assert.match(source, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

test('arc-brainstorm documents parallel readiness headings', () => {
  assertIncludesAll(read('skills/arc-brainstorm/SKILL.md'), PARALLEL_READINESS_HEADINGS);
});

test('arc-plan documents parallel readiness, issue-manager phases, and timing output', () => {
  const source = read('skills/arc-plan/SKILL.md');
  assertIncludesAll(source, PARALLEL_READINESS_HEADINGS);
  assertIncludesAll(source, ISSUE_MANAGER_PHASE_TERMS);
  assert.match(source, /## Timing/);
  assert.match(source, /elapsed_ms/);
});

test('issue-manager documents safe phased issue creation', () => {
  const source = read('agents/issue-manager.md');
  assertIncludesAll(source, ISSUE_MANAGER_PHASE_TERMS);
  assert.match(source, /^model:\s*nano$/m);
  assert.match(source, /phase=/);
  assert.match(source, /elapsed_ms/);
  assert.match(source, /## Timing/);
});

test('arc-build consumes the parallel batch manifest safely', () => {
  const source = read('skills/arc-build/SKILL.md');
  assert.match(source, /Parallel Batch Manifest/);
  assert.match(source, /worktree: true/);
  assert.match(source, /PARALLEL_BASE/);
  assert.match(source, /one (returned )?patch|one patch/i);
});

test('README documents bundled subagents and execution lanes', () => {
  const source = read('README.md');
  assert.match(source, new RegExp(PI_SUBAGENTS_PACKAGE));
  assert.match(source, /bundledDependencies/);
  assert.match(source, /duplicate/i);
  assert.match(source, /Parallel Arc batch/);
  assert.match(source, /Ant Colony/);
  assert.doesNotMatch(source, /pi-plan.*replace.*arc-plan/i);
});
