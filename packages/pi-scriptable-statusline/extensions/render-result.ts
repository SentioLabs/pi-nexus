import type { StatuslineRenderResult, StatuslineRendererResult, StatuslineSurface } from "../index.d.ts";

export interface NormalizedStatuslineRenderResult {
  footer: string[];
  widgets: {
    aboveEditor: string[];
    belowEditor: string[];
  };
  status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLines(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value.map((line, index) => {
    if (typeof line !== "string") {
      throw new Error(`${path}[${index}] must be a string`);
    }
    return line;
  });
}

export function normalizeRenderResult(
  result: StatuslineRendererResult,
  surface: StatuslineSurface,
): NormalizedStatuslineRenderResult {
  if (Array.isArray(result)) {
    const lines = normalizeLines(result, "result");
    return {
      footer: surface === "footer" ? lines : [],
      widgets: {
        aboveEditor: surface === "aboveEditor" ? lines : [],
        belowEditor: surface === "belowEditor" ? lines : [],
      },
    };
  }

  if (!isRecord(result)) {
    throw new Error("Renderer must return an array of strings or an object");
  }

  const widgets = isRecord(result.widgets) ? result.widgets : {};
  const normalized: NormalizedStatuslineRenderResult = {
    footer: normalizeLines(result.footer, "result.footer"),
    widgets: {
      aboveEditor: normalizeLines(widgets.aboveEditor, "result.widgets.aboveEditor"),
      belowEditor: normalizeLines(widgets.belowEditor, "result.widgets.belowEditor"),
    },
  };

  if (result.status !== undefined) {
    if (typeof result.status !== "string") {
      throw new Error("result.status must be a string when provided");
    }
    normalized.status = result.status;
  }

  return normalized;
}

export type { StatuslineRenderResult, StatuslineRendererResult, StatuslineSurface };
