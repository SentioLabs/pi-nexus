export type StatuslineSurface = "footer" | "aboveEditor" | "belowEditor";

export interface StatuslineTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
}

export interface StatuslineUtils {
  visibleWidth(text: string): number;
  truncate(text: string, width: number, ellipsis?: string): string;
}

export interface StatuslineModelSnapshot {
  provider: string | null;
  id: string | null;
  label: string;
}

export interface StatuslineRepoSnapshot {
  name: string;
  root: string | null;
}

export interface StatuslineGitSnapshot {
  branch: string | null;
}

export interface StatuslineContextSnapshot {
  tokens: number;
  window: number;
  percent: number | null;
}

export interface StatuslineTokenSnapshot {
  input: number;
  output: number;
  total: number;
  totalLabel: string;
}

export interface StatuslineCostSnapshot {
  total: number;
  totalLabel: string;
}

export interface StatuslineLimitWindowSnapshot {
  used: number | null;
  limit: number | null;
  percent: number | null;
  resetAt: string | null;
  label: string;
}

export interface StatuslineLimitSnapshot {
  daily: StatuslineLimitWindowSnapshot | null;
  weekly: StatuslineLimitWindowSnapshot | null;
  source: string | null;
}

export interface StatuslineExtensionStatusSnapshot {
  key: string;
  text: string;
}

export interface StatuslineSessionSnapshot {
  id: string | null;
  turn: number;
}

export interface StatuslineRenderInput {
  surface: StatuslineSurface;
  width: number;
  cwd: string;
  model: StatuslineModelSnapshot;
  repo: StatuslineRepoSnapshot;
  git: StatuslineGitSnapshot;
  context: StatuslineContextSnapshot;
  tokens: StatuslineTokenSnapshot;
  cost: StatuslineCostSnapshot;
  limits: StatuslineLimitSnapshot;
  extensionStatuses: readonly StatuslineExtensionStatusSnapshot[];
  session: StatuslineSessionSnapshot;
  theme: StatuslineTheme;
  utils: StatuslineUtils;
}

export interface StatuslineWidgetRenderResult {
  aboveEditor?: readonly string[];
  belowEditor?: readonly string[];
}

export interface StatuslineRenderResult {
  footer?: readonly string[];
  widgets?: StatuslineWidgetRenderResult;
  status?: string;
}

export type StatuslineRendererResult = StatuslineRenderResult | readonly string[];

export type StatuslineRenderer = (
  input: StatuslineRenderInput,
) => StatuslineRendererResult | Promise<StatuslineRendererResult>;
