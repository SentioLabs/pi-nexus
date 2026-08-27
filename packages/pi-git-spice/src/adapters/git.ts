import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { RepositoryIdentity } from "../core/contracts.ts";
import type { CommandResult, CommandRunner, GitAdapter } from "../core/ports.ts";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

const requireSuccess = (result: CommandResult): string => {
  if (result.code !== 0) throw new Error(`Git command failed with exit code ${result.code}`);
  return result.stdout.trim();
};

const isPresent = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const validateBranch = (branch: string): void => {
  if (branch.length === 0 || branch.includes("\0")) throw new Error("Branch name must not be empty or contain NUL");
};

export const createGitAdapter = (runner: CommandRunner): GitAdapter => {
  const runGit = async (args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> => {
    const result = await runner.run({
      executable: "git",
      args,
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    return requireSuccess(result);
  };

  const gitPath = async (name: string, cwd: string, signal?: AbortSignal): Promise<string> => {
    const reportedPath = await runGit(["rev-parse", "--git-path", name], cwd, signal);
    return path.resolve(cwd, reportedPath);
  };

  const operationAt = async (cwd: string, signal?: AbortSignal): Promise<"rebase" | "merge" | "cherry-pick" | "revert" | null> => {
    for (const [operation, sentinels] of [
      ["rebase", ["rebase-merge", "rebase-apply"]],
      ["merge", ["MERGE_HEAD"]],
      ["cherry-pick", ["CHERRY_PICK_HEAD"]],
      ["revert", ["REVERT_HEAD"]],
    ] as const) {
      for (const sentinel of sentinels) {
        if (await isPresent(await gitPath(sentinel, cwd, signal))) return operation;
      }
    }
    return null;
  };

  return {
    async identify(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
      const commonDir = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, signal);
      const anchorCwd = await runGit(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd, signal);
      const trunk = await runGit(["config", "--get", "spice.trunk"], cwd, signal);
      if (!path.isAbsolute(commonDir) || !path.isAbsolute(anchorCwd) || trunk.length === 0) {
        throw new Error("Git returned an incomplete repository identity");
      }
      const normalizedCommonDir = await realpath(commonDir);
      const normalizedAnchorCwd = await realpath(anchorCwd);
      return {
        key: createHash("sha256").update(normalizedCommonDir).digest("hex"),
        commonDir: normalizedCommonDir,
        anchorCwd: normalizedAnchorCwd,
        trunk,
      };
    },

    async createBranch(branch: string, base: string, cwd: string, signal?: AbortSignal): Promise<void> {
      validateBranch(branch);
      await runGit(["check-ref-format", "--branch", branch], cwd, signal);
      await runGit(["branch", branch, base], cwd, signal);
    },

    async inspectWorktree(pathname: string, signal?: AbortSignal) {
      const head = await runGit(["rev-parse", "HEAD"], pathname, signal);
      const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], pathname, signal);
      return {
        head,
        dirty: status.length > 0,
        operation: await operationAt(pathname, signal),
      };
    },
  };
};
