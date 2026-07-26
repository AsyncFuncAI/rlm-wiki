import { join } from "node:path";
import { codeAnything, normalizeCodeAnythingAgent } from "./code-anything.ts";
import { capabilityRuntime, saveCapabilitySettings, type CapabilitySettings } from "./agent-capabilities.ts";
import { normalizeAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { friendlyWikiGenerationError, generateWiki, normalizeWikiGenerationRuntime, regenerateWikiPage, type GenerationEvent } from "./generator.ts";
import { createJobQueue, type JobQueue, type JobRecord } from "./job-queue.ts";
import {
  createProductStore,
  wikiArtifactKey,
  wikiInstanceArtifactKey,
  wikiRecordArtifactKey,
  type ProductRun,
  type ProductStore,
} from "./persistence.ts";
import { redactProviderSecrets, type ProviderSecrets } from "./provider-secrets.ts";
import { createSecretGrantStore, type SecretGrantStore } from "./secret-grants.ts";
import { codeKbEnabled } from "./sharenow-kb-client.ts";
import { WikiStore } from "./storage.ts";
import { normalizeRepoSourcePath, wikiRefForWorkspace, WikiRecordSchema, type GeneratedPage, type WikiRecord, type WorkspaceRepoRef } from "./types.ts";
import { normalizeWikiLanguages, type WikiLanguage } from "./wiki-options.ts";
import { ensureWikiRecordIdentity } from "./wiki-identity.ts";
import type { CapabilityProfileOptions, CapabilitySnapshot } from "./agent-capabilities.ts";

const CAPABILITY_SETTINGS_ARTIFACT_KIND = "capability_settings";
const CAPABILITY_SETTINGS_ARTIFACT_KEY = "default";
const WIKI_DRAFT_ARTIFACT_KIND = "wiki_draft";
const DEFAULT_WORKER_POLL_MS = Math.max(250, Number(process.env.RLM_WIKI_WORKER_POLL_MS || 1_000));
const DEFAULT_WORKER_LOCK_MS = Math.max(10_000, Number(process.env.RLM_WIKI_JOB_LOCK_MS || 60_000));
const MAX_BATCH_REGENERATE_PAGES = 50;

interface WorkerOptions {
  once?: boolean;
  pollMs?: number;
  workerId?: string;
  /** Exact job id to claim once (Unikraft one-shot dispatch). */
  jobId?: string;
}

interface PublicRepoRef {
  id?: string;
  owner: string;
  repo: string;
  label?: string;
  url: string;
  branch: string | null;
  sourcePath?: string | null;
}

interface CodeWorkerPayload {
  action: "code.publish-boundary" | "code.initial";
  turnId: string;
  startedAt: string;
  ref: PublicRepoRef;
  refs?: WorkspaceRepoRef[];
  task: string;
  displayTask?: string;
  handoff?: Record<string, string | number | boolean>;
  channel: string;
  runtime: AgentRuntime;
  agent: string;
  screenshots?: unknown;
  maxIterations?: number;
  capabilities?: CapabilitySnapshot;
  secretGrantId?: string;
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

interface WikiWorkerPayload {
  action: "wiki.generate" | "wiki.page.regenerate" | "wiki.pages.regenerate";
  ref?: PublicRepoRef;
  refs?: WorkspaceRepoRef[];
  id?: string | null;
    owner?: string;
    repo?: string;
    branch?: string | null;
    sourcePath?: string | null;
  pageId?: string;
  pageIds?: string[];
  pageTitle?: string;
  channel: string;
  structureChannel?: string;
  pageChannel?: string;
  runtime: AgentRuntime;
  localCli?: unknown;
  concurrency?: number;
  depth?: string;
  pageCount?: number;
  pageCountMode?: string;
  style?: string;
  stylePrompt?: string;
  languages?: WikiLanguage[];
  knowledgeProfile?: unknown;
  codeGraphEnabled: boolean;
  stylePromptOverride?: boolean;
  instruction?: string;
  secretGrantId?: string;
}

interface WorkerProcessEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function startWorker(opts: WorkerOptions = {}): Promise<void> {
  const baseStore = new WikiStore();
  const jobQueue = await createJobQueue(baseStore.root);
  const secretGrantStore = await createSecretGrantStore(baseStore.root);
  const workerId = (opts.workerId || process.env.RLM_WIKI_WORKER_ID || `worker-${crypto.randomUUID().slice(0, 8)}`).slice(0, 80);
  const pollMs = opts.pollMs ?? DEFAULT_WORKER_POLL_MS;
  const startedAt = new Date().toISOString();
  const exactJobId = (opts.jobId || process.env.RLM_WIKI_JOB_ID || "").trim();

  console.log(`rlm-wiki worker starting as ${workerId}`);
  console.log(`  Storage: ${baseStore.root}`);
  console.log(`  Queue:   ${jobQueue.mode}`);
  console.log(`  Secrets: ${secretGrantStore.mode}`);
  if (exactJobId) console.log(`  Job:     ${exactJobId}`);
  startWorkerHealthServer({ jobQueue, secretGrantStore, workerId, pollMs, startedAt, once: opts.once === true || Boolean(exactJobId) });

  // One-shot exact claim path used by Unikraft microVMs (Fable/Claudex: never claimNext in the VM).
  if (exactJobId) {
    const job = await jobQueue.claim(exactJobId, {
      workerId,
      lockMs: DEFAULT_WORKER_LOCK_MS,
    });
    if (!job) {
      throw new Error(`Could not claim assigned job ${exactJobId}`);
    }
    await executeClaimedJob({
      baseStore,
      jobQueue,
      secretGrantStore,
      workerId,
      job,
    });
    return;
  }

  while (true) {
    const job = await jobQueue.claimNext({
      workerId,
      types: ["run.code", "run.wiki_generate"],
      lockMs: DEFAULT_WORKER_LOCK_MS,
    });
    if (!job) {
      if (opts.once) return;
      await sleep(pollMs);
      continue;
    }

    await executeClaimedJob({
      baseStore,
      jobQueue,
      secretGrantStore,
      workerId,
      job,
    });

    if (opts.once) return;
  }
}

function startWorkerHealthServer(args: {
  jobQueue: JobQueue;
  secretGrantStore: SecretGrantStore;
  workerId: string;
  pollMs: number;
  startedAt: string;
  once: boolean;
}): void {
  const port = workerHealthPort(args.once);
  if (!port) return;
  const hostname = process.env.HOST || "0.0.0.0";
  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/health" && url.pathname !== "/health") {
        return new Response("not found", { status: 404 });
      }
      const [queue, secretGrants] = await Promise.all([
        args.jobQueue.stats().catch((error) => ({
          mode: args.jobQueue.mode,
          error: error instanceof Error ? error.message : String(error),
        })),
        args.secretGrantStore.stats().catch((error) => ({
          mode: args.secretGrantStore.mode,
          configured: args.secretGrantStore.configured,
          error: error instanceof Error ? error.message : String(error),
        })),
      ]);
      return Response.json({
        ok: true,
        role: "worker",
        workerId: args.workerId,
        startedAt: args.startedAt,
        queue,
        secretGrants,
        pollMs: args.pollMs,
        lockMs: DEFAULT_WORKER_LOCK_MS,
      });
    },
  });
  console.log(`  Health: http://${hostname}:${server.port}/api/health`);
}

function workerHealthPort(once: boolean): number | null {
  if (once) return null;
  if (process.env.RLM_WIKI_WORKER_HEALTH === "0" || process.env.RLM_WIKI_WORKER_HEALTH === "false") {
    return null;
  }
  const raw = process.env.RLM_WIKI_WORKER_HEALTH_PORT || process.env.PORT;
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function executeClaimedJob(args: {
  baseStore: WikiStore;
  jobQueue: JobQueue;
  secretGrantStore: SecretGrantStore;
  workerId: string;
  job: JobRecord;
}): Promise<void> {
  const productStore = await createProductStore(
    join(args.baseStore.root, "users", args.job.ownerUserId),
    { ownerUserId: args.job.ownerUserId },
  );
  const runId = args.job.runId || String(args.job.payload.runId || "");
  const run = runId ? await productStore.getRun(runId) : null;
  if (!run) {
    await args.jobQueue.fail(args.job.id, args.workerId, "Run not found");
    return;
  }

  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    args.jobQueue.heartbeat(args.job.id, args.workerId, DEFAULT_WORKER_LOCK_MS)
      .then((row) => {
        // null means the job is no longer running under this worker (cancel / reclaim).
        if (!row && !abort.signal.aborted) {
          console.warn(`[worker] heartbeat lost ownership of ${args.job.id}; aborting`);
          abort.abort();
        }
      })
      .catch((error) => {
        console.warn(`[worker] heartbeat failed for ${args.job.id}:`, error instanceof Error ? error.message : error);
      });
  }, Math.max(5_000, Math.floor(DEFAULT_WORKER_LOCK_MS / 3)));

  try {
    if (abort.signal.aborted) throw new DOMException("Stopped by cancel.", "AbortError");
    if (args.job.type === "run.code") {
      await executeCodeJob({
        baseRoot: args.baseStore.root,
        productStore,
        secretGrantStore: args.secretGrantStore,
        ownerUserId: args.job.ownerUserId,
        run,
        payload: args.job.payload,
        signal: abort.signal,
      });
    } else if (args.job.type === "run.wiki_generate") {
      await executeWikiJob({
        baseRoot: args.baseStore.root,
        productStore,
        secretGrantStore: args.secretGrantStore,
        ownerUserId: args.job.ownerUserId,
        run,
        payload: args.job.payload,
        signal: abort.signal,
      });
    } else {
      throw new Error(`Unsupported job type: ${args.job.type}`);
    }
    await args.jobQueue.complete(args.job.id, args.workerId);
    await revokeGrantFromPayload(args.secretGrantStore, args.job.ownerUserId, args.job.payload, "worker completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const canceled = abort.signal.aborted || (error instanceof Error && error.name === "AbortError");
    await productStore.appendEvent(run.id, "error", { message }).catch(() => null);
    await productStore.updateRun(run.id, {
      status: canceled ? "canceled" : "error",
      error: message,
    }).catch(() => null);
    if (canceled) {
      await args.jobQueue.cancel(args.job.id, message).catch(() => null);
    } else {
      await args.jobQueue.fail(args.job.id, args.workerId, message).catch(() => null);
    }
    await revokeGrantFromPayload(args.secretGrantStore, args.job.ownerUserId, args.job.payload, canceled ? "worker canceled" : "worker failed").catch(() => false);
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeCodeJob(args: {
  baseRoot: string;
  productStore: ProductStore;
  secretGrantStore: SecretGrantStore;
  ownerUserId: string;
  run: ProductRun;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  const payload = normalizeCodePayload(args.payload);
  const store = new WikiStore(join(args.baseRoot, "users", args.ownerUserId));
  const profile = { defaultUserId: args.ownerUserId };
  await hydrateCapabilitySettingsCache(store.root, args.productStore, profile);
  const runtimeCapabilities = await capabilityRuntime(store.root, profile);
  const providerSecrets = await providerSecretsForJob(args.secretGrantStore, args.ownerUserId, payload);

  await appendRunEvent(args.productStore, args.run.id, "start", {
    runId: args.run.id,
    turnId: payload.turnId,
    owner: payload.ref.owner,
    repo: payload.ref.repo,
        url: payload.ref.url,
        branch: payload.ref.branch,
        sourcePath: payload.ref.sourcePath ?? null,
    task: payload.task,
    displayTask: payload.displayTask,
    handoff: payload.handoff,
    channel: payload.channel,
    runtime: payload.runtime,
    agent: payload.agent,
    capabilities: runtimeCapabilities.snapshot,
    worker: true,
    publishBlocked: payload.action === "code.publish-boundary" ? true : undefined,
  });

  if (payload.action === "code.publish-boundary") {
    const answer = buildPrBoundaryAnswer({ task: payload.task, ref: payload.ref, changedFiles: [] });
    const turn: CodeSessionTurn = {
      id: payload.turnId,
      task: payload.task,
      displayTask: payload.displayTask,
      handoff: payload.handoff,
      status: "done",
      channel: payload.channel,
      runtime: payload.runtime,
      agent: payload.agent,
      startedAt: payload.startedAt,
      completedAt: new Date().toISOString(),
      answer,
      sources: [],
      diff: "(no diff)",
      fullDiff: "(no diff)",
      gitStatus: "(clean)",
      changedFiles: [],
      truncated: false,
    };
    await appendRunEvent(args.productStore, args.run.id, "answer", { turnId: turn.id, answer, sources: [] });
    await appendRunEvent(args.productStore, args.run.id, "diff", {
      turnId: turn.id,
      diff: turn.diff,
      status: turn.gitStatus,
      changedFiles: turn.changedFiles,
      truncated: turn.truncated,
    });
    const current = await args.productStore.getRun(args.run.id);
    await args.productStore.updateRun(args.run.id, {
      status: "done",
      result: codeRunResultWithTurn(current ?? args.run, turn),
      error: null,
    });
    return;
  }

  if (!Object.keys(providerSecrets).length) {
    throw new Error("Worker execution requires a valid BYOK secret grant.");
  }

  const result = await codeAnything(payload.ref, payload.task, {
    channel: payload.channel,
    runtime: payload.runtime,
    agent: payload.agent,
    screenshots: payload.screenshots,
    maxIterations: payload.maxIterations,
    mcpConfig: runtimeCapabilities.mcpConfig,
    skillSources: runtimeCapabilities.skillSources,
    providerSecrets,
    refs: payload.refs,
    signal: args.signal,
    onEvent: (ev) => {
      appendRunEvent(args.productStore, args.run.id, ev.type, withTurnId(payload.turnId, ev)).catch((error) => {
        console.warn(`[worker] failed to append ${ev.type} for ${args.run.id}:`, error instanceof Error ? error.message : error);
      });
    },
  });
  const turn: CodeSessionTurn = {
    id: payload.turnId,
    task: payload.task,
    displayTask: payload.displayTask,
    handoff: payload.handoff,
    status: "done",
    channel: payload.channel,
    runtime: payload.runtime,
    agent: payload.agent,
    startedAt: payload.startedAt,
    completedAt: new Date().toISOString(),
    answer: result.answer,
    sources: result.sources,
    diff: result.diff,
    fullDiff: result.fullDiff,
    gitStatus: result.status,
    changedFiles: result.changedFiles,
    truncated: result.truncated,
  };
  const current = await args.productStore.getRun(args.run.id);
  await args.productStore.updateRun(args.run.id, {
    status: "done",
    result: codeRunResultWithTurn(current ?? args.run, turn),
    error: null,
  });
}

async function executeWikiJob(args: {
  baseRoot: string;
  productStore: ProductStore;
  secretGrantStore: SecretGrantStore;
  ownerUserId: string;
  run: ProductRun;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  const payload = normalizeWikiPayload(args.payload);
  const store = new WikiStore(join(args.baseRoot, "users", args.ownerUserId));
  const providerSecrets = await providerSecretsForJob(args.secretGrantStore, args.ownerUserId, payload);
  const processEvents: WorkerProcessEvent[] = [];
  let writeQueue = Promise.resolve();
  const persist = (type: string, data: unknown): void => {
    const compact = compactWikiWorkerEvent(type, data);
    if (!compact) return;
    processEvents.push({ ...compact, createdAt: new Date().toISOString() });
    if (processEvents.length > 300) processEvents.splice(0, processEvents.length - 300);
    writeQueue = writeQueue
      .catch(() => {
        /* keep the queue moving after a prior write failure */
      })
      .then(() => appendRunEvent(args.productStore, args.run.id, compact.type, compact.payload));
  };
  const flush = async (): Promise<void> => {
    await writeQueue.catch((error) => {
      console.warn(`[worker] failed to persist wiki event for ${args.run.id}:`, error instanceof Error ? error.message : error);
    });
  };

  if (payload.action === "wiki.generate") {
    const ref = payload.refs?.length ? wikiRefForWorkspace(payload.refs) : payload.ref;
    if (!ref) throw new Error("Wiki generate payload is missing repo ref");
    persist("start", {
      runId: args.run.id,
      owner: ref.owner,
      repo: ref.repo,
        url: ref.url,
        repos: payload.refs,
        branch: ref.branch,
        sourcePath: ref.sourcePath ?? null,
      channel: payload.channel,
      structureChannel: payload.structureChannel ?? payload.channel,
      pageChannel: payload.pageChannel ?? payload.channel,
      runtime: payload.runtime,
      worker: true,
    });
    const record = await generateWiki(ref, {
      refs: payload.refs,
      channel: payload.channel,
      structureChannel: payload.structureChannel,
      pageChannel: payload.pageChannel,
      runtime: payload.runtime,
      localCli: payload.localCli,
      concurrency: payload.concurrency,
      depth: payload.depth,
      pageCount: payload.pageCount,
      pageCountMode: payload.pageCountMode,
      style: payload.style,
      stylePrompt: payload.stylePrompt,
      languages: payload.languages,
      knowledgeProfile: payload.knowledgeProfile,
      signal: args.signal,
      codeKb: {
        enabled: () => codeGraphEnabledForWikiWorker(payload.codeGraphEnabled),
      },
      store,
      providerSecrets,
      onCheckpoint: async (checkpointRecord, checkpoint) => {
        await args.productStore.upsertArtifact({
          kind: WIKI_DRAFT_ARTIFACT_KIND,
          key: args.run.id,
          runId: args.run.id,
          data: {
            ...(checkpointRecord as unknown as Record<string, unknown>),
            checkpoint,
            status: "running",
          },
        }).catch((error) => {
          console.warn(`[worker] failed to persist wiki draft checkpoint for ${args.run.id}:`, error instanceof Error ? error.message : error);
        });
      },
      onEvent: (ev) => persistGenerationEvent(persist, ev),
    });
    await flush();
    await persistWikiArtifact(args.productStore, record, args.run.id);
    await args.productStore.updateRun(args.run.id, {
      status: "done",
      result: { wiki: record, processSnapshot: workerProcessSnapshot(processEvents) },
      error: null,
    });
    return;
  }

  if (payload.action === "wiki.page.regenerate") {
    let record = await loadWikiRecordForPayload(args.productStore, store, payload);
    const pageId = payload.pageId || "";
    if (!pageId) throw new Error("Wiki page regenerate payload is missing pageId");
    const pageMeta = record.structure.pages.find((page) => page.id === pageId);
    persist("start", {
      runId: args.run.id,
      owner: record.owner,
      repo: record.repo,
      branch: record.branch,
      pageId,
      title: pageMeta?.title || payload.pageTitle || pageId,
      channel: payload.channel,
      runtime: payload.runtime,
      worker: true,
    });
    persist("phase", {
      phase: "pages",
      message: `Regenerating "${pageMeta?.title || pageId}"`,
    });
    persist("page-start", {
      pageId,
      title: pageMeta?.title || payload.pageTitle || pageId,
    });
    const page = await regenerateWikiPage(record, pageId, {
      channel: payload.channel,
      runtime: payload.runtime,
      localCli: payload.localCli,
      instruction: payload.instruction,
      stylePrompt: payload.stylePrompt ?? "",
      stylePromptOverride: payload.stylePromptOverride,
      store,
      providerSecrets,
      onEvent: () => {
        /* Page repair agent internals stay off the persisted worker stream. */
      },
    });
    record = await loadWikiRecordForPayload(args.productStore, store, payload).catch(() => record);
    record.pages[pageId] = page;
    record.generatedAt = new Date().toISOString();
    store.save(record);
    persist("page-done", wikiPageDonePayload(pageId, page));
    await flush();
    await persistWikiArtifact(args.productStore, record, args.run.id);
    await args.productStore.updateRun(args.run.id, {
      status: "done",
      result: { wiki: record, page, pageId, processSnapshot: workerProcessSnapshot(processEvents) },
      error: null,
    });
    return;
  }

  if (payload.action === "wiki.pages.regenerate") {
    let record = await loadWikiRecordForPayload(args.productStore, store, payload);
    const pageIds = payload.pageIds ?? [];
    if (!pageIds.length) throw new Error("Wiki batch regenerate payload is missing pageIds");
    const pageById = new Map(record.structure.pages.map((page) => [page.id, page]));
    const pageMetas = pageIds.map((pageId) => pageById.get(pageId));
    const missing = pageIds.filter((pageId, index) => !pageMetas[index]);
    if (missing.length) throw new Error(`Wiki batch regenerate payload has unknown pageIds: ${missing.slice(0, 5).join(", ")}`);

    persist("start", {
      runId: args.run.id,
      owner: record.owner,
      repo: record.repo,
      branch: record.branch,
      pageIds,
      pageCount: pageMetas.length,
      pages: pageMetas.map((page) => ({ pageId: page!.id, title: page!.title })),
      channel: payload.channel,
      runtime: payload.runtime,
      worker: true,
    });
    persist("phase", {
      phase: "pages",
      message: `Regenerating ${pageMetas.length} page${pageMetas.length === 1 ? "" : "s"}`,
    });
    await flush();

    const completedPageIds: string[] = [];
    const pageErrors: Array<{ pageId: string; title: string; message: string }> = [];
    for (let index = 0; index < pageMetas.length; index++) {
      const pageMeta = pageMetas[index]!;
      persist("page-start", {
        pageId: pageMeta.id,
        title: pageMeta.title,
        index: index + 1,
        total: pageMetas.length,
      });
      await flush();
      try {
        const page = await regenerateWikiPage(record, pageMeta.id, {
          channel: payload.channel,
          runtime: payload.runtime,
          localCli: payload.localCli,
          instruction: payload.instruction,
          store,
          providerSecrets,
          onEvent: () => {
            /* Page repair agent internals stay off the persisted worker stream. */
          },
        });
        record = await loadWikiRecordForPayload(args.productStore, store, payload).catch(() => record);
        record.pages[pageMeta.id] = page;
        record.generatedAt = new Date().toISOString();
        store.save(record);
        completedPageIds.push(pageMeta.id);
        persist("page-done", wikiPageDonePayload(pageMeta.id, page));
        await flush();
        await persistWikiArtifact(args.productStore, record, args.run.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const displayError = friendlyWikiGenerationError(message);
        pageErrors.push({ pageId: pageMeta.id, title: pageMeta.title, message });
        persist("page-error", { pageId: pageMeta.id, title: pageMeta.title, error: message, displayError });
        await flush();
      }
    }

    if (!completedPageIds.length) {
      const message = pageErrors[0]?.message || "No selected pages regenerated";
      await args.productStore.updateRun(args.run.id, {
        status: "error",
        result: { wiki: record, pageIds: completedPageIds, pageErrors, processSnapshot: workerProcessSnapshot(processEvents) },
        error: message,
      });
      throw new Error(message);
    }

    await persistWikiArtifact(args.productStore, record, args.run.id);
    await args.productStore.updateRun(args.run.id, {
      status: "done",
      result: { wiki: record, pageIds: completedPageIds, pageErrors, processSnapshot: workerProcessSnapshot(processEvents) },
      error: null,
    });
    return;
  }

  throw new Error(`Unsupported wiki worker action: ${payload.action}`);
}

async function hydrateCapabilitySettingsCache(
  root: string,
  productStore: ProductStore,
  profile: CapabilityProfileOptions,
): Promise<void> {
  if (productStore.mode !== "postgres") return;
  const artifact = await productStore.getArtifact(CAPABILITY_SETTINGS_ARTIFACT_KIND, CAPABILITY_SETTINGS_ARTIFACT_KEY);
  if (!artifact) return;
  saveCapabilitySettings(root, artifact.data as unknown as CapabilitySettings, profile);
}

async function providerSecretsForJob(
  secretGrantStore: SecretGrantStore,
  ownerUserId: string,
  payload: { secretGrantId?: string },
): Promise<ProviderSecrets> {
  if (!payload.secretGrantId) return {};
  return await secretGrantStore.read(payload.secretGrantId, ownerUserId) ?? {};
}

async function revokeGrantFromPayload(
  secretGrantStore: SecretGrantStore,
  ownerUserId: string,
  payload: Record<string, unknown>,
  reason: string,
): Promise<boolean> {
  const grantId = typeof payload.secretGrantId === "string" ? payload.secretGrantId : "";
  if (!grantId) return false;
  return secretGrantStore.revoke(grantId, ownerUserId, reason);
}

async function appendRunEvent(
  productStore: ProductStore,
  runId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await productStore.appendEvent(runId, type, redactProviderSecrets(payload));
}

function normalizeCodePayload(payload: Record<string, unknown>): CodeWorkerPayload {
  const action = payload.action === "code.publish-boundary" ? "code.publish-boundary" : payload.action === "code.initial" ? "code.initial" : null;
  if (!action) throw new Error("Unsupported code worker action");
  const ref = normalizeRepoRef(payload.ref);
  if (!ref) throw new Error("Code worker payload is missing repo ref");
  const turnId = typeof payload.turnId === "string" && payload.turnId ? payload.turnId : "";
  const task = typeof payload.task === "string" && payload.task.trim() ? payload.task.trim() : "";
  const channel = typeof payload.channel === "string" && payload.channel ? payload.channel : "";
  if (!turnId || !task || !channel) throw new Error("Code worker payload is incomplete");
  return {
    action,
    turnId,
    startedAt: typeof payload.startedAt === "string" && payload.startedAt ? payload.startedAt : new Date().toISOString(),
    ref,
    refs: normalizeWorkspaceRefs(payload.refs),
    task,
    displayTask: typeof payload.displayTask === "string" && payload.displayTask ? payload.displayTask : undefined,
    handoff: normalizeCodeHandoff(payload.handoff),
    channel,
    runtime: normalizeAgentRuntime(payload.runtime, "agent"),
    agent: normalizeCodeAnythingAgent(payload.agent),
    screenshots: payload.screenshots,
    maxIterations: typeof payload.maxIterations === "number" && Number.isFinite(payload.maxIterations) ? payload.maxIterations : undefined,
    capabilities: normalizeCapabilitySnapshot(payload.capabilities),
    secretGrantId: typeof payload.secretGrantId === "string" && payload.secretGrantId ? payload.secretGrantId : undefined,
  };
}

export function normalizeWikiCodeGraphEnabled(value: unknown): boolean {
  // Opt-in only. Undefined/missing defaults to off.
  return value === true;
}

export function codeGraphEnabledForWikiWorker(
  requested: unknown,
  serverEnabled: () => boolean = codeKbEnabled,
): boolean {
  return normalizeWikiCodeGraphEnabled(requested) && serverEnabled();
}

function normalizeWikiPayload(payload: Record<string, unknown>): WikiWorkerPayload {
  const action = payload.action === "wiki.generate"
    ? "wiki.generate"
    : payload.action === "wiki.page.regenerate"
      ? "wiki.page.regenerate"
      : payload.action === "wiki.pages.regenerate"
        ? "wiki.pages.regenerate"
        : null;
  if (!action) throw new Error("Unsupported wiki worker action");
  const channel = typeof payload.channel === "string" && payload.channel ? payload.channel : "";
  if (!channel) throw new Error("Wiki worker payload is missing channel");
  const ref = normalizeRepoRef(payload.ref);
  const refs = normalizeWorkspaceRefs(payload.refs);
  return {
    action,
    ref: ref ?? undefined,
    refs: refs.length > 1 ? refs : undefined,
      owner: typeof payload.owner === "string" && payload.owner ? payload.owner : undefined,
      repo: typeof payload.repo === "string" && payload.repo ? payload.repo : undefined,
      branch: payload.branch == null ? null : String(payload.branch),
      sourcePath: normalizeRepoSourcePath(payload.sourcePath),
    pageId: typeof payload.pageId === "string" && payload.pageId ? payload.pageId : undefined,
    pageIds: normalizeWikiBatchPageIds(payload.pageIds),
    pageTitle: typeof payload.pageTitle === "string" && payload.pageTitle ? payload.pageTitle : undefined,
    channel,
    structureChannel: typeof payload.structureChannel === "string" && payload.structureChannel ? payload.structureChannel : undefined,
    pageChannel: typeof payload.pageChannel === "string" && payload.pageChannel ? payload.pageChannel : undefined,
    runtime: normalizeWikiGenerationRuntime(payload.runtime),
    localCli: payload.localCli,
    concurrency: typeof payload.concurrency === "number" && Number.isFinite(payload.concurrency) ? payload.concurrency : undefined,
    depth: typeof payload.depth === "string" && payload.depth ? payload.depth : undefined,
    pageCount: typeof payload.pageCount === "number" && Number.isFinite(payload.pageCount) ? payload.pageCount : undefined,
    style: typeof payload.style === "string" && payload.style ? payload.style : undefined,
    stylePrompt: typeof payload.stylePrompt === "string" ? payload.stylePrompt : undefined,
    languages: normalizeWikiLanguages(payload.languages),
    knowledgeProfile: payload.knowledgeProfile,
    codeGraphEnabled: normalizeWikiCodeGraphEnabled(payload.codeGraphEnabled),
    stylePromptOverride: payload.stylePromptOverride === true,
    instruction: typeof payload.instruction === "string" && payload.instruction ? payload.instruction : undefined,
    secretGrantId: typeof payload.secretGrantId === "string" && payload.secretGrantId ? payload.secretGrantId : undefined,
  };
}

function normalizeWorkspaceRefs(value: unknown): WorkspaceRepoRef[] {
  const raw = Array.isArray(value) ? value : [];
  const refs: WorkspaceRepoRef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ref = normalizeRepoRef(item);
    if (!ref) continue;
    const id = jsonObject(item).id;
    const label = jsonObject(item).label;
    const workspaceRef: WorkspaceRepoRef = {
      owner: ref.owner,
      repo: ref.repo,
        url: ref.url,
        branch: ref.branch,
        sourcePath: ref.sourcePath ?? null,
        id: typeof id === "string" && id ? id : `${ref.owner}-${ref.repo}`.toLowerCase(),
        label: typeof label === "string" && label ? label : `${ref.owner}/${ref.repo}`,
      };
    const key = `${workspaceRef.id}:${workspaceRef.owner}/${workspaceRef.repo}@${workspaceRef.branch || ""}#${workspaceRef.sourcePath || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(workspaceRef);
  }
  return refs;
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

function persistGenerationEvent(
  persist: (type: string, data: unknown) => void,
  ev: GenerationEvent,
): void {
  if (ev.type === "phase") {
    persist("phase", { phase: ev.phase, message: ev.message });
    return;
  }
  if (ev.type === "structure-start") {
    persist("phase", { phase: "structure", message: "Planning wiki structure" });
    return;
  }
  if (ev.type === "structure-done") {
    persist("structure-done", { structure: ev.structure });
    return;
  }
  if (ev.type === "page-start") {
    persist("page-start", { pageId: ev.pageId, title: ev.title });
    return;
  }
  if (ev.type === "page-done") {
    persist("page-done", {
      pageId: ev.pageId,
      contentLength: ev.content.length,
      tokenUsage: ev.tokenUsage,
    });
    return;
  }
  if (ev.type === "page-error") {
    persist("page-error", { pageId: ev.pageId, error: ev.error, displayError: ev.displayError });
    return;
  }
  if (ev.type === "error") {
    persist("error", { message: ev.error });
  }
}

function compactWikiWorkerEvent(type: string, payload: unknown): { type: string; payload: Record<string, unknown> } | null {
  const row = jsonObject(payload);
  if (type === "start") return { type, payload: row };
  if (type === "phase") {
    return {
      type,
      payload: {
        phase: compactString(row.phase, 80),
        message: compactString(row.message, 500),
      },
    };
  }
  if (type === "structure-done") {
    return { type, payload: { structure: jsonObject(row.structure) } };
  }
  if (type === "page-start") {
    return {
      type,
      payload: {
        pageId: compactString(row.pageId, 160),
        title: compactString(row.title, 300),
      },
    };
  }
  if (type === "page-done") {
    return {
      type,
      payload: {
        pageId: compactString(row.pageId, 160),
        contentLength: typeof row.contentLength === "number" ? row.contentLength : undefined,
        tokenUsage: jsonObject(row.tokenUsage),
      },
    };
  }
  if (type === "page-error" || type === "error") {
    return {
      type,
      payload: {
        pageId: compactString(row.pageId, 160),
        message: compactString(row.message || row.error, 2000),
        error: compactString(row.error || row.message, 2000),
        displayError: compactString(row.displayError, 500),
      },
    };
  }
  return null;
}

function wikiPageDonePayload(pageId: string, page: GeneratedPage): Record<string, unknown> {
  return {
    pageId,
    contentLength: page.content.length,
    tokenUsage: page.tokenUsage,
  };
}

async function persistWikiArtifact(productStore: ProductStore, record: WikiRecord, runId: string): Promise<void> {
  const recordWithIdentity = ensureWikiRecordIdentity(record);
  await productStore.upsertArtifact({
    kind: "wiki",
    key: wikiRecordArtifactKey(recordWithIdentity),
    runId,
    data: recordWithIdentity as unknown as Record<string, unknown>,
  });
}

async function loadWikiRecordForPayload(
  productStore: ProductStore,
  store: WikiStore,
  payload: WikiWorkerPayload,
): Promise<WikiRecord> {
  const owner = payload.owner || payload.ref?.owner || "";
  const repo = payload.repo || payload.ref?.repo || "";
  const branch = payload.branch ?? payload.ref?.branch ?? null;
  const sourcePath = payload.sourcePath ?? payload.ref?.sourcePath ?? null;
  const id = String(payload.id || "").trim();
  if (id) {
    const artifact = await productStore.getArtifact("wiki", wikiInstanceArtifactKey(id));
    const loadedRecord = artifact
      ? WikiRecordSchema.parse(artifact.data)
      : store.loadById(id);
    if (!loadedRecord) throw new Error("Wiki not found");
    return ensureWikiRecordIdentity(loadedRecord);
  }
  if (!owner || !repo) throw new Error("Wiki page regenerate payload is missing owner/repo");
  const artifact = branch || sourcePath
    ? await productStore.getArtifact("wiki", wikiArtifactKey(owner, repo, branch, sourcePath))
    : null;
  const defaultArtifact = artifact ?? await productStore.getArtifact("wiki", wikiArtifactKey(owner, repo));
  const loadedRecord = defaultArtifact
    ? WikiRecordSchema.parse(defaultArtifact.data)
    : store.load(owner, repo);
  if (!loadedRecord) throw new Error("Wiki not found");
  return ensureWikiRecordIdentity(loadedRecord);
}

function workerProcessSnapshot(events: WorkerProcessEvent[]): Record<string, unknown> {
  return {
    version: 1,
    eventCount: events.length,
    events,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRepoRef(value: unknown): PublicRepoRef | null {
  const row = jsonObject(value);
  const owner = typeof row.owner === "string" ? row.owner : "";
  const repo = typeof row.repo === "string" ? row.repo : "";
  const url = typeof row.url === "string" ? row.url : "";
  if (!owner || !repo || !url) return null;
  return {
    id: typeof row.id === "string" && row.id ? row.id : undefined,
    owner,
    repo,
    label: typeof row.label === "string" && row.label ? row.label : undefined,
      url,
      branch: row.branch == null ? null : String(row.branch),
      sourcePath: normalizeRepoSourcePath(row.sourcePath),
    };
}

function normalizeCodeHandoff(value: unknown): Record<string, string | number | boolean> | undefined {
  const row = jsonObject(value);
  const kind = typeof row.kind === "string" && row.kind ? row.kind : "";
  if (!kind) return undefined;
  const out: Record<string, string | number | boolean> = { kind };
  for (const key of ["displayTask", "reviewLabel", "detail", "returnUrl", "sourceUrl", "sourceRunId"] as const) {
    if (typeof row[key] === "string" && row[key]) out[key] = String(row[key]);
  }
  if (typeof row.changedFileCount === "number" && Number.isFinite(row.changedFileCount)) {
    out.changedFileCount = row.changedFileCount;
  }
  return out;
}

function normalizeCapabilitySnapshot(value: unknown): CapabilitySnapshot | undefined {
  const row = jsonObject(value);
  const composio = jsonObject(row.composio);
  const mcpServers = Array.isArray(row.mcpServers) ? row.mcpServers : [];
  const skills = Array.isArray(row.skills) ? row.skills : [];
  if (!mcpServers.length && !skills.length && !Object.keys(composio).length) return undefined;
  return row as unknown as CapabilitySnapshot;
}

function codeRunResultWithTurn(run: ProductRun | null, turn: CodeSessionTurn): Record<string, unknown> {
  const existing = run ? jsonObject(run.result) : {};
  const turns = Array.isArray(existing.turns)
    ? existing.turns.filter((item) => jsonObject(item).id !== turn.id)
    : [];
  const result: Record<string, unknown> = {
    ...existing,
    turns: turns.concat(turn),
    answer: turn.answer ?? "",
    sources: turn.sources ?? [],
    diff: turn.diff ?? "(no diff)",
    fullDiff: turn.fullDiff ?? turn.diff ?? "(no diff)",
    status: turn.gitStatus ?? "(clean)",
    changedFiles: turn.changedFiles ?? [],
    truncated: turn.truncated === true,
    agent: normalizeCodeAnythingAgent(turn.agent),
    runtime: turn.runtime,
    error: turn.error ?? null,
  };
  return result;
}

function buildPrBoundaryAnswer(args: {
  task: string;
  ref: PublicRepoRef;
  changedFiles?: string[];
}): string {
  const changedFiles = args.changedFiles ?? [];
  const title = changedFiles.length === 1 ? `Update ${changedFiles[0]}` : changedFiles.length > 1 ? `Update ${changedFiles.length} files` : "Apply Code Anything patch";
  const files = changedFiles.length
    ? changedFiles.map((file) => `- \`${file}\``).join("\n")
    : "- No patch files are available yet.";
  return `## Ready To Create A Pull Request

I did not create a pull request or mutate GitHub from the agent loop.

Code Anything prepares the patch first. Use the **Create PR** action in rlm-wiki to publish the current patch to GitHub.

## PR Draft

Title: ${title}

## Changed Files

${files}

Repository: ${args.ref.owner}/${args.ref.repo}
Task: ${args.task}`.trim();
}

function withTurnId(turnId: string, payload: unknown): Record<string, unknown> {
  return { ...jsonObject(payload), turnId };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactString(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
