import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("deep-review skill frontmatter is valid for Pi discovery", () => {
  const skill = readText("skills/deep-review/SKILL.md");
  assert.match(skill, /^---\n/);
  assert.match(skill, /\nname: deep-review\n/);
  const description = (skill.match(/\ndescription:\s*(?:[>|]\n)?([\s\S]+?)\nlicense:\s*MIT\n/)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(description.length >= 20);
  assert.ok(description.length <= 1024);
  assert.match(skill, /\nlicense: MIT\n/);
});

test("package exposes only canonical review resources", () => {
  assert.equal(existsSync(new URL("../skills/deep-review/SKILL.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../skills/size-review/SKILL.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../prompts/code-quality-review.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../prompts/code-quality-size.md", import.meta.url)), true);
  assert.equal(existsSync(new URL("../skills/slop-review/SKILL.md", import.meta.url)), false);
  assert.equal(existsSync(new URL("../prompts/code-quality-slop.md", import.meta.url)), false);
});

test("deep-review preserves five-lens grading and advisory separation", () => {
  const skill = readText("skills/deep-review/SKILL.md");
  assert.match(skill, /Phase 1a \(Correctness & Quality\)/);
  assert.match(skill, /Phase 1b \(Security\)/);
  assert.match(skill, /Phase 1c \(Idiom & Best Practices\)/);
  assert.match(skill, /Phase 1d \(Architecture & Solution-Fit\)/);
  assert.match(skill, /Phase 1e \(AI Slop & Curation Evidence\)/);
  assert.match(skill, /advisory: it never caps, raises, or otherwise alters the review grade/i);
  assert.match(skill, /False-negative sweep \(mandatory\)/);
  assert.match(skill, /Grade caps/);
  assert.match(skill, /Any CONFIRMED or ESCALATED \*\*security or correctness\*\*/);
  assert.match(skill, /\.code-quality\/review-acceptances\.md/);
  assert.doesNotMatch(skill, /\.code-quality\/slop-acceptances\.md/);
});

test("deep-review and output actions preserve Pi portability guards", () => {
  const skill = readText("skills/deep-review/SKILL.md");
  const actions = readText("skills/deep-review/references/output-actions.md");
  const combined = `${skill}\n${actions}`;
  assert.match(skill, /Execution Model and Model Tier Intent/);
  assert.match(skill, /sequential/i);
  assert.match(skill, /strongest available reasoning tier/i);
  assert.match(actions, /ask_user_question/);
  assert.match(actions, /questions\[\]/);
  assert.match(actions, /tool subprocess stdin may be non-TTY during an interactive session/i);
  assert.match(actions, /DEEP_REVIEW\.md/);
  assert.doesNotMatch(combined, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(combined, /AskUserQuestion/);
  assert.doesNotMatch(combined, /\/code-quality:/);
  assert.doesNotMatch(combined, /model: "(?:fable|opus|sonnet)"/);
  assert.doesNotMatch(combined, /CLAUDE_DEEP_REVIEW\.md/);
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

test("size-review preserves strict source thresholds and seam behavior", () => {
  const skill = readText("skills/size-review/SKILL.md");
  assert.match(skill, /More than \*\*10 files changed\*\*/);
  assert.match(skill, /More than \*\*400 lines added\*\*/);
  assert.match(skill, /More than \*\*15 commits\*\*/);
  assert.match(skill, /\*\*3 or more top-level directories touched\*\*/);
  assert.match(skill, /mixes a behavior change with a refactor or mechanical churn/);
  assert.match(skill, /1,000 authored lines added/);
  assert.match(skill, /30 files/);
  assert.match(skill, /Sweep the whole catalog/);
  assert.match(skill, /Review cost/);
  assert.match(skill, /Split by default/);
  assert.match(skill, /references\/default-exclusions\.md/);
  assert.match(skill, /ask_user_question/);
  assert.doesNotMatch(skill, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.doesNotMatch(skill, /\[ ! -t 0 \]/);
  assert.doesNotMatch(skill, /CLAUDE_SIZE_REVIEW\.md/);
});

test("prompt aliases point at canonical review skills", () => {
  const reviewPrompt = readText("prompts/code-quality-review.md");
  const sizePrompt = readText("prompts/code-quality-size.md");
  assert.match(reviewPrompt, /^---\n/);
  assert.match(reviewPrompt, /argument-hint: "\[scope\]"/);
  assert.match(reviewPrompt, /Use the `deep-review` skill/);
  assert.match(reviewPrompt, /\$ARGUMENTS/);
  assert.match(reviewPrompt, /all changes|base branch/i);
  assert.doesNotMatch(reviewPrompt, /\/code-quality:/);
  assert.match(sizePrompt, /^---\n/);
  assert.match(sizePrompt, /argument-hint: "\[scope\]"/);
  assert.match(sizePrompt, /Use the `size-review` skill/);
  assert.match(sizePrompt, /\$ARGUMENTS/);
  assert.doesNotMatch(sizePrompt, /\/code-quality:/);
});

test("deep-review and size-review references are bundled", () => {
  for (const reference of ["go", "python", "rust", "svelte-ts"]) {
    const content = readText(`skills/deep-review/references/${reference}.md`);
    assert.match(content, /^# .+AI Slop Signals/m);
  }
  assert.match(readText("skills/deep-review/references/output-actions.md"), /^# Output Actions/);
  const exclusions = readText("skills/size-review/references/default-exclusions.md");
  assert.match(exclusions, /^# Universal default exclusions for size-review/m);
  assert.match(exclusions, /go\.sum/);
  assert.match(exclusions, /package-lock\.json/);
});
