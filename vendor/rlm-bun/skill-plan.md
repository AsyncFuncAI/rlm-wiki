# rlm-bun × skillsh: Dynamic Skill Integration Plan

## Executive Summary

`rlm-bun` has a production-grade REPL sandbox (Bun subprocess + IPC protocol), a streaming LLM loop, and an interactive follow-up mode — but **zero skill infrastructure**: no skill discovery, no `/` command interface, no way to inject contextual knowledge into the LLM system prompt at runtime. `skillsh` has the complete inverse: a mature skill ecosystem (discovery, locking, registry, multi-agent installation) but no REPL or LLM execution layer.

The integration opportunity is deep and high-value. Below is a prioritized plan with concrete code references and adaptation guidance.

---

## Feature Gap Matrix

| Feature | skillsh | rlm-bun | Gap |
|---|---|---|---|
| SKILL.md format (frontmatter + markdown body) | ✅ Full | ❌ None | rlm-bun needs this |
| Skill discovery (filesystem walk) | ✅ `discoverSkills()` | ❌ None | rlm-bun needs this |
| Source parsing (GitHub, GitLab, local, well-known) | ✅ `parseSource()` | ⚠️ Partial (only for repos) | Extend existing loader |
| Well-known registry search | ✅ `runFind()` | ❌ None | Port from skillsh |
| Skill lock / integrity hashing | ✅ `local-lock.ts` + `skill-lock.ts` | ❌ None | Port lock format |
| Plugin manifest (multi-skill bundles) | ✅ `PLUGIN.json` | ❌ None | Optional, medium priority |
| `/` command interface in interactive REPL | ❌ None | ❌ None (stub exists) | Both need this — rlm-bun builds it |
| Skill injection into system prompt | ❌ Not applicable (skillsh writes to disk, agents read) | ❌ None | New for rlm-bun |
| Hot-reload skills without restart | ❌ No REPL | ❌ No skills | New for rlm-bun |
| Agent-specific install paths (cursor, claude-code, etc.) | ✅ `agents.ts` | ❌ None | Lower priority for rlm-bun |
| Interactive skill search prompt | ✅ `search-multiselect.ts` | ❌ None | Port concept |
| Skill sandboxing/scoping | N/A (markdown only, no code) | ✅ Bun subprocess IPC | rlm-bun's sandbox already handles this |

---

## Architecture: How Skill Injection Works in rlm-bun

The key insight from reading both repos: **rlm-bun injects everything into the LLM via `buildActionPrompt()` in `src/prompts/action.ts`**. Skills should be injected there as an additional system prompt section. The sandbox worker (`src/sandbox/worker.ts`) evaluates LLM-generated code, so skills don't run in the sandbox — they inform the LLM that generates the code.

```
User types: /skill add vercel-labs/agent-skills@react-best-practices
                │
                ▼
    SlashCommandRouter (new, in bin/rlm.ts)
                │
                ▼
    SkillRegistry.add(source)  ──→  clone/fetch SKILL.md
                │                   parse frontmatter + body
                ▼
    SkillRegistry.getLoaded()   ──→  [{name, description, body}]
                │
                ▼
    buildActionPrompt(query, repoIndex, skills)
                │
                ▼
    System prompt now includes:
    ## Loaded Skills
    ### react-best-practices
    <full SKILL.md body injected here>
                │
                ▼
    LLM generates code that KNOWS these patterns/workflows
                │
                ▼
    sandbox/worker.ts eval() → tool calls → results → SUBMIT
```

---

## Priority 1 — HIGH: `/` Command Router in `bin/rlm.ts`

**What it does:** Intercepts slash commands in the interactive REPL before they reach the LLM. This is the primary user-facing integration point.

**Why it's critical:** The current `promptForFollowUp` callback in `bin/rlm.ts` is a raw passthrough with zero parsing. This is the exact extension point for the entire skill system.

**Current code in `mine:bin/rlm.ts`:**
```typescript
const promptForFollowUp = (): Promise<string | null> =>
  new Promise((resolve) => {
    console.error(`${C.muted}  enter to exit · type a follow-up question${C.reset}`);
    rl.question(`\n${C.accent}❯${C.reset} `, (answer: string) => {
      const trimmed = answer.trim();
      resolve(trimmed || null);  // ← raw passthrough, no command handling
    });
  });
```

**Adapted code for `bin/rlm.ts`:**
```typescript
// New slash command router — insert before promptForFollowUp callback
const skillRegistry = new SkillRegistry(); // see Priority 2

async function handleSlashCommand(input: string): Promise<string | null> {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "skill":
    case "s": {
      const [subCmd, ...subArgs] = rest;
      if (subCmd === "add" || subCmd === "a") {
        const source = subArgs.join(" ");
        if (!source) {
          console.error(`${C.muted}  Usage: /skill add <owner/repo@skill-name>${C.reset}`);
          return null; // stay in loop, don't pass to LLM
        }
        try {
          console.error(`${C.muted}  ○ Loading skill: ${source}${C.reset}`);
          const loaded = await skillRegistry.add(source);
          console.error(`${C.accent}  ✓ Skill loaded: ${loaded.name}${C.reset}`);
          console.error(`${C.muted}  ${loaded.description}${C.reset}`);
        } catch (e: any) {
          console.error(`${C.error}  ✗ Failed to load skill: ${e.message}${C.reset}`);
        }
        return null; // command handled, no LLM call needed
      }
      if (subCmd === "list" || subCmd === "ls") {
        const skills = skillRegistry.getLoaded();
        if (skills.length === 0) {
          console.error(`${C.muted}  No skills loaded. Use /skill add <source>${C.reset}`);
        } else {
          console.error(`${C.muted}  Loaded skills:${C.reset}`);
          for (const sk of skills) {
            console.error(`${C.accent}    • ${sk.name}${C.reset} ${C.muted}— ${sk.description}${C.reset}`);
          }
        }
        return null;
      }
      if (subCmd === "remove" || subCmd === "rm") {
        const name = subArgs.join(" ");
        skillRegistry.remove(name);
        console.error(`${C.muted}  Skill removed: ${name}${C.reset}`);
        return null;
      }
      if (subCmd === "find" || subCmd === "f") {
        const query = subArgs.join(" ");
        await runSkillFind(query); // see Priority 4
        return null;
      }
      // Unknown subcommand — show help
      console.error(`${C.muted}  /skill add <source>    — load a skill into this session
  /skill list           — show loaded skills
  /skill remove <name>  — unload a skill
  /skill find [query]   — search the skills registry${C.reset}`);
      return null;
    }

    case "clear":
    case "reset":
      // Signal RLM to reset conversation history
      return "/reset"; // special sentinel — RLM.queryInteractive() handles this

    case "help":
    case "?":
      console.error(`${C.muted}  Slash commands:
  /skill add <owner/repo@name>  Load a skill into the LLM context
  /skill list                   List loaded skills
  /skill find [query]           Search skills.sh registry
  /clear                        Reset conversation history
  /help                         Show this message${C.reset}`);
      return null;

    default:
      // Unknown command — pass to LLM as-is (maybe the user wants to ask about it)
      return input;
  }
}

// Updated promptForFollowUp
const promptForFollowUp = (): Promise<string | null> =>
  new Promise((resolve) => {
    console.error(`${C.muted}  enter to exit · type a follow-up · /skill add <source> to load skills${C.reset}`);
    rl.question(`\n${C.accent}❯${C.reset} `, async (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed) return resolve(null);
      if (trimmed.startsWith("/")) {
        const result = await handleSlashCommand(trimmed);
        if (result === null) {
          // Command handled, re-prompt
          resolve(await promptForFollowUp());
        } else {
          resolve(result);
        }
      } else {
        resolve(trimmed);
      }
    });
  });
```

---

## Priority 2 — HIGH: `SkillRegistry` — In-Memory Skill Store

**What it does:** Loads, parses, and holds SKILL.md files in memory for the session. Sources can be local paths, GitHub repos (`owner/repo@skill-name`), or remote URLs.

**From `skillsh:src/skills.ts` — key functions to port:**
```typescript
// skillsh:src/skills.ts — lines 25-60
export async function parseSkillMd(
  skillMdPath: string,
  options?: { includeInternal?: boolean }
): Promise<Skill | null> {
  const content = await readFile(skillMdPath, 'utf-8');
  const { data } = matter(content);  // gray-matter parses YAML frontmatter
  if (!data.name || !data.description) return null;
  return {
    name: data.name,
    description: data.description,
    path: dirname(skillMdPath),
    rawContent: content,
    metadata: data.metadata,
  };
}

// skillsh:src/skills.ts — discoverSkills() recursive walk
export async function discoverSkills(basePath: string, subpath?: string): Promise<Skill[]> {
  // walks directory tree looking for SKILL.md files
  // supports fullDepth mode to find all skills under a repo
  // deduplicates by name
}
```

**New file for rlm-bun: `src/skills/registry.ts`**
```typescript
import { readFileSync, existsSync, mkdirSync } from "fs";
import { readFile, stat } from "fs/promises";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

export interface LoadedSkill {
  name: string;
  description: string;
  body: string;        // Full markdown body (without frontmatter)
  rawContent: string;  // Full SKILL.md content including frontmatter
  source: string;      // Original source string (owner/repo@name or local path)
}

// Ported from skillsh:src/source-parser.ts
export interface ParsedSkillSource {
  type: "github" | "local" | "inline";
  repoUrl?: string;    // https://github.com/owner/repo.git
  ref?: string;        // branch/tag
  subpath?: string;    // path within repo
  skillFilter?: string; // specific skill name (after @)
  localPath?: string;
  inlineContent?: string;
}

export function parseSkillSource(input: string): ParsedSkillSource {
  // Local path
  if (input.startsWith("./") || input.startsWith("/") || input.startsWith("../")) {
    return { type: "local", localPath: resolve(input) };
  }

  // owner/repo@skill-name shorthand (from skillsh:src/source-parser.ts)
  const atMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atMatch && !input.includes(":")) {
    const [, owner, repo, skillFilter] = atMatch;
    return {
      type: "github",
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      skillFilter,
    };
  }

  // owner/repo (whole repo)
  const repoMatch = input.match(/^([^/]+)\/([^/]+)$/);
  if (repoMatch && !input.includes(":")) {
    const [, owner, repo] = repoMatch;
    return {
      type: "github",
      repoUrl: `https://github.com/${owner}/${repo}.git`,
    };
  }

  // Full GitHub URL (from skillsh:src/source-parser.ts)
  const ghTree = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?/);
  if (ghTree) {
    const [, owner, repo, ref, subpath] = ghTree;
    return {
      type: "github",
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      ref,
      subpath,
    };
  }

  throw new Error(`Cannot parse skill source: "${input}". Use owner/repo@skill-name or a local path.`);
}

// Cache dir — adapted from skillsh:src/constants.ts pattern
const SKILLS_CACHE_DIR = join(homedir(), ".rlm", "skills-cache");

export class SkillRegistry {
  private loaded: Map<string, LoadedSkill> = new Map();

  /** Load a skill from a source string. Caches cloned repos locally. */
  async add(source: string): Promise<LoadedSkill> {
    const parsed = parseSkillSource(source);
    let skillContent: string;
    let skillName: string;

    if (parsed.type === "local") {
      skillContent = await this.loadFromLocal(parsed.localPath!);
      skillName = parsed.localPath!;
    } else if (parsed.type === "github") {
      skillContent = await this.loadFromGitHub(parsed);
      skillName = source;
    } else {
      throw new Error("Unsupported source type");
    }

    const skill = this.parseSkillMd(skillContent, source);
    this.loaded.set(skill.name, skill);
    return skill;
  }

  /** Load skill content directly from a SKILL.md string (for testing/inline use) */
  addInline(name: string, content: string): LoadedSkill {
    const skill = this.parseSkillMd(content, "inline:" + name);
    this.loaded.set(skill.name, { ...skill, name });
    return this.loaded.get(name)!;
  }

  remove(name: string): boolean {
    return this.loaded.delete(name);
  }

  getLoaded(): LoadedSkill[] {
    return Array.from(this.loaded.values());
  }

  clear(): void {
    this.loaded.clear();
  }

  /** Format all loaded skills for injection into the system prompt */
  formatForPrompt(): string {
    const skills = this.getLoaded();
    if (skills.length === 0) return "";
    
    const sections = skills.map(sk =>
      `### Skill: ${sk.name}\n${sk.description}\n\n${sk.body}`
    );
    
    return `## Active Skills\n\nThe following skills have been loaded into this session. Follow their guidance when relevant:\n\n${sections.join("\n\n---\n\n")}`;
  }

  private parseSkillMd(content: string, source: string): LoadedSkill {
    // Parse YAML frontmatter (ported from skillsh:src/skills.ts parseSkillMd)
    // gray-matter pattern — simple inline parser (no dep needed for basic cases)
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) {
      // No frontmatter — treat whole content as body, derive name from source
      const name = source.split(/[@/]/).pop() || "skill";
      return { name, description: "", body: content, rawContent: content, source };
    }

    const [, frontmatter, body] = fmMatch;
    // Simple YAML key: value parser for name/description
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() || source.split(/[@/]/).pop() || "skill";
    const description = descMatch?.[1]?.trim() || "";

    return { name, description, body: body.trim(), rawContent: content, source };
  }

  private async loadFromLocal(localPath: string): Promise<string> {
    // Check if it's a directory with SKILL.md or a direct SKILL.md file
    const skillMdPath = localPath.endsWith("SKILL.md")
      ? localPath
      : join(localPath, "SKILL.md");
    
    if (!existsSync(skillMdPath)) {
      throw new Error(`No SKILL.md found at: ${skillMdPath}`);
    }
    return readFileSync(skillMdPath, "utf-8");
  }

  private async loadFromGitHub(parsed: ParsedSkillSource): Promise<string> {
    // Shallow clone to cache dir (adapted from skillsh:src/git.ts pattern)
    const repoHash = createHash("sha256")
      .update(parsed.repoUrl!)
      .update(parsed.ref || "HEAD")
      .digest("hex")
      .slice(0, 16);
    const cacheDir = join(SKILLS_CACHE_DIR, repoHash);

    if (!existsSync(cacheDir)) {
      mkdirSync(SKILLS_CACHE_DIR, { recursive: true });
      const ref = parsed.ref || "HEAD";
      const result = Bun.spawnSync([
        "git", "clone", "--depth=1", "--quiet",
        ...(parsed.ref ? ["--branch", parsed.ref] : []),
        parsed.repoUrl!,
        cacheDir,
      ], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to clone ${parsed.repoUrl}: ${new TextDecoder().decode(result.stderr)}`);
      }
    }

    // Find the specific skill (adapted from skillsh:src/skills.ts discoverSkills)
    const searchRoot = parsed.subpath ? join(cacheDir, parsed.subpath) : cacheDir;
    const skills = await this.discoverSkillMds(searchRoot);

    if (skills.length === 0) {
      throw new Error(`No SKILL.md files found in ${parsed.repoUrl}`);
    }

    // Filter by skillFilter if provided (owner/repo@skill-name syntax)
    if (parsed.skillFilter) {
      const match = skills.find(
        (s) => s.name.toLowerCase() === parsed.skillFilter!.toLowerCase() ||
               s.path.includes(parsed.skillFilter!)
      );
      if (!match) {
        const available = skills.map(s => s.name).join(", ");
        throw new Error(
          `Skill "${parsed.skillFilter}" not found. Available: ${available}`
        );
      }
      return match.content;
    }

    // Return first skill if no filter
    return skills[0]!.content;
  }

  private async discoverSkillMds(
    dir: string,
    depth = 0
  ): Promise<Array<{ name: string; path: string; content: string }>> {
    if (depth > 5) return [];
    const SKIP = new Set(["node_modules", ".git", "dist", "build"]);

    try {
      const entries = await import("fs/promises").then(fs =>
        fs.readdir(dir, { withFileTypes: true })
      );
      const results: Array<{ name: string; path: string; content: string }> = [];

      // Check this dir
      const skillMdPath = join(dir, "SKILL.md");
      if (existsSync(skillMdPath)) {
        const content = readFileSync(skillMdPath, "utf-8");
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const name = nameMatch?.[1]?.trim() || dir.split("/").pop() || "skill";
        results.push({ name, path: dir, content });
      }

      // Recurse
      const subdirResults = await Promise.all(
        entries
          .filter(e => e.isDirectory() && !SKIP.has(e.name))
          .map(e => this.discoverSkillMds(join(dir, e.name), depth + 1))
      );
      return [...results, ...subdirResults.flat()];
    } catch {
      return [];
    }
  }
}
```

---

## Priority 3 — HIGH: Skill Injection into `buildActionPrompt()`

**What it does:** Embeds loaded skill markdown directly into the LLM system prompt so the LLM follows skill guidance when generating sandbox code.

**Current `mine:src/prompts/action.ts`** builds the system prompt with `repoIndex`, tool docs, and the user query. Add skills as an additional section:

```typescript
// In src/prompts/action.ts — add skills parameter
export function buildActionPrompt(
  query: string,
  repoIndex: string,
  toolDocs: string,
  options?: {
    skills?: import("../skills/registry.ts").SkillRegistry;
    // ... existing options
  }
): string {
  const skillsSection = options?.skills?.formatForPrompt() ?? "";

  return `You are an expert software engineer analyzing a codebase in a JavaScript REPL (Bun runtime).

## Repository Overview
${repoIndex}

${skillsSection ? skillsSection + "\n\n" : ""}## Your Task
${query}

## Available Tools
${toolDocs}

## Rules
- Write JavaScript code executed in a Bun REPL
- Use await for all async operations
- Call SUBMIT({ sources }) when done
- ${skillsSection ? "Follow the guidance from Active Skills where relevant" : ""}
`;
}
```

**In `src/rlm.ts`** — pass registry to prompt builder:
```typescript
// src/rlm.ts — thread skills through the query loop
class RLM {
  private skillRegistry = new SkillRegistry();  // add this field

  // Expose for CLI injection
  get skills(): SkillRegistry {
    return this.skillRegistry;
  }

  private async buildPrompt(query: string, history: REPLHistory): string {
    const repoIndex = await this.getRepoIndex();
    return buildActionPrompt(query, repoIndex, TOOL_DOCS, {
      skills: this.skillRegistry,  // pass registry here
    });
  }
}
```

---

## Priority 4 — MEDIUM: Well-Known Registry Search (`/skill find`)

**What it does:** Queries the skills.sh well-known registry to discover community skills by keyword. Ported from `skillsh:src/find.ts` and `skillsh:src/providers/wellknown.ts`.

**From `skillsh:src/constants.ts`:**
```typescript
export const SKILLS_REGISTRY_URL = 'https://skills.sh/api/skills';
export const WELL_KNOWN_URL = 'https://skills.sh/.well-known/skills.json';
```

**From `skillsh:src/find.ts`** — the search mechanism:
```typescript
// skillsh:src/find.ts — adapted for rlm-bun
export async function runSkillFind(query: string): Promise<void> {
  const C = COLORS; // reuse rlm-bun's color constants
  console.error(`${C.muted}  Searching skills.sh for: "${query}"${C.reset}`);
  
  try {
    // skillsh fetches from WELL_KNOWN_URL and filters locally
    const response = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error(`Registry returned ${response.status}`);
    
    const results = await response.json() as Array<{
      name: string;
      description: string;
      source: string; // "owner/repo@skill-name"
      url: string;
    }>;

    if (results.length === 0) {
      console.error(`${C.muted}  No skills found for "${query}"${C.reset}`);
      console.error(`${C.muted}  Browse all skills at https://skills.sh${C.reset}`);
      return;
    }

    console.error(`\n${C.accent}  Found ${results.length} skill(s):${C.reset}\n`);
    for (const r of results.slice(0, 10)) {
      console.error(`  ${C.accent}${r.name}${C.reset}`);
      console.error(`  ${C.muted}${r.description}${C.reset}`);
      console.error(`  ${C.muted}Load with: /skill add ${r.source}${C.reset}\n`);
    }
  } catch (e: any) {
    console.error(`${C.muted}  Could not reach skills registry: ${e.message}${C.reset}`);
    console.error(`${C.muted}  Browse manually at https://skills.sh${C.reset}`);
  }
}
```

---

## Priority 5 — MEDIUM: Session Skill Persistence (`.rlm-skills.json`)

**What it does:** Saves loaded skills across sessions — ported from `skillsh:src/local-lock.ts`'s merge-friendly lock format.

**From `skillsh:src/local-lock.ts`** — the key design principles to port:
```typescript
// skillsh:src/local-lock.ts — the lock format (adapt for rlm-bun)
interface RLMSkillLock {
  version: 1;
  skills: Record<string, {
    source: string;    // original input (owner/repo@skill-name)
    loadedAt: string;  // ISO timestamp — omit for merge-friendliness
    hash: string;      // SHA-256 of SKILL.md content
  }>;
}
```

**New file: `src/skills/lock.ts`**
```typescript
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOCK_PATH = join(homedir(), ".rlm", "skills.json");

export interface SkillLock {
  version: 1;
  skills: Record<string, { source: string; hash: string; name: string }>;
}

export function readSkillLock(): SkillLock {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  } catch {
    return { version: 1, skills: {} };
  }
}

export function writeSkillLock(lock: SkillLock): void {
  // Sort keys for merge-friendly diffs (ported from skillsh:src/local-lock.ts)
  const sorted: SkillLock["skills"] = {};
  for (const key of Object.keys(lock.skills).sort()) {
    sorted[key] = lock.skills[key]!;
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ ...lock, skills: sorted }, null, 2));
}

export function hashSkillContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

**Wire into `SkillRegistry`:**
```typescript
// In SkillRegistry.add() — after parsing
const hash = hashSkillContent(skillContent);
const lock = readSkillLock();
lock.skills[skill.name] = { source, hash, name: skill.name };
writeSkillLock(lock);

// In SkillRegistry constructor — auto-reload from lock
constructor(autoReload = true) {
  if (autoReload) {
    const lock = readSkillLock();
    // Silently re-add all previously loaded skills
    for (const [, entry] of Object.entries(lock.skills)) {
      this.add(entry.source).catch(() => {}); // non-fatal
    }
  }
}
```

---

## Priority 6 — MEDIUM: Skill Sandbox Tool (`loadSkill()` in REPL)

**What it does:** Exposes a `loadSkill(source)` tool inside the LLM's sandbox REPL, so the LLM itself can dynamically load skills mid-execution (e.g., as part of a workspace comparison task).

**Adapt `mine:src/sandbox/tools.ts`** to add the tool:
```typescript
// In buildRepoTools() / tool injection — src/sandbox/tools.ts
loadSkill: async (source: string): Promise<{ name: string; description: string; body: string }> => {
  // Called from sandbox via IPC tool_call — executes on HOST side
  const registry = getGlobalSkillRegistry(); // singleton access
  const skill = await registry.add(source);
  // Also inject into next prompt iteration via side-channel
  return { name: skill.name, description: skill.description, body: skill.body };
},
```

**In `mine:src/sandbox/worker.ts`** — expose as global:
```typescript
// In the globalThis setup block
(globalThis as any).loadSkill = async (source: string) => {
  return await tool_call("loadSkill", source);
};
```

**Document in `mine:src/prompts/action.ts`** tool docs:
```
- loadSkill(source)  — Dynamically load a skill into context.
                       source: "owner/repo@skill-name" or local path.
                       Returns { name, description, body }.
                       Example: await loadSkill("vercel-labs/agent-skills@react-best-practices")
```

---

## Priority 7 — LOW: SKILL.md Creation Helper (`/skill init`)

**What it does:** Scaffolds a new SKILL.md for the current project, based on `skillsh:skills/find-skills/SKILL.md` as a template.

```typescript
// In slash command router
case "skill init": {
  const name = arg || "my-skill";
  const template = `---
name: ${name}
description: Describe what this skill does and when to use it.
---

# ${name}

## When to Use This Skill

Describe the contexts where this skill should be applied.

## Guidelines

- Key rule 1
- Key rule 2

## Examples

Show concrete examples of applying this skill.
`;
  const path = join(process.cwd(), "SKILL.md");
  writeFileSync(path, template);
  console.error(`${C.accent}  ✓ Created SKILL.md at ${path}${C.reset}`);
  console.error(`${C.muted}  Load it with: /skill add ./${C.reset}`);
  return null;
}
```

---

## Final Integration Architecture

```
bin/rlm.ts
├── SkillRegistry (new: src/skills/registry.ts)
│   ├── add(source)          ← clone/parse SKILL.md from GitHub or local
│   ├── remove(name)         ← unload from session
│   ├── getLoaded()          ← list all active skills
│   └── formatForPrompt()    ← serialize for LLM system prompt
│
├── SlashCommandRouter (new, inline in bin/rlm.ts)
│   ├── /skill add <source>  ← delegates to SkillRegistry.add()
│   ├── /skill list          ← delegates to SkillRegistry.getLoaded()
│   ├── /skill find [query]  ← queries skills.sh API
│   ├── /skill remove <n>    ← delegates to SkillRegistry.remove()
│   ├── /skill init          ← scaffolds SKILL.md
│   └── /clear               ← resets conversation history
│
├── RLM instance (src/rlm.ts)
│   └── exposes .skills → SkillRegistry
│
└── buildActionPrompt() (src/prompts/action.ts)
    └── injects SkillRegistry.formatForPrompt() into system prompt

src/skills/ (new directory)
├── registry.ts      ← SkillRegistry class, parseSkillSource(), SKILL.md parsing
├── lock.ts          ← Persistent lock file (ported from skillsh:src/local-lock.ts)
└── wellknown.ts     ← Registry search (ported from skillsh:src/find.ts)
```

---

## Implementation Order

| Step | File | Change | Priority |
|---|---|---|---|
| 1 | `src/skills/registry.ts` | Create SkillRegistry class | 🔴 High |
| 2 | `bin/rlm.ts` | Add slash command router around `promptForFollowUp` | 🔴 High |
| 3 | `src/prompts/action.ts` | Add `skills?` param to `buildActionPrompt()` | 🔴 High |
| 4 | `src/rlm.ts` | Expose `.skills` field, thread registry to prompt builder | 🔴 High |
| 5 | `src/skills/lock.ts` | Session persistence (ported from skillsh local-lock) | 🟡 Medium |
| 6 | `src/skills/wellknown.ts` | Registry search for `/skill find` | 🟡 Medium |
| 7 | `src/sandbox/tools.ts` | Add `loadSkill()` as sandbox tool | 🟡 Medium |
| 8 | `src/sandbox/worker.ts` | Expose `loadSkill` global in REPL context | 🟡 Medium |
| 9 | `bin/rlm.ts` | Add `/skill init` scaffolder | 🟢 Low |

## Key Insight: No Hard Dependency on skillsh

`rlm-bun` does **not** need to depend on the `skills` npm package. The relevant logic from skillsh to port is:

1. **SKILL.md parsing** — trivial YAML frontmatter parser (20 lines, no gray-matter dep needed)
2. **Source parsing** (`owner/repo@skill-name` → GitHub URL) — 40 lines of regex
3. **Recursive discovery** (`discoverSkills()`) — async filesystem walk
4. **Lock format** — merge-friendly JSON structure

All of these are small enough to inline directly in `src/skills/registry.ts` without pulling in skillsh's full dependency tree (gray-matter, chalk, etc.).