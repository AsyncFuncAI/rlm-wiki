import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
  GROK_CLI_MODELS,
  PI_READONLY_TOOLS,
  PI_WRITE_TOOLS,
  isLocalCliReadOnlyContext,
  modelsForLocalCliAgent,
  piToolsForContext,
} from "./local-cli-agent-policy.ts";

describe("local-cli-agent-policy (single source of truth)", () => {
  test("Codex family and Claude family share model catalogs across agents", () => {
    expect(modelsForLocalCliAgent("codex")).toEqual([...CODEX_CLI_MODELS]);
    expect(modelsForLocalCliAgent("pi-codex")).toEqual([...CODEX_CLI_MODELS]);
    expect(modelsForLocalCliAgent("claude")).toEqual([...CLAUDE_CLI_MODELS]);
    expect(modelsForLocalCliAgent("pi-claude")).toEqual([...CLAUDE_CLI_MODELS]);
    expect(modelsForLocalCliAgent("grok")).toEqual([...GROK_CLI_MODELS]);
  });

  test("Pi tools always include bash so code-graph curl works", () => {
    expect(PI_READONLY_TOOLS.split(",")).toContain("bash");
    expect(PI_WRITE_TOOLS.split(",")).toContain("bash");
    expect(piToolsForContext("ask")).toBe(PI_READONLY_TOOLS);
    expect(piToolsForContext("chat")).toBe(PI_READONLY_TOOLS);
    expect(piToolsForContext("wiki-slides")).toBe(PI_READONLY_TOOLS);
    expect(piToolsForContext("wiki-page")).toBe(PI_WRITE_TOOLS);
    expect(piToolsForContext("wiki-structure")).toBe(PI_WRITE_TOOLS);
    // Write tools must not appear in read-only Ask.
    expect(piToolsForContext("ask").split(",")).not.toContain("edit");
    expect(piToolsForContext("ask").split(",")).not.toContain("write");
  });

  test("read-only contexts are shared (Ask/chat/slides)", () => {
    expect(isLocalCliReadOnlyContext("ask")).toBe(true);
    expect(isLocalCliReadOnlyContext("chat")).toBe(true);
    expect(isLocalCliReadOnlyContext("wiki-slides")).toBe(true);
    expect(isLocalCliReadOnlyContext("wiki-page")).toBe(false);
    expect(isLocalCliReadOnlyContext("wiki-structure")).toBe(false);
  });
});
