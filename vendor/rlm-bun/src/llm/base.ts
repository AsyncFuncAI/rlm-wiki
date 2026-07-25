import { type ParsedOutput } from "../utils/code-parse.ts";
import type {
  LLMClient,
  LLMUsage,
  StreamCallback,
  GenerateActionParams,
} from "./types.ts";

/**
 * Abstract base class for LLM clients.
 * Implements the shared generateAction dispatch logic.
 */
export abstract class BaseLLMClient implements LLMClient {
  public abstract apiKey: string;
  public abstract model: string;
  public abstract maxTokens: number;
  public lastUsage: LLMUsage | null = null;
  public onStream: StreamCallback | null = null;

  abstract generate(prompt: string): Promise<string>;

  async generateAction({ system, messages }: GenerateActionParams): Promise<ParsedOutput> {
    if (this.onStream) {
      return this._generateActionStreaming({ system, messages });
    }
    return this._generateActionBlocking({ system, messages });
  }

  protected abstract _generateActionStreaming(params: GenerateActionParams): Promise<ParsedOutput>;
  protected abstract _generateActionBlocking(params: GenerateActionParams): Promise<ParsedOutput>;
}
