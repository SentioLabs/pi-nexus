import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package exposes only statusline extension entrypoint", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi?.extensions, ["./extensions/statusline.ts"]);
});
