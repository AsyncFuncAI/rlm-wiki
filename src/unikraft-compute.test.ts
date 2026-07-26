import { describe, expect, test } from "bun:test";
import {
  __resetUnikraftDispatchStateForTests,
  buildWorkerEnv,
  createUnikraftClient,
  dispatchJobToUnikraft,
  unikraftDispatchConfig,
  unikraftDispatchEnabledForJobType,
} from "./unikraft-compute.ts";

describe("unikraftDispatchConfig", () => {
  test("disabled without token or image", () => {
    expect(unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
    }).enabled).toBe(false);

    expect(unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "",
    }).enabled).toBe(false);
  });

  test("enabled when token, image, and dispatch flag are set", () => {
    const config = unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
      RLM_WIKI_UNIKRAFT_METRO: "dal",
      RLM_WIKI_UNIKRAFT_JOB_TYPES: "run.wiki_generate",
      RLM_WIKI_UNIKRAFT_MAX_CONCURRENT: "3",
    });
    expect(config.enabled).toBe(true);
    expect(config.metro).toBe("dal");
    expect(config.jobTypes).toEqual(["run.wiki_generate"]);
    expect(config.maxConcurrent).toBe(3);
  });

  test("job type gate respects allow-list", () => {
    const env = {
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
      RLM_WIKI_UNIKRAFT_JOB_TYPES: "run.wiki_generate",
    };
    expect(unikraftDispatchEnabledForJobType("run.wiki_generate", env)).toBe(true);
    expect(unikraftDispatchEnabledForJobType("run.ask", env)).toBe(false);
  });
});

describe("buildWorkerEnv", () => {
  test("never forwards Unikraft control-plane keys", () => {
    const previous = process.env.UNIKRAFT_API_KEY;
    process.env.UNIKRAFT_API_KEY = "should-not-leak";
    process.env.DATABASE_URL = "postgres://example";
    process.env.RLM_WIKI_SECRET_GRANT_KEY = "grant-key";
    try {
      const env = buildWorkerEnv({
        jobId: "job-1",
        ownerUserId: "user-1",
        runId: "run-1",
        extra: {
          UNIKRAFT_API_KEY: "also-no",
          UKC_TOKEN: "nope",
          SAFE_CUSTOM: "ok",
        },
      });
      expect(env.RLM_WIKI_JOB_ID).toBe("job-1");
      expect(env.RLM_WIKI_RUN_ID).toBe("run-1");
      expect(env.DATABASE_URL).toBe("postgres://example");
      expect(env.RLM_WIKI_SECRET_GRANT_KEY).toBe("grant-key");
      expect(env.SAFE_CUSTOM).toBe("ok");
      expect(env.UNIKRAFT_API_KEY).toBeUndefined();
      expect(env.UKC_TOKEN).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.UNIKRAFT_API_KEY;
      else process.env.UNIKRAFT_API_KEY = previous;
    }
  });
});

describe("dispatchJobToUnikraft", () => {
  test("creates a delete-on-stop instance for an assigned job", async () => {
    __resetUnikraftDispatchStateForTests();
    const calls: Array<{ method?: string; body?: unknown }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method, body });
      return new Response(JSON.stringify({
        status: "success",
        data: {
          instances: [{
            uuid: "11111111-1111-4111-8111-111111111111",
            name: "rlm-job-1",
            state: "starting",
          }],
        },
      }), { status: 200 });
    }) as typeof fetch;

    const config = unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
      RLM_WIKI_UNIKRAFT_METRO: "fra",
    });
    const client = createUnikraftClient(config, fetchImpl);
    const result = await dispatchJobToUnikraft({
      jobId: "job-abc",
      jobType: "run.wiki_generate",
      runId: "run-1",
      ownerUserId: "user-1",
      client,
      config,
    });

    expect(result.dispatched).toBe(true);
    expect(result.instance?.uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[0]?.method).toBe("POST");
    const body = calls[0]?.body as {
      features?: string[];
      args?: string[];
      entrypoint?: string[];
      env?: Record<string, string>;
      image?: { url?: string };
    };
    expect(body.features).toContain("delete-on-stop");
    expect(body.image?.url).toBe("oci://example/worker:latest");
    expect(body.entrypoint).toEqual(["bun"]);
    expect(body.args).toEqual(["run", "./bin/rlm-wiki.ts", "worker", "--once", "--job", "job-abc"]);
    expect(body.env?.RLM_WIKI_JOB_ID).toBe("job-abc");
    expect(body.env?.UNIKRAFT_API_KEY).toBeUndefined();
  });

  test("skips when at concurrency cap", async () => {
    __resetUnikraftDispatchStateForTests();
    const config = unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
      RLM_WIKI_UNIKRAFT_MAX_CONCURRENT: "1",
    });

    let resolveCreate: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const client = {
      createInstance: async () => {
        await blocked;
        return { uuid: "u", name: "n" };
      },
      deleteInstance: async () => {},
      listInstances: async () => [],
    };

    const first = dispatchJobToUnikraft({
      jobId: "job-1",
      jobType: "run.wiki_generate",
      ownerUserId: "user",
      client,
      config,
    });
    // Allow first call to enter inFlight++
    await Promise.resolve();
    const second = await dispatchJobToUnikraft({
      jobId: "job-2",
      jobType: "run.wiki_generate",
      ownerUserId: "user",
      client,
      config,
    });
    expect(second.dispatched).toBe(false);
    expect(second.skippedReason).toBe("max_concurrent_reached");
    resolveCreate?.();
    await first;
    __resetUnikraftDispatchStateForTests();
  });
});
