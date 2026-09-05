import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureArcPrimaryBaseline, compareArcPrimaryBaseline } from '../extensions/arc/review-baseline.ts';

const exec = promisify(execFile);
const limits = { maxFiles: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024, maxProcessOutputBytes: 64 * 1024, maxGitOutputBytes: 1024 * 1024 };

async function git(repo, ...args) {
  return (await exec('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } })).stdout.trim();
}

async function makeBaselineFakeGit() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-baseline-git-'));
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const file = path.join(directory, 'git');
  await fs.writeFile(file, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2); const mode = process.env.ARC_BASELINE_GIT_MODE;
if (args.includes('ls-files') && mode === 'unreadable') { process.stderr.write('fixture failure'); process.exit(2); }
if (args.includes('ls-files') && args.includes('--stage') && mode === 'inconsistent') {
  const state = process.env.ARC_BASELINE_GIT_STATE; let count = 0;
  try { count = Number(fs.readFileSync(state, 'utf8')); } catch {}
  fs.writeFileSync(state, String(count + 1));
  if (count > 0) process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { input: fs.readFileSync(0) });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
`);
  await fs.chmod(file, 0o755);
  return directory;
}

async function makeRepo() {
  const repo = await fs.mkdtemp(path.join(tmpdir(), 'pi-arc-baseline-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'committed\n');
  await fs.writeFile(path.join(repo, 'exec.sh'), '#!/bin/sh\n');
  await fs.chmod(path.join(repo, 'exec.sh'), 0o755);
  await fs.writeFile(path.join(repo, 'staged.txt'), 'base\n');
  await fs.writeFile(path.join(repo, 'deleted-in-worktree.txt'), 'present\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'base');
  await fs.writeFile(path.join(repo, 'staged.txt'), 'staged bytes\n');
  await git(repo, 'add', 'staged.txt');
  await fs.writeFile(path.join(repo, 'tracked.txt'), Buffer.from([0, 255, 65]));
  await fs.writeFile(path.join(repo, 'untracked.bin'), Buffer.from([1, 0, 254]));
  await fs.symlink('tracked.txt', path.join(repo, 'untracked-link'));
  await fs.mkdir(path.join(repo, 'cache'));
  await fs.writeFile(path.join(repo, 'cache', 'ignored'), 'ignored');
  return repo;
}

async function snapshotPrimaryBytes(repo) {
  const gitDir = path.join(repo, '.git');
  const names = ['HEAD', 'index', 'refs/heads/main', 'refs/heads/sibling'];
  const metadata = {};
  for (const name of names) {
    const file = path.join(gitDir, name);
    try {
      const stat = await fs.lstat(file);
      metadata[name] = { bytes: (await fs.readFile(file)).toString('base64'), mode: stat.mode, mtimeNs: stat.mtimeNs?.toString() ?? stat.mtimeMs };
    } catch (error) { if (error.code !== 'ENOENT') throw error; metadata[name] = null; }
  }
  for (const name of ['tracked.txt', 'staged.txt', 'exec.sh', 'deleted-in-worktree.txt', 'untracked.bin', 'untracked-link', 'cache/ignored']) {
    const file = path.join(repo, name);
    try {
      const stat = await fs.lstat(file);
      metadata[`work/${name}`] = stat.isSymbolicLink()
        ? { mode: stat.mode, target: await fs.readlink(file, 'buffer') }
        : { mode: stat.mode, bytes: (await fs.readFile(file)).toString('base64') };
    } catch (error) { if (error.code !== 'ENOENT') throw error; metadata[`work/${name}`] = null; }
  }
  return metadata;
}

test('captures Git-visible bytes without refresh and detects tracked changes', async () => {
  const repo = await makeRepo();
  const before = await snapshotPrimaryBytes(repo);
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['refs/heads/main'], limits });
  assert.deepEqual(await snapshotPrimaryBytes(repo), before);
  assert.equal(baseline.ignoredPolicy, 'excluded');
  assert.equal(baseline.symbolicHead, 'refs/heads/main');
  assert.equal(baseline.activeRef.name, 'refs/heads/main');
  assert.ok(baseline.tracked.some((row) => row.path === 'exec.sh' && row.mode === '0755'));
  assert.ok(baseline.untracked.some((row) => row.path === 'untracked-link' && row.kind === 'symlink' && row.target === 'tracked.txt'));
  assert.equal(baseline.untracked.some((row) => row.path.includes('cache')), false);
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unchanged');
  await fs.writeFile(path.join(repo, 'tracked.txt'), Buffer.from([0, 255]));
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'changed');
});

test('attests staged, mode, untracked, active/reviewed refs, and HEAD', async () => {
  const mutations = [
    async (repo) => { await fs.writeFile(path.join(repo, 'staged.txt'), 'new staged'); await git(repo, 'add', 'staged.txt'); },
    async (repo) => fs.chmod(path.join(repo, 'exec.sh'), 0o644),
    async (repo) => fs.writeFile(path.join(repo, 'untracked.bin'), 'changed'),
    async (repo) => git(repo, 'update-ref', 'refs/heads/main', 'HEAD~0^{commit}', `${await git(repo, 'rev-parse', 'refs/heads/main')}`),
    async (repo) => { await git(repo, 'checkout', '--detach', '-q'); },
  ];
  // Ref movement needs a distinct commit, unlike the other mutations.
  for (let index = 0; index < mutations.length; index++) {
    const repo = await makeRepo();
    const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['refs/heads/main'], limits });
    if (index === 3) {
      await git(repo, 'commit', '--allow-empty', '-qm', 'move');
    } else await mutations[index](repo);
    assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'changed', `mutation ${index}`);
  }
});

test('tolerates unrelated refs and supports detached HEAD', async () => {
  const repo = await makeRepo();
  await git(repo, 'branch', 'sibling');
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  const siblingCommit = await git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'sibling movement');
  await git(repo, 'update-ref', 'refs/heads/sibling', siblingCommit);
  assert.notEqual(siblingCommit, baseline.headSha);
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unchanged');

  await git(repo, 'checkout', '--detach', '-q');
  const detached = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  assert.equal(detached.symbolicHead, null);
  assert.equal(detached.activeRef, null);
  assert.equal((await compareArcPrimaryBaseline(detached, limits)).state, 'unchanged');
});

test('detects movement of a reviewed ref even when HEAD and its active ref do not move', async () => {
  const repo = await makeRepo();
  await git(repo, 'update-ref', 'refs/review/target', 'HEAD');
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['refs/review/target'], limits });
  const moved = await git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'review ref movement');
  await git(repo, 'update-ref', 'refs/review/target', moved);
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'changed');
});

test('accepts only exact full reviewed refs or immutable full SHAs', async () => {
  const repo = await makeRepo();
  await git(repo, 'update-ref', 'refs/review/target', 'HEAD');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const before = await snapshotPrimaryBytes(repo);
  await assert.rejects(
    () => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['refs/review/target^{tree}'], limits }),
    /reviewed ref name is invalid/i,
  );
  await assert.rejects(
    () => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: ['review/target'], limits }),
    /reviewed ref name is invalid/i,
  );
  const immutable = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [head], limits });
  assert.deepEqual(immutable.reviewedRefs, [{ name: head, objectId: head }]);
  assert.deepEqual(await snapshotPrimaryBytes(repo), before);
});

test('records dirty tracked deletion distinctly and detects restoration', async () => {
  const repo = await makeRepo();
  await fs.unlink(path.join(repo, 'deleted-in-worktree.txt'));
  const dirtyBefore = await snapshotPrimaryBytes(repo);
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  assert.deepEqual(await snapshotPrimaryBytes(repo), dirtyBefore);
  assert.deepEqual(baseline.tracked.find((row) => row.path === 'deleted-in-worktree.txt'), { path: 'deleted-in-worktree.txt', kind: 'missing' });
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unchanged');
  await fs.writeFile(path.join(repo, 'deleted-in-worktree.txt'), 'restored externally');
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'changed');
});

test('records nested tracked paths as missing when their ancestor is deleted', async () => {
  const repo = await makeRepo();
  await fs.mkdir(path.join(repo, 'nested'));
  await fs.writeFile(path.join(repo, 'nested', 'tracked'), 'nested');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'nested');
  await fs.rm(path.join(repo, 'nested'), { recursive: true });
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  assert.deepEqual(baseline.tracked.find((row) => row.path === 'nested/tracked'), { path: 'nested/tracked', kind: 'missing' });
  assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unchanged');
});

test('fails closed rather than following a tracked symlink ancestor', async () => {
  const linkedRepo = await makeRepo();
  await fs.mkdir(path.join(linkedRepo, 'nested'));
  await fs.writeFile(path.join(linkedRepo, 'nested', 'tracked'), 'nested');
  await git(linkedRepo, 'add', '.'); await git(linkedRepo, 'commit', '-qm', 'nested');
  await fs.rm(path.join(linkedRepo, 'nested'), { recursive: true });
  await fs.symlink(tmpdir(), path.join(linkedRepo, 'nested'));
  await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: linkedRepo, reviewedRefs: [], limits }), /symlink ancestor/i);
});

test('fails closed on a special filesystem kind at a Git-visible tracked path', async () => {
  const repo = await makeRepo();
  const tracked = path.join(repo, 'tracked.txt');
  await fs.unlink(tracked);
  await exec('mkfifo', [tracked]);
  const before = await fs.lstat(tracked);
  await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits }), /unsupported filesystem kind/i);
  const after = await fs.lstat(tracked);
  assert.equal(after.isFIFO(), true);
  assert.deepEqual({ dev: after.dev, ino: after.ino, mode: after.mode }, { dev: before.dev, ino: before.ino, mode: before.mode });
});

test('inconsistent and unreadable scans fail closed without changing primary bytes', async () => {
  const repo = await makeRepo();
  const before = await snapshotPrimaryBytes(repo);
  const fake = await makeBaselineFakeGit();
  const originalPath = process.env.PATH;
  const state = path.join(fake, 'state');
  try {
    process.env.PATH = `${fake}${path.delimiter}${originalPath}`;
    process.env.ARC_BASELINE_GIT_MODE = 'inconsistent';
    process.env.ARC_BASELINE_GIT_STATE = state;
    await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits }), /changed during capture/i);
    process.env.PATH = originalPath;
    delete process.env.ARC_BASELINE_GIT_MODE;
    assert.deepEqual(await snapshotPrimaryBytes(repo), before);

    const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
    process.env.PATH = `${fake}${path.delimiter}${originalPath}`;
    process.env.ARC_BASELINE_GIT_MODE = 'unreadable';
    assert.equal((await compareArcPrimaryBaseline(baseline, limits)).state, 'unreadable');
  } finally {
    process.env.PATH = originalPath;
    delete process.env.ARC_BASELINE_GIT_MODE;
    delete process.env.ARC_BASELINE_GIT_STATE;
  }
  assert.deepEqual(await snapshotPrimaryBytes(repo), before);
});

test('an unreadable index fails at the direct index read boundary', async () => {
  const repo = await makeRepo();
  const indexPath = path.join(repo, '.git', 'index');
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  await fs.chmod(indexPath, 0o000);
  try {
    const comparison = await compareArcPrimaryBaseline(baseline, limits);
    assert.equal(comparison.state, 'unreadable');
    assert.match(comparison.differences.join('\n'), /index.*unreadable|EACCES|EPERM/i);
    await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits }), /index|EACCES|EPERM/i);
  } finally {
    await fs.chmod(indexPath, 0o600);
  }
});

test('a deleted index and limits fail closed without exposing contents', async () => {
  const repo = await makeRepo();
  const baseline = await captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits });
  await fs.unlink(path.join(repo, '.git', 'index'));
  const comparison = await compareArcPrimaryBaseline(baseline, limits);
  assert.equal(comparison.state, 'unreadable');
  assert.ok(comparison.differences.length > 0);
  await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits: { ...limits, maxFiles: 1 } }), /limit|index/i);
});

async function withControlledBaselineRead(target, mutation, action) {
  const originalOpen = fsPromises.open;
  let requested = 0;
  let consumed = 0;
  let controlled = false;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target && !controlled) {
      controlled = true;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      const originalReadFile = handle.readFile.bind(handle);
      let statCalls = 0;
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        if (statCalls++ === 0) await mutation();
        return stat;
      };
      handle.read = async (buffer, offset, length, position) => {
        requested += length;
        const result = await originalRead(buffer, offset, length, position);
        consumed += result.bytesRead;
        return result;
      };
      handle.readFile = async (...readArgs) => {
        const bytes = await originalReadFile(...readArgs);
        requested += bytes.byteLength;
        consumed += bytes.byteLength;
        return bytes;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { return { value: await action(), requested, consumed }; }
  finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
}

test('bounds tracked and untracked reads during growth and rejects shrink/early EOF', async () => {
  for (const name of ['tracked.txt', 'untracked.bin']) {
    const repo = await makeRepo();
    const target = path.join(repo, name);
    const declared = (await fs.stat(target)).size;
    const outcome = await withControlledBaselineRead(target, () => fs.appendFile(target, Buffer.alloc(2048)), async () => {
      await assert.rejects(
        () => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits: { ...limits, maxFileBytes: 1024 } }),
        /changed while reading|exceeds maxFileBytes/i,
      );
    });
    assert.ok(outcome.requested <= declared + 1, `${name} requested ${outcome.requested} bytes`);
  }

  const repo = await makeRepo();
  const target = path.join(repo, 'tracked.txt');
  const outcome = await withControlledBaselineRead(target, () => fs.truncate(target, 1), async () => {
    await assert.rejects(() => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits }), /changed while reading/i);
  });
  assert.ok(outcome.consumed <= 3);
});

test('bounds the raw index read during concurrent growth', async () => {
  const repo = await makeRepo();
  const target = path.join(repo, '.git', 'index');
  const declared = (await fs.stat(target)).size;
  const outcome = await withControlledBaselineRead(target, () => fs.appendFile(target, Buffer.alloc(2048)), async () => {
    await assert.rejects(
      () => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits: { ...limits, maxFileBytes: 1024 } }),
      /changed while reading|exceeds maxFileBytes/i,
    );
  });
  assert.ok(outcome.requested <= declared + 1, `index requested ${outcome.requested} bytes`);
});

test('stops before filesystem reads when index metadata exhausts the total budget', async () => {
  const repo = await makeRepo();
  const indexSize = (await fs.stat(path.join(repo, '.git', 'index'))).size;
  const entriesSize = (await exec('git', ['ls-files', '--stage', '-z'], {
    cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, encoding: 'buffer',
  })).stdout.length;
  const originalOpen = fsPromises.open;
  let worktreeOpens = 0;
  fsPromises.open = async (...args) => {
    const named = String(args[0]);
    if (named.startsWith(`${repo}${path.sep}`) && !named.startsWith(`${repo}${path.sep}.git${path.sep}`)) worktreeOpens += 1;
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => captureArcPrimaryBaseline({ repositoryRoot: repo, reviewedRefs: [], limits: { ...limits, maxTotalBytes: indexSize + entriesSize } }),
      /maxTotalBytes/i,
    );
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(worktreeOpens, 0);
});
