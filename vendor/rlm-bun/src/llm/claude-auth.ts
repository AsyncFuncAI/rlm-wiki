/**
 * Claude Code authentication resolution.
 *
 * Reads Claude credentials from (in priority order):
 * 1. Explicit apiKey option (highest priority)
 * 2. Environment variable (ANTHROPIC_API_KEY)
 * 3. Claude config file (~/.claude.json or ~/.config/claude/credentials.json)
 * 4. Platform credential store (macOS Keychain, extensible to Linux/Windows)
 */

import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

export type CredentialKind = "apiKey" | "oauth";
export type CredentialSource = "env" | "config" | "keychain" | "explicit";

export interface ClaudeCredentials {
  apiKey: string;
  source: CredentialSource;
  kind: CredentialKind;
}

// ── Logger Interface ────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug: (msg, meta) => console.log(msg, meta ?? ""),
  warn: (msg, meta) => console.warn(msg, meta ?? ""),
};

export const noopLogger: Logger = {
  debug: () => {},
  warn: () => {},
};

// ── execFile Dependency Injection ───────────────────────────────────────

/** Signature for the shell-free exec function, injectable for testing. */
export type ExecFileFn = (cmd: string, args: string[]) => Buffer;

const defaultExecFile: ExecFileFn = (cmd, args) =>
  execFileSync(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

// ── Credential Validation ───────────────────────────────────────────────

/** Matches `sk-ant-*` Anthropic API keys (40+ chars after prefix). */
const ANTHROPIC_KEY_RE = /^sk-ant-[a-zA-Z0-9_-]{40,}$/;

/**
 * Check if a string looks like a valid credential.
 * API keys must match `sk-ant-*`; OAuth tokens are long opaque strings (>100 chars).
 */
export function isValidCredential(value: string): boolean {
  return ANTHROPIC_KEY_RE.test(value) || value.length > 100;
}

/** Determine the credential kind from the raw string. */
function inferKind(value: string): CredentialKind {
  return ANTHROPIC_KEY_RE.test(value) ? "apiKey" : "oauth";
}

// ── OAuth Expiry ────────────────────────────────────────────────────────

/**
 * Check if an OAuth token's expiry timestamp has been reached.
 * Applies a 60-second clock-skew buffer by default to avoid using
 * tokens that are about to expire mid-request.
 */
export function isExpired(
  expiresAt: number | undefined,
  clockSkewMs = 60_000
): boolean {
  return expiresAt !== undefined && Date.now() + clockSkewMs >= expiresAt;
}

// ── Zod Schemas at I/O Boundaries ───────────────────────────────────────

const ClaudeOAuthSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.number().optional(),
});

const ClaudeConfigSchema = z
  .object({
    claudeAiOauth: ClaudeOAuthSchema.optional(),
    apiKey: z.string().optional(),
    api_key: z.string().optional(),
    oauthAccessToken: z.string().optional(),
    oauth_access_token: z.string().optional(),
  })
  .passthrough(); // forward-compat: ignore unknown fields

const KeychainOAuthSchema = z.object({
  claudeAiOauth: ClaudeOAuthSchema.optional(),
});

// ── Keychain Service Constants ──────────────────────────────────────────

export const KEYCHAIN_SERVICE_NAMES = {
  CLAUDE_CLI: "claude-cli",
  ANTHROPIC_API_KEY: "anthropic-api-key",
  CLAUDE_CODE: "Claude Code-credentials",
} as const satisfies Record<string, string>;

// ── Zod Options Schema ──────────────────────────────────────────────────

const ResolveCredentialsOptsSchema = z.object({
  apiKey: z.string().optional(),
});
type ResolveCredentialsOpts = z.infer<typeof ResolveCredentialsOptsSchema>;

// ── Credential Cache ────────────────────────────────────────────────────

function makeCredentialCache() {
  type State =
    | { checked: false }
    | { checked: true; value: ClaudeCredentials | null };

  let state: State = { checked: false };

  return {
    get: (): ClaudeCredentials | null | undefined =>
      state.checked ? state.value : undefined,
    set: (value: ClaudeCredentials | null) => {
      state = { checked: true, value };
    },
    /** Reset the cache — call in test teardowns. */
    clear: () => {
      state = { checked: false };
    },
  };
}

export const credentialCache = makeCredentialCache();

// ── Credential Store Abstraction ────────────────────────────────────────

/**
 * Platform-agnostic credential store interface.
 * Currently only macOS Keychain is implemented. Linux/Windows stores
 * can be added by implementing this interface.
 */
export interface CredentialStore {
  readonly platformName: string;
  isAvailable(): boolean;
  lookup(service: string, execFile: ExecFileFn): string | null;
}

class MacOsKeychainStore implements CredentialStore {
  readonly platformName = "macOS Keychain";

  isAvailable(): boolean {
    return platform() === "darwin";
  }

  lookup(service: string, execFile: ExecFileFn): string | null {
    try {
      const result = execFile("security", [
        "find-generic-password",
        "-s",
        service,
        "-w",
      ]);
      return result.toString("utf-8").trim() || null;
    } catch {
      return null;
    }
  }
}

/** Registered credential stores — extend by appending to this array. */
export const CREDENTIAL_STORES: CredentialStore[] = [
  new MacOsKeychainStore(),
  // Future: new LinuxSecretServiceStore(), new WindowsCredentialManagerStore()
];

// ── Source Resolvers ────────────────────────────────────────────────────

/**
 * Attempt to find Claude credentials in environment variables.
 */
export function getCredentialsFromEnv(
  logger: Logger = consoleLogger
): ClaudeCredentials | null {
  const raw = process.env.ANTHROPIC_API_KEY;
  if (!raw) return null;

  if (!isValidCredential(raw)) {
    logger.warn("[claude/auth] ANTHROPIC_API_KEY has invalid format — skipping");
    return null;
  }

  return { apiKey: raw, source: "env", kind: inferKind(raw) };
}

/**
 * Attempt to find Claude credentials in local config files.
 */
export function getCredentialsFromConfig(
  logger: Logger = consoleLogger
): ClaudeCredentials | null {
  const home = homedir();
  const configPaths = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude.json"),
    join(home, ".config", "claude", "credentials.json"),
    join(home, ".config", "claude", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      const configResult = ClaudeConfigSchema.safeParse(parsed);

      if (!configResult.success) {
        logger.warn("[claude/auth] Config failed schema validation", {
          path: configPath,
          errors: configResult.error.issues,
        });
        continue;
      }

      const config = configResult.data;

      // Check for OAuth access token (Claude subscription)
      if (config.claudeAiOauth?.accessToken) {
        if (isExpired(config.claudeAiOauth.expiresAt)) {
          logger.warn("[claude/auth] OAuth token expired, skipping", {
            path: configPath,
            expiresAt: config.claudeAiOauth.expiresAt
              ? new Date(config.claudeAiOauth.expiresAt).toISOString()
              : undefined,
          });
          continue;
        }
        logger.debug("[claude/auth] Found OAuth credentials in: " + configPath);
        return {
          apiKey: config.claudeAiOauth.accessToken,
          source: "config",
          kind: "oauth",
        };
      }

      // Check legacy formats
      const apiKey = config.apiKey || config.api_key;
      const oauthAccessToken =
        config.oauthAccessToken || config.oauth_access_token;

      if (apiKey) {
        if (!isValidCredential(apiKey)) {
          logger.warn(
            "[claude/auth] API key in config has invalid format — skipping",
            { path: configPath }
          );
          continue;
        }
        logger.debug("[claude/auth] Found API key in: " + configPath);
        return { apiKey, source: "config", kind: "apiKey" };
      }

      if (oauthAccessToken) {
        logger.debug("[claude/auth] Found OAuth credentials in: " + configPath);
        return {
          apiKey: oauthAccessToken,
          source: "config",
          kind: "oauth",
        };
      }
    } catch (error) {
      logger.warn("[claude/auth] Failed to parse config at " + configPath, {
        error: String(error),
      });
    }
  }

  return null;
}

/**
 * Parse a raw keychain result for a given service into credentials.
 * Handles both raw API keys and JSON blobs (Claude Code OAuth).
 */
function parseKeychainResult(
  raw: string,
  service: string,
  logger: Logger
): ClaudeCredentials | null {
  // For Claude Code-credentials, the value is a JSON blob
  if (service === KEYCHAIN_SERVICE_NAMES.CLAUDE_CODE) {
    try {
      const parsed = KeychainOAuthSchema.parse(JSON.parse(raw));
      const token = parsed.claudeAiOauth?.accessToken;
      if (token) {
        if (isExpired(parsed.claudeAiOauth?.expiresAt)) {
          logger.warn(
            "[claude/auth] Keychain OAuth token expired, skipping",
            { service }
          );
          return null;
        }
        logger.debug(
          `[claude/auth] Found OAuth credentials in Keychain (${service})`
        );
        return { apiKey: token, source: "keychain", kind: "oauth" };
      }
    } catch {
      // Not valid JSON or schema mismatch — treat as raw key if it looks like one
      if (raw.startsWith("sk-")) {
        logger.debug(
          `[claude/auth] Found API key in Keychain (${service})`
        );
        return { apiKey: raw, source: "keychain", kind: "apiKey" };
      }
    }
    return null;
  }

  // For other services, the value is a raw API key
  if (!isValidCredential(raw)) {
    logger.warn(
      `[claude/auth] Keychain credential (${service}) has invalid format — skipping`
    );
    return null;
  }

  logger.debug(
    `[claude/auth] Found credentials in Keychain (${service})`
  );
  return { apiKey: raw, source: "keychain", kind: inferKind(raw) };
}

/**
 * Attempt to find Claude credentials in platform credential stores.
 * Uses dependency-injected execFile for testability.
 */
export function getCredentialsFromKeychain(
  execFile: ExecFileFn = defaultExecFile,
  logger: Logger = consoleLogger
): ClaudeCredentials | null {
  for (const store of CREDENTIAL_STORES) {
    if (!store.isAvailable()) continue;

    for (const service of Object.values(KEYCHAIN_SERVICE_NAMES)) {
      const raw = store.lookup(service, execFile);
      if (raw) {
        const creds = parseKeychainResult(raw, service, logger);
        if (creds) return creds;
      }
    }
  }

  return null;
}

// ── Main Resolver ───────────────────────────────────────────────────────

/**
 * Resolve Claude credentials by checking all available sources in priority order:
 * 1. Explicit apiKey option (highest priority)
 * 2. Environment variable (ANTHROPIC_API_KEY)
 * 3. Local config files (OAuth tokens from Claude CLI subscription)
 * 4. Platform credential stores (macOS Keychain, etc.)
 *
 * Results are cached — subsequent calls return the same credentials without re-logging.
 */
export function resolveClaudeCredentials(
  opts: ResolveCredentialsOpts = {},
  logger: Logger = consoleLogger
): ClaudeCredentials | null {
  const validated = ResolveCredentialsOptsSchema.parse(opts);

  // Explicit API key takes absolute priority (bypass cache)
  if (validated.apiKey) {
    logger.debug("[claude/auth] Using explicit API key from options");
    return { apiKey: validated.apiKey, source: "explicit", kind: "apiKey" };
  }

  // Return cached result if already resolved
  const cached = credentialCache.get();
  if (cached !== undefined) return cached;

  // Priority order: env → config → keychain
  const fromEnv = getCredentialsFromEnv(logger);
  if (fromEnv) {
    credentialCache.set(fromEnv);
    return fromEnv;
  }

  const fromConfig = getCredentialsFromConfig(logger);
  if (fromConfig) {
    credentialCache.set(fromConfig);
    return fromConfig;
  }

  const fromKeychain = getCredentialsFromKeychain(defaultExecFile, logger);
  if (fromKeychain) {
    credentialCache.set(fromKeychain);
    return fromKeychain;
  }

  credentialCache.set(null);
  return null;
}
