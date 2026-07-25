import { z } from "zod";
import type { ParsedOutput } from "../utils/code-parse.ts";

// ── Zod Schemas ─────────────────────────────────────────────────────

/** Zod schema for LLM client constructor options */
export const LLMClientOptionsSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  maxTokens: z.number().positive().optional(),
  baseURL: z.string().url().optional(),
  requestBody: z.record(z.string(), z.unknown()).optional(),
  captureReasoning: z.boolean().optional(),
});
export type LLMClientOptions = z.infer<typeof LLMClientOptionsSchema>;

// ── Types ───────────────────────────────────────────────────────────

/** Standardized token usage across all providers */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Stream event emitted via onStream callback */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; error: Error | null; text: string; reasoning?: string | null; usage: LLMUsage | null };

/** Callback type for streaming */
export type StreamCallback = (event: StreamEvent) => void;

/** Message in a conversation */
export interface ChatMessage {
  role: string;
  content: string;
}

/** Parameters for generateAction */
export interface GenerateActionParams {
  system: string;
  messages: ChatMessage[];
}

/** Common interface that all LLM clients implement */
export interface LLMClient {
  /** Current token usage from the last request */
  lastUsage: LLMUsage | null;

  /** Optional streaming callback */
  onStream: StreamCallback | null;

  /** Simple string → string generation */
  generate(prompt: string): Promise<string>;

  /** Generate a reasoning + code action for the RLM execution loop */
  generateAction(params: GenerateActionParams): Promise<ParsedOutput>;
}
