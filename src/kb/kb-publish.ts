/**
 * Phase 3 - Publish adapter.
 *
 * `kbRecordFromArtifact` is the single chokepoint that lets a per-repo Knowledge
 * Base ride the existing wiki publish/serve/feedback stack. It turns the
 * `KnowledgeBaseData` blob into a fully-formed `WikiRecord` so the KB can be:
 *   - written to the local `wiki` artifact (the feedback path reads the LOCAL store)
 *   - published through `publishWikiRecordToPublicSite` (human page + agent .md/llms.txt)
 *   - re-published at the SAME publicId on every sync (always-current link)
 *
 * Two correctness requirements the plan review flagged are enforced here:
 *  1. ALL required WikiRecordSchema fields are supplied (repoUrl, owner, repo,
 *     generatedAt, model, structure{title,description,sections[],pages[]}), not just
 *     title/description.
 *  2. A STABLE WikiRecord id is preserved across calls. The id is read from the KB
 *     artifact (`kb.wikiRecordId`); when absent we mint one and the caller persists
 *     it back, so the publication artifact key + managementToken never orphan.
 *
 * Each card becomes one structure page + one generated page carrying `kb` freshness
 * metadata (status/lastUpdated/sourceAskIds/contradicts/topicTags/corroborationCount).
 * The contradicts/corroborationCount detail is gated by the Phase 0 build branch
 * (kbRendersContradictionDetail) at the MARKDOWN layer; the metadata is always
 * attached here so a branch flip needs no re-publish to start showing it.
 */

import { createHash, randomUUID } from "node:crypto";
import type { GeneratedPage, WikiPage, WikiRecord, WikiSection } from "../types.ts";
import type { KnowledgeBaseData, KnowledgeCard } from "./knowledge-base-store.ts";

/** Model label stamped on a KB-derived WikiRecord (no LLM ran to build the record). */
const KB_RECORD_MODEL = "rlm-wiki Knowledge Base" as const;

/** Section ids for the three KB layers (decision 2: wiki backbone, ask cards, docs). */
const KB_SECTION_CARDS = "kb-section-cards" as const;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function slugPart(value: string, fallback: string): string {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || fallback
  );
}

/**
 * Derive a stable synthetic `{owner, repo, repoUrl}` from a canonical KB repo key.
 *
 * - `gh:owner/repo`   -> real owner/repo + the github repoUrl.
 * - `local:/abs/path` -> owner `local`, repo `<dirname>-<pathhash>`. The path hash is
 *   the dirname-collision disambiguator the plan requires (two `myapp` dirs differ).
 * - `raw:<text>`      -> owner `repo`, repo `<slug>-<hash>`. No public repoUrl.
 *
 * `repoUrl` is only the real github URL when the key is a `gh:` key; otherwise it is
 * empty (the sanitizer rejects non-github URLs to "" anyway), keeping local/raw KBs
 * from advertising a bogus GitHub link.
 */
export function kbSyntheticRepoIdentity(repoKey: string): {
  owner: string;
  repo: string;
  repoUrl: string;
} {
  const key = String(repoKey || "").trim().toLowerCase();
  const ghMatch = /^gh:([^/]+)\/(.+)$/.exec(key);
  if (ghMatch) {
    const owner = ghMatch[1].trim();
    const repo = ghMatch[2].trim();
    return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}` };
  }
  if (key.startsWith("local:")) {
    const path = key.slice("local:".length);
    const dirname = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "repo";
    // Path-hash disambiguator so two local dirs sharing a name never collide.
    return { owner: "local", repo: `${slugPart(dirname, "repo")}-${shortHash(path)}`, repoUrl: "" };
  }
  const rest = key.startsWith("raw:") ? key.slice("raw:".length) : key;
  return { owner: "repo", repo: `${slugPart(rest, "kb")}-${shortHash(rest || key)}`, repoUrl: "" };
}

/** Card id -> the synthetic wiki page id used in both structure.pages and pages{}. */
export function kbCardPageId(card: KnowledgeCard): string {
  return `kb-card-${slugPart(card.id, shortHash(card.id))}`;
}

/**
 * Build the `kb` freshness metadata for a card. Always carries status + lastUpdated
 * + sourceAskIds + topicTags + corroborationCount. The `contradicts[]` flags are the
 * loud "this card disagrees with a higher-authority source" markers; they ride here
 * unconditionally and the markdown layer decides (per build branch) whether to show
 * the contradicts/corroboration detail.
 */
export function kbPageMetadataForCard(card: KnowledgeCard): NonNullable<GeneratedPage["kb"]> {
  return {
    status: card.status,
    lastUpdated: card.lastUpdated,
    sourceAskIds: [...card.sourceAskIds],
    contradicts: [...card.contradictsFlags],
    topicTags: [...card.topicTags],
    corroborationCount: card.corroborationCount,
  };
}

/**
 * The generated-page markdown for a card = its body verbatim. The card title is
 * rendered by the markdown builders as the page/section heading, so we do NOT repeat
 * it here (that would double the H1). Freshness + provenance are added by the
 * builders' per-card freshness block, keeping the agent variant self-contained.
 */
function kbCardPageContent(card: KnowledgeCard): string {
  return String(card.body || "").trim();
}

/**
 * Convert a `KnowledgeBaseData` artifact into a fully-formed `WikiRecord`.
 *
 * @param wikiRecordId stable id to reuse (from `kb.wikiRecordId`); when omitted a new
 *   one is minted. The caller (publish handler) MUST persist the returned record's id
 *   back into the KB artifact so subsequent publishes reuse the same publicId.
 */
export function kbRecordFromArtifact(
  kb: KnowledgeBaseData,
  opts: { wikiRecordId?: string | null; generatedAt?: string } = {},
): WikiRecord {
  const identity = kbSyntheticRepoIdentity(kb.repoKey);
  const id =
    (typeof opts.wikiRecordId === "string" && opts.wikiRecordId.trim()) ||
    (typeof kb.wikiRecordId === "string" && kb.wikiRecordId.trim()) ||
    kbMintWikiRecordId(identity.owner, identity.repo);

  const generatedAt =
    opts.generatedAt ||
    kb.lastRollupAt ||
    kb.lastIncrementAt ||
    kb.updatedAt ||
    new Date().toISOString();

  const cards = Array.isArray(kb.cards) ? kb.cards : [];

  const structurePages: WikiPage[] = cards.map((card) => ({
    id: kbCardPageId(card),
    title: card.title || card.id,
    // Description stays short so the index/page headers read cleanly; the loud
    // contradiction banner is added by the markdown builders, not here.
    description: kbCardDescription(card),
    importance:
      card.status === "corroborated" ? "high" : card.contradictsFlags.length ? "medium" : "low",
    filePaths: [],
    relatedPages: [],
    parentSection: KB_SECTION_CARDS,
  }));

  const sections: WikiSection[] = [
    {
      id: KB_SECTION_CARDS,
      title: "Knowledge cards",
      pages: structurePages.map((page) => page.id),
      subsections: [],
    },
  ];

  const pages: Record<string, GeneratedPage> = {};
  for (const card of cards) {
    const pageId = kbCardPageId(card);
    pages[pageId] = {
      id: pageId,
      content: kbCardPageContent(card),
      generatedAt: card.lastUpdated || generatedAt,
      kb: kbPageMetadataForCard(card),
    };
  }

  return {
    id,
    repoUrl: identity.repoUrl,
    owner: identity.owner,
    repo: identity.repo,
    branch: null,
    sourcePath: null,
    generatedAt,
    updatedAt: kb.updatedAt || generatedAt,
    model: KB_RECORD_MODEL,
    structure: {
      title: kbWikiTitle(kb),
      description: kbWikiDescription(kb),
      sections,
      pages: structurePages,
    },
    pages,
  };
}

/** A short, honest description for a card (status-aware, zero em-dashes). */
function kbCardDescription(card: KnowledgeCard): string {
  if (card.contradictsFlags.length) {
    return "Flagged: this card disagrees with a higher-authority source. Saved as provisional for review.";
  }
  return card.status === "corroborated"
    ? "Corroborated by two or more independent sources."
    : "Provisional. Not yet corroborated by a second source.";
}

function kbWikiTitle(kb: KnowledgeBaseData): string {
  const label = String(kb.repoLabel || kb.repoKey || "Repository").trim();
  return `${label} Knowledge Base`;
}

function kbWikiDescription(kb: KnowledgeBaseData): string {
  const count = Array.isArray(kb.cards) ? kb.cards.length : 0;
  const noun = count === 1 ? "card" : "cards";
  return count
    ? `A self-healing, source-grounded knowledge base for this repository (${count} ${noun}).`
    : "A self-healing, source-grounded knowledge base for this repository.";
}

/** Mint a stable WikiRecord id (same shape as createWikiId, KB-scoped). */
export function kbMintWikiRecordId(owner: string, repo: string): string {
  const prefix = slugPart(`${owner}-${repo}`, "kb");
  return `wiki-kb-${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * Phase 4 feedback loop: rank KB card pages by corroboration desc -> recency desc so
 * that when an ask injects the KB as `wikiContext` and the ~90k-char budget truncates,
 * the MOST-trustworthy cards survive instead of array order. This is the "top-N card
 * selection by corroboration/recency before injection" the plan requires; it rides the
 * existing wikiContexts seam (no new endpoint).
 *
 * Stable: equal-rank pages keep their original order. Pure: no I/O. Operates on the
 * `{ pageId, kb }` projection so it is callable from the server's ask-context builder
 * (which has the served WikiRecord pages + their `page.kb` metadata) and unit-testable.
 */
export type KbCardPageRank = {
  pageId: string;
  corroborationCount?: number | null;
  lastUpdated?: string | null;
};

export function orderKbCardPagesByFreshness<T extends KbCardPageRank>(pages: T[]): T[] {
  const indexed = pages.map((page, index) => ({ page, index }));
  indexed.sort((a, b) => {
    const ca = Number(a.page.corroborationCount ?? 0) || 0;
    const cb = Number(b.page.corroborationCount ?? 0) || 0;
    if (cb !== ca) return cb - ca; // higher corroboration first
    const ra = a.page.lastUpdated ? Date.parse(a.page.lastUpdated) : 0;
    const rb = b.page.lastUpdated ? Date.parse(b.page.lastUpdated) : 0;
    const rva = Number.isFinite(ra) ? ra : 0;
    const rvb = Number.isFinite(rb) ? rb : 0;
    if (rvb !== rva) return rvb - rva; // newer first
    return a.index - b.index; // stable tiebreak
  });
  return indexed.map((entry) => entry.page);
}
