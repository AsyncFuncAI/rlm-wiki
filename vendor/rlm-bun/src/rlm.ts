import { z } from "zod";
import { existsSync, rmSync, unlinkSync } from "fs";
import { resolve, join } from "path";
import { loadSource, loadWorkspace, isPRURL } from "./source-loader.ts";
import type { LoadedRepo } from "./source-loader.ts";
import { fetchPRData, parsePRURL, type GitHubFetch } from "./github/pr-fetcher.ts";
import { buildPRReviewPrompt } from "./prompts/pr-review.ts";
import { loadFileSource } from "./file-loader.ts";
import { buildRepoIndex, formatGraphContext, formatGraphContextMulti } from "./repo-index.ts";
import type { RepoIndex } from "./repo-index.ts";
import { buildFileIndex } from "./file-index.ts";
import { BunSandbox } from "./sandbox/bun-sandbox.js";
import { buildRepoTools, buildToolWrappers, buildWorkspaceTools } from "./sandbox/tools.js";
import { buildFileTools } from "./sandbox/file-tools.js";
import { buildGraphifyTools, buildGraphifyToolsMulti } from "./sandbox/graphify-tools.js";
import { extractDefinedVars, extractKeyFindings } from "./state/session-utils.js";
import { FileSession } from "./state/session.ts";
import type { Session, SessionQueryOpts } from "./state/session.ts";
import { makeLLMTools, makeLSPTools, makeWebSearchTool } from "./llm/tools.ts";
import { buildActionPrompt, buildFollowUpPrompt, buildSessionIterationPrompt } from "./prompts/action.js";
import { buildRLMPrompt, buildRLMIterationPrompt, buildRLMWorkspacePrompt } from "./prompts/rlm-action.js";
import { buildFileAnalysisPrompt } from "./prompts/file-analysis.js";
import { buildExtractPrompt } from "./prompts/extract.js";
import { buildWorkspaceActionPrompt } from "./prompts/workspace-action.js";
import { buildGeneralistPrompt } from "./prompts/generalist.ts";
import { optimizeQuery } from "./prompts/query-optimizer.ts";
import type { LLMClient, LLMUsage, StreamEvent } from "./llm/types.ts";
import { loadMCPConfig, connectAllMCPServers } from "./mcp/client.ts";
import type { MCPConfig } from "./mcp/client.ts";
import { makeMCPTools, buildMCPPromptSection } from "./mcp/tools.ts";

// ── Event types ──────────────────────────────────────────────────

export type RLMEventStatus = { type: "status"; phase: string; message: string };
export type RLMEventStreamDelta = { type: "stream-delta"; delta: string };
export type RLMEventStreamReasoningDelta = { type: "stream-reasoning-delta"; delta: string };
export type RLMEventStreamDone = { type: "stream-done"; text: string | null; usage: LLMUsage | null; error: Error | null };
export type RLMEventStep = { type: "step"; step: number; maxSteps: number; reasoning: string; code: string; output: string; resultType: string; tokenUsage: TokenUsage };
export type RLMEventToolStart = { type: "tool-start"; tool: string };
export type RLMEventToolDone = { type: "tool-done"; tool: string; durationMs: number };
export type RLMEventToolError = { type: "tool-error"; tool: string; durationMs: number; error: string };
export type RLMEventJITStart = {
  type: "jit-start";
  step: number;
  code: string;
  llmCallBudget: number;
};
export type RLMEventJIT = {
  type: "jit";
  step: number;
  code: string;
  output: string;
  resultType: string;
  durationMs: number;
  llmCalls: number;
  llmCallBudget: number;
};
export type RLMEventSubmit = { type: "submit"; answer: string; sources: string[] };
export type RLMEventUsage = { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
export type RLMEventError = { type: "error"; error: string };

export type RLMEvent =
  | RLMEventStatus | RLMEventStreamDelta | RLMEventStreamDone
  | RLMEventStreamReasoningDelta
  | RLMEventStep | RLMEventToolStart | RLMEventToolDone | RLMEventToolError
  | RLMEventJITStart | RLMEventJIT | RLMEventSubmit | RLMEventUsage | RLMEventError;

// ── Token usage ──────────────────────────────────────────────────

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

// ── Trajectory entry ─────────────────────────────────────────────

interface TrajectoryEntry {
  reasoning: string;
  code: string;
  output: string;
}

// ── Query result ─────────────────────────────────────────────────

export interface RLMQueryResult {
  answer: string;
  sources: string[];
  trajectory: TrajectoryEntry[];
  finalReasoning: string;
  tokenUsage: TokenUsage;
  confidence?: string;
  /** Internal state for follow-ups — not serialized to user */
  _messages?: ChatMessage[];
  [key: string]: unknown;
}

// ── Chat message ─────────────────────────────────────────────────

interface ChatMessage {
  role: string;
  content: string;
}

// ── Source spec ───────────────────────────────────────────────────

interface SourceSpec {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
}

// ── Callback types ───────────────────────────────────────────────

type EventCallback = (event: RLMEvent) => void;
type StepCallback = (step: { step: number; maxSteps: number; reasoning: string; code: string; output: string; type: string; tokenUsage: TokenUsage }) => void;
type StatusCallback = (status: { phase: string; message: string }) => void;
type StreamCallbackLegacy = (event: StreamEvent) => void;

// ── RLM Options Zod Schema ───────────────────────────────────────

export const RLMOptionsSchema = z.object({
  source: z.string().optional(),
  sources: z.array(z.union([z.string(), z.object({
    id: z.string().optional(),
    source: z.string(),
    branch: z.string().nullish(),
    sourcePath: z.string().nullish(),
    label: z.string().optional(),
  })])).optional(),
  mode: z.enum(["auto", "repo", "file", "workspace", "chat", "rlm"]).default("auto"),
  branch: z.string().nullish(),
  sourcePath: z.string().nullish(),
  llm: z.custom<LLMClient>((val) => val != null && typeof val === "object"),
  subLM: z.custom<LLMClient>((val) => val != null && typeof val === "object").optional(),
  maxIterations: z.number().positive().default(20),
  maxLLMCalls: z.number().positive().default(5000),
  maxOutputChars: z.number().positive().default(10_000),
  maxJITProbesPerIteration: z.number().int().min(0).default(3),
  maxJITLLMCallsPerIteration: z.number().int().min(0).default(1),
  jitProbeTimeout: z.number().positive().default(5_000),
  jitProbeLLMTimeout: z.number().positive().default(15_000),
  jitProbeMaxOutputChars: z.number().positive().default(4_000),
  subLLMMaxOutputTokens: z.number().positive().max(4096).default(4096),
  subLLMAgentMaxTurns: z.number().int().positive().max(12).default(4),
  recursiveFinalGate: z.union([z.boolean(), z.literal("auto")]).default("auto"),
  defaultAgent: z.string().optional(),
  sandboxTimeout: z.number().positive().default(30_000),
  verbose: z.boolean().default(false),
  optimizer: z.boolean().default(false),
  githubToken: z.string().optional(),
  githubFetch: z.custom<GitHubFetch>((val) => typeof val === "function").optional(),
  prMode: z.boolean().optional().default(false),
  mcpConfig: z.custom<MCPConfig>((val) => val == null || typeof val === "object").optional(),
  sessionDir: z.string().optional(),
  resumeSessionId: z.string().optional(),
  firstUserMessageSuffix: z.string().optional(),
  onEvent: z.function().optional() as z.ZodType<EventCallback | undefined>,
  onStep: z.function().optional() as z.ZodType<StepCallback | undefined>,
  onStatus: z.function().optional() as z.ZodType<StatusCallback | undefined>,
  onStream: z.function().optional() as z.ZodType<StreamCallbackLegacy | undefined>,
});

export type RLMOptions = z.infer<typeof RLMOptionsSchema>;

// ── Analysis mode ────────────────────────────────────────────────

type AnalysisMode = "repo" | "file" | "workspace" | "chat" | "rlm";

/** Iteration prompt builder signature — stored in SessionSetup so _executeLoop is mode-agnostic. */
type IterPromptBuilder = (session: Session, iteration: number, maxIterations: number, llmCalls: number, maxLLMCalls: number) => string;

function generatedCodeParseIssue(code: string): string | null {
  try {
    new Function(`return (async () => {\n${code}\n})()`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function countRegexMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function generatedExplorationContractIssue(code: string, query = ""): string | null {
  if (/\bSUBMIT\s*\(/.test(code)) return null;

  const readFileCalls = countRegexMatches(code, /\breadFile\s*\(/g);
  const focusedReadCalls = countRegexMatches(code, /\breadFileRange\s*\(/g);
  const discoveryCalls = countRegexMatches(
    code,
    /\b(?:rg|grep|glob|inspect|listFiles|searchAll|listRepos|listSymbols|lsp_query|graphifyQuery|graphifyExplain)\s*\(/g,
  );
  const bulkRead =
    /\.map\s*\([^)]*(?:readFile|readFileRange)/is.test(code) ||
    (/\bPromise\.all\s*\(/.test(code) && readFileCalls >= 4);
  const mappingQuestion = /\b(?:where|implementation|architecture|trace|flow|lifecycle|review|audit|rendering|pipeline|entry[\s-]?point|wire|wiring)\b/i.test(
    `${query}\n${code}`,
  );
  const manualLineSlicing = /\breadFile\s*\([\s\S]{0,240}\.split\s*\(\s*["'`]\\n["'`]\s*\)|\.split\s*\(\s*["'`]\\n["'`]\s*\)[\s\S]{0,240}\.slice\s*\(/i.test(code);

  if (bulkRead) {
    return "The generated step bulk-reads files. First use rg/glob/inspect/listFiles to build a candidate map, then read only the few spans that answer the question.";
  }
  if (mappingQuestion && readFileCalls >= 3 && focusedReadCalls === 0 && discoveryCalls === 0) {
    return `The generated step opens ${readFileCalls} whole files for a mapping question. Use rg/inspect/listSymbols results and readFileRange around exact symbols instead of whole-file reads.`;
  }
  if (mappingQuestion && readFileCalls >= 2 && focusedReadCalls === 0 && manualLineSlicing) {
    return "The generated step reads whole files and manually slices line windows. Use readFileRange(path, startLine, endLine) for those exact spans instead.";
  }
  if (readFileCalls >= 4 && discoveryCalls < 2) {
    return `The generated step calls readFile ${readFileCalls} times with only ${discoveryCalls} discovery calls. Break it down: run rg/glob/inspect first, print the candidate map with line numbers, then use readFileRange or one focused read.`;
  }
  if (readFileCalls >= 8) {
    return `The generated step calls readFile ${readFileCalls} times. This is a broad sweep; split it into smaller targeted steps and prefer readFileRange for exact evidence spans.`;
  }

  return null;
}

function hasSubmitCall(code: string): boolean {
  return /\bSUBMIT\s*\(/.test(code);
}

function hasSemanticSubLLMCall(code: string): boolean {
  return /\b(?:llmQuery|llmQueryBatched|llmQueryAgent|llm_query|llm_query_batched|llm_query_agent|rlmQuery|rlm_query|rlmQueryAgent|rlm_query_agent)\s*\(/.test(code);
}

function isDirectRetrievalQuery(query: string): boolean {
  const text = query.toLowerCase();
  if (/\b(?:how|why|architecture|architectural|review|audit|compare|comparison|implement|fix|debug|trace|flow|lifecycle|design|recommend|should|explain|summari[sz]e|analy[sz]e|reverse engineer)\b/.test(text)) {
    return false;
  }
  return /\b(?:first line|last line|line\s+\d+|what(?:'s| is)?\s+(?:the\s+)?(?:value|version|name|license|output|contents?)|show\s+(?:me\s+)?(?:the\s+)?(?:file|line|symbol|command output)|read\s+(?:the\s+)?(?:file|line|symbol)|does\s+.+\s+(?:contain|say))\b/.test(text);
}

function directRetrievalEvidenceReady(session: Session | null, query: string): boolean {
  if (!session || !isDirectRetrievalQuery(query)) return false;
  const outputEvents = session.getEvents({ type: "output" });
  if (outputEvents.length === 0 || outputEvents.length > 2) return false;

  const counts: Record<string, number> = {};
  const readFiles = new Set<string>();
  for (const event of outputEvents) {
    for (const file of event.metadata?.readFiles ?? []) {
      if (typeof file === "string" && file.trim()) readFiles.add(file.trim());
    }
    for (const [tool, count] of Object.entries(event.metadata?.toolCounts ?? {})) {
      counts[tool] = (counts[tool] ?? 0) + count;
    }
  }

  const allowed = new Set(["readFile", "readFileRange", "inspect", "rg", "grep", "glob", "listSymbols", "gitStatus", "gitLog", "bash"]);
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return false;
  if (entries.some(([tool]) => !allowed.has(tool))) return false;
  const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);
  if (totalCalls > 2) return false;
  if (readFiles.size > 1) return false;
  return true;
}

function directRetrievalSubmitCode(code: string, query: string): boolean {
  if (!hasSubmitCall(code) || !isDirectRetrievalQuery(query)) return false;
  const counts: Record<string, number> = {};
  for (const tool of ["readFile", "readFileRange", "inspect", "rg", "grep", "glob", "listSymbols", "gitStatus", "gitLog", "bash"]) {
    counts[tool] = countRegexMatches(code, new RegExp(String.raw`\b${tool}\s*\(`, "g"));
  }
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);
  if (totalCalls === 0 || totalCalls > 2) return false;
  if (countRegexMatches(code, /\b(?:Promise\.all|\.map\s*\(|for\s*\(|for\s+await|while\s*\()/g) > 0) return false;
  return true;
}

function hasExplorationToolCall(code: string): boolean {
  return /\b(?:readFile|readFileRange|rg|grep|glob|inspect|listFiles|searchAll|listSymbols|lsp_query|graphify[A-Za-z]*|bash|experiment|getSessionEvents|llmQuery|llmQueryBatched|llmQueryAgent|llm_query|llm_query_batched|llm_query_agent|rlmQuery|rlm_query|rlmQueryAgent|rlm_query_agent)\s*\(/.test(code);
}

function semanticSubmitGateMessage(): string {
  return [
    "SUBMIT was rejected because RLM mode requires at least one semantic sub-LLM call before the final answer.",
    "Run a normal ```js block that calls `llmQuery(...)`, `llmQueryBatched(...)`, `llmQueryAgent(...)`, or the portability aliases with actual evidence content from the sandbox.",
    "Exception: literal one-hop retrieval from a specific file, line, symbol, or command output can submit directly with exact sources.",
    "For large source or data analysis, feed generous meaningful chunks instead of tiny arbitrary windows, then submit after the sub-LLM result is in scope.",
  ].join("\n");
}

function recursiveFinalGatePrompt(): string {
  return [
    "## Semantic Synthesis Guidance",
    "For complex answers, prefer one `llmQuery(...)`, `llmQueryBatched(...)`, `llmQueryAgent(...)`, or portability alias call with actual evidence from the sandbox before final SUBMIT.",
    "This is guidance, not a reason to loop: if the answer is already clear from inspected evidence, submit directly with exact sources.",
    "For broad/deep questions, strongly prefer `llmQueryBatched` for fan-out or `llmQueryAgent` for a hard subproblem over piling up more reads; pass meaningful code/data chunks, not path names or tiny arbitrary slices.",
  ].join("\n");
}

function stripMarkdownFence(text: string): string {
  const fenced = text.match(/```(?:json|md|markdown)?\s*\n?([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function inferSourcesFromText(text: string): string[] {
  const citablePath = String.raw`(?:(?:[\w@.-]+\/)?[\w@.-]+:)?(?:[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|css|html|svelte|vue|yml|yaml|toml|lock|sh|mjs|cjs|mts|cts)|(?:[\w@./-]+/)?(?:README|LICENSE|Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Brewfile|Justfile|Taskfile))`;
  const pattern = new RegExp(
    String.raw`\b(${citablePath}(?::\d+(?:-\d+)?)?)\b`,
    "g",
  );
  const sources = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    sources.add(match[1]);
  }
  return [...sources];
}

function normalizeExtractionPayload(parsed: unknown, fallbackAnswer: string): Partial<RLMQueryResult> {
  const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const answer = typeof payload.answer === "string" && payload.answer.trim()
    ? payload.answer
    : fallbackAnswer;
  const explicitSources = coerceStringArray(payload.sources);
  return {
    answer,
    sources: explicitSources.length ? explicitSources : inferSourcesFromText(answer),
    confidence: typeof payload.confidence === "string" ? payload.confidence : "medium",
    finalReasoning: "extraction fallback",
  };
}

function parseExtractionResponse(response: string): Partial<RLMQueryResult> | null {
  const candidates = [
    response,
    stripMarkdownFence(response),
    response.match(/\{[\s\S]*\}/)?.[0] ?? "",
  ].filter((candidate) => candidate.trim().length > 0);

  for (const candidate of candidates) {
    try {
      return normalizeExtractionPayload(JSON.parse(candidate), response);
    } catch {
      // Try the next candidate; repair is handled by the caller.
    }
  }
  return null;
}

function buildSynthesisNudge(args: {
  step: number;
  maxIterations: number;
  output: string;
  readFiles: string[];
}): string {
  const lineAnchors = countRegexMatches(args.output, /\b[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|css|html|svelte|vue|yml|yaml|toml|lock|sh):\d+(?:-\d+)?\b/g);
  const distinctReads = new Set(args.readFiles).size;
  const closeToBudget = args.step >= Math.max(4, args.maxIterations - 4);
  const enoughEvidence = args.step >= 6 && (lineAnchors >= 6 || distinctReads >= 6);
  if (!closeToBudget && !enoughEvidence) return "";

  return [
    "SYNTHESIS CHECKPOINT:",
    "If the output above gives enough evidence to answer, your next response should submit the final answer.",
    "Do not keep opening adjacent files just to be exhaustive. Prefer a concise <ANSWER> with exact file:line sources, then a tiny SUBMIT({ sources }) block.",
    "Only continue exploring if a required category from the user's question is still missing.",
  ].join(" ");
}

function isMCPToolName(name: string): boolean {
  return name === "mcp_tool_schema" || name === "list_mcp_tools" || name.startsWith("mcp__");
}

function isMCPSchemaLookupTool(name: string): boolean {
  return name === "mcp_tool_schema" || /__COMPOSIO_GET_TOOL_SCHEMAS$/i.test(name);
}

function isMCPValidationFailure(message: string): boolean {
  return /following fields are missing|required field|required.*missing|missing.*required|schema validation|invalid arguments?|invalid input|missing.*field/i.test(message);
}

function mcpRetryKey(name: string, args: unknown[], message = ""): string {
  if (/__COMPOSIO_MULTI_EXECUTE_TOOL$/i.test(name)) {
    const slugs = extractComposioToolSlugs(args, message);
    if (slugs.length) return `${name}:${slugs.join(",")}`;
  }
  return name;
}

function extractComposioToolSlugs(args: unknown[], message = ""): string[] {
  const slugs = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const row = value as Record<string, unknown>;
    const slug = row.tool_slug ?? row.toolSlug ?? row.slug;
    if (typeof slug === "string" && slug.trim()) slugs.add(slug.trim().toUpperCase());
    for (const child of Object.values(row)) visit(child);
  };

  visit(args);
  const text = `${safeStringify(args)}\n${message}`;
  for (const match of text.matchAll(/["']?tool_slug["']?\s*[:=]\s*["']([^"']+)["']/gi)) {
    slugs.add(match[1].trim().toUpperCase());
  }
  return [...slugs].sort();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function mcpRetryBlockedMessage(key: string, lastError: string): string {
  return [
    `MCP retry guard blocked another call to ${key}.`,
    "The previous call failed input validation. Do not keep retrying guessed argument names.",
    "Inspect the exact schema first: use `mcp_tool_schema(\"mcp__server__tool\")` for direct tools, or `COMPOSIO_GET_TOOL_SCHEMAS` for Composio nested tool slugs.",
    "If the schema has already been inspected and the tool still fails, stop calling this tool, submit a clean user-facing answer that says the external side effect was not completed, and include the relevant error/log id.",
    `Last validation error: ${lastError.slice(0, 1200)}`,
  ].join("\n");
}

// ── Session setup result ─────────────────────────────────────────

interface SessionSetup {
  sandbox: BunSandbox;
  systemPrompt: string;
  rebuildSystemPrompt: () => string;
  /** Mode-specific iteration prompt builder. All existing modes use buildSessionIterationPrompt; rlm mode uses buildRLMIterationPrompt. */
  buildIterPrompt: IterPromptBuilder;
  getCallCount: () => number;
  getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
  cleanup: () => Promise<void>;
}

// ── Tool call event shape ────────────────────────────────────────

interface ToolCallEvent {
  name: string;
  args?: unknown[];
  phase: "start" | "done" | "error";
  executionMode?: "execute" | "probe" | null;
  durationMs?: number;
  error?: string;
}

interface MCPValidationFailureRecord {
  schemaEpoch: number;
  lastError: string;
}

/**
 * RLM — Recursive Language Model for codebase understanding and data analysis.
 *
 * Supports three modes:
 * - 'repo': GitHub URL or local git repo (codebase understanding)
 * - 'file': Single file or directory (data/document analysis — CSV, TXT, MD, etc.)
 * - 'workspace': Multiple repos (cross-repo understanding, steal/port features)
 *
 * Mode is auto-detected from the source or set explicitly.
 */
export class RLM {
  source: string | null;
  sources: Array<string | SourceSpec> | null;
  mode: string;
  branch: string | null | undefined;
  sourcePath: string | null | undefined;
  llm: LLMClient;
  subLM: LLMClient;
  defaultAgent?: string;
  maxIterations: number;
  maxLLMCalls: number;
  maxOutputChars: number;
  maxJITProbesPerIteration: number;
  maxJITLLMCallsPerIteration: number;
  subLLMMaxOutputTokens: number;
  subLLMAgentMaxTurns: number;
  jitProbeTimeout: number;
  jitProbeLLMTimeout: number;
  jitProbeMaxOutputChars: number;
  sandboxTimeout: number;
  verbose: boolean;
  optimizer: boolean;
  githubToken: string | undefined;
  githubFetch: GitHubFetch | undefined;
  prMode: boolean;
  onEvent: EventCallback | null;
  onStep: StepCallback | null;
  onStatus: StatusCallback | null;
  onStream: StreamCallbackLegacy | null;
  tokenUsage: TokenUsage;
  _currentSandbox: BunSandbox | null;
  _currentCleanup: (() => Promise<void>) | null;
  _mcpConfig: MCPConfig | null;
  _sessionDir: string | null;
  _resumeSessionId: string | null;
  _firstUserMessageSuffix: string;
  _session: Session | null = null;
  _buildIterPrompt: IterPromptBuilder = buildSessionIterationPrompt;
  _skillsPromptText: string = "";
  _iterationReadFiles: string[] = [];
  _iterationToolCounts: Record<string, number> = {};
  _jitProbeActive: boolean = false;
  _jitLLMCallsThisIteration: number = 0;
  _requireSemanticBeforeSubmit: boolean = false;
  _encourageSemanticBeforeSubmit: boolean = false;
  _recursiveFinalGate: boolean | "auto";
  _mcpSchemaEpoch: number = 0;
  _mcpValidationFailures: Record<string, MCPValidationFailureRecord> = {};

  constructor(opts: Partial<RLMOptions>) {
    const parsed = RLMOptionsSchema.parse(opts);

    if (parsed.source && parsed.sources) {
      throw new Error("RLM: use 'source' or 'sources', not both");
    }
    if (!parsed.source && !parsed.sources && parsed.mode !== "chat") {
      throw new Error("RLM: source or sources is required");
    }
    if (!parsed.llm) throw new Error("RLM: llm is required");

    this.source = parsed.source || null;
    this.sources = parsed.sources || null;
    this.mode = parsed.mode;
    this.branch = parsed.branch;
    this.sourcePath = parsed.sourcePath;
    this.llm = parsed.llm;
    this.defaultAgent = parsed.defaultAgent;
    this.subLM = parsed.subLM || parsed.llm;
    this.maxIterations = parsed.maxIterations;
    this.maxLLMCalls = parsed.maxLLMCalls;
    this.maxOutputChars = parsed.maxOutputChars;
    this.maxJITProbesPerIteration = parsed.maxJITProbesPerIteration;
    this.maxJITLLMCallsPerIteration = parsed.maxJITLLMCallsPerIteration;
    this.subLLMMaxOutputTokens = parsed.subLLMMaxOutputTokens;
    this.subLLMAgentMaxTurns = parsed.subLLMAgentMaxTurns;
    this.jitProbeTimeout = parsed.jitProbeTimeout;
    this.jitProbeLLMTimeout = parsed.jitProbeLLMTimeout;
    this.jitProbeMaxOutputChars = parsed.jitProbeMaxOutputChars;
    this._recursiveFinalGate = parsed.recursiveFinalGate;
    this.sandboxTimeout = parsed.sandboxTimeout;
    this.verbose = parsed.verbose;
    this.optimizer = parsed.optimizer;
    this.githubToken = parsed.githubToken;
    this.githubFetch = parsed.githubFetch;
    this.prMode = parsed.prMode;
    this.onEvent = parsed.onEvent || null;
    // Backward-compat shims (deprecated — prefer onEvent)
    this.onStep = parsed.onStep || null;
    this.onStatus = parsed.onStatus || null;
    this.onStream = parsed.onStream || null;

    // Token usage tracking
    this.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    // Track current sandbox for signal cleanup
    this._currentSandbox = null;
    // MCP config: explicit override or auto-load from .mcp.json
    this._mcpConfig = (parsed as any).mcpConfig || null;
    this._currentCleanup = null;
    this._sessionDir = (parsed as any).sessionDir || null;
    this._resumeSessionId = (parsed as any).resumeSessionId || null;
    this._firstUserMessageSuffix = (parsed as any).firstUserMessageSuffix || "";
  }

  /**
   * Force-destroy the current session (sandbox + temp files).
   * Called by signal handlers to guarantee resource teardown.
   */
  setSkillsPromptText(text: string): void {
    this._skillsPromptText = text;
  }

  getSkillsPromptText(): string {
    return this._skillsPromptText;
  }

  private _loadMCPConfigFor(cwd?: string): MCPConfig | null {
    if (this._mcpConfig) return this._mcpConfig;
    return loadMCPConfig(cwd ? [cwd, process.cwd()] : process.cwd());
  }

  async destroy(): Promise<void> {
    if (this._currentSandbox) {
      try { await this._currentSandbox.shutdown(); } catch { }
      this._currentSandbox = null;
    }
    if (this._currentCleanup) {
      try { await this._currentCleanup(); } catch { }
      this._currentCleanup = null;
    }
  }

  /**
   * Ask a question about the source.
   */
  async query(query: string): Promise<RLMQueryResult> {
    if (!query) throw new Error("RLM.query: query is required");

    const mode = this._resolveMode();
    this._encourageSemanticBeforeSubmit = this._recursiveFinalGate !== false && mode === "rlm" && !(this.source && parsePRURL(this.source));
    this._requireSemanticBeforeSubmit = this._recursiveFinalGate === true && this._encourageSemanticBeforeSubmit;
    this._emitStatus("mode", `Analysis mode: ${mode}`);

    // Mild prompt optimization: rewrite the query for clarity before the main loop
    let effectiveQuery = query;
    if (this.optimizer) {
      this._emitStatus("optimizer", "Optimizing query…");
      const { optimizedQuery, changed } = await optimizeQuery(query, this.subLM);
      { const u = this.subLM.lastUsage; if (u) { this.tokenUsage.promptTokens += u.promptTokens || 0; this.tokenUsage.completionTokens += u.completionTokens || 0; this.tokenUsage.totalTokens += u.totalTokens || 0; this.tokenUsage.calls += 1; } }
      effectiveQuery = optimizedQuery;
      if (changed) {
        this._emitStatus("optimizer", `Query rewritten: "${effectiveQuery}"`);
      }
    }

    // PR URL detection — intercept before normal mode dispatch
    if (this.source && parsePRURL(this.source)) {
      return this._queryPR(effectiveQuery);
    }

    if (mode === "chat") {
      return this._queryChat(effectiveQuery);
    }
    if (mode === "rlm") {
      // RLM mode works with both single-repo and workspace sources.
      if (this.sources && this.sources.length > 1) {
        return this._queryRLMWorkspace(effectiveQuery);
      }
      return this._queryRLM(effectiveQuery);
    }
    if (mode === "workspace") {
      return this._queryWorkspace(effectiveQuery);
    }
    if (mode === "repo") {
      return this._queryRepo(effectiveQuery);
    }
    return this._queryFile(effectiveQuery);
  }

  /**
   * Interactive query — runs the initial query, then accepts follow-ups.
   * The sandbox and all variables persist between rounds.
   */
  async queryInteractive(
    query: string,
    promptFn: () => Promise<string | null>,
    onAnswer?: (result: RLMQueryResult) => void
  ): Promise<RLMQueryResult> {
    if (!query) throw new Error("RLM.queryInteractive: query is required");

    const mode = this._resolveMode();
    this._encourageSemanticBeforeSubmit = this._recursiveFinalGate !== false && mode === "rlm" && !(this.source && parsePRURL(this.source));
    this._requireSemanticBeforeSubmit = this._recursiveFinalGate === true && this._encourageSemanticBeforeSubmit;
    this._emitStatus("mode", `Analysis mode: ${mode} (interactive)`);

    // Mild prompt optimization (same as query())
    let effectiveQuery = query;
    if (this.optimizer) {
      this._emitStatus("optimizer", "Optimizing query…");
      const { optimizedQuery, changed } = await optimizeQuery(effectiveQuery, this.subLM);
      { const u = this.subLM.lastUsage; if (u) { this.tokenUsage.promptTokens += u.promptTokens || 0; this.tokenUsage.completionTokens += u.completionTokens || 0; this.tokenUsage.totalTokens += u.totalTokens || 0; this.tokenUsage.calls += 1; } }
      effectiveQuery = optimizedQuery;
      if (changed) {
        this._emitStatus("optimizer", `Query rewritten: "${effectiveQuery}"`);
      }
    }

    const session = await this._setupSession(mode, effectiveQuery);
    const { sandbox, getCallCount, getTokenUsage, cleanup } = session;
    this._buildIterPrompt = session.buildIterPrompt;
    let systemPrompt = session.rebuildSystemPrompt();

    // Create/resume durable session + inject getSessionEvents tool
    await this._initSession(sandbox, effectiveQuery);

    try {
      // Initial query
      let messages: ChatMessage[] = [];
      let lastResult = await this._runLoopInteractive(
        sandbox, systemPrompt, getCallCount, getTokenUsage, effectiveQuery, messages
      );
      if (onAnswer) onAnswer(lastResult);

      // Follow-up loop
      while (true) {
        const followUp = await promptFn();
        if (!followUp) break;

        this._emitStatus("follow-up", `Follow-up: "${followUp.slice(0, 60)}..."`);

        // Refresh system prompt so newly loaded skills are included
        systemPrompt = session.rebuildSystemPrompt();

        // Continue with preserved sandbox state + conversation context
        lastResult = await this._continueLoop(
          sandbox, systemPrompt, getCallCount, getTokenUsage, followUp,
          lastResult._messages!, lastResult.answer
        );
        if (onAnswer) onAnswer(lastResult);
      }

      return lastResult;
    } finally {
      if (sandbox) await sandbox.shutdown();
      await cleanup();
    }
  }

  /**
   * Detect the mode from the source path.
   */
  _resolveMode(): AnalysisMode {
    if (this.mode === "chat") return "chat";
    // RLM mode applies to both single-repo and workspace — the system prompt
    // is strategy-free regardless of multi-repo infrastructure.
    if (this.mode === "rlm") return "rlm";
    if (this.mode === "workspace") return "workspace";
    if (this.mode === "repo") return "repo";
    if (this.mode === "file") return "file";

    // Auto-detect: multiple sources → workspace
    if (this.sources && this.sources.length > 1) return "workspace";

    // Single source in sources array → treat as single source
    if (this.sources && this.sources.length === 1) {
      const s = this.sources[0];
      this.source = typeof s === "string" ? s : s.source;
      this.branch = this.branch || (typeof s === "object" ? s.branch : undefined) || undefined;
    }

    const src = this.source;
    if (!src) return "file";

    // PR URLs are handled by query() directly — don't classify as "repo"
    if (isPRURL(src)) {
      return "repo"; // fallback label; query() intercepts before this matters
    }

    // GitHub URL → repo
    if (/^https?:\/\/(www\.)?github\.com\//.test(src) || /^git@github\.com:/.test(src)) {
      return "repo";
    }

    const resolved = resolve(src);

    // Directory with .git → repo
    if (existsSync(join(resolved, ".git"))) {
      return "repo";
    }

    // Everything else → file mode
    return "file";
  }

  // ── Session setup (shared by query + queryInteractive) ─────────

  async _setupSession(mode: AnalysisMode, query: string): Promise<SessionSetup> {
    if (this.source && parsePRURL(this.source)) return this._setupPR(query);
    if (mode === "chat") return this._setupChat(query);
    if (mode === "rlm") {
      // RLM mode with workspace sources uses workspace infrastructure + RLM prompts.
      if (this.sources && this.sources.length > 1) return this._setupRLMWorkspace(query);
      return this._setupRLM(query);
    }
    if (mode === "workspace") return this._setupWorkspace(query);
    if (mode === "repo") return this._setupRepo(query);
    return this._setupFile(query);
  }

  async _setupRepo(query: string): Promise<SessionSetup> {
    this._emitStatus("load", `Loading source: ${this.source}`);
    const { repoPath, cleanup } = await loadSource(this.source!, {
      cache: true,
      branch: this.branch,
      sourcePath: this.sourcePath,
    });
    this._emitStatus("load", `Repo path: ${repoPath}`);

    this._emitStatus("index", "Building repo index...");
    const repoIndex = await buildRepoIndex(repoPath);
    this._emitStatus("index", `Index: ${repoIndex.stats.totalFiles} files, ${repoIndex.stats.totalLines} lines`);

    const repoTools = buildRepoTools(repoPath);
    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    const lspTools = makeLSPTools(repoPath);

    // Connect MCP servers (if configured)
    const mcpConfig = this._loadMCPConfigFor(repoPath);
    const mcpConns = mcpConfig ? await connectAllMCPServers(mcpConfig) : [];
    const mcpTools = makeMCPTools(mcpConns);

    // Graphify knowledge graph tools (if graph exists)
    const graphTools = buildGraphifyTools(repoPath);
    const graphContext = formatGraphContext(graphTools);

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphTools || {}),
      readFile: repoTools.readFile,
      readFileRange: repoTools.readFileRange,
      inspect: repoTools.inspect,
      listSymbols: repoTools.listSymbols,
      glob: repoTools.glob,
      rg: repoTools.rg,
      grep: repoTools.grep,
      gitLog: repoTools.gitLog,
      gitDiff: repoTools.gitDiff,
      gitBlame: repoTools.gitBlame,
      gitStatus: repoTools.gitStatus,
      gitDiffWorking: repoTools.gitDiffWorking,
      applyPatch: repoTools.applyPatch,
      listFiles: repoTools.listFiles,
      detectRunners: repoTools.detectRunners,
      writeFile: repoTools.writeFile,
      editFileRange: repoTools.editFileRange,
      editFile: repoTools.editFile,
      bash: repoTools.bash,
      experiment: repoTools.experiment,
      remember: repoTools.remember,
      forge_tool: repoTools.forge_tool,
      run_agent: repoTools.run_agent,
      delegateAgent: repoTools.delegateAgent,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      llm_query: llmQuery,
      llm_query_batched: llmQueryBatched,
      llm_query_agent: llmQueryAgent,
      lsp_query: lspTools.lsp_query,
      ...mcpTools,
    };

    const mcpPrompt = buildMCPPromptSection(mcpConns);
    const rebuildSystemPrompt = () => buildActionPrompt(repoIndex, query, this.defaultAgent, (this._skillsPromptText || "") + mcpPrompt || undefined, graphContext);
    const systemPrompt = rebuildSystemPrompt();
    const sandbox = await this._startSandbox(allTools, repoIndex.fileTree);

    const origCleanup = cleanup;
    const sessionCleanup = async () => {
      await Promise.all(mcpConns.map(c => c.cleanup()));
      await origCleanup();
    };

    return { sandbox, systemPrompt, rebuildSystemPrompt, buildIterPrompt: buildSessionIterationPrompt, getCallCount, getTokenUsage, cleanup: sessionCleanup };
  }

  async _setupWorkspace(query: string): Promise<SessionSetup> {
    this._emitStatus("load", `Loading workspace: ${this.sources!.length} repositories`);
    const workspace = await loadWorkspace(this.sources!, {
      cache: true,
      branch: this.branch,
    });
    this._emitStatus("load", `Loaded repos: ${workspace.repos.map((r: LoadedRepo) => r.id).join(", ")}`);

    this._emitStatus("index", "Building repo indexes...");
    const repoIndexes: Record<string, RepoIndex> = {};
    for (const repo of workspace.repos) {
      repoIndexes[repo.id!] = await buildRepoIndex(repo.repoPath);
    }

    const totalFiles = Object.values(repoIndexes).reduce(
      (sum, idx) => sum + idx.stats.totalFiles,
      0
    );
    const totalLines = Object.values(repoIndexes).reduce(
      (sum, idx) => sum + idx.stats.totalLines,
      0
    );
    this._emitStatus("index", `Workspace index: ${totalFiles} files, ${totalLines} lines across ${workspace.repos.length} repos`);

    const repoToolsById = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, buildRepoTools(r.repoPath)])
    );
    const repoPathsById = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, r.repoPath])
    );
    const wsTools = buildWorkspaceTools(repoToolsById, repoPathsById);

    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    // Connect MCP servers (if configured)
    const mcpConfig = this._loadMCPConfigFor(workspace.repos[0]?.repoPath || process.cwd());
    const mcpConns = mcpConfig ? await connectAllMCPServers(mcpConfig) : [];
    const mcpToolsWs = makeMCPTools(mcpConns);

    // Graphify knowledge graph tools — build PER REPO so the LLM gets an
    // accurate topology for each codebase, not a single arbitrary repo's graph.
    const { tools: graphToolsWs, perRepo: graphPerRepoWs } = buildGraphifyToolsMulti(
      workspace.repos.map((r: LoadedRepo) => ({ id: r.id || "unknown", repoPath: r.repoPath })),
    );
    const graphContext = formatGraphContextMulti(
      workspace.repos.map((r: LoadedRepo) => ({ id: r.id || "unknown", tools: graphPerRepoWs[r.id || "unknown"] })),
    );

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsWs || {}),
      ...wsTools,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      llm_query: llmQuery,
      llm_query_batched: llmQueryBatched,
      llm_query_agent: llmQueryAgent,
      lsp_query: makeLSPTools(workspace.repos[0]?.repoPath || process.cwd()).lsp_query,
      ...mcpToolsWs,
    };

    const workspaceRepos = workspace.repos.map((r: LoadedRepo) => ({
      id: r.id || 'unknown',
      label: r.label || r.id || 'unknown',
      source: r.source,
    }));
    const mcpPromptWs = buildMCPPromptSection(mcpConns);
    const systemPrompt = buildWorkspaceActionPrompt(
      workspaceRepos,
      repoIndexes,
      query,
      this.defaultAgent,
      graphContext,
    ) + mcpPromptWs;

    const combinedTree = workspace.repos
      .map((r: LoadedRepo) => `[${r.id}]\n${repoIndexes[r.id!].fileTree.join("\n")}`)
      .join("\n\n");

    const sandbox = await this._startSandbox(allTools, combinedTree);

    // Inject repo path mapping so the worker's SUBMIT handler can resolve
    // workspace-namespaced file paths (e.g. "mine:_answer.md" → abs path)
    const repoPathMap = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, r.repoPath])
    );
    await sandbox.inject("__repoPathMap", repoPathMap);

    return {
      sandbox, systemPrompt, rebuildSystemPrompt: () => systemPrompt, buildIterPrompt: buildSessionIterationPrompt, getCallCount, getTokenUsage,
      cleanup: async () => {
        await Promise.all(mcpConns.map(c => c.cleanup()));
        await workspace.cleanupAll();
      },
    };
  }

  async _setupFile(query: string): Promise<SessionSetup> {
    this._emitStatus("load", `Loading file source: ${this.source}`);
    const { basePath, files, type, cleanup } = await loadFileSource(this.source!);
    this._emitStatus("load", `Base path: ${basePath} (${type}, ${files.length} files)`);

    this._emitStatus("index", "Building file index...");
    const fileIndex = await buildFileIndex(basePath, files);
    this._emitStatus("index", `Index: ${fileIndex.stats.totalFiles} files, ${fileIndex.stats.totalLines} lines`);

    const fileTools = buildFileTools(basePath);
    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    const lspTools = makeLSPTools(basePath);

    // Connect MCP servers (if configured)
    const mcpConfigFile = this._loadMCPConfigFor(basePath);
    const mcpConnsFile = mcpConfigFile ? await connectAllMCPServers(mcpConfigFile) : [];
    const mcpToolsFile = makeMCPTools(mcpConnsFile);

    // Graphify knowledge graph tools (if graph exists)
    const graphToolsFile = buildGraphifyTools(basePath);

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsFile || {}),
      readFile: fileTools.readFile,
      inspect: fileTools.inspect,
      glob: fileTools.glob,
      rg: fileTools.rg,
      grep: fileTools.grep,
      listFiles: fileTools.listFiles,
      fileInfo: fileTools.fileInfo,
      csvInfo: fileTools.csvInfo,
      csvQuery: fileTools.csvQuery,
      csvAggregate: fileTools.csvAggregate,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      lsp_query: lspTools.lsp_query,
      ...mcpToolsFile,
    };

    const mcpPromptFile = buildMCPPromptSection(mcpConnsFile);
    const systemPrompt = buildFileAnalysisPrompt(fileIndex, query, this.defaultAgent) + mcpPromptFile;
    const sandbox = await this._startSandbox(allTools, fileIndex.fileTree);

    const origFileCleanup = cleanup;
    const fileSessionCleanup = async () => {
      await Promise.all(mcpConnsFile.map(c => c.cleanup()));
      await origFileCleanup();
    };

    return { sandbox, systemPrompt, rebuildSystemPrompt: () => systemPrompt, buildIterPrompt: buildSessionIterationPrompt, getCallCount, getTokenUsage, cleanup: fileSessionCleanup };
  }

  async _setupChat(query: string): Promise<SessionSetup> {
    const cwd = process.cwd();

    const repoTools = buildRepoTools(cwd);
    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    const lspTools = makeLSPTools(cwd);

    // Connect MCP servers (if configured)
    const mcpConfig = this._loadMCPConfigFor(cwd);
    const mcpConns = mcpConfig ? await connectAllMCPServers(mcpConfig) : [];
    const mcpTools = makeMCPTools(mcpConns);

    // Graphify knowledge graph tools (if graph exists)
    const graphToolsChat = buildGraphifyTools(cwd);

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsChat || {}),
      readFile: repoTools.readFile,
      readFileRange: repoTools.readFileRange,
      inspect: repoTools.inspect,
      listSymbols: repoTools.listSymbols,
      glob: repoTools.glob,
      rg: repoTools.rg,
      grep: repoTools.grep,
      gitLog: repoTools.gitLog,
      gitDiff: repoTools.gitDiff,
      gitBlame: repoTools.gitBlame,
      gitStatus: repoTools.gitStatus,
      gitDiffWorking: repoTools.gitDiffWorking,
      applyPatch: repoTools.applyPatch,
      listFiles: repoTools.listFiles,
      detectRunners: repoTools.detectRunners,
      writeFile: repoTools.writeFile,
      editFileRange: repoTools.editFileRange,
      editFile: repoTools.editFile,
      bash: repoTools.bash,
      experiment: repoTools.experiment,
      remember: repoTools.remember,
      forge_tool: repoTools.forge_tool,
      run_agent: repoTools.run_agent,
      delegateAgent: repoTools.delegateAgent,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      llm_query: llmQuery,
      llm_query_batched: llmQueryBatched,
      llm_query_agent: llmQueryAgent,
      lsp_query: lspTools.lsp_query,
      ...mcpTools,
    };

    const mcpPrompt = buildMCPPromptSection(mcpConns);
    const rebuildSystemPrompt = () => buildGeneralistPrompt(query, this.defaultAgent, (this._skillsPromptText || "") + mcpPrompt || undefined);
    const systemPrompt = rebuildSystemPrompt();
    const sandbox = await this._startSandbox(allTools, []);

    const sessionCleanup = async () => {
      await Promise.all(mcpConns.map(c => c.cleanup()));
    };

    return { sandbox, systemPrompt, rebuildSystemPrompt, buildIterPrompt: buildSessionIterationPrompt, getCallCount, getTokenUsage, cleanup: sessionCleanup };
  }

  // ── RLM mode: strategy-free decomposition ──────────────────────

  async _setupRLM(query: string): Promise<SessionSetup> {
    // Same infrastructure as repo mode — same tools, same sandbox, same MCP.
    // Only difference: uses buildRLMPrompt (no prescriptive strategy) and
    // buildRLMIterationPrompt (no heuristic reminders, no panic countdowns).
    this._emitStatus("load", `Loading source: ${this.source}`);
    const { repoPath, cleanup } = await loadSource(this.source!, {
      cache: true,
      branch: this.branch,
      sourcePath: this.sourcePath,
    });
    this._emitStatus("load", `Repo path: ${repoPath}`);

    this._emitStatus("index", "Building repo index...");
    const repoIndex = await buildRepoIndex(repoPath);
    this._emitStatus("index", `Index: ${repoIndex.stats.totalFiles} files, ${repoIndex.stats.totalLines} lines`);

    const repoTools = buildRepoTools(repoPath);
    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    const lspTools = makeLSPTools(repoPath);

    const mcpConfig = this._loadMCPConfigFor(repoPath);
    const mcpConns = mcpConfig ? await connectAllMCPServers(mcpConfig) : [];
    const mcpTools = makeMCPTools(mcpConns);

    // Graphify knowledge graph tools (if graph exists)
    const graphToolsRLM = buildGraphifyTools(repoPath);
    const graphContext = formatGraphContext(graphToolsRLM);

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsRLM || {}),
      readFile: repoTools.readFile,
      readFileRange: repoTools.readFileRange,
      inspect: repoTools.inspect,
      listSymbols: repoTools.listSymbols,
      glob: repoTools.glob,
      rg: repoTools.rg,
      grep: repoTools.grep,
      gitLog: repoTools.gitLog,
      gitDiff: repoTools.gitDiff,
      gitBlame: repoTools.gitBlame,
      gitStatus: repoTools.gitStatus,
      gitDiffWorking: repoTools.gitDiffWorking,
      applyPatch: repoTools.applyPatch,
      listFiles: repoTools.listFiles,
      detectRunners: repoTools.detectRunners,
      writeFile: repoTools.writeFile,
      editFileRange: repoTools.editFileRange,
      editFile: repoTools.editFile,
      bash: repoTools.bash,
      experiment: repoTools.experiment,
      remember: repoTools.remember,
      forge_tool: repoTools.forge_tool,
      run_agent: repoTools.run_agent,
      delegateAgent: repoTools.delegateAgent,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      llm_query: llmQuery,
      llm_query_batched: llmQueryBatched,
      llm_query_agent: llmQueryAgent,
      rlmQuery: llmQuery,
      rlm_query: llmQuery,
      rlmQueryAgent: llmQueryAgent,
      rlm_query_agent: llmQueryAgent,
      lsp_query: lspTools.lsp_query,
      ...mcpTools,
    };

    const mcpPrompt = buildMCPPromptSection(mcpConns);
    const rebuildSystemPrompt = () => buildRLMPrompt(repoIndex, query, this.defaultAgent, (this._skillsPromptText || "") + mcpPrompt || undefined, graphContext);
    const systemPrompt = rebuildSystemPrompt();
    const sandbox = await this._startSandbox(allTools, repoIndex.fileTree);

    const origCleanup = cleanup;
    const sessionCleanup = async () => {
      await Promise.all(mcpConns.map(c => c.cleanup()));
      await origCleanup();
    };

    return { sandbox, systemPrompt, rebuildSystemPrompt, buildIterPrompt: buildRLMIterationPrompt, getCallCount, getTokenUsage, cleanup: sessionCleanup };
  }

  async _queryRLM(query: string): Promise<RLMQueryResult> {
    const session = await this._setupRLM(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  // ── RLM + Workspace mode: strategy-free decomposition on multi-repo ──

  async _setupRLMWorkspace(query: string): Promise<SessionSetup> {
    // Same infrastructure as workspace mode — same multi-repo tools, same sandbox.
    // Only difference: uses buildRLMWorkspacePrompt (strategy-free) and
    // buildRLMIterationPrompt (factual budget only, no heuristics).
    this._emitStatus("load", `Loading workspace: ${this.sources!.length} repositories`);
    const workspace = await loadWorkspace(this.sources!, {
      cache: true,
      branch: this.branch,
    });
    this._emitStatus("load", `Loaded repos: ${workspace.repos.map((r: LoadedRepo) => r.id).join(", ")}`);

    this._emitStatus("index", "Building repo indexes...");
    const repoIndexes: Record<string, RepoIndex> = {};
    for (const repo of workspace.repos) {
      repoIndexes[repo.id!] = await buildRepoIndex(repo.repoPath);
    }

    const totalFiles = Object.values(repoIndexes).reduce(
      (sum, idx) => sum + idx.stats.totalFiles, 0
    );
    const totalLines = Object.values(repoIndexes).reduce(
      (sum, idx) => sum + idx.stats.totalLines, 0
    );
    this._emitStatus("index", `Workspace index: ${totalFiles} files, ${totalLines} lines across ${workspace.repos.length} repos`);

    const repoToolsById = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, buildRepoTools(r.repoPath)])
    );
    const repoPathsByIdRLM = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, r.repoPath])
    );
    const wsTools = buildWorkspaceTools(repoToolsById, repoPathsByIdRLM);

    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    // Connect MCP servers (if configured)
    const mcpConfig = this._loadMCPConfigFor(workspace.repos[0]?.repoPath || process.cwd());
    const mcpConns = mcpConfig ? await connectAllMCPServers(mcpConfig) : [];
    const mcpToolsWs = makeMCPTools(mcpConns);

    // Graphify knowledge graph tools — build PER REPO (see _setupWorkspace).
    const { tools: graphToolsRLMWs, perRepo: graphPerRepoRLMWs } = buildGraphifyToolsMulti(
      workspace.repos.map((r: LoadedRepo) => ({ id: r.id || "unknown", repoPath: r.repoPath })),
    );
    const graphContext = formatGraphContextMulti(
      workspace.repos.map((r: LoadedRepo) => ({ id: r.id || "unknown", tools: graphPerRepoRLMWs[r.id || "unknown"] })),
    );

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsRLMWs || {}),
      ...wsTools,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      llm_query: llmQuery,
      llm_query_batched: llmQueryBatched,
      llm_query_agent: llmQueryAgent,
      rlmQuery: llmQuery,
      rlm_query: llmQuery,
      rlmQueryAgent: llmQueryAgent,
      rlm_query_agent: llmQueryAgent,
      lsp_query: makeLSPTools(workspace.repos[0]?.repoPath || process.cwd()).lsp_query,
      ...mcpToolsWs,
    };

    const workspaceRepos = workspace.repos.map((r: LoadedRepo) => ({
      id: r.id || 'unknown',
      label: r.label || r.id || 'unknown',
      source: r.source,
    }));
    const mcpPromptWs = buildMCPPromptSection(mcpConns);

    // Use RLM workspace prompt — strategy-free philosophy with workspace tools
    const rebuildSystemPrompt = () => buildRLMWorkspacePrompt(
      workspaceRepos,
      repoIndexes,
      query,
      this.defaultAgent,
      (this._skillsPromptText || "") + mcpPromptWs || undefined,
      graphContext
    );
    const systemPrompt = rebuildSystemPrompt();

    const combinedTree = workspace.repos
      .map((r: LoadedRepo) => `[${r.id}]\n${repoIndexes[r.id!].fileTree.join("\n")}`)
      .join("\n\n");

    const sandbox = await this._startSandbox(allTools, combinedTree);

    // Inject repo path mapping so the worker's SUBMIT handler can resolve
    // workspace-namespaced file paths (e.g. "mine:_answer.md" → abs path)
    const repoPathMapRLM = Object.fromEntries(
      workspace.repos.map((r: LoadedRepo) => [r.id, r.repoPath])
    );
    await sandbox.inject("__repoPathMap", repoPathMapRLM);

    return {
      sandbox, systemPrompt, rebuildSystemPrompt, buildIterPrompt: buildRLMIterationPrompt, getCallCount, getTokenUsage,
      cleanup: async () => {
        await Promise.all(mcpConns.map(c => c.cleanup()));
        await workspace.cleanupAll();
      },
    };
  }

  async _queryRLMWorkspace(query: string): Promise<RLMQueryResult> {
    const session = await this._setupRLMWorkspace(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }


  // ── Non-interactive query methods ──────────────────────────────

  async _queryRepo(query: string): Promise<RLMQueryResult> {
    const session = await this._setupRepo(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  async _queryChat(query: string): Promise<RLMQueryResult> {
    const session = await this._setupChat(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  async _queryWorkspace(query: string): Promise<RLMQueryResult> {
    const session = await this._setupWorkspace(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  async _queryFile(query: string): Promise<RLMQueryResult> {
    const session = await this._setupFile(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;
    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  async _setupPR(query: string): Promise<SessionSetup> {
    const parsed = parsePRURL(this.source!);
    if (!parsed) throw new Error("RLM._setupPR: invalid PR URL");
    const { owner, repo, number: prNumber } = parsed;

    this._emitStatus("pr", "Fetching PR data from GitHub...");
    const prData = await fetchPRData(owner, repo, prNumber, { githubToken: this.githubToken, githubFetch: this.githubFetch });
    this._emitStatus("pr", `PR #${prNumber}: ${prData.info.title}`);

    // Clone the base branch to provide repo context
    const repoURL = `https://github.com/${owner}/${repo}`;
    this._emitStatus("load", `Cloning base branch: ${prData.info.baseBranch}`);
    const { repoPath: basePath, cleanup } = await loadSource(repoURL, {
      cache: false,  // Don't cache — we mutate by applying the PR diff
      branch: prData.info.baseBranch,
    });
    this._emitStatus("load", `Base repo path: ${basePath}`);

    // Fetch PR head ref and checkout changed files so they're accessible via readFile
    if (prData.diff.changedFiles.length > 0) {
      this._emitStatus("pr", "Fetching PR files...");

      // Fetch the PR's head ref from GitHub
      const fetchResult = Bun.spawnSync(
        ["git", "fetch", "origin", `pull/${prNumber}/head`, "--depth=1"],
        { cwd: basePath, stderr: "pipe" }
      );

      if (fetchResult.exitCode === 0) {
        // Checkout each changed file from the PR head
        const filesToCheckout = prData.diff.changedFiles
          .filter(f => f.status !== "removed")
          .map(f => f.filename);

        if (filesToCheckout.length > 0) {
          // Batch checkout via git checkout FETCH_HEAD -- file1 file2 ...
          const checkoutResult = Bun.spawnSync(
            ["git", "checkout", "FETCH_HEAD", "--", ...filesToCheckout],
            { cwd: basePath, stderr: "pipe" }
          );

          if (checkoutResult.exitCode === 0) {
            this._emitStatus("pr", `Checked out ${filesToCheckout.length} PR files`);
          } else {
            // Fallback: checkout files one by one (some may be in subdirs that need creating)
            let checkedOut = 0;
            for (const file of filesToCheckout) {
              // Ensure parent directory exists
              const dir = join(basePath, file.split("/").slice(0, -1).join("/"));
              if (dir !== basePath) {
                Bun.spawnSync(["mkdir", "-p", dir], { cwd: basePath });
              }
              const r = Bun.spawnSync(
                ["git", "checkout", "FETCH_HEAD", "--", file],
                { cwd: basePath, stderr: "pipe" }
              );
              if (r.exitCode === 0) checkedOut++;
            }
            this._emitStatus("pr", `Checked out ${checkedOut}/${filesToCheckout.length} PR files`);
          }
        }

        // Handle removed files
        const removedFiles = prData.diff.changedFiles
          .filter(f => f.status === "removed")
          .map(f => f.filename);
        for (const file of removedFiles) {
          try { unlinkSync(join(basePath, file)); } catch { }
        }
      } else {
        const err = new TextDecoder().decode(fetchResult.stderr);
        this._emitStatus("pr", `Could not fetch PR ref (${err.trim().slice(0, 80)}). Files from the diff may not be readable.`);
      }
    }

    // PR review graphify must represent the post-PR working tree. The graph
    // cache is path-local (`graphify-out/graph.json`) and graphify only
    // regenerates when it is missing, so remove any checked-in or leftover
    // graph before building tools for this temporary PR checkout.
    try { rmSync(join(basePath, "graphify-out"), { recursive: true, force: true }); } catch { }

    this._emitStatus("index", "Building repo index...");
    const repoIndex = await buildRepoIndex(basePath);
    this._emitStatus("index", `Index: ${repoIndex.stats.totalFiles} files, ${repoIndex.stats.totalLines} lines`);


    const repoTools = buildRepoTools(basePath);
    const { llmQuery, llmQueryBatched, llmQueryAgent, getCallCount, getTokenUsage } = makeLLMTools(
      this.subLM,
      this.maxLLMCalls,
      { maxOutputTokens: this.subLLMMaxOutputTokens, defaultAgentMaxTurns: this.subLLMAgentMaxTurns }
    );

    const lspTools = makeLSPTools(basePath);

    // Graphify knowledge graph tools (if graph exists)
    const graphToolsPR = buildGraphifyTools(basePath);
    const graphContextPR = formatGraphContext(graphToolsPR);

    // Connect MCP servers (if configured)
    const mcpConfigPR = this._loadMCPConfigFor(basePath);
    const mcpConnsPR = mcpConfigPR ? await connectAllMCPServers(mcpConfigPR) : [];
    const mcpToolsPR = makeMCPTools(mcpConnsPR);

    const allTools: Record<string, (...args: any[]) => any> = {
      ...(graphToolsPR || {}),
      readFile: repoTools.readFile,
      readFileRange: repoTools.readFileRange,
      inspect: repoTools.inspect,
      listSymbols: repoTools.listSymbols,
      glob: repoTools.glob,
      rg: repoTools.rg,
      grep: repoTools.grep,
      gitLog: repoTools.gitLog,
      gitDiff: repoTools.gitDiff,
      gitBlame: repoTools.gitBlame,
      gitStatus: repoTools.gitStatus,
      gitDiffWorking: repoTools.gitDiffWorking,
      applyPatch: repoTools.applyPatch,
      listFiles: repoTools.listFiles,
      detectRunners: repoTools.detectRunners,
      writeFile: repoTools.writeFile,
      editFileRange: repoTools.editFileRange,
      editFile: repoTools.editFile,
      bash: repoTools.bash,
      experiment: repoTools.experiment,
      remember: repoTools.remember,
      forge_tool: repoTools.forge_tool,
      run_agent: repoTools.run_agent,
      delegateAgent: repoTools.delegateAgent,
      run_websearch: makeWebSearchTool(this.llm).run_websearch,
      llmQuery,
      llmQueryBatched,
      llmQueryAgent,
      lsp_query: lspTools.lsp_query,
      ...mcpToolsPR,
    };

    const mcpPromptPR = buildMCPPromptSection(mcpConnsPR);
    const rebuildSystemPrompt = () => buildPRReviewPrompt(prData, repoIndex, query, this.defaultAgent, graphContextPR) + mcpPromptPR;
    const systemPrompt = rebuildSystemPrompt();

    const sandbox = await this._startSandbox(allTools, repoIndex.fileTree);

    const origPRCleanup = cleanup;
    const prSessionCleanup = async () => {
      await Promise.all(mcpConnsPR.map(c => c.cleanup()));
      await origPRCleanup();
    };

    return { sandbox, systemPrompt, rebuildSystemPrompt, buildIterPrompt: buildSessionIterationPrompt, getCallCount, getTokenUsage, cleanup: prSessionCleanup };
  }

  async _queryPR(query: string): Promise<RLMQueryResult> {
    const session = await this._setupPR(query);
    this._currentSandbox = session.sandbox;
    this._currentCleanup = session.cleanup;
    this._buildIterPrompt = session.buildIterPrompt;

    try {
      return await this._runLoop(session.sandbox, session.systemPrompt, session.getCallCount, session.getTokenUsage, query);
    } finally {
      if (session.sandbox) await session.sandbox.shutdown();
      await session.cleanup();
      this._currentSandbox = null;
      this._currentCleanup = null;
    }
  }

  // ── Shared loop infrastructure ─────────────────────────────────

  _wrapToolsForJIT(allTools: Record<string, (...args: any[]) => any>): Record<string, (...args: any[]) => any> {
    const wrapped = { ...allTools };

    for (const name of ["llmQuery", "llm_query", "rlmQuery", "rlm_query"]) {
      if (typeof wrapped[name] !== "function") continue;
      const llmQuery = wrapped[name];
      wrapped[name] = async (...args: any[]) => {
        if (this._jitProbeActive) {
          if (this._jitLLMCallsThisIteration >= this.maxJITLLMCallsPerIteration) {
            throw new Error(
              `JIT llmQuery budget exhausted (${this._jitLLMCallsThisIteration}/${this.maxJITLLMCallsPerIteration}) for this iteration. ` +
              "Use the context you already have or write a normal ```js step."
            );
          }
          this._jitLLMCallsThisIteration++;
        }
        return llmQuery(...args);
      };
    }

    for (const name of ["llmQueryBatched", "llm_query_batched", "llmQueryAgent", "llm_query_agent", "rlmQueryAgent", "rlm_query_agent"]) {
      if (typeof wrapped[name] !== "function") continue;
      const semanticTool = wrapped[name];
      wrapped[name] = async (...args: any[]) => {
        if (this._jitProbeActive) {
          throw new Error(
            `${name} is not available inside JIT probes. ` +
            "Use at most one llmQuery(...) call, or write a normal ```js step for broader synthesis."
          );
        }
        return semanticTool(...args);
      };
    }

    for (const [name, tool] of Object.entries(wrapped)) {
      if (!isMCPToolName(name) || typeof tool !== "function") continue;

      wrapped[name] = async (...args: any[]) => {
        if (isMCPSchemaLookupTool(name)) {
          this._mcpSchemaEpoch++;
          return tool(...args);
        }

        const key = mcpRetryKey(name, args);
        const prior = this._mcpValidationFailures[key];
        if (prior && prior.schemaEpoch >= this._mcpSchemaEpoch) {
          throw new Error(mcpRetryBlockedMessage(key, prior.lastError));
        }

        try {
          const result = await tool(...args);
          delete this._mcpValidationFailures[key];
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isMCPValidationFailure(message)) {
            const failedKey = mcpRetryKey(name, args, message);
            this._mcpValidationFailures[failedKey] = {
              schemaEpoch: this._mcpSchemaEpoch,
              lastError: message,
            };
          }
          throw error;
        }
      };
    }

    return wrapped;
  }

  async _startSandbox(allTools: Record<string, (...args: any[]) => any>, fileTree: string[] | string): Promise<BunSandbox> {
    this._emitStatus("sandbox", "Starting sandbox...");
    const self = this;
    const sandboxTools = this._wrapToolsForJIT(allTools);
    const sandbox = new BunSandbox({
      timeout: this.sandboxTimeout,
      maxOutputChars: this.maxOutputChars,
      tools: sandboxTools as any,
      onToolCall: ({ name, args, phase, durationMs, error }: ToolCallEvent) => {
        if (phase === "start") {
          self._emit({ type: "tool-start", tool: name });
          self._emitStatus("tool", `⚙ ${name}`);
          self._iterationToolCounts[name] = (self._iterationToolCounts[name] || 0) + 1;
          // Track file reads for semantic history
          if (args && args.length > 0 && typeof args[0] === "string") {
            if (["readFile", "rg", "grep", "glob"].includes(name)) {
              const filePath = args[0] as string;
              if (!self._iterationReadFiles.includes(filePath)) {
                self._iterationReadFiles.push(filePath);
              }
            }
          }
        } else if (phase === "done") {
          self._emit({ type: "tool-done", tool: name, durationMs: durationMs! });
          self._emitStatus("tool", `✓ ${name} (${durationMs}ms)`);
        } else if (phase === "error") {
          self._emit({ type: "tool-error", tool: name, durationMs: durationMs!, error: error! });
          self._emitStatus("tool", `✗ ${name} (${durationMs}ms): ${error}`);
        }
      },
    });
    await sandbox.start();

    const wrappers = buildToolWrappers(Object.keys(allTools));
    for (const [name, source] of Object.entries(wrappers)) {
      await sandbox.injectFunction(name, source as string);
    }

    await sandbox.inject("files", fileTree);

    return sandbox;
  }

  /**
   * Create or resume a Session, then inject getSessionEvents into the sandbox.
   * Called from both _runLoop and queryInteractive.
   */
  async _initSession(sandbox: BunSandbox, query: string): Promise<Session> {
    let session: FileSession;

    if (this._resumeSessionId) {
      // Resume from an existing session file
      const dir = this._sessionDir || join(process.cwd(), ".rlm-sessions");
      const filePath = join(dir, `${this._resumeSessionId}.jsonl`);
      session = FileSession.load(filePath);
      this._emitStatus("session", `♻ Resumed session: ${session.id} (${session.eventCount} events, ${session.stepCount()} steps)`);
      const lastStep = session.eventCount > 0 ? Math.max(...session.getEvents().map(e => e.step)) : 1;
      session.emit({ type: "status", step: lastStep, content: `Resumed. New query: ${query}` });
    } else {
      session = new FileSession({ sessionDir: this._sessionDir || undefined });
      this._emitStatus("session", `📝 Session started: ${session.id} → ${session.filePath}`);
      session.emit({ type: "status", step: 1, content: `Query: ${query}` });
    }

    this._session = session;

    // Inject getSessionEvents as a sandbox tool
    sandbox.tools.getSessionEvents = ((opts?: SessionQueryOpts) => session.getEvents(opts)) as (...args: unknown[]) => unknown;
    const wrappers = buildToolWrappers(["getSessionEvents"]);
    if (wrappers.getSessionEvents) {
      await sandbox.injectFunction("getSessionEvents", wrappers.getSessionEvents as string);
    }

    return session;
  }

  async _runLoop(sandbox: BunSandbox, systemPrompt: string, getCallCount: () => number, getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number }, query: string): Promise<RLMQueryResult> {
    this._emitStatus("loop", "Starting execution loop...");
    const messages: ChatMessage[] = [];

    // Create or resume a durable Session
    await this._initSession(sandbox, query);

    const result = await this._executeLoop(sandbox, systemPrompt, getCallCount, getTokenUsage, query, messages);
    return result;
  }

  async _runLoopInteractive(
    sandbox: BunSandbox, systemPrompt: string, getCallCount: () => number,
    getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number },
    query: string, messages: ChatMessage[]
  ): Promise<RLMQueryResult> {
    return this._executeLoop(sandbox, systemPrompt, getCallCount, getTokenUsage, query, messages);
  }

  async _continueLoop(
    sandbox: BunSandbox, systemPrompt: string, getCallCount: () => number,
    getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number },
    followUpQuery: string, prevMessages: ChatMessage[], previousAnswer: string
  ): Promise<RLMQueryResult> {
    this._emitStatus("loop", "Starting follow-up loop...");

    const messages = [...prevMessages];

    const firstPrompt = buildFollowUpPrompt(
      followUpQuery, previousAnswer,
      this._session ? this._session.stepCount() : 0, this.maxIterations,
      getCallCount(), this.maxLLMCalls
    );

    messages.push({ role: "user", content: firstPrompt });

    return this._executeLoop(sandbox, systemPrompt, getCallCount, getTokenUsage, followUpQuery, messages, true);
  }

  async _executeJITProbe(
    sandbox: BunSandbox,
    code: string,
    step: number,
    session: Session | null,
  ): Promise<{ output: string; resultType: string; durationMs: number; llmCalls: number; llmCallBudget: number }> {
    const beforeCounts = { ...this._iterationToolCounts };
    const beforeReadFiles = [...this._iterationReadFiles];
    const beforeReadSet = new Set(beforeReadFiles);
    const beforeJITLLMCalls = this._jitLLMCallsThisIteration;
    const started = Date.now();
    const usesSubLLM = /\b(?:llmQuery(?:Batched|Agent)?|llm_query(?:_batched|_agent)?|rlmQueryAgent|rlm_query_agent|rlmQuery|rlm_query)\s*\(/.test(code);

    this._emitStatus("jit", "JIT peek");
    this._emit({ type: "jit-start", step, code, llmCallBudget: this.maxJITLLMCallsPerIteration });
    this._jitProbeActive = true;
    const result = await sandbox.executeProbe(code, {
      timeout: usesSubLLM ? this.jitProbeLLMTimeout : this.jitProbeTimeout,
      maxOutputChars: this.jitProbeMaxOutputChars,
    }).finally(() => {
      this._jitProbeActive = false;
    });
    const durationMs = Date.now() - started;
    const llmCalls = this._jitLLMCallsThisIteration - beforeJITLLMCalls;
    const output = result.type === "error"
      ? `[Error] ${result.output || ""}`
      : result.output || "(no output)";

    const toolCounts: Record<string, number> = {};
    for (const [name, count] of Object.entries(this._iterationToolCounts)) {
      const delta = count - (beforeCounts[name] || 0);
      if (delta > 0) toolCounts[name] = delta;
    }
    const readFiles = this._iterationReadFiles.filter((file) => !beforeReadSet.has(file));

    if (session) {
      session.emit({
        type: "jit",
        step,
        content: [
          "Code:",
          "```js",
          code,
          "```",
          `Output (${output.length} chars):`,
          output,
        ].join("\n"),
        metadata: {
          readFiles,
          toolCounts,
          keyFindings: extractKeyFindings(output),
          resultType: result.type,
          llmCalls,
          llmCallBudget: this.maxJITLLMCallsPerIteration,
        },
      });
    }

    this._emit({
      type: "jit",
      step,
      code,
      output,
      resultType: result.type,
      durationMs,
      llmCalls,
      llmCallBudget: this.maxJITLLMCallsPerIteration,
    });
    const llmNote = llmCalls > 0 ? `, llmQuery ${this._jitLLMCallsThisIteration}/${this.maxJITLLMCallsPerIteration}` : "";
    this._emitStatus("jit", `peek ${result.type} (${durationMs}ms${llmNote})`);

    // JIT peeks are side-channel context lookups. Keep their tool accounting
    // out of the next major step's semantic metadata.
    this._iterationToolCounts = beforeCounts;
    this._iterationReadFiles = beforeReadFiles;

    return { output, resultType: result.type, durationMs, llmCalls, llmCallBudget: this.maxJITLLMCallsPerIteration };
  }

  /**
   * Core think→act→observe loop. Shared by initial and follow-up rounds.
   */
  async _executeLoop(
    sandbox: BunSandbox, systemPrompt: string, getCallCount: () => number,
    getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number },
    query: string, messages: ChatMessage[], isFollowUp: boolean = false
  ): Promise<RLMQueryResult> {
    const session = this._session;
    const stepOffset = session ? session.stepCount() : 0;
    let persistedFirstControlPrompt = false;
    let i = 0;
    let retryingAfterJIT = false;
    let jitProbesThisIteration = 0;
    let finalSubmitRepairUsed = false;
    let broadReadRewriteCount = 0;
    let semanticSubmitRepairUsed = false;
    const semanticCallBaseline = getCallCount();
    this._mcpSchemaEpoch = 0;
    this._mcpValidationFailures = {};
    while (i < this.maxIterations) {
      if (retryingAfterJIT) {
        this._log(`\n--- JIT continuation for iteration ${i + 1}/${this.maxIterations} ---`);
        retryingAfterJIT = false;
      } else {
        this._log(`\n--- Iteration ${i + 1}/${this.maxIterations} ---`);
        this._iterationReadFiles = [];
        this._iterationToolCounts = {};
        jitProbesThisIteration = 0;
        this._jitLLMCallsThisIteration = 0;
      }

      let iterMessages: ChatMessage[];
      if (isFollowUp && i === 0) {
        iterMessages = [...messages];
        isFollowUp = false;
      } else {
        let iterPrompt = this._buildIterPrompt(
              session!,
              i,
              this.maxIterations,
              getCallCount(),
              this.maxLLMCalls
            );
        if (this._encourageSemanticBeforeSubmit) {
          iterPrompt += `\n\n${recursiveFinalGatePrompt()}`;
        }

        const shouldAppendFirstUserSuffix =
          Boolean(this._firstUserMessageSuffix) &&
          !persistedFirstControlPrompt &&
          messages.length === 0;
        if (shouldAppendFirstUserSuffix) {
          iterPrompt += `\n\n${this._firstUserMessageSuffix}`;
        }

        iterMessages = [...messages];
        const lastMsgIndex = iterMessages.length - 1;
        const lastMsg = iterMessages[lastMsgIndex];

        if (lastMsg && lastMsg.role === "user") {
          // Merge to avoid consecutive user messages which breaks Anthropic API
          // Clone the message object before mutating to avoid corrupting the original `messages` array
          iterMessages[lastMsgIndex] = {
            ...lastMsg,
            content: lastMsg.content + "\n\n" + iterPrompt
          };
        } else {
          iterMessages.push({ role: "user", content: iterPrompt });
        }
      }

      // Wire streaming callback to LLM if supported
      if (this.llm.onStream !== undefined) {
        const rlm = this;
        this.llm.onStream = (event: StreamEvent) => {
          if (event.type === "text") {
            rlm._emit({ type: "stream-delta", delta: event.delta });
          } else if (event.type === "reasoning") {
            rlm._emit({ type: "stream-reasoning-delta", delta: event.delta });
          } else if (event.type === "done") {
            rlm._emit({ type: "stream-done", text: event.text || null, usage: event.usage || null, error: event.error || null });
          }
          if (rlm.onStream) {
            try { rlm.onStream(event); } catch { }
          }
        };
      }

      const action = await this.llm.generateAction({
        system: systemPrompt,
        messages: iterMessages,
      });

      this._accumulateUsage(this.llm);
      this._accumulateSubUsage(getTokenUsage);

      this._log("Reasoning:", action.reasoning.slice(0, 200));
      this._log("Code:", action.code.slice(0, 300));
      if (action.formatError) {
        this._log("Format error:", action.formatError);
      }
      if (action.answer) {
        this._log("Answer tag detected:", action.answer.slice(0, 100) + "...");
      }

      if (action.jitCode) {
        const step = stepOffset + i + 1;
        if (jitProbesThisIteration >= this.maxJITProbesPerIteration) {
          const message = `JIT probe budget exhausted for iteration ${i + 1}; write a normal \`\`\`js block now.`;
          if (session) {
            session.emit({ type: "error", step, content: message });
          }
          this._emitStep(i + 1, this.maxIterations, action.reasoning, action.jitCode, `[Error] ${message}`, "error", this.tokenUsage);
          if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
            const firstUserMessage = iterMessages.find((message) => message.role === "user");
            if (firstUserMessage) {
              messages.push({ ...firstUserMessage });
              persistedFirstControlPrompt = true;
            }
          }
          messages.push(
            { role: "assistant", content: `${action.reasoning}\n\n<JIT>\n${action.jitCode}\n</JIT>` },
            { role: "user", content: `${message}\nDo not emit another <JIT> block for this iteration.` }
          );
          i++;
          continue;
        }

        const isFinalIteration = i >= this.maxIterations - 1;
        if (isFinalIteration) {
          if (!finalSubmitRepairUsed) {
            finalSubmitRepairUsed = true;
            if (session) {
              session.emit({
                type: "status",
                step,
                content: "Final iteration requested a JIT peek; requesting synthesis from existing evidence.",
              });
            }
            this._emitStatus("format", "Final iteration requested JIT; requesting final answer");
            if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
              const firstUserMessage = iterMessages.find((message) => message.role === "user");
              if (firstUserMessage) {
                messages.push({ ...firstUserMessage });
                persistedFirstControlPrompt = true;
              }
            }
            messages.push(
              { role: "assistant", content: `${action.reasoning}\n\n<JIT>\n${action.jitCode}\n</JIT>` },
              {
                role: "user",
                content:
                  "You are on the final iteration. Do not call JIT, search, read, or inspection tools. Use the evidence already printed in the session. If a semantic sub-LLM call would materially improve the answer, call `llmQuery`, `llmQueryBatched`, or `llmQueryAgent` on evidence already in scope. Otherwise submit directly: put the complete markdown in <ANSWER>...</ANSWER>, then run `SUBMIT({ sources: [...] })` with exact file:line spans.",
              },
            );
            continue;
          }

          this._emitStatus("extract", "Final iteration still requested JIT; synthesizing from explored evidence");
          const fallback = await this._extractFallback(session!, query);
          return {
            answer: fallback.answer || "",
            sources: fallback.sources || [],
            confidence: fallback.confidence,
            finalReasoning: fallback.finalReasoning || "extraction fallback",
            trajectory: [],
            tokenUsage: { ...this.tokenUsage },
            _messages: messages,
          };
        }

        const jitExplorationIssue = generatedExplorationContractIssue(action.jitCode, query);
        if (jitExplorationIssue) {
          jitProbesThisIteration++;
          broadReadRewriteCount++;
          if (session) {
            session.emit({
              type: "status",
              step,
              content: "JIT attempted broad reads; requesting a tiny context peek or normal focused step.",
            });
          }
          this._emitStatus("jit", "JIT attempted broad reads; requesting targeted rewrite");
          if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
            const firstUserMessage = iterMessages.find((message) => message.role === "user");
            if (firstUserMessage) {
              messages.push({ ...firstUserMessage });
              persistedFirstControlPrompt = true;
            }
          }
          messages.push(
            { role: "assistant", content: `${action.reasoning}\n\n<JIT>\n${action.jitCode}\n</JIT>` },
            {
              role: "user",
              content:
                `${jitExplorationIssue}\n\n` +
                "JIT peeks are only for one tiny missing fact. Do not read whole files or multiple files in JIT. Use a normal focused ```js block with rg/inspect/listSymbols/readFileRange, or submit with exact sources if the existing evidence is enough.",
            },
          );
          retryingAfterJIT = true;
          continue;
        }

        jitProbesThisIteration++;
        const probe = await this._executeJITProbe(sandbox, action.jitCode, step, session);
        if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
          const firstUserMessage = iterMessages.find((message) => message.role === "user");
          if (firstUserMessage) {
            messages.push({ ...firstUserMessage });
            persistedFirstControlPrompt = true;
          }
        }
        messages.push(
          { role: "assistant", content: `${action.reasoning}\n\n<JIT>\n${action.jitCode}\n</JIT>` },
          {
            role: "user",
            content:
              `JIT output (${probe.resultType}, ${probe.durationMs}ms, probe ${jitProbesThisIteration}/${this.maxJITProbesPerIteration}, llmQuery ${this._jitLLMCallsThisIteration}/${this.maxJITLLMCallsPerIteration} for this iteration):\n` +
              `${probe.output}\n\n` +
              "Use this tiny context and now continue the same major iteration. Emit either one more <JIT> if a tiny missing fact remains, or exactly one ```js block for the real step.",
          }
        );
        retryingAfterJIT = true;
        continue;
      }

      // Emit reasoning to Session for durable recall. Display layers may still cap printed output.
      if (session) {
        session.emit({ type: "reasoning", step: stepOffset + i + 1, content: action.reasoning });
      }

      if (!action.code) {
        if (action.answer) {
          action.code = 'SUBMIT({ sources: [] });';
        } else {
          if (session) {
            session.emit({ type: "code", step: stepOffset + i + 1, content: "(no code generated)" });
          }
          if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
            const firstUserMessage = iterMessages.find((message) => message.role === "user");
            if (firstUserMessage) {
              messages.push({ ...firstUserMessage });
              persistedFirstControlPrompt = true;
            }
          }
          messages.push(
            { role: "assistant", content: action.reasoning },
            {
              role: "user",
              content:
                `${action.formatError ? `${action.formatError}\n\n` : ""}` +
                "You didn't write executable exploration code. Provide exactly one ```js fenced block containing runnable JavaScript that calls available sandbox tools like inspect, listFiles, rg, grep, readFile, llmQuery, or SUBMIT. Only call graphify tools if the current system prompt explicitly lists them as available. Do not put ASCII diagrams, Mermaid, markdown, or prose examples inside fenced blocks.",
            }
          );
          i++;
          continue;
        }
      }

      const parseIssue = generatedCodeParseIssue(action.code);
      if (parseIssue) {
        const step = stepOffset + i + 1;
        if (session) {
          session.emit({
            type: "status",
            step,
            content: "Generated JavaScript did not parse before execution; requesting a smaller valid rewrite.",
          });
        }
        this._emitStatus("format", "Generated JavaScript did not parse; requesting rewrite");
        if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
          const firstUserMessage = iterMessages.find((message) => message.role === "user");
          if (firstUserMessage) {
            messages.push({ ...firstUserMessage });
            persistedFirstControlPrompt = true;
          }
        }
        messages.push(
          {
            role: "assistant",
            content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
          },
          {
            role: "user",
            content:
              `The previous JavaScript did not parse before execution (${parseIssue}). ` +
              "Rewrite this step as one smaller valid ```js block. If you were trying to produce the final answer, put the Markdown in <ANSWER> outside the code block and put only SUBMIT({ sources }) in JavaScript.",
          },
        );
        i++;
        continue;
      }

      if (
        this._requireSemanticBeforeSubmit &&
        hasSubmitCall(action.code) &&
        getCallCount() <= semanticCallBaseline &&
        !hasSemanticSubLLMCall(action.code) &&
        !directRetrievalEvidenceReady(session, query) &&
        !directRetrievalSubmitCode(action.code, query)
      ) {
        const step = stepOffset + i + 1;
        const message = semanticSubmitGateMessage();
        if (session) {
          session.emit({
            type: "status",
            step,
            content: "SUBMIT rejected before execution because no semantic sub-LLM call has run in this RLM turn.",
          });
        }
        this._emitStatus("format", "SUBMIT rejected: semantic sub-LLM required");
        if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
          const firstUserMessage = iterMessages.find((message) => message.role === "user");
          if (firstUserMessage) {
            messages.push({ ...firstUserMessage });
            persistedFirstControlPrompt = true;
          }
        }
        messages.push(
          {
            role: "assistant",
            content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
          },
          { role: "user", content: message },
        );
        if (semanticSubmitRepairUsed) {
          i++;
        } else {
          semanticSubmitRepairUsed = true;
        }
        continue;
      }

      const isFinalIteration = i >= this.maxIterations - 1;
      if (isFinalIteration && !hasSubmitCall(action.code) && hasExplorationToolCall(action.code)) {
        const step = stepOffset + i + 1;
        if (!finalSubmitRepairUsed) {
          finalSubmitRepairUsed = true;
          if (session) {
            session.emit({
              type: "status",
              step,
              content: "Final iteration requested more exploration; requesting synthesis from existing evidence.",
            });
          }
          this._emitStatus("format", "Final iteration requested tools; requesting final answer");
          if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
            const firstUserMessage = iterMessages.find((message) => message.role === "user");
            if (firstUserMessage) {
              messages.push({ ...firstUserMessage });
              persistedFirstControlPrompt = true;
            }
          }
          messages.push(
            {
              role: "assistant",
              content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
            },
            {
              role: "user",
              content:
                "You are on the final iteration. Do not call more search/read/inspection tools. Use the evidence already printed in the session. If a semantic sub-LLM call would materially improve the answer, call `llmQuery`, `llmQueryBatched`, or `llmQueryAgent` on evidence already in scope. Otherwise submit directly: put the complete markdown in <ANSWER>...</ANSWER>, then run `SUBMIT({ sources: [...] })` with exact file:line spans.",
            },
          );
          continue;
        }

        this._emitStatus("extract", "Final iteration still requested tools; synthesizing from explored evidence");
        const fallback = await this._extractFallback(session!, query);
        return {
          answer: fallback.answer || "",
          sources: fallback.sources || [],
          confidence: fallback.confidence,
          finalReasoning: fallback.finalReasoning || "extraction fallback",
          trajectory: [],
          tokenUsage: { ...this.tokenUsage },
          _messages: messages,
        };
      }

      const explorationIssue = generatedExplorationContractIssue(action.code, query);
      if (explorationIssue) {
        broadReadRewriteCount++;
        const step = stepOffset + i + 1;
        if (session) {
          session.emit({
            type: "status",
            step,
            content: "Generated JavaScript attempted a broad read sweep; requesting a narrower discovery-first rewrite.",
          });
        }
        this._emitStatus("format", "Generated JavaScript attempted broad reads; requesting targeted rewrite");
        if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
          const firstUserMessage = iterMessages.find((message) => message.role === "user");
          if (firstUserMessage) {
            messages.push({ ...firstUserMessage });
            persistedFirstControlPrompt = true;
          }
        }
        messages.push(
          {
            role: "assistant",
            content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
          },
          {
            role: "user",
            content:
              `${explorationIssue}\n\n` +
              (broadReadRewriteCount >= 2
                ? "You have already been redirected away from broad reads. Do not try another whole-file sweep. If the session has enough evidence, submit with <ANSWER> plus SUBMIT({ sources }). Otherwise run exactly one rg/inspect/listSymbols/readFileRange step that prints exact line-numbered evidence."
                : "Rewrite this as one smaller valid ```js block. Step 0 should discover candidate files/symbols with rg/glob/inspect/listFiles/searchAll and print concise line-numbered evidence. Then, in later steps, read only the smallest line ranges needed. If you already have enough evidence, submit the final answer with <ANSWER> plus SUBMIT({ sources })."),
          },
        );
        i++;
        continue;
      }

      // Emit code to Session
      if (session) {
        session.emit({ type: "code", step: stepOffset + i + 1, content: action.code });
      }

      if (action.answer) {
        await sandbox.inject("__hostAnswer", action.answer);
      }

      const result = await sandbox.execute(action.code);

      this._log("Result type:", result.type);
      this._log("Output:", (result.output || "").slice(0, 300));

      if (result.type === "submit") {
        if (
          this._requireSemanticBeforeSubmit &&
          getCallCount() <= semanticCallBaseline &&
          !hasSemanticSubLLMCall(action.code) &&
          !directRetrievalEvidenceReady(session, query) &&
          !directRetrievalSubmitCode(action.code, query)
        ) {
          const step = stepOffset + i + 1;
          const message = semanticSubmitGateMessage();
          if (session) {
            session.emit({
              type: "status",
              step,
              content: "SUBMIT rejected after execution because no semantic sub-LLM call completed in this RLM turn.",
            });
          }
          this._emitStatus("format", "SUBMIT rejected after execution: semantic sub-LLM required");
          if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
            const firstUserMessage = iterMessages.find((message) => message.role === "user");
            if (firstUserMessage) {
              messages.push({ ...firstUserMessage });
              persistedFirstControlPrompt = true;
            }
          }
          messages.push(
            {
              role: "assistant",
              content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
            },
            { role: "user", content: message },
          );
          if (semanticSubmitRepairUsed) {
            i++;
          } else {
            semanticSubmitRepairUsed = true;
          }
          continue;
        }

        this._emitStatus("submit", "SUBMIT received!");
        this._emitStep(i + 1, this.maxIterations, action.reasoning, action.code, "(submitted)", "submit", this.tokenUsage);
        const outputs = (result.outputs || {}) as Record<string, unknown>;

        // Emit submit to Session
        if (session) {
          session.emit({
            type: "submit", step: stepOffset + i + 1,
            content: (outputs.answer as string) || "(submitted)",
          });
        }

        if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
          const firstUserMessage = iterMessages.find((message) => message.role === "user");
          if (firstUserMessage) {
            messages.push({ ...firstUserMessage });
            persistedFirstControlPrompt = true;
          }
        }

        messages.push(
          {
            role: "assistant",
            content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
          },
          { role: "user", content: `(Answer submitted successfully)` }
        );

        return {
          ...outputs,
          answer: (outputs.answer as string) || "",
          sources: (outputs.sources as string[]) || [],
          trajectory: [],
          finalReasoning: action.reasoning,
          tokenUsage: { ...this.tokenUsage },
          _messages: messages,
        };
      }

      const output =
        result.type === "error"
          ? `[Error] ${result.output}`
          : result.output || "(no output — if your task is done, call SUBMIT({sources}) to finish)";

      // Emit output to Session with rawOutput when available; agents should search/slice it, not replay it wholesale.
      if (session) {
        session.emit({
          type: result.type === "error" ? "error" : "output",
          step: stepOffset + i + 1,
          content: result.rawOutput ?? result.output ?? "",
          metadata: {
            definedVars: extractDefinedVars(action.code),
            readFiles: [...this._iterationReadFiles],
            toolCounts: { ...this._iterationToolCounts },
            keyFindings: extractKeyFindings(output),
            resultType: result.type,
          },
        });
      }

      this._emitStep(i + 1, this.maxIterations, action.reasoning, action.code, output, result.type, this.tokenUsage);

      if (!persistedFirstControlPrompt && this._firstUserMessageSuffix && messages.length === 0) {
        const firstUserMessage = iterMessages.find((message) => message.role === "user");
        if (firstUserMessage) {
          messages.push({ ...firstUserMessage });
          persistedFirstControlPrompt = true;
        }
      }

      const synthesisNudge = buildSynthesisNudge({
        step: i + 1,
        maxIterations: this.maxIterations,
        output,
        readFiles: this._iterationReadFiles,
      });

      messages.push(
        {
          role: "assistant",
          content: `${action.reasoning}\n\n\`\`\`js\n${action.code}\n\`\`\``,
        },
        {
          role: "user",
          content: `Output:\n${output}${synthesisNudge ? `\n\n${synthesisNudge}` : ""}`,
        }
      );
      i++;
    }

    this._log("Max iterations reached. Extracting fallback...");
    const fallback = await this._extractFallback(session!, query);
    return {
      answer: fallback.answer || "",
      sources: fallback.sources || [],
      confidence: fallback.confidence,
      finalReasoning: fallback.finalReasoning || "extraction fallback",
      trajectory: [],
      tokenUsage: { ...this.tokenUsage },
      _messages: messages,
    };
  }

  /**
   * Fallback: ask the LLM to synthesize an answer from whatever it explored.
   */
  async _extractFallback(session: Session, query: string): Promise<Partial<RLMQueryResult>> {
    const prompt = buildExtractPrompt(query, session);

    try {
      const response = await this.llm.generate(prompt);

      const parsed = parseExtractionResponse(response);
      if (parsed) return parsed;

      const repairPrompt = [
        "The previous extraction response was not valid JSON.",
        "Convert it to valid JSON only, preserving the answer content and any source paths or file:line spans.",
        "Required keys: answer, sources, confidence.",
        "",
        "Previous response:",
        response,
      ].join("\n");
      const repaired = await this.llm.generate(repairPrompt);
      this._accumulateUsage(this.llm);
      const repairedParsed = parseExtractionResponse(repaired);
      if (repairedParsed) return repairedParsed;

      return {
        answer: stripMarkdownFence(response) || response,
        sources: inferSourcesFromText(response),
        confidence: "medium",
        finalReasoning: "extraction fallback (raw response)",
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._log("Extraction fallback JSON parse failed:", message);
      return {
        answer: `Extraction attempted but failed: ${message}`,
        sources: [],
        confidence: "low",
        finalReasoning: "extraction fallback (error)",
      };
    }
  }

  _log(...args: unknown[]): void {
    if (this.verbose) console.log("[RLM]", ...args);
  }

  /**
   * Unified event emitter. All events flow through here.
   */
  _emit(event: RLMEvent): void {
    if (this.onEvent) {
      try { this.onEvent(event); } catch { }
    }
  }

  _emitStatus(phase: string, message: string): void {
    this._log(`[${phase}]`, message);
    this._emit({ type: "status", phase, message });
    // Backward-compat shim
    if (this.onStatus) {
      try { this.onStatus({ phase, message }); } catch { }
    }
  }

  _emitStep(step: number, maxSteps: number, reasoning: string, code: string, output: string, resultType: string, tokenUsage: TokenUsage): void {
    this._emit({ type: "step", step, maxSteps, reasoning, code, output, resultType, tokenUsage });
    // Backward-compat shim
    if (this.onStep) {
      try { this.onStep({ step, maxSteps, reasoning, code, output, type: resultType, tokenUsage }); } catch { }
    }
  }

  /** Accumulate token usage from an LLM client's lastUsage */
  _accumulateUsage(client: LLMClient): void {
    const u = client?.lastUsage;
    if (!u) return;
    this.tokenUsage.promptTokens += u.promptTokens || 0;
    this.tokenUsage.completionTokens += u.completionTokens || 0;
    this.tokenUsage.totalTokens += u.totalTokens || 0;
    this.tokenUsage.calls += 1;
  }

  /** Accumulate sub-LLM token usage from a getTokenUsage snapshot */
  _accumulateSubUsage(getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number }): void {
    const u = getTokenUsage();
    this.tokenUsage.promptTokens += u.promptTokens || 0;
    this.tokenUsage.completionTokens += u.completionTokens || 0;
    this.tokenUsage.totalTokens += u.totalTokens || 0;
    this.tokenUsage.calls += u.calls || 0;
  }
}
