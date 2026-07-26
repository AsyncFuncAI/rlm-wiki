import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretGrantStore } from "./secret-grants.ts";

const originalGrantKey = process.env.RLM_WIKI_SECRET_GRANT_KEY;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDatabasePublicUrl = process.env.DATABASE_PUBLIC_URL;
const dirs: string[] = [];

afterEach(() => {
  if (originalGrantKey === undefined) delete process.env.RLM_WIKI_SECRET_GRANT_KEY;
  else process.env.RLM_WIKI_SECRET_GRANT_KEY = originalGrantKey;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDatabasePublicUrl === undefined) delete process.env.DATABASE_PUBLIC_URL;
  else process.env.DATABASE_PUBLIC_URL = originalDatabasePublicUrl;
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-secret-grants-"));
  dirs.push(dir);
  return dir;
}

describe("secret grants", () => {
  test("is disabled when no encryption key is configured", async () => {
    delete process.env.RLM_WIKI_SECRET_GRANT_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PUBLIC_URL;
    const store = await createSecretGrantStore(tempRoot());
    expect(store.mode).toBe("disabled");
    expect(store.configured).toBe(false);
    const grant = await store.create({
      ownerUserId: "user-1",
      purpose: "run.ask",
      providerSecrets: { OPENAI_API_KEY: "sk-should-not-store" },
    });
    expect(grant).toBeNull();
  });

  test("encrypts secrets at rest and never writes plaintext keys to disk", async () => {
    process.env.RLM_WIKI_SECRET_GRANT_KEY = "test-secret-grant-key-for-unit-tests";
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PUBLIC_URL;

    const root = tempRoot();
    const store = await createSecretGrantStore(root);
    expect(store.mode).toBe("file");
    expect(store.configured).toBe(true);

    const secret = "sk-live-must-not-appear-on-disk";
    const grant = await store.create({
      ownerUserId: "owner@example.com",
      purpose: "run.code",
      providerSecrets: {
        OPENAI_API_KEY: secret,
        GEMINI_API_KEY: "AIza-also-secret",
        NOT_A_KEY: "drop-me",
      } as Record<string, string>,
      ttlSeconds: 120,
    });
    expect(grant?.id).toMatch(/^grant-/);
    expect(grant?.expiresAt).toBeTruthy();

    const grantDir = join(root, "secret-grants");
    expect(existsSync(grantDir)).toBe(true);
    const files = readdirSync(grantDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);

    const onDisk = readFileSync(join(grantDir, files[0]!), "utf8");
    expect(onDisk).not.toContain(secret);
    expect(onDisk).not.toContain("AIza-also-secret");
    expect(onDisk).not.toContain("OPENAI_API_KEY");
    expect(onDisk).toContain("ciphertext");
    expect(onDisk).toContain("iv");
    expect(onDisk).toContain("tag");

    const readBack = await store.read(grant!.id, "owner@example.com");
    expect(readBack).toEqual({
      OPENAI_API_KEY: secret,
      GEMINI_API_KEY: "AIza-also-secret",
    });

    // Wrong owner cannot read the grant.
    expect(await store.read(grant!.id, "other@example.com")).toBeNull();

    const revoked = await store.revoke(grant!.id, "owner@example.com", "test complete");
    expect(revoked).toBe(true);
    expect(await store.read(grant!.id, "owner@example.com")).toBeNull();

    const afterRevoke = readFileSync(join(grantDir, files[0]!), "utf8");
    expect(afterRevoke).not.toContain(secret);
    expect(afterRevoke).toContain("revokedAt");
  });

  test("empty or invalid secret payloads create no grant", async () => {
    process.env.RLM_WIKI_SECRET_GRANT_KEY = "test-secret-grant-key-for-unit-tests";
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_PUBLIC_URL;
    const store = await createSecretGrantStore(tempRoot());
    expect(await store.create({
      ownerUserId: "owner",
      purpose: "run.ask",
      providerSecrets: {},
    })).toBeNull();
    expect(await store.create({
      ownerUserId: "owner",
      purpose: "run.ask",
      providerSecrets: { OPENAI_API_KEY: "   " },
    })).toBeNull();
  });
});
