import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCodeKbClientForTests,
  codeKbBaseUrl,
  codeKbEnabled,
  defaultCodeKbExec,
  ensureCodeKbSession,
  peekCodeKbSession,
  prewarmCodeKbSession,
  queryCodeKb,
  readCodeKbFile,
  type CodeKbExec,
  type CodeKbExecResult,
  type CodeKbSession,
} from "./sharenow-kb-client.ts";
import type { RepoRef } from "./types.ts";

const githubRef: RepoRef = {
  owner: "vercel",
  repo: "ai",
  url: "https://github.com/vercel/ai",
  branch: null,
};

const localRef: RepoRef = {
  owner: "local",
  repo: "myrepo",
  url: "/Users/example/code/myrepo",
  branch: null,
};

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

function fakeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ?? null,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execResult(exitCode: number, stdout: string, stderr: string): CodeKbExecResult {
  return { exitCode, stdout: new TextEncoder().encode(stdout), stderr, capExceeded: false };
}

const failingExec: CodeKbExec = () => execResult(1, "", "not available in tests");

// Fake git/tar exec: git answers come from the optional head/branch callbacks
// (absent means git fails, i.e. non-git dir); tar streams a fake archive of
// `archiveBytes` to stdout and honors the byte cap the way defaultCodeKbExec
// does (crossing it reports capExceeded, as after a deliberate kill).
function fakeExec(options: { archiveBytes?: number; head?: () => string; branch?: () => string } = {}): {
  exec: CodeKbExec;
  commands: string[][];
} {
  const commands: string[][] = [];
  const exec: CodeKbExec = (command, execOpts) => {
    commands.push(command);
    if (command[0] === "git" && command.includes("--abbrev-ref")) {
      const branch = options.branch?.();
      return branch ? execResult(0, `${branch}\n`, "") : execResult(1, "", "not a git repo");
    }
    if (command[0] === "git") {
      const head = options.head?.();
      return head ? execResult(0, `${head}\n`, "") : execResult(1, "", "not a git repo");
    }
    if (command[0] === "tar") {
      const size = options.archiveBytes ?? 64;
      const max = execOpts?.maxStdoutBytes;
      if (max !== undefined && size > max) {
        return { exitCode: 137, stdout: new Uint8Array(max + 1).fill(0x1f), stderr: "", capExceeded: true };
      }
      return { exitCode: 0, stdout: new Uint8Array(size).fill(0x1f), stderr: "", capExceeded: false };
    }
    return execResult(1, "", `unexpected command ${command[0]}`);
  };
  return { exec, commands };
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.RLM_WIKI_CODE_KB = process.env.RLM_WIKI_CODE_KB;
  savedEnv.RLM_WIKI_CODE_KB_BASE_URL = process.env.RLM_WIKI_CODE_KB_BASE_URL;
  savedEnv.RLM_WIKI_CODE_KB_PROVISION_BUDGET_MS = process.env.RLM_WIKI_CODE_KB_PROVISION_BUDGET_MS;
  delete process.env.RLM_WIKI_CODE_KB;
  delete process.env.RLM_WIKI_CODE_KB_BASE_URL;
  delete process.env.RLM_WIKI_CODE_KB_PROVISION_BUDGET_MS;
  __resetCodeKbClientForTests();
});

afterEach(() => {
  for (const key of ["RLM_WIKI_CODE_KB", "RLM_WIKI_CODE_KB_BASE_URL", "RLM_WIKI_CODE_KB_PROVISION_BUDGET_MS"] as const) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetCodeKbClientForTests();
});

describe("code kb config", () => {
  test("enabled by default, disabled only by the explicit zero flag", () => {
    expect(codeKbEnabled()).toBe(true);
    process.env.RLM_WIKI_CODE_KB = "0";
    expect(codeKbEnabled()).toBe(false);
    process.env.RLM_WIKI_CODE_KB = "1";
    expect(codeKbEnabled()).toBe(true);
  });

  test("base URL defaults to sharenow.today and trims trailing slashes on override", () => {
    expect(codeKbBaseUrl()).toBe("https://sharenow.today");
    process.env.RLM_WIKI_CODE_KB_BASE_URL = "http://localhost:9999/";
    expect(codeKbBaseUrl()).toBe("http://localhost:9999");
  });
});

describe("defaultCodeKbExec", () => {
  test("captures stdout and exit code", async () => {
    const result = await defaultCodeKbExec(["printf", "hello"], {});
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("hello");
    expect(result.capExceeded).toBe(false);
  });

  test("kills a process that crosses the stdout byte cap", async () => {
    const result = await defaultCodeKbExec(["yes"], { maxStdoutBytes: 4096, timeoutMs: 10_000 });
    expect(result.capExceeded).toBe(true);
    expect(result.stdout.byteLength).toBeGreaterThan(4096);
  });

  test("kills a command that exceeds its timeout", async () => {
    const start = Date.now();
    const result = await defaultCodeKbExec(["sleep", "30"], { timeoutMs: 100 });
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("ensureCodeKbSession github route", () => {
  test("creates, polls provisioning to ready, and caches so a second call makes no fetch", async () => {
    const { impl, calls } = fakeFetch((call, index) => {
      if (index === 0) {
        expect(call.url).toBe("https://sharenow.today/api/v1/kb");
        expect(call.method).toBe("POST");
        expect(JSON.parse(String(call.body))).toEqual({ repoUrl: "https://github.com/vercel/ai" });
        return jsonResponse({ sessionId: "kb-1", slug: "ai", state: "provisioning" }, 202);
      }
      expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-1/status");
      if (index === 1) return jsonResponse({ sessionId: "kb-1", state: "provisioning" });
      return jsonResponse({ sessionId: "kb-1", state: "ready", project: "ai" });
    });

    const session = await ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 });
    expect(session).toEqual({
      sessionId: "kb-1",
      baseUrl: "https://sharenow.today",
      cacheKey: "github:vercel/ai@default",
      ref: githubRef,
    });
    expect(calls.length).toBe(3);

    const again = await ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 });
    expect(again).toBe(session as CodeKbSession);
    expect(calls.length).toBe(3);
  });

  test("carries the branch as ref and keys the cache per branch", async () => {
    let created = 0;
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: `kb-${created}`, slug: "ai", state: "ready", reused: true }, 202);
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const onBranch = await ensureCodeKbSession({ ...githubRef, branch: "canary" }, { fetchImpl: impl });
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ repoUrl: "https://github.com/vercel/ai", ref: "canary" });
    expect(onBranch?.cacheKey).toBe("github:vercel/ai@canary");

    const onDefault = await ensureCodeKbSession(githubRef, { fetchImpl: impl });
    expect(onDefault?.cacheKey).toBe("github:vercel/ai@default");
    expect(onDefault?.sessionId).toBe("kb-2");
    expect(created).toBe(2);
  });

  test("two concurrent ensures for the same repo share one create", async () => {
    let created = 0;
    let statusCalls = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: "kb-dedup", state: "provisioning" }, 202);
      }
      statusCalls += 1;
      return jsonResponse({ sessionId: "kb-dedup", state: statusCalls >= 2 ? "ready" : "provisioning" });
    });

    const [a, b] = await Promise.all([
      ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 }),
      ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 }),
    ]);
    expect(a?.sessionId).toBe("kb-dedup");
    expect(b?.sessionId).toBe("kb-dedup");
    expect(created).toBe(1);
  });

  test("a caller timeout leaves provisioning running; a later ensure converges without a second create", async () => {
    let created = 0;
    let statusCalls = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: "kb-resume", state: "provisioning" }, 202);
      }
      statusCalls += 1;
      return jsonResponse({ sessionId: "kb-resume", state: statusCalls >= 3 ? "ready" : "provisioning" });
    });

    const first = await ensureCodeKbSession(githubRef, {
      fetchImpl: impl,
      budgetMs: 5,
      pollIntervalMs: 10,
      internalBudgetMs: 5_000,
    });
    expect(first).toBe(null);

    const second = await ensureCodeKbSession(githubRef, {
      fetchImpl: impl,
      budgetMs: 5_000,
      pollIntervalMs: 10,
      internalBudgetMs: 5_000,
    });
    expect(second?.sessionId).toBe("kb-resume");
    expect(created).toBe(1);
  });

  test("transient status failures are retried until ready", async () => {
    let statusCalls = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) return jsonResponse({ sessionId: "kb-flaky", state: "provisioning" }, 202);
      statusCalls += 1;
      if (statusCalls === 1) throw new TypeError("socket hang up");
      if (statusCalls === 2) return jsonResponse({ error: { code: "oops" } }, 500);
      return jsonResponse({ sessionId: "kb-flaky", state: "ready" });
    });

    const session = await ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 });
    expect(session?.sessionId).toBe("kb-flaky");
    expect(statusCalls).toBe(3);
  });

  test("session cache is bounded: the oldest entry is evicted past 64 entries", async () => {
    let created = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: `kb-${created}`, state: "ready" }, 202);
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    for (let i = 0; i < 65; i += 1) {
      await ensureCodeKbSession({ ...githubRef, repo: `repo-${i}` }, { fetchImpl: impl });
    }
    expect(created).toBe(65);

    // The newest entry is still cached; the oldest was evicted and re-creates.
    await ensureCodeKbSession({ ...githubRef, repo: "repo-64" }, { fetchImpl: impl });
    expect(created).toBe(65);
    await ensureCodeKbSession({ ...githubRef, repo: "repo-0" }, { fetchImpl: impl });
    expect(created).toBe(66);
  });
});

describe("ensureCodeKbSession local route", () => {
  test("tars to stdout with the exclude set and uploads gzip to the local route", async () => {
    const { exec, commands } = fakeExec({ archiveBytes: 64 });
    const { impl, calls } = fakeFetch((call, index) => {
      if (index === 0) {
        expect(call.url).toBe("https://sharenow.today/api/v1/kb/local?name=myrepo");
        expect(call.method).toBe("POST");
        expect(call.headers.get("content-type")).toBe("application/gzip");
        return jsonResponse({ sessionId: "kb-local-1", slug: "myrepo", state: "provisioning" }, 202);
      }
      return jsonResponse({ sessionId: "kb-local-1", state: "ready", project: "myrepo" });
    });

    const session = await ensureCodeKbSession(localRef, { fetchImpl: impl, exec, pollIntervalMs: 1 });
    expect(session?.sessionId).toBe("kb-local-1");
    expect(session?.cacheKey).toBe(`local:${localRef.url}@worktree#default`);
    expect(calls.length).toBe(2);

    const tar = commands.find((command) => command[0] === "tar")!;
    expect(tar.slice(0, 3)).toEqual(["tar", "-czf", "-"]);
    expect(tar[3]).toBe("-C");
    expect(tar[4]).toBe(localRef.url);
    for (const pattern of ["node_modules", "*/node_modules", ".git", "dist", "build", "target", ".next", ".vercel"]) {
      expect(tar).toContain(`--exclude=${pattern}`);
    }
    expect(tar[tar.length - 1]).toBe(".");
  });

  test("secret-bearing patterns are excluded from the tar argv", async () => {
    const { exec, commands } = fakeExec({ archiveBytes: 64 });
    const { impl } = fakeFetch(() => jsonResponse({ sessionId: "kb-local-2", state: "ready" }, 202));

    await ensureCodeKbSession(localRef, { fetchImpl: impl, exec });
    const tar = commands.find((command) => command[0] === "tar")!;
    const secretPatterns = [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "*.keystore",
      "id_rsa",
      "id_rsa.*",
      "id_ed25519",
      "id_ed25519.*",
      ".npmrc",
      ".netrc",
      ".aws",
      ".ssh",
      "credentials",
      "credentials.*",
      "secrets",
      "secrets.*",
    ];
    for (const pattern of secretPatterns) {
      expect(tar).toContain(`--exclude=${pattern}`);
    }
  });

  test("an archive that crosses the stream cap is treated as oversized with no upload call", async () => {
    const { exec, commands } = fakeExec({ archiveBytes: 64 });
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not upload an oversized archive");
    });

    const skips: string[] = [];
    const session = await ensureCodeKbSession(localRef, {
      fetchImpl: impl,
      exec,
      maxArchiveBytes: 8,
      onSkip: (reason) => skips.push(reason),
    });
    expect(session).toBe(null);
    expect(calls.length).toBe(0);
    // The oversized archive surfaces a "too-large" skip reason for the UI, while
    // still resolving null (fail-silent).
    expect(skips).toEqual(["too-large"]);
    // The cap is handed to the exec seam so the real runner can kill tar early.
    const tar = commands.find((command) => command[0] === "tar")!;
    expect(tar).toBeDefined();
  });

  test("failed tar command returns null with no upload call", async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not upload without an archive");
    });

    const session = await ensureCodeKbSession(localRef, { fetchImpl: impl, exec: failingExec });
    expect(session).toBe(null);
    expect(calls.length).toBe(0);
  });

  test("keys the cache by HEAD sha so a new commit creates a fresh session", async () => {
    let sha = "a".repeat(40);
    const { exec } = fakeExec({ archiveBytes: 64, head: () => sha, branch: () => "main" });
    let created = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.includes("/api/v1/kb/local")) {
        created += 1;
        return jsonResponse({ sessionId: `kb-head-${created}`, state: "ready" }, 202);
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const first = await ensureCodeKbSession(localRef, { fetchImpl: impl, exec });
    expect(first?.cacheKey).toBe(`local:${localRef.url}@${"a".repeat(40)}#main`);
    expect(created).toBe(1);

    sha = "b".repeat(40);
    const second = await ensureCodeKbSession(localRef, { fetchImpl: impl, exec });
    expect(second?.cacheKey).toBe(`local:${localRef.url}@${"b".repeat(40)}#main`);
    expect(created).toBe(2);

    // Same HEAD again is a cache hit with no new create.
    const third = await ensureCodeKbSession(localRef, { fetchImpl: impl, exec });
    expect(third?.sessionId).toBe("kb-head-2");
    expect(created).toBe(2);
  });

  test("a requested branch matching the worktree is part of the cache key", async () => {
    const { exec } = fakeExec({ archiveBytes: 64, head: () => "c".repeat(40), branch: () => "main" });
    const { impl } = fakeFetch(() => jsonResponse({ sessionId: "kb-branch", state: "ready" }, 202));

    const session = await ensureCodeKbSession({ ...localRef, branch: "main" }, { fetchImpl: impl, exec });
    expect(session?.cacheKey).toBe(`local:${localRef.url}@${"c".repeat(40)}#main`);
  });

  test("a requested branch differing from the worktree skips kb entirely", async () => {
    const { exec, commands } = fakeExec({ archiveBytes: 64, head: () => "d".repeat(40), branch: () => "main" });
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not fetch on a branch mismatch");
    });

    const session = await ensureCodeKbSession({ ...localRef, branch: "feature-x" }, { fetchImpl: impl, exec });
    expect(session).toBe(null);
    expect(calls.length).toBe(0);
    expect(commands.some((command) => command[0] === "tar")).toBe(false);
  });
});

describe("ensureCodeKbSession failure paths (fallback invariant)", () => {
  test("disabled flag returns null immediately with zero fetches", async () => {
    process.env.RLM_WIKI_CODE_KB = "0";
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not fetch when disabled");
    });
    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl })).toBe(null);
    expect(calls.length).toBe(0);
  });

  test("network error resolves null, never throws", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl })).toBe(null);
  });

  test("503 feature gate resolves null", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ error: { code: "service_unavailable", message: "feature_unavailable" } }, 503));
    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl })).toBe(null);
  });

  test("provision failed status resolves null and a later ensure starts from create again", async () => {
    let created = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: `kb-${created}`, slug: "ai", state: "provisioning" }, 202);
      }
      return jsonResponse({ sessionId: `kb-${created}`, state: "failed", error: "clone failed" });
    });
    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 })).toBe(null);
    // The failed session was dropped from the cache, so ensure re-creates.
    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl, pollIntervalMs: 1 })).toBe(null);
    expect(created).toBe(2);
  });

  test("a session stuck provisioning resolves null and later ensures poll it instead of creating another", async () => {
    let created = 0;
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: "kb-slow", slug: "ai", state: "provisioning" }, 202);
      }
      return jsonResponse({ sessionId: "kb-slow", state: "provisioning" });
    });

    const opts = { fetchImpl: impl, budgetMs: 20, pollIntervalMs: 5, internalBudgetMs: 50 };
    expect(await ensureCodeKbSession(githubRef, opts)).toBe(null);
    // Let the shared provisioning attempt exhaust its own deadline.
    await sleep(120);
    const callsBefore = calls.length;

    // The sandbox still exists server-side, so the next ensure resumes
    // polling the cached provisioning session rather than creating an orphan.
    expect(await ensureCodeKbSession(githubRef, opts)).toBe(null);
    expect(created).toBe(1);
    expect(calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("prewarmCodeKbSession", () => {
  test("returns void instantly and the shared attempt provisions in the background", async () => {
    let created = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: "kb-warm", state: "ready" }, 202);
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const result = prewarmCodeKbSession(githubRef, { fetchImpl: impl });
    expect(result).toBeUndefined();
    // Fire-and-forget: nothing has been awaited at return time.
    expect(created).toBe(0);

    await sleep(20);
    expect(created).toBe(1);
    // The warmed session is a cache hit for the next ensure: no second create.
    const session = await ensureCodeKbSession(githubRef, { fetchImpl: impl });
    expect(session?.sessionId).toBe("kb-warm");
    expect(created).toBe(1);
  });

  test("returns instantly with a hanging create and never surfaces a rejection", async () => {
    const { impl, calls } = fakeFetch(() => new Promise<Response>(() => {}));
    expect(prewarmCodeKbSession(githubRef, { fetchImpl: impl })).toBeUndefined();
    await sleep(20);
    // The internal attempt started and is parked on the hanging create.
    expect(calls.length).toBe(1);
  });

  test("swallows throwing fetch and exec failures", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    expect(prewarmCodeKbSession(githubRef, { fetchImpl: impl })).toBeUndefined();
    expect(prewarmCodeKbSession(localRef, { fetchImpl: impl, exec: failingExec })).toBeUndefined();
    await sleep(20);
  });

  test("disabled flag is a no-op with zero fetches", async () => {
    process.env.RLM_WIKI_CODE_KB = "0";
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not fetch when disabled");
    });
    expect(prewarmCodeKbSession(githubRef, { fetchImpl: impl })).toBeUndefined();
    await sleep(20);
    expect(calls.length).toBe(0);
  });
});

describe("peekCodeKbSession", () => {
  test("returns null on a cache miss with zero fetches", async () => {
    const { impl, calls } = fakeFetch(() => {
      throw new Error("peek must never fetch");
    });
    expect(await peekCodeKbSession(githubRef, { fetchImpl: impl })).toBe(null);
    expect(calls.length).toBe(0);
  });

  test("returns a provisioning entry cached by an earlier ensure without fetches", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        return jsonResponse({ sessionId: "kb-peek", state: "provisioning" }, 202);
      }
      return jsonResponse({ sessionId: "kb-peek", state: "provisioning" });
    });

    expect(await ensureCodeKbSession(githubRef, { fetchImpl: impl, budgetMs: 20, pollIntervalMs: 5, internalBudgetMs: 50 })).toBe(null);
    // Let the shared provisioning attempt exhaust its own deadline first so
    // background polling cannot race the fetch-count assertion below.
    await sleep(120);
    const callsBefore = calls.length;

    const peeked = await peekCodeKbSession(githubRef);
    expect(peeked?.state).toBe("provisioning");
    expect(peeked?.session.sessionId).toBe("kb-peek");
    expect(peeked?.session.cacheKey).toBe("github:vercel/ai@default");
    expect(calls.length).toBe(callsBefore);
  });

  test("returns a ready entry after a completed ensure", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ sessionId: "kb-ready-peek", state: "ready" }, 202));
    await ensureCodeKbSession(githubRef, { fetchImpl: impl });

    const peeked = await peekCodeKbSession(githubRef);
    expect(peeked?.state).toBe("ready");
    expect(peeked?.session.sessionId).toBe("kb-ready-peek");
  });

  test("local refs resolve the cache key best-effort: a differing key or failing git is a miss", async () => {
    const { exec } = fakeExec({ archiveBytes: 64, head: () => "e".repeat(40), branch: () => "main" });
    const { impl } = fakeFetch(() => jsonResponse({ sessionId: "kb-local-peek", state: "ready" }, 202));
    await ensureCodeKbSession(localRef, { fetchImpl: impl, exec });

    const hit = await peekCodeKbSession(localRef, { exec });
    expect(hit?.session.sessionId).toBe("kb-local-peek");
    // A failing git resolves the worktree key, which does not match the
    // HEAD-keyed entry: best-effort peek reports a miss instead of throwing.
    expect(await peekCodeKbSession(localRef, { exec: failingExec })).toBe(null);
  });

  test("branch mismatch and disabled flag resolve null", async () => {
    const { exec } = fakeExec({ archiveBytes: 64, head: () => "f".repeat(40), branch: () => "main" });
    expect(await peekCodeKbSession({ ...localRef, branch: "feature-x" }, { exec })).toBe(null);

    process.env.RLM_WIKI_CODE_KB = "0";
    expect(await peekCodeKbSession(githubRef)).toBe(null);
  });
});

describe("queryCodeKb / readCodeKbFile", () => {
  const session: CodeKbSession = {
    sessionId: "kb-live",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:vercel/ai@default",
    ref: githubRef,
  };

  test("returns the result payload on success", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-live/query");
      expect(JSON.parse(String(call.body))).toEqual({ tool: "get_architecture", args: {} });
      return jsonResponse({ result: { nodes: 12, edges: 30 } });
    });
    expect(await queryCodeKb(session, "get_architecture", {}, { fetchImpl: impl })).toEqual({ nodes: 12, edges: 30 });
    expect(calls.length).toBe(1);
  });

  test("file reads post path and range to the file route", async () => {
    const { impl } = fakeFetch((call) => {
      expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-live/file");
      expect(JSON.parse(String(call.body))).toEqual({ path: "src/index.ts", startLine: 5, endLine: 20 });
      return jsonResponse({ result: { content: "export {}" } });
    });
    expect(await readCodeKbFile(session, "src/index.ts", { startLine: 5, endLine: 20 }, { fetchImpl: impl })).toEqual({
      content: "export {}",
    });
  });

  test("410 invalidates, re-creates once, and retries the query", async () => {
    const { impl, calls } = fakeFetch((call, index) => {
      if (index === 0) {
        expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-live/query");
        return jsonResponse({ error: { code: "gone", message: "kb session sandbox is gone" } }, 410);
      }
      if (index === 1) {
        expect(call.url).toBe("https://sharenow.today/api/v1/kb");
        return jsonResponse({ sessionId: "kb-fresh", slug: "ai", state: "ready", reused: true }, 202);
      }
      expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-fresh/query");
      return jsonResponse({ result: { callers: ["a", "b"] } });
    });

    const result = await queryCodeKb(session, "context", { symbol: "run" }, { fetchImpl: impl });
    expect(result).toEqual({ callers: ["a", "b"] });
    expect(calls.length).toBe(3);
  });

  test("410 on a session seeded through ensure invalidates the cache entry and creates exactly one new session", async () => {
    let created = 0;
    const { impl } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        created += 1;
        return jsonResponse({ sessionId: `kb-${created}`, state: "ready" }, 202);
      }
      if (call.url.includes("/kb-1/query")) {
        return jsonResponse({ error: { code: "gone", message: "sandbox is gone" } }, 410);
      }
      expect(call.url).toBe("https://sharenow.today/api/v1/kb/kb-2/query");
      return jsonResponse({ result: { ok: true } });
    });

    const seeded = await ensureCodeKbSession(githubRef, { fetchImpl: impl });
    expect(seeded?.sessionId).toBe("kb-1");
    expect(created).toBe(1);

    const result = await queryCodeKb(seeded!, "context", { symbol: "run" }, { fetchImpl: impl });
    expect(result).toEqual({ ok: true });
    expect(created).toBe(2);

    // The stale entry was replaced: a later ensure returns the fresh session
    // from the cache without another create.
    const after = await ensureCodeKbSession(githubRef, { fetchImpl: impl });
    expect(after?.sessionId).toBe("kb-2");
    expect(created).toBe(2);
  });

  test("second consecutive 410 resolves null", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/v1/kb")) {
        return jsonResponse({ sessionId: "kb-fresh-2", slug: "ai", state: "ready", reused: true }, 202);
      }
      return jsonResponse({ error: { code: "gone", message: "gone again" } }, 410);
    });
    expect(await queryCodeKb(session, "context", { symbol: "run" }, { fetchImpl: impl })).toBe(null);
    expect(calls.length).toBe(3);
  });

  test("non-410 HTTP errors and network errors resolve null, never throw", async () => {
    const badStatus = fakeFetch(() => jsonResponse({ error: { code: "invalid_request", message: "unknown tool" } }, 400));
    expect(await queryCodeKb(session, "nope", {}, { fetchImpl: badStatus.impl })).toBe(null);

    const networkError = fakeFetch(() => {
      throw new TypeError("socket hang up");
    });
    expect(await readCodeKbFile(session, "src/index.ts", undefined, { fetchImpl: networkError.impl })).toBe(null);
  });

  test("disabled flag short-circuits queries with zero fetches", async () => {
    process.env.RLM_WIKI_CODE_KB = "0";
    const { impl, calls } = fakeFetch(() => {
      throw new Error("must not fetch when disabled");
    });
    expect(await queryCodeKb(session, "context", {}, { fetchImpl: impl })).toBe(null);
    expect(calls.length).toBe(0);
  });
});
