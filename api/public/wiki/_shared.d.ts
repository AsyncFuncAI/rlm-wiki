/**
 * Minimal ambient typings for the plain-JS public-wiki markdown builders, so TS
 * callers (e.g. the Phase 3 golden test) can import them without TS7016. Only the
 * surface the TS side consumes is declared; the JS module remains the source of truth.
 */

export function publicWikiMarkdownIndex(snapshot: unknown, baseUrl?: string): string;
export function publicWikiMarkdownFull(snapshot: unknown, baseUrl?: string): string;
export function publicWikiMarkdownPage(snapshot: unknown, baseUrl: string | undefined, pageParam: string): string;
export function publicWikiMarkdownUrls(baseUrl: string, snapshot: unknown): Record<string, unknown>;
export function publicWikiPath(publicId: string, visibility?: string | null, surface?: string | null): string;
export function publicWikiRobotsTxt(baseUrl?: string): string;
export function publicWikiSitemapXml(baseUrl?: string, items?: unknown[]): string;
export function publicWikiGalleryItemFromMeta(meta: unknown): Record<string, unknown> | null;
export function publicWikiGalleryItemMatchesQuery(item: unknown, query: string): boolean;
export function publicWikiAgentHtmlFallback(snapshot: unknown, baseUrl?: string): string;
export function wikiExportFiles(record: unknown): Array<{ path: string; content: string }>;
export function createStoredZip(files: Array<{ path: string; content: string }>): Uint8Array;
