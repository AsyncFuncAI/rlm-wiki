import {
  UpstashPublicWikiStore,
  publicWikiBaseUrl,
  publicWikiSitemapXml,
} from "./public/wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("method not allowed");
  }

  const baseUrl = publicWikiBaseUrl(req);
  const items = await publicWikiSitemapItems();
  const xml = publicWikiSitemapXml(baseUrl, items);

  res.setHeader("content-type", "application/xml; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(xml);
}

async function publicWikiSitemapItems() {
  try {
    const store = new UpstashPublicWikiStore();
    return await store.allPublicItems({ maxKeys: 49995, sort: "updated" });
  } catch {
    return [];
  }
}
