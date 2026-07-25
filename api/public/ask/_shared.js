import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  escapeHtml,
  plainText,
  publicWikiBaseUrl,
  publicWikiBaseUrlFromEnv,
  slugPathPart,
} from "../wiki/_shared.js";

export { errorMessage, errorStatus, requestBody, setCors, publicWikiBaseUrl } from "../wiki/_shared.js";

const PUBLIC_ASK_SCHEMA_VERSION = 1;
const KEY_PREFIX = "gw:public:ask";

const MAX_TURNS = 200;
const MAX_QUESTION_CHARS = 4_000;
const MAX_ANSWER_CHARS = 200_000;
const MAX_CLARIFICATIONS = 20;
const MAX_SOURCES = 120;
const MAX_EXCERPT_CHARS = 2_000;
const MAX_SCOPES = 8;
const MAX_RECORD_BYTES = 4_000_000;

export function normalizePublicAskId(value) {
  const clean = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,95}$/.test(clean) ? clean : "";
}

export function normalizePublicAskVisibility(value) {
  return value === "private" ? "private" : "public";
}

export function publicAskPath(publicId, visibility) {
  const prefix = normalizePublicAskVisibility(visibility) === "private" ? "/share/ask" : "/public/ask";
  return `${prefix}/${encodeURIComponent(publicId)}`;
}

export function publicAskOgImageUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rlm-wiki-preview.png`;
}

export function makePublicAskId(title) {
  const prefix = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "ask";
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function makePrivateAskId() {
  return `private-${randomBytes(16).toString("hex")}`;
}

export function publicAskPublicationFromSnapshot(snapshot, baseUrl) {
  const origin = String(baseUrl || publicWikiBaseUrlFromEnv()).replace(/\/+$/, "");
  return {
    published: true,
    publicId: snapshot.publicId,
    publicPath: publicAskPath(snapshot.publicId, snapshot.visibility),
    publicUrl: `${origin}${publicAskPath(snapshot.publicId, snapshot.visibility)}`,
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
    title: snapshot.title,
    readOnly: true,
    visibility: normalizePublicAskVisibility(snapshot.visibility),
    recordVersion: String(snapshot.ask?.askedAt || ""),
  };
}

export function sanitizePublicAskRecord(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid ask record.");
  if (JSON.stringify(value).length > MAX_RECORD_BYTES) throw new Error("Ask conversation is too large to share.");
  const record = value;
  const turns = [];
  for (const raw of Array.isArray(record.turns) ? record.turns : []) {
    if (!raw || typeof raw !== "object") continue;
    const question = collapseWhitespace(raw.question).slice(0, MAX_QUESTION_CHARS);
    const answer = String(raw.answer || "").trim().slice(0, MAX_ANSWER_CHARS);
    if (!question || !answer) continue;
    const clarifications = sanitizeClarifications(raw.clarifications);
    turns.push({
      question,
      answer,
      ...(validIsoDate(raw.askedAt) ? { askedAt: validIsoDate(raw.askedAt) } : {}),
      ...(clarifications.length ? { clarifications } : {}),
    });
    if (turns.length >= MAX_TURNS) break;
  }
  if (!turns.length) throw new Error("Invalid ask record: no completed turns.");

  const title = collapseWhitespace(record.title).slice(0, 160) || titleFromQuestion(turns[0].question);
  const scopes = (Array.isArray(record.scopes) ? record.scopes : [])
    .map(shareSafeScopeLabel)
    .filter(Boolean)
    .slice(0, MAX_SCOPES);
  const repoName = shareSafeScopeLabel(record.repoName);

  return {
    id: cleanOptional(record.id),
    title,
    description: collapseWhitespace(record.description).slice(0, 220) || turns[0].question.slice(0, 220),
    ...(repoName ? { repoName } : {}),
    ...(scopes.length ? { scopes } : {}),
    runtime: cleanOptional(record.runtime),
    model: cleanOptional(record.model),
    ...(validIsoDate(record.askedAt) ? { askedAt: validIsoDate(record.askedAt) } : {}),
    turns,
    sources: sanitizeSources(record.sources),
  };
}

function sanitizeClarifications(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const question = collapseWhitespace(raw.question).slice(0, 2_000);
    const answer = collapseWhitespace(raw.answer).slice(0, 2_000);
    if (!question) continue;
    items.push({ question, answer });
    if (items.length >= MAX_CLARIFICATIONS) break;
  }
  return items;
}

function sanitizeSources(value) {
  if (!Array.isArray(value) || !value.length) return undefined;
  const items = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const path = shareSafeSourcePath(raw.path);
    if (!path) continue;
    const label = collapseWhitespace(raw.label).slice(0, 200);
    const detail = collapseWhitespace(raw.detail).slice(0, 300);
    const excerpt = String(raw.excerpt || "").trim().slice(0, MAX_EXCERPT_CHARS);
    items.push({
      path,
      ...(label && label !== path ? { label } : {}),
      ...(detail ? { detail } : {}),
      ...(excerpt ? { excerpt } : {}),
    });
    if (items.length >= MAX_SOURCES) break;
  }
  return items.length ? items : undefined;
}

export function shareSafeScopeLabel(value) {
  const text = collapseWhitespace(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text.length <= 200 ? text : "";
  const normalized = text.replace(/\\/g, "/");
  if (/^(?:\/|~|[A-Za-z]:\/|file:)/i.test(normalized)) {
    const parts = normalized.replace(/^file:\/*/i, "").split("/").filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail ? `…/${tail}` : "";
  }
  return text.slice(0, 200);
}

export function shareSafeSourcePath(value) {
  const text = collapseWhitespace(value).replace(/\\/g, "/");
  if (!text) return "";
  if (/^(?:\/|~|[A-Za-z]:\/|file:)/i.test(text)) {
    const parts = text.replace(/^file:\/*/i, "").split("/").filter(Boolean);
    const tail = parts.slice(-3).join("/");
    return tail ? `…/${tail}` : "";
  }
  if (text.split("/").some((part) => part === "..")) return "";
  return text.slice(0, 260);
}

export function createPublicAskSnapshot(args) {
  const publicId = normalizePublicAskId(args.publicId);
  if (!publicId) throw new Error("Invalid public ask id.");
  const ask = sanitizePublicAskRecord(args.record);
  const now = new Date().toISOString();
  return {
    schemaVersion: PUBLIC_ASK_SCHEMA_VERSION,
    publicId,
    published: true,
    visibility: normalizePublicAskVisibility(args.visibility),
    surface: "ask",
    readOnly: true,
    title: ask.title,
    description: ask.description || "",
    repoName: ask.repoName,
    runtime: ask.runtime,
    model: ask.model,
    turnCount: ask.turns.length,
    askedAt: ask.askedAt,
    publishedAt: args.publishedAt || now,
    updatedAt: args.updatedAt || now,
    ask,
  };
}

export function publicAskMarkdownUrls(baseUrl, snapshot) {
  const origin = String(baseUrl || publicWikiBaseUrlFromEnv()).replace(/\/+$/, "");
  const publicId = normalizePublicAskId(snapshot?.publicId);
  const visibility = normalizePublicAskVisibility(snapshot?.visibility);
  const canonicalPath = publicAskPath(publicId, visibility);
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
  };
}

export function publicAskMarkdownIndex(snapshot, baseUrl) {
  const context = publicAskMarkdownContext(snapshot, baseUrl);
  const lines = [
    `# ${context.title}`,
    "",
    context.description ? `> ${context.description}` : "",
    "",
    "This is a shared rlm-wiki Ask conversation: a question and answer session grounded in repository evidence. Use the complete Markdown link when an agent needs the full transcript.",
    "",
    "## Context Links",
    "",
    `- ${markdownLink("Complete Markdown transcript", context.urls.llmsFullUrl)}`,
    `- ${markdownLink("Complete Markdown alias", context.urls.markdownUrl)}`,
    `- ${markdownLink("Human interactive conversation", context.urls.canonicalUrl)}`,
    "",
    "## Conversation",
    "",
    ...context.metadataLines,
    "",
    "## Questions",
    "",
    context.turns.length
      ? context.turns.map((turn, index) => `- ${String(index + 1).padStart(2, "0")}. ${inlineMarkdown(turn.question)}`).join("\n")
      : "- No answered questions are available.",
    "",
    context.sources.length ? "## Sources" : "",
    "",
    context.sources.length ? context.sources.map((source) => `- \`${escapeMarkdownCode(source.path)}\``).join("\n") : "",
    "",
  ];
  return cleanMarkdown(lines);
}

export function publicAskMarkdownFull(snapshot, baseUrl) {
  const context = publicAskMarkdownContext(snapshot, baseUrl);
  const lines = [
    `# ${context.title}`,
    "",
    context.description ? `> ${context.description}` : "",
    "",
    "## Context Links",
    "",
    `- ${markdownLink("Agent index", context.urls.llmsUrl)}`,
    `- ${markdownLink("Human interactive conversation", context.urls.canonicalUrl)}`,
    "",
    "## Conversation Metadata",
    "",
    ...context.metadataLines,
    "",
    "## Question Index",
    "",
    context.turns.length
      ? context.turns.map((turn, index) => `- ${String(index + 1).padStart(2, "0")}. ${inlineMarkdown(turn.question)}`).join("\n")
      : "- No answered questions are available.",
    "",
    "---",
    "",
    ...context.turns.flatMap((turn, index) => publicAskTurnSection(turn, index)),
    context.sources.length ? "## Sources" : "",
    "",
    ...context.sources.flatMap((source) => publicAskSourceLines(source)),
    "",
  ];
  return cleanMarkdown(lines);
}

function publicAskTurnSection(turn, index) {
  const heading = plainText(turn.question, 110);
  const truncated = heading !== collapseWhitespace(turn.question);
  const clarifications = Array.isArray(turn.clarifications) ? turn.clarifications : [];
  return [
    `## Q${index + 1}: ${inlineMarkdown(heading)}`,
    "",
    truncated ? `**Full question:** ${inlineMarkdown(turn.question)}` : "",
    truncated ? "" : "",
    clarifications.length ? "**Clarified before answering:**" : "",
    clarifications.length
      ? clarifications.map((entry) => `- ${inlineMarkdown(entry.question)}: ${inlineMarkdown(entry.answer || "(not answered)")}`).join("\n")
      : "",
    clarifications.length ? "" : "",
    "### Answer",
    "",
    normalizeMarkdownBody(turn.answer) || "_No answer content was available._",
    "",
    "---",
    "",
  ];
}

function publicAskSourceLines(source) {
  const label = source.label && source.label !== source.path ? `${source.label} (\`${escapeMarkdownCode(source.path)}\`)` : `\`${escapeMarkdownCode(source.path)}\``;
  return [`- ${label}${source.detail ? ` - ${inlineMarkdown(source.detail)}` : ""}`];
}

function publicAskMarkdownContext(snapshot, baseUrl) {
  const ask = snapshot?.ask && typeof snapshot.ask === "object" ? snapshot.ask : {};
  const turns = Array.isArray(ask.turns) ? ask.turns : [];
  const sources = Array.isArray(ask.sources) ? ask.sources : [];
  const urls = publicAskMarkdownUrls(baseUrl, snapshot);
  const scopeLine = Array.isArray(ask.scopes) && ask.scopes.length ? ask.scopes.join(", ") : String(ask.repoName || snapshot?.repoName || "");
  const metadataLines = [
    scopeLine ? `- Scope: ${inlineMarkdown(scopeLine)}` : "",
    ask.runtime || snapshot?.runtime ? `- Runtime: ${inlineMarkdown(ask.runtime || snapshot.runtime)}` : "",
    ask.model || snapshot?.model ? `- Model: ${inlineMarkdown(ask.model || snapshot.model)}` : "",
    snapshot?.askedAt ? `- Asked: ${inlineMarkdown(snapshot.askedAt)}` : "",
    snapshot?.publishedAt ? `- Shared: ${inlineMarkdown(snapshot.publishedAt)}` : "",
    snapshot?.updatedAt ? `- Updated: ${inlineMarkdown(snapshot.updatedAt)}` : "",
    `- Turns: ${turns.length}`,
  ].filter(Boolean);
  return {
    title: plainText(snapshot?.title || ask.title || "Shared Ask conversation", 160),
    description: plainText(snapshot?.description || ask.description || turns[0]?.question || "", 220),
    urls,
    turns,
    sources,
    metadataLines,
  };
}

export function publicAskMarkdownFileName(snapshot, suffix = "ask.md") {
  const slug = slugPathPart(snapshot?.title || "conversation");
  const cleanSuffix = String(suffix || "ask.md").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || "ask.md";
  return `${slug}-${cleanSuffix}`;
}

export function publicAskAgentHtmlFallback(snapshot, baseUrl) {
  const context = publicAskMarkdownContext(snapshot, baseUrl);
  const fullMarkdown = publicAskMarkdownFull(snapshot, baseUrl);
  const visibleTurns = context.turns.slice(0, 12);
  return `
      <article class="public-wiki-agent-fallback" data-agent-readable="true" aria-label="Agent-readable rlm-wiki Ask conversation fallback">
        <header class="public-wiki-agent-head">
          <p class="public-wiki-agent-kicker">Agent-readable conversation</p>
          <h1>${escapeHtml(context.title)}</h1>
          ${context.description ? `<p>${escapeHtml(context.description)}</p>` : ""}
        </header>
        <nav class="public-wiki-agent-links" aria-label="Markdown links">
          <a href="${escapeHtml(context.urls.llmsFullPath)}">Full Markdown</a>
          <a href="${escapeHtml(context.urls.llmsPath)}">llms.txt</a>
          <a href="${escapeHtml(context.urls.markdownPath)}">Markdown alias</a>
        </nav>
        <section class="public-wiki-agent-pages" aria-label="Conversation questions">
          <h2>Questions</h2>
          <ol>
            ${visibleTurns.map((turn) => `<li>${escapeHtml(plainText(turn.question, 160))}</li>`).join("")}
          </ol>
        </section>
        <section class="public-wiki-agent-markdown" aria-label="Complete Markdown fallback">
          <h2>Complete Markdown</h2>
          <pre>${escapeHtml(fullMarkdown)}</pre>
        </section>
      </article>`;
}

export class UpstashPublicAskStore {
  constructor(opts = {}) {
    this.url = String(opts.url || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
    this.token = String(opts.token || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
    if (!this.url || !this.token) {
      throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for public ask publishing.");
    }
  }

  async get(publicId) {
    const id = normalizePublicAskId(publicId);
    if (!id) return null;
    const meta = await this.getMeta(id);
    if (!meta || meta.published !== true) return null;
    const turnCount = Number.isFinite(Number(meta.turnCount)) ? Number(meta.turnCount) : 0;
    const turnResults = turnCount > 0
      ? await this.command(["MGET", ...Array.from({ length: turnCount }, (_, index) => this.turnKey(id, index))])
      : [];
    const turns = [];
    (Array.isArray(turnResults) ? turnResults : []).forEach((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.question === "string") {
          turns.push(parsed);
        }
      } catch {
        // A corrupt turn should not expose raw storage.
      }
    });
    return {
      schemaVersion: meta.schemaVersion,
      publicId: id,
      published: true,
      visibility: normalizePublicAskVisibility(meta.visibility),
      surface: "ask",
      readOnly: true,
      title: meta.title,
      description: meta.description,
      repoName: meta.repoName,
      runtime: meta.runtime,
      model: meta.model,
      turnCount: turns.length,
      askedAt: meta.askedAt,
      publishedAt: meta.publishedAt,
      updatedAt: meta.updatedAt,
      ask: {
        ...meta.ask,
        turns,
      },
    };
  }

  async publish(args) {
    const existingId = normalizePublicAskId(args.publicId);
    const existingMeta = existingId ? await this.getMeta(existingId) : null;
    if (existingId) this.assertAuthorized(existingId, existingMeta, args.managementToken);

    const visibility = args.visibility == null && existingMeta
      ? normalizePublicAskVisibility(existingMeta.visibility)
      : normalizePublicAskVisibility(args.visibility);
    const publicId = existingId || (visibility === "private"
      ? makePrivateAskId()
      : makePublicAskId(String(args.record?.title || "ask")));
    const now = new Date().toISOString();
    const publishedAt = existingMeta?.publishedAt || now;
    const managementToken = existingMeta ? String(args.managementToken || "") : makeManagementToken();
    const snapshot = createPublicAskSnapshot({
      publicId,
      record: args.record,
      visibility,
      publishedAt,
      updatedAt: now,
    });
    const previousTurnCount = Number.isFinite(Number(existingMeta?.turnCount)) ? Number(existingMeta.turnCount) : 0;
    const meta = {
      ...snapshot,
      tokenHash: existingMeta?.tokenHash || hashToken(managementToken),
      ask: {
        ...snapshot.ask,
        turns: [],
      },
    };

    await this.pipeline([
      ["SET", this.metaKey(publicId), JSON.stringify(meta)],
      ...snapshot.ask.turns.map((turn, index) => ["SET", this.turnKey(publicId, index), JSON.stringify(turn)]),
      // A re-publish with fewer turns must not leave stale tail turns readable.
      ...(previousTurnCount > snapshot.ask.turns.length
        ? [["DEL", ...Array.from(
            { length: previousTurnCount - snapshot.ask.turns.length },
            (_, index) => this.turnKey(publicId, snapshot.ask.turns.length + index),
          )]]
        : []),
    ]);

    const baseUrl = args.baseUrl || publicWikiBaseUrlFromEnv();
    return {
      snapshot,
      publication: publicAskPublicationFromSnapshot(snapshot, baseUrl),
      managementToken: existingMeta ? undefined : managementToken,
    };
  }

  async unpublish(args) {
    const publicId = normalizePublicAskId(args.publicId);
    if (!publicId) throw new Error("Invalid public ask id.");
    const meta = await this.getMeta(publicId);
    this.assertAuthorized(publicId, meta, args.managementToken);
    const now = new Date().toISOString();
    const turnCount = Number.isFinite(Number(meta?.turnCount)) ? Number(meta.turnCount) : 0;
    await this.pipeline([
      ["SET", this.metaKey(publicId), JSON.stringify({ ...meta, published: false, updatedAt: now, unpublishedAt: now })],
      ...(turnCount > 0
        ? [["DEL", ...Array.from({ length: turnCount }, (_, index) => this.turnKey(publicId, index))]]
        : []),
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
        visibility: normalizePublicAskVisibility(meta?.visibility),
      },
    };
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
    if (!meta) throw new Error("Public ask not found.");
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

  turnKey(publicId, index) {
    return `${KEY_PREFIX}:${publicId}:turn:${Number(index) || 0}`;
  }
}

function titleFromQuestion(question) {
  const words = collapseWhitespace(question).split(" ").filter(Boolean);
  const short = words.slice(0, 8).join(" ");
  return (words.length > 8 ? `${short}…` : short) || "Shared Ask";
}

function validIsoDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanOptional(value) {
  const text = collapseWhitespace(value);
  return text || undefined;
}

function markdownLink(label, url) {
  return `[${inlineMarkdown(label)}](${url})`;
}

function inlineMarkdown(value) {
  return collapseWhitespace(value).replace(/([\[\]])/g, "\\$1");
}

function escapeMarkdownCode(value) {
  return String(value || "").replace(/`/g, "'");
}

function normalizeMarkdownBody(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function cleanMarkdown(lines) {
  return lines
    .map((line) => (line == null ? "" : String(line)))
    .join("\n")
    .split("\n")
    .filter((line, index, all) => line || all[index - 1] !== "")
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd() + "\n";
}

function makeManagementToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
