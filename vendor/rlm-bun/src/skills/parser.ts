// Skill source parser for rlm-bun — adapted from skillsh source-parser

import { isAbsolute, resolve } from "node:path";
import type { ParsedSkillSource } from "./types.ts";

/**
 * Parse a user-provided skill source string into a structured ParsedSkillSource.
 */
export function parseSkillSource(input: string): ParsedSkillSource {
  const s = input.trim();

  // 1. Local path detection
  if (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    isAbsolute(s) ||
    /^[A-Za-z]:[/\\]/.test(s)
  ) {
    return { type: "local", localPath: resolve(s) };
  }

  // 2. Full GitHub URL with optional /tree/ref/subpath
  // Using new RegExp to avoid regex literal parsing issues with slashes
  const ghTreePat = new RegExp(
    "^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([^/]+)\\/([^/]+)\\/tree\\/([^/]+)(?:\\/(.+))?$"
  );
  const ghFullTree = s.match(ghTreePat);
  if (ghFullTree) {
    const [, owner, repo, ref, subpath] = ghFullTree;
    return {
      type: "github",
      owner: owner!,
      repo: repo!.replace(/\.git$/, ""),
      ref,
      subpath: subpath || undefined,
    };
  }

  // 3. Full GitHub URL (no tree)
  const ghBasePat = new RegExp(
    "^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([^/]+)\\/([^/]+?)(?:\\.git)?(?:\\/.*)?$"
  );
  const ghFull = s.match(ghBasePat);
  if (ghFull) {
    const [, owner, repo] = ghFull;
    return { type: "github", owner: owner!, repo: repo! };
  }

  // 4–7. GitHub shorthand forms (no colon, no leading dot/slash)
  if (!s.includes(":") && !s.startsWith(".") && !s.startsWith("/")) {

    // 4. owner/repo/tree/ref/subpath
    const shorthandTree = s.match(/^([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
    if (shorthandTree) {
      const [, owner, repo, ref, subpath] = shorthandTree;
      return { type: "github", owner: owner!, repo: repo!, ref, subpath: subpath || undefined };
    }

    // 5. owner/repo@skill-name
    const atMatch = s.match(/^([^/]+)\/([^/@]+)@(.+)$/);
    if (atMatch) {
      const [, owner, repo, skillFilter] = atMatch;
      return { type: "github", owner: owner!, repo: repo!, skillFilter: skillFilter! };
    }

    // 6. owner/repo/subpath
    const subpathMatch = s.match(/^([^/]+)\/([^/]+)\/(.+)$/);
    if (subpathMatch) {
      const [, owner, repo, subpath] = subpathMatch;
      return { type: "github", owner: owner!, repo: repo!, subpath: subpath! };
    }

    // 7. owner/repo
    const simpleMatch = s.match(/^([^/]+)\/([^/]+)$/);
    if (simpleMatch) {
      const [, owner, repo] = simpleMatch;
      return { type: "github", owner: owner!, repo: repo! };
    }
  }

  // 8. Arbitrary HTTPS URL
  if (s.startsWith("https://") || s.startsWith("http://")) {
    return { type: "url", url: s };
  }

  // 9. Fallback: treat as local path
  return { type: "local", localPath: resolve(s) };
}

/**
 * Returns the git clone URL for a GitHub parsed source.
 * Returns null for local and url types.
 */
export function skillSourceToCloneUrl(parsed: ParsedSkillSource): string | null {
  if (parsed.type === "github") {
    return "https://github.com/" + parsed.owner + "/" + parsed.repo + ".git";
  }
  return null;
}
