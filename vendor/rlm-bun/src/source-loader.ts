import { existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { z } from "zod";
import { getDefaultCache } from "./cache.ts";

const LoadSourceOptsSchema = z.object({
  branch: z.string().nullish(),
  sourcePath: z.string().nullish(),
  tmpDir: z.string().optional(),
  cache: z.boolean().optional().default(true),
});
type LoadSourceOpts = z.input<typeof LoadSourceOptsSchema>;

export interface LoadSourceResult {
  repoPath: string;
  checkoutPath?: string;
  sourcePath?: string | null;
  cleanup: () => Promise<void>;
  cached: boolean;
}

interface ParsedGitHubURL {
  cloneURL: string;
  branch: string | null;
  sourcePath: string | null;
}

/**
 * Resolve a GitHub URL or local path to a local repo directory.
 */
export async function loadSource(source: string, opts: LoadSourceOpts = {}): Promise<LoadSourceResult> {
  const validatedOpts = LoadSourceOptsSchema.parse(opts);
  if (isGitHubURL(source)) {
    return cloneGitHub(source, validatedOpts);
  }
  return resolveLocal(source, validatedOpts);
}

function isGitHubURL(str: string): boolean {
  return (
    /^https?:\/\/(www\.)?github\.com\//.test(str) ||
    /^git@github\.com:/.test(str)
  );
}

export function isPRURL(str: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(str);
}

/**
 * Parse a GitHub URL into clone-able form.
 */
function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRepoSourcePath(value: unknown): string | null {
  const text = String(value || "").trim().split(/[?#]/)[0]?.replace(/\\/g, "/") || "";
  if (!text) return null;
  const parts = text
    .split("/")
    .map((part) => safeDecodePathSegment(part).trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || null;
}

function isGitHubBranchNamespace(value: string): boolean {
  return ["feature", "feat", "fix", "bugfix", "hotfix", "release", "chore", "wip"].includes(value);
}

function isLikelyGitHubPathRoot(value: string): boolean {
  const clean = safeDecodePathSegment(value).trim().toLowerCase();
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

function parseGitHubTreeRefPath(value: string): { branch: string | null; sourcePath: string | null } {
  const parts = String(value || "").split(/[?#]/)[0]?.split("/").filter(Boolean) || [];
  if (!parts.length) return { branch: null, sourcePath: null };
  if (parts.length <= 2 && isGitHubBranchNamespace(parts[0] || "")) {
    return {
      branch: parts.map((part) => safeDecodePathSegment(part).trim()).filter(Boolean).join("/") || null,
      sourcePath: null,
    };
  }
  if (
    isGitHubBranchNamespace(parts[0] || "") &&
    parts.length > 2 &&
    !isLikelyGitHubPathRoot(parts[1] || "")
  ) {
    return {
      branch: parts.slice(0, 2).map((part) => safeDecodePathSegment(part).trim()).filter(Boolean).join("/") || null,
      sourcePath: normalizeRepoSourcePath(parts.slice(2).join("/")),
    };
  }
  return {
    branch: parts[0] ? safeDecodePathSegment(parts[0]).trim() : null,
    sourcePath: normalizeRepoSourcePath(parts.slice(1).join("/")),
  };
}

export function parseGitHubURL(url: string): ParsedGitHubURL {
  // SSH format
  if (url.startsWith("git@")) {
    return { cloneURL: url, branch: null, sourcePath: null };
  }

  // HTTPS — strip trailing slashes
  let cleaned = (url.split(/[?#]/)[0] || url).replace(/\/+$/, "");

  // PR URL — strip /pull/N (and optional sub-paths like /files, /commits)
  const prMatch = cleaned.match(
    /^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/pull\/\d+(\/.*)?$/
  );
  if (prMatch) {
    return { cloneURL: prMatch[1].replace("://www.github.com", "://github.com") + ".git", branch: null, sourcePath: null };
  }

  // Extract branch from /tree/branch pattern
  const treeMatch = cleaned.match(
    /^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/tree\/(.+)$/
  );
  if (treeMatch) {
    const parsed = parseGitHubTreeRefPath(treeMatch[2]);
    return {
      cloneURL: treeMatch[1].replace("://www.github.com", "://github.com") + ".git",
      branch: parsed.branch,
      sourcePath: parsed.sourcePath,
    };
  }

  const blobMatch = cleaned.match(
    /^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/blob\/(.+)$/
  );
  if (blobMatch) {
    const parsed = parseGitHubTreeRefPath(blobMatch[2]);
    return {
      cloneURL: blobMatch[1].replace("://www.github.com", "://github.com") + ".git",
      branch: parsed.branch,
      sourcePath: parsed.sourcePath,
    };
  }

  // Plain repo URL
  if (!cleaned.endsWith(".git")) cleaned += ".git";
  return { cloneURL: cleaned.replace("://www.github.com", "://github.com"), branch: null, sourcePath: null };
}

export function resolveGitHubLoadTarget(
  source: string,
  opts: Pick<LoadSourceOpts, "branch" | "sourcePath"> = {},
): ParsedGitHubURL {
  const { cloneURL, branch: urlBranch, sourcePath: urlSourcePath } = parseGitHubURL(source);
  return {
    cloneURL,
    branch: urlBranch || opts.branch || null,
    sourcePath: normalizeRepoSourcePath(opts.sourcePath ?? urlSourcePath),
  };
}

async function cloneGitHub(source: string, opts: LoadSourceOpts): Promise<LoadSourceResult> {
  const { cloneURL, branch, sourcePath } = resolveGitHubLoadTarget(source, opts);
  const useCache = opts.cache !== false;

  // Check cache first
  if (useCache) {
    const cache = getDefaultCache();
    const cached = cache.get(cloneURL, branch);

    if (cached) {
      // Refresh cached clone
      const refreshed = cache.refresh(cached.repoPath);
      if (refreshed) {
        return scopedLoadSourceResult(cached.repoPath, sourcePath, async () => { }, true);
      }
      // Refresh failed — cache is corrupt, delete and re-clone below
      Bun.spawnSync(["rm", "-rf", cached.repoPath]);
    }

    // Clone into cache directory
    const cachePath = cache.pathFor(cloneURL, branch);
    // Remove any leftover corrupt directory that cache.get() rejected
    if (existsSync(cachePath)) {
      Bun.spawnSync(["rm", "-rf", cachePath]);
    }
    const args = ["git", "clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(cloneURL, cachePath);

    const proc = Bun.spawnSync(args, { stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const err = new TextDecoder().decode(proc.stderr);
      throw new Error(`git clone failed: ${err}`);
    }

    return scopedLoadSourceResult(cachePath, sourcePath, async () => { }, false);
  }

  // No cache — clone to temp directory
  const id = randomBytes(6).toString("hex");
  const base = opts.tmpDir || tmpdir();
  const repoPath = join(base, `rlm-${id}`);

  const args = ["git", "clone", "--depth", "1"];
  if (branch) args.push("--branch", branch);
  args.push(cloneURL, repoPath);

  const proc = Bun.spawnSync(args, { stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr);
    throw new Error(`git clone failed: ${err}`);
  }

  return scopedLoadSourceResult(
    repoPath,
    sourcePath,
    async () => {
      const rm = Bun.spawnSync(["rm", "-rf", repoPath]);
      if (rm.exitCode !== 0) {
        console.warn(`Warning: failed to clean up ${repoPath}`);
      }
    },
    false,
  );
}

function scopedLoadSourceResult(
  checkoutPath: string,
  sourcePath: string | null,
  cleanup: () => Promise<void>,
  cached: boolean,
): LoadSourceResult {
  const repoPath = sourcePath ? join(checkoutPath, sourcePath) : checkoutPath;
  if (sourcePath && (!existsSync(repoPath) || !statSync(repoPath).isDirectory())) {
    throw new Error(`Source path does not exist in repository: ${sourcePath}`);
  }
  return {
    repoPath,
    checkoutPath,
    sourcePath,
    cleanup: async () => {
      await cleanup();
    },
    cached,
  };
}

async function resolveLocal(source: string, opts: LoadSourceOpts): Promise<LoadSourceResult> {
  const repoPath = resolve(source);
  const sourcePath = normalizeRepoSourcePath(opts.sourcePath);

  if (!existsSync(repoPath)) {
    throw new Error(`Path does not exist: ${repoPath}`);
  }

  if (!statSync(repoPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${repoPath}`);
  }

  if (!existsSync(join(repoPath, ".git")) && opts.branch) {
    throw new Error(`Branch or ref selection requires a git repository: ${repoPath}`);
  }

  return scopedLoadSourceResult(repoPath, sourcePath, async () => { }, false);
}

// ── Multi-repo workspace loader ─────────────────────────────────

interface RepoSourceInput {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string | null;
}

interface NormalisedRepoSource {
  id: string | null;
  source: string;
  branch: string | null;
  sourcePath: string | null;
  label: string | null;
}

export interface LoadedRepo {
  id: string | null;
  label: string | null;
  source: string;
  repoPath: string;
  sourcePath?: string | null;
  cleanup: () => Promise<void>;
  cached: boolean;
}

export interface WorkspaceResult {
  repos: LoadedRepo[];
  cleanupAll: () => Promise<void>;
}

/**
 * Derive a stable repoId from a source string or object.
 */
function deriveRepoId(source: string | RepoSourceInput): string {
  const url = typeof source === "string" ? source : source.source;
  // Strip trailing slash, .git suffix, extract basename
  const cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
  const basename = cleaned.split("/").pop() || "repo";
  // lowercase, strip non-alphanumeric except hyphens
  return basename.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Normalise a RepoSource into a consistent shape.
 */
function normaliseRepoSource(source: string | RepoSourceInput): NormalisedRepoSource {
  if (typeof source === "string") {
    return { id: null, source, branch: null, sourcePath: null, label: null };
  }
  return {
    id: source.id || null,
    source: source.source,
    branch: source.branch || null,
    sourcePath: source.sourcePath || null,
    label: source.label || null,
  };
}

/**
 * Load multiple repositories in parallel.
 */
export async function loadWorkspace(
  sources: Array<string | RepoSourceInput>,
  opts: LoadSourceOpts = {}
): Promise<WorkspaceResult> {
  if (!sources || sources.length === 0) {
    throw new Error("loadWorkspace: at least one source is required");
  }

  // Normalise all sources
  const normalised = sources.map(normaliseRepoSource);

  // Assign repoIds with de-duplication
  const usedIds = new Set<string>();
  for (const src of normalised) {
    let id = src.id || deriveRepoId(src.source);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);
    src.id = id;
    if (!src.label) src.label = id;
  }

  // Load all in parallel
  const loaded = await Promise.all(
    normalised.map(async (src) => {
      const result = await loadSource(src.source, {
        ...opts,
        branch: src.branch ?? opts.branch ?? undefined,
        sourcePath: src.sourcePath ?? opts.sourcePath ?? undefined,
      });
      return {
        id: src.id,
        label: src.label,
        source: src.source,
        repoPath: result.repoPath,
        sourcePath: result.sourcePath,
        cleanup: result.cleanup,
        cached: result.cached,
      };
    })
  );

  return {
    repos: loaded,
    cleanupAll: async () => {
      for (const repo of loaded) {
        await repo.cleanup();
      }
    },
  };
}
