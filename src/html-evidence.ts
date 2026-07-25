/**
 * HTML-native evidence pack (I2): deterministic repo-shaped folio for one-shot
 * HTML generate. Not Ask keyword mining from the brief.
 */
import {
  queryCodeKb,
  readCodeKbFile,
  raceWithBudget,
  type CodeKbSession,
} from "./sharenow-kb-client.ts";
import {
  renderCodeKbArchitectureSummary,
  renderStructureEvidence,
} from "./prompts/code-kb.ts";

const INVENTORY_LIMIT = 200;
const HOTSPOT_LIMIT = 40;
const HOTSPOT_MIN_DEGREE = 3;
const FILE_HEAD_LINES = 120;
const MAX_FILE_HEADS = 8;
const MAX_PACK_CHARS = 36_000;
const MAX_IN_FLIGHT = 4;

const ENTRY_PATTERNS = [
  /^readme(\.md|\.rst|\.txt)?$/i,
  /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|gemfile)$/i,
  /^(src\/)?(index|main|app|server|cli|mod)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go)$/i,
  /^(src|lib|app|cmd|packages)\/.+\.(ts|tsx|js|py|rs|go)$/i,
];

function fileContent(result: unknown): string | null {
  if (typeof result === "string") return result.trim() ? result : null;
  if (typeof result === "object" && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return null;
}

function inventoryPaths(result: unknown): string[] {
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
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (path && !path.startsWith("node_modules/") && !path.includes("/.git/")) paths.add(path);
  }
  return Array.from(paths);
}

function pickEntryPaths(paths: string[]): string[] {
  const scored = paths.map((path) => {
    let score = 0;
    const base = path.split("/").pop() || path;
    if (/^readme/i.test(base)) score += 100;
    if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(base)) score += 90;
    if (ENTRY_PATTERNS.some((re) => re.test(path) || re.test(base))) score += 40;
    if (/\.(ts|tsx|js|jsx|py|rs|go|md)$/i.test(path)) score += 10;
    if (path.split("/").length <= 2) score += 5;
    if (/test|spec|__tests__|\.d\.ts$/i.test(path)) score -= 50;
    return { path, score };
  });
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const picked: string[] = [];
  for (const row of scored) {
    if (row.score <= 0) continue;
    if (picked.includes(row.path)) continue;
    picked.push(row.path);
    if (picked.length >= MAX_FILE_HEADS) break;
  }
  return picked;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export type HtmlEvidenceFetchOverrides = {
  query?: (session: CodeKbSession, tool: string, args?: Record<string, unknown>) => Promise<unknown | null>;
  readFile?: (
    session: CodeKbSession,
    path: string,
    range?: { startLine?: number; endLine?: number },
  ) => Promise<unknown | null>;
};

/**
 * Deterministic HTML folio: inventory + hotspots + architecture + entry file heads.
 * Returns "" on total miss so prompts stay clean.
 */
export async function fetchHtmlEvidencePack(
  session: CodeKbSession,
  remainingMs: number,
  overrides: HtmlEvidenceFetchOverrides = {},
): Promise<string> {
  try {
    if (remainingMs <= 200) return "";
    const query = overrides.query ?? queryCodeKb;
    const readFile = overrides.readFile ?? readCodeKbFile;
    const deadline = Date.now() + remainingMs;

    const graph = await raceWithBudget(
      Promise.all([
        query(session, "search_graph", { label: "File", limit: INVENTORY_LIMIT }).catch(() => null),
        query(session, "search_graph", { minDegree: HOTSPOT_MIN_DEGREE, limit: HOTSPOT_LIMIT }).catch(() => null),
        query(session, "get_architecture", {}).catch(() => null),
      ]),
      Math.max(200, deadline - Date.now()),
    );
    if (!graph) return "";
    const [fileInventory, hotspots, architecture] = graph;
    const paths = inventoryPaths(fileInventory);
    const entryPaths = pickEntryPaths(paths);

    // Prefer README + manifest first for structure evidence sections
    const readmePath = paths.find((p) => /^readme(\.md|\.rst|\.txt)?$/i.test(p.split("/").pop() || ""));
    const manifestPath = paths.find((p) =>
      /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json)$/i.test(p.split("/").pop() || ""),
    );

    const headPaths = [...new Set([readmePath, manifestPath, ...entryPaths].filter(Boolean) as string[])].slice(
      0,
      MAX_FILE_HEADS,
    );

    const heads = await raceWithBudget(
      mapPool(headPaths, MAX_IN_FLIGHT, async (path) => {
        try {
          const raw = await readFile(session, path, { startLine: 1, endLine: FILE_HEAD_LINES });
          const content = fileContent(raw);
          return content ? { path, content } : null;
        } catch {
          return null;
        }
      }),
      Math.max(200, deadline - Date.now()),
    );

    const files = (heads || []).filter(Boolean) as Array<{ path: string; content: string }>;
    const readmeHead = files.find((f) => /readme/i.test(f.path))?.content;
    const manifest = files.find((f) =>
      /package\.json|pyproject|cargo\.toml|go\.mod|composer/i.test(f.path),
    );

    const structure = renderStructureEvidence({
      fileInventory: fileInventory ?? undefined,
      hotspots: hotspots ?? undefined,
      readmeHead,
      manifestHead: manifest ? { path: manifest.path, content: manifest.content } : undefined,
    });

    const arch = renderCodeKbArchitectureSummary(architecture);
    const sections: string[] = [];
    if (structure) sections.push(structure);
    if (arch) {
      sections.push(
        [
          "<code-kb>",
          "# Architecture map",
          "",
          arch,
          "</code-kb>",
        ].join("\n"),
      );
    }
    const bodyFiles = files.filter((f) => f !== files.find((x) => x.path === readmePath) && f.path !== manifest?.path);
    if (bodyFiles.length) {
      const fileBlocks = bodyFiles
        .map((f) => {
          const body = f.content.length > 4500 ? `${f.content.slice(0, 4500)}\n…` : f.content;
          return `### ${f.path}\n\n\`\`\`\n${body}\n\`\`\``;
        })
        .join("\n\n");
      sections.push(
        [
          "<code-kb>",
          "# Entry file heads (pre-fetched)",
          "",
          "Cite real paths from these heads. Prefer verification lookups only when a claim is not covered here.",
          "",
          fileBlocks,
          "</code-kb>",
        ].join("\n"),
      );
    }

    let pack = sections.filter(Boolean).join("\n\n").trim();
    if (pack.length > MAX_PACK_CHARS) pack = pack.slice(0, MAX_PACK_CHARS) + "\n… [html evidence truncated]";
    return pack;
  } catch {
    return "";
  }
}
