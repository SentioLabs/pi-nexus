import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationScript = fileURLToPath(new URL("../scripts/migrate-git-spice-plugin.py", import.meta.url));
const runtimeManifest = JSON.parse(execFileSync("python3", [
  "-B",
  "-c",
  "import importlib.util, json, sys; spec = importlib.util.spec_from_file_location('migration', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps([target for _, target in module.RUNTIME_MANIFEST]))",
  migrationScript,
], { encoding: "utf8" }));
const productionReferenceContract = JSON.parse(execFileSync("python3", [
  "-B",
  "-c",
  "import importlib.util, json, sys; spec = importlib.util.spec_from_file_location('migration', sys.argv[1]); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(json.dumps({'approvedStructuralReasons': sorted(getattr(module, 'APPROVED_STRUCTURAL_REFERENCE_REASONS', ())), 'proseReferenceReason': module.PROSE_REFERENCE_REASON}))",
  migrationScript,
], { encoding: "utf8" }));
const readText = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));

const expectedPrompts = [
  "git-spice-continue.md", "git-spice-init.md", "git-spice-new.md",
  "git-spice-restack.md", "git-spice-stack.md", "git-spice-submit.md",
  "git-spice-sync.md",
];
const expectedSkills = ["git-spice", "stacking-workflow"];
const expectedAgents = ["stack-doctor.md", "stacker.md"];
const runtimePaths = [
  ...expectedPrompts.map((name) => `prompts/${name}`),
  ...expectedSkills.map((name) => `skills/${name}/SKILL.md`),
  ...expectedAgents.map((name) => `agents/${name}`),
];
const expectedPackedPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  ...runtimePaths,
  "extensions/git-spice-workflow.ts",
  "package.json",
  "src/adapters/command-runner.ts",
  "src/adapters/git.ts",
  "src/core/contracts.ts",
  "src/core/ports.ts",
].sort();

const auditCommittedRuntime = () => {
  const probe = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "root = pathlib.Path(sys.argv[2])",
    "result = {}",
    "for relative in sys.argv[3:]:",
    "    occurrences = module.audit_git_spice_occurrences(pathlib.Path(relative), (root / relative).read_text(encoding='utf8'))",
    "    result[relative] = [{'classification': item.classification, 'reason': item.reason, 'argv': item.argv, 'line': item.line, 'column': item.column, 'region': item.region.kind} for item in occurrences]",
    "print(json.dumps(result))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript, packageRoot, ...runtimePaths], { encoding: "utf8" }));
};

const auditSyntheticCases = (cases) => {
  const probe = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.PROSE_REFERENCE_MANIFEST = {target: () for _, target in module.RUNTIME_MANIFEST}",
    "result = []",
    "for case in json.load(sys.stdin):",
    "    try:",
    "        occurrences = module.audit_git_spice_occurrences(pathlib.Path('prompts/git-spice-stack.md'), case['text'])",
    "        result.append({'ok': True, 'argv': [item.argv for item in occurrences if item.classification == 'executable']})",
    "    except RuntimeError as error:",
    "        result.append({'ok': False, 'error': str(error)})",
    "print(json.dumps(result))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", probe, migrationScript], {
    encoding: "utf8",
    input: JSON.stringify(cases),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const expectedStructuralReasons = new Set([
  "exact registered git-spice prompt identifier",
  "exact registered git-spice agent identifier",
  "exact registered git-spice upstream identifier",
  "exact package or skill identifier",
  "exact standalone git-spice Markdown heading",
  "exact standalone inline code token",
  "exact standalone fenced code token",
]);
const exportedApprovedStructuralReasons = new Set(productionReferenceContract.approvedStructuralReasons);
const proseReferenceReason = "exact physical-line prose reference manifest match";
const executableOccurrenceReason = "occurrence is not an explicit reference";
const expectedReasonSnapshots = {
  "prompts/git-spice-continue.md": { [proseReferenceReason]: 4, [executableOccurrenceReason]: 5 },
  "prompts/git-spice-init.md": { [proseReferenceReason]: 4, [executableOccurrenceReason]: 8 },
  "prompts/git-spice-new.md": { [executableOccurrenceReason]: 7 },
  "prompts/git-spice-restack.md": { "exact registered git-spice prompt identifier": 1, [executableOccurrenceReason]: 5 },
  "prompts/git-spice-stack.md": { [proseReferenceReason]: 1, "exact registered git-spice prompt identifier": 3, [executableOccurrenceReason]: 3 },
  "prompts/git-spice-submit.md": { [proseReferenceReason]: 1, "exact registered git-spice prompt identifier": 1, [executableOccurrenceReason]: 6 },
  "prompts/git-spice-sync.md": { "exact registered git-spice prompt identifier": 1, [executableOccurrenceReason]: 4 },
  "skills/git-spice/SKILL.md": {
    "exact package or skill identifier": 1,
    [proseReferenceReason]: 16,
    "exact registered git-spice agent identifier": 2,
    "exact registered git-spice upstream identifier": 1,
    "exact standalone git-spice Markdown heading": 1,
    "exact standalone inline code token": 5,
    [executableOccurrenceReason]: 138,
  },
  "skills/stacking-workflow/SKILL.md": {
    "exact registered git-spice agent identifier": 2,
    "exact standalone inline code token": 6,
    [executableOccurrenceReason]: 12,
  },
  "agents/stack-doctor.md": {
    "exact package or skill identifier": 1,
    [proseReferenceReason]: 5,
    [executableOccurrenceReason]: 26,
  },
  "agents/stacker.md": {
    "exact package or skill identifier": 1,
    [proseReferenceReason]: 3,
    "exact standalone inline code token": 1,
    [executableOccurrenceReason]: 10,
  },
};

const assertApprovedReferenceReasons = (relative, reasons, proseReferenceReason) => {
  for (const reason of reasons) {
    assert.ok(
      exportedApprovedStructuralReasons.has(reason) || reason === proseReferenceReason,
      `${relative} has unapproved git-spice reference reason: ${JSON.stringify(reason)}`,
    );
  }
};

test("production and independent snapshots dual-lock exact structural reference reasons", () => {
  assert.deepEqual(
    Array.from(exportedApprovedStructuralReasons).sort(),
    Array.from(expectedStructuralReasons).sort(),
  );
  assert.equal(productionReferenceContract.proseReferenceReason, proseReferenceReason);
  assert.equal(exportedApprovedStructuralReasons.has("identifier-adjacent git-spice reference"), false);
  assert.equal(exportedApprovedStructuralReasons.has("shell comment reference"), false);
});

test("registered identifier groups retain only exact members and typed reasons", () => {
  const probe = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([{'kind': group.kind.value, 'identifiers': sorted(group.identifiers), 'fields': sorted(group.__dataclass_fields__), 'reason': group.reason} for group in module.REGISTERED_IDENTIFIER_GROUPS]))",
  ].join("; ");
  const contract = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript], { encoding: "utf8" }));
  assert.deepEqual(contract, [
    {
      kind: "prompt",
      identifiers: [
        "/git-spice-continue",
        "/git-spice-init",
        "/git-spice-new",
        "/git-spice-restack",
        "/git-spice-stack",
        "/git-spice-submit",
        "/git-spice-sync",
      ],
      fields: ["identifiers", "kind", "reason"],
      reason: "exact registered git-spice prompt identifier",
    },
    {
      kind: "agent",
      identifiers: ["git-spice.stack-doctor", "git-spice.stacker"],
      fields: ["identifiers", "kind", "reason"],
      reason: "exact registered git-spice agent identifier",
    },
    {
      kind: "upstream",
      identifiers: ["abhinav/git-spice#1050"],
      fields: ["identifiers", "kind", "reason"],
      reason: "exact registered git-spice upstream identifier",
    },
  ]);
});

test("legacy pathless audits, boundary inference, and package Markdown parsers are absent", () => {
  const pythonNames = [
    "classify_git_spice_" + "occurrences",
    "executable_git_spice_" + "invocations",
    "executable_git_spice_" + "commands",
    "IdentifierBoundary" + "Policy",
    "_shell_position_" + "reason",
    "_terminal_dot_" + "boundary",
    "validate_generated_" + "commands",
  ];
  const probe = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps({name: hasattr(module, name) for name in sys.argv[2:]}))",
  ].join("; ");
  const attributes = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript, ...pythonNames], { encoding: "utf8" }));
  assert.deepEqual(attributes, Object.fromEntries(pythonNames.map((name) => [name, false])));

  const packageTestSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const parserName of ["executable" + "Snippets", "invocationsIn" + "Snippet"]) {
    assert.equal(packageTestSource.includes(`const ${parserName} =`), false, parserName);
  }
});

test("registered identifier boundaries reject terminal punctuation followed by attached text after bounded and long closing runs", () => {
  const cases = [];
  for (const [kind, identifier] of [
    ["prompt", "/git-spice-init"],
    ["agent", "git-spice.stacker"],
    ["upstream", "abhinav/git-spice#1050"],
  ]) {
    for (const closingRunLength of [1, 7, 1024]) {
      const closingRun = Array.from(
        { length: closingRunLength },
        (_, index) => ")]}"[index % 3],
      ).join("");
      for (const punctuation of [",", ";", ":", "!", "?"]) {
        cases.push({
          kind,
          closingRunLength,
          punctuation,
          text: `${identifier}.${closingRun}${punctuation}future-mutate`,
        });
      }
    }
  }

  const probe = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "result = []",
    "for item in json.load(sys.stdin):",
    "    text = item['text']",
    "    occurrences = module.inventory_git_spice_occurrences(text, module.scan_markdown_regions(text))",
    "    if len(occurrences) != 1: raise RuntimeError('expected exactly one direct-probe occurrence')",
    "    reason = module._registered_identifier_reference_reason(text, occurrences[0])",
    "    if reason is not None: result.append({**item, 'reason': reason})",
    "print(json.dumps(result))",
  ].join("\n");
  const structuralMatches = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript], {
    encoding: "utf8",
    input: JSON.stringify(cases),
  }));

  assert.equal(cases.length, 45);
  assert.deepEqual(structuralMatches, []);
});

test("target-aware audit extracts unmanifested plain commands without shell-position filtering", () => {
  const results = auditSyntheticCases([
    { text: "Run git-spice --no-prompt log long" },
    { text: "arbitrary words git-spice future mutate" },
  ]);
  assert.deepEqual(results[0], { ok: true, argv: [["git-spice", "--no-prompt", "log", "long"]] });
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /unclassified git-spice subcommand/);
});

test("package contract independently locks ordered prompt and restack policy outcomes", () => {
  const cases = [
    { text: "`git-spice --prompt --no-prompt log long`", ok: true },
    { text: "`git-spice --no-prompt --prompt log long`", ok: false },
    { text: "`git-spice --no-prompt --prompt=false log long`", ok: true },
    { text: "`git-spice --prompt=false log long`", ok: false },
    { text: "`git-spice --no-prompt repo sync --restack=none --restack=upstack`", ok: true },
    { text: "`git-spice --no-prompt repo sync --restack=upstack --restack=none`", ok: false },
    { text: "`git-spice --no-prompt rs --restack=upstack`", ok: true },
    { text: "`git-spice --no-prompt rs --restack=future`", ok: false },
    { text: "`git-spice --no-prompt rs --restack=future --restack`", ok: true },
  ];
  const results = auditSyntheticCases(cases);
  assert.deepEqual(results.map(({ ok }) => ok), cases.map(({ ok }) => ok));
  assert.deepEqual(results[0].argv, [["git-spice", "--prompt", "--no-prompt", "log", "long"]]);
  assert.deepEqual(results[4].argv, [["git-spice", "--no-prompt", "repo", "sync", "--restack=none", "--restack=upstack"]]);
  assert.match(results[1].error, /prompting must be disabled by final effective state/);
  assert.match(results[3].error, /explicit --no-prompt/);
  assert.match(results[5].error, /restack/);
  assert.match(results[7].error, /restack/);
});

test("positive occurrence audit rejects an unapproved generic reference reason", () => {
  assert.throws(
    () => assertApprovedReferenceReasons("synthetic.md", ["generic prose heuristic"], "manifest reason"),
    /unapproved git-spice reference reason/,
  );
});

test("committed runtime occurrence inventories reconcile with exact reasons and executable argv", () => {
  const audit = auditCommittedRuntime();
  for (const relative of runtimePaths) {
    const occurrences = audit[relative];
    const references = occurrences.filter(({ classification }) => classification === "reference");
    const executables = occurrences.filter(({ classification }) => classification === "executable");
    assert.ok(occurrences.length > 0, `${relative} inventories git-spice occurrences`);
    assert.equal(occurrences.length, references.length + executables.length, `${relative} reconciles every occurrence`);
    assert.ok(executables.length > 0, `${relative} validates executable guidance`);
    assert.ok(occurrences.every(({ reason }) => reason.length > 0), `${relative} records every classification reason`);
    assert.ok(references.every(({ argv }) => argv === null), `${relative} gives references no executable argv`);
    assert.ok(executables.every(({ argv }) => Array.isArray(argv) && argv[0] === "git-spice"), `${relative} exposes argv for every executable`);
    assertApprovedReferenceReasons(relative, references.map(({ reason }) => reason), proseReferenceReason);
    const reasonCounts = Object.fromEntries(Array.from(new Set(occurrences.map(({ reason }) => reason))).map((reason) => [
      reason,
      occurrences.filter((occurrence) => occurrence.reason === reason).length,
    ]));
    assert.deepEqual(reasonCounts, expectedReasonSnapshots[relative], `${relative} exact occurrence reason snapshot`);
  }
});

test("committed sentence-final bare git-spice reference is prose-manifest-backed", () => {
  const physicalLine = "- **base** — the branch a given branch was created from. Stored as metadata by git-spice.";
  const probe = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "path = pathlib.Path('skills/git-spice/SKILL.md')",
    "text = pathlib.Path(sys.argv[2], path).read_text(encoding='utf8')",
    "occurrences = module.audit_git_spice_occurrences(path, text)",
    "line = sys.argv[3]",
    "print(json.dumps([{'line': item.physical_line, 'reason': item.reason} for item in occurrences if item.physical_line == line]))",
  ].join("\n");
  const occurrences = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript, packageRoot, physicalLine], { encoding: "utf8" }));
  assert.deepEqual(occurrences, [{ line: physicalLine, reason: productionReferenceContract.proseReferenceReason }]);
});

test("committed runtime uses every static prose manifest entry at exact cardinality", () => {
  const probe = [
    "import collections, importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "root = pathlib.Path(sys.argv[2])",
    "result = {}",
    "for relative in sys.argv[3:]:",
    "    occurrences = module.audit_git_spice_occurrences(pathlib.Path(relative), (root / relative).read_text(encoding='utf8'))",
    "    used = collections.Counter(item.physical_line for item in occurrences if item.reason == module.PROSE_REFERENCE_REASON)",
    "    result[relative] = [{'line': entry.exact_physical_line, 'expected': entry.expected_count, 'actual': used[entry.exact_physical_line]} for entry in module.PROSE_REFERENCE_MANIFEST[relative]]",
    "print(json.dumps(result))",
  ].join("\n");
  const audit = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript, packageRoot, ...runtimePaths], { encoding: "utf8" }));
  assert.deepEqual(Object.keys(audit).sort(), [...runtimePaths].sort());
  for (const relative of runtimePaths) {
    for (const entry of audit[relative]) {
      assert.ok(entry.line.includes("git-spice"), `${relative} manifest entry contains the literal token`);
      assert.ok(entry.expected > 0, `${relative} manifest cardinality is positive`);
      assert.equal(entry.actual, entry.expected, `${relative} uses ${JSON.stringify(entry.line)} exactly`);
    }
  }
});

test("package exposes the exact Pi git-spice runtime", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@sentiolabs/pi-git-spice");
  assert.deepEqual(pkg.pi, {
    extensions: ["./extensions/git-spice-workflow.ts"],
    skills: ["./skills"],
    prompts: ["./prompts/*.md"],
    subagents: { agents: ["./agents"] },
  });
  assert.deepEqual(readdirSync(new URL("../prompts", import.meta.url)).sort(), expectedPrompts);
  assert.deepEqual(readdirSync(new URL("../skills", import.meta.url)).sort(), expectedSkills);
  assert.deepEqual(readdirSync(new URL("../agents", import.meta.url)).sort(), expectedAgents);
});

test("package metadata is publishable Pi package metadata", () => {
  const pkg = readJson("package.json");
  assert.match(pkg.version, /^0\.1\.0$/);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.directory, "packages/pi-git-spice");
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.deepEqual(pkg.scripts, {
    test: "node --test tests/*.test.mjs && npm run typecheck",
    typecheck: "tsc -p tsconfig.json",
    "pack:dry-run": "npm pack --dry-run",
    prepublishOnly: "npm test && npm run pack:dry-run",
  });
  assert.deepEqual(pkg.files, ["agents/", "extensions/", "prompts/", "skills/", "src/", "README.md", "CHANGELOG.md", "LICENSE"]);
  assert.deepEqual(pkg.peerDependencies, {
    "@earendil-works/pi-coding-agent": "^0.84.3",
    "@earendil-works/pi-tui": "^0.84.3",
    typebox: "^1.3.7",
  });
  assert.deepEqual(pkg.devDependencies, {
    "@earendil-works/pi-coding-agent": "^0.84.3",
    "@earendil-works/pi-tui": "^0.84.3",
    "@types/node": "^24.13.3",
    typebox: "^1.3.7",
    typescript: "^5.9.3",
  });
  assert.equal(pkg.scripts.prepare, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
});

test("prompts retain arguments and make every mutation non-interactive", () => {
  const prompts = Object.fromEntries(expectedPrompts.map((name) => [name, readText(`prompts/${name}`)]));
  for (const name of expectedPrompts) assert.match(prompts[name], /^---\n[\s\S]+?\n---\n/);
  for (const name of ["git-spice-continue.md", "git-spice-init.md", "git-spice-new.md", "git-spice-restack.md", "git-spice-submit.md"]) {
    assert.match(prompts[name], /\$ARGUMENTS/, name);
  }
  assert.match(prompts["git-spice-init.md"], /git-spice --no-prompt repo init --trunk=<name> --remote=<name>/);
  assert.match(prompts["git-spice-init.md"], /separate explicit confirmation/i);
  assert.doesNotMatch(prompts["git-spice-init.md"], /Otherwise let the interactive prompt run/);
  assert.doesNotMatch(prompts["git-spice-init.md"], /git-spice --no-prompt repo init --reset/);
  assert.match(prompts["git-spice-new.md"], /branch create <name> -m <message>/);
  assert.doesNotMatch(prompts["git-spice-new.md"], /auto-generate from the commit message/);
  assert.match(prompts["git-spice-new.md"], /Add `-a` only after explicit approval/i);
  assert.match(prompts["git-spice-new.md"], /branch create <name> --no-commit/);
  assert.match(prompts["git-spice-continue.md"], /git-spice --no-prompt rebase continue --no-edit/);
  assert.match(prompts["git-spice-continue.md"], /terminal-only/i);
  assert.match(prompts["git-spice-continue.md"], /missing configuration[\s\S]*report[\s\S]*rather than enabling prompts/i);
  assert.match(prompts["git-spice-submit.md"], /--draft.*--no-draft|--no-draft.*--draft/s);
  assert.match(prompts["git-spice-submit.md"], /spice\.submit\.draft/);
  assert.match(prompts["git-spice-submit.md"], /--dry-run/);
  for (const name of ["git-spice-restack.md", "git-spice-sync.md"]) assert.match(prompts[name], /--no-prompt/, name);
  assert.doesNotMatch(Object.values(prompts).join("\n"), /\/git-spice:/);
});

test("skills provide guarded optional subagent routing and direct fallback", () => {
  for (const name of expectedSkills) {
    const skill = readText(`skills/${name}/SKILL.md`);
    assert.match(skill, new RegExp(`\\nname: ${name}\\n`));
    assert.match(skill, /\nlicense: MIT\n/);
    assert.match(skill, /If the subagent tool is available, list agents first/);
    assert.match(skill, /git-spice\.stacker/);
    assert.match(skill, /git-spice\.stack-doctor/);
    assert.match(skill, /fresh context/);
    assert.match(skill, /same checkout concurrently/);
    assert.match(skill, /direct workflow instead/);
    assert.doesNotMatch(skill, /subagent_type|\/git-spice:/);
  }
});

test("agents expose dotted Pi identities and safe tool contracts", () => {
  const stacker = readText("agents/stacker.md");
  const doctor = readText("agents/stack-doctor.md");
  assert.match(stacker, /^---\nname: stacker\npackage: git-spice\n/);
  assert.match(stacker, /\ntools: bash, read, write, edit, find, grep\n/);
  assert.match(stacker, /\ninheritProjectContext: true\ndefaultContext: fresh\n/);
  assert.match(stacker, /git-spice --no-prompt branch create <prefix><slug> -m "<subject>"/);
  assert.match(doctor, /^---\nname: stack-doctor\npackage: git-spice\n/);
  assert.match(doctor, /\ntools: bash, read, find, grep\n/);
  assert.match(doctor, /\ninheritProjectContext: true\ndefaultContext: fresh\n/);
  assert.match(doctor, /git-spice --no-prompt rebase continue --no-edit/);
  assert.match(doctor, /git-spice --no-prompt <scope> submit --force <draft-flag>/);
  assert.match(doctor, /--draft.*--no-draft|--no-draft.*--draft/s);
  assert.match(doctor, /git-spice --no-prompt branch track <branch>/);
  assert.match(doctor, /git-spice --no-prompt downstack track <top-branch>/);
  assert.match(doctor, /gather or derive[\s\S]*branch name/i);
  assert.match(doctor, /ambiguous[\s\S]*missing configuration[\s\S]*rather than enabling prompts/i);
  assert.doesNotMatch(`${stacker}\n${doctor}`, /model: sonnet|subagent_type|  - (?:Bash|Read|Write|Edit|Glob|Grep)\n/);
});

test("authoritative audit exposes command-specific safe argv for every generated executable", () => {
  const audit = auditCommittedRuntime();
  for (const relative of runtimePaths) {
    const commands = audit[relative]
      .filter(({ classification }) => classification === "executable")
      .map(({ argv }) => argv.join(" "));
    assert.ok(commands.length > 0, `${relative} exposes executable git-spice guidance`);
    for (const command of commands) {
      assert.match(command, /^git-spice --no-prompt /, `${relative}: ${command}`);
      if (/^git-spice --no-prompt (?:repo init|r i)\b/.test(command)) {
        assert.match(command, /(?:^| )--trunk=<[^>]+>/, `${relative}: ${command}`);
        assert.match(command, /(?:^| )--remote=<[^>]+>/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:branch create|bc)\b/.test(command)) {
        assert.match(command, /(?:^| )-m (?:[^ ]+|<[^>]+>)|(?:^| )--message(?:=| )|(?:^| )--no-commit(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:rebase continue|rbc)\b/.test(command)) {
        assert.match(command, /(?:^| )--no-edit(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:(?:branch|upstack|downstack|stack|<scope>) submit|bs|dss|uss|ss)\b/.test(command) && !/(?:^| )--update-only(?: |$)/.test(command)) {
        assert.match(command, /(?:^| )(?:--draft|--no-draft|<draft-flag>)(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:repo sync|rs)\b/.test(command)) {
        assert.match(command, /(?:^| )--restack(?:=upstack)?(?: |$)/, `${relative}: ${command}`);
      }
    }
  }
});

test("direct submit workflows explicitly resolve draft state with the update-only exception", () => {
  for (const relative of [
    "prompts/git-spice-submit.md",
    "skills/git-spice/SKILL.md",
    "skills/stacking-workflow/SKILL.md",
    "agents/stack-doctor.md",
  ]) {
    const text = readText(relative);
    assert.match(text, /arguments?[\s\S]*spice\.submit\.draft[\s\S]*(?:user-question|question tool)[\s\S]*plain chat/i, relative);
    assert.match(text, /--draft[\s\S]*--no-draft|--no-draft[\s\S]*--draft/s, relative);
    assert.match(text, /--update-only[\s\S]*(?:exception|no new|cannot create|skip)/i, relative);
  }
});

test("every direct init and reset path gathers explicit trunk and remote safely", () => {
  const audit = auditCommittedRuntime();
  for (const relative of ["prompts/git-spice-init.md", "skills/git-spice/SKILL.md", "agents/stack-doctor.md"]) {
    const text = readText(relative);
    const initCommands = audit[relative]
      .filter(({ classification, argv }) => classification === "executable" && argv.slice(0, 4).join(" ") === "git-spice --no-prompt repo init")
      .map(({ argv }) => argv.join(" "));
    assert.ok(initCommands.length > 0, relative);
    for (const command of initCommands) {
      assert.match(command, /--trunk=<[^>]+>/, `${relative}: ${command}`);
      assert.match(command, /--remote=<[^>]+>/, `${relative}: ${command}`);
    }
    assert.match(text, /(?:user-question|question tool)[\s\S]*plain chat/i, relative);
    assert.match(text, /reset[\s\S]*(?:forget|tracking)[\s\S]*separate explicit confirmation/i, relative);
  }
});

test("npm pack contains the exact generated runtime and no maintainer tooling", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  assert.equal(packed.length, 1);
  const paths = new Set(packed[0].files.map(({ path }) => path));
  assert.equal(paths.size, 20);
  assert.deepEqual([...paths].sort(), expectedPackedPaths);
  assert.deepEqual([...runtimeManifest].sort(), [...runtimePaths].sort(), "the exact 11 generated resources remain packed");
  assert.equal([...paths].some((p) => p.startsWith("scripts/") || p.startsWith("tests/") || p.startsWith(".pi/")), false);
  assert.deepEqual(
    [...paths].filter((p) => p.startsWith("agents/") || p.startsWith("prompts/") || p.startsWith("skills/")).sort(),
    [...runtimeManifest].sort(),
  );
  assert.equal(existsSync(new URL("../scripts/migrate-git-spice-plugin.py", import.meta.url)), true);
});
