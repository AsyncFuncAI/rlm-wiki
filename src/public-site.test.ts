import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Web product surface only (root public/).
 * Desktop marketing lives under apps/desktop/marketing/ and is tested separately
 * when that private tree is present (monorepo only).
 */
const marketingRoot = join(import.meta.dirname, "../apps/desktop/marketing");
const hasDesktopMarketing = existsSync(join(marketingRoot, "index.html"));

describe("rlm-wiki web product surface", () => {
  type VercelHeaderRule = {
    source: string;
    headers: Array<{ key: string; value: string }>;
  };

  test("product SPA exposes Wiki Ask Code Review and browser-local Keys", async () => {
    const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();

    expect(html).toContain('<title>rlm-wiki</title>');
    expect(html).toContain('data-topbar-route="wikis"');
    expect(html).toContain('data-topbar-route="ask"');
    expect(html).toContain('data-topbar-route="code"');
    expect(html).toContain('data-topbar-route="review"');
    expect(html).toContain('id="provider-keys-btn"');
    expect(html).toContain(">Keys<");
    expect(html).not.toContain(">BYOK<");
    expect(html).toContain('class="hero-video"');
    expect(html).toContain("cloudfront.net");
  });

  test("web Vite config never builds desktop marketing into index", async () => {
    const viteConfig = await Bun.file(new URL("../vite.web.config.ts", import.meta.url)).text();

    expect(viteConfig).toContain('index: join(publicRoot, "index.html")');
    expect(viteConfig).toContain("public-ask");
    expect(viteConfig).toContain("public-wiki");
    expect(viteConfig).not.toContain("episodes.html");
    expect(viteConfig).not.toContain("changelog.html");
    // Minify may rewrite index in place; marketing must never be the source.
    expect(viteConfig).not.toContain("landingHtml");
    expect(viteConfig).not.toContain("rlm-wiki.html");
    expect(viteConfig).toContain("Product SPA only");
  });

  test("vercel config is product-only (no marketing film routes)", async () => {
    const config = JSON.parse(await Bun.file(new URL("../vercel.json", import.meta.url)).text()) as {
      redirects: Array<{ source: string; destination?: string }>;
      headers: VercelHeaderRule[];
      rewrites: Array<{ source: string }>;
    };

    expect(config.redirects).toEqual(
      expect.arrayContaining([
        { source: "/index.html", destination: "/", permanent: true },
      ]),
    );
    expect(config.redirects.some((r) => r.source.includes("episodes"))).toBe(false);
    expect(config.redirects.some((r) => r.source.includes("changelog"))).toBe(false);
    expect(config.rewrites.some((r) => r.source === "/episodes")).toBe(false);
    expect(config.rewrites.some((r) => r.source === "/changelog")).toBe(false);

    expect(config.headers).toEqual(
      expect.arrayContaining([
        {
          source: "/public-wiki-gallery.html",
          headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
        },
        {
          source: "/public-wiki.html",
          headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
        },
        {
          source: "/public-ask.html",
          headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }],
        },
      ]),
    );
  });
});

describe.skipIf(!hasDesktopMarketing)("desktop marketing boundary", () => {
  test("marketing homepage lives under apps/desktop/marketing only", () => {
    const marketingIndex = join(marketingRoot, "index.html");
    const html = readFileSync(marketingIndex, "utf8");

    expect(html).toContain("hero");
    expect(html.length).toBeGreaterThan(50_000);

    // Must not sit in web product public/ anymore
    const webPublic = join(import.meta.dirname, "../public");
    expect(() => readFileSync(join(webPublic, "rlm-wiki.html"), "utf8")).toThrow();
    expect(() => readFileSync(join(webPublic, "episodes.html"), "utf8")).toThrow();
    expect(() => readFileSync(join(webPublic, "changelog.html"), "utf8")).toThrow();
  });

  test("marketing README documents the hard boundary", () => {
    const readme = readFileSync(join(marketingRoot, "README.md"), "utf8");
    expect(readme).toContain("apps/desktop/marketing/");
    expect(readme).toContain("public/index.html");
    expect(readme).toContain("Never");
  });
});
