export const ANTHROPIC_MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_PROXY_PREFIX = "/api/jcode-anthropic-openai";

let localProxyBase: string | null = null;
let localProxyServer: ReturnType<typeof Bun.serve> | null = null;

export function configureAnthropicProxyEnvForServer(host: string, port: number): void {
  if (!process.env.ANTHROPIC_API_KEY || process.env.RLM_WIKI_DISABLE_ANTHROPIC_PROXY === "1") return;
  const clientHost = jcodeLocalProxyHost(host);
  process.env.RLM_WIKI_ANTHROPIC_OPENAI_COMPAT_API_BASE = `http://${clientHost}:${port}${ANTHROPIC_PROXY_PREFIX}`;
}

export function ensureLocalAnthropicProxyBase(): string {
  if (localProxyBase) return localProxyBase;
  localProxyServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      return proxyAnthropicOpenAI(req, new URL(req.url), "");
    },
  });
  localProxyServer.unref();
  localProxyBase = `http://localhost:${localProxyServer.port}`;
  return localProxyBase;
}

function jcodeLocalProxyHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "127.0.0.1" || normalized === "::1") {
    return "localhost";
  }
  return host;
}

type JsonRecord = Record<string, unknown>;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: JsonRecord[];
}

interface ToolCallState {
  openAIIndex: number;
  id: string;
  name: string;
}

export async function proxyAnthropicOpenAI(req: Request, url: URL, prefix = ANTHROPIC_PROXY_PREFIX): Promise<Response> {
  const suffix = prefix ? url.pathname.slice(prefix.length) || "/" : url.pathname || "/";

  if ((req.method === "GET" || req.method === "HEAD") && suffix.endsWith("/models")) {
    return jsonResponse({
      object: "list",
      data: [],
    });
  }

  if (req.method !== "POST" || !suffix.endsWith("/chat/completions")) {
    return jsonResponse({
      error: {
        message: "Anthropic OpenAI-compatible proxy only supports POST /chat/completions.",
        type: "invalid_request_error",
      },
    }, 404);
  }

  const apiKey = apiKeyFromHeaders(req.headers);
  if (!apiKey) {
    return jsonResponse({
      error: {
        message: "ANTHROPIC_API_KEY is required for Claude Agent mode.",
        type: "authentication_error",
      },
    }, 401);
  }

  let payload: JsonRecord;
  try {
    payload = await req.json() as JsonRecord;
  } catch {
    return jsonResponse({
      error: {
        message: "Request body must be valid JSON.",
        type: "invalid_request_error",
      },
    }, 400);
  }

  const anthropicBody = openAIChatToAnthropicMessages(payload);
  const stream = payload.stream === true;
  const upstreamRes = await fetch(ANTHROPIC_MESSAGES_API_URL, {
    method: "POST",
    headers: {
      "accept": stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!upstreamRes.ok) {
    return anthropicErrorResponse(upstreamRes);
  }

  const requestedModel = stringValue(payload.model) || stringValue(anthropicBody.model) || "claude";
  if (stream) {
    if (!upstreamRes.body) {
      return jsonResponse({
        error: {
          message: "Anthropic returned an empty stream.",
          type: "api_error",
        },
      }, 502);
    }
    return new Response(anthropicStreamToOpenAI(upstreamRes.body, requestedModel), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  const anthropicPayload = await upstreamRes.json() as JsonRecord;
  return jsonResponse(anthropicMessageToOpenAICompletion(anthropicPayload, requestedModel));
}

function apiKeyFromHeaders(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")?.trim();
  const bearer = authorization?.match(/^bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer
    || headers.get("x-api-key")?.trim()
    || headers.get("anthropic-api-key")?.trim()
    || process.env.ANTHROPIC_API_KEY?.trim()
    || undefined;
}

function openAIChatToAnthropicMessages(payload: JsonRecord): JsonRecord {
  const messagesInput = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const item of messagesInput) {
    if (!isRecord(item)) continue;
    const role = stringValue(item.role);
    if (role === "system" || role === "developer") {
      const text = openAIContentToText(item.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "assistant") {
      appendAnthropicMessage(messages, "assistant", assistantContentBlocks(item));
      continue;
    }

    if (role === "tool" || role === "function") {
      appendAnthropicMessage(messages, "user", [toolResultBlock(item)]);
      continue;
    }

    appendAnthropicMessage(messages, "user", contentBlocksFromOpenAIContent(item.content));
  }

  if (!messages.length || messages[0]?.role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continuing)" }] });
  }

  const body: JsonRecord = {
    model: stringValue(payload.model) || "claude-sonnet-4-6",
    max_tokens: numberValue(payload.max_tokens) ?? 8192,
    messages,
  };

  if (systemParts.length) body.system = systemParts.join("\n\n");
  const temperature = numberValue(payload.temperature);
  if (temperature !== undefined) body.temperature = temperature;
  const topP = numberValue(payload.top_p);
  if (topP !== undefined) body.top_p = topP;
  const stopSequences = stopSequencesFromOpenAI(payload.stop);
  if (stopSequences.length) body.stop_sequences = stopSequences;

  const tools = toolsFromOpenAI(payload.tools);
  if (tools.length) {
    body.tools = tools;
    const toolChoice = toolChoiceFromOpenAI(payload.tool_choice);
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (payload.stream === true) body.stream = true;

  return body;
}

function appendAnthropicMessage(messages: AnthropicMessage[], role: "user" | "assistant", content: JsonRecord[]): void {
  const normalized = content.length ? content : [{ type: "text", text: " " }];
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.content.push(...normalized);
    return;
  }
  messages.push({ role, content: normalized });
}

function assistantContentBlocks(message: JsonRecord): JsonRecord[] {
  const content = contentBlocksFromOpenAIContent(message.content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall)) continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const name = stringValue(fn.name);
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: stringValue(toolCall.id) || `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
      name,
      input: parseJsonObject(stringValue(fn.arguments) || "{}"),
    });
  }
  return content;
}

function toolResultBlock(message: JsonRecord): JsonRecord {
  const contentText = openAIContentToText(message.content);
  return {
    type: "tool_result",
    tool_use_id: stringValue(message.tool_call_id) || stringValue(message.name) || "toolu_unknown",
    content: contentText || " ",
  };
}

function contentBlocksFromOpenAIContent(content: unknown): JsonRecord[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: JsonRecord[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = stringValue(part.type);
    if (type === "text" || type === "input_text") {
      const text = stringValue(part.text) || stringValue(part.input_text);
      if (text) blocks.push({ type: "text", text });
    } else if (type === "image_url") {
      const block = imageBlockFromOpenAIPart(part);
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

function imageBlockFromOpenAIPart(part: JsonRecord): JsonRecord | null {
  const imageUrl = isRecord(part.image_url) ? stringValue(part.image_url.url) : stringValue(part.image_url);
  if (!imageUrl) return null;
  const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }
  return {
    type: "image",
    source: {
      type: "url",
      url: imageUrl,
    },
  };
}

function openAIContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = stringValue(part.text) || stringValue(part.input_text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function toolsFromOpenAI(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const tools: JsonRecord[] = [];
  for (const tool of value) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? tool.function : {};
    const name = stringValue(fn.name);
    if (!name) continue;
    tools.push({
      name,
      description: stringValue(fn.description) || undefined,
      input_schema: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return tools;
}

function toolChoiceFromOpenAI(value: unknown): JsonRecord | undefined {
  if (!value || value === "auto") return { type: "auto" };
  if (value === "none") return { type: "none" };
  if (value === "required") return { type: "any" };
  if (isRecord(value)) {
    const fn = isRecord(value.function) ? value.function : {};
    const name = stringValue(fn.name);
    if (name) return { type: "tool", name };
  }
  return undefined;
}

function stopSequencesFromOpenAI(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item));
}

function anthropicMessageToOpenAICompletion(payload: JsonRecord, fallbackModel: string): JsonRecord {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: JsonRecord[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      reasoningParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      const name = stringValue(block.name);
      if (!name) continue;
      toolCalls.push({
        id: stringValue(block.id) || `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
        },
      });
    }
  }

  const message: JsonRecord = {
    role: "assistant",
    content: textParts.join(""),
  };
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join("\n");
  if (toolCalls.length) {
    message.content = message.content || null;
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl_${stringValue(payload.id) || crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: stringValue(payload.model) || fallbackModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFromAnthropic(stringValue(payload.stop_reason)),
    }],
    usage: usageFromAnthropic(payload.usage),
  };
}

function anthropicStreamToOpenAI(body: ReadableStream<Uint8Array>, fallbackModel: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let buffer = "";
  let sentRole = false;
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  const toolCallIndexes = new Map<number, ToolCallState>();

  const chunk = (delta: JsonRecord, finish: string | null = null): JsonRecord => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finish,
    }],
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (data: JsonRecord): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const emitRole = (): void => {
        if (sentRole) return;
        sentRole = true;
        emit(chunk({ role: "assistant" }));
      };
      const emitDone = (): void => {
        emit(chunk({}, finishReason ?? "stop"));
        emit({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = flushAnthropicSSE(buffer, (event) => {
            emitRole();
            if (event.type === "message_start" && isRecord(event.message)) {
              model = stringValue(event.message.model) || model;
              const usage = isRecord(event.message.usage) ? event.message.usage : {};
              promptTokens = numberValue(usage.input_tokens) ?? promptTokens;
            } else if (event.type === "content_block_start") {
              const index = numberValue(event.index);
              const contentBlock = isRecord(event.content_block) ? event.content_block : {};
              if (index !== undefined && contentBlock.type === "tool_use") {
                const openAIIndex = toolCallIndexes.size;
                const idValue = stringValue(contentBlock.id) || `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
                const name = stringValue(contentBlock.name) || "tool";
                toolCallIndexes.set(index, { openAIIndex, id: idValue, name });
                emit(chunk({
                  tool_calls: [{
                    index: openAIIndex,
                    id: idValue,
                    type: "function",
                    function: { name, arguments: "" },
                  }],
                }));
              }
            } else if (event.type === "content_block_delta") {
              const delta = isRecord(event.delta) ? event.delta : {};
              if (delta.type === "text_delta") {
                const text = stringValue(delta.text);
                if (text) emit(chunk({ content: text }));
              } else if (delta.type === "thinking_delta") {
                const thinking = stringValue(delta.thinking);
                if (thinking) emit(chunk({ reasoning_content: thinking }));
              } else if (delta.type === "input_json_delta") {
                const index = numberValue(event.index);
                const state = index === undefined ? undefined : toolCallIndexes.get(index);
                const partialJson = stringValue(delta.partial_json);
                if (state && partialJson) {
                  emit(chunk({
                    tool_calls: [{
                      index: state.openAIIndex,
                      function: { arguments: partialJson },
                    }],
                  }));
                }
              }
            } else if (event.type === "message_delta") {
              const delta = isRecord(event.delta) ? event.delta : {};
              finishReason = finishReasonFromAnthropic(stringValue(delta.stop_reason));
              const usage = isRecord(event.usage) ? event.usage : {};
              completionTokens = numberValue(usage.output_tokens) ?? completionTokens;
            }
          });
        }
        if (buffer.trim()) {
          flushAnthropicSSE(`${buffer}\n\n`, (event) => {
            if (event.type === "message_delta") {
              const delta = isRecord(event.delta) ? event.delta : {};
              finishReason = finishReasonFromAnthropic(stringValue(delta.stop_reason));
            }
          });
        }
        emitRole();
        emitDone();
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return stream;
}

function flushAnthropicSSE(buffer: string, onEvent: (event: JsonRecord) => void): string {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const chunks = normalized.split("\n\n");
  const remainder = chunks.pop() ?? "";
  for (const raw of chunks) {
    const dataLines = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    for (const line of dataLines) {
      if (!line || line === "[DONE]") continue;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) onEvent(parsed);
      } catch {
        // Ignore malformed upstream frames and keep the stream alive.
      }
    }
  }
  return remainder;
}

async function anthropicErrorResponse(res: Response): Promise<Response> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const error = isRecord(parsed) && isRecord(parsed.error)
    ? parsed.error
    : { message: text || res.statusText, type: "api_error" };
  return jsonResponse({ error }, res.status);
}

function usageFromAnthropic(value: unknown): JsonRecord {
  const usage = isRecord(value) ? value : {};
  const input = numberValue(usage.input_tokens) ?? 0;
  const output = numberValue(usage.output_tokens) ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

function finishReasonFromAnthropic(value: string | undefined): string {
  switch (value) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "stop_sequence":
    case "end_turn":
    default:
      return "stop";
  }
}

function parseJsonObject(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
