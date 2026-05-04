import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package exposes the frontend-design skill to Pi", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-frontend-design");
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.repository.directory, "packages/frontend-design");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.ok(pkg.files.includes("skills/"));
});

test("frontend-design skill frontmatter is valid for Pi discovery", () => {
  const skill = readText("skills/frontend-design/SKILL.md");

  assert.match(skill, /^---\n/);
  assert.match(skill, /\nname: frontend-design\n/);
  assert.match(skill, /\ndescription: .{20,1024}\n/);
  assert.match(skill, /\nlicense: Apache-2\.0\n/);
});
