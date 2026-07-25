/** Provider usage / rate-limit shapes, aligned with Orca's rate-limit-types. */

export type RateLimitWindow = {
  /** Percentage of the window consumed (0–100). */
  usedPercent: number;
  /** Window duration in minutes: 300 (5h) or 10080 (7d). */
  windowMinutes: number;
  /** Unix ms timestamp when the window resets, if known. */
  resetsAt: number | null;
  /** Human-readable reset description, e.g. "2:30 PM" or "Thu". */
  resetDescription: string | null;
};

export type ProviderRateLimitStatus = "idle" | "fetching" | "ok" | "error" | "unavailable";

export type UsageProviderId = "codex" | "claude" | "grok";

export type ProviderRateLimits = {
  provider: UsageProviderId;
  /** 5-hour session window, null if not available. */
  session: RateLimitWindow | null;
  /** 7-day weekly window, null if not available. */
  weekly: RateLimitWindow | null;
  /** Claude Fable 7-day weekly window, null if not available. */
  fableWeekly?: RateLimitWindow | null;
  /** Unix ms timestamp of the last successful data update. */
  updatedAt: number;
  /** Human-readable error message, null when status is 'ok'. */
  error: string | null;
  status: ProviderRateLimitStatus;
};

export type ProviderUsageState = {
  codex: ProviderRateLimits | null;
  claude: ProviderRateLimits | null;
  grok: ProviderRateLimits | null;
  /** True when ~/.grok/auth.json (or GROK_HOME) has a session. */
  grokAuthConfigured: boolean;
  /** True when Claude credentials (file or keychain) are present. */
  claudeAuthConfigured: boolean;
  /** True when ~/.codex/auth.json has tokens. */
  codexAuthConfigured: boolean;
  fetchedAt: number;
};
