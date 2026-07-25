/**
 * Phase 2 - rollup input compression.
 *
 * The star (rollup) path distills the whole repo's documented knowledge into the
 * KB. Its input is the wiki backbone: a compact structure summary plus selected
 * page content (plan section 4, Phase 2 input compression). This mirrors the chat
 * path's `compactAskHistory` but for the wiki surface, turning the wiki into the
 * same `KbHistoryMessage[]` shape the distill prompt already consumes, so the prompt
 * builder stays uniform across both scopes.
 *
 * Provenance: each wiki-derived pseudo-turn carries `askId = wiki:<pageId>` so the
 * resulting card's `sourceAskIds` trace back to the documented page, not a real ask.
 */

import type { WikiRecord } from "../types.ts";
import type { KbHistoryMessage } from "./kb-prompts.ts";

/** Stable provenance askId for a wiki page contributing to a rollup. */
export function wikiPageAskId(pageId: string): string {
  return `wiki:${String(pageId || "").trim()}`;
}

const ROLLUP_MAX_PAGES = 12;
const ROLLUP_PAGE_CHARS = 6_000;
const ROLLUP_SUMMARY_CHARS = 4_000;

function clamp(text: string, max: number): string {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}\n[truncated ${normalized.length - max} chars]`;
}

/**
 * Build the compact wiki summary: title + description + the page title/description
 * backbone. Mirrors the internal `summariseWiki` (src/chat.ts:414) intent but lives
 * here so the rollup path does not depend on a non-exported chat helper.
 */
export function summariseWikiForRollup(wiki: WikiRecord): string {
  const lines: string[] = [
    `# ${wiki.structure.title}`,
    wiki.structure.description ? wiki.structure.description : "",
    "",
    "## Documented pages",
  ];
  for (const page of wiki.structure.pages) {
    lines.push(`- ${page.title}: ${page.description}`);
  }
  return clamp(lines.filter((line) => line !== "").join("\n"), ROLLUP_SUMMARY_CHARS);
}

/**
 * Turn a wiki record into the distill agent's `KbHistoryMessage[]` input for the
 * rollup scope. The first message is the compacted structure summary; each
 * subsequent message is one page's content (clamped, capped at ROLLUP_MAX_PAGES by
 * importance order) with `askId = wiki:<pageId>` for provenance.
 *
 * Page selection: high-importance pages first, then the rest, until the cap. This
 * keeps the rollup within budget for large wikis without a vector store.
 */
export function buildRollupMessages(wiki: WikiRecord): KbHistoryMessage[] {
  const messages: KbHistoryMessage[] = [
    {
      askId: wikiPageAskId("structure"),
      role: "user",
      content: summariseWikiForRollup(wiki),
    },
  ];

  const importanceRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ordered = [...wiki.structure.pages].sort(
    (a, b) => (importanceRank[a.importance] ?? 3) - (importanceRank[b.importance] ?? 3),
  );

  let used = 0;
  for (const page of ordered) {
    if (used >= ROLLUP_MAX_PAGES) break;
    const generated = wiki.pages[page.id];
    const content = generated?.content?.trim();
    if (!content) continue;
    messages.push({
      askId: wikiPageAskId(page.id),
      role: "assistant",
      content: `## ${page.title}\n\n${clamp(content, ROLLUP_PAGE_CHARS)}`,
    });
    used += 1;
  }
  return messages;
}
