// Skill system types for rlm-bun — adapted from skillsh (github.com/vercel-labs/skills)

export const SKILLS_DIR_NAME = ".rlm-bun";

export interface SkillRecord {
  /** Display name from SKILL.md frontmatter */
  name: string;
  /** Short description from SKILL.md frontmatter */
  description: string;
  /** Full markdown body (after frontmatter) — injected into LLM system prompt */
  body: string;
  /** Original source string provided by user (e.g. "vercel-labs/agent-skills@react") */
  source: string;
  /** When this skill was loaded into the registry */
  loadedAt: Date;
  /** Additional metadata from SKILL.md frontmatter */
  metadata?: Record<string, unknown>;
}

export type ParsedSkillSource =
  | {
      type: "github";
      owner: string;
      repo: string;
      ref?: string;
      subpath?: string;
      /** Filter to a specific skill by name (from owner/repo@skill-name syntax) */
      skillFilter?: string;
    }
  | {
      type: "local";
      localPath: string;
    }
  | {
      type: "url";
      url: string;
    };

export interface SkillRegistryState {
  skills: Map<string, SkillRecord>;
}
