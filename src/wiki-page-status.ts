export interface WikiRecordCompletion {
  plannedPageCount: number;
  generatedPageCount: number;
  failedPageCount: number;
  missingPageIds: string[];
  failedPageIds: string[];
  recoverablePageIds: string[];
  partial: boolean;
}

const FAILED_PAGE_PATTERNS = [
  /^>\s*⚠️\s*Page generation failed:/i,
  /^>\s*⚠️\s*The agent returned an invalid wiki page\./i,
  /^>\s*⚠️\s*Page needs recovery\./i,
];

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function wikiGeneratedPageFailureReason(value: unknown): string | null {
  const page = jsonObject(value);
  const explicitStatus = typeof page.status === "string" ? page.status.trim().toLowerCase() : "";
  if (explicitStatus === "failed") {
    return typeof page.error === "string" && page.error.trim()
      ? page.error.trim()
      : "page generation failed";
  }
  const content = typeof page.content === "string" ? page.content.trim() : "";
  if (!content) return null;
  return FAILED_PAGE_PATTERNS.some((pattern) => pattern.test(content))
    ? content.split("\n").slice(0, 3).join(" ").replace(/^>\s*/gm, "").trim()
    : null;
}

export function isFailedWikiGeneratedPage(value: unknown): boolean {
  return wikiGeneratedPageFailureReason(value) !== null;
}

export function wikiRecordCompletion(record: Record<string, unknown>): WikiRecordCompletion {
  const structure = jsonObject(record.structure);
  const structurePages = Array.isArray(structure.pages)
    ? structure.pages.map(jsonObject).filter((page) => typeof page.id === "string")
    : [];
  const generatedPages = record.pages && typeof record.pages === "object"
    ? record.pages as Record<string, unknown>
    : {};
  const generatedIds = new Set<string>();
  const failedIds = new Set<string>();

  for (const [pageId, page] of Object.entries(generatedPages)) {
    if (isFailedWikiGeneratedPage(page)) {
      failedIds.add(pageId);
    } else {
      generatedIds.add(pageId);
    }
  }

  const plannedIds = structurePages.map((page) => String(page.id));
  const failedPageIds = plannedIds.filter((pageId) => failedIds.has(pageId));
  const missingPageIds = plannedIds.filter((pageId) => !generatedIds.has(pageId) && !failedIds.has(pageId));
  const recoverablePageIds = plannedIds.filter((pageId) => !generatedIds.has(pageId));

  return {
    plannedPageCount: plannedIds.length,
    generatedPageCount: plannedIds.filter((pageId) => generatedIds.has(pageId)).length,
    failedPageCount: failedPageIds.length,
    missingPageIds,
    failedPageIds,
    recoverablePageIds,
    partial: Boolean(recoverablePageIds.length),
  };
}
