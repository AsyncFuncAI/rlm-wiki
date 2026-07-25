#!/usr/bin/env bun
/**
 * RLM Web UI server.
 *
 * Exposes a thin HTTP + SSE API around setupRLM() / rlm.query() /
 * rlm.queryInteractive() and serves session-viewer.html.
 *
 * Endpoints:
 *   GET  /                           serves session-viewer.html
 *   POST /api/run                    start a job, returns { jobId, sessionId }
 *   GET  /api/events/:jobId          SSE stream (replays + live)
 *   POST /api/followup/:jobId        send follow-up in interactive mode
 *   POST /api/abort/:jobId           abort a running job
 *   GET  /api/sessions               list .rlm-sessions/ files
 *   GET  /api/session/:id            return a session JSONL body
 *   GET  /api/status                 server ping
 */

import { join, resolve, basename } from "path";
import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { randomBytes } from "crypto";
import { setupRLM } from "../src/cli/setup.ts";
import type { RLM, RLMEvent, RLMQueryResult } from "../src/rlm.ts";
import type { SourceSpec } from "../src/cli/args.ts";
import type { SessionEvent } from "../src/state/session.ts";
import { listGoals, buildWorkspaceQuery } from "../src/prompts/workspace-meta.js";

// ── Config ───────────────────────────────────────────────────────────

const PORT = parseInt(getFlag(process.argv, "--port", "3141")!);
const HTML_PATH = resolve(import.meta.dir, "..", "session-viewer.html");
const SESSIONS_DIR = resolve(process.cwd(), ".rlm-sessions");

function getFlag(argv: string[], name: string, def: string | null): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  return argv[i + 1] ?? def;
}

// ── Server-stream event envelope ─────────────────────────────────────
// The SSE stream carries two kinds of payloads:
//   1. `session` — a raw SessionEvent (same shape as .rlm-sessions/*.jsonl)
//      — this lets the viewer reuse its existing renderer as-is.
//   2. `rlm` — a raw RLMEvent (status/usage/stream-delta/error/submit etc.)
//      — useful for live progress indicators and answer streaming.
// Plus some control messages: `ready`, `done`, `abort`, `waiting-followup`.

type StreamEnvelope =
  | { kind: "session"; data: SessionEvent }
  | { kind: "rlm"; data: RLMEvent }
  | { kind: "ready"; sessionId: string | null; jobId: string }
  | { kind: "done"; result: Partial<RLMQueryResult> }
  | { kind: "waiting-followup" }
  | { kind: "error"; error: string };

// ── Job registry ─────────────────────────────────────────────────────

interface Job {
  id: string;
  rlm: RLM | null;
  buffer: StreamEnvelope[];
  clients: Set<(e: StreamEnvelope) => void>;
  done: boolean;
  aborted: boolean;
  sessionId: string | null;
  sessionFilePath: string | null;
  lastSessionEventId: number; // highest session event id already streamed
  followUpResolve: ((q: string | null) => void) | null;
  started: number;
}

const jobs = new Map<string, Job>();

function createJob(): Job {
  const id = `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const job: Job = {
    id,
    rlm: null,
    buffer: [],
    clients: new Set(),
    done: false,
    aborted: false,
    sessionId: null,
    sessionFilePath: null,
    lastSessionEventId: -1,
    followUpResolve: null,
    started: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function pushEvent(job: Job, env: StreamEnvelope): void {
  job.buffer.push(env);
  // Cap buffer to avoid runaway memory for very long jobs
  if (job.buffer.length > 10000) job.buffer.splice(0, job.buffer.length - 10000);
  for (const send of job.clients) {
    try { send(env); } catch { /* client will self-remove on error */ }
  }
}

// ── Run request ──────────────────────────────────────────────────────

interface RunRequest {
  mode?: string;
  provider?: string;
  model?: string;
  subProvider?: string;
  subModel?: string;
  baseURL?: string;
  subBaseURL?: string;
  maxIter?: number;
  maxLLM?: number;
  branch?: string;
  sandboxTimeout?: number;
  githubToken?: string;
  interactive?: boolean;
  promptMode?: boolean;
  verbose?: boolean;
  optimizer?: boolean;
  sessionDir?: string;
  resumeSessionId?: string;
  source?: string;
  sources?: Array<string | SourceSpec>;
  goal?: string;
  query: string;
}

async function startJob(req: RunRequest): Promise<Job> {
  const job = createJob();

  const onEvent = (ev: RLMEvent) => {
    if (job.aborted) return;
    pushEvent(job, { kind: "rlm", data: ev });
    // Capture session id from the first `📝 Session started` status
    if (ev.type === "status" && (ev as any).phase === "session") {
      const msg = (ev as any).message as string;
      const match = /Session started: (\S+)\s*→\s*(.+)$/.exec(msg || "") ||
                    /Resumed session: (\S+)/.exec(msg || "");
      if (match && !job.sessionId) {
        job.sessionId = match[1];
        if (match[2]) job.sessionFilePath = match[2].trim();
        else job.sessionFilePath = join(req.sessionDir || SESSIONS_DIR, `${job.sessionId}.jsonl`);
        pushEvent(job, { kind: "ready", sessionId: job.sessionId, jobId: job.id });
      }
    }
  };

  const mode = req.mode ?? "auto";
  const provider = req.provider ?? "anthropic";

  // If a workspace goal is supplied, rewrite the query the same way args.ts does.
  let effectiveQuery = req.query;
  if (req.goal && req.sources && req.sources.length > 0) {
    const repoIds = req.sources.map((s) =>
      typeof s === "string"
        ? (s.split("/").pop() || s).replace(/\.git$/, "")
        : (s.id || (s.source.split("/").pop() || s.source).replace(/\.git$/, ""))
    );
    effectiveQuery = buildWorkspaceQuery(req.goal, repoIds, req.query || undefined);
  }

  // Build setup args
  const setup = await setupRLM({
    mode,
    provider,
    model: req.model ?? null,
    subProvider: req.subProvider ?? null,
    subModel: req.subModel ?? null,
    subBaseURL: req.subBaseURL ?? null,
    baseURL: req.baseURL ?? null,
    maxIter: req.maxIter ?? 20,
    maxLLM: req.maxLLM ?? 5000,
    branch: req.branch ?? null,
    sandboxTimeout: req.sandboxTimeout ?? 1800000,
    githubToken: req.githubToken ?? null,
    verbose: req.verbose ?? false,
    optimizer: req.optimizer ?? false,
    jsonOutput: true, // suppress CLI console decoration
    sessionDir: req.sessionDir ?? null,
    resumeSessionId: req.resumeSessionId ?? null,
    promptMode: req.promptMode ?? false,
    source: req.source ?? null,
    sources: req.sources,
    onEvent,
  });

  job.rlm = setup.rlm;

  // Start the background tailer as soon as the session file path is known
  startSessionTail(job);

  // Kick off the query in the background
  runJob(job, req, effectiveQuery).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    pushEvent(job, { kind: "error", error: msg });
    finishJob(job, { answer: "", sources: [] } as any);
  });

  return job;
}

async function runJob(job: Job, req: RunRequest, query: string): Promise<void> {
  if (!job.rlm) return;
  if (req.interactive || req.promptMode) {
    const promptFn = (): Promise<string | null> => {
      pushEvent(job, { kind: "waiting-followup" });
      return new Promise<string | null>((resolve) => {
        job.followUpResolve = resolve;
      });
    };
    const result = await job.rlm.queryInteractive(query, promptFn, (partial) => {
      // Partial answers between follow-ups — already captured in RLMEvents + session file
      pushEvent(job, {
        kind: "done",
        result: {
          answer: partial.answer,
          sources: partial.sources,
          tokenUsage: partial.tokenUsage,
          confidence: partial.confidence,
        },
      });
    });
    finishJob(job, result);
  } else {
    const result = await job.rlm.query(query);
    finishJob(job, result);
  }
}

function finishJob(job: Job, result: RLMQueryResult): void {
  if (job.done) return;
  job.done = true;
  pushEvent(job, {
    kind: "done",
    result: {
      answer: result.answer,
      sources: result.sources,
      tokenUsage: result.tokenUsage,
      confidence: result.confidence,
    },
  });
  // Flush the session file one more time in case any trailing lines were written
  tailSessionOnce(job).finally(() => {
    // Keep the job around briefly so late SSE connects can still replay, then drop it
    setTimeout(() => jobs.delete(job.id), 60_000);
  });
  // Best-effort cleanup
  job.rlm?.destroy().catch(() => { });
}

// ── Session-file tailer ──────────────────────────────────────────────

async function tailSessionOnce(job: Job): Promise<void> {
  if (!job.sessionFilePath || !existsSync(job.sessionFilePath)) return;
  let content: string;
  try {
    content = readFileSync(job.sessionFilePath, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: SessionEvent;
    try { ev = JSON.parse(line) as SessionEvent; }
    catch { continue; }
    if (typeof ev.id !== "number") continue;
    if (ev.id <= job.lastSessionEventId) continue;
    job.lastSessionEventId = ev.id;
    pushEvent(job, { kind: "session", data: ev });
  }
}

function startSessionTail(job: Job): void {
  // Poll the file every 250ms until the job finishes + one final flush.
  const tick = async () => {
    if (!job.sessionFilePath) {
      // sessionFilePath populated after first `session` status event
      if (!job.done) setTimeout(tick, 150);
      return;
    }
    await tailSessionOnce(job);
    if (!job.done) setTimeout(tick, 250);
  };
  setTimeout(tick, 50);
}

// ── HTTP routing ─────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

async function handleRun(req: Request): Promise<Response> {
  let body: RunRequest;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return json({ error: "`query` is required" }, 400);
  }
  try {
    const job = await startJob(body);
    return json({ jobId: job.id, sessionId: job.sessionId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
}

function handleEvents(jobId: string): Response {
  const job = jobs.get(jobId);
  if (!job) return notFound("Unknown jobId");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (env: StreamEnvelope) => {
        const data = `data: ${JSON.stringify(env)}\n\n`;
        try { controller.enqueue(encoder.encode(data)); }
        catch { /* stream closed */ }
      };
      // Replay buffered events
      for (const env of job.buffer) send(env);
      // Close stream if already done (let a `done` event drain first)
      if (job.done) {
        try { controller.close(); } catch { }
        return;
      }
      job.clients.add(send);
      // Heartbeat so intermediaries don't buffer us
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { clearInterval(heartbeat); }
      }, 15000);

      const closer = setInterval(() => {
        if (job.done) {
          clearInterval(closer);
          clearInterval(heartbeat);
          job.clients.delete(send);
          try { controller.close(); } catch { }
        }
      }, 250);
    },
    cancel() {
      // client disconnected — we let setInterval closer clean up on next tick
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders,
    },
  });
}

async function handleFollowup(jobId: string, req: Request): Promise<Response> {
  const job = jobs.get(jobId);
  if (!job) return notFound("Unknown jobId");
  let body: { query?: string | null };
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }
  if (!job.followUpResolve) {
    return json({ error: "Job is not waiting for a follow-up" }, 409);
  }
  const resolve = job.followUpResolve;
  job.followUpResolve = null;
  const q = typeof body.query === "string" && body.query.trim() ? body.query.trim() : null;
  resolve(q);
  return json({ ok: true });
}

function handleAbort(jobId: string): Response {
  const job = jobs.get(jobId);
  if (!job) return notFound("Unknown jobId");
  job.aborted = true;
  // End any pending follow-up with null to let queryInteractive unwind cleanly
  if (job.followUpResolve) {
    const r = job.followUpResolve;
    job.followUpResolve = null;
    r(null);
  }
  job.rlm?.destroy().catch(() => { });
  pushEvent(job, { kind: "error", error: "aborted" });
  finishJob(job, { answer: "", sources: [] } as any);
  return json({ ok: true });
}

function handleListSessions(): Response {
  const dir = SESSIONS_DIR;
  if (!existsSync(dir)) return json({ sessions: [] });
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const full = join(dir, f);
      const st = statSync(full);
      return { id: f.replace(/\.jsonl$/, ""), file: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return json({ sessions: files });
}

function handleGetSession(id: string): Response {
  const safe = basename(id).replace(/\.jsonl$/, "");
  const full = join(SESSIONS_DIR, `${safe}.jsonl`);
  if (!existsSync(full)) return notFound("Session not found");
  const body = readFileSync(full, "utf8");
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", ...corsHeaders },
  });
}

function handleIndex(): Response {
  if (!existsSync(HTML_PATH)) {
    return new Response("session-viewer.html not found", { status: 500 });
  }
  return new Response(Bun.file(HTML_PATH), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── Bun server ───────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  // 0 = disable idle timeout so long-lived SSE streams aren't killed.
  // Individual handlers manage their own lifecycles (heartbeat pings + done signal).
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return handleIndex();
    }
    if (req.method === "GET" && path === "/api/status") {
      return json({ ok: true, activeJobs: jobs.size });
    }
    if (req.method === "GET" && path === "/api/goals") {
      return json({ goals: listGoals() });
    }
    if (req.method === "POST" && path === "/api/run") {
      return await handleRun(req);
    }
    if (req.method === "GET" && path.startsWith("/api/events/")) {
      const jobId = path.slice("/api/events/".length);
      return handleEvents(jobId);
    }
    if (req.method === "POST" && path.startsWith("/api/followup/")) {
      const jobId = path.slice("/api/followup/".length);
      return await handleFollowup(jobId, req);
    }
    if (req.method === "POST" && path.startsWith("/api/abort/")) {
      const jobId = path.slice("/api/abort/".length);
      return handleAbort(jobId);
    }
    if (req.method === "GET" && path === "/api/sessions") {
      return handleListSessions();
    }
    if (req.method === "GET" && path.startsWith("/api/session/")) {
      const id = path.slice("/api/session/".length);
      return handleGetSession(id);
    }

    return notFound();
  },
});

console.error(`\n  rlm-server listening on http://localhost:${server.port}`);
console.error(`  UI: http://localhost:${server.port}/`);
console.error(`  Sessions dir: ${SESSIONS_DIR}\n`);
