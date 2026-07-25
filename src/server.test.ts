import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveGitHubLoadTarget } from "./jcode-runtime.ts";
import { configureServerTelemetry } from "./server-telemetry.ts";
import { appendCodeKbWikiContext, channelConfigForRequest, computeCodeKbAskEntry, desktopDirectPagesEnabled, extractAskCodeTokens, extractAskSearchPatterns, isDocsShapedAskQuestion, parseAskRefsFromSourceRefs, parseAskRefsFromUrls, parseWikiRefsFromSourceRefs, parseWikiRefsFromUrls, sendPersisted, shouldCaptureRunStreamError, waitForPersistedEvents, type AppendCodeKbOverrides } from "./server.ts";
import type { CodeKbSession } from "./sharenow-kb-client.ts";
import type { RepoRef } from "./types.ts";

describe("channels API config", () => {
  test("does not probe local CLI agents by default", async () => {
    let localAgentProbeCount = 0;

    const payload = await channelConfigForRequest(
      new Request("http://127.0.0.1/api/channels"),
      { desktop: { enabled: true } },
      {
        isLocalCliSidecarEnabled: () => true,
        loadLocalCliAgents: async () => {
          localAgentProbeCount++;
          return { enabled: true, agents: [] };
        },
      },
    );

    expect(localAgentProbeCount).toBe(0);
    expect(payload.localCli).toEqual({ enabled: true, agents: [] });
    expect(payload.channels.length).toBeGreaterThan(0);
    expect(payload.channels[0].runtimeStatus["local-cli"]).toEqual({
      configured: true,
      serverConfigured: false,
      missing: [],
      setup: null,
    });
  });

  test("probes local CLI agents only when requested by query param", async () => {
    let localAgentProbeCount = 0;
    let sawRescan = false;

    const payload = await channelConfigForRequest(
      new Request("http://127.0.0.1/api/channels?includeLocalCliAgents=1&rescan=1"),
      { desktop: { enabled: true } },
      {
        isLocalCliSidecarEnabled: () => true,
        loadLocalCliAgents: async (opts) => {
          localAgentProbeCount++;
          sawRescan = opts?.rescan === true;
          return {
            enabled: true,
            agents: [{
              id: "codex",
              name: "Codex",
              bin: "codex",
              path: "/usr/local/bin/codex",
              installed: true,
              runnable: true,
              version: "1.0.0",
              authStatus: "ready",
              models: ["gpt-5.5"],
              defaultModel: "gpt-5.5",
              reasoningOptions: [],
            }],
          };
        },
      },
    );

    expect(localAgentProbeCount).toBe(1);
    expect(sawRescan).toBe(true);
    expect(payload.localCli.agents.map((agent) => agent.id)).toEqual(["codex"]);
    expect(payload.channels[0].runtimeStatus["local-cli"].serverConfigured).toBe(true);
  });
});

describe("run event persistence", () => {
  test("keeps expected local runtime exits out of server Error Tracking", () => {
    expect(shouldCaptureRunStreamError("Stopped by user.")).toBe(false);
    expect(shouldCaptureRunStreamError("Task terminal session ended with an error")).toBe(false);
    expect(shouldCaptureRunStreamError("Codex CLI is not installed or authenticated. Run `codex login` on this machine.")).toBe(false);
    expect(shouldCaptureRunStreamError("Pi · Codex is not installed or authenticated. Run Pi login.")).toBe(false);
    expect(shouldCaptureRunStreamError("Claude Code exited with 1: auth failed")).toBe(false);
    expect(shouldCaptureRunStreamError("the local CLI runtime failed: codex exited with 1")).toBe(false);
    expect(shouldCaptureRunStreamError("Request failed with HTTP 503")).toBe(true);
    expect(shouldCaptureRunStreamError("Unhandled persistence invariant violation")).toBe(true);
  });

  test("stops appending run events after SQLite reports fatal storage exhaustion", async () => {
    configureServerTelemetry(false);
    const runId = `run-${crypto.randomUUID()}`;
    const sent: string[] = [];
    let appendCalls = 0;
    const store = {
      mode: "sqlite",
      appendEvent: async () => {
        appendCalls++;
        const error = new Error("database or disk is full");
        error.name = "SQLiteError";
        throw error;
      },
    } as any;

    sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
      type: "status",
      message: "first chunk",
    });
    await waitForPersistedEvents(runId);

    sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
      type: "status",
      message: "second chunk",
    });
    await waitForPersistedEvents(runId);

    expect(sent).toEqual(["agent", "agent"]);
    expect(appendCalls).toBe(1);
  });

  test("cools down run event persistence after SQLite lock retry exhaustion", async () => {
    configureServerTelemetry(false);
    process.env.RLM_WIKI_SQLITE_BUSY_RETRY_DELAYS_MS = "1,1";
    const runId = `run-${crypto.randomUUID()}`;
    const sent: string[] = [];
    let appendCalls = 0;
    const store = {
      mode: "sqlite",
      appendEvent: async () => {
        appendCalls++;
        const error = new Error("database is locked");
        error.name = "SQLiteError";
        throw error;
      },
    } as any;

    try {
      sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
        type: "status",
        message: "first chunk",
      });
      await waitForPersistedEvents(runId);

      sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
        type: "status",
        message: "second chunk",
      });
      await waitForPersistedEvents(runId);
    } finally {
      delete process.env.RLM_WIKI_SQLITE_BUSY_RETRY_DELAYS_MS;
    }

    expect(sent).toEqual(["agent", "agent"]);
    expect(appendCalls).toBe(3);
  });

  test("does not add extra SQLite lock retries unless explicitly configured", async () => {
    configureServerTelemetry(false);
    delete process.env.RLM_WIKI_SQLITE_BUSY_RETRY_DELAYS_MS;
    const runId = `run-${crypto.randomUUID()}`;
    const sent: string[] = [];
    let appendCalls = 0;
    const store = {
      mode: "sqlite",
      appendEvent: async () => {
        appendCalls++;
        const error = new Error("database is locked");
        error.name = "SQLiteError";
        throw error;
      },
    } as any;

    sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
      type: "status",
      message: "first chunk",
    });
    await waitForPersistedEvents(runId);

    sendPersisted(store, runId, (eventName) => sent.push(eventName), "agent", {
      type: "status",
      message: "second chunk",
    });
    await waitForPersistedEvents(runId);

    expect(sent).toEqual(["agent", "agent"]);
    expect(appendCalls).toBe(1);
  });
});

describe("ask source parsing", () => {
  test("keeps GitHub tree folder scopes distinct", () => {
    const refs = parseAskRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      "https://github.com/openai/codex/tree/main/codex-rs/core",
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
    ]);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
      label: "openai/codex:codex-rs/app-server",
    });
    expect(refs[1]).toMatchObject({
      branch: "main",
      sourcePath: "codex-rs/core",
      label: "openai/codex:codex-rs/core",
    });
  });

  test("normalizes Ask GitHub tree URLs before clone setup", () => {
    const refs = parseAskRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server?tab=readme",
      "https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey?tab=readme",
      "https://github.com/AsyncFuncAI/rlm-wiki/tree/feature/hotkey/apps/desktop",
      "openai/codex@main:codex-rs/core",
      "https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs",
    ]);

    expect(refs[0]).toMatchObject({
      owner: "openai",
      repo: "codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
      label: "openai/codex:codex-rs/app-server",
    });
    expect(refs[1]).toMatchObject({
      owner: "AsyncFuncAI",
      repo: "rlm-wiki",
      branch: "feature/hotkey",
      sourcePath: null,
      label: "AsyncFuncAI/rlm-wiki",
    });
    expect(refs[2]).toMatchObject({
      owner: "AsyncFuncAI",
      repo: "rlm-wiki",
      branch: "feature/hotkey",
      sourcePath: "apps/desktop",
      label: "AsyncFuncAI/rlm-wiki:apps/desktop",
    });
    expect(refs[3]).toMatchObject({
      owner: "openai",
      repo: "codex",
      branch: "main",
      sourcePath: "codex-rs/core",
      label: "openai/codex:codex-rs/core",
    });
    expect(refs[4]).toMatchObject({
      owner: "openai",
      repo: "codex",
      branch: "main",
      sourcePath: "codex-rs/app-server/src/main.rs",
      label: "openai/codex:codex-rs/app-server/src/main.rs",
    });
  });

  test("feeds scoped Ask GitHub URLs to runtime as base clone URLs plus scope", () => {
    const [ref] = parseAskRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
    ]);

    const target = resolveGitHubLoadTarget(ref.url, {
      branch: ref.branch,
      sourcePath: ref.sourcePath,
    });

    expect(ref.url).toBe("https://github.com/openai/codex");
    expect(target).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(target.cloneURL).not.toContain("/tree/");
  });

  test("accepts structured Ask refs without putting tree paths in clone URLs", () => {
    const [ref] = parseAskRefsFromSourceRefs([{
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    }]);

    const target = resolveGitHubLoadTarget(ref.url, {
      branch: ref.branch,
      sourcePath: ref.sourcePath,
    });

    expect(ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
      label: "openai/codex:codex-rs/app-server",
    });
    expect(target).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("does not let structured Ask refs promote source paths into clone branches", () => {
    const refs = parseAskRefsFromSourceRefs([
      {
        url: "https://github.com/openai/codex/tree/main/codex-rs/app-server",
        branch: "main/codex-rs/app-server",
      },
      {
        url: "https://github.com/openai/codex",
        branch: "main/codex-rs/core",
        sourcePath: "codex-rs/core",
      },
    ]);

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
      label: "openai/codex:codex-rs/app-server",
    });
    expect(refs[1]).toMatchObject({
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/core",
      label: "openai/codex:codex-rs/core",
    });

    for (const ref of refs) {
      const target = resolveGitHubLoadTarget(ref.url, {
        branch: ref.branch,
        sourcePath: ref.sourcePath,
      });
      expect(target.branch).toBe("main");
      expect(target.cloneURL).toBe("https://github.com/openai/codex.git");
      expect(target.cloneURL).not.toContain("/tree/");
      expect(target.branch).not.toContain(ref.sourcePath || "missing-source-path");
    }
  });
});

describe("wiki source parsing", () => {
  test("keeps GitHub tree folder scope on the primary wiki ref", () => {
    const parsed = parseWikiRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
    ]);

    expect(parsed.refs).toBeUndefined();
    expect(parsed.ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
  });

  test("dedupes workspace wiki sources by branch and path scope", () => {
    const parsed = parseWikiRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
      "https://github.com/openai/codex/tree/main/codex-rs/core",
      "https://github.com/openai/codex/tree/main/codex-rs/app-server?tab=readme",
    ]);

    expect(parsed.ref).toMatchObject({
      owner: "openai",
      repo: "codex-with-openai-codex",
      sourcePath: null,
    });
    expect(parsed.refs).toHaveLength(2);
    expect(parsed.refs?.map((ref) => ref.sourcePath)).toEqual([
      "codex-rs/app-server",
      "codex-rs/core",
    ]);
  });

  test("feeds scoped Wiki GitHub URLs to runtime as base clone URLs plus scope", () => {
    const parsed = parseWikiRefsFromUrls([
      "https://github.com/openai/codex/tree/main/codex-rs/app-server",
    ]);

    const target = resolveGitHubLoadTarget(parsed.ref.url, {
      branch: parsed.ref.branch,
      sourcePath: parsed.ref.sourcePath,
    });

    expect(parsed.ref.url).toBe("https://github.com/openai/codex");
    expect(target).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(target.cloneURL).not.toContain("/tree/");
  });

  test("does not let structured Wiki refs promote source paths into clone branches", () => {
    const parsed = parseWikiRefsFromSourceRefs([
      {
        url: "https://github.com/openai/codex/tree/main/codex-rs/app-server",
        branch: "main/codex-rs/app-server",
      },
    ]);

    const target = resolveGitHubLoadTarget(parsed.ref.url, {
      branch: parsed.ref.branch,
      sourcePath: parsed.ref.sourcePath,
    });

    expect(parsed.ref).toMatchObject({
      owner: "openai",
      repo: "codex",
      url: "https://github.com/openai/codex",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(target).toEqual({
      cloneURL: "https://github.com/openai/codex.git",
      branch: "main",
      sourcePath: "codex-rs/app-server",
    });
    expect(target.cloneURL).not.toContain("/tree/");
    expect(target.branch).not.toContain("codex-rs/app-server");
  });
});

describe("ask code-kb wiring", () => {
  const primaryRef: RepoRef = {
    owner: "vercel",
    repo: "next.js",
    url: "https://github.com/vercel/next.js",
    branch: null,
  };
  const readySession: CodeKbSession = {
    sessionId: "kb-abc123",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:vercel/next.js@default",
    ref: primaryRef,
  };
  const baseContexts = () => [
    { id: "vercel/next.js#wiki", label: "Next.js wiki", context: "wiki artifact context" },
    { id: "kb", label: "Knowledge base", context: "memory card block" },
  ];

  test("request intent and server configuration independently gate Code Graph", async () => {
    const serverModule = await import("./server.ts");
    const gate = (serverModule as Record<string, unknown>).codeGraphEnabledForRequest;
    expect(typeof gate).toBe("function");
    const enabledForRequest = gate as (requested: unknown) => boolean;
    const previous = process.env.RLM_WIKI_CODE_KB;
    try {
      delete process.env.RLM_WIKI_CODE_KB;
      // Opt-in only: missing/undefined defaults off.
      expect(enabledForRequest(undefined)).toBe(false);
      expect(enabledForRequest(true)).toBe(true);
      expect(enabledForRequest(false)).toBe(false);

      process.env.RLM_WIKI_CODE_KB = "0";
      expect(enabledForRequest(true)).toBe(false);
      expect(enabledForRequest(undefined)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RLM_WIKI_CODE_KB;
      else process.env.RLM_WIKI_CODE_KB = previous;
    }
  });

  test("ready session appends one entry after existing entries without reordering", async () => {
    const contexts = baseContexts();
    const before = contexts.map((entry) => ({ ...entry }));
    const ensuredRefs: RepoRef[] = [];
    const queriedTools: string[] = [];

    await appendCodeKbWikiContext(contexts, primaryRef, {
      enabled: () => true,
      ensure: async (ref) => {
        ensuredRefs.push(ref);
        return readySession;
      },
      query: async (_session, tool) => {
        queriedTools.push(tool);
        return null;
      },
    });

    expect(contexts.length).toBe(3);
    expect(contexts.slice(0, 2)).toEqual(before);
    expect(ensuredRefs).toEqual([primaryRef]);
    expect(contexts[2].id).toBe("code-kb");
    expect(contexts[2].context).toContain("kb-abc123");
    expect(contexts[2].context).toContain("https://sharenow.today");
    // The architecture map is dropped: no get_architecture query is made and the
    // entry carries no architecture section, only the session id + instructions.
    expect(queriedTools).not.toContain("get_architecture");
    expect(contexts[2].context).not.toContain("Architecture code map");
  });

  test("appends instructions-only entry without any architecture query", async () => {
    const contexts = baseContexts();
    const queriedTools: string[] = [];

    await appendCodeKbWikiContext(contexts, primaryRef, {
      enabled: () => true,
      ensure: async () => readySession,
      query: async (_session, tool) => {
        queriedTools.push(tool);
        return null;
      },
    });

    expect(contexts.length).toBe(3);
    expect(contexts[2].id).toBe("code-kb");
    expect(contexts[2].context).toContain("kb-abc123");
    expect(queriedTools).not.toContain("get_architecture");
    expect(contexts[2].context).not.toContain("Architecture code map");
  });

  test("slow ensure leaves contexts unchanged within budget (Covers R4)", async () => {
    const contexts = baseContexts();
    const before = contexts.map((entry) => ({ ...entry }));
    let resolveEnsure: (value: CodeKbSession | null) => void = () => {};
    const pending = new Promise<CodeKbSession | null>((resolve) => {
      resolveEnsure = resolve;
    });
    let queryCalls = 0;

    await appendCodeKbWikiContext(contexts, primaryRef, {
      enabled: () => true,
      budgetMs: 20,
      ensure: () => pending,
      query: async () => {
        queryCalls++;
        return {};
      },
    });

    expect(contexts).toEqual(before);
    expect(queryCalls).toBe(0);
    resolveEnsure(null);
  });

  test("failed ensure leaves contexts unchanged (Covers R4)", async () => {
    const contexts = baseContexts();
    const before = contexts.map((entry) => ({ ...entry }));

    await appendCodeKbWikiContext(contexts, primaryRef, {
      enabled: () => true,
      ensure: async () => {
        throw new Error("provisioning failed");
      },
      query: async () => ({}),
    });

    expect(contexts).toEqual(before);
  });

  test("null ensure result leaves contexts unchanged (Covers R4)", async () => {
    const contexts = baseContexts();
    const before = contexts.map((entry) => ({ ...entry }));

    await appendCodeKbWikiContext(contexts, primaryRef, {
      enabled: () => true,
      ensure: async () => null,
      query: async () => ({}),
    });

    expect(contexts).toEqual(before);
  });

  test("disabled flag leaves contexts unchanged with zero fetches", async () => {
    const previous = process.env.RLM_WIKI_CODE_KB;
    process.env.RLM_WIKI_CODE_KB = "0";
    try {
      const contexts = baseContexts();
      const before = contexts.map((entry) => ({ ...entry }));
      let ensureCalls = 0;
      let queryCalls = 0;

      await appendCodeKbWikiContext(contexts, primaryRef, {
        ensure: async () => {
          ensureCalls++;
          return readySession;
        },
        query: async () => {
          queryCalls++;
          return {};
        },
      });

      expect(contexts).toEqual(before);
      expect(ensureCalls).toBe(0);
      expect(queryCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.RLM_WIKI_CODE_KB;
      else process.env.RLM_WIKI_CODE_KB = previous;
    }
  });

  test("missing primary ref leaves contexts unchanged", async () => {
    const contexts = baseContexts();
    const before = contexts.map((entry) => ({ ...entry }));
    let ensureCalls = 0;

    await appendCodeKbWikiContext(contexts, null, {
      enabled: () => true,
      ensure: async () => {
        ensureCalls++;
        return readySession;
      },
      query: async () => ({}),
    });

    expect(contexts).toEqual(before);
    expect(ensureCalls).toBe(0);
  });

  test("workspace ask gets one entry for the primary ref only", async () => {
    // The handler passes only refs[0]; a multi-ref workspace must still yield a
    // single code-kb entry bound to the primary repo (v1 scope). The fake ensure
    // derives the session id from the ref it receives, so the appended entry
    // proves which ref flowed through the DI seam.
    const workspaceRefs: RepoRef[] = [
      primaryRef,
      { owner: "facebook", repo: "react", url: "https://github.com/facebook/react", branch: null },
    ];
    const contexts = baseContexts();
    const ensuredRefs: RepoRef[] = [];

    await appendCodeKbWikiContext(contexts, workspaceRefs[0] ?? null, {
      enabled: () => true,
      ensure: async (ref) => {
        ensuredRefs.push(ref);
        return { ...readySession, sessionId: `kb-${ref.owner}-${ref.repo}`, ref };
      },
      query: async () => null,
    });

    expect(ensuredRefs).toEqual([primaryRef]);
    expect(contexts.filter((entry) => entry.id === "code-kb").length).toBe(1);
    expect(contexts[contexts.length - 1].context).toContain("kb-vercel-next.js");
    expect(contexts[contexts.length - 1].context).not.toContain("kb-facebook-react");
  });

  test("the ask-interview handler pre-warms the code-kb session for the parsed source ref (R1)", () => {
    // Source-slice pin (same idiom as the /api/ask test below): prewarm is
    // unit-tested in sharenow-kb-client.test.ts, so pin the handler wiring.
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const interviewStart = server.indexOf('url.pathname === "/api/ask-interview"');
    expect(interviewStart).toBeGreaterThan(-1);
    const interviewEnd = server.indexOf('url.pathname === "/api/provider-setup/start"', interviewStart);
    expect(interviewEnd).toBeGreaterThan(interviewStart);

    const interviewHandler = server.slice(interviewStart, interviewEnd);
    expect(interviewHandler).toContain(
      "codeGraphEnabledForRequest(askInterviewBody.codeGraphEnabled)",
    );
    expect(interviewHandler).toContain(
      "prewarmCodeKbSession(parseRepoInput(askInterviewSource, localFolderAccessForReadOnlyRequest(req, host, opts)))",
    );
    // Fire-and-forget before the interview agent runs, guarded so an
    // unparseable source can never fail the interview request.
    const prewarmIndex = interviewHandler.indexOf("prewarmCodeKbSession(");
    const interviewRunIndex = interviewHandler.indexOf("await runAskInterview(");
    expect(prewarmIndex).toBeGreaterThan(-1);
    expect(interviewRunIndex).toBeGreaterThan(prewarmIndex);
  });

  test("the /api/generate handler pre-warms the code-kb session before validation (R1)", () => {
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const generateStart = server.indexOf('url.pathname === "/api/generate"');
    expect(generateStart).toBeGreaterThan(-1);

    const generateHandler = server.slice(generateStart);
    expect(generateHandler).toContain(
      "const codeGraphEnabled = codeGraphEnabledForRequest(body.codeGraphEnabled);",
    );
    expect(generateHandler).toContain("if (codeGraphEnabled) prewarmCodeKbSession(ref);");
    const prewarmIndex = generateHandler.indexOf("prewarmCodeKbSession(ref);");
    expect(prewarmIndex).toBeGreaterThan(-1);
    // Provisioning overlaps the remaining request validation and preflight:
    // the pre-warm fires before both, right after the refs parse.
    const preflightIndex = generateHandler.indexOf("localCliPreflightResponse(");
    const createRunIndex = generateHandler.indexOf("productStore.createRun(");
    expect(preflightIndex).toBeGreaterThan(prewarmIndex);
    expect(createRunIndex).toBeGreaterThan(prewarmIndex);
  });

  test("the /api/generate handler enables direct pages only for the desktop local server", () => {
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const generateStart = server.indexOf('url.pathname === "/api/generate"');
    expect(generateStart).toBeGreaterThan(-1);

    const generateHandler = server.slice(generateStart);
    const generateWikiStart = generateHandler.indexOf("const record = await generateWiki(ref, {");
    expect(generateWikiStart).toBeGreaterThan(-1);
    const generateWikiOptions = generateHandler.slice(generateWikiStart, generateWikiStart + 2_400);
    expect(generateWikiOptions).toContain("preferDirectPages: desktopDirectPagesEnabled({");
    expect(generateWikiOptions).toContain("benchmarkFastPages: body.benchmarkFastPages");
  });

  test("desktop direct pages cannot be enabled by the benchmark override on a web server", () => {
    expect(desktopDirectPagesEnabled({
      benchmarkMode: true,
      benchmarkFastPages: true,
    })).toBe(false);
  });

  test("desktop direct pages default on and only honor an explicit benchmark override", () => {
    const desktop = { desktop: { enabled: true } };
    expect(desktopDirectPagesEnabled({ server: desktop, benchmarkMode: false, benchmarkFastPages: false })).toBe(true);
    expect(desktopDirectPagesEnabled({ server: desktop, benchmarkMode: true })).toBe(true);
    expect(desktopDirectPagesEnabled({ server: desktop, benchmarkMode: true, benchmarkFastPages: false })).toBe(false);
    expect(desktopDirectPagesEnabled({ server: desktop, benchmarkMode: true, benchmarkFastPages: true })).toBe(true);
  });

  test("desktop benchmark code-graph prewarm is child-local and benchmark-gated", () => {
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const routeStart = server.indexOf('url.pathname === "/api/desktop-benchmark/code-graph"');
    expect(routeStart).toBeGreaterThan(-1);
    const route = server.slice(routeStart, routeStart + 1_800);

    expect(route).toContain("desktopBenchmarkEnabled(opts)");
    expect(route).toContain("parseWikiRefs(body, localFolderAccessForReadOnlyRequest(req, host, opts))");
    expect(route).toContain("await ensureCodeKbSession(parsed.ref, { budgetMs: 120_000 })");
    expect(route).toContain("ready: Boolean(session)");
  });

  test("the /api/ask handler computes the code-kb entry concurrently and appends it after resolving contexts", () => {
    // Source-slice pin (same idiom as server-wiki-interview.test.ts): the
    // exported helper is unit-tested above, so pin the handler wiring itself.
    const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const askHandlerStart = server.indexOf('url.pathname === "/api/ask")');
    expect(askHandlerStart).toBeGreaterThan(-1);

    const askHandler = server.slice(askHandlerStart);
    // Kicked off BEFORE wiki-context resolution so the kb work overlaps it
    // instead of adding serial wall-clock before the stream opens.
    // The question rides along so the U3 evidence pre-fetch can extract tokens.
    expect(askHandler).toContain(
      "const codeGraphEnabled = codeGraphEnabledForRequest(body.codeGraphEnabled);",
    );
    expect(askHandler).toContain("enabled: () => codeGraphEnabled");
    expect(askHandler).toContain("const codeKbEntry = await codeKbEntryPromise;");
    expect(askHandler).toContain("if (codeKbEntry) wikiContexts.push(codeKbEntry);");
    const kickoffIndex = askHandler.indexOf("computeCodeKbAskEntry(refs[0] ?? null, question, {");
    const resolveIndex = askHandler.indexOf("resolveAskWikiContexts(body.wikiContexts");
    const pushIndex = askHandler.indexOf("wikiContexts.push(codeKbEntry)");
    expect(kickoffIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(kickoffIndex);
    // Append-only ordering: the kb entry goes in after the explicit picks are
    // resolved, so nothing the user chose can be evicted or reordered.
    expect(pushIndex).toBeGreaterThan(resolveIndex);
  });
});

describe("ask code-kb evidence (U3)", () => {
  const primaryRef: RepoRef = {
    owner: "vercel",
    repo: "next.js",
    url: "https://github.com/vercel/next.js",
    branch: null,
  };
  const readySession: CodeKbSession = {
    sessionId: "kb-abc123",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:vercel/next.js@default",
    ref: primaryRef,
  };

  test("extractAskCodeTokens pulls quoted, camelCase, snake_case, and dotted tokens in order", () => {
    expect(extractAskCodeTokens("How does computeCodeKbAskEntry use ask_budget and utils.raceWithBudget?")).toEqual([
      "computeCodeKbAskEntry",
      "ask_budget",
      "utils.raceWithBudget",
    ]);
    // Quoted literals come first and duplicates dedupe case-insensitively.
    expect(extractAskCodeTokens("Where is 'renderAskEvidence' defined, and does renderAskEvidence call ask_budget?")).toEqual([
      "renderAskEvidence",
      "ask_budget",
    ]);
    // Contraction apostrophes never open a quoted literal.
    expect(extractAskCodeTokens("What's the deal with 'askRepo'?")).toEqual(["askRepo"]);
  });

  test("extractAskCodeTokens caps at three tokens and skips common English words", () => {
    expect(extractAskCodeTokens("Compare parseAskRefs, buildWikiPrompt, askRepo and runAgentLoop")).toEqual([
      "parseAskRefs",
      "buildWikiPrompt",
      "askRepo",
    ]);
    // Dotted latin abbreviations are stop words; real dotted paths survive.
    expect(extractAskCodeTokens("Does e.g. apply here, e.g. in a.b.c cases?")).toEqual(["a.b.c"]);
    expect(extractAskCodeTokens("Why is the response slow on large repositories?")).toEqual([]);
    expect(extractAskCodeTokens("")).toEqual([]);
  });

  test("extractAskSearchPatterns seeds NL architecture questions with technical phrases", () => {
    const patterns = extractAskSearchPatterns(
      "How does Orca connect agent terminals to browser automation? Name the key modules and the call path from terminal orchestration into browser control.",
    );
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.length).toBeLessThanOrEqual(4);
    // Bigrams preferred over bare stop-adjacent words.
    expect(patterns.some((p) => /browser/i.test(p))).toBe(true);
    expect(patterns.some((p) => /terminal/i.test(p))).toBe(true);
    // Pure English with no technical signal still yields nothing useful.
    expect(extractAskSearchPatterns("Why is the response slow?")).toEqual([]);
    // Code tokens still win when present.
    expect(extractAskSearchPatterns("How does computeCodeKbAskEntry use ask_budget?")).toEqual([
      "computeCodeKbAskEntry",
      "ask_budget",
    ]);
  });

  test("isDocsShapedAskQuestion matches the docs keyword list on word boundaries", () => {
    expect(isDocsShapedAskQuestion("How do I deploy this to production?")).toBe(true);
    expect(isDocsShapedAskQuestion("Getting started with self hosting")).toBe(true);
    expect(isDocsShapedAskQuestion("Is there a docker setup?")).toBe(true);
    // A docs keyword inside a camelCase identifier is not a docs signal.
    expect(isDocsShapedAskQuestion("What does buildWikiPrompt return?")).toBe(false);
    expect(isDocsShapedAskQuestion("Why is the response slow?")).toBe(false);
  });

  test("code-shaped question pre-runs search_code with exactly the extracted tokens", async () => {
    const searchCalls: Array<Record<string, unknown> | undefined> = [];
    const readFileCalls: string[] = [];

    const entry = await computeCodeKbAskEntry(primaryRef, "How does computeCodeKbAskEntry use ask_budget and utils.raceWithBudget?", {
      enabled: () => true,
      ensure: async () => readySession,
      peek: async () => ({ session: readySession, state: "ready" }),
      query: async (_session, tool, args) => {
        // The architecture map is dropped: the only query is the U3 search_code.
        expect(tool).toBe("search_code");
        searchCalls.push(args);
        return { matches: [{ file: "src/server.ts", text: `hit for ${String(args?.pattern)}` }] };
      },
      readFile: async (_session, path) => {
        readFileCalls.push(path);
        return null;
      },
    });

    expect(searchCalls).toEqual([
      { pattern: "computeCodeKbAskEntry" },
      { pattern: "ask_budget" },
      { pattern: "utils.raceWithBudget" },
    ]);
    expect(readFileCalls).toEqual([]);
    expect(entry).not.toBeNull();
    expect(entry!.context).toContain("# Ask evidence (pre-fetched, candidate only)");
    expect(entry!.context).toContain("## search_code results: computeCodeKbAskEntry");
    expect(entry!.context).toContain("hit for ask_budget");
    expect(entry!.context).not.toContain("## README.md head");
  });

  test("NL architecture question pre-runs search_code via phrase patterns on a warm session", async () => {
    const searchCalls: string[] = [];
    let ensureCalls = 0;
    const entry = await computeCodeKbAskEntry(
      primaryRef,
      "How does Orca connect agent terminals to browser automation?",
      {
        enabled: () => true,
        ensure: async () => {
          ensureCalls += 1;
          return readySession;
        },
        peek: async () => ({ session: readySession, state: "ready" }),
        query: async (_session, tool, args) => {
          expect(tool).toBe("search_code");
          searchCalls.push(String(args?.pattern || ""));
          return { matches: [{ file: "src/terminal.ts", text: `hit ${args?.pattern}` }] };
        },
      },
    );
    expect(ensureCalls).toBe(0);
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.some((p) => /terminal|browser/i.test(p))).toBe(true);
    expect(entry).not.toBeNull();
    expect(entry!.context).toContain("# Ask evidence (pre-fetched, candidate only)");
    expect(entry!.context).toContain("## Proactive use policy");
  });

  test("docs-shaped question pre-fetches the README head (120 lines)", async () => {
    const searchCalls: unknown[] = [];
    const readFileCalls: Array<{ path: string; range?: { startLine?: number; endLine?: number } }> = [];

    const entry = await computeCodeKbAskEntry(primaryRef, "How do I deploy this to production?", {
      enabled: () => true,
      ensure: async () => readySession,
      query: async (_session, tool, args) => {
        searchCalls.push({ tool, args });
        return null;
      },
      readFile: async (_session, path, range) => {
        readFileCalls.push({ path, range });
        return { content: "# rlm-wiki\nRun docker compose up." };
      },
    });

    expect(readFileCalls).toEqual([{ path: "README.md", range: { startLine: 1, endLine: 120 } }]);
    // Docs-shaped asks always fetch README; NL content words may also seed search_code.
    expect(entry).not.toBeNull();
    expect(entry!.context).toContain("## README.md head");
    expect(entry!.context).toContain("docker compose up");
  });

  test("mixed question fetches both search hits and the README head", async () => {
    const searchCalls: Array<Record<string, unknown> | undefined> = [];
    let readFileCalls = 0;

    const entry = await computeCodeKbAskEntry(primaryRef, "How do I install and configure the buildWikiPrompt pipeline?", {
      enabled: () => true,
      ensure: async () => readySession,
      query: async (_session, tool, args) => {
        if (tool !== "search_code") return null;
        searchCalls.push(args);
        return { matches: [{ file: "src/generator.ts" }] };
      },
      readFile: async () => {
        readFileCalls++;
        return { content: "# Install\nbun install" };
      },
    });

    expect(searchCalls).toEqual([{ pattern: "buildWikiPrompt" }]);
    expect(readFileCalls).toBe(1);
    expect(entry).not.toBeNull();
    expect(entry!.context).toContain("## search_code results: buildWikiPrompt");
    expect(entry!.context).toContain("## README.md head");
    expect(entry!.context).toContain("bun install");
  });

  test("no-signal question leaves the entry byte-identical to today's with zero evidence fetches (R8)", async () => {
    let evidenceFetches = 0;
    const overrides: AppendCodeKbOverrides = {
      enabled: () => true,
      ensure: async () => readySession,
      // No get_architecture query is made anymore; any query here would be a
      // U3 evidence fetch, which a no-signal question must never trigger.
      query: async () => {
        evidenceFetches++;
        return { matches: [] };
      },
      readFile: async () => {
        evidenceFetches++;
        return { content: "# README" };
      },
    };

    const baseline = await computeCodeKbAskEntry(primaryRef, "", overrides);
    const entry = await computeCodeKbAskEntry(primaryRef, "Why is the response slow on large repositories?", overrides);

    expect(evidenceFetches).toBe(0);
    expect(baseline).not.toBeNull();
    expect(entry).toEqual(baseline);
    expect(entry!.context).not.toContain("# Ask evidence");
    // The baseline entry is instructions only: no architecture map.
    expect(baseline!.context).not.toContain("Architecture code map");
  });

  test("evidence fetch failures degrade to today's entry (R8)", async () => {
    const workingOverrides: AppendCodeKbOverrides = {
      enabled: () => true,
      ensure: async () => readySession,
      query: async () => null,
      readFile: async () => null,
    };
    const failingOverrides: AppendCodeKbOverrides = {
      enabled: () => true,
      ensure: async () => readySession,
      query: async () => {
        throw new Error("search_code blew up");
      },
      readFile: async () => {
        throw new Error("file read blew up");
      },
    };

    const baseline = await computeCodeKbAskEntry(primaryRef, "", workingOverrides);
    const question = "How do I deploy the buildWikiPrompt pipeline?";

    expect(baseline).not.toBeNull();
    expect(await computeCodeKbAskEntry(primaryRef, question, failingOverrides)).toEqual(baseline);
    // Null results (kb answered, nothing found) degrade identically.
    expect(await computeCodeKbAskEntry(primaryRef, question, workingOverrides)).toEqual(baseline);
  });

  test("hanging evidence fetches never push the entry past the ask budget", async () => {
    const hangForever = new Promise<never>(() => {});
    const startedAt = Date.now();

    const entry = await computeCodeKbAskEntry(primaryRef, "How do I deploy computeCodeKbAskEntry?", {
      enabled: () => true,
      budgetMs: 50,
      ensure: async () => readySession,
      query: () => hangForever,
      readFile: () => hangForever,
    });
    const elapsed = Date.now() - startedAt;

    expect(entry).not.toBeNull();
    expect(entry!.context).toContain("kb-abc123");
    expect(entry!.context).not.toContain("# Ask evidence");
    // Generous ceiling: the point is that the ~50ms budget bounds the wait,
    // not the never-resolving fakes.
    expect(elapsed).toBeLessThan(1_500);
  });
});
