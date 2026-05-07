import { basename } from "node:path";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { StatuslineRenderInput, StatuslineSurface } from "../index.d.ts";

export interface SnapshotOptions {
  surface: StatuslineSurface;
  width: number;
  ctx: any;
  footerData?: { getGitBranch?: () => string | null; getExtensionStatuses?: () => ReadonlyMap<string, string> };
  turn: number;
  repoRoot?: string | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callOptional<T>(fn: unknown): T | undefined {
  if (typeof fn !== "function") return undefined;
  try {
    return fn() as T;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function recordNumber(record: unknown, keys: string[]): number | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function recordString(record: unknown, keys: string[]): string | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(3)}`;
}

function modelSnapshot(ctx: any) {
  const model = ctx?.model;
  if (typeof model === "string") {
    return { provider: null, id: model, label: model };
  }

  const provider = recordString(model, ["provider", "providerId"]);
  const id = recordString(model, ["id", "model", "modelId", "name"]);
  const label = recordString(model, ["label", "displayName", "name", "id", "model", "modelId"]) ?? "unknown";
  return { provider: provider ?? null, id: id ?? null, label };
}

function contextSnapshot(ctx: any) {
  const usage = callOptional<unknown>(ctx?.getContextUsage?.bind?.(ctx)) ?? ctx?.contextUsage;
  const tokens = recordNumber(usage, ["tokens", "used", "current"]) ?? 0;
  const window = recordNumber(usage, ["window", "contextWindow", "limit", "max"]) ?? 0;
  const explicitPercent = recordNumber(usage, ["percent", "percentage"]);
  const percent = explicitPercent ?? (window > 0 ? Math.round((tokens / window) * 100) : null);

  return { tokens, window, percent };
}

function aggregateUsageFromSession(ctx: any): { input: number; output: number; cost: number } | null {
  const entries = callOptional<unknown>(ctx?.sessionManager?.getBranch?.bind?.(ctx?.sessionManager));
  if (!Array.isArray(entries)) return null;

  let input = 0;
  let output = 0;
  let cost = 0;
  let found = false;

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") {
      continue;
    }

    const usage = isRecord(entry.message.usage) ? entry.message.usage : {};
    input += recordNumber(usage, ["input", "inputTokens", "prompt", "promptTokens"]) ?? 0;
    output += recordNumber(usage, ["output", "outputTokens", "completion", "completionTokens"]) ?? 0;
    cost += recordNumber(usage.cost, ["total", "totalUsd", "usd"]) ?? 0;
    found = true;
  }

  return found ? { input, output, cost } : null;
}

function tokenSnapshot(ctx: any) {
  const fromSession = aggregateUsageFromSession(ctx);
  if (fromSession) {
    const total = fromSession.input + fromSession.output;
    return { input: fromSession.input, output: fromSession.output, total, totalLabel: formatCount(total) };
  }

  const source = ctx?.tokens ?? ctx?.tokenUsage ?? ctx?.usage;
  const input = recordNumber(source, ["input", "inputTokens", "prompt", "promptTokens"]) ?? 0;
  const output = recordNumber(source, ["output", "outputTokens", "completion", "completionTokens"]) ?? 0;
  const total = recordNumber(source, ["total", "totalTokens"]) ?? input + output;

  return { input, output, total, totalLabel: formatCount(total) };
}

function costSnapshot(ctx: any) {
  const fromSession = aggregateUsageFromSession(ctx);
  if (fromSession) {
    return { total: fromSession.cost, totalLabel: formatCost(fromSession.cost) };
  }

  const source = ctx?.cost ?? ctx?.costs;
  const total = recordNumber(source, ["total", "totalUsd", "usd"]) ?? 0;
  const totalLabel = recordString(source, ["totalLabel", "label"]) ?? formatCost(total);

  return { total, totalLabel };
}

function extensionStatuses(footerData: SnapshotOptions["footerData"]) {
  const statuses = callOptional<ReadonlyMap<string, string>>(footerData?.getExtensionStatuses?.bind?.(footerData));
  if (!statuses) return [];

  return Array.from(statuses.entries()).map(([key, text]) => ({ key, text }));
}

function sessionId(ctx: any): string | null {
  return (
    stringValue(ctx?.sessionId) ??
    recordString(ctx?.session, ["id"]) ??
    callOptional<string>(ctx?.sessionManager?.getSessionFile?.bind?.(ctx?.sessionManager)) ??
    null
  );
}

export function buildStatuslineSnapshot(options: SnapshotOptions): StatuslineRenderInput {
  const ctx = options.ctx ?? {};
  const cwd = stringValue(ctx.cwd) ?? process.cwd();
  const repoRoot = options.repoRoot ?? null;
  const repoName = basename(repoRoot ?? cwd) || basename(cwd) || cwd;
  const footerBranch = callOptional<string | null>(options.footerData?.getGitBranch?.bind?.(options.footerData));
  const themeSource = ctx.theme ?? ctx.ui?.theme;

  return {
    surface: options.surface,
    width: options.width,
    cwd,
    model: modelSnapshot(ctx),
    repo: { name: repoName, root: repoRoot },
    git: { branch: footerBranch ?? null },
    context: contextSnapshot(ctx),
    tokens: tokenSnapshot(ctx),
    cost: costSnapshot(ctx),
    limits: { daily: null, weekly: null, source: null },
    extensionStatuses: extensionStatuses(options.footerData),
    session: { id: sessionId(ctx), turn: options.turn },
    theme: {
      fg: (color: string, text: string) => {
        if (typeof themeSource?.fg === "function") return themeSource.fg(color, text);
        return text;
      },
      bg: (color: string, text: string) => {
        if (typeof themeSource?.bg === "function") return themeSource.bg(color, text);
        return text;
      },
    },
    utils: {
      visibleWidth,
      truncate: truncateToWidth,
    },
  };
}
