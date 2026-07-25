import { describe, expect, test } from "bun:test";
import {
  createStoredZip,
  publicWikiAgentHtmlFallback,
  publicWikiGalleryItemFromMeta,
  publicWikiGalleryItemMatchesQuery,
  publicWikiMarkdownFull,
  publicWikiMarkdownIndex,
  publicWikiMarkdownPage,
  publicWikiMarkdownUrls,
  publicWikiPath,
  publicWikiRobotsTxt,
  publicWikiSitemapXml,
  UpstashPublicWikiStore,
  wikiExportFiles,
} from "./_shared.js";

const baseMeta = {
  publicId: "owner-repo-abc12345",
  published: true,
  owner: "owner",
  repo: "repo",
  title: "Repo Wiki",
  description: "A generated wiki",
  publishedAt: "2026-05-22T12:00:00.000Z",
  updatedAt: "2026-05-22T12:05:00.000Z",
  generatedAt: "2026-05-22T11:55:00.000Z",
  pageIds: ["overview"],
  wiki: {
    owner: "owner",
    repo: "repo",
    repoUrl: "https://github.com/owner/repo",
    model: "Grok CLI",
    wikiStyle: "first-30",
    structure: {
      title: "Repo Wiki",
      description: "A generated wiki",
      sections: [],
      pages: [{ id: "overview", title: "Overview", description: "Start here", filePaths: ["README.md"] }],
    },
    pages: {},
  },
};

describe("public wiki gallery visibility", () => {
  test("keeps private links out of the public gallery", () => {
    expect(publicWikiGalleryItemFromMeta({ ...baseMeta, visibility: "private" })).toBeNull();
    expect(publicWikiPath("private-abc123456789abcd123456789abcd1234", "private")).toBe(
      "/share/wiki/private-abc123456789abcd123456789abcd1234",
    );
  });

  test("keeps old public rows visible by default", () => {
    const item = publicWikiGalleryItemFromMeta(baseMeta);
    expect(item?.href).toBe("/public/wiki/owner-repo-abc12345");
    expect(item?.surface).toBe("wiki");
    expect(item?.repository).toBe("owner/repo");
  });

  test("routes documentation rows to the public docs surface", () => {
    const item = publicWikiGalleryItemFromMeta({
      ...baseMeta,
      publicId: "owner-repo-docs12345",
      title: "Repo Documentation",
      wiki: {
        ...baseMeta.wiki,
        wikiStyle: "documentation",
        structure: {
          ...baseMeta.wiki.structure,
          title: "Repo Documentation",
        },
      },
    });

    expect(item?.href).toBe("/public/docs/owner-repo-docs12345");
    expect(item?.surface).toBe("docs");
    expect(item?.format).toBe("documentation");
    expect(item?.formatLabel).toBe("Documentation");
  });

  test("matches public gallery rows by exact GitHub owner and repo", () => {
    const item = publicWikiGalleryItemFromMeta({
      ...baseMeta,
      publicId: "manaflow-ai-cmux-abc12345",
      owner: "manaflow-ai",
      repo: "cmux",
      title: "cmux Feature Scout Wiki",
      wiki: {
        ...baseMeta.wiki,
        owner: "manaflow-ai",
        repo: "cmux",
        repoUrl: "https://github.com/manaflow-ai/cmux",
      },
    });

    expect(publicWikiGalleryItemMatchesQuery(item, "manaflow-ai/cmux")).toBe(true);
    expect(publicWikiGalleryItemMatchesQuery(item, "manaflow ai cmux")).toBe(true);
    expect(publicWikiGalleryItemMatchesQuery(item, "other/cmux")).toBe(false);
  });

  test("builds an Obsidian markdown vault from a public snapshot", () => {
    const files = wikiExportFiles({
      ...baseMeta.wiki,
      branch: "main",
      generatedAt: baseMeta.generatedAt,
      pages: {
        overview: {
          id: "overview",
          content: "# Overview\n\nUse this repo.",
          generatedAt: baseMeta.generatedAt,
        },
      },
    });

    expect(files.map((file) => file.path)).toEqual([
      "owner-repo-wiki/README.md",
      "owner-repo-wiki/sources.md",
      "owner-repo-wiki/manifest.json",
      "owner-repo-wiki/.obsidian/app.json",
      "owner-repo-wiki/pages/01-overview.md",
    ]);
    expect(files[0].content).toContain("[[01-overview|Overview]]");
    expect(files[3].content).toContain("alwaysUpdateLinks");

    const zip = createStoredZip(files);
    expect(Buffer.from(zip.subarray(0, 4)).toString("hex")).toBe("504b0304");
    expect(Buffer.from(zip).toString("utf8")).toContain("owner-repo-wiki/pages/01-overview.md");
  });
});

describe("public wiki Markdown artifacts", () => {
  const snapshot = {
    ...baseMeta,
    visibility: "public",
    branch: "main",
    wiki: {
      ...baseMeta.wiki,
      branch: "main",
      runtimeModelLabel: "Codex CLI",
      pages: {
        overview: {
          id: "overview",
          content: "# Overview\n\nUse this repo.\n\nSources: [README.md:1-4]().",
          generatedAt: baseMeta.generatedAt,
        },
      },
    },
  };

  test("builds discoverable llms.txt links", () => {
    const urls = publicWikiMarkdownUrls("https://grok-wiki.com", snapshot);
    const index = publicWikiMarkdownIndex(snapshot, "https://grok-wiki.com");

    expect(urls.llmsPath).toBe("/public/wiki/owner-repo-abc12345/llms.txt");
    expect(urls.llmsFullPath).toBe("/public/wiki/owner-repo-abc12345/llms-full.txt");
    expect(index).toContain("# Repo Wiki");
    expect(index).toContain("Complete Markdown wiki");
    expect(index).toContain("/public/wiki/owner-repo-abc12345/pages/01-overview.md");
    expect(index).not.toContain("Loading wiki");
  });

  test("builds discoverable docs links for documentation snapshots", () => {
    const docsSnapshot = {
      ...snapshot,
      surface: "docs",
      wiki: {
        ...snapshot.wiki,
        wikiStyle: "documentation",
      },
    };
    const urls = publicWikiMarkdownUrls("https://grok-wiki.com", docsSnapshot);
    const index = publicWikiMarkdownIndex(docsSnapshot, "https://grok-wiki.com");
    const page = publicWikiMarkdownPage(docsSnapshot, "https://grok-wiki.com", "01-overview.md");

    expect(urls.canonicalPath).toBe("/public/docs/owner-repo-abc12345");
    expect(urls.llmsPath).toBe("/public/docs/owner-repo-abc12345/llms.txt");
    expect(index).toContain("Complete Markdown docs");
    expect(index).toContain("Human interactive docs");
    expect(page).toContain("Human docs: https://grok-wiki.com/public/docs/owner-repo-abc12345");
  });

  test("builds complete Markdown with page content and source files", () => {
    const markdown = publicWikiMarkdownFull(snapshot, "https://grok-wiki.com");

    expect(markdown).toContain("## 01. Overview");
    expect(markdown).toContain("Use this repo.");
    expect(markdown).toContain("`README.md`");
    expect(markdown).toContain("Runtime: Codex CLI");
  });

  test("builds per-page Markdown by page slug", () => {
    const markdown = publicWikiMarkdownPage(snapshot, "https://grok-wiki.com", "01-overview.md");

    expect(markdown).toContain("# Overview");
    expect(markdown).toContain("Complete Markdown: https://grok-wiki.com/public/wiki/owner-repo-abc12345/llms-full.txt");
  });

  test("injects a real agent-readable HTML fallback", () => {
    const html = publicWikiAgentHtmlFallback(snapshot, "https://grok-wiki.com");

    expect(html).toContain('data-agent-readable="true"');
    expect(html).toContain("Full Markdown");
    expect(html).toContain("/public/wiki/owner-repo-abc12345/llms-full.txt");
    expect(html).not.toContain("Use this repo.");
    expect(html).not.toContain("Loading wiki");
  });

  test("keeps generated Markdown out of the crawlable HTML fallback", () => {
    const html = publicWikiAgentHtmlFallback({
      ...snapshot,
      wiki: {
        ...snapshot.wiki,
        pages: {
          overview: {
            id: "overview",
            content: [
              "# Overview",
              "",
              '</pre><script type="application/ld+json">{"@type":"TechArticle"}</script><pre>',
            ].join("\n"),
            generatedAt: baseMeta.generatedAt,
          },
        },
      },
    }, "https://grok-wiki.com");

    const fallbackStart = html.indexOf('<section class="public-wiki-agent-markdown"');
    const fallbackHtml = html.slice(fallbackStart);

    expect(fallbackHtml).toContain("Full Markdown");
    expect(fallbackHtml).toContain("/public/wiki/owner-repo-abc12345/llms-full.txt");
    expect(fallbackHtml).not.toContain("<pre");
    expect(fallbackHtml).not.toContain('<script type="application/ld+json">');
    expect(fallbackHtml).not.toContain("&lt;script type=&quot;application/ld+json&quot;&gt;");
  });

  test("exposes every generated page link in the crawlable HTML fallback", () => {
    const pages = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => {
        const number = index + 1;
        return [
          `page-${number}`,
          {
            id: `page-${number}`,
            content: `# Page ${number}\n\nContent for page ${number}.`,
            generatedAt: baseMeta.generatedAt,
          },
        ];
      }),
    );
    const pageMetas = Array.from({ length: 14 }, (_, index) => {
      const number = index + 1;
      return {
        id: `page-${number}`,
        title: `Page ${number}`,
        description: `Page ${number} summary`,
        filePaths: [`src/page-${number}.ts`],
      };
    });

    const html = publicWikiAgentHtmlFallback({
      ...snapshot,
      wiki: {
        ...snapshot.wiki,
        structure: {
          ...snapshot.wiki.structure,
          pages: pageMetas,
        },
        pages,
      },
    }, "https://grok-wiki.com");

    const pageLinks = [...html.matchAll(/href="\/public\/wiki\/owner-repo-abc12345\/pages\/[^"]+"/g)];
    expect(pageLinks).toHaveLength(14);
    expect(html).toContain("/public/wiki/owner-repo-abc12345/pages/13-page-13.md");
    expect(html).toContain("/public/wiki/owner-repo-abc12345/pages/14-page-14.md");
  });

  test("builds crawl discovery files for public artifact routes only", () => {
    const robots = publicWikiRobotsTxt("https://grok-wiki.com/");
    const sitemap = publicWikiSitemapXml("https://grok-wiki.com/", [
      publicWikiGalleryItemFromMeta(baseMeta),
      publicWikiGalleryItemFromMeta({
        ...baseMeta,
        publicId: "owner-repo-docs12345",
        wiki: {
          ...baseMeta.wiki,
          wikiStyle: "documentation",
        },
      }),
      publicWikiGalleryItemFromMeta({ ...baseMeta, publicId: "private-abc123456789abcd123456789abcd1234", visibility: "private" }),
    ]);

    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Disallow: /share/wiki/");
    expect(robots).not.toContain("Disallow: /share/docs/");
    expect(robots).not.toContain("Disallow: /share/ask/");
    expect(robots).toContain("Sitemap: https://grok-wiki.com/sitemap.xml");
    expect(sitemap).toContain("<loc>https://grok-wiki.com/episodes</loc>");
    expect(sitemap).toContain("<loc>https://grok-wiki.com/public/wikis</loc>");
    expect(sitemap).toContain("<loc>https://grok-wiki.com/public/docs</loc>");
    expect(sitemap).toContain("<loc>https://grok-wiki.com/public/wiki/owner-repo-abc12345</loc>");
    expect(sitemap).toContain("<loc>https://grok-wiki.com/public/docs/owner-repo-docs12345</loc>");
    expect(sitemap).not.toContain("/share/wiki/");
    expect(sitemap).not.toContain("/share/docs/");
  });

  test("scans enough public artifact metadata for large sitemap inventories", async () => {
    let capturedMaxKeys = 0;
    class InventoryStore extends UpstashPublicWikiStore {
      async scanMetaKeys(maxKeys) {
        capturedMaxKeys = maxKeys;
        return [];
      }

      async loadMetas() {
        return [];
      }
    }

    const inventoryStore = new InventoryStore({ url: "https://redis.example", token: "token" });
    await inventoryStore.allPublicItems({ maxKeys: 50000 });

    expect(capturedMaxKeys).toBe(50000);
  });

  test("continues scanning public artifact metadata after eighty cursor batches", async () => {
    class CursorStore extends UpstashPublicWikiStore {
      constructor() {
        super({ url: "https://redis.example", token: "token" });
        this.calls = 0;
      }

      async command() {
        this.calls += 1;
        const cursor = this.calls < 90 ? String(this.calls) : "0";
        return [cursor, [`gw:public:item-${this.calls}:meta`]];
      }
    }

    const cursorStore = new CursorStore();
    const keys = await cursorStore.scanMetaKeys(200);

    expect(keys).toHaveLength(90);
  });
});
