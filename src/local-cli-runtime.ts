import type { LLMClient } from "./llm-core.ts";
import type { GitHubFetch, MCPConfig, RLMEvent, RLMOptions, RLMQueryResult } from "./jcode-runtime.ts";
import { normalizeLocalCliConfig, type LocalCliConfig } from "./local-cli-events.ts";
import { runLocalCliSidecar } from "./local-cli-sidecar-client.ts";
import type { CodeScreenshotAttachment } from "./vision.ts";
import { shouldInjectAgentSkills } from "./agent-skill-scope.ts";

interface SourceSpec {
  id?: string;
  source: string;
  branch?: string | null;
  sourcePath?: string | null;
  label?: string;
}

export interface LocalCliOptions {
  source?: string;
  sources?: Array<string | SourceSpec>;
  mode?: RLMOptions["mode"];
  branch?: string | null;
  sourcePath?: string | null;
  llm?: LLMClient;
  subLM?: LLMClient;
  maxIterations?: number;
  maxLLMCalls?: number;
  defaultAgent?: string;
  mcpConfig?: MCPConfig;
  sessionDir?: string;
  firstUserMessageSuffix?: string;
  githubFetch?: GitHubFetch;
  localCli?: LocalCliConfig | unknown;
  basePatch?: string;
  screenshots?: CodeScreenshotAttachment[];
  contextLabel?: string;
  onEvent?: (event: RLMEvent) => void;
}

export class LocalCliAgent {
  private source: string | null;
  private sources: Array<string | SourceSpec> | null;
  private branch: string | null | undefined;
  private sourcePath: string | null | undefined;
  private firstUserMessageSuffix: string;
  private localCli: LocalCliConfig;
  private basePatch: string;
  private screenshots: CodeScreenshotAttachment[];
  private contextLabel: string;
  private onEvent: ((event: RLMEvent) => void) | null;
  private skillsPromptText = "";
  private sourceless: boolean;

  constructor(opts: Partial<LocalCliOptions>) {
    if (opts.source && opts.sources) {
      throw new Error("local-cli: use 'source' or 'sources', not both");
    }
    if (!opts.source && !opts.sources && opts.mode !== "chat") {
      throw new Error("local-cli: source or sources is required");
    }
    // Chat mode is the sourceless escape hatch: no repository clone, run in an empty CWD.
    this.sourceless = opts.mode === "chat" && !opts.source && !opts.sources;
    this.source = opts.source ?? null;
    this.sources = opts.sources ?? null;
    this.branch = opts.branch;
    this.sourcePath = opts.sourcePath;
    this.firstUserMessageSuffix = opts.firstUserMessageSuffix ?? "";
    this.localCli = normalizeLocalCliConfig(opts.localCli ?? { agentId: opts.defaultAgent });
    this.basePatch = opts.basePatch ?? "";
    this.screenshots = Array.isArray(opts.screenshots) ? opts.screenshots : [];
    this.contextLabel = opts.contextLabel ?? "";
    this.onEvent = opts.onEvent ?? null;
  }

  setSkillsPromptText(text: string): void {
    this.skillsPromptText = text;
  }

  setBasePatch(patch: string): void {
    this.basePatch = patch;
  }

  async query(prompt: string, signal?: AbortSignal): Promise<RLMQueryResult & { workspacePath?: string; baseHead?: string; rawText?: string }> {
    const requestPrompt = [
      this.skillsPromptText && shouldInjectAgentSkills(this.contextLabel)
        ? `# Loaded Skills\n${this.skillsPromptText}`
        : "",
      this.firstUserMessageSuffix ? `# Model-Specific Guidance\n${this.firstUserMessageSuffix}` : "",
      prompt,
    ].filter((section) => section.trim()).join("\n\n");

    const metadata = await runLocalCliSidecar({
      source: this.source ?? undefined,
      sources: this.sources ?? undefined,
      branch: this.branch ?? null,
      sourcePath: this.sourcePath ?? null,
      prompt: requestPrompt,
      localCli: this.localCli,
      basePatch: this.basePatch || undefined,
      screenshots: this.screenshots,
      contextLabel: this.contextLabel || undefined,
      ...(this.sourceless ? { sourceless: true } : {}),
    }, (event) => this.emit(event as unknown as RLMEvent), signal);

    return {
      answer: metadata.answer,
      sources: metadata.sources,
      trajectory: [],
      finalReasoning: "",
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
      workspacePath: metadata.workspacePath,
      baseHead: metadata.baseHead,
      rawText: metadata.rawText,
    };
  }

  private emit(event: RLMEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // UI event plumbing must not fail the agent run.
    }
  }
}
