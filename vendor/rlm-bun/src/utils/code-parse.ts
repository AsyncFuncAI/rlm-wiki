/**
 * Strip markdown code fences from a code string.
 * Handles only executable ```js / ```javascript fences.
 */
export function stripCodeFences(text: string): string {
  if (!text) return "";

  // Match explicit JS/JavaScript code fences only. Bare/text/mermaid fences
  // are not executable RLM actions.
  const fenceRegex = /```(?:js|javascript)\s*\n([\s\S]*?)```/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    matches.push(match[1].trim());
  }

  if (matches.length > 0) {
    return matches.join("\n\n");
  }

  // No fences found — return as-is (might already be raw code)
  return text.trim();
}

export interface ParsedOutput {
  reasoning: string;
  code: string;
  answer: string | null;
  /** Tiny pre-step sandbox probe requested with <JIT>...</JIT>. */
  jitCode?: string;
  formatError?: string;
}

function stripJITFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:js|javascript|jit)\s*\n([\s\S]*?)```\s*$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseableJavaScript(code: string): boolean {
  try {
    // Parse only; do not execute. Used to protect final <ANSWER> submissions
    // from malformed/truncated SUBMIT source arrays.
    new Function("SUBMIT", code);
    return true;
  } catch {
    return false;
  }
}

function normalizeAnswerSubmitCode(answer: string | null, code: string): string {
  if (!answer) return code;
  const trimmed = code.trim();
  if (!trimmed) return "SUBMIT({ sources: [] });";

  // When an <ANSWER> block exists, the JS block is only a submit signal.
  // Long source arrays are telemetry, not content, and have caused truncated
  // code blocks to throw SyntaxError after the answer was already extracted.
  const submitOnly = /^SUBMIT\s*\([\s\S]*\)\s*;?\s*$/.test(trimmed);
  if (!submitOnly || trimmed.length > 1200 || !parseableJavaScript(trimmed)) {
    return "SUBMIT({ sources: [] });";
  }

  return trimmed;
}

const ACTION_TOOL_CALL_PATTERN =
  /\b(?:SUBMIT|inspect|listFiles|rg|grep|readFile|readFileRange|glob|llmQuery|llmQueryBatched|llmQueryAgent|llm_query|llm_query_batched|llm_query_agent|rlmQuery|rlm_query|rlmQueryAgent|rlm_query_agent|bash|experiment|forge_tool|listSymbols|lsp_query|graphify[A-Za-z]*|list_mcp_tools|mcp_tool_schema|getSessionEvents|remember|vars)\s*\(/;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeMarkdownAnswerWithIncidentalCode(text: string, reasoning: string, code: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || !reasoning.trim() || /\bSUBMIT\s*\(/.test(code)) return false;
  if (ACTION_TOOL_CALL_PATTERN.test(code)) return false;
  if (wordCount(trimmed) < 80) return false;

  return /(^|\n)\s*#{1,3}\s*(?:summary|findings?|issues?|sources|verification|residual test risk|positive highlights)\b/i.test(trimmed) ||
    /\bPR Review\b/i.test(trimmed);
}

function extractLastAnswerBlock(text: string): { answer: string; start: number; end: number } | null {
  const closeRegex = /<\/ANSWER>/gi;
  let closeMatch: RegExpExecArray | null;
  let result: { answer: string; start: number; end: number } | null = null;

  while ((closeMatch = closeRegex.exec(text)) !== null) {
    const beforeClose = text.slice(0, closeMatch.index);
    const openIndex = beforeClose.toLowerCase().lastIndexOf("<answer>");
    if (openIndex < 0) continue;
    const contentStart = openIndex + "<ANSWER>".length;
    result = {
      answer: text.slice(contentStart, closeMatch.index).trim(),
      start: openIndex,
      end: closeMatch.index + closeMatch[0].length,
    };
  }

  return result;
}

/**
 * Parse LLM output into reasoning, code, and optional answer.
 *
 * Extracts ONLY the first ```js code block as executable code.
 * Any <ANSWER>...</ANSWER> tags are extracted as raw answer text.
 * Any substantial text AFTER the code block is auto-detected as the answer
 * (prevents markdown with #, backticks, ${} from being eval'd).
 */
export function parseReasoningAndCode(text: string): ParsedOutput {
  if (!text) return { reasoning: "", code: "", answer: null };

  // Extract <ANSWER>...</ANSWER> block if present (raw text, never eval'd)
  let answer: string | null = null;
  let textWithoutAnswer = text;
  let actionSearchText = text;
  const answerBlock = extractLastAnswerBlock(text);
  if (answerBlock) {
    answer = answerBlock.answer;
    textWithoutAnswer = text.slice(0, answerBlock.start) + text.slice(answerBlock.end);
    const afterAnswer = text.slice(answerBlock.end).trim();
    actionSearchText = /```(?:js|javascript)\s*\n/i.test(afterAnswer) ? afterAnswer : textWithoutAnswer;
  } else {
    actionSearchText = textWithoutAnswer;
  }

  // A <JIT> block is a tiny just-in-time context peek. It is executed by the
  // host in the same persistent sandbox, but does not count as a major RLM
  // step. It must be the action for this response; the model will receive the
  // capped output and then produce the real ```js block.
  const jitMatch = /<JIT>([\s\S]*?)<\/JIT>/i.exec(actionSearchText);
  if (jitMatch) {
    const reasoning = (
      actionSearchText.slice(0, jitMatch.index) +
      actionSearchText.slice(jitMatch.index + jitMatch[0].length)
    ).trim();
    return {
      reasoning,
      code: "",
      answer,
      jitCode: stripJITFences(jitMatch[1]),
    };
  }

  // The first fenced block in an action response must be executable JS.
  // Without this guard, a bare markdown/text fence (ASCII diagrams, Mermaid,
  // prose examples) can be mistaken for code and shown/executed as a probe.
  const firstFenceRegex = /(`{3,})([^\n`]*)\r?\n/m;
  const fenceMatch = firstFenceRegex.exec(actionSearchText);

  if (!fenceMatch) {
    return { reasoning: textWithoutAnswer.trim(), code: "", answer };
  }

  const fenceLang = fenceMatch[2].trim().toLowerCase();
  if (fenceLang !== "js" && fenceLang !== "javascript") {
    const label = fenceLang || "(bare fence)";
    return {
      reasoning: actionSearchText.trim(),
      code: "",
      answer,
      formatError: `Non-executable code fence "${label}" is not allowed in an RLM action. Use exactly one \`\`\`js fenced block containing runnable exploration code.`,
    };
  }

  const fenceStart = fenceMatch.index;
  const fenceChars = fenceMatch[1]; // e.g. "```" or "````"
  const codeStart = fenceStart + fenceMatch[0].length;

  // Find the matching closing fence (same number of backticks)
  const closePattern = new RegExp(`^${fenceChars}\\s*$`, "m");
  const closeMatch = closePattern.exec(actionSearchText.slice(codeStart));

  let code = "";
  let trailing = "";

  if (closeMatch) {
    code = actionSearchText.slice(codeStart, codeStart + closeMatch.index).trim();
    trailing = actionSearchText.slice(codeStart + closeMatch.index + closeMatch[0].length).trim();
  } else {
    // No closing fence — take everything as code (best effort)
    code = actionSearchText.slice(codeStart).trim();
  }

  // Defensive: if an <ANSWER> tag ended up inside the code block, extract it
  // before it reaches eval() — this catches the common LLM mistake of placing
  // <ANSWER>...</ANSWER> inside ```js blocks (which causes SyntaxError: '<')
  const codeAnswerBlock = extractLastAnswerBlock(code);
  if (codeAnswerBlock) {
    if (!answer) answer = codeAnswerBlock.answer;
    code = (code.slice(0, codeAnswerBlock.start) + code.slice(codeAnswerBlock.end)).trim();
    // If stripping the ANSWER tag left no code, inject a bare SUBMIT
    if (!code) code = 'SUBMIT({ sources: [] });';
  }

  const reasoning = actionSearchText.slice(0, fenceStart).trim();

  // Some models write the complete markdown answer without tags and include an
  // incidental code snippet. If that snippet is not an action, keep the answer
  // instead of executing prose as JavaScript.
  if (!answer && looksLikeMarkdownAnswerWithIncidentalCode(textWithoutAnswer, reasoning, code)) {
    answer = textWithoutAnswer.trim();
    return { reasoning: "", code: "SUBMIT({ sources: [] });", answer };
  }

  // Auto-detect trailing text as answer if no <ANSWER> tag was used
  // and there's substantial content after the code block.
  // Guard: skip if trailing text is itself a code block — that's a second code snippet,
  // not prose. (This prevents the LLM's prior-step code references from being captured
  // as the answer and corrupting the SUBMIT output.)
  if (!answer && trailing.length > 50 && !trailing.trimStart().startsWith("```")) {
    answer = trailing;
  }

  code = normalizeAnswerSubmitCode(answer, code);

  return { reasoning, code, answer };
}
