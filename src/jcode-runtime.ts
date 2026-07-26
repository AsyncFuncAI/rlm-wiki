import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { LLMClient, LLMUsage } from "./llm-core.ts";
import { shouldInjectAgentSkills } from "./agent-skill-scope.ts";
import { extractJCodeStderrError, formatJCodeFailure, jcodeBinary } from "./jcode-errors.ts";
import { ensureJCodeModelCacheForRun } from "./jcode-model-cache.ts";
import { PROVIDER_SECRET_KEYS } from "./provider-secrets.ts";
import { normalizeRepoSourcePath } from "./types.ts";

export type RLMEventStatus = { type: "status"; phase: string; message: string };
export type RLMEventStreamDelta = { type: "stream-delta"; delta: string; replace?: boolean };
export type RLMEventStreamReasoningDelta = { type: "stream-reasoning-delta"; delta: string };
export type RLMEventStreamDone = { type: "stream-done"; text: string | null; usage: LLMUsage | null; error: Error | null };
export type RLMEventStep = { type: "step"; step: number; maxSteps: number; reasoning: string; code: string; output: string; resultType: string; tokenUsage: TokenUsage };
export type RLMEventToolStart = { type: "tool-start"; tool: string };
export type RLMEventToolDone = { type: "tool-done"; tool: string; durationMs: number };
export type RLMEventToolError = { type: "tool-error"; tool: string; durationMs: number; error: string };
export type RLMEventAgentLog = {
  type: "agent-log";
  kind: "status" | "reasoning" | "tool" | "tool-input" | "tool-output" | "tool-error" | "message";
  message: string;
  id?: string;
  tool?: string;
  reasoning?: string;
  input?: string;
  output?: string;
  error?: string;
  durationMs?: number;
};
export type RLMEventJITStart = { type: "jit-start"; step: number; code: string; llmCallBudget: number };
export type RLMEventJIT = { type: "jit"; step: number; code: string; output: string; resultType: string; durationMs: number; llmCalls: number; llmCallBudget: number };
export type RLMEventSubmit = { type: "submit"; answer: string; sources: string[] };
export type RLMEventUsage = { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
export type RLMEventError = { type: "error"; error: string; code?: string; provider?: string; command?: string; sourcePath?: string };

export type RLMEvent =
  | RLMEventStatus | RLMEventStreamDelta | RLMEventStreamDone | RLMEventStreamReasoningDelta
  | RLMEventStep | RLMEventToolStart | RLMEventToolDone | RLMEventToolError | RLMEventAgentLog
  | RLMEventJITStart | RLMEventJIT | RLMEventSubmit | RLMEventUsage | RLMEventError;

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

interface TrajectoryEntry {
  reasoning: string;
  code: string;
  output: string;
}

interface JCodeEventState {
  step: number;
  usage: TokenUsage;
  activeToolId: string;
  thinkingBuffer: string;
  /** Last fatal NDJSON error from jcode. jcode 0.58+ often exits 0 after type:error. */
  fatalError: string;
}

type JCodeSubprocess = {
  kill(signal?: string): void;
};

const activeJCodeProcesses = new Set<JCodeSubprocess>();
let processCleanupInstalled = false;

export interface RLMQueryResult {
  answer: string;
  sources: string[];
  trajectory: TrajectoryEntry[];
  finalReasoning: string;
  tokenUsage: TokenUsage;
  confidence?: string;
  [key: string]: unknown;
}

export interface JCodeModelClient extends LLMClient {
  providerArg: string;
  model: string;
  channelId?: string;
  label?: string;
  env?: Record<string, string | undefined>;
}

interface SourceSpec {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
}

export interface RLMOptions {
  source?: string;
  sources?: Array<string | SourceSpec>;
  mode?: "auto" | "repo" | "file" | "workspace" | "chat" | "rlm";
  branch?: string | null;
  sourcePath?: string | null;
  llm: LLMClient;
  subLM?: LLMClient;
  maxIterations?: number;
  maxLLMCalls?: number;
  maxOutputChars?: number;
  defaultAgent?: string;
  sandboxTimeout?: number;
  verbose?: boolean;
  optimizer?: boolean;
  githubToken?: string;
  githubFetch?: GitHubFetch;
  prMode?: boolean;
  mcpConfig?: MCPConfig;
  sessionDir?: string;
  resumeSessionId?: string;
  firstUserMessageSuffix?: string;
  contextLabel?: string;
  onEvent?: (event: RLMEvent) => void;
}

export type GitHubFetch = (path: string, extraHeaders?: Record<string, string>) => Promise<Response>;

export interface PreparedRun {
  cwd: string;
  diffCwd?: string;
  cleanup: () => Promise<void>;
  context: string;
}

export class JCodeAgent {
  private source: string | null;
  private sources: Array<string | SourceSpec> | null;
  private mode: RLMOptions["mode"];
  private branch: string | null | undefined;
  private sourcePath: string | null | undefined;
  private llm: LLMClient;
  private maxIterations: number;
  private mcpConfig: MCPConfig | null;
  private firstUserMessageSuffix: string;
  private contextLabel: string;
  private githubFetch: GitHubFetch | null;
  private onEvent: ((event: RLMEvent) => void) | null;
  private skillsPromptText = "";

  constructor(opts: Partial<RLMOptions>) {
    if (opts.source && opts.sources) {
      throw new Error("JCODE: use 'source' or 'sources', not both");
    }
    if (!opts.source && !opts.sources && opts.mode !== "chat") {
      throw new Error("JCODE: source or sources is required");
    }
    if (!opts.llm) throw new Error("JCODE: llm is required");

    this.source = opts.source ?? null;
    this.sources = opts.sources ?? null;
    this.mode = opts.mode ?? "auto";
    this.branch = opts.branch;
    this.sourcePath = opts.sourcePath;
    this.llm = opts.llm;
    this.maxIterations = opts.maxIterations ?? 20;
    this.mcpConfig = opts.mcpConfig ?? null;
    this.firstUserMessageSuffix = opts.firstUserMessageSuffix ?? "";
    this.contextLabel = opts.contextLabel ?? "";
    this.githubFetch = opts.githubFetch ?? null;
    this.onEvent = opts.onEvent ?? null;
  }

  setSkillsPromptText(text: string): void {
    this.skillsPromptText = text;
  }

  async query(prompt: string, signal?: AbortSignal): Promise<RLMQueryResult> {
    throwIfAborted(signal);
    const prepared = this.materializeMCPConfig(await this.prepareRun());
    const model = asJCodeModel(this.llm);
    const textChunks: string[] = [];
    const toolStarts = new Map<string, number>();
    const toolInputs = new Map<string, string>();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    let step = 0;
    let eventState: JCodeEventState = { step, usage, activeToolId: "", thinkingBuffer: "", fatalError: "" };
    let proc: (JCodeSubprocess & { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }) | null = null;

    try {
      const finalPrompt = this.buildPrompt(prompt, prepared.context);
      this.emit({ type: "status", phase: "jcode", message: `Starting agent in ${prepared.cwd}` });
      this.emit({ type: "agent-log", kind: "status", message: `Starting agent in ${prepared.cwd}` });

      const args = [
        "--no-update",
        "--quiet",
        "--provider", model.providerArg,
        "--model", model.model,
        // jcode 0.58 ships a broken `swarm` tool schema for some providers;
        // hide it so chat/agent runs do not fail before the first token.
        "--disabled-tools", "swarm",
        "-C", prepared.cwd,
        "run",
        "--ndjson",
        finalPrompt,
      ];

      throwIfAborted(signal);
      ensureJCodeModelCacheForRun(model.providerArg, model.model, model.env);
      const spawned = Bun.spawn([jcodeBinary(), ...args], {
        cwd: prepared.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: jcodeEnv(model),
      }) as JCodeSubprocess & { exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> };
      proc = spawned;
      trackJCodeProcess(spawned);
      const currentProc = spawned;
      let aborted = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const abortHandler = () => {
        aborted = true;
        try {
          currentProc.kill("SIGTERM");
        } catch {
          /* process may already be gone */
        }
        killTimer = setTimeout(() => {
          try {
            currentProc.kill("SIGKILL");
          } catch {
            /* process may already be gone */
          }
        }, 1500);
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }

      const stderrPromise = new Response(proc.stderr).text();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            throwIfAborted(signal);
            const parsed = safeJson(line);
            if (parsed) {
              eventState = this.handleJCodeEvent(parsed, textChunks, toolStarts, toolInputs, eventState);
              step = eventState.step;
              usage = eventState.usage;
            }
          }
          newline = buffer.indexOf("\n");
        }
      }

      const leftover = buffer.trim();
      if (leftover) {
          throwIfAborted(signal);
          const parsed = safeJson(leftover);
        if (parsed) {
          eventState = this.handleJCodeEvent(parsed, textChunks, toolStarts, toolInputs, eventState);
          step = eventState.step;
          usage = eventState.usage;
        }
      }

      const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (killTimer) clearTimeout(killTimer);
      if (aborted || signal?.aborted) throw new DOMException("Stopped by user.", "AbortError");
      this.flushThinkingLog(eventState, "Reasoning captured");
      const rawText = textChunks.join("").trim();
      // jcode 0.58 often reports provider failures as NDJSON {type:"error"} and
      // still exits 0. Treat those (and empty silent failures) as hard errors.
      const ndjsonError = eventState.fatalError.trim();
      const stderrError = extractJCodeStderrError(stderr);
      if (exitCode !== 0 || ndjsonError || (!rawText && stderrError)) {
        const failure = formatJCodeFailure({
          exitCode: exitCode !== 0 ? exitCode : 1,
          stderr: ndjsonError || stderrError || stderr,
          stdout: rawText,
          providerArg: model.providerArg,
          bin: jcodeBinary(),
        });
        if (!ndjsonError) {
          this.emit({ type: "error", error: failure.message, code: failure.code, provider: failure.provider, command: failure.command, sourcePath: failure.sourcePath });
        }
        throw new Error(failure.message);
      }

      const answer = extractAnswer(rawText);
      const sources = extractSources(rawText);
      this.emit({ type: "stream-done", text: rawText, usage: usageFromTokenUsage(usage), error: null });
      this.emit({ type: "submit", answer, sources });

      return {
        answer,
        sources,
        trajectory: [],
        finalReasoning: "",
        tokenUsage: usage,
      };
    } finally {
      if (proc) untrackJCodeProcess(proc);
      await prepared.cleanup();
    }
  }

  private handleJCodeEvent(
    event: Record<string, unknown>,
    textChunks: string[],
    toolStarts: Map<string, number>,
    toolInputs: Map<string, string>,
    state: JCodeEventState,
  ): JCodeEventState {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "start") {
      const provider = str(event.provider);
      const model = str(event.model);
      const detail = provider || model ? ` (${[provider, model].filter(Boolean).join(" · ")})` : "";
      this.emit({ type: "status", phase: "jcode", message: `Agent ready${detail}.` });
      this.emit({ type: "agent-log", kind: "status", message: `Agent ready${detail}.` });
    } else if (type === "text_delta") {
      const delta = str(event.text);
      if (delta) {
        const thinking = jcodeThinkingDelta(delta);
        if (thinking) {
          if (thinking.done) {
            this.flushThinkingLog(state, thinking.done);
          } else if (thinking.text) {
            state.thinkingBuffer += thinking.text;
          }
          return state;
        }
        textChunks.push(delta);
        this.emit({ type: "stream-delta", delta });
      }
    } else if (type === "text_replace") {
      const text = str(event.text);
      textChunks.splice(0, textChunks.length, text);
      this.emit({ type: "stream-delta", delta: text, replace: true });
    } else if (type === "tool_start") {
      const id = str(event.id) || crypto.randomUUID();
      const name = str(event.name) || "tool";
      toolStarts.set(id, Date.now());
      toolInputs.set(id, "");
      state.activeToolId = id;
      state.step += 1;
      this.emit({ type: "tool-start", tool: name });
      this.emit({ type: "agent-log", kind: "tool", id, tool: name, message: `Preparing ${name}` });
    } else if (type === "tool_input") {
      const delta = str(event.delta);
      if (delta && state.activeToolId) {
        toolInputs.set(state.activeToolId, `${toolInputs.get(state.activeToolId) ?? ""}${delta}`);
      }
    } else if (type === "tool_exec") {
      const id = str(event.id) || state.activeToolId;
      const name = str(event.name) || "tool";
      state.activeToolId = id;
      this.emit({
        type: "agent-log",
        kind: "tool-input",
        id,
        tool: name,
        message: `Using ${name}`,
        input: toolInputs.get(id) ?? "",
      });
    } else if (type === "tool_done") {
      const id = str(event.id);
      const name = str(event.name) || "tool";
      const durationMs = Math.max(0, Date.now() - (toolStarts.get(id) ?? Date.now()));
      const error = str(event.error);
      const output = str(event.output);
      if (error) {
        this.emit({ type: "tool-error", tool: name, durationMs, error });
        this.emit({ type: "agent-log", kind: "tool-error", id, tool: name, message: `${name} failed`, error, output, durationMs });
      } else {
        this.emit({ type: "tool-done", tool: name, durationMs });
        this.emit({ type: "agent-log", kind: "tool-output", id, tool: name, message: `${name} finished`, output, durationMs });
      }
      toolStarts.delete(id);
      toolInputs.delete(id);
      if (state.activeToolId === id) state.activeToolId = "";
    } else if (type === "tokens") {
      const promptTokens = num(event.input) + num(event.cache_read_input) + num(event.cache_creation_input);
      const completionTokens = num(event.output);
      state.usage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        calls: state.usage.calls + 1,
      };
      this.emit({ type: "usage", ...state.usage });
    } else if (type === "status_detail") {
      const detail = str(event.detail);
      if (detail) {
        this.emit({ type: "status", phase: "jcode", message: detail });
        this.emit({ type: "agent-log", kind: "status", message: detail });
      }
    } else if (type === "connection_phase") {
      const phase = str(event.phase);
      if (phase) {
        this.emit({ type: "status", phase: "connection", message: phase });
        this.emit({ type: "agent-log", kind: "status", message: phase });
      }
    } else if (type === "error") {
      const message = str(event.message) || "Agent reported an error";
      state.fatalError = message;
      this.emit({ type: "error", error: message });
    }
    return state;
  }

  private flushThinkingLog(state: JCodeEventState, message: string): void {
    const reasoning = state.thinkingBuffer.trim();
    if (!reasoning) return;
    this.emit({ type: "status", phase: "loop", message });
    this.emit({ type: "agent-log", kind: "reasoning", message, reasoning });
    state.thinkingBuffer = "";
  }

  private async prepareRun(): Promise<PreparedRun> {
    if (this.sources?.length) {
      const root = mkdtempSync(join(tmpdir(), "jcode-wiki-workspace-"));
      const workspace = await loadWorkspace(this.sources, { tmpDir: root, cache: false });
      const context = [
        "# Workspace Repositories",
        "The current working directory contains one subdirectory per repository:",
        ...workspace.repos.map((repo) => `- ${repo.id}: ${repo.repoPath} (${repo.source}${repo.sourcePath ? `, scope: ${repo.sourcePath}` : ""})`),
      ].join("\n");
      return {
        cwd: root,
        context,
        cleanup: async () => {
          await workspace.cleanupAll();
          rmSync(root, { recursive: true, force: true });
        },
      };
    }

    if (!this.source) {
      return { cwd: process.cwd(), context: "", cleanup: async () => {} };
    }

    const parsedPR = parsePRURL(this.source);
    if (parsedPR) {
      return loadPRWorkingTree(this.source, parsedPR, this.branch ?? null, this.githubFetch ?? undefined);
    }

    const loaded = await loadSource(this.source, { branch: this.branch, sourcePath: this.sourcePath, cache: this.mode !== "rlm" });
    return {
      cwd: loaded.repoPath,
      context: [
        "# Repository Context",
        `JCODE is running in the cloned repository at ${loaded.repoPath}.`,
        loaded.sourcePath ? `Only inspect and document the scoped repository path \`${loaded.sourcePath}\`.` : "",
      ].filter(Boolean).join("\n"),
      cleanup: loaded.cleanup,
    };
  }

  private materializeMCPConfig(prepared: PreparedRun): PreparedRun {
    const servers = this.mcpConfig?.mcpServers ?? {};
    if (!Object.keys(servers).length) return prepared;

    const dir = join(prepared.cwd, ".jcode");
    const path = join(dir, "mcp.json");
    const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ servers, mcpServers: servers }, null, 2) + "\n", "utf8");

    return {
      ...prepared,
      cleanup: async () => {
        if (previous === null) rmSync(path, { force: true });
        else writeFileSync(path, previous, "utf8");
        await prepared.cleanup();
      },
    };
  }

  private buildPrompt(prompt: string, context: string): string {
    const sections = [
      "# JCODE Runtime Contract",
      "You are JCODE, the agent now driving this product. Use JCODE's native tools directly; do not emit legacy JavaScript action blocks, JIT blocks, or SUBMIT calls.",
      "For repository work, inspect files with JCODE tools such as read, grep, glob, ls, bash, edit, write, apply_patch, and task as appropriate.",
      "If the task asks for a final <ANSWER> block, provide the answer in <ANSWER>...</ANSWER>. Do not add a trailing JavaScript SUBMIT block.",
      "Think Socratically before acting: what evidence would change the answer, which file or command can produce it, and what is the smallest verified next move?",
      this.mcpConfig && Object.keys(this.mcpConfig.mcpServers ?? {}).length
        ? "MCP servers are configured for this run. Use JCODE's MCP tooling when a connected external system is relevant."
        : "",
      context,
      this.skillsPromptText && shouldInjectAgentSkills(this.contextLabel)
        ? `# Loaded Skills\n${this.skillsPromptText}`
        : "",
      this.firstUserMessageSuffix ? `# Model-Specific Guidance\n${this.firstUserMessageSuffix}` : "",
      "# User Task",
      adaptPromptForJCode(prompt),
    ];
    return sections.filter((section) => section.trim()).join("\n\n");
  }

  private emit(event: RLMEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Event handlers are UI plumbing; never let them kill an agent run.
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Stopped by user.", "AbortError");
}

function trackJCodeProcess(proc: JCodeSubprocess): void {
  installProcessCleanup();
  activeJCodeProcesses.add(proc);
}

function untrackJCodeProcess(proc: JCodeSubprocess): void {
  activeJCodeProcesses.delete(proc);
}

function installProcessCleanup(): void {
  if (processCleanupInstalled) return;
  processCleanupInstalled = true;
  const terminateChildren = (): void => {
    for (const proc of activeJCodeProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* child may already be gone */
      }
    }
  };
  process.on("exit", terminateChildren);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      terminateChildren();
      setTimeout(() => {
        for (const proc of activeJCodeProcesses) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* child may already be gone */
          }
        }
        process.exit(128 + signalNumber(signal));
      }, 200).unref();
    });
  }
}

function signalNumber(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): number {
  switch (signal) {
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    case "SIGHUP":
      return 1;
  }
}

export const RLM = JCodeAgent;
export type RLM = JCodeAgent;

function asJCodeModel(client: LLMClient): JCodeModelClient {
  const maybe = client as Partial<JCodeModelClient>;
  return {
    ...client,
    providerArg: maybe.providerArg || "auto",
    model: maybe.model || "gpt-5.6-sol",
    channelId: maybe.channelId,
    label: maybe.label,
    env: maybe.env,
  } as JCodeModelClient;
}

function jcodeEnv(model: JCodeModelClient): Record<string, string> {
  const env: Record<string, string> = jcodeBaseEnv();
  env.JCODE_NON_INTERACTIVE = "1";
  env.JCODE_QUIET = "1";
  env.JCODE_SHOW_THINKING = "1";
  for (const [key, value] of Object.entries(model.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function jcodeBaseEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of PROVIDER_SECRET_KEYS) delete env[key];
  delete env.DEEPSEEK_API_KEYS;
  for (const key of Object.keys(env)) {
    if (/^DEEPSEEK_API_KEY_\d+$/.test(key)) delete env[key];
  }
  return env;
}

export function adaptPromptForJCode(prompt: string): string {
  return prompt
    // Only translate legacy harness/tool-contract wording. Do not rewrite
    // domain terms such as "RLM" or "rlm-bun" globally because they may be
    // the subject of the user's repository question.
    .replace(/You are running inside the rlm-bun JavaScript REPL sandbox\./gi, "You are running inside the JCODE native tool runtime.")
    .replace(/You are running inside an rlm-bun JavaScript sandbox\./gi, "You are running inside the JCODE native tool runtime.")
    .replace(/You are running inside an rlm-bun agent with JavaScript sandbox access to the cloned repository\./gi, "JCODE is running in the cloned repository.")
    .replace(/Use rlm-bun's JavaScript sandbox to inspect the repository directly\./gi, "Use JCODE native tools to inspect the repository directly.")
    .replace(/Use the rlm-bun JavaScript sandbox from the workspace root\./gi, "Use JCODE native tools from the workspace root.")
    .replace(/Use the rlm-bun JavaScript sandbox to inspect, edit, and verify this temporary git worktree\. Emit one executable JavaScript block per step while working\./gi, "Use JCODE native tools to inspect, edit, and verify this temporary git worktree.")
    .replace(/rlm-bun contract/gi, "JCODE contract")
    .replace(/then call `SUBMIT\(\{ sources: \[\.\.\.\] \}\)` in one js block\./gi, "")
    .replace(/After the <ANSWER> block, call SUBMIT\(\{ sources \}\) in one js block\./gi, "")
    .replace(/followed by a ```js block containing only `SUBMIT\(\{ sources: \[\.\.\.\] \}\)`/gi, "")
    .replace(/followed by a `SUBMIT\(\.\.\.\)` call/gi, "")
    .replace(/call `SUBMIT\(\{ sources: \[\.\.\.\] \}\)`|call `SUBMIT\(\{ sources \}\)`|call SUBMIT\(\{ sources \}\)/gi, "finish with the requested answer")
    .replace(/Do NOT include `<ANSWER>` tags or call `SUBMIT\(\.\.\.\)` in your first response\./gi, "Do not finalize in your first response.")
    .replace(/```js block/gi, "JCODE native tool call")
    .replace(/```js/gi, "```text");
}

function extractAnswer(text: string): string {
  const answer = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i);
  const raw = answer ? answer[1] : text;
  return raw
    .replace(/```(?:js|javascript|ts|typescript)\s*SUBMIT\s*\([\s\S]*?```/gi, "")
    .trim();
}

function extractSources(text: string): string[] {
  const sources = new Set<string>();
  const submit = text.match(/SUBMIT\s*\(\s*\{[\s\S]*?sources\s*:\s*(\[[\s\S]*?\])[\s\S]*?\}\s*\)/);
  if (submit) {
    try {
      const parsed = JSON.parse(submit[1]);
      if (Array.isArray(parsed)) parsed.map(String).filter(Boolean).forEach((source) => sources.add(source));
    } catch {
      // Ignore malformed legacy source telemetry.
    }
  }
  for (const match of text.matchAll(/\[([A-Za-z0-9_./@ -]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?)\]\(\)/g)) {
    sources.add(match[1].trim());
  }
  return [...sources];
}

function usageFromTokenUsage(usage: TokenUsage): LLMUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function jcodeThinkingDelta(text: string): { text?: string; done?: string } | null {
  const thoughtPrefix = "\u{1F4AD}";
  if (text.startsWith(thoughtPrefix)) {
    return { text: text.slice(thoughtPrefix.length).replace(/^\s+/, "") };
  }
  const clean = text.trim();
  if (/^Thought for \d+(?:\.\d+)?s\.?$/i.test(clean)) {
    return { done: clean };
  }
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface LoadSourceResult {
  repoPath: string;
  checkoutPath?: string;
  sourcePath?: string | null;
  cleanup: () => Promise<void>;
  cached: boolean;
}

export interface LoadedRepo {
  id: string;
  label: string;
  source: string;
  repoPath: string;
  sourcePath?: string | null;
  cleanup: () => Promise<void>;
  cached: boolean;
}

export interface WorkspaceResult {
  repos: LoadedRepo[];
  cleanupAll: () => Promise<void>;
}

export async function loadSource(source: string, opts: { branch?: string | null; sourcePath?: string | null; tmpDir?: string; cache?: boolean } = {}): Promise<LoadSourceResult> {
  if (isGitHubURL(source)) return cloneGitHub(source, opts);
  return resolveLocal(source, opts);
}

export async function loadWorkspace(sources: Array<string | SourceSpec>, opts: { branch?: string | null; sourcePath?: string | null; tmpDir?: string; cache?: boolean } = {}): Promise<WorkspaceResult> {
  if (!sources.length) throw new Error("loadWorkspace: at least one source is required");
  const used = new Set<string>();
  const specs = sources.map((raw) => {
    const spec = typeof raw === "string" ? { source: raw } : raw;
    const id = uniqueRepoId(spec.id || deriveRepoId(spec.source), used);
    const tmpDir = opts.tmpDir ? join(opts.tmpDir, id) : undefined;
    return { spec, id, tmpDir };
  });
  const repos = await Promise.all(specs.map(async ({ spec, id, tmpDir }) => {
    const loaded = await loadSource(spec.source, {
      branch: spec.branch ?? opts.branch,
      sourcePath: spec.sourcePath ?? opts.sourcePath,
      tmpDir,
      cache: tmpDir ? false : opts.cache,
    });
    return {
      id,
      label: spec.label || id,
      source: spec.source,
      repoPath: loaded.repoPath,
      sourcePath: loaded.sourcePath,
      cleanup: loaded.cleanup,
      cached: loaded.cached,
    } satisfies LoadedRepo;
  }));
  return {
    repos,
    cleanupAll: async () => {
      await Promise.allSettled(repos.map((repo) => repo.cleanup()));
    },
  };
}

function isGitHubURL(value: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\//.test(value) || /^git@github\.com:/.test(value);
}

function parseGitHubSource(source: string): { cloneURL: string; branch: string | null; sourcePath: string | null } {
  if (source.startsWith("git@")) return { cloneURL: source, branch: null, sourcePath: null };
  let cleaned = source.split(/[?#]/)[0]?.replace(/\/+$/, "") || source.replace(/\/+$/, "");
  const prMatch = cleaned.match(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/pull\/\d+(?:\/.*)?$/);
  if (prMatch) return { cloneURL: `${prMatch[1].replace("://www.github.com", "://github.com")}.git`, branch: null, sourcePath: null };
  const treeMatch = cleaned.match(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/tree\/(.+)$/);
  if (treeMatch) {
    const parsed = parseGitHubTreeRefPath(treeMatch[2]);
    return {
      cloneURL: `${treeMatch[1].replace("://www.github.com", "://github.com")}.git`,
      branch: parsed.branch,
      sourcePath: parsed.sourcePath,
    };
  }
  const blobMatch = cleaned.match(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/blob\/(.+)$/);
  if (blobMatch) {
    const parsed = parseGitHubTreeRefPath(blobMatch[2]);
    return {
      cloneURL: `${blobMatch[1].replace("://www.github.com", "://github.com")}.git`,
      branch: parsed.branch,
      sourcePath: parsed.sourcePath,
    };
  }
  if (!cleaned.endsWith(".git")) cleaned += ".git";
  cleaned = cleaned.replace("://www.github.com", "://github.com");
  return { cloneURL: cleaned, branch: null, sourcePath: null };
}

function isGitHubBranchNamespace(value: string): boolean {
  return ["feature", "feat", "fix", "bugfix", "hotfix", "release", "chore", "wip"].includes(value);
}

function isLikelyGitHubPathRoot(value: string): boolean {
  const clean = safeDecodePathSegment(value).trim().toLowerCase();
  return [
    ".github",
    "api",
    "app",
    "apps",
    "backend",
    "bin",
    "client",
    "cmd",
    "codex-rs",
    "crates",
    "docs",
    "examples",
    "frontend",
    "internal",
    "lib",
    "libs",
    "packages",
    "pkg",
    "public",
    "scripts",
    "server",
    "src",
    "test",
    "tests",
    "tools",
    "web",
  ].includes(clean);
}

function parseGitHubTreeRefPath(value: string): { branch: string | null; sourcePath: string | null } {
  const parts = String(value || "").split(/[?#]/)[0]?.split("/").filter(Boolean) || [];
  if (!parts.length) return { branch: null, sourcePath: null };
  if (parts.length <= 2 && isGitHubBranchNamespace(parts[0] || "")) {
    return {
      branch: parts.map((part) => safeDecodePathSegment(part).trim()).filter(Boolean).join("/") || null,
      sourcePath: null,
    };
  }
  if (
    isGitHubBranchNamespace(parts[0] || "") &&
    parts.length > 2 &&
    !isLikelyGitHubPathRoot(parts[1] || "")
  ) {
    const branch = parts
      .slice(0, 2)
      .map((part) => safeDecodePathSegment(part).trim())
      .filter(Boolean)
      .join("/") || null;
    return {
      branch,
      sourcePath: normalizeRepoSourcePath(parts.slice(2).join("/")),
    };
  }
  return {
    branch: parts[0] ? safeDecodePathSegment(parts[0]) : null,
    sourcePath: normalizeRepoSourcePath(parts.slice(1).join("/")),
  };
}

export function resolveGitHubLoadTarget(
  source: string,
  opts: { branch?: string | null; sourcePath?: string | null } = {},
): { cloneURL: string; branch: string | null; sourcePath: string | null } {
  const parsed = parseGitHubSource(source);
  return {
    cloneURL: parsed.cloneURL,
    branch: parsed.branch || opts.branch || null,
    sourcePath: normalizeRepoSourcePath(opts.sourcePath ?? parsed.sourcePath),
  };
}

async function cloneGitHub(source: string, opts: { branch?: string | null; sourcePath?: string | null; tmpDir?: string; cache?: boolean }): Promise<LoadSourceResult> {
  const { cloneURL, branch, sourcePath } = resolveGitHubLoadTarget(source, opts);
  const useCache = opts.cache !== false && !opts.tmpDir;
  const checkoutPath = useCache
    ? jcodeRepoCachePath(cloneURL, branch)
    : opts.tmpDir || join(tmpdir(), `jcode-wiki-${randomBytes(6).toString("hex")}`);

  if (existsSync(join(checkoutPath, ".git"))) {
    return scopedLoadSourceResult(checkoutPath, sourcePath, async () => {}, true);
  }

  if (existsSync(checkoutPath)) rmSync(checkoutPath, { recursive: true, force: true });
  mkdirSync(dirname(checkoutPath), { recursive: true });
  const args = ["clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  args.push(cloneURL, checkoutPath);
  runChecked("git", args);

  return scopedLoadSourceResult(checkoutPath, sourcePath, async () => {
    if (!useCache) rmSync(checkoutPath, { recursive: true, force: true });
  }, false);
}

async function resolveLocal(source: string, opts: { branch?: string | null; sourcePath?: string | null; tmpDir?: string } = {}): Promise<LoadSourceResult> {
  const repoPath = resolve(source);
  if (!existsSync(repoPath)) throw new Error(`Path does not exist: ${repoPath}`);
  if (!statSync(repoPath).isDirectory()) throw new Error(`Path is not a directory: ${repoPath}`);
  const branch = opts.branch?.trim() || null;
  const sourcePath = normalizeRepoSourcePath(opts.sourcePath);
  if (!existsSync(join(repoPath, ".git"))) {
    if (branch) throw new Error(`Branch or ref selection requires a git repository: ${repoPath}`);
    if (opts.tmpDir) {
      copyLocalFolder(repoPath, opts.tmpDir);
      return scopedLoadSourceResult(opts.tmpDir, sourcePath, async () => {
        rmSync(opts.tmpDir!, { recursive: true, force: true });
      }, false);
    }
    return scopedLoadSourceResult(repoPath, sourcePath, async () => {}, false);
  }
  if (branch) {
    const checkoutPath = opts.tmpDir || mkdtempSync(join(tmpdir(), "jcode-wiki-local-"));
    if (existsSync(checkoutPath)) rmSync(checkoutPath, { recursive: true, force: true });
    mkdirSync(dirname(checkoutPath), { recursive: true });
    cloneLocalSource(repoPath, checkoutPath, branch);
    return scopedLoadSourceResult(checkoutPath, sourcePath, async () => {
      rmSync(checkoutPath, { recursive: true, force: true });
    }, false);
  }
  if (opts.tmpDir) {
    cloneLocalSource(repoPath, opts.tmpDir);
    return scopedLoadSourceResult(opts.tmpDir, sourcePath, async () => {
      rmSync(opts.tmpDir!, { recursive: true, force: true });
    }, false);
  }
  return scopedLoadSourceResult(repoPath, sourcePath, async () => {}, false);
}

function scopedLoadSourceResult(
  checkoutPath: string,
  sourcePath: string | null,
  cleanup: () => Promise<void>,
  cached: boolean,
): LoadSourceResult {
  const repoPath = sourcePath ? join(checkoutPath, sourcePath) : checkoutPath;
  if (sourcePath && (!existsSync(repoPath) || !statSync(repoPath).isDirectory())) {
    throw new Error(`Source path does not exist in repository: ${sourcePath}`);
  }
  return {
    repoPath,
    checkoutPath,
    sourcePath,
    cleanup,
    cached,
  };
}

function cloneLocalSource(sourcePath: string, targetPath: string, branch: string | null = null): void {
  // git ignores --depth for local clones and copies the FULL object store, which
  // costs tens of seconds on large repos (measured 17.7s vs 0.5s shared on a 206MB
  // checkout) and runs on EVERY ask. --shared borrows objects from the source via
  // alternates so only the worktree checkout is paid; the clone is a short-lived
  // per-run scratch dir, the same lifetime as the sidecar's shared clones from the
  // GitHub cache (cloneLocalRepository), so the alternates stay valid.
  const branchArgs = branch ? ["--branch", branch] : [];
  const shared = Bun.spawnSync(["git", "clone", "--shared", "--quiet", ...branchArgs, sourcePath, targetPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (shared.exitCode === 0) return;
  rmSync(targetPath, { recursive: true, force: true });
  runChecked("git", ["clone", "--depth", "1", ...branchArgs, sourcePath, targetPath]);
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const LOCAL_FOLDER_COPY_IGNORES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

function copyLocalFolder(sourcePath: string, targetPath: string): void {
  if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const name = basename(path);
      return !LOCAL_FOLDER_COPY_IGNORES.has(name);
    },
  });
}

function jcodeRepoCachePath(cloneURL: string, branch?: string | null): string {
  const key = createHash("sha256").update(`${cloneURL}#${branch ?? ""}`).digest("hex").slice(0, 16);
  return join(homedir(), ".jcode-wiki", "repo-cache", `${basename(cloneURL, ".git")}-${key}`);
}

function deriveRepoId(source: string): string {
  const clean = source.replace(/\/+$/, "").replace(/\.git$/, "");
  return (clean.split("/").pop() || "repo").toLowerCase().replace(/[^a-z0-9-]/g, "") || "repo";
}

function uniqueRepoId(base: string, used: Set<string>): string {
  let id = base.toLowerCase().replace(/[^a-z0-9-]/g, "") || "repo";
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

export async function loadPRWorkingTree(
  url: string,
  parsed: { owner: string; repo: string; number: number },
  branch: string | null,
  githubFetch?: GitHubFetch,
  opts: { tmpDir?: string } = {},
): Promise<PreparedRun> {
  const prData = await fetchPRData(parsed.owner, parsed.repo, parsed.number, { githubFetch });
  const cloneURL = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const root = opts.tmpDir || mkdtempSync(join(tmpdir(), "jcode-wiki-pr-"));
  mkdirSync(root, { recursive: true });
  const repoPath = join(root, `${parsed.repo}-pr-${parsed.number}`);
  const cloneArgs = ["clone", "--depth", "1"];
  if (branch || prData.info.baseBranch) cloneArgs.push("--branch", branch || prData.info.baseBranch);
  cloneArgs.push(cloneURL, repoPath);
  runChecked("git", cloneArgs);
  runChecked("git", ["fetch", "origin", `pull/${parsed.number}/head:jcode-pr-${parsed.number}`], repoPath);
  runChecked("git", ["checkout", `jcode-pr-${parsed.number}`], repoPath);

  const context = [
    "# Pull Request Context",
    `URL: ${url}`,
    `Title: ${prData.info.title}`,
    `Author: ${prData.info.author}`,
    `Base: ${prData.info.baseBranch} (${prData.info.baseSHA})`,
    `Head: ${prData.info.headBranch} (${prData.info.headSHA})`,
    "",
    "## Changed Files",
    ...prData.diff.changedFiles.map((file) => `- ${file.status}: ${file.filename} (+${file.additions}/-${file.deletions})`),
    "",
    "## Diff",
    "```diff",
    prData.diff.diff,
    "```",
    prData.conversation.issueComments.length || prData.conversation.reviewComments.length || prData.conversation.reviews.length
      ? [
          "",
          "## Conversation",
          ...prData.conversation.issueComments.map((comment) => `Issue comment by ${comment.author}: ${comment.body}`),
          ...prData.conversation.reviewComments.map((comment) => `Review comment by ${comment.author} on ${comment.path}:${comment.line}: ${comment.body}`),
          ...prData.conversation.reviews.map((review) => `Review ${review.state} by ${review.author}: ${review.body}`),
        ].join("\n")
      : "",
  ].filter(Boolean).join("\n");

  return {
    cwd: repoPath,
    context,
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
}

function runChecked(command: string, args: string[], cwd = process.cwd()): void {
  const proc = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    throw new Error(`${command} ${args.join(" ")} failed (${proc.exitCode}): ${stderr || stdout}`);
  }
}

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headOwner?: string;
  headRepo?: string;
  headSHA: string;
  baseSHA: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergeableState: string;
  labels: string[];
}

export interface PRDiff {
  diff: string;
  changedFiles: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
}

export interface PRConversation {
  issueComments: Array<{ id: number; author: string; body: string; createdAt: string; updatedAt: string }>;
  reviewComments: Array<{ id: number; author: string; body: string; path: string; line: number; side: string; createdAt: string; updatedAt: string; resolved?: boolean }>;
  reviews: Array<{ id: number; author: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; body: string; submittedAt: string }>;
  commitMessages: string[];
}

export interface PRData {
  info: PRInfo;
  diff: PRDiff;
  conversation: PRConversation;
}

export function parsePRURL(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
}

export async function fetchPRData(owner: string, repo: string, prNumber: number, opts: { githubToken?: string; maxDiffBytes?: number; githubFetch?: GitHubFetch } = {}): Promise<PRData> {
  const token = opts.githubFetch ? undefined : opts.githubToken || await resolveGithubToken();
  const maxDiffBytes = opts.maxDiffBytes ?? 500_000;
  const base = `/repos/${owner}/${repo}`;
  const apiFetch = opts.githubFetch
    ? (path: string, extraHeaders?: Record<string, string>) => checkedGitHubFetch(opts.githubFetch!, path, extraHeaders)
    : (path: string, extraHeaders?: Record<string, string>) => ghFetch(path, token, extraHeaders);
  const [prRes, diffRes, issueComments, reviewComments, reviews, commits, filesRes] = await Promise.all([
    apiFetch(`${base}/pulls/${prNumber}`),
    apiFetch(`${base}/pulls/${prNumber}`, { Accept: "application/vnd.github.v3.diff" }),
    paginateJSON<any>(`${base}/issues/${prNumber}/comments`, apiFetch),
    paginateJSON<any>(`${base}/pulls/${prNumber}/comments`, apiFetch),
    paginateJSON<any>(`${base}/pulls/${prNumber}/reviews`, apiFetch),
    paginateJSON<any>(`${base}/pulls/${prNumber}/commits`, apiFetch),
    apiFetch(`${base}/pulls/${prNumber}/files?per_page=100`),
  ]);

  const pr = await prRes.json() as any;
  let diff = await diffRes.text();
  if (diff.length > maxDiffBytes) diff = `${diff.slice(0, maxDiffBytes)}\n\n... [diff truncated at ${maxDiffBytes} bytes] ...`;
  const files = await filesRes.json() as any[];

  return {
    info: {
      owner,
      repo,
      number: prNumber,
      title: pr.title ?? "",
      body: pr.body ?? "",
      state: pr.state ?? "",
      draft: pr.draft ?? false,
      baseBranch: pr.base?.ref ?? "",
      headBranch: pr.head?.ref ?? "",
      headOwner: pr.head?.repo?.owner?.login ?? pr.head?.user?.login ?? owner,
      headRepo: pr.head?.repo?.name ?? repo,
      headSHA: pr.head?.sha ?? "",
      baseSHA: pr.base?.sha ?? "",
      author: pr.user?.login ?? "",
      createdAt: pr.created_at ?? "",
      updatedAt: pr.updated_at ?? "",
      mergeableState: pr.mergeable_state ?? "",
      labels: (pr.labels ?? []).map((label: any) => label.name).filter(Boolean),
    },
    diff: {
      diff,
      changedFiles: files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      })),
    },
    conversation: {
      issueComments: issueComments.map((comment: any) => ({
        id: comment.id,
        author: comment.user?.login ?? "",
        body: comment.body ?? "",
        createdAt: comment.created_at ?? "",
        updatedAt: comment.updated_at ?? "",
      })),
      reviewComments: reviewComments.map((comment: any) => ({
        id: comment.id,
        author: comment.user?.login ?? "",
        body: comment.body ?? "",
        path: comment.path ?? "",
        line: comment.line ?? comment.original_line ?? 0,
        side: comment.side ?? "RIGHT",
        createdAt: comment.created_at ?? "",
        updatedAt: comment.updated_at ?? "",
        resolved: comment.resolved,
      })),
      reviews: reviews.map((review: any) => ({
        id: review.id,
        author: review.user?.login ?? "",
        state: review.state ?? "COMMENTED",
        body: review.body ?? "",
        submittedAt: review.submitted_at ?? "",
      })),
      commitMessages: commits.map((commit: any) => commit.commit?.message ?? "").filter(Boolean),
    },
  };
}

async function resolveGithubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) {
      const token = new TextDecoder().decode(proc.stdout).trim();
      return token || undefined;
    }
  } catch {
    // Optional gh fallback.
  }
  return undefined;
}

async function ghFetch(path: string, token?: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "jcode-wiki",
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  return response;
}

async function checkedGitHubFetch(fetcher: GitHubFetch, path: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const response = await fetcher(path, extraHeaders);
  if (response.status === 404) throw new Error(`GitHub API error 404: ${path} not found`);
  if (response.status === 403) throw new Error(`GitHub API error 403: Access denied or rate limited. ${await response.text()}`);
  if (!response.ok) throw new Error(`GitHub API error ${response.status}: ${await response.text()}`);
  return response;
}

async function paginateJSON<T>(
  path: string,
  apiFetch: (path: string, extraHeaders?: Record<string, string>) => Promise<Response>,
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const response = await apiFetch(`${path}${sep}per_page=100&page=${page}`);
    const data = await response.json() as T[];
    if (!data.length) break;
    results.push(...data);
  }
  return results;
}

export interface MCPServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPToolInfo {
  server: string;
  tool: string;
  callAs: string;
  description: string;
  inputSchema?: unknown;
}

export type ParsedSkillSource =
  | {
      type: "github";
      owner: string;
      repo: string;
      ref?: string;
      path?: string;
      source: string;
    }
  | {
      type: "local";
      path?: string;
      source: string;
    };

export interface SkillRecord {
  name: string;
  description: string;
  source: string;
  content: string;
}

export function loadMCPConfig(cwd = process.cwd()): MCPConfig | null {
  for (const path of [
    join(cwd, ".jcode", "mcp.json"),
    join(cwd, ".mcp.json"),
    join(homedir(), ".jcode", "mcp.json"),
  ]) {
      if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        const row = parsed as { mcpServers?: Record<string, MCPServerConfig>; servers?: Record<string, MCPServerConfig> };
        const mcpServers = row.mcpServers ?? row.servers;
        if (mcpServers) return { mcpServers };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function connectMCPServer(name: string, _config: MCPServerConfig): Promise<{ name: string; tools: Array<{ name: string; description?: string; inputSchema?: unknown }>; cleanup: () => Promise<void> }> {
  return {
    name,
    tools: [],
    cleanup: async () => {},
  };
}

export class SkillRegistry {
  private records: SkillRecord[] = [];

  async add(source: string): Promise<SkillRecord[]> {
    const parsed = parseSkillSource(source);
    const root = parsed.type === "github" ? cloneSkillRepo(parsed) : resolve(parsed.path || parsed.source);
    const skillFiles = findSkillFiles(root, parsed.path);
    const loaded = skillFiles.map(readSkillFile);
    this.records.push(...loaded);
    this.writeManifest(source);
    return loaded;
  }

  async restoreFromManifest(): Promise<string[]> {
    const manifest = readSkillManifest();
    const restored: string[] = [];
    for (const source of manifest.sources) {
      try {
        const loaded = await this.add(source);
        if (loaded.length) restored.push(source);
      } catch {
        // Ignore stale skill entries.
      }
    }
    return restored;
  }

  list(): SkillRecord[] {
    return [...this.records];
  }

  formatForPrompt(): string {
    if (!this.records.length) return "";
    return this.records
      .map((skill) => [
        `## ${skill.name}`,
        skill.description,
        "",
        skill.content,
      ].filter(Boolean).join("\n"))
      .join("\n\n---\n\n");
  }

  private writeManifest(source: string): void {
    const dir = join(process.cwd(), ".jcode");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "skills.json");
    const manifest = readSkillManifest(path);
    if (!manifest.sources.includes(source)) manifest.sources.push(source);
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
}

export function parseSkillSource(source: string): ParsedSkillSource {
  const trimmed = source.trim();
  const github = trimmed.match(/^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/@\s]+)(?:\/tree\/([^/\s]+)\/(.+)|\/(.+?))?(?:@([^/\s]+))?$/);
  if (github && !trimmed.startsWith("/") && !trimmed.startsWith(".")) {
    return {
      type: "github",
      owner: github[1],
      repo: github[2].replace(/\.git$/, ""),
      ref: github[3] || github[6],
      path: github[4] || github[5],
      source: trimmed,
    };
  }
  return { type: "local", path: trimmed, source: trimmed };
}

function cloneSkillRepo(parsed: ParsedSkillSource): string {
  if (parsed.type !== "github" || !parsed.owner || !parsed.repo) throw new Error("Not a GitHub skill source");
  const cache = join(homedir(), ".jcode", "skills-cache", `${parsed.owner}__${parsed.repo}${parsed.ref ? `__${parsed.ref}` : ""}`);
  if (!existsSync(join(cache, ".git"))) {
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(dirname(cache), { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (parsed.ref) args.push("--branch", parsed.ref);
    args.push(`https://github.com/${parsed.owner}/${parsed.repo}.git`, cache);
    runChecked("git", args);
  }
  return parsed.path ? join(cache, parsed.path) : cache;
}

function findSkillFiles(root: string, preferredPath?: string): string[] {
  const direct = existsSync(join(root, "SKILL.md")) ? [join(root, "SKILL.md")] : [];
  if (direct.length || preferredPath) return direct;
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = Array.from(new Bun.Glob("*").scanSync({ cwd: current, onlyFiles: false }));
    for (const entry of entries) {
      const path = join(current, entry);
      if (basename(path) === ".git") continue;
      const stat = statSync(path);
      if (stat.isDirectory()) stack.push(path);
      else if (basename(path) === "SKILL.md") files.push(path);
    }
  }
  return files;
}

function readSkillFile(path: string): SkillRecord {
  const content = readFileSync(path, "utf8");
  const name = basename(dirname(path));
  const description = content.match(/description:\s*(.+)/i)?.[1]?.trim()
    || content.split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim()
    || "";
  return { name, description, source: path, content };
}

function readSkillManifest(path = join(process.cwd(), ".jcode", "skills.json")): { sources: string[] } {
  if (!existsSync(path)) return { sources: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const sources = Array.isArray(parsed.sources) ? parsed.sources.map(String).filter(Boolean) : [];
    return { sources };
  } catch {
    return { sources: [] };
  }
}

export function buildWorkspaceQuery(goal: string, repoIds: string[], userQuery?: string): string {
  const repoList = repoIds.join(", ");
  const task = userQuery || "Analyze these repositories.";
  const goals: Record<string, string> = {
    compare: `Compare the repositories ${repoList}. Build an evidence-backed feature and architecture comparison, citing files from each repo.`,
    steal: `Find features or patterns worth porting among ${repoList}. Identify source implementation files, target analogs, risks, and a prioritized porting plan. Task: ${task}`,
    understand: `Explain how the repositories ${repoList} relate, where their architectures overlap, and where they differ. Task: ${task}`,
    bridge: `Create a feature-gap matrix and bridge plan across ${repoList}. Task: ${task}`,
    audit: `Audit shared patterns, risks, and best practices across ${repoList}. Task: ${task}`,
  };
  return goals[goal] || `${task}\n\nRepositories: ${repoList}`;
}
