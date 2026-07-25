import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readGrokAuthSession, isGrokAccessTokenFresh } from "../provider-usage/grok.ts";
import type { GrokAccountStatus } from "./types.ts";

export function defaultClaudeConfigDir(): string {
  return join(homedir(), ".claude");
}

export function defaultCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".codex");
}

export function readClaudeIdentity(configDir: string): {
  email: string | null;
  hasAuth: boolean;
  organizationName: string | null;
} {
  const credPath = join(configDir, ".credentials.json");
  const oauthPath = join(configDir, "oauth-account.json");
  let email: string | null = null;
  let organizationName: string | null = null;
  let hasAuth = false;

  if (existsSync(oauthPath)) {
    try {
      const oauth = JSON.parse(readFileSync(oauthPath, "utf8")) as {
        emailAddress?: string;
        email?: string;
        organizationName?: string;
      };
      email =
        (typeof oauth.emailAddress === "string" && oauth.emailAddress) ||
        (typeof oauth.email === "string" && oauth.email) ||
        null;
      organizationName =
        typeof oauth.organizationName === "string" ? oauth.organizationName : null;
    } catch {
      // ignore
    }
  }

  if (existsSync(credPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credPath, "utf8")) as {
        claudeAiOauth?: { accessToken?: string; refreshToken?: string; email?: string };
      };
      const oauth = parsed?.claudeAiOauth;
      hasAuth = Boolean(
        (typeof oauth?.accessToken === "string" && oauth.accessToken.trim()) ||
          (typeof oauth?.refreshToken === "string" && oauth.refreshToken.trim()),
      );
      if (!email && typeof oauth?.email === "string") email = oauth.email;
    } catch {
      // ignore
    }
  }

  return { email, hasAuth, organizationName };
}

/** Best-effort email from Codex auth JWT payload. */
export function readCodexIdentity(codexHome: string): { email: string | null; hasAuth: boolean } {
  const authPath = join(codexHome, "auth.json");
  if (!existsSync(authPath)) return { email: null, hasAuth: false };
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
      tokens?: { access_token?: string; id_token?: string; account_id?: string };
    };
    const access = parsed?.tokens?.access_token;
    const idToken = parsed?.tokens?.id_token;
    const hasAuth = typeof access === "string" && access.trim().length > 0;
    const email = decodeJwtEmail(idToken) || decodeJwtEmail(access);
    return { email, hasAuth };
  } catch {
    return { email: null, hasAuth: false };
  }
}

function decodeJwtEmail(token: string | undefined): string | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
      "https://api.openai.com/profile"?: { email?: string };
    };
    if (typeof payload.email === "string" && payload.email.includes("@")) return payload.email;
    if (typeof payload.preferred_username === "string" && payload.preferred_username.includes("@")) {
      return payload.preferred_username;
    }
    const profileEmail = payload["https://api.openai.com/profile"]?.email;
    if (typeof profileEmail === "string" && profileEmail.includes("@")) return profileEmail;
  } catch {
    return null;
  }
  return null;
}

export function getGrokAccountStatus(): GrokAccountStatus {
  const authPath = join(
    process.env.GROK_HOME?.trim() || join(homedir(), ".grok"),
    "auth.json",
  );
  const read = readGrokAuthSession();
  if (read.status === "missing") {
    return {
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null,
      authPath,
    };
  }
  if (read.status === "error") {
    return {
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: read.error,
      authPath,
    };
  }
  return {
    signedIn: true,
    email: read.session.email,
    teamId: read.session.teamId,
    tokenFresh: isGrokAccessTokenFresh(read.session),
    error: null,
    authPath,
  };
}
