/**
 * Graphify knowledge graph integration for the RLM sandbox.
 *
 * Provides `graphifyQuery` as a tool that queries the pre-built knowledge graph
 * BEFORE falling back to raw file reads. This crowns readFile/glob/rg by
 * giving the agent a compressed, structured view of the codebase first.
 *
 * The graph lives at `graphify-out/graph.json` in the project root and is
 * auto-generated on first use via the AST pipeline (~0.2s for a typical repo).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { execFileSync, execSync } from "child_process";

export interface GraphifyQueryResult {
  traversal: string;
  startNodes: string[];
  subgraphNodes: { name: string; label: string; sourceFile: string; sourceLocation: string }[];
  subgraphEdges: { from: string; to: string; relation: string; confidence: string }[];
  nodeCount: number;
  edgeCount: number;
  hasGraph?: boolean;
  error?: string;
}

export interface GraphifyExplainResult {
  node: string;
  sourceFile: string;
  fileType: string;
  degree: number;
  connections: { relation: string; target: string; confidence: string; sourceFile: string }[];
}

export interface GraphifyGodNodesResult {
  godNodes: { name: string; label: string; degree: number; sourceFile: string }[];
  totalNodes: number;
  totalEdges: number;
  communities: number;
}

export interface GraphifyCommunitiesResult {
  communities: { id: number; size: number; nodes: string[] }[];
  totalCommunities: number;
}

export interface GraphifyGetCommunityResult {
  id: number;
  nodes: { name: string; sourceFile: string; fileType: string; degree: number }[];
}

interface GraphNode {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
  file_type?: string;
  community?: number;
}

interface GraphEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphEdge[];
}

// ── Auto-generation pipeline ────────────────────────────────────────

// Compact Python pipeline: detect → extract → build → cluster → export
const GRAPHIFY_PIPELINE = [
  "import sys, os",
  "repo = sys.argv[1]",
  "from graphify.detect import detect",
  "from graphify.extract import extract",
  "from graphify.build import build_from_json",
  "from graphify.cluster import cluster",
  "from graphify.export import to_json",
  "from pathlib import Path",
  "result = detect(Path(repo))",
  "code_files = [Path(f) for f in result['files']['code']]",
  "if not code_files:",
  "    print('NO_FILES'); sys.exit(0)",
  "extraction = extract(code_files)",
  "G = build_from_json(extraction)",
  "communities = cluster(G)",
  "outdir = os.path.join(repo, 'graphify-out')",
  "os.makedirs(outdir, exist_ok=True)",
  "to_json(G, communities, os.path.join(outdir, 'graph.json'))",
  "print(f'OK:{G.number_of_nodes()}:{G.number_of_edges()}:{len(communities)}')",
].join("\n");

const GRAPHIFY_SKIP_FILE = ".graphify-skip.json";
const DEFAULT_TOKEI_MAX_CODE_LINES = 150_000;
const DEFAULT_TOKEI_MAX_FILES = 5_000;
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function graphifyOutDir(repoPath: string): string {
  return resolve(repoPath, "graphify-out");
}

function graphifySkipMarker(repoPath: string): string {
  return resolve(graphifyOutDir(repoPath), GRAPHIFY_SKIP_FILE);
}

function writeGraphifySkipMarker(repoPath: string, reason: string): void {
  try {
    mkdirSync(graphifyOutDir(repoPath), { recursive: true });
    writeFileSync(
      graphifySkipMarker(repoPath),
      JSON.stringify({ reason, createdAt: Date.now() }, null, 2),
    );
  } catch {
    // Best-effort only. A failed skip marker should not break sandbox tools.
  }
}

function activeGraphifySkipReason(repoPath: string): string | null {
  const marker = graphifySkipMarker(repoPath);
  if (!existsSync(marker)) return null;
  const ttlMs = envPositiveInt("RLM_GRAPHIFY_FAILURE_TTL_MS", 6 * 60 * 60 * 1000);
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf-8")) as { reason?: unknown; createdAt?: unknown };
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
    if (Date.now() - createdAt <= ttlMs) {
      return typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "previous graphify attempt failed";
    }
    try { unlinkSync(marker); } catch { }
    return null;
  } catch {
    try { unlinkSync(marker); } catch { }
    return null;
  }
}

function trackedFiles(repoPath: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function extensionOf(file: string): string {
  const base = file.toLowerCase();
  const index = base.lastIndexOf(".");
  return index >= 0 ? base.slice(index) : "";
}

function isCodeLike(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (/(^|\/)(dist|build|coverage|node_modules|vendor|graphify-out|\.git)\//.test(normalized)) return false;
  return CODE_EXTENSIONS.has(extensionOf(normalized));
}

interface TokeiNode {
  code?: unknown;
  reports?: unknown;
  children?: unknown;
}

interface TokeiMetrics {
  codeLines: number;
  files: number;
}

function countTokeiReports(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const row = node as TokeiNode;
  let count = Array.isArray(row.reports) ? row.reports.length : 0;
  if (row.children && typeof row.children === "object") {
    for (const child of Object.values(row.children as Record<string, unknown>)) {
      count += countTokeiReports(child);
    }
  }
  return count;
}

function runTokei(repoPath: string): TokeiMetrics | null {
  if (!envBool("RLM_GRAPHIFY_TOKEI_PRECHECK", true)) return null;
  try {
    const output = execFileSync("tokei", ["--output", "json", repoPath], {
      encoding: "utf-8",
      timeout: envPositiveInt("RLM_GRAPHIFY_TOKEI_TIMEOUT_MS", 20_000),
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(output) as Record<string, TokeiNode>;
    const total = parsed.Total;
    if (!total || typeof total !== "object") return null;
    const codeLines = typeof total.code === "number" ? total.code : 0;
    let files = countTokeiReports(total);
    if (!files) {
      files = Object.entries(parsed)
        .filter(([language]) => language !== "Total")
        .reduce((sum, [, node]) => sum + countTokeiReports(node), 0);
    }
    return { codeLines, files };
  } catch (err: any) {
    const message = err?.code === "ENOENT"
      ? "tokei not found"
      : err?.message?.slice(0, 160) || String(err).slice(0, 160);
    console.error(`[graphify] tokei precheck unavailable for ${repoPath}: ${message}`);
    return null;
  }
}

function tokeiSkipReason(repoPath: string): string | null {
  const metrics = runTokei(repoPath);
  if (!metrics) return null;

  const maxLines = envPositiveInt("RLM_GRAPHIFY_TOKEI_MAX_CODE_LINES", DEFAULT_TOKEI_MAX_CODE_LINES);
  if (metrics.codeLines > maxLines) {
    return `tokei counted ${metrics.codeLines} code lines (limit ${maxLines})`;
  }

  const maxFiles = envPositiveInt("RLM_GRAPHIFY_TOKEI_MAX_FILES", DEFAULT_TOKEI_MAX_FILES);
  if (metrics.files > maxFiles) {
    return `tokei counted ${metrics.files} source files (limit ${maxFiles})`;
  }

  return null;
}

function graphifyPreflightSkipReason(repoPath: string): string | null {
  if (!envBool("RLM_GRAPHIFY_AUTO_GENERATE", true) || !envBool("RLM_GRAPHIFY_ENABLED", true)) {
    return "auto-generation disabled by environment";
  }
  const previous = activeGraphifySkipReason(repoPath);
  if (previous) return `recent skip marker: ${previous}`;

  const tokeiReason = tokeiSkipReason(repoPath);
  if (tokeiReason) return tokeiReason;

  const files = trackedFiles(repoPath);
  if (!files) return null;

  const maxTracked = envPositiveInt("RLM_GRAPHIFY_MAX_TRACKED_FILES", 15_000);
  if (files.length > maxTracked) {
    return `repo has ${files.length} tracked files (limit ${maxTracked})`;
  }

  const codeFiles = files.filter(isCodeLike).length;
  const maxCode = envPositiveInt("RLM_GRAPHIFY_MAX_CODE_FILES", 5_000);
  if (codeFiles > maxCode) {
    return `repo has ${codeFiles} code-like files (limit ${maxCode})`;
  }

  return null;
}

function pythonCanImportGraphify(python: string): boolean {
  try {
    execFileSync(python, ["-c", "import graphify"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function ensureLocalGraphifyPython(): string | null {
  const venvDir = resolve(process.cwd(), ".graphify-venv");
  const python = resolve(venvDir, "bin", "python3");

  try {
    if (!existsSync(python)) {
      console.error(`[graphify] Creating local Python environment at ${venvDir}`);
      execFileSync("python3", ["-m", "venv", venvDir], { stdio: "pipe", timeout: 120000 });
    }

    if (!pythonCanImportGraphify(python)) {
      console.error("[graphify] Installing graphifyy into local Python environment...");
      execFileSync(python, ["-m", "pip", "install", "--quiet", "graphifyy"], {
        stdio: "pipe",
        timeout: 300000,
      });
    }

    return pythonCanImportGraphify(python) ? python : null;
  } catch (err: any) {
    console.error(`[graphify] Could not prepare local graphify environment: ${err.message?.slice(0, 200)}`);
    return null;
  }
}

/**
 * Find or prepare a Python executable that has graphify installed.
 * Searches env overrides, repoPath/.graphify-venv, cwd/.graphify-venv, parent dirs,
 * system PATH, then creates cwd/.graphify-venv and installs the graphifyy package.
 */
function findGraphifyPython(repoPath: string): string | null {
  const candidates = [
    process.env.RLM_GRAPHIFY_PYTHON,
    process.env.GRAPHIFY_PYTHON,
    resolve(repoPath, ".graphify-venv", "bin", "python3"),
    resolve(process.cwd(), ".graphify-venv", "bin", "python3"),
  ].filter(Boolean) as string[];

  // Walk up from cwd looking for a .graphify-venv
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    candidates.push(resolve(parent, ".graphify-venv", "bin", "python3"));
    dir = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && pythonCanImportGraphify(candidate)) return candidate;
  }

  // Try system graphify (pip install --user)
  if (pythonCanImportGraphify("python3")) return "python3";

  return ensureLocalGraphifyPython();
}

/**
 * Auto-generate a graphify knowledge graph for a repo if one doesn't exist.
 * Returns true if graph was generated or already exists, false on failure.
 */
function ensureGraphifyGraph(repoPath: string): boolean {
  const graphPath = resolve(repoPath, "graphify-out", "graph.json");
  const skipReason = graphifyPreflightSkipReason(repoPath);
  if (skipReason) {
    console.error(`[graphify] Skipping graphify tools for ${repoPath}: ${skipReason}`);
    if (!skipReason.startsWith("auto-generation disabled") && !skipReason.startsWith("recent skip marker:")) {
      writeGraphifySkipMarker(repoPath, skipReason);
    }
    return false;
  }

  if (existsSync(graphPath)) return true;

  const python = findGraphifyPython(repoPath);
  if (!python) {
    console.error(`[graphify] No graphify Python found — skipping graph generation for ${repoPath}`);
    writeGraphifySkipMarker(repoPath, "no graphify Python available");
    return false;
  }

  const tmpScript = join(repoPath, ".graphify_gen_tmp.py");
  try {
    console.error(`[graphify] Auto-generating knowledge graph for ${repoPath}...`);
    writeFileSync(tmpScript, GRAPHIFY_PIPELINE);
    const timeoutMs = envPositiveInt("RLM_GRAPHIFY_TIMEOUT_MS", 120_000);
    const result = execSync(
      `"${python}" "${tmpScript}" "${repoPath}"`,
      { timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const line = (result || "").trim().split("\n").pop() || "";
    if (line.startsWith("OK:")) {
      const [, nodes, edges, communities] = line.split(":");
      console.error(`[graphify] ✓ Generated: ${nodes} nodes, ${edges} edges, ${communities} communities`);
      return true;
    } else if (line === "NO_FILES") {
      console.error(`[graphify] No code files found in ${repoPath} — skipping`);
      writeGraphifySkipMarker(repoPath, "no code files found");
      return false;
    }
    console.error(`[graphify] Unexpected output: ${line}`);
    writeGraphifySkipMarker(repoPath, `unexpected graphify output: ${line.slice(0, 120)}`);
    return false;
  } catch (err: any) {
    const message = err.message?.slice(0, 200) || String(err).slice(0, 200);
    console.error(`[graphify] Failed to generate graph: ${message}`);
    writeGraphifySkipMarker(repoPath, `generation failed: ${message}`);
    return false;
  } finally {
    try { unlinkSync(tmpScript); } catch {}
  }
}

// ── Tool builder ────────────────────────────────────────────────────

/**
 * Build graphify tools for a given repo path.
 * Auto-generates the knowledge graph if it doesn't exist (~0.2s).
 * Returns null only if generation fails (no graphify installed, no code files, etc).
 */
export function buildGraphifyTools(repoPath: string) {
  const graphPath = resolve(repoPath, "graphify-out", "graph.json");

  // Always run preflight, even when a graph cache already exists. Large repos
  // must not receive graphify tools through stale graphify-out/graph.json.
  if (!ensureGraphifyGraph(repoPath)) {
    return null;
  }

  // Load graph once — it's persistent across sandbox invocations
  let graphData: GraphData;
  try {
    graphData = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch {
    return null;
  }

  // Build adjacency index
  const nodesById = new Map<string, GraphNode>();
  for (const node of graphData.nodes) {
    nodesById.set(node.id, node);
  }

  const adjacency = new Map<string, { neighbor: string; edge: GraphEdge }[]>();
  for (const edge of graphData.links) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push({ neighbor: edge.target, edge });
    adjacency.get(edge.target)!.push({ neighbor: edge.source, edge });
  }

  function findMatchingNodes(terms: string[], maxNodes = 3): string[] {
    const scored: [number, string][] = [];
    for (const [nid, ndata] of nodesById) {
      const label = (ndata.label || "").toLowerCase();
      const score = terms.reduce((s, t) => s + (label.includes(t) ? 1 : 0), 0);
      if (score > 0) scored.push([score, nid]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, maxNodes).map(([, nid]) => nid);
  }

  function bfsTraversal(startNodes: string[], depth = 3): { nodes: Set<string>; edges: [string, string][] } {
    const visited = new Set(startNodes);
    const edges: [string, string][] = [];
    let frontier = new Set(startNodes);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = new Set<string>();
      for (const n of frontier) {
        for (const { neighbor } of adjacency.get(n) || []) {
          if (!visited.has(neighbor)) {
            nextFrontier.add(neighbor);
            edges.push([n, neighbor]);
          }
        }
      }
      for (const n of nextFrontier) visited.add(n);
      frontier = nextFrontier;
    }
    return { nodes: visited, edges };
  }

  return {
    /**
     * Query the knowledge graph with a natural language question.
     * Returns a compressed subgraph relevant to the question.
     * Use this BEFORE readFile/glob/rg for understanding codebase structure.
     */
    graphifyQuery(question: string, opts?: { mode?: "bfs" | "dfs"; budget?: number }): GraphifyQueryResult {
      const mode = opts?.mode || "bfs";
      const budget = Math.max(opts?.budget || 2000, 500); // minimum 500 tokens

      const terms = question.toLowerCase().split(/\s+/).filter(t => t.length > 3);
      const startNodes = findMatchingNodes(terms);

      if (startNodes.length === 0) {
        return {
          traversal: mode.toUpperCase(),
          startNodes: [],
          subgraphNodes: [],
          subgraphEdges: [],
          nodeCount: 0,
          edgeCount: 0,
        };
      }

      const { nodes: subNodes, edges: subEdges } = bfsTraversal(startNodes);

      // Rank by relevance
      const ranked = [...subNodes].sort((a, b) => {
        const aLabel = (nodesById.get(a)?.label || "").toLowerCase();
        const bLabel = (nodesById.get(b)?.label || "").toLowerCase();
        const aScore = terms.reduce((s, t) => s + (aLabel.includes(t) ? 1 : 0), 0);
        const bScore = terms.reduce((s, t) => s + (bLabel.includes(t) ? 1 : 0), 0);
        return bScore - aScore;
      });

      // Budget-aware trimming (~4 chars/token)
      const charBudget = budget * 4;
      const resultNodes: GraphifyQueryResult["subgraphNodes"] = [];
      const resultEdges: GraphifyQueryResult["subgraphEdges"] = [];
      let charCount = 0;

      for (const nid of ranked) {
        const n = nodesById.get(nid)!;
        const entry = {
          name: n.label || nid,
          label: n.label || nid,
          sourceFile: n.source_file || "",
          sourceLocation: n.source_location || "",
        };
        const entryChars = JSON.stringify(entry).length;
        if (charCount + entryChars > charBudget) break;
        resultNodes.push(entry);
        charCount += entryChars;
      }

      const nodeSet = new Set(resultNodes.map(n => n.label));
      for (const [u, v] of subEdges) {
        const uLabel = nodesById.get(u)?.label || u;
        const vLabel = nodesById.get(v)?.label || v;
        // Find the edge data
        const edgeData = graphData.links.find(
          e => (e.source === u && e.target === v) || (e.source === v && e.target === u)
        );
        resultEdges.push({
          from: uLabel,
          to: vLabel,
          relation: edgeData?.relation || "related_to",
          confidence: edgeData?.confidence || "EXTRACTED",
        });
      }

      return {
        traversal: mode.toUpperCase(),
        startNodes: startNodes.map(n => nodesById.get(n)?.label || n),
        subgraphNodes: resultNodes,
        subgraphEdges: resultEdges,
        nodeCount: resultNodes.length,
        edgeCount: resultEdges.length,
      };
    },

    /**
     * Explain a specific node — what it is, what it connects to.
     */
    graphifyExplain(nodeName: string): GraphifyExplainResult | null {
      const terms = nodeName.toLowerCase().split(/\s+/);
      const matches = findMatchingNodes(terms, 1);
      if (matches.length === 0) return null;

      const nid = matches[0];
      const node = nodesById.get(nid)!;
      const neighbors = adjacency.get(nid) || [];

      return {
        node: node.label || nid,
        sourceFile: node.source_file || "",
        fileType: node.file_type || "code",
        degree: neighbors.length,
        connections: neighbors.map(({ neighbor, edge }) => ({
          relation: edge.relation || "related_to",
          target: nodesById.get(neighbor)?.label || neighbor,
          confidence: edge.confidence || "EXTRACTED",
          sourceFile: nodesById.get(neighbor)?.source_file || "",
        })),
      };
    },

    /**
     * Get the god nodes — highest-degree concepts everything connects through.
     * Use this as the first call to orient in a new codebase.
     */
    graphifyGodNodes(): GraphifyGodNodesResult {
      const degrees: [string, number][] = [];
      for (const [nid] of nodesById) {
        degrees.push([nid, (adjacency.get(nid) || []).length]);
      }
      degrees.sort((a, b) => b[1] - a[1]);

      const communitySet = new Set<number>();
      for (const node of graphData.nodes) {
        if (node.community !== undefined) communitySet.add(node.community);
      }

      return {
        godNodes: degrees.slice(0, 10).map(([nid, deg]) => ({
          name: nodesById.get(nid)?.label || nid,
          label: nodesById.get(nid)?.label || nid,
          degree: deg,
          sourceFile: nodesById.get(nid)?.source_file || "",
        })),
        totalNodes: nodesById.size,
        totalEdges: graphData.links.length,
        communities: communitySet.size,
      };
    },

    /**
     * Find the shortest path between two concepts in the graph.
     */
    graphifyPath(nodeA: string, nodeB: string): string[] | null {
      const aTerms = nodeA.toLowerCase().split(/\s+/);
      const bTerms = nodeB.toLowerCase().split(/\s+/);
      const aMatch = findMatchingNodes(aTerms, 1)[0];
      const bMatch = findMatchingNodes(bTerms, 1)[0];

      if (!aMatch || !bMatch) return null;

      // BFS shortest path
      const visited = new Set<string>([aMatch]);
      const parent = new Map<string, string>();
      const queue = [aMatch];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === bMatch) {
          // Reconstruct path
          const path: string[] = [];
          let c: string | undefined = bMatch;
          while (c) {
            path.unshift(nodesById.get(c)?.label || c);
            c = parent.get(c);
          }
          return path;
        }
        for (const { neighbor } of adjacency.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            parent.set(neighbor, current);
            queue.push(neighbor);
          }
        }
      }
      return null;
    },
    /**
     * List all community clusters detected in the graph (Leiden/Louvain).
     * Communities represent natural subsystems or modules. Use this to discover
     * the codebase's high-level structure before drilling into specific areas.
     */
    graphifyListCommunities(): GraphifyCommunitiesResult {
      const communityMap = new Map<number, string[]>();
      for (const node of graphData.nodes) {
        if (node.community !== undefined) {
          const cid = node.community;
          if (!communityMap.has(cid)) communityMap.set(cid, []);
          communityMap.get(cid)!.push(nodesById.get(node.id)?.label || node.id);
        }
      }
      // Sort each community's nodes alphabetically
      for (const [, nodes] of communityMap) nodes.sort();
      // Sort communities by size descending
      const communities = [...communityMap.entries()]
        .map(([id, nodes]) => ({ id, size: nodes.length, nodes }))
        .sort((a, b) => b.size - a.size);
      return { communities, totalCommunities: communities.length };
    },

    /**
     * Get all nodes in a specific community cluster by ID.
     * Use graphifyListCommunities() first to find community IDs.
     * Returns null if the community ID doesn't exist.
     */
    graphifyGetCommunity(communityId: number): GraphifyGetCommunityResult | null {
      const members: { name: string; sourceFile: string; fileType: string; degree: number }[] = [];
      for (const node of graphData.nodes) {
        if (node.community === communityId) {
          const neighbors = adjacency.get(node.id) || [];
          members.push({
            name: node.label || node.id,
            sourceFile: node.source_file || "",
            fileType: node.file_type || "code",
            degree: neighbors.length,
          });
        }
      }
      if (members.length === 0) return null;
      members.sort((a, b) => b.degree - a.degree);
      return { id: communityId, nodes: members };
    },

  };
}

// ── Workspace-aware graphify tools ──────────────────────────────────
// Namespaced variants that route every call to a specific repo's graph.
// The first argument is always `repoId` so the LLM must declare which
// codebase it's asking about — this preserves provenance in workspace mode.

export type GraphifyToolsSingle = NonNullable<ReturnType<typeof buildGraphifyTools>>;

export interface WorkspaceGraphifyTools {
  graphifyQuery: (repoId: string, question: string, opts?: { mode?: "bfs" | "dfs"; budget?: number }) => GraphifyQueryResult;
  graphifyExplain: (repoId: string, nodeName: string) => GraphifyExplainResult | null;
  graphifyPath: (repoId: string, nodeA: string, nodeB: string) => string[] | null;
  graphifyListCommunities: (repoId: string) => GraphifyCommunitiesResult;
  graphifyGetCommunity: (repoId: string, communityId: number) => GraphifyGetCommunityResult | null;
  graphifyGodNodes: (repoId: string) => GraphifyGodNodesResult;
  graphifyListRepos: () => { id: string; hasGraph: boolean }[];
}

/**
 * Build workspace-scoped graphify tools for multiple repos.
 *
 * Each repo's graph is loaded independently (or skipped if its graph can't
 * be built). The returned tools take `repoId` as the first argument and
 * route to the appropriate repo's single-repo tools.
 *
 * Returns the tools and a map of per-repo single-repo tools (so callers
 * can also build per-repo topology summaries for the system prompt).
 */
export function buildGraphifyToolsMulti(
  repos: { id: string; repoPath: string }[],
): { tools: WorkspaceGraphifyTools | null; perRepo: Record<string, GraphifyToolsSingle | null> } {
  const perRepo: Record<string, GraphifyToolsSingle | null> = {};
  for (const r of repos) {
    perRepo[r.id] = buildGraphifyTools(r.repoPath);
  }

  const availableRepos = () =>
    Object.entries(perRepo).filter(([, t]) => t !== null).map(([id]) => id);

  if (availableRepos().length === 0) {
    return { tools: null, perRepo };
  }

  function unavailableMessage(repoId: string): string {
    const known = Object.keys(perRepo);
    const avail = availableRepos();
    if (!known.includes(repoId)) {
      return `graphify: unknown repoId "${repoId}". Available repos: ${known.length ? known.join(", ") : "(none)"}.`;
    }
    return (
      `graphify: no graph available for repoId "${repoId}". ` +
      `Repos with graphs: ${avail.length ? avail.join(", ") : "(none)"}. ` +
      `Use rg/searchAll/listFiles/readFile as a fallback.`
    );
  }

  function emptyQueryResult(repoId: string, error = unavailableMessage(repoId)): GraphifyQueryResult {
    return {
      traversal: "UNAVAILABLE",
      startNodes: [],
      subgraphNodes: [],
      subgraphEdges: [],
      nodeCount: 0,
      edgeCount: 0,
      hasGraph: false,
      error,
    };
  }

  function pick(repoId: string): GraphifyToolsSingle | null {
    const t = perRepo[repoId];
    return t || null;
  }

  function prefixSourceFile(repoId: string, sourceFile: string): string {
    if (!sourceFile) return sourceFile;
    if (sourceFile.includes(":")) return sourceFile;
    if (sourceFile.startsWith("/") || /^[A-Za-z]:[\\/]/.test(sourceFile)) return sourceFile;
    return `${repoId}:${sourceFile}`;
  }

  function prefixQueryResult(repoId: string, result: GraphifyQueryResult): GraphifyQueryResult {
    return {
      ...result,
      subgraphNodes: (result.subgraphNodes || []).map((node) => ({
        ...node,
        sourceFile: prefixSourceFile(repoId, node.sourceFile),
      })),
    };
  }

  function prefixExplainResult(repoId: string, result: GraphifyExplainResult | null): GraphifyExplainResult | null {
    if (!result) return result;
    return {
      ...result,
      sourceFile: prefixSourceFile(repoId, result.sourceFile),
      connections: (result.connections || []).map((conn) => ({
        ...conn,
        sourceFile: prefixSourceFile(repoId, conn.sourceFile),
      })),
    };
  }

  function prefixGodNodes(repoId: string, result: GraphifyGodNodesResult): GraphifyGodNodesResult {
    return {
      ...result,
      godNodes: (result.godNodes || []).map((node) => ({
        ...node,
        sourceFile: prefixSourceFile(repoId, node.sourceFile),
      })),
    };
  }

  function prefixCommunity(repoId: string, result: GraphifyGetCommunityResult | null): GraphifyGetCommunityResult | null {
    if (!result) return result;
    return {
      ...result,
      nodes: (result.nodes || []).map((node) => ({
        ...node,
        sourceFile: prefixSourceFile(repoId, node.sourceFile),
      })),
    };
  }

  const tools: WorkspaceGraphifyTools = {
    graphifyQuery: (repoId, question, opts) => {
      const t = pick(repoId);
      if (!t) return emptyQueryResult(repoId);
      try {
        return prefixQueryResult(repoId, t.graphifyQuery(question, opts));
      } catch (err) {
        return emptyQueryResult(repoId, `graphifyQuery failed for repoId "${repoId}": ${(err as Error).message}`);
      }
    },
    graphifyExplain: (repoId, nodeName) => {
      const t = pick(repoId);
      if (!t) return null;
      try { return prefixExplainResult(repoId, t.graphifyExplain(nodeName)); } catch { return null; }
    },
    graphifyPath: (repoId, a, b) => {
      const t = pick(repoId);
      if (!t) return null;
      try { return t.graphifyPath(a, b); } catch { return null; }
    },
    graphifyListCommunities: (repoId) => {
      const t = pick(repoId);
      if (!t) return { communities: [], totalCommunities: 0 };
      try { return t.graphifyListCommunities(); } catch { return { communities: [], totalCommunities: 0 }; }
    },
    graphifyGetCommunity: (repoId, cid) => {
      const t = pick(repoId);
      if (!t) return null;
      try { return prefixCommunity(repoId, t.graphifyGetCommunity(cid)); } catch { return null; }
    },
    graphifyGodNodes: (repoId) => {
      const t = pick(repoId);
      if (!t) return { godNodes: [], totalNodes: 0, totalEdges: 0, communities: 0 };
      try { return prefixGodNodes(repoId, t.graphifyGodNodes()); } catch { return { godNodes: [], totalNodes: 0, totalEdges: 0, communities: 0 }; }
    },
    graphifyListRepos: () => Object.entries(perRepo).map(([id, t]) => ({ id, hasGraph: t !== null })),
  };

  return { tools, perRepo };
}
