import type { LLMClient } from "../llm/types.ts";

/**
 * Mildly auto-optimize a raw user query before the main RLM loop.
 *
 * Uses the sub-LLM to rewrite the query into a clearer, more answerable
 * version — fixing ambiguities, adding specificity, and making the intent
 * explicit — without changing the underlying ask.
 *
 * The rewrite is intentionally conservative ("mild"): it preserves the
 * original meaning and does not add assumptions about the codebase.
 */
export async function optimizeQuery(
  query: string,
  subLM: LLMClient,
): Promise<{ optimizedQuery: string; changed: boolean }> {
  const prompt = `You are a prompt-optimization assistant.
Your job is to take a user query and mildly improve it so the analysis agent can answer it more precisely.

Rules:
- Keep the original intent exactly. Do NOT change what is being asked.
- Fix grammar, ambiguity, and vagueness where obvious.
- If the query references "it", "this", "the thing" etc., clarify what they refer to if inferable.
- Add specificity if the original is generic, adopt socratical questioning/discussion. (e.g., "how does it work").
- Do NOT add assumptions, guesses, or new requirements not implied by the original.
- Do NOT add boilerplate or meta-commentary.
- If the query is already clear and specific, return it unchanged.
- Output ONLY the rewritten query — no explanation, no quotes, no prefix.

Original query:
${query}`;

  let optimized: string;
  try {
    const result = await subLM.generate(prompt);
    optimized = (result || "").trim();
  } catch {
    // On any error, fall back to the original query silently
    return { optimizedQuery: query, changed: false };
  }

  // Sanity check: if the result is empty or suspiciously long, bail out
  if (!optimized || optimized.length > query.length * 4) {
    return { optimizedQuery: query, changed: false };
  }

  const changed = optimized.toLowerCase() !== query.toLowerCase();
  return { optimizedQuery: optimized, changed };
}