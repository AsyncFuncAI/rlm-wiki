/**
 * HTML multi-agent pipeline (Doc/wiki-style):
 *   1) Blueprint agent → L1–L10 structure (code-graph grounded)
 *   2) Parallel block agents → one timeline entry each
 *   3) Deterministic assemble → single-file journey HTML
 *
 * Visual language inspired by prime-volume / OpenCode Drive journey:
 * center rail, note cards, kickers, terminal/code entries, tight mono type.
 */
import type { LocalCliConfig } from "./local-cli-events.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { RLMEvent } from "./jcode-runtime.ts";

/** Avoid circular import with html-generate.ts — mirror dress/genre shapes only. */
export type HtmlDressPromptInput = {
  id: string;
  label: string;
  summary: string;
  theme: "light" | "dark";
  cssContract: string;
  layoutRules: string;
  cssRoot: string;
};

export type HtmlGenre = "tour" | "map" | "impact" | "trace" | "concepts";

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

function normalizeHtmlGenre(value: unknown): HtmlGenre {
  const raw = String(value || "").trim().toLowerCase();
  return LEGACY_GENRE[raw] || "tour";
}

export type HtmlLevelId =
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6"
  | "L7"
  | "L8"
  | "L9"
  | "L10";

/** Beat shapes agents may plan. Unknown / off-level types coerce to note. */
export type HtmlBeatType =
  | "note"
  | "term"
  | "table"
  | "callout"
  | "steps"
  | "files"
  | "flow"
  | "terms"
  | "facts";

export const HTML_BEAT_TYPES: HtmlBeatType[] = [
  "note",
  "term",
  "table",
  "callout",
  "steps",
  "files",
  "flow",
  "terms",
  "facts",
];

/** Hard allowlist: wrong type for a level silently becomes note. */
export const ALLOWED_BEATS_BY_LEVEL: Record<HtmlLevelId, readonly HtmlBeatType[]> = {
  L1: ["note", "term", "facts"],
  L2: ["note", "term", "callout"],
  L3: ["note", "terms", "flow", "table"],
  L4: ["note", "term", "table"],
  L5: ["note", "term", "callout"],
  L6: ["note", "table", "callout"],
  L7: ["note", "term", "steps", "callout"],
  L8: ["note", "files", "table"],
  L9: ["note", "term", "flow"],
  L10: ["note", "table", "callout"],
};

export function isHtmlBeatType(value: string): value is HtmlBeatType {
  return (HTML_BEAT_TYPES as string[]).includes(value);
}

/** Coerce raw beat type for a level (unknown or disallowed → note). */
export function coerceBeatTypeForLevel(raw: string, levelId: HtmlLevelId): HtmlBeatType {
  const t = String(raw || "note").toLowerCase().trim();
  if (!isHtmlBeatType(t)) return "note";
  const allowed = ALLOWED_BEATS_BY_LEVEL[levelId] || ["note"];
  return allowed.includes(t) ? t : "note";
}

/** One expandable deep beat chained under a level anchor (not the only card). */
export type HtmlBlueprintBeat = {
  type: HtmlBeatType;
  title: string;
  /** What this beat must prove (paths/symbols). */
  prove: string;
};

export type HtmlBlueprintSection = {
  id: HtmlLevelId;
  kicker: string;
  title: string;
  intent: string;
  mustInclude: string;
  visual: "none" | "table" | "code" | "diagram" | "list";
  /**
   * Chainable deep beats (2–5). Anchor stays on the rail; beats expand in a
   * Fluid-Functionalism-style disclosure chain (not a single dump card).
   */
  beats: HtmlBlueprintBeat[];
};

export type HtmlBlueprint = {
  title: string;
  coreNoun: string;
  sections: HtmlBlueprintSection[];
};

/** Default rich chain plan per level when blueprint omits beats. */
export function defaultBeatsForLevel(id: HtmlLevelId): HtmlBlueprintBeat[] {
  const plans: Record<HtmlLevelId, HtmlBlueprintBeat[]> = {
    L1: [
      { type: "facts", title: "Repo at a glance", prove: "language, entry command, key dep from pack" },
      { type: "note", title: "Who it is for", prove: "README audience / user scenario" },
      { type: "term", title: "One concrete run", prove: "quickstart command from docs" },
    ],
    L2: [
      { type: "note", title: "Product stake", prove: "README framing / problem statement" },
      { type: "callout", title: "What it is not", prove: "explicit non-goals or rename residue" },
    ],
    L3: [
      { type: "terms", title: "Core noun and satellites", prove: "AGENTS.md or architecture map" },
      { type: "note", title: "Model in one breath", prove: "how the pieces fit" },
    ],
    L4: [
      { type: "table", title: "Stack that pays rent", prove: "package.json / Cargo.toml / lockfiles" },
      { type: "note", title: "Core vs optional", prove: "optional cloud/auth packages if any" },
      { type: "term", title: "Manifest evidence", prove: "key deps lines" },
    ],
    L5: [
      { type: "note", title: "Pattern A with proof", prove: "file:symbol" },
      { type: "note", title: "Pattern B with proof", prove: "file:symbol" },
      { type: "term", title: "Code that embodies the pattern", prove: "source excerpt" },
      { type: "callout", title: "What breaks if ignored", prove: "callers / boundary files" },
    ],
    L6: [
      { type: "note", title: "Unusual mechanism", prove: "non-obvious module path" },
      { type: "callout", title: "Fossil or rename residue", prove: "legacy package names" },
      { type: "table", title: "Surprises vs pitch", prove: "README claim vs tree" },
    ],
    L7: [
      { type: "steps", title: "First 10 minutes", prove: "real install/run commands from docs" },
      { type: "term", title: "First success signal", prove: "what green looks like" },
      { type: "callout", title: "Common trap", prove: "gotcha path or env var" },
    ],
    L8: [
      { type: "files", title: "Open these in order", prove: "3–8 real paths + why" },
      { type: "note", title: "Safe first open", prove: "lowest-risk file" },
    ],
    L9: [
      { type: "flow", title: "Happy path through code", prove: "entry → core transaction symbols" },
      { type: "term", title: "Critical function", prove: "file:line or symbol" },
    ],
    L10: [
      { type: "table", title: "Worth borrowing", prove: "practice → path" },
      { type: "note", title: "Recurring convention", prove: "example files" },
      { type: "callout", title: "Anti-pattern to avoid copying", prove: "counterexample path" },
    ],
  };
  return plans[id] || [];
}

/**
 * Standing voice rule for HTML journeys (technical readers who do not live in
 * this codebase day-to-day). Always inject into blueprint/block prompts.
 */
export const HTML_AUDIENCE_VOICE_REMINDER = [
  "AUDIENCE VOICE (always):",
  "The reader is technical but does not read this codebase day-to-day.",
  "Responding with code or pointing at files is fine — do not assume they already know what a given variable, function, or module does; introduce it briefly on first mention.",
].join("\n");

/**
 * When the user filled the compose note/brief: it steers depth and voice for
 * the whole L1–L10 journey. Levels still all run; brief does not replace the shell.
 */
export function htmlUserBriefSteeringReminder(brief: string): string {
  const b = String(brief || "").trim();
  if (!b) return "";
  return [
    "USER NOTE STEERING (non-empty brief present):",
    "The user note below steers depth and voice for the WHOLE L1–L10 journey.",
    "L1–L10 still all run. Do not drop levels, invent a different shell, or replace the center-rail journey with a freeform essay.",
    "Use the note to emphasize what matters (audience, lens, depth) while keeping every level grounded in real paths.",
  ].join("\n");
}

export type HtmlTimelineBlock = {
  id: HtmlLevelId;
  html: string;
  rawText: string;
  failed?: boolean;
};

export const HTML_LEVEL_ORDER: HtmlLevelId[] = [
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
];

/** Canonical L1–L10 product contract (fallback + blueprint seed). */
export const HTML_LEVEL_SPECS: Record<
  HtmlLevelId,
  { kicker: string; defaultTitle: string; intent: string; visual: HtmlBlueprintSection["visual"] }
> = {
  L1: {
    kicker: "L1 · What is this",
    defaultTitle: "What is this product",
    intent: "Plain language what it is, who it is for, one concrete scenario.",
    visual: "none",
  },
  L2: {
    kicker: "L2 · Why it exists",
    defaultTitle: "Why it exists",
    intent: "Human stake and product posture. Not marketing.",
    visual: "none",
  },
  L3: {
    kicker: "L3 · Mental model",
    defaultTitle: "Mental model in one breath",
    intent: "One core noun + 3–5 named pieces of the system.",
    visual: "list",
  },
  L4: {
    kicker: "L4 · Tech stack",
    defaultTitle: "Stack that pays rent",
    intent:
      "Table: layer, library, purpose IN THIS REPO, path, core vs optional. Cap ~12 rows. Not package.json dump.",
    visual: "table",
  },
  L5: {
    kicker: "L5 · Patterns here",
    defaultTitle: "Patterns and system design of this repo",
    intent:
      "3–6 plain-English pattern cards with path/symbol proof and what breaks if ignored. No GoF lecture.",
    visual: "list",
  },
  L6: {
    kicker: "L6 · Unusual",
    defaultTitle: "What makes this repo unusual",
    intent: "Differentiators, non-obvious engineering, fossils/rename residue. Not feature marketing.",
    visual: "none",
  },
  L7: {
    kicker: "L7 · First 10 minutes",
    defaultTitle: "First 10 minutes",
    intent: "How someone opens, runs, or tries it. Real commands only.",
    visual: "code",
  },
  L8: {
    kicker: "L8 · Guided entry",
    defaultTitle: "Open these files in order",
    intent: "3–8 real files in reading order with one-line why open this.",
    visual: "list",
  },
  L9: {
    kicker: "L9 · Primary path",
    defaultTitle: "Primary story path",
    intent: "One end-to-end journey through the code with real symbols. Diagram optional.",
    visual: "code",
  },
  L10: {
    kicker: "L10 · Worth borrowing",
    defaultTitle: "Common recurring patterns, best practices, worth borrowing",
    intent:
      "Recurring patterns and practices in THIS repo worth copying elsewhere. Concrete, with paths. Not generic advice.",
    visual: "table",
  },
};

export function defaultHtmlBlueprint(title: string, coreNoun = "system"): HtmlBlueprint {
  return {
    title: title || "Repository tour",
    coreNoun,
    sections: HTML_LEVEL_ORDER.map((id) => {
      const spec = HTML_LEVEL_SPECS[id];
      return {
        id,
        kicker: spec.kicker,
        title: spec.defaultTitle,
        intent: spec.intent,
        mustInclude: "",
        visual: spec.visual,
        beats: defaultBeatsForLevel(id),
      };
    }),
  };
}

export function buildHtmlBlueprintPrompt(input: {
  title: string;
  brief: string;
  genre: HtmlGenre;
  scope: string;
  codeKbContext?: string | null;
}): string {
  const codeKb = String(input.codeKbContext || "").trim();
  const levels = HTML_LEVEL_ORDER.map((id) => {
    const s = HTML_LEVEL_SPECS[id];
    return `- ${id}: ${s.kicker} — ${s.intent}`;
  }).join("\n");
  return [
    "You are planning a single-file progressive onboarding HTML (timeline journey).",
    "Do NOT write the HTML yet. Output only a grounded L1–L10 BLUEPRINT in XML.",
    "",
    "PRODUCT CONTRACT (fixed section order):",
    levels,
    "",
    "Rules:",
    "- Ground every section in the repository evidence below (or checkout if pack is thin).",
    "- Prefer real paths and symbols. Do not invent package names.",
    "- Titles must be concrete for THIS repo (not generic).",
    "- must_include: comma-separated real paths/symbols the block agent must use (0–8 items).",
    "- visual: one of none | table | code | diagram | list.",
    "- core_noun: the one noun that organizes the system (e.g. session, agent, pipeline).",
    "- Each section is a LINEAR scroll segment: short ANCHOR note, then 2–5 always-visible beats on the center rail.",
    "- No click-to-expand chains. The reader scrolls top → bottom through a guided journey.",
    "- beat types (level-allowlisted): note | term | table | callout | steps | files | flow | terms | facts.",
    "  L1 facts; L3 terms; L7 steps; L8 files; L9 flow; callout tip/warning/fossil; prove = path/symbol.",
    "- Off-level or unknown beat types are coerced to note. Prefer the shapes above over walls of prose.",
    "- Plan beats so technical symbols are introduced in plain language before dense code.",
    "",
    HTML_AUDIENCE_VOICE_REMINDER,
    "",
    htmlUserBriefSteeringReminder(input.brief),
    "",
    `Working title hint: ${input.title}`,
    `Scope: ${input.scope}`,
    `Job lens: ${input.genre}`,
    "",
    "User brief:",
    input.brief,
    "",
    codeKb
      ? ["CODE GRAPH + EVIDENCE PACK (primary grounding):", codeKb, ""].join("\n")
      : "No prefetched evidence pack. Infer carefully from checkout tools if available.\n",
    "Output EXACTLY this XML shape (no markdown fence required):",
    "<html_blueprint>",
    `  <title>${input.title}</title>`,
    "  <core_noun>...</core_noun>",
    "  <section id=\"L1\">",
    "    <kicker>L1 · What is this</kicker>",
    "    <title>...</title>",
    "    <intent>hook only — one breath</intent>",
    "    <must_include>path/a.ts, symbol.Foo</must_include>",
    "    <visual>none</visual>",
    "    <beat type=\"facts\" title=\"Repo at a glance\" prove=\"language, entry command\"/>",
    "    <beat type=\"note\" title=\"Who it is for\" prove=\"README audience\"/>",
    "    <beat type=\"term\" title=\"One concrete run\" prove=\"quickstart command\"/>",
    "  </section>",
    "  <!-- L2 … L10 same shape; each section 2–5 beats; use steps/files/flow/terms/callout where allowlisted -->",
    "</html_blueprint>",
    "All ten sections L1–L10 are required. Each section needs 2–5 beats.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function xmlText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return (m?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseHtmlBlueprintXml(raw: string, fallbackTitle = "Repository tour"): HtmlBlueprint {
  const text = String(raw || "");
  const xmlMatch =
    text.match(/<html_blueprint[\s\S]*?<\/html_blueprint>/i) ||
    text.match(/```(?:xml)?\s*([\s\S]*?)```/i);
  const xml = xmlMatch
    ? xmlMatch[0].startsWith("```")
      ? xmlMatch[1] || ""
      : xmlMatch[0]
    : text;
  const title = xmlText(xml, "title") || fallbackTitle;
  const coreNoun = xmlText(xml, "core_noun") || "system";
  const sectionBlocks = [...xml.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)].map((m) => m[0]);
  const byId = new Map<string, HtmlBlueprintSection>();
  for (const block of sectionBlocks) {
    const idRaw = (block.match(/id\s*=\s*["']?(L1[0]|L[1-9])["']?/i)?.[1] || "").toUpperCase();
    const id = (HTML_LEVEL_ORDER.includes(idRaw as HtmlLevelId) ? idRaw : "") as HtmlLevelId | "";
    if (!id) continue;
    const visualRaw = xmlText(block, "visual").toLowerCase();
    const visual = (["none", "table", "code", "diagram", "list"].includes(visualRaw)
      ? visualRaw
      : HTML_LEVEL_SPECS[id].visual) as HtmlBlueprintSection["visual"];
    const beats: HtmlBlueprintBeat[] = [];
    const beatTypeAttr =
      "note|term|table|callout|steps|files|flow|terms|facts|quote|compare";
    for (const beat of block.matchAll(/<beat\b([^>]*)\/?>/gi)) {
      const attrs = beat[1] || "";
      const typeRaw = (
        attrs.match(new RegExp(`\\btype\\s*=\\s*["']?(${beatTypeAttr})["']?`, "i"))?.[1] || "note"
      ).toLowerCase();
      const type = coerceBeatTypeForLevel(typeRaw, id);
      const bTitle = attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1] || "Deep dive";
      const prove = attrs.match(/\bprove\s*=\s*["']([^"']+)["']/i)?.[1] || "";
      beats.push({ type, title: bTitle.trim(), prove: prove.trim() });
    }
    // Also support <beat>...</beat> with nested prove tag
    for (const beat of block.matchAll(/<beat\b([^>]*)>([\s\S]*?)<\/beat>/gi)) {
      if (beats.length >= 5) break;
      const attrs = beat[1] || "";
      const inner = beat[2] || "";
      const typeRaw = (
        attrs.match(new RegExp(`\\btype\\s*=\\s*["']?(${beatTypeAttr})["']?`, "i"))?.[1] || "note"
      ).toLowerCase();
      const type = coerceBeatTypeForLevel(typeRaw, id);
      const bTitle =
        attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1] ||
        xmlText(inner, "title") ||
        "Deep dive";
      const prove =
        attrs.match(/\bprove\s*=\s*["']([^"']+)["']/i)?.[1] ||
        xmlText(inner, "prove") ||
        "";
      if (!beats.some((b) => b.title === bTitle.trim())) {
        beats.push({ type, title: bTitle.trim(), prove: prove.trim() });
      }
    }
    byId.set(id, {
      id,
      kicker: xmlText(block, "kicker") || HTML_LEVEL_SPECS[id].kicker,
      title: xmlText(block, "title") || HTML_LEVEL_SPECS[id].defaultTitle,
      intent: xmlText(block, "intent") || HTML_LEVEL_SPECS[id].intent,
      mustInclude: xmlText(block, "must_include"),
      visual,
      beats: beats.length >= 2 ? beats.slice(0, 5) : defaultBeatsForLevel(id),
    });
  }
  const base = defaultHtmlBlueprint(title, coreNoun);
  return {
    title,
    coreNoun,
    sections: base.sections.map((s) => byId.get(s.id) || s),
  };
}

/** Cap for per-block evidence (not the full pack — Docs-style unit budgets). */
export const HTML_BLOCK_EVIDENCE_MAX = 6_000;

/**
 * Slim section-scoped evidence: prefer must_include paths + nearby inventory lines
 * from the fat pack. Avoids 10× full-pack token cost.
 */
export function slimEvidenceForSection(
  codeKb: string,
  section: HtmlBlueprintSection,
  maxChars = HTML_BLOCK_EVIDENCE_MAX,
): string {
  const pack = String(codeKb || "").trim();
  if (!pack) return "";
  const needles = String(section.mustInclude || "")
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!needles.length) {
    // Shared inventory head only
    return pack.slice(0, Math.min(maxChars, 3500));
  }
  const lines = pack.split("\n");
  const kept: string[] = [];
  const lowerNeedles = needles.map((n) => n.toLowerCase());
  for (const line of lines) {
    const l = line.toLowerCase();
    if (lowerNeedles.some((n) => n && l.includes(n))) kept.push(line);
  }
  let out = [
    `Section ${section.id} focus paths: ${needles.join(", ")}`,
    "",
    kept.length ? kept.join("\n") : pack.slice(0, 2500),
  ].join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

/** Compact markup contracts for planned beat types only (keeps prompts lean). */
export function beatContractSnippets(types: HtmlBeatType[]): string[] {
  const uniq = [...new Set(types)];
  const lines: string[] = ["BEAT CONTRACTS (only types planned for this level — emit exact class roots):"];
  for (const t of uniq) {
    switch (t) {
      case "note":
        lines.push(
          '- note: <article class="entry note"> note-kicker / note-title / note-body (460px). Introduce symbols briefly on first mention.',
        );
        break;
      case "term":
        lines.push(
          '- term: <figure class="entry term-entry"><div class="term"><div class="term-bar"><span>$ shell | path · Lx–y</span><span class="verbatim">…</span></div><pre>…</pre></div><p class="term-caption">…</p></figure>',
        );
        break;
      case "table":
        lines.push(
          '- table: <figure class="entry table-entry"><div class="table-scroll"><table class="claims">…</table></div></figure> (≤12 rows).',
        );
        break;
      case "callout":
        lines.push(
          '- callout: <article class="entry note callout callout-warning|callout-tip|callout-fossil"><p class="callout-kicker">…</p><p class="callout-body">…</p></article> (max 1 per level).',
        );
        break;
      case "steps":
        lines.push(
          '- steps: <figure class="entry steps-entry"><ol class="steps"><li class="step"><span class="step-title">…</span><div class="step-body">…</div></li></ol></figure> (3–7 real commands).',
        );
        break;
      case "files":
        lines.push(
          '- files: <figure class="entry files-entry"><ol class="files"><li class="file"><code class="file-path path-chip">path</code><span class="file-why">why ≤12 words</span></li></ol></figure> (3–8 rows).',
        );
        break;
      case "flow":
        lines.push(
          '- flow: <figure class="entry flow-entry"><ol class="flow"><li class="flow-node"><span class="flow-symbol">…</span><code class="flow-path path-chip">path</code><span class="flow-note">…</span></li></ol></figure> (3–7 linear nodes).',
        );
        break;
      case "terms":
        lines.push(
          '- terms: <article class="entry note terms-entry"><p class="note-kicker">…</p><h2 class="note-title">…</h2><dl class="terms"><dt>…</dt><dd>… <code class="path-chip">path</code></dd></dl></article> (3–6).',
        );
        break;
      case "facts":
        lines.push(
          '- facts: <figure class="entry facts-entry"><div class="meta-strip"><span><b>val</b> label</span>…</div></figure> (4–7 verifiable facts, zero adjectives).',
        );
        break;
      default:
        break;
    }
  }
  return lines;
}

export function buildHtmlBlockPrompt(input: {
  section: HtmlBlueprintSection;
  blueprint: HtmlBlueprint;
  brief: string;
  genre: HtmlGenre;
  scope: string;
  /** Prefer slim section evidence; full pack only as last resort. */
  codeKbContext?: string | null;
  theme: "light" | "dark";
}): string {
  const s = input.section;
  const codeKb = slimEvidenceForSection(String(input.codeKbContext || ""), s);
  const beats = s.beats?.length ? s.beats : defaultBeatsForLevel(s.id);
  const beatPlan = beats
    .map((b, i) => `  ${i + 1}. [${b.type}] ${b.title} — prove: ${b.prove || "real path"}`)
    .join("\n");
  const plannedTypes = beats.map((b) => b.type);
  const contracts = beatContractSnippets(plannedTypes);
  const packBudget =
    "Hard budget: at most 4 verification lookups (prefer must_include + beat prove paths), then WRITE the level segment.";
  const hardShape =
    s.id === "L7"
      ? "HARD: this level MUST include figure.entry.steps-entry."
      : s.id === "L8"
        ? "HARD: this level MUST include figure.entry.files-entry."
        : s.id === "L9"
          ? "HARD: this level MUST include figure.entry.flow-entry."
          : "";
  return [
    `Write ONE rich LEVEL SEGMENT for ${s.id}. Not a full HTML document. Not a single dump card.`,
    "",
    "ARCHITECTURE — GUIDED SCROLL (no click gates):",
    "- The reader scrolls top → bottom. Do NOT use <details>, chain-toggle, Expand, or click-to-reveal.",
    "- Order on the center rail: (1) short anchor note that orients, (2) planned beat shapes in order, each always visible.",
    "- Keep the level scannable: short notes, one primary rich shape, not a wall of undifferentiated prose.",
    "- Before any dense code/path dump: one sentence that introduces what the function/module/path is for (technical reader, not day-to-day in this repo).",
    "",
    "Visual language (prime-volume center rail):",
    "Centered vertical timeline. System CSS owns widths. You emit a level-segment only.",
    "",
    "REQUIRED SHAPE (exact OpenCode Drive classes — NEVER wrap/hero/beat/page/card/details/chain-toggle):",
    "```html",
    `<section class="level-segment" data-level="${s.id}" id="l${s.id.replace("L", "")}">`,
    `  <article class="entry note" style="--index: 0">`,
    `    <p class="note-kicker">${s.kicker}</p>`,
    "    <h2 class=\"note-title\">Concrete hook title</h2>",
    "    <p class=\"note-body\">Orient the reader. Introduce any core noun/symbol briefly before deeper blocks.</p>",
    "  </article>",
    "  <!-- always-visible rail children in order: facts / terms / steps / files / flow / table / term / callout / note -->",
    "  <figure class=\"entry …-entry\" style=\"--index: 1\">…</figure>",
    "  <article class=\"entry note\" style=\"--index: 2\">…</article>",
    "</section>",
    "```",
    "",
    ...contracts,
    "",
    hardShape,
    "FORBIDDEN: wrap, hero, beat, page, card, panel, toc, breath, <details>, chain-toggle, Expand, left-rail dots, custom width/margin, tabs, mermaid.",
    "Rules:",
    "- Linear scroll only. Every beat is visible without a click.",
    "- Anchor first, then evidence shapes. Cap density: prefer one primary rich block + short notes.",
    "- Every path/symbol is introduced in plain language on first mention.",
    "- Every beat cites real paths. No invented packages.",
    "- System CSS owns centering (margin: 0 auto on .entry; .note is min(460px)).",
    "- No <!DOCTYPE>, no <html>, no global CSS, no remote CDNs, no em-dashes.",
    "",
    HTML_AUDIENCE_VOICE_REMINDER,
    "",
    htmlUserBriefSteeringReminder(input.brief),
    "",
    `Repository: ${input.scope}`,
    `Document title: ${input.blueprint.title}`,
    `Core noun: ${input.blueprint.coreNoun}`,
    `Job lens: ${input.genre}`,
    `Theme: ${input.theme}`,
    "",
    "SECTION CONTRACT:",
    `- id: ${s.id}`,
    `- kicker: ${s.kicker}`,
    `- title: ${s.title}`,
    `- anchor intent: ${s.intent}`,
    `- must_include: ${s.mustInclude || "(ground in real paths)"}`,
    `- preferred visual: ${s.visual}`,
    "",
    "CHAIN BEATS TO SHIP (in order):",
    beatPlan,
    "",
    "User brief (truncated):",
    input.brief.slice(0, 1200),
    "",
    packBudget,
    codeKb ? ["", "SECTION EVIDENCE (scoped):", codeKb].join("\n") : "",
    "",
    "Output markers (required):",
    `<!--GW_BLOCK_START ${s.id}-->`,
    "...level-segment markup only...",
    "<!--GW_BLOCK_END-->",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function extractHtmlBlock(raw: string, levelId: HtmlLevelId): string | null {
  const text = String(raw || "");
  const marked = text.match(
    new RegExp(
      `<!--GW_BLOCK_START\\s*${levelId}\\s*-->([\\s\\S]*?)<!--GW_BLOCK_END-->`,
      "i",
    ),
  );
  if (marked?.[1]?.trim()) return marked[1].trim();
  const anyBlock = text.match(/<!--GW_BLOCK_START[^>]*-->([\s\S]*?)<!--GW_BLOCK_END-->/i);
  if (anyBlock?.[1]?.trim()) return anyBlock[1].trim();
  const segment = text.match(
    /<section\b[^>]*class=["'][^"']*level-segment[^"']*["'][\s\S]*?<\/section>/i,
  );
  if (segment?.[0]?.trim()) return segment[0].trim();
  if ((text.match(/<article\b|<figure\b|<details\b/gi) || []).length >= 2) {
    return text.trim() || null;
  }
  const article = text.match(/<article\b[\s\S]*?<\/article>/i);
  if (article?.[0]?.trim()) return article[0].trim();
  return null;
}

function fallbackBeatHtml(b: HtmlBlueprintBeat, section: HtmlBlueprintSection, i: number): string {
  const prove = b.prove ? ` Prove with <code class="path-chip">${escapeHtml(b.prove)}</code>.` : "";
  const idx = i + 1;
  switch (b.type) {
    case "term":
      return `<figure class="entry term-entry" style="--index: ${idx}">
  <div class="term"><div class="term-bar"><span>${escapeHtml(b.title)}</span><span class="verbatim">stub</span></div>
  <pre>// regenerate for full ${escapeHtml(section.id)} depth</pre></div>
  <p class="term-caption">${escapeHtml(b.title)}.${prove}</p>
</figure>`;
    case "table":
      return `<figure class="entry table-entry" style="--index: ${idx}">
  <div class="table-scroll"><table class="claims"><thead><tr><th>Item</th><th>Path</th></tr></thead>
  <tbody><tr><td>${escapeHtml(b.title)}</td><td><code class="path-chip">${escapeHtml(b.prove || "…")}</code></td></tr></tbody></table></div>
</figure>`;
    case "steps":
      return `<figure class="entry steps-entry" style="--index: ${idx}">
  <ol class="steps">
    <li class="step"><span class="step-title">${escapeHtml(b.title)}</span><div class="step-body">Regenerate for real commands.${prove}</div></li>
    <li class="step"><span class="step-title">Confirm green</span><div class="step-body">What success looks like.</div></li>
    <li class="step"><span class="step-title">Open the next level</span><div class="step-body">Continue the journey.</div></li>
  </ol>
</figure>`;
    case "files":
      return `<figure class="entry files-entry" style="--index: ${idx}">
  <ol class="files">
    <li class="file"><code class="file-path path-chip">${escapeHtml(b.prove || "README.md")}</code><span class="file-why">${escapeHtml(b.title)}</span><span class="file-badge">start here</span></li>
    <li class="file"><code class="file-path path-chip">package.json</code><span class="file-why">manifest and scripts</span></li>
    <li class="file"><code class="file-path path-chip">src/</code><span class="file-why">implementation root</span></li>
  </ol>
</figure>`;
    case "flow":
      return `<figure class="entry flow-entry" style="--index: ${idx}">
  <ol class="flow">
    <li class="flow-node"><span class="flow-symbol">Entry</span><code class="flow-path path-chip">${escapeHtml(b.prove || "src/main")}</code><span class="flow-note">${escapeHtml(b.title)}</span></li>
    <li class="flow-node"><span class="flow-symbol">Core</span><code class="flow-path path-chip">src/core</code><span class="flow-note">main transaction</span></li>
    <li class="flow-node"><span class="flow-symbol">Land</span><code class="flow-path path-chip">src/store</code><span class="flow-note">where state settles</span></li>
  </ol>
</figure>`;
    case "facts":
      return `<figure class="entry facts-entry" style="--index: ${idx}">
  <div class="meta-strip">
    <span><b>—</b> language</span>
    <span><b>—</b> entry</span>
    <span class="mono"><b>${escapeHtml(b.prove || "…")}</b></span>
    <span><b>stub</b> regenerate</span>
  </div>
</figure>`;
    case "terms":
      return `<article class="entry note terms-entry" style="--index: ${idx}">
  <p class="note-kicker">Deep · ${escapeHtml(section.id)}</p>
  <h2 class="note-title">${escapeHtml(b.title)}</h2>
  <dl class="terms">
    <dt>${escapeHtml(section.id === "L3" ? "core noun" : b.title)}</dt>
    <dd>${escapeHtml(section.intent)} <code class="path-chip">${escapeHtml(b.prove || "…")}</code></dd>
    <dt>satellite</dt>
    <dd>Regenerate for full glossary.</dd>
    <dt>boundary</dt>
    <dd>Where ownership ends.</dd>
  </dl>
</article>`;
    case "callout":
      return `<article class="entry note callout callout-warning" style="--index: ${idx}">
  <p class="callout-kicker">Watch</p>
  <p class="callout-body">${escapeHtml(b.title)}.${prove}</p>
</article>`;
    default:
      return `<article class="entry note" style="--index: ${idx}">
  <p class="note-kicker">Deep · ${escapeHtml(section.id)}</p>
  <h2 class="note-title">${escapeHtml(b.title)}</h2>
  <p class="note-body">${escapeHtml(section.intent)}.${prove}</p>
</article>`;
  }
}

export function fallbackBlockHtml(section: HtmlBlueprintSection, index = 0): string {
  const n = section.id.replace("L", "");
  const beats = section.beats?.length ? section.beats : defaultBeatsForLevel(section.id);
  // Linear rail only — no click-to-expand. Guided top-to-bottom scroll.
  const rail = beats.map((b, i) => fallbackBeatHtml(b, section, i)).join("\n");
  return `<section class="level-segment" data-level="${section.id}" id="l${n}">
  <article class="entry note" style="--index: ${index}">
    <p class="note-kicker">${escapeHtml(section.kicker)}</p>
    <h2 class="note-title">${escapeHtml(section.title)}</h2>
    <p class="note-body">${escapeHtml(section.intent)}${
      section.mustInclude ? ` Start with <code class="path-chip">${escapeHtml(section.mustInclude)}</code>.` : ""
    }</p>
  </article>
${rail}
</section>`;
}

/** Truthful chain-summary meta from beat types (e.g. "steps · files · 2 notes"). */
export function summarizeBeatTypes(beats: HtmlBlueprintBeat[]): string {
  const counts = new Map<string, number>();
  for (const b of beats) {
    counts.set(b.type, (counts.get(b.type) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [t, n] of counts) {
    parts.push(n === 1 ? t : `${n} ${t}`);
  }
  return parts.join(" · ") || "chain";
}

/** Infer chain-summary meta from rendered roots (normalize-time truthing). */
export function summarizeHtmlBlockRoots(html: string): string {
  const doc = String(html || "");
  const kinds: Array<[RegExp, string]> = [
    [/steps-entry/gi, "steps"],
    [/files-entry/gi, "files"],
    [/flow-entry/gi, "flow"],
    [/facts-entry/gi, "facts"],
    [/terms-entry/gi, "terms"],
    [/\bcallout\b/gi, "callout"],
    [/term-entry/gi, "term"],
    [/table-entry/gi, "table"],
    [/<article\b[^>]*class=["'][^"']*\bnote\b/gi, "note"],
  ];
  const parts: string[] = [];
  for (const [re, label] of kinds) {
    const n = (doc.match(re) || []).length;
    if (n === 1) parts.push(label);
    else if (n > 1) parts.push(`${n} ${label}`);
  }
  return parts.slice(0, 4).join(" · ") || "chain";
}

/**
 * Structural lint for a level segment after extract/normalize.
 * Hard fails mark the block failed (retry). Soft notes surface as qualityIssue.
 */
export function lintJourneyBlockHtml(
  levelId: HtmlLevelId,
  html: string,
): { hardFail: string | null; softNotes: string[] } {
  const doc = String(html || "");
  const softNotes: string[] = [];
  let hardFail: string | null = null;

  if (levelId === "L7" && !/steps-entry/i.test(doc)) {
    hardFail = "L7 missing steps-entry";
  } else if (levelId === "L8" && !/files-entry/i.test(doc)) {
    hardFail = "L8 missing files-entry";
  } else if (levelId === "L9" && !/flow-entry/i.test(doc)) {
    hardFail = "L9 missing flow-entry";
  } else if (levelId === "L3" && !/terms-entry|\bclass=["'][^"']*\bterms\b|<dl\b[^>]*\bterms\b/i.test(doc)) {
    hardFail = "L3 missing terms-entry";
  } else if (levelId === "L1" && !/facts-entry|meta-strip/i.test(doc)) {
    hardFail = "L1 missing facts-entry";
  }
  const calloutCount = (doc.match(/class=["'][^"']*\bcallout\b/gi) || []).length;
  if (calloutCount > 1) {
    softNotes.push(`${levelId} has ${calloutCount} callouts (max 1)`);
  }

  return { hardFail, softNotes };
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Exact prime-volume / OpenCode Drive journey layout.
 * Source of truth: https://prime-volume-fm2j.sharenow.today/
 * Notes are 460px centered on a 1040px rail; term/table entries are full rail width.
 * Dark dress maps via html[data-theme="dark"] overrides only (structure unchanged).
 */
export function htmlJourneyTimelineCss(): string {
  return `
/* === prime-volume journey (centered rail) === */
:root {
  color: #1d1d1f;
  background: #fff;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  font-synthesis: none;
  font-optical-sizing: auto;
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
html {
  background: #fff;
  scroll-padding-top: 75px;
}
body {
  margin: 0;
  min-width: 320px;
  background: #fff;
}
.journey {
  position: relative;
  width: min(1040px, calc(100% - 40px));
  margin: 0 auto;
  padding: 80px 0;
}
.journey:not(:empty)::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50% !important;
  width: 1px;
  content: "";
  background: #ededed;
  transform: translateX(-0.5px);
}
/* Center rail only — never alternating left/right beats */
.entry {
  position: relative;
  z-index: 1;
  float: none !important;
  clear: both !important;
  width: auto;
  max-width: 100%;
  margin: 0 auto 72px !important;
  margin-left: auto !important;
  margin-right: auto !important;
  left: auto !important;
  right: auto !important;
  transform: none;
  cursor: default;
}
.entry:last-child { margin-bottom: 0 !important; }
.entry:target { border-color: #0070f3; }
/* note cards: fixed 460px, auto-centered on the rail (never half-width zigzag) */
.note {
  display: block !important;
  float: none !important;
  width: min(460px, 100%) !important;
  max-width: min(460px, 100%) !important;
  margin-left: auto !important;
  margin-right: auto !important;
  padding: 20px 22px 21px;
  border: 1px solid #e9e9e9;
  border-radius: 10px;
  background: #fff;
  text-align: left;
}
.note-kicker {
  margin: 0 0 8px;
  color: #767676;
  font-size: 11px;
  font-weight: 550;
  line-height: 16px;
  letter-spacing: 0.065em;
  text-transform: uppercase;
}
.note-title, h2.note-title {
  margin: 0 0 8px;
  color: #171717;
  font-size: 14px;
  font-weight: 620;
  line-height: 20px;
  letter-spacing: -0.012em;
}
.note-body {
  margin: 0;
  color: #3f3f3f;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  letter-spacing: -0.004em;
}
.note-body p { margin: 0 0 10px; }
.note-body p:last-child { margin-bottom: 0; }
.note-body ul, .note-body ol {
  margin: 0 0 10px;
  padding-left: 1.15em;
}
.note-body li { margin: 0 0 4px; }
.note-body code,
.note-title code {
  padding: 0 3px;
  border-radius: 3px;
  background: #f4f4f4;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #171717;
}
/* full-rail companions (still centered via .entry margin auto) */
.term-entry,
.table-entry,
.image-entry {
  display: block;
  width: 100%;
  max-width: 1040px;
  margin-left: auto;
  margin-right: auto;
  padding: 7px;
  border: 1px solid #e8e8e8;
  border-radius: 12px;
  background: #fff;
}
.term {
  overflow: hidden;
  border-radius: 7px;
  background: #16181d;
}
.term-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid #2a2d34;
  color: #7d8590;
  font-size: 10px;
  font-weight: 550;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.term-bar .verbatim { color: #7ee2a8; }
.term pre {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  color: #d4dae3;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  tab-size: 4;
}
.term .prompt, .term .dim { color: #7d8590; user-select: none; }
.term .cmd { color: #9db4ff; font-weight: 600; }
.term .key { color: #7ee2a8; }
.term .hl {
  padding: 0 2px;
  border-radius: 3px;
  background: rgba(125, 155, 255, 0.18);
}
.term-caption,
.image-caption {
  margin: 0;
  padding: 11px 7px 5px;
  color: #777;
  font-size: 11px;
  line-height: 16px;
  letter-spacing: 0.005em;
  text-align: center;
}
.table-scroll {
  overflow-x: auto;
  border-radius: 7px;
  background: #fafafa;
}
.claims,
.note-body table {
  width: 100%;
  min-width: 0;
  border-collapse: collapse;
  font-size: 12.5px;
  line-height: 18px;
}
.claims { min-width: 640px; }
.claims th,
.note-body table th {
  padding: 10px 14px;
  border-bottom: 1px solid #e9e9e9;
  color: #767676;
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.07em;
  text-align: left;
  text-transform: uppercase;
}
.claims td,
.note-body table td {
  padding: 10px 14px;
  border-bottom: 1px solid #efefef;
  color: #3f3f3f;
  vertical-align: top;
}
.claims tr:last-child td { border-bottom: none; }
.claims .ref {
  color: #0070f3;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.claims .what { color: #171717; font-weight: 550; }
.claims code {
  padding: 0 3px;
  border-radius: 3px;
  background: #f0f0f0;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.meta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  justify-content: center;
  padding: 12px 14px;
  border-radius: 7px;
  background: #fafafa;
  font-size: 11.5px;
  color: #555;
}
.meta-strip b {
  color: #171717;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.meta-strip .mono {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.meta-strip .ready { color: #17804d; font-weight: 600; }
.muted { color: #767676; }

/* === reader blocks (MVP enrichment) === */
.path-chip {
  display: inline;
  padding: 0 4px;
  border-radius: 3px;
  background: #f0f0f0;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #171717;
  overflow-wrap: anywhere;
}
.facts-entry {
  display: block;
  width: 100%;
  max-width: 1040px;
  margin-left: auto !important;
  margin-right: auto !important;
  padding: 0;
  border: 0;
  background: transparent;
}
.callout {
  border-left: 2px solid #171717 !important;
  padding-left: 18px !important;
}
.callout-tip { border-left-color: #17804d !important; }
.callout-warning { border-left-color: #171717 !important; }
.callout-fossil { border-left-color: #9a9a96 !important; }
.callout-kicker {
  margin: 0 0 6px;
  color: #767676;
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0.065em;
  text-transform: uppercase;
}
.callout-body {
  margin: 0;
  color: #3f3f3f;
  font-size: 13px;
  line-height: 20px;
}
.terms-entry dl.terms,
dl.terms {
  margin: 8px 0 0;
  padding: 0;
}
.terms-entry dt,
dl.terms dt {
  margin: 10px 0 2px;
  color: #171717;
  font-size: 12.5px;
  font-weight: 620;
}
.terms-entry dd,
dl.terms dd {
  margin: 0 0 0 0;
  color: #3f3f3f;
  font-size: 13px;
  line-height: 20px;
}
.steps-entry,
.files-entry,
.flow-entry {
  display: block;
  width: 100%;
  max-width: 1040px;
  margin-left: auto !important;
  margin-right: auto !important;
  padding: 16px 18px 18px;
  border: 1px solid #e9e9e9;
  border-radius: 12px;
  background: #fff;
}
ol.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: gw-step;
}
li.step {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 10px 12px;
  align-items: start;
  margin: 0 0 14px;
  counter-increment: gw-step;
}
li.step:last-child { margin-bottom: 0; }
li.step::before {
  content: counter(gw-step);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: #f4f4f4;
  color: #171717;
  font-size: 11px;
  font-weight: 620;
  grid-row: 1 / span 2;
}
.step-title {
  display: block;
  color: #171717;
  font-size: 13px;
  font-weight: 620;
  line-height: 20px;
}
.step-body {
  grid-column: 2;
  color: #3f3f3f;
  font-size: 13px;
  line-height: 20px;
}
.step-body > :last-child { margin-bottom: 0; }
ol.files {
  margin: 0;
  padding: 0;
  list-style: none;
}
li.file {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  margin: 0;
  padding: 10px 0;
  border-bottom: 1px solid #efefef;
}
li.file:last-child { border-bottom: none; }
.file-path {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #171717;
  overflow-wrap: anywhere;
}
.file-why {
  flex: 1 1 12rem;
  color: #555;
  font-size: 12.5px;
  line-height: 18px;
}
.file-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid #e9e9e9;
  border-radius: 999px;
  color: #767676;
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
ol.flow {
  margin: 0;
  padding: 0;
  list-style: none;
}
li.flow-node {
  position: relative;
  display: grid;
  grid-template-columns: 7rem 1fr;
  gap: 4px 14px;
  margin: 0;
  padding: 0 0 18px 22px;
}
li.flow-node:last-child { padding-bottom: 0; }
li.flow-node::before {
  position: absolute;
  left: 5px;
  top: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #171717;
  content: "";
}
li.flow-node:not(:last-child)::after {
  position: absolute;
  left: 8px;
  top: 16px;
  bottom: 0;
  width: 1px;
  background: #e9e9e9;
  content: "";
}
.flow-symbol {
  grid-column: 1;
  color: #171717;
  font-size: 12.5px;
  font-weight: 620;
}
.flow-path {
  grid-column: 2;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #171717;
}
.flow-note {
  grid-column: 2;
  color: #555;
  font-size: 12.5px;
  line-height: 18px;
}
.quote-entry {
  display: block;
  width: min(460px, 100%);
  margin-left: auto !important;
  margin-right: auto !important;
}
blockquote.quote {
  margin: 0;
  padding: 14px 16px;
  border: 1px solid #e9e9e9;
  border-radius: 10px;
  background: #fafafa;
  color: #3f3f3f;
  font-size: 13px;
  line-height: 20px;
}
blockquote.quote cite {
  display: block;
  margin-top: 8px;
  color: #767676;
  font-size: 11.5px;
  font-style: normal;
}

/* Dark twin (void-ink) — same geometry, inverted surfaces */
html[data-theme="dark"] {
  color-scheme: dark;
  background: #0c0c0c;
  color: #f2f2f0;
}
html[data-theme="dark"] body { background: #0c0c0c; }
html[data-theme="dark"] .journey:not(:empty)::before { background: #2a2a28; }
html[data-theme="dark"] .note {
  background: #141414;
  border-color: #2a2a28;
  color: #f2f2f0;
}
html[data-theme="dark"] .note-kicker { color: #9a9a96; }
html[data-theme="dark"] .note-title,
html[data-theme="dark"] h2.note-title { color: #f2f2f0; }
html[data-theme="dark"] .note-body { color: #c8c8c4; }
html[data-theme="dark"] .note-body code,
html[data-theme="dark"] .note-title code {
  background: #1c1c1a;
  color: #f2f2f0;
}
html[data-theme="dark"] .term-entry,
html[data-theme="dark"] .table-entry,
html[data-theme="dark"] .image-entry,
html[data-theme="dark"] .steps-entry,
html[data-theme="dark"] .files-entry,
html[data-theme="dark"] .flow-entry {
  background: #141414;
  border-color: #2a2a28;
}
html[data-theme="dark"] .table-scroll { background: #101010; }
html[data-theme="dark"] .claims th,
html[data-theme="dark"] .note-body table th {
  color: #9a9a96;
  border-bottom-color: #2a2a28;
}
html[data-theme="dark"] .claims td,
html[data-theme="dark"] .note-body table td {
  color: #c8c8c4;
  border-bottom-color: #222;
}
html[data-theme="dark"] .claims .what { color: #f2f2f0; }
html[data-theme="dark"] .claims code { background: #1c1c1a; color: #f2f2f0; }
html[data-theme="dark"] .meta-strip { background: #101010; color: #9a9a96; }
html[data-theme="dark"] .meta-strip b { color: #f2f2f0; }
html[data-theme="dark"] .path-chip { background: #1c1c1a; color: #f2f2f0; }
html[data-theme="dark"] .callout-kicker { color: #9a9a96; }
html[data-theme="dark"] .callout-body { color: #c8c8c4; }
html[data-theme="dark"] .callout-tip { border-left-color: #3d9b6a !important; }
html[data-theme="dark"] .callout-warning { border-left-color: #f2f2f0 !important; }
html[data-theme="dark"] .callout-fossil { border-left-color: #6a6a66 !important; }
html[data-theme="dark"] li.step::before { background: #1c1c1a; color: #f2f2f0; }
html[data-theme="dark"] .step-title { color: #f2f2f0; }
html[data-theme="dark"] .step-body,
html[data-theme="dark"] .file-why,
html[data-theme="dark"] .flow-note { color: #c8c8c4; }
html[data-theme="dark"] .file-path,
html[data-theme="dark"] .flow-path,
html[data-theme="dark"] .flow-symbol { color: #f2f2f0; }
html[data-theme="dark"] li.file { border-bottom-color: #222; }
html[data-theme="dark"] .file-badge { border-color: #2a2a28; color: #9a9a96; }
html[data-theme="dark"] li.flow-node::before { background: #f2f2f0; }
html[data-theme="dark"] li.flow-node:not(:last-child)::after { background: #2a2a28; }
html[data-theme="dark"] .terms-entry dt,
html[data-theme="dark"] dl.terms dt { color: #f2f2f0; }
html[data-theme="dark"] .terms-entry dd,
html[data-theme="dark"] dl.terms dd { color: #c8c8c4; }
html[data-theme="dark"] blockquote.quote {
  background: #101010;
  border-color: #2a2a28;
  color: #c8c8c4;
}
html[data-theme="dark"] .term-caption,
html[data-theme="dark"] .image-caption { color: #9a9a96; }

@media (max-width: 640px) {
  .journey {
    width: min(100% - 24px, 1040px);
    padding: 48px 0;
  }
  .entry { margin-bottom: 48px; }
  .note { padding: 18px; }
  .term-entry,
  .table-entry,
  .image-entry {
    padding: 4px;
    border-radius: 9px;
  }
  .term,
  .table-scroll { border-radius: 5px; }
}
@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
  .entry {
    animation: gw-journey-reveal 400ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
    animation-delay: calc(var(--index, 0) * 45ms);
  }
  @keyframes gw-journey-reveal {
    from { opacity: 0; transform: translateY(8px); }
  }
}
/* === Linear level segments (guided scroll, no click gates) === */
.level-segment {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
}
.level-segment > .entry {
  margin-bottom: 56px;
}
.level-segment > .entry:last-child {
  margin-bottom: 72px;
}
/* Full-rail shapes as direct level-segment children */
.level-segment > .entry.term-entry,
.level-segment > .entry.table-entry,
.level-segment > .entry.image-entry,
.level-segment > .entry.steps-entry,
.level-segment > .entry.files-entry,
.level-segment > .entry.flow-entry,
.level-segment > .entry.facts-entry {
  width: 100%;
  max-width: 1040px;
}

@media (prefers-reduced-motion: reduce) {
  .entry { animation: none; }
}
`.trim();
}

/**
 * Agents invent left/right zigzag CSS and full documents. Blocks may only keep
 * content markup + `--index` for stagger. System journey CSS owns geometry.
 */
export function stripAgentGeometryFromBlockHtml(html: string): string {
  let out = String(html || "");
  // Drop any nested stylesheets / full documents the block agent smuggled in.
  out = out
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body|meta|link|title)\b[^>]*>/gi, "");
  // Keep only --index on style attrs; drop float / margin-left:50% / absolute left-right.
  out = out.replace(/\bstyle\s*=\s*(["'])([^"']*)\1/gi, (_m, q, st) => {
    const indexMatch = String(st).match(/--index\s*:\s*(\d+)/i);
    return indexMatch ? `style=${q}--index: ${indexMatch[1]}${q}` : "";
  });
  // Kill zigzag class names agents still emit.
  out = out.replace(/\bclass=(["'])([^"']*)\1/gi, (_m, q, cls) => {
    const cleaned = String(cls)
      .replace(
        /\b(wrap|hero|beat|page|card|panel|toc|breath|left|right|odd|even|zigzag|alt)\b/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
    return cleaned ? `class=${q}${cleaned}${q}` : "";
  });
  return out.trim();
}

/** Ensure block markup is OpenCode entry note geometry + expandable chain-rail. */
export function normalizeJourneyBlockHtml(html: string, levelId: HtmlLevelId, index: number): string {
  let out = stripAgentGeometryFromBlockHtml(String(html || "").trim());
  if (!out) return out;
  const n = levelId.replace("L", "");

  // Strip forbidden anti-journey classes if agents leak them (second pass after rename).
  // Only rename the bare class token "kicker" → "note-kicker". Never rewrite
  // callout-kicker / chain-summary-kicker (Macro regression: broken expand + callouts).
  out = out.replace(/\bclass=(["'])([^"']*)\1/gi, (_m, q, cls) => {
    const cleaned = String(cls)
      .replace(/\b(wrap|hero|beat|page|card|panel|toc|breath)\b/gi, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => (tok === "kicker" ? "note-kicker" : tok))
      .join(" ")
      .trim();
    return cleaned ? `class=${q}${cleaned}${q}` : "";
  });
  // Repair already-broken renames from older normalize.
  out = out
    .replace(/\bchain-summary-note-kicker\b/g, "chain-summary-kicker")
    .replace(/\bcallout-note-kicker\b/g, "callout-kicker");

  // Rename legacy chain-panel/chain-body → chain-toggle/chain-rail
  out = out
    .replace(/\bchain-panel\b/g, "chain-toggle")
    .replace(/\bchain-body\b/g, "chain-rail")
    .replace(/\blevel-anchor\b/g, "")
    .replace(/\bchain-beat\b/g, "");

  if (/class=["'][^"']*\blevel-segment\b/i.test(out)) {
    out = out.replace(/<section\b([^>]*)>/i, (_m, attrs) => {
      let a = String(attrs || "");
      if (!/\bid\s*=/.test(a)) a += ` id="l${n}"`;
      if (!/\bdata-level\s*=/.test(a)) a += ` data-level="${levelId}"`;
      return `<section${a}>`;
    });
    // Ensure details.chain-toggle has class "entry note chain-toggle"
    out = out.replace(/<details\b([^>]*)>/gi, (_m, attrs) => {
      let a = String(attrs || "");
      if (!/\bclass\s*=/.test(a)) a = ` class="entry note chain-toggle"${a}`;
      else if (!/\bchain-toggle\b/.test(a)) {
        a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => {
          const next = `${cls} entry note chain-toggle`.replace(/\s+/g, " ").trim();
          return `class=${q}${next}${q}`;
        });
      } else if (!/\bnote\b/.test(a)) {
        a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => `class=${q}${cls} note${q}`);
      }
      return `<details${a}>`;
    });
    let i = index;
    out = out.replace(/<(article|figure|details)\b([^>]*)>/gi, (_m, tag, attrs) => {
      let a = String(attrs || "");
      if (!/--index/.test(a)) {
        if (/\bstyle\s*=/.test(a)) {
          a = a.replace(/\bstyle\s*=\s*(["'])([^"']*)\1/i, (_s, q, st) => `style=${q}--index: ${i}; ${st}${q}`);
        } else {
          a += ` style="--index: ${i}"`;
        }
      }
      // Force OpenCode entry classes on articles; figures keep rich *-entry classes.
      const isFigure = tag.toLowerCase() === "figure";
      const isArticle = tag.toLowerCase() === "article";
      if (isArticle && !/\bentry\b/.test(a)) {
        if (/\bclass\s*=/.test(a)) {
          a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => `class=${q}entry note ${cls}${q}`);
        } else {
          a = ` class="entry note"${a}`;
        }
      }
      if (isFigure && !/\bentry\b/.test(a)) {
        if (/\bclass\s*=/.test(a)) {
          a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => `class=${q}entry ${cls}${q}`);
        } else {
          a = ` class="entry term-entry"${a}`;
        }
      }
      i += 1;
      return `<${tag}${a}>`;
    });
    // Flatten any legacy expand chains into a linear scroll rail.
    return flattenJourneyToLinearRail(out);
  }

  // Multi-root → level-segment: all entries on the rail in order (no click gates).
  const roots = out.match(/<(?:article|figure|details)\b[\s\S]*?<\/(?:article|figure|details)>/gi) || [];
  if (roots.length >= 2) {
    // Unwrap nested details roots into their children if present
    const flat: string[] = [];
    for (const r of roots) {
      if (/<details\b/i.test(r) && /chain-rail|chain-toggle/i.test(r)) {
        const inner = r.match(/<div\b[^>]*class=["'][^"']*\bchain-rail\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
        const kids = inner?.match(/<(?:article|figure)\b[\s\S]*?<\/(?:article|figure)>/gi) || [];
        if (kids.length) {
          flat.push(...kids);
          continue;
        }
      }
      if (!/<details\b/i.test(r)) flat.push(r);
    }
    out = `<section class="level-segment" data-level="${levelId}" id="l${n}">
${flat.join("\n")}
</section>`;
    return normalizeJourneyBlockHtml(out, levelId, index);
  }

  // Single root (or agent wrap shells around one article)
  if (!/<article\b|<figure\b/i.test(out)) {
    out = `<article class="entry note" id="l${n}" style="--index: ${index}">${out}</article>`;
  }
  // Force OpenCode entry classes. Articles default to note; figures keep *-entry
  // full-rail types (term/table/steps/files/flow/facts) without forcing note width.
  let firstIndexed = false;
  out = out.replace(/<(article|figure)\b([^>]*)>/gi, (_m, tag, attrs) => {
    let a = String(attrs || "");
    const isFigure = tag.toLowerCase() === "figure";
    const hasRichFigure =
      isFigure &&
      /\b(term-entry|table-entry|image-entry|steps-entry|files-entry|flow-entry|facts-entry|quote-entry|compare-entry)\b/i.test(
        a,
      );
    if (!/\bclass\s*=/.test(a)) {
      a = isFigure ? ` class="entry term-entry"${a}` : ` class="entry note"${a}`;
    } else if (!/\bentry\b/.test(a)) {
      a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => {
        const base = hasRichFigure ? "entry" : "entry note";
        const next = `${base} ${String(cls || "").trim()}`.replace(/\s+/g, " ").trim();
        return `class=${q}${next}${q}`;
      });
    } else if (!/\bnote\b/.test(a) && !isFigure && !hasRichFigure) {
      a = a.replace(/\bclass\s*=\s*(["'])([^"']*)\1/i, (_c, q, cls) => `class=${q}${cls} note${q}`);
    }
    if (!firstIndexed) {
      if (!/\bid\s*=/.test(a)) a += ` id="l${n}"`;
      if (!/--index/.test(a)) a += ` style="--index: ${index}"`;
      firstIndexed = true;
    }
    return `<${tag}${a}>`;
  });
  // Drop empty wrap divs agents leave after class strip.
  out = out.replace(/<div\b[^>]*>\s*(<(?:article|figure|section)\b)/gi, "$1");
  out = out.replace(/(<\/(?:article|figure|section)>)\s*<\/div>/gi, "$1");
  if (!/\blevel-segment\b/i.test(out)) {
    out = `<section class="level-segment" data-level="${levelId}" id="l${n}">
${out}
</section>`;
  }
  out = out.replace(/<h1\b([^>]*)class=(["'])([^"']*\bnote-title\b[^"']*)\2/gi, `<h2 class=$2$3$2`);
  return flattenJourneyToLinearRail(out);
}

/** Rich shapes that belong on the always-visible center rail. */
const RICH_ENTRY_CLASS_RE =
  /\b(steps-entry|files-entry|flow-entry|facts-entry|table-entry|term-entry|terms-entry|quote-entry|compare-entry)\b/i;

export function isRichJourneyEntryHtml(html: string): boolean {
  const h = String(html || "");
  if (RICH_ENTRY_CLASS_RE.test(h)) return true;
  if (/<article\b[^>]*\bcallout\b/i.test(h)) return true;
  if (/<dl\b[^>]*\bterms\b/i.test(h)) return true;
  return false;
}

/** @deprecated alias — linear flatten is the product path. */
export function promoteRichBlocksOntoRail(html: string): string {
  return flattenJourneyToLinearRail(html);
}

/**
 * Guided journey: unwrap every chain-toggle / chain-rail so the reader scrolls
 * top → bottom with no click-to-reveal. Click gates demote the experience.
 */
export function flattenJourneyToLinearRail(html: string): string {
  let out = String(html || "");
  if (!/level-segment/i.test(out)) return out;
  if (!/chain-toggle|chain-rail|<details\b/i.test(out)) return out;

  out = out.replace(
    /(<section\b[^>]*class=["'][^"']*\blevel-segment\b[^"']*["'][^>]*>)([\s\S]*?)(<\/section>)/gi,
    (_m, open, body, close) => {
      let bodyStr = String(body);
      // Pull every chain-rail's children out, drop the details wrapper entirely.
      bodyStr = bodyStr.replace(
        /<details\b[^>]*class=["'][^"']*\bchain-toggle\b[^"']*["'][^>]*>[\s\S]*?<div\b[^>]*class=["'][^"']*\bchain-rail\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/details>/gi,
        (_d, railInner) => `\n${String(railInner || "").trim()}\n`,
      );
      // Any leftover bare details with articles/figures inside
      bodyStr = bodyStr.replace(
        /<details\b[^>]*>[\s\S]*?<summary\b[^>]*>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/gi,
        (_d, rest) => `\n${String(rest || "").trim()}\n`,
      );
      // Drop orphaned summary chrome if any leaked
      bodyStr = bodyStr
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
        .replace(/<div\b[^>]*class=["'][^"']*\bchain-rail\b[^"']*["'][^>]*>\s*<\/div>/gi, "");
      return `${open}${bodyStr}${close}`;
    },
  );
  return out;
}

export function assembleHtmlJourney(input: {
  title: string;
  coreNoun: string;
  blocks: HtmlTimelineBlock[];
  /** Section objects for stub fallback (prefer blueprint sections). */
  sections?: HtmlBlueprintSection[];
  dress?: HtmlDressPromptInput | null;
  scope?: string;
}): string {
  const title = String(input.title || "Repository tour").trim();
  const theme = input.dress?.theme === "dark" ? "dark" : "light";
  const sectionById = new Map((input.sections || []).map((s) => [s.id, s]));
  // Pure prime-volume journey: only centered entries on the rail (no sticky nav chrome).
  let index = 0;
  const bodyBlocks = HTML_LEVEL_ORDER.map((id) => {
    const block = input.blocks.find((b) => b.id === id);
    const section = sectionById.get(id) || {
      id,
      kicker: HTML_LEVEL_SPECS[id].kicker,
      title: HTML_LEVEL_SPECS[id].defaultTitle,
      intent: HTML_LEVEL_SPECS[id].intent,
      mustInclude: "",
      visual: HTML_LEVEL_SPECS[id].visual,
      beats: defaultBeatsForLevel(id),
    };
    const raw = block?.html || fallbackBlockHtml(section, index);
    const normalized = normalizeJourneyBlockHtml(raw, id, index);
    index += 1;
    return normalized;
  }).join("\n\n");

  // Opening note — exact OpenCode `entry note` geometry (460px, centered on rail).
  const openNote = `<article class="entry note" id="entry-00" style="--index: 0">
  <p class="note-kicker">00 · Starting point</p>
  <h2 class="note-title">${escapeHtml(title)}</h2>
  <p class="note-body">Grounded onboarding for <code>${escapeHtml(input.scope || "this repository")}</code>. Core noun: <strong>${escapeHtml(input.coreNoun)}</strong>. Scroll the center rail top to bottom. Each level introduces ideas before denser proof.</p>
</article>`;

  // Re-index every --index for staggered reveal (OpenCode pattern).
  let reIndex = 1;
  const reindexed = bodyBlocks.replace(
    /style="([^"]*--index:\s*)\d+([^"]*)"/g,
    (_m, pre, post) => `style="${pre}${reIndex++}${post}"`,
  );

  // Journey CSS is the ONLY stylesheet (no dress dump, no agent geometry).
  const journeyCss = htmlJourneyTimelineCss();
  // Final scrub: never let smuggled styles / wrap shells into the body.
  const bodySafe = stripAgentGeometryFromBlockHtml(`${openNote}\n\n${reindexed}`);

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}" data-gw-journey="1" data-gw-dress="${escapeHtml(input.dress?.id || "ink-paper")}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style data-gw-journey="1">
${journeyCss}
</style>
</head>
<body>
<main id="journey" class="journey" aria-label="${escapeHtml(title)}">
${bodySafe}
</main>
</body>
</html>`;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type HtmlPipelinePhase =
  | "prepare"
  | "structure"
  | "pages"
  | "write"
  | "finalize";

export type HtmlBlockDoneEvent = {
  levelId: HtmlLevelId;
  index: number;
  total: number;
  title: string;
  kicker: string;
  failed: boolean;
  /** Completed count so far (success + failed). */
  completed: number;
};

export type RunHtmlPipelineOptions = {
  source: string;
  brief: string;
  title?: string;
  genre?: unknown;
  dress?: HtmlDressPromptInput | null;
  codeKbContext?: string | null;
  codeGraphHint?: string;
  localCli: LocalCliConfig;
  /**
   * Agent stream. During parallel blocks, events are tagged with htmlBlockId
   * so the UI can demux / suppress thrash (Docs-style page isolation).
   */
  onEvent?: (event: RLMEvent & { htmlBlockId?: string }) => void;
  signal?: AbortSignal;
  onPhase?: (phase: HtmlPipelinePhase, label: string, detail: string) => void;
  onRepair?: (issue: string) => void;
  /** Fired after blueprint is ready (default or agent-authored). */
  onStructureDone?: (blueprint: HtmlBlueprint) => void;
  /** Fired after each timeline block settles (success or stub). */
  onBlockDone?: (event: HtmlBlockDoneEvent) => void;
  /**
   * Parallel block agents.
   * Default 8 to match Docs/wiki local-CLI page concurrency
   * (`DEFAULT_LOCAL_CLI_PAGE_CONCURRENCY` in generator.ts).
   */
  concurrency?: number;
  /** Per-block timeout ms (default 6 minutes). */
  blockTimeoutMs?: number;
  /** Auto-retry failed blocks once at concurrency 2 (default true). */
  retryFailedBlocks?: boolean;
};

export type HtmlPipelineResult = {
  html: string;
  title: string;
  genre: HtmlGenre;
  rawText: string;
  promptChars: number;
  evidenceChars: number;
  blueprint: HtmlBlueprint;
  blocks: HtmlTimelineBlock[];
  failedBlockIds: HtmlLevelId[];
  qualityIssue?: string | null;
  repaired?: boolean;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("HTML generation aborted");
    err.name = "AbortError";
    throw err;
  }
}

function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === "object" && e !== null) {
    const name = String((e as { name?: string }).name || "");
    const msg = String((e as { message?: string }).message || e);
    if (name === "AbortError") return true;
    if (/abort/i.test(msg)) return true;
  }
  return false;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!ms || ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  const onAbort = () => {
    /* race settles via throwIfAborted on outer loops */
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Blueprint → parallel timeline blocks → assemble one HTML journey.
 * Docs/wiki-shaped: structure-done, block-done, abort, timeouts, failed surface.
 */
export async function runHtmlPipeline(opts: RunHtmlPipelineOptions): Promise<HtmlPipelineResult> {
  const source = String(opts.source || "").trim();
  const brief = String(opts.brief || "").trim();
  if (!source) throw new Error("source is required");
  if (!brief) throw new Error("brief is required");

  const genre = normalizeHtmlGenre(opts.genre);
  const workingTitle = String(opts.title || "").trim() || "Repository tour";
  const codeKb = String(opts.codeKbContext || "").trim();
  const theme = opts.dress?.theme === "dark" ? "dark" : "light";
  // Match Docs/wiki local-CLI page agents: default 8, hard cap 10 (all 10 L-levels fit in ~2 waves).
  const envConc = Number(process.env.RLM_WIKI_HTML_BLOCK_CONCURRENCY || process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY || "");
  const defaultConc = Number.isFinite(envConc) && envConc > 0 ? Math.floor(envConc) : 8;
  const concurrency = Math.max(
    1,
    Math.min(Number(opts.concurrency) || defaultConc, 10),
  );
  const blockTimeoutMs = Math.max(
    60_000,
    Number(opts.blockTimeoutMs) ||
      Number(process.env.RLM_WIKI_HTML_BLOCK_TIMEOUT_MS || 360_000),
  );
  const retryFailed = opts.retryFailedBlocks !== false;
  const emitPhase = (phase: HtmlPipelinePhase, label: string, detail: string) => {
    try {
      opts.onPhase?.(phase, label, detail);
    } catch {
      /* ignore */
    }
  };

  let promptChars = 0;
  let rawParts: string[] = [];
  let completedCount = 0;
  const total = HTML_LEVEL_ORDER.length;

  // ── 1) Blueprint ──────────────────────────────────────────────
  throwIfAborted(opts.signal);
  emitPhase("structure", "Blueprint L1–L10", "Planning section titles and must-include paths from evidence.");
  const blueprintPrompt = buildHtmlBlueprintPrompt({
    title: workingTitle,
    brief,
    genre,
    scope: source,
    codeKbContext: codeKb || null,
  });
  promptChars += blueprintPrompt.length;

  let blueprint = defaultHtmlBlueprint(workingTitle);
  try {
    const structureAgent = new LocalCliAgent({
      source,
      mode: "chat",
      localCli: opts.localCli,
      contextLabel: "html-blueprint",
      onEvent: opts.onEvent,
    });
    const structureResult = await withTimeout(
      structureAgent.query(blueprintPrompt, opts.signal),
      blockTimeoutMs,
      "HTML blueprint agent",
      opts.signal,
    );
    const structureRaw = String(structureResult.rawText ?? structureResult.answer ?? "").trim();
    rawParts.push(`---BLUEPRINT---\n${structureRaw}`);
    if (structureRaw) {
      blueprint = parseHtmlBlueprintXml(structureRaw, workingTitle);
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    // Keep default blueprint on agent failure (not abort).
    rawParts.push(`---BLUEPRINT-ERROR---\n${e instanceof Error ? e.message : String(e)}`);
  }

  throwIfAborted(opts.signal);
  try {
    opts.onStructureDone?.(blueprint);
  } catch {
    /* ignore */
  }

  // ── 2) Parallel blocks ────────────────────────────────────────
  emitPhase(
    "pages",
    "Write timeline blocks",
    `Spawning ${blueprint.sections.length} block agents (concurrency ${concurrency}).`,
  );

  const softLintNotes: string[] = [];

  const runOneBlock = async (section: HtmlBlueprintSection): Promise<HtmlTimelineBlock> => {
    throwIfAborted(opts.signal);
    const blockPrompt = buildHtmlBlockPrompt({
      section,
      blueprint,
      brief,
      genre,
      scope: source,
      codeKbContext: codeKb || null,
      theme,
    });
    promptChars += blockPrompt.length;
    const blockId = section.id;
    try {
      const agent = new LocalCliAgent({
        source,
        mode: "chat",
        localCli: opts.localCli,
        contextLabel: `html-block-${section.id.toLowerCase()}`,
        // Tag events so desktop can demux; UI should not thrash phase on these.
        onEvent: (ev) => opts.onEvent?.({ ...(ev as object), htmlBlockId: blockId } as RLMEvent & {
          htmlBlockId?: string;
        }),
      });
      const result = await withTimeout(
        agent.query(blockPrompt, opts.signal),
        blockTimeoutMs,
        `HTML block ${section.id}`,
        opts.signal,
      );
      const raw = String(result.rawText ?? result.answer ?? "").trim();
      rawParts.push(`---${section.id}---\n${raw.slice(0, 80_000)}`);
      const extracted = extractHtmlBlock(raw, section.id);
      if (extracted && extracted.length > 80) {
        const idx = HTML_LEVEL_ORDER.indexOf(section.id);
        const normalized = normalizeJourneyBlockHtml(extracted, section.id, Math.max(0, idx));
        const lint = lintJourneyBlockHtml(section.id, normalized);
        if (lint.softNotes.length) {
          softLintNotes.push(...lint.softNotes);
          rawParts.push(`---${section.id}-LINT-SOFT---\n${lint.softNotes.join("; ")}`);
        }
        if (lint.hardFail) {
          return {
            id: section.id,
            html: fallbackBlockHtml(section),
            rawText: `${raw}\n\n<!-- lint: ${lint.hardFail} -->`,
            failed: true,
          };
        }
        return {
          id: section.id,
          html: normalized,
          rawText: raw,
        };
      }
      return {
        id: section.id,
        html: fallbackBlockHtml(section),
        rawText: raw,
        failed: true,
      };
    } catch (e) {
      if (isAbortError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      return {
        id: section.id,
        html: fallbackBlockHtml(section),
        rawText: msg,
        failed: true,
      };
    }
  };

  const emitBlockDone = (block: HtmlTimelineBlock, section: HtmlBlueprintSection, index: number) => {
    completedCount += 1;
    try {
      opts.onBlockDone?.({
        levelId: block.id,
        index,
        total,
        title: section.title,
        kicker: section.kicker,
        failed: Boolean(block.failed),
        completed: completedCount,
      });
    } catch {
      /* ignore */
    }
  };

  let blocks = await mapPool(blueprint.sections, concurrency, async (section, index) => {
    const block = await runOneBlock(section);
    emitBlockDone(block, section, index);
    return block;
  });

  // Auto-recovery for failed blocks (Docs/wiki-style quiet retry pass).
  throwIfAborted(opts.signal);
  if (retryFailed) {
    const failedSections = blueprint.sections.filter((s) =>
      blocks.some((b) => b.id === s.id && b.failed),
    );
    if (failedSections.length) {
      emitPhase(
        "pages",
        "Recover failed blocks",
        `Retrying ${failedSections.length} failed level${failedSections.length === 1 ? "" : "s"}.`,
      );
      const recovered = await mapPool(failedSections, Math.min(2, concurrency), async (section) => {
        const block = await runOneBlock(section);
        // Don't double-count completed; notify as refresh of that level.
        try {
          const index = blueprint.sections.findIndex((s) => s.id === section.id);
          opts.onBlockDone?.({
            levelId: block.id,
            index: Math.max(0, index),
            total,
            title: section.title,
            kicker: section.kicker,
            failed: Boolean(block.failed),
            completed: completedCount,
          });
        } catch {
          /* ignore */
        }
        return block;
      });
      const byId = new Map(blocks.map((b) => [b.id, b]));
      for (const b of recovered) byId.set(b.id, b);
      blocks = HTML_LEVEL_ORDER.map((id) => byId.get(id)!).filter(Boolean);
    }
  }

  throwIfAborted(opts.signal);
  const failedBlockIds = blocks.filter((b) => b.failed).map((b) => b.id);

  // ── 3) Assemble ───────────────────────────────────────────────
  emitPhase("write", "Assemble journey", "Piecing L1–L10 timeline blocks into one HTML document.");
  const html = assembleHtmlJourney({
    title: blueprint.title || workingTitle,
    coreNoun: blueprint.coreNoun,
    blocks,
    sections: blueprint.sections,
    dress: opts.dress || null,
    scope: source,
  });

  const qualityParts: string[] = [];
  if (failedBlockIds.length > 0) {
    qualityParts.push(
      `${failedBlockIds.length} of ${total} levels used recovery stubs (${failedBlockIds.join(", ")}). Regenerate or re-run those levels for full depth.`,
    );
  }
  if (softLintNotes.length) {
    qualityParts.push(`Shape notes: ${[...new Set(softLintNotes)].slice(0, 6).join("; ")}`);
  }
  const qualityIssue = qualityParts.length ? qualityParts.join(" ") : null;

  return {
    html,
    title: blueprint.title || workingTitle,
    genre,
    rawText: rawParts.join("\n\n").slice(0, 512_000),
    promptChars,
    evidenceChars: codeKb.length,
    blueprint,
    blocks,
    failedBlockIds,
    qualityIssue,
    repaired: false,
  };
}
