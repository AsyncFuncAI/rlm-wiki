/**
 * Agentrove-style ACP session/update → LocalCliEvent mapper.
 *
 * Goals (matched to agentrove backend/app/services/acp/client.py):
 * - Stateful tool tracking (_active_tools): start / progress / completed / failed
 * - Agent-aware tool names (Claude field_meta, Grok x.ai/tool, OpenCode title, else kind)
 * - Preserve diffs from early tool_call content when terminal updates only carry status
 * - Suppress noisy progress spam unless title/input actually changes
 * - Keep Grok subagent participant mapping
 *
 * Pure mapping only: no process I/O.
 */
import type { LocalCliEvent } from "../local-cli-events.ts";

export type AcpAgentKind = "grok" | "claude" | "codex" | "opencode" | "cursor" | "copilot" | "generic";

export type AcpActiveTool = {
  id: string;
  name: string;
  title?: string;
  status: "started" | "running" | "completed" | "failed" | string;
  parentId?: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  diffs?: Array<{ path?: string | null; oldText?: string | null; newText?: string | null }>;
  startedAt: number;
};

type ParticipantRecord = {
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

export interface AcpStreamState {
  agentKind: AcpAgentKind;
  /** Live tool payloads keyed by toolCallId (Agentrove _active_tools). */
  activeTools: Map<string, AcpActiveTool>;
  /** Back-compat name cache for older callers. */
  toolNames: Map<string, string>;
  pendingSubagentTools: Array<{
    id: string;
    description: string;
    agentType?: string;
    input?: unknown;
  }>;
  subagentToolsByKey: Map<string, string>;
  participantIdsBySessionId: Map<string, string>;
  participantsById: Map<string, ParticipantRecord>;
  sessionId?: string;
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
}

export function createAcpStreamState(agentKind: AcpAgentKind = "generic"): AcpStreamState {
  return {
    agentKind,
    activeTools: new Map(),
    toolNames: new Map(),
    pendingSubagentTools: [],
    subagentToolsByKey: new Map(),
    participantIdsBySessionId: new Map(),
    participantsById: new Map(),
  };
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fieldMeta(update: Record<string, any>): Record<string, any> {
  return asObject(update.fieldMeta ?? update.field_meta ?? update._meta ?? update.meta);
}

/**
 * Agent-aware tool identity (Agentrove _extract_tool_name).
 */
export function extractAcpToolName(
  update: Record<string, any>,
  agentKind: AcpAgentKind,
): string {
  const meta = fieldMeta(update);
  const claude = asObject(meta.claudeCode ?? meta.claude_code);
  if (claude.toolName || claude.tool_name) {
    return stringValue(claude.toolName ?? claude.tool_name);
  }
  if (agentKind === "opencode") {
    const title = stringValue(update.title);
    if (title) return title;
  }
  if (agentKind === "grok") {
    const xai = asObject(meta["x.ai/tool"] ?? meta["xai/tool"] ?? meta.xaiTool);
    if (xai.name) return stringValue(xai.name);
  }
  const kind = stringValue(update.kind ?? update.toolKind);
  if (kind) return kind;
  const title = stringValue(update.title ?? update.name);
  return title || "tool";
}

export function extractAcpParentToolId(update: Record<string, any>): string | undefined {
  const meta = fieldMeta(update);
  const claude = asObject(meta.claudeCode ?? meta.claude_code);
  const parent = stringValue(claude.parentToolUseId ?? claude.parent_tool_use_id);
  return parent || undefined;
}

function extractRawInput(raw: unknown): Record<string, unknown> | unknown {
  if (raw == null) return undefined;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through
  }
  return { raw: String(raw) };
}

function extractContentDiffs(update: Record<string, any>): AcpActiveTool["diffs"] {
  const content = Array.isArray(update.content) ? update.content : [];
  const diffs: NonNullable<AcpActiveTool["diffs"]> = [];
  for (const block of content) {
    const item = asObject(block);
    if (stringValue(item.type) !== "diff") continue;
    diffs.push({
      path: stringValue(item.path) || null,
      oldText: (item.oldText ?? item.old_text) as string | null | undefined,
      newText: (item.newText ?? item.new_text) as string | null | undefined,
    });
  }
  return diffs.length ? diffs : undefined;
}

function extractContentTexts(update: Record<string, any>): string[] {
  const content = Array.isArray(update.content) ? update.content : [];
  const texts: string[] = [];
  for (const block of content) {
    const item = asObject(block);
    const inner = asObject(item.content);
    if (stringValue(inner.type) === "text" && inner.text) texts.push(stringValue(inner.text));
    else if (stringValue(item.type) === "text" && item.text) texts.push(stringValue(item.text));
  }
  return texts;
}

function extractToolResult(update: Record<string, any>): unknown {
  const meta = fieldMeta(update);
  const claude = asObject(meta.claudeCode ?? meta.claude_code);
  if ("toolResponse" in claude || "tool_response" in claude) {
    return claude.toolResponse ?? claude.tool_response;
  }
  if (update.rawOutput != null || update.raw_output != null) {
    return update.rawOutput ?? update.raw_output;
  }
  const diffs = extractContentDiffs(update);
  if (diffs?.length) return { diffs };
  const texts = extractContentTexts(update);
  if (texts.length) return texts.join("\n");
  if (update.output != null) return update.output;
  return undefined;
}

function formatToolOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.length > 8000 ? `${value.slice(0, 7999)}…` : value;
  const obj = asObject(value);
  const content = asObject(obj.Content ?? obj.content);
  const text =
    stringValue(content.content) ||
    stringValue(obj.raw_output) ||
    stringValue(obj.output) ||
    stringValue(obj.text);
  if (text) return text.length > 8000 ? `${text.slice(0, 7999)}…` : text;
  if (Array.isArray(obj.diffs) && obj.diffs.length) {
    return obj.diffs
      .map((d: any) => {
        const path = stringValue(d.path) || "file";
        return `diff ${path}`;
      })
      .join("\n");
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 8000 ? `${json.slice(0, 7999)}…` : json;
  } catch {
    return String(value);
  }
}

function isGrokSubagentToolCall(name: string, input: unknown): boolean {
  const normalized = name.trim().toLowerCase();
  if (/^(?:agent|task|spawn_subagent|subagent|spawn agent)$/.test(normalized)) return true;
  const raw = asObject(input);
  return !!(raw.subagent_type || raw.agent_type || raw.agentType || raw.capability_mode);
}

function grokSubagentKey(description: string, agentType: string): string {
  const left = description.trim();
  const right = agentType.trim();
  return left || right ? `${left}\u0000${right}` : "";
}

function grokSubagentToolUseId(
  description: string,
  agentType: string,
  state: AcpStreamState,
): string {
  const key = grokSubagentKey(description, agentType);
  if (key) {
    const id = state.subagentToolsByKey.get(key);
    if (id) return id;
  }
  const index = state.pendingSubagentTools.findIndex((tool) => {
    if (description && tool.description === description) return true;
    return !!agentType && tool.agentType === agentType;
  });
  if (index >= 0) {
    const [tool] = state.pendingSubagentTools.splice(index, 1);
    return tool?.id || "";
  }
  return state.pendingSubagentTools.shift()?.id || "";
}

function grokParticipantState(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (/fail|error/.test(normalized)) return "failed";
  if (/cancel/.test(normalized)) return "canceled";
  if (/complete|done|success/.test(normalized)) return "completed";
  if (/start|spawn|pending/.test(normalized)) return "started";
  return normalized || "running";
}

/**
 * Map one ACP JSON-RPC message (notification or bare update) into LocalCliEvents.
 */
export function mapAcpMessageToEvents(
  raw: unknown,
  state: AcpStreamState = createAcpStreamState(),
): LocalCliEvent[] {
  const msg = asObject(raw);
  const method = stringValue(msg.method);
  // Bare session updates (already unwrapped) or full JSON-RPC notifications.
  if (method && method !== "session/update") return [];

  const params = asObject(msg.params ?? msg);
  const update = asObject(params.update ?? (method ? params : msg));
  if (!Object.keys(update).length && method !== "session/update") return [];

  const type = stringValue(update.sessionUpdate ?? update.type);
  const sessionId = stringValue(params.sessionId ?? params.session_id ?? update.sessionId);
  if (sessionId) state.sessionId = sessionId;

  if (type === "agent_thought_chunk") {
    const text = stringValue(
      asObject(update.content).text ?? update.text ?? update.content,
    );
    if (text) return [{ type: "thinking_delta", text }];
    return [{ type: "thinking_start", label: "thinking" }];
  }

  if (type === "agent_message_chunk" || type === "user_message_chunk") {
    const text = stringValue(
      asObject(update.content).text ?? update.text ?? update.content,
    );
    return text ? [{ type: "text_delta", text }] : [];
  }

  if (type === "usage_update" || type === "usage") {
    const used = numberValue(update.used ?? update.inputTokens ?? update.input_tokens);
    const size = numberValue(update.size ?? update.contextWindow ?? update.context_window);
    const cost = asObject(update.cost);
    const costUsd = numberValue(cost.amount ?? update.costUsd ?? update.cost_usd) || undefined;
    const outputTokens = numberValue(update.outputTokens ?? update.output_tokens) || undefined;
    state.lastUsage = {
      inputTokens: used || undefined,
      outputTokens,
      totalTokens: used + (outputTokens || 0) || undefined,
      costUsd,
    };
    return [{
      type: "usage",
      inputTokens: state.lastUsage.inputTokens,
      outputTokens: state.lastUsage.outputTokens,
      totalTokens: state.lastUsage.totalTokens,
      costUsd: state.lastUsage.costUsd,
    }];
  }

  if (type === "session_info_update" || type === "session_info") {
    return [{
      type: "status",
      label: "session",
      phase: "session",
      message: sessionId ? `ACP session ${sessionId}` : "ACP session update",
      sessionId: sessionId || state.sessionId,
    }];
  }

  if (type === "agent_plan_update" || type === "plan") {
    // Full plan replacement; surface as status detail for desktop timeline.
    const entries = Array.isArray(update.entries) ? update.entries : [];
    if (!entries.length) return [];
    const summary = entries
      .slice(0, 8)
      .map((entry: any) => {
        const e = asObject(entry);
        return `${stringValue(e.status) || "pending"}: ${stringValue(e.content)}`;
      })
      .filter((line: string) => line.length > 2)
      .join(" · ");
    return summary
      ? [{ type: "status", label: "plan", phase: "plan", message: summary }]
      : [];
  }

  if (type === "tool_call" || type === "tool_call_start") {
    return mapToolCallStart(update, state, sessionId);
  }

  if (type === "subagent_spawned") {
    const event = mapSubagentSpawned(update, params, state, sessionId);
    return event ? [event] : [];
  }

  if (type === "subagent_finished") {
    const event = mapSubagentFinished(update, state, sessionId);
    return event ? [event] : [];
  }

  if (type === "tool_call_update" || type === "tool_call_progress" || type === "tool_call_result") {
    return mapToolCallProgress(update, state, type);
  }

  return [];
}

function mapToolCallStart(
  update: Record<string, any>,
  state: AcpStreamState,
  sessionId: string,
): LocalCliEvent[] {
  const id =
    stringValue(update.toolCallId ?? update.tool_call_id ?? update.id) ||
    crypto.randomUUID();
  const rawInput = extractRawInput(update.rawInput ?? update.raw_input ?? update.input);
  let name = extractAcpToolName(update, state.agentKind);
  if (isGrokSubagentToolCall(name, rawInput)) name = "Agent";
  const title = stringValue(update.title) || name;
  const parentId = extractAcpParentToolId(update);
  const diffs = extractContentDiffs(update);
  const payload: AcpActiveTool = {
    id,
    name,
    title,
    status: "started",
    parentId,
    input: rawInput,
    diffs,
    startedAt: Date.now(),
  };
  if (diffs?.length) payload.result = { diffs };
  state.activeTools.set(id, payload);
  state.toolNames.set(id, name);

  if (name === "Agent") {
    const input = asObject(rawInput);
    const description = stringValue(input.description ?? input.prompt ?? input.name);
    const agentType = stringValue(
      input.subagent_type ?? input.agentType ?? input.agent_type ?? input.role,
    );
    state.pendingSubagentTools.push({
      id,
      description,
      agentType: agentType || undefined,
      input: rawInput,
    });
    const key = grokSubagentKey(description, agentType);
    if (key) state.subagentToolsByKey.set(key, id);
    const record: ParticipantRecord = {
      id,
      role: "agent",
      parentId: sessionId || undefined,
      toolUseId: id,
      title: description || "Subagent",
      name: agentType || undefined,
      agentType: agentType || undefined,
      prompt: stringValue(input.prompt) || undefined,
      sessionId: id,
    };
    state.participantsById.set(id, record);
    return [
      { type: "tool_use", id, name, input: rawInput },
      {
        type: "participant_status",
        id,
        role: "agent",
        state: "running",
        parentId: record.parentId,
        toolUseId: id,
        title: record.title,
        detail: "Running in background.",
        name: record.name,
        agentType: record.agentType,
        prompt: record.prompt,
        sessionId: record.sessionId,
      },
    ];
  }

  return [{
    type: "tool_use",
    id,
    name,
    input: rawInput,
    ...(parentId ? { participant: { id: parentId, role: "tool" as const, toolUseId: parentId } } : {}),
  }];
}

function mapToolCallProgress(
  update: Record<string, any>,
  state: AcpStreamState,
  type: string,
): LocalCliEvent[] {
  const id =
    stringValue(update.toolCallId ?? update.tool_call_id ?? update.id) ||
    crypto.randomUUID();
  const status = stringValue(update.status).toLowerCase();
  let existing = state.activeTools.get(id);

  // Terminal update with no prior start and no status → ignore (Agentrove).
  if (!existing && !status && type !== "tool_call_result") return [];

  if (!existing) {
    const name =
      state.toolNames.get(id) ||
      extractAcpToolName(update, state.agentKind) ||
      "tool";
    existing = {
      id,
      name,
      title: stringValue(update.title) || name,
      status: "started",
      parentId: extractAcpParentToolId(update),
      input: extractRawInput(update.rawInput ?? update.raw_input ?? update.input),
      startedAt: Date.now(),
    };
    state.activeTools.set(id, existing);
    state.toolNames.set(id, name);
  }

  let changed = false;
  if (update.title != null) {
    const title = stringValue(update.title);
    if (title && title !== existing.title) {
      existing.title = title;
      changed = true;
    }
  }
  if (update.rawInput != null || update.raw_input != null || update.input != null) {
    const nextInput = extractRawInput(update.rawInput ?? update.raw_input ?? update.input);
    if (JSON.stringify(nextInput) !== JSON.stringify(existing.input)) {
      existing.input = nextInput;
      changed = true;
    }
  }
  // Prefer better names as meta arrives (Grok often fills x.ai/tool on later updates).
  // Only upgrade from structured sources (kind / field_meta), never from human title labels.
  const meta = fieldMeta(update);
  const claudeName = stringValue(
    asObject(meta.claudeCode ?? meta.claude_code).toolName ??
      asObject(meta.claudeCode ?? meta.claude_code).tool_name,
  );
  const grokName = stringValue(
    asObject(meta["x.ai/tool"] ?? meta["xai/tool"] ?? meta.xaiTool).name,
  );
  const kindName = stringValue(update.kind ?? update.toolKind);
  const refinedName = claudeName || (state.agentKind === "grok" ? grokName : "") || kindName;
  if (
    refinedName &&
    refinedName !== "tool" &&
    refinedName !== existing.name &&
    !isGrokSubagentToolCall(refinedName, existing.input)
  ) {
    existing.name = refinedName;
    state.toolNames.set(id, refinedName);
    changed = true;
  }

  const diffs = extractContentDiffs(update);
  if (diffs?.length) {
    existing.diffs = [...(existing.diffs || []), ...diffs];
    existing.result = { diffs: existing.diffs };
    changed = true;
  }

  if (status === "completed" || (type === "tool_call_result" && status !== "failed")) {
    state.activeTools.delete(id);
    existing.status = "completed";
    const result = extractToolResult(update);
    if (result !== undefined || existing.result === undefined) {
      existing.result = result !== undefined ? result : existing.result;
    }
    const durationMs = Math.max(0, Date.now() - existing.startedAt);
    return [{
      type: "tool_result",
      id,
      name: existing.name,
      output: formatToolOutput(existing.result),
      isError: false,
      ...(durationMs > 0 ? { durationMs } : {}),
    }];
  }

  if (status === "failed") {
    state.activeTools.delete(id);
    existing.status = "failed";
    existing.error =
      formatToolOutput(extractToolResult(update)) ||
      stringValue(update.error) ||
      "Tool failed";
    const durationMs = Math.max(0, Date.now() - existing.startedAt);
    return [{
      type: "tool_result",
      id,
      name: existing.name,
      output: existing.error,
      isError: true,
      ...(durationMs > 0 ? { durationMs } : {}),
    }];
  }

  state.activeTools.set(id, existing);

  // In-progress: re-emit tool_use when title/input/name changed so UI can refresh
  // the loading row (Agentrove re-emits tool_started). Avoid spam status on every tick.
  if (changed) {
    return [{
      type: "tool_use",
      id,
      name: existing.name,
      input: existing.input,
    }];
  }

  // First progress without prior change still gets a light status so timelines
  // that only listen for status keep working.
  if (status && status !== "started") {
    return [{
      type: "status",
      label: status,
      phase: "tool",
      message: `${existing.name} ${status}.`,
    }];
  }
  return [];
}

function mapSubagentSpawned(
  update: Record<string, any>,
  params: Record<string, any>,
  state: AcpStreamState,
  fallbackSessionId = "",
): LocalCliEvent | null {
  const id = stringValue(
    update.subagent_id ?? update.subagentId ?? update.child_session_id ?? update.childSessionId,
  );
  if (!id) return null;
  const description = stringValue(update.description ?? update.prompt ?? update.title);
  const agentType = stringValue(
    update.subagent_type ?? update.subagentType ?? update.role ?? update.agent_type ?? update.agentType,
  );
  const toolUseId = grokSubagentToolUseId(description, agentType, state);
  const participantId = toolUseId || id;
  const parentId = stringValue(
    update.parent_session_id ?? update.parentSessionId ?? params.sessionId ?? params.session_id,
  );
  const previous = state.participantsById.get(participantId) || state.participantsById.get(id);
  const childSessionId =
    stringValue(update.child_session_id ?? update.childSessionId) ||
    fallbackSessionId ||
    id;
  if (childSessionId) state.participantIdsBySessionId.set(childSessionId, participantId);
  state.participantIdsBySessionId.set(id, participantId);
  const title = description || previous?.title || "Subagent";
  const record: ParticipantRecord = {
    id: participantId,
    role: "agent",
    parentId: parentId || previous?.parentId || undefined,
    toolUseId: toolUseId || previous?.toolUseId,
    title,
    name: agentType || previous?.name || undefined,
    agentType: agentType || previous?.agentType || undefined,
    prompt: stringValue(update.prompt) || previous?.prompt || undefined,
    sessionId: childSessionId,
  };
  state.participantsById.set(participantId, record);
  return {
    type: "participant_status",
    id: participantId,
    role: "agent",
    state: "running",
    parentId: record.parentId,
    toolUseId: record.toolUseId,
    title,
    detail: "Running in background.",
    name: record.name,
    agentType: record.agentType,
    prompt: record.prompt,
    sessionId: record.sessionId,
  };
}

function mapSubagentFinished(
  update: Record<string, any>,
  state: AcpStreamState,
  fallbackSessionId = "",
): LocalCliEvent | null {
  const id = stringValue(
    update.subagent_id ?? update.subagentId ?? update.child_session_id ?? update.childSessionId,
  );
  if (!id) return null;
  const participantId = state.participantIdsBySessionId.get(id) || id;
  const previous = state.participantsById.get(participantId) || state.participantsById.get(id);
  const rawStatus = stringValue(update.status) || "completed";
  const participantState = grokParticipantState(rawStatus);
  return {
    type: "participant_status",
    id: participantId,
    role: "agent",
    state: participantState,
    parentId: previous?.parentId,
    toolUseId: previous?.toolUseId,
    title: previous?.title || stringValue(update.description) || "Subagent",
    detail: participantState === "completed" ? "" : rawStatus,
    name: previous?.name,
    agentType: previous?.agentType,
    prompt: previous?.prompt,
    output: formatToolOutput(update.output),
    totalTokens: numberValue(update.total_tokens ?? update.totalTokens) || undefined,
    toolUses:
      numberValue(update.tool_calls ?? update.toolCalls ?? update.tool_uses ?? update.toolUses) ||
      undefined,
    durationMs: numberValue(update.duration_ms ?? update.durationMs) || undefined,
    sessionId:
      previous?.sessionId ||
      stringValue(update.child_session_id ?? update.childSessionId) ||
      fallbackSessionId ||
      id,
  };
}
