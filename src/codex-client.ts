/**
 * Local Codex CLI-backed LLM client.
 *
 * This lets rlm-wiki use the user's Codex/ChatGPT subscription instead of
 * requiring an OpenAI API key. It shells out to `codex exec`, which uses the
 * login stored by `codex login`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseLLMClient } from "../vendor/rlm-bun/src/llm/base.ts";
import type {
  GenerateActionParams,
  LLMUsage,
  StreamCallback,
} from "../vendor/rlm-bun/src/llm/types.ts";
import {
  parseReasoningAndCode,
  type ParsedOutput,
} from "../vendor/rlm-bun/src/utils/code-parse.ts";
import { codexCliEnv } from "./codex-runtime.ts";

interface CodexClientOptions {
  model?: string;
  maxTokens?: number;
  cwd?: string;
}

export class CodexClient extends BaseLLMClient {
  public apiKey = "codex-cli";
  public model: string;
  public maxTokens: number;
  private cwd: string;

  constructor(opts: CodexClientOptions = {}) {
    super();
    this.model = opts.model || "gpt-5.5";
    this.maxTokens = opts.maxTokens || 8192;
    this.cwd = opts.cwd || process.cwd();
  }

  async generate(prompt: string): Promise<string> {
    return this._runCodex(prompt);
  }

  protected async _generateActionBlocking(
    params: GenerateActionParams,
  ): Promise<ParsedOutput> {
    const text = await this._runCodex(this._formatActionPrompt(params));
    return parseReasoningAndCode(text);
  }

  protected async _generateActionStreaming(
    params: GenerateActionParams,
  ): Promise<ParsedOutput> {
    const onStream = this.onStream as StreamCallback;
    let text = "";
    let streamError: Error | null = null;

    try {
      text = await this._runCodex(this._formatActionPrompt(params));
      try { onStream({ type: "text", delta: text }); } catch { /* ignore */ }
    } catch (err) {
      streamError = err as Error;
    } finally {
      try {
        onStream({
          type: "done",
          error: streamError,
          text,
          usage: this.lastUsage,
        });
      } catch { /* ignore */ }
    }

    if (streamError) throw streamError;
    return parseReasoningAndCode(text);
  }

  private _formatActionPrompt({ system, messages }: GenerateActionParams): string {
    const transcript = messages
      .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
      .join("\n\n");

    return [
      "You are running as the model backend for rlm-wiki.",
      "Respond only to the conversation below. Preserve the requested output format exactly, especially JavaScript code fences and <ANSWER> tags.",
      "If the task needs repository inspection, emit JavaScript that uses the rlm-wiki runtime APIs described in the prompt to read and cite files. Do not refuse because file inspection is required.",
      "Do not edit the rlm-wiki host project unless the conversation explicitly asks you to modify it.",
      "",
      "<system>",
      system,
      "</system>",
      "",
      transcript,
    ].join("\n");
  }

  private async _runCodex(prompt: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rlm-wiki-codex-"));
    const promptPath = join(dir, "prompt.txt");
    const outputPath = join(dir, "last-message.txt");
    await writeFile(promptPath, prompt, "utf8");

    const args = [
      "exec",
      "--json",
      "--color", "never",
      "-m", this.model,
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "-C", this.cwd,
      "-o", outputPath,
      "-",
    ];

    try {
      const proc = Bun.spawn(["codex", ...args], {
        cwd: this.cwd,
        stdin: Bun.file(promptPath),
        stdout: "pipe",
        stderr: "pipe",
        env: codexCliEnv(),
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0) {
        throw new Error(
          [
            `codex exec failed with exit code ${exitCode}.`,
            stderr.trim(),
            stdout.trim(),
          ].filter(Boolean).join("\n"),
        );
      }

      const text = (await readFile(outputPath, "utf8")).trim();
      this.lastUsage = this._zeroUsage();
      return text || stdout.trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CodexClient: ${message}\nRun \`codex login status\` to confirm this machine is logged in with ChatGPT/Codex.`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private _zeroUsage(): LLMUsage {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}
