import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSource, resolveGitHubLoadTarget } from "./jcode-runtime.ts";

describe("local source loading", () => {
  test("allows non-git local folders for read-only workspaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-local-folder-"));
    const source = join(root, "loose-notes");
    const target = join(root, "workspace", "loose-notes");
    mkdirSync(join(source, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(source, "README.md"), "# Loose folder\n");
    writeFileSync(join(source, "node_modules", "ignored", "package.json"), "{}");

    try {
      const loaded = await loadSource(source, { tmpDir: target });

      expect(loaded.repoPath).toBe(target);
      expect(existsSync(join(target, "README.md"))).toBe(true);
      expect(existsSync(join(target, "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can scope a loaded source to a subfolder", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-local-folder-"));
    const source = join(root, "repo");
    const target = join(root, "workspace", "repo");
    mkdirSync(join(source, "codex-rs", "app-server"), { recursive: true });
    writeFileSync(join(source, "README.md"), "# Root\n");
    writeFileSync(join(source, "codex-rs", "app-server", "Cargo.toml"), "[package]\n");

    try {
      const loaded = await loadSource(source, {
        sourcePath: "codex-rs/app-server",
        tmpDir: target,
      });

      expect(loaded.checkoutPath).toBe(target);
      expect(loaded.repoPath).toBe(join(target, "codex-rs", "app-server"));
      expect(loaded.sourcePath).toBe("codex-rs/app-server");
      expect(existsSync(join(loaded.repoPath, "Cargo.toml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers a parsed GitHub tree branch over an external combined branch override", () => {
    expect(resolveGitHubLoadTarget(
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      { branch: "main/codex-rs/app-server" },
    )).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("normalizes GitHub blob URLs before clone setup", () => {
    expect(resolveGitHubLoadTarget(
      "https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs",
      { branch: "main/codex-rs/app-server/src/main.rs" },
    )).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server/src/main.rs",
    });
  });

  test("still rejects branch selection for non-git local folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-local-folder-"));
    const source = join(root, "loose-notes");
    mkdirSync(source, { recursive: true });

    try {
      await expect(loadSource(source, { branch: "main" })).rejects.toThrow(/requires a git repository/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
