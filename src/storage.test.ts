import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "./storage.ts";
import type { WikiRecord } from "./types.ts";

function wikiRecord(id: string, sourcePath: string | null): WikiRecord {
  return {
    id,
    owner: "openai",
    repo: "codex",
    repoUrl: "https://github.com/openai/codex",
    branch: "main",
    sourcePath,
    generatedAt: "2026-06-02T00:00:00.000Z",
    model: "gpt-5.5",
    structure: {
      title: sourcePath || "Full repo",
      description: "Test wiki.",
      sections: [{ id: "overview", title: "Overview", pages: ["overview"], subsections: [] }],
      pages: [{
        id: "overview",
        title: "Overview",
        description: "Overview.",
        importance: "high",
        filePaths: ["README.md"],
        relatedPages: [],
      }],
    },
    pages: {
      overview: {
        id: "overview",
        content: "# Overview",
        generatedAt: "2026-06-02T00:00:00.000Z",
      },
    },
  };
}

describe("WikiStore scoped refs", () => {
  test("loads a wiki by owner repo branch and source path", () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-storage-scope-"));
    const store = new WikiStore(root);

    try {
      store.save(wikiRecord("wiki-codex-full", null));
      store.save(wikiRecord("wiki-codex-app-server", "codex-rs/app-server"));

      expect(store.loadForRef({
        owner: "openai",
        repo: "codex",
        branch: "main",
        sourcePath: "codex-rs/app-server",
      })?.id).toBe("wiki-codex-app-server");

      expect(store.loadForRef({
        owner: "openai",
        repo: "codex",
        branch: "main",
        sourcePath: "codex-rs/core",
      })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
