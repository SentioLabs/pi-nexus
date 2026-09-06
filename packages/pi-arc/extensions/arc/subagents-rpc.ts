import { randomUUID as nodeRandomUUID } from "node:crypto";

import {
  ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES,
  ARC_REVIEW_RPC_TIMEOUT_MS,
  ARC_SUBAGENTS_RPC_REQUEST_EVENT,
  type ArcSubagentsPing,
  type ArcSubagentsRpcClient,
} from "./reports.ts";

const REPLY_PREFIX = "subagents:rpc:v1:reply:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RPC_DEPTH = 64;
const MAX_RPC_NODES = 4096;
const MAX_RPC_ENTRIES = 4096;
const MAX_RPC_FIELD_BYTES = 4096;

type ArcEvents = {
  on(name: string, handler: (value: unknown) => void): () => void;
  emit(name: string, value: unknown): void;
};

type RpcMethod = "ping" | "spawn" | "status" | "stop" | "resume";

interface RpcReply {
  version: 1;
  requestId: string;
  method: RpcMethod;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateUuid(value: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("requestId must be a UUID");
}

function validateJsonLikeStructure(value: unknown, label: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_RPC_DEPTH) throw new Error(`${label} exceeds the structural depth bound`);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${label} contains a non-JSON number`);
      continue;
    }
    if (typeof item === "string") {
      const size = Buffer.byteLength(item, "utf8");
      if (size > ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES) throw new Error(`${label} contains an oversized string`);
      bytes += size;
      if (bytes > ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES) throw new Error(`${label} exceeds the aggregate byte bound`);
      continue;
    }
    if (typeof item !== "object") throw new Error(`${label} is not plain JSON-like data`);
    if (seen.has(item)) throw new Error(`${label} contains a cycle`);
    seen.add(item);
    nodes += 1;
    if (nodes > MAX_RPC_NODES) throw new Error(`${label} exceeds the structural node bound`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error(`${label} contains an unsupported prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    entries += keys.length;
    if (entries > MAX_RPC_ENTRIES) throw new Error(`${label} exceeds the structural entry bound`);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error(`${label} contains a symbol key`);
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > ARC_REVIEW_MAX_PROCESS_OUTPUT_BYTES) throw new Error(`${label} exceeds the aggregate byte bound`);
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || descriptor.get || descriptor.set) throw new Error(`${label} contains an accessor property`);
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const detail = signal.reason instanceof Error ? `: ${signal.reason.message}` : "";
  return new Error(`subagents RPC request aborted${detail}`);
}

function awaitSingleBoundedReply(input: {
  events: ArcEvents;
  replyName: string;
  requestId: string;
  method: RpcMethod;
  timeoutMs: number;
  signal?: AbortSignal;
  emit: () => void;
  registerCancellation: (cancel: (error: Error) => void) => () => void;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    let unregisterCancellation = () => {};
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      unregisterCancellation();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => fail(abortError(input.signal!));
    const onReply = (raw: unknown) => {
      if (!isRecord(raw) || raw.version !== 1 || raw.requestId !== input.requestId || raw.method !== input.method || typeof raw.success !== "boolean") return;
      if (raw.success) {
        if (!Object.hasOwn(raw, "data")) return;
        try {
          validateJsonLikeStructure(raw.data, `subagents RPC ${input.method} data`);
          succeed(structuredClone(raw.data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(`subagents RPC ${input.method} returned invalid data`));
        }
        return;
      }
      if (!isRecord(raw.error) || typeof raw.error.code !== "string" || !raw.error.code || typeof raw.error.message !== "string" || !raw.error.message ||
          Buffer.byteLength(raw.error.code, "utf8") > MAX_RPC_FIELD_BYTES || Buffer.byteLength(raw.error.message, "utf8") > MAX_RPC_FIELD_BYTES) {
        fail(new Error(`subagents RPC ${input.method} returned malformed bounded error details`));
        return;
      }
      fail(new Error(`subagents RPC ${raw.error.code}: ${raw.error.message}`));
    };

    unsubscribe = input.events.on(input.replyName, onReply);
    unregisterCancellation = input.registerCancellation(fail);
    if (input.signal?.aborted) {
      fail(abortError(input.signal));
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new Error(`subagents RPC ${input.method} timed out after ${input.timeoutMs}ms`)), input.timeoutMs);
    try {
      input.emit();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function optionalString(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > 4096) throw new Error(`malformed ping ${at}`);
  return value;
}

function validatePing(value: unknown): ArcSubagentsPing {
  if (!isRecord(value) || value.version !== 1) throw new Error("malformed ping version");
  if (!Array.isArray(value.methods) || value.methods.length > 64 || value.methods.some((method) => typeof method !== "string" || !method || /[\0\r\n]/.test(method) || Buffer.byteLength(method, "utf8") > MAX_RPC_FIELD_BYTES) || new Set(value.methods).size !== value.methods.length) throw new Error("malformed ping methods");
  if (!isRecord(value.capabilities)) throw new Error("malformed ping capabilities");
  if (!isRecord(value.events)) throw new Error("malformed ping events");

  const capabilities = value.capabilities;
  for (const key of ["asyncSpawn", "stop", "resume"] as const) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") throw new Error(`malformed ping capabilities.${key}`);
  }
  if (capabilities.runtimeAcknowledgedExtensions !== undefined) {
    const item = capabilities.runtimeAcknowledgedExtensions;
    if (!isRecord(item) || item.version !== 1 || item.source !== "child-runtime" || typeof item.event !== "string" || !item.event) {
      throw new Error("malformed ping capabilities.runtimeAcknowledgedExtensions");
    }
  }
  if (capabilities.processTerminalProof !== undefined) {
    const item = capabilities.processTerminalProof;
    if (!isRecord(item) || item.version !== 1 || !Number.isSafeInteger(item.lifecycleArtifactVersion) || (item.lifecycleArtifactVersion as number) < 1) {
      throw new Error("malformed ping capabilities.processTerminalProof");
    }
  }

  const asyncComplete = optionalString(value.events.asyncComplete, "events.asyncComplete");
  const processTerminal = optionalString(value.events.processTerminal, "events.processTerminal");
  const ready = optionalString(value.events.ready, "events.ready");
  const request = optionalString(value.events.request, "events.request");
  const replyPrefix = optionalString(value.events.replyPrefix, "events.replyPrefix");
  const events = {
    ...(asyncComplete ? { asyncComplete } : {}),
    ...(processTerminal ? { processTerminal } : {}),
    ...(ready ? { ready } : {}),
    ...(request ? { request } : {}),
    ...(replyPrefix ? { replyPrefix } : {}),
  };
  let session: ArcSubagentsPing["session"];
  if (value.session !== undefined) {
    if (!isRecord(value.session)) throw new Error("malformed ping session");
    const cwd = optionalString(value.session.cwd, "session.cwd");
    const sessionId = optionalString(value.session.sessionId, "session.sessionId");
    const sessionFileValue = value.session.sessionFile;
    if (sessionFileValue !== undefined && sessionFileValue !== null && (typeof sessionFileValue !== "string" || !sessionFileValue || /[\0\r\n]/.test(sessionFileValue) || Buffer.byteLength(sessionFileValue, "utf8") > MAX_RPC_FIELD_BYTES)) throw new Error("malformed ping session.sessionFile");
    session = {
      ...(cwd ? { cwd } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionFileValue !== undefined ? { sessionFile: sessionFileValue as string | null } : {}),
    };
  }

  return structuredClone({
    version: 1,
    methods: [...value.methods] as string[],
    capabilities: {
      ...(capabilities.asyncSpawn !== undefined ? { asyncSpawn: capabilities.asyncSpawn as boolean } : {}),
      ...(capabilities.stop !== undefined ? { stop: capabilities.stop as boolean } : {}),
      ...(capabilities.resume !== undefined ? { resume: capabilities.resume as boolean } : {}),
      ...(capabilities.runtimeAcknowledgedExtensions !== undefined ? { runtimeAcknowledgedExtensions: capabilities.runtimeAcknowledgedExtensions as ArcSubagentsPing["capabilities"]["runtimeAcknowledgedExtensions"] } : {}),
      ...(capabilities.processTerminalProof !== undefined ? { processTerminalProof: capabilities.processTerminalProof as ArcSubagentsPing["capabilities"]["processTerminalProof"] } : {}),
    },
    events,
    ...(session ? { session } : {}),
  });
}

export function createArcSubagentsRpcClient(input: {
  events: ArcEvents;
  requestTimeoutMs?: number;
  randomUUID?: () => string;
}): ArcSubagentsRpcClient {
  if (!input || !input.events || typeof input.events.on !== "function" || typeof input.events.emit !== "function") throw new Error("subagents RPC events are invalid");
  const timeoutMs = input.requestTimeoutMs ?? ARC_REVIEW_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("subagents RPC timeout must be a positive integer");
  const randomUUID = input.randomUUID ?? nodeRandomUUID;
  let disposed = false;
  const cancellations = new Set<(error: Error) => void>();

  const issue = async (requestId: string, method: RpcMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (disposed) throw new Error("subagents RPC client is disposed");
    validateUuid(requestId);
    if (!isRecord(params)) throw new Error("subagents RPC params must be a plain object");
    const replyName = `${REPLY_PREFIX}${requestId}`;
    const wireParams = structuredClone(params);
    return await awaitSingleBoundedReply({
      events: input.events,
      replyName,
      requestId,
      method,
      timeoutMs,
      signal,
      registerCancellation(cancel) {
        cancellations.add(cancel);
        return () => cancellations.delete(cancel);
      },
      emit: () => input.events.emit(ARC_SUBAGENTS_RPC_REQUEST_EVENT, { version: 1, requestId, method, params: wireParams }),
    });
  };

  return {
    async ping(signal?: AbortSignal): Promise<ArcSubagentsPing> {
      const requestId = randomUUID();
      return validatePing(await issue(requestId, "ping", {}, signal));
    },
    request(requestId, method, params, signal) {
      return issue(requestId, method, params, signal);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error("subagents RPC client is disposed");
      for (const cancel of [...cancellations]) cancel(error);
      cancellations.clear();
    },
  };
}
