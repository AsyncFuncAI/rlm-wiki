import { describe, expect, test } from "bun:test";

describe("wiki generation concurrency policy", () => {
  test("accepts concurrent user wiki runs instead of aborting the previous run", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();

    expect(source).toContain("MAX_GENERATE_PER_USER");
    expect(source).toContain("tryAcquireUserSlot(activeGenerateByUser, authIdentity.userId, MAX_GENERATE_PER_USER)");
    expect(source).not.toContain("abortActiveWikiGenerationForUser");
    expect(source).not.toContain("Stopped previous generation run");
  });

  test("uses the desktop-aware local CLI preflight on every run endpoint", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();
    // Match each full call expression (single- or multi-line) and assert `opts`
    // is the final argument. Line-based matching broke whenever a call was
    // formatted across multiple lines.
    const callSites = [...source.matchAll(/localCliPreflightResponse\(([\s\S]*?)\)\s*;/g)].filter(
      (match) => !source.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0).includes("async function"),
    );

    expect(callSites.length).toBeGreaterThanOrEqual(8);
    for (const match of callSites) {
      expect(match[1].trim()).toMatch(/(?:^|,)\s*opts\s*,?$/);
    }
    expect(source).toContain("if (!localCliRuntimeEnabled(req, opts))");
  });

  test("lets read-only Ask and Wiki flows use local folders without loosening Code git requirements", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url)).text();

    expect(source).toContain("function localFolderAccessForReadOnlyRequest");
    expect(source).toContain("requireGit: false");
    expect(source).toContain("const localRepoAccess = localFolderAccessForReadOnlyRequest(req, host, opts)");
    expect(source).toContain("parseAskRefsFromUrls(requestedUrls, localRepoAccess)");
    expect(source).toContain("parseWikiRefs(body, localFolderAccessForReadOnlyRequest(req, host, opts))");
    expect(source).toContain("parseCodeRefs(body, localRepoAccessForRequest(req, host, opts))");
  });
});
