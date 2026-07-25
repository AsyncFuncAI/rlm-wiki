import { buildWorkspaceQuery, listGoals } from "../prompts/workspace-meta.js";

export interface SourceSpec {
  id?: string;
  source: string;
  branch?: string;
  label?: string;
}

export interface ParsedArgs {
  mode: string;
  provider: string;
  model: string | null;
  subModel: string | null;
  subProvider: string | null;
  subBaseURL: string | null;
  baseURL: string | null;
  maxIter: number;
  maxLLM: number;
  branch: string | null;
  sandboxTimeout: number;
  githubToken: string | null;
  interactive: boolean;
  promptMode: boolean;
  verbose: boolean;
  optimizer: boolean;
  jsonOutput: boolean;
  goal: string | null;
  sessionDir: string | null;
  resumeSessionId: string | null;
  source: string | null;
  query: string;
  sources: Array<string | SourceSpec> | undefined;
  displaySource: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: string[] = argv.slice(2);

  function getFlag(name: string, defaultVal: string | null): string | null {
    const idx = args.indexOf(name);
    if (idx === -1) return defaultVal;
    const val = args[idx + 1];
    args.splice(idx, 2);
    return val;
  }

  function hasFlag(name: string): boolean {
    const idx = args.indexOf(name);
    if (idx === -1) return false;
    args.splice(idx, 1);
    return true;
  }

  const mode = getFlag("--mode", "auto")!;
  const provider = getFlag("--provider", "anthropic")!;
  const model = getFlag("--model", null);
  const subModel = getFlag("--sub-model", null);
  const subProvider = getFlag("--sub-provider", null);
  const subBaseURL = getFlag("--sub-base-url", null);
  const baseURL = getFlag("--base-url", null);
  const maxIter = parseInt(getFlag("--max-iter", "20")!);
  const maxLLM = parseInt(getFlag("--max-llm", "5000")!);
  const branch = getFlag("--branch", null);
  const sandboxTimeout = parseInt(getFlag("--sandbox-timeout", "1800000")!);
  const githubToken = getFlag("--github-token", null);
  let interactive = hasFlag("--interactive") || hasFlag("-i");
  let promptMode = hasFlag("--prompt") || hasFlag("-p");
  const verbose = hasFlag("--verbose");
  const optimizer = hasFlag("--optimizer");
  const jsonOutput = hasFlag("--json");
  const goal = getFlag("--goal", null);
  const sessionDir = getFlag("--session-dir", null);
  const resumeSessionId = getFlag("--resume-session", null);

  // Parse --sources (workspace mode)
  let workspaceSources: Array<string | SourceSpec> | null = null;
  {
    const sourcesIdx = args.indexOf("--sources");
    if (sourcesIdx !== -1) {
      args.splice(sourcesIdx, 1);
      const specs: Array<string | SourceSpec> = [];
      const looksLikeSource = (s: string): boolean =>
        s.includes("=") || s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || s.startsWith("http");
      while (args.length > sourcesIdx && args[sourcesIdx] && !args[sourcesIdx].startsWith("--") && looksLikeSource(args[sourcesIdx])) {
        const spec = args[sourcesIdx];
        args.splice(sourcesIdx, 1);
        const eqIdx = spec.indexOf("=");
        if (eqIdx > 0) {
          specs.push({ id: spec.slice(0, eqIdx), source: spec.slice(eqIdx + 1) });
        } else {
          specs.push(spec);
        }
      }
      if (specs.length > 0) workspaceSources = specs;
    }
  }

  if (!["auto", "repo", "file", "workspace", "pr", "rlm"].includes(mode)) {
    console.error(`Error: Invalid mode "${mode}". Must be auto, repo, file, workspace, pr, or rlm.`);
    process.exit(1);
  }

  // Resolve sources + goal → query
  let source: string | null;
  let query: string;
  let sources: Array<string | SourceSpec> | undefined;

  if (workspaceSources) {
    sources = workspaceSources;
    const repoIds = sources.map((s) =>
      typeof s === "string" ? s.split("/").pop()!.replace(/\.git$/, "") : s.id!
    );

    const userQuery = args.join(" ").trim() || null;

    if (goal) {
      query = buildWorkspaceQuery(goal, repoIds, userQuery ?? undefined);
    } else if (userQuery) {
      query = userQuery;
    } else {
      console.error("Error: Workspace mode requires --goal <goal> or a query.");
      console.error("Available goals: " + listGoals().map((g: { id: string }) => g.id).join(", "));
      process.exit(1);
    }

    source = null;
  } else if (promptMode) {
    source = null;
    query = args.join(" ").trim();
    if (!query) {
      interactive = true;
    }
  } else {
    source = args[0];
    query = args.slice(1).join(" ");

    if (!source || !query) {
      console.error("Error: Both <source> and <query> are required.");
      console.error('Usage: rlm <source> "your question here"');
      console.error('  or:  rlm --sources id=url id=url --goal compare');
      console.error('  or:  rlm --prompt "your question here"');
      process.exit(1);
    }
  }

  const displaySource: string = source || (sources ? sources.map((s) => typeof s === "string" ? s : `${s.id}=${s.source}`).join(", ") : "prompt");

  return {
    mode, provider, model, subModel, subProvider, subBaseURL, baseURL,
    maxIter, maxLLM, branch, sandboxTimeout, githubToken,
    interactive, promptMode, verbose, optimizer, jsonOutput,
    goal, sessionDir, resumeSessionId,
    source, query, sources, displaySource,
  };
}
