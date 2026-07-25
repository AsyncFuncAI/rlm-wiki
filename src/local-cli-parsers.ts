import type { LocalCliEvent, LocalCliParticipant } from "./local-cli-events.ts";
import {
  createAcpStreamState,
  mapAcpMessageToEvents,
  type AcpAgentKind,
  type AcpStreamState,
} from "./acp/event-mapper.ts";

export interface CodexParserState {
  activeTools: Map<string, { name: string; input?: unknown; startedAt: number; emitted: boolean }>;
  threadId?: string;
  participantsById: Map<string, LocalCliParticipantStatusRecord>;
}

type LocalCliParticipantStatusRecord = {
  id: string;
  role: "agent" | "tool" | "model";
  parentId?: string;
  toolUseId?: string;
  title?: string;
  name?: string;
  agentType?: string;
  prompt?: string;
  sessionId?: string;
};

/** ACP stream state (Agentrove-style). Alias kept for call sites. */
export type AcpParserState = AcpStreamState;

type CodexCommandKind = "search" | "read" | "list" | "command";

type CodexCommandSummary = {
  name: string;
  kind: CodexCommandKind;
  input: Record<string, string>;
  query?: string;
  path?: string;
};

type CodexToolSummary = {
  name: string;
  input: Record<string, unknown>;
};

type ClaudeBlockState = {
  type: string;
  id?: string;
  name?: string;
  input: string;
  inputSignalEmitted?: boolean;
  participant?: LocalCliParticipant;
};

type ClaudeTaskState = {
  id: string;
  toolUseId: string;
  description: string;
  agentType?: string;
};

export interface ClaudeParserState {
  blocks: Map<number, ClaudeBlockState>;
  activeTools: Map<string, { name: string; input?: unknown; startedAt: number; participant?: LocalCliParticipant }>;
  tasksByToolUseId: Map<string, ClaudeTaskState>;
  currentMessageText: string;
  currentMessageStreamedText: boolean;
  readyEmitted: boolean;
  streamingEmitted: boolean;
  textStreamed: boolean;
}

export interface PiParserState {
  sessionId?: string;
  currentMessageText: string;
  currentMessageStreamedText: boolean;
  activeTools: Map<string, { name: string; input?: unknown; startedAt: number }>;
}

export function createCodexParserState(): CodexParserState {
  return {
    activeTools: new Map(),
    participantsById: new Map(),
  };
}

export function createAcpParserState(agentKind: AcpAgentKind = "generic"): AcpParserState {
  return createAcpStreamState(agentKind);
}

export function createClaudeParserState(): ClaudeParserState {
  return {
    blocks: new Map(),
    activeTools: new Map(),
    tasksByToolUseId: new Map(),
    currentMessageText: "",
    currentMessageStreamedText: false,
    readyEmitted: false,
    streamingEmitted: false,
    textStreamed: false,
  };
}

export function createPiParserState(): PiParserState {
  return {
    currentMessageText: "",
    currentMessageStreamedText: false,
    activeTools: new Map(),
  };
}

export function codexJsonToEvents(raw: unknown, state: CodexParserState = createCodexParserState()): LocalCliEvent[] {
  const event = asObject(raw);
  const type = stringValue(event.type);
  const out: LocalCliEvent[] = [];

  if (type === "thread.started") {
    state.threadId = stringValue(event.thread_id ?? event.threadId) || state.threadId;
    out.push({
      type: "status",
      label: "initializing",
      message: "Codex session initialized.",
      sessionId: state.threadId,
    });
    return out;
  }
  if (type === "turn.started") {
    out.push({ type: "status", label: "running", message: "Codex is working." });
    return out;
  }
  if (type === "turn.completed") {
    const usage = asObject(event.usage);
    const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    const cachedInputTokens = numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens);
    if (inputTokens || outputTokens || cachedInputTokens) {
      out.push({
        type: "usage",
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens + cachedInputTokens,
      });
    }
    out.push({ type: "status", label: "done", message: "Codex finished." });
    return out;
  }

  const item = asObject(event.item);
  const itemId = stringValue(item.id || event.item_id || event.id) || `codex-${state.activeTools.size + 1}`;
  const itemType = stringValue(item.type || event.item_type);
  if ((type === "item.started" || type === "item.completed") && itemType === "collab_tool_call") {
    return codexCollabToolCallEvents(type, itemId, item, state);
  }
  if (type === "item.started" && itemType === "command_execution") {
    const command = stringValue(item.command || asObject(item.input).command || event.command);
    const tool = codexCommandSummary(command, item.input);
    state.activeTools.set(itemId, { name: tool.name, input: tool.input, startedAt: Date.now(), emitted: true });
    const signal = codexCommandActivitySignal(command);
    if (signal) out.push({ type: "thinking_delta", text: signal });
    out.push({ type: "tool_use", id: itemId, name: tool.name, input: tool.input });
    return out;
  }
  if (type === "item.completed" && itemType === "command_execution") {
    const active = state.activeTools.get(itemId);
    const command = stringValue(item.command || asObject(item.input).command);
    const tool = active ?? codexCommandSummary(command, item.input);
    const output = stringValue(item.aggregated_output || item.output || item.stdout || item.stderr);
    const status = stringValue(item.status);
    const exitCode = numberValue(item.exit_code ?? item.exitCode);
    const isError = status === "failed" || status === "error" || exitCode > 0;
    if (!active) {
      out.push({ type: "tool_use", id: itemId, name: tool.name, input: tool.input });
    }
    out.push({
      type: "tool_result",
      id: itemId,
      name: tool.name,
      output,
      isError,
      durationMs: active ? Math.max(0, Date.now() - active.startedAt) : undefined,
    });
    state.activeTools.delete(itemId);
    return out;
  }
  if (type === "item.started" && itemType === "mcp_tool_call") {
    const tool = codexMcpToolSummary(item);
    state.activeTools.set(itemId, {
      name: tool.name,
      input: tool.input,
      startedAt: Date.now(),
      emitted: true,
    });
    const signal = codexMcpActivitySignal(tool);
    if (signal) out.push({ type: "thinking_delta", text: signal });
    out.push({ type: "tool_use", id: itemId, name: tool.name, input: tool.input });
    return out;
  }
  if (type === "item.completed" && itemType === "mcp_tool_call") {
    const active = state.activeTools.get(itemId);
    const tool = active ?? codexMcpToolSummary(item);
    const output = extractText(item.result ?? item.output ?? item.error);
    const error = extractText(item.error);
    const status = stringValue(item.status);
    const isError = !!error || status === "failed" || status === "error";
    if (!active) {
      out.push({ type: "tool_use", id: itemId, name: tool.name, input: tool.input });
    }
    out.push({
      type: "tool_result",
      id: itemId,
      name: tool.name,
      output: error || output,
      isError,
      durationMs: active ? Math.max(0, Date.now() - active.startedAt) : undefined,
    });
    state.activeTools.delete(itemId);
    return out;
  }
  if (type === "item.completed" && (itemType === "agent_message" || itemType === "message")) {
    const text = extractText(item.text ?? item.content ?? event.text ?? event.content);
    if (text) out.push({ type: "text_delta", text });
    return out;
  }

  const delta = extractText(event.delta ?? event.text);
  if ((type === "text_delta" || type === "message.delta" || type === "response.output_text.delta") && delta) {
    out.push({ type: "text_delta", text: delta });
  }
  return out;
}

export function piJsonToEvents(raw: unknown, state: PiParserState = createPiParserState()): LocalCliEvent[] {
  const event = asObject(raw);
  const type = stringValue(event.type);
  const out: LocalCliEvent[] = [];

  if (type === "session") {
    state.sessionId = stringValue(event.id) || state.sessionId;
    out.push({
      type: "status",
      label: "initializing",
      message: "Pi session initialized.",
      sessionId: state.sessionId,
    });
    return out;
  }

  if (type === "agent_start") {
    out.push({ type: "status", label: "running", message: "Pi is working.", sessionId: state.sessionId });
    return out;
  }

  if (type === "agent_end") {
    out.push({ type: "status", label: "done", message: "Pi finished.", sessionId: state.sessionId });
    return out;
  }

  if (type === "message_update") {
    const assistantEvent = asObject(event.assistantMessageEvent);
    const assistantType = stringValue(assistantEvent.type);
    if (assistantType === "text_delta") {
      const delta = stringValue(assistantEvent.delta);
      if (delta) {
        state.currentMessageStreamedText = true;
        out.push({ type: "text_delta", text: delta });
      }
      return out;
    }
    if (assistantType === "thinking_start") {
      out.push({ type: "thinking_start", label: "Thinking" });
      return out;
    }
    if (assistantType === "thinking_delta") {
      const delta = stringValue(assistantEvent.delta);
      if (delta) out.push({ type: "thinking_delta", text: delta });
      return out;
    }
    if (assistantType === "toolcall_end") {
      const toolCall = asObject(assistantEvent.toolCall);
      const id = stringValue(toolCall.id) || stringValue(toolCall.toolCallId);
      const name = stringValue(toolCall.name);
      if (id && name && !state.activeTools.has(id)) {
        const input = toolCall.arguments ?? toolCall.args;
        state.activeTools.set(id, { name, input, startedAt: Date.now() });
        out.push({ type: "tool_use", id, name, input });
      }
      return out;
    }
    return out;
  }

  if (type === "message_end") {
    const message = asObject(event.message);
    const role = stringValue(message.role);
    const usage = asObject(message.usage);
    const inputTokens = numberValue(usage.input);
    const outputTokens = numberValue(usage.output);
    const cachedInputTokens = numberValue(usage.cacheRead) + numberValue(usage.cacheWrite);
    if (inputTokens || outputTokens || cachedInputTokens) {
      out.push({
        type: "usage",
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens + cachedInputTokens,
        costUsd: numberValue(asObject(usage.cost).total),
      });
    }
    if (role === "assistant") {
      const text = extractAssistantText(message);
      emitPiTextSnapshot(state, out, text);
    }
    const stopReason = stringValue(message.stopReason);
    const errorMessage = stringValue(message.errorMessage);
    if ((stopReason === "error" || stopReason === "aborted") && errorMessage) {
      out.push({ type: "error", error: errorMessage, code: stopReason });
    }
    return out;
  }

  if (type === "tool_execution_start") {
    const id = stringValue(event.toolCallId);
    const name = stringValue(event.toolName);
    if (id && name && !state.activeTools.has(id)) {
      state.activeTools.set(id, { name, input: event.args, startedAt: Date.now() });
      out.push({ type: "tool_use", id, name, input: event.args });
    }
    return out;
  }

  if (type === "tool_execution_update") {
    const id = stringValue(event.toolCallId);
    const name = stringValue(event.toolName) || state.activeTools.get(id)?.name;
    const output = extractText(asObject(event.partialResult).content ?? event.partialResult);
    if (id && name && output) {
      out.push({
        type: "status",
        label: name,
        phase: "tool-progress",
        message: output.length > 500 ? `${output.slice(0, 499)}…` : output,
      });
    }
    return out;
  }

  if (type === "tool_execution_end") {
    const id = stringValue(event.toolCallId);
    const active = state.activeTools.get(id);
    const name = stringValue(event.toolName) || active?.name || "tool";
    const output = extractText(asObject(event.result).content ?? event.result);
    const durationMs = active?.startedAt ? Date.now() - active.startedAt : undefined;
    if (id) state.activeTools.delete(id);
    out.push({
      type: "tool_result",
      id: id || `${name}-${Date.now()}`,
      name,
      output,
      isError: event.isError === true,
      durationMs,
    });
    return out;
  }

  if (type === "queue_update") {
    out.push({ type: "status", label: "queue", message: "Pi updated its steering/follow-up queue." });
    return out;
  }

  if (type === "compaction_start") {
    out.push({ type: "status", label: "compaction", message: "Pi started context compaction." });
    return out;
  }

  if (type === "compaction_end") {
    out.push({ type: "status", label: "compaction", message: "Pi finished context compaction." });
    return out;
  }

  if (type === "auto_retry_start") {
    out.push({
      type: "status",
      label: "retrying",
      message: stringValue(event.errorMessage) || "Pi is retrying after a transient error.",
    });
    return out;
  }

  if (type === "auto_retry_end" && event.success === false) {
    out.push({ type: "error", error: stringValue(event.finalError) || "Pi retry failed.", code: "auto_retry_failed" });
  }

  return out;
}

function codexCollabToolCallEvents(
  type: string,
  itemId: string,
  item: Record<string, any>,
  state: CodexParserState,
): LocalCliEvent[] {
  const out: LocalCliEvent[] = [];
  const tool = stringValue(item.tool || item.name) || "collab";
  const senderThreadId = stringValue(item.sender_thread_id ?? item.senderThreadId) || state.threadId;
  const receiverThreadIds = arrayValue(item.receiver_thread_ids ?? item.receiverThreadIds)
    .map(stringValue)
    .filter(Boolean);
  const prompt = stringValue(item.prompt);
  const input = codexCollabToolInput(item, tool);
  const displayName = isCodexAgentCollabTool(tool) ? "Agent" : humanizeToolName(tool);

  if (type === "item.started") {
    state.activeTools.set(itemId, {
      name: displayName,
      input,
      startedAt: Date.now(),
      emitted: true,
    });
    out.push({ type: "tool_use", id: itemId, name: displayName, input });
    if (tool === "wait") {
      for (const participantId of receiverThreadIds) {
        const previous = state.participantsById.get(participantId);
        out.push({
          type: "participant_status",
          id: participantId,
          role: "agent",
          state: "running",
          parentId: previous?.parentId || senderThreadId || undefined,
          toolUseId: previous?.toolUseId || itemId,
          title: previous?.title || "Subagent",
          detail: "Waiting for subagent result.",
          name: previous?.name,
          agentType: previous?.agentType,
          prompt: previous?.prompt,
          sessionId: previous?.sessionId || participantId,
        });
      }
    }
    return out;
  }

  const active = state.activeTools.get(itemId);
  if (!active) out.push({ type: "tool_use", id: itemId, name: displayName, input });
  out.push({
    type: "tool_result",
    id: itemId,
    name: active?.name || displayName,
    output: codexCollabToolOutput(item),
    isError: /fail|error/i.test(stringValue(item.status)),
    durationMs: active ? Math.max(0, Date.now() - active.startedAt) : undefined,
  });

  const agents = asObject(item.agents_states ?? item.agentsStates);
  const participantIds = receiverThreadIds.length ? receiverThreadIds : Object.keys(agents);
  for (const participantId of participantIds) {
    const agentState = asObject(agents[participantId]);
    const rawStatus = stringValue(agentState.status ?? item.status);
    const participantState = codexParticipantState(rawStatus, tool);
    const previous = state.participantsById.get(participantId);
    const title = previous?.title || codexParticipantTitle(prompt);
    const record: LocalCliParticipantStatusRecord = {
      id: participantId,
      role: "agent",
      parentId: previous?.parentId || senderThreadId || undefined,
      toolUseId: previous?.toolUseId || (tool === "spawn_agent" ? itemId : undefined),
      title,
      name: previous?.name,
      agentType: previous?.agentType,
      prompt: previous?.prompt || prompt || undefined,
      sessionId: participantId,
    };
    state.participantsById.set(participantId, record);
    const message = extractText(agentState.message ?? agentState.output);
    out.push({
      type: "participant_status",
      id: participantId,
      role: "agent",
      state: participantState,
      parentId: record.parentId,
      toolUseId: record.toolUseId || itemId,
      title,
      detail: participantState === "completed" ? "" : codexParticipantDetail(rawStatus, tool),
      name: record.name,
      agentType: record.agentType,
      prompt: record.prompt,
      output: message || undefined,
      sessionId: record.sessionId,
    });
  }

  state.activeTools.delete(itemId);
  return out;
}

function isCodexAgentCollabTool(tool: string): boolean {
  return /^(?:spawn_agent|wait)$/i.test(tool);
}

function codexCollabToolInput(item: Record<string, any>, tool: string): Record<string, unknown> {
  return {
    tool,
    ...(stringValue(item.prompt) ? { prompt: stringValue(item.prompt) } : {}),
    ...(stringValue(item.sender_thread_id ?? item.senderThreadId) ? { sender_thread_id: stringValue(item.sender_thread_id ?? item.senderThreadId) } : {}),
    ...(arrayValue(item.receiver_thread_ids ?? item.receiverThreadIds).length
      ? { receiver_thread_ids: arrayValue(item.receiver_thread_ids ?? item.receiverThreadIds) }
      : {}),
  };
}

function codexCollabToolOutput(item: Record<string, any>): string {
  const agents = asObject(item.agents_states ?? item.agentsStates);
  const messages = Object.entries(agents)
    .map(([id, value]) => {
      const state = asObject(value);
      const status = stringValue(state.status);
      const message = extractText(state.message ?? state.output);
      return [id, status, message].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  if (messages.length) return messages.join("\n");
  return extractText(item.output ?? item.result ?? item.error);
}

function codexParticipantState(status: string, tool: string): string {
  const normalized = status.trim().toLowerCase();
  if (/fail|error/.test(normalized)) return "failed";
  if (/cancel/.test(normalized)) return "canceled";
  if (/complete|done|success/.test(normalized)) return "completed";
  if (normalized === "pending_init") return "running";
  if (tool === "spawn_agent") return "running";
  return "running";
}

function codexParticipantDetail(status: string, tool: string): string {
  const normalized = status.trim().toLowerCase();
  if (tool === "wait") return "Waiting for subagent result.";
  if (normalized === "pending_init") return "Running in background.";
  if (tool === "spawn_agent") return "Running in background.";
  return status ? humanizeToolName(status) : "Subagent started.";
}

function codexParticipantTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\bRead-only investigation only\.?\s*/i, "")
    .replace(/\bDo not modify files\.?\s*/i, "")
    .replace(/\bIn\s+\/[^\s,]+(?:,\s*)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0]?.trim();
  return sentence ? sentence.replace(/^\w/, (letter) => letter.toUpperCase()) : "Subagent";
}

function codexMcpToolSummary(item: Record<string, any>): CodexToolSummary {
  const rawName = stringValue(item.tool || item.name || item.tool_name || item.server);
  const args = asObject(item.arguments ?? item.input ?? item.args);
  const toolName = rawName || "tool";
  const lower = toolName.toLowerCase();
  const input = { tool: toolName, ...args };

  if (/\b(search|grep|query)\b/.test(lower) || /search|grep|query/.test(lower)) {
    return { name: "Search", input };
  }
  if (/fetch[_-]?file|fetchfile|read|get[_-]?file|contents?|blob|readme/.test(lower)) {
    return { name: "Read", input };
  }
  if (/list|tree|branches|repositories|files|paths/.test(lower)) {
    return { name: "List", input };
  }
  if (/create|update|delete|edit|patch|write/.test(lower)) {
    return { name: "Edit", input };
  }

  return { name: humanizeToolName(toolName), input };
}

function codexMcpActivitySignal(tool: CodexToolSummary): string {
  const path = stringValue(tool.input.path || tool.input.file || tool.input.repository_full_name);
  if (tool.name === "Read") {
    return path
      ? `Reading ${path} through a connector to verify the answer from source evidence.`
      : "Reading source evidence through a connector before answering.";
  }
  if (tool.name === "Search") {
    return "Searching through a connector to find the evidence needed for the answer.";
  }
  if (tool.name === "List") {
    return "Listing repository metadata through a connector to choose the next evidence source.";
  }
  return "";
}

function humanizeToolName(value: string): string {
  return value
    .replace(/^mcp[_-]/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool";
}

function codexCommandSummary(command: string, fallbackInput?: unknown): CodexCommandSummary {
  const normalized = command.trim().replace(/\s+/g, " ");
  const inner = unwrapShellCommand(normalized);
  const query = searchQueryFromCommand(inner);
  if (query !== null) {
    return {
      name: "Search",
      kind: "search",
      query,
      input: { command: inner, ...(query ? { query } : {}) },
    };
  }

  const readPath = readPathFromCommand(inner);
  if (readPath) {
    return {
      name: "Read",
      kind: "read",
      path: readPath,
      input: { command: inner, path: readPath },
    };
  }

  const listPath = listPathFromCommand(inner);
  if (listPath !== null) {
    return {
      name: "List",
      kind: "list",
      path: listPath,
      input: { command: inner, ...(listPath ? { path: listPath } : {}) },
    };
  }

  if (normalized) {
    return {
      name: "Command",
      kind: "command",
      input: { command: inner || normalized },
    };
  }

  const input = asObject(fallbackInput);
  return {
    name: "Command",
    kind: "command",
    input: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, stringValue(value)])),
  };
}

function codexCommandActivitySignal(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const inner = unwrapShellCommand(normalized);
  const display = compactCommand(inner);
  const summary = codexCommandSummary(command);

  if (summary.kind === "search") {
    return summary.query
      ? `Searching the repository for "${summary.query}" to find the code paths that can answer the question.`
      : "Searching the repository to find relevant code paths before answering.";
  }

  if (summary.kind === "read") {
    return `Reading ${summary.path || "a source file"} to verify the behavior from source evidence.`;
  }

  if (summary.kind === "list") {
    return "Mapping the repository structure to choose the next evidence source.";
  }

  if (/\bgit\s+(?:status|diff|show|log|rev-parse|branch)\b/.test(inner)) {
    return "Inspecting git state or history to understand the current workspace context.";
  }

  if (/\b(?:curl|wget)\b/.test(inner)) {
    return "Checking a local or remote endpoint to verify runtime behavior.";
  }

  if (/\b(?:bun|npm|pnpm|yarn|cargo|go|pytest|python|node)\s+(?:test|run|check|build|tsc|vite|lint)\b/.test(inner)) {
    return "Running a verification command to check whether the implementation still holds.";
  }

  return `Running a shell command to gather evidence: ${display}.`;
}

function unwrapShellCommand(command: string): string {
  const shell = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (shell) return shell[2].trim();
  const unquoted = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/);
  return unquoted ? unquoted[1].trim() : command;
}

function compactCommand(command: string): string {
  const compact = command.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function searchQueryFromCommand(command: string): string | null {
  if (!/\b(?:rg|grep)\b/.test(command)) return null;
  const tokens = shellWords(command);
  if (tokens.includes("--files")) return null;
  const toolIndex = tokens.findIndex((token) => token === "rg" || token === "grep");
  if (toolIndex < 0) return "";
  const optionsWithValues = new Set([
    "-A",
    "-B",
    "-C",
    "-e",
    "-g",
    "-m",
    "-t",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--max-count",
    "--regexp",
    "--type",
  ]);
  for (let index = toolIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    if (token.startsWith("-")) {
      if (optionsWithValues.has(token) && index + 1 < tokens.length) index += 1;
      continue;
    }
    return token.trim();
  }
  return "";
}

function readPathFromCommand(command: string): string {
  const match = command.match(/\b(?:sed|nl|cat|bat|head|tail)\b[\s\S]*?\s([A-Za-z0-9_@./:+-]+\.(?:ts|tsx|js|jsx|json|md|mdx|py|go|rs|java|css|html|yml|yaml|toml|sh|mjs|cjs|mts|cts))/);
  return match?.[1]?.trim() || "";
}

function listPathFromCommand(command: string): string | null {
  if (/\brg\b/.test(command) && shellWords(command).includes("--files")) return "";
  if (!/\b(?:find|fd|ls|tree)\b/.test(command)) return null;
  const match = command.match(/\b(?:find|fd|ls|tree)\b(?:\s+--?[A-Za-z0-9-]+(?:\s+\S+)?)?\s+([A-Za-z0-9_@./:+-]+)/);
  return match?.[1]?.trim() || "";
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    words.push((match[1] || match[2] || match[3] || "").replace(/\\(["'\\])/g, "$1"));
  }
  return words;
}

export function claudeJsonToEvents(raw: unknown, state: ClaudeParserState = createClaudeParserState()): LocalCliEvent[] {
  const event = asObject(raw);
  const type = stringValue(event.type);
  const out: LocalCliEvent[] = [];

  if (type === "system") {
    const subtype = stringValue(event.subtype);
    const model = stringValue(event.model);
    const sessionId = stringValue(event.session_id ?? event.sessionId);
    const status = stringValue(event.status);

    if (subtype === "hook_started") {
      const hookName = stringValue(event.hook_name ?? event.hook ?? event.hook_event);
      out.push({
        type: "status",
        label: "claude-startup",
        phase: "claude-startup",
        message: hookName ? `Claude Code startup hook: ${hookName}.` : "Claude Code startup hook running.",
        sessionId,
      });
      return out;
    }

    if (subtype === "task_started") {
      const toolUseId = stringValue(event.tool_use_id ?? event.toolUseId);
      const taskId = stringValue(event.task_id ?? event.taskId) || toolUseId || crypto.randomUUID();
      const description = stringValue(event.description ?? event.summary);
      const agentType = stringValue(event.agent_type ?? event.agentType);
      const prompt = stringValue(event.prompt);
      if (toolUseId) {
        state.tasksByToolUseId.set(toolUseId, {
          id: taskId,
          toolUseId,
          description,
          agentType: agentType || undefined,
        });
      }
      out.push({
        type: "participant_status",
        id: taskId,
        role: "agent",
        state: "started",
        toolUseId,
        title: description || "Subagent",
        detail: description || "Subagent started.",
        agentType: agentType || undefined,
        prompt: prompt || undefined,
        sessionId,
      });
      return out;
    }

    if (subtype === "task_progress") {
      const toolUseId = stringValue(event.tool_use_id ?? event.toolUseId);
      const taskId = stringValue(event.task_id ?? event.taskId) || state.tasksByToolUseId.get(toolUseId)?.id || toolUseId || crypto.randomUUID();
      const previous = toolUseId ? state.tasksByToolUseId.get(toolUseId) : undefined;
      const usage = asObject(event.usage);
      out.push({
        type: "participant_status",
        id: taskId,
        role: "agent",
        state: "running",
        toolUseId,
        title: previous?.description || stringValue(event.summary) || stringValue(event.description) || "Subagent",
        detail: stringValue(event.description ?? event.summary),
        agentType: previous?.agentType,
        currentTool: stringValue(event.last_tool_name ?? event.lastToolName) || undefined,
        totalTokens: numberValue(usage.total_tokens ?? usage.totalTokens) || undefined,
        toolUses: numberValue(usage.tool_uses ?? usage.toolUses) || undefined,
        durationMs: numberValue(usage.duration_ms ?? usage.durationMs) || undefined,
        sessionId,
      });
      return out;
    }

    if (subtype === "task_notification" || subtype === "task_updated") {
      const toolUseId = stringValue(event.tool_use_id ?? event.toolUseId);
      const taskId = stringValue(event.task_id ?? event.taskId) || state.tasksByToolUseId.get(toolUseId)?.id || toolUseId || crypto.randomUUID();
      const previous = toolUseId ? state.tasksByToolUseId.get(toolUseId) : undefined;
      const usage = asObject(event.usage);
      const notificationStatus = stringValue(event.status) || "running";
      const stateLabel = /fail|error/i.test(notificationStatus)
        ? "failed"
        : /cancel/i.test(notificationStatus)
          ? "canceled"
          : /complete|done|success/i.test(notificationStatus)
            ? "completed"
            : notificationStatus;
      out.push({
        type: "participant_status",
        id: taskId,
        role: "agent",
        state: stateLabel,
        toolUseId,
        title: previous?.description || stringValue(event.summary) || "Subagent",
        detail: stringValue(event.summary ?? event.description),
        agentType: previous?.agentType,
        output: extractText(event.output),
        outputFile: stringValue(event.output_file ?? event.outputFile) || undefined,
        totalTokens: numberValue(usage.total_tokens ?? usage.totalTokens) || undefined,
        toolUses: numberValue(usage.tool_uses ?? usage.toolUses) || undefined,
        durationMs: numberValue(usage.duration_ms ?? usage.durationMs) || undefined,
        sessionId,
      });
      return out;
    }

    if (subtype === "init" || model || sessionId) {
      if (state.readyEmitted) return out;
      state.readyEmitted = true;
      out.push({
        type: "status",
        label: subtype || "system",
        message: model ? `Claude Code ready (${model}).` : "Claude Code ready.",
        model,
        sessionId,
      });
      return out;
    }

    if (status) {
      out.push({
        type: "status",
        label: status,
        message: claudeStatusMessage(status),
        model,
        sessionId,
      });
      return out;
    }

    return out;
  }

  if (type === "user") {
    const message = asObject(event.message);
    for (const content of arrayValue(message.content ?? event.content)) {
      const block = asObject(content);
      if (stringValue(block.type) !== "tool_result") continue;
      out.push(claudeToolResultEvent(block, event.tool_use_result, state, event));
    }
    return out;
  }

  if (type === "assistant" || type === "message") {
    const participant = claudeParticipantFromRawEvent(event, state);
    const message = asObject(event.message);
    for (const content of arrayValue(message.content ?? event.content)) {
      const block = asObject(content);
      const blockType = stringValue(block.type);
      if (blockType === "text") {
        const text = stringValue(block.text);
        emitClaudeTextSnapshot(state, out, text);
      } else if (blockType === "thinking") {
        const text = stringValue(block.thinking ?? block.text);
        out.push({ type: "thinking_start", label: "thinking" });
        if (text) out.push({ type: "thinking_delta", text });
      } else if (blockType === "tool_use") {
        const toolId = stringValue(block.id) || crypto.randomUUID();
        const toolName = stringValue(block.name) || "tool";
        const existing = state.activeTools.get(toolId);
        state.activeTools.set(toolId, {
          name: toolName,
          input: block.input,
          startedAt: existing?.startedAt ?? Date.now(),
          participant,
        });
        out.push({
          type: "tool_use",
          id: toolId,
          name: toolName,
          input: block.input,
          ...(participant ? { participant } : {}),
        });
        const taskEvent = claudeAgentToolParticipantEvent(toolId, toolName, block.input, state);
        if (taskEvent) out.push(taskEvent);
      } else if (blockType === "tool_result") {
        out.push(claudeToolResultEvent(block, undefined, state, event));
      }
    }
    return out;
  }

  if (type === "result") {
    const usage = asObject(event.usage);
    const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    out.push({
      type: "usage",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: numberValue(event.total_cost_usd ?? event.totalCostUsd),
      durationMs: numberValue(event.duration_ms ?? event.durationMs),
    });
    return out;
  }

  const streamEvent = asObject(event.type === "stream_event" ? event.event : event);
  const participant = claudeParticipantFromRawEvent(event, state);
  const streamType = stringValue(streamEvent.type);
  if (streamType === "message_start") {
    state.currentMessageText = "";
    state.currentMessageStreamedText = false;
    if (state.streamingEmitted) return out;
    state.streamingEmitted = true;
    const message = asObject(streamEvent.message);
    out.push({
      type: "status",
      label: "streaming",
      message: "Claude is responding.",
      model: stringValue(message.model),
    });
  } else if (streamType === "content_block_start") {
    const index = numberValue(streamEvent.index);
    const block = asObject(streamEvent.content_block);
    const blockType = stringValue(block.type);
    state.blocks.set(index, {
      type: blockType,
      id: stringValue(block.id),
      name: stringValue(block.name),
      input: "",
      participant,
    });
    if (blockType === "thinking") out.push({ type: "thinking_start", label: "thinking" });
    if (blockType === "tool_use") {
      const toolId = stringValue(block.id) || `claude-tool-${index}`;
      const toolName = stringValue(block.name) || "tool";
      state.activeTools.set(toolId, {
        name: toolName,
        input: block.input ?? {},
        startedAt: Date.now(),
        participant,
      });
      out.push({
        type: "tool_use",
        id: toolId,
        name: toolName,
        input: block.input ?? {},
        ...(participant ? { participant } : {}),
      });
    }
  } else if (streamType === "content_block_delta") {
    const index = numberValue(streamEvent.index);
    const block = state.blocks.get(index);
    const delta = asObject(streamEvent.delta);
    const deltaType = stringValue(delta.type);
    if (deltaType === "text_delta") {
      const text = stringValue(delta.text);
      if (text) {
        state.currentMessageText += text;
        state.currentMessageStreamedText = true;
        state.textStreamed = true;
        out.push({ type: "text_delta", text });
      }
    } else if (deltaType === "thinking_delta") {
      const text = stringValue(delta.thinking);
      if (text) out.push({ type: "thinking_delta", text });
    } else if (deltaType === "input_json_delta" && block?.type === "tool_use") {
      block.input += stringValue(delta.partial_json ?? delta.partialJson);
      if (!block.inputSignalEmitted) {
        block.inputSignalEmitted = true;
        const signal = claudeToolInputActivitySignal(block.name || "tool");
        if (signal) out.push({ type: "thinking_delta", text: signal });
      }
    }
  } else if (streamType === "content_block_stop") {
    const index = numberValue(streamEvent.index);
    const block = state.blocks.get(index);
    if (block?.type === "tool_use" && block.input.trim()) {
      const toolId = block.id || `claude-tool-${index}`;
      const toolName = block.name || "tool";
      const input = safeJson(block.input) ?? block.input;
      const existing = state.activeTools.get(toolId);
      state.activeTools.set(toolId, {
        name: toolName,
        input,
        startedAt: existing?.startedAt ?? Date.now(),
        participant: block.participant,
      });
      out.push({
        type: "tool_use",
        id: toolId,
        name: toolName,
        input,
        ...(block.participant ? { participant: block.participant } : {}),
      });
      const taskEvent = claudeAgentToolParticipantEvent(toolId, toolName, input, state);
      if (taskEvent) out.push(taskEvent);
    }
    state.blocks.delete(index);
  } else if (streamType === "message_delta") {
    const usage = asObject(asObject(streamEvent.usage).output_tokens ? streamEvent.usage : asObject(streamEvent.delta).usage);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    if (outputTokens) out.push({ type: "usage", outputTokens, totalTokens: outputTokens });
  }

  return out;
}

export function acpJsonToEvents(
  raw: unknown,
  state: AcpParserState = createAcpParserState(),
): LocalCliEvent[] {
  // Agentrove-quality stateful stream extraction (see src/acp/event-mapper.ts).
  return mapAcpMessageToEvents(raw, state);
}

export function grokJsonToEvents(raw: unknown): LocalCliEvent[] {
  const event = asObject(raw);
  const type = stringValue(event.type);
  const text = extractText(event.data ?? event.text ?? event.content);

  if (type === "thought") {
    return text ? [{ type: "thinking_delta", text }] : [{ type: "thinking_start", label: "thinking" }];
  }
  if (type === "text") {
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (type === "end") {
    return [{
      type: "status",
      label: "done",
      message: "Grok CLI finished.",
      sessionId: stringValue(event.sessionId ?? event.session_id),
    }];
  }
  if (type === "tool" || type === "tool_use") {
    return [{
      type: "tool_use",
      id: stringValue(event.id ?? event.toolUseId ?? event.tool_use_id) || crypto.randomUUID(),
      name: stringValue(event.name ?? event.toolName ?? event.tool_name) || "tool",
      input: event.input ?? event.data,
    }];
  }
  if (type === "tool_result" || type === "tool_result_delta") {
    return [{
      type: "tool_result",
      id: stringValue(event.id ?? event.toolUseId ?? event.tool_use_id) || crypto.randomUUID(),
      name: stringValue(event.name ?? event.toolName ?? event.tool_name) || undefined,
      output: extractText(event.output ?? event.data ?? event.content),
      isError: event.isError === true || event.is_error === true || stringValue(event.status) === "error",
    }];
  }
  return [];
}

function claudeStatusMessage(status: string): string {
  if (status === "requesting") return "Claude Code is requesting model output.";
  const label = humanizeToolName(status).toLowerCase();
  return label ? `Claude Code status: ${label}.` : "Claude Code status update.";
}

function claudeToolInputActivitySignal(name: string): string {
  const label = humanizeToolName(name || "tool");
  const lower = label.toLowerCase();
  if (lower === "read") return "Preparing a file read through Claude Code.";
  if (lower === "bash") return "Preparing a shell command through Claude Code.";
  if (lower === "grep" || lower === "glob" || lower === "search") {
    return "Preparing a repository search through Claude Code.";
  }
  if (lower === "edit" || lower === "write") return "Preparing a file edit through Claude Code.";
  return `Preparing ${label} tool input through Claude Code.`;
}

function isClaudeAgentTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "agent" || normalized === "task";
}

function claudeAgentToolParticipantEvent(
  toolUseId: string,
  toolName: string,
  input: unknown,
  state: ClaudeParserState,
): LocalCliEvent | null {
  if (!toolUseId || !isClaudeAgentTool(toolName)) return null;
  if (state.tasksByToolUseId.has(toolUseId)) {
    const task = state.tasksByToolUseId.get(toolUseId);
    const raw = asObject(input);
    const agentType = stringValue(raw.subagent_type ?? raw.agentType ?? raw.agent_type);
    if (task && agentType && !task.agentType) task.agentType = agentType;
    return null;
  }

  const raw = asObject(input);
  const description = stringValue(raw.description ?? raw.name ?? raw.title);
  const agentType = stringValue(raw.subagent_type ?? raw.agentType ?? raw.agent_type);
  const prompt = stringValue(raw.prompt);
  if (!description && !prompt) return null;
  state.tasksByToolUseId.set(toolUseId, {
    id: toolUseId,
    toolUseId,
    description: description || "Subagent",
    agentType: agentType || undefined,
  });
  return {
    type: "participant_status",
    id: toolUseId,
    role: "agent",
    state: "started",
    toolUseId,
    title: description || "Subagent",
    detail: description || "Subagent started.",
    name: toolName,
    agentType: agentType || undefined,
    prompt: prompt || undefined,
  };
}

function claudeParentToolUseId(event: Record<string, any>): string {
  return stringValue(event.parent_tool_use_id ?? event.parentToolUseId);
}

function claudeParticipantForToolUseId(
  toolUseId: string,
  state: ClaudeParserState,
): LocalCliParticipant | undefined {
  if (!toolUseId) return undefined;
  const task = state.tasksByToolUseId.get(toolUseId);
  if (task) {
    return {
      id: task.id,
      role: "agent",
      toolUseId: task.toolUseId,
      title: task.description || "Subagent",
      ...(task.agentType ? { name: task.agentType } : {}),
    };
  }
  // Only a `parent_tool_use_id` that was registered by a `task_started` event is
  // a real Task sub-agent. A bare/unregistered id belongs to the MAIN agent
  // (its own Bash/Read tool calls carry a parent id too) — attributing those to a
  // synthetic "Subagent" participant spawned phantom rows in the Agents panel.
  return undefined;
}

function claudeParticipantFromRawEvent(
  event: Record<string, any>,
  state: ClaudeParserState,
): LocalCliParticipant | undefined {
  return claudeParticipantForToolUseId(claudeParentToolUseId(event), state);
}

function claudeParticipantForToolResult(
  block: Record<string, any>,
  event: Record<string, any>,
  state: ClaudeParserState,
): LocalCliParticipant | undefined {
  const parent = claudeParticipantFromRawEvent(event, state);
  if (parent) return parent;
  const explicitId = stringValue(block.tool_use_id ?? block.toolUseId ?? block.id);
  return claudeParticipantForToolUseId(explicitId, state);
}

function claudeToolResultEvent(
  block: Record<string, any>,
  rawResult: unknown,
  state: ClaudeParserState,
  rawEvent: Record<string, any> = {},
): LocalCliEvent {
  const explicitId = stringValue(block.tool_use_id ?? block.toolUseId ?? block.id);
  const id = explicitId || (state.activeTools.size === 1 ? [...state.activeTools.keys()][0] : crypto.randomUUID());
  const active = state.activeTools.get(id);
  const participant = active?.participant || claudeParticipantForToolResult(block, rawEvent, state);
  const output = extractText(block.content) || extractClaudeToolUseResult(rawResult);
  const isError = claudeToolResultIsError(block, rawResult);
  if (id) state.activeTools.delete(id);
  return {
    type: "tool_result",
    id,
    name: active?.name || stringValue(block.name) || stringValue(asObject(rawResult).name) || undefined,
    output,
    isError,
    durationMs: active ? Math.max(0, Date.now() - active.startedAt) : undefined,
    ...(participant ? { participant } : {}),
  };
}

function extractClaudeToolUseResult(rawResult: unknown): string {
  const result = asObject(rawResult);
  const direct = extractText(result.content ?? result.output ?? result.stdout ?? result.stderr ?? result.text);
  if (direct) return direct;
  const file = asObject(result.file);
  if (typeof file.content === "string") return file.content;
  if (typeof result.error === "string") return result.error;
  if (typeof result.message === "string") return result.message;
  return extractText(rawResult);
}

function claudeToolResultIsError(block: Record<string, any>, rawResult: unknown): boolean {
  const result = asObject(rawResult);
  const status = stringValue(block.status ?? result.status).toLowerCase();
  return (
    block.is_error === true ||
    block.isError === true ||
    result.is_error === true ||
    result.isError === true ||
    stringValue(result.type).toLowerCase() === "error" ||
    status === "failed" ||
    status === "error"
  );
}

function emitClaudeTextSnapshot(state: ClaudeParserState, out: LocalCliEvent[], text: string): void {
  if (!text) return;

  if (state.currentMessageText && text.startsWith(state.currentMessageText)) {
    const delta = text.slice(state.currentMessageText.length);
    state.currentMessageText = text;
    if (delta) out.push({ type: "text_delta", text: delta });
    return;
  }

  if (state.currentMessageStreamedText) {
    return;
  }

  if (text === state.currentMessageText) {
    return;
  }

  state.currentMessageText = text;
  state.textStreamed = true;
  out.push({ type: "text_delta", text });
}

function emitPiTextSnapshot(state: PiParserState, out: LocalCliEvent[], text: string): void {
  if (!text) return;

  if (state.currentMessageText && text.startsWith(state.currentMessageText)) {
    const delta = text.slice(state.currentMessageText.length);
    state.currentMessageText = text;
    if (delta) out.push({ type: "text_delta", text: delta });
    return;
  }

  if (state.currentMessageStreamedText) {
    return;
  }

  if (text === state.currentMessageText) {
    return;
  }

  state.currentMessageText = text;
  out.push({ type: "text_delta", text });
}

function extractAssistantText(message: Record<string, any>): string {
  return arrayValue(message.content)
    .map((block) => {
      const item = asObject(block);
      return stringValue(item.type) === "text" ? stringValue(item.text) : "";
    })
    .filter(Boolean)
    .join("");
}

export function extractAnswer(text: string): string {
  const answer = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i);
  const raw = answer ? answer[1] : text;
  return collapseRepeatedFinalAnswer(raw
    .replace(/```(?:js|javascript|ts|typescript)\s*SUBMIT\s*\([\s\S]*?```/gi, "")
    .trim());
}

/**
 * Pull a JSON decision object out of an agent's raw (often chatty) text.
 *
 * Mirrors {@link extractAnswer}: tolerates prose surrounding the JSON, prefers a
 * fenced ```json block, then falls back to the first balanced `{...}` object.
 * Returns the parsed object, or `null` when no parseable object is present.
 *
 * Used by sourceless routing (POST /api/route) to recover the routing contract
 * even when the CLI agent wraps it in commentary.
 */
export function extractDecision(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim()) return null;

  // 1. Strip an <ANSWER> wrapper if the agent used the answer convention.
  const answer = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i);
  const body = answer ? answer[1] : text;

  // 2. Prefer the contents of a fenced code block (```json … ``` or bare ``` … ```).
  const fences = [...body.matchAll(/```(?:json|jsonc)?\s*([\s\S]*?)```/gi)];
  for (const fence of fences) {
    const parsed = parseFirstJsonObject(fence[1]);
    if (parsed) return parsed;
  }

  // 3. Fall back to scanning the whole text for the first balanced object.
  return parseFirstJsonObject(body);
}

/**
 * Find and parse the first balanced top-level `{...}` JSON object in a string,
 * ignoring braces that appear inside string literals. Returns null on failure.
 */
function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          const parsed = safeJson(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
          break; // unbalanced/garbage object — try the next "{".
        }
      }
    }
  }
  return null;
}

function collapseRepeatedFinalAnswer(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 400) return trimmed;

  const midpoint = Math.floor(trimmed.length / 2);
  const window = Math.min(120, midpoint);
  for (let pivot = midpoint - window; pivot <= midpoint + window; pivot++) {
    const left = trimmed.slice(0, pivot).trim();
    const right = trimmed.slice(pivot).trim();
    if (left.length >= 200 && left === right) return left;
  }
  return trimmed;
}

export function extractSources(text: string): string[] {
  const sources = new Set<string>();
  const submit = text.match(/SUBMIT\s*\(\s*\{[\s\S]*?sources\s*:\s*(\[[\s\S]*?\])[\s\S]*?\}\s*\)/);
  if (submit) {
    try {
      const parsed = JSON.parse(submit[1]);
      if (Array.isArray(parsed)) parsed.map(String).filter(Boolean).forEach((source) => sources.add(source));
    } catch {
      // Ignore malformed legacy telemetry.
    }
  }
  for (const match of text.matchAll(/\[([A-Za-z0-9_./@:+ -]+\.[A-Za-z0-9]+(?::\d+(?:[-–]\d+)?)?)\]\(\)/g)) {
    sources.add(match[1].trim());
  }
  return [...sources];
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  const obj = asObject(value);
  if (Array.isArray(obj.content)) return obj.content.map(extractText).filter(Boolean).join("\n");
  if (Array.isArray(obj.Content)) return obj.Content.map(extractText).filter(Boolean).join("\n");
  const content = asObject(obj.Content ?? obj.content);
  if (typeof content.content === "string") return content.content;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.stdout)) return byteArrayToText(obj.stdout);
  if (Array.isArray(obj.stderr)) return byteArrayToText(obj.stderr);
  return "";
}

function byteArrayToText(value: unknown[]): string {
  if (!value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
    return "";
  }
  return new TextDecoder().decode(Uint8Array.from(value as number[]));
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
