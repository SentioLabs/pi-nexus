import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc-build documents executor label routing and legacy fallbacks', () => {
  const source = read('skills/arc-build/SKILL.md');

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
