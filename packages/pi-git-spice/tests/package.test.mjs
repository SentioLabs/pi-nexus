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
const gitSpiceAliasNames = [
  "r", "ls", "ll", "bdi", "bc", "btr", "dstr", "cc", "ca", "csp", "cf", "cp", "bco", "br",
  "usr", "dsr", "sr", "rr", "bsq", "bsp", "be", "bfo", "bon", "uso", "se", "dse", "brn", "bd",
  "sd", "usd", "buntr", "bs", "dss", "uss", "ss", "rs", "rbc", "rba",
];
const runtimePaths = [
  ...expectedPrompts.map((name) => `prompts/${name}`),
  ...expectedSkills.map((name) => `skills/${name}/SKILL.md`),
  ...expectedAgents.map((name) => `agents/${name}`),
];

const executableGitSpiceCommands = (text) => {
  const snippets = [
    ...Array.from(text.matchAll(/`([^`\n]+)`/g), ([, snippet]) => snippet.trim()),
    ...Array.from(text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g), ([, block]) => block.split("\n").map((line) => line.trim())),
  ].flat();
  const knownCommand = new RegExp(`^git-spice (?:--no-prompt )?(?:repo|auth|log|branch|commit|upstack|downstack|stack|rebase|trunk|top|bottom|up|down|<scope>|${gitSpiceAliasNames.join("|")})(?:\\s|$)`);
  return snippets.filter((snippet) => knownCommand.test(snippet));
};

test("package exposes the exact Pi git-spice runtime", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@sentiolabs/pi-git-spice");
  assert.deepEqual(pkg.pi, {
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
  assert.deepEqual(pkg.files, ["agents/", "prompts/", "skills/", "README.md", "CHANGELOG.md", "LICENSE"]);
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
  assert.doesNotMatch(`${stacker}\n${doctor}`, /model: sonnet|subagent_type|  - (?:Bash|Read|Write|Edit|Glob|Grep)\n/);
});

test("every executable command in every generated resource has command-specific safety", () => {
  for (const relative of runtimePaths) {
    const commands = executableGitSpiceCommands(readText(relative));
    assert.ok(commands.length > 0, `${relative} exposes executable git-spice guidance`);
    for (const command of commands) {
      assert.match(command, /^git-spice --no-prompt /, `${relative}: ${command}`);
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
  for (const runtimePath of runtimeManifest) {
    assert.equal(paths.has(runtimePath), true, `${runtimePath} should be packed`);
  }
  assert.equal([...paths].some((p) => p.startsWith("scripts/") || p.startsWith("tests/") || p.startsWith(".pi/")), false);
  assert.deepEqual(
    [...paths].filter((p) => p.startsWith("agents/") || p.startsWith("prompts/") || p.startsWith("skills/")).sort(),
    [...runtimeManifest].sort(),
  );
  assert.equal(existsSync(new URL("../scripts/migrate-git-spice-plugin.py", import.meta.url)), true);
});
