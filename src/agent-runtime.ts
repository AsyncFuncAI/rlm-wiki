export type AgentRuntime = "agent" | "rlm" | "local-cli";

export const DEFAULT_AGENT_RUNTIME: AgentRuntime = "agent";
export const DEFAULT_RLM_RUNTIME: AgentRuntime = "rlm";
export const DEFAULT_LOCAL_CLI_RUNTIME: AgentRuntime = "local-cli";

export function normalizeAgentRuntime(value: unknown, fallback: AgentRuntime = DEFAULT_AGENT_RUNTIME): AgentRuntime {
  if (value === "local-cli") return "local-cli";
  if (value === "rlm") return "rlm";
  if (value === "agent") return "agent";
  return fallback;
}

export function runtimeLabel(runtime: AgentRuntime): string {
  if (runtime === "local-cli") return "Local CLI";
  return runtime === "rlm" ? "RLM" : "Agent";
}
