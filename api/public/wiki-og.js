import { ImageResponse } from "@vercel/og";
import React from "react";
import {
  UpstashPublicWikiStore,
  errorMessage,
  errorStatus,
  normalizePublicWikiId,
  plainText,
} from "./wiki/_shared.js";

const h = React.createElement;
const OG_SIZE = { width: 1200, height: 630 };
let instrumentSerifPromise = null;
let interPromise = null;

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

    const title = plainText(snapshot.title || snapshot.wiki?.structure?.title || "Repository Wiki", 86);
    const description = plainText(
      snapshot.description || snapshot.wiki?.structure?.description || "A source-grounded public repository wiki generated with rlm-wiki.",
      160,
    );
    const pages = Array.isArray(snapshot.wiki?.structure?.pages)
      ? snapshot.wiki.structure.pages.length
      : Object.keys(snapshot.wiki?.pages || {}).length;
    const repo = `${snapshot.owner || snapshot.wiki?.owner || "repo"}/${snapshot.repo || snapshot.wiki?.repo || "wiki"}`;
    const [instrumentSerif, inter] = await Promise.all([
      loadGoogleFont(
        "Instrument Serif",
        "rlm-wiki©abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_…:./",
      ),
      loadGoogleFont(
        "Inter",
        `${title} ${description} ${repo} Generated public wiki pages abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_…:./`,
      ),
    ]);
    const image = new ImageResponse(renderOgCard({ title, description, pages, repo }), {
      ...OG_SIZE,
      fonts: [
        instrumentSerif && { name: "Instrument Serif", data: instrumentSerif, weight: 400, style: "normal" },
        inter && { name: "Inter", data: inter, weight: 400, style: "normal" },
      ].filter(Boolean),
    });
    const body = Buffer.from(await image.arrayBuffer());
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, immutable, no-transform, max-age=31536000");
    return res.status(200).send(body);
  } catch (error) {
    return res.status(errorStatus(error)).send(errorMessage(error));
  }
}

function renderOgCard({ title, description, pages, repo }) {
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: "#f4f3ef",
        color: "#20242a",
        overflow: "hidden",
      },
    },
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        display: "flex",
        backgroundImage:
          "linear-gradient(rgba(34, 39, 46, 0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(34, 39, 46, 0.09) 1px, transparent 1px)",
        backgroundSize: "31px 31px",
      },
    }),
    h("div", {
      style: {
        position: "absolute",
        inset: 0,
        display: "flex",
        backgroundImage: "radial-gradient(circle at 18% 14%, rgba(255,255,255,.9), transparent 32%), linear-gradient(180deg, rgba(255,255,255,.35), rgba(230,229,224,.25))",
      },
    }),
    h(
      "div",
      {
        style: {
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "68px 76px 62px",
          border: "1px solid rgba(32, 36, 42, 0.13)",
        },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "rgba(32, 36, 42, 0.58)",
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: 27,
            letterSpacing: 0,
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "baseline",
              gap: 14,
            },
          },
          h(
            "div",
            {
              style: {
                fontFamily: "Instrument Serif, Georgia, serif",
                fontSize: 54,
                lineHeight: 1,
                color: "#20242a",
              },
            },
            "rlm-wiki",
          ),
          h("div", { style: { fontSize: 24, transform: "translateY(-16px)" } }, "©"),
        ),
        h("div", null, `${Math.max(1, Number(pages) || 1)} pages`),
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 22,
            maxWidth: 890,
          },
        },
        h(
          "div",
          {
            style: {
              fontFamily: "Instrument Serif, Georgia, serif",
              fontSize: title.length > 58 ? 78 : 92,
              lineHeight: 0.96,
              letterSpacing: -1,
              color: "#20242a",
            },
          },
          title,
        ),
        h(
          "div",
          {
            style: {
              maxWidth: 780,
              color: "rgba(32, 36, 42, 0.64)",
              fontFamily: "Inter, Arial, sans-serif",
              fontSize: 30,
              lineHeight: 1.32,
            },
          },
          description,
        ),
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            color: "rgba(32, 36, 42, 0.54)",
            fontFamily: "Inter, Arial, sans-serif",
            fontSize: 24,
          },
        },
        h("div", null, repo),
      ),
    ),
  );
}

async function loadGoogleFont(family, text) {
  const isSerif = family === "Instrument Serif";
  if (isSerif && instrumentSerifPromise) return instrumentSerifPromise;
  if (!isSerif && interPromise) return interPromise;
  const promise = fetch(
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&text=${encodeURIComponent(text)}`,
      { headers: { "user-agent": "Mozilla/5.0" } },
    )
      .then((response) => response.text())
      .then((css) => {
        const url = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
        return url ? fetch(url).then((response) => response.arrayBuffer()) : null;
      })
      .catch(() => null);
  if (isSerif) instrumentSerifPromise = promise;
  else interPromise = promise;
  return promise;
}
