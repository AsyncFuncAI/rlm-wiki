# Reflection: Restoring RLM Reliability

Date: 2026-05-02

## What Happened

RLM mode had become unstable across Ask, Review, and Wiki generation. The failure modes were not model-specific; good models could still drift into bad runtime behavior:

- Ask could submit thin answers too early, especially after the harness learned to avoid broad reads.
- Review could produce useful prose but miss citations, sources, or verification structure.
- Wiki page generation could persist a long private reasoning monologue because the old page gate mostly rejected only short placeholders.

The important lesson: prompt improvements help, but product surfaces need acceptance gates at the persistence boundary. If the generated artifact is not shaped like the product expects, we should retry or mark it invalid instead of saving it as user-facing truth.

## What We Changed

- Added first-class `rg` support in the vendored RLM sandbox, with smart-case behavior and a JavaScript fallback when ripgrep is unavailable.
- Updated RLM prompts to prefer discovery-first search, `readFileRange`, small verified spans, and source tracking.
- Added runtime guardrails for malformed generated JavaScript, broad read sweeps, final-step synthesis, MCP validation loops, and fallback answer extraction.
- Added Ask answer validation and retry for malformed fragments, unfinished exploration, missing persisted sources, and missing citations.
- Split Ask Fast and Deep behavior:
  - Fast keeps the compact search/read/answer pattern.
  - Deep now gets larger budgets, deeper prompt guidance, and an evidence floor.
- Added Review retry and repair flow for missing citations, empty sources, weak final shape, and missing verification.
- Added Wiki page quality checks so invalid pages do not silently become saved wiki content.

## What We Learned

The core tension is between reliability and depth. The first reliability pass made RLM more consistent by encouraging smaller searches and earlier synthesis. That fixed cost and malformed output, but it also made Deep Ask feel too shallow. The better shape is not one global policy; it is surface-aware and mode-aware control.

Fast should be allowed to be fast. Deep should have a minimum evidence floor. Wiki generation should be stricter than Ask because it persists long-lived content. Review should be stricter than chat because users may publish the result back to GitHub.

## Current Guardrails

- Ask Deep now rejects citation-light answers for architecture, lifecycle, trace, implementation, how, and why questions unless the answer explicitly establishes a tiny or single-file scope.
- Wiki pages must start with the required source-file details block, include the expected page heading, and avoid leaked reasoning/final-answer chatter.
- Review answers are normalized with inferred citations and retried when the evidence contract is weak.
- The RLM runtime can push back on broad read sweeps before executing them, and it can force synthesis when the loop reaches the end.

## Open Questions

- We should add small automated tests around the new quality gates so future prompt tuning does not weaken them quietly.
- We may want per-surface telemetry for retry reasons: Ask deep-evidence miss, Wiki leaked-reasoning rejection, Review missing-sources repair, etc.
- The page generator currently retries once. If invalid pages remain common, a targeted repair pass that preserves explored evidence may be cheaper than a full fresh page run.
- Deep mode should continue to be judged by user-perceived usefulness, not only by citation count.

## Operating Principle

Do not trust a model response just because it is long, confident, or cited. Trust it when it satisfies the product contract for the surface that will display or persist it.
