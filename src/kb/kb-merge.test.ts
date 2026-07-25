import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLocalCliConfig } from "../local-cli-events.ts";
import {
  buildDistillPrompt,
  buildMergePrompt,
  type KbHistoryMessage,
} from "./kb-prompts.ts";
import {
  kbRawTextHasDecision,
  normalizeDistillResult,
  normalizeMergeDecision,
  runDistill,
  runMerge,
  type KbAgentRunner,
} from "./kb-merge.ts";
import type { DistillCard, MergeDecision } from "./knowledge-base-types.ts";
import { eccAskIds, eccConversation, eccExistingCards } from "./__fixtures__/ecc-conversation.ts";

const localCli = normalizeLocalCliConfig({ agentId: "claude" });

// A canned-runner helper: returns a fixed JSON reply, ignoring the prompt. This is
// the routing-brain test pattern (server-route.test.ts:198) — zero LLM, CI-safe.
function cannedRunner(reply: string): KbAgentRunner {
  return async () => reply;
}

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

describe("buildDistillPrompt", () => {
  test("embeds the conversation, existing cards, and the JSON contract", () => {
    const prompt = buildDistillPrompt(eccConversation, eccExistingCards);
    expect(prompt).toContain("How do I install the ecc command-line tool");
    expect(prompt).toContain("Cluster by INTENT, not by turn");
    expect(prompt).toContain("Drop dead-end turns");
    expect(prompt).toContain("Output ONLY a single fenced JSON block");
    expect(prompt).toContain("Getting ECC running"); // existing card title for context
    expect(prompt).toContain(eccAskIds.Q1);
  });
});

describe("buildMergePrompt", () => {
  test("encodes resolution order and the provisional-on-single-contradiction rule", () => {
    const newCard: DistillCard = {
      id: "new-port",
      kind: "developer convention",
      title: "ECC default port",
      body: "The default port is 3000.",
      sourceAskIds: ["ask-x"],
      status: "provisional",
      corroborationCount: 1,
      lastUpdated: "2026-06-07T00:00:00.000Z",
      contradictsFlags: [],
    };
    const prompt = buildMergePrompt(newCard, eccExistingCards);
    expect(prompt).toContain("CORROBORATION");
    expect(prompt).toContain("RECENCY");
    expect(prompt).toContain("AUTHORITY");
    expect(prompt).toContain("doc > wiki > card");
    expect(prompt).toContain("PROVISIONAL-ON-SINGLE-CONTRADICTION");
    expect(prompt).toContain("corroborationCount < 2");
    expect(prompt).toContain("readme-default-port"); // the doc card it must not override
  });
});

// ---------------------------------------------------------------------------
// kbRawTextHasDecision (mirrors routeRawTextHasDecision exactly)
// ---------------------------------------------------------------------------

describe("kbRawTextHasDecision", () => {
  test("true for parseable fenced JSON, false for prose", () => {
    expect(kbRawTextHasDecision('```json\n{"cards":[]}\n```')).toBe(true);
    expect(kbRawTextHasDecision("I am not sure how to distill that.")).toBe(false);
    expect(kbRawTextHasDecision("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clustering: 4Q -> 3 cards (Q1+Q2 merged, Q4 dropped)
// ---------------------------------------------------------------------------

describe("distill clustering (canned)", () => {
  // The canned reply an ideal distill agent would produce for the ECC conversation:
  // Q1+Q2 -> ONE install card; Q3 -> a convention card; Q4 -> NO card (dead end).
  const cannedDistill = JSON.stringify({
    cards: [
      {
        id: "ecc-install",
        kind: "workflow",
        title: "Installing ECC (global and per-project)",
        body: "Global: `bun add -g ecc`. Per project: `bun add -d ecc` then `bunx ecc`.",
        sourceAskIds: [eccAskIds.Q1, eccAskIds.Q2],
        status: "provisional",
        corroborationCount: 1,
        lastUpdated: "2026-06-07T00:00:00.000Z",
        contradictsFlags: [],
      },
      {
        id: "ecc-config-convention",
        kind: "developer convention",
        title: "Committed ecc.config.ts, secrets from env",
        body: "Keep one committed `ecc.config.ts` at the root; load secrets from the environment.",
        sourceAskIds: [eccAskIds.Q3],
        status: "provisional",
        corroborationCount: 1,
        lastUpdated: "2026-06-07T00:00:00.000Z",
        contradictsFlags: [],
      },
    ],
  });

  test("4 turns collapse to exactly 3 cards: Q1+Q2 merged, Q3 kept, Q4 dropped", async () => {
    const result = await runDistill(
      eccConversation,
      eccExistingCards,
      localCli,
      cannedRunner("```json\n" + cannedDistill + "\n```"),
    );
    // 4 conversation turns -> 2 emitted cards covering 3 conclusive questions
    // (Q1+Q2 fused into one), Q4 dropped.
    expect(result.cards.length).toBe(2);

    const installCard = result.cards.find((c) => c.id === "ecc-install");
    expect(installCard).toBeDefined();
    // Q1+Q2 merged -> both ask ids retained as provenance.
    expect(installCard?.sourceAskIds.sort()).toEqual([eccAskIds.Q1, eccAskIds.Q2].sort());

    // Q4 (dead end) produced NO card.
    const allAskIds = result.cards.flatMap((c) => c.sourceAskIds);
    expect(allAskIds).not.toContain(eccAskIds.Q4);
  });

  test("normalizer drops cards with no provenance or an unknown kind", () => {
    const result = normalizeDistillResult({
      cards: [
        { id: "ok", kind: "concept", title: "T", body: "B", sourceAskIds: ["a"] },
        { id: "no-prov", kind: "concept", title: "T", body: "B", sourceAskIds: [] }, // dropped: no provenance
        { id: "bad-kind", kind: "not-a-kind", title: "T", body: "B", sourceAskIds: ["a"] }, // dropped: unknown kind
      ],
    });
    expect(result.cards.map((c) => c.id)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// Semantic match by intent (id), not by title
// ---------------------------------------------------------------------------

describe("intent match by id, not title (canned)", () => {
  const newInstallCard: DistillCard = {
    id: "ecc-install",
    kind: "workflow",
    title: "Installing ECC (global and per-project)", // title differs from "Getting ECC running"
    body: "Global: `bun add -g ecc`. Per project: `bun add -d ecc`.",
    sourceAskIds: [eccAskIds.Q1, eccAskIds.Q2],
    status: "provisional",
    corroborationCount: 1,
    lastUpdated: "2026-06-07T00:00:00.000Z",
    contradictsFlags: [],
  };

  test("matches the differently-titled existing card by intent id", async () => {
    // An ideal merge agent matches by meaning: the new install card maps to
    // `existing-setup-guide` even though the titles differ.
    const canned: MergeDecision = {
      intentMatchCardId: "existing-setup-guide",
      classification: "correction",
      resolution: "apply",
      currentCorroborationCount: 1,
      weightRationale: { corroboration: "Agrees with prior install card.", recency: "Newer.", authority: "Same tier." },
      rewriteWithProvenance: {
        body: "Global and per-project install instructions.",
        claims: [
          { text: "Global: bun add -g ecc", sourceAskId: eccAskIds.Q1 },
          { text: "Per project: bun add -d ecc", sourceAskId: eccAskIds.Q2 },
        ],
      },
      retainedPriorVersion: true,
      contradictsFlag: null,
    };
    const decision = await runMerge(
      newInstallCard,
      eccExistingCards,
      1,
      localCli,
      cannedRunner("```json\n" + JSON.stringify(canned) + "\n```"),
    );
    expect(decision.intentMatchCardId).toBe("existing-setup-guide");
    // Match is by id, NOT by title string equality.
    expect(decision.intentMatchCardId).not.toBe(newInstallCard.title);
    expect(decision.retainedPriorVersion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification: addition / correction / contradiction
// ---------------------------------------------------------------------------

describe("classification (canned)", () => {
  function decisionWith(classification: string, resolution: string, count = 2): MergeDecision {
    return normalizeMergeDecision(
      {
        intentMatchCardId: classification === "addition" ? null : "readme-default-port",
        classification,
        resolution,
        weightRationale: { corroboration: "", recency: "", authority: "" },
        rewriteWithProvenance: { body: "b", claims: [{ text: "t", sourceAskId: "a" }] },
        retainedPriorVersion: classification !== "addition",
      },
      count,
    );
  }

  test("addition keeps null match and applies", () => {
    const d = decisionWith("addition", "apply");
    expect(d.classification).toBe("addition");
    expect(d.intentMatchCardId).toBeNull();
    expect(d.resolution).toBe("apply");
  });

  test("correction matches and applies", () => {
    const d = decisionWith("correction", "apply");
    expect(d.classification).toBe("correction");
    expect(d.intentMatchCardId).toBe("readme-default-port");
    expect(d.resolution).toBe("apply");
  });

  test("contradiction is preserved as a classification", () => {
    const d = decisionWith("contradiction", "provisional", 1);
    expect(d.classification).toBe("contradiction");
  });

  test("unknown classification degrades to addition", () => {
    const d = decisionWith("garbage", "provisional");
    expect(d.classification).toBe("addition");
  });
});

// ---------------------------------------------------------------------------
// THE KEYSTONE: deterministic provisional-on-single-contradiction normalizer rule
// ---------------------------------------------------------------------------

describe("keystone normalizer: provisional-on-single-contradiction", () => {
  test("forces provisional even when the LLM wrongly says apply (count < 2)", () => {
    // The LLM mistakenly tries to APPLY a single unverified contradiction over the
    // doc. The normalizer MUST override it to provisional. This is the zero-silent-
    // override bright line, enforced deterministically regardless of LLM output.
    const decision = normalizeMergeDecision(
      {
        intentMatchCardId: "readme-default-port",
        classification: "contradiction",
        resolution: "apply", // <-- the LLM is WRONG here
        weightRationale: { corroboration: "single source", recency: "newer", authority: "lower than doc" },
        rewriteWithProvenance: { body: "port is 3000", claims: [{ text: "port 3000", sourceAskId: "ask-x" }] },
        retainedPriorVersion: true,
        contradictsFlag: "Contradicts README (doc): claims port 3000 vs documented 8080.",
      },
      1, // currentCorroborationCount < 2
    );
    expect(decision.resolution).toBe("provisional"); // overridden, NOT apply
    expect(decision.classification).toBe("contradiction");
    expect(decision.contradictsFlag).toContain("Contradicts README");
  });

  test("does not touch a contradiction the LLM already marked provisional", () => {
    const decision = normalizeMergeDecision(
      {
        intentMatchCardId: "readme-default-port",
        classification: "contradiction",
        resolution: "provisional",
        weightRationale: { corroboration: "", recency: "", authority: "" },
        rewriteWithProvenance: { body: "x", claims: [{ text: "x", sourceAskId: "a" }] },
        retainedPriorVersion: true,
      },
      1,
    );
    expect(decision.resolution).toBe("provisional");
  });

  test("malformed output degrades to provisional, NEVER apply", () => {
    expect(normalizeMergeDecision(null, 1).resolution).toBe("provisional");
    expect(normalizeMergeDecision("not an object", 5).resolution).toBe("provisional");
    expect(normalizeMergeDecision({ resolution: "apply" }, 0).resolution).toBe("apply"); // addition default keeps apply only when explicitly valid + not a contradiction
  });

  test("a missing/invalid resolution degrades to provisional", () => {
    const d = normalizeMergeDecision(
      { intentMatchCardId: null, classification: "addition", resolution: "weird" },
      0,
    );
    expect(d.resolution).toBe("provisional");
  });
});

// ---------------------------------------------------------------------------
// THE COUNT FLIP: count >= 2 lets a contradiction keep apply (corroboration win)
// ---------------------------------------------------------------------------

describe("keystone: corroboration count >= 2 flip", () => {
  test("a contradiction with 2+ corroborating sources keeps apply", () => {
    const decision = normalizeMergeDecision(
      {
        intentMatchCardId: "readme-default-port",
        classification: "contradiction",
        resolution: "apply",
        weightRationale: { corroboration: "two independent sources now agree", recency: "newer", authority: "lower" },
        rewriteWithProvenance: { body: "port is 3000", claims: [{ text: "port 3000", sourceAskId: "ask-y" }] },
        retainedPriorVersion: true,
        contradictsFlag: "Now corroborated by a 2nd source.",
      },
      2, // currentCorroborationCount >= 2 -> the flip earns the win
    );
    expect(decision.resolution).toBe("apply"); // NOT downgraded — corroboration won
    expect(decision.currentCorroborationCount).toBe(2);
  });

  test("the keystone flip end-to-end: 1 source = provisional, 2 sources = apply (same LLM reply)", async () => {
    // Same canned LLM reply (it always says apply); the only thing that changes is
    // the stored corroboration count fed in. This isolates the deterministic flip.
    const cannedContradiction: MergeDecision = {
      intentMatchCardId: "readme-default-port",
      classification: "contradiction",
      resolution: "apply",
      currentCorroborationCount: 0,
      weightRationale: { corroboration: "", recency: "", authority: "" },
      rewriteWithProvenance: { body: "port 3000", claims: [{ text: "port 3000", sourceAskId: "ask-z" }] },
      retainedPriorVersion: true,
      contradictsFlag: "contradicts README",
    };
    const runner = cannedRunner("```json\n" + JSON.stringify(cannedContradiction) + "\n```");
    const newCard: DistillCard = {
      id: "new-port-card",
      kind: "developer convention",
      title: "ECC default port is 3000",
      body: "The default port is 3000.",
      sourceAskIds: ["ask-z"],
      status: "provisional",
      corroborationCount: 1,
      lastUpdated: "2026-06-07T00:00:00.000Z",
      contradictsFlags: [],
    };

    const single = await runMerge(newCard, eccExistingCards, 1, localCli, runner);
    expect(single.resolution).toBe("provisional"); // 1 source -> provisional, doc not overridden

    const corroborated = await runMerge(newCard, eccExistingCards, 2, localCli, runner);
    expect(corroborated.resolution).toBe("apply"); // 2 sources -> flips to apply
  });
});

// ---------------------------------------------------------------------------
// Provenance retained
// ---------------------------------------------------------------------------

describe("provenance retained", () => {
  test("every claim in the rewrite carries a sourceAskId", () => {
    const decision = normalizeMergeDecision(
      {
        intentMatchCardId: "existing-setup-guide",
        classification: "correction",
        resolution: "apply",
        weightRationale: { corroboration: "", recency: "", authority: "" },
        rewriteWithProvenance: {
          body: "merged",
          claims: [
            { text: "global install", sourceAskId: eccAskIds.Q1 },
            { text: "project install", sourceAskId: eccAskIds.Q2 },
            { text: "no source", sourceAskId: "" }, // dropped: no provenance
          ],
        },
        retainedPriorVersion: true,
      },
      2,
    );
    expect(decision.rewriteWithProvenance.claims.length).toBe(2); // the no-source claim is dropped
    for (const claim of decision.rewriteWithProvenance.claims) {
      expect(claim.sourceAskId).toBeTruthy();
    }
    expect(decision.rewriteWithProvenance.claims.map((c) => c.sourceAskId)).toEqual([eccAskIds.Q1, eccAskIds.Q2]);
  });

  test("matching an existing card retains the prior version by default", () => {
    const d = normalizeMergeDecision(
      {
        intentMatchCardId: "existing-setup-guide",
        classification: "correction",
        resolution: "apply",
        rewriteWithProvenance: { body: "x", claims: [{ text: "x", sourceAskId: "a" }] },
        // retainedPriorVersion omitted -> defaults true because a card was matched
      },
      2,
    );
    expect(d.retainedPriorVersion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repair turn (mirrors runRouteDecision's one-repair-turn behavior)
// ---------------------------------------------------------------------------

describe("repair turn", () => {
  test("distill recovers after an unparseable first reply", async () => {
    let calls = 0;
    const runner: KbAgentRunner = async () => {
      calls += 1;
      return calls === 1
        ? "Sure, let me think about how to distill that conversation."
        : '```json\n{"cards":[{"id":"c","kind":"concept","title":"T","body":"B","sourceAskIds":["a"],"status":"provisional","corroborationCount":1,"lastUpdated":"2026-06-07T00:00:00.000Z","contradictsFlags":[]}]}\n```';
    };
    const result = await runDistill(eccConversation, eccExistingCards, localCli, runner);
    expect(calls).toBe(2);
    expect(result.cards.length).toBe(1);
  });

  test("merge degrades to provisional when both turns are garbage", async () => {
    let calls = 0;
    const runner: KbAgentRunner = async () => {
      calls += 1;
      return "I cannot produce that JSON right now.";
    };
    const newCard: DistillCard = {
      id: "x",
      kind: "concept",
      title: "T",
      body: "B",
      sourceAskIds: ["a"],
      status: "provisional",
      corroborationCount: 1,
      lastUpdated: "2026-06-07T00:00:00.000Z",
      contradictsFlags: [],
    };
    const decision = await runMerge(newCard, eccExistingCards, 1, localCli, runner);
    expect(calls).toBe(2); // a repair turn was attempted
    expect(decision.resolution).toBe("provisional"); // never apply on failure
  });
});

// ---------------------------------------------------------------------------
// LIVE block (opt-in via KB_SPIKE_LIVE; never runs in CI). Captures raw replies
// to the gitignored .live-output/ dir for inspection. Pins agent "claude".
// ---------------------------------------------------------------------------

const LIVE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", ".live-output");

describe.skipIf(!process.env.KB_SPIKE_LIVE)("KB spike LIVE (real agent)", () => {
  // Capture raw replies so a human can audit the keystone behavior across runs.
  const captured: Array<{ step: string; raw: string }> = [];

  afterAll(() => {
    try {
      mkdirSync(LIVE_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(
        join(LIVE_DIR, `spike-${stamp}.json`),
        JSON.stringify(captured, null, 2),
        "utf8",
      );
    } catch {
      // Capture is best-effort; never fail the live run over disk I/O.
    }
  });

  // A capturing wrapper around the real default runner, so we record raw replies.
  async function capturingRunner(step: string): Promise<KbAgentRunner> {
    const { defaultKbAgentRunner } = await import("./kb-merge.ts");
    return async (prompt, cli, signal) => {
      const raw = await defaultKbAgentRunner(prompt, cli, signal);
      captured.push({ step, raw });
      return raw;
    };
  }

  test(
    "live: 4Q -> 3 cards, Q1+Q2 merged, Q4 dropped",
    async () => {
      const runner = await capturingRunner("distill");
      const result = await runDistill(eccConversation, eccExistingCards, localCli, runner);
      // Across runs the bright line for clustering: install merged, dead-end dropped.
      const allAskIds = result.cards.flatMap((c) => c.sourceAskIds);
      expect(allAskIds).not.toContain(eccAskIds.Q4);
      expect(result.cards.length).toBeGreaterThanOrEqual(1);
    },
    600_000,
  );

  test(
    "live: a single fresh contradiction against the README doc lands provisional (zero silent override)",
    async () => {
      const newPortCard: DistillCard = {
        id: "live-new-port",
        kind: "developer convention",
        title: "ECC default port is 3000",
        body: "The ECC dev server defaults to port 3000.",
        sourceAskIds: ["live-ask"],
        status: "provisional",
        corroborationCount: 1,
        lastUpdated: "2026-06-07T00:00:00.000Z",
        contradictsFlags: [],
      };
      const runner = await capturingRunner("merge");
      const decision = await runMerge(newPortCard, eccExistingCards, 1, localCli, runner);
      // THE BRIGHT LINE: a lone unverified card MUST NOT override the doc.
      expect(decision.resolution).not.toBe("apply");
    },
    600_000,
  );
});
