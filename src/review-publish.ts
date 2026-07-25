import type { ProductRun } from "./persistence.ts";
import { createComposioToolkitSession } from "./agent-capabilities.ts";
import { parsePRURL } from "./jcode-runtime.ts";
import type { ReviewIssue } from "./review.ts";

const GITHUB_HEADERS = [
  { in: "header" as const, name: "Accept", value: "application/vnd.github+json" },
  { in: "header" as const, name: "X-GitHub-Api-Version", value: "2022-11-28" },
];

type ComposioSession = Awaited<ReturnType<typeof createComposioToolkitSession>>;

interface GithubProxyResponse<T = unknown> {
  status: number;
  data: T;
}

interface GithubIssueComment {
  id?: number;
  html_url?: string;
  body?: string;
  created_at?: string;
}

export interface ReviewCommentPublishResult {
  provider: "composio-github-proxy" | "env-github-token";
  kind: "review" | "investigation";
  owner: string;
  repo: string;
  number: number;
  url: string;
  id: number | null;
  postedAt: string;
  alreadyPublished?: boolean;
}

export interface ReviewCommentPublishOptions {
  confirm?: boolean;
  defaultComposioUserId?: string;
}

export async function publishReviewRunComment(
  root: string,
  run: ProductRun,
  options: ReviewCommentPublishOptions = {},
): Promise<ReviewCommentPublishResult> {
  if (options.confirm !== true) throw new Error("Posting to GitHub requires explicit confirmation");
  if (run.kind !== "review" && run.kind !== "investigate") throw new Error("Only Review runs can be posted to GitHub");
  if (run.status !== "done") throw new Error("Wait for the review or investigation to finish before posting it");

  const result = jsonObject(run.result);
  const existingKey = run.kind === "investigate" ? "investigationComment" : "reviewComment";
  const existing = jsonObject(result[existingKey]);
  if (typeof existing.url === "string" && existing.url) {
    return {
      provider: String(existing.provider || "") === "env-github-token" ? "env-github-token" : "composio-github-proxy",
      kind: run.kind === "investigate" ? "investigation" : "review",
      owner: String(existing.owner || ""),
      repo: String(existing.repo || ""),
      number: Number(existing.number || 0),
      url: existing.url,
      id: Number(existing.id || 0) || null,
      postedAt: String(existing.postedAt || new Date().toISOString()),
      alreadyPublished: true,
    };
  }

  const target = reviewTargetFromRun(run);
  const body = run.kind === "investigate"
    ? investigationCommentBody(run, result)
    : reviewCommentBody(run, result);

  const endpoint = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}/comments`;
  const envToken = process.env.GITHUB_TOKEN?.trim();
  const provider: ReviewCommentPublishResult["provider"] = envToken ? "env-github-token" : "composio-github-proxy";
  const comment = envToken
    ? await githubWithToken<GithubIssueComment>(envToken, "POST", endpoint, { body }, [201])
    : await github<GithubIssueComment>(
      await createComposioToolkitSession(root, ["github"], true, {
        defaultUserId: options.defaultComposioUserId,
      }),
      "POST",
      endpoint,
      { body },
      [201],
    );
  return {
    provider,
    kind: run.kind === "investigate" ? "investigation" : "review",
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    url: required(comment.html_url, "GitHub did not return a comment URL"),
    id: Number(comment.id || 0) || null,
    postedAt: String(comment.created_at || new Date().toISOString()),
  };
}

function reviewTargetFromRun(run: ProductRun): { owner: string; repo: string; number: number } {
  const input = jsonObject(run.input);
  const review = jsonObject(input.review);
  const owner = String(review.owner || "");
  const repo = String(review.repo || "");
  const number = Number(review.number || 0);
  if (owner && repo && number > 0) return { owner, repo, number };

  const url = String(input.url || "");
  const parsed = parsePRURL(url);
  if (parsed) return parsed;
  throw new Error("Could not resolve the GitHub pull request for this run");
}

function reviewCommentBody(run: ProductRun, result: Record<string, unknown>): string {
  const answer = String(result.answer || "").trim();
  if (!answer) throw new Error("This review run has no review response to post");
  return [
    `<!-- rlm-wiki:review:${run.id} -->`,
    "## rlm-wiki review",
    "",
    answer,
    "",
    "---",
    "_Posted from rlm-wiki._",
  ].join("\n");
}

function investigationCommentBody(run: ProductRun, result: Record<string, unknown>): string {
  const issues = Array.isArray(result.issues)
    ? result.issues.map(normalizeIssue).filter((issue): issue is ReviewIssue => issue !== null)
    : [];
  const bugs = issues.filter((issue) => issue.category === "bug");
  const flags = issues.filter((issue) => issue.category !== "bug");
  if (!bugs.length && !flags.length) throw new Error("This investigation did not find bugs or flags to post");

  const sections = [
    `<!-- rlm-wiki:investigation:${run.id} -->`,
    "## rlm-wiki bugs / flags",
    "",
    String(result.summaryMarkdown || "").trim(),
    "",
    `**Bugs:** ${bugs.length} · **Flags:** ${flags.length}`,
  ].filter(Boolean);

  if (bugs.length) {
    sections.push("", "### Bugs", ...bugs.map((issue, index) => formatIssue(issue, index + 1)));
  }
  if (flags.length) {
    sections.push("", "### Flags", ...flags.map((issue, index) => formatIssue(issue, index + 1)));
  }
  sections.push("", "---", "_Posted from rlm-wiki._");
  return sections.join("\n");
}

function formatIssue(issue: ReviewIssue, index: number): string {
  const citation = issue.citations?.[0];
  const location = citation
    ? `${citation.path}:${citation.startLine}${citation.endLine && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}`
    : "No exact diff line";
  const lines = [
    `#### ${index}. ${issue.title || "Review note"}`,
    "",
    `- Severity: ${issue.severity || "medium"}`,
    `- Location: ${location}`,
    "",
    issue.explanationMarkdown || "",
  ];
  if (issue.fixSuggestions?.length) {
    lines.push("", "Suggested fix:", ...issue.fixSuggestions.map((fix) => `- ${fix}`));
  }
  if (issue.testsToAdd?.length) {
    lines.push("", "Tests to add:", ...issue.testsToAdd.map((test) => `- ${test}`));
  }
  return lines.join("\n");
}

function normalizeIssue(value: unknown): ReviewIssue | null {
  const row = jsonObject(value);
  const title = String(row.title || "").trim();
  if (!title) return null;
  const category = String(row.category || "").toLowerCase();
  const severity = String(row.severity || "medium").toLowerCase();
  return {
    title,
    severity: severity === "critical" || severity === "high" || severity === "medium" || severity === "low" ? severity : "medium",
    category: category === "bug" || category === "investigation" || category === "informational" ? category : "informational",
    explanationMarkdown: String(row.explanationMarkdown || row.explanation || ""),
    citations: Array.isArray(row.citations) ? row.citations.map(normalizeCitation).filter((item): item is ReviewIssue["citations"][number] => item !== null) : [],
    fixSuggestions: Array.isArray(row.fixSuggestions) ? row.fixSuggestions.map(String).filter(Boolean) : [],
    testsToAdd: Array.isArray(row.testsToAdd) ? row.testsToAdd.map(String).filter(Boolean) : [],
  };
}

function normalizeCitation(value: unknown): ReviewIssue["citations"][number] | null {
  const row = jsonObject(value);
  const path = String(row.path || "").trim();
  const startLine = Number(row.startLine || row.start_line || row.line || 0);
  if (!path || !Number.isFinite(startLine) || startLine <= 0) return null;
  const endLine = Number(row.endLine || row.end_line || startLine);
  const side = String(row.side || "unified").toLowerCase();
  return {
    path,
    side: side === "additions" || side === "deletions" ? side : "unified",
    startLine,
    endLine: Number.isFinite(endLine) && endLine > 0 ? endLine : startLine,
    label: typeof row.label === "string" ? row.label : undefined,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

async function github<T>(
  session: ComposioSession,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  endpoint: string,
  body: unknown,
  okStatuses: number[],
): Promise<T> {
  const response = await githubRaw<T>(session, method, endpoint, body);
  await expectGithub(response, okStatuses, `GitHub ${method} ${endpoint} failed`);
  return response.data;
}

async function githubWithToken<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  endpoint: string,
  body: unknown,
  okStatuses: number[],
): Promise<T> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rlm-wiki-review",
      Authorization: `Bearer ${token}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!okStatuses.includes(response.status)) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`GitHub ${method} ${endpoint} failed (${response.status}): ${message}`);
  }
  return data as T;
}

async function githubRaw<T = unknown>(
  session: ComposioSession,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  endpoint: string,
  body?: unknown,
): Promise<GithubProxyResponse<T>> {
  const response = await session.proxyExecute({
    toolkit: "github",
    endpoint: endpoint.startsWith("http") ? endpoint : `https://api.github.com${endpoint}`,
    method,
    ...(body === undefined ? {} : { body }),
    parameters: GITHUB_HEADERS,
  });
  return {
    status: Number(response.status),
    data: response.data as T,
  };
}

async function expectGithub<T>(response: GithubProxyResponse<T>, okStatuses: number[], prefix: string): Promise<void> {
  if (okStatuses.includes(response.status)) return;
  const data = jsonObject(response.data);
  const detail = typeof data.message === "string" && data.message
    ? data.message
    : JSON.stringify(response.data).slice(0, 800);
  throw new Error(`${prefix}: ${response.status}${detail ? ` ${detail}` : ""}`);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required(value: unknown, message: string): string {
  const text = String(value || "");
  if (!text) throw new Error(message);
  return text;
}
