import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { CommandRequest, CommandResult, CommandRunner } from "../core/ports.ts";

interface ResolvedExecutable {
  readonly name: string;
  readonly absolutePath: string;
}

const KILL_GRACE_MS = 250;

class OutputAccumulator {
  #remaining: number;
  #truncated = false;

  constructor(maxOutputBytes: number) {
    this.#remaining = maxOutputBytes;
  }

  append(chunk: Buffer): Buffer | null {
    if (this.#remaining === 0) {
      this.#truncated = true;
      return null;
    }
    if (chunk.byteLength <= this.#remaining) {
      this.#remaining -= chunk.byteLength;
      return chunk;
    }
    const bounded = chunk.subarray(0, this.#remaining);
    this.#remaining = 0;
    this.#truncated = true;
    return bounded;
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

const isWithin = (candidate: string, directory: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const findRepositoryRoots = async (cwd: string): Promise<readonly string[]> => {
  const roots: string[] = [];
  let directory = await realpath(cwd);
  while (true) {
    try {
      await stat(path.join(directory, ".git"));
      roots.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return roots;
    directory = parent;
  }
};

const resolveCandidate = async (
  name: string,
  candidate: string,
  cwd: string,
  repositoryRoots: readonly string[],
): Promise<ResolvedExecutable | null> => {
  try {
    await access(candidate, constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EACCES") return null;
    throw error;
  }
  const absolutePath = await realpath(candidate);
  if (isWithin(absolutePath, cwd) || repositoryRoots.some((repositoryRoot) => isWithin(absolutePath, repositoryRoot))) {
    throw new Error(`Trusted executable may not be repository-local: ${name}`);
  }
  return { name, absolutePath };
};

const resolveTrustedExecutable = async (executable: string, cwd: string): Promise<ResolvedExecutable> => {
  if (executable.length === 0 || executable.includes("\0")) throw new Error("Invalid executable");
  const realCwd = await realpath(cwd);
  const repositoryRoots = await findRepositoryRoots(realCwd);
  if (path.isAbsolute(executable)) {
    const resolved = await resolveCandidate(path.basename(executable), executable, realCwd, repositoryRoots);
    if (resolved !== null) return resolved;
    throw new Error(`Trusted executable is unavailable: ${executable}`);
  }
  if (path.basename(executable) !== executable) throw new Error(`Trusted executable must be a bare command name: ${executable}`);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of pathEntries) {
    const directory = path.isAbsolute(entry) ? entry : path.resolve(realCwd, entry || ".");
    const resolved = await resolveCandidate(executable, path.join(directory, executable), realCwd, repositoryRoots);
    if (resolved !== null) return resolved;
  }
  throw new Error(`Trusted executable is unavailable: ${executable}`);
};

const decodeOutput = (chunks: readonly Buffer[]): string => new TextDecoder().decode(Buffer.concat(chunks), { stream: true });

export const createCommandRunner = (): CommandRunner => ({
  async run(request: CommandRequest): Promise<CommandResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) throw new RangeError("timeoutMs must be non-negative");
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0) {
      throw new RangeError("maxOutputBytes must be a non-negative safe integer");
    }

    const executable = await resolveTrustedExecutable(request.executable, request.cwd);
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(executable.absolutePath, request.args, {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = new OutputAccumulator(request.maxOutputBytes);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let killed = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const signalProcessTree = (signal: NodeJS.Signals): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The group may already have exited; fall through to the direct child.
          }
        }
        child.kill(signal);
      };

      const terminate = (): void => {
        if (killed) return;
        killed = true;
        signalProcessTree("SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree("SIGKILL");
          killTimer = undefined;
        }, KILL_GRACE_MS);
      };

      const timeout = setTimeout(terminate, request.timeoutMs);
      timeout.unref();
      const onAbort = (): void => terminate();
      const clearRequestResources = (clearEscalation: boolean): void => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        if (clearEscalation && killTimer !== undefined) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        const bounded = output.append(chunk);
        if (bounded !== null) stdout.push(bounded);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const bounded = output.append(chunk);
        if (bounded !== null) stderr.push(bounded);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearRequestResources(true);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearRequestResources(!killed || process.platform === "win32");
        resolve({
          code: code ?? 1,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
          killed,
          truncated: output.truncated,
        });
      });
      if (request.signal?.aborted) terminate();
    });
  },
});
