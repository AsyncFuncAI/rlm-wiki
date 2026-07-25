/**
 * Lightweight Anthropic client for rlm-wiki.
 *
 * rlm-bun already ships an `AnthropicClient`, but it wraps the
 * @anthropic-ai/claude-agent-sdk which runs the `claude` CLI as a
 * subprocess and expects OAuth credentials (i.e. you must have run
 * `claude login`). That's fine for local dev on a dev's laptop but
 * inappropriate for a server deploy where we just want
 * ANTHROPIC_API_KEY → messages.create().
 *
 * This adapter speaks the direct Anthropic API via `@anthropic-ai/sdk`,
 * keyed on ANTHROPIC_API_KEY. Implements the same BaseLLMClient contract
 * as OpenAIClient / GeminiClient so rlm-bun's agent loop can drop it in
 * without caring which provider is underneath.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ThinkingConfigParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { BaseLLMClient } from "../vendor/rlm-bun/src/llm/base.ts";
import type {
  GenerateActionParams,
  LLMUsage,
  StreamCallback,
} from "../vendor/rlm-bun/src/llm/types.ts";
import {
  parseReasoningAndCode,
  type ParsedOutput,
} from "../vendor/rlm-bun/src/utils/code-parse.ts";

interface AnthropicDirectOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  requestBody?: Record<string, unknown> & {
    thinking?: ThinkingConfigParam;
  };
}

export class AnthropicDirectClient extends BaseLLMClient {
  public apiKey: string;
  public model: string;
  public maxTokens: number;
  private client: Anthropic;
  private actionRequestBody: Record<string, unknown>;

  constructor(opts: AnthropicDirectOptions = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || "";
    this.model = opts.model || "claude-haiku-4-5";
    this.maxTokens = opts.maxTokens || 8192;
    this.actionRequestBody = opts.requestBody || {};

    if (!this.apiKey) {
      throw new Error(
        "AnthropicDirectClient: No API key. Set ANTHROPIC_API_KEY env or pass apiKey option.",
      );
    }
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  /**
   * Anthropic messages API wants `system` as a top-level string and the
   * messages array to alternate user/assistant only. We coalesce any
   * non-alternating runs (shouldn't happen in practice but be safe) and
   * drop any role the SDK doesn't accept.
   */
  private _prepare({ system, messages }: GenerateActionParams): {
    system: string;
    messages: MessageParam[];
  } {
    const out: MessageParam[] = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      out.push({ role, content: m.content });
    }
    // Ensure we start with a user message — Anthropic rejects first=assistant.
    if (out.length && out[0].role !== "user") {
      out.unshift({ role: "user", content: "(continuing)" });
    }
    return { system, messages: out };
  }

  private _actionBody(base: Record<string, unknown>): Record<string, unknown> {
    return {
      ...base,
      ...this.actionRequestBody,
    };
  }

  private _extractUsage(u: { input_tokens: number; output_tokens: number }): LLMUsage {
    this.lastUsage = {
      promptTokens: u.input_tokens || 0,
      completionTokens: u.output_tokens || 0,
      totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    };
    return this.lastUsage;
  }

  private _extractContentBlocks(blocks: unknown): { text: string; reasoning: string } {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    if (!Array.isArray(blocks)) return { text: "", reasoning: "" };

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        reasoningParts.push(b.thinking);
      }
    }

    return {
      text: textParts.join(""),
      reasoning: reasoningParts.join("\n"),
    };
  }

  /** Simple string → string generation (used by channel smoke-tests). */
  async generate(prompt: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    this._extractUsage(res.usage);
    return this._extractContentBlocks(res.content).text;
  }

  protected async _generateActionBlocking(
    params: GenerateActionParams,
  ): Promise<ParsedOutput> {
    const { system, messages } = this._prepare(params);
    const res = await this.client.messages.create(this._actionBody({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
    }) as any);
    this._extractUsage(res.usage);
    const { text, reasoning } = this._extractContentBlocks(res.content);
    const parsed = parseReasoningAndCode(text);
    if (reasoning) {
      parsed.reasoning = parsed.reasoning
        ? `${reasoning}\n\n${parsed.reasoning}`
        : reasoning;
    }
    return parsed;
  }

  protected async _generateActionStreaming(
    params: GenerateActionParams,
  ): Promise<ParsedOutput> {
    const { system, messages } = this._prepare(params);
    const onStream = this.onStream as StreamCallback;

    let fullText = "";
    let fullReasoning = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let streamError: Error | null = null;

    try {
      const stream = await this.client.messages.create(this._actionBody({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages,
        stream: true,
      }) as any) as unknown as AsyncIterable<Record<string, unknown>>;

      for await (const event of stream) {
        if (event.type === "message_start") {
          const message = event.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, number> | undefined;
          inputTokens = usage?.input_tokens ?? inputTokens;
        } else if (event.type === "content_block_delta") {
          const deltaObj = event.delta as Record<string, unknown> | undefined;
          if (deltaObj?.type === "text_delta" && typeof deltaObj.text === "string") {
            fullText += deltaObj.text;
            try { onStream({ type: "text", delta: deltaObj.text }); } catch { /* ignore */ }
          } else if (deltaObj?.type === "thinking_delta" && typeof deltaObj.thinking === "string") {
            fullReasoning += deltaObj.thinking;
            try { onStream({ type: "reasoning", delta: deltaObj.thinking }); } catch { /* ignore */ }
          }
        } else if (event.type === "message_delta") {
          const usage = event.usage as Record<string, number> | undefined;
          outputTokens = usage?.output_tokens ?? outputTokens;
        }
      }

      this.lastUsage = {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    } catch (err) {
      streamError = err as Error;
    } finally {
      try {
        onStream({
          type: "done",
          error: streamError,
          text: fullText,
          reasoning: fullReasoning || null,
          usage: this.lastUsage,
        });
      } catch { /* ignore */ }
    }

    if (streamError) throw streamError;
    if (!this.lastUsage) {
      this.lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }

    const parsed = parseReasoningAndCode(fullText);
    if (fullReasoning) {
      parsed.reasoning = parsed.reasoning
        ? `${fullReasoning}\n\n${parsed.reasoning}`
        : fullReasoning;
    }
    return parsed;
  }
}
