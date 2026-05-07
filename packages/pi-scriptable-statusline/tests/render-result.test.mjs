import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRenderResult } from "../extensions/render-result.ts";

test("array renderer output maps to the active footer surface", () => {
  assert.deepEqual(normalizeRenderResult(["one", "two"], "footer"), {
    footer: ["one", "two"],
    widgets: { aboveEditor: [], belowEditor: [] },
  });
});

test("array renderer output maps to the active widget surface", () => {
  assert.deepEqual(normalizeRenderResult(["above"], "aboveEditor"), {
    footer: [],
    widgets: { aboveEditor: ["above"], belowEditor: [] },
  });
  assert.deepEqual(normalizeRenderResult(["below"], "belowEditor"), {
    footer: [],
    widgets: { aboveEditor: [], belowEditor: ["below"] },
  });
});

test("object renderer output normalizes all supported surfaces", () => {
  assert.deepEqual(
    normalizeRenderResult(
      { footer: ["f"], widgets: { aboveEditor: ["a"], belowEditor: ["b"] }, status: "s" },
      "footer",
    ),
    { footer: ["f"], widgets: { aboveEditor: ["a"], belowEditor: ["b"] }, status: "s" },
  );
});

test("missing surfaces normalize to empty arrays", () => {
  assert.deepEqual(normalizeRenderResult({}, "footer"), {
    footer: [],
    widgets: { aboveEditor: [], belowEditor: [] },
  });
});

test("invalid renderer output throws useful errors", () => {
  assert.throws(() => normalizeRenderResult(null, "footer"), /array of strings or an object/);
  assert.throws(() => normalizeRenderResult({ footer: "bad" }, "footer"), /result\.footer/);
  assert.throws(() => normalizeRenderResult({ widgets: { belowEditor: ["ok", 1] } }, "footer"), /belowEditor\[1\]/);
  assert.throws(() => normalizeRenderResult({ status: 1 }, "footer"), /result\.status/);
});
