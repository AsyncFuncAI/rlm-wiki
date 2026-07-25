/**
 * Single source of truth for local-CLI agent product policy:
 * model chips, read-only contexts, and tool allowlists.
 *
 * Desktop UI and the local-cli sidecar both import this module so catalogs and
 * capability (including code-graph curl via bash) cannot drift by agent.
 */

import type { LocalCliAgentId } from "./local-cli-events.ts";
// type-only import: keeps the desktop bundle free of server event runtime code.

/** Ask / chat / slides must not mutate the workspace. */
export const LOCAL_CLI_READ_ONLY_CONTEXTS = new Set([
  "ask",
  "chat",
  "wiki-slides",
]);

/** Surfaces Pi is allowed to run. */
export const PI_SUPPORTED_CONTEXTS = new Set([
  "ask",
  "chat",
  "wiki-structure",
  "wiki-page",
  "wiki-slides",
]);

/**
 * Pi built-in tools (from `pi --help`):
 * read, bash, edit, write, grep, find, ls
 *
 * bash is required for live code-graph use (curl against the KB HTTP API).
 * Without bash, Pi can only consume prefetched evidence in the prompt.
 */
export const PI_READONLY_TOOLS = "read,bash,grep,find,ls" as const;
export const PI_WRITE_TOOLS = "read,bash,edit,write,grep,find,ls" as const;

/** Product model chips — keep Pi · Codex / Pi · Claude locked to these. */
export const GROK_CLI_MODELS = ["default", "grok-4.5", "composer-2.5"] as const;

export const CODEX_CLI_MODELS = [
  "default",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
] as const;

export const CLAUDE_CLI_MODELS = [
  "default",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
] as const;

export type LocalCliModelCatalogId =
  | "grok"
  | "codex"
  | "claude"
  | "pi-codex"
  | "pi-claude"
  | "antigravity";

export function isLocalCliReadOnlyContext(contextLabel?: string | null): boolean {
  return LOCAL_CLI_READ_ONLY_CONTEXTS.has(String(contextLabel || ""));
}

export function isPiSupportedContext(contextLabel?: string | null): boolean {
  return PI_SUPPORTED_CONTEXTS.has(String(contextLabel || ""));
}

/**
 * Tool allowlist for Pi. Same capability story as Codex/Claude for code graph:
 * bash (curl) is always available; edit/write only when the context may mutate.
 */
export function piToolsForContext(contextLabel?: string | null): string {
  return isLocalCliReadOnlyContext(contextLabel) ? PI_READONLY_TOOLS : PI_WRITE_TOOLS;
}

/**
 * Codex sandbox for a context. workspace-write gets explicit network_access so
 * live code-graph curl works. read-only relies on Codex's default network
 * policy for that sandbox (prefetch still covers Ask when live curl is blocked).
 */
export function codexSandboxForContext(contextLabel?: string | null): {
  sandbox: "read-only" | "workspace-write";
  networkAccess: boolean;
} {
  const readOnly = isLocalCliReadOnlyContext(contextLabel);
  return {
    sandbox: readOnly ? "read-only" : "workspace-write",
    networkAccess: !readOnly,
  };
}

export function modelsForLocalCliAgent(agentId: LocalCliModelCatalogId | string): string[] {
  switch (agentId) {
    case "grok":
      return [...GROK_CLI_MODELS];
    case "codex":
    case "pi-codex":
      return [...CODEX_CLI_MODELS];
    case "claude":
    case "pi-claude":
      return [...CLAUDE_CLI_MODELS];
    case "antigravity":
      return ["default"];
    default:
      return ["default"];
  }
}

export function defaultModelForLocalCliAgent(agentId: LocalCliModelCatalogId | string): string {
  return modelsForLocalCliAgent(agentId)[0] || "default";
}

export function isPiAgentId(agentId: string | null | undefined): agentId is Extract<LocalCliAgentId, "pi-codex" | "pi-claude"> {
  return agentId === "pi-codex" || agentId === "pi-claude";
}
