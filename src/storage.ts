import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WikiRecordSchema, normalizeRepoSourcePath, type WikiRecord, wikiKey } from "./types.ts";

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeEntities(rec: WikiRecord): void {
  rec.structure.title = decodeEntities(rec.structure.title);
  rec.structure.description = decodeEntities(rec.structure.description);
  for (const s of rec.structure.sections) {
    s.title = decodeEntities(s.title);
  }
  for (const p of rec.structure.pages) {
    p.title = decodeEntities(p.title);
    p.description = decodeEntities(p.description);
  }
}

// Storage root resolution (first match wins):
//   1. explicit constructor arg     — tests / scripts override everything
//   2. GROK_WIKI_ROOT env var        — desktop/prod knob for mounting a persistent volume
//   3. ~/.rlm-wiki                   — local-dev default
function defaultRoot(): string {
  const fromEnv = process.env.GROK_WIKI_ROOT?.trim() || process.env.RLM_WIKI_ROOT?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".rlm-wiki");
}

export class WikiStore {
  readonly root: string;
  readonly wikisDir: string;
  readonly sessionsDir: string;

  constructor(root?: string) {
    this.root = root ?? defaultRoot();
    this.wikisDir = join(this.root, "wikis");
    this.sessionsDir = join(this.root, "sessions");
    mkdirSync(this.wikisDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  pathFor(owner: string, repo: string): string {
    return join(this.wikisDir, `${wikiKey({ owner, repo })}.json`);
  }

  pathForRecord(record: Pick<WikiRecord, "id" | "owner" | "repo">): string {
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id) {
      const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || wikiKey(record);
      return join(this.wikisDir, `${safeId}.json`);
    }
    return this.pathFor(record.owner, record.repo);
  }

  has(owner: string, repo: string): boolean {
    return existsSync(this.pathFor(owner, repo));
  }

  load(owner: string, repo: string): WikiRecord | null {
    const p = this.pathFor(owner, repo);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const record = WikiRecordSchema.parse(parsed);
    // Backfill: decode HTML entities that leaked into titles/descriptions
    // in older records generated before the XML parser decoded them.
    normalizeEntities(record);
    return record;
  }

  loadForRef(ref: {
    owner: string;
    repo: string;
    branch?: string | null;
    sourcePath?: string | null;
  }): WikiRecord | null {
    const owner = String(ref.owner || "").trim();
    const repo = String(ref.repo || "").trim();
    if (!owner || !repo || !existsSync(this.wikisDir)) return null;

    const branch = String(ref.branch || "").trim();
    const sourcePath = normalizeRepoSourcePath(ref.sourcePath) || "";
    const matches: WikiRecord[] = [];
    for (const file of readdirSync(this.wikisDir).filter((name) => name.endsWith(".json"))) {
      try {
        const raw = readFileSync(join(this.wikisDir, file), "utf8");
        const record = WikiRecordSchema.parse(JSON.parse(raw));
        normalizeEntities(record);
        if (record.owner !== owner || record.repo !== repo) continue;
        if (String(record.branch || "").trim() !== branch) continue;
        if ((normalizeRepoSourcePath(record.sourcePath) || "") !== sourcePath) continue;
        matches.push(record);
      } catch {
        continue;
      }
    }
    matches.sort((a, b) => String(b.updatedAt || b.generatedAt || "").localeCompare(String(a.updatedAt || a.generatedAt || "")));
    if (matches[0]) return matches[0];
    return !branch && !sourcePath ? this.load(owner, repo) : null;
  }

  loadById(id: string): WikiRecord | null {
    const safeId = id.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safeId) return null;
    const p = join(this.wikisDir, `${safeId}.json`);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    const record = WikiRecordSchema.parse(parsed);
    normalizeEntities(record);
    return record;
  }

  save(record: WikiRecord): void {
    const validated = WikiRecordSchema.parse(record);
    const p = this.pathForRecord(record);
    writeFileSync(p, JSON.stringify(validated, null, 2), "utf8");
  }

  list(): Array<{ id?: string; owner: string; repo: string; repos?: WikiRecord["repos"]; branch?: string | null; sourcePath?: string | null; sourceKey?: string; variantKey?: string; createdAt?: string; updatedAt?: string; generatedAt: string; title: string; description: string; pageCount: number; sourceCount: number; model?: string; structureModel?: string; pageModel?: string; runtime?: string; runtimeModelLabel?: string; wikiDepth?: string; wikiPageCount?: number; wikiStyle?: string; wikiStylePrompt?: string; wikiLanguages?: string[] }> {
    if (!existsSync(this.wikisDir)) return [];
    const files = readdirSync(this.wikisDir).filter((f) => f.endsWith(".json"));
    const out: Array<{ id?: string; owner: string; repo: string; repos?: WikiRecord["repos"]; branch?: string | null; sourcePath?: string | null; sourceKey?: string; variantKey?: string; createdAt?: string; updatedAt?: string; generatedAt: string; title: string; description: string; pageCount: number; sourceCount: number; model?: string; structureModel?: string; pageModel?: string; runtime?: string; runtimeModelLabel?: string; wikiDepth?: string; wikiPageCount?: number; wikiStyle?: string; wikiStylePrompt?: string; wikiLanguages?: string[] }> = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(this.wikisDir, f), "utf8");
        const parsed = JSON.parse(raw);
        const rec = WikiRecordSchema.parse(parsed);
        normalizeEntities(rec);
        const sourceCount = new Set(
          rec.structure.pages.flatMap((page) => Array.isArray(page.filePaths) ? page.filePaths : []),
        ).size;
        out.push({
          id: rec.id,
          owner: rec.owner,
          repo: rec.repo,
          repos: rec.repos,
          branch: rec.branch,
          sourcePath: rec.sourcePath ?? null,
          sourceKey: rec.sourceKey,
          variantKey: rec.variantKey,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          generatedAt: rec.generatedAt,
          title: rec.structure.title,
          description: rec.structure.description,
          pageCount: Object.keys(rec.pages).length,
          sourceCount,
          model: rec.model,
          structureModel: rec.structureModel,
          pageModel: rec.pageModel,
          runtime: rec.runtime,
          runtimeModelLabel: rec.runtimeModelLabel,
          wikiDepth: rec.wikiDepth,
          wikiPageCount: rec.wikiPageCount,
          wikiStyle: rec.wikiStyle,
          wikiStylePrompt: rec.wikiStylePrompt,
          wikiLanguages: rec.wikiLanguages,
        });
      } catch {
        continue;
      }
    }
    out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return out;
  }
}
