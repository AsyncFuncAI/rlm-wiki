import { z } from "zod";
import { parseReasoningAndCode, type ParsedOutput } from "../utils/code-parse.ts";
import {
  LLMClientOptionsSchema,
  type LLMUsage,
  type GenerateActionParams,
  type ChatMessage,
} from "./types.ts";
import { BaseLLMClient } from "./base.ts";

/** Gemini-specific options schema (no baseURL needed) */
const GeminiOptionsSchema = LLMClientOptionsSchema.omit({ baseURL: true });
type GeminiOptions = z.infer<typeof GeminiOptionsSchema>;

/** Gemini content part */
interface GeminiPart {
  text?: string;
  thought?: boolean;
}

/** Gemini content block */
interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

/** Gemini candidate */
interface GeminiCandidate {
  content?: { parts: GeminiPart[] };
}

/**
 * Google Gemini LLM adapter.
 * Uses the Generative Language REST API (v1beta).
 */
export class GeminiClient extends BaseLLMClient {
  public apiKey: string;
  public model: string;
  public maxTokens: number;

  constructor(opts: GeminiOptions = {}) {
    super();
    const validated = GeminiOptionsSchema.parse(opts);
    this.apiKey = validated.apiKey || process.env.GEMINI_API_KEY || "";
    this.model = validated.model || "gemini-3.1-pro-preview";
    this.maxTokens = validated.maxTokens || 16384;

    if (!this.apiKey) {
      throw new Error(
        "GeminiClient: No API key. Set GEMINI_API_KEY env or pass apiKey option."
      );
    }
  }

  /** Extract standardized usage from Gemini usageMetadata */
  private _extractUsage(data: Record<string, unknown>): LLMUsage {
    const u = (data.usageMetadata || {}) as Record<string, number>;
    this.lastUsage = {
      promptTokens: u.promptTokenCount || 0,
      completionTokens: u.candidatesTokenCount || 0,
      totalTokens: u.totalTokenCount || 0,
    };
    return this.lastUsage;
  }

  /** Base URL for the model endpoint */
  private _url(method: string): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:${method}?key=${this.apiKey}`;
  }

  /**
   * Map OpenAI-style messages [{role, content}] → Gemini contents format.
   * Gemini uses "user" and "model" roles.
   */
  private _toContents(messages: ChatMessage[]): GeminiContent[] {
    return messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  }

  /**
   * Extract text and thought parts from Gemini response candidates.
   */
  private _extractParts(candidate: GeminiCandidate): { thought: string; text: string } {
    const parts = candidate.content?.parts || [];
    const thoughtParts: string[] = [];
    const textParts: string[] = [];

    for (const part of parts) {
      if (part.thought) {
        thoughtParts.push(part.text || "");
      } else if (part.text !== undefined) {
        textParts.push(part.text);
      }
    }

    return {
      thought: thoughtParts.join("\n"),
      text: textParts.join("\n"),
    };
  }

  private _thinkingConfig(): Record<string, unknown> {
    const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
    if (/^gemini-3/i.test(this.model)) {
      thinkingConfig.thinkingLevel = "high";
    } else {
      thinkingConfig.thinkingBudget = 1024;
    }
    return thinkingConfig;
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch(this._url("generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: this.maxTokens },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    this._extractUsage(data);
    const candidates = data.candidates as GeminiCandidate[];
    const { text } = this._extractParts(candidates[0]);
    return text;
  }

  /** Non-streaming generateAction */
  protected async _generateActionBlocking({ system, messages }: GenerateActionParams): Promise<ParsedOutput> {
    const res = await fetch(this._url("generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: this._toContents(messages),
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          thinkingConfig: this._thinkingConfig(),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${body}`);
    }

    const data = await res.json() as Record<string, unknown>;
    this._extractUsage(data);

    const candidates = data.candidates as GeminiCandidate[];
    const { thought, text } = this._extractParts(candidates[0]);
    const parsed = parseReasoningAndCode(text);

    if (thought && !parsed.reasoning) {
      parsed.reasoning = thought;
    } else if (thought && parsed.reasoning) {
      parsed.reasoning = thought + "\n\n" + parsed.reasoning;
    }

    return parsed;
  }

  /**
   * Streaming generateAction — uses Gemini's streamGenerateContent SSE endpoint.
   * Emits text deltas via this.onStream callback in real-time.
   */
  protected async _generateActionStreaming({ system, messages }: GenerateActionParams): Promise<ParsedOutput> {
    const url = this._url("streamGenerateContent") + "&alt=sse";
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: this._toContents(messages),
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          thinkingConfig: this._thinkingConfig(),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${body}`);
    }

    let fullThought = "";
    let fullText = "";
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

          try {
            const event = JSON.parse(data) as Record<string, unknown>;

            // Extract usage if present
            if (event.usageMetadata) {
              this._extractUsage(event);
            }

            const candidates = event.candidates as Array<{ content?: { parts: GeminiPart[] } }> | undefined;
            const candidate = candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
              if (part.thought && part.text) {
                fullThought += part.text;
                try { onStream({ type: "reasoning", delta: part.text }); } catch { }
              } else if (part.text !== undefined) {
                fullText += part.text;
                try { onStream({ type: "text", delta: part.text }); } catch { }
              }
            }
          } catch { }
        }
      }
    } catch (err) {
      streamError = err as Error;
    } finally {
      buffer += decoder.decode();
      reader.releaseLock();
      try { onStream({ type: "done", error: streamError || null, text: fullText, reasoning: fullThought || null, usage: this.lastUsage }); } catch { }
    }
    if (streamError) throw streamError;

    if (!this.lastUsage) {
      this.lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }

    const parsed = parseReasoningAndCode(fullText);

    if (fullThought && !parsed.reasoning) {
      parsed.reasoning = fullThought;
    } else if (fullThought && parsed.reasoning) {
      parsed.reasoning = fullThought + "\n\n" + parsed.reasoning;
    }

    return parsed;
  }

  /**
   * Web search using Gemini's googleSearch grounding tool.
   * Returns search results with source links.
   */
  public async run_websearch(query: string): Promise<string> {
    const res = await fetch(this._url("generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: this.maxTokens },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    this._extractUsage(data);

    const candidates = data.candidates as Array<{
      content?: { parts: GeminiPart[] };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      };
    }>;
    const candidate = candidates[0];

    // Collect non-thought text parts
    const parts = candidate.content?.parts || [];
    const textParts: string[] = [];
    for (const part of parts) {
      if (!part.thought && part.text !== undefined) {
        textParts.push(part.text);
      }
    }

    let result = textParts.join("\n");

    // Append grounding source links
    const chunks = candidate.groundingMetadata?.groundingChunks || [];
    if (chunks.length > 0) {
      result += "\n\n";
      for (const chunk of chunks) {
        if (chunk.web) {
          result += `[Source: ${chunk.web.title || "Unknown"}](${chunk.web.uri || ""})\n`;
        }
      }
    }

    return result;
  }
}
