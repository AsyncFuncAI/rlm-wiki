import { describe, expect, test } from "bun:test";
import {
  acpJsonToEvents,
  claudeJsonToEvents,
  codexJsonToEvents,
  createAcpParserState,
  createClaudeParserState,
  createCodexParserState,
  extractAnswer,
  extractSources,
  grokJsonToEvents,
} from "./local-cli-parsers.ts";
import { localCliAgentEnv } from "./local-cli-sidecar.ts";
import { openDesignAgentEvent } from "./server.ts";

describe("local CLI parser fixtures", () => {
  test("maps Codex JSON command and answer events", () => {
    const state = createCodexParserState();
    expect(codexJsonToEvents({ type: "turn.started" }, state)).toEqual([
      { type: "status", label: "running", message: "Codex is working." },
    ]);

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "rg local-cli src",
      },
    }, state)).toEqual([
      {
        type: "thinking_delta",
        text: 'Searching the repository for "local-cli" to find the code paths that can answer the question.',
      },
      { type: "tool_use", id: "cmd-1", name: "Search", input: { command: "rg local-cli src", query: "local-cli" } },
    ]);

    const result = codexJsonToEvents({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        aggregated_output: "src/local-cli-runtime.ts\n",
        exit_code: 0,
      },
    }, state);
    expect(result[0]).toMatchObject({
      type: "tool_result",
      id: "cmd-1",
      name: "Search",
      output: "src/local-cli-runtime.ts\n",
      isError: false,
    });

    expect(codexJsonToEvents({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "<ANSWER>Done</ANSWER>" },
    }, state)).toEqual([{ type: "text_delta", text: "<ANSWER>Done</ANSWER>" }]);
  });

  test("adds visible Codex activity signals for command-only runs", () => {
    const state = createCodexParserState();

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-read",
        type: "command_execution",
        command: "/bin/zsh -lc 'nl -ba src/server.ts | sed -n 1,80p'",
      },
    }, state)[0]).toEqual({
      type: "thinking_delta",
      text: "Reading src/server.ts to verify the behavior from source evidence.",
    });

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-test",
        type: "command_execution",
        command: "bun test src/local-cli-parsers.test.ts",
      },
    }, state)[0]).toEqual({
      type: "thinking_delta",
      text: "Running a verification command to check whether the implementation still holds.",
    });
  });

  test("classifies Codex command executions for transcript rollups", () => {
    const state = createCodexParserState();

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-rg",
        type: "command_execution",
        command: "/bin/zsh -lc 'rg -n \"codexJsonToEvents\" src/local-cli-parsers.ts'",
      },
    }, state)[1]).toEqual({
      type: "tool_use",
      id: "cmd-rg",
      name: "Search",
      input: {
        command: 'rg -n "codexJsonToEvents" src/local-cli-parsers.ts',
        query: "codexJsonToEvents",
      },
    });

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-read",
        type: "command_execution",
        command: "/bin/zsh -lc 'nl -ba src/server.ts | sed -n 1,80p'",
      },
    }, state)[1]).toEqual({
      type: "tool_use",
      id: "cmd-read",
      name: "Read",
      input: {
        command: "nl -ba src/server.ts | sed -n 1,80p",
        path: "src/server.ts",
      },
    });

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-pwd",
        type: "command_execution",
        command: "/bin/zsh -lc pwd",
      },
    }, state)[1]).toEqual({
      type: "tool_use",
      id: "cmd-pwd",
      name: "Command",
      input: { command: "pwd" },
    });

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "cmd-files",
        type: "command_execution",
        command: "rg --files -g '*.ts'",
      },
    }, state)[1]).toEqual({
      type: "tool_use",
      id: "cmd-files",
      name: "List",
      input: { command: "rg --files -g '*.ts'" },
    });
  });

  test("maps Codex MCP tool calls into transcript activity", () => {
    const state = createCodexParserState();

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "codex_apps",
        tool: "github_fetch_file",
        arguments: {
          repository_full_name: "crynta/terax-ai",
          path: "README.md",
          ref: "main",
        },
      },
    }, state)).toEqual([
      {
        type: "thinking_delta",
        text: "Reading README.md through a connector to verify the answer from source evidence.",
      },
      {
        type: "tool_use",
        id: "mcp-1",
        name: "Read",
        input: {
          tool: "github_fetch_file",
          repository_full_name: "crynta/terax-ai",
          path: "README.md",
          ref: "main",
        },
      },
    ]);

    expect(codexJsonToEvents({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        status: "completed",
        result: { content: [{ type: "text", text: "README contents" }] },
      },
    }, state)[0]).toMatchObject({
      type: "tool_result",
      id: "mcp-1",
      name: "Read",
      output: "README contents",
      isError: false,
    });
  });

  test("maps Codex collab subagents into participant activity", () => {
    const state = createCodexParserState();

    expect(codexJsonToEvents({
      type: "thread.started",
      thread_id: "root-thread",
    }, state)[0]).toMatchObject({
      type: "status",
      sessionId: "root-thread",
    });

    expect(codexJsonToEvents({
      type: "item.started",
      item: {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        sender_thread_id: "root-thread",
        prompt: "Read-only investigation only. Do not modify files. In /tmp/repo, inspect README and package metadata.",
        receiver_thread_ids: [],
        agents_states: {},
        status: "in_progress",
      },
    }, state)).toEqual([{
      type: "tool_use",
      id: "spawn-1",
      name: "Agent",
      input: {
        tool: "spawn_agent",
        prompt: "Read-only investigation only. Do not modify files. In /tmp/repo, inspect README and package metadata.",
        sender_thread_id: "root-thread",
      },
    }]);

    expect(codexJsonToEvents({
      type: "item.completed",
      item: {
        id: "spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        sender_thread_id: "root-thread",
        receiver_thread_ids: ["child-thread"],
        prompt: "Read-only investigation only. Do not modify files. In /tmp/repo, inspect README and package metadata.",
        agents_states: {
          "child-thread": { status: "pending_init", message: null },
        },
        status: "completed",
      },
    }, state)).toEqual([
      {
        type: "tool_result",
        id: "spawn-1",
        name: "Agent",
        output: "child-thread: pending_init",
        isError: false,
        durationMs: expect.any(Number),
      },
      {
        type: "participant_status",
        id: "child-thread",
        role: "agent",
        state: "running",
        parentId: "root-thread",
        toolUseId: "spawn-1",
        title: "Inspect README and package metadata.",
        detail: "Running in background.",
        name: undefined,
        agentType: undefined,
        prompt: "Read-only investigation only. Do not modify files. In /tmp/repo, inspect README and package metadata.",
        output: undefined,
        sessionId: "child-thread",
      },
    ]);

    expect(codexJsonToEvents({
      type: "item.completed",
      item: {
        id: "wait-1",
        type: "collab_tool_call",
        tool: "wait",
        sender_thread_id: "root-thread",
        receiver_thread_ids: ["child-thread"],
        agents_states: {
          "child-thread": { status: "completed", message: "Read README.md and package.json." },
        },
        status: "completed",
      },
    }, state)).toEqual([
      {
        type: "tool_use",
        id: "wait-1",
        name: "Agent",
        input: {
          tool: "wait",
          sender_thread_id: "root-thread",
          receiver_thread_ids: ["child-thread"],
        },
      },
      {
        type: "tool_result",
        id: "wait-1",
        name: "Agent",
        output: "child-thread: completed: Read README.md and package.json.",
        isError: false,
        durationMs: undefined,
      },
      {
        type: "participant_status",
        id: "child-thread",
        role: "agent",
        state: "completed",
        parentId: "root-thread",
        toolUseId: "spawn-1",
        title: "Inspect README and package metadata.",
        detail: "",
        name: undefined,
        agentType: undefined,
        prompt: "Read-only investigation only. Do not modify files. In /tmp/repo, inspect README and package metadata.",
        output: "Read README.md and package.json.",
        sessionId: "child-thread",
      },
    ]);
  });

  test("maps Claude stream JSON text, thinking, tools, and usage", () => {
    const state = createClaudeParserState();
    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    }, state)).toEqual([{ type: "thinking_start", label: "thinking" }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting files." } },
    }, state)).toEqual([{ type: "thinking_delta", text: "Inspecting files." }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    }, state)).toEqual([{ type: "text_delta", text: "Hello" }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
      },
    }, state)).toEqual([{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" } },
    }, state)).toEqual([{ type: "thinking_delta", text: "Preparing a shell command through Claude Code." }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_stop", index: 2 },
    }, state)).toEqual([{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }]);

    const toolResult = claudeJsonToEvents({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: "tool-1", type: "tool_result", content: "/tmp/repo\n" }],
      },
      tool_use_result: { type: "text", stdout: [47, 116, 109, 112, 47, 114, 101, 112, 111, 10] },
    }, state);
    expect(toolResult[0]).toMatchObject({
      type: "tool_result",
      id: "tool-1",
      name: "Bash",
      output: "/tmp/repo\n",
      isError: false,
    });

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 11 } },
    }, state)).toEqual([{ type: "usage", outputTokens: 11, totalTokens: 11 }]);
  });

  test("maps Claude subagent lifecycle and nested tool activity", () => {
    const state = createClaudeParserState();

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "agent-tool-1",
      description: "Inspect README and package metadata",
      agent_type: "scout",
      prompt: "Read the README.",
      session_id: "session-1",
    }, state)).toEqual([{
      type: "participant_status",
      id: "task-1",
      role: "agent",
      state: "started",
      toolUseId: "agent-tool-1",
      title: "Inspect README and package metadata",
      detail: "Inspect README and package metadata",
      agentType: "scout",
      prompt: "Read the README.",
      sessionId: "session-1",
    }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      parent_tool_use_id: "agent-tool-1",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} },
      },
    }, state)).toEqual([{
      type: "tool_use",
      id: "read-1",
      name: "Read",
      input: {},
      participant: {
        id: "task-1",
        role: "agent",
        toolUseId: "agent-tool-1",
        title: "Inspect README and package metadata",
        name: "scout",
      },
    }]);

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      tool_use_id: "agent-tool-1",
      description: "Reading package.json",
      last_tool_name: "Read",
      usage: { total_tokens: 1200, tool_uses: 2, duration_ms: 900 },
      session_id: "session-1",
    }, state)).toEqual([{
      type: "participant_status",
      id: "task-1",
      role: "agent",
      state: "running",
      toolUseId: "agent-tool-1",
      title: "Inspect README and package metadata",
      detail: "Reading package.json",
      agentType: "scout",
      currentTool: "Read",
      totalTokens: 1200,
      toolUses: 2,
      durationMs: 900,
      sessionId: "session-1",
    }]);

    expect(claudeJsonToEvents({
      type: "user",
      parent_tool_use_id: "agent-tool-1",
      message: {
        role: "user",
        content: [{ tool_use_id: "read-1", type: "tool_result", content: "package data" }],
      },
    }, state)[0]).toMatchObject({
      type: "tool_result",
      id: "read-1",
      name: "Read",
      output: "package data",
      isError: false,
      participant: {
        id: "task-1",
        role: "agent",
        toolUseId: "agent-tool-1",
        title: "Inspect README and package metadata",
        name: "scout",
      },
    });

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "agent-tool-1",
      status: "completed",
      summary: "Inspect README and package metadata",
      usage: { total_tokens: 2500, tool_uses: 5, duration_ms: 19453 },
      session_id: "session-1",
    }, state)).toEqual([{
      type: "participant_status",
      id: "task-1",
      role: "agent",
      state: "completed",
      toolUseId: "agent-tool-1",
      title: "Inspect README and package metadata",
      detail: "Inspect README and package metadata",
      agentType: "scout",
      output: "",
      outputFile: undefined,
      totalTokens: 2500,
      toolUses: 5,
      durationMs: 19453,
      sessionId: "session-1",
    }]);
  });

  test("does NOT attribute a main-agent tool call to a phantom subagent participant", () => {
    // A main agent's own tool_use/tool_result can carry a parent_tool_use_id that
    // was never registered by a task_started event. Such events belong to the
    // main agent and must NOT get a `participant` (which would spawn fake
    // "Subagent" rows in the Agents panel). Regression for the phantom-agents bug.
    const state = createClaudeParserState();
    const toolUse = claudeJsonToEvents({
      type: "stream_event",
      parent_tool_use_id: "unregistered-main-turn",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } },
      },
    }, state);
    expect(toolUse[0]).not.toHaveProperty("participant");

    const toolResult = claudeJsonToEvents({
      type: "user",
      parent_tool_use_id: "unregistered-main-turn",
      message: {
        role: "user",
        content: [{ tool_use_id: "bash-1", type: "tool_result", content: "ok" }],
      },
    }, state);
    expect(toolResult[0]).not.toHaveProperty("participant");
  });

  test("deduplicates Claude lifecycle statuses and full-message text snapshots", () => {
    const state = createClaudeParserState();

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "hook_started",
      hook: "SessionStart",
    }, state)).toEqual([{
      type: "status",
      label: "claude-startup",
      phase: "claude-startup",
      message: "Claude Code startup hook: SessionStart.",
      sessionId: "",
    }]);

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "status",
      status: "requesting",
    }, state)).toEqual([{
      type: "status",
      label: "requesting",
      message: "Claude Code is requesting model output.",
      model: "",
      sessionId: "",
    }]);

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-5",
      session_id: "session-1",
    }, state)).toEqual([{
      type: "status",
      label: "init",
      message: "Claude Code ready (claude-sonnet-4-5).",
      model: "claude-sonnet-4-5",
      sessionId: "session-1",
    }]);

    expect(claudeJsonToEvents({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-5",
      session_id: "session-1",
    }, state)).toEqual([]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-sonnet-4-5" } },
    }, state)).toEqual([{
      type: "status",
      label: "streaming",
      message: "Claude is responding.",
      model: "claude-sonnet-4-5",
    }]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-sonnet-4-5" } },
    }, state)).toEqual([]);

    expect(claudeJsonToEvents({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Now " } },
    }, state)).toEqual([{ type: "text_delta", text: "Now " }]);

    expect(claudeJsonToEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "Now turn_execution.rs:" }] },
    }, state)).toEqual([{ type: "text_delta", text: "turn_execution.rs:" }]);

    expect(claudeJsonToEvents({
      type: "assistant",
      message: { content: [{ type: "text", text: "Now turn_execution.rs:" }] },
    }, state)).toEqual([]);
  });

  test("maps legacy ACP session updates", () => {
    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "agent_message_chunk", content: { text: "patched" } } },
    })).toEqual([{ type: "text_delta", text: "patched" }]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: { update: { type: "tool_call", id: "h-1", title: "Read", input: { path: "README.md" } } },
    })).toEqual([{ type: "tool_use", id: "h-1", name: "Read", input: { path: "README.md" } }]);
  });

  test("maps documented Grok ACP session updates", () => {
    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "hello from grok" },
        },
      },
    })).toEqual([{ type: "text_delta", text: "hello from grok" }]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { text: "inspecting files" },
        },
      },
    })).toEqual([{ type: "thinking_delta", text: "inspecting files" }]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "read_file",
          rawInput: { target_file: "package.json" },
        },
      },
    })).toEqual([{ type: "tool_use", id: "call-1", name: "read_file", input: { target_file: "package.json" } }]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "read_file",
          status: "running",
        },
      },
    })).toEqual([{
      type: "status",
      label: "running",
      phase: "tool",
      message: "read_file running.",
    }]);

    const state = createAcpParserState("grok");
    acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "read_file",
          rawInput: { target_file: "package.json" },
        },
      },
    }, state);
    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: { type: "ReadFile", Content: { content: "{ \"name\": \"rlm-wiki\" }" } },
        },
      },
    }, state)).toMatchObject([{
      type: "tool_result",
      id: "call-1",
      name: "read_file",
      output: "{ \"name\": \"rlm-wiki\" }",
      isError: false,
    }]);
  });

  test("maps Grok ACP subagents into participant activity", () => {
    const state = createAcpParserState();

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "parent-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-agent",
          title: "spawn_subagent",
          rawInput: {
            description: "Inspect README and package metadata",
            subagent_type: "explore",
            capability_mode: "read-only",
          },
        },
      },
    }, state)).toEqual([
      {
        type: "tool_use",
        id: "call-agent",
        name: "Agent",
        input: {
          description: "Inspect README and package metadata",
          subagent_type: "explore",
          capability_mode: "read-only",
        },
      },
      {
        type: "participant_status",
        id: "call-agent",
        role: "agent",
        state: "running",
        parentId: "parent-session",
        toolUseId: "call-agent",
        title: "Inspect README and package metadata",
        detail: "Running in background.",
        name: "explore",
        agentType: "explore",
        prompt: undefined,
        sessionId: "call-agent",
      },
    ]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "parent-session",
        update: {
          sessionUpdate: "subagent_spawned",
          subagent_id: "child-session",
          parent_session_id: "parent-session",
          child_session_id: "child-session",
          subagent_type: "explore",
          description: "Inspect README and package metadata",
          model: "grok-build",
        },
      },
    }, state)).toEqual([{
      type: "participant_status",
      id: "call-agent",
      role: "agent",
      state: "running",
      parentId: "parent-session",
      toolUseId: "call-agent",
      title: "Inspect README and package metadata",
      detail: "Running in background.",
      name: "explore",
      agentType: "explore",
      prompt: undefined,
      sessionId: "child-session",
    }]);

    expect(acpJsonToEvents({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "parent-session",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "child-session",
          child_session_id: "child-session",
          status: "completed",
          tool_calls: 2,
          turns: 1,
          duration_ms: 6273,
          output: "README and package metadata inspected.",
        },
      },
    }, state)).toEqual([{
      type: "participant_status",
      id: "call-agent",
      role: "agent",
      state: "completed",
      parentId: "parent-session",
      toolUseId: "call-agent",
      title: "Inspect README and package metadata",
      detail: "",
      name: "explore",
      agentType: "explore",
      prompt: undefined,
      output: "README and package metadata inspected.",
      totalTokens: undefined,
      toolUses: 2,
      durationMs: 6273,
      sessionId: "child-session",
    }]);
  });

  test("maps Grok headless streaming JSON chunks", () => {
    expect(grokJsonToEvents({ type: "thought", data: "The" })).toEqual([{ type: "thinking_delta", text: "The" }]);
    expect(grokJsonToEvents({ type: "text", data: "Done" })).toEqual([{ type: "text_delta", text: "Done" }]);
    expect(grokJsonToEvents({ type: "end", stopReason: "EndTurn", sessionId: "session-1" })).toEqual([{
      type: "status",
      label: "done",
      message: "Grok CLI finished.",
      sessionId: "session-1",
    }]);
  });

  test("extracts final answer and sources from product contracts", () => {
    expect(extractAnswer("noise <ANSWER>\nFinal answer\n</ANSWER> tail")).toBe("Final answer");
    const longAnswer = `${"A concise but sufficiently long final answer. ".repeat(12)}\n\n## Sources\n- README.md:1`;
    expect(extractAnswer(`<ANSWER>${longAnswer}\n\n${longAnswer}</ANSWER>`)).toBe(longAnswer);
    expect(extractSources("[src/server.ts:10]()\n[README.md]()\n[repo-a:src/app.ts:12-24]()\n[local_connection.py:421–479]()")).toEqual([
      "src/server.ts:10",
      "README.md",
      "repo-a:src/app.ts:12-24",
      "local_connection.py:421–479",
    ]);
  });
});

describe("legacy runtime event normalization", () => {
  test("maps JCODE/RLM stream and tool events into Open Design-style events", () => {
    expect(openDesignAgentEvent({ type: "stream-delta", delta: "hello" })).toEqual({
      type: "text_delta",
      text: "hello",
      replace: false,
    });

    expect(openDesignAgentEvent({ type: "stream-reasoning-delta", delta: "thinking" })).toEqual({
      type: "thinking_delta",
      text: "thinking",
    });

    expect(openDesignAgentEvent({ type: "stream-done" })).toEqual({
      type: "status",
      label: "stream_done",
      message: "",
    });

    expect(openDesignAgentEvent({ type: "agent-log", kind: "tool-output", id: "t1", tool: "Bash", output: "ok" })).toEqual({
      type: "tool_result",
      id: "t1",
      name: "Bash",
      output: "ok",
      isError: false,
      durationMs: undefined,
    });

    expect(openDesignAgentEvent({ type: "agent-log", kind: "status", message: "Starting agent in /tmp/repo" })).toEqual({
      type: "agent-log",
      kind: "status",
      id: expect.any(String),
      message: "Starting agent in /tmp/repo",
      tool: undefined,
    });

    expect(openDesignAgentEvent({ type: "submit", answer: "Done", sources: ["README.md:1-3"] })).toEqual({
      type: "submit",
      answer: "Done",
      sources: ["README.md:1-3"],
    });

    expect(openDesignAgentEvent({
      type: "participant_status",
      id: "task-1",
      role: "agent",
      state: "running",
      title: "Inspect README",
    })).toEqual({
      type: "participant_status",
      id: "task-1",
      role: "agent",
      state: "running",
      title: "Inspect README",
    });
  });
});

describe("local CLI sidecar environment", () => {
  test("does not forward server/BYOK provider credentials into local agent subprocesses", () => {
    const env = localCliAgentEnv({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      DEEPSEEK_API_KEY_2: "deepseek-secret",
      GROK_WIKI_SECRET_GRANT_KEY: "grant-secret",
      RLM_WIKI_SECRET_GRANT_KEY: "grant-secret",
    });

    expect(String(env.PATH || "").split(":")).toContain("/usr/bin");
    expect(env.HOME).toBe("/Users/example");
    expect(env.NO_COLOR).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY_2).toBeUndefined();
    expect(env.GROK_WIKI_SECRET_GRANT_KEY).toBeUndefined();
    expect(env.RLM_WIKI_SECRET_GRANT_KEY).toBeUndefined();
  });
});
