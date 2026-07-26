import { describe, expect, test } from "bun:test";
import {
  buildWorkerEnv,
  countLiveWorkerInstances,
  createUnikraftClient,
  dispatchJobToUnikraft,
  unikraftDispatchConfig,
  unikraftDispatchEnabledForJobType,
  unikraftGraceUntilIso,
  unikraftInstanceNameForJob,
} from "./unikraft-compute.ts";
import { isUnikraftGraceQueued, type JobRecord } from "./job-queue.ts";

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
      expect(env.DATABASE_URL).toBe("postgres://example");
      expect(env.RLM_WIKI_SECRET_GRANT_KEY).toBe("grant-key");
      expect(env.SAFE_CUSTOM).toBe("ok");
      expect(env.UNIKRAFT_API_KEY).toBeUndefined();
      expect(env.UKC_TOKEN).toBeUndefined();
      expect(env.RLM_WIKI_RUN_ID).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.UNIKRAFT_API_KEY;
      else process.env.UNIKRAFT_API_KEY = previous;
    }
  });
});

describe("isUnikraftGraceQueued", () => {
  test("reserves queued unikraft jobs during grace window", () => {
    const now = Date.now();
    const job = {
      status: "queued",
      payload: {
        unikraftDispatched: true,
        unikraftGraceUntil: new Date(now + 60_000).toISOString(),
      },
    } as unknown as JobRecord;
    expect(isUnikraftGraceQueued(job, now)).toBe(true);
    expect(isUnikraftGraceQueued(job, now + 120_000)).toBe(false);
  });
});

describe("dispatchJobToUnikraft", () => {
  test("creates a delete-on-stop instance for an assigned job", async () => {
    const calls: Array<{ method?: string; url?: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method, url: String(url), body });
      if (String(url).endsWith("/instances") && (init?.method || "GET") === "GET") {
        return new Response(JSON.stringify({ status: "success", data: { instances: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "success",
        data: {
          instances: [{
            uuid: "11111111-1111-4111-8111-111111111111",
            name: unikraftInstanceNameForJob("job-abc"),
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
    const create = calls.find((call) => call.method === "POST");
    const body = create?.body as {
      features?: string[];
      args?: string[];
      entrypoint?: string[];
      env?: Record<string, string>;
      image?: { url?: string };
      name?: string;
    };
    expect(body.features).toContain("delete-on-stop");
    expect((body as { image?: string }).image).toBe("oci://example/worker:latest");
    expect(body.entrypoint).toBeUndefined();
    expect(body.args).toBeUndefined();
    expect(body.env?.RLM_WIKI_JOB_ID).toBe("job-abc");
    expect(body.env?.UNIKRAFT_API_KEY).toBeUndefined();
    expect(body.name).toBe(unikraftInstanceNameForJob("job-abc"));
  });

  test("skips when live instance count is at cap", async () => {
    const client = {
      createInstance: async () => {
        throw new Error("should not create");
      },
      deleteInstance: async () => {},
      listInstances: async () => ([
        { uuid: "a", name: "rlm-a", state: "running" },
        { uuid: "b", name: "rlm-b", state: "starting" },
      ]),
    };
    const config = unikraftDispatchConfig({
      RLM_WIKI_UNIKRAFT_DISPATCH: "1",
      UNIKRAFT_API_KEY: "token",
      RLM_WIKI_UNIKRAFT_IMAGE: "oci://example/worker:latest",
      RLM_WIKI_UNIKRAFT_MAX_CONCURRENT: "2",
    });
    const result = await dispatchJobToUnikraft({
      jobId: "job-2",
      jobType: "run.wiki_generate",
      ownerUserId: "user",
      client,
      config,
    });
    expect(result.dispatched).toBe(false);
    expect(result.skippedReason).toContain("max_concurrent_reached");
    expect(await countLiveWorkerInstances(client)).toBe(2);
  });
});

describe("unikraftGraceUntilIso", () => {
  test("returns a future ISO timestamp", () => {
    const ts = Date.parse(unikraftGraceUntilIso(1_000_000, 5_000));
    expect(ts).toBe(1_005_000);
  });
});
