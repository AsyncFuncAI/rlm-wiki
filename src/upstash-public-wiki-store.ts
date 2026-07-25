/// <reference types="node" />

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createPublicWikiSnapshot,
  makePrivateWikiId,
  makePublicWikiId,
  normalizePublicWikiId,
  normalizePublicWikiSurface,
  normalizePublicWikiVisibility,
  publicWikiPublicationFromSnapshot,
  type PublicWikiPublication,
  type PublicWikiSnapshot,
  type PublicWikiVisibility,
} from "./public-wiki.ts";

type RedisJson = { result?: unknown; error?: string };

type StoredPublicWikiMeta = Omit<PublicWikiSnapshot, "wiki" | "published"> & {
  published: boolean;
  tokenHash: string;
  pageIds: string[];
  wiki: Omit<PublicWikiSnapshot["wiki"], "pages"> & { pages: Record<string, never> };
  unpublishedAt?: string | null;
};

export type PublishPublicWikiResult = {
  snapshot: PublicWikiSnapshot;
  publication: PublicWikiPublication;
  managementToken?: string;
};

export type UnpublishPublicWikiResult = {
  publication: PublicWikiPublication;
};

const KEY_PREFIX = "gw:public:wiki";

export function publicWikiBaseUrlFromEnv(defaultBaseUrl = "https://rlmwiki.deepascii.com"): string {
  return (process.env.RLM_WIKI_PUBLIC_URL || defaultBaseUrl).trim().replace(/\/+$/, "");
}

export class UpstashPublicWikiStore {
  private readonly url: string;
  private readonly token: string;

  constructor(opts: { url?: string; token?: string } = {}) {
    this.url = (opts.url || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
    this.token = (opts.token || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
    if (!this.url || !this.token) {
      throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for public wiki publishing.");
    }
  }

  async get(publicId: string): Promise<PublicWikiSnapshot | null> {
    const id = normalizePublicWikiId(publicId);
    if (!id) return null;
    const meta = await this.getMeta(id);
    if (!meta || meta.published !== true) return null;
    const pageIds = Array.isArray(meta.pageIds) ? meta.pageIds : [];
    const pageResults = pageIds.length
      ? await this.command<Array<string | null>>(["MGET", ...pageIds.map((pageId) => this.pageKey(id, pageId))])
      : [];
    const pages: PublicWikiSnapshot["wiki"]["pages"] = {};
    pageIds.forEach((pageId, index) => {
      const raw = pageResults[index];
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
          pages[pageId] = parsed;
        }
      } catch {
        // Treat a missing/corrupt page as absent rather than exposing partial raw data.
      }
    });
    return {
      schemaVersion: meta.schemaVersion,
      publicId: id,
      published: true,
      visibility: normalizePublicWikiVisibility(meta.visibility),
      surface: normalizePublicWikiSurface(meta.surface),
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

  async publish(args: {
    record: unknown;
    publicId?: string | null;
    managementToken?: string | null;
    visibility?: PublicWikiVisibility | null;
    baseUrl?: string;
  }): Promise<PublishPublicWikiResult> {
    const existingId = normalizePublicWikiId(args.publicId);
    const existingMeta = existingId ? await this.getMeta(existingId) : null;
    if (existingId) {
      this.assertAuthorized(existingId, existingMeta, args.managementToken);
    }

    const visibility = args.visibility == null && existingMeta
      ? normalizePublicWikiVisibility(existingMeta.visibility)
      : normalizePublicWikiVisibility(args.visibility);
    const publicId = existingId || (visibility === "private"
      ? makePrivateWikiId()
      : makePublicWikiId(
        String((args.record as { owner?: unknown })?.owner || "wiki"),
        String((args.record as { repo?: unknown })?.repo || "repo"),
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
    const pageIds = snapshot.wiki.structure.pages.map((page) => page.id).filter((pageId) => snapshot.wiki.pages[pageId]);
    const meta: StoredPublicWikiMeta = {
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

  async unpublish(args: {
    publicId: string;
    managementToken?: string | null;
    baseUrl?: string;
  }): Promise<UnpublishPublicWikiResult> {
    const publicId = normalizePublicWikiId(args.publicId);
    if (!publicId) throw new Error("Invalid public wiki id.");
    const meta = await this.getMeta(publicId);
    this.assertAuthorized(publicId, meta, args.managementToken);
    const now = new Date().toISOString();
    const unpublishedMeta: StoredPublicWikiMeta = {
      ...meta!,
      published: false,
      updatedAt: now,
      unpublishedAt: now,
    };
    const pageIds = Array.isArray(meta?.pageIds) ? meta!.pageIds : [];
    await this.pipeline([
      ["SET", this.metaKey(publicId), JSON.stringify(unpublishedMeta)],
      ...(pageIds.length ? [["DEL", ...pageIds.map((pageId) => this.pageKey(publicId, pageId))]] : []),
    ]);
    const baseUrl = args.baseUrl || publicWikiBaseUrlFromEnv();
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

  private async getMeta(publicId: string): Promise<StoredPublicWikiMeta | null> {
    const raw = await this.command<string | null>(["GET", this.metaKey(publicId)]);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as StoredPublicWikiMeta : null;
    } catch {
      return null;
    }
  }

  private assertAuthorized(publicId: string, meta: StoredPublicWikiMeta | null, token: unknown): void {
    if (!meta) throw new Error("Public wiki not found.");
    const provided = String(token || "");
    if (!provided || !safeEqual(hashToken(provided), meta.tokenHash)) {
      throw new Error(`Publish token rejected for ${publicId}.`);
    }
  }

  private async command<T>(command: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    const json = await response.json().catch(() => ({})) as RedisJson;
    if (!response.ok || json.error) throw new Error(json.error || `Upstash request failed with HTTP ${response.status}.`);
    return json.result as T;
  }

  private async pipeline(commands: unknown[][]): Promise<RedisJson[]> {
    if (!commands.length) return [];
    const response = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    const json = await response.json().catch(() => []) as RedisJson[];
    if (!response.ok) throw new Error(`Upstash pipeline failed with HTTP ${response.status}.`);
    const failed = Array.isArray(json) ? json.find((item) => item?.error) : null;
    if (failed?.error) throw new Error(failed.error);
    return Array.isArray(json) ? json : [];
  }

  private metaKey(publicId: string): string {
    return `${KEY_PREFIX}:${publicId}:meta`;
  }

  private pageKey(publicId: string, pageId: string): string {
    const safePageId = String(pageId || "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "page";
    return `${KEY_PREFIX}:${publicId}:page:${safePageId}`;
  }
}

function makeManagementToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
