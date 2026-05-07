import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createRenderCache } from "./render-cache.ts";
import { createRendererLoader, defaultRendererPath } from "./renderer-loader.ts";
import { buildStatuslineSnapshot } from "./snapshot.ts";

const ABOVE_WIDGET_KEY = "scriptable-statusline-above";
const BELOW_WIDGET_KEY = "scriptable-statusline-below";

const DEFAULT_TEMPLATE = new URL("../templates/default-render.ts", import.meta.url);

type FooterDataLike = {
  getGitBranch?: () => string | null;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  onBranchChange?: (callback: () => void) => (() => void) | void;
};

type TuiLike = { requestRender?: () => void };

interface StatuslineCommandRuntime {
  rendererPath?: string;
  templatePath?: string | URL;
  loader?: { rendererPath?: string; invalidate: () => void };
  cache?: { invalidate: () => void; getLastError?: () => Error | undefined; getLastRenderTime?: () => number | undefined };
  enable?: (ctx: ExtensionContext) => void;
  disable?: (ctx: ExtensionContext) => void;
  requestRender?: () => void;
  isEnabled?: () => boolean;
  onInit?: () => void;
}

interface StatuslineControllerOptions {
  cache: {
    render: (surface: "footer" | "aboveEditor" | "belowEditor", width: number, context?: unknown) => string[];
    invalidate?: () => void;
  };
  onEnable?: (ctx: ExtensionContext) => void;
  setFooterDataContext: (context: { footerData?: FooterDataLike } | undefined) => void;
  getFooterDataContext: () => { footerData?: FooterDataLike } | undefined;
  requestRender: () => void;
  registerTui: (tui: TuiLike | undefined) => void;
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

function isFooterData(value: unknown): value is FooterDataLike {
  return isRecord(value) && (typeof value.getGitBranch === "function" || typeof value.getExtensionStatuses === "function");
}

function footerContext(first: unknown, second: unknown): { footerData?: FooterDataLike } | undefined {
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

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
  if (!ctx || ctx.hasUI === false) return;
  ctx.ui.notify(message, level);
}

function commandAction(args: string): string {
  return args.trim().split(/\s+/, 1)[0]?.toLowerCase() || "doctor";
}

function isOperationalStatuslineCommand(args: string): boolean {
  const action = commandAction(args);
  return action === "init" || action === "reload" || action === "doctor" || action === "disable" || action === "enable";
}

function delegationMessage(request: string): string {
  return `Use the statusline-setup skill to configure @sentiolabs/pi-scriptable-statusline for this request: ${request}`;
}

function clearStatuslineUi(ctx: ExtensionContext | undefined) {
  if (!ctx) return;
  ctx.ui.setFooter(undefined);
  ctx.ui.setWidget(ABOVE_WIDGET_KEY, undefined);
  ctx.ui.setWidget(BELOW_WIDGET_KEY, undefined);
}

function initializeRenderer(rendererPath: string, templatePath: string | URL = DEFAULT_TEMPLATE): string {
  if (existsSync(rendererPath)) return `Statusline renderer already exists: ${rendererPath}`;

  mkdirSync(dirname(rendererPath), { recursive: true });
  copyFileSync(templatePath, rendererPath);
  return `Created statusline renderer: ${rendererPath}`;
}

export function runStatuslineCommand(args: string, ctx: ExtensionContext, runtime: StatuslineCommandRuntime = {}): string {
  const action = commandAction(args);
  const rendererPath = runtime.rendererPath ?? runtime.loader?.rendererPath ?? defaultRendererPath();

  if (action === "init") {
    const message = initializeRenderer(rendererPath, runtime.templatePath);
    runtime.loader?.invalidate();
    runtime.cache?.invalidate();
    runtime.requestRender?.();
    runtime.onInit?.();
    return message;
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

function statusSignature(footerData?: FooterDataLike): string {
  if (!footerData) return "none";
  const branch = typeof footerData.getGitBranch === "function" ? footerData.getGitBranch() ?? "" : "";
  const statuses = typeof footerData.getExtensionStatuses === "function" ? footerData.getExtensionStatuses() : undefined;
  const statusParts = statuses ? Array.from(statuses.entries()).map(([key, text]) => `${key}:${text}`) : [];
  return `${branch}|${statusParts.join("|")}`;
}

function createStatuslineController(options: StatuslineControllerOptions) {
  let footerUnsubscribe: (() => void) | undefined;
  let footerSignature = "none";

  function resetFooterSubscription() {
    footerUnsubscribe?.();
    footerUnsubscribe = undefined;
  }

  return {
    enable(ctx: ExtensionContext) {
      options.onEnable?.(ctx);
      const ui = ctx.ui;

      ui.setFooter((tui?: TuiLike, _theme?: unknown, footerData?: unknown) => {
        options.registerTui(tui);
        const context = footerContext(footerData, undefined);
        options.setFooterDataContext(context);
        const currentFooterData = context?.footerData;
        footerSignature = statusSignature(currentFooterData);

        resetFooterSubscription();
        if (currentFooterData && typeof currentFooterData.onBranchChange === "function") {
          const unsub = currentFooterData.onBranchChange(() => {
            options.cache.invalidate?.();
            options.requestRender();
          });
          if (typeof unsub === "function") footerUnsubscribe = unsub;
        }

        return {
          dispose() {
            resetFooterSubscription();
          },
          invalidate() {
            options.cache.invalidate?.();
          },
          render(width: number) {
            const nextSignature = statusSignature(currentFooterData);
            if (nextSignature !== footerSignature) {
              footerSignature = nextSignature;
              options.cache.invalidate?.();
            }
            return options.cache.render("footer", renderWidth(width), context);
          },
        };
      });
      ui.setWidget(ABOVE_WIDGET_KEY, (tui?: TuiLike) => {
        options.registerTui(tui);
        return {
          invalidate() {
            options.cache.invalidate?.();
          },
          render(width: number) {
            return options.cache.render("aboveEditor", renderWidth(width), options.getFooterDataContext());
          },
        };
      });
      ui.setWidget(
        BELOW_WIDGET_KEY,
        (tui?: TuiLike) => {
          options.registerTui(tui);
          return {
            invalidate() {
              options.cache.invalidate?.();
            },
            render(width: number) {
              return options.cache.render("belowEditor", renderWidth(width), options.getFooterDataContext());
            },
          };
        },
        { placement: "belowEditor" },
      );
    },
    disable(ctx: ExtensionContext) {
      resetFooterSubscription();
      options.setFooterDataContext(undefined);
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
  let currentCtx: ExtensionContext | undefined;
  let repoRoot: string | null = null;
  let watcher: ReturnType<typeof watch> | undefined;
  let lastFooterContext: { footerData?: FooterDataLike } | undefined;
  const tuiHandles = new Set<TuiLike>();

  const requestRender = () => {
    for (const tui of tuiHandles) {
      tui.requestRender?.();
    }
  };

  const loader = createRendererLoader();
  const cache = createRenderCache({
    loadRenderer: () => loader.load(),
    buildInput: (surface, width, context) => {
      const data = isRecord(context) ? context.footerData : undefined;
      return buildStatuslineSnapshot({
        surface,
        width,
        ctx: currentCtx ?? {},
        footerData: isFooterData(data) ? data : undefined,
        turn,
        repoRoot,
      });
    },
    requestRender,
    fallbackLines: (surface) => (surface === "footer" ? ["statusline loading..."] : []),
  });

  const controller = createStatuslineController({
    cache,
    onEnable(ctx) {
      currentCtx = ctx;
      repoRoot = findGitRoot(ctx?.cwd);
    },
    setFooterDataContext(context) {
      lastFooterContext = context;
    },
    getFooterDataContext() {
      return lastFooterContext;
    },
    requestRender,
    registerTui(tui) {
      if (tui) tuiHandles.add(tui);
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
        requestRender();
      });
    } catch {
      watcher = undefined;
    }
  }

  pi.on("turn_start", () => {
    turn += 1;
    cache.invalidate();
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    repoRoot = findGitRoot(ctx?.cwd);
    if (enabled) controller.enable(ctx);
    restartWatcher();
  });

  pi.registerCommand("statusline", {
    description: "Manage the scriptable statusline renderer",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      currentCtx = ctx;
      repoRoot = findGitRoot(ctx?.cwd);

      const trimmedArgs = args.trim();
      if (trimmedArgs.length > 0 && !isOperationalStatuslineCommand(trimmedArgs)) {
        const deliverAs = ctx.isIdle() === false ? "followUp" : undefined;
        pi.sendUserMessage(delegationMessage(trimmedArgs), deliverAs ? { deliverAs } : undefined);
        notify(ctx, "Delegating to statusline-setup for your requested layout.", "info");
        return;
      }

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
        requestRender,
        isEnabled: () => enabled,
        onInit: restartWatcher,
      });

      notify(ctx, message, "info");
    },
  });

  pi.on("session_shutdown", () => {
    watcher?.close();
    watcher = undefined;
    lastFooterContext = undefined;
    tuiHandles.clear();
    if (currentCtx) controller.disable(currentCtx);
  });
}
