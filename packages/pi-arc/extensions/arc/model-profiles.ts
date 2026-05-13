import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const ARC_MODELS_CONFIG_VERSION = 1 as const;

export const ARC_MODEL_PROFILE_KEYS = [
  "brainstorm",
  "plan",
  "issueManager",
  "builder",
  "codeReviewer",
  "docWriter",
  "specReviewer",
  "evaluator",
] as const;

export type ArcModelProfileKey = (typeof ARC_MODEL_PROFILE_KEYS)[number];

export const ARC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ArcThinkingLevel = (typeof ARC_THINKING_LEVELS)[number];

export type ArcThinkingLevelMap = Partial<Record<ArcThinkingLevel, string | null>>;

export interface ArcModelInfo {
  provider: string;
  id: string;
  fullId: string;
  reasoning?: boolean;
  thinkingLevelMap?: ArcThinkingLevelMap;
}

export interface ArcModelProfile {
  model?: string;
  thinking?: ArcThinkingLevel;
  escalateTo?: string;
}

export interface ArcModelsSetupState {
  completedAt?: string | null;
  dismissedAt?: string | null;
}

export interface ArcModelsConfig {
  version: typeof ARC_MODELS_CONFIG_VERSION;
  modelProfiles: Partial<Record<ArcModelProfileKey, ArcModelProfile>>;
  setup?: ArcModelsSetupState;
}

export type ArcModelResolutionSource =
  | "explicit"
  | "profile"
  | "tier"
  | "fallback"
  | "unconfigured";

export interface ArcModelProfileResolution {
  profileKey: ArcModelProfileKey;
  source: ArcModelResolutionSource;
  model?: string;
  thinking?: ArcThinkingLevel;
  unavailableModel?: string;
  shouldPrompt: boolean;
  warning?: string;
}

export interface ResolveArcModelProfileInput {
  profileKey: ArcModelProfileKey;
  explicitModel?: string;
  config: ArcModelsConfig;
  availableModels: ArcModelInfo[];
  tierModel?: string;
  fallbackModel?: string;
  preferredProvider?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveArcModelsConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  return path.join(configHome, "pi-arc", "models.json");
}

export async function loadArcModelsConfig(filePath = resolveArcModelsConfigPath()): Promise<ArcModelsConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    return normalizeArcModelsConfig(JSON.parse(raw));
  } catch {
    return { version: ARC_MODELS_CONFIG_VERSION, modelProfiles: {} };
  }
}

export async function saveArcModelsConfig(config: ArcModelsConfig, filePath = resolveArcModelsConfigPath()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalizeArcModelsConfig(config), null, 2)}\n`, "utf8");
}

export function normalizeArcModelsConfig(input: unknown): ArcModelsConfig {
  if (!isRecord(input) || input.version !== ARC_MODELS_CONFIG_VERSION || !isRecord(input.modelProfiles)) {
    return { version: ARC_MODELS_CONFIG_VERSION, modelProfiles: {} };
  }

  const config: ArcModelsConfig = { version: ARC_MODELS_CONFIG_VERSION, modelProfiles: {} };

  for (const key of ARC_MODEL_PROFILE_KEYS) {
    const rawProfile = input.modelProfiles[key];
    if (!isRecord(rawProfile)) continue;

    const profile: ArcModelProfile = {};
    if (typeof rawProfile.model === "string" && rawProfile.model.trim()) profile.model = rawProfile.model.trim();
    if (typeof rawProfile.thinking === "string" && (ARC_THINKING_LEVELS as readonly string[]).includes(rawProfile.thinking)) {
      profile.thinking = rawProfile.thinking as ArcThinkingLevel;
    }
    if (typeof rawProfile.escalateTo === "string" && rawProfile.escalateTo.trim()) profile.escalateTo = rawProfile.escalateTo.trim();

    if (Object.keys(profile).length > 0) config.modelProfiles[key] = profile;
  }

  if (isRecord(input.setup)) {
    const setup: ArcModelsSetupState = {};
    let hasSetupField = false;

    if (typeof input.setup.completedAt === "string" || input.setup.completedAt === null) {
      setup.completedAt = input.setup.completedAt;
      hasSetupField = true;
    }
    if (typeof input.setup.dismissedAt === "string" || input.setup.dismissedAt === null) {
      setup.dismissedAt = input.setup.dismissedAt;
      hasSetupField = true;
    }

    if (hasSetupField) config.setup = setup;
  }

  return config;
}

function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
  const suffix = ARC_THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
  if (!suffix) return { baseModel: model, thinkingSuffix: "" };
  return { baseModel: model.substring(0, colonIdx), thinkingSuffix: `:${suffix}` };
}

export function toArcModelInfo(model: { provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: ArcThinkingLevelMap }): ArcModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

export function findArcModelInfo(model: string | undefined, availableModels: ArcModelInfo[], preferredProvider?: string): ArcModelInfo | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const { baseModel } = splitKnownThinkingSuffix(trimmed);
  const exactModel = availableModels.find((availableModel) => availableModel.fullId === baseModel);
  if (exactModel) return exactModel;

  const provider = preferredProvider?.trim();
  if (provider) {
    const preferredModel = availableModels.find((availableModel) => availableModel.provider === provider && availableModel.id === baseModel);
    if (preferredModel) return preferredModel;
  }

  return availableModels.find((availableModel) => availableModel.id === baseModel);
}

export function getSupportedArcThinkingLevels(model: ArcModelInfo | undefined): ArcThinkingLevel[] {
  if (!model) return [...ARC_THINKING_LEVELS];
  if (model.reasoning === false) return ["off"];
  if (!model.thinkingLevelMap) return [...ARC_THINKING_LEVELS];
  return ARC_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

export function applyArcThinkingSuffix(model: string | undefined, thinking: ArcThinkingLevel | undefined): string | undefined {
  if (!model || !thinking || thinking === "off") return model;
  const { thinkingSuffix } = splitKnownThinkingSuffix(model);
  if (thinkingSuffix) return model;
  return `${model}:${thinking}`;
}

export function resolveArcModelProfile(input: ResolveArcModelProfileInput): ArcModelProfileResolution {
  const { profileKey, explicitModel, config, availableModels, tierModel, fallbackModel, preferredProvider } = input;
  if (explicitModel?.trim()) {
    return { profileKey, source: "explicit", model: explicitModel.trim(), shouldPrompt: false };
  }

  const profile = config.modelProfiles[profileKey];
  if (profile?.model?.trim()) {
    const configured = profile.model.trim();
    const modelInfo = findArcModelInfo(configured, availableModels, preferredProvider);
    if (!modelInfo) {
      const fallback = tierModel ?? fallbackModel;
      return {
        profileKey,
        source: "profile",
        model: fallback,
        unavailableModel: configured,
        shouldPrompt: true,
        warning: `Configured ${profileKey} model is unavailable: ${configured}`,
      };
    }
    const levels = getSupportedArcThinkingLevels(modelInfo);
    const requestedThinking = profile.thinking ?? "off";
    const thinking = levels.includes(requestedThinking) ? requestedThinking : "off";
    return {
      profileKey,
      source: "profile",
      model: modelInfo.fullId,
      thinking,
      shouldPrompt: !levels.includes(requestedThinking),
      warning: levels.includes(requestedThinking) ? undefined : `Configured ${profileKey} thinking level is unsupported: ${requestedThinking}`,
    };
  }

  if (tierModel) return { profileKey, source: "tier", model: tierModel, shouldPrompt: false };
  if (fallbackModel) return { profileKey, source: "fallback", model: fallbackModel, shouldPrompt: false };
  return { profileKey, source: "unconfigured", shouldPrompt: false };
}
