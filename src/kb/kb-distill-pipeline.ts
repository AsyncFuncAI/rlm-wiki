/**
 * Phase 2 - Distillation pipeline.
 *
 * Promotes the spike's `runDistill`/`runMerge` (src/kb/kb-merge.ts) into the
 * streaming production pipeline that writes real cards. Structurally this mirrors
 * `generateWiki`'s shape (src/generator.ts): an event-emitting orchestrator over
 * the agent->extract->parse->one-retry calls, except the agents are the sourceless
 * routing-brain path (mode:"chat") so no repo clone is needed.
 *
 * Two input scopes (Decision Log 1):
 *   - increment (chat "Distill to knowledge"): the current cooled thread's history.
 *   - rollup (project star): the wiki summary + selected wiki page content.
 *
 * ALL persistence goes through Phase 1's `mergeSafeAppend` / `saveKnowledgeBase`.
 * Cards are NEVER stored as synthetic GeneratedPage entries (plan section 4, Phase 2
 * review fix: that breaks `wikiArtifactAskContext`).
 *
 * BRANCH = FULL SELF-HEAL: a merge decision of `resolution:"apply"` auto-applies via
 * `saveKnowledgeBase({ allowRewriteCorroborated:true })` (the resolver-only opt). The
 * deterministic bright-line still holds inside `normalizeMergeDecision`: a single
 * unverified contradiction can never reach "apply". When the harness is run in the
 * Phase-0 PARTIAL fallback (selfHeal:false), the resolver is gated off and every
 * card lands provisional via `mergeSafeAppend` only.
 */

import type { LocalCliConfig } from "../local-cli-events.ts";
import type { ProductStore } from "../persistence.ts";
import {
  defaultKbAgentRunner,
  runDistill,
  runMerge,
  type KbAgentRunner,
} from "./kb-merge.ts";
import type { KbHistoryMessage } from "./kb-prompts.ts";
import {
  type DistillCard,
  type MergeDecision,
  type SeededExistingCard,
} from "./knowledge-base-types.ts";
import {
  emptyKnowledgeBase,
  knowledgeBaseArtifactKey,
  loadKnowledgeBase,
  mergeSafeAppend,
  saveKnowledgeBase,
  type KnowledgeBaseData,
  type KnowledgeCard,
} from "./knowledge-base-store.ts";

/** The two distillation input scopes (Decision Log 1). */
export type DistillScope = "increment" | "rollup";

/**
 * Streaming event union for the distill pipeline, mirroring `GenerationEvent`
 * (src/generator.ts:56) one-for-one in shape: a `*-start`/`*-done`/`error`
 * lifecycle the desktop runtime can render. The agents do not stream token
 * deltas (the sourceless runner returns a single raw reply), so events are
 * coarse-grained lifecycle markers, not per-token agent events.
 */
export type DistillEvent =
  | { type: "distill-start"; scope: DistillScope; repoKey: string; existingCardCount: number }
  | { type: "distill-agent"; message: string }
  | { type: "distill-done"; cards: DistillCard[] }
  | MergeEvent
  | { type: "done"; result: DistillRunResult }
  | { type: "error"; error: string };

/** Per-card merge lifecycle, a sub-union of DistillEvent (mirrors page-* events). */
export type MergeEvent =
  | { type: "merge-start"; cardId: string; cardTitle: string; index: number; total: number }
  | { type: "merge-done"; cardId: string; decision: MergeDecision; applied: KbCardOutcome };

/** What the pipeline did with one resolved card. */
export type KbCardOutcome = "applied" | "provisional" | "rejected" | "skipped-corroborated";

/** A single per-card resolution record, surfaced in the final result. */
export interface KbCardResolution {
  cardId: string;
  cardTitle: string;
  classification: MergeDecision["classification"];
  resolution: MergeDecision["resolution"];
  outcome: KbCardOutcome;
  intentMatchCardId: string | null;
  contradictsFlag: string | null;
}

/** The terminal result the `done` event carries. */
export interface DistillRunResult {
  repoKey: string;
  repoLabel: string;
  scope: DistillScope;
  /** Cards the distill agent produced (pre-merge). */
  distilledCount: number;
  resolutions: KbCardResolution[];
  appliedCount: number;
  provisionalCount: number;
  rejectedCount: number;
  /** The persisted KB after all writes (latest snapshot). */
  knowledgeBase: KnowledgeBaseData;
}

/** Options threaded into the pipeline. */
export interface DistillPipelineOptions {
  store: ProductStore;
  repoKey: string;
  repoLabel: string;
  scope: DistillScope;
  /** Increment scope: the cooled thread's conversation turns. */
  history?: KbHistoryMessage[];
  /**
   * Rollup scope: a compacted wiki summary + selected page content, already
   * turned into pseudo-turns by the caller (so the distill prompt stays uniform).
   */
  rollupMessages?: KbHistoryMessage[];
  localCli: LocalCliConfig;
  /**
   * BRANCH gate. true (FULL SELF-HEAL) wires the auto-apply resolver; false
   * (Phase-0 PARTIAL fallback) forces every card to land provisional via
   * mergeSafeAppend only.
   */
  selfHeal: boolean;
  runId?: string | null;
  /** Injectable for tests (canned JSON); production uses defaultKbAgentRunner. */
  runner?: KbAgentRunner;
  onEvent?: (ev: DistillEvent) => void;
  signal?: AbortSignal;
}

/**
 * Convert a persisted `KnowledgeCard` into the `SeededExistingCard` shape the merge
 * agent reasons against. Stored cards carry a status + count but no explicit
 * sourceTier; cards are the lowest authority tier (doc > wiki > card), so an ask-card
 * is seeded as tier "card". Its timestamp drives the recency tiebreak.
 */
export function seededFromKnowledgeCard(card: KnowledgeCard): SeededExistingCard {
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    body: card.body,
    sourceTier: "card",
    timestamp: card.lastUpdated,
    status: card.status,
    corroborationCount: card.corroborationCount,
    sourceAskIds: card.sourceAskIds,
  };
}

/**
 * Build a persisted `KnowledgeCard` from a freshly-distilled card and its merge
 * decision. When the decision matched an existing card the rewritten body (with
 * per-claim provenance) is used; otherwise the distilled body stands. The merge
 * decision's resolution maps onto the stored `status` and `contradictsFlags`.
 *
 * The prior version is retained on `priorVersion` whenever the decision matched and
 * asked to retain it (recoverability requirement, Decision Log 5).
 */
export function knowledgeCardFromDecision(
  distilled: DistillCard,
  decision: MergeDecision,
  matchedExisting: KnowledgeCard | null,
): KnowledgeCard {
  const useRewrite = decision.rewriteWithProvenance.body.trim().length > 0;
  const body = useRewrite ? decision.rewriteWithProvenance.body : distilled.body;

  // Provenance: union of the distilled card's askIds and every claim's sourceAskId.
  const askIds = new Set<string>(distilled.sourceAskIds);
  for (const claim of decision.rewriteWithProvenance.claims) {
    if (claim.sourceAskId) askIds.add(claim.sourceAskId);
  }
  if (matchedExisting) {
    for (const id of matchedExisting.sourceAskIds) askIds.add(id);
  }

  // A contradiction that the resolver did NOT apply stays provisional and loudly
  // flagged. A clean apply earns corroborated only when the count reached >= 2.
  const contradictsFlags = [...distilled.contradictsFlags];
  if (decision.contradictsFlag && !contradictsFlags.includes(decision.contradictsFlag)) {
    contradictsFlags.push(decision.contradictsFlag);
  }

  const corroborationCount = Math.max(
    distilled.corroborationCount,
    matchedExisting?.corroborationCount ?? 0,
    decision.currentCorroborationCount,
  );

  const status: KnowledgeCard["status"] =
    decision.resolution === "apply" && corroborationCount >= 2 && contradictsFlags.length === 0
      ? "corroborated"
      : "provisional";

  // Keep the matched card's id so a merge rewrites it in place (the resolver path),
  // otherwise the distilled id (a genuinely new card).
  const id = matchedExisting?.id ?? distilled.id;

  const card: KnowledgeCard = {
    id,
    kind: distilled.kind,
    title: distilled.title || matchedExisting?.title || id,
    body,
    sourceAskIds: [...askIds],
    status,
    corroborationCount,
    lastUpdated: new Date().toISOString(),
    contradictsFlags,
    topicTags: matchedExisting?.topicTags ?? [],
    repoRefs: matchedExisting?.repoRefs ?? [],
  };

  // Retain the prior version for recoverability when we rewrote a matched card.
  if (matchedExisting && decision.retainedPriorVersion) {
    card.priorVersion = matchedExisting;
  }
  return card;
}

/**
 * Run ONE distill turn (agent -> extract -> parse -> one repair turn), emitting the
 * lifecycle events. Thin wrapper over the spike's `runDistill` so the merge half can
 * be tested independently.
 */
export async function runDistillAgent(
  messages: KbHistoryMessage[],
  existing: SeededExistingCard[],
  localCli: LocalCliConfig,
  runner: KbAgentRunner,
  onEvent?: (ev: DistillEvent) => void,
  signal?: AbortSignal,
): Promise<DistillCard[]> {
  onEvent?.({ type: "distill-agent", message: "Reading the conversation for durable knowledge." });
  const result = await runDistill(messages, existing, localCli, withSignalGuard(runner, signal));
  onEvent?.({ type: "distill-done", cards: result.cards });
  return result.cards;
}

/**
 * Run ONE merge turn for a single distilled card (agent -> extract -> normalize ->
 * one repair turn). The deterministic bright-line lives inside
 * `normalizeMergeDecision`; this is a thin wrapper that feeds the stored count of the
 * matched competing claim as the merge INPUT.
 */
export async function runMergeAgent(
  distilled: DistillCard,
  existing: SeededExistingCard[],
  currentCorroborationCount: number,
  localCli: LocalCliConfig,
  runner: KbAgentRunner,
  signal?: AbortSignal,
): Promise<MergeDecision> {
  return runMerge(distilled, existing, currentCorroborationCount, localCli, withSignalGuard(runner, signal));
}

/** Wrap a runner so an aborted signal short-circuits before the next agent call. */
function withSignalGuard(runner: KbAgentRunner, signal?: AbortSignal): KbAgentRunner {
  if (!signal) return runner;
  return (prompt, localCli, innerSignal) => {
    if (signal.aborted) {
      return Promise.reject(new Error("Stopped by user."));
    }
    return runner(prompt, localCli, innerSignal ?? signal);
  };
}

/**
 * The full distillation pipeline: distill -> per-card merge -> resolve -> persist.
 *
 * Persistence rules (the only write paths, per Phase 1):
 *   - `mergeSafeAppend` for provisional/append cards (and ALWAYS in fallback mode).
 *     It never rewrites a corroborated card.
 *   - `saveKnowledgeBase({ allowRewriteCorroborated:true })` only when selfHeal is on
 *     AND the resolver returned `resolution:"apply"` on a card that matched an
 *     existing CORROBORATED card (the only case mergeSafeAppend would refuse).
 *
 * Increment scope sets `lastIncrementAt`; rollup sets `lastRollupAt` (via the scope
 * threaded into mergeSafeAppend / a direct save).
 */
export async function distillToKnowledgeBase(
  opts: DistillPipelineOptions,
): Promise<DistillRunResult> {
  const {
    store,
    scope,
    localCli,
    selfHeal,
    runId = null,
    runner = defaultKbAgentRunner,
    onEvent,
    signal,
  } = opts;
  const repoKey = knowledgeBaseArtifactKey(opts.repoKey);
  const repoLabel = String(opts.repoLabel || repoKey).trim() || repoKey;

  const messages = scope === "rollup" ? opts.rollupMessages ?? [] : opts.history ?? [];

  const existingKb =
    (await loadKnowledgeBase(store, repoKey)) ?? emptyKnowledgeBase(repoKey, repoLabel);
  const existingById = new Map(existingKb.cards.map((c) => [c.id, c]));
  const seeded = existingKb.cards.map(seededFromKnowledgeCard);

  onEvent?.({
    type: "distill-start",
    scope,
    repoKey,
    existingCardCount: existingKb.cards.length,
  });

  throwIfAborted(signal);
  const distilled = await runDistillAgent(messages, seeded, localCli, runner, onEvent, signal);

  // Resolve each distilled card against the existing KB, one merge call at a time
  // (the spike's two-sequential-calls design, easier to isolate which step fails).
  const resolutions: KbCardResolution[] = [];
  // Provisional/append cards are batched into one mergeSafeAppend; apply-on-corroborated
  // cards are written individually via the resolver path.
  const provisionalAppend: KnowledgeCard[] = [];

  for (let i = 0; i < distilled.length; i++) {
    throwIfAborted(signal);
    const card = distilled[i];
    onEvent?.({
      type: "merge-start",
      cardId: card.id,
      cardTitle: card.title,
      index: i,
      total: distilled.length,
    });

    // Find a likely match by id first (the distill agent reuses ids for known cards);
    // the merge agent confirms/overrides via intentMatchCardId by MEANING.
    const idGuess = existingById.get(card.id) ?? null;

    // The bright-line count fed to the normalizer is how many sources back the NEW
    // claim (the distilled card's corroborationCount). A lone source (count < 2) on a
    // contradiction is FORCED provisional regardless of the LLM output. The matched
    // card's own count never relaxes that — only corroboration of the new claim does.
    const newClaimCount = Math.max(0, card.corroborationCount || 0);

    const decision = await runMergeAgent(card, seeded, newClaimCount, localCli, runner, signal);

    // The authoritative match is the one the agent chose by intent.
    const matched = decision.intentMatchCardId
      ? existingById.get(decision.intentMatchCardId) ?? idGuess
      : null;

    let outcome: KbCardOutcome;
    if (decision.resolution === "reject") {
      outcome = "rejected";
    } else {
      const resolved = knowledgeCardFromDecision(card, decision, matched);
      const matchedCorroborated = matched?.status === "corroborated";

      if (selfHeal && decision.resolution === "apply" && matchedCorroborated) {
        // The ONLY case mergeSafeAppend refuses: rewriting ground truth. The
        // deterministic bright-line already guaranteed a lone contradiction never
        // reaches here. Apply directly via the resolver-only opt.
        await applyResolverCard(store, repoKey, repoLabel, resolved, scope, runId);
        outcome = "applied";
      } else if (matchedCorroborated && decision.classification === "contradiction") {
        // A flagged contradiction against corroborated ground truth that did NOT win
        // (lone source / fallback): the ground truth is preserved verbatim, but the
        // conflict must stay VISIBLE (Decision Log 6 "loudly flagged"), not silently
        // dropped. Persist it as a SEPARATE provisional card under a distinct id so
        // the KB view can surface the contradiction banner. mergeSafeAppend never
        // touches the corroborated card (its id differs).
        const contestedId = `${resolved.id}-contested`;
        provisionalAppend.push({
          ...resolved,
          id: contestedId,
          status: "provisional",
          priorVersion: undefined,
        });
        outcome = "provisional";
      } else if (matchedCorroborated) {
        // A non-contradiction match against a corroborated card (e.g. a duplicate
        // addition) with no winning resolution: ground truth already holds the
        // knowledge, so do not append a redundant provisional card.
        outcome = "skipped-corroborated";
      } else {
        // New card or a provisional match: safe to append. In fallback mode every
        // card lands here as provisional regardless of the LLM's resolution.
        provisionalAppend.push({ ...resolved, status: selfHeal ? resolved.status : "provisional" });
        outcome = selfHeal && resolved.status === "corroborated" ? "applied" : "provisional";
      }
    }

    resolutions.push({
      cardId: card.id,
      cardTitle: card.title,
      classification: decision.classification,
      resolution: decision.resolution,
      outcome,
      intentMatchCardId: decision.intentMatchCardId,
      contradictsFlag: decision.contradictsFlag ?? null,
    });
    onEvent?.({ type: "merge-done", cardId: card.id, decision, applied: outcome });
  }

  throwIfAborted(signal);
  // One safe-append for all provisional/new cards (sets lastIncrement/lastRollup).
  let knowledgeBase: KnowledgeBaseData;
  if (provisionalAppend.length) {
    knowledgeBase = await mergeSafeAppend(store, repoKey, provisionalAppend, {
      runId,
      repoLabel,
      scope,
    });
  } else {
    // No appends, but a rollup/increment still touched the KB: refresh the timestamp
    // so the star-glow staleness check resolves (an empty distill is still a sync).
    knowledgeBase = await mergeSafeAppend(store, repoKey, [], { runId, repoLabel, scope });
  }

  const appliedCount = resolutions.filter((r) => r.outcome === "applied").length;
  const provisionalCount = resolutions.filter((r) => r.outcome === "provisional").length;
  const rejectedCount = resolutions.filter((r) => r.outcome === "rejected").length;

  const result: DistillRunResult = {
    repoKey,
    repoLabel,
    scope,
    distilledCount: distilled.length,
    resolutions,
    appliedCount,
    provisionalCount,
    rejectedCount,
    knowledgeBase,
  };
  onEvent?.({ type: "done", result });
  return result;
}

/**
 * Apply a resolver-rewrite of a corroborated card via the resolver-only opt. Loads
 * the current KB, replaces the matched card in place, and saves with
 * `allowRewriteCorroborated:true`. This is the ONLY caller of that opt outside
 * direct admin tooling; the deterministic bright-line in `normalizeMergeDecision`
 * is what makes reaching this path safe.
 */
async function applyResolverCard(
  store: ProductStore,
  repoKey: string,
  repoLabel: string,
  card: KnowledgeCard,
  scope: DistillScope,
  runId: string | null,
): Promise<void> {
  const current = (await loadKnowledgeBase(store, repoKey)) ?? emptyKnowledgeBase(repoKey, repoLabel);
  const nowIso = new Date().toISOString();
  const idx = current.cards.findIndex((c) => c.id === card.id);
  const cards = [...current.cards];
  if (idx === -1) cards.push(card);
  else cards[idx] = card;

  await saveKnowledgeBase(
    store,
    {
      ...current,
      repoKey,
      repoLabel: repoLabel || current.repoLabel,
      cards,
      lastIncrementAt: scope === "rollup" ? current.lastIncrementAt : nowIso,
      lastRollupAt: scope === "rollup" ? nowIso : current.lastRollupAt,
    },
    {
      expectedUpdatedAt: current.updatedAt,
      allowRewriteCorroborated: true,
      runId,
    },
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Stopped by user.");
}
