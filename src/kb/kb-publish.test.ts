/**
 * Phase 3 golden tests: KB -> WikiRecord adapter + per-card freshness rendering.
 *
 * Asserts (the plan's Phase 3 exit gate):
 *  - kbRecordFromArtifact supplies ALL required WikiRecordSchema fields and parses.
 *  - the WikiRecord id is STABLE: reused from kb.wikiRecordId / the wikiRecordId opt.
 *  - page.kb freshness metadata survives sanitizePublicWikiRecord (the sanitizer
 *    hardcodes {id,content,generatedAt}; the passthrough is the review fix).
 *  - the markdown builders (llms-full.txt / per-page .md / index) render the
 *    per-card status, corroboration count, and a loud contradiction banner.
 *  - llms-full.txt stays self-contained (full card body inline).
 */

import { describe, expect, test } from "bun:test";
import { WikiRecordSchema } from "../types.ts";
import { createPublicWikiSnapshot } from "../public-wiki.ts";
import {
  kbCardPageId,
  kbRecordFromArtifact,
  kbSyntheticRepoIdentity,
  orderKbCardPagesByFreshness,
} from "./kb-publish.ts";
import type { KnowledgeBaseData, KnowledgeCard } from "./knowledge-base-store.ts";
import { KB_BUILD_BRANCH } from "./knowledge-base-types.ts";
// The markdown builders are plain JS shared by the public site + the desktop server.
import {
  publicWikiMarkdownFull,
  publicWikiMarkdownIndex,
  publicWikiMarkdownPage,
} from "../../api/public/wiki/_shared.js";

function card(overrides: Partial<KnowledgeCard> & { id: string }): KnowledgeCard {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "workflow",
    title: overrides.title ?? "Card",
    body: overrides.body ?? "Card body.",
    sourceAskIds: overrides.sourceAskIds ?? ["ask-1"],
    status: overrides.status ?? "provisional",
    corroborationCount: overrides.corroborationCount ?? 1,
    lastUpdated: overrides.lastUpdated ?? "2026-06-01T00:00:00.000Z",
    contradictsFlags: overrides.contradictsFlags ?? [],
    topicTags: overrides.topicTags ?? [],
    repoRefs: overrides.repoRefs ?? [],
    ...(overrides.priorVersion ? { priorVersion: overrides.priorVersion } : {}),
  };
}

function sampleKb(repoKey: string): KnowledgeBaseData {
  return {
    schemaVersion: 1,
    repoKey,
    repoLabel: "owner/repo",
    cards: [
      card({
        id: "card-install",
        kind: "workflow",
        title: "Install workflow",
        body: "Run the installer with the documented flags.",
        status: "corroborated",
        corroborationCount: 3,
        sourceAskIds: ["ask-1", "ask-2"],
        topicTags: ["install", "setup"],
        lastUpdated: "2026-06-02T00:00:00.000Z",
      }),
      card({
        id: "card-port",
        kind: "integration",
        title: "Local dev port",
        body: "The dev server binds to port 5173 by default.",
        status: "provisional",
        corroborationCount: 1,
        contradictsFlags: ["README says port 3000"],
        sourceAskIds: ["ask-9"],
        lastUpdated: "2026-06-03T00:00:00.000Z",
      }),
    ],
    lastRollupAt: "2026-06-03T00:00:00.000Z",
    lastIncrementAt: null,
    updatedAt: "2026-06-03T01:00:00.000Z",
  };
}

describe("kbRecordFromArtifact adapter", () => {
  test("supplies all required WikiRecordSchema fields and parses", () => {
    const record = kbRecordFromArtifact(sampleKb("gh:owner/repo"));
    // Parse against the real schema - throws if a required field is missing.
    const parsed = WikiRecordSchema.parse(record);
    expect(parsed.repoUrl).toBe("https://github.com/owner/repo");
    expect(parsed.owner).toBe("owner");
    expect(parsed.repo).toBe("repo");
    expect(parsed.model).toBeTruthy();
    expect(parsed.generatedAt).toBeTruthy();
    expect(parsed.structure.title).toContain("Knowledge Base");
    expect(parsed.structure.pages.length).toBe(2);
    expect(Object.keys(parsed.pages).length).toBe(2);
  });

  test("preserves a stable WikiRecord id across calls", () => {
    const kb = sampleKb("gh:owner/repo");
    const first = kbRecordFromArtifact(kb);
    expect(first.id).toBeTruthy();
    // Reuse via the stored field.
    const withStored = kbRecordFromArtifact({ ...kb, wikiRecordId: first.id });
    expect(withStored.id).toBe(first.id);
    // Reuse via the explicit opt.
    const withOpt = kbRecordFromArtifact(kb, { wikiRecordId: "wiki-kb-fixed-1234" });
    expect(withOpt.id).toBe("wiki-kb-fixed-1234");
  });

  test("disambiguates two local repos sharing a directory name", () => {
    const a = kbSyntheticRepoIdentity("local:/Users/a/myapp");
    const b = kbSyntheticRepoIdentity("local:/Users/b/myapp");
    expect(a.repo).not.toBe(b.repo);
    expect(a.owner).toBe("local");
    expect(a.repoUrl).toBe(""); // no bogus GitHub URL for a local KB
  });

  test("attaches kb freshness metadata to each card page", () => {
    const record = kbRecordFromArtifact(sampleKb("gh:owner/repo"));
    const installPageId = kbCardPageId({ ...card({ id: "card-install" }) });
    const kbMeta = record.pages[installPageId]?.kb;
    expect(kbMeta?.status).toBe("corroborated");
    expect(kbMeta?.corroborationCount).toBe(3);
    expect(kbMeta?.topicTags).toContain("install");
  });
});

describe("kb page metadata survives sanitization", () => {
  test("sanitizePublicWikiRecord copies page.kb through", () => {
    const record = kbRecordFromArtifact(sampleKb("gh:owner/repo"));
    const snapshot = createPublicWikiSnapshot({
      publicId: "owner-repo-abc12345",
      record,
      visibility: "public",
    });
    const portPageId = kbCardPageId(card({ id: "card-port" }));
    const sanitizedKb = snapshot.wiki.pages[portPageId]?.kb;
    expect(sanitizedKb).toBeTruthy();
    expect(sanitizedKb?.status).toBe("provisional");
    expect(sanitizedKb?.contradicts).toContain("README says port 3000");
  });
});

describe("freshness metadata renders in published markdown", () => {
  const record = kbRecordFromArtifact(sampleKb("gh:owner/repo"));
  const snapshot = createPublicWikiSnapshot({
    publicId: "owner-repo-abc12345",
    record,
    visibility: "public",
  });

  test("llms-full.txt renders per-card status + corroboration + contradiction banner, self-contained", () => {
    const full = publicWikiMarkdownFull(snapshot, "https://rlmwiki.deepascii.com");
    // Per-card status block.
    expect(full).toContain("### Card status");
    expect(full).toContain("Status: Corroborated");
    expect(full).toContain("Status: Provisional");
    // Corroboration detail is on (full-self-heal branch).
    expect(full).toContain("Corroborating sources: 3");
    expect(full).toContain("Contradicts: README says port 3000");
    // Loud contradiction banner so an agent never silently trusts a flagged card.
    expect(full).toContain("Warning: this card disagrees with a higher-authority source");
    // Self-contained: the full card body is inline, not just a link.
    expect(full).toContain("Run the installer with the documented flags.");
    expect(full).toContain("The dev server binds to port 5173 by default.");
  });

  test("per-page .md renders the card's own freshness block", () => {
    const installPageId = kbCardPageId(card({ id: "card-install" }));
    const installPage = publicWikiMarkdownPage(snapshot, "https://rlmwiki.deepascii.com", installPageId);
    expect(installPage).toContain("### Card status");
    expect(installPage).toContain("Status: Corroborated");
    expect(installPage).toContain("Run the installer with the documented flags.");
  });

  test("index surfaces per-card status inline", () => {
    const index = publicWikiMarkdownIndex(snapshot, "https://rlmwiki.deepascii.com");
    expect(index).toContain("[corroborated]");
    expect(index).toContain("[provisional, contradiction flagged]");
  });

  test("build branch is the Phase 0 outcome (full-self-heal) so detail renders", () => {
    // Guards the 3b gate: a branch flip to manual-authoring must drop the detail.
    expect(KB_BUILD_BRANCH).toBe("full-self-heal");
  });
});

describe("orderKbCardPagesByFreshness (Phase 4 top-N selection)", () => {
  test("ranks by corroboration desc, then recency desc, with a stable tiebreak", () => {
    const ordered = orderKbCardPagesByFreshness([
      { pageId: "low-old", corroborationCount: 0, lastUpdated: "2026-01-01T00:00:00.000Z" },
      { pageId: "high", corroborationCount: 3, lastUpdated: "2026-02-01T00:00:00.000Z" },
      { pageId: "low-new", corroborationCount: 0, lastUpdated: "2026-06-01T00:00:00.000Z" },
      { pageId: "mid", corroborationCount: 1, lastUpdated: "2026-03-01T00:00:00.000Z" },
    ]);
    // Highest corroboration wins outright; among equal corroboration, newer first.
    expect(ordered.map((p) => p.pageId)).toEqual(["high", "mid", "low-new", "low-old"]);
  });

  test("keeps the original order for equal corroboration AND equal recency (stable)", () => {
    const ordered = orderKbCardPagesByFreshness([
      { pageId: "a", corroborationCount: 1, lastUpdated: "2026-06-01T00:00:00.000Z" },
      { pageId: "b", corroborationCount: 1, lastUpdated: "2026-06-01T00:00:00.000Z" },
      { pageId: "c", corroborationCount: 1, lastUpdated: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(ordered.map((p) => p.pageId)).toEqual(["a", "b", "c"]);
  });

  test("tolerates missing / null freshness fields (treated as 0 / no date)", () => {
    const ordered = orderKbCardPagesByFreshness([
      { pageId: "none" },
      { pageId: "some", corroborationCount: 2, lastUpdated: "2026-06-01T00:00:00.000Z" },
    ]);
    expect(ordered.map((p) => p.pageId)).toEqual(["some", "none"]);
  });

  test("does not mutate the input array", () => {
    const input = [
      { pageId: "x", corroborationCount: 0 },
      { pageId: "y", corroborationCount: 5 },
    ];
    const snapshot = input.map((p) => p.pageId);
    orderKbCardPagesByFreshness(input);
    expect(input.map((p) => p.pageId)).toEqual(snapshot);
  });
});
