export const GEMINI_OPENAI_COMPAT_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_PROXY_PREFIX = "/api/jcode-gemini-openai";

const GEMINI_DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

let localProxyBase: string | null = null;
let localProxyServer: ReturnType<typeof Bun.serve> | null = null;

export function configureGeminiProxyEnvForServer(host: string, port: number): void {
  if (!process.env.GEMINI_API_KEY || process.env.RLM_WIKI_DISABLE_GEMINI_PROXY === "1") return;
  const clientHost = jcodeLocalProxyHost(host);
  process.env.RLM_WIKI_GEMINI_OPENAI_COMPAT_API_BASE = `http://${clientHost}:${port}${GEMINI_PROXY_PREFIX}`;
}

export function ensureLocalGeminiProxyBase(): string {
  if (localProxyBase) return localProxyBase;
  localProxyServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      return proxyGeminiOpenAI(req, new URL(req.url), "");
    },
  });
  localProxyServer.unref();
  localProxyBase = `http://localhost:${localProxyServer.port}`;
  return localProxyBase;
}

function jcodeLocalProxyHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::" || normalized === "127.0.0.1" || normalized === "::1") {
    return "localhost";
  }
  return host;
}

export async function proxyGeminiOpenAI(req: Request, url: URL, prefix = GEMINI_PROXY_PREFIX): Promise<Response> {
  const suffix = prefix ? url.pathname.slice(prefix.length) || "/" : url.pathname || "/";
  const upstream = `${GEMINI_OPENAI_COMPAT_API_BASE}${suffix}${url.search}`;
  const headers = proxyRequestHeaders(req.headers);
  let body: BodyInit | undefined;

  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await req.text();
    if (suffix.endsWith("/chat/completions")) {
      const patched = patchGeminiThoughtSignatures(raw);
      body = patched ?? raw;
      if (patched) headers.set("content-type", "application/json");
    } else {
      body = raw;
    }
  }

  const upstreamRes = await fetch(upstream, {
    method: req.method,
    headers,
    body,
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: proxyResponseHeaders(upstreamRes.headers),
  });
}

function proxyRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  return headers;
}

function proxyResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("connection");
  return headers;
}

function patchGeminiThoughtSignatures(raw: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  let changed = false;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (role !== "assistant" && role !== "model") continue;
    const toolCalls = record.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    const firstFunctionCall = toolCalls.find((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) return false;
      const type = (call as Record<string, unknown>).type;
      return type === undefined || type === "function";
    });
    if (!firstFunctionCall || typeof firstFunctionCall !== "object" || Array.isArray(firstFunctionCall)) continue;
    const callRecord = firstFunctionCall as Record<string, unknown>;
    const extra = objectRecord(callRecord.extra_content);
    const google = objectRecord(extra.google);
    if (typeof google.thought_signature === "string" && google.thought_signature.trim()) continue;
    google.thought_signature = GEMINI_DUMMY_THOUGHT_SIGNATURE;
    extra.google = google;
    callRecord.extra_content = extra;
    changed = true;
  }

  return changed ? JSON.stringify(payload) : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
