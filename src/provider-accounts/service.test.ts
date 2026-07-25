import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProviderAccountsSnapshot,
  removeProviderAccount,
  selectProviderAccount,
} from "./service.ts";
import { writeProviderAccountsFile } from "./store.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempAppData() {
  const dir = mkdtempSync(join(tmpdir(), "gw-accounts-"));
  temps.push(dir);
  return dir;
}

describe("provider accounts service", () => {
  test("starts with empty managed rosters and grok status", () => {
    const appDataDir = tempAppData();
    const snap = getProviderAccountsSnapshot({ appDataDir });
    expect(snap.claude.accounts).toEqual([]);
    expect(snap.claude.activeAccountId).toBeNull();
    expect(snap.codex.accounts).toEqual([]);
    expect(snap.codex.activeAccountId).toBeNull();
    expect(snap.grok).toHaveProperty("signedIn");
    expect(snap.grok).toHaveProperty("authPath");
  });

  test("prunes legacy Sign in pending stubs on snapshot", () => {
    const appDataDir = tempAppData();
    const homePath = join(appDataDir, "provider-accounts", "claude", "stub-1");
    mkdirSync(homePath, { recursive: true });
    writeProviderAccountsFile(
      {
        version: 1,
        claude: {
          accounts: [
            {
              id: "stub-1",
              email: "Sign in pending",
              homePath,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastAuthenticatedAt: 0,
            },
          ],
          activeAccountId: "stub-1",
        },
        codex: { accounts: [], activeAccountId: null },
      },
      appDataDir,
    );

    const snap = getProviderAccountsSnapshot({ appDataDir });
    expect(snap.claude.accounts).toEqual([]);
    expect(snap.claude.activeAccountId).toBeNull();
  });

  test("keeps authenticated managed account with email and org label", () => {
    const appDataDir = tempAppData();
    const homePath = join(appDataDir, "provider-accounts", "claude", "real-1");
    mkdirSync(homePath, { recursive: true });
    writeFileSync(
      join(homePath, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          refreshToken: "ref",
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(homePath, "oauth-account.json"),
      JSON.stringify({
        emailAddress: "sheing@falcon5.co",
        organizationName: "Falcon5",
      }),
      "utf8",
    );
    writeProviderAccountsFile(
      {
        version: 1,
        claude: {
          accounts: [
            {
              id: "real-1",
              email: "sheing@falcon5.co",
              homePath,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              lastAuthenticatedAt: Date.now(),
              label: "Falcon5",
            },
          ],
          activeAccountId: null,
        },
        codex: { accounts: [], activeAccountId: null },
      },
      appDataDir,
    );

    const snap = getProviderAccountsSnapshot({ appDataDir });
    expect(snap.claude.accounts).toHaveLength(1);
    expect(snap.claude.accounts[0]?.email).toBe("sheing@falcon5.co");
    expect(snap.claude.accounts[0]?.label).toBe("Falcon5");

    const selected = selectProviderAccount("claude", "real-1", { appDataDir });
    expect(selected.claude.activeAccountId).toBe("real-1");

    const system = selectProviderAccount("claude", null, { appDataDir });
    expect(system.claude.activeAccountId).toBeNull();

    const removed = removeProviderAccount("claude", "real-1", { appDataDir });
    expect(removed.claude.accounts).toHaveLength(0);
  });
});
