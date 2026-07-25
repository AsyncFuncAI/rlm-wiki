import {
  UpstashPublicWikiStore,
  errorMessage,
  errorStatus,
  publicWikiBaseUrl,
  requestBody,
  setCors,
} from "./_shared.js";

export default async function handler(req, res) {
  setCors(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const store = new UpstashPublicWikiStore();
    if (req.method === "GET") {
      const result = await store.list({
        q: queryValue(req, "q"),
        sort: queryValue(req, "sort"),
        format: queryValue(req, "format"),
        pages: queryValue(req, "pages"),
        surface: queryValue(req, "surface"),
        page: queryValue(req, "page"),
        pageSize: queryValue(req, "pageSize"),
      });
      res.setHeader("cache-control", "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === "POST") {
      const body = await requestBody(req);
      const result = await store.publish({
        record: body.wiki,
        visibility: body.visibility,
        baseUrl: publicWikiBaseUrl(req),
      });
      return res.status(200).json({
        ok: true,
        publication: result.publication,
        managementToken: result.managementToken,
      });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    return res.status(errorStatus(error)).json({ error: errorMessage(error) });
  }
}

function queryValue(req, key) {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}
