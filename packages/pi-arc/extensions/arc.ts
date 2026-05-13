import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  ARC_MODELS_CONFIG_VERSION,
  type ArcModelProfileKey,
  type ArcThinkingLevel,
  applyArcThinkingSuffix,
  getSupportedArcThinkingLevels,
  loadArcModelsConfig,
  normalizeArcModelsConfig,
  resolveArcModelProfile,
  resolveArcModelsConfigPath,
  saveArcModelsConfig,
  toArcModelInfo,
} from "./arc/model-profiles.ts";
import { openArcModelProfilesEditor } from "./arc/model-profiles-ui.ts";
import {
  ARC_PI_SUBAGENTS,
  ARC_SUBAGENT_GENERATED_MARKER,
  buildArcSubagentMarkdown,
  buildArcSubagentMetadata,
  isGeneratedArcSubagent,
  materializeArcSubagents,
  resolveArcSubagentDir,
  type ArcSubagentMaterializationReason,
  type ArcSubagentMaterializationResult,
  type ArcSubagentScope,
} from "./arc/subagents.ts";

type ArcCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const WORKFLOW_SKILLS: Array<{ command: string; skill: string; description: string }> = [
  {
    command: "arc-brainstorm",
    skill: "arc-brainstorm",
    description: "Use arc-brainstorm for design discovery and trade-off analysis",
  },
  {
    command: "arc-plan",
    skill: "arc-plan",
    description: "Use arc-plan to break an approved design into arc implementation tasks",
  },
  {
    command: "arc-build",
    skill: "arc-build",
    description: "Use arc-build to orchestrate implementation of arc tasks",
  },
  {
    command: "arc-debug",
    skill: "arc-debug",
    description: "Use arc-debug for structured root-cause investigation",
  },
  {
    command: "arc-review",
    skill: "arc-review",
    description: "Use arc-review to review changes against an arc task",
  },
  {
    command: "arc-verify",
    skill: "arc-verify",
    description: "Use arc-verify for evidence-based completion checks",
  },
  {
    command: "arc-finish",
    skill: "arc-finish",
    description: "Use arc-finish to wrap up a session and persist handoff context",
  },
  {
    command: "arc-source-sync",
    skill: "arc-source-sync",
    description: "Maintainer-only: sync pi-arc resources from the Arc source plugin",
  },
];

function outputOf(result: ArcCommandResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout && stderr) return `${stdout}\n\nstderr:\n${stderr}`;
  return stdout || stderr || `(exit code ${result.code ?? "unknown"}, no output)`;
}

type ArcAgentName = "builder" | "code-reviewer" | "doc-writer" | "evaluator" | "issue-manager" | "spec-reviewer";

const ARC_AGENT_NAMES = [
  "builder",
  "code-reviewer",
  "doc-writer",
  "evaluator",
  "issue-manager",
  "spec-reviewer",
] as const;

const ARC_AGENT_PROFILE_KEYS = Object.fromEntries(
  ARC_PI_SUBAGENTS.map(({ source, profileKey }) => [source, profileKey]),
) as Record<ArcAgentName, ArcModelProfileKey>;

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "..");
const AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");
const ARC_SUBAGENT_SKIP_REASON = "existing file is missing the generated marker; preserving user edits";

type ArcModelTier = "nano" | "small" | "standard" | "large";

type ArcModelTierMap = Record<ArcModelTier, string>;

const DEFAULT_ARC_MODEL_TIERS: ArcModelTierMap = {
  nano: "openai-codex/gpt-5.4-mini",
  small: "openai-codex/gpt-5.4-mini",
  standard: "openai-codex/gpt-5.3-codex",
  large: "openai-codex/gpt-5.5",
};

const MODEL_TIER_ALIASES: Record<string, ArcModelTier> = {
  nano: "nano",
  haiku: "small",
  mini: "small",
  small: "small",
  sonnet: "standard",
  standard: "standard",
  opus: "large",
  large: "large",
};

function parseAgentMarkdown(markdown: string): { prompt: string; description?: string; model?: string; tools?: string[] } {
  if (!markdown.startsWith("---")) return { prompt: markdown.trim() };
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return { prompt: markdown.trim() };

  const frontmatter = markdown.slice(3, end).trim().split(/\r?\n/);
  const body = markdown.slice(end + "\n---".length).trim();
  let description: string | undefined;
  let model: string | undefined;
  const tools: string[] = [];
  let inTools = false;

  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (trimmed.startsWith("description:")) {
      description = trimmed.slice("description:".length).trim().replace(/^['\"]|['\"]$/g, "");
      inTools = false;
      continue;
    }
    if (trimmed.startsWith("model:")) {
      model = trimmed.slice("model:".length).trim().replace(/^['\"]|['\"]$/g, "");
      inTools = false;
      continue;
    }
    if (trimmed.startsWith("tools:")) {
      inTools = true;
      const inline = trimmed.slice("tools:".length).trim();
      if (inline) tools.push(...inline.split(",").map((tool) => tool.trim()).filter(Boolean));
      continue;
    }
    if (inTools && trimmed.startsWith("-")) {
      tools.push(trimmed.slice(1).trim());
      continue;
    }
    if (trimmed && !trimmed.startsWith("#")) inTools = false;
  }

  return { prompt: body, description, model, tools: tools.length > 0 ? tools : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function applyTierOverrides(target: ArcModelTierMap, settings: Record<string, unknown> | undefined) {
  const arc = isRecord(settings?.arc) ? settings.arc : undefined;
  const modelTiers = isRecord(arc?.modelTiers) ? arc.modelTiers : undefined;
  if (!modelTiers) return;

  for (const tier of Object.keys(DEFAULT_ARC_MODEL_TIERS) as ArcModelTier[]) {
    const value = modelTiers[tier];
    if (typeof value === "string" && value.trim()) target[tier] = value.trim();
  }
}

async function loadArcModelTiers(cwd: string): Promise<ArcModelTierMap> {
  const tiers: ArcModelTierMap = { ...DEFAULT_ARC_MODEL_TIERS };

  applyTierOverrides(tiers, await readJsonFile(path.join(homedir(), ".pi", "agent", "settings.json")));

  const projectSettings: string[] = [];
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    projectSettings.push(path.join(dir, ".pi", "settings.json"));
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  for (const settingsPath of projectSettings.reverse()) {
    applyTierOverrides(tiers, await readJsonFile(settingsPath));
  }

  return tiers;
}

async function modelPattern(model: string | undefined, cwd: string): Promise<string | undefined> {
  if (!model) return undefined;
  const trimmed = model.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return undefined;

  const tier = MODEL_TIER_ALIASES[normalized];
  if (!tier) return trimmed;

  const tiers = await loadArcModelTiers(cwd);
  return tiers[tier];
}

type ArcAvailableModel = Parameters<typeof toArcModelInfo>[0];
type ArcModelInfo = ReturnType<typeof toArcModelInfo>;
type ArcModelsConfig = Awaited<ReturnType<typeof loadArcModelsConfig>>;
type ArcModelSource = ReturnType<typeof resolveArcModelProfile>["source"];

type ArcModelForAgentResolution = {
  profileKey: ArcModelProfileKey;
  model?: string;
  modelSource: ArcModelSource;
  warning?: string;
  unavailableModel?: string;
};

const ARC_RECOMMENDED_PROFILE_KEYS: ArcModelProfileKey[] = [
  "brainstorm",
  "plan",
  "issueManager",
  "builder",
  "codeReviewer",
  "docWriter",
  "specReviewer",
  "evaluator",
];

type ArcProfileRecommendation = {
  modelId: string;
  thinking: ArcThinkingLevel;
  reason: string;
};

const ARC_RECOMMENDED_MODEL_PROVIDER = "openai-codex";

const ARC_PROFILE_RECOMMENDATIONS: Record<ArcModelProfileKey, ArcProfileRecommendation> = {
  brainstorm: { modelId: "gpt-5.5", thinking: "high", reason: "design exploration and architecture judgment" },
  plan: { modelId: "gpt-5.5", thinking: "high", reason: "task breakdown and sequencing" },
  issueManager: { modelId: "gpt-5.4-mini", thinking: "off", reason: "Arc CLI formatting and issue updates" },
  builder: { modelId: "gpt-5.3-codex", thinking: "medium", reason: "implementation and code navigation" },
  codeReviewer: { modelId: "gpt-5.5", thinking: "high", reason: "review judgment and risk detection" },
  docWriter: { modelId: "gpt-5.4-mini", thinking: "low", reason: "documentation prose and light reasoning" },
  specReviewer: { modelId: "gpt-5.5", thinking: "high", reason: "spec compliance and ambiguity detection" },
  evaluator: { modelId: "gpt-5.5", thinking: "high", reason: "adversarial validation" },
};

type BrainstormProfilePromptAction = "recommended" | "customize" | "skip" | "reconfigure" | "fallback" | "disable" | "cancel";

type BrainstormProfilePromptOption = {
  label: string;
  description: string;
  action: BrainstormProfilePromptAction;
};

function matchesArcRecommendedModelId(model: ArcModelInfo, modelId: string): boolean {
  return model.id === modelId || model.fullId.endsWith(`/${modelId}`);
}

function findRecommendedArcModel(
  recommendation: ArcProfileRecommendation,
  models: ArcModelInfo[],
  preferredProvider?: string,
): ArcModelInfo | undefined {
  const candidates = models.filter((model) => matchesArcRecommendedModelId(model, recommendation.modelId));
  const defaultProvider = candidates.find((model) => model.provider === ARC_RECOMMENDED_MODEL_PROVIDER);
  const provider = preferredProvider?.trim();
  const preferred = provider ? candidates.find((model) => model.provider === provider) : undefined;
  return defaultProvider ?? preferred ?? candidates[0];
}

function recommendedArcModelForProfile(
  profileKey: ArcModelProfileKey,
  models: ArcModelInfo[],
  preferredProvider?: string,
): { recommendation: ArcProfileRecommendation; model?: ArcModelInfo } {
  const recommendation = ARC_PROFILE_RECOMMENDATIONS[profileKey];
  return { recommendation, model: findRecommendedArcModel(recommendation, models, preferredProvider) };
}

function applyRecommendedArcModelProfiles(config: ArcModelsConfig, models: ArcModelInfo[], preferredProvider?: string): ArcModelsConfig {
  for (const profileKey of ARC_RECOMMENDED_PROFILE_KEYS) {
    const recommended = recommendedArcModelForProfile(profileKey, models, preferredProvider);
    if (!recommended.model) continue;
    const recommendation = recommended.recommendation;
    const levels = getSupportedArcThinkingLevels(recommended.model);
    config.modelProfiles[profileKey] = {
      ...config.modelProfiles[profileKey],
      model: recommended.model.fullId,
      thinking: levels.includes(recommendation.thinking) ? recommendation.thinking : "off",
    };
  }
  config.setup = { ...config.setup, completedAt: new Date().toISOString(), dismissedAt: null };
  return config;
}

function selectedPromptAction(options: BrainstormProfilePromptOption[], cursor: number): BrainstormProfilePromptAction {
  return options[cursor]?.action ?? "cancel";
}

function renderBrainstormProfilePrompt(
  title: string,
  message: string,
  options: BrainstormProfilePromptOption[],
  cursor: number,
): string[] {
  const lines = [title, "", message, ""];
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!;
    const prefix = index === cursor ? "›" : " ";
    lines.push(`${prefix} ${index + 1}. ${option.label}`);
    lines.push(`   ${option.description}`);
  }
  lines.push("", "Enter selects · 1-3 selects directly · Esc cancels");
  return lines;
}

async function promptBrainstormProfileSetup(
  ctx: ExtensionContext,
  title: string,
  message: string,
  options: BrainstormProfilePromptOption[],
): Promise<BrainstormProfilePromptAction> {
  return ctx.ui.custom<BrainstormProfilePromptAction>(
    (tui, _theme, _kb, done) => {
      let cursor = 0;
      return {
        handleInput(data: string): void {
          if (data === "\u0003" || data === "\u001b") {
            done("cancel");
            return;
          }
          if (data === "\r" || data === "\n") {
            done(selectedPromptAction(options, cursor));
            return;
          }
          if (data === "\u001b[A" || data === "k") {
            cursor = cursor === 0 ? options.length - 1 : cursor - 1;
            tui.requestRender();
            return;
          }
          if (data === "\u001b[B" || data === "j") {
            cursor = cursor === options.length - 1 ? 0 : cursor + 1;
            tui.requestRender();
            return;
          }

          const numeric = Number(data);
          if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
            done(selectedPromptAction(options, numeric - 1));
          }
        },
        render(): string[] {
          return renderBrainstormProfilePrompt(title, message, options, cursor);
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: 72, maxHeight: "80%" } },
  );
}

async function materializeArcSubagentsAfterModelSave(ctx: ExtensionContext): Promise<void> {
  const materialized = await materializeArcSubagentsForContext(ctx, "arc_models_save");
  notifyArcSubagentMaterialization(ctx, materialized);
}

async function saveArcModelsConfigWithMaterialization(
  ctx: ExtensionContext,
  config: ArcModelsConfig,
  configPath: string,
): Promise<void> {
  await saveArcModelsConfig(config, configPath);
  if (ctx.hasUI) ctx.ui.notify("Arc model profiles saved", "info");
  await materializeArcSubagentsAfterModelSave(ctx);
}

async function openAndMaybeSaveArcModelProfiles(
  ctx: ExtensionContext,
  config: ArcModelsConfig,
  configPath: string,
  preferredProvider: string | undefined,
  markSetupComplete: boolean,
): Promise<boolean> {
  const result = await openArcModelProfilesEditor(ctx, { config, configPath, preferredProvider });
  if (result.action !== "save" || !result.config) return false;
  if (markSetupComplete) {
    result.config.setup = { ...result.config.setup, completedAt: new Date().toISOString(), dismissedAt: null };
  }
  await saveArcModelsConfigWithMaterialization(ctx, result.config, configPath);
  return true;
}

async function resolveArcModelForAgent(
  agent: ArcAgentName,
  explicitModel: string | undefined,
  frontmatterModel: string | undefined,
  cwd: string,
  availableModels: ArcAvailableModel[],
  preferredProvider?: string,
): Promise<ArcModelForAgentResolution> {
  const profileKey = ARC_AGENT_PROFILE_KEYS[agent];
  const config = await loadArcModelsConfig();
  const explicitPattern = await modelPattern(explicitModel, cwd);
  const tierModel = await modelPattern(frontmatterModel, cwd);
  const resolution = resolveArcModelProfile({
    profileKey,
    explicitModel: explicitPattern,
    config,
    availableModels: availableModels.map(toArcModelInfo),
    tierModel,
    preferredProvider,
  });

  return {
    profileKey,
    model: applyArcThinkingSuffix(resolution.model, resolution.thinking),
    modelSource: resolution.source,
    warning: resolution.warning,
    unavailableModel: resolution.unavailableModel,
  };
}

async function maybeEnsureBrainstormProfileReady(ctx: ExtensionContext, _args?: string): Promise<boolean> {
  if (!ctx.hasUI) return true;

  const preferredProvider = ctx.model?.provider;
  const configPath = resolveArcModelsConfigPath();
  const config = await loadArcModelsConfig(configPath);
  const availableModels = ctx.modelRegistry.getAvailable().map(toArcModelInfo);
  const brainstormResolution = resolveArcModelProfile({
    profileKey: "brainstorm",
    config,
    availableModels,
    preferredProvider,
  });

  if (brainstormResolution.unavailableModel && config.modelProfiles.brainstorm?.model) {
    const action = await promptBrainstormProfileSetup(
      ctx,
      "Arc brainstorm model unavailable",
      brainstormResolution.warning ?? "Configured brainstorm model is unavailable.",
      [
        {
          label: "Reconfigure now",
          description: "Open /arc-models and continue only after saving an available brainstorm profile.",
          action: "reconfigure",
        },
        {
          label: "Use fallback once",
          description: "Continue this brainstorm without changing model profile configuration.",
          action: "fallback",
        },
        {
          label: "Disable profile",
          description: "Remove the brainstorm profile, save, and continue with fallback behavior.",
          action: "disable",
        },
      ],
    );

    if (action === "reconfigure") return openAndMaybeSaveArcModelProfiles(ctx, config, configPath, preferredProvider, true);
    if (action === "fallback") return true;
    if (action === "disable") {
      delete config.modelProfiles.brainstorm;
      await saveArcModelsConfigWithMaterialization(ctx, config, configPath);
      return true;
    }
    return false;
  }

  if (config.setup?.completedAt || config.setup?.dismissedAt) return true;

  const action = await promptBrainstormProfileSetup(
    ctx,
    "Set up Arc model profiles",
    "Configure focused model profiles before using /arc-brainstorm, or continue with legacy fallback behavior.",
    [
      {
        label: "Use recommended defaults",
        description: "Save available recommended models for Arc profiles and continue.",
        action: "recommended",
      },
      {
        label: "Customize",
        description: "Open /arc-models and continue only after saving your choices.",
        action: "customize",
      },
      {
        label: "Skip for now",
        description: "Dismiss setup and continue with fallback behavior.",
        action: "skip",
      },
    ],
  );

  if (action === "recommended") {
    applyRecommendedArcModelProfiles(config, availableModels, preferredProvider);
    await saveArcModelsConfigWithMaterialization(ctx, config, configPath);
    return true;
  }
  if (action === "customize") return openAndMaybeSaveArcModelProfiles(ctx, config, configPath, preferredProvider, true);
  if (action === "skip") {
    config.setup = { ...config.setup, dismissedAt: new Date().toISOString() };
    await saveArcModelsConfig(config, configPath);
    return true;
  }

  return false;
}

function runPiSubprocess(args: string[], cwd: string, signal?: AbortSignal): Promise<ArcCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ArcCommandResult) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", abort);
      resolve(result);
    };

    const abort = () => child.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ code: 127, stdout, stderr: stderr + error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

function truncatedOutput(text: string): string {
  const truncation = truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}).]`;
}

function parseArcSubagentScopeArg(rawArgs: string): { scope: ArcSubagentScope; error?: string } {
  const tokens = rawArgs
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return { scope: "user" };
  if (tokens.length > 1) {
    return {
      scope: "user",
      error: `Unsupported arguments: ${tokens.join(" ")}. Use one of: user, --user, project, --project.`,
    };
  }

  const token = tokens[0]?.toLowerCase();
  if (token === "project" || token === "--project") return { scope: "project" };
  if (token === "user" || token === "--user") return { scope: "user" };
  return {
    scope: "user",
    error: `Unknown scope '${tokens[0]}'. Use one of: user, --user, project, --project.`,
  };
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function materializeArcSubagentsForContext(
  ctx: ExtensionContext,
  reason: ArcSubagentMaterializationReason,
  scope: ArcSubagentScope = "user",
): Promise<ArcSubagentMaterializationResult> {
  const configPath = resolveArcModelsConfigPath();
  const homeDir = homedir();

  let normalizedConfigText: string;
  try {
    const raw = await readFile(configPath, "utf8");
    normalizedConfigText = `${JSON.stringify(normalizeArcModelsConfig(JSON.parse(raw)), null, 2)}\n`;
  } catch {
    normalizedConfigText = `${JSON.stringify(normalizeArcModelsConfig({ version: ARC_MODELS_CONFIG_VERSION, modelProfiles: {} }), null, 2)}\n`;
  }

  const targetDir = resolveArcSubagentDir(scope, ctx.cwd, homeDir);
  const legacyTargetDir = scope === "user" ? resolveArcSubagentDir(scope, ctx.cwd, homeDir, { legacyUserDir: true }) : undefined;
  const modelsConfigSha256 = sha256Text(normalizedConfigText);

  const materialized = await materializeArcSubagents({
    reason,
    scope,
    cwd: ctx.cwd,
    homeDir,
    agentsDir: AGENTS_DIR,
    modelsConfigSha256,
    allowLegacyUserDirFallback: scope === "user",
    renderAgent: async (source, target) => {
      const sourceMarkdown = await readFile(path.join(AGENTS_DIR, `${source}.md`), "utf8");
      const parsedSource = parseAgentMarkdown(sourceMarkdown);
      const modelResolution = await resolveArcModelForAgent(
        source as ArcAgentName,
        undefined,
        parsedSource.model,
        ctx.cwd,
        ctx.modelRegistry.getAvailable(),
        ctx.model?.provider,
      );
      const resolvedModel = modelResolution.model ?? (await modelPattern(parsedSource.model, ctx.cwd));
      const generatedAt = new Date().toISOString();
      const rendered = buildArcSubagentMarkdown({
        targetName: target,
        sourceName: source,
        sourceMarkdown,
        parsedSource,
        resolvedModel,
        modelProfileKey: modelResolution.profileKey,
        modelResolutionSource: modelResolution.modelSource,
        modelsConfigHash: modelsConfigSha256,
        generatedAt,
      });
      const expectedMetadata = buildArcSubagentMetadata({
        sourceName: source,
        sourceSha256: sha256Text(sourceMarkdown),
        modelProfileKey: modelResolution.profileKey,
        modelResolutionSource: modelResolution.modelSource,
        modelsConfigSha256,
        generatedAt,
      });
      if (!rendered.includes(ARC_SUBAGENT_GENERATED_MARKER) || !rendered.includes(expectedMetadata)) {
        throw new Error(`Generated Arc subagent metadata missing source-sha256 freshness block for ${target}`);
      }
      return rendered;
    },
  });

  if (materialized.targetDir !== targetDir && materialized.targetDir !== legacyTargetDir) {
    throw new Error(`Arc subagent target directory mismatch: expected ${targetDir}, got ${materialized.targetDir}`);
  }

  return materialized;
}

function notifyArcSubagentMaterialization(ctx: ExtensionContext, result: ArcSubagentMaterializationResult) {
  const skipped = result.writes.filter((entry) => entry.status === "skipped");
  const failed = result.writes.filter((entry) => entry.status === "failed");
  const hasWarnings = skipped.length > 0 || failed.length > 0 || result.shadows.length > 0;
  if (!hasWarnings) return;

  if (ctx.hasUI) {
    const shadowSummary = result.shadows.slice(0, 2).map((shadow) => `${shadow.agent} at ${shadow.projectPath}`).join("; ");
    ctx.ui.notify(
      `Arc subagent materialization (${result.reason}): skipped ${skipped.length}, failed ${failed.length}, shadows ${result.shadows.length}`
        + (shadowSummary ? `. Project scope wins over user scope: ${shadowSummary}` : ""),
      failed.length > 0 || result.shadows.length > 0 ? "warning" : "info",
    );
  }
}

async function formatSkippedArcSubagentDetails(result: ArcSubagentMaterializationResult): Promise<string[]> {
  const skipped = result.writes.filter((entry) => entry.status === "skipped");
  const details: string[] = [];
  for (const entry of skipped) {
    try {
      const existing = await readFile(entry.target, "utf8");
      if (isGeneratedArcSubagent(existing)) {
        details.push(`- ${entry.agent}: skipped because the existing generated file was not rewritten`);
        continue;
      }
    } catch {
      // Preserve the materializer-reported reason when the file cannot be re-read.
    }
    details.push(`- ${entry.agent}: ${entry.reason ?? ARC_SUBAGENT_SKIP_REASON}`);
  }
  return details;
}

function runArcWithStdin(
  args: string[],
  stdin: unknown,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<ArcCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("arc", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ArcCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
      resolve(result);
    };

    const abort = () => {
      child.kill("SIGTERM");
    };

    const timeout = setTimeout(() => {
      stderr += `Timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.on("error", (error) => {
      stderr += error.message;
    });
    child.on("error", (error) => {
      finish({ code: 127, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });

    child.stdin.end(`${JSON.stringify(stdin)}\n`);
  });
}

export default function arcExtension(pi: ExtensionAPI) {
  let primeCache = "";
  let primeError = "";
  let lastPrimeAt = 0;

  async function runArc(args: string[], ctx: ExtensionContext, timeout = 15_000): Promise<ArcCommandResult> {
    const result = await pi.exec("arc", args, { timeout, signal: ctx.signal });
    return {
      code: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  async function refreshPrime(ctx: ExtensionContext): Promise<boolean> {
    try {
      const result = await runArc(["prime"], ctx, 20_000);
      lastPrimeAt = Date.now();
      if (result.code === 0) {
        primeCache = result.stdout.trim();
        primeError = "";
        return true;
      }
      primeError = outputOf(result);
      return false;
    } catch (error) {
      lastPrimeAt = Date.now();
      primeError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  function sendArcMessage(title: string, body: string) {
    pi.sendMessage({
      customType: "arc",
      content: `## ${title}\n\n${body}`,
      display: true,
    });
  }

  async function sendArcCommandOutput(ctx: ExtensionContext, title: string, args: string[], timeout = 30_000) {
    const result = await runArc(args, ctx, timeout);
    const status = result.code === 0 ? "info" : "error";
    if (ctx.hasUI) ctx.ui.notify(`arc ${args.join(" ")} ${result.code === 0 ? "completed" : "failed"}`, status);
    sendArcMessage(title, `\`arc ${args.join(" ")}\` exited with code ${result.code}.\n\n\`\`\`\n${outputOf(result)}\n\`\`\``);
  }

  pi.registerTool({
    name: "arc_agent",
    label: "Arc Agent",
    description:
      "Run a bundled Arc specialist agent (builder, reviewer, issue-manager, etc.) in a fresh Pi subprocess. Output is truncated to 50KB/2000 lines.",
    promptSnippet: "Delegate Arc issue-management, implementation, review, docs, and evaluation tasks to bundled specialist agents.",
    promptGuidelines: [
      "Prefer true pi-subagents Arc specialists (arc-builder, arc-issue-manager, arc-code-reviewer, etc.) when available/auto-materialized so long runs can be monitored with /subagents-status.",
      "For bulk issue creation, do not use arc_agent issue-manager when subagent({ action: \"list\" }) shows arc-issue-manager; dispatch arc-issue-manager asynchronously instead.",
      "Use arc_agent only as the self-contained fallback when Arc pi-subagents definitions are unavailable or a workflow skill explicitly asks for the fallback.",
      "Right-size fallback arc_agent dispatches with model tiers: nano for bulk CLI issue creation, small for mechanical/docs tasks, standard for normal contained work, large for complex or high-risk work.",
    ],
    parameters: Type.Object({
      agent: StringEnum(ARC_AGENT_NAMES),
      task: Type.String({ description: "Complete task prompt to give the subagent." }),
      model: Type.Optional(Type.String({ description: "Optional Pi model pattern override, e.g. nano, haiku, sonnet, opus." })),
      isolation: Type.Optional(StringEnum(["none", "worktree"] as const)),
    }),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (params.isolation === "worktree") {
        throw new Error("arc_agent worktree isolation is not implemented yet. Use isolation='none' or run tasks sequentially.");
      }

      const agent = params.agent as ArcAgentName;
      const agentPath = path.join(AGENTS_DIR, `${agent}.md`);
      const markdown = await readFile(agentPath, "utf8");
      const config = parseAgentMarkdown(markdown);
      const requestedModel = params.model ?? config.model;
      const modelResolution = await resolveArcModelForAgent(
        agent,
        params.model,
        config.model,
        ctx.cwd,
        ctx.modelRegistry.getAvailable(),
        ctx.model?.provider,
      );
      const selectedModel = modelResolution.model;
      const selectedTools = config.tools?.map((tool) => tool.toLowerCase()).join(",");

      const args = ["-p", "--no-session", "--system-prompt", config.prompt];
      if (selectedModel) args.push("--model", selectedModel);
      if (selectedTools) args.push("--tools", selectedTools);
      args.push(params.task);

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Running arc_agent ${agent}${selectedModel ? ` with model ${selectedModel}` : ""}...`,
          },
        ],
        details: {
          agent,
          requestedModel,
          profileKey: modelResolution.profileKey,
          modelSource: modelResolution.modelSource,
          warning: modelResolution.warning,
          model: selectedModel,
          tools: selectedTools,
        },
      });

      const result = await runPiSubprocess(args, ctx.cwd, signal);
      const combined = outputOf(result);
      const text = truncatedOutput(combined);

      if (result.code !== 0) {
        throw new Error(`arc_agent ${agent} failed with exit code ${result.code}.\n\n${text}`);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          agent,
          requestedModel,
          profileKey: modelResolution.profileKey,
          modelSource: modelResolution.modelSource,
          warning: modelResolution.warning,
          model: selectedModel,
          tools: selectedTools,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
  } as any);

  pi.on("session_start", async (_event, ctx) => {
    try {
      const materialized = await materializeArcSubagentsForContext(ctx, "session_start");
      notifyArcSubagentMaterialization(ctx, materialized);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Arc subagent materialization failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }

    const ok = await refreshPrime(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(ok ? "arc context loaded" : "arc context unavailable", ok ? "info" : "warning");
    }

    const payload = {
      harness: "pi",
      event: "session_start",
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      timestamp: new Date().toISOString(),
    };

    // Best-effort compatibility with arc AI session tracking. Older arc versions may not
    // support this payload outside Claude; failures are intentionally non-fatal.
    await runArcWithStdin(["ai", "session", "start", "--stdin"], payload, ctx.cwd, ctx.signal).catch(() => undefined);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    await refreshPrime(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!primeCache && !primeError) {
      await refreshPrime(ctx);
    }

    const context = primeCache
      ? `<arc-context last-updated="${new Date(lastPrimeAt).toISOString()}">\n${primeCache}\n</arc-context>`
      : primeError
        ? `<arc-context status="unavailable">\narc prime failed: ${primeError}\n</arc-context>`
        : "";

    if (!context) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${context}`,
    };
  });

  pi.registerCommand("arc-refresh", {
    description: "Refresh cached arc prime context",
    handler: async (_args, ctx) => {
      const ok = await refreshPrime(ctx);
      if (ctx.hasUI) ctx.ui.notify(ok ? "arc context refreshed" : "arc prime failed", ok ? "info" : "error");
      sendArcMessage("Arc context refresh", ok ? "arc prime completed successfully." : `arc prime failed:\n\n\`\`\`\n${primeError}\n\`\`\``);
    },
  });

  pi.registerCommand("arc-prime", {
    description: "Show cached arc prime context, refreshing if needed",
    handler: async (_args, ctx) => {
      if (!primeCache && !primeError) await refreshPrime(ctx);
      if (primeCache) {
        sendArcMessage("Arc prime", `\`\`\`\n${primeCache}\n\`\`\``);
      } else {
        sendArcMessage("Arc prime unavailable", `\`\`\`\n${primeError || "No arc prime output."}\n\`\`\``);
      }
    },
  });

  pi.registerCommand("arc-onboard", {
    description: "Run arc onboard for the current project",
    handler: async (_args, ctx) => {
      await sendArcCommandOutput(ctx, "Arc onboard", ["onboard"], 60_000);
      await refreshPrime(ctx);
    },
  });

  pi.registerCommand("arc-which", {
    description: "Show which arc project is active",
    handler: async (_args, ctx) => {
      await sendArcCommandOutput(ctx, "Arc project resolution", ["which"], 30_000);
    },
  });

  pi.registerCommand("arc-subagents-sync", {
    description: "Repair generated Arc specialist definitions (arc-builder, arc-doc-writer, arc-spec-reviewer, arc-code-reviewer, arc-evaluator, arc-issue-manager) in user/project scope",
    handler: async (args, ctx) => {
      const parsedArgs = parseArcSubagentScopeArg(args);
      if (parsedArgs.error) {
        if (ctx.hasUI) ctx.ui.notify("arc-subagents-sync failed", "error");
        sendArcMessage(
          "Arc subagents sync failed",
          `${parsedArgs.error}\n\nUsage:\n- \`/arc-subagents-sync\` (user scope)\n- \`/arc-subagents-sync user\`\n- \`/arc-subagents-sync project\` (repairs \`${path.join(".pi", "agents")}\`)\n\nLegacy user-scope generated agents may exist at \`${path.join(".pi", "agent", "agents")}\`.`,
        );
        return;
      }

      const materialized = await materializeArcSubagentsForContext(ctx, "manual_repair", parsedArgs.scope);
      notifyArcSubagentMaterialization(ctx, materialized);

      const written = materialized.writes.filter((entry) => entry.status === "written");
      const unchanged = materialized.writes.filter((entry) => entry.status === "unchanged");
      const skipped = materialized.writes.filter((entry) => entry.status === "skipped");
      const failed = materialized.writes.filter((entry) => entry.status === "failed");

      const skippedDetails = await formatSkippedArcSubagentDetails(materialized);
      const failedDetails = failed.map((entry) => `- ${entry.agent}: ${entry.reason ?? "unknown failure"}`);
      const shadowDetails = materialized.shadows.map((shadow) => {
        const generatedLabel = shadow.generated ? "generated" : "non-generated";
        const staleLabel = shadow.stale ? "stale" : "current";
        return `- ${shadow.agent}: project=\`${shadow.projectPath}\`, user=\`${shadow.userPath}\` (${generatedLabel}, ${staleLabel}; project scope wins over user scope)`;
      });

      const detailSections: string[] = [];
      if (skippedDetails.length > 0) detailSections.push(`Skipped details:\n${skippedDetails.join("\n")}`);
      if (failedDetails.length > 0) detailSections.push(`Failed details:\n${failedDetails.join("\n")}`);
      if (shadowDetails.length > 0) detailSections.push(`Project shadow details:\n${shadowDetails.join("\n")}`);

      sendArcMessage(
        "Arc subagents sync",
        "/arc-subagents-sync is deprecated for normal activation. Arc specialists are auto-materialized in user scope. Use this command only to repair generated files or explicitly refresh legacy project-scope definitions.\n\n"
          + `Scope: **${materialized.scope}**\nTarget directory: \`${materialized.targetDir}\`\n\n`
          + `Written: ${written.length}\nUnchanged: ${unchanged.length}\nSkipped: ${skipped.length}\nFailed: ${failed.length}\nShadows: ${materialized.shadows.length}\n\n`
          + (detailSections.length > 0 ? `${detailSections.join("\n\n")}\n\n` : "")
          + 'Next steps:\n1. Run `subagent({ action: "list" })` to confirm the Arc specialists are available.\n2. Run `/agents` to inspect loaded agent definitions.\n3. Use `/subagents-status` to monitor active/recent async Arc specialist runs; idle installed agents are listed by `/agents`.',
      );
    },
  });

  pi.registerCommand("arc-models", {
    description: "Configure Arc model profiles",
    handler: async (_args, ctx) => {
      const configPath = resolveArcModelsConfigPath();
      const config = await loadArcModelsConfig(configPath);
      await openAndMaybeSaveArcModelProfiles(ctx, config, configPath, ctx.model?.provider, false);
    },
  });

  for (const { command, skill, description } of WORKFLOW_SKILLS) {
    pi.registerCommand(command, {
      description,
      handler: async (args, ctx) => {
        if (command === "arc-brainstorm" && !(await maybeEnsureBrainstormProfileReady(ctx, args))) return;
        pi.sendUserMessage(`/skill:${skill}${args.trim() ? ` ${args.trim()}` : ""}`);
      },
    });
  }
}
