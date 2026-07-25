/// <reference types="node" />

import { randomBytes, randomUUID } from "node:crypto";
import { WikiRecordSchema, type GeneratedPage, type WikiPage, type WikiRecord, type WorkspaceRepoRef } from "./types.ts";

export const PUBLIC_WIKI_SCHEMA_VERSION = 1;
export type PublicWikiVisibility = "public" | "private";

export type PublicWikiSnapshot = {
  schemaVersion: typeof PUBLIC_WIKI_SCHEMA_VERSION;
  publicId: string;
  published: true;
  visibility: PublicWikiVisibility;
  surface: PublicWikiSurface;
  readOnly: true;
	  owner: string;
	  repo: string;
	  branch: string | null;
	  sourcePath?: string | null;
	  title: string;
  description: string;
  generatedAt: string;
  publishedAt: string;
  updatedAt: string;
  wiki: WikiRecord;
};

export type PublicWikiPublication = {
  published: boolean;
  publicId: string | null;
  publicPath: string | null;
  publicUrl: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  unpublishedAt?: string | null;
  title: string | null;
  readOnly: true;
  visibility?: PublicWikiVisibility;
  surface?: PublicWikiSurface;
  needsUpdate?: boolean;
};

export type PublicWikiSurface = "wiki" | "docs";

export function normalizePublicWikiId(value: unknown): string {
  const clean = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,95}$/.test(clean) ? clean : "";
}

export function publicWikiPath(publicId: string, visibility?: PublicWikiVisibility | null): string {
  return publicWikiPathForSurface(publicId, visibility, "wiki");
}

export function publicWikiPathForSurface(
  publicId: string,
  visibility?: PublicWikiVisibility | null,
  surface?: PublicWikiSurface | null,
): string {
  const surfacePart = normalizePublicWikiSurface(surface) === "docs" ? "docs" : "wiki";
  const prefix = normalizePublicWikiVisibility(visibility) === "private" ? `/share/${surfacePart}` : `/public/${surfacePart}`;
  return `${prefix}/${encodeURIComponent(publicId)}`;
}

export function publicWikiUrl(
  baseUrl: string,
  publicId: string,
  visibility?: PublicWikiVisibility | null,
  surface?: PublicWikiSurface | null,
): string {
  return `${baseUrl.replace(/\/+$/, "")}${publicWikiPathForSurface(publicId, visibility, surface)}`;
}

export function normalizePublicWikiVisibility(value: unknown): PublicWikiVisibility {
  return value === "private" ? "private" : "public";
}

export function normalizePublicWikiSurface(value: unknown): PublicWikiSurface {
  return value === "docs" ? "docs" : "wiki";
}

export function publicWikiSurfaceForRecord(record: Pick<WikiRecord, "wikiStyle"> | null | undefined): PublicWikiSurface {
  return record?.wikiStyle === "documentation" ? "docs" : "wiki";
}

export function makePublicWikiId(owner: string, repo: string): string {
  const prefix = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "wiki";
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function makePrivateWikiId(): string {
  return `private-${randomBytes(16).toString("hex")}`;
}

export function publicWikiPublicationFromSnapshot(
  snapshot: PublicWikiSnapshot,
  baseUrl: string,
  extra: Pick<PublicWikiPublication, "needsUpdate"> = {},
): PublicWikiPublication {
  return {
    published: true,
    publicId: snapshot.publicId,
    publicPath: publicWikiPathForSurface(snapshot.publicId, snapshot.visibility, snapshot.surface),
    publicUrl: publicWikiUrl(baseUrl, snapshot.publicId, snapshot.visibility, snapshot.surface),
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
    title: snapshot.title,
    readOnly: true,
    visibility: normalizePublicWikiVisibility(snapshot.visibility),
    surface: normalizePublicWikiSurface(snapshot.surface),
    ...extra,
  };
}

export function wikiPublicationRecordVersion(record: Pick<WikiRecord, "updatedAt" | "generatedAt">): string {
  return String(record.updatedAt || record.generatedAt || "");
}

export function sanitizePublicWikiRecord(value: unknown): WikiRecord {
  const record = WikiRecordSchema.parse(value);
  const pageIds = new Set(record.structure.pages.map((page) => page.id));
  const pages: Record<string, GeneratedPage> = {};
  for (const [pageId, page] of Object.entries(record.pages || {})) {
    if (!pageIds.has(pageId)) continue;
    pages[pageId] = {
      id: page.id,
      content: String(page.content || ""),
      generatedAt: String(page.generatedAt || record.generatedAt),
      // KB freshness metadata must ride through the sanitizer or the per-card
      // status/lastUpdated/contradicts never reaches the public markdown builders
      // (the schema field alone is necessary but not sufficient - Phase 3 review fix).
      ...(page.kb ? { kb: page.kb } : {}),
    };
  }

  return {
    id: cleanOptional(record.id),
    repoUrl: safePublicRepoUrl(record.repoUrl),
    owner: record.owner,
    repo: record.repo,
    repos: sanitizeRepos(record.repos),
    branch: record.branch ?? null,
    sourcePath: cleanOptional(record.sourcePath),
    sourceKey: cleanOptional(record.sourceKey),
    variantKey: cleanOptional(record.variantKey),
    createdAt: cleanOptional(record.createdAt),
    updatedAt: cleanOptional(record.updatedAt),
    generatedAt: record.generatedAt,
    model: record.model,
    structureModel: cleanOptional(record.structureModel),
    pageModel: cleanOptional(record.pageModel),
    runtime: cleanOptional(record.runtime),
    runtimeModelLabel: cleanOptional(record.runtimeModelLabel),
    wikiDepth: record.wikiDepth,
    wikiPageCount: record.wikiPageCount,
    wikiPageCountMode: record.wikiPageCountMode,
    wikiStyle: record.wikiStyle,
    wikiLanguages: record.wikiLanguages,
    structure: {
      title: record.structure.title,
      description: record.structure.description,
      sections: record.structure.sections.map((section) => ({
        id: section.id,
        title: section.title,
        pages: section.pages.filter((pageId) => pageIds.has(pageId)),
        subsections: section.subsections || [],
      })),
      pages: record.structure.pages.map(sanitizeStructurePage),
    },
    pages,
  };
}

export function createPublicWikiSnapshot(args: {
  publicId: string;
  record: unknown;
  visibility?: PublicWikiVisibility;
  publishedAt?: string;
  updatedAt?: string;
}): PublicWikiSnapshot {
  const publicId = normalizePublicWikiId(args.publicId);
  if (!publicId) throw new Error("Invalid public wiki id.");
  const wiki = sanitizePublicWikiRecord(args.record);
  const now = new Date().toISOString();
  return {
    schemaVersion: PUBLIC_WIKI_SCHEMA_VERSION,
    publicId,
    published: true,
    visibility: normalizePublicWikiVisibility(args.visibility),
    surface: publicWikiSurfaceForRecord(wiki),
    readOnly: true,
    owner: wiki.owner,
	    repo: wiki.repo,
	    branch: wiki.branch ?? null,
	    sourcePath: wiki.sourcePath ?? null,
	    title: wiki.structure.title,
    description: wiki.structure.description,
    generatedAt: wiki.generatedAt,
    publishedAt: args.publishedAt || now,
    updatedAt: args.updatedAt || now,
    wiki,
  };
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function safePublicRepoUrl(value: unknown): string {
  const text = String(value || "").trim();
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/i.test(text) ? text.replace(/\/$/, "") : "";
}

function sanitizeRepos(repos: WikiRecord["repos"]): WorkspaceRepoRef[] | undefined {
  if (!Array.isArray(repos) || !repos.length) return undefined;
  return repos.map((repo) => ({
    id: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    label: repo.label,
	    url: safePublicRepoUrl(repo.url),
	    branch: repo.branch ?? null,
	    sourcePath: cleanOptional(repo.sourcePath),
	  }));
}

function sanitizeStructurePage(page: WikiPage): WikiPage {
  return {
    id: page.id,
    title: page.title,
    description: page.description,
    importance: page.importance,
    filePaths: page.filePaths.map(safeSourcePath).filter(Boolean),
    relatedPages: page.relatedPages || [],
    parentSection: page.parentSection,
  };
}

function safeSourcePath(value: unknown): string {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:\//.test(text)) return "";
  if (text.split("/").some((part) => part === "..")) return "";
  return text.slice(0, 260);
}
