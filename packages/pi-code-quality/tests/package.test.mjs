import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package exposes code-quality skills and prompts to Pi", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-code-quality");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.directory, "packages/pi-code-quality");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("prompts/"));
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.keywords.includes("ai-slop"));
  assert.ok(pkg.keywords.includes("pr-size"));
  assert.ok(pkg.keywords.includes("reviewability"));
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
  assert.match(skill, /ask_user_question/);
  assert.doesNotMatch(skill, /\/code-quality:slop/);
  assert.doesNotMatch(skill, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(skill, /AskUserQuestion/);
});

test("size-review skill frontmatter is valid for Pi discovery", () => {
  const skill = readText("skills/size-review/SKILL.md");

  assert.match(skill, /^---\n/);
  assert.match(skill, /\nname: size-review\n/);
  const description = (skill.match(/\ndescription:\s*(?:[>|]\n)?([\s\S]+?)\nlicense:\s*MIT\n/)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(description.length >= 20, "description should be descriptive");
  assert.ok(description.length <= 1024, "description should fit Pi skill metadata limits");
  assert.match(skill, /\nlicense: MIT\n/);
});

test("size-review preserves source threshold and stack analysis behavior", () => {
  const skill = readText("skills/size-review/SKILL.md");

  assert.match(skill, /More than \*\*20 files changed\*\*/);
  assert.match(skill, /More than \*\*500 lines added\*\*/);
  assert.match(skill, /More than \*\*30 commits\*\*/);
  assert.match(skill, /\*\*3 or more top-level directories touched\*\*/);
  assert.match(skill, /raw → .* after exclusions/);
  assert.match(skill, /Cumulative/);
  assert.match(skill, /Slice/);
  assert.match(skill, /references\/default-exclusions\.md/);
  assert.match(skill, /ask_user_question/);
  assert.doesNotMatch(skill, /\/code-quality:size/);
  assert.doesNotMatch(skill, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(skill, /CLAUDE_SIZE_REVIEW\.md/);
});

test("prompt aliases point at the correct skills", () => {
  const slopPrompt = readText("prompts/code-quality-slop.md");
  const sizePrompt = readText("prompts/code-quality-size.md");

  assert.match(slopPrompt, /^---\n/);
  assert.match(slopPrompt, /description: Run an AI slop\/code-quality review/);
  assert.match(slopPrompt, /argument-hint: "\[scope\]"/);
  assert.match(slopPrompt, /Use the `slop-review` skill/);
  assert.match(slopPrompt, /\$ARGUMENTS/);
  assert.doesNotMatch(slopPrompt, /\/code-quality:slop/);

  assert.match(sizePrompt, /^---\n/);
  assert.match(sizePrompt, /description: Run a PR or branch size review/);
  assert.match(sizePrompt, /argument-hint: "\[scope\]"/);
  assert.match(sizePrompt, /Use the `size-review` skill/);
  assert.match(sizePrompt, /\$ARGUMENTS/);
  assert.doesNotMatch(sizePrompt, /\/code-quality:size/);
});

test("slop-review language reference files are bundled", () => {
  for (const reference of ["go", "python", "rust", "svelte-ts"]) {
    const content = readText(`skills/slop-review/references/${reference}.md`);
    assert.match(content, /^# .+AI Slop Signals/m);
  }
});

test("size-review default exclusions are bundled", () => {
  const content = readText("skills/size-review/references/default-exclusions.md");

  assert.match(content, /^# Universal default exclusions for size-review/m);
  assert.match(content, /go\.sum/);
  assert.match(content, /\*\*\/package-lock\.json/);
  assert.match(content, /\*\*\/\*\.pb\.go/);
  assert.match(content, /\*\*\/__generated__\/\*\*/);
});

test("README documents both portable review workflows", () => {
  const readme = readText("README.md");

  assert.match(readme, /parallel agent tool/);
  assert.match(readme, /sequential/i);
  assert.match(readme, /\/code-quality-slop/);
  assert.match(readme, /\/skill:slop-review/);
  assert.match(readme, /\/code-quality-size/);
  assert.match(readme, /\/skill:size-review/);
  assert.match(readme, /raw vs post-exclusion size/);
});
