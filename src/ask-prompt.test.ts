import { describe, expect, test } from "bun:test";
import { buildWorkspaceChatPrompt } from "./chat.ts";
import { shouldInjectAgentSkills } from "./agent-skill-scope.ts";
import { buildLocalCliPrompt } from "./local-cli-sidecar.ts";
import { buildChatPrompt } from "./prompts/chat.ts";
import { compactAskHistory } from "./prompts/ask-history.ts";

describe("ask prompts", () => {
  test("native single-repo ask prompt stays compact and citation-focused", () => {
    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "Where is auth handled?",
      askMode: "deep",
      runtime: "local-cli",
    });

    expect(prompt).toContain("# Ask Task");
    expect(prompt).toContain("Sources: [src/foo.ts:42-58]()");
    expect(prompt).toContain("Sources: [local_connection.py:421-479]()");
    expect(prompt).toContain("do not append `Sources:` to every sentence or every bullet");
    expect(prompt).toContain("Use the full repo-relative path found by search/read");
    expect(prompt).toContain("Do not cite file-line references as bare text or inline code");
    expect(prompt).toContain("Return the complete answer as plain Markdown with concise source citations for representative evidence.");
    expect(prompt).not.toContain("<ANSWER>");
    expect(prompt).not.toContain("SUBMIT");
    expect(prompt).not.toContain("## How To Work");
    expect(prompt).not.toContain("Start with the direct answer.");
    expect(prompt).not.toContain("Budget:");
  });

  test("single-repo ask prompt names scoped GitHub tree paths", () => {
    const prompt = buildChatPrompt({
      owner: "openai",
      repo: "codex",
      sourcePath: "codex-rs/app-server",
      question: "How does the app server start?",
      askMode: "deep",
      runtime: "local-cli",
    });

    expect(prompt).toContain("openai/codex:codex-rs/app-server");
    expect(prompt).toContain("## Source scope");
    expect(prompt).toContain("Treat that folder as the source root");
    expect(prompt).toContain("Do not inspect unrelated repository folders outside this scope");
  });

  test("native workspace ask prompt keeps namespaced citation guidance", () => {
    const prompt = buildWorkspaceChatPrompt({
      repos: [
        {
          id: "repo-a",
          label: "owner/repo-a",
          owner: "owner",
          repo: "repo-a",
          url: "https://github.com/owner/repo-a",
          branch: null,
          sourcePath: "packages/api",
        },
        {
          id: "repo-b",
          label: "owner/repo-b",
          owner: "owner",
          repo: "repo-b",
          url: "https://github.com/owner/repo-b",
          branch: null,
        },
      ],
      question: "Compare auth flows",
      askMode: "fast",
      runtime: "local-cli",
    });

    expect(prompt).toContain("- `repo-a/`");
    expect(prompt).toContain("scope: packages/api");
    expect(prompt).toContain("## Source scopes");
    expect(prompt).toContain("[repo-a:src/index.ts:12-24]()");
    expect(prompt).toContain("Sources: [repo-id:local_connection.py:421-479]()");
    expect(prompt).toContain("do not append `Sources:` to every sentence or every bullet");
    expect(prompt).toContain("Use the full repo-relative path found by search/read");
    expect(prompt).toContain("Do not cite file-line references as bare text or inline code");
    expect(prompt).toContain("Return the complete answer as plain Markdown with concise source citations for representative evidence.");
    expect(prompt).not.toContain("<ANSWER>");
    expect(prompt).not.toContain("SUBMIT");
    expect(prompt).not.toContain("## How To Work");
    expect(prompt).not.toContain("Start with the direct answer.");
    expect(prompt).not.toContain("local-cli v1 has no MCP integration");
  });

  test("legacy rlm ask prompt keeps the wrapper contract", () => {
    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "Where is auth handled?",
      runtime: "rlm",
    });

    expect(prompt).toContain("<ANSWER>...</ANSWER>");
    expect(prompt).toContain("SUBMIT({ sources: [...] })");
    expect(prompt).toContain("## How To Work");
  });

  test("docs-inline ask prompt answers from documentation before repository study", () => {
    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "How do I configure auth?",
      runtime: "rlm",
      askIntent: "docs-inline",
      wikiContext: "### Authentication\nSet API keys in the provider settings.",
    });

    expect(prompt).toContain("## Documentation context");
    expect(prompt).toContain("Use this generated documentation MDX as the primary source");
    expect(prompt).toContain("Before using any file, search, read, or shell tool, decide whether the generated MDX supports the answer.");
    expect(prompt).toContain("Proceed to repository study only when the docs are out of context");
    expect(prompt).toContain("If you answer from Documentation context only, submit an empty sources array.");
    expect(prompt).toContain("SUBMIT({ sources: [] })");
    expect(prompt).not.toContain("Do not answer from memory or from the wiki context alone.");
    expect(prompt).not.toContain("Never submit an empty sources array for a code answer.");
  });

  test("ask history is same-thread sized and bounded before prompt assembly", () => {
    const compact = compactAskHistory([
      { role: "user", content: "old unrelated user" },
      { role: "assistant", content: "old unrelated answer" },
      { role: "user", content: "current user" },
      { role: "assistant", content: "x".repeat(3000) },
      { role: "user", content: "follow-up user" },
      { role: "assistant", content: "y".repeat(3000) },
    ]);

    expect(compact).toHaveLength(4);
    expect(compact.map((message) => message.content).join("\n")).not.toContain("old unrelated");
    expect(compact[1].content).toContain("[truncated");

    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "Follow up?",
      runtime: "local-cli",
      history: compact,
    });

    expect(prompt).toContain("## Conversation history");
    expect(prompt).not.toContain("old unrelated answer");
    expect(prompt.length).toBeLessThan(8000);
  });

  test("raw skill bodies are excluded from Ask and Wiki synthesis surfaces", () => {
    expect(shouldInjectAgentSkills("ask")).toBe(false);
    expect(shouldInjectAgentSkills("wiki-page")).toBe(false);
    expect(shouldInjectAgentSkills("code")).toBe(true);
  });

  test("local CLI wrapper uses the generic agent identity and tool-call notes", () => {
    const prompt = buildLocalCliPrompt({
      agentName: "Codex CLI",
      context: "# Workspace\n- `repo-a/`",
      prompt: "# Ask Task\nQuestion",
      skillsContext: "",
    });

    expect(prompt).toContain("You are a proactive, Socratic-thinking general-purpose and coding agent");
    expect(prompt).toContain("# Tool call notes");
    expect(prompt).toContain("Parallelize tool calls whenever possible.");
    expect(prompt).toContain("Use the `batch` tool");
    expect(prompt).toContain("Prefer non-interactive commands.");
    expect(prompt).toContain("Utilize sub-agents to map-reduce complex tasks");
    expect(prompt).toContain("Do not claim sub-agents ran");
    expect(prompt).toContain("do not describe work as simulated sub-agents");
    expect(prompt).not.toContain("# Local CLI Runtime");
    expect(prompt).not.toContain("You are Codex CLI running from rlm-wiki Agent mode.");
  });
});

// Regression: the Clarify interview answers were sent as `askIntent`, which the
// server overwrote with the docs-inline mode flag, so clarifications never reached
// the prompt and the agent answered the original (vaguer) question. They now ride
// as a dedicated `clarifyContext` and must appear as an authoritative refinement.
describe("clarify interview context injection", () => {
  const clarify =
    "What you're really asking:\n- Which layer?: The HTTP routing layer\n- Depth?: Just the entrypoint";

  test("single-repo non-rlm prompt injects the clarified intent after the question", () => {
    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "How does routing work?",
      runtime: "local-cli",
      clarifyContext: clarify,
    });

    expect(prompt).toContain("## Clarified intent (authoritative)");
    expect(prompt).toContain("OVERRIDE the question");
    expect(prompt).toContain("The HTTP routing layer");
    expect(prompt).toContain("Just the entrypoint");
    // Must sit between the question and the guidance, i.e. before "## Guidance".
    expect(prompt.indexOf("## Clarified intent")).toBeLessThan(prompt.indexOf("## Guidance"));
    expect(prompt.indexOf("## Question")).toBeLessThan(prompt.indexOf("## Clarified intent"));
  });

  test("single-repo rlm prompt injects the clarified intent before How To Work", () => {
    const prompt = buildChatPrompt({
      owner: "owner",
      repo: "repo",
      question: "How does routing work?",
      runtime: "rlm",
      clarifyContext: clarify,
    });

    expect(prompt).toContain("## Clarified intent (authoritative)");
    expect(prompt.indexOf("## Clarified intent")).toBeLessThan(prompt.indexOf("## How To Work"));
  });

  test("workspace prompt injects the clarified intent", () => {
    const prompt = buildWorkspaceChatPrompt({
      repos: [
        { id: "a", label: "owner/a", owner: "owner", repo: "a", url: "https://github.com/owner/a", branch: null },
        { id: "b", label: "owner/b", owner: "owner", repo: "b", url: "https://github.com/owner/b", branch: null },
      ],
      question: "Compare routing",
      runtime: "local-cli",
      clarifyContext: clarify,
    });

    expect(prompt).toContain("## Clarified intent (authoritative)");
    expect(prompt).toContain("The HTTP routing layer");
  });

  test("no clarify block is emitted when context is absent or blank", () => {
    const none = buildChatPrompt({ owner: "o", repo: "r", question: "q?", runtime: "local-cli" });
    const blank = buildChatPrompt({ owner: "o", repo: "r", question: "q?", runtime: "local-cli", clarifyContext: "   " });
    expect(none).not.toContain("## Clarified intent");
    expect(blank).not.toContain("## Clarified intent");
  });
});
