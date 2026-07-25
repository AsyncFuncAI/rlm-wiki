import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RLMOptionsSchema } from "./rlm.ts";
import { loadSource, loadWorkspace, parseGitHubURL, resolveGitHubLoadTarget } from "./source-loader.ts";

describe("rlm-bun local source loading", () => {
  test("allows non-git local folders when no branch is requested", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-bun-local-folder-"));
    const source = join(root, "loose-folder");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# Loose folder\n");

    try {
      const loaded = await loadSource(source, { cache: false });

      expect(loaded.repoPath).toBe(source);
      await loaded.cleanup();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects branch selection for non-git local folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-bun-local-folder-"));
    const source = join(root, "loose-folder");
    mkdirSync(source, { recursive: true });

    try {
      await expect(loadSource(source, { branch: "main", cache: false })).rejects.toThrow(/requires a git repository/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses GitHub tree folder URLs without promoting the path to a branch", () => {
    expect(parseGitHubURL("https://github.com/openai/codex/tree/main/codex-rs/app-server")).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(parseGitHubURL("https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey?tab=readme")).toEqual({
      cloneURL: "https://github.com/AsyncFuncAI/rlm-wiki.git",
      branch: "feature/hotkey",
      sourcePath: null,
    });
    expect(parseGitHubURL("https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey/apps/desktop")).toEqual({
      cloneURL: "https://github.com/AsyncFuncAI/rlm-wiki.git",
      branch: "feature/hotkey",
      sourcePath: "apps/desktop",
    });
  });

  test("loads a scoped local source path as the repo path", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-bun-local-scope-"));
    const source = join(root, "repo");
    const scoped = join(source, "codex-rs", "app-server");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, "Cargo.toml"), "[package]\n");

    try {
      const loaded = await loadSource(source, { sourcePath: "codex-rs/app-server", cache: false });

      expect(loaded.checkoutPath).toBe(source);
      expect(loaded.repoPath).toBe(scoped);
      expect(loaded.sourcePath).toBe("codex-rs/app-server");
      await loaded.cleanup();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the parsed tree branch instead of an external combined branch override", () => {
    expect(resolveGitHubLoadTarget(
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      { branch: "main/codex-rs/app-server" },
    )).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("uses the parsed blob branch instead of an external combined branch override", () => {
    expect(resolveGitHubLoadTarget(
      "https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs",
      { branch: "main/codex-rs/app-server/src/main.rs" },
    )).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server/src/main.rs",
    });
  });

  test("keeps workspace source paths attached to each loaded repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-bun-workspace-scope-"));
    const repo = join(root, "repo");
    const scoped = join(repo, "apps", "desktop");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, "package.json"), "{}\n");

    try {
      const workspace = await loadWorkspace([
        { id: "desktop", source: repo, sourcePath: "apps/desktop", label: "Desktop" },
      ], { cache: false });

      expect(workspace.repos[0]).toMatchObject({
        id: "desktop",
        label: "Desktop",
        repoPath: scoped,
        sourcePath: "apps/desktop",
      });
      await workspace.cleanupAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves source paths in RLM options", () => {
    const parsed = RLMOptionsSchema.parse({
      source: "https://github.com/openai/codex",
      sourcePath: "codex-rs/app-server",
      mode: "rlm",
      llm: {},
    });
    const workspace = RLMOptionsSchema.parse({
      sources: [{
        id: "desktop",
        source: "https://github.com/AsyncFuncAI/rlm-wiki",
        branch: "feature/hotkey",
        sourcePath: "apps/desktop",
      }],
      mode: "workspace",
      llm: {},
    });

    expect(parsed.sourcePath).toBe("codex-rs/app-server");
    expect((workspace.sources?.[0] as { sourcePath?: string }).sourcePath).toBe("apps/desktop");
  });
});
