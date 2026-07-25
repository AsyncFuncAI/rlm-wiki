import type { DistillCard, SeededExistingCard } from "./knowledge-base-types.ts";
import { KB_INTENT_TYPES } from "./knowledge-base-types.ts";

/**
 * Prompt builders for the Knowledge Base distill + merge agents.
 *
 * Modeled EXACTLY on `buildRouteSystemPrompt` (src/server.ts:908): a numbered rule
 * list followed by ONE fenced ```json schema, JSON-only output. Card bodies live
 * inside JSON string values (escaped) so there is no XML entity-encoding risk
 * (plan section 3, structured-output contract).
 */

/** A conversation turn fed to the distill agent. */
export interface KbHistoryMessage {
  /** Stable id of the ask whose conversation this turn belongs to (provenance). */
  askId: string;
  role: "user" | "assistant";
  content: string;
}

const KIND_LIST = KB_INTENT_TYPES.map((k) => `"${k}"`).join(" | ");

function formatHistory(messages: KbHistoryMessage[]): string {
  return messages
    .map((m) => `[askId=${m.askId}] ${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
}

function formatExistingCards(cards: SeededExistingCard[]): string {
  if (!cards.length) return "(none — this is a fresh knowledge base)";
  return cards
    .map((c) =>
      [
        `- id: ${c.id}`,
        `  kind: ${c.kind}`,
        `  title: ${c.title}`,
        `  sourceTier: ${c.sourceTier} (doc > wiki > card)`,
        `  timestamp: ${c.timestamp}`,
        `  status: ${c.status}`,
        `  corroborationCount: ${c.corroborationCount}`,
        `  body: ${c.body}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Build the distill prompt: cluster a conversation's CONCLUSIVE turns into cards
 * by INTENT (not by turn), dropping inconclusive/dead-end turns entirely.
 *
 * Mirrors `buildRouteSystemPrompt`: numbered rules + one fenced ```json schema.
 */
export function buildDistillPrompt(
  historyMessages: KbHistoryMessage[],
  existingCards: SeededExistingCard[],
): string {
  return [
    "You are the distillation brain for rlm-wiki's repo Knowledge Base.",
    "Read a finished conversation and distill its DURABLE, CONCLUSIVE knowledge into cards.",
    "Return the cards as JSON.",
    "",
    "Card kinds (pick exactly one per card):",
    `  ${KB_INTENT_TYPES.join(", ")}.`,
    "",
    "Rules:",
    "1. Cluster by INTENT, not by turn. Two turns about the same underlying topic become ONE card.",
    '2. Drop dead-end turns. If a turn was inconclusive, abandoned, or reached no answer, produce NO card for it.',
    "3. Each card's `kind` MUST be one of the listed kinds, verbatim.",
    "4. `sourceAskIds` MUST list EVERY askId whose turn contributed to the card (provenance is mandatory).",
    "5. `body` is concise markdown capturing the durable answer. It is a JSON string value, so escape it normally.",
    "6. New cards start `status:\"provisional\"` with `corroborationCount:1` unless multiple independent sources in THIS conversation already agree.",
    "7. `contradictsFlags` is an array of short strings, empty unless the card knowingly conflicts with an existing card listed below.",
    "8. `lastUpdated` is an ISO-8601 timestamp string for when this knowledge was settled.",
    "9. Do NOT invent knowledge that is not supported by the conversation.",
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "cards": [',
    "    {",
    '      "id": "kebab-case-stable-id",',
    `      "kind": ${KIND_LIST},`,
    '      "title": "short human title",',
    '      "body": "markdown body",',
    '      "sourceAskIds": ["ask-1"],',
    '      "status": "provisional" | "corroborated",',
    '      "corroborationCount": 1,',
    '      "lastUpdated": "2026-06-07T00:00:00.000Z",',
    '      "contradictsFlags": []',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "# Existing cards in this knowledge base (for context; do NOT re-emit them here)",
    formatExistingCards(existingCards),
    "",
    "# Conversation to distill",
    formatHistory(historyMessages),
  ].join("\n");
}

/**
 * Build the merge prompt: reconcile ONE freshly-distilled card against the existing
 * KB, encoding the keystone resolution order corroboration > recency > authority and
 * the provisional-on-single-contradiction rule.
 *
 * Mirrors `buildRouteSystemPrompt`: numbered rules + one fenced ```json schema.
 */
export function buildMergePrompt(
  newCard: DistillCard,
  existingCards: SeededExistingCard[],
): string {
  return [
    "You are the merge/contradiction brain for rlm-wiki's repo Knowledge Base.",
    "Reconcile ONE new card against the existing cards and return the merge decision as JSON.",
    "This decision is load-bearing: a wrong 'apply' silently overwrites ground truth. Be conservative.",
    "",
    "Resolution order (STRICT, highest priority first):",
    "  1. CORROBORATION: 2+ independent sources agreeing wins. A single unverified source does NOT win.",
    "  2. RECENCY: when corroboration is equal, the newer timestamp wins.",
    "  3. AUTHORITY: the final tiebreak is sourceTier, doc > wiki > card.",
    "",
    "Rules:",
    "1. `intentMatchCardId`: the id of the existing card this NEW card matches by INTENT (same underlying topic), or null if genuinely new. Match by MEANING, never by title string equality. A card titled differently but about the same intent IS a match.",
    "2. `classification`: \"addition\" (new, non-overlapping knowledge), \"correction\" (refines a matched card without conflict), or \"contradiction\" (asserts something incompatible with a matched card).",
    "3. PROVISIONAL-ON-SINGLE-CONTRADICTION (the bright line): if classification is \"contradiction\" AND the new card is backed by only a SINGLE unverified source (corroborationCount < 2), you MUST set resolution:\"provisional\" and you MUST NOT set resolution:\"apply\". A lone fresh card contradicting a higher-authority source (e.g. a doc) NEVER overrides it; it lands provisional and is loudly flagged.",
    "4. COUNT-FLIP: a contradiction earns resolution:\"apply\" only once it reaches 2+ corroborating sources. `currentCorroborationCount` (the stored count for the matched card's competing claim) is provided to you as INPUT for this judgement.",
    "5. When the output is uncertain or the conversation is ambiguous, degrade to resolution:\"provisional\". NEVER apply on doubt.",
    "6. `rewriteWithProvenance.body` is the merged markdown body. `rewriteWithProvenance.claims` lists each claim with the `sourceAskId` that supports it (provenance is mandatory and must be preserved).",
    "7. `retainedPriorVersion` MUST be true whenever you rewrite an existing matched card (the prior version is kept for recoverability).",
    "8. `contradictsFlag`: a short loud string when this card contradicts a higher-authority source, else null.",
    "9. `weightRationale` explains, in one short sentence each, how corroboration, recency, and authority informed the decision.",
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "intentMatchCardId": "existing-card-id or null",',
    '  "classification": "addition" | "correction" | "contradiction",',
    '  "resolution": "apply" | "provisional" | "reject",',
    '  "currentCorroborationCount": 1,',
    '  "weightRationale": { "corroboration": "...", "recency": "...", "authority": "..." },',
    '  "rewriteWithProvenance": { "body": "merged markdown", "claims": [ { "text": "...", "sourceAskId": "ask-1" } ] },',
    '  "retainedPriorVersion": true,',
    '  "contradictsFlag": "short flag or null"',
    "}",
    "```",
    "",
    "# Existing cards (each carries sourceTier and timestamp for the resolver)",
    formatExistingCards(existingCards),
    "",
    "# New card to reconcile",
    [
      `id: ${newCard.id}`,
      `kind: ${newCard.kind}`,
      `title: ${newCard.title}`,
      `status: ${newCard.status}`,
      `corroborationCount: ${newCard.corroborationCount}`,
      `sourceAskIds: ${newCard.sourceAskIds.join(", ")}`,
      `body: ${newCard.body}`,
    ].join("\n"),
  ].join("\n");
}

/**
 * One-turn repair prompt insisting on a clean JSON contract, mirroring
 * `buildRouteRepairPrompt` (src/server.ts:1072). Used when the agent's first reply
 * did not contain a parseable decision object.
 */
export function buildKbRepairPrompt(originalPrompt: string, badReply: string): string {
  return [
    "Your previous reply could not be parsed as the required JSON.",
    "Return ONLY a single fenced ```json block matching the schema in the original instruction — no prose before or after.",
    "",
    "# Original instruction",
    originalPrompt,
    "",
    "# Your previous (unparseable) reply",
    badReply.slice(0, 2000),
  ].join("\n");
}
