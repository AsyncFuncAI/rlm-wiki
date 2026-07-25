/**
 * Meta-prompter for workspace mode.
 *
 * Given a user's goal (e.g., "compare", "steal", "understand") and the repo IDs,
 * generates a detailed system-level query that steers the LLM agent effectively.
 */

interface GoalDefinition {
  label: string;
  template: (repos: string[], userQuery?: string) => string;
}

const GOALS: Record<string, GoalDefinition> = {
    compare: {
        label: "Cross-repo comparison",
        template: (repos: string[], userQuery?: string) => `You are comparing ${repos.length} codebases in a workspace: ${repos.join(", ")}.

Your task: ${userQuery || `Compare these repositories thoroughly.`}

Strategy:
1. First build a map of BOTH repositories with search/rg/glob/listFiles/inspect. Read manifests/READMEs plus the load-bearing entry-point or boundary files needed to prove architecture; avoid broad implementation sweeps in the first step.
2. Explore iteratively: search/inspect first, read one or two matching components, form a hypothesis, then expand only where evidence points.
3. Use llmQueryBatched only for independent focused snippets or small modules; prompts must contain actual content, not paths or arbitrary character slices.
4. Produce a feature comparison matrix with dimensions like: architecture, tool system, LLM integration, prompt design, agent loop, output formats, extensibility.
5. For each dimension, cite specific files from each repo as evidence.
6. Highlight key architectural differences and trade-offs.

Critical: avoid front-loaded megareads and fixed offsets like \`substring(0, 3000)\`. Navigate by symbols, imports, exports, rg matches, and line windows around the relevant code.

Output a structured comparison with evidence-backed claims. Cite all files with repoId:path format.`,
    },

    steal: {
        label: "Steal/port features",
        template: (repos: string[], userQuery?: string) => `You are analyzing ${repos.length} codebases to steal and port features.

Repos: ${repos.join(", ")}

Your task: ${userQuery || `Find features in the first repo that the second repo lacks, and produce a plan to port them.`}

Strategy:
1. First build a map of both repositories with search/rg/glob/listFiles/inspect. Read manifests/READMEs plus the load-bearing entry-point or boundary files needed to prove feature ownership; avoid broad implementation sweeps in the first step.
2. Identify features unique to each repo (feature gap matrix).
3. Verify gaps iteratively: search both repos, read the canonical implementation or closest analog, then expand only if the evidence is ambiguous.
4. For features worth stealing, find the canonical implementation (entry points, core logic, tests).
5. For each stealable feature, use \`llmQuery\` to produce:
   - What it does and why it's valuable
   - Key source files with code snippets
   - How to adapt it for the target repo's architecture
   - Priority ranking (high/medium/low)
6. Output a prioritized steal plan with concrete code references.

Use \`llmQueryBatched\` only for independent focused snippets or small modules. Avoid fixed character slices; extract code by symbols, imports, exports, or rg/line matches.

Cite all files with repoId:path format. Include actual code snippets for high-priority items.`,
    },

    understand: {
        label: "Cross-repo understanding",
        template: (repos: string[], userQuery?: string) => `You are analyzing ${repos.length} codebases to build cross-repo understanding.

Repos: ${repos.join(", ")}

Your task: ${userQuery || `How do these repositories relate? What patterns do they share? How do they differ in approach?`}

Strategy:
1. First build a map of each repository's architecture, entry points, and core patterns with search/rg/glob/listFiles/inspect, then read the load-bearing entry-point or boundary files needed to verify the relationships.
2. Search for shared concepts across all repos (searchAll).
3. For each shared concept, read the implementations in each repo.
4. Use llmQueryBatched only when each repo's relevant implementation has been narrowed to focused snippets or small modules.
5. Synthesize from summaries: what's the same, what's different, and *why*.
6. Identify architectural lessons — what does each repo do better?

Output a deep analysis with specific file citations in repoId:path format.`,
    },

    bridge: {
        label: "Feature gap bridging",
        template: (repos: string[], userQuery?: string) => `You are bridging feature gaps between ${repos.length} codebases.

Repos: ${repos.join(", ")}

Your task: ${userQuery || `Produce a gap matrix and bridge plan to port missing features between these repos.`}

Strategy:
1. First build a map of both repos with search/rg/glob/listFiles/inspect. Read manifests/READMEs plus the load-bearing entry-point or boundary files needed to prove the gap matrix; avoid broad implementation sweeps in the first step.
2. Build a complete feature gap matrix: [feature, repo A status, repo B status, evidence files].
3. Verify each gap with search and targeted reads; batch only independent focused evidence snippets.
4. For each confirmed gap, identify the canonical implementation in the source repo.
5. Find the closest architectural analog in the target repo (where it should live).
6. Use \`llmQuery\` to draft concrete bridge steps for each gap.
7. Produce a structured bridge plan with:
   - Gap matrix (what's missing where)
   - Concrete implementation steps per feature
   - File paths for both source and target
   - Risk assessment and dependencies

Critical: the sub-LLM is not path-aware, so prompts must contain actual content. Do not feed it arbitrary character windows; use symbol-level or line-window evidence.

Include gapMatrix and bridgePlan in your SUBMIT payload alongside answer and sources.`,
    },

    audit: {
        label: "Cross-repo audit",
        template: (repos: string[], userQuery?: string) => `You are auditing ${repos.length} codebases for patterns, issues, and best practices.

Repos: ${repos.join(", ")}

Your task: ${userQuery || `Audit these repos for shared patterns, common issues, and best practices.`}

Strategy:
1. Search across all repos for common patterns (error handling, logging, auth, config, testing).
2. Analyze patterns iteratively: use search results to choose focused snippets, then use llmQueryBatched only for independent checks.
3. Compare how each repo handles these concerns.
4. Identify best practices from each repo.
5. Flag anti-patterns, inconsistencies, or potential issues.
6. Produce a structured audit report with specific file citations.

Cite all files with repoId:path format.`,
    },
};

/**
 * Generate a workspace query from a goal keyword and optional user query.
 */
export function buildWorkspaceQuery(goal: string, repoIds: string[], userQuery?: string): string {
    const goalDef = GOALS[goal];
    if (!goalDef) {
        const available = Object.keys(GOALS).join(", ");
        throw new Error(`Unknown goal "${goal}". Available: ${available}`);
    }
    return goalDef.template(repoIds, userQuery);
}

export interface GoalInfo {
  id: string;
  label: string;
}

/** List available goals with labels. */
export function listGoals(): GoalInfo[] {
    return Object.entries(GOALS).map(([id, def]) => ({
        id,
        label: def.label,
    }));
}
