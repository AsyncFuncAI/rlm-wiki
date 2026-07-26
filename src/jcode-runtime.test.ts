import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJCodeStderrError } from "./jcode-errors.ts";
import { JCodeAgent, loadSource, resolveGitHubLoadTarget } from "./jcode-runtime.ts";
import type { JCodeModelClient } from "./jcode-runtime.ts";

describe("local source loading", () => {
  test("allows non-git local folders for read-only workspaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-local-folder-"));
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
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-local-folder-"));
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
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-local-folder-"));
    const source = join(root, "loose-notes");
    mkdirSync(source, { recursive: true });

    try {
      await expect(loadSource(source, { branch: "main" })).rejects.toThrow(/requires a git repository/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("jcode 0.58 error handling", () => {
  test("extractJCodeStderrError pulls Error: lines", () => {
    expect(extractJCodeStderrError("Error: Your current account is not eligible for Gemini Code Assist\n")).toContain(
      "not eligible for Gemini Code Assist",
    );
    expect(extractJCodeStderrError("info only")).toBe("");
  });

  test("treats NDJSON type:error with exit 0 as a hard failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-jcode-error-"));
    const source = join(root, "repo");
    const bin = join(root, "fake-jcode");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# demo\n");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
# Fake jcode 0.58: emit NDJSON error then exit 0 (regression observed in production).
if [[ " $* " == *" --version "* ]]; then
  echo "jcode v0.58.0-test"
  exit 0
fi
echo '{"type":"start","provider":"gemini","model":"gemini-3.6-flash"}'
echo '{"type":"connection_phase","phase":"authenticating"}'
echo '{"type":"error","message":"Your current account is not eligible for Gemini Code Assist for individuals."}'
echo 'Error: Your current account is not eligible for Gemini Code Assist for individuals.' >&2
exit 0
`,
      "utf8",
    );
    chmodSync(bin, 0o755);

    const previousBin = process.env.RLM_WIKI_JCODE_BIN;
    process.env.RLM_WIKI_JCODE_BIN = bin;
    const events: Array<{ type: string; error?: string }> = [];
    try {
      const llm = {
        providerArg: "gemini",
        model: "gemini-3.6-flash",
        channelId: "gemini-test",
        label: "Gemini test",
        generate: async () => "",
        generateAction: async () => ({ reasoning: "", code: "" }),
        lastUsage: null,
        onStream: null,
      } as unknown as JCodeModelClient;

      const agent = new JCodeAgent({
        source,
        mode: "repo",
        llm,
        onEvent: (event) => {
          if (event.type === "error") events.push(event);
        },
      });

      await expect(agent.query("Say hi")).rejects.toThrow(/not eligible for Gemini Code Assist/);
      expect(events.some((event) => /not eligible/i.test(event.error || ""))).toBe(true);
    } finally {
      if (previousBin === undefined) delete process.env.RLM_WIKI_JCODE_BIN;
      else process.env.RLM_WIKI_JCODE_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats successful NDJSON text stream as a normal answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-wiki-jcode-ok-"));
    const source = join(root, "repo");
    const bin = join(root, "fake-jcode");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# demo\n");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
echo '{"type":"start","provider":"openai","model":"gpt-5.6-sol"}'
echo '{"type":"text_delta","text":"<ANSWER>OK</ANSWER>"}'
echo '{"type":"done","text":"<ANSWER>OK</ANSWER>"}'
exit 0
`,
      "utf8",
    );
    chmodSync(bin, 0o755);

    const previousBin = process.env.RLM_WIKI_JCODE_BIN;
    process.env.RLM_WIKI_JCODE_BIN = bin;
    try {
      const llm = {
        providerArg: "openai",
        model: "gpt-5.6-sol",
        channelId: "openai-test",
        label: "OpenAI test",
        generate: async () => "",
        generateAction: async () => ({ reasoning: "", code: "" }),
        lastUsage: null,
        onStream: null,
      } as unknown as JCodeModelClient;

      const agent = new JCodeAgent({
        source,
        mode: "repo",
        llm,
      });

      const result = await agent.query("Say hi");
      expect(result.answer).toBe("OK");
    } finally {
      if (previousBin === undefined) delete process.env.RLM_WIKI_JCODE_BIN;
      else process.env.RLM_WIKI_JCODE_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
