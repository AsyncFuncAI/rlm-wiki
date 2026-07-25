import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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
import {
  hasProviderSecrets,
  normalizeProviderSecrets,
  type ProviderSecrets,
} from "./provider-secrets.ts";

export type SecretGrantMode = "disabled" | "file" | "postgres";

export interface SecretGrantRef {
  id: string;
  expiresAt: string;
}

export interface SecretGrantStats {
  mode: SecretGrantMode;
  configured: boolean;
  ttlSeconds: number;
  active: number;
  expired: number;
  revoked: number;
}

export interface SecretGrantStore {
  readonly mode: SecretGrantMode;
  readonly configured: boolean;
  readonly ttlSeconds: number;
  create(args: {
    ownerUserId: string;
    purpose: string;
    providerSecrets?: ProviderSecrets | null;
    ttlSeconds?: number;
  }): Promise<SecretGrantRef | null>;
  read(id: string, ownerUserId: string): Promise<ProviderSecrets | null>;
  revoke(id: string, ownerUserId: string, reason?: string): Promise<boolean>;
  stats(): Promise<SecretGrantStats>;
}

interface StoredSecretGrant {
  id: string;
  ownerUserId: string;
  purpose: string;
  iv: string;
  tag: string;
  ciphertext: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

const DEFAULT_TTL_SECONDS = Math.max(60, Number(process.env.RLM_WIKI_SECRET_GRANT_TTL_SECONDS || 30 * 60));
const postgresClientCache = new Map<string, postgres.Sql>();
const postgresMigrationCache = new Map<string, Promise<void>>();

export async function createSecretGrantStore(root: string): Promise<SecretGrantStore> {
  const key = secretGrantKey();
  if (!key) return new DisabledSecretGrantStore(DEFAULT_TTL_SECONDS);
  const databaseUrl = productDatabaseUrlForRuntime();
  if (databaseUrl) return PostgresSecretGrantStore.create(databaseUrl, key, DEFAULT_TTL_SECONDS);
  return new FileSecretGrantStore(join(root, "secret-grants"), key, DEFAULT_TTL_SECONDS);
}

function secretGrantKey(): Buffer | null {
  const raw = process.env.RLM_WIKI_SECRET_GRANT_KEY?.trim();
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
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

function makeGrantId(): string {
  return `grant-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 12)}`.toLowerCase();
}

function cleanOwnerUserId(value: string): string {
  const clean = value.trim();
  if (/^[a-zA-Z0-9_.:@-]{1,128}$/.test(clean)) return clean;
  return "legacy";
}

function safeFileName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function encryptGrant(args: {
  key: Buffer;
  id: string;
  ownerUserId: string;
  purpose: string;
  providerSecrets: ProviderSecrets;
  expiresAt: string;
}): Pick<StoredSecretGrant, "iv" | "tag" | "ciphertext"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", args.key, iv);
  cipher.setAAD(grantAad(args));
  const plaintext = Buffer.from(JSON.stringify(args.providerSecrets), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptGrant(key: Buffer, grant: StoredSecretGrant): ProviderSecrets {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(grant.iv, "base64"));
  decipher.setAAD(grantAad(grant));
  decipher.setAuthTag(Buffer.from(grant.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(grant.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return normalizeProviderSecrets(JSON.parse(plaintext));
}

function grantAad(args: { id: string; ownerUserId: string; purpose: string; expiresAt: string }): Buffer {
  return Buffer.from(`${args.id}:${args.ownerUserId}:${args.purpose}:${args.expiresAt}`, "utf8");
}

function isGrantActive(grant: StoredSecretGrant): boolean {
  return !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now();
}

function normalizeStoredGrant(row: any): StoredSecretGrant {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id ?? row.ownerUserId ?? "legacy"),
    purpose: String(row.purpose || ""),
    iv: String(row.iv || ""),
    tag: String(row.tag || ""),
    ciphertext: String(row.ciphertext || ""),
    expiresAt: toIso(row.expires_at ?? row.expiresAt),
    revokedAt: toIsoOrNull(row.revoked_at ?? row.revokedAt),
    revokedReason: row.revoked_reason == null && row.revokedReason == null ? null : String(row.revoked_reason ?? row.revokedReason),
    createdAt: toIso(row.created_at ?? row.createdAt),
  };
}

function emptyStats(mode: SecretGrantMode, configured: boolean, ttlSeconds: number): SecretGrantStats {
  return {
    mode,
    configured,
    ttlSeconds,
    active: 0,
    expired: 0,
    revoked: 0,
  };
}

class DisabledSecretGrantStore implements SecretGrantStore {
  readonly mode = "disabled" as const;
  readonly configured = false;
  readonly ttlSeconds: number;

  constructor(ttlSeconds: number) {
    this.ttlSeconds = ttlSeconds;
  }

  async create(): Promise<SecretGrantRef | null> {
    return null;
  }

  async read(): Promise<ProviderSecrets | null> {
    return null;
  }

  async revoke(): Promise<boolean> {
    return false;
  }

  async stats(): Promise<SecretGrantStats> {
    return emptyStats(this.mode, this.configured, this.ttlSeconds);
  }
}

class FileSecretGrantStore implements SecretGrantStore {
  readonly mode = "file" as const;
  readonly configured = true;
  readonly ttlSeconds: number;
  private readonly root: string;
  private readonly key: Buffer;

  constructor(root: string, key: Buffer, ttlSeconds: number) {
    this.root = root;
    this.key = key;
    this.ttlSeconds = ttlSeconds;
    mkdirSync(this.root, { recursive: true });
  }

  async create(args: {
    ownerUserId: string;
    purpose: string;
    providerSecrets?: ProviderSecrets | null;
    ttlSeconds?: number;
  }): Promise<SecretGrantRef | null> {
    const providerSecrets = normalizeProviderSecrets(args.providerSecrets);
    if (!hasProviderSecrets(providerSecrets)) return null;
    const id = makeGrantId();
    const ownerUserId = cleanOwnerUserId(args.ownerUserId);
    const ttlSeconds = Math.max(30, args.ttlSeconds ?? this.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const encrypted = encryptGrant({
      key: this.key,
      id,
      ownerUserId,
      purpose: args.purpose,
      providerSecrets,
      expiresAt,
    });
    const grant: StoredSecretGrant = {
      id,
      ownerUserId,
      purpose: args.purpose,
      ...encrypted,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      createdAt: nowIso(),
    };
    this.writeGrant(grant);
    return { id, expiresAt };
  }

  async read(id: string, ownerUserId: string): Promise<ProviderSecrets | null> {
    const grant = this.readGrant(id);
    if (!grant || grant.ownerUserId !== cleanOwnerUserId(ownerUserId) || !isGrantActive(grant)) return null;
    return decryptGrant(this.key, grant);
  }

  async revoke(id: string, ownerUserId: string, reason?: string): Promise<boolean> {
    const grant = this.readGrant(id);
    if (!grant || grant.ownerUserId !== cleanOwnerUserId(ownerUserId) || grant.revokedAt) return false;
    this.writeGrant({
      ...grant,
      revokedAt: nowIso(),
      revokedReason: reason ?? null,
    });
    return true;
  }

  async stats(): Promise<SecretGrantStats> {
    const stats = emptyStats(this.mode, this.configured, this.ttlSeconds);
    for (const grant of this.readGrants()) {
      if (grant.revokedAt) stats.revoked += 1;
      else if (Date.parse(grant.expiresAt) <= Date.now()) stats.expired += 1;
      else stats.active += 1;
    }
    return stats;
  }

  private readGrants(): StoredSecretGrant[] {
    return readdirSync(this.root)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return normalizeStoredGrant(JSON.parse(readFileSync(join(this.root, file), "utf8")));
        } catch {
          return null;
        }
      })
      .filter((grant): grant is StoredSecretGrant => Boolean(grant));
  }

  private readGrant(id: string): StoredSecretGrant | null {
    const file = this.pathFor(id);
    if (!existsSync(file)) return null;
    try {
      return normalizeStoredGrant(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  private writeGrant(grant: StoredSecretGrant): void {
    writeFileSync(this.pathFor(grant.id), JSON.stringify(grant, null, 2), "utf8");
  }

  private pathFor(id: string): string {
    return join(this.root, `${safeFileName(id)}.json`);
  }
}

class PostgresSecretGrantStore implements SecretGrantStore {
  readonly mode = "postgres" as const;
  readonly configured = true;
  readonly ttlSeconds: number;
  private readonly sql: postgres.Sql;
  private readonly key: Buffer;

  private constructor(sql: postgres.Sql, key: Buffer, ttlSeconds: number) {
    this.sql = sql;
    this.key = key;
    this.ttlSeconds = ttlSeconds;
  }

  static async create(url: string, key: Buffer, ttlSeconds: number): Promise<PostgresSecretGrantStore> {
    const sql = postgresSqlForUrl(url);
    const store = new PostgresSecretGrantStore(sql, key, ttlSeconds);
    let migration = postgresMigrationCache.get(url);
    if (!migration) {
      migration = store.migrate();
      postgresMigrationCache.set(url, migration);
    }
    await migration;
    return store;
  }

  async create(args: {
    ownerUserId: string;
    purpose: string;
    providerSecrets?: ProviderSecrets | null;
    ttlSeconds?: number;
  }): Promise<SecretGrantRef | null> {
    const providerSecrets = normalizeProviderSecrets(args.providerSecrets);
    if (!hasProviderSecrets(providerSecrets)) return null;
    const id = makeGrantId();
    const ownerUserId = cleanOwnerUserId(args.ownerUserId);
    const ttlSeconds = Math.max(30, args.ttlSeconds ?? this.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const encrypted = encryptGrant({
      key: this.key,
      id,
      ownerUserId,
      purpose: args.purpose,
      providerSecrets,
      expiresAt,
    });
    const rows = await this.sql`
      insert into rlm_secret_grants (
        id, owner_user_id, purpose, iv, tag, ciphertext, expires_at
      )
      values (
        ${id},
        ${ownerUserId},
        ${args.purpose},
        ${encrypted.iv},
        ${encrypted.tag},
        ${encrypted.ciphertext},
        ${new Date(expiresAt)}
      )
      returning id, expires_at
    `;
    return { id: String(rows[0].id), expiresAt: toIso(rows[0].expires_at) };
  }

  async read(id: string, ownerUserId: string): Promise<ProviderSecrets | null> {
    const rows = await this.sql`
      select * from rlm_secret_grants
      where id = ${id}
        and owner_user_id = ${cleanOwnerUserId(ownerUserId)}
        and revoked_at is null
        and expires_at > now()
    `;
    if (!rows[0]) return null;
    return decryptGrant(this.key, normalizeStoredGrant(rows[0]));
  }

  async revoke(id: string, ownerUserId: string, reason?: string): Promise<boolean> {
    const rows = await this.sql`
      update rlm_secret_grants
      set revoked_at = coalesce(revoked_at, now()),
          revoked_reason = coalesce(revoked_reason, ${reason ?? null})
      where id = ${id} and owner_user_id = ${cleanOwnerUserId(ownerUserId)}
      returning id
    `;
    return Boolean(rows[0]);
  }

  async stats(): Promise<SecretGrantStats> {
    const rows = await this.sql`
      select
        count(*) filter (where revoked_at is null and expires_at > now())::int as active,
        count(*) filter (where revoked_at is null and expires_at <= now())::int as expired,
        count(*) filter (where revoked_at is not null)::int as revoked
      from rlm_secret_grants
    `;
    const stats = emptyStats(this.mode, this.configured, this.ttlSeconds);
    stats.active = Number(rows[0]?.active ?? 0);
    stats.expired = Number(rows[0]?.expired ?? 0);
    stats.revoked = Number(rows[0]?.revoked ?? 0);
    return stats;
  }

  private async migrate(): Promise<void> {
    await this.sql`
      create table if not exists rlm_secret_grants (
        id text primary key,
        owner_user_id text not null default 'legacy',
        purpose text not null,
        iv text not null,
        tag text not null,
        ciphertext text not null,
        expires_at timestamptz not null,
        revoked_at timestamptz,
        revoked_reason text,
        created_at timestamptz not null default now()
      )
    `;
    await this.sql`
      create index if not exists rlm_secret_grants_owner_active_idx
      on rlm_secret_grants (owner_user_id, expires_at desc)
      where revoked_at is null
    `;
    await this.sql`
      create index if not exists rlm_secret_grants_expiry_idx
      on rlm_secret_grants (expires_at)
    `;
  }
}
