import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderRateLimits, RateLimitWindow } from "./types.ts";
import { parseResetDescription, parseResetTimestamp } from "./format.ts";

const execFileAsync = promisify(execFile);

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";
const API_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 10_000;
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const ACTIVE_CLAUDE_SERVICE = "Claude Code-credentials";
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000;

type ClaudeOauthBlob = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  [key: string]: unknown;
};

type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauthBlob;
  [key: string]: unknown;
};

type OAuthUsageWindow = {
  utilization?: number;
  used_percentage?: number;
  resets_at?: string | number;
};

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow;
  seven_day?: OAuthUsageWindow;
  fable_weekly?: OAuthUsageWindow;
  fable_seven_day?: OAuthUsageWindow;
  seven_day_fable?: OAuthUsageWindow;
};

type TokenEndpointResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
};

type CredentialSource = "keychain" | "credentials-file" | "none";

type CredentialBundle = {
  json: string;
  source: CredentialSource;
  path: string | null;
};

function result(
  status: ProviderRateLimits["status"],
  error: string | null,
  partial?: Partial<ProviderRateLimits>,
): ProviderRateLimits {
  return {
    provider: "claude",
    session: null,
    weekly: null,
    fableWeekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...partial,
  };
}

function getCredentialsFilePath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function getKeychainUser(): string {
  return process.env.USER || process.env.USERNAME || "user";
}

async function readKeychainPassword(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-a", getKeychainUser(), "-w"],
      { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function writeKeychainPassword(service: string, contents: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const user = getKeychainUser();
  // Delete first so -U update path is reliable.
  await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", user], {
    timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
  }).catch(() => {});
  await execFileAsync(
    "security",
    ["add-generic-password", "-s", service, "-a", user, "-w", contents, "-U"],
    { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS },
  );
}

function credentialsFilePathForConfigDir(configDir?: string | null): string {
  const dir = configDir?.trim();
  if (dir) return join(dir, ".credentials.json");
  return getCredentialsFilePath();
}

async function readFromCredentialsFile(configDir?: string | null): Promise<CredentialBundle | null> {
  const path = credentialsFilePathForConfigDir(configDir);
  try {
    const json = await readFile(path, "utf-8");
    const parsed = JSON.parse(json) as ClaudeCredentials;
    if (!parsed?.claudeAiOauth) return null;
    return { json, source: "credentials-file", path };
  } catch {
    return null;
  }
}

async function readFromKeychain(): Promise<CredentialBundle | null> {
  const json = await readKeychainPassword(ACTIVE_CLAUDE_SERVICE);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ClaudeCredentials;
    if (!parsed?.claudeAiOauth) return null;
    return { json, source: "keychain", path: null };
  } catch {
    return null;
  }
}

function isSystemClaudeConfigDir(configDir?: string | null): boolean {
  const dir = configDir?.trim();
  if (!dir) return true;
  // System default is ~/.claude (or CLAUDE_CONFIG_DIR if the user set it globally).
  // Managed accounts live under provider-accounts/claude/<id>/ and must not read Keychain.
  return dir === getCredentialsFilePath().replace(/\/\.credentials\.json$/, "") ||
    dir === join(homedir(), ".claude");
}

export async function hasClaudeAuth(options?: { configDir?: string | null }): Promise<boolean> {
  const configDir = options?.configDir?.trim() || null;
  // Managed profiles use isolated credentials files only (no system Keychain bleed).
  if (configDir && !isSystemClaudeConfigDir(configDir)) {
    return Boolean(await readFromCredentialsFile(configDir));
  }
  const keychain = await readFromKeychain();
  if (keychain) return true;
  const file = await readFromCredentialsFile(configDir);
  return Boolean(file);
}

async function loadCredentials(configDir?: string | null): Promise<CredentialBundle | null> {
  const dir = configDir?.trim() || null;
  // Managed account homes: file only under that dir.
  if (dir && !isSystemClaudeConfigDir(dir)) {
    return readFromCredentialsFile(dir);
  }
  // System default: Keychain first (working Claude Code session), then credentials file.
  // Passing ~/.claude as configDir must NOT skip Keychain — that path is the system home.
  return (await readFromKeychain()) ?? (await readFromCredentialsFile(dir));
}

function parseOauthBlob(credentialsJson: string): ClaudeOauthBlob | null {
  try {
    const parsed = JSON.parse(credentialsJson) as ClaudeCredentials;
    const oauth = parsed?.claudeAiOauth;
    return oauth && typeof oauth === "object" && !Array.isArray(oauth) ? oauth : null;
  } catch {
    return null;
  }
}

function isOauthTokenExpiring(credentialsJson: string, now = Date.now()): boolean {
  const oauth = parseOauthBlob(credentialsJson);
  if (!oauth) return false;
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true;
  return now + OAUTH_EXPIRY_BUFFER_MS >= expiresAt;
}

function applyRefreshedToken(
  credentialsJson: string,
  response: TokenEndpointResponse,
  now = Date.now(),
): string | null {
  let parsed: ClaudeCredentials;
  try {
    parsed = JSON.parse(credentialsJson) as ClaudeCredentials;
  } catch {
    return null;
  }
  const accessToken = response.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") return null;
  const oauth: ClaudeOauthBlob = { ...parsed.claudeAiOauth };
  oauth.accessToken = accessToken;
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    oauth.expiresAt = now + response.expires_in * 1000;
  }
  if (typeof response.refresh_token === "string" && response.refresh_token.trim() !== "") {
    oauth.refreshToken = response.refresh_token;
  }
  if (typeof response.scope === "string" && response.scope.trim() !== "") {
    oauth.scopes = response.scope.split(" ");
  }
  parsed.claudeAiOauth = oauth;
  return JSON.stringify(parsed);
}

async function refreshClaudeOauth(credentialsJson: string, signal?: AbortSignal): Promise<string | null> {
  const oauth = parseOauthBlob(credentialsJson);
  const refreshToken =
    typeof oauth?.refreshToken === "string" && oauth.refreshToken.trim()
      ? oauth.refreshToken.trim()
      : null;
  if (!refreshToken) return null;

  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)])
      : AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: requestSignal,
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as TokenEndpointResponse;
    return applyRefreshedToken(credentialsJson, payload);
  } catch {
    return null;
  }
}

async function persistCredentials(bundle: CredentialBundle, nextJson: string): Promise<void> {
  if (bundle.source === "keychain") {
    await writeKeychainPassword(ACTIVE_CLAUDE_SERVICE, nextJson).catch(() => {});
    return;
  }
  if (bundle.source === "credentials-file" && bundle.path) {
    await writeFile(bundle.path, nextJson, "utf-8").catch(() => {});
  }
}

function mapWindow(raw: OAuthUsageWindow | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!raw) return null;
  const usedPercent =
    typeof raw.utilization === "number"
      ? raw.utilization
      : typeof raw.used_percentage === "number"
        ? raw.used_percentage
        : null;
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: parseResetTimestamp(raw.resets_at),
    resetDescription: parseResetDescription(raw.resets_at),
  };
}

function mapFableWeeklyWindow(data: OAuthUsageResponse): RateLimitWindow | null {
  return (
    mapWindow(data.fable_weekly, 10080) ??
    mapWindow(data.fable_seven_day, 10080) ??
    mapWindow(data.seven_day_fable, 10080)
  );
}

async function fetchViaOAuth(token: string, signal?: AbortSignal): Promise<ProviderRateLimits> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS);

  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      "User-Agent": CLAUDE_CODE_USER_AGENT,
    },
    signal: requestSignal,
  });

  if (!res.ok) {
    throw new Error(`Claude usage request failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as OAuthUsageResponse;
  const session = mapWindow(data.five_hour, 300);
  const weekly = mapWindow(data.seven_day, 10080);
  const fableWeekly = mapFableWeeklyWindow(data);
  return result("ok", null, {
    session,
    weekly,
    fableWeekly,
    error: session || weekly || fableWeekly ? null : "Claude usage response had no windows",
    status: session || weekly || fableWeekly ? "ok" : "unavailable",
  });
}

/**
 * Fetch Claude subscription usage via OAuth endpoint (Orca claude-fetcher parity).
 * Credentials: macOS Keychain first, then ~/.claude/.credentials.json.
 * Proactively refreshes when the access token is near expiry.
 */
export async function fetchClaudeRateLimits(options?: {
  signal?: AbortSignal;
  configDir?: string | null;
}): Promise<ProviderRateLimits> {
  let bundle = await loadCredentials(options?.configDir);
  if (!bundle) {
    return result("unavailable", "Not signed in to Claude — run claude login");
  }

  let credentialsJson = bundle.json;
  if (isOauthTokenExpiring(credentialsJson)) {
    const refreshed = await refreshClaudeOauth(credentialsJson, options?.signal);
    if (refreshed) {
      await persistCredentials(bundle, refreshed);
      credentialsJson = refreshed;
      bundle = { ...bundle, json: refreshed };
    }
  }

  const oauth = parseOauthBlob(credentialsJson);
  const token =
    typeof oauth?.accessToken === "string" && oauth.accessToken.trim()
      ? oauth.accessToken.trim()
      : null;
  if (!token) {
    return result("unavailable", "Claude credentials are missing an access token");
  }

  try {
    return await fetchViaOAuth(token, options?.signal);
  } catch (firstError) {
    // Retry once after a forced refresh (stale file token while Keychain is fresh, etc.).
    const refreshed = await refreshClaudeOauth(credentialsJson, options?.signal);
    if (!refreshed) {
      if (options?.signal?.aborted) {
        return result("error", "Rate-limit fetch aborted");
      }
      // If Keychain/file pair diverges, try the other system source once.
      if (isSystemClaudeConfigDir(options?.configDir) && bundle.source === "credentials-file") {
        const keychain = await readFromKeychain();
        if (keychain && keychain.json !== credentialsJson) {
          try {
            return await fetchClaudeRateLimits({
              signal: options?.signal,
              // Re-enter with null so loadCredentials prefers Keychain.
              configDir: null,
            });
          } catch {
            // fall through
          }
        }
      }
      const message =
        firstError instanceof Error ? firstError.message : "Claude usage request failed";
      const hint =
        message.includes("401") || message.includes("403")
          ? " Session expired — run claude login, then refresh."
          : "";
      return result("error", `${message}${hint}`);
    }
    await persistCredentials(bundle, refreshed);
    const nextOauth = parseOauthBlob(refreshed);
    const nextToken =
      typeof nextOauth?.accessToken === "string" ? nextOauth.accessToken.trim() : "";
    if (!nextToken) {
      return result("error", "Claude token refresh did not return an access token");
    }
    try {
      return await fetchViaOAuth(nextToken, options?.signal);
    } catch (err) {
      if (options?.signal?.aborted) {
        return result("error", "Rate-limit fetch aborted");
      }
      return result("error", err instanceof Error ? err.message : "Claude usage request failed");
    }
  }
}
