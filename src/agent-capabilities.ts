import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { Composio } from "@composio/core";
import type { ToolRouterCreateSessionConfig, ToolRouterMCPServerConfig } from "@composio/core";
import { connectMCPServer, loadMCPConfig, parseSkillSource, SkillRegistry } from "./jcode-runtime.ts";
import type { MCPConfig as JCodeMCPConfig, MCPServerConfig, MCPToolInfo, ParsedSkillSource, JCodeAgent, SkillRecord } from "./jcode-runtime.ts";

export interface AgentCapabilityOptions {
  /**
   * Optional explicit skill sources for programmatic callers.
   * The web server intentionally does not accept these from arbitrary requests.
   */
  skillSources?: string[];
  onStatus?: (message: string) => void;
}

export interface CapabilityProfileOptions {
  defaultUserId?: string;
}

export interface StoredMCPServer {
  id: string;
  name: string;
  url: string;
  type: "http" | "sse";
  tokenEnv?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSkillSource {
  id: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredComposioToolkit {
  slug: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredComposioConfig {
  enabled: boolean;
  userId: string;
  toolkits: StoredComposioToolkit[];
}

export interface CapabilitySettings {
  version: 1;
  composio: StoredComposioConfig;
  mcpServers: StoredMCPServer[];
  skills: StoredSkillSource[];
}

export interface CapabilitySnapshot {
  mcpServers: Array<{
    id: string;
    name: string;
    url: string;
    type: "http" | "sse";
    enabled: boolean;
    auth: "none" | "bearer-env";
  }>;
  skills: Array<{
    id: string;
    source: string;
    enabled: boolean;
  }>;
  composio: {
    enabled: boolean;
    configured: boolean;
    userId: string;
    toolkits: Array<{
      slug: string;
      enabled: boolean;
    }>;
    sessionId?: string;
    error?: string;
    mcp?: {
      name: string;
      type: "http" | "sse";
      enabled: boolean;
      auth: "composio-session";
    };
  };
}

export interface GithubSkillCandidate {
  name: string;
  description: string;
  source: string;
  installSource: string;
  installed: boolean;
}

export interface GithubSkillInspection {
  source: string;
  skills: GithubSkillCandidate[];
}

export interface CapabilityRuntime {
  mcpConfig: JCodeMCPConfig;
  skillSources: string[];
  snapshot: CapabilitySnapshot;
}

export interface ComposioCatalogToolkit {
  slug: string;
  name: string;
  description: string;
  logo?: string;
  appUrl?: string;
  categories: Array<{ id: string; name: string }>;
  toolsCount: number;
  triggersCount: number;
  authSchemes: string[];
  composioManagedAuthSchemes: string[];
  noAuth: boolean;
  selected: boolean;
  enabled: boolean;
}

export interface ComposioCatalogResult {
  items: ComposioCatalogToolkit[];
  nextCursor?: string;
  totalPages: number;
  currentPage: number;
  totalItems: number;
}

export interface ComposioConnectedApp {
  slug: string;
  name: string;
  logo?: string;
  isNoAuth: boolean;
  isActive: boolean;
  status?: string;
  connectedAccountId?: string;
}

interface SkillHydrationResult {
  names: string[];
  sources: string[];
  promptText: string;
  errors: string[];
}

let manifestSkillsCache: {
  key: string;
  value: Promise<SkillHydrationResult>;
} | null = null;

export async function applyAgentCapabilities(
  agent: JCodeAgent,
  opts: AgentCapabilityOptions = {},
): Promise<SkillHydrationResult> {
  const skills = opts.skillSources
    ? await loadExplicitSkills(opts.skillSources)
    : await loadManifestSkills();

  if (skills.promptText) {
    agent.setSkillsPromptText(skills.promptText);
  }

  if (skills.names.length) {
    opts.onStatus?.(`Skills active: ${skills.names.join(", ")}`);
  }
  for (const error of skills.errors) {
    opts.onStatus?.(`Skill load skipped: ${error}`);
  }

  return skills;
}

export function loadCapabilitySettings(root: string, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const path = capabilityPath(root);
  if (!existsSync(path)) return emptyCapabilitySettings(opts.defaultUserId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CapabilitySettings>;
    return normalizeCapabilitySettings(parsed, opts.defaultUserId);
  } catch {
    return emptyCapabilitySettings(opts.defaultUserId);
  }
}

export function saveCapabilitySettings(root: string, settings: CapabilitySettings, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const normalized = normalizeCapabilitySettings(settings, opts.defaultUserId);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(capabilityPath(root), JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  return normalized;
}

export async function capabilityRuntime(root: string, opts: CapabilityProfileOptions = {}): Promise<CapabilityRuntime> {
  const settings = loadCapabilitySettings(root, opts);
  const savedMCP = mcpConfigFromSettings(settings);
  const serverMCP = process.env.RLM_WIKI_ENABLE_GLOBAL_MCP === "1"
    ? loadMCPConfig(process.cwd()) ?? { mcpServers: {} }
    : { mcpServers: {} };
  const composio = await composioRuntime(settings);
  const mcpConfig = mergeMCPConfigs(serverMCP, savedMCP, composio.mcpConfig);
  return {
    mcpConfig,
    skillSources: settings.skills.filter((skill) => skill.enabled).map((skill) => skill.source),
    snapshot: capabilitySnapshot(settings, composio.snapshot),
  };
}

export function createComposioToolkitSession(
  root: string,
  toolkits: string[],
  forceRefresh = true,
  opts: CapabilityProfileOptions = {},
): ReturnType<Composio["create"]> {
  const settings = loadCapabilitySettings(root, opts);
  if (!settings.composio.enabled) throw new Error("Composio is disabled in Capabilities");
  return createComposioSession(settings, toolkits, forceRefresh);
}

export function updateComposioSettings(root: string, input: unknown, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const row = record(input);
  const settings = loadCapabilitySettings(root, opts);
  const userId = cleanComposioUserId(row.userId ?? settings.composio.userId);
  settings.composio = {
    ...settings.composio,
    enabled: row.enabled !== false,
    userId,
  };
  return saveCapabilitySettings(root, settings);
}

export function addComposioToolkits(root: string, input: unknown, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const row = record(input);
  const slugs = cleanToolkitSlugs(row.toolkits ?? row.toolkit ?? row.slug);
  if (!slugs.length) throw new Error("At least one Composio toolkit slug is required");
  const settings = loadCapabilitySettings(root, opts);
  const now = new Date().toISOString();
  for (const toolkit of slugs) {
    const existingIndex = settings.composio.toolkits.findIndex((item) => item.slug === toolkit);
    const prior = existingIndex >= 0 ? settings.composio.toolkits[existingIndex] : null;
    const next: StoredComposioToolkit = {
      slug: toolkit,
      enabled: row.enabled !== false,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIndex >= 0) settings.composio.toolkits[existingIndex] = next;
    else settings.composio.toolkits.push(next);
  }
  return saveCapabilitySettings(root, settings);
}

export function removeComposioToolkit(root: string, slug: string, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const settings = loadCapabilitySettings(root, opts);
  const cleanSlug = cleanToolkitSlug(slug);
  settings.composio.toolkits = settings.composio.toolkits.filter((toolkit) => toolkit.slug !== cleanSlug);
  return saveCapabilitySettings(root, settings);
}

export async function authorizeComposioToolkit(
  root: string,
  input: unknown,
  opts: CapabilityProfileOptions = {},
): Promise<{ toolkit: string; id: string; status?: string; redirectUrl?: string | null }> {
  const row = record(input);
  const toolkit = cleanToolkitSlug(row.toolkit ?? row.slug);
  const callbackUrl = typeof row.callbackUrl === "string" && row.callbackUrl.trim()
    ? row.callbackUrl.trim()
    : undefined;
  const settings = loadCapabilitySettings(root, opts);
  const session = await createComposioSession(settings, [toolkit]);
  const request = await session.authorize(toolkit, callbackUrl ? { callbackUrl } : undefined);
  return {
    toolkit,
    id: request.id,
    status: request.status,
    redirectUrl: request.redirectUrl,
  };
}

export async function inspectComposio(
  root: string,
  input: unknown = {},
  opts: CapabilityProfileOptions = {},
): Promise<{
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  userId: string;
  sessionId?: string;
  mcp?: { type: "http" | "sse"; hasUrl: boolean; headerKeys: string[] };
  toolkits: Array<{
    slug: string;
    name: string;
    isNoAuth: boolean;
    isActive: boolean;
    status?: string;
    connectedAccountId?: string;
  }>;
  error?: string;
}> {
  const settings = loadCapabilitySettings(root, opts);
  const row = record(input);
  const requested = cleanToolkitSlugs(row.toolkits ?? row.toolkit ?? row.slug);
  const toolkits = requested.length ? requested : enabledComposioToolkits(settings);
  if (!settings.composio.enabled) {
    return {
      ok: true,
      configured: hasComposioApiKey(),
      enabled: false,
      userId: settings.composio.userId,
      toolkits: [],
    };
  }
  if (!toolkits.length) {
    return {
      ok: true,
      configured: hasComposioApiKey(),
      enabled: true,
      userId: settings.composio.userId,
      toolkits: [],
    };
  }
  try {
    const session = await createComposioSession(settings, toolkits, true);
    const details = await session.toolkits({ toolkits, limit: Math.max(20, toolkits.length) });
    return {
      ok: true,
      configured: true,
      enabled: true,
      userId: settings.composio.userId,
      sessionId: session.sessionId,
      mcp: {
        type: session.mcp.type,
        hasUrl: Boolean(session.mcp.url),
        headerKeys: Object.keys(session.mcp.headers ?? {}),
      },
      toolkits: details.items.map((item) => ({
        slug: item.slug,
        name: item.name,
        isNoAuth: item.isNoAuth,
        isActive: Boolean(item.connection?.isActive),
        status: item.connection?.connectedAccount?.status,
        connectedAccountId: item.connection?.connectedAccount?.id,
      })),
    };
  } catch (e) {
    return {
      ok: false,
      configured: hasComposioApiKey(),
      enabled: settings.composio.enabled,
      userId: settings.composio.userId,
      toolkits: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function listComposioToolkitCatalog(
  root: string,
  input: unknown = {},
  opts: CapabilityProfileOptions = {},
): Promise<ComposioCatalogResult> {
  if (!hasComposioApiKey()) throw new Error("COMPOSIO_API_KEY is not set");

  const settings = loadCapabilitySettings(root, opts);
  const row = record(input);
  const query = new URLSearchParams();
  const search = cleanOptionalString(row.search);
  const category = cleanOptionalString(row.category);
  const cursor = cleanOptionalString(row.cursor);
  const managedBy = cleanEnum(row.managed_by ?? row.managedBy, ["composio", "all", "project"], "all");
  const sortBy = cleanEnum(row.sort_by ?? row.sortBy, ["usage", "alphabetically"], "usage");
  const limit = cleanLimit(row.limit, 24, 100);

  query.set("managed_by", managedBy);
  query.set("sort_by", sortBy);
  query.set("include_deprecated", "false");
  query.set("limit", String(limit));
  if (search) query.set("search", search);
  if (category) query.set("category", category);
  if (cursor) query.set("cursor", cursor);

  const payload = await composioAPIGet("/api/v3.1/toolkits", query);
  const selected = new Map(settings.composio.toolkits.map((toolkit) => [toolkit.slug, toolkit]));
  const items = Array.isArray(payload.items)
    ? payload.items.map((item) => normalizeCatalogToolkit(item, selected)).filter((item): item is ComposioCatalogToolkit => Boolean(item))
    : [];
  return {
    items,
    nextCursor: typeof payload.next_cursor === "string" ? payload.next_cursor : undefined,
    totalPages: typeof payload.total_pages === "number" ? payload.total_pages : 0,
    currentPage: typeof payload.current_page === "number" ? payload.current_page : 0,
    totalItems: typeof payload.total_items === "number" ? payload.total_items : items.length,
  };
}

export async function listComposioConnectedApps(root: string, opts: CapabilityProfileOptions = {}): Promise<{
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  userId: string;
  sessionId?: string;
  items: ComposioConnectedApp[];
  error?: string;
}> {
  const settings = loadCapabilitySettings(root, opts);
  const toolkits = enabledComposioToolkits(settings);
  if (!settings.composio.enabled || !toolkits.length) {
    return {
      ok: true,
      configured: hasComposioApiKey(),
      enabled: settings.composio.enabled,
      userId: settings.composio.userId,
      items: [],
    };
  }
  try {
    const session = await createComposioSession(settings, toolkits, true);
    const details = await session.toolkits({ toolkits, limit: Math.max(20, toolkits.length) });
    return {
      ok: true,
      configured: true,
      enabled: true,
      userId: settings.composio.userId,
      sessionId: session.sessionId,
      items: details.items.map((item) => {
        const raw = record(item);
        const connection = record(raw.connection);
        const connectedAccount = record(connection.connectedAccount);
        return {
          slug: item.slug,
          name: item.name,
          logo: typeof raw.logo === "string" ? raw.logo : undefined,
          isNoAuth: item.isNoAuth,
          isActive: Boolean(item.connection?.isActive),
          status: typeof connectedAccount.status === "string" ? connectedAccount.status : undefined,
          connectedAccountId: typeof connectedAccount.id === "string" ? connectedAccount.id : undefined,
        };
      }),
    };
  } catch (e) {
    return {
      ok: false,
      configured: hasComposioApiKey(),
      enabled: settings.composio.enabled,
      userId: settings.composio.userId,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function addOrUpdateMCPServer(root: string, input: unknown, opts: CapabilityProfileOptions = {}): Promise<CapabilitySettings> {
  const row = record(input);
  const name = cleanMCPName(row.name);
  const url = cleanRemoteMCPUrl(row.url);
  const type = row.type === "sse" ? "sse" : "http";
  const tokenEnv = cleanEnvName(row.tokenEnv);
  const enabled = row.enabled !== false;
  const now = new Date().toISOString();
  const settings = loadCapabilitySettings(root, opts);
  const existingIndex = settings.mcpServers.findIndex((server) => server.id === slug(name) || server.name === name);
  const prior = existingIndex >= 0 ? settings.mcpServers[existingIndex] : null;
  const next: StoredMCPServer = {
    id: prior?.id ?? slug(name),
    name,
    url,
    type,
    ...(tokenEnv ? { tokenEnv } : {}),
    enabled,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIndex >= 0) settings.mcpServers[existingIndex] = next;
  else settings.mcpServers.push(next);
  return saveCapabilitySettings(root, settings);
}

export function removeMCPServer(root: string, id: string, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const settings = loadCapabilitySettings(root, opts);
  settings.mcpServers = settings.mcpServers.filter((server) => server.id !== id);
  return saveCapabilitySettings(root, settings);
}

export async function testMCPServer(root: string, id: string, opts: CapabilityProfileOptions = {}): Promise<{ ok: boolean; tools: MCPToolInfo[]; error?: string }> {
  const settings = loadCapabilitySettings(root, opts);
  const server = settings.mcpServers.find((entry) => entry.id === id);
  if (!server) throw new Error("MCP server not found");
  let conn: Awaited<ReturnType<typeof connectMCPServer>> | null = null;
  try {
    conn = await connectMCPServer(server.name, mcpServerConfig(server));
    const tools: MCPToolInfo[] = conn.tools.map((tool) => ({
      server: conn!.name,
      tool: tool.name,
      callAs: `mcp__${sanitizeToolName(conn!.name)}__${sanitizeToolName(tool.name)}`,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (conn) {
      try { await conn.cleanup(); } catch { /* ignore cleanup */ }
    }
  }
}

export async function addGithubSkill(root: string, input: unknown, opts: CapabilityProfileOptions = {}): Promise<CapabilitySettings> {
  const row = record(input);
  const sources = githubSkillSources(row);
  if (!sources.length) throw new Error("Skill source is required");
  const registry = new SkillRegistry();
  const now = new Date().toISOString();
  const settings = loadCapabilitySettings(root, opts);
  for (const source of sources) {
    const parsed = parseSkillSource(source);
    if (parsed.type !== "github") {
      throw new Error("Skills must come from GitHub, for example owner/repo@skill-name");
    }

    const loaded = await registry.add(source);
    if (loaded.length === 0) {
      throw new Error(`No skills found in GitHub source: ${source}`);
    }

    const existingIndex = settings.skills.findIndex((skill) => skill.source === source);
    const prior = existingIndex >= 0 ? settings.skills[existingIndex] : null;
    const next: StoredSkillSource = {
      id: prior?.id ?? slug(source),
      source,
      enabled: row.enabled !== false,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIndex >= 0) settings.skills[existingIndex] = next;
    else settings.skills.push(next);
  }
  return saveCapabilitySettings(root, settings);
}

export async function inspectGithubSkillSource(root: string, input: unknown, opts: CapabilityProfileOptions = {}): Promise<GithubSkillInspection> {
  const row = record(input);
  const source = typeof row.source === "string" ? row.source.trim() : "";
  if (!source) throw new Error("Skill source is required");
  const parsed = parseSkillSource(source);
  if (parsed.type !== "github") {
    throw new Error("Skills must come from GitHub, for example owner/repo@skill-name");
  }

  const registry = new SkillRegistry();
  const loaded = await registry.add(source);
  if (!loaded.length) {
    throw new Error("No skills found in that GitHub source");
  }

  const settings = loadCapabilitySettings(root, opts);
  const installedSources = new Set(settings.skills.map((skill) => skill.source));
  const skills = loaded
    .map((skill) => githubSkillCandidate(parsed, source, skill, installedSources))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { source, skills };
}

export function removeGithubSkill(root: string, id: string, opts: CapabilityProfileOptions = {}): CapabilitySettings {
  const settings = loadCapabilitySettings(root, opts);
  settings.skills = settings.skills.filter((skill) => skill.id !== id);
  return saveCapabilitySettings(root, settings);
}

export function capabilitySnapshot(
  settings: CapabilitySettings,
  composioRuntime?: Partial<CapabilitySnapshot["composio"]>,
): CapabilitySnapshot {
  return {
    mcpServers: settings.mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      type: server.type,
      enabled: server.enabled,
      auth: server.tokenEnv ? "bearer-env" : "none",
    })),
    skills: settings.skills.map((skill) => ({
      id: skill.id,
      source: skill.source,
      enabled: skill.enabled,
    })),
    composio: {
      enabled: settings.composio.enabled,
      configured: hasComposioApiKey(),
      userId: settings.composio.userId,
      toolkits: settings.composio.toolkits.map((toolkit) => ({
        slug: toolkit.slug,
        enabled: toolkit.enabled,
      })),
      ...composioRuntime,
    },
  };
}

export const CAPABILITY_TODOS = [
  "Let each Ask/Review run select a subset of connected MCP servers and GitHub skills.",
  "Move active-run accounting to Postgres before increasing Railway replicas.",
];

async function loadManifestSkills(): Promise<SkillHydrationResult> {
  const key = manifestCacheKey();
  if (manifestSkillsCache?.key === key) {
    return manifestSkillsCache.value;
  }

  const value = hydrateSkills();
  manifestSkillsCache = { key, value };
  return value;
}

async function loadExplicitSkills(sources: string[]): Promise<SkillHydrationResult> {
  return hydrateSkills(sources);
}

async function hydrateSkills(explicitSources?: string[]): Promise<SkillHydrationResult> {
  const registry = new SkillRegistry();
  const errors: string[] = [];
  const sources: string[] = [];

  if (explicitSources?.length) {
    for (const source of explicitSources) {
      try {
        const loaded = await registry.add(source);
        if (loaded.length) sources.push(source);
      } catch (e) {
        errors.push(`${source}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    sources.push(...await registry.restoreFromManifest());
  }

  const names = registry.list().map((skill) => skill.name);
  return {
    names,
    sources,
    promptText: registry.formatForPrompt(),
    errors,
  };
}

function manifestCacheKey(): string {
  const manifestPath = join(process.cwd(), ".jcode", "skills.json");
  if (!existsSync(manifestPath)) return `${manifestPath}:missing`;
  try {
    const stat = statSync(manifestPath);
    return `${manifestPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${manifestPath}:unreadable`;
  }
}

function capabilityPath(root: string): string {
  return join(root, "config", "capabilities.json");
}

function emptyCapabilitySettings(defaultUserId?: string): CapabilitySettings {
  return {
    version: 1,
    composio: defaultComposioConfig(defaultUserId),
    mcpServers: [],
    skills: [],
  };
}

function normalizeCapabilitySettings(raw: Partial<CapabilitySettings>, defaultUserId?: string): CapabilitySettings {
  return {
    version: 1,
    composio: normalizeComposioConfig(raw.composio, defaultUserId),
    mcpServers: Array.isArray(raw.mcpServers)
      ? raw.mcpServers.map(normalizeMCPServer).filter((entry): entry is StoredMCPServer => Boolean(entry))
      : [],
    skills: Array.isArray(raw.skills)
      ? raw.skills.map(normalizeSkillSource).filter((entry): entry is StoredSkillSource => Boolean(entry))
      : [],
  };
}

function defaultComposioConfig(defaultUserId?: string): StoredComposioConfig {
  return {
    enabled: true,
    userId: defaultComposioUserId(defaultUserId),
    toolkits: [],
  };
}

function normalizeComposioConfig(raw: unknown, defaultUserId?: string): StoredComposioConfig {
  const row = record(raw);
  const fallback = defaultComposioConfig(defaultUserId);
  const userId = typeof row.userId === "string" && row.userId.trim()
    ? cleanComposioUserId(row.userId)
    : fallback.userId;
  return {
    enabled: row.enabled !== false,
    userId,
    toolkits: Array.isArray(row.toolkits)
      ? row.toolkits.map(normalizeComposioToolkit).filter((entry): entry is StoredComposioToolkit => Boolean(entry))
      : [],
  };
}

function normalizeComposioToolkit(raw: unknown): StoredComposioToolkit | null {
  const row = record(raw);
  try {
    const slugValue = row.slug ?? row.toolkit;
    const slug = cleanToolkitSlug(slugValue);
    const now = new Date().toISOString();
    return {
      slug,
      enabled: row.enabled !== false,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : now,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : now,
    };
  } catch {
    return null;
  }
}

function normalizeMCPServer(raw: unknown): StoredMCPServer | null {
  const row = record(raw);
  if (typeof row.name !== "string" || typeof row.url !== "string") return null;
  try {
    const name = cleanMCPName(row.name);
    const url = cleanRemoteMCPUrl(row.url);
    const now = new Date().toISOString();
    const tokenEnv = cleanEnvName(row.tokenEnv);
    return {
      id: typeof row.id === "string" && row.id ? row.id : slug(name),
      name,
      url,
      type: row.type === "sse" ? "sse" : "http",
      ...(tokenEnv ? { tokenEnv } : {}),
      enabled: row.enabled !== false,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : now,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : now,
    };
  } catch {
    return null;
  }
}

function normalizeSkillSource(raw: unknown): StoredSkillSource | null {
  const row = record(raw);
  if (typeof row.source !== "string") return null;
  const source = row.source.trim();
  if (!source) return null;
  try {
    if (parseSkillSource(source).type !== "github") return null;
  } catch {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id: typeof row.id === "string" && row.id ? row.id : slug(source),
    source,
    enabled: row.enabled !== false,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : now,
  };
}

function githubSkillSources(row: Record<string, unknown>): string[] {
  const raw = Array.isArray(row.sources)
    ? row.sources
    : Array.isArray(row.source)
      ? row.source
      : [row.source];
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const source = item.trim();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

function githubSkillCandidate(
  parsed: ParsedSkillSource & { type: "github" },
  requestedSource: string,
  skill: SkillRecord,
  installedSources: Set<string>,
): GithubSkillCandidate {
  const installSource = githubSkillInstallSource(parsed, requestedSource, skill);
  return {
    name: skill.name,
    description: skill.description,
    source: requestedSource,
    installSource,
    installed: installedSources.has(requestedSource) || installedSources.has(installSource),
  };
}

function githubSkillInstallSource(
  parsed: ParsedSkillSource & { type: "github" },
  requestedSource: string,
  skill: SkillRecord,
): string {
  const skillDir = dirname(skill.source);
  const cachePath = githubSkillCachePath(parsed);
  const relPath = normalizePathSlashes(relative(cachePath, skillDir));
  if (!relPath || relPath === "." || relPath.startsWith("../") || relPath === "..") {
    return requestedSource;
  }
  if (parsed.ref) {
    return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${parsed.ref}/${relPath}`;
  }
  return `${parsed.owner}/${parsed.repo}/${relPath}`;
}

function githubSkillCachePath(parsed: ParsedSkillSource & { type: "github" }): string {
  const cacheSlug = `${parsed.owner}__${parsed.repo}${parsed.ref ? `__${parsed.ref}` : ""}`;
  return join(homedir(), ".rlm", "skills-cache", cacheSlug);
}

function normalizePathSlashes(path: string): string {
  return path.split(sep).join("/");
}

function mcpConfigFromSettings(settings: CapabilitySettings): JCodeMCPConfig {
  const mcpServers: Record<string, MCPServerConfig> = {};
  for (const server of settings.mcpServers) {
    if (!server.enabled) continue;
    mcpServers[server.name] = mcpServerConfig(server);
  }
  return { mcpServers };
}

function mcpServerConfig(server: StoredMCPServer): MCPServerConfig {
  return {
    type: server.type,
    url: server.url,
    ...(server.tokenEnv ? { headers: { Authorization: `Bearer \${${server.tokenEnv}}` } } : {}),
  };
}

function mergeMCPConfigs(...configs: Array<JCodeMCPConfig | null | undefined>): JCodeMCPConfig {
  const mcpServers: Record<string, MCPServerConfig> = {};
  for (const config of configs) {
    if (!config?.mcpServers) continue;
    Object.assign(mcpServers, config.mcpServers);
  }
  return { mcpServers };
}

let composioRuntimeCache: {
  key: string;
  expiresAt: number;
  value: Promise<{
    mcpConfig: JCodeMCPConfig;
    snapshot: Partial<CapabilitySnapshot["composio"]>;
  }>;
} | null = null;

async function composioRuntime(settings: CapabilitySettings): Promise<{
  mcpConfig: JCodeMCPConfig;
  snapshot: Partial<CapabilitySnapshot["composio"]>;
}> {
  const toolkits = enabledComposioToolkits(settings);
  if (!settings.composio.enabled || !toolkits.length) {
    return { mcpConfig: { mcpServers: {} }, snapshot: {} };
  }
  if (!hasComposioApiKey()) {
    return {
      mcpConfig: { mcpServers: {} },
      snapshot: { error: "COMPOSIO_API_KEY is not set" },
    };
  }

  const key = `${settings.composio.userId}:${toolkits.join(",")}`;
  if (composioRuntimeCache?.key === key && composioRuntimeCache.expiresAt > Date.now()) {
    return composioRuntimeCache.value;
  }

  const value: Promise<{
    mcpConfig: JCodeMCPConfig;
    snapshot: Partial<CapabilitySnapshot["composio"]>;
  }> = (async () => {
    try {
      const session = await createComposioSession(settings, toolkits);
      const mcpConfig: JCodeMCPConfig = {
        mcpServers: {
          composio: composioMCPServerConfig(session.mcp),
        },
      };
      const snapshot: Partial<CapabilitySnapshot["composio"]> = {
        sessionId: session.sessionId,
        mcp: {
          name: "composio",
          type: session.mcp.type,
          enabled: true,
          auth: "composio-session",
        },
      };
      return {
        mcpConfig,
        snapshot,
      };
    } catch (e) {
      composioRuntimeCache = null;
      const mcpConfig: JCodeMCPConfig = { mcpServers: {} };
      const snapshot: Partial<CapabilitySnapshot["composio"]> = {
        error: e instanceof Error ? e.message : String(e),
      };
      return {
        mcpConfig,
        snapshot,
      };
    }
  })();
  composioRuntimeCache = { key, expiresAt: Date.now() + 10 * 60_000, value };
  return value;
}

function composioMCPServerConfig(mcp: ToolRouterMCPServerConfig): MCPServerConfig {
  return {
    type: mcp.type,
    url: mcp.url,
    ...(mcp.headers ? { headers: mcp.headers } : {}),
  };
}

function createComposioSession(
  settings: CapabilitySettings,
  onlyToolkits?: string[],
  forceRefresh = false,
): ReturnType<Composio["create"]> {
  const toolkits = onlyToolkits?.length ? onlyToolkits : enabledComposioToolkits(settings);
  if (!toolkits.length) throw new Error("Add at least one Composio toolkit before creating a session");
  const config: ToolRouterCreateSessionConfig = {
    toolkits,
    manageConnections: {
      enable: true,
      waitForConnections: false,
    },
    // JCODE already has rich local code tools; keep Composio focused on external apps.
    workbench: { enable: false },
  };
  if (forceRefresh) composioRuntimeCache = null;
  return composioClient().create(settings.composio.userId, config);
}

function composioClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set");
  return new Composio({
    apiKey,
    baseURL: process.env.COMPOSIO_BASE_URL || undefined,
    allowTracking: false,
    host: "rlm-wiki",
  });
}

function enabledComposioToolkits(settings: CapabilitySettings): string[] {
  return settings.composio.toolkits
    .filter((toolkit) => toolkit.enabled)
    .map((toolkit) => toolkit.slug);
}

function hasComposioApiKey(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

async function composioAPIGet(path: string, query?: URLSearchParams): Promise<Record<string, unknown>> {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set");
  const url = new URL(path, composioBackendBaseURL());
  if (query) {
    for (const [key, value] of query) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "x-api-key": apiKey,
    },
  });
  const text = await response.text();
  const parsed = text ? record(JSON.parse(text)) : {};
  if (!response.ok) {
    const error = record(parsed.error);
    const message = typeof error.message === "string"
      ? error.message
      : `Composio request failed: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return parsed;
}

function composioBackendBaseURL(): string {
  return (process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev").replace(/\/+$/, "");
}

function normalizeCatalogToolkit(
  raw: unknown,
  selected: Map<string, StoredComposioToolkit>,
): ComposioCatalogToolkit | null {
  const row = record(raw);
  const slugValue = typeof row.slug === "string" ? row.slug : "";
  if (!slugValue) return null;
  const meta = record(row.meta);
  const selectedToolkit = selected.get(slugValue);
  return {
    slug: slugValue,
    name: typeof row.name === "string" && row.name ? row.name : slugValue,
    description: typeof meta.description === "string" ? meta.description : "",
    logo: typeof meta.logo === "string" ? meta.logo : undefined,
    appUrl: typeof meta.app_url === "string" ? meta.app_url : undefined,
    categories: Array.isArray(meta.categories)
      ? meta.categories.map(normalizeToolkitCategory).filter((category): category is { id: string; name: string } => Boolean(category))
      : [],
    toolsCount: typeof meta.tools_count === "number" ? meta.tools_count : 0,
    triggersCount: typeof meta.triggers_count === "number" ? meta.triggers_count : 0,
    authSchemes: Array.isArray(row.auth_schemes) ? row.auth_schemes.map(String) : [],
    composioManagedAuthSchemes: Array.isArray(row.composio_managed_auth_schemes)
      ? row.composio_managed_auth_schemes.map(String)
      : [],
    noAuth: row.no_auth === true,
    selected: Boolean(selectedToolkit),
    enabled: selectedToolkit?.enabled ?? false,
  };
}

function normalizeToolkitCategory(raw: unknown): { id: string; name: string } | null {
  const row = record(raw);
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : id;
  if (!id && !name) return null;
  return { id: id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: name || id };
}

function cleanMCPName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("MCP name must start with a letter and use only letters, numbers, underscores, or hyphens");
  }
  return name;
}

function cleanRemoteMCPUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP URL must be a valid URL");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("Remote MCP URLs must use https://, except localhost during development");
  }
  return url.toString();
}

function defaultComposioUserId(defaultUserId?: string): string {
  return cleanComposioUserId(defaultUserId || process.env.COMPOSIO_USER_ID || "rlm-wiki-owner");
}

function cleanComposioUserId(value: unknown): string {
  const userId = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(userId)) {
    throw new Error("Composio user id must use letters, numbers, dot, underscore, colon, at-sign, or hyphen");
  }
  return userId;
}

function cleanToolkitSlugs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map(cleanToolkitSlug))];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean).map(cleanToolkitSlug))];
  }
  return [];
}

function cleanToolkitSlug(value: unknown): string {
  const slugValue = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(slugValue)) {
    throw new Error("Composio toolkit slugs must start with a letter and use lowercase letters, numbers, underscores, or hyphens");
  }
  return slugValue;
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean || undefined;
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

function cleanLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function cleanEnvName(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const name = String(value).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("Token env var must be a valid environment variable name");
  }
  return name;
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function slug(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "capability";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
