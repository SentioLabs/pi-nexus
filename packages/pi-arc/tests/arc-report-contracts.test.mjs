import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARC_REVIEWER_REPORT_JSON_SCHEMA,
  ARC_REVIEW_MAX_ATTEMPTS,
  ARC_REVIEW_STOP_GRACE_MS,
  ARC_REVIEW_KILL_GRACE_MS,
  ARC_RUNTIME_REGISTER_EVENT,
  ARC_WORKER_REPORT_JSON_SCHEMA,
  canonicalizeArcJson,
  validateArcReviewerReport,
  validateArcWorkerReport,
} from '../extensions/arc/reports.ts';

const digest = 'a'.repeat(64);
const validReview = {
  schemaVersion: 1,
  reviewInputDigest: digest,
  verdict: 'PASS',
  summary: 'No blocking discrepancy found.',
  findings: [],
  coverage: { reviewedPaths: ['src/a.ts'], reviewedRequirements: ['SC1'] },
  limitations: [],
};

const validWorker = {
  schemaVersion: 1,
  role: 'builder',
  status: 'DONE',
  summary: 'Implemented and verified the requested contract.',
  changedPaths: ['src/a.ts'],
  claimedChecks: [{ name: 'focused tests', status: 'PASS', command: 'node --test', summary: '1 passed' }],
  concerns: [],
  blockers: [],
};

function replace(value, key, replacement) {
  return { ...value, [key]: replacement };
}

test('report constants and JSON schemas expose the frozen v1 bounds', () => {
  assert.equal(ARC_REVIEW_MAX_ATTEMPTS, 6);
  assert.equal(ARC_REVIEW_STOP_GRACE_MS, 5_000);
  assert.equal(ARC_REVIEW_KILL_GRACE_MS, 5_000);
  assert.equal(ARC_RUNTIME_REGISTER_EVENT, 'pi-subagents:runtime-agent-register:v1');
  assert.equal(ARC_WORKER_REPORT_JSON_SCHEMA.type, 'object');
  assert.equal(ARC_WORKER_REPORT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(ARC_REVIEWER_REPORT_JSON_SCHEMA.type, 'object');
  assert.equal(ARC_REVIEWER_REPORT_JSON_SCHEMA.additionalProperties, false);
});

test('valid worker and reviewer reports normalize to detached values and stable digests', () => {
  const worker = validateArcWorkerReport(validWorker);
  assert.equal(worker.ok, true);
  if (!worker.ok) return;
  assert.deepEqual(worker.value, validWorker);
  assert.notEqual(worker.value, validWorker);
  assert.equal(worker.canonicalJson, canonicalizeArcJson(validWorker));
  assert.match(worker.digest, /^[a-f0-9]{64}$/);
  assert.equal(worker.digest, validateArcWorkerReport({ ...validWorker })?.digest);

  const reviewer = validateArcReviewerReport(validReview, digest);
  assert.equal(reviewer.ok, true);
  if (!reviewer.ok) return;
  assert.deepEqual(reviewer.value, validReview);
  assert.notEqual(reviewer.value, validReview);
  assert.equal(reviewer.canonicalJson, canonicalizeArcJson(validReview));
  assert.match(reviewer.digest, /^[a-f0-9]{64}$/);
});

test('reviewer validation rejects exact-schema failures with accumulated paths', () => {
  for (const invalid of [
    { ...validReview, schemaVersion: 2 },
    { ...validReview, limitations: ['source omitted'] },
    { ...validReview, extra: true },
    replace(validReview, 'reviewInputDigest', 'not-a-digest'),
    replace(validReview, 'summary', ''),
    replace(validReview, 'findings', 'none'),
    replace(validReview, 'coverage', { ...validReview.coverage, extra: true }),
    replace(validReview, 'coverage', { reviewedPaths: [1], reviewedRequirements: ['SC1'] }),
  ]) {
    const result = validateArcReviewerReport(invalid, digest);
    assert.equal(result.ok, false, JSON.stringify(invalid));
    if (!result.ok) assert.ok(result.errors.every((error) => error.startsWith('$')));
  }

  const accumulated = validateArcReviewerReport({ ...validReview, schemaVersion: 2, extra: true }, digest);
  assert.equal(accumulated.ok, false);
  if (!accumulated.ok) {
    assert.ok(accumulated.errors.some((error) => error.startsWith('$.schemaVersion:')));
    assert.ok(accumulated.errors.some((error) => error.startsWith('$.extra:')));
  }
});

test('reviewer validation rejects contradictory verdicts and invalid or duplicate findings', () => {
  const blocking = {
    id: 'sc1.correctness',
    severity: 'important',
    category: 'correctness',
    blocking: true,
    path: 'src/a.ts',
    line: 12,
    explanation: 'The result is incorrect.',
  };
  const critical = { ...blocking, id: 'sc1.security', severity: 'critical', blocking: false };

  for (const invalid of [
    { ...validReview, reviewInputDigest: 'b'.repeat(64) },
    { ...validReview, findings: [blocking] },
    { ...validReview, findings: [critical] },
    { ...validReview, verdict: 'CHANGES_REQUESTED', findings: [{ ...blocking, blocking: false }] },
    { ...validReview, verdict: 'CHANGES_REQUESTED', findings: [blocking, { ...blocking }] },
    { ...validReview, verdict: 'BLOCKED', findings: [{ ...blocking, id: 'UPPER' }] },
    { ...validReview, verdict: 'BLOCKED', findings: [{ ...blocking, line: 0 }] },
    { ...validReview, verdict: 'BLOCKED', findings: [{ ...blocking, extra: true }] },
  ]) {
    assert.equal(validateArcReviewerReport(invalid, digest).ok, false, JSON.stringify(invalid));
  }

  assert.equal(validateArcReviewerReport({ ...validReview, verdict: 'CHANGES_REQUESTED', findings: [blocking] }, digest).ok, true);
  assert.equal(validateArcReviewerReport({ ...validReview, verdict: 'BLOCKED', limitations: ['Dependency unavailable.'] }, digest).ok, true);
});

test('worker validation enforces exact keys, statuses, claimed checks, and status semantics', () => {
  for (const invalid of [
    { ...validWorker, schemaVersion: 2 },
    { ...validWorker, role: 'reviewer' },
    { ...validWorker, status: 'done' },
    { ...validWorker, extra: true },
    { ...validWorker, changedPaths: [1] },
    { ...validWorker, claimedChecks: [{ name: 'tests', status: 'PASS', extra: true }] },
    { ...validWorker, claimedChecks: [{ name: 'tests', status: 'UNKNOWN' }] },
    { ...validWorker, concerns: ['Concern remains.'] },
    { ...validWorker, blockers: ['Blocked.'] },
    { ...validWorker, status: 'DONE_WITH_CONCERNS', concerns: [] },
    { ...validWorker, status: 'BLOCKED', blockers: [] },
    { ...validWorker, status: 'NEEDS_CONTEXT', blockers: [] },
  ]) {
    assert.equal(validateArcWorkerReport(invalid).ok, false, JSON.stringify(invalid));
  }

  assert.equal(validateArcWorkerReport({ ...validWorker, status: 'DONE_WITH_CONCERNS', concerns: ['Review requested.'] }).ok, true);
  assert.equal(validateArcWorkerReport({ ...validWorker, status: 'BLOCKED', blockers: ['Dependency missing.'] }).ok, true);
  assert.equal(validateArcWorkerReport({ ...validWorker, status: 'NEEDS_CONTEXT', blockers: ['API choice required.'] }).ok, true);
});

test('DevOps operations require coherent rollback evidence', () => {
  const operations = {
    target: 'staging cluster',
    preview: ['terraform plan'],
    safeguards: ['Snapshot captured.'],
    applied: ['terraform apply'],
    verification: ['Health check passed.'],
    rollback: { available: true, reference: 'snapshot-42', commands: ['terraform apply rollback.tfplan'] },
  };
  const devops = { ...validWorker, role: 'devops-builder', operations };
  assert.equal(validateArcWorkerReport(devops).ok, true);

  for (const invalidOperations of [
    undefined,
    { ...operations, extra: true },
    { ...operations, rollback: { available: true, commands: [] } },
    { ...operations, rollback: { available: false, reference: 'snapshot-42', commands: [] } },
    { ...operations, rollback: { available: false, commands: ['rollback'] } },
  ]) {
    const candidate = { ...devops };
    if (invalidOperations === undefined) delete candidate.operations;
    else candidate.operations = invalidOperations;
    assert.equal(validateArcWorkerReport(candidate).ok, false, JSON.stringify(candidate));
  }
  assert.equal(validateArcWorkerReport({ ...validWorker, operations }).ok, false);
});

test('report validation applies exact prose, array, and path byte limits', () => {
  assert.equal(validateArcWorkerReport({ ...validWorker, summary: 'x'.repeat(64 * 1024) }).ok, true);
  assert.equal(validateArcWorkerReport({ ...validWorker, summary: 'x'.repeat(64 * 1024 + 1) }).ok, false);
  assert.equal(validateArcReviewerReport({ ...validReview, summary: '😀'.repeat(16 * 1024 + 1) }, digest).ok, false);
  assert.equal(validateArcWorkerReport({ ...validWorker, changedPaths: ['p'.repeat(4096)] }).ok, true);
  assert.equal(validateArcWorkerReport({ ...validWorker, changedPaths: ['é'.repeat(2049)] }).ok, false);
  assert.equal(validateArcReviewerReport({ ...validReview, limitations: Array.from({ length: 1025 }, () => 'limited') }, digest).ok, false);
});

test('canonical JSON sorts object keys, preserves array order, and rejects non-JSON values', () => {
  assert.equal(
    canonicalizeArcJson({ z: 1, a: [2, 3] }),
    canonicalizeArcJson({ a: [2, 3], z: 1 }),
  );
  assert.notEqual(canonicalizeArcJson({ a: [2, 3] }), canonicalizeArcJson({ a: [3, 2] }));
  assert.equal(canonicalizeArcJson({ text: 'é', number: -0 }), '{"number":0,"text":"é"}');

  for (const value of [undefined, NaN, Infinity, 1n, { missing: undefined }, new Date(0), [, 1]]) {
    assert.throws(() => canonicalizeArcJson(value));
  }
  assert.throws(() => canonicalizeArcJson([{ id: 'same' }, { id: 'same' }]), /duplicate semantic id/i);
});
