import type { KbHistoryMessage } from "../kb-prompts.ts";
import type { SeededExistingCard } from "../knowledge-base-types.ts";

/**
 * ECC-style fixture (ECC = "Effortless Code Companion", a small CLI tool the asks
 * are about). One real 4-turn conversation plus seeded existing cards.
 *
 * The conversation has FOUR turns:
 *   Q1  install            -> conclusive  (general install)
 *   Q2  project-install    -> conclusive  (project-scoped install; SAME install intent as Q1)
 *   Q3  best-practices     -> conclusive  (distinct intent: a developer convention)
 *   Q4  inconclusive       -> DEAD END    (no answer reached; must be dropped)
 *
 * Expected distill clustering: 4Q -> 3 cards, with Q1+Q2 merged into ONE install
 * card and Q4 dropped entirely.
 *
 * Seeded existing cards include:
 *   - `existing-setup-guide`: an install card whose TITLE differs ("Getting ECC
 *     running") but whose INTENT matches the new install card — used to prove
 *     semantic match by INTENT (id), not by title string equality.
 *   - `readme-default-port`: a README doc card (sourceTier "doc") asserting the
 *     default port is 8080 — used for the contradiction test (a fresh card claiming
 *     3000 must land provisional, never override the doc).
 */

const Q1 = "ecc-q1-install";
const Q2 = "ecc-q2-project-install";
const Q3 = "ecc-q3-best-practices";
const Q4 = "ecc-q4-deadend";

export const eccConversation: KbHistoryMessage[] = [
  // --- Q1: general install (conclusive) ---
  {
    askId: Q1,
    role: "user",
    content: "How do I install the ecc command-line tool on my machine?",
  },
  {
    askId: Q1,
    role: "assistant",
    content:
      "Install ECC globally with the package manager: run `bun add -g ecc`. After it finishes, `ecc --version` confirms the binary is on your PATH. That is all that is needed for a system-wide install.",
  },
  // --- Q2: project-scoped install (conclusive; SAME install intent as Q1) ---
  {
    askId: Q2,
    role: "user",
    content: "What about adding ECC just to one project instead of globally?",
  },
  {
    askId: Q2,
    role: "assistant",
    content:
      "For a single project, install it as a dev dependency: `bun add -d ecc` inside the project root. Then invoke it through `bunx ecc` or an npm-style script so the project pins its own version. This is the same install story as the global case, scoped to the repo.",
  },
  // --- Q3: best practices (conclusive; distinct intent -> developer convention) ---
  {
    askId: Q3,
    role: "user",
    content: "Any best practice for organizing ECC config in a team repo?",
  },
  {
    askId: Q3,
    role: "assistant",
    content:
      "Keep a single committed `ecc.config.ts` at the repo root and never put secrets in it; load secrets from the environment. Teams that follow this avoid drift between members' setups. Treat the config file as the one source of truth.",
  },
  // --- Q4: inconclusive dead-end (NO answer reached; must be dropped) ---
  {
    askId: Q4,
    role: "user",
    content: "Why does ECC sometimes hang for a few seconds on my laptop at startup?",
  },
  {
    askId: Q4,
    role: "assistant",
    content:
      "I am not sure yet. It could be a few different things and I could not reproduce it from the information given. We did not reach a conclusion on this one.",
  },
];

/**
 * Seeded existing KB cards. Note `existing-setup-guide` has a DIFFERENT title from
 * what a new install card would carry, but the SAME intent (install).
 */
export const eccExistingCards: SeededExistingCard[] = [
  {
    id: "existing-setup-guide",
    kind: "workflow",
    title: "Getting ECC running",
    body: "Install ECC with `bun add -g ecc`, then check `ecc --version`. This is the canonical way to get the tool onto a developer machine.",
    sourceTier: "card",
    timestamp: "2026-05-01T10:00:00.000Z",
    status: "provisional",
    corroborationCount: 1,
    sourceAskIds: ["ecc-legacy-install"],
  },
  {
    id: "readme-default-port",
    kind: "developer convention",
    title: "ECC default server port",
    body: "Per the project README, the ECC dev server listens on port 8080 by default. Override it with `ecc serve --port`.",
    sourceTier: "doc",
    timestamp: "2026-04-15T09:00:00.000Z",
    status: "corroborated",
    corroborationCount: 3,
    sourceAskIds: ["ecc-readme-import"],
  },
];

/** The ids exported for tests that assert clustering provenance precisely. */
export const eccAskIds = { Q1, Q2, Q3, Q4 } as const;
