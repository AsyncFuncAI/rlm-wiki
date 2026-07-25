/**
 * Worker script — runs as a long-lived Bun subprocess.
 * Reads JSON messages from stdin, executes code, writes results to stdout.
 *
 * Communication uses newline-delimited JSON with __RLM_MSG_BOUNDARY__ delimiters.
 *
 * Phase 2 improvements:
 * - Sequential message processing (one execute at a time)
 * - Better error boundaries (never crash the read loop)
 * - Safe JSON stringify (handles circular refs, BigInt, etc.)
 * - Structured error messages with relevant stack frames
 */

import {
  encode,
  createMessageBuffer,
  MSG_OUTPUT,
  MSG_ERROR,
  MSG_SUBMIT,
  MSG_TOOL_CALL,
  MSG_READY,
} from "./protocol.ts";
import type { MessageBuffer } from "./protocol.ts";

async function send(msg: Record<string, unknown>): Promise<void> {
  try {
    await process.stdout.write(encode(msg));
  } catch (e) {
    // write failed — log to stderr and continue (don't kill the worker)
    try { process.stderr.write(`[worker] stdout write failed: ${String(e)}\n`); } catch { }
  }
}

// --- Safe JSON stringify ---

function safeStringify(obj: unknown, indent?: number): string {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (_key: string, value: unknown) => {
      if (typeof value === "bigint") return value.toString() + "n";
      if (typeof value === "function")
        return `[Function: ${(value as { name?: string }).name || "anonymous"}]`;
      if (value instanceof RegExp) return value.toString();
      if (value instanceof Error)
        return { name: value.name, message: value.message };
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    },
    indent
  );
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return safeStringify(a, 2);
  } catch {
    return String(a);
  }
}

// --- Console capture ---

const captured: string[] = [];

console.log = (...args: unknown[]) => {
  captured.push(args.map(formatArg).join(" "));
};
console.warn = (...args: unknown[]) => {
  captured.push("[warn] " + args.map(formatArg).join(" "));
};
console.error = (...args: unknown[]) => {
  captured.push("[error] " + args.map(formatArg).join(" "));
};

// --- SUBMIT function ---

let submitCalled = false;
let submitValue: Record<string, unknown> | null = null;

(globalThis as Record<string, unknown>).SUBMIT = (outputs: Record<string, unknown> = {}) => {
  // If the code explicitly printed output via console.log, prefer that over __hostAnswer.
  // __hostAnswer is set from the LLM's trailing-text heuristic, which can fire false-positives
  // (e.g. picking up a code example that appeared after the ```js block as the "answer").
  // Explicit console output is always more reliable than the heuristic.
  if (!outputs.answer && captured.length > 0) {
    outputs.answer = captured.join("\n");
    captured.length = 0;
  }

  // Fall back to __hostAnswer (set by <ANSWER> tag extraction) only if captured was empty.
  if (!outputs.answer && (globalThis as Record<string, unknown>).__hostAnswer) {
    outputs.answer = (globalThis as Record<string, unknown>).__hostAnswer;
    (globalThis as Record<string, unknown>).__hostAnswer = null;
    captured.length = 0;
  }

  if (outputs.answer && /\.(md|txt|json|html)$/i.test(outputs.answer as string)) {
    try {
      const fs = require("fs");
      const path = require("path");
      let filePath = outputs.answer as string;

      // Resolve workspace-namespaced paths (e.g. "mine:_answer.md" → "/abs/path/to/mine/_answer.md")
      const repoPathMap = (globalThis as Record<string, unknown>).__repoPathMap as Record<string, string> | undefined;
      if (repoPathMap && filePath.includes(":")) {
        const colonIdx = filePath.indexOf(":");
        const prefix = filePath.slice(0, colonIdx);
        const relPath = filePath.slice(colonIdx + 1);
        if (repoPathMap[prefix]) {
          filePath = path.resolve(repoPathMap[prefix], relPath);
        }
      }

      if (fs.existsSync(filePath)) {
        outputs.answer = fs.readFileSync(filePath, "utf-8");
        captured.length = 0;
      }
    } catch { }
  }

  if (!outputs.answer && captured.length > 0) {
    outputs.answer = captured.join("\n");
    captured.length = 0;
  }

  submitCalled = true;
  submitValue = outputs;
};

// --- Plan management ---

interface PlanTask {
  index: number;
  task: string;
  status: string;
  notes: string;
}

let currentPlan: PlanTask[] | null = null;

(globalThis as Record<string, unknown>).PLAN = (tasks: (string | { task: string })[]) => {
  currentPlan = tasks.map((t, i) => ({
    index: i,
    task: typeof t === "string" ? t : t.task,
    status: "pending",
    notes: "",
  }));
  const lines = ["## Implementation Plan", ""];
  for (const t of currentPlan) {
    lines.push(`- [ ] **${t.index}.** ${t.task}`);
  }
  captured.push(lines.join("\n"));
  return currentPlan;
};

(globalThis as Record<string, unknown>).updateTask = (index: number, status: string, notes?: string) => {
  if (!currentPlan) {
    captured.push("[plan] No plan created yet. Call PLAN([...]) first.");
    return;
  }
  if (index < 0 || index >= currentPlan.length) {
    captured.push(`[plan] Invalid task index: ${index}`);
    return;
  }
  currentPlan[index].status = status;
  if (notes) currentPlan[index].notes = notes;

  const icons: Record<string, string> = { pending: "⬜", "in-progress": "🔄", done: "✅", skipped: "⏭️" };
  const icon = icons[status] || "❓";
  captured.push(`${icon} Task ${index}: ${currentPlan[index].task} → ${status}${notes ? " — " + notes : ""}`);
  return currentPlan[index];
};

(globalThis as Record<string, unknown>).getPlan = () => {
  return currentPlan;
};

// --- Variable registry ---

(globalThis as Record<string, unknown>).vars = () => {
  const persisted = (globalThis as Record<string, unknown>).__rlm_persistedBindings as Set<string> | undefined;
  return [...(persisted || [])]
    .filter(k => Object.prototype.hasOwnProperty.call(globalThis, k))
    .map(k => {
      const v = (globalThis as Record<string, unknown>)[k];
      const type = Array.isArray(v) ? `Array(${(v as unknown[]).length})` : typeof v;
      return { name: k, type, preview: String(v).slice(0, 80) };
    });
};

// --- Tool call IPC ---

let nextCallId = 0;
let nextDestructId = 0;
const injectedFunctionNames = new Set<string>();
const persistedBindingNames = new Set<string>();
const pendingToolCalls = new Map<number, (value: unknown) => void>();
let currentExecutionMode: "execute" | "probe" | null = null;

(globalThis as Record<string, unknown>).__rlm_persistedBindings = persistedBindingNames;

(globalThis as Record<string, unknown>).__rlm_tool_call = (name: string, args: unknown[]) => {
  return new Promise(async (resolve) => {
    const callId = nextCallId++;
    pendingToolCalls.set(callId, resolve);
    const safeArgs = (args as unknown[]).map((a: unknown) => {
      if (a instanceof RegExp) return a.source;
      if (typeof a === "function") return String(a);
      if (typeof a === "undefined") return null;
      return a;
    });
    await send({ type: MSG_TOOL_CALL, name, args: safeArgs, callId, executionMode: currentExecutionMode });
  });
};

// --- Message processing ---

let executing = false;
const messageQueue: Record<string, unknown>[] = [];
const msgBuffer: MessageBuffer = createMessageBuffer();

function processBuffer(): void {
  const msgs = msgBuffer.drain();
  for (const msg of msgs) {
    if (msg.type === "tool_result") {
      const resolve = pendingToolCalls.get(msg.callId as number);
      if (resolve) {
        pendingToolCalls.delete(msg.callId as number);
        resolve(msg.result);
      }
    } else {
      messageQueue.push(msg);
    }
  }
  drainQueue();
}

async function drainQueue(): Promise<void> {
  if (executing) return;

  while (messageQueue.length > 0) {
    const msg = messageQueue.shift()!;
    await handleMessage(msg);
  }
}

/**
 * Rewrite const/let/var declarations to var + globalThis.
 * Handles multi-line destructuring by tracking bracket depth.
 *
 * Supported patterns:
 *   const [a, b] = expr            — inline array destructure
 *   const [                        — multi-line array destructure (opening [ alone or with names)
 *     a,
 *     b,
 *   ] = expr
 *   const {a, b} = expr            — inline object destructure
 *   const {                        — multi-line object destructure
 *     a,
 *     b,
 *   } = expr
 *   const x = expr                 — simple declaration
 */
function shouldPersistBinding(name: string): boolean {
  return !injectedFunctionNames.has(name);
}

function emitBinding(indent: string, name: string, rhsExpr: string): string {
  if (shouldPersistBinding(name)) {
    return `${indent}globalThis.__rlm_persistedBindings.add(${JSON.stringify(name)}); var ${name} = globalThis.${name} = ${rhsExpr}`;
  }
  return `${indent}var ${name} = ${rhsExpr}`;
}

/**
 * Preserve access to injected tool functions when generated code accidentally
 * declares a local with the same name, e.g. `const gitLog = await gitLog(5)`.
 */
function rewriteInjectedFunctionCalls(code: string): string {
  const names = [...injectedFunctionNames]
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return code;

  let output = "";
  let i = 0;

  const isIdent = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch);
  const copyQuoted = (quote: string) => {
    output += code[i++];
    while (i < code.length) {
      const ch = code[i];
      output += ch;
      i++;
      if (ch === "\\") {
        if (i < code.length) output += code[i++];
        continue;
      }
      if (ch === quote) break;
    }
  };

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '"' || ch === "'" || ch === "`") {
      copyQuoted(ch);
      continue;
    }

    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2);
      const sliceEnd = end === -1 ? code.length : end;
      output += code.slice(i, sliceEnd);
      i = sliceEnd;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const sliceEnd = end === -1 ? code.length : end + 2;
      output += code.slice(i, sliceEnd);
      i = sliceEnd;
      continue;
    }

    let matched = false;
    for (const name of names) {
      if (!code.startsWith(name, i)) continue;

      const before = code[i - 1];
      const after = code[i + name.length];
      if (isIdent(before) || isIdent(after) || before === ".") continue;

      let j = i + name.length;
      while (/\s/.test(code[j] || "")) j++;
      if (code[j] !== "(") continue;

      const previousToken = code.slice(Math.max(0, i - 24), i);
      if (/\bfunction\s*$/.test(previousToken)) continue;

      output += `globalThis.${name}`;
      i += name.length;
      matched = true;
      break;
    }

    if (!matched) {
      output += ch;
      i++;
    }
  }

  return output;
}

function splitTopLevelDelimited(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;

    if (ch === delimiter && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function rewriteDeclarations(code: string): string {
  const lines = code.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const semicolonParts = splitTopLevelDelimited(line, ";");
    if (semicolonParts.length > 1) {
      output.push(rewriteDeclarations(semicolonParts.join("\n")));
      i++;
      continue;
    }

    // ── Array destructuring ─────────────────────────────────────────

    // Case A: const [ ... ] = expr  (everything on one line)
    const arrInline = line.match(/^(\s*)(?:const|let|var)\s+\[([^\]]+)\]\s*=\s*(.*)$/);
    if (arrInline) {
      const [, indent, names, firstExprPart] = arrInline;
      const expr = collectFullExpression(firstExprPart, lines, i);
      i = expr.endLine + 1;
      emitArrayDestructure(indent, names, expr.text, output);
      continue;
    }

    // Case B: const [\n  a,\n  b,\n] = expr  (multi-line variable list)
    const arrOpen = line.match(/^(\s*)(?:const|let|var)\s+\[\s*(.*)$/);
    if (arrOpen) {
      const [, indent, afterBracket] = arrOpen;
      // Collect variable names until we find the closing `] =`
      const nameLines: string[] = [];
      if (afterBracket.trim()) nameLines.push(afterBracket);
      let j = i + 1;
      let foundClose = false;
      let rhsStart = "";
      while (j < lines.length) {
        const ln = lines[j];
        const closeMatch = ln.match(/^\s*\]\s*=\s*(.*)$/);
        if (closeMatch) {
          rhsStart = closeMatch[1];
          j++;
          foundClose = true;
          break;
        }
        nameLines.push(ln.trim());
        j++;
      }
      if (foundClose) {
        const names = nameLines.join(",");
        const expr = collectFullExpression(rhsStart, lines, j - 1);
        i = expr.endLine + 1;
        emitArrayDestructure(indent, names, expr.text, output);
        continue;
      }
      // Couldn't find close — fall through to simple rewrite
    }

    // ── Object destructuring ────────────────────────────────────────

    // Case A: const { ... } = expr  (everything on one line)
    const objInline = line.match(/^(\s*)(?:const|let|var)\s+\{([^}]+)\}\s*=\s*(.*)$/);
    if (objInline) {
      const [, indent, names, firstExprPart] = objInline;
      const expr = collectFullExpression(firstExprPart, lines, i);
      i = expr.endLine + 1;
      emitObjectDestructure(indent, names, expr.text, output);
      continue;
    }

    // Case B: const {\n  a,\n  b,\n} = expr  (multi-line variable list)
    const objOpen = line.match(/^(\s*)(?:const|let|var)\s+\{\s*(.*)$/);
    if (objOpen) {
      const [, indent, afterBrace] = objOpen;
      const nameLines: string[] = [];
      if (afterBrace.trim()) nameLines.push(afterBrace);
      let j = i + 1;
      let foundClose = false;
      let rhsStart = "";
      while (j < lines.length) {
        const ln = lines[j];
        const closeMatch = ln.match(/^\s*\}\s*=\s*(.*)$/);
        if (closeMatch) {
          rhsStart = closeMatch[1];
          j++;
          foundClose = true;
          break;
        }
        nameLines.push(ln.trim());
        j++;
      }
      if (foundClose) {
        const names = nameLines.join(",");
        const expr = collectFullExpression(rhsStart, lines, j - 1);
        i = expr.endLine + 1;
        emitObjectDestructure(indent, names, expr.text, output);
        continue;
      }
      // Couldn't find close — fall through to simple rewrite
    }

    // ── Simple variable declarations ────────────────────────────────
    // Case A: const x = multiLineExpression(...)
    const simpleMultiline = line.match(/^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
    if (simpleMultiline && countBracketDepth(simpleMultiline[3]) > 0) {
      const [, indent, name, rhsExpr] = simpleMultiline;
      const expr = collectFullExpression(rhsExpr, lines, i);
      i = expr.endLine + 1;
      output.push(emitBinding(indent, name, expr.text));
      continue;
    }

    // Case B: const x = 1, y = 2
    const simpleDecl = line.match(/^(\s*)(?:const|let|var)\s+(.+)$/);
    if (simpleDecl) {
      const [, indent, rawDecls] = simpleDecl;
      const decls = splitTopLevelDelimited(rawDecls.replace(/;\s*$/, ""), ",");
      const emitted: string[] = [];
      let allSimple = decls.length > 0;

      for (const decl of decls) {
        const match = decl.match(/^([A-Za-z_$][\w$]*)\s*(?:=\s*([\s\S]+))?$/);
        if (!match) {
          allSimple = false;
          break;
        }
        emitted.push(emitBinding(indent, match[1], match[2] || "undefined"));
      }

      if (allSimple) {
        output.push(...emitted);
      } else {
        output.push(line);
      }
    } else {
      output.push(line);
    }
    i++;
  }

  return output.join("\n");
}

/** Emit globalThis assignments for an array destructure. */
function emitArrayDestructure(indent: string, rawNames: string, rhsExpr: string, output: string[]): void {
  const id = nextDestructId++;
  const vars = rawNames.split(",").map((s: string) => s.trim()).filter(Boolean);
  output.push(`${indent}var __d_${id} = ${rhsExpr}`);
  for (let vi = 0; vi < vars.length; vi++) {
    let v = vars[vi];
    if (v === "_") {
      // Intentional ignore — skip globalThis assignment
      output.push(`${indent}var __skip_${id}_${vi} = __d_${id}[${vi}]`);
    } else if (v.startsWith("...")) {
      v = v.slice(3);
      output.push(emitBinding(indent, v, `__d_${id}.slice(${vi})`));
    } else {
      output.push(emitBinding(indent, v, `__d_${id}[${vi}]`));
    }
  }
}

/** Emit globalThis assignments for an object destructure. */
function emitObjectDestructure(indent: string, rawNames: string, rhsExpr: string, output: string[]): void {
  const id = nextDestructId++;
  const pairs = rawNames.split(",").map((s: string) => s.trim()).filter(Boolean);
  output.push(`${indent}var __d_${id} = ${rhsExpr}`);
  for (const pair of pairs) {
    if (pair.startsWith("...")) {
      const v = pair.slice(3);
      output.push(emitBinding(indent, v, `(({${pairs.filter((p: string) => !p.startsWith("...")).join(",")}, ...r})=>r)(__d_${id})`));
    } else if (pair.includes(":")) {
      const [key, alias] = pair.split(":").map((s: string) => s.trim());
      output.push(emitBinding(indent, alias, `__d_${id}.${key}`));
    } else {
      output.push(emitBinding(indent, pair, `__d_${id}.${pair}`));
    }
  }
}


/**
 * Count net bracket depth in a string, skipping characters inside
 * string literals (single-quoted, double-quoted, and backtick template literals).
 * Respects backslash escapes.
 */
function countBracketDepth(s: string): number {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip to end of string literal
      const quote = ch;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2; // skip escaped character
          continue;
        }
        if (s[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    i++;
  }
  return depth;
}

/**
 * Starting from `firstPart` (text after `=` on the declaration line),
 * collect lines until all brackets are balanced, handling multi-line expressions.
 */
function collectFullExpression(
  firstPart: string,
  lines: string[],
  startLine: number
): { text: string; endLine: number } {
  let text = firstPart;
  let depth = countBracketDepth(firstPart);

  let endLine = startLine;

  // If brackets aren't balanced, consume more lines
  while (depth > 0 && endLine + 1 < lines.length) {
    endLine++;
    const nextLine = lines[endLine];
    text += "\n" + nextLine;
    depth += countBracketDepth(nextLine);
  }

  return { text, endLine };
}

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  if (msg.type === "execute" || msg.type === "probe") {
    executing = true;
    const previousExecutionMode = currentExecutionMode;
    currentExecutionMode = msg.type === "probe" ? "probe" : "execute";
    captured.length = 0;
    submitCalled = false;
    submitValue = null;

    let rewritten = '';
    try {
      let code = msg.code as string;

      // Defensive: strip any <ANSWER>...</ANSWER> that leaked into the code
      // (common LLM mistake — they place <ANSWER> inside the ```js block)
      code = code.replace(/<ANSWER>[\s\S]*?<\/ANSWER>/gi, '').trim();
      if (!code) code = 'SUBMIT({ sources: [] });';

      const callsRewritten = rewriteInjectedFunctionCalls(code);
      rewritten = msg.type === "probe" ? callsRewritten : rewriteDeclarations(callsRewritten);

      const result = await eval(`(async () => {\n${rewritten}\n})()`);

      if (captured.length === 0 && result !== undefined) {
        captured.push(formatArg(result));
      }

      if (submitCalled) {
        await send({ type: MSG_SUBMIT, outputs: submitValue });
      } else {
        await send({ type: MSG_OUTPUT, output: captured.join("\n") });
      }
    } catch (err) {
      let errorMsg = `${(err as Error).name || "Error"}: ${(err as Error).message}`;
      if ((err as Error).stack) {
        const stackLines = (err as Error).stack!.split("\n");
        const relevant = stackLines.find(
          (l: string) => l.includes("eval") || l.includes("<anonymous>")
        );
        if (relevant) errorMsg += "\n  at " + relevant.trim();
      }
      // Enhanced error for actual eval/template-literal SyntaxErrors. Bun's
      // JSON.parse failures are also SyntaxError instances, so do not suggest
      // backticks when the code simply parsed invalid JSON.
      const syntaxMessage = (err as Error).message || "";
      const isJsonParseSyntaxError = /JSON Parse error/i.test(syntaxMessage);
      const looksLikeTemplateEvalSyntax =
        /unterminated|unexpected eof|unexpected end of input|unexpected token|invalid or unexpected token|missing \)|unexpected identifier/i.test(syntaxMessage);
      if (err instanceof SyntaxError && rewritten.includes('`') && !isJsonParseSyntaxError && looksLikeTemplateEvalSyntax) {
        errorMsg += "\n\n⚠ This is likely caused by backticks (```) inside template literals. " +
          "Fix: use the <ANSWER> tag for markdown output (write it OUTSIDE the code block), " +
          "or use bash() with an array of strings instead of template literals.\n" +
          "IMPORTANT: The <ANSWER> tag goes OUTSIDE and BEFORE the ```js block, like this:\n" +
          "<ANSWER>\nYour markdown here\n</ANSWER>\n```js\nSUBMIT({ sources: [] });\n```";
      }
      await send({ type: MSG_ERROR, error: errorMsg });
    } finally {
      currentExecutionMode = previousExecutionMode;
      executing = false;
    }
  } else if (msg.type === "inject") {
    try {
      if (msg.valueType === "function") {
        (globalThis as Record<string, unknown>)[msg.name as string] = eval(`(${msg.source})`);
        injectedFunctionNames.add(msg.name as string);
      } else {
        (globalThis as Record<string, unknown>)[msg.name as string] = JSON.parse(msg.value as string);
      }
      await send({ type: MSG_OUTPUT, output: `Injected: ${msg.name}` });
    } catch (err) {
      await send({
        type: MSG_ERROR,
        error: `Inject failed for ${msg.name}: ${(err as Error).message}`,
      });
    }
  }
}

// --- Stdin read loop ---

const decoder = new TextDecoder();

await send({ type: MSG_READY });

const reader = Bun.stdin.stream().getReader();

async function readLoop(): Promise<void> {
  while (true) {
    try {
      const { done, value } = await reader.read();
      if (done) break;
      msgBuffer.push(decoder.decode(value, { stream: true }));
      processBuffer();
    } catch (err) {
      await send({ type: MSG_ERROR, error: `Read error: ${(err as Error).message}` });
    }
  }
}

readLoop().catch(async (err) => {
  await send({ type: MSG_ERROR, error: `Read loop fatal: ${(err as Error).message}` });
});
