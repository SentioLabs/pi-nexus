import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { createGitAdapter } = await import("../src/adapters/git.ts");

const temporaryRoots = new Set();

const makeTemporaryDirectory = (prefix) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
};

const result = (stdout, code = 0, stderr = "") => ({
  code,
  stdout,
  stderr,
  killed: false,
  truncated: false,
});

class FakeRunner {
  constructor(respond) {
    this.calls = [];
    this.respond = respond;
  }

  async run(request) {
    this.calls.push(request);
    return this.respond(request);
  }
}

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("identify normalizes real repository paths and creates a stable common-dir key", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-identify-");
  const commonDir = path.join(root, "actual-common");
  const worktreeRoot = path.join(root, "actual-worktree");
  const commonDirLink = path.join(root, "common-link");
  const worktreeRootLink = path.join(root, "worktree-link");
  mkdirSync(commonDir);
  mkdirSync(worktreeRoot);
  symlinkSync(commonDir, commonDirLink, "dir");
  symlinkSync(worktreeRoot, worktreeRootLink, "dir");
  const controller = new AbortController();
  const runner = new FakeRunner(({ args }) => {
    if (args.at(-1) === "--git-common-dir") return result(`${commonDirLink}\n`);
    if (args.at(-1) === "--show-toplevel") return result(`${worktreeRootLink}\n`);
    if (args.join(" ") === "config --get spice.trunk") return result("main\n");
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });
  const adapter = createGitAdapter(runner);

  const identity = await adapter.identify(worktreeRootLink, controller.signal);

  assert.deepEqual(identity, {
    key: createHash("sha256").update(commonDir).digest("hex"),
    commonDir,
    anchorCwd: worktreeRoot,
    trunk: "main",
  });
  assert.deepEqual(runner.calls.map(({ executable, args, cwd, signal }) => ({ executable, args, cwd, signal })), [
    {
      executable: "git",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: worktreeRootLink,
      signal: controller.signal,
    },
    {
      executable: "git",
      args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      cwd: worktreeRootLink,
      signal: controller.signal,
    },
    {
      executable: "git",
      args: ["config", "--get", "spice.trunk"],
      cwd: worktreeRootLink,
      signal: controller.signal,
    },
  ]);
});

test("createBranch verifies the ref and creates it without checkout", async () => {
  const runner = new FakeRunner(() => result(""));
  const adapter = createGitAdapter(runner);
  const branch = "feature/argv;$(unsafe)";
  const base = "base/with space";

  await adapter.createBranch(branch, base, "/repository path");

  assert.deepEqual(runner.calls.map(({ executable, args, cwd }) => ({ executable, args, cwd })), [
    {
      executable: "git",
      args: ["check-ref-format", "--branch", branch],
      cwd: "/repository path",
    },
    {
      executable: "git",
      args: ["branch", branch, base],
      cwd: "/repository path",
    },
  ]);
  assert.equal(runner.calls.some(({ args }) => args.includes("checkout") || args.includes("switch")), false);
});

test("createBranch rejects empty or NUL branch names before running Git", async () => {
  for (const branch of ["", "bad\0branch"]) {
    const runner = new FakeRunner(() => result(""));
    const adapter = createGitAdapter(runner);

    await assert.rejects(adapter.createBranch(branch, "main", "/repository"), /branch/i);
    assert.deepEqual(runner.calls, []);
  }
});

test("createBranch stops when Git rejects the requested ref", async () => {
  const runner = new FakeRunner(({ args }) => result("", args[0] === "check-ref-format" ? 1 : 0));
  const adapter = createGitAdapter(runner);

  await assert.rejects(adapter.createBranch("feature/rejected", "main", "/repository"), /git command failed/i);
  assert.deepEqual(runner.calls.map(({ args }) => args), [["check-ref-format", "--branch", "feature/rejected"]]);
});

test("inspectWorktree reports HEAD and untracked files as dirty", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-inspect-dirty-");
  const gitDir = path.join(root, ".git");
  mkdirSync(gitDir);
  const runner = new FakeRunner(({ args }) => {
    if (args.join(" ") === "rev-parse HEAD") return result("0123456789abcdef\n");
    if (args[0] === "status") return result("?? untracked-file\n");
    if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${path.join(gitDir, args[2])}\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });
  const adapter = createGitAdapter(runner);

  const snapshot = await adapter.inspectWorktree(root);

  assert.deepEqual(snapshot, {
    head: "0123456789abcdef",
    dirty: true,
    operation: null,
  });
  assert.deepEqual(runner.calls.slice(0, 2).map(({ args }) => args), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
  ]);
});

test("inspectWorktree detects each interrupted Git-operation sentinel", async () => {
  const sentinels = [
    ["rebase", "rebase-merge"],
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ];

  for (const [operation, sentinel] of sentinels) {
    const root = makeTemporaryDirectory(`pi-git-spice-${operation}-`);
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir);
    const sentinelPath = path.join(gitDir, sentinel);
    if (operation === "rebase") mkdirSync(sentinelPath);
    else writeFileSync(sentinelPath, "in progress\n");
    const runner = new FakeRunner(({ args }) => {
      if (args.join(" ") === "rev-parse HEAD") return result("head\n");
      if (args[0] === "status") return result("");
      if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${path.join(gitDir, args[2])}\n`);
      throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
    });

    const snapshot = await createGitAdapter(runner).inspectWorktree(root);

    assert.equal(snapshot.operation, operation);
    assert.equal(snapshot.dirty, false);
    assert.equal(snapshot.head, "head");
  }
});
