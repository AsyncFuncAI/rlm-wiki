import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const PUBLIC_WIKI_SCHEMA_VERSION = 1;
const KEY_PREFIX = "gw:public:wiki";

export function normalizePublicWikiId(value) {
  const clean = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,95}$/.test(clean) ? clean : "";
}

export function publicWikiBaseUrlFromEnv(defaultBaseUrl = "https://rlmwiki.deepascii.com") {
  return String(process.env.RLM_WIKI_PUBLIC_URL || defaultBaseUrl)
    .trim()
    .replace(/\/+$/, "");
}

export function publicWikiBaseUrl(req) {
  const configured = publicWikiBaseUrlFromEnv("");
  if (configured) return configured;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "rlmwiki.deepascii.com";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function errorStatus(error) {
  const message = errorMessage(error);
  if (/not found/i.test(message)) return 404;
  if (/token|rejected|authorized/i.test(message)) return 403;
  return 400;
}

export async function requestBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function setCors(res, methods) {
  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", "content-type, x-rlm-wiki-publish-token");
}

export function normalizePublicWikiVisibility(value) {
  return value === "private" ? "private" : "public";
}

export function normalizePublicWikiSurface(value) {
  return value === "docs" ? "docs" : "wiki";
}

export function publicWikiSurfaceFromRecord(record) {
  const style = String(record?.wikiStyle || record?.input?.style || record?.style || "").trim();
  return style === "documentation" ? "docs" : "wiki";
}

export function publicWikiSurfaceFromSnapshot(snapshot) {
  return normalizePublicWikiSurface(snapshot?.surface || publicWikiSurfaceFromRecord(snapshot?.wiki || snapshot));
}

export function publicWikiPath(publicId, visibility, surface = "wiki") {
  const surfacePart = normalizePublicWikiSurface(surface) === "docs" ? "docs" : "wiki";
  const prefix = normalizePublicWikiVisibility(visibility) === "private" ? `/share/${surfacePart}` : `/public/${surfacePart}`;
  return `${prefix}/${encodeURIComponent(publicId)}`;
}

export function publicWikiOgImageUrl(baseUrl, snapshot) {
  const version = encodeURIComponent(String(snapshot?.updatedAt || snapshot?.publishedAt || snapshot?.generatedAt || ""));
  const publicId = encodeURIComponent(String(snapshot?.publicId || ""));
  return `${String(baseUrl || "").replace(/\/+$/, "")}/api/public/wiki-og?id=${publicId}${version ? `&v=${version}` : ""}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function plainText(value, maxLength = 220) {
  const text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function slugPathPart(value, fallback = "untitled") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeZipU16(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeZipU32(bytes, value) {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function appendZipBytes(out, bytes) {
  for (const byte of bytes) out.push(byte);
}

export function createStoredZip(files) {
  const encoder = new TextEncoder();
  const out = [];
  const central = [];
  const { date, time } = dosDateTime();

  for (const file of files) {
    const pathBytes = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const offset = out.length;

    writeZipU32(out, 0x04034b50);
    writeZipU16(out, 20);
    writeZipU16(out, 0x0800);
    writeZipU16(out, 0);
    writeZipU16(out, time);
    writeZipU16(out, date);
    writeZipU32(out, crc);
    writeZipU32(out, data.length);
    writeZipU32(out, data.length);
    writeZipU16(out, pathBytes.length);
    writeZipU16(out, 0);
    appendZipBytes(out, pathBytes);
    appendZipBytes(out, data);

    writeZipU32(central, 0x02014b50);
    writeZipU16(central, 20);
    writeZipU16(central, 20);
    writeZipU16(central, 0x0800);
    writeZipU16(central, 0);
    writeZipU16(central, time);
    writeZipU16(central, date);
    writeZipU32(central, crc);
    writeZipU32(central, data.length);
    writeZipU32(central, data.length);
    writeZipU16(central, pathBytes.length);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU32(central, 0);
    writeZipU32(central, offset);
    appendZipBytes(central, pathBytes);
  }

  const centralOffset = out.length;
  appendZipBytes(out, Uint8Array.from(central));
  writeZipU32(out, 0x06054b50);
  writeZipU16(out, 0);
  writeZipU16(out, 0);
  writeZipU16(out, files.length);
  writeZipU16(out, files.length);
  writeZipU32(out, central.length);
  writeZipU32(out, centralOffset);
  writeZipU16(out, 0);
  return Uint8Array.from(out);
}

export function wikiExportFiles(record) {
  const root = `${slugPathPart(record.owner)}-${slugPathPart(record.repo)}-wiki`;
  const pageMetas = Array.isArray(record.structure?.pages) ? record.structure.pages : [];
  const generatedIds = new Set(Object.keys(record.pages || {}));
  const orderedPageIds = [
    ...pageMetas.map((page) => page.id).filter((pageId) => generatedIds.has(pageId)),
    ...Object.keys(record.pages || {}).filter((pageId) => !pageMetas.some((page) => page.id === pageId)),
  ];
  const files = [];
  const pageEntries = [];
  const usedNames = new Set();

  for (const [index, pageId] of orderedPageIds.entries()) {
    const page = record.pages?.[pageId];
    if (!page) continue;
    const meta = pageMetas.find((item) => item.id === pageId);
    const title = meta?.title || pageId;
    const baseName = `${String(index + 1).padStart(2, "0")}-${slugPathPart(title)}`;
    let fileName = `${baseName}.md`;
    for (let i = 2; usedNames.has(fileName); i++) fileName = `${baseName}-${i}.md`;
    usedNames.add(fileName);
    const path = `pages/${fileName}`;
    const sourceFiles = Array.isArray(meta?.filePaths) ? meta.filePaths.map(String).filter(Boolean) : [];
    pageEntries.push({
      id: pageId,
      title,
      description: meta?.description || "",
      path,
      obsidianName: fileName.replace(/\.md$/i, ""),
      sourceFiles,
    });
    files.push({
      path: `${root}/${path}`,
      content: wikiObsidianPageMarkdown({
        record,
        pageId,
        title,
        description: meta?.description || "",
        sourceFiles,
        relatedPages: Array.isArray(meta?.relatedPages) ? meta.relatedPages : [],
        content: page.content || "",
      }),
    });
  }

  const missingIds = pageMetas
    .map((page) => page.id)
    .filter((pageId) => !generatedIds.has(pageId));
  const indexMarkdown = [
    "---",
    "rlm_wiki: true",
    `title: ${yamlString(record.structure?.title || `${record.owner}/${record.repo}`)}`,
    `repository: ${yamlString(`${record.owner}/${record.repo}`)}`,
    `branch: ${yamlString(record.branch || "default")}`,
    `generated_at: ${yamlString(record.generatedAt)}`,
    `pages: ${pageEntries.length}`,
    "---",
    "",
    `# ${record.structure?.title || `${record.owner}/${record.repo}`}`,
    "",
    record.structure?.description || "",
    "",
    `- Repository: ${record.owner}/${record.repo}`,
    `- Branch: ${record.branch || "default"}`,
    `- Generated at: ${record.generatedAt}`,
    `- Pages exported: ${pageEntries.length}/${pageMetas.length || pageEntries.length}`,
    "",
    "## Pages",
    "",
    pageEntries.map((entry) => `- [[${entry.obsidianName}|${entry.title}]]`).join("\n") || "_No generated pages were available._",
    "",
    "## Files",
    "",
    "- [[sources|Source file index]]",
    "- `manifest.json`",
    ...(missingIds.length ? ["", "## Missing Pages", "", ...missingIds.map((pageId) => `- ${pageMetas.find((page) => page.id === pageId)?.title || pageId}`)] : []),
    "",
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");

  return [
    { path: `${root}/README.md`, content: indexMarkdown },
    { path: `${root}/sources.md`, content: wikiObsidianSourcesMarkdown(record, pageEntries) },
    { path: `${root}/manifest.json`, content: JSON.stringify(wikiExportManifest(record, pageEntries), null, 2) },
    { path: `${root}/.obsidian/app.json`, content: JSON.stringify({ alwaysUpdateLinks: true, promptDelete: false }, null, 2) },
    ...files,
  ];
}

function wikiObsidianPageMarkdown(args) {
  const frontmatter = [
    "---",
    "rlm_wiki: true",
    `page_id: ${yamlString(args.pageId)}`,
    `title: ${yamlString(args.title)}`,
    `repository: ${yamlString(`${args.record.owner}/${args.record.repo}`)}`,
    `branch: ${yamlString(args.record.branch || "default")}`,
    `generated_at: ${yamlString(args.record.generatedAt)}`,
    ...(args.sourceFiles.length ? ["source_files:", ...args.sourceFiles.map((file) => `  - ${yamlString(file)}`)] : ["source_files: []"]),
    "---",
    "",
  ];
  const related = args.relatedPages.length
    ? ["", "## Related pages", "", ...args.relatedPages.map((pageId) => `- ${pageId}`), ""]
    : [];
  const sources = args.sourceFiles.length
    ? ["", "## Source files", "", ...args.sourceFiles.map((file) => `- \`${file}\``), ""]
    : [];
  return [
    ...frontmatter,
    args.content.trim() || `# ${args.title}\n\n_No generated content was available for this page._`,
    ...related,
    ...sources,
  ].join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

function wikiObsidianSourcesMarkdown(record, pageEntries) {
  const byFile = new Map();
  for (const page of pageEntries) {
    for (const source of page.sourceFiles) {
      const pages = byFile.get(source) || [];
      pages.push(`[[${page.obsidianName}|${page.title}]]`);
      byFile.set(source, pages);
    }
  }
  const rows = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return [
    "---",
    "rlm_wiki: true",
    `title: ${yamlString(`${record.structure?.title || record.repo} sources`)}`,
    "---",
    "",
    "# Source file index",
    "",
    rows.length
      ? rows.map(([file, pages]) => `- \`${file}\` - ${pages.join(", ")}`).join("\n")
      : "_No source files were recorded for this export._",
    "",
  ].join("\n");
}

function wikiExportManifest(record, pageEntries) {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    title: record.structure?.title || `${record.owner}/${record.repo}`,
    description: record.structure?.description || "",
    repository: `${record.owner}/${record.repo}`,
    branch: record.branch || null,
    generatedAt: record.generatedAt,
    format: "obsidian-markdown-vault",
    privacy: "public-snapshot-export",
    pages: pageEntries.map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      path: page.path,
      sourceFiles: page.sourceFiles,
    })),
  };
}

export function publicWikiMarkdownUrls(baseUrl, snapshot) {
  const origin = String(baseUrl || publicWikiBaseUrlFromEnv()).replace(/\/+$/, "");
  const publicId = normalizePublicWikiId(snapshot?.publicId);
  const visibility = normalizePublicWikiVisibility(snapshot?.visibility);
  const surface = publicWikiSurfaceFromSnapshot(snapshot);
  const canonicalPath = publicWikiPath(publicId, visibility, surface);
  const withOrigin = (path) => `${origin}${path}`;
  return {
    canonicalPath,
    canonicalUrl: withOrigin(canonicalPath),
    llmsPath: `${canonicalPath}/llms.txt`,
    llmsUrl: withOrigin(`${canonicalPath}/llms.txt`),
    llmsFullPath: `${canonicalPath}/llms-full.txt`,
    llmsFullUrl: withOrigin(`${canonicalPath}/llms-full.txt`),
    markdownPath: `${canonicalPath}.md`,
    markdownUrl: withOrigin(`${canonicalPath}.md`),
    pageMarkdownPath(entry) {
      return `${canonicalPath}/pages/${encodeURIComponent(entry.fileName)}`;
    },
    pageMarkdownUrl(entry) {
      return withOrigin(`${canonicalPath}/pages/${encodeURIComponent(entry.fileName)}`);
    },
  };
}

export function publicWikiMarkdownIndex(snapshot, baseUrl) {
  const context = publicWikiMarkdownContext(snapshot, baseUrl);
  const artifact = context.surface === "docs" ? "docs" : "wiki";
  const artifactDescription = context.surface === "docs"
    ? "rlm-wiki source-grounded repository documentation set"
    : "rlm-wiki source-grounded repository wiki";
  const lines = [
    `# ${context.title}`,
    "",
    context.description ? `> ${context.description}` : "",
    "",
    `This is a ${artifactDescription}. Use the complete Markdown link when an agent needs the full repo context.`,
    "",
    "## Context Links",
    "",
    `- ${markdownLink(`Complete Markdown ${artifact}`, context.urls.llmsFullUrl)}`,
    `- ${markdownLink("Complete Markdown alias", context.urls.markdownUrl)}`,
    `- ${markdownLink(`Human interactive ${artifact}`, context.urls.canonicalUrl)}`,
    context.repoUrl ? `- ${markdownLink("GitHub repository", context.repoUrl)}` : "",
    "",
    "## Repository",
    "",
    `- Repository: ${inlineMarkdown(context.repository)}`,
    context.branch ? `- Branch: ${inlineMarkdown(context.branch)}` : "",
    context.generatedAt ? `- Generated: ${inlineMarkdown(context.generatedAt)}` : "",
    context.updatedAt ? `- Updated: ${inlineMarkdown(context.updatedAt)}` : "",
    context.runtime ? `- Runtime: ${inlineMarkdown(context.runtime)}` : "",
    context.format ? `- Format: ${inlineMarkdown(context.format)}` : "",
    `- Pages: ${context.entries.length}`,
    "",
    "## Pages",
    "",
    context.entries.length
      ? context.entries.map((entry) => `- ${markdownLink(entry.title, context.urls.pageMarkdownUrl(entry))}${publicWikiIndexEntrySuffix(entry)}`).join("\n")
      : "- No generated pages are available.",
    "",
    context.sourceFiles.length ? "## Source Files" : "",
    "",
    context.sourceFiles.length ? context.sourceFiles.map((file) => `- \`${escapeMarkdownCode(file)}\``).join("\n") : "",
    "",
  ];
  return cleanMarkdown(lines);
}

export function publicWikiMarkdownFull(snapshot, baseUrl) {
  const context = publicWikiMarkdownContext(snapshot, baseUrl);
  const artifact = context.surface === "docs" ? "docs" : "wiki";
  const lines = [
    `# ${context.title}`,
    "",
    context.description ? `> ${context.description}` : "",
    "",
    "## Context Links",
    "",
    `- ${markdownLink("Agent index", context.urls.llmsUrl)}`,
    `- ${markdownLink(`Human interactive ${artifact}`, context.urls.canonicalUrl)}`,
    context.repoUrl ? `- ${markdownLink("GitHub repository", context.repoUrl)}` : "",
    "",
    "## Repository Metadata",
    "",
    `- Repository: ${inlineMarkdown(context.repository)}`,
    context.branch ? `- Branch: ${inlineMarkdown(context.branch)}` : "",
    context.generatedAt ? `- Generated: ${inlineMarkdown(context.generatedAt)}` : "",
    context.updatedAt ? `- Updated: ${inlineMarkdown(context.updatedAt)}` : "",
    context.runtime ? `- Runtime: ${inlineMarkdown(context.runtime)}` : "",
    context.format ? `- Format: ${inlineMarkdown(context.format)}` : "",
    `- Pages: ${context.entries.length}`,
    "",
    "## Page Index",
    "",
    context.entries.length
      ? context.entries.map((entry, index) => `- ${String(index + 1).padStart(2, "0")}. ${markdownLink(entry.title, context.urls.pageMarkdownUrl(entry))}${entry.description ? ` - ${inlineMarkdown(entry.description)}` : ""}`).join("\n")
      : "- No generated pages are available.",
    "",
    context.sourceFiles.length ? "## Source File Index" : "",
    "",
    context.sourceFiles.length ? context.sourceFiles.map((file) => `- \`${escapeMarkdownCode(file)}\``).join("\n") : "",
    "",
    "---",
    "",
    ...context.entries.flatMap((entry, index) => publicWikiFullPageSection(context, entry, index)),
  ];
  return cleanMarkdown(lines);
}

export function publicWikiMarkdownPage(snapshot, baseUrl, pageParam) {
  const context = publicWikiMarkdownContext(snapshot, baseUrl);
  const entry = publicWikiMarkdownPageEntry(context.entries, pageParam);
  if (!entry) throw new Error("Public wiki page not found.");
  const artifact = context.surface === "docs" ? "docs" : "wiki";
  const lines = [
    `# ${entry.title}`,
    "",
    entry.description ? `> ${entry.description}` : "",
    "",
    `- Repository: ${inlineMarkdown(context.repository)}`,
    context.repoUrl ? `- GitHub: ${context.repoUrl}` : "",
    `- Human ${artifact}: ${context.urls.canonicalUrl}`,
    `- Complete Markdown: ${context.urls.llmsFullUrl}`,
    "",
    ...publicWikiCardFreshnessLines(entry.kb),
    entry.sourceFiles.length ? "## Source Files" : "",
    "",
    entry.sourceFiles.length ? entry.sourceFiles.map((file) => `- \`${escapeMarkdownCode(file)}\``).join("\n") : "",
    "",
    "---",
    "",
    normalizeMarkdownBody(entry.content) || `_No generated content was available for ${entry.title}._`,
    "",
  ];
  return cleanMarkdown(lines);
}

export function publicWikiRobotsTxt(baseUrl) {
  const origin = String(baseUrl || publicWikiBaseUrlFromEnv()).replace(/\/+$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export function publicWikiSitemapXml(baseUrl, items = []) {
  const origin = String(baseUrl || publicWikiBaseUrlFromEnv()).replace(/\/+$/, "");
  const now = new Date().toISOString();
  const staticEntries = [
    { loc: `${origin}/`, priority: "0.8", changefreq: "weekly" },
    { loc: `${origin}/public/wikis`, priority: "0.7", changefreq: "daily" },
    { loc: `${origin}/public/docs`, priority: "0.7", changefreq: "daily" },
    { loc: `${origin}/episodes`, priority: "0.4", changefreq: "monthly" },
    { loc: `${origin}/changelog`, priority: "0.3", changefreq: "weekly" },
  ];
  const wikiEntries = (Array.isArray(items) ? items : [])
    .filter((item) => normalizePublicWikiId(item?.publicId))
    .map((item) => ({
      loc: `${origin}${publicWikiPath(item.publicId, "public", item.surface)}`,
      lastmod: validIsoDate(item.updatedAt || item.publishedAt || item.generatedAt) || now,
      priority: "0.6",
      changefreq: "weekly",
    }));
  const entries = [...staticEntries, ...wikiEntries];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((entry) => [
      "  <url>",
      `    <loc>${xmlEscape(entry.loc)}</loc>`,
      entry.lastmod ? `    <lastmod>${xmlEscape(entry.lastmod)}</lastmod>` : "",
      entry.changefreq ? `    <changefreq>${xmlEscape(entry.changefreq)}</changefreq>` : "",
      entry.priority ? `    <priority>${xmlEscape(entry.priority)}</priority>` : "",
      "  </url>",
    ].filter(Boolean).join("\n")),
    "</urlset>",
    "",
  ].join("\n");
}

export function publicWikiMarkdownFileName(snapshot, suffix = "wiki.md") {
  const wiki = snapshot?.wiki || {};
  const owner = slugPathPart(wiki.owner || snapshot?.owner || "repo");
  const repo = slugPathPart(wiki.repo || snapshot?.repo || "wiki");
  const cleanSuffix = String(suffix || "wiki.md").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || "wiki.md";
  return `${owner}-${repo}-${cleanSuffix}`;
}

export function publicWikiAgentHtmlFallback(snapshot, baseUrl) {
  const context = publicWikiMarkdownContext(snapshot, baseUrl);
  const visiblePages = context.entries;
  const artifactLabel = context.surface === "docs" ? "docs" : "wiki";
  const headingLabel = context.surface === "docs" ? "Agent-readable docs" : "Agent-readable wiki";
  return `
      <article class="public-wiki-agent-fallback" data-agent-readable="true" aria-label="Agent-readable rlm-wiki ${artifactLabel} fallback">
        <header class="public-wiki-agent-head">
          <p class="public-wiki-agent-kicker">${escapeHtml(headingLabel)}</p>
          <h1>${escapeHtml(context.title)}</h1>
          ${context.description ? `<p>${escapeHtml(context.description)}</p>` : ""}
        </header>
        <nav class="public-wiki-agent-links" aria-label="Markdown links">
          <a href="${escapeHtml(context.urls.llmsFullPath)}">Full Markdown</a>
          <a href="${escapeHtml(context.urls.llmsPath)}">llms.txt</a>
          <a href="${escapeHtml(context.urls.markdownPath)}">Markdown alias</a>
          ${context.repoUrl ? `<a href="${escapeHtml(context.repoUrl)}">GitHub</a>` : ""}
        </nav>
        <section class="public-wiki-agent-pages" aria-label="Wiki pages">
          <h2>Pages</h2>
          <ol>
            ${visiblePages.map((entry) => `<li><a href="${escapeHtml(context.urls.pageMarkdownPath(entry))}">${escapeHtml(entry.title)}</a>${entry.description ? `<span>${escapeHtml(entry.description)}</span>` : ""}</li>`).join("")}
          </ol>
        </section>
        <section class="public-wiki-agent-markdown" aria-label="Complete Markdown files">
          <h2>Complete Markdown</h2>
          <p>The complete agent-readable Markdown files are published separately from this HTML page.</p>
          <ul>
            <li><a href="${escapeHtml(context.urls.llmsFullPath)}">Full Markdown</a></li>
            <li><a href="${escapeHtml(context.urls.markdownPath)}">Markdown alias</a></li>
          </ul>
        </section>
      </article>`;
}

function publicWikiMarkdownContext(snapshot, baseUrl) {
  const wiki = snapshot?.wiki && typeof snapshot.wiki === "object" ? snapshot.wiki : {};
  const structure = wiki.structure && typeof wiki.structure === "object" ? wiki.structure : {};
  const owner = cleanOptional(wiki.owner) || cleanOptional(snapshot?.owner) || "github";
  const repo = cleanOptional(wiki.repo) || cleanOptional(snapshot?.repo) || "repo";
  const repository = `${owner}/${repo}`;
  const urls = publicWikiMarkdownUrls(baseUrl, snapshot);
  const entries = publicWikiMarkdownPageEntries(snapshot);
  const sourceFiles = [...new Set(entries.flatMap((entry) => entry.sourceFiles))].sort((a, b) => a.localeCompare(b));
  const surface = publicWikiSurfaceFromSnapshot(snapshot);
  return {
    wiki,
    structure,
    urls,
    surface,
    entries,
    sourceFiles,
    repository,
    repoUrl: safePublicRepoUrl(wiki.repoUrl) || firstRepoUrl(wiki.repos),
    title: markdownLine(snapshot?.title || structure.title || `${repository} Wiki`, `${repository} Wiki`),
    description: markdownLine(snapshot?.description || structure.description || `A source-grounded repository ${surface === "docs" ? "documentation set" : "wiki"} generated with rlm-wiki.`, ""),
    branch: cleanOptional(snapshot?.branch) || cleanOptional(wiki.branch),
    generatedAt: cleanOptional(snapshot?.generatedAt) || cleanOptional(wiki.generatedAt),
    updatedAt: cleanOptional(snapshot?.updatedAt) || cleanOptional(wiki.updatedAt),
    runtime: cleanOptional(wiki.runtimeModelLabel) || cleanOptional(wiki.pageModel) || cleanOptional(wiki.structureModel) || cleanOptional(wiki.model),
    format: wikiStyleLabel(wiki.wikiStyle || "technical"),
  };
}

function publicWikiMarkdownPageEntries(snapshot) {
  const wiki = snapshot?.wiki && typeof snapshot.wiki === "object" ? snapshot.wiki : {};
  const pageMetas = Array.isArray(wiki.structure?.pages) ? wiki.structure.pages : [];
  const pages = wiki.pages && typeof wiki.pages === "object" ? wiki.pages : {};
  const generatedIds = new Set(Object.keys(pages));
  const orderedPageIds = [
    ...pageMetas.map((page) => page.id).filter((pageId) => generatedIds.has(pageId)),
    ...Object.keys(pages).filter((pageId) => !pageMetas.some((page) => page.id === pageId)),
  ];
  const usedNames = new Set();
  return orderedPageIds.map((pageId, index) => {
    const page = pages[pageId] || {};
    const meta = pageMetas.find((item) => item.id === pageId) || {};
    const title = markdownLine(meta.title || page.title || pageId, `Page ${index + 1}`);
    const baseName = `${String(index + 1).padStart(2, "0")}-${slugPathPart(title, `page-${index + 1}`)}`;
    let fileName = `${baseName}.md`;
    for (let i = 2; usedNames.has(fileName); i++) fileName = `${baseName}-${i}.md`;
    usedNames.add(fileName);
    return {
      id: String(pageId),
      index,
      title,
      description: markdownLine(meta.description || "", ""),
      fileName,
      slug: fileName.replace(/\.md$/i, ""),
      sourceFiles: Array.isArray(meta.filePaths) ? meta.filePaths.map(safeSourcePath).filter(Boolean) : [],
      content: String(page.content || ""),
      generatedAt: cleanOptional(page.generatedAt),
      kb: normalizeKbPageMetadata(page.kb),
    };
  });
}

/**
 * The KB build branch (Phase 0 gate outcome). Mirrors KB_BUILD_BRANCH in
 * src/kb/knowledge-base-types.ts (this file is plain JS and cannot import TS).
 * Keep the two in sync: a branch flip there must flip here.
 */
const KB_BUILD_BRANCH = "full-self-heal";

/** True when the contradicts/corroboration detail renders (every branch but manual). */
function kbRendersContradictionDetail() {
  return KB_BUILD_BRANCH !== "manual-authoring";
}

/** Coerce untrusted KB page metadata into a safe shape, or null when absent. */
function normalizeKbPageMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const status = value.status === "corroborated" ? "corroborated" : "provisional";
  const lastUpdated = cleanOptional(value.lastUpdated) || "";
  const sourceAskIds = Array.isArray(value.sourceAskIds) ? value.sourceAskIds.map((v) => String(v)).filter(Boolean) : [];
  const contradicts = Array.isArray(value.contradicts) ? value.contradicts.map((v) => String(v)).filter(Boolean) : [];
  const topicTags = Array.isArray(value.topicTags) ? value.topicTags.map((v) => String(v)).filter(Boolean) : [];
  const corroborationCount = Number.isFinite(Number(value.corroborationCount))
    ? Math.max(0, Math.floor(Number(value.corroborationCount)))
    : 0;
  return { status, lastUpdated, sourceAskIds, contradicts, topicTags, corroborationCount };
}

/**
 * Render the per-card freshness block for a KB card page. Always shows status +
 * last updated + provenance. The contradicts/corroboration detail is gated by the
 * build branch (3b): under manual-authoring there is no detector output to show, so
 * only the honest status + lastUpdated line renders. Returns [] for non-KB pages.
 */
function publicWikiCardFreshnessLines(kb) {
  if (!kb) return [];
  const statusLabel = kb.status === "corroborated" ? "Corroborated" : "Provisional";
  const lines = ["### Card status", ""];
  lines.push(`- Status: ${inlineMarkdown(statusLabel)}`);
  if (kb.lastUpdated) lines.push(`- Last updated: ${inlineMarkdown(kb.lastUpdated)}`);
  if (kbRendersContradictionDetail()) {
    lines.push(`- Corroborating sources: ${kb.corroborationCount}`);
    if (kb.contradicts.length) {
      lines.push(`- Contradicts: ${kb.contradicts.map((flag) => inlineMarkdown(flag)).join("; ")}`);
    }
  }
  if (kb.topicTags.length) {
    lines.push(`- Topics: ${kb.topicTags.map((tag) => inlineMarkdown(tag)).join(", ")}`);
  }
  if (kb.sourceAskIds.length) {
    lines.push(`- Sources: ${kb.sourceAskIds.map((id) => `\`${escapeMarkdownCode(id)}\``).join(", ")}`);
  }
  lines.push("");
  // A loud, plain-text contradiction banner so an agent never silently trusts a
  // flagged card. Only when the detector actually produced contradicts flags.
  if (kbRendersContradictionDetail() && kb.contradicts.length) {
    lines.push(
      "> Warning: this card disagrees with a higher-authority source and is saved as provisional. Verify before relying on it.",
      "",
    );
  }
  return lines;
}

/**
 * Inline freshness suffix for a page entry in the index list. For a KB card this
 * surfaces the status (and a flag marker) at a glance; for an ordinary wiki page it
 * falls back to the page description. Always returns a string (possibly empty).
 */
function publicWikiIndexEntrySuffix(entry) {
  const kb = entry && entry.kb;
  if (kb) {
    const parts = [kb.status === "corroborated" ? "corroborated" : "provisional"];
    if (kbRendersContradictionDetail() && kb.contradicts.length) parts.push("contradiction flagged");
    return ` [${parts.join(", ")}]${entry.description ? `: ${inlineMarkdown(entry.description)}` : ""}`;
  }
  return entry && entry.description ? `: ${inlineMarkdown(entry.description)}` : "";
}

function publicWikiMarkdownPageEntry(entries, pageParam) {
  const wanted = normalizeMarkdownPageParam(pageParam);
  if (!wanted) return null;
  return entries.find((entry) => {
    const candidates = [entry.id, entry.slug, entry.fileName, entry.title, String(entry.index + 1), String(entry.index + 1).padStart(2, "0")];
    return candidates.some((candidate) => normalizeMarkdownPageParam(candidate) === wanted);
  }) || null;
}

function publicWikiFullPageSection(context, entry, index) {
  return [
    `## ${String(index + 1).padStart(2, "0")}. ${entry.title}`,
    "",
    entry.description ? `> ${entry.description}` : "",
    "",
    `- Page Markdown: ${context.urls.pageMarkdownUrl(entry)}`,
    entry.generatedAt ? `- Generated: ${inlineMarkdown(entry.generatedAt)}` : "",
    "",
    ...publicWikiCardFreshnessLines(entry.kb),
    entry.sourceFiles.length ? "### Source Files" : "",
    "",
    entry.sourceFiles.length ? entry.sourceFiles.map((file) => `- \`${escapeMarkdownCode(file)}\``).join("\n") : "",
    "",
    normalizeMarkdownBody(entry.content) || `_No generated content was available for ${entry.title}._`,
    "",
    "---",
    "",
  ];
}

function normalizeMarkdownPageParam(value) {
  const decoded = safeDecodeURIComponent(String(value || ""));
  return decoded.trim().replace(/\.md$/i, "").toLowerCase();
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function markdownLine(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function inlineMarkdown(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function markdownLink(label, url) {
  const text = String(label || "Link").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\s+/g, " ").trim();
  const href = String(url || "").replace(/\)/g, "%29").trim();
  return `[${text || "Link"}](${href})`;
}

function escapeMarkdownCode(value) {
  return String(value || "").replace(/`/g, "\\`");
}

function normalizeMarkdownBody(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function cleanMarkdown(lines) {
  return lines
    .flat()
    .filter((line, index, all) => line || all[index - 1] !== "")
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd() + "\n";
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

export class UpstashPublicWikiStore {
  constructor(opts = {}) {
    this.url = String(opts.url || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
    this.token = String(opts.token || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
    if (!this.url || !this.token) {
      throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for public wiki publishing.");
    }
  }

  async get(publicId) {
    const id = normalizePublicWikiId(publicId);
    if (!id) return null;
    const meta = await this.getMeta(id);
    if (!meta || meta.published !== true) return null;
    const pageIds = Array.isArray(meta.pageIds) ? meta.pageIds : [];
    const pageResults = pageIds.length
      ? await this.command(["MGET", ...pageIds.map((pageId) => this.pageKey(id, pageId))])
      : [];
    const pages = {};
    pageIds.forEach((pageId, index) => {
      const raw = pageResults[index];
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
          pages[pageId] = parsed;
        }
      } catch {
        // A corrupt page should not expose raw storage.
      }
    });
    return {
      schemaVersion: meta.schemaVersion,
      publicId: id,
      published: true,
      visibility: normalizePublicWikiVisibility(meta.visibility),
      surface: publicWikiSurfaceFromSnapshot(meta),
      readOnly: true,
      owner: meta.owner,
      repo: meta.repo,
      branch: meta.branch ?? null,
      title: meta.title,
      description: meta.description,
      generatedAt: meta.generatedAt,
      publishedAt: meta.publishedAt,
      updatedAt: meta.updatedAt,
      wiki: {
        ...meta.wiki,
        pages,
      },
    };
  }

  async publish(args) {
    const existingId = normalizePublicWikiId(args.publicId);
    const existingMeta = existingId ? await this.getMeta(existingId) : null;
    if (existingId) this.assertAuthorized(existingId, existingMeta, args.managementToken);

    const visibility = args.visibility == null && existingMeta
      ? normalizePublicWikiVisibility(existingMeta.visibility)
      : normalizePublicWikiVisibility(args.visibility);
    const publicId = existingId || (visibility === "private"
      ? makePrivateWikiId()
      : makePublicWikiId(
        String(args.record?.owner || "wiki"),
        String(args.record?.repo || "repo"),
      ));
    const now = new Date().toISOString();
    const publishedAt = existingMeta?.publishedAt || now;
    const managementToken = existingMeta ? String(args.managementToken || "") : makeManagementToken();
    const snapshot = createPublicWikiSnapshot({
      publicId,
      record: args.record,
      visibility,
      publishedAt,
      updatedAt: now,
    });
    const pageIds = snapshot.wiki.structure.pages
      .map((page) => page.id)
      .filter((pageId) => snapshot.wiki.pages[pageId]);
    const meta = {
      ...snapshot,
      tokenHash: existingMeta?.tokenHash || hashToken(managementToken),
      pageIds,
      wiki: {
        ...snapshot.wiki,
        pages: {},
      },
    };

    await this.pipeline([
      ["SET", this.metaKey(publicId), JSON.stringify(meta)],
      ...pageIds.map((pageId) => ["SET", this.pageKey(publicId, pageId), JSON.stringify(snapshot.wiki.pages[pageId])]),
    ]);

    const baseUrl = args.baseUrl || publicWikiBaseUrlFromEnv();
    return {
      snapshot,
      publication: publicWikiPublicationFromSnapshot(snapshot, baseUrl),
      managementToken: existingMeta ? undefined : managementToken,
    };
  }

  async unpublish(args) {
    const publicId = normalizePublicWikiId(args.publicId);
    if (!publicId) throw new Error("Invalid public wiki id.");
    const meta = await this.getMeta(publicId);
    this.assertAuthorized(publicId, meta, args.managementToken);
    const now = new Date().toISOString();
    const pageIds = Array.isArray(meta?.pageIds) ? meta.pageIds : [];
    await this.pipeline([
      ["SET", this.metaKey(publicId), JSON.stringify({ ...meta, published: false, updatedAt: now, unpublishedAt: now })],
      ...(pageIds.length ? [["DEL", ...pageIds.map((pageId) => this.pageKey(publicId, pageId))]] : []),
    ]);
    return {
      publication: {
        published: false,
        publicId,
        publicPath: null,
        publicUrl: null,
        publishedAt: meta?.publishedAt || null,
        updatedAt: now,
        unpublishedAt: now,
        title: meta?.title || null,
        readOnly: true,
        visibility: normalizePublicWikiVisibility(meta?.visibility),
      },
    };
  }

  async list(opts = {}) {
    const pageSize = clampInteger(opts.pageSize, 1, 48, 12);
    const requestedPage = clampInteger(opts.page, 1, 100000, 1);
    const query = normalizeSearchQuery(opts.q);
    const format = normalizeFacetValue(opts.format);
    const pageRange = normalizeFacetValue(opts.pages);
    const sort = normalizeGallerySort(opts.sort);
    const allItems = await this.allPublicItems({ maxKeys: 2500 });
    const searchedItems = query
      ? allItems.filter((item) => publicWikiGalleryItemMatchesQuery(item, query))
      : allItems;
    const surface = normalizePublicGallerySurface(opts.surface);
    const filteredItems = searchedItems.filter((item) => {
      if (surface && item.surface !== surface) return false;
      if (format && item.format !== format) return false;
      if (pageRange && pageRangeForCount(item.pages) !== pageRange) return false;
      return true;
    });

    filteredItems.sort((left, right) => compareGalleryItems(left, right, sort));
    const total = filteredItems.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const start = (page - 1) * pageSize;
    const items = filteredItems.slice(start, start + pageSize).map(({ searchText, ...item }) => item);

    return {
      items,
      pagination: {
        page,
        pageSize,
        total,
        pageCount,
        hasNext: page < pageCount,
        hasPrevious: page > 1,
      },
      facets: galleryFacets(searchedItems),
      filters: {
        q: query,
        format,
        pages: pageRange,
        surface,
      },
      sort,
    };
  }

  async allPublicItems(opts = {}) {
    const maxKeys = clampInteger(opts.maxKeys, 1, 50000, 2500);
    const sort = normalizeGallerySort(opts.sort || "updated");
    const keys = await this.scanMetaKeys(maxKeys);
    const metas = await this.loadMetas(keys);
    return metas
      .map(publicWikiGalleryItemFromMeta)
      .filter(Boolean)
      .sort((left, right) => compareGalleryItems(left, right, sort));
  }

  async loadMetas(keys) {
    const metas = [];
    for (let index = 0; index < keys.length; index += 100) {
      const batch = keys.slice(index, index + 100);
      if (!batch.length) continue;
      const raws = await this.command(["MGET", ...batch]);
      (Array.isArray(raws) ? raws : []).forEach((raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") metas.push(parsed);
        } catch {
          // Ignore malformed rows rather than exposing storage details.
        }
      });
    }
    return metas;
  }

  async scanMetaKeys(maxKeys) {
    const keys = [];
    let cursor = "0";
    let iterations = 0;
    const maxIterations = Math.max(1000, Math.ceil(maxKeys / 50) + 20);
    do {
      const result = await this.command(["SCAN", cursor, "MATCH", `${KEY_PREFIX}:*:meta`, "COUNT", 100]);
      cursor = String(Array.isArray(result) ? result[0] || "0" : "0");
      const batch = Array.isArray(result) && Array.isArray(result[1]) ? result[1] : [];
      batch.forEach((key) => {
        if (typeof key === "string" && keys.length < maxKeys) keys.push(key);
      });
      iterations += 1;
    } while (cursor !== "0" && keys.length < maxKeys && iterations < maxIterations);
    return keys;
  }

  async getMeta(publicId) {
    const raw = await this.command(["GET", this.metaKey(publicId)]);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  assertAuthorized(publicId, meta, token) {
    if (!meta) throw new Error("Public wiki not found.");
    const provided = String(token || "");
    if (!provided || !safeEqual(hashToken(provided), meta.tokenHash)) {
      throw new Error(`Publish token rejected for ${publicId}.`);
    }
  }

  async command(command) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) throw new Error(json.error || `Upstash request failed with HTTP ${response.status}.`);
    return json.result;
  }

  async pipeline(commands) {
    if (!commands.length) return [];
    const response = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    const json = await response.json().catch(() => []);
    if (!response.ok) throw new Error(`Upstash pipeline failed with HTTP ${response.status}.`);
    const failed = Array.isArray(json) ? json.find((item) => item?.error) : null;
    if (failed?.error) throw new Error(failed.error);
    return Array.isArray(json) ? json : [];
  }

  metaKey(publicId) {
    return `${KEY_PREFIX}:${publicId}:meta`;
  }

  pageKey(publicId, pageId) {
    const safePageId = String(pageId || "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "page";
    return `${KEY_PREFIX}:${publicId}:page:${safePageId}`;
  }
}

function normalizePublicGallerySurface(value) {
  const clean = String(value || "").trim().toLowerCase();
  return clean === "wiki" || clean === "docs" ? clean : "";
}

function createPublicWikiSnapshot(args) {
  const publicId = normalizePublicWikiId(args.publicId);
  if (!publicId) throw new Error("Invalid public wiki id.");
  const wiki = sanitizePublicWikiRecord(args.record);
  const now = new Date().toISOString();
  return {
    schemaVersion: PUBLIC_WIKI_SCHEMA_VERSION,
    publicId,
    published: true,
    visibility: normalizePublicWikiVisibility(args.visibility),
    surface: publicWikiSurfaceFromRecord(wiki),
    readOnly: true,
    owner: wiki.owner,
    repo: wiki.repo,
    branch: wiki.branch ?? null,
    title: wiki.structure.title,
    description: wiki.structure.description,
    generatedAt: wiki.generatedAt,
    publishedAt: args.publishedAt || now,
    updatedAt: args.updatedAt || now,
    wiki,
  };
}

function sanitizePublicWikiRecord(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid wiki record.");
  const record = value;
  const structure = sanitizeStructure(record.structure);
  const pageIds = new Set(structure.pages.map((page) => page.id));
  const pages = {};
  Object.entries(record.pages || {}).forEach(([pageId, page]) => {
    if (!pageIds.has(pageId) || !page || typeof page !== "object") return;
    pages[pageId] = {
      id: String(page.id || pageId),
      content: String(page.content || ""),
      generatedAt: String(page.generatedAt || record.generatedAt || new Date().toISOString()),
    };
  });
  return {
    id: cleanOptional(record.id),
    repoUrl: safePublicRepoUrl(record.repoUrl),
    owner: requiredText(record.owner, "owner"),
    repo: requiredText(record.repo, "repo"),
    repos: sanitizeRepos(record.repos),
    branch: record.branch == null ? null : String(record.branch),
    sourceKey: cleanOptional(record.sourceKey),
    variantKey: cleanOptional(record.variantKey),
    createdAt: cleanOptional(record.createdAt),
    updatedAt: cleanOptional(record.updatedAt),
    generatedAt: requiredText(record.generatedAt, "generatedAt"),
    model: requiredText(record.model, "model"),
    structureModel: cleanOptional(record.structureModel),
    pageModel: cleanOptional(record.pageModel),
    runtime: cleanOptional(record.runtime),
    runtimeModelLabel: cleanOptional(record.runtimeModelLabel),
    wikiDepth: cleanOptional(record.wikiDepth),
    wikiPageCount: Number.isFinite(Number(record.wikiPageCount)) ? Number(record.wikiPageCount) : undefined,
    wikiPageCountMode: record.wikiPageCountMode === "fixed" ? "fixed" : "auto",
    wikiStyle: cleanOptional(record.wikiStyle),
    wikiLanguages: Array.isArray(record.wikiLanguages) ? record.wikiLanguages.map(String) : undefined,
    structure,
    pages,
  };
}

function sanitizeStructure(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid wiki structure.");
  const pages = Array.isArray(value.pages) ? value.pages.map(sanitizeStructurePage) : [];
  const pageIds = new Set(pages.map((page) => page.id));
  return {
    title: requiredText(value.title, "structure.title"),
    description: String(value.description || ""),
    sections: (Array.isArray(value.sections) ? value.sections : []).map((section) => ({
      id: requiredText(section?.id, "section.id"),
      title: requiredText(section?.title, "section.title"),
      pages: Array.isArray(section?.pages) ? section.pages.map(String).filter((pageId) => pageIds.has(pageId)) : [],
      subsections: Array.isArray(section?.subsections) ? section.subsections.map(String) : [],
    })),
    pages,
  };
}

function sanitizeStructurePage(page) {
  if (!page || typeof page !== "object") throw new Error("Invalid wiki page.");
  return {
    id: requiredText(page.id, "page.id"),
    title: requiredText(page.title, "page.title"),
    description: String(page.description || ""),
    importance: ["high", "medium", "low"].includes(page.importance) ? page.importance : "medium",
    filePaths: Array.isArray(page.filePaths) ? page.filePaths.map(safeSourcePath).filter(Boolean) : [],
    relatedPages: Array.isArray(page.relatedPages) ? page.relatedPages.map(String) : [],
    parentSection: cleanOptional(page.parentSection),
  };
}

function sanitizeRepos(repos) {
  if (!Array.isArray(repos) || !repos.length) return undefined;
  return repos.map((repo) => ({
    id: requiredText(repo?.id, "repo.id"),
    owner: requiredText(repo?.owner, "repo.owner"),
    repo: requiredText(repo?.repo, "repo.repo"),
    label: requiredText(repo?.label, "repo.label"),
    url: safePublicRepoUrl(repo?.url),
    branch: repo?.branch == null ? null : String(repo.branch),
  }));
}

export function publicWikiGalleryItemFromMeta(meta) {
  if (!meta || typeof meta !== "object" || meta.published !== true) return null;
  if (normalizePublicWikiVisibility(meta.visibility) !== "public") return null;
  const wiki = meta.wiki && typeof meta.wiki === "object" ? meta.wiki : {};
  const structure = wiki.structure && typeof wiki.structure === "object" ? wiki.structure : {};
  const repoUrl = safePublicRepoUrl(wiki.repoUrl) || firstRepoUrl(wiki.repos);
  if (!repoUrl) return null;
  const publicId = normalizePublicWikiId(meta.publicId);
  if (!publicId) return null;

  const owner = cleanOptional(meta.owner) || cleanOptional(wiki.owner) || repoUrlOwner(repoUrl);
  const repo = cleanOptional(meta.repo) || cleanOptional(wiki.repo) || repoUrlRepo(repoUrl);
  const title = plainText(meta.title || structure.title || `${owner}/${repo}`, 120);
  const description = plainText(meta.description || structure.description || "A source-grounded public repository wiki.", 220);
  const pages = pageCountFromMeta(meta, structure);
  const sourceFiles = sourceFileCount(structure);
  const format = normalizeWikiStyle(wiki.wikiStyle || "technical");
  const surface = publicWikiSurfaceFromSnapshot(meta);
  const runtime = plainText(wiki.runtimeModelLabel || wiki.pageModel || wiki.structureModel || wiki.model || "Runtime", 80);
  const pageText = Array.isArray(structure.pages)
    ? structure.pages.map((page) => `${page?.title || ""} ${page?.description || ""}`).join(" ")
    : "";
  const repository = `${owner}/${repo}`;

  return {
    publicId,
    href: publicWikiPath(publicId, "public", surface),
    surface,
    title,
    description,
    owner,
    repo,
    repository,
    repoUrl,
    branch: meta.branch || wiki.branch || null,
    format,
    formatLabel: wikiStyleLabel(format),
    runtime,
    pages,
    sourceFiles,
    publishedAt: cleanOptional(meta.publishedAt) || null,
    updatedAt: cleanOptional(meta.updatedAt) || cleanOptional(meta.publishedAt) || null,
    generatedAt: cleanOptional(meta.generatedAt) || cleanOptional(wiki.generatedAt) || null,
    searchText: normalizeSearchQuery(`${title} ${description} ${repository} ${runtime} ${wikiStyleLabel(format)} ${pageText}`),
  };
}

export function publicWikiGalleryItemMatchesQuery(item, value) {
  const query = normalizeSearchQuery(value);
  if (!query) return true;
  if (String(item?.searchText || "").includes(query)) return true;

  const repository = normalizeSearchQuery(item?.repository || `${item?.owner || ""}/${item?.repo || ""}`);
  if (repository && (repository === query || repository.includes(query))) return true;

  const compactQuery = compactSearchQuery(query);
  if (compactQuery.length >= 3) {
    const compactRepository = compactSearchQuery(repository);
    if (compactRepository && compactRepository.includes(compactQuery)) return true;
  }

  return false;
}

function galleryFacets(items) {
  const formatMap = new Map();
  const pageMap = new Map();
  items.forEach((item) => {
    addFacet(formatMap, item.format, item.formatLabel);
    const range = pageRangeForCount(item.pages);
    addFacet(pageMap, range, pageRangeLabel(range));
  });
  return {
    formats: [...formatMap.values()].sort((left, right) => left.label.localeCompare(right.label)),
    pageRanges: ["compact", "standard", "deep"]
      .map((value) => pageMap.get(value) || { value, label: pageRangeLabel(value), count: 0 })
      .filter((facet) => facet.count > 0),
  };
}

function addFacet(map, value, label) {
  const key = normalizeFacetValue(value);
  if (!key) return;
  const current = map.get(key) || { value: key, label: label || key, count: 0 };
  current.count += 1;
  map.set(key, current);
}

function compareGalleryItems(left, right, sort) {
  if (sort === "title") return left.title.localeCompare(right.title) || compareDateDesc(left.updatedAt, right.updatedAt);
  if (sort === "pages") return (right.pages - left.pages) || compareDateDesc(left.updatedAt, right.updatedAt);
  if (sort === "published") return compareDateDesc(left.publishedAt, right.publishedAt) || left.title.localeCompare(right.title);
  return compareDateDesc(left.updatedAt, right.updatedAt) || compareDateDesc(left.publishedAt, right.publishedAt);
}

function compareDateDesc(left, right) {
  return timestamp(right) - timestamp(left);
}

function timestamp(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function pageCountFromMeta(meta, structure) {
  if (Array.isArray(meta.pageIds) && meta.pageIds.length) return meta.pageIds.length;
  if (Array.isArray(structure.pages)) return structure.pages.length;
  const count = Number(meta.wiki?.wikiPageCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function sourceFileCount(structure) {
  const files = new Set();
  if (!Array.isArray(structure.pages)) return 0;
  structure.pages.forEach((page) => {
    if (!Array.isArray(page?.filePaths)) return;
    page.filePaths.forEach((file) => {
      const safe = safeSourcePath(file);
      if (safe) files.add(safe);
    });
  });
  return files.size;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validIsoDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function firstRepoUrl(repos) {
  if (!Array.isArray(repos)) return "";
  for (const repo of repos) {
    const url = safePublicRepoUrl(repo?.url);
    if (url) return url;
  }
  return "";
}

function repoUrlOwner(url) {
  return String(url || "").match(/^https:\/\/github\.com\/([^/\s]+)\/[^/\s]+/i)?.[1] || "github";
}

function repoUrlRepo(url) {
  return String(url || "").match(/^https:\/\/github\.com\/[^/\s]+\/([^/\s]+)/i)?.[1] || "repo";
}

function normalizeSearchQuery(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

function compactSearchQuery(value) {
  return normalizeSearchQuery(value).replace(/[^a-z0-9]+/g, "");
}

function normalizeFacetValue(value) {
  return String(value || "").trim().toLowerCase().slice(0, 80);
}

function normalizeGallerySort(value) {
  const sort = normalizeFacetValue(value);
  return ["updated", "published", "title", "pages"].includes(sort) ? sort : "updated";
}

function clampInteger(value, min, max, fallback) {
  const integer = Math.trunc(Number(value));
  if (!Number.isFinite(integer)) return fallback;
  return Math.min(max, Math.max(min, integer));
}

function pageRangeForCount(count) {
  const pages = Number(count) || 0;
  if (pages <= 4) return "compact";
  if (pages <= 8) return "standard";
  return "deep";
}

function pageRangeLabel(value) {
  if (value === "compact") return "1-4 pages";
  if (value === "deep") return "9+ pages";
  return "5-8 pages";
}

function normalizeWikiStyle(value) {
  const text = String(value || "").trim();
  const legacy = {
    functional: "feature-scout",
    wlog: "socratic-exploration",
    design: "worth-stealing",
  };
  const normalized = text.startsWith("custom:") ? "custom" : legacy[text] || text || "technical";
  const known = new Set([
    "basic",
    "technical",
    "first-30",
    "eli5",
    "mental-model",
    "socratic-exploration",
    "feature-scout",
    "worth-stealing",
    "hidden-quirks",
    "pattern-discovery",
    "repo-comparison",
    "debugging-atlas",
    "tech-reader",
    "documentation",
    "custom",
  ]);
  return known.has(normalized) ? normalized : "technical";
}

function wikiStyleLabel(value) {
  return {
    basic: "Basic",
    technical: "Technical",
    "first-30": "First 30 Minutes",
    eli5: "Explain Like I'm 5",
    "mental-model": "Mental Model",
    "socratic-exploration": "Socratic Exploration",
    "feature-scout": "Feature Scout",
    "worth-stealing": "Worth Stealing",
    "hidden-quirks": "Hidden Quirks",
    "pattern-discovery": "Pattern Discovery",
    "repo-comparison": "Repo Comparison",
    "debugging-atlas": "Debugging Atlas",
    "tech-reader": "Tech Reader Brief",
    documentation: "Documentation",
    custom: "Custom",
  }[normalizeWikiStyle(value)] || "Technical";
}

function publicWikiPublicationFromSnapshot(snapshot, baseUrl) {
  const surface = publicWikiSurfaceFromSnapshot(snapshot);
  const publicPath = publicWikiPath(snapshot.publicId, snapshot.visibility, surface);
  return {
    published: true,
    publicId: snapshot.publicId,
    publicPath,
    publicUrl: `${baseUrl.replace(/\/+$/, "")}${publicPath}`,
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
    title: snapshot.title,
    readOnly: true,
    visibility: normalizePublicWikiVisibility(snapshot.visibility),
    surface,
  };
}

function makePublicWikiId(owner, repo) {
  const prefix = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "wiki";
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function makePrivateWikiId() {
  return `private-${randomBytes(16).toString("hex")}`;
}

function cleanOptional(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

function requiredText(value, field) {
  const text = cleanOptional(value);
  if (!text) throw new Error(`Missing ${field}.`);
  return text;
}

function safePublicRepoUrl(value) {
  const text = String(value || "").trim();
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/i.test(text) ? text.replace(/\/$/, "") : "";
}

function safeSourcePath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:\//.test(text)) return "";
  if (text.split("/").some((part) => part === "..")) return "";
  return text.slice(0, 260);
}

function makeManagementToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
