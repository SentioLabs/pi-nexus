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

test("rejects Git results killed or truncated despite a successful exit code", async () => {
  for (const incomplete of ["killed", "truncated"]) {
    const runner = new FakeRunner(({ args }) => ({
      ...result(""),
      [incomplete]: true,
    }));
    const adapter = createGitAdapter(runner);

    await assert.rejects(adapter.createBranch("feature/complete-result", "main", "/repository"), /incomplete|git command failed/i);
    assert.deepEqual(runner.calls.map(({ args }) => args), [["check-ref-format", "--branch", "feature/complete-result"]]);
  }
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
    if (args.join(" ") === "check-ref-format --branch main") return result("");
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
    {
      executable: "git",
      args: ["check-ref-format", "--branch", "main"],
      cwd: worktreeRootLink,
      signal: controller.signal,
    },
  ]);
});

test("rejects a malformed trunk before accepting the repository identity", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-malformed-trunk-");
  const commonDir = path.join(root, "common");
  const worktreeRoot = path.join(root, "worktree");
  mkdirSync(commonDir);
  mkdirSync(worktreeRoot);
  const runner = new FakeRunner(({ args }) => {
    if (args.at(-1) === "--git-common-dir") return result(`${commonDir}\n`);
    if (args.at(-1) === "--show-toplevel") return result(`${worktreeRoot}\n`);
    if (args.join(" ") === "config --get spice.trunk") return result("main \n");
    if (args[0] === "check-ref-format") return result("");
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });

  await assert.rejects(createGitAdapter(runner).identify(worktreeRoot), /trunk branch/i);
});

test("preserves meaningful path whitespace while removing only the Git line ending", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-line-ending-");
  const commonDir = path.join(root, "common ");
  const worktreeRoot = path.join(root, "worktree ");
  mkdirSync(commonDir);
  mkdirSync(worktreeRoot);
  const runner = new FakeRunner(({ args }) => {
    if (args.at(-1) === "--git-common-dir") return result(`${commonDir}\r\n`);
    if (args.at(-1) === "--show-toplevel") return result(`${worktreeRoot}\n`);
    if (args.join(" ") === "config --get spice.trunk") return result("main\n");
    if (args[0] === "check-ref-format") return result("");
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });

  const identity = await createGitAdapter(runner).identify(worktreeRoot);

  assert.equal(identity.commonDir, commonDir);
  assert.equal(identity.anchorCwd, worktreeRoot);
});

test("rejects malformed or non-directory repository identity output", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-identity-shape-");
  const worktreeRoot = path.join(root, "worktree");
  const notDirectory = path.join(root, "not-a-directory");
  mkdirSync(worktreeRoot);
  writeFileSync(notDirectory, "not a directory\n");

  const malformedLineRunner = new FakeRunner(({ args }) => {
    if (args.at(-1) === "--git-common-dir") return result(`${root}\nextra\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });
  await assert.rejects(createGitAdapter(malformedLineRunner).identify(worktreeRoot), /malformed Git common directory/i);

  const fileRunner = new FakeRunner(({ args }) => {
    if (args.at(-1) === "--git-common-dir") return result(`${notDirectory}\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });
  await assert.rejects(createGitAdapter(fileRunner).identify(worktreeRoot), /non-directory Git common directory/i);
});

test("createBranch verifies the ref and creates it without checkout", async () => {
  const branch = "feature/argv;$(unsafe)";
  const base = "base/with space";
  const startPoint = "0123456789abcdef0123456789abcdef01234567";
  const runner = new FakeRunner(({ args }) => result(args[0] === "rev-parse" ? `${startPoint}\n` : ""));
  const adapter = createGitAdapter(runner);

  await adapter.createBranch(branch, base, "/repository path");

  assert.deepEqual(runner.calls.map(({ executable, args, cwd }) => ({ executable, args, cwd })), [
    {
      executable: "git",
      args: ["check-ref-format", "--branch", branch],
      cwd: "/repository path",
    },
    {
      executable: "git",
      args: ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
      cwd: "/repository path",
    },
    {
      executable: "git",
      args: ["branch", "--", branch, startPoint],
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

test("createBranch rejects malformed bases and verifies an option-like base before branch creation", async () => {
  for (const base of ["", "bad\0base"]) {
    const runner = new FakeRunner(() => result(""));

    await assert.rejects(createGitAdapter(runner).createBranch("feature/valid", base, "/repository"), /base|ref/i);
    assert.deepEqual(runner.calls, []);
  }

  const runner = new FakeRunner(({ args }) => {
    if (args[0] === "check-ref-format") return result("");
    if (args[0] === "rev-parse") return result("0123456789abcdef0123456789abcdef01234567\n");
    if (args[0] === "branch") return result("");
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });

  await createGitAdapter(runner).createBranch("feature/valid", "--option-like", "/repository");

  assert.deepEqual(runner.calls.map(({ args }) => args), [
    ["check-ref-format", "--branch", "feature/valid"],
    ["rev-parse", "--verify", "--end-of-options", "--option-like^{commit}"],
    ["branch", "--", "feature/valid", "0123456789abcdef0123456789abcdef01234567"],
  ]);
});

test("createBranch stops before branch creation when Git cannot verify the base", async () => {
  const runner = new FakeRunner(({ args }) => result("", args[0] === "rev-parse" ? 1 : 0));

  await assert.rejects(createGitAdapter(runner).createBranch("feature/valid", "malformed-base", "/repository"), /incomplete result/i);
  assert.deepEqual(runner.calls.map(({ args }) => args), [
    ["check-ref-format", "--branch", "feature/valid"],
    ["rev-parse", "--verify", "--end-of-options", "malformed-base^{commit}"],
  ]);
});

test("createBranch stops when Git rejects the requested ref", async () => {
  const runner = new FakeRunner(({ args }) => result("", args[0] === "check-ref-format" ? 1 : 0));
  const adapter = createGitAdapter(runner);

  await assert.rejects(adapter.createBranch("feature/rejected", "main", "/repository"), /incomplete result/i);
  assert.deepEqual(runner.calls.map(({ args }) => args), [["check-ref-format", "--branch", "feature/rejected"]]);
});

test("inspectWorktree rejects a malformed HEAD before reading mutable repository state", async () => {
  const runner = new FakeRunner(({ args }) => {
    if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567 extra\n");
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });

  await assert.rejects(createGitAdapter(runner).inspectWorktree("/repository"), /malformed HEAD/i);
  assert.deepEqual(runner.calls.map(({ args }) => args), [["rev-parse", "--verify", "HEAD^{commit}"]]);
});

test("inspectWorktree treats tracked, staged, and whitespace porcelain output as dirty", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-inspect-whitespace-dirty-");
  const gitDir = path.join(root, ".git");
  mkdirSync(gitDir);
  for (const statusOutput of [" \n", " M tracked-file\n", "M  staged-file\n"]) {
    const runner = new FakeRunner(({ args }) => {
      if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567\n");
      if (args[0] === "status") return result(statusOutput);
      if (args.join(" ") === "rev-parse --path-format=absolute --git-dir") return result(`${gitDir}\n`);
      if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${path.join(gitDir, args[2])}\n`);
      throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
    });

    const snapshot = await createGitAdapter(runner).inspectWorktree(root);

    assert.equal(snapshot.dirty, true);
  }
});

test("inspectWorktree reports HEAD and untracked files as dirty", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-inspect-dirty-");
  const gitDir = path.join(root, ".git");
  mkdirSync(gitDir);
  const runner = new FakeRunner(({ args }) => {
    if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567\n");
    if (args[0] === "status") return result("?? untracked-file\n");
    if (args.join(" ") === "rev-parse --path-format=absolute --git-dir") return result(`${gitDir}\n`);
    if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${path.join(gitDir, args[2])}\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });
  const adapter = createGitAdapter(runner);

  const snapshot = await adapter.inspectWorktree(root);

  assert.deepEqual(snapshot, {
    head: "0123456789abcdef0123456789abcdef01234567",
    dirty: true,
    operation: null,
  });
  assert.deepEqual(runner.calls.slice(0, 2).map(({ args }) => args), [
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
  ]);
});

test("inspectWorktree confines relative operation paths after resolving a symlinked worktree cwd", { skip: process.platform === "win32" }, async () => {
  const root = makeTemporaryDirectory("pi-git-spice-symlinked-worktree-");
  const gitDir = path.join(root, ".git");
  const parent = makeTemporaryDirectory("pi-git-spice-symlinked-worktree-parent-");
  const worktreeLink = path.join(parent, "worktree");
  mkdirSync(gitDir);
  symlinkSync(root, worktreeLink, "dir");
  const runner = new FakeRunner(({ args }) => {
    if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567\n");
    if (args[0] === "status") return result("");
    if (args.join(" ") === "rev-parse --path-format=absolute --git-dir") return result(`${gitDir}\n`);
    if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`.git/${args[2]}\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  });

  const snapshot = await createGitAdapter(runner).inspectWorktree(worktreeLink);

  assert.equal(snapshot.operation, null);
});

test("inspectWorktree rejects operation paths outside the Git directory and malformed sentinel shapes", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-operation-path-");
  const gitDir = path.join(root, ".git");
  const outside = makeTemporaryDirectory("pi-git-spice-outside-operation-path-");
  mkdirSync(gitDir);
  const baseResponses = (operationPath) => ({ args }) => {
    if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567\n");
    if (args[0] === "status") return result("");
    if (args.join(" ") === "rev-parse --path-format=absolute --git-dir") return result(`${gitDir}\n`);
    if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${operationPath(args[2])}\n`);
    throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
  };

  await assert.rejects(
    createGitAdapter(new FakeRunner(baseResponses((sentinel) => path.join(outside, sentinel)))).inspectWorktree(root),
    /outside its repository/i,
  );

  writeFileSync(path.join(gitDir, "rebase-merge"), "not a rebase directory\n");
  await assert.rejects(
    createGitAdapter(new FakeRunner(baseResponses((sentinel) => path.join(gitDir, sentinel)))).inspectWorktree(root),
    /malformed rebase operation sentinel/i,
  );
});

test("inspectWorktree detects each interrupted Git-operation sentinel", async () => {
  const sentinels = [
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
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
      if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return result("0123456789abcdef0123456789abcdef01234567\n");
      if (args[0] === "status") return result("");
      if (args.join(" ") === "rev-parse --path-format=absolute --git-dir") return result(`${gitDir}\n`);
      if (args[0] === "rev-parse" && args[1] === "--git-path") return result(`${path.join(gitDir, args[2])}\n`);
      throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
    });

    const snapshot = await createGitAdapter(runner).inspectWorktree(root);

    assert.equal(snapshot.operation, operation);
    assert.equal(snapshot.dirty, false);
    assert.equal(snapshot.head, "0123456789abcdef0123456789abcdef01234567");
  }
});
