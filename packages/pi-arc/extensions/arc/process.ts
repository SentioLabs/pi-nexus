import { spawn, type ChildProcess } from "node:child_process";

import type { ArcProcessResult, ArcProcessSpawnObservation } from "./reports.ts";

class BoundedByteCollector {
  readonly #limit: number;
  #prefix = Buffer.alloc(0);
  #suffix = Buffer.alloc(0);
  #total = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("maxOutputBytes must be a non-negative safe integer");
    this.#limit = limit;
  }

  push(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk);
    this.#total += bytes.length;
    if (this.#limit === 0) return;
    const prefixLimit = Math.ceil(this.#limit / 2);
    let offset = 0;
    if (this.#prefix.length < prefixLimit) {
      const amount = Math.min(prefixLimit - this.#prefix.length, bytes.length);
      this.#prefix = Buffer.concat([this.#prefix, bytes.subarray(0, amount)]);
      offset = amount;
    }
    const suffixLimit = this.#limit - this.#prefix.length;
    if (suffixLimit > 0 && offset < bytes.length) {
      const tailStart = Math.max(offset, bytes.length - suffixLimit);
      this.#suffix = Buffer.concat([this.#suffix, bytes.subarray(tailStart)]).subarray(-suffixLimit);
    }
  }

  get truncated(): boolean { return this.#total > this.#limit; }
  bytes(): Uint8Array {
    if (!this.truncated) return Uint8Array.from(Buffer.concat([this.#prefix, this.#suffix]));
    return Uint8Array.from(Buffer.concat([this.#prefix, this.#suffix]).subarray(0, this.#limit));
  }
}

function boundedError(error: unknown): string {
  let message: string;
  if (error instanceof Error) message = `${error.name}: ${error.message}`;
  else message = String(error);
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 4096) return message;
  let end = 4096;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function validDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
}

export function runArcBoundedProcess(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: Uint8Array; timeoutMs: number;
  stopGraceMs: number; killGraceMs: number; maxOutputBytes: number; signal?: AbortSignal;
  onSpawn?: (observation: ArcProcessSpawnObservation) => Promise<void>;
}): Promise<ArcProcessResult> {
  validDuration(input.timeoutMs, "timeoutMs");
  validDuration(input.stopGraceMs, "stopGraceMs");
  validDuration(input.killGraceMs, "killGraceMs");
  const stdout = new BoundedByteCollector(input.maxOutputBytes);
  const stderr = new BoundedByteCollector(input.maxOutputBytes);
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let child: ChildProcess;
    let spawned = false;
    let spawnObservation: ArcProcessSpawnObservation | undefined;
    let observedClose = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let aborted = input.signal?.aborted ?? false;
    let observationSettled = input.onSpawn === undefined;
    let observationError: string | undefined;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let termTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const finish = (termination: "observed" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (termTimer) clearTimeout(termTimer);
      if (hardTimer) clearTimeout(hardTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        spawned,
        ...(spawnObservation ? { pid: spawnObservation.pid } : {}),
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        termination,
        stdout: stdout.bytes(), stderr: stderr.bytes(),
        stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
        startedAt, endedAt: new Date().toISOString(),
        ...(observationError ? { observationError } : {}),
      });
    };

    const maybeSettle = () => {
      if (observedClose && observationSettled) finish("observed");
    };

    const terminateOwnedChild = () => {
      if (!spawned) {
        if (!hardTimer) hardTimer = setTimeout(() => finish(observedClose ? "observed" : "unknown"), input.stopGraceMs + input.killGraceMs);
        return;
      }
      if (!observedClose) {
        try { child.kill("SIGTERM"); } catch { /* close/hard deadline remains authoritative */ }
        if (!termTimer) termTimer = setTimeout(() => {
          if (!observedClose) {
            try { child.kill("SIGKILL"); } catch { /* hard deadline remains authoritative */ }
          }
        }, input.stopGraceMs);
      }
      if (!hardTimer) hardTimer = setTimeout(() => {
        if (!observationSettled) {
          observationError ??= "spawn observer did not settle before process deadline";
          observationSettled = true;
        }
        finish(observedClose ? "observed" : "unknown");
      }, input.stopGraceMs + input.killGraceMs);
    };

    const failBeforeClose = (error: unknown) => {
      observationError ??= boundedError(error);
      if (!spawned) observationSettled = true;
      terminateOwnedChild();
      maybeSettle();
    };

    const onAbort = () => {
      aborted = true;
      if (!observationSettled) observationError ??= "spawn observer did not settle before abort deadline";
      terminateOwnedChild();
    };

    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd, env: input.env, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      observationError = boundedError(error);
      observationSettled = true;
      finish("unknown");
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin?.once("error", failBeforeClose);
    child.once("error", failBeforeClose);
    child.once("close", (code, signal) => {
      observedClose = true;
      exitCode = code;
      exitSignal = signal;
      maybeSettle();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!observationSettled) observationError ??= "spawn observer did not settle before process deadline";
      terminateOwnedChild();
    }, input.timeoutMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("spawn", () => {
      spawned = true;
      spawnObservation = { pid: child.pid!, spawnedAt: new Date().toISOString() };
      Promise.resolve().then(() => input.onSpawn?.(spawnObservation!)).then(
        () => { observationSettled = true; maybeSettle(); },
        (error) => { observationError = boundedError(error); observationSettled = true; terminateOwnedChild(); maybeSettle(); },
      );
      if (aborted) onAbort();
    });

    child.stdin?.end(input.stdin ? Buffer.from(input.stdin) : undefined);
  });
}
