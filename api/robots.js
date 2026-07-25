import {
  publicWikiBaseUrl,
  publicWikiRobotsTxt,
} from "./public/wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("method not allowed");
  }

  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(publicWikiRobotsTxt(publicWikiBaseUrl(req)));
}
