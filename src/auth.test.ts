import { afterEach, describe, expect, test } from "bun:test";
import {
  ANON_SESSION_COOKIE,
  authenticateRequest,
  authMode,
  identityFromEmail,
} from "./auth.ts";

const originalAuthMode = process.env.AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
});

describe("authMode", () => {
  test("defaults to off", () => {
    delete process.env.AUTH_MODE;
    expect(authMode()).toBe("off");
  });
});

describe("AUTH_MODE=off anonymous sessions", () => {
  test("mints a stable per-browser identity and Set-Cookie", async () => {
    process.env.AUTH_MODE = "off";
    const first = await authenticateRequest(new Request("http://127.0.0.1/api/me"));
    expect(first).not.toBeNull();
    expect(first!.identity.authMode).toBe("off");
    expect(first!.identity.userId).toMatch(/^[a-f0-9]{32}$/);
    expect(first!.identity.email).toStartWith("anon-");
    expect(first!.setCookie).toContain(`${ANON_SESSION_COOKIE}=${first!.identity.userId}`);
    expect(first!.setCookie).toContain("HttpOnly");

    const second = await authenticateRequest(new Request("http://127.0.0.1/api/me", {
      headers: { cookie: `${ANON_SESSION_COOKIE}=${first!.identity.userId}` },
    }));
    expect(second!.identity.userId).toBe(first!.identity.userId);
    expect(second!.setCookie).toBeUndefined();
  });

  test("accepts x-rlm-wiki-anon-id for non-browser clients", async () => {
    process.env.AUTH_MODE = "off";
    const id = "0123456789abcdef0123456789abcdef";
    const result = await authenticateRequest(new Request("http://127.0.0.1/api/me", {
      headers: { "x-rlm-wiki-anon-id": id },
    }));
    expect(result!.identity.userId).toBe(id);
    expect(result!.setCookie).toBeUndefined();
  });

  test("does not collapse every visitor into one shared email tenant", async () => {
    process.env.AUTH_MODE = "off";
    const a = await authenticateRequest(new Request("http://127.0.0.1/a"));
    const b = await authenticateRequest(new Request("http://127.0.0.1/b"));
    expect(a!.identity.userId).not.toBe(b!.identity.userId);
    expect(a!.identity.email).not.toBe("local@rlm-wiki.dev");
  });
});

describe("identityFromEmail", () => {
  test("hashes email into a stable userId", () => {
    const a = identityFromEmail("You@Example.com", "dev");
    const b = identityFromEmail("you@example.com", "dev");
    expect(a.email).toBe("you@example.com");
    expect(a.userId).toBe(b.userId);
    expect(a.userId).toHaveLength(32);
  });
});
