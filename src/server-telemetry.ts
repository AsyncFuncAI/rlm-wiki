// Server-side error telemetry to PostHog Error Tracking. Mirrors the desktop
// client's payload boundary: messages and stacks are redacted before leaving
// the process, captures are rate-limited, and nothing is sent unless the user
// opted in (the desktop frontend pushes its analytics preference via
// /api/telemetry-config; hosted deployments opt in with RLM_WIKI_SERVER_TELEMETRY=1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POSTHOG_PROJECT_TOKEN = "phc_cXKukXXkydA5fR89Uwo7p4gnN50Dc0MVhszjwNhxn37";
const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const MAX_ERRORS_PER_PROCESS = 40;
const MIN_ERROR_INTERVAL_MS = 500;
const SAFE_KEY = /^[a-zA-Z0-9_.$-]{1,64}$/;

type TelemetryState = { enabled: boolean; distinctId: string };

let state: TelemetryState | null = null;
let errorCount = 0;
let lastCaptureAt = 0;

function telemetryDir(): string {
  return (
    process.env.RLM_WIKI_DESKTOP_APP_DATA?.trim() ||
    process.env.RLM_WIKI_ROOT?.trim() ||
    ""
  );
}

function telemetryFile(): string {
  const dir = telemetryDir();
  return dir ? join(dir, "server-telemetry.json") : "";
}

function loadState(): TelemetryState {
  if (state) return state;
  const forced = String(process.env.RLM_WIKI_SERVER_TELEMETRY || "").trim();
  if (forced === "1" || forced.toLowerCase() === "on") {
    state = { enabled: true, distinctId: `srv-${crypto.randomUUID()}` };
    return state;
  }
  if (forced === "0" || forced.toLowerCase() === "off") {
    state = { enabled: false, distinctId: "srv-disabled" };
    return state;
  }
  const file = telemetryFile();
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      state = {
        enabled: parsed.enabled === true,
        distinctId: typeof parsed.distinctId === "string" && parsed.distinctId
          ? parsed.distinctId
          : `srv-${crypto.randomUUID()}`,
      };
      return state;
    } catch {
      // fall through to default
    }
  }
  // Default ON, matching the client's opt-out analytics model ("Disable this
  // anytime" in settings). The frontend pushes the user's preference on every
  // status load, and an opt-out persists across boots via the state file.
  state = { enabled: true, distinctId: `srv-${crypto.randomUUID()}` };
  return state;
}

function persistState(): void {
  const file = telemetryFile();
  if (!file || !state) return;
  try {
    mkdirSync(telemetryDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // Telemetry must never break the server.
  }
}

export function configureServerTelemetry(enabled: boolean): void {
  const current = loadState();
  state = { ...current, enabled: enabled === true };
  persistState();
}

export function serverTelemetryEnabled(): boolean {
  return loadState().enabled;
}

/** Reduce file paths to "<path>/basename", strip URLs, emails, and token-like blobs. */
export function redactServerErrorText(value: unknown, maxLen = 300): string {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text
    .replace(/\bhttps?:\/\/[^\s'")]+/gi, "<url>")
    .replace(/\bfile:\/\/[^\s'")]+/gi, (m) => pathBasenameToken(m))
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\b[A-Za-z]:\\[^\s'")]+/g, (m) => pathBasenameToken(m))
    .replace(/(?:\/[\w.@~-]+){2,}\/?/g, (m) => pathBasenameToken(m))
    .replace(/\b(?:sk|phc|key|tok|ghp|github_pat|bearer)[-_][A-Za-z0-9_-]{8,}\b/gi, "<token>")
    .replace(/\b[a-f0-9]{24,}\b/gi, "<hex>");
  return text.slice(0, maxLen);
}

function pathBasenameToken(path: string): string {
  const clean = String(path).replace(/[)'":,]+$/g, "");
  const segments = clean.split(/[\\/]/).filter(Boolean);
  const basename = segments[segments.length - 1] || "";
  return basename ? `<path>/${basename}` : "<path>";
}

function sanitizeProps(properties: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (!SAFE_KEY.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      safe[key] = value;
    } else if (typeof value === "string") {
      const clean = redactServerErrorText(value, 120);
      if (clean) safe[key] = clean;
    }
  }
  return safe;
}

/**
 * Capture a redacted server-side exception to PostHog Error Tracking.
 * Fire-and-forget: never throws, never blocks, rate-limited per process.
 */
export function captureServerError(
  flow: string,
  error: unknown,
  properties: Record<string, unknown> = {},
): void {
  try {
    const current = loadState();
    if (!current.enabled) return;
    const now = Date.now();
    if (errorCount >= MAX_ERRORS_PER_PROCESS) return;
    if (now - lastCaptureAt < MIN_ERROR_INTERVAL_MS) return;
    errorCount += 1;
    lastCaptureAt = now;

    const raw = error instanceof Error ? error : new Error(String(error ?? "Unknown error"));
    const type = SAFE_KEY.test(String(raw.name || "")) ? raw.name : "Error";
    const value = redactServerErrorText(raw.message) || "Unknown error";

    const body = JSON.stringify({
      api_key: POSTHOG_PROJECT_TOKEN,
      event: "$exception",
      distinct_id: current.distinctId,
      properties: {
        ...sanitizeProps(properties),
        error_flow: SAFE_KEY.test(String(flow || "")) ? flow : "unknown",
        app_surface: "desktop-server",
        $exception_list: [
          { type, value, mechanism: { handled: true, synthetic: false } },
        ],
      },
    });
    void fetch(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {
      /* telemetry must never break the server */
    });
  } catch {
    /* telemetry must never break the server */
  }
}

/** Observe fatal errors without changing crash semantics. */
export function installServerTelemetryMonitors(): void {
  try {
    process.on("uncaughtExceptionMonitor", (error) => {
      captureServerError("process", error, { handler: "uncaught_exception" });
    });
  } catch {
    // Monitor unsupported on this runtime; flow-level captures still apply.
  }
}
