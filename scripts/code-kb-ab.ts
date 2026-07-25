#!/usr/bin/env bun
// scripts/code-kb-ab.ts — manual A/B harness for the sharenow code-kb evidence
// slices (plan 2026-07-06-002, U4/R6).
//
// Runs the SAME small wiki generation plus one canned ask twice — kb evidence
// ON, then OFF (RLM_WIKI_CODE_KB=0) — each against a fresh scratch
// RLM_WIKI_ROOT, and prints a per-phase comparison table: wall-clock,
// iteration proxies (tool calls / RLM steps), and retry signals.
//
// ⚠️ MANUAL DEV TOOL — REAL LLM COST. Every invocation runs a structure agent,
// N page agents, and one ask through your local CLI agent, twice in both mode.
// It is deliberately NOT part of `bun test`. Run it yourself:
//
//   bun scripts/code-kb-ab.ts [--repo URL] [--pages N] [--mode both|on|off]
//
// Caveats (KTD-6): one run per config — a fail-fast signal, not statistics —
// and the on-run goes first, so warm clone/kb caches can bias the off-run
// slightly fast. Page-agent in-run retries are not distinct events; retries
// surface here as page errors, recovery rounds, and extra structure starts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askRepo } from "../src/chat.ts";
import { parseFlags } from "../src/cli.ts";
import { generateWiki, type GenerationEvent } from "../src/generator.ts";
import type { RLMEvent } from "../src/jcode-runtime.ts";
import { localCliLabel, normalizeLocalCliConfig, type LocalCliConfig } from "../src/local-cli-events.ts";
import { getLocalCliAgents } from "../src/local-cli-sidecar-client.ts";
import { computeCodeKbAskEntry } from "../src/server.ts";
import { WikiStore } from "../src/storage.ts";
import { parseGithubUrl } from "../src/types.ts";

const DEFAULT_REPO = "https://github.com/Zackriya-Solutions/meetily";
const ASK_QUESTION = "how do I self deploy this?";

type AbMode = "on" | "off";

interface AgentCounters {
  toolCalls: number;
  steps: number;
}

interface RunMetrics {
  mode: AbMode;
  structureMs?: number;
  structureStarts: number;
  structureCounters: AgentCounters;
  pageMs: Map<string, number>;
  pageCounters: Map<string, AgentCounters>;
  pageErrors: number;
  recoveryRounds: number;
  generateMs?: number;
  generateError?: string;
  askMs?: number;
  askError?: string;
  askEvidenceChars?: number;
}

function fmtMs(ms?: number): string {
  return ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function fmtDelta(on?: number, off?: number): string {
  if (on === undefined || off === undefined) return "-";
  const delta = on - off;
  return `${delta < 0 ? "-" : "+"}${(Math.abs(delta) / 1000).toFixed(1)}s`;
}

function fmtCounters(counters: AgentCounters): string {
  return counters.steps > 0 ? `${counters.toolCalls} tools, ${counters.steps} steps` : `${counters.toolCalls} tools`;
}

// Local-cli agents surface tool_use events (LocalCliEvent cast to RLMEvent in
// local-cli-runtime.ts); RLM agents surface tool-start and step events.
function bumpCounters(counters: AgentCounters, agentEvent: RLMEvent): void {
  const type = (agentEvent as { type?: string }).type;
  if (type === "tool_use" || type === "tool-start") counters.toolCalls += 1;
  if (agentEvent.type === "step") counters.steps = Math.max(counters.steps, agentEvent.step);
}

function captureEvents(metrics: RunMetrics): (ev: GenerationEvent) => void {
  let structureStartedAt = 0;
  const pageStartedAt = new Map<string, number>();
  return (ev) => {
    const now = Date.now();
    switch (ev.type) {
      case "phase":
        if (ev.message.startsWith("Auto-recovering")) metrics.recoveryRounds += 1;
        console.log(`  [${ev.phase}] ${ev.message}`);
        break;
      case "structure-start":
        metrics.structureStarts += 1;
        structureStartedAt = now;
        break;
      case "structure-agent":
        bumpCounters(metrics.structureCounters, ev.event);
        break;
      case "structure-done":
        metrics.structureMs = now - structureStartedAt;
        console.log(`  structure done in ${fmtMs(metrics.structureMs)}: ${ev.structure.pages.length} pages`);
        break;
      case "page-start":
        pageStartedAt.set(ev.pageId, now);
        if (!metrics.pageCounters.has(ev.pageId)) metrics.pageCounters.set(ev.pageId, { toolCalls: 0, steps: 0 });
        break;
      case "page-agent":
        bumpCounters(metrics.pageCounters.get(ev.pageId) ?? { toolCalls: 0, steps: 0 }, ev.event);
        break;
      case "page-done": {
        const startedAt = pageStartedAt.get(ev.pageId);
        if (startedAt) metrics.pageMs.set(ev.pageId, now - startedAt);
        console.log(`  page ${ev.pageId} done in ${fmtMs(metrics.pageMs.get(ev.pageId))}`);
        break;
      }
      case "page-error":
        metrics.pageErrors += 1;
        console.log(`  page ${ev.pageId} error: ${ev.displayError || ev.error}`);
        break;
    }
  };
}

async function runMode(mode: AbMode, repoInput: string, pages: number, localCli: LocalCliConfig): Promise<RunMetrics> {
  const metrics: RunMetrics = {
    mode,
    structureStarts: 0,
    structureCounters: { toolCalls: 0, steps: 0 },
    pageMs: new Map(),
    pageCounters: new Map(),
    pageErrors: 0,
    recoveryRounds: 0,
  };
  // codeKbEnabled() reads the flag at call time, so a runtime flip is enough.
  process.env.RLM_WIKI_CODE_KB = mode === "off" ? "0" : "1";
  const root = mkdtempSync(join(tmpdir(), `code-kb-ab-${mode}-`));
  process.env.RLM_WIKI_ROOT = root;
  const ref = parseGithubUrl(repoInput);

  console.log(`\n=== kb-${mode} · generate ${ref.owner}/${ref.repo} (${pages} pages) · scratch ${root}`);
  const generateStartedAt = Date.now();
  try {
    // Mirrors cmdGenerate in src/cli.ts: local-cli runtime, fixed small page
    // count (<=12 resolves to fast depth), CLI default style, scratch store.
    await generateWiki(ref, {
      runtime: "local-cli",
      localCli,
      pageCount: pages,
      pageCountMode: "fixed",
      style: "first-30",
      store: new WikiStore(join(root, "wiki")),
      onEvent: captureEvents(metrics),
    });
  } catch (err) {
    metrics.generateError = err instanceof Error ? err.message : String(err);
    console.log(`  generation failed: ${metrics.generateError}`);
  }
  metrics.generateMs = Date.now() - generateStartedAt;

  console.log(`=== kb-${mode} · ask: "${ASK_QUESTION}"`);
  const askStartedAt = Date.now();
  try {
    // askRepo has no kb path of its own; the server injects the kb entry via
    // wikiContexts (computeCodeKbAskEntry), so the harness mirrors that seam.
    // With the flag off the entry resolves null and the prompt matches today's.
    // Fresh empty store so a generated wiki never skews the ask timing.
    const entry = await computeCodeKbAskEntry(ref, ASK_QUESTION);
    metrics.askEvidenceChars = entry ? entry.context.length : 0;
    await askRepo(ref, ASK_QUESTION, {
      runtime: "local-cli",
      localCli,
      askMode: "fast",
      wikiContexts: entry ? [entry] : [],
      store: new WikiStore(join(root, "ask")),
    });
  } catch (err) {
    metrics.askError = err instanceof Error ? err.message : String(err);
    console.log(`  ask failed: ${metrics.askError}`);
  }
  metrics.askMs = Date.now() - askStartedAt;
  return metrics;
}

function sum(values: Iterable<number>): number {
  return [...values].reduce((total, value) => total + value, 0);
}

function totalCounters(metrics: RunMetrics): AgentCounters {
  const totals = { toolCalls: 0, steps: 0 };
  for (const counters of metrics.pageCounters.values()) {
    totals.toolCalls += counters.toolCalls;
    totals.steps += counters.steps;
  }
  return totals;
}

function printComparison(on?: RunMetrics, off?: RunMetrics): void {
  const rows: string[][] = [["phase / metric", "kb-on", "kb-off", "delta (on-off)"]];
  const timeRow = (label: string, pick: (m: RunMetrics) => number | undefined): void => {
    const onValue = on ? pick(on) : undefined;
    const offValue = off ? pick(off) : undefined;
    rows.push([label, fmtMs(onValue), fmtMs(offValue), fmtDelta(onValue, offValue)]);
  };
  const textRow = (label: string, pick: (m: RunMetrics) => string): void => {
    rows.push([label, on ? pick(on) : "-", off ? pick(off) : "-", ""]);
  };
  const pageMean = (m: RunMetrics): number | undefined =>
    m.pageMs.size ? sum(m.pageMs.values()) / m.pageMs.size : undefined;
  timeRow("structure", (m) => m.structureMs);
  timeRow("pages total", (m) => (m.pageMs.size ? sum(m.pageMs.values()) : undefined));
  timeRow("page mean", pageMean);
  timeRow("generate wall-clock", (m) => m.generateMs);
  timeRow("ask wall-clock", (m) => m.askMs);
  timeRow("total wall-clock", (m) => (m.generateMs !== undefined || m.askMs !== undefined ? (m.generateMs ?? 0) + (m.askMs ?? 0) : undefined));
  textRow("structure iterations", (m) => fmtCounters(m.structureCounters));
  textRow("page iterations total", (m) => fmtCounters(totalCounters(m)));
  textRow("pages completed", (m) => String(m.pageMs.size));
  textRow("structure retries", (m) => String(Math.max(0, m.structureStarts - 1)));
  textRow("page errors", (m) => String(m.pageErrors));
  textRow("recovery rounds", (m) => String(m.recoveryRounds));
  textRow("ask evidence chars", (m) => (m.askEvidenceChars === undefined ? "-" : String(m.askEvidenceChars)));
  textRow("errors", (m) => [m.generateError && "generate", m.askError && "ask"].filter(Boolean).join(", ") || "none");
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  console.log("");
  for (const row of rows) console.log(`  ${row.map((cell, column) => cell.padEnd(widths[column] + 2)).join("")}`);
  console.log("\n  Negative delta = kb-on was faster. One run per config; treat as signal, not statistics.");
}

const { flags } = parseFlags(process.argv.slice(2));
const repoInput = typeof flags.repo === "string" ? flags.repo : DEFAULT_REPO;
const pages = typeof flags.pages === "string" ? Number(flags.pages) : 4;
if (!Number.isInteger(pages) || pages < 1 || pages > 30) throw new Error("--pages must be an integer from 1 to 30");
const requestedMode = typeof flags.mode === "string" ? flags.mode : "both";
if (requestedMode !== "both" && requestedMode !== "on" && requestedMode !== "off") {
  throw new Error("--mode must be both, on, or off");
}
const modes: AbMode[] = requestedMode === "both" ? ["on", "off"] : [requestedMode];

const agents = await getLocalCliAgents({ rescan: true });
if (!agents.enabled) throw new Error(`Local CLI sidecar unavailable: ${agents.error || "unknown error"}`);
const agent = agents.agents.find((candidate) => candidate.runnable);
if (!agent) throw new Error("No ready local CLI agent found. Run `rlm-wiki agents --rescan`.");
const localCli = normalizeLocalCliConfig({
  agentId: agent.id,
  ...(agent.defaultModel && agent.defaultModel !== "default" ? { model: agent.defaultModel } : {}),
});
console.log(`code-kb A/B · repo ${repoInput} · ${pages} pages · agent ${localCliLabel(localCli)} · mode ${requestedMode}`);

const results: Partial<Record<AbMode, RunMetrics>> = {};
for (const mode of modes) {
  results[mode] = await runMode(mode, repoInput, pages, localCli);
}
printComparison(results.on, results.off);
