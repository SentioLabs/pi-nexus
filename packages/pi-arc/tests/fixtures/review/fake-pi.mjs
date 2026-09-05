#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mode = process.env.FAKE_PI_MODE ?? 'success';
const recordPath = process.env.FAKE_PI_RECORD;
const acknowledgementPath = process.env.FAKE_PI_ACK;
const reportPath = process.env.FAKE_PI_REPORT;
const guardPath = process.env.FAKE_PI_GUARD;
const schemaPath = process.env.FAKE_PI_SCHEMA;
const attemptId = process.env.FAKE_PI_ATTEMPT;
const digest = process.env.FAKE_PI_DIGEST;
const guardDigest = process.env.FAKE_PI_GUARD_DIGEST;
const schemaDigest = process.env.FAKE_PI_SCHEMA_DIGEST;

if (!recordPath) throw new Error('FAKE_PI_RECORD is required');
await writeFile(recordPath, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR', 'PI_SERVER_DIR', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR'].map((name) => [name, process.env[name]])),
  absoluteReadPaths: (process.env.FAKE_PI_ABSOLUTE_READ_PATHS ?? '').split(path.delimiter).filter(Boolean),
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
if (!acknowledgementPath || !reportPath || !guardPath || !schemaPath || !attemptId || !digest || !guardDigest || !schemaDigest) throw new Error('fake artifact environment is incomplete');
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
const report = {
  schemaVersion: 1,
  reviewInputDigest: digest,
  verdict: 'PASS',
  summary: 'The deterministic fixture completed.',
  findings: [],
  coverage: { reviewedPaths: ['source/a.ts'], reviewedRequirements: ['SC3'] },
  limitations: [],
};
if (mode === 'wrong-digest') report.reviewInputDigest = 'f'.repeat(64);
if (mode !== 'missing-report') {
  const contents = mode === 'duplicate' ? `${JSON.stringify(report)}\n${JSON.stringify(report)}` : mode === 'malformed-report' ? '{bad' : JSON.stringify(report);
  await writeFile(reportPath, contents, { mode: 0o600, flag: 'wx' });
  await chmod(reportPath, 0o600);
}
if (mode === 'mutation-request') await writeFile(path.join(path.dirname(reportPath), 'guard-evidence.jsonl'), '{"tool":"canary_mutate"}\n', { mode: 0o600, flag: 'wx' });
