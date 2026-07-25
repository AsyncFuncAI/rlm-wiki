#!/usr/bin/env bun

import { isPRURL } from "../src/source-loader.ts";
import { printHelp } from "../src/cli/help.ts";
import { parseArgs } from "../src/cli/args.ts";
import { runInteractive } from "../src/cli/interactive.ts";
import { C, GRAYS, createOnEvent, createDisplayAnswer } from "../src/cli/display.ts";
import { setupRLM } from "../src/cli/setup.ts";

// --- Parse CLI args ---

const rawArgs: string[] = process.argv.slice(2);

if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printHelp();
}

const parsed = parseArgs(process.argv);
const {
  mode, provider, model, subProvider, subModel, subBaseURL, baseURL,
  maxIter, maxLLM, branch, sandboxTimeout, githubToken,
  interactive, promptMode, verbose, optimizer, jsonOutput,
  goal, sessionDir, resumeSessionId,
  source, sources, displaySource,
} = parsed;
const { query } = parsed;

// --- Build event handler and setup RLM ---

const onEvent = createOnEvent({ jsonOutput, verbose, model, provider, source: source || null });

const { rlm, skillRegistry } = await setupRLM({
  mode, provider, model, subProvider, subModel, subBaseURL, baseURL,
  maxIter, maxLLM, branch, sandboxTimeout, githubToken,
  verbose, optimizer, jsonOutput, sessionDir, resumeSessionId,
  promptMode, source, sources, onEvent,
});

const displayAnswer = createDisplayAnswer(rlm as any, { jsonOutput, verbose, model, provider, source: source || null });

// --- Banner ---

if (!jsonOutput) {
  if (process.stderr.isTTY) {
    const logoLines = [
      "  ╦═╗╦  ╔╦╗",
      "  ╠╦╝║  ║║║",
      "  ╩╚═╩═╝╩ ╩  bun",
    ];
    process.stderr.write("\n");
    for (const line of logoLines) {
      line.split("").forEach((ch, i) => {
        process.stderr.write((GRAYS[Math.min(i, GRAYS.length - 1)] || GRAYS[3]) + ch);
      });
      process.stderr.write(C.reset + "\n");
    }
    console.error(`  ${C.muted}think → code → observe${C.reset}\n`);
  } else {
    process.stderr.write("\n");
    "rlm-bun".split("").forEach((ch, i) => {
      process.stderr.write((GRAYS[Math.min(i, GRAYS.length - 1)] || GRAYS[3]) + ch);
    });
    process.stderr.write(C.reset + "\n");
  }

  if (sources) {
    console.error(`${C.muted}mode:  ${C.reset}workspace${interactive ? `  ${C.muted}(interactive)${C.reset}` : ""}`);
    console.error(`${C.muted}repos: ${C.body}${displaySource}${C.reset}`);
    console.error(`${C.muted}goal:  ${C.body}${goal || "custom query"}${C.reset}`);
  } else if (promptMode) {
    console.error(`${C.muted}mode:  ${C.reset}chat${interactive ? `  ${C.muted}(interactive)${C.reset}` : ""}`);
    if (query) console.error(`${C.muted}query: ${C.body}${query}${C.reset}`);
  } else if (source && isPRURL(source)) {
    console.error(`${C.muted}mode:  ${C.reset}pr-review${interactive ? `  ${C.muted}(interactive)${C.reset}` : ""}`);
    console.error(`${C.muted}pr:    ${C.body}${source}${C.reset}`);
    console.error(`${C.muted}query: ${C.body}${query!}${C.reset}`);
  } else {
    console.error(`${C.muted}mode:  ${C.reset}${mode}${interactive ? `  ${C.muted}(interactive)${C.reset}` : ""}`);
    console.error(`${C.muted}src:   ${C.body}${source}${C.reset}`);
    console.error(`${C.muted}query: ${C.body}${query!}${C.reset}`);
  }
  console.error("");
}

// --- Run ---

try {
  if (interactive || promptMode) {
    await runInteractive(rlm, query, promptMode, skillRegistry, C, displayAnswer);
  } else {
    const result = await rlm.query(query!);
    displayAnswer(result);
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (jsonOutput) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`\nError: ${message}`);
  }
  process.exit(1);
}
