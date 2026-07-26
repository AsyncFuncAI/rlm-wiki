/**
 * Prompt for the chat/ask agent.
 *
 * JCODE owns repository exploration. Normal ask prompts treat wiki context as a
 * map, then ask it to inspect the cloned repository before answering. Docs
 * inline asks treat generated documentation MDX as the primary source first.
 */
import type { AgentRuntime } from "../agent-runtime.ts";
import { knowledgeProfilePrompt, type KnowledgeProfile } from "../knowledge-profile.ts";
import { normalizeRepoSourcePath } from "../types.ts";
import { renderAskHistoryBlock } from "./ask-history.ts";

export type AskIntent = "repo" | "docs-inline";

// The Clarify interview keeps the user's question verbatim and carries their
// answers to the clarifying questions as a separate transcript. Inject them as an
// AUTHORITATIVE refinement: the model must treat them as binding constraints that
// disambiguate the literal wording, not optional background. Without this framing
// the agent tends to answer the original (vaguer) question and ignore the
// clarifications the user just gave.
export function renderClarifyBlock(clarifyContext?: string | null): string {
  const text = typeof clarifyContext === "string" ? clarifyContext.trim() : "";
  if (!text) return "";
  return `## Clarified intent (authoritative)
The user kept their question as written above, then answered clarifying questions to pin down what they actually want. These answers REFINE and, where they conflict with a literal reading, OVERRIDE the question. Treat them as binding requirements: scope, prioritize, and shape your answer to satisfy them, and do not drift back to a broader or different interpretation of the original wording.

${text}

`;
}

const ASK_FAST_PATTERNS = [
  "## Fast exploration pattern",
  "Use this compact shape for Fast mode. It is intentionally small.",
  "Do not copy placeholder paths from examples. Derive every path and line range from rg/glob/inspect/listSymbols output in the current repository.",
  "",
  "### Narrow factual or where-would-I-change question",
  "Usually one search/map step plus one range-read step is enough:",
  "```js",
  "const hits = await rg(\"exact flag, route, symbol, or error text from the question\", { glob: \"**/*.{ts,tsx,js,jsx}\", maxResults: 20 });",
  "console.log(hits.map(h => `${h.file}:${h.line} ${h.text}`).join(\"\\n\"));",
  "```",
  "Pick the entry point, the state/data boundary, and the nearest test or test gap; then answer with a cited change map.",
].join("\n");

const ASK_DEEP_PATTERNS = [
  "## Deep exploration pattern",
  "Deep mode should feel meaningfully deeper than Fast mode while staying bounded.",
  "Do not copy placeholder paths from examples. Derive every path and line range from rg/glob/inspect/listSymbols output in the current repository.",
  "",
  "### Architecture, lifecycle, trace, audit, or why question",
  "Step 1 should map candidates with simple literal searches, not read bodies:",
  "```js",
  "const patterns = [\"session\", \"streamText\", \"provider\", \"persist\"];",
  "const allHits = [];",
  "for (const pattern of patterns) {",
  "  const hits = await rg(pattern, { glob: \"**/*.{ts,tsx,js,jsx}\", maxResults: 8 });",
  "  allHits.push(...hits);",
  "}",
  "console.log(allHits.map(h => `${h.file}:${h.line} ${h.text}`).join(\"\\n\"));",
  "```",
  "Step 2 should read the entry point and 2-4 load-bearing spans derived from those hits:",
  "```js",
  "const selected = allHits.slice(0, 5);",
  "const spans = [];",
  "for (const h of selected) {",
  "  spans.push(await readFileRange(h.file, Math.max(1, h.line - 12), h.line + 28));",
  "}",
  "for (const s of spans) console.log(`--- ${s.path}:${s.startLine}-${s.endLine}\\n${s.content}`);",
  "```",
  "Step 3 should verify one adjacent caller, config, test, route, or absence search when the question asks how/why/architecture:",
  "```js",
  "const verificationHits = await rg(\"symbol or route you now believe is central\", { glob: \"**/*.{ts,tsx,js,jsx,json,md}\", maxResults: 20 });",
  "console.log(verificationHits.map(h => `${h.file}:${h.line} ${h.text}`).join(\"\\n\"));",
  "```",
  "Only then submit. If the repo is tiny or has only one relevant file, say that explicitly and cite the searches that established the limited scope.",
  "",
  "### Avoid this cost trap",
  "```js",
  "const files = await Promise.all(paths.map(path => readFile(path)));",
  "```",
  "That is a broad read sweep. Replace it with rg/glob/inspect first, then readFileRange for the spans that can change the answer.",
].join("\n");

function askExplorationPatterns(mode: "fast" | "deep"): string {
  return mode === "fast" ? ASK_FAST_PATTERNS : ASK_DEEP_PATTERNS;
}

export function buildChatPrompt(args: {
  owner: string;
  repo: string;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  wikiContext?: string | null;
  sourcePath?: string | null;
  askMode?: "fast" | "deep";
  askIntent?: AskIntent;
  /**
   * Lossless clarification transcript from the Clarify interview ("- <question>:
   * <answer>" lines). The user's `question` stays verbatim; this refines it.
   */
  clarifyContext?: string | null;
  runtime?: AgentRuntime;
  knowledgeProfile?: KnowledgeProfile;
}): string {
  const { owner, repo, question, history = [], wikiContext, askMode = "deep", askIntent = "repo", runtime = "agent", knowledgeProfile } = args;
  const docsInline = askIntent === "docs-inline";
  const clarifyBlock = renderClarifyBlock(args.clarifyContext);
  const sourcePath = normalizeRepoSourcePath(args.sourcePath);
  const repoLabel = sourcePath ? `${owner}/${repo}:${sourcePath}` : `${owner}/${repo}`;

  const historyBlock = renderAskHistoryBlock(history);
  const hasCodeKb = typeof wikiContext === "string" && wikiContext.includes("<code-kb>");

  const wikiBlock = wikiContext
    ? docsInline
      ? `## Documentation context
Use this generated documentation MDX as the primary source for this answer. Before using any file, search, read, or shell tool, decide whether this MDX is sufficient. If it fully answers the question, do not inspect repository files.

${wikiContext}

`
      : `## Wiki context
Use this generated wiki context as a starting map only. Verify claims against repository files before answering.${hasCodeKb ? " When a `<code-kb>` block is present, treat its live graph queries as the preferred path for locate and call-graph work (budgeted; see the block)." : ""}

${wikiContext}

`
    : "";

  const modeBlock = askMode === "fast"
    ? `## Ask mode: Fast
Optimize for a direct, evidence-backed answer in under one minute. Do the smallest useful repository inspection${hasCodeKb ? " (prefer 1-2 code-graph queries before local search when the question is structural)" : ""}, then answer once the claim is supported.

`
    : `## Ask mode: Deep
Do a thorough repository investigation. Spend extra effort on architecture, trace, audit, comparison, and "why" questions.${hasCodeKb ? " Prefer budgeted code-graph queries for structural hops, then verify with focused local reads." : ""}

	`;
  const knowledgeBlock = knowledgeProfilePrompt(knowledgeProfile, "ask");
  const sourceScopeBlock = sourcePath
    ? `## Source scope
This Ask run is scoped to \`${sourcePath}/\` inside **${owner}/${repo}**. Treat that folder as the source root. Do not inspect unrelated repository folders outside this scope. If tools return paths relative to the prepared working directory, cite those relative scoped paths; if tools return repository-root-relative paths, keep the \`${sourcePath}/\` prefix.

`
    : "";

  const harnessBlock = docsInline
    ? runtime === "rlm"
      ? `You are running inside an rlm-bun agent with JavaScript sandbox access to the cloned repository. Start from the Documentation context. Before running any file, search, read, or shell tool, compare the question against the Documentation context. If the generated MDX answers the question, answer directly from it without repository inspection. Use sandbox tools only when the documentation context is missing, ambiguous, or needs implementation verification.

Useful tools include \`inspect\`, \`readFile\`, \`readFileRange\`, \`rg\`, \`grep\`, \`glob\`, \`listFiles\`, \`experiment\`, \`llmQuery\`, \`llmQueryBatched\`, and \`llmQueryAgent\` when available in the sandbox. \`rg(pattern, opts)\` is the preferred ripgrep-backed search tool; \`grep\` remains a compatibility alias. Use one executable JavaScript block per step.`
      : runtime === "local-cli"
      ? `A local CLI agent is running in the prepared repository. Start from the Documentation context. Before running native file, search, read, shell, or verification tools, compare the question against the docs. If the generated MDX answers the question, answer directly from it without repository inspection. Use tools only when the documentation context is missing, ambiguous, or needs implementation verification.`
      : `JCODE is running in the cloned repository. Start from the Documentation context. Before running native tools, compare the question against the docs. If the generated MDX answers the question, answer directly from it without repository inspection. Use tools only when the documentation context is missing, ambiguous, or needs implementation verification.`
    : runtime === "rlm"
    ? `You are running inside an rlm-bun agent with JavaScript sandbox access to the cloned repository. Use the sandbox tools to inspect real files, search symbols, run focused commands, and verify behavior. Do not answer from memory or from the wiki context alone. Your first meaningful step should be a repository-inspection JavaScript block.

Useful tools include \`inspect\`, \`readFile\`, \`readFileRange\`, \`rg\`, \`grep\`, \`glob\`, \`listFiles\`, \`experiment\`, \`llmQuery\`, \`llmQueryBatched\`, and \`llmQueryAgent\` when available in the sandbox. \`rg(pattern, opts)\` is the preferred ripgrep-backed search tool; \`grep\` remains a compatibility alias. Use one executable JavaScript block per step.`
    : runtime === "local-cli"
    ? `A local CLI agent is running in the prepared repository. Use the selected CLI agent's native file, search, shell, and verification tools to inspect the actual implementation. Do not answer from memory or from the wiki context alone.${hasCodeKb ? " When a code graph block is present, proactively curl its query/file endpoints for locate and call-graph questions before multi-step local search (at most 4 successful graph queries, then write)." : ""}`
    : `JCODE is running in the cloned repository. Use JCODE's native tools to inspect the actual files, search symbols, run focused commands, and verify behavior. Do not answer from memory or from the wiki context alone.${hasCodeKb ? " When a code graph block is present, proactively curl its query/file endpoints for locate and call-graph questions before multi-step local search (at most 4 successful graph queries, then write)." : ""}`;

  const citationGuidance = docsInline
    ? "When the answer comes from the Documentation context, cite the relevant docs page title or heading in prose. If you inspect repository files, cite only the implementation claims with clickable exact line ranges like `Sources: [src/foo.ts:42-58]()`. Do not invent file citations for docs-only answers."
    : "Use concise source citations for the key implementation claims that anchor the answer; do not append `Sources:` to every sentence or every bullet. When citing, use clickable Markdown references with exact line ranges like `Sources: [src/foo.ts:42-58]()`. Use the full repo-relative path found by search/read; only use a root-level citation like `Sources: [local_connection.py:421-479]()` when the file is actually at the repository root. Do not cite file-line references as bare text or inline code like `src/foo.ts:42-58`.";
  const finalOutput = runtime === "rlm"
    ? docsInline
      ? `Return the complete markdown answer inside one \`<ANSWER>...</ANSWER>\` block. If you answered from Documentation context only, call \`SUBMIT({ sources: [] })\` after the answer. If you inspected repository files, include representative cited paths in \`SUBMIT({ sources: [...] })\`. Do not put the answer inside JavaScript or a markdown fence.`
      : `Return the complete markdown answer inside one \`<ANSWER>...</ANSWER>\` block. Include concise source citations for representative evidence inside the answer. After the answer, emit one tiny JavaScript block that calls \`SUBMIT({ sources: [...] })\` with representative cited paths. Do not put the answer inside JavaScript or a markdown fence.`
    : `Return the complete user-facing answer inside one \`<ANSWER>...</ANSWER>\` block as non-empty Markdown with concise source citations for representative evidence. A tools-only transcript with no final answer is a failed task — after any tools, you must still emit the \`<ANSWER>\` block. Do not put the answer inside a markdown fence. Do not call SUBMIT.`;

  if (runtime !== "rlm") {
    return `# Ask Task

Answer the user's question about **${repoLabel}**${docsInline ? " from the generated documentation first" : " using the prepared repository as the source of truth"}.

${historyBlock}${wikiBlock}${knowledgeBlock ? `${knowledgeBlock}\n\n` : ""}${sourceScopeBlock}## Question
${question}

${clarifyBlock}## Guidance
- ${docsInline ? "If the Documentation context answers the question, answer from that MDX without searching or reading repository files." : hasCodeKb ? "Prefer budgeted code-graph queries for locate/call-graph work, then search/read only the files you will cite." : "Search/read the relevant files before answering."}
- ${docsInline ? "Before using file, search, read, or shell tools, decide whether the Documentation context is sufficient." : hasCodeKb ? "Cap successful graph queries at 4, then write. Local rg remains fallback when the graph is unhealthy or after the budget." : "Use focused searches before broad reads."}
- ${docsInline ? "Only inspect repository files when the documentation context is insufficient, ambiguous, or the question explicitly asks for implementation verification." : "If the repository does not contain the answer, say so and cite the search or file evidence."}
- ${citationGuidance}
- ${finalOutput}

Mode: ${askMode === "fast" ? "Fast — keep the inspection focused." : "Deep — inspect enough surrounding code to answer confidently."}`;
  }

  return `You are an expert code analyst answering a question about the GitHub repository **${repoLabel}**.

${harnessBlock}

${historyBlock}${wikiBlock}${knowledgeBlock ? `${knowledgeBlock}\n\n` : ""}${sourceScopeBlock}${modeBlock}## User Question
${question}

${clarifyBlock}## How To Work
- Think Socratically before choosing tools: what evidence would change the answer, which file or command can produce it, and what is the smallest verified next move?
- ${docsInline ? "Start with the Documentation context. Before using any file, search, read, or shell tool, decide whether the generated MDX supports the answer. If it does, do not perform repository study." : hasCodeKb ? "Start with repository evidence. Prefer budgeted code-graph queries for locate and call-graph hops, then read only the files you will cite. For architecture questions, use context/trace_path before broad local tours." : "Start with repository evidence. For factual questions, search for the symbol/config/route/error text and read the owning implementation. For architecture questions, map entry points and boundaries before reading details."}
- ${docsInline ? "Proceed to repository study only when the docs are out of context, incomplete, ambiguous, or the user asks for implementation-level proof." : hasCodeKb ? "Cap successful graph queries at 4, then write. Use local search as fallback or for citation verification, not as the first structural tool while the graph is healthy." : "Use targeted repository inspection before answering."}
- ${runtime === "rlm" ? "Before any unfamiliar `readFile(\"path\")`, prove the path exists with `rg`, `glob`, `listFiles`, or `inspect`; then use `readFileRange(path, start, end)` around exact hits when line spans are known." : "Use targeted search and reads before answering."}
- ${runtime === "rlm" ? "Do not bulk-read arrays of files with `Promise.all(files.map(readFile))`; first print a candidate map, choose the load-bearing spans, and stop once the answer is supported." : "Avoid broad file sweeps unless the question truly needs them."}
- Use runtime checks for claims about behavior, regressions, generated output, or tests when the repo provides a safe way to run them.
- Track precise source paths and line ranges while inspecting. Prefer narrow supporting spans over whole-file citations.
- If the repository does not contain the requested answer, say so and cite the searches or files that establish the absence.
${runtime === "rlm" ? `- ${docsInline ? "If you inspect repository files, keep a `sources` array and include the same file:line spans in `SUBMIT({ sources })`. If you answer from Documentation context only, submit an empty sources array." : "Keep a `sources` array as you work. If your answer cites file:line spans, the final `SUBMIT({ sources })` must include those same spans. Never submit an empty sources array for a code answer."}
- If the user asks you to send/post/publish the answer to an external system, that side effect is part of the task. Perform it after enough repo evidence, preserve returned id/timestamp/link, and report cleanly if it fails.
${askMode === "deep" ? `- Deep mode evidence floor: for architecture, lifecycle, trace, audit, implementation, "how", or "why" questions, inspect at least an entry point plus one adjacent caller/config/test/route or an explicit absence search before submitting. The answer should usually cite a few representative precise spans, but group citations by paragraph or section instead of repeating them on every bullet.` : ""}

${askExplorationPatterns(askMode)}
` : ""}

## Answer Style
- Start with the direct answer.
- Be concise but complete. Use bullets, short sections, tables, or diagrams only when they make the answer clearer.
- ${citationGuidance}
- Do not put the answer in a markdown fence.

## Final Output
${finalOutput}

Budget: ${askMode === "fast" ? "aim for 1-2 focused inspection steps." : "up to 12 focused investigation steps."}`;
}
