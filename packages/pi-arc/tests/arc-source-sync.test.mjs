import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  assert.match(source, /def validate_source/);
  assert.match(source, /"commands"/);
  assert.match(source, /"skills"/);
  assert.match(source, /"agents"/);
  assert.match(source, /"\.claude-plugin\/plugin\.json"/);
});

test('arc-source-sync skill exists and is maintainer-only', () => {
  const source = read('skills/arc-source-sync/SKILL.md');
  assert.match(source, /name: arc-source-sync/);
  assert.match(source, /maintainer-only/i);
  assert.match(source, /Never blindly copy/);
  assert.match(source, /python3 scripts\/migrate-arc-plugin\.py "\$SOURCE"/);
  assert.match(source, /Release Please-managed/);
});

test('migration script preserves Pi-only skills and excludes upstream eval fixtures', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /PI_LOCAL_SKILL_DIRS = \{"arc-source-sync"\}/);
  assert.match(source, /ignore=shutil\.ignore_patterns\("evals"\)/);
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

test('arc extension registers arc-source-sync slash alias', () => {
  const source = read('extensions/arc.ts');
  assert.match(source, /command: "arc-source-sync"/);
  assert.match(source, /skill: "arc-source-sync"/);
  assert.match(source, /Maintainer-only: sync pi-arc resources/);
  assert.match(source, /pi\.sendUserMessage\(`\/skill:\$\{skill\}\$\{args\.trim\(\)/);
});

test('README documents maintainer-only source sync', () => {
  const source = read('README.md');
  assert.match(source, /Maintainer source sync/);
  assert.match(source, /maintainer-only `\/arc-source-sync` skill\/command/);
  assert.match(source, /python3 scripts\/migrate-arc-plugin\.py --source ~\/foo\/bar\/arc/);
});

test('README documents arc share review surfaces', () => {
  const source = read('README.md');
  assert.match(source, /Plan review surfaces/);
  assert.match(source, /arc share create <file> --remote/);
  assert.match(source, /arc-review: kind=share-remote id=<id>/);
});
