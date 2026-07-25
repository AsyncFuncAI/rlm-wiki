/**
 * Single-file HTML artifact generation via Local CLI (same spine as wiki page
 * agents / Ask). Not a Terminal PTY: the agent answer is captured and returned
 * to the HTML surface.
 */
import type { LocalCliConfig } from "./local-cli-events.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { RLMEvent } from "./jcode-runtime.ts";
import { looksLikeLeakedReasoning } from "./generator.ts";

/** Jobs: tour (default progressive story) + deep lenses. Legacy ids normalize. */
export type HtmlGenre = "tour" | "map" | "impact" | "trace" | "concepts";

export const HTML_GENRES: HtmlGenre[] = ["tour", "map", "impact", "trace", "concepts"];

const LEGACY_GENRE: Record<string, HtmlGenre> = {
  explore: "tour",
  onboard: "tour",
  prototype: "tour",
  deck: "tour",
  review: "impact",
  design: "concepts",
  report: "trace",
  editor: "map",
  map: "map",
  impact: "impact",
  trace: "trace",
  concepts: "concepts",
  tour: "tour",
};

export function normalizeHtmlGenre(value: unknown): HtmlGenre {
  const raw = String(value || "").trim().toLowerCase();
  return LEGACY_GENRE[raw] || "tour";
}

/** JTBD contracts. Tour is the product default: one unified onboarding artifact. */
const GENRE_GUIDE: Record<HtmlGenre, string> = {
  tour:
    "Unified tour (default): progressive L1→L10 timeline journey. L1 what/why, L3 mental model, L4 stack table, L5 patterns of THIS repo, L6 unusual, L7 first minutes, L8 ranked files, L9 story path, L10 common recurring patterns / best practices / worth borrowing. Never open with a wiring dump.",
  map:
    "Map deep lens: same unified sections; after L1–L3, large interactive SVG wiring graph (path-labeled nodes). Forbidden: graph-first without human opener; pill-tab essay.",
  impact:
    "Impact deep lens: same unified sections; emphasize blast radius and hot modules with real paths.",
  trace:
    "Trace deep lens: same unified sections; one primary runtime flow with file:line steps + diagram + gotchas.",
  concepts:
    "Concepts deep lens: same unified sections; patterns/anti-patterns of THIS repo with file proof. Not a textbook glossary.",
};

export type HtmlDressPromptInput = {
  id: string;
  label: string;
  summary: string;
  theme: "light" | "dark";
  cssContract: string;
  layoutRules: string;
  /** Full dress CSS including fonts. Injected at extract time; never dumped raw into the agent prompt. */
  cssRoot: string;
};

/**
 * Compact dress CSS safe for agent prompts: strips @font-face blocks and data-URIs
 * so geist-pixel (~700KB base64) never enters the model context.
 * Full cssRoot is re-injected after extract via injectHtmlDressCssRoot.
 */
export function dressCssRootForPrompt(cssRoot: string, maxChars = 3500): string {
  let s = String(cssRoot || "");
  // Remove @font-face rules (non-greedy; nested braces rare in font-face)
  s = s.replace(/@font-face\s*\{[\s\S]*?\}\s*/gi, "");
  s = s.replace(/url\(\s*["']?data:[^)]+\)/gi, "/* data-uri omitted; runtime injects fonts */");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length <= maxChars) return s;
  const root = s.match(/:root\s*\{[\s\S]*?\}/);
  if (root?.[0] && root[0].length <= maxChars) return root[0].trim();
  return s.slice(0, maxChars).trimEnd() + "\n/* truncated for prompt; full dress injected at extract */";
}

/** List CSS custom properties mentioned in a dress cssRoot (for prompt guidance). */
export function dressCssVariableNames(cssRoot: string): string[] {
  const names = new Set<string>();
  const re = /(--[a-zA-Z0-9-_]+)\s*:/g;
  let m: RegExpExecArray | null;
  const src = String(cssRoot || "");
  while ((m = re.exec(src))) names.add(m[1]);
  return [...names].slice(0, 40);
}

/**
 * Inject system-owned dress CSS into the agent HTML so the final artifact is
 * self-contained (fonts + tokens) without the model re-authoring them.
 */
export function injectHtmlDressCssRoot(
  html: string,
  cssRoot: string,
  dressId = "dress",
): string {
  const css = String(cssRoot || "").trim();
  const doc = String(html || "");
  if (!css || !doc) return doc;
  const safeId = String(dressId || "dress").replace(/[^a-zA-Z0-9_-]/g, "-") || "dress";
  // Idempotent: replace prior runtime inject
  const withoutPrior = doc.replace(
    /<style\b[^>]*\bdata-gw-dress\b[^>]*>[\s\S]*?<\/style>\s*/gi,
    "",
  );
  const styleTag = `<style data-gw-dress="${safeId}">\n${css}\n</style>`;
  // Prefer after <meta charset> so large dress CSS (geist fonts) never
  // pushes charset past the browser's early-parse window (~1024 bytes).
  if (/<meta\b[^>]*charset\b[^>]*>/i.test(withoutPrior)) {
    return withoutPrior.replace(/(<meta\b[^>]*charset\b[^>]*>)/i, `$1\n${styleTag}`);
  }
  if (/<head[^>]*>/i.test(withoutPrior)) {
    return withoutPrior.replace(/<head([^>]*)>/i, `<head$1>\n${styleTag}`);
  }
  if (/<html[\s>]/i.test(withoutPrior)) {
    return withoutPrior.replace(
      /<html([^>]*)>/i,
      `<html$1><head><meta charset="utf-8">${styleTag}</head>`,
    );
  }
  return `${styleTag}\n${withoutPrior}`;
}

export function buildHtmlGeneratePrompt(input: {
  title: string;
  brief: string;
  genre: HtmlGenre;
  scope?: string;
  dress?: HtmlDressPromptInput | null;
  /** Full <code-kb> block from the live code graph (preferred). */
  codeKbContext?: string | null;
  /** Soft fallback when a live session is unavailable. */
  codeGraphHint?: string;
  /** When true, a fat prefetched pack is present; tighten tool budget. */
  evidencePackRich?: boolean;
}): string {
  const genre = normalizeHtmlGenre(input.genre);
  const dress = input.dress;
  const codeKb = String(input.codeKbContext || "").trim();
  const packRich = Boolean(input.evidencePackRich) || codeKb.length >= 2000;
  const promptCss = dress ? dressCssRootForPrompt(dress.cssRoot) : "";
  const varNames = dress ? dressCssVariableNames(dress.cssRoot) : [];
  const dressBlock = dress
    ? [
        "VISUAL DRESS (system-owned CSS; content author uses tokens only):",
        `- Dress: ${dress.id} (${dress.label}) · ${dress.theme}`,
        `- ${dress.summary}`,
        `- CSS contract: ${dress.cssContract}`,
        `- Layout rules: ${dress.layoutRules}`,
        varNames.length
          ? `- CSS variables to use: ${varNames.join(", ")}`
          : "- Use the provided :root variables only. No second palette.",
        "- Build structure and light structural CSS from those variables. No second palette.",
        "- Do NOT embed @font-face data-URIs, base64 fonts, or remote font/CDN links.",
        "- Do NOT re-author the full design system. The runtime injects the complete dress CSS (including self-contained fonts) after your HTML is extracted.",
        "- Prefer semantic classes the dress already styles: page, card, panel, callout, pill, chip, muted, lede, rule, btn, primary.",
        "- No AI-purple gradients, neon glow, glassmorphism blobs, or three equal marketing cards.",
        "- No em-dashes in copy. Use periods or commas.",
        "- Spacious, easy to read. Body max-width ~65ch.",
        "",
        "Token reference (prompt-safe; fonts omitted):",
        "```css",
        promptCss || ":root { /* dress tokens applied at extract */ }",
        "```",
        "",
      ]
    : [
        "VISUAL STYLE (mandatory minimalist default):",
        "- Spacious monochrome. Dark or light paper only. High contrast body text.",
        "- System fonts. No remote CDNs. No AI-purple, neon, or glassmorphism.",
        "- No em-dashes. Max readable line ~65ch. Prefer hairlines and space over card grids.",
        "",
      ];
  const toolBudget = packRich
    ? [
        "CODE GRAPH + PREFETCHED EVIDENCE (mandatory):",
        "A live code graph and a prefetched repository evidence pack are attached below.",
        "- Treat the pack as primary grounding. Prefer claims already supported by file heads, inventory, and hotspots.",
        "- Hard budget: at most 2 high-signal verification lookups, then WRITE. No completeness theater.",
        "- If the graph errors or returns 410 after one retry, fall back to the pack alone.",
        "",
        codeKb,
        "",
      ]
    : codeKb
      ? [
          "CODE GRAPH (mandatory when available):",
          "A live pre-indexed code graph is attached below. Use it before broad local file tours.",
          "- Prefer budgeted graph queries for locate, call-graph, and architecture questions.",
          "- Ground every major claim in real file paths and symbols from the graph or checkout.",
          "- Hard budget: at most 4 high-signal graph/file lookups, then WRITE. No completeness theater.",
          "- If the graph errors or returns 410 after one retry, fall back to normal local exploration.",
          "",
          codeKb,
          "",
        ]
      : input.codeGraphHint
        ? [
            "CODE GRAPH (best effort):",
            `- ${input.codeGraphHint}`,
            "- Prefer structural reads of real entry points and symbols before inventing architecture.",
            "- Hard budget: at most 6 focused reads/searches, then WRITE.",
            "",
          ]
        : [
            "REPOSITORY EVIDENCE:",
            "- Explore the checkout. Cite real files and symbols. Do not invent package names or paths.",
            "- Hard budget: at most 8 focused reads/searches, then WRITE.",
            "",
          ];
  return [
    "Create ONE self-contained HTML artifact (single file).",
    "Do NOT write Markdown. HTML only.",
    "",
    "WORKFLOW (quality first, speed second):",
    "1) RESEARCH (can use parallel sub-agents/tasks IF your runtime supports them):",
    "   - Gather architecture, entry points, and 3-8 concrete file/symbol facts.",
    "   - Parallel research is fine. Do NOT parallel-write the HTML document itself.",
    "2) WRITE (single author, one pass):",
    "   - ONE agent writes structure, copy, and voice so the document stays coherent.",
    "   - Dress/fonts are system-owned and injected after extract; do not co-author full dress CSS.",
    "   - Do not draft partial HTML, then rewrite from scratch. Prefer one complete emit.",
    "   - After the HTML starts, stop exploring unless a cited path is clearly wrong.",
    "",
    "READING EXPERIENCE (one unified onboarding artifact, not a tech dump):",
    "- Pass the Slack test: would a curious human open a GitHub URL's artifact and keep scrolling?",
    "- ALWAYS open at L1: what is this product/project in plain language, who it's for, one concrete scenario.",
    "- Progress L1→L10 as a center-rail timeline journey (prime-volume / OpenCode Drive reading experience).",
    "- Structure: journey rail + entry note cards (note-kicker, note-title, note-body). Optional term/code and table entries.",
    "- Voice: warm and concrete. Prefer 'you open the app…' / 'the session starts…' over plugin inventories.",
    "- AUDIENCE VOICE: the reader is technical but does not read this codebase day-to-day. Code and file pointers are fine — do not assume they already know what a given variable, function, or module does; introduce it briefly on first mention.",
    "- Each beat: kicker + title + 2–4 sentences + optional visual/table. No multi-paragraph essays.",
    "- Stack table: layer · library · purpose in this repo · path · core/optional. Cap ~12 rows. Not a dependency dump.",
    "- Patterns: plain-English cards with file proof. Not Gang-of-Four lectures.",
    "- L10: common recurring patterns, best practices, and what is worth borrowing from THIS repo (with paths).",
    "- Do not dump entry points or crate graphs before the human story.",
    "- Ban brochure language: 'how X is actually assembled', 'comprehensive overview', 'shape, options, tradeoffs', 'built for a senior engineer who asks…'.",
    "",
    "DEPTH (earn technical density; do not lead with it):",
    "- Human levels (L1–L3) before stack/patterns; story path and landmines after orientation.",
    "- Every deep beat still names verified paths/symbols that exist in the checkout.",
    "- Prefer cutting a shallow section over inventing paths or a complete-looking shell.",
    "",
    "VISUAL (in service of the story):",
    "- Timeline / journey column is the default skeleton (center rail or stacked beats).",
    "- Diagrams appear when the level needs them (story path / map lens), not as the first screen.",
    "- Quiet kickers, tight titles, body ≤ ~65ch. Dress CSS variables only.",
    "- FORBIDDEN primary layouts: Notion pill-tab essay, three equal marketing cards, graph-of-crates with no human opener.",
    "- Interaction only when it teaches. Graphs may be wide; phone may scroll them horizontally.",
    "",
    "Requirements:",
    "- Complete document: <!DOCTYPE html>, inline CSS hooks as needed, minimal inline JS if interactive.",
    "- Story carries the page; diagrams, tables, and code annotate it.",
    "- Mobile-friendly enough to read on a phone.",
    "- No remote scripts or stylesheets. No external fonts/CDNs. No @font-face data-URIs in your output.",
    "",
    "JOB (non-negotiable deliverable; adapt rendering to the repository):",
    `- Job id: ${genre}`,
    `- ${GENRE_GUIDE[genre]}`,
    "- First identify the repository type (app, library, monorepo, CLI, service, research, design system, etc.).",
    "- Fixed section answers (what/why/stack/patterns/path/landmines); adaptive beat chrome for THAT repo type.",
    `- Working title hint (may be a placeholder): ${input.title}`,
    "- Set a concrete <title> and primary <h1> that name the project or subject. Do not use only the job word (Tour, Map, Impact, Trace, Concepts).",
    input.scope ? `- Repository / scope context (read the code when relevant): ${input.scope}` : "- Scope: none provided.",
    "",
    ...toolBudget,
    ...dressBlock,
    String(input.brief || "").trim()
      ? [
          "USER NOTE STEERING (non-empty brief present):",
          "The user note below steers depth and voice for the WHOLE L1–L10 journey.",
          "L1–L10 still all run. Do not drop levels, invent a different shell, or replace the center-rail journey with a freeform essay.",
          "Use the note to emphasize what matters (audience, lens, depth) while keeping every level grounded in real paths.",
          "",
        ].join("\n")
      : "",
    "User brief (primary intent; may be a stock lens or a custom saved prompt):",
    input.brief,
    "",
    "When finished, output the COMPLETE HTML document.",
    "Prefer wrapping it between these exact markers on their own lines:",
    "<!--GW_HTML_START-->",
    "<!--GW_HTML_END-->",
    "No commentary outside the markers once the HTML is ready.",
    "Do not narrate the CSS contract back to the user; use the dress tokens in markup and light CSS only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const GENRE_ONLY_TITLE =
  /^(exploration|explore|review|design|prototype|report|editor|deck|code review|design system|map|onboard|impact|trace|concepts|tour|architecture map|blast radius|onboarding)$/i;

// Paths like src/server.ts or apps/desktop/src/x.ts:12 (optionally inside tags/code).
const PATH_ANCHOR_RE =
  /(?:^|[^A-Za-z0-9_/])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|md|json|toml|yml|yaml|css|html))(?::\d+(?:-\d+)?)?/g;

export type HtmlQualityContext = {
  genre?: HtmlGenre | string;
  dress?: HtmlDressPromptInput | null;
  /** True when a live code-kb / evidence pack was available for this run. */
  hadCodeEvidence?: boolean;
  /** Pre-dress extracted HTML (preferred for font-face checks). */
  extractedHtml?: string;
  /** Agent raw text before markers (leak detection). */
  rawText?: string;
  /**
   * Inventory paths from the evidence pack / code graph. When present, cited
   * path anchors are checked for existence (normalized suffix match).
   */
  knownPaths?: string[] | Set<string>;
};

/** Unique path anchors cited in HTML (no line numbers). */
export function extractPathAnchors(html: string): string[] {
  const unique = new Set<string>();
  for (const m of String(html || "").matchAll(PATH_ANCHOR_RE)) {
    const path = (m[1] || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (path) unique.add(path);
  }
  return [...unique];
}

/**
 * Pull path-like strings from a code-kb / evidence pack for inventory matching.
 * Cheap and deterministic; does not call the network.
 */
export function extractKnownPathsFromEvidence(codeKb: string): string[] {
  const text = String(codeKb || "");
  if (!text) return [];
  const unique = new Set<string>();
  // Markdown / inventory lines and fenced path headers
  const re =
    /(?:^|[\s`"'(=])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|md|json|toml|yml|yaml|css|html|lock))(?=[\s`"'):,]|$)/gim;
  for (const m of text.matchAll(re)) {
    const path = (m[1] || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      path &&
      !path.startsWith("node_modules/") &&
      !path.includes("/.git/") &&
      path.length < 200
    ) {
      unique.add(path);
    }
  }
  // Bare filenames that often appear as inventory leaves
  for (const bare of ["README.md", "package.json", "Cargo.toml", "go.mod", "pyproject.toml"]) {
    if (new RegExp(`\\b${bare.replace(".", "\\.")}\\b`).test(text)) unique.add(bare);
  }
  return [...unique];
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/** True when cited path matches inventory (exact, suffix, or basename for short roots). */
export function pathInKnownInventory(cited: string, known: Iterable<string>): boolean {
  const c = normalizePathKey(cited);
  if (!c) return false;
  for (const k of known) {
    const n = normalizePathKey(k);
    if (!n) continue;
    // Exact or path-segment suffix only (avoid "a.ts" matching "data.ts").
    if (n === c || n.endsWith("/" + c) || c.endsWith("/" + n)) {
      return true;
    }
  }
  return false;
}

/**
 * When inventory is available, reject documents that cite mostly ghost paths.
 * Soft when inventory is thin (<8 paths).
 */
export function pathAnchorExistenceIssue(
  doc: string,
  knownPaths: string[] | Set<string> | undefined,
): string | null {
  if (!knownPaths) return null;
  const known = knownPaths instanceof Set ? [...knownPaths] : knownPaths;
  if (known.length < 8) return null;
  const cited = extractPathAnchors(doc);
  if (cited.length < 2) return null;
  const unmatched = cited.filter((p) => !pathInKnownInventory(p, known));
  const matched = cited.length - unmatched.length;
  // Fail when half or more of cited paths are missing and at least 2 ghosts.
  if (unmatched.length >= 2 && unmatched.length >= Math.ceil(cited.length * 0.5) && matched < 2) {
    const sample = unmatched.slice(0, 3).join(", ");
    return `cited paths were not found in the repository inventory (e.g. ${sample}); use real files from the evidence pack or checkout`;
  }
  if (unmatched.length >= 3 && matched === 0) {
    const sample = unmatched.slice(0, 3).join(", ");
    return `none of the cited paths match the repository inventory (e.g. ${sample}); ground claims in real files`;
  }
  return null;
}

/**
 * Unified section presence for the product default (tour) when evidence was available.
 * Heuristic: require orientation + stack signal + pattern/mechanism + landmine/safe-change.
 */
export function unifiedSectionQualityIssue(doc: string, hadCodeEvidence: boolean): string | null {
  if (!hadCodeEvidence) return null;
  const text = doc
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const head = text.slice(0, 2800);
  if (!/\b(what is|this (is|app|tool|project|product)|for (people|developers|teams)|you (can|open|start|hit|join)|helps you|when you)\b/i.test(head)) {
    return "unified tour must open with a human L1 overview (what this is / who it's for)";
  }
  const hasStack =
    /<table\b/i.test(doc) ||
    /\b(tech stack|stack|frontend|backend|runtime|framework|library|dependencies|shell|infra)\b/i.test(text);
  const pathCount = extractPathAnchors(doc).length;
  if (!hasStack || pathCount < 2) {
    return "unified tour needs a stack section (table or layered list) with purpose and real paths, not a package dump";
  }
  const hasPatterns =
    /\b(pattern|convention|architecture|mental model|plugin|transaction|aggregate|boundary|monorepo|subscribe|live quer)\b/i.test(
      text,
    );
  if (!hasPatterns) {
    return "unified tour needs patterns/system-design of THIS repo (named mechanisms with file proof)";
  }
  const hasBorrowOrPractice =
    /\b(borrow|best practice|recurring|pattern|convention|worth|reuse|repeat|practice|anti-?pattern|do this|prefer)\b/i.test(
      text,
    );
  if (!hasBorrowOrPractice) {
    return "unified tour needs L10 worth-borrowing / recurring patterns / best practices grounded in this repo";
  }
  return null;
}

/**
 * HTML-native quality gate. Returns a short issue string or null when acceptable.
 * Not markdown wiki rules.
 */
export function htmlArtifactQualityIssue(html: string, ctx: HtmlQualityContext = {}): string | null {
  // Always score agent content (pre-dress). Post-inject html can contain the full
  // dress cssRoot (~700KB fonts), which would mask length/token/leak checks.
  const doc = String(ctx.extractedHtml || html || "").trim();
  if (!doc || doc.length < 400) return "the HTML document was empty or far too short for a useful artifact";
  if (!/<html[\s>]/i.test(doc) && !/<!DOCTYPE html/i.test(doc)) {
    return "the output was not a parseable HTML document";
  }

  const title = extractTitleFromHtml(doc);
  if (!title || GENRE_ONLY_TITLE.test(title.trim())) {
    return "the title/h1 is missing or is only a genre word; name the project or subject";
  }

  const rawProbe = String(ctx.rawText || doc);
  const beforeMarkers = rawProbe.split(/<!--GW_HTML_START-->/i)[0] || "";
  if (looksLikeLeakedReasoning(beforeMarkers) || looksLikeLeakedReasoning(doc.slice(0, 2500))) {
    return "the output appears to contain leaked model reasoning before or inside the HTML";
  }

  if (/<script\b[^>]*\bsrc\s*=\s*["']https?:/i.test(doc)) {
    return "the HTML loads a remote script; self-contained artifacts cannot use external script src";
  }
  if (/<link\b[^>]*\bhref\s*=\s*["']https?:/i.test(doc)) {
    return "the HTML loads a remote stylesheet or resource; no external CDNs";
  }
  if (/@import\s+url\(\s*["']?https?:/i.test(doc)) {
    return "the HTML uses a remote @import; keep styles local";
  }
  if (/@font-face\s*\{[\s\S]{0,200}url\(\s*["']?data:/i.test(doc)) {
    return "the agent embedded @font-face data-URIs; dress fonts are system-injected after extract";
  }

  if (ctx.dress?.cssRoot) {
    const vars = dressCssVariableNames(ctx.dress.cssRoot);
    const usesVar =
      /var\(\s*--[a-zA-Z0-9-_]+/.test(doc) ||
      vars.some((name) => doc.includes(`var(${name}`) || doc.includes(`var( ${name}`));
    if (!usesVar && vars.length > 0) {
      return "the HTML does not reference dress CSS variables (e.g. var(--bg)); use the dress tokens";
    }
  }

  if (ctx.hadCodeEvidence) {
    const unique = extractPathAnchors(doc);
    if (unique.length < 2) {
      return "with code evidence available, include at least two real repository path anchors (e.g. src/server.ts)";
    }
    const pathExist = pathAnchorExistenceIssue(doc, ctx.knownPaths);
    if (pathExist) return pathExist;
  }

  // Light structure: not a single empty body
  if (!/<h1[\s>]/i.test(doc) && !/<h2[\s>]/i.test(doc)) {
    return "the HTML lacks scannable headings (h1/h2)";
  }

  const job = normalizeHtmlGenre(ctx.genre);

  // Progressive open for all jobs (product opens human-first).
  const prog = progressiveOpenIssue(doc);
  if (prog) return prog;

  // Unified section contract (default product + deep lenses share orientation).
  if (job === "tour" || job === "concepts" || job === "impact" || job === "trace") {
    const sectionIssue = unifiedSectionQualityIssue(doc, Boolean(ctx.hadCodeEvidence));
    if (sectionIssue) return sectionIssue;
  }

  if (job === "map") {
    const svgIssue = mapSvgQualityIssue(doc);
    if (svgIssue) return svgIssue;
  }
  if (job === "impact" && !/\b(blast|impact|caller|depend|downstream|break|risk|sev-|safe (first )?change)\b/i.test(doc)) {
    return "impact lens must discuss blast radius / callers / what breaks / first safe change, with real paths";
  }
  if (job === "trace" && !/\b(step|flow|request|pipeline|handler|entrypoint|entry point)\b/i.test(doc)) {
    return "trace lens must narrate an ordered end-to-end flow with steps and paths";
  }
  if (job === "concepts" && !/\b(pattern|concept|abstraction|anti-?pattern|mental|decision|tradeoff|convention)\b/i.test(doc)) {
    return "concepts lens must cover mental model / patterns of THIS repo with real examples";
  }

  if (job === "map" && looksLikePillTabEssay(doc)) {
    return "map lens must not use a pill-tab essay as the primary layout; put a large SVG wiring graph after the human opener";
  }

  const brochure = brochureVoiceIssue(doc);
  if (brochure) return brochure;

  // Reject wrap/hero/beat dumps (not the OpenCode centered journey shell).
  if (
    /\bclass=["'][^"']*\b(wrap|hero|beat)\b/i.test(doc) &&
    !/data-gw-journey\b/i.test(doc)
  ) {
    return "layout is not the OpenCode centered journey shell (wrap/hero/beat dump); use entry note on a center rail";
  }
  // Reject classic left/right alternating timeline CSS (Open-Inspect failure mode).
  if (
    (/nth-child\s*\(\s*even\s*\)/i.test(doc) && /margin-left\s*:\s*50%/i.test(doc)) ||
    (/\.beat\b/i.test(doc) && /margin-left\s*:\s*50%/i.test(doc))
  ) {
    return "layout uses left/right alternating timeline (zigzag); use center-rail entry notes only";
  }

  return null;
}

/**
 * Progressive open: first screen must not be pure wiring/crate inventory.
 * Used for tour/map so GitHub-URL onboarding starts at human L1.
 */
export function progressiveOpenIssue(doc: string): string | null {
  const head = doc.slice(0, 1800);
  const headText = head
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " [SVG] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Graph or heavy path list in the first chunk with no human framing words.
  const hasSvgEarly = /\[SVG\]/.test(headText) || /<svg\b/i.test(head);
  const humanCue = /\b(what is|this (is|app|tool|project|product)|for (people|developers|teams)|you (can|open|start)|helps you|when you)\b/i.test(
    headText,
  );
  const pathDensity = (headText.match(/[\w.-]+\.(?:rs|ts|tsx|js|go|py|sql)\b/g) || []).length;
  if (hasSvgEarly && !humanCue && pathDensity >= 4) {
    return "opens as a tech dump (graph/paths before human L1); lead with what this is and who it's for, then deepen";
  }
  if (!humanCue && pathDensity >= 8) {
    return "first screen is path-heavy without a human overview; start L1 (what/why) before file inventories";
  }
  return null;
}

/** Phrases that read as AI brochure filler rather than a tour someone finishes. */
export function brochureVoiceIssue(doc: string): string | null {
  const text = doc
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 8000);
  const banned: Array<[RegExp, string]> = [
    [/\bhow (?:the |this )?.{0,40}\bis actually assembled\b/i, "brochure lede ('actually assembled')"],
    [/\bshape,?\s*options,?\s*(?:and )?tradeoffs\b/i, "generic section title 'shape, options, tradeoffs'"],
    [/\bbuilt for a senior engineer who asks\b/i, "meta 'built for a senior engineer' framing"],
    [/\bcomprehensive overview\b/i, "'comprehensive overview' filler"],
    [/\bthis (?:page|artifact|document) (?:will |aims to |seeks to )/i, "meta document self-description"],
  ];
  for (const [re, label] of banned) {
    if (re.test(text)) {
      return `copy sounds like a brochure (${label}); rewrite as a concrete tour with real paths and short beats`;
    }
  }
  return null;
}

/** Map job: require a substantial SVG, not a token <svg></svg> or single icon. */
export function mapSvgQualityIssue(doc: string): string | null {
  const svgs = doc.match(/<svg\b[\s\S]*?<\/svg>/gi) || [];
  if (svgs.length === 0) {
    return "map job requires a large interactive SVG wiring/architecture graph with real paths";
  }
  const best = svgs.reduce((a, b) => (a.length >= b.length ? a : b), "");
  if (best.length < 400) {
    return "map SVG is too small; ship a real multi-node wiring graph (not a decorative icon)";
  }
  const shapes = (best.match(/<(?:path|line|polyline|polygon|rect|circle|ellipse)\b/gi) || []).length;
  if (shapes < 6) {
    return "map SVG needs more graph structure (≥6 shapes: nodes/edges), not a stub diagram";
  }
  // Prefer real repo paths somewhere in the document near the graph
  const pathHits = [...doc.matchAll(PATH_ANCHOR_RE)].length;
  if (pathHits < 3) {
    return "map job needs ≥3 real repository path anchors on or next to the graph";
  }
  return null;
}

/** Heuristic: pill tabs + long prose, no substantial graph (the lame Notion layout). */
export function looksLikePillTabEssay(doc: string): boolean {
  const tabButtons = (doc.match(/<button\b[^>]*>[\s\S]{0,40}<\/button>/gi) || []).length;
  const pillClass = /\b(pill|chip|tab)\b/i.test(doc);
  const proseHeavy = (doc.match(/<p\b/gi) || []).length >= 6;
  const svgLen = (doc.match(/<svg\b[\s\S]*?<\/svg>/gi) || []).join("").length;
  return pillClass && tabButtons >= 3 && proseHeavy && svgLen < 400;
}

export function buildHtmlRepairPrompt(input: {
  issue: string;
  priorHtml: string;
  title: string;
  brief: string;
  genre: HtmlGenre;
  scope?: string;
  dress?: HtmlDressPromptInput | null;
}): string {
  const dressHint = input.dress
    ? `Keep using dress tokens (${dressCssVariableNames(input.dress.cssRoot).slice(0, 12).join(", ")}). Do not re-embed fonts.`
    : "Keep the minimal monochrome style.";
  return [
    "Your previous HTML artifact was rejected by the quality gate.",
    `Issue: ${input.issue}`,
    "",
    "Produce a COMPLETE replacement HTML document that fixes the issue.",
    "Do not apologize or explain. Output only the HTML between markers.",
    `- Job: ${normalizeHtmlGenre(input.genre)}`,
    `- Title subject: ${input.title}`,
    input.scope ? `- Scope: ${input.scope}` : "",
    `- Brief: ${input.brief}`,
    dressHint,
    "- Keep the unified section ladder: human L1, stack with purpose, patterns of THIS repo, L10 worth borrowing / best practices with real paths.",
    "- Cite only paths that exist in the checkout / evidence pack. No genre-only title, no remote CDNs.",
    "- Prefer surgical improvement of the prior document over a totally different shell.",
    "",
    "Prior HTML (for reference; rewrite as needed):",
    "<!--GW_HTML_START-->",
    input.priorHtml.slice(0, 80_000),
    "<!--GW_HTML_END-->",
    "",
    "Return the fixed document between:",
    "<!--GW_HTML_START-->",
    "<!--GW_HTML_END-->",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function extractHtmlFromAgentOutput(raw: string): string | null {
  const text = String(raw || "");
  const marked = text.match(/<!--GW_HTML_START-->([\s\S]*?)<!--GW_HTML_END-->/i);
  if (marked?.[1]?.trim()) return marked[1].trim();
  const fenced = text.match(/```html\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  const doctype = text.match(/(<!DOCTYPE html[\s\S]*<\/html>)/i);
  if (doctype?.[1]?.trim()) return doctype[1].trim();
  if (/<html[\s>]/i.test(text) && /<\/html>/i.test(text)) {
    const start = text.search(/<html[\s>]/i);
    const end = text.toLowerCase().lastIndexOf("</html>");
    if (start >= 0 && end > start) return text.slice(start, end + 7).trim();
  }
  return null;
}

export function titleFromBrief(brief: string, genre: HtmlGenre, scope = ""): string {
  const line = String(brief || "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  const repoFromBrief = String(brief || "").match(/Repository:\s*(\S+)/i)?.[1] || "";
  const scopePrimary = String(scope || "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  const source = scopePrimary || repoFromBrief;
  if (source) {
    const gh = source.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
    if (gh) return gh[2].replace(/\.git$/i, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(source)) return source.split("/")[1] || source;
    const leaf = source.replace(/\/+$/, "").split(/[/\\]/).filter(Boolean).pop();
    if (leaf) return leaf;
  }
  if (
    line &&
    line.length <= 72 &&
    !/^you are\b/i.test(line) &&
    !/^create one\b/i.test(line)
  ) {
    return line.replace(/[.。]+$/, "");
  }
  const labels: Record<HtmlGenre, string> = {
    tour: "Guided tour",
    map: "Architecture map",
    impact: "Blast radius",
    trace: "Flow trace",
    concepts: "Mental model",
  };
  return labels[genre] || "HTML artifact";
}

/** Prefer <title> / h1 from the finished document over genre placeholders. */
export function extractTitleFromHtml(html: string): string {
  const raw = String(html || "");
  const decode = (value: string) =>
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  const titleTag = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  for (const candidate of [titleTag, h1]) {
    const cleaned = decode(String(candidate || ""));
    if (!cleaned) continue;
    if (/^(exploration|explore|review|design|prototype|report|editor|deck)$/i.test(cleaned)) {
      continue;
    }
    return cleaned.length > 80 ? `${cleaned.slice(0, 79).trimEnd()}…` : cleaned;
  }
  return "";
}

export type HtmlGenerateResult = {
  html: string;
  title: string;
  genre: HtmlGenre;
  rawText: string;
  /** Prompt bytes for telemetry (not full dress fonts). */
  promptChars: number;
  evidenceChars: number;
  qualityIssue?: string | null;
  repaired?: boolean;
  /** Multi-agent: levels that fell back to stubs after retries. */
  failedBlockIds?: string[];
};

function finalizeHtmlDocument(
  extractedOrRaw: string,
  dress: HtmlDressPromptInput | null | undefined,
): { extracted: string; html: string } {
  const extracted = extractedOrRaw;
  let html = extracted;
  const dressCss = String(dress?.cssRoot || "").trim();
  if (dressCss) {
    html = injectHtmlDressCssRoot(html, dressCss, dress?.id || "dress");
  }
  return { extracted, html };
}

export type HtmlGeneratePhase = "prepare" | "structure" | "pages" | "write" | "finalize";

export type HtmlGenerateOptions = {
  source: string;
  brief: string;
  title?: string;
  genre?: unknown;
  dress?: HtmlDressPromptInput | null;
  /** Full live code-graph prompt block (<code-kb>…). */
  codeKbContext?: string | null;
  codeGraphHint?: string;
  localCli: LocalCliConfig;
  onEvent?: (event: RLMEvent) => void;
  signal?: AbortSignal;
  /** Called when a quality repair pass starts. */
  onRepair?: (issue: string) => void;
  /** Pipeline phase updates (blueprint / parallel blocks / assemble). */
  onPhase?: (phase: HtmlGeneratePhase, label: string, detail: string) => void;
  /** Parallel timeline block agents (default 8, same as Docs local-CLI pages). */
  concurrency?: number;
  /**
   * When true (default), use blueprint + parallel block pipeline.
   * Set false to fall back to one-shot single agent (debug only).
   */
  multiAgent?: boolean;
  /** Docs-style: blueprint ready with L1–L10 plan. */
  onStructureDone?: (blueprint: {
    title: string;
    coreNoun: string;
    sections: Array<{ id: string; title: string; kicker: string; intent: string }>;
  }) => void;
  /** Docs-style: each timeline block settled. */
  onBlockDone?: (event: {
    levelId: string;
    index: number;
    total: number;
    title: string;
    kicker: string;
    failed: boolean;
    completed: number;
  }) => void;
};

/**
 * Generate one self-contained HTML journey for a repo.
 * Default path (multi-agent, Doc/wiki-style):
 *   blueprint L1–L10 → parallel timeline block agents → assemble → gate (+ repair).
 * Uses LocalCliAgent (sidecar), not a Terminal PTY.
 */
export async function runHtmlGenerate(opts: HtmlGenerateOptions): Promise<HtmlGenerateResult> {
  const source = String(opts.source || "").trim();
  const brief = String(opts.brief || "").trim();
  if (!source) throw new Error("source is required");
  if (!brief) throw new Error("brief is required");

  const genre = normalizeHtmlGenre(opts.genre);
  const workingTitle =
    String(opts.title || "").trim() || titleFromBrief(brief, genre, source);
  const codeKb = String(opts.codeKbContext || "").trim();
  const multiAgent = opts.multiAgent !== false;

  // Dynamic import keeps module graph clean for tests that only use helpers.
  const { runHtmlPipeline } = await import("./html-pipeline.ts");

  let extracted = "";
  let rawText = "";
  let promptChars = 0;
  let pipelineTitle = workingTitle;

  let pipelineFailedIds: string[] = [];
  let pipelineQualityNote: string | null = null;

  if (multiAgent) {
    const pipeline = await runHtmlPipeline({
      source,
      brief,
      title: workingTitle,
      genre,
      dress: opts.dress || null,
      codeKbContext: codeKb || null,
      codeGraphHint: opts.codeGraphHint,
      localCli: opts.localCli,
      onEvent: opts.onEvent as HtmlGenerateOptions["onEvent"],
      signal: opts.signal,
      onPhase: opts.onPhase,
      onRepair: opts.onRepair,
      onStructureDone: opts.onStructureDone,
      onBlockDone: opts.onBlockDone,
      concurrency: opts.concurrency,
    });
    extracted = pipeline.html;
    rawText = pipeline.rawText;
    promptChars = pipeline.promptChars;
    pipelineTitle = pipeline.title || workingTitle;
    pipelineFailedIds = pipeline.failedBlockIds || [];
    pipelineQualityNote = pipeline.qualityIssue || null;
  } else {
    const prompt = buildHtmlGeneratePrompt({
      title: workingTitle,
      brief,
      genre,
      scope: source,
      dress: opts.dress || null,
      codeKbContext: codeKb || null,
      codeGraphHint: opts.codeGraphHint,
      evidencePackRich: codeKb.length >= 2000,
    });
    promptChars = prompt.length;
    const agent = new LocalCliAgent({
      source,
      mode: "chat",
      localCli: opts.localCli,
      contextLabel: "html-generate",
      onEvent: opts.onEvent,
    });
    const result = await agent.query(prompt, opts.signal);
    rawText = String(result.rawText ?? result.answer ?? "").trim();
    if (!rawText) throw new Error("Agent returned empty output");
    extracted = extractHtmlFromAgentOutput(rawText) || rawText;
  }

  if (!/<html[\s>]/i.test(extracted) && !/<!DOCTYPE html/i.test(extracted)) {
    throw new Error("Agent output did not include a parseable HTML document");
  }

  const knownPaths = extractKnownPathsFromEvidence(codeKb);
  const qualityCtxBase: HtmlQualityContext = {
    genre,
    dress: opts.dress || null,
    hadCodeEvidence: codeKb.length > 0,
    knownPaths: knownPaths.length ? knownPaths : undefined,
  };

  // Multi-agent assemble owns the OpenCode Drive journey shell + CSS.
  // NEVER whole-doc repair that shell — agents invent wrap/hero/beat layouts and
  // destroy center-rail geometry (see Open-Inspect left/right zigzag regression).
  const isJourneyShell = (html: string) => {
    const h = String(html || "");
    if (!/data-gw-journey\b/i.test(h)) return false;
    if (!/class=["'][^"']*\bjourney\b/i.test(h)) return false;
    // Forbidden agent shells
    if (/\bclass=["'][^"']*\bwrap\b/i.test(h)) return false;
    if (/\bclass=["'][^"']*\bbeat\b/i.test(h)) return false;
    if (/\bclass=["'][^"']*\bhero\b/i.test(h)) return false;
    // Forbidden left/right zigzag CSS (Open-Inspect failure mode)
    if (/nth-child\s*\(\s*even\s*\)/i.test(h) && /margin-left\s*:\s*50%/i.test(h)) return false;
    if (/\.beat\b/i.test(h) && /margin-left\s*:\s*50%/i.test(h)) return false;
    return true;
  };

  let pipelineAssembled = multiAgent && isJourneyShell(extracted);
  // Pipeline path: ship assembled HTML as-is (never inject dress CSS that can fight geometry).
  // One-shot debug path: may finalize + repair, but never ship zigzag wrap/beat dumps.
  let finalized = pipelineAssembled
    ? { extracted, html: extracted }
    : finalizeHtmlDocument(extracted, opts.dress);
  let qualityIssue =
    htmlArtifactQualityIssue(finalized.html, {
      ...qualityCtxBase,
      extractedHtml: extracted,
      rawText,
    }) || pipelineQualityNote;

  let repaired = false;
  // Only one-shot (non-pipeline) may attempt whole-doc repair — and only if
  // the repair still yields a journey shell.
  if (qualityIssue && !pipelineAssembled && !multiAgent) {
    try {
      opts.onRepair?.(qualityIssue);
    } catch {
      /* ignore */
    }
    const repairAgent = new LocalCliAgent({
      source,
      mode: "chat",
      localCli: opts.localCli,
      contextLabel: "html-generate-repair",
      onEvent: opts.onEvent,
    });
    const repairPrompt = buildHtmlRepairPrompt({
      issue: qualityIssue,
      priorHtml: finalized.extracted.slice(0, 80_000),
      title: pipelineTitle,
      brief,
      genre,
      scope: source,
      dress: opts.dress || null,
    });
    try {
      const repairResult = await repairAgent.query(repairPrompt, opts.signal);
      const repairRaw = String(repairResult.rawText ?? repairResult.answer ?? "").trim();
      if (repairRaw) {
        rawText = `${rawText}\n\n---REPAIR---\n${repairRaw}`.slice(0, 512_000);
        const repairExtracted = extractHtmlFromAgentOutput(repairRaw) || repairRaw;
        if (
          (/<html[\s>]/i.test(repairExtracted) || /<!DOCTYPE html/i.test(repairExtracted)) &&
          isJourneyShell(repairExtracted) &&
          // Reject wrap/hero/beat dumps — keep prior if repair destroys geometry.
          !/\bclass=["'][^"']*\b(wrap|beat|hero)\b/i.test(repairExtracted)
        ) {
          extracted = repairExtracted;
          finalized = finalizeHtmlDocument(extracted, opts.dress);
          repaired = true;
          qualityIssue = htmlArtifactQualityIssue(finalized.html, {
            ...qualityCtxBase,
            extractedHtml: extracted,
            rawText: repairRaw,
          });
        }
      }
    } catch {
      // Keep first attempt
    }
  } else if (qualityIssue && pipelineAssembled) {
    // Surface the note; keep the locked journey shell intact.
    repaired = false;
  }

  // Nuclear: multi-agent product path MUST ship center-rail shell. Never left/right zigzag.
  if (multiAgent && !isJourneyShell(finalized.html)) {
    throw new Error(
      "HTML multi-agent pipeline did not produce an OpenCode center-rail journey shell (refusing wrap/hero/beat or left-right zigzag layout). Regenerate.",
    );
  }
  if (!multiAgent && !isJourneyShell(finalized.html)) {
    qualityIssue =
      qualityIssue ||
      "output was not an OpenCode-style centered journey shell; use multi-agent pipeline";
  }

  const title =
    extractTitleFromHtml(finalized.html) ||
    pipelineTitle ||
    titleFromBrief(brief, genre, source);

  return {
    html: finalized.html,
    title,
    genre,
    rawText: rawText.slice(0, 512_000),
    promptChars,
    evidenceChars: codeKb.length,
    qualityIssue: qualityIssue || null,
    repaired,
    failedBlockIds: pipelineFailedIds.length ? pipelineFailedIds : undefined,
  };
}
