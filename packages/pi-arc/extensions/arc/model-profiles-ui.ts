import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
  ARC_MODEL_PROFILE_KEYS,
  type ArcModelInfo,
  type ArcModelProfileKey,
  type ArcModelsConfig,
  type ArcThinkingLevel,
  applyArcThinkingSuffix,
  findArcModelInfo,
  getSupportedArcThinkingLevels,
  toArcModelInfo,
} from "./model-profiles.ts";

export interface ArcModelProfilesEditorOptions {
  config: ArcModelsConfig;
  configPath: string;
  preferredProvider?: string;
}

export interface ArcModelProfilesEditorResult {
  action: "save" | "cancel";
  config?: ArcModelsConfig;
}

interface ProfileRowView {
  key: ArcModelProfileKey;
  label: string;
  model: string;
  thinking: string;
  recommendationModel: string;
  recommendationThinking: ArcThinkingLevel;
  recommendationReason: string;
  status: string;
  recommended: boolean;
}

interface ProfileRecommendation {
  modelId: string;
  thinking: ArcThinkingLevel;
  reason: string;
}

interface ResolvedProfileRecommendation {
  recommendation: ProfileRecommendation;
  model?: ArcModelInfo;
  displayModel: string;
}

type UiMode = "profiles" | "model" | "thinking";
type DraftProfile = NonNullable<ArcModelsConfig["modelProfiles"][ArcModelProfileKey]>;

const PROFILE_LABELS: Record<ArcModelProfileKey, string> = {
  brainstorm: "Brainstorm",
  plan: "Plan",
  issueManager: "Issue Manager",
  builder: "Builder",
  codeReviewer: "Code Reviewer",
  docWriter: "Doc Writer",
  specReviewer: "Spec Reviewer",
  evaluator: "Evaluator",
};

const RECOMMENDED_MODEL_PROVIDER = "openai-codex";

const PROFILE_RECOMMENDATIONS: Record<ArcModelProfileKey, ProfileRecommendation> = {
  brainstorm: { modelId: "gpt-5.5", thinking: "high", reason: "design exploration and architecture judgment" },
  plan: { modelId: "gpt-5.5", thinking: "high", reason: "task breakdown and sequencing" },
  issueManager: { modelId: "gpt-5.4-mini", thinking: "off", reason: "Arc CLI formatting and issue updates" },
  builder: { modelId: "gpt-5.3-codex", thinking: "medium", reason: "implementation and code navigation" },
  codeReviewer: { modelId: "gpt-5.5", thinking: "high", reason: "review judgment and risk detection" },
  docWriter: { modelId: "gpt-5.4-mini", thinking: "low", reason: "documentation prose and light reasoning" },
  specReviewer: { modelId: "gpt-5.5", thinking: "high", reason: "spec compliance and ambiguity detection" },
  evaluator: { modelId: "gpt-5.5", thinking: "high", reason: "adversarial validation" },
};

const THINKING_DESCRIPTIONS: Record<ArcThinkingLevel, string> = {
  off: "No extended thinking",
  minimal: "Brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Maximum reasoning",
};

export async function openArcModelProfilesEditor(
  ctx: ExtensionCommandContext,
  options: ArcModelProfilesEditorOptions,
): Promise<ArcModelProfilesEditorResult> {
  const models = ctx.modelRegistry.getAvailable().map(toArcModelInfo);
  return ctx.ui.custom<ArcModelProfilesEditorResult>(
    (tui, theme, _kb, done) => new ArcModelProfilesComponent(tui, theme, models, options, done),
    { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function row(content: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  const clipped = truncateToWidth(content.replace(/[\r\n]+/g, " "), innerWidth);
  return theme.fg("border", "│") + pad(clipped, innerWidth) + theme.fg("border", "│");
}

function truncateDetail(value: string, width: number): string {
  return truncateToWidth(value.replace(/[\r\n]+/g, " "), width);
}

function renderHeader(title: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  const visibleTitle = stripAnsi(title).length;
  const available = Math.max(0, innerWidth - visibleTitle);
  const left = Math.floor(available / 2);
  const right = available - left;
  return theme.fg("border", `╭${"─".repeat(left)}`) + theme.fg("accent", title) + theme.fg("border", `${"─".repeat(right)}╮`);
}

function renderFooter(text: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  const visibleText = stripAnsi(text).length;
  const available = Math.max(0, innerWidth - visibleText);
  const left = Math.floor(available / 2);
  const right = available - left;
  return theme.fg("border", `╰${"─".repeat(left)}`) + theme.fg("dim", text) + theme.fg("border", `${"─".repeat(right)}╯`);
}

function sortedModels(models: ArcModelInfo[], preferredProvider?: string): ArcModelInfo[] {
  const provider = preferredProvider?.trim();
  if (!provider) return [...models];
  return [...models].sort((a, b) => Number(b.provider === provider) - Number(a.provider === provider));
}

function matchesModelQuery(model: ArcModelInfo, query: string): boolean {
  const normalized = query.toLowerCase();
  return (
    model.fullId.toLowerCase().includes(normalized) ||
    model.id.toLowerCase().includes(normalized) ||
    model.provider.toLowerCase().includes(normalized)
  );
}

function defaultRecommendationModelId(recommendation: ProfileRecommendation): string {
  return `${RECOMMENDED_MODEL_PROVIDER}/${recommendation.modelId}`;
}

function matchesRecommendedModelId(model: ArcModelInfo, modelId: string): boolean {
  return model.id === modelId || model.fullId.endsWith(`/${modelId}`);
}

function findRecommendedModel(
  recommendation: ProfileRecommendation,
  models: ArcModelInfo[],
  preferredProvider?: string,
): ArcModelInfo | undefined {
  const candidates = models.filter((model) => matchesRecommendedModelId(model, recommendation.modelId));
  const defaultProvider = candidates.find((model) => model.provider === RECOMMENDED_MODEL_PROVIDER);
  const provider = preferredProvider?.trim();
  const preferred = provider ? candidates.find((model) => model.provider === provider) : undefined;
  return defaultProvider ?? preferred ?? candidates[0];
}

function recommendedModelForProfile(
  key: ArcModelProfileKey,
  models: ArcModelInfo[],
  preferredProvider?: string,
): ResolvedProfileRecommendation {
  const recommendation = PROFILE_RECOMMENDATIONS[key];
  const model = findRecommendedModel(recommendation, models, preferredProvider);
  return {
    recommendation,
    model,
    displayModel: model?.fullId ?? `${defaultRecommendationModelId(recommendation)} (unavailable)`,
  };
}

function modelMatchesRecommendation(
  model: string | undefined,
  recommendation: ArcModelInfo | undefined,
  models: ArcModelInfo[],
  preferredProvider?: string,
): boolean {
  if (!model || !recommendation) return false;
  const info = findArcModelInfo(model, models, preferredProvider);
  return info?.fullId === recommendation.fullId;
}

function recommendedThinkingForModel(recommendation: ProfileRecommendation, model: ArcModelInfo | undefined): ArcThinkingLevel {
  const levels = getSupportedArcThinkingLevels(model);
  return levels.includes(recommendation.thinking) ? recommendation.thinking : "off";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function setupSummary(config: ArcModelsConfig): string {
  if (config.setup?.completedAt) return `completed ${config.setup.completedAt}`;
  if (config.setup?.dismissedAt) return `dismissed ${config.setup.dismissedAt}`;
  return "not completed";
}

class ArcModelProfilesComponent {
  private mode: UiMode = "profiles";
  private cursor = 0;
  private modelCursor = 0;
  private thinkingCursor = 0;
  private modelSearchQuery = "";
  private filteredModels: ArcModelInfo[];
  private readonly draft: ArcModelsConfig;

  constructor(
    private readonly tui: { requestRender(): void },
    private readonly theme: Theme,
    private readonly models: ArcModelInfo[],
    private readonly options: ArcModelProfilesEditorOptions,
    private readonly done: (result: ArcModelProfilesEditorResult) => void,
  ) {
    this.filteredModels = [...models];
    this.draft = JSON.parse(JSON.stringify(options.config)) as ArcModelsConfig;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+s") || (data === "s" && this.mode !== "model")) {
      this.save();
      return;
    }

    if (this.mode === "profiles") {
      this.handleProfilesInput(data);
      return;
    }

    if (this.mode === "model") {
      this.handleModelInput(data);
      return;
    }

    this.handleThinkingInput(data);
  }

  render(width: number): string[] {
    if (this.mode === "model") return this.renderModelPicker(width);
    if (this.mode === "thinking") return this.renderThinkingPicker(width);
    return this.renderProfiles(width);
  }

  private handleProfilesInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done({ action: "cancel" });
      return;
    }

    if (matchesKey(data, "up")) {
      this.cursor = clamp(this.cursor - 1, 0, ARC_MODEL_PROFILE_KEYS.length - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.cursor = clamp(this.cursor + 1, 0, ARC_MODEL_PROFILE_KEYS.length - 1);
      this.tui.requestRender();
      return;
    }

    if (data === "m" || matchesKey(data, "return")) {
      this.openModelPicker();
      this.tui.requestRender();
      return;
    }

    if (data === "t") {
      this.openThinkingPicker();
      this.tui.requestRender();
      return;
    }

    if (data === "r") {
      this.applyRecommendedDefaults();
      this.tui.requestRender();
      return;
    }

    if (data === "d") {
      this.clearSelectedProfile();
      this.tui.requestRender();
      return;
    }
  }

  private handleModelInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "profiles";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "return")) {
      this.selectModel();
      this.mode = "profiles";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.filteredModels.length > 0) this.modelCursor = this.modelCursor === 0 ? this.filteredModels.length - 1 : this.modelCursor - 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.filteredModels.length > 0) this.modelCursor = this.modelCursor === this.filteredModels.length - 1 ? 0 : this.modelCursor + 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.modelSearchQuery.length > 0) this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
      this.refreshModelFilter();
      this.tui.requestRender();
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.modelSearchQuery += data;
      this.refreshModelFilter();
      this.tui.requestRender();
    }
  }

  private handleThinkingInput(data: string): void {
    const levels = this.supportedThinkingLevelsForSelectedProfile();

    if (matchesKey(data, "escape")) {
      this.mode = "profiles";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "return")) {
      const selected = levels[this.thinkingCursor] ?? "off";
      this.ensureSelectedProfile().thinking = selected;
      this.mode = "profiles";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (levels.length > 0) this.thinkingCursor = this.thinkingCursor === 0 ? levels.length - 1 : this.thinkingCursor - 1;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (levels.length > 0) this.thinkingCursor = this.thinkingCursor === levels.length - 1 ? 0 : this.thinkingCursor + 1;
      this.tui.requestRender();
    }
  }

  private renderProfiles(width: number): string[] {
    const lines: string[] = [];
    lines.push(renderHeader(" Arc Model Profiles ", width, this.theme));
    lines.push(row("", width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Config:")} ${truncateToWidth(this.options.configPath, width - 12)}`, width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Setup:")} ${setupSummary(this.draft)}`, width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Available:")} ${this.models.length} models`, width, this.theme));
    lines.push(row("", width, this.theme));

    const detailWidth = Math.max(0, width - 2);
    const rows = this.profileRows();
    const maxVisibleProfiles = 3;
    let start = 0;
    if (rows.length > maxVisibleProfiles) {
      start = Math.max(0, this.cursor - Math.floor(maxVisibleProfiles / 2));
      start = Math.min(start, rows.length - maxVisibleProfiles);
    }
    const end = Math.min(start + maxVisibleProfiles, rows.length);

    if (start > 0) lines.push(row(` ${this.theme.fg("dim", `↑ ${start} more`)}`, width, this.theme));
    for (let index = start; index < end; index++) {
      const profile = rows[index]!;
      const selected = index === this.cursor;
      const prefix = selected ? this.theme.fg("accent", "▸ ") : "  ";
      const label = selected ? this.theme.fg("accent", profile.label) : this.theme.fg("dim", profile.label);
      const badge = profile.recommended ? ` ${this.theme.fg(selected ? "success" : "dim", "[recommended]")}` : "";
      lines.push(row(` ${prefix}${label}${badge}`, width, this.theme));
      for (const detail of this.profileDetailLines(profile, detailWidth, selected)) lines.push(row(detail, width, this.theme));
      const note = this.effectiveThinkingNote(profile.key);
      if (note) lines.push(row(this.profileDetailLine("note", note, detailWidth, selected), width, this.theme));
    }
    if (rows.length - end > 0) lines.push(row(` ${this.theme.fg("dim", `↓ ${rows.length - end} more`)}`, width, this.theme));

    lines.push(row("", width, this.theme));
    lines.push(renderFooter(" [Enter] Edit · [Esc] Cancel · [m]odel [t]hinking [r]ecommended [d]isable [s]ave ", width, this.theme));
    return lines;
  }

  private profileDetailLines(profile: ProfileRowView, width: number, selected: boolean): string[] {
    return [
      this.profileDetailLine("selected", profile.model, width, selected),
      this.profileDetailLine("thinking", profile.thinking, width, selected),
      this.profileDetailLine("recommended", `${profile.recommendationModel} · thinking ${profile.recommendationThinking}`, width, selected),
      this.profileDetailLine("reason", profile.recommendationReason, width, selected),
      this.profileDetailLine("status", profile.status, width, selected),
    ];
  }

  private profileDetailLine(label: string, value: string, width: number, selected: boolean): string {
    const valueWidth = Math.max(0, width - label.length - 7);
    const content = `    ${label}: ${truncateDetail(value, valueWidth)}`;
    return selected ? content : this.theme.fg("dim", content);
  }

  private renderModelPicker(width: number): string[] {
    const selectedKey = this.selectedKey();
    const profile = this.draft.modelProfiles[selectedKey];
    const recommended = recommendedModelForProfile(selectedKey, this.models, this.options.preferredProvider);
    const lines: string[] = [];
    lines.push(renderHeader(" Select Model ", width, this.theme));
    lines.push(row("", width, this.theme));
    const cursor = "\x1b[7m \x1b[27m";
    lines.push(row(` ${this.theme.fg("dim", "Search:")} ${this.modelSearchQuery}${cursor}`, width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Profile:")} ${PROFILE_LABELS[selectedKey]}`, width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Current:")} ${profile?.model ?? "disabled"}`, width, this.theme));
    if (this.options.preferredProvider) lines.push(row(` ${this.theme.fg("dim", "Provider:")} ${this.options.preferredProvider}`, width, this.theme));
    lines.push(row("", width, this.theme));

    if (this.filteredModels.length === 0) {
      lines.push(row(` ${this.theme.fg("dim", "No matching models")}`, width, this.theme));
    } else {
      const maxVisible = 12;
      let start = 0;
      if (this.filteredModels.length > maxVisible) {
        start = Math.max(0, this.modelCursor - Math.floor(maxVisible / 2));
        start = Math.min(start, this.filteredModels.length - maxVisible);
      }
      const end = Math.min(start + maxVisible, this.filteredModels.length);
      if (start > 0) lines.push(row(` ${this.theme.fg("dim", `↑ ${start} more`)}`, width, this.theme));
      for (let index = start; index < end; index++) {
        const model = this.filteredModels[index]!;
        const selected = index === this.modelCursor;
        const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
        const modelText = selected ? this.theme.fg("accent", model.fullId) : model.fullId;
        const recommendedBadge = recommended.model?.fullId === model.fullId ? ` ${this.theme.fg("success", "[recommended]")}` : "";
        const reasoningBadge = model.reasoning === false ? this.theme.fg("dim", " [no-thinking]") : "";
        lines.push(row(` ${prefix}${modelText}${recommendedBadge}${reasoningBadge}`, width, this.theme));
      }
      const remaining = this.filteredModels.length - end;
      if (remaining > 0) lines.push(row(` ${this.theme.fg("dim", `↓ ${remaining} more`)}`, width, this.theme));
    }

    lines.push(row("", width, this.theme));
    lines.push(renderFooter(" [Enter] Select · [Esc] Back · type to search ", width, this.theme));
    return lines;
  }

  private renderThinkingPicker(width: number): string[] {
    const selectedKey = this.selectedKey();
    const profile = this.draft.modelProfiles[selectedKey];
    const levels = this.supportedThinkingLevelsForSelectedProfile();
    const lines: string[] = [];
    lines.push(renderHeader(" Select Thinking ", width, this.theme));
    lines.push(row("", width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Profile:")} ${PROFILE_LABELS[selectedKey]}`, width, this.theme));
    lines.push(row(` ${this.theme.fg("dim", "Model:")} ${profile?.model ?? "disabled"}`, width, this.theme));
    lines.push(row("", width, this.theme));

    for (let index = 0; index < levels.length; index++) {
      const level = levels[index]!;
      const selected = index === this.thinkingCursor;
      const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
      const levelText = selected ? this.theme.fg("accent", level) : level;
      lines.push(row(` ${prefix}${levelText} ${this.theme.fg("dim", `- ${THINKING_DESCRIPTIONS[level]}`)}`, width, this.theme));
    }

    lines.push(row("", width, this.theme));
    lines.push(renderFooter(" [Enter] Select · [Esc] Back · [↑↓] Navigate ", width, this.theme));
    return lines;
  }

  private profileRows(): ProfileRowView[] {
    return ARC_MODEL_PROFILE_KEYS.map((key) => {
      const profile = this.draft.modelProfiles[key];
      const modelInfo = findArcModelInfo(profile?.model, this.models, this.options.preferredProvider);
      const recommended = recommendedModelForProfile(key, this.models, this.options.preferredProvider);
      const recommendation = recommended.recommendation;
      const recommendedModel = modelMatchesRecommendation(profile?.model, recommended.model, this.models, this.options.preferredProvider);
      const thinking = profile?.thinking ?? "off";
      const recommendedThinking = recommendedThinkingForModel(recommendation, recommended.model);
      const recommendedProfile = recommendedModel && thinking === recommendedThinking;
      const supportedLevels = getSupportedArcThinkingLevels(modelInfo);
      const unsupportedThinking = Boolean(profile?.model && modelInfo && !supportedLevels.includes(thinking));
      let status = "disabled";
      if (profile?.model && !modelInfo) status = "unavailable";
      else if (unsupportedThinking) status = "unsupported thinking";
      else if (recommendedProfile) status = "recommended";
      else if (profile?.model) status = "available";

      return {
        key,
        label: PROFILE_LABELS[key],
        model: profile?.model ?? "disabled",
        thinking,
        recommendationModel: recommended.displayModel,
        recommendationThinking: recommendation.thinking,
        recommendationReason: recommendation.reason,
        status,
        recommended: recommendedProfile,
      };
    });
  }

  private openModelPicker(): void {
    this.mode = "model";
    this.modelSearchQuery = "";
    this.filteredModels = sortedModels(this.models, this.options.preferredProvider);
    const profile = this.draft.modelProfiles[this.selectedKey()];
    const modelInfo = findArcModelInfo(profile?.model, this.models, this.options.preferredProvider);
    const index = this.filteredModels.findIndex((model) => model.fullId === modelInfo?.fullId);
    this.modelCursor = index >= 0 ? index : 0;
  }

  private openThinkingPicker(): void {
    const levels = this.supportedThinkingLevelsForSelectedProfile();
    if (levels.length === 1 && levels[0] === "off") {
      this.ensureSelectedProfile().thinking = "off";
      this.mode = "profiles";
      return;
    }

    this.mode = "thinking";
    const current = this.draft.modelProfiles[this.selectedKey()]?.thinking ?? "off";
    const index = levels.findIndex((level) => level === current);
    this.thinkingCursor = index >= 0 ? index : Math.max(0, levels.indexOf("off"));
  }

  private selectModel(): void {
    const selected = this.filteredModels[this.modelCursor];
    if (!selected) return;

    const profile = this.ensureSelectedProfile();
    profile.model = selected.fullId;
    const levels = getSupportedArcThinkingLevels(findArcModelInfo(profile.model, this.models, this.options.preferredProvider));
    const current = profile.thinking ?? "off";
    if (levels.length === 1 && levels[0] === "off") profile.thinking = "off";
    else if (!levels.includes(current)) profile.thinking = "off";
  }

  private refreshModelFilter(): void {
    const query = this.modelSearchQuery.trim();
    const models = sortedModels(this.models, this.options.preferredProvider);
    this.filteredModels = query ? models.filter((model) => matchesModelQuery(model, query)) : models;
    this.modelCursor = clamp(this.modelCursor, 0, Math.max(0, this.filteredModels.length - 1));
  }

  private supportedThinkingLevelsForSelectedProfile(): ArcThinkingLevel[] {
    const profile = this.draft.modelProfiles[this.selectedKey()];
    return getSupportedArcThinkingLevels(findArcModelInfo(profile?.model, this.models, this.options.preferredProvider));
  }

  private applyRecommendedDefaults(): void {
    for (const key of ARC_MODEL_PROFILE_KEYS) {
      const recommended = recommendedModelForProfile(key, this.models, this.options.preferredProvider);
      if (!recommended.model) continue;

      const recommendation = recommended.recommendation;
      const profile = this.ensureProfile(key);
      profile.model = recommended.model.fullId;
      const levels = getSupportedArcThinkingLevels(recommended.model);
      profile.thinking = levels.includes(recommendation.thinking) ? recommendation.thinking : "off";
    }
  }

  private clearSelectedProfile(): void {
    delete this.draft.modelProfiles[this.selectedKey()];
  }

  private effectiveThinkingNote(key: ArcModelProfileKey): string | undefined {
    const profile = this.draft.modelProfiles[key];
    const effectiveModel = applyArcThinkingSuffix(profile?.model, profile?.thinking);
    if (!effectiveModel || effectiveModel === profile?.model) return undefined;
    return `saves as ${effectiveModel}`;
  }

  private selectedKey(): ArcModelProfileKey {
    return ARC_MODEL_PROFILE_KEYS[this.cursor] ?? ARC_MODEL_PROFILE_KEYS[0];
  }

  private ensureSelectedProfile(): DraftProfile {
    return this.ensureProfile(this.selectedKey());
  }

  private ensureProfile(key: ArcModelProfileKey): DraftProfile {
    const profile = this.draft.modelProfiles[key] ?? {};
    this.draft.modelProfiles[key] = profile;
    return profile;
  }

  private save(): void {
    this.done({ action: "save", config: this.draft });
  }
}
