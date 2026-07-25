import type { ProviderModel } from "./llm.ts";

export type PromptSurface =
  | "chat"
  | "wiki-structure"
  | "wiki-page"
  | "wiki-slides"
  | "code"
  | "review"
  | "investigate";

export type PromptDepth = "fast" | "deep";

export interface ModelControlContext {
  surface: PromptSurface;
  depth?: PromptDepth;
}

export interface OpenAICompatibleControlOptions {
  requestBody?: Record<string, unknown>;
  captureReasoning?: boolean;
}

export interface AnthropicControlOptions {
  requestBody?: Record<string, unknown>;
}

export interface JCodeControlOptions {
  firstUserMessageSuffix?: string;
}

export interface RLMControlOptions {
  firstUserMessageSuffix?: string;
}

export interface LocalCliControlOptions {
  firstUserMessageSuffix?: string;
}

const OFF_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

const CHARACTER_IMMERSION_REQUIREMENTS = `【Character Immersion Requirements】In your thinking process (within the <think> tags), please adhere to the following rules:
1. Use first-person inner monologue for the character, wrapping inner thoughts in brackets, e.g., "(Thinking: ...)" or "(Inner OS: ...)"
2. Describe feelings from a first-person perspective using phrases like "I think," "I feel," or "I secretly..."
3. The thinking content should be fully immersed in the character, analyzing the plot and planning the response through this monologue.`;

const PURE_ANALYSIS_REQUIREMENTS = `【Thinking Mode Requirements】In your thinking process (within the <think> tags), please adhere to the following rules:
1. Prohibit the use of brackets for inner monologues; all analysis should be stated directly.
2. Prohibit first-person character descriptions of inner activity; use analytical language instead.
3. Thinking content should focus on plot progression and response planning; do not perform character acting within the thinking block.`;

function envEnabled(name: string, defaultValue = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return !OFF_VALUES.has(value);
}

function isDeepSeekChannel(channel: ProviderModel): boolean {
  return channel.provider === "deepseek" || channel.id.startsWith("deepseek-v4-");
}

export function modelControlsEnabled(channel: ProviderModel): boolean {
  return isDeepSeekChannel(channel) && envEnabled("RLM_WIKI_DEEPSEEK_CONTROLS", true);
}

function reasoningCaptureEnabled(channel: ProviderModel): boolean {
  if (isDeepSeekChannel(channel)) return modelControlsEnabled(channel);
  if (channel.provider === "openrouter") return envEnabled("RLM_WIKI_OPENROUTER_REASONING", true);
  if (channel.provider === "cloudflare" || channel.provider === "minimax") {
    return envEnabled("RLM_WIKI_OPENAI_COMPAT_REASONING_CAPTURE", true);
  }
  return false;
}

function roleplayEnabled(channel: ProviderModel): boolean {
  return modelControlsEnabled(channel) && envEnabled("RLM_WIKI_DEEPSEEK_ROLEPLAY", true);
}

function envInteger(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function reasoningEffortFor(channel: ProviderModel, context?: ModelControlContext): "high" | "max" {
  if (context?.depth === "fast") {
    const fastOverride = process.env.RLM_WIKI_DEEPSEEK_FAST_EFFORT?.trim().toLowerCase();
    if (fastOverride === "high" || fastOverride === "max") return fastOverride;
    return "high";
  }
  const override = process.env.RLM_WIKI_DEEPSEEK_EFFORT?.trim().toLowerCase();
  if (override === "high" || override === "max") return override;
  return channel.id === "deepseek-v4-pro" ? "max" : "high";
}

function openRouterReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" {
  const override = process.env.RLM_WIKI_OPENROUTER_EFFORT?.trim().toLowerCase();
  if (
    override === "minimal" ||
    override === "low" ||
    override === "medium" ||
    override === "high" ||
    override === "xhigh"
  ) {
    return override;
  }
  return "high";
}

function anthropicThinkingBudget(context: ModelControlContext | undefined, maxTokens: number): number {
  const depthSpecific =
    context?.depth === "fast"
      ? envInteger("RLM_WIKI_ANTHROPIC_FAST_THINKING_BUDGET")
      : envInteger("RLM_WIKI_ANTHROPIC_DEEP_THINKING_BUDGET");
  const requested =
    depthSpecific ??
    envInteger("RLM_WIKI_ANTHROPIC_THINKING_BUDGET") ??
    (context?.depth === "fast" ? 1024 : 2048);

  const minBudget = 1024;
  const maxBudget = Math.max(minBudget, maxTokens - minBudget);
  return Math.min(Math.max(requested, minBudget), maxBudget);
}

function surfaceRole(surface: PromptSurface): string {
  switch (surface) {
    case "chat":
      return "Adopt the private reasoning role of a patient senior repository guide pairing with the user: curious, grounded, and focused on answering from code evidence.";
    case "wiki-structure":
      return "Adopt the private reasoning role of a principal technical architect designing an internal developer wiki: think in reader journeys, subsystem boundaries, and maintainable page decomposition.";
    case "wiki-page":
      return "Adopt the private reasoning role of a staff technical writer documenting code for future contributors: think in examples, diagrams, citations, and what a new maintainer needs next.";
    case "wiki-slides":
      return "Adopt the private reasoning role of a source-grounded editorial presentation designer converting a generated developer wiki into a premium internal engineering brief: preserve grounding privately, design a clear visual system, reduce wording, and make the story useful for engineering readers.";
    case "code":
      return "Adopt the private reasoning role of an autonomous coding agent pairing with the user: inspect first, make minimal working edits, verify them, and leave a clear diff.";
    case "review":
      return "Use private reasoning as an evidence-first code reviewer: classify only verified defects, separate certainty from risk, and avoid speculative findings.";
    case "investigate":
      return "Use private reasoning as an evidence-first review investigator: verify impact paths before classifying issues and keep machine-readable output requirements in view.";
  }
}

function thinkingModeFor(surface: PromptSurface): "immersive" | "analysis" {
  return surface === "chat" || surface === "review" || surface === "investigate" || surface === "code" ? "analysis" : "immersive";
}

export function openAICompatibleControls(
  channel: ProviderModel,
  context?: ModelControlContext,
): OpenAICompatibleControlOptions {
  if (!reasoningCaptureEnabled(channel)) return {};

  if (channel.provider === "openrouter") {
    return {
      requestBody: {
        reasoning: {
          effort: openRouterReasoningEffort(),
          exclude: false,
        },
      },
      captureReasoning: true,
    };
  }

  if (!modelControlsEnabled(channel)) {
    return { captureReasoning: true };
  }

  const surface = context?.surface.toUpperCase().replace(/-/g, "_");
  const surfaceThinkingOverride = surface
    ? process.env[`RLM_WIKI_DEEPSEEK_${surface}_THINKING`]?.trim().toLowerCase()
    : undefined;
  const thinkingOverride =
    surfaceThinkingOverride ??
    process.env.RLM_WIKI_DEEPSEEK_THINKING?.trim().toLowerCase() ??
    (context?.surface === "chat" ? "disabled" : undefined);
  const thinkingType = OFF_VALUES.has(thinkingOverride ?? "") ? "disabled" : "enabled";
  const requestBody: Record<string, unknown> = {
    thinking: { type: thinkingType },
  };
  if (thinkingType === "enabled") {
    requestBody.reasoning_effort = reasoningEffortFor(channel, context);
  }

  return {
    requestBody,
    captureReasoning: thinkingType === "enabled",
  };
}

export function anthropicControls(
  channel: ProviderModel,
  context?: ModelControlContext,
  maxTokens = 8192,
): AnthropicControlOptions {
  if (channel.provider !== "anthropic") return {};
  if (!envEnabled("RLM_WIKI_ANTHROPIC_THINKING", true)) return {};

  return {
    requestBody: {
      thinking: {
        type: "enabled",
        budget_tokens: anthropicThinkingBudget(context, maxTokens),
        display: "summarized",
      },
    },
  };
}

export function jcodeControlsForSurface(
  channel: ProviderModel,
  context: ModelControlContext,
): JCodeControlOptions {
  if (!roleplayEnabled(channel)) return {};

  const mode = context.depth === "fast" ? "analysis" : thinkingModeFor(context.surface);
  const requirements =
    mode === "analysis" ? PURE_ANALYSIS_REQUIREMENTS : CHARACTER_IMMERSION_REQUIREMENTS;

  return {
    firstUserMessageSuffix: [
      "# DeepSeek Thinking-Mode Control",
      "These instructions apply only to the model's private thinking/reasoning stream. The visible response must still obey the JCODE contract: use native tools directly and place final answers in <ANSWER> tags when required.",
      surfaceRole(context.surface),
      "",
      requirements,
    ].join("\n"),
  };
}

export function rlmControlsForSurface(
  channel: ProviderModel,
  context: ModelControlContext,
): RLMControlOptions {
  if (!roleplayEnabled(channel)) return {};

  const mode = context.depth === "fast" ? "analysis" : thinkingModeFor(context.surface);
  const requirements =
    mode === "analysis" ? PURE_ANALYSIS_REQUIREMENTS : CHARACTER_IMMERSION_REQUIREMENTS;

  return {
    firstUserMessageSuffix: [
      "# DeepSeek Thinking-Mode Control",
      "These instructions apply only to the model's private thinking/reasoning stream. The visible response must still obey the rlm-bun contract: exactly one executable JavaScript block per step, and final answers in <ANSWER> tags when required.",
      surfaceRole(context.surface),
      "",
      requirements,
    ].join("\n"),
  };
}

export function localCliControlsForSurface(
  channel: ProviderModel,
  context: ModelControlContext,
): LocalCliControlOptions {
  if (!roleplayEnabled(channel)) return {};

  const mode = context.depth === "fast" ? "analysis" : thinkingModeFor(context.surface);
  const requirements =
    mode === "analysis" ? PURE_ANALYSIS_REQUIREMENTS : CHARACTER_IMMERSION_REQUIREMENTS;

  return {
    firstUserMessageSuffix: [
      "# DeepSeek Thinking-Mode Control",
      "These instructions apply only to the model's private thinking/reasoning stream. The visible response must still obey the local CLI contract: use native tools directly and return the final answer in the requested format.",
      surfaceRole(context.surface),
      "",
      requirements,
    ].join("\n"),
  };
}
