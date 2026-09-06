import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { runArcBoundedProcess } from "./process.ts";
import {
  ARC_REVIEW_GUARD_ACK_PREFIX,
  ARC_REVIEW_KILL_GRACE_MS,
  ARC_REVIEW_MAX_FILES,
  ARC_REVIEW_MAX_FILE_BYTES,
  ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES,
  ARC_REVIEW_STOP_GRACE_MS,
  canonicalizeArcJson,
  validateArcReviewerReport,
  type ArcAdapterExecution,
  type ArcAdapterObserver,
  type ArcPreparedReviewAttempt,
  type ArcProcessResult,
  type ArcReviewAdapter,
  type ArcReviewDispatchReceipt,
  type ArcReviewGuardConfig,
  type ArcReviewGuardMaterialization,
  type ArcReviewLaunchIdentity,
  type ArcReviewPreparationReferences,
  type ArcReviewPreflightInput,
  type ArcReviewStartRequest,
  type ArcTerminationEvidence,
} from "./reports.ts";

interface ArcStandaloneReviewOptions {
  piCommand: string;
  selectedModel: string;
  buildPrompt: (attempt: ArcPreparedReviewAttempt) => { systemPrompt: string; task: string };
  trustedProviderExtensions: string[];
  processEnv: NodeJS.ProcessEnv;
  randomUUID?: () => string;
}

interface ArcReviewGuardAcknowledgement {
  version: 1;
  attemptId: string;
  id: string;
  guardSourceDigest: string;
  reportSchemaDigest: string;
  loadedAt: string;
}

interface OwnedProcess {
  identity: ArcReviewLaunchIdentity;
  controller: AbortController;
}

const DATA_ENV_KEYS = `PATH LANG LC_ALL LC_CTYPE TZ TERM CI NO_COLOR
ANTHROPIC_API_KEY ANT_LING_API_KEY AZURE_OPENAI_API_KEY OPENAI_API_KEY
DEEPSEEK_API_KEY NVIDIA_API_KEY GEMINI_API_KEY AWS_BEARER_TOKEN_BEDROCK
MISTRAL_API_KEY GROQ_API_KEY CEREBRAS_API_KEY CLOUDFLARE_API_KEY
XAI_API_KEY OPENROUTER_API_KEY AI_GATEWAY_API_KEY ZAI_API_KEY
ZAI_CODING_CN_API_KEY OPENCODE_API_KEY RADIUS_API_KEY HF_TOKEN
FIREWORKS_API_KEY TOGETHER_API_KEY BASETEN_API_KEY KIMI_API_KEY
MINIMAX_API_KEY MINIMAX_CN_API_KEY QWEN_TOKEN_PLAN_API_KEY
QWEN_TOKEN_PLAN_CN_API_KEY XIAOMI_API_KEY XIAOMI_TOKEN_PLAN_CN_API_KEY
XIAOMI_TOKEN_PLAN_AMS_API_KEY XIAOMI_TOKEN_PLAN_SGP_API_KEY
AZURE_OPENAI_BASE_URL AZURE_OPENAI_RESOURCE_NAME AZURE_OPENAI_API_VERSION
AZURE_OPENAI_DEPLOYMENT_NAME_MAP CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_GATEWAY_ID
AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION
GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION HTTP_PROXY HTTPS_PROXY`.split(/\s+/);
const PRIVATE_DIRECTORIES = {
  PI_CODING_AGENT_DIR: "pi-agent",
  PI_CODING_AGENT_SESSION_DIR: "sessions",
  PI_SERVER_DIR: "server",
  HOME: "home",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_DATA_HOME: "xdg-data",
  XDG_STATE_HOME: "xdg-state",
  XDG_RUNTIME_DIR: "xdg-runtime",
  TMPDIR: "tmp",
} as const;
const GUARD_EXTENSION_NAME = "review-child.ts";
const GUARD_CONFIG_NAME = "arc-review-guard.json";
const AUTHORITY_DIGEST_PLACEHOLDER = "__ARC_REVIEW_AUTHORITY_DIGEST_PLACEHOLDER__";
const GUARD_CONFIG_KEYS = ["acknowledgementPath", "allowedTools", "attemptId", "expectedGuardSourceDigest", "expectedReportSchemaDigest", "expectedReviewInputDigest", "inputRoots", "reportPath", "reportRoot", "reportSchemaPath", "version"] as const;
const FIXED_GUARD_TOOLS = ["read", "grep", "find", "ls", "structured_output", "arc_review_report"] as const;
const EVIDENCE_NAME = "guard-evidence.jsonl";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_LINES = 128;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;

type InterruptionKind = "timed_out" | "cancelled";

class AttemptInterrupted extends Error {
  readonly kind: InterruptionKind;
  constructor(kind: InterruptionKind) {
    super(kind === "cancelled" ? "review attempt cancelled" : "review observer or preparation deadline timed out");
    this.name = "AttemptInterrupted";
    this.kind = kind;
  }
}

interface BoundedWindow {
  check(): void;
  wait<T>(start: () => Promise<T>, discard?: (value: T) => Promise<void>): Promise<T>;
  close(): void;
}

function boundedWindow(end: number, signal: AbortSignal, clock: () => number): BoundedWindow {
  let closed = false;
  const outstanding = new Set<(error: AttemptInterrupted) => void>();
  const interruption = () => new AttemptInterrupted(signal.aborted ? "cancelled" : "timed_out");
  const check = () => {
    if (closed || signal.aborted || clock() >= end) throw interruption();
  };
  return {
    check,
    wait<T>(start: () => Promise<T>, discard?: (value: T) => Promise<void>): Promise<T> {
      check();
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          outstanding.delete(onClosed);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => fail(new AttemptInterrupted("cancelled"));
        const onClosed = (error: AttemptInterrupted) => fail(error);
        outstanding.add(onClosed);
        signal.addEventListener("abort", onAbort, { once: true });
        const remaining = Math.max(0, end - clock());
        timer = setTimeout(() => fail(new AttemptInterrupted("timed_out")), remaining);
        let operation: Promise<T>;
        try { operation = start(); }
        catch (error) { fail(error); return; }
        Promise.resolve(operation).then(
          (value) => {
            if (settled) {
              if (discard) void discard(value).catch(() => {});
              return;
            }
            try { check(); }
            catch (error) { fail(error); if (discard) void discard(value).catch(() => {}); return; }
            settled = true;
            cleanup();
            resolve(value);
          },
          (error) => fail(error),
        );
      });
    },
    close() {
      if (closed) return;
      closed = true;
      const error = interruption();
      for (const reject of [...outstanding]) reject(error);
      outstanding.clear();
    },
  };
}

function nowIso(): string { return new Date().toISOString(); }

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 4096) return message;
  let end = 4096;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function below(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function guarded<T>(window: BoundedWindow | undefined, start: () => Promise<T>, discard?: (value: T) => Promise<void>): Promise<T> {
  return window ? window.wait(start, discard) : start();
}

async function canonicalDirectory(value: string, name: string, ownerOnly = false, window?: BoundedWindow): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute canonical directory`);
  const info = await guarded(window, () => lstat(value));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink directory`);
  if (ownerOnly && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))) throw new Error(`${name} must be a private owner-only directory`);
  const canonical = await guarded(window, () => realpath(value));
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function canonicalRegularFile(value: string, name: string, window?: BoundedWindow): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute canonical file`);
  const info = await guarded(window, () => lstat(value));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink regular file`);
  const canonical = await guarded(window, () => realpath(value));
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function canonicalDestination(value: string, root: string, name: string, window?: BoundedWindow): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be absolute`);
  const parent = await canonicalDirectory(path.dirname(value), `${name} parent`, false, window);
  const canonical = path.join(parent, path.basename(value));
  if (canonical !== value || canonical === root || !below(root, canonical)) throw new Error(`${name} must be a canonical path below its private root`);
  return canonical;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(destination: string, bytes: Uint8Array, mode: number): Promise<void> {
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(destination, flags, mode);
  try {
    await handle.chmod(mode);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesWritten === 0) throw new Error(`short write for ${destination}`);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(destination));
}

type BigIntFileMetadata = { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; gid: bigint; mtimeNs: bigint; ctimeNs: bigint };

function sameFileMetadata(left: BigIntFileMetadata, right: BigIntFileMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function boundedRead(file: string, maxBytes: number, expectedMode?: number, window?: BoundedWindow): Promise<Uint8Array> {
  const before = await guarded(window, () => lstat(file, { bigint: true }));
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error(`${file} is not a bounded regular file`);
  if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) throw new Error(`${file} has the wrong owner`);
  if (expectedMode !== undefined && (before.mode & 0o777n) !== BigInt(expectedMode)) throw new Error(`${file} has the wrong mode`);
  const handle = await guarded(window, () => open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)), (late) => late.close());
  try {
    const opened = await guarded(window, () => handle.stat({ bigint: true }));
    if (!opened.isFile() || !sameFileMetadata(opened, before)) throw new Error(`${file} changed while opening`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await guarded(window, () => handle.read(bytes, offset, bytes.length - offset, offset));
      if (result.bytesRead === 0) throw new Error(`${file} changed while reading`);
      offset += result.bytesRead;
    }
    const after = await guarded(window, () => handle.stat({ bigint: true }));
    if (!sameFileMetadata(after, opened)) throw new Error(`${file} changed while reading`);
    const final = await guarded(window, () => lstat(file, { bigint: true }));
    if (!final.isFile() || !sameFileMetadata(final, before)) throw new Error(`${file} changed after reading`);
    return bytes;
  } finally {
    if (window) {
      let closing: Promise<void>;
      try { closing = handle.close(); }
      catch (error) { closing = Promise.reject(error); }
      void closing.catch(() => {});
      try { await window.wait(() => closing); }
      catch { /* Cleanup cannot replace the bounded read or interruption outcome. */ }
    } else await handle.close();
  }
}

async function sha256File(file: string, window?: BoundedWindow): Promise<string> {
  return createHash("sha256").update(await boundedRead(file, MAX_ARTIFACT_BYTES, undefined, window)).digest("hex");
}

function validateMaterializationConfig(config: Omit<ArcReviewGuardConfig, "expectedGuardSourceDigest" | "expectedReportSchemaDigest">): void {
  if (!isRecord(config)) throw new Error("guard config must be an object");
  const expectedKeys = ["acknowledgementPath", "allowedTools", "attemptId", "expectedReviewInputDigest", "inputRoots", "reportPath", "reportRoot", "reportSchemaPath", "version"];
  const keys = Object.keys(config).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("guard config must contain the exact expected keys");
  if (config.version !== 1) throw new Error("guard config version must equal 1");
  if (typeof config.attemptId !== "string" || !config.attemptId || config.attemptId.includes("\0") || Buffer.byteLength(config.attemptId, "utf8") > 256) throw new Error("guard config attemptId is invalid");
  if (!Array.isArray(config.inputRoots) || config.inputRoots.length === 0 || config.inputRoots.length > 16) throw new Error("guard config inputRoots are invalid");
  const paths = [...config.inputRoots, config.reportRoot, config.reportPath, config.reportSchemaPath, config.acknowledgementPath];
  if (paths.some((value) => typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096)) throw new Error("guard config paths must be bounded absolute paths");
  if (!/^[a-f0-9]{64}$/.test(config.expectedReviewInputDigest)) throw new Error("guard config review input digest is invalid");
  if (!Array.isArray(config.allowedTools) || config.allowedTools.length !== FIXED_GUARD_TOOLS.length || config.allowedTools.some((value, index) => value !== FIXED_GUARD_TOOLS[index])) throw new Error("guard config allowlist is invalid");
}

export async function materializeArcReviewGuard(input: {
  config: Omit<ArcReviewGuardConfig, "expectedGuardSourceDigest" | "expectedReportSchemaDigest">;
  runtimeRoot: string;
  sourceModulePath: string;
  reviewerSchema: Readonly<Record<string, unknown>>;
}): Promise<ArcReviewGuardMaterialization> {
  validateMaterializationConfig(input.config);
  const runtimeRoot = await canonicalDirectory(input.runtimeRoot, "runtimeRoot", true);
  const inputRoots = await Promise.all(input.config.inputRoots.map((root, index) => canonicalDirectory(root, `inputRoots[${index}]`)));
  if (inputRoots.some((root) => below(root, runtimeRoot) || below(runtimeRoot, root))) throw new Error("runtimeRoot and inputRoots must be disjoint");
  const sourceModulePath = await canonicalRegularFile(input.sourceModulePath, "sourceModulePath");
  const extensionPath = path.join(runtimeRoot, GUARD_EXTENSION_NAME);
  const configPath = path.join(runtimeRoot, GUARD_CONFIG_NAME);
  const reportSchemaPath = path.resolve(input.config.reportSchemaPath);
  if (reportSchemaPath !== input.config.reportSchemaPath || path.dirname(reportSchemaPath) !== runtimeRoot) throw new Error("reportSchemaPath must be a canonical sibling of the guard module");
  const reportRoot = await canonicalDirectory(input.config.reportRoot, "reportRoot", true);
  const acknowledgementPath = await canonicalDestination(input.config.acknowledgementPath, reportRoot, "acknowledgementPath");
  await canonicalDestination(input.config.reportPath, reportRoot, "reportPath");
  if (below(runtimeRoot, reportRoot) || below(reportRoot, runtimeRoot) || inputRoots.some((root) => below(root, reportRoot) || below(reportRoot, root))) {
    throw new Error("reportRoot must be disjoint from runtimeRoot and inputRoots");
  }
  const schemaBytes = Buffer.from(canonicalizeArcJson(input.reviewerSchema), "utf8");
  if (schemaBytes.length > MAX_ARTIFACT_BYTES) throw new Error("reviewer schema exceeds materialization limit");
  const reportSchemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
  const authority = { ...input.config, reportSchemaPath, expectedReportSchemaDigest: reportSchemaDigest };
  const authorityDigest = createHash("sha256").update(canonicalizeArcJson(authority), "utf8").digest("hex");
  const sourceBytes = await boundedRead(sourceModulePath, MAX_ARTIFACT_BYTES);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes); }
  catch { throw new Error("guard source module must be strict UTF-8"); }
  if (source.split(AUTHORITY_DIGEST_PLACEHOLDER).length !== 2) throw new Error("guard source module must contain exactly one authority binding placeholder");
  const materializedSource = Buffer.from(source.replace(AUTHORITY_DIGEST_PLACEHOLDER, authorityDigest), "utf8");
  if (materializedSource.length > MAX_ARTIFACT_BYTES) throw new Error("materialized guard source exceeds byte limit");
  try {
    await writeExclusive(extensionPath, materializedSource, 0o600);
    await writeExclusive(reportSchemaPath, schemaBytes, 0o600);
    const sourceDigest = await sha256File(extensionPath);
    const completedConfig: ArcReviewGuardConfig = { ...authority, expectedGuardSourceDigest: sourceDigest };
    await writeExclusive(configPath, Buffer.from(canonicalizeArcJson(completedConfig), "utf8"), 0o600);
    for (const file of [extensionPath, reportSchemaPath, configPath]) await chmod(file, 0o400);
    await syncDirectory(runtimeRoot);
    return { extensionPath, configPath, reportSchemaPath, acknowledgementPath, sourceDigest, reportSchemaDigest };
  } catch (error) {
    const code = typeof (error as NodeJS.ErrnoException)?.code === "string" ? ` code=${(error as NodeJS.ErrnoException).code}` : "";
    const kind = error instanceof Error ? error.name : "unknown";
    throw new Error(`guard preparation failed; retained paths: runtimeRoot=${runtimeRoot}, extension=${extensionPath}, schema=${reportSchemaPath}, config=${configPath}; cause=${kind}${code}`);
  }
}

async function canonicalPrivateFile(value: string, name: string, window?: BoundedWindow): Promise<string> {
  const file = await canonicalRegularFile(value, name, window);
  const info = await guarded(window, () => lstat(file));
  if ((info.mode & 0o777) !== 0o400 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${name} must be immutable and owner-only`);
  return file;
}

async function manifestReviewerPaths(inputRoot: string, manifestPath: string, window?: BoundedWindow): Promise<string[]> {
  const bytes = await boundedRead(manifestPath, ARC_REVIEW_MAX_FILE_BYTES, undefined, window);
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("review input manifest must be strict UTF-8 JSON"); }
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.source) || !Array.isArray(manifest.materials) ||
      manifest.source.length > ARC_REVIEW_MAX_FILES || manifest.materials.length > ARC_REVIEW_MAX_FILES ||
      manifest.source.length + manifest.materials.length + 1 > ARC_REVIEW_MAX_FILES) throw new Error("review input manifest file arrays are invalid");
  const sourceSeen = new Set<string>();
  const sourceRoot = path.join(inputRoot, "source");
  for (const [index, row] of manifest.source.entries()) {
    if (!isRecord(row) || typeof row.path !== "string" || !row.path || row.path.includes("\0") || path.posix.isAbsolute(row.path) || row.path.includes("\\") ||
        row.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`review input manifest source ${index} has an invalid path`);
    if (sourceSeen.has(row.path)) throw new Error("review input manifest has duplicate source paths");
    sourceSeen.add(row.path);
    const candidate = path.join(sourceRoot, ...row.path.split("/"));
    const file = await canonicalRegularFile(candidate, `manifest source ${row.path}`, window);
    if (!below(sourceRoot, file)) throw new Error(`manifest source ${row.path} escapes sourceRoot`);
  }
  const materialPaths: string[] = [];
  const seen = new Set<string>();
  const instructionNumbers = new Set<number>();
  for (const [index, row] of manifest.materials.entries()) {
    if (!isRecord(row) || typeof row.path !== "string" || !row.path || row.path.includes("\0") || path.posix.isAbsolute(row.path) || row.path.includes("\\") ||
        row.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`review input manifest material ${index} has an invalid path`);
    if (seen.has(row.path)) throw new Error("review input manifest has duplicate materials");
    seen.add(row.path);
    if (!["materials/diff.patch", "materials/task.md", "materials/design.md", "materials/review.md"].includes(row.path)) {
      const match = /^materials\/instructions\/([0-9]+)\.md$/.exec(row.path);
      if (!match || match[1].length > 5) throw new Error("invalid instruction name");
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || number > ARC_REVIEW_MAX_FILES || row.path !== `materials/instructions/${String(number).padStart(4, "0")}.md`) {
        throw new Error("invalid instruction index");
      }
      if (instructionNumbers.has(number)) throw new Error("duplicate instruction");
      instructionNumbers.add(number);
    }
    const candidate = path.join(inputRoot, ...row.path.split("/"));
    const file = await canonicalRegularFile(candidate, `manifest material ${row.path}`, window);
    if (!below(inputRoot, file)) throw new Error(`manifest material ${row.path} escapes inputRoot`);
    materialPaths.push(file);
  }
  for (let number = 1; number <= instructionNumbers.size; number += 1) {
    if (!instructionNumbers.has(number)) throw new Error("instruction gap");
  }
  for (const required of ["materials/diff.patch", "materials/task.md", "materials/design.md", "materials/review.md"]) {
    if (!seen.has(required)) throw new Error(`review input manifest omitted ${required}`);
  }
  if (instructionNumbers.size > ARC_REVIEW_MAX_FILES - manifest.source.length - 4 - 1) throw new Error("too many review instructions");
  return materialPaths;
}

async function readBoundGuardConfig(preparation: ArcReviewPreparationReferences, expectedAttemptId?: string, window?: BoundedWindow): Promise<ArcReviewGuardConfig> {
  const bytes = await boundedRead(preparation.guardConfigPath, 256 * 1024, 0o400, window);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("guard config is not strict UTF-8 JSON"); }
  if (!isRecord(value)) throw new Error("guard config must be an object");
  const keys = Object.keys(value).sort();
  const expectedKeys = [...GUARD_CONFIG_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("guard config must contain the exact expected keys");
  if (value.version !== 1 || typeof value.attemptId !== "string" || !value.attemptId || value.attemptId.includes("\0") || Buffer.byteLength(value.attemptId, "utf8") > 256) {
    throw new Error("guard config attempt identity is invalid");
  }
  if (expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId) throw new Error("guard config attemptId does not match the complete attempt");
  if (!Array.isArray(value.inputRoots) || value.inputRoots.length !== 1 || value.inputRoots[0] !== preparation.inputRoot) {
    throw new Error("guard config inputRoots do not match the prepared input");
  }
  if (value.reportRoot !== preparation.reportRoot || value.reportSchemaPath !== preparation.reportSchemaPath || value.acknowledgementPath !== preparation.guardAcknowledgementPath) {
    throw new Error("guard config artifact paths do not match the preparation references");
  }
  if (value.expectedReviewInputDigest !== preparation.reviewInputDigest) throw new Error("guard config review input digest does not match the preparation references");
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length !== FIXED_GUARD_TOOLS.length || value.allowedTools.some((entry, index) => entry !== FIXED_GUARD_TOOLS[index])) {
    throw new Error("guard config allowlist does not match the fixed review policy");
  }
  if (typeof value.expectedGuardSourceDigest !== "string" || value.expectedGuardSourceDigest !== await sha256File(preparation.guardExtensionPath, window)) {
    throw new Error("guard config source identity does not match the prepared guard");
  }
  if (typeof value.expectedReportSchemaDigest !== "string" || value.expectedReportSchemaDigest !== await sha256File(preparation.reportSchemaPath, window)) {
    throw new Error("guard config schema identity does not match the prepared schema");
  }
  if (typeof value.reportPath !== "string") throw new Error("guard config does not name a fixed report path");
  const reportPath = await canonicalDestination(value.reportPath, preparation.reportRoot, "fixed reportPath", window);
  if (reportPath === preparation.guardAcknowledgementPath) throw new Error("guard config report and acknowledgement paths must be distinct");
  return value as unknown as ArcReviewGuardConfig;
}

async function validateAttemptPaths(
  preparation: ArcReviewPreparationReferences,
  request: ArcReviewStartRequest,
  trustedExtensions: string[],
  expectedAttemptId?: string,
  window?: BoundedWindow,
): Promise<{ reviewerPaths: string[]; guardConfig: ArcReviewGuardConfig }> {
  const repositoryRoot = await canonicalDirectory(request.repositoryRoot, "repositoryRoot", false, window);
  const stateDir = await canonicalDirectory(preparation.stateDir, "stateDir", true, window);
  const inputParent = await canonicalDirectory(path.join(stateDir, "input"), "stateDir/input", true, window);
  const inputRoot = await canonicalDirectory(preparation.inputRoot, "inputRoot", false, window);
  const sourceRoot = await canonicalDirectory(path.join(inputRoot, "source"), "sourceRoot", false, window);
  const runtimeRoot = await canonicalDirectory(preparation.runtimeRoot, "runtimeRoot", true, window);
  const reportRoot = await canonicalDirectory(preparation.reportRoot, "reportRoot", true, window);
  const evidenceRoot = await canonicalDirectory(path.join(stateDir, "evidence"), "stateDir/evidence", true, window);
  if (runtimeRoot !== path.join(stateDir, "runtime") || reportRoot !== path.join(stateDir, "reports") || !below(inputParent, inputRoot) || inputRoot === inputParent) {
    throw new Error("attempt paths must use the approved stateDir input/runtime/reports sibling layout");
  }
  if (below(repositoryRoot, stateDir) || below(stateDir, repositoryRoot)) throw new Error("stateDir must be disjoint from the checkout");
  for (const [left, right, label] of [[inputRoot, runtimeRoot, "runtimeRoot"], [inputRoot, reportRoot, "reportRoot"], [runtimeRoot, reportRoot, "reportRoot"]] as const) {
    if (below(left, right) || below(right, left)) throw new Error(`${label} must be disjoint from other attempt roots`);
  }
  const manifestPath = await canonicalRegularFile(preparation.manifestPath, "manifestPath", window);
  if (manifestPath !== path.join(inputRoot, "manifest.json")) throw new Error("manifestPath must name the canonical input manifest");
  const materialPaths = await manifestReviewerPaths(inputRoot, manifestPath, window);
  const expectedDiff = path.join(inputRoot, "materials", "diff.patch");
  if (preparation.diffPath !== expectedDiff || !materialPaths.includes(expectedDiff)) throw new Error("diffPath must name the canonical public diff material");
  for (const [name, pathValue] of Object.entries({ baselinePath: preparation.baselinePath, inputDescriptorPath: preparation.inputDescriptorPath })) {
    const file = await canonicalPrivateFile(pathValue, name, window);
    if (path.dirname(file) !== evidenceRoot || below(inputRoot, file) || below(repositoryRoot, file)) throw new Error(`${name} must be private evidence below stateDir/evidence`);
  }
  for (const [name, pathValue] of Object.entries({
    guardExtensionPath: preparation.guardExtensionPath,
    guardConfigPath: preparation.guardConfigPath,
    reportSchemaPath: preparation.reportSchemaPath,
  })) {
    const file = await canonicalPrivateFile(pathValue, name, window);
    if (!below(runtimeRoot, file) || below(inputRoot, file) || below(repositoryRoot, file)) throw new Error(`${name} must be private runtime material`);
  }
  if (preparation.guardExtensionPath !== path.join(runtimeRoot, GUARD_EXTENSION_NAME) || preparation.guardConfigPath !== path.join(runtimeRoot, GUARD_CONFIG_NAME)) {
    throw new Error("guard paths do not identify the materialized review guard");
  }
  await canonicalDestination(preparation.guardAcknowledgementPath, reportRoot, "guardAcknowledgementPath", window);
  const guardConfig = await readBoundGuardConfig(preparation, expectedAttemptId, window);
  const instructionDirectory = path.join(inputRoot, "materials", "instructions");
  if (materialPaths.some((value) => value.startsWith(`${instructionDirectory}${path.sep}`))) {
    await canonicalDirectory(instructionDirectory, "instruction directory", false, window);
  }
  for (let index = 0; index < trustedExtensions.length; index += 1) {
    const extension = await canonicalRegularFile(trustedExtensions[index], `trustedProviderExtensions[${index}]`, window);
    if (below(inputRoot, extension) || below(repositoryRoot, extension)) throw new Error("trusted provider extensions cannot come from review input or checkout");
  }
  return { reviewerPaths: [sourceRoot, manifestPath, ...materialPaths], guardConfig };
}

function dataEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of DATA_ENV_KEYS) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) continue;
    const value: unknown = source[key];
    if (typeof value !== "string" || value.includes("\0") || value.length > 16_384 || Buffer.byteLength(value, "utf8") > 16_384) {
      throw new Error(`invalid environment scalar for ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function vectorBytes(values: readonly string[]): number {
  let bytes = 32;
  for (const value of values) {
    if (typeof value !== "string" || value.length > 192 * 1024 || value.includes("\0")) throw new Error("invalid launch scalar");
    bytes += Buffer.byteLength(value, "utf8") + 1 + 16;
    if (bytes > 192 * 1024) throw new Error("launch vector too large");
  }
  return bytes;
}

async function privateEnvironment(attempt: ArcPreparedReviewAttempt, source: NodeJS.ProcessEnv, command: string, args: readonly string[], window?: BoundedWindow): Promise<NodeJS.ProcessEnv> {
  const result = dataEnvironment(source);
  const destinations = Object.entries(PRIVATE_DIRECTORIES).map(([name, leaf]) => [name, path.join(attempt.runtimeRoot, leaf)] as const);
  if (new Set(destinations.map(([, destination]) => destination)).size !== destinations.length) throw new Error("private environment destinations must be unique");
  for (const [name, destination] of destinations) {
    if (!path.isAbsolute(destination) || destination !== path.resolve(destination) || destination === attempt.runtimeRoot || !below(attempt.runtimeRoot, destination)) {
      throw new Error(`${name} private destination is invalid`);
    }
    result[name] = destination;
  }
  result.TMP = result.TMPDIR;
  result.TEMP = result.TMPDIR;
  result.PI_OFFLINE = "1";
  result.PI_SKIP_VERSION_CHECK = "1";
  result.PI_TELEMETRY = "0";
  const envBytes = vectorBytes(Object.entries(result).map(([key, value]) => `${key}=${value}`));
  if (envBytes > 128 * 1024 || envBytes + vectorBytes([command, ...args]) > 192 * 1024) {
    throw new Error("launch byte limit");
  }
  for (const [name, destination] of destinations) {
    try { await guarded(window, () => mkdir(destination, { recursive: false, mode: 0o700 })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${name} private destination is preexisting`);
      throw error;
    }
    await guarded(window, () => chmod(destination, 0o700));
    const info = await guarded(window, () => lstat(destination));
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid()) || await guarded(window, () => realpath(destination)) !== destination) {
      throw new Error(`${name} private destination is unsafe`);
    }
  }
  return result;
}

function quotedValueEnd(prompt: string, start: number, quote: string): number {
  for (let index = start + 1; index < prompt.length; index += 1) {
    if (prompt[index] === "\\") { index += 1; continue; }
    if (prompt[index] === quote) return index;
  }
  return -1;
}

function isQuotedValueStart(prompt: string, index: number): boolean {
  if (!["'", "\"", "`"].includes(prompt[index])) return false;
  return index === 0 || /[\s([{=:,;]/.test(prompt[index - 1]);
}

function promptPathLiterals(text: string): Set<string> {
  const literals = new Set<string>();
  const unquotedStart = (index: number) => text[index] === "/" && (index === 0 || /[\s([{=:]/.test(text[index - 1]));
  const unquotedEnd = (character: string) => /[\s\])},;:]/.test(character);
  for (let index = 0; index < text.length;) {
    if (isQuotedValueStart(text, index)) {
      const end = quotedValueEnd(text, index, text[index]);
      if (end < 0) throw new Error("prompt contains a dangling quoted value");
      const next = text[end + 1] ?? "";
      const afterNext = text[end + 2] ?? "";
      if (next && !/\s/.test(next) && !(/[\])},;:.]/.test(next) && (!afterNext || /\s/.test(afterNext)))) {
        throw new Error("prompt contains an ambiguous quoted value suffix");
      }
      literals.add(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (["'", "\"", "`"].includes(text[index])) throw new Error("prompt contains an ambiguous quote");
    if (unquotedStart(index)) {
      let end = index + 1;
      while (end < text.length && !unquotedEnd(text[end])) end += 1;
      let token = text.slice(index, end);
      if (token.endsWith(".") && (end === text.length || /\s/.test(text[end]))) token = token.slice(0, -1);
      literals.add(token);
      index = end;
      continue;
    }
    index += 1;
  }
  return literals;
}

function buildArguments(options: ArcStandaloneReviewOptions, attempt: ArcPreparedReviewAttempt, reviewerPaths: string[]): string[] {
  const prompt = options.buildPrompt(attempt);
  if (!prompt || typeof prompt.systemPrompt !== "string" || typeof prompt.task !== "string" || !prompt.systemPrompt.trim() || !prompt.task.trim() ||
      prompt.systemPrompt.includes("\0") || prompt.task.includes("\0")) throw new Error("buildPrompt must return nonempty string systemPrompt and task without NUL");
  for (const [name, value] of [["systemPrompt", prompt.systemPrompt], ["task", prompt.task]] as const) {
    if (value.length > 65_536 || Buffer.byteLength(value, "utf8") > 65_536) throw new Error(`${name} exceeds prompt byte limit`);
  }
  if (Buffer.byteLength(prompt.systemPrompt, "utf8") + Buffer.byteLength(prompt.task, "utf8") + 1 > 131_072) throw new Error("combined prompt exceeds byte limit");
  const literals = promptPathLiterals(`${prompt.systemPrompt}\n${prompt.task}`);
  const fixed = ["diff.patch", "task.md", "design.md", "review.md"].map((name) => path.join(attempt.inputRoot, "materials", name));
  for (const requiredPath of [path.join(attempt.inputRoot, "source"), attempt.manifestPath, ...fixed]) {
    if (!path.isAbsolute(requiredPath) || !literals.has(requiredPath)) throw new Error(`prompt omitted canonical review path ${requiredPath}`);
  }
  const instructionDirectory = path.join(attempt.inputRoot, "materials", "instructions");
  const instructions = reviewerPaths.filter((value) => value.startsWith(`${instructionDirectory}${path.sep}`));
  const indexed = literals.has(attempt.inputRoot) && literals.has(instructionDirectory);
  if (instructions.length && !indexed && !instructions.every((value) => literals.has(value))) throw new Error("prompt omitted canonical review path for instructions");
  return [
    "-p", "--no-session", "--mode", "json",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--no-builtin-tools", "--tools", "read,grep,find,ls,arc_review_report",
    "--extension", attempt.guardExtensionPath,
    ...options.trustedProviderExtensions.flatMap((value) => ["--extension", value]),
    "--model", options.selectedModel,
    "--system-prompt", prompt.systemPrompt,
    "--", prompt.task,
  ];
}

function terminationFromExactProcessResult(identity: ArcReviewLaunchIdentity, result: ArcProcessResult): ArcTerminationEvidence {
  if (!result.spawned && result.termination === "observed") return { status: "not_applicable", source: "not_started", detail: "process non-creation was confirmed by observed close" };
  if (result.spawned && result.termination === "observed") {
    return { status: "observed", source: "standalone_child_close", runnerProcessInstanceId: identity.runnerProcessInstanceId, observedAt: result.endedAt, detail: `exact child close observed (exit=${String(result.exitCode)}, signal=${String(result.signal)})` };
  }
  return { status: "unknown", source: "standalone_child_close", runnerProcessInstanceId: identity.runnerProcessInstanceId, detail: result.spawned ? "exact child close was not observed" : "process creation and close were not observed" };
}

function baseExecution(identity: ArcReviewLaunchIdentity, receipt: ArcReviewDispatchReceipt | undefined, result: ArcProcessResult, termination: ArcTerminationEvidence) {
  return {
    adapter: "standalone" as const,
    attemptId: identity.attemptId,
    identity,
    ...(receipt ? { dispatchReceipt: receipt } : {}),
    ...(result.spawned ? { exitCode: result.exitCode, signal: result.signal } : {}),
    guardAcknowledgements: [] as string[],
    termination,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    artifactReferences: receipt?.artifactReferences ?? [],
  };
}

function failedExecution(identity: ArcReviewLaunchIdentity, receipt: ArcReviewDispatchReceipt | undefined, result: ArcProcessResult, termination: ArcTerminationEvidence, lifecycle: ArcAdapterExecution["lifecycle"], reason: string, diagnostics: string[] = []): ArcAdapterExecution {
  return { ...baseExecution(identity, receipt, result, termination), lifecycle, boundedDiagnostics: [boundedMessage(reason), ...diagnostics].slice(0, MAX_DIAGNOSTIC_LINES) };
}

function decodeJsonLines(bytes: Uint8Array): { diagnostics: string[]; error?: string } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { diagnostics: [], error: "stdout is not strict UTF-8" }; }
  const diagnostics: string[] = [];
  if (text.length === 0) return { diagnostics };
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  let total = 0;
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) return { diagnostics, error: `stdout line ${index + 1} is not JSON` };
    let value: unknown;
    try { value = JSON.parse(line); } catch { return { diagnostics, error: `stdout line ${index + 1} is not JSON` }; }
    let rendered: string;
    try { rendered = canonicalizeArcJson(value); } catch { return { diagnostics, error: `stdout line ${index + 1} is not canonicalizable JSON` }; }
    const bytesInLine = Buffer.byteLength(rendered, "utf8");
    if (diagnostics.length < MAX_DIAGNOSTIC_LINES && total + bytesInLine <= MAX_DIAGNOSTIC_BYTES) {
      diagnostics.push(rendered);
      total += bytesInLine;
    }
  }
  return { diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

async function readAcknowledgement(attempt: ArcPreparedReviewAttempt, window?: BoundedWindow): Promise<ArcReviewGuardAcknowledgement> {
  const bytes = await boundedRead(attempt.guardAcknowledgementPath, 64 * 1024, 0o600, window);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("guard acknowledgement is not strict UTF-8 JSON"); }
  if (!isRecord(value)) throw new Error("guard acknowledgement must be an object");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["attemptId", "guardSourceDigest", "id", "loadedAt", "reportSchemaDigest", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("guard acknowledgement has unexpected fields");
  const guardSourceDigest = await sha256File(attempt.guardExtensionPath, window);
  const reportSchemaDigest = await sha256File(attempt.reportSchemaPath, window);
  if (value.version !== 1 || value.attemptId !== attempt.attemptId || value.id !== ARC_REVIEW_GUARD_ACK_PREFIX + attempt.attemptId || value.guardSourceDigest !== guardSourceDigest || value.reportSchemaDigest !== reportSchemaDigest) {
    throw new Error("guard acknowledgement does not match the attempt and immutable materials");
  }
  if (typeof value.loadedAt !== "string" || !Number.isFinite(Date.parse(value.loadedAt)) || new Date(value.loadedAt).toISOString() !== value.loadedAt) throw new Error("guard acknowledgement loadedAt is invalid");
  return value as unknown as ArcReviewGuardAcknowledgement;
}

async function requireFreshArtifacts(attempt: ArcPreparedReviewAttempt, reportPath: string, window?: BoundedWindow): Promise<void> {
  const candidates = [attempt.guardAcknowledgementPath, reportPath, path.join(attempt.reportRoot, EVIDENCE_NAME)];
  for (const candidate of candidates) {
    try {
      await guarded(window, () => lstat(candidate));
      throw new Error(`fixed review artifact is preexisting and cannot prove freshness: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readReport(reportPath: string, window?: BoundedWindow): Promise<unknown> {
  const reportBytes = await boundedRead(reportPath, MAX_ARTIFACT_BYTES, 0o600, window);
  let report: unknown;
  try { report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)); } catch { throw new Error("fixed review report is not strict UTF-8 JSON"); }
  return report;
}

async function hasGuardEvidence(reportRoot: string, window?: BoundedWindow): Promise<boolean> {
  const evidence = path.join(reportRoot, EVIDENCE_NAME);
  try {
    const info = await guarded(window, () => lstat(evidence));
    if (!info.isFile() || info.isSymbolicLink()) return true;
    return info.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function lifecycleBeforeArtifacts(result: ArcProcessResult): ArcAdapterExecution["lifecycle"] | undefined {
  if (!result.spawned) return "spawn_failed";
  if (result.observationError) return "guard_failed";
  if (result.termination !== "observed") return "provider_lost";
  if (result.timedOut) return "timed_out";
  if (result.aborted) return "cancelled";
  if (result.signal) return "signaled";
  if (result.exitCode !== 0) return "provider_lost";
  if (result.stdoutTruncated || result.stderrTruncated) return "malformed_report";
  return undefined;
}

function timingForAttempt(attempt: ArcPreparedReviewAttempt, entered: number, clock: () => number): { hardEnd: number; workEnd: number } {
  if (!Number.isSafeInteger(attempt.effectiveAttemptBudgetMs) || attempt.effectiveAttemptBudgetMs <= 0 || attempt.effectiveAttemptBudgetMs > MAX_ATTEMPT_TIMEOUT_MS ||
      !Number.isSafeInteger(attempt.executionTimeoutMs) || attempt.executionTimeoutMs <= 0 ||
      attempt.executionTimeoutMs + ARC_REVIEW_STOP_GRACE_MS + ARC_REVIEW_KILL_GRACE_MS > attempt.effectiveAttemptBudgetMs) {
    throw new Error("attempt timing budgets are invalid");
  }
  const parsed = Date.parse(attempt.dispatchDeadlineAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== attempt.dispatchDeadlineAt) throw new Error("attempt dispatch deadline is invalid");
  const hardEnd = Math.min(parsed, entered + attempt.effectiveAttemptBudgetMs);
  const workEnd = Math.min(entered + attempt.executionTimeoutMs, hardEnd - ARC_REVIEW_STOP_GRACE_MS - ARC_REVIEW_KILL_GRACE_MS);
  if (!Number.isFinite(workEnd) || clock() >= workEnd) throw new AttemptInterrupted("timed_out");
  return { hardEnd, workEnd };
}

function interruptedExecution(identity: ArcReviewLaunchIdentity, startedAt: string, kind: InterruptionKind): ArcAdapterExecution {
  return {
    adapter: "standalone",
    attemptId: identity.attemptId,
    identity,
    lifecycle: kind,
    guardAcknowledgements: [],
    termination: { status: "not_applicable", source: "not_started", detail: "dispatch prevented before process invocation" },
    startedAt,
    endedAt: nowIso(),
    boundedDiagnostics: [kind === "cancelled" ? "review attempt cancelled before process invocation" : "review attempt timed out before process invocation"],
    artifactReferences: [],
  };
}

export function createArcStandaloneReviewAdapter(options: ArcStandaloneReviewOptions): ArcReviewAdapter {
  if (!options || typeof options.piCommand !== "string" || options.piCommand.length === 0 || typeof options.selectedModel !== "string" || options.selectedModel.length === 0 || !Array.isArray(options.trustedProviderExtensions)) {
    throw new Error("standalone review options are invalid");
  }
  const ownedProcesses = new Map<string, OwnedProcess>();
  const randomUUID = options.randomUUID ?? nodeRandomUUID;

  return {
    kind: "standalone",
    async preflight(input: ArcReviewPreflightInput) {
      if (process.platform === "win32") return { ok: false, classification: "incompatible", reason: "standalone review is unsupported on win32 without exact process-tree termination" };
      const entered = Date.now();
      const monotonic = performance.now();
      let last = entered;
      const clock = () => last = Math.max(last, Date.now(), entered + performance.now() - monotonic);
      const controller = new AbortController();
      const window = boundedWindow(entered + PREFLIGHT_TIMEOUT_MS, controller.signal, clock);
      try {
        await validateAttemptPaths(input.preparation, input.request, options.trustedProviderExtensions, undefined, window);
        window.check();
        return { ok: true };
      } catch (error) {
        return { ok: false, classification: "incompatible", reason: boundedMessage(error) };
      } finally {
        window.close();
      }
    },
    async execute(attempt: ArcPreparedReviewAttempt, signal: AbortSignal, observer: ArcAdapterObserver): Promise<ArcAdapterExecution> {
      if (process.platform === "win32") throw new Error("standalone review is unsupported on win32");
      if (ownedProcesses.has(attempt.attemptId)) throw new Error(`attempt ${attempt.attemptId} already owns an active process`);
      const entered = Date.now();
      const monotonic = performance.now();
      let last = entered;
      const clock = () => last = Math.max(last, Date.now(), entered + performance.now() - monotonic);
      const startedAt = new Date(entered).toISOString();
      const identity: ArcReviewLaunchIdentity = { adapter: "standalone", attemptId: attempt.attemptId, requestId: randomUUID(), runnerProcessInstanceId: randomUUID() };
      const ownedController = new AbortController();
      const relayAbort = () => ownedController.abort(signal.reason);
      signal.addEventListener("abort", relayAbort, { once: true });
      if (signal.aborted) relayAbort();
      ownedProcesses.set(attempt.attemptId, { identity, controller: ownedController });
      let work: BoundedWindow | undefined;
      let terminal: BoundedWindow | undefined;
      let receipt: ArcReviewDispatchReceipt | undefined;
      let processResult: ArcProcessResult | undefined;
      let processInvoked = false;
      try {
        let timing: { hardEnd: number; workEnd: number };
        try { timing = timingForAttempt(attempt, entered, clock); }
        catch (error) {
          if (error instanceof AttemptInterrupted) return interruptedExecution(identity, startedAt, error.kind);
          throw error;
        }
        work = boundedWindow(timing.workEnd, ownedController.signal, clock);
        terminal = boundedWindow(timing.hardEnd, ownedController.signal, clock);
        try {
          const { reviewerPaths, guardConfig } = await validateAttemptPaths(attempt, attempt.request, options.trustedProviderExtensions, attempt.attemptId, work);
          work.check();
          const args = buildArguments(options, attempt, reviewerPaths);
          work.check();
          await requireFreshArtifacts(attempt, guardConfig.reportPath, work);
          const env = await privateEnvironment(attempt, options.processEnv, options.piCommand, args, work);
          await work.wait(() => observer.persistBeforeDispatch(identity));
          work.check();
          const remaining = Math.floor(timing.workEnd - clock());
          if (remaining <= 0) throw new AttemptInterrupted("timed_out");
          work.check();
          processInvoked = true;
          processResult = await runArcBoundedProcess({
            command: options.piCommand,
            args,
            cwd: attempt.runtimeRoot,
            env,
            timeoutMs: remaining,
            stopGraceMs: ARC_REVIEW_STOP_GRACE_MS,
            killGraceMs: ARC_REVIEW_KILL_GRACE_MS,
            maxOutputBytes: ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES,
            signal: ownedController.signal,
            onSpawn: async ({ pid, spawnedAt }) => {
              const next: ArcReviewDispatchReceipt = { identity, dispatchedAt: spawnedAt, receivedAt: nowIso(), artifactReferences: [attempt.reportRoot] };
              await work!.wait(() => observer.persistDispatchReceipt(next));
              work!.check();
              receipt = next;
              observer.progress(`spawned process ${pid}`);
            },
          });
          const termination = terminationFromExactProcessResult(identity, processResult);
          if (termination.status === "observed") {
            try {
              terminal.check();
              await terminal.wait(() => observer.persistObservedTermination(termination));
              terminal.check();
            } catch (error) {
              return failedExecution(identity, receipt, processResult, termination, "guard_failed", `termination persistence failed or requires reconciliation: ${boundedMessage(error)}`);
            }
          }
          const diagnostics = decodeJsonLines(processResult.stdout);
          const earlyLifecycle = lifecycleBeforeArtifacts(processResult);
          if (earlyLifecycle) return failedExecution(identity, receipt, processResult, termination, earlyLifecycle, processResult.observationError ?? earlyLifecycle, diagnostics.diagnostics);
          if (diagnostics.error) return failedExecution(identity, receipt, processResult, termination, "malformed_report", diagnostics.error, diagnostics.diagnostics);
          try { await readBoundGuardConfig(attempt, attempt.attemptId, terminal); }
          catch (error) { return failedExecution(identity, receipt, processResult, termination, "guard_failed", boundedMessage(error), diagnostics.diagnostics); }
          let acknowledgement: ArcReviewGuardAcknowledgement;
          try { acknowledgement = await readAcknowledgement(attempt, terminal); }
          catch (error) { return failedExecution(identity, receipt, processResult, termination, "guard_failed", boundedMessage(error), diagnostics.diagnostics); }
          if (await hasGuardEvidence(attempt.reportRoot, terminal)) return failedExecution(identity, receipt, processResult, termination, "guard_failed", "guard evidence records blocked or overflowed calls", diagnostics.diagnostics);
          let report: unknown;
          try { report = await readReport(guardConfig.reportPath, terminal); }
          catch (error) { return failedExecution(identity, receipt, processResult, termination, "malformed_report", boundedMessage(error), diagnostics.diagnostics); }
          terminal.check();
          const validated = validateArcReviewerReport(report, attempt.reviewInputDigest);
          if (!validated.ok) return failedExecution(identity, receipt, processResult, termination, "malformed_report", validated.errors.slice(0, 8).join("; "), diagnostics.diagnostics);
          terminal.check();
          return {
            ...baseExecution(identity, receipt, processResult, termination),
            lifecycle: "succeeded",
            structuredReport: validated.value,
            guardAcknowledgements: [acknowledgement.id],
            boundedDiagnostics: diagnostics.diagnostics,
            artifactReferences: [attempt.guardAcknowledgementPath, attempt.reportRoot],
          };
        } catch (error) {
          if (error instanceof AttemptInterrupted && !processInvoked) return interruptedExecution(identity, startedAt, error.kind);
          throw error;
        }
      } finally {
        work?.close();
        terminal?.close();
        signal.removeEventListener("abort", relayAbort);
        if (!processInvoked || processResult?.termination === "observed") {
          const owned = ownedProcesses.get(attempt.attemptId);
          if (owned?.identity.runnerProcessInstanceId === identity.runnerProcessInstanceId) ownedProcesses.delete(attempt.attemptId);
        }
      }
    },
    async stop(attempt: ArcPreparedReviewAttempt, identity: ArcReviewLaunchIdentity | undefined): Promise<void> {
      if (!identity?.runnerProcessInstanceId || identity.attemptId !== attempt.attemptId || identity.adapter !== "standalone") return;
      const owned = ownedProcesses.get(attempt.attemptId);
      if (!owned || owned.identity.runnerProcessInstanceId !== identity.runnerProcessInstanceId || owned.identity.requestId !== identity.requestId) return;
      owned.controller.abort(new Error("standalone review stop requested"));
    },
  };
}
