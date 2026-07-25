import {
  UpstashPublicAskStore,
  errorMessage,
  errorStatus,
  normalizePublicAskId,
  publicAskPath,
  publicWikiBaseUrl,
  requestBody,
  setCors,
} from "./_shared.js";

// One function serves create, read, update, and unpublish: /api/public/ask/:id is
// rewritten here with ?id= (vercel.json) so ask sharing fits the Vercel Hobby
// 12-serverless-function ceiling instead of splitting an [id].js handler.
export default async function handler(req, res) {
  setCors(res, "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const publicId = normalizePublicAskId(firstQueryValue(req.query?.id));

  try {
    const store = new UpstashPublicAskStore();

    if (req.method === "POST" && !publicId) {
      const body = await requestBody(req);
      const result = await store.publish({
        record: body.ask,
        visibility: body.visibility,
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({
        ok: true,
        publication: result.publication,
        managementToken: result.managementToken,
      });
    }

    if (!publicId) return res.status(404).json({ error: "not found" });

    if (req.method === "GET") {
      const snapshot = await store.get(publicId);
      if (!snapshot) return res.status(404).json({ error: "not found" });
      if (snapshot.visibility === "private") res.setHeader("x-robots-tag", "noindex, nofollow");
      return res.status(200).json({
        ask: snapshot.ask,
        snapshot: { ...snapshot, ask: undefined },
        publication: {
          publicId,
          publicPath: publicAskPath(publicId, snapshot.visibility),
          publicUrl: `${publicWikiBaseUrl(req)}${publicAskPath(publicId, snapshot.visibility)}`,
          publishedAt: snapshot.publishedAt,
          updatedAt: snapshot.updatedAt,
          readOnly: true,
          visibility: snapshot.visibility || "public",
        },
      });
    }

    if (req.method === "PUT") {
      const body = await requestBody(req);
      const result = await store.publish({
        record: body.ask,
        publicId,
        managementToken: body.managementToken || req.headers["x-grok-wiki-publish-token"],
        visibility: body.visibility,
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({ ok: true, publication: result.publication });
    }

    if (req.method === "DELETE") {
      const body = await requestBody(req).catch(() => ({}));
      const result = await store.unpublish({
        publicId,
        managementToken: body.managementToken || req.headers["x-grok-wiki-publish-token"],
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({ ok: true, publication: result.publication });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    return res.status(errorStatus(error)).json({ error: errorMessage(error) });
  }
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
