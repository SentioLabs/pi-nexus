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
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionId: () => id, getSessionFile: () => file },
    };

    const registration = await registerArcSession(ctx);
    assert.equal(registration.code, 0, registration.stderr);
    const hook = JSON.parse(registration.stdout);
    assert.deepEqual(hook.args, ['ai', 'session', 'start', '--stdin']);
    assert.equal(hook.cwd, dir);
    assert.equal(hook.id, id);
    assert.deepEqual(JSON.parse(hook.input), { session_id: id, cwd: dir, transcript_path: file });

    // A new or in-memory session must not reuse a previous session's ID/file.
    id = 'pi-next';
    file = undefined;
    const prime = await runArcCommand(['prime'], ctx);
    assert.equal(prime.code, 0, prime.stderr);
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

test('extension routes Arc subprocesses and session-start registration through the session adapter', async () => {
  const source = await readFile(new URL('../extensions/arc.ts', import.meta.url), 'utf8');
  assert.match(source, /return runArcCommand\(args, ctx, \{ timeoutMs: timeout \}\)/);
  assert.match(source, /pi\.on\("session_start",[\s\S]*await registerArcSession\(ctx\)/);
  assert.doesNotMatch(source, /pi\.exec\("arc"/);
});
