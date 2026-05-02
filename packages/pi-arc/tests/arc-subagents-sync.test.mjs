import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc extension registers arc-subagents-sync command', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /registerCommand\("arc-subagents-sync"/);
  assert.match(source, /ARC_SUBAGENT_GENERATED_MARKER/);
  assert.match(source, /source-sha256/);
  assert.match(source, /\.pi", "agents"/);
  assert.match(source, /\.pi", "agent", "agents"/);
});

test('arc extension sync map includes all Arc specialists', () => {
  const source = read('extensions/arc.ts');
  for (const name of [
    'arc-builder',
    'arc-doc-writer',
    'arc-spec-reviewer',
    'arc-code-reviewer',
    'arc-evaluator',
    'arc-issue-manager',
  ]) {
    assert.match(source, new RegExp(name));
  }
  assert.match(source, /existing file is missing the generated marker; preserving user edits/);
});

test('arc extension model tiers include nano', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /type ArcModelTier = "nano" \| "small" \| "standard" \| "large"/);
  assert.match(source, /nano: "openai-codex\/gpt-5\.4-nano"/);
  assert.match(source, /nano for bulk CLI issue creation/);
});

test('arc extension sync guidance distinguishes agent discovery from status monitoring', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /subagent\(\{ action: "list" \}\).*confirm the Arc specialists are available/);
  assert.match(source, /\/agents.*inspect loaded agent definitions/);
  assert.match(source, /\/subagents-status.*monitor active\/recent async Arc specialist runs/);
  assert.match(source, /idle installed agents are listed by.*\/agents/);
  assert.doesNotMatch(source, /\/subagents-status.*confirm availability/);
});

test('arc-build skill references arc-subagents-sync and async pi-subagents workers', () => {
  const source = read('skills/arc-build/SKILL.md');
  assert.match(source, /\/arc-subagents-sync/);
  assert.match(source, /arc-builder/);
  assert.match(source, /async: true/);
  assert.match(source, /clarify: false/);
  assert.match(source, /subagent\(\{ action: "status", id: "<run-id>" \}\)/);
  assert.match(source, /until terminal/);
  assert.match(source, /read the final output/);
  assert.match(source, /\/subagents-status/);
});

test('arc-plan prefers arc-issue-manager via pi-subagents before arc_agent fallback', () => {
  const source = read('skills/arc-plan/SKILL.md');
  assert.match(source, /arc-issue-manager/);
  assert.match(source, /subagent\(\{ agent: "arc-issue-manager"/);
  assert.match(source, /async: true/);
  assert.match(source, /clarify: false/);
  assert.match(source, /subagent\(\{ action: "status", id: "<run-id>" \}\)/);
  assert.match(source, /do \*\*not\*\* use the slower `arc_agent\(agent="issue-manager"\)` fallback/);
  assert.match(source, /arc_agent\(agent="issue-manager"/);
});

test('arc-review prefers arc-code-reviewer via pi-subagents before arc_agent fallback', () => {
  const source = read('skills/arc-review/SKILL.md');
  assert.match(source, /arc-code-reviewer/);
  assert.match(source, /subagent\(\{ agent: "arc-code-reviewer"/);
  assert.match(source, /async: true/);
  assert.match(source, /clarify: false/);
  assert.match(source, /subagent\(\{ action: "status", id: "<run-id>" \}\)/);
  assert.match(source, /arc_agent\(agent="code-reviewer"/);
});

test('README documents arc-subagents-sync and status semantics', () => {
  const source = read('README.md');
  assert.match(source, /\/arc-subagents-sync/);
  assert.match(source, /generic `worker`/i);
  assert.match(source, /After syncing, verify agent registration/);
  assert.match(source, /subagent\(\{ action: "list" \}\)/);
  assert.match(source, /\/agents/);
  assert.match(source, /Use `\/subagents-status` to monitor active\/recent async Arc specialist runs/);
  assert.match(source, /It does not list idle installed agents/);
  assert.doesNotMatch(source, /\/subagents-status.*confirm availability/);
});

test('migration script preserves arc-subagents-sync wording', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /arc-subagents-sync/);
});
