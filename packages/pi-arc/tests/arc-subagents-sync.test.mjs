import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('arc-subagents-sync is deprecated repair while user-scope materialization is default', () => {
  const source = read('extensions/arc.ts');
  const materializer = read('extensions/arc/subagents.ts');
  const start = source.indexOf('registerCommand("arc-subagents-sync"');
  assert.notEqual(start, -1, 'missing arc-subagents-sync command');
  const end = source.indexOf('registerCommand("arc-models"', start);
  assert.notEqual(end, -1, 'missing arc-models command after arc-subagents-sync');
  const commandBlock = source.slice(start, end);
  assert.match(commandBlock, /arc-subagents-sync/);
  assert.match(commandBlock, /deprecated/i);
  assert.match(commandBlock, /repair/i);
  assert.match(source, /ARC_SUBAGENT_GENERATED_MARKER/);
  assert.match(source, /source-sha256/);
  assert.match(materializer, /"\.agents"/);
  assert.match(materializer, /"\.pi", "agent", "agents"/);
  assert.doesNotMatch(commandBlock, /Usage:\\n- `\/arc-subagents-sync` \(project scope\)/);
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
  assert.match(source, /nano: "openai-codex\/gpt-5\.4-mini"/);
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

test('arc-code-reviewer dispatch prompt stays review-only for pi-subagents completion guard', () => {
  const source = read('skills/arc-review/code-reviewer-prompt.md');
  assert.match(source, /Review only/i);
  assert.match(source, /return findings only/i);
  assert.match(source, /Do not edit files/i);
  assert.doesNotMatch(source, /\bmust\s+(?:edit|modify|change|fix|patch|apply)\b/i);
  assert.doesNotMatch(source, /\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i);
  assert.doesNotMatch(source, /\bmake\s+(?:the\s+)?code\s+changes\b/i);
});

test('README documents auto-materialized specialists and status semantics', () => {
  const source = read('README.md');
  assert.match(source, /auto-materialized/i);
  assert.match(source, /Users do not need to run `\/arc-subagents-sync`/);
  assert.match(source, /\/arc-subagents-sync.*deprecated.*repair\/backcompat/i);
  assert.match(source, /project .*shadow/i);
  assert.match(source, /generic `worker`/i);
  assert.match(source, /subagent\(\{ action: "list" \}\)/);
  assert.match(source, /\/agents/);
  assert.match(source, /Use `\/subagents-status` to monitor active\/recent async Arc specialist runs/);
  assert.match(source, /It does not list idle installed agents/);
  assert.doesNotMatch(source, /\/subagents-status.*confirm availability/);
});

test('arc docs mention arc-subagents-sync only as deprecated repair/backcompat', () => {
  for (const path of [
    'README.md',
    'skills/arc-build/SKILL.md',
    'skills/arc-plan/SKILL.md',
    'skills/arc-review/SKILL.md',
  ]) {
    const source = read(path);
    const lines = source.split(/\r?\n/).filter((line) => line.includes('/arc-subagents-sync'));
    if (path === 'README.md') assert.ok(lines.length > 0, `${path} should mention /arc-subagents-sync`);
    for (const line of lines) {
      assert.match(line, /deprecated|repair|backcompat|Users do not need/i, `${path}: ${line}`);
    }
  }
});

test('migration script preserves arc-subagents-sync wording', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /arc-subagents-sync/);
});
