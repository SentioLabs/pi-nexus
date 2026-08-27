import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { CommandRequest, CommandResult, CommandRunner } from "../core/ports.ts";

interface ResolvedExecutable {
  readonly name: string;
  readonly absolutePath: string;
}

interface CommandRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly path?: string;
  readonly pathExt?: string;
}

interface GitDirectory {
  readonly gitDir: string;
  readonly commonDir: string;
}

const KILL_GRACE_MS = 250;
const GROUP_POLL_MS = 10;
const GIT_POINTER_MAX_BYTES = 4 * 1024;

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

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const readBoundedRegularFile = async (filename: string, label: string): Promise<string> => {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Malformed ${label}`);
  if (constants.O_NOFOLLOW === undefined) throw new Error(`Cannot safely read ${label}`);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) throw new Error(`Malformed ${label}`);
    const buffer = Buffer.alloc(GIT_POINTER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > GIT_POINTER_MAX_BYTES) throw new Error(`Malformed ${label}`);
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
};

const parsePointer = (contents: string, prefix: string, label: string): string => {
  if (!contents.endsWith("\n") || contents.includes("\0")) throw new Error(`Malformed ${label}`);
  const line = contents.slice(0, -1).endsWith("\r") ? contents.slice(0, -2) : contents.slice(0, -1);
  if (!line.startsWith(prefix) || line.slice(prefix.length).length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new Error(`Malformed ${label}`);
  }
  return line.slice(prefix.length);
};

const resolvePointerDirectory = async (pointerFile: string, target: string, label: string): Promise<string> => {
  const resolved = await realpath(path.resolve(path.dirname(pointerFile), target));
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Malformed ${label}`);
  return resolved;
};

const resolvePointerFile = async (pointerFile: string, target: string, label: string): Promise<string> => {
  const resolved = await realpath(path.resolve(path.dirname(pointerFile), target));
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Malformed ${label}`);
  return resolved;
};

const readGitDirectory = async (gitFile: string): Promise<GitDirectory> => {
  const gitDir = await resolvePointerDirectory(
    gitFile,
    parsePointer(await readBoundedRegularFile(gitFile, "Git pointer"), "gitdir: ", "Git pointer"),
    "Git pointer",
  );
  const commonPointer = path.join(gitDir, "commondir");
  try {
    return {
      gitDir,
      commonDir: await resolvePointerDirectory(
        commonPointer,
        parsePointer(await readBoundedRegularFile(commonPointer, "Git common-dir pointer"), "", "Git common-dir pointer"),
        "Git common-dir pointer",
      ),
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (path.basename(path.dirname(gitDir)).toLowerCase() === "worktrees") {
      throw new Error("Malformed Git common-dir pointer");
    }
    return { gitDir, commonDir: gitDir };
  }
};

const inspectGitDirectory = async (repositoryRoot: string): Promise<GitDirectory | null> => {
  const gitPath = path.join(repositoryRoot, ".git");
  let metadata;
  try {
    metadata = await lstat(gitPath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error("Malformed Git directory");
  if (metadata.isDirectory()) {
    const gitDir = await realpath(gitPath);
    return { gitDir, commonDir: gitDir };
  }
  if (metadata.isFile()) return readGitDirectory(gitPath);
  throw new Error("Malformed Git directory");
};

const linkedWorktreeRoots = async (commonDir: string): Promise<readonly string[]> => {
  const worktreesDirectory = path.join(commonDir, "worktrees");
  let entries;
  try {
    entries = await readdir(worktreesDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Malformed linked-worktree metadata");
    const privateGitDir = path.join(worktreesDirectory, entry.name);
    const gitdirPointer = path.join(privateGitDir, "gitdir");
    const gitFile = await resolvePointerFile(
      gitdirPointer,
      parsePointer(await readBoundedRegularFile(gitdirPointer, "linked-worktree Git pointer"), "", "linked-worktree Git pointer"),
      "linked-worktree Git pointer",
    );
    if (path.basename(gitFile) !== ".git") throw new Error("Malformed linked-worktree Git pointer");
    const gitDirectory = await readGitDirectory(gitFile);
    if (gitDirectory.gitDir !== (await realpath(privateGitDir)) || gitDirectory.commonDir !== commonDir) {
      throw new Error("Malformed linked-worktree Git pointer");
    }
    roots.push(path.dirname(gitFile));
  }
  return roots;
};

const findRepositoryRoots = async (cwd: string): Promise<readonly string[]> => {
  const roots = new Set<string>();
  const commonDirectories = new Set<string>();
  let directory = await realpath(cwd);
  while (true) {
    const gitDirectory = await inspectGitDirectory(directory);
    if (gitDirectory !== null) {
      roots.add(directory);
      roots.add(gitDirectory.gitDir);
      roots.add(gitDirectory.commonDir);
      commonDirectories.add(gitDirectory.commonDir);
      if (path.basename(gitDirectory.commonDir).toLowerCase() === ".git") roots.add(path.dirname(gitDirectory.commonDir));
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const commonDir of commonDirectories) {
    for (const worktreeRoot of await linkedWorktreeRoots(commonDir)) roots.add(worktreeRoot);
  }
  return [...roots];
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
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "EACCES") return null;
    throw error;
  }
  const absolutePath = await realpath(candidate);
  if (isWithin(absolutePath, cwd) || repositoryRoots.some((repositoryRoot) => isWithin(absolutePath, repositoryRoot))) {
    throw new Error(`Trusted executable may not be repository-local: ${name}`);
  }
  return { name, absolutePath };
};

const pathExtensions = (pathExt: string | undefined): readonly string[] => {
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";");
  if (extensions.some((extension) => !/^\.[^\\/:;\0]+$/.test(extension))) throw new Error("Invalid PATHEXT");
  return [...new Map(extensions.map((extension) => [extension.toUpperCase(), extension])).values()];
};

const resolveTrustedExecutable = async (
  executable: string,
  cwd: string,
  options: Required<Pick<CommandRunnerOptions, "platform">> & Pick<CommandRunnerOptions, "path" | "pathExt">,
): Promise<ResolvedExecutable> => {
  if (executable.length === 0 || executable.includes("\0")) throw new Error("Invalid executable");
  const realCwd = await realpath(cwd);
  const repositoryRoots = await findRepositoryRoots(realCwd);
  if (path.isAbsolute(executable)) {
    const resolved = await resolveCandidate(path.basename(executable), executable, realCwd, repositoryRoots);
    if (resolved !== null) return resolved;
    throw new Error(`Trusted executable is unavailable: ${executable}`);
  }
  if (path.basename(executable) !== executable) throw new Error(`Trusted executable must be a bare command name: ${executable}`);
  const pathEntries = (options.path ?? process.env.PATH ?? "").split(options.platform === "win32" ? ";" : path.delimiter);
  const names = options.platform === "win32" && path.extname(executable) === "" ? pathExtensions(options.pathExt ?? process.env.PATHEXT) : [""];
  for (const entry of pathEntries) {
    const directory = path.isAbsolute(entry) ? entry : path.resolve(realCwd, entry || ".");
    for (const extension of names) {
      const resolved = await resolveCandidate(executable, path.join(directory, `${executable}${extension}`), realCwd, repositoryRoots);
      if (resolved !== null) return resolved;
    }
  }
  throw new Error(`Trusted executable is unavailable: ${executable}`);
};

const decodeOutput = (chunks: readonly Buffer[]): string => new TextDecoder().decode(Buffer.concat(chunks), { stream: true });

export const createCommandRunner = (options: CommandRunnerOptions = {}): CommandRunner => {
  const runtime = {
    platform: options.platform ?? process.platform,
    path: options.path,
    pathExt: options.pathExt,
  };

  return {
    async run(request: CommandRequest): Promise<CommandResult> {
      if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) throw new RangeError("timeoutMs must be non-negative");
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0) {
        throw new RangeError("maxOutputBytes must be a non-negative safe integer");
      }

      const executable = await resolveTrustedExecutable(request.executable, request.cwd, runtime);
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(executable.absolutePath, request.args, {
          cwd: request.cwd,
          detached: runtime.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const output = new OutputAccumulator(request.maxOutputBytes);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let killed = false;
        let settled = false;
        let closing = false;
        let killTimer: NodeJS.Timeout | undefined;

        const processGroupIsAbsent = (): boolean => {
          if (runtime.platform === "win32" || child.pid === undefined) return true;
          try {
            process.kill(-child.pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        };

        const signalProcessTree = (signal: NodeJS.Signals): void => {
          if (runtime.platform !== "win32" && child.pid !== undefined) {
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
          if (settled || killed) return;
          killed = true;
          signalProcessTree("SIGTERM");
          killTimer = setTimeout(() => {
            killTimer = undefined;
            signalProcessTree("SIGKILL");
          }, KILL_GRACE_MS);
        };

        const timeout = setTimeout(terminate, request.timeoutMs);
        timeout.unref();
        const onAbort = (): void => terminate();
        const clearRequestResources = (): void => {
          clearTimeout(timeout);
          request.signal?.removeEventListener("abort", onAbort);
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
        };
        const settle = (result: CommandResult): void => {
          if (settled) return;
          settled = true;
          clearRequestResources();
          resolve(result);
        };
        const waitForProcessGroupExit = async (): Promise<void> => {
          while (!processGroupIsAbsent()) {
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, GROUP_POLL_MS));
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
          if (settled || closing) return;
          settled = true;
          clearRequestResources();
          reject(error);
        });
        child.once("close", (code) => {
          if (settled) return;
          closing = true;
          const result = {
            code: code ?? 1,
            stdout: decodeOutput(stdout),
            stderr: decodeOutput(stderr),
            killed,
            truncated: output.truncated,
          };
          if (!killed || runtime.platform === "win32" || processGroupIsAbsent()) {
            settle(result);
            return;
          }
          void waitForProcessGroupExit().then(() => settle(result), (error: unknown) => {
            if (settled) return;
            settled = true;
            clearRequestResources();
            reject(error);
          });
        });
        if (request.signal?.aborted) terminate();
      });
    },
  };
};
