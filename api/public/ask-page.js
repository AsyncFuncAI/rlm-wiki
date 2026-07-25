import {
  UpstashPublicAskStore,
  errorMessage,
  errorStatus,
  normalizePublicAskId,
  publicAskAgentHtmlFallback,
  publicAskMarkdownFileName,
  publicAskMarkdownFull,
  publicAskMarkdownIndex,
  publicAskMarkdownUrls,
  publicAskOgImageUrl,
  publicAskPath,
  publicWikiBaseUrl,
} from "./ask/_shared.js";
import { escapeHtml, plainText } from "./wiki/_shared.js";

// Serves both the human HTML page and the agent markdown formats (?format=llms|full,
// wired from the .md / llms.txt rewrites): one function instead of an extra
// ask-markdown.js, to fit the Vercel Hobby 12-serverless-function ceiling.
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("method not allowed");
  }

  const publicId = normalizePublicAskId(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id);
  if (!publicId) return res.status(404).send("Not found");

  try {
    const store = new UpstashPublicAskStore();
    const snapshot = await store.get(publicId);
    if (!snapshot) return res.status(404).send("Not found");

    const baseUrl = publicWikiBaseUrl(req);
    const format = String(firstQueryValue(req.query?.format) || "").toLowerCase();
    if (format) {
      const markdown = format === "llms" || format === "index"
        ? { body: publicAskMarkdownIndex(snapshot, baseUrl), contentType: "text/plain; charset=utf-8", fileName: "llms.txt" }
        : { body: publicAskMarkdownFull(snapshot, baseUrl), contentType: "text/markdown; charset=utf-8", fileName: publicAskMarkdownFileName(snapshot) };
      res.setHeader("content-type", markdown.contentType);
      res.setHeader("content-disposition", `inline; filename="${markdown.fileName}"`);
      res.setHeader("cache-control", cacheControlForSnapshot(snapshot));
      if (snapshot.visibility === "private") res.setHeader("x-robots-tag", "noindex, nofollow");
      if (req.method === "HEAD") return res.status(200).end();
      return res.status(200).send(markdown.body);
    }
    const pageUrl = `${baseUrl}${publicAskPath(publicId, snapshot.visibility)}`;
    const title = plainText(snapshot.title || "Shared Ask conversation");
    const description = plainText(
      snapshot.description || "A shared Grok-Wiki Ask conversation grounded in repository evidence.",
      180,
    );
    const imageUrl = publicAskOgImageUrl(baseUrl);
    const markdownUrls = publicAskMarkdownUrls(baseUrl, snapshot);
    setAgentReadableHeaders(res, markdownUrls, snapshot);

    if (prefersMarkdown(req)) {
      res.setHeader("content-type", "text/markdown; charset=utf-8");
      res.setHeader("content-disposition", `inline; filename="${publicAskMarkdownFileName(snapshot)}"`);
      if (req.method === "HEAD") return res.status(200).end();
      return res.status(200).send(publicAskMarkdownFull(snapshot, baseUrl));
    }

    const shell = await loadPublicAskShell(baseUrl);
    const htmlTitle = `${title} · Grok-Wiki Ask`;
    const tags = renderMetaTags({
      htmlTitle,
      description,
      pageUrl,
      imageUrl,
      markdownUrls,
      privateLink: snapshot.visibility === "private",
    });
    const fallback = publicAskAgentHtmlFallback(snapshot, baseUrl);
    const html = shell
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(htmlTitle)}</title>`)
      .replace("</head>", `${tags}\n  </head>`)
      .replace('<div class="public-wiki-loading">Loading conversation...</div>', fallback);

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", cacheControlForSnapshot(snapshot));
    return res.status(200).send(html);
  } catch (error) {
    return res.status(errorStatus(error)).send(errorMessage(error));
  }
}

async function loadPublicAskShell(baseUrl) {
  const response = await fetch(`${baseUrl}/public-ask.html`);
  if (!response.ok) throw new Error(`Could not load public ask shell (${response.status}).`);
  return response.text();
}

function renderMetaTags({ htmlTitle, description, pageUrl, imageUrl, markdownUrls, privateLink }) {
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
    <link rel="alternate" type="text/markdown" title="Markdown transcript" href="${escapedMarkdownUrl}" />
    <meta name="description" content="${escapedDescription}" />
    ${privateLink ? '<meta name="robots" content="noindex,nofollow" />' : '<meta name="robots" content="index,follow,max-image-preview:large" />'}
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Grok-Wiki" />
    <meta property="og:title" content="${escapedTitle}" />
    <meta property="og:description" content="${escapedDescription}" />
    <meta property="og:url" content="${escapedPageUrl}" />
    <meta property="og:image" content="${escapedImageUrl}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapedTitle}" />
    <meta name="twitter:description" content="${escapedDescription}" />
    <meta name="twitter:image" content="${escapedImageUrl}" />`;
}

function setAgentReadableHeaders(res, markdownUrls, snapshot) {
  res.setHeader("link", [
    `<${markdownUrls.llmsUrl}>; rel="alternate"; type="text/plain"; title="llms.txt"`,
    `<${markdownUrls.llmsFullUrl}>; rel="alternate"; type="text/markdown"; title="llms-full.txt"`,
    `<${markdownUrls.markdownUrl}>; rel="alternate"; type="text/markdown"; title="Markdown transcript"`,
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

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
