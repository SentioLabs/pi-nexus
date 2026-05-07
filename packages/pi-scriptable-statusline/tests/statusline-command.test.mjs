import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import statuslineExtension, { runStatuslineCommand } from "../extensions/statusline.ts";

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

test("session start registers footer and editor widgets", () => {
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
  const ctx = {
    cwd: mkdtempSync(join(tmpdir(), "statusline-session-")),
    ui: {
      setFooter(renderer) {
        calls.push(["footer", typeof renderer]);
      },
      setWidget(key, renderer, options) {
        calls.push(["widget", key, typeof renderer, options]);
      },
    },
  };

  events.get("session_start")({}, ctx);

  assert.equal(commands.has("statusline"), true);
  assert.deepEqual(calls, [
    ["footer", "function"],
    ["widget", "scriptable-statusline-above", "function", undefined],
    ["widget", "scriptable-statusline-below", "function", { placement: "belowEditor" }],
  ]);
});

test("disable clears footer and widget UI keys", () => {
  const calls = [];
  const ctx = {
    ui: {
      setFooter(renderer) {
        calls.push(["footer", renderer]);
      },
      setWidget(key, renderer, options) {
        calls.push(["widget", key, renderer, options]);
      },
    },
  };

  const message = runStatuslineCommand("disable", ctx, {});

  assert.match(message, /disabled/);
  assert.deepEqual(calls, [
    ["footer", undefined],
    ["widget", "scriptable-statusline-above", undefined, undefined],
    ["widget", "scriptable-statusline-below", undefined, undefined],
  ]);
});
