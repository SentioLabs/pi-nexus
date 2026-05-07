import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(readText(path));

test("package typecheck uses real dependency types instead of broad any shims", () => {
  const pkg = readJson("package.json");
  const tsconfig = readJson("tsconfig.json");

  assert.match(pkg.devDependencies["@types/node"], /^\^24\./);
  assert.equal(pkg.devDependencies["@mariozechner/pi-coding-agent"] !== undefined, true);
  assert.equal(pkg.devDependencies["@mariozechner/pi-tui"] !== undefined, true);
  assert.equal(pkg.peerDependencies["@mariozechner/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependencies["@mariozechner/pi-tui"], "*");
  assert.equal(pkg.peerDependenciesMeta["@mariozechner/pi-coding-agent"].optional, true);
  assert.equal(pkg.peerDependenciesMeta["@mariozechner/pi-tui"].optional, true);
  assert.deepEqual(tsconfig.compilerOptions.types, ["node"]);
  assert.equal(tsconfig.include.includes("tests/source-typecheck-shims.d.ts"), false);
  assert.equal(existsSync(new URL("../tests/source-typecheck-shims.d.ts", import.meta.url)), false);
});
