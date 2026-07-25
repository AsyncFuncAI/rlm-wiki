/**
 * File source loader — loads single files or directories for analysis.
 * No git dependency. Parallel to source-loader.ts (which handles git repos).
 */

import { resolve, dirname, basename, extname } from "path";
import { existsSync, statSync, readdirSync } from "fs";

/** Directories to skip when walking */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__",
  ".tox", ".venv", "venv", ".mypy_cache", ".pytest_cache",
  "dist", "build", ".next", ".nuxt", "coverage",
]);

/** Binary extensions to skip */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pyc", ".class", ".o", ".wasm",
]);

export interface FileSourceResult {
  basePath: string;
  files: string[];
  type: "single" | "directory";
  cleanup: () => Promise<void>;
}

/**
 * Load a file or directory for analysis.
 */
export async function loadFileSource(source: string): Promise<FileSourceResult> {
  const sourcePath = resolve(source);

  if (!existsSync(sourcePath)) {
    throw new Error(`Path does not exist: ${sourcePath}`);
  }

  const stats = statSync(sourcePath);

  if (stats.isFile()) {
    return {
      basePath: dirname(sourcePath),
      files: [basename(sourcePath)],
      type: "single",
      cleanup: async () => {},
    };
  }

  if (stats.isDirectory()) {
    const files = walkDirectory(sourcePath, sourcePath);
    return {
      basePath: sourcePath,
      files,
      type: "directory",
      cleanup: async () => {},
    };
  }

  throw new Error(`Unsupported source type: ${sourcePath}`);
}

/**
 * Recursively walk a directory and return relative file paths.
 */
function walkDirectory(dir: string, root: string, maxFiles: number = 5000): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // skip permission errors
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(resolve(current, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;

        const rel = resolve(current, entry.name).slice(root.length + 1);
        results.push(rel);
      }
    }
  }

  walk(dir);
  return results.sort();
}

