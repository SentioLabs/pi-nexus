import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const scriptPath = new URL("../scripts/npm-publish-workspace-if-needed.mjs", import.meta.url).pathname;
const packageName = "@sentiolabs/example";

function setupWorkspace(version = "1.2.3") {
  const dir = mkdtempSync(join(tmpdir(), "pi-nexus-publish-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "packages", "example"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }, null, 2),
  );
  writeFileSync(
    join(dir, "packages", "example", "package.json"),
    JSON.stringify({ name: packageName, version }, null, 2),
  );

  const callsPath = join(dir, "npm-calls.jsonl");
  const fakeNpmPath = join(dir, "fake-npm.mjs");
  writeFileSync(
    fakeNpmPath,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const callsPath = process.env.FAKE_NPM_CALLS;
const packageName = process.env.FAKE_NPM_PACKAGE_NAME;
const packageVersion = process.env.FAKE_NPM_PACKAGE_VERSION;
const args = process.argv.slice(2);
const calls = existsSync(callsPath)
  ? readFileSync(callsPath, 'utf8').trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
appendFileSync(callsPath, JSON.stringify(args) + '\\n');
if (args[0] === 'view' && args[1] === packageName + '@' + packageVersion) {
  const publishIndex = calls.findLastIndex((call) => call[0] === 'publish');
  if (publishIndex !== -1) {
    if (process.env.FAKE_NPM_VISIBILITY_ERROR) {
      console.log('visibility error stdout');
      console.error('npm error code ' + process.env.FAKE_NPM_VISIBILITY_ERROR);
      process.exit(7);
    }
    const previousChecks = calls.slice(publishIndex + 1).filter((call) => call[0] === 'view').length;
    if (previousChecks >= Number(process.env.FAKE_NPM_VISIBILITY_MISSES)) {
      console.log(JSON.stringify(packageVersion));
      process.exit(0);
    }
    console.error(process.env.FAKE_NPM_VISIBILITY_NOT_FOUND);
    process.exit(1);
  }
  if (process.env.FAKE_NPM_EXACT_EXISTS === '1') {
    console.log(JSON.stringify(packageVersion));
    process.exit(0);
  }
  console.error('npm error code E404');
  console.error('npm error 404 No match found for version ' + packageVersion);
  process.exit(1);
}
if (args[0] === 'view' && args[1] === packageName) {
  const latest = process.env.FAKE_NPM_LATEST_VERSION;
  if (latest) {
    console.log(JSON.stringify(latest));
    process.exit(0);
  }
  console.error('npm error code E404');
  console.error('npm error 404 package not found');
  process.exit(1);
}
if (args[0] === 'publish') {
  process.exit(Number(process.env.FAKE_NPM_PUBLISH_EXIT));
}
process.exit(99);
`,
  );
  chmodSync(fakeNpmPath, 0o755);

  return { dir, callsPath, fakeNpmPath, version };
}

function runScript({ dir, callsPath, fakeNpmPath, version }, options = {}) {
  return spawnSync(process.execPath, [scriptPath, packageName, ...(options.extraArgs ?? [])], {
    cwd: dir,
    encoding: "utf8",
    timeout: options.timeout ?? 10_000,
    env: {
      ...process.env,
      FAKE_NPM_CALLS: callsPath,
      FAKE_NPM_EXACT_EXISTS: options.exactExists ? "1" : "0",
      FAKE_NPM_LATEST_VERSION: options.latestVersion ?? "",
      FAKE_NPM_PACKAGE_NAME: packageName,
      FAKE_NPM_PACKAGE_VERSION: version,
      FAKE_NPM_VISIBILITY_MISSES: String(options.visibilityMisses ?? 0),
      FAKE_NPM_VISIBILITY_ERROR: options.visibilityError ?? "",
      FAKE_NPM_VISIBILITY_NOT_FOUND: options.visibilityNotFound ?? "npm error code E404",
      FAKE_NPM_PUBLISH_EXIT: String(options.publishExit ?? 0),
      NPM_PUBLISH_VERIFY_ATTEMPTS: "3",
      NPM_PUBLISH_VERIFY_DELAY_MS: "1",
      ...options.verifyEnv,
      NPM_PUBLISH_IF_NEEDED_NPM: fakeNpmPath,
    },
  });
}

function readCalls(callsPath) {
  if (!existsSync(callsPath)) return [];
  return readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("publish helper skips workspace package versions already on npm", () => {
  const workspace = setupWorkspace();

  const result = runScript(workspace, { exactExists: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already published/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ["view", "@sentiolabs/example@1.2.3", "version", "--json"],
  ]);
});

test("publish helper dry-run skips post-publish visibility checks", () => {
  const workspace = setupWorkspace();

  const result = runScript(workspace, { latestVersion: "1.2.2", extraArgs: ["--dry-run"] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not published yet/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ["view", "@sentiolabs/example@1.2.3", "version", "--json"],
    ["view", "@sentiolabs/example", "version", "--json"],
    ["publish", "--workspace", "@sentiolabs/example", "--access", "public", "--provenance", "--dry-run"],
  ]);
});

test("publish helper refuses to move npm latest backwards", () => {
  const workspace = setupWorkspace();

  const result = runScript(workspace, { latestVersion: "1.3.0", extraArgs: ["--dry-run"] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to publish/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ["view", "@sentiolabs/example@1.2.3", "version", "--json"],
    ["view", "@sentiolabs/example", "version", "--json"],
  ]);
});

test("publish helper treats stable same-core versions as newer than prereleases", () => {
  const workspace = setupWorkspace("1.2.3-beta.1");

  const result = runScript(workspace, { latestVersion: "1.2.3", extraArgs: ["--dry-run"] });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /prerelease/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ["view", "@sentiolabs/example@1.2.3-beta.1", "version", "--json"],
  ]);
});

test("publish helper allows prereleases with an explicit non-latest dist-tag", () => {
  const workspace = setupWorkspace("1.2.3-beta.1");

  const result = runScript(workspace, { latestVersion: "1.2.3", extraArgs: ["--tag", "next", "--dry-run"] });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not published yet/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ["view", "@sentiolabs/example@1.2.3-beta.1", "version", "--json"],
    ["publish", "--workspace", "@sentiolabs/example", "--access", "public", "--provenance", "--tag", "next", "--dry-run"],
  ]);
});

function expectedPublishCalls(version = "1.2.3", extraArgs = []) {
  return [
    ["view", `${packageName}@${version}`, "version", "--json"],
    ["view", packageName, "version", "--json"],
    ["publish", "--workspace", packageName, "--access", "public", "--provenance", ...extraArgs],
  ];
}

for (const visibilityMisses of [0, 1, 2]) {
  test(`publish helper confirms visibility after ${visibilityMisses} exact-version misses`, () => {
    const workspace = setupWorkspace();
    const result = runScript(workspace, { latestVersion: "1.2.2", visibilityMisses });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /@sentiolabs\/example@1\.2\.3.*visible/);
    assert.deepEqual(readCalls(workspace.callsPath), [
      ...expectedPublishCalls(),
      ...Array.from({ length: visibilityMisses + 1 }, () => ["view", `${packageName}@1.2.3`, "version", "--json"]),
    ]);
  });
}

for (const visibilityNotFound of ["npm error code E404", "404 Not Found", "No match found for version 1.2.3"]) {
  test(`publish helper fails after the final visibility attempt for ${visibilityNotFound}`, () => {
    const workspace = setupWorkspace();
    const result = runScript(workspace, { visibilityMisses: 3, visibilityNotFound });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /@sentiolabs\/example@1\.2\.3.*not visible.*3 attempts/);
    assert.deepEqual(readCalls(workspace.callsPath), [
      ...expectedPublishCalls(),
      ...Array.from({ length: 3 }, () => ["view", `${packageName}@1.2.3`, "version", "--json"]),
    ]);
  });
}

test("publish helper forwards non-404 visibility errors and fails without retrying", () => {
  const workspace = setupWorkspace();
  const result = runScript(workspace, { visibilityError: "E401" });

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /visibility error stdout/);
  assert.match(result.stderr, /npm error code E401/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ...expectedPublishCalls(),
    ["view", `${packageName}@1.2.3`, "version", "--json"],
  ]);
});

test("publish helper does not check visibility after a failed publish", () => {
  const workspace = setupWorkspace();
  const result = runScript(workspace, { publishExit: 9 });

  assert.equal(result.status, 9, result.stderr);
  assert.deepEqual(readCalls(workspace.callsPath), expectedPublishCalls());
});

test("publish helper preserves a failed dry-run exit status without checking visibility", () => {
  const workspace = setupWorkspace();
  const result = runScript(workspace, { publishExit: 9, extraArgs: ["--dry-run"] });

  assert.equal(result.status, 9, result.stderr);
  assert.deepEqual(readCalls(workspace.callsPath), expectedPublishCalls("1.2.3", ["--dry-run"]));
});

for (const name of ["NPM_PUBLISH_VERIFY_ATTEMPTS", "NPM_PUBLISH_VERIFY_DELAY_MS"]) {
  for (const value of ["", "0", "-1", "1.5", "nope", "2ms", "1e2", "0x10", " 2", "2 ", "2\n", "Infinity", "9007199254740992"]) {
    test(`publish helper rejects ${name}=${JSON.stringify(value)} before publishing`, () => {
      const workspace = setupWorkspace();
      const result = runScript(workspace, { verifyEnv: { [name]: value } });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`${name}.*positive base-10 integer`));
      assert.equal(readCalls(workspace.callsPath).some((call) => call[0] === "publish"), false);
    });
  }
}

test("publish helper accepts positive base-10 verification overrides", () => {
  const workspace = setupWorkspace();
  const result = runScript(workspace, {
    visibilityMisses: 3,
    verifyEnv: { NPM_PUBLISH_VERIFY_ATTEMPTS: "04", NPM_PUBLISH_VERIFY_DELAY_MS: "01" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@sentiolabs\/example@1\.2\.3.*visible/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ...expectedPublishCalls(),
    ...Array.from({ length: 4 }, () => ["view", `${packageName}@1.2.3`, "version", "--json"]),
  ]);
});

for (const delayMs of [undefined, "2000", "2147483648"]) {
  test(`publish helper waits between visibility attempts with delay ${delayMs ?? "default"} without timer overflow`, () => {
    const workspace = setupWorkspace();
    const result = runScript(workspace, {
      visibilityMisses: 1,
      timeout: 1000,
      verifyEnv: { NPM_PUBLISH_VERIFY_DELAY_MS: delayMs },
    });

    assert.equal(result.error?.code, "ETIMEDOUT", result.stderr);
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
    assert.deepEqual(readCalls(workspace.callsPath), [
      ...expectedPublishCalls(),
      ["view", `${packageName}@1.2.3`, "version", "--json"],
    ]);
  });
}

test("publish helper defaults to 24 bounded visibility attempts", () => {
  const workspace = setupWorkspace();
  const result = runScript(workspace, {
    visibilityMisses: 24,
    verifyEnv: { NPM_PUBLISH_VERIFY_ATTEMPTS: undefined },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /@sentiolabs\/example@1\.2\.3.*not visible.*24 attempts/);
  assert.deepEqual(readCalls(workspace.callsPath), [
    ...expectedPublishCalls(),
    ...Array.from({ length: 24 }, () => ["view", `${packageName}@1.2.3`, "version", "--json"]),
  ]);
});
