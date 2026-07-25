import { describe, expect, test } from "bun:test";
import {
  createAcpStreamState,
  extractAcpToolName,
  mapAcpMessageToEvents,
} from "./event-mapper.ts";

function sessionUpdate(update: Record<string, unknown>, sessionId = "s1") {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  };
}

describe("ACP event mapper (Agentrove-style)", () => {
  test("extracts Claude tool names from field_meta.claudeCode.toolName", () => {
    expect(
      extractAcpToolName(
        {
          title: "Reading file",
          kind: "read",
          fieldMeta: { claudeCode: { toolName: "Read" } },
        },
        "claude",
      ),
    ).toBe("Read");
  });

  test("extracts Grok tool names from x.ai/tool meta over rewritten titles", () => {
    expect(
      extractAcpToolName(
        {
          title: "Reading package.json",
          fieldMeta: { "x.ai/tool": { name: "read_file" } },
        },
        "grok",
      ),
    ).toBe("read_file");
  });

  test("tracks tool lifecycle statefully: start → progress title change → complete", () => {
    const state = createAcpStreamState("codex");
    const start = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        kind: "execute",
        title: "run tests",
        rawInput: { command: "bun test" },
      }),
      state,
    );
    expect(start).toEqual([{
      type: "tool_use",
      id: "t1",
      name: "execute",
      input: { command: "bun test" },
    }]);
    expect(state.activeTools.has("t1")).toBe(true);

    // No-op progress (same title/input) still emits a light status once.
    const running = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        title: "run tests",
      }),
      state,
    );
    expect(running[0]?.type).toBe("status");

    // Title change re-emits tool_use (Agentrove tool_started refresh).
    const refreshed = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
        title: "run tests (file 2/4)",
      }),
      state,
    );
    expect(refreshed).toEqual([{
      type: "tool_use",
      id: "t1",
      name: "execute",
      input: { command: "bun test" },
    }]);

    const done = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "ok",
      }),
      state,
    );
    expect(done[0]).toMatchObject({
      type: "tool_result",
      id: "t1",
      name: "execute",
      output: "ok",
      isError: false,
    });
    expect(state.activeTools.has("t1")).toBe(false);
  });

  test("preserves edit diffs from tool_call when terminal update only has status", () => {
    const state = createAcpStreamState("codex");
    mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        kind: "edit",
        title: "edit",
        content: [
          { type: "diff", path: "src/a.ts", oldText: "a", newText: "b" },
        ],
      }),
      state,
    );
    const done = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
      }),
      state,
    );
    expect(done[0]?.type).toBe("tool_result");
    expect(String((done[0] as any).output || "")).toContain("diff src/a.ts");
  });

  test("refines Grok tool name when meta arrives on later update", () => {
    const state = createAcpStreamState("grok");
    mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "g1",
        title: "Working…",
        rawInput: { path: "a.ts" },
      }),
      state,
    );
    const refined = mapAcpMessageToEvents(
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "g1",
        status: "in_progress",
        title: "Reading a.ts",
        fieldMeta: { "x.ai/tool": { name: "read_file" } },
      }),
      state,
    );
    expect(refined[0]).toMatchObject({
      type: "tool_use",
      id: "g1",
      name: "read_file",
    });
  });

  test("maps thought and message chunks without inventing empty text events", () => {
    const state = createAcpStreamState();
    expect(
      mapAcpMessageToEvents(
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
        state,
      ),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(
      mapAcpMessageToEvents(
        sessionUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        }),
        state,
      ),
    ).toEqual([{ type: "thinking_delta", text: "thinking" }]);
  });
});
