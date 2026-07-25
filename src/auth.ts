import { createHash, createPublicKey, createVerify, randomBytes, type KeyObject } from "node:crypto";

export type AuthMode = "off" | "dev" | "cloudflare_access";

export interface AuthIdentity {
  userId: string;
  email: string;
  authMode: AuthMode;
}

/** Result of authenticating a request, including optional response cookies. */
export interface AuthResult {
  identity: AuthIdentity;
  /** Set-Cookie header value when a new anonymous session was minted (AUTH_MODE=off). */
  setCookie?: string;
}

/** HttpOnly cookie that scopes product storage for open (AUTH_MODE=off) deployments. */
export const ANON_SESSION_COOKIE = "rlm_wiki_anon";
const ANON_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 400; // ~13 months

interface JwksCache {
  url: string;
  expiresAt: number;
  keys: Map<string, KeyObject>;
}

let jwksCache: JwksCache | null = null;

export function authMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim().toLowerCase();
  if (raw === "cloudflare_access" || raw === "dev" || raw === "off") return raw;
  return "off";
}

/**
 * Authenticate a request.
 *
 * AUTH_MODE=off (public BYOK hosting): mint or reuse a per-browser anonymous
 * session cookie so users do not all collapse into one shared tenant. This is
 * isolation-by-cookie, not login. It is intentionally weaker than Cloudflare
 * Access, but far safer than one global `local@rlm-wiki.dev` identity.
 */
export async function authenticateRequest(req: Request): Promise<AuthResult | null> {
  const mode = authMode();
  if (mode === "off") {
    return anonymousAuthResult(req);
  }
  if (mode === "dev") {
    const headerEmail = req.headers.get("x-rlm-wiki-dev-user");
    return {
      identity: identityFromEmail(headerEmail || process.env.RLM_WIKI_DEV_USER_EMAIL || "dev@rlm-wiki.local", mode),
    };
  }
  return { identity: await authenticateCloudflareAccess(req) };
}

export function identityFromEmail(emailInput: string, authModeValue: AuthMode): AuthIdentity {
  const email = normalizeEmail(emailInput);
  return {
    email,
    authMode: authModeValue,
    userId: createHash("sha256").update(email).digest("hex").slice(0, 32),
  };
}

function anonymousAuthResult(req: Request): AuthResult {
  const existing = anonIdFromRequest(req);
  if (existing) {
    return { identity: identityFromAnonId(existing) };
  }
  const userId = randomBytes(16).toString("hex");
  return {
    identity: identityFromAnonId(userId),
    setCookie: anonSessionCookie(userId),
  };
}

function identityFromAnonId(userId: string): AuthIdentity {
  return {
    userId,
    email: `anon-${userId.slice(0, 8)}@rlm-wiki.local`,
    authMode: "off",
  };
}

function anonIdFromRequest(req: Request): string | null {
  const header = req.headers.get("x-rlm-wiki-anon-id")?.trim() || "";
  if (isAnonId(header)) return header.toLowerCase();
  const cookie = cookieValue(req.headers.get("cookie") || "", ANON_SESSION_COOKIE);
  if (isAnonId(cookie)) return cookie.toLowerCase();
  return null;
}

function isAnonId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value.trim());
}

export function anonSessionCookie(userId: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ANON_SESSION_COOKIE}=${userId}; Path=/; Max-Age=${ANON_SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function cookieValue(header: string, name: string): string {
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("=").trim());
  }
  return "";
}

async function authenticateCloudflareAccess(req: Request): Promise<AuthIdentity> {
  const token = req.headers.get("cf-access-jwt-assertion") || "";
  if (!token) throw authError("Missing Cloudflare Access assertion.", 401);

  const teamDomain = cloudflareTeamDomain();
  const audience = process.env.RLM_WIKI_CF_ACCESS_AUD?.trim() || process.env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    throw authError("Cloudflare Access auth requires RLM_WIKI_CF_ACCESS_TEAM_DOMAIN and RLM_WIKI_CF_ACCESS_AUD.", 500);
  }

  const payload = await verifyAccessJwt(token, teamDomain, audience);
  const email =
    stringClaim(payload.email) ||
    req.headers.get("cf-access-authenticated-user-email") ||
    stringClaim(payload.common_name) ||
    stringClaim(payload.sub);
  if (!email) throw authError("Cloudflare Access assertion did not include a user email.", 401);
  return identityFromEmail(email, "cloudflare_access");
}

function cloudflareTeamDomain(): string {
  const raw = process.env.RLM_WIKI_CF_ACCESS_TEAM_DOMAIN?.trim() || process.env.CF_ACCESS_TEAM_DOMAIN?.trim() || process.env.TEAM_DOMAIN?.trim() || "";
  if (!raw) return "";
  return raw.startsWith("https://") ? raw.replace(/\/+$/, "") : `https://${raw.replace(/\/+$/, "")}`;
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<Record<string, unknown>> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw authError("Malformed Cloudflare Access assertion.", 401);

  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  if (header.alg !== "RS256") throw authError("Unsupported Cloudflare Access JWT algorithm.", 401);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) throw authError("Cloudflare Access JWT is missing a key id.", 401);

  const iss = stringClaim(payload.iss);
  if (iss !== teamDomain) throw authError("Cloudflare Access JWT issuer mismatch.", 401);
  if (!audienceMatches(payload.aud, audience)) throw authError("Cloudflare Access JWT audience mismatch.", 401);
  const now = Math.floor(Date.now() / 1000);
  if (numberClaim(payload.exp) <= now) throw authError("Cloudflare Access JWT expired.", 401);
  const nbf = numberClaim(payload.nbf);
  if (nbf && nbf > now + 60) throw authError("Cloudflare Access JWT is not valid yet.", 401);

  const key = (await loadAccessKeys(teamDomain)).get(kid);
  if (!key) throw authError("Cloudflare Access signing key not found.", 401);
  const ok = verifyWithNodeCrypto(token, key);
  if (!ok) throw authError("Cloudflare Access JWT signature verification failed.", 401);
  return payload;
}

function verifyWithNodeCrypto(token: string, key: KeyObject): boolean {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  return verifier.verify(key, Buffer.from(base64UrlToBytes(encodedSignature)));
}

async function loadAccessKeys(teamDomain: string): Promise<Map<string, KeyObject>> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache?.url === url && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(url);
  if (!response.ok) throw authError(`Could not load Cloudflare Access certs (${response.status}).`, 500);
  const payload = await response.json() as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, KeyObject>();
  for (const jwk of payload.keys ?? []) {
    const kid = typeof jwk.kid === "string" ? jwk.kid : "";
    if (!kid) continue;
    keys.set(kid, createPublicKey({ key: jwk, format: "jwk" }));
  }
  jwksCache = { url, expiresAt: Date.now() + 10 * 60_000, keys };
  return keys;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
  } catch {
    throw authError("Malformed Cloudflare Access JWT payload.", 401);
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.map(String).includes(expected);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email) throw authError("Authenticated user email is empty.", 401);
  return email;
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberClaim(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function authError(message: string, status: number): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}
