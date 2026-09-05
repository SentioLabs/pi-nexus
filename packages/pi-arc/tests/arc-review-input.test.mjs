import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureArcPrimaryBaseline, compareArcPrimaryBaseline } from '../extensions/arc/review-baseline.ts';
import { prepareArcReviewInput, verifyArcReviewInput } from '../extensions/arc/review-input.ts';

const exec = promisify(execFile);
const limits = { maxFiles: 100, maxTotalBytes: 2 * 1024 * 1024, maxFileBytes: 512 * 1024, maxProcessOutputBytes: 64 * 1024, maxGitOutputBytes: 1024 * 1024 };
async function git(repo, ...args) { return (await exec('git', args, { cwd: repo, env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })).stdout.trim(); }

async function makeFakeGit() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-fake-git-'));
  const realGit = (await exec('sh', ['-c', 'command -v git'], { env: { ...process.env } })).stdout.trim();
  const file = path.join(directory, 'git');
  await fs.writeFile(file, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.ARC_FAKE_GIT_MODE;
const command = args.find((value) => ['ls-tree','cat-file'].includes(value));
if (mode === 'cat-epipe' && command === 'ls-tree') {
  const result = spawnSync(${JSON.stringify(realGit)}, args);
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  const bytes = Buffer.from(result.stdout); const tab = bytes.indexOf(9);
  const header = bytes.subarray(0, tab + 1);
  for (let index = 0; index < 30000; index++) process.stdout.write(Buffer.concat([header, Buffer.from('epipe-' + String(index).padStart(5, '0')), Buffer.from([0])]));
} else if (mode?.startsWith('tree-') && command === 'ls-tree') {
  const result = spawnSync(${JSON.stringify(realGit)}, args);
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1); }
  const bytes = Buffer.from(result.stdout); const tab = bytes.indexOf(9); const nul = bytes.indexOf(0, tab);
  const replacement = mode === 'tree-traversal' ? Buffer.from('../escape') : mode === 'tree-absolute' ? Buffer.from('/escape') : Buffer.from([0xff]);
  const changed = Buffer.concat([bytes.subarray(0, tab + 1), replacement, bytes.subarray(nul)]);
  process.stdout.write(mode === 'tree-duplicate' ? Buffer.concat([bytes.subarray(0, nul + 1), bytes]) : changed);
} else if (command === 'cat-file' && mode?.startsWith('cat-')) {
  if (mode === 'cat-epipe') process.exit(23);
  if (mode === 'cat-nonzero') { process.stderr.write('cat-file unreadable fixture'); process.exit(17); }
  const query = fs.readFileSync(0, 'ascii'); const oid = query.split('\\n')[0];
  const real = spawnSync(${JSON.stringify(realGit)}, args, { input: query });
  if (mode === 'cat-missing') process.stdout.write(oid + ' missing\\n');
  else if (mode === 'cat-header') process.stdout.write(oid + ' blob');
  else if (mode === 'cat-payload') process.stdout.write(real.stdout.subarray(0, Math.max(0, real.stdout.length - 2)));
  else if (mode === 'cat-nonblob') process.stdout.write(oid + ' commit 1\\nx\\n');
  else if (mode === 'cat-trailing') process.stdout.write(Buffer.concat([real.stdout, Buffer.from('x')]));
  else if (mode === 'cat-early-close') process.exit(0);
} else {
  const result = spawnSync(${JSON.stringify(realGit)}, args, { input: fs.readFileSync(0) });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
`);
  await fs.chmod(file, 0o755);
  return directory;
}

async function makeRange({ objectFormat } = {}) {
  const repo = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-input-repo-'));
  const destinationRoot = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-input-dest-'));
  await git(repo, 'init', ...(objectFormat ? [`--object-format=${objectFormat}`] : []), '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, 'gone.txt'), 'gone from head\n');
  await fs.writeFile(path.join(repo, 'modified.txt'), 'old\n');
  await fs.writeFile(path.join(repo, 'deleted-in-worktree.txt'), 'tracked in head\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'base');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  await fs.unlink(path.join(repo, 'gone.txt'));
  await fs.writeFile(path.join(repo, 'modified.txt'), 'new\n');
  await fs.writeFile(path.join(repo, 'binary.dat'), Buffer.from([0, 255, 254, 65]));
  await fs.writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\necho yes\n');
  await fs.chmod(path.join(repo, 'run.sh'), 0o755);
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'head');
  const headSha = await git(repo, 'rev-parse', 'HEAD');
  return { repo, destinationRoot, baseSha, headSha };
}

function request(range, overrides = {}) {
  return {
    repositoryRoot: range.repo, baseSha: range.baseSha, headSha: range.headSha,
    destinationRoot: range.destinationRoot, taskContext: 'Task context\n', designContext: 'Design context\n', reviewContext: 'Review context\n',
    repositoryInstructions: [{ source: 'AGENTS.md', content: 'Repository instruction\n' }], limits, ...overrides,
  };
}

async function snapshotPrimary(repo) {
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['refs/heads/main'], limits });
  const index = await fs.readFile(path.join(repo, '.git', 'index'));
  const indexStat = await fs.stat(path.join(repo, '.git', 'index'), { bigint: true });
  return { baseline, index, mtimeNs: indexStat.mtimeNs };
}

async function assertPrimarySame(before, repo) {
  assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'index')), before.index);
  assert.equal((await fs.stat(path.join(repo, '.git', 'index'), { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal((await compareArcPrimaryBaseline(before.baseline, limits)).state, 'unchanged');
}

test('exports exact committed binary source, deletion, immutable modes, materials, and digest', async () => {
  const range = await makeRange();
  await fs.writeFile(path.join(range.repo, 'modified.txt'), 'dirty checkout not reviewed\n');
  await fs.writeFile(path.join(range.repo, 'untracked'), Buffer.from([9, 0, 8]));
  await fs.unlink(path.join(range.repo, 'deleted-in-worktree.txt'));
  const before = await snapshotPrimary(range.repo);
  assert.deepEqual(before.baseline.tracked.find((row) => row.path === 'deleted-in-worktree.txt'), { path: 'deleted-in-worktree.txt', kind: 'missing' });
  const expectedPatch = (await exec('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', range.baseSha, range.headSha, '--'], {
    cwd: range.repo, env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' }, encoding: 'buffer',
  })).stdout;
  const prepared = await prepareArcReviewInput(request(range));
  await assertPrimarySame(before, range.repo);
  assert.deepEqual(await fs.readFile(path.join(prepared.sourceRoot, 'binary.dat')), Buffer.from([0, 255, 254, 65]));
  assert.equal(await fs.readFile(path.join(prepared.sourceRoot, 'modified.txt'), 'utf8'), 'new\n');
  assert.equal((await fs.stat(path.join(prepared.sourceRoot, 'binary.dat'))).mode & 0o777, 0o400);
  assert.equal((await fs.stat(path.join(prepared.sourceRoot, 'run.sh'))).mode & 0o777, 0o500);
  const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.source.find((x) => x.path === 'run.sh').gitMode, '100755');
  assert.equal(manifest.source.find((x) => x.path === 'binary.dat').gitMode, '100644');
  assert.equal(manifest.changes.find((x) => x.path === 'gone.txt').status, 'deleted');
  assert.equal(manifest.changes.find((x) => x.path === 'gone.txt').headObjectId, undefined);
  assert.equal(manifest.source.some((x) => x.path === 'manifest.json'), false);
  assert.equal(manifest.materials.some((x) => x.path === 'manifest.json'), false);
  const expectedMaterials = new Map([
    ['materials/task.md', Buffer.from('Task context\n')],
    ['materials/design.md', Buffer.from('Design context\n')],
    ['materials/review.md', Buffer.from('Review context\n')],
    ['materials/instructions/0001.md', Buffer.from('Repository instruction\n')],
    ['materials/diff.patch', expectedPatch],
  ]);
  assert.deepEqual(manifest.materials.map((x) => x.path), [
    'materials/design.md', 'materials/diff.patch', 'materials/instructions/0001.md', 'materials/review.md', 'materials/task.md',
  ]);
  for (const row of manifest.materials) {
    const file = path.join(prepared.inputRoot, ...row.path.split('/'));
    assert.equal(row.physicalMode, '0400');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o400);
    assert.deepEqual(await fs.readFile(file), expectedMaterials.get(row.path));
  }
  assert.equal((await fs.stat(prepared.inputRoot)).mode & 0o777, 0o500);
  assert.equal((await fs.stat(prepared.manifestPath)).mode & 0o777, 0o400);
  assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'unchanged');
  assert.ok(prepared.fileCount >= manifest.source.length + manifest.materials.length + 1);
  await fs.writeFile(path.join(range.repo, 'deleted-in-worktree.txt'), 'restored externally');
  assert.equal((await compareArcPrimaryBaseline(before.baseline, limits)).state, 'changed');
});

test('verification detects byte, mode, removal, and additions and reports unreadable roots', async () => {
  for (const mutate of [
    async (p) => { await fs.chmod(path.join(p.sourceRoot, 'binary.dat'), 0o600); await fs.writeFile(path.join(p.sourceRoot, 'binary.dat'), 'tampered'); },
    async (p) => { await fs.chmod(path.join(p.sourceRoot, 'binary.dat'), 0o600); },
    async (p) => { await fs.chmod(p.sourceRoot, 0o700); await fs.chmod(path.join(p.sourceRoot, 'binary.dat'), 0o600); await fs.unlink(path.join(p.sourceRoot, 'binary.dat')); },
    async (p) => { await fs.chmod(p.sourceRoot, 0o700); await fs.writeFile(path.join(p.sourceRoot, 'extra'), 'extra'); },
    async (p) => { await fs.chmod(p.sourceRoot, 0o700); await fs.mkdir(path.join(p.sourceRoot, 'empty'), { mode: 0o500 }); },
  ]) {
    const range = await makeRange(); const prepared = await prepareArcReviewInput(request(range));
    await mutate(prepared);
    assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'changed');
  }
  const range = await makeRange(); const prepared = await prepareArcReviewInput(request(range));
  await fs.rename(prepared.inputRoot, `${prepared.inputRoot}.gone`);
  assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'unreadable');
});

test('rejects abbreviated, uppercase, nonhex, missing commits and non-ancestor ranges', async () => {
  const range = await makeRange();
  const other = await git(range.repo, 'commit-tree', `${range.headSha}^{tree}`, '-m', 'unrelated');
  for (const overrides of [
    { headSha: range.headSha.slice(0, 8) }, { headSha: range.headSha.toUpperCase() }, { headSha: 'z'.repeat(40) },
    { headSha: 'a'.repeat(40) }, { baseSha: range.headSha, headSha: range.baseSha }, { baseSha: other },
  ]) {
    const before = await snapshotPrimary(range.repo);
    await assert.rejects(() => prepareArcReviewInput(request(range, overrides)), /commit|ancestor|object|sha/i);
    await assertPrimarySame(before, range.repo);
  }
});

test('accepts and exports a full SHA-256 committed range', async () => {
  const range = await makeRange({ objectFormat: 'sha256' });
  assert.match(range.baseSha, /^[0-9a-f]{64}$/);
  assert.match(range.headSha, /^[0-9a-f]{64}$/);
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: range.repo, reviewedRefs: ['refs/heads/main'], limits });
  const prepared = await prepareArcReviewInput(request(range));
  const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, 'utf8'));
  assert.equal(manifest.baseSha, range.baseSha);
  assert.equal(manifest.headSha, range.headSha);
  assert.equal(manifest.changes.find((row) => row.path === 'gone.txt').status, 'deleted');
  assert.deepEqual(await fs.readFile(path.join(prepared.sourceRoot, 'binary.dat')), Buffer.from([0, 255, 254, 65]));
  assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'unchanged');
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unchanged');
});

test('fails closed on symlinks, gitlinks, case and Unicode normalization collisions', async () => {
  for (const kind of ['symlink', 'gitlink', 'case', 'unicode']) {
    const range = await makeRange();
    if (kind === 'symlink') { await fs.symlink('modified.txt', path.join(range.repo, 'link')); await git(range.repo, 'add', 'link'); }
    if (kind === 'gitlink') await git(range.repo, 'update-index', '--add', '--cacheinfo', `160000,${range.headSha},nested`);
    if (kind === 'case') { await fs.writeFile(path.join(range.repo, 'Name'), 'a'); await fs.writeFile(path.join(range.repo, 'name'), 'b'); await git(range.repo, 'add', 'Name', 'name'); }
    if (kind === 'unicode') { await fs.writeFile(path.join(range.repo, 'é'), 'a'); await fs.writeFile(path.join(range.repo, 'é'), 'b'); await git(range.repo, 'add', 'é', 'é'); }
    await git(range.repo, 'commit', '-qm', kind);
    range.headSha = await git(range.repo, 'rev-parse', 'HEAD');
    const before = await snapshotPrimary(range.repo);
    await assert.rejects(() => prepareArcReviewInput(request(range)), /mode|symlink|gitlink|collision|normalization/i);
    await assertPrimarySame(before, range.repo);
  }
});

test('rejects collisions in nested directory components using deterministic Unicode caseless keys', async () => {
  for (const [left, right] of [['Dir/a', 'dir/b'], ['é/a', 'é/b'], ['σ/a', 'ς/b']]) {
    const range = await makeRange();
    await fs.mkdir(path.join(range.repo, path.dirname(left)), { recursive: true });
    await fs.mkdir(path.join(range.repo, path.dirname(right)), { recursive: true });
    await fs.writeFile(path.join(range.repo, left), 'left');
    await fs.writeFile(path.join(range.repo, right), 'right');
    await git(range.repo, 'add', left, right);
    await git(range.repo, 'commit', '-qm', 'nested collision');
    range.headSha = await git(range.repo, 'rev-parse', 'HEAD');
    const before = await snapshotPrimary(range.repo);
    await assert.rejects(() => prepareArcReviewInput(request(range)), /collision|normalization|case-fold/i);
    await assertPrimarySame(before, range.repo);
  }
});

test('rejects sharp-s case expansion collisions at leaves and directory prefixes', async () => {
  for (const [left, right] of [['ẞ.txt', 'ß.txt'], ['ẞ/a', 'ß/b']]) {
    const range = await makeRange();
    await fs.mkdir(path.join(range.repo, path.dirname(left)), { recursive: true });
    await fs.mkdir(path.join(range.repo, path.dirname(right)), { recursive: true });
    await fs.writeFile(path.join(range.repo, left), 'left');
    await fs.writeFile(path.join(range.repo, right), 'right');
    await git(range.repo, 'add', left, right);
    await git(range.repo, 'commit', '-qm', 'sharp-s collision');
    range.headSha = await git(range.repo, 'rev-parse', 'HEAD');
    const before = await snapshotPrimary(range.repo);
    await assert.rejects(() => prepareArcReviewInput(request(range)), /collision|case-fold/i);
    await assertPrimarySame(before, range.repo);
    assert.deepEqual(await fs.readdir(range.destinationRoot), []);
  }
});

test('rejects traversal and malformed, missing, unreadable, truncated, non-blob, trailing, and early-close batch responses', async () => {
  const fakeDirectory = await makeFakeGit();
  const originalPath = process.env.PATH;
  try {
    for (const mode of ['tree-traversal', 'tree-absolute', 'tree-invalid-utf8', 'tree-duplicate', 'cat-missing', 'cat-nonzero', 'cat-header', 'cat-payload', 'cat-nonblob', 'cat-trailing', 'cat-early-close']) {
      const range = await makeRange();
      const before = await snapshotPrimary(range.repo);
      process.env.PATH = `${fakeDirectory}${path.delimiter}${originalPath}`;
      process.env.ARC_FAKE_GIT_MODE = mode;
      await assert.rejects(() => prepareArcReviewInput(request(range)), /path|absolute|segment|UTF-8|duplicate|cat-file|batch|missing|truncated|blob|trailing/i, mode);
      delete process.env.ARC_FAKE_GIT_MODE;
      process.env.PATH = originalPath;
      await assertPrimarySame(before, range.repo);
      assert.deepEqual(await fs.readdir(range.destinationRoot), []);
    }
  } finally {
    delete process.env.ARC_FAKE_GIT_MODE;
    process.env.PATH = originalPath;
  }
});

test('rejects a destination inside the canonical checkout when repositoryRoot is nested', async () => {
  const range = await makeRange();
  const nestedRoot = path.join(range.repo, 'nested-cwd');
  const destinationRoot = path.join(range.repo, 'output');
  await fs.mkdir(nestedRoot);
  await fs.mkdir(destinationRoot);
  const before = await snapshotPrimary(range.repo);
  await assert.rejects(
    () => prepareArcReviewInput(request(range, { repositoryRoot: nestedRoot, destinationRoot })),
    /repositoryRoot.*Git worktree root|independent.*checkout/i,
  );
  await assertPrimarySame(before, range.repo);
  assert.deepEqual(await fs.readdir(destinationRoot), []);
});

test('disables Git replacement objects for immutable committed source export', async () => {
  const range = await makeRange();
  const originalObject = await git(range.repo, 'rev-parse', `${range.headSha}:modified.txt`);
  const evilPath = path.join(range.destinationRoot, 'evil-blob');
  await fs.writeFile(evilPath, 'evil replacement\n');
  const replacementObject = await git(range.repo, 'hash-object', '-w', evilPath);
  await git(range.repo, 'replace', originalObject, replacementObject);
  assert.equal(await git(range.repo, 'cat-file', 'blob', originalObject), 'evil replacement');
  const before = await snapshotPrimary(range.repo);
  const prepared = await prepareArcReviewInput(request(range));
  assert.equal(await fs.readFile(path.join(prepared.sourceRoot, 'modified.txt'), 'utf8'), 'new\n');
  const patch = await fs.readFile(prepared.diffPath, 'utf8');
  assert.match(patch, /\+new/);
  assert.doesNotMatch(patch, /evil replacement/);
  assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'unchanged');
  await assertPrimarySame(before, range.repo);
});

test('rejects destination symlinks and all declared size/count bounds', async () => {
  const range = await makeRange();
  const before = await snapshotPrimary(range.repo);
  const destinationLink = `${range.destinationRoot}-link`;
  await fs.symlink(range.destinationRoot, destinationLink);
  await assert.rejects(() => prepareArcReviewInput(request(range, { destinationRoot: destinationLink })), /symlink/i);
  await assertPrimarySame(before, range.repo);
  const realAncestor = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-real-ancestor-'));
  await fs.mkdir(path.join(realAncestor, 'child'));
  const linkedAncestor = `${realAncestor}-link`;
  await fs.symlink(realAncestor, linkedAncestor);
  await assert.rejects(() => prepareArcReviewInput(request(range, { destinationRoot: path.join(linkedAncestor, 'child') })), /symlink/i);
  await assertPrimarySame(before, range.repo);
  for (const constrained of [
    { ...limits, maxFiles: 1 }, { ...limits, maxFileBytes: 3 }, { ...limits, maxTotalBytes: 20 }, { ...limits, maxTotalBytes: 200 }, { ...limits, maxGitOutputBytes: 8 },
  ]) {
    await assert.rejects(() => prepareArcReviewInput(request(range, { limits: constrained })), /limit|exceeds|output|batch|file|Git|input bytes/i);
    assert.deepEqual(await fs.readdir(range.destinationRoot), []);
    await assertPrimarySame(before, range.repo);
  }
});

test('cat-file stdin EPIPE fails preparation and preserves primary state', async () => {
  const fakeDirectory = await makeFakeGit();
  const originalPath = process.env.PATH;
  const range = await makeRange();
  const before = await snapshotPrimary(range.repo);
  try {
    process.env.PATH = `${fakeDirectory}${path.delimiter}${originalPath}`;
    process.env.ARC_FAKE_GIT_MODE = 'cat-epipe';
    await assert.rejects(
      () => prepareArcReviewInput(request(range, { limits: { ...limits, maxFiles: 40_000, maxTotalBytes: 8 * 1024 * 1024, maxGitOutputBytes: 4 * 1024 * 1024 } })),
      (error) => { assert.match(error.message, /EPIPE/i); return true; },
    );
  } finally {
    delete process.env.ARC_FAKE_GIT_MODE;
    process.env.PATH = originalPath;
  }
  await assertPrimarySame(before, range.repo);
  assert.deepEqual(await fs.readdir(range.destinationRoot), []);
});

test('rejects a single cat-file response that cannot fit its per-batch output bound', async () => {
  const range = await makeRange();
  await fs.writeFile(path.join(range.repo, 'large-unchanged'), Buffer.alloc(2000, 0x61));
  await git(range.repo, 'add', '.'); await git(range.repo, 'commit', '-qm', 'large base');
  range.baseSha = await git(range.repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(range.repo, 'modified.txt'), 'tiny delta\n');
  await git(range.repo, 'add', '.'); await git(range.repo, 'commit', '-qm', 'small head');
  range.headSha = await git(range.repo, 'rev-parse', 'HEAD');
  const before = await snapshotPrimary(range.repo);
  await assert.rejects(() => prepareArcReviewInput(request(range, { limits: { ...limits, maxGitOutputBytes: 1000 } })), /blob response|maxGitOutputBytes/i);
  assert.deepEqual(await fs.readdir(range.destinationRoot), []);
  await assertPrimarySame(before, range.repo);
});

test('missing blob and batch limits fail without changing the primary checkout', async () => {
  const range = await makeRange();
  const object = await git(range.repo, 'rev-parse', `${range.headSha}:binary.dat`);
  const objectPath = path.join(range.repo, '.git', 'objects', object.slice(0, 2), object.slice(2));
  const before = await snapshotPrimary(range.repo);
  await fs.unlink(objectPath);
  await assert.rejects(() => prepareArcReviewInput(request(range)), /cat-file|missing|Git|ls-tree|object/i);
  await assertPrimarySame(before, range.repo);
});

test('partitions a binary export into multiple bounded cat-file batches', async () => {
  const range = await makeRange();
  for (let index = 0; index < 5; index++) await fs.writeFile(path.join(range.repo, `large-${index}`), Buffer.alloc(1000, index));
  await git(range.repo, 'add', '.'); await git(range.repo, 'commit', '-qm', 'large base');
  range.baseSha = await git(range.repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(range.repo, 'modified.txt'), 'small delta\n');
  await git(range.repo, 'add', '.'); await git(range.repo, 'commit', '-qm', 'small head');
  range.headSha = await git(range.repo, 'rev-parse', 'HEAD');
  // Tree/diff metadata fit, each response fits, while all blob responses do not.
  const prepared = await prepareArcReviewInput(request(range, { limits: { ...limits, maxGitOutputBytes: 4096 } }));
  assert.equal((await verifyArcReviewInput(prepared, limits)).state, 'unchanged');
});
