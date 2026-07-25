import { describe, expect, test } from "bun:test";
import handler from "./wiki-gallery-page.js";
import { renderGalleryPageHtml } from "./wiki-gallery-page.js";

describe("public wiki gallery page SEO", () => {
  test("renders indexable collection metadata and item list schema", async () => {
    const shell = await Bun.file(new URL("../../public/public-wiki-gallery.html", import.meta.url)).text();
    const html = renderGalleryPageHtml({
      baseUrl: "https://rlmwiki.deepascii.com",
      shell,
      surface: "docs",
      items: [
        {
          href: "/public/docs/owner-repo-docs12345",
          title: "Repo Documentation",
          description: "Source-grounded technical docs for the repo.",
          repository: "owner/repo",
          owner: "owner",
          repo: "repo",
          pages: 4,
          sourceFiles: 12,
          surface: "docs",
          updatedAt: "2026-06-19T12:00:00.000Z",
        },
      ],
    });

    expect(html).toContain("<title>Public docs - rlm-wiki</title>");
    expect(html).toContain('<link rel="canonical" href="https://rlmwiki.deepascii.com/public/docs" />');
    expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large" />');
    expect(html).toContain('href="/public/docs/owner-repo-docs12345"');

    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(jsonLdMatch).toBeTruthy();

    const jsonLd = JSON.parse(jsonLdMatch?.[1] || "{}");
    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Public docs - rlm-wiki",
      url: "https://rlmwiki.deepascii.com/public/docs",
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 1,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            url: "https://rlmwiki.deepascii.com/public/docs/owner-repo-docs12345",
            name: "Repo Documentation",
            description: "Source-grounded technical docs for the repo.",
          },
        ],
      },
    });
  });

  test("falls back to an embedded shell when the legacy shell URL redirects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 308, headers: { location: "/public/wikis" } });

    try {
      const headers = {};
      let statusCode = 0;
      let body = "";
      const req = {
        method: "GET",
        query: {},
        headers: {
          host: "rlmwiki.deepascii.com",
          "x-forwarded-proto": "https",
        },
      };
      const res = {
        setHeader(key, value) {
          headers[key.toLowerCase()] = value;
        },
        status(code) {
          statusCode = code;
          return {
            send(value) {
              body = String(value || "");
            },
            end() {},
          };
        },
      };

      await handler(req, res);

      expect(statusCode).toBe(200);
      expect(headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(body).toContain('<link rel="canonical" href="https://rlmwiki.deepascii.com/public/wikis" />');
      expect(body).toContain('"@type":"CollectionPage"');
      expect(body).toContain('data-public-gallery-fallback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
