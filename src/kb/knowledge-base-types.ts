/**
 * Phase-0 spike-frozen Knowledge Base types.
 *
 * THIS FILE LOCKS THE CARD ENUM FOR PHASE 1. The `KbIntentType` union below is the
 * single source of truth for a card's kind; Phase 1's `KnowledgeCard` model must
 * reuse it verbatim and must NOT be merged before this spike froze the shape
 * (plan section 4: "the model is itself a Phase 0 deliverable").
 *
 * The taxonomy is the same six kinds promised by the ce-compound capability's
 * promptContract at src/knowledge-profile.ts:119 (verified): concept, architecture
 * pattern, workflow, integration, failure mode, developer convention. That enum
 * only exists as prompt-contract text there; we re-express it as a real TS union
 * here so the merge/distill normalizers can validate against it deterministically.
 */

/**
 * The KB build branch chosen by the Phase 0 keystone gate.
 *
 * - `full-self-heal`: the contradiction-detector passed the zero-silent-override
 *   gate; auto-apply + corroboration flip + per-card contradicts rendering are live.
 * - `provisional-marking-only`: the gate was PARTIAL; every merge lands provisional,
 *   no auto-apply, but the KB still degrades honestly (only provisional renders).
 * - `manual-authoring`: the gate FAILED; auto-distill is off and cards are hand-curated.
 *
 * Phase 0 outcome for this build = `full-self-heal`. This is the single source of
 * truth Phase 3 reads to gate (3b) contradicts[]/corroborationCount rendering;
 * under `manual-authoring` the freshness block degrades to status + lastUpdated only.
 */
export type KbBuildBranch =
  | "full-self-heal"
  | "provisional-marking-only"
  | "manual-authoring";

/** The active KB build branch (Phase 0 gate outcome). */
export const KB_BUILD_BRANCH: KbBuildBranch = "full-self-heal";

/**
 * Whether the contradicts[]/corroborationCount detail renders in published
 * markdown (Phase 3, split 3b). True for every branch except manual-authoring,
 * where there is no detector output to show.
 */
export function kbRendersContradictionDetail(
  branch: KbBuildBranch = KB_BUILD_BRANCH,
): boolean {
  return branch !== "manual-authoring";
}

/**
 * Card kind taxonomy. Reuses the ce-compound classification verbatim
 * (src/knowledge-profile.ts:119). FROZEN by this spike for Phase 1.
 */
export type KbIntentType =
  | "concept"
  | "architecture pattern"
  | "workflow"
  | "integration"
  | "failure mode"
  | "developer convention";

export const KB_INTENT_TYPES: readonly KbIntentType[] = [
  "concept",
  "architecture pattern",
  "workflow",
  "integration",
  "failure mode",
  "developer convention",
] as const;

/** Authority tiers for the keystone resolver: doc beats wiki beats card. */
export type KbSourceTier = "doc" | "wiki" | "card";

/** Numeric authority weight; higher wins the authority tiebreak (doc > wiki > card). */
export const KB_SOURCE_TIER_WEIGHT: Record<KbSourceTier, number> = {
  doc: 3,
  wiki: 2,
  card: 1,
};

/** A single claim with its provenance back-pointer (recoverability requirement). */
export interface KbClaimProvenance {
  text: string;
  /** The ask whose conversation produced this claim. */
  sourceAskId: string;
}

/**
 * A distilled knowledge card. This is the unit the distill agent produces and the
 * merge agent reconciles against existing cards.
 */
export interface DistillCard {
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
  lastUpdated: string;
  /** Loud flags when this card contradicts a higher-authority source. */
  contradictsFlags: string[];
  /** The prior version retained for auditability/recoverability (review requirement). */
  priorVersion?: DistillCard;
}

/**
 * A seeded existing card the merge agent reasons against. Carries an explicit
 * sourceTier and concrete timestamp so the authority and recency tiebreaks are
 * deterministically testable (plan review fix, section 3).
 */
export interface SeededExistingCard {
  id: string;
  kind: KbIntentType;
  title: string;
  body: string;
  sourceTier: KbSourceTier;
  /** ISO timestamp; drives the recency tiebreak. */
  timestamp: string;
  status: "provisional" | "corroborated";
  corroborationCount: number;
  sourceAskIds: string[];
}

/** How a new card relates to the existing card it matched (if any). */
export type KbClassification = "addition" | "correction" | "contradiction";

/** What the resolver decided to do with the new card. */
export type KbResolution = "apply" | "provisional" | "reject";

/** The corroboration/recency/authority weighing the agent reports for transparency. */
export interface KbWeightRationale {
  corroboration: string;
  recency: string;
  authority: string;
}

/** The rewritten card body plus per-claim provenance (the merge output payload). */
export interface KbRewriteWithProvenance {
  body: string;
  claims: KbClaimProvenance[];
}

/**
 * The keystone merge decision. The contradiction-detector returns this.
 *
 * `currentCorroborationCount` is a merge INPUT (review fix, plan section 3): the
 * normalizer cannot apply the count>=2 corroboration-flip rule without the stored
 * count fed back in. It is fed FROM the matched existing card, not invented by the LLM.
 */
export interface MergeDecision {
  /** The existing card this matches by INTENT (not title). null = genuinely new. */
  intentMatchCardId: string | null;
  classification: KbClassification;
  resolution: KbResolution;
  /** Stored corroboration count for the matched card, fed back as merge INPUT. */
  currentCorroborationCount: number;
  weightRationale: KbWeightRationale;
  rewriteWithProvenance: KbRewriteWithProvenance;
  /** True when the prior card version was retained for recoverability. */
  retainedPriorVersion: boolean;
  /** Set when the new card contradicts a higher-authority source; loudly surfaced. */
  contradictsFlag?: string | null;
}

/**
 * The distill agent's raw output: the clustered cards it extracted from a
 * conversation, before any merge reconciliation against the existing KB.
 */
export interface DistillResult {
  cards: DistillCard[];
}
