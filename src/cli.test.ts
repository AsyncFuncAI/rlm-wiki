import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, runCli, type CliDeps, type CliIO } from "./cli.ts";
import { createProductStore } from "./persistence.ts";
import { WikiStore } from "./storage.ts";
import type { WikiRecord } from "./types.ts";

function ioBuffer(): CliIO & { out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

function wikiRecord(owner = "owner", repo = "repo"): WikiRecord {
  return {
    id: `wiki-${owner}-${repo}`,
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
    branch: null,
    generatedAt: "2026-05-28T00:00:00.000Z",
    model: "gpt-5.5",
    runtime: "local-cli",
    runtimeModelLabel: "Grok CLI",
    structure: {
      title: "Test Wiki",
      description: "A test wiki.",
      sections: [{ id: "section", title: "Section", pages: ["page-overview"], subsections: [] }],
      pages: [{
        id: "page-overview",
        title: "Overview",
        description: "Overview.",
        importance: "high",
        filePaths: ["README.md"],
        relatedPages: [],
      }],
    },
    pages: {
      "page-overview": {
        id: "page-overview",
        content: "# Overview",
        generatedAt: "2026-05-28T00:00:00.000Z",
      },
    },
  };
}

function depsWith(overrides: Partial<CliDeps> = {}): CliDeps {
  const root = mkdtempSync(join(tmpdir(), "rlm-wiki-cli-test-"));
  return {
    createStore: () => new WikiStore(root),
    generateWiki: async () => wikiRecord(),
    askRepo: async () => ({ answer: "repo answer", sources: ["src/index.ts:1"] }),
    askWorkspace: async () => ({ answer: "workspace answer", sources: ["repo-a:src/index.ts:1"] }),
    getLocalCliAgents: async () => ({
      enabled: true,
      agents: [{
        id: "grok",
        name: "Grok CLI",
        bin: "grok",
        path: "/usr/local/bin/grok",
        installed: true,
        runnable: true,
        version: "1.0.0",
        authStatus: "ready",
        models: ["default", "grok-code-fast-1"],
        defaultModel: "default",
        reasoningOptions: ["default", "low", "high"],
      }],
    }),
    startServer: async () => undefined,
    startWorker: async () => undefined,
    startLocalCliSidecar: async () => undefined,
    ...overrides,
  } as CliDeps;
}

describe("rlm-wiki CLI", () => {
  test("parses repeated and equals flags without losing sources", () => {
    const parsed = parseFlags([
      "--source",
      "owner/repo-a",
      "--source=owner/repo-b",
      "--agent",
      "codex",
      "positional",
    ]);

    expect(parsed.positional).toEqual(["positional"]);
    expect(parsed.flags.source).toEqual(["owner/repo-a", "owner/repo-b"]);
    expect(parsed.flags.agent).toBe("codex");
  });

  test("generate uses local-cli runtime, local agent config, and workspace refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-cli-src-"));
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    const io = ioBuffer();
    const calls: Array<{ ref: unknown; opts: Record<string, unknown> }> = [];

    try {
      const code = await runCli([
        "generate",
        repoA,
        repoB,
        "--agent",
        "grok",
        "--model",
        "grok-code-fast-1",
        "--reasoning",
        "high",
        "--pages",
        "6",
        "--page-count-mode",
        "fixed",
        "--style",
        "first-30",
        "--language",
        "ja",
      ], depsWith({
        generateWiki: async (ref, opts) => {
          calls.push({ ref, opts: opts as Record<string, unknown> });
          return wikiRecord("local", "repo-a--with--local-repo-b");
        },
      }), io);

      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.runtime).toBe("local-cli");
      expect(calls[0].opts.localCli).toEqual({ agentId: "grok", model: "grok-code-fast-1", reasoning: "high" });
      expect(calls[0].opts.refs).toHaveLength(2);
      expect(calls[0].opts.pageCount).toBe(6);
      expect(calls[0].opts.pageCountMode).toBe("fixed");
      expect(calls[0].opts.style).toBe("first-30");
      expect(calls[0].opts.languages).toEqual(["ja"]);
      expect(io.out()).toContain("provider: local-cli");
      expect(io.err()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generate defaults match the desktop local-cli wiki form", async () => {
    const io = ioBuffer();
    const calls: Array<Record<string, unknown>> = [];
    const code = await runCli([
      "generate",
      "owner/repo",
      "--agent",
      "grok",
    ], depsWith({
      generateWiki: async (_ref, opts) => {
        calls.push(opts as Record<string, unknown>);
        return wikiRecord();
      },
    }), io);

    expect(code).toBe(0);
    expect(calls[0].pageCount).toBe(6);
    expect(calls[0].pageCountMode).toBe("auto");
    expect(calls[0].style).toBe("first-30");
    expect(calls[0].languages).toEqual(["en"]);
    expect(io.out()).toContain("pages: auto up to 6");
    expect(io.out()).toContain("style: first-30");
    });

  test("generate preserves GitHub tree folder scope", async () => {
    const io = ioBuffer();
    const calls: Array<{ ref: Record<string, unknown>; opts: Record<string, unknown> }> = [];
    const code = await runCli([
      "generate",
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      "--agent",
      "grok",
    ], depsWith({
      generateWiki: async (ref, opts) => {
        calls.push({ ref: ref as unknown as Record<string, unknown>, opts: opts as Record<string, unknown> });
        return wikiRecord("openai", "codex");
      },
    }), io);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(calls[0].opts.refs).toBeUndefined();
  });

  test("generate persists a product wiki artifact for desktop library hydration", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-cli-product-"));
    const io = ioBuffer();
    const store = new WikiStore(root);

    try {
      const code = await runCli([
        "generate",
        "owner/repo",
        "--agent",
        "grok",
      ], depsWith({
        createStore: () => store,
        generateWiki: async () => wikiRecord(),
      }), io);

      expect(code).toBe(0);
      const productStore = await createProductStore(root);
      const runs = await productStore.listRuns({ kind: "wiki_generate" });
      const artifacts = await productStore.listArtifacts("wiki");

      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("done");
      expect(runs[0].input.source).toBe("cli");
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].key).toBe("wiki:wiki-owner-repo");
      expect(artifacts[0].latestRunId).toBe(runs[0].id);
      expect(artifacts[0].data.structure).toMatchObject({ title: "Test Wiki" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generate passes custom wiki style prompt and validates language", async () => {
    const io = ioBuffer();
    const calls: Array<Record<string, unknown>> = [];
    const code = await runCli([
      "generate",
      "owner/repo",
      "--agent",
      "grok",
      "--style",
      "custom",
      "--style-prompt",
      "Write as an operator runbook.",
      "--languages",
      "fr,ja",
    ], depsWith({
      generateWiki: async (_ref, opts) => {
        calls.push(opts as Record<string, unknown>);
        return wikiRecord();
      },
    }), io);

    expect(code).toBe(0);
    expect(calls[0].style).toBe("custom");
    expect(calls[0].stylePrompt).toBe("Write as an operator runbook.");
    expect(calls[0].languages).toEqual(["fr"]);

    const badLanguageIo = ioBuffer();
    const badLanguage = await runCli([
      "generate",
      "owner/repo",
      "--agent",
      "grok",
      "--language",
      "klingon",
    ], depsWith(), badLanguageIo);
    expect(badLanguage).toBe(1);
    expect(badLanguageIo.err()).toContain("language must be one of");
  });

  test("ask routes multi-source questions through local-cli workspace Ask", async () => {
    const io = ioBuffer();
    let workspaceCall: { refs: unknown[]; question: string; opts: Record<string, unknown> } | null = null;
    let repoCalls = 0;

    const code = await runCli([
      "ask",
      "owner/repo-a",
      "owner/repo-b",
      "--question",
      "Compare auth flows",
      "--workspace-goal",
      "compare",
      "--mode",
      "fast",
      "--agent",
      "grok",
      "--model",
      "grok-code-fast-1",
    ], depsWith({
      askRepo: async () => {
        repoCalls += 1;
        return { answer: "wrong", sources: [] };
      },
      askWorkspace: async (refs, question, opts) => {
        workspaceCall = { refs, question, opts: opts as Record<string, unknown> };
        return { answer: "workspace answer", sources: ["owner-repo-a:src/auth.ts:1"] };
      },
    }), io);

    expect(code).toBe(0);
    expect(repoCalls).toBe(0);
    const capturedWorkspaceCall = workspaceCall as { refs: unknown[]; question: string; opts: Record<string, unknown> } | null;
    expect(capturedWorkspaceCall?.refs).toHaveLength(2);
    expect(capturedWorkspaceCall?.question).toBe("Compare auth flows");
    expect(capturedWorkspaceCall?.opts.runtime).toBe("local-cli");
    expect(capturedWorkspaceCall?.opts.askMode).toBe("fast");
    expect(capturedWorkspaceCall?.opts.workspaceGoal).toBe("compare");
    expect(capturedWorkspaceCall?.opts.localCli).toEqual({ agentId: "grok", model: "grok-code-fast-1" });
    expect(io.out()).toContain("workspace answer");
  });

  test("ask supports multi-source local paths for workspace Ask", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-cli-local-ask-"));
    const repoA = join(root, "api");
    const repoB = join(root, "web");
    mkdirSync(repoA);
    mkdirSync(repoB);
    const io = ioBuffer();
    let workspaceCall: { refs: Array<{ url: string }>; question: string; opts: Record<string, unknown> } | null = null;

    try {
      const code = await runCli([
        "ask",
        repoA,
        repoB,
        "--question",
        "Compare auth flows",
        "--agent",
        "grok",
      ], depsWith({
        askWorkspace: async (refs, question, opts) => {
          workspaceCall = { refs: refs as Array<{ url: string }>, question, opts: opts as Record<string, unknown> };
          return { answer: "local workspace answer", sources: [] };
        },
      }), io);

      expect(code).toBe(0);
      const capturedWorkspaceCall = workspaceCall as { refs: Array<{ url: string }>; question: string; opts: Record<string, unknown> } | null;
      expect(capturedWorkspaceCall?.refs.map((ref) => ref.url)).toEqual([repoA, repoB]);
      expect(capturedWorkspaceCall?.opts.runtime).toBe("local-cli");
      expect(io.out()).toContain("local/api + local/web");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ask keeps the old single-source positional question form", async () => {
    const io = ioBuffer();
    let askCall: { question: string; opts: Record<string, unknown> } | null = null;

    const code = await runCli([
      "ask",
      "owner/repo",
      "How",
      "does",
      "routing",
      "work?",
      "--agent",
      "grok",
    ], depsWith({
      askRepo: async (_ref, question, opts) => {
        askCall = { question, opts: opts as Record<string, unknown> };
        return { answer: "single answer", sources: [] };
      },
    }), io);

    expect(code).toBe(0);
    const capturedAskCall = askCall as { question: string; opts: Record<string, unknown> } | null;
    expect(capturedAskCall?.question).toBe("How does routing work?");
    expect(capturedAskCall?.opts.runtime).toBe("local-cli");
    expect(capturedAskCall?.opts.localCli).toEqual({ agentId: "grok" });
    expect(io.out()).toContain("single answer");
  });

  test("ask preserves GitHub tree folder scope", async () => {
    const io = ioBuffer();
    const askCalls: Array<{ ref: Record<string, unknown>; question: string }> = [];

    const code = await runCli([
      "ask",
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      "How",
      "does",
      "the",
      "app",
      "server",
      "start?",
      "--agent",
      "grok",
    ], depsWith({
      askRepo: async (ref, question) => {
        askCalls.push({ ref: ref as unknown as Record<string, unknown>, question });
        return { answer: "scoped answer", sources: ["src/lib.rs:1"] };
      },
    }), io);

    expect(code).toBe(0);
    expect(askCalls[0]?.question).toBe("How does the app server start?");
    expect(askCalls[0]?.ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(io.out()).toContain("openai/codex:codex-rs/app-server");
  });

  test("ask preserves GitHub blob path scope", async () => {
    const io = ioBuffer();
    const askCalls: Array<{ ref: Record<string, unknown>; question: string }> = [];

    const code = await runCli([
      "ask",
      "https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs",
      "Where",
      "does",
      "main",
      "start?",
      "--agent",
      "grok",
    ], depsWith({
      askRepo: async (ref, question) => {
        askCalls.push({ ref: ref as unknown as Record<string, unknown>, question });
        return { answer: "scoped answer", sources: ["codex-rs/app-server/src/main.rs:1"] };
      },
    }), io);

    expect(code).toBe(0);
    expect(askCalls[0]?.question).toBe("Where does main start?");
    expect(askCalls[0]?.ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server/src/main.rs",
    });
    expect(io.out()).toContain("openai/codex:codex-rs/app-server/src/main.rs");
  });

  test("ask persists a product ask run for desktop recent asks", async () => {
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-cli-ask-product-"));
    const io = ioBuffer();
    const store = new WikiStore(root);

    try {
      const code = await runCli([
        "ask",
        "owner/repo",
        "How does it work?",
        "--agent",
        "grok",
      ], depsWith({
        createStore: () => store,
        askRepo: async (_ref, _question, opts = {}) => {
          opts.onEvent?.({ type: "agent", event: { type: "status", message: "Inspecting repo" } } as never);
          return { answer: "It works through a local CLI run.", sources: ["src/cli.ts:1"] };
        },
      }), io);

      expect(code).toBe(0);
      const productStore = await createProductStore(root);
      const runs = await productStore.listRuns({ kind: "ask" });
      const fullRun = await productStore.getRun(runs[0].id, { includeEvents: true });

      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("done");
      expect(runs[0].input.source).toBe("cli");
      expect(runs[0].input.question).toBe("How does it work?");
      expect(runs[0].result?.answer).toBe("It works through a local CLI run.");
      expect((runs[0].result?.turns as Array<Record<string, unknown>>)[0].status).toBe("done");
      expect((runs[0].result?.turns as Array<Record<string, unknown>>)[0].refs).toHaveLength(1);
      expect(fullRun?.events?.map((event) => event.type)).toContain("answer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("auto-selects the first ready local CLI agent when --agent is omitted", async () => {
    const io = ioBuffer();
    let askCall: { opts: Record<string, unknown> } | null = null;
    const code = await runCli([
      "ask",
      "owner/repo",
      "What changed?",
      "--model",
      "sonnet",
    ], depsWith({
      getLocalCliAgents: async () => ({
        enabled: true,
        agents: [
          {
            id: "grok",
            name: "Grok CLI",
            bin: "grok",
            path: null,
            installed: false,
            runnable: false,
            version: null,
            authStatus: "missing",
            models: ["default"],
            defaultModel: "default",
            reasoningOptions: ["default"],
            setupHint: "Install Grok CLI.",
          },
          {
            id: "claude",
            name: "Claude Code",
            bin: "claude",
            path: "/usr/local/bin/claude",
            installed: true,
            runnable: true,
            version: "1.0.0",
            authStatus: "ready",
            models: ["default", "sonnet"],
            defaultModel: "default",
            reasoningOptions: ["default"],
          },
        ],
      }),
      askRepo: async (_ref, _question, opts) => {
        askCall = { opts: opts as Record<string, unknown> };
        return { answer: "auto answer", sources: [] };
      },
    }), io);

    expect(code).toBe(0);
    const capturedAskCall = askCall as { opts: Record<string, unknown> } | null;
    expect(capturedAskCall?.opts.localCli).toEqual({ agentId: "claude", model: "sonnet" });
    expect(io.out()).toContain("agent: Claude Code · sonnet");
  });

  test("applies non-sentinel local CLI default models", async () => {
    const io = ioBuffer();
    let askCall: { opts: Record<string, unknown> } | null = null;
    const code = await runCli([
      "ask",
      "owner/repo",
      "What changed?",
      "--agent",
      "codex",
    ], depsWith({
      getLocalCliAgents: async () => ({
        enabled: true,
        agents: [{
          id: "codex",
          name: "Codex CLI",
          bin: "codex",
          path: "/usr/local/bin/codex",
          installed: true,
          runnable: true,
          version: "1.0.0",
          authStatus: "ready",
          models: ["gpt-5.5", "gpt-5", "gpt-5.4", "o3", "o4-mini"],
          defaultModel: "gpt-5.5",
          reasoningOptions: ["default", "low", "high"],
        }],
      }),
      askRepo: async (_ref, _question, opts) => {
        askCall = { opts: opts as Record<string, unknown> };
        return { answer: "codex answer", sources: [] };
      },
    }), io);

    expect(code).toBe(0);
    const capturedAskCall = askCall as { opts: Record<string, unknown> } | null;
    expect(capturedAskCall?.opts.localCli).toEqual({ agentId: "codex", model: "gpt-5.5" });
    expect(io.out()).toContain("agent: Codex CLI · gpt-5.5");
  });

  test("rejects unknown enum-like CLI flags", async () => {
    const badAgent = await runCli(["ask", "owner/repo", "Question?", "--agent", "bogus"], depsWith(), ioBuffer());
    expect(badAgent).toBe(1);

    const badModeIo = ioBuffer();
    const badMode = await runCli(["ask", "owner/repo", "Question?", "--mode", "medium"], depsWith(), badModeIo);
    expect(badMode).toBe(1);
    expect(badModeIo.err()).toContain("mode must be one of");

    const badGoalIo = ioBuffer();
    const badGoal = await runCli([
      "ask",
      "owner/repo-a",
      "owner/repo-b",
      "--question",
      "Compare",
      "--workspace-goal",
      "summarize",
    ], depsWith(), badGoalIo);
    expect(badGoal).toBe(1);
    expect(badGoalIo.err()).toContain("workspace-goal must be one of");
  });

  test("preflights selected local CLI agent before running", async () => {
    const io = ioBuffer();
    let generated = false;
    const code = await runCli([
      "generate",
      "owner/repo",
      "--agent",
      "codex",
    ], depsWith({
      getLocalCliAgents: async () => ({
        enabled: true,
        agents: [{
          id: "codex",
          name: "Codex CLI",
          bin: "codex",
          path: null,
          installed: false,
          runnable: false,
          version: null,
          authStatus: "missing",
          models: ["default"],
          defaultModel: "default",
          reasoningOptions: ["default"],
          setupHint: "Install Codex CLI.",
        }],
      }),
      generateWiki: async () => {
        generated = true;
        return wikiRecord();
      },
    }), io);

    expect(code).toBe(1);
    expect(generated).toBe(false);
    expect(io.err()).toContain("Codex CLI is not ready");
    expect(io.err()).toContain("Install Codex CLI.");
  });

  test("reports unavailable local CLI sidecar before running agents", async () => {
    const io = ioBuffer();
    let generated = false;
    const code = await runCli(["generate", "owner/repo"], depsWith({
      getLocalCliAgents: async () => ({
        enabled: false,
        agents: [],
        error: "sidecar disabled",
      }),
      generateWiki: async () => {
        generated = true;
        return wikiRecord();
      },
    }), io);

    expect(code).toBe(1);
    expect(generated).toBe(false);
    expect(io.err()).toContain("Local CLI mode is unavailable");
    expect(io.err()).toContain("sidecar disabled");
  });

  test("rejects legacy runtime flags instead of silently using a provider path", async () => {
    const io = ioBuffer();
    let generated = false;
    const code = await runCli([
      "generate",
      "owner/repo",
      "--runtime",
      "rlm",
    ], depsWith({
      generateWiki: async () => {
        generated = true;
        return wikiRecord();
      },
    }), io);

    expect(code).toBe(1);
    expect(generated).toBe(false);
    expect(io.err()).toContain("only supports --runtime local-cli");
  });

  test("rejects invalid serve port before calling startServer", async () => {
    const io = ioBuffer();
    let started = false;
    const code = await runCli(["serve", "--port", "abc"], depsWith({
      startServer: async () => {
        started = true;
      },
    }), io);

    expect(code).toBe(1);
    expect(started).toBe(false);
    expect(io.err()).toContain("port must be a number");
  });

  test("serve and worker flags are passed through after validation", async () => {
    const io = ioBuffer();
    let serverOptions: unknown = null;
    let workerOptions: unknown = null;

    const serveCode = await runCli(["serve", "--port", "4545", "--host", "0.0.0.0"], depsWith({
      startServer: async (opts) => {
        serverOptions = opts;
      },
    }), io);
    const workerCode = await runCli(["worker", "--once"], depsWith({
      startWorker: async (opts) => {
        workerOptions = opts;
      },
    }), io);

    expect(serveCode).toBe(0);
    expect(serverOptions).toEqual({ port: 4545, host: "0.0.0.0" });
    expect(workerCode).toBe(0);
    expect(workerOptions).toEqual({ once: true });
  });

  test("package exposes the rlm-wiki executable alias", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin["rlm-wiki"]).toBe("./bin/rlm-wiki.ts");
    expect(pkg.bin["rlm-wiki"]).toBe("./bin/rlm-wiki.ts");
  });
});
