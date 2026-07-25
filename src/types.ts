import { z } from "zod";
import { WIKI_RECORD_STYLES } from "./wiki-options.ts";

export const WikiPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  importance: z.enum(["high", "medium", "low"]),
  filePaths: z.array(z.string()),
  relatedPages: z.array(z.string()).default([]),
  parentSection: z.string().optional(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  pages: z.array(z.string()),
  subsections: z.array(z.string()).default([]),
});
export type WikiSection = z.infer<typeof WikiSectionSchema>;

export const WikiStructureSchema = z.object({
  title: z.string(),
  description: z.string(),
  sections: z.array(WikiSectionSchema),
  pages: z.array(WikiPageSchema),
});
export type WikiStructure = z.infer<typeof WikiStructureSchema>;

/**
 * Per-card freshness metadata carried on a generated page when the page is a
 * Knowledge Base card (Phase 3). Schema-only here; population happens in
 * `kbRecordFromArtifact`. Adding it to the schema is necessary but NOT sufficient
 * to publish it - `sanitizePublicWikiRecord` must also copy it through (it hardcodes
 * `{id, content, generatedAt}`), so the passthrough lives in src/public-wiki.ts too.
 */
export const KbPageMetadataSchema = z.object({
  status: z.enum(["provisional", "corroborated"]),
  lastUpdated: z.string(),
  sourceAskIds: z.array(z.string()).default([]),
  contradicts: z.array(z.string()).default([]),
  topicTags: z.array(z.string()).default([]),
  corroborationCount: z.number().int().min(0).default(0),
});
export type KbPageMetadata = z.infer<typeof KbPageMetadataSchema>;

export const GeneratedPageSchema = z.object({
  id: z.string(),
  content: z.string(),
  generatedAt: z.string(),
  kb: KbPageMetadataSchema.optional(),
  status: z.enum(["generated", "failed"]).optional(),
  error: z.string().optional(),
  displayError: z.string().optional(),
  sessionId: z.string().optional(),
  stylePrompt: z.string().optional(),
  stylePromptOverride: z.boolean().optional(),
  tokenUsage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
});
export type GeneratedPage = z.infer<typeof GeneratedPageSchema>;

export const WikiRecordSchema = z.object({
  id: z.string().optional(),
  repoUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  repos: z.array(z.object({
    id: z.string(),
    owner: z.string(),
    repo: z.string(),
    label: z.string(),
    url: z.string(),
    branch: z.string().nullable().default(null),
    sourcePath: z.string().nullable().optional(),
  })).optional(),
  branch: z.string().nullable().default(null),
  sourcePath: z.string().nullable().optional(),
  sourceKey: z.string().optional(),
  variantKey: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  generatedAt: z.string(),
  model: z.string(),
  structureModel: z.string().optional(),
  pageModel: z.string().optional(),
  runtime: z.string().optional(),
  runtimeModelLabel: z.string().optional(),
  wikiDepth: z.enum(["fast", "regular", "deep"]).optional(),
  wikiPageCount: z.number().int().min(1).max(30).optional(),
  wikiPageCountMode: z.enum(["auto", "fixed"]).optional(),
  wikiStyle: z.enum(WIKI_RECORD_STYLES).optional(),
  wikiStylePrompt: z.string().optional(),
  wikiLanguages: z.array(z.enum(["en", "es", "pt", "ja", "zh", "zh-Hans", "zh-Hant", "ko", "fr", "de", "ru", "ar", "he", "id", "ms"])).optional(),
  knowledgeProfile: z.unknown().optional(),
  structure: WikiStructureSchema,
  pages: z.record(z.string(), GeneratedPageSchema),
  structureSessionId: z.string().optional(),
});
export type WikiRecord = z.infer<typeof WikiRecordSchema>;

export interface RepoRef {
  owner: string;
  repo: string;
  url: string;
  branch: string | null;
  sourcePath?: string | null;
}

export interface WorkspaceRepoRef extends RepoRef {
  id: string;
  label: string;
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeRepoSourcePath(value: unknown): string | null {
  const text = String(value || "").trim().split(/[?#]/)[0]?.replace(/\\/g, "/") || "";
  if (!text) return null;
  const parts = text
    .split("/")
    .map((part) => safeDecodeUriComponent(part).trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || null;
}

function isGithubBranchNamespace(value: string): boolean {
  return ["feature", "feat", "fix", "bugfix", "hotfix", "release", "chore", "wip"].includes(value);
}

function isLikelyGithubPathRoot(value: string): boolean {
  const clean = safeDecodeUriComponent(value).trim().toLowerCase();
  return [
    ".github",
    "api",
    "app",
    "apps",
    "backend",
    "bin",
    "client",
    "cmd",
    "codex-rs",
    "crates",
    "docs",
    "examples",
    "frontend",
    "internal",
    "lib",
    "libs",
    "packages",
    "pkg",
    "public",
    "scripts",
    "server",
    "src",
    "test",
    "tests",
    "tools",
    "web",
  ].includes(clean);
}

function parseGithubTreeRefPath(parts: string[]): { branch: string | null; sourcePath: string | null } {
  if (!parts.length) return { branch: null, sourcePath: null };
  const cleanParts = parts
    .join("/")
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean);
  if (!cleanParts.length) return { branch: null, sourcePath: null };
  if (cleanParts.length <= 2 && isGithubBranchNamespace(cleanParts[0] || "")) {
    return {
      branch: cleanParts.map((part) => safeDecodeUriComponent(part).trim()).filter(Boolean).join("/") || null,
      sourcePath: null,
    };
  }
  if (
    isGithubBranchNamespace(cleanParts[0] || "") &&
    cleanParts.length > 2 &&
    !isLikelyGithubPathRoot(cleanParts[1] || "")
  ) {
    const branch = cleanParts
      .slice(0, 2)
      .map((part) => safeDecodeUriComponent(part).trim())
      .filter(Boolean)
      .join("/") || null;
    return {
      branch,
      sourcePath: normalizeRepoSourcePath(cleanParts.slice(2).join("/")),
    };
  }
  const branch = safeDecodeUriComponent(cleanParts[0] || "").trim() || null;
  return {
    branch,
    sourcePath: normalizeRepoSourcePath(cleanParts.slice(1).join("/")),
  };
}

function parseShorthandRef(value: string | null | undefined): { branch: string | null; sourcePath: string | null } {
  const text = String(value || "").trim();
  if (!text) return { branch: null, sourcePath: null };
  const [branch, sourcePath] = text.split(/:(.+)/, 2);
  return {
    branch: branch.trim() || null,
    sourcePath: normalizeRepoSourcePath(sourcePath),
  };
}

export function parseGithubUrl(input: string): RepoRef {
  const raw = input.trim();
  const trimmed = (raw.match(/github\.com/i) ? raw.split(/[?#]/)[0] || raw : raw).replace(/\/$/, "");
  const ghMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?(?:\/(.*))?$/i,
  );
  if (ghMatch) {
    const rest = ghMatch[3] || "";
    const restParts = rest.split("/").filter(Boolean);
    let branch: string | null = null;
    let sourcePath: string | null = null;
    if (restParts[0] === "tree" && restParts[1]) {
      const parsed = parseGithubTreeRefPath(restParts.slice(1));
      branch = parsed.branch;
      sourcePath = parsed.sourcePath;
    } else if (restParts[0] === "blob" && restParts[1]) {
      const parsed = parseGithubTreeRefPath(restParts.slice(1));
      branch = parsed.branch;
      sourcePath = parsed.sourcePath;
    }
    return {
      owner: ghMatch[1],
      repo: ghMatch[2],
      url: `https://github.com/${ghMatch[1]}/${ghMatch[2]}`,
      branch,
      sourcePath,
    };
  }
  const shortMatch = trimmed.match(
    /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@(.+))?$/,
  );
  if (shortMatch) {
    const parsedRef = parseShorthandRef(shortMatch[3]);
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}`,
      branch: parsedRef.branch,
      sourcePath: parsedRef.sourcePath,
    };
  }
  throw new Error(
    `Could not parse as a GitHub URL or owner/repo shorthand: "${input}"`,
  );
}

export function workspaceRepoId(ref: Pick<RepoRef, "owner" | "repo" | "sourcePath">): string {
  return (
    `${ref.owner}-${ref.repo}${ref.sourcePath ? `-${ref.sourcePath}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "repo"
  );
}

export function assignWorkspaceRepoIds(refs: RepoRef[]): WorkspaceRepoRef[] {
  const used = new Set<string>();
  return refs.map((ref) => {
    const base = workspaceRepoId(ref);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      ...ref,
      id,
      label: ref.sourcePath ? `${ref.owner}/${ref.repo}:${ref.sourcePath}` : `${ref.owner}/${ref.repo}`,
    };
  });
}

export function wikiRefForWorkspace(refs: WorkspaceRepoRef[]): RepoRef {
  if (!refs.length) {
    throw new Error("wikiRefForWorkspace requires at least one repository");
  }
  if (refs.length === 1) {
    const ref = refs[0];
    return { owner: ref.owner, repo: ref.repo, url: ref.url, branch: ref.branch, sourcePath: ref.sourcePath ?? null };
  }
  const primary = refs[0];
  const suffix = refs
    .slice(1)
    .map((ref) => `${ref.owner}-${ref.repo}`)
    .join("--");
  const repo = `${primary.repo}--with--${suffix}`
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
  return {
    owner: primary.owner,
    repo: repo || primary.repo,
    url: primary.url,
    branch: null,
    sourcePath: null,
  };
}

export function wikiKey(ref: Pick<RepoRef, "owner" | "repo">): string {
  return `${ref.owner}_${ref.repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
