import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

function renderTestAgent(mod, source, target, modelsConfigHash = 'models-hash') {
  return mod.buildArcSubagentMarkdown({
    targetName: target,
    sourceName: source,
    sourceMarkdown: `# ${source}`,
    parsedSource: { prompt: `# ${source}` },
    resolvedModel: 'openai-codex/gpt-5.4-mini',
    modelProfileKey: 'builder',
    modelResolutionSource: 'test',
    modelsConfigHash,
    generatedAt: '2026-05-03T00:00:00.000Z',
  });
}

test('Arc subagent materializer exposes stable result contract', () => {
  const source = read('extensions/arc/subagents.ts');

  assert.match(source, /export type ArcSubagentMaterializationReason/);
  assert.match(source, /"session_start"/);
  assert.match(source, /"arc_models_save"/);
  assert.match(source, /"manual_repair"/);
  assert.match(source, /export interface ArcSubagentMaterializationResult/);
  assert.match(source, /writes: ArcSubagentWriteResult\[\]/);
  assert.match(source, /shadows: ArcSubagentShadowWarning\[\]/);
});

test('Arc generated subagents record model freshness metadata', () => {
  const source = read('extensions/arc/subagents.ts');

  assert.match(source, /source-sha256/);
  assert.match(source, /model-profile-key/);
  assert.match(source, /model-resolution-source/);
  assert.match(source, /models-config-sha256/);
  assert.match(source, /generated-at/);
  assert.match(source, /export const ARC_SUBAGENT_GENERATED_MARKER/);
  assert.match(source, /export function isGeneratedArcSubagent/);
});

test('Arc subagent user target prefers modern user agent directory', () => {
  const source = read('extensions/arc/subagents.ts');

  assert.match(source, /"\.agents"/);
  assert.match(source, /"\.pi", "agent", "agents"/);
  assert.match(source, /legacyUserDir/);
  assert.equal(source.includes('// "\\.agents" "\\.pi", "agent", "agents"'), false);
});

test('Arc subagent markdown render preserves frontmatter, metadata, and body order', () => {
  const source = read('extensions/arc/subagents.ts');

  assert.match(source, /import \{ createHash \} from "node:crypto";/);
  assert.match(source, /import type \{ ArcModelProfileKey \} from "\.\/model-profiles\.ts";/);
  assert.match(source, /export interface ArcSubagentRenderInput/);
  assert.match(source, /export interface ArcSubagentParsedSource/);
  assert.match(source, /parsedSource:\s*ArcSubagentParsedSource;/);
  assert.match(source, /prompt:\s*string;/);
  assert.match(source, /export interface ArcSubagentRenderInput\s*\{[^}]*generatedAt:\s*string;[^}]*\}/);
  assert.doesNotMatch(source, /export interface ArcSubagentRenderInput\s*\{[^}]*sourceSha256:\s*string;/);
  assert.match(source, /createHash\("sha256"\)\.update\(text\)\.digest\("hex"\)/);
  assert.match(source, /buildArcSubagentMarkdown\(input: ArcSubagentRenderInput\): string/);
  assert.match(source, /sourceSha256:\s*sha256Text\(input\.sourceMarkdown\),/);
  assert.match(source, /const frontmatter = \[/);
  assert.match(source, /"---"/);
  assert.match(source, /`name: \$\{input\.targetName\}`/);
  assert.match(source, /systemPromptMode: replace/);
  assert.match(source, /inheritProjectContext: true/);
  assert.match(source, /inheritSkills: false/);
  assert.match(source, /frontmatter\}\\n\$\{metadata\}\\n\\n\$\{body\}/);
});

test('Arc subagent markdown render quotes colon-bearing descriptions and keeps expected output sections', () => {
  const source = read('extensions/arc/subagents.ts');
  const problematicDescription = 'Use this agent when creating issues. This includes: epics, tasks, labels.';

  assert.equal(JSON.stringify(problematicDescription), '"Use this agent when creating issues. This includes: epics, tasks, labels."');
  assert.match(source, /function yamlStringValue\(value: string\): string \{\s*return JSON\.stringify\(value\);\s*\}/);
  assert.match(source, /input\.parsedSource\.description \? `description: \$\{yamlStringValue\(input\.parsedSource\.description\)\}` : undefined,/);
  assert.match(source, /`name: \$\{input\.targetName\}`/);
  assert.match(source, /input\.resolvedModel \? `model: \$\{input\.resolvedModel\}` : undefined,/);
  assert.match(source, /input\.parsedSource\.tools\?\.length \? `tools: \$\{input\.parsedSource\.tools\.join\(", "\)\}` : undefined,/);
  assert.match(source, /frontmatter\}\\n\$\{metadata\}\\n\\n\$\{body\}/);
  assert.match(source, /source-sha256/);
  assert.match(source, /model-profile-key/);
  assert.match(source, /model-resolution-source/);
  assert.match(source, /models-config-sha256/);
  assert.match(source, /generated-at/);
});

test('Arc materializer preserves non-generated files and reports project shadows', async () => {
  const mod = await import('../extensions/arc/subagents.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'arc-subagents-'));
  try {
    const cwd = path.join(root, 'project', 'child');
    const homeDir = path.join(root, 'home');
    const agentsDir = path.join(root, 'agents');
    await mkdir(cwd, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });

    const targetDir = mod.resolveArcSubagentDir('user', cwd, homeDir);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'arc-builder.md'), '', 'utf8');

    const projectAgentsDir = path.join(cwd, '.pi', 'agents');
    const legacyProjectAgentsDir = path.join(cwd, '.agents');
    await mkdir(projectAgentsDir, { recursive: true });
    await mkdir(legacyProjectAgentsDir, { recursive: true });
    await writeFile(path.join(projectAgentsDir, 'arc-builder.md'), renderTestAgent(mod, 'builder', 'arc-builder'), 'utf8');
    await writeFile(path.join(legacyProjectAgentsDir, 'arc-doc-writer.md'), 'custom project shadow', 'utf8');

    const result = await mod.materializeArcSubagents({
      reason: 'manual_repair',
      scope: 'user',
      cwd,
      homeDir,
      agentsDir,
      modelsConfigSha256: 'models-hash',
      renderAgent: async (source, target) => renderTestAgent(mod, source, target),
    });

    const builder = result.writes.find((entry) => entry.agent === 'arc-builder');
    assert.equal(builder?.status, 'skipped');
    assert.equal(await readFile(path.join(targetDir, 'arc-builder.md'), 'utf8'), '');
    assert.ok(result.shadows.some((shadow) => shadow.projectPath.endsWith(path.join('.pi', 'agents', 'arc-builder.md'))));
    assert.ok(result.shadows.some((shadow) => shadow.projectPath.endsWith(path.join('.agents', 'arc-doc-writer.md'))));
    assert.ok(result.shadows.every((shadow) => shadow.message.includes('project scope wins over user scope')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Arc materializer falls back to legacy user directory when modern user directory is unavailable', async () => {
  const mod = await import('../extensions/arc/subagents.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'arc-subagents-'));
  try {
    const cwd = path.join(root, 'project');
    const homeDir = path.join(root, 'home');
    const agentsDir = path.join(root, 'agents');
    await mkdir(cwd, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(homeDir, '.agents'), 'not a directory', 'utf8');

    const result = await mod.materializeArcSubagents({
      reason: 'session_start',
      scope: 'user',
      cwd,
      homeDir,
      agentsDir,
      modelsConfigSha256: 'models-hash',
      allowLegacyUserDirFallback: true,
      renderAgent: async (source, target) => renderTestAgent(mod, source, target),
    });

    const legacyDir = path.join(homeDir, '.pi', 'agent', 'agents');
    assert.equal(result.targetDir, legacyDir);
    assert.equal(result.writes.filter((entry) => entry.status === 'written').length, mod.ARC_PI_SUBAGENTS.length);
    assert.match(await readFile(path.join(legacyDir, 'arc-builder.md'), 'utf8'), /name: arc-builder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Arc materializer reports modern per-file target failures instead of legacy fallback', async () => {
  const mod = await import('../extensions/arc/subagents.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'arc-subagents-'));
  try {
    const cwd = path.join(root, 'project');
    const homeDir = path.join(root, 'home');
    const agentsDir = path.join(root, 'agents');
    await mkdir(cwd, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });

    const modernDir = path.join(homeDir, '.agents');
    await mkdir(path.join(modernDir, 'arc-doc-writer.md'), { recursive: true });

    const result = await mod.materializeArcSubagents({
      reason: 'session_start',
      scope: 'user',
      cwd,
      homeDir,
      agentsDir,
      modelsConfigSha256: 'models-hash',
      allowLegacyUserDirFallback: true,
      renderAgent: async (source, target) => renderTestAgent(mod, source, target),
    });

    assert.equal(result.targetDir, modernDir);
    const failed = result.writes.find((entry) => entry.agent === 'arc-doc-writer');
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.reason ?? '', /could not read existing target:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Arc source agents document optional supervisor escalation without bundling pi-intercom', () => {
  for (const file of [
    'agents/builder.md',
    'agents/code-reviewer.md',
    'agents/doc-writer.md',
    'agents/evaluator.md',
    'agents/issue-manager.md',
    'agents/spec-reviewer.md',
  ]) {
    const source = read(file);
    assert.match(source, /## Supervisor Escalation/);
    assert.match(source, /contact_supervisor/);
    assert.match(source, /Never invent an intercom target/);
    assert.match(source, /Do not send routine completion handoffs|do not send routine completion handoffs/i);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['pi-intercom'], undefined);
  assert.ok(!pkg.bundledDependencies.includes('pi-intercom'));
});

test('Arc subagent markdown render runtime output matches expected structure', async () => {
  const mod = await import('../extensions/arc/subagents.ts');
  const output = mod.buildArcSubagentMarkdown({
    targetName: 'arc-issue-manager',
    sourceName: 'issue-manager',
    sourceMarkdown: '---\nname: issue-manager\n---\n# Arc Issue Tracker Agent',
    parsedSource: {
      prompt: '# Arc Issue Tracker Agent',
      description: 'Use this agent when creating issues. This includes: epics, tasks, labels.',
      tools: ['bash', 'read', 'grep'],
    },
    resolvedModel: 'openai-codex/gpt-5.4-mini',
    modelProfileKey: 'issueManager',
    modelResolutionSource: 'profile',
    modelsConfigHash: 'abc123',
    generatedAt: '2026-05-03T00:00:00.000Z',
  });

  assert.ok(output.startsWith('---\nname: arc-issue-manager'));
  assert.ok(output.includes('description: "Use this agent when creating issues. This includes: epics, tasks, labels."'));
  assert.ok(output.includes('model: openai-codex/gpt-5.4-mini'));
  assert.ok(output.includes('tools: bash, read, grep'));
  assert.ok(output.includes('systemPromptMode: replace'));
  assert.ok(output.includes('inheritProjectContext: true'));
  assert.ok(output.includes('inheritSkills: false'));

  const frontmatterEnd = output.indexOf('\n---\n');
  const metadataStart = output.indexOf('\n<!-- generated by @sentiolabs/pi-arc arc-subagents -->');
  assert.ok(frontmatterEnd >= 0, 'frontmatter should have closing delimiter');
  assert.ok(metadataStart > frontmatterEnd, 'metadata marker must be after frontmatter');

  assert.ok(output.includes('source-sha256: '));
  assert.ok(output.includes('model-profile-key: issueManager'));
  assert.ok(output.includes('model-resolution-source: profile'));
  assert.ok(output.includes('models-config-sha256: abc123'));
  assert.ok(output.includes('generated-at: 2026-05-03T00:00:00.000Z'));
  assert.ok(output.includes('\n\n# Arc Issue Tracker Agent'));
});
