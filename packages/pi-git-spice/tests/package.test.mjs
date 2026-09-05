import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = join(packageRoot, "scripts/migrate-git-spice-plugin.py");
const migrationContract = JSON.parse(execFileSync("python3", [
  "-B",
  "-c",
  [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps({'commit': module.REVIEWED_UPSTREAM_COMMIT, 'pins': module.PINNED_SOURCE_SHA256, 'required': module.REQUIRED_SOURCE_PATHS, 'runtime': [target for _, target in module.RUNTIME_MANIFEST]}))",
  ].join("; "),
  migrationScript,
], { encoding: "utf8" }));
const readText = (relative) => readFileSync(join(packageRoot, relative), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));

const expectedSourceSha256 = {
  ".claude-plugin/plugin.json": "05a3bb20a09140dabb498f62e53e513bae64e92f4f6bd252944b4c14de5c4d75",
  "commands/continue.md": "36a2a0984affd272c80ee7264db39a760744cfb20e8d7900a91057fa56c76783",
  "commands/init.md": "f28579b31be7fb0aa0c101734359a8a2f7fab5e999d54b753b0a57767740841c",
  "commands/new.md": "773de81af3ea362b9006baf301296d1f76879cae2ee8378106b64752cab2fb44",
  "commands/restack.md": "51f361cc07d4803bd890e0d3eb857ace7225b18f684078b7ab275237defb5a67",
  "commands/stack.md": "07f06651c43e56a3328cad7950651775919ffe88ed0d235e2232d766ab2b0537",
  "commands/submit.md": "be232954a666a724b91a9da56fc77bb2c1ebf69191094990022388b0735f1199",
  "commands/sync.md": "b08b01431d3285bbc39267c778290ced498b31a3c0e1d6d383a68df640c51494",
  "skills/git-spice/SKILL.md": "6aef3f2dc87e8ddbfa94d231aa3201d69deae27616d7ba6090ae04c362dbf9a2",
  "skills/stacking-workflow/SKILL.md": "558461eb99a21cdd21d2cbc5b38c4fa97e8efa396861cb20c320edc6c16c32bf",
  "agents/stack-doctor.md": "d1afbff2da29e95f9645ee2c63f3888f7d875748a1766a2b06b624b145e9566e",
  "agents/stacker.md": "c5f7055f7b60d9ee5014d39fe7f28680a485a807bfb7f10bda06f58ff12c50e1",
};
const expectedGeneratedDigestPaths = [
  "agents/stack-doctor.md",
  "agents/stacker.md",
  "prompts/git-spice-continue.md",
  "prompts/git-spice-init.md",
  "prompts/git-spice-new.md",
  "prompts/git-spice-restack.md",
  "prompts/git-spice-stack.md",
  "prompts/git-spice-submit.md",
  "prompts/git-spice-sync.md",
  "skills/git-spice/SKILL.md",
  "skills/stacking-workflow/SKILL.md",
].sort();
const reviewedGeneratedSha256 = {
  "agents/stack-doctor.md": "163885ec4a57fcc3587199d82c34ed584aa972c393b1b2ec2b84878fc835599d",
  "agents/stacker.md": "4ab2da81685cf6a97fba23546fe20b7929e580f7cdf6d05e92299e74a67a0425",
  "prompts/git-spice-continue.md": "247113435a61483022c2b48b422f1b89095a54be1f6f8f2a32bb1d242bd14750",
  "prompts/git-spice-init.md": "2dbaee08e95087a9e236cb6af88cc13e1f01127c9dff2aebbb3bd5564ab3c8e1",
  "prompts/git-spice-new.md": "e553eb03f97707965a3e590c75f0c9b592ba2000a975ea0a57d6c7fdd796d986",
  "prompts/git-spice-restack.md": "4f05ecb3dd230b8880deb9b097694719995ea3984137f8aff264de970711afb2",
  "prompts/git-spice-stack.md": "3e031ef21aa66a1e8f525be32b69cf5efd18e435bd5d4fa764235edef06b70f2",
  "prompts/git-spice-submit.md": "c5ce194c3f989ea5b3bfbf66f6726c1c23318ee67c61f50cdb713fdf8f244437",
  "prompts/git-spice-sync.md": "7f72f317bdda57d3b15c04b000e3bf5d6e23bedb7fddd816652cc0fdbbeeb474",
  "skills/git-spice/SKILL.md": "7e2e267f4151c040f97c69dda598cea0d7cb766d79ae7e0b799525629d09917a",
  "skills/stacking-workflow/SKILL.md": "e3b8a55ba89a3a81b65f50487826c28c54c3b850182c4a391515a86e9ac3c4c0",
};
const expectedPackedPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  ...expectedGeneratedDigestPaths,
  "extensions/git-spice-workflow.ts",
  "package.json",
  "src/adapters/command-runner.ts",
  "src/adapters/git.ts",
  "src/core/contracts.ts",
  "src/core/ports.ts",
].sort();

test("production pins the exact reviewed upstream source bytes", () => {
  assert.equal(migrationContract.commit, "c84eeae13b6b283f5969044fc6775e642e805935");
  assert.deepEqual(migrationContract.pins, expectedSourceSha256);
  assert.deepEqual([...migrationContract.required].sort(), Object.keys(expectedSourceSha256).sort());
  for (const digest of Object.values(migrationContract.pins)) assert.match(digest, /^[a-f0-9]{64}$/);
});

test("generated resources match the reviewed SHA-256 map", async () => {
  assert.deepEqual(Object.keys(reviewedGeneratedSha256).sort(), expectedGeneratedDigestPaths);
  for (const relative of expectedGeneratedDigestPaths) {
    assert.match(reviewedGeneratedSha256[relative], /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(packageRoot, relative));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), reviewedGeneratedSha256[relative]);
  }
});

test("migration source contains no removed Markdown, occurrence, shell, or argv parser subsystem", () => {
  const source = readText("scripts/migrate-git-spice-plugin.py");
  for (const name of [
    "MarkdownRegion", "SourceLine", "GitSpiceOccurrence", "ProseReferenceManifestEntry",
    "RegisteredIdentifierKind", "RegisteredIdentifierGroup", "ShellWord", "ShellCommandSegment",
    "ShellSyntaxError", "ShellOccurrenceError", "scan_markdown_regions", "inventory_git_spice_occurrences",
    "classify_occurrence", "classify_git_spice_command", "parse_git_spice_arguments",
    "validate_git_spice_invocation", "audit_git_spice_occurrences", "GLOBAL_FLAG_OPTIONS",
    "GLOBAL_VALUE_OPTIONS", "PROSE_REFERENCE_MANIFEST", "READ_ONLY_COMMAND_SIGNATURES",
    "MUTATING_COMMAND_SIGNATURES",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), name);
  }
});

test("generator and focused tests remain within approved line-count limits", () => {
  const generatorLines = readText("scripts/migrate-git-spice-plugin.py").split("\n").length;
  const migrationTestLines = readText("tests/migration.test.mjs").split("\n").length;
  const packageTestLines = readText("tests/package.test.mjs").split("\n").length;
  assert.ok(generatorLines <= 1000, `generator has ${generatorLines} physical lines`);
  assert.ok(migrationTestLines + packageTestLines <= 1200, `focused tests have ${migrationTestLines + packageTestLines} physical lines`);
});

test("package exposes the exact Pi git-spice runtime and publishable metadata", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@sentiolabs/pi-git-spice");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.directory, "packages/pi-git-spice");
  assert.deepEqual(pkg.pi, {
    extensions: ["./extensions/git-spice-workflow.ts"],
    skills: ["./skills"],
    prompts: ["./prompts/*.md"],
    subagents: { agents: ["./agents"] },
  });
  assert.deepEqual(readdirSync(join(packageRoot, "prompts")).sort(), expectedGeneratedDigestPaths
    .filter((relative) => relative.startsWith("prompts/"))
    .map((relative) => relative.slice("prompts/".length)));
  assert.deepEqual(readdirSync(join(packageRoot, "skills")).sort(), ["git-spice", "stacking-workflow"]);
  assert.deepEqual(readdirSync(join(packageRoot, "agents")).sort(), ["stack-doctor.md", "stacker.md"]);
  assert.deepEqual([...migrationContract.runtime].sort(), expectedGeneratedDigestPaths);
});

test("generated prompts preserve arguments and explicit safety adaptations", () => {
  const prompts = Object.fromEntries(expectedGeneratedDigestPaths
    .filter((relative) => relative.startsWith("prompts/"))
    .map((relative) => [relative, readText(relative)]));
  for (const text of Object.values(prompts)) assert.match(text, /^---\n[\s\S]+?\n---\n/);
  for (const name of ["continue", "init", "new", "restack", "submit"]) {
    assert.match(prompts[`prompts/git-spice-${name}.md`], /\$ARGUMENTS/, name);
  }
  assert.match(prompts["prompts/git-spice-init.md"], /repo init --trunk=<name> --remote=<name>/);
  assert.match(prompts["prompts/git-spice-init.md"], /separate explicit confirmation/i);
  assert.match(prompts["prompts/git-spice-new.md"], /branch create <name> -m <message>/);
  assert.match(prompts["prompts/git-spice-new.md"], /add `-a` only after explicit approval/i);
  assert.match(prompts["prompts/git-spice-new.md"], /branch create <name> --no-commit/);
  assert.match(prompts["prompts/git-spice-continue.md"], /rebase continue --no-edit/);
  assert.match(prompts["prompts/git-spice-submit.md"], /--draft[\s\S]*--no-draft|--no-draft[\s\S]*--draft/);
  assert.match(prompts["prompts/git-spice-submit.md"], /submit --dry-run --fill <draft-flag>/);
  assert.match(prompts["prompts/git-spice-submit.md"], /reject prompt controls and conflicting draft controls/i);
  assert.match(prompts["prompts/git-spice-sync.md"], /repo sync --restack/);
  assert.doesNotMatch(Object.values(prompts).join("\n"), /\/git-spice:/);
});

test("skills and agents retain Pi identities, optional dispatch, and fresh context", () => {
  for (const relative of ["skills/git-spice/SKILL.md", "skills/stacking-workflow/SKILL.md"]) {
    const skill = readText(relative);
    assert.match(skill, /If the subagent tool is available, list agents first/);
    assert.match(skill, /git-spice\.stacker/);
    assert.match(skill, /git-spice\.stack-doctor/);
    assert.match(skill, /fresh context/);
    assert.match(skill, /same checkout concurrently/);
    assert.match(skill, /direct workflow instead/);
  }
  const stacker = readText("agents/stacker.md");
  const doctor = readText("agents/stack-doctor.md");
  assert.match(stacker, /^---\nname: stacker\npackage: git-spice\n/);
  assert.match(stacker, /tools: bash, read, write, edit, find, grep/);
  assert.match(stacker, /inheritProjectContext: true\ndefaultContext: fresh/);
  assert.match(doctor, /^---\nname: stack-doctor\npackage: git-spice\n/);
  assert.match(doctor, /tools: bash, read, find, grep/);
  assert.match(doctor, /inheritProjectContext: true\ndefaultContext: fresh/);
  assert.doesNotMatch(`${stacker}\n${doctor}`, /model: sonnet|subagent_type|  - (?:Bash|Read|Write|Edit|Glob|Grep)\n/);
});

test("generated resources omit obsolete executable and report placeholders", () => {
  const combined = expectedGeneratedDigestPaths.map(readText).join("\n");
  for (const forbidden of [
    "<extra-flags>",
    "git-spice --no-prompt commit ...",
    "<paste git-spice --no-prompt log long>",
    "<paste git-spice --no-prompt log long and git status>",
  ]) assert.equal(combined.includes(forbidden), false, forbidden);
  assert.match(combined, /<paste final stack log output>/);
  assert.match(combined, /<paste final stack log and git status output>/);
});

test("npm pack contains exactly 20 files with all 11 generated resources", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  assert.equal(packed.length, 1);
  const paths = packed[0].files.map(({ path }) => path).sort();
  assert.equal(paths.length, 20);
  assert.deepEqual(paths, expectedPackedPaths);
  assert.deepEqual(paths.filter((relative) => /^(?:agents|prompts|skills)\//.test(relative)), expectedGeneratedDigestPaths);
  assert.equal(paths.some((relative) => /^(?:scripts|tests|\.pi)\//.test(relative)), false);
  assert.equal(existsSync(migrationScript), true);
});
