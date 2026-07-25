import { join } from "path";
import type { buildGraphifyTools } from "./sandbox/graphify-tools.ts";

const LANGUAGE_MAP: Record<string, string> = {
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C/C++ Header",
  cpp: "C++",
  cc: "C++",
  cs: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  md: "Markdown",
  mdx: "MDX",
  sql: "SQL",
  graphql: "GraphQL",
  proto: "Protocol Buffers",
  dockerfile: "Dockerfile",
  zig: "Zig",
  lua: "Lua",
  r: "R",
  vue: "Vue",
  svelte: "Svelte",
};

interface LanguageStats {
  files: number;
  lines: number;
}

interface FileSize {
  file: string;
  lines: number;
}

interface RepoStats {
  totalFiles: number;
  totalLines: number;
  languages: Record<string, LanguageStats>;
  largestFiles: FileSize[];
}

interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface GitInfo {
  branch: string;
  remoteURL: string;
  recentCommits: GitCommit[];
}

export interface RepoIndex {
  repoPath: string;
  fileTree: string[];
  stats: RepoStats;
  gitInfo: GitInfo;
  structure: string;
}

function exec(cmd: string, cwd: string): string {
  const result = Bun.spawnSync(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(result.stdout).trim();
}

/**
 * Build a repo index: file tree, language stats, git info.
 */
export async function buildRepoIndex(repoPath: string): Promise<RepoIndex> {
  const fileTree = getFileTree(repoPath);
  const stats = buildStats(fileTree, repoPath);
  const gitInfo = getGitInfo(repoPath);
  const structure = buildTree(fileTree, 3);

  return { repoPath, fileTree, stats, gitInfo, structure };
}

function getFileTree(repoPath: string): string[] {
  const out = exec("git ls-files", repoPath);
  if (out) return out.split("\n").filter(Boolean);
  // Fallback when git ls-files fails
  const g = new Bun.Glob("**/*");
  const entries = Array.from(g.scanSync({ cwd: repoPath, dot: false }));
  return entries.filter((f: string) => {
    const parts = f.split("/");
    return !parts.some((p: string) => p === ".git" || p === "node_modules");
  });
}

function buildStats(fileTree: string[], repoPath: string): RepoStats {
  const languages: Record<string, LanguageStats> = {};
  let totalLines = 0;
  const fileSizes: FileSize[] = [];

  for (const file of fileTree) {
    const ext = file.split(".").pop()!.toLowerCase();
    const lang = LANGUAGE_MAP[ext] || ext;

    let lines = 0;
    try {
      const result = Bun.spawnSync(["wc", "-l", join(repoPath, file)], {
        stdout: "pipe",
      });
      const out = new TextDecoder().decode(result.stdout).trim();
      lines = parseInt(out) || 0;
    } catch {
      // Binary or unreadable file
    }

    if (!languages[lang]) languages[lang] = { files: 0, lines: 0 };
    languages[lang].files++;
    languages[lang].lines += lines;
    totalLines += lines;
    fileSizes.push({ file, lines });
  }

  fileSizes.sort((a, b) => b.lines - a.lines);

  return {
    totalFiles: fileTree.length,
    totalLines,
    languages,
    largestFiles: fileSizes.slice(0, 10),
  };
}

function getGitInfo(repoPath: string): GitInfo {
  const branch = exec("git rev-parse --abbrev-ref HEAD", repoPath) || "main";
  const remoteURL = exec("git remote get-url origin", repoPath) || "";

  const logRaw = exec(
    'git log --format=\'{"hash":"%H","author":"%an","date":"%ai","message":"%s"}\' -n 20',
    repoPath
  );

  let recentCommits: GitCommit[] = [];
  if (logRaw) {
    recentCommits = logRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as GitCommit;
        } catch {
          return null;
        }
      })
      .filter((c): c is GitCommit => c !== null);
  }

  return { branch, remoteURL, recentCommits };
}

/**
 * Build a pretty directory tree string from a flat file list.
 */
function buildTree(files: string[], maxDepth: number): string {
  const tree: Record<string, any> = {};

  for (const file of files) {
    const parts = file.split("/");
    let node = tree;
    for (let i = 0; i < parts.length && i < maxDepth; i++) {
      const part = parts[i];
      if (i === parts.length - 1 || i === maxDepth - 1) {
        if (i === maxDepth - 1 && i < parts.length - 1) {
          node[part + "/"] = node[part + "/"] || {};
        } else {
          node[part] = null;
        }
      } else {
        node[part + "/"] = node[part + "/"] || {};
        node = node[part + "/"];
      }
    }
  }

  return renderTree(tree, "");
}

function renderTree(node: Record<string, any>, prefix: string): string {
  const keys = Object.keys(node).sort((a, b) => {
    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const isLast = i === keys.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    lines.push(prefix + connector + key);

    if (node[key] && typeof node[key] === "object") {
      lines.push(renderTree(node[key], prefix + childPrefix));
    }
  }

  return lines.join("\n");
}

/**
 * Format a repo index into a human-readable string for the LLM prompt.
 */
export function formatRepoIndex(index: RepoIndex): string {
  const langSummary = Object.entries(index.stats.languages)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 10)
    .map(([lang, s]) => `${lang} (${s.files} files, ${s.lines.toLocaleString()} lines)`)
    .join(", ");

  const commits = index.gitInfo.recentCommits
    .slice(0, 10)
    .map(
      (c) =>
        `  ${c.hash.slice(0, 7)} ${c.message} (${c.author}, ${c.date.split(" ")[0]})`
    );

  return [
    `Repository: ${index.gitInfo.remoteURL || index.repoPath}`,
    `Branch: ${index.gitInfo.branch}`,
    `Files: ${index.stats.totalFiles} | Lines: ${index.stats.totalLines.toLocaleString()}`,
    `Languages: ${langSummary}`,
    "",
    "Directory structure (depth 3):",
    index.structure,
    "",
    "Recent commits:",
    ...commits,
  ].join("\n");
}

/**
 * Pre-render a compact structural topology block from the graphify knowledge graph.
 *
 * Calls graphifyGodNodes() and graphifyListCommunities() synchronously (pure in-memory,
 * no I/O) and formats the result into a `## Structural Topology` block suitable for
 * direct injection into the system prompt at session start.
 *
 * Returns null if graphTools is null (no graph available — graceful degradation).
 */
export function formatGraphContext(
  graphTools: ReturnType<typeof buildGraphifyTools>
): string | null {
  if (!graphTools) return null;

  try {
    const godResult = graphTools.graphifyGodNodes();
    const commResult = graphTools.graphifyListCommunities();

    const godLines = godResult.godNodes.slice(0, 5).map(
      (n) => `  • ${n.name} (degree ${n.degree}) — ${n.sourceFile || "(unknown)"}`,
    );

    const commLines = commResult.communities.slice(0, 5).map((c) => {
      const preview = c.nodes.slice(0, 3).join(", ");
      const more = c.nodes.length > 3 ? ` … +${c.nodes.length - 3} more` : "";
      return `  • Community #${c.id} (${c.size} nodes): ${preview}${more}`;
    });

    const lines: string[] = [
      `Graph: ${godResult.totalNodes} nodes, ${godResult.totalEdges} edges, ${godResult.communities} communities`,
      "",
      `Top hub nodes (highest connectivity):`,
      ...godLines,
      "",
      `Subsystem communities (Leiden/Louvain clusters):`,
      ...commLines,
    ];

    return lines.join("\n");
  } catch {
    // Graph data corrupt or incomplete — don't crash session startup
    return null;
  }
}

/**
 * Format per-repo topology blocks for workspace mode.
 *
 * Produces one `### [repoId] topology` block per repo that has a graph.
 * Repos without a graph are silently skipped (common when graphify hasn't
 * been run yet or the repo has no code files).
 *
 * Returns null if no repo has a graph — caller drops the whole section.
 */
export function formatGraphContextMulti(
  repoGraphs: Array<{ id: string; tools: ReturnType<typeof buildGraphifyTools> }>,
): string | null {
  const blocks: string[] = [];
  for (const { id, tools } of repoGraphs) {
    if (!tools) continue;
    try {
      const god = tools.graphifyGodNodes();
      const comm = tools.graphifyListCommunities();
      const godLines = god.godNodes.slice(0, 5).map(
        (n) => `  • ${n.name} (degree ${n.degree}) — ${n.sourceFile || "(unknown)"}`,
      );
      const commLines = comm.communities.slice(0, 5).map((c) => {
        const preview = c.nodes.slice(0, 3).join(", ");
        const more = c.nodes.length > 3 ? ` … +${c.nodes.length - 3} more` : "";
        return `  • Community #${c.id} (${c.size} nodes): ${preview}${more}`;
      });
      blocks.push(
        [
          `### [${id}] topology`,
          `Graph: ${god.totalNodes} nodes, ${god.totalEdges} edges, ${god.communities} communities`,
          "",
          `Top hub nodes (highest connectivity):`,
          ...godLines,
          "",
          `Subsystem communities (Leiden/Louvain clusters):`,
          ...commLines,
        ].join("\n"),
      );
    } catch {
      // Skip corrupt/incomplete graph for this repo
    }
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

