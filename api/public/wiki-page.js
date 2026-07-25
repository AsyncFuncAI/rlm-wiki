import {
  UpstashPublicWikiStore,
  escapeHtml,
  errorMessage,
  errorStatus,
  normalizePublicWikiId,
  plainText,
  publicWikiBaseUrl,
  publicWikiAgentHtmlFallback,
  publicWikiMarkdownFileName,
  publicWikiMarkdownFull,
  publicWikiMarkdownUrls,
  publicWikiOgImageUrl,
  publicWikiPath,
  publicWikiSurfaceFromSnapshot,
} from "./wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("method not allowed");
  }

  const publicId = normalizePublicWikiId(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id);
  if (!publicId) return res.status(404).send("Not found");

  try {
    const store = new UpstashPublicWikiStore();
    const snapshot = await store.get(publicId);
    if (!snapshot) return res.status(404).send("Not found");

    const baseUrl = publicWikiBaseUrl(req);
    const surface = publicWikiSurfaceFromSnapshot(snapshot);
    const docs = surface === "docs";
    const pageUrl = `${baseUrl}${publicWikiPath(publicId, snapshot.visibility, surface)}`;
    const title = plainText(snapshot.title || snapshot.wiki?.structure?.title || (docs ? "Grok Docs" : "Grok-Wiki"));
    const description = plainText(
      snapshot.description || snapshot.wiki?.structure?.description || `A source-grounded public repository ${docs ? "documentation set" : "wiki"} generated with Grok-Wiki.`,
      180,
    );
    const imageUrl = publicWikiOgImageUrl(baseUrl, snapshot);
    const markdownUrls = publicWikiMarkdownUrls(baseUrl, snapshot);
    setAgentReadableHeaders(res, markdownUrls, snapshot);

    if (prefersMarkdown(req)) {
      res.setHeader("content-type", "text/markdown; charset=utf-8");
      res.setHeader("content-disposition", `inline; filename="${publicWikiMarkdownFileName(snapshot, docs ? "docs.md" : "wiki.md")}"`);
      if (req.method === "HEAD") return res.status(200).end();
      return res.status(200).send(publicWikiMarkdownFull(snapshot, baseUrl));
    }

    const shell = await loadPublicWikiShell(baseUrl);
    const htmlTitle = `${title} · ${docs ? "Grok Docs" : "Grok-Wiki"}`;
    const tags = renderMetaTags({
      title,
      htmlTitle,
      description,
      pageUrl,
      imageUrl,
      markdownUrls,
      snapshot,
      privateLink: snapshot.visibility === "private",
    });
    const fallback = publicWikiAgentHtmlFallback(snapshot, baseUrl);
    const html = shell
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(htmlTitle)}</title>`)
      .replace("</head>", `${tags}\n  </head>`)
      .replace('<div class="public-wiki-loading">Loading wiki...</div>', fallback);

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", cacheControlForSnapshot(snapshot));
    return res.status(200).send(html);
  } catch (error) {
    return res.status(errorStatus(error)).send(errorMessage(error));
  }
}

async function loadPublicWikiShell(baseUrl) {
  const response = await fetch(`${baseUrl}/public-wiki.html`);
  if (!response.ok) throw new Error(`Could not load public wiki shell (${response.status}).`);
  return response.text();
}

function renderMetaTags({ title, htmlTitle, description, pageUrl, imageUrl, markdownUrls, snapshot, privateLink }) {
  const docs = publicWikiSurfaceFromSnapshot(snapshot) === "docs";
  const artifact = docs ? "docs" : "wiki";
  const siteName = docs ? "Grok Docs" : "Grok-Wiki";
  const escapedTitle = escapeHtml(htmlTitle);
  const escapedDescription = escapeHtml(description);
  const escapedPageUrl = escapeHtml(pageUrl);
  const escapedImageUrl = escapeHtml(imageUrl);
  const escapedLlmsUrl = escapeHtml(markdownUrls.llmsUrl);
  const escapedLlmsFullUrl = escapeHtml(markdownUrls.llmsFullUrl);
  const escapedMarkdownUrl = escapeHtml(markdownUrls.markdownUrl);
  return `
    <link rel="canonical" href="${escapedPageUrl}" />
    <link rel="alternate" type="text/plain" title="llms.txt" href="${escapedLlmsUrl}" />
    <link rel="alternate" type="text/markdown" title="llms-full.txt" href="${escapedLlmsFullUrl}" />
    <link rel="alternate" type="text/markdown" title="Markdown ${artifact}" href="${escapedMarkdownUrl}" />
    <meta name="description" content="${escapedDescription}" />
    ${privateLink ? '<meta name="robots" content="noindex,nofollow" />' : '<meta name="robots" content="index,follow,max-image-preview:large" />'}
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${siteName}" />
    <meta property="og:title" content="${escapedTitle}" />
    <meta property="og:description" content="${escapedDescription}" />
    <meta property="og:url" content="${escapedPageUrl}" />
    <meta property="og:image" content="${escapedImageUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${escapedTitle}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapedTitle}" />
    <meta name="twitter:description" content="${escapedDescription}" />
    <meta name="twitter:image" content="${escapedImageUrl}" />
    ${jsonLdScript(publicWikiStructuredData({ title, description, pageUrl, imageUrl, snapshot }))}`;
}

function setAgentReadableHeaders(res, markdownUrls, snapshot) {
  const artifact = publicWikiSurfaceFromSnapshot(snapshot) === "docs" ? "docs" : "wiki";
  res.setHeader("link", [
    `<${markdownUrls.llmsUrl}>; rel="alternate"; type="text/plain"; title="llms.txt"`,
    `<${markdownUrls.llmsFullUrl}>; rel="alternate"; type="text/markdown"; title="llms-full.txt"`,
    `<${markdownUrls.markdownUrl}>; rel="alternate"; type="text/markdown"; title="Markdown ${artifact}"`,
  ].join(", "));
  res.setHeader("x-llms-txt", markdownUrls.llmsUrl);
  res.setHeader("x-llms-full-txt", markdownUrls.llmsFullUrl);
  res.setHeader("vary", "Accept");
  res.setHeader("cache-control", cacheControlForSnapshot(snapshot));
  if (snapshot.visibility === "private") res.setHeader("x-robots-tag", "noindex, nofollow");
}

function prefersMarkdown(req) {
  const accept = String(req.headers.accept || "");
  const markdownIndex = accept.indexOf("text/markdown");
  if (markdownIndex === -1) return false;
  const htmlIndex = accept.indexOf("text/html");
  return htmlIndex === -1 || markdownIndex < htmlIndex;
}

function cacheControlForSnapshot(snapshot) {
  return snapshot.visibility === "private"
    ? "private, max-age=0, no-store"
    : "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";
}

function publicWikiStructuredData({ title, description, pageUrl, imageUrl, snapshot }) {
  const wiki = snapshot?.wiki || {};
  const repoUrl = typeof wiki.repoUrl === "string" && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/i.test(wiki.repoUrl)
    ? wiki.repoUrl.replace(/\/$/, "")
    : "";
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url: pageUrl,
    image: imageUrl,
    datePublished: snapshot?.publishedAt || snapshot?.generatedAt,
    dateModified: snapshot?.updatedAt || snapshot?.publishedAt,
    isAccessibleForFree: true,
    about: {
      "@type": "SoftwareSourceCode",
      name: `${snapshot?.owner || wiki.owner || "github"}/${snapshot?.repo || wiki.repo || "repo"}`,
      codeRepository: repoUrl || undefined,
    },
    publisher: {
      "@type": "Organization",
      name: "Grok-Wiki",
      url: publicWikiBaseUrlFromUrl(pageUrl),
    },
  };
}

function jsonLdScript(value) {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

function publicWikiBaseUrlFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return "https://grok-wiki.com";
  }
}
