import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc-plan requires exactly one executor label for every new task', () => {
  const source = read('skills/arc-plan/SKILL.md');

  assert.match(source, /every new implementation task[^\n]+exactly one executor label/i);
  assert.match(source, /`executor:coder`/);
  assert.match(source, /`executor:devops`/);
  assert.match(source, /`executor:docs`/);
  assert.match(source, /multiple or missing executor labels/i);
});

test('arc-plan uses executor:docs for new docs tasks and treats docs-only as legacy input', () => {
  const source = read('skills/arc-plan/SKILL.md');

  assert.match(source, /use `executor:docs` as the source of truth/i);
  assert.match(source, /`docs-only`[^\n]+legacy input[^\n]+arc-build/i);
  assert.doesNotMatch(source, /include it in the `## Labels` section with `docs-only`/i);
});

test('arc-plan documents devops classification and task contract sections', () => {
  const source = read('skills/arc-plan/SKILL.md');

  for (const term of [
    'Kubernetes',
    'Terraform/OpenTofu',
    'Helm',
    'Kustomize',
    'ArgoCD',
    'CI/CD',
    'cloud infra',
    'runbooks',
    'live operational checks',
  ]) {
    assert.match(source, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const heading of [
    '## Executor',
    '## Live Operation Authorization',
    '## Target Environment',
    '## Allowed Operations',
    '## Scope Boundary',
    '## Preflight Checks',
    '## Execution Steps',
    '## Rollback Plan',
    '## Validation/Post-checks',
    '## Evidence to Report',
  ]) {
    assert.match(source, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(source, /live-ops-approved/);
  assert.match(source, /task-body authorization/i);
});

test('issue-manager manifest guidance includes executor labels', () => {
  const source = read('agents/issue-manager.md');

  assert.match(source, /executor:coder/);
  assert.match(source, /executor:devops/);
  assert.match(source, /executor:docs/);
  assert.match(source, /exactly one executor label/i);
});
