import { describe, expect, test } from "bun:test";
import {
  buildTaskExtractPrompt,
  buildEpicExtractPrompt,
  normalizeTaskExtract,
  normalizeEpicExtract,
  runTaskExtract,
  runEpicExtract,
  TASK_EXTRACT_MAX_TASKS,
  TASK_EXTRACT_MAX_EPICS,
} from "./task-extract.ts";
import { normalizeLocalCliConfig } from "./local-cli-events.ts";

describe("buildTaskExtractPrompt", () => {
  test("includes the answer, the question line, and the fenced-json instruction", () => {
    const prompt = buildTaskExtractPrompt("Fix the stale bundle warning.", "how do I fix HMR?");
    expect(prompt).toContain("Fix the stale bundle warning.");
    expect(prompt).toContain("The user's question was: how do I fix HMR?");
    expect(prompt).toContain("```json");
    expect(prompt).toContain(`1 to ${TASK_EXTRACT_MAX_TASKS}`);
  });

  test("asks for scannable bullet-point briefs with an outcome sentence", () => {
    const prompt = buildTaskExtractPrompt("anything", null);
    expect(prompt).toContain("One plain-language sentence stating the outcome");
    expect(prompt).toContain("2 to 5 bullet points");
    expect(prompt).toContain("Done when:");
  });

  test("omits the question line when no question is provided", () => {
    const prompt = buildTaskExtractPrompt("anything", null);
    expect(prompt).not.toContain("The user's question was:");
  });
});

describe("normalizeTaskExtract", () => {
  test("returns [] for null / non-array / non-object", () => {
    expect(normalizeTaskExtract(null)).toEqual([]);
    expect(normalizeTaskExtract(undefined)).toEqual([]);
    expect(normalizeTaskExtract(42)).toEqual([]);
    expect(normalizeTaskExtract({ nope: true })).toEqual([]);
  });

  test("accepts a bare array (no tasks wrapper)", () => {
    const out = normalizeTaskExtract([{ title: "Do X", brief: "Steps for X" }]);
    expect(out).toEqual([{ title: "Do X", brief: "Steps for X" }]);
  });

  test("drops entries without a title and falls back to the title as brief", () => {
    const out = normalizeTaskExtract({
      tasks: [
        { title: "", brief: "orphan brief" },
        { brief: "no title at all" },
        { title: "Title only" },
        "not an object",
      ],
    });
    expect(out).toEqual([{ title: "Title only", brief: "Title only" }]);
  });

  test("caps the list at TASK_EXTRACT_MAX_TASKS and truncates long titles", () => {
    const tasks = Array.from({ length: TASK_EXTRACT_MAX_TASKS + 5 }, (_, i) => ({
      title: `${"x".repeat(200)}-${i}`,
      brief: "b",
    }));
    const out = normalizeTaskExtract({ tasks });
    expect(out).toHaveLength(TASK_EXTRACT_MAX_TASKS);
    expect(out[0].title.length).toBe(120);
  });
});

describe("runTaskExtract", () => {
  const localCli = normalizeLocalCliConfig({ agentId: "claude" });

  test("returns parsed tasks on good JSON and passes the localCli through", async () => {
    let seenAgentId = "";
    const tasks = await runTaskExtract(
      "1. Fix the bug\n2. Add tests",
      "what should I do?",
      localCli,
      async (_prompt, cli) => {
        seenAgentId = cli.agentId;
        return [
          "```json",
          JSON.stringify({
            tasks: [
              { title: "Fix the bug", brief: "Find and fix the bug in module X." },
              { title: "Add tests", brief: "Cover the fix with a regression test." },
            ],
          }),
          "```",
        ].join("\n");
      },
    );
    expect(seenAgentId).toBe("claude");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Fix the bug");
  });

  test("returns [] when the runner throws", async () => {
    const tasks = await runTaskExtract("x", null, localCli, async () => {
      throw new Error("agent down");
    });
    expect(tasks).toEqual([]);
  });

  test("returns [] on timeout (runner hangs until aborted)", async () => {
    const tasks = await runTaskExtract(
      "x",
      null,
      localCli,
      (_prompt, _cli, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      10,
    );
    expect(tasks).toEqual([]);
  });
});

describe("buildEpicExtractPrompt", () => {
  test("asks for theme-split epics, forbids question-as-title, and hard-excludes non-tasks", () => {
    const prompt = buildEpicExtractPrompt("answer", "/ce-ideate what are the highest-leverage");
    expect(prompt).toContain(`1 to ${TASK_EXTRACT_MAX_EPICS} epics BY THEME`);
    expect(prompt).toContain("do not lump unrelated");
    expect(prompt).toContain("NEVER use the user's question as an epic title");
    expect(prompt).toContain("senior product manager");
    expect(prompt).toContain("status names, column names");
    // The question is passed for context but explicitly marked do-not-use.
    expect(prompt).toContain("DO NOT use this as a title");
    expect(prompt).toContain('"epics"');
  });
});

describe("normalizeEpicExtract", () => {
  test("returns [] for malformed input", () => {
    expect(normalizeEpicExtract(null)).toEqual([]);
    expect(normalizeEpicExtract({ nope: 1 })).toEqual([]);
  });

  test("drops epics with no valid sub-tasks and keeps well-formed ones", () => {
    const out = normalizeEpicExtract({
      epics: [
        { title: "Empty epic", summary: "x", tasks: [] },
        { title: "Real epic", summary: "ships X", tasks: [{ title: "Do A", brief: "steps" }] },
        { summary: "no title", tasks: [{ title: "Do B", brief: "b" }] },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Real epic");
    expect(out[0].tasks).toEqual([{ title: "Do A", brief: "steps" }]);
  });

  test("caps epics at TASK_EXTRACT_MAX_EPICS", () => {
    const epics = Array.from({ length: TASK_EXTRACT_MAX_EPICS + 3 }, (_, i) => ({
      title: `Epic ${i}`,
      summary: "s",
      tasks: [{ title: "t", brief: "b" }],
    }));
    expect(normalizeEpicExtract({ epics })).toHaveLength(TASK_EXTRACT_MAX_EPICS);
  });
});

describe("runEpicExtract", () => {
  const localCli = normalizeLocalCliConfig({ agentId: "claude" });

  test("parses epics from good JSON", async () => {
    const epics = await runEpicExtract("answer", null, localCli, async () =>
      [
        "```json",
        JSON.stringify({
          epics: [
            { title: "Regenerate", summary: "per-turn", tasks: [{ title: "Backend", brief: "do it" }] },
          ],
        }),
        "```",
      ].join("\n"),
    );
    expect(epics).toHaveLength(1);
    expect(epics[0].tasks[0].title).toBe("Backend");
  });

  test("returns [] when the runner throws", async () => {
    const epics = await runEpicExtract("x", null, localCli, async () => {
      throw new Error("down");
    });
    expect(epics).toEqual([]);
  });
});
