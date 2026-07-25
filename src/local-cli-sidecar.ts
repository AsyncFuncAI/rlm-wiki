import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  loadPRWorkingTree,
  loadSource,
  loadWorkspace,
  parsePRURL,
  type PreparedRun,
} from "./jcode-runtime.ts";
import { normalizeScreenshotAttachments, type CodeScreenshotAttachment } from "./vision.ts";
import {
  LOCAL_CLI_AGENT_IDS,
  normalizeLocalCliConfig,
  type LocalCliAgentId,
  type LocalCliAgentStatus,
  type LocalCliConfig,
  type LocalCliEvent,
  type LocalCliRunArtifact,
  type LocalCliRunMetadata,
} from "./local-cli-events.ts";
import {
  acpJsonToEvents,
  claudeJsonToEvents,
  codexJsonToEvents,
  createAcpParserState,
  createClaudeParserState,
  createCodexParserState,
  createPiParserState,
  extractAnswer,
  extractSources,
  grokJsonToEvents,
  piJsonToEvents,
} from "./local-cli-parsers.ts";
import { PROVIDER_SECRET_KEYS } from "./provider-secrets.ts";
import {
  defaultClaudeConfigDir,
  defaultCodexHome,
  getActiveClaudeConfigDir,
  getActiveCodexHome,
} from "./provider-accounts/index.ts";
import { acpAdapterFor, acpTransportPreference } from "./acp/adapters.ts";
import {
  isLocalCliReadOnlyContext,
  isPiSupportedContext,
  modelsForLocalCliAgent,
  piToolsForContext,
  codexSandboxForContext,
} from "./local-cli-agent-policy.ts";

const SIDE_CAR_TTL_MS = Math.max(
  60_000,
  Number(process.env.GROK_WIKI_LOCAL_CLI_WORKSPACE_TTL_MS || process.env.RLM_WIKI_LOCAL_CLI_WORKSPACE_TTL_MS || 15 * 60_000),
);
const LOCAL_CLI_PROMPT_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GROK_WIKI_LOCAL_CLI_PROMPT_TIMEOUT_MS || process.env.RLM_WIKI_LOCAL_CLI_PROMPT_TIMEOUT_MS || 31 * 60_000),
);
const LOCAL_CLI_PROBE_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.GROK_WIKI_LOCAL_CLI_PROBE_TIMEOUT_MS || process.env.RLM_WIKI_LOCAL_CLI_PROBE_TIMEOUT_MS || 1_500),
);
const ANTIGRAVITY_STATUS_HEARTBEAT_MS = Math.max(
  5_000,
  Number(process.env.GROK_WIKI_ANTIGRAVITY_STATUS_HEARTBEAT_MS || process.env.RLM_WIKI_ANTIGRAVITY_STATUS_HEARTBEAT_MS || 15_000),
);
const ANTIGRAVITY_QUIET_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GROK_WIKI_ANTIGRAVITY_QUIET_TIMEOUT_MS || process.env.RLM_WIKI_ANTIGRAVITY_QUIET_TIMEOUT_MS || 5 * 60_000),
);
const LOCAL_CLI_RUN_PREFIX = "grok-wiki-local-cli-";
const LOCAL_CLI_PROVIDER_ENV_ALLOW =
  process.env.GROK_WIKI_LOCAL_CLI_ALLOW_PROVIDER_ENV === "1" ||
  process.env.RLM_WIKI_LOCAL_CLI_ALLOW_PROVIDER_ENV === "1";
const LOCAL_CLI_PROVIDER_ENV_KEYS = new Set([
  ...PROVIDER_SECRET_KEYS,
  "ANTHROPIC_API_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
]);
const LOCAL_CLI_PROVIDER_ENV_PATTERNS = [
  /^DEEPSEEK_API_KEY_\d+$/,
  /^GROK_WIKI_.*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|KEY)$/,
  /^RLM_WIKI_.*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|KEY)$/,
];
const LOCAL_CLI_TERMINAL_PREFIX = "grok-wiki-local-cli-terminal-";
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const PI_CODEX_PROVIDER = "openai-codex";
const PI_CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const PI_CLAUDE_PROVIDER = "anthropic";
const PI_CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
// Memory guards for retained run records (see SidecarRunRecord.events). A single tool_result
// can carry 50-200KB of raw output and text_delta floods accumulate for the whole run, so cap
// both the per-event payload on ingest and the total retained event bytes per run.
export const LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP = Math.max(
  4_096,
  Number(process.env.GROK_WIKI_LOCAL_CLI_EVENT_PAYLOAD_BYTES || process.env.RLM_WIKI_LOCAL_CLI_EVENT_PAYLOAD_BYTES || 64 * 1024),
);
export const LOCAL_CLI_RUN_EVENT_BYTE_BUDGET = Math.max(
  LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP,
  Number(process.env.GROK_WIKI_LOCAL_CLI_RUN_EVENT_BUDGET_BYTES || process.env.RLM_WIKI_LOCAL_CLI_RUN_EVENT_BUDGET_BYTES || 12 * 1024 * 1024),
);
const LOCAL_CLI_PAYLOAD_TRUNCATION_MARKER = "\n…[truncated under memory pressure]";
let cachedLoginShellPathDirs: string[] | null = null;

interface SourceSpec {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
}

interface SidecarRunRequest {
  source?: string;
  sources?: Array<string | SourceSpec>;
  branch?: string | null;
  sourcePath?: string | null;
  prompt: string;
  localCli?: LocalCliConfig;
  basePatch?: string;
  screenshots?: unknown[];
  contextLabel?: string;
  /**
   * Chat/routing escape hatch: run the agent in an empty scratch directory with no
   * repository clone. Used by sourceless decision endpoints (e.g. POST /api/route).
   */
  sourceless?: boolean;
}

interface PreparedScreenshot {
  path: string;
  name: string;
  mimeType: string;
}

interface SidecarRunRecord {
  id: string;
  status: "queued" | "running" | "done" | "error" | "canceled";
  events: Array<{ event: string; data: unknown; bytes: number; terminal: boolean }>;
  eventBytes?: number;
  subscribers: Set<(event: string, data: unknown) => void>;
  controller: AbortController;
  metadata?: LocalCliRunMetadata;
  error?: string;
  cleanup?: () => Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface TerminalWorkspaceRequest {
  source?: string;
  branch?: string | null;
  sourcePath?: string | null;
}

interface TerminalWorkspaceRecord {
  id: string;
  source: string;
  cwd: string;
  diffCwd?: string;
  root: string;
  sourcePath?: string | null;
  context: string;
  cleanup: () => Promise<void>;
}

interface StartSidecarOptions {
  host?: string;
  port?: number;
  token: string;
  stampPath?: string;
}

const runs = new Map<string, SidecarRunRecord>();
const terminalWorkspaces = new Map<string, TerminalWorkspaceRecord>();

export async function startLocalCliSidecar(opts: StartSidecarOptions): Promise<void> {
  const host = opts.host || "127.0.0.1";
  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({ ok: true, pid: process.pid });
      }
      if (!authorized(req, opts.token)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (req.method === "GET" && url.pathname === "/v1/agents") {
        const rescan = url.searchParams.get("rescan") === "1";
        const probe = url.searchParams.get("probe") === "1";
        return jsonResponse({ agents: detectLocalCliAgents({ rescan, probe }) });
      }
      if (req.method === "POST" && url.pathname === "/v1/runs") {
        const body = await req.json().catch(() => null);
        const run = createRun(body);
        queueMicrotask(() => executeRun(run, body as SidecarRunRequest).catch((error) => {
          finishRunError(run, error instanceof Error ? error.message : String(error));
        }));
        return jsonResponse({ runId: run.id });
      }
      const eventMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventMatch) {
        const run = runs.get(eventMatch[1]);
        if (!run) return jsonResponse({ error: "run not found" }, 404);
        return runEventsResponse(run, req);
      }
      const artifactMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && artifactMatch) {
        const run = runs.get(artifactMatch[1]);
        if (!run) return jsonResponse({ error: "run not found" }, 404);
        return jsonResponse({
          contract: "open-design.local-cli.artifacts.v1",
          runId: run.id,
          status: run.status,
          metadata: run.metadata ?? null,
          artifacts: run.metadata?.artifacts ?? [],
          error: run.error ?? null,
        });
      }
      const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const run = runs.get(cancelMatch[1]);
        if (!run) return jsonResponse({ error: "run not found" }, 404);
        run.controller.abort("Canceled by caller.");
        return jsonResponse({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/v1/terminal-workspaces") {
        try {
          const body = await req.json().catch(() => null);
          return jsonResponse(await createTerminalWorkspace(body));
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      const terminalWorkspaceMatch = url.pathname.match(/^\/v1\/terminal-workspaces\/([^/]+)$/);
      if (req.method === "DELETE" && terminalWorkspaceMatch) {
        const released = await releaseTerminalWorkspace(terminalWorkspaceMatch[1]);
        return jsonResponse({ ok: true, released });
      }
      return jsonResponse({ error: "not found" }, 404);
    },
  });

  if (opts.stampPath) {
    mkdirSync(dirname(opts.stampPath), { recursive: true });
    writeFileSync(opts.stampPath, JSON.stringify({
      pid: process.pid,
      host,
      port: server.port,
      token: opts.token,
      startedAt: new Date().toISOString(),
    }) + "\n", "utf8");
  }

  console.log(`[local-cli-sidecar] listening on http://${host}:${server.port}`);
  scheduleStaleWorkspaceCleanup();
  await new Promise<void>(() => {});
}

let cachedAgents: LocalCliAgentStatus[] | null = null;

export function detectLocalCliAgents(opts: { rescan?: boolean; probe?: boolean } = {}): LocalCliAgentStatus[] {
  if (opts.rescan) {
    // Re-discover binaries on PATH only. Must NOT touch the readiness cache: every
    // run's preflight passes rescan=1 (server.ts localCliPreflightResponse), so
    // clearing readiness here would wipe the cache before every run and re-pay the
    // per-run probe the cache exists to avoid.
    cachedAgents = null;
    cachedLoginShellPathDirs = null;
  }
  if (opts.probe) {
    // Full readiness re-verification (the settings "Rescan" button sends probe=1).
    // Clear first so agents that disappeared drop out; refreshAgentReadiness then
    // overwrites/deletes the surviving entries with freshly probed status.
    agentReadinessCache.clear();
    return LOCAL_CLI_AGENT_IDS.map(refreshAgentReadiness);
  }
  if (cachedAgents && !opts.rescan) return cachedAgents;
  cachedAgents = LOCAL_CLI_AGENT_IDS.map(detectOneAgentPathOnly);
  return cachedAgents;
}

// Readiness on the RUN path (cachedAgentReadiness) must never spawn the agent just
// to read a version string: `runnable` is derived from auth alone (codex/pi checks,
// or "unknown"), and `version` is display-only for the settings UI. A `claude
// --version` boot measured ~4.8s and dominated ask start latency, so the run-path
// probe skips it (version: null). The settings/probe path (refreshAgentReadiness)
// still fetches versions to display them. Positive results are cached briefly;
// negative results are never cached so a just-completed install/login is picked up
// on the very next run. A run failure invalidates the entry so stale "ready" never
// masks a logout (see executeRun). A version:null run-path entry is replaced with a
// version-bearing one whenever the user opens settings (probe recomputes fully).
const AGENT_READINESS_TTL_MS = 5 * 60_000;
const agentReadinessCache = new Map<LocalCliAgentId, { status: LocalCliAgentStatus; at: number }>();

function refreshAgentReadiness(id: LocalCliAgentId): LocalCliAgentStatus {
  const status = detectOneAgentReadiness(id, { withVersion: true });
  if (status.installed && status.runnable) agentReadinessCache.set(id, { status, at: Date.now() });
  else agentReadinessCache.delete(id);
  return status;
}

function cachedAgentReadiness(id: LocalCliAgentId): LocalCliAgentStatus {
  const hit = agentReadinessCache.get(id);
  if (hit && Date.now() - hit.at < AGENT_READINESS_TTL_MS) return hit.status;
  // Cache miss on the run path: verify auth WITHOUT the version spawn.
  const status = detectOneAgentReadiness(id, { withVersion: false });
  if (status.installed && status.runnable) agentReadinessCache.set(id, { status, at: Date.now() });
  else agentReadinessCache.delete(id);
  return status;
}

function invalidateAgentReadiness(id: LocalCliAgentId): void {
  agentReadinessCache.delete(id);
}

// Test-only: exercise the run-path readiness lookup (the version-skipping, cache-
// backed check executeRun uses) without standing up the HTTP server or a real run.
export function __runPathAgentReadinessForTests(id: LocalCliAgentId): LocalCliAgentStatus {
  return cachedAgentReadiness(id);
}

// Test-only: drop all cached readiness without probing the environment. Since a
// rescan no longer clears readiness, scenarios that primed a positive entry must
// reset it explicitly so it does not leak into the next scenario's isolated env.
export function __resetAgentReadinessForTests(): void {
  agentReadinessCache.clear();
}

function missingAgentStatus(id: LocalCliAgentId): LocalCliAgentStatus {
  const def = agentDefinition(id);
  return {
    id,
    name: def.name,
    bin: def.bin,
    path: null,
    installed: false,
    runnable: false,
    version: null,
    authStatus: "missing",
    models: def.models,
    defaultModel: def.models[0],
    reasoningOptions: def.reasoningOptions,
    setupHint: def.installHint,
  };
}

function detectOneAgentPathOnly(id: LocalCliAgentId): LocalCliAgentStatus {
  const def = agentDefinition(id);
  const path = resolveExecutable(def.bin, def.fallbackBins ?? []);
  if (!path) return missingAgentStatus(id);
  return {
    id,
    name: def.name,
    bin: def.bin,
    path,
    installed: true,
    // Discovery must not execute agent binaries. Treat PATH presence as runnable
    // enough for UI selection, then verify readiness only on an explicit run/probe.
    runnable: true,
    version: null,
    authStatus: "unknown",
    models: def.models,
    defaultModel: def.models[0],
    reasoningOptions: def.reasoningOptions,
    setupHint: def.authHint,
  };
}

function detectOneAgentReadiness(id: LocalCliAgentId, opts: { withVersion?: boolean } = {}): LocalCliAgentStatus {
  const def = agentDefinition(id);
  const path = resolveExecutable(def.bin, def.fallbackBins ?? []);
  if (!path) return missingAgentStatus(id);
  // version is display-only; the run path skips it to avoid a multi-second binary spawn.
  const version = opts.withVersion ? runVersion(path, def.versionArgs) : null;
  const auth = id === "codex"
    ? codexAuthStatus(path)
    : id === "pi-codex" || id === "pi-claude"
    ? piAuthStatus(piProviderForAgent(id))
    : "unknown";
  return {
    id,
    name: def.name,
    bin: def.bin,
    path,
    installed: true,
    runnable: auth !== "missing",
    version,
    authStatus: auth,
    models: def.models,
    defaultModel: def.models[0],
    reasoningOptions: def.reasoningOptions,
    setupHint: auth === "missing" ? def.authHint : undefined,
  };
}

function createRun(raw: unknown): SidecarRunRecord {
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const run: SidecarRunRecord = {
    id,
    status: "queued",
    events: [],
    subscribers: new Set(),
    controller: new AbortController(),
  };
  runs.set(id, run);
  return run;
}

// Test-only: build a detached run record (not registered in the `runs` Map) so the
// emitRun memory guards can be exercised without standing up the HTTP server.
export function __createDetachedRunForTests(): SidecarRunRecord {
  return {
    id: `test-${randomBytes(4).toString("hex")}`,
    status: "running",
    events: [],
    subscribers: new Set(),
    controller: new AbortController(),
  };
}

async function executeRun(run: SidecarRunRecord, body: SidecarRunRequest): Promise<void> {
  const startedAt = Date.now();
  const phase = (
    label: string,
    message: string,
    extra: Partial<Extract<LocalCliEvent, { type: "status" }>> = {},
  ): void => {
    emitRun(run, "event", {
      type: "status",
      label,
      phase: label,
      message,
      durationMs: Date.now() - startedAt,
      ...extra,
    } satisfies LocalCliEvent);
  };
  const request = normalizeRunRequest(body);
  const config = normalizeLocalCliConfig(request.localCli);
  const agent = cachedAgentReadiness(config.agentId);
  const selectedModel = config.model && config.model !== "default"
    ? config.model
    : agent.defaultModel && agent.defaultModel !== "default"
    ? agent.defaultModel
    : undefined;
  if (!agent.path || !agent.runnable) {
    throw new Error(`${agent.name} is not installed or authenticated. ${agent.setupHint || "Install and authenticate it, then rescan."}`);
  }
  const agentPath = agent.path;

  run.status = "running";
  phase("preparing", "Preparing local CLI workspace.");
  const prepared = await prepareSidecarRun(request);
  run.cleanup = prepared.cleanup;
  phase("workspace-ready", "Local CLI workspace is ready.");
  const diffCwd = prepared.diffCwd || prepared.cwd;
  const screenshots = materializeScreenshots(prepared.cwd, normalizeScreenshotAttachments(request.screenshots));
  const baseHead = gitOutput(diffCwd, ["rev-parse", "HEAD"]).trim() || "HEAD";
  if (request.basePatch?.trim()) {
    applyBasePatch(diffCwd, request.basePatch);
    phase("continuation", "Applied previous patch in sidecar workspace.");
  }

  const textChunks: string[] = [];
  let localCliWorkStarted = false;
  const finalPrompt = buildLocalCliPrompt({
    prompt: request.prompt,
    context: [prepared.context, screenshotsPrompt(screenshots, config.agentId)].filter(Boolean).join("\n\n"),
    agentName: agent.name,
    skillsContext: "",
  });
  phase("starting", `Starting ${agent.name}.`, { agentId: config.agentId, model: selectedModel });
  try {
    await runWithLocalCliModelFallback(
      selectedModel,
      (model) => runAdapter({
        run,
        agentId: config.agentId,
        binPath: agentPath,
        cwd: prepared.cwd,
        prompt: finalPrompt,
        model,
        reasoning: config.reasoning,
        screenshots,
        contextLabel: request.contextLabel,
        readOnly: isLocalCliReadOnlyContext(request.contextLabel),
        phase,
        onEvent: (event) => {
          if (localCliEventStartsWork(event)) localCliWorkStarted = true;
          if (event.type === "text_delta") textChunks.push(event.text);
          emitRun(run, "event", event);
        },
      }),
      {
        canFallback: () => !localCliWorkStarted,
        onFallback: (rejectedModel) => {
          const message = `${agent.name} does not offer ${rejectedModel}; retrying with its default model.`;
          phase("model-fallback", message, { agentId: config.agentId, model: "default" });
        },
      },
    );
  } catch (error) {
    // The cached "ready" may be stale (binary updated, logged out). Drop it so the
    // next run re-probes and surfaces the real setup hint instead of a spawn error.
    invalidateAgentReadiness(config.agentId);
    throw error;
  }

  const rawText = stripLocalCliPromptEcho(textChunks.join("").trim(), finalPrompt);
  run.metadata = {
    runId: run.id,
    workspacePath: diffCwd,
    baseHead,
    rawText,
    answer: extractAnswer(rawText),
    sources: extractSources(rawText),
  };
  run.metadata.artifacts = collectRunArtifacts(diffCwd, baseHead, run.metadata);
  run.status = "done";
  emitRun(run, "done", run.metadata);
  scheduleCleanup(run);
} 

function isUnavailableLocalCliModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\bunknown model(?: id)?\b|\bmodel(?: id)?\b[^\n]{0,120}\b(?:not found|not available|unavailable|unsupported|does not exist)\b/i.test(message);
}

export function localCliEventStartsWork(event: LocalCliEvent): boolean {
  return event.type !== "status" && event.type !== "error";
}

export async function runWithLocalCliModelFallback<T>(
  selectedModel: string | undefined,
  run: (model: string | undefined) => Promise<T>,
  options: {
    canFallback?: () => boolean;
    onFallback?: (rejectedModel: string) => void;
  } = {},
): Promise<T> {
  try {
    return await run(selectedModel);
  } catch (error) {
    if (
      !selectedModel ||
      !isUnavailableLocalCliModelError(error) ||
      options.canFallback?.() === false
    ) throw error;
    options.onFallback?.(selectedModel);
    return run(undefined);
  }
}

function normalizeRunRequest(body: SidecarRunRequest): SidecarRunRequest {
  if (!body || typeof body !== "object") throw new Error("run body is required");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
  if (body.sourceless) return body;
  if (!body.source && !Array.isArray(body.sources)) throw new Error("source or sources is required");
  return body;
}

async function prepareSidecarRun(request: SidecarRunRequest): Promise<PreparedRun> {
  if (request.sourceless && !request.source && !(Array.isArray(request.sources) && request.sources.length)) {
    // Sourceless / chat mode: no repository clone. Run the agent in an empty scratch
    // directory so binaries that need a CWD (e.g. Claude -p, Grok ACP) still start cleanly.
    const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_RUN_PREFIX}chat-`));
    return {
      cwd: root,
      diffCwd: root,
      context: [
        "# Workspace",
        "The current working directory is an empty scratch directory with no repository.",
        "Answer using only the user task below. Do not attempt to read project files.",
      ].join("\n"),
      cleanup: async () => {
        rmSync(root, { recursive: true, force: true });
      },
    };
  }
  if (Array.isArray(request.sources) && request.sources.length) {
    const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_RUN_PREFIX}workspace-`));
    const workspace = await loadSidecarWorkspace(request.sources, request.branch ?? null, root);
    const primary = workspace.repos[0];
    return {
      cwd: root,
      diffCwd: primary?.repoPath || root,
      context: [
	        "# Workspace",
	        "The current working directory is a prepared workspace with these repository folders:",
	        ...workspace.repos.map((repo) => `- \`${repo.id}/\` — ${repo.source}${repo.sourcePath ? ` (scope: ${repo.sourcePath})` : ""}`),
	        primary ? `Primary repository: \`${primary.id}/\`` : "",
      ].join("\n"),
      cleanup: async () => {
        await workspace.cleanupAll();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }
  const source = request.source || "";
  const parsedPR = parsePRURL(source);
  if (parsedPR) {
    const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_RUN_PREFIX}workspace-`));
    return loadPRWorkingTree(source, parsedPR, request.branch ?? null, undefined, { tmpDir: root });
  }
  const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_RUN_PREFIX}workspace-`));
  const loaded = await loadSidecarSource(source, request.branch ?? null, request.sourcePath ?? null, join(root, "repo"));
  return {
    cwd: loaded.repoPath,
    context: [
      "# Workspace",
      `The current working directory is the prepared repository checkout for ${source}.`,
      loaded.sourcePath ? `Only inspect and document the scoped repository path \`${loaded.sourcePath}\`.` : "",
    ].filter(Boolean).join("\n"),
    cleanup: async () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function normalizeTerminalWorkspaceRequest(body: TerminalWorkspaceRequest): Required<TerminalWorkspaceRequest> {
  if (!body || typeof body !== "object") throw new Error("terminal workspace body is required");
  const source = String(body.source || "").trim();
  if (!source) throw new Error("source is required");
  return {
    source,
    branch: typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null,
    sourcePath: typeof body.sourcePath === "string" && body.sourcePath.trim() ? body.sourcePath.trim() : null,
  };
}

async function createTerminalWorkspace(body: TerminalWorkspaceRequest): Promise<{
  id: string;
  source: string;
  cwd: string;
  diffCwd?: string;
  root: string;
  sourcePath?: string | null;
  context: string;
}> {
  const request = normalizeTerminalWorkspaceRequest(body);
  const id = `terminal-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_TERMINAL_PREFIX}workspace-`));
  try {
    const parsedPR = parsePRURL(request.source);
    const prepared = parsedPR
      ? await loadPRWorkingTree(request.source, parsedPR, request.branch, undefined, { tmpDir: root })
      : await prepareTerminalSourceWorkspace(request, root);
    const record: TerminalWorkspaceRecord = {
      id,
      source: request.source,
      cwd: prepared.cwd,
      diffCwd: prepared.diffCwd,
      root,
      sourcePath: request.sourcePath,
      context: prepared.context,
      cleanup: prepared.cleanup,
    };
    terminalWorkspaces.set(id, record);
    return {
      id,
      source: record.source,
      cwd: record.cwd,
      diffCwd: record.diffCwd,
      root: record.root,
      sourcePath: record.sourcePath,
      context: record.context,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function prepareTerminalSourceWorkspace(
  request: Required<TerminalWorkspaceRequest>,
  root: string,
): Promise<PreparedRun> {
  const loaded = await loadSidecarSource(request.source, request.branch, request.sourcePath, join(root, "repo"));
  return {
    cwd: loaded.repoPath,
    diffCwd: loaded.repoPath,
    context: [
      "# Terminal Workspace",
      `The current working directory is the prepared repository checkout for ${request.source}.`,
      loaded.sourcePath ? `The selected scope path is \`${loaded.sourcePath}\`.` : "",
    ].filter(Boolean).join("\n"),
    cleanup: async () => {
      await loaded.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function releaseTerminalWorkspace(id: string): Promise<boolean> {
  const workspace = terminalWorkspaces.get(id);
  if (!workspace) return false;
  terminalWorkspaces.delete(id);
  await workspace.cleanup();
  return true;
}

async function loadSidecarSource(
  source: string,
  branch: string | null,
  sourcePath: string | null,
  targetDir: string,
): Promise<{ repoPath: string; sourcePath?: string | null; cleanup: () => Promise<void>; cached: boolean }> {
  if (isGitHubSource(source)) {
    const cached = await loadSource(source, { branch, sourcePath, cache: true });
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    cloneLocalRepository(cached.checkoutPath || cached.repoPath, targetDir);
    return {
      repoPath: cached.sourcePath ? join(targetDir, cached.sourcePath) : targetDir,
      sourcePath: cached.sourcePath,
      cleanup: async () => {},
      cached: cached.cached,
    };
  }
  return loadSource(source, { branch, sourcePath, tmpDir: targetDir, cache: false });
}

async function loadSidecarWorkspace(
  sources: Array<string | SourceSpec>,
  branch: string | null,
  root: string,
): Promise<Awaited<ReturnType<typeof loadWorkspace>>> {
  if (!sources.length) throw new Error("loadWorkspace: at least one source is required");
  const used = new Set<string>();
  const repos = await Promise.all(sources.map(async (raw) => {
    const spec = typeof raw === "string" ? { source: raw } : raw;
    const id = uniqueSidecarRepoId(spec.id || deriveSidecarRepoId(spec.source), used);
    const loaded = await loadSidecarSource(spec.source, spec.branch ?? branch, spec.sourcePath ?? null, join(root, id));
    return {
      id,
      label: spec.label || id,
      source: spec.source,
      repoPath: loaded.repoPath,
      sourcePath: loaded.sourcePath,
      cleanup: loaded.cleanup,
      cached: loaded.cached,
    };
  }));
  return {
    repos,
    cleanupAll: async () => {
      await Promise.allSettled(repos.map((repo) => repo.cleanup()));
    },
  };
}

function isGitHubSource(value: string): boolean {
  return /^https?:\/\/(?:www\.)?github\.com\//.test(value) || /^git@github\.com:/.test(value);
}

function cloneLocalRepository(sourcePath: string, targetDir: string): void {
  const args = ["clone", "--shared", "--quiet", sourcePath, targetDir];
  const proc = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return;

  const fallback = Bun.spawnSync(["git", "clone", "--depth", "1", sourcePath, targetDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (fallback.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const fallbackStderr = new TextDecoder().decode(fallback.stderr).trim();
    const fallbackStdout = new TextDecoder().decode(fallback.stdout).trim();
    throw new Error(`git clone from cache failed: ${fallbackStderr || fallbackStdout || stderr || stdout}`);
  }
}

function deriveSidecarRepoId(source: string): string {
  const clean = source.replace(/\/+$/, "").replace(/\.git$/, "");
  return (clean.split("/").pop() || "repo").toLowerCase().replace(/[^a-z0-9-]/g, "") || "repo";
}

function uniqueSidecarRepoId(base: string, used: Set<string>): string {
  const cleanBase = base.toLowerCase().replace(/[^a-z0-9-]/g, "") || "repo";
  let id = cleanBase;
  let suffix = 2;
  while (used.has(id)) id = `${cleanBase}-${suffix++}`;
  used.add(id);
  return id;
}

export function buildLocalCliPrompt(args: { prompt: string; context: string; agentName: string; skillsContext: string }): string {
  return [
    "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.",
    "# Tool call notes",
    "Parallelize tool calls whenever possible. Especially file reads, such as `cat`, `rg`, `sed`, `ls`, `git show`, `nl`, `wc`. Use the `batch` tool for independent parallel tool calls.",
    "Prefer non-interactive commands. If you run an interactive command, the command may hang waiting for interactive input, which you cannot provide. Avoid this situation.",
    "Utilize sub-agents to map-reduce complex tasks, especially for multi-repositories tasks.",
    "When the user asks you to spawn, use, or delegate to sub-agents, call the runtime's real sub-agent/delegation tool if one is available. If no such tool is available, say so briefly and use parallel reads/searches instead. Do not claim sub-agents ran, do not call sections `Sub-agent`, and do not describe work as simulated sub-agents unless a real sub-agent tool actually ran.",
    args.context,
    args.skillsContext ? `# Loaded Skills\n${args.skillsContext}` : "",
    "# User Task",
    args.prompt,
  ].filter((section) => section.trim()).join("\n\n");
}

function materializeScreenshots(cwd: string, screenshots: CodeScreenshotAttachment[]): PreparedScreenshot[] {
  if (!screenshots.length) return [];
  const dir = join(cwd, ".rlm-wiki-screenshots");
  mkdirSync(dir, { recursive: true });
  return screenshots.map((screenshot, index) => {
    const ext = screenshot.mimeType === "image/jpeg" ? "jpg" : screenshot.mimeType === "image/webp" ? "webp" : "png";
    const safeName = (screenshot.name || `screenshot-${index + 1}.${ext}`)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || `screenshot-${index + 1}.${ext}`;
    const path = join(dir, safeName.includes(".") ? safeName : `${safeName}.${ext}`);
    writeFileSync(path, Buffer.from(screenshot.data, "base64"));
    return { path, name: safeName, mimeType: screenshot.mimeType };
  });
}

function screenshotsPrompt(screenshots: PreparedScreenshot[], agentId: LocalCliAgentId): string {
  if (!screenshots.length) return "";
  const rows = screenshots.map((screenshot, index) => `- Screenshot ${index + 1}: ${screenshot.path} (${screenshot.mimeType})`).join("\n");
  const agentLine = agentId === "codex"
    ? "These screenshots are also attached to the initial Codex prompt through `--image`."
    : agentId === "pi-codex" || agentId === "pi-claude"
    ? "Use Pi's local file reading capability to inspect these screenshot files before answering."
    : agentId === "claude"
    ? "Use Claude Code's file/image reading capability to inspect these screenshot files before editing."
    : agentId === "antigravity"
    ? "Use Antigravity CLI's local file reading capability to inspect these screenshot files before editing."
    : "Use Grok CLI's local file reading capability to inspect these screenshot files before editing.";
  return [
    "# Screenshot Context",
    "The user attached screenshot evidence for this coding task.",
    rows,
    agentLine,
    "Treat screenshots as visual evidence. Do not invent hidden requirements; verify code before editing.",
  ].join("\n");
}

function resolveAcpServerBinary(agentId: LocalCliAgentId): string | null {
  const pref = acpTransportPreference();
  if (pref === "off") return null;
  const adapter = acpAdapterFor(agentId);
  if (!adapter.acpCapable || !adapter.binCandidates.length) return null;
  for (const name of adapter.binCandidates) {
    // Reuse local CLI PATH search roots so desktop-managed bins are visible.
    for (const dir of localCliSearchPath()) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    // which via common absolute-ish path
    try {
      const which = Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "ignore" });
      if (which.exitCode === 0) {
        const path = which.stdout.toString().trim();
        if (path && existsSync(path)) return path;
      }
    } catch {
      // ignore
    }
  }
  // Grok's primary binary already speaks ACP stdio via `grok agent … stdio`.
  if (agentId === "grok") return null; // handled by runGrokWithBestAvailableMode
  return pref === "force" ? null : null;
}

async function runAdapter(args: {
  run: SidecarRunRecord;
  agentId: LocalCliAgentId;
  binPath: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  screenshots?: PreparedScreenshot[];
  contextLabel?: string;
  readOnly?: boolean;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
  onEvent: (event: LocalCliEvent) => void;
}): Promise<void> {
  if (args.agentId === "grok") {
    await runGrokWithBestAvailableMode(args);
    return;
  }
  if (args.agentId === "antigravity") {
    await runAntigravityPrint(args);
    return;
  }
  if (args.agentId === "pi-codex" || args.agentId === "pi-claude") {
    await runPiJson({
      ...args,
      agentId: args.agentId,
      contextLabel: args.contextLabel,
    });
    return;
  }

  // Prefer dedicated ACP servers for Claude/Codex when installed (Agentrove model).
  const acpBin = resolveAcpServerBinary(args.agentId);
  if (acpBin && (args.agentId === "claude" || args.agentId === "codex")) {
    const adapter = acpAdapterFor(args.agentId);
    args.phase?.("acp", `Using ACP server ${acpBin}.`);
    await runAcpStdioSession({
      run: args.run,
      binPath: acpBin,
      commandArgs: adapter.args({
        model: args.model,
        reasoning: args.reasoning,
        cwd: args.cwd,
      }),
      agentKind: adapter.agentKind,
      agentLabel: adapter.agentId === "claude" ? "Claude ACP" : "Codex ACP",
      cwd: args.cwd,
      prompt: args.prompt,
      model: args.model,
      onEvent: args.onEvent,
      phase: args.phase,
      autoApprovePermissions: adapter.autoApprovePermissions,
    });
    return;
  }

  const commandArgs = args.agentId === "claude"
    ? claudeArgs(args.model)
    : codexArgs(args.cwd, args.model, args.reasoning, args.screenshots, {
        readOnly: args.readOnly,
        contextLabel: args.contextLabel,
      });
  const command = formatCommandForDisplay(args.binPath, commandArgs);
  const proc = Bun.spawn([args.binPath, ...commandArgs], {
    cwd: args.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
  });
  args.phase?.("spawned", `${localCliAgentName(args.agentId)} process spawned.`);
  const abort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  args.run.controller.signal.addEventListener("abort", abort, { once: true });

  let stderrText = "";
  let lastDiagnostic = "";
  const stderrPromise = readTextLines(proc.stderr, (line) => {
    stderrText += `${line}\n`;
    lastDiagnostic = compactStatusLine(line) || lastDiagnostic;
    if (isUsefulCliStderrLine(line)) {
      args.onEvent({
        type: "status",
        label: "stderr",
        phase: "stderr",
        message: compactStatusLine(line),
      });
    }
  });
  const parserState = args.agentId === "claude" ? createClaudeParserState() : createCodexParserState();
  let firstJson = true;
  const stdoutPromise = readJsonLines(proc.stdout, (json) => {
    if (firstJson) {
      firstJson = false;
      args.phase?.("first-json", `${localCliAgentName(args.agentId)} emitted its first event.`);
    }
    const events = args.agentId === "claude"
      ? claudeJsonToEvents(json, parserState as ReturnType<typeof createClaudeParserState>)
      : codexJsonToEvents(json, parserState as ReturnType<typeof createCodexParserState>);
    events.forEach((event) => {
      if (event.type === "status") lastDiagnostic = compactStatusLine(event.message || "") || lastDiagnostic;
      args.onEvent(event);
    });
  });
  await writeStdin(proc.stdin, args.prompt);
  args.phase?.("prompt-sent", `Prompt sent to ${localCliAgentName(args.agentId)}.`);
  await stdoutPromise;
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  args.run.controller.signal.removeEventListener("abort", abort);
  if (args.run.controller.signal.aborted) {
    args.run.status = "canceled";
    throw new DOMException("Canceled by caller.", "AbortError");
  }
  if (exitCode !== 0) {
    throw new Error(localCliExitErrorMessage({
      agentName: localCliAgentName(args.agentId),
      exitCode,
      stderr: stderr || stderrText,
      lastDiagnostic,
      command,
      cwd: args.cwd,
    }));
  }
}

type LocalCliAdapterRun = {
  controller: AbortController;
  status?: "queued" | "running" | "done" | "error" | "canceled";
};

async function runPiJson(args: {
  run: LocalCliAdapterRun;
  agentId: Extract<LocalCliAgentId, "pi-codex" | "pi-claude">;
  binPath: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  contextLabel?: string;
  onEvent: (event: LocalCliEvent) => void;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
}): Promise<void> {
  const contextLabel = String(args.contextLabel || "");
  if (!isPiSupportedContext(contextLabel)) {
    throw new Error(`${piAgentLabel(args.agentId)} is currently enabled only for Ask, Wiki generation, and Wiki Slides.`);
  }

  const promptEchoFilter = createPromptEchoFilter(args.prompt);
  const commandArgs = [
    ...piAgentArgs(args.agentId, args.model, args.reasoning, contextLabel),
    args.prompt,
  ];
  const command = formatCommandForDisplay(args.binPath, commandArgs);
  const proc = Bun.spawn([args.binPath, ...commandArgs], {
    cwd: args.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: piAgentEnv(),
  });
  args.phase?.("spawned", `${piAgentLabel(args.agentId)} process spawned.`);
  const abort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  args.run.controller.signal.addEventListener("abort", abort, { once: true });

  let stderrText = "";
  let lastDiagnostic = "";
  const stderrPromise = readTextLines(proc.stderr, (line) => {
    stderrText += `${line}\n`;
    lastDiagnostic = compactStatusLine(line) || lastDiagnostic;
    if (isUsefulCliStderrLine(line)) {
      args.onEvent({
        type: "status",
        label: "stderr",
        phase: "stderr",
        message: compactStatusLine(line),
      });
    }
  });
  const parserState = createPiParserState();
  let firstJson = true;
  const stdoutPromise = readJsonLines(proc.stdout, (json) => {
    if (firstJson) {
      firstJson = false;
      args.phase?.("first-json", `${piAgentLabel(args.agentId)} emitted its first event.`);
    }
    piJsonToEvents(json, parserState).forEach((event) => {
      if (event.type === "status") lastDiagnostic = compactStatusLine(event.message || "") || lastDiagnostic;
      if (event.type === "text_delta") {
        const text = promptEchoFilter.push(event.text);
        if (text) args.onEvent({ ...event, text });
        return;
      }
      args.onEvent(event);
    });
  });

  args.phase?.("prompt-sent", `Prompt sent to ${piAgentLabel(args.agentId)}.`);
  await stdoutPromise;
  const pendingText = promptEchoFilter.flush();
  if (pendingText) args.onEvent({ type: "text_delta", text: pendingText });
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  args.run.controller.signal.removeEventListener("abort", abort);
  if (args.run.controller.signal.aborted) {
    args.run.status = "canceled";
    throw new DOMException("Canceled by caller.", "AbortError");
  }
  if (exitCode !== 0) {
    throw new Error(localCliExitErrorMessage({
      agentName: piAgentLabel(args.agentId),
      exitCode,
      stderr: stderr || stderrText,
      lastDiagnostic,
      command,
      cwd: args.cwd,
    }));
  }
}

export async function runAntigravityPrint(args: {
  run: LocalCliAdapterRun;
  binPath: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  quietTimeoutMs?: number;
  onEvent: (event: LocalCliEvent) => void;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
}): Promise<void> {
  const promptFileName = `.grok-wiki-antigravity-prompt-${randomBytes(4).toString("hex")}.md`;
  const promptPath = join(args.cwd, promptFileName);
  writeFileSync(promptPath, args.prompt, "utf8");
  const commandArgs = antigravityArgs({
    promptPath,
    workspaceDir: args.cwd,
    timeoutMs: args.timeoutMs ?? LOCAL_CLI_PROMPT_TIMEOUT_MS,
  });
  const command = formatCommandForDisplay(args.binPath, commandArgs);
  const proc = Bun.spawn([args.binPath, ...commandArgs], {
    cwd: args.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
  });
  args.phase?.("spawned", "Antigravity CLI process spawned.");
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let outputChunks = 0;
  let lastDiagnostic = "";
  let quietTimedOut = false;
  const statusHeartbeatMs = Math.max(1, args.heartbeatMs ?? ANTIGRAVITY_STATUS_HEARTBEAT_MS);
  const quietTimeoutMs = Math.max(1, args.quietTimeoutMs ?? ANTIGRAVITY_QUIET_TIMEOUT_MS);
  const emitQuietStatus = (message: string): void => {
    lastDiagnostic = compactStatusLine(message) || lastDiagnostic;
    args.onEvent({
      type: "status",
      label: "antigravity",
      phase: "antigravity-print",
      message,
      durationMs: Date.now() - startedAt,
    });
  };
  emitQuietStatus("Antigravity CLI is running in print mode. It can be quiet until the final answer.");
  const heartbeat = setInterval(() => {
    if (args.run.controller.signal.aborted) return;
    const quietFor = formatDuration(Date.now() - lastOutputAt);
    emitQuietStatus(outputChunks
      ? `Antigravity CLI is still running. Last output was ${quietFor} ago.`
      : `Antigravity CLI is still running. No output yet after ${quietFor}.`);
  }, statusHeartbeatMs);
  heartbeat.unref?.();
  const abort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  args.run.controller.signal.addEventListener("abort", abort, { once: true });
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const resetQuietTimer = (): void => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (args.run.controller.signal.aborted) return;
      quietTimedOut = true;
      emitQuietStatus(
        outputChunks
          ? `Antigravity CLI produced no new output for ${formatDuration(quietTimeoutMs)}. Stopping this run.`
          : `Antigravity CLI produced no output for ${formatDuration(quietTimeoutMs)}. Stopping this run.`,
      );
      abort();
    }, quietTimeoutMs);
    quietTimer.unref?.();
  };
  resetQuietTimer();

  let stderrText = "";
  const stderrPromise = readTextLines(proc.stderr, (line) => {
    stderrText += `${line}\n`;
    lastOutputAt = Date.now();
    outputChunks++;
    resetQuietTimer();
    lastDiagnostic = compactStatusLine(line) || lastDiagnostic;
    if (isUsefulCliStderrLine(line)) {
      args.onEvent({
        type: "status",
        label: "stderr",
        phase: "stderr",
        message: compactStatusLine(line),
      });
    }
  });
  try {
    args.phase?.("prompt-sent", "Prompt sent to Antigravity CLI.");
    const stdoutText = await readTextChunks(proc.stdout, (chunk) => {
      lastOutputAt = Date.now();
      outputChunks++;
      resetQuietTimer();
      lastDiagnostic = compactStatusLine(chunk) || lastDiagnostic;
      args.onEvent({ type: "text_delta", text: chunk });
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
    if (args.run.controller.signal.aborted) {
      args.run.status = "canceled";
      throw new DOMException("Canceled by caller.", "AbortError");
    }
    if (quietTimedOut) {
      throw new Error(localCliQuietTimeoutMessage({
        agentName: "Antigravity CLI",
        quietTimeoutMs,
        hadOutput: outputChunks > 0,
        lastDiagnostic,
        command,
        cwd: args.cwd,
      }));
    }
    if (exitCode !== 0) {
      throw new Error(
        `${localCliExitErrorMessage({
          agentName: "Antigravity CLI",
          exitCode,
          stderr: stderr || stderrText,
          lastDiagnostic,
          command,
          cwd: args.cwd,
        })}\nInstall Antigravity CLI with \`curl -fsSL https://antigravity.google/cli/install.sh | bash\`, then run \`agy\` once and complete Google Sign-In if prompted.`,
      );
    }
    const finalStdout = stdoutText.trim();
    if (/^Error:\s*timed out waiting for response\b/i.test(finalStdout)) {
      throw new Error("Antigravity CLI timed out waiting for a print-mode response.");
    }
    if (!finalStdout) {
      const detail = compactStatusLine(stderr.trim() || stderrText.trim() || lastDiagnostic);
      throw new Error(
        `Antigravity CLI exited without a print-mode answer.${detail ? ` Last diagnostic: ${detail}` : ` Command: ${command}`}`,
      );
    }
  } finally {
    clearInterval(heartbeat);
    if (quietTimer) clearTimeout(quietTimer);
    args.run.controller.signal.removeEventListener("abort", abort);
    rmSync(promptPath, { force: true });
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function shouldUseGrokHeadless(contextLabel?: string): boolean {
  return /^wiki-(?:structure|page)$/.test(String(contextLabel || ""));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

export function shouldFallbackFromGrokAcpError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(?:grok|initialize|authenticate|session\/new|prompt|stdio|exited|timed out)\b/i.test(message);
}

async function runGrokWithBestAvailableMode(args: {
  run: SidecarRunRecord;
  binPath: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  contextLabel?: string;
  onEvent: (event: LocalCliEvent) => void;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
}): Promise<void> {
  if (shouldUseGrokHeadless(args.contextLabel)) {
    await runGrokHeadless(args);
    return;
  }
  try {
    await runGrokAcp(args);
  } catch (error) {
    if (!shouldFallbackFromGrokAcpError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error || "");
    args.phase?.("grok-headless-fallback", "Grok CLI ACP failed; retrying with headless streaming mode.", {
      agentId: "grok",
    });
    args.onEvent({
      type: "status",
      label: "grok-headless-fallback",
      phase: "grok-headless-fallback",
      message: detail ? `Retrying Grok CLI in headless mode after ACP failed: ${detail}` : "Retrying Grok CLI in headless mode after ACP failed.",
      agentId: "grok",
    });
    await runGrokHeadless(args);
  }
}

async function runGrokHeadless(args: {
  run: SidecarRunRecord;
  binPath: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  onEvent: (event: LocalCliEvent) => void;
}): Promise<void> {
  const promptPath = join(args.cwd, `.grok-wiki-grok-prompt-${randomBytes(4).toString("hex")}.md`);
  writeFileSync(promptPath, args.prompt, "utf8");
  const commandArgs = grokHeadlessArgs({
    cwd: args.cwd,
    promptPath,
    model: args.model,
    reasoning: args.reasoning,
  });
  const command = formatCommandForDisplay(args.binPath, commandArgs);
  const proc = Bun.spawn([args.binPath, ...commandArgs], {
    cwd: args.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
  });
  const abort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  args.run.controller.signal.addEventListener("abort", abort, { once: true });
  const stderrPromise = new Response(proc.stderr).text();
  let grokSessionId = "";
  let lastDiagnostic = "";
  try {
    await readJsonLines(proc.stdout, (json) => {
      const event = jsonRecord(json);
      if (stringField(event.type) === "end") {
        grokSessionId = stringField(event.sessionId ?? event.session_id);
      }
      grokJsonToEvents(json).forEach((localEvent) => {
        if (localEvent.type === "status") lastDiagnostic = compactStatusLine(localEvent.message || "") || lastDiagnostic;
        args.onEvent(localEvent);
      });
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
    if (args.run.controller.signal.aborted) {
      args.run.status = "canceled";
      throw new DOMException("Canceled by caller.", "AbortError");
    }
    if (exitCode !== 0) {
      throw new Error(localCliExitErrorMessage({
        agentName: "Grok CLI",
        exitCode,
        stderr,
        lastDiagnostic,
        command,
        cwd: args.cwd,
      }));
    }
    if (grokSessionId) emitGrokTraceToolEvents(args.binPath, args.cwd, grokSessionId, args.onEvent);
  } finally {
    args.run.controller.signal.removeEventListener("abort", abort);
    rmSync(promptPath, { force: true });
  }
}

function emitGrokTraceToolEvents(
  binPath: string,
  cwd: string,
  sessionId: string,
  onEvent: (event: LocalCliEvent) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), `${LOCAL_CLI_RUN_PREFIX}grok-trace-`));
  const archivePath = join(root, "trace.tar.gz");
  try {
    const trace = Bun.spawnSync(
      [binPath, "trace", "--local", "--json", "-o", archivePath, sessionId],
      { cwd, stdout: "pipe", stderr: "pipe", env: localCliAgentEnv() },
    );
    if (trace.exitCode !== 0 || !existsSync(archivePath)) return;
    const extract = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (extract.exitCode !== 0) return;
    const updatesPath = join(root, sessionId, "updates.jsonl");
    if (!existsSync(updatesPath)) return;
    grokTraceUpdatesToEvents(readFileSync(updatesPath, "utf8")).forEach(onEvent);
  } catch {
    // Trace export is best-effort; the live answer stream should not fail if it is unavailable.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function grokTraceUpdatesToEvents(updatesJsonl: string): LocalCliEvent[] {
  const events: LocalCliEvent[] = [];
  const parserState = createAcpParserState("grok");
  for (const line of updatesJsonl.split(/\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = jsonRecord(JSON.parse(line));
    } catch {
      continue;
    }
    for (const event of acpJsonToEvents(record, parserState)) {
      if (event.type === "status") continue;
      if (event.type === "tool_result") {
        const params = jsonRecord(record.params);
        const update = jsonRecord(params.update ?? params);
        events.push({
          ...event,
          output: summarizeGrokToolOutput(update.rawOutput ?? update.output ?? update.content),
        });
        continue;
      }
      events.push(event);
    }
  }
  return events;
}

function summarizeGrokToolOutput(value: unknown): string {
  const output = jsonRecord(value);
  const content = jsonRecord(output.Content ?? output.content);
  const text =
    stringField(content.content) ||
    stringField(output.raw_output) ||
    stringField(output.output) ||
    stringField(value);
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}

interface AcpTerminalRecord {
  proc: ReturnType<typeof Bun.spawn>;
  output: string;
  outputByteLimit: number;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

async function runGrokAcp(args: {
  run: SidecarRunRecord;
  binPath: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  onEvent: (event: LocalCliEvent) => void;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
}): Promise<void> {
  await runAcpStdioSession({
    run: args.run,
    binPath: args.binPath,
    commandArgs: grokAgentArgs(args.model, args.reasoning),
    agentKind: "grok",
    agentLabel: "Grok CLI",
    cwd: args.cwd,
    prompt: args.prompt,
    model: args.model,
    onEvent: args.onEvent,
    phase: args.phase,
    autoApprovePermissions: true,
    afterPrompt: (sessionId) => {
      if (sessionId) emitGrokTraceToolEvents(args.binPath, args.cwd, sessionId, args.onEvent);
    },
    authenticate: true,
  });
}

/**
 * Generalized ACP stdio host (Agentrove AcpSession.create + prompt loop).
 * Speaks initialize → optional authenticate → session/new → session/prompt,
 * maps session/update through the stateful event mapper, auto-approves
 * permissions for desktop Ask v1, and implements fs/terminal client methods
 * against the prepared workspace (agents still own most I/O).
 */
async function runAcpStdioSession(args: {
  run: SidecarRunRecord;
  binPath: string;
  commandArgs: string[];
  agentKind: import("./acp/event-mapper.ts").AcpAgentKind;
  agentLabel: string;
  cwd: string;
  prompt: string;
  model?: string;
  onEvent: (event: LocalCliEvent) => void;
  phase?: (label: string, message: string, extra?: Partial<Extract<LocalCliEvent, { type: "status" }>>) => void;
  autoApprovePermissions?: boolean;
  authenticate?: boolean;
  afterPrompt?: (sessionId: string) => void;
}): Promise<void> {
  const command = formatCommandForDisplay(args.binPath, args.commandArgs);
  const proc = Bun.spawn([args.binPath, ...args.commandArgs], {
    cwd: args.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
  });
  args.phase?.("spawned", `${args.agentLabel} ACP process spawned.`);
  let nextId = 1;
  let promptCompleted = false;
  let lastAcpStreamAt = 0;
  let acpSessionId = "";
  let lastDiagnostic = "";
  const acpParserState = createAcpParserState(args.agentKind);
  // Grok ACP often echoes the full local-cli prompt as assistant text_delta.
  // Strip it the same way Pi does so the answer surface stays user-facing.
  const promptEchoFilter = createPromptEchoFilter(args.prompt);
  const emitAcpEvent = (event: LocalCliEvent): void => {
    if (event.type === "status") lastDiagnostic = compactStatusLine(event.message || "") || lastDiagnostic;
    // Any streamed model content resets the settle clock (not only session/update).
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      lastAcpStreamAt = Date.now();
    }
    if (event.type === "text_delta") {
      const text = promptEchoFilter.push(event.text);
      if (text) args.onEvent({ ...event, text });
      return;
    }
    args.onEvent(event);
  };
  const terminals = new Map<string, AcpTerminalRecord>();
  const pending = new Map<number, {
    method: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const rejectPending = (error: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };
  const sendResponse = async (id: unknown, result: unknown): Promise<void> => {
    await writeSink(proc.stdin, JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };
  const sendError = async (id: unknown, message: string, code = -32603): Promise<void> => {
    await writeSink(proc.stdin, JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  };
  const request = async (method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const promise = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`${args.agentLabel} ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
    });
    try {
      await writeSink(proc.stdin, JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
      throw error;
    }
    return promise;
  };
  const abort = () => {
    rejectPending(new DOMException("Canceled by caller.", "AbortError") as unknown as Error);
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  args.run.controller.signal.addEventListener("abort", abort, { once: true });

  const stderrPromise = new Response(proc.stderr).text();
  const stdoutPromise = readJsonLines(proc.stdout, async (json) => {
    const msg = jsonRecord(json);
    if (stringField(msg.method)) {
      if (stringField(msg.method) === "session/update") lastAcpStreamAt = Date.now();
      await handleGrokAcpClientRequest({
        msg,
        cwd: args.cwd,
        terminals,
        sendResponse,
        sendError,
        autoApprovePermissions: args.autoApprovePermissions !== false,
      });
      acpJsonToEvents(json, acpParserState).forEach((event) => emitAcpEvent(event));
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : null;
    if (id !== null && pending.has(id)) {
      const entry = pending.get(id)!;
      clearTimeout(entry.timer);
      pending.delete(id);
      if (msg.error) {
        const error = jsonRecord(msg.error);
        entry.reject(new Error(stringField(error.message) || `${args.agentLabel} ${entry.method} failed`));
      } else {
        entry.resolve(jsonRecord(msg.result));
      }
      return;
    }

    acpJsonToEvents(json, acpParserState).forEach((event) => emitAcpEvent(event));
  });
  const exitWatcher = proc.exited.then((exitCode) => {
    if (!promptCompleted && !args.run.controller.signal.aborted) {
      rejectPending(new Error(`${args.agentLabel} exited before completing the prompt (exit ${exitCode}).`));
    }
  });

  try {
    args.phase?.("acp-initialize", `Initializing ${args.agentLabel} session.`);
    const init = await request("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }, 90_000);
    if (args.authenticate !== false) {
      const authMethods = arrayField(init.authMethods)
        .map((method) => stringField(jsonRecord(method).id))
        .filter(Boolean);
      // Grok-specific auth selection; other ACP servers may have empty authMethods.
      if (args.agentKind === "grok") {
        const methodId = process.env.GROK_CODE_XAI_API_KEY && authMethods.includes("xai.api_key")
          ? "xai.api_key"
          : authMethods.includes("cached_token")
          ? "cached_token"
          : "";
        if (authMethods.length && !methodId) {
          throw new Error("Run `grok` locally to authenticate, or set GROK_CODE_XAI_API_KEY.");
        }
        if (methodId) {
          args.phase?.("acp-auth", `Authenticating ${args.agentLabel} session.`);
          await request("authenticate", { methodId, meta: { headless: true } }, 120_000);
        }
      }
    }
    args.phase?.("acp-session", `Creating ${args.agentLabel} workspace session.`);
    const session = await request("session/new", { cwd: resolve(args.cwd), mcpServers: [] }, 90_000);
    const sessionId = stringField(session.sessionId ?? session.session_id ?? session.id);
    if (!sessionId) throw new Error(`${args.agentLabel} session/new did not return a sessionId.`);
    acpSessionId = sessionId;
    if (args.model) {
      args.phase?.("acp-model", `Selecting ${args.agentLabel} model.`);
      await request("session/set_model", { sessionId, model: args.model }, 30_000).catch(() => {});
    }
    args.phase?.("prompt-sent", `Prompt sent to ${args.agentLabel}.`);
    await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: args.prompt }],
    }, LOCAL_CLI_PROMPT_TIMEOUT_MS);
    // Grok often keeps streaming text_delta after session/prompt resolves.
    // A short settle was killing the process mid-sentence (answers ending at
    // "checkpoints + w"). Wait for a real idle window before teardown.
    await waitForGrokAcpStreamSettle(() => lastAcpStreamAt);
    promptCompleted = true;
    // Flush held answer text BEFORE killing the child so the last holdBack
    // characters always reach the client.
    const pendingBeforeTeardown = promptEchoFilter.flush();
    if (pendingBeforeTeardown) args.onEvent({ type: "text_delta", text: pendingBeforeTeardown });
    args.afterPrompt?.(sessionId);
  } finally {
    args.run.controller.signal.removeEventListener("abort", abort);
    rejectPending(new Error(`${args.agentLabel} adapter stopped before completing pending requests.`));
    try {
      await proc.stdin.end();
    } catch {
      // stdin may already be closed
    }
    if (!args.run.controller.signal.aborted) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    cleanupAcpTerminals(terminals);
  }

  await stdoutPromise.catch(() => {});
  await exitWatcher.catch(() => {});
  // Second flush is a no-op if already flushed; keeps non-happy paths safe.
  const pendingText = promptEchoFilter.flush();
  if (pendingText) args.onEvent({ type: "text_delta", text: pendingText });
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  if (args.run.controller.signal.aborted) {
    args.run.status = "canceled";
    throw new DOMException("Canceled by caller.", "AbortError");
  }
  if (!promptCompleted && exitCode !== 0) {
    throw new Error(localCliExitErrorMessage({
      agentName: args.agentLabel,
      exitCode,
      stderr,
      lastDiagnostic,
      command,
      cwd: args.cwd,
    }));
  }
  void acpSessionId;
}

async function waitForGrokAcpStreamSettle(lastStreamAt: () => number): Promise<void> {
  // After session/prompt returns, ACP agents (especially Grok) may still emit
  // assistant text for a while. Previously we only waited ~300ms idle / 2s max,
  // then SIGTERM'd the child — that chopped final answers mid-word.
  const idleSliceMs = 400;
  const requiredIdleSlices = 3; // ~1.2s of continuous quiet
  const maxWaitMs = Math.max(
    15_000,
    Number(process.env.GROK_WIKI_ACP_STREAM_SETTLE_MS || 45_000),
  );
  let stableChecks = 0;
  const started = Date.now();
  // If nothing has streamed yet, still give a brief window for late first bytes.
  if (!lastStreamAt()) {
    await new Promise((resolve) => setTimeout(resolve, idleSliceMs));
  }
  while (stableChecks < requiredIdleSlices && Date.now() - started < maxWaitMs) {
    const before = lastStreamAt();
    await new Promise((resolve) => setTimeout(resolve, idleSliceMs));
    stableChecks = lastStreamAt() === before ? stableChecks + 1 : 0;
  }
}

async function handleGrokAcpClientRequest(args: {
  msg: Record<string, unknown>;
  cwd: string;
  terminals: Map<string, AcpTerminalRecord>;
  sendResponse: (id: unknown, result: unknown) => Promise<void>;
  sendError: (id: unknown, message: string, code?: number) => Promise<void>;
  autoApprovePermissions?: boolean;
}): Promise<void> {
  const method = stringField(args.msg.method);
  const id = args.msg.id;
  if (method === "session/update" || id === undefined) return;
  try {
    const params = jsonRecord(args.msg.params);
    if (method === "session/request_permission") {
      // Desktop Ask v1: auto-approve (Agentrove blocks on UI; we keep non-blocking).
      if (args.autoApprovePermissions === false) {
        await args.sendResponse(id, { outcome: { outcome: "cancelled" } });
        return;
      }
      await args.sendResponse(id, { outcome: { outcome: "approve_for_session" } });
      return;
    }
    if (method === "fs/read_text_file") {
      await args.sendResponse(id, grokAcpReadTextFile(args.cwd, params));
      return;
    }
    if (method === "fs/write_text_file") {
      grokAcpWriteTextFile(args.cwd, params);
      await args.sendResponse(id, null);
      return;
    }
    if (method === "terminal/create") {
      await args.sendResponse(id, grokAcpCreateTerminal(args.cwd, params, args.terminals));
      return;
    }
    if (method === "terminal/output") {
      await args.sendResponse(id, grokAcpTerminalOutput(params, args.terminals));
      return;
    }
    if (method === "terminal/wait_for_exit") {
      await args.sendResponse(id, await grokAcpTerminalWaitForExit(params, args.terminals));
      return;
    }
    if (method === "terminal/kill") {
      grokAcpTerminalKill(params, args.terminals);
      await args.sendResponse(id, null);
      return;
    }
    if (method === "terminal/release") {
      grokAcpTerminalRelease(params, args.terminals);
      await args.sendResponse(id, null);
      return;
    }
    await args.sendError(id, `Unhandled client method ${method}`, -32601);
  } catch (error) {
    await args.sendError(id, error instanceof Error ? error.message : String(error));
  }
}

function grokAcpReadTextFile(cwd: string, params: Record<string, unknown>): { content: string } {
  const path = resolveWorkspacePath(cwd, params.path);
  const line = positiveInteger(params.line);
  const limit = positiveInteger(params.limit);
  let content = readFileSync(path, "utf8");
  if (line || limit) {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, (line || 1) - 1);
    const end = limit ? start + limit : lines.length;
    content = lines.slice(start, end).join("\n");
  }
  return { content };
}

function grokAcpWriteTextFile(cwd: string, params: Record<string, unknown>): void {
  const path = resolveWorkspacePath(cwd, params.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringField(params.content), "utf8");
}

function grokAcpCreateTerminal(
  cwd: string,
  params: Record<string, unknown>,
  terminals: Map<string, AcpTerminalRecord>,
): { terminalId: string } {
  const command = stringField(params.command).trim();
  if (!command) throw new Error("terminal/create requires command.");
  const commandArgs = arrayField(params.args).map(stringField).filter(Boolean);
  const terminalCwd = params.cwd ? resolveWorkspacePath(cwd, params.cwd) : resolve(cwd);
  const outputByteLimit = positiveInteger(params.outputByteLimit) || 1_048_576;
  const terminalId = `term-${randomBytes(6).toString("hex")}`;
  const record: AcpTerminalRecord = {
    proc: Bun.spawn(commandArgs.length ? [command, ...commandArgs] : ["/bin/bash", "-lc", command], {
      cwd: terminalCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: grokAcpTerminalEnv(params.env),
    }),
    output: "",
    outputByteLimit,
    truncated: false,
    exitStatus: null,
  };
  terminals.set(terminalId, record);
  captureAcpTerminalOutput(record.proc.stdout as ReadableStream<Uint8Array>, record);
  captureAcpTerminalOutput(record.proc.stderr as ReadableStream<Uint8Array>, record);
  record.proc.exited.then((exitCode) => {
    record.exitStatus = { exitCode, signal: null };
  }).catch(() => {
    record.exitStatus = { exitCode: null, signal: "error" };
  });
  return { terminalId };
}

function grokAcpTerminalOutput(
  params: Record<string, unknown>,
  terminals: Map<string, AcpTerminalRecord>,
): { output: string; truncated: boolean; exitStatus?: { exitCode: number | null; signal: string | null } } {
  const terminal = acpTerminal(params, terminals);
  return {
    output: terminal.output,
    truncated: terminal.truncated,
    ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
  };
}

async function grokAcpTerminalWaitForExit(
  params: Record<string, unknown>,
  terminals: Map<string, AcpTerminalRecord>,
): Promise<{ exitCode: number | null; signal: string | null }> {
  const terminal = acpTerminal(params, terminals);
  if (!terminal.exitStatus) {
    try {
      const exitCode = await terminal.proc.exited;
      terminal.exitStatus = { exitCode, signal: null };
    } catch {
      terminal.exitStatus = { exitCode: null, signal: "error" };
    }
  }
  return terminal.exitStatus;
}

function grokAcpTerminalKill(params: Record<string, unknown>, terminals: Map<string, AcpTerminalRecord>): void {
  const terminal = acpTerminal(params, terminals);
  try {
    terminal.proc.kill("SIGTERM");
  } catch {
    // already exited
  }
}

function grokAcpTerminalRelease(params: Record<string, unknown>, terminals: Map<string, AcpTerminalRecord>): void {
  const terminalId = stringField(params.terminalId ?? params.terminal_id);
  if (!terminalId) return;
  const terminal = terminals.get(terminalId);
  if (!terminal) return;
  if (!terminal.exitStatus) {
    try {
      terminal.proc.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
  terminals.delete(terminalId);
}

function cleanupAcpTerminals(terminals: Map<string, AcpTerminalRecord>): void {
  for (const terminal of terminals.values()) {
    if (!terminal.exitStatus) {
      try {
        terminal.proc.kill("SIGTERM");
      } catch {
        // already exited
      }
    }
  }
  terminals.clear();
}

function acpTerminal(
  params: Record<string, unknown>,
  terminals: Map<string, AcpTerminalRecord>,
): AcpTerminalRecord {
  const terminalId = stringField(params.terminalId ?? params.terminal_id);
  const terminal = terminalId ? terminals.get(terminalId) : null;
  if (!terminal) throw new Error(`Unknown terminal ${terminalId || "(missing)"}.`);
  return terminal;
}

function captureAcpTerminalOutput(stream: ReadableStream<Uint8Array>, record: AcpTerminalRecord): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        appendAcpTerminalOutput(record, decoder.decode(value, { stream: true }));
      }
      appendAcpTerminalOutput(record, decoder.decode());
    } catch {
      // Terminal output collection is best-effort.
    }
  })();
}

function appendAcpTerminalOutput(record: AcpTerminalRecord, chunk: string): void {
  if (!chunk) return;
  record.output += chunk;
  if (record.output.length > record.outputByteLimit) {
    record.output = record.output.slice(-record.outputByteLimit);
    record.truncated = true;
  }
}

function grokAcpTerminalEnv(value: unknown): NodeJS.ProcessEnv {
  const env = localCliAgentEnv();
  for (const item of arrayField(value)) {
    const entry = jsonRecord(item);
    const name = stringField(entry.name);
    if (!name || isProviderSecretEnvKey(name)) continue;
    env[name] = stringField(entry.value);
  }
  return env;
}

export function resolveWorkspacePath(cwd: string, value: unknown): string {
  const root = resolve(cwd);
  const path = resolve(root, stringField(value));
  const canonicalRoot = canonicalWorkspacePath(root);
  const canonicalPath = canonicalWorkspacePath(path);
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new Error(`Refusing to access path outside local CLI workspace: ${path}`);
  }
  return path;
}

function canonicalWorkspacePath(path: string): string {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    existing = parent;
  }
  return `${realpathSync(existing)}${path.slice(existing.length)}`;
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function grokAgentArgs(model?: string, reasoning?: string): string[] {
  const cliArgs = ["agent", "--always-approve"];
  if (model && model !== "default") cliArgs.push("--model", model);
  if (reasoning && reasoning !== "default") cliArgs.push("--reasoning-effort", reasoning);
  cliArgs.push("stdio");
  return cliArgs;
}

export function grokHeadlessArgs(args: { cwd: string; promptPath: string; model?: string; reasoning?: string }): string[] {
  const cliArgs = [
    "--cwd",
    args.cwd,
    "--output-format",
    "streaming-json",
    "--always-approve",
  ];
  if (args.model && args.model !== "default") cliArgs.push("--model", args.model);
  if (args.reasoning && args.reasoning !== "default") cliArgs.push("--reasoning-effort", args.reasoning);
  cliArgs.push("--prompt-file", args.promptPath);
  return cliArgs;
}

export function codexArgs(
  cwd: string,
  model?: string,
  reasoning?: string,
  screenshots: PreparedScreenshot[] = [],
  opts: { readOnly?: boolean; contextLabel?: string } = {},
): string[] {
  // Prefer shared policy context → sandbox mapping so Codex tracks the same
  // read-only set as Pi (ask/chat/wiki-slides).
  const readOnly =
    opts.contextLabel != null
      ? isLocalCliReadOnlyContext(opts.contextLabel)
      : !!opts.readOnly;
  const { sandbox, networkAccess } = codexSandboxForContext(
    opts.contextLabel ?? (readOnly ? "ask" : "wiki-page"),
  );
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    sandbox,
    "-C",
    cwd,
  ];
  // Network is required for live code-graph curl (same path as Grok/Claude/Pi bash).
  if (networkAccess && sandbox === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.network_access=true");
  }
  if (model) args.push("--model", model);
  for (const screenshot of screenshots) args.push("--image", screenshot.path);
  const effort = clampCodexReasoning(model, reasoning);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  return args;
}

function claudeArgs(model?: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (model) args.push("--model", model);
  return args;
}

export function antigravityArgs(args: { promptPath: string; workspaceDir: string; timeoutMs?: number }): string[] {
  return [
    "--add-dir",
    args.workspaceDir,
    "--sandbox",
    "--dangerously-skip-permissions",
    "--print-timeout",
    `${Math.max(1, Math.floor(args.timeoutMs ?? LOCAL_CLI_PROMPT_TIMEOUT_MS))}ms`,
    "--print",
    `Read ${args.promptPath} and complete the task exactly as written.`,
  ];
}

export function piCodexArgs(model?: string, reasoning?: string, contextLabel?: string): string[] {
  return piAgentArgs("pi-codex", model, reasoning, contextLabel);
}

export function piClaudeArgs(model?: string, reasoning?: string, contextLabel?: string): string[] {
  return piAgentArgs("pi-claude", model, reasoning, contextLabel);
}

function piAgentArgs(
  agentId: Extract<LocalCliAgentId, "pi-codex" | "pi-claude">,
  model?: string,
  reasoning?: string,
  contextLabel?: string,
): string[] {
  const selectedModel = model && model !== "default" ? model : piDefaultModelForAgent(agentId);
  // Shared policy: bash included so code-graph curl works for Pi the same as
  // Codex/Claude/Grok. edit/write only outside read-only contexts.
  const tools = piToolsForContext(contextLabel);
  const cliArgs = [
    "--mode",
    "json",
    "--print",
    "--provider",
    piProviderForAgent(agentId),
    "--model",
    selectedModel,
    "--no-session",
    "--tools",
    tools,
  ];
  const explicitReasoning = reasoning && reasoning !== "default" ? reasoning : "";
  const defaultReasoning =
    agentId === "pi-claude" && !piModelHasThinkingSuffix(selectedModel)
      ? "high"
      : "";
  const thinking = explicitReasoning || defaultReasoning;
  if (thinking) cliArgs.push("--thinking", thinking);
  return cliArgs;
}

function piModelHasThinkingSuffix(model?: string): boolean {
  const value = (model || "").trim();
  const colon = value.lastIndexOf(":");
  if (colon < 0) return false;
  return PI_THINKING_LEVELS.has(value.slice(colon + 1));
}

function piProviderForAgent(agentId: Extract<LocalCliAgentId, "pi-codex" | "pi-claude">): string {
  return agentId === "pi-claude" ? PI_CLAUDE_PROVIDER : PI_CODEX_PROVIDER;
}

function piDefaultModelForAgent(agentId: Extract<LocalCliAgentId, "pi-codex" | "pi-claude">): string {
  return agentId === "pi-claude" ? PI_CLAUDE_DEFAULT_MODEL : PI_CODEX_DEFAULT_MODEL;
}

function piAgentLabel(agentId: Extract<LocalCliAgentId, "pi-codex" | "pi-claude">): string {
  return agentId === "pi-claude" ? "Pi · Claude Code" : "Pi · Codex";
}

/**
 * High-confidence local-cli / Ask scaffold markers. Keep this list strict:
 * false positives here chop real answers mid-sentence (seen as abrupt cutoffs).
 */
export const LOCAL_CLI_PROMPT_ECHO_MARKERS = [
  "You are a proactive, Socratic-thinking general-purpose and coding agent which helps the user answer their codebase questions.",
  "You are a proactive, Socratic-thinking general-purpose and coding agent",
  "\n# Tool call notes\n",
  "\n# Local CLI Agent Instructions\n",
  "\n# Ask Task\n",
  "\n## Knowledge Profile",
  "\n<code-kb>",
  "Parallelize tool calls whenever possible. Especially file reads",
  "Use native CLI tools directly.\nWhen done, return the final answer as plain Markdown.",
] as const;

const LOCAL_CLI_SYSTEM_INTRO =
  "You are a proactive, Socratic-thinking general-purpose and coding agent";

/** True when text from idx looks like system/Ask scaffold, not user prose. */
export function isLocalCliScaffoldAt(text: string, idx: number): boolean {
  if (idx < 0 || idx >= text.length) return false;
  const window = text.slice(idx, idx + 500);
  // Leading system intro always counts.
  if (window.startsWith(LOCAL_CLI_SYSTEM_INTRO)) return true;
  // Require scaffold co-signals so a lone markdown heading never chops an answer.
  const signals = [
    /#\s*Tool call notes\b/i,
    /#\s*Local CLI Agent Instructions\b/i,
    /#\s*Ask Task\b/i,
    /#\s*User Task\b/i,
    /<code-kb>/i,
    /Socratic-thinking general-purpose/i,
    /Parallelize tool calls whenever possible/i,
    /When done, return the final answer as plain Markdown/i,
    /##\s*Knowledge Profile/i,
    /##\s*Wiki context\b/i,
  ];
  let hits = 0;
  for (const re of signals) if (re.test(window)) hits++;
  return hits >= 2 || (hits >= 1 && /#\s*(?:Tool call notes|Ask Task|Local CLI)/i.test(window));
}

/**
 * Cut echoed local-cli system prompt / Ask task scaffolding out of answer text.
 * Only cuts at high-confidence scaffold boundaries so real answers are never truncated.
 */
export function stripLocalCliPromptEcho(text: string, prompt = ""): string {
  if (!text) return "";
  let out = text;
  const expected = prompt.trim();

  // Leading exact system-intro / full-prompt echo.
  if (out.startsWith(LOCAL_CLI_SYSTEM_INTRO)) {
    if (expected.length >= 48 && out.startsWith(expected.slice(0, Math.min(64, expected.length)))) {
      // Prefer slicing the full known prompt when it is a true prefix.
      if (out.startsWith(expected)) {
        out = out.slice(expected.length).replace(/^\s+/, "");
      } else if (isLocalCliScaffoldAt(out, 0)) {
        // Drop the leading scaffold block through the first double-newline after
        // enough scaffold, then keep any real answer that follows.
        const after = out.search(/\n{2,}(?!#|<code-kb>|You are a proactive)/i);
        out = after >= 0 ? out.slice(after).replace(/^\s+/, "") : "";
      }
    } else if (isLocalCliScaffoldAt(out, 0)) {
      out = "";
    }
  }

  // Trailing / mid dump: cut only when the marker is confirmed scaffold.
  let cut = -1;
  if (out.includes(LOCAL_CLI_SYSTEM_INTRO)) {
    const at = out.indexOf(LOCAL_CLI_SYSTEM_INTRO);
    if (at > 24 && isLocalCliScaffoldAt(out, at)) cut = at;
  }
  for (const marker of LOCAL_CLI_PROMPT_ECHO_MARKERS) {
    const idx = out.indexOf(marker);
    if (idx > 24 && isLocalCliScaffoldAt(out, idx) && (cut < 0 || idx < cut)) cut = idx;
  }
  if (cut > 0) out = out.slice(0, cut).trimEnd();

  // Residual code-kb / Ask Task blocks (confirmed headers only).
  out = out
    .replace(/<code-kb>[\s\S]*?(?:<\/code-kb>|$)/gi, "")
    .replace(/(?:^|\n)#\s*Ask Task\b[\s\S]*$/i, "")
    .replace(/(?:^|\n)#\s*Local CLI Agent Instructions\b[\s\S]*$/i, "")
    .replace(/(?:^|\n)#\s*Tool call notes\b[\s\S]*$/i, "")
    .trimEnd();

  return out;
}

export function createPromptEchoFilter(prompt: string): {
  push: (text: string) => string;
  flush: () => string;
} {
  const expected = prompt.trim();
  const probeLength = Math.min(32, expected.length);
  // Hold only enough to detect the system-intro prefix across chunk boundaries.
  // Larger values parked the ending of real answers and looked like cutoffs when
  // teardown raced ahead of flush.
  const holdBack = 28;
  let mode: "undecided" | "stripping" | "passing" | "dropping" = expected ? "undecided" : "passing";
  let buffer = "";
  let offset = 0;
  let tail = "";

  const stripLeading = (text: string): string => {
    let index = 0;
    while (index < text.length && offset < expected.length && text[index] === expected[offset]) {
      index++;
      offset++;
    }
    if (offset >= expected.length) {
      mode = "passing";
      return text.slice(index).replace(/^\s+/, "");
    }
    if (index < text.length) {
      mode = "passing";
      return text.slice(index);
    }
    return "";
  };

  /** Find earliest confirmed mid/trailing prompt re-echo boundary; -1 if none. */
  const findReechoStart = (text: string): number => {
    let cut = -1;
    // Only match the system intro, never an arbitrary slice of the full prompt
    // (full prompt includes the user question / wiki context and can false-hit).
    const introAt = text.indexOf(LOCAL_CLI_SYSTEM_INTRO);
    if (introAt > 24 && isLocalCliScaffoldAt(text, introAt)) cut = introAt;
    else if (introAt === 0 && isLocalCliScaffoldAt(text, 0)) cut = 0;

    for (const marker of LOCAL_CLI_PROMPT_ECHO_MARKERS) {
      const at = text.indexOf(marker);
      if (at > 24 && isLocalCliScaffoldAt(text, at) && (cut < 0 || at < cut)) cut = at;
    }
    return cut;
  };

  const filterPassing = (text: string): string => {
    const combined = tail + text;
    const cut = findReechoStart(combined);
    if (cut >= 0) {
      mode = "dropping";
      // Emit held tail + new text up to the scaffold boundary (held tail was not
      // previously emitted to the client).
      const keep = combined.slice(0, cut).trimEnd();
      tail = "";
      return keep;
    }
    if (combined.length <= holdBack) {
      tail = combined;
      return "";
    }
    const emit = combined.slice(0, combined.length - holdBack);
    tail = combined.slice(combined.length - holdBack);
    return emit;
  };

  return {
    push(text: string): string {
      if (!text) return "";
      if (mode === "dropping") return "";
      if (mode === "passing") return filterPassing(text);
      if (mode === "stripping") {
        const rest = stripLeading(text);
        return rest ? filterPassing(rest) : "";
      }

      buffer += text;
      if (probeLength > 0 && buffer.length >= probeLength) {
        if (buffer.slice(0, probeLength) === expected.slice(0, probeLength)) {
          mode = "stripping";
          const pending = buffer;
          buffer = "";
          const rest = stripLeading(pending);
          return rest ? filterPassing(rest) : "";
        }
        mode = "passing";
        const pending = buffer;
        buffer = "";
        return filterPassing(pending);
      }
      if (expected.startsWith(buffer)) return "";
      mode = "passing";
      const pending = buffer;
      buffer = "";
      return filterPassing(pending);
    },
    flush(): string {
      // Always release held answer text. Do not lose the last holdBack chars.
      const held = `${buffer}${tail}`;
      buffer = "";
      tail = "";
      if (!held) return "";
      // Already emitted the pre-scaffold keep slice; any residual held text after
      // a confirmed dump is scaffold noise and can be dropped.
      if (mode === "dropping") return "";
      mode = "passing";
      return stripLocalCliPromptEcho(held, expected);
    },
  };
}

export function localCliAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = localCliSearchPath(env).join(":") || env.PATH || "";
  const next: NodeJS.ProcessEnv = { ...env, PATH: path, NO_COLOR: "1" };
  // Active managed provider homes (Settings → Accounts) pin CLI sign-in context.
  const claudeDir = getActiveClaudeConfigDir();
  const codexHome = getActiveCodexHome();
  if (claudeDir && claudeDir !== defaultClaudeConfigDir()) {
    next.CLAUDE_CONFIG_DIR = claudeDir;
  }
  if (codexHome && codexHome !== defaultCodexHome()) {
    next.CODEX_HOME = codexHome;
  }
  if (LOCAL_CLI_PROVIDER_ENV_ALLOW) return next;
  for (const key of Object.keys(next)) {
    if (isProviderSecretEnvKey(key)) delete next[key];
  }
  return next;
}

function piAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...localCliAgentEnv(env),
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

function isProviderSecretEnvKey(key: string): boolean {
  return LOCAL_CLI_PROVIDER_ENV_KEYS.has(key) || LOCAL_CLI_PROVIDER_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

function clampCodexReasoning(model = "", reasoning?: string): string {
  const effort = (reasoning || "").trim();
  if (!effort || effort === "default") return "";
  if (model.startsWith("gpt-5.1") && effort === "xhigh") return "high";
  if (/^gpt-5(?:\.|$)/.test(model) && effort === "minimal") return "low";
  if (model.includes("codex-mini") && (effort === "low" || effort === "minimal" || effort === "xhigh")) return "medium";
  return effort;
}

type ProcessStdinSink = {
  write(chunk: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer): number | Promise<number>;
  flush(): number | Promise<number>;
  end(error?: Error): number | Promise<number>;
};

async function writeSink(stdin: ProcessStdinSink, text: string): Promise<void> {
  await stdin.write(text);
  await stdin.flush();
}

async function writeStdin(stdin: ProcessStdinSink, text: string): Promise<void> {
  await writeSink(stdin, text);
  await stdin.end();
}

async function readJsonLines(stream: ReadableStream<Uint8Array>, onJson: (json: unknown) => void | Promise<void>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          await onJson(JSON.parse(line));
        } catch {
          // Native CLIs sometimes write warnings to stdout. Ignore non-JSON.
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
  const leftover = buffer.trim();
  if (leftover) {
    try {
      await onJson(JSON.parse(leftover));
    } catch {
      // Ignore trailing non-JSON.
    }
  }
}

async function readTextLines(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void | Promise<void>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await onLine?.(line);
      newline = buffer.indexOf("\n");
    }
  }
  const leftover = buffer.trim();
  if (leftover) await onLine?.(leftover);
  return text;
}

async function readTextChunks(stream: ReadableStream<Uint8Array>, onChunk?: (chunk: string) => void | Promise<void>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    text += chunk;
    await onChunk?.(chunk);
  }
  const leftover = decoder.decode();
  if (leftover) {
    text += leftover;
    await onChunk?.(leftover);
  }
  return text;
}

function localCliExitErrorMessage(args: {
  agentName: string;
  exitCode: number;
  stderr?: string;
  lastDiagnostic?: string;
  command?: string;
  cwd?: string;
}): string {
  const detail = compactStatusLine(args.stderr || args.lastDiagnostic || "") ||
    "process ended without stderr, stdout, or status output";
  const lines = [`${args.agentName} exited with ${args.exitCode}: ${detail}`];
  if (args.command) lines.push(`Command: ${args.command}`);
  if (args.cwd) lines.push(`Working directory: ${args.cwd}`);
  return lines.join("\n");
}

function localCliQuietTimeoutMessage(args: {
  agentName: string;
  quietTimeoutMs: number;
  hadOutput?: boolean;
  lastDiagnostic?: string;
  command?: string;
  cwd?: string;
}): string {
  const lines = [
    args.hadOutput
      ? `${args.agentName} produced no new output for ${formatDuration(args.quietTimeoutMs)} and was stopped.`
      : `${args.agentName} produced no output for ${formatDuration(args.quietTimeoutMs)} and was stopped.`,
  ];
  const detail = compactStatusLine(args.lastDiagnostic || "");
  if (detail) lines.push(`Last diagnostic: ${detail}`);
  if (args.command) lines.push(`Command: ${args.command}`);
  if (args.cwd) lines.push(`Working directory: ${args.cwd}`);
  return lines.join("\n");
}

function formatCommandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(shellQuoteForDisplay).join(" ");
}

function shellQuoteForDisplay(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function localCliAgentName(id: LocalCliAgentId): string {
  return id === "claude"
    ? "Claude Code"
    : id === "pi-codex"
    ? "Pi · Codex"
    : id === "pi-claude"
    ? "Pi · Claude Code"
    : id === "codex"
    ? "Codex CLI"
    : id === "antigravity"
    ? "Antigravity CLI"
    : "Grok CLI";
}

function isUsefulCliStderrLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /\bWARN\b/.test(text)) return false;
  if (/plugin name collision|ignoring interface\.defaultPrompt/i.test(text)) return false;
  if (/^Reading prompt from stdin/i.test(text)) return true;
  return /\b(auth|login|loading|initializ|starting|session|model|mcp|warning|error)\b/i.test(text);
}

function compactStatusLine(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function applyBasePatch(cwd: string, patch: string): void {
  const path = join(cwd, `.rlm-wiki-base-${randomBytes(4).toString("hex")}.patch`);
  writeFileSync(path, patch, "utf8");
  try {
    const proc = Bun.spawnSync(["git", "apply", "--3way", path], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      const stdout = new TextDecoder().decode(proc.stdout).trim();
      throw new Error(`git apply failed: ${stderr || stdout}`);
    }
  } finally {
    rmSync(path, { force: true });
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout);
}

function collectRunArtifacts(cwd: string, baseHead: string, metadata: LocalCliRunMetadata): LocalCliRunArtifact[] {
  const patch = gitOutput(cwd, ["diff", "--binary", baseHead, "--"]);
  const status = gitOutput(cwd, ["status", "--short"]);
  const artifacts: LocalCliRunArtifact[] = [
    {
      id: "workspace",
      type: "workspace",
      name: "Prepared workspace",
      path: cwd,
    },
    {
      id: "git-status",
      type: "git_status",
      name: "Git status",
      content: status || "(clean)",
      mediaType: "text/plain",
      size: status.length,
    },
  ];
  if (patch.trim()) {
    artifacts.push({
      id: "patch",
      type: "patch",
      name: "Workspace patch",
      content: patch,
      mediaType: "text/x-diff",
      size: patch.length,
    });
  }
  if (metadata.answer.trim()) {
    artifacts.push({
      id: "answer",
      type: "answer",
      name: "Final answer",
      content: metadata.answer,
      mediaType: "text/markdown",
      size: metadata.answer.length,
    });
  }
  if (metadata.sources.length) {
    const content = JSON.stringify(metadata.sources, null, 2);
    artifacts.push({
      id: "sources",
      type: "sources",
      name: "Sources",
      content,
      mediaType: "application/json",
      size: content.length,
    });
  }
  return artifacts;
}

function finishRunError(run: SidecarRunRecord, message: string): void {
  run.status = run.controller.signal.aborted ? "canceled" : "error";
  run.error = message;
  emitRun(run, run.status === "canceled" ? "canceled" : "error", { error: message });
  scheduleCleanup(run);
}

const TERMINAL_RUN_EVENTS = new Set(["done", "error", "canceled"]);

// Cap any single retained string field. The desktop UI renders only short summaries of
// tool output/input, so the full payload is not needed once captured for streaming.
function truncatePayloadString(value: string): string {
  if (value.length <= LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP) return value;
  return value.slice(0, LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP) + LOCAL_CLI_PAYLOAD_TRUNCATION_MARKER;
}

// Truncate the heavy text-bearing fields of an event before it is retained in run.events.
// Mirrors the Grok ACP trace summarizer (summarizeGrokToolOutput): cap + visible marker.
function truncateEventForRetention(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  let patched: Record<string, unknown> | null = null;
  const patch = (key: string): void => {
    const value = record[key];
    if (typeof value !== "string" || value.length <= LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP) return;
    if (!patched) patched = { ...record };
    patched[key] = truncatePayloadString(value);
  };
  // tool_result.output / participant_status.output / participant_status.prompt carry raw
  // command output; text_delta/thinking_delta carry streamed text; error carries messages.
  patch("output");
  patch("prompt");
  patch("text");
  patch("error");
  // tool_use.input can be an arbitrarily large object; stringify-cap it if oversized.
  const input = record.input;
  if (typeof input === "string" && input.length > LOCAL_CLI_EVENT_PAYLOAD_BYTE_CAP) {
    if (!patched) patched = { ...record };
    patched.input = truncatePayloadString(input);
  }
  return patched ?? data;
}

// Cheap byte estimate for the retained payload: sum the heavy string fields rather than
// stringifying the whole object on every event (hot path during text_delta floods).
function estimateEventBytes(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const record = data as Record<string, unknown>;
  let bytes = 0;
  for (const key of ["output", "prompt", "text", "error", "input", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string") bytes += value.length;
  }
  return bytes;
}

export function emitRun(run: SidecarRunRecord, event: string, data: unknown): void {
  // (1b) Truncate oversized payloads on ingest so a single tool_result can't retain
  // hundreds of KB. Live subscribers receive the same (capped) payload.
  const terminal = TERMINAL_RUN_EVENTS.has(event);
  const retained = terminal ? data : truncateEventForRetention(data);
  const bytes = estimateEventBytes(retained);
  run.events.push({ event, data: retained, bytes, terminal });
  run.eventBytes = (run.eventBytes ?? 0) + bytes;
  // (1a) Enforce a per-run byte budget on the retained events array. Drop the OLDEST
  // non-terminal events (ring-buffer style); NEVER drop terminal events because
  // runEventsResponse replays run.events to late subscribers, who must still receive the
  // terminal frame. Replayed mid-run history is truncated under memory pressure; live
  // subscribers already received the dropped events.
  if (run.eventBytes > LOCAL_CLI_RUN_EVENT_BYTE_BUDGET) {
    let index = 0;
    while (run.eventBytes > LOCAL_CLI_RUN_EVENT_BYTE_BUDGET && index < run.events.length) {
      const entry = run.events[index];
      if (entry.terminal) {
        index += 1;
        continue;
      }
      run.events.splice(index, 1);
      run.eventBytes -= entry.bytes;
    }
  }
  for (const send of run.subscribers) send(event, retained);
}

function runEventsResponse(run: SidecarRunRecord, req: Request): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let subscriber: ((event: string, data: unknown) => void) | null = null;
      let abort: (() => void) | null = null;
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 5_000);
      heartbeat.unref?.();
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (subscriber) run.subscribers.delete(subscriber);
        if (abort) req.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      for (const entry of run.events) send(entry.event, entry.data);
      const replayedTerminal = run.events.some((entry) => entry.event === "done" || entry.event === "error" || entry.event === "canceled");
      if (!replayedTerminal && run.status === "done" && run.metadata) send("done", run.metadata);
      if (!replayedTerminal && (run.status === "error" || run.status === "canceled") && run.error) send(run.status, { error: run.error });
      if (run.status === "done" || run.status === "error" || run.status === "canceled") {
        controller.close();
        return;
      }
      subscriber = (event, data) => {
        send(event, data);
        if (event === "done" || event === "error" || event === "canceled") close();
      };
      run.subscribers.add(subscriber);
      abort = close;
      req.signal.addEventListener("abort", abort, { once: true });
    },
    cancel() {
      // Subscriber cleanup is handled by the request abort callback in normal EventSource use.
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-rlm-wiki-agent-event-contract": "open-design.agent-events.v1",
    },
  });
}

function scheduleCleanup(run: SidecarRunRecord): void {
  // Always schedule the Map entry removal, even when run.cleanup was never assigned (early
  // failures throw before prepareSidecarRun wires it up). Otherwise the record leaks in `runs`
  // forever. Filesystem cleanup stays conditional on run.cleanup having been prepared.
  if (run.cleanupTimer) return;
  run.cleanupTimer = setTimeout(() => {
    run.cleanup?.().catch(() => {});
    runs.delete(run.id);
  }, SIDE_CAR_TTL_MS);
  run.cleanupTimer.unref?.();
}

function scheduleStaleWorkspaceCleanup(): void {
  const timer = setTimeout(() => {
    cleanupStaleLocalCliWorkspaces();
  }, 2_000);
  timer.unref?.();
}

function cleanupStaleLocalCliWorkspaces(): void {
  const cutoff = Date.now() - Math.max(SIDE_CAR_TTL_MS * 2, 60 * 60_000);
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      (!entry.name.startsWith(`${LOCAL_CLI_RUN_PREFIX}workspace-`) &&
        !entry.name.startsWith(`${LOCAL_CLI_TERMINAL_PREFIX}workspace-`))
    ) continue;
    const path = join(tmpdir(), entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${token}`;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function agentDefinition(id: LocalCliAgentId): {
  name: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs: string[];
  models: string[];
  reasoningOptions: string[];
  installHint: string;
  authHint: string;
} {
  if (id === "claude") {
    return {
      name: "Claude Code",
      bin: "claude",
      fallbackBins: ["openclaude"],
      versionArgs: ["--version"],
      models: modelsForLocalCliAgent("claude"),
      reasoningOptions: ["default"],
      installHint: "Install Claude Code with `curl -fsSL https://claude.ai/install.sh | bash`, then authenticate it locally.",
      authHint: "Authenticate Claude Code locally.",
    };
  }
  if (id === "grok") {
    return {
      name: "Grok CLI",
      bin: "grok",
      versionArgs: ["--version"],
      models: modelsForLocalCliAgent("grok"),
      reasoningOptions: ["default"],
      installHint: "Install Grok CLI with `curl -fsSL https://x.ai/cli/install.sh | bash`, then authenticate via `grok login`.",
      authHint: "Authenticate Grok CLI via `grok login`.",
    };
  }
  if (id === "antigravity") {
    return {
      name: "Antigravity CLI",
      bin: "agy",
      fallbackBins: ["antigravity"],
      versionArgs: ["--version"],
      models: modelsForLocalCliAgent("antigravity"),
      reasoningOptions: ["default"],
      installHint: "Install Antigravity CLI with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once and complete Google Sign-In if prompted.",
      authHint: "Run `agy` once and complete Google Sign-In if prompted.",
    };
  }
  if (id === "pi-codex") {
    return {
      name: "Pi · Codex",
      bin: "pi",
      versionArgs: ["--version"],
      models: modelsForLocalCliAgent("pi-codex"),
      reasoningOptions: ["default", "minimal", "low", "medium", "high", "xhigh"],
      installHint: "Requires Pi installed with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. Then run Pi login: start `pi`, enter `/login`, and select ChatGPT Plus/Pro (Codex).",
      authHint: "Run Pi login: start `pi`, enter `/login`, and select ChatGPT Plus/Pro (Codex). OpenAI API keys do not authenticate Pi's openai-codex provider.",
    };
  }
  if (id === "pi-claude") {
    return {
      name: "Pi · Claude Code",
      bin: "pi",
      versionArgs: ["--version"],
      models: modelsForLocalCliAgent("pi-claude"),
      reasoningOptions: ["default", "minimal", "low", "medium", "high", "xhigh"],
      installHint: "Requires Pi installed with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. Then run Pi login: start `pi`, enter `/login`, and select Claude Pro / Max.",
      authHint: "Run Pi login: start `pi`, enter `/login`, and select Claude Pro / Max.",
    };
  }
  return {
    name: "Codex CLI",
    bin: "codex",
    versionArgs: ["--version"],
    models: modelsForLocalCliAgent("codex"),
    reasoningOptions: ["default", "minimal", "low", "medium", "high", "xhigh"],
    installHint: "Install Codex CLI with `npm i -g @openai/codex` or `brew install codex`, then run `codex login`.",
    authHint: "Run `codex login` on this machine.",
  };
}

function resolveExecutable(bin: string, fallbacks: string[]): string | null {
  for (const candidate of [bin, ...fallbacks]) {
    const found = resolveOnPath(candidate);
    if (found) return found;
  }
  return null;
}

function resolveOnPath(bin: string): string | null {
  const dirs = localCliSearchPath();
  for (const dir of dirs) {
    const path = join(dir, bin);
    if (existsSync(path)) return path;
  }
  return null;
}

export function localCliSearchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const seen = new Set<string>();
  const nvmRoot = env.NVM_DIR || join(home, ".nvm");
  const fnmRoot = env.FNM_DIR || join(home, ".fnm");
  const dirs = [
    ...String(env.PATH || "").split(":"),
    ...loginShellPathDirs(),
    ...(env.NPM_CONFIG_PREFIX ? [join(env.NPM_CONFIG_PREFIX, "bin")] : []),
    ...(env.PNPM_HOME ? [env.PNPM_HOME] : []),
    ...(env.BUN_INSTALL ? [join(env.BUN_INSTALL, "bin")] : []),
    ...(env.VOLTA_HOME ? [join(env.VOLTA_HOME, "bin")] : []),
    ...(env.ASDF_DATA_DIR ? [join(env.ASDF_DATA_DIR, "shims")] : []),
    ...(env.MISE_DATA_DIR ? [join(env.MISE_DATA_DIR, "shims")] : []),
    join(home, ".local", "bin"),
    join(home, ".antigravity", "antigravity", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".mise", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".npm-global", "bin"),
    join(home, ".npm-packages", "bin"),
    join(home, "npm-global", "bin"),
    join(home, ".node_modules_global", "bin"),
    join(home, ".yarn", "bin"),
    join(home, ".config", "yarn", "global", "node_modules", ".bin"),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    ...versionedBinDirs(join(nvmRoot, "versions", "node")),
    ...versionedBinDirs(join(home, ".nvm", "versions", "node")),
    ...versionedInstallationBinDirs(join(fnmRoot, "node-versions")),
    ...versionedInstallationBinDirs(join(home, ".fnm", "node-versions")),
    ...versionedInstallationBinDirs(join(home, ".local", "share", "fnm", "node-versions")),
    ...versionedBinDirs(join(home, ".nodenv", "versions")),
    ...versionedBinDirs(join(home, ".pyenv", "versions")),
  ];
  return dirs
    .map((dir) => expandHomePath(dir, home))
    .filter((dir) => dir && existsSync(dir))
    .filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
}

function loginShellPathDirs(): string[] {
  if (cachedLoginShellPathDirs) return cachedLoginShellPathDirs;
  const shell = process.env.SHELL || "/bin/zsh";
  const proc = Bun.spawnSync([shell, "-lc", "printf %s \"$PATH\""], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    timeout: LOCAL_CLI_PROBE_TIMEOUT_MS,
  });
  cachedLoginShellPathDirs = proc.exitCode === 0
    ? new TextDecoder().decode(proc.stdout).split(":").filter(Boolean)
    : [];
  return cachedLoginShellPathDirs;
}

function versionedBinDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry, "bin"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function versionedInstallationBinDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .map((entry) => join(root, entry, "installation", "bin"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function expandHomePath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function runVersion(path: string, args: string[]): string | null {
  const proc = Bun.spawnSync([path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
    timeout: LOCAL_CLI_PROBE_TIMEOUT_MS,
  });
  if (proc.exitCode !== 0) return null;
  return new TextDecoder().decode(proc.stdout).trim().split("\n")[0] || null;
}

function codexAuthStatus(path: string): "ready" | "missing" | "unknown" {
  const proc = Bun.spawnSync([path, "login", "status"], {
    stdout: "pipe",
    stderr: "pipe",
    env: localCliAgentEnv(),
    timeout: LOCAL_CLI_PROBE_TIMEOUT_MS,
  });
  return proc.exitCode === 0 ? "ready" : "missing";
}

function piAuthStatus(provider: string, env: NodeJS.ProcessEnv = process.env): "ready" | "missing" | "unknown" {
  const home = env.HOME || homedir();
  const authPaths = [
    env.PI_AGENT_DIR ? join(env.PI_AGENT_DIR, "auth.json") : "",
    env.PI_CODING_AGENT_DIR ? join(env.PI_CODING_AGENT_DIR, "auth.json") : "",
    join(home, ".pi", "agent", "auth.json"),
  ].filter(Boolean);

  for (const authPath of authPaths) {
    if (!existsSync(authPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf8"));
      if (isConfiguredPiAuth(jsonRecord(parsed)[provider])) return "ready";
      if (isConfiguredPiAuth(jsonRecord(jsonRecord(parsed).providers)[provider])) return "ready";
    } catch {
      return "unknown";
    }
  }
  return "missing";
}

function isConfiguredPiAuth(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.values(record).some((field) =>
    typeof field === "string" ? field.trim().length > 0 : Boolean(field)
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
