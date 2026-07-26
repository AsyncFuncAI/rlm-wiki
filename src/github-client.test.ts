import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewGitHubConnectionStatus } from "./github-client.ts";

const originalToken = process.env.GITHUB_TOKEN;
const dirs: string[] = [];

afterEach(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("reviewGitHubConnectionStatus", () => {
  test("treats GITHUB_TOKEN as already connected", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_for_unit_test";
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-gh-"));
    dirs.push(root);
    const status = await reviewGitHubConnectionStatus(root, { defaultUserId: "test-user" });
    expect(status.connected).toBe(true);
    expect(status.provider).toBe("env");
    expect(status.configured).toBe(true);
  });

  test("reports disconnected when no token and no Composio GitHub auth", async () => {
    delete process.env.GITHUB_TOKEN;
    const root = mkdtempSync(join(tmpdir(), "rlm-wiki-gh-"));
    dirs.push(root);
    const status = await reviewGitHubConnectionStatus(root, { defaultUserId: "test-user" });
    expect(status.connected).toBe(false);
    // Without COMPOSIO_API_KEY, configured is false; with key but no OAuth, still disconnected.
    expect(status.provider === "none" || status.provider === "github").toBe(true);
  });
});
