#!/usr/bin/env bun
/**
 * Unikraft dispatch smoke checks.
 *
 * Dry-run (default): validates config + client list API.
 * Live: creates a tiny delete-on-stop instance then deletes it.
 *
 *   bun run scripts/unikraft-smoke.ts
 *   bun run scripts/unikraft-smoke.ts --live
 */
import {
  createUnikraftClient,
  unikraftDispatchConfig,
} from "../src/unikraft-compute.ts";

const live = process.argv.includes("--live");
const config = unikraftDispatchConfig();

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!config.token) fail("UNIKRAFT_API_KEY / UKC_TOKEN missing");
if (!config.image && live) fail("RLM_WIKI_UNIKRAFT_IMAGE required for --live");

console.log("config", {
  enabled: config.enabled,
  metro: config.metro,
  image: config.image || "(unset)",
  memoryMb: config.memoryMb,
  maxConcurrent: config.maxConcurrent,
  jobTypes: config.jobTypes,
  live,
});

const client = createUnikraftClient(config);
const listed = await client.listInstances();
console.log(`listInstances: ${listed.length} instance(s)`);

if (!live) {
  console.log("OK dry-run (pass --live to create+delete a smoke instance)");
  process.exit(0);
}

const name = `rlm-smoke-${Date.now().toString(36)}`;
console.log(`createInstance ${name} ...`);
const instance = await client.createInstance({
  name,
  image: config.image,
  memoryMb: Math.min(config.memoryMb, 512),
  env: {
    RLM_WIKI_SMOKE: "1",
  },
  args: ["-e", "console.log('rlm-wiki unikraft smoke')"],
  entrypoint: ["bun"],
  autokillMs: 60_000,
  timeoutS: 60,
  tags: ["rlm-wiki", "smoke"],
});
console.log("created", instance);
console.log("deleteInstance ...");
await client.deleteInstance(instance.uuid || instance.name);
console.log("OK live smoke");
