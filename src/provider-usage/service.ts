import { getActiveClaudeConfigDir, getActiveCodexHome } from "../provider-accounts/index.ts";
import { fetchClaudeRateLimits, hasClaudeAuth } from "./claude.ts";
import { fetchCodexRateLimits, hasCodexAuth } from "./codex.ts";
import { fetchGrokRateLimits, hasGrokAuthSession } from "./grok.ts";
import type { ProviderRateLimits, ProviderUsageState } from "./types.ts";

const DEFAULT_CACHE_MS = 5 * 60 * 1000; // 5 minutes — Orca min refetch debounce

type CacheEntry = {
  state: ProviderUsageState;
  fetchedAt: number;
  cacheKey: string;
};

let cache: CacheEntry | null = null;
let inFlight: Promise<ProviderUsageState> | null = null;
let inFlightKey = "";

function emptyProvider(
  provider: ProviderRateLimits["provider"],
  status: ProviderRateLimits["status"] = "idle",
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    ...(provider === "claude" ? { fableWeekly: null } : {}),
    updatedAt: 0,
    error: null,
    status,
  };
}

function activeHomes(appDataDir?: string | null) {
  return {
    claudeConfigDir: getActiveClaudeConfigDir({ appDataDir }),
    codexHomePath: getActiveCodexHome({ appDataDir }),
  };
}

function cacheKeyFor(appDataDir?: string | null): string {
  const homes = activeHomes(appDataDir);
  return `${homes.claudeConfigDir}|${homes.codexHomePath}`;
}

async function fetchAll(
  signal?: AbortSignal,
  appDataDir?: string | null,
): Promise<ProviderUsageState> {
  const homes = activeHomes(appDataDir);
  const [codexAuthConfigured, claudeAuthConfigured, grokAuthConfigured] = await Promise.all([
    hasCodexAuth({ codexHomePath: homes.codexHomePath }),
    hasClaudeAuth({ configDir: homes.claudeConfigDir }),
    Promise.resolve(hasGrokAuthSession()),
  ]);

  const [codex, claude, grok] = await Promise.all([
    codexAuthConfigured
      ? fetchCodexRateLimits({ signal, codexHomePath: homes.codexHomePath })
      : Promise.resolve(emptyProvider("codex", "unavailable")),
    claudeAuthConfigured
      ? fetchClaudeRateLimits({ signal, configDir: homes.claudeConfigDir })
      : Promise.resolve(emptyProvider("claude", "unavailable")),
    grokAuthConfigured
      ? fetchGrokRateLimits({ signal })
      : Promise.resolve(emptyProvider("grok", "unavailable")),
  ]);

  return {
    codex,
    claude,
    grok,
    codexAuthConfigured,
    claudeAuthConfigured,
    grokAuthConfigured,
    fetchedAt: Date.now(),
  };
}

/**
 * Return provider usage for Codex / Claude / Grok.
 * Uses the active managed account homes when set (Orca-style account switch).
 * Cached for a few minutes; pass force=true to refresh immediately.
 */
export async function getProviderUsageState(options?: {
  force?: boolean;
  signal?: AbortSignal;
  cacheMs?: number;
  appDataDir?: string | null;
}): Promise<ProviderUsageState> {
  const cacheMs = options?.cacheMs ?? DEFAULT_CACHE_MS;
  const key = cacheKeyFor(options?.appDataDir);
  const now = Date.now();
  if (!options?.force && cache && cache.cacheKey === key && now - cache.fetchedAt < cacheMs) {
    return cache.state;
  }
  if (inFlight && !options?.force && inFlightKey === key) {
    return inFlight;
  }

  const run = fetchAll(options?.signal, options?.appDataDir)
    .then((state) => {
      cache = { state, fetchedAt: state.fetchedAt, cacheKey: key };
      return state;
    })
    .finally(() => {
      inFlight = null;
      inFlightKey = "";
    });

  inFlight = run;
  inFlightKey = key;
  return run;
}

/** Test helper — clear cached usage. */
export function __resetProviderUsageCacheForTests(): void {
  cache = null;
  inFlight = null;
  inFlightKey = "";
}
