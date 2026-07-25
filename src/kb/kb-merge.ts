import { extractDecision } from "../local-cli-parsers.ts";
import { LocalCliAgent } from "../local-cli-runtime.ts";
import type { LocalCliConfig } from "../local-cli-events.ts";
import {
  buildDistillPrompt,
  buildKbRepairPrompt,
  buildMergePrompt,
  type KbHistoryMessage,
} from "./kb-prompts.ts";
import {
  KB_INTENT_TYPES,
  type DistillCard,
  type DistillResult,
  type KbClassification,
  type KbIntentType,
  type KbResolution,
  type MergeDecision,
  type SeededExistingCard,
} from "./knowledge-base-types.ts";

/**
 * Knowledge Base distill + merge harness.
 *
 * Structurally identical to the routing-brain path (src/server.ts:1097-1145):
 * injectable runner -> agent -> extractDecision (JSON, not XML) -> normalize, with
 * ONE repair turn gated by `kbRawTextHasDecision`. The normalizer NEVER auto-applies
 * on malformed/uncertain output; it degrades to provisional. It deterministically
 * forces provisional on `classification === "contradiction" && currentCorroborationCount < 2`.
 */

const KB_AGENT_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.GROK_WIKI_KB_TIMEOUT_MS || 60_000),
);

/**
 * Injectable runner, mirroring `RouteAgentRunner` (src/server.ts:1097). Tests inject
 * canned JSON strings; production uses `defaultKbAgentRunner`.
 */
export interface KbAgentRunner {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal): Promise<string>;
}

/**
 * Default runner: the sourceless routing-brain path (`mode:"chat"`, empty CWD, no
 * repo clone — seconds not minutes). The `?? ""` guard is MANDATORY (review fix):
 * without it, a null rawText flows into extractDecision whose `typeof !== "string"`
 * guard would silently trigger the repair turn on every call.
 */
export async function defaultKbAgentRunner(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
): Promise<string> {
  const agent = new LocalCliAgent({
    mode: "chat",
    contextLabel: "chat",
    localCli,
  });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

/**
 * True when the agent's raw text contained a parseable JSON object. Mirrors the real
 * `routeRawTextHasDecision` check (src/server.ts:1066) exactly — `extractDecision(raw)
 * !== null`, NOT a loose `JSON.parse` (review fix).
 */
export function kbRawTextHasDecision(raw: string): boolean {
  return extractDecision(raw) !== null;
}

// ---------------------------------------------------------------------------
// Pure normalizers (synchronous, deterministic, CI-safe — the PASS bar for the
// parse/normalize half of the keystone).
// ---------------------------------------------------------------------------

function isIntentType(value: unknown): value is KbIntentType {
  return typeof value === "string" && (KB_INTENT_TYPES as readonly string[]).includes(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asNonNegInt(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

const CLASSIFICATIONS = new Set<KbClassification>(["addition", "correction", "contradiction"]);
const RESOLUTIONS = new Set<KbResolution>(["apply", "provisional", "reject"]);

/**
 * Normalize one raw distilled card. Drops anything whose kind is not in the frozen
 * taxonomy or that carries no provenance (sourceAskIds), since both are mandatory.
 * Returns null for an unusable card so the caller can filter it out.
 */
export function normalizeDistillCard(raw: unknown): DistillCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (!isIntentType(row.kind)) return null;

  const sourceAskIds = asStringArray(row.sourceAskIds);
  // Provenance is mandatory — a card with no contributing ask is unusable.
  if (sourceAskIds.length === 0) return null;

  const title = asString(row.title).trim();
  const body = asString(row.body).trim();
  if (!title || !body) return null;

  const id = asString(row.id).trim() || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const corroborationCount = Math.max(1, asNonNegInt(row.corroborationCount, 1));
  // A card only earns "corroborated" once it has >= 2 sources; otherwise provisional.
  const status: DistillCard["status"] =
    row.status === "corroborated" && corroborationCount >= 2 ? "corroborated" : "provisional";

  return {
    id,
    kind: row.kind,
    title,
    body,
    sourceAskIds,
    status,
    corroborationCount,
    lastUpdated: asString(row.lastUpdated).trim() || new Date(0).toISOString(),
    contradictsFlags: asStringArray(row.contradictsFlags),
  };
}

/** Normalize the distill agent's raw decision object into a DistillResult. */
export function normalizeDistillResult(parsed: unknown): DistillResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { cards: [] };
  const row = parsed as Record<string, unknown>;
  const rawCards = Array.isArray(row.cards) ? row.cards : [];
  const cards = rawCards
    .map((c) => normalizeDistillCard(c))
    .filter((c): c is DistillCard => c !== null);
  return { cards };
}

/**
 * Normalize a raw merge decision into the locked `MergeDecision` contract.
 *
 * THE KEYSTONE INVARIANT (deterministic, regardless of LLM output):
 *   classification === "contradiction" && currentCorroborationCount < 2
 *     => resolution forced to "provisional", never "apply".
 * And the count-flip: a contradiction with count >= 2 may keep "apply".
 *
 * `currentCorroborationCount` is a merge INPUT — the caller feeds the stored count
 * from the matched existing card, since the LLM cannot be trusted to recall it.
 *
 * On malformed/missing output the normalizer degrades to provisional (mirrors
 * `normalizeRouteDecision`'s degrade-to-clarify); it NEVER fabricates an "apply".
 */
export function normalizeMergeDecision(
  parsed: unknown,
  currentCorroborationCount: number,
): MergeDecision {
  const safeCount = asNonNegInt(currentCorroborationCount, 0);

  const degradedBase: MergeDecision = {
    intentMatchCardId: null,
    classification: "addition",
    resolution: "provisional",
    currentCorroborationCount: safeCount,
    weightRationale: {
      corroboration: "Output was not parseable; degraded to provisional for human review.",
      recency: "",
      authority: "",
    },
    rewriteWithProvenance: { body: "", claims: [] },
    retainedPriorVersion: false,
    contradictsFlag: null,
  };

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return degradedBase;
  }
  const row = parsed as Record<string, unknown>;

  const intentMatchCardId =
    typeof row.intentMatchCardId === "string" && row.intentMatchCardId.trim() && row.intentMatchCardId !== "null"
      ? row.intentMatchCardId.trim()
      : null;

  const classification: KbClassification = CLASSIFICATIONS.has(row.classification as KbClassification)
    ? (row.classification as KbClassification)
    : "addition";

  // Trust the LLM's resolution only if it is a valid enum value; otherwise degrade.
  let resolution: KbResolution = RESOLUTIONS.has(row.resolution as KbResolution)
    ? (row.resolution as KbResolution)
    : "provisional";

  // --- THE BRIGHT LINE (deterministic override) -------------------------------
  // A single unverified contradiction can NEVER auto-apply, no matter what the LLM
  // returned. It is forced to provisional. The count-flip (>= 2) lets a corroborated
  // contradiction keep its "apply".
  if (classification === "contradiction" && safeCount < 2 && resolution === "apply") {
    resolution = "provisional";
  }
  // ---------------------------------------------------------------------------

  const rationaleRaw =
    row.weightRationale && typeof row.weightRationale === "object" && !Array.isArray(row.weightRationale)
      ? (row.weightRationale as Record<string, unknown>)
      : {};

  const rewriteRaw =
    row.rewriteWithProvenance && typeof row.rewriteWithProvenance === "object" && !Array.isArray(row.rewriteWithProvenance)
      ? (row.rewriteWithProvenance as Record<string, unknown>)
      : {};
  const claimsRaw = Array.isArray(rewriteRaw.claims) ? rewriteRaw.claims : [];
  const claims = claimsRaw
    .map((c) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) return null;
      const cr = c as Record<string, unknown>;
      const text = asString(cr.text).trim();
      const sourceAskId = asString(cr.sourceAskId).trim();
      if (!text || !sourceAskId) return null;
      return { text, sourceAskId };
    })
    .filter((c): c is { text: string; sourceAskId: string } => c !== null);

  const contradictsFlag =
    typeof row.contradictsFlag === "string" && row.contradictsFlag.trim() && row.contradictsFlag !== "null"
      ? row.contradictsFlag.trim()
      : null;

  return {
    intentMatchCardId,
    classification,
    resolution,
    currentCorroborationCount: safeCount,
    weightRationale: {
      corroboration: asString(rationaleRaw.corroboration),
      recency: asString(rationaleRaw.recency),
      authority: asString(rationaleRaw.authority),
    },
    rewriteWithProvenance: {
      body: asString(rewriteRaw.body),
      claims,
    },
    // If the LLM matched an existing card, the prior version must be retained.
    retainedPriorVersion: intentMatchCardId !== null ? row.retainedPriorVersion !== false : Boolean(row.retainedPriorVersion),
    contradictsFlag,
  };
}

// ---------------------------------------------------------------------------
// Agent runners (agent -> extract -> normalize, with one repair turn).
// ---------------------------------------------------------------------------

/**
 * Run the distill step: cluster a conversation's conclusive turns into cards.
 * Mirrors `runRouteDecision` — agent-first with one repair turn gated by
 * `kbRawTextHasDecision`; degrades to an empty card list on total failure.
 */
export async function runDistill(
  historyMessages: KbHistoryMessage[],
  existingCards: SeededExistingCard[],
  localCli: LocalCliConfig,
  runner: KbAgentRunner = defaultKbAgentRunner,
  timeoutMs: number = KB_AGENT_TIMEOUT_MS,
): Promise<DistillResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("kb distill timeout"), timeoutMs);
  try {
    const prompt = buildDistillPrompt(historyMessages, existingCards);
    const raw = await runner(prompt, localCli, controller.signal);
    if (kbRawTextHasDecision(raw)) {
      return normalizeDistillResult(extractDecision(raw));
    }
    const repaired = await runner(buildKbRepairPrompt(prompt, raw), localCli, controller.signal);
    return normalizeDistillResult(extractDecision(repaired));
  } catch {
    // Degrade honestly: no cards rather than fabricated ones.
    return { cards: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the merge step for ONE card against the existing KB.
 *
 * `currentCorroborationCount` is fed in as the stored count for the matched card's
 * competing claim (merge INPUT) so the deterministic count-flip rule can apply even
 * when the LLM omits or misreports it. On total failure, degrades to a provisional
 * decision — NEVER an "apply".
 */
export async function runMerge(
  newCard: DistillCard,
  existingCards: SeededExistingCard[],
  currentCorroborationCount: number,
  localCli: LocalCliConfig,
  runner: KbAgentRunner = defaultKbAgentRunner,
  timeoutMs: number = KB_AGENT_TIMEOUT_MS,
): Promise<MergeDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("kb merge timeout"), timeoutMs);
  try {
    const prompt = buildMergePrompt(newCard, existingCards);
    const raw = await runner(prompt, localCli, controller.signal);
    if (kbRawTextHasDecision(raw)) {
      return normalizeMergeDecision(extractDecision(raw), currentCorroborationCount);
    }
    const repaired = await runner(buildKbRepairPrompt(prompt, raw), localCli, controller.signal);
    return normalizeMergeDecision(extractDecision(repaired), currentCorroborationCount);
  } catch {
    // Degrade to provisional, never apply, on agent failure.
    return normalizeMergeDecision(null, currentCorroborationCount);
  } finally {
    clearTimeout(timer);
  }
}
