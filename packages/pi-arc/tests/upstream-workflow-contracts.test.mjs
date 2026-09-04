import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('planner-only review contract is consistent across Arc workflow skills', () => {
  for (const path of [
    'skills/arc/SKILL.md',
    'skills/arc-brainstorm/SKILL.md',
    'skills/arc-plan/SKILL.md',
  ]) {
    const source = read(path);
    assert.match(source, /arc plan/);
    assert.doesNotMatch(source, /arc share|share-local|share-remote|kind=legacy/);
  }

  const brainstorm = read('skills/arc-brainstorm/SKILL.md');
  const plan = read('skills/arc-plan/SKILL.md');
  assert.match(brainstorm, /<!-- arc-review: id=<id> -->/);
  assert.match(plan, /<!-- arc-review: id=<id> -->/);
  assert.match(brainstorm, /arc plan create --no-frontmatter/);
  assert.doesNotMatch(brainstorm, /arc plan create (?!--no-frontmatter)/);
  const combined = [read('skills/arc/SKILL.md'), brainstorm, plan].join('\n');
  assert.doesNotMatch(combined, /arc:(?:plan|build)|arc plan create (?!--no-frontmatter)/);
});

test('Astra, Terra, and Luna map onto Arc model tiers and role profiles', () => {
  const extension = read('extensions/arc.ts');
  const readme = read('README.md');

  assert.match(extension, /nano: "openai-codex\/gpt-5\.6-luna"/);
  assert.match(extension, /small: "openai-codex\/gpt-5\.6-luna"/);
  assert.match(extension, /standard: "openai-codex\/gpt-5\.6-terra"/);
  assert.match(extension, /large: "openai-codex\/gpt-6-astra"/);
  assert.match(readme, /Luna \(`off` for issue management and `low` for docs\)/);
  assert.match(readme, /Terra for `standard`/);
  assert.match(readme, /Astra for `large`/);
});

test('general Arc reference uses Pi-native lifecycle and dispatch wording', () => {
  const source = read('skills/arc/SKILL.md');
  assert.match(source, /Pi extension session-start and before-compaction handlers/);
  assert.match(source, /auto-materialized `arc-issue-manager` pi-subagent/);
  assert.match(source, /bundled `arc_agent` fallback/);
  assert.doesNotMatch(source, /SessionStart\/PreCompact hooks|via the Task tool/);
});

test('success criteria flow from brainstorm through epic completion', () => {
  const brainstorm = read('skills/arc-brainstorm/SKILL.md');
  const plan = read('skills/arc-plan/SKILL.md');
  const build = read('skills/arc-build/SKILL.md');

  assert.match(brainstorm, /## Success Criteria/);
  assert.match(plan, /Success-criteria coverage/);
  assert.match(plan, /## Expected Outcome/);
  assert.match(build, /Completion Gate/);
  assert.match(build, /select\(\.status != "closed"\)/);
  assert.match(build, /Any `open`, `in_progress`, `blocked`, or `deferred` child keeps the epic open/);
  assert.match(build, /For a standalone task/);
  assert.match(build, /For DevOps-only epics/);
  assert.match(build, /Success Criteria/);
});

test('DevOps tasks use dedicated Pi-native specialist and safety resources', () => {
  for (const path of [
    'agents/devops-builder.md',
    'skills/arc-build/devops-builder-prompt.md',
    'skills/arc-build/references/devops-patterns.md',
  ]) {
    assert.equal(existsSync(path), true, `missing ${path}`);
  }

  const agent = read('agents/devops-builder.md');
  const prompt = read('skills/arc-build/devops-builder-prompt.md');
  const plan = read('skills/arc-plan/SKILL.md');
  const build = read('skills/arc-build/SKILL.md');
  const extension = read('extensions/arc.ts');
  const subagents = read('extensions/arc/subagents.ts');

  assert.match(agent, /^model:\s*large$/m);
  assert.match(agent, /NO MUTATION WITHOUT A DRY-RUN PREVIEW AND A ROLLBACK PATH/);
  assert.match(agent, /## Supervisor Escalation/);
  assert.doesNotMatch(agent, /skills\/build\//);
  assert.doesNotMatch(prompt, /skills\/build\//);
  assert.match(prompt, /skills\/arc-build\/references\/devops-patterns\.md/);
  const patterns = read('skills/arc-build/references/devops-patterns.md');
  assert.match(patterns, /helm diff upgrade/);
  assert.match(patterns, /STOP and require explicit authorization plus a verified recovery procedure/);
  assert.doesNotMatch(plan, /Upgrade the staging cluster control plane from 1\.28 to 1\.29/);
  assert.match(plan, /helm rollback payments/);

  for (const heading of ['## Target', '## Safeguards', '## Verification', '## Rollback']) {
    assert.match(plan, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(plan, /Labels: devops/);
  assert.match(build, /arc-devops-builder/);
  assert.match(build, /arc_agent\(agent="devops-builder", task="<filled prompt>"\)/);
  assert.doesNotMatch(build, /arc_agent\(agent="devops-builder"[^\n]*model=/);
  assert.match(build, /devopsBuilder/);
  assert.match(build, /never include live-system operations tasks in a parallel patch batch/i);
  assert.match(build, /No task has a `devops` label or any live-system mutation scope/);
  assert.match(plan, /Never place a `devops` task or other live-system mutation in a parallel batch/);
  assert.match(extension, /"devops-builder"/);
  assert.match(subagents, /target: "arc-devops-builder", profileKey: "devopsBuilder"/);
});

test('issue-manager preserves canonical descriptions and phased ordering', () => {
  const source = read('agents/issue-manager.md');
  const plan = read('skills/arc-plan/SKILL.md');
  assert.match(source, /Never summarize, trim, or paraphrase/i);
  assert.match(source, /--stdin < "\/path\/to\/T1\.md"/);
  assert.match(source, /Create the epic first/);
  assert.match(source, /Create all child tasks/);
  assert.match(source, /Apply dependencies only after all child IDs exist/);
  assert.match(source, /Apply labels after dependencies/);
  assert.match(source, /arc update <id> --label-add=devops/);
  assert.match(source, /canonical description-file paths/);
  assert.match(source, /Arc normalizes outer whitespace/);
  assert.match(source, /jq -j \.description \| sha256sum/);
  assert.match(source, /wc -l/);
  assert.match(plan, /path\.write_text\(path\.read_text\(\)\.strip\(\)\)/);
  assert.match(plan, /File SHA-256/);
  assert.doesNotMatch(plan, /File lines \| Arc lines/);
  assert.ok(plan.indexOf('Before persistence, self-review') < plan.indexOf('Then dispatch the manifest'));
  assert.equal((plan.match(/### 6\.5\. Self-Review/g) ?? []).length, 0);
  assert.match(source, /## Timing/);
});

test('arc-summarize uses Pi MCP gateway and bundled question schema', () => {
  const skill = read('skills/arc-summarize/SKILL.md');
  const extension = read('extensions/arc.ts');

  assert.match(skill, /^name:\s*arc-summarize$/m);
  assert.match(skill, /Pi's `mcp` gateway/);
  assert.match(skill, /questions\[\]/);
  assert.match(skill, /@juicesharp\/rpiv-ask-user-question/);
  assert.doesNotMatch(skill, /mcp__claude|mcp__plugin/);
  assert.doesNotMatch(skill, /jira_create\(/);
  assert.match(skill, /mcp\(\{ describe: "<discovered-create-tool>" \}\)/);
  assert.doesNotMatch(skill, /`ask_user_question`:\s*$/m);
  assert.match(skill, /TMP=\$\(mktemp\)/);
  assert.match(skill, /jq -j \.description > "\$TMP"/);
  assert.match(skill, /arc update <arc-id> --stdin < "\$TMP"/);
  assert.match(skill, /Re-read both records/);
  assert.match(skill, /never fabricate a host/);
  assert.doesNotMatch(skill, /https:\/\/arc\.bactrack\.com/);
  assert.doesNotMatch(skill, /<full existing description, unchanged from arc show>/);
  assert.match(extension, /command: "arc-summarize"/);
  assert.match(extension, /skill: "arc-summarize"/);
});

test('review and evaluator profiles remain authoritative with large fallbacks', () => {
  for (const path of ['agents/code-reviewer.md', 'agents/spec-reviewer.md', 'agents/evaluator.md']) {
    assert.match(read(path), /^model:\s*large$/m, path);
  }

  const build = read('skills/arc-build/SKILL.md');
  assert.match(build, /subagent\(\{ agent: "arc-spec-reviewer", task: "<filled prompt>", context: "fresh"/);
  assert.doesNotMatch(build, /agent: "arc-spec-reviewer"[^\n]*model:/);
  assert.doesNotMatch(build, /agent: "arc-evaluator"[^\n]*model:/);
  assert.doesNotMatch(build, /arc_agent\(agent="evaluator"[^\n]*model=/);
  assert.match(build, /git status --short.*pre-evaluation baseline/s);

  const evaluator = read('agents/evaluator.md');
  assert.match(evaluator, /If it is not clean, report `BLOCKED`/);
  assert.match(evaluator, /restore modified tracked files and remove only the temporary files/i);
  assert.doesNotMatch(evaluator, /Do NOT worry about cleanup/);
});
