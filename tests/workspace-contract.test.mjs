import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("root package declares private npm workspaces", () => {
  const pkg = readJson("package.json");

  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.workspaces, ["packages/*"]);
  assert.equal(pkg.engines.node, ">=24.0.0");
});

test("release-please tracks pi-arc as an independent package", () => {
  const config = readJson("release-please-config.json");
  const manifest = readJson(".release-please-manifest.json");
  const piArc = config.packages["packages/pi-arc"];

  assert.ok(piArc);
  assert.equal(piArc.component, "pi-arc");
  assert.equal(piArc["package-name"], "@sentiolabs/pi-arc");
  assert.equal(manifest["packages/pi-arc"], "0.7.0");
});

test("pi-arc package metadata points at the workspace package", () => {
  const pkg = readJson("packages/pi-arc/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-arc");
  assert.equal(pkg.version, "0.7.0");
  assert.equal(pkg.repository.directory, "packages/pi-arc");
  assert.equal(pkg.repository.url, "git+ssh://git@github.com/SentioLabs/pi-nexus.git");
  assert.equal(pkg.homepage, "https://github.com/SentioLabs/pi-nexus/tree/main/packages/pi-arc#readme");
  assert.equal(pkg.bugs.url, "https://github.com/SentioLabs/pi-nexus/issues");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-todo"));
  assert.ok(pkg.bundledDependencies.includes("@juicesharp/rpiv-ask-user-question"));
  assert.ok(pkg.bundledDependencies.includes("pi-subagents"));
});

test("release-please tracks frontend-design as an independent package", () => {
  const config = readJson("release-please-config.json");
  const manifest = readJson(".release-please-manifest.json");
  const frontendDesign = config.packages["packages/frontend-design"];

  assert.ok(frontendDesign);
  assert.equal(frontendDesign.component, "pi-frontend-design");
  assert.equal(frontendDesign["package-name"], "@sentiolabs/pi-frontend-design");
  assert.equal(manifest["packages/frontend-design"], "0.1.0");
});

test("frontend-design package metadata points at the workspace package", () => {
  const pkg = readJson("packages/frontend-design/package.json");

  assert.equal(pkg.name, "@sentiolabs/pi-frontend-design");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.repository.directory, "packages/frontend-design");
  assert.equal(pkg.repository.url, "git+ssh://git@github.com/SentioLabs/pi-nexus.git");
  assert.equal(pkg.homepage, "https://github.com/SentioLabs/pi-nexus/tree/main/packages/frontend-design#readme");
  assert.equal(pkg.bugs.url, "https://github.com/SentioLabs/pi-nexus/issues");
  assert.equal(pkg.engines.node, ">=24.0.0");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
});
