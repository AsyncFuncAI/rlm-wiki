import { afterEach, describe, expect, test } from "bun:test";
import {
  hasProviderSecrets,
  hasRequestProviderCredentials,
  normalizeProviderSecrets,
  providerRequiredSecretKeys,
  providerSecretsForProviderEnv,
  redactProviderSecrets,
  requestSecretValue,
  secretValue,
} from "./provider-secrets.ts";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("normalizeProviderSecrets", () => {
  test("keeps only known non-empty secret keys and trims values", () => {
    const secrets = normalizeProviderSecrets({
      OPENAI_API_KEY: "  sk-test  ",
      GEMINI_API_KEY: "",
      ANTHROPIC_API_KEY: "   ",
      NOT_A_SECRET: "should-drop",
      OPENAI_API_KEY_EXTRA: "nope",
      nested: { OPENAI_API_KEY: "ignored" },
    });
    expect(secrets).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  test("ignores non-objects and non-string values", () => {
    expect(normalizeProviderSecrets(null)).toEqual({});
    expect(normalizeProviderSecrets("OPENAI_API_KEY")).toEqual({});
    expect(normalizeProviderSecrets({ OPENAI_API_KEY: 123 })).toEqual({});
    expect(normalizeProviderSecrets([{ OPENAI_API_KEY: "sk-x" }])).toEqual({});
  });
});

describe("request vs process env secret resolution", () => {
  test("requestSecretValue never falls back to process env", () => {
    process.env.OPENAI_API_KEY = "from-env";
    expect(requestSecretValue({}, "OPENAI_API_KEY")).toBeUndefined();
    expect(requestSecretValue({ OPENAI_API_KEY: "from-request" }, "OPENAI_API_KEY")).toBe("from-request");
  });

  test("secretValue can fall back to process env for local/dev tooling", () => {
    process.env.GEMINI_API_KEY = "env-gemini";
    expect(secretValue({}, "GEMINI_API_KEY")).toBe("env-gemini");
    expect(secretValue({ GEMINI_API_KEY: "req-gemini" }, "GEMINI_API_KEY")).toBe("req-gemini");
  });

  test("BYOK readiness uses request secrets only", () => {
    process.env.OPENAI_API_KEY = "env-only";
    expect(hasRequestProviderCredentials("openai", {})).toBe(false);
    expect(hasRequestProviderCredentials("openai", { OPENAI_API_KEY: "req" })).toBe(true);
  });

  test("cloudflare requires both token and account id from the request", () => {
    expect(hasRequestProviderCredentials("cloudflare", {
      CLOUDFLARE_API_TOKEN: "token",
    })).toBe(false);
    expect(hasRequestProviderCredentials("cloudflare", {
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    })).toBe(true);
  });
});

describe("providerSecretsForProviderEnv", () => {
  test("scopes env injection to the selected provider only", () => {
    const secrets = normalizeProviderSecrets({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      GEMINI_API_KEY: "gemini",
    });
    expect(providerSecretsForProviderEnv("openai", secrets)).toEqual({
      OPENAI_API_KEY: "sk-openai",
    });
    expect(providerSecretsForProviderEnv("anthropic", secrets)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(providerSecretsForProviderEnv("codex", secrets)).toEqual({});
  });

  test("does not pull process env when includeProcessEnv is false", () => {
    process.env.OPENAI_API_KEY = "env-openai";
    expect(providerSecretsForProviderEnv("openai", {}, false)).toEqual({});
    expect(providerSecretsForProviderEnv("openai", {}, true)).toEqual({
      OPENAI_API_KEY: "env-openai",
    });
  });
});

describe("redactProviderSecrets", () => {
  test("redacts nested providerSecrets and known secret field names", () => {
    const leaked = {
      question: "how does auth work?",
      providerSecrets: {
        OPENAI_API_KEY: "sk-live-secret",
        GEMINI_API_KEY: "AIza-secret",
      },
      OPENAI_API_KEY: "sk-top-level",
      events: [
        {
          type: "tool",
          OPENAI_API_KEY: "sk-in-event",
          payload: { ANTHROPIC_API_KEY: "sk-ant", ok: true },
        },
      ],
      safe: "visible",
    };

    const redacted = redactProviderSecrets(leaked) as Record<string, unknown>;
    expect(redacted.safe).toBe("visible");
    expect(redacted.question).toBe("how does auth work?");
    expect(redacted.providerSecrets).toBe("[redacted]");
    expect(redacted.OPENAI_API_KEY).toBe("[redacted]");

    const events = redacted.events as Array<Record<string, unknown>>;
    expect(events[0]?.OPENAI_API_KEY).toBe("[redacted]");
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.ANTHROPIC_API_KEY).toBe("[redacted]");
    expect(payload.ok).toBe(true);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("AIza-secret");
    expect(serialized).not.toContain("sk-top-level");
    expect(serialized).not.toContain("sk-in-event");
    expect(serialized).not.toContain("sk-ant");
  });

  test("leaves non-secret structures untouched", () => {
    expect(redactProviderSecrets("hello")).toBe("hello");
    expect(redactProviderSecrets(42)).toBe(42);
    expect(redactProviderSecrets(null)).toBeNull();
    expect(redactProviderSecrets(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("provider secret catalog", () => {
  test("required keys cover BYOK providers and exclude local CLI codex", () => {
    expect(providerRequiredSecretKeys("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(providerRequiredSecretKeys("cloudflare")).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]);
    expect(providerRequiredSecretKeys("codex")).toEqual([]);
  });

  test("hasProviderSecrets is false for empty normalized payloads", () => {
    expect(hasProviderSecrets(undefined)).toBe(false);
    expect(hasProviderSecrets({})).toBe(false);
    expect(hasProviderSecrets({ OPENAI_API_KEY: "x" })).toBe(true);
  });
});
