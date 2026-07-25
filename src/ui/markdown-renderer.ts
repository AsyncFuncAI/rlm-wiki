export type MarkdownStreamState = {
  key: string;
  seenLines: number;
  lineIndex: number;
};

export type MarkdownRendererDeps = {
  escape(value: unknown): string;
  sourceTextLabel(value: string): string;
  sourceLink(label: string, ref: string): string;
  isSourceReference(value: string): boolean;
  renderMermaidBlock(code: string): string;
  icon(name: string): string;
  copy?: Partial<MarkdownRendererCopy>;
  compactSourceCitations?: boolean;
  resolveMediaSrc?: (src: string) => string | null | undefined;
  resolveDocsPageHref?: (href: string, title: string, description: string) => string | null;
};

export type MarkdownRendererCopy = {
  responseFields: string;
  request: string;
  response: string;
  details: string;
  step: string;
  item: string;
  codeExamples: string;
  documentationTabs: string;
  field: string;
  fieldFallback: string;
  detailsColumn: string;
  required: string;
  optional: string;
  deprecated: string;
  defaultValue: string;
  fileTree: string;
  endpoint: string;
  update: string;
  note: string;
  tip: string;
  warning: string;
  check: string;
  copyCode: string;
  showAllCodeLines: (count: number) => string;
  showAll: string;
  openDiagramZoom: string;
  lineCount: (count: number) => string;
  collapsedLineCount: (visible: number, total: number) => string;
};

const DEFAULT_MARKDOWN_RENDERER_COPY: MarkdownRendererCopy = {
  responseFields: "Response fields",
  request: "Request",
  response: "Response",
  details: "Details",
  step: "Step",
  item: "Item",
  codeExamples: "Code examples",
  documentationTabs: "Documentation tabs",
  field: "Field",
  fieldFallback: "field",
  detailsColumn: "Details",
  required: "required",
  optional: "optional",
  deprecated: "deprecated",
  defaultValue: "default",
  fileTree: "File tree",
  endpoint: "Endpoint",
  update: "Update",
  note: "Note",
  tip: "Tip",
  warning: "Warning",
  check: "Check",
  copyCode: "Copy code",
  showAllCodeLines: (count) => `Show all ${count} code lines`,
  showAll: "Show all",
  openDiagramZoom: "Open diagram zoom",
  lineCount: (count) => `${count} lines`,
  collapsedLineCount: (visible, total) => `${visible}/${total} lines`,
};

export function markdownRendererCopy(copy?: Partial<MarkdownRendererCopy>): MarkdownRendererCopy {
  return {
    ...DEFAULT_MARKDOWN_RENDERER_COPY,
    ...(copy || {}),
    showAllCodeLines: copy?.showAllCodeLines || DEFAULT_MARKDOWN_RENDERER_COPY.showAllCodeLines,
    lineCount: copy?.lineCount || DEFAULT_MARKDOWN_RENDERER_COPY.lineCount,
    collapsedLineCount: copy?.collapsedLineCount || DEFAULT_MARKDOWN_RENDERER_COPY.collapsedLineCount,
  };
}

export type MarkdownFrontmatter = {
  attrs: Record<string, string>;
  body: string;
  raw: string;
};

const SOURCE_FILE_REF_PATTERN = String.raw`(?:(?:[\w@.-]+\/)?[\w@.-]+:)?(?:[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|py|go|rs|java|css|html|svelte|vue|yml|yaml|toml|lock|sh|mjs|cjs|mts|cts|rb|php|cs|cpp|cc|cxx|h|hpp|swift|kt|kts|sql|proto|gradle)|(?:[\w@./-]+/)?(?:README|LICENSE|Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Brewfile|Justfile|Taskfile)):\d+(?:[-–]\d+)?`;
type DocsKitKind =
  | "cards"
  | "steps"
  | "tabs"
  | "code-group"
  | "params"
  | "fields"
  | "response-fields"
  | "files"
  | "accordion"
  | "accordions"
  | "request"
  | "response"
  | "endpoint"
  | "frame"
  | "updates";

type DocsKitBlock = {
  kind: DocsKitKind;
  label: string;
  body: string;
  nextIndex: number;
};

const DOCS_KIT_DIRECTIVE_PATTERN =
  /^\s*:::(cards|steps|tabs|code-group|params|fields|response-fields|files|accordion|accordions|request|response|endpoint|frame|updates)(?:\s+(.+?))?\s*$/i;
const CODE_VIEWER_INITIAL_LINE_LIMIT = 220;

export function renderMarkdownPreview(
  markdown: string,
  linkSources: boolean,
  stream: MarkdownStreamState | null,
  deps: MarkdownRendererDeps,
): string {
  const body = renderMarkdownBlocks(markdown, linkSources, stream, deps);
  return `<div class="markdown-preview${stream ? " markdown-preview-streaming" : ""}">${body}</div>`;
}

export function renderMarkdownBlocks(
  markdown: string,
  linkSources: boolean,
  stream: MarkdownStreamState | null,
  deps: MarkdownRendererDeps,
): string {
  const blocks: string[] = [];
  const { body } = extractMarkdownFrontmatter(markdown);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const isTableDivider = (value: string) =>
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value);
  const parseTableRow = (value: string) => {
    let row = String(value || "").trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row.split("|").map((cell) => cell.trim());
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const docsKitBlock = parseDocsKitBlock(lines, index);
    if (docsKitBlock) {
      blocks.push(renderDocsKitBlock(docsKitBlock, linkSources, deps));
      index = docsKitBlock.nextIndex;
      continue;
    }

    const docsMdxBlock = parseDocsMdxComponentBlock(lines, index, linkSources, deps);
    if (docsMdxBlock) {
      blocks.push(docsMdxBlock.html);
      index = docsMdxBlock.nextIndex;
      continue;
    }

    const detailsBlock = parseDetailsBlock(lines, index, markdownRendererCopy(deps.copy).details);
    if (detailsBlock) {
      blocks.push(renderDetailsBlock(detailsBlock.summary, detailsBlock.body, linkSources, deps));
      index = detailsBlock.nextIndex;
      continue;
    }

    const fence = parseMarkdownFence(line);
    if (fence) {
      const language = fence.language || "text";
      const codeLines: string[] = [];
      // Track whether the closing ``` was actually seen. The old loop exited on
      // both "fence closed" and "input exhausted" identically, so a still-streaming
      // (unterminated) mermaid fence was rendered as a live diagram on every delta —
      // thrashing the diagram engine. Defer the real diagram until the fence closes.
      let fenceClosed = false;
      index += 1;
      while (index < lines.length) {
        if (/^```\s*$/.test(lines[index] ?? "")) {
          fenceClosed = true;
          index += 1;
          break;
        }
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      const code = mermaidCodeFromFence(fence.info, codeLines.join("\n"));
      const isMermaid = looksLikeMermaid(language, code);
      blocks.push(
        isMermaid
          ? fenceClosed
            ? deps.renderMermaidBlock(normalizeMermaidCode(code))
            : renderMermaidPending(normalizeMermaidCode(code), deps)
          : renderCodeViewer(code, language, false, deps, fence.title),
      );
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      const codeLines: string[] = [];
      for (
        ;
        index < lines.length &&
        ((lines[index] ?? "") === "" || /^(?: {4}|\t)/.test(lines[index] ?? ""));
      ) {
        codeLines.push((lines[index] ?? "").replace(/^(?: {4}|\t)/, ""));
        index += 1;
      }
      const code = codeLines.join("\n").trimEnd();
      const isMermaid = looksLikeMermaid("", code);
      blocks.push(
        isMermaid
          ? deps.renderMermaidBlock(normalizeMermaidCode(code))
          : renderCodeViewer(code, "text", false, deps),
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      blocks.push(
        `<h${level}>${renderInlineMarkdown(heading[2], linkSources, deps)}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (/^\s*-{3,}\s*$/.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    const image = parseMarkdownImageLine(line);
    if (image) {
      blocks.push(renderDocsFrame(image.caption || image.alt, line, linkSources, deps));
      index += 1;
      continue;
    }

    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      const header = parseTableRow(line);
      const rows: string[][] = [];
      for (
        index += 2;
        index < lines.length && (lines[index] ?? "").trim() && (lines[index] ?? "").includes("|");
      ) {
        rows.push(parseTableRow(lines[index] ?? ""));
        index += 1;
      }
      const headHtml = header
        .map((cell) => `<th>${renderInlineMarkdown(cell, linkSources, deps)}</th>`)
        .join("");
      const rowHtml = rows
        .map(
          (row) =>
            `<tr>${header
              .map((_, cellIndex) =>
                `<td>${renderInlineMarkdown(row[cellIndex] || "", linkSources, deps)}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      blocks.push(
        `<div class="markdown-table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowHtml}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      for (; index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? ""); ) {
        items.push(
          `<li>${renderListItemContent(
            (lines[index] ?? "").replace(/^\s*[-*]\s+/, ""),
            linkSources,
            deps,
          )}</li>`,
        );
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      for (; index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? ""); ) {
        items.push(
          `<li>${renderListItemContent(
            (lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""),
            linkSources,
            deps,
          )}</li>`,
        );
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^>\s+/.test(line)) {
      const quoteLines: string[] = [];
      for (; index < lines.length && /^>\s?/.test(lines[index] ?? ""); ) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(
        renderCalloutBlock(quoteLines, linkSources, deps) ||
          `<blockquote>${quoteLines
            .map((value) => renderInlineMarkdown(value, linkSources, deps))
            .join("<br>")}</blockquote>`,
      );
      continue;
    }

    const paragraph: string[] = [];
    for (
      ;
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^```/.test(lines[index] ?? "") &&
      !DOCS_KIT_DIRECTIVE_PATTERN.test(lines[index] ?? "") &&
      !/^\s*<details\b/i.test(lines[index] ?? "") &&
      !parseMarkdownImageLine(lines[index] ?? "") &&
      !/^(#{1,4})\s+/.test(lines[index] ?? "") &&
      !/^\s*-{3,}\s*$/.test(lines[index] ?? "") &&
      !((lines[index] ?? "").includes("|") && isTableDivider(lines[index + 1] ?? "")) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[index] ?? "") &&
      !/^>\s?/.test(lines[index] ?? "") &&
      !(
        paragraph.length > 0 &&
        deps.compactSourceCitations &&
        isSourceCitationStart(lines[index] ?? "")
      );
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    const paragraphText = paragraph.join(" ");
    blocks.push(renderParagraphBlock(paragraphText, linkSources, deps));
  }

  if (!stream) return blocks.join("");
  const keys = streamBlockKeys(blocks);
  return blocks.map((block, position) => renderStreamLine(block, stream, keys[position])).join("");
}

export function extractMarkdownFrontmatter(markdown: string): MarkdownFrontmatter {
  const value = String(markdown || "").replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const lines = value.split("\n");
  if ((lines[0] || "").trim() !== "---") return { attrs: {}, body: value, raw: "" };

  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] || "").trim() === "---") {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) return { attrs: {}, body: value, raw: "" };

  const raw = lines.slice(1, endIndex).join("\n");
  const attrs: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    attrs[match[1]] = unquoteYamlScalar(match[2]);
  }
  return {
    attrs,
    raw,
    body: lines.slice(endIndex + 1).join("\n").replace(/^\n+/, ""),
  };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

function parseDocsKitBlock(lines: string[], startIndex: number): DocsKitBlock | null {
  const directive = parseDocsKitDirective(lines[startIndex] ?? "");
  if (!directive) return null;

  const { kind, label } = directive;
  const bodyLines: string[] = [];
  let index = startIndex + 1;
  let nestedDepth = 0;
  let fenced = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^```/.test(line.trim())) {
      fenced = !fenced;
      bodyLines.push(line);
      continue;
    }
    const nestedDirective = !fenced ? parseDocsKitDirective(line) : null;
    if (nestedDirective) {
      if (nestedDepth === 0 && !canNestDocsKitDirective(kind, nestedDirective.kind)) {
        return { kind, label, body: bodyLines.join("\n").trim(), nextIndex: index };
      }
      nestedDepth += 1;
      bodyLines.push(line);
      continue;
    }
    if (!fenced && /^\s*:::\s*$/.test(line)) {
      if (nestedDepth > 0) {
        nestedDepth -= 1;
        bodyLines.push(line);
        continue;
      }
      return { kind, label, body: bodyLines.join("\n").trim(), nextIndex: index + 1 };
    }
    bodyLines.push(line);
  }

  return { kind, label, body: bodyLines.join("\n").trim(), nextIndex: index };
}

function parseDocsKitDirective(line: string): { kind: DocsKitKind; label: string } | null {
  const match = String(line || "").match(DOCS_KIT_DIRECTIVE_PATTERN);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as DocsKitKind,
    label: String(match[2] || "").trim(),
  };
}

function canNestDocsKitDirective(parent: DocsKitKind, child: DocsKitKind): boolean {
  if (parent === child) return false;
  if (parent === "endpoint") {
    return child !== "endpoint";
  }
  return !["endpoint", "params", "fields", "response-fields", "request", "response"].includes(child);
}

function renderDocsKitBlock(
  block: DocsKitBlock,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const copy = markdownRendererCopy(deps.copy);
  switch (block.kind) {
    case "cards":
      return renderDocsCards(block.body, linkSources, deps);
    case "steps":
      return renderDocsSteps(block.body, linkSources, deps);
    case "tabs":
      return renderDocsTabs(block.body, linkSources, deps, "tabs", block.label);
    case "code-group":
      return renderDocsTabs(block.body, linkSources, deps, "code-group", block.label);
    case "params":
      return renderDocsParams(block.body, linkSources, deps, block.label, "params");
    case "fields":
      return renderDocsParams(block.body, linkSources, deps, block.label, "fields");
    case "response-fields":
      return renderDocsParams(block.body, linkSources, deps, block.label || copy.responseFields, "response-fields");
    case "files":
      return renderDocsFiles(block.body, deps, block.label);
    case "accordion":
    case "accordions":
      return renderDocsAccordions(block.body, linkSources, deps, block.label);
    case "request":
      return renderDocsExample("request", block.label || copy.request, block.body, linkSources, deps);
    case "response":
      return renderDocsExample("response", block.label || copy.response, block.body, linkSources, deps);
    case "endpoint":
      return renderDocsEndpoint(block.label, block.body, linkSources, deps);
    case "frame":
      return renderDocsFrame(block.label, block.body, linkSources, deps);
    case "updates":
      return renderDocsUpdates(block.body, linkSources, deps, block.label);
    default:
      return "";
  }
}

function parseDocsMdxComponentBlock(
  lines: string[],
  startIndex: number,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): { html: string; nextIndex: number } | null {
  const line = lines[startIndex] ?? "";
  const fieldTag = parseMdxFieldTagName(line);
  if (fieldTag) {
    return parseMdxFieldRun(lines, startIndex, linkSources, deps, fieldTag);
  }

  const open = parseMdxOpenTag(line);
  if (!open) return null;

  const supported = new Set([
    "Note",
    "Info",
    "Tip",
    "Warning",
    "Check",
    "Frame",
    "CardGroup",
    "Steps",
    "Tabs",
    "CodeGroup",
    "AccordionGroup",
    "Accordion",
    "RequestExample",
    "ResponseExample",
  ]);
  if (!supported.has(open.tag)) return null;

  const collected = collectMdxComponent(lines, startIndex, open.tag);
  if (!collected) return null;
  const copy = markdownRendererCopy(deps.copy);
  const attrs = parseMdxAttrs(open.attrs);
  const body = collected.body.trim();
  switch (open.tag) {
    case "Note":
    case "Info":
    case "Tip":
    case "Warning":
    case "Check":
      return {
        html: renderMdxCallout(open.tag, body, linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    case "Frame":
      return {
        html: renderDocsFrame(String(attrs.caption || attrs.title || ""), body, linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    case "CardGroup":
      return {
        html: renderMdxCardGroup(body, linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    case "Steps":
      return {
        html: renderDocsSteps(mdxChildrenToSections(body, "Step", copy.step), linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    case "Tabs":
      return {
        html: renderDocsTabs(mdxChildrenToTabs(body, "Tab", "tab"), linkSources, deps, "tabs", ""),
        nextIndex: collected.nextIndex,
      };
    case "CodeGroup":
      return {
        html: renderDocsTabs(mdxCodeGroupToTabs(body), linkSources, deps, "code-group", ""),
        nextIndex: collected.nextIndex,
      };
    case "AccordionGroup":
      return {
        html: renderDocsAccordions(mdxChildrenToTabs(body, "Accordion", "item", copy.item), linkSources, deps, ""),
        nextIndex: collected.nextIndex,
      };
    case "Accordion":
      return {
        html: renderDetailsBlock(String(attrs.title || copy.details), body, linkSources, deps).replace("markdown-details", "markdown-details markdown-docs-accordion"),
        nextIndex: collected.nextIndex,
      };
    case "RequestExample":
      return {
        html: renderDocsExample("request", String(attrs.title || ""), body, linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    case "ResponseExample":
      return {
        html: renderDocsExample("response", String(attrs.title || ""), body, linkSources, deps),
        nextIndex: collected.nextIndex,
      };
    default:
      return null;
  }
}

function parseMdxFieldRun(
  lines: string[],
  startIndex: number,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
  tag: "ParamField" | "ResponseField",
): { html: string; nextIndex: number } | null {
  const rows: string[] = [];
  let index = startIndex;
  for (; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const selfClosingRows = parseSelfClosingMdxFieldRows(line, tag);
    if (selfClosingRows) {
      rows.push(...selfClosingRows);
      index += 1;
      continue;
    }
    const open = parseMdxOpenTag(line);
    if (!open || open.tag !== tag) break;
    const collected = collectMdxComponent(lines, index, tag);
    if (!collected) break;
    rows.push(mdxFieldRow(parseMdxAttrs(open.attrs), collected.body));
    index = collected.nextIndex;
  }

  if (!rows.length) return null;
  return {
    html: renderDocsParams(rows.join("\n"), linkSources, deps, "", tag === "ResponseField" ? "response-fields" : "params"),
    nextIndex: index,
  };
}

function parseMdxFieldTagName(line: string): "ParamField" | "ResponseField" | null {
  const match = String(line || "").trim().match(/^<(ParamField|ResponseField)\b/);
  return match ? match[1] as "ParamField" | "ResponseField" : null;
}

function parseSelfClosingMdxFieldRows(line: string, tag: "ParamField" | "ResponseField"): string[] | null {
  const value = String(line || "").trim();
  if (!value) return null;

  const rows: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (/\s/.test(value[offset] || "")) offset += 1;
    if (offset >= value.length) break;

    const slice = value.slice(offset);
    const match = slice.match(new RegExp(`^<${tag}\\b`));
    if (!match) return null;
    const tagEnd = findMdxTagEnd(slice, match[0].length);
    if (tagEnd < 0) return null;

    const attrs = slice.slice(match[0].length, tagEnd);
    if (!/\/\s*$/.test(attrs)) return null;
    rows.push(mdxFieldRow(parseMdxAttrs(attrs.replace(/\/\s*$/, "")), ""));
    offset += tagEnd + 1;
  }

  return rows.length ? rows : null;
}

function mdxFieldRow(attrs: Record<string, string>, body: string): string {
  const normalized = recoverMdxFieldComparator(attrs, body);
  const fieldAttrs = normalized.attrs;
  const name = String(fieldAttrs.body || fieldAttrs.name || "").trim();
  const type = String(fieldAttrs.type || "").trim() || "value";
  const required = fieldAttrs.required === "true" ? "required" : "optional";
  const defaultValue = fieldAttrs.default || fieldAttrs.defaultValue ? ` default \`${fieldAttrs.default || fieldAttrs.defaultValue}\`` : "";
  const description = normalized.body.trim().replace(/\n+/g, " ");
  return `- \`${name || "field"}\` | \`${type}\` | ${required}${defaultValue} | ${description}`;
}

function recoverMdxFieldComparator(
  attrs: Record<string, string>,
  body: string,
): { attrs: Record<string, string>; body: string } {
  const type = String(attrs.type || "").trim();
  if (type) return { attrs, body };

  const match = String(body || "").match(/^\s*([^"'\s]+)(["'])\s+([^>]*)>\s*([\s\S]*)$/);
  if (!match) return { attrs, body };

  const recoveredAttrs = parseMdxAttrs(match[3] || "");
  if (!Object.keys(recoveredAttrs).length) return { attrs, body };

  return {
    attrs: {
      ...attrs,
      ...recoveredAttrs,
      type: `>${match[1].trim()}`,
    },
    body: match[4] || "",
  };
}

function parseMdxOpenTag(line: string): { tag: string; attrs: string; rest: string; selfClosing: boolean } | null {
  const value = String(line || "").trim();
  const match = value.match(/^<([A-Z][A-Za-z0-9]*)\b/);
  if (!match) return null;
  const tagEnd = findMdxTagEnd(value, match[0].length);
  if (tagEnd < 0) return null;
  const attrs = value.slice(match[0].length, tagEnd);
  const selfClosing = /\/\s*$/.test(attrs);
  if (selfClosing) return null;
  return {
    tag: match[1],
    attrs,
    rest: value.slice(tagEnd + 1).trim(),
    selfClosing,
  };
}

function findMdxTagEnd(value: string, startIndex: number): number {
  let quote: string | null = null;
  let braceDepth = 0;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ">" && braceDepth === 0) return index;
  }
  return -1;
}

function splitMdxCloseLine(line: string, tag: string): { before: string; after: string } | null {
  const match = String(line || "").match(new RegExp(`</${escapeRegExp(tag)}>`, "i"));
  if (!match || match.index == null) return null;
  return {
    before: String(line || "").slice(0, match.index),
    after: String(line || "").slice(match.index + match[0].length),
  };
}

function collectMdxComponent(
  lines: string[],
  startIndex: number,
  tag: string,
): { body: string; nextIndex: number } | null {
  const bodyLines: string[] = [];
  let depth = 0;
  let fenced = false;
  const opening = parseMdxOpenTag(lines[startIndex] ?? "");
  if (!opening || opening.tag !== tag) return null;
  if (opening.rest) {
    const inlineClose = splitMdxCloseLine(opening.rest, tag);
    if (inlineClose) {
      if (inlineClose.before.trim()) bodyLines.push(inlineClose.before.trim());
      return { body: bodyLines.join("\n"), nextIndex: startIndex + 1 };
    }
    bodyLines.push(opening.rest);
  }
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^```/.test(line.trim())) {
      fenced = !fenced;
      bodyLines.push(line);
      continue;
    }
    const open = !fenced ? parseMdxOpenTag(line) : null;
    if (open && open.tag === tag) {
      depth += 1;
      bodyLines.push(line);
      continue;
    }
    const close = !fenced ? splitMdxCloseLine(line, tag) : null;
    if (close) {
      if (depth > 0) {
        depth -= 1;
        bodyLines.push(line);
        continue;
      }
      if (close.before.trim()) bodyLines.push(close.before.trim());
      return { body: bodyLines.join("\n"), nextIndex: index + 1 };
    }
    bodyLines.push(line);
  }
  return null;
}

function parseMdxAttrs(attrs: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const value = String(attrs || "");
  const attrPattern = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+)))?/g;
  for (const match of value.matchAll(attrPattern)) {
    const name = match[1];
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    parsed[name] = raw == null ? "true" : String(raw).trim().replace(/^['"]|['"]$/g, "");
  }
  return parsed;
}

function renderMdxCallout(
  tag: string,
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const kind = tag === "Info" ? "NOTE" : tag.toUpperCase();
  return renderCalloutBlock([`[!${kind}]`, ...String(body || "").split("\n")], linkSources, deps) || "";
}

function renderMdxCardGroup(
  body: string,
  _linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const cards = [...String(body || "").matchAll(/<Card\b([^>]*)>([\s\S]*?)<\/Card>/gi)]
    .map((match) => {
      const attrs = parseMdxAttrs(match[1] || "");
      return {
        title: String(attrs.title || "").trim(),
        href: String(attrs.href || "").trim(),
        description: cleanMdxBody(match[2] || ""),
      };
    })
    .filter((card) => card.title || card.description);
  if (!cards.length) return "";

  return `<div class="markdown-docs-cards" data-docs-kit="cards">${cards
    .map((card) => {
      const href = safeDocsHref(card.href);
      const target = docsCardTarget(href, card.title, card.description, deps);
      return `<${target.tag} class="markdown-docs-card${target.disabled ? " is-unresolved" : ""}"${target.attrs}><span class="markdown-docs-card-icon">${deps.icon("page")}</span><span class="markdown-docs-card-copy"><strong>${renderDocsCardInline(card.title || card.description, deps)}</strong>${card.title && card.description ? `<small>${renderDocsCardInline(card.description, deps)}</small>` : ""}</span>${target.linked ? deps.icon("arrowRight") : ""}</${target.tag}>`;
    })
    .join("")}</div>`;
}

function docsCardTarget(
  href: string,
  title: string,
  description: string,
  deps: MarkdownRendererDeps,
): { tag: "a" | "div"; attrs: string; linked: boolean; disabled: boolean } {
  if (!href) return { tag: "div", attrs: "", linked: false, disabled: false };
  const external = /^(?:https?:)?\/\//i.test(href) || /^(?:mailto|tel):/i.test(href);
  if (external) {
    return { tag: "a", attrs: renderDocsCardHrefAttrs(href, deps), linked: true, disabled: false };
  }
  const resolvedPageId = deps.resolveDocsPageHref?.(href, title, description);
  if (resolvedPageId) {
    const pageId = deps.escape(resolvedPageId);
    return {
      tag: "a",
      attrs: ` href="#${pageId}" data-wiki-page="${pageId}"`,
      linked: true,
      disabled: false,
    };
  }
  if (deps.resolveDocsPageHref) {
    return {
      tag: "div",
      attrs: ` data-docs-unresolved-link="${deps.escape(href)}" aria-disabled="true"`,
      linked: false,
      disabled: true,
    };
  }
  return { tag: "a", attrs: renderDocsCardHrefAttrs(href, deps), linked: true, disabled: false };
}

function renderDocsCardHrefAttrs(href: string, deps: MarkdownRendererDeps): string {
  const external = /^(?:https?:)?\/\//i.test(href) || /^(?:mailto|tel):/i.test(href);
  return ` href="${deps.escape(href)}"${external ? ' target="_blank" rel="noreferrer"' : ""}`;
}

function safeDocsHref(href: string): string {
  const value = String(href || "").trim();
  if (!value || /^javascript:/i.test(value)) return "";
  return value;
}

function mdxChildrenToSections(body: string, tag: string, fallbackTitle = DEFAULT_MARKDOWN_RENDERER_COPY.step): string {
  return [...String(body || "").matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))]
    .map((match) => {
      const attrs = parseMdxAttrs(match[1] || "");
      return `### ${String(attrs.title || fallbackTitle).trim()}\n${cleanMdxBody(match[2] || "")}`;
    })
    .join("\n\n");
}

function mdxChildrenToTabs(body: string, tag: string, marker: "tab" | "item", fallbackTitle = DEFAULT_MARKDOWN_RENDERER_COPY.item): string {
  return [...String(body || "").matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))]
    .map((match) => {
      const attrs = parseMdxAttrs(match[1] || "");
      return `@${marker} ${String(attrs.title || fallbackTitle).trim()}\n${cleanMdxBody(match[2] || "")}`;
    })
    .join("\n\n");
}

function mdxCodeGroupToTabs(body: string): string {
  const tabs: string[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of String(body || "").matchAll(fencePattern)) {
    const info = parseCodeFenceInfo(match[1] || "");
    const language = info.language || "text";
    const title = info.title || language || `Example ${tabs.length + 1}`;
    tabs.push(`@code ${title}\n\`\`\`${language || "text"}\n${match[2] || ""}\`\`\``);
  }
  return tabs.length ? tabs.join("\n\n") : `@code Example\n${body}`;
}

function cleanMdxBody(body: string): string {
  return String(body || "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderDocsCards(
  body: string,
  _linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const cards = String(body || "")
    .split("\n")
    .map(parseDocsCardLine)
    .filter((card): card is { title: string; href: string; description: string } => !!card);
  if (!cards.length) return "";

  return `<div class="markdown-docs-cards" data-docs-kit="cards">${cards
    .map((card) => {
      const href = safeDocsHref(card.href);
      const target = docsCardTarget(href, card.title, card.description, deps);
      return `<${target.tag} class="markdown-docs-card${target.disabled ? " is-unresolved" : ""}"${target.attrs}><span class="markdown-docs-card-icon">${deps.icon("page")}</span><span class="markdown-docs-card-copy"><strong>${renderDocsCardInline(card.title, deps)}</strong>${card.description ? `<small>${renderDocsCardInline(card.description, deps)}</small>` : ""}</span>${target.linked ? deps.icon("arrowRight") : ""}</${target.tag}>`;
    })
    .join("")}</div>`;
}

function renderDocsCardInline(value: string, deps: MarkdownRendererDeps): string {
  return stripInlineAnchors(renderInlineMarkdown(value, false, deps));
}

function stripInlineAnchors(html: string): string {
  return String(html || "").replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
}

function parseDocsCardLine(line: string): { title: string; href: string; description: string } | null {
  const value = String(line || "").trim().replace(/^[-*]\s+/, "").trim();
  if (!value) return null;

  const linkMatch = value.match(/^\[([^\]]+)\]\(([^)]*)\)(?:\s*(?:-|:)\s*(.+))?$/);
  if (linkMatch) {
    return {
      title: linkMatch[1].trim(),
      href: String(linkMatch[2] || "").trim(),
      description: String(linkMatch[3] || "").trim(),
    };
  }

  const split = value.match(/^(.+?)\s+(?:-|:)\s+(.+)$/);
  return {
    title: (split?.[1] || value).trim(),
    href: "",
    description: String(split?.[2] || "").trim(),
  };
}

function renderDocsSteps(
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const steps = parseDocsSteps(body);
  if (!steps.length) return "";

  return `<div class="markdown-docs-steps" role="list" data-docs-kit="steps">${steps
    .map((step, index) => {
      const bodyHtml = step.body.trim()
        ? `<div class="markdown-docs-step-body">${renderMarkdownBlocks(step.body.trim(), linkSources, null, deps)}</div>`
        : "";
      return `<section class="markdown-docs-step" role="listitem"><span class="markdown-docs-step-index">${index + 1}</span><div class="markdown-docs-step-copy"><h4>${renderInlineMarkdown(step.title, linkSources, deps)}</h4>${bodyHtml}</div></section>`;
    })
    .join("")}</div>`;
}

function parseDocsSteps(body: string): Array<{ title: string; body: string }> {
  const steps: Array<{ title: string; lines: string[] }> = [];
  for (const line of String(body || "").split("\n")) {
    const heading = line.match(/^\s*(?:#{2,5}\s+|\d+\.\s+)(.+?)\s*$/);
    if (heading) {
      steps.push({
        title: heading[1].replace(/\s+\[step\]$/i, "").trim(),
        lines: [],
      });
      continue;
    }
    if (!steps.length) {
      if (!line.trim()) continue;
      steps.push({ title: line.trim(), lines: [] });
      continue;
    }
    steps[steps.length - 1].lines.push(line);
  }
  return steps
    .map((step) => ({ title: step.title, body: step.lines.join("\n").trim() }))
    .filter((step) => step.title);
}

function renderDocsTabs(
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
  variant: "tabs" | "code-group",
  label: string,
): string {
  const tabs = parseDocsTabs(body, variant === "code-group" ? "code" : "tab");
  if (!tabs.length) return "";

  const id = `docs-${variant}-${stableDocsId(`${variant}\n${label}\n${body}`)}`;
  const className = variant === "code-group" ? "markdown-docs-code-group" : "markdown-docs-tabs";
  const copy = markdownRendererCopy(deps.copy);
  const ariaLabel = label || (variant === "code-group" ? copy.codeExamples : copy.documentationTabs);
  return `<div class="${className}" data-doc-tabs data-docs-kit="${variant}"><div class="markdown-docs-tabs-list" role="tablist" aria-label="${deps.escape(ariaLabel)}">${tabs
    .map((tab, index) => `<button class="markdown-docs-tab-button${index === 0 ? " active" : ""}" type="button" role="tab" id="${id}-tab-${index}" aria-controls="${id}-panel-${index}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-doc-tab data-doc-tab-index="${index}">${renderInlineMarkdown(tab.title, linkSources, deps)}</button>`)
    .join("")}</div><div class="markdown-docs-tabs-panels">${tabs
    .map((tab, index) => {
      const lazyBody = index === 0 ? "" : encodeLazyPayload(tab.body);
      if (index === 0 || !lazyBody) {
        return `<div class="markdown-docs-tab-panel" role="tabpanel" id="${id}-panel-${index}" aria-labelledby="${id}-tab-${index}" data-doc-tab-panel data-doc-tab-index="${index}"${index === 0 ? "" : " hidden"}>${renderMarkdownBlocks(tab.body, linkSources, null, deps)}</div>`;
      }
      return `<div class="markdown-docs-tab-panel" role="tabpanel" id="${id}-panel-${index}" aria-labelledby="${id}-tab-${index}" data-doc-tab-panel data-doc-tab-index="${index}" hidden data-doc-tab-lazy="1" data-doc-tab-body="${deps.escape(lazyBody)}" data-doc-tab-link-sources="${linkSources ? "1" : "0"}"></div>`;
    })
    .join("")}</div></div>`;
}

function parseDocsTabs(body: string, marker: "tab" | "code"): Array<{ title: string; body: string }> {
  const tabs: Array<{ title: string; lines: string[] }> = [];
  const markerPattern = new RegExp(`^\\s*@${marker}\\s+(.+?)\\s*$`, "i");
  for (const line of String(body || "").split("\n")) {
    const match = line.match(markerPattern);
    if (match) {
      tabs.push({ title: normalizeDocsMarkerTitle(match[1]), lines: [] });
      continue;
    }
    if (tabs.length) tabs[tabs.length - 1].lines.push(line);
  }
  return tabs
    .map((tab) => ({ title: tab.title, body: tab.lines.join("\n").trim() }))
    .filter((tab) => tab.title && tab.body);
}

function normalizeDocsMarkerTitle(value: string): string {
  const trimmed = String(value || "").trim();
  const titleAttr = trimmed.match(/^title=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s]+))$/i);
  if (titleAttr) {
    return String(titleAttr[1] ?? titleAttr[2] ?? titleAttr[3] ?? titleAttr[4] ?? "").trim();
  }
  return trimmed;
}

function renderDocsParams(
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
  label: string,
  kit: "params" | "fields" | "response-fields" = "params",
): string {
  const params = String(body || "")
    .split("\n")
    .map(parseDocsParamLine)
    .filter((param): param is {
      name: string;
      type: string;
      required: boolean;
      deprecated: boolean;
      defaultValue: string;
      description: string;
    } => !!param);
  if (!params.length) return "";

  const copy = markdownRendererCopy(deps.copy);
  const title = label || (kit === "response-fields" ? copy.responseFields : "");
  return `<div class="markdown-docs-params" data-docs-kit="${kit}">${title ? `<div class="markdown-docs-params-title">${renderInlineMarkdown(title, linkSources, deps)}</div>` : ""}<div class="markdown-docs-params-head"><span>${deps.escape(copy.field)}</span><span>${deps.escape(copy.detailsColumn)}</span></div>${params
    .map((param) => `<div class="markdown-docs-param-row"><div class="markdown-docs-param-name"><code>${deps.escape(param.name)}</code><span>${renderInlineMarkdown(param.type, linkSources, deps)}</span></div><div class="markdown-docs-param-detail"><div class="markdown-docs-param-badges">${param.required ? `<span class="required">${deps.escape(copy.required)}</span>` : `<span>${deps.escape(copy.optional)}</span>`}${param.deprecated ? `<span class="deprecated">${deps.escape(copy.deprecated)}</span>` : ""}${param.defaultValue ? `<span>${deps.escape(copy.defaultValue)} <code>${deps.escape(param.defaultValue)}</code></span>` : ""}</div><p>${renderInlineMarkdown(param.description, linkSources, deps)}</p></div></div>`)
    .join("")}</div>`;
}

function parseDocsParamLine(line: string): {
  name: string;
  type: string;
  required: boolean;
  deprecated: boolean;
  defaultValue: string;
  description: string;
} | null {
  const value = String(line || "").trim().replace(/^[-*]\s+/, "").trim();
  if (!value) return null;

  const cells = value.split("|").map((cell) => cell.trim());
  if (cells.length >= 3 && cells[0] && cells[1]) {
    const meta = cells.length >= 4 ? cells.slice(2, -1).join(" ") : cells[2];
    return {
      name: stripInlineCode(cells[0]).replace(/[?!]$/, ""),
      type: stripInlineCode(cells[1]),
      required: /\brequired\b/i.test(meta) || /!$/.test(stripInlineCode(cells[0])),
      deprecated: /\bdeprecated\b/i.test(meta),
      defaultValue: extractDefaultValue(meta),
      description: cells.length >= 4 ? cells[cells.length - 1] : "",
    };
  }

  const match = value.match(/^`?([^`\s|:]+[?!]?)`?\s*[:|]\s*`?(.+?)`?\s*(?:-|:)\s*(.+)$/);
  if (!match) return null;
  const name = stripInlineCode(match[1]).replace(/[?!]$/, "");
  const typeAndMeta = match[2];
  return {
    name,
    type: stripInlineCode(typeAndMeta.replace(/\b(required|optional|deprecated)\b.*$/i, "").trim()),
    required: /\brequired\b/i.test(typeAndMeta) || /!$/.test(match[1]),
    deprecated: /\bdeprecated\b/i.test(typeAndMeta),
    defaultValue: extractDefaultValue(typeAndMeta),
    description: match[3].trim(),
  };
}

function renderDocsFiles(body: string, deps: MarkdownRendererDeps, label: string): string {
  const files = String(body || "")
    .split("\n")
    .map(parseDocsFileLine)
    .filter((file): file is { name: string; depth: number; folder: boolean } => !!file);
  if (!files.length) return "";

  const copy = markdownRendererCopy(deps.copy);
  return `<div class="markdown-docs-files" role="tree" aria-label="${deps.escape(label || copy.fileTree)}" data-docs-kit="files">${files
    .map((file) => `<div class="markdown-docs-file ${file.folder ? "is-folder" : "is-file"}" role="treeitem" aria-level="${file.depth + 1}" style="--tree-depth:${file.depth}">${deps.icon(file.folder ? "folderOpen" : "page")}<span>${deps.escape(file.name)}</span></div>`)
    .join("")}</div>`;
}

function parseDocsFileLine(line: string): { name: string; depth: number; folder: boolean } | null {
  const raw = String(line || "").trimEnd();
  if (!raw.trim()) return null;
  let depth = Math.floor((raw.match(/^\s*/)?.[0].length || 0) / 2);
  let name = raw.trim();
  const branchMatch = name.match(/^((?:(?:│| ) {2,3})*(?:├──|└──)\s*)/);
  if (branchMatch) {
    const prefix = branchMatch[1];
    depth = (prefix.match(/(?:│   |    )/g) || []).length + 1;
    name = name.slice(prefix.length).trim();
  }
  name = name.replace(/^[-*]\s+/, "").trim();
  if (!name) return null;
  const folder = /\/$/.test(name) || (depth === 0 && !/\.[\w]+$/.test(name));
  return { name: name.replace(/\/$/, ""), depth, folder };
}

function renderDocsAccordions(
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
  label: string,
): string {
  const items = parseDocsSections(body, "item");
  if (!items.length) return "";
  const title = label
    ? `<div class="markdown-docs-group-title">${renderInlineMarkdown(label, linkSources, deps)}</div>`
    : "";
  return `<div class="markdown-docs-accordion-group" data-docs-kit="accordion">${title}${items
    .map((item) => renderDetailsBlock(item.title, item.body, linkSources, deps).replace("markdown-details", "markdown-details markdown-docs-accordion"))
    .join("")}</div>`;
}

function renderDocsExample(
  kind: "request" | "response",
  label: string,
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const iconName = kind === "request" ? "terminal" : "statusCheck";
  const copy = markdownRendererCopy(deps.copy);
  const title = label || (kind === "request" ? copy.request : copy.response);
  return `<section class="markdown-docs-example markdown-docs-example-${kind}" data-docs-kit="${kind}"><div class="markdown-docs-example-head">${deps.icon(iconName)}<strong>${renderInlineMarkdown(title, linkSources, deps)}</strong></div><div class="markdown-docs-example-body">${renderMarkdownBlocks(body, linkSources, null, deps)}</div></section>`;
}

function renderDocsEndpoint(
  label: string,
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const endpoint = parseDocsEndpointLabel(label);
  const copy = markdownRendererCopy(deps.copy);
  const title = endpoint.summary || copy.endpoint;
  const bodyHtml = body.trim()
    ? `<div class="markdown-docs-endpoint-body">${renderMarkdownBlocks(body, linkSources, null, deps)}</div>`
    : "";
  return `<section class="markdown-docs-endpoint" data-docs-kit="endpoint"><div class="markdown-docs-endpoint-head"><span class="markdown-docs-method markdown-docs-method-${deps.escape(endpoint.method.toLowerCase())}">${deps.escape(endpoint.method)}</span><code>${deps.escape(endpoint.path)}</code>${title ? `<strong>${renderInlineMarkdown(title, linkSources, deps)}</strong>` : ""}</div>${bodyHtml}</section>`;
}

function parseDocsEndpointLabel(label: string): { method: string; path: string; summary: string } {
  const trimmed = String(label || "").trim();
  const match = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+(.+))?$/i);
  if (!match) return { method: "API", path: trimmed || "/", summary: "" };
  return {
    method: match[1].toUpperCase(),
    path: match[2],
    summary: String(match[3] || "").trim(),
  };
}

function renderDocsFrame(
  label: string,
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const trimmedBody = String(body || "").trim();
  const image = parseMarkdownImageLine(trimmedBody) || parseHtmlImageLine(trimmedBody);
  const content = image
    ? renderMarkdownImage(image, deps)
    : renderMarkdownBlocks(body, linkSources, null, deps);
  const caption = label || image?.caption || "";
  return `<figure class="markdown-docs-frame" data-docs-kit="frame"><div class="markdown-docs-frame-body">${content}</div>${caption ? `<figcaption>${renderInlineMarkdown(caption, linkSources, deps)}</figcaption>` : ""}</figure>`;
}

function parseMarkdownImageLine(line: string): { alt: string; src: string; caption: string } | null {
  const match = String(line || "")
    .trim()
    .match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)(?:\s*(?:-|:)\s*(.+))?$/);
  if (!match) return null;
  return {
    alt: match[1].trim(),
    src: match[2].trim(),
    caption: String(match[4] || match[3] || "").trim(),
  };
}

function parseHtmlImageLine(line: string): { alt: string; src: string; caption: string } | null {
  const value = String(line || "").trim();
  const match = value.match(/^<img\b([^>]*)\/?>$/i);
  if (!match) return null;
  const attrs = parseMdxAttrs(match[1] || "");
  const src = String(attrs.src || "").trim();
  if (!src) return null;
  return {
    alt: String(attrs.alt || "").trim(),
    src,
    caption: String(attrs.caption || attrs.title || "").trim(),
  };
}

function renderMarkdownImage(
  image: { alt: string; src: string },
  deps: Pick<MarkdownRendererDeps, "escape" | "resolveMediaSrc">,
): string {
  const originalSrc = safeDocsMediaSrc(image.src);
  const resolvedSrc = originalSrc ? safeDocsMediaSrc(deps.resolveMediaSrc?.(originalSrc) || originalSrc) : "";
  const src = resolvedSrc || originalSrc;
  if (!src) return "";
  return `<img src="${deps.escape(src)}" alt="${deps.escape(image.alt)}" loading="lazy">`;
}

function safeDocsMediaSrc(src: string): string {
  const value = String(src || "").trim();
  if (!value || /^javascript:/i.test(value)) return "";
  return value;
}

function renderDocsUpdates(
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
  label: string,
): string {
  const updates = parseDocsSections(body, "update");
  if (!updates.length) return "";
  const copy = markdownRendererCopy(deps.copy);
  const title = label
    ? `<div class="markdown-docs-group-title">${renderInlineMarkdown(label, linkSources, deps)}</div>`
    : "";
  return `<div class="markdown-docs-updates" data-docs-kit="updates">${title}${updates
    .map((update) => {
      const parsed = parseDocsUpdateTitle(update.title, copy.update);
      return `<section class="markdown-docs-update"><div class="markdown-docs-update-marker">${deps.icon("statusCheck")}</div><div class="markdown-docs-update-copy"><h4>${renderInlineMarkdown(parsed.label, linkSources, deps)}</h4>${parsed.description ? `<p class="markdown-docs-update-description">${renderInlineMarkdown(parsed.description, linkSources, deps)}</p>` : ""}${renderMarkdownBlocks(update.body, linkSources, null, deps)}</div></section>`;
    })
    .join("")}</div>`;
}

function parseDocsUpdateTitle(title: string, fallbackLabel = DEFAULT_MARKDOWN_RENDERER_COPY.update): { label: string; description: string } {
  const match = String(title || "").match(/^(.+?)\s+(?:-|:)\s+(.+)$/);
  return {
    label: (match?.[1] || title || fallbackLabel).trim(),
    description: String(match?.[2] || "").trim(),
  };
}

function parseDocsSections(body: string, marker: "item" | "update"): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  const markerPattern = new RegExp(`^\\s*@${marker}\\s+(.+?)\\s*$`, "i");
  for (const line of String(body || "").split("\n")) {
    const match = line.match(markerPattern);
    if (match) {
      sections.push({ title: match[1].trim(), lines: [] });
      continue;
    }
    if (!sections.length) {
      if (!line.trim()) continue;
      sections.push({ title: line.trim(), lines: [] });
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  return sections
    .map((section) => ({ title: section.title, body: section.lines.join("\n").trim() }))
    .filter((section) => section.title);
}

function stripInlineCode(value: string): string {
  return String(value || "").trim().replace(/^`|`$/g, "").trim();
}

function extractDefaultValue(value: string): string {
  const match = String(value || "").match(/\bdefault\s+(`[^`]+`|[^,|]+)/i);
  return match ? stripInlineCode(match[1]) : "";
}

function stableDocsId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function renderParagraphBlock(
  paragraphText: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const sourceCitationBlock = deps.compactSourceCitations
    ? renderSourceCitationBlock(paragraphText, deps)
    : null;
  if (sourceCitationBlock) return sourceCitationBlock;

  if (deps.compactSourceCitations) {
    const split = splitTrailingSourceCitation(paragraphText, deps);
    if (split) {
      const prefix = split.text.trim()
        ? `<p>${renderInlineMarkdown(split.text.trim(), linkSources, deps)}</p>`
        : "";
      return `${prefix}${split.sources}`;
    }
  }

  return `<p>${renderInlineMarkdown(paragraphText, linkSources, deps)}</p>`;
}

function renderListItemContent(
  itemText: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  if (deps.compactSourceCitations) {
    const sourceCitationBlock = renderSourceCitationBlock(itemText, deps);
    if (sourceCitationBlock) return sourceCitationBlock;

    const split = splitTrailingSourceCitation(itemText, deps);
    if (split) {
      const prefix = split.text.trim()
        ? renderInlineMarkdown(split.text.trim(), linkSources, deps)
        : "";
      return `${prefix}${prefix ? " " : ""}${split.sources}`;
    }
  }

  return renderInlineMarkdown(itemText, linkSources, deps);
}

function parseDetailsBlock(
  lines: string[],
  startIndex: number,
  fallbackSummary = DEFAULT_MARKDOWN_RENDERER_COPY.details,
): { summary: string; body: string; nextIndex: number } | null {
  if (!/^\s*<details\b/i.test(lines[startIndex] ?? "")) return null;
  const collected: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    collected.push(lines[index] ?? "");
    if (/<\/details>\s*$/i.test(lines[index] ?? "") || /<\/details>/i.test(lines[index] ?? "")) {
      break;
    }
  }
  if (index >= lines.length) return null;

  const raw = collected.join("\n");
  const openMatch = raw.match(/<details\b[^>]*>/i);
  const closeMatch = raw.match(/<\/details>/i);
  if (!openMatch || !closeMatch || closeMatch.index == null) return null;

  const content = raw.slice((openMatch.index ?? 0) + openMatch[0].length, closeMatch.index);
  const summaryMatch = content.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
  const summary = cleanHtmlText(summaryMatch?.[1] || fallbackSummary);
  const body = summaryMatch
    ? `${content.slice(0, summaryMatch.index).trim()}\n${content.slice((summaryMatch.index ?? 0) + summaryMatch[0].length).trim()}`.trim()
    : content.trim();

  return { summary, body, nextIndex: index + 1 };
}

function renderDetailsBlock(
  summary: string,
  body: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const bodyHtml = body
    ? renderMarkdownBlocks(body, linkSources, null, deps)
    : "";
  return `<details class="markdown-details"><summary>${renderInlineMarkdown(summary, linkSources, deps)}</summary><div class="markdown-details-body">${bodyHtml}</div></details>`;
}

function cleanHtmlText(value: string): string {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderCalloutBlock(
  quoteLines: string[],
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string | null {
  const first = String(quoteLines[0] || "").trim();
  const match = first.match(/^\[!(NOTE|INFO|TIP|WARNING|CHECK)\]\s*(.*)$/i);
  if (!match) return null;
  const rawKind = match[1].toLowerCase();
  const kind = rawKind === "info" ? "note" : rawKind;
  const copy = markdownRendererCopy(deps.copy);
  const fallbackTitle: Record<string, string> = {
    note: copy.note,
    tip: copy.tip,
    warning: copy.warning,
    check: copy.check,
  };
  const iconName: Record<string, string> = {
    note: "book",
    tip: "sparkles",
    warning: "alert",
    check: "statusCheck",
  };
  const title = (match[2] || "").trim() || fallbackTitle[kind] || copy.note;
  const body = quoteLines.slice(1).join("\n").trim();
  const bodyHtml = body ? renderMarkdownBlocks(body, linkSources, null, deps) : "";
  return `<aside class="markdown-callout markdown-callout-${kind}"><div class="markdown-callout-title">${deps.icon(iconName[kind] || "book")}<strong>${renderInlineMarkdown(title, linkSources, deps)}</strong></div>${bodyHtml ? `<div class="markdown-callout-body">${bodyHtml}</div>` : ""}</aside>`;
}

export function renderStreamLine(
  html: string,
  stream: MarkdownStreamState | null,
  blockKey?: string,
): string {
  if (!stream) return html;
  const index = stream.lineIndex++;
  const isNew = index >= stream.seenLines;
  const delay = isNew
    ? ` style="--stream-delay:${Math.min(index - stream.seenLines, 6) * 28}ms"`
    : "";
  // The is-new class string stays contiguous ("answer-stream-line is-new"); the
  // stable key lives in a separate data-block-key attribute that the desktop
  // PatchAskAnswerPreviewInPlace diff uses to reuse nodes across deltas.
  const keyAttr = blockKey ? ` data-block-key="${blockKey}"` : "";
  return `<div class="answer-stream-line${isNew ? " is-new" : ""}"${keyAttr}${delay}>${html}</div>`;
}

// A cheap, stable, collision-resistant key for a streamed block. The prefix (stable
// blocks) keys on block type + a content hash + an occurrence counter so two
// identical paragraphs/headings never collide and steal each other's DOM node. The
// growing LAST block always gets a positional key ("tail:N") so it patches in place
// token-by-token instead of detaching and re-animating every frame.
function streamBlockType(html: string): string {
  const match = String(html || "").match(/^<([a-z][a-z0-9-]*)/i);
  return match ? match[1].toLowerCase() : "p";
}
function streamBlockHash(html: string): string {
  let hash = 5381;
  const s = String(html || "");
  for (let i = 0; i < s.length; i += 1) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
function streamBlockKeys(blocks: string[]): string[] {
  const seen = new Map<string, number>();
  return blocks.map((block, position) => {
    if (position === blocks.length - 1) return `tail:${position}`;
    const base = `${streamBlockType(block)}:${streamBlockHash(block)}`;
    const occ = seen.get(base) || 0;
    seen.set(base, occ + 1);
    return `${base}:${occ}`;
  });
}

function renderMermaidPending(code: string, deps: MarkdownRendererDeps): string {
  // Streaming placeholder for an unterminated mermaid fence: a plain code preview
  // with NO .mermaid / .mermaid-loading class, so the diagram engine is never
  // queued on partial source. Replaced by the real diagram once the fence closes.
  return `<pre class="mermaid-pending"><code>${deps.escape(code)}</code></pre>`;
}

export function renderInlineMarkdown(
  value: string,
  linkSources: boolean,
  deps: MarkdownRendererDeps,
): string {
  const placeholders: string[] = [];
  const hold = (html: string) => {
    const key = `@@GW_PLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(html);
    return key;
  };
  const inlineValue = replaceInlineSelfClosingMdxFields(value, hold, deps);
  let html = deps
    .escape(inlineValue)
    .replace(/`([^`]+)`/g, (_match, code) => {
      const sourceRef = deps.sourceTextLabel(code.trim());
      if (linkSources && deps.isSourceReference(sourceRef))
        return hold(deps.sourceLink(code, sourceRef));
      return hold(`<code>${code}</code>`);
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_match, label, href) => {
      const sourceRef = deps.sourceTextLabel(label);
      if (linkSources && deps.isSourceReference(sourceRef))
        return deps.sourceLink(label, sourceRef);
      return href
        ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
        : label;
    });

  if (linkSources) html = autoLinkSourceReferences(html, deps);
  placeholders.forEach((placeholder, index) => {
    html = html.replace(`@@GW_PLACEHOLDER_${index}@@`, placeholder);
  });
  return html;
}

function replaceInlineSelfClosingMdxFields(
  value: string,
  hold: (html: string) => string,
  deps: MarkdownRendererDeps,
): string {
  const source = String(value || "");
  let output = "";
  let index = 0;

  while (index < source.length) {
    const nextParam = source.indexOf("<ParamField", index);
    const nextResponse = source.indexOf("<ResponseField", index);
    const candidates = [nextParam, nextResponse].filter((position) => position >= 0);
    if (!candidates.length) {
      output += source.slice(index);
      break;
    }

    const start = Math.min(...candidates);
    const tag: "ParamField" | "ResponseField" = source.startsWith("<ResponseField", start)
      ? "ResponseField"
      : "ParamField";
    const open = `<${tag}`;
    const tagEnd = findMdxTagEnd(source, start + open.length);
    if (tagEnd < 0) {
      output += source.slice(index);
      break;
    }

    const attrs = source.slice(start + open.length, tagEnd);
    if (!/\/\s*$/.test(attrs)) {
      output += source.slice(index, tagEnd + 1);
      index = tagEnd + 1;
      continue;
    }

    output += source.slice(index, start);
    output += hold(renderInlineMdxField(parseMdxAttrs(attrs.replace(/\/\s*$/, "")), deps));
    index = tagEnd + 1;
  }

  return output;
}

function renderInlineMdxField(attrs: Record<string, string>, deps: MarkdownRendererDeps): string {
  const normalized = recoverMdxFieldComparator(attrs, "");
  const fieldAttrs = normalized.attrs;
  const copy = markdownRendererCopy(deps.copy);
  const name = String(fieldAttrs.body || fieldAttrs.name || "").trim() || copy.fieldFallback;
  const type = String(fieldAttrs.type || "").trim();
  const required = fieldAttrs.required === "true";
  return `<span class="markdown-docs-inline-field" data-docs-kit="inline-field"><code>${deps.escape(name)}</code>${type ? `<span>${deps.escape(type)}</span>` : ""}<em${required ? ' class="required"' : ""}>${required ? deps.escape(copy.required) : deps.escape(copy.optional)}</em></span>`;
}

export function autoLinkSourceReferences(
  html: string,
  deps: Pick<MarkdownRendererDeps, "sourceLink">,
): string {
  const sourcePattern = new RegExp(`(^|[^\\w@./:-])(${SOURCE_FILE_REF_PATTERN})(?=$|[^\\w@/-])`, "gi");
  return html
    .split(/(<a\b[^>]*>.*?<\/a>|<[^>]+>)/gi)
    .map((part) =>
      !part || part.startsWith("<")
        ? part
        : part.replace(sourcePattern, (_match, prefix, sourceRef) =>
            `${prefix}${deps.sourceLink(sourceRef, sourceRef)}`,
          ),
    )
    .join("");
}

function isSourceCitationStart(line: string): boolean {
  return /^\s*(?:[-*]\s*)?Sources?:\s+/i.test(String(line || ""));
}

function renderSourceCitationBlock(value: string, deps: MarkdownRendererDeps): string | null {
  const match = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(/^(?:[-*]\s*)?Sources?:\s*(.+)\s*$/i);
  if (!match) return null;
  const references = extractSourceReferences(match[1]);
  if (!references.length) return null;
  const count = references.length;
  const links = references
    .map((ref) => deps.sourceLink(sourceCitationLabel(ref), ref))
    .join("");
  return `<details class="markdown-source-citations"><summary><span class="markdown-source-pill">${deps.icon("book")}<span>${count} source${count === 1 ? "" : "s"}</span></span></summary><div class="markdown-source-citation-list">${links}</div></details>`;
}

function splitTrailingSourceCitation(
  value: string,
  deps: MarkdownRendererDeps,
): { text: string; sources: string } | null {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  const matches = [...normalized.matchAll(/\bSources?:\s+/gi)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match.index == null || match.index <= 0) continue;
    const sources = renderSourceCitationBlock(normalized.slice(match.index), deps);
    if (!sources) continue;
    return {
      text: normalized.slice(0, match.index).trim(),
      sources,
    };
  }
  return null;
}

function extractSourceReferences(value: string): string[] {
  const sourcePattern = new RegExp(SOURCE_FILE_REF_PATTERN, "gi");
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of String(value || "").matchAll(sourcePattern)) {
    const ref = String(match[0] || "").trim().replace(/[),.;]+$/g, "");
    const key = ref.toLowerCase();
    if (!ref || seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function sourceCitationLabel(ref: string): string {
  const value = String(ref || "").trim();
  const namespaced = value.match(/^([\w@.-]+):(.+)$/);
  if (namespaced && /\.\w+:\d/.test(namespaced[2])) {
    return `${namespaced[1]} · ${namespaced[2]}`;
  }
  return value;
}

export function renderCodeViewer(
  code: string,
  language: string,
  showLineNumbers: boolean,
  deps: Pick<MarkdownRendererDeps, "escape" | "icon" | "copy">,
  title = "",
): string {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const lines = String(code || "").split("\n");
  const encodedFullCode = lines.length > CODE_VIEWER_INITIAL_LINE_LIMIT ? encodeLazyPayload(code) : "";
  const encodedCopyCode = encodeLazyPayload(code);
  const collapsed = !!encodedFullCode;
  const visibleCode = collapsed ? lines.slice(0, CODE_VIEWER_INITIAL_LINE_LIMIT).join("\n") : code;
  const codeHtml = renderCodeLines(visibleCode, normalizedLanguage, showLineNumbers, deps.escape);
  const zoomable = isZoomableDiagram(code, normalizedLanguage);
  const zoomAttrs = zoomable
    ? ` data-diagram-code="${deps.escape(encodeURIComponent(code))}" data-diagram-lang="${deps.escape(normalizedLanguage)}"`
    : "";
  const collapseAttrs = collapsed
    ? ` data-code-viewer-collapsed="1" data-code-full="${deps.escape(encodedFullCode)}" data-code-language="${deps.escape(normalizedLanguage)}" data-code-line-numbers="${showLineNumbers ? "1" : "0"}" data-code-line-count="${deps.escape(String(lines.length))}"`
    : "";
  const copyAttrs = encodedCopyCode
    ? ` data-code-viewer-copy-code="${deps.escape(encodedCopyCode)}"`
    : "";
  const zoomClass = zoomable ? " diagram-code-viewer" : "";
  const codeTitle = String(title || "").trim();
  const label = codeTitle
    ? `<span class="code-viewer-label"><strong>${deps.escape(codeTitle)}</strong><span>${deps.escape(normalizedLanguage)}</span></span>`
    : `<span class="code-viewer-language">${deps.escape(normalizedLanguage)}</span>`;
  const copy = markdownRendererCopy(deps.copy);
  const lineSummary = collapsed ? copy.collapsedLineCount(CODE_VIEWER_INITIAL_LINE_LIMIT, lines.length) : copy.lineCount(lines.length);
  return `
    <div class="code-viewer ${showLineNumbers ? "" : "no-lines"}${zoomClass} language-${deps.escape(normalizedLanguage)}"${zoomAttrs}${collapseAttrs}${copyAttrs}>
      <div class="code-viewer-head">
        ${label}
        <span class="code-viewer-meta"><span data-code-line-summary>${deps.escape(lineSummary)}</span><button class="code-viewer-copy" type="button" data-code-viewer-copy aria-label="${deps.escape(copy.copyCode)}" title="${deps.escape(copy.copyCode)}">${deps.icon("copy")}</button>${collapsed ? `<button class="code-viewer-expand" type="button" data-code-viewer-expand aria-label="${deps.escape(copy.showAllCodeLines(lines.length))}">${deps.icon("chevronDown")}<span>${deps.escape(copy.showAll)}</span></button>` : ""}${zoomable ? `<button class="code-viewer-zoom" type="button" data-diagram-zoom aria-label="${deps.escape(copy.openDiagramZoom)}">${deps.icon("search")}</button>` : ""}</span>
      </div>
      <pre><code>${codeHtml}</code></pre>
    </div>
  `;
}

export function codeViewerInitialLineLimit(): number {
  return CODE_VIEWER_INITIAL_LINE_LIMIT;
}

export function renderCodeLines(
  code: string,
  language: string,
  showLineNumbers: boolean,
  escape: (value: unknown) => string,
): string {
  return String(code || "")
    .split("\n")
    .map((line, index) => {
      const lineNumber = showLineNumbers
        ? `<span class="code-line-no">${String(index + 1).padStart(2, "0")}</span>`
        : "";
      const text = `<span class="code-line-text">${highlightCodeLine(
        line,
        language,
        escape,
      ) || " "}</span>`;
      return `<span class="code-line">${lineNumber}${text}</span>`;
    })
    .join("");
}

function encodeLazyPayload(value: string): string {
  try {
    return encodeURIComponent(String(value || ""));
  } catch {
    return "";
  }
}

export function normalizeCodeLanguage(language: string): string {
  const value = String(language || "").toLowerCase();
  if (value === "js" || value === "jsx" || value === "mjs" || value === "cjs")
    return "javascript";
  if (value === "ts" || value === "tsx" || value === "mts" || value === "cts")
    return "typescript";
  if (["bash", "sh", "shell", "zsh"].includes(value)) return "bash";
  if (["py", "python3", "py3"].includes(value)) return "python";
  if (value === "md") return "markdown";
  return value || "text";
}

type CodeFenceInfo = {
  language: string;
  title: string;
  rest: string;
  info: string;
};

function parseMarkdownFence(line: string): CodeFenceInfo | null {
  const match = line.match(/^```([^`]*)$/);
  if (!match) return null;
  return parseCodeFenceInfo(match[1] || "");
}

function parseCodeFenceInfo(info: string): CodeFenceInfo {
  const raw = String(info || "").trim();
  const attrs: Record<string, string> = {};
  const withoutAttrs = raw
    .replace(
      /(?:^|\s)([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s]+))/g,
      (_match, key, doubleQuoted, singleQuoted, braced, bare) => {
        attrs[String(key || "").toLowerCase()] = String(
          doubleQuoted ?? singleQuoted ?? braced ?? bare ?? "",
        ).trim();
        return " ";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
  const tokens = tokenizeCodeFenceInfo(withoutAttrs);
  const language = stripFenceInfoToken(tokens[0] || "");
  const restTokens = tokens
    .slice(1)
    .filter((token) => !/^\{[\s\S]*\}$/.test(token.trim()))
    .map(stripFenceInfoToken)
    .filter(Boolean);
  const title = attrs.title || attrs.filename || attrs.file || attrs.name || restTokens.join(" ");
  return {
    language,
    title: String(title || "").trim(),
    rest: restTokens.join(" ").trim(),
    info: raw,
  };
}

function tokenizeCodeFenceInfo(info: string): string[] {
  return String(info || "").match(/"[^"]*"|'[^']*'|\{[^}]*\}|\S+/g) || [];
}

function stripFenceInfoToken(token: string): string {
  const value = String(token || "").trim();
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2].trim();
  return value;
}

function mermaidCodeFromFence(info: string, code: string): string {
  const parsed = parseCodeFenceInfo(info);
  const language = parsed.language;
  if (!isMermaidLanguage(language) || /^(mermaid|mmd)$/i.test(language)) return code;
  const firstLine = [language, parsed.rest].filter(Boolean).join(" ").trim();
  return firstLine ? `${firstLine}\n${code}`.trimEnd() : code;
}

export function normalizeMermaidCode(code: string): string {
  const value = String(code || "");
  if (!/^\s*(?:graph|flowchart)\b/m.test(value)) return value;
  return value.replace(
    /(^|[\s{(])([A-Za-z][\w-]*)\[([^\]\n]+)\]/g,
    (match, prefix: string, nodeId: string, label: string) => {
      const trimmed = String(label || "").trim();
      if (/^(?:"|')/.test(trimmed)) return match;
      if (!/[^\w\s.-]/.test(trimmed)) return match;
      const escapedLabel = trimmed
        .replace(/"/g, "#quot;")
        .replace(/&/g, "&amp;");
      return `${prefix}${nodeId}["${escapedLabel}"]`;
    },
  );
}

export function looksLikeMermaid(language: string, code: string): boolean {
  if (!code) return false;
  const normalizedLanguage = String(language || "").toLowerCase().trim();
  const mermaidKeywords =
    /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;
  if (normalizedLanguage === "mermaid" || normalizedLanguage === "mmd")
    return true;
  if (isMermaidLanguage(normalizedLanguage)) return true;
  if (!normalizedLanguage) return mermaidKeywords.test(code);
  if (["text", "txt", "plain", "plaintext"].includes(normalizedLanguage)) {
    return mermaidKeywords.test(code);
  }
  return false;
}

function isMermaidLanguage(language: string): boolean {
  return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)$/i.test(
    language,
  );
}

export function isZoomableDiagram(code: string, language: string): boolean {
  const normalizedLanguage = normalizeCodeLanguage(language).toLowerCase();
  if (normalizedLanguage === "mermaid") return true;
  if (!["text", "txt", "plain", "ascii"].includes(normalizedLanguage)) return false;
  const nonEmptyLines = String(code || "")
    .split("\n")
    .filter((line) => line.trim());
  if (nonEmptyLines.length < 3) return false;
  const diagramGlyphs =
    (String(code || "").match(/[┌┐└┘├┤┬┴┼│─═╔╗╚╝╠╣╦╩╬+|<>/\\[\]-]/g) || [])
      .length;
  const hasStructure =
    /-->|<--|->|<-|=>|<=|[┌╔+].*[-─═]{3,}|[│|].*[│|]/.test(code);
  return hasStructure && diagramGlyphs / Math.max(String(code || "").length, 1) > 0.06;
}

export function highlightCodeLine(
  line: string,
  language: string,
  escape: (value: unknown) => string,
): string {
  const normalizedLanguage = normalizeCodeLanguage(language);
  if (normalizedLanguage === "javascript" || normalizedLanguage === "typescript")
    return highlightJsTs(line, escape);
  if (normalizedLanguage === "rust") return highlightRust(line, escape);
  if (normalizedLanguage === "python") return highlightPython(line, escape);
  if (normalizedLanguage === "json") return highlightJson(line, escape);
  if (normalizedLanguage === "bash") return highlightShell(line, escape);
  return escape(line);
}

function highlightJsTs(line: string, escape: (value: unknown) => string): string {
  const keywords = new Set([
    "await",
    "async",
    "const",
    "let",
    "var",
    "return",
    "if",
    "else",
    "for",
    "while",
    "try",
    "catch",
    "new",
    "class",
    "function",
    "import",
    "from",
    "export",
    "default",
    "true",
    "false",
    "null",
    "undefined",
  ]);
  const builtins = new Set(["Promise", "Map", "Set", "JSON", "Date", "Array", "Object"]);
  return highlightTokenStream(line, escape, {
    keywords,
    builtins,
    stringQuotes: new Set(['"', "'", "`"]),
  });
}

function highlightRust(line: string, escape: (value: unknown) => string): string {
  const keywords = new Set([
    "as",
    "async",
    "await",
    "break",
    "const",
    "continue",
    "crate",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "self",
    "Self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "unsafe",
    "use",
    "where",
    "while",
  ]);
  const builtins = new Set([
    "Result",
    "Option",
    "Some",
    "None",
    "Ok",
    "Err",
    "String",
    "Vec",
    "Box",
    "Path",
    "PathBuf",
    "HashMap",
    "HashSet",
    "Arc",
    "Mutex",
    "Duration",
    "Instant",
    "SystemTime",
    "usize",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "f32",
    "f64",
    "bool",
    "str",
    "char",
  ]);
  return highlightTokenStream(line, escape, {
    keywords,
    builtins,
    stringQuotes: new Set(['"']),
    rust: true,
  });
}

function highlightPython(line: string, escape: (value: unknown) => string): string {
  const keywords = new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "False",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "None",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "True",
    "try",
    "while",
    "with",
    "yield",
  ]);
  const builtins = new Set([
    "bool",
    "bytes",
    "dict",
    "enumerate",
    "float",
    "int",
    "len",
    "list",
    "map",
    "max",
    "min",
    "open",
    "Path",
    "print",
    "range",
    "set",
    "str",
    "sum",
    "tuple",
    "zip",
  ]);
  let html = "";
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);
    const char = line[index];

    if (char === "#") {
      html += `<span class="tok-comment">${escape(rest)}</span>`;
      break;
    }

    const stringToken = scanPythonStringToken(line, index);
    if (stringToken) {
      html += `<span class="tok-string">${escape(stringToken.value)}</span>`;
      index = stringToken.end;
      continue;
    }

    const decorator = rest.match(/^@[A-Za-z_][\w.]*/)?.[0];
    if (decorator) {
      html += `<span class="tok-attribute">${escape(decorator)}</span>`;
      index += decorator.length;
      continue;
    }

    const identifier = rest.match(/^[A-Za-z_][\w]*/)?.[0];
    if (identifier) {
      const escapedIdentifier = escape(identifier);
      const nextChar = line[index + identifier.length] || "";
      const charAfterNext = line[index + identifier.length + 1] || "";
      if (keywords.has(identifier)) {
        html += `<span class="tok-keyword">${escapedIdentifier}</span>`;
      } else if (nextChar === "=" && charAfterNext !== "=") {
        html += `<span class="tok-attribute">${escapedIdentifier}</span>`;
      } else if (builtins.has(identifier) || /^[A-Z]/.test(identifier)) {
        html += `<span class="tok-type">${escapedIdentifier}</span>`;
      } else {
        html += escapedIdentifier;
      }
      index += identifier.length;
      continue;
    }

    const number = rest.match(
      /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?j?|\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?j?)/,
    )?.[0];
    if (number) {
      html += `<span class="tok-number">${escape(number)}</span>`;
      index += number.length;
      continue;
    }

    html += escape(char);
    index += 1;
  }

  return html;
}

function scanPythonStringToken(
  line: string,
  startIndex: number,
): { value: string; end: number } | null {
  const token = line.slice(startIndex).match(/^([rRuUbBfF]{0,3})(['"])/);
  if (!token) return null;
  const quote = token[2];
  const prefixLength = token[1].length;
  const quoteStart = startIndex + prefixLength;
  const triple = line.slice(quoteStart, quoteStart + 3) === quote.repeat(3);
  let index = quoteStart + (triple ? 3 : 1);
  while (index < line.length) {
    if (!triple && line[index] === "\\") {
      index += 2;
      continue;
    }
    if (triple && line.slice(index, index + 3) === quote.repeat(3)) {
      index += 3;
      return { value: line.slice(startIndex, index), end: index };
    }
    if (!triple && line[index] === quote) {
      index += 1;
      return { value: line.slice(startIndex, index), end: index };
    }
    index += 1;
  }
  return { value: line.slice(startIndex), end: line.length };
}

function highlightShell(line: string, escape: (value: unknown) => string): string {
  const keywords = new Set([
    "alias",
    "case",
    "cd",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "eval",
    "exec",
    "export",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "local",
    "read",
    "set",
    "shift",
    "source",
    "then",
    "trap",
    "unalias",
    "unset",
    "until",
    "while",
  ]);
  let html = "";
  let index = 0;
  let expectCommand = true;

  while (index < line.length) {
    const rest = line.slice(index);
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : "";

    if (/\s/.test(char)) {
      html += escape(char);
      index += 1;
      continue;
    }

    if (char === "#" && (index === 0 || /\s/.test(previous))) {
      html += `<span class="tok-comment">${escape(rest)}</span>`;
      break;
    }

    if (char === "'" || char === '"' || char === "`") {
      const next = scanQuotedShellToken(line, index, char);
      html += `<span class="tok-string">${escape(line.slice(index, next))}</span>`;
      index = next;
      expectCommand = false;
      continue;
    }

    const variable = rest.match(/^\$(?:\{[A-Za-z_][\w]*\}|[A-Za-z_][\w]*|[#?@*!$-])/)?.[0];
    if (variable) {
      html += `<span class="tok-type">${escape(variable)}</span>`;
      index += variable.length;
      expectCommand = false;
      continue;
    }

    const flag = rest.match(/^--?[A-Za-z0-9][\w-]*(?:=(?:"[^"]*"|'[^']*'|[^\s]+))?/)?.[0];
    if (flag) {
      html += `<span class="tok-attribute">${escape(flag)}</span>`;
      index += flag.length;
      expectCommand = false;
      continue;
    }

    const assignment = rest.match(/^[A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|[^\s]*)/)?.[0];
    if (assignment) {
      const split = assignment.indexOf("=");
      html += `<span class="tok-type">${escape(assignment.slice(0, split))}</span>${escape("=")}${highlightShellAssignmentValue(assignment.slice(split + 1), escape)}`;
      index += assignment.length;
      expectCommand = false;
      continue;
    }

    const number = rest.match(/^(?:\d+\.)+\d+\b|^\d+(?:\.\d+)?\b/)?.[0];
    if (number) {
      html += `<span class="tok-number">${escape(number)}</span>`;
      index += number.length;
      expectCommand = false;
      continue;
    }

    const operator = rest.match(/^(?:&&|\|\||[;|&()<>])/)?.[0];
    if (operator) {
      html += escape(operator);
      index += operator.length;
      expectCommand = /^(?:&&|\|\||[;|(&])$/.test(operator);
      continue;
    }

    const word = rest.match(/^[^\s'"`#$;|&()<>]+/)?.[0];
    if (word) {
      const escapedWord = escape(word);
      if (keywords.has(word)) {
        html += `<span class="tok-keyword">${escapedWord}</span>`;
        expectCommand = /^(?:do|then|else|elif|while|for|if)$/.test(word);
      } else if (expectCommand && !word.includes("=")) {
        html += `<span class="tok-type">${escapedWord}</span>`;
        expectCommand = false;
      } else {
        html += escapedWord;
        expectCommand = false;
      }
      index += word.length;
      continue;
    }

    html += escape(char);
    index += 1;
  }

  return html;
}

function scanQuotedShellToken(line: string, startIndex: number, quote: string): number {
  let index = startIndex + 1;
  while (index < line.length) {
    if (quote !== "'" && line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index += 1;
  }
  return line.length;
}

function highlightShellAssignmentValue(
  value: string,
  escape: (value: unknown) => string,
): string {
  if (!value) return "";
  if (/^(['"`])/.test(value)) {
    return `<span class="tok-string">${escape(value)}</span>`;
  }
  return escape(value).replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
}

function highlightTokenStream(
  line: string,
  escape: (value: unknown) => string,
  options: {
    keywords: Set<string>;
    builtins: Set<string>;
    stringQuotes: Set<string>;
    rust?: boolean;
  },
): string {
  let html = "";
  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    if (rest.startsWith("//")) {
      html += `<span class="tok-comment">${escape(rest)}</span>`;
      break;
    }
    if (options.rust && rest.startsWith("#[")) {
      const end = line.indexOf("]", index + 2);
      const next = end >= 0 ? end + 1 : line.length;
      html += `<span class="tok-attribute">${escape(line.slice(index, next))}</span>`;
      index = next;
      continue;
    }
    const char = line[index];
    if (options.stringQuotes.has(char)) {
      let end = index + 1;
      for (; end < line.length; ) {
        if (line[end] === "\\") {
          end += 2;
          continue;
        }
        if (line[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      html += `<span class="tok-string">${escape(line.slice(index, end))}</span>`;
      index = end;
      continue;
    }
    if (options.rust) {
      const lifetime = rest.match(/^'[A-Za-z_][\w_]*\b/)?.[0];
      if (lifetime) {
        html += `<span class="tok-lifetime">${escape(lifetime)}</span>`;
        index += lifetime.length;
        continue;
      }
      const macro = rest.match(/^[A-Za-z_][\w_]*(?=!)/)?.[0];
      if (macro) {
        html += `<span class="tok-macro">${escape(macro)}</span>`;
        index += macro.length;
        continue;
      }
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier) {
      const escapedIdentifier = escape(identifier);
      if (options.keywords.has(identifier))
        html += `<span class="tok-keyword">${escapedIdentifier}</span>`;
      else if (options.builtins.has(identifier) || /^[A-Z]/.test(identifier))
        html += `<span class="tok-type">${escapedIdentifier}</span>`;
      else html += escapedIdentifier;
      index += identifier.length;
      continue;
    }
    const number = rest.match(
      options.rust
        ? /^\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?/
        : /^\d+(?:\.\d+)?/,
    )?.[0];
    if (number) {
      html += `<span class="tok-number">${escape(number)}</span>`;
      index += number.length;
      continue;
    }
    html += escape(char);
    index += 1;
  }
  return html;
}

function highlightJson(line: string, escape: (value: unknown) => string): string {
  const property = line.match(/^(\s*)("[^"]+")(\s*:)(.*)$/);
  return property
    ? `${escape(property[1])}<span class="tok-keyword">${escape(
        property[2],
      )}</span>${escape(property[3])}${highlightScalar(property[4], escape)}`
    : highlightScalar(line, escape);
}

function highlightScalar(
  value: string,
  escape: (value: unknown) => string,
): string {
  return escape(value)
    .replace(/(&quot;.*?&quot;)/g, '<span class="tok-string">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
}
