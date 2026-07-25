import { describe, expect, test } from "bun:test";
import { isZoomableDiagram, renderCodeViewer } from "./ui/markdown-renderer.ts";
import {
  createPublicWikiSnapshot,
  makePrivateWikiId,
  publicWikiPathForSurface,
  normalizePublicWikiVisibility,
  publicWikiPath,
  publicWikiPublicationFromSnapshot,
  sanitizePublicWikiRecord,
} from "./public-wiki.ts";
import { publicAgentPrompt } from "./public-agent-prompt.ts";

const record = {
  id: "wiki-test",
  repoUrl: "/Users/sheing/private/repo",
  owner: "local",
  repo: "repo",
  branch: null,
  generatedAt: "2026-05-20T12:00:00.000Z",
  model: "grok-cli",
  wikiStyle: "first-30",
  wikiStylePrompt: "private custom prompt",
  structure: {
    title: "Local Repo Wiki",
    description: "A generated wiki",
    sections: [{ id: "start", title: "Start", pages: ["overview"], subsections: [] }],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "Start here",
        importance: "high",
        filePaths: ["README.md", "/Users/sheing/private/repo/.env", "../secret.txt"],
        relatedPages: [],
      },
    ],
  },
  pages: {
    overview: {
      id: "overview",
      content: "Public content",
      generatedAt: "2026-05-20T12:00:00.000Z",
      sessionId: "private-session",
      stylePrompt: "private page prompt",
      tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    },
  },
};

describe("public wiki snapshots", () => {
  test("removes private prompts, run metadata, and absolute local paths", () => {
    const sanitized = sanitizePublicWikiRecord(record);

    expect(sanitized.repoUrl).toBe("");
    expect(sanitized.wikiStylePrompt).toBeUndefined();
    expect(sanitized.structure.pages[0]?.filePaths).toEqual(["README.md"]);
    expect(sanitized.pages.overview?.content).toBe("Public content");
    expect(sanitized.pages.overview?.sessionId).toBeUndefined();
    expect(sanitized.pages.overview?.stylePrompt).toBeUndefined();
    expect(sanitized.pages.overview?.tokenUsage).toBeUndefined();
  });

  test("creates a read-only snapshot with stable public metadata", () => {
    const snapshot = createPublicWikiSnapshot({
      publicId: "local-repo-abc12345",
      record,
      publishedAt: "2026-05-21T01:00:00.000Z",
      updatedAt: "2026-05-21T01:05:00.000Z",
    });

    expect(snapshot.publicId).toBe("local-repo-abc12345");
    expect(snapshot.published).toBe(true);
    expect(snapshot.visibility).toBe("public");
    expect(snapshot.surface).toBe("wiki");
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.wiki.pages.overview?.content).toBe("Public content");
  });

  test("publishes documentation snapshots under the public docs surface", () => {
    const docsRecord = {
      ...record,
      id: "docs-test",
      wikiStyle: "documentation",
      structure: {
        ...record.structure,
        title: "Local Repo Documentation",
      },
    };
    const snapshot = createPublicWikiSnapshot({
      publicId: "local-repo-docs12345",
      record: docsRecord,
      publishedAt: "2026-05-21T01:00:00.000Z",
    });
    const publication = publicWikiPublicationFromSnapshot(snapshot, "https://grok-wiki.com");

    expect(snapshot.surface).toBe("docs");
    expect(publicWikiPathForSurface(snapshot.publicId, snapshot.visibility, snapshot.surface)).toBe("/public/docs/local-repo-docs12345");
    expect(publication.publicPath).toBe("/public/docs/local-repo-docs12345");
    expect(publication.publicUrl).toBe("https://grok-wiki.com/public/docs/local-repo-docs12345");
    expect(publication.surface).toBe("docs");
  });

  test("supports opaque private-link snapshots", () => {
    const publicId = makePrivateWikiId();
    const snapshot = createPublicWikiSnapshot({
      publicId,
      record,
      visibility: "private",
    });

    expect(publicId).toMatch(/^private-[a-f0-9]{32}$/);
    expect(snapshot.visibility).toBe("private");
    expect(publicWikiPath(publicId, snapshot.visibility)).toBe(`/share/wiki/${publicId}`);
    expect(publicWikiPublicationFromSnapshot(snapshot, "https://grok-wiki.com").publicUrl).toBe(`https://grok-wiki.com/share/wiki/${publicId}`);
    expect(normalizePublicWikiVisibility("anything else")).toBe("public");
  });
});

describe("public wiki diagram zoom contracts", () => {
  test("marks ASCII diagrams as zoomable code viewers", () => {
    const ascii = [
      "+-------------+      +------------+",
      "| desktop app | ---> | public web |",
      "+-------------+      +------------+",
    ].join("\n");

    expect(isZoomableDiagram(ascii, "text")).toBe(true);
    expect(
      renderCodeViewer(ascii, "text", false, {
        escape: escapeHtml,
        icon: () => "",
      }),
    ).toContain("data-diagram-code=");
  });

  test("copies rendered code blocks without opening diagram zoom", async () => {
    const source = await Bun.file(new URL("../public/public-wiki.ts", import.meta.url)).text();
    const readerStyles = await Bun.file(new URL("./ui/styles.css", import.meta.url)).text();

    expect(source).toContain('target.closest<HTMLElement>("[data-code-viewer-copy]")');
    expect(source).toContain("async function copyCodeViewer");
    expect(source).toContain("await copyText(code)");
    expect(source).toContain("codeViewerCopyResetTimers");
    expect(source).toContain("copy: '<rect");
    expect(readerStyles).toContain(".code-viewer-copy");
  });
});

describe("public wiki page shell", () => {
  test("surfaces GitHub and Obsidian download actions", async () => {
    const source = await Bun.file(new URL("../public/public-wiki.ts", import.meta.url)).text();

    expect(source).toContain("public-wiki-repo-pill");
    expect(source).toContain('target="_blank"');
    expect(source).toContain("/api/public/wiki-export");
    expect(source).toContain('brandIcon("obsidian")');
    expect(source).toContain("Add Agent");
    expect(source).toContain('workspaceKind: docs ? "docs" : "wiki"');
    expect(source).toContain("resolveDocsPageHref: context?.resolveDocsPageHref");
  });

  test("surfaces a scoped Add Agent popover without rerendering the wiki reader", async () => {
    const source = await Bun.file(new URL("../public/public-wiki.ts", import.meta.url)).text();
    const css = await Bun.file(new URL("../public/public-wiki.css", import.meta.url)).text();

    expect(source).toContain('class="public-wiki-cta public-wiki-agent-button"');
    expect(source).toContain("type=\"button\"");
    expect(source).toContain("data-public-agent-open");
    expect(source).not.toContain('href="/" title="Add Grok-Wiki agent"');
    expect(source).toContain("publicAgentPopoverHost");
    expect(source).toContain("copyPublicAgentPrompt");
    expect(source).toContain("publicAgentPrompt(");
    expect(css).toContain(".public-wiki-agent-button");
    expect(css).toContain(".public-agent-popover");
    expect(css).toContain("public-agent-popover-in");
  });

  test("public docs tabs switch and hydrate without rerendering the reader", async () => {
    const source = await Bun.file(new URL("../public/public-wiki.ts", import.meta.url)).text();
    const handlerBody = source.match(/function activateDocsKitTab\(tab: Element, focus = true\): void \{([\s\S]*?)\n\}/)?.[1] || "";
    const keyboardBody = source.match(/function handleDocsKitTabKeydown\(event: KeyboardEvent, tab: HTMLElement\): boolean \{([\s\S]*?)\n\}/)?.[1] || "";

    expect(source).toContain('target.closest<HTMLElement>("[data-doc-tab]")');
    expect(source).toContain("function hydrateDocsKitTabPanel");
    expect(source).toContain("function publicDocsMarkdownContext");
    expect(source).toContain("resolveDocsPageLink(currentWiki, href, label)");
    expect(handlerBody).toContain('rootNode.querySelectorAll<HTMLElement>("[data-doc-tab]")');
    expect(handlerBody).toContain('rootNode.querySelectorAll<HTMLElement>("[data-doc-tab-panel]")');
    expect(handlerBody).toContain("hydrateDocsKitTabPanel(panel)");
    expect(handlerBody).toContain('panel.toggleAttribute("hidden", !active)');
    expect(handlerBody).not.toContain("render()");
    expect(keyboardBody).toContain('event.key === "ArrowRight"');
    expect(keyboardBody).toContain('event.key === "ArrowLeft"');
    expect(keyboardBody).toContain('event.key === "Home"');
    expect(keyboardBody).toContain('event.key === "End"');
    expect(keyboardBody).toContain("activateDocsKitTab(tabs[nextIndex])");
    expect(keyboardBody).not.toContain("render()");
  });

  test("public docs reader owns text selection contrast in light mode", async () => {
    const css = await Bun.file(new URL("./ui/styles.css", import.meta.url)).text();

    expect(css).toContain(".docs-reader-layout::selection");
    expect(css).toContain(".docs-reader-layout ::selection");
    expect(css).toContain(".docs-reader-layout::-moz-selection");
    expect(css).toContain(".docs-reader-layout ::-moz-selection");
    expect(css).toContain("--wiki-selection-bg: rgba(47, 119, 159, 0.24)");
    expect(css).toContain("--wiki-selection-text: rgba(13, 31, 43, 0.96)");
  });

  test("exposes agent-readable Markdown routes and fallback", async () => {
    const pageSource = await Bun.file(new URL("../api/public/wiki-page.js", import.meta.url)).text();
    const galleryPageSource = await Bun.file(new URL("../api/public/wiki-gallery-page.js", import.meta.url)).text();
    const sitemapSource = await Bun.file(new URL("../api/sitemap.js", import.meta.url)).text();
    const robotsSource = await Bun.file(new URL("../api/robots.js", import.meta.url)).text();
    const vercelConfig = await Bun.file(new URL("../vercel.json", import.meta.url)).json();
    const rewriteSources = vercelConfig.rewrites.map((rewrite: { source: string }) => rewrite.source);
    const rewriteDestinations = vercelConfig.rewrites.map((rewrite: { destination: string }) => rewrite.destination);

    expect(pageSource).toContain("x-llms-txt");
    expect(pageSource).toContain('"vary", "Accept"');
    expect(pageSource).toContain("publicWikiAgentHtmlFallback");
    expect(pageSource).toContain("<title>${escapeHtml(htmlTitle)}</title>");
    expect(pageSource).toContain("Grok Docs");
    expect(pageSource).toContain("Markdown ${artifact}");
    expect(pageSource).toContain('application/ld+json');
    expect(pageSource).toContain('type="text/markdown"');
    expect(galleryPageSource).toContain("data-public-gallery-fallback");
    expect(galleryPageSource).toContain("store.allPublicItems");
    expect(galleryPageSource).toContain("gallerySeo(baseUrl, surface)");
    expect(sitemapSource).toContain("publicWikiSitemapXml");
    expect(robotsSource).toContain("publicWikiRobotsTxt");
    expect(rewriteSources).toContain("/robots.txt");
    expect(rewriteSources).toContain("/sitemap.xml");
    expect(rewriteSources).toContain("/public/docs");
    expect(rewriteSources).toContain("/public/docs/:id");
    expect(rewriteSources).toContain("/public/docs/:id/llms.txt");
    expect(rewriteSources).toContain("/public/docs/:id/llms-full.txt");
    expect(rewriteSources).toContain("/public/docs/:id/pages/:page");
    expect(rewriteSources).toContain("/share/docs/:id/llms.txt");
    expect(rewriteSources).toContain("/public/wiki/:id/llms.txt");
    expect(rewriteSources).toContain("/public/wiki/:id/llms-full.txt");
    expect(rewriteSources).toContain("/public/wiki/:id/pages/:page");
    expect(rewriteSources).toContain("/share/wiki/:id/llms.txt");
    expect(rewriteDestinations).toContain("/api/public/wiki-gallery-page");
  });

  test("desktop public gallery lookup proxies through the configured public site base URL", async () => {
    const serverSource = await Bun.file(new URL("./server.ts", import.meta.url)).text();

    expect(serverSource).toContain('url.pathname === "/api/wiki/public-gallery"');
    expect(serverSource).toContain("publicGallerySearchUrl(url, baseUrl)");
    expect(serverSource).toContain("publicSiteBaseUrl()");
    expect(serverSource).toContain("publicGalleryAbsoluteUrl(baseUrl");
    expect(serverSource).toContain("Could not reach the public gallery. Try again when your connection is steadier.");
  });
});

describe("public wiki agent handoff prompt", () => {
  test("keeps agent context narrow, provider-agnostic, and source-grounded", () => {
    const prompt = publicAgentPrompt({
      artifactLabel: "wiki",
      title: "Owner Repo Wiki",
      description: "Source-grounded architecture notes.",
      pageUrl: "https://grok-wiki.com/public/wiki/owner-repo-abc12345",
      llmsUrl: "https://grok-wiki.com/public/wiki/owner-repo-abc12345/llms.txt",
      llmsFullUrl: "https://grok-wiki.com/public/wiki/owner-repo-abc12345/llms-full.txt",
      markdownUrl: "https://grok-wiki.com/public/wiki/owner-repo-abc12345.md",
      repository: "owner/repo",
      repoUrl: "https://github.com/owner/repo",
      branch: "main",
      pageCount: 7,
      updatedAt: "2026-05-30T12:00:00.000Z",
    });

    expect(prompt).toContain("Agent index (read first): https://grok-wiki.com/public/wiki/owner-repo-abc12345/llms.txt");
    expect(prompt).toContain("Fetch the smallest relevant page");
    expect(prompt).toContain("Keep provider-specific assumptions out of your plan");
    expect(prompt).toContain("read-only generated snapshot");
  });

  test("can describe public docs without wiki-only wording", () => {
    const prompt = publicAgentPrompt({
      artifactLabel: "docs",
      title: "Owner Repo Documentation",
      pageUrl: "https://grok-wiki.com/public/docs/owner-repo-docs12345",
      llmsUrl: "https://grok-wiki.com/public/docs/owner-repo-docs12345/llms.txt",
      llmsFullUrl: "https://grok-wiki.com/public/docs/owner-repo-docs12345/llms-full.txt",
      markdownUrl: "https://grok-wiki.com/public/docs/owner-repo-docs12345.md",
      repository: "owner/repo",
    });

    expect(prompt).toContain("Use these Grok-Wiki docs as source-grounded context");
    expect(prompt).toContain("Docs: Owner Repo Documentation");
    expect(prompt).toContain("whole-docs context");
    expect(prompt).toContain("Treat these docs as a read-only generated snapshot");
  });
});

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
