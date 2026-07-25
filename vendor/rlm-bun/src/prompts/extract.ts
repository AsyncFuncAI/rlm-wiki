import type { Session } from "../state/session.ts";

/**
 * Build the extraction fallback prompt.
 * Used when the RLM reaches max iterations without a SUBMIT call.
 */
export function buildExtractPrompt(query: string, session: Session): string {
  return `You are synthesizing a final answer from a codebase exploration session.

## Original Query
"${query}"

## What You Explored
${session.summarize(3)}

## Instructions
You reached the maximum number of exploration iterations. Based on everything you discovered above, provide your best answer now.

Your response MUST be valid JSON. Required keys:
{
  "answer": "Your comprehensive markdown answer here. Include code snippets, file references, and explanations.",
  "sources": ["path/to/file1.js", "path/to/file2.js"],
  "confidence": "high|medium|low"
}
You may include additional keys like "comparison", "gapMatrix", or "bridgePlan" if relevant.

Guidelines:
- If you found strong evidence, give a thorough answer with HIGH confidence
- If evidence is partial, give what you know and note gaps with MEDIUM confidence
- If you barely found anything relevant, say so honestly with LOW confidence
- Always reference specific files and code you actually examined
- Never make up file paths or code you didn't see in the exploration history

Respond with JSON only, no surrounding text.`;
}

