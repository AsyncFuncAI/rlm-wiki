import { describe, expect, test } from "bun:test";

describe("public landing SEO", () => {
  type VercelRouteRule = {
    source: string;
    destination?: string;
    permanent?: boolean;
    has?: unknown;
  };

  type VercelHeaderRule = {
    source: string;
    headers: Array<{ key: string; value: string }>;
  };

  test("canonicalizes crawlable static marketing routes", async () => {
    const pages = [
      ["../public/grok-wiki.html", "https://grok-wiki.com/"],
      ["../public/episodes.html", "https://grok-wiki.com/episodes"],
      ["../public/changelog.html", "https://grok-wiki.com/changelog"],
    ];

    for (const [path, canonicalUrl] of pages) {
      const html = await Bun.file(new URL(path, import.meta.url)).text();

      expect(html).toContain(`<link rel="canonical" href="${canonicalUrl}" />`);
      expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large" />');
    }
  });

  test("exposes answer-ready homepage structured data", async () => {
    const html = await Bun.file(new URL("../public/grok-wiki.html", import.meta.url)).text();
    const jsonLd = Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g), ([, raw]) => JSON.parse(raw));
    const nodes = jsonLd.flatMap((value) => Array.isArray(value["@graph"]) ? value["@graph"] : [value]);

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "SoftwareApplication",
          name: "Grok-Wiki",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "macOS",
        }),
        expect.objectContaining({
          "@type": "FAQPage",
          mainEntity: expect.arrayContaining([
            expect.objectContaining({
              name: "Why use Grok-Wiki instead of just Codex, Claude Code, Grok, or ChatGPT?",
            }),
            expect.objectContaining({
              name: "How does Grok-Wiki keep the wiki grounded in the source?",
            }),
            expect.objectContaining({
              name: "Can another agent use a Grok-Wiki page after it is generated?",
            }),
          ]),
        }),
      ]),
    );
  });

  test("canonicalizes duplicate host and keeps static shells noindex", async () => {
    const config = JSON.parse(await Bun.file(new URL("../vercel.json", import.meta.url)).text()) as {
      redirects: VercelRouteRule[];
      headers: VercelHeaderRule[];
    };

    expect(config.redirects).toContainEqual({
      source: "/",
      has: [{ type: "host", value: "www.grok-wiki.com" }],
      destination: "https://grok-wiki.com/",
      permanent: true,
    });

    expect(config.redirects).toEqual(
      expect.arrayContaining([
        {
          source: "/:path*",
          has: [{ type: "host", value: "www.grok-wiki.com" }],
          destination: "https://grok-wiki.com/:path*",
          permanent: true,
        },
        {
          source: "/grok-wiki.html",
          destination: "/",
          permanent: true,
        },
        {
          source: "/index.html",
          destination: "/",
          permanent: true,
        },
        {
          source: "/episodes.html",
          destination: "/episodes",
          permanent: true,
        },
        {
          source: "/changelog.html",
          destination: "/changelog",
          permanent: true,
        },
      ]),
    );

    expect(config.redirects.filter((redirect) => redirect.source === "/public-wiki-gallery.html")).toHaveLength(0);
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

  test("gives every landing video a crawlable thumbnail poster", async () => {
    const html = await Bun.file(new URL("../public/grok-wiki.html", import.meta.url)).text();
    const videoTags = Array.from(html.matchAll(/<video\b[^>]*>/g), ([tag]) => tag);

    expect(videoTags.length).toBeGreaterThan(0);
    for (const tag of videoTags) {
      expect(tag).toContain('poster="https://grok-wiki.com/');
    }
    expect(html).toContain('poster="https://grok-wiki.com/episodes/grok-wiki-ep1-poster.jpg"');
  });

  test("includes the Grok-Wiki FAQ with onboarding contact and hardware artwork", async () => {
    const html = await Bun.file(new URL("../public/grok-wiki.html", import.meta.url)).text();

    expect(html).toContain('id="faq"');
    expect(html).toContain("Frequently Asked Questions");
    expect(html).toContain("https://calendly.com/asyncfunc/grok-wiki-onboarding");
    expect(html).toContain("./editorial/grok-wiki-faq-90s-hardware.webp");
    expect(html).toContain("Why use Grok-Wiki instead of just Codex, Claude Code, Grok, or ChatGPT?");
    expect(html).toContain("How does Grok-Wiki keep the wiki grounded in the source?");
    expect(html).toContain("What happens when I publish a wiki?");
    expect(html).toContain("Can another agent use a Grok-Wiki page after it is generated?");
    expect(html).toContain("What kinds of repositories are a good fit?");

    const faqStart = html.indexOf('<section class="faq-section"');
    const faqEnd = html.indexOf("</section>", faqStart);
    const faqHtml = html.slice(faqStart, faqEnd);
    expect((faqHtml.match(/<details class="faq-item"/g) || []).length).toBe(8);
    expect(faqHtml).not.toContain("BYOK");
    expect(faqHtml).not.toContain("BYOC");
  });
});
