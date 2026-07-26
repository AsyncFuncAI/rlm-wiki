import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { askRepo, askWorkspace, type AskMode, type WorkspaceGoal } from "./chat.ts";
import { generateWiki, resolveWikiConcurrency } from "./generator.ts";
import { DEFAULT_CHANNEL_ID, resolveChannel } from "./llm.ts";
import {
  LOCAL_CLI_AGENT_IDS,
  localCliLabel,
  normalizeLocalCliConfig,
  type LocalCliAgentId,
  type LocalCliConfig,
} from "./local-cli-events.ts";
import { getLocalCliAgents } from "./local-cli-sidecar-client.ts";
import { startLocalCliSidecar } from "./local-cli-sidecar.ts";
import { startWorker } from "./run-worker.ts";
import { startServer } from "./server.ts";
import { WikiStore } from "./storage.ts";
import {
  createProductStore,
  wikiRecordArtifactKey,
  type ProductRun,
  type ProductStore,
} from "./persistence.ts";
import {
  assignWorkspaceRepoIds,
  parseGithubUrl,
  wikiRefForWorkspace,
  type RepoRef,
  type WikiRecord,
  type WorkspaceRepoRef,
} from "./types.ts";
import {
  WIKI_LANGUAGES,
  WIKI_STYLES,
  defaultWikiPageCountForDepth,
  normalizeWikiLanguages,
  normalizeWikiPageCount,
  normalizeWikiPageCountMode,
  normalizeWikiStyle,
  normalizeWikiStylePrompt,
  type WikiLanguage,
  type WikiPageCountMode,
  type WikiStyle,
} from "./wiki-options.ts";

type FlagValue = string | boolean | string[];

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, FlagValue>;
}

export interface CliIO {
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

export interface CliDeps {
  createStore: () => WikiStore;
  createProductStore?: typeof createProductStore;
  generateWiki: typeof generateWiki;
  askRepo: typeof askRepo;
  askWorkspace: typeof askWorkspace;
  getLocalCliAgents: typeof getLocalCliAgents;
  startServer: typeof startServer;
  startWorker: typeof startWorker;
  startLocalCliSidecar: typeof startLocalCliSidecar;
}

const WORKSPACE_GOALS = new Set<WorkspaceGoal>(["compare", "steal", "understand", "bridge", "audit"]);
const ASK_MODES = new Set<AskMode>(["fast", "deep"]);
const CLI_DEFAULT_WIKI_PAGE_COUNT = 6;
const CLI_DEFAULT_WIKI_STYLE = "first-30";

interface LocalCliSelection {
  localCli: LocalCliConfig;
  explicitAgent: boolean;
}

const defaultDeps: CliDeps = {
  createStore: () => new WikiStore(),
  createProductStore,
  generateWiki,
  askRepo,
  askWorkspace,
  getLocalCliAgents,
  startServer,
  startWorker,
  startLocalCliSidecar,
};

const defaultIO: CliIO = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawKey = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value = eq >= 0
      ? arg.slice(eq + 1)
      : next && !next.startsWith("--")
      ? (i++, next)
      : true;
    addFlag(flags, key, value);
  }
  return { positional, flags };
}

function addFlag(flags: Record<string, FlagValue>, key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[key] = [String(existing), String(value)];
  }
}

function print(io: CliIO, text = ""): void {
  io.stdout.write(`${text}\n`);
}

function error(io: CliIO, text = ""): void {
  io.stderr.write(`${text}\n`);
}

function flagString(flags: Record<string, FlagValue>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name];
    if (Array.isArray(value)) {
      const last = value.at(-1);
      if (last) return last;
    } else if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function flagStrings(flags: Record<string, FlagValue>, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = flags[name];
    if (Array.isArray(value)) out.push(...value);
    else if (typeof value === "string") out.push(value);
  }
  return out.map((value) => value.trim()).filter(Boolean);
}

function flagBool(flags: Record<string, FlagValue>, ...names: string[]): boolean {
  return names.some((name) => flags[name] === true || flags[name] === "true" || flags[name] === "1");
}

function flagNumber(flags: Record<string, FlagValue>, name: string): number | undefined {
  const value = flagString(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function printUsage(io: CliIO): void {
  print(io, `grok-wiki — local CLI repository wikis and Ask

Usage:
  grok-wiki generate <source...> [--agent ID] [--model MODEL] [--reasoning LEVEL] [--pages N] [--page-count-mode auto|fixed] [--style STYLE] [--language LANG] [--concurrency N]
  grok-wiki ask      <source> "question" [--agent ID] [--model MODEL] [--reasoning LEVEL] [--mode fast|deep]
  grok-wiki ask      <source...> --question "question" [--workspace-goal compare|steal|understand|bridge|audit]
  grok-wiki agents   [--rescan]
  grok-wiki list
  grok-wiki serve    [--port 3141] [--host 127.0.0.1]
  grok-wiki worker   [--once] [--job JOB_ID]
  grok-wiki sidecar  --token TOKEN [--port 0] [--host 127.0.0.1] [--stamp PATH]

Sources:
  GitHub URLs, owner/repo shorthands, or local paths. Repeat sources for a workspace wiki or multi-repo Ask.
  Local path refs use "#branch", for example: ~/work/repo#main

Local CLI agents:
  ${LOCAL_CLI_AGENT_IDS.join(", ")}
  Default: first ready local CLI agent

Wiki styles:
  ${WIKI_STYLES.join(", ")}

Languages:
  ${WIKI_LANGUAGES.join(", ")}

Wiki defaults:
  Style: ${CLI_DEFAULT_WIKI_STYLE}
  Default page target: auto up to ${CLI_DEFAULT_WIKI_PAGE_COUNT}

Examples:
  grok-wiki agents --rescan
  grok-wiki generate expressjs/express --agent grok --pages 8 --style first-30
  grok-wiki generate ./repo-a ./repo-b --agent codex --model gpt-5.5 --page-count-mode fixed --pages 6
  grok-wiki ask expressjs/express "How does routing work?" --agent claude --mode deep
  grok-wiki ask ./api ./web --question "Compare auth flows" --workspace-goal compare
`);
}

function localCliFromFlags(flags: Record<string, FlagValue>): LocalCliSelection {
  const rawAgent = flagString(flags, "agent", "local-agent", "local-cli");
  if (rawAgent && !(LOCAL_CLI_AGENT_IDS as readonly string[]).includes(rawAgent)) {
    throw new Error(`unknown local CLI agent "${rawAgent}". Known agents: ${LOCAL_CLI_AGENT_IDS.join(", ")}`);
  }
  return {
    explicitAgent: Boolean(rawAgent),
    localCli: normalizeLocalCliConfig({
      agentId: rawAgent ?? "grok",
      model: flagString(flags, "model", "local-model"),
      reasoning: flagString(flags, "reasoning", "effort"),
    }),
  };
}

function applyAgentDefaultModel(
  localCli: LocalCliConfig,
  agent: { id: string; defaultModel?: string | null },
): LocalCliConfig {
  const selectedModel = localCli.model && localCli.model !== "default"
    ? localCli.model
    : agent.defaultModel && agent.defaultModel !== "default"
    ? agent.defaultModel
    : undefined;
  return {
    ...localCli,
    agentId: agent.id as LocalCliAgentId,
    ...(selectedModel ? { model: selectedModel } : {}),
  };
}

async function resolveLocalCli(
  deps: CliDeps,
  selection: LocalCliSelection,
  io: CliIO,
): Promise<LocalCliConfig> {
  const status = await deps.getLocalCliAgents({ rescan: true });
  if (!status.enabled) {
    error(io, `Error: Local CLI mode is unavailable: ${status.error || "sidecar could not start"}`);
    error(io, "  Open Grok-Wiki on localhost or install and authenticate a local CLI agent.");
    throw new CliExit(1);
  }

  const selected = selection.explicitAgent
    ? status.agents.find((agent) => agent.id === selection.localCli.agentId)
    : status.agents.find((agent) => agent.runnable);
  if (!selection.explicitAgent && selected?.runnable) {
    return applyAgentDefaultModel(selection.localCli, selected);
  }
  if (selection.explicitAgent && selected?.runnable) return applyAgentDefaultModel(selection.localCli, selected);

  const agentLabel = selected?.name || (selection.explicitAgent ? localCliLabel(selection.localCli) : "Local CLI agent");
  const setupHint = selected?.setupHint || "Install and authenticate a local CLI agent, then run `grok-wiki agents --rescan`.";
  error(io, selection.explicitAgent
    ? `Error: ${agentLabel} is not ready for local-cli runs.`
    : "Error: no ready local CLI agents were found.");
  error(io, `  ${setupHint}`);
  throw new CliExit(1);
}

function splitLocalPathRef(value: string): { path: string; branch: string | null } {
  const marker = value.lastIndexOf("#");
  if (marker > 0 && marker < value.length - 1) {
    return {
      path: value.slice(0, marker).trim(),
      branch: value.slice(marker + 1).trim() || null,
    };
  }
  return { path: value, branch: null };
}

function looksLikeLocalPath(value: string): boolean {
  const path = splitLocalPathRef(value).path.trim();
  return path.startsWith("/") ||
    path.startsWith("~") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.toLowerCase().startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeLocalPath(path: string): string {
  let expanded = path.trim();
  if (expanded.toLowerCase().startsWith("file://")) {
    expanded = fileURLToPath(expanded);
  }
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/")) return resolve(homedir(), expanded.slice(2));
  return resolve(expanded);
}

function parseSourceInput(input: string): RepoRef {
  const value = input.trim();
  if (!value) throw new Error("source is required");
  if (!looksLikeLocalPath(value)) return parseGithubUrl(value);

  const parsed = splitLocalPathRef(value);
  const path = normalizeLocalPath(parsed.path);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Local folder does not exist: ${path}`);
  }
  if (parsed.branch && !existsSync(resolve(path, ".git"))) {
    throw new Error("Branch or ref selection requires a git repository.");
  }
  return {
    owner: "local",
    repo: basename(path) || "repo",
    url: path,
    branch: parsed.branch,
  };
}

function uniqueSourceInputs(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function refsFromSources(sources: string[]): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  const parsedRefs = sources.map(parseSourceInput);
  const deduped = parsedRefs.filter((ref, index, refs) => {
    const key = `${ref.owner}/${ref.repo}:${ref.url}@${ref.branch || ""}#${ref.sourcePath || ""}`.toLowerCase();
    return refs.findIndex((candidate) =>
      `${candidate.owner}/${candidate.repo}:${candidate.url}@${candidate.branch || ""}#${candidate.sourcePath || ""}`.toLowerCase() === key
    ) === index;
  });
  const refs = assignWorkspaceRepoIds(deduped);
  if (!refs.length) throw new Error("source is required");
  return {
    ref: wikiRefForWorkspace(refs),
    refs: refs.length > 1 ? refs : undefined,
  };
}

function sourceFlags(flags: Record<string, FlagValue>): string[] {
  return flagStrings(flags, "source", "repo", "url");
}

function parsePageCount(flags: Record<string, FlagValue>): number | undefined {
  const raw = flagNumber(flags, "pages") ?? flagNumber(flags, "page-count");
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 1 || raw > 30) {
    throw new Error("pages must be an integer from 1 to 30");
  }
  return raw;
}

function parseWikiLanguagesFlag(flags: Record<string, FlagValue>): WikiLanguage[] {
  const raw = flagString(flags, "language", "languages", "wiki-languages");
  if (!raw) return normalizeWikiLanguages(undefined);
  const requested = raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item === "zh" ? "zh-Hans" : item);
  const invalid = requested.find((item) => !(WIKI_LANGUAGES as readonly string[]).includes(item));
  if (invalid) throw new Error(`language must be one of: ${WIKI_LANGUAGES.join(", ")}`);
  return normalizeWikiLanguages(requested);
}

function readStylePrompt(flags: Record<string, FlagValue>): string {
  const promptFile = flagString(flags, "style-prompt-file");
  if (promptFile) return normalizeWikiStylePrompt(readFileSync(resolve(promptFile), "utf8"));
  return normalizeWikiStylePrompt(flagString(flags, "style-prompt"));
}

function maybeChannel(flags: Record<string, FlagValue>): string {
  return flagString(flags, "channel", "prompt-channel") ?? DEFAULT_CHANNEL_ID;
}

function optionalEnumFlag<T extends string>(
  flags: Record<string, FlagValue>,
  names: string[],
  allowed: readonly T[],
): T | undefined {
  const value = flagString(flags, ...names);
  if (!value) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${names[0]} must be one of: ${allowed.join(", ")}`);
}

function assertLocalCliRuntimeFlag(flags: Record<string, FlagValue>): void {
  const runtime = flagString(flags, "runtime");
  if (runtime && runtime !== "local-cli") {
    throw new Error("grok-wiki CLI only supports --runtime local-cli.");
  }
}

function parsePort(flags: Record<string, FlagValue>, fallback: number): number {
  const port = flagNumber(flags, "port") ?? fallback;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  return port;
}

function agentEventLine(event: Record<string, unknown>, verbose: boolean): string | null {
  const type = String(event.type || "");
  if (type === "status") {
    const message = String(event.message || event.label || "").trim();
    const phase = String(event.phase || event.label || "status").trim();
    return message ? `  [${phase}] ${message}` : null;
  }
  if (type === "tool_use" || type === "tool-start") {
    const name = String(event.name || event.tool || "tool").trim();
    return `  [tool] ${name}`;
  }
  if (type === "tool_result" || type === "tool-done") {
    if (!verbose) return null;
    const name = String(event.name || event.tool || "tool").trim();
    const duration = typeof event.durationMs === "number" ? ` ${Math.round(event.durationMs)}ms` : "";
    return `  [tool-done] ${name}${duration}`;
  }
  if (type === "error" || type === "tool-error") {
    return `  [error] ${String(event.error || event.message || "local CLI error")}`;
  }
  if (verbose && (type === "thinking_delta" || type === "stream-reasoning-delta")) {
    const text = String(event.text || event.delta || "").replace(/\s+/g, " ").trim();
    return text ? `  [thinking] ${text.slice(0, 160)}` : null;
  }
  return null;
}

interface ProductEventQueue {
  append(type: string, payload: unknown): void;
  flush(): Promise<void>;
}

function productEventQueue(productStore: ProductStore, runId: string, io: CliIO): ProductEventQueue {
  let queue = Promise.resolve();
  let failed = false;
  return {
    append(type, payload) {
      if (failed) return;
      queue = queue
        .then(() => productStore.appendEvent(runId, type, payload))
        .then(() => undefined)
        .catch((err) => {
          failed = true;
          error(io, `Warning: could not persist CLI run event: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    flush() {
      return queue;
    },
  };
}

async function productStoreForCli(deps: CliDeps, store: WikiStore): Promise<ProductStore> {
  return (deps.createProductStore ?? createProductStore)(store.root, { ownerUserId: "legacy" });
}

function publicRepoRef(ref: WorkspaceRepoRef | RepoRef): Record<string, unknown> {
  return {
    ...(typeof (ref as WorkspaceRepoRef).id === "string" ? { id: (ref as WorkspaceRepoRef).id } : {}),
    ...(typeof (ref as WorkspaceRepoRef).label === "string" ? { label: (ref as WorkspaceRepoRef).label } : {}),
    owner: ref.owner,
    repo: ref.repo,
    url: ref.url,
    branch: ref.branch,
    sourcePath: ref.sourcePath ?? null,
  };
}

function askTurnRecord(args: {
  id: string;
  question: string;
  status: "running" | "done" | "error" | "canceled";
  refs: WorkspaceRepoRef[];
  channel: string;
  localCli: LocalCliConfig;
  askMode: AskMode;
  workspaceGoal: WorkspaceGoal | null;
  startedAt: string;
  completedAt?: string | null;
  answer?: string;
  sources?: string[];
  error?: string | null;
}): Record<string, unknown> {
  return {
    id: args.id,
    question: args.question,
    status: args.status,
    refs: args.refs.map(publicRepoRef),
    history: [],
    channel: args.channel,
    runtime: "local-cli",
    localCli: args.localCli,
    model: localCliLabel(args.localCli),
    workspaceGoal: args.workspaceGoal,
    askMode: args.askMode,
    startedAt: args.startedAt,
    completedAt: args.completedAt ?? null,
    ...(args.answer !== undefined ? { answer: args.answer } : {}),
    ...(args.sources ? { sources: args.sources } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}

async function cmdGenerate(
  positional: string[],
  flags: Record<string, FlagValue>,
  deps: CliDeps,
  io: CliIO,
): Promise<void> {
  const sources = uniqueSourceInputs([...sourceFlags(flags), ...positional]);
  if (!sources.length) {
    error(io, "Error: missing <source>");
    printUsage(io);
    throw new CliExit(1);
  }

  const { ref, refs } = refsFromSources(sources);
  assertLocalCliRuntimeFlag(flags);
  const localCli = await resolveLocalCli(deps, localCliFromFlags(flags), io);

  const channelId = maybeChannel(flags);
  const channel = resolveChannel(channelId);
  const requestedConcurrency = flagNumber(flags, "concurrency");
  if (requestedConcurrency !== undefined && (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1)) {
    throw new Error("concurrency must be a positive integer");
  }
  const requestedPageCount = parsePageCount(flags);
  const depth = flagString(flags, "depth");
  const pageCount = normalizeWikiPageCount(
    requestedPageCount,
    depth ? defaultWikiPageCountForDepth(depth) : CLI_DEFAULT_WIKI_PAGE_COUNT,
  );
  const pageCountMode = normalizeWikiPageCountMode(
    optionalEnumFlag<WikiPageCountMode>(flags, ["page-count-mode", "pageCountMode"], ["auto", "fixed"]),
  );
  const style = normalizeWikiStyle(
    optionalEnumFlag<WikiStyle>(flags, ["style"], WIKI_STYLES),
    CLI_DEFAULT_WIKI_STYLE,
  );
  const stylePrompt = readStylePrompt(flags);
  if (style === "custom" && !stylePrompt) throw new Error("custom style requires --style-prompt or --style-prompt-file");
  const languages = parseWikiLanguagesFlag(flags);
  const concurrency = resolveWikiConcurrency(channel, requestedConcurrency, localCli);
  const store = deps.createStore();
  const verbose = flagBool(flags, "verbose");
  const repoLabel = refs?.length ? refs.map((item) => item.label).join(" + ") : `${ref.owner}/${ref.repo}`;

  print(io, "");
  print(io, `→ Generating wiki for ${repoLabel}`);
  print(io, `  provider: local-cli`);
  print(io, `  agent: ${localCliLabel(localCli)}`);
  print(io, `  pages: ${pageCountMode === "auto" ? `auto up to ${pageCount}` : pageCount}`);
  print(io, `  style: ${style}`);
  print(io, `  language: ${languages[0]}`);
  print(io, `  concurrency: ${concurrency}${requestedConcurrency ? "" : " (auto)"}`);
  print(io, `  storage: ${store.root}`);
  print(io, "");

  const productStore = await productStoreForCli(deps, store);
  const run = await productStore.createRun({
    kind: "wiki_generate",
    title: `Generate wiki · ${repoLabel}`,
    input: {
      ref: publicRepoRef(ref),
      ...(refs ? { refs: refs.map(publicRepoRef) } : {}),
      channel: channelId,
      runtime: "local-cli",
      localCli,
      pageCount,
      pageCountMode,
      style,
      stylePrompt,
      languages,
      source: "cli",
    },
  });
  const events = productEventQueue(productStore, run.id, io);
  events.append("start", {
    runId: run.id,
    owner: ref.owner,
    repo: ref.repo,
    url: ref.url,
    branch: ref.branch,
    workspace: Boolean(refs?.length && refs.length > 1),
    repos: refs?.map(publicRepoRef) ?? [publicRepoRef(ref)],
    channel: channelId,
    runtime: "local-cli",
    localCli,
    pageCount,
    pageCountMode,
    style,
    languages,
  });

  let record: WikiRecord;
  try {
    record = await deps.generateWiki(ref, {
      refs,
      channel: channelId,
      structureChannel: channelId,
      pageChannel: channelId,
      runtime: "local-cli",
      localCli,
      concurrency: requestedConcurrency,
      pageCount,
      pageCountMode,
      style,
      stylePrompt,
      languages,
      store,
      onEvent: (ev) => {
        events.append(ev.type, ev);
        switch (ev.type) {
          case "phase":
            print(io, `  [${ev.phase}] ${ev.message}`);
            break;
          case "structure-done":
            print(io, `  ✓ Structure: "${ev.structure.title}" — ${ev.structure.pages.length} pages`);
            for (const page of ev.structure.pages) {
              print(io, `     • ${page.id} — ${page.title} (${page.importance}, ${page.filePaths.length} files)`);
            }
            break;
          case "page-start":
            print(io, `  → [${ev.pageId}] start: ${ev.title}`);
            break;
          case "page-done":
            print(io, `  ✓ [${ev.pageId}] done (${ev.content.length} chars)`);
            break;
          case "page-error":
            print(io, `  ✗ [${ev.pageId}] error: ${ev.displayError || ev.error}`);
            break;
          case "structure-agent":
          case "page-agent": {
            const line = agentEventLine(ev.event as unknown as Record<string, unknown>, verbose);
            if (line) print(io, line);
            break;
          }
          case "done":
            print(io, "");
            print(io, `✓ Wiki saved to ${store.pathForRecord(ev.record)}`);
            break;
        }
      },
    });
  } catch (err) {
    await events.flush();
    await productStore.updateRun(run.id, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await events.flush();
  await productStore.updateRun(run.id, {
    status: "done",
    result: { wiki: record as unknown as Record<string, unknown> },
    error: null,
  });
  await productStore.upsertArtifact({
    kind: "wiki",
    key: wikiRecordArtifactKey(record),
    runId: run.id,
    data: record as unknown as Record<string, unknown>,
  });

  print(io, "");
  print(io, `Generated ${Object.keys(record.pages).length} pages in "${record.structure.title}".`);
}

function parseAskInputs(positional: string[], flags: Record<string, FlagValue>): { sources: string[]; question: string } {
  const questionFlag = flagString(flags, "question", "q");
  if (questionFlag) {
    return {
      sources: uniqueSourceInputs([...sourceFlags(flags), ...positional]),
      question: questionFlag,
    };
  }
  const flaggedSources = sourceFlags(flags);
  if (flaggedSources.length) {
    return {
      sources: uniqueSourceInputs(flaggedSources),
      question: positional.join(" ").trim(),
    };
  }
  const [source, ...questionParts] = positional;
  return {
    sources: source ? [source] : [],
    question: questionParts.join(" ").trim(),
  };
}

async function cmdAsk(
  positional: string[],
  flags: Record<string, FlagValue>,
  deps: CliDeps,
  io: CliIO,
): Promise<void> {
  const { sources, question } = parseAskInputs(positional, flags);
  if (!sources.length || !question) {
    error(io, 'Error: usage is `grok-wiki ask <source> "question"` or `grok-wiki ask <source...> --question "question"`');
    throw new CliExit(1);
  }

  const { ref, refs } = refsFromSources(sources);
  assertLocalCliRuntimeFlag(flags);
  const workspaceRefs = refs ?? assignWorkspaceRepoIds([ref]);
  const localCli = await resolveLocalCli(deps, localCliFromFlags(flags), io);

  const channelId = maybeChannel(flags);
  resolveChannel(channelId);
  const askMode: AskMode = optionalEnumFlag(flags, ["mode", "ask-mode"], [...ASK_MODES]) ?? "deep";
  const workspaceGoal = optionalEnumFlag(flags, ["workspace-goal", "goal"], [...WORKSPACE_GOALS]) ?? null;
  const store = deps.createStore();
  const verbose = flagBool(flags, "verbose");
  const productStore = await productStoreForCli(deps, store);
  const startedAt = new Date().toISOString();
  const turnId = crypto.randomUUID();
  const runningTurn = askTurnRecord({
    id: turnId,
    question,
    status: "running",
    refs: workspaceRefs,
    channel: channelId,
    localCli,
    askMode,
    workspaceGoal,
    startedAt,
  });
  let run: ProductRun = await productStore.createRun({
    kind: "ask",
    title: question,
    input: {
      refs: workspaceRefs.map(publicRepoRef),
      question,
      history: [],
      channel: channelId,
      runtime: "local-cli",
      localCli,
      model: localCliLabel(localCli),
      workspaceGoal,
      askMode,
      currentTurnId: turnId,
      turns: [runningTurn],
      source: "cli",
    },
  });
  const events = productEventQueue(productStore, run.id, io);

  print(io, "");
  print(io, `→ Asking ${workspaceRefs.map((item) => item.label).join(" + ")}: "${question}"`);
  print(io, `  provider: local-cli`);
  print(io, `  agent: ${localCliLabel(localCli)}`);
  print(io, `  mode: ${askMode}`);
  if (workspaceGoal) print(io, `  workspace goal: ${workspaceGoal}`);
  print(io, "");
  events.append("start", {
    runId: run.id,
    turnId,
    owner: ref.owner,
    repo: ref.repo,
    url: ref.url,
    branch: ref.branch,
    sourcePath: ref.sourcePath ?? null,
    workspace: workspaceRefs.length > 1,
    repos: workspaceRefs.map(publicRepoRef),
    question,
    channel: channelId,
    runtime: "local-cli",
    localCli,
    workspaceGoal,
    askMode,
  });

  const onEvent = (ev: { type: string; event?: unknown }): void => {
    if (ev.type !== "agent") return;
    events.append(ev.type, { turnId, ...ev });
    const line = agentEventLine(ev.event as Record<string, unknown>, verbose);
    if (line) print(io, line);
  };

  let result: { answer: string; sources: string[] };
  try {
    result = workspaceRefs.length > 1
      ? await deps.askWorkspace(workspaceRefs, question, {
        channel: channelId,
        runtime: "local-cli",
        localCli,
        askMode,
        workspaceGoal,
        store,
        onEvent,
      })
      : await deps.askRepo(ref, question, {
        channel: channelId,
        runtime: "local-cli",
        localCli,
        askMode,
        store,
        onEvent,
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const erroredTurn = askTurnRecord({
      id: turnId,
      question,
      status: "error",
      refs: workspaceRefs,
      channel: channelId,
      localCli,
      askMode,
      workspaceGoal,
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    });
    events.append("error", { turnId, message });
    await events.flush();
    await productStore.updateRun(run.id, {
      status: "error",
      input: { ...run.input, turns: [erroredTurn] },
      result: { turns: [erroredTurn], error: message },
      error: message,
    });
    throw err;
  }

  const completedTurn = askTurnRecord({
    id: turnId,
    question,
    status: "done",
    refs: workspaceRefs,
    channel: channelId,
    localCli,
    askMode,
    workspaceGoal,
    startedAt,
    completedAt: new Date().toISOString(),
    answer: result.answer,
    sources: result.sources,
  });
  events.append("answer", { turnId, answer: result.answer, sources: result.sources });
  await events.flush();
  run = await productStore.updateRun(run.id, {
    status: "done",
    input: { ...run.input, turns: [completedTurn] },
    result: {
      turns: [completedTurn],
      answer: result.answer,
      sources: result.sources,
      error: null,
    },
    error: null,
  }) ?? run;

  print(io, "");
  print(io, "========== ANSWER ==========");
  print(io, "");
  print(io, result.answer);
  print(io, "");
  print(io, "========== SOURCES ==========");
  if (result.sources.length) {
    for (const source of result.sources) print(io, `  - ${source}`);
  } else {
    print(io, "  (none reported)");
  }
}

async function cmdAgents(flags: Record<string, FlagValue>, deps: CliDeps, io: CliIO): Promise<void> {
  const status = await deps.getLocalCliAgents({ rescan: flagBool(flags, "rescan") });
  if (!status.enabled) {
    error(io, `Local CLI sidecar unavailable: ${status.error || "unknown error"}`);
    throw new CliExit(1);
  }
  print(io, "Local CLI agents:");
  for (const agent of status.agents) {
    const marker = agent.runnable ? "ready" : agent.installed ? "needs auth" : "missing";
    const model = agent.defaultModel ? ` default=${agent.defaultModel}` : "";
    print(io, `  ${agent.id.padEnd(12)} ${marker.padEnd(10)} ${agent.name}${model}`);
    if (!agent.runnable && agent.setupHint) print(io, `    ${agent.setupHint}`);
  }
}

function cmdList(deps: CliDeps, io: CliIO): void {
  const store = deps.createStore();
  const wikis = store.list();
  if (!wikis.length) {
    print(io, "No wikis generated yet.");
    return;
  }
  print(io, `Found ${wikis.length} wiki(s) in ${store.wikisDir}:`);
  print(io, "");
  for (const wiki of wikis) {
    const agent = wiki.runtimeModelLabel ? ` · ${wiki.runtimeModelLabel}` : "";
    print(io, `  ${wiki.owner}/${wiki.repo} — "${wiki.title}" (${wiki.pageCount} pages, ${wiki.generatedAt}${agent})`);
  }
}

async function cmdServe(flags: Record<string, FlagValue>, deps: CliDeps): Promise<void> {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  const port = parsePort(flags, envPort ?? 3141);
  const defaultHost = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
  const host = flagString(flags, "host") || process.env.HOST || defaultHost;
  await deps.startServer({ port, host });
}

async function cmdWorker(flags: Record<string, FlagValue>, deps: CliDeps): Promise<void> {
  const jobId = flagString(flags, "job") || process.env.RLM_WIKI_JOB_ID || "";
  await deps.startWorker({
    once: flagBool(flags, "once") || Boolean(jobId),
    jobId: jobId || undefined,
  });
}

async function cmdSidecar(flags: Record<string, FlagValue>, deps: CliDeps): Promise<void> {
  const token = flagString(flags, "token") || "";
  if (!token) throw new Error("sidecar requires --token");
  const port = parsePort(flags, 0);
  const host = flagString(flags, "host") || "127.0.0.1";
  const stampPath = flagString(flags, "stamp");
  await deps.startLocalCliSidecar({ host, port, token, stampPath });
}

class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`CLI exited with ${code}`);
    this.code = code;
  }
}

export async function runCli(
  argv = process.argv.slice(2),
  deps: CliDeps = defaultDeps,
  io: CliIO = defaultIO,
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printUsage(io);
    return 0;
  }

  const { positional, flags } = parseFlags(rest);
  try {
    switch (cmd) {
      case "generate":
        await cmdGenerate(positional, flags, deps, io);
        return 0;
      case "ask":
        await cmdAsk(positional, flags, deps, io);
        return 0;
      case "agents":
      case "agent-status":
        await cmdAgents(flags, deps, io);
        return 0;
      case "list":
        cmdList(deps, io);
        return 0;
      case "serve":
        await cmdServe(flags, deps);
        return 0;
      case "worker":
        await cmdWorker(flags, deps);
        return 0;
      case "sidecar":
        await cmdSidecar(flags, deps);
        return 0;
      default:
        error(io, `Unknown command: ${cmd}`);
        printUsage(io);
        return 1;
    }
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    error(io, "");
    error(io, `Fatal: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack && flagBool(flags, "debug")) error(io, err.stack);
    return 1;
  }
}

export type { WikiRecord };
