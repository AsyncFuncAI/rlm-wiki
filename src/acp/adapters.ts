/**
 * Per-agent ACP launch adapters (Agentrove adapters.py pattern).
 * Maps product agent ids → binary + CLI args + event-mapper kind.
 */
import type { LocalCliAgentId } from "../local-cli-events.ts";
import type { AcpAgentKind } from "./event-mapper.ts";

export type AcpLaunchConfig = {
  /** Product agent id. */
  agentId: LocalCliAgentId;
  /** Event mapper kind for meta-aware tool names. */
  agentKind: AcpAgentKind;
  /** Preferred ACP server binary names to search on PATH (first hit wins). */
  binCandidates: string[];
  /** CLI args after the binary (stdio server mode). */
  args: (opts: { model?: string; reasoning?: string; cwd: string }) => string[];
  /** Whether this agent is known to speak ACP stdio. */
  acpCapable: boolean;
  /** Auto-approve permissions on the host (desktop Ask v1). */
  autoApprovePermissions: boolean;
};

export const ACP_ADAPTERS: Record<LocalCliAgentId, AcpLaunchConfig> = {
  grok: {
    agentId: "grok",
    agentKind: "grok",
    binCandidates: ["grok"],
    acpCapable: true,
    autoApprovePermissions: true,
    args: ({ model, reasoning }) => {
      const cliArgs = ["agent", "--always-approve"];
      if (model && model !== "default") cliArgs.push("--model", model);
      if (reasoning && reasoning !== "default") cliArgs.push("--reasoning-effort", reasoning);
      cliArgs.push("stdio");
      return cliArgs;
    },
  },
  claude: {
    agentId: "claude",
    agentKind: "claude",
    // Prefer dedicated ACP server when installed; empty means not auto-ACP.
    binCandidates: ["claude-agent-acp", "claude-code-acp"],
    acpCapable: true,
    autoApprovePermissions: true,
    args: ({ model }) => {
      const cliArgs: string[] = [];
      if (model && model !== "default") cliArgs.push("--model", model);
      return cliArgs;
    },
  },
  codex: {
    agentId: "codex",
    agentKind: "codex",
    binCandidates: ["codex-acp"],
    acpCapable: true,
    autoApprovePermissions: true,
    args: ({ model, reasoning }) => {
      const cliArgs: string[] = [];
      if (model) cliArgs.push("--model", model);
      if (reasoning && reasoning !== "default") {
        // Codex ACP often encodes effort in model id; pass through when supported.
        cliArgs.push("--config", `model_reasoning_effort=${reasoning}`);
      }
      return cliArgs;
    },
  },
  "pi-codex": {
    agentId: "pi-codex",
    agentKind: "generic",
    binCandidates: [],
    acpCapable: false,
    autoApprovePermissions: true,
    args: () => [],
  },
  "pi-claude": {
    agentId: "pi-claude",
    agentKind: "generic",
    binCandidates: [],
    acpCapable: false,
    autoApprovePermissions: true,
    args: () => [],
  },
  antigravity: {
    agentId: "antigravity",
    agentKind: "generic",
    binCandidates: [],
    acpCapable: false,
    autoApprovePermissions: true,
    args: () => [],
  },
};

export function acpAdapterFor(agentId: LocalCliAgentId): AcpLaunchConfig {
  return ACP_ADAPTERS[agentId] || ACP_ADAPTERS.grok;
}

/** Env override: RLM_WIKI_ACP=0 disables ACP path; =1 forces try; unset = auto. */
export function acpTransportPreference(): "off" | "auto" | "force" {
  const raw = (process.env.RLM_WIKI_ACP || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "legacy") return "off";
  if (raw === "1" || raw === "true" || raw === "on" || raw === "force") return "force";
  return "auto";
}
