import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getGrokAccountStatus,
  readClaudeIdentity,
  readCodexIdentity,
  defaultClaudeConfigDir,
  defaultCodexHome,
} from "./identities.ts";
import {
  captureClaudeLogin,
  captureCodexLogin,
  writeClaudeManagedHome,
} from "./login-capture.ts";
import {
  managedHomesRoot,
  readProviderAccountsFile,
  writeProviderAccountsFile,
} from "./store.ts";
import type {
  AddAccountResult,
  ManagedProviderAccount,
  ProviderAccountsRoster,
  ProviderAccountsSnapshot,
} from "./types.ts";

export type ProviderAccountsOptions = {
  appDataDir?: string | null;
};

function formatOrgLabel(organizationName?: string | null): string | null {
  const value = organizationName?.trim();
  if (!value) return null;
  // Claude personal orgs often look like "name@email.com's Organization".
  // Orca shows those as "Personal".
  if (/'s Organization$/i.test(value) || /^personal$/i.test(value)) return "Personal";
  return value;
}

function isUnsignedStub(account: ManagedProviderAccount, hasAuth: boolean): boolean {
  if (hasAuth) return false;
  if ((account.lastAuthenticatedAt || 0) === 0) return true;
  const email = (account.email || "").trim().toLowerCase();
  return !email || email === "sign in pending";
}

function refreshRosterIdentities(
  provider: "claude" | "codex",
  roster: ProviderAccountsRoster,
  options: ProviderAccountsOptions = {},
): ProviderAccountsRoster {
  const root = managedHomesRoot(provider, options.appDataDir);
  const kept: ManagedProviderAccount[] = [];
  for (const account of roster.accounts) {
    const identity =
      provider === "claude"
        ? readClaudeIdentity(account.homePath)
        : readCodexIdentity(account.homePath);
    // Drop legacy "Sign in pending" stubs from the old pre-capture Add Account path.
    if (isUnsignedStub(account, identity.hasAuth)) {
      if (account.homePath.startsWith(root) && existsSync(account.homePath)) {
        rmSync(account.homePath, { recursive: true, force: true });
      }
      continue;
    }
    const email =
      (account.email && account.email !== "Sign in pending" ? account.email : null) ||
      identity.email ||
      (identity.hasAuth ? `${provider} account` : "Sign in pending");
    const orgFromIdentity =
      provider === "claude" && "organizationName" in identity
        ? formatOrgLabel((identity as { organizationName?: string | null }).organizationName)
        : null;
    kept.push({
      ...account,
      email,
      label: account.label || orgFromIdentity || null,
      updatedAt: identity.hasAuth ? Math.max(account.updatedAt, Date.now()) : account.updatedAt,
      lastAuthenticatedAt: identity.hasAuth
        ? Math.max(account.lastAuthenticatedAt || 0, Date.now())
        : account.lastAuthenticatedAt,
    });
  }
  let activeAccountId =
    roster.activeAccountId && kept.some((a) => a.id === roster.activeAccountId)
      ? roster.activeAccountId
      : null;
  if (activeAccountId) {
    const active = kept.find((a) => a.id === activeAccountId);
    if (active?.email === "Sign in pending" || (active?.lastAuthenticatedAt || 0) === 0) {
      activeAccountId = null;
    }
  }
  return { accounts: kept, activeAccountId };
}

export function getProviderAccountsSnapshot(
  options: ProviderAccountsOptions = {},
): ProviderAccountsSnapshot {
  const file = readProviderAccountsFile(options.appDataDir);
  // Persist cleanup of invalid active selection and legacy unsigned stubs.
  const claude = refreshRosterIdentities("claude", file.claude, options);
  const codex = refreshRosterIdentities("codex", file.codex, options);
  const claudeChanged =
    claude.activeAccountId !== file.claude.activeAccountId ||
    claude.accounts.length !== file.claude.accounts.length ||
    claude.accounts.some((a, i) => a.id !== file.claude.accounts[i]?.id || a.email !== file.claude.accounts[i]?.email);
  const codexChanged =
    codex.activeAccountId !== file.codex.activeAccountId ||
    codex.accounts.length !== file.codex.accounts.length ||
    codex.accounts.some((a, i) => a.id !== file.codex.accounts[i]?.id || a.email !== file.codex.accounts[i]?.email);
  if (claudeChanged || codexChanged) {
    writeProviderAccountsFile(
      { version: 1, claude, codex },
      options.appDataDir,
    );
  }
  return {
    claude,
    codex,
    grok: getGrokAccountStatus(),
    roots: {
      claude: managedHomesRoot("claude", options.appDataDir),
      codex: managedHomesRoot("codex", options.appDataDir),
    },
  };
}

export function getActiveClaudeConfigDir(options: ProviderAccountsOptions = {}): string {
  const roster = getProviderAccountsSnapshot(options).claude;
  if (!roster.activeAccountId) return defaultClaudeConfigDir();
  const account = roster.accounts.find((a) => a.id === roster.activeAccountId);
  return account?.homePath || defaultClaudeConfigDir();
}

export function getActiveCodexHome(options: ProviderAccountsOptions = {}): string {
  const roster = getProviderAccountsSnapshot(options).codex;
  if (!roster.activeAccountId) return defaultCodexHome();
  const account = roster.accounts.find((a) => a.id === roster.activeAccountId);
  return account?.homePath || defaultCodexHome();
}

export function selectProviderAccount(
  provider: "claude" | "codex",
  accountId: string | null,
  options: ProviderAccountsOptions = {},
): ProviderAccountsSnapshot {
  const file = readProviderAccountsFile(options.appDataDir);
  const roster = file[provider];
  if (accountId !== null) {
    const account = roster.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`Unknown ${provider} account.`);
    const identity =
      provider === "claude"
        ? readClaudeIdentity(account.homePath)
        : readCodexIdentity(account.homePath);
    if (!identity.hasAuth && (account.lastAuthenticatedAt || 0) === 0) {
      throw new Error(
        `That ${provider} account is not signed in yet. Click Re-authenticate and complete browser login.`,
      );
    }
  }
  file[provider] = { ...roster, activeAccountId: accountId };
  writeProviderAccountsFile(file, options.appDataDir);
  return getProviderAccountsSnapshot(options);
}

/**
 * Orca-style Add Account: open CLI login in an isolated home, capture credentials,
 * and store a real email/org. Does not leave "Sign in pending" stubs on success.
 */
export async function addProviderAccount(
  provider: "claude" | "codex",
  options: ProviderAccountsOptions = {},
): Promise<AddAccountResult> {
  const file = readProviderAccountsFile(options.appDataDir);
  const id = randomUUID();
  const root = managedHomesRoot(provider, options.appDataDir);
  const homePath = join(root, id);
  mkdirSync(homePath, { recursive: true });
  const now = Date.now();

  try {
    if (provider === "claude") {
      const captured = await captureClaudeLogin();
      writeClaudeManagedHome(homePath, captured);
      const account: ManagedProviderAccount = {
        id,
        email: captured.email,
        homePath,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now,
        label: formatOrgLabel(captured.organizationName),
      };
      file.claude = {
        accounts: [...file.claude.accounts, account],
        // Keep current active selection (system default or prior account).
        activeAccountId: file.claude.activeAccountId,
      };
      writeProviderAccountsFile(file, options.appDataDir);
      return {
        snapshot: getProviderAccountsSnapshot(options),
        account,
        loginCommand: "",
        loginHint: "",
      };
    }

    // Codex: login writes auth.json into CODEX_HOME = managed home.
    const captured = await captureCodexLogin(homePath);
    const account: ManagedProviderAccount = {
      id,
      email: captured.email,
      homePath,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now,
      label: captured.workspaceLabel,
    };
    file.codex = {
      accounts: [...file.codex.accounts, account],
      activeAccountId: file.codex.activeAccountId,
    };
    writeProviderAccountsFile(file, options.appDataDir);
    return {
      snapshot: getProviderAccountsSnapshot(options),
      account,
      loginCommand: "",
      loginHint: "",
    };
  } catch (error) {
    // Roll back empty managed home on failure (Orca does the same).
    if (existsSync(homePath)) {
      rmSync(homePath, { recursive: true, force: true });
    }
    throw error;
  }
}

export function removeProviderAccount(
  provider: "claude" | "codex",
  accountId: string,
  options: ProviderAccountsOptions = {},
): ProviderAccountsSnapshot {
  const file = readProviderAccountsFile(options.appDataDir);
  const roster = file[provider];
  const account = roster.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown ${provider} account.`);
  file[provider] = {
    accounts: roster.accounts.filter((a) => a.id !== accountId),
    activeAccountId: roster.activeAccountId === accountId ? null : roster.activeAccountId,
  };
  writeProviderAccountsFile(file, options.appDataDir);
  const root = managedHomesRoot(provider, options.appDataDir);
  if (account.homePath.startsWith(root) && existsSync(account.homePath)) {
    rmSync(account.homePath, { recursive: true, force: true });
  }
  return getProviderAccountsSnapshot(options);
}

/**
 * Re-run CLI login for an existing managed account and update email/org metadata.
 */
export async function reauthProviderAccount(
  provider: "claude" | "codex",
  accountId: string,
  options: ProviderAccountsOptions = {},
): Promise<{
  snapshot: ProviderAccountsSnapshot;
  account: ManagedProviderAccount;
  loginCommand: string;
  loginHint: string;
}> {
  const file = readProviderAccountsFile(options.appDataDir);
  const roster = file[provider];
  const index = roster.accounts.findIndex((a) => a.id === accountId);
  if (index < 0) throw new Error(`Unknown ${provider} account.`);
  const existing = roster.accounts[index];
  const now = Date.now();

  if (provider === "claude") {
    const captured = await captureClaudeLogin();
    writeClaudeManagedHome(existing.homePath, captured);
    const account: ManagedProviderAccount = {
      ...existing,
      email: captured.email,
      label: formatOrgLabel(captured.organizationName) || existing.label,
      updatedAt: now,
      lastAuthenticatedAt: now,
    };
    const accounts = [...roster.accounts];
    accounts[index] = account;
    file.claude = { ...roster, accounts };
    writeProviderAccountsFile(file, options.appDataDir);
    return {
      snapshot: getProviderAccountsSnapshot(options),
      account,
      loginCommand: "",
      loginHint: "",
    };
  }

  const captured = await captureCodexLogin(existing.homePath);
  const account: ManagedProviderAccount = {
    ...existing,
    email: captured.email,
    label: captured.workspaceLabel || existing.label,
    updatedAt: now,
    lastAuthenticatedAt: now,
  };
  const accounts = [...roster.accounts];
  accounts[index] = account;
  file.codex = { ...roster, accounts };
  writeProviderAccountsFile(file, options.appDataDir);
  return {
    snapshot: getProviderAccountsSnapshot(options),
    account,
    loginCommand: "",
    loginHint: "",
  };
}
