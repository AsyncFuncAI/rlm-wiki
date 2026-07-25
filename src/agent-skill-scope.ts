const PROMPT_COMPACT_SURFACES = new Set([
  "ask",
  "chat",
  "wiki-structure",
  "wiki-page",
  "wiki-slides",
]);

export function shouldInjectAgentSkills(contextLabel?: string): boolean {
  return !PROMPT_COMPACT_SURFACES.has(String(contextLabel || "").trim());
}
