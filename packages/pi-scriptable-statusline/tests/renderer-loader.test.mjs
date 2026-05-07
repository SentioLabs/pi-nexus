import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRendererLoader, defaultRendererPath } from "../extensions/renderer-loader.ts";

test("defaultRendererPath points at ~/.pi/agent/scriptable-statusline/render.ts", () => {
  const path = defaultRendererPath("/home/alice");
  assert.equal(path, "/home/alice/.pi/agent/scriptable-statusline/render.ts");
});

test("loader imports a renderer function and reloads after invalidation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-renderer-"));
  const rendererPath = join(dir, "render.mjs");
  writeFileSync(rendererPath, "export default () => ['one'];\n");

  const loader = createRendererLoader({ rendererPath, importModule: (specifier) => import(specifier) });
  assert.deepEqual(await (await loader.load())({ surface: "footer" }), ["one"]);

  writeFileSync(rendererPath, "export default () => ['two'];\n");
  loader.invalidate();
  const renderer = await loader.load();
  assert.deepEqual(await renderer({ surface: "footer" }), ["two"]);
});

test("loader rejects modules without function default export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-renderer-"));
  const rendererPath = join(dir, "bad.mjs");
  writeFileSync(rendererPath, "export default {};\n");

  const loader = createRendererLoader({ rendererPath, importModule: (specifier) => import(specifier) });
  await assert.rejects(() => loader.load(), /default export.*function/);
});
