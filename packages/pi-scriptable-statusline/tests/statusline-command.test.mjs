import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const piTuiModuleUrl = `data:text/javascript,${encodeURIComponent(`
export function visibleWidth(text) {
  return Array.from(String(text)).length;
}

export function truncateToWidth(text, width) {
  return Array.from(String(text)).slice(0, width).join("");
}
`)}`;

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@mariozechner/pi-tui") {
    return { url: ${JSON.stringify(piTuiModuleUrl)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`)}`,
);

const { default: statuslineExtension, runStatuslineCommand } = await import("../extensions/statusline.ts");

async function flushRefresh() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("init refuses to overwrite an existing renderer", () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-command-"));
  const rendererPath = join(dir, "render.ts");
  const templatePath = join(dir, "template.ts");
  writeFileSync(rendererPath, "existing renderer\n");
  writeFileSync(templatePath, "template renderer\n");

  const message = runStatuslineCommand("init", {}, { rendererPath, templatePath });

  assert.match(message, /already exists/);
  assert.equal(readFileSync(rendererPath, "utf8"), "existing renderer\n");
});

test("reload invalidates renderer loader and render cache", () => {
  let loaderInvalidated = false;
  let cacheInvalidated = false;

  const message = runStatuslineCommand("reload", {}, {
    loader: {
      invalidate() {
        loaderInvalidated = true;
      },
    },
    cache: {
      invalidate() {
        cacheInvalidated = true;
      },
    },
  });

  assert.match(message, /reloaded/);
  assert.equal(loaderInvalidated, true);
  assert.equal(cacheInvalidated, true);
});

test("disable command clears registered footer and widget UI keys", async () => {
  const originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "statusline-home-"));

  try {
    const events = new Map();
    const commands = new Map();
    statuslineExtension({
      on(name, handler) {
        events.set(name, handler);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
    });

    const calls = [];
    const renderers = new Map();
    const ctx = {
      cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
      ui: {
        setFooter(renderer) {
          calls.push(["footer", renderer === undefined ? "cleared" : "registered"]);
          if (typeof renderer === "function") renderers.set("footer", renderer);
        },
        setWidget(key, renderer, options) {
          calls.push(["widget", key, renderer === undefined ? "cleared" : "registered", options]);
          if (typeof renderer === "function") renderers.set(key, renderer);
        },
        notify(message, level) {
          calls.push(["notify", message, level]);
        },
        requestRender() {
          calls.push(["requestRender"]);
        },
        render() {
          calls.push(["render"]);
        },
      },
    };

    events.get("session_start")({}, ctx);

    assert.equal(commands.has("statusline"), true);
    assert.deepEqual(calls, [
      ["footer", "registered"],
      ["widget", "scriptable-statusline-above", "registered", undefined],
      ["widget", "scriptable-statusline-below", "registered", { placement: "belowEditor" }],
    ]);
    assert.deepEqual(renderers.get("footer")(80), ["statusline loading..."]);
    assert.deepEqual(renderers.get("scriptable-statusline-above")(80), []);
    assert.deepEqual(renderers.get("scriptable-statusline-below")(80), []);

    await flushRefresh();
    calls.length = 0;

    await commands.get("statusline").handler("disable", ctx);

    assert.deepEqual(calls, [
      ["footer", "cleared"],
      ["widget", "scriptable-statusline-above", "cleared", undefined],
      ["widget", "scriptable-statusline-below", "cleared", undefined],
      ["notify", "Statusline disabled.", "info"],
    ]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
