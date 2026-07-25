import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { parseReasoningAndCode, type ParsedOutput } from "../utils/code-parse.ts";
import { resolveClaudeCredentials, credentialCache } from "./claude-auth.ts";
import { wrapSDKError, OAuthExpiredError } from "./errors.ts";
import { withRetry } from "./retry.ts";
import {
  LLMClientOptionsSchema,
  type LLMUsage,
  type StreamCallback,
  type GenerateActionParams,
} from "./types.ts";
import { BaseLLMClient } from "./base.ts";

// ── OAuth error detection ────────────────────────────────────────────────

/**
 * Returns true if the error is an expired-OAuth signal — either:
 * 1. An OAuthExpiredError we threw ourselves from a result message, OR
 * 2. A raw Error thrown directly by the SDK subprocess (before yielding
 *    a result message) whose message contains "Invalid API key".
 *
 * Both paths need to trigger a retry because the SDK can surface the
 * same OAuth expiry in two ways depending on timing.
 */
function isOAuthError(err: unknown): boolean {
  if (err instanceof OAuthExpiredError) return true;
  if (err instanceof Error && /invalid api key|not logged in/i.test(err.message)) return true;
  return false;
}

// ── SDK env allowlist ───────────────────────────────────────────────────

/**
 * Only these env vars are forwarded to the SDK subprocess.
 * Avoids leaking database URLs, secrets, etc.
 */
const SDK_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "NODE_ENV",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
] as const;

// ── Type guards for SDK messages ────────────────────────────────────────

function isAssistantMsg(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}

function isStreamEvent(msg: SDKMessage): msg is SDKPartialAssistantMessage {
  return msg.type === "stream_event";
}

function isResultMsg(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

function isResultSuccess(msg: SDKResultMessage): msg is SDKResultSuccess {
  return msg.subtype === "success";
}

interface AnthropicStreamDeltaHandlers {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

// ── Options schema ──────────────────────────────────────────────────────

/** Anthropic-specific options schema (no baseURL needed) */
const AnthropicOptionsSchema = LLMClientOptionsSchema.omit({ baseURL: true }).extend({
  onStream: z.any().optional(),
});
type AnthropicOptions = z.infer<typeof AnthropicOptionsSchema>;

// ── Query options builder type ──────────────────────────────────────────

interface QueryOptions {
  systemPrompt?: string;
  model: string;
  maxTurns: number;
  /**
   * Base set of available built-in tools.
   * `[]` = disable ALL built-in tools (Read, Write, Bash, etc.).
   * `["WebSearch"]` = only WebSearch is available.
   * Omit or `{ type: "preset", preset: "claude_code" }` = all default tools.
   */
  tools: string[] | { type: "preset"; preset: "claude_code" };
  allowedTools: string[];
  permissionMode: "dontAsk";
  persistSession: boolean;
  cwd: string;
  env: Record<string, string>;
  stderr?: (data: string) => void;
  includePartialMessages?: boolean;
}

// ── Client ──────────────────────────────────────────────────────────────

/**
 * Anthropic Claude LLM adapter — powered by @anthropic-ai/claude-agent-sdk.
 *
 * Uses the Agent SDK `query()` function instead of raw API calls, which:
 * - Bypasses API rate limits when using OAuth tokens from Claude subscription
 * - Handles authentication natively
 * - Provides structured message streaming
 */
export class AnthropicClient extends BaseLLMClient {
  public apiKey: string;
  public model: string;
  public maxTokens: number;
  public override lastUsage: LLMUsage | null;
  public override onStream: StreamCallback | null;

  /** Per-instance flag — avoids the static flag that leaked across test instances. */
  private _credentialLogged = false;
  private _stderrTail = "";

  constructor(opts: AnthropicOptions & { onStream?: StreamCallback } = {}) {
    super();
    const validated = AnthropicOptionsSchema.parse(opts);

    if (validated.apiKey) {
      this.apiKey = validated.apiKey;
      this._logCredential("Using explicit API key from options");
    } else {
      const creds = resolveClaudeCredentials();
      if (creds) {
        this.apiKey = creds.apiKey;
        this._logCredential(
          `Resolved credentials from ${creds.source} (type: ${creds.kind})`
        );
      } else {
        this.apiKey = "";
      }
    }

    this.model = validated.model || "claude-opus-4-7";
    this.maxTokens = validated.maxTokens || 8192;
    this.lastUsage = null;
    this.onStream = (opts as any).onStream ?? null;

    if (!this.apiKey) {
      throw new Error(
        "AnthropicClient: No credentials found. Set ANTHROPIC_API_KEY env var, " +
        "or log in with Claude Code CLI (credentials auto-resolved from Keychain/config)."
      );
    }
  }

  /** Log a credential message once per instance. */
  private _logCredential(msg: string): void {
    if (!this._credentialLogged) {
      console.log(`[AnthropicClient] ${msg}`);
      this._credentialLogged = true;
    }
  }

  // ── Env & Options Helpers ─────────────────────────────────────────────

  /**
   * Build the env object for SDK query() — only inject needed keys.
   * No longer copies all of process.env.
   */
  private _buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: this.apiKey };
    for (const key of SDK_ENV_ALLOWLIST) {
      const val = process.env[key];
      if (val !== undefined) env[key] = val;
    }
    return env;
  }

  /**
   * Attempt to refresh an expired OAuth token by spawning the Claude CLI.
   *
   * When run without ANTHROPIC_API_KEY in env, the Claude CLI subprocess reads
   * its credentials from ~/.claude.json / keychain and automatically uses its
   * stored refresh token to obtain a new access token. After the subprocess
   * exits, we clear the credential cache and re-read the (hopefully fresh)
   * credentials so subsequent retry attempts use the new token.
   */
  private async _refreshOAuthCredentials(): Promise<void> {
    try {
      // `claude -p ""` makes a real authenticated call — this forces the Claude
      // CLI to detect the expired token and use its stored refresh token to obtain
      // a new access token. `--version` doesn't make an auth call so it won't refresh.
      const proc = Bun.spawn(["claude", "-p", ""], {
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
      });
      await proc.exited;
    } catch {
      // `claude` binary not found or failed — can't auto-refresh
    }

    // Small delay for the keychain/config file to be written
    await new Promise((r) => setTimeout(r, 500));

    // Clear the cached (expired) credentials and re-read fresh ones
    credentialCache.clear();
    const fresh = resolveClaudeCredentials();
    if (fresh?.apiKey) {
      this.apiKey = fresh.apiKey;
    }
  }

  private async _shouldRetryOAuth(err: unknown): Promise<boolean> {
    if (!isOAuthError(err)) return false;
    await this._refreshOAuthCredentials();
    return true;
  }

  /**
   * Build shared query options. Individual methods override specific fields.
   */
  private _buildQueryOptions(
    overrides: Partial<QueryOptions> = {}
  ): QueryOptions {
    return {
      model: this.model,
      maxTurns: 1,
      // Disable ALL built-in tools — the RLM has its own sandbox/tool layer.
      // Without this, Claude Code's default tools (Read, Write, Bash, Grep…)
      // remain available, and with permissionMode "dontAsk" they get denied,
      // wasting turns and contaminating output.
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      persistSession: false,
      cwd: "/tmp",
      env: this._buildEnv(),
      stderr: (data: string) => this._recordStderr(data),
      ...overrides,
    };
  }

  private _resetStderr(): void {
    this._stderrTail = "";
  }

  private _recordStderr(data: string): void {
    this._stderrTail = `${this._stderrTail}${data}`.slice(-4000);
  }

  private _wrapSDKError(err: unknown): never {
    const stderr = this._stderrTail.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (stderr && err instanceof Error && /claude|exited|stderr|spawn|subprocess/i.test(err.message)) {
      const wrapped = new Error(`${err.message}\nClaude Code stderr:\n${stderr}`);
      (wrapped as Error & { cause?: unknown }).cause = err;
      wrapSDKError(wrapped);
    }
    wrapSDKError(err);
  }

  // ── Message Collection ────────────────────────────────────────────────

  /**
   * Collect text + usage from a blocking (non-streaming) SDK message stream.
   * Processes `assistant` and `result` messages only.
   */
  private async _collectBlocking(
    stream: AsyncGenerator<SDKMessage, void>,
    signal?: AbortSignal
  ): Promise<{ text: string; usage: LLMUsage }> {
    // Only keep text from the LAST assistant message to avoid contamination
    // from intermediate turns (tool-attempt reasoning leaking into output).
    let lastAssistantText = "";
    let resultText: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const msg of stream) {
      if (signal?.aborted) {
        await stream.return(undefined as unknown as void);
        throw new DOMException("Query aborted", "AbortError");
      }

      if (isAssistantMsg(msg)) {
        // Reset per assistant message — only the LAST one survives.
        lastAssistantText = "";
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              lastAssistantText += block.text;
            }
          }
        }
      } else if (isResultMsg(msg)) {
        inputTokens = msg.usage?.input_tokens ?? 0;
        outputTokens = msg.usage?.output_tokens ?? 0;
        if (isResultSuccess(msg)) {
          resultText = msg.result || null;
        } else {
          // Check both msg.errors (array) and msg.result (full string) for the
          // OAuth expired message — the SDK puts the full text in msg.result:
          // "Claude Code returned an error result: Invalid API key · Fix external API key"
          const errMsg =
            (msg as any).errors?.join("; ") ||
            (msg as any).result ||
            `SDK result: ${msg.subtype}`;
          if (/invalid api key/i.test(errMsg)) {
            throw new OAuthExpiredError(errMsg);
          }
          throw new Error(`Claude Code returned an error result: ${errMsg}`);
        }
      }
    }

    // Prefer the SDK result text (clean final output) over accumulated assistant text.
    const text = resultText ?? lastAssistantText;

    return {
      text,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Collect text + usage from a streaming SDK message stream.
   * Emits partial text/reasoning via callbacks in real-time.
   */
  private async _collectStreaming(
    stream: AsyncGenerator<SDKMessage, void>,
    handlers: AnthropicStreamDeltaHandlers,
    signal?: AbortSignal
  ): Promise<{ text: string; reasoning: string; usage: LLMUsage }> {
    let fullText = "";
    let fullReasoning = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const msg of stream) {
      if (signal?.aborted) {
        await stream.return(undefined as unknown as void);
        throw new DOMException("Query aborted", "AbortError");
      }

      if (isStreamEvent(msg)) {
        const event = msg.event as unknown as Record<string, unknown>;

        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            fullText += delta.text;
            handlers.onTextDelta?.(delta.text);
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            fullReasoning += delta.thinking;
            handlers.onReasoningDelta?.(delta.thinking);
          }
        } else if (event.type === "message_start") {
          const msg2 = event.message as Record<string, unknown> | undefined;
          const usage = msg2?.usage as Record<string, number> | undefined;
          if (usage) {
            inputTokens = usage.input_tokens || 0;
          }
        } else if (event.type === "message_delta") {
          const usage = event.usage as Record<string, number> | undefined;
          if (usage) {
            outputTokens = usage.output_tokens || 0;
          }
        }
      } else if (isResultMsg(msg)) {
        inputTokens = msg.usage?.input_tokens ?? inputTokens;
        outputTokens = msg.usage?.output_tokens ?? outputTokens;
        if (!isResultSuccess(msg)) {
          // Check both msg.errors and msg.result for the OAuth expired message
          const errMsg =
            (msg as any).errors?.join("; ") ||
            (msg as any).result ||
            `SDK result: ${msg.subtype}`;
          if (/invalid api key/i.test(errMsg)) {
            throw new OAuthExpiredError(errMsg);
          }
        }
      }
    }

    return {
      text: fullText,
      reasoning: fullReasoning,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  // ── Prompt Assembly ───────────────────────────────────────────────────

  /**
   * Assemble multi-turn messages into a single prompt string for the SDK.
   *
   * The SDK query() takes a flat string prompt. The RLM loop sends messages as:
   *   [user₀, assistant₀, user₁, assistant₁, ..., userₙ]
   *
   * The last user message (userₙ) already contains the full execution history
   * via buildIterationPrompt(). Prior messages are serialized as XML-tagged
   * context to avoid marker echo (### Human: etc. leak into code blocks).
   */
  private _assemblePrompt(
    messages: Array<{ role: string; content: string }>
  ): string {
    if (messages.length <= 1) {
      return messages[0]?.content || "";
    }

    const lastMsg = messages[messages.length - 1];
    const priorMsgs = messages.slice(0, -1);

    if (priorMsgs.length === 0) {
      return lastMsg.content;
    }

    const contextParts: string[] = [];
    for (const msg of priorMsgs) {
      contextParts.push(`<turn role="${msg.role}">\n${msg.content}\n</turn>`);
    }

    return `<conversation_context>\n${contextParts.join("\n")}\n</conversation_context>\n\n${lastMsg.content}`;
  }

  // ── Public API ────────────────────────────────────────────────────────

  async generate(
    prompt: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<string> {
    this._resetStderr();
    try {
      return await withRetry(
        async () => {
          const stream = query({
            prompt,
            options: this._buildQueryOptions(),
          });

          const { text, usage } = await this._collectBlocking(
            stream,
            opts.signal
          );
          this.lastUsage = usage;
          return text;
        },
        { maxAttempts: 3, baseDelayMs: 500, shouldRetry: (e) => this._shouldRetryOAuth(e) }
      );
    } catch (err) {
      this._wrapSDKError(err);
    }
  }

  async run_websearch(
    searchQuery: string,
    opts: { signal?: AbortSignal } = {}
  ): Promise<string> {
    this._resetStderr();
    try {
      return await withRetry(
        async () => {
          const stream = query({
            prompt: searchQuery,
            options: this._buildQueryOptions({
              maxTurns: 3,
              // Make WebSearch available AND auto-approved.
              tools: ["WebSearch"],
              allowedTools: ["WebSearch"],
            }),
          });

          const { text, usage } = await this._collectBlocking(
            stream,
            opts.signal
          );
          this.lastUsage = usage;
          return text;
        },
        { maxAttempts: 3, baseDelayMs: 500, shouldRetry: (e) => this._shouldRetryOAuth(e) }
      );
    } catch (err) {
      this._wrapSDKError(err);
    }
  }

  /** Non-streaming generateAction via SDK query() */
  protected async _generateActionBlocking(
    { system, messages }: GenerateActionParams
  ): Promise<ParsedOutput> {
    const prompt = this._assemblePrompt(messages);
    this._resetStderr();
    try {
      return await withRetry(
        async () => {
          const stream = query({
            prompt,
            options: this._buildQueryOptions({ systemPrompt: system }),
          });

          const { text, usage } = await this._collectBlocking(stream);
          this.lastUsage = usage;
          return parseReasoningAndCode(text);
        },
        { maxAttempts: 3, baseDelayMs: 500, shouldRetry: (e) => this._shouldRetryOAuth(e) }
      );
    } catch (err) {
      this._wrapSDKError(err);
    }
  }

  /**
   * Streaming generateAction — uses SDK partial messages.
   * Emits text deltas via this.onStream callback in real-time,
   * then returns the full { reasoning, code } result.
   */
  protected async _generateActionStreaming(
    { system, messages }: GenerateActionParams
  ): Promise<ParsedOutput> {
    const prompt = this._assemblePrompt(messages);
    const onStream = this.onStream!;
    this._resetStderr();
    let streamError: Error | null = null;
    let fullText = "";
    let fullReasoning = "";
    let usage: LLMUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      const result = await withRetry(
        async () => {
          const stream = query({
            prompt,
            options: this._buildQueryOptions({
              systemPrompt: system,
              includePartialMessages: true,
            }),
          });

          return await this._collectStreaming(
            stream,
            {
              onTextDelta: (delta) => {
                try {
                  onStream({ type: "text", delta });
                } catch { }
              },
              onReasoningDelta: (delta) => {
                try {
                  onStream({ type: "reasoning", delta });
                } catch { }
              },
            },
          );
        },
        { maxAttempts: 3, baseDelayMs: 500, shouldRetry: (e) => this._shouldRetryOAuth(e) }
      );

      fullText = result.text;
      fullReasoning = result.reasoning;
      usage = result.usage;
    } catch (err) {
      streamError = err as Error;
    } finally {
      try {
        onStream({
          type: "done",
          error: streamError || null,
          text: fullText,
          reasoning: fullReasoning || null,
          usage,
        });
      } catch { }
    }

    if (streamError) this._wrapSDKError(streamError);

    this.lastUsage = usage;
    const parsed = parseReasoningAndCode(fullText);
    if (fullReasoning) {
      parsed.reasoning = parsed.reasoning
        ? `${fullReasoning}\n\n${parsed.reasoning}`
        : fullReasoning;
    }
    return parsed;
  }
}
