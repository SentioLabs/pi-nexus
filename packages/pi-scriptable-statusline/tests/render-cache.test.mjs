import assert from "node:assert/strict";
import test from "node:test";
import { createRenderCache } from "../extensions/render-cache.ts";

async function flushRefresh() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("render returns fallback immediately then cached renderer output after refresh", async () => {
  let rendererCalls = 0;
  let renderRequests = 0;
  const cache = createRenderCache({
    loadRenderer: async () => async (input) => {
      rendererCalls += 1;
      return [`${input.surface}:${input.width}`];
    },
    buildInput: (surface, width) => ({ surface, width }),
    requestRender: () => {
      renderRequests += 1;
    },
    fallbackLines: (surface) => [`fallback:${surface}`],
  });

  assert.deepEqual(cache.render("footer", 80), ["fallback:footer"]);
  assert.equal(rendererCalls, 0);

  await flushRefresh();

  assert.equal(rendererCalls, 1);
  assert.equal(renderRequests, 1);
  assert.deepEqual(cache.render("footer", 80), ["footer:80"]);
});

test("render keeps last good lines when renderer throws", async () => {
  let shouldThrow = false;
  const cache = createRenderCache({
    loadRenderer: async () => async () => {
      if (shouldThrow) throw new Error("boom");
      return ["good"];
    },
    buildInput: (surface, width) => ({ surface, width }),
    requestRender: () => undefined,
  });

  assert.deepEqual(cache.render("footer", 80), []);
  await flushRefresh();
  assert.deepEqual(cache.render("footer", 80), ["good"]);

  shouldThrow = true;
  cache.invalidate();
  assert.deepEqual(cache.render("footer", 80), ["good"]);
  await flushRefresh();

  assert.match(cache.getLastError()?.message, /boom/);
  assert.deepEqual(cache.render("footer", 80), ["good"]);
});

test("invalidate marks all surfaces stale", async () => {
  let value = "first";
  const cache = createRenderCache({
    loadRenderer: async () => async () => [value],
    buildInput: (surface, width) => ({ surface, width }),
    requestRender: () => undefined,
  });

  assert.deepEqual(cache.render("belowEditor", 40), []);
  await flushRefresh();
  assert.deepEqual(cache.render("belowEditor", 40), ["first"]);

  value = "second";
  cache.invalidate();
  assert.deepEqual(cache.render("belowEditor", 40), ["first"]);
  await flushRefresh();
  assert.deepEqual(cache.render("belowEditor", 40), ["second"]);
});
