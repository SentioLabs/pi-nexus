import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("footer and widget registrations return Pi component factories", async () => {
  const originalHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "statusline-home-"));

  try {
    const events = new Map();
    statuslineExtension({
      on(name, handler) {
        events.set(name, handler);
      },
      registerCommand() {},
    });

    const renderers = new Map();
    const ctx = {
      cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
      ui: {
        setFooter(renderer) {
          if (typeof renderer === "function") renderers.set("footer", renderer);
        },
        setWidget(key, renderer) {
          if (typeof renderer === "function") renderers.set(key, renderer);
        },
      },
    };

    events.get("session_start")({}, ctx);

    const footerComponent = renderers.get("footer")({ requestRender() {} }, {}, {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map([["mode", "plan"]]);
      },
    });
    const aboveComponent = renderers.get("scriptable-statusline-above")({ requestRender() {} }, {});
    const belowComponent = renderers.get("scriptable-statusline-below")({ requestRender() {} }, {});

    assert.equal(typeof footerComponent.render, "function");
    assert.equal(typeof footerComponent.invalidate, "function");
    assert.deepEqual(footerComponent.render(80), ["statusline loading..."]);
    assert.equal(typeof aboveComponent.render, "function");
    assert.equal(typeof aboveComponent.invalidate, "function");
    assert.deepEqual(aboveComponent.render(80), []);
    assert.equal(typeof belowComponent.render, "function");
    assert.equal(typeof belowComponent.invalidate, "function");
    assert.deepEqual(belowComponent.render(80), []);

    await flushRefresh();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("footer and widgets use captured footerData statuses in snapshots", async () => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "statusline-home-"));
  process.env.HOME = home;

  try {
    const rendererPath = join(home, ".pi", "agent", "scriptable-statusline", "render.ts");
    mkdirSync(dirname(rendererPath), { recursive: true });
    writeFileSync(
      rendererPath,
      "export default (input) => input.extensionStatuses.map((status) => `${input.surface}:${status.key}:${status.text}`);\n",
    );

    const events = new Map();
    statuslineExtension({
      on(name, handler) {
        events.set(name, handler);
      },
      registerCommand() {},
    });

    const renderers = new Map();
    const ctx = {
      cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
      ui: {
        setFooter(renderer) {
          if (typeof renderer === "function") renderers.set("footer", renderer);
        },
        setWidget(key, renderer) {
          if (typeof renderer === "function") renderers.set(key, renderer);
        },
      },
    };

    events.get("session_start")({}, ctx);

    const footerData = {
      getGitBranch() {
        return "main";
      },
      getExtensionStatuses() {
        return new Map([["mode", "plan"]]);
      },
      onBranchChange() {
        return () => {};
      },
    };

    const footerComponent = renderers.get("footer")({ requestRender() {} }, {}, footerData);
    const belowComponent = renderers.get("scriptable-statusline-below")({ requestRender() {} }, {});

    assert.deepEqual(footerComponent.render(80), ["statusline loading..."]);
    assert.deepEqual(belowComponent.render(80), []);
    await flushRefresh();
    assert.deepEqual(footerComponent.render(80), ["footer:mode:plan"]);
    assert.deepEqual(belowComponent.render(80), ["belowEditor:mode:plan"]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
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
      },
    };

    events.get("session_start")({}, ctx);

    assert.equal(commands.has("statusline"), true);
    assert.deepEqual(calls, [
      ["footer", "registered"],
      ["widget", "scriptable-statusline-above", "registered", undefined],
      ["widget", "scriptable-statusline-below", "registered", { placement: "belowEditor" }],
    ]);

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

test("enable command re-registers footer/widgets and doctor reports status", async () => {
  const calls = [];
  const message = runStatuslineCommand("enable", {
    ui: {
      setFooter(renderer) {
        calls.push(["footer", typeof renderer]);
      },
      setWidget(key, renderer, options) {
        calls.push(["widget", key, typeof renderer, options]);
      },
    },
  }, {
    enable(ctx) {
      ctx.ui.setFooter(() => ({}));
      ctx.ui.setWidget("scriptable-statusline-above", () => ({}));
      ctx.ui.setWidget("scriptable-statusline-below", () => ({}), { placement: "belowEditor" });
    },
    requestRender() {},
  });

  assert.match(message, /enabled/);
  assert.deepEqual(calls, [
    ["footer", "function"],
    ["widget", "scriptable-statusline-above", "function", undefined],
    ["widget", "scriptable-statusline-below", "function", { placement: "belowEditor" }],
  ]);

  const doctor = runStatuslineCommand("doctor", {}, {
    rendererPath: "/tmp/render.ts",
    isEnabled: () => false,
    cache: {
      invalidate() {},
      getLastError() {
        return new Error("boom");
      },
      getLastRenderTime() {
        return 1000;
      },
    },
  });

  assert.match(doctor, /enabled: false/);
  assert.match(doctor, /renderer: \/tmp\/render\.ts/);
  assert.match(doctor, /lastError: boom/);
});

test("reload requests repaint via active TUI handle", async () => {
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

    const renderers = new Map();
    const tuiCalls = [];
    const ctx = {
      cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
      ui: {
        setFooter(renderer) {
          if (typeof renderer === "function") renderers.set("footer", renderer);
        },
        setWidget(key, renderer) {
          if (typeof renderer === "function") renderers.set(key, renderer);
        },
        notify() {},
      },
    };

    events.get("session_start")({}, ctx);
    renderers.get("footer")({ requestRender() { tuiCalls.push("request"); } }, {}, {
      getGitBranch() { return "main"; },
      getExtensionStatuses() { return new Map(); },
      onBranchChange() { return () => {}; },
    });

    await commands.get("statusline").handler("reload", ctx);

    assert.deepEqual(tuiCalls, ["request"]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("empty args default to doctor", () => {
  const message = runStatuslineCommand("", {}, {
    rendererPath: "/tmp/render.ts",
    isEnabled: () => true,
    cache: {
      invalidate() {},
      getLastError() {
        return undefined;
      },
      getLastRenderTime() {
        return undefined;
      },
    },
  });

  assert.match(message, /^Statusline doctor/);
});

test("natural-language /statusline args delegate through sendUserMessage", async () => {
  const events = new Map();
  const commands = new Map();
  const sent = [];

  statuslineExtension({
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendUserMessage(message, options) {
      sent.push({ message, options });
      return Promise.resolve();
    },
  });

  const ctx = {
    cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
    ui: {
      setFooter() {},
      setWidget() {},
      notify() {},
    },
    isIdle() {
      return true;
    },
  };

  events.get("session_start")({}, ctx);
  await commands.get("statusline").handler("show context and limits in the footer", ctx);

  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /statusline-setup/);
  assert.match(sent[0].message, /show context and limits in the footer/);
  assert.equal(sent[0].options, undefined);
});

test("natural-language /statusline args queue follow-up when agent is busy", async () => {
  const events = new Map();
  const commands = new Map();
  const sent = [];

  statuslineExtension({
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendUserMessage(message, options) {
      sent.push({ message, options });
      return Promise.resolve();
    },
  });

  const ctx = {
    cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
    ui: {
      setFooter() {},
      setWidget() {},
      notify() {},
    },
    isIdle() {
      return false;
    },
  };

  events.get("session_start")({}, ctx);
  await commands.get("statusline").handler("use two footer lines", ctx);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].options?.deliverAs, "followUp");
});
