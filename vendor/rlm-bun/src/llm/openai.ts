import { z } from "zod";
import { parseReasoningAndCode, type ParsedOutput } from "../utils/code-parse.ts";
import {
  LLMClientOptionsSchema,
  type LLMUsage,
  type GenerateActionParams,
} from "./types.ts";
import { BaseLLMClient } from "./base.ts";

/** OpenAI-specific options schema */
const OpenAIOptionsSchema = LLMClientOptionsSchema.extend({
  baseURL: z.string().optional(),
});
type OpenAIOptions = z.infer<typeof OpenAIOptionsSchema>;

type OpenAIReasoningDetail = {
  type?: string;
  text?: string | null;
  summary?: string | string[] | null;
  content?: string | null;
};

/**
 * OpenAI-compatible LLM adapter.
 * Works with OpenAI, Azure OpenAI, and any OpenAI-compatible API (Ollama, Together, etc.)
 */
export class OpenAIClient extends BaseLLMClient {
  public apiKey: string;
  public model: string;
  public maxTokens: number;
  public baseURL: string;
  public requestBody: Record<string, unknown>;
  public captureReasoning: boolean;

  constructor(opts: OpenAIOptions = {}) {
    super();
    const validated = OpenAIOptionsSchema.parse(opts);
    this.apiKey = validated.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = validated.model || "gpt-5.2";
    this.maxTokens = validated.maxTokens || 4096;
    this.baseURL = (validated.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.requestBody = validated.requestBody || {};
    this.captureReasoning = validated.captureReasoning || false;

    if (!this.apiKey) {
      throw new Error(
        "OpenAIClient: No API key. Set OPENAI_API_KEY env or pass apiKey option."
      );
    }
  }

  /** Extract standardized usage from OpenAI response */
  private _extractUsage(data: Record<string, unknown>): LLMUsage {
    const u = (data.usage || {}) as Record<string, number>;
    this.lastUsage = {
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || 0,
    };
    return this.lastUsage;
  }

  /** Newer models (o-series, gpt-5.x) use max_completion_tokens instead of max_tokens */
  private _tokenParam(): string {
    return /^(o\d|gpt-5)/i.test(this.model)
      ? "max_completion_tokens"
      : "max_tokens";
  }

  private _requestBody(base: Record<string, unknown>): Record<string, unknown> {
    return {
      ...base,
      ...this.requestBody,
    };
  }

  private _stringFromMaybe(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private _reasoningDetailsText(details: unknown): string {
    if (!Array.isArray(details)) return "";

    const parts: string[] = [];
    for (const raw of details) {
      if (!raw || typeof raw !== "object") continue;
      const detail = raw as OpenAIReasoningDetail;
      if (typeof detail.text === "string") {
        parts.push(detail.text);
      } else if (typeof detail.summary === "string") {
        parts.push(detail.summary);
      } else if (Array.isArray(detail.summary)) {
        parts.push(detail.summary.filter((item): item is string => typeof item === "string").join("\n"));
      } else if (typeof detail.content === "string") {
        parts.push(detail.content);
      }
    }

    return parts.filter(Boolean).join("\n");
  }

  private _reasoningText(messageOrDelta: Record<string, unknown> | null | undefined): string {
    if (!messageOrDelta) return "";
    const direct = [
      this._stringFromMaybe(messageOrDelta.reasoning_content),
      this._stringFromMaybe(messageOrDelta.reasoning),
    ].filter(Boolean).join("");
    const details = this._reasoningDetailsText(messageOrDelta.reasoning_details);
    if (direct && details) return `${direct}\n${details}`;
    return direct || details;
  }

  private _parseAction(content: string | null | undefined, reasoning: string | null | undefined): ParsedOutput {
    const parsed = parseReasoningAndCode(content || "");
    if (this.captureReasoning && reasoning) {
      parsed.reasoning = parsed.reasoning
        ? `${reasoning}\n\n${parsed.reasoning}`
        : reasoning;
    }
    return parsed;
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this._requestBody({
        model: this.model,
        [this._tokenParam()]: this.maxTokens,
        messages: [{ role: "user", content: prompt }],
      })),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    this._extractUsage(data);
    const choices = data.choices as Array<{ message: { content?: string | null } }>;
    return choices[0].message.content || "";
  }

  /** Non-streaming generateAction */
  protected async _generateActionBlocking({ system, messages }: GenerateActionParams): Promise<ParsedOutput> {
    const allMessages = [
      { role: "system", content: system },
      ...messages,
    ];

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this._requestBody({
        model: this.model,
        [this._tokenParam()]: this.maxTokens,
        messages: allMessages,
      })),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    this._extractUsage(data);
    const choices = data.choices as Array<{ message: Record<string, unknown> & { content?: string | null } }>;
    const message = choices[0].message;
    return this._parseAction(message.content, this._reasoningText(message));
  }



  /**
   * Streaming generateAction — uses OpenAI's SSE stream.
   * Emits text deltas via this.onStream callback in real-time.
   */
  protected async _generateActionStreaming({ system, messages }: GenerateActionParams): Promise<ParsedOutput> {
    const allMessages = [
      { role: "system", content: system },
      ...messages,
    ];

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this._requestBody({
        model: this.model,
        [this._tokenParam()]: this.maxTokens,
        messages: allMessages,
        stream: true,
        stream_options: { include_usage: true },
      })),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${body}`);
    }

    let fullText = "";
    let fullReasoning = "";
    const onStream = this.onStream!;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError: Error | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const line of parts) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            const choices = event.choices as Array<{ delta?: Record<string, unknown> & { content?: string | null } }> | undefined;
            const deltaObj = choices?.[0]?.delta;
            const delta = deltaObj?.content;
            if (delta) {
              fullText += delta;
              try { onStream({ type: "text", delta }); } catch { }
            }
            const reasoningDelta = this._reasoningText(deltaObj);
            if (reasoningDelta) {
              fullReasoning += reasoningDelta;
              try { onStream({ type: "reasoning", delta: reasoningDelta }); } catch { }
            }
            // Capture usage from final chunk
            if (event.usage) {
              const u = event.usage as Record<string, number>;
              this.lastUsage = {
                promptTokens: u.prompt_tokens || 0,
                completionTokens: u.completion_tokens || 0,
                totalTokens: u.total_tokens || 0,
              };
            }
          } catch { }
        }
      }
    } catch (err) {
      streamError = err as Error;
    } finally {
      buffer += decoder.decode();
      reader.releaseLock();
      try { onStream({ type: "done", error: streamError || null, text: fullText, reasoning: fullReasoning || null, usage: this.lastUsage }); } catch { }
    }
    if (streamError) throw streamError;

    if (!this.lastUsage) {
      this.lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }

    // Preserve streamed reasoning in the completed action as well as the live
    // stream so consumers can render or persist full step history.
    return this._parseAction(fullText, fullReasoning || null);
  }

  /** Always use the real OpenAI endpoint for the Responses API */
  private _responsesBaseURL(): string {
    return "https://api.openai.com/v1";
  }

  /** Web search using OpenAI Responses API with web_search_preview tool */
  async run_websearch(query: string): Promise<string> {
    const res = await fetch(`${this._responsesBaseURL()}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        tools: [{ type: "web_search" }],
        input: query,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI Responses API error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      output: Array<{
        type: string;
        content?: Array<{
          type: string;
          text?: string;
          annotations?: Array<{ type: string; url?: string; title?: string }>;
        }>;
      }>;
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    };

    // Extract usage
    if (data.usage) {
      this.lastUsage = {
        promptTokens: data.usage.input_tokens || 0,
        completionTokens: data.usage.output_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
      };
    }

    const textParts: string[] = [];
    const sources: string[] = [];

    for (const item of data.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) {
            textParts.push(c.text);
          }
          // Extract source URLs from url_citation annotations
          if (c.annotations) {
            for (const ann of c.annotations) {
              if (ann.type === "url_citation" && (ann.url || ann.title)) {
                sources.push(`[Source: ${ann.title || ""}](${ann.url || ""})`);
              }
            }
          }
        }
      }
    }

    return [...textParts, ...sources].join("\n");
  }
}
