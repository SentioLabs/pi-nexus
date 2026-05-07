import type { StatuslineSurface } from "../index.d.ts";
import { normalizeRenderResult, type NormalizedStatuslineRenderResult } from "./render-result.ts";

export interface RenderCacheOptions {
  loadRenderer: () => Promise<any>;
  buildInput: (surface: StatuslineSurface, width: number, context?: unknown) => any;
  requestRender: () => void;
  fallbackLines?: (surface: StatuslineSurface) => string[];
}

interface RenderCacheEntry {
  lines: string[];
  stale: boolean;
  pending?: Promise<void>;
  lastError?: Error;
  lastRenderTime?: number;
}

function cacheKey(surface: StatuslineSurface, width: number): string {
  return `${surface}:${width}`;
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function linesForSurface(result: NormalizedStatuslineRenderResult, surface: StatuslineSurface): string[] {
  if (surface === "footer") return result.footer;
  if (surface === "aboveEditor") return result.widgets.aboveEditor;
  return result.widgets.belowEditor;
}

export function createRenderCache(options: RenderCacheOptions) {
  const entries = new Map<string, RenderCacheEntry>();
  let lastError: Error | undefined;
  let lastRenderTime: number | undefined;

  function fallback(surface: StatuslineSurface): string[] {
    return [...(options.fallbackLines?.(surface) ?? [])];
  }

  function refresh(key: string, entry: RenderCacheEntry, surface: StatuslineSurface, width: number, context?: unknown) {
    if (entry.pending) return;

    entry.pending = Promise.resolve()
      .then(async () => {
        const renderer = await options.loadRenderer();
        const input = options.buildInput(surface, width, context);
        const result = await renderer(input);
        const normalized = normalizeRenderResult(result, surface);
        const renderedLines = linesForSurface(normalized, surface);

        entry.lines = [...renderedLines];
        entry.stale = false;
        entry.lastError = undefined;
        entry.lastRenderTime = Date.now();
        lastError = undefined;
        lastRenderTime = entry.lastRenderTime;
        entries.set(key, entry);
      })
      .catch((error) => {
        const normalizedError = errorValue(error);
        entry.lastError = normalizedError;
        entry.stale = false;
        lastError = normalizedError;
      })
      .finally(() => {
        entry.pending = undefined;
        options.requestRender();
      });
  }

  return {
    render(surface: StatuslineSurface, width: number, context?: unknown): string[] {
      const key = cacheKey(surface, width);
      let entry = entries.get(key);

      if (!entry) {
        entry = { lines: fallback(surface), stale: true };
        entries.set(key, entry);
      }

      if (entry.stale) {
        refresh(key, entry, surface, width, context);
      }

      return [...entry.lines];
    },
    invalidate() {
      for (const entry of entries.values()) {
        entry.stale = true;
      }
    },
    getLastError(): Error | undefined {
      return lastError;
    },
    getLastRenderTime(): number | undefined {
      return lastRenderTime;
    },
  };
}
