// Client for sharenow's hosted codebase-kb (https://sharenow.today/api/v1/kb).
// Creates/reuses an ephemeral code-graph session per repo, polls it to ready,
// and wraps query/file reads. Strictly additive to every caller: any failure
// (disabled flag, network error, oversized archive, provision failure, expired
// session) resolves to null so surfaces degrade to today's clone-and-explore
// behavior. Nothing here may throw past the exported entry points.

import type { RepoRef } from "./types.ts";

const DEFAULT_BASE_URL = "https://sharenow.today";
// Sharenow caps local uploads at 64 MiB; oversized repos silently skip kb.
const LOCAL_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_ENSURE_BUDGET_MS = 45_000;
// The internal provisioning attempt runs on its own generous deadline so a
// caller with a short budget (Ask's ~5s) does not strand a half-provisioned
// sandbox: the attempt keeps polling after the caller gives up and caches the
// ready session for the next call. Tunable via
// GROK_WIKI_CODE_KB_PROVISION_BUDGET_MS.
const DEFAULT_PROVISION_BUDGET_MS = 150_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
// Sharenow reaps sessions after 30 min idle / 60 min hard cap. Cache entries
// expire below the idle sweep so a cached session id handed to an agent is
// still alive; a stale one is recovered by the 410 re-create path anyway.
const SESSION_CACHE_TTL_MS = 25 * 60_000;
const SESSION_CACHE_MAX_ENTRIES = 64;
const CREATE_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const GIT_EXEC_TIMEOUT_MS = 10_000;
const TAR_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
// Heavy build/dependency dirs never help the code graph; nested node_modules
// needs its own pattern so workspace packages are excluded at any depth.
// Secret-bearing files must never leave the machine, so common credential
// names and key formats are excluded too (tar matches these at any depth).
const LOCAL_TAR_EXCLUDES = [
  "node_modules",
  "*/node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".vercel",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "id_ed25519",
  "id_ed25519.*",
  ".npmrc",
  ".netrc",
  ".aws",
  ".ssh",
  "credentials",
  "credentials.*",
  "secrets",
  "secrets.*",
];

export interface CodeKbSession {
  sessionId: string;
  baseUrl: string;
  cacheKey: string;
  ref: RepoRef;
}

export interface CodeKbExecOptions {
  cwd?: string;
  /** Kill the process once its stdout crosses this many bytes. */
  maxStdoutBytes?: number;
  /** Kill the process after this long. */
  timeoutMs?: number;
}

export interface CodeKbExecResult {
  exitCode: number;
  stdout: Uint8Array<ArrayBuffer>;
  stderr: string;
  /** True when the process was killed for crossing `maxStdoutBytes`. */
  capExceeded: boolean;
}

export type CodeKbExec = (
  command: string[],
  options?: CodeKbExecOptions,
) => CodeKbExecResult | Promise<CodeKbExecResult>;

/** Why a code-kb session was skipped, surfaced best-effort to a status listener. */
export type CodeKbSkipReason = "too-large";

export interface CodeKbClientOptions {
  budgetMs?: number;
  /** Deadline for the shared provisioning attempt (defaults to env/150s). */
  internalBudgetMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  exec?: CodeKbExec;
  maxArchiveBytes?: number;
  /**
   * Best-effort notice when a session is skipped for a surfaceable reason (only
   * the 64 MiB local-archive cap today). Fail-silent semantics are unchanged:
   * the session still resolves null and generation proceeds without the kb. Any
   * throw from the listener is swallowed.
   */
  onSkip?: (reason: CodeKbSkipReason) => void;
}

export function codeKbEnabled(): boolean {
  return process.env.GROK_WIKI_CODE_KB !== "0";
}

export function codeKbBaseUrl(): string {
  const raw = String(process.env.GROK_WIKI_CODE_KB_BASE_URL || "").trim();
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed || DEFAULT_BASE_URL;
}

interface CachedSession {
  session: CodeKbSession;
  state: "ready" | "provisioning";
  expiresAt: number;
}

const sessionCache = new Map<string, CachedSession>();
// One provisioning attempt per cache key: concurrent ensures share the same
// promise instead of each creating their own sandbox.
const inFlightEnsures = new Map<string, Promise<CodeKbSession | null>>();
// A session is an immutable snapshot, so its architecture never changes:
// memoize per sessionId to keep repeat asks/generations off the network and
// the rendered prompt block byte-stable (provider prompt-cache friendly).
const architectureCache = new Map<string, unknown>();

export function __resetCodeKbClientForTests(): void {
  sessionCache.clear();
  inFlightEnsures.clear();
  architectureCache.clear();
}

/**
 * Async process runner: spawns argv directly (no shell), streams stdout with
 * an optional byte cap, and kills the process on cap or timeout. Exported so
 * tests can exercise the real kill paths.
 */
export const defaultCodeKbExec: CodeKbExec = async (command, options) => {
  const proc = Bun.spawn(command, {
    cwd: options?.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
  const maxStdoutBytes = options?.maxStdoutBytes;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let capExceeded = false;
  try {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        totalBytes += value.byteLength;
        if (maxStdoutBytes !== undefined && totalBytes > maxStdoutBytes) {
          capExceeded = true;
          await reader.cancel().catch(() => undefined);
          try {
            proc.kill();
          } catch {
            // already exited
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // A broken stdout stream surfaces via the exit code below.
  }
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited.catch(() => 1);
  clearTimeout(timer);
  const stdout = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    stdout.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exitCode: typeof exitCode === "number" ? exitCode : 1, stdout, stderr, capExceeded };
};

const textDecoder = new TextDecoder();

async function gitLine(exec: CodeKbExec, cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await exec(["git", ...args], { cwd, timeoutMs: GIT_EXEC_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const line = textDecoder.decode(result.stdout).trim();
    return line || null;
  } catch {
    return null;
  }
}

interface ResolvedCacheKey {
  cacheKey: string;
  /** True when the local worktree is on a different branch than requested. */
  branchMismatch: boolean;
}

async function resolveCacheKey(ref: RepoRef, exec: CodeKbExec): Promise<ResolvedCacheKey> {
  if (ref.owner !== "local") {
    return {
      cacheKey: `github:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}@${ref.branch || "default"}`,
      branchMismatch: false,
    };
  }
  // Key local sessions by HEAD plus the effective branch so a new commit (or
  // a branch switch) gets a fresh snapshot; a non-git dir (or a failed
  // rev-parse) caches by path only via "worktree". All best-effort.
  const [head, currentBranch] = await Promise.all([
    gitLine(exec, ref.url, ["rev-parse", "HEAD"]),
    gitLine(exec, ref.url, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  if (ref.branch && currentBranch && currentBranch !== ref.branch) {
    // Tarring the worktree would index the wrong tree; skip kb entirely.
    return { cacheKey: "", branchMismatch: true };
  }
  const headLabel = head && /^[0-9a-f]{7,64}$/i.test(head) ? head : "worktree";
  const branchLabel = ref.branch || currentBranch || "default";
  return { cacheKey: `local:${ref.url}@${headLabel}#${branchLabel}`, branchMismatch: false };
}

function rememberSession(session: CodeKbSession, state: "ready" | "provisioning"): void {
  if (sessionCache.has(session.cacheKey)) {
    sessionCache.delete(session.cacheKey);
  } else if (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(session.cacheKey, { session, state, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
}

function liveCacheEntry(cacheKey: string): CachedSession | null {
  const cached = sessionCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    sessionCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a time budget: resolves the promise's value, or null
 * once the budget elapses (the promise keeps running; a late rejection is
 * swallowed so it can never become an unhandled rejection). Shared by the
 * generation and ask wiring so the deadline-race shape lives in one place.
 */
export async function raceWithBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | null> {
  if (budgetMs <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function provisionBudgetMs(opts: CodeKbClientOptions): number {
  if (typeof opts.internalBudgetMs === "number" && opts.internalBudgetMs > 0) return opts.internalBudgetMs;
  const raw = Number(process.env.GROK_WIKI_CODE_KB_PROVISION_BUDGET_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROVISION_BUDGET_MS;
}

interface CreatedSession {
  sessionId: string;
  state: "ready" | "provisioning";
}

async function parseCreateResponse(response: Response): Promise<CreatedSession | null> {
  if (!response.ok) return null;
  const parsed = (await response.json().catch(() => null)) as { sessionId?: unknown; state?: unknown } | null;
  const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
  if (!sessionId) return null;
  return { sessionId, state: parsed?.state === "ready" ? "ready" : "provisioning" };
}

async function createGithubSession(ref: RepoRef, baseUrl: string, fetchImpl: typeof fetch): Promise<CreatedSession | null> {
  const body: Record<string, unknown> = { repoUrl: `https://github.com/${ref.owner}/${ref.repo}` };
  if (ref.branch) body.ref = ref.branch;
  const response = await fetchImpl(`${baseUrl}/api/v1/kb`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  return parseCreateResponse(response);
}

async function createLocalSession(
  ref: RepoRef,
  baseUrl: string,
  fetchImpl: typeof fetch,
  exec: CodeKbExec,
  maxArchiveBytes: number,
  onSkip?: (reason: CodeKbSkipReason) => void,
): Promise<CreatedSession | null> {
  const reportSkip = (reason: CodeKbSkipReason): null => {
    try {
      onSkip?.(reason);
    } catch {
      // A status listener must never turn a silent skip into a failure.
    }
    return null;
  };
  // Stream the gzipped tar from stdout with a hard byte cap: no tmp file, and
  // an oversized repo kills tar at the cap instead of materializing the whole
  // archive. tar exiting non-zero after that deliberate kill is expected; any
  // other non-zero exit is a failure.
  const tar = await exec(
    ["tar", "-czf", "-", "-C", ref.url, ...LOCAL_TAR_EXCLUDES.map((pattern) => `--exclude=${pattern}`), "."],
    { maxStdoutBytes: maxArchiveBytes, timeoutMs: TAR_EXEC_TIMEOUT_MS },
  );
  if (tar.capExceeded) return reportSkip("too-large");
  if (tar.exitCode !== 0) return null;
  const bytes = tar.stdout;
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength > maxArchiveBytes) return reportSkip("too-large");
  const sanitized = ref.repo.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  const name = !sanitized || sanitized === "." || sanitized === ".." ? "workspace" : sanitized;
  const response = await fetchImpl(`${baseUrl}/api/v1/kb/local?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: bytes,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  return parseCreateResponse(response);
}

async function fetchSessionState(session: CodeKbSession, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(`${session.baseUrl}/api/v1/kb/${session.sessionId}/status`, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const parsed = (await response.json().catch(() => null)) as { state?: unknown } | null;
  return typeof parsed?.state === "string" ? parsed.state : null;
}

// Poll a session toward ready until `deadline`. A failed status FETCH (network
// error, non-ok, unparseable) is transient and retried; only an explicit
// failed/expired state aborts. Returns "ready", "dead" (cache entry dropped),
// or "pending" (still provisioning at the deadline).
async function pollToReady(
  session: CodeKbSession,
  fetchImpl: typeof fetch,
  deadline: number,
  pollIntervalMs: number,
): Promise<"ready" | "dead" | "pending"> {
  while (Date.now() < deadline) {
    const state = await fetchSessionState(session, fetchImpl).catch(() => null);
    if (state === "ready") {
      rememberSession(session, "ready");
      return "ready";
    }
    if (state === "failed" || state === "expired") {
      sessionCache.delete(session.cacheKey);
      return "dead";
    }
    const waitMs = Math.min(pollIntervalMs, deadline - Date.now());
    if (waitMs <= 0) break;
    await sleep(waitMs);
  }
  return "pending";
}

// The shared provisioning attempt: create the session, cache it immediately as
// provisioning (so later ensures can adopt it instead of creating an orphan),
// then poll to ready on the generous internal deadline. Never rejects.
async function ensureInternal(
  ref: RepoRef,
  cacheKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  exec: CodeKbExec,
  opts: CodeKbClientOptions,
): Promise<CodeKbSession | null> {
  try {
    const deadline = Date.now() + provisionBudgetMs(opts);
    const created = ref.owner === "local"
      ? await createLocalSession(ref, baseUrl, fetchImpl, exec, opts.maxArchiveBytes ?? LOCAL_ARCHIVE_MAX_BYTES, opts.onSkip)
      : await createGithubSession(ref, baseUrl, fetchImpl);
    if (!created) return null;
    const session: CodeKbSession = { sessionId: created.sessionId, baseUrl, cacheKey, ref };
    rememberSession(session, created.state);
    if (created.state === "ready") return session;
    const outcome = await pollToReady(session, fetchImpl, deadline, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    // "pending" keeps the provisioning cache entry: the sandbox exists
    // server-side, so a later ensure polls it rather than creating another.
    return outcome === "ready" ? session : null;
  } catch {
    return null;
  }
}

/**
 * Ensure a ready kb session for the repo: cache hit, or create (github URL
 * route / local tar upload) and poll status until ready within `budgetMs`.
 * Concurrent calls for the same repo share one provisioning attempt, and that
 * attempt keeps running past the caller budget so a later call converges on
 * the cached ready session. Resolves null on any failure; never throws.
 */
export async function ensureCodeKbSession(ref: RepoRef, opts: CodeKbClientOptions = {}): Promise<CodeKbSession | null> {
  try {
    if (!codeKbEnabled()) return null;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const exec = opts.exec ?? defaultCodeKbExec;
    const baseUrl = codeKbBaseUrl();
    const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_ENSURE_BUDGET_MS);
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const resolved = await resolveCacheKey(ref, exec);
    if (resolved.branchMismatch) return null;
    const cacheKey = resolved.cacheKey;

    const cached = liveCacheEntry(cacheKey);
    if (cached?.state === "ready") return cached.session;

    const existing = inFlightEnsures.get(cacheKey);
    if (existing) return await raceWithBudget(existing, deadline - Date.now());

    if (cached?.state === "provisioning") {
      const outcome = await pollToReady(cached.session, fetchImpl, deadline, pollIntervalMs);
      // "pending" keeps the cache entry so the next call resumes polling.
      return outcome === "ready" ? cached.session : null;
    }

    // The attempt outlives callers that time out; both settlement handlers
    // swallow everything so a discarded attempt can never surface as an
    // unhandled rejection, and both clear the in-flight slot before any
    // joiner resumes so a settled attempt is never re-joined from the map.
    const attempt: Promise<CodeKbSession | null> = ensureInternal(ref, cacheKey, baseUrl, fetchImpl, exec, opts).then(
      (result) => {
        if (inFlightEnsures.get(cacheKey) === attempt) inFlightEnsures.delete(cacheKey);
        return result;
      },
      () => {
        if (inFlightEnsures.get(cacheKey) === attempt) inFlightEnsures.delete(cacheKey);
        return null;
      },
    );
    inFlightEnsures.set(cacheKey, attempt);
    return await raceWithBudget(attempt, deadline - Date.now());
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget pre-warm (KTD-5): kick the shared provisioning attempt for
 * the ref and return immediately. `budgetMs: 1` makes the racing caller give
 * up at once while the internal attempt keeps provisioning on its own budget
 * and caches the session for the next ensure/peek. Swallows everything; never
 * throws and never leaves an unhandled rejection.
 */
export function prewarmCodeKbSession(ref: RepoRef, opts: CodeKbClientOptions = {}): void {
  try {
    void ensureCodeKbSession(ref, { ...opts, budgetMs: 1 }).catch(() => undefined);
  } catch {
    // Pre-warm must never surface a failure to its caller.
  }
}

export interface CodeKbSessionPeek {
  session: CodeKbSession;
  state: "ready" | "provisioning";
}

/**
 * Cache-only lookup: the live cached entry for the ref, including sessions
 * still provisioning, with zero network. Local refs resolve their cache key
 * through git (a local exec, not network) best-effort; any miss, branch
 * mismatch, or failure resolves null. Never throws.
 */
export async function peekCodeKbSession(ref: RepoRef, opts: CodeKbClientOptions = {}): Promise<CodeKbSessionPeek | null> {
  try {
    if (!codeKbEnabled()) return null;
    const resolved = await resolveCacheKey(ref, opts.exec ?? defaultCodeKbExec);
    if (resolved.branchMismatch) return null;
    const cached = liveCacheEntry(resolved.cacheKey);
    if (!cached) return null;
    return { session: cached.session, state: cached.state };
  } catch {
    return null;
  }
}

type PostOutcome = { kind: "ok"; result: unknown } | { kind: "gone" } | { kind: "error" };

async function postSessionOnce(
  session: CodeKbSession,
  endpoint: "query" | "file",
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<PostOutcome> {
  const response = await fetchImpl(`${session.baseUrl}/api/v1/kb/${session.sessionId}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (response.status === 410) return { kind: "gone" };
  if (!response.ok) return { kind: "error" };
  const parsed = (await response.json().catch(() => null)) as { result?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) return { kind: "error" };
  return { kind: "ok", result: parsed.result };
}

// A 410 means the sandbox is gone (idle sweep / hard TTL): invalidate the
// cache entry, re-create the session once, retry once. Any other failure or a
// second consecutive 410 is null.
async function postSessionJson(
  session: CodeKbSession,
  endpoint: "query" | "file",
  body: Record<string, unknown>,
  opts: CodeKbClientOptions,
): Promise<unknown | null> {
  try {
    if (!codeKbEnabled()) return null;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const first = await postSessionOnce(session, endpoint, body, fetchImpl);
    if (first.kind === "ok") return first.result;
    if (first.kind !== "gone") return null;
    sessionCache.delete(session.cacheKey);
    architectureCache.delete(session.sessionId);
    const fresh = await ensureCodeKbSession(session.ref, opts);
    if (!fresh) return null;
    const second = await postSessionOnce(fresh, endpoint, body, fetchImpl);
    if (second.kind === "ok") return second.result;
    if (second.kind === "gone") {
      sessionCache.delete(fresh.cacheKey);
      architectureCache.delete(fresh.sessionId);
    }
    return null;
  } catch {
    return null;
  }
}

/** Run a cbmem query tool against the session. Null on any failure. */
export async function queryCodeKb(
  session: CodeKbSession,
  tool: string,
  args: Record<string, unknown> = {},
  opts: CodeKbClientOptions = {},
): Promise<unknown | null> {
  // The snapshot is immutable, so a no-arg get_architecture is memoizable per
  // session: repeat asks/generations skip the round-trip and render the exact
  // same bytes into the prompt block.
  const memoizable = tool === "get_architecture" && Object.keys(args).length === 0;
  if (memoizable) {
    const memo = architectureCache.get(session.sessionId);
    if (memo !== undefined) return memo;
  }
  const result = await postSessionJson(session, "query", { tool, args }, opts);
  if (memoizable && result !== null) {
    if (architectureCache.size >= SESSION_CACHE_MAX_ENTRIES) {
      const oldest = architectureCache.keys().next().value;
      if (oldest !== undefined) architectureCache.delete(oldest);
    }
    architectureCache.set(session.sessionId, result);
  }
  return result;
}

/** Read a raw file (optionally a line range) from the session's repo snapshot. Null on any failure. */
export async function readCodeKbFile(
  session: CodeKbSession,
  path: string,
  range?: { startLine?: number; endLine?: number },
  opts: CodeKbClientOptions = {},
): Promise<unknown | null> {
  const body: Record<string, unknown> = { path };
  if (range?.startLine !== undefined) body.startLine = range.startLine;
  if (range?.endLine !== undefined) body.endLine = range.endLine;
  return postSessionJson(session, "file", body, opts);
}
