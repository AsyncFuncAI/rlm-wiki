import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildWikiInterviewPrompt,
  normalizeWikiInterview,
  runWikiInterview,
  WIKI_INTERVIEW_MAX_QUESTIONS,
} from "./wiki-interview.ts";
import { normalizeLocalCliConfig } from "./local-cli-events.ts";

describe("buildWikiInterviewPrompt", () => {
  test("includes the intent, the source line, and the fenced-json instruction", () => {
    const prompt = buildWikiInterviewPrompt("focus on the auth flow", "owner/repo");
    expect(prompt).toContain("focus on the auth flow");
    expect(prompt).toContain("Repository / source under discussion: owner/repo");
    expect(prompt).toContain("```json");
    expect(prompt).toContain(`Produce 2 to ${WIKI_INTERVIEW_MAX_QUESTIONS}`);
  });

  test("notes when no source was provided", () => {
    const prompt = buildWikiInterviewPrompt("anything", null);
    expect(prompt).toContain("No repository was provided yet.");
  });
});

describe("normalizeWikiInterview", () => {
  test("returns [] for null / non-array / non-object", () => {
    expect(normalizeWikiInterview(null)).toEqual([]);
    expect(normalizeWikiInterview(undefined)).toEqual([]);
    expect(normalizeWikiInterview(42)).toEqual([]);
    expect(normalizeWikiInterview({ nope: true })).toEqual([]);
  });

  test("accepts a bare array (no questions wrapper)", () => {
    const out = normalizeWikiInterview([
      { id: "a", title: "Q", options: [{ id: "x", title: "X" }, { id: "y", title: "Y" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
  });

  test("drops questions with fewer than 2 options or no title", () => {
    const out = normalizeWikiInterview({
      questions: [
        { id: "ok", title: "Good", options: [{ id: "1", title: "One" }, { id: "2", title: "Two" }] },
        { id: "tooFew", title: "Bad", options: [{ id: "1", title: "Only" }] },
        { id: "noTitle", options: [{ id: "1", title: "A" }, { id: "2", title: "B" }] },
      ],
    });
    expect(out.map((q) => q.id)).toEqual(["ok"]);
  });

  test("clamps options to 5", () => {
    const opts = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, title: `Opt ${i}` }));
    const out = normalizeWikiInterview({ questions: [{ id: "q", title: "Q", options: opts }] });
    expect(out[0].options).toHaveLength(5);
  });

  test("defaults skippable and allowOther to true and multiSelect to false", () => {
    const out = normalizeWikiInterview({
      questions: [{ id: "q", title: "Q", options: [{ id: "a", title: "A" }, { id: "b", title: "B" }] }],
    });
    expect(out[0].skippable).toBe(true);
    expect(out[0].allowOther).toBe(true);
    expect(out[0].multiSelect).toBe(false);
  });

  test("honors explicit false flags", () => {
    const out = normalizeWikiInterview({
      questions: [
        {
          id: "q",
          title: "Q",
          multiSelect: true,
          allowOther: false,
          skippable: false,
          options: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
        },
      ],
    });
    expect(out[0].multiSelect).toBe(true);
    expect(out[0].allowOther).toBe(false);
    expect(out[0].skippable).toBe(false);
  });

  test("coerces missing question ids and option ids", () => {
    const out = normalizeWikiInterview({
      questions: [{ title: "Q", options: [{ title: "A" }, { title: "B" }] }],
    });
    expect(out[0].id).toBe("q-0");
    expect(out[0].options[0].id).toBe("opt-0-0");
    expect(out[0].options[1].id).toBe("opt-0-1");
  });

  test("truncates to the max number of questions", () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      title: `Question ${i}`,
      options: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
    }));
    const out = normalizeWikiInterview({ questions });
    expect(out).toHaveLength(WIKI_INTERVIEW_MAX_QUESTIONS);
  });
});

describe("runWikiInterview", () => {
  const localCli = normalizeLocalCliConfig({ agentId: "claude" });

  test("returns parsed questions on good JSON and passes the localCli through", async () => {
    let seenAgentId = "";
    const questions = await runWikiInterview(
      "focus on auth",
      "owner/repo",
      localCli,
      async (_prompt, cli) => {
        seenAgentId = cli.agentId;
        return [
          "```json",
          JSON.stringify({
            questions: [
              { id: "scope", title: "Scope?", options: [{ id: "all", title: "All" }, { id: "one", title: "One" }] },
            ],
          }),
          "```",
        ].join("\n");
      },
    );
    expect(seenAgentId).toBe("claude");
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("scope");
  });

  test("returns [] when the runner throws", async () => {
    const questions = await runWikiInterview("x", null, localCli, async () => {
      throw new Error("agent down");
    });
    expect(questions).toEqual([]);
  });

  test("returns [] on timeout (runner hangs until aborted)", async () => {
    const questions = await runWikiInterview(
      "x",
      null,
      localCli,
      (_prompt, _cli, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      10,
    );
    expect(questions).toEqual([]);
  });

  test("returns [] when the runner emits unparseable text", async () => {
    const questions = await runWikiInterview("x", null, localCli, async () => "no json here, sorry");
    expect(questions).toEqual([]);
  });
});

// Regression: /api/ask used to read the Clarify transcript from `body.askIntent`,
// but immediately overwrote that local with the docs-inline mode flag — so the
// clarifications were silently dropped and the agent answered the original
// question. The transcript now arrives as a dedicated `clarifyContext` field,
// kept separate from the `askIntent` mode flag, and is forwarded to the engine.
describe("/api/ask forwards the clarify transcript distinctly from the mode flag", () => {
  const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

  test("the request body declares a clarifyContext field", () => {
    expect(server).toContain("clarifyContext?: string;");
  });

  test("clarifyContext is read from the body, not aliased onto askIntent", () => {
    expect(server).toContain("typeof body.clarifyContext === \"string\"");
    // The mode flag stays its own separate derivation.
    expect(server).toContain('const askIntent = body.askIntent === "docs-inline" ? "docs-inline" : "repo";');
  });

  test("both askRepo and askWorkspace receive clarifyContext", () => {
    // It appears once in each call's options object (workspace + single-repo).
    const occurrences = server.split("clarifyContext,").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
