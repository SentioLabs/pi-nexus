import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { createCommandRunner } = await import("../src/adapters/command-runner.ts");

const temporaryRoots = new Set();

const makeTemporaryDirectory = (prefix) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
};

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for child process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const childTreeProgram = (pidFile) => [
  "const { spawn } = require('node:child_process');",
  "const { writeFileSync } = require('node:fs');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
  `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
  "process.on('SIGTERM', () => {});",
  "setInterval(() => {}, 1_000);",
].join("\n");

const assertProcessExited = async (pid) => {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
};

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

test("passes adversarial argv literally without a shell", async () => {
  const runner = createCommandRunner();
  const argument = "literal; echo shell-executed";

  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", argument],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });

  assert.deepEqual(result, {
    code: 0,
    stdout: argument,
    stderr: "",
    killed: false,
    truncated: false,
  });
});

test("caps stdout and stderr together by bytes", async () => {
  const runner = createCommandRunner();

  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('abcde'); setTimeout(() => process.stderr.write('fghij'), 50)"],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 7,
  });

  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 7);
  assert.equal(`${result.stdout}${result.stderr}`, "abcdefg");
  assert.equal(result.truncated, true);
});

test("does byte accounting before decoding output", async () => {
  const runner = createCommandRunner();

  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('é')"],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 1,
  });

  assert.equal(result.stdout, "");
  assert.equal(result.truncated, true);
});

test("timeout terminates the Unix process group", { skip: process.platform === "win32" }, async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-timeout-");
  const pidFile = path.join(root, "child.pid");
  const runner = createCommandRunner();

  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", childTreeProgram(pidFile)],
    cwd: root,
    timeoutMs: 100,
    maxOutputBytes: 1_024,
  });

  assert.equal(result.killed, true);
  assert.equal(result.truncated, false);
  await waitFor(() => existsSync(pidFile));
  await assertProcessExited(Number(readFileSync(pidFile, "utf8")));
});

test("continues escalation after the group leader exits following termination", { skip: process.platform === "win32" }, async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-escalation-");
  const pidFile = path.join(root, "child.pid");
  const program = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)\"], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const runner = createCommandRunner();

  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", program],
    cwd: root,
    timeoutMs: 100,
    maxOutputBytes: 1_024,
  });

  assert.equal(result.killed, true);
  await waitFor(() => existsSync(pidFile));
  await assertProcessExited(Number(readFileSync(pidFile, "utf8")));
});

test("AbortSignal terminates the Unix process group", { skip: process.platform === "win32" }, async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-abort-");
  const pidFile = path.join(root, "child.pid");
  const controller = new AbortController();
  const runner = createCommandRunner();

  const resultPromise = runner.run({
    executable: process.execPath,
    args: ["-e", childTreeProgram(pidFile)],
    cwd: root,
    signal: controller.signal,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  await waitFor(() => existsSync(pidFile));
  controller.abort();

  const result = await resultPromise;
  assert.equal(result.killed, true);
  await assertProcessExited(Number(readFileSync(pidFile, "utf8")));
});

test("rejects a parent repository executable from a nested repository cwd", async () => {
  const outer = makeTemporaryDirectory("pi-git-spice-runner-nested-repository-");
  const inner = path.join(outer, "nested");
  const executable = "outer-repository-fake";
  mkdirSync(path.join(outer, ".git"));
  mkdirSync(inner);
  mkdirSync(path.join(inner, ".git"));
  writeFileSync(path.join(outer, executable), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = outer;

  try {
    await assert.rejects(
      createCommandRunner().run({
        executable,
        args: [],
        cwd: inner,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
      /repository-local|trusted executable/i,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("rejects a repository-local executable resolved through a relative PATH entry", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-relative-path-");
  const executable = "relative-repository-fake";
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, executable), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = ".";

  try {
    await assert.rejects(
      createCommandRunner().run({
        executable,
        args: [],
        cwd: root,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
      /repository-local/i,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("rejects repository-local absolute and symlinked executable candidates", { skip: process.platform === "win32" }, async () => {
  const outer = makeTemporaryDirectory("pi-git-spice-runner-linked-repository-");
  const inner = path.join(outer, "nested");
  const external = makeTemporaryDirectory("pi-git-spice-runner-external-link-");
  const executable = "linked-repository-fake";
  const repositoryExecutable = path.join(outer, executable);
  mkdirSync(path.join(outer, ".git"));
  mkdirSync(inner);
  mkdirSync(path.join(inner, ".git"));
  writeFileSync(repositoryExecutable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  symlinkSync(repositoryExecutable, path.join(external, executable));

  await assert.rejects(
    createCommandRunner().run({
      executable: repositoryExecutable,
      args: [],
      cwd: inner,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }),
    /repository-local/i,
  );

  const originalPath = process.env.PATH;
  process.env.PATH = external;
  try {
    await assert.rejects(
      createCommandRunner().run({
        executable,
        args: [],
        cwd: inner,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
      /repository-local/i,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("marks an already-aborted request as killed", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await createCommandRunner().run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1_000)"],
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });

  assert.equal(result.killed, true);
});

test("settles close races without a later timeout termination", async () => {
  const runner = createCommandRunner();
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 20)"],
    cwd: process.cwd(),
    timeoutMs: 100,
    maxOutputBytes: 1_024,
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(result.killed, false);
  assert.equal(result.code, 0);
});

test("handles concurrent abort and timeout termination without leaving the process group", { skip: process.platform === "win32" }, async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-abort-timeout-race-");
  const pidFile = path.join(root, "child.pid");
  const controller = new AbortController();
  const resultPromise = createCommandRunner().run({
    executable: process.execPath,
    args: ["-e", childTreeProgram(pidFile)],
    cwd: root,
    signal: controller.signal,
    timeoutMs: 50,
    maxOutputBytes: 1_024,
  });
  setTimeout(() => controller.abort(), 50);

  const result = await resultPromise;
  assert.equal(result.killed, true);
  await waitFor(() => existsSync(pidFile));
  await assertProcessExited(Number(readFileSync(pidFile, "utf8")));
});

test("rejects a repository-local executable during trusted-binary resolution", async () => {
  const root = makeTemporaryDirectory("pi-git-spice-runner-untrusted-");
  const executable = "repository-local-fake";
  const fakePath = path.join(root, executable);
  writeFileSync(fakePath, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = root;
  const runner = createCommandRunner();

  try {
    await assert.rejects(
      runner.run({
        executable,
        args: [],
        cwd: root,
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
      }),
      /trusted executable/i,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
