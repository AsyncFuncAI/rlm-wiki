import { describe, expect, test } from "bun:test";
import {
  WIKI_BUILTIN_STYLES,
  WIKI_PAGE_COUNT_MAX,
  WIKI_STYLES,
  defaultWikiPageCountForDepth,
  normalizeWikiPageCount,
  normalizeWikiStyle,
} from "./wiki-options.ts";

describe("wiki options", () => {
  test("allows a temporary one-page wiki run", () => {
    expect(normalizeWikiPageCount(1, 12)).toBe(1);
    expect(normalizeWikiPageCount("1", 12)).toBe(1);
    expect(normalizeWikiPageCount(0, 12)).toBe(1);
  });

  test("caps generated wiki size at thirty pages", () => {
    expect(WIKI_PAGE_COUNT_MAX).toBe(30);
    expect(normalizeWikiPageCount(30, 12)).toBe(30);
    expect(normalizeWikiPageCount(31, 12)).toBe(30);
    expect(normalizeWikiPageCount(50, 12)).toBe(30);
    expect(defaultWikiPageCountForDepth("deep")).toBe(30);
  });

  test("normalizes all public wiki styles", () => {
    expect(WIKI_BUILTIN_STYLES).toEqual([
      "basic",
      "technical",
      "first-30",
      "eli5",
      "mental-model",
      "socratic-exploration",
      "feature-scout",
      "worth-stealing",
      "hidden-quirks",
      "pattern-discovery",
      "repo-comparison",
      "debugging-atlas",
      "tech-reader",
      "documentation",
    ]);
    for (const style of WIKI_STYLES) {
      expect(normalizeWikiStyle(style)).toBe(style);
    }
  });

  test("maps hidden legacy wiki styles to public replacements", () => {
    expect(normalizeWikiStyle("functional")).toBe("feature-scout");
    expect(normalizeWikiStyle("wlog")).toBe("socratic-exploration");
    expect(normalizeWikiStyle("design")).toBe("worth-stealing");
  });

  test("falls back for unknown wiki styles", () => {
    expect(normalizeWikiStyle("unknown", "technical")).toBe("technical");
  });
});
