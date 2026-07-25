// GitHub PR Fetcher — zero-dependency client for the GitHub REST API v3

// ─── Interfaces ──────────────────────────────────────────────

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSHA: string;
  baseSHA: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergeableState: string;
  labels: string[];
}

export interface PRDiff {
  diff: string;
  changedFiles: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
}

export interface PRConversation {
  issueComments: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }[];
  reviewComments: {
    id: number;
    author: string;
    body: string;
    path: string;
    line: number;
    side: string;
    createdAt: string;
    updatedAt: string;
    resolved?: boolean;
  }[];
  reviews: {
    id: number;
    author: string;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
    body: string;
    submittedAt: string;
  }[];
  commitMessages: string[];
}

export interface PRData {
  info: PRInfo;
  diff: PRDiff;
  conversation: PRConversation;
}

export type GitHubFetch = (path: string, extraHeaders?: Record<string, string>) => Promise<Response>;

// ─── URL Parser ──────────────────────────────────────────────

export function parsePRURL(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

// ─── Helpers ─────────────────────────────────────────────────

const API_BASE = "https://api.github.com";

async function resolveToken(token?: string): Promise<string | undefined> {
  if (token) return token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const result = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0 && result.stdout) {
      const text = new TextDecoder().decode(result.stdout).trim();
      if (text) return text;
    }
  } catch {
    // gh CLI not installed — fail silently
  }
  return undefined;
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "rlm-pr-fetcher",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghFetch(path: string, token?: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...authHeaders(token), ...extraHeaders },
  });

  if (res.status === 404) {
    throw new Error(`GitHub API 404: ${path} not found`);
  }
  if (res.status === 403) {
    const msg = await res.text();
    throw new Error(`GitHub API 403: Access denied or rate limited. ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  return res;
}

async function checkedGitHubFetch(fetcher: GitHubFetch, path: string, extraHeaders?: Record<string, string>): Promise<Response> {
  const res = await fetcher(path, extraHeaders);
  if (res.status === 404) {
    throw new Error(`GitHub API 404: ${path} not found`);
  }
  if (res.status === 403) {
    const msg = await res.text();
    throw new Error(`GitHub API 403: Access denied or rate limited. ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  return res;
}

async function paginateJSON<T>(
  path: string,
  apiFetch: (path: string, extraHeaders?: Record<string, string>) => Promise<Response>
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await apiFetch(`${path}${sep}per_page=100&page=${page}`);
    const data: T[] = await res.json();
    if (data.length === 0) break;
    results.push(...data);
    page++;
  }
  return results;
}

// ─── Fetcher ─────────────────────────────────────────────────

export async function fetchPRData(
  owner: string,
  repo: string,
  prNumber: number,
  opts?: { githubToken?: string; maxDiffBytes?: number; githubFetch?: GitHubFetch }
): Promise<PRData> {
  const token = opts?.githubFetch ? undefined : await resolveToken(opts?.githubToken);
  const maxDiffBytes = opts?.maxDiffBytes ?? 500_000;
  const base = `/repos/${owner}/${repo}`;
  const apiFetch = opts?.githubFetch
    ? (path: string, extraHeaders?: Record<string, string>) => checkedGitHubFetch(opts.githubFetch!, path, extraHeaders)
    : (path: string, extraHeaders?: Record<string, string>) => ghFetch(path, token, extraHeaders);

  // Fetch metadata + diff + comments in parallel
  const [prRes, diffRes, issueComments, reviewComments, reviews, commits, filesRes] =
    await Promise.all([
      apiFetch(`${base}/pulls/${prNumber}`),
      apiFetch(`${base}/pulls/${prNumber}`, {
        Accept: "application/vnd.github.v3.diff",
      }),
      paginateJSON<any>(`${base}/issues/${prNumber}/comments`, apiFetch),
      paginateJSON<any>(`${base}/pulls/${prNumber}/comments`, apiFetch),
      paginateJSON<any>(`${base}/pulls/${prNumber}/reviews`, apiFetch),
      paginateJSON<any>(`${base}/pulls/${prNumber}/commits`, apiFetch),
      apiFetch(`${base}/pulls/${prNumber}/files?per_page=100`),
    ]);

  const pr = await prRes.json();

  // Diff with truncation
  let diff = await diffRes.text();
  if (diff.length > maxDiffBytes) {
    diff = diff.slice(0, maxDiffBytes) + "\n\n... [diff truncated at " + maxDiffBytes + " bytes] ...";
  }

  const files: any[] = await filesRes.json();

  // Build PRData
  const info: PRInfo = {
    owner,
    repo,
    number: prNumber,
    title: pr.title ?? "",
    body: pr.body ?? "",
    state: pr.state ?? "",
    draft: pr.draft ?? false,
    baseBranch: pr.base?.ref ?? "",
    headBranch: pr.head?.ref ?? "",
    headSHA: pr.head?.sha ?? "",
    baseSHA: pr.base?.sha ?? "",
    author: pr.user?.login ?? "",
    createdAt: pr.created_at ?? "",
    updatedAt: pr.updated_at ?? "",
    mergeableState: pr.mergeable_state ?? "",
    labels: (pr.labels ?? []).map((l: any) => l.name),
  };

  const prDiff: PRDiff = {
    diff,
    changedFiles: files.map((f: any) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };

  const conversation: PRConversation = {
    issueComments: issueComments.map((c: any) => ({
      id: c.id,
      author: c.user?.login ?? "",
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
      updatedAt: c.updated_at ?? "",
    })),
    reviewComments: reviewComments.map((c: any) => ({
      id: c.id,
      author: c.user?.login ?? "",
      body: c.body ?? "",
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? 0,
      side: c.side ?? "RIGHT",
      createdAt: c.created_at ?? "",
      updatedAt: c.updated_at ?? "",
      resolved: c.resolved ?? undefined,
    })),
    reviews: reviews.map((r: any) => ({
      id: r.id,
      author: r.user?.login ?? "",
      state: r.state ?? "COMMENTED",
      body: r.body ?? "",
      submittedAt: r.submitted_at ?? "",
    })),
    commitMessages: commits.map((c: any) => c.commit?.message ?? ""),
  };

  return { info, diff: prDiff, conversation };
}
