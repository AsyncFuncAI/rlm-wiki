import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JCodeModelPricing = {
  prompt: string | null;
  completion: string | null;
  input_cache_read: string | null;
  input_cache_write: string | null;
};

type JCodeModelInfo = {
  id: string;
  name: string;
  context_length: number | null;
  pricing: JCodeModelPricing;
  created?: number | null;
};

type JCodeModelCache = {
  cached_at: number;
  models: JCodeModelInfo[];
};

const OPENAI_COMPAT_NAMESPACE = "openai-compatible";
const OPENROUTER_NAMESPACE = "openrouter";
const DEFAULT_CONTEXT_LENGTH = 1_000_000;

function cacheNamespace(providerArg: string, env?: Record<string, string | undefined>): string | null {
  const provider = providerArg.trim().toLowerCase();
  if (provider === "openai-compatible") return OPENAI_COMPAT_NAMESPACE;
  if (provider === "openrouter") return sanitizeNamespace(env?.JCODE_OPENROUTER_CACHE_NAMESPACE) || OPENROUTER_NAMESPACE;
  return null;
}

function sanitizeNamespace(value?: string): string | null {
  const sanitized = value
    ?.trim()
    .split("")
    .filter((char) => /[a-zA-Z0-9_-]/.test(char))
    .join("");
  return sanitized || null;
}

function cachePath(namespace: string): string {
  return join(homedir(), ".jcode", "cache", `${namespace}_models.json`);
}

function readCache(path: string): JCodeModelCache {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<JCodeModelCache>;
    return {
      cached_at: Number.isFinite(parsed.cached_at) ? Number(parsed.cached_at) : nowSeconds(),
      models: Array.isArray(parsed.models) ? parsed.models.filter(isModelInfo) : [],
    };
  } catch {
    return { cached_at: nowSeconds(), models: [] };
  }
}

function isModelInfo(value: unknown): value is JCodeModelInfo {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<JCodeModelInfo>;
  return typeof maybe.id === "string" && typeof maybe.name === "string";
}

function modelEntry(model: string): JCodeModelInfo {
  return {
    id: model,
    name: model,
    context_length: DEFAULT_CONTEXT_LENGTH,
    pricing: {
      prompt: "0",
      completion: "0",
      input_cache_read: null,
      input_cache_write: null,
    },
    created: nowSeconds(),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function ensureJCodeModelCacheForRun(
  providerArg: string,
  model: string,
  env?: Record<string, string | undefined>,
): void {
  const namespace = cacheNamespace(providerArg, env);
  const modelId = model.trim();
  if (!namespace || !modelId) return;

  try {
    const path = cachePath(namespace);
    const cache = readCache(path);
    const next = modelEntry(modelId);
    const models = cache.models.filter((entry) => entry.id !== modelId);
    models.unshift(next);
    mkdirSync(join(homedir(), ".jcode", "cache"), { recursive: true });
    writeFileSync(path, JSON.stringify({ cached_at: nowSeconds(), models } satisfies JCodeModelCache));
  } catch {
    // Cache seeding is an upstream JCODE deadlock workaround, not part of the
    // user run contract. If it fails, let JCODE surface the provider error.
  }
}
