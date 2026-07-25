export type LocalCliAgentId = "codex" | "claude" | "grok" | "pi-codex" | "pi-claude" | "antigravity";

export type LocalCliReasoning = "default" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface LocalCliConfig {
  agentId: LocalCliAgentId;
  model?: string;
  reasoning?: LocalCliReasoning | string;
}

export interface LocalCliToolUse {
  id: string;
  name: string;
  input?: unknown;
  participant?: LocalCliParticipant;
}

export interface LocalCliToolResult {
  id: string;
  name?: string;
  output?: string;
  isError?: boolean;
  durationMs?: number;
  participant?: LocalCliParticipant;
}

export interface LocalCliParticipant {
  id: string;
  role: "agent" | "tool" | "model";
  parentId?: string;
  toolUseId?: string;
  name?: string;
  title?: string;
}

export interface LocalCliParticipantStatus {
  id: string;
  role: "agent" | "tool" | "model";
  state: "started" | "running" | "completed" | "failed" | "canceled" | string;
  parentId?: string;
  toolUseId?: string;
  title?: string;
  detail?: string;
  name?: string;
  agentType?: string;
  currentTool?: string;
  prompt?: string;
  output?: string;
  outputFile?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  sessionId?: string;
}

export type LocalCliEvent =
  | { type: "status"; label?: string; message?: string; phase?: string; agentId?: string; model?: string; sessionId?: string; durationMs?: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_start"; label?: string }
  | { type: "thinking_delta"; text: string }
  | ({ type: "tool_use" } & LocalCliToolUse)
  | ({ type: "tool_result" } & LocalCliToolResult)
  | ({ type: "participant_status" } & LocalCliParticipantStatus)
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number; costUsd?: number; durationMs?: number }
  | { type: "error"; error: string; code?: string }
  | { type: "raw"; source: string; payload: unknown };

export interface LocalCliAgentStatus {
  id: LocalCliAgentId;
  name: string;
  bin: string;
  path: string | null;
  installed: boolean;
  runnable: boolean;
  version: string | null;
  authStatus: "ready" | "missing" | "unknown";
  models: string[];
  defaultModel: string;
  reasoningOptions: string[];
  setupHint?: string;
  error?: string;
}

export interface LocalCliRunMetadata {
  runId: string;
  workspacePath: string;
  baseHead: string;
  answer: string;
  sources: string[];
  rawText: string;
  artifacts?: LocalCliRunArtifact[];
}

export interface LocalCliRunArtifact {
  id: string;
  type: "workspace" | "patch" | "git_status" | "answer" | "sources";
  name: string;
  path?: string;
  content?: string;
  mediaType?: string;
  size?: number;
}

export const LOCAL_CLI_AGENT_IDS: LocalCliAgentId[] = ["grok", "codex", "claude", "pi-codex", "pi-claude", "antigravity"];

export const DEFAULT_LOCAL_CLI_CONFIG: LocalCliConfig = {
  agentId: "grok",
};

export function normalizeLocalCliAgentId(value: unknown): LocalCliAgentId {
  return value === "claude" || value === "grok" || value === "codex" || value === "pi-codex" || value === "pi-claude" || value === "antigravity" ? value : "grok";
}

export function normalizeLocalCliConfig(value: unknown): LocalCliConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const agentId = normalizeLocalCliAgentId(raw.agentId ?? raw.agent ?? raw.id);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  const reasoning = typeof raw.reasoning === "string" && raw.reasoning.trim() ? raw.reasoning.trim() : undefined;
  return { agentId, ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
}

export function localCliLabel(config: LocalCliConfig): string {
  const agent = config.agentId === "claude"
    ? "Claude Code"
    : config.agentId === "pi-codex"
    ? "Pi · Codex"
    : config.agentId === "pi-claude"
    ? "Pi · Claude Code"
    : config.agentId === "antigravity"
    ? "Antigravity CLI"
    : config.agentId === "grok"
    ? "Grok CLI"
    : "Codex CLI";
  return config.model ? `${agent} · ${config.model}` : agent;
}
