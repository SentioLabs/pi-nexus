import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { StatuslineRenderer } from "../index.d.ts";

export type ImportModule = (specifier: string) => Promise<{ default?: unknown }>;

export interface RendererLoaderOptions {
  rendererPath?: string;
  homeDir?: string;
  importModule?: ImportModule;
  now?: () => number;
}

export function defaultRendererPath(homeDir = homedir()): string {
  return `${homeDir}/.pi/agent/scriptable-statusline/render.ts`;
}

export function createRendererLoader(options: RendererLoaderOptions = {}) {
  const rendererPath = options.rendererPath ?? defaultRendererPath(options.homeDir);
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const now = options.now ?? Date.now;
  let version = `${now()}-0`;
  let invalidations = 0;
  let cached: Promise<StatuslineRenderer> | undefined;

  return {
    rendererPath,
    invalidate() {
      invalidations += 1;
      version = `${now()}-${invalidations}`;
      cached = undefined;
    },
    async load(): Promise<StatuslineRenderer> {
      if (!existsSync(rendererPath)) {
        throw new Error(`Renderer file not found: ${rendererPath}`);
      }

      cached ??= importModule(`${pathToFileURL(rendererPath).href}?v=${version}`).then((module) => {
        if (typeof module.default !== "function") {
          throw new Error("Statusline renderer default export must be a function");
        }
        return module.default as StatuslineRenderer;
      });

      return cached;
    },
  };
}
