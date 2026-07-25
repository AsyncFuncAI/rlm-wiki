/**
 * Phase 1 - Knowledge Base data model + typed store API.
 *
 * One artifact per repo, stored on the existing `ProductArtifact` table with
 * `kind: 'knowledge-base'` (zero schema change - `kind` is a plain TEXT column,
 * verified at src/persistence.ts). This module owns BOTH the on-disk shape and the
 * only safe write paths, so the merge invariant ("never mutate a corroborated card")
 * lives in the module, not in each caller (plan section 4, Phase 1).
 *
 * The card kind enum is the spike-frozen `KbIntentType` from knowledge-base-types.ts;
 * it is imported, never redefined here.
 */

import type { ProductStore } from "../persistence.ts";
import {
  type KbIntentType,
  KB_INTENT_TYPES,
} from "./knowledge-base-types.ts";

/** The artifact kind used for every per-repo Knowledge Base. */
export const KNOWLEDGE_BASE_ARTIFACT_KIND = "knowledge-base" as const;

/** The data-model version, so future migrations can branch on shape. */
export const KNOWLEDGE_BASE_SCHEMA_VERSION = 1 as const;

/**
 * A single persisted knowledge card. This is the storage shape; it carries the
 * provenance + status fields the merge resolver and publish layers read. `kind`
 * reuses the spike-frozen taxonomy verbatim.
 */
export interface KnowledgeCard {
  id: string;
  kind: KbIntentType;
  title: string;
  body: string;
  /** Every ask conversation that contributed to this card (provenance). */
  sourceAskIds: string[];
  /** provisional until corroborated by >= 2 independent sources. */
  status: "provisional" | "corroborated";
  /** Distinct corroborating sources counted so far. */
  corroborationCount: number;
  /** ISO timestamp of the last write to this card. */
  lastUpdated: string;
  /** Loud flags when this card contradicts a higher-authority source. */
  contradictsFlags: string[];
  /** Tags for the future graph view + feedback-loop top-N selection. */
  topicTags: string[];
  /** Canonical repo keys this card references (graph-later, no graph now). */
  repoRefs: string[];
  /** The prior version retained for auditability/recoverability. */
  priorVersion?: KnowledgeCard;
}

/**
 * The per-repo Knowledge Base blob persisted in `ProductArtifact.data`.
 *
 * `updatedAt` + `schemaVersion` are the optimistic-lock fields: a concurrent
 * distill/rollup that loaded an older snapshot is rejected on save so cards are
 * never silently dropped (the desktop SQLite backend shares one connection with no
 * surrounding transaction - plan section 4 lost-update guard).
 */
export interface KnowledgeBaseData {
  schemaVersion: number;
  repoKey: string;
  repoLabel: string;
  cards: KnowledgeCard[];
  /** Set by the star rollup path (full sync). */
  lastRollupAt: string | null;
  /** Set by the chat increment path (single cooled thread). */
  lastIncrementAt: string | null;
  /** ISO timestamp of the last save; the optimistic-lock token. */
  updatedAt: string;
  /** Stable Upstash public id once published (Phase 3 writes this). */
  publicId?: string;
  /**
   * Local WikiRecord id used by the feedback path (Phase 4 reads the LOCAL store,
   * not Upstash). Written by Phase 3's publish step.
   */
  wikiRecordId?: string;
}

/**
 * Canonical KB artifact key for a repo. Mirrors `wikiArtifactKey` but the KB is
 * one-per-repo, so it returns the already-canonical repo key verbatim
 * (`gh:owner/repo` | `local:/abs/path` | `raw:...`), lowercased for stability.
 */
export function knowledgeBaseArtifactKey(repoKey: string): string {
  return String(repoKey || "").trim().toLowerCase();
}

/** A fresh, empty KB for a repo (not yet persisted). */
export function emptyKnowledgeBase(repoKey: string, repoLabel: string): KnowledgeBaseData {
  return {
    schemaVersion: KNOWLEDGE_BASE_SCHEMA_VERSION,
    repoKey: knowledgeBaseArtifactKey(repoKey),
    repoLabel: String(repoLabel || repoKey || "").trim(),
    cards: [],
    lastRollupAt: null,
    lastIncrementAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function isKbIntentType(value: unknown): value is KbIntentType {
  return typeof value === "string" && (KB_INTENT_TYPES as readonly string[]).includes(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

/**
 * Coerce an untrusted stored card into the typed shape, dropping anything that
 * is not a valid kind (the enum is frozen and validated, never trusted blindly).
 */
export function normalizeKnowledgeCard(raw: unknown): KnowledgeCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id || "").trim();
  if (!id) return null;
  if (!isKbIntentType(r.kind)) return null;
  const status = r.status === "corroborated" ? "corroborated" : "provisional";
  const corroborationCount = Number.isFinite(Number(r.corroborationCount))
    ? Math.max(0, Math.floor(Number(r.corroborationCount)))
    : 0;
  const card: KnowledgeCard = {
    id,
    kind: r.kind,
    title: String(r.title || "").trim(),
    body: String(r.body || ""),
    sourceAskIds: asStringArray(r.sourceAskIds),
    status,
    corroborationCount,
    lastUpdated: typeof r.lastUpdated === "string" && r.lastUpdated ? r.lastUpdated : new Date().toISOString(),
    contradictsFlags: asStringArray(r.contradictsFlags),
    topicTags: asStringArray(r.topicTags),
    repoRefs: asStringArray(r.repoRefs),
  };
  const prior = normalizeKnowledgeCard(r.priorVersion);
  if (prior) card.priorVersion = prior;
  return card;
}

/** Coerce a stored artifact `data` blob into typed `KnowledgeBaseData`. */
export function normalizeKnowledgeBase(
  data: Record<string, unknown> | null | undefined,
  fallback: { repoKey: string; repoLabel: string },
): KnowledgeBaseData {
  const base = emptyKnowledgeBase(fallback.repoKey, fallback.repoLabel);
  if (!data || typeof data !== "object") return base;
  const cards = Array.isArray(data.cards)
    ? data.cards.map(normalizeKnowledgeCard).filter((c): c is KnowledgeCard => c !== null)
    : [];
  return {
    schemaVersion: Number.isFinite(Number(data.schemaVersion))
      ? Number(data.schemaVersion)
      : KNOWLEDGE_BASE_SCHEMA_VERSION,
    repoKey: typeof data.repoKey === "string" && data.repoKey ? data.repoKey : base.repoKey,
    repoLabel: typeof data.repoLabel === "string" && data.repoLabel ? data.repoLabel : base.repoLabel,
    cards,
    lastRollupAt: typeof data.lastRollupAt === "string" ? data.lastRollupAt : null,
    lastIncrementAt: typeof data.lastIncrementAt === "string" ? data.lastIncrementAt : null,
    updatedAt: typeof data.updatedAt === "string" && data.updatedAt ? data.updatedAt : base.updatedAt,
    ...(typeof data.publicId === "string" && data.publicId ? { publicId: data.publicId } : {}),
    ...(typeof data.wikiRecordId === "string" && data.wikiRecordId ? { wikiRecordId: data.wikiRecordId } : {}),
  };
}

/** Load the KB for a repo, or null if none has been distilled yet. */
export async function loadKnowledgeBase(
  store: ProductStore,
  repoKey: string,
): Promise<KnowledgeBaseData | null> {
  const key = knowledgeBaseArtifactKey(repoKey);
  const artifact = await store.getArtifact(KNOWLEDGE_BASE_ARTIFACT_KIND, key);
  if (!artifact) return null;
  return normalizeKnowledgeBase(artifact.data, { repoKey: key, repoLabel: key });
}

/** Thrown when an optimistic-lock save loses a race (a newer snapshot exists). */
export class KnowledgeBaseConflictError extends Error {
  constructor(
    readonly repoKey: string,
    readonly expectedUpdatedAt: string,
    readonly actualUpdatedAt: string,
  ) {
    super(
      `Knowledge base for ${repoKey} changed since load (expected ${expectedUpdatedAt}, found ${actualUpdatedAt}).`,
    );
    this.name = "KnowledgeBaseConflictError";
  }
}

/** Thrown when a non-resolver caller tries to rewrite a corroborated card. */
export class CorroboratedCardRewriteError extends Error {
  constructor(readonly repoKey: string, readonly cardId: string) {
    super(
      `Refusing to rewrite corroborated card ${cardId} in ${repoKey} outside the merge resolver. ` +
        `Pass { allowRewriteCorroborated: true } only from the resolver path.`,
    );
    this.name = "CorroboratedCardRewriteError";
  }
}

function corroboratedIds(cards: KnowledgeCard[]): Set<string> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (card.status === "corroborated") ids.add(card.id);
  }
  return ids;
}

/**
 * Full-rewrite save with an optimistic-lock guard. The lock compares the stored
 * `updatedAt` against the snapshot the caller loaded from (`expectedUpdatedAt`):
 * if another writer saved in between, the save is rejected so concurrent
 * distill/rollup calls cannot silently clobber each other.
 *
 * Rewriting (or deleting) a CORROBORATED card requires the explicit
 * `{ allowRewriteCorroborated: true }` opt, which only the merge resolver passes;
 * any other caller hits `CorroboratedCardRewriteError`. This keeps the
 * "never mutate ground truth" invariant inside the module.
 */
export async function saveKnowledgeBase(
  store: ProductStore,
  next: KnowledgeBaseData,
  opts: {
    expectedUpdatedAt?: string;
    allowRewriteCorroborated?: boolean;
    runId?: string | null;
  } = {},
): Promise<KnowledgeBaseData> {
  const key = knowledgeBaseArtifactKey(next.repoKey);
  const existing = await store.getArtifact(KNOWLEDGE_BASE_ARTIFACT_KIND, key);
  const existingKb = existing
    ? normalizeKnowledgeBase(existing.data, { repoKey: key, repoLabel: next.repoLabel })
    : null;

  // Optimistic-lock: reject if the on-disk snapshot moved past what the caller loaded.
  if (opts.expectedUpdatedAt !== undefined && existingKb) {
    if (existingKb.updatedAt !== opts.expectedUpdatedAt) {
      throw new KnowledgeBaseConflictError(key, opts.expectedUpdatedAt, existingKb.updatedAt);
    }
  }

  // Invariant: a corroborated card present before this save must survive it byte-for-byte,
  // unless the resolver explicitly opted in.
  if (existingKb && !opts.allowRewriteCorroborated) {
    const priorCorroborated = corroboratedIds(existingKb.cards);
    if (priorCorroborated.size) {
      const byId = new Map(next.cards.map((c) => [c.id, c]));
      for (const card of existingKb.cards) {
        if (card.status !== "corroborated") continue;
        const after = byId.get(card.id);
        if (!after) throw new CorroboratedCardRewriteError(key, card.id);
        if (JSON.stringify(after) !== JSON.stringify(card)) {
          throw new CorroboratedCardRewriteError(key, card.id);
        }
      }
    }
  }

  // The optimistic-lock token is `updatedAt`, so it MUST strictly increase past
  // the snapshot on disk - otherwise two saves landing in the same millisecond
  // produce equal tokens and a stale writer's lock check would wrongly pass.
  // Emit max(now, prior + 1ms) so the token is monotonic even under same-ms races.
  const priorMs = existingKb ? Date.parse(existingKb.updatedAt) : 0;
  const nowMs = Date.now();
  const nextMs = Number.isFinite(priorMs) ? Math.max(nowMs, priorMs + 1) : nowMs;
  const toPersist: KnowledgeBaseData = {
    ...next,
    repoKey: key,
    schemaVersion: next.schemaVersion || KNOWLEDGE_BASE_SCHEMA_VERSION,
    updatedAt: new Date(nextMs).toISOString(),
  };
  await store.upsertArtifact({
    kind: KNOWLEDGE_BASE_ARTIFACT_KIND,
    key,
    runId: opts.runId ?? null,
    data: toPersist as unknown as Record<string, unknown>,
  });
  return toPersist;
}

/**
 * Provisional-only safe append: load the current KB, add/merge the new cards
 * WITHOUT ever rewriting or deleting a corroborated card, and save under the
 * optimistic lock (retrying once on a lost race). This is the only write path the
 * Distillation track (a separate consumer) is allowed to call - it cannot call
 * `saveKnowledgeBase` incorrectly because the corroborated-card protection is
 * enforced here, not by the caller.
 *
 * New-card rules:
 *  - A new card whose id is unknown is appended.
 *  - A new card whose id matches an EXISTING PROVISIONAL card replaces it
 *    (provisional cards are not yet ground truth).
 *  - A new card whose id matches an EXISTING CORROBORATED card is IGNORED here
 *    (only the merge resolver, via `saveKnowledgeBase({ allowRewriteCorroborated })`,
 *    may touch corroborated cards). The corroborated card is preserved verbatim.
 */
export async function mergeSafeAppend(
  store: ProductStore,
  repoKey: string,
  newCards: KnowledgeCard[],
  opts: { runId?: string | null; repoLabel?: string; scope?: "increment" | "rollup" } = {},
): Promise<KnowledgeBaseData> {
  const key = knowledgeBaseArtifactKey(repoKey);
  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await loadKnowledgeBase(store, key);
    const current = existing ?? emptyKnowledgeBase(key, opts.repoLabel ?? key);
    const expectedUpdatedAt = current.updatedAt;

    const protectedIds = corroboratedIds(current.cards);
    const merged = [...current.cards];
    const indexById = new Map(merged.map((c, i) => [c.id, i]));
    const nowIso = new Date().toISOString();

    for (const incoming of newCards) {
      const card = normalizeKnowledgeCard(incoming);
      if (!card) continue;
      if (protectedIds.has(card.id)) continue; // never touch ground truth here
      const stamped: KnowledgeCard = { ...card, lastUpdated: card.lastUpdated || nowIso };
      const at = indexById.get(card.id);
      if (at === undefined) {
        indexById.set(card.id, merged.length);
        merged.push(stamped);
      } else {
        merged[at] = stamped; // replace existing provisional card
      }
    }

    const next: KnowledgeBaseData = {
      ...current,
      repoKey: key,
      repoLabel: opts.repoLabel ?? current.repoLabel,
      cards: merged,
      lastIncrementAt: opts.scope === "rollup" ? current.lastIncrementAt : nowIso,
      lastRollupAt: opts.scope === "rollup" ? nowIso : current.lastRollupAt,
    };

    try {
      return await saveKnowledgeBase(store, next, {
        expectedUpdatedAt,
        runId: opts.runId ?? null,
        // mergeSafeAppend never rewrites corroborated cards (guarded above), so
        // it does NOT pass allowRewriteCorroborated - the default protection holds.
      });
    } catch (err) {
      if (err instanceof KnowledgeBaseConflictError) {
        lastError = err;
        continue; // a concurrent writer won; reload and retry
      }
      throw err;
    }
  }
  throw lastError ?? new Error(`mergeSafeAppend failed for ${key} after ${maxAttempts} attempts`);
}

/**
 * Read the internal version history for a repo's KB (admin/recovery only, never
 * surfaced on the public link). Returns [] when the store backend or artifact is
 * absent. Scoped to the TS-server path (plan Open Question 1 decision); see the
 * module-level note in the storage test.
 */
export async function listKnowledgeBaseVersions(
  store: ProductStore,
  repoKey: string,
  opts: { limit?: number } = {},
) {
  const key = knowledgeBaseArtifactKey(repoKey);
  return store.listArtifactVersions(KNOWLEDGE_BASE_ARTIFACT_KIND, key, opts);
}
