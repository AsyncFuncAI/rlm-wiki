import type { RLMEvent, RLMQueryResult } from "../rlm.ts";
import { calculateCost, formatCost } from "../llm/pricing.ts";
import { highlight } from "cli-highlight";
import type { Theme } from "cli-highlight";

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  success: "\x1b[38;5;65m",
  warn: "\x1b[38;5;172m",
  error: "\x1b[38;5;160m",
  accent: "\x1b[38;5;176m",
  muted: "\x1b[38;5;240m",
  body: "\x1b[38;5;250m",
  dim: "\x1b[38;5;235m",
};

export const GRAYS = [
  "\x1b[38;5;248m",
  "\x1b[38;5;244m",
  "\x1b[38;5;240m",
  "\x1b[38;5;236m",
];

const ansi = (code: number) => (s: string) => `\x1b[38;5;${code}m${s}\x1b[0m`;

const GEIST_THEME: Theme = {
  keyword: ansi(176),
  built_in: ansi(79),
  type: ansi(114),
  literal: ansi(173),
  number: ansi(173),
  regexp: ansi(173),
  string: ansi(114),
  subst: ansi(250),
  symbol: ansi(79),
  class: ansi(250),
  function: ansi(79),
  title: ansi(250),
  params: ansi(173),
  comment: ansi(240),
  doctag: ansi(240),
  meta: ansi(176),
  attr: ansi(250),
  variable: ansi(250),
  bullet: ansi(176),
  code: (s: string) => `\x1b[48;5;235m\x1b[38;5;248m${s}\x1b[0m`,
  link: ansi(79),
  addition: ansi(114),
  deletion: ansi(196),
  default: ansi(250),
};

function highlightJS(code: string, jsonOutput: boolean): string {
  if (!process.stderr.isTTY || jsonOutput) return code;
  try {
    return highlight(code, { language: "javascript", ignoreIllegals: true, theme: GEIST_THEME });
  } catch {
    return code;
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

const LLM_LOADING_MESSAGES = [
  "cooking up answers…",
  "hardcore thinking…",
  "consulting the hive mind…",
  "crunching neurons…",
  "summoning intelligence…",
  "brewing insights…",
  "juggling tokens…",
  "deep in thought…",
  "assembling brain cells…",
  "connecting synapses…",
  "warming up the thinking cap…",
  "spinning up brain cores…",
  "digesting the codebase…",
  "doing the thinking thing…",
  "asking the oracle…",
];

const AGENT_LOADING_MESSAGES = [
  "agent is on the case…",
  "delegating to the experts…",
  "AI agent doing its thing…",
  "external brain activated…",
  "agent is cooking…",
  "subprocess intelligence engaged…",
  "calling in reinforcements…",
  "agent exploring the codebase…",
  "collaborative AI in progress…",
  "agent working autonomously…",
  "spawning intelligence…",
  "the agent has entered the chat…",
];

let llmMessageRotateInterval: ReturnType<typeof setInterval> | null = null;

function startSpinner(label: string, jsonOutput: boolean, rotateMessages?: string[]) {
  if (!process.stderr.isTTY || jsonOutput) return;
  stopSpinner();
  spinnerFrame = 0;
  let currentLabel = label;
  let msgIdx = 0;

  spinnerInterval = setInterval(() => {
    process.stderr.write(`\r\x1b[2K  ${C.accent}${SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length]}${C.reset} ${C.muted}${currentLabel}${C.reset}`);
  }, 80);

  if (rotateMessages && rotateMessages.length > 0) {
    msgIdx = Math.floor(Math.random() * rotateMessages.length);
    currentLabel = rotateMessages[msgIdx];
    llmMessageRotateInterval = setInterval(() => {
      msgIdx = (msgIdx + 1) % rotateMessages.length;
      currentLabel = rotateMessages[msgIdx];
    }, 3000);
  }
}

function stopSpinner(finalMessage?: string) {
  if (llmMessageRotateInterval) {
    clearInterval(llmMessageRotateInterval);
    llmMessageRotateInterval = null;
  }
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    if (finalMessage) {
      process.stderr.write(`\r\x1b[2K  ${C.success}✓${C.reset} ${finalMessage}\n`);
    } else {
      process.stderr.write("\r\x1b[2K");
    }
  }
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function progressBar(current: number, total: number, width: number = 20): string {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

function truncateOutput(output: string, maxLines: number): string {
  if (!output) return "(no output)";
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;
  const head = lines.slice(0, maxLines - 1).join("\n");
  return head + `\n${C.muted}... ${lines.length - maxLines + 1} more lines (${output.length} chars total)${C.reset}`;
}

function renderMarkdownANSI(md: string): string {
  if (typeof (Bun as any).markdown?.render !== "function") {
    return md;
  }

  const headingColor = (level: number): string => {
    if (level === 1) return "\x1b[1;38;5;176m";
    if (level === 2) return "\x1b[1;38;5;114m";
    return "\x1b[1;38;5;250m";
  };

  return (Bun as any).markdown.render(
    md,
    {
      heading: (children: string, meta: { level: number }) => {
        const col = headingColor(meta.level);
        const text = children.replace(/\x1b\[[0-9;]*m/g, "");
        if (meta.level <= 2) {
          return `\n\n${col}${text}\x1b[0m\n`;
        }
        const indent = "  ".repeat(meta.level - 2);
        return `\n${indent}${col}› ${text}\x1b[0m\n`;
      },

      paragraph: (children: string) => `\n${children}\x1b[0m\n`,

      blockquote: (children: string) => {
        const lines = children.trimEnd().split("\n");
        const indented = lines.map(l => `  \x1b[38;5;240m▌\x1b[0m \x1b[3;38;5;244m${l}\x1b[0m`).join("\n");
        return `\n${indented}\n`;
      },

      code: (children: string, meta: { language?: string }) => {
        const lang = meta?.language || "";
        const badge = lang ? ` \x1b[38;5;240m[${lang}]\x1b[0m` : "";
        const lines = children.trimEnd().split("\n");
        const body = lines
          .map(l => `  \x1b[38;5;240m│\x1b[0m \x1b[38;5;248m${l}\x1b[0m`)
          .join("\n");
        return `\n\x1b[38;5;240m  ╭──────────────────${badge}\x1b[0m\n${body}\n\x1b[38;5;240m  ╰──────────────────\x1b[0m\n`;
      },

      list: (children: string) => `\n${children}`,

      listItem: (children: string, meta: { index: number; depth: number; ordered: boolean; start?: number; checked?: boolean }) => {
        const indent = "  ".repeat(meta.depth);
        let marker: string;
        if (meta.checked !== undefined) {
          marker = meta.checked ? `\x1b[38;5;65m✓\x1b[0m` : `\x1b[38;5;240m○\x1b[0m`;
        } else if (meta.ordered) {
          const n = (meta.start ?? 1) + meta.index;
          marker = `\x1b[38;5;176m${n}.\x1b[0m`;
        } else {
          marker = `\x1b[38;5;176m•\x1b[0m`;
        }
        return `${indent} ${marker} ${children.trimEnd()}\n`;
      },

      hr: () => `\n\x1b[38;5;235m${"─".repeat(56)}\x1b[0m\n`,

      th: (children: string) => `\x00TH\x00${children}\x00COL\x00`,
      td: (children: string) => `\x00TD\x00${children}\x00COL\x00`,
      tr: (children: string) => `${children}\x00ROW\x00`,
      thead: (children: string) => `${children}\x00HEAD\x00`,
      tbody: (children: string) => children,

      table: (raw: string) => {
        const vlen = (s: string) =>
          s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x00(TH|TD|COL|ROW|HEAD)\x00/g, "").length;
        const padV = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vlen(s)));

        const [headRaw = "", bodyRaw = ""] = raw.split("\x00HEAD\x00");

        const parseSection = (s: string, isHeader: boolean) =>
          s.split("\x00ROW\x00")
            .filter(r => r.includes("\x00COL\x00"))
            .map(row =>
              row.split("\x00COL\x00")
                .slice(0, -1)
                .map(cell => ({
                  isHeader: isHeader || cell.startsWith("\x00TH\x00"),
                  content: cell.replace(/^\x00(TH|TD)\x00/, "").trim(),
                }))
            );

        const headerRows = parseSection(headRaw, true);
        const bodyRows = parseSection(bodyRaw, false);
        const allRows = [...headerRows, ...bodyRows];
        if (allRows.length === 0) return `\n${raw}\n`;

        const numCols = Math.max(...allRows.map(r => r.length));
        const colWidths = Array.from({ length: numCols }, (_, ci) =>
          Math.max(4, ...allRows.map(row => vlen(row[ci]?.content ?? "")))
        );

        const renderRow = (cells: Array<{ isHeader: boolean; content: string }>) => {
          const parts = cells.map((cell, i) => {
            const padded = padV(cell.content, colWidths[i]);
            return cell.isHeader ? `\x1b[1;38;5;176m${padded}\x1b[0m` : padded;
          });
          return `  ${parts.join(`  \x1b[38;5;240m│\x1b[0m  `)}`;
        };

        const sepLine = `  \x1b[38;5;238m${colWidths.map(w => "─".repeat(w)).join("──┼──")}\x1b[0m`;

        const lines: string[] = ["\n"];
        for (const row of headerRows) lines.push(renderRow(row));
        if (headerRows.length > 0) lines.push(sepLine);
        for (const row of bodyRows) lines.push(renderRow(row));
        lines.push("");
        return lines.join("\n");
      },

      strong: (children: string) => `\x1b[1m${children}\x1b[22m`,
      emphasis: (children: string) => `\x1b[3m${children}\x1b[23m`,
      codespan: (children: string) => `\x1b[38;5;114m\`${children}\`\x1b[0m`,
      strikethrough: (children: string) => `\x1b[9m${children}\x1b[29m`,

      link: (children: string, meta: { href: string; title?: string }) =>
        `\x1b[38;5;79m${children}\x1b[0m \x1b[38;5;240m(${meta.href})\x1b[0m`,

      image: (children: string, meta: { src: string; title?: string }) =>
        `\x1b[38;5;172m[img: ${children || meta.src}]\x1b[0m`,
    },
    { tables: true, strikethrough: true, tasklists: true }
  );
}

export interface DisplayConfig {
  jsonOutput: boolean;
  verbose: boolean;
  model: string | null;
  provider: string;
  source: string | null;
}

export function createDisplayAnswer(rlm: { _session?: { id: string } | null }, config: DisplayConfig) {
  return function displayAnswer(result: RLMQueryResult): void {
    if (config.jsonOutput) {
      const { _messages, _history, ...clean } = result;
      console.log(JSON.stringify(clean, null, 2));
    } else {
      console.log(`\n${C.dim}╭${"─".repeat(58)}╮${C.reset}`);
      console.log(`${C.dim}│${C.reset}${C.accent}  ✦ Answer${C.reset}${" ".repeat(49)}${C.dim}│${C.reset}`);
      console.log(`${C.dim}╰${"─".repeat(58)}╯${C.reset}`);

      if (process.stdout.isTTY && result.answer) {
        const rendered = renderMarkdownANSI(result.answer);
        process.stdout.write(rendered);
        if (!rendered.endsWith("\n")) process.stdout.write("\n");
      } else {
        console.log(result.answer);
      }
      console.log(`\n${C.muted}${"─".repeat(60)}${C.reset}`);

      if (result.sources.length > 0) {
        console.log(`${C.muted}sources: ${C.body}${result.sources.join(", ")}${C.reset}`);
      }

      const calls = result.tokenUsage?.calls || result.trajectory.length || 1;
      const parts: string[] = [`${calls} call${calls !== 1 ? "s" : ""}`];
      if (result.tokenUsage) {
        const u = result.tokenUsage as any;
        const cost = calculateCost(u, config.model || 'unknown', config.provider);
        u.cost = cost;
        parts.push(`${u.totalTokens.toLocaleString()} tokens`);
        parts.push(`~${formatCost(cost.totalCost)}`);
      }
      console.error(`\n${C.muted}${parts.join(" · ")}${C.reset}`);

      const sessionId = (rlm as any)._session?.id;
      if (sessionId) {
        console.error(`${C.muted}session: ${sessionId}${C.reset}`);
        console.error(`${C.muted}resume:  bun bin/rlm.ts ${config.source || "."} "your follow-up" --resume-session ${sessionId}${C.reset}`);
      }
    }
  };
}

export function createOnEvent(config: DisplayConfig): (event: RLMEvent) => void {
  let streamingPhase: "reasoning" | "code" = "reasoning";
  let firstCodeBlockDone = false;
  let codeBlockDepth = 0;
  let nestedFenceCount = 0;
  let reasoningStarted = false;
  let reasoningSuppressed = false;
  let codeSuppressed = false;
  let codeStarted = false;
  let codeLineBuffer = "";
  let codeLineCount = 0;
  const CODE_LINE_LIMIT = 15;
  let codeTruncationShown = false;
  let pendingBackticks = "";
  let sessionStartTime: number | null = null;

  function processCodeDelta(delta: string) {
    if (codeSuppressed) return;
    const chars = codeLineBuffer + delta;
    const lines = chars.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!codeStarted && line.match(/^[a-z]*$/i) && codeLineCount === 0) {
        codeStarted = true;
        codeLineCount = 0;
        continue;
      }
      codeStarted = true;
      if (line.includes("SUBMIT(")) {
        codeLineCount++;
        if (config.verbose || codeLineCount <= CODE_LINE_LIMIT) {
          process.stderr.write(`  ${C.muted}│${C.reset} ${highlightJS(line, config.jsonOutput)}\n`);
        }
        continue;
      }
      codeLineCount++;
      if (!config.verbose && codeLineCount > CODE_LINE_LIMIT) {
        if (!codeTruncationShown) {
          codeTruncationShown = true;
          process.stderr.write(`  ${C.muted}│ … truncated (--verbose to see all)${C.reset}\n`);
        }
        continue;
      }
      process.stderr.write(`  ${C.muted}│${C.reset} ${highlightJS(line, config.jsonOutput)}\n`);
    }
    codeLineBuffer = lines[lines.length - 1];
  }

  function flushCodeBlock() {
    if (codeSuppressed) {
      codeLineBuffer = "";
      codeTruncationShown = false;
      return;
    }
    if (codeStarted && codeLineBuffer.trim()) {
      if (config.verbose || codeLineCount < CODE_LINE_LIMIT) {
        process.stderr.write(`  ${C.muted}│${C.reset} ${highlightJS(codeLineBuffer, config.jsonOutput)}\n`);
      }
      codeLineCount++;
    }
    codeLineBuffer = "";
    if (!config.verbose && codeLineCount > CODE_LINE_LIMIT && !codeTruncationShown) {
      process.stderr.write(`  ${C.muted}│ … +${codeLineCount - CODE_LINE_LIMIT} more lines (--verbose to see all)${C.reset}\n`);
    }
    codeTruncationShown = false;
  }

  return function onEvent(event: RLMEvent): void {
    switch (event.type) {
      case "status":
        if (!config.jsonOutput && !["tool", "loop", "submit"].includes(event.phase)) {
          if (["load", "index", "sandbox"].includes(event.phase)) {
            if (event.phase === "sandbox" && !sessionStartTime) {
              sessionStartTime = Date.now();
            }
            startSpinner(event.message, config.jsonOutput);
          } else {
            stopSpinner();
            console.error(`  ${C.muted}${event.message}${C.reset}`);
          }
        }
        break;

      case "step": {
        stopSpinner();
        if (!config.jsonOutput) {
          const elapsed = sessionStartTime ? formatElapsed(Date.now() - sessionStartTime) : "";
          const stepLabel = `Step ${event.step}/${event.maxSteps} · ${event.resultType}`;
          const pct = Math.round((event.step / event.maxSteps) * 100);
          const bar = progressBar(event.step, event.maxSteps);
          const headerContent = ` ${stepLabel} `;
          const timeStr = elapsed ? ` ${elapsed} ` : "";
          const fillLen = Math.max(0, 50 - headerContent.length - timeStr.length);
          console.error(`\n${C.dim}╭─${C.reset}${C.accent}${headerContent}${C.reset}${C.dim}${"─".repeat(fillLen)}${timeStr}─╮${C.reset}`);

          console.error(`  ${C.muted}${bar}  ${pct}%${C.reset}`);
          console.error("");

          if (event.tokenUsage) {
            const cost = calculateCost(event.tokenUsage, config.model || 'unknown', config.provider);
            const tokStr = event.tokenUsage.totalTokens > 1000
              ? `${(event.tokenUsage.totalTokens / 1000).toFixed(1)}k`
              : `${event.tokenUsage.totalTokens}`;
            const elapsedStr = sessionStartTime ? formatElapsed(Date.now() - sessionStartTime) : "";
            console.error(`  ${C.muted}${tokStr} tokens · ~${formatCost(cost.totalCost)}${elapsedStr ? ` · ${elapsedStr}` : ""}${C.reset}`);
          }

          if (event.output && event.resultType !== "submit") {
            const isError = event.output.startsWith("[Error]");
            const outputDisplay = config.verbose ? truncateOutput(event.output, 25) : truncateOutput(event.output, 8);
            const prefix = isError ? `${C.error}✗ output${C.reset}` : `${C.muted}→ output${C.reset}`;
            console.error(`
  ${prefix}`);
            for (const line of outputDisplay.split("\n")) {
              console.error(`  ${C.muted}│${C.reset} ${isError ? `${C.error}${line}${C.reset}` : line}`);
            }
            console.error("");
            console.error(`  ${C.dim}${"─".repeat(48)}${C.reset}`);
          }
        }
        break;
      }

      case "stream-delta":
        if (config.jsonOutput) break;
        stopSpinner();

        {
          let delta = event.delta || "";
          if (pendingBackticks) {
            delta = pendingBackticks + delta;
            pendingBackticks = "";
          }
          const trailingMatch = delta.match(/`{1,2}$/);
          if (trailingMatch && !delta.includes("```")) {
            pendingBackticks = trailingMatch[0];
            delta = delta.slice(0, -pendingBackticks.length);
            if (!delta) break;
          }

          if (reasoningSuppressed || firstCodeBlockDone) {
            break;
          }

          if (streamingPhase === "reasoning" && delta.includes("<ANSWER")) {
            if (reasoningStarted) {
              process.stderr.write(`${C.reset}\n`);
              reasoningStarted = false;
            }
            reasoningSuppressed = true;
            break;
          }

          // Process delta iteratively, handling ALL ``` fences.
          // In code phase, track nested fence pairs (from heredocs,
          // template literals, etc.) so embedded ``` don't falsely
          // close the outer code block and suppress display.
          let remaining = delta;
          while (remaining) {
            const fencePos = remaining.indexOf("```");
            if (fencePos === -1) {
              // No fence — emit remaining in current phase
              if (streamingPhase === "reasoning") {
                if (!reasoningStarted) {
                  process.stderr.write(`\n  ${C.muted}░ `);
                  reasoningStarted = true;
                }
                process.stderr.write(remaining.replace(/\n/g, " "));
              } else if (!codeSuppressed) {
                processCodeDelta(remaining);
              }
              break;
            }

            const preFence = remaining.slice(0, fencePos);
            const postFence = remaining.slice(fencePos + 3);

            if (streamingPhase === "reasoning") {
              // Opening fence — always real in reasoning phase
              if (preFence) {
                if (!reasoningStarted) {
                  process.stderr.write(`\n  ${C.muted}░ `);
                  reasoningStarted = true;
                }
                process.stderr.write(preFence.replace(/\n/g, " "));
              }
              if (reasoningStarted) {
                process.stderr.write(`${C.reset}\n`);
                reasoningStarted = false;
              }
              streamingPhase = "code";
              codeBlockDepth++;
              nestedFenceCount = 0;
              codeStarted = false;
              codeLineBuffer = "";
              codeLineCount = 0;
              remaining = postFence;
              continue;
            }

            // — Code phase: real closing fence or embedded? —

            // 1) Not at line boundary → embedded (inside a string literal)
            const atLineStart =
              (fencePos === 0 && codeLineBuffer.trim() === "") ||
              (fencePos > 0 && remaining[fencePos - 1] === "\n");

            if (!atLineStart) {
              // Mid-line ``` — treat as regular code content
              processCodeDelta(remaining.slice(0, fencePos + 3));
              remaining = postFence;
              continue;
            }

            // 2) At line start with a language tag → embedded opening fence
            const tagMatch = postFence.match(/^([a-zA-Z][\w]*)/);
            if (tagMatch) {
              nestedFenceCount++;
              processCodeDelta(remaining.slice(0, fencePos + 3 + tagMatch[0].length));
              remaining = postFence.slice(tagMatch[0].length);
              continue;
            }

            // 3) At line start, no tag — closing fence
            if (nestedFenceCount > 0) {
              // Closes an embedded pair, not the outer block
              nestedFenceCount--;
              processCodeDelta(remaining.slice(0, fencePos + 3));
              remaining = postFence;
              continue;
            }

            // 4) Real closing fence for the outer code block
            if (preFence) processCodeDelta(preFence);
            flushCodeBlock();
            streamingPhase = "reasoning";
            if (codeBlockDepth === 1) firstCodeBlockDone = true;
            codeStarted = false;
            remaining = postFence;
            if (firstCodeBlockDone) break;
          }
        }
        break;

      case "stream-done":
        if (reasoningStarted) {
          process.stderr.write(`${C.reset}\n`);
        }
        streamingPhase = "reasoning";
        firstCodeBlockDone = false;
        codeBlockDepth = 0;
        nestedFenceCount = 0;
        reasoningStarted = false;
        reasoningSuppressed = false;
        codeSuppressed = false;
        pendingBackticks = "";
        codeStarted = false;
        codeLineBuffer = "";
        codeLineCount = 0;
        codeTruncationShown = false;
        break;

      case "tool-start":
        if (!config.jsonOutput) {
          if (event.tool === "llmQuery" || event.tool === "llmQueryBatched") {
            startSpinner("thinking…", config.jsonOutput, LLM_LOADING_MESSAGES);
          } else if (event.tool === "run_agent") {
            startSpinner("agent working…", config.jsonOutput, AGENT_LOADING_MESSAGES);
          }
        }
        break;

      case "tool-done": {
        if (event.tool === "llmQuery" || event.tool === "llmQueryBatched" || event.tool === "run_agent") {
          stopSpinner();
        }
        break;
      }

      case "tool-error": {
        if (event.tool === "llmQuery" || event.tool === "llmQueryBatched" || event.tool === "run_agent") {
          stopSpinner();
        }
        break;
      }
    }
  };
}
