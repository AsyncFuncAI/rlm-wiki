import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KNOWLEDGE_PROFILE_MODES = ["basic", "compound"] as const;
export type KnowledgeProfileMode = typeof KNOWLEDGE_PROFILE_MODES[number];

export interface KnowledgeProfileSource {
  id: string;
  label: string;
  description?: string;
  paths?: string[];
}

export interface KnowledgeProfileProvenance {
  kind: string;
  label?: string;
  sourceRepo?: string;
  sourceUrl?: string;
  sourceCommit?: string;
  sourcePath?: string;
  bundledPath?: string;
  verifiedBy?: string;
  fallback?: boolean;
}

export interface KnowledgeProfileCapability {
  id: string;
  command: string;
  label: string;
  shortLabel?: string;
  description?: string;
  surfaces?: string[];
  intent?: string;
  outputKind?: string;
  promptContract?: string;
  authoredDescription?: string;
  provenance?: KnowledgeProfileProvenance;
  wikiDefault?: boolean;
  passiveContext?: boolean;
}

export interface KnowledgeProfile {
  mode: KnowledgeProfileMode;
  packId: string;
  packName?: string;
  author?: string;
  provenance?: KnowledgeProfileProvenance;
  sources: KnowledgeProfileSource[];
  capabilities: KnowledgeProfileCapability[];
  activeCapability: KnowledgeProfileCapability | null;
  activeCapabilities: KnowledgeProfileCapability[];
  hints: string[];
}

const COMPOUND_DEFAULT_SOURCES: KnowledgeProfileSource[] = [
  { id: "generated-wiki", label: "Generated wiki context" },
  { id: "solved-problems", label: "Solved-problem notes", paths: ["docs/solutions/**"] },
  { id: "strategy", label: "Strategy anchor", paths: ["STRATEGY.md"] },
] as const;

const COMPOUND_DEFAULT_PROVENANCE: KnowledgeProfileProvenance = {
  kind: "built-in-adapter",
  label: "Built-in desktop adapter fallback",
  fallback: true,
};

const LOCAL_SKILL_ROOTS = [
  join(homedir(), ".codex", "skills"),
  join(homedir(), ".agents", "skills"),
];

const COMPOUND_DEFAULT_CAPABILITIES: KnowledgeProfileCapability[] = [
  {
    id: "ce-ideate",
    command: "/ce-ideate",
    label: "Ideas",
    surfaces: ["ask"],
    intent: "ideate",
    outputKind: "ranked ideas",
    promptContract: "Ground in repo evidence before ideating. Generate multiple directions from distinct frames, critique them, show only the strongest survivors, and include basis, risk, and next validation for each.",
  },
  {
    id: "ce-plan",
    command: "/ce-plan",
    label: "Plan",
    surfaces: ["ask", "wiki"],
    intent: "plan",
    outputKind: "scoped plan",
    promptContract: "Produce a compact implementation plan with scope, non-goals, affected files, decisions, risks, and concrete test scenarios. Do not write a plan file or execute the work.",
    wikiDefault: true,
  },
  {
    id: "ce-debug",
    command: "/ce-debug",
    label: "Root Cause",
    surfaces: ["ask"],
    intent: "debug",
    outputKind: "diagnosis",
    promptContract: "Stay diagnosis-only. Build trigger -> code path -> state transition -> symptom, mark uncertain links, cite evidence, and suggest confirmation checks or tests. Do not edit or fix files.",
  },
  {
    id: "ce-doc-review",
    command: "/ce-doc-review",
    label: "QA Review",
    surfaces: ["wiki"],
    intent: "doc-review",
    outputKind: "wiki QA",
    promptContract: "Run a source-anchored wiki quality review for unsupported claims, weak citations, duplicate pages, contradictions, and overloaded page scope. Feed concrete findings back as repair guidance.",
    wikiDefault: true,
  },
  {
    id: "ce-compound",
    command: "/ce-compound",
    label: "Page Shape",
    surfaces: ["wiki"],
    intent: "compound",
    outputKind: "wiki page shape",
    promptContract: "Borrow ce-compound read-only structure. Classify pages as concept, architecture pattern, workflow, integration, failure mode, or developer convention. Do not write docs/solutions or claim durable memory was created.",
    wikiDefault: true,
  },
  {
    id: "ce-distill",
    command: "/ce-distill",
    label: "Distill",
    surfaces: ["ask"],
    intent: "distill",
    outputKind: "knowledge cards",
    promptContract: "Distill a finished conversation into durable knowledge cards clustered by intent, dropping dead-end turns. Classify each card as concept, architecture pattern, workflow, integration, failure mode, or developer convention. Reconcile against existing cards with corroboration over recency over authority; a lone unverified contradiction lands provisional, never overriding ground truth.",
  },
] as const;

function cleanText(value: unknown, fallback = "", maxChars = 160): string {
  return String(value || fallback).trim().slice(0, maxChars);
}

function normalizeSource(value: unknown): KnowledgeProfileSource | null {
  if (typeof value === "string") {
    const id = cleanText(value);
    return id ? { id, label: id } : null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = cleanText(row.id || row.label);
  if (!id) return null;
  const rawPaths = Array.isArray(row.paths) ? row.paths : [];
  const paths = rawPaths
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 8);
  return {
    id,
    label: cleanText(row.label, id),
    description: cleanText(row.description),
    paths: paths.length ? paths : undefined,
  };
}

function normalizeProvenance(value: unknown): KnowledgeProfileProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const rawKind = cleanText(row.kind);
  const legacyBundledKind = ["part", "ner", "bundled"].join("-");
  const kind = rawKind === legacyBundledKind ? "bundled-snapshot" : rawKind;
  if (!kind) return undefined;
  return {
    kind,
    label: cleanText(row.label),
    sourceRepo: cleanText(row.sourceRepo),
    sourceUrl: cleanText(row.sourceUrl),
    sourceCommit: cleanText(row.sourceCommit),
    sourcePath: cleanText(row.sourcePath),
    bundledPath: cleanText(row.bundledPath),
    verifiedBy: cleanText(row.verifiedBy),
    fallback: row.fallback === true,
  };
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function localSkillPath(id: string): string {
  if (!id.startsWith("ce-")) return "";
  const candidates = LOCAL_SKILL_ROOTS.flatMap((root) => [
    join(root, id, "SKILL.md"),
    join(root, "compound-engineering", "skills", id, "SKILL.md"),
    join(root, "compound-engineering-plugin", "plugins", "compound-engineering", "skills", id, "SKILL.md"),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function withInstalledSkillProvenance(capability: KnowledgeProfileCapability): KnowledgeProfileCapability;
function withInstalledSkillProvenance(capability: KnowledgeProfileCapability | null): KnowledgeProfileCapability | null;
function withInstalledSkillProvenance(capability: KnowledgeProfileCapability | null): KnowledgeProfileCapability | null {
  if (!capability) return null;
  const path = localSkillPath(capability.id);
  if (!path) return capability;
  return {
    ...capability,
    provenance: {
      kind: "installed-local",
      label: "Installed local SKILL.md",
      sourcePath: displayPath(path),
      verifiedBy: "Local user skill installation",
    },
  };
}

function normalizeCapability(value: unknown): KnowledgeProfileCapability | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = cleanText(row.id || row.command);
  if (!id) return null;
  const rawSurfaces = Array.isArray(row.surfaces) ? row.surfaces : [];
  const surfaces = rawSurfaces.map((item) => cleanText(item)).filter(Boolean).slice(0, 4);
  return {
    id,
    command: cleanText(row.command, `/${id}`),
    label: cleanText(row.label, id),
    shortLabel: cleanText(row.shortLabel),
    description: cleanText(row.description),
    surfaces: surfaces.length ? surfaces : undefined,
    intent: cleanText(row.intent),
    outputKind: cleanText(row.outputKind),
    promptContract: cleanText(row.promptContract, "", 600),
    authoredDescription: cleanText(row.authoredDescription, "", 600),
    provenance: normalizeProvenance(row.provenance),
    wikiDefault: row.wikiDefault === true,
    passiveContext: row.passiveContext === true,
  };
}

function normalizeCapabilityList(value: unknown): KnowledgeProfileCapability[] {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw
    .map(normalizeCapability)
    .filter((item): item is KnowledgeProfileCapability => !!item)
    .slice(0, 12);
  const list = normalized.length ? normalized : COMPOUND_DEFAULT_CAPABILITIES.map((item) => ({ ...item, surfaces: item.surfaces ? [...item.surfaces] : undefined }));
  return list.map((item) => withInstalledSkillProvenance(item));
}

function capabilityById(capabilities: KnowledgeProfileCapability[], value: unknown): KnowledgeProfileCapability | null {
  const id = cleanText(value).replace(/^\//, "").toLowerCase();
  if (!id) return null;
  return capabilities.find((item) => {
    const itemId = item.id.toLowerCase();
    const command = item.command.replace(/^\//, "").toLowerCase();
    return id === itemId || id === command || id === String(item.intent || "").toLowerCase();
  }) || null;
}

function normalizeActiveCapabilities(
  value: unknown,
  capabilities: KnowledgeProfileCapability[],
): KnowledgeProfileCapability[] {
  const raw = Array.isArray(value) ? value : [];
  const active = raw
    .map((item) => typeof item === "string" ? capabilityById(capabilities, item) : normalizeCapability(item))
    .filter((item): item is KnowledgeProfileCapability => !!item)
    .map((item) => withInstalledSkillProvenance(item))
    .slice(0, 6);
  return active;
}

export function normalizeKnowledgeProfile(value: unknown): KnowledgeProfile {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = row.mode === "basic" ? "basic" : row.mode === "compound" ? "compound" : "basic";
  const rawSources = Array.isArray(row.sources) ? row.sources : [];
  const sources = rawSources
    .map(normalizeSource)
    .filter((item): item is KnowledgeProfileSource => !!item)
    .slice(0, 12);
  const rawHints = Array.isArray(row.hints) ? row.hints : Array.isArray(row.promptHints) ? row.promptHints : [];
  const hints = rawHints
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 8);
  const capabilities = mode === "compound" ? normalizeCapabilityList(row.capabilities) : [];
  const activeCapability =
    mode === "compound"
      ? withInstalledSkillProvenance(normalizeCapability(row.activeCapability) || capabilityById(capabilities, row.activeCapabilityId))
      : null;
  const activeCapabilities =
    mode === "compound"
      ? normalizeActiveCapabilities(row.activeCapabilities, capabilities)
      : [];
  return {
    mode,
    packId: cleanText(row.packId, mode === "compound" ? "every-compound-engineering" : "repo-only"),
    packName: cleanText(row.packName),
    author: cleanText(row.author),
    provenance: normalizeProvenance(row.provenance) || (mode === "compound" ? COMPOUND_DEFAULT_PROVENANCE : undefined),
    sources: sources.length
      ? sources
      : mode === "compound"
        ? COMPOUND_DEFAULT_SOURCES.map((item) => ({ ...item, paths: item.paths ? [...item.paths] : undefined }))
        : [{ id: "repository", label: "Repository code" }],
    capabilities,
    activeCapability,
    activeCapabilities,
    hints,
  };
}

function sourceLine(source: KnowledgeProfileSource): string {
  const detail = source.description ? `: ${source.description}` : "";
  const paths = source.paths?.length ? ` (${source.paths.join(", ")})` : "";
  return `- ${source.label}${detail}${paths}`;
}

function provenanceSummary(provenance?: KnowledgeProfileProvenance): string {
  if (!provenance) return "";
  const label = provenance.label || provenance.kind;
  const commit = provenance.sourceCommit ? ` @ ${provenance.sourceCommit.slice(0, 12)}` : "";
  const repo = provenance.sourceRepo ? ` from ${provenance.sourceRepo}` : "";
  const path = provenance.sourcePath ? ` (${provenance.sourcePath})` : "";
  return `${label}${repo}${commit}${path}`;
}

function capabilityLine(capability: KnowledgeProfileCapability): string {
  const output = capability.outputKind ? ` -> ${capability.outputKind}` : "";
  const detail = capability.description ? `: ${capability.description}` : "";
  const source = provenanceSummary(capability.provenance);
  const authored = capability.authoredDescription ? ` Authored description: ${capability.authoredDescription}` : "";
  return `- ${capability.command} (${capability.label})${output}${detail}${source ? ` Source: ${source}.` : ""}${authored}`;
}

function activeCapabilityBlock(profile: KnowledgeProfile, surface: "ask" | "wiki"): string {
  const active = surface === "wiki"
    ? profile.activeCapabilities
    : profile.activeCapability
      ? [profile.activeCapability]
      : profile.activeCapabilities;
  if (!active.length) return "";
  const title = surface === "wiki" ? "Active wiki recipe:" : "Selected CE lens:";
  return `
${title}
${active.map((capability) => {
  const contract = capability.promptContract ? ` ${capability.promptContract}` : "";
  const source = provenanceSummary(capability.provenance || profile.provenance);
  const authored = capability.authoredDescription ? ` Authored skill description: ${capability.authoredDescription}` : "";
  return `- ${capability.command} (${capability.label}):${contract}${authored}${source ? ` Source: ${source}.` : ""}`;
}).join("\n")}

Treat slash commands as routing metadata. Do not repeat the command back unless the user asks what ran.`;
}

export function knowledgeProfilePrompt(value: unknown, surface: "ask" | "wiki"): string {
  const profile = normalizeKnowledgeProfile(value);
  if (profile.mode !== "compound") return "";

  const surfaceNoun = surface === "wiki" ? "wiki" : "answer";
  const packLabel = profile.packName
    ? `${profile.packName}${profile.author ? ` by ${profile.author}` : ""}`
    : profile.packId;
  const provenance = profile.provenance
    ? `
Skill-pack provenance:
- ${provenanceSummary(profile.provenance)}
- Resolution order: installed local SKILL.md when available, bundled SKILL.md snapshot next, built-in adapter only as fallback.`
    : "";
  const compoundSpecific = profile.packId === "every-compound-engineering"
    ? `
For the Every Compound Engineering pack, adapt bundled skill guidance into Ask/Wiki synthesis only.
Ask exposes Ideas, Root Cause, and Plan. Wiki uses Blueprint, Page Shape, and QA Review internally.
Presentation rule: lead with plain product workflows before naming internal slash commands or implementation details.`
    : "";
  const hints = profile.hints.length
    ? `
Pack guidance:
${profile.hints.map((hint) => `- ${hint}`).join("\n")}`
    : "";
  const capabilities = profile.capabilities.length
    ? `
Curated Ask/Wiki capabilities:
${profile.capabilities
  .filter((capability) => !capability.surfaces?.length || capability.surfaces.includes(surface))
  .map(capabilityLine)
  .join("\n")}

Do not use workflow/action skills such as session-history search, browser testing, commits, worktrees, setup, release notes, or PR feedback inside Ask/Wiki. Those belong to execution surfaces, not synthesis.`
    : "";
  const active = activeCapabilityBlock(profile, surface);
  return `## Knowledge Profile: ${packLabel}
The user selected a modular knowledge profile for this run. Treat it as portable guidance, not a vendor-specific dependency or proof that every source is installed.

Requested source classes:
${profile.sources.map(sourceLine).join("\n")}${provenance}${capabilities}${active}${compoundSpecific}${hints}

Rules:
- Repository code remains the source of truth for implementation claims.
- Use the selected knowledge profile to orient the investigation, find prior decisions, and surface reusable context.
- Be explicit if the run used a bundled skill snapshot or fallback adapter; do not imply an installed local skill was executed unless the runtime proves it.
- If a source class is not available, do not claim that it was used.
- Cite concrete files or retrieved artifacts in the final ${surfaceNoun} when they influence the result.
- Keep the architecture BYOC/BYOK friendly: do not assume a particular model provider, hosted service, or proprietary connector.
- When recommending a Grok-Wiki integration or UI flow, explicitly state how the design stays provider-neutral and portable across file, repository, or catalog skill sources.`;
}
