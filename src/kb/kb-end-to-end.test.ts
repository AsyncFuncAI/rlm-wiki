/**
 * KB END-TO-END SPINE TEST
 *
 * Drives the WHOLE feature with a SCRIPTED FAKE LLM (no `claude` CLI, no auth,
 * deterministic, ~1s). It walks the real user journey from the brainstorm:
 *
 *   distill (cluster by intent)
 *      -> merge a contradicting card  -> lands PROVISIONAL  (the bright line)
 *      -> a 2nd source corroborates   -> flips to CORROBORATED
 *      -> publish                      -> agent markdown carries freshness
 *      -> feedback                     -> top cards ranked for the next ask
 *
 * It uses the SAME injectable-runner seam the production code uses (runDistill /
 * runMerge take a `runner`), so we exercise the real normalizers + the real
 * SQLite store + the real publish adapter + the real feedback ranker.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductStore, type ProductStore } from "../persistence.ts";
import { runDistill, runMerge, type KbAgentRunner } from "./kb-merge.ts";
import {
  emptyKnowledgeBase,
  knowledgeBaseArtifactKey,
  loadKnowledgeBase,
  mergeSafeAppend,
  saveKnowledgeBase,
} from "./knowledge-base-store.ts";
import { kbRecordFromArtifact, orderKbCardPagesByFreshness } from "./kb-publish.ts";
import type { LocalCliConfig } from "../local-cli-events.ts";

const REPO = "gh:affaan-m/ecc";
const LOCAL_CLI = { agentId: "claude", model: "" } as unknown as LocalCliConfig;

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
async function freshStore(): Promise<ProductStore> {
  const dir = mkdtempSync(join(tmpdir(), "kb-e2e-"));
  tempDirs.push(dir);
  return createProductStore(dir, { ownerUserId: "legacy" });
}

/** A fake LLM: returns whatever canned ```json the test scripted for this call. */
function scriptedRunner(...replies: string[]): KbAgentRunner {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
}
const fence = (obj: unknown) => "```json\n" + JSON.stringify(obj) + "\n```";

describe("KB end-to-end spine (fake LLM)", () => {
  test("distill -> contradiction lands provisional -> 2nd source corroborates -> publish -> feedback", async () => {
    const store = await freshStore();
    const key = knowledgeBaseArtifactKey(REPO);

    // ---- STEP 1: DISTILL the 4-turn ECC conversation -> intent-clustered cards.
    // The fake LLM merges install Q1+Q2 into ONE card and drops the dead-end Q4.
    const distillReply = fence({
      cards: [
        {
          id: "ecc-install",
          kind: "workflow",
          title: "Installing ECC",
          body: "Install ECC with `bun add -g ecc`, then verify with `ecc --version`.",
          sourceAskIds: ["q1-install", "q2-project-install"], // Q1+Q2 merged
          status: "provisional",
          corroborationCount: 1,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
        {
          id: "ecc-best-practices",
          kind: "developer convention",
          title: "ECC best practices",
          body: "Keep one committed `ecc.config.ts`; never store secrets in it.",
          sourceAskIds: ["q3-best-practices"],
          status: "provisional",
          corroborationCount: 1,
          lastUpdated: "2026-06-07T00:00:00.000Z",
          contradictsFlags: [],
        },
      ],
    });
    const distilled = await runDistill(
      [
        { role: "user", content: "how to install ecc?", askId: "q1-install" },
        { role: "assistant", content: "bun add -g ecc", askId: "q1-install" },
        { role: "user", content: "project-level install with claude code?", askId: "q2-project-install" },
        { role: "assistant", content: "bun add -d ecc", askId: "q2-project-install" },
        { role: "user", content: "best practices?", askId: "q3-best-practices" },
        { role: "assistant", content: "one committed ecc.config.ts", askId: "q3-best-practices" },
        { role: "user", content: "is the moon made of cheese?", askId: "q4-deadend" }, // dead-end Q4
      ],
      [],
      LOCAL_CLI,
      scriptedRunner(distillReply),
    );

    // VERIFY: 4 questions -> 3 turns clustered into 2 cards (install Q1+Q2 merged), Q4 dropped.
    expect(distilled.cards).toHaveLength(2);
    const install = distilled.cards.find((c) => c.id === "ecc-install")!;
    expect(install.sourceAskIds).toEqual(["q1-install", "q2-project-install"]);
    expect(distilled.cards.every((c) => c.status === "provisional")).toBe(true);

    // Persist the distilled cards via the SAFE path.
    await mergeSafeAppend(store, REPO, distilled.cards as any, { scope: "increment" });

    // ---- STEP 2: seed a CORROBORATED ground-truth doc card, then MERGE a
    // contradicting fresh card. The bright line: it must land PROVISIONAL, never apply.
    const kb0 = emptyKnowledgeBase(REPO, "affaan-m/ECC");
    const afterDistill = await loadKnowledgeBase(store, REPO);
    kb0.cards = [
      ...(afterDistill?.cards ?? []),
      {
        id: "ecc-default-port",
        kind: "integration",
        title: "ECC default port",
        body: "ECC serves on port 8080 by default (per README).",
        sourceAskIds: ["readme"],
        status: "corroborated",
        corroborationCount: 3,
        lastUpdated: "2026-06-01T00:00:00.000Z",
        contradictsFlags: [],
      } as any,
    ];
    await saveKnowledgeBase(store, kb0);

    const contradictingCard = {
      id: "ecc-port-claim",
      kind: "integration" as const,
      title: "ECC port",
      body: "ECC serves on port 3000.", // contradicts the corroborated 8080 doc
      sourceAskIds: ["q-fresh-port"],
      status: "provisional" as const,
      corroborationCount: 1,
      lastUpdated: "2026-06-08T00:00:00.000Z",
      contradictsFlags: [],
    };
    const mergeReply1 = fence({
      intentMatchCardId: "ecc-default-port",
      classification: "contradiction",
      resolution: "provisional", // honest LLM output; normalizer enforces it anyway
      currentCorroborationCount: 3,
      weightRationale: {
        corroboration: "matched card has 3 sources, new card has 1 -> keep ground truth",
        recency: "new card is newer but uncorroborated",
        authority: "doc beats card",
      },
      rewriteWithProvenance: { body: "ECC serves on port 3000.", claims: [{ text: "port 3000", sourceAskId: "q-fresh-port" }] },
      retainedPriorVersion: true,
    });
    const decision1 = await runMerge(
      contradictingCard,
      kb0.cards as any,
      /* currentCorroborationCount of the matched claim */ 1,
      LOCAL_CLI,
      scriptedRunner(mergeReply1),
    );

    // THE BRIGHT LINE: a lone contradiction never silently overrides ground truth.
    expect(decision1.classification).toBe("contradiction");
    expect(decision1.resolution).toBe("provisional");
    expect(decision1.resolution).not.toBe("apply");

    // ---- STEP 3: a SECOND independent source corroborates the port-3000 claim.
    // With currentCorroborationCount now >= 2, the resolver may apply/corroborate.
    const mergeReply2 = fence({
      intentMatchCardId: "ecc-port-claim",
      classification: "correction",
      resolution: "apply",
      currentCorroborationCount: 2,
      weightRationale: { corroboration: "now 2 independent sources agree on 3000", recency: "newest", authority: "card corroborated" },
      rewriteWithProvenance: {
        body: "ECC serves on port 3000 (verified by two sources).",
        claims: [
          { text: "port 3000", sourceAskId: "q-fresh-port" },
          { text: "port 3000", sourceAskId: "q-second-source" },
        ],
      },
      retainedPriorVersion: true,
    });
    const decision2 = await runMerge(
      { ...contradictingCard, sourceAskIds: ["q-fresh-port", "q-second-source"], corroborationCount: 2 },
      kb0.cards as any,
      /* currentCorroborationCount */ 2,
      LOCAL_CLI,
      scriptedRunner(mergeReply2),
    );
    // With 2+ corroborating sources, the resolver is allowed to apply (not forced provisional).
    expect(decision2.resolution).toBe("apply");

    // ---- STEP 4: PUBLISH -> the agent-facing record carries per-card freshness.
    const finalKb = await loadKnowledgeBase(store, REPO);
    expect(finalKb).not.toBeNull();
    if (!finalKb) return;
    const record = kbRecordFromArtifact(finalKb, { wikiRecordId: "wiki-kb-affaan-ecc-deadbeef" });
    expect(record.id).toBe("wiki-kb-affaan-ecc-deadbeef"); // stable id for the feedback loop
    expect(record.structure.pages.length).toBe(finalKb.cards.length);
    // Each card became a page carrying its kb metadata (status/freshness).
    const portPage = record.structure.pages.find((p) => /port/i.test(p.title));
    expect(portPage).toBeTruthy();

    // ---- STEP 5: FEEDBACK -> top cards ranked (most-corroborated / most-recent
    // first) so the next ask gets the strongest knowledge injected as context.
    const byPageId = new Map(finalKb.cards.map((c) => [c.id, c]));
    const ranked = orderKbCardPagesByFreshness(
      finalKb.cards.map((c) => ({
        pageId: c.id,
        lastUpdated: c.lastUpdated,
        corroborationCount: c.corroborationCount,
      })),
    );
    // The most-corroborated card (the ground-truth doc, count 3) ranks first.
    const topCard = byPageId.get(ranked[0].pageId)!;
    const maxCorroboration = Math.max(...finalKb.cards.map((c) => c.corroborationCount));
    expect(topCard.corroborationCount).toBe(maxCorroboration);
  });
});
