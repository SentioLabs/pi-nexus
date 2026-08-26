import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = fileURLToPath(
  new URL("../scripts/migrate-review-responder-plugin.py", import.meta.url),
);
const canonicalSource =
  "/home/bfirestone/devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/review-responder";
const sourceSkill = gunzipSync(Buffer.from("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", "base64")).toString("utf8");
const validPlugin = {
  name: "review-responder",
  description: "Review comments safely.",
  version: "0.2.0",
  author: { name: "Test Author", url: "https://example.com/author" },
  repository: "https://example.com/repository",
  license: "MIT",
  homepage: "https://example.com/review-responder",
  keywords: ["code-review", "github"],
};

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "pi-review-responder-test-"));
}

function writeSource(root, { skill = sourceSkill, plugin = validPlugin, omit = [], extra } = {}) {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  const files = new Map([
    ["SKILL.md", skill],
    [".claude-plugin/plugin.json", typeof plugin === "string" ? plugin : `${JSON.stringify(plugin, null, 2)}\n`],
    ["README.md", "# Source readme\n"],
    ["CHANGELOG.md", "# Source changelog\n"],
    ["version.txt", "0.2.0\n"],
  ]);
  for (const [relative, contents] of files) {
    if (!omit.includes(relative)) {
      const target = join(root, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents);
    }
  }
  if (extra) {
    const target = join(root, extra);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "unclassified\n");
  }
}

function makePackage(root, original = "original skill bytes\n") {
  const packageCopy = join(root, "package");
  mkdirSync(join(packageCopy, "scripts"), { recursive: true });
  mkdirSync(join(packageCopy, "skills", "review-responder"), { recursive: true });
  cpSync(migrationScript, join(packageCopy, "scripts", "migrate-review-responder-plugin.py"));
  writeFileSync(join(packageCopy, "skills", "review-responder", "SKILL.md"), original);
  return packageCopy;
}

function runMigration(packageCopy, args, env = {}) {
  return spawnSync(
    "python3",
    [join(packageCopy, "scripts", "migrate-review-responder-plugin.py"), ...args],
    {
      cwd: packageCopy,
      encoding: "utf8",
      env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
}

function assertPatternsInOrder(text, patterns, context) {
  let offset = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(offset));
    assert.notEqual(match, null, `${context}: missing ordered pattern ${pattern}`);
    offset += match.index + match[0].length;
  }
}

function assertOriginalSkill(packageCopy, expected = "original skill bytes\n") {
  assert.equal(
    readFileSync(join(packageCopy, "skills", "review-responder", "SKILL.md"), "utf8"),
    expected,
  );
}

function runInstallProbe(packageCopy, generated, body) {
  const probe = `
import importlib.util
import pathlib
import shutil
import sys
spec = importlib.util.spec_from_file_location("migration", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
package_root = pathlib.Path(sys.argv[2])
generated = pathlib.Path(sys.argv[3])
${body}
`;
  return spawnSync(
    "python3",
    ["-B", "-c", probe, join(packageCopy, "scripts", "migrate-review-responder-plugin.py"), packageCopy, generated],
    { encoding: "utf8" },
  );
}

function withFixture(callback) {
  const root = makeTempDir();
  try {
    const source = join(root, "source");
    writeSource(source);
    const packageCopy = makePackage(root);
    return callback({ root, source, packageCopy });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("migration CLI exposes positional and option source forms", () => {
  const result = spawnSync("python3", [migrationScript, "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Regenerate pi-review-responder resources/);
  assert.match(result.stdout, /\[--source SOURCE\]/);
  assert.match(result.stdout, /\[source\]/);
});

test("no-argument source selection skips invalid candidates under a temporary HOME", () => {
  const root = makeTempDir();
  try {
    const home = join(root, "home");
    const invalidCandidate = join(
      home,
      "devspace/personal/bfirestone/agent-marketplace/claude-marketplace/plugins/review-responder",
    );
    const verifiedCandidate = join(
      home,
      "devspace/personal/sentiolabs/agent-nexus/claude-marketplace/plugins/review-responder",
    );
    writeSource(invalidCandidate, { extra: "unclassified.txt" });
    writeSource(verifiedCandidate);
    const packageCopy = makePackage(root);

    const result = runMigration(packageCopy, [], { HOME: home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`Generated pi-review-responder resources from: ${verifiedCandidate.replaceAll("\\", "\\\\")}`),
    );
    assert.notEqual(
      readFileSync(join(packageCopy, "skills", "review-responder", "SKILL.md"), "utf8"),
      "original skill bytes\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("positional and --source forms are mutually exclusive", () => {
  withFixture(({ source, packageCopy }) => {
    const result = runMigration(packageCopy, [source, "--source", source]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /mutually exclusive/i);
    assertOriginalSkill(packageCopy);
  });
});

test("missing required source fails before live skills replacement", () => {
  const root = makeTempDir();
  try {
    const source = join(root, "source");
    writeSource(source, { omit: ["SKILL.md"] });
    const packageCopy = makePackage(root);
    const result = runMigration(packageCopy, [source]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /source file set/i);
    assertOriginalSkill(packageCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new unclassified source file fails before live skills replacement", () => {
  const root = makeTempDir();
  try {
    const source = join(root, "source");
    writeSource(source, { extra: "commands/new-command.md" });
    const packageCopy = makePackage(root);
    const result = runMigration(packageCopy, ["--source", source]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /unclassified|source file set/i);
    assertOriginalSkill(packageCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renamed or malformed plugin metadata fails closed", () => {
  const invalidPlugins = [
    { ...validPlugin, renamed: "review-responder", name: undefined },
    { ...validPlugin, name: "other-plugin" },
    { ...validPlugin, license: "Apache-2.0" },
    { ...validPlugin, description: "" },
    { ...validPlugin, author: { name: "Test Author" } },
    { ...validPlugin, keywords: ["github", 3] },
    "{ malformed json",
  ];
  for (const plugin of invalidPlugins) {
    const root = makeTempDir();
    try {
      const source = join(root, "source");
      writeSource(source, { plugin });
      const packageCopy = makePackage(root);
      const result = runMigration(packageCopy, [source]);
      assert.notEqual(result.status, 0, `metadata unexpectedly accepted: ${JSON.stringify(plugin)}`);
      assertOriginalSkill(packageCopy);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("invalid, duplicate, empty, or non-MIT skill frontmatter fails closed", () => {
  const body = sourceSkill.slice(sourceSkill.indexOf("\n---\n") + 5);
  const invalidSkills = [
    sourceSkill.replace("name: review-responder", "name: renamed-skill"),
    sourceSkill.replace("name: review-responder", "name: review-responder\nname: review-responder"),
    sourceSkill.replace("description: >\n", "description: >\nunknown: value\n"),
    `---\nname: review-responder\ndescription: >\nlicense: MIT\n---\n${body}`,
    sourceSkill.replace("description: >", "description: inline text"),
    sourceSkill.replace("  Fetches review comments", "\tFetches review comments"),
    sourceSkill.replace("description: >", "license: Apache-2.0\ndescription: >"),
  ];
  for (const skill of invalidSkills) {
    const root = makeTempDir();
    try {
      const source = join(root, "source");
      writeSource(source, { skill });
      const packageCopy = makePackage(root);
      const result = runMigration(packageCopy, [source]);
      assert.notEqual(result.status, 0, "invalid frontmatter unexpectedly accepted");
      assertOriginalSkill(packageCopy);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("semantic anchor drift fails before live skills replacement", () => {
  const root = makeTempDir();
  try {
    const source = join(root, "source");
    writeSource(source, {
      skill: sourceSkill.replace("## Phase 5: Commit and Push", "## Phase 5: Publish Changes"),
    });
    const packageCopy = makePackage(root);
    const result = runMigration(packageCopy, [source]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /marker|occurrence|drift/i);
    assertOriginalSkill(packageCopy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging preparation failure removes temporary install paths", () => {
  withFixture(({ root, packageCopy }) => {
    const generated = join(root, "generated");
    mkdirSync(join(generated, "skills", "review-responder"), { recursive: true });
    writeFileSync(join(generated, "skills", "review-responder", "SKILL.md"), "generated\n");
    const result = runInstallProbe(packageCopy, generated, `
def fail_copy(source, destination, **kwargs):
    raise OSError("injected staging copy failure")
module.shutil.copytree = fail_copy
module.install_generated_tree(generated, package_root)
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected staging copy failure/);
    assertOriginalSkill(packageCopy);
    assert.deepEqual(
      readdirSync(packageCopy).filter((name) => name.startsWith(".review-responder-skills-")),
      [],
    );
  });
});

test("ambiguous first-swap failure restores original skills bytes", () => {
  withFixture(({ root, packageCopy }) => {
    const generated = join(root, "generated");
    mkdirSync(join(generated, "skills", "review-responder"), { recursive: true });
    writeFileSync(join(generated, "skills", "review-responder", "SKILL.md"), "generated\n");
    const result = runInstallProbe(packageCopy, generated, `
move_count = 0
def move(source, destination):
    global move_count
    move_count += 1
    result = source.rename(destination)
    if move_count == 1:
        raise RuntimeError("ambiguous first swap failure")
    return result
module.install_generated_tree(generated, package_root, move=move)
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ambiguous first swap failure/);
    assertOriginalSkill(packageCopy);
  });
});

test("handled second-swap failure restores original skills bytes", () => {
  withFixture(({ root, packageCopy }) => {
    const generated = join(root, "generated");
    mkdirSync(join(generated, "skills", "review-responder"), { recursive: true });
    writeFileSync(join(generated, "skills", "review-responder", "SKILL.md"), "generated\n");
    const result = runInstallProbe(packageCopy, generated, `
move_count = 0
def move(source, destination):
    global move_count
    move_count += 1
    if move_count == 2:
        raise RuntimeError("injected second swap failure")
    return source.rename(destination)
module.install_generated_tree(generated, package_root, move=move)
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /injected second swap failure/);
    assertOriginalSkill(packageCopy);
  });
});

test("KeyboardInterrupt during install restores original skills bytes", () => {
  withFixture(({ root, packageCopy }) => {
    const generated = join(root, "generated");
    mkdirSync(join(generated, "skills", "review-responder"), { recursive: true });
    writeFileSync(join(generated, "skills", "review-responder", "SKILL.md"), "generated\n");
    const result = runInstallProbe(packageCopy, generated, `
move_count = 0
def move(source, destination):
    global move_count
    move_count += 1
    if move_count == 2:
        raise KeyboardInterrupt()
    return source.rename(destination)
module.install_generated_tree(generated, package_root, move=move)
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KeyboardInterrupt/);
    assertOriginalSkill(packageCopy);
  });
});

test("rollback deletion failure is reported", () => {
  withFixture(({ root, packageCopy }) => {
    const generated = join(root, "generated");
    mkdirSync(join(generated, "skills", "review-responder"), { recursive: true });
    writeFileSync(join(generated, "skills", "review-responder", "SKILL.md"), "generated\n");
    const result = runInstallProbe(packageCopy, generated, `
move_count = 0
def move(source, destination):
    global move_count
    move_count += 1
    result = source.rename(destination)
    if move_count == 2:
        raise RuntimeError("ambiguous second swap failure")
    return result
def remove(path):
    if path == package_root / "skills":
        raise OSError("injected rollback deletion failure")
    return shutil.rmtree(path)
module.install_generated_tree(generated, package_root, move=move, remove=remove)
`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rollback failed/i);
    assert.match(result.stderr, /injected rollback deletion failure/);
  });
});

test("fixture regeneration is byte-for-byte deterministic", () => {
  const root = makeTempDir();
  try {
    const source = join(root, "source");
    writeSource(source);
    const firstPackage = makePackage(join(root, "first"));
    const secondPackage = makePackage(join(root, "second"));
    const first = runMigration(firstPackage, [source]);
    const second = runMigration(secondPackage, ["--source", source]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /Generated pi-review-responder resources from:/);
    const firstBytes = readFileSync(join(firstPackage, "skills", "review-responder", "SKILL.md"));
    const secondBytes = readFileSync(join(secondPackage, "skills", "review-responder", "SKILL.md"));
    assert.notEqual(firstBytes.toString("utf8"), "original skill bytes\n");
    assert.deepEqual(firstBytes, secondBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture generation enforces ordered retrieval and per-post evidence refresh", () => {
  withFixture(({ source, packageCopy }) => {
    const result = runMigration(packageCopy, [source]);
    assert.equal(result.status, 0, result.stderr);
    const skill = readFileSync(
      join(packageCopy, "skills", "review-responder", "SKILL.md"),
      "utf8",
    );
    const fetchPhase = skill.slice(
      skill.indexOf("## Phase 2: Fetch Unresolved Review Threads"),
      skill.indexOf("## Phase 3: Evaluate Validity"),
    );
    assertPatternsInOrder(fetchPhase, [
      /retain every thread `id` plus its `isResolved` state without filtering or\s+fetching comments/i,
      /continue[^.]*while `hasNextPage` is true/is,
      /only after[^.]*complete[^.]*filter/is,
      /for each thread that remains unresolved[^.]*comments/is,
    ], "complete thread retrieval before filtering");

    const scopePhase = skill.slice(
      skill.indexOf("## Phase 1: Identify Scope"),
      skill.indexOf("## Phase 2: Fetch Unresolved Review Threads"),
    );
    assertPatternsInOrder(scopePhase, [
      /require `command -v gh` to exit successfully/i,
      /stop without invoking\s+`gh auth status`[^.]*without making an API call/is,
      /only after that success, run `gh auth status`/i,
      /require successful authentication/i,
      /stop before\s+any `gh pr view`, GraphQL, or REST call/is,
      /only after both checks succeed[^.]*GitHub API/is,
    ], "fail-closed gh availability and authentication preflight");

    const replyPhase = skill.slice(
      skill.indexOf("## Phase 6: Preview and Post Replies"),
      skill.indexOf("## Important Notes"),
    );
    assertPatternsInOrder(replyPhase, [
      /explicit approval of\s+the batch/i,
      /after that approval and immediately before each REST post/i,
      /refresh[^.]*headRefOid[^.]*canonical base repository/is,
      /re-check[^.]*verdict[^.]*evidence/is,
      /every \*\*Fixed\*\* and \*\*Already fixed\*\*[^.]*equals[^.]*ancestor/is,
      /evidence changed[^.]*new reply preview[^.]*approval/is,
      /re-fetch that thread[^.]*complete comment pagination/is,
      /gh api --hostname "\$host" --method POST/,
    ], "post-approval refresh before every reply post");
    assert.match(
      replyPhase,
      /\*\*Fixed\*\* and \*\*Already fixed\*\*[^\n]*marker `evidence`[^\n]*exactly the cited fix commit SHA/i,
    );
    assert.match(
      replyPhase,
      /\*\*Invalid\*\*, \*\*Won't fix\*\*, and \*\*Not applicable\*\*[\s\S]{0,120}marker `evidence`[\s\S]{0,120}evaluated and refreshed PR `headRefOid`/i,
    );
  });
});

test("manifest probes leave no scripts/__pycache__", () => {
  const probe = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("migration", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.RUNTIME_MANIFEST == (("SKILL.md", "skills/review-responder/SKILL.md"),)
`;
  const result = spawnSync("python3", ["-B", "-c", probe, migrationScript], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(packageRoot, "scripts", "__pycache__")), false);
});

test(
  "approved real source regenerates deterministically when available",
  { skip: !existsSync(canonicalSource) },
  () => {
    const root = makeTempDir();
    try {
      const firstPackage = makePackage(join(root, "first"));
      const secondPackage = makePackage(join(root, "second"));
      const first = runMigration(firstPackage, [canonicalSource]);
      const second = runMigration(secondPackage, [canonicalSource]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      const firstBytes = readFileSync(join(firstPackage, "skills", "review-responder", "SKILL.md"));
      const secondBytes = readFileSync(join(secondPackage, "skills", "review-responder", "SKILL.md"));
      assert.notEqual(firstBytes.toString("utf8"), "original skill bytes\n");
      assert.deepEqual(firstBytes, secondBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
