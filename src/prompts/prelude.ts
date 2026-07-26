import type { AgentRuntime } from "../agent-runtime.ts";
import type { WikiDepth } from "../wiki-options.ts";

/**
 * Per-channel guidance prepended to prompts before they are handed to an agent
 * harness. JCODE and rlm-bun have opposite tool contracts, so keep the bridge
 * explicit at the prompt edge.
 */
export function preludeForRuntime(channelId: string, depth: WikiDepth = "deep", runtime: AgentRuntime = "agent"): string {
  if (runtime === "rlm") return rlmPreludeForChannel(channelId, depth);
  if (runtime === "local-cli") return localCliPreludeForChannel(depth);
  return jcodePreludeForChannel(channelId, depth);
}

export function preludeForChannel(channelId: string, depth: WikiDepth = "deep"): string {
  return preludeForRuntime(channelId, depth, "agent");
}

function jcodePreludeForChannel(_channelId: string, depth: WikiDepth = "deep"): string {
  const speed = depth === "fast"
    ? [
        "# Fast Mode",
        "Use the smallest useful JCODE investigation: one targeted search/read pass, then answer as soon as the claim is supported.",
        "Avoid broad architecture mapping unless the question truly requires it.",
      ].join("\n")
    : depth === "regular"
      ? [
          "# Regular Mode",
          "Use a balanced JCODE investigation: map the main repo shape, then verify the files that determine the answer.",
          "Avoid exhaustive architecture mapping unless the repository complexity justifies it.",
        ].join("\n")
    : [
        "# Deep Mode",
        "Use JCODE's native tools to inspect the repository directly. Map structure first for architecture questions, then read the few files that can confirm or falsify the answer.",
      ].join("\n");

  return [
    "# JCODE Agent Instructions",
    "Use JCODE native tools directly. Do not emit legacy JavaScript tool loops, JIT blocks, or SUBMIT calls.",
    "Think Socratically before tool use: what evidence would change the answer, which command or file can produce it, and what is the smallest reliable next step?",
    "When a prompt asks for <ANSWER> tags, put the final answer inside <ANSWER>...</ANSWER> and stop.",
    "Never finish with tools only. A tools-only transcript with an empty or missing final answer is a failed task — always end with a non-empty user-facing answer in the requested format.",
    speed,
    "",
  ].join("\n");
}

function rlmPreludeForChannel(channelId: string, depth: WikiDepth = "deep"): string {
  const speed = depth === "fast"
    ? [
        "# Fast Mode",
        "Use the smallest useful rlm-bun investigation: one targeted search/read step, then answer as soon as the claim is supported.",
        "Prefer `rg`, `inspect`, `glob`, `listFiles`, and targeted `readFileRange` over broad whole-file reads.",
        "Avoid broad architecture mapping unless the question truly requires it.",
      ].join("\n")
    : depth === "regular"
      ? [
          "# Regular Mode",
          "Use a balanced rlm-bun investigation: map the main repo shape, then verify the files that determine the answer.",
          "Prefer `rg`, `inspect`, `glob`, `listFiles`, and targeted `readFileRange` over broad whole-file reads.",
          "Avoid exhaustive architecture mapping unless the repository complexity justifies it.",
        ].join("\n")
    : [
        "# Deep Mode",
        "Use rlm-bun's JavaScript sandbox to inspect the repository directly. Map structure first for architecture questions, then read the few files that can confirm or falsify the answer.",
        "`rg(pattern, opts)` is the preferred ripgrep-backed search tool. `grep(pattern, opts)` remains available as a compatibility alias.",
      ].join("\n");

  const strictFirstStep = /^(deepseek-v4-|kimi-k2\.6)/.test(channelId)
    ? [
        "# First-Step Guard",
        "Your first response must be exactly one repository-inspection JavaScript block. Do not answer, summarize, or call SUBMIT before at least one tool-backed inspection step.",
      ].join("\n")
    : "";

  return [
    "# RLM Agent Instructions",
    "You are running inside the rlm-bun JavaScript REPL sandbox.",
    "Exploration steps must output exactly one executable ```js block or one tiny <JIT> block. Do not emit native provider tool-call/function-call JSON.",
    "Use `rg`, `inspect`, `glob`, `listFiles`, and `readFileRange` to navigate by evidence. Avoid broad `readFile` sweeps and manual `split().slice()` line windows.",
    "Think Socratically before tool use: what evidence would change the answer, which command or file can produce it, and what is the smallest reliable next step?",
    "When a prompt asks for <ANSWER> tags, put the final answer inside <ANSWER>...</ANSWER>. When sources are required, follow it with one tiny ```js block calling SUBMIT({ sources: [...] }).",
    strictFirstStep,
    speed,
    "",
  ].filter(Boolean).join("\n");
}

function localCliPreludeForChannel(depth: WikiDepth = "deep"): string {
  const speed = depth === "fast"
    ? [
        "# Fast Mode",
        "Use the smallest useful local CLI investigation: one targeted search/read pass, then answer as soon as the claim is supported.",
        "Avoid broad architecture mapping unless the question truly requires it.",
      ].join("\n")
    : depth === "regular"
      ? [
          "# Regular Mode",
          "Use a balanced local CLI investigation: map the main repo shape, then verify the files that determine the answer.",
          "Avoid exhaustive architecture mapping unless the repository complexity justifies it.",
        ].join("\n")
      : "";

  return [
    "# Local CLI Agent Instructions",
    "Use native CLI tools directly.",
    "When a prompt asks for <ANSWER> tags, put the final answer inside <ANSWER>...</ANSWER> and stop.",
    "When done, return a non-empty final answer as Markdown (inside <ANSWER> when requested).",
    "Never finish with tools only. A tools-only transcript with an empty or missing final answer is a failed task.",
    speed,
    "",
  ].join("\n");
}
