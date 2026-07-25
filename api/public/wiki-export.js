import {
  UpstashPublicWikiStore,
  createStoredZip,
  errorMessage,
  errorStatus,
  normalizePublicWikiId,
  slugPathPart,
  wikiExportFiles,
} from "./wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const publicId = normalizePublicWikiId(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id);
  if (!publicId) return res.status(404).json({ error: "not found" });

  try {
    const store = new UpstashPublicWikiStore();
    const snapshot = await store.get(publicId);
    if (!snapshot) return res.status(404).json({ error: "not found" });

    const zip = createStoredZip(wikiExportFiles(snapshot.wiki));
    const fileName = `${slugPathPart(snapshot.wiki?.owner || snapshot.owner)}-${slugPathPart(snapshot.wiki?.repo || snapshot.repo)}-wiki.zip`;

    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
    res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=86400");
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(Buffer.from(zip));
  } catch (error) {
    return res.status(errorStatus(error)).json({ error: errorMessage(error) });
  }
}
