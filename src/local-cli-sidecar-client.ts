import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  LOCAL_CLI_AGENT_IDS,
  type LocalCliAgentStatus,
  type LocalCliEvent,
  type LocalCliRunMetadata,
} from "./local-cli-events.ts";

interface SidecarStamp {
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
}

interface SidecarHandle {
  baseUrl: string;
  token: string;
  proc?: ReturnType<typeof Bun.spawn>;
  stampPath: string;
}

interface RunRequest {
  source?: string;
  sources?: unknown[];
  branch?: string | null;
  sourcePath?: string | null;
  prompt: string;
  localCli?: unknown;
  basePatch?: string;
  screenshots?: unknown[];
  contextLabel?: string;
  sourceless?: boolean;
}

interface TerminalWorkspaceRequest {
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
}

export interface LocalCliTerminalWorkspace {
  id: string;
  source: string;
  cwd: string;
  diffCwd?: string;
  root?: string;
  sourcePath?: string | null;
  context?: string;
}

let sidecarPromise: Promise<SidecarHandle> | null = null;
let sidecarStarter: () => Promise<SidecarHandle> = startLocalCliSidecarProcess;

export function localCliSidecarEnabled(): boolean {
  const raw = (
    process.env.RLM_WIKI_LOCAL_CLI ||
    process.env.RLM_WIKI_ENABLE_LOCAL_CLI ||
    process.env.RLM_WIKI_LOCAL_CLI ||
    process.env.RLM_WIKI_ENABLE_LOCAL_CLI ||
    ""
  ).trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (process.env.RLM_WIKI_LOCAL_CLI_SIDECAR === "1") return true;
  if (process.env.RLM_WIKI_LOCAL_CLI_SIDECAR === "1") return true;
  if (process.env.RLM_WIKI_PROCESS === "worker" || process.env.RLM_WIKI_PROCESS === "worker") return false;
  if (process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.RENDER || process.env.VERCEL || process.env.NETLIFY || process.env.HEROKU_APP_NAME) {
    return false;
  }
  return true;
}

export function localCliSidecarEntrypoint(): string {
  const bundled = process.env.RLM_WIKI_SERVER_ENTRY?.trim();
  if (bundled) return bundled;
  return fileURLToPath(new URL("../bin/rlm-wiki.ts", import.meta.url));
}

export async function getLocalCliAgents(opts: { rescan?: boolean; probe?: boolean } = {}): Promise<{ enabled: boolean; agents: LocalCliAgentStatus[]; error?: string }> {
  if (!localCliSidecarEnabled()) return { enabled: false, agents: [], error: "Local CLI sidecar is disabled in this environment." };
  try {
    const params = new URLSearchParams();
    if (opts.rescan) params.set("rescan", "1");
    if (opts.probe) params.set("probe", "1");
    const res = await fetchLocalCliSidecar(`/v1/agents${params.size ? `?${params.toString()}` : ""}`, undefined, { retry: true });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json() as { agents?: LocalCliAgentStatus[] };
    const agents = Array.isArray(data.agents) ? data.agents : [];
    if (opts.rescan && isStaleLocalCliAgentList(agents)) {
      resetLocalCliSidecar(await ensureLocalCliSidecar().catch(() => undefined));
      const retryParams = new URLSearchParams();
      retryParams.set("rescan", "1");
      if (opts.probe) retryParams.set("probe", "1");
      const retry = await fetchLocalCliSidecar(`/v1/agents?${retryParams.toString()}`, undefined, { retry: true });
      if (!retry.ok) throw new Error(await retry.text());
      const fresh = await retry.json() as { agents?: LocalCliAgentStatus[] };
      return { enabled: true, agents: Array.isArray(fresh.agents) ? fresh.agents : [] };
    }
    return { enabled: true, agents };
  } catch (error) {
    return { enabled: false, agents: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function isStaleLocalCliAgentList(agents: LocalCliAgentStatus[]): boolean {
  if (!agents.length) return false;
  const ids = new Set(agents.map((agent) => agent.id));
  return LOCAL_CLI_AGENT_IDS.some((id) => !ids.has(id));
}

export async function runLocalCliSidecar(
  request: RunRequest,
  onEvent: (event: LocalCliEvent) => void,
  signal?: AbortSignal,
): Promise<LocalCliRunMetadata> {
  if (!localCliSidecarEnabled()) {
    throw new Error("Local CLI sidecar is disabled in this environment.");
  }
  const start = await fetchLocalCliSidecar("/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  }, { retry: true });
  if (!start.ok) throw new Error(await start.text());
  const { runId } = await start.json() as { runId: string };
  if (!runId) throw new Error("Local CLI sidecar did not return a run id.");
  const sidecar = await ensureLocalCliSidecar();

  let cancelSent = false;
  const cancelRun = (): void => {
    if (cancelSent) return;
    cancelSent = true;
    void cancelLocalCliSidecarRun(sidecar, runId);
  };
  signal?.addEventListener("abort", cancelRun, { once: true });
  try {
    if (signal?.aborted) cancelRun();
    const events = await fetch(`${sidecar.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: authHeaders(sidecar),
      signal,
    });
    if (!events.ok || !events.body) throw new Error(await events.text());
    return await readSidecarEvents(events.body, onEvent, signal);
  } catch (error) {
    if (signal?.aborted) cancelRun();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelRun);
  }
}

export async function prepareLocalCliTerminalWorkspace(
  request: TerminalWorkspaceRequest,
): Promise<LocalCliTerminalWorkspace> {
  if (!localCliSidecarEnabled()) {
    throw new Error("Local CLI sidecar is disabled in this environment.");
  }
  const response = await fetchLocalCliSidecar("/v1/terminal-workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }, { retry: true });
  if (!response.ok) throw new Error(await response.text());
  const workspace = await response.json() as LocalCliTerminalWorkspace;
  if (!workspace.id || !workspace.cwd) throw new Error("Local CLI sidecar did not return a terminal workspace cwd.");
  return workspace;
}

export async function releaseLocalCliTerminalWorkspace(id: string): Promise<boolean> {
  if (!id || !localCliSidecarEnabled()) return false;
  const response = await fetchLocalCliSidecar(`/v1/terminal-workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }, { retry: true });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json() as { released?: boolean };
  return data.released !== false;
}

async function ensureLocalCliSidecar(): Promise<SidecarHandle> {
  if (!sidecarPromise) {
    sidecarPromise = sidecarStarter().catch((error) => {
      sidecarPromise = null;
      throw error;
    });
  }
  return sidecarPromise;
}

async function fetchLocalCliSidecar(
  path: string,
  init?: RequestInit,
  opts: { retry?: boolean } = {},
): Promise<Response> {
  const sidecar = await ensureLocalCliSidecar();
  try {
    return await fetch(`${sidecar.baseUrl}${path}`, withAuthHeaders(sidecar, init));
  } catch (error) {
    resetLocalCliSidecar(sidecar);
    if (!opts.retry) throw error;
    const nextSidecar = await ensureLocalCliSidecar();
    return fetch(`${nextSidecar.baseUrl}${path}`, withAuthHeaders(nextSidecar, init));
  }
}

function withAuthHeaders(sidecar: SidecarHandle, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${sidecar.token}`);
  return {
    ...init,
    headers,
  };
}

function resetLocalCliSidecar(handle?: SidecarHandle): void {
  sidecarPromise = null;
  try {
    handle?.proc?.kill("SIGTERM");
  } catch {
    // already exited
  }
  if (handle?.stampPath) rmSync(handle.stampPath, { force: true });
}

async function startLocalCliSidecarProcess(): Promise<SidecarHandle> {
  const token = randomBytes(24).toString("hex");
  const stampPath = join(tmpdir(), `rlm-wiki-local-cli-${process.pid}-${randomBytes(4).toString("hex")}.json`);
  const binPath = localCliSidecarEntrypoint();
  mkdirSync(dirname(stampPath), { recursive: true });
  rmSync(stampPath, { force: true });
  const proc = Bun.spawn([
    process.execPath,
    binPath,
    "sidecar",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--token",
    token,
    "--stamp",
    stampPath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RLM_WIKI_LOCAL_CLI_SIDECAR: "1" },
  });
  drainProcessLog(proc.stderr, "local-cli-sidecar");
  drainProcessLog(proc.stdout, "local-cli-sidecar");
  let stamp: SidecarStamp;
  try {
    stamp = await waitForStamp(stampPath, token, proc);
  } catch (error) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already exited
    }
    rmSync(stampPath, { force: true });
    throw error;
  }
  const handle: SidecarHandle = {
    baseUrl: `http://${stamp.host}:${stamp.port}`,
    token: stamp.token,
    proc,
    stampPath,
  };
  installCleanup(handle);
  return handle;
}

async function waitForStamp(stampPath: string, token: string, proc: ReturnType<typeof Bun.spawn>): Promise<SidecarStamp> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (existsSync(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as SidecarStamp;
      if (stamp.token !== token) throw new Error("Local CLI sidecar stamp token mismatch.");
      return stamp;
    }
    const exited = await Promise.race([
      proc.exited.then((code) => ({ code })),
      sleep(100).then(() => null),
    ]);
    if (exited) throw new Error(`Local CLI sidecar exited before ready (${exited.code}).`);
  }
  throw new Error("Timed out waiting for local CLI sidecar to start.");
}

async function readSidecarEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: LocalCliEvent) => void,
  signal?: AbortSignal,
): Promise<LocalCliRunMetadata> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentData = "";
  while (true) {
    if (signal?.aborted) throw new DOMException("Stopped by user.", "AbortError");
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      currentEvent = "message";
      currentData = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) currentData += line.slice(5).trim();
      }
      if (currentData) {
        const parsed = JSON.parse(currentData);
        if (currentEvent === "event") {
          onEvent(parsed as LocalCliEvent);
        } else if (currentEvent === "done") {
          await reader.cancel().catch(() => {});
          return parsed as LocalCliRunMetadata;
        } else if (currentEvent === "error" || currentEvent === "canceled") {
          const error = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as any).error) : currentEvent;
          throw new Error(error);
        }
      }
      sep = buffer.indexOf("\n\n");
    }
  }
  throw new Error("Local CLI sidecar stream ended without a done event.");
}

function authHeaders(sidecar: SidecarHandle): Record<string, string> {
  return { authorization: `Bearer ${sidecar.token}` };
}

async function cancelLocalCliSidecarRun(sidecar: SidecarHandle, runId: string): Promise<void> {
  try {
    await fetch(`${sidecar.baseUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: authHeaders(sidecar),
    });
  } catch {
    // Cancellation is best-effort; the caller's abort path should keep moving.
  }
}

function installCleanup(handle: SidecarHandle): void {
  const cleanup = (): void => {
    try {
      handle.proc?.kill("SIGTERM");
    } catch {
      // already exited
    }
    rmSync(handle.stampPath, { force: true });
  };
  process.once("exit", cleanup);
}

async function drainProcessLog(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) console.warn(`[${label}] ${line}`);
        newline = buffer.indexOf("\n");
      }
    }
  } catch {
    // logging only
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function __resetLocalCliSidecarForTests(): void {
  resetLocalCliSidecar();
  sidecarStarter = startLocalCliSidecarProcess;
}

export function __setLocalCliSidecarStarterForTests(starter: () => Promise<SidecarHandle>): void {
  resetLocalCliSidecar();
  sidecarStarter = starter;
}
