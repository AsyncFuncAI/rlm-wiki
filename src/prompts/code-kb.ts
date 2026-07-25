// Pure renderers for the sharenow code-kb prompt material. Zero I/O: callers
// (generateWiki, the /api/ask handler) ensure the session and pre-fetch the
// architecture themselves and pass the results in; these functions only turn
// them into deterministic prompt text. Stable, byte-identical output for the
// same inputs keeps provider prompt caching effective.

import type { CodeKbSession } from "../sharenow-kb-client.ts";

/** Char cap for the serialized architecture summary (KTD-5: ~8k). */
export const CODE_KB_ARCHITECTURE_CHAR_CAP = 8_000;
/** Char cap for the structure evidence body (U2 / KTD-3: ~10k total). */
export const CODE_KB_STRUCTURE_EVIDENCE_CHAR_CAP = 10_000;
/** Char cap for one page's evidence-pack body (U2 / KTD-3: ~5k total). */
export const CODE_KB_PAGE_EVIDENCE_CHAR_CAP = 5_000;
/** Char cap for the ask evidence body (U3 / KTD-3: ~4k total). */
export const CODE_KB_ASK_EVIDENCE_CHAR_CAP = 4_000;

const BLOCK_OPEN = "<code-kb>";
const BLOCK_CLOSE = "</code-kb>";
const TRUNCATION_MARKER = "... [architecture summary truncated]";
// Matches the literal block delimiters (opening and closing, any case) so
// repo-derived text cannot carry a real `</code-kb>` and break out of the block.
const BLOCK_DELIMITER_PATTERN = /<(\/?)code-kb>/gi;

/**
 * Prompt-injection guard: neutralize any literal occurrence of the block
 * delimiters in service- or repo-derived text before it is embedded between
 * the real markers. Angle brackets in those exact sequences are replaced with
 * HTML entities, so the text stays readable but can never close the block.
 */
function neutralizeBlockDelimiters(text: string): string {
  return text.replace(BLOCK_DELIMITER_PATTERN, "&lt;$1code-kb&gt;");
}

/** The renderer only needs the live session coordinates, not the cache/ref fields. */
export type CodeKbPromptSession = Pick<CodeKbSession, "sessionId" | "baseUrl">;

export interface CodeKbBlockArgs {
  session: CodeKbPromptSession;
  /** Raw `get_architecture` query result (object or pre-serialized string). */
  architecture?: unknown;
  /** Include the curl cheat-sheet for the query/file endpoints. Default true. */
  includeToolInstructions?: boolean;
  /**
   * Where the indexed source came from. "local" sessions get one factual
   * sentence noting the repo source was uploaded for indexing. Default "github".
   */
  sourceKind?: "local" | "github";
}

/**
 * Serialize the `get_architecture` result to a deterministic, char-capped
 * string. Returns "" when there is nothing renderable (absent, empty, or
 * unserializable input), which callers treat as "omit the section".
 */
export function renderCodeKbArchitectureSummary(architecture: unknown, cap = CODE_KB_ARCHITECTURE_CHAR_CAP): string {
  if (architecture === undefined || architecture === null) return "";
  let text: string;
  if (typeof architecture === "string") {
    text = architecture.trim();
  } else {
    try {
      text = JSON.stringify(architecture) ?? "";
    } catch {
      return "";
    }
  }
  if (!text) return "";
  // Pre-slice before the regex scan: neutralization only grows text locally
  // and the output keeps at most `cap` chars, so scanning past 2*cap can
  // never change the result. Keeps a multi-MB graph payload off the regex.
  if (text.length > cap * 2) text = text.slice(0, cap * 2);
  text = neutralizeBlockDelimiters(text);
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/**
 * Latency-safe proactive policy: agents should use the live code graph first for
 * structural work, but stop after a few hits so wall-clock stays lower than a
 * multi-step grep/read tour. Copy is shared by Ask, Wiki structure, and page
 * agents (and Docs, which shares the wiki generator).
 */
function renderProactiveUsePolicy(): string {
  return [
    "## Proactive use policy (latency budget)",
    "",
    "Use this code graph as the default first tool for locate, call-graph, and architecture questions. Each successful query is ~0.3s and usually replaces a multi-step local search/read loop, so proactive use improves quality and often reduces total time.",
    "",
    "Budget: at most 4 successful graph queries before you start writing the answer or page. Prefer 1-3 high-signal hits, then synthesize. Do not mine the graph for completeness theater.",
    "",
    "Query proactively when:",
    "- you need where a symbol/config/route lives (search_code, then file or get_code_snippet)",
    "- you need callers, callees, or layering (context, then trace_path only if one hop is not enough)",
    "- the pre-fetched map or evidence leaves a material gap for a claim you will make",
    "- two independent lookups would each take several local tool steps (issue both graph queries before broad reads)",
    "",
    "Do not query when:",
    "- this block already includes the architecture map or pre-fetched evidence that answers the need",
    "- you would repeat the same tool and args",
    "- a targeted local read of a known path is enough to verify a citation",
    "- you already have enough evidence to write; more graph edges will not change the answer",
    "",
    "After each hit, decide write vs one more query. Prefer writing with verified paths over another exploration round. Local rg/grep/find remains the fallback, not the default, while the graph is healthy.",
  ].join("\n");
}

function renderToolInstructions(session: CodeKbPromptSession): string {
  const queryUrl = `${session.baseUrl}/api/v1/kb/${session.sessionId}/query`;
  const fileUrl = `${session.baseUrl}/api/v1/kb/${session.sessionId}/file`;
  const curlQuery = (body: string) =>
    `curl -sS --max-time 8 -X POST ${queryUrl} -H 'content-type: application/json' -d '${body}'`;
  const curlFile = (body: string) =>
    `curl -sS --max-time 8 -X POST ${fileUrl} -H 'content-type: application/json' -d '${body}'`;
  return [
    renderProactiveUsePolicy(),
    "",
    "## Reliable query workflow",
    "",
    "1. Always start with search_code (or use pre-fetched Ask evidence) to locate candidates.",
    "2. Copy a fully qualified_name from the JSON results. Never pass short/ambiguous names to context or get_code_snippet.",
    "3. Call context or get_code_snippet with that FQN. Use trace_path only when you need multi-hop callers/callees (depth 1-2).",
    "4. Read a file slice only for the paths you will cite. Then write.",
    "5. If a query returns ambiguous/too-common errors, narrow the search pattern and try one more time. Do not thrash.",
    "",
    "Shell helper (optional, same session; paste once then call kb_query / kb_file):",
    `kb_query() { curl -sS --max-time 8 -X POST '${queryUrl}' -H 'content-type: application/json' -d "$1"; }`,
    `kb_file() { curl -sS --max-time 8 -X POST '${fileUrl}' -H 'content-type: application/json' -d "$1"; }`,
    `  kb_query '{"tool":"search_code","args":{"pattern":"browser automation"}}'`,
    `  kb_query '{"tool":"context","args":{"qualifiedName":"home-user-repo.src.module.Symbol"}}'`,
    "",
    "## How to query the code graph",
    "",
    `Query endpoint: POST ${queryUrl} with JSON body {"tool": "<tool>", "args": {...}}. Each call returns JSON in ~0.3s. Run curls via shell; do not invent a special tool name.`,
    "",
    "- search_code: first-line locator (substring or regex).",
    `  ${curlQuery('{"tool":"search_code","args":{"pattern":"registerRoute"}}')}`,
    "- context: symbol plus direct callers/callees. Requires a fully qualified_name from search results.",
    `  ${curlQuery('{"tool":"context","args":{"qualifiedName":"module.Symbol"}}')}`,
    "- trace_path: call paths from a function (direction inbound|outbound|both, depth 1-5). Prefer depth 1-2.",
    `  ${curlQuery('{"tool":"trace_path","args":{"functionName":"handleRequest","direction":"inbound","depth":2}}')}`,
    "- get_code_snippet: full source of a symbol by fully qualified name.",
    `  ${curlQuery('{"tool":"get_code_snippet","args":{"qualifiedName":"module.Symbol"}}')}`,
    "",
    `File endpoint: POST ${fileUrl} reads raw file content (path is repo-root relative; startLine/endLine optional).`,
    `  ${curlFile('{"path":"src/index.ts","startLine":1,"endLine":120}')}`,
    "",
    "Evidence-first: prefer one kb query over running your own code search (grep, rg, find). One search_code or context call usually replaces a whole exploration round-trip.",
    "",
    "If any request fails, times out, or returns HTTP 410, stop using the code graph and continue with normal file exploration. Exception: a failure or HTTP 410 early in the run can mean the session is still provisioning, so retry the query once later in the run before falling back for good.",
  ].join("\n");
}

/**
 * Render the delimited code-kb prompt block: an optional architecture code map
 * plus an optional curl cheat-sheet for the kb query tools, bound to the real
 * session id and base URL.
 */
export function renderCodeKbBlock(args: CodeKbBlockArgs): string {
  const { session: rawSession, architecture, includeToolInstructions = true, sourceKind = "github" } = args;
  const session: CodeKbPromptSession = {
    sessionId: neutralizeBlockDelimiters(rawSession.sessionId),
    baseUrl: neutralizeBlockDelimiters(rawSession.baseUrl),
  };
  const summary = renderCodeKbArchitectureSummary(architecture);
  const sections: string[] = [
    "# Code graph knowledge base",
    "",
    `A live, pre-indexed code graph for this repository is available over HTTP (session ${session.sessionId} at ${session.baseUrl}). It is read-only. Prefer it for structural lookup and call-graph questions so you spend model steps on synthesis, not rediscovery. Fall back to local file tools when the graph is unavailable or after the query budget is used.`,
  ];
  if (sourceKind === "local") {
    sections.push(
      "",
      `The repository source was uploaded as a tar archive from the local machine to the kb service at ${session.baseUrl} for indexing.`,
    );
  }
  if (summary) {
    sections.push(
      "",
      "## Architecture code map (from get_architecture)",
      "",
      "Use this map before issuing new graph queries for the same overview. Query only for gaps.",
      "",
      summary,
    );
  }
  if (includeToolInstructions) {
    sections.push("", renderToolInstructions(session));
  }
  return [BLOCK_OPEN, ...sections, BLOCK_CLOSE].join("\n");
}

// Per-section caps for the structure evidence body. They sum below the total
// cap so the fixed headings never push the block past ~10k; the final body cap
// in renderStructureEvidence is the hard guarantee.
const STRUCTURE_FILE_INVENTORY_CHAR_CAP = 4_000;
const STRUCTURE_README_CHAR_CAP = 3_200;
const STRUCTURE_MANIFEST_CHAR_CAP = 1_400;
const STRUCTURE_HOTSPOTS_CHAR_CAP = 1_000;
// Content budget for one page pack, split evenly across its files; headings
// ride in the gap below CODE_KB_PAGE_EVIDENCE_CHAR_CAP.
const PAGE_EVIDENCE_CONTENT_CHAR_CAP = 4_600;
const EVIDENCE_TRUNCATION_MARKER = "... [truncated]";

/** Deterministic tail truncation with a marker, mirroring the architecture cap. */
function capEvidenceText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - EVIDENCE_TRUNCATION_MARKER.length))}${EVIDENCE_TRUNCATION_MARKER}`;
}

/**
 * Neutralize + deterministically cap one piece of service-derived evidence
 * text. Same discipline as renderCodeKbArchitectureSummary: pre-slice before
 * the regex scan (the capped output can never depend on text past 2*cap),
 * neutralize the block delimiters, then cap with the truncation marker.
 * Returns "" when there is nothing renderable, which callers treat as "omit".
 */
function renderEvidenceText(value: unknown, cap: number): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value.trim();
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  if (!text) return "";
  if (text.length > cap * 2) text = text.slice(0, cap * 2);
  text = neutralizeBlockDelimiters(text);
  return capEvidenceText(text, cap);
}

/**
 * Pull compact display lines out of a `search_graph` result: one line per
 * node, preferring `file_path`, then `qualified_name`, then `name`, with the
 * degree appended when present. Defensive about shape (cbmem error envelopes,
 * missing fields, drifted keys all extract to nothing), so an unrecognizable
 * result degrades to an omitted section rather than raw JSON noise.
 */
function extractGraphLines(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const results = (result as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const lines: string[] = [];
  for (const node of results) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const label = [record.file_path, record.qualified_name, record.name].find(
      (value): value is string => typeof value === "string" && value !== "",
    );
    if (!label) continue;
    const degree = record.degree;
    lines.push(
      typeof degree === "number" && Number.isFinite(degree) ? `${label} (degree ${degree})` : label,
    );
  }
  return lines;
}

/** Render a `search_graph` result as a capped line list; "" when nothing extracts. */
function renderGraphEvidence(result: unknown, cap: number): string {
  const lines = extractGraphLines(result);
  if (lines.length === 0) return "";
  return renderEvidenceText(lines.join("\n"), cap);
}

export interface StructureEvidenceArgs {
  /** Raw `search_graph {label:"File"}` result: the repo file inventory. */
  fileInventory?: unknown;
  /** Head of the repo README (raw text). */
  readmeHead?: string;
  /** Head of the first manifest that exists (package.json, pyproject.toml, Cargo.toml, go.mod). */
  manifestHead?: { path: string; content: string };
  /** Raw `search_graph {minDegree}` result: high-degree (hotspot) symbols. */
  hotspots?: unknown;
}

/**
 * Render the structure-phase evidence block (U2 / R3): file inventory, README
 * head, manifest head, and hotspot symbols, each neutralized and capped, so
 * the structure agent starts from evidence instead of exploration turns.
 * Sections with nothing renderable are omitted, and a fully empty input
 * returns "" so callers append nothing (R8: prompts stay byte-identical).
 */
export function renderStructureEvidence(args: StructureEvidenceArgs): string {
  const sections: string[] = [];
  const inventory = renderGraphEvidence(args.fileInventory, STRUCTURE_FILE_INVENTORY_CHAR_CAP);
  if (inventory) sections.push(`## File inventory (from search_graph)\n\n${inventory}`);
  const readme = renderEvidenceText(args.readmeHead, STRUCTURE_README_CHAR_CAP);
  if (readme) sections.push(`## README head\n\n${readme}`);
  const manifest = renderEvidenceText(args.manifestHead?.content, STRUCTURE_MANIFEST_CHAR_CAP);
  if (manifest) {
    const manifestPath = neutralizeBlockDelimiters(String(args.manifestHead?.path ?? "").trim()) || "manifest";
    sections.push(`## Manifest head (${manifestPath})\n\n${manifest}`);
  }
  const hotspots = renderGraphEvidence(args.hotspots, STRUCTURE_HOTSPOTS_CHAR_CAP);
  if (hotspots) sections.push(`## Hotspot symbols (highest graph degree)\n\n${hotspots}`);
  if (sections.length === 0) return "";
  const body = capEvidenceText(sections.join("\n\n"), CODE_KB_STRUCTURE_EVIDENCE_CHAR_CAP);
  return [
    BLOCK_OPEN,
    "# Code graph evidence (pre-fetched)",
    "",
    "Starting evidence pre-fetched from the code graph snapshot of this repository. Use it to plan without exploration round-trips, and verify anything you rely on against the checkout.",
    "",
    body,
    BLOCK_CLOSE,
  ].join("\n");
}

export interface PageEvidenceFile {
  /** Repo-root-relative path. */
  path: string;
  /** Head of the file (raw text). */
  head: string;
}

/**
 * Render one page's evidence pack (U2 / R4): head excerpts of the page's
 * relevant files, neutralized and capped (the content budget splits evenly
 * across the files present). Files with empty heads are skipped; an empty
 * pack returns "" so callers append nothing (R8).
 */
export function renderPageEvidencePack(args: { files: PageEvidenceFile[] }): string {
  const files = args.files.filter(
    (file) => typeof file.path === "string" && file.path.trim() !== "" && typeof file.head === "string" && file.head.trim() !== "",
  );
  if (files.length === 0) return "";
  const perFileCap = Math.floor(PAGE_EVIDENCE_CONTENT_CHAR_CAP / files.length);
  const sections: string[] = [];
  for (const file of files) {
    const head = renderEvidenceText(file.head, perFileCap);
    if (!head) continue;
    sections.push(`## ${neutralizeBlockDelimiters(file.path.trim())} (head)\n\n${head}`);
  }
  if (sections.length === 0) return "";
  const body = capEvidenceText(sections.join("\n\n"), CODE_KB_PAGE_EVIDENCE_CHAR_CAP);
  return [
    BLOCK_OPEN,
    "# Page evidence pack (pre-fetched file heads)",
    "",
    "Head excerpts of this page's relevant files, pre-fetched from the code graph snapshot. Start from them, then verify line ranges in the checkout before citing.",
    "",
    body,
    BLOCK_CLOSE,
  ].join("\n");
}

// Per-item caps for the ask evidence body. They sum below the total cap so
// the fixed headings never push the block past ~4k; the final body cap in
// renderAskEvidence is the hard guarantee.
const ASK_SEARCH_RESULT_CHAR_CAP = 850;
const ASK_README_CHAR_CAP = 1_200;

/** Pull the raw text out of a kb `/file` read result; "" when unrecognizable. */
function extractFileContent(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}

export interface AskEvidenceSearch {
  /** The code-shaped question token queried via search_code. */
  pattern: string;
  /** Raw `search_code` result. */
  result: unknown;
}

export interface AskEvidenceArgs {
  /** Pre-run search_code results, one per extracted question token. */
  searches?: AskEvidenceSearch[];
  /** Raw README `/file` read result (string or {content}) for docs-shaped questions. */
  readmeHead?: unknown;
}

/**
 * Render the ask evidence block (U3 / R5): pre-run search_code results for the
 * question's code-shaped tokens plus a README head for docs-shaped questions,
 * each neutralized and capped. The header labels everything candidate evidence
 * to verify before citing. Items with nothing renderable are omitted, and a
 * fully empty input returns "" so callers append nothing (R8: the ask entry
 * stays byte-identical to the pre-evidence output).
 */
export function renderAskEvidence(args: AskEvidenceArgs): string {
  const sections: string[] = [];
  for (const search of args.searches ?? []) {
    const pattern = typeof search.pattern === "string" ? search.pattern.trim() : "";
    if (!pattern) continue;
    const body = renderEvidenceText(search.result, ASK_SEARCH_RESULT_CHAR_CAP);
    if (!body) continue;
    sections.push(`## search_code results: ${neutralizeBlockDelimiters(pattern)}\n\n${body}`);
  }
  const readme = renderEvidenceText(extractFileContent(args.readmeHead), ASK_README_CHAR_CAP);
  if (readme) sections.push(`## README.md head\n\n${readme}`);
  if (sections.length === 0) return "";
  const body = capEvidenceText(sections.join("\n\n"), CODE_KB_ASK_EVIDENCE_CHAR_CAP);
  return [
    BLOCK_OPEN,
    "# Ask evidence (pre-fetched, candidate only)",
    "",
    "Query results pre-fetched from the code graph snapshot for this question. This is candidate evidence: verify anything you rely on against the checkout before citing it.",
    "",
    body,
    BLOCK_CLOSE,
  ].join("\n");
}

// Char caps for the B7 fast-structure direct-call evidence. ONE prompt, ONE
// completion: there is no per-iteration token tax, so these run larger than
// the agent-path evidence caps above. The inventory cap fits ~300 paths.
const DIRECT_STRUCTURE_INVENTORY_CHAR_CAP = 16_000;
const DIRECT_STRUCTURE_README_CHAR_CAP = 4_000;
const DIRECT_STRUCTURE_MANIFEST_CHAR_CAP = 2_000;
/** Hard total char cap for direct page evidence, including its wrapper. */
export const DIRECT_PAGE_EVIDENCE_CHAR_CAP = 48_000;
const DIRECT_PAGE_EVIDENCE_FILE_LIMIT = 6;
const DIRECT_PAGE_EVIDENCE_PATH_CHAR_CAP = 1_000;

export interface DirectStructureEvidenceArgs {
  /** Normalized repo-root-relative paths; the citable-path ground truth. */
  fileInventoryPaths: string[];
  /** Raw `get_architecture` query result (object or pre-serialized string). */
  architecture?: unknown;
  /** Raw README `/file` read result (string or {content}). */
  readmeHead?: unknown;
  /** First manifest `/file` read that resolved, with its path. */
  manifestHead?: { path: string; content: unknown };
}

/**
 * Render the evidence block for the B7 fast-structure direct call: the full
 * citable file inventory plus the architecture map, README head, and manifest
 * head, each neutralized and capped. Returns "" when the inventory renders
 * empty, which callers treat as "run the structure agent instead".
 */
export function renderDirectStructureEvidence(args: DirectStructureEvidenceArgs): string {
  const inventory = renderEvidenceText(
    args.fileInventoryPaths.filter((path) => typeof path === "string" && path.trim() !== "").join("\n"),
    DIRECT_STRUCTURE_INVENTORY_CHAR_CAP,
  );
  if (!inventory) return "";
  const sections: string[] = [
    `## File inventory (every <file_path> must come from this list)\n\n${inventory}`,
  ];
  const architecture = renderCodeKbArchitectureSummary(args.architecture);
  if (architecture) sections.push(`## Architecture code map (from get_architecture)\n\n${architecture}`);
  const readme = renderEvidenceText(extractFileContent(args.readmeHead), DIRECT_STRUCTURE_README_CHAR_CAP);
  if (readme) sections.push(`## README head\n\n${readme}`);
  const manifest = renderEvidenceText(extractFileContent(args.manifestHead?.content), DIRECT_STRUCTURE_MANIFEST_CHAR_CAP);
  if (manifest) {
    const manifestPath = neutralizeBlockDelimiters(String(args.manifestHead?.path ?? "").trim()) || "manifest";
    sections.push(`## Manifest head (${manifestPath})\n\n${manifest}`);
  }
  return [
    BLOCK_OPEN,
    "# Repository evidence (code graph snapshot)",
    "",
    "Evidence pre-fetched from the code graph snapshot of this repository. It is the only repository information available in this run.",
    "",
    sections.join("\n\n"),
    BLOCK_CLOSE,
  ].join("\n");
}

export interface DirectPageEvidenceFile {
  /** Repo-root-relative path. */
  path: string;
  /** Raw file content. */
  content: string;
}

/**
 * Render direct page evidence for a single page-generation call. The writer
 * receives only this bounded, line-numbered repository material, so every
 * rendered line remains citable against its original source line.
 */
export function renderDirectPageEvidence(args: { files: DirectPageEvidenceFile[] }): string {
  const files = args.files
    .filter((file) => typeof file.path === "string" && file.path.trim() !== "" && typeof file.content === "string" && file.content.trim() !== "")
    .sort((left, right) => {
      const leftPath = left.path.trim();
      const rightPath = right.path.trim();
      if (leftPath < rightPath) return -1;
      if (leftPath > rightPath) return 1;
      return left.content < right.content ? -1 : left.content > right.content ? 1 : 0;
    })
    .slice(0, DIRECT_PAGE_EVIDENCE_FILE_LIMIT);
  if (files.length === 0) return "";

  const title = "# Direct page evidence";
  const instruction = "This is the only repository evidence available. The writer must not invent or imply files outside this block.";
  const paths = files.map((file) => renderEvidenceText(file.path, DIRECT_PAGE_EVIDENCE_PATH_CHAR_CAP));
  const headings = paths.map((path) => `## ${path}`);
  const fixedLength = [BLOCK_OPEN, title, "", instruction, "", ...headings, BLOCK_CLOSE].join("\n\n").length;
  const contentBudget = Math.max(0, DIRECT_PAGE_EVIDENCE_CHAR_CAP - fixedLength);
  const perFileCap = Math.floor(contentBudget / files.length);
  const sections = files.map((file, index) => {
    const numbered = file.content.split("\n").map((line, lineIndex) => `${lineIndex + 1} | ${line}`).join("\n");
    return `${headings[index]}\n\n${renderEvidenceText(numbered, perFileCap)}`;
  });
  const evidence = [BLOCK_OPEN, title, "", instruction, "", ...sections, BLOCK_CLOSE].join("\n");
  return capEvidenceText(evidence, DIRECT_PAGE_EVIDENCE_CHAR_CAP);
}

/**
 * Ask-shaped wikiContexts entry carrying the code-kb block, appended by the
 * /api/ask handler after the explicitly picked contexts. `evidence` is an
 * already-rendered renderAskEvidence block appended after the main block;
 * absent or empty evidence leaves the entry byte-identical to the
 * pre-evidence output (R8).
 */
export function codeKbAskContext(args: { session: CodeKbPromptSession; architecture?: unknown; sourceKind?: "local" | "github"; evidence?: string }): { id: string; label: string; context: string } {
  const block = renderCodeKbBlock({ session: args.session, architecture: args.architecture, includeToolInstructions: true, sourceKind: args.sourceKind });
  const evidence = typeof args.evidence === "string" && args.evidence.trim() !== "" ? args.evidence : "";
  return {
    id: "code-kb",
    label: "Code graph (live query service)",
    context: evidence ? `${block}\n\n${evidence}` : block,
  };
}
