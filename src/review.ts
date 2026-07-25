import { Buffer } from "node:buffer";
import { RLM } from "rlm-bun";
import { JCodeAgent, fetchPRData, parsePRURL } from "./jcode-runtime.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { MCPConfig, PRData, RLMEvent } from "./jcode-runtime.ts";
import { DEFAULT_CHANNEL_ID, makeLLM, resolveChannel } from "./llm.ts";
import { makeRlmLLM } from "./rlm-llm.ts";
import { preludeForRuntime } from "./prompts/prelude.ts";
import { normalizeAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { jcodeControlsForSurface, localCliControlsForSurface, rlmControlsForSurface } from "./model-control.ts";
import { WikiStore } from "./storage.ts";
import { applyAgentCapabilities } from "./agent-capabilities.ts";
import type { ProviderSecrets } from "./provider-secrets.ts";
import type { GitHubFetch } from "./github-client.ts";
import type { LocalCliConfig } from "./local-cli-events.ts";

const SANDBOX_TIMEOUT_MS = 1_800_000;
const PR_REVIEW_STRATEGY_BRIDGE = [
  "Use the PR-review strategy from your system prompt as the controlling workflow:",
  "1. Orient on the full diff and changed-files summary.",
  "2. For non-trivial PRs, map changed concepts to callers, neighbors, tests, and subsystem boundaries in the post-PR working tree.",
  "3. Explore touched files and surrounding context, including imports, callers, and tests.",
  "4. Inspect runtime/config/package context when relevant.",
  "5. Search for impact with JCODE's native search, symbol, file, and shell tools. In RLM mode, prefer rg, listSymbols, and readFileRange before whole-file reads.",
  "6. Parallelize or delegate only when JCODE's native task tooling is available and the scope is clear.",
  "7. Synthesize only findings that survive verification, and cite the files you actually used.",
].join("\n");

const PR_REVIEW_FEW_SHOT_PATTERNS = [
  "Few-shot PR review patterns:",
  "Do not copy placeholder paths from examples. Derive every path and line range from the PR diff, changed-file list, rg, or listSymbols output.",
  "",
  "### Non-trivial logic change",
  "1. Map changed symbols and nearby callers before reading bodies:",
  "```js",
  "const hits = await rg(\"exact changed symbol or error text\", { glob: \"**/*.{ts,tsx,js,jsx}\", maxResults: 20 });",
  "console.log(hits.map(h => `${h.file}:${h.line} ${h.text}`).join(\"\\n\"));",
  "```",
  "2. Read the smallest changed span plus one caller/test span:",
  "```js",
  "const selected = hits.slice(0, 3);",
  "const spans = [];",
  "for (const h of selected) spans.push(await readFileRange(h.file, Math.max(1, h.line - 12), h.line + 28));",
  "for (const s of spans) console.log(`--- ${s.path}:${s.startLine}-${s.endLine}\\n${s.content}`);",
  "```",
  "3. If the risk is runtime-sensitive, run one focused experiment. Otherwise finalize with Static-only justification.",
  "",
  "### No actionable findings",
  "If changed-file span + caller/test span do not support a concrete bug, stop. Submit Summary, Findings: none, Positive Highlights, Residual Test Risk, and Sources. Do not keep searching for a finding.",
  "",
  "### Avoid this cost trap",
  "```js",
  "const files = await Promise.all(paths.map(path => readFile(path)));",
  "```",
  "Replace broad reads with rg/listSymbols/readFileRange. readFileRange is the preferred evidence tool once a line span is known.",
].join("\n");

const REVIEW_FINALIZATION_SUFFIX = [
  "# Review Finalization Contract",
  "When you are ready to finish a PR review, write the full review as plain Markdown inside <ANSWER>...</ANSWER> outside any code block.",
  "The final ```js block must contain only SUBMIT({ sources: [...] });. Do not put Markdown, code examples, console.log(review), or template literals inside that final JS block.",
  "Every finding and every changed-behavior claim needs a concrete file:line or file:start-end citation in the prose.",
  "The final answer must end with ## Sources, and SUBMIT({ sources }) must include the same inspected files, preferably with line ranges.",
  "Do not inspect node_modules in review checkouts; dependencies are usually not installed. Use package.json/lockfiles and repository source instead.",
  "Before running tests, check whether local dependencies exist. If node_modules is missing, use Static-only: dependencies are not installed in the review checkout.",
  "If you have used more than ten readFile calls, stop and switch to rg, inspect, listSymbols, graph context, or readFileRange before reading more whole files.",
].join("\n");

export interface ReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewUser {
  login: string;
  avatarUrl?: string;
  htmlUrl?: string;
  type?: string;
}

export interface ReviewDiscussionItem {
  id: string;
  kind: "comment" | "review" | "review-comment";
  author: ReviewUser;
  body: string;
  createdAt: string;
  updatedAt?: string;
  state?: string;
  path?: string;
  line?: number;
  htmlUrl?: string;
}

export interface ReviewCommit {
  sha: string;
  shortSha: string;
  title: string;
  message: string;
  author: ReviewUser;
  authoredAt: string;
  htmlUrl?: string;
  current: boolean;
}

export interface ReviewGithubContext {
  htmlUrl: string;
  mergeableState: string;
  mergeStatus: string;
  merged: boolean;
  author: ReviewUser;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  commentsCount: number;
  reviewCommentsCount: number;
  reviewsCount: number;
  commitsCount: number;
  discussion: ReviewDiscussionItem[];
  commits: ReviewCommit[];
  warning?: string;
}

export interface ReviewRecord {
  reviewId: string;
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  baseBranch: string;
  headBranch: string;
  headOwner?: string;
  headRepo?: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: ReviewFile[];
  github: ReviewGithubContext;
  loadedAt: string;
}

export interface ReviewSelection {
  path: string;
  side: "additions" | "deletions" | "unified";
  startLine: number;
  endLine: number;
  mode: "range" | "single-line" | "hunk" | "file" | "changeset";
}

export interface ReviewFileContents {
  oldFile: { name: string; contents: string; cacheKey: string } | null;
  newFile: { name: string; contents: string; cacheKey: string } | null;
  patch?: string;
}

export interface ReviewCitation {
  path: string;
  side: "additions" | "deletions" | "unified";
  startLine: number;
  endLine: number;
  label?: string;
  reason?: string;
}

export interface ReviewIssue {
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  category: "bug" | "investigation" | "informational";
  explanationMarkdown: string;
  citations: ReviewCitation[];
  fixSuggestions?: string[];
  testsToAdd?: string[];
}

export interface InvestigationResult {
  summaryMarkdown: string;
  issues: ReviewIssue[];
  rawAnswer: string;
  sources: string[];
}

interface ReviewRunResult {
  answer: string;
  sources: string[];
  valid: boolean;
}

export type ReviewEvent =
  | { type: "agent"; event: RLMEvent }
  | { type: "answer"; answer: string; sources: string[] }
  | { type: "error"; error: string };

export interface ReviewOptions {
  channel?: string;
  model?: string;
  question?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  selection?: ReviewSelection | null;
  store?: WikiStore;
  onEvent?: (ev: ReviewEvent) => void;
  maxIterations?: number;
  runtime?: AgentRuntime | string;
  localCli?: LocalCliConfig | unknown;
  /**
   * Server/programmatic capability hooks. Do not expose raw MCP configs from
   * untrusted browser input; MCP stdio servers can execute local commands.
   */
  mcpConfig?: MCPConfig;
  skillSources?: string[];
  providerSecrets?: ProviderSecrets;
  githubFetch?: GitHubFetch;
}

interface CachedReview extends ReviewRecord {
  prData: PRData;
  githubFetch?: GitHubFetch;
}

interface ParsedInvestigationResult extends InvestigationResult {
  parsedOk: boolean;
}

const reviewCache = new Map<string, CachedReview>();
let cachedGithubToken: string | null | undefined;

export function normalizePRUrl(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  const shortHash = trimmed.match(/^([^/\s]+)\/([^/\s]+)#(\d+)$/);
  if (shortHash) {
    return `https://github.com/${shortHash[1]}/${shortHash[2]}/pull/${shortHash[3]}`;
  }
  const shortPull = trimmed.match(/^([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/);
  if (shortPull) {
    return `https://github.com/${shortPull[1]}/${shortPull[2]}/pull/${shortPull[3]}`;
  }
  if (/^github\.com\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function getCachedReview(reviewId: string): ReviewRecord | null {
  const cached = reviewCache.get(reviewId);
  return cached ? publicReview(cached) : null;
}

export async function loadReview(prUrl: string, opts: { githubFetch?: GitHubFetch; reviewId?: string } = {}): Promise<ReviewRecord> {
  const url = normalizePRUrl(prUrl);
  const parsed = parsePRURL(url);
  if (!parsed) {
    throw new Error("Could not parse that as a GitHub pull request URL.");
  }

  const prData = await fetchPRData(parsed.owner, parsed.repo, parsed.number, { githubFetch: opts.githubFetch });
  const github = await fetchReviewGithubContext(parsed.owner, parsed.repo, parsed.number, url, prData, opts.githubFetch);
  const additions = prData.diff.changedFiles.reduce((sum, file) => sum + file.additions, 0);
  const deletions = prData.diff.changedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const reviewId = normalizeReviewId(opts.reviewId) || [
    parsed.owner,
    parsed.repo,
    parsed.number,
    crypto.randomUUID().slice(0, 8),
  ]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");

  const record: CachedReview = {
    reviewId,
    url,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    title: prData.info.title,
    body: prData.info.body,
    state: prData.info.state,
    draft: prData.info.draft,
    author: prData.info.author,
    baseBranch: prData.info.baseBranch,
    headBranch: prData.info.headBranch,
    headOwner: prData.info.headOwner,
    headRepo: prData.info.headRepo,
    baseSha: prData.info.baseSHA,
    headSha: prData.info.headSHA,
    additions,
    deletions,
    changedFiles: prData.diff.changedFiles.length,
    files: prData.diff.changedFiles.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    })),
    github,
    loadedAt: new Date().toISOString(),
    prData,
    githubFetch: opts.githubFetch,
  };

  reviewCache.set(reviewId, record);
  return publicReview(record);
}

export async function getReviewFileContents(
  reviewId: string,
  path: string,
): Promise<ReviewFileContents> {
  const cached = reviewCache.get(reviewId);
  if (!cached) throw new Error(`Review ${reviewId} was not found. Load the PR again.`);

  const file = cached.files.find((f) => f.path === path);
  if (!file) throw new Error(`File ${path} is not part of this PR.`);

  const oldFile =
    file.status === "added"
      ? null
      : await fetchGithubFile(cached.owner, cached.repo, cached.baseSha, path, cached.githubFetch);
  const newFile =
    file.status === "removed"
      ? null
      : await fetchGithubFile(cached.owner, cached.repo, cached.headSha, path, cached.githubFetch);

  return {
    oldFile: oldFile == null ? null : {
      name: path,
      contents: oldFile,
      cacheKey: `${cached.owner}/${cached.repo}/${cached.baseSha}/${path}`,
    },
    newFile: newFile == null ? null : {
      name: path,
      contents: newFile,
      cacheKey: `${cached.owner}/${cached.repo}/${cached.headSha}/${path}`,
    },
    patch: file.patch,
  };
}

export async function reviewAnything(
  prUrl: string,
  opts: ReviewOptions = {},
): Promise<{ answer: string; sources: string[] }> {
  const url = normalizePRUrl(prUrl);
  const parsed = parsePRURL(url);
  if (!parsed) throw new Error("Review Anything needs a GitHub pull request URL.");

  const channel = resolveChannel(opts.channel ?? opts.model ?? DEFAULT_CHANNEL_ID);
  const runtime = normalizeAgentRuntime(opts.runtime, "rlm");
  const store = opts.store ?? new WikiStore();
  const emit = opts.onEvent ?? (() => {});

  try {
    const first = await runReviewAttempt(url, channel, runtime, store, emit, opts, false);
    const firstQualityIssue = runtime === "rlm" && first.valid ? reviewAnswerQualityIssue(first) : null;
    if (first.valid && !firstQualityIssue) {
      emit({ type: "answer", answer: first.answer, sources: first.sources });
      return { answer: first.answer, sources: first.sources };
    }

    const retryReason = first.valid && firstQualityIssue
      ? firstQualityIssue
      : "the first attempt did not produce a complete review answer";
    emit({
      type: "agent",
      event: {
        type: "status",
        phase: "retry",
        message: first.valid
          ? `Review response missed evidence requirements (${retryReason}); retrying with stricter citation and verification requirements.`
          : "Review response was only a placeholder; retrying with stricter final-answer requirements.",
      } as RLMEvent,
    });
    const retry = await runReviewAttempt(url, channel, runtime, store, emit, opts, true, retryReason);
    if (retry.valid) {
      const retryQualityIssue = runtime === "rlm" ? reviewAnswerQualityIssue(retry) : null;
      if (!retryQualityIssue) {
        emit({ type: "answer", answer: retry.answer, sources: retry.sources });
        return { answer: retry.answer, sources: retry.sources };
      }

      if (runtime === "rlm" && shouldAttemptEvidenceRepair(retryQualityIssue)) {
        emit({
          type: "agent",
          event: {
            type: "status",
            phase: "retry",
            message: `Strict retry still missed evidence requirements (${retryQualityIssue}); attempting one final evidence repair.`,
          } as RLMEvent,
        });
        try {
          const repair = await runReviewAttempt(url, channel, runtime, store, emit, opts, true, retryQualityIssue);
          if (repair.valid) {
            const repairQualityIssue = reviewAnswerQualityIssue(repair);
            const better = betterReviewResult(retry, repair);
            if (!repairQualityIssue || reviewEvidenceScore(repair) > reviewEvidenceScore(retry)) {
              emit({ type: "answer", answer: better.answer, sources: better.sources });
              return { answer: better.answer, sources: better.sources };
            }
          }
        } catch (repairError) {
          const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
          emit({
            type: "agent",
            event: {
              type: "status",
              phase: "retry-fallback",
              message: `Final evidence repair failed (${repairMessage}); preserving the strict retry review.`,
            } as RLMEvent,
          });
        }
      }

      const better = first.valid ? betterReviewResult(first, retry) : retry;
      emit({
        type: "agent",
        event: {
          type: "status",
          phase: "retry-fallback",
          message: "Review retry still missed a non-critical evidence requirement; preserving the strongest available review.",
        } as RLMEvent,
      });
      emit({ type: "answer", answer: better.answer, sources: better.sources });
      return { answer: better.answer, sources: better.sources };
    }

    if (first.valid) {
      emit({
        type: "agent",
        event: {
          type: "status",
          phase: "retry-fallback",
          message: "Strict retry failed to produce a stronger review; preserving the first complete review.",
        } as RLMEvent,
      });
      emit({ type: "answer", answer: first.answer, sources: first.sources });
      return { answer: first.answer, sources: first.sources };
    }

    throw new Error("Review finished without producing review markdown. Please run Review again or try a stronger model.");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit({ type: "error", error });
    throw e;
  }
}

async function runReviewAttempt(
  url: string,
  channel: ReturnType<typeof resolveChannel>,
  runtime: AgentRuntime,
  store: WikiStore,
  emit: (ev: ReviewEvent) => void,
  opts: ReviewOptions,
  strictRetry: boolean,
  strictReason?: string | null,
): Promise<ReviewRunResult> {
  const Agent = (runtime === "local-cli" ? LocalCliAgent : runtime === "rlm" ? RLM : JCodeAgent) as any;
  const controls = runtime === "local-cli"
    ? localCliControlsForSurface(channel, { surface: "review" })
    : runtime === "rlm"
      ? rlmControlsForSurface(channel, { surface: "review" })
      : jcodeControlsForSurface(channel, { surface: "review" });
  const firstUserMessageSuffix = runtime === "rlm"
    ? [controls.firstUserMessageSuffix, REVIEW_FINALIZATION_SUFFIX].filter(Boolean).join("\n\n")
    : controls.firstUserMessageSuffix;
  const llm = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, { surface: "review" }, opts.providerSecrets) : makeLLM(channel, { surface: "review" }, opts.providerSecrets);
  const subLM = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, { surface: "review" }, opts.providerSecrets) : makeLLM(channel, { surface: "review" }, opts.providerSecrets);
  const agent = new Agent({
    source: url,
    ...(llm ? { llm } : {}),
    ...(subLM ? { subLM } : {}),
    ...controls,
    ...(firstUserMessageSuffix ? { firstUserMessageSuffix } : {}),
    maxIterations: opts.maxIterations ?? (strictRetry ? shouldAttemptEvidenceRepair(strictReason ?? null) ? 8 : 16 : 22),
    maxLLMCalls: strictRetry ? shouldAttemptEvidenceRepair(strictReason ?? null) ? 140 : 260 : 340,
    sandboxTimeout: SANDBOX_TIMEOUT_MS,
    sessionDir: store.sessionsDir,
    mcpConfig: opts.mcpConfig,
    githubFetch: opts.githubFetch,
    localCli: opts.localCli,
    onEvent: (event: RLMEvent) => emit({ type: "agent", event }),
  } as any) as { query(prompt: string): Promise<ReviewRunResult> };

  await applyAgentCapabilities(agent as unknown as JCodeAgent, {
    skillSources: opts.skillSources,
    onStatus: (message) => emitCapabilityStatus(emit, message),
  });

  const prompt = preludeForRuntime(channel.id, "deep", runtime) + buildReviewPrompt({
    question: opts.question,
    history: opts.history,
    selection: opts.selection,
    strictRetry,
    runtime,
    strictReason,
  });

  const result = await agent.query(prompt);
  const answer = result.answer.trim();
  return normalizeReviewRunResult({ answer, sources: result.sources, valid: looksLikeReviewAnswer(answer) });
}

export async function investigateReview(
  prUrl: string,
  opts: ReviewOptions = {},
): Promise<InvestigationResult> {
  const url = normalizePRUrl(prUrl);
  const parsed = parsePRURL(url);
  if (!parsed) throw new Error("Investigate needs a GitHub pull request URL.");

  const channel = resolveChannel(opts.channel ?? opts.model ?? DEFAULT_CHANNEL_ID);
  const runtime = normalizeAgentRuntime(opts.runtime, "rlm");
  const store = opts.store ?? new WikiStore();
  const emit = opts.onEvent ?? (() => {});

  try {
    const first = await runInvestigationAttempt(url, channel, runtime, store, emit, buildInvestigationPrompt(false, runtime), opts);
    if (first.parsedOk) return stripParseState(first);

    emit({ type: "agent", event: { type: "status", phase: "retry", message: "Investigation response was unstructured; retrying with stricter JSON requirements." } as RLMEvent });
    const retry = await runInvestigationAttempt(url, channel, runtime, store, emit, buildInvestigationPrompt(true, runtime), opts);
    if (retry.parsedOk) return stripParseState(retry);

    throw new Error("Investigation did not produce structured JSON after retry. Please run Investigate again or try a stronger model.");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit({ type: "error", error });
    throw e;
  }
}

async function runInvestigationAttempt(
  url: string,
  channel: ReturnType<typeof resolveChannel>,
  runtime: AgentRuntime,
  store: WikiStore,
  emit: (ev: ReviewEvent) => void,
  promptBody: string,
  opts: ReviewOptions,
): Promise<ParsedInvestigationResult> {
  const Agent = (runtime === "local-cli" ? LocalCliAgent : runtime === "rlm" ? RLM : JCodeAgent) as any;
  const llm = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, { surface: "investigate" }, opts.providerSecrets) : makeLLM(channel, { surface: "investigate" }, opts.providerSecrets);
  const subLM = runtime === "local-cli" ? null : runtime === "rlm" ? makeRlmLLM(channel, { surface: "investigate" }, opts.providerSecrets) : makeLLM(channel, { surface: "investigate" }, opts.providerSecrets);
  const agent = new Agent({
    source: url,
    ...(llm ? { llm } : {}),
    ...(subLM ? { subLM } : {}),
    ...(runtime === "local-cli"
      ? localCliControlsForSurface(channel, { surface: "investigate" })
      : runtime === "rlm"
        ? rlmControlsForSurface(channel, { surface: "investigate" })
        : jcodeControlsForSurface(channel, { surface: "investigate" })),
    maxIterations: opts.maxIterations ?? 24,
    maxLLMCalls: 420,
    sandboxTimeout: SANDBOX_TIMEOUT_MS,
    sessionDir: store.sessionsDir,
    mcpConfig: opts.mcpConfig,
    githubFetch: opts.githubFetch,
    localCli: opts.localCli,
    onEvent: (event: RLMEvent) => emit({ type: "agent", event }),
  } as any) as { query(prompt: string): Promise<ReviewRunResult> };

  await applyAgentCapabilities(agent as unknown as JCodeAgent, {
    skillSources: opts.skillSources,
    onStatus: (message) => emitCapabilityStatus(emit, message),
  });

  const result = await agent.query(preludeForRuntime(channel.id, "deep", runtime) + promptBody);
  return parseInvestigationAnswer(result.answer.trim(), result.sources);
}

function emitCapabilityStatus(
  emit: (ev: ReviewEvent) => void,
  message: string,
): void {
  emit({
    type: "agent",
    event: { type: "status", phase: "capabilities", message } as RLMEvent,
  });
}

function stripParseState(result: ParsedInvestigationResult): InvestigationResult {
  const { parsedOk: _parsedOk, ...publicResult } = result;
  void _parsedOk;
  return publicResult;
}

function buildReviewPrompt(args: {
  question?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  selection?: ReviewSelection | null;
  strictRetry?: boolean;
  runtime?: AgentRuntime;
  strictReason?: string | null;
}): string {
  const question = args.question?.trim() || [
    "Perform a focused code review of this PR.",
    "Prioritize real correctness bugs, security issues, behavioral regressions, and missing tests.",
    "Keep the review concise and actionable.",
  ].join(" ");

  const history = (args.history ?? [])
    .slice(-8)
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content.trim()}`)
    .join("\n\n");

  const selection = args.selection
    ? [
        "Current diff selection:",
        `- file: ${args.selection.path}`,
        `- side: ${args.selection.side}`,
        `- lines: ${args.selection.startLine}-${args.selection.endLine}`,
        `- mode: ${args.selection.mode}`,
      ].join("\n")
    : "";
  const runtime = args.runtime ?? "agent";
  const wrapperLine = runtime === "rlm"
    ? "This is a web-facing wrapper over rlm-bun PR review mode. Do not treat it as a standalone chat task."
    : runtime === "local-cli"
      ? "This is a web-facing wrapper over local CLI PR review mode. Do not treat it as a standalone chat task."
      : "This is a web-facing wrapper over JCODE PR review mode. Do not treat it as a standalone chat task.";
  const bridge = runtime === "rlm"
    ? PR_REVIEW_STRATEGY_BRIDGE
      .replace("JCODE's native search, symbol, file, and shell tools", "rlm-bun's sandbox search, read, shell, and analysis tools")
      .replace("JCODE's native task tooling", "the sandbox's available task tooling")
    : runtime === "local-cli"
    ? PR_REVIEW_STRATEGY_BRIDGE
      .replace("JCODE's native search, symbol, file, and shell tools", "the local CLI agent's native search, file, shell, and inspection tools")
      .replace("JCODE's native task tooling", "native CLI delegation only when the selected agent clearly supports it")
    : PR_REVIEW_STRATEGY_BRIDGE;
  const inspectionLine = runtime === "rlm"
    ? "- Use the unified diff, sandbox search/read/shell tools, and explicit reads when comparing before vs after behavior."
    : runtime === "local-cli"
      ? "- Use the unified diff, local CLI search, symbol inspection, shell commands, and explicit reads when comparing before vs after behavior."
      : "- Use the unified diff, JCODE search, symbol inspection, shell commands, and explicit reads when comparing before vs after behavior.";
  const mcpLine = runtime === "rlm"
    ? "- Use connected MCP tooling when the PR/question references Slack, Linear, Jira, roadmap items, incidents, customer reports, or external rollout state. If no matching MCP tool is connected, say so rather than inventing external context."
    : runtime === "local-cli"
      ? "- MCP tools are not available in local CLI v1. If the PR/question requires external rollout state, say that the local CLI run could not retrieve it."
      : "- Use JCODE MCP tooling when the PR/question references Slack, Linear, Jira, roadmap items, incidents, customer reports, or external rollout state. If no matching MCP tool is connected, say so rather than inventing external context.";
  const finalRuntimeLine = runtime === "rlm"
    ? "- After the <ANSWER> block, emit one tiny JavaScript block calling `SUBMIT({ sources: [...] })` with representative source files."
    : "- Do not emit JavaScript, SUBMIT calls, or any legacy sandbox wrapper.";

  return [
    args.strictRetry
      ? "STRICT RETRY: your previous Review Anything attempt missed the final-answer or evidence contract. This attempt must place the full review markdown inside <ANSWER>...</ANSWER> tags."
      : "",
    args.strictRetry && args.strictReason
      ? `STRICT RETRY REASON: ${args.strictReason}`
      : "",
    args.strictRetry && runtime === "rlm"
      ? "STRICT RETRY RULE: preserve any valid substantive findings, but repair the evidence contract before submitting. If the reason mentions sources, citations, or line numbers, use readFileRange on the exact files you relied on and add file:line citations in the prose plus matching entries in ## Sources and SUBMIT({ sources })."
      : args.strictRetry
      ? "STRICT RETRY RULE: preserve any valid substantive findings, but repair the evidence contract before submitting. If the reason mentions sources, citations, or line numbers, inspect the exact files you relied on and add file:line citations in the prose."
      : "",
    args.strictRetry && args.strictReason && shouldAttemptEvidenceRepair(args.strictReason)
      ? "STRICT EVIDENCE REPAIR MODE: this is not a fresh review. Do at most two tool-backed steps: readFileRange the exact changed files needed for line anchors, then finalize. Do not inspect node_modules, do not run tests, and do not read dependency package internals."
      : "",
    "You are powering rlm-wiki's Review Anything page.",
    wrapperLine,
    bridge,
    "",
    "Quality bar:",
    "- Start by creating a PLAN that follows the PR-review strategy.",
    "- Do not submit after only reading the diff unless the PR is clearly docs-only or trivial.",
    runtime === "rlm"
      ? "- Exploration protocol: start from the changed files and unified diff, use rg/inspect/listSymbols to locate exact symbols, then use readFileRange for the smallest relevant line ranges."
      : "",
    runtime === "rlm"
      ? "- Avoid broad read sweeps. Do not bulk-read arrays of files with Promise.all(files.map(...readFile...)). If you need many files, first narrow with rg, glob, inspect, or graph context."
      : "",
    runtime === "rlm"
      ? "- Sandbox resilience: keep each JavaScript step small, define every variable before use, avoid clever destructuring of uncertain shapes, and after any ReferenceError/SyntaxError simplify the next step instead of retrying the same code."
      : "",
    "- For non-trivial PRs, identify likely call chains and architectural neighbors in the post-PR working tree before deep reads.",
    inspectionLine,
    "- For non-trivial PRs, inspect changed files plus at least one relevant caller, test, config, or adjacent implementation file.",
    runtime === "rlm"
      ? "- Verification gate: when a finding depends on runtime behavior, tests, regressions, security, parsing, or compatibility, attempt one focused experiment({ hypothesis, steps }) before finalizing. If no focused command is practical, state why and keep the finding framed as static risk."
      : "- For suspected behavioral regressions, run focused tests or reproducible commands instead of relying on static reading alone.",
    runtime === "rlm"
      ? "- Each finding must include a `### Verification` subsection with either `Command: ...` and a short output summary from experiment, or `Static-only: <specific reason a focused command was not practical>`. Do not omit this subsection."
      : "",
    runtime === "rlm"
      ? "- Review checkouts normally do not have node_modules installed. Do not read node_modules paths or dependency package internals unless they appear in the changed-file list. If tests cannot run because dependencies are absent, record that as Static-only instead of probing node_modules."
      : "",
    mcpLine,
    "- Balance quality and latency: graph/search first, read the few files most likely to change the conclusion, and stop once more exploration is unlikely to affect findings.",
    "- Prefer fewer, verified findings over broad speculative commentary.",
    runtime === "rlm" ? PR_REVIEW_FEW_SHOT_PATTERNS : "",
    "- Do not repeat already-raised PR feedback unless your evidence changes its severity or conclusion.",
    "",
    "User request:",
    question,
    "",
    history ? `Conversation so far:\n${history}\n` : "",
    selection,
    "",
    "Return polished markdown. Lead with concrete findings when you find any.",
    "For each finding, include severity, affected file, exact file:line or file:start-end citation when you can verify it, and the evidence path you followed.",
    runtime === "rlm" ? "Every factual claim about changed behavior should include at least one file:line citation in the prose." : "",
    runtime === "rlm" ? "Path discipline: never guess file extensions. Use the changed-file list, glob, rg, or listFiles before reading unfamiliar paths." : "",
    "If no substantial issues are found, say that clearly and mention the main residual test risk.",
    runtime === "rlm" ? "End the answer with a `## Sources` section listing every file you inspected. Use the same file paths in SUBMIT({ sources })." : "",
    "",
    "Final answer contract:",
    "- The final answer MUST be the actual review markdown, not a status message.",
    "- For the final response, write the full markdown review inside <ANSWER>...</ANSWER> tags.",
    finalRuntimeLine,
    "- Never return only a placeholder such as `Submitting review...`.",
    runtime === "rlm" ? "- Do not call SUBMIT with an empty sources array unless the PR cannot be loaded; if that happens, explain the load failure in the answer." : "",
    "- If you found no issues, still write a complete review with Summary, Findings, Positive Highlights, and Residual Test Risk.",
  ]
    .filter(Boolean)
    .join("\n");
}

function looksLikeReviewAnswer(answer: string): boolean {
  const text = answer.trim();
  if (text.length < 180) return false;
  if (/```(?:js|javascript)\b/i.test(text) && !/##?\s*(?:Summary|Findings|Issues|Sources|Residual Test Risk)\b/i.test(text)) {
    return false;
  }
  if (/^Wait\b/i.test(text) && /```(?:js|javascript)\b/i.test(text)) return false;
  const lower = text.toLowerCase();
  const placeholders = [
    "submitting review",
    "analyzing the pr diff",
    "generating the review",
    "review submitted",
    "done",
  ];
  if (placeholders.some((placeholder) => lower === placeholder || lower.includes(`${placeholder}...`))) {
    return false;
  }
  return /(^|\n)\s*#{1,3}\s*(?:Summary|Findings|Issues|Positive Highlights|Residual Test Risk|Sources)\b/i.test(text) ||
    /\b(?:PR Review|critical|major|minor)\b/i.test(text);
}

function reviewAnswerQualityIssue(result: ReviewRunResult): string | null {
  const text = result.answer.trim();
  if (result.sources.length === 0) return "SUBMIT sources was empty";
  if (text.length > 240 && countReviewLineCitations(text) === 0) {
    return "review answer had no file:line citations";
  }
  if (hasReviewFindings(text) && !hasVerificationSection(text)) {
    return "review findings omitted the required Verification subsection";
  }
  if (!/##?\s*Sources\b/i.test(text)) {
    return "review answer omitted the Sources section";
  }
  return null;
}

function shouldAttemptEvidenceRepair(issue: string | null): boolean {
  return Boolean(issue && /\b(source|sources|citation|citations|line number|line citation)\b/i.test(issue));
}

function normalizeReviewRunResult(result: ReviewRunResult): ReviewRunResult {
  const inferred = inferSourcesFromReviewAnswer(result.answer);
  return {
    ...result,
    sources: Array.from(new Set([...result.sources, ...inferred])).sort(),
  };
}

const REVIEW_CITABLE_PATH_PATTERN = String.raw`(?:[\w@.-]+\/)?(?:[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|css|html|svelte|vue|yml|yaml|toml|lock|sh)|(?:[\w@./-]+/)?(?:README|LICENSE|Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Brewfile|Justfile|Taskfile))`;

function inferSourcesFromReviewAnswer(answer: string): string[] {
  const sources = new Set<string>();
  const citationPattern = new RegExp(String.raw`\b(${REVIEW_CITABLE_PATH_PATTERN}:\d+(?:-\d+)?)\b`, "g");
  for (const match of answer.matchAll(citationPattern)) {
    sources.add(match[1]);
  }
  const sourcesSection = /##?\s*Sources\b([\s\S]*)$/i.exec(answer)?.[1] ?? "";
  for (const line of sourcesSection.split("\n")) {
    const match = new RegExp(String.raw`(?:^|\s)(${REVIEW_CITABLE_PATH_PATTERN})(?::\d+(?:-\d+)?)?(?:\b|:)`).exec(line);
    if (match) sources.add(match[1]);
  }
  return [...sources];
}

function betterReviewResult(a: ReviewRunResult, b: ReviewRunResult): ReviewRunResult {
  return reviewEvidenceScore(b) > reviewEvidenceScore(a) ? b : a;
}

function reviewEvidenceScore(result: ReviewRunResult): number {
  let score = 0;
  score += Math.min(result.sources.length, 20) * 3;
  score += Math.min(countReviewLineCitations(result.answer), 20) * 4;
  if (/##?\s*Sources\b/i.test(result.answer)) score += 8;
  if (looksLikeReviewAnswer(result.answer)) score += 5;
  return score;
}

function countReviewLineCitations(text: string): number {
  const matches = text.match(new RegExp(String.raw`\b${REVIEW_CITABLE_PATH_PATTERN}:\d+(?:-\d+)?\b`, "g"));
  return matches?.length ?? 0;
}

function hasReviewFindings(text: string): boolean {
  if (/\b(no|not|did not find|found no|no substantial|no blocking)\s+(?:issues?|findings?|bugs?|regressions?)\b/i.test(text)) {
    return false;
  }
  return /(^|\n)\s*#{2,4}\s*(?:P[0-3]|critical|high|medium|low|major|minor|finding|issue)\b/i.test(text) ||
    /\bseverity\s*:\s*(?:critical|high|medium|low|major|minor)\b/i.test(text) ||
    /\[(?:P[0-3]|critical|high|medium|low|major|minor)\]/i.test(text);
}

function hasVerificationSection(text: string): boolean {
  return /#{2,4}\s*Verification\b/i.test(text) || /\bStatic-only:\s*\S+/i.test(text) || /\bCommand:\s*`?[^`\n]+`?/i.test(text);
}

function buildInvestigationPrompt(strictRetry: boolean, runtime: AgentRuntime = "agent"): string {
  const schema = [
    "{",
    '  "summaryMarkdown": "short markdown summary of what you checked and the result",',
    '  "issues": [',
    "    {",
    '      "title": "concise title",',
    '      "severity": "low",',
    '      "category": "investigation",',
    '      "explanationMarkdown": "2-3 sentence explanation with concrete evidence.",',
    '      "citations": [',
    '        {"path":"src/file.ts","side":"additions","startLine":12,"endLine":12,"label":"src/file.ts:12","reason":"why this line matters"}',
    "      ],",
    '      "fixSuggestions": ["optional concrete fix"],',
    '      "testsToAdd": ["optional missing test"]',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const examples = [
    "Example A — no issues found:",
    '<ANSWER>{"summaryMarkdown":"Checked the changed runtime path, adjacent tests, and configuration touched by the PR. I did not find a concrete bug or flag; the remaining risk is covered by the existing focused tests.","issues":[]}</ANSWER>',
    "",
    "Example B — one verified bug:",
    '<ANSWER>{"summaryMarkdown":"Found one high-confidence regression in the changed cache path.","issues":[{"title":"Cache key no longer includes the branch","severity":"high","category":"bug","explanationMarkdown":"The new cache key is built from repo and path only, so reviewing two branches can reuse stale file contents. The changed line constructs the key, and the caller uses that key for all subsequent reads.","citations":[{"path":"src/cache.ts","side":"additions","startLine":42,"endLine":42,"label":"src/cache.ts:42","reason":"Changed key construction omits the branch."}],"fixSuggestions":["Include the branch or commit SHA in the cache key."],"testsToAdd":["Add a regression test that loads the same file path from two branches."]}]}</ANSWER>',
    "",
    "Example C — one flag, not a bug:",
    '<ANSWER>{"summaryMarkdown":"No verified correctness bug, but one test coverage risk deserves attention.","issues":[{"title":"New fallback path is untested","severity":"medium","category":"investigation","explanationMarkdown":"The PR adds a fallback path for missing metadata, but the changed tests only cover the happy path. I could not prove this breaks behavior, so this is a flag rather than a bug.","citations":[{"path":"src/metadata.ts","side":"additions","startLine":88,"endLine":95,"label":"src/metadata.ts:88-95","reason":"New fallback behavior lacks a matching test case."}],"fixSuggestions":["Add a focused test for missing metadata."],"testsToAdd":["Cover the fallback branch when metadata is absent."]}]}</ANSWER>',
  ].join("\n");
  const mcpLine = runtime === "rlm"
    ? "4. When the PR/question references Slack, Linear, Jira, roadmap items, incidents, customer reports, or rollout state, use connected MCP tooling if connected."
    : runtime === "local-cli"
      ? "4. MCP tools are not available in local CLI v1. If external rollout state is required, state that it could not be retrieved."
      : "4. When the PR/question references Slack, Linear, Jira, roadmap items, incidents, customer reports, or rollout state, use JCODE MCP tooling if connected.";
  const wrapperLine = runtime === "rlm"
    ? "Use the rlm-bun sandbox to inspect the PR and repository before returning JSON."
    : runtime === "local-cli"
      ? "Use the local CLI agent's native tools to inspect the PR and repository before returning JSON."
      : "Use JCODE native tools to inspect the PR and repository before returning JSON.";
  const outputLine = runtime === "rlm"
    ? "- The final answer must be one valid JSON object inside <ANSWER>...</ANSWER>. Do not add a SUBMIT call for this structured investigation."
    : "- The final answer must be one valid JSON object inside <ANSWER>...</ANSWER>.";
  const noWrapperLine = runtime === "rlm"
    ? "- No trailing commas, comments, markdown fences, JavaScript blocks, SUBMIT calls, or prose outside <ANSWER>."
    : "- No trailing commas, comments, markdown fences, or prose outside <ANSWER>.";

  return [
    strictRetry
      ? "STRICT RETRY: the previous Investigate attempt failed because the final answer was not parseable JSON. This attempt must return exactly one valid JSON object inside <ANSWER>...</ANSWER>."
      : "You are powering rlm-wiki's Review Anything Investigate button.",
    "",
    "Goal: find Bugs and Flags for this GitHub PR.",
    "This is not a markdown review. The UI only accepts structured JSON.",
    wrapperLine,
    "",
    "Investigation checklist before the final answer:",
    "1. Read the diff and changed-file summary.",
    "2. Read the semantically relevant changed files.",
    runtime === "rlm"
      ? "3. For each suspected issue, verify impact with at least one caller, test, config, import path, rg result, lsp_query, gitDiffWorking check, or graph tool only when graph tools are explicitly available."
      : "3. For each suspected issue, verify impact with at least one caller, test, config, import path, search result, symbol query, or diff check.",
    `${mcpLine}${runtime === "rlm" ? " If a side-effect or lookup tool repeatedly fails validation, stop and record that external evidence could not be retrieved." : ""}`,
    "5. If evidence is weak, classify it as investigation or omit it.",
    "6. Submit only after you have enough evidence to fill the JSON.",
    "",
    "Categories:",
    "- bug: high-confidence correctness, security, data-loss, or regression issue.",
    "- investigation: plausible risk, missing validation, missing test, fragile behavior, or design tradeoff needing human attention.",
    "- informational: rare, useful context that is not a blocker.",
    "",
    "Citation rules:",
    "- Prefer visible changed/context lines in the diff.",
    "- Use side additions, deletions, or unified.",
    "- If the evidence is outside visible diff lines, citations may be empty; explain the evidence in explanationMarkdown.",
    "",
    "JSON rules:",
    outputLine,
    "- Use double quotes for every key and string.",
    noWrapperLine,
    "- issue.severity must be one of: low, medium, high, critical.",
    "- issue.category must be one of: bug, investigation, informational.",
    "- issues may be empty. Do not invent findings.",
    "",
    "Schema:",
    schema,
    "",
    "Few-shot examples. Do not copy these findings; copy only the output shape:",
    examples,
    "",
    strictRetry
      ? "Final reminder: skip all prose in the final answer. Return parseable JSON in <ANSWER> tags."
      : "Final reminder: investigate first, then return parseable JSON in <ANSWER> tags.",
  ].join("\n");
}

function parseInvestigationAnswer(answer: string, sources: string[]): ParsedInvestigationResult {
  const jsonText = extractJsonObject(answer);
  if (!jsonText) {
    return { summaryMarkdown: answer || "Investigation finished.", issues: [], rawAnswer: answer, sources, parsedOk: false };
  }

  try {
    const parsed = JSON.parse(jsonText) as { summaryMarkdown?: unknown; summary?: unknown; issues?: unknown };
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
    return {
      summaryMarkdown: String(parsed.summaryMarkdown ?? parsed.summary ?? "Investigation finished."),
      issues: rawIssues.map(normalizeIssue).filter((issue): issue is ReviewIssue => issue !== null),
      rawAnswer: answer,
      sources,
      parsedOk: true,
    };
  } catch {
    return { summaryMarkdown: answer || "Investigation finished.", issues: [], rawAnswer: answer, sources, parsedOk: false };
  }
}

function extractJsonObject(text: string): string | null {
  const answer = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i);
  if (answer) {
    const json = extractJsonObjectFromChunk(answer[1]);
    if (json) return json;
  }
  return extractJsonObjectFromChunk(text);
}

function extractJsonObjectFromChunk(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) return fenced[1];

  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeIssue(raw: unknown): ReviewIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const title = String(obj.title ?? "").trim();
  if (!title) return null;

  const severity = normalizeSeverity(obj.severity);
  const category = normalizeCategory(obj.category);
  const rawCitations = Array.isArray(obj.citations) ? obj.citations : [];
  const fix = Array.isArray(obj.fixSuggestions) ? obj.fixSuggestions : Array.isArray(obj.fix_suggestions) ? obj.fix_suggestions : [];
  const tests = Array.isArray(obj.testsToAdd) ? obj.testsToAdd : Array.isArray(obj.tests_to_add) ? obj.tests_to_add : [];
  return {
    title,
    severity,
    category,
    explanationMarkdown: String(obj.explanationMarkdown ?? obj.explanation ?? obj.body ?? ""),
    citations: rawCitations.map(normalizeCitation).filter((c): c is ReviewCitation => c !== null),
    fixSuggestions: fix.map(String).filter(Boolean),
    testsToAdd: tests.map(String).filter(Boolean),
  };
}

function normalizeSeverity(value: unknown): ReviewIssue["severity"] {
  const v = String(value ?? "medium").toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function normalizeCategory(value: unknown): ReviewIssue["category"] {
  const v = String(value ?? "informational").toLowerCase();
  if (v === "bug" || v === "investigation" || v === "informational") return v;
  return "informational";
}

function normalizeCitation(raw: unknown): ReviewCitation | null {
  if (typeof raw === "string") {
    const match = raw.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const startLine = Number(match[2]);
    return {
      path: match[1],
      side: "unified",
      startLine,
      endLine: Number(match[3] ?? match[2]),
    };
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const path = String(obj.path ?? "").trim();
  const startLine = Number(obj.startLine ?? obj.start_line ?? obj.line ?? 0);
  if (!path || !Number.isFinite(startLine) || startLine <= 0) return null;
  const endLine = Number(obj.endLine ?? obj.end_line ?? startLine);
  const sideRaw = String(obj.side ?? "unified").toLowerCase();
  const side = sideRaw === "additions" || sideRaw === "deletions" ? sideRaw : "unified";
  return {
    path,
    side,
    startLine,
    endLine: Number.isFinite(endLine) && endLine > 0 ? endLine : startLine,
    label: typeof obj.label === "string" ? obj.label : undefined,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  };
}

function publicReview(record: CachedReview): ReviewRecord {
  const { prData: _prData, githubFetch: _githubFetch, ...publicRecord } = record;
  void _prData;
  void _githubFetch;
  return publicRecord;
}

function normalizeReviewId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "";
  return raw.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 160);
}

async function fetchReviewGithubContext(
  owner: string,
  repo: string,
  number: number,
  url: string,
  prData: PRData,
  githubFetch?: GitHubFetch,
): Promise<ReviewGithubContext> {
  const token = githubFetch ? undefined : await resolveGithubToken();
  const base = `/repos/${owner}/${repo}`;

  try {
    const [pr, issueComments, reviewComments, reviews, commits] = await Promise.all([
      fetchGithubJson<any>(`${base}/pulls/${number}`, token, githubFetch),
      fetchGithubJsonPages<any>(`${base}/issues/${number}/comments`, token, 2, githubFetch),
      fetchGithubJsonPages<any>(`${base}/pulls/${number}/comments`, token, 2, githubFetch),
      fetchGithubJsonPages<any>(`${base}/pulls/${number}/reviews`, token, 2, githubFetch),
      fetchGithubJsonPages<any>(`${base}/pulls/${number}/commits`, token, 3, githubFetch),
    ]);

    const mergeableState = String(pr.mergeable_state ?? prData.info.mergeableState ?? "");
    const discussion = [
      ...issueComments.map((comment) => normalizeDiscussionComment(comment, "comment")),
      ...reviewComments.map((comment) => normalizeDiscussionComment(comment, "review-comment")),
      ...reviews.map((review) => normalizeReviewSubmission(review)),
    ]
      .filter((item): item is ReviewDiscussionItem => item !== null)
      .sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));

    return {
      htmlUrl: String(pr.html_url ?? url),
      mergeableState,
      mergeStatus: mergeStatusFor({
        state: String(pr.state ?? prData.info.state ?? ""),
        draft: Boolean(pr.draft ?? prData.info.draft),
        merged: Boolean(pr.merged ?? false),
        mergeableState,
      }),
      merged: Boolean(pr.merged ?? false),
      author: normalizeGithubUser(pr.user, prData.info.author || "unknown"),
      createdAt: String(pr.created_at ?? prData.info.createdAt ?? ""),
      updatedAt: String(pr.updated_at ?? prData.info.updatedAt ?? ""),
      labels: Array.isArray(pr.labels) ? pr.labels.map((label: any) => String(label.name ?? "")).filter(Boolean) : prData.info.labels,
      commentsCount: Number(pr.comments ?? issueComments.length),
      reviewCommentsCount: Number(pr.review_comments ?? reviewComments.length),
      reviewsCount: reviews.length,
      commitsCount: Number(pr.commits ?? commits.length),
      discussion,
      commits: commits.map((commit) => normalizeCommit(commit, pr.head?.sha)).filter((commit): commit is ReviewCommit => commit !== null),
    };
  } catch (error) {
    return {
      ...fallbackGithubContext(url, prData),
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function fallbackGithubContext(url: string, prData: PRData): ReviewGithubContext {
  const discussion: ReviewDiscussionItem[] = [
    ...prData.conversation.issueComments.map((comment) => ({
      id: `comment-${comment.id}`,
      kind: "comment" as const,
      author: { login: comment.author || "unknown" },
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    ...prData.conversation.reviewComments.map((comment) => ({
      id: `review-comment-${comment.id}`,
      kind: "review-comment" as const,
      author: { login: comment.author || "unknown" },
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      path: comment.path,
      line: comment.line,
      state: comment.resolved ? "RESOLVED" : undefined,
    })),
    ...prData.conversation.reviews.map((review) => ({
      id: `review-${review.id}`,
      kind: "review" as const,
      author: { login: review.author || "unknown" },
      body: review.body,
      createdAt: review.submittedAt,
      state: review.state,
    })),
  ].sort((a, b) => dateValue(a.createdAt) - dateValue(b.createdAt));

  return {
    htmlUrl: url,
    mergeableState: prData.info.mergeableState,
    mergeStatus: mergeStatusFor({
      state: prData.info.state,
      draft: prData.info.draft,
      merged: false,
      mergeableState: prData.info.mergeableState,
    }),
    merged: false,
    author: { login: prData.info.author || "unknown" },
    createdAt: prData.info.createdAt,
    updatedAt: prData.info.updatedAt,
    labels: prData.info.labels,
    commentsCount: prData.conversation.issueComments.length,
    reviewCommentsCount: prData.conversation.reviewComments.length,
    reviewsCount: prData.conversation.reviews.length,
    commitsCount: prData.conversation.commitMessages.length,
    discussion,
    commits: prData.conversation.commitMessages.map((message, index) => {
      const title = message.split("\n")[0]?.trim() || `Commit ${index + 1}`;
      return {
        sha: "",
        shortSha: "",
        title,
        message,
        author: { login: "unknown" },
        authoredAt: "",
        current: false,
      };
    }),
  };
}

function normalizeDiscussionComment(raw: any, kind: "comment" | "review-comment"): ReviewDiscussionItem | null {
  if (!raw) return null;
  return {
    id: `${kind}-${raw.id ?? crypto.randomUUID()}`,
    kind,
    author: normalizeGithubUser(raw.user, "unknown"),
    body: String(raw.body ?? ""),
    createdAt: String(raw.created_at ?? raw.updated_at ?? ""),
    updatedAt: raw.updated_at ? String(raw.updated_at) : undefined,
    path: kind === "review-comment" ? String(raw.path ?? "") : undefined,
    line: kind === "review-comment" ? Number(raw.line ?? raw.original_line ?? 0) || undefined : undefined,
    htmlUrl: raw.html_url ? String(raw.html_url) : undefined,
  };
}

function normalizeReviewSubmission(raw: any): ReviewDiscussionItem | null {
  if (!raw) return null;
  return {
    id: `review-${raw.id ?? crypto.randomUUID()}`,
    kind: "review",
    author: normalizeGithubUser(raw.user, "unknown"),
    body: String(raw.body ?? ""),
    createdAt: String(raw.submitted_at ?? raw.created_at ?? raw.updated_at ?? ""),
    updatedAt: raw.updated_at ? String(raw.updated_at) : undefined,
    state: raw.state ? String(raw.state) : undefined,
    htmlUrl: raw.html_url ? String(raw.html_url) : undefined,
  };
}

function normalizeCommit(raw: any, headSha?: string): ReviewCommit | null {
  const sha = String(raw?.sha ?? "");
  const message = String(raw?.commit?.message ?? "");
  const title = message.split("\n")[0]?.trim() || (sha ? `Commit ${sha.slice(0, 7)}` : "Commit");
  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : "",
    title,
    message,
    author: normalizeGithubUser(raw?.author, raw?.commit?.author?.name || "unknown"),
    authoredAt: String(raw?.commit?.author?.date ?? raw?.commit?.committer?.date ?? ""),
    htmlUrl: raw?.html_url ? String(raw.html_url) : undefined,
    current: Boolean(headSha && sha === headSha),
  };
}

function normalizeGithubUser(raw: any, fallback: string): ReviewUser {
  const login = String(raw?.login ?? fallback ?? "unknown");
  return {
    login,
    avatarUrl: raw?.avatar_url ? String(raw.avatar_url) : undefined,
    htmlUrl: raw?.html_url ? String(raw.html_url) : undefined,
    type: raw?.type ? String(raw.type) : undefined,
  };
}

function mergeStatusFor(args: { state: string; draft: boolean; merged: boolean; mergeableState: string }): string {
  const state = args.state.toLowerCase();
  const mergeableState = args.mergeableState.toLowerCase();
  if (args.merged) return "Merged";
  if (state === "closed") return "Closed without merge";
  if (args.draft) return "Draft PR cannot be merged yet";
  if (mergeableState === "blocked") return "Merging is blocked by branch protection rules";
  if (mergeableState === "dirty") return "Merging is blocked by conflicts";
  if (mergeableState === "unstable") return "Merging is waiting on checks";
  if (mergeableState === "clean") return "Ready to merge";
  if (mergeableState === "unknown" || !mergeableState) return "Mergeability is still being calculated";
  return `Merge state: ${mergeableState}`;
}

function dateValue(value: string | undefined): number {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

async function fetchGithubJson<T>(
  path: string,
  token?: string,
  githubFetch?: GitHubFetch,
): Promise<T> {
  const response = githubFetch
    ? await githubFetch(path, githubHeaders(token))
    : await fetch(`https://api.github.com${path}`, {
      headers: githubHeaders(token),
    });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function fetchGithubJsonPages<T>(
  path: string,
  token: string | undefined,
  maxPages: number,
  githubFetch?: GitHubFetch,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await fetchGithubJson<T[]>(`${path}${sep}per_page=100&page=${page}`, token, githubFetch);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "rlm-wiki-review",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchGithubFile(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  githubFetch?: GitHubFetch,
): Promise<string | null> {
  const token = githubFetch ? undefined : await resolveGithubToken();
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const requestPath = `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`;
  const headers = {
    ...githubHeaders(token),
    ...(githubFetch ? {} : { Accept: "application/vnd.github.raw" }),
  };
  const response = githubFetch
    ? await githubFetch(requestPath, headers)
    : await fetch(`https://api.github.com${requestPath}`, { headers });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub file fetch failed for ${path}: ${response.status} ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await response.json() as { content?: string; encoding?: string };
    if (json.encoding === "base64" && json.content) {
      return Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf8");
    }
  }
  return response.text();
}

async function resolveGithubToken(): Promise<string | undefined> {
  if (cachedGithubToken !== undefined) return cachedGithubToken || undefined;
  if (process.env.GITHUB_TOKEN) {
    cachedGithubToken = process.env.GITHUB_TOKEN;
    return cachedGithubToken;
  }

  try {
    const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0 && result.stdout) {
      const token = new TextDecoder().decode(result.stdout).trim();
      cachedGithubToken = token || null;
      return token || undefined;
    }
  } catch {
    /* gh is optional */
  }

  cachedGithubToken = null;
  return undefined;
}
