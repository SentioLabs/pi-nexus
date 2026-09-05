import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runArcBoundedProcess } from '../extensions/arc/process.ts';

const root = await mkdtemp(path.join(tmpdir(), 'pi-arc-process-'));
const fixture = path.join(root, 'fixture.mjs');
const missingExecutable = path.join(root, 'does-not-exist');
await writeFile(fixture, `
const mode = process.argv[2];
if (mode === 'echo-stdin') { const chunks=[]; for await (const c of process.stdin) chunks.push(c); process.stdout.write(Buffer.concat(chunks)); }
else if (mode === 'binary') process.stdout.write(Buffer.from([0,255,254,65]));
else if (mode === 'overflow') { process.stdout.write(Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))); process.stderr.write(Buffer.alloc(1000, 0x62)); }
else if (mode === 'nonzero') { process.stderr.write('bad'); process.exitCode=7; }
else if (mode === 'sleep') setTimeout(() => {}, 10_000);
else if (mode === 'ignore-term') { process.on('SIGTERM', () => {}); if (process.argv[3]) await import('node:fs/promises').then((fs) => fs.writeFile(process.argv[3], 'ready')); setInterval(() => {}, 1000); }
else if (mode === 'exit-without-ready') process.exitCode = 0;
else if (mode === 'close-stdin') { process.stdin.destroy(); setTimeout(() => {}, 30); }
`);

const input = {
  command: process.execPath, args: [fixture, 'echo-stdin'], cwd: root, env: { ...process.env },
  timeoutMs: 500, stopGraceMs: 50, killGraceMs: 100, maxOutputBytes: 256,
};

async function waitForPath(file, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (await access(file).then(() => false, () => true)) {
    if (signal.aborted) throw new Error('readiness wait cancelled');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('readiness was not observed before the test deadline');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(finish, Math.min(5, remaining));
      const onAbort = () => finish(new Error('readiness wait cancelled'));
      function finish(error) {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

test('round trips binary stdin and never invokes a shell', async () => {
  const bytes = Uint8Array.from([0x00, 0xff, 0x61]);
  const result = await runArcBoundedProcess({ ...input, args: [fixture, 'echo-stdin', 'literal;$(not-shell)'], stdin: bytes });
  assert.deepEqual(result.stdout, bytes);
  assert.equal(result.exitCode, 0);
  assert.equal(result.termination, 'observed');
});

test('preserves binary output and bounds both output streams', async () => {
  const binary = await runArcBoundedProcess({ ...input, args: [fixture, 'binary'] });
  assert.deepEqual(binary.stdout, Uint8Array.from([0, 255, 254, 65]));
  const overflow = await runArcBoundedProcess({ ...input, args: [fixture, 'overflow'] });
  assert.equal(overflow.stdout.byteLength, 256);
  assert.equal(overflow.stderr.byteLength, 256);
  assert.equal(overflow.stdoutTruncated, true);
  assert.equal(overflow.stderrTruncated, true);
  const full = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  assert.deepEqual(overflow.stdout, Uint8Array.from(Buffer.concat([full.subarray(0, 128), full.subarray(-128)])));
});

test('reports nonzero, timeout, abort, and TERM-ignore escalation', async () => {
  const nonzero = await runArcBoundedProcess({ ...input, args: [fixture, 'nonzero'] });
  assert.equal(nonzero.exitCode, 7);
  assert.equal(Buffer.from(nonzero.stderr).toString(), 'bad');
  const timeout = await runArcBoundedProcess({ ...input, args: [fixture, 'sleep'], timeoutMs: 40 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.termination, 'observed');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const aborted = await runArcBoundedProcess({ ...input, args: [fixture, 'sleep'], signal: controller.signal });
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.termination, 'observed');
  const escalated = await runArcBoundedProcess({ ...input, args: [fixture, 'ignore-term'], timeoutMs: 80 });
  assert.equal(escalated.timedOut, true);
  assert.equal(escalated.signal, 'SIGKILL');
});

test('observes spawn exactly once and skips observer on creation failure', async () => {
  let created;
  const observed = await runArcBoundedProcess({ ...input, onSpawn: async (value) => { created = value; } });
  assert.equal(created.pid, observed.pid);
  assert.equal(created.spawnedAt <= observed.endedAt, true);
  let calls = 0;
  const absent = await runArcBoundedProcess({ ...input, command: missingExecutable, onSpawn: async () => { calls++; } });
  assert.equal(absent.spawned, false);
  assert.equal(calls, 0);
  assert.match(absent.observationError, /ENOENT|not found/i);
});

test('stdin failure is bounded and settles after accounting for the child', async () => {
  const failed = await runArcBoundedProcess({ ...input, args: [fixture, 'close-stdin'], stdin: Buffer.alloc(8 * 1024 * 1024) });
  assert.equal(failed.termination, 'observed');
  assert.match(failed.observationError, /EPIPE|closed|write/i);
});

test('observer rejection terminates an owned child and cannot become success', async () => {
  const failedReceipt = await runArcBoundedProcess({ ...input, args: [fixture, 'ignore-term'], onSpawn: async () => { throw new Error('receipt write failed'); } });
  assert.match(failedReceipt.observationError, /receipt write failed/);
  assert.equal(failedReceipt.termination, 'observed');
  assert.notEqual(failedReceipt.exitCode, 0);
});

test('observer diagnostics remain within the 4 KiB byte bound', async () => {
  const message = `${'a'.repeat(4088)}😀`;
  const failed = await runArcBoundedProcess({ ...input, onSpawn: async () => { throw new Error(message); } });
  assert.ok(Buffer.byteLength(failed.observationError, 'utf8') <= 4096);
});

test('deadline and abort remain live while observer never settles', async () => {
  const stopGraceMs = 40;
  const killGraceMs = 80;
  const schedulerToleranceMs = 200;
  const readyForDeadline = path.join(root, `deadline-ready-${Date.now()}`);
  const timeoutMs = 180;
  const deadlineStarted = Date.now();
  const deadlineReadyWait = new AbortController();
  let deadline;
  try {
    deadline = await runArcBoundedProcess({
      ...input, args: [fixture, 'ignore-term', readyForDeadline], timeoutMs, stopGraceMs, killGraceMs,
      onSpawn: async () => {
        await waitForPath(readyForDeadline, { timeoutMs, signal: deadlineReadyWait.signal });
        return new Promise(() => {});
      },
    });
  } finally {
    deadlineReadyWait.abort();
  }
  assert.equal(deadline.timedOut, true);
  assert.equal(deadline.termination, 'observed');
  assert.equal(deadline.signal, 'SIGKILL');
  assert.match(deadline.observationError, /deadline|settle/i);
  assert.ok(Date.now() - deadlineStarted <= timeoutMs + stopGraceMs + killGraceMs + schedulerToleranceMs);

  const readyForAbort = path.join(root, `abort-ready-${Date.now()}`);
  const controller = new AbortController();
  const abortReadyWait = new AbortController();
  let abortedAt;
  const abortWhenReady = (async () => {
    await waitForPath(readyForAbort, { timeoutMs: 500, signal: abortReadyWait.signal });
    abortedAt = Date.now();
    controller.abort();
  })();
  let aborted;
  try {
    aborted = await runArcBoundedProcess({
      ...input, args: [fixture, 'ignore-term', readyForAbort], timeoutMs: 2_000, stopGraceMs, killGraceMs,
      signal: controller.signal, onSpawn: () => new Promise(() => {}),
    });
    await abortWhenReady;
  } finally {
    abortReadyWait.abort();
    await abortWhenReady.catch(() => {});
  }
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.timedOut, false);
  assert.equal(aborted.termination, 'observed');
  assert.equal(aborted.signal, 'SIGKILL');
  assert.match(aborted.observationError, /abort|settle/i);
  assert.ok(Date.now() - abortedAt <= stopGraceMs + killGraceMs + schedulerToleranceMs);
});

test('missing readiness fails and settles promptly without an owned wait', async () => {
  const ready = path.join(root, `missing-ready-${Date.now()}`);
  const readyWait = new AbortController();
  const started = Date.now();
  let result;
  try {
    result = await runArcBoundedProcess({
      ...input, args: [fixture, 'exit-without-ready'], timeoutMs: 500,
      onSpawn: () => waitForPath(ready, { timeoutMs: 60, signal: readyWait.signal }),
    });
  } finally {
    readyWait.abort();
  }
  assert.equal(result.termination, 'observed');
  assert.match(result.observationError, /readiness was not observed/i);
  assert.ok(Date.now() - started < 500);
});

test('a delayed observer prevents successful settlement until it resolves', async () => {
  let released = false;
  const start = Date.now();
  const result = await runArcBoundedProcess({ ...input, onSpawn: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); released = true; } });
  assert.equal(released, true);
  assert.ok(Date.now() - start >= 70);
  assert.equal(result.exitCode, 0);
});
