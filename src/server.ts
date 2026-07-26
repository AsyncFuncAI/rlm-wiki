import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { friendlyWikiGenerationError, generateWiki, normalizeWikiGenerationRuntime, regenerateWikiPage } from "./generator.ts";
import { captureServerError, configureServerTelemetry, installServerTelemetryMonitors } from "./server-telemetry.ts";
import { askRepo, askWorkspace } from "./chat.ts";
import type { AskMode, WorkspaceGoal } from "./chat.ts";
import { codeAnything, filterIgnoredPatch, normalizeCodeAnythingAgent } from "./code-anything.ts";
import { normalizeScreenshotAttachments } from "./vision.ts";
import { publishCodeAnythingPullRequest } from "./code-publish.ts";
import {
  getCachedReview,
  getReviewFileContents,
  investigateReview,
  loadReview,
  reviewAnything,
} from "./review.ts";
import { publishReviewRunComment } from "./review-publish.ts";
import type { ReviewSelection } from "./review.ts";
import {
  createReviewGitHubFetch,
  GitHubConnectionRequiredError,
  reviewGitHubConnectionStatus,
} from "./github-client.ts";
import { assignWorkspaceRepoIds, normalizeRepoSourcePath, parseGithubUrl, wikiRefForWorkspace, WikiRecordSchema, type RepoRef, type WikiRecord, type WorkspaceRepoRef } from "./types.ts";
import { codeKbEnabled, ensureCodeKbSession, peekCodeKbSession, prewarmCodeKbSession, queryCodeKb, raceWithBudget, readCodeKbFile, type CodeKbSession, type CodeKbSessionPeek } from "./sharenow-kb-client.ts";
import { codeKbAskContext, renderAskEvidence } from "./prompts/code-kb.ts";
import { WikiStore } from "./storage.ts";
import { MODEL_CHANNELS, DEFAULT_CHANNEL_ID, makeLLM, resolveChannel, providerStatus, channelSupportsVision } from "./llm.ts";
import type { Provider, ProviderModel, ProviderStatusEntry } from "./llm.ts";
import { rlmProviderStatus } from "./rlm-llm.ts";
import { normalizeAgentRuntime, runtimeLabel, type AgentRuntime } from "./agent-runtime.ts";
import {
  getLocalCliAgents,
  localCliSidecarEnabled,
  prepareLocalCliTerminalWorkspace,
  releaseLocalCliTerminalWorkspace,
} from "./local-cli-sidecar-client.ts";
import { localCliLabel, normalizeLocalCliConfig, type LocalCliAgentStatus, type LocalCliConfig } from "./local-cli-events.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import { getProviderUsageState } from "./provider-usage/index.ts";
import {
  addProviderAccount,
  getProviderAccountsSnapshot,
  reauthProviderAccount,
  removeProviderAccount,
  selectProviderAccount,
} from "./provider-accounts/index.ts";
import { runWikiInterview, runAskInterview } from "./wiki-interview.ts";
import { runTaskExtract, runEpicExtract } from "./task-extract.ts";
import { extractDecision } from "./local-cli-parsers.ts";
import { providerSetupInfo } from "./provider-setup.ts";
import { ANTHROPIC_PROXY_PREFIX, configureAnthropicProxyEnvForServer, proxyAnthropicOpenAI } from "./anthropic-openai-proxy.ts";
import { GEMINI_PROXY_PREFIX, configureGeminiProxyEnvForServer, proxyGeminiOpenAI } from "./gemini-openai-proxy.ts";
import { authenticateRequest, authMode, type AuthIdentity } from "./auth.ts";
// AuthResult.identity is unwrapped in the request handler; optional Set-Cookie
// for AUTH_MODE=off anonymous sessions is applied via withAuthCookies.
import {
  authorizeInviteRequest,
  createInviteLinksForEmails,
  inviteAcceptResponse,
  inviteDeniedResponse,
  inviteGateEnabled,
  isInviteAdmin,
} from "./invites.ts";
import {
  hasRequestProviderCredentials,
  hasProviderSecrets,
  normalizeProviderSecrets,
  providerRequiredSecretKeys,
  redactProviderSecrets,
  type ProviderSecrets,
} from "./provider-secrets.ts";
import {
  WIKI_PAGE_COUNT_MAX,
  defaultWikiPageCountForDepth,
  normalizeWikiLanguages,
  normalizeWikiPageCount,
  normalizeWikiPageCountMode,
  normalizeWikiStyle,
  normalizeWikiStylePrompt,
  wikiDepthForPageCount,
} from "./wiki-options.ts";
import { renderMarkdownBlocks } from "./ui/markdown-renderer.ts";
import {
  createProductStore,
  productSqlitePathForRuntime,
  wikiArtifactKey,
  wikiInstanceArtifactKey,
  wikiRecordArtifactKey,
  type ProductRunEvent,
  type ProductRun,
  type ProductRunKind,
  type ProductStore,
} from "./persistence.ts";
import { ensureWikiRecordIdentity } from "./wiki-identity.ts";
import { isFailedWikiGeneratedPage, wikiRecordCompletion } from "./wiki-page-status.ts";
import { normalizeKnowledgeProfile } from "./knowledge-profile.ts";
import {
  KNOWLEDGE_BASE_ARTIFACT_KIND,
  loadKnowledgeBase,
  normalizeKnowledgeBase,
  saveKnowledgeBase,
} from "./kb/knowledge-base-store.ts";
import { kbRecordFromArtifact, orderKbCardPagesByFreshness } from "./kb/kb-publish.ts";
import {
  distillToKnowledgeBase,
  type DistillEvent,
  type DistillScope,
} from "./kb/kb-distill-pipeline.ts";
import { buildRollupMessages } from "./kb/kb-rollup-input.ts";
import type { KbHistoryMessage } from "./kb/kb-prompts.ts";
import { openSlideDeckFiles, openSlideDeckZipName, type OpenSlideExportFile } from "./open-slide-export.ts";
import {
  generateWikiSlides,
  wikiSlidesArtifactKey,
  WIKI_SLIDES_ARTIFACT_KIND,
} from "./slides-generator.ts";
import {
  buildOpenSlideViewer,
  openSlideViewerArtifactKey,
  openSlideViewerContentType,
  openSlideViewerFilePath,
  prepareOpenSlideViewerDist,
  WIKI_SLIDES_VIEWER_ARTIFACT_KIND,
} from "./slides-viewer.ts";
import {
  createJobQueue,
  type JobRecord,
  type JobQueue,
  type JobQueueStats,
} from "./job-queue.ts";
import {
  makePrivateWikiId,
  normalizePublicWikiVisibility,
  sanitizePublicWikiRecord,
  wikiPublicationRecordVersion,
  type PublicWikiVisibility,
} from "./public-wiki.ts";
import {
  askPublicationRecordVersion,
  normalizePublicAskId,
  normalizePublicAskVisibility,
  publicAskPath,
  publicAskRecordFromDesktopAsk,
  type PublicAskRecord,
  type PublicAskVisibility,
} from "./public-ask.ts";
import {
  createSecretGrantStore,
  type SecretGrantRef,
  type SecretGrantStats,
  type SecretGrantStore,
} from "./secret-grants.ts";
import {
  dispatchJobToUnikraft,
  unikraftDispatchConfig,
  unikraftDispatchEnabledForJobType,
} from "./unikraft-compute.ts";
import {
  addComposioToolkits,
  addGithubSkill,
  addOrUpdateMCPServer,
  authorizeComposioToolkit,
  capabilityRuntime,
  capabilitySnapshot,
  CAPABILITY_TODOS,
  inspectComposio,
  inspectGithubSkillSource,
  listComposioConnectedApps,
  listComposioToolkitCatalog,
  loadCapabilitySettings,
  removeComposioToolkit,
  removeGithubSkill,
  removeMCPServer,
  saveCapabilitySettings,
  testMCPServer,
  updateComposioSettings,
  type CapabilityProfileOptions,
  type CapabilitySettings,
  type CapabilitySnapshot,
} from "./agent-capabilities.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolveOptionalEnvPath("GROK_WIKI_PUBLIC_DIR") ?? join(__dirname, "..", "public");
const DIST_PUBLIC_DIR = resolveOptionalEnvPath("GROK_WIKI_DIST_PUBLIC_DIR") ?? join(__dirname, "..", "dist", "public");
const AI_ICON_PATH_PATTERN = /^\/ai-icons\/[a-z0-9-]+\.svg$/;
const STYLE_HREF_PATTERN = /href="\/styles\.css(?:\?v=[^"]*)?"/;
const BUILT_ASSET_EXTENSIONS = "css|js|png|ico|webmanifest";
const BUILT_ASSET_PATH_PATTERN = new RegExp(`^/assets/[A-Za-z0-9_.-]+\\.(?:${BUILT_ASSET_EXTENSIONS})$`);
const PUBLIC_WIKI_ASSET_PREFIX = "/public/wiki/_assets/";
const PUBLIC_WIKI_ASSET_PATH_PATTERN = new RegExp(`^${PUBLIC_WIKI_ASSET_PREFIX.replace(/\//g, "\\/")}[A-Za-z0-9_.-]+\\.(?:${BUILT_ASSET_EXTENSIONS})$`);

/**
 * Max concurrent generation runs across the whole server. A full generation
 * can keep ~6 JCODE agents active (1 structure + up to 5 page runs). Ask runs
 * use 1 agent each.
 *
 * Railway Hobby (512 MB-1 GB): 1-2 generate slots, ~5 ask slots.
 * Railway Pro (8 GB):          5-6 generate slots, ~20 ask slots.
 *
 * Override with RLM_WIKI_MAX_GENERATE and RLM_WIKI_MAX_ASK env vars.
 */
const MAX_GENERATE = parseInt(process.env.RLM_WIKI_MAX_GENERATE || "2", 10);
const MAX_GENERATE_PER_USER = parseInt(
  process.env.RLM_WIKI_MAX_GENERATE_PER_USER || process.env.RLM_WIKI_MAX_GENERATE || "2",
  10,
);
const MAX_ASK = parseInt(process.env.RLM_WIKI_MAX_ASK || "5", 10);
const MAX_CODE = parseInt(process.env.RLM_WIKI_MAX_CODE || process.env.RLM_WIKI_MAX_ASK || "3", 10);
const MAX_REVIEW = parseInt(process.env.RLM_WIKI_MAX_REVIEW || process.env.RLM_WIKI_MAX_ASK || "5", 10);
const MAX_ASK_PER_USER = parseInt(process.env.RLM_WIKI_MAX_ASK_PER_USER || "3", 10);
const MAX_ASK_REPOS = parseInt(process.env.RLM_WIKI_MAX_ASK_REPOS || "6", 10);
const MAX_DISTILL = parseInt(process.env.RLM_WIKI_MAX_DISTILL || process.env.RLM_WIKI_MAX_ASK || "3", 10);
const MAX_BATCH_REGENERATE_PAGES = 50;
// BRANCH gate (Phase 0 outcome). Phase 0 returned gate=PASS, branch=full-self-heal,
// so the auto-apply resolver is wired on by default. Setting GROK_WIKI_KB_SELF_HEAL=0
// forces the Phase-0 PARTIAL fallback (provisional-marking-only) without a code change.
const KB_SELF_HEAL_ENABLED = process.env.GROK_WIKI_KB_SELF_HEAL !== "0";
const WORKSPACE_GOALS = new Set(["compare", "steal", "understand", "bridge", "audit"]);
const ASK_MODES = new Set(["fast", "deep"]);
const PROCESS_SNAPSHOT_EVENT_LIMIT = 240;
const CAPABILITY_SETTINGS_ARTIFACT_KIND = "capability_settings";
const CAPABILITY_SETTINGS_ARTIFACT_KEY = "default";
const WIKI_PUBLICATION_ARTIFACT_KIND = "wiki_publication";
const ASK_PUBLICATION_ARTIFACT_KIND = "ask_publication";
const PUBLIC_WIKI_ARTIFACT_KIND = "public_wiki";
const WIKI_DRAFT_ARTIFACT_KIND = "wiki_draft";
const WIKI_SLIDES_LATEST_ARTIFACT_KIND = "wiki_slides_latest";
const RUN_MODE = normalizeRunMode(process.env.RLM_WIKI_RUN_MODE);
const DESKTOP_ALLOWED_LOCAL_REPOS = new Set<string>();
const DETACHED_TERMINAL_EVENTS = new Set(["answer", "diff", "done", "investigation", "canceled", "error"]);
const JOB_LOCK_MS = Math.max(10_000, Number(process.env.RLM_WIKI_JOB_LOCK_MS || 60_000));
const JOB_WORKER_ID = (process.env.RLM_WIKI_WORKER_ID || `web-${crypto.randomUUID().slice(0, 8)}`).slice(0, 80);

let activeGenerate = 0;
let activeAsk = 0;
let activeCode = 0;
let activeReview = 0;
let activeDistill = 0;
const activeGenerateByUser = new Map<string, number>();
const activeAskByUser = new Map<string, number>();
const activeDistillByUser = new Map<string, number>();
const activeCodeByUser = new Map<string, number>();
const activeReviewByUser = new Map<string, number>();

function assetVersion(): string {
  const raw = process.env.RLM_WIKI_ASSET_VERSION
    || process.env.RAILWAY_DEPLOYMENT_ID
    || process.env.RAILWAY_GIT_COMMIT_SHA
    || Date.now().toString(36);
  return encodeURIComponent(raw.trim().slice(0, 64) || Date.now().toString(36));
}

function resolveOptionalEnvPath(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw ? resolve(raw) : null;
}

function serveBuiltPublicAssets(): boolean {
  const explicit = process.env.RLM_WIKI_SERVE_DIST;
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  if (!existsSync(join(PUBLIC_DIR, "index.html")) && existsSync(join(DIST_PUBLIC_DIR, "index.html"))) return true;
  return process.env.NODE_ENV === "production" && existsSync(join(DIST_PUBLIC_DIR, "index.html"));
}

function publicAssetDir(): string {
  return serveBuiltPublicAssets() ? DIST_PUBLIC_DIR : PUBLIC_DIR;
}

function publicAssetPath(pathname: string): string {
  return join(publicAssetDir(), pathname.replace(/^\/+/, ""));
}

function distPublicAssetPath(pathname: string): string {
  return join(DIST_PUBLIC_DIR, pathname.replace(/^\/+/, ""));
}

function existingStaticAssetPath(pathname: string): string | null {
  const primary = publicAssetPath(pathname);
  if (existsSync(primary)) return primary;
  const built = distPublicAssetPath(pathname);
  if (existsSync(built)) return built;
  return null;
}

function builtStylesheetHref(): string | null {
  const builtIndexPath = join(DIST_PUBLIC_DIR, "index.html");
  if (existsSync(builtIndexPath)) {
    const builtIndex = readFileSync(builtIndexPath, "utf8");
    const linkTags = builtIndex.match(/<link\b[^>]*>/gi) ?? [];
    for (const tag of linkTags) {
      if (!/\brel=["']stylesheet["']/i.test(tag)) continue;
      const href = tag.match(/\bhref=["']([^"']+\.css)["']/i)?.[1];
      if (!href?.startsWith("/assets/")) continue;
      if (existsSync(distPublicAssetPath(href))) return href;
    }
  }

  const assetDir = join(DIST_PUBLIC_DIR, "assets");
  if (!existsSync(assetDir)) return null;
  const stylesheets = readdirSync(assetDir)
    .filter((name) => /^style-[A-Za-z0-9_.-]+\.css$/.test(name))
    .map((name) => {
      const path = join(assetDir, name);
      return { name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stylesheets[0] ? `/assets/${stylesheets[0].name}` : null;
}

function stylesheetHrefForIndex(version: string): string {
  if (existsSync(join(PUBLIC_DIR, "styles.css"))) return `/styles.css?v=${version}`;
  return builtStylesheetHref() ?? `/styles.css?v=${version}`;
}

function publicWikiAssetPath(pathname: string): string {
  return `/assets/${pathname.slice(PUBLIC_WIKI_ASSET_PREFIX.length)}`;
}

function staticAssetContentType(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  if (pathname.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  return "application/octet-stream";
}

function builtAssetResponse(pathname: string, method: string): Response {
  const filePath = existingStaticAssetPath(pathname);
  if (filePath) {
    return new Response(method === "HEAD" ? null : Bun.file(filePath), {
      headers: {
        "content-type": staticAssetContentType(pathname),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  return new Response("Not found.", { status: 404 });
}

function publicWikiIndexHtml(servedIndexHtml: string): string {
  return servedIndexHtml
    .replace(/\b(href|src)="\/assets\//g, `$1="${PUBLIC_WIKI_ASSET_PREFIX}`)
    .replace(STYLE_HREF_PATTERN, `href="${PUBLIC_WIKI_ASSET_PREFIX}styles.css"`);
}

function loadIndexHtmlForServe(opts?: ServerOptions): string | null {
  const indexHtml = join(publicAssetDir(), "index.html");
  if (!existsSync(indexHtml)) return null;
  const version = assetVersion();
  const html = readFileSync(indexHtml, "utf8");
  const withDevCssVersion = serveBuiltPublicAssets()
    ? html
    : html.replace(
    STYLE_HREF_PATTERN,
    `href="${stylesheetHrefForIndex(version)}"`,
  );
  return withDevCssVersion.replace("</head>", `${desktopBridgeScript(opts)}\n</head>`);
}
const activeAskRunIds = new Set<string>();
const activeCodeRunIds = new Set<string>();
const activeRunControllers = new Map<string, { controller: AbortController; kind: ProductRunKind; turnId?: string; startedAt: string }>();
const runEventWriteQueues = new Map<string, Promise<unknown>>();
let runEventAppendQueue: Promise<unknown> = Promise.resolve();
const runProcessEvents = new Map<string, CompactRunEvent[]>();
const runEventPersistenceDisabled = new Map<string, { reason: string; disabledAt: number }>();
const reviewOwnerIds = new Map<string, string>();
const USER_STOP_MESSAGE = "Stopped by user.";
const RUN_EVENT_PERSISTENCE_DISABLED_TTL_MS = 15 * 60_000;

type RunMode = "inline" | "detached" | "worker";

interface CompactRunEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ProcessSnapshot {
  version: 1;
  eventCount: number;
  events: CompactRunEvent[];
  updatedAt: string;
}

interface PublicRepoRef {
  id?: string;
  owner: string;
  repo: string;
  repos?: unknown[];
  label?: string;
  url: string;
  branch?: string | null;
  sourcePath?: string | null;
}

interface AskSessionTurn {
  id: string;
  question: string;
  status: "running" | "done" | "error" | "canceled";
  refs: PublicRepoRef[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  channel: string;
  runtime: AgentRuntime;
  localCli?: unknown;
  workspaceGoal: WorkspaceGoal | null;
  askMode: AskMode;
  capabilities?: CapabilitySnapshot;
  knowledgeProfile?: unknown;
  startedAt: string;
  completedAt?: string;
  answer?: string;
  sources?: string[];
  error?: string;
}

interface CodeSessionTurn {
  id: string;
  task: string;
  displayTask?: string;
  handoff?: Record<string, string | number | boolean>;
  status: "running" | "done" | "error" | "canceled";
  channel: string;
  runtime: AgentRuntime;
  agent?: string;
  localCli?: unknown;
  startedAt: string;
  completedAt?: string;
  answer?: string;
  sources?: string[];
  diff?: string;
  fullDiff?: string;
  gitStatus?: string;
  changedFiles?: string[];
  truncated?: boolean;
  error?: string;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  store?: WikiStore;
  productStore?: ProductStore;
  jobQueue?: JobQueue;
  secretGrantStore?: SecretGrantStore;
  desktop?: {
    enabled?: boolean;
    appDataDir?: string;
    token?: string;
  };
}

function desktopEnabled(opts?: ServerOptions): boolean {
  return Boolean(
    opts?.desktop?.enabled ||
      process.env.GROK_WIKI_DESKTOP === "1" ||
      process.env.RLM_WIKI_DESKTOP === "1",
  );
}

export function desktopDirectPagesEnabled(input: {
  server?: ServerOptions;
  benchmarkFastPages?: unknown;
  benchmarkMode?: boolean;
} = {}): boolean {
  if (!desktopEnabled(input.server)) return false;
  const benchmarkMode = input.benchmarkMode
    ?? process.env.GROK_WIKI_DESKTOP_BENCHMARK === "1";
  if (benchmarkMode && typeof input.benchmarkFastPages === "boolean") {
    return input.benchmarkFastPages;
  }
  return true;
}

function desktopBenchmarkEnabled(opts?: ServerOptions): boolean {
  return desktopEnabled(opts) && process.env.GROK_WIKI_DESKTOP_BENCHMARK === "1";
}

function desktopToken(opts?: ServerOptions): string {
  return opts?.desktop?.token || process.env.GROK_WIKI_DESKTOP_TOKEN || process.env.RLM_WIKI_DESKTOP_TOKEN || "";
}

function desktopAppDataDir(opts?: ServerOptions): string {
  return opts?.desktop?.appDataDir || process.env.GROK_WIKI_DESKTOP_APP_DATA || process.env.RLM_WIKI_DESKTOP_APP_DATA || "";
}

function requestHostname(value: string): string {
  const raw = String(value || "").split(",")[0]?.trim() || "";
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    const withoutBrackets = raw.replace(/^\[/, "").replace(/\].*$/, "");
    if (withoutBrackets === "::1") return "::1";
    return raw.replace(/:\d+$/, "").toLowerCase();
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || host === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function localhostRequest(req: Request): boolean {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = req.headers.get("host");
  const visibleHost = forwardedHost || host;
  if (visibleHost) return isLoopbackHostname(requestHostname(visibleHost));
  return isLoopbackHostname(new URL(req.url).hostname);
}

function localCliRuntimeEnabled(req: Request, opts?: ServerOptions): boolean {
  return desktopEnabled(opts) || localhostRequest(req);
}

type LocalRepoAccess = {
  allowed: boolean;
  requireAllowlist: boolean;
  requireGit: boolean;
};

function localRepoAccessForRequest(req: Request, serverHost: string, opts?: ServerOptions): LocalRepoAccess {
  const desktop = desktopEnabled(opts);
  return {
    allowed: desktop || (isLoopbackHostname(serverHost) && localhostRequest(req)),
    requireAllowlist: desktop,
    requireGit: true,
  };
}

function localFolderAccessForReadOnlyRequest(req: Request, serverHost: string, opts?: ServerOptions): LocalRepoAccess {
  return {
    ...localRepoAccessForRequest(req, serverHost, opts),
    requireGit: false,
  };
}

function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin") || "";
  const allowed = allowedOrigins();
  const requestOrigin = req ? new URL(req.url).origin : "";
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, cf-access-jwt-assertion, cf-access-authenticated-user-email, x-rlm-wiki-dev-user, x-grok-wiki-desktop-token",
  };
  if (authMode() === "off" && !allowed.length) {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }
  if (origin && (origin === requestOrigin || allowed.includes(origin))) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  } else if (!origin && allowed.length === 1) {
    headers["access-control-allow-origin"] = allowed[0];
    headers.vary = "Origin";
  }
  return {
    ...headers,
  };
}

function jsonResponse(data: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

function withAuthCookies(response: Response, setCookie?: string, extra?: Record<string, string>): Response {
  if (!setCookie && !extra) return response;
  const headers = new Headers(response.headers);
  if (setCookie) headers.append("set-cookie", setCookie);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key.toLowerCase() === "set-cookie") headers.append("set-cookie", value);
      else headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface LocalCliChannelStatus {
  enabled: boolean;
  agents: LocalCliAgentStatus[];
  error?: string;
  code?: string;
}

type LocalCliAgentsLoader = (opts?: { rescan?: boolean; probe?: boolean }) => Promise<LocalCliChannelStatus>;

interface ChannelConfigDeps {
  isLocalCliSidecarEnabled?: () => boolean;
  loadLocalCliAgents?: LocalCliAgentsLoader;
}

function localCliUnavailableStatus(): LocalCliChannelStatus {
  return {
    enabled: false,
    agents: [],
    error: "Local CLI mode is only available in the desktop app or on localhost.",
    code: "LOCAL_CLI_LOCAL_ONLY",
  };
}

function localCliSidecarDisabledStatus(): LocalCliChannelStatus {
  return {
    enabled: false,
    agents: [],
    error: "Local CLI sidecar is disabled in this environment.",
  };
}

function truthyQueryParam(value: string | null): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function includeLocalCliAgentsForChannels(url: URL): boolean {
  return truthyQueryParam(url.searchParams.get("localCliAgents")) ||
    truthyQueryParam(url.searchParams.get("includeLocalCliAgents"));
}

export async function channelConfigForRequest(
  req: Request,
  opts: ServerOptions = {},
  deps: ChannelConfigDeps = {},
) {
  const url = new URL(req.url);
  const agentStatus = providerStatus();
  const rlmStatus = rlmProviderStatus();
  const localCliAllowed = localCliRuntimeEnabled(req, opts);
  const isLocalCliSidecarEnabled = deps.isLocalCliSidecarEnabled ?? localCliSidecarEnabled;
  const localCliSidecarAllowed = localCliAllowed && isLocalCliSidecarEnabled();
  const includeLocalCliAgents = includeLocalCliAgentsForChannels(url);
  const loadLocalCliAgents = deps.loadLocalCliAgents ?? getLocalCliAgents;
  const localCliStatus = !localCliAllowed
    ? localCliUnavailableStatus()
    : !localCliSidecarAllowed
      ? localCliSidecarDisabledStatus()
    : includeLocalCliAgents
      ? await loadLocalCliAgents({ rescan: truthyQueryParam(url.searchParams.get("rescan")) })
      : { enabled: true, agents: [] };
  const localCliServerConfigured = includeLocalCliAgents
    ? localCliStatus.enabled && localCliStatus.agents.some((agent) => agent.runnable)
    : false;

  return {
    defaultChannel: DEFAULT_CHANNEL_ID,
    localCli: localCliStatus,
    channels: MODEL_CHANNELS.map((c) => ({
      id: c.id,
      label: c.label,
      sub: c.sub,
      group: c.group,
      provider: c.provider,
      model: c.model,
      vision: channelSupportsVision(c),
      configured: false,
      serverConfigured: agentStatus[c.provider].configured || rlmStatus[c.provider].configured,
      acceptsProviderSecrets: c.provider !== "codex",
      keyNeededForRun: c.provider !== "codex",
      missing: providerRequiredSecretKeys(c.provider),
      setup: null,
      runtimeStatus: {
        agent: {
          configured: false,
          serverConfigured: agentStatus[c.provider].configured,
          missing: providerRequiredSecretKeys(c.provider),
          setup: null,
        },
        rlm: {
          configured: false,
          serverConfigured: rlmStatus[c.provider].configured,
          missing: providerRequiredSecretKeys(c.provider),
          setup: null,
        },
        "local-cli": {
          configured: localCliSidecarAllowed,
          serverConfigured: localCliServerConfigured,
          missing: localCliAllowed ? (localCliSidecarAllowed ? [] : ["local-cli-sidecar"]) : ["desktop-or-localhost"],
          setup: null,
        },
      },
    })),
  };
}

function binaryResponse(data: Uint8Array, headers: Record<string, string> = {}, req?: Request): Response {
  const body = new ArrayBuffer(data.byteLength);
  new Uint8Array(body).set(data);
  return new Response(new Blob([body]), {
    headers: { ...headers, ...corsHeaders(req) },
  });
}

function isUiPath(method: string, pathname: string): boolean {
  const wikiPath = /^\/[^/]+\/[^/]+\/?$/.test(pathname)
    && !pathname.startsWith("/api/")
    && !pathname.startsWith("/invite/")
    && !pathname.startsWith("/ai-icons/");
  return method === "GET" && (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/wikis" ||
    pathname === "/wikis/" ||
    pathname === "/wiki" ||
    pathname === "/wiki/" ||
    pathname.startsWith("/wiki/") ||
    pathname === "/ask" ||
    pathname === "/ask/" ||
    pathname.startsWith("/ask/") ||
    pathname === "/code" ||
    pathname === "/code/" ||
    pathname.startsWith("/code/") ||
    pathname === "/capabilities" ||
    pathname === "/capabilities/" ||
    pathname === "/review" ||
    pathname === "/review/" ||
    pathname.startsWith("/review/") ||
    wikiPath
  );
}

function isPublicUiPath(method: string, pathname: string): boolean {
  return method === "GET" && Boolean(publicWikiIdFromUiPath(pathname) || publicDocsIdFromUiPath(pathname));
}

function indexResponse(servedIndexHtml: string | null): Response {
  if (servedIndexHtml) {
    return new Response(servedIndexHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return new Response("UI not built. Visit /api/health.", { status: 404 });
}

function publicIndexResponse(servedIndexHtml: string | null): Response {
  if (servedIndexHtml) {
    return new Response(publicWikiIndexHtml(servedIndexHtml), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return new Response("UI not built. Visit /api/health.", { status: 404 });
}

function desktopBridgeScript(opts?: ServerOptions): string {
  if (!desktopEnabled(opts)) return "";
  const payload = {
    enabled: true,
    token: desktopToken(opts),
    appDataDir: desktopAppDataDir(opts),
  };
  return `<script>window.__RLM_DESKTOP__=${JSON.stringify(payload).replace(/</g, "\\u003c")};document.documentElement.classList.add("rlm-desktop");</script>`;
}

function allowedOrigins(): string[] {
  return (process.env.RLM_WIKI_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function tryAcquireUserSlot(active: Map<string, number>, userId: string, limit = 1): (() => void) | null {
  const current = active.get(userId) ?? 0;
  if (current >= limit) return null;
  active.set(userId, current + 1);
  return () => {
    const next = Math.max(0, (active.get(userId) ?? 1) - 1);
    if (next) active.set(userId, next);
    else active.delete(userId);
  };
}

function busyResponse(args: {
  kind: "generation" | "ask" | "code" | "review" | "distill";
  scope: "user" | "global";
  active: number;
  max: number;
  retryAfter: number;
  req?: Request;
}): Response {
  const status = args.scope === "user" ? 429 : 503;
  const who = args.scope === "user" ? "You already have" : "Server is busy:";
  const detail = args.scope === "user"
    ? args.max > 1
      ? `${who} ${args.active}/${args.max} ${args.kind} runs in progress. Please wait for one to finish, or stop one before starting another.`
      : `${who} a ${args.kind} run in progress. Please wait for it to finish, or stop it before starting another.`
    : `${who} ${args.active}/${args.max} ${args.kind} slots in use. Please retry in a moment.`;
  return new Response(
    JSON.stringify({ error: detail, retryAfter: args.retryAfter }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "retry-after": String(args.retryAfter),
        ...corsHeaders(args.req),
      },
    },
  );
}

function normalizeRunMode(value: unknown): RunMode {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "worker") return "worker";
  if (mode === "detached") return "detached";
  return "inline";
}

function runModeFor(productStore: ProductStore, jobQueue: JobQueue, secretGrantStore: SecretGrantStore): RunMode {
  if (RUN_MODE === "inline") return "inline";
  if (productStore.mode !== "postgres") return "inline";
  if (jobQueue.mode !== "postgres") return "inline";
  if (RUN_MODE === "worker") return secretGrantStore.configured ? "worker" : "inline";
  return "detached";
}

function providerSetupPayload(channel: ProviderModel, status: ProviderStatusEntry): Record<string, unknown> {
  const missing = providerRequiredSecretKeys(channel.provider);
  if (missing.length) {
    return {
      error: `${channel.label} is disabled in Local CLI-only mode. Use a configured local CLI runtime instead.`,
      code: "MODEL_ACCESS_UNAVAILABLE",
      provider: channel.provider,
      channel: channel.id,
      missing,
      setup: null,
    };
  }
  return {
    error: `${channel.label} is not available in Local CLI-only mode.`,
    code: "MODEL_ACCESS_UNAVAILABLE",
    provider: channel.provider,
    channel: channel.id,
    missing: status.missing,
    setup: null,
  };
}

function providerSetupResponse(channel: ProviderModel, status: ProviderStatusEntry, req?: Request): Response {
  return jsonResponse(providerSetupPayload(channel, status), 400, req);
}

function providerStatusForRuntime(
  runtime: AgentRuntime,
  providerSecrets?: ProviderSecrets,
): Record<Provider, ProviderStatusEntry> {
  if (runtime === "local-cli") {
    const base = providerStatus();
    const out = { ...base };
    for (const provider of Object.keys(out) as Provider[]) {
      out[provider] = {
        ...out[provider],
        configured: true,
        missing: [],
        setup: undefined,
      };
    }
    return out;
  }
  const status = runtime === "rlm" ? rlmProviderStatus() : providerStatus();
  const out = { ...status };
  for (const provider of Object.keys(out) as Provider[]) {
    const configured = hasRequestProviderCredentials(provider, providerSecrets);
    out[provider] = {
      ...out[provider],
      configured,
      missing: configured ? [] : providerRequiredSecretKeys(provider),
      setup: undefined,
    };
  }
  return out;
}

async function localCliPreflightResponse(
  runtime: AgentRuntime,
  localCli: LocalCliConfig,
  req: Request,
  surface: string,
  opts?: ServerOptions,
): Promise<Response | null> {
  if (runtime !== "local-cli") return null;
  if (!localCliRuntimeEnabled(req, opts)) {
    return jsonResponse({
      error: "Local CLI mode is only available in the desktop app or on localhost.",
      code: "LOCAL_CLI_LOCAL_ONLY",
      runtime,
      localCli,
      agent: null,
      enabled: false,
      setupHint: "Open Grok-Wiki Desktop or run Grok-Wiki on localhost to use local CLI agents.",
    }, 400, req);
  }
  const status = await getLocalCliAgents({ rescan: true });
  const selected = status.agents.find((agent) => agent.id === localCli.agentId);
  if (status.enabled && selected?.runnable) return null;
  const agentLabel = selected?.name || localCliLabel(localCli);
  const unavailableError = status.error
    ? `Local CLI mode is unavailable in this environment: ${status.error}`
    : "Local CLI mode is unavailable in this environment.";
  return jsonResponse({
    error: status.enabled
      ? `${agentLabel} is not ready for local-cli ${surface}.`
      : unavailableError,
    code: "LOCAL_CLI_UNAVAILABLE",
    runtime,
    localCli,
    agent: selected ?? null,
    enabled: status.enabled,
    setupHint: selected?.setupHint || status.error || "Install and authenticate the selected local CLI agent, then rescan Execution settings.",
  }, 400, req);
}

// ---------------------------------------------------------------------------
// Sourceless routing brain (POST /api/route)
//
// The user's selected local CLI agent decides where a free-text query goes:
// a Wiki/Docs generation, an Ask Q&A, a Terminal workspace, or a clarification.
// Reliability comes from a strict JSON prompt + tolerant parser (extractDecision)
// + a normalizer that always degrades to "clarify" rather than throwing.
// ---------------------------------------------------------------------------

export type RouteAction = "wiki" | "docs" | "ask" | "terminal" | "clarify";

export interface RouteSuggestion {
  label: string;
  action: RouteAction;
  source: string | null;
}

export interface RouteDecision {
  action: RouteAction;
  source: string | null;
  question: string | null;
  style: string | null;
  /**
   * For style "custom": a polished, well-formed style instruction the brain
   * expanded from the user's freeform request (e.g. "funny sarcastic" ->
   * "Write in a witty, irreverent tone...") so the generated wiki matches the
   * intended vibe while staying technically accurate. Null for named styles.
   */
  stylePrompt: string | null;
  pageCount: number | null;
  why: string;
  suggestions: RouteSuggestion[];
}

const ROUTE_ACTIONS: ReadonlySet<RouteAction> = new Set<RouteAction>([
  "wiki",
  "docs",
  "ask",
  "terminal",
  "clarify",
]);

// Wiki style ids the brain may pick (mirrors WIKI_HOTKEY_STYLE_OPTIONS in
// apps/desktop/src/app-state.ts). "documentation" is implied by the docs action.
const ROUTE_WIKI_STYLES: ReadonlySet<string> = new Set<string>([
  "basic",
  "technical",
  "first-30",
  "eli5",
  "mental-model",
  "socratic-exploration",
  "feature-scout",
  "worth-stealing",
  "hidden-quirks",
  "pattern-discovery",
  "repo-comparison",
  "debugging-atlas",
  "tech-reader",
]);
const ROUTE_PAGE_COUNT_MAX = 30;

const ROUTE_AGENT_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.GROK_WIKI_ROUTE_TIMEOUT_MS || process.env.RLM_WIKI_ROUTE_TIMEOUT_MS || 30_000),
);

export function buildRouteSystemPrompt(query: string): string {
  return [
    "You are the routing brain for Grok-Wiki, a tool that explains and works with code repositories.",
    "Classify the user's request into exactly one action and return the decision as JSON.",
    "",
    "Actions:",
    '- "wiki": generate an explanatory wiki for a codebase. Use when the user wants to understand/learn/explore a repo.',
    '- "docs": generate reference documentation for a codebase. Use when the user explicitly wants docs/API reference.',
    '- "ask": answer a specific question (optionally about a repo) with evidence. Use for direct Q&A.',
    '- "terminal": open an interactive CLI agent in a repo workspace. Use for hands-on coding/editing/running commands.',
    '- "clarify": the request is too vague or missing a repository; ask the user for more detail.',
    "",
    "Rules:",
    "- Extract any GitHub repository (owner/repo or full URL) or local path into `source`. Use null if none is present.",
    "- `question` is the cleaned natural-language question to forward to Ask; set it only for action \"ask\", else null.",
    "- `style` (wiki only): pick the format the user asked for from this list, else \"technical\":",
    "    basic, technical, first-30, eli5, mental-model, socratic-exploration, feature-scout,",
    "    worth-stealing, hidden-quirks, pattern-discovery, repo-comparison, debugging-atlas, tech-reader.",
    '    Map natural phrasing, e.g. "explain like I am 5" -> "eli5", "mental model" -> "mental-model",',
    '    "first 30 minutes"/"quick start" -> "first-30". For docs the style is always "documentation".',
    '    If the user asks for a tone/voice/vibe NOT covered by the list (e.g. "funny", "sarcastic",',
    '    "as a pirate", "in the style of a noir detective"), set style to "custom".',
    "- `stylePrompt` (only when style is \"custom\"): expand the user's freeform request into a polished,",
    "    well-formed style instruction for the wiki author. Capture the requested tone/voice/persona",
    "    precisely, add a little helpful specificity, and ALWAYS require that it stays technically accurate",
    '    and useful. Example: user "funny sarcastic wiki" -> stylePrompt: "Write in a witty, irreverent,',
    '    sarcastic voice with playful asides and dry humor, while keeping every technical claim accurate',
    '    and the explanations genuinely useful." Null for any non-custom style.',
    "- `pageCount` (wiki/docs only): an integer 1-30, or null.",
    '    1. If the user names an explicit number, use it exactly: "3 page wiki" -> 3, "a quick 5-page overview" -> 5.',
    "    2. Otherwise BALLPARK a sensible count from the scope/intent of the request, sized to the topic:",
    '       - a narrow/quick ask ("quick overview", "first 30 minutes", "just the auth flow", one subsystem) -> ~5-8',
    '       - a normal "explain this repo" with no scope qualifier -> ~12-18',
    '       - an explicitly broad/deep ask ("comprehensive", "deep dive", "everything", "full reference",',
    "         a large multi-module system) -> ~22-30",
    "       Pick a single number in the appropriate band; do not pad. Prefer fewer well-scoped pages over many thin ones.",
    "    3. Use null ONLY when you genuinely cannot tell the scope (e.g. action is not wiki/docs, or the request is bare).",
    "- `why` is a single short sentence (no markdown) explaining the choice, shown to the user.",
    "- `suggestions` is an array (possibly empty) of up to 3 alternative follow-ups, each { label, action, source }.",
    "- If no repository is given and the request needs one, prefer action \"clarify\".",
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "action": "wiki" | "docs" | "ask" | "terminal" | "clarify",',
    '  "source": "owner/repo or URL or /local/path or null",',
    '  "question": "cleaned question for Ask, or null",',
    '  "style": "one of the style ids above, \\"custom\\", or null",',
    '  "stylePrompt": "polished style instruction when style is custom, else null",',
    // Show null (the unspecified default) as the example, NOT a concrete number:
    // LLMs copy the example literal, and a "3" here made every routed wiki come
    // out at 3 pages even when the user said nothing about page count. Only emit
    // a number when the user explicitly asks (the prose rule above covers that).
    '  "pageCount": null,',
    '  "why": "one short sentence",',
    '  "suggestions": [ { "label": "...", "action": "ask", "source": "owner/repo or null" } ]',
    "}",
    "```",
    "",
    "# User request",
    query,
  ].join("\n");
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

export function clarifyRouteDecision(why?: string): RouteDecision {
  return {
    action: "clarify",
    source: null,
    question: null,
    style: null,
    stylePrompt: null,
    pageCount: null,
    why: why && why.trim()
      ? why.trim()
      : "I couldn't confidently route that. Tell me the repository or what you'd like to do.",
    suggestions: [],
  };
}

function coerceRoutePageCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1) return null;
  return Math.min(rounded, ROUTE_PAGE_COUNT_MAX);
}

export function normalizeRouteDecision(parsed: unknown): RouteDecision {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return clarifyRouteDecision();
  }
  const raw = parsed as Record<string, unknown>;
  const action = typeof raw.action === "string" && ROUTE_ACTIONS.has(raw.action as RouteAction)
    ? (raw.action as RouteAction)
    : null;
  if (!action) return clarifyRouteDecision(coerceNullableString(raw.why) ?? undefined);

  const source = coerceNullableString(raw.source);
  const styleRaw = coerceNullableString(raw.style);
  const stylePromptRaw = coerceNullableString(raw.stylePrompt);
  // Validate the style: known named style, or "custom" (freeform vibe) when the
  // brain supplied a polished stylePrompt; unknown -> default technical.
  let style: string | null = null;
  let stylePrompt: string | null = null;
  if (action === "docs") {
    style = "documentation";
  } else if (action === "wiki") {
    if (styleRaw === "custom" && stylePromptRaw) {
      style = "custom";
      stylePrompt = stylePromptRaw;
    } else if (styleRaw && ROUTE_WIKI_STYLES.has(styleRaw)) {
      style = styleRaw;
    } else {
      style = "technical";
    }
  }
  const pageCount = action === "wiki" || action === "docs" ? coerceRoutePageCount(raw.pageCount) : null;
  const question = action === "ask" ? coerceNullableString(raw.question) : null;

  const suggestions: RouteSuggestion[] = Array.isArray(raw.suggestions)
    ? raw.suggestions
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const s = entry as Record<string, unknown>;
          const sAction = typeof s.action === "string" && ROUTE_ACTIONS.has(s.action as RouteAction)
            ? (s.action as RouteAction)
            : null;
          const label = coerceNullableString(s.label);
          if (!sAction || !label) return null;
          return { label, action: sAction, source: coerceNullableString(s.source) } satisfies RouteSuggestion;
        })
        .filter((entry): entry is RouteSuggestion => entry !== null)
        .slice(0, 3)
    : [];

  return {
    action,
    source,
    question,
    style,
    stylePrompt,
    pageCount,
    why: coerceNullableString(raw.why) ?? "Routing your request.",
    suggestions,
  };
}

/**
 * Parse a routing decision out of an agent's raw text. Always returns a valid
 * contract: on parse failure it degrades to a "clarify" decision rather than throwing.
 */
export function routeDecisionFromRawText(rawText: string): RouteDecision {
  const parsed = extractDecision(rawText);
  if (!parsed) return clarifyRouteDecision();
  return normalizeRouteDecision(parsed);
}

/**
 * True when the agent's raw text did NOT contain a parseable decision object.
 * Used to decide whether a repair turn is warranted (bad JSON) versus accepting
 * a genuine decision the agent made (including a real "clarify").
 */
export function routeRawTextHasDecision(rawText: string): boolean {
  return extractDecision(rawText) !== null;
}

// One follow-up turn that insists on a clean contract. The agent still decides —
// the harness only insists the decision come back as parseable JSON.
export function buildRouteRepairPrompt(query: string, badReply: string): string {
  return [
    "Your previous reply could not be parsed as the required JSON routing decision.",
    "Return ONLY a single fenced ```json block matching the schema — no prose before or after.",
    "",
    "Schema:",
    "{",
    '  "action": "wiki" | "docs" | "ask" | "terminal" | "clarify",',
    '  "source": "owner/repo or URL or /local/path or null",',
    '  "question": "cleaned question for Ask, or null",',
    '  "style": "a style id, \\"custom\\", or null",',
    '  "stylePrompt": "polished style instruction when style is custom, else null",',
    '  "pageCount": number or null,',
    '  "why": "one short sentence",',
    '  "suggestions": []',
    "}",
    "",
    "# Original user request",
    query,
    "",
    "# Your previous (unparseable) reply",
    badReply.slice(0, 2000),
  ].join("\n");
}

export interface RouteAgentRunner {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal): Promise<string>;
}

async function defaultRouteAgentRunner(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
): Promise<string> {
  const agent = new LocalCliAgent({
    mode: "chat",
    contextLabel: "chat",
    localCli,
  });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

/**
 * Run the selected CLI agent on the routing prompt and return a routing decision.
 * Honors the passed agentId; degrades to "clarify" on any agent/parse failure.
 */
export async function runRouteDecision(
  query: string,
  localCli: LocalCliConfig,
  runner: RouteAgentRunner = defaultRouteAgentRunner,
  timeoutMs: number = ROUTE_AGENT_TIMEOUT_MS,
): Promise<RouteDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("route timeout"), timeoutMs);
  try {
    const rawText = await runner(buildRouteSystemPrompt(query), localCli, controller.signal);
    // Agent-first with a repair turn: if the reply isn't parseable JSON (prose
    // wrapping, trailing commas, etc.), insist ONCE that the agent re-emit clean
    // JSON rather than silently degrading to clarify/defaults. The agent still
    // makes the decision — the harness only guides it to a usable shape.
    if (routeRawTextHasDecision(rawText)) {
      return routeDecisionFromRawText(rawText);
    }
    const repaired = await runner(buildRouteRepairPrompt(query, rawText), localCli, controller.signal);
    return routeDecisionFromRawText(repaired);
  } catch (error) {
    return clarifyRouteDecision(
      `The routing agent could not respond (${error instanceof Error ? error.message : String(error)}).`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function providerSetupDetailsFromMessage(message: string): Record<string, unknown> {
  if (!/one-time connection|approval window|connect .* in the model picker/i.test(message)) return {};
  const providers: Array<{ provider: Provider; pattern: RegExp }> = [
    { provider: "gemini", pattern: /\bGemini\b/i },
    { provider: "openrouter", pattern: /\bOpenRouter\b/i },
    { provider: "deepseek", pattern: /\bDeepSeek\b/i },
    { provider: "minimax", pattern: /\bMiniMax\b/i },
    { provider: "anthropic", pattern: /\bClaude\b|\bAnthropic\b/i },
    { provider: "openai", pattern: /\bOpenAI\b|\bGPT\b/i },
    { provider: "codex", pattern: /\bCodex\b/i },
  ];
  const match = providers.find((row) => row.pattern.test(message));
  if (!match) return {};
  return {
    code: "PROVIDER_SETUP_REQUIRED",
    provider: match.provider,
    setup: providerSetupInfo(match.provider),
  };
}

function capabilitySettingsFilePath(root: string): string {
  return join(root, "config", "capabilities.json");
}

async function hydrateCapabilitySettingsCache(
  root: string,
  productStore: ProductStore,
  profile: CapabilityProfileOptions,
): Promise<CapabilitySettings> {
  if (productStore.mode !== "file") {
    const artifact = await productStore.getArtifact(CAPABILITY_SETTINGS_ARTIFACT_KIND, CAPABILITY_SETTINGS_ARTIFACT_KEY);
    if (artifact) {
      return saveCapabilitySettings(root, artifact.data as unknown as CapabilitySettings, profile);
    }
  }

  const settings = loadCapabilitySettings(root, profile);
  if (productStore.mode !== "file" && existsSync(capabilitySettingsFilePath(root))) {
    await persistCapabilitySettings(productStore, settings);
  }
  return settings;
}

async function persistCapabilitySettings(
  productStore: ProductStore,
  settings: CapabilitySettings,
): Promise<void> {
  if (productStore.mode === "file") return;
  await productStore.upsertArtifact({
    kind: CAPABILITY_SETTINGS_ARTIFACT_KIND,
    key: CAPABILITY_SETTINGS_ARTIFACT_KEY,
    data: settings as unknown as Record<string, unknown>,
  });
}

function publicBaseUrl(req: Request): string {
  const configured = process.env.RLM_WIKI_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "") || "https";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function normalizePublicWikiId(value: string): string {
  const clean = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{7,95}$/.test(clean) ? clean : "";
}

function publicWikiIdFromApiPath(pathname: string): string {
  return publicWikiIdFromPath(pathname, "/api/public/wiki/");
}

function publicWikiIdFromUiPath(pathname: string): string {
  return publicWikiIdFromPath(pathname, "/public/wiki/");
}

function publicDocsIdFromUiPath(pathname: string): string {
  return publicWikiIdFromPath(pathname, "/public/docs/");
}

function publicWikiIdFromPath(pathname: string, prefix: string): string {
  if (!pathname.startsWith(prefix)) return "";
  const raw = pathname.slice(prefix.length).replace(/\/+$/, "");
  if (!raw || raw.includes("/")) return "";
  try {
    return normalizePublicWikiId(decodeURIComponent(raw));
  } catch {
    return "";
  }
}

function publicWikiSurfaceFromRecord(record: Partial<WikiRecord> | Record<string, unknown> | null | undefined): "wiki" | "docs" {
  return String(record?.wikiStyle || (record as { input?: { style?: unknown } } | null | undefined)?.input?.style || "") === "documentation" ? "docs" : "wiki";
}

function publicWikiSurfaceFromData(data: Record<string, unknown> | null | undefined): "wiki" | "docs" {
  if (data?.surface === "docs") return "docs";
  return publicWikiSurfaceFromRecord(jsonObject(data?.wiki));
}

function publicWikiPath(publicId: string, visibility?: PublicWikiVisibility | null, surface: "wiki" | "docs" = "wiki"): string {
  const surfacePart = surface === "docs" ? "docs" : "wiki";
  const prefix = normalizePublicWikiVisibility(visibility) === "private" ? `/share/${surfacePart}` : `/public/${surfacePart}`;
  return `${prefix}/${encodeURIComponent(publicId)}`;
}

function publicWikiUrl(req: Request, publicId: string, visibility?: PublicWikiVisibility | null, surface: "wiki" | "docs" = "wiki"): string {
  return `${publicBaseUrl(req)}${publicWikiPath(publicId, visibility, surface)}`;
}

function makePublicWikiId(owner: string, repo: string): string {
  const prefix = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 44) || "wiki";
  return `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function publicationStateFromData(data: Record<string, unknown> | null, req?: Request): Record<string, unknown> {
  const publicId = typeof data?.publicId === "string" ? normalizePublicWikiId(data.publicId) : "";
  const published = Boolean(publicId && data?.published === true);
  const explicitPublicUrl = typeof data?.publicUrl === "string" ? data.publicUrl : "";
  const visibility = normalizePublicWikiVisibility(data?.visibility);
  const surface = publicWikiSurfaceFromData(data);
  return {
    published,
    publicId: publicId || null,
    publicPath: published && publicId ? publicWikiPath(publicId, visibility, surface) : null,
    publicUrl: published && publicId ? explicitPublicUrl || (req ? publicWikiUrl(req, publicId, visibility, surface) : null) : null,
    publishedAt: typeof data?.publishedAt === "string" ? data.publishedAt : null,
    updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
    unpublishedAt: typeof data?.unpublishedAt === "string" ? data.unpublishedAt : null,
    title: typeof data?.title === "string" ? data.title : null,
    readOnly: true,
    visibility,
    surface,
    needsUpdate: data?.needsUpdate === true,
  };
}

function publicWikiRecord(record: WikiRecord): Record<string, unknown> {
  return sanitizePublicWikiRecord(record) as unknown as Record<string, unknown>;
}

function publicWikiArtifactData(args: {
  publicId: string;
  record: WikiRecord;
  visibility?: PublicWikiVisibility | null;
  publishedAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    publicId: args.publicId,
    published: true,
    visibility: normalizePublicWikiVisibility(args.visibility),
    surface: publicWikiSurfaceFromRecord(args.record),
    readOnly: true,
    owner: args.record.owner,
    repo: args.record.repo,
    id: args.record.id ?? null,
    repos: args.record.repos,
    branch: args.record.branch ?? null,
    sourcePath: args.record.sourcePath ?? null,
    title: args.record.structure.title,
    publishedAt: args.publishedAt,
    updatedAt: args.updatedAt,
    wiki: publicWikiRecord(args.record),
  };
}

async function loadWikiRecord(
  productStore: ProductStore,
  store: WikiStore,
  args: { id?: string | null; owner?: string | null; repo?: string | null; branch?: string | null; sourcePath?: string | null },
): Promise<WikiRecord | null> {
  const id = String(args.id || "").trim();
  if (id) {
    const artifact = await productStore.getArtifact("wiki", wikiInstanceArtifactKey(id)).catch(() => null);
    if (artifact) return WikiRecordSchema.parse(artifact.data);
    const fileRecord = store.loadById(id);
    if (fileRecord) return fileRecord;
    return null;
  }
  const owner = String(args.owner || "").trim();
  const repo = String(args.repo || "").trim();
  const branch = args.branch == null ? null : String(args.branch).trim() || null;
  const sourcePath = normalizeRepoSourcePath(args.sourcePath);
  if (!owner || !repo) return null;
  const artifact = branch || sourcePath
    ? await productStore.getArtifact("wiki", wikiArtifactKey(owner, repo, branch, sourcePath)).catch(() => null)
    : null;
  const defaultArtifact = artifact ?? await productStore.getArtifact("wiki", wikiArtifactKey(owner, repo)).catch(() => null);
  return defaultArtifact ? WikiRecordSchema.parse(defaultArtifact.data) : store.loadForRef({ owner, repo, branch, sourcePath });
}

function wikiPublicationArtifactKey(args: { id?: string | null; owner: string; repo: string; branch?: string | null; sourcePath?: string | null }): string {
  const id = String(args.id || "").trim();
  return id ? wikiInstanceArtifactKey(id) : wikiArtifactKey(args.owner, args.repo, args.branch, normalizeRepoSourcePath(args.sourcePath));
}

async function syncPublishedWikiRecord(
  ownerStore: ProductStore,
  publicStore: ProductStore,
  record: WikiRecord,
  runId: string | null = null,
): Promise<void> {
  const key = wikiRecordArtifactKey(record);
  const publicationArtifact = await ownerStore.getArtifact(WIKI_PUBLICATION_ARTIFACT_KIND, key);
  const publicationData = publicationArtifact ? jsonObject(publicationArtifact.data) : null;
  const publicId = typeof publicationData?.publicId === "string" ? normalizePublicWikiId(publicationData.publicId) : "";
  if (!publicId || publicationData?.published !== true) return;

  const updatedAt = new Date().toISOString();
  const publishedAt = typeof publicationData.publishedAt === "string" ? publicationData.publishedAt : updatedAt;
  const visibility = normalizePublicWikiVisibility(publicationData.visibility);
  await publicStore.upsertArtifact({
    kind: PUBLIC_WIKI_ARTIFACT_KIND,
    key: publicId,
    runId,
    data: publicWikiArtifactData({ publicId, record, visibility, publishedAt, updatedAt }),
  });
  await ownerStore.upsertArtifact({
    kind: WIKI_PUBLICATION_ARTIFACT_KIND,
    key,
    runId,
    data: {
      ...publicationData,
      publicId,
      published: true,
      visibility,
      readOnly: true,
      title: record.structure.title,
      id: record.id ?? null,
      owner: record.owner,
      repo: record.repo,
      branch: record.branch ?? null,
      publishedAt,
      updatedAt,
    },
  });
}

function publicSiteBaseUrl(): string {
  return (process.env.GROK_WIKI_PUBLIC_URL || process.env.RLM_WIKI_PUBLIC_URL || "https://grok-wiki.com")
    .trim()
    .replace(/\/+$/, "");
}

function publicGallerySearchUrl(sourceUrl: URL, baseUrl = publicSiteBaseUrl()): string {
  const target = new URL(`${baseUrl}/api/public/wiki`);
  for (const key of ["q", "sort", "format", "pages", "page", "pageSize"]) {
    const value = sourceUrl.searchParams.get(key);
    if (value != null) target.searchParams.set(key, value);
  }
  return target.toString();
}

function publicGalleryAbsoluteUrl(baseUrl: string, value: unknown): string {
  const href = String(value || "").trim();
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${href.startsWith("/") ? href : `/${href}`}`;
}

async function publishWikiRecordToPublicSite(
  record: WikiRecord,
  existingData: Record<string, unknown>,
  visibility: PublicWikiVisibility,
): Promise<{ publication: Record<string, unknown>; managementToken?: string }> {
  const publicId = typeof existingData.publicId === "string" ? normalizePublicWikiId(existingData.publicId) : "";
  const managementToken = typeof existingData.managementToken === "string" ? existingData.managementToken : "";
  const baseUrl = publicSiteBaseUrl();
  const url = publicId ? `${baseUrl}/api/public/wiki/${encodeURIComponent(publicId)}` : `${baseUrl}/api/public/wiki`;
  const response = await fetch(url, {
    method: publicId ? "PUT" : "POST",
    headers: {
      "content-type": "application/json",
      ...(managementToken ? { "x-grok-wiki-publish-token": managementToken } : {}),
    },
    body: JSON.stringify({
      wiki: sanitizePublicWikiRecord(record),
      visibility,
      managementToken: managementToken || undefined,
    }),
  });
  const payload = jsonObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Publish failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    publication: jsonObject(payload.publication),
    managementToken: typeof payload.managementToken === "string" ? payload.managementToken : undefined,
  };
}

async function unpublishWikiRecordFromPublicSite(
  existingData: Record<string, unknown>,
): Promise<{ publication: Record<string, unknown> }> {
  const publicId = typeof existingData.publicId === "string" ? normalizePublicWikiId(existingData.publicId) : "";
  const managementToken = typeof existingData.managementToken === "string" ? existingData.managementToken : "";
  if (!publicId || !managementToken) {
    return {
      publication: {
        ...existingData,
        publicId: publicId || null,
        published: false,
        publicUrl: null,
        visibility: normalizePublicWikiVisibility(existingData.visibility),
        updatedAt: new Date().toISOString(),
      },
    };
  }
  const response = await fetch(`${publicSiteBaseUrl()}/api/public/wiki/${encodeURIComponent(publicId)}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-grok-wiki-publish-token": managementToken,
    },
    body: JSON.stringify({ managementToken }),
  });
  const payload = jsonObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Unpublish failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return { publication: jsonObject(payload.publication) };
}

function askPublicationArtifactKey(askId: string): string {
  return `ask:${String(askId || "").trim()}`;
}

function askPublicationStateFromData(data: Record<string, unknown> | null): Record<string, unknown> {
  const publicId = typeof data?.publicId === "string" ? normalizePublicAskId(data.publicId) : "";
  const published = Boolean(publicId && data?.published === true);
  const explicitPublicUrl = typeof data?.publicUrl === "string" ? data.publicUrl : "";
  const visibility = normalizePublicAskVisibility(data?.visibility);
  return {
    published,
    publicId: publicId || null,
    publicPath: published && publicId ? publicAskPath(publicId, visibility) : null,
    publicUrl: published && publicId
      ? explicitPublicUrl || `${publicSiteBaseUrl()}${publicAskPath(publicId, visibility)}`
      : null,
    publishedAt: typeof data?.publishedAt === "string" ? data.publishedAt : null,
    updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : null,
    unpublishedAt: typeof data?.unpublishedAt === "string" ? data.unpublishedAt : null,
    title: typeof data?.title === "string" ? data.title : null,
    readOnly: true,
    visibility,
    recordVersion: typeof data?.recordVersion === "string" ? data.recordVersion : null,
  };
}

async function publishAskRecordToPublicSite(
  record: PublicAskRecord,
  existingData: Record<string, unknown>,
  visibility: PublicAskVisibility,
): Promise<{ publication: Record<string, unknown>; managementToken?: string }> {
  const publicId = typeof existingData.publicId === "string" ? normalizePublicAskId(existingData.publicId) : "";
  const managementToken = typeof existingData.managementToken === "string" ? existingData.managementToken : "";
  const baseUrl = publicSiteBaseUrl();
  const url = publicId ? `${baseUrl}/api/public/ask/${encodeURIComponent(publicId)}` : `${baseUrl}/api/public/ask`;
  const response = await fetch(url, {
    method: publicId ? "PUT" : "POST",
    headers: {
      "content-type": "application/json",
      ...(managementToken ? { "x-grok-wiki-publish-token": managementToken } : {}),
    },
    body: JSON.stringify({
      ask: record,
      visibility,
      managementToken: managementToken || undefined,
    }),
  });
  const payload = jsonObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Publish failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    publication: jsonObject(payload.publication),
    managementToken: typeof payload.managementToken === "string" ? payload.managementToken : undefined,
  };
}

async function unpublishAskRecordFromPublicSite(
  existingData: Record<string, unknown>,
): Promise<{ publication: Record<string, unknown> }> {
  const publicId = typeof existingData.publicId === "string" ? normalizePublicAskId(existingData.publicId) : "";
  const managementToken = typeof existingData.managementToken === "string" ? existingData.managementToken : "";
  if (!publicId || !managementToken) {
    return {
      publication: {
        ...existingData,
        publicId: publicId || null,
        published: false,
        publicUrl: null,
        visibility: normalizePublicAskVisibility(existingData.visibility),
        updatedAt: new Date().toISOString(),
      },
    };
  }
  const response = await fetch(`${publicSiteBaseUrl()}/api/public/ask/${encodeURIComponent(publicId)}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      "x-grok-wiki-publish-token": managementToken,
    },
    body: JSON.stringify({ managementToken }),
  });
  const payload = jsonObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Unpublish failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return { publication: jsonObject(payload.publication) };
}

function publicationDataWithFreshness(data: Record<string, unknown> | null, record: WikiRecord | null): Record<string, unknown> | null {
  if (!data) return null;
  if (!record || data.published !== true) return data;
  const storedVersion = typeof data.recordVersion === "string" ? data.recordVersion : "";
  const currentVersion = wikiPublicationRecordVersion(record);
  return {
    ...data,
    needsUpdate: Boolean(storedVersion && currentVersion && storedVersion !== currentVersion),
  };
}

async function persistWikiRecordArtifacts(
  ownerStore: ProductStore,
  publicStore: ProductStore,
  record: WikiRecord,
  runId: string,
): Promise<void> {
  const recordWithIdentity = ensureWikiRecordIdentity(record);
  await ownerStore.upsertArtifact({
    kind: "wiki",
    key: wikiRecordArtifactKey(recordWithIdentity),
    runId,
    data: recordWithIdentity as unknown as Record<string, unknown>,
  });
  await syncPublishedWikiRecord(ownerStore, publicStore, recordWithIdentity, runId);
}

async function promoteWikiDraftRun(
  productStore: ProductStore,
  publicStore: ProductStore,
  run: ProductRun,
  message: string,
  meta: Record<string, unknown> = {},
): Promise<ProductRun | null> {
  if (run.kind !== "wiki_generate") return null;
  const draft = await productStore.getArtifact(WIKI_DRAFT_ARTIFACT_KIND, run.id).catch(() => null);
  if (!draft) return null;

  let record: WikiRecord;
  try {
    record = WikiRecordSchema.parse(draft.data);
  } catch {
    return null;
  }

  const completion = wikiRecordCompletion(record as unknown as Record<string, unknown>);
  if (completion.generatedPageCount < 1 && completion.plannedPageCount < 1) return null;

  record = ensureWikiRecordIdentity(record);
  const terminalCompletion = { ...completion, partial: true };
  await persistWikiRecordArtifacts(productStore, publicStore, record, run.id);
  await productStore.upsertArtifact({
    kind: WIKI_DRAFT_ARTIFACT_KIND,
    key: run.id,
    runId: run.id,
    data: {
      ...(record as unknown as Record<string, unknown>),
      checkpoint: {
        phase: "partial",
        missingPageIds: terminalCompletion.missingPageIds,
        failedPageIds: terminalCompletion.failedPageIds,
        recoverablePageIds: terminalCompletion.recoverablePageIds,
      },
      status: "partial",
      warning: message,
    },
  }).catch(() => null);
  await productStore.appendEvent(run.id, "done", {
    record,
    wiki: record,
    completion: terminalCompletion,
    warning: message,
    recovered: true,
    ...meta,
  }).catch(() => null);
  return await productStore.updateRun(run.id, {
    status: "done",
    error: null,
    result: {
      ...jsonObject(run.result),
      wiki: record,
      completion: terminalCompletion,
      warning: message,
      recovered: true,
      processSnapshot: processSnapshotFor(run.id),
    },
  }) ?? run;
}

function publicRepoRef(ref: {
  id?: string;
  owner?: string;
  repo?: string;
  label?: string;
  url?: string;
  branch?: string | null;
  sourcePath?: string | null;
}): PublicRepoRef {
  return {
    ...(ref.id ? { id: String(ref.id) } : {}),
    owner: String(ref.owner || ""),
    repo: String(ref.repo || ""),
    ...(ref.label ? { label: String(ref.label) } : {}),
    url: String(ref.url || ""),
    branch: ref.branch == null ? null : String(ref.branch),
    sourcePath: normalizeRepoSourcePath(ref.sourcePath),
  };
}

function requestedWikiUrls(body: { url?: string; urls?: string[] }): string[] {
  const raw = Array.isArray(body.urls) && body.urls.length > 0
    ? body.urls
    : typeof body.url === "string"
      ? body.url.split(/[\n,]+/)
      : [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(value);
  }
  return urls;
}

function localPathHasGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function normalizeLocalRepoPath(value: string): string {
  const trimmed = splitLocalRepoPathRef(value).path.replace(/^file:\/\//i, "");
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/")
      ? join(homedir(), trimmed.slice(2))
      : trimmed;
  if (
    expanded.startsWith("/") ||
    expanded.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(expanded)
  ) {
    return resolve(expanded);
  }
  const candidates = [resolve(expanded), resolve(homedir(), expanded)];
  return candidates.find(localPathHasGitRepo) ?? candidates.find((path) => existsSync(path)) ?? candidates[0];
}

function splitLocalRepoPathRef(value: string): { path: string; branch: string | null } {
  const trimmed = value.trim();
  const marker = trimmed.lastIndexOf("#");
  if (marker > 0 && marker < trimmed.length - 1) {
    return {
      path: trimmed.slice(0, marker).trim(),
      branch: trimmed.slice(marker + 1).trim() || null,
    };
  }
  return { path: trimmed, branch: null };
}

function looksLikeExplicitLocalPath(value: string): boolean {
  const path = splitLocalRepoPathRef(value).path.trim();
  return path.startsWith("/") ||
    path.startsWith("~") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.toLowerCase().startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(path);
}

function localRepoRefFromPath(value: string, access?: LocalRepoAccess): RepoRef {
  const localAccess = access ?? {
    allowed: desktopEnabled(),
    requireAllowlist: desktopEnabled(),
    requireGit: true,
  };
  if (!localAccess.allowed) {
    throw new Error("Local folders are available on localhost or in the desktop app only.");
  }
  const parsed = splitLocalRepoPathRef(value);
  const repoPath = normalizeLocalRepoPath(parsed.path);
  if (localAccess.requireAllowlist && !DESKTOP_ALLOWED_LOCAL_REPOS.has(repoPath)) {
    throw new Error(localAccess.requireGit
      ? "Open this local repository from the desktop picker before continuing."
      : "Open this local folder from the desktop picker before asking.");
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Local folder does not exist: ${repoPath}`);
  }
  const hasGitRepo = existsSync(join(repoPath, ".git"));
  if (localAccess.requireGit && !hasGitRepo) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
  if (!hasGitRepo && parsed.branch) {
    throw new Error("Branch or ref selection requires a git repository.");
  }
  const repo = basename(repoPath) || "repo";
  return {
    owner: "local",
    repo,
    url: repoPath,
    branch: parsed.branch,
  };
}

function parseRepoInput(input: string, access?: LocalRepoAccess): RepoRef {
  const value = input.trim();
  if (looksLikeExplicitLocalPath(value)) {
    return localRepoRefFromPath(value, access);
  }
  try {
    return parseGithubUrl(input);
  } catch (error) {
    throw error;
  }
}

type RequestedSourceRef = {
  url?: unknown;
  source?: unknown;
  branch?: unknown;
  sourcePath?: unknown;
};

function optionalSourceString(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function stripSourcePathSuffixFromBranch(branch: string | null, sourcePath: string | null): string | null {
  const branchText = String(branch || "").trim().split(/[?#]/)[0] || "";
  const scopedPath = normalizeRepoSourcePath(sourcePath);
  if (!branchText) return null;
  if (!scopedPath) return branchText;

  const branchParts = branchText.split("/").filter(Boolean);
  const pathParts = scopedPath.split("/").filter(Boolean);
  if (!branchParts.length || !pathParts.length || branchParts.length <= pathParts.length) {
    return branchText;
  }

  const branchSuffix = branchParts.slice(-pathParts.length).join("/");
  if (normalizeRepoSourcePath(branchSuffix) !== scopedPath) return branchText;

  return branchParts.slice(0, -pathParts.length).join("/") || branchText;
}

function parseSourceRefInput(input: RequestedSourceRef, access?: LocalRepoAccess): RepoRef {
  const source = optionalSourceString(input.url) || optionalSourceString(input.source);
  if (!source) throw new Error("source ref url required");
  const ref = parseRepoInput(source, access);
  const sourcePath = normalizeRepoSourcePath(input.sourcePath) || ref.sourcePath || null;
  return {
    ...ref,
    branch: stripSourcePathSuffixFromBranch(optionalSourceString(input.branch), sourcePath) || ref.branch || null,
    sourcePath,
  };
}

export function parseAskRefsFromUrls(requestedUrls: string[], access?: LocalRepoAccess): WorkspaceRepoRef[] {
  return parseWorkspaceRefs(requestedUrls.map((repoUrl) => parseRepoInput(repoUrl, access)));
}

export function parseAskRefsFromSourceRefs(sourceRefs: RequestedSourceRef[], access?: LocalRepoAccess): WorkspaceRepoRef[] {
  return parseWorkspaceRefs(sourceRefs.map((sourceRef) => parseSourceRefInput(sourceRef, access)));
}

function parseWorkspaceRefsFromUrls(requestedUrls: string[], access?: LocalRepoAccess): WorkspaceRepoRef[] {
  return parseWorkspaceRefs(requestedUrls.map((repoUrl) => parseRepoInput(repoUrl, access)));
}

function parseWorkspaceRefs(parsedRefs: RepoRef[]): WorkspaceRepoRef[] {
  const seenRefs = new Set<string>();
  return assignWorkspaceRepoIds(parsedRefs.filter((ref) => {
    const key = `${ref.owner}/${ref.repo}@${ref.branch || ""}#${ref.sourcePath || ""}`.toLowerCase();
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  }));
}

function parseWikiRefsFromWorkspaceRefs(refs: WorkspaceRepoRef[]): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  if (!refs.length) throw new Error("url required");
  return {
    ref: wikiRefForWorkspace(refs),
    refs: refs.length > 1 ? refs : undefined,
  };
}

export function parseWikiRefsFromUrls(requestedUrls: string[], access?: LocalRepoAccess): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  if (!requestedUrls.length) throw new Error("url required");
  if (requestedUrls.length > MAX_ASK_REPOS) throw new Error(`at most ${MAX_ASK_REPOS} repositories can be used for one wiki`);
  return parseWikiRefsFromWorkspaceRefs(parseWorkspaceRefsFromUrls(requestedUrls, access));
}

export function parseWikiRefsFromSourceRefs(sourceRefs: RequestedSourceRef[], access?: LocalRepoAccess): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  if (!sourceRefs.length) throw new Error("url required");
  if (sourceRefs.length > MAX_ASK_REPOS) throw new Error(`at most ${MAX_ASK_REPOS} repositories can be used for one wiki`);
  return parseWikiRefsFromWorkspaceRefs(parseWorkspaceRefs(sourceRefs.map((sourceRef) => parseSourceRefInput(sourceRef, access))));
}

function parseWikiRefs(body: { url?: string; urls?: string[]; sourceRefs?: RequestedSourceRef[] }, access?: LocalRepoAccess): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  const sourceRefs = Array.isArray(body.sourceRefs) ? body.sourceRefs : [];
  if (sourceRefs.length) return parseWikiRefsFromSourceRefs(sourceRefs, access);
  const urls = requestedWikiUrls(body);
  return parseWikiRefsFromUrls(urls, access);
}

function requestedCodeUrls(body: { url?: string; urls?: string[] }): string[] {
  const raw = Array.isArray(body.urls) && body.urls.length > 0
    ? body.urls
    : typeof body.url === "string"
      ? [body.url]
      : [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(value);
  }
  return urls;
}

function parseCodeRefs(body: { url?: string; urls?: string[] }, access?: LocalRepoAccess): { ref: RepoRef; refs?: WorkspaceRepoRef[] } {
  const urls = requestedCodeUrls(body);
  if (!urls.length) throw new Error("url required");
  if (urls.length > MAX_ASK_REPOS) throw new Error(`at most ${MAX_ASK_REPOS} repositories can be used for one code run`);
  const refs = parseWorkspaceRefsFromUrls(urls, access);
  if (!refs.length) throw new Error("url required");
  const primary = refs[0];
  return {
    ref: { owner: primary.owner, repo: primary.repo, url: primary.url, branch: primary.branch, sourcePath: primary.sourcePath ?? null },
    refs: refs.length > 1 ? refs : undefined,
  };
}

function slugPathPart(value: unknown, fallback = "untitled"): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

function writeZipU16(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeZipU32(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function appendZipBytes(out: number[], bytes: Uint8Array): void {
  for (const byte of bytes) out.push(byte);
}

function createStoredZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const out: number[] = [];
  const central: number[] = [];
  const { date, time } = dosDateTime();

  for (const file of files) {
    const pathBytes = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const offset = out.length;

    writeZipU32(out, 0x04034b50);
    writeZipU16(out, 20);
    writeZipU16(out, 0x0800);
    writeZipU16(out, 0);
    writeZipU16(out, time);
    writeZipU16(out, date);
    writeZipU32(out, crc);
    writeZipU32(out, data.length);
    writeZipU32(out, data.length);
    writeZipU16(out, pathBytes.length);
    writeZipU16(out, 0);
    appendZipBytes(out, pathBytes);
    appendZipBytes(out, data);

    writeZipU32(central, 0x02014b50);
    writeZipU16(central, 20);
    writeZipU16(central, 20);
    writeZipU16(central, 0x0800);
    writeZipU16(central, 0);
    writeZipU16(central, time);
    writeZipU16(central, date);
    writeZipU32(central, crc);
    writeZipU32(central, data.length);
    writeZipU32(central, data.length);
    writeZipU16(central, pathBytes.length);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU16(central, 0);
    writeZipU32(central, 0);
    writeZipU32(central, offset);
    appendZipBytes(central, pathBytes);
  }

  const centralOffset = out.length;
  appendZipBytes(out, Uint8Array.from(central));
  writeZipU32(out, 0x06054b50);
  writeZipU16(out, 0);
  writeZipU16(out, 0);
  writeZipU16(out, files.length);
  writeZipU16(out, files.length);
  writeZipU32(out, central.length);
  writeZipU32(out, centralOffset);
  writeZipU16(out, 0);
  return Uint8Array.from(out);
}

function normalizeOpenSlideFiles(value: unknown): OpenSlideExportFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = jsonObject(item);
      const path = String(row.path || "").trim().replace(/^\/+/, "");
      const content = typeof row.content === "string" ? row.content : "";
      if (!path || path.includes("..")) return null;
      return { path, content };
    })
    .filter((item): item is OpenSlideExportFile => Boolean(item));
}

function safeDownloadFileName(value: unknown): string {
  const clean = String(value || "")
    .trim()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return clean || "wiki-slides.zip";
}

function normalizeSlideCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(numeric)) return undefined;
  return Math.max(4, Math.min(20, numeric));
}

function wikiSlidesLatestArtifactKey(record: Pick<WikiRecord, "id" | "owner" | "repo" | "branch" | "sourcePath">): string {
  return wikiRecordArtifactKey({
    id: typeof record.id === "string" && record.id.trim() ? record.id : undefined,
    owner: record.owner,
    repo: record.repo,
    branch: record.branch ?? null,
    sourcePath: record.sourcePath ?? null,
  });
}

function wikiSlidesArtifactMatchesRecord(data: Record<string, unknown>, record: WikiRecord): boolean {
  const wikiId = compactString(data.wikiId, 160);
  if (record.id && wikiId) return wikiId === record.id;
    return compactString(data.owner, 160) === record.owner
      && compactString(data.repo, 160) === record.repo
      && compactString(data.branch, 160) === compactString(record.branch, 160)
      && compactString(data.sourcePath, 500) === compactString(record.sourcePath, 500);
}

async function latestSlidesArtifactForWiki(productStore: ProductStore, record: WikiRecord): Promise<string | null> {
  const latest = await productStore.getArtifact(WIKI_SLIDES_LATEST_ARTIFACT_KIND, wikiSlidesLatestArtifactKey(record));
  const latestRunId = latest ? compactString(jsonObject(latest.data).slidesRunId, 160) : "";
  if (latestRunId) {
    const latestRun = await productStore.getRun(latestRunId).catch(() => null);
    if (!latestRun || latestRun.status === "done") return latestRunId;
  }
  const viewerArtifacts = await productStore.listArtifacts(WIKI_SLIDES_VIEWER_ARTIFACT_KIND, { limit: 200 }).catch(() => []);
  for (const artifact of viewerArtifacts) {
    const data = jsonObject(artifact.data);
    const slidesRunId = compactString(data.slidesRunId, 160);
    if (!slidesRunId || !wikiSlidesArtifactMatchesRecord(data, record)) continue;
    const run = await productStore.getRun(slidesRunId).catch(() => null);
    if (!run || run.status === "done") return slidesRunId;
  }
  const slideArtifacts = await productStore.listArtifacts(WIKI_SLIDES_ARTIFACT_KIND, { limit: 200 }).catch(() => []);
  for (const artifact of slideArtifacts) {
    const data = jsonObject(artifact.data);
    const runId = compactString(artifact.latestRunId, 160) || compactString(data.slidesRunId, 160);
    if (!runId || !wikiSlidesArtifactMatchesRecord(data, record)) continue;
    const run = await productStore.getRun(runId).catch(() => null);
    if (!run || run.status === "done") return runId;
  }
  return null;
}

async function ensureWikiSlidesViewer(
  productStore: ProductStore,
  root: string,
  record: WikiRecord,
  slidesRunId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const slidesArtifact = await productStore.getArtifact(WIKI_SLIDES_ARTIFACT_KIND, wikiSlidesArtifactKey(slidesRunId));
  if (!slidesArtifact) throw new Error("slides artifact not found");
  const data = jsonObject(slidesArtifact.data);
  const files = normalizeOpenSlideFiles(data.files);
  if (!files.length) throw new Error("slides artifact has no files");
  const viewer = await buildOpenSlideViewer({ root, slidesRunId, files, signal });
  const result = {
    wikiId: record.id ?? null,
    owner: record.owner,
      repo: record.repo,
      branch: record.branch ?? null,
      sourcePath: record.sourcePath ?? null,
      deckId: compactString(data.deckId, 160),
    slidesRunId,
    sourceHash: viewer.sourceHash,
    viewerId: viewer.viewerId,
    viewerUrl: viewer.viewerUrl,
    downloadUrl: `/api/wiki/slides.zip?slidesRunId=${encodeURIComponent(slidesRunId)}`,
    fileName: compactString(data.fileName, 160) || "wiki-slides.zip",
    cached: viewer.cached,
    builtAt: new Date().toISOString(),
  };
  await productStore.upsertArtifact({
    kind: WIKI_SLIDES_VIEWER_ARTIFACT_KIND,
    key: openSlideViewerArtifactKey(slidesRunId, viewer.sourceHash),
    runId: slidesRunId,
    data: result,
  });
  await productStore.upsertArtifact({
    kind: WIKI_SLIDES_LATEST_ARTIFACT_KIND,
    key: wikiSlidesLatestArtifactKey(record),
    runId: slidesRunId,
    data: result,
  });
  return result;
}

function wikiExportFiles(record: WikiRecord): Array<{ path: string; content: string }> {
  const root = `${slugPathPart(record.owner)}-${slugPathPart(record.repo)}-wiki`;
  const pageMetas = record.structure.pages || [];
  const generatedIds = new Set(Object.keys(record.pages || {}));
  const orderedPageIds = [
    ...pageMetas.map((page) => page.id).filter((pageId) => generatedIds.has(pageId)),
    ...Object.keys(record.pages || {}).filter((pageId) => !pageMetas.some((page) => page.id === pageId)),
  ];
  const files: Array<{ path: string; content: string }> = [];
  const pageEntries: Array<{ id: string; title: string; description: string; path: string; obsidianName: string; sourceFiles: string[] }> = [];
  const usedNames = new Set<string>();

  for (const [index, pageId] of orderedPageIds.entries()) {
    const page = record.pages[pageId];
    if (!page) continue;
    const meta = pageMetas.find((item) => item.id === pageId);
    const title = meta?.title || pageId;
    const baseName = `${String(index + 1).padStart(2, "0")}-${slugPathPart(title)}`;
    let fileName = `${baseName}.md`;
    for (let i = 2; usedNames.has(fileName); i++) fileName = `${baseName}-${i}.md`;
    usedNames.add(fileName);
    const path = `pages/${fileName}`;
    const sourceFiles = Array.isArray(meta?.filePaths) ? meta.filePaths.map(String).filter(Boolean) : [];
    pageEntries.push({
      id: pageId,
      title,
      description: meta?.description || "",
      path,
      obsidianName: fileName.replace(/\.md$/i, ""),
      sourceFiles,
    });
    files.push({
      path: `${root}/${path}`,
      content: wikiObsidianPageMarkdown({
        record,
        pageId,
        title,
        description: meta?.description || "",
        sourceFiles,
        relatedPages: Array.isArray(meta?.relatedPages) ? meta.relatedPages : [],
        content: page.content || "",
      }),
    });
  }

  const pageEntryById = new Map(pageEntries.map((entry) => [entry.id, entry]));
  const missingIds = pageMetas
    .map((page) => page.id)
    .filter((pageId) => !generatedIds.has(pageId));
  const indexMarkdown = [
    "---",
    "grok_wiki: true",
    `title: ${yamlString(record.structure.title)}`,
    `repository: ${yamlString(`${record.owner}/${record.repo}`)}`,
    `branch: ${yamlString(record.branch || "default")}`,
    `generated_at: ${yamlString(record.generatedAt)}`,
    `pages: ${pageEntries.length}`,
    "---",
    "",
    `# ${record.structure.title}`,
    "",
    record.structure.description || "",
    "",
    `- Repository: ${record.owner}/${record.repo}`,
    `- Branch: ${record.branch || "default"}`,
    `- Generated at: ${record.generatedAt}`,
    `- Pages exported: ${pageEntries.length}/${pageMetas.length || pageEntries.length}`,
    "",
    "## Pages",
    "",
    pageEntries.map((entry) => `- [[${entry.obsidianName}|${entry.title}]]`).join("\n") || "_No generated pages were available._",
    "",
    "## Files",
    "",
    "- [[sources|Source file index]]",
    "- `manifest.json`",
    ...(missingIds.length ? ["", "## Missing Pages", "", ...missingIds.map((pageId) => `- ${pageMetas.find((page) => page.id === pageId)?.title || pageId}`)] : []),
    "",
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");

  return [
    { path: `${root}/README.md`, content: indexMarkdown },
    { path: `${root}/sources.md`, content: wikiObsidianSourcesMarkdown(record, pageEntries) },
    { path: `${root}/manifest.json`, content: JSON.stringify(wikiExportManifest(record, pageEntries), null, 2) },
    { path: `${root}/.obsidian/app.json`, content: JSON.stringify({ alwaysUpdateLinks: true, promptDelete: false }, null, 2) },
    ...files,
  ];
}

function wikiObsidianPageMarkdown(args: {
  record: WikiRecord;
  pageId: string;
  title: string;
  description: string;
  sourceFiles: string[];
  relatedPages: string[];
  content: string;
}): string {
  const frontmatter = [
    "---",
    "grok_wiki: true",
    `page_id: ${yamlString(args.pageId)}`,
    `title: ${yamlString(args.title)}`,
    `repository: ${yamlString(`${args.record.owner}/${args.record.repo}`)}`,
    `branch: ${yamlString(args.record.branch || "default")}`,
    `generated_at: ${yamlString(args.record.generatedAt)}`,
    ...(args.sourceFiles.length ? ["source_files:", ...args.sourceFiles.map((file) => `  - ${yamlString(file)}`)] : ["source_files: []"]),
    "---",
    "",
  ];
  const related = args.relatedPages.length
    ? ["", "## Related pages", "", ...args.relatedPages.map((pageId) => `- ${pageId}`), ""]
    : [];
  const sources = args.sourceFiles.length
    ? ["", "## Source files", "", ...args.sourceFiles.map((file) => `- \`${file}\``), ""]
    : [];
  return [
    ...frontmatter,
    args.content.trim() || `# ${args.title}\n\n_No generated content was available for this page._`,
    ...related,
    ...sources,
  ].join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

function wikiObsidianSourcesMarkdown(
  record: WikiRecord,
  pageEntries: Array<{ title: string; obsidianName: string; sourceFiles: string[] }>,
): string {
  const byFile = new Map<string, string[]>();
  for (const page of pageEntries) {
    for (const source of page.sourceFiles) {
      const pages = byFile.get(source) || [];
      pages.push(`[[${page.obsidianName}|${page.title}]]`);
      byFile.set(source, pages);
    }
  }
  const rows = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return [
    "---",
    "grok_wiki: true",
    `title: ${yamlString(`${record.structure.title} sources`)}`,
    "---",
    "",
    `# Source file index`,
    "",
    rows.length
      ? rows.map(([file, pages]) => `- \`${file}\` - ${pages.join(", ")}`).join("\n")
      : "_No source files were recorded for this export._",
    "",
  ].join("\n");
}

function wikiExportManifest(
  record: WikiRecord,
  pageEntries: Array<{ id: string; title: string; description: string; path: string; sourceFiles: string[] }>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    title: record.structure.title,
    description: record.structure.description,
    repository: `${record.owner}/${record.repo}`,
    branch: record.branch || null,
    generatedAt: record.generatedAt,
    format: "obsidian-markdown-vault",
    privacy: "local-export",
    pages: pageEntries.map((page) => ({
      id: page.id,
      title: page.title,
      description: page.description,
      path: page.path,
      sourceFiles: page.sourceFiles,
    })),
  };
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function wikiPrintExportHtml(record: WikiRecord): string {
  const pageMetas = record.structure.pages || [];
  const generatedIds = new Set(Object.keys(record.pages || {}));
  const orderedPageIds = [
    ...pageMetas.map((page) => page.id).filter((pageId) => generatedIds.has(pageId)),
    ...Object.keys(record.pages || {}).filter((pageId) => !pageMetas.some((page) => page.id === pageId)),
  ];
  const pages = orderedPageIds
    .map((pageId, index) => {
      const page = record.pages[pageId];
      if (!page) return "";
      const meta = pageMetas.find((item) => item.id === pageId);
      const title = meta?.title || pageId;
      const description = meta?.description || "";
      const sourceFiles = Array.isArray(meta?.filePaths) ? meta.filePaths.map(String).filter(Boolean) : [];
      return `<article class="wiki-print-page">
        <header class="wiki-print-page-head">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <h2>${htmlEscape(title)}</h2>
          ${description ? `<p>${htmlEscape(description)}</p>` : ""}
        </header>
        <section class="wiki-print-markdown">${wikiPrintMarkdownHtml(page.content || "", record)}</section>
        ${sourceFiles.length ? `<section class="wiki-print-sources"><h3>Source files</h3><ul>${sourceFiles.map((file) => `<li><code>${htmlEscape(file)}</code></li>`).join("")}</ul></section>` : ""}
      </article>`;
    })
    .filter(Boolean)
    .join("\n");
  const title = record.structure.title || `${record.owner}/${record.repo} Wiki`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)} - Grok-Wiki PDF Export</title>
  <style>${wikiPrintCss()}</style>
</head>
<body>
  <div class="wiki-print-toolbar no-print">
    <strong>Grok-Wiki PDF export</strong>
    <span>This page stays local. Use Save as PDF in the print dialog.</span>
    <button type="button" onclick="window.print()">Print / Save PDF</button>
  </div>
  <main class="wiki-print-document">
    <section class="wiki-print-cover">
      <p class="wiki-print-kicker">Grok-Wiki</p>
      <h1>${htmlEscape(title)}</h1>
      ${record.structure.description ? `<p>${htmlEscape(record.structure.description)}</p>` : ""}
      <dl>
        <div><dt>Repository</dt><dd>${htmlEscape(`${record.owner}/${record.repo}`)}</dd></div>
        <div><dt>Branch</dt><dd>${htmlEscape(record.branch || "default")}</dd></div>
        <div><dt>Generated</dt><dd>${htmlEscape(record.generatedAt)}</dd></div>
        <div><dt>Pages</dt><dd>${orderedPageIds.length}</dd></div>
      </dl>
    </section>
    ${pages || `<article class="wiki-print-page"><p>No generated pages were available.</p></article>`}
  </main>
  <script>
    window.addEventListener("load", () => {
      window.setTimeout(() => window.print(), 350);
    });
  </script>
</body>
</html>`;
}

function wikiPrintMarkdownHtml(markdown: string, record: WikiRecord): string {
  return renderMarkdownBlocks(markdown, true, null, {
    escape: htmlEscape,
    sourceTextLabel: (source) => source,
    isSourceReference: (source) => /^[A-Za-z0-9._/-]+(?::\d+(?:-\d+)?)?$/.test(source),
    sourceLink: (label, ref) => wikiPrintSourceLink(label, ref, record),
    renderMermaidBlock: (code) => `<div class="wiki-print-diagram"><pre>${htmlEscape(code)}</pre></div>`,
    icon: () => "",
  });
}

function wikiPrintSourceLink(label: string, ref: string, record: WikiRecord): string {
  const source = String(ref || label || "").replace(/^`|`$/g, "");
  const match = source.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/);
  const file = wikiRecordSourceFile(record, match?.[1] || source);
  const line = match?.[2] ? `#L${match[2]}` : "";
  const branch = String(record.branch || "HEAD").split("/").map(encodeURIComponent).join("/");
  const repoUrl = String(record.repoUrl || "");
  const href = repoUrl.startsWith("https://github.com/")
    ? `${repoUrl.replace(/\/$/, "")}/blob/${branch}/${file.split("/").map(encodeURIComponent).join("/")}${line}`
    : "";
  return href
    ? `<a class="source-link" href="${htmlEscape(href)}">${htmlEscape(label)}</a>`
    : `<code>${htmlEscape(label)}</code>`;
}

function wikiRecordSourceFile(record: WikiRecord, file: string): string {
  const cleanFile = normalizeRepoSourcePath(file) || String(file || "").replace(/^\/+/, "");
  const sourcePath = normalizeRepoSourcePath(record.sourcePath);
  if (!sourcePath || !cleanFile || cleanFile === sourcePath || cleanFile.startsWith(`${sourcePath}/`)) {
    return cleanFile;
  }
  return `${sourcePath}/${cleanFile}`;
}

function wikiPrintCss(): string {
  return `
    :root { color-scheme: light; --text:#20211f; --muted:#686963; --line:#d8d8d1; --soft:#f5f5f0; --accent:#111; }
    * { box-sizing: border-box; }
    body { margin:0; background:#f6f6f1; color:var(--text); font:15px/1.58 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .wiki-print-toolbar { position:sticky; top:0; z-index:10; display:flex; gap:14px; align-items:center; padding:12px 18px; border-bottom:1px solid var(--line); background:rgba(246,246,241,.9); backdrop-filter:blur(14px); }
    .wiki-print-toolbar span { color:var(--muted); font-size:13px; }
    .wiki-print-toolbar button { margin-left:auto; border:1px solid #222; border-radius:999px; background:#222; color:white; padding:8px 13px; font:inherit; cursor:pointer; }
    .wiki-print-document { width:min(900px, calc(100vw - 36px)); margin:28px auto 72px; }
    .wiki-print-cover, .wiki-print-page { break-after:page; page-break-after:always; background:white; border:1px solid var(--line); border-radius:14px; padding:44px; margin:0 0 24px; box-shadow:0 18px 45px rgba(20,20,15,.08); }
    .wiki-print-cover { min-height:760px; display:flex; flex-direction:column; justify-content:center; }
    .wiki-print-kicker { margin:0 0 16px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; font-size:11px; font-weight:700; }
    h1 { margin:0; max-width:720px; font-family:"Instrument Serif", Georgia, serif; font-size:58px; line-height:.98; font-weight:400; }
    .wiki-print-cover > p:not(.wiki-print-kicker) { max-width:680px; color:var(--muted); font-size:17px; margin:20px 0 0; }
    dl { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:16px; margin:46px 0 0; }
    dt { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    dd { margin:3px 0 0; font-weight:650; overflow-wrap:anywhere; }
    .wiki-print-page-head { margin-bottom:22px; border-bottom:1px solid var(--line); padding-bottom:18px; }
    .wiki-print-page-head span { color:var(--muted); font-size:12px; }
    h2 { margin:5px 0 0; font-size:28px; line-height:1.1; }
    .wiki-print-page-head p { margin:9px 0 0; color:var(--muted); }
    .wiki-print-markdown h2 { margin-top:28px; font-size:22px; }
    .wiki-print-markdown h3 { margin-top:24px; font-size:17px; }
    .wiki-print-markdown p, .wiki-print-markdown li { color:#3f403b; }
    a { color:#0969a8; text-decoration:none; }
    code { border:1px solid #deded7; border-radius:5px; background:var(--soft); padding:1px 4px; font-family:"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace; font-size:.88em; }
    pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:"SFMono-Regular", ui-monospace, Menlo, Consolas, monospace; font-size:11px; line-height:1.5; }
    .code-viewer, .wiki-print-diagram { border:1px solid var(--line); border-radius:10px; background:#f8f8f4; margin:18px 0; overflow:hidden; }
    .code-viewer-head { display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); color:var(--muted); padding:7px 10px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
    .code-viewer pre, .wiki-print-diagram pre { padding:14px; }
    table { width:100%; border-collapse:collapse; margin:16px 0; font-size:13px; }
    th, td { border:1px solid var(--line); padding:8px; text-align:left; vertical-align:top; }
    blockquote { margin:18px 0; border-left:3px solid var(--line); padding:1px 0 1px 14px; color:var(--muted); }
    details { border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin:16px 0; }
    details[open], details { background:#fbfbf8; }
    details summary { font-weight:650; }
    .wiki-print-sources { margin-top:28px; border-top:1px solid var(--line); padding-top:14px; }
    .wiki-print-sources h3 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
    @page { margin:16mm; }
    @media print {
      body { background:white; }
      .no-print { display:none !important; }
      .wiki-print-document { width:auto; margin:0; }
      .wiki-print-cover, .wiki-print-page { border:0; border-radius:0; box-shadow:none; padding:0; margin:0; min-height:auto; }
      .wiki-print-page:last-child { break-after:auto; page-break-after:auto; }
      a[href]::after { content:""; }
    }
  `;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicRepoRefFromUnknown(value: unknown): PublicRepoRef | null {
  const ref = publicRepoRef(jsonObject(value));
  return ref.owner && ref.repo && ref.url ? ref : null;
}

function workspaceRefsFromUnknown(value: unknown): WorkspaceRepoRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map(publicRepoRefFromUnknown)
    .filter((ref): ref is PublicRepoRef => Boolean(ref))
    .map((ref) => ({
        owner: ref.owner,
        repo: ref.repo,
        url: ref.url,
        branch: ref.branch ?? null,
        sourcePath: ref.sourcePath ?? null,
        id: ref.id || `${ref.owner}-${ref.repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        label: ref.label || `${ref.owner}/${ref.repo}`,
      }));
  return refs.length > 1 ? refs : undefined;
}

function cleanAskHistory(value: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = jsonObject(entry);
      const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
      const content = typeof row.content === "string" ? row.content : "";
      return role && content ? { role, content } : null;
    })
    .filter((entry): entry is { role: "user" | "assistant"; content: string } => Boolean(entry));
}

function normalizeAskTurn(value: unknown): AskSessionTurn | null {
  const row = jsonObject(value);
  const id = typeof row.id === "string" && row.id ? row.id : typeof row.turnId === "string" ? row.turnId : "";
  const question = typeof row.question === "string" ? row.question : "";
  if (!id || !question) return null;
  const refs = Array.isArray(row.refs)
    ? row.refs.map(publicRepoRefFromUnknown).filter((ref): ref is PublicRepoRef => Boolean(ref))
    : [];
  const status = row.status === "done" || row.status === "error" || row.status === "canceled" ? row.status : "running";
  const askMode: AskMode = row.askMode === "fast" ? "fast" : "deep";
  const runtime = normalizeAgentRuntime(row.runtime, "rlm");
  const workspaceGoal = typeof row.workspaceGoal === "string" && WORKSPACE_GOALS.has(row.workspaceGoal)
    ? row.workspaceGoal as WorkspaceGoal
    : null;
  return {
    id,
    question,
    status,
    refs,
    history: cleanAskHistory(row.history),
    channel: typeof row.channel === "string" && row.channel ? row.channel : DEFAULT_CHANNEL_ID,
    runtime,
    localCli: row.localCli ?? null,
    workspaceGoal,
    askMode,
    capabilities: normalizeCapabilitySnapshot(row.capabilities),
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
    completedAt: typeof row.completedAt === "string" ? row.completedAt : undefined,
    answer: typeof row.answer === "string" ? row.answer : undefined,
    sources: Array.isArray(row.sources) ? row.sources.map(String) : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

function askTurnsFromRun(run: ProductRun | null): AskSessionTurn[] {
  if (!run) return [];
  const result = jsonObject(run.result);
  const input = jsonObject(run.input);
  const rawTurns = Array.isArray(result.turns)
    ? result.turns
    : Array.isArray(input.turns)
    ? input.turns
    : [];
  const turns = rawTurns
    .map(normalizeAskTurn)
    .filter((turn): turn is AskSessionTurn => Boolean(turn));
  if (turns.length) return turns;

  const legacyQuestion = typeof input.question === "string" ? input.question : run.title;
  if (!legacyQuestion) return [];
  const legacyTurn = normalizeAskTurn({
    id: typeof input.currentTurnId === "string" ? input.currentTurnId : run.id,
    question: legacyQuestion,
    status: run.status,
    refs: Array.isArray(input.refs) ? input.refs : [],
    history: Array.isArray(input.history) ? input.history : [],
    channel: typeof input.channel === "string" ? input.channel : DEFAULT_CHANNEL_ID,
    runtime: input.runtime,
    localCli: input.localCli,
    workspaceGoal: input.workspaceGoal,
    askMode: input.askMode,
    startedAt: run.createdAt,
    completedAt: run.status === "running" ? null : run.updatedAt,
    answer: typeof result.answer === "string" ? result.answer : undefined,
    sources: Array.isArray(result.sources) ? result.sources : undefined,
    error: typeof result.error === "string" ? result.error : run.error ?? undefined,
  });
  return legacyTurn ? [legacyTurn] : [];
}

function askSessionHasRunningTurn(run: ProductRun | null): boolean {
  if (!run) return false;
  const turns = askTurnsFromRun(run);
  if (turns.length) return turns.some((turn) => turn.status === "running");
  return run.status === "running";
}

function clearStaleAskSessionLock(runId: string): void {
  activeAskRunIds.delete(runId);
  const active = activeRunControllers.get(runId);
  if (active?.kind === "ask") {
    try {
      active.controller.abort(USER_STOP_MESSAGE);
    } catch {
      // stale controller only
    }
    activeRunControllers.delete(runId);
  }
}

function upsertAskTurn(turns: AskSessionTurn[], turn: AskSessionTurn): AskSessionTurn[] {
  const next = [...turns];
  const index = next.findIndex((item) => item.id === turn.id);
  if (index >= 0) next[index] = turn;
  else next.push(turn);
  return next;
}

function askTurnInputRecord(turn: AskSessionTurn): Record<string, unknown> {
  return {
    id: turn.id,
    question: turn.question,
    status: turn.status,
    refs: turn.refs,
    history: turn.history,
    channel: turn.channel,
    runtime: turn.runtime,
    localCli: turn.localCli ?? null,
    workspaceGoal: turn.workspaceGoal,
    askMode: turn.askMode,
    capabilities: turn.capabilities ?? null,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt ?? null,
    error: turn.error ?? null,
  };
}

function askTurnResultRecord(turn: AskSessionTurn): Record<string, unknown> {
  return {
    ...askTurnInputRecord(turn),
    answer: turn.answer ?? null,
    sources: turn.sources ?? [],
  };
}

function askRunInputWithTurn(run: ProductRun | null, turn: AskSessionTurn): Record<string, unknown> {
  const existingInput = run ? jsonObject(run.input) : {};
  const turns = upsertAskTurn(askTurnsFromRun(run), turn);
  return {
    ...existingInput,
    refs: turn.refs,
    question: turn.question,
    history: turn.history,
    channel: turn.channel,
    runtime: turn.runtime,
    localCli: turn.localCli ?? null,
    workspaceGoal: turn.workspaceGoal,
    askMode: turn.askMode,
    currentTurnId: turn.id,
    turns: turns.map(askTurnInputRecord),
  };
}

function askRunResultWithTurn(
  run: ProductRun | null,
  turn: AskSessionTurn,
  processSnapshot?: ProcessSnapshot,
): Record<string, unknown> {
  const existingResult = run ? jsonObject(run.result) : {};
  const turns = upsertAskTurn(askTurnsFromRun(run), turn);
  const result: Record<string, unknown> = {
    ...existingResult,
    turns: turns.map(askTurnResultRecord),
  };
  if (turn.status === "done") {
    result.answer = turn.answer ?? "";
    result.sources = turn.sources ?? [];
    result.error = null;
  } else if (turn.status === "running") {
    result.error = null;
  } else if (turn.status === "error") {
    result.error = turn.error ?? "Ask failed";
  } else if (turn.status === "canceled") {
    result.error = turn.error ?? USER_STOP_MESSAGE;
  }
  if (processSnapshot) result.processSnapshot = processSnapshot;
  return result;
}

function normalizeCodeTurn(value: unknown): CodeSessionTurn | null {
  const row = jsonObject(value);
  const id = typeof row.id === "string" && row.id ? row.id : typeof row.turnId === "string" ? row.turnId : "";
  const task = typeof row.task === "string" ? row.task : "";
  if (!id || !task) return null;
  const status = row.status === "done" || row.status === "error" || row.status === "canceled" ? row.status : "running";
  return {
    id,
    task,
    displayTask: typeof row.displayTask === "string" && row.displayTask ? row.displayTask : undefined,
    handoff: normalizeCodeHandoff(row.handoff),
    status,
    channel: typeof row.channel === "string" && row.channel ? row.channel : DEFAULT_CHANNEL_ID,
    runtime: normalizeAgentRuntime(row.runtime, "agent"),
    agent: normalizeCodeAnythingAgent(row.agent),
    localCli: row.localCli ?? null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
    completedAt: typeof row.completedAt === "string" ? row.completedAt : undefined,
    answer: typeof row.answer === "string" ? row.answer : undefined,
    sources: Array.isArray(row.sources) ? row.sources.map(String) : undefined,
    diff: typeof row.diff === "string" ? row.diff : undefined,
    fullDiff: typeof row.fullDiff === "string" ? row.fullDiff : undefined,
    gitStatus: typeof row.gitStatus === "string" ? row.gitStatus : undefined,
    changedFiles: Array.isArray(row.changedFiles) ? row.changedFiles.map(String) : undefined,
    truncated: row.truncated === true,
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

function normalizeCodeHandoff(value: unknown): Record<string, string | number | boolean> | undefined {
  const row = jsonObject(value);
  const kind = typeof row.kind === "string" && row.kind ? row.kind : "";
  if (!kind) return undefined;
  const out: Record<string, string | number | boolean> = { kind };
  for (const key of ["displayTask", "reviewLabel", "detail", "returnUrl", "sourceUrl", "sourceRunId"] as const) {
    if (typeof row[key] === "string" && row[key]) out[key] = compactString(row[key], key === "detail" ? 600 : 240);
  }
  if (typeof row.changedFileCount === "number" && Number.isFinite(row.changedFileCount)) {
    out.changedFileCount = row.changedFileCount;
  }
  return out;
}

function codeTurnsFromRun(run: ProductRun | null): CodeSessionTurn[] {
  if (!run) return [];
  const result = jsonObject(run.result);
  const rawTurns = Array.isArray(result.turns) ? result.turns : [];
  const turns = rawTurns
    .map(normalizeCodeTurn)
    .filter((turn): turn is CodeSessionTurn => Boolean(turn));
  if (turns.length) {
    const hasRealTurn = turns.some((turn) => turn.id !== "initial");
    return turns.filter((turn) => !(hasRealTurn && turn.id === "initial" && turn.status === "running" && !turn.completedAt));
  }

  const input = jsonObject(run.input);
  const task = typeof input.task === "string" && input.task ? input.task : run.title;
  if (!task) return [];
  if (run.status === "running" && !result.answer && !result.diff && !result.error) return [];
  return [{
    id: "initial",
    task,
    displayTask: typeof input.displayTask === "string" && input.displayTask ? input.displayTask : undefined,
    handoff: normalizeCodeHandoff(input.handoff),
    status: run.status === "error" ? "error" : run.status === "canceled" ? "canceled" : run.status === "running" ? "running" : "done",
    channel: typeof input.channel === "string" && input.channel ? input.channel : DEFAULT_CHANNEL_ID,
    runtime: normalizeAgentRuntime(input.runtime, "agent"),
    agent: normalizeCodeAnythingAgent(input.agent),
    localCli: input.localCli ?? null,
    startedAt: run.createdAt,
    completedAt: run.status === "running" ? undefined : run.updatedAt,
    answer: typeof result.answer === "string" ? result.answer : undefined,
    sources: Array.isArray(result.sources) ? result.sources.map(String) : undefined,
    diff: typeof result.diff === "string" ? result.diff : undefined,
    fullDiff: typeof result.fullDiff === "string" ? result.fullDiff : undefined,
    gitStatus: typeof result.status === "string" ? result.status : undefined,
    changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles.map(String) : undefined,
    truncated: result.truncated === true,
    error: typeof result.error === "string" ? result.error : run.error ?? undefined,
  }];
}

function codeRunResultWithTurn(
  run: ProductRun | null,
  turn: CodeSessionTurn,
  processSnapshot?: ProcessSnapshot,
): Record<string, unknown> {
  const existing = run ? jsonObject(run.result) : {};
  const turns = codeTurnsFromRun(run)
    .filter((existingTurn) => existingTurn.id !== turn.id)
    .concat(turn);
  const result: Record<string, unknown> = {
    ...existing,
    turns,
  };
  if (turn.status === "done") {
    result.answer = turn.answer ?? "";
    result.sources = turn.sources ?? [];
    result.diff = turn.diff ?? "(no diff)";
    result.fullDiff = turn.fullDiff ?? turn.diff ?? "(no diff)";
    result.status = turn.gitStatus ?? "(clean)";
    result.changedFiles = turn.changedFiles ?? [];
    result.truncated = turn.truncated === true;
    result.agent = normalizeCodeAnythingAgent(turn.agent);
    result.runtime = turn.runtime;
    result.localCli = turn.localCli ?? null;
    result.error = null;
  } else if (turn.status === "error") {
    result.error = turn.error ?? "Code follow-up failed";
  } else if (turn.status === "canceled") {
    result.error = turn.error ?? USER_STOP_MESSAGE;
  } else {
    result.error = null;
  }
  if (processSnapshot) result.processSnapshot = processSnapshot;
  return result;
}

function codeRunResultFromTurns(
  run: ProductRun,
  turns: CodeSessionTurn[],
  processSnapshot?: ProcessSnapshot,
): { status: "done" | "error" | "canceled"; result: Record<string, unknown>; error: string | null } {
  const existing = jsonObject(run.result);
  const latestDone = [...turns].reverse().find((turn) => turn.status === "done");
  const latestProblem = [...turns].reverse().find((turn) => turn.status === "error" || turn.status === "canceled");
  const result: Record<string, unknown> = {
    ...existing,
    turns,
  };
  if (latestDone) {
    result.answer = latestDone.answer ?? "";
    result.sources = latestDone.sources ?? [];
    result.diff = latestDone.diff ?? "(no diff)";
    result.fullDiff = latestDone.fullDiff ?? latestDone.diff ?? "(no diff)";
    result.status = latestDone.gitStatus ?? "(clean)";
    result.changedFiles = latestDone.changedFiles ?? [];
    result.truncated = latestDone.truncated === true;
    result.agent = normalizeCodeAnythingAgent(latestDone.agent);
    result.runtime = latestDone.runtime;
    result.error = null;
    if (processSnapshot) result.processSnapshot = processSnapshot;
    return { status: "done", result, error: null };
  }

  result.answer = "";
  result.sources = [];
  result.diff = "(no diff)";
  result.fullDiff = "(no diff)";
  result.status = "(clean)";
  result.changedFiles = [];
  result.truncated = false;
  result.error = latestProblem?.error ?? null;
  if (processSnapshot) result.processSnapshot = processSnapshot;
  return {
    status: latestProblem?.status === "canceled" ? "canceled" : "error",
    result,
    error: latestProblem?.error ?? null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && (error.name === "AbortError" || error.message === USER_STOP_MESSAGE);
}

function canceledCodeTurn(turn: CodeSessionTurn, message = USER_STOP_MESSAGE): CodeSessionTurn {
  return {
    ...turn,
    status: "canceled",
    completedAt: new Date().toISOString(),
    error: message,
  };
}

function codeRunStatusAfterTurn(run: ProductRun | null, turn: CodeSessionTurn): "done" | "error" | "canceled" {
  if (turn.status === "done") return "done";
  if (turn.status === "canceled") {
    const hasPriorDoneTurn = codeTurnsFromRun(run).some((existingTurn) => existingTurn.id !== turn.id && existingTurn.status === "done");
    return hasPriorDoneTurn ? "done" : "canceled";
  }
  return "error";
}

function canceledCodeRunResult(run: ProductRun, message = USER_STOP_MESSAGE): {
  status: "done" | "canceled";
  result: Record<string, unknown>;
} {
  const now = new Date().toISOString();
  const result = jsonObject(run.result);
  const turns = codeTurnsFromRun(run);
  const input = jsonObject(run.input);
  const nextTurns = (turns.length ? turns : [{
    id: run.id,
    task: typeof input.task === "string" && input.task ? input.task : run.title,
    displayTask: typeof input.displayTask === "string" && input.displayTask ? input.displayTask : undefined,
    handoff: normalizeCodeHandoff(input.handoff),
    status: "running" as const,
    channel: typeof input.channel === "string" && input.channel ? input.channel : DEFAULT_CHANNEL_ID,
    runtime: normalizeAgentRuntime(input.runtime, "agent"),
    agent: normalizeCodeAnythingAgent(input.agent),
    startedAt: run.createdAt,
  }]).map((turn) => turn.status === "running"
    ? { ...turn, status: "canceled" as const, completedAt: now, error: message }
    : turn);
  const hasDoneTurn = nextTurns.some((turn) => turn.status === "done");
  return {
    status: hasDoneTurn ? "done" : "canceled",
    result: {
      ...result,
      turns: nextTurns,
      error: message,
      processSnapshot: processSnapshotFor(run.id),
    },
  };
}

function isCodePublishRequest(task: string): boolean {
  const text = task.toLowerCase();
  if (/\b(?:pr|pull request)\s+template\b/.test(text) || /\btemplate\s+(?:for\s+)?(?:pr|pull request)\b/.test(text)) {
    return false;
  }
  const mentionsPr = /\b(?:pr|pull request)\b/.test(text);
  const publishesCurrentPatch = /\b(?:publish|push)\s+(?:this|the\s+current|current)\s+(?:patch|diff|changes)\b/.test(text);
  if (!mentionsPr && !publishesCurrentPatch) return false;
  return [
    /\b(?:create|open|submit|publish|raise|file|make)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:github\s+)?(?:pr|pull request)\b/,
    /\b(?:update|refresh)\s+(?:the\s+|this\s+|existing\s+)?(?:github\s+)?(?:pr|pull request)\b/,
    /\b(?:pr|pull request)\s+(?:create|open|submit|publish|raise|update)\b/,
    /\b(?:publish|push)\s+(?:this|the\s+current|current)\s+(?:patch|diff|changes)\b/,
  ].some((pattern) => pattern.test(text));
}

function buildPrDraftTitle(task: string, changedFiles: string[]): string {
  const quoted = task.match(/title\s+(?:call|called|named|as)\s*:?\s*["'`]?([^"'`\n.]+)["'`]?/i)
    ?? task.match(/with\s+(?:a\s+)?title\s*:?\s*["'`]?([^"'`\n.]+)["'`]?/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  if (changedFiles.length === 1) return `Update ${changedFiles[0]}`;
  if (changedFiles.length > 1) return `Update ${changedFiles.length} files`;
  return "Apply Code Anything patch";
}

function buildPrBoundaryAnswer(args: {
  task: string;
  ref: PublicRepoRef;
  diff?: string;
  changedFiles?: string[];
  previousAnswer?: string;
}): string {
  const changedFiles = (args.changedFiles ?? []).filter(Boolean);
  const title = buildPrDraftTitle(args.task, changedFiles);
  const files = changedFiles.length
    ? changedFiles.map((file) => `- \`${file}\``).join("\n")
    : "- No patch files are available yet.";
  const body = [
    "## Summary",
    changedFiles.length
      ? `Apply the current Code Anything patch for ${args.ref.owner}/${args.ref.repo}.`
      : `No publishable patch is attached to this Code Anything session yet.`,
    "",
    "## Changed files",
    files,
    "",
    "## Verification",
    "- Review the generated patch in rlm-wiki before publishing.",
  ].join("\n");

  return `## Ready To Create A Pull Request

I did not create a pull request or mutate GitHub from the agent loop.

Code Anything prepares the patch first. Use the **Create PR** action in rlm-wiki to publish the current patch to GitHub. If a PR already exists, the action becomes **Update PR**.

## Publish Model

1. JCODE prepares the patch and PR draft.
2. The explicit PR action applies the stored patch to a clean clone.
3. The server opens or updates the pull request through the connected GitHub capability.
4. If the connected user cannot write to the target repository, rlm-wiki uses a fork automatically.

## PR Draft

Title: ${title}

Body:

\`\`\`markdown
${body}
\`\`\`

${args.previousAnswer ? `## Previous Agent Summary\n\n${args.previousAnswer}` : ""}`.trim();
}

function buildPrPublishedAnswer(publish: {
  mode: "created" | "updated";
  pullRequest?: { url: string; number: number; branch: string; base: string; title: string } | null;
  branch: { url: string; owner: string; repo: string; branch: string };
  target: "upstream" | "fork";
  openedPullRequest: boolean;
  changedFiles: string[];
  commitSha: string;
}): string {
  const verb = publish.mode === "updated" ? "Updated" : "Created";
  const files = publish.changedFiles.length
    ? publish.changedFiles.map((file) => `- \`${file}\``).join("\n")
    : "- (none)";
  if (!publish.pullRequest) {
    return `## Fork Branch ${verb}

${verb} [\`${publish.branch.owner}/${publish.branch.repo}:${publish.branch.branch}\`](${publish.branch.url}).

Target: \`${publish.target}\`
Commit: \`${publish.commitSha.slice(0, 12)}\`

## Changed Files

${files}`.trim();
  }
  return `## PR ${verb}

${verb} [#${publish.pullRequest.number}: ${publish.pullRequest.title}](${publish.pullRequest.url}).

Branch: \`${publish.pullRequest.branch}\`
Base: \`${publish.pullRequest.base}\`
Commit: \`${publish.commitSha.slice(0, 12)}\`

## Changed Files

${files}`.trim();
}

function recoverStaleCodeTurns(run: ProductRun): Record<string, unknown> | null {
  const result = jsonObject(run.result);
  const rawTurns = Array.isArray(result.turns)
    ? result.turns.map(normalizeCodeTurn).filter((turn): turn is CodeSessionTurn => Boolean(turn))
    : [];
  const turns = codeTurnsFromRun(run);
  const hasStaleSyntheticInitial = rawTurns.some((turn) => turn.id === "initial" && turn.status === "running" && !turn.completedAt)
    && rawTurns.some((turn) => turn.id !== "initial");
  if (run.status !== "running" && !turns.some((turn) => turn.status === "running") && !hasStaleSyntheticInitial) return null;
  const now = new Date().toISOString();
  return {
    ...result,
    turns: turns.map((turn) => turn.status === "running"
      ? {
        ...turn,
        status: "error",
        completedAt: now,
        error: "Previous code turn stopped before the server completed it.",
      }
      : turn),
    error: null,
  };
}

function isCompleteDiffForApply(diff: string): boolean {
  const trimmed = diff.trim();
  return Boolean(trimmed && trimmed !== "(no diff)" && trimmed.includes("diff --git ") && !trimmed.includes("[truncated"));
}

function normalizeCapabilitySnapshot(value: unknown): CapabilitySnapshot | undefined {
  const row = jsonObject(value);
  const mcpServers = Array.isArray(row.mcpServers)
    ? row.mcpServers.map((item) => {
      const server = jsonObject(item);
      return {
        id: String(server.id || ""),
        name: String(server.name || ""),
        url: String(server.url || ""),
        type: server.type === "sse" ? "sse" as const : "http" as const,
        enabled: server.enabled !== false,
        auth: server.auth === "bearer-env" ? "bearer-env" as const : "none" as const,
      };
    }).filter((server) => server.id && server.name)
    : [];
  const skills = Array.isArray(row.skills)
    ? row.skills.map((item) => {
      const skill = jsonObject(item);
      return {
        id: String(skill.id || ""),
        source: String(skill.source || ""),
        enabled: skill.enabled !== false,
      };
    }).filter((skill) => skill.id && skill.source)
    : [];
  const rawComposio = jsonObject(row.composio);
  const composioToolkits = Array.isArray(rawComposio.toolkits)
    ? rawComposio.toolkits.map((item) => {
      const toolkit = jsonObject(item);
      return {
        slug: String(toolkit.slug || ""),
        enabled: toolkit.enabled !== false,
      };
    }).filter((toolkit) => toolkit.slug)
    : [];
  const rawMcp = jsonObject(rawComposio.mcp);
  const composio: CapabilitySnapshot["composio"] = {
    enabled: rawComposio.enabled !== false,
    configured: rawComposio.configured === true,
    userId: typeof rawComposio.userId === "string" && rawComposio.userId ? rawComposio.userId : "rlm-wiki-owner",
    toolkits: composioToolkits,
    ...(typeof rawComposio.sessionId === "string" && rawComposio.sessionId ? { sessionId: rawComposio.sessionId } : {}),
    ...(typeof rawComposio.error === "string" && rawComposio.error ? { error: rawComposio.error } : {}),
    ...(rawMcp.name
      ? {
        mcp: {
          name: String(rawMcp.name),
          type: rawMcp.type === "sse" ? "sse" as const : "http" as const,
          enabled: rawMcp.enabled !== false,
          auth: "composio-session" as const,
        },
      }
      : {}),
  };
  if (!mcpServers.length && !skills.length && !composio.toolkits.length && !composio.sessionId && !composio.error) return undefined;
  return { mcpServers, skills, composio };
}

function withTurnId(turnId: string, payload: unknown): Record<string, unknown> {
  return { ...jsonObject(payload), turnId };
}

function sseResponse(
  handler: (send: (ev: string, data: unknown) => void, close: () => void, signal: AbortSignal) => Promise<void> | void,
  req?: Request,
): Response {
  const encoder = new TextEncoder();
  let abortController: AbortController | null = null;
  let closeStream: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      abortController = new AbortController();
      const requestAbort = (): void => abortController?.abort(USER_STOP_MESSAGE);
      if (req?.signal.aborted) requestAbort();
      else req?.signal.addEventListener("abort", requestAbort, { once: true });

      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const send = (ev: string, data: unknown): void => {
        if (closed) return;
        const line = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      closeStream = close;

      // Heartbeat: SSE comment every 20s so intermediaries (and Bun) don't
      // treat the connection as idle during long Gemini calls. Lines
      // starting with ":" are ignored by the EventSource spec.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      }, 20_000);

      try {
        await handler(send, close, abortController.signal);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send("error", { message, ...providerSetupDetailsFromMessage(message) });
      } finally {
        req?.signal.removeEventListener("abort", requestAbort);
        close();
      }
    },
    cancel() {
      abortController?.abort(USER_STOP_MESSAGE);
      closeStream?.();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-rlm-wiki-agent-event-contract": "open-design.agent-events.v1",
      ...corsHeaders(),
      ...corsHeaders(req),
    },
  });
}

function runResponse(
  productStore: ProductStore,
  jobQueue: JobQueue,
  secretGrantStore: SecretGrantStore,
  run: ProductRun,
  ownerUserId: string,
  handler: (send: (ev: string, data: unknown) => void, close: () => void, signal: AbortSignal) => Promise<void> | void,
  req?: Request,
  opts: { providerSecrets?: ProviderSecrets | null; payload?: Record<string, unknown> } = {},
): Response {
  const mode = runModeFor(productStore, jobQueue, secretGrantStore);
  if (mode === "inline") {
    return sseResponse(handler, req);
  }

  if (mode === "worker" && isExternalWorkerPayload(opts.payload)) {
    queueMicrotask(() => {
      enqueueRunJob(jobQueue, secretGrantStore, run, ownerUserId, opts)
        .then(async ({ job, grant }) => {
          // If enqueue created a grant but dispatch+worker both die, grant TTL still expires.
          void grant;
          await maybeDispatchJobToUnikraft({
            job,
            run,
            ownerUserId,
            productStore,
          });
        })
        .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[worker-mode] could not enqueue run ${run.id}:`, message);
        try {
          await productStore.appendEvent(run.id, "error", { message });
          await productStore.updateRun(run.id, { status: "error", error: message });
        } catch (persistError) {
          console.warn(`[worker-mode] could not persist enqueue failure for ${run.id}:`, persistError instanceof Error ? persistError.message : persistError);
        }
      });
    });
    return persistedRunSseResponse(productStore, run.id, req);
  }

  if (mode === "worker") {
    return sseResponse(handler, req);
  }

  const controller = new AbortController();
  queueMicrotask(() => {
    runQueuedHandler(productStore, jobQueue, secretGrantStore, run, ownerUserId, handler, controller.signal, opts).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[run-mode] detached run ${run.id} failed:`, message);
      try {
        await productStore.appendEvent(run.id, "error", { message });
        await productStore.updateRun(run.id, { status: "error", error: message });
      } catch (persistError) {
        console.warn(`[run-mode] could not persist detached failure for ${run.id}:`, persistError instanceof Error ? persistError.message : persistError);
      }
    });
  });

  return persistedRunSseResponse(productStore, run.id, req);
}

function isExternalWorkerPayload(payload: Record<string, unknown> | undefined): boolean {
  return jsonObject(payload).worker === true;
}

function normalizeWikiBatchPageIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const pageId = typeof item === "string" ? item.trim() : "";
    if (!pageId || seen.has(pageId)) continue;
    seen.add(pageId);
    out.push(pageId);
    if (out.length >= MAX_BATCH_REGENERATE_PAGES) break;
  }
  return out;
}

function wikiPageMetasForIds(record: WikiRecord, pageIds: string[]): {
  metas: WikiRecord["structure"]["pages"];
  missing: string[];
} {
  const pageById = new Map(record.structure.pages.map((page) => [page.id, page]));
  const metas: WikiRecord["structure"]["pages"] = [];
  const missing: string[] = [];
  for (const pageId of pageIds) {
    const page = pageById.get(pageId);
    if (page) metas.push(page);
    else missing.push(pageId);
  }
  return { metas, missing };
}

async function enqueueRunJob(
  jobQueue: JobQueue,
  secretGrantStore: SecretGrantStore,
  run: ProductRun,
  ownerUserId: string,
  opts: { providerSecrets?: ProviderSecrets | null; payload?: Record<string, unknown> } = {},
): Promise<{ job: JobRecord; grant: SecretGrantRef | null }> {
  const grant = hasProviderSecrets(opts.providerSecrets)
    ? await secretGrantStore.create({
      ownerUserId,
      purpose: `run.${run.kind}`,
      providerSecrets: opts.providerSecrets,
    })
    : null;
  const jobType = `run.${run.kind}`;
  // Ephemeral Unikraft VMs make mid-job death routine; allow one reclaim on lock expiry.
  const maxAttempts = unikraftDispatchEnabledForJobType(jobType)
    ? Math.max(2, unikraftDispatchConfig().maxAttempts)
    : 1;
  const job = await jobQueue.enqueue({
    type: jobType,
    ownerUserId,
    runId: run.id,
    payload: {
      ...jsonObject(opts.payload),
      runId: run.id,
      kind: run.kind,
      title: run.title,
      input: run.input,
      ...(grant ? { secretGrantId: grant.id, secretGrantExpiresAt: grant.expiresAt } : {}),
    },
    maxAttempts,
  });
  return { job, grant };
}

/**
 * After a job is enqueued for external workers, optionally spawn a Unikraft
 * one-shot microVM that claims that exact job id. Failures fall back to a
 * Railway worker reclaim (maxAttempts >= 2).
 */
async function maybeDispatchJobToUnikraft(args: {
  job: JobRecord;
  run: ProductRun;
  ownerUserId: string;
  productStore: ProductStore;
}): Promise<void> {
  if (!unikraftDispatchEnabledForJobType(args.job.type)) return;
  try {
    const result = await dispatchJobToUnikraft({
      jobId: args.job.id,
      jobType: args.job.type,
      runId: args.run.id,
      ownerUserId: args.ownerUserId,
    });
    if (!result.dispatched) {
      console.log(
        `[unikraft] skip dispatch job=${args.job.id} type=${args.job.type} reason=${result.skippedReason || "unknown"}`,
      );
      return;
    }
    const instance = result.instance;
    console.log(
      `[unikraft] dispatched job=${args.job.id} type=${args.job.type} instance=${instance?.name || instance?.uuid || "?"}`,
    );
    await args.productStore.appendEvent(args.run.id, "status", {
      phase: "compute",
      message: `Dispatched to Unikraft sandbox${instance?.name ? ` (${instance.name})` : ""}.`,
      unikraft: {
        instanceName: instance?.name || null,
        instanceUuid: instance?.uuid || null,
        metro: instance?.metro || null,
        jobId: args.job.id,
      },
    }).catch(() => null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[unikraft] dispatch failed for job ${args.job.id}:`, message);
    await args.productStore.appendEvent(args.run.id, "status", {
      phase: "compute",
      message: `Unikraft dispatch failed; waiting for Railway worker reclaim. ${message}`,
    }).catch(() => null);
  }
}

async function runQueuedHandler(
  productStore: ProductStore,
  jobQueue: JobQueue,
  secretGrantStore: SecretGrantStore,
  run: ProductRun,
  ownerUserId: string,
  handler: (send: (ev: string, data: unknown) => void, close: () => void, signal: AbortSignal) => Promise<void> | void,
  signal: AbortSignal,
  opts: { providerSecrets?: ProviderSecrets | null; payload?: Record<string, unknown> } = {},
): Promise<void> {
  const { job, grant } = await enqueueRunJob(jobQueue, secretGrantStore, run, ownerUserId, opts);
  const claimed = await jobQueue.claim(job.id, { workerId: JOB_WORKER_ID, lockMs: JOB_LOCK_MS });
  if (!claimed) {
    await jobQueue.cancel(job.id, "Could not claim queued job");
    if (grant) await secretGrantStore.revoke(grant.id, ownerUserId, "job claim failed").catch(() => false);
    throw new Error(`Could not claim queued job ${job.id}`);
  }

  const heartbeat = setInterval(() => {
    jobQueue.heartbeat(job.id, JOB_WORKER_ID, JOB_LOCK_MS).catch((error) => {
      console.warn(`[queue] heartbeat failed for ${job.id}:`, error instanceof Error ? error.message : error);
    });
  }, Math.max(5_000, Math.floor(JOB_LOCK_MS / 3)));

  try {
    await Promise.resolve(handler(() => {}, () => {}, signal));
    const latest = await productStore.getRun(run.id);
    if (latest?.status === "error") {
      await jobQueue.fail(job.id, JOB_WORKER_ID, latest.error || "Run failed");
    } else if (latest?.status === "canceled") {
      await jobQueue.cancel(job.id, latest.error || USER_STOP_MESSAGE);
    } else {
      await jobQueue.complete(job.id, JOB_WORKER_ID);
    }
    if (grant) await secretGrantStore.revoke(grant.id, ownerUserId, "job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await jobQueue.fail(job.id, JOB_WORKER_ID, message).catch(() => null);
    if (grant) await secretGrantStore.revoke(grant.id, ownerUserId, "job failed").catch(() => false);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function staleRunningJobMessage(job: JobRecord): string {
  const expiredAt = job.lockedUntil ? new Date(job.lockedUntil).toISOString() : "unknown time";
  return `Run stopped before completing. Last worker heartbeat expired at ${expiredAt}.`;
}

function isTerminallyStaleRunningJob(job: JobRecord): boolean {
  if (job.status !== "running" || !job.lockedUntil) return false;
  if (job.attempts < job.maxAttempts) return false;
  const lockedUntil = Date.parse(job.lockedUntil);
  return Number.isFinite(lockedUntil) && lockedUntil + JOB_LOCK_MS < Date.now();
}

async function recoverStaleRunFromJob(
  productStore: ProductStore,
  publicStore: ProductStore,
  jobQueue: JobQueue,
  run: ProductRun,
): Promise<ProductRun> {
  if (run.status !== "running") return run;
  const jobs = await jobQueue.listByRun(run.id).catch(() => []);
  const stale = jobs.find(isTerminallyStaleRunningJob);
  if (!stale) return run;

  const message = staleRunningJobMessage(stale);
  await jobQueue.cancel(stale.id, message).catch(() => null);
  const recovered = await promoteWikiDraftRun(productStore, publicStore, run, message, {
    stale: true,
    jobId: stale.id,
    lockedBy: stale.lockedBy,
    lockedUntil: stale.lockedUntil,
  });
  if (recovered) return recovered;
  await productStore.appendEvent(run.id, "error", {
    message,
    stale: true,
    jobId: stale.id,
    lockedBy: stale.lockedBy,
    lockedUntil: stale.lockedUntil,
  }).catch(() => null);
  return await productStore.updateRun(run.id, {
    status: "error",
    error: message,
    result: {
      ...jsonObject(run.result),
      processSnapshot: processSnapshotFor(run.id),
    },
  }) ?? run;
}

async function recoverOrphanedInlineWikiRuns(
  productStore: ProductStore,
  publicStore: ProductStore,
  jobQueue: JobQueue,
): Promise<void> {
  const runs = await productStore.listRuns({ kind: "wiki_generate", limit: 80 });
  await Promise.all(runs.map(async (run) => {
    if (run.status !== "running") return;
    if (activeRunControllers.has(run.id)) return;
    const jobs = await jobQueue.listByRun(run.id).catch(() => []);
    if (jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    await promoteWikiDraftRun(
      productStore,
      publicStore,
      run,
      "Generation stopped before completing. Recovered from the last saved wiki checkpoint.",
      { orphaned: true },
    ).catch(() => null);
  }));
}

function persistedRunSseResponse(productStore: ProductStore, runId: string, req?: Request): Response {
  return sseResponse(async (send, close, signal) => {
    let nextSeq = 1;
    let finalSent = false;
    while (!signal.aborted) {
      const run = await productStore.getRun(runId, { includeEvents: true });
      if (!run) {
        send("error", { message: "Run not found" });
        close();
        return;
      }

      for (const event of run.events ?? []) {
        if (event.seq < nextSeq) continue;
        nextSeq = Math.max(nextSeq, event.seq + 1);
        if (shouldReplayPersistedEvent(event.type)) {
          send(event.type, event.payload);
        }
      }

      if (run.status !== "running") {
        await waitForPersistedEvents(runId);
        const flushedRun = await productStore.getRun(runId, { includeEvents: true });
        for (const event of flushedRun?.events ?? []) {
          if (event.seq < nextSeq) continue;
          nextSeq = Math.max(nextSeq, event.seq + 1);
          if (shouldReplayPersistedEvent(event.type)) {
            send(event.type, event.payload);
          }
        }
        if (!finalSent) {
          sendTerminalRunEvents(flushedRun ?? run, send);
          finalSent = true;
        }
        close();
        return;
      }

      await sleep(750);
    }
  }, req);
}

function shouldReplayPersistedEvent(type: string): boolean {
  return !DETACHED_TERMINAL_EVENTS.has(type);
}

function sendTerminalRunEvents(run: ProductRun, send: (ev: string, data: unknown) => void): void {
  if (run.status === "error" || run.status === "canceled") {
    const eventName = run.status === "canceled" && run.kind === "code" ? "canceled" : "error";
    send(eventName, { message: run.error || (run.status === "canceled" ? USER_STOP_MESSAGE : "Run failed") });
    return;
  }
  if (run.status !== "done") return;

  const result = jsonObject(run.result);
  if (run.kind === "ask") {
    const latest = [...askTurnsFromRun(run)].reverse().find((turn) => turn.status === "done");
    send("answer", {
      turnId: latest?.id,
      answer: latest?.answer ?? String(result.answer || ""),
      sources: latest?.sources ?? (Array.isArray(result.sources) ? result.sources.map(String) : []),
    });
    return;
  }

  if (run.kind === "code") {
    const latest = [...codeTurnsFromRun(run)].reverse().find((turn) => turn.status === "done");
    send("answer", {
      turnId: latest?.id,
      answer: latest?.answer ?? String(result.answer || ""),
      sources: latest?.sources ?? (Array.isArray(result.sources) ? result.sources.map(String) : []),
    });
    send("diff", {
      turnId: latest?.id,
      diff: latest?.diff ?? String(result.diff || "(no diff)"),
      status: latest?.gitStatus ?? String(result.status || "(clean)"),
      changedFiles: latest?.changedFiles ?? (Array.isArray(result.changedFiles) ? result.changedFiles.map(String) : []),
      truncated: latest?.truncated ?? result.truncated === true,
    });
    return;
  }

  if (run.kind === "review") {
    send("answer", {
      answer: String(result.answer || ""),
      sources: Array.isArray(result.sources) ? result.sources.map(String) : [],
    });
    return;
  }

  if (run.kind === "investigate") {
    send("investigation", result);
    return;
  }

  if (run.kind === "wiki_generate") {
    const pageId = typeof result.pageId === "string" ? result.pageId : undefined;
    const pageIds = Array.isArray(result.pageIds) ? result.pageIds.map(String) : undefined;
    const pageErrors = Array.isArray(result.pageErrors) ? result.pageErrors : undefined;
    const page = jsonObject(result.page);
    const wiki = jsonObject(result.wiki);
    if (Object.keys(wiki).length) {
      send("done", { record: wiki, wiki, pageId, pageIds, pageErrors, completion: wikiRecordCompletion(wiki) });
    } else if (pageId && Object.keys(page).length) {
      send("page-done", { pageId, page });
      send("done", { runId: run.id, pageId });
    } else {
      send("done", { runId: run.id, pageIds, pageErrors });
    }
    return;
  }

  if (run.kind === "wiki_slides") {
    send("done", {
      runId: run.id,
      deckId: compactString(result.deckId, 160),
      deckSourcePath: compactString(result.deckSourcePath, 240),
      fileName: compactString(result.fileName, 180) || "wiki-slides.zip",
      usedAgent: result.usedAgent === true,
      downloadUrl: compactString(result.downloadUrl, 300),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueHealth(jobQueue: JobQueue): Promise<JobQueueStats | (Pick<JobQueueStats, "mode"> & { error: string })> {
  try {
    return await jobQueue.stats();
  } catch (error) {
    return {
      mode: jobQueue.mode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function secretGrantHealth(
  secretGrantStore: SecretGrantStore,
): Promise<SecretGrantStats | (Pick<SecretGrantStats, "mode" | "configured" | "ttlSeconds"> & { error: string })> {
  try {
    return await secretGrantStore.stats();
  } catch (error) {
    return {
      mode: secretGrantStore.mode,
      configured: secretGrantStore.configured,
      ttlSeconds: secretGrantStore.ttlSeconds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<void> {
  installServerTelemetryMonitors();
  const port = opts.port ?? 3141;
  const host = opts.host ?? "127.0.0.1";
  const baseStore = opts.store ?? new WikiStore();
  const baseProductStore = opts.productStore ?? await createProductStore(baseStore.root, { ownerUserId: "legacy" });
  const baseJobQueue = opts.jobQueue ?? await createJobQueue(baseStore.root);
  const baseSecretGrantStore = opts.secretGrantStore ?? await createSecretGrantStore(baseStore.root);
  const servedIndexHtml = loadIndexHtmlForServe(opts);
  const userProductStores = new Map<string, Promise<ProductStore>>();
  const productStoreForIdentity = (userStore: WikiStore, identity: AuthIdentity): Promise<ProductStore> => {
    if (opts.productStore) return Promise.resolve(opts.productStore);
    const existing = userProductStores.get(identity.userId);
    if (existing) return existing;
    const created = createProductStore(userStore.root, { ownerUserId: identity.userId });
    userProductStores.set(identity.userId, created);
    return created;
  };
  configureGeminiProxyEnvForServer(host, port);
  configureAnthropicProxyEnvForServer(host, port);

  const status = providerStatus();
  console.log("  ✓ Local CLI runtime enabled");
  if (Object.values(status).some((p) => p.configured)) {
    console.log("  • Server model keys are ignored for desktop Local CLI runs");
  }

  const server = Bun.serve({
    port,
    hostname: host,
    // Disable idle timeout entirely. SSE generate/ask streams can go minutes
    // between events while an agent is waiting on Gemini; Bun's default 10s
    // idleTimeout would kill them mid-run.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      if (method === "OPTIONS") {
        const headers = corsHeaders(req);
        if (req.headers.get("origin") && !headers["access-control-allow-origin"]) {
          return new Response(null, { status: 403, headers });
        }
        return new Response(null, { status: 204, headers });
      }

      if (url.pathname.startsWith(`${GEMINI_PROXY_PREFIX}/`)) {
        return proxyGeminiOpenAI(req, url);
      }

      if (url.pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`)) {
        return proxyAnthropicOpenAI(req, url);
      }

      if ((method === "GET" || method === "HEAD") && PUBLIC_WIKI_ASSET_PATH_PATTERN.test(url.pathname)) {
        return builtAssetResponse(publicWikiAssetPath(url.pathname), method);
      }

      if ((method === "GET" || method === "HEAD") && url.pathname === "/styles.css") {
        const builtStylesheet = builtStylesheetHref();
        const stylesCss = existingStaticAssetPath("/styles.css") ?? (
          builtStylesheet ? distPublicAssetPath(builtStylesheet) : null
        );
        if (stylesCss && existsSync(stylesCss)) {
          return new Response(method === "HEAD" ? null : Bun.file(stylesCss), {
            headers: {
              "content-type": "text/css; charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        }
        return new Response("Stylesheet not found.", { status: 404 });
      }

      if ((method === "GET" || method === "HEAD") && BUILT_ASSET_PATH_PATTERN.test(url.pathname)) {
        return builtAssetResponse(url.pathname, method);
      }

      if ((method === "GET" || method === "HEAD") && AI_ICON_PATH_PATTERN.test(url.pathname)) {
        const filePath = publicAssetPath(url.pathname);
        if (existsSync(filePath)) {
          return new Response(method === "HEAD" ? null : Bun.file(filePath), {
            headers: {
              "content-type": "image/svg+xml; charset=utf-8",
              "cache-control": "public, max-age=86400",
            },
          });
        }
        return new Response("Not found.", { status: 404 });
      }

      if (
        (method === "GET" || method === "HEAD") &&
        (
          url.pathname === "/favicon.ico" ||
          url.pathname === "/favicon-16x16.png" ||
          url.pathname === "/favicon-32x32.png" ||
          url.pathname === "/apple-touch-icon.png" ||
          url.pathname === "/android-chrome-192x192.png" ||
          url.pathname === "/android-chrome-512x512.png" ||
          url.pathname === "/code-ready-poster.jpg" ||
          url.pathname === "/site.webmanifest"
        )
      ) {
        const filePath = publicAssetPath(url.pathname);
        if (existsSync(filePath)) {
          const contentType = url.pathname.endsWith(".ico")
            ? "image/x-icon"
            : url.pathname.endsWith(".jpg") || url.pathname.endsWith(".jpeg")
              ? "image/jpeg"
            : url.pathname.endsWith(".png")
              ? "image/png"
              : "application/manifest+json";
          return new Response(method === "HEAD" ? null : Bun.file(filePath), {
            headers: {
              "content-type": contentType,
              "cache-control": "public, max-age=86400",
            },
          });
        }
        return new Response("Not found.", { status: 404 });
      }

      if (method === "GET" && url.pathname === "/api/health") {
        const queue = await queueHealth(baseJobQueue);
        const secretGrants = await secretGrantHealth(baseSecretGrantStore);
        return jsonResponse({
          ok: true,
          version: "0.1.0",
          persistence: baseProductStore.mode,
          storage: {
            productStore: baseProductStore.mode,
            databaseUrlConfigured: Boolean(process.env.DATABASE_URL?.trim()),
            databasePublicUrlConfigured: Boolean(process.env.DATABASE_PUBLIC_URL?.trim()),
            sqlitePathConfigured: Boolean(productSqlitePathForRuntime()),
            root: baseStore.root,
            localDiskRole: baseProductStore.mode === "postgres" || baseProductStore.mode === "sqlite" ? "cache" : "primary",
          },
          queue,
          secretGrants,
          runMode: runModeFor(baseProductStore, baseJobQueue, baseSecretGrantStore),
          features: {
            wikiLanguages: true,
            wikiLanguageAliases: true,
          },
          authMode: authMode(),
          modelAccess: "local-cli",
          hasApiKey: false,
          generate: { active: activeGenerate, max: MAX_GENERATE },
          ask: { active: activeAsk, max: MAX_ASK, maxPerUser: MAX_ASK_PER_USER, maxRepos: MAX_ASK_REPOS },
          code: { active: activeCode, max: MAX_CODE },
          review: { active: activeReview, max: MAX_REVIEW },
        }, 200, req);
      }

      if (method === "GET" && url.pathname === "/api/desktop/status") {
        return jsonResponse({
          enabled: desktopEnabled(opts),
          appDataDir: desktopAppDataDir(opts),
          root: baseStore.root,
          localRepos: DESKTOP_ALLOWED_LOCAL_REPOS.size,
          publicWikiBaseUrl: publicSiteBaseUrl(),
          healthy: true,
        }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/desktop/local-repo/allow") {
        if (!desktopEnabled(opts)) return jsonResponse({ error: "Desktop mode is not enabled." }, 404, req);
        const expectedToken = desktopToken(opts);
        const desktopTokenHeader =
          req.headers.get("x-grok-wiki-desktop-token") ||
          req.headers.get("x-rlm-wiki-desktop-token");
        if (expectedToken && desktopTokenHeader !== expectedToken) {
          return jsonResponse({ error: "Desktop token required." }, 403, req);
        }
        const body = jsonObject(await req.json().catch(() => ({})));
        const repoPath = typeof body.path === "string" ? normalizeLocalRepoPath(body.path) : "";
        const requireGit = body.requireGit !== false;
        if (!repoPath) return jsonResponse({ error: "path required" }, 400, req);
        if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
          return jsonResponse({ error: "Selected folder does not exist." }, 400, req);
        }
        const gitRepo = existsSync(join(repoPath, ".git"));
        if (requireGit && !gitRepo) {
          return jsonResponse({ error: "Selected folder is not a git repository." }, 400, req);
        }
        DESKTOP_ALLOWED_LOCAL_REPOS.add(repoPath);
        return jsonResponse({
          path: repoPath,
          owner: "local",
          repo: basename(repoPath) || "repo",
          url: repoPath,
          gitRepo,
        }, 200, req);
      }

      if (method === "GET" && url.pathname === "/api/wiki/public-gallery") {
        const baseUrl = publicSiteBaseUrl();
        let response: Response;
        try {
          response = await fetch(publicGallerySearchUrl(url, baseUrl), {
            headers: { accept: "application/json" },
          });
        } catch {
          return jsonResponse({
            error: "Could not reach the public gallery. Try again when your connection is steadier.",
            publicWikiBaseUrl: baseUrl,
          }, 502, req);
        }
        const payload = jsonObject(await response.json().catch(() => ({})));
        if (!response.ok || typeof payload.error === "string") {
          return jsonResponse({
            error: typeof payload.error === "string" ? payload.error : `Public gallery search failed with HTTP ${response.status}`,
          }, response.ok ? 400 : response.status, req);
        }
        const items = (Array.isArray(payload.items) ? payload.items : []).map((item) => {
          const row = jsonObject(item);
          const href = publicGalleryAbsoluteUrl(baseUrl, row.href || row.publicUrl);
          return { ...row, href, publicUrl: href };
        });
        return jsonResponse({
          ...payload,
          ok: true,
          publicWikiBaseUrl: baseUrl,
          items,
        }, 200, req);
      }

      const publicWikiId = publicWikiIdFromApiPath(url.pathname);
      if (method === "GET" && url.pathname.startsWith("/api/public/wiki/")) {
        if (!publicWikiId) return jsonResponse({ error: "not found" }, 404, req);
        const artifact = await baseProductStore.getArtifact(PUBLIC_WIKI_ARTIFACT_KIND, publicWikiId);
        const data = artifact ? jsonObject(artifact.data) : {};
        if (data.published !== true) return jsonResponse({ error: "not found" }, 404, req);
        const wikiData = jsonObject(data.wiki);
        try {
          const wiki = WikiRecordSchema.parse(wikiData);
          return jsonResponse({
            wiki,
            publication: {
              publicId: publicWikiId,
              publicPath: publicWikiPath(publicWikiId, normalizePublicWikiVisibility(data.visibility), publicWikiSurfaceFromData(data)),
              publicUrl: publicWikiUrl(req, publicWikiId, normalizePublicWikiVisibility(data.visibility), publicWikiSurfaceFromData(data)),
              publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : null,
              updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
              readOnly: true,
              visibility: normalizePublicWikiVisibility(data.visibility),
              surface: publicWikiSurfaceFromData(data),
            },
          }, 200, req);
        } catch {
          return jsonResponse({ error: "not found" }, 404, req);
        }
      }

      if (isPublicUiPath(method, url.pathname)) {
        return publicIndexResponse(servedIndexHtml);
      }

      if (method === "GET" && url.pathname.startsWith("/public/wiki/")) {
        return new Response("Not found.", { status: 404 });
      }

      let authIdentity: AuthIdentity;
      let authSetCookie: string | undefined;
      try {
        const auth = await authenticateRequest(req);
        if (!auth) return jsonResponse({ error: "Authentication required" }, 401, req);
        authIdentity = auth.identity;
        authSetCookie = auth.setCookie;
      } catch (e) {
        const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 401;
        if (isUiPath(method, url.pathname)) {
          return inviteDeniedResponse(e instanceof Error ? e.message : String(e), status);
        }
        return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, status, req);
      }

      if (method === "GET" && url.pathname.startsWith("/invite/")) {
        return withAuthCookies(inviteAcceptResponse(req, authIdentity), authSetCookie);
      }

      const inviteGate = authorizeInviteRequest(req, authIdentity);
      if (!inviteGate.allowed) {
        if (url.pathname.startsWith("/api/")) {
          return withAuthCookies(jsonResponse({
            error: inviteGate.reason || "Invite required.",
            code: "INVITE_REQUIRED",
            inviteOnly: true,
          }, 403, req), authSetCookie);
        }
        return withAuthCookies(inviteDeniedResponse(inviteGate.reason || "Invite required.", 403), authSetCookie);
      }

      if (isUiPath(method, url.pathname)) {
        return withAuthCookies(indexResponse(servedIndexHtml), authSetCookie, inviteGate.headers);
      }

      const store = opts.store ?? new WikiStore(join(baseStore.root, "users", authIdentity.userId));
      const productStore = await productStoreForIdentity(store, authIdentity);
      const capabilityProfile = { defaultUserId: authIdentity.email || authIdentity.userId };
      const loadCapabilitiesForRequest = (): Promise<CapabilitySettings> =>
        hydrateCapabilitySettingsCache(store.root, productStore, capabilityProfile);
      const capabilityRuntimeForRequest = async (): Promise<Awaited<ReturnType<typeof capabilityRuntime>>> => {
        await loadCapabilitiesForRequest();
        return capabilityRuntime(store.root, capabilityProfile);
      };
      const persistCapabilitiesForRequest = (settings: CapabilitySettings): Promise<void> =>
        persistCapabilitySettings(productStore, settings);

      if (method === "GET" && url.pathname === "/api/me") {
        return withAuthCookies(jsonResponse({
          userId: authIdentity.userId,
          email: authIdentity.email,
          authMode: authIdentity.authMode,
        }, 200, req), authSetCookie, inviteGate.headers);
      }

      if (method === "POST" && url.pathname === "/api/admin/invites") {
        if (!isInviteAdmin(authIdentity)) {
          return jsonResponse({ error: "Admin invite access required." }, 403, req);
        }
        try {
          const body = jsonObject(await req.json().catch(() => ({})));
          const emails = Array.isArray(body.emails)
            ? body.emails.map(String)
            : typeof body.email === "string"
              ? [body.email]
              : [];
          if (!emails.length) return jsonResponse({ error: "emails required" }, 400, req);
          const days = typeof body.days === "number" || typeof body.days === "string" ? Number(body.days) : undefined;
          const redirectPath = typeof body.redirectPath === "string" ? body.redirectPath : "/code";
          return jsonResponse({
            inviteOnly: inviteGateEnabled(),
            links: createInviteLinksForEmails({
              emails,
              days,
              redirectPath,
              baseUrl: publicBaseUrl(req),
            }),
          }, 200, req);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
      }

      if (method === "GET" && url.pathname === "/api/channels") {
        return jsonResponse(await channelConfigForRequest(req, opts), 200, req);
      }

      if (method === "GET" && url.pathname === "/api/local-cli/agents") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            enabled: false,
            agents: [],
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 200, req);
        }
        return jsonResponse(await getLocalCliAgents({
          rescan: url.searchParams.get("rescan") === "1",
          probe: url.searchParams.get("probe") === "1",
        }), 200, req);
      }

      // Provider usage bars (Codex / Claude / Grok rate limits). Desktop/localhost only;
      // credentials stay on the machine and are never returned in the response.
      if (method === "GET" && url.pathname === "/api/local-cli/usage") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const force = url.searchParams.get("refresh") === "1";
          return jsonResponse(await getProviderUsageState({
            force,
            appDataDir: desktopAppDataDir(opts),
          }), 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 500, req);
        }
      }

      // AI Provider Accounts (Orca-style system default + managed Claude/Codex homes; Grok session status).
      if (method === "GET" && url.pathname === "/api/local-cli/provider-accounts") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          return jsonResponse(getProviderAccountsSnapshot({
            appDataDir: desktopAppDataDir(opts),
          }), 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 500, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/local-cli/provider-accounts/select") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const body = await req.json().catch(() => null) as {
            provider?: string;
            accountId?: string | null;
          } | null;
          const provider = body?.provider === "codex" ? "codex" : body?.provider === "claude" ? "claude" : null;
          if (!provider) {
            return jsonResponse({ error: "provider must be claude or codex" }, 400, req);
          }
          const accountId =
            body?.accountId === null || body?.accountId === undefined || body?.accountId === ""
              ? null
              : String(body.accountId);
          const snapshot = selectProviderAccount(provider, accountId, {
            appDataDir: desktopAppDataDir(opts),
          });
          // Bust usage cache so the bar reflects the newly selected account.
          const usage = await getProviderUsageState({
            force: true,
            appDataDir: desktopAppDataDir(opts),
          });
          return jsonResponse({ ...snapshot, usage }, 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/local-cli/provider-accounts/add") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const body = await req.json().catch(() => null) as { provider?: string } | null;
          const provider = body?.provider === "codex" ? "codex" : body?.provider === "claude" ? "claude" : null;
          if (!provider) {
            return jsonResponse({ error: "provider must be claude or codex" }, 400, req);
          }
          // Opens browser OAuth (Claude/Codex). Can take up to ~3 minutes.
          return jsonResponse(await addProviderAccount(provider, {
            appDataDir: desktopAppDataDir(opts),
          }), 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/local-cli/provider-accounts/remove") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const body = await req.json().catch(() => null) as {
            provider?: string;
            accountId?: string;
          } | null;
          const provider = body?.provider === "codex" ? "codex" : body?.provider === "claude" ? "claude" : null;
          const accountId = body?.accountId ? String(body.accountId) : "";
          if (!provider || !accountId) {
            return jsonResponse({ error: "provider and accountId are required" }, 400, req);
          }
          return jsonResponse(removeProviderAccount(provider, accountId, {
            appDataDir: desktopAppDataDir(opts),
          }), 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/local-cli/provider-accounts/reauth") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const body = await req.json().catch(() => null) as {
            provider?: string;
            accountId?: string;
          } | null;
          const provider = body?.provider === "codex" ? "codex" : body?.provider === "claude" ? "claude" : null;
          const accountId = body?.accountId ? String(body.accountId) : "";
          if (!provider || !accountId) {
            return jsonResponse({ error: "provider and accountId are required" }, 400, req);
          }
          return jsonResponse(await reauthProviderAccount(provider, accountId, {
            appDataDir: desktopAppDataDir(opts),
          }), 200, req);
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
          }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/local-cli/terminal-workspace") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          const body = await req.json().catch(() => null);
          return jsonResponse(await prepareLocalCliTerminalWorkspace(body), 200, req);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, req);
        }
      }

      const terminalWorkspaceMatch = url.pathname.match(/^\/api\/local-cli\/terminal-workspace\/([^/]+)$/);
      if (method === "DELETE" && terminalWorkspaceMatch) {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
          }, 400, req);
        }
        try {
          return jsonResponse({
            ok: true,
            released: await releaseLocalCliTerminalWorkspace(terminalWorkspaceMatch[1]),
          }, 200, req);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/route") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
            decision: clarifyRouteDecision(
              "The routing brain needs the desktop app or localhost; pick Wiki, Ask, or Docs instead.",
            ),
          }, 400, req);
        }
        let routeBody: { query?: string; localCli?: unknown; agentId?: unknown };
        try {
          routeBody = (await req.json()) as typeof routeBody;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const routeQuery = typeof routeBody.query === "string" ? routeBody.query.trim() : "";
        if (!routeQuery) {
          return jsonResponse({ error: "query is required" }, 400, req);
        }
        // Honor the user's selected agent: prefer an explicit localCli config, then a
        // bare agentId, then the default agent.
        const routeLocalCli = normalizeLocalCliConfig(
          routeBody.localCli ?? (routeBody.agentId ? { agentId: routeBody.agentId } : undefined),
        );
        const decision = await runRouteDecision(routeQuery, routeLocalCli);
        return jsonResponse({ decision, localCli: routeLocalCli }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/wiki-interview") {
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
            questions: [],
          }, 400, req);
        }
        let interviewBody: { intent?: string; source?: unknown; localCli?: unknown; agentId?: unknown };
        try {
          interviewBody = (await req.json()) as typeof interviewBody;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const intent = typeof interviewBody.intent === "string" ? interviewBody.intent.trim() : "";
        if (!intent) {
          return jsonResponse({ error: "intent is required" }, 400, req);
        }
        const interviewSource =
          typeof interviewBody.source === "string" && interviewBody.source.trim()
            ? interviewBody.source.trim()
            : null;
        const interviewLocalCli = normalizeLocalCliConfig(
          interviewBody.localCli ?? (interviewBody.agentId ? { agentId: interviewBody.agentId } : undefined),
        );
        const questions = await runWikiInterview(intent, interviewSource, interviewLocalCli);
        return jsonResponse({ questions, localCli: interviewLocalCli }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/telemetry-config") {
        // The desktop frontend pushes the user's analytics preference here so
        // server-side error telemetry follows the same opt-in as the client.
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({ error: "Telemetry config is desktop-only.", ok: false }, 400, req);
        }
        let telemetryBody: { enabled?: unknown };
        try {
          telemetryBody = await req.json();
        } catch {
          return jsonResponse({ error: "Invalid JSON body.", ok: false }, 400, req);
        }
        configureServerTelemetry(telemetryBody?.enabled === true);
        return jsonResponse({ ok: true }, 200, req);
      }
      if (method === "POST" && url.pathname === "/api/tasks/extract") {
        // Tasks board: distill a cooled Ask answer into actionable backlog items
        // via the local CLI agent. Mirrors /api/wiki-interview; the desktop falls
        // back to its structured markdown parse when this returns no tasks.
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
            tasks: [],
          }, 400, req);
        }
        let taskExtractBody: { answer?: string; question?: unknown; localCli?: unknown; agentId?: unknown };
        try {
          taskExtractBody = (await req.json()) as typeof taskExtractBody;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const taskExtractAnswer = typeof taskExtractBody.answer === "string" ? taskExtractBody.answer.trim() : "";
        if (!taskExtractAnswer) {
          return jsonResponse({ error: "answer is required" }, 400, req);
        }
        const taskExtractQuestion =
          typeof taskExtractBody.question === "string" && taskExtractBody.question.trim()
            ? taskExtractBody.question.trim()
            : null;
        const taskExtractLocalCli = normalizeLocalCliConfig(
          taskExtractBody.localCli ?? (taskExtractBody.agentId ? { agentId: taskExtractBody.agentId } : undefined),
        );
        // Grouped into epics (each with sub-tasks). `tasks` is kept as a flat
        // mirror so older clients still get a usable list.
        const extractedEpics = await runEpicExtract(taskExtractAnswer, taskExtractQuestion, taskExtractLocalCli);
        const flatTasks = extractedEpics.flatMap((epic) => epic.tasks);
        return jsonResponse({ epics: extractedEpics, tasks: flatTasks, localCli: taskExtractLocalCli }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/ask-interview") {
        // Ask Clarify: turn the user's raw question into 2-3 clarifying questions
        // before the ask is sent to the agent. Mirrors /api/wiki-interview.
        if (!localCliRuntimeEnabled(req, opts)) {
          return jsonResponse({
            error: "Local CLI mode is only available in the desktop app or on localhost.",
            code: "LOCAL_CLI_LOCAL_ONLY",
            questions: [],
          }, 400, req);
        }
        let askInterviewBody: { question?: string; source?: unknown; localCli?: unknown; agentId?: unknown; screenshots?: unknown; codeGraphEnabled?: boolean };
        try {
          askInterviewBody = (await req.json()) as typeof askInterviewBody;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const askQuestion = typeof askInterviewBody.question === "string" ? askInterviewBody.question.trim() : "";
        if (!askQuestion) {
          return jsonResponse({ error: "question is required" }, 400, req);
        }
        const askInterviewSource =
          typeof askInterviewBody.source === "string" && askInterviewBody.source.trim()
            ? askInterviewBody.source.trim()
            : null;
        const askInterviewLocalCli = normalizeLocalCliConfig(
          askInterviewBody.localCli ?? (askInterviewBody.agentId ? { agentId: askInterviewBody.agentId } : undefined),
        );
        // Pre-warm (R1): the ask that follows this interview targets the same
        // repo, so kick code-kb provisioning now. Fire-and-forget; an
        // unparseable source just skips the warm-up.
        if (askInterviewSource && codeGraphEnabledForRequest(askInterviewBody.codeGraphEnabled)) {
          try {
            prewarmCodeKbSession(parseRepoInput(askInterviewSource, localFolderAccessForReadOnlyRequest(req, host, opts)));
          } catch {
            // The interview itself does not need the parsed ref.
          }
        }
        // Full screenshot attachments ride the interview request so the Clarify agent
        // can actually read them (the local-cli sidecar materializes them as files and
        // points the agent at the paths, same as the Ask run itself).
        let askInterviewScreenshots;
        try {
          askInterviewScreenshots = normalizeScreenshotAttachments(askInterviewBody.screenshots);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
        const askScreenshotNames = askInterviewScreenshots
          .map((screenshot) => (screenshot.name || "").trim())
          .filter((name) => name.length > 0);
        const askInterviewQuestion = askInterviewScreenshots.length > 0
          ? [
              askQuestion,
              "",
              `The user attached ${askInterviewScreenshots.length} screenshot(s)${askScreenshotNames.length ? ` (${askScreenshotNames.join(", ")})` : ""} as visual context. Review them before writing your questions, and if they are central to the question, ground at least one clarifying question in what they show.`,
            ].join("\n")
          : askQuestion;
        const askQuestions = await runAskInterview(
          askInterviewQuestion,
          askInterviewSource,
          askInterviewLocalCli,
          undefined,
          undefined,
          askInterviewScreenshots,
        );
        return jsonResponse({ questions: askQuestions, localCli: askInterviewLocalCli }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/provider-setup/start") {
        return jsonResponse({
          error: "Provider setup is disabled in Local CLI-only mode. Use a configured local CLI runtime instead.",
          code: "MODEL_ACCESS_REQUIRED",
        }, 400, req);
      }

      if (method === "GET" && url.pathname === "/api/capabilities") {
        const settings = await loadCapabilitiesForRequest();
        const runtime = await capabilityRuntimeForRequest();
        return jsonResponse({
          settings: capabilitySnapshot(settings),
          active: runtime.snapshot,
          todos: CAPABILITY_TODOS,
        });
      }

      if (method === "POST" && url.pathname === "/api/capabilities/composio") {
        try {
          await loadCapabilitiesForRequest();
          const settings = updateComposioSettings(store.root, await req.json(), capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/composio/toolkits") {
        try {
          await loadCapabilitiesForRequest();
          const settings = addComposioToolkits(store.root, await req.json(), capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/composio/toolkits/delete") {
        try {
          const body = jsonObject(await req.json());
          const slug = typeof body.slug === "string" ? body.slug : "";
          if (!slug) return jsonResponse({ error: "slug required" }, 400);
          await loadCapabilitiesForRequest();
          const settings = removeComposioToolkit(store.root, slug, capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/composio/authorize") {
        try {
          await loadCapabilitiesForRequest();
          return jsonResponse(await authorizeComposioToolkit(store.root, await req.json(), capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/composio/test") {
        try {
          await loadCapabilitiesForRequest();
          return jsonResponse(await inspectComposio(store.root, await req.json().catch(() => ({})), capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "GET" && url.pathname === "/api/capabilities/composio/catalog") {
        try {
          await loadCapabilitiesForRequest();
          return jsonResponse(await listComposioToolkitCatalog(store.root, Object.fromEntries(url.searchParams), capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "GET" && url.pathname === "/api/capabilities/composio/connected") {
        try {
          await loadCapabilitiesForRequest();
          return jsonResponse(await listComposioConnectedApps(store.root, capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/mcp") {
        try {
          await loadCapabilitiesForRequest();
          const settings = await addOrUpdateMCPServer(store.root, await req.json(), capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/mcp/delete") {
        try {
          const body = jsonObject(await req.json());
          const id = typeof body.id === "string" ? body.id : "";
          if (!id) return jsonResponse({ error: "id required" }, 400);
          await loadCapabilitiesForRequest();
          const settings = removeMCPServer(store.root, id, capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/mcp/test") {
        try {
          const body = jsonObject(await req.json());
          const id = typeof body.id === "string" ? body.id : "";
          if (!id) return jsonResponse({ error: "id required" }, 400);
          await loadCapabilitiesForRequest();
          return jsonResponse(await testMCPServer(store.root, id, capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/skills") {
        try {
          await loadCapabilitiesForRequest();
          const settings = await addGithubSkill(store.root, await req.json(), capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/skills/inspect") {
        try {
          await loadCapabilitiesForRequest();
          return jsonResponse(await inspectGithubSkillSource(store.root, await req.json(), capabilityProfile));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/capabilities/skills/delete") {
        try {
          const body = jsonObject(await req.json());
          const id = typeof body.id === "string" ? body.id : "";
          if (!id) return jsonResponse({ error: "id required" }, 400);
          await loadCapabilitiesForRequest();
          const settings = removeGithubSkill(store.root, id, capabilityProfile);
          await persistCapabilitiesForRequest(settings);
          return jsonResponse({ settings: capabilitySnapshot(settings), todos: CAPABILITY_TODOS });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "GET" && url.pathname === "/api/runs") {
        const kindParam = url.searchParams.get("kind");
        const limit = Number(url.searchParams.get("limit") || 30);
        const kinds = kindParam
          ? kindParam.split(",").map((kind) => kind.trim()).filter(Boolean) as ProductRunKind[]
          : undefined;
        const listedRuns = await productStore.listRuns({ kind: kinds?.length === 1 ? kinds[0] : kinds, limit });
        const runs = await Promise.all(listedRuns.map((run) => recoverStaleRunFromJob(productStore, baseProductStore, baseJobQueue, run)));
        return jsonResponse({ runs });
      }

      if (method === "GET" && url.pathname === "/api/run") {
        const id = url.searchParams.get("id");
        if (!id) return jsonResponse({ error: "id required" }, 400);
        let run = await productStore.getRun(id, { includeEvents: true });
        if (!run) return jsonResponse({ error: "not found" }, 404);
        run = await recoverStaleRunFromJob(productStore, baseProductStore, baseJobQueue, run);
        run = await productStore.getRun(id, { includeEvents: true }) ?? run;
        return jsonResponse({ run });
      }

      if (method === "GET" && url.pathname === "/api/run/stream") {
        const id = url.searchParams.get("id");
        if (!id) return jsonResponse({ error: "id required" }, 400);
        const run = await productStore.getRun(id);
        if (!run) return jsonResponse({ error: "not found" }, 404);
        await recoverStaleRunFromJob(productStore, baseProductStore, baseJobQueue, run);
        return persistedRunSseResponse(productStore, id, req);
      }

      if (method === "POST" && url.pathname === "/api/wiki/run/finish-partial") {
        let body: { id?: string; runId?: string; message?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const id = typeof body.id === "string" && body.id.trim()
          ? body.id.trim()
          : typeof body.runId === "string" ? body.runId.trim() : "";
        if (!id) return jsonResponse({ error: "id required" }, 400);
        const run = await productStore.getRun(id);
        if (!run) return jsonResponse({ error: "not found" }, 404);
        const message = typeof body.message === "string" && body.message.trim()
          ? body.message.trim()
          : "Generation finished from the last saved checkpoint.";
        const recovered = await promoteWikiDraftRun(productStore, baseProductStore, run, message, { manual: true });
        if (!recovered) return jsonResponse({ error: "No saved wiki draft pages were available for this run." }, 409);
        return jsonResponse({ ok: true, run: recovered });
      }

      if (method === "POST" && url.pathname === "/api/run/cancel") {
        let body: { id?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) return jsonResponse({ error: "id required" }, 400);

        const run = await productStore.getRun(id);
        if (!run) return jsonResponse({ error: "not found" }, 404);

        // Cancel any queue jobs first so remote workers lose heartbeat ownership
        // (Fable/Claudex: null heartbeat aborts the Unikraft/Railway worker).
        const jobs = await baseJobQueue.listByRun(id).catch(() => []);
        for (const job of jobs) {
          if (job.status === "queued" || job.status === "running") {
            await baseJobQueue.cancel(job.id, USER_STOP_MESSAGE).catch(() => null);
          }
        }

        const active = activeRunControllers.get(id);
        if (active) {
          active.controller.abort(USER_STOP_MESSAGE);
          return jsonResponse({ ok: true, status: "canceling", id });
        }

        if (run.kind === "code" && (run.status === "running" || codeTurnsFromRun(run).some((turn) => turn.status === "running"))) {
          const canceled = canceledCodeRunResult(run);
          const updated = await productStore.updateRun(run.id, {
            status: canceled.status,
            result: canceled.result,
            error: canceled.status === "canceled" ? USER_STOP_MESSAGE : null,
          });
          await productStore.appendEvent(run.id, "canceled", { message: USER_STOP_MESSAGE });
          runProcessEvents.delete(run.id);
          activeCodeRunIds.delete(run.id);
          return jsonResponse({ ok: true, status: updated?.status ?? canceled.status, id });
        }

        if (run.status === "running") {
          const updated = await productStore.updateRun(run.id, {
            status: "canceled",
            error: USER_STOP_MESSAGE,
            result: { ...jsonObject(run.result), processSnapshot: processSnapshotFor(run.id) },
          });
          await productStore.appendEvent(run.id, "canceled", { message: USER_STOP_MESSAGE });
          runProcessEvents.delete(run.id);
          activeAskRunIds.delete(run.id);
          return jsonResponse({ ok: true, status: updated?.status ?? "canceled", id });
        }

        return jsonResponse({ ok: true, status: run.status, id });
      }

      if (method === "POST" && url.pathname === "/api/run/delete") {
        let body: { id?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) return jsonResponse({ error: "id required" }, 400);
        const run = await productStore.getRun(id);
        if (!run) return jsonResponse({ error: "not found" }, 404);
        if (run.status === "running" || activeRunControllers.has(id)) {
          return jsonResponse({ error: "Stop this run before deleting it." }, 409);
        }
        const deleted = await productStore.deleteRun(id);
        runProcessEvents.delete(id);
        activeAskRunIds.delete(id);
        activeCodeRunIds.delete(id);
        return jsonResponse({ ok: deleted, id });
      }

      if (method === "POST" && url.pathname === "/api/code-anything/turn/delete") {
        let body: { runId?: string; turnId?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        const turnId = typeof body.turnId === "string" ? body.turnId.trim() : "";
        if (!runId || !turnId) return jsonResponse({ error: "runId and turnId required" }, 400);
        const run = await productStore.getRun(runId);
        if (!run || run.kind !== "code") return jsonResponse({ error: "Code session not found" }, 404);
        const turns = codeTurnsFromRun(run);
        const target = turns.find((turn) => turn.id === turnId);
        if (!target) return jsonResponse({ error: "Code turn not found" }, 404);
        if (target.status === "running" || activeRunControllers.has(runId)) {
          return jsonResponse({ error: "Stop this turn before deleting it." }, 409);
        }
        if (target.status !== "canceled" && target.status !== "error") {
          return jsonResponse({ error: "Only stopped or failed turns can be deleted." }, 400);
        }
        const remainingTurns = turns.filter((turn) => turn.id !== turnId);
        if (!remainingTurns.length) {
          return jsonResponse({ error: "This is the only turn in the session. Delete the session instead." }, 409);
        }
        const next = codeRunResultFromTurns(run, remainingTurns, processSnapshotFor(run.id));
        const updated = await productStore.updateRun(run.id, {
          status: next.status,
          result: next.result,
          error: next.error,
        });
        await productStore.appendEvent(run.id, "turn-deleted", { turnId });
        return jsonResponse({ ok: true, run: updated });
      }

      if (method === "GET" && url.pathname === "/api/wikis") {
        await recoverOrphanedInlineWikiRuns(productStore, baseProductStore, baseJobQueue);
        const [artifacts, activeRuns] = await Promise.all([
          productStore.listArtifacts("wiki", { limit: 100 }),
          listActiveWikiRuns(productStore, baseJobQueue),
        ]);
        const artifactWikis = artifacts.map((artifact) => wikiSummaryFromRecord(artifact.data));
        const seenWikiKeys = new Set(artifacts.map((artifact) => artifact.key.toLowerCase()));
        const fileWikis = store
          .list()
          .filter((wiki) =>
            !seenWikiKeys.has(
              (wiki.id
                ? wikiInstanceArtifactKey(wiki.id)
                : wikiArtifactKey(wiki.owner, wiki.repo, wiki.branch, wiki.sourcePath)).toLowerCase(),
            ),
          );
        if (artifactWikis.length) {
          return jsonResponse({ wikis: [...artifactWikis, ...fileWikis], activeRuns });
        }
        return jsonResponse({ wikis: store.list(), activeRuns });
      }

      if (method === "GET" && url.pathname === "/api/knowledge-bases") {
        // Lightweight per-repo KB index for the desktop project-group star glow.
        // Returns summaries only (no card bodies) so the payload stays small and
        // the pure groupByRepo fn can be fed a threaded freshness map.
        const artifacts = await productStore.listArtifacts(KNOWLEDGE_BASE_ARTIFACT_KIND, { limit: 200 });
        const knowledgeBases = artifacts.map((artifact) => {
          const kb = normalizeKnowledgeBase(artifact.data, { repoKey: artifact.key, repoLabel: artifact.key });
          return {
            repoKey: kb.repoKey,
            repoLabel: kb.repoLabel,
            cardCount: kb.cards.length,
            lastRollupAt: kb.lastRollupAt,
            lastIncrementAt: kb.lastIncrementAt,
            updatedAt: kb.updatedAt,
            ...(kb.publicId ? { publicId: kb.publicId } : {}),
            // Phase 4 feedback loop: the LOCAL wiki record id the KB was published
            // under. The client builds a wiki-context ref from it so an ask in this
            // repo auto-injects the KB markdown (resolveAskWikiContexts reads the
            // local store by id). Omitted until the KB has been published.
            ...(kb.wikiRecordId ? { wikiRecordId: kb.wikiRecordId } : {}),
          };
        });
        return jsonResponse({ knowledgeBases });
      }

      if (method === "GET" && url.pathname === "/api/knowledge-base") {
        // Phase 5 KB view: the full per-repo Knowledge Base including card bodies and
        // every freshness field (status / corroborationCount / contradictsFlags /
        // topicTags / sourceAskIds / lastUpdated). Distinct from /api/knowledge-bases
        // (the lightweight index for the star glow). Returns an empty KB shell when
        // none exists yet so the view renders its EMPTY state, never a 404.
        const repoKey = String(url.searchParams.get("repoKey") || "").trim();
        if (!repoKey) return jsonResponse({ error: "repoKey is required" }, 400);
        const kb = await loadKnowledgeBase(productStore, repoKey);
        if (!kb) {
          return jsonResponse({
            knowledgeBase: {
              repoKey,
              repoLabel: repoKey,
              cards: [],
              lastRollupAt: null,
              lastIncrementAt: null,
              updatedAt: new Date(0).toISOString(),
            },
            publicUrl: null,
          });
        }
        // The copy-link in the KB view needs the actual publication state. Read the
        // wiki_publication artifact keyed by the KB's stable WikiRecord id so private
        // links round-trip as /share/wiki/... instead of being reconstructed as public.
        const publicationArtifact = kb.wikiRecordId
          ? await productStore.getArtifact(WIKI_PUBLICATION_ARTIFACT_KIND, wikiInstanceArtifactKey(kb.wikiRecordId))
          : null;
        const publication = publicationStateFromData(publicationArtifact ? jsonObject(publicationArtifact.data) : null, req);
        const fallbackPublicUrl = !publication.publicUrl && kb.publicId ? publicWikiUrl(req, kb.publicId, "public", "wiki") : null;
        return jsonResponse({
          knowledgeBase: kb,
          publication: publication.publicUrl ? publication : null,
          publicUrl: publication.publicUrl || fallbackPublicUrl,
        });
      }

      if (method === "POST" && url.pathname === "/api/distill") {
        // Phase 2 distillation pipeline. Two scopes (Decision Log 1):
        //   - increment: distill the cooled chat thread's history.
        //   - rollup:    distill the repo's wiki backbone (summary + page content).
        // Cards persist via Phase 1's mergeSafeAppend / saveKnowledgeBase ONLY; they
        // are never stored as synthetic GeneratedPage entries.
        let distillBody: {
          repoKey?: string;
          repoLabel?: string;
          scope?: string;
          localCli?: unknown;
          history?: Array<{ role?: string; content?: string; askId?: string }>;
          // rollup wiki ref (any of id, or owner+repo+branch+sourcePath):
          wikiId?: string;
          owner?: string;
          repo?: string;
          branch?: string | null;
          sourcePath?: string | null;
        };
        try {
          distillBody = (await req.json()) as typeof distillBody;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }

        const distillRepoKey = typeof distillBody.repoKey === "string" ? distillBody.repoKey.trim() : "";
        if (!distillRepoKey) {
          return jsonResponse({ error: "repoKey is required" }, 400, req);
        }
        const distillRepoLabel =
          typeof distillBody.repoLabel === "string" && distillBody.repoLabel.trim()
            ? distillBody.repoLabel.trim()
            : distillRepoKey;
        const distillScope: DistillScope = distillBody.scope === "rollup" ? "rollup" : "increment";
        const distillLocalCli = normalizeLocalCliConfig(distillBody.localCli);
        const distillPreflight = await localCliPreflightResponse(
          "local-cli",
          distillLocalCli,
          req,
          "distillation",
          opts,
        );
        if (distillPreflight) return distillPreflight;

        // Assemble the scope-specific input.
        let distillMessages: KbHistoryMessage[] = [];
        if (distillScope === "increment") {
          const rawHistory = Array.isArray(distillBody.history) ? distillBody.history : [];
          distillMessages = rawHistory
            .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .map((m, i) => ({
              askId: typeof m.askId === "string" && m.askId.trim() ? m.askId.trim() : `turn-${i + 1}`,
              role: m.role as "user" | "assistant",
              content: String(m.content),
            }));
          if (!distillMessages.length) {
            return jsonResponse({ error: "history is required for an increment distill" }, 400, req);
          }
        } else {
          const wiki = await loadWikiRecord(productStore, store, {
            id: distillBody.wikiId,
            owner: distillBody.owner,
            repo: distillBody.repo,
            branch: distillBody.branch,
            sourcePath: distillBody.sourcePath,
          });
          if (!wiki) {
            return jsonResponse({ error: "no wiki found for this repo; generate a wiki before a rollup" }, 404, req);
          }
          distillMessages = buildRollupMessages(wiki);
        }

        if (activeDistill >= MAX_DISTILL) {
          return busyResponse({ kind: "distill", scope: "global", active: activeDistill, max: MAX_DISTILL, retryAfter: 15, req });
        }
        const releaseDistillSlot = tryAcquireUserSlot(activeDistillByUser, authIdentity.userId, MAX_ASK_PER_USER);
        if (!releaseDistillSlot) {
          return busyResponse({
            kind: "distill",
            scope: "user",
            active: activeDistillByUser.get(authIdentity.userId) ?? MAX_ASK_PER_USER,
            max: MAX_ASK_PER_USER,
            retryAfter: 15,
            req,
          });
        }

        let distillRun = await productStore.createRun({
          kind: "distill",
          title: `Distill ${distillScope} · ${distillRepoLabel}`,
          input: {
            repoKey: distillRepoKey,
            repoLabel: distillRepoLabel,
            scope: distillScope,
            localCli: distillLocalCli,
          },
        });

        activeDistill++;
        const distillController = new AbortController();
        activeRunControllers.set(distillRun.id, {
          controller: distillController,
          kind: "distill",
          startedAt: new Date().toISOString(),
        });

        return runResponse(
          productStore,
          baseJobQueue,
          baseSecretGrantStore,
          distillRun,
          authIdentity.userId,
          async (send, _close, signal) => {
            const abortOnClientClose = (): void => distillController.abort(USER_STOP_MESSAGE);
            if (signal.aborted) abortOnClientClose();
            else signal.addEventListener("abort", abortOnClientClose, { once: true });
            sendPersisted(productStore, distillRun.id, send, "start", {
              runId: distillRun.id,
              repoKey: distillRepoKey,
              repoLabel: distillRepoLabel,
              scope: distillScope,
              localCli: distillLocalCli,
              selfHeal: KB_SELF_HEAL_ENABLED,
            });
            try {
              const result = await distillToKnowledgeBase({
                store: productStore,
                repoKey: distillRepoKey,
                repoLabel: distillRepoLabel,
                scope: distillScope,
                history: distillScope === "increment" ? distillMessages : undefined,
                rollupMessages: distillScope === "rollup" ? distillMessages : undefined,
                localCli: distillLocalCli,
                selfHeal: KB_SELF_HEAL_ENABLED,
                runId: distillRun.id,
                signal: distillController.signal,
                onEvent: (ev: DistillEvent) => {
                  sendPersisted(productStore, distillRun.id, send, ev.type, ev);
                },
              });
              distillRun = await productStore.updateRun(distillRun.id, {
                status: "done",
                result: { distill: result, processSnapshot: processSnapshotFor(distillRun.id) },
                error: null,
              }) ?? distillRun;
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              const canceled = isAbortError(e) || distillController.signal.aborted;
              sendPersisted(productStore, distillRun.id, send, canceled ? "canceled" : "error", {
                message: canceled ? USER_STOP_MESSAGE : message,
              });
              distillRun = await productStore.updateRun(distillRun.id, {
                status: canceled ? "canceled" : "error",
                error: canceled ? USER_STOP_MESSAGE : message,
              }) ?? distillRun;
            } finally {
              signal.removeEventListener("abort", abortOnClientClose);
              await waitForPersistedEvents(distillRun.id);
              runProcessEvents.delete(distillRun.id);
              activeRunControllers.delete(distillRun.id);
              releaseDistillSlot();
              activeDistill = Math.max(0, activeDistill - 1);
            }
          },
          req,
        );
      }

      if (method === "GET" && url.pathname === "/api/wiki") {
        const id = url.searchParams.get("id");
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");
        const sourcePath = url.searchParams.get("sourcePath");
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400);
        const wiki = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!wiki) return jsonResponse({ error: "not found" }, 404);
        return jsonResponse({ wiki });
      }

      if (method === "GET" && url.pathname === "/api/wiki/export.zip") {
        const id = url.searchParams.get("id");
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");
        const sourcePath = url.searchParams.get("sourcePath");
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400);
        const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!record) return jsonResponse({ error: "not found" }, 404);
        const zip = createStoredZip(wikiExportFiles(record));
        const fileName = `${slugPathPart(record.owner)}-${slugPathPart(record.repo)}-wiki.zip`;
        return binaryResponse(zip, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${fileName}"`,
          "cache-control": "no-store",
        }, req);
      }

      if (method === "GET" && url.pathname === "/api/wiki/export.pdf.html") {
        const id = url.searchParams.get("id");
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");
        const sourcePath = url.searchParams.get("sourcePath");
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400);
        const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!record) return jsonResponse({ error: "not found" }, 404);
        return new Response(wikiPrintExportHtml(record), {
          headers: {
            ...corsHeaders(req),
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      const slidesViewerPrefix = "/api/wiki/slides/viewer/";
      if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(slidesViewerPrefix)) {
        const rest = url.pathname.slice(slidesViewerPrefix.length);
        const [viewerId = "", ...assetParts] = rest.split("/");
        const assetPath = assetParts.join("/") || "index.html";
        let decodedViewerId = "";
        let decodedAssetPath = "";
        try {
          decodedViewerId = decodeURIComponent(viewerId);
          decodedAssetPath = decodeURIComponent(assetPath);
        } catch {
          return new Response("Bad request.", { status: 400, headers: corsHeaders(req) });
        }
        if (!decodedAssetPath || decodedAssetPath === "index.html") {
          await prepareOpenSlideViewerDist(store.root, decodedViewerId);
        }
        const filePath = await openSlideViewerFilePath(store.root, decodedViewerId, decodedAssetPath);
        if (!filePath) return new Response("Not found.", { status: 404, headers: corsHeaders(req) });
        return new Response(method === "HEAD" ? null : Bun.file(filePath), {
          headers: {
            "content-type": openSlideViewerContentType(filePath),
            "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
            ...corsHeaders(req),
          },
        });
      }

      if (method === "GET" && url.pathname === "/api/wiki/slides/latest") {
        const id = url.searchParams.get("id");
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");
        const sourcePath = url.searchParams.get("sourcePath");
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400, req);
        const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!record) return jsonResponse({ error: "wiki not found" }, 404, req);
        const slidesRunId = await latestSlidesArtifactForWiki(productStore, record);
        if (!slidesRunId) return jsonResponse({ error: "slides not found" }, 404, req);
        try {
          return jsonResponse(await ensureWikiSlidesViewer(productStore, store.root, record, slidesRunId), 200, req);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, req);
        }
      }

      if (method === "GET" && url.pathname === "/api/wiki/slides.zip") {
        const slidesRunId = url.searchParams.get("slidesRunId")?.trim();
        if (slidesRunId) {
          const artifact = await productStore.getArtifact(WIKI_SLIDES_ARTIFACT_KIND, wikiSlidesArtifactKey(slidesRunId));
          if (!artifact) return jsonResponse({ error: "slides artifact not found" }, 404);
          const data = jsonObject(artifact.data);
          const files = normalizeOpenSlideFiles(data.files);
          if (!files.length) return jsonResponse({ error: "slides artifact has no files" }, 404);
          const fileName = compactString(data.fileName, 160) || "wiki-slides.zip";
          const zip = createStoredZip(files);
          return binaryResponse(zip, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${safeDownloadFileName(fileName)}"`,
            "cache-control": "no-store",
          }, req);
        }
        const id = url.searchParams.get("id");
        const owner = url.searchParams.get("owner");
        const repo = url.searchParams.get("repo");
        const branch = url.searchParams.get("branch");
        const sourcePath = url.searchParams.get("sourcePath");
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400);
        const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!record) return jsonResponse({ error: "not found" }, 404);
        const zip = createStoredZip(openSlideDeckFiles(record));
        return binaryResponse(zip, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${openSlideDeckZipName(record)}"`,
          "cache-control": "no-store",
        }, req);
      }

      if (method === "POST" && url.pathname === "/api/wiki/slides/viewer") {
        let body: { slidesRunId?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const slidesRunId = String(body.slidesRunId || "").trim();
        if (!slidesRunId) return jsonResponse({ error: "slidesRunId required" }, 400, req);
        const artifact = await productStore.getArtifact(WIKI_SLIDES_ARTIFACT_KIND, wikiSlidesArtifactKey(slidesRunId));
        if (!artifact) return jsonResponse({ error: "slides artifact not found" }, 404, req);
        const data = jsonObject(artifact.data);
        const files = normalizeOpenSlideFiles(data.files);
        if (!files.length) return jsonResponse({ error: "slides artifact has no files" }, 404, req);
        try {
          const viewer = await buildOpenSlideViewer({ root: store.root, slidesRunId, files });
          await productStore.upsertArtifact({
            kind: WIKI_SLIDES_VIEWER_ARTIFACT_KIND,
            key: openSlideViewerArtifactKey(slidesRunId, viewer.sourceHash),
            runId: slidesRunId,
            data: {
              slidesRunId,
              sourceHash: viewer.sourceHash,
              viewerId: viewer.viewerId,
              viewerUrl: viewer.viewerUrl,
              cached: viewer.cached,
              builtAt: new Date().toISOString(),
            },
          });
          return jsonResponse({
            slidesRunId,
            viewerId: viewer.viewerId,
            viewerUrl: viewer.viewerUrl,
            cached: viewer.cached,
            downloadUrl: `/api/wiki/slides.zip?slidesRunId=${encodeURIComponent(slidesRunId)}`,
            fileName: compactString(data.fileName, 160) || "wiki-slides.zip",
          }, 200, req);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/wiki/slides") {
        let body: {
          id?: string | null;
          owner?: string;
          repo?: string;
          branch?: string | null;
          sourcePath?: string | null;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          providerSecrets?: unknown;
          slideCount?: number | string;
          instructions?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const id = body.id?.trim() || null;
        const owner = body.owner?.trim() || "";
        const repo = body.repo?.trim() || "";
        const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
        const sourcePath = normalizeRepoSourcePath(body.sourcePath);
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400, req);
        const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!record) return jsonResponse({ error: "wiki not found" }, 404, req);
        const runtime = normalizeAgentRuntime(body.runtime, "local-cli");
        if (runtime !== "local-cli") {
          return jsonResponse({ error: "Slides generation currently requires a local CLI agent runtime." }, 400, req);
        }
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(runtime, localCli, req, "slides generation", opts);
        if (localCliPreflight) return localCliPreflight;
        const channelId = body.channel ?? body.model ?? record.pageModel ?? record.model ?? DEFAULT_CHANNEL_ID;
        let channel: ProviderModel;
        try {
          channel = resolveChannel(channelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
        const run = await productStore.createRun({
          kind: "wiki_slides",
          title: `Generate slides · ${record.structure?.title || `${record.owner}/${record.repo}`}`,
          input: {
            id: record.id ?? id,
            owner: record.owner,
            repo: record.repo,
            branch: record.branch ?? null,
            sourcePath: record.sourcePath ?? null,
            channel: channel.id,
            runtime,
            localCli,
            slideCount: body.slideCount ?? null,
            instructions: body.instructions ?? "",
          },
        });

        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send, _close, signal) => {
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            id: record.id ?? null,
            owner: record.owner,
            repo: record.repo,
            branch: record.branch ?? null,
            sourcePath: record.sourcePath ?? null,
            channel: channel.id,
            runtime,
            localCli,
          });
          try {
            const slides = await generateWikiSlides(record, {
              channel,
              localCli,
              signal,
              slideCount: normalizeSlideCount(body.slideCount),
              instructions: body.instructions,
              onEvent: (event) => {
                if (event.type === "phase") {
                  sendPersisted(productStore, run.id, send, "phase", {
                    phase: event.phase,
                    message: event.message,
                  });
                } else {
                  sendPersisted(productStore, run.id, send, "slides-agent", {
                    event: event.event,
                  });
                }
              },
            });
            await productStore.upsertArtifact({
              kind: WIKI_SLIDES_ARTIFACT_KIND,
              key: wikiSlidesArtifactKey(run.id),
              runId: run.id,
              data: {
                wikiId: record.id ?? null,
                owner: record.owner,
                repo: record.repo,
                branch: record.branch ?? null,
                deckId: slides.deckId,
                deckSourcePath: slides.deckSourcePath,
                fileName: slides.fileName,
                usedAgent: slides.usedAgent,
                files: slides.files,
              },
            });
            sendPersisted(productStore, run.id, send, "phase", {
              phase: "viewer",
              message: "Building Open Slide viewer.",
            });
            const viewerResult = await ensureWikiSlidesViewer(productStore, store.root, record, run.id, signal);
            const result = {
              runId: run.id,
              deckId: slides.deckId,
              deckSourcePath: slides.deckSourcePath,
              fileName: slides.fileName,
              usedAgent: slides.usedAgent,
              downloadUrl: viewerResult.downloadUrl,
              viewerUrl: viewerResult.viewerUrl,
              viewerId: viewerResult.viewerId,
            };
            await productStore.updateRun(run.id, { status: "done", result });
            sendPersisted(productStore, run.id, send, "done", result);
          } catch (e) {
            const message = signal.aborted ? USER_STOP_MESSAGE : e instanceof Error ? e.message : String(e);
            sendPersisted(productStore, run.id, send, signal.aborted ? "canceled" : "error", { message });
            await productStore.updateRun(run.id, {
              status: signal.aborted ? "canceled" : "error",
              error: message,
            });
          } finally {
            await waitForPersistedEvents(run.id);
          }
        }, req);
      }

      if (method === "GET" && url.pathname === "/api/wiki/publication") {
        const id = url.searchParams.get("id")?.trim() || "";
        const owner = url.searchParams.get("owner")?.trim() || "";
        const repo = url.searchParams.get("repo")?.trim() || "";
        const branch = url.searchParams.get("branch")?.trim() || null;
        const sourcePath = normalizeRepoSourcePath(url.searchParams.get("sourcePath"));
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400, req);
        const key = wikiPublicationArtifactKey({ id, owner, repo, branch, sourcePath });
        let artifact = await productStore.getArtifact(
          WIKI_PUBLICATION_ARTIFACT_KIND,
          key,
        );
        let record = artifact?.data && jsonObject(artifact.data).published === true
          ? await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath }).catch(() => null)
          : null;
        if (!artifact && !id) {
          record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath }).catch(() => null);
          if (record?.id) {
            artifact = await productStore.getArtifact(WIKI_PUBLICATION_ARTIFACT_KIND, wikiRecordArtifactKey(record));
          }
        }
        const data = artifact ? jsonObject(artifact.data) : null;
        record = record || (data?.published === true
          ? await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath }).catch(() => null)
          : null);
        return jsonResponse({
          publication: publicationStateFromData(publicationDataWithFreshness(data, record), req),
        }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/wiki/publication") {
        let body: {
          id?: string | null;
          owner?: string;
          repo?: string;
          branch?: string | null;
          sourcePath?: string | null;
          published?: boolean;
          visibility?: string | null;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }

        const id = body.id == null ? "" : String(body.id).trim();
        const owner = body.owner?.trim() || "";
        const repo = body.repo?.trim() || "";
        const branch = body.branch == null ? null : String(body.branch).trim() || null;
        const sourcePath = normalizeRepoSourcePath(body.sourcePath);
        const visibility = normalizePublicWikiVisibility(body.visibility);
        if (!id && (!owner || !repo)) return jsonResponse({ error: "id or owner and repo required" }, 400, req);

        const key = wikiPublicationArtifactKey({ id, owner, repo, branch, sourcePath });
        const existingArtifact = await productStore.getArtifact(WIKI_PUBLICATION_ARTIFACT_KIND, key);
        const existingData = existingArtifact ? jsonObject(existingArtifact.data) : {};
        const existingPublicId = typeof existingData.publicId === "string" ? normalizePublicWikiId(existingData.publicId) : "";

        if (desktopEnabled(opts)) {
          if (body.published === false) {
            const remote = await unpublishWikiRecordFromPublicSite(existingData);
            const unpublishedAt = new Date().toISOString();
            const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath }).catch(() => null);
            const publication = {
              ...existingData,
              ...remote.publication,
              published: false,
              readOnly: true,
              id: (record?.id ?? id) || null,
              owner: record?.owner || owner,
              repo: record?.repo || repo,
              branch: record?.branch ?? branch,
              sourcePath: record?.sourcePath ?? sourcePath,
              unpublishedAt: typeof remote.publication.unpublishedAt === "string" ? remote.publication.unpublishedAt : unpublishedAt,
              updatedAt: typeof remote.publication.updatedAt === "string" ? remote.publication.updatedAt : unpublishedAt,
            };
            await productStore.upsertArtifact({
              kind: WIKI_PUBLICATION_ARTIFACT_KIND,
              key,
              data: publication,
            });
            return jsonResponse({ ok: true, publication: publicationStateFromData(publication, req) }, 200, req);
          }

          const loadedRecord = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
          if (!loadedRecord) return jsonResponse({ error: "wiki not found" }, 404, req);
          const existingVisibility = normalizePublicWikiVisibility(existingData.visibility);
          const canReuseExistingLink = Boolean(
            existingPublicId &&
            existingVisibility === visibility &&
            (visibility === "public" || existingPublicId.startsWith("private-")),
          );
          if (existingPublicId && existingData.published === true && !canReuseExistingLink) {
            await unpublishWikiRecordFromPublicSite(existingData);
          }
          const publishData = canReuseExistingLink ? existingData : {};
          const remote = await publishWikiRecordToPublicSite(loadedRecord, publishData, visibility);
          const remotePublication = remote.publication;
          const publication = {
            ...publishData,
            ...remotePublication,
            published: true,
            visibility,
            readOnly: true,
            id: loadedRecord.id ?? null,
            owner: loadedRecord.owner,
            repo: loadedRecord.repo,
            branch: loadedRecord.branch ?? null,
            sourcePath: loadedRecord.sourcePath ?? null,
            title: loadedRecord.structure.title,
            publicId: typeof remotePublication.publicId === "string" ? remotePublication.publicId : canReuseExistingLink ? existingPublicId : null,
            publicUrl: typeof remotePublication.publicUrl === "string" ? remotePublication.publicUrl : null,
            managementToken: remote.managementToken || publishData.managementToken,
            recordVersion: wikiPublicationRecordVersion(loadedRecord),
            updatedAt: typeof remotePublication.updatedAt === "string" ? remotePublication.updatedAt : new Date().toISOString(),
            publishedAt: typeof remotePublication.publishedAt === "string" ? remotePublication.publishedAt : publishData.publishedAt || new Date().toISOString(),
          };
          await productStore.upsertArtifact({
            kind: WIKI_PUBLICATION_ARTIFACT_KIND,
            key: wikiRecordArtifactKey(loadedRecord),
            data: publication,
          });
          return jsonResponse({ ok: true, publication: publicationStateFromData(publication, req) }, 200, req);
        }

        if (body.published === false) {
          const unpublishedAt = new Date().toISOString();
          const record = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
          const resolvedOwner = record?.owner || owner;
          const resolvedRepo = record?.repo || repo;
          const resolvedBranch = record?.branch ?? branch;
          const resolvedSourcePath = record?.sourcePath ?? sourcePath;
          if (existingPublicId) {
            await baseProductStore.upsertArtifact({
              kind: PUBLIC_WIKI_ARTIFACT_KIND,
              key: existingPublicId,
              data: {
                publicId: existingPublicId,
                published: false,
                visibility: normalizePublicWikiVisibility(existingData.visibility),
                readOnly: true,
                id: (record?.id ?? id) || null,
                owner: resolvedOwner,
                repo: resolvedRepo,
                branch: resolvedBranch,
                sourcePath: resolvedSourcePath,
                title: typeof existingData.title === "string" ? existingData.title : null,
                unpublishedAt,
                updatedAt: unpublishedAt,
              },
            });
          }
          await productStore.upsertArtifact({
            kind: WIKI_PUBLICATION_ARTIFACT_KIND,
            key,
            data: {
              ...existingData,
              publicId: existingPublicId || null,
              published: false,
              visibility: normalizePublicWikiVisibility(existingData.visibility),
              readOnly: true,
              id: (record?.id ?? id) || null,
              owner: resolvedOwner,
              repo: resolvedRepo,
              branch: resolvedBranch,
              sourcePath: resolvedSourcePath,
              unpublishedAt,
              updatedAt: unpublishedAt,
            },
          });
          return jsonResponse({
            ok: true,
            publication: publicationStateFromData({ ...existingData, publicId: existingPublicId, published: false, unpublishedAt, updatedAt: unpublishedAt }, req),
          }, 200, req);
        }

        const loadedRecord = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!loadedRecord) return jsonResponse({ error: "wiki not found" }, 404, req);

        const existingVisibility = normalizePublicWikiVisibility(existingData.visibility);
        const canReuseExistingLink = Boolean(
          existingPublicId &&
          existingVisibility === visibility &&
          (visibility === "public" || existingPublicId.startsWith("private-")),
        );
        if (existingPublicId && existingData.published === true && !canReuseExistingLink) {
          await baseProductStore.upsertArtifact({
            kind: PUBLIC_WIKI_ARTIFACT_KIND,
            key: existingPublicId,
            data: {
              ...existingData,
              publicId: existingPublicId,
              published: false,
              visibility: existingVisibility,
              updatedAt: new Date().toISOString(),
            },
          });
        }
        const publicId = canReuseExistingLink
          ? existingPublicId
          : visibility === "private"
            ? makePrivateWikiId()
            : makePublicWikiId(loadedRecord.owner, loadedRecord.repo);
        const now = new Date().toISOString();
        const publishedAt = canReuseExistingLink && typeof existingData.publishedAt === "string" ? existingData.publishedAt : now;
        await baseProductStore.upsertArtifact({
          kind: PUBLIC_WIKI_ARTIFACT_KIND,
          key: publicId,
          data: publicWikiArtifactData({ publicId, record: loadedRecord, visibility, publishedAt, updatedAt: now }),
        });
        const publication = {
          publicId,
          published: true,
          visibility,
          readOnly: true,
          id: loadedRecord.id ?? null,
          owner: loadedRecord.owner,
          repo: loadedRecord.repo,
          branch: loadedRecord.branch ?? null,
          sourcePath: loadedRecord.sourcePath ?? null,
          title: loadedRecord.structure.title,
          publishedAt,
          updatedAt: now,
        };
        await productStore.upsertArtifact({
          kind: WIKI_PUBLICATION_ARTIFACT_KIND,
          key: wikiRecordArtifactKey(loadedRecord),
          data: publication,
        });
        return jsonResponse({
          ok: true,
          publication: publicationStateFromData(publication, req),
        }, 200, req);
      }

      if (method === "GET" && url.pathname === "/api/ask/publication") {
        const askId = url.searchParams.get("id")?.trim() || "";
        if (!askId) return jsonResponse({ error: "id required" }, 400, req);
        const artifact = await productStore.getArtifact(ASK_PUBLICATION_ARTIFACT_KIND, askPublicationArtifactKey(askId));
        const data = artifact ? jsonObject(artifact.data) : null;
        return jsonResponse({ publication: askPublicationStateFromData(data) }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/ask/publication") {
        // Ask sessions live in the desktop's local SQLite (Tauri), not in this
        // server's stores, so unlike /api/wiki/publication the desktop sends the
        // full ask payload in the body. This server sanitizes it (privacy: local
        // paths reduced, logs never included), pushes it to the public site, and
        // keeps the publicId + managementToken artifact so the link stays stable
        // across re-shares.
        if (!desktopEnabled(opts)) return jsonResponse({ error: "ask sharing is desktop only" }, 400, req);
        let body: {
          id?: string | null;
          ask?: Record<string, unknown> | null;
          published?: boolean;
          visibility?: string | null;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }

        const askId = body.id == null ? "" : String(body.id).trim();
        if (!askId) return jsonResponse({ error: "id required" }, 400, req);
        const visibility = normalizePublicAskVisibility(body.visibility);
        const key = askPublicationArtifactKey(askId);
        const existingArtifact = await productStore.getArtifact(ASK_PUBLICATION_ARTIFACT_KIND, key);
        const existingData = existingArtifact ? jsonObject(existingArtifact.data) : {};
        const existingPublicId = typeof existingData.publicId === "string" ? normalizePublicAskId(existingData.publicId) : "";

        try {
          if (body.published === false) {
            const remote = await unpublishAskRecordFromPublicSite(existingData);
            const unpublishedAt = new Date().toISOString();
            const publication = {
              ...existingData,
              ...remote.publication,
              published: false,
              readOnly: true,
              askId,
              unpublishedAt: typeof remote.publication.unpublishedAt === "string" ? remote.publication.unpublishedAt : unpublishedAt,
              updatedAt: typeof remote.publication.updatedAt === "string" ? remote.publication.updatedAt : unpublishedAt,
            };
            await productStore.upsertArtifact({
              kind: ASK_PUBLICATION_ARTIFACT_KIND,
              key,
              data: publication,
            });
            return jsonResponse({ ok: true, publication: askPublicationStateFromData(publication) }, 200, req);
          }

          const record = publicAskRecordFromDesktopAsk(body.ask);
          const existingVisibility = normalizePublicAskVisibility(existingData.visibility);
          const canReuseExistingLink = Boolean(
            existingPublicId &&
            existingVisibility === visibility &&
            (visibility === "public" || existingPublicId.startsWith("private-")),
          );
          if (existingPublicId && existingData.published === true && !canReuseExistingLink) {
            await unpublishAskRecordFromPublicSite(existingData);
          }
          const publishData = canReuseExistingLink ? existingData : {};
          const remote = await publishAskRecordToPublicSite(record, publishData, visibility);
          const remotePublication = remote.publication;
          const publication = {
            ...publishData,
            ...remotePublication,
            published: true,
            visibility,
            readOnly: true,
            askId,
            title: record.title,
            publicId: typeof remotePublication.publicId === "string" ? remotePublication.publicId : canReuseExistingLink ? existingPublicId : null,
            publicUrl: typeof remotePublication.publicUrl === "string" ? remotePublication.publicUrl : null,
            managementToken: remote.managementToken || publishData.managementToken,
            recordVersion: askPublicationRecordVersion(record),
            updatedAt: typeof remotePublication.updatedAt === "string" ? remotePublication.updatedAt : new Date().toISOString(),
            publishedAt: typeof remotePublication.publishedAt === "string" ? remotePublication.publishedAt : publishData.publishedAt || new Date().toISOString(),
          };
          await productStore.upsertArtifact({
            kind: ASK_PUBLICATION_ARTIFACT_KIND,
            key,
            data: publication,
          });
          return jsonResponse({ ok: true, publication: askPublicationStateFromData(publication) }, 200, req);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/kb/publication") {
        // KB publish (Phase 3). NOT a reuse of /api/wiki/publication: that handler
        // calls loadWikiRecord internally and would 404 an unwritten KB. Here we:
        //   1. load the KB artifact
        //   2. kbRecordFromArtifact -> a fully-formed WikiRecord with a STABLE id
        //   3. write the WikiRecord to the local `wiki` artifact FIRST (the feedback
        //      path reads the LOCAL store, not Upstash)
        //   4. publish to the public site, then persist publicId + wikiRecordId back
        //      into the KB artifact so the link stays stable across re-publishes.
        let body: { repoKey?: string; visibility?: string | null };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400, req);
        }
        const repoKey = String(body.repoKey || "").trim();
        if (!repoKey) return jsonResponse({ error: "repoKey required" }, 400, req);
        const visibility = normalizePublicWikiVisibility(body.visibility);

        const kb = await loadKnowledgeBase(productStore, repoKey);
        if (!kb) return jsonResponse({ error: "knowledge base not found" }, 404, req);

        // Step 2: build the WikiRecord with a stable id (reuse the stored one if any).
        const record = ensureWikiRecordIdentity(kbRecordFromArtifact(kb));

        // Step 3: write the local `wiki` artifact FIRST (required for the feedback path).
        await productStore.upsertArtifact({
          kind: "wiki",
          key: wikiRecordArtifactKey(record),
          data: record as unknown as Record<string, unknown>,
        });

        // The wiki_publication artifact (keyed by the wiki record) carries the
        // publicId + managementToken that keep the link stable across re-publishes.
        const pubKey = wikiRecordArtifactKey(record);
        const existingPubArtifact = await productStore.getArtifact(WIKI_PUBLICATION_ARTIFACT_KIND, pubKey);
        const existingPubData = existingPubArtifact ? jsonObject(existingPubArtifact.data) : {};
        const existingPublicId = typeof existingPubData.publicId === "string" ? normalizePublicWikiId(existingPubData.publicId) : "";
        const existingVisibility = normalizePublicWikiVisibility(existingPubData.visibility);
        const canReuseExistingLink = Boolean(
          existingPublicId &&
          existingVisibility === visibility &&
          (visibility === "public" || existingPublicId.startsWith("private-")),
        );

        let publication: Record<string, unknown>;
        if (desktopEnabled(opts)) {
          // Step 4 (desktop): publish through the public site over HTTP.
          if (existingPublicId && existingPubData.published === true && !canReuseExistingLink) {
            await unpublishWikiRecordFromPublicSite(existingPubData).catch(() => {});
          }
          const publishData = canReuseExistingLink ? existingPubData : {};
          const remote = await publishWikiRecordToPublicSite(record, publishData, visibility);
          const remotePublication = remote.publication;
          publication = {
            ...publishData,
            ...remotePublication,
            published: true,
            visibility,
            readOnly: true,
            id: record.id ?? null,
            owner: record.owner,
            repo: record.repo,
            branch: record.branch ?? null,
            sourcePath: record.sourcePath ?? null,
            title: record.structure.title,
            publicId: typeof remotePublication.publicId === "string" ? remotePublication.publicId : canReuseExistingLink ? existingPublicId : null,
            publicUrl: typeof remotePublication.publicUrl === "string" ? remotePublication.publicUrl : null,
            managementToken: remote.managementToken || publishData.managementToken,
            recordVersion: wikiPublicationRecordVersion(record),
            updatedAt: typeof remotePublication.updatedAt === "string" ? remotePublication.updatedAt : new Date().toISOString(),
            publishedAt: typeof remotePublication.publishedAt === "string" ? remotePublication.publishedAt : (typeof publishData.publishedAt === "string" ? publishData.publishedAt : new Date().toISOString()),
          };
        } else {
          // Step 4 (multi-tenant / cloud): write the public snapshot directly.
          if (existingPublicId && existingPubData.published === true && !canReuseExistingLink) {
            await baseProductStore.upsertArtifact({
              kind: PUBLIC_WIKI_ARTIFACT_KIND,
              key: existingPublicId,
              data: { ...existingPubData, publicId: existingPublicId, published: false, visibility: existingVisibility, updatedAt: new Date().toISOString() },
            });
          }
          const publicId = canReuseExistingLink
            ? existingPublicId
            : visibility === "private"
              ? makePrivateWikiId()
              : makePublicWikiId(record.owner, record.repo);
          const now = new Date().toISOString();
          const publishedAt = canReuseExistingLink && typeof existingPubData.publishedAt === "string" ? existingPubData.publishedAt : now;
          await baseProductStore.upsertArtifact({
            kind: PUBLIC_WIKI_ARTIFACT_KIND,
            key: publicId,
            data: publicWikiArtifactData({ publicId, record, visibility, publishedAt, updatedAt: now }),
          });
          publication = {
            ...existingPubData,
            publicId,
            published: true,
            visibility,
            readOnly: true,
            id: record.id ?? null,
            owner: record.owner,
            repo: record.repo,
            branch: record.branch ?? null,
            sourcePath: record.sourcePath ?? null,
            title: record.structure.title,
            recordVersion: wikiPublicationRecordVersion(record),
            publishedAt,
            updatedAt: now,
          };
        }

        // Persist the publication artifact so the link is stable across re-publishes.
        await productStore.upsertArtifact({
          kind: WIKI_PUBLICATION_ARTIFACT_KIND,
          key: pubKey,
          data: publication,
        });

        // Persist publicId + the stable wikiRecordId back into the KB artifact. The
        // feedback path (Phase 4) reads wikiRecordId; re-publishes reuse the publicId.
        // Re-load to write on top of the freshest snapshot (a concurrent distill may
        // have appended cards between our load and now) and preserve every card
        // verbatim, so the corroborated-card invariant holds without the resolver opt.
        const resolvedPublicId = typeof publication.publicId === "string" ? publication.publicId : kb.publicId;
        const freshKb = (await loadKnowledgeBase(productStore, repoKey)) ?? kb;
        await saveKnowledgeBase(productStore, {
          ...freshKb,
          wikiRecordId: record.id ?? freshKb.wikiRecordId,
          ...(resolvedPublicId ? { publicId: resolvedPublicId } : {}),
        });

        return jsonResponse({
          ok: true,
          wikiRecordId: record.id ?? null,
          publication: publicationStateFromData(publication, req),
        }, 200, req);
      }

      if (method === "POST" && url.pathname === "/api/wiki/page") {
        let body: {
          id?: string | null;
          owner?: string;
          repo?: string;
          branch?: string | null;
          sourcePath?: string | null;
          pageId?: string;
          mode?: "edit" | "regenerate";
          content?: string;
          instruction?: string;
          stylePrompt?: string;
          stylePromptOverride?: boolean;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const id = body.id == null ? "" : String(body.id).trim();
        const owner = body.owner?.trim();
        const repo = body.repo?.trim();
        const branch = body.branch == null ? null : String(body.branch).trim() || null;
        const sourcePath = normalizeRepoSourcePath(body.sourcePath);
        const pageId = body.pageId?.trim();
        const mode = body.mode === "edit" ? "edit" : "regenerate";
        if ((!id && (!owner || !repo)) || !pageId) return jsonResponse({ error: "id or owner/repo, and pageId required" }, 400);
        const hasPageStylePromptOverride =
          body.stylePromptOverride === true || Object.prototype.hasOwnProperty.call(body, "stylePrompt");
        const pageStylePrompt = hasPageStylePromptOverride
          ? normalizeWikiStylePrompt(body.stylePrompt)
          : undefined;

        const loadedRecordMaybe = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!loadedRecordMaybe) return jsonResponse({ error: "wiki not found" }, 404);
        let loadedRecord: WikiRecord = loadedRecordMaybe;
        const pageMeta = loadedRecord.structure.pages.find((p) => p.id === pageId);
        if (!pageMeta) return jsonResponse({ error: "page not found" }, 404);

        const persistWikiRecord = async (runId: string | null = null): Promise<void> => {
          loadedRecord.generatedAt = new Date().toISOString();
          loadedRecord.updatedAt = loadedRecord.generatedAt;
          loadedRecord = ensureWikiRecordIdentity(loadedRecord);
          store.save(loadedRecord);
          await productStore.upsertArtifact({
            kind: "wiki",
            key: wikiRecordArtifactKey(loadedRecord),
            runId,
            data: loadedRecord as unknown as Record<string, unknown>,
          });
          await syncPublishedWikiRecord(productStore, baseProductStore, loadedRecord, runId);
        };

        if (mode === "edit") {
          if (typeof body.content !== "string") {
            return jsonResponse({ error: "content required for edit mode" }, 400);
          }
          loadedRecord.pages[pageId] = {
            ...(loadedRecord.pages[pageId] ?? { id: pageId }),
            id: pageId,
            content: body.content,
            generatedAt: new Date().toISOString(),
          };
          await persistWikiRecord();
          return jsonResponse({ ok: true, wiki: loadedRecord, page: loadedRecord.pages[pageId] });
        }

        const channelId = body.channel ?? body.model ?? loadedRecord.model ?? DEFAULT_CHANNEL_ID;
        let wikiRuntime: AgentRuntime;
        try {
          wikiRuntime = normalizeWikiGenerationRuntime(body.runtime);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(wikiRuntime, localCli, req, "page repair", opts);
        if (localCliPreflight) return localCliPreflight;
        let channel;
        try {
          channel = resolveChannel(channelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const st = providerStatusForRuntime(wikiRuntime, providerSecrets);
        if (!st[channel.provider].configured) return providerSetupResponse(channel, st[channel.provider], req);
        const wikiExternalWorker = runModeFor(productStore, baseJobQueue, baseSecretGrantStore) === "worker";
        let releaseUserSlot: (() => void) | null = null;
        if (!wikiExternalWorker) {
          if (activeGenerate >= MAX_GENERATE) {
            return busyResponse({ kind: "generation", scope: "global", active: activeGenerate, max: MAX_GENERATE, retryAfter: 60, req });
          }
          releaseUserSlot = tryAcquireUserSlot(activeGenerateByUser, authIdentity.userId, MAX_GENERATE_PER_USER);
          if (!releaseUserSlot) {
            return busyResponse({
              kind: "generation",
              scope: "user",
              active: activeGenerateByUser.get(authIdentity.userId) ?? MAX_GENERATE_PER_USER,
              max: MAX_GENERATE_PER_USER,
              retryAfter: 60,
              req,
            });
          }
        }

        const run = await productStore.createRun({
          kind: "wiki_generate",
          title: `Regenerate page · ${loadedRecord.owner}/${loadedRecord.repo} · ${pageMeta.title}`,
          input: {
            id: loadedRecord.id ?? null,
                owner: loadedRecord.owner,
                repo: loadedRecord.repo,
                branch: loadedRecord.branch ?? null,
                sourcePath: loadedRecord.sourcePath ?? null,
                pageId,
            pageTitle: pageMeta.title,
            channel: channel.id,
            runtime: wikiRuntime,
            localCli,
            instruction: typeof body.instruction === "string" ? body.instruction : "",
            ...(hasPageStylePromptOverride ? { stylePrompt: pageStylePrompt ?? "", stylePromptOverride: true } : {}),
          },
        });

        if (!wikiExternalWorker) activeGenerate++;
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send, _close, signal) => {
          const runController = new AbortController();
          const startedAt = new Date().toISOString();
          activeRunControllers.set(run.id, { controller: runController, kind: "wiki_generate", startedAt });
          const abortOnClientClose = (): void => runController.abort(USER_STOP_MESSAGE);
          if (signal.aborted) abortOnClientClose();
          else signal.addEventListener("abort", abortOnClientClose, { once: true });
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            owner: loadedRecord.owner,
            repo: loadedRecord.repo,
            pageId,
            title: pageMeta.title,
            channel: channel.id,
            runtime: wikiRuntime,
            localCli,
          });
          try {
            const page = await regenerateWikiPage(loadedRecord, pageId, {
              channel: channel.id,
              runtime: wikiRuntime,
              localCli,
              instruction: typeof body.instruction === "string" ? body.instruction : undefined,
              ...(hasPageStylePromptOverride ? { stylePrompt: pageStylePrompt ?? "", stylePromptOverride: true } : {}),
              signal: runController.signal,
              store,
              providerSecrets,
              onEvent: (ev) => sendPersisted(productStore, run.id, send, "page-agent", { pageId, event: ev }),
            });
            const latestRecord = await loadWikiRecord(productStore, store, {
              id,
              owner: loadedRecord.owner,
              repo: loadedRecord.repo,
              branch: loadedRecord.branch ?? null,
              sourcePath: loadedRecord.sourcePath ?? null,
            });
            if (latestRecord) loadedRecord = latestRecord;
            loadedRecord.pages[pageId] = page;
            await persistWikiRecord(run.id);
            await productStore.updateRun(run.id, {
              status: "done",
              result: { wiki: loadedRecord, page, pageId, processSnapshot: processSnapshotFor(run.id) },
            });
            sendPersisted(productStore, run.id, send, "page-done", { pageId, page });
            sendPersisted(productStore, run.id, send, "done", { wiki: loadedRecord, pageId });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (runController.signal.aborted) {
              sendPersisted(productStore, run.id, send, "canceled", { message: USER_STOP_MESSAGE, pageId });
              await productStore.updateRun(run.id, {
                status: "canceled",
                error: USER_STOP_MESSAGE,
                result: { pageId, processSnapshot: processSnapshotFor(run.id) },
              });
              return;
            }
            sendPersisted(productStore, run.id, send, "error", { message, pageId });
            await productStore.updateRun(run.id, {
              status: "error",
              error: message,
              result: { pageId, processSnapshot: processSnapshotFor(run.id) },
            });
          } finally {
            signal.removeEventListener("abort", abortOnClientClose);
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            activeRunControllers.delete(run.id);
            releaseUserSlot?.();
            if (!wikiExternalWorker) activeGenerate = Math.max(0, activeGenerate - 1);
          }
        }, req, {
          providerSecrets,
          payload: wikiExternalWorker
            ? {
              worker: true,
              action: "wiki.page.regenerate",
              id: loadedRecord.id ?? null,
              owner: loadedRecord.owner,
              repo: loadedRecord.repo,
              branch: loadedRecord.branch ?? null,
              sourcePath: loadedRecord.sourcePath ?? null,
              pageId,
              pageTitle: pageMeta.title,
              channel: channel.id,
              runtime: wikiRuntime,
              localCli,
              instruction: typeof body.instruction === "string" ? body.instruction : "",
              ...(hasPageStylePromptOverride ? { stylePrompt: pageStylePrompt ?? "", stylePromptOverride: true } : {}),
            }
            : undefined,
        });
      }

      if (method === "POST" && url.pathname === "/api/wiki/pages") {
        let body: {
          id?: string | null;
          owner?: string;
          repo?: string;
          branch?: string | null;
          sourcePath?: string | null;
          pageIds?: unknown;
          instruction?: string;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const id = body.id == null ? "" : String(body.id).trim();
        const owner = body.owner?.trim();
        const repo = body.repo?.trim();
        const branch = body.branch == null ? null : String(body.branch).trim() || null;
        const sourcePath = normalizeRepoSourcePath(body.sourcePath);
        const pageIds = normalizeWikiBatchPageIds(body.pageIds);
        if ((!id && (!owner || !repo)) || !pageIds.length) {
          return jsonResponse({ error: "id or owner/repo, and pageIds required" }, 400);
        }

        const loadedRecordMaybe = await loadWikiRecord(productStore, store, { id, owner, repo, branch, sourcePath });
        if (!loadedRecordMaybe) return jsonResponse({ error: "wiki not found" }, 404);
        let loadedRecord: WikiRecord = loadedRecordMaybe;
        const { metas: pageMetas, missing } = wikiPageMetasForIds(loadedRecord, pageIds);
        if (missing.length) {
          return jsonResponse({ error: `page not found: ${missing.slice(0, 5).join(", ")}` }, 404);
        }

        const persistWikiRecord = async (runId: string | null = null): Promise<void> => {
          loadedRecord.generatedAt = new Date().toISOString();
          loadedRecord.updatedAt = loadedRecord.generatedAt;
          loadedRecord = ensureWikiRecordIdentity(loadedRecord);
          store.save(loadedRecord);
          await productStore.upsertArtifact({
            kind: "wiki",
            key: wikiRecordArtifactKey(loadedRecord),
            runId,
            data: loadedRecord as unknown as Record<string, unknown>,
          });
          await syncPublishedWikiRecord(productStore, baseProductStore, loadedRecord, runId);
        };

        const channelId = body.channel ?? body.model ?? loadedRecord.model ?? DEFAULT_CHANNEL_ID;
        let wikiRuntime: AgentRuntime;
        try {
          wikiRuntime = normalizeWikiGenerationRuntime(body.runtime);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(wikiRuntime, localCli, req, "batch page repair", opts);
        if (localCliPreflight) return localCliPreflight;
        let channel;
        try {
          channel = resolveChannel(channelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const st = providerStatusForRuntime(wikiRuntime, providerSecrets);
        if (!st[channel.provider].configured) return providerSetupResponse(channel, st[channel.provider], req);

        const wikiExternalWorker = runModeFor(productStore, baseJobQueue, baseSecretGrantStore) === "worker";
        let releaseUserSlot: (() => void) | null = null;
        if (!wikiExternalWorker) {
          if (activeGenerate >= MAX_GENERATE) {
            return busyResponse({ kind: "generation", scope: "global", active: activeGenerate, max: MAX_GENERATE, retryAfter: 60, req });
          }
          releaseUserSlot = tryAcquireUserSlot(activeGenerateByUser, authIdentity.userId, MAX_GENERATE_PER_USER);
          if (!releaseUserSlot) {
            return busyResponse({
              kind: "generation",
              scope: "user",
              active: activeGenerateByUser.get(authIdentity.userId) ?? MAX_GENERATE_PER_USER,
              max: MAX_GENERATE_PER_USER,
              retryAfter: 60,
              req,
            });
          }
        }

        const instruction = typeof body.instruction === "string" ? body.instruction : "";
        const run = await productStore.createRun({
          kind: "wiki_generate",
          title: `Regenerate ${pageMetas.length} pages · ${loadedRecord.owner}/${loadedRecord.repo}`,
          input: {
            id: loadedRecord.id ?? null,
                owner: loadedRecord.owner,
                repo: loadedRecord.repo,
                branch: loadedRecord.branch ?? null,
                sourcePath: loadedRecord.sourcePath ?? null,
                pageIds,
            pageTitles: pageMetas.map((page) => page.title),
            channel: channel.id,
            runtime: wikiRuntime,
            localCli,
            instruction,
          },
        });

        if (!wikiExternalWorker) activeGenerate++;
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send, _close, signal) => {
          const runController = new AbortController();
          const startedAt = new Date().toISOString();
          activeRunControllers.set(run.id, { controller: runController, kind: "wiki_generate", startedAt });
          const abortOnClientClose = (): void => runController.abort(USER_STOP_MESSAGE);
          if (signal.aborted) abortOnClientClose();
          else signal.addEventListener("abort", abortOnClientClose, { once: true });
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
              owner: loadedRecord.owner,
              repo: loadedRecord.repo,
              branch: loadedRecord.branch ?? null,
              sourcePath: loadedRecord.sourcePath ?? null,
              pageIds,
            pageCount: pageMetas.length,
            pages: pageMetas.map((page) => ({ pageId: page.id, title: page.title })),
            channel: channel.id,
            runtime: wikiRuntime,
            localCli,
          });
          sendPersisted(productStore, run.id, send, "phase", {
            phase: "pages",
            message: `Regenerating ${pageMetas.length} page${pageMetas.length === 1 ? "" : "s"}`,
          });

          const completedPageIds: string[] = [];
          const pageErrors: Array<{ pageId: string; title: string; message: string }> = [];

          try {
            for (let index = 0; index < pageMetas.length; index++) {
              if (runController.signal.aborted) throw new Error(USER_STOP_MESSAGE);
              const pageMeta = pageMetas[index]!;
              sendPersisted(productStore, run.id, send, "page-start", {
                pageId: pageMeta.id,
                title: pageMeta.title,
                index: index + 1,
                total: pageMetas.length,
              });
              try {
                const page = await regenerateWikiPage(loadedRecord, pageMeta.id, {
                  channel: channel.id,
                  runtime: wikiRuntime,
                  localCli,
                  instruction: instruction || undefined,
                  signal: runController.signal,
                  store,
                  providerSecrets,
                  onEvent: (ev) => sendPersisted(productStore, run.id, send, "page-agent", { pageId: pageMeta.id, event: ev }),
                });
                const latestRecord = await loadWikiRecord(productStore, store, {
                  id,
                  owner: loadedRecord.owner,
                  repo: loadedRecord.repo,
                  branch: loadedRecord.branch ?? null,
                  sourcePath: loadedRecord.sourcePath ?? null,
                });
                if (latestRecord) loadedRecord = latestRecord;
                loadedRecord.pages[pageMeta.id] = page;
                completedPageIds.push(pageMeta.id);
                await persistWikiRecord(run.id);
                sendPersisted(productStore, run.id, send, "page-done", {
                  pageId: pageMeta.id,
                  page,
                  index: index + 1,
                  total: pageMetas.length,
                });
              } catch (e) {
                if (runController.signal.aborted) throw e;
                const message = e instanceof Error ? e.message : String(e);
                const displayError = friendlyWikiGenerationError(message);
                pageErrors.push({ pageId: pageMeta.id, title: pageMeta.title, message });
                sendPersisted(productStore, run.id, send, "page-error", {
                  pageId: pageMeta.id,
                  title: pageMeta.title,
                  error: message,
                  displayError,
                  index: index + 1,
                  total: pageMetas.length,
                });
              }
            }

            if (!completedPageIds.length) {
              const message = pageErrors[0]?.message || "No selected pages regenerated";
              await productStore.updateRun(run.id, {
                status: "error",
                error: message,
                result: { wiki: loadedRecord, pageIds: completedPageIds, pageErrors, processSnapshot: processSnapshotFor(run.id) },
              });
              sendPersisted(productStore, run.id, send, "error", { message, pageErrors });
              return;
            }

            await productStore.updateRun(run.id, {
              status: "done",
              result: { wiki: loadedRecord, pageIds: completedPageIds, pageErrors, processSnapshot: processSnapshotFor(run.id) },
              error: null,
            });
            sendPersisted(productStore, run.id, send, "done", { wiki: loadedRecord, pageIds: completedPageIds, pageErrors });
          } catch (e) {
            const message = runController.signal.aborted
              ? USER_STOP_MESSAGE
              : e instanceof Error ? e.message : String(e);
            sendPersisted(productStore, run.id, send, runController.signal.aborted ? "canceled" : "error", {
              message,
              pageIds: completedPageIds,
              pageErrors,
            });
            await productStore.updateRun(run.id, {
              status: runController.signal.aborted ? "canceled" : "error",
              error: message,
              result: { wiki: loadedRecord, pageIds: completedPageIds, pageErrors, processSnapshot: processSnapshotFor(run.id) },
            });
          } finally {
            signal.removeEventListener("abort", abortOnClientClose);
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            activeRunControllers.delete(run.id);
            releaseUserSlot?.();
            if (!wikiExternalWorker) activeGenerate = Math.max(0, activeGenerate - 1);
          }
        }, req, {
          providerSecrets,
          payload: wikiExternalWorker
            ? {
              worker: true,
              action: "wiki.pages.regenerate",
              id: loadedRecord.id ?? null,
              owner: loadedRecord.owner,
              repo: loadedRecord.repo,
              branch: loadedRecord.branch ?? null,
              pageIds,
              pageTitles: pageMetas.map((page) => page.title),
              channel: channel.id,
              runtime: wikiRuntime,
              localCli,
              instruction,
            }
            : undefined,
        });
      }

      if (method === "POST" && url.pathname === "/api/wiki/diagram/fix") {
        let body: {
          owner?: string;
          repo?: string;
          pageTitle?: string;
          pageContext?: string;
          diagram?: string;
          error?: string;
          instruction?: string;
          channel?: string;
          model?: string;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);
        const owner = body.owner?.trim() || "";
        const repo = body.repo?.trim() || "";
        const diagram = body.diagram?.trim() || "";
        if (!owner || !repo || !diagram) return jsonResponse({ error: "owner, repo, and diagram required" }, 400);

        const channelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        let channel;
        try {
          channel = resolveChannel(channelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const st = providerStatusForRuntime("agent", providerSecrets);
        if (!st[channel.provider].configured) return providerSetupResponse(channel, st[channel.provider], req);

        try {
          const llm = makeLLM(channel, { surface: "wiki-page", depth: "fast" }, providerSecrets);
          const raw = await llm.generate(buildMermaidRepairPrompt({
            owner,
            repo,
            pageTitle: body.pageTitle || "",
            pageContext: body.pageContext || "",
            diagram,
            error: body.error || "",
            instruction: body.instruction || "",
          }));
          const fixed = extractMermaidOnly(raw);
          if (!fixed) return jsonResponse({ error: "model returned no Mermaid diagram" }, 502);
          return jsonResponse({ ok: true, diagram: fixed });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/wiki/format/tune") {
        let body: {
          prompt?: string;
          channel?: string;
          model?: string;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);
        const draft = normalizeWikiStylePrompt(body.prompt);
        if (!draft) return jsonResponse({ error: "custom format prompt required" }, 400);

        const channelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        let channel;
        try {
          channel = resolveChannel(channelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const st = providerStatusForRuntime("agent", providerSecrets);
        if (!st[channel.provider].configured) return providerSetupResponse(channel, st[channel.provider], req);

        try {
          const llm = makeLLM(channel, { surface: "wiki-page", depth: "fast" }, providerSecrets);
          const raw = await llm.generate(buildWikiFormatTunePrompt(draft));
          const prompt = extractFormatPromptOnly(raw);
          if (!prompt) return jsonResponse({ error: "model returned no usable format prompt" }, 502);
          return jsonResponse({ ok: true, prompt });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/desktop-benchmark/code-graph") {
        if (!desktopBenchmarkEnabled(opts)) {
          return jsonResponse({ error: "Desktop benchmark mode is not enabled." }, 404, req);
        }
        try {
          const body = await req.json() as { url?: string; urls?: string[]; sourceRefs?: RequestedSourceRef[] };
          const parsed = parseWikiRefs(body, localFolderAccessForReadOnlyRequest(req, host, opts));
          const session = await ensureCodeKbSession(parsed.ref, { budgetMs: 120_000 });
          return jsonResponse({ ready: Boolean(session) }, session ? 200 : 503, req);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, req);
        }
      }

      if (method === "POST" && url.pathname === "/api/generate") {
        let body: { url?: string; urls?: string[]; sourceRefs?: RequestedSourceRef[]; channel?: string; model?: string; structureChannel?: string; pageChannel?: string; concurrency?: number; depth?: string; pageCount?: number | string; pageCountMode?: string; style?: string; stylePrompt?: string; languages?: unknown; language?: unknown; wikiLanguages?: unknown; runtime?: string; localCli?: unknown; providerSecrets?: unknown; knowledgeProfile?: unknown; benchmarkFastPages?: boolean; codeGraphEnabled?: boolean };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);
        const codeGraphEnabled = codeGraphEnabledForRequest(body.codeGraphEnabled);
        let ref: RepoRef;
        let refs: WorkspaceRepoRef[] | undefined;
        try {
          const parsed = parseWikiRefs(body, localFolderAccessForReadOnlyRequest(req, host, opts));
          ref = parsed.ref;
          refs = parsed.refs;
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        // Pre-warm (R1): start code-kb provisioning now so it overlaps the
        // validation and preflight below; prefetchWikiCodeKbPrompts adopts the
        // in-flight attempt instead of starting cold.
        if (codeGraphEnabled) prewarmCodeKbSession(ref);
        const repoLabel = refs?.length ? refs.map((workspaceRef) => workspaceRef.label).join(" + ") : `${ref.owner}/${ref.repo}`;
        const channelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        const structureChannelId = body.structureChannel ?? channelId;
        const pageChannelId = body.pageChannel ?? channelId;
        let wikiRuntime: AgentRuntime;
        try {
          wikiRuntime = normalizeWikiGenerationRuntime(body.runtime);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400, req);
        }
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(wikiRuntime, localCli, req, "wiki generation", opts);
        if (localCliPreflight) return localCliPreflight;
        const rawPageCount = body.pageCount;
        if (rawPageCount !== undefined) {
          const numericPageCount = typeof rawPageCount === "number" ? rawPageCount : Number(String(rawPageCount).trim());
          if (!Number.isInteger(numericPageCount) || numericPageCount < 1 || numericPageCount > WIKI_PAGE_COUNT_MAX) {
            return jsonResponse({ error: `pageCount must be an integer from 1 to ${WIKI_PAGE_COUNT_MAX}` }, 400, req);
          }
        }
        const wikiPageCount = normalizeWikiPageCount(rawPageCount, defaultWikiPageCountForDepth(body.depth));
        const wikiPageCountMode = normalizeWikiPageCountMode(body.pageCountMode);
        const wikiDepth = wikiDepthForPageCount(wikiPageCount);
        const wikiStyle = normalizeWikiStyle(body.style);
        const wikiStylePrompt = wikiStyle === "custom" ? normalizeWikiStylePrompt(body.stylePrompt) : "";
        const wikiLanguages = normalizeWikiLanguages(body.languages ?? body.wikiLanguages ?? body.language);
        const knowledgeProfile = normalizeKnowledgeProfile(body.knowledgeProfile);
        if (wikiStyle === "custom" && !wikiStylePrompt) {
          return jsonResponse({ error: "custom format prompt required" }, 400);
        }
        let structureChannel;
        let pageChannel;
        try {
          structureChannel = resolveChannel(structureChannelId);
          pageChannel = resolveChannel(pageChannelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const st = providerStatusForRuntime(wikiRuntime, providerSecrets);
        if (!st[structureChannel.provider].configured) return providerSetupResponse(structureChannel, st[structureChannel.provider], req);
        if (!st[pageChannel.provider].configured) return providerSetupResponse(pageChannel, st[pageChannel.provider], req);

        const wikiExternalWorker = runModeFor(productStore, baseJobQueue, baseSecretGrantStore) === "worker";
        let releaseUserSlot: (() => void) | null = null;
        if (!wikiExternalWorker) {
          if (activeGenerate >= MAX_GENERATE) {
            return busyResponse({ kind: "generation", scope: "global", active: activeGenerate, max: MAX_GENERATE, retryAfter: 60, req });
          }
          releaseUserSlot = tryAcquireUserSlot(activeGenerateByUser, authIdentity.userId, MAX_GENERATE_PER_USER);
          if (!releaseUserSlot) {
            return busyResponse({
              kind: "generation",
              scope: "user",
              active: activeGenerateByUser.get(authIdentity.userId) ?? MAX_GENERATE_PER_USER,
              max: MAX_GENERATE_PER_USER,
              retryAfter: 60,
              req,
            });
          }
        }

        const requestedConcurrency =
          typeof body.concurrency === "number" && Number.isFinite(body.concurrency) && body.concurrency > 0
            ? body.concurrency
            : undefined;

        const run = await productStore.createRun({
          kind: "wiki_generate",
          title: `Generate ${wikiDepth} ${wikiStyle} wiki (${wikiPageCountMode === "auto" ? `auto up to ${wikiPageCount}` : wikiPageCount} pages) · ${repoLabel}`,
          input: {
            ref,
            refs,
            channel: pageChannel.id,
            structureChannel: structureChannel.id,
            pageChannel: pageChannel.id,
            runtime: wikiRuntime,
            localCli,
            concurrency: requestedConcurrency ?? null,
            depth: wikiDepth,
            pageCount: wikiPageCount,
            pageCountMode: wikiPageCountMode,
            style: wikiStyle,
            ...(wikiStylePrompt ? { stylePrompt: wikiStylePrompt } : {}),
            languages: wikiLanguages,
            knowledgeProfile,
            codeGraphEnabled,
          },
        });

        if (!wikiExternalWorker) activeGenerate++;
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send, _close, signal) => {
          const runController = new AbortController();
          const startedAt = new Date().toISOString();
          activeRunControllers.set(run.id, { controller: runController, kind: "wiki_generate", startedAt });
          const abortOnClientClose = (): void => runController.abort(USER_STOP_MESSAGE);
          if (signal.aborted) abortOnClientClose();
          else signal.addEventListener("abort", abortOnClientClose, { once: true });
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
              owner: ref.owner,
              repo: ref.repo,
              url: ref.url,
              branch: ref.branch,
              sourcePath: ref.sourcePath ?? null,
              repos: refs,
            channel: pageChannel.id,
            structureChannel: structureChannel.id,
            pageChannel: pageChannel.id,
            runtime: wikiRuntime,
            localCli,
            pageCount: wikiPageCount,
            pageCountMode: wikiPageCountMode,
            knowledgeProfile,
          });
          try {
            const record = await generateWiki(ref, {
              refs,
              channel: pageChannel.id,
              structureChannel: structureChannel.id,
              pageChannel: pageChannel.id,
              runtime: wikiRuntime,
              localCli,
              concurrency: requestedConcurrency,
              depth: wikiDepth,
              pageCount: wikiPageCount,
              pageCountMode: wikiPageCountMode,
              preferDirectPages: desktopDirectPagesEnabled({
                server: opts,
                benchmarkFastPages: body.benchmarkFastPages,
              }),
              style: wikiStyle,
              stylePrompt: wikiStylePrompt,
              languages: wikiLanguages,
              knowledgeProfile,
              codeKb: { enabled: () => codeGraphEnabled },
              signal: runController.signal,
              store,
              providerSecrets,
              onCheckpoint: async (checkpointRecord, checkpoint) => {
                await productStore.upsertArtifact({
                  kind: WIKI_DRAFT_ARTIFACT_KIND,
                  key: run.id,
                  runId: run.id,
                  data: {
                    ...(checkpointRecord as unknown as Record<string, unknown>),
                    checkpoint,
                    status: "running",
                  },
                }).catch((error) => {
                  console.warn(`[wiki] failed to persist draft checkpoint for ${run.id}:`, error instanceof Error ? error.message : error);
                });
              },
              onEvent: (ev) => {
                sendPersisted(productStore, run.id, send, ev.type, ev);
              },
            });
            await productStore.updateRun(run.id, { status: "done", result: { wiki: record, processSnapshot: processSnapshotFor(run.id) } });
            await persistWikiRecordArtifacts(productStore, baseProductStore, record, run.id);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (runController.signal.aborted) {
              const recovered = await promoteWikiDraftRun(productStore, baseProductStore, run, USER_STOP_MESSAGE, {
                canceled: true,
              });
              if (recovered) {
                sendPersisted(productStore, run.id, send, "done", {
                  record: jsonObject(recovered.result).wiki,
                  wiki: jsonObject(recovered.result).wiki,
                  completion: jsonObject(recovered.result).completion,
                  warning: USER_STOP_MESSAGE,
                  recovered: true,
                  canceled: true,
                });
                return;
              }
              sendPersisted(productStore, run.id, send, "canceled", { message: USER_STOP_MESSAGE });
              await productStore.updateRun(run.id, {
                status: "canceled",
                error: USER_STOP_MESSAGE,
                result: { processSnapshot: processSnapshotFor(run.id) },
              });
              return;
            }
            const recovered = await promoteWikiDraftRun(productStore, baseProductStore, run, message);
            if (recovered) {
              sendPersisted(productStore, run.id, send, "done", {
                record: jsonObject(recovered.result).wiki,
                wiki: jsonObject(recovered.result).wiki,
                completion: jsonObject(recovered.result).completion,
                warning: message,
                recovered: true,
              });
              return;
            }
            sendPersisted(productStore, run.id, send, "error", { message });
            await productStore.updateRun(run.id, {
              status: "error",
              error: message,
              result: { processSnapshot: processSnapshotFor(run.id) },
            });
          } finally {
            signal.removeEventListener("abort", abortOnClientClose);
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            activeRunControllers.delete(run.id);
            releaseUserSlot?.();
            if (!wikiExternalWorker) activeGenerate = Math.max(0, activeGenerate - 1);
          }
        }, req, {
          providerSecrets,
          payload: wikiExternalWorker
            ? {
              worker: true,
              action: "wiki.generate",
              ref,
              refs,
              channel: pageChannel.id,
              structureChannel: structureChannel.id,
              pageChannel: pageChannel.id,
              runtime: wikiRuntime,
              localCli,
              concurrency: requestedConcurrency,
              depth: wikiDepth,
              pageCount: wikiPageCount,
              pageCountMode: wikiPageCountMode,
              style: wikiStyle,
              ...(wikiStylePrompt ? { stylePrompt: wikiStylePrompt } : {}),
              languages: wikiLanguages,
              knowledgeProfile,
              codeGraphEnabled,
            }
            : undefined,
        });
      }

      // Shared Composio GitHub connection (Review + Code use the same toolkit).
      if (
        method === "GET"
        && (url.pathname === "/api/github/status" || url.pathname === "/api/review/github/status")
      ) {
        return jsonResponse(await reviewGitHubConnectionStatus(store.root, capabilityProfile));
      }

      if (
        method === "POST"
        && (url.pathname === "/api/github/connect" || url.pathname === "/api/review/github/connect")
      ) {
        try {
          const current = await reviewGitHubConnectionStatus(store.root, capabilityProfile);
          if (current.connected) return jsonResponse(current);
          addComposioToolkits(store.root, { toolkits: ["github"] }, capabilityProfile);
          const auth = await authorizeComposioToolkit(store.root, { toolkit: "github" }, capabilityProfile);
          return jsonResponse({
            connected: false,
            provider: "github",
            configured: true,
            authorization: auth,
            redirectUrl: auth.redirectUrl ?? null,
          });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/review/load") {
        let body: { url?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        if (!body.url) return jsonResponse({ error: "url required" }, 400);

        try {
          const githubFetch = await createReviewGitHubFetch(store.root, capabilityProfile);
          const review = await loadReview(body.url, { githubFetch });
          reviewOwnerIds.set(review.reviewId, authIdentity.userId);
          return jsonResponse({ review });
        } catch (e) {
          if (e instanceof GitHubConnectionRequiredError) {
            return jsonResponse({ error: e.message, needsGitHubConnection: true }, 428);
          }
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "GET" && url.pathname === "/api/review/file") {
        const reviewId = url.searchParams.get("reviewId");
        const path = url.searchParams.get("path");
        const reviewUrl = url.searchParams.get("url");
        if (!reviewId || !path) return jsonResponse({ error: "reviewId and path required" }, 400);
        const reviewOwner = reviewOwnerIds.get(reviewId);
        if (reviewOwner && reviewOwner !== authIdentity.userId) {
          return jsonResponse({ error: "Review not found" }, 404);
        }

        try {
          if (!getCachedReview(reviewId) && reviewUrl) {
            const githubFetch = await createReviewGitHubFetch(store.root, capabilityProfile);
            const review = await loadReview(reviewUrl, { githubFetch, reviewId });
            reviewOwnerIds.set(review.reviewId, authIdentity.userId);
          }
          const file = await getReviewFileContents(reviewId, path);
          return jsonResponse(file);
        } catch (e) {
          if (e instanceof GitHubConnectionRequiredError) {
            return jsonResponse({ error: e.message, needsGitHubConnection: true }, 428);
          }
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 404);
        }
      }

      if (method === "POST" && url.pathname === "/api/review/run") {
        let body: {
          url?: string;
          reviewId?: string;
          question?: string;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          sourceCodeRunId?: string;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          selection?: ReviewSelection | null;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const cachedReview = body.reviewId && reviewOwnerIds.get(body.reviewId) === authIdentity.userId
          ? getCachedReview(body.reviewId)
          : null;
        const reviewUrl = body.url ?? cachedReview?.url;
        if (!reviewUrl) return jsonResponse({ error: "url or reviewId required" }, 400);

        const reviewChannelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        const reviewRuntime = normalizeAgentRuntime(body.runtime, "rlm");
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(reviewRuntime, localCli, req, "review", opts);
        if (localCliPreflight) return localCliPreflight;
        const sourceCodeRunId = typeof body.sourceCodeRunId === "string" ? body.sourceCodeRunId.trim() : "";
        let reviewChannel;
        try {
          reviewChannel = resolveChannel(reviewChannelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const reviewSt = providerStatusForRuntime(reviewRuntime, providerSecrets);
        if (!reviewSt[reviewChannel.provider].configured) return providerSetupResponse(reviewChannel, reviewSt[reviewChannel.provider], req);

        let githubFetch;
        try {
          githubFetch = await createReviewGitHubFetch(store.root, capabilityProfile);
        } catch (e) {
          if (e instanceof GitHubConnectionRequiredError) {
            return jsonResponse({ error: e.message, needsGitHubConnection: true }, 428);
          }
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }

        if (activeReview >= MAX_REVIEW) {
          return busyResponse({ kind: "review", scope: "global", active: activeReview, max: MAX_REVIEW, retryAfter: 20, req });
        }
        const releaseUserSlot = tryAcquireUserSlot(activeReviewByUser, authIdentity.userId);
        if (!releaseUserSlot) {
          return busyResponse({ kind: "review", scope: "user", active: 1, max: 1, retryAfter: 20, req });
        }

        const runtimeCapabilities = await capabilityRuntimeForRequest();
        const reviewInput = {
          url: reviewUrl,
          reviewId: body.reviewId ?? cachedReview?.reviewId ?? null,
          review: cachedReview,
          question: body.question ?? null,
          history: body.history ?? [],
          selection: body.selection ?? null,
          channel: reviewChannel.id,
          runtime: reviewRuntime,
          localCli,
          sourceCodeRunId: sourceCodeRunId || null,
          capabilities: runtimeCapabilities.snapshot,
        };
        const run = await productStore.createRun({
          kind: "review",
          title: `${runtimeLabel(reviewRuntime)} Review · ${cachedReview ? `${cachedReview.owner}/${cachedReview.repo}#${cachedReview.number}` : reviewUrl}`,
          input: reviewInput as Record<string, unknown>,
        });

        activeReview++;
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send) => {
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            url: reviewUrl,
            reviewId: body.reviewId ?? cachedReview?.reviewId ?? null,
            owner: cachedReview?.owner ?? null,
            repo: cachedReview?.repo ?? null,
            number: cachedReview?.number ?? null,
            question: body.question ?? null,
            channel: reviewChannel.id,
            runtime: reviewRuntime,
            localCli,
            sourceCodeRunId: sourceCodeRunId || null,
            capabilities: runtimeCapabilities.snapshot,
          });
          try {
            const result = await reviewAnything(reviewUrl, {
              channel: reviewChannel.id,
              runtime: reviewRuntime,
              localCli,
              question: body.question,
              history: body.history,
              selection: body.selection,
              store,
              mcpConfig: runtimeCapabilities.mcpConfig,
              skillSources: runtimeCapabilities.skillSources,
              providerSecrets,
              githubFetch,
              onEvent: (ev) => {
                sendPersisted(productStore, run.id, send, ev.type, ev);
              },
            });
            await productStore.updateRun(run.id, {
              status: "done",
              result: { answer: result.answer, sources: result.sources, processSnapshot: processSnapshotFor(run.id) },
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            sendPersisted(productStore, run.id, send, "error", { message });
            await productStore.updateRun(run.id, {
              status: "error",
              error: message,
              result: { processSnapshot: processSnapshotFor(run.id) },
            });
          } finally {
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            releaseUserSlot();
            activeReview = Math.max(0, activeReview - 1);
          }
        }, req, { providerSecrets });
      }

      if (method === "POST" && url.pathname === "/api/review/investigate") {
        let body: {
          url?: string;
          reviewId?: string;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const cachedReview = body.reviewId && reviewOwnerIds.get(body.reviewId) === authIdentity.userId
          ? getCachedReview(body.reviewId)
          : null;
        const reviewUrl = body.url ?? cachedReview?.url;
        if (!reviewUrl) return jsonResponse({ error: "url or reviewId required" }, 400);

        const reviewChannelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        const reviewRuntime = normalizeAgentRuntime(body.runtime, "rlm");
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(reviewRuntime, localCli, req, "investigation", opts);
        if (localCliPreflight) return localCliPreflight;
        let reviewChannel;
        try {
          reviewChannel = resolveChannel(reviewChannelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const reviewSt = providerStatusForRuntime(reviewRuntime, providerSecrets);
        if (!reviewSt[reviewChannel.provider].configured) return providerSetupResponse(reviewChannel, reviewSt[reviewChannel.provider], req);

        let githubFetch;
        try {
          githubFetch = await createReviewGitHubFetch(store.root, capabilityProfile);
        } catch (e) {
          if (e instanceof GitHubConnectionRequiredError) {
            return jsonResponse({ error: e.message, needsGitHubConnection: true }, 428);
          }
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }

        if (activeReview >= MAX_REVIEW) {
          return busyResponse({ kind: "review", scope: "global", active: activeReview, max: MAX_REVIEW, retryAfter: 20, req });
        }
        const releaseUserSlot = tryAcquireUserSlot(activeReviewByUser, authIdentity.userId);
        if (!releaseUserSlot) {
          return busyResponse({ kind: "review", scope: "user", active: 1, max: 1, retryAfter: 20, req });
        }

        const runtimeCapabilities = await capabilityRuntimeForRequest();
        const investigationInput = {
          url: reviewUrl,
          reviewId: body.reviewId ?? cachedReview?.reviewId ?? null,
          review: cachedReview,
          channel: reviewChannel.id,
          runtime: reviewRuntime,
          localCli,
          capabilities: runtimeCapabilities.snapshot,
        };
        const run = await productStore.createRun({
          kind: "investigate",
          title: `${runtimeLabel(reviewRuntime)} Investigate · ${cachedReview ? `${cachedReview.owner}/${cachedReview.repo}#${cachedReview.number}` : reviewUrl}`,
          input: investigationInput as Record<string, unknown>,
        });

        activeReview++;
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send) => {
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            url: reviewUrl,
            reviewId: body.reviewId ?? cachedReview?.reviewId ?? null,
            owner: cachedReview?.owner ?? null,
            repo: cachedReview?.repo ?? null,
            number: cachedReview?.number ?? null,
            channel: reviewChannel.id,
            runtime: reviewRuntime,
            localCli,
            capabilities: runtimeCapabilities.snapshot,
          });
          try {
            const result = await investigateReview(reviewUrl, {
              channel: reviewChannel.id,
              runtime: reviewRuntime,
              localCli,
              store,
              mcpConfig: runtimeCapabilities.mcpConfig,
              skillSources: runtimeCapabilities.skillSources,
              providerSecrets,
              githubFetch,
              onEvent: (ev) => {
                sendPersisted(productStore, run.id, send, ev.type, ev);
              },
            });
            sendPersisted(productStore, run.id, send, "investigation", result);
            await productStore.updateRun(run.id, {
              status: "done",
              result: { ...(result as unknown as Record<string, unknown>), processSnapshot: processSnapshotFor(run.id) },
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            sendPersisted(productStore, run.id, send, "error", { message });
            await productStore.updateRun(run.id, {
              status: "error",
              error: message,
              result: { processSnapshot: processSnapshotFor(run.id) },
            });
          } finally {
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            releaseUserSlot();
            activeReview = Math.max(0, activeReview - 1);
          }
        }, req, { providerSecrets });
      }

      if (method === "POST" && url.pathname === "/api/review/publish-comment") {
        let body: {
          runId?: string;
          confirm?: boolean;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }

        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        if (!runId) return jsonResponse({ error: "runId required" }, 400);
        if (body.confirm !== true) return jsonResponse({ error: "Posting to GitHub requires explicit confirmation" }, 400);

        const run = await productStore.getRun(runId);
        if (!run || (run.kind !== "review" && run.kind !== "investigate")) {
          return jsonResponse({ error: "Review session not found" }, 404);
        }

        try {
          const comment = await publishReviewRunComment(store.root, run, {
            confirm: true,
            defaultComposioUserId: capabilityProfile.defaultUserId,
          });
          const resultKey = run.kind === "investigate" ? "investigationComment" : "reviewComment";
          await productStore.updateRun(run.id, {
            result: {
              ...jsonObject(run.result),
              [resultKey]: comment,
            },
            error: null,
          });
          await productStore.appendEvent(run.id, "comment", comment);
          return jsonResponse({ ok: true, comment });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/code-anything") {
        let body: {
          url?: string;
          urls?: string[];
          task?: string;
          channel?: string;
          model?: string;
          agent?: string;
          runtime?: string;
          localCli?: unknown;
          screenshots?: unknown;
          maxIterations?: number;
          publishIntent?: boolean | string;
          displayTask?: string;
          handoff?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (!requestedCodeUrls(body).length || !task) return jsonResponse({ error: "url and task required" }, 400);
        const displayTask = typeof body.displayTask === "string" ? body.displayTask.trim() : "";
        const handoff = normalizeCodeHandoff(body.handoff);

        let ref: RepoRef;
        let refs: WorkspaceRepoRef[] | undefined;
        try {
          const parsed = parseCodeRefs(body, localRepoAccessForRequest(req, host, opts));
          ref = parsed.ref;
          refs = parsed.refs;
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }

        const codeChannelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        const codeRuntime = normalizeAgentRuntime(body.runtime, "agent");
        const localCli = normalizeLocalCliConfig(body.localCli ?? { agentId: body.agent });
        const localCliPreflight = await localCliPreflightResponse(codeRuntime, localCli, req, "coding", opts);
        if (localCliPreflight) return localCliPreflight;
        const codeAgent = normalizeCodeAnythingAgent(codeRuntime === "local-cli" ? localCli.agentId : body.agent);
        let codeChannel;
        try {
          codeChannel = resolveChannel(codeChannelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const codeSt = providerStatusForRuntime(codeRuntime, providerSecrets);
        if (!codeSt[codeChannel.provider].configured) return providerSetupResponse(codeChannel, codeSt[codeChannel.provider], req);

        // Code patches and PR publish need GitHub (Composio or GITHUB_TOKEN).
        try {
          const github = await reviewGitHubConnectionStatus(store.root, capabilityProfile);
          if (!github.connected) {
            return jsonResponse({
              error: github.message || "Connect GitHub before running Code Anything.",
              needsGitHubConnection: true,
            }, 428);
          }
        } catch (e) {
          return jsonResponse({
            error: e instanceof Error ? e.message : String(e),
            needsGitHubConnection: true,
          }, 428);
        }

        const allowInlinePublishIntent = body.publishIntent !== false && body.publishIntent !== "false";
        const inlinePublishOnly = allowInlinePublishIntent && isCodePublishRequest(task);
        const codeExternalWorker = !inlinePublishOnly && runModeFor(productStore, baseJobQueue, baseSecretGrantStore) === "worker";

        if (!codeExternalWorker && activeCode >= MAX_CODE) {
          return busyResponse({ kind: "code", scope: "global", active: activeCode, max: MAX_CODE, retryAfter: 20, req });
        }
        const releaseUserSlot = inlinePublishOnly || codeExternalWorker ? null : tryAcquireUserSlot(activeCodeByUser, authIdentity.userId);
        if (!inlinePublishOnly && !codeExternalWorker && !releaseUserSlot) {
          return busyResponse({ kind: "code", scope: "user", active: 1, max: 1, retryAfter: 20, req });
        }

        const runtimeCapabilities = await capabilityRuntimeForRequest();
        const turnId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const run = await productStore.createRun({
          kind: "code",
          title: `${runtimeLabel(codeRuntime)} Code · ${ref.owner}/${ref.repo}`,
          input: {
            ref,
            refs,
            task,
            channel: codeChannel.id,
            runtime: codeRuntime,
            agent: codeAgent,
            localCli,
            screenshotCount: Array.isArray(body.screenshots) ? body.screenshots.length : 0,
            publishIntent: allowInlinePublishIntent,
            displayTask: displayTask || undefined,
            handoff,
            capabilities: runtimeCapabilities.snapshot,
          },
        });

        if (inlinePublishOnly) {
          return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send) => {
            const answer = buildPrBoundaryAnswer({ task, ref, changedFiles: [] });
            const turn: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "done",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt: new Date().toISOString(),
              answer,
              sources: [],
              diff: "(no diff)",
              fullDiff: "(no diff)",
              gitStatus: "(clean)",
              changedFiles: [],
              truncated: false,
            };
            sendPersisted(productStore, run.id, send, "start", {
              runId: run.id,
              turnId,
              owner: ref.owner,
              repo: ref.repo,
                url: ref.url,
                branch: ref.branch,
                sourcePath: ref.sourcePath ?? null,
                repos: refs,
              task,
              displayTask: displayTask || undefined,
              handoff,
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              localCli,
              capabilities: runtimeCapabilities.snapshot,
              publishBlocked: true,
            });
            sendPersisted(productStore, run.id, send, "answer", { turnId, answer, sources: [] });
            sendPersisted(productStore, run.id, send, "diff", {
              turnId,
              diff: "(no diff)",
              status: "(clean)",
              changedFiles: [],
              truncated: false,
            });
            const current = await productStore.getRun(run.id);
            await productStore.updateRun(run.id, {
              status: "done",
              result: codeRunResultWithTurn(current ?? run, turn, processSnapshotFor(run.id)),
              error: null,
            });
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
          }, req, {
            providerSecrets,
            payload: {
              worker: true,
              action: "code.publish-boundary",
              turnId,
              startedAt,
              ref,
              refs,
              task,
              displayTask: displayTask || undefined,
              handoff,
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              capabilities: runtimeCapabilities.snapshot,
            },
          });
        }

        const runController = new AbortController();
        if (!codeExternalWorker) {
          activeCode++;
          activeCodeRunIds.add(run.id);
          activeRunControllers.set(run.id, { controller: runController, kind: "code", turnId, startedAt });
        }
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send) => {
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            turnId,
            owner: ref.owner,
            repo: ref.repo,
              url: ref.url,
              branch: ref.branch,
              sourcePath: ref.sourcePath ?? null,
              repos: refs,
            task,
            displayTask: displayTask || undefined,
            handoff,
            channel: codeChannel.id,
            runtime: codeRuntime,
            agent: codeAgent,
            localCli,
            capabilities: runtimeCapabilities.snapshot,
          });
          try {
            const result = await codeAnything(ref, task, {
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              localCli,
              screenshots: body.screenshots,
              maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
              mcpConfig: runtimeCapabilities.mcpConfig,
              skillSources: runtimeCapabilities.skillSources,
              providerSecrets,
              refs,
              signal: runController.signal,
              onEvent: (ev) => {
                sendPersisted(productStore, run.id, send, ev.type, withTurnId(turnId, ev));
              },
            });
            const completedAt = new Date().toISOString();
            const turn: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "done",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt,
              answer: result.answer,
              sources: result.sources,
              diff: result.diff,
              fullDiff: result.fullDiff,
              gitStatus: result.status,
              changedFiles: result.changedFiles,
              truncated: result.truncated,
            };
            const current = await productStore.getRun(run.id);
            await productStore.updateRun(run.id, {
              status: "done",
              result: codeRunResultWithTurn(current ?? run, turn, processSnapshotFor(run.id)),
              error: null,
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const turnBase: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "error",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt: new Date().toISOString(),
              error: message,
            };
            const turn = isAbortError(e) ? canceledCodeTurn(turnBase, USER_STOP_MESSAGE) : turnBase;
            sendPersisted(productStore, run.id, send, turn.status === "canceled" ? "canceled" : "error", { turnId, message: turn.error ?? message });
            const current = await productStore.getRun(run.id);
            await productStore.updateRun(run.id, {
              status: codeRunStatusAfterTurn(current ?? run, turn),
              error: turn.status === "canceled" ? USER_STOP_MESSAGE : message,
              result: codeRunResultWithTurn(current ?? run, turn, processSnapshotFor(run.id)),
            });
          } finally {
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            activeRunControllers.delete(run.id);
            activeCodeRunIds.delete(run.id);
            releaseUserSlot?.();
            activeCode = Math.max(0, activeCode - 1);
          }
        }, req, {
          providerSecrets,
          payload: {
            worker: true,
            action: "code.initial",
            turnId,
            startedAt,
            ref,
            refs,
            task,
            displayTask: displayTask || undefined,
            handoff,
            channel: codeChannel.id,
            runtime: codeRuntime,
            agent: codeAgent,
            localCli,
            screenshots: body.screenshots,
            maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
            capabilities: runtimeCapabilities.snapshot,
          },
        });
      }

      if (method === "POST" && url.pathname === "/api/code-anything/follow-up") {
        let body: {
          runId?: string;
          task?: string;
          channel?: string;
          model?: string;
          agent?: string;
          runtime?: string;
          localCli?: unknown;
          screenshots?: unknown;
          maxIterations?: number;
          displayTask?: string;
          handoff?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);

        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (!runId || !task) return jsonResponse({ error: "runId and task required" }, 400);
        const displayTask = typeof body.displayTask === "string" ? body.displayTask.trim() : "";
        const handoff = normalizeCodeHandoff(body.handoff);

        let existing = await productStore.getRun(runId);
        if (!existing || existing.kind !== "code") return jsonResponse({ error: "Code session not found" }, 404);

        if (activeCodeRunIds.has(existing.id)) {
          return jsonResponse({ error: "This code session already has a running turn." }, 409);
        }
        const recoveredResult = recoverStaleCodeTurns(existing);
        if (recoveredResult) {
          existing = await productStore.updateRun(existing.id, {
            status: "done",
            result: recoveredResult,
            error: null,
          }) ?? existing;
        }

        const existingTurns = codeTurnsFromRun(existing);

        const input = jsonObject(existing.input);
        const ref = publicRepoRefFromUnknown(input.ref);
        if (!ref) return jsonResponse({ error: "Code session is missing its repository reference." }, 400);
        const repoRef = { owner: ref.owner, repo: ref.repo, url: ref.url, branch: ref.branch ?? null, sourcePath: ref.sourcePath ?? null };
        const refs = workspaceRefsFromUnknown(input.refs);

        const priorResult = jsonObject(existing.result);
        const visibleDiff = typeof priorResult.diff === "string" ? priorResult.diff : "";
        const fullDiff = typeof priorResult.fullDiff === "string" ? priorResult.fullDiff : "";
        const filteredVisibleDiff = filterIgnoredPatch(visibleDiff);
        const filteredVisibleDiffIsComplete = isCompleteDiffForApply(filteredVisibleDiff);
        const priorDiff = fullDiff
          ? filterIgnoredPatch(fullDiff)
          : filteredVisibleDiffIsComplete
          ? filteredVisibleDiff
          : "";
        const patchExcerpt = priorDiff ? "" : filteredVisibleDiff;
        const lastDoneTurn = [...existingTurns].reverse().find((turn) => turn.status === "done");
        const priorChangedFiles = Array.isArray(priorResult.changedFiles) ? priorResult.changedFiles.map(String) : lastDoneTurn?.changedFiles ?? [];

        const codeChannelId = body.channel ?? body.model ?? (lastDoneTurn?.channel || input.channel) ?? DEFAULT_CHANNEL_ID;
        const codeRuntime = normalizeAgentRuntime(body.runtime ?? input.runtime, "agent");
        const localCli = normalizeLocalCliConfig(body.localCli ?? jsonObject(input.localCli) ?? { agentId: body.agent });
        const localCliPreflight = await localCliPreflightResponse(codeRuntime, localCli, req, "coding follow-up", opts);
        if (localCliPreflight) return localCliPreflight;

        try {
          const github = await reviewGitHubConnectionStatus(store.root, capabilityProfile);
          if (!github.connected) {
            return jsonResponse({
              error: github.message || "Connect GitHub before continuing a Code session.",
              needsGitHubConnection: true,
            }, 428);
          }
        } catch (e) {
          return jsonResponse({
            error: e instanceof Error ? e.message : String(e),
            needsGitHubConnection: true,
          }, 428);
        }

        const codeAgent = normalizeCodeAnythingAgent(codeRuntime === "local-cli" ? localCli.agentId : body.agent);
        let codeChannel;
        try {
          codeChannel = resolveChannel(String(codeChannelId));
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const codeSt = providerStatusForRuntime(codeRuntime, providerSecrets);
        if (!codeSt[codeChannel.provider].configured) return providerSetupResponse(codeChannel, codeSt[codeChannel.provider], req);

        if (isCodePublishRequest(task)) {
          return runResponse(productStore, baseJobQueue, baseSecretGrantStore, existing, authIdentity.userId, async (send) => {
            const turnId = crypto.randomUUID();
            const startedAt = new Date().toISOString();
            sendPersisted(productStore, existing.id, send, "start", {
              runId: existing.id,
              turnId,
              continuation: true,
              owner: repoRef.owner,
              repo: repoRef.repo,
                url: repoRef.url,
                branch: repoRef.branch,
                sourcePath: repoRef.sourcePath ?? null,
                repos: refs,
              task,
              displayTask: displayTask || undefined,
              handoff,
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              localCli,
              publishRequested: true,
              publishBlocked: !priorDiff,
            });
            let publish: Awaited<ReturnType<typeof publishCodeAnythingPullRequest>> | null = null;
            let answer = "";
            let publishError = "";
            if (priorDiff) {
              try {
                publish = await publishCodeAnythingPullRequest(store.root, existing, {
                  mode: jsonObject(priorResult.pullRequest).url ? "update" : "create",
                  channel: codeChannel.id,
                  confirm: true,
                  defaultComposioUserId: capabilityProfile.defaultUserId,
                });
                answer = buildPrPublishedAnswer(publish);
              } catch (e) {
                publishError = e instanceof Error ? e.message : String(e);
              }
            }
            if (!answer) {
              answer = buildPrBoundaryAnswer({
                task,
                ref,
                diff: filteredVisibleDiff,
                changedFiles: priorChangedFiles,
                previousAnswer: typeof priorResult.answer === "string" ? priorResult.answer : lastDoneTurn?.answer,
              });
              if (publishError) {
                answer += `\n\n## Publish Attempt Failed\n\n${publishError}`;
              }
            }
            const turn: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "done",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt: new Date().toISOString(),
              answer,
              sources: [],
              diff: filteredVisibleDiff || "(no diff)",
              fullDiff: priorDiff || fullDiff || filteredVisibleDiff || "(no diff)",
              gitStatus: typeof priorResult.status === "string" ? priorResult.status : lastDoneTurn?.gitStatus ?? "(clean)",
              changedFiles: priorChangedFiles,
              truncated: priorResult.truncated === true && !priorDiff,
            };
            sendPersisted(productStore, existing.id, send, "answer", { turnId: turn.id, answer, sources: [] });
            if (publish) sendPersisted(productStore, existing.id, send, "publish", publish);
            sendPersisted(productStore, existing.id, send, "diff", {
              turnId: turn.id,
              diff: turn.diff,
              status: turn.gitStatus,
              changedFiles: turn.changedFiles,
              truncated: turn.truncated,
            });
            const current = await productStore.getRun(existing.id);
            const nextResult = codeRunResultWithTurn(current ?? existing, turn, processSnapshotFor(existing.id));
            if (publish) {
              nextResult.publish = publish;
              nextResult.branch = publish.branch;
              nextResult.pullRequest = publish.pullRequest ?? null;
              await productStore.appendEvent(existing.id, "publish", publish);
            }
            await productStore.updateRun(existing.id, {
              status: "done",
              result: nextResult,
              error: null,
            });
            await waitForPersistedEvents(existing.id);
            runProcessEvents.delete(existing.id);
          }, req, { providerSecrets });
        }

        if (activeCode >= MAX_CODE) {
          return busyResponse({ kind: "code", scope: "global", active: activeCode, max: MAX_CODE, retryAfter: 20, req });
        }
        const releaseUserSlot = tryAcquireUserSlot(activeCodeByUser, authIdentity.userId);
        if (!releaseUserSlot) {
          return busyResponse({ kind: "code", scope: "user", active: 1, max: 1, retryAfter: 20, req });
        }

        const runtimeCapabilities = await capabilityRuntimeForRequest();
        const turnId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const runningTurn: CodeSessionTurn = {
          id: turnId,
          task,
          displayTask: displayTask || undefined,
          handoff,
          status: "running",
          channel: codeChannel.id,
          runtime: codeRuntime,
          agent: codeAgent,
          localCli,
          startedAt,
        };
        await productStore.updateRun(existing.id, {
          status: "running",
          result: codeRunResultWithTurn(existing, runningTurn),
          error: null,
        });

        const runController = new AbortController();
        activeCode++;
        activeCodeRunIds.add(existing.id);
        activeRunControllers.set(existing.id, { controller: runController, kind: "code", turnId, startedAt });
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, existing, authIdentity.userId, async (send, _close, signal) => {
          const abortOnClientClose = (): void => runController.abort(USER_STOP_MESSAGE);
          if (signal.aborted) abortOnClientClose();
          else signal.addEventListener("abort", abortOnClientClose, { once: true });
          sendPersisted(productStore, existing.id, send, "start", {
            runId: existing.id,
            turnId,
            continuation: true,
            owner: repoRef.owner,
            repo: repoRef.repo,
              url: repoRef.url,
              branch: repoRef.branch,
              sourcePath: repoRef.sourcePath ?? null,
              task,
            displayTask: displayTask || undefined,
            handoff,
            channel: codeChannel.id,
            runtime: codeRuntime,
            agent: codeAgent,
            localCli,
            capabilities: runtimeCapabilities.snapshot,
            patchRehydrated: Boolean(priorDiff),
            patchExcerptOnly: Boolean(patchExcerpt),
          });
          try {
            const result = await codeAnything(repoRef, task, {
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              localCli,
              screenshots: body.screenshots,
              maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
              mcpConfig: runtimeCapabilities.mcpConfig,
              skillSources: runtimeCapabilities.skillSources,
              basePatch: priorDiff,
              providerSecrets,
              refs,
              previousContext: {
                task: lastDoneTurn?.task || (typeof input.task === "string" ? input.task : ""),
                answer: typeof priorResult.answer === "string" ? priorResult.answer : lastDoneTurn?.answer,
                changedFiles: priorChangedFiles,
                patchExcerpt,
              },
              signal: runController.signal,
              onEvent: (ev) => {
                sendPersisted(productStore, existing.id, send, ev.type, withTurnId(turnId, ev));
              },
            });
            const turn: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "done",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt: new Date().toISOString(),
              answer: result.answer,
              sources: result.sources,
              diff: result.diff,
              fullDiff: result.fullDiff,
              gitStatus: result.status,
              changedFiles: result.changedFiles,
              truncated: result.truncated,
            };
            const current = await productStore.getRun(existing.id);
            await productStore.updateRun(existing.id, {
              status: "done",
              result: codeRunResultWithTurn(current ?? existing, turn, processSnapshotFor(existing.id)),
              error: null,
            });
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const turnBase: CodeSessionTurn = {
              id: turnId,
              task,
              displayTask: displayTask || undefined,
              handoff,
              status: "error",
              channel: codeChannel.id,
              runtime: codeRuntime,
              agent: codeAgent,
              startedAt,
              completedAt: new Date().toISOString(),
              error: message,
            };
            const turn = isAbortError(e) ? canceledCodeTurn(turnBase, USER_STOP_MESSAGE) : turnBase;
            sendPersisted(productStore, existing.id, send, turn.status === "canceled" ? "canceled" : "error", { turnId, message: turn.error ?? message });
            const current = await productStore.getRun(existing.id);
            await productStore.updateRun(existing.id, {
              status: turn.status === "canceled" ? codeRunStatusAfterTurn(current ?? existing, turn) : "done",
              result: codeRunResultWithTurn(current ?? existing, turn, processSnapshotFor(existing.id)),
              error: turn.status === "canceled" && codeRunStatusAfterTurn(current ?? existing, turn) === "canceled" ? USER_STOP_MESSAGE : null,
            });
          } finally {
            signal.removeEventListener("abort", abortOnClientClose);
            await waitForPersistedEvents(existing.id);
            runProcessEvents.delete(existing.id);
            activeRunControllers.delete(existing.id);
            activeCodeRunIds.delete(existing.id);
            releaseUserSlot();
            activeCode = Math.max(0, activeCode - 1);
          }
        }, req, { providerSecrets });
      }

      if (method === "POST" && url.pathname === "/api/code-anything/publish-pr") {
        let body: {
          runId?: string;
          mode?: "create" | "update";
          title?: string;
          body?: string;
          channel?: string;
          model?: string;
          confirm?: boolean;
          openUpstreamPr?: boolean;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }

        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        if (!runId) return jsonResponse({ error: "runId required" }, 400);
        if (body.confirm !== true) return jsonResponse({ error: "Publishing requires explicit confirmation" }, 400);
        if (activeCodeRunIds.has(runId)) {
          return jsonResponse({ error: "This code session already has a running turn." }, 409);
        }

        const run = await productStore.getRun(runId);
        if (!run || run.kind !== "code") return jsonResponse({ error: "Code session not found" }, 404);

        try {
          const github = await reviewGitHubConnectionStatus(store.root, capabilityProfile);
          if (!github.connected) {
            return jsonResponse({
              error: github.message || "Connect GitHub before publishing a pull request.",
              needsGitHubConnection: true,
            }, 428);
          }
        } catch (e) {
          return jsonResponse({
            error: e instanceof Error ? e.message : String(e),
            needsGitHubConnection: true,
          }, 428);
        }

        try {
          const publish = await publishCodeAnythingPullRequest(store.root, run, {
            mode: body.mode === "update" ? "update" : "create",
            title: typeof body.title === "string" ? body.title : undefined,
            body: typeof body.body === "string" ? body.body : undefined,
            channel: typeof body.channel === "string" ? body.channel : typeof body.model === "string" ? body.model : undefined,
            openUpstreamPr: body.openUpstreamPr !== false,
            confirm: true,
            defaultComposioUserId: capabilityProfile.defaultUserId,
          });
          const nextResult = {
            ...jsonObject(run.result),
            publish,
            branch: publish.branch,
            pullRequest: publish.pullRequest ?? null,
            error: null,
          };
          await productStore.updateRun(run.id, {
            status: run.status === "running" ? "done" : run.status,
            result: nextResult,
            error: null,
          });
          await productStore.appendEvent(run.id, "publish", publish);
          return jsonResponse({
            ok: true,
            publish,
            pullRequest: publish.pullRequest,
            branch: publish.branch,
          });
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (method === "POST" && url.pathname === "/api/ask") {
        let body: {
          url?: string;
          urls?: string[];
          sourceRefs?: RequestedSourceRef[];
          question?: string;
          channel?: string;
          model?: string;
          runtime?: string;
          localCli?: unknown;
          askMode?: string;
          askIntent?: string;
          clarifyContext?: string;
          sessionId?: string;
          workspaceGoal?: string | null;
          history?: Array<{ role: "user" | "assistant"; content: string }>;
          wikiContexts?: unknown;
          knowledgeProfile?: unknown;
          codeGraphEnabled?: boolean;
          screenshots?: unknown;
          providerSecrets?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return jsonResponse({ error: "invalid JSON" }, 400);
        }
        const providerSecrets = normalizeProviderSecrets(body.providerSecrets);
        let askScreenshots;
        try {
          askScreenshots = normalizeScreenshotAttachments(body.screenshots);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const requestedUrls =
          Array.isArray(body.urls) && body.urls.length > 0
            ? body.urls
            : body.url
            ? [body.url]
            : [];
        const requestedSourceRefs = Array.isArray(body.sourceRefs) ? body.sourceRefs : [];
        const requestedSourceCount = requestedSourceRefs.length || requestedUrls.length;
        const question = typeof body.question === "string" ? body.question.trim() : "";

        if (!requestedSourceCount || !question) {
          return jsonResponse({ error: "url(s) and question required" }, 400);
        }
        if (requestedSourceCount > MAX_ASK_REPOS) {
          return jsonResponse({ error: `at most ${MAX_ASK_REPOS} repositories can be asked at once` }, 400);
        }

        let refs;
        try {
          const localRepoAccess = localFolderAccessForReadOnlyRequest(req, host, opts);
          refs = requestedSourceRefs.length
            ? parseAskRefsFromSourceRefs(requestedSourceRefs, localRepoAccess)
            : parseAskRefsFromUrls(requestedUrls, localRepoAccess);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }

        const workspaceGoal =
          body.workspaceGoal && WORKSPACE_GOALS.has(body.workspaceGoal)
            ? (body.workspaceGoal as WorkspaceGoal)
            : null;
        const askMode: AskMode =
          body.askMode && ASK_MODES.has(body.askMode)
            ? (body.askMode as AskMode)
            : "deep";
        const askIntent = body.askIntent === "docs-inline" ? "docs-inline" : "repo";
        // Clarify-interview transcript: kept separate from the mode flag above and
        // from the verbatim question. Forwarded into the prompt as an authoritative
        // refinement so the agent answers the clarified intent, not just the
        // original wording.
        const clarifyContext =
          typeof body.clarifyContext === "string" && body.clarifyContext.trim()
            ? body.clarifyContext.trim()
            : null;

        const askChannelId = body.channel ?? body.model ?? DEFAULT_CHANNEL_ID;
        const askRuntime = normalizeAgentRuntime(body.runtime, "rlm");
        const localCli = normalizeLocalCliConfig(body.localCli);
        const localCliPreflight = await localCliPreflightResponse(askRuntime, localCli, req, "ask", opts);
        if (localCliPreflight) return localCliPreflight;
        let askChannel;
        try {
          askChannel = resolveChannel(askChannelId);
        } catch (e) {
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const askSt = providerStatusForRuntime(askRuntime, providerSecrets);
        if (!askSt[askChannel.provider].configured) return providerSetupResponse(askChannel, askSt[askChannel.provider], req);

        if (activeAsk >= MAX_ASK) {
          return busyResponse({ kind: "ask", scope: "global", active: activeAsk, max: MAX_ASK, retryAfter: 15, req });
        }
        const activeAskForUser = activeAskByUser.get(authIdentity.userId) ?? 0;
        const releaseUserSlot = tryAcquireUserSlot(activeAskByUser, authIdentity.userId, MAX_ASK_PER_USER);
        if (!releaseUserSlot) {
          return busyResponse({ kind: "ask", scope: "user", active: activeAskForUser, max: MAX_ASK_PER_USER, retryAfter: 15, req });
        }

        const history = Array.isArray(body.history) ? body.history : [];
        const codeGraphEnabled = codeGraphEnabledForRequest(body.codeGraphEnabled);
        // Server-computed code-kb entry for the primary ref: started here so its
        // session ensure + architecture fetch overlap wiki-context resolution and
        // the capability probe instead of adding serial wall-clock before the
        // stream opens. Appended after the explicit picks below so nothing the
        // user chose is evicted; null (skipped silently) when the session is not
        // ready within the short budget.
        const codeKbEntryPromise = computeCodeKbAskEntry(refs[0] ?? null, question, {
          enabled: () => codeGraphEnabled,
        });
        const wikiContexts = await resolveAskWikiContexts(body.wikiContexts, productStore, store);
        const knowledgeProfile = normalizeKnowledgeProfile(body.knowledgeProfile);
        const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        const runtimeCapabilities = await capabilityRuntimeForRequest();
        const codeKbEntry = await codeKbEntryPromise;
        if (codeKbEntry) wikiContexts.push(codeKbEntry);
        const turn: AskSessionTurn = {
          id: crypto.randomUUID(),
          question,
          status: "running",
          refs: refs.map(publicRepoRef),
          history,
          channel: askChannel.id,
          runtime: askRuntime,
          localCli,
          workspaceGoal,
          askMode,
          capabilities: runtimeCapabilities.snapshot,
          knowledgeProfile,
          startedAt: new Date().toISOString(),
        };

        let run: ProductRun;
        if (requestedSessionId) {
          const existing = await productStore.getRun(requestedSessionId);
          if (!existing) {
            return jsonResponse({ error: "ask session not found" }, 404);
          }
          if (existing.kind !== "ask") {
            return jsonResponse({ error: "session is not an Ask session" }, 400);
          }
          if (activeAskRunIds.has(existing.id)) {
            if (askSessionHasRunningTurn(existing)) {
              return jsonResponse({ error: "ask session already has a running question" }, 409);
            }
            clearStaleAskSessionLock(existing.id);
          }
          run = await productStore.updateRun(existing.id, {
            status: "running",
            title: question,
            input: askRunInputWithTurn(existing, turn),
            result: askRunResultWithTurn(existing, turn),
            error: null,
          }) ?? existing;
        } else {
          run = await productStore.createRun({
            kind: "ask",
            title: question,
            input: askRunInputWithTurn(null, turn),
          });
        }

        activeAsk++;
        activeAskRunIds.add(run.id);
        const runController = new AbortController();
        activeRunControllers.set(run.id, { controller: runController, kind: "ask", turnId: turn.id, startedAt: turn.startedAt });
        return runResponse(productStore, baseJobQueue, baseSecretGrantStore, run, authIdentity.userId, async (send, _close, signal) => {
          const abortOnClientClose = (): void => runController.abort(USER_STOP_MESSAGE);
          if (signal.aborted) abortOnClientClose();
          else signal.addEventListener("abort", abortOnClientClose, { once: true });
          const primary = refs[0];
          sendPersisted(productStore, run.id, send, "start", {
            runId: run.id,
            turnId: turn.id,
            owner: primary.owner,
            repo: primary.repo,
            url: primary.url,
            branch: primary.branch,
            sourcePath: primary.sourcePath ?? null,
            workspace: refs.length > 1,
            repos: refs.map((ref) => ({
              id: ref.id,
              owner: ref.owner,
              repo: ref.repo,
              label: ref.label,
              url: ref.url,
              branch: ref.branch,
              sourcePath: ref.sourcePath ?? null,
            })),
            question,
            channel: askChannel.id,
            runtime: askRuntime,
            localCli,
            workspaceGoal,
            askMode,
            capabilities: runtimeCapabilities.snapshot,
            knowledgeProfile,
          });
          try {
            const result = refs.length > 1
              ? await askWorkspace(refs, question, {
                channel: askChannel.id,
                runtime: askRuntime,
                localCli,
                history,
                workspaceGoal,
                askMode,
                askIntent,
                clarifyContext,
                wikiContexts,
                knowledgeProfile,
                store,
                mcpConfig: runtimeCapabilities.mcpConfig,
                skillSources: runtimeCapabilities.skillSources,
                providerSecrets,
                screenshots: askScreenshots,
                signal: runController.signal,
                onEvent: (ev) => {
                  sendPersisted(productStore, run.id, send, ev.type, withTurnId(turn.id, ev));
                },
              })
              : await askRepo(primary, question, {
                channel: askChannel.id,
                runtime: askRuntime,
                localCli,
                history,
                askMode,
                askIntent,
                clarifyContext,
                wikiContexts,
                knowledgeProfile,
                store,
                mcpConfig: runtimeCapabilities.mcpConfig,
                skillSources: runtimeCapabilities.skillSources,
                providerSecrets,
                screenshots: askScreenshots,
                signal: runController.signal,
                onEvent: (ev) => {
                  sendPersisted(productStore, run.id, send, ev.type, withTurnId(turn.id, ev));
                },
              });
            const completedTurn: AskSessionTurn = {
              ...turn,
              status: "done",
              answer: result.answer,
              sources: result.sources,
              completedAt: new Date().toISOString(),
            };
            sendPersisted(productStore, run.id, send, "answer", {
              turnId: completedTurn.id,
              answer: completedTurn.answer,
              sources: completedTurn.sources,
            });
            run = await productStore.updateRun(run.id, {
              status: "done",
              input: askRunInputWithTurn(run, completedTurn),
              result: askRunResultWithTurn(run, completedTurn, processSnapshotFor(run.id)),
              error: null,
            }) ?? run;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const erroredTurn: AskSessionTurn = {
              ...turn,
              status: isAbortError(e) ? "canceled" : "error",
              error: isAbortError(e) ? USER_STOP_MESSAGE : message,
              completedAt: new Date().toISOString(),
            };
            sendPersisted(productStore, run.id, send, erroredTurn.status === "canceled" ? "canceled" : "error", {
              turnId: turn.id,
              message: erroredTurn.error,
            });
            run = await productStore.updateRun(run.id, {
              status: erroredTurn.status,
              input: askRunInputWithTurn(run, erroredTurn),
              result: askRunResultWithTurn(run, erroredTurn, processSnapshotFor(run.id)),
              error: erroredTurn.error,
            }) ?? run;
          } finally {
            signal.removeEventListener("abort", abortOnClientClose);
            await waitForPersistedEvents(run.id);
            runProcessEvents.delete(run.id);
            activeRunControllers.delete(run.id);
            activeAskRunIds.delete(run.id);
            releaseUserSlot();
            activeAsk = Math.max(0, activeAsk - 1);
          }
        }, req, { providerSecrets });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders(req) });
    },
  });

  const productName = desktopEnabled(opts) ? "Grok-Wiki" : "rlm-wiki";
  console.log(`${productName} listening at http://${server.hostname}:${server.port}`);
  console.log(`  UI:        http://${server.hostname}:${server.port}/`);
  console.log(`  Health:    http://${server.hostname}:${server.port}/api/health`);
  console.log(`  Storage:   ${baseStore.root}`);
  console.log(`  History:   ${baseProductStore.mode}`);
  console.log(`  Queue:     ${baseJobQueue.mode}`);
  console.log(`  Secrets:   ${baseSecretGrantStore.mode}`);
  await new Promise(() => {
    // Keep CLI/desktop serve processes alive after Bun.serve() returns.
  });
}

export function sendPersisted(
  store: ProductStore,
  runId: string,
  send: (ev: string, data: unknown) => void,
  ev: string,
  data: unknown,
): void {
  const publicData = normalizeRunEventForStream(redactProviderSecrets(data));
  send(ev, publicData);
  if (ev === "error") {
    // Every streamed run (wiki, docs, ask, distill) funnels its terminal error
    // through here; one hook covers all backend run failures.
    const message = String(jsonObject(publicData).message || jsonObject(publicData).error || "Run error");
    if (shouldCaptureRunStreamError(message)) {
      captureServerError("run_stream", message, { run_id: runId });
    }
  }
  const compact = compactRunEvent(ev, publicData);
  if (!compact) return;
  rememberProcessEvent(runId, compact);
  if (isRunEventPersistenceDisabled(runId)) return;
  const previous = runEventAppendQueue;
  const next = previous
    .catch(() => {
      /* keep the queue moving after a prior write failure */
    })
    .then(() => appendRunEventWithRetry(store, runId, compact))
    .catch((error) => {
      console.warn(`[persistence] failed to append ${compact.type} for ${runId}:`, error instanceof Error ? error.message : error);
      if (isFatalRunEventPersistenceError(error)) {
        disableRunEventPersistence(runId, error);
      } else if (isSqliteBusyError(error)) {
        disableRunEventPersistence(runId, error);
        return;
      }
      captureServerError("persistence", error, {
        event_type: compact.type,
        run_id: runId,
        fatal_storage: isFatalRunEventPersistenceError(error),
      });
    })
    .finally(() => {
      if (runEventWriteQueues.get(runId) === next) runEventWriteQueues.delete(runId);
    });
  runEventWriteQueues.set(runId, next);
  runEventAppendQueue = next;
}

function isRunEventPersistenceDisabled(runId: string): boolean {
  const disabled = runEventPersistenceDisabled.get(runId);
  if (!disabled) return false;
  if (Date.now() - disabled.disabledAt > RUN_EVENT_PERSISTENCE_DISABLED_TTL_MS) {
    runEventPersistenceDisabled.delete(runId);
    return false;
  }
  return true;
}

function disableRunEventPersistence(runId: string, error: unknown): void {
  if (runEventPersistenceDisabled.has(runId)) return;
  const reason = error instanceof Error ? error.message : String(error);
  runEventPersistenceDisabled.set(runId, { reason, disabledAt: Date.now() });
}

function isFatalRunEventPersistenceError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "");
  return /\bSQLITE_FULL\b|database or disk is full|disk full|no space left on device|\bENOSPC\b/i.test(message);
}

export function shouldCaptureRunStreamError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "");
  if (!message.trim()) return true;
  if (/AbortError|Stopped by user/i.test(message)) return false;
  if (/Task terminal session ended with an error/i.test(message)) return false;
  if (/is not installed or authenticated/i.test(message)) return false;
  if (/Run .*login|Install .*CLI|authenticate .*CLI|OpenAI API keys do not authenticate/i.test(message)) {
    return false;
  }
  if (/the local CLI runtime failed/i.test(message)) return false;
  if (/(?:local agent|local CLI|CLI|Codex|Claude Code|Grok|Antigravity|Pi)\b[\s\S]{0,180}\bexited with \d+/i.test(message)) {
    return false;
  }
  return true;
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "");
  return /database is locked|SQLITE_BUSY|database busy/i.test(message);
}

function runEventSqliteBusyRetryDelays(): number[] {
  const configured = process.env.RLM_WIKI_SQLITE_BUSY_RETRY_DELAYS_MS?.trim();
  if (configured) {
    const parsed = configured
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item) && item >= 0)
      .map((item) => Math.floor(item));
    if (parsed.length) return parsed;
  }
  return [];
}

async function appendRunEventWithRetry(
  store: ProductStore,
  runId: string,
  compact: CompactRunEvent,
): Promise<ProductRunEvent> {
  let lastError: unknown;
  const delays = runEventSqliteBusyRetryDelays();
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await store.appendEvent(runId, compact.type, compact.payload);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error)) throw error;
      if (attempt >= delays.length) break;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastError;
}

function normalizeRunEventForStream(data: unknown): unknown {
  const payload = jsonObject(data);
  if (!payload.event) return data;
  return {
    ...payload,
    event: openDesignAgentEvent(jsonObject(payload.event)),
  };
}

export function openDesignAgentEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = String(event.type || "");
  if (
    type === "text_delta" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "tool_use" ||
    type === "tool_result" ||
    type === "participant_status" ||
    type === "usage" ||
    type === "status" ||
    type === "error"
  ) {
    return event;
  }
  if (type === "stream-delta") return { type: "text_delta", text: compactString(event.delta, 200_000), replace: event.replace === true };
  if (type === "stream-reasoning-delta") return { type: "thinking_delta", text: compactString(event.delta, 80_000) };
  if (type === "stream-done") return { type: "status", label: "stream_done", message: "" };
  if (type === "status") return {
    type: "status",
    label: compactString(event.label || event.phase, 80),
    message: compactString(event.message, 1000),
    phase: compactString(event.phase, 80),
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    agentId: compactString(event.agentId, 80) || undefined,
    model: compactString(event.model, 120) || undefined,
    sessionId: compactString(event.sessionId, 160) || undefined,
  };
  if (type === "usage") {
    const inputTokens = typeof event.promptTokens === "number" ? event.promptTokens : undefined;
    const outputTokens = typeof event.completionTokens === "number" ? event.completionTokens : undefined;
    const totalTokens = typeof event.totalTokens === "number" ? event.totalTokens : undefined;
    return { type: "usage", inputTokens, outputTokens, totalTokens };
  }
  if (type === "tool-start") return { type: "tool_use", id: crypto.randomUUID(), name: compactString(event.tool, 120) || "tool" };
  if (type === "tool-done") return { type: "tool_result", id: crypto.randomUUID(), name: compactString(event.tool, 120), durationMs: event.durationMs };
  if (type === "tool-error") return { type: "tool_result", id: crypto.randomUUID(), name: compactString(event.tool, 120), output: compactString(event.error, 2000), isError: true, durationMs: event.durationMs };
  if (type === "agent-log") {
    const kind = String(event.kind || "");
    const id = compactString(event.id, 120) || crypto.randomUUID();
    const tool = compactString(event.tool, 120);
    if (kind === "reasoning") return { type: "thinking_delta", text: compactString(event.reasoning || event.message, 80_000) };
    if (kind === "tool-input") return { type: "tool_use", id, name: tool || compactString(event.message, 120) || "tool", input: event.input };
    if (kind === "tool-output" || kind === "tool-error") {
      return { type: "tool_result", id, name: tool, output: compactString(event.output || event.error || event.message, 80_000), isError: kind === "tool-error", durationMs: event.durationMs };
    }
    // Keep status/message agent-logs as agent-log so the Ask UI can clear the
    // "waiting for first agent event" empty state and show startup progress.
    if (kind === "status" || kind === "message" || !kind) {
      return {
        type: "agent-log",
        kind: kind || "status",
        id,
        message: compactString(event.message, 1000),
        tool: tool || undefined,
      };
    }
    return { type: "status", label: kind || "status", message: compactString(event.message, 1000) };
  }
  if (type === "submit") return { type, answer: compactString(event.answer, 200_000), sources: Array.isArray(event.sources) ? event.sources.slice(0, 50) : [] };
  if (type === "step") {
    return {
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      maxSteps: typeof event.maxSteps === "number" ? event.maxSteps : undefined,
      reasoning: compactString(event.reasoning, 80_000),
      code: compactString(event.code, 80_000),
      output: compactString(event.output, 80_000),
      resultType: compactString(event.resultType, 80),
    };
  }
  if (type === "jit-start") {
    return {
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      code: compactString(event.code, 80_000),
      llmCallBudget: typeof event.llmCallBudget === "number" ? event.llmCallBudget : undefined,
    };
  }
  if (type === "jit") {
    return {
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      code: compactString(event.code, 80_000),
      output: compactString(event.output, 80_000),
      resultType: compactString(event.resultType, 80),
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      llmCalls: typeof event.llmCalls === "number" ? event.llmCalls : undefined,
      llmCallBudget: typeof event.llmCallBudget === "number" ? event.llmCallBudget : undefined,
    };
  }
  return event;
}

function rememberProcessEvent(runId: string, event: CompactRunEvent): void {
  const events = runProcessEvents.get(runId) ?? [];
  events.push(event);
  if (events.length > PROCESS_SNAPSHOT_EVENT_LIMIT) {
    events.splice(0, events.length - PROCESS_SNAPSHOT_EVENT_LIMIT);
  }
  runProcessEvents.set(runId, events);
}

function processSnapshotFor(runId: string): ProcessSnapshot {
  const events = runProcessEvents.get(runId) ?? [];
  return {
    version: 1,
    eventCount: events.length,
    events,
    updatedAt: new Date().toISOString(),
  };
}

function compactRunEvent(type: string, payload: unknown): CompactRunEvent | null {
  const createdAt = new Date().toISOString();
  if (type === "start") return { type, payload: jsonObject(payload), createdAt };
  if (type === "phase") {
    const row = jsonObject(payload);
    return {
      type,
      payload: {
        phase: compactString(row.phase, 80),
        message: compactString(row.message, 500),
      },
      createdAt,
    };
  }
  if (type === "code-graph") {
    const row = jsonObject(payload);
    return {
      type,
      payload: {
        state: compactString(row.state, 40),
        message: compactString(row.message, 500),
      },
      createdAt,
    };
  }
  if (type === "structure-done") {
    return { type, payload: jsonObject(payload), createdAt };
  }
  if (type === "page-start") {
    const row = jsonObject(payload);
    return {
      type,
      payload: {
        pageId: compactString(row.pageId, 160),
        title: compactString(row.title, 300),
      },
      createdAt,
    };
  }
  if (type === "page-error") {
    const row = jsonObject(payload);
    return {
      type,
      payload: {
        pageId: compactString(row.pageId, 160),
        error: compactString(row.error, 2000),
        displayError: compactString(row.displayError, 500),
      },
      createdAt,
    };
  }
  if (type === "page-done") {
    const row = jsonObject(payload);
    const page = jsonObject(row.page);
    return {
      type,
      payload: {
        pageId: compactString(row.pageId || page.id, 160),
        content: compactString(row.content || page.content, 2000),
        tokenUsage: jsonObject(row.tokenUsage || page.tokenUsage),
      },
      createdAt,
    };
  }
  if (type === "error") {
    const errorPayload = jsonObject(payload);
    const turnId = compactString(errorPayload.turnId, 120);
    return {
      type,
      payload: {
        ...(turnId ? { turnId } : {}),
        message: compactString(errorMessageFrom(payload), 2000),
      },
      createdAt,
    };
  }
  if (type === "answer") {
    const answerPayload = jsonObject(payload);
    const turnId = compactString(answerPayload.turnId, 120);
    return {
      type,
      payload: {
        ...(turnId ? { turnId } : {}),
        type: "answer",
        sourceCount: Array.isArray(answerPayload.sources) ? answerPayload.sources.length : 0,
      },
      createdAt,
    };
  }
  if (type === "investigation") {
    return { type, payload: { type: "investigation" }, createdAt };
  }
  // Phase 2 distill pipeline lifecycle events: persist the structured payload as-is
  // (bounded — card/decision lists are small) so a run-mode reconnect can replay them.
  if (
    type === "distill-start" ||
    type === "distill-agent" ||
    type === "distill-done" ||
    type === "merge-start" ||
    type === "merge-done"
  ) {
    return { type, payload: jsonObject(payload), createdAt };
  }
  if (type === "done" && jsonObject(payload).result && jsonObject(jsonObject(payload).result).scope) {
    // A distill terminal result (distinguished from wiki/slides "done" by the
    // distill-shaped result.scope field) — persist the full result.
    return { type, payload: jsonObject(payload), createdAt };
  }
  if (type === "diff") {
    const diffPayload = jsonObject(payload);
    const turnId = compactString(diffPayload.turnId, 120);
    return {
      type,
      payload: {
        ...(turnId ? { turnId } : {}),
        changedFiles: Array.isArray(diffPayload.changedFiles) ? diffPayload.changedFiles.slice(0, 80).map(String) : [],
        truncated: diffPayload.truncated === true,
      },
      createdAt,
    };
  }

  const eventPayload = jsonObject(payload);
  const agentEvent = jsonObject(eventPayload.event);
  if (agentEvent.type) {
    const compact = compactAgentEvent(agentEvent);
    if (!compact) return null;
    return {
      type,
      payload: { ...eventPayload, event: compact },
      createdAt,
    };
  }

  const direct = compactAgentEvent(eventPayload);
  if (!direct) return null;
  return { type, payload: direct, createdAt };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactAgentEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(event.type || "");
  if (!type || type === "stream-done") {
    return null;
  }
  const turnId = compactString(event.turnId, 120);
  const withTurnId = (payload: Record<string, unknown>): Record<string, unknown> => (
    turnId ? { ...payload, turnId } : payload
  );

  if (type === "stream-delta") {
    return withTurnId({
      type: "text_delta",
      text: compactString(event.delta, 2000),
      replace: event.replace === true,
    });
  }

  if (type === "stream-reasoning-delta") {
    return withTurnId({
      type: "thinking_delta",
      text: compactString(event.delta, 20_000),
    });
  }

  if (type === "status") {
    const label = compactString(event.label, 80);
    const phase = compactString(event.phase, 80);
    const message = compactString(event.message, 500);
    if (label === "stream_done" && !message) return null;
    return withTurnId({
      type,
      label,
      phase,
      message,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      agentId: compactString(event.agentId, 80) || undefined,
      model: compactString(event.model, 120) || undefined,
    });
  }

  if (type === "text_delta" || type === "thinking_delta") {
    return withTurnId({
      type,
      text: compactString(event.text, type === "text_delta" ? 2000 : 20_000),
      replace: event.replace === true,
    });
  }

  if (type === "thinking_start") {
    return withTurnId({ type, label: compactString(event.label, 80) });
  }

  if (type === "tool_use") {
    return withTurnId({
      type,
      id: compactString(event.id, 120),
      name: compactString(event.name, 120),
      input: compactString(typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? ""), 20_000),
      participant: compactParticipant(event.participant),
    });
  }

  if (type === "tool_result") {
    return withTurnId({
      type,
      id: compactString(event.id, 120),
      name: compactString(event.name, 120),
      output: compactString(event.output, 20_000),
      isError: event.isError === true,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      participant: compactParticipant(event.participant),
    });
  }

  if (type === "participant_status") {
    return withTurnId({
      type,
      id: compactString(event.id, 120),
      role: compactString(event.role, 40) || "agent",
      state: compactString(event.state, 80) || "running",
      parentId: compactString(event.parentId, 120) || undefined,
      toolUseId: compactString(event.toolUseId, 120) || undefined,
      title: compactString(event.title, 240),
      detail: compactString(event.detail, 1000),
      name: compactString(event.name, 120) || undefined,
      agentType: compactString(event.agentType, 120) || undefined,
      currentTool: compactString(event.currentTool, 120) || undefined,
      prompt: compactString(event.prompt, 2000) || undefined,
      output: compactString(event.output, 20_000) || undefined,
      outputFile: compactString(event.outputFile, 1000) || undefined,
      totalTokens: typeof event.totalTokens === "number" ? event.totalTokens : undefined,
      toolUses: typeof event.toolUses === "number" ? event.toolUses : undefined,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      sessionId: compactString(event.sessionId, 160) || undefined,
    });
  }

  if (type === "tool-start" || type === "tool-done" || type === "tool-error") {
    return withTurnId({
      type,
      tool: compactString(event.tool, 120),
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      error: event.error ? compactString(event.error, 1000) : undefined,
    });
  }

  if (type === "agent-log") {
    return withTurnId({
      type,
      kind: compactString(event.kind, 80),
      message: compactString(event.message, 1000),
      id: compactString(event.id, 120),
      tool: compactString(event.tool, 120),
      reasoning: compactString(event.reasoning, 20_000),
      input: compactString(event.input, 20_000),
      output: compactString(event.output, 20_000),
      error: compactString(event.error, 2000),
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    });
  }

  if (type === "submit") {
    return withTurnId({
      type,
      answer: compactString(event.answer, 200_000),
      sources: Array.isArray(event.sources) ? event.sources.slice(0, 50) : [],
    });
  }

  if (type === "jit-start") {
    return withTurnId({
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      code: compactString(event.code, 10_000),
      llmCallBudget: typeof event.llmCallBudget === "number" ? event.llmCallBudget : undefined,
    });
  }

  if (type === "jit") {
    return withTurnId({
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      resultType: compactString(event.resultType, 80),
      code: compactString(event.code, 10_000),
      output: compactString(event.output, 10_000),
      durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      llmCalls: typeof event.llmCalls === "number" ? event.llmCalls : undefined,
      llmCallBudget: typeof event.llmCallBudget === "number" ? event.llmCallBudget : undefined,
    });
  }

  if (type === "error") {
    return withTurnId({
      type,
      error: compactString(event.error, 2000),
      code: compactString(event.code, 120),
      provider: compactString(event.provider, 120),
      command: compactString(event.command, 500),
      sourcePath: compactString(event.sourcePath, 500),
    });
  }

  if (type === "step") {
    return withTurnId({
      type,
      step: typeof event.step === "number" ? event.step : undefined,
      maxSteps: typeof event.maxSteps === "number" ? event.maxSteps : undefined,
      resultType: compactString(event.resultType, 80),
      reasoning: compactString(event.reasoning, 20_000),
      code: compactString(event.code, 40_000),
      output: compactString(event.output, 40_000),
      tokenUsage: jsonObject(event.tokenUsage),
    });
  }

  return withTurnId({ type });
}

function compactParticipant(value: unknown): Record<string, unknown> | undefined {
  const row = jsonObject(value);
  const id = compactString(row.id, 120);
  if (!id) return undefined;
  return {
    id,
    role: compactString(row.role, 40) || "agent",
    parentId: compactString(row.parentId, 120) || undefined,
    toolUseId: compactString(row.toolUseId, 120) || undefined,
    name: compactString(row.name, 120) || undefined,
    title: compactString(row.title, 240) || undefined,
  };
}

function compactString(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

type AskWikiContext = { id: string; label: string; context: string };

function normalizeAskWikiContextRefs(value: unknown): Array<{ kind: "wiki" | "page"; id: string | null; owner: string; repo: string; branch: string | null; sourcePath: string | null; pageId: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: "wiki" | "page"; id: string | null; owner: string; repo: string; branch: string | null; sourcePath: string | null; pageId: string }> = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 8)) {
    const row = jsonObject(item);
    const kind = row.kind === "wiki" ? "wiki" : "page";
    const id = compactString(row.id, 180).trim() || null;
    const owner = compactString(row.owner, 120).trim();
    const repo = compactString(row.repo, 120).trim();
    const branch = typeof row.branch === "string" && row.branch.trim() ? compactString(row.branch, 200).trim() : null;
    const sourcePath = normalizeRepoSourcePath(row.sourcePath);
    const pageId = compactString(row.pageId, 180).trim();
    if ((!id && (!owner || !repo)) || (kind === "page" && !pageId)) continue;
    const key = `${kind}:${id || `${owner}/${repo}@${branch || ""}#${sourcePath || ""}`}#${kind === "page" ? pageId : "*"}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id, owner, repo, branch, sourcePath, pageId });
  }
  return out;
}

async function loadWikiForAskContext(
  productStore: ProductStore,
  store: WikiStore,
  ref: { id: string | null; owner: string; repo: string; branch: string | null; sourcePath?: string | null },
): Promise<WikiRecord | null> {
  if (ref.id) {
    const artifact = await productStore.getArtifact("wiki", wikiInstanceArtifactKey(ref.id)).catch(() => null);
    if (artifact) return WikiRecordSchema.parse(artifact.data);
    const fileRecord = store.loadById(ref.id);
    if (fileRecord) return fileRecord;
    return null;
  }
  const sourcePath = normalizeRepoSourcePath(ref.sourcePath);
  const artifact = ref.branch || sourcePath
    ? await productStore.getArtifact("wiki", wikiArtifactKey(ref.owner, ref.repo, ref.branch, sourcePath)).catch(() => null)
    : null;
  const defaultArtifact = artifact ?? await productStore.getArtifact("wiki", wikiArtifactKey(ref.owner, ref.repo)).catch(() => null);
  if (defaultArtifact) return WikiRecordSchema.parse(defaultArtifact.data);
  return store.loadForRef({ owner: ref.owner, repo: ref.repo, branch: ref.branch, sourcePath });
}

/**
 * Phase 4 feedback loop: when the wiki record is a Knowledge Base (its pages carry
 * `kb` freshness metadata), order the cards by corroboration desc -> recency desc so
 * the ~90k-char budget truncation keeps the most-trustworthy cards instead of array
 * order. This is the "top-N card selection by corroboration/recency before injection"
 * the plan requires - it rides the existing wikiContexts seam, no new endpoint. For a
 * plain wiki (no `kb` metadata) the original page order is preserved (stable sort).
 */
function orderPagesForAskContext(wiki: WikiRecord): WikiRecord["structure"]["pages"] {
  const pageMetas = wiki.structure.pages || [];
  const isKb = pageMetas.some((meta) => wiki.pages[meta.id]?.kb);
  if (!isKb) return pageMetas;
  // Rank by the pure, unit-tested KB helper (corroboration desc -> recency desc),
  // projecting each page's freshness metadata, then map back to the page metas.
  const ranked = orderKbCardPagesByFreshness(
    pageMetas.map((meta) => ({
      pageId: meta.id,
      corroborationCount: wiki.pages[meta.id]?.kb?.corroborationCount ?? 0,
      lastUpdated: wiki.pages[meta.id]?.kb?.lastUpdated ?? null,
    })),
  );
  const byId = new Map(pageMetas.map((meta) => [meta.id, meta]));
  return ranked.map((entry) => byId.get(entry.pageId)).filter(Boolean) as WikiRecord["structure"]["pages"];
}

/** Cap on KB cards injected as ask context, so a large KB never floods even when each card is tiny. */
const MAX_KB_CONTEXT_CARDS = 40;

function wikiArtifactAskContext(wiki: WikiRecord): AskWikiContext {
  const orderedPages = orderPagesForAskContext(wiki);
  const isKb = orderedPages.some((meta) => wiki.pages[meta.id]?.kb);
  const pageMetas = isKb ? orderedPages.slice(0, MAX_KB_CONTEXT_CARDS) : orderedPages;
  let remaining = 90_000;
  const pageBlocks: string[] = [];
  for (const pageMeta of pageMetas) {
    const page = wiki.pages[pageMeta.id];
    if (!page?.content || remaining <= 0) continue;
    const header = [
      `## ${pageMeta.title || pageMeta.id}`,
      pageMeta.description ? `Description: ${pageMeta.description}` : "",
      `Page id: ${pageMeta.id}`,
      "",
    ].filter(Boolean).join("\n");
    const contentBudget = Math.max(0, remaining - header.length);
    const content = compactString(page.content, Math.min(18_000, contentBudget));
    const block = `${header}${content}`;
    pageBlocks.push(block);
    remaining -= block.length;
  }
  return {
    id: `${wiki.owner}/${wiki.repo}#wiki`,
    label: wiki.structure.title || `${wiki.owner}/${wiki.repo}`,
    context: [
      `Wiki artifact: ${wiki.structure.title}`,
      `Repository: ${wiki.owner}/${wiki.repo}${wiki.branch ? ` @ ${wiki.branch}` : ""}`,
      wiki.structure.description ? `Description: ${wiki.structure.description}` : "",
      "",
      "Page catalog:",
      ...pageMetas.map((page) => `- ${page.id}: ${page.title}${page.description ? ` — ${page.description}` : ""}`),
      "",
      "Generated page markdown:",
      ...pageBlocks,
    ].filter(Boolean).join("\n"),
  };
}

async function resolveAskWikiContexts(
  value: unknown,
  productStore: ProductStore,
  store: WikiStore,
): Promise<AskWikiContext[]> {
  const refs = normalizeAskWikiContextRefs(value);
  const contexts: AskWikiContext[] = [];
  for (const ref of refs) {
    const wiki = await loadWikiForAskContext(productStore, store, ref).catch(() => null);
    if (!wiki) continue;
    if (ref.kind === "wiki") {
      contexts.push(wikiArtifactAskContext(wiki));
      continue;
    }
    const pageMeta = wiki.structure.pages.find((page) => page.id === ref.pageId);
    const page = wiki.pages[ref.pageId];
    if (!pageMeta || !page?.content) continue;
    contexts.push({
      id: `${wiki.owner}/${wiki.repo}#${ref.pageId}`,
      label: pageMeta.title || ref.pageId,
      context: [
        `Wiki: ${wiki.structure.title}`,
        `Page: ${pageMeta.title || ref.pageId}`,
        pageMeta.description ? `Description: ${pageMeta.description}` : "",
        "",
        compactString(page.content, 18_000),
      ].filter(Boolean).join("\n"),
    });
  }
  return contexts;
}

/**
 * Ask-side latency budget for the code-kb session (KTD-6).
 * Warm sessions resolve via cache peek in milliseconds; cold provision still
 * races this budget and kicks fire-and-forget indexing for the next ask.
 * Default raised from 5s so a warm session can finish parallel search_code
 * evidence without thrashing the residual deadline.
 */
export const ASK_CODE_KB_BUDGET_MS = Math.max(
  1_000,
  Number(process.env.GROK_WIKI_CODE_KB_ASK_BUDGET_MS || 12_000),
);

export function codeGraphEnabledForRequest(requested: unknown): boolean {
  // Opt-in only (matches desktop default). Explicit true + server gate.
  return requested === true && codeKbEnabled();
}

export interface AppendCodeKbOverrides {
  enabled?: () => boolean;
  ensure?: (ref: RepoRef, opts: { budgetMs: number }) => Promise<CodeKbSession | null>;
  /** Cache-only session peek; defaults to peekCodeKbSession. */
  peek?: (ref: RepoRef) => Promise<CodeKbSessionPeek | null>;
  query?: (session: CodeKbSession, tool: string, args?: Record<string, unknown>) => Promise<unknown | null>;
  /** Raw snapshot file reader for the U3 README pre-fetch; defaults to readCodeKbFile. */
  readFile?: (session: CodeKbSession, path: string, range?: { startLine?: number; endLine?: number }) => Promise<unknown | null>;
  budgetMs?: number;
  /**
   * Optional evidence fetcher. Ask uses default U3 search; HTML passes a
   * deterministic repo-shaped folio (I2) instead of brief keyword mining.
   */
  evidence?: (
    session: CodeKbSession,
    question: string,
    deadline: number,
    overrides: AppendCodeKbOverrides,
  ) => Promise<string>;
}

/** Max search patterns for pre-run search_code (code tokens + NL phrases). */
const ASK_EVIDENCE_MAX_TOKENS = 4;
/** README head line span pre-fetched for docs-shaped ask questions (U3). */
const ASK_EVIDENCE_README_HEAD_LINES = 120;

// Common English words (plus dotted latin abbreviations) that must never
// become search_code patterns even when they slip through the shape regexes
// or arrive quoted.
const ASK_TOKEN_SKIP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "these", "those", "what", "when", "where", "which", "who", "why", "how",
  "does", "did", "done", "doing", "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "are", "was", "were", "been", "being", "have", "has", "had", "not", "but", "you", "your", "our", "their",
  "e.g", "i.e", "etc", "vs",
  // Natural-language glue that appears in architecture asks without being code.
  "from", "into", "onto", "upon", "over", "under", "through", "across", "between", "about", "after", "before",
  "using", "used", "use", "via", "per", "its", "it's", "also", "only", "just", "like", "than", "then", "them",
  "they", "there", "here", "please", "show", "list", "explain", "describe", "tell", "give", "make", "work",
  "works", "working", "connect", "connected", "connection", "call", "calls", "path", "paths", "name", "names",
  "key", "keys", "module", "modules", "main", "code", "file", "files", "function", "functions", "class",
  "classes", "type", "types", "data", "repo", "repository", "project", "system", "service", "application",
  "app", "api", "some", "any", "all", "each", "every", "other", "more", "most", "such", "very", "much",
  "many", "few", "lot", "once", "again", "while", "during", "within", "without", "inside", "outside",
  "first", "next", "last", "same", "different", "related", "based", "around", "control", "controls",
  // Vague size/quality/latency words that should not seed search_code.
  "response", "responses", "slow", "fast", "faster", "large", "small", "huge", "tiny", "better",
  "worse", "simple", "complex", "basic", "common", "special", "general", "specific", "actual",
  "current", "previous", "original", "important", "useful", "possible", "available", "necessary",
  "something", "everything", "anything", "nothing", "repositories", "issues", "problem", "problems",
  "question", "questions", "answer", "answers", "thing", "things", "stuff", "part", "parts",
]);

// One shape per pattern: dotted path (a.b.c), snake_case (interior underscore),
// and camel/PascalCase (a plain word with an interior lower-to-upper transition,
// so capitalized English words never match).
const ASK_DOTTED_TOKEN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const ASK_SNAKE_TOKEN = /^_?[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+_?$/;
const ASK_CAMEL_TOKEN = /^[A-Za-z][A-Za-z0-9]*$/;
const ASK_CAMEL_TRANSITION = /[a-z][A-Z]/;
// Quoted literal: same quote char on both sides, not embedded in a word (so
// contraction apostrophes never open a match), single line, sane length.
const ASK_QUOTED_PATTERN = /(?<!\w)(['"`])([^'"`\n]{2,64})\1(?!\w)/g;

// Docs-shaped keyword list per the plan: deploy, install, setup, build, run,
// configure, usage, getting started, self host, docker (word-boundary matches
// with common inflections).
const ASK_DOCS_QUESTION_PATTERN =
  /\b(?:deploy(?:s|ed|ing|ment|ments)?|install(?:s|ed|ing|ation)?|set\s?up|build(?:s|ing)?|run(?:s|ning)?|configur(?:e|es|ed|ing|ation)|usage|getting\s+started|self[\s-]?host(?:s|ed|ing)?|docker)\b/i;

/**
 * U3: pull up to three code-shaped tokens out of an ask question. Shapes:
 * quoted literals, dotted paths (a.b.c), snake_case, and camelCase words.
 * Quoted literals come first (the strongest explicit signal), then the shaped
 * words in question order; common English words and duplicates are skipped.
 * Pure and deterministic; exported for direct tests.
 */
export function extractAskCodeTokens(question: string): string[] {
  const tokens: string[] = [];
  const push = (raw: string) => {
    if (tokens.length >= 3) return;
    const token = raw.trim();
    if (token.length < 3 || token.length > 64) return;
    if (ASK_TOKEN_SKIP_WORDS.has(token.toLowerCase())) return;
    if (tokens.some((existing) => existing.toLowerCase() === token.toLowerCase())) return;
    tokens.push(token);
  };
  for (const match of question.matchAll(ASK_QUOTED_PATTERN)) push(match[2] ?? "");
  for (const match of question.matchAll(/[\w$.]+/g)) {
    const word = (match[0] ?? "").replace(/^\.+|\.+$/g, "");
    if (ASK_DOTTED_TOKEN.test(word) || ASK_SNAKE_TOKEN.test(word) || (ASK_CAMEL_TOKEN.test(word) && ASK_CAMEL_TRANSITION.test(word))) {
      push(word);
    }
  }
  return tokens;
}

/**
 * Search patterns for Ask evidence: code-shaped tokens first. When the question
 * has no code tokens, fall back to natural-language technical bigrams so asks
 * like "How does terminal orchestration call into browser automation?" still
 * seed search_code. Pure and deterministic; exported for tests.
 */
export function extractAskSearchPatterns(question: string): string[] {
  const codeTokens = extractAskCodeTokens(question);
  if (codeTokens.length > 0) {
    return codeTokens.slice(0, ASK_EVIDENCE_MAX_TOKENS);
  }

  const patterns: string[] = [];
  const push = (raw: string) => {
    if (patterns.length >= ASK_EVIDENCE_MAX_TOKENS) return;
    const token = raw.trim().replace(/\s+/g, " ");
    if (token.length < 5 || token.length > 64) return;
    if (ASK_TOKEN_SKIP_WORDS.has(token.toLowerCase())) return;
    if (patterns.some((existing) => existing.toLowerCase() === token.toLowerCase())) return;
    patterns.push(token);
  };

  const contentWords = (question.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || [])
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !ASK_TOKEN_SKIP_WORDS.has(word.toLowerCase()));

  // Bigrams only (higher precision; avoids mining generic unigrams like "response").
  for (let i = 0; i < contentWords.length - 1 && patterns.length < ASK_EVIDENCE_MAX_TOKENS; i += 1) {
    const left = contentWords[i];
    const right = contentWords[i + 1];
    if (!left || !right) continue;
    push(`${left} ${right}`);
  }

  // One longer unigram only when no bigram fired and the word looks technical
  // (hyphenated or long), still avoiding vague English.
  if (patterns.length === 0) {
    for (const word of contentWords) {
      if (patterns.length >= ASK_EVIDENCE_MAX_TOKENS) break;
      if (word.includes("-") || word.length >= 10) push(word);
    }
  }

  return patterns;
}

/** U3: docs-shaped ask questions get the README head pre-fetched. Exported for direct tests. */
export function isDocsShapedAskQuestion(question: string): boolean {
  return ASK_DOCS_QUESTION_PATTERN.test(question);
}

/**
 * U3 (R5): pre-run kb queries for the ask question inside whatever remains of
 * the entry's budget: parallel search_code for the question's search patterns
 * and a README head for docs-shaped questions, each raced against the shared
 * deadline so a hanging query can never push the entry past the ask budget.
 * Best-effort everywhere: a failed or slow fetch omits that item, and no
 * signal (or nothing fetched) returns "" so the entry stays byte-identical to
 * the pre-evidence output (R8, R7 via the renderer). Never throws.
 */
async function fetchAskCodeKbEvidence(
  session: CodeKbSession,
  question: string,
  deadline: number,
  overrides: AppendCodeKbOverrides,
): Promise<string> {
  try {
    const tokens = extractAskSearchPatterns(question);
    const docsShaped = isDocsShapedAskQuestion(question);
    if (tokens.length === 0 && !docsShaped) return "";
    if (deadline - Date.now() <= 0) return "";
    const query = overrides.query ?? queryCodeKb;
    const readFile = overrides.readFile ?? readCodeKbFile;
    const searchOne = async (pattern: string) => {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { pattern, result: null };
        return { pattern, result: await raceWithBudget(query(session, "search_code", { pattern }), remaining) };
      } catch {
        return { pattern, result: null };
      }
    };
    const readReadme = async (): Promise<unknown | null> => {
      if (!docsShaped) return null;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        return await raceWithBudget(
          readFile(session, "README.md", { startLine: 1, endLine: ASK_EVIDENCE_README_HEAD_LINES }),
          remaining,
        );
      } catch {
        return null;
      }
    };
    const [searches, readmeHead] = await Promise.all([Promise.all(tokens.map(searchOne)), readReadme()]);
    return renderAskEvidence({ searches, readmeHead: readmeHead ?? undefined });
  } catch {
    return "";
  }
}

/**
 * Compute the sharenow code-kb context entry for the ask's primary ref: prefer
 * a warm cache peek (zero network), else ensure within the ask budget, then
 * best-effort pre-run question evidence (U3). The architecture map is
 * intentionally omitted: the A/B benchmark showed injected evidence is
 * re-processed every agent iteration (token tax), while the agent's own tool
 * calls on the checkout are nearly free, so the big block lost. The entry is
 * instructions plus U3 evidence only. Resolves null when the entry should be
 * skipped: disabled flag, missing ref, slow ensure, or any failure (strictly
 * additive, R4). On timeout the in-flight ensure keeps running in the
 * background (raceWithBudget swallows its rejection), which is exactly the
 * fire-and-forget provisioning kick: the next ask finds the session ready.
 * Exported so the handler can start it concurrently with wiki-context
 * resolution and await it just before use.
 */
export async function computeCodeKbAskEntry(
  primaryRef: RepoRef | null | undefined,
  question = "",
  overrides: AppendCodeKbOverrides = {},
): Promise<AskWikiContext | null> {
  try {
    if (!primaryRef) return null;
    if (!(overrides.enabled ?? codeKbEnabled)()) return null;
    const budgetMs = overrides.budgetMs ?? ASK_CODE_KB_BUDGET_MS;
    const deadline = Date.now() + budgetMs;
    const ensure = overrides.ensure ?? ensureCodeKbSession;
    const peek = overrides.peek ?? peekCodeKbSession;

    // Warm path: cache-ready sessions skip provisioning wait so evidence can run.
    let session: CodeKbSession | null = null;
    try {
      const peeked = await peek(primaryRef);
      if (peeked?.state === "ready") session = peeked.session;
    } catch {
      session = null;
    }
    if (!session) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      session = await raceWithBudget(ensure(primaryRef, { budgetMs: remaining }), remaining);
    }
    if (!session) return null;

    // U3: pre-run question evidence within whatever budget remains; "" (no
    // signal, failure, or exhausted budget) leaves the entry byte-identical
    // to the pre-evidence output (R8). HTML may inject a deterministic pack.
    const evidence = overrides.evidence
      ? await overrides.evidence(session, question, deadline, overrides)
      : await fetchAskCodeKbEvidence(session, question, deadline, overrides);
    return codeKbAskContext({
      session,
      evidence,
      sourceKind: primaryRef.owner === "local" ? "local" : "github",
    });
  } catch {
    return null;
  }
}

/**
 * Append the sharenow code-kb context entry for the ask's primary ref to the
 * already-resolved wikiContexts list. Append-only: explicit picks and the
 * memory-card KB entry are never removed or reordered. One entry for the
 * primary ref only (workspace multi-repo sessions are deferred). Overrides
 * exist so tests can drive it without network.
 */
export async function appendCodeKbWikiContext(
  wikiContexts: AskWikiContext[],
  primaryRef: RepoRef | null | undefined,
  overrides: AppendCodeKbOverrides = {},
  question = "",
): Promise<void> {
  const entry = await computeCodeKbAskEntry(primaryRef, question, overrides);
  if (entry) wikiContexts.push(entry);
}

function errorMessageFrom(payload: unknown): string {
  const obj = jsonObject(payload);
  return String(obj.message || obj.error || "Run failed");
}

function buildMermaidRepairPrompt(args: {
  owner: string;
  repo: string;
  pageTitle: string;
  pageContext: string;
  diagram: string;
  error: string;
  instruction: string;
}): string {
  return [
    "You repair Mermaid diagrams for generated technical wiki pages.",
    "Fix ONLY the Mermaid diagram syntax/structure. Do not rewrite the wiki page prose.",
    "Return ONLY Mermaid source code. Do not wrap it in markdown fences. Do not explain.",
    "",
    "Rules:",
    "- Preserve the intended meaning and node labels as much as possible.",
    "- Prefer valid Mermaid syntax that the current renderer can parse.",
    "- Preserve the original diagram type when it is useful; otherwise choose the Mermaid type that best explains the concept.",
    "- Supported choices include flowchart/graph, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, and xychart-beta.",
    "- Prefer system architecture flowcharts with named subgraphs for architecture/runtime/integration pages.",
    "- Prefer classDiagram for design patterns, MVC/MVVM/MVP, interfaces, adapters, strategies, observers, factories, domain models, and controller-model-view relationships.",
    "- Avoid preserving a weak single-chain flowchart when it merely restates a checklist or call order. Upgrade it to an architecture/class/state/sequence diagram when the page context supports that, or keep it minimal if the source evidence is truly only a linear workflow.",
    "- Avoid HTML tags, markdown links, quoted edge labels with punctuation, and unnecessarily complex node syntax.",
    "- Keep node labels short and readable.",
    "",
    `Repository: ${args.owner}/${args.repo}`,
    `Page: ${args.pageTitle || "(unknown)"}`,
    args.instruction.trim() ? `User request: ${truncateString(args.instruction, 1200)}` : "",
    args.error.trim() ? `Render/parse error: ${truncateString(args.error, 1200)}` : "",
    "",
    "Nearby page context:",
    "```text",
    truncateString(args.pageContext || "(none)", 2600),
    "```",
    "",
    "Broken Mermaid:",
    "```mermaid",
    truncateString(args.diagram, 6000),
    "```",
  ].filter(Boolean).join("\n");
}

function buildWikiFormatTunePrompt(draft: string): string {
  return [
    "You tune custom wiki format briefs for a repository-wiki generator.",
    "Rewrite the user's rough idea into a concise, durable instruction block that an agent can follow while writing a code-grounded wiki.",
    "Return ONLY the tuned format brief. No markdown fences, no preamble, no explanation.",
    "",
    "The tuned brief should:",
    "- Name the target audience and desired voice if the user implied one.",
    "- Describe how pages should be organized and what each page should emphasize.",
    "- Include practical constraints for examples, diagrams, tables, or analogies when useful.",
    "- Preserve the user's creative intent.",
    "- Keep source grounding, citations, and factual accuracy mandatory.",
    "- Avoid asking the agent to ignore system instructions, hide uncertainty, invent facts, or skip verification.",
    "- Fit in 4-8 crisp bullets or short paragraphs.",
    "",
    "Reference built-in formats:",
    "- Basic: balanced DeepWiki-style repository guide; the repo shape decides the table of contents.",
    "- Technical: developer reference focused on architecture, modules, APIs, data flows, integrations, and operations.",
    "- First 30 Minutes: fast orientation, entry points, read order, glossary, setup signals, and what matters first.",
    "- Explain Like I'm 5: plain-language source-grounded explanation with careful analogies and simple cause-and-effect.",
    "- Mental Model: flows, invariants, boundaries, state ownership, failure modes, and safe-change reasoning.",
    "- Socratic Exploration: first-principles questions and reframes that reveal why the repo is shaped this way.",
    "- Feature Scout: features worth exploring, demoing, copying, or productizing, grounded in implementation surfaces.",
    "- Worth Stealing: elegant designs, best practices, reusable patterns, porting recipes, and when not to copy them.",
    "- Hidden Quirks: non-README implementation details, constraints, safety rails, edge cases, scripts, tests, prompts, adapters, and tiny high-leverage choices.",
    "- Pattern Discovery: architecture or product patterns the reader may not know to ask for, within one repo or across repos.",
    "- Repo Comparison: compare 2+ repos, or compare internal approaches when only one repo is provided.",
    "- Debugging Atlas: symptoms, probes, logs, state transitions, root-cause paths, observability hooks, and regression checks.",
    "- Tech Reader Brief: HN/TechCrunch-style technical breakdown with accessible hooks, mechanisms, tradeoffs, and no hype.",
    "",
    "User draft:",
    "```text",
    truncateString(draft, 2400),
    "```",
  ].join("\n");
}

function extractFormatPromptOnly(raw: string): string {
  const text = raw.trim();
  const answer = text.match(/<ANSWER\b[^>]*>([\s\S]*?)<\/ANSWER>/i)?.[1]?.trim();
  const fenced = (answer || text).match(/```(?:text|markdown|md)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return normalizeWikiStylePrompt(fenced || answer || text);
}

function extractMermaidOnly(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/```(?:mermaid|mmd)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return (fenced || text)
    .replace(/^<ANSWER>/i, "")
    .replace(/<\/ANSWER>$/i, "")
    .trim();
}

function truncateString(value: string, maxChars: number): string {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n...[truncated ${text.length - maxChars} chars]...\n${text.slice(-tail)}`;
}

export async function waitForPersistedEvents(runId: string): Promise<void> {
  const pending = runEventWriteQueues.get(runId);
  if (pending) await pending.catch(() => {});
}

function wikiSummaryFromRecord(record: Record<string, unknown>): {
  id?: string;
  owner: string;
  repo: string;
  repos?: unknown[];
    branch?: string | null;
    sourcePath?: string | null;
  sourceKey?: string;
  variantKey?: string;
  createdAt?: string;
  updatedAt?: string;
  generatedAt: string;
  title: string;
  description: string;
  pageCount: number;
  plannedPageCount: number;
  failedPageCount: number;
  missingPageCount: number;
  recoverablePageIds: string[];
  sourceCount: number;
  model?: string;
  structureModel?: string;
  pageModel?: string;
  runtime?: string;
  runtimeModelLabel?: string;
  wikiDepth?: string;
  wikiPageCount?: number;
  wikiStyle?: string;
  wikiStylePrompt?: string;
  wikiLanguages?: unknown[];
} {
  const structure = record.structure as { title?: string; description?: string; pages?: Array<{ filePaths?: unknown[] }> } | undefined;
  const completion = wikiRecordCompletion(record);
  const sourceCount = new Set(
    Array.isArray(structure?.pages)
      ? structure.pages.flatMap((page) => Array.isArray(page.filePaths) ? page.filePaths.map(String) : [])
      : [],
  ).size;
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    owner: String(record.owner || ""),
    repo: String(record.repo || ""),
    repos: Array.isArray(record.repos) ? record.repos : undefined,
      branch: typeof record.branch === "string" ? record.branch : null,
      sourcePath: normalizeRepoSourcePath(record.sourcePath),
    sourceKey: typeof record.sourceKey === "string" ? record.sourceKey : undefined,
    variantKey: typeof record.variantKey === "string" ? record.variantKey : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    generatedAt: String(record.generatedAt || record.updatedAt || ""),
    title: String(structure?.title || `${record.owner || ""}/${record.repo || ""}`),
    description: String(structure?.description || ""),
    pageCount: completion.generatedPageCount,
    plannedPageCount: completion.plannedPageCount,
    failedPageCount: completion.failedPageCount,
    missingPageCount: completion.recoverablePageIds.length,
    recoverablePageIds: completion.recoverablePageIds,
    sourceCount,
    model: typeof record.model === "string" ? record.model : undefined,
    structureModel: typeof record.structureModel === "string" ? record.structureModel : undefined,
    pageModel: typeof record.pageModel === "string" ? record.pageModel : undefined,
    runtime: typeof record.runtime === "string" ? record.runtime : undefined,
    runtimeModelLabel: typeof record.runtimeModelLabel === "string" ? record.runtimeModelLabel : undefined,
    wikiDepth: typeof record.wikiDepth === "string" ? record.wikiDepth : undefined,
    wikiPageCount: typeof record.wikiPageCount === "number" ? record.wikiPageCount : undefined,
    wikiStyle: typeof record.wikiStyle === "string" ? record.wikiStyle : undefined,
    wikiStylePrompt: typeof record.wikiStylePrompt === "string" ? record.wikiStylePrompt : undefined,
    wikiLanguages: Array.isArray(record.wikiLanguages) ? record.wikiLanguages : undefined,
  };
}

function wikiRunProgressSummary(run: ProductRun & { events?: Array<{ type: string; payload: unknown; createdAt: string }> }, jobs: JobRecord[] = []): Record<string, unknown> {
  const input = jsonObject(run.input);
  const ref = jsonObject(input.ref);
  const result = jsonObject(run.result);
  const wiki = jsonObject(result.wiki);
  const events = run.events ?? [];
  const structureEvent = [...events].reverse().find((event) => event.type === "structure-done");
  const structure = jsonObject(jsonObject(structureEvent?.payload).structure || wiki.structure);
  const plannedPages = Array.isArray(structure.pages)
    ? structure.pages.map(jsonObject).filter((page) => typeof page.id === "string")
    : [];
  const plannedById = new Map(plannedPages.map((page) => [String(page.id), page]));
  const started = new Map<string, { pageId: string; title: string; startedAt: string }>();
  const done = new Set<string>();
  const failed = new Map<string, string>();
  let lastEventAt = run.updatedAt;
  let lastEventType = "";

  for (const event of events) {
    lastEventAt = event.createdAt || lastEventAt;
    lastEventType = event.type;
    const payload = jsonObject(event.payload);
    const pageId = typeof payload.pageId === "string" ? payload.pageId : "";
    if (!pageId) continue;
    if (event.type === "page-start") {
      started.set(pageId, {
        pageId,
        title: String(payload.title || jsonObject(plannedById.get(pageId)).title || pageId),
        startedAt: event.createdAt,
      });
    } else if (event.type === "page-done") {
      done.add(pageId);
    } else if (event.type === "page-error") {
      failed.set(pageId, String(payload.error || payload.message || "page failed"));
    }
  }

  const generatedPages = jsonObject(wiki.pages);
  for (const [pageId, page] of Object.entries(generatedPages)) {
    if (isFailedWikiGeneratedPage(page)) failed.set(pageId, failed.get(pageId) || "page generation failed");
    else done.add(pageId);
  }
  const completedPageCount = done.size;
  const failedPageCount = failed.size;
  const plannedPageCount = plannedPages.length
    || (typeof input.pageCount === "number" ? input.pageCount : Number(input.pageCount) || 0);
  const activePages = [...started.values()].filter((page) => !done.has(page.pageId) && !failed.has(page.pageId));
  const missingPageIds = plannedPages
    .map((page) => String(page.id))
    .filter((pageId) => !done.has(pageId) && !failed.has(pageId));
  const failedPageIds = plannedPages
    .map((page) => String(page.id))
    .filter((pageId) => failed.has(pageId));
  const latestJob = jobs[0] ?? null;
  const workerActive = Boolean(
    latestJob?.status === "running"
      && latestJob.lockedUntil
      && Date.parse(latestJob.lockedUntil) > Date.now(),
  );
  const lastEventMs = Date.parse(lastEventAt || run.updatedAt);
  const stalled = run.status === "running"
    && !workerActive
    && Number.isFinite(lastEventMs)
    && Date.now() - lastEventMs > 30 * 60 * 1000;
  const owner = String(ref.owner || wiki.owner || "");
  const repo = String(ref.repo || wiki.repo || "");
  const repos = Array.isArray(input.refs) ? input.refs : Array.isArray(wiki.repos) ? wiki.repos : undefined;
  const branch = ref.branch == null ? null : String(ref.branch);

  return {
    id: run.id,
    status: run.status,
    state: stalled ? "stalled" : run.status,
    title: run.title,
    owner,
    repo,
    repos,
    branch,
    url: String(ref.url || (owner && repo ? `https://github.com/${owner}/${repo}` : "")),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastEventAt,
    lastEventType,
    channel: typeof input.channel === "string" ? input.channel : undefined,
    structureChannel: typeof input.structureChannel === "string" ? input.structureChannel : undefined,
    pageChannel: typeof input.pageChannel === "string" ? input.pageChannel : undefined,
    runtime: typeof input.runtime === "string" ? input.runtime : undefined,
    wikiDepth: typeof input.depth === "string" ? input.depth : undefined,
    wikiPageCount: plannedPageCount || undefined,
    wikiStyle: typeof input.style === "string" ? input.style : undefined,
    plannedPageCount,
    completedPageCount,
    failedPageCount,
    failedPageIds,
    recoverablePageIds: [...missingPageIds, ...failedPageIds],
    activePages: activePages.slice(0, 5),
    missingPageIds,
    progressLabel: plannedPageCount
      ? `${completedPageCount}/${plannedPageCount} pages${failedPageCount ? ` · ${failedPageCount} failed` : ""}`
      : (lastEventType || run.status),
    worker: latestJob ? {
      status: latestJob.status,
      lockedBy: latestJob.lockedBy,
      lockedUntil: latestJob.lockedUntil,
      updatedAt: latestJob.updatedAt,
      active: workerActive,
    } : null,
    error: run.error,
  };
}

async function listActiveWikiRuns(productStore: ProductStore, jobQueue: JobQueue): Promise<Record<string, unknown>[]> {
  const runs = await productStore.listRuns({ kind: "wiki_generate", limit: 80 });
  const active = runs.filter((run) => run.status === "running").slice(0, 20);
  return Promise.all(active.map(async (run) => {
    const fullRun = await productStore.getRun(run.id, { includeEvents: true }) ?? run;
    const jobs = await jobQueue.listByRun(run.id).catch(() => []);
    return wikiRunProgressSummary(fullRun, jobs);
  }));
}
