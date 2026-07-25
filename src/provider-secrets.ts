import type { Provider } from "./llm.ts";

export const PROVIDER_SECRET_KEYS = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

export type ProviderSecretKey = typeof PROVIDER_SECRET_KEYS[number];
export type ProviderSecrets = Partial<Record<ProviderSecretKey, string>>;

const PROVIDER_SECRET_KEY_SET = new Set<string>(PROVIDER_SECRET_KEYS);

export function normalizeProviderSecrets(value: unknown): ProviderSecrets {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const secrets: ProviderSecrets = {};
  for (const key of PROVIDER_SECRET_KEYS) {
    const raw = row[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) secrets[key] = trimmed;
  }
  return secrets;
}

export function hasProviderSecrets(secrets: ProviderSecrets | undefined | null): boolean {
  return Boolean(secrets && Object.keys(secrets).length);
}

export function providerSecretsForEnv(secrets: ProviderSecrets | undefined | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets ?? {})) {
    if (value) env[key] = value;
  }
  return env;
}

export function providerSecretsForProviderEnv(
  provider: Provider,
  secrets: ProviderSecrets | undefined | null,
  includeProcessEnv = false,
): Record<string, string> {
  const env: Record<string, string> = {};
  const include = (key: ProviderSecretKey): void => {
    const value = includeProcessEnv ? secretValue(secrets, key) : secrets?.[key]?.trim();
    if (value) env[key] = value;
  };
  switch (provider) {
    case "gemini":
      include("GEMINI_API_KEY");
      break;
    case "openai":
      include("OPENAI_API_KEY");
      break;
    case "cloudflare":
      include("CLOUDFLARE_API_TOKEN");
      include("CLOUDFLARE_ACCOUNT_ID");
      break;
    case "openrouter":
      include("OPENROUTER_API_KEY");
      break;
    case "deepseek":
      include("DEEPSEEK_API_KEY");
      break;
    case "minimax":
      include("MINIMAX_API_KEY");
      break;
    case "anthropic":
      include("ANTHROPIC_API_KEY");
      break;
    case "codex":
      break;
  }
  return env;
}

export function secretValue(
  secrets: ProviderSecrets | undefined | null,
  key: ProviderSecretKey,
): string | undefined {
  return secrets?.[key]?.trim() || process.env[key]?.trim() || undefined;
}

export function requestSecretValue(
  secrets: ProviderSecrets | undefined | null,
  key: ProviderSecretKey,
): string | undefined {
  return secrets?.[key]?.trim() || undefined;
}

export function providerRequiredSecretKeys(provider: Provider): ProviderSecretKey[] {
  switch (provider) {
    case "gemini":
      return ["GEMINI_API_KEY"];
    case "openai":
      return ["OPENAI_API_KEY"];
    case "cloudflare":
      return ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
    case "openrouter":
      return ["OPENROUTER_API_KEY"];
    case "deepseek":
      return ["DEEPSEEK_API_KEY"];
    case "minimax":
      return ["MINIMAX_API_KEY"];
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "codex":
      return [];
  }
}

export function deepseekKeysFromSecrets(secrets?: ProviderSecrets | null): string[] {
  const keys: string[] = [];
  const single = secrets?.DEEPSEEK_API_KEY?.trim();
  if (single) keys.push(single);
  return Array.from(new Set(keys));
}

export function hasRequestProviderCredentials(
  provider: Provider,
  secrets?: ProviderSecrets | null,
): boolean {
  switch (provider) {
    case "gemini":
      return Boolean(requestSecretValue(secrets, "GEMINI_API_KEY"));
    case "openai":
      return Boolean(requestSecretValue(secrets, "OPENAI_API_KEY"));
    case "cloudflare":
      return Boolean(requestSecretValue(secrets, "CLOUDFLARE_API_TOKEN") && requestSecretValue(secrets, "CLOUDFLARE_ACCOUNT_ID"));
    case "openrouter":
      return Boolean(requestSecretValue(secrets, "OPENROUTER_API_KEY"));
    case "deepseek":
      return deepseekKeysFromSecrets(secrets).length > 0;
    case "minimax":
      return Boolean(requestSecretValue(secrets, "MINIMAX_API_KEY"));
    case "anthropic":
      return Boolean(requestSecretValue(secrets, "ANTHROPIC_API_KEY"));
    case "codex":
      return false;
  }
}

export function hasProviderCredentials(
  provider: Provider,
  secrets?: ProviderSecrets | null,
): boolean {
  switch (provider) {
    case "gemini":
      return Boolean(secretValue(secrets, "GEMINI_API_KEY"));
    case "openai":
      return Boolean(secretValue(secrets, "OPENAI_API_KEY"));
    case "cloudflare":
      return Boolean(secretValue(secrets, "CLOUDFLARE_API_TOKEN") && secretValue(secrets, "CLOUDFLARE_ACCOUNT_ID"));
    case "openrouter":
      return Boolean(secretValue(secrets, "OPENROUTER_API_KEY"));
    case "deepseek":
      return deepseekKeysFromSecrets(secrets).length > 0;
    case "minimax":
      return Boolean(secretValue(secrets, "MINIMAX_API_KEY"));
    case "anthropic":
      return Boolean(secretValue(secrets, "ANTHROPIC_API_KEY"));
    case "codex":
      return false;
  }
}

export function redactProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === "providerSecrets" || PROVIDER_SECRET_KEY_SET.has(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactProviderSecrets(raw);
    }
  }
  return out;
}
