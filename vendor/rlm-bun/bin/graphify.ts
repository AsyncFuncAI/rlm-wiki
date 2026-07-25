#!/usr/bin/env bun

import { buildGraphifyTools } from "../src/sandbox/graphify-tools.ts";
import { resolve } from "path";
import { unlinkSync, existsSync } from "fs";

const repoPath = resolve(process.argv[2] || process.cwd());
const graphPath = resolve(repoPath, "graphify-out", "graph.json");

if (existsSync(graphPath)) {
  console.log(`[graphify] Removing existing graph at ${graphPath}`);
  unlinkSync(graphPath);
}

console.log(`[graphify] Generating graph for ${repoPath}...`);
const start = Date.now();
const tools = buildGraphifyTools(repoPath);

if (tools) {
  console.log(`[graphify] Done in ${Date.now() - start}ms.`);
} else {
  console.error(`[graphify] Failed to generate graph.`);
  process.exit(1);
}
