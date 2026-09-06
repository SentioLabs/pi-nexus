import { randomUUID as nodeRandomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARC_REVIEWER_REPORT_JSON_SCHEMA,
  ARC_REVIEW_GUARD_ACK_PREFIX,
  ARC_REVIEW_MAX_EVENT_BUFFER,
  ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES,
  ARC_REVIEW_STOP_GRACE_MS,
  ARC_RUNTIME_REGISTER_EVENT,
  canonicalizeArcJson,
  validateArcReviewerReport,
  type ArcAdapterExecution,
  type ArcAdapterObserver,
  type ArcPreparedReviewAttempt,
  type ArcReviewAdapter,
  type ArcReviewDispatchReceipt,
  type ArcReviewLaunchIdentity,
  type ArcReviewPreflightInput,
  type ArcReviewPreparationReferences,
  type ArcSubagentsPing,
  type ArcTerminationEvidence,
} from "./reports.ts";
import { createArcSubagentsRpcClient } from "./subagents-rpc.ts";

interface ArcNativeReviewOptions {
  events: { on(name: string, handler: (value: unknown) => void): () => void; emit(name: string, value: unknown): void };
  trustedProviderExtensions: string[];
  buildPrompt: (attempt: ArcPreparedReviewAttempt) => { systemPrompt: string; task: string };
  resolvedModel?: string;
  now?: () => Date;
  randomUUID?: () => string;
}

interface ArcNativeAvailabilityProbe {
  firstReadyObserved: boolean;
  firstPing: ArcSubagentsPing;
  secondReadyObserved: boolean;
  secondPing: ArcSubagentsPing;
}

interface RegistrationHandle { dispose(): void }

interface ArcNativeSpawnData {
  text: string;
  isError?: boolean;
  details: {
    mode: "single";
    runId: string;
    asyncId: string;
    asyncDir: string;
    results: unknown[];
    launchContractDigest?: string;
    launchResolvedExtensions?: unknown;
  };
}

interface ArcNativeObservedTerminal {
  version: 1;
  runId: string;
  runnerProcessInstanceId: string;
  state: "observed";
  observedAt: number;
  childIndex?: number;
  instances: Array<{
    kind: "runner" | "pi-writer";
    processInstanceId: string;
    closeObservedAt: number;
    exitCode: number | null;
    signal: string | null;
  }>;
}

interface BoundSpawn {
  receipt: ArcReviewDispatchReceipt;
  data: ArcNativeSpawnData;
}

interface ValidatedCompletion {
  lifecycle: ArcAdapterExecution["lifecycle"];
  report?: unknown;
  guardAcknowledgements: string[];
  diagnostics: string[];
  artifactReferences: string[];
}

interface ExactSettlement {
  proof?: ArcNativeObservedTerminal;
  completion?: ValidatedCompletion;
  error?: Error;
}

const DEFAULT_READY_EVENT = "subagents:rpc:v1:ready";
const MAX_DIAGNOSTICS = 128;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PARENT_EXTENSION_DIRECTORY = path.dirname(MODULE_DIRECTORY);
const MAX_RETURNED_ARTIFACTS = 128;
const MAX_PATH_BYTES = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function below(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 4096) return message;
  let end = 4096;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
  return value.toISOString();
}

async function canonicalDirectory(value: string, name: string, readOnly = false): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value) || /[\0\r\n]/.test(value)) throw new Error(`${name} must be an absolute canonical directory`);
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink directory`);
  if (readOnly && (info.mode & 0o222) !== 0) throw new Error(`${name} must be read-only`);
  const canonical = await realpath(value);
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function canonicalRegularFile(value: string, name: string, readOnly = false): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value) || /[\0\r\n]/.test(value)) throw new Error(`${name} must be an absolute canonical file`);
  const info = await lstat(value);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a non-symlink regular file`);
  if (readOnly && (info.mode & 0o222) !== 0) throw new Error(`${name} must be read-only`);
  const canonical = await realpath(value);
  if (canonical !== value) throw new Error(`${name} must be canonical`);
  return canonical;
}

async function validatePreparationPaths(input: ArcReviewPreflightInput, trustedExtensions: string[]): Promise<void> {
  const preparation = input.preparation;
  const repositoryRoot = await canonicalDirectory(input.request.repositoryRoot, "repositoryRoot");
  const stateDir = await canonicalDirectory(preparation.stateDir, "stateDir");
  const inputRoot = await canonicalDirectory(preparation.inputRoot, "inputRoot", true);
  await canonicalDirectory(path.join(inputRoot, "source"), "sourceRoot", true);
  const runtimeRoot = await canonicalDirectory(preparation.runtimeRoot, "runtimeRoot");
  const reportRoot = await canonicalDirectory(preparation.reportRoot, "reportRoot");
  if (below(repositoryRoot, stateDir) || below(stateDir, repositoryRoot)) throw new Error("stateDir must be disjoint from the checkout");
  if (!below(path.join(stateDir, "input"), inputRoot) || runtimeRoot !== path.join(stateDir, "runtime") || reportRoot !== path.join(stateDir, "reports")) {
    throw new Error("attempt roots must use the canonical state input/runtime/reports layout");
  }
  for (const [left, right] of [[inputRoot, runtimeRoot], [inputRoot, reportRoot], [runtimeRoot, reportRoot]] as const) {
    if (below(left, right) || below(right, left)) throw new Error("attempt input, runtime, and report roots must be disjoint");
  }
  const files = {
    manifestPath: preparation.manifestPath,
    diffPath: preparation.diffPath,
    guardExtensionPath: preparation.guardExtensionPath,
    guardConfigPath: preparation.guardConfigPath,
    reportSchemaPath: preparation.reportSchemaPath,
    baselinePath: preparation.baselinePath,
    inputDescriptorPath: preparation.inputDescriptorPath,
  };
  const canonicalFiles = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, value]) => [name, await canonicalRegularFile(value, name, true)])));
  if (!below(inputRoot, canonicalFiles.manifestPath) || !below(inputRoot, canonicalFiles.diffPath)) throw new Error("review manifest and diff must be below inputRoot");
  for (const name of ["guardExtensionPath", "guardConfigPath", "reportSchemaPath"] as const) {
    if (!below(runtimeRoot, canonicalFiles[name])) throw new Error(`${name} must be below runtimeRoot`);
  }
  for (const name of ["baselinePath", "inputDescriptorPath"] as const) {
    if (!below(stateDir, canonicalFiles[name]) || below(inputRoot, canonicalFiles[name]) || below(repositoryRoot, canonicalFiles[name])) throw new Error(`${name} must be private evidence outside review inputs and checkout`);
  }
  const acknowledgement = preparation.guardAcknowledgementPath;
  if (!path.isAbsolute(acknowledgement) || acknowledgement !== path.resolve(acknowledgement) || /[\0\r\n]/.test(acknowledgement) || !below(reportRoot, acknowledgement) || acknowledgement === reportRoot) {
    throw new Error("guardAcknowledgementPath must be a canonical destination below reportRoot");
  }
  if (!Array.isArray(trustedExtensions)) throw new Error("trustedProviderExtensions must be an array");
  const seen = new Set<string>();
  for (let index = 0; index < trustedExtensions.length; index += 1) {
    const extension = await canonicalRegularFile(trustedExtensions[index], `trustedProviderExtensions[${index}]`, true);
    if (seen.has(extension)) throw new Error("trusted provider extension paths must be unique");
    seen.add(extension);
    if (below(repositoryRoot, extension) || below(inputRoot, extension) || below(runtimeRoot, extension) || below(PARENT_EXTENSION_DIRECTORY, extension)) {
      throw new Error("trusted provider extensions cannot come from the checkout, attempt input/runtime, or parent extension");
    }
  }
}

function preparationProjection(preparation: ArcReviewPreparationReferences): ArcReviewPreparationReferences {
  return {
    stateDir: preparation.stateDir,
    inputRoot: preparation.inputRoot,
    runtimeRoot: preparation.runtimeRoot,
    reportRoot: preparation.reportRoot,
    manifestPath: preparation.manifestPath,
    diffPath: preparation.diffPath,
    guardExtensionPath: preparation.guardExtensionPath,
    guardConfigPath: preparation.guardConfigPath,
    reportSchemaPath: preparation.reportSchemaPath,
    guardAcknowledgementPath: preparation.guardAcknowledgementPath,
    reviewInputDigest: preparation.reviewInputDigest,
    baselineDigest: preparation.baselineDigest,
    baselinePath: preparation.baselinePath,
    baselineArtifactDigest: preparation.baselineArtifactDigest,
    inputDescriptorPath: preparation.inputDescriptorPath,
    inputDescriptorArtifactDigest: preparation.inputDescriptorArtifactDigest,
  };
}

function preparationFingerprint(input: ArcReviewPreflightInput): string {
  return canonicalizeArcJson({ request: input.request, preparation: preparationProjection(input.preparation) });
}

function requiredCapabilityFailure(ping: ArcSubagentsPing): string | undefined {
  for (const method of ["spawn", "status", "stop"]) if (!ping.methods.includes(method)) return `required ${method} method is unavailable`;
  if (ping.capabilities.asyncSpawn !== true) return "required asyncSpawn capability is unavailable";
  if (!ping.events.asyncComplete || !ping.events.processTerminal) return "required top-level completion/process-terminal events are unavailable";
  if (ping.capabilities.processTerminalProof?.version !== 1) return "required process-terminal proof capability is unavailable";
  const acknowledgement = ping.capabilities.runtimeAcknowledgedExtensions;
  if (acknowledgement?.version !== 1 || acknowledgement.source !== "child-runtime" || acknowledgement.event !== "subagent:acknowledge-extension") {
    return "required child runtime extension acknowledgement capability is unavailable";
  }
  return undefined;
}

function matchingPingFacts(first: ArcSubagentsPing, second: ArcSubagentsPing): boolean {
  return canonicalizeArcJson(first) === canonicalizeArcJson(second);
}

function ownerSessionId(probe: ArcNativeAvailabilityProbe): string {
  const first = probe.firstPing.session?.sessionId;
  const second = probe.secondPing.session?.sessionId;
  if (!first || !second || first !== second) throw new Error("two matching pings did not bind a stable owner session identity");
  return first;
}

function validatePrompt(attempt: ArcPreparedReviewAttempt, buildPrompt: ArcNativeReviewOptions["buildPrompt"]): { systemPrompt: string; task: string } {
  const prompt = buildPrompt(attempt);
  if (!prompt || typeof prompt.systemPrompt !== "string" || typeof prompt.task !== "string" || !prompt.systemPrompt.trim() || !prompt.task.trim() || /\0/.test(prompt.systemPrompt + prompt.task)) {
    throw new Error("buildPrompt must return nonempty systemPrompt and task strings without NUL");
  }
  if (Buffer.byteLength(prompt.systemPrompt, "utf8") > MAX_PROMPT_BYTES || Buffer.byteLength(prompt.task, "utf8") > MAX_PROMPT_BYTES) throw new Error("review prompt exceeds the byte limit");
  const requiredSystemPrompt = "You are a fresh read-only Arc reviewer. Use only supplied absolute paths and return the required structured report.";
  if (prompt.systemPrompt !== requiredSystemPrompt) throw new Error("review system prompt does not match the fixed read-only contract");
  const requiredLines = [
    `Review committed ${attempt.request.baseSha}..${attempt.request.headSha}.`,
    `Source root (absolute; pass unchanged to tools): ${path.join(attempt.inputRoot, "source")}`,
    `Materials manifest: ${attempt.manifestPath}`,
    "Dirty and ignored primary bytes are intentionally excluded.",
    `Return schema version 1 with reviewInputDigest ${attempt.reviewInputDigest}.`,
    "Relative paths are invalid.",
  ];
  const lines = prompt.task.split("\n");
  if (requiredLines.some((line) => !lines.includes(line))) throw new Error("review task does not contain every required committed-range, canonical-path, exclusion, digest, and relative-path line");
  return { systemPrompt: prompt.systemPrompt, task: prompt.task };
}

function validateAttemptIdentity(attempt: ArcPreparedReviewAttempt): void {
  if (typeof attempt.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attempt.attemptId)) throw new Error("attemptId cannot form a private runtime agent name");
  if (attempt.request.role !== "spec" && attempt.request.role !== "code") throw new Error("review role must be spec or code");
  if (!Number.isSafeInteger(attempt.executionTimeoutMs) || attempt.executionTimeoutMs <= 0) throw new Error("executionTimeoutMs must be a positive integer");
  if (!Number.isSafeInteger(attempt.effectiveAttemptBudgetMs) || attempt.effectiveAttemptBudgetMs <= 0) throw new Error("effectiveAttemptBudgetMs must be a positive integer");
  const deadline = Date.parse(attempt.dispatchDeadlineAt);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== attempt.dispatchDeadlineAt) throw new Error("dispatchDeadlineAt must be an ISO timestamp");
}

function terminationUnknown(identity: ArcReviewLaunchIdentity, detail: string): ArcTerminationEvidence {
  return {
    status: identity.runId ? "unknown" : "not_applicable",
    source: identity.runId ? "provider_process_terminal" : "not_started",
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.runnerProcessInstanceId ? { runnerProcessInstanceId: identity.runnerProcessInstanceId } : {}),
    detail,
  };
}

function failedExecution(input: {
  attempt: ArcPreparedReviewAttempt;
  identity: ArcReviewLaunchIdentity;
  receipt?: ArcReviewDispatchReceipt;
  lifecycle: ArcAdapterExecution["lifecycle"];
  startedAt: string;
  endedAt: string;
  reason: unknown;
  termination?: ArcTerminationEvidence;
  artifactReferences?: string[];
}): ArcAdapterExecution {
  return {
    adapter: "native",
    attemptId: input.attempt.attemptId,
    identity: input.identity,
    ...(input.receipt ? { dispatchReceipt: input.receipt } : {}),
    lifecycle: input.lifecycle,
    guardAcknowledgements: [],
    termination: input.termination ?? terminationUnknown(input.identity, "exact provider process termination was not observed"),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    boundedDiagnostics: [boundedMessage(input.reason)].slice(0, MAX_DIAGNOSTICS),
    artifactReferences: input.artifactReferences ?? input.receipt?.artifactReferences ?? [],
  };
}

function registerPrivateAgent(options: ArcNativeReviewOptions, attempt: ArcPreparedReviewAttempt, identity: ArcReviewLaunchIdentity, prompt: { systemPrompt: string; task: string }): RegistrationHandle {
  const registrationRequest: Record<string, unknown> = {
    version: 1,
    name: identity.privateAgentName,
    definition: {
      description: `Private guarded Arc ${attempt.request.role} reviewer for ${attempt.attemptId}`,
      systemPrompt: prompt.systemPrompt,
      ...(options.resolvedModel ? { model: options.resolvedModel } : {}),
      tools: ["read", "grep", "find", "ls"],
      systemPromptMode: "replace",
      inheritProjectContext: false,
      inheritGlobalContext: false,
      inheritSkills: false,
      defaultContext: "fresh",
      allowNestedSubagents: false,
      maxSubagentDepth: 0,
      extensions: [],
      subagentOnlyExtensions: [attempt.guardExtensionPath, ...options.trustedProviderExtensions],
      defaultTimeoutMs: attempt.executionTimeoutMs,
      completionGuard: false,
    },
  };
  options.events.emit(ARC_RUNTIME_REGISTER_EVENT, registrationRequest);
  const result = registrationRequest.result;
  if (result === undefined) throw new Error("native provider was ready during preflight but did not return a runtime registration result");
  if (!isRecord(result)) throw new Error("native provider returned a malformed runtime registration result");
  if (result.ok === false) {
    const error = result.error;
    throw new Error(`native runtime registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.ok !== true || !isRecord(result.registration) || typeof result.registration.dispose !== "function") throw new Error("native provider returned a malformed runtime registration handle");
  return result.registration as unknown as RegistrationHandle;
}

class ReturnedArtifactSet {
  readonly #references = new Set<string>();
  #observations = 0;

  constructor(initial: readonly string[] = []) {
    for (const value of initial) this.add(value);
  }

  add(value: string): void {
    if (this.#observations >= MAX_RETURNED_ARTIFACTS) throw new Error(`provider returned more than ${MAX_RETURNED_ARTIFACTS} aggregate artifact references`);
    this.#observations += 1;
    this.#references.add(value);
  }

  values(): string[] {
    return [...this.#references];
  }
}

function validateReturnedPathLexical(value: unknown, name: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || !path.isAbsolute(value) || value !== path.resolve(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be an absolute canonical path within the byte limit`);
  }
  return value;
}

async function canonicalReturnedDirectory(value: unknown, name: string, attempt: ArcPreparedReviewAttempt): Promise<string> {
  const lexical = validateReturnedPathLexical(value, name);
  const candidate = await canonicalDirectory(lexical, name);
  if (below(attempt.inputRoot, candidate) || below(attempt.request.repositoryRoot, candidate)) throw new Error(`${name} cannot be inside review input or checkout`);
  return candidate;
}

async function canonicalReturnedPath(value: unknown, attempt: ArcPreparedReviewAttempt): Promise<string> {
  const candidate = validateReturnedPathLexical(value, "provider returned session/artifact/output path");
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("provider returned path must be a non-symlink regular file or directory");
  const canonical = await realpath(candidate);
  if (canonical !== candidate) throw new Error("provider returned a non-canonical symlink or filesystem alias path");
  if (below(attempt.inputRoot, canonical) || below(attempt.request.repositoryRoot, canonical)) throw new Error("provider returned a session/artifact/output path inside review input or checkout");
  return canonical;
}

function* collectReturnedPaths(value: Record<string, unknown>, includeAsyncDir = true): Generator<unknown> {
  for (const key of ["asyncDir", "artifactsDir", "sessionFile", "sessionPath", "outputFile", "outputPath", "artifactPath", "reportPath", "transcriptPath", "structuredOutputPath", "structuredOutputSchemaPath"]) {
    if ((!includeAsyncDir && key === "asyncDir") || !Object.hasOwn(value, key)) continue;
    yield value[key];
  }
  if (isRecord(value.artifactPaths)) {
    for (const key of Object.keys(value.artifactPaths)) yield value.artifactPaths[key];
  }
}

async function addReturnedPaths(
  records: readonly Record<string, unknown>[],
  attempt: ArcPreparedReviewAttempt,
  artifacts: ReturnedArtifactSet,
  includeAsyncDir = true,
): Promise<void> {
  for (const record of records) {
    for (const candidate of collectReturnedPaths(record, includeAsyncDir)) artifacts.add(await canonicalReturnedPath(candidate, attempt));
  }
}

async function validateSpawnReceipt(
  attempt: ArcPreparedReviewAttempt,
  identity: ArcReviewLaunchIdentity,
  value: unknown,
  dispatchedAt: string,
  receivedAt: string,
): Promise<BoundSpawn> {
  if (!isRecord(value) || typeof value.text !== "string" || (value.isError !== undefined && typeof value.isError !== "boolean") || value.isError === true || !isRecord(value.details)) {
    throw new Error("native spawn returned a malformed or error receipt");
  }
  const details = value.details;
  if (details.mode !== "single" || typeof details.runId !== "string" || !details.runId || details.runId.length > 256 || /[\0\r\n]/.test(details.runId) || details.runId !== details.asyncId || !Array.isArray(details.results)) {
    throw new Error("native spawn receipt has an invalid exact run identity or mode");
  }
  identity.runId = details.runId;
  const asyncDir = await canonicalReturnedDirectory(details.asyncDir, "spawn asyncDir", attempt);
  identity.asyncDir = asyncDir;
  const artifacts = new ReturnedArtifactSet();
  artifacts.add(asyncDir);
  await addReturnedPaths([value, details], attempt, artifacts, false);
  await addReturnedPaths(details.results.filter(isRecord), attempt, artifacts);
  const boundIdentity: ArcReviewLaunchIdentity = { ...identity };
  const receipt: ArcReviewDispatchReceipt = { identity: boundIdentity, dispatchedAt, receivedAt, artifactReferences: artifacts.values() };
  return { receipt, data: value as unknown as ArcNativeSpawnData };
}

function finiteTimestamp(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw new Error(`${at} must be a finite timestamp`);
  return value;
}

function parseExactTerminal(value: unknown, runId: string): ArcNativeObservedTerminal | undefined {
  if (!isRecord(value) || value.runId !== runId) return undefined;
  if (Object.hasOwn(value, "childIndex")) throw new Error("child-scoped process proof cannot prove the single review root");
  if (value.version !== 1 || value.state !== "observed" || typeof value.runnerProcessInstanceId !== "string" || !value.runnerProcessInstanceId || !Array.isArray(value.instances) || value.instances.length === 0) {
    throw new Error("exact-run process-terminal proof is malformed or unknown");
  }
  const observedAt = finiteTimestamp(value.observedAt, "process-terminal observedAt");
  const instances: ArcNativeObservedTerminal["instances"] = value.instances.map((entry, index) => {
    if (!isRecord(entry) || (entry.kind !== "runner" && entry.kind !== "pi-writer") || typeof entry.processInstanceId !== "string" || !entry.processInstanceId ||
      (entry.exitCode !== null && !Number.isSafeInteger(entry.exitCode)) || (entry.signal !== null && typeof entry.signal !== "string")) {
      throw new Error(`process-terminal instances[${index}] is malformed`);
    }
    return {
      kind: entry.kind,
      processInstanceId: entry.processInstanceId,
      closeObservedAt: finiteTimestamp(entry.closeObservedAt, `process-terminal instances[${index}].closeObservedAt`),
      exitCode: entry.exitCode as number | null,
      signal: entry.signal as string | null,
    };
  });
  if (new Set(instances.map((entry) => entry.processInstanceId)).size !== instances.length) throw new Error("process-terminal instance identities must be unique");
  const runners = instances.filter((entry) => entry.kind === "runner");
  if (runners.length !== 1 || runners[0].processInstanceId !== value.runnerProcessInstanceId) throw new Error("process-terminal runner instance does not match its reported runner identity");
  return { version: 1, runId, runnerProcessInstanceId: value.runnerProcessInstanceId, state: "observed", observedAt, instances };
}

function normalizeObservedProof(proof: ArcNativeObservedTerminal): ArcTerminationEvidence {
  return {
    status: "observed",
    source: "provider_process_terminal",
    runId: proof.runId,
    runnerProcessInstanceId: proof.runnerProcessInstanceId,
    observedAt: new Date(proof.observedAt).toISOString(),
    detail: `exact root runner close observed (exit=${String(proof.instances.find((entry) => entry.kind === "runner")!.exitCode)}, signal=${String(proof.instances.find((entry) => entry.kind === "runner")!.signal)})`,
  };
}

async function parseCompletion(
  value: unknown,
  attempt: ArcPreparedReviewAttempt,
  identity: ArcReviewLaunchIdentity,
  existingArtifactReferences: readonly string[],
): Promise<ValidatedCompletion | undefined> {
  if (!isRecord(value) || value.runId !== identity.runId || value.toolCallId !== `rpc-spawn-${identity.requestId}`) return undefined;
  for (const key of ["sessionId", "ownerSessionId", "parentSessionId"]) {
    if (Object.hasOwn(value, key) && value[key] !== identity.ownerSessionId) {
      return { lifecycle: "provider_lost", guardAcknowledgements: [], diagnostics: [`completion ${key} does not match the bound owner session`], artifactReferences: [] };
    }
  }
  const existingArtifacts = new Set(existingArtifactReferences);
  const artifacts = new ReturnedArtifactSet(existingArtifactReferences);
  try {
    await addReturnedPaths([value], attempt, artifacts);
  } catch (error) {
    return { lifecycle: "guard_failed", guardAcknowledgements: [], diagnostics: [boundedMessage(error)], artifactReferences: [] };
  }
  let artifactReferences = artifacts.values().filter((reference) => !existingArtifacts.has(reference));
  if (value.mode !== "single" || value.state !== "complete" || value.success !== true || value.stopped === true || value.timedOut === true || value.interrupted === true || value.processSignal) {
    return { lifecycle: "provider_lost", guardAcknowledgements: [], diagnostics: ["native completion was not a successful single terminal result"], artifactReferences };
  }
  if (!Array.isArray(value.results) || value.results.length !== 1 || !isRecord(value.results[0])) {
    return { lifecycle: "malformed_report", guardAcknowledgements: [], diagnostics: ["native completion has no exact single result"], artifactReferences };
  }
  const result = value.results[0];
  try {
    await addReturnedPaths([result], attempt, artifacts);
    artifactReferences = artifacts.values().filter((reference) => !existingArtifacts.has(reference));
  } catch (error) {
    return { lifecycle: "guard_failed", guardAcknowledgements: [], diagnostics: [boundedMessage(error)], artifactReferences: [] };
  }
  if (result.success !== true || result.stopped === true || result.timedOut === true || result.interrupted === true || result.processSignal || !Object.hasOwn(result, "structuredOutput")) {
    return { lifecycle: "malformed_report", guardAcknowledgements: [], diagnostics: ["native child result did not contain successful structured output"], artifactReferences };
  }
  const validation = validateArcReviewerReport(result.structuredOutput, attempt.reviewInputDigest);
  if (validation.ok === false) return { lifecycle: "malformed_report", guardAcknowledgements: [], diagnostics: validation.errors.slice(0, MAX_DIAGNOSTICS), artifactReferences };
  const acknowledgement = value.runtimeAcknowledgedExtensions ?? result.runtimeAcknowledgedExtensions;
  const expected = ARC_REVIEW_GUARD_ACK_PREFIX + attempt.attemptId;
  if (!isRecord(acknowledgement) || acknowledgement.version !== 1 || acknowledgement.source !== "child-runtime" || !Array.isArray(acknowledgement.ids) ||
    acknowledgement.ids.some((id) => typeof id !== "string" || !id) || !acknowledgement.ids.includes(expected) ||
    !Number.isSafeInteger(acknowledgement.omitted) || (acknowledgement.omitted as number) < 0) {
    return { lifecycle: "guard_failed", guardAcknowledgements: [], diagnostics: ["native completion omitted the exact review guard acknowledgement"], artifactReferences };
  }
  return { lifecycle: "succeeded", report: validation.value, guardAcknowledgements: [expected], diagnostics: [], artifactReferences };
}

class BoundedEventBuffer {
  readonly #events: Array<{ kind: "completion" | "terminal"; value: unknown }> = [];
  readonly #digests = new Set<string>();
  #overflow = false;
  #wake: (() => void) | undefined;

  add(kind: "completion" | "terminal", value: unknown): void {
    if (this.#overflow) return;
    let digest: string;
    try {
      digest = `${kind}:${canonicalizeArcJson(value)}`;
    } catch {
      this.#overflow = true;
      this.#notify();
      return;
    }
    if (Buffer.byteLength(digest, "utf8") > ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES) {
      this.#overflow = true;
      this.#notify();
      return;
    }
    if (this.#digests.has(digest)) return;
    if (this.#events.length >= ARC_REVIEW_MAX_EVENT_BUFFER) {
      this.#overflow = true;
      this.#notify();
      return;
    }
    this.#digests.add(digest);
    this.#events.push({ kind, value });
    this.#notify();
  }

  #notify(): void {
    this.#wake?.();
    this.#wake = undefined;
  }

  snapshot(): { events: Array<{ kind: "completion" | "terminal"; value: unknown }>; overflow: boolean } {
    return { events: [...this.#events], overflow: this.#overflow };
  }

  wait(signal: AbortSignal, deadline: number): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("review attempt aborted"));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error("review attempt timed out waiting for native completion and process proof"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.#wake === onWake) this.#wake = undefined;
        error ? reject(error) : resolve();
      };
      const onWake = () => finish();
      const onAbort = () => finish(new Error("review attempt aborted"));
      const timer = setTimeout(() => finish(new Error("review attempt timed out waiting for native completion and process proof")), remaining);
      this.#wake = onWake;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function awaitExactRootProof(input: {
  buffer: BoundedEventBuffer;
  runId: string;
  signal: AbortSignal;
  deadline: number;
}): Promise<ArcNativeObservedTerminal | undefined> {
  let processed = 0;
  let proof: ArcNativeObservedTerminal | undefined;
  for (;;) {
    const snapshot = input.buffer.snapshot();
    if (snapshot.overflow) return undefined;
    while (processed < snapshot.events.length) {
      const event = snapshot.events[processed++];
      if (event.kind !== "terminal") continue;
      let candidate: ArcNativeObservedTerminal | undefined;
      try { candidate = parseExactTerminal(event.value, input.runId); }
      catch { return undefined; }
      if (!candidate) continue;
      if (proof && canonicalizeArcJson(proof) !== canonicalizeArcJson(candidate)) return undefined;
      proof = candidate;
    }
    if (proof) return proof;
    try { await input.buffer.wait(input.signal, input.deadline); }
    catch { return undefined; }
  }
}

async function awaitExactRootProofAndCompletion(input: {
  buffer: BoundedEventBuffer;
  attempt: ArcPreparedReviewAttempt;
  identity: ArcReviewLaunchIdentity;
  artifactReferences: readonly string[];
  signal: AbortSignal;
  deadline: number;
}): Promise<ExactSettlement> {
  let processed = 0;
  let proof: ArcNativeObservedTerminal | undefined;
  let completion: ValidatedCompletion | undefined;
  for (;;) {
    const snapshot = input.buffer.snapshot();
    if (snapshot.overflow) return { error: new Error(`native event buffer exceeded ${ARC_REVIEW_MAX_EVENT_BUFFER} unique events`) };
    while (processed < snapshot.events.length) {
      const event = snapshot.events[processed++];
      if (event.kind === "terminal") {
        let candidate: ArcNativeObservedTerminal | undefined;
        try { candidate = parseExactTerminal(event.value, input.identity.runId!); }
        catch (error) { return { completion, proof, error: error instanceof Error ? error : new Error(String(error)) }; }
        if (candidate) {
          if (proof && canonicalizeArcJson(proof) !== canonicalizeArcJson(candidate)) return { completion, proof, error: new Error("conflicting exact-run process-terminal refinements") };
          proof = candidate;
        }
      } else {
        const candidate = await parseCompletion(event.value, input.attempt, input.identity, input.artifactReferences);
        if (candidate) {
          if (completion && canonicalizeArcJson(completion) !== canonicalizeArcJson(candidate)) return { completion, proof, error: new Error("conflicting exact-run completion events") };
          completion = candidate;
        }
      }
    }
    if (proof && completion) return { proof, completion };
    await input.buffer.wait(input.signal, input.deadline);
  }
}

async function recheckBufferedSettlement(input: {
  buffer: BoundedEventBuffer;
  attempt: ArcPreparedReviewAttempt;
  identity: ArcReviewLaunchIdentity;
  artifactReferences: readonly string[];
  expectedProof: ArcNativeObservedTerminal;
  expectedCompletion: ValidatedCompletion;
}): Promise<Error | undefined> {
  const snapshot = input.buffer.snapshot();
  if (snapshot.overflow) return new Error(`native event buffer exceeded ${ARC_REVIEW_MAX_EVENT_BUFFER} unique events`);
  let proof: ArcNativeObservedTerminal | undefined;
  let completion: ValidatedCompletion | undefined;
  for (const event of snapshot.events) {
    if (event.kind === "terminal") {
      let candidate: ArcNativeObservedTerminal | undefined;
      try { candidate = parseExactTerminal(event.value, input.identity.runId!); }
      catch (error) { return error instanceof Error ? error : new Error(String(error)); }
      if (!candidate) continue;
      if (proof && canonicalizeArcJson(proof) !== canonicalizeArcJson(candidate)) return new Error("conflicting exact-run process-terminal refinements");
      proof = candidate;
      continue;
    }
    const candidate = await parseCompletion(event.value, input.attempt, input.identity, input.artifactReferences);
    if (!candidate) continue;
    if (completion && canonicalizeArcJson(completion) !== canonicalizeArcJson(candidate)) return new Error("conflicting exact-run completion events");
    completion = candidate;
  }
  if (!proof || canonicalizeArcJson(proof) !== canonicalizeArcJson(input.expectedProof)) return new Error("exact-run process-terminal proof changed during persistence");
  if (!completion || canonicalizeArcJson(completion) !== canonicalizeArcJson(input.expectedCompletion)) return new Error("exact-run completion changed during persistence");
  return undefined;
}

function settleValidatedCompletion(input: {
  attempt: ArcPreparedReviewAttempt;
  receipt: ArcReviewDispatchReceipt;
  completion: ValidatedCompletion;
  proof: ArcNativeObservedTerminal;
  termination: ArcTerminationEvidence;
  startedAt: string;
  endedAt: string;
}): ArcAdapterExecution {
  const diagnostics: string[] = [];
  let bytes = 0;
  for (const diagnostic of input.completion.diagnostics) {
    const bounded = boundedMessage(diagnostic);
    const size = Buffer.byteLength(bounded, "utf8");
    if (diagnostics.length >= MAX_DIAGNOSTICS || bytes + size > MAX_DIAGNOSTIC_BYTES) break;
    diagnostics.push(bounded);
    bytes += size;
  }
  const artifacts = [...new Set([...input.receipt.artifactReferences, ...input.completion.artifactReferences])];
  if (artifacts.length > MAX_RETURNED_ARTIFACTS) throw new Error(`provider returned more than ${MAX_RETURNED_ARTIFACTS} final artifact references`);
  const runner = input.proof.instances.find((entry) => entry.kind === "runner")!;
  const lifecycle = runner.exitCode === 0 && runner.signal === null ? input.completion.lifecycle : "provider_lost";
  if (lifecycle === "provider_lost" && input.completion.lifecycle === "succeeded") diagnostics.push("runner process termination contradicts successful completion");
  return {
    adapter: "native",
    attemptId: input.attempt.attemptId,
    identity: input.receipt.identity,
    dispatchReceipt: input.receipt,
    lifecycle,
    exitCode: runner.exitCode,
    signal: runner.signal as NodeJS.Signals | null,
    ...(lifecycle === "succeeded" ? { structuredReport: input.completion.report } : {}),
    guardAcknowledgements: lifecycle === "succeeded" ? input.completion.guardAcknowledgements : [],
    termination: input.termination,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    boundedDiagnostics: diagnostics,
    artifactReferences: artifacts,
  };
}

function operationSignal(signal: AbortSignal, deadline: number): { signal: AbortSignal; timedOut: () => boolean; close(): void } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const remaining = Math.max(0, deadline - Date.now());
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error("native operation timed out")); }, remaining);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    close() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); },
  };
}

async function boundedWait<T>(start: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  const operation = operationSignal(signal, deadline);
  try {
    if (operation.signal.aborted) throw new Error(signal.aborted ? "review attempt aborted" : "native operation timed out");
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => operation.signal.removeEventListener("abort", onAbort);
      const succeed = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(new Error(signal.aborted ? "review attempt aborted" : "native operation timed out"));
      operation.signal.addEventListener("abort", onAbort, { once: true });
      let pending: Promise<T>;
      try { pending = start(); }
      catch (error) { fail(error); return; }
      Promise.resolve(pending).then(succeed, fail);
    });
  } finally {
    operation.close();
  }
}

export function createArcNativeReviewAdapter(options: ArcNativeReviewOptions): ArcReviewAdapter {
  if (!options || !options.events || typeof options.events.on !== "function" || typeof options.events.emit !== "function" ||
    !Array.isArray(options.trustedProviderExtensions) || typeof options.buildPrompt !== "function" ||
    (options.resolvedModel !== undefined && (typeof options.resolvedModel !== "string" || !options.resolvedModel))) {
    throw new Error("native review options are invalid");
  }
  const randomUUID = options.randomUUID ?? nodeRandomUUID;
  const now = options.now ?? (() => new Date());
  const rpc = createArcSubagentsRpcClient({ events: options.events, randomUUID });
  const attempted = new Set<string>();
  const retainedRegistrations = new Map<string, RegistrationHandle>();
  let readyProbe: { probe: ArcNativeAvailabilityProbe; fingerprint: string } | undefined;

  const disposeRegistration = (attemptId: string): Error | undefined => {
    const registration = retainedRegistrations.get(attemptId);
    if (!registration) return undefined;
    try {
      registration.dispose();
      retainedRegistrations.delete(attemptId);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const requestStop = async (identity: ArcReviewLaunchIdentity | undefined, deadline = Date.now() + ARC_REVIEW_STOP_GRACE_MS): Promise<void> => {
    if (!identity?.runId) return;
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("native stop timed out")), Math.max(0, deadline - Date.now()));
    try { await rpc.request(requestId, "stop", { id: identity.runId }, controller.signal); }
    catch { /* Stop is best-effort; exact-run unknown termination remains unresolved. */ }
    finally { clearTimeout(timer); }
  };

  return {
    kind: "native",
    async preflight(input: ArcReviewPreflightInput) {
      readyProbe = undefined;
      try { await validatePreparationPaths(input, options.trustedProviderExtensions); }
      catch (error) { return { ok: false, classification: "incompatible", reason: boundedMessage(error) }; }
      let firstReadyObserved = false;
      let secondReadyObserved = false;
      let phase: "first" | "second" = "first";
      const readyHandlers: Array<() => void> = [];
      const onReady = () => { if (phase === "first") firstReadyObserved = true; else secondReadyObserved = true; };
      readyHandlers.push(options.events.on(DEFAULT_READY_EVENT, onReady));
      try {
        let firstPing: ArcSubagentsPing;
        let secondPing: ArcSubagentsPing;
        try { firstPing = await rpc.ping(); }
        catch (error) { return { ok: false, classification: "ambiguous", reason: boundedMessage(error) }; }
        if (firstPing.events.ready && firstPing.events.ready !== DEFAULT_READY_EVENT) readyHandlers.push(options.events.on(firstPing.events.ready, onReady));
        phase = "second";
        await Promise.resolve();
        try { secondPing = await rpc.ping(); }
        catch (error) { return { ok: false, classification: "ambiguous", reason: boundedMessage(error) }; }
        if (!matchingPingFacts(firstPing, secondPing)) return { ok: false, classification: "ambiguous", reason: "two native readiness pings returned changed or non-matching facts" };
        const capabilityFailure = requiredCapabilityFailure(firstPing);
        if (capabilityFailure) return { ok: false, classification: "incompatible", reason: capabilityFailure };
        const probe = { firstReadyObserved, firstPing, secondReadyObserved, secondPing };
        try { ownerSessionId(probe); }
        catch (error) { return { ok: false, classification: "ambiguous", reason: boundedMessage(error) }; }
        readyProbe = { probe, fingerprint: preparationFingerprint(input) };
        return { ok: true };
      } finally {
        for (const dispose of readyHandlers) dispose();
      }
    },
    async execute(attempt: ArcPreparedReviewAttempt, signal: AbortSignal, observer: ArcAdapterObserver): Promise<ArcAdapterExecution> {
      if (attempted.has(attempt.attemptId)) throw new Error(`native review attempt ${attempt.attemptId} was already executed or attempted`);
      attempted.add(attempt.attemptId);
      const startedAt = nowIso(now);
      const identity: ArcReviewLaunchIdentity = {
        adapter: "native",
        attemptId: attempt.attemptId,
        requestId: randomUUID(),
        privateAgentName: `arc-guarded-${attempt.request.role}-${attempt.attemptId}`,
      };
      let receipt: ArcReviewDispatchReceipt | undefined;
      let registration: RegistrationHandle | undefined;
      let spawnEmitted = false;
      let terminalObserved = false;
      let buffer: BoundedEventBuffer | undefined;
      let unsubscribeCompletion = () => {};
      let unsubscribeTerminal = () => {};
      const finishFailure = (lifecycle: ArcAdapterExecution["lifecycle"], reason: unknown, termination?: ArcTerminationEvidence) => failedExecution({
        attempt, identity: receipt?.identity ?? identity, receipt, lifecycle, startedAt, endedAt: nowIso(now), reason, termination,
      });
      try {
        validateAttemptIdentity(attempt);
        const entered = Date.now();
        const hardDeadline = Math.min(Date.parse(attempt.dispatchDeadlineAt), entered + attempt.effectiveAttemptBudgetMs);
        const workDeadline = Math.min(hardDeadline, entered + attempt.executionTimeoutMs);
        const terminalDeadline = Math.min(hardDeadline, workDeadline + ARC_REVIEW_STOP_GRACE_MS);
        if (!Number.isFinite(workDeadline) || workDeadline <= Date.now()) return finishFailure("timed_out", "native dispatch deadline elapsed before preparation");
        await boundedWait(() => validatePreparationPaths({ request: attempt.request, preparation: attempt }, options.trustedProviderExtensions), signal, workDeadline);
        if (!readyProbe || readyProbe.fingerprint !== preparationFingerprint({ request: attempt.request, preparation: attempt })) {
          return finishFailure("provider_lost", "native execute requires a matching successful ready preflight");
        }
        identity.ownerSessionId = ownerSessionId(readyProbe.probe);
        const prompt = validatePrompt(attempt, options.buildPrompt);
        if (signal.aborted) return finishFailure("cancelled", "review attempt was cancelled before dispatch");
        try { await boundedWait(() => observer.persistBeforeDispatch(identity), signal, workDeadline); }
        catch (error) { return finishFailure(signal.aborted ? "cancelled" : "guard_failed", `before-dispatch persistence failed: ${boundedMessage(error)}`); }
        await boundedWait(() => validatePreparationPaths({ request: attempt.request, preparation: attempt }, options.trustedProviderExtensions), signal, workDeadline);

        buffer = new BoundedEventBuffer();
        unsubscribeCompletion = options.events.on(readyProbe.probe.secondPing.events.asyncComplete!, (value) => buffer!.add("completion", value));
        unsubscribeTerminal = options.events.on(readyProbe.probe.secondPing.events.processTerminal!, (value) => buffer!.add("terminal", value));

        try { registration = registerPrivateAgent(options, attempt, identity, prompt); }
        catch (error) { return finishFailure("provider_lost", error); }
        retainedRegistrations.set(attempt.attemptId, registration);

        if (workDeadline <= Date.now()) return finishFailure("timed_out", "native dispatch deadline elapsed before spawn");
        const operation = operationSignal(signal, workDeadline);
        const dispatchedAt = nowIso(now);
        let spawnValue: unknown;
        try {
          spawnEmitted = true;
          spawnValue = await rpc.request(identity.requestId, "spawn", {
            agent: identity.privateAgentName,
            task: prompt.task,
            cwd: attempt.runtimeRoot,
            context: "fresh",
            async: true,
            timeoutMs: attempt.executionTimeoutMs,
            outputSchema: ARC_REVIEWER_REPORT_JSON_SCHEMA,
          }, operation.signal);
        } catch (error) {
          if (!operation.timedOut() && !signal.aborted && error instanceof Error && /subagents RPC [a-z_]+:/i.test(error.message)) {
            disposeRegistration(attempt.attemptId);
            return finishFailure("spawn_failed", error, { status: "not_applicable", source: "not_started", detail: "provider explicitly rejected native spawn" });
          }
          return finishFailure(signal.aborted ? "cancelled" : "provider_lost", error, { status: "unknown", source: "provider_process_terminal", detail: "native spawn was emitted but no exact run receipt established" });
        } finally {
          operation.close();
        }

        try {
          const bound = await boundedWait(() => validateSpawnReceipt(attempt, identity, spawnValue, dispatchedAt, nowIso(now)), signal, workDeadline);
          receipt = bound.receipt;
          Object.assign(identity, receipt.identity);
        } catch (error) {
          if (identity.runId) await requestStop(identity);
          return finishFailure("provider_lost", error, {
            status: "unknown",
            source: "provider_process_terminal",
            ...(identity.runId ? { runId: identity.runId } : {}),
            detail: identity.runId
              ? "native spawn bound an exact run but later receipt path validation failed"
              : "native spawn was emitted but its malformed reply did not establish an exact run identity",
          });
        }

        try { await boundedWait(() => observer.persistDispatchReceipt(receipt!), signal, workDeadline); }
        catch (error) {
          await requestStop(receipt.identity);
          return finishFailure("guard_failed", `initial dispatch receipt persistence failed: ${boundedMessage(error)}`);
        }
        observer.progress(`native review run ${identity.runId} dispatched`);

        let settlement: ExactSettlement;
        try { settlement = await awaitExactRootProofAndCompletion({ buffer, attempt, identity, artifactReferences: receipt.artifactReferences, signal, deadline: workDeadline }); }
        catch (error) {
          const lifecycle = signal.aborted ? "cancelled" : "timed_out";
          const stopDeadline = Math.min(hardDeadline, Date.now() + ARC_REVIEW_STOP_GRACE_MS);
          await requestStop(identity, stopDeadline);
          const proof = await awaitExactRootProof({ buffer, runId: identity.runId!, signal: new AbortController().signal, deadline: stopDeadline });
          if (!proof) return finishFailure(lifecycle, error);
          if (!receipt) return finishFailure("provider_lost", "post-stop proof was observed without a durable spawn receipt");
          const refined: ArcReviewDispatchReceipt = { ...receipt, identity: { ...receipt.identity, runnerProcessInstanceId: proof.runnerProcessInstanceId } };
          Object.assign(identity, refined.identity);
          const termination = normalizeObservedProof(proof);
          try {
            await boundedWait(() => observer.persistDispatchReceipt(refined), new AbortController().signal, stopDeadline);
            await boundedWait(() => observer.persistObservedTermination(termination), new AbortController().signal, stopDeadline);
            receipt = refined;
            terminalObserved = true;
            const disposalError = disposeRegistration(attempt.attemptId);
            if (disposalError) return finishFailure("guard_failed", `runtime registration disposal failed: ${boundedMessage(disposalError)}`, termination);
          } catch (persistenceError) {
            return finishFailure("guard_failed", `post-stop terminal persistence failed: ${boundedMessage(persistenceError)}`, termination);
          }
          return finishFailure(lifecycle, error, termination);
        }
        if (settlement.error || !settlement.proof || !settlement.completion) {
          await requestStop(identity);
          return finishFailure("provider_lost", settlement.error ?? "native completion or exact root proof was missing");
        }

        const proof = settlement.proof;
        const refined: ArcReviewDispatchReceipt = {
          ...receipt,
          identity: { ...receipt.identity, runnerProcessInstanceId: proof.runnerProcessInstanceId },
        };
        Object.assign(identity, refined.identity);
        const termination = normalizeObservedProof(proof);
        try {
          await boundedWait(() => observer.persistDispatchReceipt(refined), signal, terminalDeadline);
          await boundedWait(() => observer.persistObservedTermination(termination), signal, terminalDeadline);
        } catch (error) {
          await requestStop(identity);
          return finishFailure("guard_failed", `terminal identity persistence failed: ${boundedMessage(error)}`, termination);
        }
        let persistenceConflict: Error | undefined;
        try {
          persistenceConflict = await boundedWait(() => recheckBufferedSettlement({
            buffer,
            attempt,
            identity,
            artifactReferences: refined.artifactReferences,
            expectedProof: proof,
            expectedCompletion: settlement.completion,
          }), signal, terminalDeadline);
        } catch (error) {
          await requestStop(identity);
          return finishFailure("guard_failed", `post-persistence settlement barrier failed: ${boundedMessage(error)}`, termination);
        }
        if (persistenceConflict) {
          await requestStop(identity);
          return finishFailure("provider_lost", persistenceConflict, termination);
        }
        receipt = refined;
        terminalObserved = true;
        const disposalError = disposeRegistration(attempt.attemptId);
        if (disposalError) return finishFailure("guard_failed", `runtime registration disposal failed: ${boundedMessage(disposalError)}`, termination);
        return settleValidatedCompletion({ attempt, receipt: refined, completion: settlement.completion, proof, termination, startedAt, endedAt: nowIso(now) });
      } catch (error) {
        if (spawnEmitted && receipt?.identity.runId) await requestStop(receipt.identity);
        return finishFailure(signal.aborted ? "cancelled" : "provider_lost", error);
      } finally {
        unsubscribeCompletion();
        unsubscribeTerminal();
        if (registration && (!spawnEmitted || terminalObserved)) disposeRegistration(attempt.attemptId);
      }
    },
    async stop(attempt: ArcPreparedReviewAttempt, identity: ArcReviewLaunchIdentity | undefined): Promise<void> {
      if (!identity || identity.adapter !== "native" || identity.attemptId !== attempt.attemptId) return;
      await requestStop(identity);
    },
  };
}
