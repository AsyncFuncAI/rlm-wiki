/**
 * Phase 2 distillation-pipeline tests.
 *
 * Strategy (cross-cutting section 5): pure-function first, then the full pipeline
 * driven by an INJECTABLE runner returning canned JSON (zero LLM, CI-safe), against
 * the REAL SQLite ProductStore (high fidelity, not a mock). One env-gated live test
 * exercises the real agent end-to-end and is skipped in CI.
 *
 * The pipeline makes sequential agent calls in a fixed order: ONE distill call, then
 * ONE merge call per distilled card. A `queuedRunner` returns the next canned reply
 * per call so the two steps can be scripted independently.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProductStore, type ProductStore } from "../persistence.ts";
import { normalizeLocalCliConfig } from "../local-cli-events.ts";
import {
  loadKnowledgeBase,
  saveKnowledgeBase,
  emptyKnowledgeBase,
  type KnowledgeCard,
} from "./knowledge-base-store.ts";
import type { KbAgentRunner } from "./kb-merge.ts";
import type { DistillCard, MergeDecision } from "./knowledge-base-types.ts";
import {
  distillToKnowledgeBase,
  knowledgeCardFromDecision,
  seededFromKnowledgeCard,
  type DistillEvent,
} from "./kb-distill-pipeline.ts";
import { buildRollupMessages, summariseWikiForRollup, wikiPageAskId } from "./kb-rollup-input.ts";
import { eccConversation } from "./__fixtures__/ecc-conversation.ts";
import type { WikiRecord } from "../types.ts";

const localCli = normalizeLocalCliConfig({ agentId: "claude" });
const tempDirs: string[] = [];

function tempSqlitePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-kb-distill-"));
  tempDirs.push(dir);
  return join(dir, "desktop.sqlite3");
}

async function freshStore(): Promise<ProductStore> {
  process.env.RLM_WIKI_SQLITE_PATH = tempSqlitePath();
  return createProductStore(tempDirs[tempDirs.length - 1], { ownerUserId: "legacy" });
}

/** A runner that returns the next reply in `replies` on each call (FIFO). */
function queuedRunner(replies: string[]): KbAgentRunner {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)] ?? "";
}

function fence(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj) + "\n```";
}

function card(overrides: Partial<KnowledgeCard> & { id: string }): KnowledgeCard {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "workflow",
    title: overrides.title ?? "Card",
    body: overrides.body ?? "body",
    sourceAskIds: overrides.sourceAskIds ?? ["ask-1"],
    status: overrides.status ?? "provisional",
    corroborationCount: overrides.corroborationCount ?? 1,
    lastUpdated: overrides.lastUpdated ?? new Date().toISOString(),
    contradictsFlags: overrides.contradictsFlags ?? [],
    topicTags: overrides.topicTags ?? [],
    repoRefs: overrides.repoRefs ?? [],
    ...(overrides.priorVersion ? { priorVersion: overrides.priorVersion } : {}),
  };
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  delete process.env.RLM_WIKI_SQLITE_PATH;
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure: seededFromKnowledgeCard / knowledgeCardFromDecision
// ---------------------------------------------------------------------------

describe("seededFromKnowledgeCard", () => {
  test("maps a stored card to a 'card' authority tier with its timestamp", () => {
    const stored = card({ id: "c1", lastUpdated: "2026-01-01T00:00:00.000Z", corroborationCount: 2 });
    const seeded = seededFromKnowledgeCard(stored);
    expect(seeded.sourceTier).toBe("card"); // ask-cards are the lowest authority tier
    expect(seeded.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(seeded.corroborationCount).toBe(2);
  });
});

describe("knowledgeCardFromDecision", () => {
  const distilled: DistillCard = {
    id: "new-card",
    kind: "concept",
    title: "New concept",
    body: "fresh body",
    sourceAskIds: ["ask-new"],
    status: "provisional",
    corroborationCount: 1,
    lastUpdated: "2026-06-07T00:00:00.000Z",
    contradictsFlags: [],
  };

  test("an addition with no match keeps the distilled id and body", () => {
    const decision: MergeDecision = {
      intentMatchCardId: null,
      classification: "addition",
      resolution: "apply",
      currentCorroborationCount: 0,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "", claims: [] },
      retainedPriorVersion: false,
      contradictsFlag: null,
    };
    const out = knowledgeCardFromDecision(distilled, decision, null);
    expect(out.id).toBe("new-card");
    expect(out.body).toBe("fresh body"); // no rewrite body -> distilled body stands
    expect(out.sourceAskIds).toContain("ask-new");
    expect(out.status).toBe("provisional"); // count < 2 stays provisional even on apply
  });

  test("a matched rewrite uses the matched id, rewritten body, retains prior, merges provenance", () => {
    const existing = card({ id: "existing-1", body: "old body", sourceAskIds: ["ask-old"], corroborationCount: 1 });
    const decision: MergeDecision = {
      intentMatchCardId: "existing-1",
      classification: "correction",
      resolution: "apply",
      currentCorroborationCount: 1,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: {
        body: "merged body",
        claims: [{ text: "claim", sourceAskId: "ask-new" }],
      },
      retainedPriorVersion: true,
      contradictsFlag: null,
    };
    const out = knowledgeCardFromDecision(distilled, decision, existing);
    expect(out.id).toBe("existing-1"); // rewrite the matched card in place
    expect(out.body).toBe("merged body");
    expect(out.priorVersion?.id).toBe("existing-1"); // prior retained for recoverability
    expect(out.priorVersion?.body).toBe("old body");
    expect(out.sourceAskIds).toEqual(expect.arrayContaining(["ask-new", "ask-old"]));
  });

  test("a corroborated apply (count >= 2, no contradiction) earns corroborated status", () => {
    const existing = card({ id: "existing-2", corroborationCount: 2, status: "provisional" });
    const decision: MergeDecision = {
      intentMatchCardId: "existing-2",
      classification: "correction",
      resolution: "apply",
      currentCorroborationCount: 2,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "x", claims: [] },
      retainedPriorVersion: true,
      contradictsFlag: null,
    };
    const out = knowledgeCardFromDecision(distilled, decision, existing);
    expect(out.corroborationCount).toBeGreaterThanOrEqual(2);
    expect(out.status).toBe("corroborated");
  });

  test("a contradiction flag forces provisional even when the resolution says apply", () => {
    const decision: MergeDecision = {
      intentMatchCardId: "doc-card",
      classification: "contradiction",
      resolution: "apply", // (would only ever happen post count>=2; flag still demotes)
      currentCorroborationCount: 2,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "x", claims: [] },
      retainedPriorVersion: true,
      contradictsFlag: "Contradicts README default port (8080).",
    };
    const out = knowledgeCardFromDecision(distilled, decision, card({ id: "doc-card", corroborationCount: 2 }));
    expect(out.contradictsFlags).toContain("Contradicts README default port (8080).");
    expect(out.status).toBe("provisional"); // a flagged contradiction never reads as ground truth
  });
});

// ---------------------------------------------------------------------------
// Pipeline (canned runner + real SQLite store)
// ---------------------------------------------------------------------------

const REPO = "gh:acme/ecc";

describe("distillToKnowledgeBase (increment, self-heal on)", () => {
  test("distills + appends new provisional cards via mergeSafeAppend", async () => {
    const store = await freshStore();
    const distillReply = fence({
      cards: [
        {
          id: "install-ecc",
          kind: "workflow",
          title: "Install ECC",
          body: "Run bun add -g ecc.",
          sourceAskIds: ["q1", "q2"],
          status: "provisional",
          corroborationCount: 1,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    const mergeReply = fence({
      intentMatchCardId: null,
      classification: "addition",
      resolution: "provisional",
      currentCorroborationCount: 0,
      weightRationale: { corroboration: "new", recency: "new", authority: "card" },
      rewriteWithProvenance: { body: "", claims: [] },
      retainedPriorVersion: false,
      contradictsFlag: null,
    });
    const events: DistillEvent[] = [];
    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "increment",
      history: [{ askId: "q1", role: "user", content: "how do I install?" }],
      localCli,
      selfHeal: true,
      runner: queuedRunner([distillReply, mergeReply]),
      onEvent: (ev) => events.push(ev),
    });

    expect(result.distilledCount).toBe(1);
    expect(result.provisionalCount).toBe(1);
    expect(result.appliedCount).toBe(0);

    const kb = await loadKnowledgeBase(store, REPO);
    expect(kb?.cards.map((c) => c.id)).toContain("install-ecc");
    expect(kb?.cards[0].status).toBe("provisional");
    expect(kb?.lastIncrementAt).toBeTruthy(); // increment stamped
    expect(kb?.lastRollupAt).toBeNull();

    // events mirror GenerationEvent lifecycle: start -> distill-done -> merge -> done
    expect(events.find((e) => e.type === "distill-start")).toBeTruthy();
    expect(events.find((e) => e.type === "distill-done")).toBeTruthy();
    expect(events.find((e) => e.type === "merge-done")).toBeTruthy();
    expect(events.find((e) => e.type === "done")).toBeTruthy();
  });

  test("KEYSTONE: a lone contradiction against a corroborated doc card never overwrites it", async () => {
    const store = await freshStore();
    // Seed a corroborated doc-equivalent card (the ground truth).
    const seededKb = emptyKnowledgeBase(REPO, "acme/ecc");
    seededKb.cards = [
      card({
        id: "default-port",
        kind: "developer convention",
        title: "ECC default port",
        body: "Per README the port is 8080.",
        status: "corroborated",
        corroborationCount: 3,
        sourceAskIds: ["readme"],
      }),
    ];
    await saveKnowledgeBase(store, seededKb, {});

    // The distill produces a fresh card claiming 3000, reusing the existing id so the
    // merge step weighs it against the corroborated card.
    const distillReply = fence({
      cards: [
        {
          id: "default-port",
          kind: "developer convention",
          title: "ECC default port",
          body: "The default port is 3000.",
          sourceAskIds: ["q-port"],
          status: "provisional",
          corroborationCount: 1,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    // Even if the LLM mistakenly returns resolution:"apply", the deterministic
    // bright-line in normalizeMergeDecision (contradiction + count<2) forces provisional.
    const mergeReply = fence({
      intentMatchCardId: "default-port",
      classification: "contradiction",
      resolution: "apply",
      currentCorroborationCount: 3,
      weightRationale: { corroboration: "single source loses", recency: "newer", authority: "doc wins" },
      rewriteWithProvenance: { body: "The default port is 3000.", claims: [{ text: "3000", sourceAskId: "q-port" }] },
      retainedPriorVersion: true,
      contradictsFlag: "Contradicts README default port (8080).",
    });

    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "increment",
      history: [{ askId: "q-port", role: "user", content: "what port?" }],
      localCli,
      selfHeal: true,
      // currentCorroborationCount for the matched card is fed from storage (3), but
      // the normalizer also forces provisional because the NEW card has count 1.
      runner: queuedRunner([distillReply, mergeReply]),
    });

    // The pipeline must NOT have applied: the resolution normalized to provisional.
    // Ground truth is preserved, AND the conflict is made visible as a separate
    // provisional "contested" card (Decision Log 6: loudly flagged, never dropped).
    const r = result.resolutions[0];
    expect(r.resolution).toBe("provisional"); // bright-line held
    expect(r.outcome).toBe("provisional"); // conflict recorded, not silently dropped
    expect(r.contradictsFlag).toBeTruthy();
    expect(result.appliedCount).toBe(0);

    const kb = await loadKnowledgeBase(store, REPO);
    const port = kb?.cards.find((c) => c.id === "default-port");
    expect(port?.body).toBe("Per README the port is 8080."); // UNCHANGED ground truth
    expect(port?.status).toBe("corroborated");
    // The contradiction surfaces as a distinct provisional card carrying the flag.
    const contested = kb?.cards.find((c) => c.id === "default-port-contested");
    expect(contested?.status).toBe("provisional");
    expect(contested?.body).toContain("3000");
    expect(contested?.contradictsFlags.length).toBeGreaterThan(0);
  });

  test("self-heal applies a corroborated rewrite (count>=2) via the resolver path", async () => {
    const store = await freshStore();
    const seededKb = emptyKnowledgeBase(REPO, "acme/ecc");
    seededKb.cards = [
      card({
        id: "build-cmd",
        kind: "workflow",
        title: "Build command",
        body: "Run make build.",
        status: "corroborated",
        corroborationCount: 2,
        sourceAskIds: ["old"],
      }),
    ];
    await saveKnowledgeBase(store, seededKb, {});

    const distillReply = fence({
      cards: [
        {
          id: "build-cmd",
          kind: "workflow",
          title: "Build command",
          body: "Run bun run build (corrected, corroborated).",
          sourceAskIds: ["q-build-a", "q-build-b"],
          status: "corroborated",
          corroborationCount: 2,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    const mergeReply = fence({
      intentMatchCardId: "build-cmd",
      classification: "correction",
      resolution: "apply",
      currentCorroborationCount: 2,
      weightRationale: { corroboration: "2 sources agree", recency: "newer", authority: "card" },
      rewriteWithProvenance: {
        body: "Run bun run build (corrected, corroborated).",
        claims: [
          { text: "bun run build", sourceAskId: "q-build-a" },
          { text: "confirmed", sourceAskId: "q-build-b" },
        ],
      },
      retainedPriorVersion: true,
      contradictsFlag: null,
    });

    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "increment",
      history: [{ askId: "q-build-a", role: "user", content: "how to build?" }],
      localCli,
      selfHeal: true,
      runner: queuedRunner([distillReply, mergeReply]),
    });

    expect(result.resolutions[0].outcome).toBe("applied");
    expect(result.appliedCount).toBe(1);

    const kb = await loadKnowledgeBase(store, REPO);
    const built = kb?.cards.find((c) => c.id === "build-cmd");
    expect(built?.body).toContain("bun run build");
    expect(built?.priorVersion?.body).toBe("Run make build."); // prior retained
    expect(built?.status).toBe("corroborated");
  });
});

describe("distillToKnowledgeBase (fallback mode, self-heal off)", () => {
  test("every card lands provisional regardless of the LLM resolution", async () => {
    const store = await freshStore();
    const distillReply = fence({
      cards: [
        {
          id: "fact-1",
          kind: "concept",
          title: "Fact",
          body: "A durable fact.",
          sourceAskIds: ["q1", "q2"],
          status: "corroborated",
          corroborationCount: 2,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    const mergeReply = fence({
      intentMatchCardId: null,
      classification: "addition",
      resolution: "apply", // LLM says apply...
      currentCorroborationCount: 0,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "", claims: [] },
      retainedPriorVersion: false,
      contradictsFlag: null,
    });

    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "increment",
      history: [{ askId: "q1", role: "user", content: "x" }],
      localCli,
      selfHeal: false, // PARTIAL fallback
      runner: queuedRunner([distillReply, mergeReply]),
    });

    // ...but fallback forces provisional persistence.
    const kb = await loadKnowledgeBase(store, REPO);
    expect(kb?.cards.find((c) => c.id === "fact-1")?.status).toBe("provisional");
    expect(result.appliedCount).toBe(0);
    expect(result.provisionalCount).toBe(1);
  });
});

describe("distillToKnowledgeBase (rollup scope)", () => {
  test("rollup stamps lastRollupAt, not lastIncrementAt", async () => {
    const store = await freshStore();
    const distillReply = fence({
      cards: [
        {
          id: "arch-overview",
          kind: "architecture pattern",
          title: "Architecture overview",
          body: "The system has three layers.",
          sourceAskIds: [wikiPageAskId("structure")],
          status: "provisional",
          corroborationCount: 1,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    const mergeReply = fence({
      intentMatchCardId: null,
      classification: "addition",
      resolution: "provisional",
      currentCorroborationCount: 0,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "", claims: [] },
      retainedPriorVersion: false,
      contradictsFlag: null,
    });

    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "rollup",
      rollupMessages: [{ askId: wikiPageAskId("structure"), role: "user", content: "wiki summary" }],
      localCli,
      selfHeal: true,
      runner: queuedRunner([distillReply, mergeReply]),
    });

    expect(result.scope).toBe("rollup");
    const kb = await loadKnowledgeBase(store, REPO);
    expect(kb?.lastRollupAt).toBeTruthy();
    expect(kb?.lastIncrementAt).toBeNull();
    expect(kb?.cards.find((c) => c.id === "arch-overview")?.sourceAskIds).toContain(wikiPageAskId("structure"));
  });
});

// ---------------------------------------------------------------------------
// Rollup input compression (pure)
// ---------------------------------------------------------------------------

function fakeWiki(): WikiRecord {
  return {
    repoUrl: "https://github.com/acme/ecc",
    owner: "acme",
    repo: "ecc",
    branch: null,
    generatedAt: "2026-06-07T00:00:00.000Z",
    model: "claude",
    structure: {
      title: "ECC",
      description: "Effortless Code Companion",
      sections: [],
      pages: [
        { id: "p1", title: "Overview", description: "What ECC is", importance: "high", filePaths: [], relatedPages: [] },
        { id: "p2", title: "Install", description: "How to install", importance: "low", filePaths: [], relatedPages: [] },
      ],
    },
    pages: {
      p1: { id: "p1", content: "ECC is a CLI tool.", generatedAt: "2026-06-07T00:00:00.000Z" },
      p2: { id: "p2", content: "Run bun add -g ecc.", generatedAt: "2026-06-07T00:00:00.000Z" },
    },
  };
}

describe("buildRollupMessages", () => {
  test("summary first, then page content high-importance first, with wiki provenance ids", () => {
    const messages = buildRollupMessages(fakeWiki());
    expect(messages[0].askId).toBe(wikiPageAskId("structure"));
    expect(messages[0].content).toContain("ECC");
    // p1 (high) must come before p2 (low)
    const ids = messages.slice(1).map((m) => m.askId);
    expect(ids[0]).toBe(wikiPageAskId("p1"));
    expect(ids).toContain(wikiPageAskId("p2"));
    expect(messages[1].content).toContain("ECC is a CLI tool.");
  });

  test("summariseWikiForRollup includes the page backbone", () => {
    const summary = summariseWikiForRollup(fakeWiki());
    expect(summary).toContain("# ECC");
    expect(summary).toContain("Overview: What ECC is");
  });
});

// ---------------------------------------------------------------------------
// One env-gated LIVE test (opt-in via KB_SPIKE_LIVE=1). Runs the real sourceless
// agent end-to-end through the whole pipeline against the ECC fixture. Never runs
// in CI; raw replies are not captured here (the spike test owns capture).
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.KB_SPIKE_LIVE)("distillToKnowledgeBase (LIVE pipeline)", () => {
  test("increment over the ECC conversation persists real provisional cards", async () => {
    const store = await freshStore();
    const result = await distillToKnowledgeBase({
      store,
      repoKey: REPO,
      repoLabel: "acme/ecc",
      scope: "increment",
      history: eccConversation,
      localCli,
      selfHeal: true,
      // default runner -> the real sourceless agent (claude).
    });
    // 4Q -> 3 cards is the spike's clustering target; the pipeline persists whatever
    // the agent distilled. We assert it ran end-to-end and wrote SOMETHING safely.
    expect(result.distilledCount).toBeGreaterThan(0);
    const kb = await loadKnowledgeBase(store, REPO);
    expect(kb?.cards.length).toBeGreaterThan(0);
    // Nothing should have silently overridden ground truth (there is none seeded here).
    expect(result.resolutions.every((r) => r.outcome !== "applied" || r.classification !== "contradiction")).toBe(true);
  }, 180_000);
});
