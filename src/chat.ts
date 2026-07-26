import { RLM } from "rlm-bun";
import { JCodeAgent, buildWorkspaceQuery } from "./jcode-runtime.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { MCPConfig, RLMEvent } from "./jcode-runtime.ts";
import { buildChatPrompt, renderClarifyBlock, type AskIntent } from "./prompts/chat.ts";
import { renderAskHistoryBlock } from "./prompts/ask-history.ts";
import { preludeForRuntime } from "./prompts/prelude.ts";
import { normalizeRepoSourcePath, type RepoRef, type WikiRecord, type WorkspaceRepoRef } from "./types.ts";
import { WikiStore } from "./storage.ts";
import { resolveChannel, makeLLM, DEFAULT_CHANNEL_ID } from "./llm.ts";
import { makeRlmLLM } from "./rlm-llm.ts";
import { normalizeAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { jcodeControlsForSurface, localCliControlsForSurface, rlmControlsForSurface } from "./model-control.ts";
import type { ProviderSecrets } from "./provider-secrets.ts";
import type { LocalCliConfig } from "./local-cli-events.ts";
import { knowledgeProfilePrompt, normalizeKnowledgeProfile, type KnowledgeProfile } from "./knowledge-profile.ts";
import type { CodeScreenshotAttachment } from "./vision.ts";

export type WorkspaceGoal = "compare" | "steal" | "understand" | "bridge" | "audit";
export type AskMode = "fast" | "deep";

export type ChatEvent =
  | { type: "agent"; event: RLMEvent }
  | { type: "answer"; answer: string; sources: string[] }
  | { type: "error"; error: string };

export interface ChatOptions {
  /** Model-channel id (e.g. "gemini-3.1-pro-preview", "kimi-k2.6"). */
  channel?: string;
  /** @deprecated alias for `channel`. */
  model?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  wiki?: WikiRecord | null;
  wikiContexts?: Array<{ id: string; label: string; context: string }>;
  store?: WikiStore;
  onEvent?: (ev: ChatEvent) => void;
  maxIterations?: number;
  workspaceGoal?: WorkspaceGoal | null;
  askMode?: AskMode;
  askIntent?: AskIntent;
  /** Clarify-interview transcript ("- <question>: <answer>"). Refines the prompt. */
  clarifyContext?: string | null;
  runtime?: AgentRuntime | string;
  localCli?: LocalCliConfig | unknown;
  /**
   * Server/programmatic capability hooks. Do not expose raw MCP configs from
   * untrusted browser input; MCP stdio servers can execute local commands.
   */
  mcpConfig?: MCPConfig;
  skillSources?: string[];
  knowledgeProfile?: unknown;
  /** Screenshot attachments for native-vision local-cli agents (codex --image / file-path-in-prompt). Ignored by RLM/JCode runtimes (no native image channel). */
  screenshots?: CodeScreenshotAttachment[];
  providerSecrets?: ProviderSecrets;
  signal?: AbortSignal;
}

/**
 * One-shot Q&A against a GitHub repo.
 *
 * If a generated wiki exists for the repo, its titles + descriptions are
 * passed as lightweight context so JCODE can skip re-discovering the
 * architecture from scratch.
 */
export async function askRepo(
  ref: RepoRef,
  question: string,
  opts: ChatOptions = {},
): Promise<{ answer: string; sources: string[] }> {
  const channel = resolveChannel(opts.channel ?? opts.model ?? DEFAULT_CHANNEL_ID);
  const store = opts.store ?? new WikiStore();
  const wiki = opts.wiki ?? store.loadForRef(ref);
  const emit = opts.onEvent ?? (() => {});
  const askMode = opts.askMode ?? "deep";
  const askIntent = opts.askIntent ?? "repo";
  const runtime = normalizeAgentRuntime(opts.runtime, "rlm");
  const modelContext = { surface: "chat" as const, depth: askMode };
  const knowledgeProfile = normalizeKnowledgeProfile(opts.knowledgeProfile);

  const explicitWikiContext = opts.wikiContexts?.length
    ? opts.wikiContexts.map((entry) => `### ${entry.id} (${entry.label})\n${entry.context}`).join("\n\n")
    : "";
  const wikiContext = explicitWikiContext || (wiki ? summariseWiki(wiki) : null);

  const runAttempt = async (attemptPrompt: string): Promise<{ answer: string; sources: string[] }> => {
    const Agent = (runtime === "local-cli" ? LocalCliAgent : runtime === "rlm" ? RLM : JCodeAgent) as any;
    const controls = runtime === "local-cli"
      ? localCliControlsForSurface(channel, modelContext)
      : runtime === "rlm"
        ? rlmControlsForSurface(channel, modelContext)
        : jcodeControlsForSurface(channel, modelContext);
    const llm = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets);
    const subLM = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets);
    const agent = new Agent({
      source: ref.url,
      branch: ref.branch,
      sourcePath: ref.sourcePath ?? null,
      ...(llm ? { llm } : {}),
      ...(subLM ? { subLM } : {}),
      ...(runtime === "local-cli" && Array.isArray(opts.screenshots) && opts.screenshots.length ? { screenshots: opts.screenshots } : {}),
      ...controls,
      maxIterations: opts.maxIterations ?? (runtime === "rlm" ? askMode === "fast" ? 5 : 15 : askMode === "fast" ? 6 : 15),
      maxLLMCalls: runtime === "rlm" ? askMode === "fast" ? 40 : 200 : askMode === "fast" ? 60 : 200,
      sandboxTimeout: 1_800_000,
      sessionDir: store.sessionsDir,
      mcpConfig: opts.mcpConfig,
      localCli: opts.localCli,
      contextLabel: "ask",
      onEvent: (ev: RLMEvent) => emit({ type: "agent", event: ev }),
    } as any) as { query(prompt: string, signal?: AbortSignal): Promise<{ answer: string; sources: string[] }> };

    return agent.query(attemptPrompt, opts.signal);
  };

  const prompt = preludeForRuntime(channel.id, askMode, runtime) + buildChatPrompt({
    owner: ref.owner,
    repo: ref.repo,
    question,
    history: opts.history,
    wikiContext,
    askMode,
    askIntent,
    clarifyContext: opts.clarifyContext ?? null,
    runtime,
    sourcePath: ref.sourcePath ?? null,
    knowledgeProfile,
  });

  try {
    const first = normalizeAskRunResult(await runAttempt(prompt));
    const firstIssue = askAnswerQualityIssue(question, first.answer, first.sources, askMode, askIntent, runtime);
    const result = firstIssue
      ? normalizeAskRunResult(await runAttempt(buildAskStrictRetryPrompt(prompt, firstIssue, runtime)))
      : first;
    const finalIssue = askAnswerQualityIssue(question, result.answer, result.sources, askMode, askIntent, runtime);
    if (firstIssue) emitAskRetryStatus(emit, firstIssue, finalIssue);
    const { answer, sources } = result;
    emit({ type: "answer", answer, sources });
    return { answer, sources };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "error", error: msg });
    throw e;
  }
}

/**
 * One-shot Q&A against multiple GitHub repositories.
 *
 * JCODE clones each source into a workspace and runs from the workspace root.
 * We keep this GitHub-only at the web/API layer by accepting already-parsed
 * `WorkspaceRepoRef`s rather than raw local paths.
 */
export async function askWorkspace(
  refs: WorkspaceRepoRef[],
  question: string,
  opts: ChatOptions = {},
): Promise<{ answer: string; sources: string[] }> {
  if (refs.length < 2) {
    throw new Error("askWorkspace requires at least two repositories");
  }

  const channel = resolveChannel(opts.channel ?? opts.model ?? DEFAULT_CHANNEL_ID);
  const store = opts.store ?? new WikiStore();
  const emit = opts.onEvent ?? (() => {});
  const askMode = opts.askMode ?? "deep";
  const askIntent = opts.askIntent ?? "repo";
  const runtime = normalizeAgentRuntime(opts.runtime, "rlm");
  const modelContext = { surface: "chat" as const, depth: askMode };
  const knowledgeProfile = normalizeKnowledgeProfile(opts.knowledgeProfile);

  const wikiContexts = [
    ...(opts.wikiContexts || []),
    ...refs.map((ref) => {
      const wiki = store.loadForRef(ref);
      if (!wiki) return null;
      return {
        id: ref.id,
        label: ref.label,
        context: summariseWiki(wiki),
      };
    }).filter((entry): entry is { id: string; label: string; context: string } => Boolean(entry)),
  ];

  const runAttempt = async (attemptPrompt: string): Promise<{ answer: string; sources: string[] }> => {
    const Agent = (runtime === "local-cli" ? LocalCliAgent : runtime === "rlm" ? RLM : JCodeAgent) as any;
    const controls = runtime === "local-cli"
      ? localCliControlsForSurface(channel, modelContext)
      : runtime === "rlm"
        ? rlmControlsForSurface(channel, modelContext)
        : jcodeControlsForSurface(channel, modelContext);
    const llm = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets);
    const subLM = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets);
    const agent = new Agent({
      sources: refs.map((ref) => ({
        id: ref.id,
        source: ref.url,
        branch: ref.branch,
        sourcePath: ref.sourcePath ?? null,
        label: ref.label,
      })),
      mode: "workspace",
      ...(llm ? { llm } : {}),
      ...(subLM ? { subLM } : {}),
      ...(runtime === "local-cli" && Array.isArray(opts.screenshots) && opts.screenshots.length ? { screenshots: opts.screenshots } : {}),
      ...controls,
      maxIterations: opts.maxIterations ?? (runtime === "rlm" ? askMode === "fast" ? 6 : 18 : askMode === "fast" ? 7 : 18),
      maxLLMCalls: runtime === "rlm" ? askMode === "fast" ? 60 : 350 : askMode === "fast" ? 80 : 350,
      sandboxTimeout: 1_800_000,
      sessionDir: store.sessionsDir,
      mcpConfig: opts.mcpConfig,
      localCli: opts.localCli,
      contextLabel: "ask",
      onEvent: (ev: RLMEvent) => emit({ type: "agent", event: ev }),
    } as any) as { query(prompt: string, signal?: AbortSignal): Promise<{ answer: string; sources: string[] }> };

    return agent.query(attemptPrompt, opts.signal);
  };

  const workspaceQuery = opts.workspaceGoal
    ? buildWorkspaceQuery(opts.workspaceGoal, refs.map((ref) => ref.id), question)
    : null;

  const prompt = preludeForRuntime(channel.id, askMode, runtime) + buildWorkspaceChatPrompt({
    repos: refs,
    question,
    history: opts.history,
    wikiContexts,
    workspaceQuery,
    workspaceGoal: opts.workspaceGoal,
    askMode,
    askIntent,
    clarifyContext: opts.clarifyContext ?? null,
    runtime,
    knowledgeProfile,
  });

  try {
    const first = normalizeAskRunResult(await runAttempt(prompt));
    const firstIssue = askAnswerQualityIssue(question, first.answer, first.sources, askMode, askIntent, runtime);
    const result = firstIssue
      ? normalizeAskRunResult(await runAttempt(buildAskStrictRetryPrompt(prompt, firstIssue, runtime)))
      : first;
    const finalIssue = askAnswerQualityIssue(question, result.answer, result.sources, askMode, askIntent, runtime);
    if (firstIssue) emitAskRetryStatus(emit, firstIssue, finalIssue);
    const { answer, sources } = result;
    emit({ type: "answer", answer, sources });
    return { answer, sources };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "error", error: msg });
    throw e;
  }
}

function normalizeAskSources(answer: string, sources: string[]): string[] {
  const inferred = inferAskSourcesFromAnswer(answer);
  return Array.from(new Set([...sources, ...inferred])).sort();
}

function normalizeAskRunResult(result: { answer: string; sources: string[] }): { answer: string; sources: string[] } {
  const answer = result.answer.trim();
  return {
    answer,
    sources: normalizeAskSources(answer, result.sources),
  };
}

/** Exported for unit tests covering Agent empty-answer retries. */
export function askAnswerQualityIssue(
  question: string,
  answer: string,
  sources: string[],
  askMode: AskMode,
  askIntent: AskIntent = "repo",
  runtime: AgentRuntime = "rlm",
): string | null {
  const text = answer.trim();
  if (text.length < 80) return "the Ask answer was empty or too thin";
  if (looksLikeMalformedAnswerFragment(text)) {
    return "the Ask answer looked like a malformed fragment instead of a complete direct answer";
  }
  if (looksLikeUnfinishedAskAnswer(text)) {
    return "the Ask answer looked like unfinished exploration instead of final user-facing markdown";
  }
  if (looksLikePlaceholderAskAnswer(text)) return "the Ask answer looked like a placeholder";

  // Agent / local-cli: only gate structural emptiness and unfinished/placeholder
  // answers. Citation depth stays advisory via the prompt (avoid retry churn).
  if (runtime !== "rlm") return null;

  const requiresEvidence = requiresAskEvidence(question, text);
  if (askIntent === "docs-inline") return null;
  if (requiresEvidence && sources.length === 0) return "the Ask answer had no persisted sources";
  if (requiresEvidence && countAskLineCitations(text) === 0 && text.length > 220) {
    return "the Ask answer had no file:line citations";
  }
  if (askMode === "deep" && requiresEvidence) {
    const deepIssue = deepAskEvidenceIssue(question, text, sources);
    if (deepIssue) return deepIssue;
  }
  return null;
}

function requiresAskEvidence(question: string, answer: string): boolean {
  return /\b(code|repo|file|line|module|function|class|component|hook|command|test|trace|lifecycle|implementation|architecture|where|how|why|audit|review|verify|source|citation)\b/i.test(
    `${question}\n${answer}`,
  );
}

function requiresDeepAskEvidence(question: string, answer: string): boolean {
  return /\b(architecture|lifecycle|trace|flow|pipeline|implementation|how|why|explain|overview|summari[sz]e|audit|review|regression|security|performance|design|entry\s*points?|callers?|config|tests?|compare|investigate)\b/i.test(
    `${question}\n${answer}`,
  );
}

function deepAskEvidenceIssue(question: string, answer: string, sources: string[]): string | null {
  const lineCitationCount = countAskLineCitations(answer);
  const distinctSourceCount = countDistinctAskSourceFiles(sources);
  const limitedScope = /\b(single-file|single file|tiny repo|tiny repository|only one relevant file|no other relevant|no additional relevant|nothing else matched|no matches|not present|does not contain)\b/i.test(answer);
  const deepEvidenceRequired = requiresDeepAskEvidence(question, answer);

  if (deepEvidenceRequired && lineCitationCount < 3 && !limitedScope) {
    return "Deep Ask answered with fewer than three precise evidence spans";
  }
  if (deepEvidenceRequired && distinctSourceCount < 2 && !limitedScope) {
    return "Deep Ask answered from fewer than two distinct source files without explaining limited repository scope";
  }
  if (!deepEvidenceRequired && answer.length > 450 && lineCitationCount < 2 && !limitedScope) {
    return "Deep Ask answer was citation-light for its length";
  }
  return null;
}

function countDistinctAskSourceFiles(sources: string[]): number {
  const files = new Set<string>();
  for (const source of sources) {
    const trimmed = source.trim();
    if (!trimmed) continue;
    files.add(trimmed.replace(/:\d+(?:-\d+)?$/, ""));
  }
  return files.size;
}

function looksLikeMalformedAnswerFragment(answer: string): boolean {
  const trimmed = answer.trim();
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  return (
    /^`[^`]*`\s+tag\b/i.test(firstLine) ||
    /^['"`)\]}>,.;:-]+\s+\w/.test(firstLine) ||
    /\b(?:ANSWER|SUBMIT|markdown)\s+(?:tag|fence|format)\b/i.test(firstLine)
  );
}

function looksLikeUnfinishedAskAnswer(answer: string): boolean {
  const leading = answer.slice(0, 1200);
  return (
    /```(?:js|javascript)[\s\S]*\b(?:readFile|readFileRange|rg|grep|glob|inspect|llmQuery|llmQueryBatched|experiment|forge_tool|list_mcp_tools|mcp_tool_schema|mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+|SUBMIT)\s*\(/i.test(answer) ||
    (/^\s*(?:now i|let me|i(?:'ll| will| need to)|actually,?\s+let me|i have enough|i'm ready)\b/i.test(leading) &&
      /\b(?:read|search|inspect|verify|submit|synthesize|execute|call|post|send|tool|mcp|slack|final answer|targeted reads?)\b/i.test(leading))
  );
}

function looksLikePlaceholderAskAnswer(answer: string): boolean {
  return /^(?:todo|placeholder|writing answer|submitting|see below|i cannot access|unable to access|not enough information)\b/i.test(answer.trim());
}

const CITABLE_PATH_PATTERN = String.raw`(?:(?:[\w@.-]+\/)?[\w@.-]+:)?(?:[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|css|html|svelte|vue|yml|yaml|toml|lock|sh|mjs|cjs|mts|cts)|(?:[\w@./-]+/)?(?:README|LICENSE|Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Brewfile|Justfile|Taskfile))`;

function countAskLineCitations(text: string): number {
  const matches = text.match(new RegExp(String.raw`\b${CITABLE_PATH_PATTERN}:\d+(?:[-–]\d+)?\b`, "g"));
  return matches?.length ?? 0;
}

/** Exported for unit tests covering Agent empty-answer retries. */
export function buildAskStrictRetryPrompt(
  prompt: string,
  issue: string,
  runtime: AgentRuntime = "rlm",
): string {
  if (runtime !== "rlm") {
    return `${prompt}

## STRICT RETRY REPAIR
The previous Ask attempt was rejected because ${issue}.

This attempt must repair the final-answer contract:
- Do not end after tools only. Exploration notes, planning text, or an empty body are not answers.
- Write the full user-facing markdown inside <ANSWER>...</ANSWER> only after you have enough evidence.
- The <ANSWER> body must be non-empty substantive Markdown that directly answers the question.
- Include exact file:line citations in the prose for every implementation claim when evidence is available.
- Do not call SUBMIT.
- If a path cannot be found, show the search evidence briefly in the answer and cite the closest verified files instead of guessing.`;
  }

  return `${prompt}

## STRICT RETRY REPAIR
The previous Ask attempt was rejected because ${issue}.

This attempt must repair the final-answer contract:
- Do not submit exploration notes, planning text, or JavaScript tool code as the answer.
- Write the full user-facing markdown inside <ANSWER>...</ANSWER> only after you have enough evidence.
- Include exact file:line citations in the prose for every implementation claim.
- Call SUBMIT({ sources }) with a non-empty list of the same exact file:line spans.
- For MCP/external side effects, do not output the script you were about to run. If the action succeeded, state what was done and include the returned id/timestamp/link. If it failed, state that it was not completed, include the MCP error/log id, and do not imply success.
- If a path cannot be found, show the search evidence briefly in the answer and cite the closest verified files instead of guessing.`;
}

function emitAskRetryStatus(
  emit: (ev: ChatEvent) => void,
  issue: string,
  finalIssue: string | null,
): void {
  emit({
    type: "agent",
    event: {
      type: "status",
      phase: "ask-retry",
      message: finalIssue
        ? `Ask retry attempted after validation issue (${issue}); retry still had an issue (${finalIssue}).`
        : `Ask retry repaired validation issue: ${issue}.`,
    } as RLMEvent,
  });
}

function inferAskSourcesFromAnswer(answer: string): string[] {
  const sources = new Set<string>();
  const citationPattern = new RegExp(
    String.raw`\b(${CITABLE_PATH_PATTERN}:\d+(?:[-–]\d+)?)\b`,
    "g",
  );
  for (const match of answer.matchAll(citationPattern)) {
    sources.add(match[1]);
  }

  const sourcesSection = /##?\s*Sources\b([\s\S]*)$/i.exec(answer)?.[1] ?? "";
  const sectionPattern = new RegExp(
    String.raw`(${CITABLE_PATH_PATTERN}(?::\d+(?:[-–]\d+)?)?)`,
    "g",
  );
  for (const match of sourcesSection.matchAll(sectionPattern)) {
    sources.add(match[1]);
  }

  return [...sources];
}

function summariseWiki(wiki: WikiRecord): string {
  const lines = [
    `**${wiki.structure.title}** — ${wiki.structure.description}`,
    "",
    "Pages already documented (see title + description — full content lives on disk):",
  ];
  for (const p of wiki.structure.pages) {
    lines.push(`- \`${p.id}\` — **${p.title}**: ${p.description}`);
  }
  return lines.join("\n");
}

export function buildWorkspaceChatPrompt(args: {
  repos: WorkspaceRepoRef[];
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  wikiContexts?: Array<{ id: string; label: string; context: string }>;
  workspaceQuery?: string | null;
  workspaceGoal?: WorkspaceGoal | null;
  askMode?: AskMode;
  askIntent?: AskIntent;
  clarifyContext?: string | null;
  runtime?: AgentRuntime;
  knowledgeProfile?: KnowledgeProfile;
}): string {
  const {
    repos,
    question,
    history = [],
    wikiContexts = [],
    workspaceQuery,
    workspaceGoal,
    askMode = "deep",
    askIntent = "repo",
    runtime = "agent",
    knowledgeProfile,
  } = args;
  const docsInline = askIntent === "docs-inline";
  const clarifyBlock = renderClarifyBlock(args.clarifyContext);

  const repoList = repos
    .map((ref) => `- \`${ref.id}/\` — **${ref.label}**${ref.branch ? ` @ ${ref.branch}` : ""}${ref.sourcePath ? ` (scope: ${ref.sourcePath})` : ""}`)
    .join("\n");
  const hasScopedRepos = repos.some((ref) => !!normalizeRepoSourcePath(ref.sourcePath));

  const historyBlock = renderAskHistoryBlock(history);

  const wikiBlock = wikiContexts.length
    ? docsInline
      ? `## Documentation context
Use this generated documentation MDX as the primary source for this answer. Before using any file, search, read, or shell tool, decide whether this MDX is sufficient. If it fully answers the question, do not inspect repository files.

${wikiContexts
  .map((entry) => `### ${entry.id} (${entry.label})\n${entry.context}`)
  .join("\n\n")}

`
      : `## Wiki context
Use this generated wiki context as a starting map only. Verify claims against repository files before answering.

${wikiContexts
  .map((entry) => `### ${entry.id} (${entry.label})\n${entry.context}`)
  .join("\n\n")}

`
    : "";

  const workspaceQueryBlock = workspaceQuery
    ? `## Workspace strategy${workspaceGoal ? ` (${workspaceGoal})` : ""}
${workspaceQuery}

`
    : "";

  const modeBlock = askMode === "fast"
    ? `## Ask mode: Fast
Optimize for a direct, evidence-backed answer in under one minute. Do the smallest useful cross-repo inspection, then answer once the claim is supported.

`
    : `## Ask mode: Deep
Do a thorough multi-repo investigation. Spend extra effort on architecture, trace, audit, comparison, and "why" questions.

	`;
  const knowledgeBlock = knowledgeProfilePrompt(knowledgeProfile, "ask");
  const sourceScopeBlock = hasScopedRepos
    ? `## Source scopes
Some repositories are scoped to a folder path. Treat each listed scope as that repository's source root. Do not inspect unrelated folders outside a repo's scope. If tools expose the full checkout under the repo folder, start inside the scoped subfolder before reading files. Cite paths exactly as returned by the tool, preserving any repo id and scope prefix that appears.

`
    : "";

  const harnessBlock = docsInline
    ? runtime === "rlm"
      ? "Use the rlm-bun JavaScript sandbox from the workspace root only when the Documentation context is missing, ambiguous, or needs implementation verification. Before running any file, search, read, or shell tool, compare the question against the Documentation context. If the generated MDX answers the question, answer directly from it without repository inspection."
      : runtime === "local-cli"
      ? "A local CLI agent is running from the workspace root. Start from the Documentation context. Before running native file, search, read, or shell tools, compare the question against the docs and use tools only when the docs are missing, ambiguous, or need implementation verification."
      : "JCODE is running from the workspace root. Start from the Documentation context. Before running repository tools, compare the question against the docs and use tools only when the docs are missing, ambiguous, or need implementation verification."
    : runtime === "rlm"
    ? "Use the rlm-bun JavaScript sandbox from the workspace root. Inspect repositories directly with one executable JavaScript block per step before answering. Prefer `rg(pattern, { glob: \"repoId:...\" })`, `searchAll`, `inspect`, and `readFileRange` before whole-file reads; `grep` remains a compatibility alias."
    : runtime === "local-cli"
    ? "A local CLI agent is running from the workspace root. Each repository is checked out in the folder shown above. Use native search/read/shell tools to find the ground truth; do not answer from memory or wiki context alone."
    : "JCODE is running from the workspace root. Each repository is checked out in the folder shown above. Explore the code directly; do not answer from memory or wiki context alone.";
  const toolPhrase = runtime === "rlm" ? "sandbox tool or command" : runtime === "local-cli" ? "native CLI tool or command" : "native JCODE tool or command";
  const mcpPhrase = runtime === "rlm" ? "connected MCP tooling" : runtime === "local-cli" ? "connected external tooling outside local-cli v1" : "JCODE MCP tooling";
  const citationGuidance = docsInline
    ? "When the answer comes from the Documentation context, cite the relevant docs page title or heading in prose. If you inspect repository files, cite only the implementation claims with clickable exact namespaced line ranges like `Sources: [repo-id:src/foo.ts:42-58]()`. Do not invent file citations for docs-only answers."
    : "Use concise source citations for the key implementation claims that anchor the answer; do not append `Sources:` to every sentence or every bullet. When citing, use clickable namespaced exact-line sources like `Sources: [repo-id:src/foo.ts:42-58]()`. Use the full repo-relative path found by search/read; only use a root-level citation like `Sources: [repo-id:local_connection.py:421-479]()` when the file is actually at the repository root. Do not cite file-line references as bare text or inline code like `repo-id:src/foo.ts:42-58`.";
  const finalOutput = runtime === "rlm"
    ? docsInline
      ? "Return the complete markdown answer inside one `<ANSWER>...</ANSWER>` block. If you answered from Documentation context only, call `SUBMIT({ sources: [] })` after the answer. If you inspected repository files, include representative cited paths in `SUBMIT({ sources: [...] })`. Do not put the answer inside JavaScript or a markdown fence."
      : "Return the complete markdown answer inside one `<ANSWER>...</ANSWER>` block. Include concise source citations for representative evidence inside the answer. After the answer, emit one tiny JavaScript block that calls `SUBMIT({ sources: [...] })`. Do not put the answer inside JavaScript or a markdown fence."
    : "Return the complete user-facing answer inside one `<ANSWER>...</ANSWER>` block as non-empty Markdown with concise source citations for representative evidence. A tools-only transcript with no final answer is a failed task — after any tools, you must still emit the `<ANSWER>` block. Do not put the answer inside a markdown fence. Do not call SUBMIT.";

  if (runtime !== "rlm") {
    return `# Ask Task

Answer the user's question${docsInline ? " from the generated documentation first" : " using the prepared workspace as the source of truth"}.

## Repositories
${repoList}

${sourceScopeBlock}
For tool paths, use the repository folders above. For citations, use clickable exact namespaced line ranges like \`[${repos[0]?.id}:src/index.ts:12-24]()\`.

	${historyBlock}${wikiBlock}${knowledgeBlock ? `${knowledgeBlock}\n\n` : ""}${workspaceQueryBlock}## Question
	${question}

${clarifyBlock}## Guidance
- ${docsInline ? "If the Documentation context answers the question, answer from that MDX without searching or reading repository files." : "Search/read the relevant files before answering."}
- ${docsInline ? "Before using file, search, read, or shell tools, decide whether the Documentation context is sufficient." : "Use focused searches before broad reads."}
- ${docsInline ? "Only inspect repository files when the documentation context is insufficient, ambiguous, or the question explicitly asks for implementation verification." : "For comparisons, inspect the relevant implementation in each repository."}
- If a repository does not contain the answer, say so and cite the search or file evidence.
- ${citationGuidance}
- ${finalOutput}

Mode: ${askMode === "fast" ? "Fast — keep the inspection focused." : "Deep — inspect enough surrounding code to answer confidently."}`;
  }

  return `You are an expert code analyst answering a question across multiple GitHub repositories.

## Repositories
${repoList}

${sourceScopeBlock}
${harnessBlock}

For tool paths, use the repository folders above. For citations, use clickable exact namespaced line ranges such as \`[${repos[0]?.id}:src/index.ts:12-24]()\`.

	${historyBlock}${wikiBlock}${knowledgeBlock ? `${knowledgeBlock}\n\n` : ""}${workspaceQueryBlock}${modeBlock}## The user's question
	${question}

${clarifyBlock}## How To Work
1. Think Socratically before choosing tools: what evidence would change the answer, which repository owns it, and what ${toolPhrase} can produce it?
2. ${docsInline ? "Start with the Documentation context. Before using any file, search, read, or shell tool, decide whether the generated MDX supports the answer. If it does, do not perform repository study." : "For comparison or architecture questions, map the relevant files/symbols across repositories before reading details."}
3. ${docsInline ? "Proceed to repository study only when the docs are out of context, incomplete, ambiguous, or the user asks for implementation-level proof." : "For narrow factual questions, search all repositories first, then read the exact implementation behind the claim."}
4. For proof, verification, or regression questions, inspect enough code to form a hypothesis, then run focused package commands or tests in the repository that owns the behavior.
5. If an external system is relevant and MCP tools are connected, use ${mcpPhrase}. If no relevant MCP tool is connected, say so clearly.
6. Track line numbers as you inspect. Prefer the smallest useful citation span, usually 5-80 lines.
7. If a repo does not contain the requested concept, say that explicitly and cite the searches/files that establish the absence.
${runtime === "rlm" ? `8. Do not bulk-read arrays of files with \`Promise.all(files.map(readFile))\`. Build a candidate map with \`searchAll\`/\`rg\`, then read only the line ranges that can change the answer.
9. ${docsInline ? "If you inspect repository files, keep a `sources` array and include the same namespaced file:line spans in `SUBMIT({ sources })`. If you answer from Documentation context only, submit an empty sources array." : "Keep a `sources` array as you work. If the answer cites namespaced file:line spans, the final `SUBMIT({ sources })` must include those same spans."}
${askMode === "deep" ? `10. Deep mode evidence floor: inspect the primary repo/file plus at least one adjacent caller/config/test/route or an explicit absence search before submitting. The answer should usually cite a few representative precise spans, but group citations by paragraph or section instead of repeating them on every bullet.
` : ""}
` : ""}

## Answer Style
- Start with the direct answer.
- Do not wrap the whole answer in markdown fences.
- ${citationGuidance}
- Prefer compact comparison tables or bullets when more than one repo is involved.
- Be concise but complete.

## Final Output
${finalOutput}

Budget: ${askMode === "fast" ? "aim for 1-2 focused inspection steps." : "up to 12 focused investigation steps."}`;
}
