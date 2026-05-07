import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const packageVersion = (packagePath) => readJson(`${packagePath}/package.json`).version;
const lockPackageVersion = (packagePath) => readJson("package-lock.json").packages[packagePath].version;

function assertReleaseManifestTracksPackage(packagePath) {
  const manifest = readJson(".release-please-manifest.json");
  const version = packageVersion(packagePath);

  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(manifest[packagePath], version);
  assert.equal(lockPackageVersion(packagePath), version);
}

test("root package declares private npm workspaces", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.workspaces, ["packages/*"]);
  assert.equal(pkg.engines.node, ">=24.0.0");
});

test("release-please tracks pi-arc as an independent package", () => {
  const config = readJson("release-please-config.json");
  const piArc = config.packages["packages/pi-arc"];

  assert.ok(piArc);
  assert.equal(piArc.component, "pi-arc");
  assert.equal(piArc["package-name"], "@sentiolabs/pi-arc");
  assert.deepEqual(piArc["extra-files"], [
    {
      type: "json",
      path: "/package-lock.json",
      jsonpath: "$.packages['packages/pi-arc'].version",
    },
  ]);
  assertReleaseManifestTracksPackage("packages/pi-arc");
});

test("pi-arc package metadata points at the workspace package", () => {
  const pkg = readJson("packages/pi-arc/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-arc");
  assertReleaseManifestTracksPackage("packages/pi-arc");
  assert.equal(pkg.repository.directory, "packages/pi-arc");
  assert.equal(pkg.repository.url, "git+ssh://git@github.com/SentioLabs/pi-nexus.git");
  assert.equal(pkg.homepage, "https://github.com/SentioLabs/pi-nexus/tree/main/packages/pi-arc#readme");
  assert.equal(pkg.bugs.url, "https://github.com/SentioLabs/pi-nexus/issues");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-todo"));
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-ask-user-question"));
  assert.ok(pkg.bundledDependencies.includes("pi-subagents"));
});

test("release-please tracks pi-frontend-design as an independent package", () => {
  const config = readJson("release-please-config.json");
  const frontendDesign = config.packages["packages/pi-frontend-design"];

  assert.ok(frontendDesign);
  assert.equal(frontendDesign.component, "pi-frontend-design");
  assert.equal(frontendDesign["package-name"], "@sentiolabs/pi-frontend-design");
  assert.equal(frontendDesign["release-type"], "node");
  assert.equal(frontendDesign["initial-version"], "0.1.0");
  assert.equal(frontendDesign["changelog-path"], "CHANGELOG.md");
  assert.deepEqual(frontendDesign["extra-files"], [
    {
      type: "json",
      path: "/package-lock.json",
      jsonpath: "$.packages['packages/pi-frontend-design'].version",
    },
  ]);
  assertReleaseManifestTracksPackage("packages/pi-frontend-design");
});

test("release-please tracks pi-scriptable-statusline as an independent package", () => {
  const config = readJson("release-please-config.json");
  const statusline = config.packages["packages/pi-scriptable-statusline"];

  assert.ok(statusline);
  assert.equal(statusline.component, "pi-scriptable-statusline");
  assert.equal(statusline["package-name"], "@sentiolabs/pi-scriptable-statusline");
  assert.equal(statusline["release-type"], "node");
  assert.equal(statusline["initial-version"], "0.1.0");
  assert.equal(statusline["changelog-path"], "CHANGELOG.md");
  assert.deepEqual(statusline["extra-files"], [
    {
      type: "json",
      path: "/package-lock.json",
      jsonpath: "$.packages['packages/pi-scriptable-statusline'].version",
    },
  ]);
  assertReleaseManifestTracksPackage("packages/pi-scriptable-statusline");
});

test("release workflow uses idempotent npm publishing helper", () => {
  const workflow = readText(".github/workflows/release-please.yml");

  assert.match(workflow, /node scripts\/npm-publish-workspace-if-needed\.mjs @sentiolabs\/pi-arc/);
  assert.match(workflow, /node scripts\/npm-publish-workspace-if-needed\.mjs @sentiolabs\/pi-frontend-design/);
  assert.match(workflow, /node scripts\/npm-publish-workspace-if-needed\.mjs @sentiolabs\/pi-scriptable-statusline/);
  assert.doesNotMatch(workflow, /npm publish --workspace/);
  assert.doesNotMatch(workflow, /release_created/);
});

test("pi-frontend-design package metadata points at the workspace package", () => {
  const pkg = readJson("packages/pi-frontend-design/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-frontend-design");
  assertReleaseManifestTracksPackage("packages/pi-frontend-design");
  assert.equal(pkg.description, "Frontend design skill for distinctive, production-grade Pi UI work.");
  assert.deepEqual(pkg.keywords, ["pi-package", "pi-skill", "pi-frontend-design", "frontend-design", "ui", "ux", "frontend", "design"]);
  assert.equal(pkg.license, "Apache-2.0");
  assert.deepEqual(pkg.author, { name: "Sentio Labs", url: "https://github.com/sentiolabs" });
  assert.deepEqual(pkg.contributors, [
    { name: "Anthropic", email: "support@anthropic.com" },
    { name: "Prithvi Rajasekaran", email: "prithvi@anthropic.com" },
    { name: "Alexander Bricken", email: "alexander@anthropic.com" },
  ]);
  assert.equal(pkg.repository.directory, "packages/pi-frontend-design");
  assert.equal(pkg.repository.url, "git+ssh://git@github.com/SentioLabs/pi-nexus.git");
  assert.equal(pkg.homepage, "https://github.com/SentioLabs/pi-nexus/tree/main/packages/pi-frontend-design#readme");
  assert.equal(pkg.bugs.url, "https://github.com/SentioLabs/pi-nexus/issues");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.deepEqual(pkg.scripts, {
    test: "node --test tests/*.test.mjs",
    "pack:dry-run": "npm pack --dry-run",
    prepublishOnly: "npm test && npm run pack:dry-run",
  });
  assert.deepEqual(pkg.files, ["skills/", "prompts/", "README.md", "CHANGELOG.md", "LICENSE"]);
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
});

test("pi-scriptable-statusline package metadata points at the workspace package", () => {
  const pkg = readJson("packages/pi-scriptable-statusline/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-scriptable-statusline");
  assertReleaseManifestTracksPackage("packages/pi-scriptable-statusline");
  assert.equal(pkg.description, "Scriptable footer and statusline UI package for Pi.");
  assert.equal(pkg.repository.directory, "packages/pi-scriptable-statusline");
  assert.equal(pkg.repository.url, "git+ssh://git@github.com/SentioLabs/pi-nexus.git");
  assert.equal(pkg.homepage, "https://github.com/SentioLabs/pi-nexus/tree/main/packages/pi-scriptable-statusline#readme");
  assert.equal(pkg.bugs.url, "https://github.com/SentioLabs/pi-nexus/issues");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/statusline.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.deepEqual(pkg.pi.prompts, ["./prompts/*.md"]);
});
