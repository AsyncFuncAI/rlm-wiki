import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { productDatabaseUrlForRuntime } from "./persistence.ts";

export type JobQueueMode = "file" | "postgres";
export type JobStatus = "queued" | "running" | "done" | "error" | "canceled";

export interface JobRecord {
  id: string;
  ownerUserId: string;
  type: string;
  status: JobStatus;
  runId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  priority: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobQueueStats {
  mode: JobQueueMode;
  queued: number;
  running: number;
  done: number;
  error: number;
  canceled: number;
  staleRunning: number;
  oldestQueuedAt: string | null;
}

export interface JobQueue {
  readonly mode: JobQueueMode;
  enqueue(args: {
    type: string;
    ownerUserId: string;
    runId?: string | null;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    availableAt?: string | Date;
  }): Promise<JobRecord>;
  claim(jobId: string, args: { workerId: string; lockMs?: number }): Promise<JobRecord | null>;
  claimNext(args: { workerId: string; types?: string[]; lockMs?: number }): Promise<JobRecord | null>;
  heartbeat(jobId: string, workerId: string, lockMs?: number): Promise<JobRecord | null>;
  complete(jobId: string, workerId: string): Promise<JobRecord | null>;
  fail(jobId: string, workerId: string, error: string): Promise<JobRecord | null>;
  cancel(jobId: string, reason?: string): Promise<JobRecord | null>;
  getJob(jobId: string): Promise<JobRecord | null>;
  listByRun(runId: string): Promise<JobRecord[]>;
  stats(): Promise<JobQueueStats>;
}

const DEFAULT_LOCK_MS = 60_000;
const postgresClientCache = new Map<string, postgres.Sql>();
const postgresMigrationCache = new Map<string, Promise<void>>();

export async function createJobQueue(root: string): Promise<JobQueue> {
  const databaseUrl = productDatabaseUrlForRuntime();
  if (databaseUrl) return PostgresJobQueue.create(databaseUrl);
  return new FileJobQueue(join(root, "jobs"));
}

function postgresSqlForUrl(url: string): postgres.Sql {
  const existing = postgresClientCache.get(url);
  if (existing) return existing;
  const sql = postgres(url, {
    max: Number(process.env.RLM_WIKI_DB_MAX_CONNECTIONS || 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  postgresClientCache.set(url, sql);
  return sql;
}

function makeJobId(): string {
  return `job-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : nowIso();
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return toIso(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pgJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function cleanOwnerUserId(value: string): string {
  const clean = value.trim();
  if (/^[a-zA-Z0-9_.:@-]{1,128}$/.test(clean)) return clean;
  return "legacy";
}

function safeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function normalizeStatus(value: unknown): JobStatus {
  return value === "running" || value === "done" || value === "error" || value === "canceled"
    ? value
    : "queued";
}

function normalizeJob(row: any): JobRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id ?? row.ownerUserId ?? "legacy"),
    type: String(row.type || ""),
    status: normalizeStatus(row.status),
    runId: row.run_id == null && row.runId == null ? null : String(row.run_id ?? row.runId),
    payload: jsonObject(row.payload),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? row.maxAttempts ?? 1),
    priority: Number(row.priority ?? 0),
    lockedBy: row.locked_by == null && row.lockedBy == null ? null : String(row.locked_by ?? row.lockedBy),
    lockedUntil: toIsoOrNull(row.locked_until ?? row.lockedUntil),
    availableAt: toIso(row.available_at ?? row.availableAt),
    startedAt: toIsoOrNull(row.started_at ?? row.startedAt),
    completedAt: toIsoOrNull(row.completed_at ?? row.completedAt),
    error: row.error == null ? null : String(row.error),
    createdAt: toIso(row.created_at ?? row.createdAt),
    updatedAt: toIso(row.updated_at ?? row.updatedAt),
  };
}

function emptyStats(mode: JobQueueMode): JobQueueStats {
  return {
    mode,
    queued: 0,
    running: 0,
    done: 0,
    error: 0,
    canceled: 0,
    staleRunning: 0,
    oldestQueuedAt: null,
  };
}

class FileJobQueue implements JobQueue {
  readonly mode = "file" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  async enqueue(args: {
    type: string;
    ownerUserId: string;
    runId?: string | null;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    availableAt?: string | Date;
  }): Promise<JobRecord> {
    const ts = nowIso();
    const job: JobRecord = {
      id: makeJobId(),
      ownerUserId: cleanOwnerUserId(args.ownerUserId),
      type: args.type,
      status: "queued",
      runId: args.runId ?? null,
      payload: args.payload ?? {},
      attempts: 0,
      maxAttempts: Math.max(1, args.maxAttempts ?? 1),
      priority: args.priority ?? 0,
      lockedBy: null,
      lockedUntil: null,
      availableAt: args.availableAt ? toIso(args.availableAt) : ts,
      startedAt: null,
      completedAt: null,
      error: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.writeJob(job);
    return job;
  }

  async claim(jobId: string, args: { workerId: string; lockMs?: number }): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job || !this.claimable(job)) return null;
    return this.writeClaimed(job, args.workerId, args.lockMs);
  }

  async claimNext(args: { workerId: string; types?: string[]; lockMs?: number }): Promise<JobRecord | null> {
    const types = args.types?.length ? new Set(args.types) : null;
    const job = this.readJobs()
      .filter((item) => (!types || types.has(item.type)) && this.claimable(item))
      .sort((a, b) => (
        b.priority - a.priority
        || a.availableAt.localeCompare(b.availableAt)
        || a.createdAt.localeCompare(b.createdAt)
      ))[0];
    return job ? this.writeClaimed(job, args.workerId, args.lockMs) : null;
  }

  async heartbeat(jobId: string, workerId: string, lockMs = DEFAULT_LOCK_MS): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "running" || job.lockedBy !== workerId) return null;
    const updated = {
      ...job,
      lockedUntil: new Date(Date.now() + lockMs).toISOString(),
      updatedAt: nowIso(),
    };
    this.writeJob(updated);
    return updated;
  }

  async complete(jobId: string, workerId: string): Promise<JobRecord | null> {
    return this.finish(jobId, workerId, "done");
  }

  async fail(jobId: string, workerId: string, error: string): Promise<JobRecord | null> {
    return this.finish(jobId, workerId, "error", error);
  }

  async cancel(jobId: string, reason?: string): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job || job.status === "done" || job.status === "error" || job.status === "canceled") return null;
    const ts = nowIso();
    const updated = {
      ...job,
      status: "canceled" as const,
      lockedBy: null,
      lockedUntil: null,
      completedAt: ts,
      error: reason ?? null,
      updatedAt: ts,
    };
    this.writeJob(updated);
    return updated;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const file = this.jobPath(jobId);
    if (!existsSync(file)) return null;
    try {
      return normalizeJob(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  async listByRun(runId: string): Promise<JobRecord[]> {
    return this.readJobs()
      .filter((job) => job.runId === runId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async stats(): Promise<JobQueueStats> {
    const stats = emptyStats(this.mode);
    const now = Date.now();
    for (const job of this.readJobs()) {
      stats[job.status] += 1;
      if (job.status === "running" && job.lockedUntil && Date.parse(job.lockedUntil) <= now) {
        stats.staleRunning += 1;
      }
      if (job.status === "queued" && (!stats.oldestQueuedAt || job.createdAt < stats.oldestQueuedAt)) {
        stats.oldestQueuedAt = job.createdAt;
      }
    }
    return stats;
  }

  private claimable(job: JobRecord): boolean {
    const now = Date.now();
    if (job.status === "queued") return Date.parse(job.availableAt) <= now;
    return job.status === "running"
      && job.attempts < job.maxAttempts
      && Boolean(job.lockedUntil)
      && Date.parse(job.lockedUntil!) <= now;
  }

  private writeClaimed(job: JobRecord, workerId: string, lockMs = DEFAULT_LOCK_MS): JobRecord {
    const ts = nowIso();
    const updated = {
      ...job,
      status: "running" as const,
      attempts: job.attempts + 1,
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + lockMs).toISOString(),
      startedAt: job.startedAt ?? ts,
      updatedAt: ts,
    };
    this.writeJob(updated);
    return updated;
  }

  private async finish(jobId: string, workerId: string, status: "done" | "error", error?: string): Promise<JobRecord | null> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "running" || job.lockedBy !== workerId) return null;
    const ts = nowIso();
    const updated = {
      ...job,
      status,
      lockedBy: null,
      lockedUntil: null,
      completedAt: ts,
      error: error ?? null,
      updatedAt: ts,
    };
    this.writeJob(updated);
    return updated;
  }

  private readJobs(): JobRecord[] {
    return readdirSync(this.root)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return normalizeJob(JSON.parse(readFileSync(join(this.root, file), "utf8")));
        } catch {
          return null;
        }
      })
      .filter((job): job is JobRecord => Boolean(job));
  }

  private writeJob(job: JobRecord): void {
    writeFileSync(this.jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
  }

  private jobPath(jobId: string): string {
    return join(this.root, `${safeFileName(jobId)}.json`);
  }
}

class PostgresJobQueue implements JobQueue {
  readonly mode = "postgres" as const;
  private readonly sql: postgres.Sql;

  private constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  static async create(url: string): Promise<PostgresJobQueue> {
    const sql = postgresSqlForUrl(url);
    const queue = new PostgresJobQueue(sql);
    let migration = postgresMigrationCache.get(url);
    if (!migration) {
      migration = queue.migrate();
      postgresMigrationCache.set(url, migration);
    }
    await migration;
    return queue;
  }

  async enqueue(args: {
    type: string;
    ownerUserId: string;
    runId?: string | null;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    availableAt?: string | Date;
  }): Promise<JobRecord> {
    const rows = await this.sql`
      insert into rlm_jobs (
        id, owner_user_id, type, status, run_id, payload, priority, max_attempts, available_at
      )
      values (
        ${makeJobId()},
        ${cleanOwnerUserId(args.ownerUserId)},
        ${args.type},
        ${"queued"},
        ${args.runId ?? null},
        ${this.sql.json(pgJson(args.payload ?? {}))},
        ${args.priority ?? 0},
        ${Math.max(1, args.maxAttempts ?? 1)},
        ${args.availableAt ? new Date(args.availableAt) : new Date()}
      )
      returning *
    `;
    return normalizeJob(rows[0]);
  }

  async claim(jobId: string, args: { workerId: string; lockMs?: number }): Promise<JobRecord | null> {
    const lockMs = args.lockMs ?? DEFAULT_LOCK_MS;
    const rows = await this.sql`
      update rlm_jobs
      set status = ${"running"},
          attempts = attempts + 1,
          locked_by = ${args.workerId},
          locked_until = now() + (${lockMs} * interval '1 millisecond'),
          started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = ${jobId}
        and (
          (status = ${"queued"} and available_at <= now())
          or (status = ${"running"} and locked_until <= now() and attempts < max_attempts)
        )
      returning *
    `;
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async claimNext(args: { workerId: string; types?: string[]; lockMs?: number }): Promise<JobRecord | null> {
    const lockMs = args.lockMs ?? DEFAULT_LOCK_MS;
    return this.sql.begin(async (sql) => {
      const typeFilter = args.types?.length ? args.types : null;
      const rows = typeFilter
        ? await sql`
            select id from rlm_jobs
            where type in ${sql(typeFilter)}
              and (
                (status = ${"queued"} and available_at <= now())
                or (status = ${"running"} and locked_until <= now() and attempts < max_attempts)
              )
            order by priority desc, available_at asc, created_at asc
            for update skip locked
            limit 1
          `
        : await sql`
            select id from rlm_jobs
            where (
              (status = ${"queued"} and available_at <= now())
              or (status = ${"running"} and locked_until <= now() and attempts < max_attempts)
            )
            order by priority desc, available_at asc, created_at asc
            for update skip locked
            limit 1
          `;
      if (!rows[0]) return null;
      const updated = await sql`
        update rlm_jobs
        set status = ${"running"},
            attempts = attempts + 1,
            locked_by = ${args.workerId},
            locked_until = now() + (${lockMs} * interval '1 millisecond'),
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = ${String(rows[0].id)}
        returning *
      `;
      return updated[0] ? normalizeJob(updated[0]) : null;
    });
  }

  async heartbeat(jobId: string, workerId: string, lockMs = DEFAULT_LOCK_MS): Promise<JobRecord | null> {
    const rows = await this.sql`
      update rlm_jobs
      set locked_until = now() + (${lockMs} * interval '1 millisecond'),
          updated_at = now()
      where id = ${jobId} and status = ${"running"} and locked_by = ${workerId}
      returning *
    `;
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async complete(jobId: string, workerId: string): Promise<JobRecord | null> {
    return this.finish(jobId, workerId, "done");
  }

  async fail(jobId: string, workerId: string, error: string): Promise<JobRecord | null> {
    return this.finish(jobId, workerId, "error", error);
  }

  async cancel(jobId: string, reason?: string): Promise<JobRecord | null> {
    const rows = await this.sql`
      update rlm_jobs
      set status = ${"canceled"},
          locked_by = null,
          locked_until = null,
          completed_at = now(),
          error = ${reason ?? null},
          updated_at = now()
      where id = ${jobId} and status not in (${"done"}, ${"error"}, ${"canceled"})
      returning *
    `;
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const rows = await this.sql`select * from rlm_jobs where id = ${jobId}`;
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async listByRun(runId: string): Promise<JobRecord[]> {
    const rows = await this.sql`
      select * from rlm_jobs
      where run_id = ${runId}
      order by updated_at desc
    `;
    return rows.map(normalizeJob);
  }

  async stats(): Promise<JobQueueStats> {
    const rows = await this.sql`
      select status, count(*)::int as count
      from rlm_jobs
      group by status
    `;
    const oldest = await this.sql`
      select min(created_at) as oldest
      from rlm_jobs
      where status = ${"queued"}
    `;
    const stale = await this.sql`
      select count(*)::int as count
      from rlm_jobs
      where status = ${"running"} and locked_until <= now()
    `;
    const stats = emptyStats(this.mode);
    for (const row of rows) {
      const status = normalizeStatus(row.status);
      stats[status] = Number(row.count ?? 0);
    }
    stats.oldestQueuedAt = toIsoOrNull(oldest[0]?.oldest);
    stats.staleRunning = Number(stale[0]?.count ?? 0);
    return stats;
  }

  private async finish(jobId: string, workerId: string, status: "done" | "error", error?: string): Promise<JobRecord | null> {
    const rows = await this.sql`
      update rlm_jobs
      set status = ${status},
          locked_by = null,
          locked_until = null,
          completed_at = now(),
          error = ${error ?? null},
          updated_at = now()
      where id = ${jobId} and status = ${"running"} and locked_by = ${workerId}
      returning *
    `;
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  private async migrate(): Promise<void> {
    await this.sql`
      create table if not exists rlm_jobs (
        id text primary key,
        owner_user_id text not null default 'legacy',
        type text not null,
        status text not null,
        run_id text,
        payload jsonb not null default '{}'::jsonb,
        attempts integer not null default 0,
        max_attempts integer not null default 1,
        priority integer not null default 0,
        locked_by text,
        locked_until timestamptz,
        available_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz,
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create index if not exists rlm_jobs_claim_idx
      on rlm_jobs (status, priority desc, available_at asc, created_at asc)
    `;
    await this.sql`
      create index if not exists rlm_jobs_run_idx
      on rlm_jobs (run_id)
    `;
    await this.sql`
      create index if not exists rlm_jobs_owner_status_idx
      on rlm_jobs (owner_user_id, status, updated_at desc)
    `;
  }
}
