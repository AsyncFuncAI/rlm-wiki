#!/usr/bin/env bun

/**
 * Example: Generalist / prompt mode (no source repository).
 *
 * In chat mode the RLM acts as a general-purpose assistant backed by
 * an LLM — no codebase or document source is required.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/chat.ts
 */

import { RLM, AnthropicClient } from "../src/index.ts";

const llm = new AnthropicClient({ model: "claude-opus-4-7" });

const rlm = new RLM({
  llm,
  mode: "chat",
});

const query =
  "What are the top 3 most popular JavaScript frameworks in 2025? Search the web and compare them.";

console.log(`\nQuerying: "${query}"\n`);

const result = await rlm.query(query);

console.log("\n========== ANSWER ==========\n");
console.log(result.answer);
