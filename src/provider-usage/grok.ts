import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderRateLimits, RateLimitWindow } from "./types.ts";
import { parseResetDescription } from "./format.ts";

const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
const BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`;
const API_TIMEOUT_MS = 10_000;
const WEEKLY_WINDOW_MINUTES = 10_080;
const GROK_CLI_AUTH_HEADER = "xai-grok-cli";
const TOKEN_SKEW_MS = 5 * 60 * 1000;

type GrokAuthSession = {
  accessToken: string;
  userId: string | null;
  email: string | null;
  teamId: string | null;
  expiresAtMs: number | null;
};

type GrokAuthReadResult =
  | { status: "missing" }
  | { status: "error"; error: string }
  | { status: "ok"; session: GrokAuthSession };

type GrokBillingConfig = {
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  subscriptionTier?: string;
};

type GrokBillingResponse = GrokBillingConfig & {
  config?: GrokBillingConfig;
};

function getGrokHome(): string {
  const fromEnv = process.env.GROK_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".grok");
}

function getGrokAuthPath(): string {
  return join(getGrokHome(), "auth.json");
}

function parseExpiresAtMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function readGrokAuthSession(): GrokAuthReadResult {
  const path = getGrokAuthPath();
  if (!existsSync(path)) return { status: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "error", error: "Grok auth file is invalid" };
    }
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const authEntry = entry as {
        key?: string;
        user_id?: string;
        email?: string;
        team_id?: string;
        expires_at?: string;
      };
      if (typeof authEntry.key !== "string" || authEntry.key.length === 0) continue;
      return {
        status: "ok",
        session: {
          accessToken: authEntry.key,
          userId: typeof authEntry.user_id === "string" ? authEntry.user_id : null,
          email: typeof authEntry.email === "string" ? authEntry.email : null,
          teamId: typeof authEntry.team_id === "string" ? authEntry.team_id : null,
          expiresAtMs: parseExpiresAtMs(authEntry.expires_at),
        },
      };
    }
    return { status: "missing" };
  } catch {
    return { status: "error", error: "Unable to read Grok auth file" };
  }
}

export function hasGrokAuthSession(): boolean {
  return readGrokAuthSession().status === "ok";
}

export function isGrokAccessTokenFresh(session: GrokAuthSession): boolean {
  if (session.expiresAtMs === null) return true;
  return session.expiresAtMs - Date.now() > TOKEN_SKEW_MS;
}

function result(
  status: ProviderRateLimits["status"],
  error: string | null,
  partial?: Partial<ProviderRateLimits>,
): ProviderRateLimits {
  return {
    provider: "grok",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...partial,
  };
}

function mapWeeklyCredits(config: GrokBillingConfig): RateLimitWindow | null {
  const usedPercent = config.creditUsagePercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd;
  const resetsAt = periodEnd ? Date.parse(periodEnd) : null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
    resetDescription: parseResetDescription(periodEnd),
  };
}

function grokRequestHeaders(session: GrokAuthSession): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XAI-Token-Auth": GROK_CLI_AUTH_HEADER,
    Accept: "application/json",
  };
  if (session.userId) headers["x-userid"] = session.userId;
  return headers;
}

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) return data.config;
  if (typeof data.creditUsagePercent === "number") return data;
  return null;
}

/**
 * Fetch Grok weekly credit usage via the CLI billing proxy
 * (Orca grok-fetcher parity; session from ~/.grok/auth.json).
 */
export async function fetchGrokRateLimits(options?: {
  signal?: AbortSignal;
}): Promise<ProviderRateLimits> {
  const readResult = readGrokAuthSession();
  if (readResult.status === "missing") {
    return result("unavailable", "Not signed in to Grok — run grok login");
  }
  if (readResult.status === "error") {
    return result("error", readResult.error);
  }
  const session = readResult.session;
  if (!isGrokAccessTokenFresh(session)) {
    return result("error", "Grok session expired — run grok login to refresh");
  }

  try {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
      : AbortSignal.timeout(API_TIMEOUT_MS);
    const res = await fetch(BILLING_CREDITS_URL, {
      headers: grokRequestHeaders(session),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      return result("error", `Grok usage request unauthorized (HTTP ${res.status})`);
    }
    if (!res.ok) {
      return result("error", `Grok usage request failed (HTTP ${res.status})`);
    }
    const data: unknown = await res.json();
    const payload =
      typeof data === "object" && data !== null ? (data as GrokBillingResponse) : {};
    const config = resolveBillingConfig(payload);
    if (!config) {
      return result("unavailable", "Grok billing response did not include config");
    }
    const weekly = mapWeeklyCredits(config);
    return result(weekly ? "ok" : "unavailable", weekly ? null : "Grok billing response did not include credit usage", {
      weekly,
    });
  } catch (err) {
    if (options?.signal?.aborted) {
      return result("error", "Rate-limit fetch aborted");
    }
    return result("error", err instanceof Error ? err.message : "Grok usage request failed");
  }
}
