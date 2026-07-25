#!/usr/bin/env bun

/**
 * Example: Review a GitHub Pull Request.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-ant-... bun run examples/pr-review.ts https://github.com/owner/repo/pull/123 "Focus on security"
 */

import { RLM, AnthropicClient } from "../src/index.ts";

const [prURL, ...queryParts] = process.argv.slice(2);
const query: string = queryParts.join(" ") || "Review this PR thoroughly";

if (!prURL) {
  console.log("Usage: bun run examples/pr-review.ts <pr-url> [query]");
  console.log(
    'Example: bun run examples/pr-review.ts https://github.com/owner/repo/pull/123 "Focus on security"'
  );
  process.exit(1);
}

const llm = new AnthropicClient({ model: "claude-opus-4-7" });

const rlm = new RLM({
  source: prURL,
  githubToken: process.env.GITHUB_TOKEN,
  llm,
  subLM: new AnthropicClient({ model: "claude-opus-4-7" }),
  maxIterations: 20,
  verbose: true,
});

console.log(`\nReviewing PR: ${prURL}`);
console.log(`Query: "${query}"\n`);

const result = await rlm.query(query);

console.log("\n========== ANSWER ==========\n");
console.log(result.answer);
console.log("\n========== SOURCES ==========\n");
console.log(result.sources.join("\n"));
console.log(`\n(${result.trajectory.length} exploration steps)`);
