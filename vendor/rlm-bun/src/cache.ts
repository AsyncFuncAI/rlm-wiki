import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { z } from "zod";

const CACHE_DIR = join(tmpdir(), "rlm-cache");

const RepoCacheDirSchema = z.string().optional();

interface CacheEntry {
  repoPath: string;
  fresh: boolean;
}

/**
 * Simple file-system cache for cloned repos.
 * Key: hash of (cloneURL + branch). Value: path to cached clone.
 *
 * Cache entries are validated by checking if the directory still exists
 * and if the git fetch reports no new changes (for shallow clones).
 */
export class RepoCache {
  dir: string;

  constructor(cacheDir?: string) {
    const validated = RepoCacheDirSchema.parse(cacheDir);
    this.dir = validated || CACHE_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Generate a cache key from clone URL + branch.
   */
  _key(cloneURL: string, branch: string | null): string {
    const raw = `${cloneURL}::${branch || "default"}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  /**
   * Get a cached repo path, or null if not cached/stale.
   */
  get(cloneURL: string, branch: string | null): CacheEntry | null {
    const key = this._key(cloneURL, branch);
    const repoPath = join(this.dir, key);

    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git")) || !existsSync(join(repoPath, ".git", "HEAD"))) {
      return null;
    }

    return { repoPath, fresh: false };
  }

  /**
   * Store a repo clone in the cache.
   * Returns the cache path to clone into.
   */
  pathFor(cloneURL: string, branch: string | null): string {
    const key = this._key(cloneURL, branch);
    return join(this.dir, key);
  }

  /**
   * Refresh a cached repo by pulling latest changes.
   */
  refresh(repoPath: string): boolean {
    const result = Bun.spawnSync(
      ["git", "fetch", "--depth", "1", "origin"],
      { cwd: repoPath, stderr: "pipe" }
    );
    if (result.exitCode !== 0) return false;

    const reset = Bun.spawnSync(
      ["git", "reset", "--hard", "origin/HEAD"],
      { cwd: repoPath, stderr: "pipe" }
    );
    return reset.exitCode === 0;
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    Bun.spawnSync(["rm", "-rf", this.dir]);
    mkdirSync(this.dir, { recursive: true });
  }
}

// Singleton default cache
let defaultCache: RepoCache | null = null;

export function getDefaultCache(): RepoCache {
  if (!defaultCache) {
    defaultCache = new RepoCache();
  }
  return defaultCache;
}

