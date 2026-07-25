// SkillRegistry — central runtime registry for loaded skills in rlm-bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillRecord, ParsedSkillSource } from "./types.ts";
import { SKILLS_DIR_NAME } from "./types.ts";
import { parseSkillSource, skillSourceToCloneUrl } from "./parser.ts";
import { discoverSkills } from "./discovery.ts";

/** On-disk manifest stored in .rlm-bun/skills.json */
interface SkillManifest {
  version: 1;
  /** Ordered list of source strings to re-load on next startup */
  sources: string[];
}

export class SkillRegistry {
  private skills: Map<string, SkillRecord> = new Map();
  /** Git clone cache: ~/.rlm/skills-cache/<owner>__<repo> */
  private cacheDir: string = join(homedir(), ".rlm", "skills-cache");
  /** Project-local manifest dir — resolved from CWD at construction time */
  private manifestDir: string = resolve(process.cwd(), SKILLS_DIR_NAME);
  /** Ordered source strings (preserves add order for re-loading) */
  private sources: string[] = [];

  /**
   * Load skills from a source string.
   * Supported: owner/repo@skill, owner/repo, owner/repo/subpath, full GitHub URL, ./local/path
   */
  async add(source: string): Promise<SkillRecord[]> {
    const parsed = parseSkillSource(source);
    let discovered: SkillRecord[] = [];

    if (parsed.type === "github") {
      const clonePath = this.getCachePath(parsed);
      await this.ensureCloned(parsed, clonePath);
      discovered = await discoverSkills(clonePath, parsed.subpath);
      if (parsed.skillFilter) {
        const filter = parsed.skillFilter.toLowerCase();
        discovered = discovered.filter(
          (s) =>
            s.name.toLowerCase().includes(filter) ||
            s.name.toLowerCase().replace(/[_\s]+/g, "-").includes(filter)
        );
      }
    } else if (parsed.type === "local") {
      discovered = await discoverSkills(parsed.localPath);
    } else {
      throw new Error(
        "Direct URL skills not yet supported — use owner/repo@skill or a local path"
      );
    }

    for (const skill of discovered) {
      this.skills.set(skill.name, { ...skill, source });
    }

    // Track source order (deduplicated)
    if (!this.sources.includes(source)) {
      this.sources.push(source);
    }

    return discovered;
  }

  remove(name: string): boolean {
    const existed = this.skills.delete(name);
    if (existed) {
      // Remove from sources only if no remaining skill references it
      const remaining = Array.from(this.skills.values()).map((s) => s.source);
      this.sources = this.sources.filter((src) => remaining.includes(src));
    }
    return existed;
  }

  clear(): void {
    this.skills.clear();
    this.sources = [];
  }

  list(): SkillRecord[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillRecord | undefined {
    return this.skills.get(name);
  }

  getLoaded(): SkillRecord[] {
    return this.list();
  }

  /**
   * Format all loaded skills for injection into an LLM system prompt.
   * Returns empty string if no skills loaded.
   */
  formatForPrompt(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const sections = skills.map(
      (s) => "### " + s.name + "\n" + s.description + "\n\n" + s.body.trim()
    );
    return "## Loaded Skills\n\nThe following skills are active and should guide your approach:\n\n" + sections.join("\n\n---\n\n") + "\n\n";
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Save the current skill sources to .rlm-bun/skills.json in the working directory.
   * This allows skills to persist across sessions.
   */
  saveManifest(): void {
    try {
      mkdirSync(this.manifestDir, { recursive: true });
      const manifest: SkillManifest = { version: 1, sources: this.sources };
      writeFileSync(
        join(this.manifestDir, "skills.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8"
      );
    } catch {
      // Non-fatal — manifest save failure should not crash the session
    }
  }

  /**
   * Read the manifest from .rlm-bun/skills.json without loading skills.
   * Returns null if no manifest exists.
   */
  readManifest(): SkillManifest | null {
    const manifestPath = join(this.manifestDir, "skills.json");
    if (!existsSync(manifestPath)) return null;
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as SkillManifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.sources)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Restore skills from .rlm-bun/skills.json.
   * Returns the list of source strings that were restored.
   * Silently skips sources that fail to load (e.g. network unavailable).
   */
  async restoreFromManifest(): Promise<string[]> {
    const manifest = this.readManifest();
    if (!manifest || manifest.sources.length === 0) return [];
    const restored: string[] = [];
    for (const source of manifest.sources) {
      try {
        await this.add(source);
        restored.push(source);
      } catch {
        // Skip failed sources silently — avoids breaking startup
      }
    }
    return restored;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private getCachePath(parsed: ParsedSkillSource & { type: "github" }): string {
    const slug = parsed.owner + "__" + parsed.repo + (parsed.ref ? "__" + parsed.ref : "");
    return join(this.cacheDir, slug);
  }

  private async ensureCloned(
    parsed: ParsedSkillSource & { type: "github" },
    clonePath: string
  ): Promise<void> {
    const cloneUrl = skillSourceToCloneUrl(parsed)!;
    if (existsSync(clonePath)) {
      try {
        execSync("git pull --ff-only --quiet", { cwd: clonePath, timeout: 15000, stdio: "pipe" });
      } catch {
        // offline — use cached version
      }
      return;
    }
    mkdirSync(this.cacheDir, { recursive: true });
    const cloneArgs = ["git", "clone", "--depth=1", "--quiet"];
    if (parsed.ref) cloneArgs.push("--branch", parsed.ref);
    cloneArgs.push(cloneUrl, clonePath);
    try {
      execSync(cloneArgs.join(" "), { timeout: 60000, stdio: "pipe" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: unknown }).stderr)
          : "";
      throw new Error("Failed to clone " + cloneUrl + ": " + (stderr || msg));
    }
  }
}
