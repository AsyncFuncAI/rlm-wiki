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
