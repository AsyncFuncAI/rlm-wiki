/**
 * Extract variable names from const/let/var declarations in code.
 * Handles simple declarations, array destructuring, and object destructuring.
 */
export function extractDefinedVars(code: string): string[] {
  const vars: string[] = [];
  const lines = code.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Simple: const x = ..., let y = ..., var z = ...
    const simple = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (simple) {
      vars.push(simple[1]);
      continue;
    }

    // Array destructuring: const [a, b, ...rest] = ...
    const arrMatch = trimmed.match(/^(?:const|let|var)\s+\[([^\]]+)\]\s*=/);
    if (arrMatch) {
      const names = arrMatch[1].split(",").map(s => s.trim().replace(/^\.\.\./, "")).filter(Boolean);
      vars.push(...names);
      continue;
    }

    // Object destructuring: const {a, b: alias, ...rest} = ...
    const objMatch = trimmed.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=/);
    if (objMatch) {
      const pairs = objMatch[1].split(",").map(s => s.trim()).filter(Boolean);
      for (const pair of pairs) {
        if (pair.startsWith("...")) {
          vars.push(pair.slice(3));
        } else if (pair.includes(":")) {
          // { key: alias } → alias is the variable name
          vars.push(pair.split(":")[1].trim());
        } else {
          vars.push(pair);
        }
      }
      continue;
    }
  }

  return vars;
}

/**
 * Extract a condensed 1-line summary from execution output.
 * Takes the first non-empty, non-bracket line, capped at 120 chars.
 */
export function extractKeyFindings(output: string): string {
  if (!output) return "";

  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, pure brackets, plan output markers, error prefixes
    if (!trimmed) continue;
    if (/^[\[\]{}(),;]+$/.test(trimmed)) continue;
    if (trimmed.startsWith("Injected:")) continue;

    // Cap at 120 chars
    if (trimmed.length > 120) {
      return trimmed.slice(0, 117) + "...";
    }
    return trimmed;
  }

  return output.slice(0, 120).replace(/\n/g, " ");
}
