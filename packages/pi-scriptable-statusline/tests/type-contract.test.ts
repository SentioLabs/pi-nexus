import type {
  StatuslineRenderInput,
  StatuslineRenderResult,
  StatuslineRenderer,
  StatuslineSurface,
} from "../index.d.ts";

const surface: StatuslineSurface = "footer";

const input = {
  surface,
  width: 80,
  cwd: "/tmp/example",
  model: { provider: "anthropic", id: "claude-sonnet", label: "sonnet" },
  repo: { name: "example", root: "/tmp/example" },
  git: { branch: "main" },
  context: { tokens: 1234, window: 200000, percent: 1 },
  tokens: { input: 100, output: 50, total: 150, totalLabel: "150" },
  cost: { total: 0.001, totalLabel: "$0.001" },
  limits: { daily: null, weekly: null, source: null },
  extensionStatuses: [{ key: "mode", text: "plan" }],
  session: { id: null, turn: 0 },
  theme: { fg: (_color: string, text: string) => text },
  utils: {
    visibleWidth: (text: string) => text.length,
    truncate: (text: string, width: number) => text.slice(0, width),
  },
} satisfies StatuslineRenderInput;

const result = {
  footer: ["footer"],
  widgets: { aboveEditor: ["above"], belowEditor: ["below"] },
  status: "ok",
} satisfies StatuslineRenderResult;

const renderer: StatuslineRenderer = async (received) => {
  const observedSurface: StatuslineSurface = received.surface;
  void observedSurface;
  return result;
};

void renderer(input);
