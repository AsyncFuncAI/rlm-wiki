import { describe, expect, test } from "bun:test";
import { ensureWikiRecordIdentity, wikiSourceKey, wikiVariantKey } from "./wiki-identity.ts";
import type { WikiRecord } from "./types.ts";

const ref = {
  owner: "xai-org",
  repo: "x-algorithm",
  url: "https://github.com/xai-org/x-algorithm",
  branch: null,
};

describe("wiki identity", () => {
  test("keeps same-repository wiki variants distinct", () => {
    const technical = wikiVariantKey({ ref, style: "technical", pageCount: 6, languages: ["en"] });
    const hiddenQuirks = wikiVariantKey({ ref, style: "hidden-quirks", pageCount: 6, languages: ["en"] });

    expect(technical).toContain("style:technical");
    expect(hiddenQuirks).toContain("style:hidden-quirks");
    expect(technical).not.toBe(hiddenQuirks);
  });

  test("keeps auto page-count variants distinct from legacy exact-count variants", () => {
    const legacyExact = wikiVariantKey({ ref, style: "technical", pageCount: 6, languages: ["en"] });
    const autoCeiling = wikiVariantKey({ ref, style: "technical", pageCount: 6, pageCountMode: "auto", languages: ["en"] });
    const fixed = wikiVariantKey({ ref, style: "technical", pageCount: 6, pageCountMode: "fixed", languages: ["en"] });

    expect(legacyExact).not.toContain("pages-mode:");
    expect(autoCeiling).toContain("pages-mode:auto");
    expect(fixed).toContain("pages-mode:fixed");
    expect(autoCeiling).not.toBe(legacyExact);
    expect(autoCeiling).not.toBe(fixed);
  });

  test("uses a stable source key across style variants", () => {
    expect(wikiSourceKey(ref)).toBe("xai-org/x-algorithm@");
  });

  test("fills instance identity on legacy records without changing repo metadata", () => {
    const record = ensureWikiRecordIdentity({
      repoUrl: ref.url,
      owner: ref.owner,
      repo: ref.repo,
      branch: null,
      generatedAt: "2026-05-16T12:00:00.000Z",
      model: "grok",
      wikiStyle: "functional",
      wikiPageCount: 6,
      wikiLanguages: ["en"],
      structure: { title: "Functional Wiki", pages: [] },
      pages: {},
    } as unknown as WikiRecord);

    expect(record.id).toMatch(/^wiki-xai-org-x-algorithm-/);
    expect(record.sourceKey).toBe("xai-org/x-algorithm@");
    expect(record.variantKey).toContain("style:feature-scout");
    expect(record.owner).toBe(ref.owner);
    expect(record.repo).toBe(ref.repo);
  });
});
