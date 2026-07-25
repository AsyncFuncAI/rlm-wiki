#!/usr/bin/env bun

/**
 * Example: Query a GitHub repository.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/ask-github.ts https://github.com/user/repo "How does X work?"
 */

import { RLM, AnthropicClient } from "../src/index.ts";

const [source, ...queryParts] = process.argv.slice(2);
const query: string = queryParts.join(" ");

if (!source || !query) {
  console.log("Usage: bun run examples/ask-github.ts <github-url> <query>");
  console.log(
    'Example: bun run examples/ask-github.ts https://github.com/expressjs/express "How does routing work?"'
  );
  process.exit(1);
}

const llm = new AnthropicClient({ model: "claude-opus-4-7" });

const rlm = new RLM({
  source,
  llm,
  subLM: new AnthropicClient({ model: "claude-haiku-4-5-20251001" }),
  maxIterations: 20,
  maxLLMCalls: 50,
  verbose: true,
});

console.log(`\nQuerying: "${query}"`);
console.log(`Source: ${source}\n`);

const result = await rlm.query(query);

console.log("\n========== ANSWER ==========\n");
console.log(result.answer);
console.log("\n========== SOURCES ==========\n");
console.log(result.sources.join("\n"));
console.log(`\n(${result.trajectory.length} exploration steps)`);

