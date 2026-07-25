import { describe, expect, test } from "bun:test";
import { isFailedWikiGeneratedPage, wikiRecordCompletion } from "./wiki-page-status.ts";

describe("wiki page status", () => {
  test("does not count failed placeholder pages as generated work", () => {
    const completion = wikiRecordCompletion({
      structure: {
        pages: [
          { id: "overview" },
          { id: "runtime" },
          { id: "transport" },
        ],
      },
      pages: {
        overview: {
          id: "overview",
          content: "# Overview\n\nReal generated content.",
          generatedAt: "2026-05-24T00:00:00.000Z",
        },
        runtime: {
          id: "runtime",
          status: "failed",
          error: "codex exited with 1",
          content: "> ⚠️ Page generation failed: codex exited with 1",
          generatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
    });

    expect(completion).toEqual({
      plannedPageCount: 3,
      generatedPageCount: 1,
      failedPageCount: 1,
      missingPageIds: ["transport"],
      failedPageIds: ["runtime"],
      recoverablePageIds: ["runtime", "transport"],
      partial: true,
    });
  });

  test("recognizes older warning-only failure pages", () => {
    expect(isFailedWikiGeneratedPage({
      id: "setup",
      content: "> ⚠️ The agent returned an invalid wiki page. This page needs regeneration.",
    })).toBe(true);
  });

  test("recognizes newer recovery notices as failed pages", () => {
    expect(isFailedWikiGeneratedPage({
      content: "> ⚠️ Page needs recovery.\n>\n> The local agent stopped before returning a wiki page.",
    })).toBe(true);
  });

  test("treats a saved outline with no pages as recoverable", () => {
    expect(wikiRecordCompletion({
      structure: {
        pages: [
          { id: "overview" },
          { id: "runtime" },
        ],
      },
      pages: {},
    })).toMatchObject({
      plannedPageCount: 2,
      generatedPageCount: 0,
      recoverablePageIds: ["overview", "runtime"],
      partial: true,
    });
  });
});
