import { createHash, randomUUID } from "node:crypto";
import type { RepoRef, WikiRecord, WorkspaceRepoRef } from "./types.ts";
import { normalizeWikiLanguages, normalizeWikiStyle, normalizeWikiStylePrompt } from "./wiki-options.ts";
import { normalizeKnowledgeProfile } from "./knowledge-profile.ts";

function cleanPart(value: unknown): string {
  return String(value || "").trim();
}

function cleanKeyPart(value: unknown): string {
  return cleanPart(value).toLowerCase();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function createWikiId(owner: string, repo: string, sourcePath?: string | null): string {
  const prefix =
    `${owner}-${repo}${sourcePath ? `-${sourcePath}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "wiki";
  return `wiki-${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function wikiSourceKey(ref: RepoRef, refs?: WorkspaceRepoRef[]): string {
  const refKey = (item: Pick<RepoRef, "owner" | "repo" | "branch" | "sourcePath">): string =>
    `${cleanKeyPart(item.owner)}/${cleanKeyPart(item.repo)}@${cleanKeyPart(item.branch)}${
      cleanPart(item.sourcePath) ? `#${cleanKeyPart(item.sourcePath)}` : ""
    }`;
  const parts = refs?.length
    ? refs.map(refKey)
    : [refKey(ref)];
  return parts.sort().join("+");
}

export function wikiVariantKey(args: {
  ref: RepoRef;
  refs?: WorkspaceRepoRef[];
  style?: unknown;
  stylePrompt?: unknown;
  pageCount?: unknown;
  pageCountMode?: unknown;
  languages?: unknown;
  knowledgeProfile?: unknown;
}): string {
  const source = wikiSourceKey(args.ref, args.refs);
  const style = normalizeWikiStyle(args.style);
  const prompt = style === "custom" ? normalizeWikiStylePrompt(args.stylePrompt) : "";
  const languages = normalizeWikiLanguages(args.languages).join(",");
  const pageCount = Number.isFinite(Number(args.pageCount)) ? String(Number(args.pageCount)) : "";
  const pageCountMode = args.pageCountMode === "fixed" ? "fixed" : args.pageCountMode === "auto" ? "auto" : "";
  const knowledge = normalizeKnowledgeProfile(args.knowledgeProfile);
  return [
    source,
    `style:${style}`,
    pageCount ? `pages:${pageCount}` : "",
    pageCountMode ? `pages-mode:${pageCountMode}` : "",
    languages ? `lang:${languages}` : "",
    knowledge.mode !== "basic" ? `knowledge:${knowledge.packId || knowledge.mode}` : "",
    prompt ? `prompt:${shortHash(prompt)}` : "",
  ]
    .filter(Boolean)
    .join("|");
}

export function ensureWikiRecordIdentity(record: WikiRecord): WikiRecord {
  const ref: RepoRef = {
    owner: record.owner,
    repo: record.repo,
    url: record.repoUrl,
    branch: record.branch ?? null,
    sourcePath: record.sourcePath ?? null,
  };
  const sourceKey = record.sourceKey || wikiSourceKey(ref, record.repos);
  const variantKey =
    record.variantKey ||
    wikiVariantKey({
      ref,
      refs: record.repos,
      style: record.wikiStyle,
      stylePrompt: record.wikiStylePrompt,
      pageCount: record.wikiPageCount,
      pageCountMode: record.wikiPageCountMode,
      languages: record.wikiLanguages,
      knowledgeProfile: record.knowledgeProfile,
    });
  const timestamp = record.createdAt || record.generatedAt || new Date().toISOString();
  return {
    ...record,
    id: record.id || createWikiId(record.owner, record.repo, record.sourcePath),
    sourceKey,
    variantKey,
    createdAt: record.createdAt || timestamp,
    updatedAt: record.updatedAt || record.generatedAt || timestamp,
  };
}
