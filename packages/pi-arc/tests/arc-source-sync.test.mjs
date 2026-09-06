import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('migration script documents configurable source path', () => {
  const help = execFileSync('python3', ['scripts/migrate-arc-plugin.py', '--help'], { encoding: 'utf8' });
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
  assert.match(help, /Claude Arc plugin source/);
});

test('migration script validates source before rewriting resources', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /import argparse/);
  assert.match(source, /expanduser\(\)\.resolve\(\)/);
  assert.match(source, /DEFAULT_SOURCE_CANDIDATES/);
  assert.match(source, /bfirestone\/agent-marketplace\/claude-marketplace\/plugins\/arc/);
  assert.match(source, /tempfile\.mkdtemp/);
  assert.match(source, /install_generated_resources/);
  assert.match(source, /REPO_ROOT\.parents\[1\]\.parent \/ "agent-nexus\/claude-marketplace\/plugins\/arc"/);
  assert.match(source, /Path\.home\(\) \/ "devspace\/personal\/sentiolabs\/agent-nexus\/claude-marketplace\/plugins\/arc"/);
  assert.match(source, /def validate_source/);
  assert.match(source, /"commands"/);
  assert.match(source, /"skills"/);
  assert.match(source, /"agents"/);
  assert.match(source, /"\.claude-plugin\/plugin\.json"/);
});

test('arc-source-sync skill is repo-local and maintainer-only', () => {
  const source = read('../../.pi/skills/arc-source-sync/SKILL.md');
  assert.equal(existsSync('skills/arc-source-sync/SKILL.md'), false);
  assert.match(source, /name: arc-source-sync/);
  assert.match(source, /repo-local maintainer-only/i);
  assert.match(source, /intentionally not shipped in the `@sentiolabs\/pi-arc` npm package/);
  assert.match(source, /Never blindly copy/);
  assert.match(source, /python3 scripts\/migrate-arc-plugin\.py "\$SOURCE"/);
  assert.match(source, /Release Please-managed/);
});

test('arc-source-sync codifies reproducible Pi adaptation loop', () => {
  const source = read('../../.pi/skills/arc-source-sync/SKILL.md');
  assert.match(source, /Quality bar/i);
  assert.match(source, /tests as executable Pi contracts/);
  assert.match(source, /Adapt Pi-Specific Patches/);
  assert.match(source, /git show HEAD:<path>/);
  assert.match(source, /diff -u \/tmp\/pi-arc-sync\.before\.diff \/tmp\/pi-arc-sync\.after\.diff/);
  assert.match(source, /Only update tests when the intended Pi contract has genuinely changed/);
  assert.match(source, /Review-only code-reviewer dispatch prompt/);
  assert.match(source, /Parallel readiness contract/);
  assert.match(source, /auto-materialized Arc `pi-subagents` specialists/);
  assert.match(source, /git push/);
  assert.match(source, /Do not tell the user "ready to push"/);
});

test('migration preserves the general Arc model-policy guidance', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'pi-arc-model-policy-'));
  const packageRoot = path.join(fixture, 'pi-arc');
  const scriptPath = path.join(packageRoot, 'scripts', 'model-policy-overlay.py');
  const migration = read('scripts/migrate-arc-plugin.py');
  const helperStart = migration.indexOf('def insert_before_if_missing(');
  const helperEnd = migration.indexOf('\n\npatch_file("skills/arc/_branch-check.md", [', helperStart);
  const overlayStart = migration.indexOf('insert_before_if_missing(\n    "skills/arc/SKILL.md",');
  const overlayEnd = migration.indexOf('\n)\n\npatch_file("skills/arc-brainstorm/SKILL.md", [', overlayStart);

  try {
    assert.notEqual(helperStart, -1, 'missing model-policy overlay helper');
    assert.notEqual(helperEnd, -1, 'missing model-policy overlay helper boundary');
    assert.notEqual(overlayStart, -1, 'missing model-policy overlay');
    assert.notEqual(overlayEnd, -1, 'missing model-policy overlay boundary');
    mkdirSync(path.join(packageRoot, 'skills', 'arc'), { recursive: true });
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(path.join(packageRoot, 'skills', 'arc', 'SKILL.md'), '# Arc\n\n## Quick Start\n');
    writeFileSync(
      scriptPath,
      `from pathlib import Path\nARC_ROOT = Path(__file__).resolve().parents[1]\n\n${migration.slice(helperStart, helperEnd)}\n${migration.slice(overlayStart, overlayEnd + 2)}\n`,
    );
    execFileSync('python3', [scriptPath], { cwd: packageRoot, stdio: 'pipe' });

    const arcSkill = readFileSync(path.join(packageRoot, 'skills', 'arc', 'SKILL.md'), 'utf8');
    assert.match(arcSkill, /## Model policy/);
    assert.match(arcSkill, /Arc recommends Luna for low-cost issue-manager\/docs work/);
    assert.match(arcSkill, /\[arc-build model selection\]\(\.\.\/arc-build\/SKILL\.md#model-selection\)/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('failed regeneration leaves installed resources untouched', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'pi-arc-invalid-source-'));
  const protectedPath = 'skills/arc/SKILL.md';
  const before = read(protectedPath);
  try {
    for (const directory of ['commands', 'skills', 'agents', '.claude-plugin']) {
      mkdirSync(path.join(fixture, directory), { recursive: true });
    }
    writeFileSync(path.join(fixture, '.claude-plugin', 'plugin.json'), '{}\n');

    assert.throws(() => execFileSync('python3', ['scripts/migrate-arc-plugin.py', fixture], { encoding: 'utf8', stdio: 'pipe' }));
    assert.equal(read(protectedPath), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('migration script excludes upstream eval fixtures without preserving package-local maintainer skills', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /PI_LOCAL_SKILL_DIRS = set\(\)/);
  assert.match(source, /ignore=shutil\.ignore_patterns\("evals"\)/);
  assert.equal(existsSync('skills/arc-source-sync/SKILL.md'), false);
  assert.equal(existsSync('skills/arc-brainstorm/evals'), false);
  assert.equal(existsSync('skills/arc-plan/evals'), false);
});

test('migration script rewrites renamed skill path references', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /skills\/brainstorm\/SKILL\.md", "skills\/arc-brainstorm\/SKILL\.md/);
  assert.match(source, /skills\/plan\/SKILL\.md", "skills\/arc-plan\/SKILL\.md/);

  const arcSkill = read('skills/arc/SKILL.md');
  assert.match(arcSkill, /skills\/arc-brainstorm\/SKILL\.md/);
  assert.match(arcSkill, /skills\/arc-plan\/SKILL\.md/);
  assert.doesNotMatch(arcSkill, /skills\/(brainstorm|plan)\/SKILL\.md/);
});

test('migration preserves Pi-native guarded session arguments in operational resources', () => {
  const migration = read('scripts/migrate-arc-plugin.py');
  assert.match(migration, /ARC_SESSION_ID", "PI_SESSION_ID/);
  const transformStart = migration.indexOf('skill_map = {');
  const transformEnd = migration.indexOf('\nfor src_dir in sorted', transformStart);
  const fixture = mkdtempSync(path.join(tmpdir(), 'pi-arc-session-transform-'));
  const script = path.join(fixture, 'transform.py');
  try {
    writeFileSync(script, `import re\n${migration.slice(transformStart, transformEnd)}\nprint(transform_text('arc update <id> --take --session-id "\${ARC_SESSION_ID:?ARC_SESSION_ID is required}"\\narc prime --session-id "\${ARC_SESSION_ID:?ARC_SESSION_ID is required}"'))\n`);
    const transformed = execFileSync('python3', [script], { encoding: 'utf8' });
    assert.doesNotMatch(transformed, /ARC_SESSION_ID/);
    assert.match(transformed, /\$\{PI_SESSION_ID:\?PI_SESSION_ID is required\}/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  const files = execFileSync('find', ['prompts', 'skills', 'agents', '-name', '*.md'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      if (/arc update .*--take/.test(line)) {
        assert.match(line, /--session-id "\$\{PI_SESSION_ID:\?PI_SESSION_ID is required\}"/, file);
      }
      if (/(^\s*arc prime|`arc prime)/.test(line) && !/automatically/.test(line)) {
        assert.match(line, /--session-id "\$\{PI_SESSION_ID:\?PI_SESSION_ID is required\}"/, file);
      }
    }
  }
});

test('packaged Pi claim and prime commands preserve a guarded session ID as one argv value', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'pi-arc-session-command-'));
  const bin = path.join(fixture, 'bin');
  const capture = path.join(fixture, 'argv.json');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'arc'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARC_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))\n');
  chmodSync(path.join(bin, 'arc'), 0o755);

  try {
    for (const [file, prefix] of [
      ['skills/arc-build/SKILL.md', 'arc update <task-id> --take'],
      ['prompts/arc-prime.md', 'arc prime'],
    ]) {
      const source = read(file);
      const line = source.split('\n').find((candidate) => candidate.includes(prefix));
      assert.ok(line, `missing command in ${file}`);
      assert.match(line, /--session-id "\$\{PI_SESSION_ID:\?PI_SESSION_ID is required\}"/);
      const command = (line.match(/`([^`]+)`/)?.[1] ?? line.trim()).replace(/<[^>]+>/g, 'task-1');
      const sessionID = 'pi session; $(never)';
      const result = spawnSync('sh', ['-c', command], {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ARC_TEST_CAPTURE: capture, ARC_SESSION_ID: 'inherited arc', CODEX_THREAD_ID: 'inherited Codex', PI_SESSION_ID: sessionID },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')).slice(-2), ['--session-id', sessionID]);

      rmSync(capture, { force: true });
      const missing = spawnSync('sh', ['-c', command], {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ARC_TEST_CAPTURE: capture, ARC_SESSION_ID: 'inherited arc', CODEX_THREAD_ID: 'inherited Codex', PI_SESSION_ID: '' },
      });
      assert.notEqual(missing.status, 0, `${file} must guard PI_SESSION_ID`);
      assert.equal(existsSync(capture), false, `${file} must reject missing PI_SESSION_ID before running arc`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('arc extension does not ship arc-source-sync slash alias', () => {
  const source = read('extensions/arc.ts');
  assert.doesNotMatch(source, /command: "arc-source-sync"/);
  assert.doesNotMatch(source, /skill: "arc-source-sync"/);
  assert.match(source, /pi\.sendUserMessage\(`\/skill:\$\{skill\}\$\{args\.trim\(\)/);
});

test('README documents repo-local maintainer source sync', () => {
  const source = read('README.md');
  assert.match(source, /Maintainer source sync/);
  assert.match(source, /repo-local maintainer skill/);
  assert.match(source, /intentionally not shipped in the `@sentiolabs\/pi-arc` package/);
  assert.match(source, /\/skill:arc-source-sync ~\/devspace\/personal\/sentiolabs\/agent-nexus\/claude-marketplace\/plugins\/arc/);
  assert.match(source, /python3 scripts\/migrate-arc-plugin\.py --source ~\/foo\/bar\/arc/);
});

test('README documents the planner-only review surface', () => {
  const source = read('README.md');
  assert.match(source, /Plan review surface/);
  assert.match(source, /arc plan create --no-frontmatter <file>/);
  assert.match(source, /arc-review: id=<id>/);
  assert.doesNotMatch(source, /arc share create|share-local|share-remote|kind=legacy/);
});
