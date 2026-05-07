import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createRenderCache } from "./render-cache.ts";
import { createRendererLoader, defaultRendererPath } from "./renderer-loader.ts";
import { buildStatuslineSnapshot } from "./snapshot.ts";

const ABOVE_WIDGET_KEY = "scriptable-statusline-above";
const BELOW_WIDGET_KEY = "scriptable-statusline-below";

const DEFAULT_TEMPLATE = new URL("../templates/default-render.ts", import.meta.url);

type StatuslineUi = {
  setFooter?: (renderer: unknown) => void;
  setWidget?: (key: string, renderer: unknown, options?: unknown) => void;
  notify?: (message: string, level?: string) => void;
  requestRender?: () => void;
  render?: () => void;
};

type StatuslineContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: StatuslineUi;
};

interface StatuslineCommandRuntime {
  rendererPath?: string;
  templatePath?: string | URL;
  loader?: { rendererPath?: string; invalidate: () => void };
  cache?: { invalidate: () => void; getLastError?: () => Error | undefined; getLastRenderTime?: () => number | undefined };
  enable?: (ctx: any) => void;
  disable?: (ctx: any) => void;
  requestRender?: () => void;
  isEnabled?: () => boolean;
}

interface StatuslineControllerOptions {
  cache: { render: (surface: "footer" | "aboveEditor" | "belowEditor", width: number, context?: unknown) => string[] };
  onEnable?: (ctx: any) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericWidth(value: unknown, fallback = 80): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  if (isRecord(value)) {
    const width = numericWidth(value.width, 0);
    if (width > 0) return width;
    const columns = numericWidth(value.columns, 0);
    if (columns > 0) return columns;
  }
  return fallback;
}

function isFooterData(value: unknown): boolean {
  return isRecord(value) && (typeof value.getGitBranch === "function" || typeof value.getExtensionStatuses === "function");
}

function footerContext(first: unknown, second: unknown): { footerData?: unknown } | undefined {
  if (isFooterData(second)) return { footerData: second };
  if (isFooterData(first)) return { footerData: first };
  if (isRecord(first) && isFooterData(first.footerData)) return { footerData: first.footerData };
  if (isRecord(second) && isFooterData(second.footerData)) return { footerData: second.footerData };
  return undefined;
}

function renderWidth(first: unknown, second?: unknown): number {
  const firstWidth = numericWidth(first, 0);
  if (firstWidth > 0) return firstWidth;
  const secondWidth = numericWidth(second, 0);
  if (secondWidth > 0) return secondWidth;
  return 80;
}

function notify(ctx: any, message: string, level = "info") {
  if (ctx?.hasUI === false) return;
  ctx?.ui?.notify?.(message, level);
}

function requestUiRender(ctx: any) {
  ctx?.ui?.requestRender?.();
  ctx?.ui?.render?.();
}

function commandAction(args: string): string {
  return args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "doctor";
}

function clearStatuslineUi(ctx: any) {
  ctx?.ui?.setFooter?.(undefined);
  ctx?.ui?.setWidget?.(ABOVE_WIDGET_KEY, undefined);
  ctx?.ui?.setWidget?.(BELOW_WIDGET_KEY, undefined);
}

function initializeRenderer(rendererPath: string, templatePath: string | URL = DEFAULT_TEMPLATE): string {
  if (existsSync(rendererPath)) return `Statusline renderer already exists: ${rendererPath}`;

  mkdirSync(dirname(rendererPath), { recursive: true });
  copyFileSync(templatePath, rendererPath);
  return `Created statusline renderer: ${rendererPath}`;
}

export function runStatuslineCommand(args: string, ctx: any, runtime: StatuslineCommandRuntime = {}): string {
  const action = commandAction(args);
  const rendererPath = runtime.rendererPath ?? runtime.loader?.rendererPath ?? defaultRendererPath();

  if (action === "init") {
    return initializeRenderer(rendererPath, runtime.templatePath);
  }

  if (action === "reload") {
    runtime.loader?.invalidate();
    runtime.cache?.invalidate();
    runtime.requestRender?.();
    return "Statusline renderer reloaded.";
  }

  if (action === "disable") {
    if (runtime.disable) runtime.disable(ctx);
    else clearStatuslineUi(ctx);
    return "Statusline disabled.";
  }

  if (action === "enable") {
    runtime.enable?.(ctx);
    runtime.requestRender?.();
    return "Statusline enabled.";
  }

  if (action === "doctor") {
    const lastError = runtime.cache?.getLastError?.();
    const lastRenderTime = runtime.cache?.getLastRenderTime?.();
    return [
      "Statusline doctor",
      `enabled: ${runtime.isEnabled?.() ?? true}`,
      `renderer: ${rendererPath}`,
      `rendererExists: ${existsSync(rendererPath)}`,
      `lastRenderTime: ${lastRenderTime === undefined ? "never" : new Date(lastRenderTime).toISOString()}`,
      `lastError: ${lastError?.message ?? "none"}`,
    ].join("\n");
  }

  return "Usage: /statusline init|reload|doctor|disable|enable";
}

function createStatuslineController(options: StatuslineControllerOptions) {
  return {
    enable(ctx: any) {
      options.onEnable?.(ctx);
      const ui = ctx?.ui;
      if (!ui) return;

      ui.setFooter?.((first?: unknown, second?: unknown) => {
        return options.cache.render("footer", renderWidth(first, second), footerContext(first, second));
      });
      ui.setWidget?.(ABOVE_WIDGET_KEY, (first?: unknown, second?: unknown) => {
        return options.cache.render("aboveEditor", renderWidth(first, second));
      });
      ui.setWidget?.(
        BELOW_WIDGET_KEY,
        (first?: unknown, second?: unknown) => {
          return options.cache.render("belowEditor", renderWidth(first, second));
        },
        { placement: "belowEditor" },
      );
    },
    disable(ctx: any) {
      clearStatuslineUi(ctx);
    },
  };
}

function findGitRoot(cwd: string | undefined): string | null {
  if (!cwd) return null;

  let current = cwd;
  while (true) {
    if (existsSync(`${current}/.git`)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export default function statuslineExtension(pi: ExtensionAPI) {
  let enabled = true;
  let turn = 0;
  let currentCtx: StatuslineContext | undefined;
  let repoRoot: string | null = null;
  let watcher: ReturnType<typeof watch> | undefined;

  const loader = createRendererLoader();
  const cache = createRenderCache({
    loadRenderer: () => loader.load(),
    buildInput: (surface, width, context) => {
      const data = isRecord(context) ? context.footerData : undefined;
      return buildStatuslineSnapshot({
        surface,
        width,
        ctx: currentCtx ?? {},
        footerData: isFooterData(data) ? (data as any) : undefined,
        turn,
        repoRoot,
      });
    },
    requestRender: () => requestUiRender(currentCtx),
    fallbackLines: (surface) => (surface === "footer" ? ["statusline loading..."] : []),
  });

  const controller = createStatuslineController({
    cache,
    onEnable(ctx) {
      currentCtx = ctx;
      repoRoot = findGitRoot(ctx?.cwd);
    },
  });

  function restartWatcher() {
    watcher?.close();
    watcher = undefined;
    if (!existsSync(loader.rendererPath)) return;

    try {
      watcher = watch(loader.rendererPath, { persistent: false }, () => {
        loader.invalidate();
        cache.invalidate();
        requestUiRender(currentCtx);
      });
    } catch {
      watcher = undefined;
    }
  }

  pi.on("turn_start", () => {
    turn += 1;
    cache.invalidate();
  });

  pi.on("session_start", (_event: unknown, ctx: StatuslineContext) => {
    currentCtx = ctx;
    repoRoot = findGitRoot(ctx?.cwd);
    if (enabled) controller.enable(ctx);
    restartWatcher();
  });

  pi.registerCommand("statusline", {
    description: "Manage the scriptable statusline renderer",
    handler: async (args: string, ctx: StatuslineContext) => {
      currentCtx = ctx;
      repoRoot = findGitRoot(ctx?.cwd);
      const action = commandAction(args);
      const message = runStatuslineCommand(args, ctx, {
        rendererPath: loader.rendererPath,
        loader,
        cache,
        enable: (commandCtx) => {
          enabled = true;
          controller.enable(commandCtx);
        },
        disable: (commandCtx) => {
          enabled = false;
          controller.disable(commandCtx);
        },
        requestRender: () => requestUiRender(ctx),
        isEnabled: () => enabled,
      });

      if (action === "init") restartWatcher();
      notify(ctx, message, "info");
    },
  });

  pi.on("shutdown", () => {
    watcher?.close();
    if (currentCtx) controller.disable(currentCtx);
  });
}
