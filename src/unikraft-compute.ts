/**
 * Unikraft Cloud compute dispatcher.
 *
 * Railway stays the control plane (queue, grants, SSE). Heavy jobs can be
 * executed in ephemeral Unikraft microVMs that claim an exact job id and exit.
 *
 * Design notes (Fable + Claudex review):
 * - Dispatch only for already-queued job types (wiki_generate / code).
 * - One VM per job with delete-on-stop + autokill.
 * - Exact claim via RLM_WIKI_JOB_ID — never claimNext() inside the VM.
 * - VM gets DATABASE_URL + grant master key (parity with Railway worker), but
 *   never UNIKRAFT_API_KEY (control-plane key stays on the web service).
 */

export type UnikraftMetro = "fra" | "dal" | "sin" | "was" | "sfo";

export interface UnikraftDispatchConfig {
  enabled: boolean;
  token: string;
  metro: UnikraftMetro;
  image: string;
  memoryMb: number;
  vcpus: number;
  autokillMs: number;
  maxConcurrent: number;
  jobTypes: string[];
  maxAttempts: number;
}

export interface UnikraftCreateInstanceArgs {
  name?: string;
  image?: string;
  memoryMb?: number;
  vcpus?: number;
  env: Record<string, string>;
  args?: string[];
  entrypoint?: string[];
  autokillMs?: number;
  timeoutS?: number;
  tags?: string[];
}

export interface UnikraftInstance {
  uuid: string;
  name: string;
  state?: string;
  metro?: string;
  fqdn?: string;
}

export interface UnikraftClient {
  createInstance(args: UnikraftCreateInstanceArgs): Promise<UnikraftInstance>;
  deleteInstance(idOrName: string): Promise<void>;
  listInstances(): Promise<UnikraftInstance[]>;
}

const DEFAULT_METRO: UnikraftMetro = "fra";
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_VCPUS = 1;
const DEFAULT_AUTOKILL_MS = 45 * 60_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_JOB_TYPES = ["run.wiki_generate", "run.code"];
const DEFAULT_MAX_ATTEMPTS = 2;
/** Railway claimNext skips Unikraft-reserved jobs for this long so the VM can boot + claim. */
export const DEFAULT_UNIKRAFT_GRACE_MS = 120_000;

const LIVE_INSTANCE_STATES = new Set([
  "starting",
  "running",
  "standby",
  "draining",
  "migrating",
]);

export function unikraftDispatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): UnikraftDispatchConfig {
  const token = (env.UNIKRAFT_API_KEY || env.UKC_TOKEN || "").trim();
  const enabledRaw = (env.RLM_WIKI_UNIKRAFT_DISPATCH || "").trim().toLowerCase();
  const enabled = Boolean(token) && (enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "on");
  const metro = normalizeMetro(env.RLM_WIKI_UNIKRAFT_METRO || env.UKC_METRO || DEFAULT_METRO);
  const image = (env.RLM_WIKI_UNIKRAFT_IMAGE || "").trim();
  const jobTypes = parseJobTypes(env.RLM_WIKI_UNIKRAFT_JOB_TYPES);
  return {
    enabled: enabled && Boolean(image),
    token,
    metro,
    image,
    memoryMb: positiveInt(env.RLM_WIKI_UNIKRAFT_MEMORY_MB, DEFAULT_MEMORY_MB),
    vcpus: positiveInt(env.RLM_WIKI_UNIKRAFT_VCPUS, DEFAULT_VCPUS),
    autokillMs: positiveInt(env.RLM_WIKI_UNIKRAFT_AUTOKILL_MS, DEFAULT_AUTOKILL_MS),
    maxConcurrent: positiveInt(env.RLM_WIKI_UNIKRAFT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
    jobTypes,
    maxAttempts: positiveInt(env.RLM_WIKI_UNIKRAFT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
  };
}

export function unikraftDispatchEnabledForJobType(
  jobType: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const config = unikraftDispatchConfig(env);
  return config.enabled && config.jobTypes.includes(jobType);
}

export function createUnikraftClient(
  config: UnikraftDispatchConfig = unikraftDispatchConfig(),
  fetchImpl: typeof fetch = fetch,
): UnikraftClient {
  if (!config.token) throw new Error("UNIKRAFT_API_KEY (or UKC_TOKEN) is required for Unikraft dispatch");
  const baseUrl = `https://api.${config.metro}.unikraft.cloud/v1`;

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const message = extractErrorMessage(parsed) || text || res.statusText;
      throw new Error(`Unikraft ${method} ${path} failed (${res.status}): ${message}`);
    }
    return parsed as T;
  };

  return {
    async createInstance(args) {
      const image = args.image || config.image;
      if (!image) throw new Error("RLM_WIKI_UNIKRAFT_IMAGE is required");
      const payload = {
        name: args.name || `rlm-job-${crypto.randomUUID().slice(0, 8)}`,
        image: { url: image },
        memory_mb: args.memoryMb ?? config.memoryMb,
        vcpus: args.vcpus ?? config.vcpus,
        env: args.env,
        args: args.args,
        entrypoint: args.entrypoint,
        autostart: true,
        restart_policy: "never",
        features: ["delete-on-stop"],
        autokill: {
          time_ms: args.autokillMs ?? config.autokillMs,
        },
        timeout_s: args.timeoutS ?? 120,
        tags: args.tags ?? ["rlm-wiki", "worker"],
      };
      const response = await request<UnikraftApiEnvelope>("POST", "/instances", payload);
      const instance = firstInstance(response);
      if (!instance?.uuid && !instance?.name) {
        throw new Error(`Unikraft create instance returned no instance: ${JSON.stringify(response).slice(0, 400)}`);
      }
      return {
        uuid: String(instance.uuid || ""),
        name: String(instance.name || payload.name),
        state: instance.state ? String(instance.state) : undefined,
        metro: config.metro,
        fqdn: extractFqdn(instance),
      };
    },

    async deleteInstance(idOrName) {
      const body = [{ name: idOrName, dont_retain: true, timeout_s: 30 }];
      // API accepts uuid or name objects; try uuid form when it looks like one.
      const payload = looksLikeUuid(idOrName)
        ? [{ uuid: idOrName, dont_retain: true, timeout_s: 30 }]
        : body;
      await request("DELETE", "/instances", payload);
    },

    async listInstances() {
      const response = await request<UnikraftApiEnvelope>("GET", "/instances");
      const instances = Array.isArray(response?.data?.instances) ? response.data.instances : [];
      return instances.map((row) => ({
        uuid: String(row.uuid || ""),
        name: String(row.name || ""),
        state: row.state ? String(row.state) : undefined,
        metro: config.metro,
        fqdn: extractFqdn(row),
      }));
    },
  };
}

export interface DispatchJobToUnikraftArgs {
  jobId: string;
  jobType: string;
  runId?: string | null;
  ownerUserId: string;
  env?: Record<string, string | undefined>;
  client?: UnikraftClient;
  config?: UnikraftDispatchConfig;
}

export interface DispatchJobToUnikraftResult {
  dispatched: boolean;
  skippedReason?: string;
  instance?: UnikraftInstance;
}

/**
 * Spawn a one-shot worker microVM for an already-enqueued job.
 * Returns skipped (not error) when the dispatcher is off or at capacity.
 */
export async function dispatchJobToUnikraft(
  args: DispatchJobToUnikraftArgs,
): Promise<DispatchJobToUnikraftResult> {
  const config = args.config ?? unikraftDispatchConfig();
  if (!config.enabled) return { dispatched: false, skippedReason: "unikraft_dispatch_disabled" };
  if (!config.jobTypes.includes(args.jobType)) {
    return { dispatched: false, skippedReason: `job_type_not_enabled:${args.jobType}` };
  }

  const client = args.client ?? createUnikraftClient(config);
  // Cap live VMs (not just in-flight create HTTP calls).
  try {
    const live = await countLiveWorkerInstances(client);
    if (live >= config.maxConcurrent) {
      return { dispatched: false, skippedReason: `max_concurrent_reached:${live}` };
    }
  } catch (error) {
    // If listing fails, still allow a create but surface the skip reason on second failure.
    console.warn(
      `[unikraft] listInstances failed while checking concurrency:`,
      error instanceof Error ? error.message : error,
    );
  }

  const workerEnv = buildWorkerEnv({
    jobId: args.jobId,
    runId: args.runId,
    ownerUserId: args.ownerUserId,
    extra: args.env,
  });

  const instance = await client.createInstance({
    name: unikraftInstanceNameForJob(args.jobId),
    env: workerEnv,
    // Same image CMD can be overridden to force exact job worker.
    args: ["run", "./bin/rlm-wiki.ts", "worker", "--once", "--job", args.jobId],
    entrypoint: ["bun"],
    tags: ["rlm-wiki", "worker", args.jobType, args.jobId],
  });
  return { dispatched: true, instance };
}

export function unikraftInstanceNameForJob(jobId: string): string {
  const slug = jobId.slice(0, 28).replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
  return `rlm-${slug || "job"}`;
}

export function unikraftGraceUntilIso(nowMs = Date.now(), graceMs = DEFAULT_UNIKRAFT_GRACE_MS): string {
  return new Date(nowMs + graceMs).toISOString();
}

export async function countLiveWorkerInstances(client: UnikraftClient): Promise<number> {
  const instances = await client.listInstances();
  return instances.filter((instance) => {
    const state = String(instance.state || "").toLowerCase();
    return !state || LIVE_INSTANCE_STATES.has(state);
  }).length;
}

/** Best-effort stop/delete of a dispatched sandbox (cancel path). */
export async function deleteUnikraftInstanceBestEffort(
  idOrName: string,
  config: UnikraftDispatchConfig = unikraftDispatchConfig(),
  client?: UnikraftClient,
): Promise<void> {
  if (!config.token || !idOrName.trim()) return;
  const api = client ?? createUnikraftClient(config);
  await api.deleteInstance(idOrName.trim());
}

export function buildWorkerEnv(args: {
  jobId: string;
  runId?: string | null;
  ownerUserId: string;
  extra?: Record<string, string | undefined>;
}): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: "production",
    RLM_WIKI_PROCESS: "worker",
    RLM_WIKI_JOB_ID: args.jobId,
    RLM_WIKI_OWNER_USER_ID: args.ownerUserId,
    RLM_WIKI_ROOT: process.env.RLM_WIKI_UNIKRAFT_WORKER_ROOT || "/tmp/rlm-wiki-worker",
  };
  // Control-plane secrets required for grant redemption + event writeback.
  // Never forward UNIKRAFT_API_KEY into the VM (Claudex: control key stays on web).
  const passThrough = [
    "DATABASE_URL",
    "DATABASE_PUBLIC_URL",
    "RLM_WIKI_SECRET_GRANT_KEY",
    "RLM_WIKI_SECRET_GRANT_TTL_SECONDS",
    "RLM_WIKI_JOB_LOCK_MS",
    "GITHUB_TOKEN",
    "COMPOSIO_API_KEY",
    "COMPOSIO_BASE_URL",
    "COMPOSIO_USER_ID",
  ];
  for (const key of passThrough) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(args.extra ?? {})) {
    if (value == null || value === "") continue;
    if (isControlPlaneSecret(key)) continue;
    env[key] = value;
  }
  return env;
}

function isControlPlaneSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "UNIKRAFT_API_KEY"
    || upper === "UKC_TOKEN"
    || upper === "KRAFTCLOUD_TOKEN"
    || upper.startsWith("UKC_")
  );
}

function normalizeMetro(value: string): UnikraftMetro {
  const metro = value.trim().toLowerCase();
  if (metro === "fra" || metro === "dal" || metro === "sin" || metro === "was" || metro === "sfo") return metro;
  return DEFAULT_METRO;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseJobTypes(raw: string | undefined): string[] {
  const parts = String(raw || "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [...DEFAULT_JOB_TYPES];
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

type UnikraftApiEnvelope = {
  status?: string;
  message?: string;
  data?: {
    instances?: Array<Record<string, unknown>>;
  };
  errors?: Array<{ message?: string; status?: number }>;
};

function firstInstance(response: UnikraftApiEnvelope): Record<string, unknown> | null {
  const instances = response?.data?.instances;
  if (!Array.isArray(instances) || !instances[0]) return null;
  return instances[0];
}

function extractFqdn(instance: Record<string, unknown>): string | undefined {
  const serviceGroup = instance.service_group;
  if (!serviceGroup || typeof serviceGroup !== "object") return undefined;
  const domains = (serviceGroup as { domains?: Array<{ fqdn?: string }> }).domains;
  const fqdn = domains?.[0]?.fqdn;
  return typeof fqdn === "string" && fqdn ? fqdn.replace(/\.$/, "") : undefined;
}

function extractErrorMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const row = parsed as UnikraftApiEnvelope & { error?: string; raw?: string };
  if (typeof row.message === "string" && row.message.trim()) return row.message.trim();
  if (typeof row.error === "string" && row.error.trim()) return row.error.trim();
  if (Array.isArray(row.errors) && row.errors[0]?.message) return String(row.errors[0].message);
  if (typeof row.raw === "string") return row.raw.slice(0, 300);
  return "";
}
