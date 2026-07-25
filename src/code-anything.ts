import { RLM } from "rlm-bun";
import { JCodeAgent, loadSource } from "./jcode-runtime.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import type { MCPConfig, RLMEvent } from "./jcode-runtime.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RepoRef, WorkspaceRepoRef } from "./types.ts";
import { DEFAULT_CHANNEL_ID, makeLLM, resolveChannel } from "./llm.ts";
import { makeRlmLLM } from "./rlm-llm.ts";
import { normalizeAgentRuntime, type AgentRuntime } from "./agent-runtime.ts";
import { jcodeControlsForSurface, localCliControlsForSurface, rlmControlsForSurface } from "./model-control.ts";
import { applyAgentCapabilities } from "./agent-capabilities.ts";
import { describeCodeScreenshots, normalizeScreenshotAttachments } from "./vision.ts";
import type { ProviderSecrets } from "./provider-secrets.ts";
import type { LocalCliConfig } from "./local-cli-events.ts";

const SANDBOX_TIMEOUT_MS = 1_800_000;
const MAX_DIFF_CHARS = 240_000;
const IGNORED_DIFF_PATHS = ["graphify-out", "graphify-out/"];
const GIT_DIFF_PATHSPEC = ["--", ".", ":(exclude)graphify-out", ":(exclude)graphify-out/**"];
const CODE_AGENT_FALLBACK: CodeAnythingAgent = "codex";

export type CodeAnythingAgent = "codex" | "claude" | "grok" | "antigravity";

export type CodeAnythingEvent =
  | { type: "agent"; event: RLMEvent }
  | { type: "answer"; answer: string; sources: string[] }
  | { type: "diff"; diff: string; status: string; changedFiles: string[]; truncated: boolean }
  | { type: "error"; error: string };

export interface CodeAnythingOptions {
  channel?: string;
  model?: string;
  agent?: string;
  onEvent?: (ev: CodeAnythingEvent) => void;
  maxIterations?: number;
  mcpConfig?: MCPConfig;
  skillSources?: string[];
  screenshots?: unknown;
  signal?: AbortSignal;
  runtime?: AgentRuntime | string;
  localCli?: LocalCliConfig | unknown;
  basePatch?: string;
  providerSecrets?: ProviderSecrets;
  refs?: WorkspaceRepoRef[];
  previousContext?: {
    task?: string;
    answer?: string;
    changedFiles?: string[];
    patchExcerpt?: string;
    patchApplied?: boolean;
    hadPatch?: boolean;
  };
}

interface CodeDiffResult {
  diff: string;
  fullDiff: string;
  status: string;
  changedFiles: string[];
  truncated: boolean;
}

export function normalizeCodeAnythingAgent(value: unknown): CodeAnythingAgent {
  return value === "claude" || value === "grok" || value === "antigravity" ? value : CODE_AGENT_FALLBACK;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function codeAnything(
  ref: RepoRef,
  task: string,
  opts: CodeAnythingOptions = {},
): Promise<{
  answer: string;
  sources: string[];
  diff: string;
  fullDiff: string;
  status: string;
  changedFiles: string[];
  truncated: boolean;
}> {
  const trimmedTask = task.trim();
  if (!trimmedTask) throw new Error("codeAnything: task is required");
  throwIfAborted(opts.signal);

  const channel = resolveChannel(opts.channel ?? opts.model ?? DEFAULT_CHANNEL_ID);
  const runtime = normalizeAgentRuntime(opts.runtime, "agent");
  const selectedAgent = normalizeCodeAnythingAgent(opts.agent);
  const emit = opts.onEvent ?? (() => {});
  const workspaceRefs = codeWorkspaceRefs(ref, opts.refs);
  const screenshots = normalizeScreenshotAttachments(opts.screenshots);
  const localCliNativeImages = runtime === "local-cli" && localCliSupportsScreenshots(selectedAgent);
  let visualContext = "";
  if (screenshots.length && !localCliNativeImages) {
    emit({
      type: "agent",
      event: {
        type: "status",
        phase: "vision",
        message: `Reading ${screenshots.length === 1 ? "screenshot" : `${screenshots.length} screenshots`} with ${channel.label}.`,
      } as RLMEvent,
    });
    visualContext = await describeCodeScreenshots(channel, screenshots, trimmedTask, opts.providerSecrets);
    throwIfAborted(opts.signal);
    emit({
      type: "agent",
      event: {
        type: "status",
        phase: "vision",
        message: "Screenshot context captured for the coding agent.",
      } as RLMEvent,
    });
  }
  if (runtime === "local-cli") {
    return codeAnythingLocalCli(ref, trimmedTask, {
      ...opts,
      runtime,
      localCli: opts.localCli ?? { agentId: selectedAgent },
      providerSecrets: opts.providerSecrets,
      refs: workspaceRefs ?? opts.refs,
      screenshots,
    }, channel, selectedAgent, visualContext);
  }
  const loaded = await loadSource(ref.url, {
    branch: ref.branch,
    sourcePath: ref.sourcePath ?? null,
    cache: false,
  });

  try {
    throwIfAborted(opts.signal);
    const baseHead = runGit(loaded.repoPath, ["rev-parse", "HEAD"]).stdout.trim() || "HEAD";
    let appliedBasePatch = false;
    if (isUsablePatch(opts.basePatch)) {
      appliedBasePatch = applyPatch(loaded.repoPath, opts.basePatch!);
    }
    if (appliedBasePatch) {
      emit({
        type: "agent",
        event: {
          type: "status",
          phase: "continuation",
          message: "Applied the previous patch before handling the follow-up.",
        } as RLMEvent,
      });
    }
    const previousContext = opts.previousContext
      ? {
        ...opts.previousContext,
        patchApplied: appliedBasePatch,
        hadPatch: isUsablePatch(opts.basePatch) || Boolean(opts.previousContext.patchExcerpt),
      }
      : undefined;

    const modelContext = { surface: "code" as const, depth: "deep" as const };
    const Agent = (runtime === "rlm" ? RLM : JCodeAgent) as any;
    const agent = new Agent({
      source: loaded.repoPath,
      mode: "rlm",
      llm: runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets),
      subLM: runtime === "rlm" ? makeRlmLLM(channel, modelContext, opts.providerSecrets) : makeLLM(channel, modelContext, opts.providerSecrets),
      ...(runtime === "rlm" ? rlmControlsForSurface(channel, modelContext) : jcodeControlsForSurface(channel, modelContext)),
      defaultAgent: selectedAgent,
      maxIterations: opts.maxIterations ?? 24,
      maxLLMCalls: 420,
      sandboxTimeout: SANDBOX_TIMEOUT_MS,
      mcpConfig: opts.mcpConfig,
      onEvent: (event: RLMEvent) => emit({ type: "agent", event }),
    } as any) as {
      query(prompt: string, signal?: AbortSignal): Promise<{ answer: string; sources: string[] }>;
    };

    await applyAgentCapabilities(agent as unknown as JCodeAgent, {
      skillSources: opts.skillSources,
      onStatus: (message) => emit({
        type: "agent",
        event: { type: "status", phase: "capabilities", message } as RLMEvent,
      }),
    });

    const prompt = buildCodeAnythingPrompt(ref, trimmedTask, previousContext, selectedAgent, visualContext, runtime, workspaceRefs);
    let result = await runCodeAgentQuery(agent, prompt, runtime, opts.signal);
    throwIfAborted(opts.signal);
    let answer = (result.answer || "").trim();
    let sources = result.sources;
    let diffResult = collectDiff(loaded.repoPath, baseHead);
    if (shouldRepairEmptyDiff(trimmedTask, answer, diffResult)) {
      emit({
        type: "agent",
        event: {
          type: "status",
          phase: "diff",
          message: "No patch found after the first pass; asking the agent to reconcile the clean worktree.",
        } as RLMEvent,
      });
      const repairPrompt = buildEmptyDiffRepairPrompt(ref, trimmedTask, answer, diffResult, runtime);
      result = await runCodeAgentQuery(agent, repairPrompt, runtime, opts.signal);
      throwIfAborted(opts.signal);
      answer = (result.answer || "").trim();
      sources = result.sources;
      diffResult = collectDiff(loaded.repoPath, baseHead);
    }
    if (shouldBlockFalseChangeSummary(answer, diffResult)) {
      answer = buildNoPatchAnswer(trimmedTask, answer, diffResult);
      sources = [];
    }
    emit({ type: "answer", answer, sources });
    emit({
      type: "diff",
      diff: diffResult.diff,
      status: diffResult.status,
      changedFiles: diffResult.changedFiles,
      truncated: diffResult.truncated,
    });

    return {
      answer,
      sources,
      ...diffResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAbortError(error)) emit({ type: "error", error: message });
    throw error;
  } finally {
    await loaded.cleanup();
  }
}

async function codeAnythingLocalCli(
  ref: RepoRef,
  trimmedTask: string,
  opts: CodeAnythingOptions,
  channel: ReturnType<typeof resolveChannel>,
  selectedAgent: CodeAnythingAgent,
  visualContext: string,
): Promise<{
  answer: string;
  sources: string[];
  diff: string;
  fullDiff: string;
  status: string;
  changedFiles: string[];
  truncated: boolean;
}> {
  const emit = opts.onEvent ?? (() => {});
  const previousContext = opts.previousContext
    ? {
      ...opts.previousContext,
      patchApplied: isUsablePatch(opts.basePatch),
      hadPatch: isUsablePatch(opts.basePatch) || Boolean(opts.previousContext.patchExcerpt),
    }
    : undefined;
  const screenshots = normalizeScreenshotAttachments(opts.screenshots);
  const modelContext = { surface: "code" as const, depth: "deep" as const };
  const workspaceRefs = codeWorkspaceRefs(ref, opts.refs);
  const agent = new LocalCliAgent({
    ...(workspaceRefs
      ? {
          sources: workspaceRefs.map((workspaceRef) => ({
            id: workspaceRef.id,
	            source: workspaceRef.url,
	            branch: workspaceRef.branch,
	            sourcePath: workspaceRef.sourcePath ?? null,
	            label: workspaceRef.label,
          })),
          mode: "workspace" as const,
        }
      : {
	          source: ref.url,
	          branch: ref.branch,
	          sourcePath: ref.sourcePath ?? null,
	        }),
    mode: "rlm",
    ...localCliControlsForSurface(channel, modelContext),
    defaultAgent: selectedAgent,
    localCli: opts.localCli ?? { agentId: selectedAgent },
    basePatch: opts.basePatch,
    screenshots,
    maxIterations: opts.maxIterations ?? 24,
    maxLLMCalls: 420,
    sandboxTimeout: SANDBOX_TIMEOUT_MS,
    onEvent: (event: RLMEvent) => emit({ type: "agent", event }),
  } as any);

  await applyAgentCapabilities(agent as unknown as JCodeAgent, {
    skillSources: opts.skillSources,
    onStatus: (message) => emit({
      type: "agent",
      event: { type: "status", phase: "capabilities", message } as RLMEvent,
    }),
  });

  const prompt = buildCodeAnythingPrompt(ref, trimmedTask, previousContext, selectedAgent, visualContext, "local-cli", workspaceRefs);
  const result = await agent.query(prompt, opts.signal);
  throwIfAborted(opts.signal);
  const answer = (result.answer || "").trim();
  const sources = result.sources;
  const workspacePath = typeof result.workspacePath === "string" ? result.workspacePath : "";
  const baseHead = typeof result.baseHead === "string" ? result.baseHead : "HEAD";
  const diffResult = workspacePath ? collectDiff(workspacePath, baseHead) : {
    diff: "(no diff)",
    fullDiff: "(no diff)",
    status: "(clean)",
    changedFiles: [],
    truncated: false,
  };
  const finalAnswer = shouldBlockFalseChangeSummary(answer, diffResult)
    ? buildNoPatchAnswer(trimmedTask, answer, diffResult)
    : answer;
  emit({ type: "answer", answer: finalAnswer, sources });
  emit({
    type: "diff",
    diff: diffResult.diff,
    status: diffResult.status,
    changedFiles: diffResult.changedFiles,
    truncated: diffResult.truncated,
  });
  return { answer: finalAnswer, sources, ...diffResult };
}

function localCliSupportsScreenshots(agent: CodeAnythingAgent): boolean {
  return agent === "codex" || agent === "claude" || agent === "grok" || agent === "antigravity";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Stopped by user.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && (error.name === "AbortError" || error.message === "Stopped by user.");
}

async function runCodeAgentQuery(
  agent: { query(prompt: string, signal?: AbortSignal): Promise<{ answer: string; sources: string[]; workspacePath?: string; baseHead?: string }> },
  prompt: string,
  runtime: AgentRuntime,
  signal?: AbortSignal,
): Promise<{ answer: string; sources: string[]; workspacePath?: string; baseHead?: string }> {
  return runtime === "rlm" ? agent.query(prompt) : agent.query(prompt, signal);
}

function shouldRepairEmptyDiff(task: string, answer: string, diffResult: CodeDiffResult): boolean {
  if (hasMaterialDiff(diffResult)) return false;
  if (answerClearlySaysNoPatch(answer)) return false;
  return looksLikeEditIntent(task) || answerClaimsChanges(answer);
}

function shouldBlockFalseChangeSummary(answer: string, diffResult: CodeDiffResult): boolean {
  return !hasMaterialDiff(diffResult) && !answerClearlySaysNoPatch(answer) && answerClaimsChanges(answer);
}

function hasMaterialDiff(diffResult: CodeDiffResult): boolean {
  const diff = diffResult.diff.trim();
  const fullDiff = diffResult.fullDiff.trim();
  return Boolean(diffResult.changedFiles.length)
    || Boolean(diff && diff !== "(no diff)")
    || Boolean(fullDiff && fullDiff !== "(no diff)")
    || !isCleanGitStatus(diffResult.status);
}

function isCleanGitStatus(status: string): boolean {
  const clean = status.trim();
  return !clean || clean === "(clean)";
}

function looksLikeEditIntent(task: string): boolean {
  return /\b(?:fix|repair|resolve|change|update|remove|delete|dedupe|dupe|duplicate|add|create|implement|write|edit|refactor|cleanup|clean\s*up|rename|migrate|patch)\b/i.test(task);
}

function answerClaimsChanges(answer: string): boolean {
  const text = answer.replace(/`[^`]*`/g, " ");
  return /\b(?:changed|updated|fixed|removed|deleted|added|created|implemented|renamed|migrated|refactored|cleaned\s+up|consolidated|deduplicated)\b/i.test(text)
    || /\b(?:changes made|what changed|patch ready|files changed)\b/i.test(text);
}

function answerClearlySaysNoPatch(answer: string): boolean {
  return /\b(?:no|not|without)\s+(?:changes?|edits?|patch|modifications?)\b/i.test(answer)
    || /\b(?:nothing|no\s+safe\s+edit|no\s+actionable\s+change|could\s+not\s+find\s+.*\s+to\s+(?:fix|change|update|remove))\b/i.test(answer);
}

function codeWorkspaceRefs(ref: RepoRef, refs?: WorkspaceRepoRef[]): WorkspaceRepoRef[] | null {
  if (!refs || refs.length <= 1) return null;
  const refKey = (item: Pick<RepoRef, "owner" | "repo" | "branch" | "sourcePath">): string =>
    `${item.owner}/${item.repo}@${item.branch || ""}#${item.sourcePath || ""}`.toLowerCase();
  const primaryKey = refKey(ref);
  const normalized = refs.filter((item) => item && item.owner && item.repo && item.url);
  if (!normalized.length) return null;
  const hasPrimaryFirst = refKey(normalized[0]) === primaryKey;
  return hasPrimaryFirst ? normalized : [
    { ...ref, id: "target", label: `${ref.owner}/${ref.repo}` },
    ...normalized.filter((item) => refKey(item) !== primaryKey),
  ];
}

function referenceRepoBlock(refs?: WorkspaceRepoRef[], runtime: AgentRuntime = "agent"): string {
  if (!refs || refs.length <= 1) return "";
  const primary = refs[0];
  const referenceRows = refs.slice(1).map((repo) => `- \`${repo.id}\` — ${repo.label} (${repo.url}${repo.branch ? ` @ ${repo.branch}` : ""})`).join("\n");
  const workspaceLine = runtime === "local-cli"
    ? `The prepared workspace contains one directory per repository. Edit only \`${primary.id}/\`; use the other directories as read-only reference material.`
    : "Reference repositories may need to be inspected through native shell/GitHub tooling. If you clone them, clone outside the target repo so they do not appear in the final patch.";
  return `
## Repository Scope
Primary patch target:
- \`${primary.id}\` — ${primary.label} (${primary.url}${primary.branch ? ` @ ${primary.branch}` : ""})

Read-only reference repositories:
${referenceRows}

Scope contract:
- ${workspaceLine}
- Do not edit, commit, vendor, or copy whole files from reference repositories unless the user explicitly asks for that scale of port.
- Use reference repositories to understand behavior, styling, APIs, and implementation patterns, then implement an idiomatic patch in the primary target.
- When citing sources in the final summary, keep repository prefixes for reference evidence, for example \`${refs[1]?.id}:src/file.ts\` and \`${primary.id}:src/file.ts\`.
`;
}

function buildEmptyDiffRepairPrompt(
  ref: RepoRef,
  task: string,
  previousAnswer: string,
  diffResult: CodeDiffResult,
  runtime: AgentRuntime,
): string {
  const commandLine = runtime === "rlm"
    ? "Use the sandbox tools"
    : "Use JCODE tools";
  return `# Code Anything Empty-Diff Repair

You are still working in the same temporary worktree for ${ref.owner}/${ref.repo}${ref.branch ? ` on branch ${ref.branch}` : ""}.

The previous response claimed changes, but rlm-wiki verified the worktree afterward and found no patch:

\`\`\`text
git status: ${diffResult.status || "(clean)"}
changed files: ${diffResult.changedFiles.length}
diff: ${diffResult.diff === "(no diff)" ? "(no diff)" : "present"}
\`\`\`

Original user task:
${task}

Previous response:
${previousAnswer || "(empty)"}

Repair contract:
- If the task requires edits, make real file changes in the worktree now.
- ${commandLine} to verify with \`git status --short\` and \`git diff --stat\` before the final answer.
- Do not claim files were changed unless \`git status --short\` or \`git diff\` shows those changes.
- If no safe edit is possible, say that no patch was produced and explain why.
- Keep the final answer concise and include the verification result.`;
}

function buildNoPatchAnswer(task: string, previousAnswer: string, diffResult: CodeDiffResult): string {
  const prior = previousAnswer.trim()
    ? "The agent returned a change summary, but rlm-wiki discarded it because the verified worktree was clean."
    : "The agent finished without producing a patch.";
  return `No patch was produced.

${prior}

Verified diff state:
- \`git status\`: ${diffResult.status || "(clean)"}
- changed files: ${diffResult.changedFiles.length}
- patch: ${diffResult.diff === "(no diff)" ? "(no diff)" : "empty after filtering"}

Original task: ${task}

## Suggested Next Steps
- **Rerun with a narrower target** — Name the exact duplicate class, resource folder, or file group to change.
- **Ask for investigation first** — Run Code Anything with "find duplicates and list the safest concrete edits before changing files."
- **Try a stronger edit model** — Re-run the same task with a model better suited for tool-following if this happens again.`;
}

function buildCodeAnythingPrompt(
  ref: RepoRef,
  task: string,
  previousContext?: CodeAnythingOptions["previousContext"],
  selectedAgent: CodeAnythingAgent = CODE_AGENT_FALLBACK,
  visualContext = "",
  runtime: AgentRuntime = "agent",
  refs?: WorkspaceRepoRef[] | null,
): string {
  const previous = previousContext
    ? `
## Continuation context
This is a follow-up inside an existing Code Anything session.
${previousContext.patchApplied
  ? "The previous patch has already been applied to the temporary worktree before you start."
  : previousContext.hadPatch
  ? "The previous patch was not available in full, so the temporary worktree starts from the repository base. Use the previous summary and patch excerpt to reconstruct the intended final state before making the new tweak."
  : "The previous turn produced no patch, so the temporary worktree starts from the repository base."}

Previous user task:
${previousContext.task || "(not recorded)"}

Previously changed files:
${previousContext.changedFiles?.length ? previousContext.changedFiles.map((file) => `- ${file}`).join("\n") : "- (not recorded)"}

Previous agent summary:
${previousContext.answer || "(not recorded)"}

${previousContext.patchExcerpt ? `Previous patch excerpt:
\`\`\`diff
${previousContext.patchExcerpt}
\`\`\`
` : ""}
`
    : "";
  const visual = visualContext.trim()
    ? `
## Screenshot context
The user attached screenshot evidence. Use these visual notes as task context, but verify code behavior in the repository before editing.

${visualContext.trim()}
`
    : "";

  const harness = runtime === "rlm"
    ? [
        `You are running as rlm-wiki's RLM coding agent for ${ref.owner}/${ref.repo}${ref.branch ? ` on branch ${ref.branch}` : ""}.`,
        "Use the rlm-bun JavaScript sandbox to inspect, edit, and verify this temporary git worktree. Emit one executable JavaScript block per step while working.",
      ].join("\n")
    : runtime === "local-cli"
    ? [
        `You are running as rlm-wiki's local CLI coding agent for ${ref.owner}/${ref.repo}${ref.branch ? ` on branch ${ref.branch}` : ""}.`,
        "Use the selected CLI agent's native file, search, shell, edit, and verification tools directly in the prepared worktree.",
      ].join("\n")
    : [
        `You are running as rlm-wiki's JCODE coding agent for ${ref.owner}/${ref.repo}${ref.branch ? ` on branch ${ref.branch}` : ""}.`,
        "The old sandbox/worker contract is gone; JCODE drives implementation, inspection, editing, and verification.",
      ].join("\n");
  const toolLine = runtime === "rlm"
    ? "Use the sandbox's search, file, shell, edit/patch, and analysis tools. Prefer the smallest safe edit and preserve unrelated user changes."
    : runtime === "local-cli"
    ? "Use the local CLI agent's native search, file, shell, edit, and patch tools. Prefer the smallest safe edit and preserve unrelated user changes."
    : "Use JCODE's native search, file, shell, edit, patch, and task tools. Prefer the smallest safe edit and preserve unrelated user changes.";
  const delegationLine = runtime === "rlm"
    ? "For broad work, keep the plan bounded and make changes directly in this sandbox."
    : runtime === "local-cli"
    ? "For broad work, stay inside the prepared worktree and only use native CLI delegation if the selected agent supports it clearly."
    : "For broad work, use JCODE's native task/delegation only when the scope is bounded and the write set is clear.";
  const finalLine = runtime === "rlm"
    ? "Do not put the summary inside JavaScript. After the <ANSWER> block, emit one tiny JavaScript block calling `SUBMIT({ sources: [...] })` with representative edited/read source files."
    : "Do not emit JavaScript, SUBMIT calls, or any legacy sandbox wrapper.";

  return `# Code Anything

${harness}
Selected implementation style hint: ${selectedAgent}.
${previous}
${referenceRepoBlock(refs ?? undefined, runtime)}

## User Task
${task}
${visual}

## Operating Contract
- Complete the requested coding task end-to-end inside this temporary git worktree.
- Think Socratically before acting: what would disprove your current assumption, what exact file owns the behavior, and what smallest change can be verified?
- Reuse the existing codebase patterns. Keep edits narrow and avoid unrelated refactors.
- Read files before editing them. If a file read is truncated, inspect the missing region before editing.
- ${toolLine}
- ${delegationLine}
- When a changed file is untracked, inspect the file content or use a diff command that includes untracked files.
- Use shell commands for the repo's own scripts only after inspecting package/project metadata.
- Run the most relevant verification command available. If verification is impossible or blocked by pre-existing failure, say exactly why.
- Treat \`graphify-out/\` as runtime cache output. Do not edit it, cite it, or count it as part of the user-facing patch.
- Do not commit, push, create branches, or change remotes. Leave the working tree dirty so rlm-wiki can show the patch.
- Do not publish autonomously from the agent loop. If the user asks to create/open/update/submit/publish a PR, prepare the local patch and PR draft title/body; rlm-wiki's explicit Publish PR / Update PR action performs confirmed remote writes.
- Do not create docs unless the user task asks for docs.

## Final Response
Return a concise engineering summary inside one \`<ANSWER>...</ANSWER>\` block with:
1. What changed.
2. How you verified it, including command results.
3. Any residual risk or follow-up.
4. A final section named exactly \`## Suggested Next Steps\` with exactly three tailored bullets.

Each suggested-next-step bullet must use this exact format:
\`- **Short action** — Concrete follow-up prompt the user could send.\`

Make the suggestions specific to the patch and repository state. Prefer useful next actions such as tightening the patch, adding focused tests, updating docs, preparing PR notes, or publishing/updating a PR when appropriate. ${finalLine}`;
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

function collectDiff(cwd: string, baseHead: string): CodeDiffResult {
  const statusBeforeIntent = runGit(cwd, ["status", "--short", ...GIT_DIFF_PATHSPEC]).stdout;
  const untrackedFiles = collectUntrackedFiles(statusBeforeIntent);
  runGit(cwd, ["add", "-N", ...GIT_DIFF_PATHSPEC]);
  const status = runGit(cwd, ["status", "--short", ...GIT_DIFF_PATHSPEC]).stdout;
  const names = [
    ...runGit(cwd, ["diff", "--name-only", baseHead, ...GIT_DIFF_PATHSPEC]).stdout
    .split("\n")
    .map((line) => line.trim())
      .filter((line) => line && !isIgnoredDiffPath(line)),
    ...collectStatusPaths(statusBeforeIntent),
  ];
  const changedFiles = [...new Set(names.filter((line) => line && !isIgnoredDiffPath(line)))];
  const rawBaseDiff = runGit(cwd, ["diff", "--no-ext-diff", "--binary", baseHead, ...GIT_DIFF_PATHSPEC]).stdout;
  const rawDiff = filterIgnoredPatch(appendUntrackedDiffs(cwd, rawBaseDiff, untrackedFiles));
  const { text: diff, truncated } = truncateMiddle(rawDiff || "", MAX_DIFF_CHARS);
  return {
    diff: diff || "(no diff)",
    fullDiff: rawDiff || "(no diff)",
    status: status.trim() || "(clean)",
    changedFiles,
    truncated,
  };
}

function collectStatusPaths(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).trim();
      const rename = path.match(/^(.+?)\s+->\s+(.+)$/);
      return stripGitStatusPath(rename ? rename[2] : path);
    })
    .filter((path) => path && !isIgnoredDiffPath(path));
}

function collectUntrackedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => stripGitStatusPath(line.slice(3).trim()))
    .filter((path) => path && !isIgnoredDiffPath(path));
}

function stripGitStatusPath(path: string): string {
  return path.replace(/^"|"$/g, "").replace(/\\"/g, "\"");
}

function appendUntrackedDiffs(cwd: string, rawDiff: string, untrackedFiles: string[]): string {
  let output = rawDiff || "";
  for (const file of untrackedFiles) {
    if (output.includes(` b/${file}\n`) || output.includes(` b/${file}\t`)) continue;
    const result = runGit(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", file]);
    if (result.stdout.trim()) {
      output += `${output.endsWith("\n") || !output ? "" : "\n"}${result.stdout}`;
    }
  }
  return output;
}

function isUsablePatch(patch: string | undefined): patch is string {
  const trimmed = patch?.trim();
  return Boolean(trimmed && trimmed !== "(no diff)");
}

function applyPatch(cwd: string, patch: string): boolean {
  const filteredPatch = filterIgnoredPatch(patch);
  if (!isUsablePatch(filteredPatch)) return false;

  const dir = mkdtempSync(join(tmpdir(), "rlm-wiki-patch-"));
  const patchPath = join(dir, "previous.patch");
  try {
    writeFileSync(patchPath, filteredPatch);
    const result = runGit(cwd, ["apply", "--whitespace=nowarn", "--binary", patchPath]);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "unknown git apply failure").trim();
      throw new Error(`Could not apply the previous patch before continuing: ${detail}`);
    }
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function filterIgnoredPatch(patch: string): string {
  const trimmed = patch.trim();
  if (!trimmed || trimmed === "(no diff)" || !patch.includes("diff --git ")) return patch;

  const segments: string[] = [];
  let current: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current.length) {
      segments.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) segments.push(current.join("\n"));

  const kept = segments.filter((segment) => {
    const header = segment.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) return true;
    return ![header[1], header[2]].some(isIgnoredDiffPath);
  });
  if (!kept.length) return "";
  const output = kept.join("\n");
  const normalized = repairBlankContextLines(output);
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function isIgnoredDiffPath(path: string): boolean {
  const normalized = path.replace(/^["']|["']$/g, "").replace(/^\.?\//, "");
  return IGNORED_DIFF_PATHS.some((ignored) => {
    const clean = ignored.replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

function repairBlankContextLines(patch: string): string {
  if (!patch.includes("@@")) return patch;
  const lines = patch.split("\n");
  const repaired: string[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldRemaining = hunk[1] == null ? 1 : Number(hunk[1]);
      newRemaining = hunk[2] == null ? 1 : Number(hunk[2]);
      repaired.push(line);
      continue;
    }

    if ((oldRemaining > 0 || newRemaining > 0) && line === "") {
      repaired.push(" ");
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
      continue;
    }

    repaired.push(line);
    if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith(" ")) {
        oldRemaining = Math.max(0, oldRemaining - 1);
        newRemaining = Math.max(0, newRemaining - 1);
      } else if (line.startsWith("-")) {
        oldRemaining = Math.max(0, oldRemaining - 1);
      } else if (line.startsWith("+")) {
        newRemaining = Math.max(0, newRemaining - 1);
      }
    }
  }

  return repaired.join("\n");
}

function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - maxChars;
  return {
    text: `${text.slice(0, half)}\n...[truncated ${dropped.toLocaleString()} chars]...\n${text.slice(-half)}`,
    truncated: true,
  };
}
