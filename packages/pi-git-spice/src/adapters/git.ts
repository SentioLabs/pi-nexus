import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { RepositoryIdentity } from "../core/contracts.ts";
import type { CommandResult, CommandRunner, GitAdapter } from "../core/ports.ts";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const requireSuccess = (result: CommandResult): void => {
  if (result.code !== 0 || result.killed || result.truncated) {
    throw new Error("Git command returned an incomplete result");
  }
};

const removeProtocolLineEnding = (output: string, label: string): string => {
  if (!output.endsWith("\n")) throw new Error(`Git returned malformed ${label}`);
  const line = output.slice(0, -1);
  const value = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`Git returned malformed ${label}`);
  }
  return value;
};

const isWithin = (candidate: string, directory: string): boolean => {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const normalizeDirectory = async (reportedPath: string, label: string): Promise<string> => {
  if (!path.isAbsolute(reportedPath)) throw new Error(`Git returned a non-absolute ${label}`);
  const normalizedPath = await realpath(reportedPath);
  if (!(await stat(normalizedPath)).isDirectory()) throw new Error(`Git returned a non-directory ${label}`);
  return normalizedPath;
};

const validateBranch = (branch: string, label: string): void => {
  if (
    branch.length === 0 ||
    branch.includes("\0") ||
    branch.startsWith("-") ||
    branch === "@" ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20~^:?*\[\\]/.test(branch) ||
    branch.endsWith(".") ||
    branch.split("/").some((component) => component.length === 0 || component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new Error(`${label} is malformed`);
  }
};

const validateObjectId = (objectId: string, label: string): void => {
  if (!OBJECT_ID.test(objectId)) throw new Error(`Git returned a malformed ${label}`);
};

const statIfPresent = async (target: string) => {
  try {
    return await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const createGitAdapter = (runner: CommandRunner): GitAdapter => {
  const runGit = async (args: readonly string[], cwd: string, signal?: AbortSignal): Promise<CommandResult> => {
    const result = await runner.run({
      executable: "git",
      args,
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    requireSuccess(result);
    return result;
  };

  const runGitLine = async (args: readonly string[], cwd: string, label: string, signal?: AbortSignal): Promise<string> =>
    removeProtocolLineEnding((await runGit(args, cwd, signal)).stdout, label);

  const runGitObject = async (args: readonly string[], cwd: string, label: string, signal?: AbortSignal): Promise<string> => {
    const objectId = await runGitLine(args, cwd, label, signal);
    validateObjectId(objectId, label);
    return objectId;
  };

  const gitDirectory = async (cwd: string, signal?: AbortSignal): Promise<string> =>
    normalizeDirectory(
      await runGitLine(["rev-parse", "--path-format=absolute", "--git-dir"], cwd, "Git directory", signal),
      "Git directory",
    );

  const operationPath = async (name: string, cwd: string, gitDir: string, signal?: AbortSignal): Promise<string> => {
    const reportedPath = await runGitLine(["rev-parse", "--git-path", name], cwd, "operation path", signal);
    const candidate = path.resolve(await realpath(cwd), reportedPath);
    if (path.basename(candidate) !== name || !isWithin(candidate, gitDir)) {
      throw new Error("Git returned an operation path outside its repository");
    }
    if ((await realpath(path.dirname(candidate))) !== gitDir) {
      throw new Error("Git returned an operation path outside its repository");
    }
    return candidate;
  };

  const operationAt = async (cwd: string, signal?: AbortSignal): Promise<"rebase" | "merge" | "cherry-pick" | "revert" | null> => {
    const gitDir = await gitDirectory(cwd, signal);
    for (const [operation, sentinels] of [
      ["rebase", ["rebase-merge", "rebase-apply"]],
      ["merge", ["MERGE_HEAD"]],
      ["cherry-pick", ["CHERRY_PICK_HEAD"]],
      ["revert", ["REVERT_HEAD"]],
    ] as const) {
      for (const sentinel of sentinels) {
        const sentinelStats = await statIfPresent(await operationPath(sentinel, cwd, gitDir, signal));
        if (sentinelStats === null) continue;
        if ((operation === "rebase" && !sentinelStats.isDirectory()) || (operation !== "rebase" && !sentinelStats.isFile())) {
          throw new Error(`Git returned a malformed ${operation} operation sentinel`);
        }
        return operation;
      }
    }
    return null;
  };

  return {
    async identify(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
      const commonDir = await normalizeDirectory(
        await runGitLine(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, "Git common directory", signal),
        "Git common directory",
      );
      const anchorCwd = await normalizeDirectory(
        await runGitLine(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd, "worktree root", signal),
        "worktree root",
      );
      const trunk = await runGitLine(["config", "--get", "spice.trunk"], cwd, "trunk branch", signal);
      validateBranch(trunk, "Trunk branch");
      await runGit(["check-ref-format", "--branch", trunk], cwd, signal);
      return {
        key: createHash("sha256").update(commonDir).digest("hex"),
        commonDir,
        anchorCwd,
        trunk,
      };
    },

    async createBranch(branch: string, base: string, cwd: string, signal?: AbortSignal): Promise<void> {
      validateBranch(branch, "Branch name");
      validateBranch(base, "Base ref");
      await runGit(["check-ref-format", "--branch", branch], cwd, signal);
      await runGit(["check-ref-format", "--branch", base], cwd, signal);
      const startPoint = await runGitObject(
        ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
        cwd,
        "branch start point",
        signal,
      );
      await runGit(["branch", "--", branch, startPoint], cwd, signal);
    },

    async inspectWorktree(pathname: string, signal?: AbortSignal) {
      const head = await runGitObject(["rev-parse", "--verify", "HEAD^{commit}"], pathname, "HEAD", signal);
      const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], pathname, signal);
      return {
        head,
        dirty: status.stdout.length > 0,
        operation: await operationAt(pathname, signal),
      };
    },
  };
};
