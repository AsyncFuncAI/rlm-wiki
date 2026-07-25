/**
 * Phase 1 storage round-trip tests on the real SQLite ProductStore backend
 * (high-fidelity, not a mock - cross-cutting testing strategy section 5).
 *
 * NOTE on scope (plan Open Question 1 decision): `listArtifactVersions` and its
 * `artifact_id` index are scoped to the TS server stores (File/SQLite/Postgres).
 * No Rust desktop schema change was made. The SQLite backend here IS the real
 * desktop backend, so these tests exercise the same code that ships.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProductStore, type ProductStore } from "../persistence.ts";
import {
  CorroboratedCardRewriteError,
  KnowledgeBaseConflictError,
  KNOWLEDGE_BASE_ARTIFACT_KIND,
  type KnowledgeCard,
  emptyKnowledgeBase,
  knowledgeBaseArtifactKey,
  listKnowledgeBaseVersions,
  loadKnowledgeBase,
  mergeSafeAppend,
  saveKnowledgeBase,
} from "./knowledge-base-store.ts";

const tempDirs: string[] = [];

function tempSqlitePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-kb-"));
  tempDirs.push(dir);
  return join(dir, "desktop.sqlite3");
}

async function freshStore(): Promise<ProductStore> {
  process.env.RLM_WIKI_SQLITE_PATH = tempSqlitePath();
  return createProductStore(tempDirs[tempDirs.length - 1], { ownerUserId: "legacy" });
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
  delete process.env.DATABASE_PUBLIC_URL;
});

afterEach(() => {
  delete process.env.RLM_WIKI_SQLITE_PATH;
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("knowledgeBaseArtifactKey", () => {
  test("returns the canonical repo key verbatim, lowercased", () => {
    expect(knowledgeBaseArtifactKey("gh:OpenAI/Codex")).toBe("gh:openai/codex");
    expect(knowledgeBaseArtifactKey("local:/Abs/Path")).toBe("local:/abs/path");
    expect(knowledgeBaseArtifactKey("  gh:a/b  ")).toBe("gh:a/b");
  });
});

describe("KB round-trip on SQLite", () => {
  test("save then load reproduces the cards and metadata", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const kb = emptyKnowledgeBase(repoKey, "owner/repo");
    kb.cards = [card({ id: "c1", title: "Install" }), card({ id: "c2", kind: "concept" })];
    kb.lastIncrementAt = new Date().toISOString();

    const saved = await saveKnowledgeBase(store, kb);
    expect(saved.updatedAt).not.toBe(emptyKnowledgeBase(repoKey, "x").updatedAt);

    const loaded = await loadKnowledgeBase(store, repoKey);
    expect(loaded).not.toBeNull();
    expect(loaded!.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(loaded!.cards[0].title).toBe("Install");
    expect(loaded!.repoKey).toBe(repoKey);
  });

  test("loadKnowledgeBase returns null when none exists", async () => {
    const store = await freshStore();
    expect(await loadKnowledgeBase(store, "gh:nope/none")).toBeNull();
  });

  test("normalizer drops cards with an invalid kind", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    // Write a raw artifact with one bad-kind card directly through the store.
    await store.upsertArtifact({
      kind: KNOWLEDGE_BASE_ARTIFACT_KIND,
      key: knowledgeBaseArtifactKey(repoKey),
      data: {
        schemaVersion: 1,
        repoKey,
        repoLabel: "owner/repo",
        cards: [
          { id: "good", kind: "workflow", title: "ok", body: "", sourceAskIds: [], status: "provisional", corroborationCount: 0, lastUpdated: "", contradictsFlags: [] },
          { id: "bad", kind: "not-a-real-kind", title: "x", body: "", sourceAskIds: [] },
        ],
        lastRollupAt: null,
        lastIncrementAt: null,
        updatedAt: new Date().toISOString(),
      },
    });
    const loaded = await loadKnowledgeBase(store, repoKey);
    expect(loaded!.cards.map((c) => c.id)).toEqual(["good"]);
  });
});

describe("mergeSafeAppend invariant", () => {
  test("appends new cards and replaces existing provisional cards", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    await mergeSafeAppend(store, repoKey, [card({ id: "c1", title: "v1" })], { repoLabel: "owner/repo" });
    await mergeSafeAppend(store, repoKey, [
      card({ id: "c1", title: "v2" }), // replaces provisional c1
      card({ id: "c2", title: "new" }), // appended
    ]);
    const loaded = await loadKnowledgeBase(store, repoKey);
    const byId = new Map(loaded!.cards.map((c) => [c.id, c]));
    expect(byId.get("c1")!.title).toBe("v2");
    expect(byId.get("c2")!.title).toBe("new");
  });

  test("NEVER mutates a corroborated card", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    // Seed a corroborated card via the resolver-only full save.
    const kb = emptyKnowledgeBase(repoKey, "owner/repo");
    kb.cards = [card({ id: "ground", title: "TRUTH", status: "corroborated", corroborationCount: 3 })];
    await saveKnowledgeBase(store, kb);

    // A distill run tries to overwrite the corroborated card AND add a new one.
    await mergeSafeAppend(store, repoKey, [
      card({ id: "ground", title: "HIJACKED", status: "provisional", corroborationCount: 1 }),
      card({ id: "fresh", title: "added" }),
    ]);

    const loaded = await loadKnowledgeBase(store, repoKey);
    const byId = new Map(loaded!.cards.map((c) => [c.id, c]));
    // Ground truth preserved byte-for-byte; the hijack attempt was ignored.
    expect(byId.get("ground")!.title).toBe("TRUTH");
    expect(byId.get("ground")!.status).toBe("corroborated");
    expect(byId.get("ground")!.corroborationCount).toBe(3);
    // The genuinely-new card still landed.
    expect(byId.get("fresh")!.title).toBe("added");
  });

  test("rollup scope sets lastRollupAt; increment scope sets lastIncrementAt", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const inc = await mergeSafeAppend(store, repoKey, [card({ id: "c1" })], { scope: "increment" });
    expect(inc.lastIncrementAt).not.toBeNull();
    expect(inc.lastRollupAt).toBeNull();
    const roll = await mergeSafeAppend(store, repoKey, [card({ id: "c2" })], { scope: "rollup" });
    expect(roll.lastRollupAt).not.toBeNull();
  });
});

describe("saveKnowledgeBase guards", () => {
  test("optimistic-lock rejects a stale save", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const first = await saveKnowledgeBase(store, emptyKnowledgeBase(repoKey, "owner/repo"));
    // A concurrent writer advances the snapshot.
    await saveKnowledgeBase(store, { ...first, cards: [card({ id: "x" })] });
    // The first writer (holding the OLD updatedAt) must now lose.
    await expect(
      saveKnowledgeBase(store, { ...first, cards: [card({ id: "y" })] }, { expectedUpdatedAt: first.updatedAt }),
    ).rejects.toBeInstanceOf(KnowledgeBaseConflictError);
  });

  test("throws when rewriting a corroborated card without the resolver opt", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const kb = emptyKnowledgeBase(repoKey, "owner/repo");
    kb.cards = [card({ id: "g", status: "corroborated", corroborationCount: 2, title: "TRUTH" })];
    const saved = await saveKnowledgeBase(store, kb);
    await expect(
      saveKnowledgeBase(store, { ...saved, cards: [card({ id: "g", status: "corroborated", corroborationCount: 2, title: "CHANGED" })] }),
    ).rejects.toBeInstanceOf(CorroboratedCardRewriteError);
  });

  test("allows rewriting a corroborated card WITH the resolver opt", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const kb = emptyKnowledgeBase(repoKey, "owner/repo");
    kb.cards = [card({ id: "g", status: "corroborated", corroborationCount: 2, title: "TRUTH" })];
    const saved = await saveKnowledgeBase(store, kb);
    const updated = await saveKnowledgeBase(
      store,
      { ...saved, cards: [card({ id: "g", status: "corroborated", corroborationCount: 3, title: "REWRITTEN" })] },
      { allowRewriteCorroborated: true },
    );
    expect(updated.cards[0].title).toBe("REWRITTEN");
  });
});

describe("listArtifactVersions read path", () => {
  test("returns prior snapshots newest-first via the indexed query", async () => {
    const store = await freshStore();
    const repoKey = "gh:owner/repo";
    const kb = emptyKnowledgeBase(repoKey, "owner/repo");
    kb.cards = [card({ id: "c1", title: "v1" })];
    const first = await saveKnowledgeBase(store, kb);
    await saveKnowledgeBase(store, { ...first, cards: [card({ id: "c1", title: "v2" })] });

    const versions = await listKnowledgeBaseVersions(store, repoKey);
    expect(versions.length).toBe(2); // two writes => two auto-versioned rows
    // Newest first: the most recent snapshot holds v2.
    const newest = versions[0].data as any;
    expect(newest.cards[0].title).toBe("v2");
    const oldest = versions[versions.length - 1].data as any;
    expect(oldest.cards[0].title).toBe("v1");
    // All versions belong to the same artifact id.
    expect(new Set(versions.map((v) => v.artifactId)).size).toBe(1);
  });

  test("returns [] for an absent artifact", async () => {
    const store = await freshStore();
    expect(await listKnowledgeBaseVersions(store, "gh:nope/none")).toEqual([]);
  });

  test("scopes versions by owner", async () => {
    process.env.RLM_WIKI_SQLITE_PATH = tempSqlitePath();
    const storeA = await createProductStore(tempDirs[tempDirs.length - 1], { ownerUserId: "user-a" });
    const storeB = await createProductStore(tempDirs[tempDirs.length - 1], { ownerUserId: "user-b" });
    const repoKey = "gh:owner/repo";
    await saveKnowledgeBase(storeA, emptyKnowledgeBase(repoKey, "owner/repo"));
    expect((await listKnowledgeBaseVersions(storeA, repoKey)).length).toBe(1);
    expect(await listKnowledgeBaseVersions(storeB, repoKey)).toEqual([]);
  });
});
