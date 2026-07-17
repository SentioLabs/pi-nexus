import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-code-quality-plugin.py");

test("migration CLI exposes positional and option source forms", () => {
  const help = execFileSync("python3", [migrationScript, "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.match(help, /Regenerate pi-code-quality resources/);
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
});

test("invalid source fails before rewriting package resources", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-source-"));
  const protectedPath = path.join(packageRoot, "prompts/code-quality-slop.md");
  const before = readFileSync(protectedPath, "utf8");
  try {
    mkdirSync(path.join(fixture, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(fixture, ".claude-plugin/plugin.json"), "{}\n");
    const result = spawnSync("python3", [migrationScript, fixture], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing expected paths/);
    assert.equal(readFileSync(protectedPath, "utf8"), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
