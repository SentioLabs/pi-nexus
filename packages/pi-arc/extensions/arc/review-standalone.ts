import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
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
  type ArcReviewPreflightInput,
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

const PRIVATE_DIRECTORIES = {
  PI_CODING_AGENT_DIR: "pi-agent",
  PI_CODING_AGENT_SESSION_DIR: "sessions",
  PI_PACKAGE_DIR: "packages",
  PI_SERVER_DIR: "server",
  HOME: "home",
  XDG_CONFIG_HOME: "xdg-config",
  XDG_CACHE_HOME: "xdg-cache",
  XDG_DATA_HOME: "xdg-data",
  TMPDIR: "tmp",
} as const;
const GUARD_EXTENSION_NAME = "review-child.ts";
const GUARD_CONFIG_NAME = "arc-review-guard.json";
const EVIDENCE_NAME = "guard-evidence.jsonl";
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_LINES = 128;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

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

async function canonicalDirectory(value: string, name: string, ownerOnly = false): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute canonical directory`);
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink directory`);
  if (ownerOnly && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))) throw new Error(`${name} must be a private owner-only directory`);
  const canonical = await realpath(value);
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function canonicalRegularFile(value: string, name: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute canonical file`);
  const info = await lstat(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink regular file`);
  const canonical = await realpath(value);
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function canonicalDestination(value: string, root: string, name: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be absolute`);
  const parent = await canonicalDirectory(path.dirname(value), `${name} parent`);
  const canonical = path.join(parent, path.basename(value));
  if (canonical !== value || canonical === root || !below(root, canonical)) throw new Error(`${name} must be a canonical path below its private root`);
  return canonical;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(destination: string, bytes: Uint8Array, mode: number): Promise<void> {
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(destination, flags, mode);
  let completed = false;
  try {
    await handle.chmod(mode);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesWritten === 0) throw new Error(`short write for ${destination}`);
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    await syncDirectory(path.dirname(destination));
    completed = true;
  } finally {
    await handle.close().catch(() => {});
    if (!completed) await rm(destination, { force: true }).catch(() => {});
  }
}

type BigIntFileMetadata = { dev: bigint; ino: bigint; size: bigint; mode: bigint; uid: bigint; gid: bigint; mtimeNs: bigint; ctimeNs: bigint };

function sameFileMetadata(left: BigIntFileMetadata, right: BigIntFileMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function boundedRead(file: string, maxBytes: number, expectedMode?: number): Promise<Uint8Array> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error(`${file} is not a bounded regular file`);
  if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) throw new Error(`${file} has the wrong owner`);
  if (expectedMode !== undefined && (before.mode & 0o777n) !== BigInt(expectedMode)) throw new Error(`${file} has the wrong mode`);
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
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
  } finally { await handle.close(); }
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await boundedRead(file, MAX_ARTIFACT_BYTES)).digest("hex");
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
  const fixed = ["read", "grep", "find", "ls", "structured_output", "arc_review_report"];
  if (!Array.isArray(config.allowedTools) || config.allowedTools.length !== fixed.length || config.allowedTools.some((value, index) => value !== fixed[index])) throw new Error("guard config allowlist is invalid");
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
  const created: string[] = [];
  try {
    await copyFile(sourceModulePath, extensionPath, fsConstants.COPYFILE_EXCL);
    created.push(extensionPath);
    await syncFile(extensionPath);
    const schemaBytes = Buffer.from(canonicalizeArcJson(input.reviewerSchema), "utf8");
    if (schemaBytes.length > MAX_ARTIFACT_BYTES) throw new Error("reviewer schema exceeds materialization limit");
    await writeExclusive(reportSchemaPath, schemaBytes, 0o600);
    created.push(reportSchemaPath);
    const sourceDigest = await sha256File(extensionPath);
    const reportSchemaDigest = await sha256File(reportSchemaPath);
    const completedConfig: ArcReviewGuardConfig = { ...input.config, reportSchemaPath, expectedGuardSourceDigest: sourceDigest, expectedReportSchemaDigest: reportSchemaDigest };
    await writeExclusive(configPath, Buffer.from(canonicalizeArcJson(completedConfig), "utf8"), 0o600);
    created.push(configPath);
    await Promise.all(created.map((file) => chmod(file, 0o400)));
    await syncDirectory(runtimeRoot);
    return { extensionPath, configPath, reportSchemaPath, acknowledgementPath, sourceDigest, reportSchemaDigest };
  } catch (error) {
    await Promise.all(created.map((file) => rm(file, { force: true }).catch(() => {})));
    await syncDirectory(runtimeRoot).catch(() => {});
    throw error;
  }
}

async function canonicalPrivateFile(value: string, name: string): Promise<string> {
  const file = await canonicalRegularFile(value, name);
  const info = await lstat(file);
  if ((info.mode & 0o777) !== 0o400 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${name} must be immutable and owner-only`);
  return file;
}

async function manifestReviewerPaths(inputRoot: string, manifestPath: string): Promise<string[]> {
  const bytes = await boundedRead(manifestPath, ARC_REVIEW_MAX_FILE_BYTES);
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("review input manifest must be strict UTF-8 JSON"); }
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.materials) || manifest.materials.length > ARC_REVIEW_MAX_FILES) throw new Error("review input manifest materials are invalid");
  const materialPaths: string[] = [];
  const seen = new Set<string>();
  for (const [index, row] of manifest.materials.entries()) {
    if (!isRecord(row) || typeof row.path !== "string" || !row.path || row.path.includes("\0") || path.posix.isAbsolute(row.path) || row.path.includes("\\") ||
        row.path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`review input manifest material ${index} has an invalid path`);
    if (seen.has(row.path)) throw new Error("review input manifest has duplicate materials");
    seen.add(row.path);
    if (!["materials/diff.patch", "materials/task.md", "materials/design.md", "materials/review.md"].includes(row.path) && !/^materials\/instructions\/\d{4}\.md$/.test(row.path)) {
      throw new Error(`review input manifest has unsupported reviewer material ${row.path}`);
    }
    const candidate = path.join(inputRoot, ...row.path.split("/"));
    const file = await canonicalRegularFile(candidate, `manifest material ${row.path}`);
    if (!below(inputRoot, file)) throw new Error(`manifest material ${row.path} escapes inputRoot`);
    materialPaths.push(file);
  }
  for (const required of ["materials/diff.patch", "materials/task.md", "materials/design.md", "materials/review.md"]) {
    if (!seen.has(required)) throw new Error(`review input manifest omitted ${required}`);
  }
  return materialPaths;
}

async function validateAttemptPaths(attempt: ArcPreparedReviewAttempt, trustedExtensions: string[]): Promise<string[]> {
  const repositoryRoot = await canonicalDirectory(attempt.request.repositoryRoot, "repositoryRoot");
  const stateDir = await canonicalDirectory(attempt.stateDir, "stateDir", true);
  const inputParent = await canonicalDirectory(path.join(stateDir, "input"), "stateDir/input", true);
  const inputRoot = await canonicalDirectory(attempt.inputRoot, "inputRoot");
  const sourceRoot = await canonicalDirectory(path.join(inputRoot, "source"), "sourceRoot");
  const runtimeRoot = await canonicalDirectory(attempt.runtimeRoot, "runtimeRoot", true);
  const reportRoot = await canonicalDirectory(attempt.reportRoot, "reportRoot", true);
  const evidenceRoot = await canonicalDirectory(path.join(stateDir, "evidence"), "stateDir/evidence", true);
  if (runtimeRoot !== path.join(stateDir, "runtime") || reportRoot !== path.join(stateDir, "reports") || !below(inputParent, inputRoot) || inputRoot === inputParent) {
    throw new Error("attempt paths must use the approved stateDir input/runtime/reports sibling layout");
  }
  if (below(repositoryRoot, stateDir) || below(stateDir, repositoryRoot)) throw new Error("stateDir must be disjoint from the checkout");
  for (const [left, right, label] of [[inputRoot, runtimeRoot, "runtimeRoot"], [inputRoot, reportRoot, "reportRoot"], [runtimeRoot, reportRoot, "reportRoot"]] as const) {
    if (below(left, right) || below(right, left)) throw new Error(`${label} must be disjoint from other attempt roots`);
  }
  const manifestPath = await canonicalRegularFile(attempt.manifestPath, "manifestPath");
  if (manifestPath !== path.join(inputRoot, "manifest.json")) throw new Error("manifestPath must name the canonical input manifest");
  const materialPaths = await manifestReviewerPaths(inputRoot, manifestPath);
  const expectedDiff = path.join(inputRoot, "materials", "diff.patch");
  if (attempt.diffPath !== expectedDiff || !materialPaths.includes(expectedDiff)) throw new Error("diffPath must name the canonical public diff material");
  for (const [name, value] of Object.entries({ baselinePath: attempt.baselinePath, inputDescriptorPath: attempt.inputDescriptorPath })) {
    const file = await canonicalPrivateFile(value, name);
    if (path.dirname(file) !== evidenceRoot || below(inputRoot, file) || below(repositoryRoot, file)) throw new Error(`${name} must be private evidence below stateDir/evidence`);
  }
  for (const [name, value] of Object.entries({
    guardExtensionPath: attempt.guardExtensionPath,
    guardConfigPath: attempt.guardConfigPath,
    reportSchemaPath: attempt.reportSchemaPath,
  })) {
    const file = await canonicalRegularFile(value, name);
    if (!below(runtimeRoot, file) || below(inputRoot, file) || below(repositoryRoot, file)) throw new Error(`${name} must be private runtime material`);
  }
  await canonicalDestination(attempt.guardAcknowledgementPath, reportRoot, "guardAcknowledgementPath");
  for (let index = 0; index < trustedExtensions.length; index += 1) {
    const extension = await canonicalRegularFile(trustedExtensions[index], `trustedProviderExtensions[${index}]`);
    if (below(inputRoot, extension) || below(repositoryRoot, extension)) throw new Error("trusted provider extensions cannot come from review input or checkout");
  }
  return [sourceRoot, manifestPath, ...materialPaths];
}

async function privateEnvironment(attempt: ArcPreparedReviewAttempt, source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = { ...source };
  for (const [name, leaf] of Object.entries(PRIVATE_DIRECTORIES)) {
    const destination = path.join(attempt.runtimeRoot, leaf);
    try { await mkdir(destination, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${name} private destination is preexisting`);
      throw error;
    }
    await chmod(destination, 0o700);
    result[name] = destination;
  }
  result.PI_SKIP_VERSION_CHECK = "1";
  result.PI_TELEMETRY = "0";
  return result;
}

function promptContainsCanonicalPath(prompt: string, requiredPath: string): boolean {
  let offset = 0;
  while (offset <= prompt.length - requiredPath.length) {
    const index = prompt.indexOf(requiredPath, offset);
    if (index < 0) return false;
    const before = index === 0 ? "" : prompt[index - 1];
    const afterIndex = index + requiredPath.length;
    const after = afterIndex === prompt.length ? "" : prompt[afterIndex];
    const componentCharacter = (value: string) => value !== "" && /[A-Za-z0-9_~\/-]/.test(value);
    if (!componentCharacter(before) && !componentCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
}

function buildArguments(options: ArcStandaloneReviewOptions, attempt: ArcPreparedReviewAttempt, reviewerPaths: string[]): string[] {
  const prompt = options.buildPrompt(attempt);
  if (!prompt || typeof prompt.systemPrompt !== "string" || typeof prompt.task !== "string" || !prompt.systemPrompt.trim() || !prompt.task.trim() || prompt.systemPrompt.includes("\0") || prompt.task.includes("\0")) {
    throw new Error("buildPrompt must return nonempty string systemPrompt and task without NUL");
  }
  const promptText = `${prompt.systemPrompt}\n${prompt.task}`;
  for (const requiredPath of reviewerPaths) {
    if (!path.isAbsolute(requiredPath) || !promptContainsCanonicalPath(promptText, requiredPath)) throw new Error(`prompt omitted canonical review path ${requiredPath}`);
  }
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
  let total = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
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

async function readAcknowledgement(attempt: ArcPreparedReviewAttempt): Promise<ArcReviewGuardAcknowledgement> {
  const bytes = await boundedRead(attempt.guardAcknowledgementPath, 64 * 1024, 0o600);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("guard acknowledgement is not strict UTF-8 JSON"); }
  if (!isRecord(value)) throw new Error("guard acknowledgement must be an object");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["attemptId", "guardSourceDigest", "id", "loadedAt", "reportSchemaDigest", "version"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("guard acknowledgement has unexpected fields");
  const guardSourceDigest = await sha256File(attempt.guardExtensionPath);
  const reportSchemaDigest = await sha256File(attempt.reportSchemaPath);
  if (value.version !== 1 || value.attemptId !== attempt.attemptId || value.id !== ARC_REVIEW_GUARD_ACK_PREFIX + attempt.attemptId || value.guardSourceDigest !== guardSourceDigest || value.reportSchemaDigest !== reportSchemaDigest) {
    throw new Error("guard acknowledgement does not match the attempt and immutable materials");
  }
  if (typeof value.loadedAt !== "string" || !Number.isFinite(Date.parse(value.loadedAt)) || new Date(value.loadedAt).toISOString() !== value.loadedAt) throw new Error("guard acknowledgement loadedAt is invalid");
  return value as unknown as ArcReviewGuardAcknowledgement;
}

async function fixedReportPath(attempt: ArcPreparedReviewAttempt): Promise<string> {
  const guardConfigBytes = await boundedRead(attempt.guardConfigPath, 256 * 1024, 0o400);
  let guardConfig: unknown;
  try { guardConfig = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(guardConfigBytes)); } catch { throw new Error("guard config is not strict UTF-8 JSON"); }
  if (!isRecord(guardConfig) || typeof guardConfig.reportPath !== "string") throw new Error("guard config does not name a fixed report path");
  return canonicalDestination(guardConfig.reportPath, attempt.reportRoot, "fixed reportPath");
}

async function requireFreshArtifacts(attempt: ArcPreparedReviewAttempt): Promise<void> {
  const candidates = [attempt.guardAcknowledgementPath, await fixedReportPath(attempt), path.join(attempt.reportRoot, EVIDENCE_NAME)];
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      throw new Error(`fixed review artifact is preexisting and cannot prove freshness: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readReport(attempt: ArcPreparedReviewAttempt): Promise<unknown> {
  const reportPath = await fixedReportPath(attempt);
  const reportBytes = await boundedRead(reportPath, MAX_ARTIFACT_BYTES, 0o600);
  let report: unknown;
  try { report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)); } catch { throw new Error("fixed review report is not strict UTF-8 JSON"); }
  return report;
}

async function hasGuardEvidence(reportRoot: string): Promise<boolean> {
  const evidence = path.join(reportRoot, EVIDENCE_NAME);
  try {
    const info = await lstat(evidence);
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
      try {
        await validateAttemptPaths({ ...input.preparation, request: input.request } as ArcPreparedReviewAttempt, options.trustedProviderExtensions);
        return { ok: true };
      } catch (error) {
        return { ok: false, classification: "incompatible", reason: boundedMessage(error) };
      }
    },
    async execute(attempt: ArcPreparedReviewAttempt, signal: AbortSignal, observer: ArcAdapterObserver): Promise<ArcAdapterExecution> {
      if (process.platform === "win32") throw new Error("standalone review is unsupported on win32");
      if (ownedProcesses.has(attempt.attemptId)) throw new Error(`attempt ${attempt.attemptId} already owns an active process`);
      const reviewerPaths = await validateAttemptPaths(attempt, options.trustedProviderExtensions);
      const args = buildArguments(options, attempt, reviewerPaths);
      await requireFreshArtifacts(attempt);
      const env = await privateEnvironment(attempt, options.processEnv);
      const identity: ArcReviewLaunchIdentity = { adapter: "standalone", attemptId: attempt.attemptId, requestId: randomUUID(), runnerProcessInstanceId: randomUUID() };
      await observer.persistBeforeDispatch(identity);
      const ownedController = new AbortController();
      const relayAbort = () => ownedController.abort(signal.reason);
      signal.addEventListener("abort", relayAbort, { once: true });
      if (signal.aborted) relayAbort();
      ownedProcesses.set(attempt.attemptId, { identity, controller: ownedController });
      let receipt: ArcReviewDispatchReceipt | undefined;
      let processResult: ArcProcessResult | undefined;
      try {
        processResult = await runArcBoundedProcess({
          command: options.piCommand,
          args,
          cwd: attempt.runtimeRoot,
          env,
          timeoutMs: attempt.executionTimeoutMs,
          stopGraceMs: ARC_REVIEW_STOP_GRACE_MS,
          killGraceMs: ARC_REVIEW_KILL_GRACE_MS,
          maxOutputBytes: ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES,
          signal: ownedController.signal,
          onSpawn: async ({ pid, spawnedAt }) => {
            const next: ArcReviewDispatchReceipt = { identity, dispatchedAt: spawnedAt, receivedAt: nowIso(), artifactReferences: [attempt.reportRoot] };
            await observer.persistDispatchReceipt(next);
            receipt = next;
            observer.progress(`spawned process ${pid}`);
          },
        });
        const termination = terminationFromExactProcessResult(identity, processResult);
        if (termination.status === "observed") {
          try { await observer.persistObservedTermination(termination); }
          catch (error) { return failedExecution(identity, receipt, processResult, termination, "guard_failed", `termination persistence failed: ${boundedMessage(error)}`); }
        }
        const diagnostics = decodeJsonLines(processResult.stdout);
        const earlyLifecycle = lifecycleBeforeArtifacts(processResult);
        if (earlyLifecycle) return failedExecution(identity, receipt, processResult, termination, earlyLifecycle, processResult.observationError ?? earlyLifecycle, diagnostics.diagnostics);
        if (diagnostics.error) return failedExecution(identity, receipt, processResult, termination, "malformed_report", diagnostics.error, diagnostics.diagnostics);
        let acknowledgement: ArcReviewGuardAcknowledgement;
        try { acknowledgement = await readAcknowledgement(attempt); }
        catch (error) { return failedExecution(identity, receipt, processResult, termination, "guard_failed", boundedMessage(error), diagnostics.diagnostics); }
        if (await hasGuardEvidence(attempt.reportRoot)) return failedExecution(identity, receipt, processResult, termination, "guard_failed", "guard evidence records blocked or overflowed calls", diagnostics.diagnostics);
        let report: unknown;
        try { report = await readReport(attempt); }
        catch (error) { return failedExecution(identity, receipt, processResult, termination, "malformed_report", boundedMessage(error), diagnostics.diagnostics); }
        const validated = validateArcReviewerReport(report, attempt.reviewInputDigest);
        if (!validated.ok) return failedExecution(identity, receipt, processResult, termination, "malformed_report", validated.errors.slice(0, 8).join("; "), diagnostics.diagnostics);
        return {
          ...baseExecution(identity, receipt, processResult, termination),
          lifecycle: "succeeded",
          structuredReport: validated.value,
          guardAcknowledgements: [acknowledgement.id],
          boundedDiagnostics: diagnostics.diagnostics,
          artifactReferences: [attempt.guardAcknowledgementPath, attempt.reportRoot],
        };
      } finally {
        signal.removeEventListener("abort", relayAbort);
        if (processResult?.termination === "observed") {
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
