import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ARC_REVIEW_GUARD_ACK_PREFIX = "pi-arc.review-child:v1:";
const MATERIALIZED_AUTHORITY_DIGEST = "__ARC_REVIEW_AUTHORITY_DIGEST_PLACEHOLDER__";
const CONFIG_KEYS = ["acknowledgementPath", "allowedTools", "attemptId", "expectedGuardSourceDigest", "expectedReportSchemaDigest", "expectedReviewInputDigest", "inputRoots", "reportPath", "reportRoot", "reportSchemaPath", "version"] as const;
const FIXED_TOOLS = ["read", "grep", "find", "ls", "structured_output", "arc_review_report"] as const;
const PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_PROSE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_ARRAY_ENTRIES = 1024;
const MAX_EVIDENCE_RECORDS = 256;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const EVIDENCE_NAME = "guard-evidence.jsonl";

type JsonRecord = Record<string, unknown>;

interface GuardConfig {
  version: 1;
  attemptId: string;
  inputRoots: string[];
  reportRoot: string;
  reportPath: string;
  reportSchemaPath: string;
  acknowledgementPath: string;
  expectedGuardSourceDigest: string;
  expectedReportSchemaDigest: string;
  expectedReviewInputDigest: string;
  allowedTools: ["read", "grep", "find", "ls", "structured_output", "arc_review_report"];
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
}

interface LoadedGuardConfig {
  config: GuardConfig;
  digest: string;
  identity: FileIdentity;
}

interface GuardRuntimeConfig extends GuardConfig {
  canonicalInputRoots: string[];
  canonicalReportRoot: string;
  canonicalReportPath: string;
  canonicalSchemaPath: string;
  canonicalAcknowledgementPath: string;
  evidencePath: string;
  attestedDirectories: Array<{ path: string; identity: FileIdentity }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: JsonRecord, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${at} must contain exactly: ${wanted.join(", ")}`);
  }
}

function requireSafeString(value: unknown, at: string, maxBytes = MAX_PATH_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${at} must be a nonempty bounded string without NUL`);
  }
  return value;
}

function requireDigest(value: unknown, at: string): string {
  const result = requireSafeString(value, at, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${at} must be a lowercase SHA-256 digest`);
  return result;
}

function canonicalize(value: unknown, ancestors = new Set<object>(), at = "$" ): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${at} is not finite JSON`);
    return JSON.stringify(value);
  }
  if (!isRecord(value) && !Array.isArray(value)) throw new Error(`${at} is not plain JSON`);
  if (ancestors.has(value)) throw new Error(`${at} is cyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${at}[${index}] is sparse`);
        entries.push(canonicalize(value[index], ancestors, `${at}[${index}]`));
      }
      return `[${entries.join(",")}]`;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${at} has symbol keys`);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors, `${at}.${key}`)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type BigIntFileMetadata = { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; gid: bigint; mtimeNs: bigint; ctimeNs: bigint };

function sameFileMetadata(left: BigIntFileMetadata, right: BigIntFileMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileIdentity(info: BigIntFileMetadata): FileIdentity {
  return { dev: info.dev, ino: info.ino, uid: info.uid, mode: info.mode };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

async function boundedRegularFile(file: string, maxBytes: number, expectedMode?: number): Promise<Uint8Array> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
  if (before.size > BigInt(maxBytes)) throw new Error(`${file} exceeds its byte limit`);
  if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) throw new Error(`${file} has the wrong owner`);
  if (expectedMode !== undefined && (before.mode & 0o777n) !== BigInt(expectedMode)) throw new Error(`${file} must have mode ${expectedMode.toString(8)}`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileMetadata(opened, before)) throw new Error(`${file} changed while opening`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${file} changed while reading`);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileMetadata(after, opened)) throw new Error(`${file} changed while reading`);
    const final = await lstat(file, { bigint: true });
    if (!final.isFile() || !sameFileMetadata(final, before)) throw new Error(`${file} changed after reading`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function below(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function requireCanonicalDirectory(value: string, at: string, ownerOnly = false): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(`${at} must be absolute`);
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${at} must be a non-symlink directory`);
  if (ownerOnly && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))) throw new Error(`${at} must be a private owner-only directory`);
  const resolved = await realpath(value);
  if (resolved !== value) throw new Error(`${at} must be canonical`);
  return resolved;
}

async function requireCanonicalFileDestination(value: string, root: string, at: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(`${at} must be absolute`);
  const resolvedParent = await requireCanonicalDirectory(path.dirname(value), `${at} parent`);
  const result = path.join(resolvedParent, path.basename(value));
  if (result !== value || !below(root, result) || result === root) throw new Error(`${at} must be a canonical child of reportRoot`);
  return result;
}

function guardAuthority(config: GuardConfig): JsonRecord {
  const { expectedGuardSourceDigest: _sourceDigest, ...authority } = config;
  return authority;
}

function verifyMaterializedAuthority(config: GuardConfig): void {
  if (!/^[a-f0-9]{64}$/.test(MATERIALIZED_AUTHORITY_DIGEST)) throw new Error("guard authority binding was not materialized");
  const actual = sha256(Buffer.from(canonicalize(guardAuthority(config)), "utf8"));
  if (actual !== MATERIALIZED_AUTHORITY_DIGEST) throw new Error("guard config authority does not match the materialized guard");
}

async function readAndValidateConfig(configUrl: URL): Promise<LoadedGuardConfig> {
  const configPath = fileURLToPath(configUrl);
  const bytes = await boundedRegularFile(configPath, MAX_CONFIG_BYTES, 0o400);
  const metadata = await lstat(configPath, { bigint: true });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("guard config must be valid UTF-8 JSON"); }
  if (!isRecord(value)) throw new Error("guard config must be an object");
  exactKeys(value, CONFIG_KEYS, "guard config");
  if (value.version !== 1) throw new Error("guard config version must be 1");
  const attemptId = requireSafeString(value.attemptId, "attemptId", 256);
  if (!Array.isArray(value.inputRoots) || value.inputRoots.length === 0 || value.inputRoots.length > 16) throw new Error("inputRoots must be a nonempty bounded array");
  const inputRoots = value.inputRoots.map((entry, index) => requireSafeString(entry, `inputRoots[${index}]`));
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length !== FIXED_TOOLS.length || value.allowedTools.some((entry, index) => entry !== FIXED_TOOLS[index])) {
    throw new Error("allowedTools must equal the fixed review allowlist");
  }
  const config: GuardConfig = {
    version: 1,
    attemptId,
    inputRoots,
    reportRoot: requireSafeString(value.reportRoot, "reportRoot"),
    reportPath: requireSafeString(value.reportPath, "reportPath"),
    reportSchemaPath: requireSafeString(value.reportSchemaPath, "reportSchemaPath"),
    acknowledgementPath: requireSafeString(value.acknowledgementPath, "acknowledgementPath"),
    expectedGuardSourceDigest: requireDigest(value.expectedGuardSourceDigest, "expectedGuardSourceDigest"),
    expectedReportSchemaDigest: requireDigest(value.expectedReportSchemaDigest, "expectedReportSchemaDigest"),
    expectedReviewInputDigest: requireDigest(value.expectedReviewInputDigest, "expectedReviewInputDigest"),
    allowedTools: [...FIXED_TOOLS],
  };
  verifyMaterializedAuthority(config);
  return {
    config,
    digest: sha256(bytes),
    identity: fileIdentity(metadata),
  };
}

async function canonicalRuntimeConfig(config: GuardConfig): Promise<GuardRuntimeConfig> {
  const canonicalInputRoots = await Promise.all(config.inputRoots.map((root, index) => requireCanonicalDirectory(root, `inputRoots[${index}]`)));
  if (new Set(canonicalInputRoots).size !== canonicalInputRoots.length) throw new Error("inputRoots must be unique");
  const canonicalReportRoot = await requireCanonicalDirectory(config.reportRoot, "reportRoot", true);
  for (const root of canonicalInputRoots) {
    if (below(root, canonicalReportRoot) || below(canonicalReportRoot, root)) throw new Error("reportRoot and inputRoots must be disjoint");
  }
  const canonicalReportPath = await requireCanonicalFileDestination(config.reportPath, canonicalReportRoot, "reportPath");
  if (!path.isAbsolute(config.reportSchemaPath)) throw new Error("reportSchemaPath must be absolute");
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  await requireCanonicalDirectory(moduleRoot, "guard module root", true);
  const canonicalSchemaPath = path.resolve(config.reportSchemaPath);
  if (canonicalSchemaPath !== config.reportSchemaPath || path.dirname(canonicalSchemaPath) !== moduleRoot) throw new Error("reportSchemaPath must be a canonical sibling of the guard module");
  const canonicalAcknowledgementPath = await requireCanonicalFileDestination(config.acknowledgementPath, canonicalReportRoot, "acknowledgementPath");
  const evidencePath = await requireCanonicalFileDestination(path.join(canonicalReportRoot, EVIDENCE_NAME), canonicalReportRoot, "evidencePath");
  if (new Set([canonicalReportPath, canonicalSchemaPath, canonicalAcknowledgementPath, evidencePath]).size !== 4) throw new Error("guard artifact paths must be distinct");
  const attestedPaths = [...canonicalInputRoots, canonicalReportRoot, moduleRoot];
  const attestedDirectories = await Promise.all(attestedPaths.map(async (directory) => ({
    path: directory,
    identity: fileIdentity(await lstat(directory, { bigint: true })),
  })));
  return { ...config, canonicalInputRoots, canonicalReportRoot, canonicalReportPath, canonicalSchemaPath, canonicalAcknowledgementPath, evidencePath, attestedDirectories };
}

async function verifyOwnModuleAndSchema(config: GuardRuntimeConfig): Promise<Readonly<JsonRecord>> {
  const ownPath = fileURLToPath(import.meta.url);
  if (await realpath(ownPath) !== ownPath) throw new Error("guard module path must be canonical");
  const ownBytes = await boundedRegularFile(ownPath, MAX_MODULE_BYTES, 0o400);
  if (sha256(ownBytes) !== config.expectedGuardSourceDigest) throw new Error("guard source digest mismatch");
  if (await realpath(config.canonicalSchemaPath) !== config.canonicalSchemaPath) throw new Error("report schema path must be canonical");
  const schemaBytes = await boundedRegularFile(config.canonicalSchemaPath, MAX_SCHEMA_BYTES, 0o400);
  if (sha256(schemaBytes) !== config.expectedReportSchemaDigest) throw new Error("report schema digest mismatch");
  let schema: unknown;
  try { schema = JSON.parse(Buffer.from(schemaBytes).toString("utf8")); } catch { throw new Error("report schema must be valid UTF-8 JSON"); }
  if (!isRecord(schema)) throw new Error("report schema must be an object");
  return deepFreeze(schema);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertStagedEntry(
  name: string,
  handle: Awaited<ReturnType<typeof open>>,
  identity: FileIdentity,
  contents: Uint8Array,
  mode: number,
): Promise<void> {
  const descriptorBefore = await handle.stat({ bigint: true });
  if (!descriptorBefore.isFile() || !sameIdentity(fileIdentity(descriptorBefore), identity) || descriptorBefore.size !== BigInt(contents.byteLength) ||
      (descriptorBefore.mode & 0o777n) !== BigInt(mode) || (typeof process.getuid === "function" && descriptorBefore.uid !== BigInt(process.getuid()))) {
    throw new Error("staged publication descriptor identity changed");
  }
  const namedBefore = await lstat(name, { bigint: true });
  if (!namedBefore.isFile() || !sameIdentity(fileIdentity(namedBefore), identity) || namedBefore.size !== BigInt(contents.byteLength) ||
      (namedBefore.mode & 0o777n) !== BigInt(mode)) throw new Error("staged publication entry identity changed");
  const actual = await boundedRegularFile(name, contents.byteLength, mode);
  if (!Buffer.from(actual).equals(Buffer.from(contents))) throw new Error("staged publication contents changed");
  const descriptorAfter = await handle.stat({ bigint: true });
  const namedAfter = await lstat(name, { bigint: true });
  if (!descriptorAfter.isFile() || !namedAfter.isFile() || !sameIdentity(fileIdentity(descriptorAfter), identity) ||
      !sameIdentity(fileIdentity(namedAfter), identity) || !sameFileMetadata(descriptorBefore, descriptorAfter) ||
      !sameFileMetadata(namedBefore, namedAfter)) throw new Error("staged publication changed while verifying");
}

async function writeExclusiveAtomic(destination: string, contents: Uint8Array, mode: number): Promise<void> {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${Date.now()}.${createHash("sha256").update(contents).digest("hex").slice(0, 12)}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, mode);
  let failed = false;
  try {
    await handle.chmod(mode);
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || (typeof process.getuid === "function" && initial.uid !== BigInt(process.getuid()))) throw new Error("staged publication must be an owner-owned regular file");
    const stagedIdentity = fileIdentity(initial);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesWritten } = await handle.write(contents, offset, contents.byteLength - offset, offset);
      if (bytesWritten === 0) throw new Error("short artifact write");
      offset += bytesWritten;
    }
    await handle.sync();
    await assertStagedEntry(temporary, handle, stagedIdentity, contents, mode);
    await link(temporary, destination);
    await assertStagedEntry(destination, handle, stagedIdentity, contents, mode);
    await assertStagedEntry(temporary, handle, stagedIdentity, contents, mode);
    await unlink(temporary);
    await syncDirectory(directory);
    await assertStagedEntry(destination, handle, stagedIdentity, contents, mode);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await handle.close(); }
    catch (error) { if (!failed) throw error; }
  }
}

function acknowledgement(config: GuardRuntimeConfig): JsonRecord {
  return {
    version: 1,
    attemptId: config.attemptId,
    id: ARC_REVIEW_GUARD_ACK_PREFIX + config.attemptId,
    guardSourceDigest: config.expectedGuardSourceDigest,
    reportSchemaDigest: config.expectedReportSchemaDigest,
    loadedAt: new Date().toISOString(),
  };
}

function reportErrors(value: unknown, expectedDigest: string): string[] {
  const errors: string[] = [];
  const stringValue = (entry: unknown, at: string, max: number, nonempty = true): string => {
    if (typeof entry !== "string" || (nonempty && !entry.trim()) || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > max) errors.push(`${at}: invalid string`);
    return typeof entry === "string" ? entry : "";
  };
  const array = (entry: unknown, at: string): unknown[] => {
    if (!Array.isArray(entry)) { errors.push(`${at}: invalid array`); return []; }
    if (entry.length > MAX_ARRAY_ENTRIES) errors.push(`${at}: invalid array`);
    return entry.slice(0, MAX_ARRAY_ENTRIES);
  };
  if (!isRecord(value)) return ["$: must be an object"];
  try { exactKeys(value, ["schemaVersion", "reviewInputDigest", "verdict", "summary", "findings", "coverage", "limitations"], "$"); } catch (error) { errors.push((error as Error).message); }
  if (value.schemaVersion !== 1) errors.push("$.schemaVersion: must equal 1");
  if (value.reviewInputDigest !== expectedDigest) errors.push("$.reviewInputDigest: mismatch");
  if (!["PASS", "CHANGES_REQUESTED", "BLOCKED"].includes(value.verdict as string)) errors.push("$.verdict: invalid");
  stringValue(value.summary, "$.summary", MAX_PROSE_BYTES);
  const findings = array(value.findings, "$.findings");
  const ids = new Set<string>();
  let hasBlocking = false;
  let hasCritical = false;
  findings.forEach((entry, index) => {
    const at = `$.findings[${index}]`;
    if (!isRecord(entry)) { errors.push(`${at}: invalid object`); return; }
    try { exactKeys(entry, Object.hasOwn(entry, "path") || Object.hasOwn(entry, "line") ? ["id", "severity", "category", "blocking", "explanation", ...Object.hasOwn(entry, "path") ? ["path"] : [], ...Object.hasOwn(entry, "line") ? ["line"] : []] : ["id", "severity", "category", "blocking", "explanation"], at); } catch (error) { errors.push((error as Error).message); }
    const id = stringValue(entry.id, `${at}.id`, 128);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) || ids.has(id)) errors.push(`${at}.id: invalid or duplicate`); else ids.add(id);
    if (!["critical", "important", "minor"].includes(entry.severity as string)) errors.push(`${at}.severity: invalid`);
    if (!["missing", "extra", "misunderstood", "correctness", "security", "quality", "test_gap", "deviation"].includes(entry.category as string)) errors.push(`${at}.category: invalid`);
    if (typeof entry.blocking !== "boolean") errors.push(`${at}.blocking: invalid`); else hasBlocking ||= entry.blocking;
    hasCritical ||= entry.severity === "critical";
    stringValue(entry.explanation, `${at}.explanation`, MAX_PROSE_BYTES);
    if (Object.hasOwn(entry, "path")) stringValue(entry.path, `${at}.path`, MAX_PATH_BYTES);
    if (Object.hasOwn(entry, "line") && (!Number.isSafeInteger(entry.line) || (entry.line as number) < 1)) errors.push(`${at}.line: invalid`);
  });
  if (!isRecord(value.coverage)) errors.push("$.coverage: invalid object");
  else {
    try { exactKeys(value.coverage, ["reviewedPaths", "reviewedRequirements"], "$.coverage"); } catch (error) { errors.push((error as Error).message); }
    array(value.coverage.reviewedPaths, "$.coverage.reviewedPaths").forEach((entry, index) => stringValue(entry, `$.coverage.reviewedPaths[${index}]`, MAX_PATH_BYTES));
    array(value.coverage.reviewedRequirements, "$.coverage.reviewedRequirements").forEach((entry, index) => stringValue(entry, `$.coverage.reviewedRequirements[${index}]`, MAX_PROSE_BYTES));
  }
  const limitations = array(value.limitations, "$.limitations");
  limitations.forEach((entry, index) => stringValue(entry, `$.limitations[${index}]`, MAX_PROSE_BYTES));
  if (value.verdict === "PASS" && (limitations.length > 0 || hasBlocking || hasCritical)) errors.push("$.verdict: contradictory PASS");
  if (value.verdict === "CHANGES_REQUESTED" && !hasBlocking) errors.push("$.verdict: requires blocking finding");
  return errors;
}

async function requireAbsent(file: string, label: string): Promise<void> {
  try {
    await lstat(file);
    throw new Error(`${label} is preexisting`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createReportTool(
  config: GuardRuntimeConfig,
  schema: Readonly<JsonRecord>,
  canWrite: () => boolean,
  onPublicationFailure: () => Promise<never>,
) {
  let writeInFlight: Promise<void> | undefined;
  let written = false;
  return {
    name: "arc_review_report",
    label: "Arc Review Report",
    description: "Submit the final fixed-schema Arc reviewer report exactly once.",
    parameters: schema,
    async execute(_toolCallId: string, params: unknown) {
      if (!canWrite()) throw new Error("review guard initialization is not satisfied");
      if (written || writeInFlight) throw new Error("review report was already submitted");
      const errors = reportErrors(params, config.expectedReviewInputDigest);
      if (errors.length) throw new Error(`invalid review report: ${errors.slice(0, 8).join("; ")}`);
      const bytes = Buffer.from(canonicalize(params), "utf8");
      if (bytes.length > MAX_REPORT_BYTES) throw new Error("review report exceeds byte limit");
      writeInFlight = writeExclusiveAtomic(config.canonicalReportPath, bytes, 0o600);
      try {
        try { await writeInFlight; }
        catch { return await onPublicationFailure(); }
        written = true;
      } finally {
        writeInFlight = undefined;
      }
      return { content: [{ type: "text", text: "Arc review report saved." }], details: {}, terminate: true };
    },
  };
}

function evidenceWriter(config: GuardRuntimeConfig) {
  let records = 0;
  let bytes = 0;
  let overflowed = false;
  let failed = false;
  let queue = Promise.resolve();
  const append = async (record: JsonRecord): Promise<void> => {
    const line = Buffer.from(`${canonicalize(record)}\n`, "utf8");
    const marker = Buffer.from(`${canonicalize({ overflow: true, reason: "guard evidence limit exceeded" })}\n`, "utf8");
    let selected = line;
    if (records >= MAX_EVIDENCE_RECORDS - 1 || bytes + line.length + marker.length > MAX_EVIDENCE_BYTES) {
      if (overflowed) return;
      overflowed = true;
      selected = marker;
      if (records >= MAX_EVIDENCE_RECORDS || bytes + selected.length > MAX_EVIDENCE_BYTES) return;
    }
    const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(config.evidencePath, flags, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("invalid evidence artifact");
      await handle.chmod(0o600);
      await handle.writeFile(selected);
      await handle.sync();
    } finally { await handle.close(); }
    bytes += selected.length;
    records += 1;
    await syncDirectory(config.canonicalReportRoot);
  };
  return {
    record(tool: unknown, callId: unknown, reason: string): Promise<void> {
      const clean = (value: unknown) => typeof value === "string" ? value.slice(0, 256) : "unknown";
      queue = queue
        .then(() => append({ tool: clean(tool), callId: clean(callId), reason }), () => append({ tool: clean(tool), callId: clean(callId), reason }))
        .catch((error) => { failed = true; throw error; });
      return queue;
    },
    satisfied: () => !overflowed && !failed,
  };
}

async function enforceToolCall(event: unknown, config: GuardRuntimeConfig, ready: boolean, record: (tool: unknown, callId: unknown, reason: string) => Promise<void>) {
  const object = isRecord(event) ? event : {};
  const toolName = object.toolName;
  const callId = object.toolCallId;
  const block = async (reason: string) => {
    await record(toolName, callId, reason).catch(() => {});
    return { block: true, reason };
  };
  if (!ready) return block("review guard initialization is not satisfied");
  if (typeof toolName !== "string" || !config.allowedTools.includes(toolName as never)) return block("tool is not allowed by review policy");
  if (!PATH_TOOLS.has(toolName)) {
    if (isRecord(object.input) && Object.hasOwn(object.input, "path")) return block("fixed report tools do not accept a path");
    return undefined;
  }
  if (!isRecord(object.input) || !Object.hasOwn(object.input, "path") || typeof object.input.path !== "string" || object.input.path.length === 0 || object.input.path.includes("\0")) {
    return block("absolute path required for review read/search tool");
  }
  if (!path.isAbsolute(object.input.path)) return block("absolute path required for review read/search tool");
  let resolved: string;
  try { resolved = await realpath(object.input.path); } catch { return block("review path must resolve to an existing input"); }
  if (!config.canonicalInputRoots.some((root) => below(root, resolved))) return block("review path is outside approved input roots");
  object.input.path = resolved;
  return undefined;
}

const configUrl = new URL("./arc-review-guard.json", import.meta.url);
const loadedConfig = await readAndValidateConfig(configUrl);
const config = await canonicalRuntimeConfig(loadedConfig.config);

async function reattestStartup(): Promise<void> {
  const current = await readAndValidateConfig(configUrl);
  if (current.digest !== loadedConfig.digest || !sameIdentity(current.identity, loadedConfig.identity)) throw new Error("guard config changed after extension load");
  const runtime = await canonicalRuntimeConfig(current.config);
  if (canonicalize(current.config) !== canonicalize(loadedConfig.config)) throw new Error("guard config authority changed after extension load");
  if (runtime.attestedDirectories.length !== config.attestedDirectories.length || runtime.attestedDirectories.some((entry, index) =>
    entry.path !== config.attestedDirectories[index].path || !sameIdentity(entry.identity, config.attestedDirectories[index].identity))) {
    throw new Error("guard canonical root identity changed after extension load");
  }
}

export default async function reviewChild(pi: ExtensionAPI): Promise<void> {
  let initialized = false;
  let publicationFailed = false;
  let schema: Readonly<JsonRecord> | undefined;
  const evidence = evidenceWriter(config);
  const publicationFailure = async (channel: "acknowledgement" | "report"): Promise<never> => {
    publicationFailed = true;
    initialized = false;
    const timer = setTimeout(() => process.exit(1), 1000);
    try {
      await evidence.record("guard-publication", channel, "publication failed");
      if (!(await boundedRegularFile(config.evidencePath, MAX_EVIDENCE_BYTES, 0o600)).length) process.exit(1);
    } catch {
      process.exit(1);
    } finally {
      clearTimeout(timer);
    }
    throw new Error("publication failed; guard evidence retained");
  };

  pi.on("session_start", async () => {
    initialized = false;
    await reattestStartup();
    schema = await verifyOwnModuleAndSchema(config);
    await Promise.all([
      requireAbsent(config.canonicalAcknowledgementPath, "guard acknowledgement"),
      requireAbsent(config.canonicalReportPath, "review report"),
      requireAbsent(config.evidencePath, "guard evidence"),
    ]);
    const ack = Buffer.from(canonicalize(acknowledgement(config)), "utf8");
    try { await writeExclusiveAtomic(config.canonicalAcknowledgementPath, ack, 0o600); }
    catch { return await publicationFailure("acknowledgement"); }
    initialized = !publicationFailed;
    pi.events.emit("subagent:acknowledge-extension", { id: ARC_REVIEW_GUARD_ACK_PREFIX + config.attemptId });
  });
  pi.on("tool_call", async (event) => enforceToolCall(event, config, initialized && !publicationFailed && evidence.satisfied(), evidence.record));

  schema = await verifyOwnModuleAndSchema(config);
  pi.registerTool(createReportTool(config, schema, () => initialized && !publicationFailed && evidence.satisfied(), () => publicationFailure("report")));
}
