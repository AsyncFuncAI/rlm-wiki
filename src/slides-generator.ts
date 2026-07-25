import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RLMEvent } from "./jcode-runtime.ts";
import type { ProviderModel } from "./llm.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { LocalCliConfig } from "./local-cli-events.ts";
import { localCliControlsForSurface } from "./model-control.ts";
import {
  openSlideDeckFiles,
  openSlideDeckId,
  openSlideDeckSourcePath,
  openSlideDeckZipName,
  type OpenSlideExportFile,
} from "./open-slide-export.ts";
import { parseGithubUrl, type WikiRecord } from "./types.ts";

export const WIKI_SLIDES_ARTIFACT_KIND = "wiki_slides";

type SourceSpec = {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
};

export type WikiSlidesEvent =
  | { type: "phase"; phase: "prepare" | "agent" | "package"; message: string }
  | { type: "agent"; event: RLMEvent };

export interface GeneratedWikiSlides {
  deckId: string;
  fileName: string;
  files: OpenSlideExportFile[];
  deckSourcePath: string;
  usedAgent: boolean;
}

export interface GenerateWikiSlidesOptions {
  channel: ProviderModel;
  localCli?: LocalCliConfig | unknown;
  signal?: AbortSignal;
  slideCount?: number;
  instructions?: string;
  onEvent?: (event: WikiSlidesEvent) => void;
}

const MAX_PROMPT_CHARS = 48_000;
const MAX_PAGE_CHARS = 3_800;
const MAX_REPAIR_SOURCE_CHARS = 40_000;
const MAX_REPAIR_ERROR_CHARS = 4_000;

export function wikiSlidesArtifactKey(runId: string): string {
  return runId;
}

export async function generateWikiSlides(
  record: WikiRecord,
  options: GenerateWikiSlidesOptions,
): Promise<GeneratedWikiSlides> {
  const deckId = openSlideDeckId(record);
  const deckSourcePath = openSlideDeckSourcePath(record);
  options.onEvent?.({
    type: "phase",
    phase: "prepare",
    message: "Preparing wiki context for slide generation.",
  });

  const agent = new LocalCliAgent({
    sources: wikiRecordSources(record),
    ...localCliControlsForSurface(options.channel, { surface: "wiki-slides", depth: "deep" }),
    localCli: options.localCli,
    contextLabel: "wiki-slides",
    onEvent: (event) => options.onEvent?.({ type: "agent", event }),
  });

  options.onEvent?.({
    type: "phase",
    phase: "agent",
    message: "Asking the selected local CLI agent to design the Open Slide deck.",
  });
  const prompt = buildSlidesPrompt(record, {
    deckId,
    slideCount: options.slideCount,
    instructions: options.instructions,
  });
  const result = await agent.query(prompt, options.signal);
  let deckSource = extractOpenSlideSource(result.answer || result.rawText || "");
  let usedAgent = true;
  try {
    await validateGeneratedOpenSlideSource(deckSource);
  } catch (initialError) {
    options.onEvent?.({
      type: "phase",
      phase: "agent",
      message: "Repairing the Open Slide source before packaging.",
    });
    try {
      const repair = await agent.query(buildSlidesRepairPrompt(deckId, deckSource, initialError), options.signal);
      deckSource = extractOpenSlideSource(repair.answer || repair.rawText || "");
      await validateGeneratedOpenSlideSource(deckSource);
    } catch {
      usedAgent = false;
      deckSource = "";
      options.onEvent?.({
        type: "phase",
        phase: "package",
        message: "Using the safe Open Slide template after the agent deck failed validation.",
      });
    }
  }

  options.onEvent?.({
    type: "phase",
    phase: "package",
    message: "Packaging the generated Open Slide workspace.",
  });
  const files = openSlideDeckFiles(record, {
    deckSource: deckSource || null,
    readmeNote: usedAgent
      ? "The deck source was authored by the selected local CLI agent from the generated wiki context."
      : "The selected local CLI agent returned invalid TSX, so Grok-Wiki packaged the safe built-in Open Slide template.",
  });
  return {
    deckId,
    fileName: openSlideDeckZipName(record),
    files,
    deckSourcePath,
    usedAgent,
  };
}

export function wikiRecordSources(record: WikiRecord): Array<string | SourceSpec> {
  if (Array.isArray(record.repos) && record.repos.length) {
    return record.repos.map((repo) => wikiRecordSourceSpec({
      id: repo.id,
      owner: repo.owner,
      repo: repo.repo,
      source: repo.url,
      branch: repo.branch ?? null,
      sourcePath: repo.sourcePath ?? null,
      label: repo.label || `${repo.owner}/${repo.repo}`,
    }));
  }
  return [wikiRecordSourceSpec({
    id: `${record.owner}-${record.repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    source: record.repoUrl || `https://github.com/${record.owner}/${record.repo}`,
    branch: record.branch ?? null,
    sourcePath: record.sourcePath ?? null,
    label: `${record.owner}/${record.repo}`,
  })];
}

function wikiRecordSourceSpec(input: {
  id?: string;
  owner?: string;
  repo?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
}): SourceSpec {
  const parsed = parseGithubSourceSpec(input.source);
  return {
    id: input.id,
    source: parsed?.url || input.source,
    branch: input.branch ?? parsed?.branch ?? null,
    sourcePath: input.sourcePath ?? parsed?.sourcePath ?? null,
    label: input.label || `${input.owner || ""}/${input.repo || ""}`,
  };
}

function parseGithubSourceSpec(source: string): { url: string; branch: string | null; sourcePath?: string | null } | null {
  try {
    return parseGithubUrl(source);
  } catch {
    return null;
  }
}

export function buildSlidesPrompt(
  record: WikiRecord,
  options: { deckId: string; slideCount?: number; instructions?: string },
): string {
  const targetSlideCount = clampSlideCount(options.slideCount, record);
  return [
    "Create an Open Slide deck from the generated wiki below.",
    "",
    "# Output Contract",
    `Return only the complete contents for \`slides/${options.deckId}/index.tsx\`.`,
    "Wrap the full TSX source in <ANSWER>...</ANSWER> tags.",
    "Do not return a patch, markdown explanation, shell commands, or additional files.",
    "",
    "# Open Slide Contract",
    "- Use React/TSX.",
    "- Import `Page` and `SlideMeta` from `@open-slide/core`.",
    "- Export `meta` as `SlideMeta`.",
    "- Keep `meta` limited to Open Slide fields: `title` and optional `theme`. Do not add `createdAt`, `author`, or custom metadata fields.",
    "- Export optional `notes` as `Record<number, string>`.",
    "- Default export an array of `Page` components.",
    "- Use only inline React styles, local constants, and local helper components. Do not import external assets.",
    "- In inline style objects, always use explicit keys and values. Do not use shorthand properties unless that exact variable is declared in the same scope.",
    "",
    "# Story Strategy",
    `- Aim for ${targetSlideCount} slides unless the wiki clearly needs fewer.`,
    "- Privately choose one thesis for the deck before writing TSX. The audience should understand what this repo does, why it matters, and how the implementation works.",
    "- Build a concise narrative deck, not a dump of wiki paragraphs.",
    "- Use this arc where possible: cover thesis -> repo/system map -> core flow -> important mechanism(s) -> tradeoffs or operational notes -> next steps.",
    "- Every slide must have one job, one sharp headline, and one concrete takeaway for a new reader.",
    "- Turn lists into structured visuals: architecture maps, flow lanes, comparison matrices, mechanism stacks, code-path callouts, or decision trees.",
    "- Include a short `notes` entry for each slide with what the presenter should say. Notes may mention grounding privately, but slides themselves should stay citation-free.",
    "",
    "# Visual Direction",
    "- Treat the deck like a premium internal engineering brief: quiet, structured, dense enough for engineers, but immediately scannable.",
    "- Create a small reusable design system in the TSX: palette, type scale, spacing constants, and 3-5 components such as Frame, Eyebrow, InsightCard, FlowStep, CodePath, or DecisionGrid.",
    "- Compose for a 1920x1080 canvas with stable margins, a consistent footer, and a clear content grid. Do not let text touch edges.",
    "- Use one dominant visual structure per slide. Avoid repeating the same card grid on every slide.",
    "- Use off-white/off-black surfaces, subtle borders, and one intentional accent plus one supporting color. Avoid pure black, pure white, loud gradients, decorative blobs, stock imagery, and marketing-style hero art.",
    "- Typography must carry hierarchy: cover title 76-104px, slide titles 52-72px, body 26-34px, labels 16-22px. Use `letterSpacing: 0`; never use negative letter spacing.",
    "- Keep copy breathable: no paragraph walls and no more than 3 primary bullets/cards on a slide.",
    "- Do not render visible citations, source trails, bibliography slides, source-file chips, or citation footers. The deck should feel like a polished explanation, not an annotated wiki.",
    "- Ensure every slide is readable at presentation distance. No clipped text, overlapping elements, tiny code, nested cards, or layout that only works for one title length.",
    "",
    "# Quality Bar",
    "- Every technical claim must be grounded in the wiki context, but do not display citations or source paths on the slides unless the user explicitly asked for them.",
    "- Keep the content engaging by showing relationships, causality, and decisions rather than restating page summaries.",
    "- Prefer concrete nouns from the repo over generic labels like `Component`, `System`, or `Process`.",
    "- The deck should be useful for a new reader who wants the repo explained quickly.",
    options.instructions ? `\n# User Slide Instructions\n${options.instructions.trim()}` : "",
    "",
    "# Wiki Context",
    wikiContext(record),
  ].filter((section) => section.trim()).join("\n");
}

function buildSlidesRepairPrompt(deckId: string, source: string, error: unknown): string {
  const errorText = error instanceof Error ? error.message : String(error);
  return [
    "Repair the Open Slide deck source below.",
    "",
    "# Output Contract",
    `Return only the complete corrected contents for \`slides/${deckId}/index.tsx\`.`,
    "Wrap the full TSX source in <ANSWER>...</ANSWER> tags.",
    "Do not return explanations, patches, shell commands, or additional files.",
    "",
    "# Repair Rules",
    "- Preserve the deck's narrative, visual direction, and slide count where possible.",
    "- Fix every TypeScript and TSX error.",
    "- Do not use shorthand object properties in inline styles unless the same variable is explicitly in scope. For example, write `background: bg`, not `background`.",
    "- Import only `Page` and `SlideMeta` from `@open-slide/core`.",
    "- Keep `meta` limited to Open Slide fields: `title` and optional `theme`.",
    "- Keep slides citation-free: no visible source paths, citation footers, bibliography slides, or source chips.",
    "- Do not import external assets, server modules, Node modules, CSS files, or packages other than `@open-slide/core`.",
    "",
    "# Validation Error",
    truncate(errorText, MAX_REPAIR_ERROR_CHARS),
    "",
    "# Broken Source",
    "```tsx",
    truncate(source, MAX_REPAIR_SOURCE_CHARS),
    "```",
  ].join("\n");
}

function clampSlideCount(value: unknown, record: WikiRecord): number {
  const generatedPages = Object.keys(record.pages || {}).length;
  const fallback = Math.min(12, Math.max(5, generatedPages + 3));
  const numeric = typeof value === "number" ? value : Number(String(value || "").trim());
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(4, Math.min(20, numeric));
}

function wikiContext(record: WikiRecord): string {
  const repoLabel = record.repos?.length
    ? record.repos.map((repo) => `${repo.label || `${repo.owner}/${repo.repo}`}${repo.branch ? `@${repo.branch}` : ""}`).join(" + ")
    : `${record.owner}/${record.repo}${record.branch ? `@${record.branch}` : ""}`;
  const chunks = [
    `Repository: ${repoLabel}`,
    `Wiki title: ${record.structure.title}`,
    `Wiki description: ${record.structure.description}`,
    "",
    ...orderedPageContext(record),
  ];
  return truncate(chunks.join("\n"), MAX_PROMPT_CHARS);
}

function orderedPageContext(record: WikiRecord): string[] {
  const generated = new Set(Object.keys(record.pages || {}));
  const orderedIds = [
    ...record.structure.pages.map((page) => page.id).filter((id) => generated.has(id)),
    ...Object.keys(record.pages || {}).filter((id) => !record.structure.pages.some((page) => page.id === id)),
  ];
  return orderedIds.map((pageId, index) => {
    const meta = record.structure.pages.find((page) => page.id === pageId);
    const page = record.pages[pageId];
    const title = meta?.title || page?.id || pageId;
    const description = meta?.description || "";
    const files = Array.isArray(meta?.filePaths) ? meta.filePaths : [];
    const content = truncate(stripMarkdown(page?.content || ""), MAX_PAGE_CHARS);
    return [
      `## Page ${index + 1}: ${title}`,
      description ? `Description: ${description}` : "",
      files.length ? `Source files: ${files.slice(0, 12).join(", ")}` : "Source files: not recorded",
      "Content excerpt:",
      content,
    ].filter(Boolean).join("\n");
  });
}

function stripMarkdown(value: string): string {
  return String(value || "")
    .replace(/<details\b[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max: number): string {
  const clean = String(value || "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function extractOpenSlideSource(output: string): string {
  const raw = String(output || "").trim();
  const answer = raw.match(/<ANSWER>\s*([\s\S]*?)\s*<\/ANSWER>/i)?.[1]?.trim() || raw;
  const fenced = answer.match(/```(?:tsx|typescript|ts|jsx)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return (fenced || answer)
    .replace(/^<ANSWER>/i, "")
    .replace(/<\/ANSWER>$/i, "")
    .trim();
}

export function validateOpenSlideSource(source: string): void {
  const clean = source.trim();
  if (!clean) throw new Error("Slide agent returned an empty deck.");
  if (!/\bfrom\s+['"]@open-slide\/core['"]/.test(clean)) {
    throw new Error("Slide agent did not import from @open-slide/core.");
  }
  if (!/\bexport\s+const\s+meta\b/.test(clean)) {
    throw new Error("Slide agent did not export deck metadata.");
  }
  if (!/\bexport\s+default\b/.test(clean)) {
    throw new Error("Slide agent did not export a default Page array.");
  }
  if (/\bfrom\s+['"](?:node:)?(?:fs|path|child_process|http|https|net|tls)['"]/.test(clean)) {
    throw new Error("Slide agent returned server-only imports that cannot run in Open Slide.");
  }
}

export async function validateGeneratedOpenSlideSource(source: string): Promise<void> {
  validateOpenSlideSource(source);
  await validateOpenSlideSourceSemantics(source);
}

async function validateOpenSlideSourceSemantics(source: string): Promise<void> {
  const ts = await import("typescript");
  const tmp = await mkdtemp(join(tmpdir(), "grok-wiki-open-slide-typecheck-"));
  const sourcePath = join(tmp, "index.tsx");
  const shimPath = join(tmp, "open-slide-shims.d.ts");
  try {
    await writeFile(sourcePath, source, "utf8");
    await writeFile(shimPath, OPEN_SLIDE_TYPECHECK_SHIMS, "utf8");
    const program = ts.createProgram([sourcePath, shimPath], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (diagnostics.length) {
      throw new Error([
        "Slide agent returned TypeScript-invalid Open Slide TSX:",
        formatTypeScriptDiagnostics(ts, diagnostics, tmp),
      ].join("\n"));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function formatTypeScriptDiagnostics(
  ts: typeof import("typescript"),
  diagnostics: import("typescript").Diagnostic[],
  root: string,
): string {
  const host: import("typescript").FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  };
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
    .replaceAll(root, ".")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

const OPEN_SLIDE_TYPECHECK_SHIMS = `
declare module "@open-slide/core" {
  export type Page = () => JSX.Element | null;
  export type SlideMeta = {
    title?: string;
    theme?: string;
  };
}

declare module "react" {
  export type CSSProperties = Record<string, string | number | undefined | null>;
  export type ReactNode = unknown;
  const React: unknown;
  export default React;
}

declare module "react/jsx-runtime" {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}

declare namespace JSX {
  type Element = unknown;
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}
`;
