import { RLM } from "../rlm.ts";
import type { RLMEvent } from "../rlm.ts";
import { AnthropicClient } from "../llm/anthropic.ts";
import { OpenAIClient } from "../llm/openai.ts";
import { GeminiClient } from "../llm/gemini.ts";
import { SkillRegistry } from "../skills/index.ts";
import { registerSignalCleanup } from "../utils/signal-cleanup.ts";
import type { LLMClient } from "../llm/types.ts";
import type { SourceSpec } from "./args.ts";
import { C } from "./display.ts";

export function buildClient(p: string, m: string | null, url: string | null): LLMClient {
  if (p === "openai") {
    const mdl = m || "gpt-5.2";
    const opts = url ? { model: mdl, baseURL: url } : { model: mdl };
    return new OpenAIClient(opts);
  } else if (p === "gemini") {
    const mdl = m || "gemini-3.1-pro-preview";
    return new GeminiClient({ model: mdl });
  } else {
    const mdl = m || "claude-opus-4-7";
    return new AnthropicClient({ model: mdl });
  }
}

export interface SetupArgs {
  mode: string;
  provider: string;
  model: string | null;
  subProvider: string | null;
  subModel: string | null;
  subBaseURL: string | null;
  baseURL: string | null;
  maxIter: number;
  maxLLM: number;
  branch: string | null;
  sandboxTimeout: number;
  githubToken: string | null;
  verbose: boolean;
  optimizer: boolean;
  jsonOutput: boolean;
  sessionDir: string | null;
  resumeSessionId: string | null;
  promptMode: boolean;
  source: string | null;
  sources: Array<string | SourceSpec> | undefined;
  onEvent: (event: RLMEvent) => void;
}

export interface SetupResult {
  rlm: RLM;
  skillRegistry: SkillRegistry;
  llm: LLMClient;
  subLM: LLMClient;
}

export async function setupRLM(args: SetupArgs): Promise<SetupResult> {
  const llm = buildClient(args.provider, args.model, args.baseURL);

  const effectiveSubProvider = args.subProvider || args.provider;
  const effectiveSubModel = args.subModel || (args.subProvider ? null : args.model);
  const effectiveSubBaseURL = args.subBaseURL ?? (args.subProvider ? null : args.baseURL);
  const subLM = buildClient(effectiveSubProvider, effectiveSubModel, effectiveSubBaseURL);

  const rlmOpts: Record<string, unknown> = {
    mode: args.sources
      ? (args.mode === "rlm" ? "rlm" : "workspace")
      : (args.promptMode ? "chat" : args.mode),
    branch: args.branch,
    llm,
    subLM,
    maxIterations: args.maxIter,
    maxLLMCalls: args.maxLLM,
    sandboxTimeout: args.sandboxTimeout,
    verbose: false,
    optimizer: args.optimizer,
    onEvent: args.onEvent,
    githubToken: args.githubToken || process.env.GITHUB_TOKEN || undefined,
    sessionDir: args.sessionDir || undefined,
    resumeSessionId: args.resumeSessionId || undefined,
  };

  if (args.sources) {
    rlmOpts.sources = args.sources;
  } else if (!args.promptMode) {
    rlmOpts.source = args.source;
  }

  const rlm = new RLM(rlmOpts as any);
  const skillRegistry = new SkillRegistry();
  const restoredSources = await skillRegistry.restoreFromManifest();
  if (restoredSources.length > 0) {
    rlm.setSkillsPromptText(skillRegistry.formatForPrompt());
    if (!args.jsonOutput) {
      const skillNames = skillRegistry.list().map((s) => s.name).join(", ");
      console.error(`  ${C.muted}\u26a1 Skills restored: ${skillNames}${C.reset}`);
    }
  }

  registerSignalCleanup(async () => {
    if (!args.jsonOutput) console.error(`\n  ${C.muted}⏻ shutting down…${C.reset}`);
    await rlm.destroy();
  });

  return { rlm, skillRegistry, llm, subLM };
}
