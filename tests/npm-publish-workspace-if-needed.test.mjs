import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = new URL("../scripts/npm-publish-workspace-if-needed.mjs", import.meta.url).pathname;
const packageName = "@sentiolabs/example";

function setupWorkspace(version = "1.2.3") {
  const dir = mkdtempSync(join(tmpdir(), "pi-nexus-publish-test-"));
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
    `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nconst callsPath = process.env.FAKE_NPM_CALLS;\nconst packageName = process.env.FAKE_NPM_PACKAGE_NAME;\nconst packageVersion = process.env.FAKE_NPM_PACKAGE_VERSION;\nconst args = process.argv.slice(2);\nappendFileSync(callsPath, JSON.stringify(args) + '\\n');\nif (args[0] === 'view' && args[1] === packageName + '@' + packageVersion) {\n  if (process.env.FAKE_NPM_EXACT_EXISTS === '1') {\n    console.log(JSON.stringify(packageVersion));\n    process.exit(0);\n  }\n  console.error('npm error code E404');\n  console.error('npm error 404 No match found for version ' + packageVersion);\n  process.exit(1);\n}\nif (args[0] === 'view' && args[1] === packageName) {\n  const latest = process.env.FAKE_NPM_LATEST_VERSION;\n  if (latest) {\n    console.log(JSON.stringify(latest));\n    process.exit(0);\n  }\n  console.error('npm error code E404');\n  console.error('npm error 404 package not found');\n  process.exit(1);\n}\nif (args[0] === 'publish') {\n  process.exit(0);\n}\nprocess.exit(99);\n`,
  );
  chmodSync(fakeNpmPath, 0o755);

  return { dir, callsPath, fakeNpmPath, version };
}

function runScript({ dir, callsPath, fakeNpmPath, version }, options = {}) {
  return spawnSync(process.execPath, [scriptPath, packageName, ...(options.extraArgs ?? [])], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_NPM_CALLS: callsPath,
      FAKE_NPM_EXACT_EXISTS: options.exactExists ? "1" : "0",
      FAKE_NPM_LATEST_VERSION: options.latestVersion ?? "",
      FAKE_NPM_PACKAGE_NAME: packageName,
      FAKE_NPM_PACKAGE_VERSION: version,
      NPM_PUBLISH_IF_NEEDED_NPM: fakeNpmPath,
    },
  });
}

function readCalls(callsPath) {
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

test("publish helper publishes workspace package versions missing from npm", () => {
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
