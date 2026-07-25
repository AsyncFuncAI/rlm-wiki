import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { RLMEvent } from "./jcode-runtime.ts";
import { buildStructurePrompt } from "./prompts/structure.ts";
import { buildPagePrompt, DOCS_MIN_BODY_CHARS } from "./prompts/page.ts";
import { documentationPresentationQualityIssue } from "./docs-presentation-quality.ts";
import { preludeForRuntime } from "./prompts/prelude.ts";
import { parseWikiStructureXml } from "./xml-parser.ts";
import type {
  RepoRef,
  WorkspaceRepoRef,
  WikiRecord,
  WikiPage,
  WikiStructure,
  GeneratedPage,
} from "./types.ts";
import { WikiStore } from "./storage.ts";
import { codeKbEnabled, ensureCodeKbSession, peekCodeKbSession, queryCodeKb, raceWithBudget, readCodeKbFile, type CodeKbSession, type CodeKbSessionPeek, type CodeKbSkipReason } from "./sharenow-kb-client.ts";
import { renderCodeKbBlock, renderDirectPageEvidence, renderDirectStructureEvidence, renderPageEvidencePack, renderStructureEvidence } from "./prompts/code-kb.ts";
import { DEFAULT_CHANNEL_ID, resolveChannel } from "./llm.ts";
import type { ProviderModel } from "./llm.ts";
import { normalizeAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { localCliControlsForSurface, type PromptSurface } from "./model-control.ts";
import { localCliLabel, normalizeLocalCliConfig, type LocalCliConfig } from "./local-cli-events.ts";
import { isFailedWikiGeneratedPage } from "./wiki-page-status.ts";
import type { ProviderSecrets } from "./provider-secrets.ts";
import { normalizeKnowledgeProfile, type KnowledgeProfile } from "./knowledge-profile.ts";
import {
  defaultWikiPageCountForDepth,
  normalizeWikiDepth,
  normalizeWikiPageCount,
  normalizeWikiPageCountMode,
  normalizeWikiStyle,
  normalizeWikiStylePrompt,
  normalizeWikiLanguages,
  wikiLanguagePrompt,
  wikiSourceScaffold,
  wikiAutoPageCountRange,
  wikiDepthForPageCount,
  type WikiDepth,
  type WikiPageCountMode,
  type WikiLanguage,
  type WikiStyle,
} from "./wiki-options.ts";
import {
  createWikiId,
  wikiSourceKey,
  wikiVariantKey,
} from "./wiki-identity.ts";

/** @deprecated use DEFAULT_CHANNEL_ID from ./llm.ts */
export const DEFAULT_MODEL = DEFAULT_CHANNEL_ID;

const MAX_PAGE_CONCURRENCY = 10;
const DEFAULT_PAGE_CONCURRENCY = 4;
const DEFAULT_LOCAL_CLI_PAGE_CONCURRENCY = 8;
const STRUCTURE_AGENT_TIMEOUT_MS = envPositiveInt("RLM_WIKI_STRUCTURE_AGENT_TIMEOUT_MS", 1_800_000);
const PAGE_AGENT_TIMEOUT_MS = envPositiveInt("RLM_WIKI_PAGE_AGENT_TIMEOUT_MS", 1_800_000);
// Kill an agent only when it goes silent, not while it is visibly working. Local CLI
// runtimes emit an event per message/tool call, so long gaps mean a hung process.
const STRUCTURE_AGENT_IDLE_TIMEOUT_MS = envPositiveInt("RLM_WIKI_STRUCTURE_AGENT_IDLE_TIMEOUT_MS", 300_000);
const PAGE_AGENT_IDLE_TIMEOUT_MS = envPositiveInt("RLM_WIKI_PAGE_AGENT_IDLE_TIMEOUT_MS", 300_000);
const USER_STOP_MESSAGE = "Stopped by user.";
// Generation runs minutes, so a cold sharenow kb provision (~5-20s) is worth
// waiting for; anything slower degrades to the instruction-only blocks when a
// provisioning session is already cached (pre-warm), else to the no-kb prompts.
const WIKI_CODE_KB_BUDGET_MS = envPositiveInt("RLM_WIKI_CODE_KB_WIKI_BUDGET_MS", 20_000);
// U2 evidence pre-fetch (KTD-4): bounded fan-out so a burst of kb reads never
// swamps the session sandbox, plus deterministic head sizes for cache-stable
// prompts. All fetches are best-effort; a failed item is silently omitted.
const CODE_KB_EVIDENCE_MAX_IN_FLIGHT = 8;
const CODE_KB_FILE_INVENTORY_LIMIT = 200;
const CODE_KB_HOTSPOT_MIN_DEGREE = 10;
const CODE_KB_HOTSPOT_LIMIT = 30;
const CODE_KB_PAGE_HEAD_LINES = 80;
const CODE_KB_PAGE_EVIDENCE_MAX_FILES = 4;
const DIRECT_PAGE_MAX_FILES = 6;
const DIRECT_PAGE_END_LINE = 320;
const FAST_PAGE_WIKI_TIMEOUT_MS = 90_000;
const FAST_PAGE_DOCUMENTATION_TIMEOUT_MS = 120_000;
// B7 fast-structure direct call: for fast-depth wikis with a READY kb session,
// ONE sourceless LLM completion over pre-fetched kb evidence replaces the
// structure agent (~68s serial in every A/B config). Evidence sizes are larger
// than the agent-path caps because the prompt is consumed exactly once.
const FAST_STRUCTURE_FILE_INVENTORY_LIMIT = 300;
// Clamp direct-call page plans to the agent planner's typical load (A/B: the
// direct planner drifted to 7-8 files/page, making every page agent slower).
const FAST_STRUCTURE_MAX_FILES_PER_PAGE = 6;
// The direct-call budget scales with the requested page count: a deeper plan
// (Docs asks for up to 30 pages) is a longer single completion, so a flat 60s
// timed out every deep run. Grows 4s per page from a 60s floor, capped at 180s.
const FAST_STRUCTURE_TIMEOUT_BASE_MS = 60_000;
const FAST_STRUCTURE_TIMEOUT_PER_PAGE_MS = 4_000;
const FAST_STRUCTURE_TIMEOUT_MAX_MS = 180_000;
const FAST_STRUCTURE_README_HEAD_LINES = 120;
const FAST_STRUCTURE_MANIFEST_HEAD_LINES = 60;
const FAST_STRUCTURE_MANIFEST_CANDIDATES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"] as const;
const WIKI_LOCAL_CLI_ONLY_MESSAGE =
  "Wiki generation is Local CLI-only. Select Codex CLI, Claude Code, Grok CLI, Pi · Codex, Pi · Claude Code, or Antigravity CLI.";

/**
 * Code-graph (sharenow code-kb) session status surfaced to the generation UI.
 * "indexing" is the first-run provisioning wait, "ready" the resolved session,
 * "too-large" the 64 MiB local-archive cap, and "skipped" the fast-structure
 * shortcut falling back to the thorough planner. All are informational: the kb
 * status never fails generation.
 */
export type CodeGraphStatus = "indexing" | "ready" | "too-large" | "skipped";

// User-facing copy for each code-graph state. NO em-dashes (repo hard rule);
// periods and parentheses only.
export const CODE_GRAPH_STATUS_COPY: Record<CodeGraphStatus, string> = {
  indexing: "Code graph indexing (first run on this repository).",
  ready: "Code graph ready.",
  "too-large": "Code graph unavailable for this repository (too large).",
  skipped: "Code graph shortcut skipped. Using the thorough planner.",
};

export type GenerationEvent =
  | { type: "phase"; phase: "structure" | "pages"; message: string }
  | { type: "code-graph"; state: CodeGraphStatus; message: string }
  | { type: "structure-start" }
  | {
      type: "structure-agent";
      event: RLMEvent;
    }
  | { type: "structure-done"; structure: WikiStructure }
  | { type: "page-start"; pageId: string; title: string }
  | { type: "page-agent"; pageId: string; event: RLMEvent }
  | { type: "page-done"; pageId: string; content: string; tokenUsage: GeneratedPage["tokenUsage"] }
  | { type: "page-error"; pageId: string; error: string; displayError?: string }
  | { type: "done"; record: WikiRecord }
  | { type: "error"; error: string };

export interface GenerateOptions {
  /** Model-channel id from MODEL_CHANNELS (e.g. "gemini-3.1-pro-preview", "kimi-k2.6"). */
  channel?: string;
  /** @deprecated alias for `channel`. */
  model?: string;
  /** Model-channel id used only by the structure-planning agent. Falls back to `channel`. */
  structureChannel?: string;
  /** Model-channel id used by page-writing agents. Falls back to `channel`. */
  pageChannel?: string;
  concurrency?: number;
  store?: WikiStore;
  onEvent?: (ev: GenerationEvent) => void;
  maxStructureIterations?: number;
  maxPageIterations?: number;
  runtime?: AgentRuntime | string;
  localCli?: LocalCliConfig | unknown;
  providerSecrets?: ProviderSecrets;
  depth?: WikiDepth | string;
  pageCount?: number;
  pageCountMode?: WikiPageCountMode | string;
  style?: WikiStyle | string;
  stylePrompt?: string;
  languages?: WikiLanguage[] | string[] | string;
  knowledgeProfile?: unknown;
  refs?: WorkspaceRepoRef[];
  /** Explicitly opt this generation run into guarded direct page writing. Defaults to false. */
  preferDirectPages?: boolean;
  signal?: AbortSignal;
  onCheckpoint?: (record: WikiRecord, checkpoint: { phase: "structure" | "page"; pageId?: string }) => Promise<void> | void;
  /** DI seam for the sharenow code-kb client; defaults to the real client. */
  codeKb?: WikiCodeKbOptions;
}

export interface WikiCodeKbOptions {
  enabled?: () => boolean;
  ensure?: (ref: RepoRef, opts?: { budgetMs?: number; onSkip?: (reason: CodeKbSkipReason) => void }) => Promise<CodeKbSession | null>;
  query?: (session: CodeKbSession, tool: string, args?: Record<string, unknown>) => Promise<unknown | null>;
  /** Cache-only session lookup for the instruction-only fallback (R2); defaults to peekCodeKbSession. */
  peek?: (ref: RepoRef) => Promise<CodeKbSessionPeek | null>;
  /** Raw snapshot file reader for the U2 evidence pre-fetches; defaults to readCodeKbFile. */
  readFile?: (session: CodeKbSession, path: string, range?: { startLine?: number; endLine?: number }) => Promise<unknown | null>;
  /** DI seam for the B7 fast-structure direct LLM call; defaults to a sourceless local-CLI chat run. */
  directCall?: WikiStructureDirectCall;
  /** DI seam for the guarded direct page writer; defaults to a sourceless local-CLI chat run. */
  directPageCall?: WikiPageDirectCall;
  /** Best-effort direct-page outcome metric. Callback failures never affect generation. */
  onDirectPageResult?: (result: WikiDirectPageResult) => Promise<void> | void;
  budgetMs?: number;
}

/**
 * The B7 direct structure call: one prompt in, one raw completion out, on the
 * run's own local CLI config (BYOC, vendor-agnostic; no hardcoded provider).
 * Tests inject canned XML strings; production uses the sourceless
 * routing-brain/KB runner pattern (mode:"chat", empty scratch CWD, no clone).
 */
export interface WikiStructureDirectCall {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal): Promise<string>;
}

export interface WikiPageDirectCall {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal): Promise<string>;
}

export interface WikiDirectPageResult {
  pageId: string;
  state: "success" | "fallback" | "timeout";
  attempted: boolean;
  durationMs: number;
  reason?: string;
}

export interface WikiCodeKbPrompts {
  /** Full block (architecture code map + query instructions) for the structure prompt. */
  structureCodeKb: string;
  /** Instructions-only block (small) for every page prompt. */
  pageCodeKb: string;
  /**
   * The ready session behind the blocks, present only on the full (ready +
   * architecture) path. Powers the U2 evidence pre-fetches; the instruction-only
   * fallback carries no session, so those runs stay exactly on the U1 behavior.
   */
  session?: CodeKbSession;
}

/**
 * Best-effort pre-fetch of the sharenow code-kb prompt material: ensure a kb
 * session for the repo and run `get_architecture`, all within one budget.
 * When that primary path misses the budget (or yields no architecture) but a
 * session id is already cached (pre-warmed, possibly still provisioning), the
 * instruction-only blocks ship anyway so agents can query the kb once it
 * comes up (R2); the block copy covers early 410/provisioning responses.
 * Resolves null on ANY other failure (disabled flag, throw, timeout with no
 * cached session) so generation proceeds byte-identical to the no-kb path.
 */
export async function prefetchWikiCodeKbPrompts(
  ref: RepoRef,
  codeKb: WikiCodeKbOptions = {},
  onStatus?: (state: CodeGraphStatus) => void,
): Promise<WikiCodeKbPrompts | null> {
  try {
    if (!(codeKb.enabled ?? codeKbEnabled)()) return null;
  } catch {
    return null;
  }
  const budgetMs = codeKb.budgetMs ?? WIKI_CODE_KB_BUDGET_MS;
  const sourceKind = ref.owner === "local" ? ("local" as const) : ("github" as const);
  // Emit each state at most once; the "too-large" skip and a later "ready"/"indexing"
  // are mutually exclusive outcomes, and a duplicate would only churn the UI row.
  const reported = new Set<CodeGraphStatus>();
  const status = (state: CodeGraphStatus): void => {
    if (!onStatus || reported.has(state)) return;
    reported.add(state);
    try {
      onStatus(state);
    } catch {
      // Status reporting is decorative; never let it fail the prefetch.
    }
  };
  // Indexing is the "not already ready" case: peek is cache-only (no network),
  // so a warm ready session skips the indexing notice and goes straight to
  // ready. Only probed when a listener is attached, so a caller with no status
  // callback keeps the exact pre-status call sequence (no extra peek).
  if (onStatus) {
    try {
      const peek = codeKb.peek ?? peekCodeKbSession;
      const known = await peek(ref);
      if (known?.state !== "ready") status("indexing");
    } catch {
      // A failed peek is indistinguishable from a cold start; assume indexing.
      status("indexing");
    }
  }
  const run = async (): Promise<WikiCodeKbPrompts | null> => {
    const ensure = codeKb.ensure ?? ensureCodeKbSession;
    const query = codeKb.query ?? queryCodeKb;
    const session = await ensure(ref, { budgetMs, onSkip: (reason) => reason === "too-large" && status("too-large") });
    if (!session) return null;
    const architecture = await query(session, "get_architecture", {});
    if (architecture === null || architecture === undefined) return null;
    return {
      structureCodeKb: renderCodeKbBlock({ session, architecture, includeToolInstructions: true, sourceKind }),
      pageCodeKb: renderCodeKbBlock({ session, includeToolInstructions: true, sourceKind }),
      session,
    };
  };
  // raceWithBudget swallows a late rejection after the timeout wins, so it
  // can never surface as an unhandled rejection.
  const full = await raceWithBudget(run(), budgetMs);
  if (full) {
    status("ready");
    return full;
  }
  try {
    const peek = codeKb.peek ?? peekCodeKbSession;
    const peeked = await peek(ref);
    if (!peeked) return null;
    if (peeked.state === "ready") status("ready");
    const instructionsOnly = renderCodeKbBlock({ session: peeked.session, includeToolInstructions: true, sourceKind });
    return { structureCodeKb: instructionsOnly, pageCodeKb: instructionsOnly };
  } catch {
    return null;
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight (KTD-4). Results keep
 * the input order. Callers pass a `fn` that never rejects (best-effort items).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Pull the raw text out of a kb `/file` read result; null when unrecognizable. */
function codeKbFileContent(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return null;
}

/**
 * U2 (R3): pre-fetch structure-phase evidence from a ready kb session (file
 * inventory and hotspot symbols) in parallel with a small in-flight cap. The
 * README head and manifest probe fetches were dropped: the A/B benchmark showed
 * those sections did not reduce structure-agent tool calls and only added the
 * per-iteration token tax, so trimming to the two graph queries is the win.
 * Every item is best-effort: a failed fetch omits that section, and an all-fail
 * run returns "" so the structure prompt stays byte-identical to the
 * pre-evidence output (R8). Bounded by the codeKb budget; never throws.
 */
export async function fetchWikiStructureEvidence(
  session: CodeKbSession,
  codeKb: WikiCodeKbOptions = {},
): Promise<string> {
  try {
    const query = codeKb.query ?? queryCodeKb;
    const tasks: Array<() => Promise<unknown | null>> = [
      () => query(session, "search_graph", { label: "File", limit: CODE_KB_FILE_INVENTORY_LIMIT }),
      () => query(session, "search_graph", { minDegree: CODE_KB_HOTSPOT_MIN_DEGREE, limit: CODE_KB_HOTSPOT_LIMIT }),
    ];
    const settled = await raceWithBudget(
      mapWithConcurrency(tasks, CODE_KB_EVIDENCE_MAX_IN_FLIGHT, (task) => task().catch(() => null)),
      codeKb.budgetMs ?? WIKI_CODE_KB_BUDGET_MS,
    );
    if (!settled) return "";
    const [fileInventory, hotspots] = settled;
    return renderStructureEvidence({
      fileInventory: fileInventory ?? undefined,
      hotspots: hotspots ?? undefined,
    });
  } catch {
    return "";
  }
}

/**
 * U2 (R4): pre-fetch per-page evidence packs — head excerpts of up to four of
 * each page's filePaths — with ONE in-flight cap shared across all pages
 * (KTD-4). Duplicate paths across pages are fetched once. Returns pageId →
 * rendered pack; pages with nothing fetched are absent, and a total failure
 * yields an empty map so every page prompt stays byte-identical to the
 * pre-evidence output (R8). Bounded by the codeKb budget; never throws.
 */
export async function fetchWikiPageEvidencePacks(
  session: CodeKbSession,
  pages: WikiStructure["pages"],
  codeKb: WikiCodeKbOptions = {},
): Promise<Map<string, string>> {
  const packs = new Map<string, string>();
  try {
    const readFile = codeKb.readFile ?? readCodeKbFile;
    const perPagePaths = pages.map((page) => ({
      pageId: page.id,
      paths: (page.filePaths || [])
        .filter((path) => typeof path === "string" && path.trim() !== "")
        .slice(0, CODE_KB_PAGE_EVIDENCE_MAX_FILES),
    }));
    const uniquePaths = Array.from(new Set(perPagePaths.flatMap((entry) => entry.paths)));
    if (uniquePaths.length === 0) return packs;
    const heads = await raceWithBudget(
      mapWithConcurrency(uniquePaths, CODE_KB_EVIDENCE_MAX_IN_FLIGHT, async (path) => {
        try {
          return codeKbFileContent(await readFile(session, path, { startLine: 1, endLine: CODE_KB_PAGE_HEAD_LINES }));
        } catch {
          return null;
        }
      }),
      codeKb.budgetMs ?? WIKI_CODE_KB_BUDGET_MS,
    );
    if (!heads) return packs;
    const headByPath = new Map<string, string>();
    uniquePaths.forEach((path, index) => {
      const head = heads[index];
      if (typeof head === "string" && head.trim() !== "") headByPath.set(path, head);
    });
    for (const entry of perPagePaths) {
      const files = entry.paths
        .filter((path) => headByPath.has(path))
        .map((path) => ({ path, head: headByPath.get(path)! }));
      if (files.length === 0) continue;
      const pack = renderPageEvidencePack({ files });
      if (pack) packs.set(entry.pageId, pack);
    }
    return packs;
  } catch {
    return packs;
  }
}

/**
 * Fetch complete source evidence for direct page generation. Each selected
 * path must resolve to non-empty content before its page receives a pack.
 * Reads are deduplicated across the run and remain best-effort under budget.
 */
export async function fetchWikiDirectPageEvidencePacks(
  session: CodeKbSession,
  pages: WikiStructure["pages"],
  codeKb: WikiCodeKbOptions = {},
  sourcePath?: string | null,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const packs = new Map<string, string>();
  try {
    const readFile = codeKb.readFile ?? readCodeKbFile;
    const perPagePaths = pages.map((page) => {
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const rawPath of page.filePaths || []) {
        if (typeof rawPath !== "string") continue;
        const path = codeKbPathForSource(rawPath, sourcePath);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
        if (paths.length === DIRECT_PAGE_MAX_FILES) break;
      }
      return { pageId: page.id, paths };
    });
    const uniquePaths = Array.from(new Set(perPagePaths.flatMap((entry) => entry.paths)));
    if (uniquePaths.length === 0) return packs;
    const contents = await raceWithAbortSignal(
      raceWithBudget(
        mapWithConcurrency(uniquePaths, CODE_KB_EVIDENCE_MAX_IN_FLIGHT, async (path) => {
          try {
            return codeKbFileContent(await readFile(session, path, { startLine: 1, endLine: DIRECT_PAGE_END_LINE }));
          } catch {
            return null;
          }
        }),
        codeKb.budgetMs ?? WIKI_CODE_KB_BUDGET_MS,
      ),
      signal,
    );
    if (!contents) return packs;
    const contentByPath = new Map<string, string>();
    uniquePaths.forEach((path, index) => {
      const content = contents[index];
      if (typeof content === "string" && content.trim() !== "") contentByPath.set(path, content);
    });
    for (const entry of perPagePaths) {
      if (entry.paths.length === 0 || !entry.paths.every((path) => contentByPath.has(path))) continue;
      const pack = renderDirectPageEvidence({
        files: entry.paths.map((path) => ({ path, content: contentByPath.get(path)! })),
      });
      if (pack) packs.set(entry.pageId, pack);
    }
    return packs;
  } catch {
    return packs;
  }
}

/** B7 gate: default ON for fast depth; opt out with RLM_WIKI_CODE_KB_FAST_STRUCTURE=0. */
function fastStructureEnabled(): boolean {
  return process.env.RLM_WIKI_CODE_KB_FAST_STRUCTURE !== "0";
}

function fastPagesEnabled(): boolean {
  return process.env.RLM_WIKI_CODE_KB_FAST_PAGES !== "0";
}

export function fastPageTimeoutDefaultMs(style: WikiStyle | string): number {
  return normalizeWikiStyle(style) === "documentation"
    ? FAST_PAGE_DOCUMENTATION_TIMEOUT_MS
    : FAST_PAGE_WIKI_TIMEOUT_MS;
}

/**
 * Default budget (ms) for the B7 direct structure call, scaled by the requested
 * page count: FAST_STRUCTURE_TIMEOUT_BASE_MS plus FAST_STRUCTURE_TIMEOUT_PER_PAGE_MS
 * per page, clamped to FAST_STRUCTURE_TIMEOUT_MAX_MS. RLM_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS
 * overrides this. A deeper plan is a longer single completion, so the flat 60s
 * default timed out every deep (Docs, up to 30 pages) run.
 */
export function fastStructureTimeoutDefaultMs(pageCount: unknown): number {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  const scaled = FAST_STRUCTURE_TIMEOUT_BASE_MS + FAST_STRUCTURE_TIMEOUT_PER_PAGE_MS * pages;
  return Math.min(FAST_STRUCTURE_TIMEOUT_MAX_MS, scaled);
}

/** Normalize kb/agent file paths for comparison: forward slashes, no leading ./ or /. */
function normalizeCodeKbFilePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function normalizeCodeKbSourcePath(sourcePath?: string | null): string {
  return normalizeCodeKbFilePath(String(sourcePath || "")).replace(/\/+$/, "");
}

function codeKbPathWithinSource(path: string, sourcePath?: string | null): boolean {
  const normalizedPath = normalizeCodeKbFilePath(path);
  const scope = normalizeCodeKbSourcePath(sourcePath);
  return !scope || normalizedPath === scope || normalizedPath.startsWith(`${scope}/`);
}

function codeKbPathForSource(path: string, sourcePath?: string | null): string {
  const normalizedPath = normalizeCodeKbFilePath(path);
  const scope = normalizeCodeKbSourcePath(sourcePath);
  if (!scope || codeKbPathWithinSource(normalizedPath, scope)) return normalizedPath;
  return `${scope}/${normalizedPath}`;
}

function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException(USER_STOP_MESSAGE, "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException(USER_STOP_MESSAGE, "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Extract normalized repo-root-relative paths from a `search_graph {label:"File"}` result. */
function codeKbFileInventoryPaths(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const results = (result as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const paths = new Set<string>();
  for (const node of results) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const raw = [record.file_path, record.name].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    if (!raw) continue;
    const path = normalizeCodeKbFilePath(raw);
    if (path) paths.add(path);
  }
  return Array.from(paths);
}

/**
 * Default B7 runner: byte-for-byte the sourceless routing-brain/KB pattern
 * (src/kb/kb-merge.ts defaultKbAgentRunner). No repo clone, one prompt to one
 * reply on the configured local CLI. The `?? ""` guard keeps a null rawText
 * from flowing into the XML extraction as a non-string.
 */
async function defaultWikiStructureDirectCall(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
): Promise<string> {
  const agent = new LocalCliAgent({ mode: "chat", contextLabel: "chat", localCli });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

async function defaultWikiPageDirectCall(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
): Promise<string> {
  const agent = new LocalCliAgent({ mode: "chat", contextLabel: "chat", localCli });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

/**
 * Accept the direct-call structure only when it matches the agent contract:
 * page count within the requested bounds (exact for fixed mode, 3-to-ceiling
 * for documentation auto mode, the normal auto range otherwise) and every
 * page filePath present in the kb-verified path set. Anything else is a
 * fallback signal, never a repair.
 */
function validateFastStructure(
  structure: WikiStructure,
  validPaths: ReadonlySet<string>,
  pageCount: number,
  pageCountMode: WikiPageCountMode,
  style: WikiStyle,
): boolean {
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  const bounds = pageCountMode === "fixed"
    ? { min: pageCount, max: pageCount }
    : style === "documentation"
      ? { min: Math.min(3, pageCount), max: pageCount }
    : wikiAutoPageCountRange(pageCount);
  if (pages.length < bounds.min || pages.length > bounds.max) return false;
  for (const page of pages) {
    const filePaths = (page.filePaths || []).filter((path) => typeof path === "string" && path.trim() !== "");
    if (filePaths.length === 0) return false;
    for (const filePath of filePaths) {
      if (!validPaths.has(normalizeCodeKbFilePath(filePath))) return false;
    }
    // Heavier pages write slower (A/B: the direct planner assigned 7-8 files
    // where the agent assigns 6), so clamp instead of rejecting: keep the
    // first six paths, which the prompt orders by relevance.
    if (filePaths.length > FAST_STRUCTURE_MAX_FILES_PER_PAGE) {
      page.filePaths = filePaths.slice(0, FAST_STRUCTURE_MAX_FILES_PER_PAGE);
    }
  }
  if (style === "documentation") {
    if (documentationStructureQualityIssue(structure, { pageCount, pageCountMode })) return false;
  }
  return true;
}

/**
 * B7: build the fast-depth wiki structure from ONE direct LLM call over kb
 * evidence instead of the structure agent. Gathers the evidence in one
 * bounded fan-out (memoized get_architecture, file inventory, README head,
 * first manifest head), renders the agent's exact structure-XML contract via
 * buildStructurePrompt, runs the direct call within an env-tunable budget,
 * then parses with the same parser and validates page count plus every page
 * filePath against the kb-verified inventory. Resolves null on ANY miss so
 * the caller runs the normal structure agent unchanged (the fallback is the
 * quality guarantee). Never throws.
 */
export async function structureFromCodeKb(
  ref: RepoRef,
  session: CodeKbSession,
  opts: {
    depth: WikiDepth;
    pageCount: number;
    pageCountMode: WikiPageCountMode;
    style: WikiStyle;
    stylePrompt?: string;
    languages: WikiLanguage[];
    knowledgeProfile: KnowledgeProfile;
    localCli?: LocalCliConfig | unknown;
    codeKb?: WikiCodeKbOptions;
    signal?: AbortSignal;
  },
): Promise<WikiStructure | null> {
  // All depths take the direct path (Docs submits 30 pages = deep, and the
  // structure phase grows with depth, so the win does too). Validation plus
  // the unconditional agent fallback bound the quality risk identically at
  // every depth.
  if (!fastStructureEnabled()) return null;
  const codeKb = opts.codeKb ?? {};
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(opts.signal?.reason ?? USER_STOP_MESSAGE);
  };
  if (opts.signal?.aborted) return null;
  opts.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const query = codeKb.query ?? queryCodeKb;
    const readFile = codeKb.readFile ?? readCodeKbFile;
    const sourceScope = normalizeCodeKbSourcePath(ref.sourcePath);
    const readmePath = codeKbPathForSource("README.md", sourceScope);
    const manifestCandidates = FAST_STRUCTURE_MANIFEST_CANDIDATES.map((path) =>
      codeKbPathForSource(path, sourceScope)
    );
    const tasks: Array<() => Promise<unknown | null>> = [
      () => query(session, "search_graph", { label: "File", limit: FAST_STRUCTURE_FILE_INVENTORY_LIMIT }),
      () => sourceScope ? Promise.resolve(null) : query(session, "get_architecture", {}),
      () => readFile(session, readmePath, { startLine: 1, endLine: FAST_STRUCTURE_README_HEAD_LINES }),
      ...manifestCandidates.map(
        (path) => () => readFile(session, path, { startLine: 1, endLine: FAST_STRUCTURE_MANIFEST_HEAD_LINES }),
      ),
    ];
    const settled = await raceWithAbortSignal(
      raceWithBudget(
        mapWithConcurrency(tasks, CODE_KB_EVIDENCE_MAX_IN_FLIGHT, (task) => task().catch(() => null)),
        codeKb.budgetMs ?? WIKI_CODE_KB_BUDGET_MS,
      ),
      opts.signal,
    );
    if (!settled) return null;
    const [fileInventory, architecture, readmeHead, ...manifests] = settled;
    const inventoryPaths = codeKbFileInventoryPaths(fileInventory).filter((path) =>
      codeKbPathWithinSource(path, sourceScope)
    );
    // Without an inventory the filePath validation is impossible; run the agent.
    if (inventoryPaths.length === 0) return null;
    const readmeContent = codeKbFileContent(readmeHead ?? null);
    const hasReadme = typeof readmeContent === "string" && readmeContent.trim() !== "";
    const manifestIndex = manifests.findIndex((result) => {
      const content = codeKbFileContent(result ?? null);
      return typeof content === "string" && content.trim() !== "";
    });
    const manifestPath = manifestIndex >= 0 ? manifestCandidates[manifestIndex]! : null;
    // The file endpoint verified these exist in the snapshot even when the
    // graph's File nodes omit non-code files, so pages may cite them too.
    const validPaths = new Set(inventoryPaths);
    if (hasReadme) validPaths.add(readmePath);
    if (manifestPath) validPaths.add(manifestPath);

    const evidence = renderDirectStructureEvidence({
      fileInventoryPaths: Array.from(validPaths),
      architecture: architecture ?? undefined,
      readmeHead: readmeHead ?? undefined,
      ...(manifestPath ? { manifestHead: { path: manifestPath, content: manifests[manifestIndex] } } : {}),
    });
    if (!evidence) return null;

    const prompt = buildStructurePrompt({
      owner: ref.owner,
      repo: ref.repo,
      sourcePath: ref.sourcePath,
      runtime: "local-cli",
      depth: opts.depth,
      pageCount: opts.pageCount,
      pageCountMode: opts.pageCountMode,
      style: opts.style,
      stylePrompt: opts.stylePrompt,
      languages: opts.languages,
      knowledgeProfile: opts.knowledgeProfile,
      directEvidence: evidence,
    });

    if (opts.signal?.aborted) return null;
    const timeoutMs = envPositiveInt(
      "RLM_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS",
      fastStructureTimeoutDefaultMs(opts.pageCount),
    );
    const timer = setTimeout(() => controller.abort("fast structure direct call timed out"), timeoutMs);
    const call = codeKb.directCall ?? defaultWikiStructureDirectCall;
    let raw: string | null;
    try {
      // raceWithBudget is the hard bound (a runner that ignores the signal
      // still resolves null at the budget); the abort kills the real CLI.
      raw = await raceWithAbortSignal(
        raceWithBudget(
          Promise.resolve(call(prompt, normalizeLocalCliConfig(opts.localCli), controller.signal)),
          timeoutMs,
        ),
        opts.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!raw) return null;
    const xml = findWikiStructureXml(raw);
    if (!xml) return null;
    const structure = parseWikiStructureXml(xml);
    return validateFastStructure(structure, validPaths, opts.pageCount, opts.pageCountMode, opts.style) ? structure : null;
  } catch {
    return null;
  } finally {
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}

interface QueryAgent {
  query(prompt: string, signal?: AbortSignal): Promise<{
    answer: string;
    sources: string[];
    tokenUsage?: GeneratedPage["tokenUsage"];
  }>;
}

type QueryAgentResult = Awaited<ReturnType<QueryAgent["query"]>>;

export function normalizeWikiGenerationRuntime(value: unknown): AgentRuntime {
  const runtime = normalizeAgentRuntime(value, "local-cli");
  if (runtime !== "local-cli") {
    throw new Error(WIKI_LOCAL_CLI_ONLY_MESSAGE);
  }
  return runtime;
}

function wikiRuntimeModelLabel(localCli?: LocalCliConfig | unknown): string {
  return localCliLabel(normalizeLocalCliConfig(localCli));
}

function createRepoAgent(opts: {
  source: string;
  refs?: WorkspaceRepoRef[];
  branch?: string | null;
  sourcePath?: string | null;
  channel: ProviderModel;
  surface: PromptSurface;
  maxIterations: number;
  maxLLMCalls: number;
  sessionDir: string;
  onEvent: (ev: RLMEvent) => void;
  localCli?: LocalCliConfig | unknown;
}): QueryAgent {
  const workspaceRefs = opts.refs && opts.refs.length > 1 ? opts.refs : null;
  return new LocalCliAgent({
    ...(workspaceRefs
      ? {
          sources: workspaceRefs.map((ref) => ({
            id: ref.id,
            source: ref.url,
            branch: ref.branch,
            sourcePath: ref.sourcePath ?? null,
            label: ref.label,
          })),
          mode: "workspace",
        }
      : {
        source: opts.source,
        branch: opts.branch,
        sourcePath: opts.sourcePath,
      }),
    ...localCliControlsForSurface(opts.channel, { surface: opts.surface }),
    maxIterations: opts.maxIterations,
    maxLLMCalls: opts.maxLLMCalls,
    sessionDir: opts.sessionDir,
    contextLabel: opts.surface,
    localCli: opts.localCli,
    onEvent: opts.onEvent,
  }) as QueryAgent;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-page evidence packs are off by default: the A/B benchmark showed the
 * per-iteration token tax of the injected file heads outweighed the tool-call
 * savings on a local checkout. Opt in with RLM_WIKI_CODE_KB_PAGE_EVIDENCE=1.
 */
function pageEvidenceEnabled(): boolean {
  return process.env.RLM_WIKI_CODE_KB_PAGE_EVIDENCE === "1";
}

function maxPageConcurrencyForLocalCli(localCli?: LocalCliConfig | unknown): number {
  const config = normalizeLocalCliConfig(localCli);
  if (config.agentId === "antigravity") {
    return Math.min(MAX_PAGE_CONCURRENCY, envPositiveInt("RLM_WIKI_ANTIGRAVITY_PAGE_CONCURRENCY", 1));
  }
  return MAX_PAGE_CONCURRENCY;
}

function defaultPageConcurrency(channel: ProviderModel, localCli?: LocalCliConfig | unknown): number {
  const adapterMax = maxPageConcurrencyForLocalCli(localCli);
  if (normalizeLocalCliConfig(localCli).agentId === "antigravity") {
    return adapterMax;
  }
  // Gate on an explicitly provided config, not the normalized agentId: the
  // normalizer falls back to "grok" for undefined input, and provider-channel
  // callers pass no localCli at all.
  if (localCli != null) {
    // Local-CLI page agents are API-stream-bound, not CPU-bound (~2-3% CPU
    // each observed), so a higher default divides the dominant page phase:
    // a 22-page docs run at ~85s/page drops from ~6 waves to ~3. Provider
    // channels below keep the conservative default (rate-limit exposure).
    return envPositiveInt(
      "RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY",
      envPositiveInt("RLM_WIKI_PAGE_CONCURRENCY", DEFAULT_LOCAL_CLI_PAGE_CONCURRENCY),
    );
  }
  const sharedDefault = envPositiveInt("RLM_WIKI_PAGE_CONCURRENCY", DEFAULT_PAGE_CONCURRENCY);
  if (channel.provider === "deepseek") {
    return envPositiveInt("RLM_WIKI_DEEPSEEK_PAGE_CONCURRENCY", sharedDefault);
  }
  return sharedDefault;
}

export function resolveWikiConcurrency(
  channel: ProviderModel,
  requested?: number,
  localCli?: LocalCliConfig | unknown,
): number {
  const adapterMax = maxPageConcurrencyForLocalCli(localCli);
  const raw = Number.isFinite(requested) && requested! > 0
    ? Math.floor(requested!)
    : defaultPageConcurrency(channel, localCli);
  return Math.max(1, Math.min(adapterMax, raw));
}

const MIN_PAGE_CHARS = 400;
const JUNK_PATTERNS = [
  /^writing\s+answer\.?\.?\.?$/i,
  /^see\s+(below|above)\.?$/i,
  /^submitted\.?$/i,
  /^\(submitted\)$/i,
  /^answer\s+written\.?$/i,
];
const LEAKED_REASONING_PATTERNS = [
  /\bNeed see output\?/i,
  /\bWait assistant final\b/i,
  /\bWe need (?:produce|continue|provide|send|actual output)\b/i,
  /\bMaybe I can continue with a code block\b/i,
  /\bLet's issue another js block\b/i,
  /\bthe final (?:message|answer|channel)\b/i,
  /\bno separate user\b/i,
  /\bcode block in (?:assistant|final|commentary)\b/i,
  /\bSUBMIT\(\{?\s*sources\b/i,
];
const DOCS_INVENTORY_TITLE_PATTERN =
  /\b(?:module|package|directory|folder|source)\s+inventory\b|\bsource\s+tree\b|\bfile\s+list\b|\bpackage\s+list\b|\bcodebase\s+inventory\b/i;
const DOCS_PATH_LIKE_TITLE_PATTERN =
  /^(?:src|apps?|packages?|crates?|lib|cmd|internal|codegen)(?:\/[\w.-]+)+\/?$/i;
const DOCS_PATH_LIKE_SECTION_PATTERN =
  /^(?:src|apps?|packages?|crates?|lib|cmd|internal|codegen)(?:\/[\w.-]+)*\/?$/i;
const DOCS_INVENTORY_BODY_PATH_BULLET =
  /^\s*(?:[-*]|\d+\.)\s+(?:`[^`]+`|(?:[\w.-]+\/)+[\w.-]+)\s*$/gm;
const DOCS_PATH_OR_COMMAND_TOKEN =
  /`[^`\n]*(?:\/|\.(?:[A-Za-z0-9]{1,8})\b|::)[^`\n]*`|^\s*(?:\$\s+)?(?:npm|pnpm|bun|yarn|cargo|go|pip|uv|curl|docker|kubectl|grok|claude)\b/im;

function looksLikeJunk(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_PAGE_CHARS) return true;
  for (const pat of JUNK_PATTERNS) {
    if (pat.test(t)) return true;
  }
  return false;
}

function stripDocsFrontmatter(text: string): string {
  return text.trim().replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
}

function docsBodyLooksLikeInventoryOnly(body: string): boolean {
  const lines = body.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const pathBullets = body.match(DOCS_INVENTORY_BODY_PATH_BULLET) || [];
  if (pathBullets.length < 4) return false;
  const nonBullet = lines.filter((line) => !/^(?:[-*]|\d+\.)\s+/.test(line) && !/^#+\s/.test(line));
  // List intros ("Important files:") do not count as explanatory prose.
  const explanatory = nonBullet.filter((line) =>
    line.length > 40 &&
    !/`[^`]+`\s*$/.test(line) &&
    !/:\s*$/.test(line) &&
    !/\b(?:files?|paths?|modules?|packages?|directories|folders)\b/i.test(line)
  );
  return pathBullets.length >= Math.max(4, Math.floor(lines.length * 0.45)) && explanatory.length < 2;
}

function docsTitleLooksLikeInventory(title: string): boolean {
  const t = String(title || "").trim();
  if (!t) return true;
  if (DOCS_INVENTORY_TITLE_PATTERN.test(t)) return true;
  if (DOCS_PATH_LIKE_TITLE_PATTERN.test(t)) return true;
  if (/^(?:src|apps?|packages?|crates?)\/[\w./-]+$/i.test(t)) return true;
  return false;
}

function docsSectionLooksLikeInventory(title: string): boolean {
  const t = String(title || "").trim();
  if (!t) return true;
  if (DOCS_INVENTORY_TITLE_PATTERN.test(t)) return true;
  if (DOCS_PATH_LIKE_SECTION_PATTERN.test(t)) return true;
  if (/^(?:src|apps?|packages?|crates?)\/[\w./-]*$/i.test(t)) return true;
  return false;
}

function normalizeDocsComparableText(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseDocsFrontmatterField(frontmatter: string, field: "title" | "description"): string {
  const match = frontmatter.match(new RegExp(`^\\s*${field}\\s*:\\s*(.*)$`, "im"));
  if (!match) return "";
  let raw = String(match[1] || "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  return raw.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
}

/**
 * Pure documentation-structure quality helper. Returns a human-readable issue
 * string when the planned manifest is inventory-like or not journey-capable.
 * Used by tests and by fast-structure acceptance; non-docs styles ignore it.
 */
export function documentationStructureQualityIssue(
  structure: WikiStructure,
  options: { pageCount?: number; pageCountMode?: WikiPageCountMode | string } = {},
): string | null {
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  const sections = Array.isArray(structure.sections) ? structure.sections : [];
  if (!pages.length) return "the docs structure has no pages";

  for (const page of pages) {
    if (docsTitleLooksLikeInventory(page.title)) {
      return `the docs structure uses an inventory-like page title (${page.title}); prefer one-concern capability or route titles`;
    }
  }
  for (const section of sections) {
    if (docsSectionLooksLikeInventory(section.title)) {
      return `the docs structure uses an inventory-like navigation group (${section.title}); prefer themed journey groups`;
    }
  }

  // Multi-page docs should group routes. Use the actual planned page count only
  // (never the desktop auto ceiling). Tiny/compact manifests may stay in one group.
  if (pages.length >= 8 && sections.length < 2) {
    return "the docs structure needs themed navigation groups (at least 2) for multi-page manifests";
  }

  // Require a real planned overview — never treat an arbitrary pages[0] as the hub.
  // Normalization can still force page-overview id later, which would contaminate
  // hub prompt guidance if the planned page was not an overview.
  const overview =
    pages.find((page) => page.id === OVERVIEW_PAGE_ID) ||
    pages.find((page) => isOverviewPage(page));
  if (!overview) {
    return "the docs structure must include a planned overview/hub page (id page-overview or Overview title)";
  }
  if (pages.length >= 3) {
    const desc = String(overview.description || "").trim();
    if (!desc) {
      return "the docs overview description must orient the reader and name the first planned follow-on path";
    }
    const looksLikeHub =
      /\b(?:route|reader|follow|start|next|path|entry|first|begin|quickstart|install|use|workflow)\b/i.test(desc) ||
      (Array.isArray(overview.relatedPages) && overview.relatedPages.length > 0);
    if (!looksLikeHub) {
      return "the docs overview description must orient the reader and name the first planned follow-on path";
    }
  }

  const seenTitles = new Map<string, string>();
  const seenDescriptions = new Map<string, string>();
  for (const page of pages) {
    const titleKey = normalizeDocsComparableText(page.title);
    if (titleKey) {
      const prior = seenTitles.get(titleKey);
      if (prior) {
        return `the docs structure reuses the page title (${page.title}) on ${prior} and ${page.id}; each route needs a unique one-concern title`;
      }
      seenTitles.set(titleKey, page.id);
    }
    const descKey = normalizeDocsComparableText(page.description);
    if (descKey && descKey.length >= 12) {
      const prior = seenDescriptions.get(descKey);
      if (prior) {
        return `the docs structure reuses the same page description on ${prior} and ${page.id}; give each route a distinct description`;
      }
      seenDescriptions.set(descKey, page.id);
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PRECISE_SOURCE_CITATION_PATTERN = /\[[^\]\n]+:\d+(?:-\d+)?\]\([^)]*\)/g;
const DOCS_READER_OUTCOME_OPENING_PATTERN =
  /\b(?:after\s+(?:reading|finishing|completing|working through)\s+(?:this\s+)?page\b|by\s+the\s+end(?:\s+of)?\s+(?:this\s+)?page\b|you\s+will\s+(?:be\s+able\s+to|learn|know|understand|see)\b|this\s+page\s+(?:explains|covers|describes|documents|walks\s+through|shows)\b|in\s+this\s+page\b)/i;

function countPreciseSourceCitations(text: string): number {
  return (text.match(PRECISE_SOURCE_CITATION_PATTERN) || []).length;
}

function docsOrphanCardHref(text: string, pages: WikiStructure["pages"]): string | null {
  if (!pages.length) return null;
  const allowed = docsAllowedLinkKeys(pages);
  const patterns = [
    /<Card\b[^>]*\bhref=(["'])(.*?)\1[^>]*>/gi,
    /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>/gi,
    /\[[^\]]+\]\(([^)\s]+)\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const href = String(match[2] ?? match[1] ?? "").trim();
      if (!href || isExternalDocsHref(href) || href.startsWith("#")) continue;
      // Ignore pure source-path markdown links that are not docs routes.
      if (!href.startsWith("/") && !/^page-/i.test(href) && !/\.(?:mdx?|html?)(?:#|$)/i.test(href) && !allowed.has(normalizeDocsLinkKey(href))) {
        if (/[./]/.test(href) && !href.includes("page-")) continue;
      }
      const key = normalizeDocsLinkKey(href);
      if (!key) continue;
      if (!allowed.has(key)) return href;
    }
  }
  return null;
}

function docsAllowedLinkKeys(pages: WikiStructure["pages"]): Set<string> {
  const keys = new Set<string>();
  pages.forEach((page) => {
    [
      page.id,
      String(page.id || "").replace(/^page-/i, ""),
      page.title,
      `/${String(page.id || "").replace(/^page-/i, "")}`,
      page.description,
    ].forEach((value) => {
      const key = normalizeDocsLinkKey(value);
      if (key) keys.add(key);
    });
  });
  return keys;
}

function isExternalDocsHref(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href) || /^(?:mailto|tel):/i.test(href);
}

function normalizeDocsLinkKey(value: unknown): string {
  let raw = String(value || "").trim();
  if (!raw) return "";
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.replace(/\\/g, "/").replace(/^https?:\/\/[^/]+/i, "");
  const hashIndex = raw.indexOf("#");
  if (hashIndex === 0) raw = raw.slice(1);
  else if (hashIndex > 0) raw = raw.slice(0, hashIndex);
  raw = raw
    .replace(/[?].*$/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/index(?:\.(?:mdx?|html?))?$/i, "")
    .replace(/\.(?:mdx?|html?)$/i, "")
    .replace(/\/+$/, "");
  return raw
    .replace(/^page-/i, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function wikiPageQualityIssue(
  text: string,
  page: WikiStructure["pages"][number],
  languages: WikiLanguage[] = ["en"],
  style: WikiStyle = "basic",
  allPages: WikiStructure["pages"] = [],
): string | null {
  const t = text.trim();
  if (looksLikeJunk(t)) return "the page was empty, too short, or placeholder-like";
  if (style === "documentation") {
    if (!/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/.test(t)) {
      return "the docs page did not start with YAML frontmatter";
    }
    const frontmatter = t.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1] || "";
    if (!/^\s*title\s*:/m.test(frontmatter) || !/^\s*description\s*:/m.test(frontmatter)) {
      return "the docs page frontmatter must include title and description";
    }
    const fmTitle = parseDocsFrontmatterField(frontmatter, "title");
    const fmDescription = parseDocsFrontmatterField(frontmatter, "description");
    if (normalizeDocsComparableText(fmTitle) !== normalizeDocsComparableText(page.title)) {
      return `the docs page frontmatter title must match the planned page title (${page.title})`;
    }
    if (normalizeDocsComparableText(fmDescription) !== normalizeDocsComparableText(page.description)) {
      return `the docs page frontmatter description must match the planned page description (${page.description})`;
    }
    const body = stripDocsFrontmatter(t);
    // Inventory-only is a structure defect even when short, so flag it before the body floor.
    if (docsBodyLooksLikeInventoryOnly(body)) {
      return "the docs page looks like a path inventory; explain behavior, ownership, and usage instead of listing files";
    }
    if (body.trim().length < DOCS_MIN_BODY_CHARS) {
      return "the docs page body was too thin; add substantive source-backed explanation without padding or decorative components";
    }
    if (/^\s*#\s+\S/m.test(body.slice(0, 2000))) {
      return "the docs page included a duplicate level-1 heading; frontmatter supplies the visible title";
    }
    if (/<details\b[\s\S]{0,800}<summary>[^<]*(?:source|file|evidence)[^<]*<\/summary>/i.test(body)) {
      return "the docs page included a visible source-file details block";
    }
    if (/^Sources\s*:/im.test(body) || countPreciseSourceCitations(body) > 0) {
      return "the docs page included visible source citations; documentation pages should keep evidence out of the body";
    }
    const openingSection = body.trimStart().split(/\n##\s+/)[0]?.slice(0, 1400) || "";
    if (DOCS_READER_OUTCOME_OPENING_PATTERN.test(openingSection)) {
      return "the docs page opened with reader-outcome or tutorial framing; start with implementation facts instead";
    }
    const presentationIssue = documentationPresentationQualityIssue(body);
    if (presentationIssue) return presentationIssue;
    const headingCount = (body.match(/^\s*##\s+\S/gm) || []).length;
    const hasConcreteSurface =
      DOCS_PATH_OR_COMMAND_TOKEN.test(body) || /```/.test(body) || /^\s*\|.+\|/m.test(body);
    if (headingCount < 2 || !hasConcreteSurface) {
      return "the docs page lacks a usable reading path (need at least two ## sections and a concrete path, command, code fence, or table)";
    }
    const orphanCardHref = docsOrphanCardHref(body, allPages);
    if (orphanCardHref) {
      return `the docs page linked a Card to an unplanned page route (${orphanCardHref}); use only planned docs pages`;
    }
    if (looksLikeLeakedReasoning(t)) {
      return "the page appears to contain leaked model reasoning or sandbox final-answer instructions";
    }
    return null;
  }
  const scaffold = wikiSourceScaffold(languages);
  const sourceBlockPattern = new RegExp(`^<details>\\s*<summary>${escapeRegExp(scaffold.summary)}<\\/summary>`, "i");
  if (!sourceBlockPattern.test(t)) {
    return `the page did not start with the required "${scaffold.summary}" details block`;
  }
  const normalizedLanguages = normalizeWikiLanguages(languages);
  const headingPattern = normalizedLanguages[0] === "en"
    ? new RegExp(`(^|\\n)#\\s+${escapeRegExp(page.title)}\\s*(\\n|$)`, "i")
    : /(^|\n)#\s+\S.*(\n|$)/;
  if (!headingPattern.test(t.slice(0, 2500))) {
    return normalizedLanguages[0] === "en"
      ? `the page did not include the required "# ${page.title}" heading near the top`
      : "the page did not include a translated level-1 heading near the top";
  }
  if (looksLikeLeakedReasoning(t)) {
    return "the page appears to contain leaked model reasoning or sandbox final-answer instructions";
  }
  const expectedCitations = Math.min(3, Math.max(1, page.filePaths.length));
  if (countPreciseSourceCitations(t) < expectedCitations) {
    return `the page included too few precise line citations; include at least ${expectedCitations} citations like Sources: [path/to/file.ts:12-40]() outside the opening source list`;
  }
  return null;
}

function compactGenerationError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

export function friendlyWikiGenerationError(value: unknown): string {
  const message = compactGenerationError(value);
  if (/timed out/i.test(message)) {
    return "The agent timed out before finishing. Recover this page when your connection or runtime is steadier.";
  }
  if (/(?:http error:\s*)?503|service unavailable|failed to connect to websocket/i.test(message)) {
    return "The agent service was temporarily unavailable. Recover this page after the connection settles.";
  }
  if (/quota|rate limit|429|usage limit/i.test(message)) {
    return "The selected provider or account hit a usage limit. Recover this page after quota is available.";
  }
  if (/thread .*not found|session .*not found|failed to record rollout/i.test(message)) {
    return "The local agent lost its session state. Recover this page to continue from the saved wiki outline.";
  }
  if (/\bunknown model(?: id)?\b|\bmodel(?: id)?\b[^.]{0,120}\b(?:not found|not available|unavailable|unsupported|does not exist)\b/i.test(message)) {
    return "The selected local model is unavailable. Choose another model, then recover this page.";
  }
  if (/local CLI runtime failed|exited with \d+|reading prompt from stdin/i.test(message)) {
    return "The local agent stopped before returning a wiki page. Recover this page when the runtime is ready.";
  }
  return "The agent stopped before returning a valid wiki page. Recover this page to try again.";
}

function friendlyWikiGenerationIssue(issue: string): string {
  const localCliPrefix = "the local CLI runtime failed:";
  return issue.toLowerCase().startsWith(localCliPrefix)
    ? friendlyWikiGenerationError(issue.slice(localCliPrefix.length).trim())
    : issue;
}

/** Exported for HTML artifact quality gates (format-agnostic leak detection). */
export function looksLikeLeakedReasoning(text: string): boolean {
  const firstChunk = text.slice(0, 3000);
  if (LEAKED_REASONING_PATTERNS.some((pattern) => pattern.test(firstChunk))) return true;

  const suspiciousLines = firstChunk
    .split("\n")
    .filter((line) => /^\s*(?:Need|Wait|Maybe|Actually|Since|Let's|We need|I need)\b/i.test(line))
    .length;
  return suspiciousLines >= 3;
}

/**
 * Try to extract a <wiki_structure> XML block from a string. Returns null if
 * nothing resembling a structure XML is present.
 */
function findWikiStructureXml(text: string): string | null {
  if (!text) return null;
  const match = text.match(/<wiki_structure\b[\s\S]*?<\/wiki_structure>/i);
  return match ? match[0] : null;
}

function structureIterationsFor(depth: WikiDepth): number {
  if (depth === "fast") return 12;
  if (depth === "regular") return 20;
  return 35;
}

function pageIterationsFor(depth: WikiDepth): number {
  if (depth === "fast") return 10;
  if (depth === "regular") return 12;
  return 15;
}

async function withAgentTimeout<T>(
  run: (signal: AbortSignal, bumpActivity: () => void) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  opts: {
    totalMs: number;
    totalMessage: string;
    /** Abort when no agent activity (events) is seen for this long. */
    idleMs?: number;
    idleMessage?: string;
  },
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  let timeoutMessage: string | undefined;
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? USER_STOP_MESSAGE);
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const totalTimeout = setTimeout(() => {
    timeoutMessage = opts.totalMessage;
    controller.abort(opts.totalMessage);
  }, opts.totalMs);
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (!opts.idleMs) return;
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      timeoutMessage = opts.idleMessage ?? opts.totalMessage;
      controller.abort(timeoutMessage);
    }, opts.idleMs);
  };
  armIdle();
  const bumpActivity = (): void => {
    if (!controller.signal.aborted) armIdle();
  };
  try {
    return await run(controller.signal, bumpActivity);
  } catch (error) {
    if (timeoutMessage) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(totalTimeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

const OVERVIEW_PAGE_ID = "page-overview";
const OVERVIEW_TITLE = "Overview";
const OVERVIEW_TITLE_PATTERN =
  /^(?:overview|repo overview|repository overview|project overview|system overview|概览|概要|系统概览|總覽|專案總覽|项目概览|개요|visión general|visão geral|vue d'ensemble|überblick|обзор|نظرة عامة|סקירה|ringkasan|gambaran umum)$/i;

function isOverviewPage(page: WikiPage): boolean {
  const id = String(page.id || "").toLowerCase();
  const title = String(page.title || "").trim();
  return id === OVERVIEW_PAGE_ID || /\boverview\b/.test(id) || OVERVIEW_TITLE_PATTERN.test(title);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function overviewFilePathsFrom(pages: WikiPage[]): string[] {
  const preferred = pages.flatMap((page) => page.filePaths || []).filter((filePath) =>
    /(^|\/)(readme|package\.json|pyproject\.toml|cargo\.toml|go\.mod|deno\.json|bunfig\.toml|vite\.config|next\.config|src\/index|src\/main|src\/app)/i.test(filePath),
  );
  const fallback = pages.flatMap((page) => page.filePaths || []);
  return uniqueStrings(preferred.length ? preferred : fallback).slice(0, 8);
}

function replacePageId(values: string[], fromId: string, toId: string): string[] {
  return uniqueStrings(values.map((value) => (value === fromId ? toId : value)));
}

export function ensureOverviewFirstWikiPage(structure: WikiStructure): WikiStructure {
  return ensureOpeningPageFirstWikiStructure(structure);
}

function openingFallbackForStyle(style: WikiStyle): { title: string; description: string } {
  switch (style) {
    case "first-30":
      return {
        title: "Start Here",
        description: "What this repository is, what to read first, and what should make sense in the first 30 minutes.",
      };
    case "eli5":
      return {
        title: "Explain It Simply",
        description: "What this repository does in plain language, the simplest useful analogy, and what to remember.",
      };
    case "mental-model":
      return {
        title: "The Mental Model",
        description: "The simplest useful model of the system, its main flows, boundaries, and invariants.",
      };
    case "socratic-exploration":
      return {
        title: "The First Question",
        description: "The first-principles question that unlocks the repository and the evidence that answers it.",
      };
    case "feature-scout":
      return {
        title: "Feature Scout Brief",
        description: "The features worth exploring first and why they deserve attention beyond the README.",
      };
    case "worth-stealing":
      return {
        title: "What Is Worth Stealing",
        description: "The strongest reusable moves, why they work, and what a naive clone would miss.",
      };
    case "hidden-quirks":
      return {
        title: "Hidden Quirks Map",
        description: "The non-obvious implementation details, constraints, and edge cases worth studying first.",
      };
    case "pattern-discovery":
      return {
        title: "Pattern Discovery Map",
        description: "The recurring architecture and product patterns that appear across files, subsystems, or repositories.",
      };
    case "repo-comparison":
      return {
        title: "Comparison Frame",
        description: "What is being compared, which criteria matter, and how to read the differences.",
      };
    case "debugging-atlas":
      return {
        title: "Debugging Map",
        description: "The failure surfaces, probes, logs, and recovery paths to understand first.",
      };
    case "tech-reader":
      return {
        title: "Why This Repo Matters",
        description: "The hook, the mechanism underneath it, and what technical readers should notice first.",
      };
    case "technical":
      return {
        title: "Technical Orientation",
        description: "The core entry points, architecture, and how the rest of the developer reference is organized.",
      };
    case "custom":
      return {
        title: "Opening Brief",
        description: "The custom-format opening page that orients the reader to the repository and the rest of the wiki.",
      };
    case "basic":
    default:
      return {
        title: "Repository Guide",
        description: "What this repository is, who it is for, the core entry points, and how the wiki is organized.",
      };
  }
}

export function ensureOpeningPageFirstWikiStructure(
  structure: WikiStructure,
  options: { style?: WikiStyle | string } = {},
): WikiStructure {
  const originalPages = Array.isArray(structure.pages) ? structure.pages : [];
  if (!originalPages.length) return structure;

  const fallbackOpening = openingFallbackForStyle(normalizeWikiStyle(options.style));
  const exactOverviewIndex = originalPages.findIndex((page) => page.id === OVERVIEW_PAGE_ID);
  const overviewIndex = exactOverviewIndex >= 0 ? exactOverviewIndex : originalPages.findIndex(isOverviewPage);
  const openingIndex = overviewIndex >= 0 ? overviewIndex : 0;
  const originalOverview = originalPages[openingIndex] || null;
  const originalOverviewId = originalOverview?.id || OVERVIEW_PAGE_ID;
  const firstSectionId = structure.sections[0]?.id || "section-overview";
  const overviewParentSection = originalOverview?.parentSection || firstSectionId;
  const overviewPage: WikiPage = originalOverview
    ? {
        ...originalOverview,
        id: OVERVIEW_PAGE_ID,
        title: String(originalOverview.title || "").trim() || fallbackOpening.title,
        description: originalOverview.description || fallbackOpening.description,
        importance: originalOverview.importance || "high",
        parentSection: overviewParentSection,
      }
    : {
        id: OVERVIEW_PAGE_ID,
        title: fallbackOpening.title || OVERVIEW_TITLE,
        description: fallbackOpening.description,
        importance: "high",
        filePaths: overviewFilePathsFrom(originalPages),
        relatedPages: originalPages[0]?.id ? [originalPages[0].id] : [],
        parentSection: overviewParentSection,
      };

  const remainingPages = originalPages
    .filter((page, index) => index !== openingIndex && page.id !== OVERVIEW_PAGE_ID)
    .map((page) => ({
      ...page,
      relatedPages: replacePageId(page.relatedPages || [], originalOverviewId, OVERVIEW_PAGE_ID).filter(
        (pageId) => pageId !== page.id,
      ),
    }));
  const pageIdsAfterOverview = new Set([OVERVIEW_PAGE_ID, ...remainingPages.map((page) => page.id)]);
  const relatedPages = replacePageId(overviewPage.relatedPages || [], originalOverviewId, OVERVIEW_PAGE_ID).filter(
    (pageId) => pageId !== OVERVIEW_PAGE_ID && pageIdsAfterOverview.has(pageId),
  );
  const pages = [{ ...overviewPage, relatedPages }, ...remainingPages];

  const existingSections = structure.sections.length
    ? structure.sections.map((section) => ({
        ...section,
        pages: replacePageId(section.pages || [], originalOverviewId, OVERVIEW_PAGE_ID).filter(
          (pageId) => pageId !== OVERVIEW_PAGE_ID && pageIdsAfterOverview.has(pageId),
        ),
      }))
    : [{
        id: overviewParentSection,
        title: OVERVIEW_TITLE,
        pages: [],
        subsections: [],
      }];
  const parentIndex = existingSections.findIndex((section) => section.id === overviewParentSection);
  const sections = parentIndex >= 0
    ? existingSections
    : [{
        id: overviewParentSection,
        title: OVERVIEW_TITLE,
        pages: [],
        subsections: [],
      }, ...existingSections];
  const normalizedParentIndex = Math.max(0, sections.findIndex((section) => section.id === overviewParentSection));
  sections[normalizedParentIndex] = {
    ...sections[normalizedParentIndex]!,
    pages: uniqueStrings([OVERVIEW_PAGE_ID, ...sections[normalizedParentIndex]!.pages]),
  };
  if (normalizedParentIndex > 0) {
    const [parentSection] = sections.splice(normalizedParentIndex, 1);
    sections.unshift(parentSection!);
  }

  return {
    ...structure,
    sections,
    pages,
  };
}

function capWikiStructurePages(structure: WikiStructure, maxPages: number): WikiStructure {
  if (structure.pages.length <= maxPages) return structure;
  const pages = structure.pages.slice(0, maxPages);
  const kept = new Set(pages.map((page) => page.id));
  const sections = structure.sections
    .map((section) => ({
      ...section,
      pages: section.pages.filter((pageId) => kept.has(pageId)),
    }))
    .filter((section) => section.pages.length > 0);
  return {
    ...structure,
    sections,
    pages: pages.map((page) => ({
      ...page,
      relatedPages: page.relatedPages.filter((pageId) => kept.has(pageId)),
    })),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(USER_STOP_MESSAGE, "AbortError");
  }
}

/**
 * Run the structure agent and coerce its output into a WikiStructure.
 *
 * We accept the XML from three places, in order:
 *   1. The agent's submitted `answer` (the happy path — they used <ANSWER>).
 *   2. Anywhere in the trajectory text (reasoning / code / output).
 *      Some models emit valid XML inline but forget the <ANSWER> wrapper.
 *   3. If neither works, retry once with a fresh agent and a stricter
 *      prompt that demands the <ANSWER> wrapper.
 */
async function runStructureAgent(args: {
  ref: RepoRef;
  refs?: WorkspaceRepoRef[];
  channel: ProviderModel;
  sessionDir: string;
  maxIterations: number;
  onEvent: (ev: RLMEvent) => void;
  runtime: AgentRuntime;
  depth: WikiDepth;
  pageCount: number;
  pageCountMode: WikiPageCountMode;
  style: WikiStyle;
  stylePrompt?: string;
  languages: WikiLanguage[];
  knowledgeProfile: KnowledgeProfile;
  localCli?: LocalCliConfig | unknown;
  codeKb?: string;
  signal?: AbortSignal;
  /** Prior docs-structure quality rejection to feed into a replan attempt. */
  qualityIssue?: string;
}): Promise<WikiStructure> {
  const { ref, refs, channel, sessionDir, maxIterations, onEvent, runtime, depth, pageCount, pageCountMode, style, stylePrompt, languages, knowledgeProfile, localCli, codeKb, signal, qualityIssue } = args;
  const basePrompt = preludeForRuntime(channel.id, depth, runtime) + buildStructurePrompt({ owner: ref.owner, repo: ref.repo, sourcePath: ref.sourcePath, repos: refs, runtime, depth, pageCount, pageCountMode, style, stylePrompt, languages, knowledgeProfile, codeKb });
  const prompt = qualityIssue
    ? `${basePrompt}\n\n---\n⚠️ A previous docs structure plan was rejected because ${qualityIssue}.\n\nEmit a complete replacement <wiki_structure> that fixes that defect. Keep adaptive journey-ordered themed groups, one-concern titles, a real page-overview orientation that names the first useful path, and no inventory titles or duplicate route titles/descriptions.\n`
    : basePrompt;

  // Accumulate every event's text so we can recover the XML even if the agent
  // omitted the <ANSWER> tag.
  const trajectoryChunks: string[] = [];
  const trackedOnEvent = (ev: RLMEvent): void => {
    if (ev.type === "step") {
      if (ev.reasoning) trajectoryChunks.push(ev.reasoning);
      if (ev.code) trajectoryChunks.push(ev.code);
      if (ev.output) trajectoryChunks.push(ev.output);
    } else if (ev.type === "submit") {
      if (ev.answer) trajectoryChunks.push(ev.answer);
    }
    onEvent(ev);
  };

  const agent = createRepoAgent({
    source: ref.url,
    refs,
    branch: ref.branch,
    sourcePath: ref.sourcePath,
    channel,
    surface: "wiki-structure",
    maxIterations,
    maxLLMCalls: 200,
    sessionDir,
    onEvent: trackedOnEvent,
    localCli,
  });

  throwIfAborted(signal);
  const result = await agent.query(prompt, signal);

  // Priority 1: the answer itself.
  let xml = findWikiStructureXml(result.answer ?? "");
  // Priority 2: anywhere in the trajectory (catches Kimi's "forgot ANSWER" case).
  if (!xml) {
    const hay = trajectoryChunks.join("\n");
    xml = findWikiStructureXml(hay);
    if (xml) {
      // eslint-disable-next-line no-console
      console.warn(
        `[generator] Structure agent did not wrap XML in <ANSWER>. Recovered from trajectory (${xml.length} chars).`,
      );
    }
  }
  if (xml) {
    return parseWikiStructureXml(xml);
  }

  // Priority 3: one retry with a fresh agent and a sharper prompt.
  // eslint-disable-next-line no-console
  console.warn(
    `[generator] Structure agent (${channel.id}) returned no parseable <wiki_structure>. Retrying once with a stricter prompt.`,
  );
  const retryChunks: string[] = [];
  const retryAgent = createRepoAgent({
    source: ref.url,
    refs,
    branch: ref.branch,
    sourcePath: ref.sourcePath,
    channel,
    surface: "wiki-structure",
    maxIterations,
    maxLLMCalls: 200,
    sessionDir,
    localCli,
    onEvent: (ev: RLMEvent) => {
      if (ev.type === "step") {
        if (ev.reasoning) retryChunks.push(ev.reasoning);
        if (ev.code) retryChunks.push(ev.code);
        if (ev.output) retryChunks.push(ev.output);
      } else if (ev.type === "submit") {
        if (ev.answer) retryChunks.push(ev.answer);
      }
      onEvent(ev);
    },
  });
  const retryPrompt =
    prompt +
    `

---

⚠️ A previous attempt by this agent failed: it did not emit the full <wiki_structure> XML inside <ANSWER>...</ANSWER> tags.

**You MUST emit the complete <wiki_structure> XML document between <ANSWER>...</ANSWER> tags in your FINAL message.** Without the <ANSWER> wrapper, your output will be rejected and the pipeline will fail.

Template for your final message (fill in the XML):

<ANSWER>
<wiki_structure>
  <title>...</title>
  <description>...</description>
  <sections>...</sections>
  <pages>...</pages>
</wiki_structure>
</ANSWER>`;

  throwIfAborted(signal);
  const retry = await retryAgent.query(retryPrompt, signal);
  let retryXml = findWikiStructureXml(retry.answer ?? "");
  if (!retryXml) {
    retryXml = findWikiStructureXml(retryChunks.join("\n"));
  }
  if (retryXml) {
    return parseWikiStructureXml(retryXml);
  }

  const snippet = (result.answer || trajectoryChunks.slice(-2).join("\n") || "(empty)").slice(0, 800);
  throw new Error(
    `Structure agent (${channel.id}) did not produce <wiki_structure> XML after two attempts. Last output:\n${snippet}`,
  );
}

async function runPageAgent(args: {
  ref: RepoRef;
  refs?: WorkspaceRepoRef[];
  page: WikiStructure["pages"][number];
  pages?: WikiStructure["pages"];
  channel: ProviderModel;
  sessionDir: string;
  maxIterations: number;
  onEvent: (ev: RLMEvent) => void;
  repairInstruction?: string;
  currentContent?: string;
  runtime: AgentRuntime;
  depth: WikiDepth;
  style: WikiStyle;
  stylePrompt?: string;
  languages: WikiLanguage[];
  knowledgeProfile: KnowledgeProfile;
  localCli?: LocalCliConfig | unknown;
  codeKb?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; tokenUsage?: GeneratedPage["tokenUsage"] }> {
  const { ref, refs, page, pages = [], channel, sessionDir, maxIterations, onEvent, repairInstruction, currentContent, runtime, depth, style, stylePrompt, languages, knowledgeProfile, localCli, codeKb, signal } = args;

  const agent = createRepoAgent({
    source: ref.url,
    refs,
    branch: ref.branch,
    sourcePath: ref.sourcePath,
    channel,
    surface: "wiki-page",
    maxIterations,
    maxLLMCalls: 200,
    sessionDir,
    onEvent,
    localCli,
  });

  const prompt = preludeForRuntime(channel.id, depth, runtime) + buildPagePrompt({
    owner: ref.owner,
    repo: ref.repo,
    sourcePath: ref.sourcePath,
    repos: refs,
    page,
    allPages: pages,
    repairInstruction,
    currentContent,
    runtime,
    depth,
    style,
    stylePrompt,
    languages,
    knowledgeProfile,
    codeKb,
  });
  throwIfAborted(signal);
  let first: QueryAgentResult | null = null;
  let firstError: string | null = null;
  try {
    first = await agent.query(prompt, signal);
  } catch (error) {
    throwIfAborted(signal);
    firstError = compactGenerationError(error);
  }
  const firstText = (first?.answer ?? "").trim();
  const firstUsage = first?.tokenUsage
    ? {
        promptTokens: first.tokenUsage.promptTokens,
        completionTokens: first.tokenUsage.completionTokens,
        totalTokens: first.tokenUsage.totalTokens,
      }
    : undefined;

  const firstIssue = firstError
    ? `the local CLI runtime failed: ${firstError}`
    : wikiPageQualityIssue(firstText, page, languages, style, pages);
  if (!firstIssue) {
    return { text: firstText, tokenUsage: firstUsage };
  }

  // Retry once with a stricter follow-up. A fresh agent because we don't want
  // the prior short answer in its history nudging it back to the same behaviour.
  const retryAgent = createRepoAgent({
    source: ref.url,
    refs,
    branch: ref.branch,
    sourcePath: ref.sourcePath,
    channel,
    surface: "wiki-page",
    maxIterations,
    maxLLMCalls: 200,
    sessionDir,
    onEvent,
    localCli,
  });
  const languageGuidance = wikiLanguagePrompt(languages);
  const sourceScaffold = wikiSourceScaffold(languages);
  const expectedCitations = Math.min(3, Math.max(1, page.filePaths.length));
  const retryPrompt =
    prompt +
    (style === "documentation"
      ? `\n\n---\n⚠️ A previous attempt was rejected because ${firstIssue}.\n\nThis is a critical docs-page contract failure. Your next final answer MUST contain a complete replacement MDX page, not analysis about how to answer.\n\nOutput language requirement:\n${languageGuidance}\n\nRequired final shape:\n<ANSWER>\n---\ntitle: "${page.title.replace(/"/g, '\\"')}"\ndescription: "${page.description.replace(/"/g, '\\"')}"\n---\n\nStart with plain orientation prose, then use focused ## sections in a progressive reading order. Keep core information visible, place components beside the prose they support, and do not stack different rich component families without an explanatory paragraph.\n</ANSWER>\n\nDo not open with reader-outcome or tutorial framing such as \"After reading this page\", \"By the end\", \"You will learn\", \"This page explains\", or \"This page covers\". Do not add a duplicate # heading, source-file details block, Source evidence section, visible Sources: lines, line-number citations, JavaScript, SUBMIT calls, private reasoning, planning notes, sandbox instructions, \"Need see output\", \"Wait assistant\", or discussion about final/code/commentary channels. Do not submit until the <ANSWER> block contains at least ${DOCS_MIN_BODY_CHARS} characters of real docs MDX.`
      : `\n\n---\n⚠️ A previous attempt was rejected because ${firstIssue}.\n\nThis is a critical wiki-page contract failure. Your next final answer MUST contain a complete replacement page, not analysis about how to answer.\n\nOutput language requirement:\n${languageGuidance}\n\nRequired final shape:\n<ANSWER>\n<details>\n<summary>${sourceScaffold.summary}</summary>\n${sourceScaffold.intro}\n- [path/to/file.ext](path/to/file.ext)\n</details>\n\n# ${page.title}\n\nTranslate the heading above if it is not already in the selected output language, then write the complete grounded wiki page in the selected output language. Include at least ${expectedCitations} precise body citations like Sources: [path/to/file.ts:12-40](). The opening source-file list does not count. Verify cited line ranges before using them.\n</ANSWER>\n\nDo not emit JavaScript, SUBMIT calls, or any legacy sandbox wrapper. Do not include private reasoning, planning notes, sandbox instructions, \"Need see output\", \"Wait assistant\", or discussion about final/code/commentary channels in the page. Do not submit until the <ANSWER> block contains at least ${MIN_PAGE_CHARS} characters of real wiki markdown.`);
  throwIfAborted(signal);
  let retry: QueryAgentResult | null = null;
  let retryError: string | null = null;
  try {
    retry = await retryAgent.query(retryPrompt, signal);
  } catch (error) {
    throwIfAborted(signal);
    retryError = compactGenerationError(error);
  }
  const retryText = (retry?.answer ?? "").trim();
  const combinedUsage: GeneratedPage["tokenUsage"] | undefined =
    firstUsage && retry?.tokenUsage
      ? {
          promptTokens: firstUsage.promptTokens + retry.tokenUsage.promptTokens,
          completionTokens: firstUsage.completionTokens + retry.tokenUsage.completionTokens,
          totalTokens: firstUsage.totalTokens + retry.tokenUsage.totalTokens,
        }
      : firstUsage ?? (retry?.tokenUsage
          ? {
              promptTokens: retry.tokenUsage.promptTokens,
              completionTokens: retry.tokenUsage.completionTokens,
              totalTokens: retry.tokenUsage.totalTokens,
            }
          : undefined);

  const retryIssue = retryError
    ? `the local CLI runtime failed: ${retryError}`
    : wikiPageQualityIssue(retryText, page, languages, style, pages);
  if (!retryIssue) {
    return { text: retryText, tokenUsage: combinedUsage };
  }
  if (style === "documentation") {
    throw new Error(`Docs page generation failed validation after retry. First failure: ${firstIssue}. Retry failure: ${retryIssue}.`);
  }
  if (firstError && retryError) {
    throw new Error(`Page generation failed after retry. First failure: ${firstIssue}. Retry failure: ${retryIssue}.`);
  }
  // Even the retry failed. Surface the best text we have with a warning banner.
  const best = retryText.length >= firstText.length ? retryText : firstText;
  return {
    text: `> ⚠️ The agent returned an invalid wiki page. This page needs recovery.\n>\n> First failure: ${friendlyWikiGenerationIssue(firstIssue)}\n> Retry failure: ${friendlyWikiGenerationIssue(retryIssue)}\n\n${best || "(empty)"}`,
    tokenUsage: combinedUsage,
  };
}

function directAnswerText(raw: string): string {
  const answer = raw.match(/<ANSWER>\s*([\s\S]*?)\s*<\/ANSWER>/i)?.[1];
  return (answer ?? raw).trim();
}

type DirectPageAttempt =
  | { state: "success"; content: { text: string; tokenUsage?: GeneratedPage["tokenUsage"] }; durationMs: number }
  | { state: "fallback" | "timeout"; durationMs: number; reason: string };

function compactDirectPageReason(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason || "direct page unavailable");
  return text.replace(/\s+/g, " ").trim().slice(0, 110) || "direct page unavailable";
}

function reportDirectPageResult(
  callback: WikiCodeKbOptions["onDirectPageResult"],
  result: WikiDirectPageResult,
): void {
  if (!callback) return;
  try {
    Promise.resolve(callback(result)).catch(() => {});
  } catch {
    // Metrics are observational and must never alter generation behavior.
  }
}

async function runDirectPageWriter(args: {
  ref: RepoRef;
  page: WikiStructure["pages"][number];
  pages: WikiStructure["pages"];
  runtime: AgentRuntime;
  depth: WikiDepth;
  style: WikiStyle;
  stylePrompt?: string;
  languages: WikiLanguage[];
  knowledgeProfile: KnowledgeProfile;
  localCli?: LocalCliConfig | unknown;
  directEvidence: string;
  codeKb?: WikiCodeKbOptions;
  signal?: AbortSignal;
}): Promise<DirectPageAttempt> {
  const startedAt = Date.now();
  const prompt = buildPagePrompt({
    owner: args.ref.owner,
    repo: args.ref.repo,
    sourcePath: args.ref.sourcePath,
    page: args.page,
    allPages: args.pages,
    runtime: args.runtime,
    depth: args.depth,
    style: args.style,
    stylePrompt: args.stylePrompt,
    languages: args.languages,
    knowledgeProfile: args.knowledgeProfile,
    directEvidence: args.directEvidence,
  });
  throwIfAborted(args.signal);
  const call = args.codeKb?.directPageCall ?? defaultWikiPageDirectCall;
  const controller = new AbortController();
  let rejectPendingCall: ((reason?: unknown) => void) | null = null;
  const onParentAbort = (): void => {
    controller.abort(args.signal?.reason ?? USER_STOP_MESSAGE);
    rejectPendingCall?.(new Error(USER_STOP_MESSAGE));
  };
  args.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timeoutMs = envPositiveInt(
    "RLM_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS",
    fastPageTimeoutDefaultMs(args.style),
  );
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      rejectPendingCall = reject;
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort("direct page timed out");
        resolve("");
      }, timeoutMs);
      Promise.resolve(call(prompt, normalizeLocalCliConfig(args.localCli), controller.signal)).then(resolve, reject);
    });
  } catch (error) {
    throwIfAborted(args.signal);
    return {
      state: timedOut ? "timeout" : "fallback",
      durationMs: Date.now() - startedAt,
      reason: compactDirectPageReason(error),
    };
  } finally {
    rejectPendingCall = null;
    if (timer) clearTimeout(timer);
    args.signal?.removeEventListener("abort", onParentAbort);
  }
  throwIfAborted(args.signal);
  if (timedOut) {
    return {
      state: "timeout",
      durationMs: Date.now() - startedAt,
      reason: `direct page timed out after ${timeoutMs}ms`,
    };
  }
  const text = directAnswerText(raw);
  const issue = wikiPageQualityIssue(text, args.page, args.languages, args.style, args.pages);
  if (issue) {
    return { state: "fallback", durationMs: Date.now() - startedAt, reason: compactDirectPageReason(issue) };
  }
  return { state: "success", content: { text }, durationMs: Date.now() - startedAt };
}

export async function regenerateWikiPage(
  record: WikiRecord,
  pageId: string,
  opts: {
    channel?: string;
    model?: string;
    instruction?: string;
    store?: WikiStore;
    onEvent?: (ev: RLMEvent) => void;
    maxPageIterations?: number;
    runtime?: AgentRuntime | string;
    localCli?: LocalCliConfig | unknown;
    providerSecrets?: ProviderSecrets;
    stylePrompt?: string;
    stylePromptOverride?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<GeneratedPage> {
  const page = record.structure.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`Wiki page not found: ${pageId}`);

  const channel = resolveChannel(opts.channel ?? opts.model ?? record.pageModel ?? record.model);
  const runtime = normalizeWikiGenerationRuntime(opts.runtime);
  const depth = normalizeWikiDepth(record.wikiDepth);
  const recordStyle = normalizeWikiStyle(record.wikiStyle);
  const hasStylePromptOverride = opts.stylePromptOverride === true;
  const style: WikiStyle = hasStylePromptOverride ? "custom" : recordStyle;
  const stylePrompt = hasStylePromptOverride
    ? normalizeWikiStylePrompt(opts.stylePrompt)
    : recordStyle === "custom"
      ? normalizeWikiStylePrompt(record.wikiStylePrompt)
      : "";
  const languages = normalizeWikiLanguages(record.wikiLanguages);
  const knowledgeProfile = normalizeKnowledgeProfile(record.knowledgeProfile);
  const store = opts.store ?? new WikiStore();
    const ref: RepoRef = {
      owner: record.owner,
      repo: record.repo,
      url: record.repoUrl,
      branch: record.branch,
      sourcePath: record.sourcePath ?? null,
    };
  const refs = record.repos;

  const content = await runPageAgent({
    ref,
    refs,
    page,
    pages: record.structure?.pages || [],
    channel,
    sessionDir: store.sessionsDir,
    maxIterations: opts.maxPageIterations ?? pageIterationsFor(depth),
    onEvent: opts.onEvent ?? (() => {}),
    repairInstruction: opts.instruction,
    currentContent: record.pages[pageId]?.content,
    runtime,
    localCli: opts.localCli,
    depth,
    style,
    stylePrompt,
    languages,
    knowledgeProfile,
    signal: opts.signal,
  });

  return {
    id: pageId,
    content: content.text,
    generatedAt: new Date().toISOString(),
    status: "generated",
    ...(hasStylePromptOverride ? { stylePrompt, stylePromptOverride: true } : {}),
    tokenUsage: content.tokenUsage,
  };
}

/**
 * Generate (or re-generate) a wiki for a GitHub repo.
 *
 * Pipeline:
 *   1. Structure agent — explores repo, emits <wiki_structure> XML.
 *   2. Parse XML → WikiStructure.
 *   3. Page agents — N agents in parallel (concurrency-capped), one per page.
 *   4. Save WikiRecord to storage.
 */
export async function generateWiki(
  ref: RepoRef,
  opts: GenerateOptions = {},
): Promise<WikiRecord> {
  throwIfAborted(opts.signal);
  const baseChannelId = opts.channel ?? opts.model;
  const structureChannel = resolveChannel(opts.structureChannel ?? baseChannelId);
  const pageChannel = resolveChannel(opts.pageChannel ?? baseChannelId);
  const runtime = normalizeWikiGenerationRuntime(opts.runtime);
  const requestedPageCount = normalizeWikiPageCount(opts.pageCount, defaultWikiPageCountForDepth(opts.depth));
  const pageCountMode = normalizeWikiPageCountMode(opts.pageCountMode);
  const depth = wikiDepthForPageCount(requestedPageCount);
  const style = normalizeWikiStyle(opts.style);
  const stylePrompt = style === "custom" ? normalizeWikiStylePrompt(opts.stylePrompt) : "";
  const languages = normalizeWikiLanguages(opts.languages);
  const knowledgeProfile = normalizeKnowledgeProfile(opts.knowledgeProfile);
  const concurrency = resolveWikiConcurrency(pageChannel, opts.concurrency, opts.localCli);
  const store = opts.store ?? new WikiStore();
  const emit = opts.onEvent ?? (() => {});
  const sessionDir = store.sessionsDir;
  const refs = opts.refs && opts.refs.length > 1 ? opts.refs : undefined;
  const repoLabel = refs?.length
    ? refs.map((workspaceRef) => workspaceRef.label).join(" + ")
    : `${ref.owner}/${ref.repo}`;
  const structureModelLabel = wikiRuntimeModelLabel(opts.localCli);
  const pageModelLabel = wikiRuntimeModelLabel(opts.localCli);

  emit({
    type: "phase",
    phase: "structure",
    message: `Spawning structure agent for ${repoLabel} via ${structureModelLabel}`,
  });

  // Best-effort: pre-index the repo in the sharenow code-kb and pre-fetch the
  // architecture so the agents can query the code graph. Any failure resolves
  // to null and generation proceeds identically to the no-kb path. The status
  // callback surfaces the code-graph session state (indexing/ready/too-large)
  // as informational events; it never gates generation.
  const codeKbPrompts = await prefetchWikiCodeKbPrompts(ref, opts.codeKb, (state) =>
    emit({ type: "code-graph", state, message: CODE_GRAPH_STATUS_COPY[state] }),
  );
  throwIfAborted(opts.signal);

  // U2 (R3): with a ready session, seed the structure prompt with pre-fetched
  // evidence. An all-fail fetch renders "" and appends nothing, keeping the
  // prompt byte-identical to the pre-evidence output (R8).
  let structureCodeKb = codeKbPrompts?.structureCodeKb;
  if (codeKbPrompts?.session && structureCodeKb) {
    const evidence = await fetchWikiStructureEvidence(codeKbPrompts.session, opts.codeKb);
    if (evidence) structureCodeKb = `${structureCodeKb}\n\n${evidence}`;
    throwIfAborted(opts.signal);
  }

  emit({ type: "structure-start" });
  // The compound knowledge profile asks the structure agent for noticeably more
  // work (page-shape classification, QA framing). When a compound run dies in
  // the structure phase, retry once with the basic profile instead of failing
  // the whole generation; the rest of the run then stays basic for coherence.
  let effectiveKnowledgeProfile = knowledgeProfile;
  const runStructurePhase = (profile: KnowledgeProfile, qualityIssue?: string) => withAgentTimeout(
    (signal, bumpActivity) => runStructureAgent({
      ref,
      refs,
      channel: structureChannel,
      sessionDir,
      maxIterations: opts.maxStructureIterations ?? structureIterationsFor(depth),
      runtime,
      localCli: opts.localCli,
      depth,
      pageCount: requestedPageCount,
      pageCountMode,
      style,
      stylePrompt,
      languages,
      knowledgeProfile: profile,
      codeKb: structureCodeKb,
      signal,
      qualityIssue,
      onEvent: (ev: RLMEvent) => {
        bumpActivity();
        emit({ type: "structure-agent", event: ev });
      },
    }),
    opts.signal,
    {
      totalMs: STRUCTURE_AGENT_TIMEOUT_MS,
      totalMessage: `Structure generation timed out after ${Math.round(STRUCTURE_AGENT_TIMEOUT_MS / 1000)}s`,
      idleMs: STRUCTURE_AGENT_IDLE_TIMEOUT_MS,
      idleMessage:
        `Structure agent stalled (no activity for ${Math.round(STRUCTURE_AGENT_IDLE_TIMEOUT_MS / 1000)}s). ` +
        `Retry the run, or raise RLM_WIKI_STRUCTURE_AGENT_IDLE_TIMEOUT_MS if your runtime pauses longer between steps.`,
    },
  );
  // B7: agentless structure (all depths; Docs submits deep). With a READY kb
  // session, try ONE direct LLM call over pre-fetched kb evidence before
  // spawning the structure agent. Any miss (flag off, workspace run, evidence
  // gap, call failure or timeout, parse or validation failure) resolves null
  // and the agent path below runs exactly as today (R8).
  let structure: WikiStructure | null = null;
  if (!refs && codeKbPrompts?.session && fastStructureEnabled()) {
    emit({ type: "phase", phase: "structure", message: "Planning structure via code graph." });
    structure = await structureFromCodeKb(ref, codeKbPrompts.session, {
      depth,
      pageCount: requestedPageCount,
      pageCountMode,
      style,
      stylePrompt,
      languages,
      knowledgeProfile: effectiveKnowledgeProfile,
      localCli: opts.localCli,
      codeKb: opts.codeKb,
      signal: opts.signal,
    });
    throwIfAborted(opts.signal);
    if (structure) {
      // One synthetic step so the A/B harness iteration counters record the
      // direct call as a single iteration instead of a blank.
      emit({
        type: "structure-agent",
        event: {
          type: "step",
          step: 1,
          maxSteps: 1,
          reasoning: "",
          code: "",
          output: "",
          resultType: "code-kb-direct",
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
        },
      });
    } else {
      emit({ type: "code-graph", state: "skipped", message: CODE_GRAPH_STATUS_COPY.skipped });
      emit({ type: "phase", phase: "structure", message: CODE_GRAPH_STATUS_COPY.skipped });
    }
  }
  if (!structure) {
    try {
      structure = await runStructurePhase(effectiveKnowledgeProfile);
      if (!structure.pages?.length) throw new Error("Structure agent returned zero pages. Aborting.");
    } catch (error) {
      throwIfAborted(opts.signal);
      if (effectiveKnowledgeProfile.mode !== "compound") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      emit({
        type: "phase",
        phase: "structure",
        message: `Compound knowledge run failed (${reason}). Retrying once with the basic profile.`,
      });
      effectiveKnowledgeProfile = normalizeKnowledgeProfile({ mode: "basic" });
      emit({ type: "structure-start" });
      structure = await runStructurePhase(effectiveKnowledgeProfile);
    }
  }
  throwIfAborted(opts.signal);
  // Docs quality on the raw agent/direct structure before overview normalization
  // can invent a hub from the first arbitrary page.
  if (style === "documentation") {
    const docsStructureIssue = documentationStructureQualityIssue(structure, {
      pageCount: requestedPageCount,
      pageCountMode,
    });
    if (docsStructureIssue) {
      emit({
        type: "phase",
        phase: "structure",
        message: `Docs structure quality issue (${docsStructureIssue}). Replanning structure once.`,
      });
      emit({ type: "structure-start" });
      structure = await runStructurePhase(effectiveKnowledgeProfile, docsStructureIssue);
      const retryIssue = documentationStructureQualityIssue(structure, {
        pageCount: requestedPageCount,
        pageCountMode,
      });
      if (retryIssue) {
        throw new Error(`Documentation structure rejected after retry: ${retryIssue}`);
      }
    }
  }
  const cappedStructure = capWikiStructurePages(
    ensureOpeningPageFirstWikiStructure(structure, { style }),
    requestedPageCount,
  );

  if (!cappedStructure.pages.length) {
    throw new Error("Structure agent returned zero pages. Aborting.");
  }
  const pageDepth = pageCountMode === "auto"
    ? wikiDepthForPageCount(cappedStructure.pages.length)
    : depth;
  emit({ type: "structure-done", structure: cappedStructure });

  const directPageSkipReason = opts.preferDirectPages !== true
    ? "direct pages not requested"
    : !fastPagesEnabled()
      ? "direct pages disabled"
      : refs
        ? "workspace generation uses page agents"
        : !codeKbPrompts?.session
          ? "ready code graph session unavailable"
          : null;
  let directPageEvidencePacks = new Map<string, string>();
  if (!directPageSkipReason && codeKbPrompts?.session) {
    directPageEvidencePacks = await fetchWikiDirectPageEvidencePacks(
      codeKbPrompts.session,
      cappedStructure.pages,
      opts.codeKb,
      ref.sourcePath,
      opts.signal,
    );
    throwIfAborted(opts.signal);
  }

  // U2 (R4): pre-fetch the per-page evidence packs from the same snapshot
  // before spawning page agents. Off by default (the A/B benchmark showed the
  // token tax lost to free tool calls on the checkout); opt in with
  // RLM_WIKI_CODE_KB_PAGE_EVIDENCE=1. Best-effort: an empty map leaves every
  // page prompt byte-identical to the pre-evidence output (R8).
  let pageEvidencePacks = new Map<string, string>();
  if (pageEvidenceEnabled() && codeKbPrompts?.session && codeKbPrompts.pageCodeKb) {
    pageEvidencePacks = await fetchWikiPageEvidencePacks(codeKbPrompts.session, cappedStructure.pages, opts.codeKb);
    throwIfAborted(opts.signal);
  }
  const wikiPageCodeKbFor = (pageId: string): string | undefined => {
    const base = codeKbPrompts?.pageCodeKb;
    if (!base) return base;
    const pack = pageEvidencePacks.get(pageId);
    return pack ? `${base}\n\n${pack}` : base;
  };

  emit({
    type: "phase",
    phase: "pages",
    message: `Spawning ${cappedStructure.pages.length} page agents via ${pageModelLabel} (concurrency: ${concurrency})`,
  });

  const pages: Record<string, GeneratedPage> = {};
  const createdAt = new Date().toISOString();
  const record: WikiRecord = {
    id: createWikiId(ref.owner, ref.repo, ref.sourcePath),
    repoUrl: ref.url,
    owner: ref.owner,
    repo: ref.repo,
    ...(refs?.length ? { repos: refs } : {}),
    branch: ref.branch,
    sourcePath: ref.sourcePath ?? null,
    sourceKey: wikiSourceKey(ref, refs),
    variantKey: wikiVariantKey({
      ref,
      refs,
      style,
      stylePrompt,
      pageCount: requestedPageCount,
      pageCountMode,
      languages,
      knowledgeProfile,
    }),
    createdAt,
    updatedAt: createdAt,
    generatedAt: createdAt,
    model: pageChannel.id,
    structureModel: structureChannel.id,
    pageModel: pageChannel.id,
    runtime,
    runtimeModelLabel: pageModelLabel,
    wikiDepth: depth,
    wikiPageCount: requestedPageCount,
    wikiPageCountMode: pageCountMode,
    wikiStyle: style,
    ...(stylePrompt ? { wikiStylePrompt: stylePrompt } : {}),
    wikiLanguages: languages,
    knowledgeProfile,
    structure: cappedStructure,
    pages,
  };
  let checkpointQueue = Promise.resolve();
  const checkpoint = async (phase: "structure" | "page", pageId?: string): Promise<void> => {
    record.generatedAt = new Date().toISOString();
    record.updatedAt = record.generatedAt;
    if (!opts.onCheckpoint) return;
    checkpointQueue = checkpointQueue.then(() => opts.onCheckpoint!(record, { phase, pageId }));
    await checkpointQueue;
  };
  await checkpoint("structure");

  const queue = [...cappedStructure.pages];
  const workers: Promise<void>[] = [];
  const handledDirectPages = new Set<string>();

  const runOne = async (): Promise<void> => {
    while (queue.length) {
      throwIfAborted(opts.signal);
      const page = queue.shift()!;
      emit({ type: "page-start", pageId: page.id, title: page.title });
      try {
        const directEvidence = directPageEvidencePacks.get(page.id);
        let content: { text: string; tokenUsage?: GeneratedPage["tokenUsage"] } | null = null;
        let directPageSucceeded = false;
        if (!handledDirectPages.has(page.id)) {
          handledDirectPages.add(page.id);
          if (directPageSkipReason || !directEvidence) {
            reportDirectPageResult(opts.codeKb?.onDirectPageResult, {
              pageId: page.id,
              state: "fallback",
              attempted: false,
              durationMs: 0,
              reason: directPageSkipReason ?? "complete direct page evidence unavailable",
            });
          } else {
            const directAttempt = await runDirectPageWriter({
              ref,
              page,
              pages: cappedStructure.pages,
              runtime,
              depth: pageDepth,
              style,
              stylePrompt,
              languages,
              knowledgeProfile: effectiveKnowledgeProfile,
              localCli: opts.localCli,
              directEvidence,
              codeKb: opts.codeKb,
              signal: opts.signal,
            });
            reportDirectPageResult(opts.codeKb?.onDirectPageResult, {
              pageId: page.id,
              state: directAttempt.state,
              attempted: true,
              durationMs: directAttempt.durationMs,
              ...(directAttempt.state === "success" ? {} : { reason: directAttempt.reason }),
            });
            if (directAttempt.state === "success") {
              content = directAttempt.content;
              directPageSucceeded = true;
            }
          }
        }
        if (!content) {
          content = await withAgentTimeout(
            (signal, bumpActivity) => runPageAgent({
              ref,
              refs,
              page,
              pages: cappedStructure.pages,
              channel: pageChannel,
              sessionDir,
              maxIterations: opts.maxPageIterations ?? pageIterationsFor(pageDepth),
              runtime,
              localCli: opts.localCli,
              depth: pageDepth,
              style,
              stylePrompt,
              languages,
              knowledgeProfile: effectiveKnowledgeProfile,
              codeKb: wikiPageCodeKbFor(page.id),
              signal,
              onEvent: (ev: RLMEvent) => {
                bumpActivity();
                emit({ type: "page-agent", pageId: page.id, event: ev });
              },
            }),
            opts.signal,
            {
              totalMs: PAGE_AGENT_TIMEOUT_MS,
              totalMessage: `Page generation timed out after ${Math.round(PAGE_AGENT_TIMEOUT_MS / 1000)}s`,
              idleMs: PAGE_AGENT_IDLE_TIMEOUT_MS,
              idleMessage:
                `Page agent stalled (no activity for ${Math.round(PAGE_AGENT_IDLE_TIMEOUT_MS / 1000)}s). ` +
                `Retry the run, or raise RLM_WIKI_PAGE_AGENT_IDLE_TIMEOUT_MS if your runtime pauses longer between steps.`,
            },
          );
        }
        if (directPageSucceeded) {
          emit({
            type: "page-agent",
            pageId: page.id,
            event: {
              type: "step",
              step: 1,
              maxSteps: 1,
              reasoning: "",
              code: "",
              output: "",
              resultType: "code-kb-direct-page",
              tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
            },
          });
        }
        pages[page.id] = {
          id: page.id,
          content: content.text,
          generatedAt: new Date().toISOString(),
          status: "generated",
          tokenUsage: content.tokenUsage,
        };
        await checkpoint("page", page.id);
        emit({
          type: "page-done",
          pageId: page.id,
          content: content.text,
          tokenUsage: content.tokenUsage,
        });
      } catch (e) {
        throwIfAborted(opts.signal);
        const msg = e instanceof Error ? e.message : String(e);
        const displayError = friendlyWikiGenerationError(msg);
        emit({ type: "page-error", pageId: page.id, error: msg, displayError });
        pages[page.id] = {
          id: page.id,
          content: `> ⚠️ Page needs recovery.\n>\n> ${displayError}`,
          generatedAt: new Date().toISOString(),
          status: "failed",
          error: msg,
          displayError,
        };
        await checkpoint("page", page.id);
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, cappedStructure.pages.length); i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  // Auto-recovery rounds. Page failures here are overwhelmingly transient:
  // N concurrent CLI agents compete for local resources and rate limits, and the
  // in-page retry shares the first attempt's timeout budget, so stragglers time
  // out or fail validation. Rerunning just the failed pages on a quieter pass
  // with a fresh timeout is exactly what the manual "Recover" button does, and
  // it usually succeeds. Do those rounds automatically (at most 2, low
  // concurrency) before declaring the wiki partial.
  const autoRecoveryRounds = envPositiveInt("RLM_WIKI_AUTO_RECOVERY_ROUNDS", 2);
  for (let round = 1; round <= autoRecoveryRounds; round++) {
    throwIfAborted(opts.signal);
    const failedPages = cappedStructure.pages.filter((page) => isFailedWikiGeneratedPage(pages[page.id]));
    if (!failedPages.length) break;
    emit({
      type: "phase",
      phase: "pages",
      message: `Auto-recovering ${failedPages.length} failed page${failedPages.length === 1 ? "" : "s"} (round ${round}/${autoRecoveryRounds})`,
    });
    queue.push(...failedPages);
    const recoveryWorkers: Promise<void>[] = [];
    const recoveryConcurrency = Math.max(1, Math.min(2, concurrency, failedPages.length));
    for (let i = 0; i < recoveryConcurrency; i++) {
      recoveryWorkers.push(runOne());
    }
    await Promise.all(recoveryWorkers);
  }

  record.generatedAt = new Date().toISOString();
  record.updatedAt = record.generatedAt;
  store.save(record);
  await checkpointQueue;
  emit({ type: "done", record });
  return record;
}
