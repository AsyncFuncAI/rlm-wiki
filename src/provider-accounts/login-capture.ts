/**
 * Orca-style CLI login capture for managed Claude / Codex accounts.
 * Spawns the CLI with an isolated home, waits for browser OAuth, then reads
 * credentials + identity so Settings can show a real email (not "Sign in pending").
 */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readCodexIdentity } from "./identities.ts";

const execFileAsync = promisify(execFile);

const CLAUDE_LOGIN_TIMEOUT_MS = 180_000;
const CODEX_LOGIN_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 20_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const ACTIVE_CLAUDE_SERVICE = "Claude Code-credentials";

export type CapturedClaudeLogin = {
  email: string;
  organizationName: string | null;
  organizationUuid: string | null;
  credentialsJson: string;
  oauthAccount: unknown;
};

export type CapturedCodexLogin = {
  email: string;
  workspaceLabel: string | null;
  providerAccountId: string | null;
};

function resolveBin(name: string): string {
  try {
    const out = execFileSync("which", [name], { encoding: "utf8" }).trim();
    if (out) return out;
  } catch {
    // fall through to known install locations
  }
  const candidates = [
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".bun", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return name;
}

function keychainUser(): string {
  return process.env.USER || process.env.USERNAME || "user";
}

function scopedClaudeKeychainService(configDir: string): string {
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${ACTIVE_CLAUDE_SERVICE}-${suffix}`;
}

async function readKeychain(service: string, account: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function deleteKeychain(service: string, account: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await execFileAsync("security", ["delete-generic-password", "-s", service, "-a", account], {
    timeout: KEYCHAIN_TIMEOUT_MS,
  }).catch(() => {});
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options?: { allowFailure?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      // ignore stdin so CLIs do not hang waiting for a TTY
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
      reject(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser sign-in. Complete login in the browser, then try again.`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 50_000) stdout = stdout.slice(-40_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 50_000) stderr = stderr.slice(-40_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      if (code === 0 || options?.allowFailure) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          output
            ? `CLI exited with code ${code}: ${output.slice(0, 500)}`
            : `CLI exited with code ${code}`,
        ),
      );
    });
  });
}

function readOauthAccountFromConfigDir(configDir: string): unknown {
  for (const name of [".claude.json", "config.json", ".config.json"]) {
    const path = join(configDir, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed.oauthAccount) return parsed.oauthAccount;
    } catch {
      continue;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  const value = obj?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function captureClaudeCredentials(
  configDir: string,
  previousLegacyKeychain: string | null,
): Promise<string | null> {
  if (process.platform === "darwin") {
    const scoped = await readKeychain(scopedClaudeKeychainService(configDir), keychainUser());
    if (scoped) return scoped;
    const legacy = await readKeychain(ACTIVE_CLAUDE_SERVICE, keychainUser());
    if (legacy && legacy !== previousLegacyKeychain) return legacy;
  }
  const credentialsPath = join(configDir, ".credentials.json");
  return existsSync(credentialsPath) ? readFileSync(credentialsPath, "utf8") : null;
}

/**
 * Run `claude auth login --claudeai` in an isolated config dir, capture OAuth
 * credentials + identity (email/org), without permanently changing the system login.
 */
export async function captureClaudeLogin(): Promise<CapturedClaudeLogin> {
  const claudeBin = resolveBin("claude");
  const tempConfig = mkdtempSync(join(tmpdir(), "grok-wiki-claude-login-"));
  const previousLegacyKeychain = await readKeychain(ACTIVE_CLAUDE_SERVICE, keychainUser());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: tempConfig,
  };

  try {
    await runCommand(claudeBin, ["auth", "login", "--claudeai"], env, CLAUDE_LOGIN_TIMEOUT_MS);

    const statusOutput = await runCommand(
      claudeBin,
      ["auth", "status", "--json"],
      env,
      STATUS_TIMEOUT_MS,
      { allowFailure: true },
    );

    const credentialsJson = await captureClaudeCredentials(tempConfig, previousLegacyKeychain);
    if (!credentialsJson) {
      throw new Error(
        "Claude login finished, but no OAuth credentials were captured. Try again, or run claude auth login in a terminal.",
      );
    }

    const oauthAccount = readOauthAccountFromConfigDir(tempConfig);
    let status: Record<string, unknown> | null = null;
    try {
      // status may be pure JSON or mixed with log lines
      const jsonStart = statusOutput.indexOf("{");
      const jsonEnd = statusOutput.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        status = asRecord(JSON.parse(statusOutput.slice(jsonStart, jsonEnd + 1)));
      }
    } catch {
      status = null;
    }
    const oauth = asRecord(oauthAccount);
    let credentials: Record<string, unknown> | null = null;
    try {
      credentials = asRecord(JSON.parse(credentialsJson));
    } catch {
      credentials = null;
    }
    const credentialOauth = asRecord(credentials?.claudeAiOauth);

    const email =
      readString(status, "email") ||
      readString(oauth, "emailAddress") ||
      readString(oauth, "email") ||
      readString(credentialOauth, "email");
    if (!email) {
      throw new Error(
        "Claude login finished, but the account email could not be resolved. Sign in with the account you want (for example sheing@falcon5.co), then try again.",
      );
    }

    const organizationName =
      readString(status, "orgName") ||
      readString(status, "organizationName") ||
      readString(oauth, "organizationName");

    return {
      email,
      organizationName,
      organizationUuid:
        readString(status, "orgId") ||
        readString(status, "organizationUuid") ||
        readString(oauth, "organizationUuid"),
      credentialsJson,
      oauthAccount:
        oauthAccount ||
        (email
          ? {
              emailAddress: email,
              organizationName,
              organizationUuid:
                readString(status, "orgId") ||
                readString(status, "organizationUuid") ||
                readString(oauth, "organizationUuid"),
            }
          : null),
    };
  } finally {
    // Restore system Keychain if login overwrote the legacy active item.
    if (process.platform === "darwin") {
      await deleteKeychain(scopedClaudeKeychainService(tempConfig), keychainUser());
      try {
        const currentLegacy = await readKeychain(ACTIVE_CLAUDE_SERVICE, keychainUser());
        if (previousLegacyKeychain && currentLegacy !== previousLegacyKeychain) {
          await deleteKeychain(ACTIVE_CLAUDE_SERVICE, keychainUser());
          await execFileAsync(
            "security",
            [
              "add-generic-password",
              "-s",
              ACTIVE_CLAUDE_SERVICE,
              "-a",
              keychainUser(),
              "-w",
              previousLegacyKeychain,
              "-U",
            ],
            { timeout: KEYCHAIN_TIMEOUT_MS },
          ).catch(() => {});
        }
      } catch {
        // non-fatal
      }
    }
    rmSync(tempConfig, { recursive: true, force: true });
  }
}

/**
 * Run `codex login` with CODEX_HOME set to the managed home, then read identity.
 */
export async function captureCodexLogin(managedHomePath: string): Promise<CapturedCodexLogin> {
  mkdirSync(managedHomePath, { recursive: true });
  const codexBin = resolveBin("codex");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: managedHomePath,
  };

  await runCommand(codexBin, ["login"], env, CODEX_LOGIN_TIMEOUT_MS);

  const identity = readCodexIdentity(managedHomePath);
  if (!identity.email || !identity.hasAuth) {
    throw new Error(
      "Codex login finished, but the account email could not be resolved. Complete browser sign-in, then try again.",
    );
  }
  return {
    email: identity.email,
    workspaceLabel: null,
    providerAccountId: null,
  };
}

/** Persist captured Claude credentials into a managed home for CLAUDE_CONFIG_DIR use. */
export function writeClaudeManagedHome(
  homePath: string,
  captured: CapturedClaudeLogin,
): void {
  mkdirSync(homePath, { recursive: true });
  writeFileSync(join(homePath, ".credentials.json"), captured.credentialsJson, "utf8");
  if (captured.oauthAccount) {
    writeFileSync(
      join(homePath, "oauth-account.json"),
      `${JSON.stringify(captured.oauthAccount, null, 2)}\n`,
      "utf8",
    );
  }
  writeFileSync(join(homePath, ".grok-wiki-managed-claude"), "1\n", "utf8");
}
