import type { LLMClient } from "./types.ts";
import { AnthropicClient } from "./anthropic.ts";
import { OpenAIClient } from "./openai.ts";
import { GeminiClient } from "./gemini.ts";

const SOURCE_PATH_RE = /\b(?:(?:[\w@.+-]+:)?(?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.(?:[a-zA-Z][\w+.-]{0,8})|(?:README|CHANGELOG|LICENSE|package|pyproject|Cargo|go\.mod|tsconfig)\.[\w.-]+)\b/g;
const FILE_ANALYSIS_RE = /\b(?:summari[sz]e|analy[sz]e|explain|inspect|review|classify|compare|understand|list|trace|describe|what does|how does|methods?|signatures?|docstring|contract|implementation|architecture|key logic|public api|streaming response)\b/i;
const CODE_SIGNAL_RE = /\b(?:import|export|class|interface|type|function|const|let|var|return|async|await|def|from\s+["']|package\s+\w|public\s+(?:class|interface|static)|private\s+\w|protected\s+\w)\b/;

function hasEmbeddedSourceContent(prompt: string): boolean {
  const newlineCount = (prompt.match(/\n/g) || []).length;
  if (prompt.length >= 1200 && newlineCount >= 4) return true;
  if (/```[\s\S]{120,}```/.test(prompt)) return true;
  if (/(?:^|\n)\s*(?:={3,}|-{3,}|#{1,6}\s+|\*\*[^*\n]+?\*\*)[^\n]*(?:\n[\s\S]{250,})/.test(prompt)) return true;
  if (newlineCount >= 5 && CODE_SIGNAL_RE.test(prompt)) return true;
  return false;
}

function validateLLMQueryPrompt(prompt: string, toolName: string, index?: number): void {
  const sourcePaths = prompt.match(SOURCE_PATH_RE) || [];
  if (sourcePaths.length === 0) return;
  if (!FILE_ANALYSIS_RE.test(prompt)) return;
  if (hasEmbeddedSourceContent(prompt)) return;

  const location = index == null ? "" : ` prompts[${index}]`;
  const sample = Array.from(new Set(sourcePaths)).slice(0, 3).join(", ");
  throw new Error(
    `${toolName}${location}: sub-LLM prompts are not path-aware. ` +
    `This prompt names source path(s) (${sample}) but does not include the file contents. ` +
    `Read files first and pass the content variable into the prompt, e.g. ` +
    `const code = await readFile("src/file.ts"); await llmQuery("Analyze src/file.ts:\\n" + code);`
  );
}

/** Hard cap per sub-LLM API call. Multi-turn sub-agents get this cap per turn. */
const DEFAULT_SUB_LLM_MAX_TOKENS = 4096;
const HARD_SUB_LLM_MAX_TOKENS = 4096;
const DEFAULT_SUB_AGENT_MAX_TURNS = 4;
const HARD_SUB_AGENT_MAX_TURNS = 12;

export interface LLMQueryAgentRequest {
  task: string;
  evidence: string;
  maxTurns?: number;
  maxOutputTokens?: number;
}

export interface LLMQueryAgentResult {
  answer: string;
  turns: number;
  transcript: Array<{ turn: number; output: string }>;
  stopped: "final" | "max_turns";
}

export interface LLMToolOptions {
  maxOutputTokens?: number;
  defaultAgentMaxTurns?: number;
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/**
 * Run `fn` with `subLM.maxTokens` temporarily pinned to the requested cap.
 * Restores the prior value even on throw. The cast is needed because the
 * LLMClient interface doesn't declare `maxTokens`, but BaseClient and every
 * concrete provider client does.
 */
async function withSubLMMaxTokens<T>(subLM: LLMClient, maxTokens: number, fn: () => Promise<T>): Promise<T> {
  const client = subLM as LLMClient & { maxTokens?: number };
  const prev = client.maxTokens;
  client.maxTokens = Math.min(Math.max(1, maxTokens), HARD_SUB_LLM_MAX_TOKENS);
  try {
    return await fn();
  } finally {
    client.maxTokens = prev;
  }
}

/**
 * Create sub-LLM tool functions (llmQuery + llmQueryBatched + llmQueryAgent).
 * These are registered as host-side tools and called from the sandbox via IPC.
 *
 * @param subLM - LLM client with a generate(prompt) method
 * @param maxCalls - Max total sub-LLM invocations
 */
export function makeLLMTools(subLM: LLMClient, maxCalls: number = 5000, opts: LLMToolOptions = {}): {
  llmQuery: (prompt: string) => Promise<string>;
  llmQueryBatched: (prompts: string[]) => Promise<string[]>;
  llmQueryAgent: (request: LLMQueryAgentRequest | string, evidence?: string) => Promise<LLMQueryAgentResult>;
  getCallCount: () => number;
  getTokenUsage: () => { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
} {
  let callCount = 0;
  let subTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  const defaultMaxOutputTokens = clampPositiveInt(opts.maxOutputTokens, DEFAULT_SUB_LLM_MAX_TOKENS, HARD_SUB_LLM_MAX_TOKENS);
  const defaultAgentMaxTurns = clampPositiveInt(opts.defaultAgentMaxTurns, DEFAULT_SUB_AGENT_MAX_TURNS, HARD_SUB_AGENT_MAX_TURNS);

  function reserveSubCalls(count: number, label: string): void {
    if (callCount + count > maxCalls) {
      throw new Error(`${label}: sub-LLM call limit would be exceeded (${callCount + count}/${maxCalls}).`);
    }
    callCount += count;
  }

  async function generateSubTurn(prompt: string, maxOutputTokens = defaultMaxOutputTokens): Promise<string> {
    const result = await withSubLMMaxTokens(subLM, maxOutputTokens, () => subLM.generate(prompt));
    const u = subLM.lastUsage;
    if (u) {
      subTokenUsage.promptTokens += u.promptTokens || 0;
      subTokenUsage.completionTokens += u.completionTokens || 0;
      subTokenUsage.totalTokens += u.totalTokens || 0;
      subTokenUsage.calls += 1;
    }
    return result;
  }

  async function llmQuery(prompt: string): Promise<string> {
    if (!prompt || typeof prompt !== "string") {
      throw new Error(
        `llmQuery: prompt must be a non-empty string, got ${typeof prompt}: ${JSON.stringify(prompt).slice(0, 100)}`
      );
    }
    validateLLMQueryPrompt(prompt, "llmQuery");
    reserveSubCalls(1, "llmQuery");
    return generateSubTurn(prompt);
  }

  async function llmQueryBatched(prompts: string[]): Promise<string[]> {
    if (!Array.isArray(prompts)) {
      throw new Error(
        `llmQueryBatched: prompts must be an array of strings, got ${typeof prompts}`
      );
    }
    if (prompts.length === 0) {
      return [];
    }
    for (let i = 0; i < prompts.length; i++) {
      if (typeof prompts[i] !== "string") {
        throw new Error(
          `llmQueryBatched: prompts[${i}] must be a string, got ${typeof prompts[i]}`
        );
      }
      validateLLMQueryPrompt(prompts[i], "llmQueryBatched", i);
    }
    reserveSubCalls(prompts.length, "llmQueryBatched");

    // Concurrent execution — limit to 3 to avoid Bun socket exhaustion
    const CONCURRENCY = 3;
    const results = new Array<string>(prompts.length);

    for (let i = 0; i < prompts.length; i += CONCURRENCY) {
      const batch = prompts.slice(i, i + CONCURRENCY);
      const batchResults = await withSubLMMaxTokens(subLM, defaultMaxOutputTokens, () =>
        Promise.all(
          batch.map(async (p) => {
            const r = await subLM.generate(p);
            const u = subLM.lastUsage;
            if (u) {
              subTokenUsage.promptTokens += u.promptTokens || 0;
              subTokenUsage.completionTokens += u.completionTokens || 0;
              subTokenUsage.totalTokens += u.totalTokens || 0;
              subTokenUsage.calls += 1;
            }
            return r;
          })
        )
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  }

  async function llmQueryAgent(requestOrTask: LLMQueryAgentRequest | string, evidenceInput?: string): Promise<LLMQueryAgentResult> {
    const request = typeof requestOrTask === "string"
      ? { task: requestOrTask, evidence: evidenceInput || "" }
      : requestOrTask;
    if (!request || typeof request !== "object") {
      throw new Error("llmQueryAgent: provide { task, evidence, maxTurns?, maxOutputTokens? }");
    }
    if (!request.task || typeof request.task !== "string") {
      throw new Error("llmQueryAgent: task must be a non-empty string");
    }
    if (!request.evidence || typeof request.evidence !== "string") {
      throw new Error("llmQueryAgent: evidence must be a non-empty string containing actual content, not paths only");
    }
    validateLLMQueryPrompt(`${request.task}\n\n${request.evidence}`, "llmQueryAgent");

    const maxTurns = clampPositiveInt(request.maxTurns, defaultAgentMaxTurns, HARD_SUB_AGENT_MAX_TURNS);
    const maxOutputTokens = clampPositiveInt(request.maxOutputTokens, defaultMaxOutputTokens, HARD_SUB_LLM_MAX_TOKENS);
    const transcript: Array<{ turn: number; output: string }> = [];
    let stopped: "final" | "max_turns" = "max_turns";

    for (let turn = 1; turn <= maxTurns; turn++) {
      reserveSubCalls(1, "llmQueryAgent");
      const prior = transcript.length
        ? `\n\nPrevious turns:\n${transcript.map((row) => `Turn ${row.turn}:\n${row.output}`).join("\n\n")}`
        : "";
      const prompt = [
        "You are a semantic sub-agent. You cannot read files, run tools, or fetch paths.",
        "Use only the task and evidence below. Decompose internally across turns if useful.",
        "When the answer is ready, start with `FINAL:`. If another turn would materially improve the answer, start with `CONTINUE:` and state the next reasoning target.",
        `Turn budget: ${turn}/${maxTurns}. Per-turn output cap: ${maxOutputTokens} tokens.`,
        "",
        `Task:\n${request.task}`,
        "",
        `Evidence:\n${request.evidence}`,
        prior,
      ].join("\n");
      const output = await generateSubTurn(prompt, maxOutputTokens);
      transcript.push({ turn, output });
      if (/^\s*FINAL\s*:/i.test(output) || turn === maxTurns) {
        stopped = /^\s*FINAL\s*:/i.test(output) ? "final" : "max_turns";
        break;
      }
    }

    const last = transcript[transcript.length - 1]?.output ?? "";
    return {
      answer: last.replace(/^\s*(?:FINAL|CONTINUE)\s*:\s*/i, "").trim(),
      turns: transcript.length,
      transcript,
      stopped,
    };
  }

  return {
    llmQuery,
    llmQueryBatched,
    llmQueryAgent,
    getCallCount: () => callCount,
    getTokenUsage: () => ({ ...subTokenUsage }),
  };
}


/**
 * Creates LSP tool functions for the agent.
 *
 * @param workspaceRoot - The root directory of the workspace
 */
export function makeLSPTools(workspaceRoot: string = process.cwd()): {
  lsp_query: (operation: string, filePath: string, line: number, character: number) => Promise<unknown>;
} {
  async function lsp_query(operation: string, filePath: string, line: number, character: number): Promise<unknown> {
    // Dynamically import the LSP class so we only spawn servers when needed
    const { LSP } = await import("../lsp/index.js");
    const { join, isAbsolute } = await import("node:path");

    // Resolve relative paths against the workspace root
    const absPath = isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);

    try {
      if (operation === "goToDefinition") {
        return await LSP.goToDefinition(absPath, workspaceRoot, line, character);
      } else if (operation === "findReferences") {
        return await LSP.findReferences(absPath, workspaceRoot, line, character);
      } else {
        throw new Error("Unsupported LSP operation: " + operation);
      }
    } catch (err) {
      return { error: (err as Error).message, note: "Check if the file path is correct and the language server is installed." };
    }
  }

  return { lsp_query };
}


/**
 * Create a web search tool that delegates to the appropriate provider's web search implementation
 * based on the LLM client type (AnthropicClient uses web_search_20250305, OpenAIClient uses
 * Responses API web_search_preview, GeminiClient uses googleSearch grounding tool).
 *
 * @param llm - LLM client (must be AnthropicClient, OpenAIClient, or GeminiClient)
 */
export function makeWebSearchTool(llm: LLMClient): { run_websearch: (query: string) => Promise<string> } {
  async function run_websearch(query: string): Promise<string> {
    if (llm instanceof AnthropicClient) {
      return llm.run_websearch(query);
    } else if (llm instanceof OpenAIClient) {
      return llm.run_websearch(query);
    } else if (llm instanceof GeminiClient) {
      return llm.run_websearch(query);
    }
    throw new Error("run_websearch requires AnthropicClient, OpenAIClient, or GeminiClient");
  }

  return { run_websearch };
}
