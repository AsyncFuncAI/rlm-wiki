import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { extractDecision } from "./local-cli-parsers.ts";
import {
  buildRouteSystemPrompt,
  clarifyRouteDecision,
  normalizeRouteDecision,
  routeDecisionFromRawText,
  runRouteDecision,
} from "./server.ts";
import { normalizeLocalCliConfig } from "./local-cli-events.ts";

describe("extractDecision", () => {
  test("pulls JSON out of a fenced json block surrounded by prose", () => {
    const raw = [
      "Sure! Here's my routing decision for you:",
      "",
      "```json",
      '{ "action": "wiki", "source": "openai/codex", "why": "Explore the repo." }',
      "```",
      "",
      "Let me know if you want anything else.",
    ].join("\n");
    expect(extractDecision(raw)).toEqual({
      action: "wiki",
      source: "openai/codex",
      why: "Explore the repo.",
    });
  });

  test("pulls JSON out of a bare code fence", () => {
    const raw = "```\n{\"action\":\"ask\",\"question\":\"how does auth work?\"}\n```";
    expect(extractDecision(raw)).toEqual({ action: "ask", question: "how does auth work?" });
  });

  test("recovers the first balanced object when there is no fence", () => {
    const raw = 'Decision: {"action": "docs", "source": "a/b", "style": "documentation"} done.';
    expect(extractDecision(raw)).toEqual({ action: "docs", source: "a/b", style: "documentation" });
  });

  test("ignores braces inside string literals", () => {
    const raw = '{"action":"ask","question":"what is {x} in the config?"}';
    expect(extractDecision(raw)).toEqual({ action: "ask", question: "what is {x} in the config?" });
  });

  test("returns null on unparseable text", () => {
    expect(extractDecision("I am not sure how to answer that.")).toBeNull();
    expect(extractDecision("")).toBeNull();
    expect(extractDecision("{ this is not json }")).toBeNull();
  });

  test("unwraps an <ANSWER> wrapper before parsing", () => {
    const raw = '<ANSWER>{"action":"terminal","source":"o/r"}</ANSWER>';
    expect(extractDecision(raw)).toEqual({ action: "terminal", source: "o/r" });
  });
});

describe("normalizeRouteDecision contract shape", () => {
  test("fills wiki defaults and drops irrelevant fields", () => {
    const decision = normalizeRouteDecision({
      action: "wiki",
      source: "openai/codex",
      question: "ignored for wiki",
    });
    expect(decision).toMatchObject({
      action: "wiki",
      source: "openai/codex",
      style: "technical",
      question: null,
    });
    expect(Array.isArray(decision.suggestions)).toBe(true);
  });

  test("defaults docs style to documentation", () => {
    expect(normalizeRouteDecision({ action: "docs", source: "a/b" }).style).toBe("documentation");
  });

  test("keeps a valid wiki style and parses pageCount", () => {
    const decision = normalizeRouteDecision({
      action: "wiki",
      source: "sashimikun/con-terminal",
      style: "mental-model",
      pageCount: 3,
    });
    expect(decision.style).toBe("mental-model");
    expect(decision.pageCount).toBe(3);
  });

  test("accepts a custom style with a polished stylePrompt", () => {
    const decision = normalizeRouteDecision({
      action: "wiki",
      source: "x/y",
      style: "custom",
      stylePrompt: "Write in a witty, sarcastic voice while staying technically accurate.",
    });
    expect(decision.style).toBe("custom");
    expect(decision.stylePrompt).toContain("sarcastic");
  });

  test("custom style without a stylePrompt falls back to technical", () => {
    const decision = normalizeRouteDecision({ action: "wiki", source: "x/y", style: "custom" });
    expect(decision.style).toBe("technical");
    expect(decision.stylePrompt).toBeNull();
  });

  test("rejects an unknown wiki style (falls back to technical) and clamps pageCount", () => {
    const decision = normalizeRouteDecision({ action: "wiki", source: "a/b", style: "make-it-funny", pageCount: 999 });
    expect(decision.style).toBe("technical");
    expect(decision.pageCount).toBe(30);
  });

  test("nulls pageCount for non-wiki actions and invalid values", () => {
    expect(normalizeRouteDecision({ action: "ask", source: "a/b", pageCount: 5 }).pageCount).toBeNull();
    expect(normalizeRouteDecision({ action: "wiki", source: "a/b", pageCount: 0 }).pageCount).toBeNull();
  });

  test("keeps the cleaned question for ask and clears style", () => {
    const decision = normalizeRouteDecision({
      action: "ask",
      source: "a/b",
      question: "  How does login work?  ",
      style: "technical",
    });
    expect(decision.action).toBe("ask");
    expect(decision.question).toBe("How does login work?");
    expect(decision.style).toBeNull();
  });

  test("coerces the literal string \"null\" source to null", () => {
    expect(normalizeRouteDecision({ action: "clarify", source: "null" }).source).toBeNull();
  });

  test("filters malformed suggestions and caps at three", () => {
    const decision = normalizeRouteDecision({
      action: "ask",
      question: "x",
      suggestions: [
        { label: "Wiki it", action: "wiki", source: "a/b" },
        { label: "no action" },
        { action: "ask" },
        { label: "Bad action", action: "explode", source: "a/b" },
        { label: "Docs", action: "docs", source: null },
        { label: "Terminal", action: "terminal", source: "a/b" },
        { label: "Fourth", action: "ask", source: "a/b" },
      ],
    });
    expect(decision.suggestions).toHaveLength(3);
    expect(decision.suggestions[0]).toEqual({ label: "Wiki it", action: "wiki", source: "a/b" });
    expect(decision.suggestions.every((s) => ["wiki", "docs", "ask", "terminal", "clarify"].includes(s.action))).toBe(true);
  });

  test("degrades to clarify on an invalid action", () => {
    expect(normalizeRouteDecision({ action: "nope" }).action).toBe("clarify");
    expect(normalizeRouteDecision(null).action).toBe("clarify");
    expect(normalizeRouteDecision("string").action).toBe("clarify");
  });
});

describe("routeDecisionFromRawText", () => {
  test("parses messy agent output end to end", () => {
    const raw = [
      "I think the best fit is a wiki.",
      "```json",
      '{ "action": "wiki", "source": "https://github.com/openai/codex", "why": "Understand the codebase.", "suggestions": [ { "label": "Ask instead", "action": "ask", "source": "openai/codex" } ] }',
      "```",
    ].join("\n");
    const decision = routeDecisionFromRawText(raw);
    expect(decision.action).toBe("wiki");
    expect(decision.source).toBe("https://github.com/openai/codex");
    expect(decision.style).toBe("technical");
    expect(decision.suggestions).toEqual([{ label: "Ask instead", action: "ask", source: "openai/codex" }]);
  });

  test("returns a clarify decision when the agent emits no JSON", () => {
    const decision = routeDecisionFromRawText("Hmm, I really am not sure what you want.");
    expect(decision.action).toBe("clarify");
    expect(typeof decision.why).toBe("string");
    expect(decision.why.length).toBeGreaterThan(0);
  });
});

describe("buildRouteSystemPrompt", () => {
  test("embeds the user query and the contract instructions", () => {
    const prompt = buildRouteSystemPrompt("explain the auth flow in owner/repo");
    expect(prompt).toContain("explain the auth flow in owner/repo");
    expect(prompt).toContain('"action": "wiki" | "docs" | "ask" | "terminal" | "clarify"');
    expect(prompt).toContain("Output ONLY a single fenced JSON block");
    // The pageCount example must be null, not a concrete number — a literal like
    // "3" here makes the routing LLM parrot it back and every wiki comes out at
    // that page count even when the user never asked for one.
    expect(prompt).toContain('"pageCount": null');
    expect(prompt).not.toContain('"pageCount": 3 | null');
    // The agent ballparks a count from scope when no explicit number is given.
    expect(prompt).toContain("BALLPARK a sensible count");
  });
});

describe("runRouteDecision", () => {
  const localCli = normalizeLocalCliConfig({ agentId: "claude" });

  test("honors the selected agent and parses its decision", async () => {
    let seenAgentId = "";
    const decision = await runRouteDecision(
      "generate a wiki for openai/codex",
      localCli,
      async (_prompt, cli) => {
        seenAgentId = cli.agentId;
        return '```json\n{"action":"wiki","source":"openai/codex","why":"Explore it."}\n```';
      },
    );
    expect(seenAgentId).toBe("claude");
    expect(decision.action).toBe("wiki");
    expect(decision.source).toBe("openai/codex");
  });

  test("degrades to clarify when the agent runner throws", async () => {
    const decision = await runRouteDecision(
      "do something",
      localCli,
      async () => {
        throw new Error("agent unavailable");
      },
    );
    expect(decision.action).toBe("clarify");
    expect(decision.why).toContain("agent unavailable");
  });

  test("degrades to clarify when the agent returns garbage on every turn", async () => {
    let calls = 0;
    const decision = await runRouteDecision(
      "do something",
      localCli,
      async () => {
        calls += 1;
        return "I cannot help with that right now.";
      },
    );
    expect(decision.action).toBe("clarify");
    // a repair turn was attempted before giving up
    expect(calls).toBe(2);
  });

  test("repair turn recovers a usable decision after unparseable first reply", async () => {
    let calls = 0;
    const decision = await runRouteDecision(
      "generate a 3 page mental model wiki for x/y",
      localCli,
      async () => {
        calls += 1;
        // First reply: prose, no JSON. Second (repair) reply: clean contract.
        return calls === 1
          ? "Sure! I think a mental model wiki of 3 pages would be great."
          : '```json\n{"action":"wiki","source":"x/y","style":"mental-model","pageCount":3,"why":"ok"}\n```';
      },
    );
    expect(calls).toBe(2);
    expect(decision.action).toBe("wiki");
    expect(decision.style).toBe("mental-model");
    expect(decision.pageCount).toBe(3);
  });

  test("a good first reply does NOT trigger a repair turn", async () => {
    let calls = 0;
    const decision = await runRouteDecision(
      "wiki for a/b",
      localCli,
      async () => {
        calls += 1;
        return '{"action":"wiki","source":"a/b","why":"ok"}';
      },
    );
    expect(calls).toBe(1);
    expect(decision.action).toBe("wiki");
  });

  test("times out and degrades to clarify when the agent hangs", async () => {
    const decision = await runRouteDecision(
      "do something",
      localCli,
      (_prompt, _cli, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      10,
    );
    expect(decision.action).toBe("clarify");
  });
});

describe("clarifyRouteDecision", () => {
  test("produces a complete, safe default contract", () => {
    const decision = clarifyRouteDecision();
    expect(decision).toEqual({
      action: "clarify",
      source: null,
      question: null,
      style: null,
      stylePrompt: null,
      pageCount: null,
      why: expect.any(String),
      suggestions: [],
    });
  });
});

describe("knowledge-base route publication state", () => {
  test("GET /api/knowledge-base reads the stored publication so private links stay private", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const routeStart = source.indexOf('url.pathname === "/api/knowledge-base"');
    const routeEnd = source.indexOf('url.pathname === "/api/distill"', routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(route).toContain("WIKI_PUBLICATION_ARTIFACT_KIND");
    expect(route).toContain("wikiInstanceArtifactKey(kb.wikiRecordId)");
    expect(route).toContain("publicationStateFromData");
    expect(route).toContain("publication.publicUrl || fallbackPublicUrl");
    expect(route.indexOf("publicationStateFromData")).toBeLessThan(route.indexOf("fallbackPublicUrl"));
  });
});
