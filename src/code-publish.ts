import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSource } from "./jcode-runtime.ts";
import type { ProductRun } from "./persistence.ts";
import type { RepoRef } from "./types.ts";
import { createComposioToolkitSession } from "./agent-capabilities.ts";
import { filterIgnoredPatch } from "./code-anything.ts";
import { DEFAULT_CHANNEL_ID, makeLLM, resolveChannel } from "./llm.ts";

const GIT_DIFF_PATHSPEC = ["--", ".", ":(exclude)graphify-out", ":(exclude)graphify-out/**"];
const GITHUB_HEADERS = [
  { in: "header" as const, name: "Accept", value: "application/vnd.github+json" },
  { in: "header" as const, name: "X-GitHub-Api-Version", value: "2022-11-28" },
];

type PublishMode = "create" | "update";
type ComposioSession = Awaited<ReturnType<typeof createComposioToolkitSession>>;

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GithubProxyResponse<T = unknown> {
  status: number;
  data: T;
}

interface GithubRepository {
  default_branch?: string;
  full_name?: string;
  html_url?: string;
  fork?: boolean;
  owner?: {
    login?: string;
  };
  parent?: {
    full_name?: string;
  };
  source?: {
    full_name?: string;
  };
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
  };
}

interface GithubRef {
  ref?: string;
  object?: {
    sha?: string;
    type?: string;
  };
}

interface GithubCommit {
  sha?: string;
  tree?: {
    sha?: string;
  };
}

interface GithubBlob {
  sha?: string;
}

interface GithubTree {
  sha?: string;
}

interface GithubPullRequest {
  number?: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  head?: {
    ref?: string;
    repo?: {
      name?: string;
      full_name?: string;
      owner?: {
        login?: string;
      };
    };
  };
  base?: {
    ref?: string;
    repo?: {
      name?: string;
      full_name?: string;
      owner?: {
        login?: string;
      };
    };
  };
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "commit";
  sha: string | null;
}

export interface CodePullRequestRef {
  url: string;
  number: number;
  branch: string;
  base: string;
  title: string;
  body: string;
  headOwner?: string;
  headRepo?: string;
  baseOwner?: string;
  baseRepo?: string;
  updatedAt: string;
}

export interface CodePublishBranchRef {
  url: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface CodePublishResult {
  mode: "created" | "updated";
  provider: "composio-github-proxy";
  owner: string;
  repo: string;
  target: "upstream" | "fork";
  openedPullRequest: boolean;
  changedFiles: string[];
  commitSha: string;
  branch: CodePublishBranchRef;
  pullRequest?: CodePullRequestRef | null;
  pullRequestError?: string;
}

export interface CodePublishOptions {
  mode?: PublishMode;
  title?: string;
  body?: string;
  channel?: string;
  model?: string;
  confirm?: boolean;
  openUpstreamPr?: boolean;
  defaultComposioUserId?: string;
}

interface GithubUser {
  login?: string;
}

export async function publishCodeAnythingPullRequest(
  root: string,
  run: ProductRun,
  options: CodePublishOptions = {},
): Promise<CodePublishResult> {
  if (options.confirm !== true) {
    throw new Error("Publishing requires explicit confirmation");
  }
  if (run.kind !== "code") throw new Error("Only Code Anything runs can be published");

  const input = jsonObject(run.input);
  const result = jsonObject(run.result);
  const ref = repoRefFromInput(input);
  if (!ref) throw new Error("Code session is missing its repository reference");

  const patch = publishablePatch(result);
  if (!patch) throw new Error("This Code Anything session does not have a full publishable patch yet");

  const existingPr = normalizePullRequest(result.pullRequest);
  const existingBranch = normalizeBranch(result.branch) ?? normalizeBranch(jsonObject(result.publish).branch);
  const requestedMode: PublishMode = options.mode === "update" || (options.mode !== "create" && (existingPr || existingBranch)) ? "update" : "create";
  if (requestedMode === "update" && !existingPr && !existingBranch) {
    throw new Error("There is no previously published PR or fork branch to update");
  }

  const loaded = await loadSource(ref.url, {
    branch: ref.branch,
    cache: false,
  });

  try {
    applyPatch(loaded.repoPath, patch);
    const changedFiles = collectChangedFiles(loaded.repoPath);
    if (!changedFiles.length) throw new Error("The stored patch applies cleanly but produces no changed files");

    const session = await createComposioToolkitSession(root, ["github"], true, {
      defaultUserId: options.defaultComposioUserId,
    });
    const user = await github<GithubUser>(session, "GET", "/user", undefined, [200]);
    const userLogin = required(user.login, "Could not resolve the connected GitHub user");

    const owner = ref.owner;
    const repo = ref.repo;
    const repoInfo = await github<GithubRepository>(session, "GET", repoEndpoint(owner, repo), undefined, [200]);
    const baseBranch = ref.branch || repoInfo.default_branch || "main";
    const baseRef = await github<GithubRef>(
      session,
      "GET",
      `${repoEndpoint(owner, repo)}/git/ref/heads/${encodeRefPath(baseBranch)}`,
      undefined,
      [200],
    );
    const baseSha = required(baseRef.object?.sha, `Could not resolve ${baseBranch}`);
    const baseCommit = await github<GithubCommit>(
      session,
      "GET",
      `${repoEndpoint(owner, repo)}/git/commits/${baseSha}`,
      undefined,
      [200],
    );
    const baseTreeSha = required(baseCommit.tree?.sha, `Could not resolve tree for ${baseBranch}`);

    const wantsUpstreamPr = options.openUpstreamPr !== false;
    const target = await resolvePublishTarget({
      session,
      userLogin,
      upstreamOwner: owner,
      upstreamRepo: repo,
      upstreamRepoInfo: repoInfo,
      existingPr,
      existingBranch,
      forceFork: !wantsUpstreamPr,
    });
    const fallbackTitle = draftTitleFromRun(run, result, changedFiles, existingPr?.title);
    const fallbackBody = draftBodyFromRun(run, result, changedFiles, existingPr?.body);
    const generatedDraft = options.title?.trim() && options.body?.trim()
      ? null
      : await generatePullRequestDraft({
        run,
        result,
        patch,
        changedFiles,
        existingPr,
        requestedMode,
        target,
        owner,
        repo,
        baseBranch,
        fallbackTitle,
        fallbackBody,
        channel: options.channel ?? options.model,
      });
    const title = sanitizePrTitle(options.title)
      || sanitizePrTitle(generatedDraft?.title)
      || fallbackTitle;
    const body = sanitizePrBody(options.body)
      || sanitizePrBody(generatedDraft?.body)
      || fallbackBody;

    const treeEntries = await collectTreeEntries(session, target.owner, target.repo, loaded.repoPath, changedFiles);
    const tree = await github<GithubTree>(
      session,
      "POST",
      `${repoEndpoint(target.owner, target.repo)}/git/trees`,
      { base_tree: baseTreeSha, tree: treeEntries },
      [201],
    );
    const treeSha = required(tree.sha, "GitHub did not return a tree SHA");

    const commit = await github<GithubCommit>(
      session,
      "POST",
      `${repoEndpoint(target.owner, target.repo)}/git/commits`,
      {
        message: commitMessage(title),
        tree: treeSha,
        parents: [baseSha],
      },
      [201],
    );
    const commitSha = required(commit.sha, "GitHub did not return a commit SHA");

    const branch = requestedMode === "update" && (existingPr?.branch || existingBranch?.branch)
      ? (existingPr?.branch || existingBranch!.branch)
      : await nextAvailableBranch(session, target.owner, target.repo, branchNameForRun(run, title));

    if (requestedMode === "update") {
      const existingBranch = await githubRaw<GithubRef>(
        session,
        "GET",
        `${repoEndpoint(target.owner, target.repo)}/git/ref/heads/${encodeRefPath(branch)}`,
      );
      if (existingBranch.status === 404) {
        await github(session, "POST", `${repoEndpoint(target.owner, target.repo)}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: commitSha,
        }, [201]);
      } else {
        await expectGithub(existingBranch, [200], `GitHub GET ${branch} failed`);
        await github(session, "PATCH", `${repoEndpoint(target.owner, target.repo)}/git/refs/heads/${encodeRefPath(branch)}`, {
          sha: commitSha,
          force: true,
        }, [200]);
      }
      if (existingPr && wantsUpstreamPr) {
        const prResponse = await githubRaw<GithubPullRequest>(
          session,
          "PATCH",
          `${repoEndpoint(owner, repo)}/pulls/${existingPr.number}`,
          { title, body },
        );
        if (prResponse.status !== 200) {
          const fallback = branchResult("updated", owner, repo, target, changedFiles.map((file) => file.path), commitSha, branch, prFailureAfterBranch(prResponse));
          fallback.pullRequest = existingPr;
          return fallback;
        }
        const pr = prResponse.data;
        return publishResult("updated", owner, repo, target, changedFiles.map((file) => file.path), commitSha, pr, branch, baseBranch, title, body);
      }
      return branchResult("updated", owner, repo, target, changedFiles.map((file) => file.path), commitSha, branch);
    }

    await github(session, "POST", `${repoEndpoint(target.owner, target.repo)}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    }, [201]);
    if (!wantsUpstreamPr) {
      return branchResult("created", owner, repo, target, changedFiles.map((file) => file.path), commitSha, branch);
    }
    const prResponse = await githubRaw<GithubPullRequest>(session, "POST", `${repoEndpoint(owner, repo)}/pulls`, {
      title,
      body,
      head: target.kind === "fork" ? `${target.owner}:${branch}` : branch,
      base: baseBranch,
      draft: false,
    });
    if (prResponse.status !== 201) {
      return branchResult("created", owner, repo, target, changedFiles.map((file) => file.path), commitSha, branch, prFailureAfterBranch(prResponse));
    }
    const pr = prResponse.data;
    return publishResult("created", owner, repo, target, changedFiles.map((file) => file.path), commitSha, pr, branch, baseBranch, title, body);
  } finally {
    await loaded.cleanup();
  }
}

interface PublishTarget {
  kind: "upstream" | "fork";
  owner: string;
  repo: string;
}

function publishResult(
  mode: "created" | "updated",
  owner: string,
  repo: string,
  target: PublishTarget,
  changedFiles: string[],
  commitSha: string,
  pr: GithubPullRequest,
  branch: string,
  base: string,
  title: string,
  body: string,
): CodePublishResult {
  const number = Number(pr.number);
  const url = typeof pr.html_url === "string" && pr.html_url
    ? pr.html_url
    : `https://github.com/${owner}/${repo}/pull/${number}`;
  if (!Number.isFinite(number) || number <= 0) throw new Error("GitHub did not return a PR number");
  return {
    mode,
    provider: "composio-github-proxy",
    owner,
    repo,
    target: target.kind,
    openedPullRequest: true,
    changedFiles,
    commitSha,
    branch: branchRef(target, branch),
    pullRequest: {
      url,
      number,
      branch: pr.head?.ref || branch,
      base: pr.base?.ref || base,
      title: pr.title || title,
      body: typeof pr.body === "string" ? pr.body : body,
      headOwner: pr.head?.repo?.owner?.login || target.owner,
      headRepo: pr.head?.repo?.name || target.repo,
      baseOwner: pr.base?.repo?.owner?.login || owner,
      baseRepo: pr.base?.repo?.name || repo,
      updatedAt: new Date().toISOString(),
    },
  };
}

function branchResult(
  mode: "created" | "updated",
  owner: string,
  repo: string,
  target: PublishTarget,
  changedFiles: string[],
  commitSha: string,
  branch: string,
  pullRequestError?: string,
): CodePublishResult {
  return {
    mode,
    provider: "composio-github-proxy",
    owner,
    repo,
    target: target.kind,
    openedPullRequest: false,
    changedFiles,
    commitSha,
    branch: branchRef(target, branch),
    pullRequest: null,
    ...(pullRequestError ? { pullRequestError } : {}),
  };
}

function branchRef(target: PublishTarget, branch: string): CodePublishBranchRef {
  return {
    owner: target.owner,
    repo: target.repo,
    branch,
    url: `https://github.com/${target.owner}/${target.repo}/tree/${encodeBranchForUrl(branch)}`,
  };
}

async function collectTreeEntries(
  session: ComposioSession,
  owner: string,
  repo: string,
  repoPath: string,
  changedFiles: ChangedFile[],
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for (const file of changedFiles) {
    if (file.oldPath && file.oldPath !== file.path) {
      entries.push({ path: file.oldPath, mode: "100644", type: "blob", sha: null });
    }
    if (file.status === "D") {
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const absolutePath = join(repoPath, file.path);
    if (!existsSync(absolutePath)) {
      entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const mode = fileMode(absolutePath);
    const blobContent = mode === "120000"
      ? Buffer.from(readlinkSync(absolutePath), "utf-8")
      : readFileSync(absolutePath);
    const blob = await github<GithubBlob>(
      session,
      "POST",
      `${repoEndpoint(owner, repo)}/git/blobs`,
      { content: blobContent.toString("base64"), encoding: "base64" },
      [201],
    );
    entries.push({
      path: file.path,
      mode,
      type: "blob",
      sha: required(blob.sha, `GitHub did not return a blob SHA for ${file.path}`),
    });
  }
  return entries;
}

interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
}

async function resolvePublishTarget(args: {
  session: ComposioSession;
  userLogin: string;
  upstreamOwner: string;
  upstreamRepo: string;
  upstreamRepoInfo: GithubRepository;
  existingPr: CodePullRequestRef | null;
  existingBranch: CodePublishBranchRef | null;
  forceFork: boolean;
}): Promise<PublishTarget> {
  if (args.existingPr?.headOwner && args.existingPr.headRepo) {
    const upstreamFullName = `${args.upstreamOwner}/${args.upstreamRepo}`;
    return {
      kind: sameRepo(args.existingPr.headOwner, args.existingPr.headRepo, args.upstreamOwner, args.upstreamRepo) ? "upstream" : "fork",
      owner: args.existingPr.headOwner,
      repo: args.existingPr.headRepo,
    };
  }
  if (args.existingBranch?.owner && args.existingBranch.repo) {
    return {
      kind: sameRepo(args.existingBranch.owner, args.existingBranch.repo, args.upstreamOwner, args.upstreamRepo) ? "upstream" : "fork",
      owner: args.existingBranch.owner,
      repo: args.existingBranch.repo,
    };
  }
  if (!args.forceFork && canPushRepository(args.upstreamRepoInfo, args.userLogin)) {
    return { kind: "upstream", owner: args.upstreamOwner, repo: args.upstreamRepo };
  }
  const fork = await ensureFork(args.session, args.userLogin, args.upstreamOwner, args.upstreamRepo);
  return { kind: "fork", owner: args.userLogin, repo: fork.name };
}

async function ensureFork(
  session: ComposioSession,
  userLogin: string,
  upstreamOwner: string,
  upstreamRepo: string,
): Promise<{ name: string; fullName: string }> {
  const upstreamFullName = `${upstreamOwner}/${upstreamRepo}`;
  const preferred = await githubRaw<GithubRepository>(session, "GET", repoEndpoint(userLogin, upstreamRepo));
  if (preferred.status === 200 && isForkOf(preferred.data, upstreamFullName)) {
    return { name: upstreamRepo, fullName: `${userLogin}/${upstreamRepo}` };
  }
  if (preferred.status !== 404 && preferred.status !== 200) {
    await expectGithub(preferred, [200, 404], `Could not inspect fork ${userLogin}/${upstreamRepo}`);
  }

  const forkName = preferred.status === 200 ? `${upstreamRepo}-rlm-wiki` : upstreamRepo;
  const existingNamed = forkName === upstreamRepo
    ? preferred
    : await githubRaw<GithubRepository>(session, "GET", repoEndpoint(userLogin, forkName));
  if (existingNamed.status === 200 && isForkOf(existingNamed.data, upstreamFullName)) {
    return { name: forkName, fullName: `${userLogin}/${forkName}` };
  }
  if (existingNamed.status !== 404 && existingNamed.status !== 200) {
    await expectGithub(existingNamed, [200, 404], `Could not inspect fork ${userLogin}/${forkName}`);
  }

  const created = await githubRaw<GithubRepository>(session, "POST", `${repoEndpoint(upstreamOwner, upstreamRepo)}/forks`, {
    name: forkName,
    default_branch_only: true,
  });
  if (![201, 202, 200].includes(created.status) && !(created.status === 422 && existingNamed.status === 200)) {
    await expectGithub(created, [201, 202, 200], `Could not fork ${upstreamFullName}`);
  }
  const fork = await waitForFork(session, userLogin, forkName, upstreamFullName);
  return { name: forkName, fullName: fork.full_name || `${userLogin}/${forkName}` };
}

async function waitForFork(
  session: ComposioSession,
  owner: string,
  repo: string,
  upstreamFullName: string,
): Promise<GithubRepository> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await githubRaw<GithubRepository>(session, "GET", repoEndpoint(owner, repo));
    lastStatus = response.status;
    if (response.status === 200 && isForkOf(response.data, upstreamFullName)) return response.data;
    await sleep(1500);
  }
  throw new Error(`Fork ${owner}/${repo} was not ready yet (last GitHub status ${lastStatus || "unknown"})`);
}

function collectChangedFiles(repoPath: string): ChangedFile[] {
  runGit(repoPath, ["add", "-N", ...GIT_DIFF_PATHSPEC]);
  const status = runGit(repoPath, ["diff", "--name-status", "-M", "HEAD", ...GIT_DIFF_PATHSPEC]);
  if (status.exitCode !== 0) throw new Error((status.stderr || status.stdout || "git diff failed").trim());
  return status.stdout
    .split("\n")
    .map((line) => parseNameStatusLine(line))
    .filter((file): file is ChangedFile => Boolean(file));
}

function parseNameStatusLine(line: string): ChangedFile | null {
  const parts = line.trim().split("\t").filter(Boolean);
  if (!parts.length) return null;
  const status = parts[0]?.charAt(0) || "";
  if (!status) return null;
  if (status === "R" || status === "C") {
    const oldPath = parts[1];
    const path = parts[2];
    return path ? { status: "A", path, oldPath } : null;
  }
  const path = parts[1];
  return path ? { status, path } : null;
}

function fileMode(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return "120000";
  return (stat.mode & 0o111) ? "100755" : "100644";
}

function applyPatch(cwd: string, patch: string): void {
  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-publish-"));
  const patchPath = join(dir, "patch.diff");
  try {
    writeFileSync(patchPath, filterIgnoredPatch(patch), "utf-8");
    const result = runGit(cwd, ["apply", "--whitespace=nowarn", "--binary", patchPath]);
    if (result.exitCode !== 0) {
      throw new Error((result.stderr || result.stdout || "git apply failed").trim());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

async function nextAvailableBranch(
  session: ComposioSession,
  owner: string,
  repo: string,
  preferred: string,
): Promise<string> {
  for (let index = 0; index < 8; index++) {
    const branch = index === 0 ? preferred : `${preferred}-${index + 1}`;
    const ref = await githubRaw(session, "GET", `${repoEndpoint(owner, repo)}/git/ref/heads/${encodeRefPath(branch)}`);
    if (ref.status === 404) return branch;
    await expectGithub(ref, [200], `Could not check branch ${branch}`);
  }
  throw new Error(`Could not find an available branch name near ${preferred}`);
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
  throw new Error(githubFailureMessage(response, prefix));
}

function githubFailureMessage<T>(response: GithubProxyResponse<T>, prefix: string): string {
  const data = jsonObject(response.data);
  const detail = typeof data.message === "string" && data.message
    ? data.message
    : JSON.stringify(response.data).slice(0, 800);
  return `${prefix}: ${response.status}${detail ? ` ${detail}` : ""}`;
}

function prFailureAfterBranch<T>(response: GithubProxyResponse<T>): string {
  const message = githubFailureMessage(response, "GitHub could not open the pull request");
  if (/limited the ability to open a pull request|collaborators/i.test(message)) {
    return "Branch was pushed, but this repository only allows collaborators to open pull requests.";
  }
  return `Branch was pushed, but the pull request could not be opened: ${message}`;
}

function repoEndpoint(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function encodeRefPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function encodeBranchForUrl(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function required(value: string | undefined | null, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function publishablePatch(result: Record<string, unknown>): string {
  const fullDiff = typeof result.fullDiff === "string" ? filterIgnoredPatch(result.fullDiff) : "";
  const diff = typeof result.diff === "string" ? filterIgnoredPatch(result.diff) : "";
  const patch = fullDiff && fullDiff !== "(no diff)" ? fullDiff : diff;
  if (!patch || patch === "(no diff)" || !patch.includes("diff --git ") || patch.includes("[truncated")) return "";
  return patch;
}

function repoRefFromInput(input: Record<string, unknown>): RepoRef | null {
  const ref = jsonObject(input.ref);
  const owner = typeof ref.owner === "string" ? ref.owner : "";
  const repo = typeof ref.repo === "string" ? ref.repo : "";
  const url = typeof ref.url === "string" ? ref.url : "";
  if (!owner || !repo || !url) return null;
  const branch = typeof ref.branch === "string" && ref.branch ? ref.branch : null;
  return { owner, repo, url, branch };
}

function normalizePullRequest(value: unknown): CodePullRequestRef | null {
  const row = jsonObject(value);
  const url = typeof row.url === "string" ? row.url : "";
  const number = Number(row.number);
  const branch = typeof row.branch === "string" ? row.branch : "";
  const base = typeof row.base === "string" ? row.base : "main";
  const title = typeof row.title === "string" ? row.title : "";
  const body = typeof row.body === "string" ? row.body : "";
  const headOwner = typeof row.headOwner === "string" ? row.headOwner : undefined;
  const headRepo = typeof row.headRepo === "string" ? row.headRepo : undefined;
  const baseOwner = typeof row.baseOwner === "string" ? row.baseOwner : undefined;
  const baseRepo = typeof row.baseRepo === "string" ? row.baseRepo : undefined;
  const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : "";
  if (!url || !Number.isFinite(number) || number <= 0 || !branch) return null;
  return { url, number, branch, base, title, body, headOwner, headRepo, baseOwner, baseRepo, updatedAt };
}

function normalizeBranch(value: unknown): CodePublishBranchRef | null {
  const row = jsonObject(value);
  const owner = typeof row.owner === "string" ? row.owner : "";
  const repo = typeof row.repo === "string" ? row.repo : "";
  const branch = typeof row.branch === "string" ? row.branch : "";
  const url = typeof row.url === "string" && row.url
    ? row.url
    : owner && repo && branch
    ? `https://github.com/${owner}/${repo}/tree/${encodeBranchForUrl(branch)}`
    : "";
  if (!owner || !repo || !branch || !url) return null;
  return { owner, repo, branch, url };
}

function draftTitleFromRun(
  run: ProductRun,
  result: Record<string, unknown>,
  changedFiles: ChangedFile[],
  existingTitle?: string,
): string {
  const latest = latestDoneTurn(result);
  const fromAnswer = extractPrDraft(latest?.answer || asString(result.answer)).title;
  if (fromAnswer) return fromAnswer;
  const task = latest?.task || asString(jsonObject(run.input).task);
  const quoted = task.match(/title\s+(?:call|called|named|as)\s*:?\s*["'`]?([^"'`\n.]+)["'`]?/i)
    ?? task.match(/with\s+(?:a\s+)?title\s*:?\s*["'`]?([^"'`\n.]+)["'`]?/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  if (existingTitle && !isGenericPrTitle(existingTitle)) return existingTitle;
  const taskTitle = titleCandidateFromTask(task);
  if (taskTitle) return taskTitle;
  if (existingTitle) return existingTitle;
  if (changedFiles.length === 1) return `Update ${changedFiles[0].path}`;
  return `Update ${changedFiles.length} files`;
}

function draftBodyFromRun(
  run: ProductRun,
  result: Record<string, unknown>,
  changedFiles: ChangedFile[],
  existingBody?: string,
): string {
  const latest = latestDoneTurn(result);
  const answer = latest?.answer || asString(result.answer);
  const draft = extractPrDraft(answer);
  if (draft.body) return draft.body;
  const summary = summaryBulletsFromAnswer(answer);
  const task = latest?.task || asString(jsonObject(run.input).task) || "Apply Code Anything patch.";
  const files = changedFiles.map((file) => `- \`${file.path}\``).join("\n");
  return [
    "## Summary",
    summary || `- ${task}`,
    "",
    "## What Changed",
    files || "- (none)",
    "",
    "## Verification",
    existingBody ? "- Updated from a Code Anything follow-up." : "- Not reported by the code run.",
    "",
    "## Publish Notes",
    "- Generated from the current Code Anything patch.",
  ].join("\n");
}

function titleCandidateFromTask(task: string): string {
  const cleaned = task
    .replace(/^\s*(please|can you|could you|would you)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!cleaned || /^publish\b/i.test(cleaned)) return "";
  const title = sanitizePrTitle(cleaned);
  if (!title || title.length > 88) return "";
  return title;
}

function isGenericPrTitle(title: string): boolean {
  return /^update\s+\d+\s+files?$/i.test(title.trim())
    || /^code anything patch$/i.test(title.trim());
}

function summaryBulletsFromAnswer(answer: string): string {
  const ignored = new Set(["summary", "what changed", "changed files", "verification", "publish notes"]);
  const lines = answer
    .replace(/^#+\s+/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !ignored.has(line.replace(/:$/, "").toLowerCase()))
    .filter((line) => !/^```/.test(line))
    .slice(0, 4);
  return lines
    .map((line) => line.startsWith("- ") ? line : `- ${line.replace(/^-+\s*/, "")}`)
    .join("\n");
}

interface PullRequestDraftContext {
  run: ProductRun;
  result: Record<string, unknown>;
  patch: string;
  changedFiles: ChangedFile[];
  existingPr: CodePullRequestRef | null;
  requestedMode: PublishMode;
  target: PublishTarget;
  owner: string;
  repo: string;
  baseBranch: string;
  fallbackTitle: string;
  fallbackBody: string;
  channel?: string;
}

async function generatePullRequestDraft(ctx: PullRequestDraftContext): Promise<{ title?: string; body?: string } | null> {
  const channelId = ctx.channel || prDraftChannelId(ctx.run, ctx.result);
  try {
    const channel = resolveChannel(channelId);
    const llm = makeLLM(channel, { surface: "code", depth: "fast" });
    const raw = await llm.generate(buildPullRequestDraftPrompt(ctx));
    const parsed = parsePullRequestDraftJson(raw);
    const title = sanitizePrTitle(parsed.title);
    const body = sanitizePrBody(parsed.body);
    if (!title && !body) return null;
    return { title, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[code-publish] PR metadata generation failed, falling back to deterministic draft: ${message}`);
    return null;
  }
}

function buildPullRequestDraftPrompt(ctx: PullRequestDraftContext): string {
  const latest = latestDoneTurn(ctx.result);
  const input = jsonObject(ctx.run.input);
  const task = latest?.task || asString(input.task) || ctx.run.title || "Apply Code Anything patch.";
  const answer = latest?.answer || asString(ctx.result.answer);
  const targetLine = ctx.target.kind === "fork"
    ? `fork ${ctx.target.owner}/${ctx.target.repo} -> ${ctx.owner}/${ctx.repo}`
    : `branch in ${ctx.owner}/${ctx.repo}`;
  const existing = ctx.existingPr
    ? [
      `Existing PR: #${ctx.existingPr.number}`,
      `Existing title: ${ctx.existingPr.title || "(none)"}`,
      `Existing body excerpt: ${truncateMiddle(ctx.existingPr.body || "", 1600) || "(none)"}`,
    ].join("\n")
    : "Existing PR: none";

  return [
    "You write GitHub pull request metadata for an agent-created code patch.",
    "The user will see this on GitHub, so be specific, concise, and useful.",
    "",
    "Return ONLY a JSON object with this shape:",
    '{"title":"...","body":"..."}',
    "",
    "Title rules:",
    "- Describe the actual issue or behavior fixed, not the number of files.",
    "- Prefer imperative or present-tense engineering copy.",
    "- 8 to 72 characters when possible.",
    "- Do not use generic titles like \"Update 2 files\", \"Code Anything patch\", or \"Fix bug\".",
    "- Do not include an issue number, markdown, quotes, or a trailing period.",
    "",
    "Body rules:",
    "- Markdown only, but do not wrap the whole body in a code fence.",
    "- Use exactly these sections: ## Summary, ## What Changed, ## Verification, ## Publish Notes.",
    "- Use short bullets under each section.",
    "- Reflect only facts in the task, answer, changed files, and diff excerpt.",
    "- Do not invent tests. If no verification command/result is reported, say \"Not reported by the code run.\"",
    "- In Publish Notes, mention the target repo and whether this publishes through a fork or upstream branch.",
    "",
    "Publish state:",
    `Mode: ${ctx.requestedMode}`,
    `Base repository: ${ctx.owner}/${ctx.repo}`,
    `Base branch: ${ctx.baseBranch}`,
    `Publishing path: ${targetLine}`,
    existing,
    "",
    "Original task:",
    task,
    "",
    "Agent final answer excerpt:",
    truncateMiddle(answer, 5000) || "(none)",
    "",
    "Changed files:",
    changedFilesForPrompt(ctx.changedFiles),
    "",
    "Diff excerpt:",
    truncateMiddle(ctx.patch, 28000),
    "",
    "Fallback draft if you cannot infer better metadata:",
    JSON.stringify({ title: ctx.fallbackTitle, body: ctx.fallbackBody }),
  ].join("\n");
}

function prDraftChannelId(run: ProductRun, result: Record<string, unknown>): string {
  const input = jsonObject(run.input);
  const latest = latestDoneTurn(result);
  return latest?.channel || asString(input.channel) || asString(input.model) || DEFAULT_CHANNEL_ID;
}

function parsePullRequestDraftJson(raw: string): { title?: string; body?: string } {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) return extractPrDraft(raw);
  try {
    const parsed = JSON.parse(candidate);
    const row = jsonObject(parsed);
    return {
      title: asString(row.title),
      body: asString(row.body),
    };
  } catch {
    return extractPrDraft(raw);
  }
}

function sanitizePrTitle(value: unknown): string {
  const title = asString(value)
    .replace(/^\s*Title:\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.。]+$/g, "")
    .trim();
  if (title.length < 4) return "";
  if (title.length <= 96) return title;
  const clipped = title.slice(0, 93).replace(/\s+\S*$/, "").trim();
  return clipped ? `${clipped}...` : title.slice(0, 93).trim();
}

function sanitizePrBody(value: unknown): string {
  let body = asString(value).trim();
  if (!body) return "";
  body = body.replace(/^\s*Body:\s*/i, "").trim();
  body = stripSurroundingFence(body).trim();
  body = body.replace(/^#\s+Summary\s*\n+/i, "");
  body = body.replace(/^Summary\s*\n+Summary\s*\n+/i, "## Summary\n");
  if (body.length < 20) return "";
  if (!/^##\s+Summary/im.test(body)) {
    body = `## Summary\n${body}`;
  }
  return body;
}

function stripSurroundingFence(value: string): string {
  const match = value.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match?.[1] ?? value;
}

function changedFilesForPrompt(changedFiles: ChangedFile[]): string {
  if (!changedFiles.length) return "- (none)";
  return changedFiles
    .map((file) => {
      const rename = file.oldPath ? ` (from ${file.oldPath})` : "";
      return `- ${file.status} ${file.path}${rename}`;
    })
    .join("\n");
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.max(0, maxChars - head - 80);
  return `${value.slice(0, head)}\n\n...[truncated ${value.length - head - tail} chars]...\n\n${value.slice(-tail)}`;
}

function extractPrDraft(answer: string): { title?: string; body?: string } {
  const title = answer.match(/^\s*Title:\s*(.+)$/im)?.[1]?.trim();
  const body = answer.match(/Body:\s*\n+```(?:markdown)?\n([\s\S]*?)```/i)?.[1]?.trim();
  return { title, body };
}

function latestDoneTurn(result: Record<string, unknown>): { task?: string; answer?: string; channel?: string } | null {
  const turns = Array.isArray(result.turns) ? result.turns : [];
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = jsonObject(turns[index]);
    if (turn.status !== "done") continue;
    return {
      task: asString(turn.task),
      answer: asString(turn.answer),
      channel: asString(turn.channel),
    };
  }
  return null;
}

function commitMessage(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean ? `code-anything: ${clean}` : "code-anything: publish patch";
}

function branchNameForRun(run: ProductRun, title: string): string {
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "patch";
  return `rlm-wiki/code-anything-${run.id.slice(0, 8)}-${titleSlug}`;
}

function canPushRepository(repo: GithubRepository, userLogin: string): boolean {
  if (repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push) return true;
  return sameLogin(repo.owner?.login, userLogin);
}

function isForkOf(repo: GithubRepository, upstreamFullName: string): boolean {
  const target = upstreamFullName.toLowerCase();
  return repo.fork === true
    && (
      repo.parent?.full_name?.toLowerCase() === target
      || repo.source?.full_name?.toLowerCase() === target
    );
}

function sameRepo(ownerA: string, repoA: string, ownerB: string, repoB: string): boolean {
  return sameLogin(ownerA, ownerB) && repoA.toLowerCase() === repoB.toLowerCase();
}

function sameLogin(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
