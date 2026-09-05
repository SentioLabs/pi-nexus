import { createHash } from "node:crypto";

import type { ArcResolvedAgentDefinition } from "./agent-definitions.ts";

export const ARC_REPORT_SCHEMA_VERSION = 1 as const;
export const ARC_REVIEW_POLICY_VERSION = 1 as const;
export const ARC_REVIEW_LEDGER_VERSION = 1 as const;
export const ARC_ACTIVATION_MANIFEST_VERSION = 1 as const;
export const ARC_HANDOFF_VERSION = 1 as const;
export const ARC_REVIEW_GUARD_ACK_VERSION = 1 as const;
export const ARC_REVIEW_MAX_ATTEMPTS = 6;
export const ARC_REVIEW_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1_000;
export const ARC_REVIEW_CUMULATIVE_TIMEOUT_MS = 60 * 60 * 1_000;
export const ARC_REVIEW_RPC_TIMEOUT_MS = 10_000;
export const ARC_REVIEW_STOP_GRACE_MS = 5_000;
export const ARC_REVIEW_KILL_GRACE_MS = 5_000;
export const ARC_REVIEW_MAX_FILES = 25_000;
export const ARC_REVIEW_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const ARC_REVIEW_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
export const ARC_REVIEW_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const ARC_REVIEW_MAX_EVENT_BUFFER = 128;
export const ARC_RUNTIME_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
export const ARC_SUBAGENTS_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const ARC_SUBAGENTS_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const ARC_REVIEW_GUARD_ACK_PREFIX = "pi-arc.review-child:v1:";

const MAX_PROSE_BYTES = 64 * 1024;
const MAX_ARRAY_ENTRIES = 1_024;
const MAX_PATH_BYTES = 4_096;
const DIGEST_PATTERN = "^[a-f0-9]{64}$";
const FINDING_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";

export type ArcWorkerStatus = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";
export type ArcWorkerRole = "builder" | "devops-builder" | "doc-writer" | "evaluator" | "issue-manager";
export type ArcClaimedCheckStatus = "PASS" | "FAIL" | "NOT_RUN" | "SETUP_ERROR";
export interface ArcClaimedCheck { name: string; status: ArcClaimedCheckStatus; command?: string; summary?: string; }
export interface ArcDevOpsEvidence {
  target: string; preview: string[]; safeguards: string[]; applied: string[]; verification: string[];
  rollback: { available: boolean; reference?: string; commands: string[] };
}
export interface ArcWorkerReport {
  schemaVersion: 1; role: ArcWorkerRole; status: ArcWorkerStatus; summary: string; changedPaths: string[];
  claimedChecks: ArcClaimedCheck[]; concerns: string[]; blockers: string[]; operations?: ArcDevOpsEvidence;
}
export type ArcReviewVerdict = "PASS" | "CHANGES_REQUESTED" | "BLOCKED";
export type ArcFindingSeverity = "critical" | "important" | "minor";
export type ArcFindingCategory = "missing" | "extra" | "misunderstood" | "correctness" | "security" | "quality" | "test_gap" | "deviation";
export interface ArcReviewFinding {
  id: string; severity: ArcFindingSeverity; category: ArcFindingCategory; blocking: boolean;
  path?: string; line?: number; explanation: string;
}
export interface ArcReviewerReport {
  schemaVersion: 1; reviewInputDigest: string; verdict: ArcReviewVerdict; summary: string;
  findings: ArcReviewFinding[]; coverage: { reviewedPaths: string[]; reviewedRequirements: string[] }; limitations: string[];
}
export type ArcValidationResult<T> =
  | { ok: true; value: T; canonicalJson: string; digest: string }
  | { ok: false; errors: string[] };

const proseSchema = { type: "string", minLength: 1, maxLength: MAX_PROSE_BYTES } as const;
const pathSchema = { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES } as const;
const proseArraySchema = { type: "array", maxItems: MAX_ARRAY_ENTRIES, items: proseSchema } as const;
const pathArraySchema = { type: "array", maxItems: MAX_ARRAY_ENTRIES, items: pathSchema } as const;

export const ARC_WORKER_REPORT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "role", "status", "summary", "changedPaths", "claimedChecks", "concerns", "blockers"],
  properties: {
    schemaVersion: { const: 1 },
    role: { enum: ["builder", "devops-builder", "doc-writer", "evaluator", "issue-manager"] },
    status: { enum: ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] },
    summary: proseSchema,
    changedPaths: pathArraySchema,
    claimedChecks: {
      type: "array",
      maxItems: MAX_ARRAY_ENTRIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: proseSchema,
          status: { enum: ["PASS", "FAIL", "NOT_RUN", "SETUP_ERROR"] },
          command: proseSchema,
          summary: proseSchema,
        },
      },
    },
    concerns: proseArraySchema,
    blockers: proseArraySchema,
    operations: {
      type: "object",
      additionalProperties: false,
      required: ["target", "preview", "safeguards", "applied", "verification", "rollback"],
      properties: {
        target: proseSchema,
        preview: proseArraySchema,
        safeguards: proseArraySchema,
        applied: proseArraySchema,
        verification: proseArraySchema,
        rollback: {
          type: "object",
          additionalProperties: false,
          required: ["available", "commands"],
          properties: { available: { type: "boolean" }, reference: proseSchema, commands: proseArraySchema },
        },
      },
    },
  },
};

export const ARC_REVIEWER_REPORT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "reviewInputDigest", "verdict", "summary", "findings", "coverage", "limitations"],
  properties: {
    schemaVersion: { const: 1 },
    reviewInputDigest: { type: "string", pattern: DIGEST_PATTERN },
    verdict: { enum: ["PASS", "CHANGES_REQUESTED", "BLOCKED"] },
    summary: proseSchema,
    findings: {
      type: "array",
      maxItems: MAX_ARRAY_ENTRIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "category", "blocking", "explanation"],
        properties: {
          id: { type: "string", pattern: FINDING_ID_PATTERN },
          severity: { enum: ["critical", "important", "minor"] },
          category: { enum: ["missing", "extra", "misunderstood", "correctness", "security", "quality", "test_gap", "deviation"] },
          blocking: { type: "boolean" },
          path: pathSchema,
          line: { type: "integer", minimum: 1 },
          explanation: proseSchema,
        },
      },
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["reviewedPaths", "reviewedRequirements"],
      properties: { reviewedPaths: pathArraySchema, reviewedRequirements: proseArraySchema },
    },
    limitations: proseArraySchema,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], at: string, errors: string[]): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${at}.${key}: unknown field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required field is missing`);
  }
}

function readLiteral<T extends string | number>(value: unknown, expected: T, at: string, errors: string[]): T {
  if (value !== expected) errors.push(`${at}: must equal ${JSON.stringify(expected)}`);
  return expected;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, at: string, errors: string[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${at}: must be one of ${allowed.join(", ")}`);
    return fallback;
  }
  return value as T;
}

function readBoolean(value: unknown, at: string, errors: string[]): boolean {
  if (typeof value !== "boolean") {
    errors.push(`${at}: must be a boolean`);
    return false;
  }
  return value;
}

function readString(value: unknown, at: string, errors: string[], options: { maxBytes?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== "string") {
    errors.push(`${at}: must be a string`);
    return "";
  }
  if (!value.trim()) errors.push(`${at}: must not be blank`);
  if (value.includes("\0")) errors.push(`${at}: must not contain NUL`);
  if (byteLength(value) > (options.maxBytes ?? MAX_PROSE_BYTES)) {
    errors.push(`${at}: exceeds ${options.maxBytes ?? MAX_PROSE_BYTES} UTF-8 bytes`);
  }
  if (options.pattern && !options.pattern.test(value)) errors.push(`${at}: has invalid format`);
  return value;
}

function readOptionalString(value: Record<string, unknown>, key: string, at: string, errors: string[], options: { maxBytes?: number; pattern?: RegExp } = {}): string | undefined {
  return Object.hasOwn(value, key) ? readString(value[key], `${at}.${key}`, errors, options) : undefined;
}

function readArray<T>(value: unknown, at: string, errors: string[], readEntry: (entry: unknown, entryAt: string) => T): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${at}: must be an array`);
    return [];
  }
  if (value.length > MAX_ARRAY_ENTRIES) errors.push(`${at}: exceeds ${MAX_ARRAY_ENTRIES} entries`);
  const result: T[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_ARRAY_ENTRIES); index += 1) {
    if (!Object.hasOwn(value, index)) {
      errors.push(`${at}[${index}]: sparse array entries are not JSON values`);
      continue;
    }
    result.push(readEntry(value[index], `${at}[${index}]`));
  }
  return result;
}

function readStringArray(value: unknown, at: string, errors: string[], maxBytes = MAX_PROSE_BYTES): string[] {
  return readArray(value, at, errors, (entry, entryAt) => readString(entry, entryAt, errors, { maxBytes }));
}

function readClaimedCheck(value: unknown, at: string, errors: string[]): ArcClaimedCheck {
  if (!isRecord(value)) {
    errors.push(`${at}: must be an object`);
    return { name: "", status: "NOT_RUN" };
  }
  exactKeys(value, ["name", "status"], ["command", "summary"], at, errors);
  const command = readOptionalString(value, "command", at, errors);
  const summary = readOptionalString(value, "summary", at, errors);
  return {
    name: readString(value.name, `${at}.name`, errors),
    status: readEnum(value.status, ["PASS", "FAIL", "NOT_RUN", "SETUP_ERROR"], "NOT_RUN", `${at}.status`, errors),
    ...(command !== undefined ? { command } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function readDevOpsEvidence(value: unknown, at: string, errors: string[]): ArcDevOpsEvidence | undefined {
  if (!isRecord(value)) {
    errors.push(`${at}: must be an object`);
    return undefined;
  }
  exactKeys(value, ["target", "preview", "safeguards", "applied", "verification", "rollback"], [], at, errors);
  let rollback: ArcDevOpsEvidence["rollback"] = { available: false, commands: [] };
  if (!isRecord(value.rollback)) {
    errors.push(`${at}.rollback: must be an object`);
  } else {
    exactKeys(value.rollback, ["available", "commands"], ["reference"], `${at}.rollback`, errors);
    const available = readBoolean(value.rollback.available, `${at}.rollback.available`, errors);
    const reference = readOptionalString(value.rollback, "reference", `${at}.rollback`, errors);
    const commands = readStringArray(value.rollback.commands, `${at}.rollback.commands`, errors);
    rollback = { available, ...(reference !== undefined ? { reference } : {}), commands };
    if (available && (!reference || commands.length === 0)) {
      errors.push(`${at}.rollback: available rollback requires a reference and commands`);
    }
    if (!available && (reference !== undefined || commands.length > 0)) {
      errors.push(`${at}.rollback: unavailable rollback cannot claim a reference or commands`);
    }
  }
  const evidence: ArcDevOpsEvidence = {
    target: readString(value.target, `${at}.target`, errors),
    preview: readStringArray(value.preview, `${at}.preview`, errors),
    safeguards: readStringArray(value.safeguards, `${at}.safeguards`, errors),
    applied: readStringArray(value.applied, `${at}.applied`, errors),
    verification: readStringArray(value.verification, `${at}.verification`, errors),
    rollback,
  };
  if (evidence.applied.length > 0 && !evidence.rollback.available) {
    errors.push(`${at}.rollback: applied operations require an available rollback`);
  }
  return evidence;
}

function readExactWorkerObject(value: unknown, errors: string[]): ArcWorkerReport | undefined {
  if (!isRecord(value)) {
    errors.push("$: must be an object");
    return undefined;
  }
  exactKeys(value, ["schemaVersion", "role", "status", "summary", "changedPaths", "claimedChecks", "concerns", "blockers"], ["operations"], "$", errors);
  const operations = Object.hasOwn(value, "operations") ? readDevOpsEvidence(value.operations, "$.operations", errors) : undefined;
  return {
    schemaVersion: readLiteral(value.schemaVersion, 1, "$.schemaVersion", errors),
    role: readEnum(value.role, ["builder", "devops-builder", "doc-writer", "evaluator", "issue-manager"], "builder", "$.role", errors),
    status: readEnum(value.status, ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"], "BLOCKED", "$.status", errors),
    summary: readString(value.summary, "$.summary", errors),
    changedPaths: readStringArray(value.changedPaths, "$.changedPaths", errors, MAX_PATH_BYTES),
    claimedChecks: readArray(value.claimedChecks, "$.claimedChecks", errors, (entry, at) => readClaimedCheck(entry, at, errors)),
    concerns: readStringArray(value.concerns, "$.concerns", errors),
    blockers: readStringArray(value.blockers, "$.blockers", errors),
    ...(operations ? { operations } : {}),
  };
}

function readFinding(value: unknown, at: string, errors: string[]): ArcReviewFinding {
  if (!isRecord(value)) {
    errors.push(`${at}: must be an object`);
    return { id: "invalid", severity: "important", category: "correctness", blocking: true, explanation: "invalid" };
  }
  exactKeys(value, ["id", "severity", "category", "blocking", "explanation"], ["path", "line"], at, errors);
  const path = readOptionalString(value, "path", at, errors, { maxBytes: MAX_PATH_BYTES });
  let line: number | undefined;
  if (Object.hasOwn(value, "line")) {
    if (!Number.isSafeInteger(value.line) || (value.line as number) < 1) errors.push(`${at}.line: must be a positive safe integer`);
    else line = value.line as number;
  }
  return {
    id: readString(value.id, `${at}.id`, errors, { pattern: new RegExp(FINDING_ID_PATTERN) }),
    severity: readEnum(value.severity, ["critical", "important", "minor"], "important", `${at}.severity`, errors),
    category: readEnum(value.category, ["missing", "extra", "misunderstood", "correctness", "security", "quality", "test_gap", "deviation"], "correctness", `${at}.category`, errors),
    blocking: readBoolean(value.blocking, `${at}.blocking`, errors),
    ...(path !== undefined ? { path } : {}),
    ...(line !== undefined ? { line } : {}),
    explanation: readString(value.explanation, `${at}.explanation`, errors),
  };
}

function readCoverage(value: unknown, errors: string[]): ArcReviewerReport["coverage"] {
  if (!isRecord(value)) {
    errors.push("$.coverage: must be an object");
    return { reviewedPaths: [], reviewedRequirements: [] };
  }
  exactKeys(value, ["reviewedPaths", "reviewedRequirements"], [], "$.coverage", errors);
  return {
    reviewedPaths: readStringArray(value.reviewedPaths, "$.coverage.reviewedPaths", errors, MAX_PATH_BYTES),
    reviewedRequirements: readStringArray(value.reviewedRequirements, "$.coverage.reviewedRequirements", errors),
  };
}

function readExactReviewerObject(value: unknown, errors: string[]): ArcReviewerReport | undefined {
  if (!isRecord(value)) {
    errors.push("$: must be an object");
    return undefined;
  }
  exactKeys(value, ["schemaVersion", "reviewInputDigest", "verdict", "summary", "findings", "coverage", "limitations"], [], "$", errors);
  const findings = readArray(value.findings, "$.findings", errors, (entry, at) => readFinding(entry, at, errors));
  const findingIds = new Map<string, number>();
  findings.forEach((finding, index) => {
    const previous = findingIds.get(finding.id);
    if (previous !== undefined) errors.push(`$.findings[${index}].id: duplicate semantic ID first used at $.findings[${previous}].id`);
    else findingIds.set(finding.id, index);
  });
  return {
    schemaVersion: readLiteral(value.schemaVersion, 1, "$.schemaVersion", errors),
    reviewInputDigest: readString(value.reviewInputDigest, "$.reviewInputDigest", errors, { pattern: new RegExp(DIGEST_PATTERN) }),
    verdict: readEnum(value.verdict, ["PASS", "CHANGES_REQUESTED", "BLOCKED"], "BLOCKED", "$.verdict", errors),
    summary: readString(value.summary, "$.summary", errors),
    findings,
    coverage: readCoverage(value.coverage, errors),
    limitations: readStringArray(value.limitations, "$.limitations", errors),
  };
}

function canonicalizeValue(value: unknown, ancestors: Set<object>, at: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${at}: non-finite numbers are not JSON values`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`${at}: value is not JSON-compatible`);
  if (!Array.isArray(value) && !isRecord(value)) throw new TypeError(`${at}: value must be a plain JSON object`);
  if (ancestors.has(value)) throw new TypeError(`${at}: cyclic values are not JSON-compatible`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const semanticIds = new Set<string>();
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${at}[${index}]: sparse array entries are not JSON values`);
        const entry = value[index];
        if (isRecord(entry) && Object.hasOwn(entry, "id") && typeof entry.id === "string") {
          if (semanticIds.has(entry.id)) throw new TypeError(`${at}[${index}].id: duplicate semantic ID ${entry.id}`);
          semanticIds.add(entry.id);
        }
        entries.push(canonicalizeValue(entry, ancestors, `${at}[${index}]`));
      }
      return `[${entries.join(",")}]`;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${at}: symbol keys are not JSON-compatible`);
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key], ancestors, `${at}.${key}`)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeArcJson(value: unknown): string {
  return canonicalizeValue(value, new Set(), "$");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateArcWorkerReport(value: unknown): ArcValidationResult<ArcWorkerReport> {
  const errors: string[] = [];
  const report = readExactWorkerObject(value, errors);
  if (report?.status === "DONE" && (report.blockers.length || report.concerns.length)) {
    errors.push("$.status: DONE contradicts blockers or concerns");
  }
  if (report?.status === "DONE_WITH_CONCERNS" && (report.concerns.length === 0 || report.blockers.length > 0)) {
    errors.push("$.status: DONE_WITH_CONCERNS requires concerns and cannot include blockers");
  }
  if ((report?.status === "BLOCKED" || report?.status === "NEEDS_CONTEXT") && report.blockers.length === 0) {
    errors.push(`$.status: ${report.status} requires a blocker`);
  }
  if (report?.role === "devops-builder" && !report.operations) errors.push("$.operations: required for devops-builder");
  if (report?.role !== "devops-builder" && report?.operations) errors.push("$.operations: only valid for devops-builder");
  if (!report || errors.length) return { ok: false, errors };
  const canonicalJson = canonicalizeArcJson(report);
  return { ok: true, value: structuredClone(report), canonicalJson, digest: sha256Utf8(canonicalJson) };
}

export function validateArcReviewerReport(value: unknown, expectedReviewInputDigest: string): ArcValidationResult<ArcReviewerReport> {
  const errors: string[] = [];
  const report = readExactReviewerObject(value, errors);
  if (report && report.reviewInputDigest !== expectedReviewInputDigest) errors.push("$.reviewInputDigest: does not match prepared input");
  if (report?.verdict === "PASS" && (report.limitations.length || report.findings.some((finding) => finding.blocking || finding.severity === "critical"))) {
    errors.push("$.verdict: PASS contradicts limitations or blocking/critical findings");
  }
  if (report?.verdict === "CHANGES_REQUESTED" && !report.findings.some((finding) => finding.blocking)) {
    errors.push("$.verdict: CHANGES_REQUESTED requires a blocking finding");
  }
  if (!report || errors.length) return { ok: false, errors };
  const canonicalJson = canonicalizeArcJson(report);
  return { ok: true, value: structuredClone(report), canonicalJson, digest: sha256Utf8(canonicalJson) };
}

export type ArcReviewRole = "spec" | "code";
export type ArcReviewAdapterKind = "native" | "standalone";
export type ArcReviewAdapterSelection = "auto" | "native" | "standalone";
export type ArcNativeAvailability = "ready" | "absent" | "incompatible" | "ambiguous";
export type ArcReviewAttemptState = "reserved" | "dispatching" | "running" | "finalizing" | "unresolved" | "accepted" | "rejected" | "cancelled";
export interface ArcPriorReviewContext {
  cycle: number; lastReviewedHead: string;
  findingDispositions: Array<{ findingId: string; disposition: "fixed" | "accepted" | "still_open"; explanation: string }>;
  deltaSummary: string;
}
export interface ArcReviewStartRequest {
  repositoryRoot: string; taskKey: string; scopeKey: string; role: ArcReviewRole; adapterSelection: ArcReviewAdapterSelection;
  baseSha: string; headSha: string; reviewedRefs: string[]; taskContext: string; designContext: string;
  reviewContext: string; prior?: ArcPriorReviewContext; modelOverride?: string;
}
export interface ArcReviewPreparationReferences {
  stateDir: string; inputRoot: string; runtimeRoot: string; reportRoot: string; manifestPath: string; diffPath: string;
  guardExtensionPath: string; guardConfigPath: string; reportSchemaPath: string; guardAcknowledgementPath: string; reviewInputDigest: string; baselineDigest: string;
  baselinePath: string; baselineArtifactDigest: string; inputDescriptorPath: string; inputDescriptorArtifactDigest: string;
}
export interface ArcReviewPreflightInput { request: ArcReviewStartRequest; preparation: ArcReviewPreparationReferences; }
export interface ArcPreparedReviewAttempt extends ArcReviewPreparationReferences {
  attemptId: string; repositoryKey: string; request: ArcReviewStartRequest; reservedAt: string; attemptNumber: number;
  effectiveAttemptBudgetMs: number; executionTimeoutMs: number; dispatchDeadlineAt: string;
}
export interface ArcReviewLaunchIdentity {
  adapter: ArcReviewAdapterKind; attemptId: string; requestId: string; privateAgentName?: string;
  runnerProcessInstanceId?: string; ownerSessionId?: string; childSessionId?: string; runId?: string; asyncDir?: string;
}
export interface ArcReviewDispatchReceipt {
  identity: ArcReviewLaunchIdentity; dispatchedAt: string; receivedAt: string; artifactReferences: string[];
}
export interface ArcReviewPendingAttempt {
  schemaVersion: 1; ledgerVersion: 1; state: "reserved" | "dispatching" | "running" | "finalizing" | "unresolved";
  attemptId: string; repositoryKey: string; taskKey: string; scopeKey: string; role: ArcReviewRole;
  adapter: ArcReviewAdapterKind; request: ArcReviewStartRequest; preparation: ArcReviewPreparationReferences;
  attemptNumber: number; effectiveAttemptBudgetMs: number; executionTimeoutMs: number; dispatchDeadlineAt: string;
  reservedAt: string; launchIdentity?: ArcReviewLaunchIdentity; dispatchReceipt?: ArcReviewDispatchReceipt;
  observedTermination?: ArcTerminationEvidence; updatedAt: string;
}
export type ArcReviewLifecycleOutcome = "not_dispatched" | "succeeded" | "spawn_failed" | "cancelled" | "timed_out" | "signaled" | "provider_lost" | "malformed_report" | "guard_failed";
export interface ArcTerminationEvidence {
  status: "observed" | "unknown" | "not_applicable"; source: "provider_process_terminal" | "standalone_child_close" | "not_started";
  runId?: string; runnerProcessInstanceId?: string; observedAt?: string; detail: string;
}
export interface ArcAdapterExecution {
  adapter: ArcReviewAdapterKind; attemptId: string; identity: ArcReviewLaunchIdentity; dispatchReceipt?: ArcReviewDispatchReceipt;
  lifecycle: ArcReviewLifecycleOutcome; exitCode?: number | null; signal?: NodeJS.Signals | null;
  structuredReport?: unknown; guardAcknowledgements: string[]; termination: ArcTerminationEvidence;
  startedAt: string; endedAt: string; boundedDiagnostics: string[]; artifactReferences: string[];
}
export interface ArcAdapterObserver {
  persistBeforeDispatch(identity: ArcReviewLaunchIdentity): Promise<void>;
  persistDispatchReceipt(receipt: ArcReviewDispatchReceipt): Promise<void>;
  persistObservedTermination(evidence: ArcTerminationEvidence): Promise<void>;
  progress(message: string): void;
}
export type ArcAdapterPreflight =
  | { ok: true }
  | { ok: false; classification: Exclude<ArcNativeAvailability, "ready">; reason: string };
export interface ArcReviewAdapter {
  readonly kind: ArcReviewAdapterKind;
  preflight(input: ArcReviewPreflightInput): Promise<ArcAdapterPreflight>;
  execute(attempt: ArcPreparedReviewAttempt, signal: AbortSignal, observer: ArcAdapterObserver): Promise<ArcAdapterExecution>;
  stop(attempt: ArcPreparedReviewAttempt, identity: ArcReviewLaunchIdentity | undefined): Promise<void>;
}
export interface ArcReviewEnvelope {
  schemaVersion: 1; policyVersion: 1; attemptId: string; repositoryKey: string; taskKey: string; scopeKey: string;
  role: ArcReviewRole; adapter: ArcReviewAdapterKind; state: ArcReviewAttemptState; baseSha: string; headSha: string;
  preparation: ArcReviewPreparationReferences; launchIdentity?: ArcReviewLaunchIdentity; dispatchReceipt?: ArcReviewDispatchReceipt;
  baselineComparison: "unchanged" | "changed" | "unreadable"; inputComparison: "unchanged" | "changed" | "unreadable";
  lifecycle: ArcReviewLifecycleOutcome; termination: ArcTerminationEvidence; guardSatisfied: boolean;
  reportDigest?: string; elapsedMs: number; cumulativeElapsedMs: number; attemptNumber: number;
  accepted: boolean; reasons: string[]; artifactReferences: string[]; modelClaims?: ArcReviewerReport;
}
export type ArcReviewResult =
  | { status: "accepted"; envelope: ArcReviewEnvelope & { state: "accepted"; accepted: true; modelClaims: ArcReviewerReport } }
  | { status: "rejected"; envelope: ArcReviewEnvelope & { state: "rejected" | "cancelled"; accepted: false } }
  | { status: "unresolved"; envelope: ArcReviewEnvelope & { state: "unresolved"; accepted: false } };

export interface ArcReviewLimits { maxFiles: number; maxTotalBytes: number; maxFileBytes: number; maxProcessOutputBytes: number; maxGitOutputBytes: number; }
export interface ArcPrimaryBaseline {
  version: 1; repositoryRoot: string; symbolicHead: string | null; headSha: string;
  activeRef: { name: string; objectId: string } | null; reviewedRefs: Array<{ name: string; objectId: string }>;
  index: { sha256: string; size: number; entriesSha256: string };
  tracked: Array<{ path: string; mode: string; kind: "file" | "symlink"; sha256?: string; target?: string } | { path: string; kind: "missing" }>;
  untracked: Array<{ path: string; mode: string; kind: "file" | "symlink"; sha256?: string; target?: string }>;
  ignoredPolicy: "excluded"; digest: string;
}
export interface ArcPreparedReviewInput { inputRoot: string; sourceRoot: string; manifestPath: string; diffPath: string; digest: string; fileCount: number; totalBytes: number; }
export interface ArcProcessResult {
  spawned: boolean; pid?: number; exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean;
  termination: "observed" | "unknown"; stdout: Uint8Array; stderr: Uint8Array;
  stdoutTruncated: boolean; stderrTruncated: boolean; startedAt: string; endedAt: string; observationError?: string;
}
export interface ArcProcessSpawnObservation { pid: number; spawnedAt: string; }
export declare function captureArcPrimaryBaseline(input: { repositoryRoot: string; reviewedRefs: string[]; limits: ArcReviewLimits }): Promise<ArcPrimaryBaseline>;
export declare function compareArcPrimaryBaseline(expected: ArcPrimaryBaseline, limits: ArcReviewLimits): Promise<{ state: "unchanged" | "changed" | "unreadable"; differences: string[]; actualDigest?: string }>;
export declare function prepareArcReviewInput(input: {
  repositoryRoot: string; baseSha: string; headSha: string; destinationRoot: string; taskContext: string;
  designContext: string; reviewContext: string; repositoryInstructions: Array<{ source: string; content: string }>;
  limits: ArcReviewLimits;
}): Promise<ArcPreparedReviewInput>;
export declare function verifyArcReviewInput(prepared: ArcPreparedReviewInput, limits: ArcReviewLimits): Promise<{ state: "unchanged" | "changed" | "unreadable"; differences: string[] }>;
export declare function runArcBoundedProcess(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: Uint8Array; timeoutMs: number;
  stopGraceMs: number; killGraceMs: number; maxOutputBytes: number; signal?: AbortSignal;
  onSpawn?: (observation: ArcProcessSpawnObservation) => Promise<void>;
}): Promise<ArcProcessResult>;

export interface ArcReviewGuardConfig {
  version: 1; attemptId: string; inputRoots: string[]; reportRoot: string; reportPath: string; reportSchemaPath: string;
  acknowledgementPath: string; expectedGuardSourceDigest: string; expectedReportSchemaDigest: string;
  expectedReviewInputDigest: string;
  allowedTools: ["read", "grep", "find", "ls", "structured_output", "arc_review_report"];
}
export interface ArcReviewGuardMaterialization {
  extensionPath: string; configPath: string; reportSchemaPath: string; acknowledgementPath: string;
  sourceDigest: string; reportSchemaDigest: string;
}
export declare function materializeArcReviewGuard(input: { config: Omit<ArcReviewGuardConfig, "expectedGuardSourceDigest" | "expectedReportSchemaDigest">; runtimeRoot: string; sourceModulePath: string; reviewerSchema: Readonly<Record<string, unknown>> }): Promise<ArcReviewGuardMaterialization>;
export interface ArcSubagentsPing {
  version: 1; methods: string[];
  capabilities: {
    asyncSpawn?: boolean; stop?: boolean; resume?: boolean;
    runtimeAcknowledgedExtensions?: { version: 1; source: "child-runtime"; event: string };
    processTerminalProof?: { version: 1; lifecycleArtifactVersion: number };
  };
  events: { asyncComplete?: string; processTerminal?: string; ready?: string; request?: string; replyPrefix?: string };
  session?: { cwd?: string; sessionId?: string; sessionFile?: string | null };
}
export interface ArcSubagentsRpcClient {
  ping(signal?: AbortSignal): Promise<ArcSubagentsPing>;
  request(requestId: string, method: "spawn" | "status" | "stop" | "resume", params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  dispose(): void;
}
export declare function createArcSubagentsRpcClient(input: {
  events: { on(name: string, handler: (value: unknown) => void): () => void; emit(name: string, value: unknown): void };
  requestTimeoutMs?: number; randomUUID?: () => string;
}): ArcSubagentsRpcClient;

export interface ArcReviewBudgetSnapshot {
  version: 1; repositoryKey: string; taskKey: string; scopeKeys: string[]; attemptsReserved: number;
  cumulativeElapsedMs: number; maxAttempts: number; maxCumulativeElapsedMs: number;
  remainingAttempts: number; remainingCumulativeMs: number; activeAttemptId?: string; updatedAt: string;
}
export interface ArcReviewReservation { budget: ArcReviewBudgetSnapshot; pending: ArcReviewPendingAttempt; attempt: ArcPreparedReviewAttempt; }
export interface ArcReviewLedger {
  reserve(input: {
    repositoryKey: string; taskKey: string; scopeKey: string; attemptId: string; adapter: ArcReviewAdapterKind;
    request: ArcReviewStartRequest; preparation: ArcReviewPreparationReferences; now: string;
  }): Promise<ArcReviewReservation>;
  persistBeforeDispatch(attemptId: string, identity: ArcReviewLaunchIdentity, now: string): Promise<ArcReviewPendingAttempt>;
  persistDispatchReceipt(attemptId: string, receipt: ArcReviewDispatchReceipt, now: string): Promise<ArcReviewPendingAttempt>;
  persistObservedTermination(attemptId: string, evidence: ArcTerminationEvidence, now: string): Promise<ArcReviewPendingAttempt>;
  finalize(input: { attemptId: string; elapsedMs: number; result: ArcReviewResult; now: string }): Promise<ArcReviewBudgetSnapshot>;
  loadPending(attemptId: string): Promise<ArcReviewPendingAttempt | undefined>;
  loadResult(attemptId: string): Promise<ArcReviewResult | undefined>;
  listPending(repositoryKey: string): Promise<ArcReviewPendingAttempt[]>;
  applyOwnerBudgetChange(input: { repositoryKey: string; taskKey: string; maxAttempts: number; maxCumulativeElapsedMs: number; approvalId: string; now: string }): Promise<ArcReviewBudgetSnapshot>;
}
export interface ArcReviewCoordinator {
  start(request: ArcReviewStartRequest, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<ArcReviewResult>;
  status(attemptId: string): Promise<ArcReviewResult | { status: "running"; pending: ArcReviewPendingAttempt }>;
  cancel(attemptId: string): Promise<ArcReviewResult>;
  reconcile(repositoryRoot: string): Promise<ArcReviewResult[]>;
  previewOwnerRecovery(attemptId: string): Promise<{ token: string; diagnostics: string[]; expiresAt: string }>;
  confirmOwnerRecovery(input: { attemptId: string; token: string }): Promise<ArcReviewResult>;
  previewBudgetChange(input: { repositoryRoot: string; taskKey: string; maxAttempts: number; maxCumulativeElapsedMs: number }): Promise<{ token: string; diagnostics: string[]; expiresAt: string }>;
  confirmBudgetChange(input: { token: string }): Promise<ArcReviewBudgetSnapshot>;
}

export type ArcSpecialistActivationMode = "file" | "runtime";
export type ArcSpecialistOwnership = "missing" | "arc_owned" | "custom" | "uncertain" | "conflict";
export interface ArcGeneratedDigestRecord { path: string; digest: string; recordedAt: string; }
export interface ArcActivationRoleState {
  role: string; mode: ArcSpecialistActivationMode; ownership: ArcSpecialistOwnership;
  sourcePath?: string; sourceDigest?: string; lastGenerated?: ArcGeneratedDigestRecord;
  backupPath?: string; backupDigest?: string; runtimeName?: string; runtimeDefinitionDigest?: string; conflictReasons: string[];
}
export interface ArcActivationManifest { version: 1; repositoryKey: string; roles: ArcActivationRoleState[]; updatedAt: string; }
export interface ArcActivationDefinitionSnapshot { role: string; digest: string; definition: ArcResolvedAgentDefinition; }
export interface ArcActivationPlan {
  manifest: ArcActivationManifest; definitions: ArcActivationDefinitionSnapshot[];
  actions: Array<{ role: string; action: "preserve_file" | "write_file" | "backup_file" | "register_runtime" | "restore_file" | "blocked"; reason: string }>;
}
export interface ArcActivationRegistrationHandle { role: string; definitionDigest: string; dispose(): void; }
export interface ArcActivationRuntimeState {
  manifest: ArcActivationManifest; definitions: ArcActivationDefinitionSnapshot[]; registrations: ArcActivationRegistrationHandle[];
}

export interface ArcWriterHandoff {
  version: 1; repositoryKey: string; taskKey: string; runId: string; sessionId: string; canonicalWorkspace: string;
  branch: string | null; headSha: string; launchContractDigest: string; resumable: boolean;
  artifactReferences: string[]; recordedAt: string;
}
export type ArcContinuationProviderStatus =
  | { state: "resumable"; runId: string; sessionId: string; taskKey: string; canonicalWorkspace: string; branch: string | null; headSha: string; launchContractDigest: string; termination: "observed"; lease: "available" }
  | { state: "not_found" | "not_retained" | "not_resumable"; runId: string; termination: "observed" }
  | { state: "live" | "paused" | "foreign" | "lease_conflict" | "unknown_termination" | "malformed"; reason: string };
export type ArcContinuationDecision =
  | { action: "resume"; runId: string; sessionId: string; message: string }
  | { action: "fresh"; reason: "missing_handoff" | "stale_head" | "contract_changed" | "not_found" | "not_retained" | "not_resumable"; priorHandoff?: ArcWriterHandoff }
  | { action: "blocked"; reason: string };
export declare function evaluateArcWriterContinuation(input: {
  handoff: ArcWriterHandoff | undefined; taskKey: string; canonicalWorkspace: string; branch: string | null;
  currentHeadSha: string; requestedLaunchContractDigest: string; providerStatus?: ArcContinuationProviderStatus; fixMessage: string;
}): ArcContinuationDecision;
