import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __createDetachedRunForTests,
  __resetAgentReadinessForTests,
  __runPathAgentReadinessForTests,
  antigravityArgs,
  codexArgs,
  createPromptEchoFilter,
  detectLocalCliAgents,
  emitRun,
  grokAgentArgs,
  grokHeadlessArgs,
  grokTraceUpdatesToEvents,
  LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP,
  LOCAL_CLI_RUN_EVENT_BYTE_BUDGET,
  localCliEventStartsWork,
  localCliAgentEnv,
  localCliSearchPath,
  piClaudeArgs,
  piCodexArgs,
  resolveWorkspacePath,
  runAntigravityPrint,
  runWithLocalCliModelFallback,
  shouldFallbackFromGrokAcpError,
  shouldUseGrokHeadless,
} from "./local-cli-sidecar.ts";
import {
  LOCAL_CLI_AGENT_IDS,
  localCliLabel,
  normalizeLocalCliAgentId,
} from "./local-cli-events.ts";
import { createPiParserState, extractAnswer, piJsonToEvents } from "./local-cli-parsers.ts";
import {
  __resetLocalCliSidecarForTests,
  __setLocalCliSidecarStarterForTests,
  getLocalCliAgents,
  localCliSidecarEntrypoint,
} from "./local-cli-sidecar-client.ts";

const LOCAL_CLI_MANAGER_ENV_KEYS = [
  "NPM_CONFIG_PREFIX",
  "PNPM_HOME",
  "BUN_INSTALL",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "NVM_DIR",
  "FNM_DIR",
] as const;

function useIsolatedLocalCliEnv(next: Record<string, string>): () => void {
  // PI_*_DIR point piAuthStatus at an auth.json OUTSIDE the isolated HOME (Orca
  // shells export PI_CODING_AGENT_DIR), so clear them or the host's real Pi auth
  // leaks into the "not authenticated" fixtures.
  const piEnvKeys = ["PI_AGENT_DIR", "PI_CODING_AGENT_DIR"];
  const keys = ["HOME", "PATH", "SHELL", ...piEnvKeys, ...LOCAL_CLI_MANAGER_ENV_KEYS];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of [...piEnvKeys, ...LOCAL_CLI_MANAGER_ENV_KEYS]) delete process.env[key];
  for (const [key, value] of Object.entries(next)) process.env[key] = value;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe("Grok CLI local CLI adapter", () => {
  test("recognizes local CLI agents", () => {
    expect(LOCAL_CLI_AGENT_IDS).toEqual(["grok", "codex", "claude", "pi-codex", "pi-claude", "antigravity"]);
    expect(normalizeLocalCliAgentId("antigravity")).toBe("antigravity");
    expect(normalizeLocalCliAgentId("pi-codex")).toBe("pi-codex");
    expect(normalizeLocalCliAgentId("pi-claude")).toBe("pi-claude");
    expect(localCliLabel({ agentId: "antigravity" })).toBe("Antigravity CLI");
    expect(localCliLabel({ agentId: "pi-codex" })).toBe("Pi · Codex");
    expect(localCliLabel({ agentId: "pi-claude" })).toBe("Pi · Claude Code");
  });

  test("retries with the CLI default when an explicit model is unavailable", async () => {
    const attemptedModels: Array<string | undefined> = [];
    const rejectedModels: string[] = [];

    const answer = await runWithLocalCliModelFallback(
      "composer-2.5",
      async (model) => {
        attemptedModels.push(model);
        if (model) {
          throw new Error(`Couldn't set model '${model}': Invalid params: "unknown model id".`);
        }
        return "generated page";
      },
      { onFallback: (model) => rejectedModels.push(model) },
    );

    expect(answer).toBe("generated page");
    expect(attemptedModels).toEqual(["composer-2.5", undefined]);
    expect(rejectedModels).toEqual(["composer-2.5"]);
  });

  test("does not retry unrelated local CLI failures with a different model", async () => {
    const attemptedModels: Array<string | undefined> = [];

    await expect(runWithLocalCliModelFallback("grok-4.5", async (model) => {
      attemptedModels.push(model);
      throw new Error("Grok CLI exited with 1: authentication required");
    })).rejects.toThrow("authentication required");

    expect(attemptedModels).toEqual(["grok-4.5"]);
  });

  test("does not change models after answer text has started streaming", async () => {
    const attemptedModels: Array<string | undefined> = [];
    let hasStreamedText = false;

    await expect(runWithLocalCliModelFallback(
      "composer-2.5",
      async (model) => {
        attemptedModels.push(model);
        hasStreamedText = true;
        throw new Error("unknown model id");
      },
      { canFallback: () => !hasStreamedText },
    )).rejects.toThrow("unknown model id");

    expect(attemptedModels).toEqual(["composer-2.5"]);
  });

  test("treats tool and thinking events as started work but not status chatter", () => {
    expect(localCliEventStartsWork({
      type: "status",
      phase: "starting",
      message: "Starting local CLI.",
    })).toBe(false);
    expect(localCliEventStartsWork({ type: "thinking_start" })).toBe(true);
    expect(localCliEventStartsWork({
      type: "tool_use",
      id: "tool-1",
      name: "write_file",
      input: { path: "README.md" },
    })).toBe(true);
    expect(localCliEventStartsWork({ type: "text_delta", text: "Draft" })).toBe(true);
  });

  test("bounds retained run events under memory pressure while preserving the terminal frame", () => {
    const run = __createDetachedRunForTests();

    // Oversized single payload is truncated on ingest with a visible marker.
    const huge = "x".repeat(LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP * 4);
    emitRun(run, "event", { type: "tool_result", id: "t1", output: huge });
    const retainedOutput = (run.events[0]?.data as { output: string }).output;
    expect(retainedOutput.length).toBeLessThanOrEqual(LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP + 64);
    expect(retainedOutput).toContain("truncated under memory pressure");

    // Flood enough capped tool_results to exceed the per-run budget; oldest non-terminal
    // events are dropped ring-buffer style so total retained bytes stay bounded.
    const floodCount = Math.ceil((LOCAL_CLI_RUN_EVENT_BYTE_BUDGET / LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP) * 3);
    for (let i = 0; i < floodCount; i += 1) {
      emitRun(run, "event", { type: "tool_result", id: `flood-${i}`, output: huge });
    }
    expect(run.eventBytes ?? 0).toBeLessThanOrEqual(LOCAL_CLI_RUN_EVENT_BYTE_BUDGET);

    // The terminal frame is emitted last and must survive eviction so late subscribers
    // (runEventsResponse replay) still receive it.
    emitRun(run, "done", { runId: run.id, answer: "ok" });
    const terminal = run.events.filter((entry) => entry.terminal);
    expect(terminal.length).toBe(1);
    expect(terminal[0]?.event).toBe("done");
    expect((terminal[0]?.data as { answer: string }).answer).toBe("ok");
    expect(run.eventBytes ?? 0).toBeLessThanOrEqual(LOCAL_CLI_RUN_EVENT_BYTE_BUDGET);
  });

  test("uses a read-only Codex sandbox for Ask-style local CLI runs", () => {
    expect(codexArgs("/tmp/repo", "gpt-5.5", "low", [], { readOnly: true })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      "/tmp/repo",
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  test("keeps Codex workspace-write sandbox for editing-capable local CLI runs", () => {
    expect(codexArgs("/tmp/repo")).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      "/tmp/repo",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });

  test("runs Pi Codex through read-only JSON mode with gpt-5.6-sol and bash for code-graph", () => {
    // bash is required so Pi can curl the live code graph (same path as Codex/Claude/Grok).
    expect(piCodexArgs(undefined, undefined, "ask")).toEqual([
      "--mode",
      "json",
      "--print",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-sol",
      "--no-session",
      "--tools",
      "read,bash,grep,find,ls",
    ]);
    expect(piCodexArgs("default", "high", "ask")).toContain("--thinking");
    expect(piCodexArgs("default", "high", "ask")).toContain("high");
  });

  test("runs Pi Claude through JSON mode with Anthropic and bash for code-graph", () => {
    expect(piClaudeArgs(undefined, undefined, "ask")).toEqual([
      "--mode",
      "json",
      "--print",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-5",
      "--no-session",
      "--tools",
      "read,bash,grep,find,ls",
      "--thinking",
      "high",
    ]);
    // Write contexts (wiki page) also keep bash + add edit/write.
    expect(piClaudeArgs("claude-sonnet-5", "medium", "wiki-page")).toEqual([
      "--mode",
      "json",
      "--print",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-5",
      "--no-session",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--thinking",
      "medium",
    ]);
  });

  test("keeps network environment for local agents while filtering provider secrets", () => {
    const env = localCliAgentEnv({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
    });

    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/ca.pem");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
  });

  test("filters echoed local CLI prompt text from Pi answer streams", () => {
    const prompt = [
      "You are a proactive, Socratic-thinking general-purpose and coding agent.",
      "# Tool call notes",
      "Use rg first.",
      "# User Task",
      "Answer the question.",
    ].join("\n\n");
    const filter = createPromptEchoFilter(prompt);

    expect(filter.push("You are a proactive, Soc")).toBe("");
    // Short post-echo answers may sit in the hold-back tail until flush so we
    // can still detect mid-stream re-injection markers split across chunks.
    const mid = filter.push(
      "ratic-thinking general-purpose and coding agent.\n\n# Tool call notes\n\nUse rg first.\n\n# User Task\n\nAnswer the question.\n\nActual answer.",
    );
    expect((mid + filter.flush()).trim()).toBe("Actual answer.");

    const normal = createPromptEchoFilter(prompt);
    const body = normal.push("You should inspect README.md first.");
    expect((body + normal.flush()).trim()).toBe("You should inspect README.md first.");
  });

  test("strips trailing local-cli prompt dumps after a real answer", () => {
    const prompt = [
      "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.",
      "# Tool call notes",
      "Parallelize tool calls whenever possible. Especially file reads, such as `cat`.",
      "# User Task",
      "How to self-host?",
    ].join("\n\n");

    const good = [
      "# How to self-host Agentrove",
      "",
      "Use Docker Compose on a single host.",
      "",
      "```bash",
      "docker compose up -d",
      "```",
    ].join("\n");

    const leaked = [
      good,
      "",
      "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.",
      "",
      "# Tool call notes",
      "Parallelize tool calls whenever possible. Especially file reads, such as `cat`.",
      "",
      "# Ask Task",
      "Answer the user's question.",
      "",
      "<code-kb>",
      "secret scaffold",
      "</code-kb>",
    ].join("\n");

    // Finalizer path
    const { stripLocalCliPromptEcho } = require("./local-cli-sidecar.ts") as typeof import("./local-cli-sidecar.ts");
    expect(stripLocalCliPromptEcho(leaked, prompt)).toBe(good);

    // Streaming path: answer first, then scaffold dump mid-stream
    const stream = createPromptEchoFilter(prompt);
    const chunks = [
      "# How to self-host Agentrove\n\nUse Docker Compose on a single host.\n\n```bash\ndocker compose up -d\n```\n\n",
      "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.\n\n",
      "# Tool call notes\nParallelize tool calls whenever possible. Especially file reads, such as `cat`.\n",
      "# Ask Task\nAnswer.\n<code-kb>x</code-kb>",
    ];
    let out = "";
    for (const chunk of chunks) out += stream.push(chunk);
    out += stream.flush();
    expect(out.trim()).toBe(good.trim());
    expect(out).not.toContain("# Tool call notes");
    expect(out).not.toContain("<code-kb>");
    expect(out).not.toContain("Socratic-thinking");
  });

  test("does not chop a complete answer that mentions workspace or wiki headings", () => {
    const prompt = [
      "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.",
      "# Tool call notes",
      "Parallelize tool calls whenever possible. Especially file reads, such as `cat`.",
      "# User Task",
      "Explain the pipeline.",
    ].join("\n\n");

    const full = [
      "Design takeaways",
      "",
      "1. Turns are seq-ordered event logs while live.",
      "2. High-frequency content is batched.",
      "3. One content SSE per user avoids browser connection limits.",
      "",
      "That is the full path Agentrove uses to process event turns in chat:",
      "agent updates become sequenced envelopes, dual SSE feeds deliver",
      "content via Redis and lifecycle discovery stays intentionally lossy.",
    ].join("\n");

    const { stripLocalCliPromptEcho } = require("./local-cli-sidecar.ts") as typeof import("./local-cli-sidecar.ts");
    expect(stripLocalCliPromptEcho(full, prompt)).toBe(full);

    const stream = createPromptEchoFilter(prompt);
    // Stream in small chunks (including a short final chunk that used to sit in holdBack).
    const pieces = [
      full.slice(0, 80),
      full.slice(80, 160),
      full.slice(160, 240),
      full.slice(240),
    ];
    let out = "";
    for (const piece of pieces) out += stream.push(piece);
    out += stream.flush();
    expect(out).toBe(full);
    expect(out.endsWith("intentionally lossy.")).toBe(true);
  });

  test("ACP session path strips echoed prompts the same way as Pi", async () => {
    const source = await Bun.file(new URL("./local-cli-sidecar.ts", import.meta.url)).text();
    // Grok ACP used to forward raw text_delta, dumping the full system prompt into Ask.
    expect(source).toContain("const promptEchoFilter = createPromptEchoFilter(args.prompt);");
    expect(source).toContain("const emitAcpEvent = (event: LocalCliEvent): void => {");
    expect(source).toContain('if (event.type === "text_delta")');
    expect(source).toContain("const text = promptEchoFilter.push(event.text);");
    expect(source).toContain("const pendingText = promptEchoFilter.flush();");
    // Must flush held answer text before killing the child (mid-sentence cutoffs).
    expect(source).toContain("const pendingBeforeTeardown = promptEchoFilter.flush();");
    // Settle window must be patient: old 2s max killed Grok mid-answer.
    expect(source).toContain("requiredIdleSlices = 3");
    expect(source).toMatch(/maxWaitMs = Math\.max\(\s*15_000/);
  });

  test("normalizes Pi JSON stream events", () => {
    const state = createPiParserState();
    const events = [
      ...piJsonToEvents({ type: "session", id: "pi-session" }, state),
      ...piJsonToEvents({ type: "agent_start" }, state),
      ...piJsonToEvents({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "<ANSWER>Hello" },
      }, state),
      ...piJsonToEvents({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      }, state),
      ...piJsonToEvents({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Inspecting the repo." },
      }, state),
      ...piJsonToEvents({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "grep",
        args: { pattern: "Pi" },
      }, state),
      ...piJsonToEvents({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "grep",
        result: { content: [{ type: "text", text: "README.md:1" }] },
        isError: false,
      }, state),
      ...piJsonToEvents({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "</ANSWER>" },
      }, state),
    ];

    expect(events).toContainEqual({
      type: "status",
      label: "initializing",
      message: "Pi session initialized.",
      sessionId: "pi-session",
    });
    expect(events).toContainEqual({ type: "text_delta", text: "<ANSWER>Hello" });
    expect(events).toContainEqual({ type: "thinking_start", label: "Thinking" });
    expect(events).toContainEqual({ type: "thinking_delta", text: "Inspecting the repo." });
    expect(events).toContainEqual({ type: "tool_use", id: "tool-1", name: "grep", input: { pattern: "Pi" } });
    expect(events).toContainEqual({
      type: "tool_result",
      id: "tool-1",
      name: "grep",
      output: "README.md:1",
      isError: false,
      durationMs: expect.any(Number),
    });
    expect(extractAnswer(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""))).toBe("Hello");
  });

  test("does not stream Pi user or tool-result messages as answer text", () => {
    const state = createPiParserState();
    const events = [
      ...piJsonToEvents({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "Question prompt" }],
        },
      }, state),
      ...piJsonToEvents({
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "ls",
          content: [{ type: "text", text: ".claude/\nREADME.md" }],
        },
      }, state),
      ...piJsonToEvents({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
        },
      }, state),
    ];

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Final answer" },
    ]);
  });

  test("runs headless streaming JSON in documented always-approve mode", () => {
    expect(grokHeadlessArgs({
      cwd: "/tmp/repo",
      promptPath: "/tmp/repo/.grok-wiki-grok-prompt.md",
    })).toEqual([
      "--cwd",
      "/tmp/repo",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--prompt-file",
      "/tmp/repo/.grok-wiki-grok-prompt.md",
    ]);
  });

  test("passes selected model and reasoning to headless mode", () => {
    expect(grokHeadlessArgs({
      cwd: "/tmp/repo",
      promptPath: "/tmp/repo/.grok-wiki-grok-prompt.md",
      model: "grok-code-fast-1",
      reasoning: "high",
    })).toEqual([
      "--cwd",
      "/tmp/repo",
      "--output-format",
      "streaming-json",
      "--always-approve",
      "--model",
      "grok-code-fast-1",
      "--reasoning-effort",
      "high",
      "--prompt-file",
      "/tmp/repo/.grok-wiki-grok-prompt.md",
    ]);
  });

  test("keeps ACP helper in always-approve mode for future IDE integrations", () => {
    expect(grokAgentArgs()).toEqual(["agent", "--always-approve", "stdio"]);
  });

  test("runs Antigravity in sandboxed unattended print mode", () => {
    expect(antigravityArgs({
      promptPath: "/tmp/repo/.grok-wiki-antigravity-prompt-abcd.md",
      workspaceDir: "/tmp/repo",
      timeoutMs: 1234,
    })).toEqual([
      "--add-dir",
      "/tmp/repo",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "1234ms",
      "--print",
      "Read /tmp/repo/.grok-wiki-antigravity-prompt-abcd.md and complete the task exactly as written.",
    ]);
  });

  test("uses Antigravity stdout as the answer stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-run-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo '1.0.0'; exit 0; fi",
      "prompt=\"\"",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--print\" ]; then shift; prompt=\"$1\"; break; fi",
      "  shift",
      "done",
      "case \"$prompt\" in",
      "  *'.grok-wiki-antigravity-prompt-'*) printf '<ANSWER>Antigravity done</ANSWER>\\n<SOURCES>\\n- README.md:1\\n</SOURCES>\\n'; exit 0 ;;",
      "  *) echo 'missing prompt file instruction' >&2; exit 2 ;;",
      "esac",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    const events: unknown[] = [];
    try {
      await runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer from README.",
        timeoutMs: 500,
        onEvent: (event) => events.push(event),
      });

      expect(events).toContainEqual({
        type: "text_delta",
        text: "<ANSWER>Antigravity done</ANSWER>\n<SOURCES>\n- README.md:1\n</SOURCES>\n",
      });
      expect(extractAnswer(events
        .filter((event): event is { type: "text_delta"; text: string } => typeof event === "object" && event !== null && (event as { type?: string }).type === "text_delta")
        .map((event) => event.text)
        .join(""))).toBe("Antigravity done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits Antigravity quiet-mode status while stdout is buffered", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-quiet-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "sleep 0.08",
      "printf '<ANSWER>Quiet answer</ANSWER>\\n'",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    const events: unknown[] = [];
    try {
      await runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer quietly.",
        timeoutMs: 500,
        heartbeatMs: 20,
        onEvent: (event) => events.push(event),
      });

      const statuses = events
        .filter((event): event is { type: "status"; message?: string } => typeof event === "object" && event !== null && (event as { type?: string }).type === "status")
        .map((event) => event.message || "");
      expect(statuses.some((message) => message.includes("print mode"))).toBe(true);
      expect(statuses.some((message) => message.includes("No output yet"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops Antigravity after a tunable quiet period", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-quiet-timeout-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "sleep 1",
      "printf '<ANSWER>Too late</ANSWER>\\n'",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    const events: unknown[] = [];
    try {
      await expect(runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer eventually.",
        timeoutMs: 2_000,
        heartbeatMs: 10,
        quietTimeoutMs: 30,
        onEvent: (event) => events.push(event),
      })).rejects.toThrow(/produced no output for 0s and was stopped/);

      const statuses = events
        .filter((event): event is { type: "status"; message?: string } => typeof event === "object" && event !== null && (event as { type?: string }).type === "status")
        .map((event) => event.message || "");
      expect(statuses.some((message) => message.includes("Stopping this run"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds Antigravity setup guidance when print mode exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-error-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "echo 'browser sign-in required' >&2",
      "exit 7",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    try {
      await expect(runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer from README.",
        timeoutMs: 500,
        onEvent: () => {},
      })).rejects.toThrow(/run `agy` once and complete Google Sign-In/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats Antigravity print timeout stdout as a runtime error", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-timeout-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "echo 'Error: timed out waiting for response'",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    try {
      await expect(runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer from README.",
        timeoutMs: 500,
        onEvent: () => {},
      })).rejects.toThrow(/timed out waiting for a print-mode response/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats empty Antigravity print stdout as a runtime error", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-empty-"));
    const bin = join(root, "agy");
    writeFileSync(bin, [
      "#!/bin/sh",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(bin, 0o755);
    try {
      await expect(runAntigravityPrint({
        run: { controller: new AbortController() },
        binPath: bin,
        cwd: root,
        prompt: "Answer from README.",
        timeoutMs: 500,
        onEvent: () => {},
      })).rejects.toThrow(/without a print-mode answer/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses Grok headless mode only for wiki generation surfaces", () => {
    expect(shouldUseGrokHeadless("wiki-structure")).toBe(true);
    expect(shouldUseGrokHeadless("wiki-page")).toBe(true);
    expect(shouldUseGrokHeadless("chat")).toBe(false);
    expect(shouldUseGrokHeadless("code")).toBe(false);
    expect(shouldUseGrokHeadless()).toBe(false);
  });

  test("falls back from Grok ACP startup failures but not cancellations", () => {
    expect(shouldFallbackFromGrokAcpError(new Error("grok initialize timed out"))).toBe(true);
    expect(shouldFallbackFromGrokAcpError(new Error("grok session/new did not return a sessionId."))).toBe(true);
    expect(shouldFallbackFromGrokAcpError(new Error("Grok CLI exited with 1: auth failed"))).toBe(true);
    expect(shouldFallbackFromGrokAcpError(new DOMException("Canceled by caller.", "AbortError"))).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(shouldFallbackFromGrokAcpError(abort)).toBe(false);
  });

  test("allows canonical paths that point inside a symlinked workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-workspace-real-"));
    const alias = `${root}-alias`;
    try {
      symlinkSync(root, alias, "dir");
      const file = join(root, "README.md");
      writeFileSync(file, "ok", "utf8");

      expect(resolveWorkspacePath(alias, file)).toBe(file);
    } finally {
      rmSync(alias, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still rejects real paths outside the local CLI workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-workspace-"));
    try {
      expect(() => resolveWorkspacePath(root, "/etc/passwd")).toThrow(/outside local CLI workspace/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers real tool calls from exported Grok traces", () => {
    const updates = [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "list_dir",
            rawInput: { target_directory: "." },
          },
        },
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            rawOutput: {
              type: "ListDir",
              Content: { content: "- README.md\n- src/" },
            },
          },
        },
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-2",
            title: "read_file",
            rawInput: { target_file: "README.md" },
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    // durationMs is only present when tool start/complete span at least 1ms, so strip it.
    const events = grokTraceUpdatesToEvents(updates).map((event) => {
      if (event.type !== "tool_result") return event;
      const { durationMs: _durationMs, ...rest } = event;
      return rest;
    });
    expect(events).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        name: "list_dir",
        input: { target_directory: "." },
      },
      {
        type: "tool_result",
        id: "call-1",
        name: "list_dir",
        output: "- README.md\n- src/",
        isError: false,
      },
      {
        type: "tool_use",
        id: "call-2",
        name: "read_file",
        input: { target_file: "README.md" },
      },
    ]);
  });

  test("recovers subagent lifecycle from exported Grok traces", () => {
    const updates = [
      {
        method: "session/update",
        params: {
          sessionId: "parent-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-agent",
            title: "spawn_subagent",
            rawInput: {
              description: "Inspect source entry points",
              subagent_type: "explore",
              capability_mode: "read-only",
            },
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "parent-session",
          update: {
            sessionUpdate: "subagent_spawned",
            subagent_id: "child-session",
            parent_session_id: "parent-session",
            child_session_id: "child-session",
            subagent_type: "explore",
            description: "Inspect source entry points",
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "parent-session",
          update: {
            sessionUpdate: "subagent_finished",
            subagent_id: "child-session",
            child_session_id: "child-session",
            status: "completed",
            tool_calls: 3,
            duration_ms: 4200,
            output: "Found src/server.ts and apps/desktop/src/main.ts.",
          },
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    expect(grokTraceUpdatesToEvents(updates)).toEqual([
      {
        type: "tool_use",
        id: "call-agent",
        name: "Agent",
        input: {
          description: "Inspect source entry points",
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
        title: "Inspect source entry points",
        detail: "Running in background.",
        name: "explore",
        agentType: "explore",
        prompt: undefined,
        sessionId: "call-agent",
      },
      {
        type: "participant_status",
        id: "call-agent",
        role: "agent",
        state: "running",
        parentId: "parent-session",
        toolUseId: "call-agent",
        title: "Inspect source entry points",
        detail: "Running in background.",
        name: "explore",
        agentType: "explore",
        prompt: undefined,
        sessionId: "child-session",
      },
      {
        type: "participant_status",
        id: "call-agent",
        role: "agent",
        state: "completed",
        parentId: "parent-session",
        toolUseId: "call-agent",
        title: "Inspect source entry points",
        detail: "",
        name: "explore",
        agentType: "explore",
        prompt: undefined,
        output: "Found src/server.ts and apps/desktop/src/main.ts.",
        totalTokens: undefined,
        toolUses: 3,
        durationMs: 4200,
        sessionId: "child-session",
      },
    ]);
  });

  test("searches common shell install locations for packaged desktop agents", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-agent-home-"));
    const npmPrefix = join(home, "custom-npm");
    const pnpmHome = join(home, "custom-pnpm");
    const bunInstall = join(home, "custom-bun");
    const voltaHome = join(home, "custom-volta");
    const asdfData = join(home, "custom-asdf");
    const miseData = join(home, "custom-mise");
    const nvmRoot = join(home, "custom-nvm");
    const fnmRoot = join(home, "custom-fnm");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".antigravity", "antigravity", "bin"), { recursive: true });
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "pnpm"), { recursive: true });
    mkdirSync(join(home, ".npm-packages", "bin"), { recursive: true });
    mkdirSync(join(home, "npm-global", "bin"), { recursive: true });
    mkdirSync(join(home, ".node_modules_global", "bin"), { recursive: true });
    mkdirSync(join(npmPrefix, "bin"), { recursive: true });
    mkdirSync(pnpmHome, { recursive: true });
    mkdirSync(join(bunInstall, "bin"), { recursive: true });
    mkdirSync(join(voltaHome, "bin"), { recursive: true });
    mkdirSync(join(asdfData, "shims"), { recursive: true });
    mkdirSync(join(miseData, "shims"), { recursive: true });
    const fnm = join(home, ".fnm", "node-versions", "v22.0.0", "installation", "bin");
    const customFnm = join(fnmRoot, "node-versions", "v24.0.0", "installation", "bin");
    const customNvm = join(nvmRoot, "versions", "node", "v24.1.0", "bin");
    const localShareFnm = join(home, ".local", "share", "fnm", "node-versions", "v23.0.0", "installation", "bin");
    mkdirSync(fnm, { recursive: true });
    mkdirSync(customFnm, { recursive: true });
    mkdirSync(customNvm, { recursive: true });
    mkdirSync(localShareFnm, { recursive: true });
    try {
      const dirs = localCliSearchPath({
        PATH: "/usr/bin",
        HOME: home,
        NPM_CONFIG_PREFIX: npmPrefix,
        PNPM_HOME: pnpmHome,
        BUN_INSTALL: bunInstall,
        VOLTA_HOME: voltaHome,
        ASDF_DATA_DIR: asdfData,
        MISE_DATA_DIR: miseData,
        NVM_DIR: nvmRoot,
        FNM_DIR: fnmRoot,
      });

      expect(dirs).toContain("/usr/bin");
      expect(dirs).toContain(join(npmPrefix, "bin"));
      expect(dirs).toContain(pnpmHome);
      expect(dirs).toContain(join(bunInstall, "bin"));
      expect(dirs).toContain(join(voltaHome, "bin"));
      expect(dirs).toContain(join(asdfData, "shims"));
      expect(dirs).toContain(join(miseData, "shims"));
      expect(dirs).toContain(join(home, ".local", "bin"));
      expect(dirs).toContain(join(home, ".antigravity", "antigravity", "bin"));
      expect(dirs).toContain(join(home, ".bun", "bin"));
      expect(dirs).toContain(join(home, ".local", "share", "pnpm"));
      expect(dirs).toContain(join(home, ".npm-packages", "bin"));
      expect(dirs).toContain(join(home, "npm-global", "bin"));
      expect(dirs).toContain(join(home, ".node_modules_global", "bin"));
      expect(dirs).toContain(customNvm);
      expect(dirs).toContain(fnm);
      expect(dirs).toContain(customFnm);
      expect(dirs).toContain(localShareFnm);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("spawns packaged local CLI sidecars through the bundled server entry", () => {
    const previous = process.env.GROK_WIKI_SERVER_ENTRY;
    try {
      process.env.GROK_WIKI_SERVER_ENTRY = "/Applications/Grok-Wiki.app/Contents/Resources/server/rlm-wiki.js";
      expect(localCliSidecarEntrypoint()).toBe("/Applications/Grok-Wiki.app/Contents/Resources/server/rlm-wiki.js");
    } finally {
      if (previous === undefined) delete process.env.GROK_WIKI_SERVER_ENTRY;
      else process.env.GROK_WIKI_SERVER_ENTRY = previous;
    }
  });

  test("retries sidecar startup after a cached failure", async () => {
    const previousFetch = globalThis.fetch;
    let starts = 0;
    try {
      __setLocalCliSidecarStarterForTests(async () => {
        starts++;
        if (starts === 1) throw new Error("bad bundled sidecar path");
        return { baseUrl: "http://127.0.0.1:1", token: "token", stampPath: join(tmpdir(), "grok-wiki-test-sidecar.json") };
      });
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ agents: [] }), { status: 200 })
      ) as unknown as typeof fetch;

      const first = await getLocalCliAgents({ rescan: true });
      expect(first.enabled).toBe(false);
      expect(first.error).toContain("bad bundled sidecar path");

      const second = await getLocalCliAgents({ rescan: true });
      expect(second.enabled).toBe(true);
      expect(starts).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      __resetLocalCliSidecarForTests();
    }
  });

  test("restarts a stale sidecar handle when the readiness fetch fails", async () => {
    const previousFetch = globalThis.fetch;
    let starts = 0;
    let fetches = 0;
    try {
      __setLocalCliSidecarStarterForTests(async () => {
        starts++;
        return {
          baseUrl: `http://127.0.0.1:${41000 + starts}`,
          token: "token",
          stampPath: join(tmpdir(), `grok-wiki-test-sidecar-${starts}.json`),
        };
      });
      globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        fetches++;
        if (fetches === 1) throw new TypeError("connection refused");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const status = await getLocalCliAgents({ rescan: true });
      expect(status.enabled).toBe(true);
      expect(starts).toBe(2);
      expect(fetches).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      __resetLocalCliSidecarForTests();
    }
  });

  test("restarts a stale sidecar when the agent list predates Pi agents", async () => {
    const previousFetch = globalThis.fetch;
    let starts = 0;
    let fetches = 0;
    try {
      __setLocalCliSidecarStarterForTests(async () => {
        starts++;
        return {
          baseUrl: `http://127.0.0.1:${42000 + starts}`,
          token: "token",
          stampPath: join(tmpdir(), `grok-wiki-test-stale-sidecar-${starts}.json`),
        };
      });
      globalThis.fetch = (async () => {
        fetches++;
        const agents = fetches === 1
          ? [{ id: "grok" }, { id: "codex" }, { id: "claude" }]
          : [{ id: "grok" }, { id: "codex" }, { id: "claude" }, { id: "pi-codex" }, { id: "pi-claude" }, { id: "antigravity" }];
        return new Response(JSON.stringify({ agents }), { status: 200 });
      }) as unknown as typeof fetch;

      const status = await getLocalCliAgents({ rescan: true });
      expect(status.enabled).toBe(true);
      expect(status.agents.map((agent) => agent.id)).toContain("pi-codex");
      expect(status.agents.map((agent) => agent.id)).toContain("pi-claude");
      expect(status.agents.map((agent) => agent.id)).toContain("antigravity");
      expect(starts).toBe(2);
      expect(fetches).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      __resetLocalCliSidecarForTests();
    }
  });

  test("rescans local CLI availability without executing installed agent shims", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-agent-rescan-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const before = detectLocalCliAgents({ rescan: true }).find((agent) => agent.id === "codex");
      expect(before?.installed).toBe(false);

      const codex = join(bin, "codex");
      const marker = join(home, "codex-executed");
      writeFileSync(codex, [
        "#!/bin/sh",
        `touch "${marker}"`,
        "if [ \"$1\" = \"--version\" ]; then echo 'codex 1.2.3'; exit 0; fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(codex, 0o755);

      const cached = detectLocalCliAgents().find((agent) => agent.id === "codex");
      expect(cached?.installed).toBe(false);

      const rescanned = detectLocalCliAgents({ rescan: true }).find((agent) => agent.id === "codex");
      expect(rescanned?.installed).toBe(true);
      expect(rescanned?.runnable).toBe(true);
      expect(rescanned?.version).toBe(null);
      expect(rescanned?.authStatus).toBe("unknown");
      expect(existsSync(marker)).toBe(false);

      const probed = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "codex");
      expect(probed?.installed).toBe(true);
      expect(probed?.runnable).toBe(true);
      expect(probed?.version).toBe("codex 1.2.3");
      expect(existsSync(marker)).toBe(true);
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rescan does not clear cached readiness, so the run path does not re-probe the shim", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-readiness-cache-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const codex = join(bin, "codex");
      const log = join(home, "codex-argv.log");
      writeFileSync(codex, [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${log}"`,
        "if [ \"$1\" = \"--version\" ]; then echo 'codex 1.2.3'; exit 0; fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(codex, 0o755);

      // Prime the readiness cache via a run-path lookup (auth check only, no --version).
      const primed = __runPathAgentReadinessForTests("codex");
      expect(primed.runnable).toBe(true);
      const invocationsAfterPrime = existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0;

      // A run's preflight rescans binaries on PATH. This must NOT wipe readiness.
      detectLocalCliAgents({ rescan: true });

      // The next run's readiness lookup should be a cache hit: the shim is not re-run.
      const cached = __runPathAgentReadinessForTests("codex");
      expect(cached.runnable).toBe(true);
      const invocationsAfterRescan = existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(invocationsAfterRescan).toBe(invocationsAfterPrime);
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("run-path readiness never invokes the version args, while probe does", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-readiness-version-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const codex = join(bin, "codex");
      const log = join(home, "codex-argv.log");
      writeFileSync(codex, [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${log}"`,
        "if [ \"$1\" = \"--version\" ]; then echo 'codex 1.2.3'; exit 0; fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(codex, 0o755);

      // Discover the freshly-installed binary but leave readiness un-probed.
      detectLocalCliAgents({ rescan: true });

      const runPath = __runPathAgentReadinessForTests("codex");
      expect(runPath.runnable).toBe(true);
      expect(runPath.version).toBe(null);
      const runPathArgv = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      expect(runPathArgv.some((line) => line.includes("--version"))).toBe(false);

      // The settings/probe path DOES fetch the version for display.
      const probed = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "codex");
      expect(probed?.version).toBe("codex 1.2.3");
      const probeArgv = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      expect(probeArgv.some((line) => line.includes("--version"))).toBe(true);
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects Antigravity CLI as runnable when agy is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const agy = join(bin, "agy");
      writeFileSync(agy, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo '1.0.0'; exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(agy, 0o755);

      const antigravity = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "antigravity");
      expect(antigravity?.installed).toBe(true);
      expect(antigravity?.runnable).toBe(true);
      expect(antigravity?.authStatus).toBe("unknown");
      expect(antigravity?.version).toBe("1.0.0");
      expect(antigravity?.path).toBe(agy);
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects Antigravity CLI from the desktop app shim directory", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-antigravity-shim-home-"));
    const bin = join(home, ".antigravity", "antigravity", "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: "/usr/bin", SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const agy = join(bin, "agy");
      writeFileSync(agy, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo '1.0.0'; exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(agy, 0o755);

      const antigravity = detectLocalCliAgents({ rescan: true }).find((agent) => agent.id === "antigravity");
      expect(antigravity?.installed).toBe(true);
      expect(antigravity?.runnable).toBe(true);
      expect(antigravity?.version).toBe(null);
      expect(antigravity?.path).toBe(agy);
    } finally {
      restoreEnv();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("marks Pi Codex unavailable until openai-codex auth exists", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-pi-codex-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const pi = join(bin, "pi");
      writeFileSync(pi, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'pi 0.1.0'; exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(pi, 0o755);

      const missing = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "pi-codex");
      expect(missing?.installed).toBe(true);
      expect(missing?.runnable).toBe(false);
      expect(missing?.authStatus).toBe("missing");
      expect(missing?.setupHint).toContain("Run Pi login");
      expect(missing?.setupHint).toContain("enter `/login`");
      expect(missing?.setupHint).toContain("OpenAI API keys do not authenticate");

      const authDir = join(home, ".pi", "agent");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({
        "openai-codex": { type: "oauth", accessToken: "token" },
      }), "utf8");

      const ready = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "pi-codex");
      expect(ready?.runnable).toBe(true);
      expect(ready?.authStatus).toBe("ready");
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("marks Pi Claude unavailable until anthropic auth exists", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-pi-claude-home-"));
    const bin = join(home, "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const pi = join(bin, "pi");
      writeFileSync(pi, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'pi 0.1.0'; exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(pi, 0o755);

      const missing = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "pi-claude");
      expect(missing?.installed).toBe(true);
      expect(missing?.runnable).toBe(false);
      expect(missing?.authStatus).toBe("missing");
      expect(missing?.setupHint).toContain("Run Pi login");
      expect(missing?.setupHint).toContain("enter `/login`");
      expect(missing?.setupHint).toContain("Claude Pro / Max");

      const authDir = join(home, ".pi", "agent");
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "auth.json"), JSON.stringify({
        anthropic: { type: "oauth", accessToken: "token" },
      }), "utf8");

      const ready = detectLocalCliAgents({ rescan: true, probe: true }).find((agent) => agent.id === "pi-claude");
      expect(ready?.runnable).toBe(true);
      expect(ready?.authStatus).toBe("ready");
    } finally {
      restoreEnv();
      __resetAgentReadinessForTests();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects Codex installed under fnm when the desktop app lacks the terminal PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "grok-wiki-agent-fnm-home-"));
    const bin = join(home, ".fnm", "node-versions", "v22.0.0", "installation", "bin");
    const restoreEnv = useIsolatedLocalCliEnv({ HOME: home, PATH: "/usr/bin", SHELL: "/bin/sh" });
    mkdirSync(bin, { recursive: true });
    try {
      const codex = join(bin, "codex");
      writeFileSync(codex, [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'codex 9.9.9'; exit 0; fi",
        "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi",
        "exit 0",
        "",
      ].join("\n"), "utf8");
      chmodSync(codex, 0o755);

      const codexStatus = detectLocalCliAgents({ rescan: true }).find((agent) => agent.id === "codex");
      expect(codexStatus?.installed).toBe(true);
      expect(codexStatus?.runnable).toBe(true);
      expect(codexStatus?.path).toBe(codex);
    } finally {
      restoreEnv();
      detectLocalCliAgents({ rescan: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
