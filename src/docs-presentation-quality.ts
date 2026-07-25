type DocsSurfaceFamily =
  | "cards"
  | "steps"
  | "tabs"
  | "code-group"
  | "accordion"
  | "frame"
  | "endpoint"
  | "updates"
  | "files"
  | "examples"
  | "diagram";

type DocsSurfaceBlock = {
  family: DocsSurfaceFamily;
  startLine: number;
  endLine: number;
  sectionIndex: number;
};

type NarrativeParagraph = {
  startLine: number;
  endLine: number;
  sectionIndex: number;
  visibleLength: number;
};

type ConsumedContainer = {
  family: DocsSurfaceFamily | null;
  endLine: number;
};

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

const DIRECTIVE_PATTERN =
  /^\s*:::(cards|steps|tabs|code-group|params|fields|response-fields|files|accordion|accordions|request|response|endpoint|frame|updates)(?:\s+(.+?))?\s*$/i;

const DIRECTIVE_FAMILIES: Partial<Record<DocsKitKind, DocsSurfaceFamily>> = {
  cards: "cards",
  steps: "steps",
  tabs: "tabs",
  "code-group": "code-group",
  files: "files",
  accordion: "accordion",
  accordions: "accordion",
  request: "examples",
  response: "examples",
  endpoint: "endpoint",
  frame: "frame",
  updates: "updates",
};

const MDX_COMPONENTS = new Set([
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

const MDX_FAMILIES: Partial<Record<string, DocsSurfaceFamily>> = {
  Frame: "frame",
  CardGroup: "cards",
  Steps: "steps",
  Tabs: "tabs",
  CodeGroup: "code-group",
  AccordionGroup: "accordion",
  Accordion: "accordion",
  RequestExample: "examples",
  ResponseExample: "examples",
};

const MERMAID_KEYWORDS =
  /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/;
const MERMAID_LANGUAGE_PATTERN =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)$/i;

function parseDirective(line: string): { kind: DocsKitKind } | null {
  const match = String(line || "").match(DIRECTIVE_PATTERN);
  return match ? { kind: match[1]!.toLowerCase() as DocsKitKind } : null;
}

function canNestDirective(parent: DocsKitKind, child: DocsKitKind): boolean {
  if (parent === child) return false;
  if (parent === "endpoint") return child !== "endpoint";
  return !["endpoint", "params", "fields", "response-fields", "request", "response"].includes(
    child,
  );
}

function consumeDirective(lines: string[], startLine: number): ConsumedContainer | null {
  const directive = parseDirective(lines[startLine] || "");
  if (!directive) return null;

  let nestedDepth = 0;
  let fenced = false;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    const value = lines[line] || "";
    if (/^```/.test(value.trim())) {
      fenced = !fenced;
      continue;
    }
    const nested = !fenced ? parseDirective(value) : null;
    if (nested) {
      if (nestedDepth === 0 && !canNestDirective(directive.kind, nested.kind)) {
        return {
          family: DIRECTIVE_FAMILIES[directive.kind] || null,
          endLine: line,
        };
      }
      nestedDepth += 1;
      continue;
    }
    if (!fenced && /^\s*:::\s*$/.test(value)) {
      if (nestedDepth > 0) {
        nestedDepth -= 1;
        continue;
      }
      return {
        family: DIRECTIVE_FAMILIES[directive.kind] || null,
        endLine: line + 1,
      };
    }
  }

  return {
    family: DIRECTIVE_FAMILIES[directive.kind] || null,
    endLine: lines.length,
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

function parseMdxOpenTag(
  line: string,
): { tag: string; rest: string; selfClosing: boolean } | null {
  const value = String(line || "").trim();
  const match = value.match(/^<([A-Z][A-Za-z0-9]*)\b/);
  if (!match) return null;
  const tagEnd = findMdxTagEnd(value, match[0].length);
  if (tagEnd < 0) return null;
  const attrs = value.slice(match[0].length, tagEnd);
  return {
    tag: match[1]!,
    rest: value.slice(tagEnd + 1).trim(),
    selfClosing: /\/\s*$/.test(attrs),
  };
}

function sameTagBalanceOnLine(line: string, tag: string): number {
  const value = String(line || "");
  const tagToken = new RegExp(`<(/?)${tag}\\b`, "gi");
  let balance = 0;
  for (let match = tagToken.exec(value); match; match = tagToken.exec(value)) {
    if (match[1]) {
      const close = value.slice(match.index).match(new RegExp(`^</${tag}>`, "i"));
      if (!close) continue;
      balance -= 1;
      tagToken.lastIndex = match.index + close[0].length;
      continue;
    }
    const tagEnd = findMdxTagEnd(value, tagToken.lastIndex);
    if (tagEnd < 0) continue;
    const attrs = value.slice(tagToken.lastIndex, tagEnd);
    if (!/\/\s*$/.test(attrs)) balance += 1;
    tagToken.lastIndex = tagEnd + 1;
  }
  return balance;
}

function consumeMdxComponent(lines: string[], startLine: number, tag: string): number | null {
  const opening = parseMdxOpenTag(lines[startLine] || "");
  if (!opening || opening.tag !== tag || opening.selfClosing) return null;
  let balance = sameTagBalanceOnLine(lines[startLine] || "", tag);
  if (balance <= 0) return startLine + 1;

  let fenced = false;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    const value = lines[line] || "";
    if (/^```/.test(value.trim())) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    balance += sameTagBalanceOnLine(value, tag);
    if (balance <= 0) return line + 1;
  }
  return null;
}

function parseMdxFieldTag(line: string): "ParamField" | "ResponseField" | null {
  const match = String(line || "").trim().match(/^<(ParamField|ResponseField)\b/);
  return match ? (match[1] as "ParamField" | "ResponseField") : null;
}

function isSelfClosingMdxFieldLine(
  line: string,
  tag: "ParamField" | "ResponseField",
): boolean {
  const value = String(line || "").trim();
  if (!value) return false;

  let offset = 0;
  let rows = 0;
  while (offset < value.length) {
    while (/\s/.test(value[offset] || "")) offset += 1;
    if (offset >= value.length) break;
    const slice = value.slice(offset);
    const match = slice.match(new RegExp(`^<${tag}\\b`));
    if (!match) return false;
    const tagEnd = findMdxTagEnd(slice, match[0].length);
    if (tagEnd < 0) return false;
    const attrs = slice.slice(match[0].length, tagEnd);
    if (!/\/\s*$/.test(attrs)) return false;
    rows += 1;
    offset += tagEnd + 1;
  }
  return rows > 0;
}

function consumeMdxFieldRun(lines: string[], startLine: number): number | null {
  const tag = parseMdxFieldTag(lines[startLine] || "");
  if (!tag) return null;

  let rows = 0;
  let line = startLine;
  for (; line < lines.length; ) {
    const value = lines[line] || "";
    if (!value.trim()) {
      line += 1;
      continue;
    }
    if (isSelfClosingMdxFieldLine(value, tag)) {
      rows += 1;
      line += 1;
      continue;
    }
    const opening = parseMdxOpenTag(value);
    if (!opening || opening.tag !== tag || opening.selfClosing) break;
    const endLine = consumeMdxComponent(lines, line, tag);
    if (endLine == null) break;
    rows += 1;
    line = endLine;
  }

  return rows > 0 ? line : null;
}

function consumeSupportedMdx(lines: string[], startLine: number): ConsumedContainer | null {
  const fieldEnd = consumeMdxFieldRun(lines, startLine);
  if (fieldEnd != null) return { family: null, endLine: fieldEnd };

  const opening = parseMdxOpenTag(lines[startLine] || "");
  if (!opening || opening.selfClosing || !MDX_COMPONENTS.has(opening.tag)) return null;
  const endLine = consumeMdxComponent(lines, startLine, opening.tag);
  if (endLine == null) return null;
  return {
    family: MDX_FAMILIES[opening.tag] || null,
    endLine,
  };
}

function consumeDetails(lines: string[], startLine: number): ConsumedContainer | null {
  const openingLine = lines[startLine] || "";
  if (!/^\s*<details\b/i.test(openingLine)) return null;
  let balance = sameTagBalanceOnLine(openingLine, "details");
  if (balance <= 0) {
    return /<\/details>/i.test(openingLine)
      ? { family: "accordion", endLine: startLine + 1 }
      : null;
  }

  let fenced = false;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    const value = lines[line] || "";
    if (/^```/.test(value.trim())) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    balance += sameTagBalanceOnLine(value, "details");
    if (balance <= 0) return { family: "accordion", endLine: line + 1 };
  }
  return null;
}

function consumeSupportedContainer(lines: string[], startLine: number): ConsumedContainer | null {
  return (
    consumeDirective(lines, startLine) ||
    consumeSupportedMdx(lines, startLine) ||
    consumeDetails(lines, startLine)
  );
}

type CodeFenceInfo = {
  language: string;
  rest: string;
  info: string;
};

function tokenizeCodeFenceInfo(info: string): string[] {
  return String(info || "").match(/"[^"]*"|'[^']*'|\{[^}]*\}|\S+/g) || [];
}

function stripFenceInfoToken(token: string): string {
  const value = String(token || "").trim();
  const quoted = value.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2]!.trim() : value;
}

function parseCodeFenceInfo(info: string): CodeFenceInfo {
  const raw = String(info || "").trim();
  const withoutAttrs = raw
    .replace(
      /(?:^|\s)([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s]+))/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const tokens = tokenizeCodeFenceInfo(withoutAttrs);
  const language = stripFenceInfoToken(tokens[0] || "");
  const rest = tokens
    .slice(1)
    .filter((token) => !/^\{[\s\S]*\}$/.test(token.trim()))
    .map(stripFenceInfoToken)
    .filter(Boolean)
    .join(" ")
    .trim();
  return { language, rest, info: raw };
}

function parseMarkdownFence(line: string): CodeFenceInfo | null {
  const match = String(line || "").match(/^```([^`]*)$/);
  return match ? parseCodeFenceInfo(match[1] || "") : null;
}

function isMermaidLanguage(language: string): boolean {
  return MERMAID_LANGUAGE_PATTERN.test(language);
}

function mermaidCodeFromFence(fence: CodeFenceInfo, code: string): string {
  if (!isMermaidLanguage(fence.language) || /^(mermaid|mmd)$/i.test(fence.language)) return code;
  const firstLine = [fence.language, fence.rest].filter(Boolean).join(" ").trim();
  return firstLine ? `${firstLine}\n${code}`.trimEnd() : code;
}

function looksLikeMermaid(language: string, code: string): boolean {
  if (!code) return false;
  const normalizedLanguage = String(language || "").toLowerCase().trim();
  if (normalizedLanguage === "mermaid" || normalizedLanguage === "mmd") return true;
  if (isMermaidLanguage(normalizedLanguage)) return true;
  if (!normalizedLanguage) return MERMAID_KEYWORDS.test(code);
  if (["text", "txt", "plain", "plaintext"].includes(normalizedLanguage)) {
    return MERMAID_KEYWORDS.test(code);
  }
  return false;
}

function isZoomableAsciiDiagram(code: string, language: string): boolean {
  const normalizedLanguage = String(language || "text").toLowerCase().trim();
  if (!["text", "txt", "plain", "ascii"].includes(normalizedLanguage)) return false;
  const nonEmptyLines = String(code || "")
    .split("\n")
    .filter((line) => line.trim());
  if (nonEmptyLines.length < 3) return false;
  const diagramGlyphs =
    (String(code || "").match(/[┌┐└┘├┤┬┴┼│─═╔╗╚╝╠╣╦╩╬+|<>/\\[\]-]/g) || []).length;
  const hasStructure = /-->|<--|->|<-|=>|<=|[┌╔+].*[-─═]{3,}|[│|].*[│|]/.test(code);
  return hasStructure && diagramGlyphs / Math.max(String(code || "").length, 1) > 0.06;
}

function consumeFence(
  lines: string[],
  startLine: number,
  fence: CodeFenceInfo,
): { endLine: number; diagram: boolean } {
  const codeLines: string[] = [];
  let line = startLine + 1;
  for (; line < lines.length; line += 1) {
    if (/^```\s*$/.test(lines[line] || "")) {
      line += 1;
      break;
    }
    codeLines.push(lines[line] || "");
  }
  const code = mermaidCodeFromFence(fence, codeLines.join("\n"));
  const language = fence.language || "text";
  return {
    endLine: line,
    diagram: looksLikeMermaid(language, code) || isZoomableAsciiDiagram(code, language),
  };
}

function consumeIndentedCode(
  lines: string[],
  startLine: number,
): { endLine: number; diagram: boolean } {
  const codeLines: string[] = [];
  let line = startLine;
  for (
    ;
    line < lines.length &&
    ((lines[line] || "") === "" || /^(?: {4}|\t)/.test(lines[line] || ""));
    line += 1
  ) {
    codeLines.push((lines[line] || "").replace(/^(?: {4}|\t)/, ""));
  }
  const code = codeLines.join("\n").trimEnd();
  return {
    endLine: line,
    diagram: looksLikeMermaid("", code) || isZoomableAsciiDiagram(code, "text"),
  };
}

function isTableDivider(value: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value);
}

function isStandaloneImage(value: string): boolean {
  return /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(value);
}

function isListMarker(value: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(value);
}

function isTrueTopLevelBlock(lines: string[], line: number): boolean {
  const value = lines[line] || "";
  if (!value || /^\s/.test(value)) return false;
  if (consumeSupportedContainer(lines, line)) return true;
  if (parseMarkdownFence(value)) return true;
  if (/^#{1,6}\s+\S/.test(value) || /^-{3,}\s*$/.test(value)) return true;
  if (isStandaloneImage(value)) return true;
  if (value.includes("|") && isTableDivider(lines[line + 1] || "")) return true;
  if (/^>\s?/.test(value) || /^:::/i.test(value)) return true;
  return false;
}

function consumeListBlock(lines: string[], startLine: number): number {
  let line = startLine + 1;
  while (line < lines.length && (lines[line] || "").trim()) {
    const value = lines[line] || "";
    if (isListMarker(value)) {
      line += 1;
      continue;
    }
    if (consumeSupportedContainer(lines, line)) break;
    if (/^\s/.test(value)) {
      line += 1;
      continue;
    }
    if (isTrueTopLevelBlock(lines, line)) break;
    line += 1;
  }
  return line;
}

function visibleParagraphText(lines: string[]): string {
  return lines
    .join(" ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[\*_~]/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleCodePointLength(value: string): number {
  return Array.from(value).length;
}

function isParagraphBoundary(lines: string[], line: number): boolean {
  const value = lines[line] || "";
  if (!value.trim()) return true;
  if (consumeSupportedContainer(lines, line)) return true;
  if (parseMarkdownFence(value)) return true;
  if (/^(?: {4}|\t)/.test(value)) return true;
  if (/^#{1,6}\s+\S/.test(value)) return true;
  if (/^\s*-{3,}\s*$/.test(value)) return true;
  if (isStandaloneImage(value)) return true;
  if (value.includes("|") && isTableDivider(lines[line + 1] || "")) return true;
  if (isListMarker(value)) return true;
  if (/^>\s?/.test(value)) return true;
  if (/^\s*:::/i.test(value)) return true;
  return false;
}

function scanTopLevel(body: string): {
  blocks: DocsSurfaceBlock[];
  paragraphs: NarrativeParagraph[];
} {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: DocsSurfaceBlock[] = [];
  const paragraphs: NarrativeParagraph[] = [];
  let sectionIndex = -1;
  let line = 0;

  while (line < lines.length) {
    const value = lines[line] || "";
    if (!value.trim()) {
      line += 1;
      continue;
    }

    const container = consumeSupportedContainer(lines, line);
    if (container) {
      if (container.family) {
        blocks.push({
          family: container.family,
          startLine: line,
          endLine: container.endLine,
          sectionIndex,
        });
      }
      line = Math.max(line + 1, container.endLine);
      continue;
    }

    const fence = parseMarkdownFence(value);
    if (fence) {
      const consumed = consumeFence(lines, line, fence);
      if (consumed.diagram) {
        blocks.push({
          family: "diagram",
          startLine: line,
          endLine: consumed.endLine,
          sectionIndex,
        });
      }
      line = Math.max(line + 1, consumed.endLine);
      continue;
    }

    if (/^(?: {4}|\t)/.test(value)) {
      const consumed = consumeIndentedCode(lines, line);
      if (consumed.diagram) {
        blocks.push({
          family: "diagram",
          startLine: line,
          endLine: consumed.endLine,
          sectionIndex,
        });
      }
      line = Math.max(line + 1, consumed.endLine);
      continue;
    }

    if (/^##\s+\S/.test(value)) {
      sectionIndex += 1;
      line += 1;
      continue;
    }
    if (/^#{1,6}\s+\S/.test(value) || /^\s*-{3,}\s*$/.test(value) || isStandaloneImage(value)) {
      line += 1;
      continue;
    }

    if (value.includes("|") && isTableDivider(lines[line + 1] || "")) {
      line += 2;
      while (line < lines.length && (lines[line] || "").trim() && (lines[line] || "").includes("|")) {
        line += 1;
      }
      continue;
    }

    if (isListMarker(value)) {
      line = consumeListBlock(lines, line);
      continue;
    }

    if (/^>\s?/.test(value)) {
      line += 1;
      while (line < lines.length && /^>\s?/.test(lines[line] || "")) line += 1;
      continue;
    }

    if (/^\s*:::/i.test(value)) {
      line += 1;
      continue;
    }

    const startLine = line;
    const paragraphLines: string[] = [];
    while (line < lines.length && !isParagraphBoundary(lines, line)) {
      paragraphLines.push(lines[line] || "");
      line += 1;
    }
    if (line === startLine) {
      line += 1;
      continue;
    }
    const visibleLength = visibleCodePointLength(visibleParagraphText(paragraphLines));
    if (visibleLength > 0) {
      paragraphs.push({ startLine, endLine: line, sectionIndex, visibleLength });
    }
  }

  return { blocks, paragraphs };
}

function hasNarrativeBridge(
  paragraphs: NarrativeParagraph[],
  previous: DocsSurfaceBlock,
  next: DocsSurfaceBlock,
): boolean {
  return paragraphs.some(
    (paragraph) =>
      paragraph.sectionIndex === previous.sectionIndex &&
      paragraph.startLine >= previous.endLine &&
      paragraph.endLine <= next.startLine &&
      paragraph.visibleLength >= 24,
  );
}

export function documentationPresentationQualityIssue(body: string): string | null {
  const { blocks, paragraphs } = scanTopLevel(body);
  const openingBlock = blocks.find((block) => block.sectionIndex < 0);
  if (openingBlock) {
    return `the docs page placed a ${openingBlock.family} component before the first section; start with plain orientation prose`;
  }

  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1]!;
    const next = blocks[index]!;
    if (
      previous.sectionIndex === next.sectionIndex &&
      previous.family !== next.family &&
      !hasNarrativeBridge(paragraphs, previous, next)
    ) {
      return `the docs page stacked ${previous.family} and ${next.family} components without explanatory prose between them`;
    }
  }

  const familiesBySection = new Map<number, Set<DocsSurfaceFamily>>();
  for (const block of blocks) {
    const families = familiesBySection.get(block.sectionIndex) || new Set<DocsSurfaceFamily>();
    families.add(block.family);
    familiesBySection.set(block.sectionIndex, families);
    if (families.size > 2) {
      return "the docs page mixes more than two rich component families in one section; split the section or keep the clearest component";
    }
  }

  return null;
}
