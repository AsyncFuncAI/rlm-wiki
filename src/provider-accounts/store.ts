import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAccountsFile, ProviderAccountsRoster } from "./types.ts";

function emptyRoster(): ProviderAccountsRoster {
  return { accounts: [], activeAccountId: null };
}

function defaultFile(): ProviderAccountsFile {
  return { version: 1, claude: emptyRoster(), codex: emptyRoster() };
}

export function providerAccountsRoot(appDataDir?: string | null): string {
  const base =
    (appDataDir && appDataDir.trim()) ||
    process.env.RLM_WIKI_DESKTOP_APP_DATA?.trim() ||
    process.env.RLM_WIKI_DESKTOP_APP_DATA?.trim() ||
    join(homedir(), ".rlm-wiki");
  return join(base, "provider-accounts");
}

export function providerAccountsFilePath(appDataDir?: string | null): string {
  return join(providerAccountsRoot(appDataDir), "accounts.json");
}

export function managedHomesRoot(
  provider: "claude" | "codex",
  appDataDir?: string | null,
): string {
  return join(providerAccountsRoot(appDataDir), provider);
}

export function readProviderAccountsFile(appDataDir?: string | null): ProviderAccountsFile {
  const path = providerAccountsFilePath(appDataDir);
  if (!existsSync(path)) return defaultFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderAccountsFile;
    if (!parsed || parsed.version !== 1) return defaultFile();
    return {
      version: 1,
      claude: normalizeRoster(parsed.claude),
      codex: normalizeRoster(parsed.codex),
    };
  } catch {
    return defaultFile();
  }
}

export function writeProviderAccountsFile(
  file: ProviderAccountsFile,
  appDataDir?: string | null,
): void {
  const root = providerAccountsRoot(appDataDir);
  mkdirSync(root, { recursive: true });
  writeFileSync(providerAccountsFilePath(appDataDir), JSON.stringify(file, null, 2), "utf8");
}

function normalizeRoster(value: unknown): ProviderAccountsRoster {
  if (!value || typeof value !== "object") return emptyRoster();
  const raw = value as ProviderAccountsRoster;
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.filter(
        (account) =>
          account &&
          typeof account.id === "string" &&
          typeof account.homePath === "string" &&
          typeof account.email === "string",
      )
    : [];
  const activeAccountId =
    typeof raw.activeAccountId === "string" && accounts.some((a) => a.id === raw.activeAccountId)
      ? raw.activeAccountId
      : null;
  return { accounts, activeAccountId };
}
