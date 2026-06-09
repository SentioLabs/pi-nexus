import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package exposes the slop-review skill and prompt to Pi", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-code-quality");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.directory, "packages/pi-code-quality");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("prompts/"));
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("ai-slop"));
});

test("slop-review skill frontmatter is valid for Pi discovery", () => {
  const skill = readText("skills/slop-review/SKILL.md");

  assert.match(skill, /^---\n/);
  assert.match(skill, /\nname: slop-review\n/);
  const description = skill.match(/\ndescription: (.+)\n/)?.[1] ?? "";
  assert.ok(description.length >= 20, "description should be descriptive");
  assert.ok(description.length <= 1024, "description should fit Pi skill metadata limits");
  assert.match(skill, /\nlicense: MIT\n/);
});

test("slop-review skill contains Pi-specific portability guards", () => {
  const skill = readText("skills/slop-review/SKILL.md");

  assert.match(skill, /Execution Model and Model Tier Intent/);
  assert.match(skill, /Pi\/source-fidelity guard/);
  assert.match(skill, /Do \*\*not\*\* use `\[ ! -t 0 \]` in Pi/);
  assert.doesNotMatch(skill, /\/code-quality:slop/);
  assert.doesNotMatch(skill, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test("code-quality-slop prompt alias points at slop-review", () => {
  const prompt = readText("prompts/code-quality-slop.md");

  assert.match(prompt, /^---\n/);
  assert.match(prompt, /description: Run an AI slop\/code-quality review/);
  assert.match(prompt, /argument-hint: "\[scope\]"/);
  assert.match(prompt, /Use the `slop-review` skill/);
});

test("language reference files are bundled", () => {
  for (const reference of ["go", "python", "rust", "svelte-ts"]) {
    const content = readText(`skills/slop-review/references/${reference}.md`);
    assert.match(content, /^# .+AI Slop Signals/m);
  }
});

test("README documents portable execution behavior", () => {
  const readme = readText("README.md");

  assert.match(readme, /parallel agent tool/);
  assert.match(readme, /sequential/i);
  assert.match(readme, /\/code-quality-slop/);
  assert.match(readme, /\/skill:slop-review/);
});
