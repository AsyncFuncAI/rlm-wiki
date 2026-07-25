import { describe, expect, test } from "bun:test";
import { makeLLMTools } from "../vendor/rlm-bun/src/llm/tools.ts";
import type { GenerateActionParams, LLMClient, LLMUsage, StreamCallback } from "../vendor/rlm-bun/src/llm/types.ts";
import type { ParsedOutput } from "../vendor/rlm-bun/src/utils/code-parse.ts";

class FakeLLM implements LLMClient {
  lastUsage: LLMUsage | null = null;
  onStream: StreamCallback | null = null;
  maxTokens = 8192;
  prompts: string[] = [];
  maxTokensSeen: number[] = [];

  constructor(private outputs: string[]) {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.maxTokensSeen.push(this.maxTokens);
    this.lastUsage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
    return this.outputs.shift() ?? "FINAL: default";
  }

  async generateAction(_params: GenerateActionParams): Promise<ParsedOutput> {
    throw new Error("generateAction is not used in llm tool tests");
  }
}

describe("makeLLMTools", () => {
  test("llmQuery hard-caps each sub-LLM call at 4096 tokens and restores the client", async () => {
    const fake = new FakeLLM(["answer"]);
    const tools = makeLLMTools(fake, 10, { maxOutputTokens: 9000 });

    await expect(tools.llmQuery("Summarize this actual content:\n\nconst answer = 42;")).resolves.toBe("answer");

    expect(fake.maxTokensSeen).toEqual([4096]);
    expect(fake.maxTokens).toBe(8192);
    expect(tools.getCallCount()).toBe(1);
    expect(tools.getTokenUsage()).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30, calls: 1 });
  });

  test("llmQueryAgent runs multiple capped turns until FINAL", async () => {
    const fake = new FakeLLM([
      "CONTINUE: Need to compare the second branch.",
      "FINAL: The invariant is enforced at the boundary.",
    ]);
    const tools = makeLLMTools(fake, 10, { maxOutputTokens: 4096, defaultAgentMaxTurns: 4 });

    const result = await tools.llmQueryAgent({
      task: "Analyze the invariant from this evidence.",
      evidence: "function guard(input) { if (!input.id) throw new Error('id required'); return input; }",
      maxTurns: 3,
      maxOutputTokens: 9000,
    });

    expect(result).toMatchObject({
      answer: "The invariant is enforced at the boundary.",
      turns: 2,
      stopped: "final",
    });
    expect(result.transcript).toHaveLength(2);
    expect(fake.maxTokensSeen).toEqual([4096, 4096]);
    expect(tools.getCallCount()).toBe(2);
  });

  test("llmQueryAgent stops at maxTurns when the sub-agent never emits FINAL", async () => {
    const fake = new FakeLLM([
      "CONTINUE: First pass.",
      "CONTINUE: Second pass.",
    ]);
    const tools = makeLLMTools(fake, 10, { defaultAgentMaxTurns: 2 });

    const result = await tools.llmQueryAgent({
      task: "Find the architectural risk.",
      evidence: "class Runner { start() { return this.transport.connect(); } }",
    });

    expect(result.stopped).toBe("max_turns");
    expect(result.turns).toBe(2);
    expect(result.answer).toBe("Second pass.");
  });

  test("llmQueryAgent rejects path-only evidence for analysis prompts", async () => {
    const fake = new FakeLLM(["FINAL: ignored"]);
    const tools = makeLLMTools(fake);

    await expect(
      tools.llmQueryAgent({
        task: "Analyze src/runtime/agent.ts.",
        evidence: "src/runtime/agent.ts",
      })
    ).rejects.toThrow("sub-LLM prompts are not path-aware");
  });

  test("llmQueryAgent counts every turn against the global sub-LLM budget", async () => {
    const fake = new FakeLLM([
      "CONTINUE: first",
      "CONTINUE: second",
      "FINAL: third",
    ]);
    const tools = makeLLMTools(fake, 2, { defaultAgentMaxTurns: 3 });

    await expect(
      tools.llmQueryAgent({
        task: "Resolve this hard subproblem.",
        evidence: "const state = ['a', 'b', 'c'];",
      })
    ).rejects.toThrow("sub-LLM call limit would be exceeded");
    expect(tools.getCallCount()).toBe(2);
  });
});
