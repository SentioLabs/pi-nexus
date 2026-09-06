#!/usr/bin/env node
import fsPromises, { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const control = JSON.parse(await readFile(new URL('./fake-pi-control.json', import.meta.url), 'utf8'));
const {
  mode = 'success', recordPath, acknowledgementPath, reportPath, guardPath, schemaPath,
  attemptId, digest, guardDigest, schemaDigest, absoluteReadPaths = [], allowedData = {},
  publicationFault, failureEvidenceUnavailable = false, evidenceStuck = false,
} = control;
if (!recordPath) throw new Error('fixture recordPath is required');
const privateKeys = [
  'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_SERVER_DIR', 'HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP',
];
await writeFile(recordPath, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(privateKeys.map((name) => [name, process.env[name]])),
  flags: Object.fromEntries(['PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'PI_PACKAGE_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS'].map((name) => [name, process.env[name] ?? null])),
  allowedDataPreserved: Object.fromEntries(Object.entries(allowedData).map(([name, expected]) => [name, process.env[name] === expected])),
  absoluteReadPaths,
}));

if (mode === 'timeout') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
  await new Promise(() => {});
}
if (mode === 'nonzero') {
  process.stderr.write('fixture nonzero');
  process.exit(7);
}
if (mode === 'malformed') process.stdout.write('{not-json}\n');
else if (mode === 'oversize') process.stdout.write(`${JSON.stringify({ type: 'diagnostic', text: 'x'.repeat(2 * 1024 * 1024) })}\n`);
else if (mode === 'malformed-tail-lines') process.stdout.write(`${'{}\n'.repeat(129)}{not-json}\n`);
else if (mode === 'malformed-tail-bytes') process.stdout.write(`${JSON.stringify({ text: 'x'.repeat(40 * 1024) })}\n${JSON.stringify({ text: 'y'.repeat(40 * 1024) })}\n{not-json}\n`);
else if (mode === 'blank-tail-lines') process.stdout.write(`${'{}\n'.repeat(129)}\n{}\n`);
else if (mode === 'valid-crlf') process.stdout.write(`${JSON.stringify({ type: 'fixture-complete' })}\r\n`);
else process.stdout.write(`${JSON.stringify({ type: 'fixture-complete' })}\n`);

if (mode === 'no-artifacts') process.exit(0);
if (!acknowledgementPath || !reportPath || !guardPath || !schemaPath || !attemptId || !digest || !guardDigest || !schemaDigest) throw new Error('fake artifact control is incomplete');
const report = {
  schemaVersion: 1,
  reviewInputDigest: digest,
  verdict: 'PASS',
  summary: 'The deterministic fixture completed.',
  findings: [],
  coverage: { reviewedPaths: ['source/a.ts'], reviewedRequirements: ['SC3'] },
  limitations: [],
};

if (mode === 'copied-guard') {
  const evidencePath = path.join(path.dirname(reportPath), 'guard-evidence.jsonl');
  const realLink = fsPromises.link;
  const realOpen = fsPromises.open;
  const realUnlink = fsPromises.unlink;
  let linkedChannel;
  let syncFaultConsumed = false;
  let cleanupFaultConsumed = false;
  fsPromises.link = async (from, to) => {
    if (publicationFault === 'unsupported-link') {
      const error = new Error('fixture unsupported link');
      error.code = 'ENOTSUP';
      throw error;
    }
    const result = await realLink(from, to);
    if (to === reportPath) linkedChannel = 'report';
    if (to === acknowledgementPath) linkedChannel = 'acknowledgement';
    return result;
  };
  fsPromises.unlink = async (file) => {
    if (publicationFault === 'temporary-cleanup' && linkedChannel && !cleanupFaultConsumed && file !== reportPath && file !== acknowledgementPath) {
      cleanupFaultConsumed = true;
      const error = new Error('fixture temporary cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    return realUnlink(file);
  };
  fsPromises.open = async (file, ...args) => {
    if (failureEvidenceUnavailable && file === evidencePath) {
      const error = new Error('fixture evidence unavailable');
      error.code = 'EACCES';
      throw error;
    }
    const handle = await realOpen(file, ...args);
    if (evidenceStuck && file === evidencePath) {
      handle.sync = () => new Promise(() => {});
      return handle;
    }
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      const shouldFail = !syncFaultConsumed && ((publicationFault === 'report-directory-sync' && linkedChannel === 'report' && file === path.dirname(reportPath)) ||
        (publicationFault === 'ack-directory-sync' && linkedChannel === 'acknowledgement' && file === path.dirname(acknowledgementPath)));
      if (shouldFail) {
        syncFaultConsumed = true;
        const error = new Error('fixture directory sync failure');
        error.code = 'EIO';
        throw error;
      }
      return originalSync();
    };
    return handle;
  };
  syncBuiltinESMExports();
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    registerTool(tool) { tools.set(tool.name, tool); },
    events: { emit() {} },
  };
  try {
    const guard = await import(`${pathToFileURL(guardPath).href}?fixture=${Date.now()}`);
    await guard.default(pi);
    for (const handler of handlers.get('session_start') ?? []) await handler({}, {});
    await tools.get('arc_review_report').execute('fixture-report', report, new AbortController().signal);
  } catch {}
  process.exit(0);
}

await mkdir(path.dirname(acknowledgementPath), { recursive: true });
const ack = {
  version: 1,
  attemptId,
  id: `pi-arc.review-child:v1:${attemptId}`,
  guardSourceDigest: guardDigest,
  reportSchemaDigest: schemaDigest,
  loadedAt: new Date().toISOString(),
};
if (mode === 'mismatched-ack') ack.guardSourceDigest = '0'.repeat(64);
if (mode !== 'missing-ack') {
  await writeFile(acknowledgementPath, JSON.stringify(ack), { mode: 0o600, flag: 'wx' });
  await chmod(acknowledgementPath, 0o600);
}
if (mode === 'wrong-digest') report.reviewInputDigest = 'f'.repeat(64);
if (mode !== 'missing-report') {
  const contents = mode === 'duplicate' ? `${JSON.stringify(report)}\n${JSON.stringify(report)}` : mode === 'malformed-report' ? '{bad' : JSON.stringify(report);
  await writeFile(reportPath, contents, { mode: 0o600, flag: 'wx' });
  await chmod(reportPath, 0o600);
}
if (mode === 'mutation-request') await writeFile(path.join(path.dirname(reportPath), 'guard-evidence.jsonl'), '{"tool":"canary_mutate"}\n', { mode: 0o600, flag: 'wx' });
