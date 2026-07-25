import {
  UpstashPublicWikiStore,
  errorMessage,
  errorStatus,
  normalizePublicWikiId,
  publicWikiBaseUrl,
  publicWikiPath,
  publicWikiSurfaceFromSnapshot,
  requestBody,
  setCors,
} from "./_shared.js";

export default async function handler(req, res) {
  setCors(res, "GET, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const publicId = normalizePublicWikiId(Array.isArray(req.query?.id) ? req.query.id[0] : req.query?.id);
  if (!publicId) return res.status(404).json({ error: "not found" });

  try {
    const store = new UpstashPublicWikiStore();
    if (req.method === "GET") {
      const snapshot = await store.get(publicId);
      if (!snapshot) return res.status(404).json({ error: "not found" });
      const surface = publicWikiSurfaceFromSnapshot(snapshot);
      return res.status(200).json({
        wiki: snapshot.wiki,
        publication: {
          publicId,
          publicPath: publicWikiPath(publicId, snapshot.visibility, surface),
          publicUrl: `${publicWikiBaseUrl(req)}${publicWikiPath(publicId, snapshot.visibility, surface)}`,
          publishedAt: snapshot.publishedAt,
          updatedAt: snapshot.updatedAt,
          readOnly: true,
          visibility: snapshot.visibility || "public",
          surface,
        },
      });
    }

    if (req.method === "PUT") {
      const body = await requestBody(req);
      const result = await store.publish({
        record: body.wiki,
        publicId,
        managementToken: body.managementToken || req.headers["x-rlm-wiki-publish-token"],
        visibility: body.visibility,
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({ ok: true, publication: result.publication });
    }

    if (req.method === "DELETE") {
      const body = await requestBody(req).catch(() => ({}));
      const result = await store.unpublish({
        publicId,
        managementToken: body.managementToken || req.headers["x-rlm-wiki-publish-token"],
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({ ok: true, publication: result.publication });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    return res.status(errorStatus(error)).json({ error: errorMessage(error) });
  }
}
