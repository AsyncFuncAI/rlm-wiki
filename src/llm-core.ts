export interface ParsedOutput {
  reasoning: string;
  code: string;
  answer?: string;
  sources?: string[];
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; error: Error | null; text: string; reasoning?: string | null; usage: LLMUsage | null };

export type StreamCallback = (event: StreamEvent) => void;

export interface ChatMessage {
  role: string;
  content: string;
}

export interface GenerateActionParams {
  system: string;
  messages: ChatMessage[];
}

export interface LLMClient {
  lastUsage: LLMUsage | null;
  onStream: StreamCallback | null;
  model?: string;
  generate(prompt: string): Promise<string>;
  generateAction(params: GenerateActionParams): Promise<ParsedOutput>;
}

export abstract class BaseLLMClient implements LLMClient {
  public abstract apiKey: string;
  public abstract model: string;
  public abstract maxTokens: number;
  public lastUsage: LLMUsage | null = null;
  public onStream: StreamCallback | null = null;

  abstract generate(prompt: string): Promise<string>;

  async generateAction(params: GenerateActionParams): Promise<ParsedOutput> {
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

export function parseReasoningAndCode(text: string): ParsedOutput {
  const answerMatch = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i);
  const answer = answerMatch?.[1]?.trim();
  const textWithoutAnswer = answerMatch
    ? text.slice(0, answerMatch.index) + text.slice((answerMatch.index ?? 0) + answerMatch[0].length)
    : text;
  const code = textWithoutAnswer.match(/```(?:js|javascript|ts|typescript)\s*([\s\S]*?)```/i)?.[1]?.trim() ?? "";
  const sources = extractCitationSources(text);
  return {
    reasoning: code
      ? textWithoutAnswer.replace(/```(?:js|javascript|ts|typescript)\s*[\s\S]*?```/i, "").trim()
      : textWithoutAnswer.trim(),
    code,
    ...(answer ? { answer } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

function extractCitationSources(text: string): string[] {
  const sources = new Set<string>();
  for (const match of text.matchAll(/\[([A-Za-z0-9_./@ -]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)\]\(\)/g)) {
    sources.add(match[1].trim());
  }
  return [...sources];
}
