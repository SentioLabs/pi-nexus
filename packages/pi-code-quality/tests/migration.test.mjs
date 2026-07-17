import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const sourceRoot = "/home/bfirestone/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/code-quality";

test("migration succeeds in a temporary package copy without stale or Claude-specific resources", () => {
  assert.ok(existsSync(sourceRoot), `source fixture should exist: ${sourceRoot}`);

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pi-code-quality-package-"));
  const copiedPackage = path.join(tempRoot, "pi-code-quality");
  try {
    execFileSync("cp", ["-a", packageRoot, copiedPackage]);
    const output = execFileSync(
      "python3",
      [path.join(copiedPackage, "scripts/migrate-code-quality-plugin.py"), sourceRoot],
      { cwd: copiedPackage, encoding: "utf8" },
    );

    assert.match(output, new RegExp(`Migrated code-quality plugin from: ${sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(existsSync(path.join(copiedPackage, "prompts/code-quality-review.md")));
    assert.ok(existsSync(path.join(copiedPackage, "prompts/code-quality-size.md")));
    assert.ok(existsSync(path.join(copiedPackage, "skills/deep-review/references/output-actions.md")));
    assert.ok(existsSync(path.join(copiedPackage, "skills/size-review/references/default-exclusions.md")));
    assert.ok(!existsSync(path.join(copiedPackage, "prompts/code-quality-slop.md")));
    assert.ok(!existsSync(path.join(copiedPackage, "skills/slop-review")));

    const forbidden = spawnSync(
      "rg",
      [
        String.raw`\$\{CLAUDE_PLUGIN_ROOT\}|AskUserQuestion|/code-quality:|model: "(fable|opus|sonnet)"|CLAUDE_(DEEP|SIZE)_REVIEW|\.code-quality/slop-acceptances\.md`,
        path.join(copiedPackage, "skills"),
        path.join(copiedPackage, "prompts"),
      ],
      { cwd: copiedPackage, encoding: "utf8" },
    );
    assert.equal(forbidden.status, 1, forbidden.stdout + forbidden.stderr);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
