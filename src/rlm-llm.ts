import { spawnSync } from "node:child_process";
import { GeminiClient, OpenAIClient } from "rlm-bun";
import type { GenerateActionParams, LLMClient, LLMUsage, StreamCallback } from "rlm-bun";
import { AnthropicDirectClient } from "./anthropic-client.ts";
import { CodexClient } from "./codex-client.ts";
import { codexCliEnv } from "./codex-runtime.ts";
import { deepseekApiKeys, type Provider, type ProviderModel, type ProviderStatusEntry } from "./llm.ts";
import { anthropicControls, openAICompatibleControls, type ModelControlContext } from "./model-control.ts";
import { deepseekKeysFromSecrets, secretValue, type ProviderSecrets } from "./provider-secrets.ts";

let deepseekKeyCursor = 0;

function nextDeepSeekApiKey(keys: string[]): string {
  if (!keys.length) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Provide DEEPSEEK_API_KEY, DEEPSEEK_API_KEY_2..., or DEEPSEEK_API_KEYS.",
    );
  }
  const key = keys[deepseekKeyCursor % keys.length];
  deepseekKeyCursor = (deepseekKeyCursor + 1) % Number.MAX_SAFE_INTEGER;
  return key;
}

class DeepSeekLoadBalancedClient implements LLMClient {
  public lastUsage: LLMUsage | null = null;
  public onStream: StreamCallback | null = null;
  public maxTokens: number;

  constructor(
    private readonly opts: {
      keys: string[];
      model: string;
      baseURL: string;
      maxTokens: number;
      requestBody?: Record<string, unknown>;
      captureReasoning?: boolean;
    },
  ) {
    this.maxTokens = opts.maxTokens;
  }

  private clientForCall(): OpenAIClient {
    const client = new OpenAIClient({
      apiKey: nextDeepSeekApiKey(this.opts.keys),
      model: this.opts.model,
      baseURL: this.opts.baseURL,
      maxTokens: this.maxTokens,
      ...(this.opts.requestBody ? { requestBody: this.opts.requestBody } : {}),
      ...(this.opts.captureReasoning !== undefined ? { captureReasoning: this.opts.captureReasoning } : {}),
    });
    client.onStream = this.onStream;
    return client;
  }

  private isRateLimit(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b429\b|rate limit|too many requests/i.test(message);
  }

  private async withClient<T>(fn: (client: OpenAIClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.opts.keys.length; attempt++) {
      const client = this.clientForCall();
      try {
        const result = await fn(client);
        this.lastUsage = client.lastUsage;
        return result;
      } catch (error) {
        this.lastUsage = client.lastUsage;
        lastError = error;
        if (!this.isRateLimit(error) || attempt === this.opts.keys.length - 1) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async generate(prompt: string): Promise<string> {
    return this.withClient((client) => client.generate(prompt));
  }

  async generateAction(params: GenerateActionParams) {
    return this.withClient((client) => client.generateAction(params));
  }
}

export function makeRlmLLM(
  channel: ProviderModel,
  context?: ModelControlContext,
  providerSecrets?: ProviderSecrets,
): LLMClient {
  if (channel.provider === "gemini") {
    const apiKey = secretValue(providerSecrets, "GEMINI_API_KEY");
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey");
    }
    return new GeminiClient({ apiKey, model: channel.model });
  }

  if (channel.provider === "openai") {
    const apiKey = secretValue(providerSecrets, "OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set. Create one at https://platform.openai.com/api-keys");
    }
    return new OpenAIClient({
      apiKey,
      model: channel.model,
      baseURL: "https://api.openai.com/v1",
      maxTokens: 8192,
    });
  }

  if (channel.provider === "cloudflare") {
    const token = secretValue(providerSecrets, "CLOUDFLARE_API_TOKEN");
    const accountId = secretValue(providerSecrets, "CLOUDFLARE_ACCOUNT_ID");
    if (!token) {
      throw new Error(
        "CLOUDFLARE_API_TOKEN is not set. Create one at https://dash.cloudflare.com/profile/api-tokens with the 'Workers AI' permission.",
      );
    }
    if (!accountId) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID is not set. Find it on your Cloudflare dashboard homepage (right sidebar).");
    }
    const controls = openAICompatibleControls(channel, context);
    return new OpenAIClient({
      apiKey: token,
      model: channel.model,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      maxTokens: 8192,
      ...(controls.requestBody ? { requestBody: controls.requestBody } : {}),
      ...(controls.captureReasoning !== undefined ? { captureReasoning: controls.captureReasoning } : {}),
    });
  }

  if (channel.provider === "openrouter") {
    const apiKey = secretValue(providerSecrets, "OPENROUTER_API_KEY");
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/settings/keys");
    }
    const controls = openAICompatibleControls(channel, context);
    return new OpenAIClient({
      apiKey,
      model: channel.model,
      baseURL: "https://openrouter.ai/api/v1",
      maxTokens: 8192,
      ...(controls.requestBody ? { requestBody: controls.requestBody } : {}),
      ...(controls.captureReasoning !== undefined ? { captureReasoning: controls.captureReasoning } : {}),
    });
  }

  if (channel.provider === "deepseek") {
    const controls = openAICompatibleControls(channel, context);
    const requestKeys = deepseekKeysFromSecrets(providerSecrets);
    return new DeepSeekLoadBalancedClient({
      keys: requestKeys.length ? requestKeys : deepseekApiKeys(),
      model: channel.model,
      baseURL: "https://api.deepseek.com",
      maxTokens: 8192,
      requestBody: controls.requestBody,
      captureReasoning: controls.captureReasoning,
    });
  }

  if (channel.provider === "minimax") {
    const apiKey = secretValue(providerSecrets, "MINIMAX_API_KEY");
    if (!apiKey) {
      throw new Error("MINIMAX_API_KEY is not set. Get a key from the MiniMax platform.");
    }
    const controls = openAICompatibleControls(channel, context);
    return new OpenAIClient({
      apiKey,
      model: channel.model,
      baseURL: "https://api.minimax.io/v1",
      maxTokens: 8192,
      ...(controls.requestBody ? { requestBody: controls.requestBody } : {}),
      ...(controls.captureReasoning !== undefined ? { captureReasoning: controls.captureReasoning } : {}),
    });
  }

  if (channel.provider === "anthropic") {
    const apiKey = secretValue(providerSecrets, "ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for RLM mode with Claude. Use Agent mode for Claude subscription auth through JCODE.");
    }
    const controls = anthropicControls(channel, context, 8192);
    return new AnthropicDirectClient({
      apiKey,
      model: channel.model,
      maxTokens: 8192,
      requestBody: controls.requestBody,
    });
  }

  if (channel.provider === "codex") {
    return new CodexClient({ model: channel.model });
  }

  throw new Error(`Unsupported provider for RLM mode: ${(channel as ProviderModel).provider}`);
}

export function rlmProviderStatus(): Record<Provider, ProviderStatusEntry> {
  const geminiMissing: string[] = [];
  if (!process.env.GEMINI_API_KEY) geminiMissing.push("GEMINI_API_KEY");

  const cfMissing: string[] = [];
  if (!process.env.CLOUDFLARE_API_TOKEN) cfMissing.push("CLOUDFLARE_API_TOKEN");
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) cfMissing.push("CLOUDFLARE_ACCOUNT_ID");

  const openaiMissing: string[] = [];
  if (!process.env.OPENAI_API_KEY) openaiMissing.push("OPENAI_API_KEY");

  const openrouterMissing: string[] = [];
  if (!process.env.OPENROUTER_API_KEY) openrouterMissing.push("OPENROUTER_API_KEY");

  const deepseekMissing: string[] = [];
  if (!deepseekApiKeys().length) deepseekMissing.push("DEEPSEEK_API_KEY");

  const minimaxMissing: string[] = [];
  if (!process.env.MINIMAX_API_KEY) minimaxMissing.push("MINIMAX_API_KEY");

  const anthropicMissing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) anthropicMissing.push("ANTHROPIC_API_KEY");

  const codexStatus = spawnSync("codex", ["login", "status"], {
    env: codexCliEnv(),
    stdio: "ignore",
  });
  const codexMissing = codexStatus.status === 0 ? [] : ["codex login"];

  return {
    gemini: { configured: geminiMissing.length === 0, missing: geminiMissing },
    openai: { configured: openaiMissing.length === 0, missing: openaiMissing },
    cloudflare: { configured: cfMissing.length === 0, missing: cfMissing },
    openrouter: { configured: openrouterMissing.length === 0, missing: openrouterMissing },
    deepseek: { configured: deepseekMissing.length === 0, missing: deepseekMissing },
    minimax: { configured: minimaxMissing.length === 0, missing: minimaxMissing },
    anthropic: { configured: anthropicMissing.length === 0, missing: anthropicMissing },
    codex: { configured: codexMissing.length === 0, missing: codexMissing },
  };
}
