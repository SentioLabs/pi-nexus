import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const UPSTREAM_ARC_SOURCE = '/Volumes/ExternalSamsung/devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/arc';

function read(path) {
  return readFileSync(path, 'utf8');
}

function looksLikeClaudeArcSource(root) {
  return ['commands', 'skills', 'agents', '.claude-plugin/plugin.json']
    .every((rel) => existsSync(join(root, rel)));
}

function snapshotTree(root) {
  const rows = [];
  function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const hash = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
      rows.push(`${relative(root, fullPath)}\0${hash}`);
    }
  }
  walk(root);
  return rows.join('\n');
}

function snapshotGeneratedResources(packageRoot) {
  return ['agents', 'prompts', 'skills']
    .map((rel) => `${rel}\n${snapshotTree(join(packageRoot, rel))}`)
    .join('\n---\n');
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

test('migration script codifies coder/devops split overlays', () => {
  const source = read('scripts/migrate-arc-plugin.py');
  assert.match(source, /f\.name == "builder\.md"/);
  assert.match(source, /dest_name = "coder\.md" if f\.name == "builder\.md" else f\.name/);
  assert.match(source, /PRESERVED_OVERLAY_FILES = \[/);
  assert.match(source, /"agents\/devops\.md"/);
  assert.match(source, /"skills\/arc-build\/SKILL\.md"/);
  assert.match(source, /overlay_text_by_rel\[rel\] = overlay_path\.read_text\(\)/);
  assert.match(source, /Missing required Pi overlay:/);
  assert.match(source, /md\.name == "builder-prompt\.md"/);
  assert.match(source, /md\.replace\(coder_prompt\)/);
  assert.match(source, /builder_prompt_path = ARC_ROOT \/ "skills" \/ "arc-build" \/ "builder-prompt\.md"/);
  assert.match(source, /builder_prompt_path\.unlink\(\)/);
  assert.doesNotMatch(source, /arc_agent\(agent=\\?"builder/);
});

test('migration script deterministically maps upstream builder resources to coder/devops overlays', (t) => {
  if (!looksLikeClaudeArcSource(UPSTREAM_ARC_SOURCE)) {
    t.skip(`Claude Arc source checkout not available at ${UPSTREAM_ARC_SOURCE}`);
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-arc-source-sync-'));
  const packageCopy = join(tempRoot, 'pi-arc');
  try {
    cpSync('.', packageCopy, { recursive: true });
    const originalDevopsOverlay = read('agents/devops.md');

    execFileSync('python3', ['scripts/migrate-arc-plugin.py', UPSTREAM_ARC_SOURCE], {
      cwd: packageCopy,
      encoding: 'utf8',
    });

    assert.equal(existsSync(join(packageCopy, 'agents/coder.md')), true);
    assert.equal(existsSync(join(packageCopy, 'agents/devops.md')), true);
    assert.equal(existsSync(join(packageCopy, 'agents/builder.md')), false);
    assert.equal(existsSync(join(packageCopy, 'skills/arc-build/coder-prompt.md')), true);
    assert.equal(existsSync(join(packageCopy, 'skills/arc-build/builder-prompt.md')), false);
    assert.equal(readFileSync(join(packageCopy, 'agents/devops.md'), 'utf8'), originalDevopsOverlay);

    const firstSnapshot = snapshotGeneratedResources(packageCopy);
    execFileSync('python3', ['scripts/migrate-arc-plugin.py', UPSTREAM_ARC_SOURCE], {
      cwd: packageCopy,
      encoding: 'utf8',
    });
    assert.equal(snapshotGeneratedResources(packageCopy), firstSnapshot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-local source sync contract preserves coder/devops split', () => {
  const source = read('../../.pi/skills/arc-source-sync/SKILL.md');
  assert.match(source, /coder\/devops split/i);
  assert.match(source, /agents\/builder\.md.*agents\/coder\.md/i);
  assert.match(source, /arc-coder/);
  assert.match(source, /arc-devops/);
  assert.match(source, /do not commit regenerated `packages\/pi-arc\/prompts`, `packages\/pi-arc\/skills`, or `packages\/pi-arc\/agents` output changes/i);
  assert.match(source, /ordinary source-sync tasks where regenerated resources are the intended deliverable/i);
  assert.match(source, /update `scripts\/migrate-arc-plugin\.py` so the guard is reproduced on every future sync/i);
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

test('README documents arc share review surfaces', () => {
  const source = read('README.md');
  assert.match(source, /Plan review surfaces/);
  assert.match(source, /arc share create <file> --remote/);
  assert.match(source, /arc-review: kind=share-remote id=<id>/);
});
