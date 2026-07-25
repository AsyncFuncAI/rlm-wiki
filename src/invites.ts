import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { authMode, normalizeEmail, type AuthIdentity } from "./auth.ts";

const INVITE_COOKIE = "rlm_wiki_invite";
const DEFAULT_INVITE_DAYS = 14;

interface InvitePayload {
  v: 1;
  email: string;
  exp: number;
  iat: number;
  nonce: string;
  redirectPath?: string;
}

export interface InviteLink {
  email: string;
  url: string;
  expiresAt: string;
}

export interface InviteGateResult {
  allowed: boolean;
  reason?: string;
  headers?: Record<string, string>;
}

export function inviteGateEnabled(): boolean {
  if (authMode() === "off") return false;
  if (truthy(process.env.RLM_WIKI_REQUIRE_INVITE)) return true;
  return Boolean(emailSet(process.env.RLM_WIKI_ALLOWED_EMAILS).size || inviteSecret());
}

export function isInviteAdmin(identity: AuthIdentity): boolean {
  // AUTH_MODE=off is the open public surface. Do not treat every anonymous
  // browser session as an invite admin.
  if (authMode() === "off") return false;
  const admins = emailSet(process.env.RLM_WIKI_ADMIN_EMAILS);
  if (admins.size) return admins.has(identity.email);
  const allowed = emailSet(process.env.RLM_WIKI_ALLOWED_EMAILS);
  if (allowed.size) return allowed.has(identity.email);
  return authMode() === "dev";
}

export function authorizeInviteRequest(req: Request, identity: AuthIdentity): InviteGateResult {
  if (!inviteGateEnabled()) return { allowed: true };
  if (isInviteAdmin(identity)) return { allowed: true };
  if (emailSet(process.env.RLM_WIKI_ALLOWED_EMAILS).has(identity.email)) return { allowed: true };

  const token = inviteTokenFromRequest(req);
  if (!token) {
    return { allowed: false, reason: "This beta is invite-only. Ask the person who invited you for a valid invite link." };
  }

  const payload = verifyInviteToken(token, identity.email);
  if (!payload) {
    return { allowed: false, reason: "This invite link is invalid, expired, or belongs to a different email." };
  }

  return {
    allowed: true,
    headers: {
      "set-cookie": inviteCookie(token, payload.exp),
    },
  };
}

export function inviteAcceptResponse(req: Request, identity: AuthIdentity): Response {
  const result = authorizeInviteRequest(req, identity);
  if (!result.allowed) {
    return inviteDeniedResponse(result.reason || "Invite required.", 403);
  }
  const payload = verifyInviteToken(inviteTokenFromRequest(req), identity.email);
  const redirectPath = safeRedirectPath(payload?.redirectPath || new URL(req.url).searchParams.get("to") || "/code");
  return new Response(null, {
    status: 302,
    headers: {
      location: redirectPath,
      ...(result.headers || {}),
    },
  });
}

export function inviteDeniedResponse(reason: string, status = 403): Response {
  const escaped = escapeHtml(reason);
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invite required · rlm-wiki</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #ededed; font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(520px, calc(100vw - 32px)); border: 1px solid #222; border-radius: 10px; background: #0a0a0a; padding: 28px; box-shadow: 0 24px 90px rgba(0,0,0,.7); }
    p:first-child { margin: 0 0 10px; color: #555; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; letter-spacing: 0; }
    p { color: #999; }
    a { color: #ededed; }
  </style>
</head>
<body>
  <main>
    <p>rlm-wiki beta</p>
    <h1>Invite required</h1>
    <p>${escaped}</p>
  </main>
</body>
</html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function createInviteLinksForEmails(args: {
  emails: string[];
  baseUrl: string;
  days?: number;
  redirectPath?: string;
}): InviteLink[] {
  const days = clampInviteDays(args.days);
  const exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const base = args.baseUrl.replace(/\/+$/, "");
  const redirectPath = safeRedirectPath(args.redirectPath || "/code");
  return uniqueEmails(args.emails).map((email) => {
    const token = createInviteToken({ email, exp, redirectPath });
    return {
      email,
      url: `${base}/invite/${encodeURIComponent(token)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  });
}

function createInviteToken(payload: Omit<InvitePayload, "v" | "iat" | "nonce">): string {
  const fullPayload: InvitePayload = {
    v: 1,
    email: normalizeEmail(payload.email),
    exp: payload.exp,
    iat: Math.floor(Date.now() / 1000),
    nonce: randomBytes(12).toString("base64url"),
    redirectPath: safeRedirectPath(payload.redirectPath || "/code"),
  };
  const body = base64Url(JSON.stringify(fullPayload));
  return `${body}.${sign(body)}`;
}

function verifyInviteToken(tokenInput: string | null | undefined, email: string): InvitePayload | null {
  const token = String(tokenInput || "").trim();
  const [body, signature] = token.split(".");
  if (!body || !signature || token.split(".").length !== 2) return null;
  try {
    if (!safeEqual(signature, sign(body))) return null;
  } catch {
    return null;
  }
  let payload: InvitePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as InvitePayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (payload.email !== normalizeEmail(email)) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function inviteTokenFromRequest(req: Request): string {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/invite/")) return decodeURIComponent(url.pathname.slice("/invite/".length));
  return url.searchParams.get("invite") || cookieValue(req.headers.get("cookie") || "", INVITE_COOKIE);
}

function inviteCookie(token: string, exp: number): string {
  const maxAge = Math.max(60, exp - Math.floor(Date.now() / 1000));
  const secure = process.env.NODE_ENV === "production" || authMode() === "cloudflare_access" ? "; Secure" : "";
  return `${INVITE_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function sign(body: string): string {
  const secret = inviteSecret();
  if (!secret) throw new Error("RLM_WIKI_INVITE_SECRET is required for invite links.");
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function inviteSecret(): string {
  return process.env.RLM_WIKI_INVITE_SECRET?.trim() || "";
}

function emailSet(value: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const raw of (value || "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    set.add(normalizeEmail(trimmed));
  }
  return set;
}

function uniqueEmails(emails: string[]): string[] {
  return [...new Set(emails.map((email) => normalizeEmail(email)).filter(Boolean))];
}

function clampInviteDays(value: unknown): number {
  const days = Number(value ?? DEFAULT_INVITE_DAYS);
  if (!Number.isFinite(days)) return DEFAULT_INVITE_DAYS;
  return Math.max(1, Math.min(90, Math.floor(days)));
}

function safeRedirectPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/code";
  return raw.length > 160 ? "/code" : raw;
}

function cookieValue(cookieHeader: string, name: string): string {
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return "";
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() || "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}
