/// <reference types="node" />

import { randomBytes, randomUUID } from "node:crypto";

export const PUBLIC_ASK_SCHEMA_VERSION = 1;
export type PublicAskVisibility = "public" | "private";

export const PUBLIC_ASK_MAX_TURNS = 200;
export const PUBLIC_ASK_MAX_QUESTION_CHARS = 4_000;
export const PUBLIC_ASK_MAX_ANSWER_CHARS = 200_000;
export const PUBLIC_ASK_MAX_CLARIFICATIONS = 20;
export const PUBLIC_ASK_MAX_SOURCES = 120;
export const PUBLIC_ASK_MAX_EXCERPT_CHARS = 2_000;
export const PUBLIC_ASK_MAX_SCOPES = 8;

export type PublicAskClarification = {
  question: string;
  answer: string;
};

export type PublicAskTurn = {
  question: string;
  answer: string;
  askedAt?: string;
  clarifications?: PublicAskClarification[];
};

export type PublicAskSource = {
  path: string;
  label?: string;
  detail?: string;
  excerpt?: string;
};

export type PublicAskRecord = {
  id?: string;
  title: string;
  description?: string;
  repoName?: string;
  scopes?: string[];
  runtime?: string;
  model?: string;
  askedAt?: string;
  turns: PublicAskTurn[];
  sources?: PublicAskSource[];
};

export type PublicAskSnapshot = {
  schemaVersion: typeof PUBLIC_ASK_SCHEMA_VERSION;
  publicId: string;
  published: true;
  visibility: PublicAskVisibility;
  surface: "ask";
  readOnly: true;
  title: string;
  description: string;
  repoName?: string;
  runtime?: string;
  model?: string;
  turnCount: number;
  askedAt?: string;
  publishedAt: string;
  updatedAt: string;
  ask: PublicAskRecord;
};

export type PublicAskPublication = {
  published: boolean;
  publicId: string | null;
  publicPath: string | null;
  publicUrl: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  unpublishedAt?: string | null;
  title: string | null;
  readOnly: true;
  visibility?: PublicAskVisibility;
  recordVersion?: string | null;
};

export function normalizePublicAskId(value: unknown): string {
  const clean = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,95}$/.test(clean) ? clean : "";
}

export function normalizePublicAskVisibility(value: unknown): PublicAskVisibility {
  return value === "private" ? "private" : "public";
}

export function publicAskPath(publicId: string, visibility?: PublicAskVisibility | null): string {
  const prefix = normalizePublicAskVisibility(visibility) === "private" ? "/share/ask" : "/public/ask";
  return `${prefix}/${encodeURIComponent(publicId)}`;
}

export function publicAskUrl(baseUrl: string, publicId: string, visibility?: PublicAskVisibility | null): string {
  return `${baseUrl.replace(/\/+$/, "")}${publicAskPath(publicId, visibility)}`;
}

export function makePublicAskId(title: string): string {
  const prefix = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "ask";
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function makePrivateAskId(): string {
  return `private-${randomBytes(16).toString("hex")}`;
}

export function askPublicationRecordVersion(record: Pick<PublicAskRecord, "askedAt"> | null | undefined): string {
  return String(record?.askedAt || "");
}

export function publicAskPublicationFromSnapshot(
  snapshot: PublicAskSnapshot,
  baseUrl: string,
): PublicAskPublication {
  return {
    published: true,
    publicId: snapshot.publicId,
    publicPath: publicAskPath(snapshot.publicId, snapshot.visibility),
    publicUrl: publicAskUrl(baseUrl, snapshot.publicId, snapshot.visibility),
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
    title: snapshot.title,
    readOnly: true,
    visibility: normalizePublicAskVisibility(snapshot.visibility),
    recordVersion: askPublicationRecordVersion(snapshot.ask),
  };
}

/**
 * The desktop persists an AskDraft (apps/desktop/src/controllers/ask-stream-controller.ts)
 * whose timestamps are epoch milliseconds and whose scope is a newline-joined blob that can
 * contain local filesystem paths. This converts that shape into the wire-format
 * PublicAskRecord: answered turns only, ISO dates, and scope/source paths reduced so a
 * shared link never leaks a local directory layout.
 */
export function publicAskRecordFromDesktopAsk(value: unknown): PublicAskRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid ask payload.");
  const ask = value as Record<string, unknown>;
  const rawTurns = Array.isArray(ask.turns) ? ask.turns : [];
  const turns: PublicAskTurn[] = [];
  for (const raw of rawTurns) {
    if (!raw || typeof raw !== "object") continue;
    const turn = raw as Record<string, unknown>;
    const question = collapseWhitespace(turn.question).slice(0, PUBLIC_ASK_MAX_QUESTION_CHARS);
    const answer = String(turn.answer || "").trim().slice(0, PUBLIC_ASK_MAX_ANSWER_CHARS);
    if (!question || !answer) continue;
    if (turn.status != null && !["done", "error"].includes(String(turn.status))) continue;
    const clarifications = sanitizeClarifications(turn.clarifications);
    turns.push({
      question,
      answer,
      askedAt: toIsoDate(turn.updatedAt ?? (turn as { updated_at?: unknown }).updated_at),
      ...(clarifications.length ? { clarifications } : {}),
    });
    if (turns.length >= PUBLIC_ASK_MAX_TURNS) break;
  }
  if (!turns.length) throw new Error("Nothing to share yet: the conversation has no completed answers.");

  const firstQuestion = turns[0].question;
  const title = collapseWhitespace(ask.title).slice(0, 160) || titleFromQuestion(firstQuestion);
  const scopes = splitScopeText(ask.scope)
    .map(shareSafeScopeLabel)
    .filter(Boolean)
    .slice(0, PUBLIC_ASK_MAX_SCOPES);
  const repoName = shareSafeScopeLabel(ask.repoName);

  return {
    id: cleanOptional(ask.id),
    title,
    description: firstQuestion.slice(0, 220),
    ...(repoName ? { repoName } : {}),
    ...(scopes.length ? { scopes } : {}),
    runtime: cleanOptional(ask.runtime),
    model: cleanOptional(ask.localCliModel) || cleanOptional(ask.model),
    askedAt: toIsoDate(ask.updatedAt),
    turns,
    sources: sanitizeSources(ask.sources),
  };
}

function sanitizeClarifications(value: unknown): PublicAskClarification[] {
  if (!Array.isArray(value)) return [];
  const items: PublicAskClarification[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const question = collapseWhitespace((raw as Record<string, unknown>).question).slice(0, 2_000);
    const answer = collapseWhitespace((raw as Record<string, unknown>).answer).slice(0, 2_000);
    if (!question) continue;
    items.push({ question, answer });
    if (items.length >= PUBLIC_ASK_MAX_CLARIFICATIONS) break;
  }
  return items;
}

function sanitizeSources(value: unknown): PublicAskSource[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const items: PublicAskSource[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    const path = shareSafeSourcePath(source.path);
    if (!path) continue;
    const label = collapseWhitespace(source.label).slice(0, 200);
    const detail = collapseWhitespace(source.detail).slice(0, 300);
    const excerpt = String(source.excerpt || "").trim().slice(0, PUBLIC_ASK_MAX_EXCERPT_CHARS);
    items.push({
      path,
      ...(label && label !== path ? { label } : {}),
      ...(detail ? { detail } : {}),
      ...(excerpt ? { excerpt } : {}),
    });
    if (items.length >= PUBLIC_ASK_MAX_SOURCES) break;
  }
  return items.length ? items : undefined;
}

export function splitScopeText(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Scope entries and source paths from a local (BYOC) workspace can be absolute paths like
 * /Users/me/code/repo. A shared snapshot keeps only the trailing two segments so the label
 * still reads naturally without leaking the machine's directory layout.
 */
export function shareSafeScopeLabel(value: unknown): string {
  const text = collapseWhitespace(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text.length <= 200 ? text : "";
  const normalized = text.replace(/\\/g, "/");
  if (/^(?:\/|~|[A-Za-z]:\/|file:)/i.test(normalized)) {
    const parts = normalized.replace(/^file:\/*/i, "").split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail ? `…/${tail}` : "";
  }
  return text.slice(0, 200);
}

export function shareSafeSourcePath(value: unknown): string {
  const text = collapseWhitespace(value).replace(/\\/g, "/");
  if (!text) return "";
  if (/^(?:\/|~|[A-Za-z]:\/|file:)/i.test(text)) {
    const parts = text.replace(/^file:\/*/i, "").split("/").filter(Boolean);
    const tail = parts.slice(-3).join("/");
    return tail ? `…/${tail}` : "";
  }
  if (text.split("/").some((part) => part === "..")) return "";
  return text.slice(0, 260);
}

function titleFromQuestion(question: string): string {
  const words = collapseWhitespace(question).split(" ").filter(Boolean);
  const short = words.slice(0, 8).join(" ");
  return (words.length > 8 ? `${short}…` : short) || "Shared Ask";
}

function toIsoDate(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanOptional(value: unknown): string | undefined {
  const text = collapseWhitespace(value);
  return text || undefined;
}
