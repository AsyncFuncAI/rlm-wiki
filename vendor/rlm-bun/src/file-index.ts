/**
 * File index builder — builds metadata about files for the LLM prompt.
 * Parallel to repo-index.ts but without git dependency.
 */

import { join, extname } from "path";
import { statSync } from "fs";

/** File type detection by extension */
const TYPE_MAP: Record<string, string> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".log": "log",
  ".ini": "config",
  ".cfg": "config",
  ".conf": "config",
  ".env": "config",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".js": "javascript",
  ".ts": "typescript",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c-header",
  ".sh": "shell",
  ".sql": "sql",
};

interface FileTypeStats {
  count: number;
  totalSize: number;
  totalLines: number;
  extensions: string[];
}

interface FileSizeEntry {
  file: string;
  size: number;
  lines: number;
  type: string;
}

interface FileIndexStats {
  totalFiles: number;
  totalSize: number;
  totalLines: number;
  fileTypes: Record<string, FileTypeStats>;
  largestFiles: FileSizeEntry[];
}

export interface FileIndex {
  basePath: string;
  fileTree: string[];
  type: "single" | "directory";
  stats: FileIndexStats;
  structure: string;
}

/**
 * Build an index of files for the LLM prompt.
 */
export async function buildFileIndex(basePath: string, files: string[]): Promise<FileIndex> {
  const fileTypes: Record<string, { count: number; totalSize: number; totalLines: number; extensions: Set<string> }> = {};
  let totalSize = 0;
  let totalLines = 0;
  const largestFiles: FileSizeEntry[] = [];

  for (const file of files) {
    const abs = join(basePath, file);
    let size = 0;
    let lines = 0;

    try {
      const st = statSync(abs);
      size = st.size;
    } catch {
      continue;
    }

    // Count lines for text files (skip very large ones to avoid blocking)
    if (size < 50_000_000) {
      try {
        const content = await Bun.file(abs).text();
        lines = content.split("\n").length;
      } catch {
        // binary or encoding issue
      }
    }

    const ext = extname(file).toLowerCase() || "no-ext";
    const type = TYPE_MAP[ext] || "other";

    if (!fileTypes[type]) {
      fileTypes[type] = { count: 0, totalSize: 0, totalLines: 0, extensions: new Set() };
    }
    fileTypes[type].count++;
    fileTypes[type].totalSize += size;
    fileTypes[type].totalLines += lines;
    fileTypes[type].extensions.add(ext);

    totalSize += size;
    totalLines += lines;

    largestFiles.push({ file, size, lines, type });
  }

  largestFiles.sort((a, b) => b.size - a.size);

  // Convert Set to Array for serialization
  const serializedTypes: Record<string, FileTypeStats> = {};
  for (const [key, t] of Object.entries(fileTypes)) {
    serializedTypes[key] = { ...t, extensions: [...t.extensions] };
  }

  const structure = buildTree(files, 3);

  return {
    basePath,
    fileTree: files,
    type: files.length === 1 ? "single" : "directory",
    stats: {
      totalFiles: files.length,
      totalSize,
      totalLines,
      fileTypes: serializedTypes,
      largestFiles: largestFiles.slice(0, 10),
    },
    structure,
  };
}

/**
 * Build an ASCII directory tree from file paths.
 */
function buildTree(files: string[], maxDepth: number): string {
  const tree: Record<string, any> = {};
  for (const f of files) {
    const parts = f.split("/");
    let node = tree;
    for (let i = 0; i < Math.min(parts.length, maxDepth + 1); i++) {
      const p = parts[i];
      if (i === parts.length - 1 || i === maxDepth) {
        node[p] = null; // leaf
      } else {
        if (!node[p]) node[p] = {};
        node = node[p];
      }
    }
  }

  const lines: string[] = [];
  function render(obj: Record<string, any>, prefix: string): void {
    const keys = Object.keys(obj).sort();
    for (let i = 0; i < keys.length; i++) {
      const isLast = i === keys.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(prefix + connector + keys[i]);
      if (obj[keys[i]] && typeof obj[keys[i]] === "object") {
        render(obj[keys[i]], prefix + (isLast ? "    " : "│   "));
      }
    }
  }

  render(tree, "");
  return lines.join("\n");
}

/**
 * Format the file index for inclusion in an LLM prompt.
 */
export function formatFileIndex(index: FileIndex): string {
  const { stats } = index;

  const typeSummary = Object.entries(stats.fileTypes)
    .sort((a, b) => b[1].totalSize - a[1].totalSize)
    .map(
      ([type, s]) =>
        `  ${type}: ${s.count} file${s.count > 1 ? "s" : ""}, ${formatBytes(s.totalSize)}, ${s.totalLines.toLocaleString()} lines`
    )
    .join("\n");

  const largestSummary = stats.largestFiles
    .slice(0, 5)
    .map(
      (f) =>
        `  ${f.file} (${formatBytes(f.size)}, ${f.lines.toLocaleString()} lines, ${f.type})`
    )
    .join("\n");

  return [
    `Source: ${index.basePath}`,
    `Type: ${index.type === "single" ? "Single file" : "Directory"}`,
    `Files: ${stats.totalFiles} | Total size: ${formatBytes(stats.totalSize)} | Lines: ${stats.totalLines.toLocaleString()}`,
    "",
    "File types:",
    typeSummary,
    "",
    "Largest files:",
    largestSummary,
    "",
    "Structure:",
    index.structure,
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

