import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database as SQLiteDatabase } from "bun:sqlite";
import postgres from "postgres";

export type ProductRunKind =
  | "ask"
  | "code"
  | "review"
  | "investigate"
  | "wiki_generate"
  | "wiki_slides"
  | "distill";
export type ProductRunStatus = "running" | "done" | "error" | "canceled";

export interface ProductRun {
  id: string;
  kind: ProductRunKind;
  status: ProductRunStatus;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRunEvent {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface ProductArtifact {
  id: string;
  kind: string;
  key: string;
  latestRunId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * One auto-versioned snapshot of an artifact's `data` blob. Writes already record
 * these for free on every `upsertArtifact`; this is the read shape for the
 * (previously missing) versions read path used by `listArtifactVersions`.
 */
export interface ProductArtifactVersion {
  id: string;
  artifactId: string;
  runId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ProductStore {
  readonly mode: "file" | "postgres" | "sqlite";
  createRun(args: {
    kind: ProductRunKind;
    title: string;
    input?: Record<string, unknown>;
  }): Promise<ProductRun>;
  updateRun(
    id: string,
    patch: {
      status?: ProductRunStatus;
      title?: string;
      input?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<ProductRun | null>;
  appendEvent(runId: string, type: string, payload: unknown): Promise<ProductRunEvent>;
  getRun(id: string, opts?: { includeEvents?: boolean }): Promise<(ProductRun & { events?: ProductRunEvent[] }) | null>;
  deleteRun(id: string): Promise<boolean>;
  listRuns(opts?: {
    kind?: ProductRunKind | ProductRunKind[];
    limit?: number;
  }): Promise<ProductRun[]>;
  upsertArtifact(args: {
    kind: string;
    key: string;
    runId?: string | null;
    data: Record<string, unknown>;
  }): Promise<ProductArtifact>;
  getArtifact(kind: string, key: string): Promise<ProductArtifact | null>;
  listArtifacts(kind: string, opts?: { limit?: number }): Promise<ProductArtifact[]>;
  /**
   * Read the auto-versioned snapshot history for a (kind, key) artifact, newest
   * first. Returns [] when the artifact does not exist. Used for internal
   * admin/recovery, never on the public link.
   */
  listArtifactVersions(
    kind: string,
    key: string,
    opts?: { limit?: number },
  ): Promise<ProductArtifactVersion[]>;
}

export async function createProductStore(
  root: string,
  opts: { ownerUserId?: string } = {},
): Promise<ProductStore> {
  const databaseUrl = productDatabaseUrlForRuntime();
  const sqlitePath = productSqlitePathForRuntime();
  const ownerUserId = cleanOwnerUserId(opts.ownerUserId ?? "legacy");
  if (databaseUrl) {
    return PostgresProductStore.create(databaseUrl, ownerUserId);
  }
  if (sqlitePath) {
    return SQLiteProductStore.create(sqlitePath, ownerUserId);
  }
  return new FileProductStore(join(root, "product"));
}

export function wikiArtifactKey(owner: string, repo: string, branch?: string | null, sourcePath?: string | null): string {
  const base = branch ? `${owner}/${repo}@${branch}` : `${owner}/${repo}`;
  return sourcePath ? `${base}#${sourcePath}` : base;
}

export function wikiInstanceArtifactKey(id: string): string {
  const trimmed = String(id || "").trim();
  return trimmed.startsWith("wiki:") ? trimmed : `wiki:${trimmed}`;
}

export function wikiRecordArtifactKey(record: {
  id?: unknown;
  owner: string;
  repo: string;
  branch?: string | null;
  sourcePath?: string | null;
}): string {
  return typeof record.id === "string" && record.id.trim()
    ? wikiInstanceArtifactKey(record.id)
    : wikiArtifactKey(record.owner, record.repo, record.branch, record.sourcePath);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`.toLowerCase();
}

function makeRunId(): string {
  return crypto.randomUUID();
}

export function productDatabaseUrlForRuntime(): string | undefined {
  const privateUrl = process.env.DATABASE_URL?.trim();
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) return privateUrl || publicUrl;
  return publicUrl || privateUrl;
}

export function productSqlitePathForRuntime(): string | undefined {
  const sqlitePath =
    process.env.GROK_WIKI_SQLITE_PATH?.trim() || process.env.RLM_WIKI_SQLITE_PATH?.trim();
  if (!sqlitePath || productDatabaseUrlForRuntime()) return undefined;
  return sqlitePath;
}

function safeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonIfString(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function sqliteJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function pgJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

const SQLITE_BUSY_TIMEOUT_DEFAULT_MS = 30000;
const SQLITE_WRITE_BUSY_TIMEOUT_DEFAULT_MS = 500;
const SQLITE_WRITE_BUSY_RETRY_DELAYS_DEFAULT_MS = [50, 100];

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envDelayList(name: string, fallback: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.floor(item));
  return parsed.length ? parsed : fallback;
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "");
  return /database is locked|SQLITE_BUSY|database busy/i.test(message);
}

function sqliteWriteBusyRetryDelays(): number[] {
  return envDelayList("RLM_WIKI_SQLITE_WRITE_BUSY_RETRY_DELAYS_MS", SQLITE_WRITE_BUSY_RETRY_DELAYS_DEFAULT_MS);
}

function sqliteBusyTimeoutMs(): number {
  return envNumber("RLM_WIKI_SQLITE_BUSY_TIMEOUT_MS", SQLITE_BUSY_TIMEOUT_DEFAULT_MS);
}

function sqliteWriteBusyTimeoutMs(): number {
  return envNumber("RLM_WIKI_SQLITE_WRITE_BUSY_TIMEOUT_MS", SQLITE_WRITE_BUSY_TIMEOUT_DEFAULT_MS);
}

function setSqliteBusyTimeout(db: SQLiteDatabase, ms: number): void {
  db.run(`PRAGMA busy_timeout = ${ms}`);
}

async function withSqliteWriteBusyRetry<T>(db: SQLiteDatabase, write: () => T): Promise<T> {
  let lastError: unknown;
  const delays = sqliteWriteBusyRetryDelays();
  const writeBusyTimeoutMs = sqliteWriteBusyTimeoutMs();
  const defaultBusyTimeoutMs = sqliteBusyTimeoutMs();
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let retryDelayMs: number | null = null;
    try {
      setSqliteBusyTimeout(db, writeBusyTimeoutMs);
      return write();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt >= delays.length) break;
      retryDelayMs = delays[attempt];
    } finally {
      setSqliteBusyTimeout(db, defaultBusyTimeoutMs);
    }
    if (retryDelayMs !== null) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw lastError;
}

const postgresClientCache = new Map<string, postgres.Sql>();
const postgresMigrationCache = new Map<string, Promise<void>>();
const sqliteClientCache = new Map<string, SQLiteDatabase>();
const sqliteMigrationCache = new Map<string, Promise<void>>();

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

function sqliteDbForPath(path: string): SQLiteDatabase {
  const existing = sqliteClientCache.get(path);
  if (existing) return existing;
  const db = new SQLiteDatabase(path, { create: true });
  setSqliteBusyTimeout(db, sqliteBusyTimeoutMs());
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  sqliteClientCache.set(path, db);
  return db;
}

function normalizeRun(row: any): ProductRun {
  return {
    id: String(row.id),
    kind: row.kind as ProductRunKind,
    status: row.status as ProductRunStatus,
    title: String(row.title || ""),
    input: jsonObject(row.input),
    result: row.result == null ? null : jsonObject(row.result),
    error: row.error == null ? null : String(row.error),
    createdAt: toIso(row.created_at ?? row.createdAt),
    updatedAt: toIso(row.updated_at ?? row.updatedAt),
  };
}

function normalizeEvent(row: any): ProductRunEvent {
  return {
    runId: String(row.run_id ?? row.runId),
    seq: Number(row.seq),
    type: String(row.type),
    payload: parseJsonIfString(row.payload),
    createdAt: toIso(row.created_at ?? row.createdAt),
  };
}

function normalizeArtifact(row: any): ProductArtifact {
  return {
    id: String(row.id),
    kind: String(row.kind),
    key: String(row.key),
    latestRunId: row.latest_run_id == null && row.latestRunId == null
      ? null
      : String(row.latest_run_id ?? row.latestRunId),
    data: jsonObject(row.data),
    createdAt: toIso(row.created_at ?? row.createdAt),
    updatedAt: toIso(row.updated_at ?? row.updatedAt),
  };
}

function normalizeArtifactVersion(row: any): ProductArtifactVersion {
  return {
    id: String(row.id),
    artifactId: String(row.artifact_id ?? row.artifactId),
    runId: row.run_id == null && row.runId == null ? null : String(row.run_id ?? row.runId),
    data: jsonObject(row.data),
    createdAt: toIso(row.created_at ?? row.createdAt),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : nowIso();
}

class FileProductStore implements ProductStore {
  readonly mode = "file" as const;
  private readonly root: string;
  private readonly runsDir: string;
  private readonly eventsDir: string;
  private readonly artifactsDir: string;
  private readonly versionsDir: string;

  constructor(root: string) {
    this.root = root;
    this.runsDir = join(root, "runs");
    this.eventsDir = join(root, "events");
    this.artifactsDir = join(root, "artifacts");
    this.versionsDir = join(root, "artifact-versions");
    for (const dir of [this.root, this.runsDir, this.eventsDir, this.artifactsDir, this.versionsDir]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async createRun(args: {
    kind: ProductRunKind;
    title: string;
    input?: Record<string, unknown>;
  }): Promise<ProductRun> {
    const ts = nowIso();
    const run: ProductRun = {
      id: makeRunId(),
      kind: args.kind,
      status: "running",
      title: args.title,
      input: args.input ?? {},
      result: null,
      error: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.writeRun(run);
    return run;
  }

  async updateRun(
    id: string,
    patch: {
      status?: ProductRunStatus;
      title?: string;
      input?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<ProductRun | null> {
    const run = await this.getRun(id);
    if (!run) return null;
    const updated: ProductRun = {
      ...run,
      status: patch.status ?? run.status,
      title: patch.title ?? run.title,
      input: patch.input === undefined ? run.input : patch.input,
      result: patch.result === undefined ? run.result : patch.result,
      error: patch.error === undefined ? run.error : patch.error,
      updatedAt: nowIso(),
    };
    this.writeRun(updated);
    return updated;
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<ProductRunEvent> {
    const file = this.eventPath(runId);
    const seq = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).length + 1
      : 1;
    const event: ProductRunEvent = {
      runId,
      seq,
      type,
      payload,
      createdAt: nowIso(),
    };
    appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
    const run = await this.getRun(runId);
    if (run) this.writeRun({ ...run, updatedAt: event.createdAt });
    return event;
  }

  async getRun(
    id: string,
    opts: { includeEvents?: boolean } = {},
  ): Promise<(ProductRun & { events?: ProductRunEvent[] }) | null> {
    const file = this.runPath(id);
    if (!existsSync(file)) return null;
    const run = normalizeRun(JSON.parse(readFileSync(file, "utf8")));
    if (!opts.includeEvents) return run;
    return { ...run, events: this.readEvents(id) };
  }

  async deleteRun(id: string): Promise<boolean> {
    const file = this.runPath(id);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    const events = this.eventPath(id);
    if (existsSync(events)) unlinkSync(events);
    return true;
  }

  async listRuns(opts: {
    kind?: ProductRunKind | ProductRunKind[];
    limit?: number;
  } = {}): Promise<ProductRun[]> {
    const kinds = opts.kind ? new Set(Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    const runs = readdirSync(this.runsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return normalizeRun(JSON.parse(readFileSync(join(this.runsDir, file), "utf8")));
        } catch {
          return null;
        }
      })
      .filter((run): run is ProductRun => run !== null && (!kinds || kinds.has(run.kind)));
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async upsertArtifact(args: {
    kind: string;
    key: string;
    runId?: string | null;
    data: Record<string, unknown>;
  }): Promise<ProductArtifact> {
    const existing = await this.getArtifact(args.kind, args.key);
    const ts = nowIso();
    const artifact: ProductArtifact = {
      id: existing?.id ?? makeId("artifact"),
      kind: args.kind,
      key: args.key,
      latestRunId: args.runId ?? null,
      data: args.data,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    writeFileSync(this.artifactPath(args.kind, args.key), JSON.stringify(artifact, null, 2), "utf8");
    const version = {
      id: makeId("artifact-version"),
      artifactId: artifact.id,
      runId: args.runId ?? null,
      data: args.data,
      createdAt: ts,
    };
    writeFileSync(
      join(this.versionsDir, `${safeFileName(args.kind)}-${safeFileName(args.key)}-${Date.now()}.json`),
      JSON.stringify(version, null, 2),
      "utf8",
    );
    return artifact;
  }

  async getArtifact(kind: string, key: string): Promise<ProductArtifact | null> {
    const file = this.artifactPath(kind, key);
    if (!existsSync(file)) return null;
    return normalizeArtifact(JSON.parse(readFileSync(file, "utf8")));
  }

  async listArtifacts(kind: string, opts: { limit?: number } = {}): Promise<ProductArtifact[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    return readdirSync(this.artifactsDir)
      .filter((file) => file.startsWith(`${safeFileName(kind)}-`) && file.endsWith(".json"))
      .map((file) => {
        try {
          return normalizeArtifact(JSON.parse(readFileSync(join(this.artifactsDir, file), "utf8")));
        } catch {
          return null;
        }
      })
      .filter((artifact): artifact is ProductArtifact => Boolean(artifact))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async listArtifactVersions(
    kind: string,
    key: string,
    opts: { limit?: number } = {},
  ): Promise<ProductArtifactVersion[]> {
    const artifact = await this.getArtifact(kind, key);
    if (!artifact) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    return readdirSync(this.versionsDir)
      .filter((file) => file.startsWith(`${safeFileName(kind)}-${safeFileName(key)}-`) && file.endsWith(".json"))
      .map((file) => {
        try {
          return normalizeArtifactVersion(JSON.parse(readFileSync(join(this.versionsDir, file), "utf8")));
        } catch {
          return null;
        }
      })
      .filter((version): version is ProductArtifactVersion => Boolean(version) && version!.artifactId === artifact.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private writeRun(run: ProductRun): void {
    writeFileSync(this.runPath(run.id), JSON.stringify(run, null, 2), "utf8");
  }

  private readEvents(runId: string): ProductRunEvent[] {
    const file = this.eventPath(runId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizeEvent(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((event): event is ProductRunEvent => Boolean(event));
  }

  private runPath(id: string): string {
    return join(this.runsDir, `${safeFileName(id)}.json`);
  }

  private eventPath(runId: string): string {
    return join(this.eventsDir, `${safeFileName(runId)}.jsonl`);
  }

  private artifactPath(kind: string, key: string): string {
    return join(this.artifactsDir, `${safeFileName(kind)}-${safeFileName(key)}.json`);
  }
}

class SQLiteProductStore implements ProductStore {
  readonly mode = "sqlite" as const;
  private readonly db: SQLiteDatabase;
  private readonly ownerUserId: string;

  private constructor(db: SQLiteDatabase, ownerUserId: string) {
    this.db = db;
    this.ownerUserId = ownerUserId;
  }

  static async create(path: string, ownerUserId: string): Promise<SQLiteProductStore> {
    const db = sqliteDbForPath(path);
    const store = new SQLiteProductStore(db, ownerUserId);
    let migration = sqliteMigrationCache.get(path);
    if (!migration) {
      migration = Promise.resolve().then(() => store.migrate());
      sqliteMigrationCache.set(path, migration);
    }
    await migration;
    return store;
  }

  async createRun(args: {
    kind: ProductRunKind;
    title: string;
    input?: Record<string, unknown>;
  }): Promise<ProductRun> {
    return withSqliteWriteBusyRetry(this.db, () => {
      const id = makeRunId();
      const ts = nowIso();
      const row = this.db.query(`
        insert into rlm_product_runs (id, owner_user_id, kind, status, title, input, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        returning *
      `).get(id, this.ownerUserId, args.kind, "running", args.title, sqliteJson(args.input ?? {}), ts, ts);
      return normalizeRun(row);
    });
  }

  async updateRun(
    id: string,
    patch: {
      status?: ProductRunStatus;
      title?: string;
      input?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<ProductRun | null> {
    return withSqliteWriteBusyRetry(this.db, () => {
      const currentRow = this.db.query(`
        select * from rlm_product_runs
        where id = ? and owner_user_id = ?
      `).get(id, this.ownerUserId);
      if (!currentRow) return null;
      const current = normalizeRun(currentRow);
      const row = this.db.query(`
        update rlm_product_runs
        set status = ?,
            title = ?,
            input = ?,
            result = ?,
            error = ?,
            updated_at = ?
        where id = ? and owner_user_id = ?
        returning *
      `).get(
        patch.status ?? current.status,
        patch.title ?? current.title,
        sqliteJson(patch.input === undefined ? current.input : patch.input),
        patch.result === undefined
          ? (current.result == null ? null : sqliteJson(current.result))
          : (patch.result == null ? null : sqliteJson(patch.result)),
        patch.error === undefined ? current.error : patch.error,
        nowIso(),
        id,
        this.ownerUserId,
      );
      return row ? normalizeRun(row) : null;
    });
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<ProductRunEvent> {
    const append = this.db.transaction((id: string, eventType: string, eventPayload: string, ownerUserId: string) => {
      const ownedRun = this.db.query(`
        select id from rlm_product_runs
        where id = ? and owner_user_id = ?
      `).get(id, ownerUserId);
      if (!ownedRun) throw new Error("Run not found");
      const seqRow = this.db.query(`
        select coalesce(max(seq), 0) + 1 as seq
        from rlm_product_run_events
        where run_id = ?
      `).get(id) as { seq?: number } | null;
      const seq = Number(seqRow?.seq ?? 1);
      const ts = nowIso();
      const row = this.db.query(`
        insert into rlm_product_run_events (run_id, seq, type, payload, created_at)
        values (?, ?, ?, ?, ?)
        returning *
      `).get(id, seq, eventType, eventPayload, ts);
      this.db.query(`
        update rlm_product_runs
        set updated_at = ?
        where id = ? and owner_user_id = ?
      `).run(ts, id, ownerUserId);
      return normalizeEvent(row);
    });
    return append(runId, type, sqliteJson(payload), this.ownerUserId);
  }

  async getRun(
    id: string,
    opts: { includeEvents?: boolean } = {},
  ): Promise<(ProductRun & { events?: ProductRunEvent[] }) | null> {
    const row = this.db.query(`
      select * from rlm_product_runs
      where id = ? and owner_user_id = ?
    `).get(id, this.ownerUserId);
    if (!row) return null;
    const run = normalizeRun(row);
    if (!opts.includeEvents) return run;
    const events = this.db.query(`
      select * from rlm_product_run_events
      where run_id = ?
      order by seq asc
    `).all(id).map(normalizeEvent);
    return { ...run, events };
  }

  async deleteRun(id: string): Promise<boolean> {
    const result = await withSqliteWriteBusyRetry(this.db, () => this.db.query(`
        delete from rlm_product_runs
        where id = ? and owner_user_id = ?
      `).run(id, this.ownerUserId));
    return result.changes > 0;
  }

  async listRuns(opts: {
    kind?: ProductRunKind | ProductRunKind[];
    limit?: number;
  } = {}): Promise<ProductRun[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    if (!opts.kind) {
      return this.db.query(`
        select * from rlm_product_runs
        where owner_user_id = ?
        order by updated_at desc
        limit ?
      `).all(this.ownerUserId, limit).map(normalizeRun);
    }
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    const placeholders = kinds.map(() => "?").join(", ");
    return this.db.query(`
      select * from rlm_product_runs
      where owner_user_id = ? and kind in (${placeholders})
      order by updated_at desc
      limit ?
    `).all(this.ownerUserId, ...kinds, limit).map(normalizeRun);
  }

  async upsertArtifact(args: {
    kind: string;
    key: string;
    runId?: string | null;
    data: Record<string, unknown>;
  }): Promise<ProductArtifact> {
    const upsert = this.db.transaction((
      ownerUserId: string,
      kind: string,
      key: string,
      runId: string | null,
      data: string,
    ) => {
      const ts = nowIso();
      const row = this.db.query(`
        insert into rlm_product_artifacts (id, owner_user_id, kind, key, latest_run_id, data, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(owner_user_id, kind, key)
        do update set latest_run_id = excluded.latest_run_id,
                      data = excluded.data,
                      updated_at = excluded.updated_at
        returning *
      `).get(makeId("artifact"), ownerUserId, kind, key, runId, data, ts, ts);
      const artifact = normalizeArtifact(row);
      this.db.query(`
        insert into rlm_product_artifact_versions (id, owner_user_id, artifact_id, run_id, data, created_at)
        values (?, ?, ?, ?, ?, ?)
      `).run(makeId("artifact-version"), ownerUserId, artifact.id, runId, data, ts);
      return artifact;
    });
    return withSqliteWriteBusyRetry(this.db, () => upsert(this.ownerUserId, args.kind, args.key, args.runId ?? null, sqliteJson(args.data)));
  }

  async getArtifact(kind: string, key: string): Promise<ProductArtifact | null> {
    const row = this.db.query(`
      select * from rlm_product_artifacts
      where owner_user_id = ? and kind = ? and key = ?
    `).get(this.ownerUserId, kind, key);
    return row ? normalizeArtifact(row) : null;
  }

  async listArtifacts(kind: string, opts: { limit?: number } = {}): Promise<ProductArtifact[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    return this.db.query(`
      select * from rlm_product_artifacts
      where owner_user_id = ? and kind = ?
      order by updated_at desc
      limit ?
    `).all(this.ownerUserId, kind, limit).map(normalizeArtifact);
  }

  async listArtifactVersions(
    kind: string,
    key: string,
    opts: { limit?: number } = {},
  ): Promise<ProductArtifactVersion[]> {
    const artifact = await this.getArtifact(kind, key);
    if (!artifact) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    // rowid is SQLite's monotonic insertion order; it disambiguates two writes
    // that share an identical millisecond `created_at` so newest-first is stable.
    return this.db.query(`
      select * from rlm_product_artifact_versions
      where owner_user_id = ? and artifact_id = ?
      order by created_at desc, rowid desc
      limit ?
    `).all(this.ownerUserId, artifact.id, limit).map(normalizeArtifactVersion);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists rlm_product_runs (
        id text primary key,
        owner_user_id text not null default 'legacy',
        kind text not null,
        status text not null,
        title text not null,
        input text not null default '{}',
        result text,
        error text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create index if not exists rlm_product_runs_kind_updated_idx
      on rlm_product_runs (kind, updated_at desc);

      create index if not exists rlm_product_runs_owner_kind_updated_idx
      on rlm_product_runs (owner_user_id, kind, updated_at desc);

      create table if not exists rlm_product_run_events (
        run_id text not null references rlm_product_runs(id) on delete cascade,
        seq integer not null,
        type text not null,
        payload text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        primary key (run_id, seq)
      );

      create table if not exists rlm_product_artifacts (
        id text primary key,
        owner_user_id text not null default 'legacy',
        kind text not null,
        key text not null,
        latest_run_id text references rlm_product_runs(id) on delete set null,
        data text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create index if not exists rlm_product_artifacts_kind_updated_idx
      on rlm_product_artifacts (kind, updated_at desc);

      create unique index if not exists rlm_product_artifacts_owner_kind_key_idx
      on rlm_product_artifacts (owner_user_id, kind, key);

      create index if not exists rlm_product_artifacts_owner_kind_updated_idx
      on rlm_product_artifacts (owner_user_id, kind, updated_at desc);

      create table if not exists rlm_product_artifact_versions (
        id text primary key,
        owner_user_id text not null default 'legacy',
        artifact_id text not null references rlm_product_artifacts(id) on delete cascade,
        run_id text references rlm_product_runs(id) on delete set null,
        data text not null default '{}',
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create index if not exists rlm_product_artifact_versions_owner_idx
      on rlm_product_artifact_versions (owner_user_id, created_at desc);

      create index if not exists rlm_product_artifact_versions_owner_artifact_idx
      on rlm_product_artifact_versions (owner_user_id, artifact_id, created_at desc);
    `);
  }
}

class PostgresProductStore implements ProductStore {
  readonly mode = "postgres" as const;
  private readonly sql: postgres.Sql;
  private readonly ownerUserId: string;

  private constructor(sql: postgres.Sql, ownerUserId: string) {
    this.sql = sql;
    this.ownerUserId = ownerUserId;
  }

  static async create(url: string, ownerUserId: string): Promise<PostgresProductStore> {
    const sql = postgresSqlForUrl(url);
    const store = new PostgresProductStore(sql, ownerUserId);
    let migration = postgresMigrationCache.get(url);
    if (!migration) {
      migration = store.migrate();
      postgresMigrationCache.set(url, migration);
    }
    await migration;
    return store;
  }

  async createRun(args: {
    kind: ProductRunKind;
    title: string;
    input?: Record<string, unknown>;
  }): Promise<ProductRun> {
    const id = makeRunId();
    const rows = await this.sql`
      insert into rlm_product_runs (id, owner_user_id, kind, status, title, input)
      values (${id}, ${this.ownerUserId}, ${args.kind}, ${"running"}, ${args.title}, ${this.sql.json(pgJson(args.input ?? {}))})
      returning *
    `;
    return normalizeRun(rows[0]);
  }

  async updateRun(
    id: string,
    patch: {
      status?: ProductRunStatus;
      title?: string;
      input?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<ProductRun | null> {
    const current = await this.getRun(id);
    if (!current) return null;
    const rows = await this.sql`
      update rlm_product_runs
      set status = ${patch.status ?? current.status},
          title = ${patch.title ?? current.title},
          input = ${patch.input === undefined ? this.sql.json(pgJson(current.input)) : this.sql.json(pgJson(patch.input))},
          result = ${patch.result === undefined ? (current.result == null ? null : this.sql.json(pgJson(current.result))) : (patch.result == null ? null : this.sql.json(pgJson(patch.result)))},
          error = ${patch.error === undefined ? current.error : patch.error},
          updated_at = now()
      where id = ${id} and owner_user_id = ${this.ownerUserId}
      returning *
    `;
    return rows[0] ? normalizeRun(rows[0]) : null;
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<ProductRunEvent> {
    return this.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(${83491774}, hashtext(${runId}))`;
      const ownedRun = await sql`
        select id from rlm_product_runs
        where id = ${runId} and owner_user_id = ${this.ownerUserId}
      `;
      if (!ownedRun[0]) throw new Error("Run not found");
      const seqRows = await sql`
        select coalesce(max(seq), 0) + 1 as seq
        from rlm_product_run_events
        where run_id = ${runId}
      `;
      const seq = Number(seqRows[0]?.seq ?? 1);
      const rows = await sql`
        insert into rlm_product_run_events (run_id, seq, type, payload)
        values (${runId}, ${seq}, ${type}, ${sql.json(pgJson(payload))})
        returning *
      `;
      await sql`update rlm_product_runs set updated_at = now() where id = ${runId} and owner_user_id = ${this.ownerUserId}`;
      return normalizeEvent(rows[0]);
    });
  }

  async getRun(
    id: string,
    opts: { includeEvents?: boolean } = {},
  ): Promise<(ProductRun & { events?: ProductRunEvent[] }) | null> {
    const rows = await this.sql`select * from rlm_product_runs where id = ${id} and owner_user_id = ${this.ownerUserId}`;
    if (!rows[0]) return null;
    const run = normalizeRun(rows[0]);
    if (!opts.includeEvents) return run;
    const events = await this.sql`
      select * from rlm_product_run_events
      where run_id = ${id}
      order by seq asc
    `;
    return { ...run, events: events.map(normalizeEvent) };
  }

  async deleteRun(id: string): Promise<boolean> {
    const rows = await this.sql`
      delete from rlm_product_runs
      where id = ${id} and owner_user_id = ${this.ownerUserId}
      returning id
    `;
    return Boolean(rows[0]);
  }

  async listRuns(opts: {
    kind?: ProductRunKind | ProductRunKind[];
    limit?: number;
  } = {}): Promise<ProductRun[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
    if (!opts.kind) {
      const rows = await this.sql`
        select * from rlm_product_runs
        where owner_user_id = ${this.ownerUserId}
        order by updated_at desc
        limit ${limit}
      `;
      return rows.map(normalizeRun);
    }
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    const rows = await this.sql`
      select * from rlm_product_runs
      where owner_user_id = ${this.ownerUserId} and kind in ${this.sql(kinds)}
      order by updated_at desc
      limit ${limit}
    `;
    return rows.map(normalizeRun);
  }

  async upsertArtifact(args: {
    kind: string;
    key: string;
    runId?: string | null;
    data: Record<string, unknown>;
  }): Promise<ProductArtifact> {
    const id = makeId("artifact");
    const rows = await this.sql`
      insert into rlm_product_artifacts (id, owner_user_id, kind, key, latest_run_id, data)
      values (${id}, ${this.ownerUserId}, ${args.kind}, ${args.key}, ${args.runId ?? null}, ${this.sql.json(pgJson(args.data))})
      on conflict (owner_user_id, kind, key)
      do update set latest_run_id = excluded.latest_run_id,
                    data = excluded.data,
                    updated_at = now()
      returning *
    `;
    const artifact = normalizeArtifact(rows[0]);
    await this.sql`
      insert into rlm_product_artifact_versions (id, owner_user_id, artifact_id, run_id, data)
      values (${makeId("artifact-version")}, ${this.ownerUserId}, ${artifact.id}, ${args.runId ?? null}, ${this.sql.json(pgJson(args.data))})
    `;
    return artifact;
  }

  async getArtifact(kind: string, key: string): Promise<ProductArtifact | null> {
    const rows = await this.sql`
      select * from rlm_product_artifacts
      where owner_user_id = ${this.ownerUserId} and kind = ${kind} and key = ${key}
    `;
    return rows[0] ? normalizeArtifact(rows[0]) : null;
  }

  async listArtifacts(kind: string, opts: { limit?: number } = {}): Promise<ProductArtifact[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const rows = await this.sql`
      select * from rlm_product_artifacts
      where owner_user_id = ${this.ownerUserId} and kind = ${kind}
      order by updated_at desc
      limit ${limit}
    `;
    return rows.map(normalizeArtifact);
  }

  async listArtifactVersions(
    kind: string,
    key: string,
    opts: { limit?: number } = {},
  ): Promise<ProductArtifactVersion[]> {
    const artifact = await this.getArtifact(kind, key);
    if (!artifact) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const rows = await this.sql`
      select * from rlm_product_artifact_versions
      where owner_user_id = ${this.ownerUserId} and artifact_id = ${artifact.id}
      order by created_at desc
      limit ${limit}
    `;
    return rows.map(normalizeArtifactVersion);
  }

  private async migrate(): Promise<void> {
    await this.sql`
      create table if not exists rlm_product_runs (
        id text primary key,
        owner_user_id text not null default 'legacy',
        kind text not null,
        status text not null,
        title text not null,
        input jsonb not null default '{}'::jsonb,
        result jsonb,
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`alter table rlm_product_runs add column if not exists owner_user_id text not null default 'legacy'`;
    await this.sql`
      create index if not exists rlm_product_runs_kind_updated_idx
      on rlm_product_runs (kind, updated_at desc)
    `;
    await this.sql`
      create index if not exists rlm_product_runs_owner_kind_updated_idx
      on rlm_product_runs (owner_user_id, kind, updated_at desc)
    `;
    await this.sql`
      create table if not exists rlm_product_run_events (
        run_id text not null references rlm_product_runs(id) on delete cascade,
        seq integer not null,
        type text not null,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        primary key (run_id, seq)
      )
    `;
    await this.sql`
      create table if not exists rlm_product_artifacts (
        id text primary key,
        owner_user_id text not null default 'legacy',
        kind text not null,
        key text not null,
        latest_run_id text references rlm_product_runs(id) on delete set null,
        data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await this.sql`alter table rlm_product_artifacts add column if not exists owner_user_id text not null default 'legacy'`;
    await this.sql`alter table rlm_product_artifacts drop constraint if exists rlm_product_artifacts_kind_key_key`;
    await this.sql`
      create index if not exists rlm_product_artifacts_kind_updated_idx
      on rlm_product_artifacts (kind, updated_at desc)
    `;
    await this.sql`
      create unique index if not exists rlm_product_artifacts_owner_kind_key_idx
      on rlm_product_artifacts (owner_user_id, kind, key)
    `;
    await this.sql`
      create index if not exists rlm_product_artifacts_owner_kind_updated_idx
      on rlm_product_artifacts (owner_user_id, kind, updated_at desc)
    `;
    await this.sql`
      create table if not exists rlm_product_artifact_versions (
        id text primary key,
        owner_user_id text not null default 'legacy',
        artifact_id text not null references rlm_product_artifacts(id) on delete cascade,
        run_id text references rlm_product_runs(id) on delete set null,
        data jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `;
    await this.sql`alter table rlm_product_artifact_versions add column if not exists owner_user_id text not null default 'legacy'`;
    await this.sql`
      create index if not exists rlm_product_artifact_versions_owner_idx
      on rlm_product_artifact_versions (owner_user_id, created_at desc)
    `;
    await this.sql`
      create index if not exists rlm_product_artifact_versions_owner_artifact_idx
      on rlm_product_artifact_versions (owner_user_id, artifact_id, created_at desc)
    `;
  }
}

function cleanOwnerUserId(value: string): string {
  const clean = value.trim();
  if (/^[a-zA-Z0-9_.:@-]{1,128}$/.test(clean)) return clean;
  return "legacy";
}
