import { describe, expect, test } from "bun:test";

describe("wiki worker Code Graph request snapshot", () => {
  test("defaults missing request snapshots off and requires an explicit opt-in", async () => {
    const worker = await import("./run-worker.ts");

    expect(worker.normalizeWikiCodeGraphEnabled(undefined)).toBe(false);
    expect(worker.normalizeWikiCodeGraphEnabled(true)).toBe(true);
    expect(worker.normalizeWikiCodeGraphEnabled(false)).toBe(false);
  });

  test("combines the request snapshot with the server authority gate", async () => {
    const worker = await import("./run-worker.ts");

    expect(worker.codeGraphEnabledForWikiWorker(undefined, () => true)).toBe(false);
    expect(worker.codeGraphEnabledForWikiWorker(false, () => true)).toBe(false);
    expect(worker.codeGraphEnabledForWikiWorker(true, () => true)).toBe(true);
    expect(worker.codeGraphEnabledForWikiWorker(true, () => false)).toBe(false);
  });
});
