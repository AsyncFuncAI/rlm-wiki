import {
  UpstashPublicWikiStore,
  escapeHtml,
  publicWikiBaseUrl,
} from "./wiki/_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("method not allowed");
  }

  const baseUrl = publicWikiBaseUrl(req);
  const surface = normalizeGallerySurface(queryValue(req, "surface"));
  const seo = gallerySeo(baseUrl, surface);
  const shell = await loadPublicWikiGalleryShell(baseUrl);
  const items = await publicWikiGalleryFallbackItems(surface);
  const html = renderGalleryPageHtml({ baseUrl, shell, surface, items });

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).send(html);
}

export function renderGalleryPageHtml({ baseUrl, shell, surface, items }) {
  const seo = gallerySeo(baseUrl, surface);
  return String(shell || "")
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(seo.title)}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/>/i, `<meta name="description" content="${escapeHtml(seo.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/i, `<meta property="og:title" content="${escapeHtml(seo.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/i, `<meta property="og:description" content="${escapeHtml(seo.description)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/i, `<meta property="og:url" content="${escapeHtml(seo.canonicalUrl)}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*" \/>/i, `<meta name="twitter:title" content="${escapeHtml(seo.title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*" \/>/i, `<meta name="twitter:description" content="${escapeHtml(seo.description)}" />`)
    .replace("</head>", `${renderGallerySeoTags(seo, items)}\n  </head>`)
    .replace('<div class="wiki-gallery-loading">Loading public items...</div>', renderGalleryFallback(items, surface));
}

async function loadPublicWikiGalleryShell(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/public-wiki-gallery.html`, { redirect: "manual" });
    if (response.ok) return response.text();
  } catch {
    // The SSR gallery must stay indexable even when the static shell route is
    // redirected or temporarily unavailable.
  }
  return fallbackGalleryShell();
}

function fallbackGalleryShell() {
  return `<!doctype html>
<html lang="en" data-theme="dark" data-public-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Public library - rlm-wiki</title>
    <meta name="description" content="Browse public repository wikis and technical docs generated with rlm-wiki." />
    <meta property="og:title" content="Public library - rlm-wiki" />
    <meta property="og:description" content="Browse public repository wikis and technical docs generated with rlm-wiki." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://rlmwiki.deepascii.com/public/wikis" />
    <meta property="og:image" content="https://rlmwiki.deepascii.com/rlm-wiki-preview-bottom-left.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Public library - rlm-wiki" />
    <meta name="twitter:description" content="Browse public repository wikis and technical docs generated with rlm-wiki." />
    <meta name="twitter:image" content="https://rlmwiki.deepascii.com/rlm-wiki-preview-bottom-left.png" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <script type="module" src="/public-wiki-gallery.ts"></script>
    <script type="module" src="/vercel-analytics.ts"></script>
  </head>
  <body class="wiki-gallery-body">
    <div id="public-wiki-gallery-root" class="wiki-gallery-root">
      <div class="wiki-gallery-loading">Loading public items...</div>
    </div>
  </body>
</html>`;
}

async function publicWikiGalleryFallbackItems(surface) {
  try {
    const store = new UpstashPublicWikiStore();
    return (await store.allPublicItems({ maxKeys: 10000, sort: "updated" }))
      .filter((item) => !surface || item.surface === surface)
      .slice(0, 24);
  } catch {
    return [];
  }
}

function gallerySeo(baseUrl, surface) {
  const canonicalPath = surface === "docs" ? "/public/docs" : "/public/wikis";
  const canonicalUrl = `${String(baseUrl || "").replace(/\/+$/, "")}${canonicalPath}`;
  if (surface === "docs") {
    return {
      canonicalUrl,
      title: "Public docs - rlm-wiki",
      description: "Browse public technical docs generated from repositories and folders with rlm-wiki.",
    };
  }
  return {
    canonicalUrl,
    title: "Public library - rlm-wiki",
    description: "Browse public repository wikis and technical docs generated with rlm-wiki.",
  };
}

function renderGallerySeoTags(seo, items) {
  return `
    <link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    ${renderGalleryStructuredData(seo, items)}`;
}

function renderGalleryStructuredData(seo, items) {
  const visibleItems = Array.isArray(items) ? items : [];
  const data = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: schemaText(seo.title),
    description: schemaText(seo.description),
    url: seo.canonicalUrl,
    mainEntity: {
      "@type": "ItemList",
      name: `${schemaText(seo.title)} results`,
      numberOfItems: visibleItems.length,
      itemListElement: visibleItems.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: absoluteGalleryUrl(seo.canonicalUrl, item?.href),
        name: schemaText(item?.title),
        description: schemaText(item?.description),
      })),
    },
  };
  return `<script type="application/ld+json">${jsonLd(data)}</script>`;
}

function absoluteGalleryUrl(canonicalUrl, href) {
  try {
    return new URL(String(href || ""), canonicalUrl).toString();
  } catch {
    return canonicalUrl;
  }
}

function schemaText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderGalleryFallback(items, surface) {
  const cards = items.length
    ? items.map(renderGalleryCard).join("")
    : `<p class="wiki-gallery-loading">Public ${surface === "docs" ? "docs" : surface === "wiki" ? "wikis" : "items"} are loading.</p>`;
  const title = surface === "docs" ? "Browse generated docs." : surface === "wiki" ? "Browse repo wikis." : "Browse repo knowledge.";
  const copy = surface === "docs"
    ? "Functional technical docs generated from repositories and folders."
    : surface === "wiki"
      ? "Source-grounded repository wikis published from rlm-wiki."
      : "Source-grounded public wikis and documentation generated with rlm-wiki.";
  return `
      <main class="gallery-main" data-public-gallery-fallback>
        <section class="gallery-hero" aria-labelledby="gallery-title">
          <p class="gallery-kicker">Public library</p>
          <div class="gallery-hero-row">
            <div>
              <h1 id="gallery-title">${escapeHtml(title)}</h1>
              <p class="gallery-copy">
                ${escapeHtml(copy)}
              </p>
            </div>
            <div class="gallery-count" aria-label="${escapeHtml(String(items.length))} public items">${escapeHtml(String(items.length))}</div>
          </div>
          <nav class="gallery-surface-tabs" aria-label="Public artifact type">
            ${surfaceLink("", "All", !surface)}
            ${surfaceLink("wiki", "Wikis", surface === "wiki")}
            ${surfaceLink("docs", "Docs", surface === "docs")}
          </nav>
        </section>
        <section class="gallery-results-head">
          <p>${items.length ? "Recently published public items" : "Loading public items..."}</p>
        </section>
        <section class="gallery-grid" aria-label="Public artifact links">
          ${cards}
        </section>
      </main>`;
}

function renderGalleryCard(item) {
  return `
    <a class="gallery-card" href="${escapeHtml(item.href)}" aria-label="Open ${escapeHtml(item.title)}">
      <div class="gallery-thumb" aria-hidden="true">
        <div class="gallery-thumb-meta">
          <span>${escapeHtml(String(item.pages || 0))} pages</span>
          <span>${escapeHtml(item.surface === "docs" ? "Docs" : item.formatLabel || "Wiki")}</span>
        </div>
        <strong>${escapeHtml(shortTitle(item.title))}</strong>
        <small>${escapeHtml(item.repository)}</small>
      </div>
      <div class="gallery-card-body">
        <div class="gallery-repo">
          <span>${escapeHtml(item.owner)}</span>
          <span>${escapeHtml(item.repo)}</span>
        </div>
        <h2>${escapeHtml(item.title)}</h2>
        <p>${escapeHtml(item.description)}</p>
        <div class="gallery-card-foot">
          <span>${item.updatedAt ? `Updated ${escapeHtml(formatDate(item.updatedAt))}` : "Recently published"}</span>
          <span>${escapeHtml(String(item.sourceFiles || 0))} source ${(item.sourceFiles || 0) === 1 ? "file" : "files"}</span>
        </div>
      </div>
    </a>`;
}

function surfaceLink(surface, label, active) {
  const href = surface === "docs" ? "/public/docs" : surface === "wiki" ? "/public/wikis?surface=wiki" : "/public/wikis";
  return `<a class="${active ? "active" : ""}" href="${href}" aria-current="${active ? "page" : "false"}">${escapeHtml(label)}</a>`;
}

function normalizeGallerySurface(value) {
  const clean = String(value || "").trim().toLowerCase();
  return clean === "wiki" || clean === "docs" ? clean : "";
}

function queryValue(req, key) {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function shortTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 58 ? `${text.slice(0, 57).trimEnd()}...` : text;
}

function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "recently";
  return date.toISOString().slice(0, 10);
}
