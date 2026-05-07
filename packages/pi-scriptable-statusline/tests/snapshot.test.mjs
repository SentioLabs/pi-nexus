import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const piTuiModuleUrl = `data:text/javascript,${encodeURIComponent(`
export function visibleWidth(text) {
  return 1000 + text.length;
}

export function truncateToWidth(text, width, ellipsis) {
  return "pi-tui:" + text + ":" + width + ":" + (ellipsis ?? "");
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

const { buildStatuslineSnapshot } = await import("../extensions/snapshot.ts");

test("snapshot extracts model, context, git, statuses, tokens, and cost", () => {
  const ctx = {
    cwd: "/workspace/example",
    model: { provider: "anthropic", id: "claude-sonnet", label: "claude-sonnet" },
    tokens: { input: 10, output: 5 },
    cost: { total: 0.003 },
    getContextUsage() {
      return { tokens: 12000, window: 100000, percent: 12 };
    },
    sessionManager: {
      getBranch() {
        return "fallback-branch";
      },
      getSessionFile() {
        return "/sessions/session-123.json";
      },
    },
  };

  const footerData = {
    getGitBranch() {
      return "main";
    },
    getExtensionStatuses() {
      return new Map([["mode", "plan"]]);
    },
  };

  const snapshot = buildStatuslineSnapshot({
    surface: "footer",
    width: 80,
    ctx,
    footerData,
    turn: 2,
    repoRoot: "/workspace/example",
  });

  assert.equal(snapshot.model.label, "claude-sonnet");
  assert.equal(snapshot.context.percent, 12);
  assert.equal(snapshot.git.branch, "main");
  assert.deepEqual(snapshot.extensionStatuses, [{ key: "mode", text: "plan" }]);
  assert.equal(snapshot.tokens.total, 15);
  assert.equal(snapshot.cost.totalLabel, "$0.003");
  assert.equal(snapshot.utils.visibleWidth("abc"), 1003);
  assert.equal(snapshot.utils.truncate("abcdef", 3, "~"), "pi-tui:abcdef:3:~");
});
