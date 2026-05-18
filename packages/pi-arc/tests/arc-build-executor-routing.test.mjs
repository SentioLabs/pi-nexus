import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc-build documents executor label routing and legacy fallbacks', () => {
  const source = read('skills/arc-build/SKILL.md');

  assert.match(source, /dispatching fresh executor-specific subagents per task/i);
  assert.doesNotMatch(source, /dispatching fresh `coder` subagents per task/i);
  assert.match(source, /exactly one `executor:coder`[^\n]*coder/i);
  assert.match(source, /exactly one `executor:devops`[^\n]*devops/i);
  assert.match(source, /exactly one `executor:docs`[^\n]*doc-writer/i);
  assert.match(source, /zero executor labels[^\n]*`docs-only`[^\n]*doc-writer/i);
  assert.match(source, /zero executor labels[^\n]*no `docs-only`[^\n]*coder/i);
  assert.match(source, /multiple or unknown executor labels[^\n]*(stop|require issue correction)/i);
});

test('arc-build documents devops dispatch and evidence-only completion', () => {
  const source = read('skills/arc-build/SKILL.md');

  assert.match(source, /subagent\(\{ agent: "arc-devops"[\s\S]*async: true[\s\S]*clarify: false[\s\S]*\}\)/);
  assert.match(source, /arc_agent\(agent="devops"/);
  assert.match(source, /evidence-only/i);
  assert.match(source, /no commit/i);
  assert.match(source, /devops evidence/i);
});

test('arc-build follow-up loops re-dispatch the resolved executor', () => {
  const source = read('skills/arc-build/SKILL.md');

  assert.match(source, /re-dispatch the resolved executor/i);
  assert.match(source, /resolved executor \(`coder`, `devops`, or `doc-writer`\)/i);
  assert.match(source, /## Handle Executor Status/);
  assert.match(source, /Every `coder`, `devops`, and `doc-writer` dispatch returns/i);
  assert.doesNotMatch(source, /## Handle Coder Status/);
  assert.doesNotMatch(source, /re-dispatch `coder` with specific gaps/i);
  assert.doesNotMatch(source, /Re-dispatch `coder` with fixes/i);
  assert.doesNotMatch(source, /Re-dispatch `coder` if the concerns/i);
});

test('arc-build docs routing updates doc-writer and docs review wording', () => {
  const source = read('skills/arc-build/SKILL.md');
  const prompt = read('skills/arc-build/doc-writer-prompt.md');

  assert.match(prompt, /`executor:docs`/);
  assert.match(prompt, /legacy `docs-only` fallback/i);
  assert.match(source, /resolved executor is `doc-writer` \(including legacy `docs-only`\)/i);
  assert.doesNotMatch(source, /> \*\*Docs-only tasks\*\*: Skip this step\./i);
  assert.doesNotMatch(source, /> \*\*Docs-only tasks\*\*: Skip code quality review\./i);
});
