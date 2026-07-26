import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexHtml = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");

describe("provider keys UI privacy contract", () => {
  test("uses a single browser-local save model (no session/device toggle)", () => {
    expect(indexHtml).not.toContain('data-provider-secret-scope="session"');
    expect(indexHtml).not.toContain('data-provider-secret-scope="device"');
    expect(indexHtml).not.toContain("Save to device");
    expect(indexHtml).not.toContain("Save for session");
    expect(indexHtml).not.toContain("Remembered on device");
    expect(indexHtml).not.toContain("Session key saved");
    expect(indexHtml).toContain("Save");
    expect(indexHtml).toContain("Local only.");
    expect(indexHtml).toContain("We do not save them to your account or our database.");
    expect(indexHtml).toContain("Browser-local · not stored on our servers · clear anytime");
  });

  test("stores keys only under the browser-local provider-secret prefix", () => {
    expect(indexHtml).toContain("rlm-wiki:provider-secret:");
    expect(indexHtml).toContain("localStorage");
    // Saves go to localStorage; legacy session keys are still readable for migration.
    expect(indexHtml).toMatch(/function setProviderSecret[\s\S]*localStorage/);
    expect(indexHtml).toMatch(/function getProviderSecret[\s\S]*getProviderDeviceSecret[\s\S]*getProviderSessionSecret/);
  });

  test("attaches providerSecrets only on outbound run requests, not as a server-side store API", () => {
    expect(indexHtml).toContain("function providerSecretsPayload()");
    expect(indexHtml).toContain("function withProviderSecrets(body)");
    expect(indexHtml).toContain("postJSONWithSecrets");
    // No dedicated "upload keys" / account vault endpoint in the UI.
    expect(indexHtml).not.toMatch(/\/api\/provider-keys/);
    expect(indexHtml).not.toMatch(/\/api\/secrets\/store/);
    expect(indexHtml).not.toMatch(/saveKeysToServer/);
  });

  test("top nav labels keys simply without BYOK jargon", () => {
    expect(indexHtml).toMatch(/id="provider-keys-btn"[^>]*>Keys</);
    expect(indexHtml).toContain("Keys (${count})");
    expect(indexHtml).toContain("Ready in this browser");
  });
});

describe("code surface GitHub connect-first gate", () => {
  test("Code page requires GitHub connection before run, same as Review", () => {
    expect(indexHtml).toContain('id="code-github-gate"');
    expect(indexHtml).toContain('id="code-github-connect"');
    expect(indexHtml).toContain("/api/github/status");
    expect(indexHtml).toContain("/api/github/connect");
    expect(indexHtml).toContain("Connect GitHub before running Code Anything");
    expect(indexHtml).toContain("Connect GitHub before publishing a pull request");
  });
});

describe("model picker key sync", () => {
  test("menu items gate on browser keys and drop access/session chips", () => {
    expect(indexHtml).toContain("function channelConfiguredForBrowser");
    expect(indexHtml).toContain("function ensureSelectedChannelHasKey");
    expect(indexHtml).toContain("channelConfiguredForBrowser(c)");
    expect(indexHtml).not.toContain("channel-setup-chip ready\">session");
    expect(indexHtml).not.toContain("channel-setup-chip\">access");
    expect(indexHtml).not.toContain("· session key");
    expect(indexHtml).not.toContain("Using a session key from this browser");
  });
});
