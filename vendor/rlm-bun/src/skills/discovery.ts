// Skill discovery for rlm-bun — filesystem walker for SKILL.md files

import { readFile, stat, readdir } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { SkillRecord } from "./types.ts";

const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__"];

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { data: {}, body: content };
  }
  const closingIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closingIdx === -1) {
    return { data: {}, body: content };
  }
  const frontmatterLines = lines.slice(1, closingIdx);
  const body = lines.slice(closingIdx + 1).join("\n").trimStart();
  const data: Record<string, string> = {};
  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i]!;
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const [, key, raw = ""] = match;
    const value = raw.trim();
    if (value === "|" || value === ">") {
      const block: string[] = [];
      for (i++; i < frontmatterLines.length; i++) {
        const next = frontmatterLines[i]!;
        if (!next.trim()) {
          block.push("");
          continue;
        }
        if (!/^\s/.test(next)) {
          i--;
          break;
        }
        block.push(next);
      }
      const cleaned = stripCommonIndent(block);
      data[key!] = value === ">"
        ? cleaned.join(" ").replace(/\s+/g, " ").trim()
        : cleaned.join("\n").trim();
    } else if (value) {
      data[key!] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body };
}

function stripCommonIndent(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(minIndent, line.length)).trimEnd());
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    const s = await stat(join(dir, "SKILL.md"));
    return s.isFile();
  } catch {
    return false;
  }
}

async function findSkillDirs(dir: string, depth = 0, maxDepth = 5): Promise<string[]> {
  if (depth > maxDepth) return [];
  try {
    const [hasSkill, entries] = await Promise.all([
      hasSkillMd(dir),
      readdir(dir, { withFileTypes: true }).catch(() => []),
    ]);
    const current = hasSkill ? [dir] : [];
    const subResults = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !SKIP_DIRS.includes(e.name))
        .map((e) => findSkillDirs(join(dir, e.name), depth + 1, maxDepth))
    );
    return [...current, ...subResults.flat()];
  } catch {
    return [];
  }
}

export async function parseSkillMd(skillMdPath: string): Promise<SkillRecord | null> {
  try {
    const content = await readFile(skillMdPath, "utf-8");
    const { data, body } = parseFrontmatter(content);
    if (!data["name"] || !data["description"]) return null;
    if (typeof data["name"] !== "string" || typeof data["description"] !== "string") return null;
    return {
      name: data["name"],
      description: data["description"],
      body,
      source: skillMdPath,
      loadedAt: new Date(),
      metadata: Object.fromEntries(
        Object.entries(data).filter(([k]) => k !== "name" && k !== "description")
      ),
    };
  } catch {
    return null;
  }
}

function isSubpathSafe(basePath: string, subpath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(join(basePath, subpath)));
  return (
    normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase
  );
}

export async function discoverSkills(
  basePath: string,
  subpath?: string
): Promise<SkillRecord[]> {
  if (subpath && !isSubpathSafe(basePath, subpath)) {
    throw new Error(
      `Invalid subpath "${subpath}" escapes base directory. Subpath must not contain ".." segments.`
    );
  }
  const searchPath = subpath ? join(basePath, subpath) : basePath;
  const skillDirs = await findSkillDirs(searchPath);
  const results: SkillRecord[] = [];
  const seenNames = new Set<string>();
  for (const dir of skillDirs) {
    const skill = await parseSkillMd(join(dir, "SKILL.md"));
    if (skill && !seenNames.has(skill.name)) {
      seenNames.add(skill.name);
      results.push(skill);
    }
  }
  return results;
}
