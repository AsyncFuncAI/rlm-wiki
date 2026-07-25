import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createProductStore } from "./persistence.ts";

const tempDirs: string[] = [];

function tempSqlitePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-sqlite-"));
  tempDirs.push(dir);
  return join(dir, "desktop.sqlite3");
}

afterEach(() => {
  delete process.env.RLM_WIKI_SQLITE_PATH;
  delete process.env.RLM_WIKI_SQLITE_BUSY_TIMEOUT_MS;
  delete process.env.RLM_WIKI_SQLITE_WRITE_BUSY_TIMEOUT_MS;
  delete process.env.RLM_WIKI_SQLITE_WRITE_BUSY_RETRY_DELAYS_MS;
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_PUBLIC_URL;
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SQLite ProductStore", () => {
  test("matches product-store run, event, and artifact semantics", async () => {
    process.env.RLM_WIKI_SQLITE_PATH = tempSqlitePath();
    const store = await createProductStore(tempDirs[0], { ownerUserId: "user-a" });

    const run = await store.createRun({
      kind: "wiki_generate",
      title: "Generate wiki",
      input: { ref: { owner: "openai", repo: "codex" }, pageCount: 6 },
    });
    expect(run.status).toBe("running");
    expect(run.input).toMatchObject({ pageCount: 6 });

    await store.appendEvent(run.id, "phase", { phase: "structure" });
    await store.appendEvent(run.id, "page-done", { pageId: "intro" });
    const replay = await store.getRun(run.id, { includeEvents: true });
    expect(replay?.events?.map((event) => [event.seq, event.type])).toEqual([
      [1, "phase"],
      [2, "page-done"],
    ]);

    const updated = await store.updateRun(run.id, {
      status: "done",
      result: { wiki: { owner: "openai", repo: "codex" } },
    });
    expect(updated?.status).toBe("done");

    const firstArtifact = await store.upsertArtifact({
      kind: "wiki",
      key: "openai/codex",
      runId: run.id,
      data: { owner: "openai", repo: "codex", pages: { intro: { id: "intro" } } },
    });
    const secondArtifact = await store.upsertArtifact({
      kind: "wiki",
      key: "openai/codex",
      runId: run.id,
      data: { owner: "openai", repo: "codex", pages: { intro: { id: "intro" }, api: { id: "api" } } },
    });
    expect(secondArtifact.id).toBe(firstArtifact.id);
    expect((await store.getArtifact("wiki", "openai/codex"))?.data).toMatchObject({
      pages: { api: { id: "api" } },
    });
  });

  test("retries non-stream writes when a transient SQLite writer lock clears", async () => {
    process.env.RLM_WIKI_SQLITE_WRITE_BUSY_TIMEOUT_MS = "5";
    process.env.RLM_WIKI_SQLITE_WRITE_BUSY_RETRY_DELAYS_MS = "20,20";
    const sqlitePath = tempSqlitePath();
    process.env.RLM_WIKI_SQLITE_PATH = sqlitePath;
    const store = await createProductStore(tempDirs[0], { ownerUserId: "user-a" });

    const run = await withTransientSqliteWriteLock(sqlitePath, () => store.createRun({
      kind: "wiki_generate",
      title: "Generate under lock",
      input: { pageCount: 3 },
    }));
    expect(run.status).toBe("running");

    const updated = await withTransientSqliteWriteLock(sqlitePath, () => store.updateRun(run.id, {
      status: "done",
      result: { wiki: { owner: "openai", repo: "codex" } },
    }));
    expect(updated?.status).toBe("done");

    const artifact = await withTransientSqliteWriteLock(sqlitePath, () => store.upsertArtifact({
      kind: "wiki",
      key: "openai/codex",
      runId: run.id,
      data: { owner: "openai", repo: "codex", pages: {} },
    }));
    expect(artifact.latestRunId).toBe(run.id);
    expect((await store.getArtifact("wiki", "openai/codex"))?.id).toBe(artifact.id);
  });

  test("restores the default SQLite busy timeout after non-stream writes", async () => {
    process.env.RLM_WIKI_SQLITE_WRITE_BUSY_TIMEOUT_MS = "5";
    process.env.RLM_WIKI_SQLITE_WRITE_BUSY_RETRY_DELAYS_MS = "5";
    const sqlitePath = tempSqlitePath();
    process.env.RLM_WIKI_SQLITE_PATH = sqlitePath;
    const store = await createProductStore(tempDirs[0], { ownerUserId: "user-a" });
    const run = await store.createRun({
      kind: "wiki_generate",
      title: "Generate with scoped timeout",
      input: { pageCount: 3 },
    });

    expect(sqliteBusyTimeout(store)).toBe(30000);

    await expect(withPersistentSqliteWriteLock(sqlitePath, () => store.updateRun(run.id, {
      status: "done",
      result: { wiki: { owner: "openai", repo: "codex" } },
    }))).rejects.toThrow(/database is locked|SQLITE_BUSY|database busy/i);

    expect(sqliteBusyTimeout(store)).toBe(30000);
  });

  test("bounds default non-stream write lock waits", async () => {
    const sqlitePath = tempSqlitePath();
    process.env.RLM_WIKI_SQLITE_PATH = sqlitePath;
    const store = await createProductStore(tempDirs[0], { ownerUserId: "user-a" });

    const startedAt = Date.now();
    await expect(withPersistentSqliteWriteLock(sqlitePath, () => store.createRun({
      kind: "wiki_generate",
      title: "Generate under persistent lock",
      input: { pageCount: 3 },
    }))).rejects.toThrow(/database is locked|SQLITE_BUSY|database busy/i);

    expect(Date.now() - startedAt).toBeLessThan(8000);
  });

  test("scopes runs and artifacts by owner", async () => {
    process.env.RLM_WIKI_SQLITE_PATH = tempSqlitePath();
    const storeA = await createProductStore(tempDirs[0], { ownerUserId: "user-a" });
    const storeB = await createProductStore(tempDirs[0], { ownerUserId: "user-b" });

    const run = await storeA.createRun({ kind: "ask", title: "Ask", input: { q: "hello" } });
    await storeA.upsertArtifact({
      kind: "wiki",
      key: "owner/repo",
      runId: run.id,
      data: { owner: "owner", repo: "repo", pages: {} },
    });

    expect(await storeB.getRun(run.id)).toBeNull();
    expect(await storeB.getArtifact("wiki", "owner/repo")).toBeNull();
    expect(await storeB.listRuns()).toEqual([]);
    expect(await storeB.listArtifacts("wiki")).toEqual([]);
  });
});

async function withTransientSqliteWriteLock<T>(
  sqlitePath: string,
  operation: () => Promise<T>,
  releaseDelayMs = 10,
): Promise<T> {
  const locker = new SQLiteDatabase(sqlitePath, { create: true });
  locker.run("PRAGMA busy_timeout = 1");
  locker.run("BEGIN IMMEDIATE");
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      locker.run("ROLLBACK");
    } finally {
      locker.close();
    }
  };
  const timer = setTimeout(release, releaseDelayMs);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    release();
  }
}

async function withPersistentSqliteWriteLock<T>(sqlitePath: string, operation: () => Promise<T>): Promise<T> {
  const locker = new SQLiteDatabase(sqlitePath, { create: true });
  locker.run("PRAGMA busy_timeout = 1");
  locker.run("BEGIN IMMEDIATE");
  try {
    return await operation();
  } finally {
    try {
      locker.run("ROLLBACK");
    } finally {
      locker.close();
    }
  }
}

function sqliteBusyTimeout(store: unknown): number {
  const row = (store as { db: SQLiteDatabase }).db.query("PRAGMA busy_timeout").get() as { timeout: number };
  return row.timeout;
}
