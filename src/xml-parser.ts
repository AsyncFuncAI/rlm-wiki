import type { WikiStructure, WikiPage, WikiSection } from "./types.ts";

/**
 * Parse the <wiki_structure> XML returned by the structure agent.
 * Uses DOMParser-free regex-based parsing — good enough for the strict
 * schema we request in the prompt and sidesteps ESM import issues.
 */
export function parseWikiStructureXml(xml: string): WikiStructure {
  const cleaned = stripFences(xml).trim();
  const rootMatch = cleaned.match(/<wiki_structure\b[^>]*>([\s\S]*?)<\/wiki_structure>/i);
  if (!rootMatch) {
    throw new Error(
      "No <wiki_structure> element found in agent output. Got:\n" +
        cleaned.slice(0, 500),
    );
  }
  const body = rootMatch[1];

  const title = extractText(body, "title") ?? "Untitled Wiki";
  const description = extractText(body, "description") ?? "";

  const sectionsBlockMatch = body.match(/<sections>([\s\S]*?)<\/sections>/i);
  const sectionsBlock = sectionsBlockMatch ? sectionsBlockMatch[1] : "";
  const sections: WikiSection[] = parseSections(sectionsBlock);

  const pagesBlockMatch = body.match(/<pages>([\s\S]*?)<\/pages>\s*<\/wiki_structure>/i) ?? body.match(/<pages>([\s\S]*)<\/pages>/i);
  const pagesBlock = pagesBlockMatch ? pagesBlockMatch[1] : "";
  const pages: WikiPage[] = parsePages(pagesBlock);

  return { title, description, sections, pages };
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:xml|markdown|html)?\s*/i, "")
    .replace(/```\s*$/i, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractText(src: string, tag: string): string | null {
  const m = src.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : null;
}

function parseSections(src: string): WikiSection[] {
  const out: WikiSection[] = [];
  const re = /<section\s+id="([^"]+)">([\s\S]*?)<\/section>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const id = match[1];
    const inner = match[2];
    const title = extractText(inner, "title") ?? id;
    const pages: string[] = [];
    const pagesInner = inner.match(/<pages>([\s\S]*?)<\/pages>/i);
    if (pagesInner) {
      const pageRefRe = /<page_ref>([\s\S]*?)<\/page_ref>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = pageRefRe.exec(pagesInner[1])) !== null) {
        pages.push(pm[1].trim());
      }
    }
    const subsections: string[] = [];
    const subInner = inner.match(/<subsections>([\s\S]*?)<\/subsections>/i);
    if (subInner) {
      const subRe = /<section_ref>([\s\S]*?)<\/section_ref>/gi;
      let sm: RegExpExecArray | null;
      while ((sm = subRe.exec(subInner[1])) !== null) {
        subsections.push(sm[1].trim());
      }
    }
    out.push({ id, title, pages, subsections });
  }
  return out;
}

function parsePages(src: string): WikiPage[] {
  const out: WikiPage[] = [];
  const re = /<page\s+id="([^"]+)">([\s\S]*?)<\/page>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    const id = match[1];
    const inner = match[2];
    const title = extractText(inner, "title") ?? id;
    const description = extractText(inner, "description") ?? "";
    const importanceRaw = (extractText(inner, "importance") ?? "medium").toLowerCase();
    const importance: WikiPage["importance"] =
      importanceRaw === "high" || importanceRaw === "low" ? importanceRaw : "medium";

    const filePaths: string[] = [];
    const filesInner = inner.match(/<relevant_files>([\s\S]*?)<\/relevant_files>/i);
    if (filesInner) {
      const fpRe = /<file_path>([\s\S]*?)<\/file_path>/gi;
      let fm: RegExpExecArray | null;
      while ((fm = fpRe.exec(filesInner[1])) !== null) {
        const p = fm[1].trim();
        if (p) filePaths.push(p);
      }
    }

    const relatedPages: string[] = [];
    const relInner = inner.match(/<related_pages>([\s\S]*?)<\/related_pages>/i);
    if (relInner) {
      const relRe = /<related>([\s\S]*?)<\/related>/gi;
      let rm: RegExpExecArray | null;
      while ((rm = relRe.exec(relInner[1])) !== null) {
        const p = rm[1].trim();
        if (p) relatedPages.push(p);
      }
    }
    const parentSection = extractText(inner, "parent_section") ?? undefined;
    out.push({ id, title, description, importance, filePaths, relatedPages, parentSection });
  }
  return out;
}
