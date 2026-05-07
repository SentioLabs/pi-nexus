import assert from "node:assert/strict";
import test from "node:test";
import { buildStatuslineSnapshot } from "../extensions/snapshot.ts";

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
});
