import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const readText = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));

const expectedPrompts = [
  "git-spice-continue.md", "git-spice-init.md", "git-spice-new.md",
  "git-spice-restack.md", "git-spice-stack.md", "git-spice-submit.md",
  "git-spice-sync.md",
];
const expectedSkills = ["git-spice", "stacking-workflow"];
const expectedAgents = ["stack-doctor.md", "stacker.md"];
const readOnlyCommandSignatures = [
  ["auth", "status"], ["log", "short"], ["log", "long"], ["branch", "diff"], ["ls"], ["ll"], ["bdi"],
];
const mutatingCommandSignatures = [
  ["repo", "init"], ["repo", "restack"], ["repo", "sync"], ["auth", "login"], ["auth", "logout"],
  ["branch", "create"], ["branch", "track"], ["branch", "checkout"], ["branch", "restack"],
  ["branch", "squash"], ["branch", "split"], ["branch", "edit"], ["branch", "fold"], ["branch", "onto"],
  ["branch", "rename"], ["branch", "delete"], ["branch", "untrack"], ["branch", "submit"],
  ["commit", "create"], ["commit", "amend"], ["commit", "split"], ["commit", "fixup"], ["commit", "pick"],
  ["commit", "..."], ["upstack", "restack"], ["upstack", "onto"], ["upstack", "delete"],
  ["upstack", "submit"], ["downstack", "track"], ["downstack", "restack"], ["downstack", "edit"],
  ["downstack", "submit"], ["stack", "restack"], ["stack", "edit"], ["stack", "delete"],
  ["stack", "submit"], ["rebase", "continue"], ["rebase", "abort"], ["<scope>", "submit"],
  ["trunk"], ["top"], ["bottom"], ["up"], ["down"], ["r", "i"], ["bc"], ["btr"], ["dstr"],
  ["cc"], ["ca"], ["csp"], ["cf"], ["cp"], ["bco"], ["br"], ["usr"], ["dsr"], ["sr"], ["rr"],
  ["bsq"], ["bsp"], ["be"], ["bfo"], ["bon"], ["uso"], ["se"], ["dse"], ["brn"], ["bd"],
  ["sd"], ["usd"], ["buntr"], ["bs"], ["dss"], ["uss"], ["ss"], ["rs"], ["rbc"], ["rba"],
];
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

const executableSnippets = (text) => {
  const bareCommands = text.split("\n").map((line) => line.trim()).filter((line) => /^\(?\s*git-spice(?:\s|$)/.test(line));
  return [
    ...Array.from(text.matchAll(/(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g), ([, , snippet]) => snippet.trim()),
    ...Array.from(text.matchAll(/^```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)^```[ \t]*$/gm), ([, block]) => block),
    ...bareCommands,
  ].filter((snippet) => snippet.includes("git-spice"));
};

const invocationsInSnippet = (snippet) => {
  const invocations = [];
  for (const match of snippet.matchAll(/(?<![\w-])git-spice(?=\s)/g)) {
    let quote = null;
    let end = match.index + match[0].length;
    for (; end < snippet.length; end += 1) {
      const character = snippet[end];
      if (character === "\\" && snippet[end + 1] === "\n") {
        end += 1;
        continue;
      }
      if (quote) {
        if (character === quote && snippet[end - 1] !== "\\") quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "#" && /\s/.test(snippet[end - 1] ?? "")) break;
      if (character === "\n" || ";&|()".includes(character)) break;
    }
    invocations.push(snippet.slice(match.index, end).replace(/\\\r?\n/g, " ").trim());
  }
  return invocations;
};

const executableGitSpiceCommands = (text) => executableSnippets(text).flatMap(invocationsInSnippet);

const classifyGitSpiceCommand = (command) => {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const argumentsAfterGlobalFlag = tokens.slice(2);
  for (const [classification, signatures] of [["read-only", readOnlyCommandSignatures], ["mutation", mutatingCommandSignatures]]) {
    if (signatures.some((signature) => signature.every((part, index) => argumentsAfterGlobalFlag[index] === part))) return classification;
  }
  return null;
};

test("package command audit extracts bare unknown commands without known-prefix filtering", () => {
  assert.deepEqual(executableGitSpiceCommands("git-spice future mutate"), ["git-spice future mutate"]);
  assert.deepEqual(executableGitSpiceCommands("git-spice --verbose future mutate"), ["git-spice --verbose future mutate"]);
});

test("committed runtime occurrence inventories reconcile and validate independently", () => {
  const probe = [
    "import importlib.util, json, pathlib, sys",
    "spec = importlib.util.spec_from_file_location('migration', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "root = pathlib.Path(sys.argv[2])",
    "result = {}",
    "for relative in sys.argv[3:]:",
    "    occurrences = module.audit_git_spice_occurrences(pathlib.Path(relative), (root / relative).read_text(encoding='utf8'))",
    "    result[relative] = {'inventory': len(occurrences), 'references': sum(item.classification == 'reference' for item in occurrences), 'executables': sum(item.classification == 'executable' for item in occurrences), 'reasons': [item.reason for item in occurrences]}",
    "print(json.dumps(result))",
  ].join("\n");
  const audit = JSON.parse(execFileSync("python3", ["-B", "-c", probe, migrationScript, packageRoot, ...runtimePaths], { encoding: "utf8" }));
  for (const relative of runtimePaths) {
    const result = audit[relative];
    assert.ok(result.inventory > 0, `${relative} inventories git-spice occurrences`);
    assert.equal(result.inventory, result.references + result.executables, `${relative} reconciles every occurrence`);
    assert.ok(result.executables > 0, `${relative} validates executable guidance`);
    assert.ok(result.reasons.every((reason) => reason.length > 0), `${relative} records every classification reason`);
    assert.ok(result.reasons.every((reason) => !/capitalized|tabular|Markdown-formatted|cue word/i.test(reason)), `${relative} uses structural classification reasons`);
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

test("every executable command in every generated resource has command-specific safety", () => {
  for (const relative of runtimePaths) {
    const commands = executableGitSpiceCommands(readText(relative));
    assert.ok(commands.length > 0, `${relative} exposes executable git-spice guidance`);
    for (const command of commands) {
      assert.match(command, /^git-spice --no-prompt /, `${relative}: ${command}`);
      assert.notEqual(classifyGitSpiceCommand(command), null, `${relative}: unclassified command: ${command}`);
      if (/^git-spice --no-prompt (?:repo init|r i)\b/.test(command)) {
        assert.match(command, /(?:^| )--trunk=<[^>]+>/, `${relative}: ${command}`);
        assert.match(command, /(?:^| )--remote=<[^>]+>/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:branch create|bc)\b/.test(command)) {
        assert.match(command, /(?:^| )-m (?:"[^"]+"|<[^>]+>)|(?:^| )--message(?:=| )|(?:^| )--no-commit(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:rebase continue|rbc)\b/.test(command)) {
        assert.match(command, /(?:^| )--no-edit(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:(?:branch|upstack|downstack|stack|<scope>) submit|bs|dss|uss|ss)\b/.test(command) && !/(?:^| )--update-only(?: |$)/.test(command)) {
        assert.match(command, /(?:^| )(?:--draft|--no-draft|<draft-flag>)(?: |$)/, `${relative}: ${command}`);
      }
      if (/^git-spice --no-prompt (?:repo sync|rs)\b/.test(command)) {
        assert.match(command, /(?:^| )--restack(?:=\S+)?(?: |$)/, `${relative}: ${command}`);
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
  for (const relative of ["prompts/git-spice-init.md", "skills/git-spice/SKILL.md", "agents/stack-doctor.md"]) {
    const text = readText(relative);
    const initCommands = executableGitSpiceCommands(text).filter((command) => /^git-spice --no-prompt repo init\b/.test(command));
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
