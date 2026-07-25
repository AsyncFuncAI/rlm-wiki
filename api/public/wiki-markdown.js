import {
  UpstashPublicWikiStore,
  errorMessage,
  errorStatus,
  normalizePublicWikiId,
  publicWikiBaseUrl,
  publicWikiMarkdownFileName,
  publicWikiMarkdownFull,
  publicWikiMarkdownIndex,
  publicWikiMarkdownPage,
} from "./wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const publicId = normalizePublicWikiId(firstQueryValue(req.query?.id));
  if (!publicId) return res.status(404).send("not found");

  try {
    const store = new UpstashPublicWikiStore();
    const snapshot = await store.get(publicId);
    if (!snapshot) return res.status(404).send("not found");

    const baseUrl = publicWikiBaseUrl(req);
    const format = String(firstQueryValue(req.query?.format) || "full").toLowerCase();
    const result = markdownResponse(format, snapshot, baseUrl, firstQueryValue(req.query?.page));

    res.setHeader("content-type", result.contentType);
    res.setHeader("content-disposition", `inline; filename="${result.fileName}"`);
    res.setHeader("cache-control", cacheControlForSnapshot(snapshot));
    if (snapshot.visibility === "private") res.setHeader("x-robots-tag", "noindex, nofollow");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(result.body);
  } catch (error) {
    const status = errorStatus(error);
    const message = status === 404 ? "not found" : errorMessage(error);
    return res.status(status).send(message);
  }
}

function markdownResponse(format, snapshot, baseUrl, pageParam) {
  if (format === "llms" || format === "index") {
    return {
      body: publicWikiMarkdownIndex(snapshot, baseUrl),
      contentType: "text/plain; charset=utf-8",
      fileName: "llms.txt",
    };
  }
  if (format === "page") {
    return {
      body: publicWikiMarkdownPage(snapshot, baseUrl, pageParam),
      contentType: "text/markdown; charset=utf-8",
      fileName: `${String(pageParam || "page").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.md$/i, "") || "page"}.md`,
    };
  }
  return {
    body: publicWikiMarkdownFull(snapshot, baseUrl),
    contentType: "text/markdown; charset=utf-8",
    fileName: publicWikiMarkdownFileName(snapshot, "wiki.md"),
  };
}

function cacheControlForSnapshot(snapshot) {
  return snapshot.visibility === "private"
    ? "private, max-age=0, no-store"
    : "public, max-age=0, s-maxage=300, stale-while-revalidate=86400";
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
