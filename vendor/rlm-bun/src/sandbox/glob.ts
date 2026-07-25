import { existsSync, readdirSync } from "fs";
import { join } from "path";

const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

function escapeRegexChar(ch: string): string {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function expandBraceAlternates(pattern: string): string {
  return pattern.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    return `(${inner.split(",").map((part) => part.trim().split("").map(escapeRegexChar).join("")).join("|")})`;
  });
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\/+$/, "");
  const withBraces = expandBraceAlternates(normalized);
  let source = "";
  for (let i = 0; i < withBraces.length; i++) {
    const ch = withBraces[i];
    const next = withBraces[i + 1];
    if (ch === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "(" || ch === ")" || ch === "|") {
      source += ch;
    } else {
      source += escapeRegexChar(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function collectDirectories(root: string, dir = "", out: string[] = []): string[] {
  const abs = dir ? join(root, dir) : root;
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    out.push(rel);
    collectDirectories(root, rel, out);
  }
  return out;
}

function directoryMatches(root: string, pattern: string): string[] {
  const rx = globToRegExp(pattern);
  return collectDirectories(root)
    .filter((dir) => rx.test(dir))
    .map((dir) => `${dir}/`);
}

export function scanGlobPaths(root: string, pattern: string): string[] {
  const g = new Bun.Glob(pattern);
  const matches = Array.from(g.scanSync({ cwd: root }));
  if (pattern.endsWith("/") || matches.length === 0) {
    const dirs = directoryMatches(root, pattern);
    for (const dir of dirs) {
      if (!matches.includes(dir)) matches.push(dir);
    }
  }
  return matches;
}
