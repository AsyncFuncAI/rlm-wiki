/** Provider account shapes aligned with Orca AccountsPane (host-only v1). */

export type ProviderAccountKind = "claude" | "codex" | "grok";

export type ManagedProviderAccount = {
  id: string;
  email: string;
  /** Isolated home / config dir for this profile. */
  homePath: string;
  createdAt: number;
  updatedAt: number;
  lastAuthenticatedAt: number;
  /** Optional org / workspace label when known. */
  label?: string | null;
};

export type ProviderAccountsRoster = {
  accounts: ManagedProviderAccount[];
  /** null = system default (~/.claude or ~/.codex). */
  activeAccountId: string | null;
};

export type GrokAccountStatus = {
  signedIn: boolean;
  email: string | null;
  teamId: string | null;
  tokenFresh: boolean;
  error: string | null;
  authPath: string;
};

export type ProviderAccountsSnapshot = {
  claude: ProviderAccountsRoster;
  codex: ProviderAccountsRoster;
  grok: GrokAccountStatus;
  roots: {
    claude: string;
    codex: string;
  };
};

export type ProviderAccountsFile = {
  version: 1;
  claude: ProviderAccountsRoster;
  codex: ProviderAccountsRoster;
};

export type AddAccountResult = {
  snapshot: ProviderAccountsSnapshot;
  account: ManagedProviderAccount;
  /** Shell command the user runs once to sign into this profile. */
  loginCommand: string;
  loginHint: string;
};
