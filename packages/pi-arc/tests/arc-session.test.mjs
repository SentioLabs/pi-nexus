import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerArcSession, runArcCommand } from '../extensions/arc/session.ts';

test('Arc commands and hook payloads follow the current Pi session without changing process identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'arc-session-'));
  const originalPath = process.env.PATH;
  const originalID = process.env.ARC_SESSION_ID;
  try {
    await writeFile(path.join(dir, 'arc'), `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), id: process.env.ARC_SESSION_ID, input}));
`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    process.env.ARC_SESSION_ID = 'inherited-parent';
    let id = 'pi-current';
    let file = path.join(dir, 'current.jsonl');
    let sessionIDReads = 0;
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionId: () => { sessionIDReads += 1; return id; }, getSessionFile: () => file },
    };

    const registration = await registerArcSession(ctx);
    assert.equal(registration.code, 0, registration.stderr);
    assert.equal(sessionIDReads, 1, 'registration must use one captured session ID for payload and environment');
    const hook = JSON.parse(registration.stdout);
    assert.deepEqual(hook.args, ['ai', 'session', 'start', '--stdin']);
    assert.equal(hook.cwd, dir);
    assert.equal(hook.id, id);
    assert.deepEqual(JSON.parse(hook.input), { session_id: id, cwd: dir, transcript_path: file });

    // A new or in-memory session must not reuse a previous session's ID/file.
    id = 'pi-next';
    file = undefined;
    sessionIDReads = 0;
    const prime = await runArcCommand(['prime'], ctx);
    assert.equal(prime.code, 0, prime.stderr);
    assert.equal(sessionIDReads, 1, 'each command must capture the current session ID once');
    assert.deepEqual(JSON.parse(prime.stdout), { args: ['prime'], cwd: dir, id, input: '' });
    const next = await registerArcSession(ctx);
    assert.equal(next.code, 0, next.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(next.stdout).input), { session_id: id, cwd: dir, transcript_path: '' });
    assert.equal(process.env.ARC_SESSION_ID, 'inherited-parent');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalID === undefined) delete process.env.ARC_SESSION_ID;
    else process.env.ARC_SESSION_ID = originalID;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Arc session adapter preserves explicit session flags and refuses missing manager identity before spawn', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'arc-session-'));
  const originalPath = process.env.PATH;
  try {
    await writeFile(path.join(dir, 'arc'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({args: process.argv.slice(2), id: process.env.ARC_SESSION_ID}));
`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    const explicit = await runArcCommand(['prime', '--session-id', 'caller supplied; $(never)'], {
      cwd: dir,
      sessionManager: { getSessionId: () => 'manager-session', getSessionFile: () => undefined },
    });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(explicit.stdout), {
      args: ['prime', '--session-id', 'caller supplied; $(never)'],
      id: 'manager-session',
    });

    const missing = await runArcCommand(['prime'], {
      cwd: dir,
      sessionManager: { getSessionId: () => '', getSessionFile: () => undefined },
    });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Pi session ID is required/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('extension routes Arc subprocesses and session-start registration through the session adapter', async () => {
  const source = await readFile(new URL('../extensions/arc.ts', import.meta.url), 'utf8');
  assert.match(source, /return runArcCommand\(args, ctx, \{ timeoutMs: timeout \}\)/);
  assert.match(source, /runArcCommand\(\["prime", "--session-id", sessionID\], ctx, \{ timeoutMs: 20_000, sessionID \}\)/);
  assert.match(source, /primeCache = "";\n\s*primeError = outputOf\(result\)/);
  assert.match(source, /pi\.on\("session_start",[\s\S]*await registerArcSession\(ctx\)/);
  assert.doesNotMatch(source, /pi\.exec\("arc"/);
});
