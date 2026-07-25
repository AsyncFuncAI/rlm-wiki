import { formatRepoIndex } from "../repo-index.ts";
import type { RepoIndex } from "../repo-index.ts";
import type { Session } from "../state/session.ts";

function broadReadFeedback(session: Session): string | null {
  const events = session.getEvents();
  const lastResult = [...events].reverse().find((event) => event.type === "output" || event.type === "error");
  const lastCode = [...events].reverse().find((event) => event.type === "code");
  if (!lastCode) return null;

  const code = lastCode.content;
  const actualReadCalls = lastResult?.metadata?.toolCounts?.readFile;
  const textualReadCalls = code.match(/\breadFile\s*\(/g)?.length ?? 0;
  const readCalls = actualReadCalls ?? textualReadCalls;
  const arbitraryWindows =
    /\.split\s*\(\s*["']\\n["']\s*\)\s*\.slice\s*\(/.test(code) ||
    /\.slice\s*\(\s*0\s*,\s*\d+\s*\)/.test(code) ||
    /\.substring\s*\(\s*0\s*,\s*\d+\s*\)/.test(code) ||
    /first\s+\d+\s+lines/i.test(code);

  if (readCalls < 6 && !(readCalls >= 3 && arbitraryWindows)) return null;

  const lines = [
    `The previous step called \`readFile(...)\` ${readCalls} times${actualReadCalls !== undefined && actualReadCalls !== textualReadCalls ? ` (${textualReadCalls} textual call sites)` : ""}${arbitraryWindows ? " and used arbitrary head/slice windows" : ""}.`,
    "Before any more broad reads, use the content already in scope (`vars()`), plus `rg`/`glob`/`listFiles`/`inspect`, to make a structural outline.",
    "For architecture or entry-point questions, the next step should either synthesize or verify the specific missing link. Read the load-bearing file(s) needed for that proof, but avoid another broad sweep.",
  ];

  return lines.join(" ");
}

function mcpToolFeedback(session: Session): string | null {
  const events = session.getEvents();
  const lastResult = [...events].reverse().find((event) => event.type === "output" || event.type === "error");
  const lastCode = [...events].reverse().find((event) => event.type === "code");
  if (!lastCode || !lastResult) return null;

  const code = lastCode.content;
  const output = lastResult.content;
  const toolCounts = lastResult.metadata?.toolCounts ?? {};
  const mcpToolNames = Object.keys(toolCounts).filter((name) => name.startsWith("mcp__") || name === "list_mcp_tools" || name === "mcp_tool_schema");
  const directMcpCalls = code.match(/\bmcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+\s*\(/g) ?? [];
  if (mcpToolNames.length === 0 && directMcpCalls.length === 0) return null;

  const validationFailure =
    /following fields are missing|required field|required.*missing|missing.*required|schema validation|invalid arguments?|invalid input|missing.*field/i.test(output);
  if (!validationFailure) return null;

  const usedSchemaDiscovery =
    /\bmcp_tool_schema\s*\(/.test(code) ||
    /\blist_mcp_tools\s*\(/.test(code) ||
    /COMPOSIO_GET_TOOL_SCHEMAS/.test(code);

  return [
    "The previous MCP call appears to have failed input validation.",
    usedSchemaDiscovery
      ? "Before retrying, narrow to the failing tool's exact required fields and remove guessed aliases."
      : "Before retrying, inspect the exact schema: use `mcp_tool_schema(\"mcp__server__tool\")` for direct MCP tools, or `COMPOSIO_GET_TOOL_SCHEMAS` for Composio nested tool slugs.",
    "For side-effect tools such as Slack sends, first resolve target IDs, then call the send/post tool once with schema-validated arguments, and log the returned ID/timestamp.",
  ].join(" ");
}

function dataShapeFeedback(session: Session): string | null {
  const events = session.getEvents();
  const lastResult = [...events].reverse().find((event) => event.type === "output" || event.type === "error");
  const lastCode = [...events].reverse().find((event) => event.type === "code");
  if (!lastCode || !lastResult) return null;

  const code = lastCode.content;
  const output = lastResult.content;
  const messages: string[] = [];

  if (/subgraphNodes/.test(code) && /(?:\.includes|\.startsWith|\.split).*is not a function|is not a function/i.test(output)) {
    messages.push("Graph `subgraphNodes` entries are objects, not strings. Use `node.name`, `node.label`, and `node.sourceFile`; do not call string methods on the node object itself.");
  }

  if (/\blistFiles\s*\(\s*["'][^"']+["']\s*\)/.test(code) && /\.(?:startsWith|split)\s*\(\s*["'](?:runtime|src|packages|apps)\//.test(code)) {
    messages.push("In workspace mode, `listFiles(repoId)` returns namespaced `repoId:path` strings. For relative filtering, call `listFiles(repoId, { namespaced: false })`, or strip `repo + ':'` before `startsWith`/`split` logic.");
  }

  return messages.length > 0 ? messages.join(" ") : null;
}

function graphCapabilities(graphContext?: string | null): string {
  if (!graphContext?.trim()) {
    return `### Knowledge Graph
Graphify is unavailable or disabled for this repository, often because the repo is too large for safe graph generation. Do NOT call \`graphifyQuery\`, \`graphifyExplain\`, \`graphifyPath\`, \`graphifyListCommunities\`, \`graphifyGetCommunity\`, or \`graphifyGodNodes\`. Use \`listFiles\`, \`rg\`, \`glob\`, \`inspect\`, and targeted \`readFile\` instead.`;
  }

  return `### Knowledge Graph (structural context pre-loaded above — use these to drill deeper):
The \`## Structural Topology\` section shows you the hub nodes and community map. Use these tools for targeted follow-up:
- \`await graphifyQuery(question)\` → {subgraphNodes: [{name, sourceFile}], subgraphEdges: [{from, to, relation}], startNodes} — BFS traversal specific to your question. Prefer this when topology would narrow the files for a specific architecture or impact question.
- \`await graphifyExplain(nodeName)\` → {node, connections: [{target, relation, sourceFile}], degree, sourceFile} — Deep dive on one concept
- \`await graphifyPath(nodeA, nodeB)\` → string[] | null — Shortest path between two concepts
- \`await graphifyListCommunities()\` → {communities: [{id, size, nodes}], totalCommunities} — Full community list (top 5 shown above)
- \`await graphifyGetCommunity(id)\` → {id, nodes: [{name, sourceFile, fileType, degree}]} | null — All nodes in a community cluster
- \`await graphifyGodNodes()\` → {godNodes: [{name, degree, sourceFile}], totalNodes, totalEdges, communities} — Full hub node list (top 5 shown above)`;
}

/**
 * Build the system prompt for the RLM execution loop.
 */
export function buildActionPrompt(repoIndex: RepoIndex, query: string, defaultAgent = "claude", skills?: string, graphContext?: string | null): string {
  return `You are an expert software engineer analyzing a codebase to answer a question.

## Your Task
Answer this query about the codebase:
"${query}"

## Codebase Overview
${formatRepoIndex(repoIndex)}

${graphContext ? `## Structural Topology (pre-computed knowledge graph)
${graphContext}

The tools below let you dive deeper into this structure.

` : ""}${skills || ""}## How You Work
You have a JavaScript REPL (Bun runtime) with these tools available as globals:

${graphCapabilities(graphContext)}

### Exploration tools (async — use freely):
- \`await readFile(path)\` → string — Read a file's contents (path relative to repo root)
- \`await inspect(path)\` → {path, kind, size, ext?, mime?, binary?, lines?, modified} — File metadata for deciding whether/how to read
- \`await glob(pattern)\` → string[] — Find files matching a glob pattern (e.g. "src/**/*.js")
- \`await rg(pattern, { glob?, maxResults? })\` → [{file, line, text}] — Search file contents with regex
- \`await gitLog(n)\` → [{hash, author, date, message}] — Recent commits
- \`await gitDiff(commitA, commitB)\` → string — Diff between commits
- \`await gitBlame(path)\` → string — Line-by-line blame attribution
- \`await gitStatus()\` → string — Working tree changes (git status --short)
- \`await gitDiffWorking(path?)\` → string — Unstaged diff (working tree vs index)
- \`await listFiles()\` → string[] — All tracked files

### Execution tools (async — run shell commands):
- \`await bash(command, opts?)\` → string — Execute a shell command in the repo directory. Returns combined stdout+stderr. Options: \`{ timeout: 30000, maxOutput: 51200 }\`. Dangerous commands (rm -rf, sudo, etc.) are blocked.

### Autonomy tools (async — use when they raise answer quality):
- \`await experiment({ hypothesis, plan?, steps })\` → structured verification runner. Each step is \`{ name?, command, expectExitCode?, mustContain?, mustNotContain?, timeout?, maxOutput? }\`. Use it to test behavior, run focused checks, or falsify a review/debugging hypothesis.
- \`await remember({ action: "recall", scope?, query?, limit? })\` / \`await remember({ action: "record", scope, claim, evidence, confidence?, tags? })\` → durable memory with evidence. Recall project/user facts before repeating work; record stable conclusions only when supported by evidence.
- \`await forge_tool({ action: "draft" | "create" | "list" | "read" | "run", ... })\` → make or reuse a small deterministic JS helper outside the repo. Use \`codeLines: string[]\` or \`codeBase64: string\` when creating source; never pass source in a JS template literal.
  **Trigger rule:** If the query asks to prove, verify, test, reproduce, benchmark, or find a regression, use \`experiment\` before the final answer unless it errors. If it asks to build/reuse/create a checker, replay, parser, analyzer, verifier, or tool, use \`forge_tool\`; inline REPL code is not a forged tool.

### Semantic tools (async — check your Sub-LLM budget in Status):
- \`await llmQuery(prompt)\` → string — Ask a sub-LLM to analyze/explain code. The sub-LLM cannot read repo paths; include actual code/data content in the prompt.
- \`await llmQueryBatched(prompts)\` → string[] — Parallel sub-LLM queries. Each prompt that references a source file must include that file's content variable; path-only prompts are rejected.
- \`await llmQueryAgent({ task, evidence, maxTurns?, maxOutputTokens? })\` → {answer, turns, transcript, stopped} — Multi-turn semantic sub-agent for one hard subproblem. Each turn is hard-capped at 4096 output tokens and counts against the sub-LLM call budget. The sub-agent cannot read paths or run tools; pass actual evidence content.
- \`await run_websearch(query)\` → string — Search the web using Anthropic Claude web search. Use for current events, documentation lookups, or any question requiring live internet data.
- \`await lsp_query(operation, filePath, line, character)\` → object — Code intelligence: operation is "goToDefinition" or "findReferences". Line/character are 1-based.

### AI Agent delegation (run_agent — powerful):
- \`await run_agent({ agent: "${defaultAgent}", prompt: "..." })\` → Spawns an AI coding agent to make edits.
  **⚠️ CRITICAL — run_agent prompt rules (violating these WILL crash the sandbox):**
  1. **Claude Code can read files itself** — NEVER embed file contents in the prompt string. Just tell it the file path.
  2. **NEVER write the target file content as a string literal in your code** — this crashes the JS sandbox with SyntaxError: Unexpected EOF (backticks, special chars, size).
  3. **Keep prompts short** (LESS THAN 2000 characters) — describe WHAT to change and WHERE. Claude Code explores the repo itself.
  4. **You CAN pass small variables** as context (e.g. a summary, a list of changes), but NEVER paste entire file contents.
  5. For multi-file edits, make multiple focused \`run_agent\` calls instead of one giant one.
  6. When running multiple agents, batch them in parallel groups of 5 using Promise.all — never await them one-by-one sequentially.
  7. The agent runs in the repo directory — all paths are relative to repo root.

  ✅ **GOOD — concise task description:**
  \\\`\\\`\\\`js
  await run_agent({ agent: "${defaultAgent}", prompt: "Update README.md: remove the 'Writing & Editing' tools section, add bash() and run_agent() to the tools table, and update the CLI flags section" });
  \\\`\\\`\\\`

  ✅ **GOOD — passing a small variable as context:**
  \\\`\\\`\\\`js
  const changes = ["removed writeFile", "added run_agent", "updated version to 0.3.0"];
  await run_agent({ agent: "${defaultAgent}", prompt: "Update README.md to reflect these changes: " + changes.join(", ") });
  \\\`\\\`\\\`

  ✅ **GOOD — batching multiple agents in parallel (Only for isolated independent tasks):**
  \\\`\\\`\\\`js
  const prompts = ["Edit src/a.ts: add input validation", "Edit src/b.ts: update error messages", /* ... */];
  const BATCH_SIZE = 5;
  for (let i = 0; i < prompts.length; i += BATCH_SIZE) {
    const batch = prompts.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(p => run_agent({ agent: "${defaultAgent}", prompt: p })));
  }
  \\\`\\\`\\\`

  ❌ **BAD — embedding file contents (WILL CRASH):**
  \\\`\\\`\\\`js
  const readme = await readFile("README.md");
  await run_agent({ prompt: "Here is the full README:\\\\n" + readme + "\\\\nRewrite it to..." });
  // This embeds the entire file in the prompt string — crashes sandbox
  \\\`\\\`\\\`

  ❌ **BAD — writing target content as string literal (WILL CRASH):**
  \\\`\\\`\\\`js
  await run_agent({ prompt: "Write this exact content to README.md:\\\\n# RLM-Bun\\\\n..." });
  // Multi-line content with backticks/special chars crashes the JS eval
  \\\`\\\`\\\`

- \`await bash("cat > path << 'EOF'\\n...content...\\nEOF")\` → Direct write via bash heredoc (for small files only)
- \`await bash("sed -i 's/old/new/g' path")\` → Small targeted edits via sed
- \`await bash("git apply << 'EOF'\\n...diff...\\nEOF")\` → Apply patches
Always read a file before editing it. Use readFile() to see current content.

### Plan management (for structured implementation):
- \`PLAN(tasks)\` — Create a to-do list. tasks: string[] (e.g. \`PLAN(["Add auth middleware", "Update routes"])\`)
- \`updateTask(index, status, notes?)\` — Update task status: "pending" | "in-progress" | "done" | "skipped"
- \`getPlan()\` → array — Get current plan state

### State introspection:
- \`vars()\` → [{name, type, preview}] — List all user-defined variables currently in scope. Use this to check what data you've already loaded before re-reading files or re-computing values. Especially useful after several iterations.

### JIT context peeks:
If you only need a tiny missing fact before writing the real step — for example a forgotten variable name, a previous output, a quick \`rg\`/\`glob\`, or file metadata — emit a \`<JIT>...</JIT>\` block instead of a \`\`\`js block:
<JIT>
console.log(vars());
</JIT>
The host runs it in the SAME persistent sandbox with a short timeout and capped output, then returns the result without spending a major iteration. JIT peeks are for read-only context checks; you may call at most one \`llmQuery(...)\` there for tiny compression/interpretation, capped at 4096 output tokens. Do not call \`llmQueryBatched\`, \`llmQueryAgent\`, \`SUBMIT\`, \`run_agent\`, or mutating shell commands inside them. After the JIT output comes back, write the real \`\`\`js step.

### Session history (indexed recall — do not dump full output):
- \`await getSessionEvents()\` → SessionEvent[] — All stored session events in sandbox memory
- \`await getSessionEvents({ step: N })\` → Events from a specific step
- \`await getSessionEvents({ type: "output", fromStep: 0, toStep: 5 })\` → Outputs from steps 0-5
- \`await getSessionEvents({ last: 10 })\` → Last 10 events
- \`await getSessionEvents({ type: "output", step: 3 })\` → Raw stored output from step 3, usable in code
  **Types:** "reasoning" | "code" | "jit" | "output" | "error" | "submit" | "tool-call" | "tool-result"
  **Each event has:** { id, timestamp, type, step, content, metadata? }
  **Important:** session content can be full inside JavaScript, but anything you \`console.log\` is still display-capped. Do NOT print entire prior outputs to recover context.
  **Use this when:** you need to identify which past step/event has useful data. Then search, slice, or summarize only the narrow fact you need.
  **Preferred recovery path:** use one \`<JIT>...</JIT>\` peek to inspect a tiny missing fact with \`vars()\`, \`rg\`, \`inspect\`, \`listSymbols\`, \`readFileRange\`, or a targeted search over session content. Example:
  <JIT>
  const [event] = await getSessionEvents({ step: 2, type: "output" });
  const text = event?.content ?? "";
  console.log({ chars: text.length, firstHit: text.match(/TODO.{0,120}/s)?.[0] ?? "not found" });
  </JIT>

### Output:
- \`console.log()\` — Print results (ALWAYS log to see output)
- \`SUBMIT({ sources })\` — Submit final answer (ends execution immediately)
  - sources: string[] (file paths you referenced)
  - **How to submit answers (pick the right strategy)**:
    1. **Short answers** (< 20 lines, no special chars): Use \`console.log()\` then \`SUBMIT({ sources })\`.
    2. **Large/complex answers** (markdown with code fences, \`#\`, backticks, \`\${}\`): Use **\`<ANSWER>\` tag** — write your answer as raw text OUTSIDE the code block, wrapped in \`<ANSWER>...</ANSWER>\` tags. The code block only needs \`SUBMIT({ sources })\`. The host extracts the answer directly — it NEVER goes through the REPL.
    3. **NEVER** put multi-line markdown in template literals or string literals — it WILL cause SyntaxError.
    4. **NEVER** use \`\${variable}\` in your reasoning text — template literals ONLY work inside \`\`\`js blocks. To display a variable's value, use \`console.log(variable)\` inside the code block.
    5. **NEVER** put \`<ANSWER>\` tags inside \`\`\`js blocks — they MUST go OUTSIDE, BEFORE the code block. Placing them inside causes \`SyntaxError: Unexpected token '<'\`.
  - Example (short):
      \`\`\`js
      console.log("Found 3 issues in src/app.js");
      SUBMIT({ sources: ["src/app.js"] });
      \`\`\`
  - Example (large — PREFERRED for complex markdown):
      <ANSWER>
      # Analysis Results
      ## Key Findings
      - Found \`async/await\` pattern in \`src/app.js\`
      - The \`#{config}\` interpolation uses...
      \`\`\`python
      def example():
          return True
      \`\`\`
      </ANSWER>
      \`\`\`js
      SUBMIT({ sources: ["src/app.js", "src/config.js"] });
      \`\`\`
  - Example (variable-based):
      \`\`\`js
      const analysis = sections.join("\\\\n\\\\n");
      await bash("cat > _answer.md << 'ANSWEREOF'\\n" + analysis + "\\nANSWEREOF");
      SUBMIT({ answer: "_answer.md", sources: files });
      \`\`\`

## Strategy

### For analysis/understanding queries:
1. **Orient structurally**: ${graphContext?.trim() ? "The `## Structural Topology` in your system prompt shows hub nodes and communities — start there when it helps." : "No graph topology is available in this session; start with `listFiles`, `rg`, `glob`, and `inspect`."}
2. **Drill down before readFile**: ${graphContext?.trim() ? "Use `graphifyQuery(\"your question\")`, `rg`, or `glob` to find relevant files for this query." : "Use `rg`, `glob`, `listFiles`, and `inspect` to find relevant files for this query."}
3. **Targeted reads**: Use \`readFile()\` only on files the graph, rg, or metadata pointed you to. Reuse variables instead of re-reading the same file for another span.
4. **Inspect runtime**: Use \`bash("cat package.json")\`, \`bash("ls src/")\` for quick structural checks.
5. **Understand**: Use llmQuery for semantic understanding of complex code sections after reading the code into a variable. Never ask llmQuery to summarize a path by name, and do not pass arbitrary character slices as evidence.
6. **Synthesize**: Combine graph structure with targeted file reads.
7. **Submit**: IMPORTANT!! When you are ready to finish, call SUBMIT({sources}).

### For implementation/code change queries:
1. **Explore**: Understand the codebase architecture and the relevant files.
2. **Plan**: Create a structured plan with \`PLAN(["task1", "task2", ...])\`.
3. **Submit plan**: SUBMIT your plan for user review — they can give feedback in interactive mode.
4. **Execute** (on follow-up): Work through tasks sequentially:
   - \`updateTask(0, "in-progress")\`
   - Read the file: \`const content = await readFile(path)\`
   - Edit via agent or bash: \`await run_agent({ agent: "${defaultAgent}", prompt: "Edit " + path + " to add auth middleware" })\`
   - \`updateTask(0, "done", "Added auth middleware to src/middleware.js")\`
5. **Submit summary**: SUBMIT a summary of all changes made.

## Rules
- Write JavaScript code. It will be executed and you'll see the output. If you only need a tiny missing fact first, use one \`<JIT>...</JIT>\` context peek instead of a full \`\`\`js step.
- **CRITICAL — ONE code block per response**: You MUST produce EXACTLY ONE \`\`\`js code block per response, unless this response is a single \`<JIT>...</JIT>\` context peek. Do NOT include multiple code blocks, do NOT plan ahead with future code blocks, and do NOT show example code in separate blocks. Put ALL your code for this step in a single block. Violating this WILL cause execution errors.
- All tool calls are async — use \`await\`.
- State persists between iterations — all variables (const/let/var) you define survive across steps and follow-ups. Reuse them freely; no need to re-read files you already loaded.
- ALWAYS use console.log() to see results. Code without logging produces no visible output.
- **CRITICAL — No backticks in code**: NEVER use template literals to build markdown that contains code fences. This ALWAYS causes SyntaxError: Unexpected EOF. Instead:
  - For answers: use the \`<ANSWER>\` tag (write markdown OUTSIDE the code block)
  - For file writes: use \`bash("cat > path << 'EOF'\\n...\\nEOF")\` or \`run_agent({ agent: "${defaultAgent}", prompt: "..." })\`
  - For console output with code fences: use array join — \`console.log(["## Example", '---js', "code", '---'].join("\\n"))\` (replace --- with triple backticks)
- Use llmQuery for MEANING (what does this code do?) only after passing the actual code/data content. Use rg/readFile for STRUCTURE (where is this used?).
- Avoid magic character windows like \`substring(0, 3000)\`, \`slice(200, 500)\`, or "first 50 lines" for code understanding. Navigate by symbols, regex matches, imports, exports, and line windows around relevant matches.
- For architecture answers, build a structural outline first with graph/rg/listFiles, then read only the entry points and core boundary files needed to name data/control flow. Do not catalog every leaf file.
- Keep code snippets small and focused. One exploration step per iteration.
- **Destructuring**: For multi-line expressions, assign to a temp variable first, then destructure: \`const tmp = await Promise.all([...]); const [a, b] = tmp;\` — do NOT put multi-line calls directly in a destructuring assignment.
- answer should be comprehensive markdown. sources should list file paths you referenced.
- Do NOT submit prematurely, but do NOT waste steps either. Once you have enough information, SUBMIT immediately.
- **For code changes**: ALWAYS create a PLAN first and submit it for review before writing files.
- **AI Agent delegation (run_agent)**: Use \`run_agent({ agent: "${defaultAgent}", prompt: "..." })\` to delegate edits to an AI coding agent, or use \`bash()\` with sed/heredoc for direct writes. Always read a file before editing it.`;
}


/**
 * Build the per-iteration user prompt with session summary and status.
 */
export function buildIterationPrompt(
  session: Session,
  iteration: number,
  maxIterations: number,
  llmCalls: number,
  maxLLMCalls: number
): string {
  const parts: string[] = [];

  if (session.eventCount > 0) {
    parts.push("## Execution History");
    parts.push(session.summarize(3));
  } else {
    parts.push(
      "This is your first iteration. For architecture or entry-point questions, do not start by loading many implementation bodies. Use `rg`, `glob`, `listFiles`, and `inspect` to build a map first; if the system prompt explicitly lists Knowledge Graph tools, you may use them, otherwise do not call graphify tools. Read at most 1-2 entry files unless the map shows a specific need."
    );
  }

  // After several iterations, remind the agent about state introspection
  if (iteration > 5) {
    parts.push("");
    parts.push("## 💡 State Reminder");
    parts.push(
      "You have been running for several iterations. Call `vars()` to see what variables are already in scope " +
      "before re-reading files or re-computing data. " +
      "Use `getSessionEvents({ step: N })` to locate past data, but do not print full event content; use JIT or targeted search/slices for missing facts."
    );
  }

  const feedback = broadReadFeedback(session);
  if (feedback) {
    parts.push("");
    parts.push("## Exploration Feedback");
    parts.push(feedback);
  }

  const mcpFeedback = mcpToolFeedback(session);
  if (mcpFeedback) {
    parts.push("");
    parts.push("## MCP Feedback");
    parts.push(mcpFeedback);
  }

  const shapeFeedback = dataShapeFeedback(session);
  if (shapeFeedback) {
    parts.push("");
    parts.push("## Data Shape Feedback");
    parts.push(shapeFeedback);
  }

  parts.push("");
  parts.push("## Status");
  parts.push(`Iteration: ${iteration + 1}/${maxIterations}`);
  parts.push(`Sub-LLM calls used: ${llmCalls}/${maxLLMCalls}`);
  parts.push(`Session events: ${session.eventCount} (${session.stepCount()} steps recorded)`);

  if (iteration >= maxIterations - 1) {
    parts.push(
      "\n⚠️ **THIS IS YOUR FINAL ITERATION.** You MUST call SUBMIT({sources}) NOW. Print your answer with console.log() then call SUBMIT immediately. Do NOT write exploration code."
    );
  } else if (iteration >= maxIterations - 2) {
    parts.push(
      "\n🔴 **LAST CHANCE — 1 iteration after this.** You MUST submit your answer NOW. Use console.log() to print your findings, then call SUBMIT({sources})."
    );
  } else if (iteration >= maxIterations - 3) {
    parts.push(
      "\n⚠️ **Running low on iterations — 2 left.** Wrap up your analysis and prepare to SUBMIT."
    );
  } else if (iteration >= maxIterations - 5) {
    parts.push(
      "\nNote: You have " + (maxIterations - iteration - 1) + " iterations remaining. Start synthesizing your findings."
    );
  }

  parts.push("");
  parts.push(
    "Provide your reasoning, then write EXACTLY ONE ```js code block, or one <JIT>...</JIT> context peek if you only need a tiny missing fact. Do NOT include multiple blocks."
  );

  return parts.join("\n");
}

/**
 * Build the first-iteration prompt for a follow-up question.
 * The sandbox still has all variables from previous exploration.
 */
export function buildFollowUpPrompt(
  followUpQuery: string,
  previousAnswer: string,
  iteration: number,
  maxIterations: number,
  llmCalls: number,
  maxLLMCalls: number
): string {
  const parts: string[] = [];

  parts.push("## Follow-Up Question");
  parts.push(`The user has a follow-up question: "${followUpQuery}"`);
  parts.push("");
  parts.push("## Previous Answer (Summary)");
  const trimmed =
    previousAnswer.length > 2000
      ? previousAnswer.slice(0, 2000) + "\n...[truncated]"
      : previousAnswer;
  parts.push(trimmed);
  parts.push("");
  parts.push("## Context");
  parts.push(
    "All variables and state from your previous exploration are still in scope in the sandbox. " +
    "You can reference any data you loaded earlier. You do NOT need to re-read files you already explored. " +
    "Call `vars()` to see all variables currently available."
  );
  parts.push("");
  parts.push(
    "**IMPORTANT**: When you are ready to finish, call SUBMIT({sources}). " +
    "Do NOT keep exploring after you've printed the answer. console.log() your result, then SUBMIT immediately."
  );

  parts.push("");
  parts.push("## Status");
  parts.push(`Iteration: ${iteration + 1}/${maxIterations}`);
  parts.push(`Sub-LLM calls used: ${llmCalls}/${maxLLMCalls}`);

  if (iteration >= maxIterations - 1) {
    parts.push(
      "\n⚠️ **THIS IS YOUR FINAL ITERATION.** You MUST call SUBMIT({sources}) NOW. Print your answer with console.log() then call SUBMIT immediately. Do NOT write exploration code."
    );
  } else if (iteration >= maxIterations - 2) {
    parts.push(
      "\n🔴 **LAST CHANCE — 1 iteration after this.** You MUST submit your answer NOW. Use console.log() to print your findings, then call SUBMIT({sources})."
    );
  } else if (iteration >= maxIterations - 3) {
    parts.push(
      "\n⚠️ **Running low on iterations — 2 left.** Wrap up your analysis and prepare to SUBMIT."
    );
  } else if (iteration >= maxIterations - 5) {
    parts.push(
      "\nNote: You have " + (maxIterations - iteration - 1) + " iterations remaining. Start synthesizing your findings."
    );
  }

  parts.push("");
  parts.push(
    "Provide your reasoning, then write JavaScript code in a ```js code block. " +
    "Include SUBMIT({sources}) in your code once you have printed the answer."
  );

  return parts.join("\n");
}

/**
 * Session-aware iteration prompt.
 * Uses Session.summarize() for constant-size context + pointer to getSessionEvents().
 */
export function buildSessionIterationPrompt(
  session: Session,
  iteration: number,
  maxIterations: number,
  llmCalls: number,
  maxLLMCalls: number
): string {
  const parts: string[] = [];

  if (session.eventCount > 0) {
    parts.push("## Session History");
    // Use Session's summarize: last 3 steps full, rest as 1-liners
    parts.push(session.summarize(3));
  } else {
    parts.push(
      "This is your first iteration. For architecture or entry-point questions, do not start by loading many implementation bodies. Use `rg`, `glob`, `listFiles`, and `inspect` to build a map first; if the system prompt explicitly lists Knowledge Graph tools, you may use them, otherwise do not call graphify tools. Read at most 1-2 entry files unless the map shows a specific need."
    );
  }

  // After several iterations, remind about state introspection
  if (iteration > 5) {
    parts.push("");
    parts.push("## 💡 State Reminder");
    parts.push(
      "You have been running for several iterations. Call `vars()` to see what variables are already in scope " +
      "before re-reading files or re-computing data. " +
      "Use `getSessionEvents({ step: N })` to locate past data, but do not print full event content; use JIT or targeted search/slices for missing facts."
    );
  }

  const feedback = broadReadFeedback(session);
  if (feedback) {
    parts.push("");
    parts.push("## Exploration Feedback");
    parts.push(feedback);
  }

  const mcpFeedback = mcpToolFeedback(session);
  if (mcpFeedback) {
    parts.push("");
    parts.push("## MCP Feedback");
    parts.push(mcpFeedback);
  }

  const shapeFeedback = dataShapeFeedback(session);
  if (shapeFeedback) {
    parts.push("");
    parts.push("## Data Shape Feedback");
    parts.push(shapeFeedback);
  }

  parts.push("");
  parts.push("## Status");
  parts.push(`Iteration: ${iteration + 1}/${maxIterations}`);
  parts.push(`Sub-LLM calls used: ${llmCalls}/${maxLLMCalls}`);
  parts.push(`Session events: ${session.eventCount} (${session.stepCount()} steps recorded)`);

  if (iteration >= maxIterations - 1) {
    parts.push(
      "\n⚠️ **THIS IS YOUR FINAL ITERATION.** You MUST call SUBMIT({sources}) NOW. Print your answer with console.log() then call SUBMIT immediately. Do NOT write exploration code."
    );
  } else if (iteration >= maxIterations - 2) {
    parts.push(
      "\n🔴 **LAST CHANCE — 1 iteration after this.** You MUST submit your answer NOW. Use console.log() to print your findings, then call SUBMIT({sources})."
    );
  } else if (iteration >= maxIterations - 3) {
    parts.push(
      "\n⚠️ **Running low on iterations — 2 left.** Wrap up your analysis and prepare to SUBMIT."
    );
  } else if (iteration >= maxIterations - 5) {
    parts.push(
      "\nNote: You have " + (maxIterations - iteration - 1) + " iterations remaining. Start synthesizing your findings."
    );
  }

  parts.push("");
  parts.push(
    "Provide your reasoning, then write EXACTLY ONE ```js code block, or one <JIT>...</JIT> context peek if you only need a tiny missing fact. Do NOT include multiple blocks."
  );

  return parts.join("\n");
}
