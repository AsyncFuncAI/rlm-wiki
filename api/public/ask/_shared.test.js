import { afterEach, describe, expect, test } from "bun:test";
import {
  UpstashPublicAskStore,
  createPublicAskSnapshot,
  makePrivateAskId,
  makePublicAskId,
  normalizePublicAskId,
  publicAskAgentHtmlFallback,
  publicAskMarkdownFull,
  publicAskMarkdownIndex,
  publicAskMarkdownUrls,
  publicAskPath,
  publicAskPublicationFromSnapshot,
  sanitizePublicAskRecord,
  shareSafeScopeLabel,
  shareSafeSourcePath,
} from "./_shared.js";

const baseRecord = {
  id: "ask-1749500000000",
  title: "How does the launchpad route asks?",
  description: "How does the launchpad route asks?",
  repoName: "openai/codex",
  scopes: ["openai/codex"],
  runtime: "Grok CLI",
  model: "grok-4",
  askedAt: "2026-06-10T12:00:00.000Z",
  turns: [
    {
      question: "How does the launchpad route asks?",
      answer: "It uses an **agent brain** that decides routing.\n\n- `src/launchpad.ts`",
      askedAt: "2026-06-10T11:58:00.000Z",
      clarifications: [{ question: "Which surface?", answer: "Desktop" }],
    },
    {
      question: "Where are repair loops handled?",
      answer: "In the repair module, with no regex fallback.",
    },
  ],
  sources: [
    { path: "src/launchpad.ts", detail: "agent router", excerpt: "export function route() {}" },
  ],
};

function baseSnapshot(visibility = "public") {
  return createPublicAskSnapshot({
    publicId: visibility === "private" ? makePrivateAskId() : "how-does-the-launchpad-route-asks-abc123456789",
    record: baseRecord,
    visibility,
    publishedAt: "2026-06-10T12:05:00.000Z",
    updatedAt: "2026-06-10T12:06:00.000Z",
  });
}

describe("public ask ids and paths", () => {
  test("public ids derive from the title and normalize round-trip", () => {
    const id = makePublicAskId("How does the Launchpad route Asks?!");
    expect(id).toMatch(/^how-does-the-launchpad-route-asks-[0-9a-f]{12}$/);
    expect(normalizePublicAskId(id)).toBe(id);
  });

  test("private ids are unguessable and prefix-tagged", () => {
    const id = makePrivateAskId();
    expect(id).toMatch(/^private-[0-9a-f]{32}$/);
    expect(normalizePublicAskId(id)).toBe(id);
  });

  test("visibility decides the path prefix", () => {
    expect(publicAskPath("abc12345", "public")).toBe("/public/ask/abc12345");
    expect(publicAskPath("abc12345", "private")).toBe("/share/ask/abc12345");
  });
});

describe("sanitizePublicAskRecord", () => {
  test("keeps answered turns, clarifications, and sources", () => {
    const record = sanitizePublicAskRecord(baseRecord);
    expect(record.turns).toHaveLength(2);
    expect(record.turns[0].clarifications).toHaveLength(1);
    expect(record.sources).toHaveLength(1);
    expect(record.title).toBe("How does the launchpad route asks?");
  });

  test("drops turns without an answer and throws when nothing is answered", () => {
    const record = sanitizePublicAskRecord({
      ...baseRecord,
      turns: [...baseRecord.turns, { question: "Pending?", answer: "" }],
    });
    expect(record.turns).toHaveLength(2);
    expect(() => sanitizePublicAskRecord({ ...baseRecord, turns: [{ question: "Pending?", answer: "" }] })).toThrow(/no completed turns/i);
  });

  test("reduces absolute scope and source paths so local layouts never leak", () => {
    const record = sanitizePublicAskRecord({
      ...baseRecord,
      repoName: "/Users/someone/code/secret-repo",
      scopes: ["/Users/someone/code/secret-repo", "owner/repo"],
      sources: [{ path: "/Users/someone/code/secret-repo/src/app.ts", excerpt: "x" }],
    });
    expect(record.repoName).toBe("…/code/secret-repo");
    expect(record.scopes).toEqual(["…/code/secret-repo", "owner/repo"]);
    expect(record.sources[0].path).toBe("…/secret-repo/src/app.ts");
    expect(JSON.stringify(record)).not.toContain("/Users/someone");
  });
});

describe("share-safe labels", () => {
  test("scope labels keep repos and urls, reduce machine paths", () => {
    expect(shareSafeScopeLabel("owner/repo")).toBe("owner/repo");
    expect(shareSafeScopeLabel("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
    expect(shareSafeScopeLabel("/Users/me/code/repo")).toBe("…/code/repo");
    expect(shareSafeScopeLabel("C:\\code\\repo")).toBe("…/code/repo");
    expect(shareSafeScopeLabel("~/code/repo")).toBe("…/code/repo");
  });

  test("source paths reject traversal and reduce absolute paths", () => {
    expect(shareSafeSourcePath("src/server.ts")).toBe("src/server.ts");
    expect(shareSafeSourcePath("../etc/passwd")).toBe("");
    expect(shareSafeSourcePath("/Users/me/code/repo/src/a.ts")).toBe("…/repo/src/a.ts");
  });
});

describe("markdown builders", () => {
  test("llms.txt index lists context links and every question", () => {
    const snapshot = baseSnapshot();
    const markdown = publicAskMarkdownIndex(snapshot, "https://rlmwiki.deepascii.com");
    expect(markdown).toContain("# How does the launchpad route asks?");
    expect(markdown).toContain("/llms-full.txt");
    expect(markdown).toContain("01. How does the launchpad route asks?");
    expect(markdown).toContain("02. Where are repair loops handled?");
    expect(markdown).toContain("`src/launchpad.ts`");
    expect(markdown).toContain("- Turns: 2");
  });

  test("full markdown carries answers, clarifications, and sources", () => {
    const snapshot = baseSnapshot();
    const markdown = publicAskMarkdownFull(snapshot, "https://rlmwiki.deepascii.com");
    expect(markdown).toContain("## Q1: How does the launchpad route asks?");
    expect(markdown).toContain("It uses an **agent brain** that decides routing.");
    expect(markdown).toContain("Which surface?: Desktop");
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("agent router");
    expect(markdown).not.toContain("—");
  });

  test("markdown urls follow the canonical path for both visibilities", () => {
    const urls = publicAskMarkdownUrls("https://rlmwiki.deepascii.com", baseSnapshot("private"));
    expect(urls.canonicalUrl).toMatch(/^https:\/\/rlm-wiki\.com\/share\/ask\/private-[0-9a-f]{32}$/);
    expect(urls.llmsUrl.endsWith("/llms.txt")).toBe(true);
    expect(urls.markdownUrl.endsWith(".md")).toBe(true);
  });
});

describe("agent fallback and publication", () => {
  test("fallback html embeds questions and the complete markdown", () => {
    const snapshot = baseSnapshot();
    const html = publicAskAgentHtmlFallback(snapshot, "https://rlmwiki.deepascii.com");
    expect(html).toContain('data-agent-readable="true"');
    expect(html).toContain("How does the launchpad route asks?");
    expect(html).toContain("Complete Markdown");
    expect(html).toContain("llms.txt");
  });

  test("publication carries recordVersion for desktop freshness checks", () => {
    const snapshot = baseSnapshot();
    const publication = publicAskPublicationFromSnapshot(snapshot, "https://rlmwiki.deepascii.com");
    expect(publication.published).toBe(true);
    expect(publication.publicUrl).toContain("/public/ask/");
    expect(publication.recordVersion).toBe("2026-06-10T12:00:00.000Z");
  });
});

describe("UpstashPublicAskStore", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function installFakeUpstash() {
    const kv = new Map();
    const run = (command) => {
      const [op, ...args] = command;
      if (op === "SET") {
        kv.set(args[0], args[1]);
        return "OK";
      }
      if (op === "GET") return kv.get(args[0]) ?? null;
      if (op === "MGET") return args.map((key) => kv.get(key) ?? null);
      if (op === "DEL") {
        let removed = 0;
        for (const key of args) removed += kv.delete(key) ? 1 : 0;
        return removed;
      }
      return null;
    };
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const payload = String(url).endsWith("/pipeline")
        ? body.map((command) => ({ result: run(command) }))
        : { result: run(body) };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    return kv;
  }

  function makeStore() {
    return new UpstashPublicAskStore({ url: "https://fake-upstash.test", token: "token" });
  }

  test("publish mints a token once and get() reassembles the turns", async () => {
    installFakeUpstash();
    const store = makeStore();
    const published = await store.publish({ record: baseRecord, visibility: "private", baseUrl: "https://rlmwiki.deepascii.com" });
    expect(published.managementToken).toBeTruthy();
    expect(published.publication.publicUrl).toContain("/share/ask/private-");

    const snapshot = await store.get(published.publication.publicId);
    expect(snapshot.ask.turns).toHaveLength(2);
    expect(snapshot.ask.turns[1].answer).toContain("repair module");
    expect(snapshot.visibility).toBe("private");
  });

  test("updates require the management token and trim stale tail turns", async () => {
    const kv = installFakeUpstash();
    const store = makeStore();
    const published = await store.publish({ record: baseRecord, visibility: "private", baseUrl: "https://rlmwiki.deepascii.com" });
    const publicId = published.publication.publicId;

    await expect(store.publish({ record: baseRecord, publicId, managementToken: "wrong" })).rejects.toThrow(/token rejected/i);

    const shorter = { ...baseRecord, turns: [baseRecord.turns[0]] };
    const updated = await store.publish({
      record: shorter,
      publicId,
      managementToken: published.managementToken,
      baseUrl: "https://rlmwiki.deepascii.com",
    });
    expect(updated.managementToken).toBeUndefined();
    expect(kv.has(`gw:public:ask:${publicId}:turn:1`)).toBe(false);
    const snapshot = await store.get(publicId);
    expect(snapshot.ask.turns).toHaveLength(1);
  });

  test("unpublish hides the snapshot and deletes turn bodies", async () => {
    const kv = installFakeUpstash();
    const store = makeStore();
    const published = await store.publish({ record: baseRecord, visibility: "public", baseUrl: "https://rlmwiki.deepascii.com" });
    const publicId = published.publication.publicId;

    const result = await store.unpublish({ publicId, managementToken: published.managementToken });
    expect(result.publication.published).toBe(false);
    expect(await store.get(publicId)).toBeNull();
    expect(kv.has(`gw:public:ask:${publicId}:turn:0`)).toBe(false);
  });
});
