import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandAnchorPattern,
  editorOpeningAnchors,
  failureVariants,
  forbiddenManualSubprocessCommands,
  manualInteractiveTransforms,
  mutationAnchorPatterns,
  rawSourceFiles,
  sourceFiles,
} from "./migration-fixtures.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = path.join(packageRoot, "scripts/migrate-git-spice-plugin.py");
const migrationContracts = path.join(packageRoot, "scripts/migration_contracts.py");
const migrationInstall = path.join(packageRoot, "scripts/migration_install.py");
const runtimeManifest = [
  ["commands/continue.md", "prompts/git-spice-continue.md"], ["commands/init.md", "prompts/git-spice-init.md"],
  ["commands/new.md", "prompts/git-spice-new.md"], ["commands/restack.md", "prompts/git-spice-restack.md"],
  ["commands/stack.md", "prompts/git-spice-stack.md"], ["commands/submit.md", "prompts/git-spice-submit.md"],
  ["commands/sync.md", "prompts/git-spice-sync.md"], ["skills/git-spice/SKILL.md", "skills/git-spice/SKILL.md"],
  ["skills/stacking-workflow/SKILL.md", "skills/stacking-workflow/SKILL.md"],
  ["agents/stack-doctor.md", "agents/stack-doctor.md"], ["agents/stacker.md", "agents/stacker.md"],
];
const requiredSourcePaths = [...runtimeManifest.map(([source]) => source), ".claude-plugin/plugin.json"];
const temporaryRoots = new Set();

const makeTemporaryDirectory = (prefix) => {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
};

test.after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const writeFixtureFile = (root, relativePath, content) => {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

const createSourceFixture = (overrides = {}) => {
  const root = makeTemporaryDirectory("pi-git-spice-source-");
  const files = { ...sourceFiles(), ...overrides };
  for (const [relative, content] of Object.entries(files)) writeFixtureFile(root, relative, content);
  return root;
};

const createTemporaryPackage = () => {
  const root = makeTemporaryDirectory("pi-git-spice-package-");
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "migrate-git-spice-plugin.py");
  copyFileSync(migrationScript, script);
  copyFileSync(migrationContracts, path.join(scripts, "migration_contracts.py"));
  copyFileSync(migrationInstall, path.join(scripts, "migration_install.py"));
  return { root, script };
};

const sourceDigestMap = (source) => Object.fromEntries(requiredSourcePaths.map((relative) => [
  relative,
  createHash("sha256").update(readFileSync(path.join(source, relative))).digest("hex"),
]));

const migrationImportHarness = [
  "import importlib.util, json, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "module.migrate(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), json.loads(sys.argv[4]))",
].join("; ");

const runMigration = (
  script,
  source,
  cwd,
  { expectedDigests = sourceDigestMap(source), productionCli = false } = {},
) => spawnSync(
  "python3",
  productionCli
    ? ["-B", script, source]
    : ["-B", "-c", migrationImportHarness, script, source, cwd, JSON.stringify(expectedDigests)],
  { cwd, encoding: "utf8" },
);

const runtimeSnapshot = (root) => {
  const snapshot = new Map();
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else {
      snapshot.set(relative, readFileSync(absolute));
    }
  };
  for (const generatedRoot of ["agents", "prompts", "skills"]) visit(generatedRoot);
  return snapshot;
};

const assertRuntimeSnapshot = (root, expected) => {
  assert.deepEqual(runtimeSnapshot(root), expected);
};

const assertNoTransactionDebris = (root) => {
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith(".pi-git-spice-install-")),
    [],
    "transaction staging and backup directories",
  );
};

const installedSentinels = (root) => {
  for (const name of ["prompts", "skills", "agents"]) writeFixtureFile(root, `${name}/sentinel.txt`, `${name} original\n`);
  return new Map(["prompts", "skills", "agents"].map((name) => [name, readFileSync(path.join(root, name, "sentinel.txt"))]));
};

const assertRollback = (root, sentinels) => {
  for (const [name, bytes] of sentinels) assert.deepEqual(readFileSync(path.join(root, name, "sentinel.txt")), bytes, name);
  assertNoTransactionDebris(root);
};

for (const relative of requiredSourcePaths) {
  test(`source digest drift for ${relative} fails before installed-root mutation`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    installedSentinels(packageCopy.root);
    const expectedDigests = sourceDigestMap(source);
    const before = runtimeSnapshot(packageCopy.root);
    writeFileSync(path.join(source, relative), Buffer.concat([
      readFileSync(path.join(source, relative)),
      Buffer.from("\nreview drift\n"),
    ]));
    const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(relative.replaceAll("/", "\\/")));
    assert.match(result.stderr, /expected=[a-f0-9]{64}/);
    assert.match(result.stderr, /actual=[a-f0-9]{64}/);
    assertRuntimeSnapshot(packageCopy.root, before);
    assertNoTransactionDebris(packageCopy.root);
  });
}

test("production CLI rejects synthetic source bytes with compiled-in pins", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const before = runtimeSnapshot(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root, { productionCli: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commands\/continue\.md/);
  assert.match(result.stderr, /expected=[a-f0-9]{64}/);
  assert.match(result.stderr, /actual=[a-f0-9]{64}/);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

for (const [name, mutate, diagnostic] of [
  ["missing", (digests) => { delete digests[requiredSourcePaths[0]]; }, /digest keys.*missing.*commands\/continue\.md/is],
  ["extra", (digests) => { digests["commands/future.md"] = "0".repeat(64); }, /digest keys.*extra.*commands\/future\.md/is],
]) {
  test(`${name} source digest-map keys fail before installed-root mutation`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    installedSentinels(packageCopy.root);
    const expectedDigests = sourceDigestMap(source);
    mutate(expectedDigests);
    const before = runtimeSnapshot(packageCopy.root);
    const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, diagnostic);
    assertRuntimeSnapshot(packageCopy.root, before);
    assertNoTransactionDebris(packageCopy.root);
  });
}

test("reviewed fixture digest seam still reaches transform anchor cardinality checks", () => {
  const relative = "commands/continue.md";
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const drifted = readFileSync(path.join(source, relative), "utf8")
    .replace("git-spice rebase continue", "git-spice  rebase continue");
  writeFileSync(path.join(source, relative), drifted);
  const expectedDigests = sourceDigestMap(source);
  const before = runtimeSnapshot(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root, { expectedDigests });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rebase continue mutation anchor cardinality/);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

const inlineGitSpiceCommands = (text, operation) => Array.from(
  text.matchAll(new RegExp("`(git-spice(?: --no-prompt)? " + operation + "[^`]*)`", "g")),
  ([, command]) => command,
);

const assertSafeBranchCreation = (text, context) => {
  const commands = Array.from(text.matchAll(/git-spice(?: --no-prompt)? branch create[^\n`]*/g), ([command]) => command.trim());
  assert.ok(commands.length > 0, `${context} contains branch creation guidance`);
  for (const command of commands) {
    assert.match(command, /^git-spice --no-prompt branch create /, command);
    assert.match(command, /(?:^| )-m (?:"[^"]+"|<[^>]+>)|--no-commit/, command);
  }
};

const assertSafeRebaseContinuation = (text, context) => {
  const commands = inlineGitSpiceCommands(text, "rebase continue");
  assert.ok(commands.length > 0, `${context} contains rebase continuation guidance`);
  for (const command of commands) assert.equal(command, "git-spice --no-prompt rebase continue --no-edit", context);
};

const assertSafeEditorOpeningGuidance = (gitSpice, stacking) => {
  assert.match(
    gitSpice,
    /`git-spice --no-prompt commit create -m "<message>"` \(`git-spice --no-prompt cc -m "<message>"`\)/,
  );
  assert.match(
    gitSpice,
    /`git-spice --no-prompt commit amend --no-edit` \(`git-spice --no-prompt ca --no-edit`\)/,
  );
  assert.match(
    gitSpice,
    /`git-spice --no-prompt branch squash --no-edit` \(`git-spice --no-prompt bsq --no-edit`\)/,
  );
  assert.match(gitSpice, /commit amend --no-edit\s+# or commit create -m "<message>"/);
  assert.match(stacking, /commit amend --no-edit\s+# or 'commit create -m "<message>"'/);
  assert.match(stacking, /instead of `git-spice --no-prompt commit create -m "<message>"`/);
  const combined = `${gitSpice}\n${stacking}`;
  assert.doesNotMatch(
    combined,
    /git-spice --no-prompt (?:commit create|cc)(?![^`\n]*(?:-m|--message|-F|--message-file)(?:[ =]))/,
  );
  assert.doesNotMatch(
    combined,
    /git-spice --no-prompt (?:commit amend|ca|branch squash|bsq)(?![^`\n]*--no-edit)/,
  );
};

const assertManualInteractiveOutput = (packageCopy) => {
  const outputs = Object.fromEntries(runtimeManifest.map(([source, target]) => [
    source,
    readFileSync(path.join(packageCopy.root, target), "utf8"),
  ]));
  for (const [name, relative, , target] of manualInteractiveTransforms) {
    assert.equal(outputs[relative].split(target).length - 1, 1, `${relative}: ${name}`);
  }
  const combined = Object.values(outputs).join("\n");
  for (const command of forbiddenManualSubprocessCommands) {
    assert.equal(combined.includes(`git-spice --no-prompt ${command}`), false, command);
  }
};

test("migration CLI does not leave imported helper bytecode beside the generator", () => {
  const packageCopy = createTemporaryPackage();
  const result = spawnSync("python3", [packageCopy.script, "--help"], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(packageCopy.root, "scripts/__pycache__")), false);
});

test("migration CLI parses positional and option source forms without a digest bypass", () => {
  const help = execFileSync("python3", [migrationScript, "--help"], { encoding: "utf8" });
  assert.match(help, /\[--source SOURCE\]/);
  assert.match(help, /\[source\]/);
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const positional = runMigration(packageCopy.script, source, packageCopy.root, { productionCli: true });
  const option = spawnSync("python3", ["-B", packageCopy.script, "--source", source], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  for (const result of [positional, option]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Source digest drift/);
  }
  const duplicate = spawnSync("python3", ["-B", packageCopy.script, source, "--source", source], {
    cwd: packageCopy.root,
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /either positionally or with --source/);
});

test("invalid source fails before rewriting installed resources", () => {
  const source = makeTemporaryDirectory("pi-git-spice-invalid-");
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root, {
    expectedDigests: {},
    productionCli: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing expected paths/);
  assertRollback(packageCopy.root, sentinels);
});

test("unclassified source files fail closed", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  writeFixtureFile(source, "commands/future.md", "# Future\n");
  const result = runMigration(packageCopy.script, source, packageCopy.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unclassified source file/);
  assertRollback(packageCopy.root, sentinels);
});

test("malformed UTF-8 reports its source path before installed-root mutation", () => {
  const relative = "commands/stack.md";
  const source = createSourceFixture();
  writeFileSync(path.join(source, relative), Buffer.concat([readFileSync(path.join(source, relative)), Buffer.from([0xff])]));
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const before = runtimeSnapshot(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commands\/stack\.md[\s\S]*UTF-8|UTF-8[\s\S]*commands\/stack\.md/i);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

test("fixture regeneration is byte-for-byte deterministic", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const first = runtimeSnapshot(packageCopy.root);
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  for (const [relative, bytes] of first) assert.deepEqual(readFileSync(path.join(packageCopy.root, relative)), bytes, relative);
});

test("migration transforms source bodies while applying Pi safety adaptations", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const prompts = Object.fromEntries(Object.keys(sourceFiles())
    .filter((relative) => relative.startsWith("commands/"))
    .map((relative) => [relative, readFileSync(path.join(packageCopy.root, "prompts", `git-spice-${path.basename(relative)}`), "utf8")]));
  const combinedPrompts = Object.values(prompts).join("\n");
  assert.match(combinedPrompts, /git-spice --no-prompt repo init --trunk=<name> --remote=<name>/);
  assert.match(combinedPrompts, /separate explicit confirmation/i);
  assert.match(combinedPrompts, /draft/i);
  assert.doesNotMatch(combinedPrompts, /\/git-spice:/);
  for (const output of Object.values(prompts)) assert.match(output, /\/git-spice-stack/);
  assertSafeBranchCreation(prompts["commands/new.md"], "new prompt");
  assertSafeRebaseContinuation(prompts["commands/continue.md"], "continue prompt");
  assert.match(prompts["commands/continue.md"], /missing configuration[\s\S]*report[\s\S]*rather than enabling prompts/i);
  assert.match(prompts["commands/submit.md"], /submit --dry-run --fill <draft-flag>/);
  assert.match(prompts["commands/submit.md"], /reject prompt controls and conflicting draft controls/i);
  assert.doesNotMatch(prompts["commands/submit.md"], /<extra-flags>/);

  const generatedSkills = Object.fromEntries(["skills/git-spice/SKILL.md", "skills/stacking-workflow/SKILL.md"].map((relative) => [
    relative, readFileSync(path.join(packageCopy.root, relative), "utf8"),
  ]));
  assertSafeEditorOpeningGuidance(generatedSkills["skills/git-spice/SKILL.md"], generatedSkills["skills/stacking-workflow/SKILL.md"]);
  for (const [relative, output] of Object.entries(generatedSkills)) {
    assert.match(output, /If the subagent tool is available, list agents first/);
    assert.match(output, /git-spice\.stacker/);
    assert.match(output, /direct workflow instead/);
    assert.doesNotMatch(output, /subagent_type|Task tool/);
    if (relative === "skills/git-spice/SKILL.md") assert.doesNotMatch(output, /git-spice --no-prompt commit \.\.\./);
    assertSafeBranchCreation(output, relative);
    assertSafeRebaseContinuation(output, relative);
  }

  const stacker = readFileSync(path.join(packageCopy.root, "agents/stacker.md"), "utf8");
  assert.match(stacker, /name: stacker/);
  assert.match(stacker, /package: git-spice/);
  assert.match(stacker, /description: Use this agent to build a stack of dependent git-spice branches/);
  assert.match(stacker, /tools: bash, read, write, edit, find, grep/);
  assert.doesNotMatch(stacker, /model: sonnet/);
  assert.match(stacker, /<paste final stack log output>/);
  assertSafeBranchCreation(stacker, "stacker agent");

  const doctor = readFileSync(path.join(packageCopy.root, "agents/stack-doctor.md"), "utf8");
  assert.match(doctor, /<paste final stack log and git status output>/);
  assertSafeRebaseContinuation(doctor, "stack-doctor agent");
  const submitMutations = inlineGitSpiceCommands(doctor, "(?:branch|upstack|downstack|stack|<scope>) submit");
  assert.ok(submitMutations.length > 0, "stack-doctor contains submit guidance");
  for (const command of submitMutations) {
    assert.match(command, /^git-spice --no-prompt /, command);
    if (!command.endsWith(" submit")) assert.match(command, /--draft|--no-draft|<draft-flag>/, command);
  }
  assert.match(doctor, /--draft.*--no-draft|--no-draft.*--draft/s);
  assert.match(doctor, /never rely on an implicit draft state/i);
  assert.match(doctor, /git-spice --no-prompt branch track <branch>/);
  assert.match(doctor, /git-spice --no-prompt downstack track <top-branch>/);
  assert.match(doctor, /gather or derive[\s\S]*branch name/i);
  assert.match(doctor, /ambiguous[\s\S]*missing configuration[\s\S]*rather than enabling prompts/i);
  assertManualInteractiveOutput(packageCopy);
});

test("all runtime resource bodies preserve distinct opaque multiline blocks byte-for-byte", () => {
  const blocks = Object.fromEntries(runtimeManifest.map(([source], index) => [source,
    `opaque-begin-${index}:${source}\n  untouched payload ${index} <> & punctuation\nopaque-end-${index}:${source}`]));
  const overrides = Object.fromEntries(runtimeManifest.map(([source]) => [source, `${sourceFiles()[source].trimEnd()}\n\n${blocks[source]}\n`]));
  const source = createSourceFixture(overrides);
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  for (const [sourceRelative, targetRelative] of runtimeManifest) {
    const output = readFileSync(path.join(packageCopy.root, targetRelative));
    for (const [otherRelative, block] of Object.entries(blocks)) {
      const marker = Buffer.from(block);
      const first = output.indexOf(marker);
      assert.equal(first >= 0, otherRelative === sourceRelative, `${targetRelative} marker from ${otherRelative}`);
      if (first >= 0) assert.equal(output.indexOf(marker, first + marker.length), -1, `${targetRelative} duplicate marker`);
    }
  }
});

test("every repeated git-spice reference survives semantic transformation", () => {
  const revised = sourceFiles()["commands/restack.md"].replace("/git-spice:continue", "/git-spice:continue and /git-spice:continue");
  const source = createSourceFixture({ "commands/restack.md": revised });
  const packageCopy = createTemporaryPackage();
  assert.equal(runMigration(packageCopy.script, source, packageCopy.root).status, 0);
  const output = readFileSync(path.join(packageCopy.root, "prompts/git-spice-restack.md"), "utf8");
  assert.equal((output.match(/\/git-spice-continue/g) ?? []).length, 2);
  assert.doesNotMatch(output, /\/git-spice:continue/);
});

const assertMigrationFailure = (relative, content, diagnostic, requireSourcePath = false) => {
  const source = createSourceFixture({ [relative]: `${content}\n` });
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const result = runMigration(packageCopy.script, source, packageCopy.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, diagnostic);
  if (requireSourcePath) assert.match(result.stderr, new RegExp(relative.replaceAll("/", "\\/")));
  assertRollback(packageCopy.root, sentinels);
};

for (const [name, relative, makeContent, diagnostic] of failureVariants) {
  test(`${name} fails before installation`, () => assertMigrationFailure(relative, makeContent(), diagnostic));
}

const manualAnchorMutation = (content, source, variant) => {
  if (variant === "zero") return content.replace(source, "");
  if (variant === "duplicate") return `${content.trimEnd()}\n${source}\n`;
  const drifted = `${source[0]} ${source.slice(1)}`;
  return content.replace(source, drifted);
};

for (const [name, relative, source] of manualInteractiveTransforms) {
  for (const variant of ["zero", "duplicate", "drifted"]) {
    test(`${name} rejects ${variant} manual-interactive source anchor in ${relative}`, () => {
      const content = manualAnchorMutation(sourceFiles()[relative], source, variant);
      assertMigrationFailure(
        relative,
        content,
        /manual-interactive source anchor cardinality/,
        true,
      );
    });
  }
}

const guardedMutationAnchors = [
  ...editorOpeningAnchors.map(([operation, relative, pattern]) => [operation, relative, pattern, new RegExp(`${operation} editor-opening anchor cardinality`)]),
  ["init/reset", "commands/init.md", mutationAnchorPatterns.reset, /reset mutation anchor cardinality/],
  ["init/reconfiguration", "commands/init.md", mutationAnchorPatterns.init, /init mutation anchor cardinality/],
  ["branch create", "commands/new.md", mutationAnchorPatterns.branchCreate, /branch create mutation anchor cardinality/],
  ["rebase continue", "commands/continue.md", mutationAnchorPatterns.rebaseContinue, /rebase continue mutation anchor cardinality/],
  ["rebase abort", "commands/continue.md", mutationAnchorPatterns.rebaseAbort, /rebase abort mutation anchor cardinality/],
  ["restack", "commands/restack.md", mutationAnchorPatterns.restack, /restack mutation anchor cardinality/],
  ["sync", "commands/sync.md", mutationAnchorPatterns.sync, /sync mutation anchor cardinality/],
  ["submit draft injection", "commands/submit.md", mutationAnchorPatterns.submit, /submit mutation anchor cardinality/],
  ["other command mutation", "commands/stack.md", commandAnchorPattern, /command anchor cardinality/],
];

const mutateAnchorCardinality = (content, pattern, variant) => {
  const matches = Array.from(content.matchAll(pattern), (match) => match[0]);
  assert.ok(matches.length > 0);
  if (variant === "zero") return content.replace(pattern, "git spice disabled-anchor");
  if (variant === "duplicate") {
    if (pattern === commandAnchorPattern) return `${content}\nDuplicated mutation: \`git-spice commit amend\`.\n`;
    const suffix = pattern === mutationAnchorPatterns.reset ? " --reset" : " fixture";
    return `${content}\nDuplicated mutation: \`${matches[0]}${suffix}\`.\n`;
  }
  if (pattern === commandAnchorPattern) return content.replace(new RegExp(pattern.source), "git-spice  ");
  const drifted = matches[0].includes("git-spice ")
    ? matches[0].replace("git-spice ", "git-spice  ")
    : matches[0].replace("commit create", "commit  create");
  return content.replace(new RegExp(pattern.source), drifted);
};

for (const [operation, relative, pattern, diagnostic] of guardedMutationAnchors) {
  for (const variant of ["zero", "duplicate", "drifted"]) {
    test(`${operation} rejects ${variant} mutation anchors before installation`, () => assertMigrationFailure(
      relative, mutateAnchorCardinality(sourceFiles()[relative], pattern, variant), diagnostic, true,
    ));
  }
}

const runProbe = (python, packageCopy, source) => spawnSync(
  "python3",
  ["-B", "-c", python, packageCopy.script, source, JSON.stringify(sourceDigestMap(source))],
  { cwd: packageCopy.root, encoding: "utf8" },
);

const sourceSnapshotProbe = (directory, body, beforeBuild = "") => [
  "import importlib.util, json, pathlib, sys",
  "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "source = pathlib.Path(sys.argv[2])",
  `temporary = pathlib.Path(module.PACKAGE_ROOT) / '${directory}'`,
  "temporary.mkdir()",
  "snapshot = module.load_validated_source(source, json.loads(sys.argv[3]))",
  beforeBuild,
  "generated = module.build_generated_tree(snapshot, temporary)",
  body,
].join("\n");
const generatedTreeProbe = (body) => sourceSnapshotProbe("validator-probe", `${body}\nmodule.validate_generated_tree(generated)`);

test("validate_source returns None and migrate installs one immutable validated snapshot", () => {
  const relative = "commands/stack.md";
  const [reviewed, unreviewed] = ["opaque-reviewed-snapshot-block", "unreviewed-post-validation-mutation"];
  const source = createSourceFixture({ [relative]: `${sourceFiles()[relative]}\n${reviewed}\n` });
  const packageCopy = createTemporaryPackage();
  const interception = [
    "expected = json.loads(sys.argv[3])",
    "assert module.validate_source(source, expected) is None",
    "calls = []",
    "original_load = module.load_validated_source",
    "def mutating_load(source, expected_digests):",
    "    snapshot = original_load(source, expected_digests); calls.append(snapshot)",
    "    assert not hasattr(snapshot, '__setitem__'), 'source snapshot must be immutable'",
    `    target = source / ${JSON.stringify(relative)}`,
    `    target.write_bytes(target.read_bytes().replace(b'${reviewed}', b'${unreviewed}'))`,
    "    return snapshot",
    "module.load_validated_source = mutating_load",
  ].join("\n");
  const migration = "module.migrate(source, module.PACKAGE_ROOT, expected)\nassert len(calls) == 1, 'migrate must load one source snapshot'";
  const result = runProbe(sourceSnapshotProbe("snapshot-probe", migration, interception), packageCopy, source);
  assert.equal(result.status, 0, result.stderr);
  const installed = readFileSync(path.join(packageCopy.root, "prompts/git-spice-stack.md"), "utf8");
  assert.match(installed, new RegExp(reviewed));
  assert.doesNotMatch(installed, new RegExp(unreviewed));
});

test("generated-tree validation rejects required Pi literal cardinality drift", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const mutation = [
    "target = generated / 'prompts/git-spice-continue.md'",
    "text = target.read_text()",
    "target.write_text(text.replace('git-spice --no-prompt rebase continue --no-edit', 'git spice removed', 1))",
  ].join("\n");
  const result = runProbe(generatedTreeProbe(mutation), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required literal.*cardinality/i);
});

for (const [relative, literal] of [
  ["skills/git-spice/SKILL.md", "name: git-spice\n"], ["skills/git-spice/SKILL.md", "license: MIT\n"],
  ["skills/stacking-workflow/SKILL.md", "name: stacking-workflow\n"], ["skills/stacking-workflow/SKILL.md", "license: MIT\n"],
]) {
  test(`generated-tree validation rejects corrupted ${relative} ${literal.trim()}`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const mutation = [
      `target = generated / ${JSON.stringify(relative)}`,
      `literal = ${JSON.stringify(literal)}`,
      "target.write_text(target.read_text().replace(literal, 'corrupted: value\\n', 1))",
    ].join("\n");
    const result = runProbe(generatedTreeProbe(mutation), packageCopy, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(relative.replaceAll("/", "\\/")));
    assert.match(result.stderr, /literal=.*expected=1.*actual=0|expected=1.*actual=0.*literal=/is);
  });
}

test("generated-tree validation rejects forbidden Pi-delta literals", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const mutation = [
    "target = generated / 'prompts/git-spice-stack.md'",
    "target.write_text(target.read_text() + '\\n<extra-flags>\\n')",
  ].join("\n");
  const result = runProbe(generatedTreeProbe(mutation), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /forbidden generated content/i);
});

const installationProbe = (injection) => sourceSnapshotProbe("installation-probe", injection);

const transactionDirectories = (root) => readdirSync(root).filter((name) => name.startsWith(".pi-git-spice-install-"));

for (const swap of [1, 2, 3, 4, 5, 6]) {
  test(`failure during atomic root swap ${swap} restores all originals and cleans artifacts`, () => {
    const source = createSourceFixture();
    const packageCopy = createTemporaryPackage();
    const sentinels = installedSentinels(packageCopy.root);
    const injection = [
      "calls = {'moves': 0}",
      "original_move = module.rename_path",
      "def failing_move(source, destination):",
      "    calls['moves'] += 1",
      `    if calls['moves'] == ${swap}: raise OSError('injected swap ${swap}')`,
      "    return original_move(source, destination)",
      "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=module.remove_tree)",
    ].join("\n");
    const result = runProbe(installationProbe(injection), packageCopy, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`injected swap ${swap}`));
    assertRollback(packageCopy.root, sentinels);
  });
}

test("KeyboardInterrupt during staging preserves installed roots and removes staging artifacts", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'copies': 0}",
    "original_copytree = module.shutil.copytree",
    "def failing_copytree(source, destination):",
    "    calls['copies'] += 1",
    "    if calls['copies'] == 2: raise KeyboardInterrupt()",
    "    return original_copytree(source, destination)",
    "module.shutil.copytree = failing_copytree",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=module.rename_path, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KeyboardInterrupt/);
  assertRollback(packageCopy.root, sentinels);
});

test("KeyboardInterrupt during a live-root swap restores every original byte and removes transaction debris", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const before = runtimeSnapshot(packageCopy.root);
  const injection = [
    "calls = {'backups': 0, 'installs': 0}",
    "original_move = module.rename_path",
    "def interrupted_move(source, destination):",
    "    result = original_move(source, destination)",
    "    if destination.parent.name == 'backups': calls['backups'] += 1",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 1:",
    "            assert calls['backups'] >= 1",
    "            assert destination.exists()",
    "            raise KeyboardInterrupt('injected live-root swap interruption')",
    "    return result",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=interrupted_move, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KeyboardInterrupt: injected live-root swap interruption/);
  assertRuntimeSnapshot(packageCopy.root, before);
  assertNoTransactionDebris(packageCopy.root);
});

test("installed-root verification failure restores all originals", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  const sentinels = installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "def corrupting_move(source, destination):",
    "    result = original_move(source, destination)",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 3: next(path for path in destination.rglob('*') if path.is_file()).unlink()",
    "    return result",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=corrupting_move, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed generated resource verification failed/);
  assertRollback(packageCopy.root, sentinels);
});

test("interrupted committed cleanup is retried without hiding the committed state", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'cleanup': 0}",
    "original_remove = module.remove_tree",
    "def interrupted_remove(target):",
    "    if target.name.startswith('.pi-git-spice-install-'):",
    "        calls['cleanup'] += 1",
    "        if calls['cleanup'] == 1: raise KeyboardInterrupt()",
    "    return original_remove(target)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=module.rename_path, remove=interrupted_remove)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installation committed and verified.*cleanup was interrupted/is);
  assert.deepEqual(transactionDirectories(packageCopy.root), []);
  for (const relative of runtimeSnapshot(packageCopy.root).keys()) assert.equal(existsSync(path.join(packageCopy.root, relative)), true, relative);
});

test("rollback deletion failure retains recoverable backups and reports their path", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "original_remove = module.remove_tree",
    "def failing_move(source, destination):",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 2: raise OSError('trigger rollback')",
    "    return original_move(source, destination)",
    "def failing_remove(target):",
    "    if target == module.PACKAGE_ROOT / 'agents': raise OSError('cannot delete installed agents')",
    "    return original_remove(target)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=failing_remove)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to roll back generated resource installation/);
  assert.match(result.stderr, /Recovery artifacts retained at/);
  const transactions = transactionDirectories(packageCopy.root);
  assert.equal(transactions.length, 1);
  assert.equal(readFileSync(path.join(packageCopy.root, transactions[0], "backups/agents/sentinel.txt"), "utf8"), "agents original\n");
});

test("backup restoration failure never deletes the last recoverable original", () => {
  const source = createSourceFixture();
  const packageCopy = createTemporaryPackage();
  installedSentinels(packageCopy.root);
  const injection = [
    "calls = {'installs': 0}",
    "original_move = module.rename_path",
    "def failing_move(source, destination):",
    "    if source.parent.name == 'staged':",
    "        calls['installs'] += 1",
    "        if calls['installs'] == 2: raise OSError('trigger rollback')",
    "    if source.parent.name == 'backups' and source.name == 'agents': raise OSError('cannot restore agents')",
    "    return original_move(source, destination)",
    "module.install_generated_tree(generated, module.PACKAGE_ROOT, move=failing_move, remove=module.remove_tree)",
  ].join("\n");
  const result = runProbe(installationProbe(injection), packageCopy, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot restore agents/);
  assert.match(result.stderr, /Recovery artifacts retained at/);
  const transactions = transactionDirectories(packageCopy.root);
  assert.equal(transactions.length, 1);
  assert.equal(readFileSync(path.join(packageCopy.root, transactions[0], "backups/agents/sentinel.txt"), "utf8"), "agents original\n");
});
