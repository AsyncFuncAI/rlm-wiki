import {
  createComposioToolkitSession,
  listComposioConnectedApps,
  type CapabilityProfileOptions,
} from "./agent-capabilities.ts";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_HEADERS = [
  { in: "header" as const, name: "Accept", value: "application/vnd.github+json" },
  { in: "header" as const, name: "X-GitHub-Api-Version", value: "2022-11-28" },
];

type ComposioSession = Awaited<ReturnType<typeof createComposioToolkitSession>>;

export type GitHubFetch = (path: string, extraHeaders?: Record<string, string>) => Promise<Response>;

export class GitHubConnectionRequiredError extends Error {
  constructor(message = "Connect GitHub before reviewing pull requests.") {
    super(message);
    this.name = "GitHubConnectionRequiredError";
  }
}

export interface GitHubConnectionStatus {
  connected: boolean;
  provider: "env" | "github" | "none";
  configured: boolean;
  message?: string;
}

export async function reviewGitHubConnectionStatus(
  root: string,
  opts: CapabilityProfileOptions = {},
): Promise<GitHubConnectionStatus> {
  if (process.env.GITHUB_TOKEN?.trim()) {
    return { connected: true, provider: "env", configured: true };
  }
  try {
    const connected = await listComposioConnectedApps(root, opts);
    const github = connected.items.find((item) => item.slug === "github");
    const active = Boolean(github && (github.isActive || github.isNoAuth));
    return {
      connected: active,
      provider: active ? "github" : "none",
      configured: connected.configured,
      message: active
        ? undefined
        : github
          ? "GitHub is not connected yet."
          : "Connect GitHub before running Code or Review.",
    };
  } catch (error) {
    return {
      connected: false,
      provider: "none",
      configured: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createReviewGitHubFetch(
  root: string,
  opts: CapabilityProfileOptions = {},
): Promise<GitHubFetch> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) return envGitHubFetch(envToken);

  const status = await reviewGitHubConnectionStatus(root, opts);
  if (!status.connected) {
    throw new GitHubConnectionRequiredError(status.message || "Connect GitHub before reviewing pull requests.");
  }

  const session = await createComposioToolkitSession(root, ["github"], true, opts);
  return composioGitHubFetch(session);
}

function envGitHubFetch(token: string): GitHubFetch {
  return async (path, extraHeaders = {}) => fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "rlm-wiki-review",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
}

function composioGitHubFetch(session: ComposioSession): GitHubFetch {
  return async (path, extraHeaders = {}) => {
    if (wantsDiff(extraHeaders)) {
      const synthetic = await syntheticPullRequestDiff(session, path);
      if (synthetic) return new Response(synthetic, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const response = await session.proxyExecute({
      toolkit: "github",
      endpoint: path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`,
      method: "GET",
      parameters: headerParameters(extraHeaders),
    });
    return responseFromProxy(response.status, response.data);
  };
}

function wantsDiff(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === "accept" && /\bdiff\b/i.test(value));
}

async function syntheticPullRequestDiff(session: ComposioSession, path: string): Promise<string | null> {
  const parsed = path.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\?.*)?$/);
  if (!parsed) return null;
  const [, owner, repo, number] = parsed;
  const files: Array<{ filename?: string; previous_filename?: string; status?: string; patch?: string }> = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await session.proxyExecute({
      toolkit: "github",
      endpoint: `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      method: "GET",
      parameters: GITHUB_HEADERS,
    });
    if (Number(response.status) !== 200 || !Array.isArray(response.data)) break;
    files.push(...response.data);
    if (response.data.length < 100) break;
  }
  if (!files.length) return "";
  return files.map((file) => {
    const filename = file.filename || "unknown";
    const previous = file.previous_filename || filename;
    const from = file.status === "added" ? "/dev/null" : `a/${previous}`;
    const to = file.status === "removed" ? "/dev/null" : `b/${filename}`;
    return [
      `diff --git a/${previous} b/${filename}`,
      `--- ${from}`,
      `+++ ${to}`,
      file.patch || "",
    ].join("\n");
  }).join("\n");
}

function headerParameters(extraHeaders: Record<string, string>) {
  const merged = new Map<string, string>();
  for (const header of GITHUB_HEADERS) merged.set(header.name.toLowerCase(), header.value);
  for (const [name, value] of Object.entries(extraHeaders)) merged.set(name.toLowerCase(), value);
  return Array.from(merged.entries()).map(([name, value]) => ({
    in: "header" as const,
    name,
    value,
  }));
}

function responseFromProxy(status: unknown, data: unknown): Response {
  const body = typeof data === "string"
    ? data
    : data == null
      ? ""
      : JSON.stringify(data);
  return new Response(body, {
    status: Number(status) || 500,
    headers: {
      "content-type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    },
  });
}
