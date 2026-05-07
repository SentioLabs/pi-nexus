import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package exposes extension, skill, and prompt to Pi", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@sentiolabs/pi-scriptable-statusline");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.directory, "packages/pi-scriptable-statusline");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/statusline.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
  assert.ok(pkg.files.includes("extensions/"));
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("prompts/"));
  assert.ok(pkg.files.includes("templates/"));
  assert.ok(pkg.files.includes("index.d.ts"));
});

test("statusline-setup skill frontmatter is valid", () => {
  const skill = readText("skills/statusline-setup/SKILL.md");
  assert.match(skill, /^---\n/);
  assert.match(skill, /\nname: statusline-setup\n/);
  assert.match(skill, /\ndescription: .{20,1024}\n/);
  assert.match(skill, /\nlicense: MIT\n/);
  assert.match(skill, /~\/\.pi\/agent\/scriptable-statusline\/render\.ts/);
});

test("statusline prompt alias points at the setup skill", () => {
  const prompt = readText("prompts/statusline.md");
  assert.match(prompt, /^---\n/);
  assert.match(prompt, /description: Use the statusline-setup skill/);
  assert.match(prompt, /Use the `statusline-setup` skill/);
});

test("README documents footer ownership and renderer API", () => {
  const readme = readText("README.md");
  assert.match(readme, /owns Pi's footer/);
  assert.match(readme, /Disable other footer replacement packages/);
  assert.match(readme, /StatuslineRenderer/);
  assert.match(readme, /\/statusline init/);
});
