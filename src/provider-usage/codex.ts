import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderRateLimits, RateLimitWindow } from "./types.ts";
import { parseResetDescription, parseResetTimestamp } from "./format.ts";

const BACKEND_TIMEOUT_MS = 10_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type CodexAuthFile = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

type BackendRateLimitWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
};

type BackendUsageResponse = {
  plan_type?: string;
  rate_limit?: {
    primary_window?: BackendRateLimitWindow | null;
    secondary_window?: BackendRateLimitWindow | null;
  };
};

function getCodexHomePath(override?: string | null): string {
  const fromOverride = override?.trim();
  if (fromOverride) return fromOverride;
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".codex");
}

export async function hasCodexAuth(options?: { codexHomePath?: string | null }): Promise<boolean> {
  try {
    const auth = await readCodexAuth(options?.codexHomePath);
    return Boolean(auth?.tokens?.access_token);
  } catch {
    return false;
  }
}

async function readCodexAuth(codexHomePath?: string | null): Promise<CodexAuthFile | null> {
  const authPath = join(getCodexHomePath(codexHomePath), "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    return JSON.parse(raw) as CodexAuthFile;
  } catch {
    return null;
  }
}

function mapBackendUsageWindow(
  raw: BackendRateLimitWindow | null | undefined,
  fallbackWindowMinutes: number,
): RateLimitWindow | null {
  if (!raw || typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent)) {
    return null;
  }
  const limitWindowSeconds = raw.limit_window_seconds;
  const windowMinutes =
    typeof limitWindowSeconds === "number" &&
    Number.isFinite(limitWindowSeconds) &&
    limitWindowSeconds > 0
      ? Math.ceil(limitWindowSeconds / 60)
      : fallbackWindowMinutes;

  const resetsAt = parseResetTimestamp(raw.reset_at);
  return {
    usedPercent: Math.min(100, Math.max(0, raw.used_percent)),
    windowMinutes,
    resetsAt,
    resetDescription: parseResetDescription(raw.reset_at),
  };
}

function result(
  status: ProviderRateLimits["status"],
  error: string | null,
  partial?: Partial<ProviderRateLimits>,
): ProviderRateLimits {
  return {
    provider: "codex",
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...partial,
  };
}

/**
 * Fetch Codex rate limits via ChatGPT backend usage endpoint
 * (same contract Codex CLI / Orca uses).
 */
export async function fetchCodexRateLimits(options?: {
  signal?: AbortSignal;
  codexHomePath?: string | null;
}): Promise<ProviderRateLimits> {
  const auth = await readCodexAuth(options?.codexHomePath);
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    return result("unavailable", "Not signed in to Codex — run codex login");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "rlm-wiki",
  };
  if (auth?.tokens?.account_id) {
    headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  }

  try {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)])
      : AbortSignal.timeout(BACKEND_TIMEOUT_MS);
    const response = await fetch(USAGE_URL, { headers, signal });
    if (response.status === 401 || response.status === 403) {
      return result("error", `Codex usage unauthorized (HTTP ${response.status})`);
    }
    if (!response.ok) {
      return result("error", `Codex usage request failed (HTTP ${response.status})`);
    }
    const payload = (await response.json()) as BackendUsageResponse;
    if (typeof payload.plan_type !== "string") {
      return result("error", "Codex usage response was incomplete");
    }
    const session = mapBackendUsageWindow(payload.rate_limit?.primary_window, 300);
    const weekly = mapBackendUsageWindow(payload.rate_limit?.secondary_window, 10080);
    return result("ok", null, {
      session,
      weekly,
      error: session || weekly ? null : "Codex usage response had no windows",
      status: session || weekly ? "ok" : "unavailable",
    });
  } catch (err) {
    if (options?.signal?.aborted) {
      return result("error", "Rate-limit fetch aborted");
    }
    return result("error", err instanceof Error ? err.message : "Codex usage request failed");
  }
}
