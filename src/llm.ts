import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GenerateActionParams, LLMClient, LLMUsage, StreamCallback } from "./llm-core.ts";
import { parseReasoningAndCode } from "./llm-core.ts";
import { extractJCodeStderrError, formatJCodeFailure, jcodeBinary } from "./jcode-errors.ts";
import { ensureJCodeModelCacheForRun } from "./jcode-model-cache.ts";
import { providerSetupInfo, type ProviderSetupInfo } from "./provider-setup.ts";
import { ensureLocalAnthropicProxyBase } from "./anthropic-openai-proxy.ts";
import { GEMINI_OPENAI_COMPAT_API_BASE, ensureLocalGeminiProxyBase } from "./gemini-openai-proxy.ts";
import type { ModelControlContext } from "./model-control.ts";
import {
  PROVIDER_SECRET_KEYS,
  providerSecretsForProviderEnv,
  requestSecretValue,
  secretValue,
  type ProviderSecrets,
} from "./provider-secrets.ts";

export type Provider = "gemini" | "openai" | "cloudflare" | "openrouter" | "deepseek" | "minimax" | "anthropic" | "codex";

export interface ProviderModel {
  /** Stable id used by CLI flags, JSON payloads, and URLs. */
  id: string;
  /** Short human label shown in the UI. */
  label: string;
  /** Sub-label (e.g. context window). */
  sub: string;
  /** Model picker group label. */
  group: string;
  /** Underlying provider. */
  provider: Provider;
  /** Model string to pass to the provider. */
  model: string;
}

export interface ProviderStatusEntry {
  configured: boolean;
  missing: string[];
  setup?: ProviderSetupInfo;
}

/**
 * The set of model "channels" exposed to the UI.
 * Add new ones here — factory + UI dropdown both iterate this list.
 *
 * Last refreshed: 2026-07-25 against OpenAI, Anthropic, Google, DeepSeek,
 * xAI, and OpenRouter public model docs / rankings.
 */
export const MODEL_CHANNELS: readonly ProviderModel[] = [
  {
    id: "gpt-5.6-sol",
    label: "gpt-5.6-sol",
    sub: "OpenAI API · flagship · complex reasoning · 1M ctx",
    group: "OpenAI",
    provider: "openai",
    model: "gpt-5.6-sol",
  },
  {
    id: "gpt-5.6-terra",
    label: "gpt-5.6-terra",
    sub: "OpenAI API · balanced intelligence and cost · 1M ctx",
    group: "OpenAI",
    provider: "openai",
    model: "gpt-5.6-terra",
  },
  {
    id: "gpt-5.6-luna",
    label: "gpt-5.6-luna",
    sub: "OpenAI API · cost-sensitive · high volume · 1M ctx",
    group: "OpenAI",
    provider: "openai",
    model: "gpt-5.6-luna",
  },
  {
    id: "gpt-5.5",
    label: "gpt-5.5",
    sub: "OpenAI API · previous flagship · 1M ctx",
    group: "OpenAI",
    provider: "openai",
    model: "gpt-5.5",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "gemini-3.1-pro-preview",
    sub: "Google AI Studio · preview · strongest Gemini · 1M ctx",
    group: "Gemini",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
  },
  {
    id: "gemini-3.6-flash",
    label: "gemini-3.6-flash",
    sub: "Google AI Studio · stable · latest Flash · agentic",
    group: "Gemini",
    provider: "gemini",
    model: "gemini-3.6-flash",
  },
  {
    id: "gemini-3.5-flash",
    label: "gemini-3.5-flash",
    sub: "Google AI Studio · stable · frontier Flash · coding",
    group: "Gemini",
    provider: "gemini",
    model: "gemini-3.5-flash",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "gemini-3.5-flash-lite",
    sub: "Google AI Studio · stable · fastest · high throughput",
    group: "Gemini",
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
  },
  {
    id: "claude-fable-5",
    label: "claude-fable-5",
    sub: "Anthropic API · strongest widely released · 1M ctx",
    group: "Anthropic (Claude)",
    provider: "anthropic",
    model: "claude-fable-5",
  },
  {
    id: "claude-opus-5",
    label: "claude-opus-5",
    sub: "Anthropic API · complex agentic coding · 1M ctx",
    group: "Anthropic (Claude)",
    provider: "anthropic",
    model: "claude-opus-5",
  },
  {
    id: "claude-sonnet-5",
    label: "claude-sonnet-5",
    sub: "Anthropic API · speed + intelligence · 1M ctx",
    group: "Anthropic (Claude)",
    provider: "anthropic",
    model: "claude-sonnet-5",
  },
  {
    id: "claude-haiku-4-5",
    label: "claude-haiku-4-5",
    sub: "Anthropic API · fastest · near-frontier",
    group: "Anthropic (Claude)",
    provider: "anthropic",
    model: "claude-haiku-4-5",
  },
  {
    id: "deepseek-v4-pro",
    label: "deepseek-v4-pro",
    sub: "DeepSeek API · reasoning · 1M ctx",
    group: "Deepseek V4",
    provider: "deepseek",
    model: "deepseek-v4-pro",
  },
  {
    id: "deepseek-v4-flash",
    label: "deepseek-v4-flash",
    sub: "DeepSeek API · fast · 1M ctx",
    group: "Deepseek V4",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  },
  {
    id: "openrouter-xiaomi-mimo-v2.5",
    label: "xiaomi/mimo-v2.5",
    sub: "OpenRouter · high volume · Xiaomi",
    group: "OpenRouter",
    provider: "openrouter",
    model: "xiaomi/mimo-v2.5",
  },
  {
    id: "openrouter-tencent-hy3-free",
    label: "tencent/hy3:free",
    sub: "OpenRouter · free tier · Tencent",
    group: "OpenRouter",
    provider: "openrouter",
    model: "tencent/hy3:free",
  },
  {
    id: "openrouter-deepseek-v4-flash",
    label: "deepseek/deepseek-v4-flash",
    sub: "OpenRouter · DeepSeek V4 Flash · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
  },
  {
    id: "openrouter-deepseek-v4-pro",
    label: "deepseek/deepseek-v4-pro",
    sub: "OpenRouter · DeepSeek V4 Pro · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
  },
  {
    id: "openrouter-z-ai-glm-5.2",
    label: "z-ai/glm-5.2",
    sub: "OpenRouter · GLM 5.2 · open agentic coding",
    group: "OpenRouter",
    provider: "openrouter",
    model: "z-ai/glm-5.2",
  },
  {
    id: "openrouter-minimax-m3",
    label: "minimax/minimax-m3",
    sub: "OpenRouter · MiniMax M3 · multimodal · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "minimax/minimax-m3",
  },
  {
    id: "openrouter-gpt-5.6-sol",
    label: "openai/gpt-5.6-sol",
    sub: "OpenRouter · OpenAI flagship · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "openai/gpt-5.6-sol",
  },
  {
    id: "openrouter-claude-sonnet-5",
    label: "anthropic/claude-sonnet-5",
    sub: "OpenRouter · Anthropic Sonnet 5 · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
  },
  {
    id: "openrouter-claude-opus-5",
    label: "anthropic/claude-opus-5",
    sub: "OpenRouter · Anthropic Opus 5 · 1M ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "anthropic/claude-opus-5",
  },
  {
    id: "openrouter-gemini-3.6-flash",
    label: "google/gemini-3.6-flash",
    sub: "OpenRouter · Google Gemini 3.6 Flash",
    group: "OpenRouter",
    provider: "openrouter",
    model: "google/gemini-3.6-flash",
  },
  {
    id: "openrouter-grok-4.5",
    label: "x-ai/grok-4.5",
    sub: "OpenRouter · xAI flagship · coding · 500K ctx",
    group: "OpenRouter",
    provider: "openrouter",
    model: "x-ai/grok-4.5",
  },
] as const;

export const DEFAULT_CHANNEL_ID: string = MODEL_CHANNELS[0].id;

/** Map retired channel ids onto the closest current catalog entry. */
const LEGACY_CHANNEL_ALIASES: Record<string, string> = {
  "gpt-5.4-mini": "gpt-5.6-luna",
  "gpt-5.4-nano": "gpt-5.6-luna",
  "gpt-5.4": "gpt-5.6-terra",
  "gemini-3-flash-preview": "gemini-3.6-flash",
  "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "claude-opus-4-7": "claude-opus-5",
  "claude-opus-4-8": "claude-opus-5",
  "claude-sonnet-4-6": "claude-sonnet-5",
  "openrouter-gpt-5.5": "openrouter-gpt-5.6-sol",
  "openrouter-claude-sonnet-4.6": "openrouter-claude-sonnet-5",
  "openrouter-claude-opus-4.7": "openrouter-claude-opus-5",
  "openrouter-gemini-3-flash-preview": "openrouter-gemini-3.6-flash",
  "openrouter-grok-4.1-fast": "openrouter-grok-4.5",
  "openrouter-deepseek-v3.2": "openrouter-deepseek-v4-flash",
  "openrouter-tencent-hy3-preview-free": "openrouter-tencent-hy3-free",
  "openrouter-kimi-k2.6": "openrouter-xiaomi-mimo-v2.5",
  "openrouter-step-3.5-flash": "openrouter-z-ai-glm-5.2",
};

export function resolveChannel(id: string | undefined | null): ProviderModel {
  if (!id) return MODEL_CHANNELS[0];
  const resolvedId = LEGACY_CHANNEL_ALIASES[id] || id;
  const match = MODEL_CHANNELS.find((c) => c.id === resolvedId);
  if (!match && id.startsWith("codex:")) {
    const model = id.slice("codex:".length).trim();
    if (!model) throw new Error("Codex channel override must be formatted as codex:<model>.");
    return {
      id,
      label: model,
      sub: "OpenAI · Codex subscription · local CLI",
      group: "Codex",
      provider: "codex",
      model,
    };
  }
  if (!match) {
    const known = MODEL_CHANNELS.map((c) => c.id).join(", ");
    throw new Error(`Unknown model channel "${id}". Known: ${known}. You can also pass codex:<model>.`);
  }
  return match;
}

export function channelSupportsVision(channel: ProviderModel): boolean {
  return channel.provider === "gemini" || channel.provider === "anthropic" || channel.provider === "openai";
}

function splitEnvKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n\r]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

export function deepseekApiKeys(): string[] {
  const keys: string[] = [];
  keys.push(...splitEnvKeys(process.env.DEEPSEEK_API_KEY));
  keys.push(...splitEnvKeys(process.env.DEEPSEEK_API_KEYS));

  const numbered = Object.entries(process.env)
    .map(([name, value]) => {
      const match = name.match(/^DEEPSEEK_API_KEY_(\d+)$/);
      return match ? { index: Number.parseInt(match[1], 10), value } : null;
    })
    .filter((entry): entry is { index: number; value: string | undefined } => Boolean(entry))
    .sort((a, b) => a.index - b.index);
  for (const entry of numbered) keys.push(...splitEnvKeys(entry.value));

  return Array.from(new Set(keys));
}

export function deepseekApiKeyCount(): number {
  return deepseekApiKeys().length;
}

class JCodeChannelClient implements LLMClient {
  public lastUsage: LLMUsage | null = null;
  public onStream: StreamCallback | null = null;
  public providerArg: string;
  public model: string;
  public channelId: string;
  public label: string;
  public env: Record<string, string | undefined>;

  constructor(
    opts: {
      channelId: string;
      label: string;
      providerArg: string;
      model: string;
      env?: Record<string, string | undefined>;
    },
  ) {
    this.channelId = opts.channelId;
    this.label = opts.label;
    this.providerArg = opts.providerArg;
    this.model = opts.model;
    this.env = opts.env ?? {};
  }

  async generate(prompt: string): Promise<string> {
    ensureJCodeModelCacheForRun(this.providerArg, this.model, this.env);
    const proc = Bun.spawn([
      jcodeBinary(),
      "--no-update",
      "--quiet",
      "--provider", this.providerArg,
      "--model", this.model,
      "--disabled-tools", "swarm",
      "run",
      "--json",
      prompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...jcodeBaseEnv(),
        ...this.env,
        JCODE_NON_INTERACTIVE: "1",
        JCODE_QUIET: "1",
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const stderrError = extractJCodeStderrError(stderr);
    const stdoutText = stdout.trim();
    // jcode 0.58 may print non-fatal MCP noise on stderr while still returning
    // a valid JSON body. Only treat stderr as fatal when exit != 0 or stdout is empty.
    if (exitCode !== 0 || (!stdoutText && stderrError)) {
      const failure = formatJCodeFailure({
        exitCode: exitCode !== 0 ? exitCode : 1,
        stderr: stderrError || stderr,
        stdout,
        providerArg: this.providerArg,
        bin: jcodeBinary(),
      });
      throw new Error(failure.message);
    }
    try {
      const parsed = JSON.parse(stdout) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: string };
      if (parsed.error?.trim()) {
        throw new Error(parsed.error.trim());
      }
      const promptTokens = parsed.usage?.input_tokens ?? 0;
      const completionTokens = parsed.usage?.output_tokens ?? 0;
      this.lastUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
      const text = (parsed.text ?? "").trim() || stdoutText;
      if (!text) throw new Error(stderrError || "Local agent returned an empty response.");
      return text;
    } catch (error) {
      // Re-throw intentional failures; only fall through for JSON parse errors.
      if (error instanceof SyntaxError) {
        this.lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        if (!stdoutText) throw new Error(stderrError || "Local agent returned an empty response.");
        return stdoutText;
      }
      throw error;
    }
  }

  async generateAction(params: GenerateActionParams) {
    const text = await this.generate([
      params.system,
      "",
      ...params.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`),
    ].join("\n"));
    const parsed = parseReasoningAndCode(text);
    if (this.onStream) {
      this.onStream({ type: "text", delta: text });
      this.onStream({ type: "done", error: null, text, usage: this.lastUsage });
    }
    return parsed;
  }
}

/**
 * Build a JCODE-backed model client for a given channel.
 *
 * JCODE owns the agent loop and provider runtime. This object carries the
 * selected provider/model/env through the app's existing construction sites.
 */
export function makeLLM(channel: ProviderModel, context?: ModelControlContext, providerSecrets?: ProviderSecrets): LLMClient {
  void context;
  const runtime = jcodeRuntimeForChannel(channel, providerSecrets);
  if (channel.provider === "cloudflare") {
    const token = secretValue(providerSecrets, "CLOUDFLARE_API_TOKEN");
    const accountId = secretValue(providerSecrets, "CLOUDFLARE_ACCOUNT_ID");
    if (!token) {
      throw new Error(
        "CLOUDFLARE_API_TOKEN is not set. Create one at https://dash.cloudflare.com/profile/api-tokens with the 'Workers AI' permission.",
      );
    }
    if (!accountId) {
      throw new Error(
        "CLOUDFLARE_ACCOUNT_ID is not set. Find it on your Cloudflare dashboard homepage (right sidebar).",
      );
    }
  }
  return new JCodeChannelClient({
    channelId: channel.id,
    label: channel.label,
    providerArg: runtime.providerArg,
    model: channel.model,
    env: runtime.env,
  });
}

function jcodeRuntimeForChannel(
  channel: ProviderModel,
  providerSecrets?: ProviderSecrets,
): { providerArg: string; env?: Record<string, string | undefined> } {
  const secretEnv = providerSecretsForProviderEnv(channel.provider, providerSecrets, true);
  if (channel.provider === "deepseek") {
    const multi = process.env.DEEPSEEK_API_KEYS?.trim();
    if (multi && !providerSecrets?.DEEPSEEK_API_KEY) secretEnv.DEEPSEEK_API_KEYS = multi;
    for (const [key, value] of Object.entries(process.env)) {
      if (/^DEEPSEEK_API_KEY_\d+$/.test(key) && value?.trim() && !providerSecrets?.DEEPSEEK_API_KEY) {
        secretEnv[key] = value.trim();
      }
    }
  }
  switch (channel.provider) {
    case "gemini": {
      if (hasGeminiApiKey(providerSecrets)) {
        // Prefer jcode's first-class gemini-api provider (v0.58+). Keep the
        // OpenAI-compatible + local thought-signature proxy path when the
        // proxy is enabled so multi-turn Gemini tool calls keep working.
        const useProxy = process.env.RLM_WIKI_DISABLE_GEMINI_PROXY !== "1";
        if (useProxy) {
          return {
            providerArg: "openai-compatible",
            env: {
              ...secretEnv,
              JCODE_OPENAI_COMPAT_API_BASE: geminiOpenAICompatApiBase(),
              JCODE_OPENAI_COMPAT_API_KEY_NAME: "GEMINI_API_KEY",
              JCODE_OPENAI_COMPAT_DEFAULT_MODEL: channel.model,
              JCODE_OPENAI_COMPAT_ENV_FILE: "gemini.env",
            },
          };
        }
        return {
          providerArg: "gemini-api",
          env: secretEnv,
        };
      }
      // Native `gemini` is Gemini Code Assist OAuth, not AI Studio API keys.
      return { providerArg: "gemini" };
    }
    case "openai":
      return {
        providerArg: "openai-compatible",
        env: {
          ...secretEnv,
          JCODE_OPENAI_COMPAT_API_BASE: "https://api.openai.com/v1",
          JCODE_OPENAI_COMPAT_API_KEY_NAME: "OPENAI_API_KEY",
          JCODE_OPENAI_COMPAT_DEFAULT_MODEL: channel.model,
          JCODE_OPENAI_COMPAT_ENV_FILE: "openai.env",
        },
      };
    case "cloudflare": {
      const accountId = secretValue(providerSecrets, "CLOUDFLARE_ACCOUNT_ID") ?? "";
      return {
        providerArg: "openai-compatible",
        env: {
          ...secretEnv,
          JCODE_OPENAI_COMPAT_API_BASE: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
          JCODE_OPENAI_COMPAT_API_KEY_NAME: "CLOUDFLARE_API_TOKEN",
          JCODE_OPENAI_COMPAT_DEFAULT_MODEL: channel.model,
          JCODE_OPENAI_COMPAT_ENV_FILE: "cloudflare.env",
        },
      };
    }
    case "openrouter":
      return { providerArg: "openrouter", env: secretEnv };
    case "deepseek":
      return { providerArg: "deepseek", env: secretEnv };
    case "minimax":
      return { providerArg: "minimax", env: secretEnv };
    case "anthropic": {
      const anthropicApiKey = requestSecretValue(providerSecrets, "ANTHROPIC_API_KEY");
      if (anthropicApiKey) {
        return {
          providerArg: "openai-compatible",
          env: {
            ...secretEnv,
            OPENAI_COMPAT_API_KEY: anthropicApiKey,
            JCODE_OPENAI_COMPAT_API_BASE: anthropicOpenAICompatApiBase(),
            JCODE_OPENAI_COMPAT_DEFAULT_MODEL: channel.model,
            JCODE_OPENAI_COMPAT_ENV_FILE: "openai-compatible.env",
          },
        };
      }
      return { providerArg: "claude", env: providerSecretsForProviderEnv("anthropic", providerSecrets, false) };
    }
    case "codex":
      return { providerArg: "openai", env: secretEnv };
  }
}

/**
 * Quick status probe for the UI: which providers are configured to run?
 */
export function providerStatus(): Record<Provider, ProviderStatusEntry> {
  const jcodeAuth = jcodeAuthStatusMap();
  const hasJCodeAuth = (provider: string): boolean => jcodeAuth?.get(provider) === "available";
  const setup = (provider: Provider): ProviderSetupInfo | undefined => providerSetupInfo(provider) ?? undefined;

  const geminiMissing: string[] = [];
  let geminiSetup: ProviderSetupInfo | undefined;
  if (hasGeminiApiKey()) {
    // Gemini API keys run through Google's OpenAI-compatible endpoint. No JCODE
    // OAuth approval is needed, even if local Gemini CLI credentials exist.
  } else if (geminiCliAuthNeedsApproval(jcodeAuth)) {
    geminiSetup = setup("gemini");
    geminiMissing.push(geminiSetup?.buttonLabel ?? "Connect Gemini");
  } else if (!hasJCodeAuth("gemini")) {
    geminiSetup = setup("gemini");
    geminiMissing.push(geminiSetup?.buttonLabel ?? "Connect Gemini");
  }

  const cfMissing: string[] = [];
  if (!process.env.CLOUDFLARE_API_TOKEN) cfMissing.push("CLOUDFLARE_API_TOKEN");
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) cfMissing.push("CLOUDFLARE_ACCOUNT_ID");

  const openaiMissing: string[] = [];
  if (!process.env.OPENAI_API_KEY) openaiMissing.push("OPENAI_API_KEY");

  const orMissing: string[] = [];
  let openrouterSetup: ProviderSetupInfo | undefined;
  if (!process.env.OPENROUTER_API_KEY && !hasJCodeAuth("openrouter")) {
    openrouterSetup = setup("openrouter");
    orMissing.push(openrouterSetup?.buttonLabel ?? "Connect OpenRouter or set OPENROUTER_API_KEY");
  }

  const deepseekMissing: string[] = [];
  let deepseekSetup: ProviderSetupInfo | undefined;
  if (!deepseekApiKeys().length && !hasJCodeAuth("deepseek")) {
    deepseekSetup = setup("deepseek");
    deepseekMissing.push(deepseekSetup?.buttonLabel ?? "Connect DeepSeek or set DEEPSEEK_API_KEY");
  }

  const mmMissing: string[] = [];
  let minimaxSetup: ProviderSetupInfo | undefined;
  if (!process.env.MINIMAX_API_KEY && !hasJCodeAuth("minimax")) {
    minimaxSetup = setup("minimax");
    mmMissing.push(minimaxSetup?.buttonLabel ?? "Connect MiniMax or set MINIMAX_API_KEY");
  }

  const anthMissing: string[] = [];
  let anthropicSetup: ProviderSetupInfo | undefined;
  if (process.env.ANTHROPIC_API_KEY) {
    // Direct Anthropic API keys run through the local OpenAI-compatible adapter
    // in Agent mode, avoiding JCODE's Claude subscription auth importer.
  } else if (!jcodeProviderListAvailable("claude")) {
    anthropicSetup = setup("anthropic");
    anthMissing.push(anthropicSetup?.buttonLabel ?? "Connect Claude");
  }

  const codexMissing: string[] = [];
  let codexSetup: ProviderSetupInfo | undefined;
  if (!hasJCodeAuth("openai")) {
    codexSetup = setup("codex");
    codexMissing.push(codexSetup?.buttonLabel ?? "Connect OpenAI");
  }

  return {
    gemini: { configured: geminiMissing.length === 0, missing: geminiMissing, setup: geminiSetup },
    openai: { configured: openaiMissing.length === 0, missing: openaiMissing },
    cloudflare: { configured: cfMissing.length === 0, missing: cfMissing },
    openrouter: { configured: orMissing.length === 0, missing: orMissing, setup: openrouterSetup },
    deepseek: { configured: deepseekMissing.length === 0, missing: deepseekMissing, setup: deepseekSetup },
    minimax: { configured: mmMissing.length === 0, missing: mmMissing, setup: minimaxSetup },
    anthropic: { configured: anthMissing.length === 0, missing: anthMissing, setup: anthropicSetup },
    codex: { configured: codexMissing.length === 0, missing: codexMissing, setup: codexSetup },
  };
}

function jcodeAuthStatusMap(): Map<string, string> | null {
  try {
    const status = Bun.spawnSync([
      jcodeBinary(),
      "auth",
      "status",
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (status.exitCode !== 0) {
      return null;
    } else {
      const text = new TextDecoder().decode(status.stdout);
      const parsed = JSON.parse(text) as { providers?: Array<{ id?: string; status?: string }> };
      return new Map((parsed.providers ?? [])
        .filter((provider) => provider.id && provider.status)
        .map((provider) => [provider.id!, provider.status!]));
    }
  } catch {
    return null;
  }
}

function jcodeProviderListAvailable(providerArg: string): boolean {
  try {
    const status = Bun.spawnSync([
      jcodeBinary(),
      "model",
      "list",
      "--provider",
      providerArg,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        JCODE_NON_INTERACTIVE: "1",
        JCODE_QUIET: "1",
      },
    });
    return status.exitCode === 0;
  } catch {
    return false;
  }
}

function jcodeBaseEnv(): Record<string, string | undefined> {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of PROVIDER_SECRET_KEYS) delete env[key];
  delete env.DEEPSEEK_API_KEYS;
  for (const key of Object.keys(env)) {
    if (/^DEEPSEEK_API_KEY_\d+$/.test(key)) delete env[key];
  }
  return env;
}

function geminiCliAuthNeedsApproval(jcodeAuth: Map<string, string> | null): boolean {
  if (jcodeAuth?.get("gemini") === "available") return false;
  return existsSync(join(homedir(), ".gemini", "oauth_creds.json"));
}

function hasGeminiApiKey(providerSecrets?: ProviderSecrets): boolean {
  return Boolean(secretValue(providerSecrets, "GEMINI_API_KEY"));
}

function hasAnthropicApiKey(providerSecrets?: ProviderSecrets): boolean {
  return Boolean(requestSecretValue(providerSecrets, "ANTHROPIC_API_KEY"));
}

function geminiOpenAICompatApiBase(): string {
  return envValue("RLM_WIKI_GEMINI_OPENAI_COMPAT_API_BASE")
    ?? envValue("GEMINI_OPENAI_COMPAT_API_BASE")
    ?? (process.env.RLM_WIKI_DISABLE_GEMINI_PROXY === "1"
      ? GEMINI_OPENAI_COMPAT_API_BASE
      : ensureLocalGeminiProxyBase());
}

function anthropicOpenAICompatApiBase(): string {
  return envValue("RLM_WIKI_ANTHROPIC_OPENAI_COMPAT_API_BASE")
    ?? envValue("ANTHROPIC_OPENAI_COMPAT_API_BASE")
    ?? ensureLocalAnthropicProxyBase();
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
