import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpeningPageFirstWikiStructure, ensureOverviewFirstWikiPage, fastPageTimeoutDefaultMs, fastStructureTimeoutDefaultMs, fetchWikiDirectPageEvidencePacks, fetchWikiPageEvidencePacks, fetchWikiStructureEvidence, friendlyWikiGenerationError, generateWiki, normalizeWikiGenerationRuntime, prefetchWikiCodeKbPrompts, resolveWikiConcurrency, structureFromCodeKb, wikiPageQualityIssue, type GenerationEvent, type WikiCodeKbOptions } from "./generator.ts";
import { knowledgeProfilePrompt, normalizeKnowledgeProfile } from "./knowledge-profile.ts";
import { __resetLocalCliSidecarForTests, __setLocalCliSidecarStarterForTests } from "./local-cli-sidecar-client.ts";
import { renderCodeKbBlock } from "./prompts/code-kb.ts";
import { buildPagePrompt } from "./prompts/page.ts";
import { buildStructurePrompt } from "./prompts/structure.ts";
import type { CodeKbSession } from "./sharenow-kb-client.ts";
import { WikiStore } from "./storage.ts";
import type { RepoRef, WikiPage } from "./types.ts";
import { wikiAutoPageCountRange } from "./wiki-options.ts";

describe("wiki generation runtime", () => {
  test("defaults wiki generation to local CLI", () => {
    expect(normalizeWikiGenerationRuntime(undefined)).toBe("local-cli");
    expect(normalizeWikiGenerationRuntime("local-cli")).toBe("local-cli");
  });

  test("rejects legacy wiki runtime modes before agents can spawn", () => {
    expect(() => normalizeWikiGenerationRuntime("rlm")).toThrow(/Local CLI-only/);
    expect(() => normalizeWikiGenerationRuntime("agent")).toThrow(/Local CLI-only/);
  });

  test("caps page agent concurrency at ten", () => {
    expect(resolveWikiConcurrency({ provider: "openai" } as any, 10)).toBe(10);
    expect(resolveWikiConcurrency({ provider: "openai" } as any, 25)).toBe(10);
  });

  test("defaults page agent concurrency to a quota-safe batch", () => {
    const previous = process.env.RLM_WIKI_PAGE_CONCURRENCY;
    delete process.env.RLM_WIKI_PAGE_CONCURRENCY;
    try {
      expect(resolveWikiConcurrency({ provider: "openai" } as any)).toBe(4);
    } finally {
      if (previous === undefined) {
        delete process.env.RLM_WIKI_PAGE_CONCURRENCY;
      } else {
        process.env.RLM_WIKI_PAGE_CONCURRENCY = previous;
      }
    }
  });

  test("local-cli runs default to eight page workers (stream-bound, not CPU-bound)", () => {
    const previousShared = process.env.RLM_WIKI_PAGE_CONCURRENCY;
    const previousLocal = process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY;
    delete process.env.RLM_WIKI_PAGE_CONCURRENCY;
    delete process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY;
    try {
      expect(resolveWikiConcurrency({ provider: "openai" } as any, undefined, { agentId: "grok" })).toBe(8);
      // Explicit request still wins; the shared env override still applies.
      expect(resolveWikiConcurrency({ provider: "openai" } as any, 3, { agentId: "grok" })).toBe(3);
      process.env.RLM_WIKI_PAGE_CONCURRENCY = "5";
      expect(resolveWikiConcurrency({ provider: "openai" } as any, undefined, { agentId: "claude" })).toBe(5);
      process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY = "6";
      expect(resolveWikiConcurrency({ provider: "openai" } as any, undefined, { agentId: "claude" })).toBe(6);
    } finally {
      if (previousShared === undefined) delete process.env.RLM_WIKI_PAGE_CONCURRENCY;
      else process.env.RLM_WIKI_PAGE_CONCURRENCY = previousShared;
      if (previousLocal === undefined) delete process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY;
      else process.env.RLM_WIKI_LOCAL_CLI_PAGE_CONCURRENCY = previousLocal;
    }
  });

  test("serializes Antigravity wiki page workers by default", () => {
    const previous = process.env.RLM_WIKI_ANTIGRAVITY_PAGE_CONCURRENCY;
    delete process.env.RLM_WIKI_ANTIGRAVITY_PAGE_CONCURRENCY;
    try {
      expect(resolveWikiConcurrency({ provider: "openai" } as any, undefined, { agentId: "antigravity" })).toBe(1);
      expect(resolveWikiConcurrency({ provider: "openai" } as any, 8, { agentId: "antigravity" })).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.RLM_WIKI_ANTIGRAVITY_PAGE_CONCURRENCY;
      } else {
        process.env.RLM_WIKI_ANTIGRAVITY_PAGE_CONCURRENCY = previous;
      }
    }
  });
});

describe("wiki generation errors", () => {
  test("turns raw local-agent failures into recovery-oriented copy", () => {
    const message = friendlyWikiGenerationError(
      "the local CLI runtime failed: codex exited with 1: Reading prompt from stdin... 2026-05-24T01:25:25.159443Z ERROR failed to connect to websocket: HTTP error: 503 Service Unavailable",
    );

    expect(message).toContain("temporarily unavailable");
    expect(message).toContain("Recover this page");
    expect(message).not.toContain("codex exited");
    expect(message).not.toContain("Reading prompt");
  });
});

describe("wiki prompts", () => {
  test("auto page-count prompts ask the structure agent to choose under the ceiling", () => {
    const prompt = buildStructurePrompt({
      owner: "AsyncFuncAI",
      repo: "grok-wiki",
      pageCount: 12,
      pageCountMode: "auto",
    });

    expect(prompt).toContain("Page target: **auto, up to 12 pages");
    expect(prompt).toContain("Choose the smallest useful number of pages between 3 and 12");
    expect(prompt).toContain("Do not fill all 12 slots unless the repository genuinely needs that many distinct pages.");
    expect(prompt).not.toContain("emit exactly 12 <page>");
  });

  test("fixed page-count prompts preserve exact-count API behavior", () => {
    const prompt = buildStructurePrompt({
      owner: "AsyncFuncAI",
      repo: "grok-wiki",
      pageCount: 12,
      pageCountMode: "fixed",
    });

    expect(prompt).toContain("Page target: **12 pages");
    expect(prompt).toContain("exactly 12 total pages");
    expect(prompt).toContain("emit exactly 12 <page>");
  });

  test("structure prompts do not include legacy RLM submit contracts", () => {
    const prompt = buildStructurePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      runtime: "rlm",
      pageCount: 1,
    });

    expect(prompt).not.toContain("SUBMIT({ sources");
    expect(prompt).not.toContain("rlm-bun");
    expect(prompt).not.toContain("Use the sandbox");
    expect(prompt).not.toMatch(/graphify|tokio|line[- ]?count|files\s*>\s*\d+\s*lines/i);
  });

  test("structure prompts require a format-specific opening and deliberate finish", () => {
    const prompt = buildStructurePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      pageCount: 3,
      style: "worth-stealing",
    });

    expect(prompt).toContain('The first page in `<pages>` must use the stable internal id `id="page-overview"`');
    expect(prompt).toContain("the first `<page_ref>` in the first section");
    expect(prompt).toContain("do not call it \"Overview\" unless that is genuinely the strongest title");
    expect(prompt).toContain("What Is Worth Stealing");
    expect(prompt).toContain("The final page should be a real closing page");
    expect(prompt).toContain("The first emitted page always uses internal id `page-overview`, but its visible title should be format-specific.");
    expect(prompt).not.toContain("`page-overview` / Overview");
  });

  test("page prompts do not include legacy RLM submit contracts", () => {
    const prompt = buildPagePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      runtime: "rlm",
      page: {
        id: "page-overview",
        title: "Overview",
        description: "What this repo is and how it works.",
        filePaths: ["README.md", "pyproject.toml"],
      },
    });

    expect(prompt).not.toContain("SUBMIT({ sources");
    expect(prompt).not.toContain("rlm-bun");
    expect(prompt).not.toContain("JavaScript sandbox");
    expect(prompt).not.toMatch(/graphify|tokio|line[- ]?count|files\s*>\s*\d+\s*lines/i);
  });

  test("page prompts require precise but compact body citations beyond the source index", () => {
    const prompt = buildPagePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      page: {
        id: "page-overview",
        title: "Overview",
        description: "Explain the core architecture.",
        filePaths: ["src/index.ts", "src/commands/convert.ts", "src/targets/index.ts"],
      },
    });

    expect(prompt).toContain("Use `Sources:` lines at natural section or claim-cluster boundaries");
    expect(prompt).toContain("do not force a citation into every short section, sentence, or list item");
    expect(prompt).toContain("The opening source-file list is only an index");
    expect(prompt).toContain("Never cite beyond the end of a file");
  });

  test("direct page prompt keeps the wiki contract while using only supplied evidence", () => {
    const args = {
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      sourcePath: "packages/sdk",
      depth: "regular" as const,
      style: "hidden-quirks" as const,
      languages: ["es" as const],
      page: {
        id: "page-runtime",
        title: "Runtime quirks",
        description: "Document the runtime constraints.",
        filePaths: ["src/runtime.ts", "src/config.ts"],
      },
    };
    const baseline = buildPagePrompt(args);
    const evidence = "# Direct page evidence\n\n## src/runtime.ts\n\n1 | export const runtime = \"local\";";
    const prompt = buildPagePrompt({ ...args, directEvidence: evidence });

    expect(prompt).toContain("**Title:** Runtime quirks");
    expect(prompt).toContain("**Description:** Document the runtime constraints.");
    expect(prompt).toContain("Write all human-facing wiki content in Spanish");
    expect(prompt).toContain("hidden quirks worth studying");
    expect(prompt).toContain("The very first element must be a collapsible source-file list");
    expect(prompt).toContain("Return the complete markdown page inside one `<ANSWER>...</ANSWER>` block");
    expect(prompt.endsWith(evidence)).toBe(true);
    expect(prompt).not.toContain("A local CLI agent is running in the prepared repository.");
    expect(prompt).not.toContain("Use native search and file tools before reading uncertain files.");
    expect(prompt).not.toContain("Start with these files, then inspect adjacent imports");
    expect(prompt).not.toContain("focused investigation/writing steps");
    expect(prompt).toContain("Write this page in one pass from the supplied evidence");
    expect(prompt).toContain("Source scope: only document evidence under `packages/sdk/`");
    expect(prompt).toContain("Do not describe unrelated repository folders");
    expect(buildPagePrompt({ ...args, directEvidence: undefined })).toBe(baseline);
    expect(buildPagePrompt({ ...args, directEvidence: "" })).toBe(baseline);
  });

  test("direct page prompt keeps the documentation contract while using only supplied evidence", () => {
    const args = {
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      style: "documentation" as const,
      languages: ["zh-Hans" as const],
      page: {
        id: "page-reference",
        title: "Configuration reference",
        description: "Document supported options.",
        filePaths: ["src/config.ts"],
      },
      allPages: [
        { id: "page-overview", title: "Overview", description: "Project surfaces." },
        { id: "page-reference", title: "Configuration reference", description: "Document supported options." },
      ],
    };
    const evidence = "# Direct page evidence\n\n## src/config.ts\n\n1 | export const retries = 3;";
    const prompt = buildPagePrompt({ ...args, directEvidence: evidence });

    expect(prompt).toContain("**Title:** Configuration reference");
    expect(prompt).toContain("**Description:** Document supported options.");
    expect(prompt).toContain("Write all human-facing wiki content in Mandarin 简体");
    expect(prompt).toContain("Write as functional, product-quality technical MDX repository documentation");
    expect(prompt).toContain("The very first element must be YAML frontmatter");
    expect(prompt).toContain("## Available Docs Page Links");
    expect(prompt).toContain("`/overview` or `page-overview`");
    expect(prompt).toContain("Return the complete MDX documentation page inside one `<ANSWER>...</ANSWER>` block");
    expect(prompt.endsWith(evidence)).toBe(true);
    expect(prompt).not.toContain("A local CLI agent is running in the prepared repository.");
    expect(prompt).not.toContain("Use native search and file tools before reading uncertain files.");
    expect(prompt).not.toContain("Start with these files, then inspect adjacent imports");
    expect(prompt).not.toContain("focused investigation/writing steps");
    expect(prompt).toContain("Write this page in one pass from the supplied evidence");
    const baseline = buildPagePrompt(args);
    expect(buildPagePrompt({ ...args, directEvidence: undefined })).toBe(baseline);
    expect(buildPagePrompt({ ...args, directEvidence: "" })).toBe(baseline);
  });

  test("page prompts prefer meaningful architecture and class diagrams over weak linear graphs", () => {
    const prompt = buildPagePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      style: "pattern-discovery",
      page: {
        id: "page-runtime-patterns",
        title: "Runtime Patterns",
        description: "Explain architecture and design patterns in the runtime.",
        filePaths: ["src/index.ts", "src/runtime.ts", "src/adapters/claude.ts"],
      },
    });

    expect(prompt).toContain("## Diagram Quality Harness");
    expect(prompt).toContain("Prefer system architecture diagrams");
    expect(prompt).toContain("named subgraphs for layers or ownership boundaries");
    expect(prompt).toContain("Prefer `classDiagram` for design patterns, MVC/MVVM/MVP");
    expect(prompt).toContain("interface-to-implementation contracts");
    expect(prompt).toContain("a compact fenced `text` ASCII diagram is a strong candidate");
    expect(prompt).toContain("module ownership boxes, data-shape sketches, file-to-responsibility maps");
    expect(prompt).toContain("Avoid low-value linear flowcharts like `A --> B --> C --> D`");
    expect(prompt).toContain("upgrade it into an architecture/class/state/sequence diagram or omit it");
  });

  test("new wiki formats shape structure and page prompts beyond the README", () => {
    const styleCases = [
      ["hidden-quirks", "hidden quirks worth studying", "Prioritize things not already obvious from the README"],
      ["worth-stealing", "what is worth stealing", "End with a final section titled exactly `## What To Reuse`"],
      ["socratic-exploration", "first-principles exploration", "Use Socratic questioning to reveal the system"],
      ["eli5", "Explain Like I'm 5", "Use plain language and short sections"],
      ["tech-reader", "HN/TechCrunch-style", "Write like a technical article for HN/TechCrunch readers"],
      ["repo-comparison", "comparison", "for multiple repos, explain what each does better"],
      ["documentation", "Documentation site", "Write as functional, product-quality technical MDX repository documentation"],
    ] as const;

    for (const [style, structureNeedle, pageNeedle] of styleCases) {
      const structurePrompt = buildStructurePrompt({
        owner: "EveryInc",
        repo: "compound-engineering-plugin",
        pageCount: 3,
        style,
      });
      const pagePrompt = buildPagePrompt({
        owner: "EveryInc",
        repo: "compound-engineering-plugin",
        style,
        page: {
          id: "page-overview",
          title: "Overview",
          description: "Explain the core architecture.",
          filePaths: ["README.md", "src/index.ts", "src/commands/convert.ts"],
        },
      });

      expect(structurePrompt).toContain(structureNeedle);
      expect(structurePrompt).toContain("Beyond README Requirement");
      expect(structurePrompt).toContain("not already obvious from the README");
      expect(pagePrompt).toContain(pageNeedle);
      expect(pagePrompt).toContain("actively look beyond it");
    }
  });

  test("documentation prompts name only supported docs kit artifacts", () => {
    const structurePrompt = buildStructurePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      pageCount: 4,
      style: "documentation",
    });
    const pagePrompt = buildPagePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      style: "documentation",
      page: {
        id: "page-reference",
        title: "Configuration reference",
        description: "Document supported options.",
        filePaths: ["README.md", "src/config.ts"],
      },
      allPages: [
        {
          id: "page-overview",
          title: "Overview",
          description: "Project surfaces.",
        },
        {
          id: "page-reference",
          title: "Configuration reference",
          description: "Document supported options.",
        },
      ],
    });

    expect(structurePrompt).toContain("a root manifest like Mintlify `docs.json` or Fumadocs `meta.json`");
    expect(structurePrompt).toContain("Predetermine the exact docs page count before writing XML");
    expect(structurePrompt).toContain("page archetypes");
    expect(structurePrompt).toContain("sections are docs navigation groups and pages are docs routes");
    expect(structurePrompt).toContain("agent- and human-friendly");
    expect(structurePrompt).toContain("Prefer functional technical coverage over explanation");
    expect(pagePrompt).toContain("Grok Docs MDX components");
    expect(pagePrompt).toContain("The very first element must be YAML frontmatter");
    expect(pagePrompt).toContain('title: "Configuration reference"');
    expect(pagePrompt).toContain("Agent-friendly output matters");
    expect(pagePrompt).toContain("Do not over-explain or teach");
    expect(pagePrompt).toContain("Start body content with one fact-first technical paragraph");
    expect(pagePrompt).toContain("Never open with reader-outcome framing");
    expect(pagePrompt).not.toContain("Start with an outcome paragraph");
    expect(pagePrompt).toContain("Reflect what is in the repository or folder");
    expect(pagePrompt).toContain("<CardGroup>");
    expect(pagePrompt).toContain("<RequestExample>");
    expect(pagePrompt).toContain("`:::endpoint METHOD /path short summary`");
    expect(pagePrompt).toContain("<AccordionGroup>");
    expect(pagePrompt).toContain("<ParamField");
    expect(pagePrompt).toContain("do not depend on Mintlify, Fumadocs");
    expect(pagePrompt).toContain("Do not add a duplicate top-level `#` heading");
    expect(pagePrompt).toContain("Do not include a collapsible source-file list");
    expect(pagePrompt).toContain("do not write visible `Sources:` lines");
    expect(pagePrompt).toContain("Available Docs Page Links");
    expect(pagePrompt).toContain("`/reference` or `page-reference`");
    expect(pagePrompt).toContain("Do not invent future docs routes");
    expect(pagePrompt).toContain("Cross-page card hrefs must point only to planned docs pages");
  });

  test("documentation page quality rejects reader-outcome openings", () => {
    const page = {
      id: "page-indexing",
      title: "Indexing and persistence",
      description: "Document indexing behavior.",
      importance: "high" as const,
      filePaths: ["src/data_pipeline.py"],
      relatedPages: [],
    };
    const bad = [
      "---",
      'title: "Indexing and persistence"',
      'description: "Document indexing behavior."',
      "---",
      "",
      "After reading this page you can explain and operate GithubChat's indexing layer: how a repository becomes a searchable vector index, where that index is written on disk, when it is rebuilt versus reused, and which configuration values control chunking and embeddings.",
      "",
      "## Index location",
      "",
      "DatabaseManager clones the target repository into the AdalFlow repository directory, transforms matching files into chunked documents, embeds those chunks, and persists the resulting LocalDB object as a `.pkl` file. The saved database lets later runs reuse the vector index instead of re-cloning and re-embedding the same repository. The implementation also keeps repository acquisition, document reading, splitting, embedding, and persistence in separate methods so failures are easier to isolate.",
    ].join("\n");
    const good = [
      "---",
      'title: "Indexing and persistence"',
      'description: "Document indexing behavior."',
      "---",
      "",
      "DatabaseManager owns GithubChat's indexing layer: it clones or reuses a repository checkout, reads supported source and documentation files, transforms them through a splitter and embedding pipeline, and persists the resulting LocalDB under the AdalFlow data directory.",
      "",
      "## Index location",
      "",
      "The saved `.pkl` database is the cache boundary between first-run indexing and later retrieval. A missing database triggers clone, read, split, embed, and save work; an existing database is loaded directly so the retriever can be prepared without rebuilding every vector. Configuration values define the splitter chunk size, overlap, embedding model, and retrieval count.",
    ].join("\n");
    const delayedBad = [
      "---",
      'title: "Indexing and persistence"',
      'description: "Document indexing behavior."',
      "---",
      "",
      "DatabaseManager owns GithubChat's indexing layer and persists a LocalDB object for retrieval.",
      "",
      "After reading this page you will be able to explain when the index rebuilds and how the persisted database is reused.",
      "",
      "## Index location",
      "",
      "The saved `.pkl` database is the cache boundary between first-run indexing and later retrieval. A missing database triggers clone, read, split, embed, and save work; an existing database is loaded directly so the retriever can be prepared without rebuilding every vector.",
    ].join("\n");

    expect(wikiPageQualityIssue(bad, page, ["en"], "documentation")).toContain("reader-outcome");
    expect(wikiPageQualityIssue(delayedBad, page, ["en"], "documentation")).toContain("reader-outcome");
    expect(wikiPageQualityIssue(good, page, ["en"], "documentation")).toBeNull();
  });

  test("documentation page quality rejects cards linked to unplanned routes", () => {
    const page = {
      id: "page-overview",
      title: "Overview",
      description: "Overview.",
      importance: "high" as const,
      filePaths: ["README.md"],
      relatedPages: [],
    };
    const pages = [
      page,
      {
        id: "page-configuration-reference",
        title: "Configuration reference",
        description: "Supported options.",
        importance: "high" as const,
        filePaths: ["README.md"],
        relatedPages: [],
      },
    ];
    const valid = [
      "---",
      'title: "Overview"',
      'description: "Overview."',
      "---",
      "",
      "Odysseus exposes its runtime surfaces through app routes, configuration keys, and provider-neutral model endpoints.",
      "The overview page keeps navigation focused on generated docs routes that already exist in the manifest. It names implementation surfaces, points to the supported reference page, and avoids presenting future API pages as clickable docs when the structure agent did not plan them.",
      "",
      "## Runtime surfaces",
      "",
      "The app route, configuration, and model surfaces are documented in the generated page set. Cross-page cards are navigation controls, so their href values must resolve to planned page ids instead of aspirational slugs.",
      "",
      "## Next",
      "",
      "<CardGroup>",
      '<Card title="Configuration reference" href="/configuration-reference">',
      "Supported options.",
      "</Card>",
      "</CardGroup>",
    ].join("\n");
    const invalid = valid.replace("/configuration-reference", "/api-routes");

    expect(wikiPageQualityIssue(valid, page, ["en"], "documentation", pages)).toBeNull();
    expect(wikiPageQualityIssue(invalid, page, ["en"], "documentation", pages)).toContain("unplanned page route");
  });

  test("custom wiki format prompt is inherited by structure and page writers", () => {
    const stylePrompt = "Write the wiki as an operator runbook with Risk, Probe, and Fix sections.";
    const structurePrompt = buildStructurePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      pageCount: 3,
      style: "custom",
      stylePrompt,
    });
    const pagePrompt = buildPagePrompt({
      owner: "EveryInc",
      repo: "compound-engineering-plugin",
      style: "custom",
      stylePrompt,
      page: {
        id: "page-overview",
        title: "Overview",
        description: "Explain the core architecture.",
        filePaths: ["README.md", "src/index.ts", "src/commands/convert.ts"],
      },
    });

    expect(structurePrompt).toContain("<custom_wiki_format>");
    expect(structurePrompt).toContain(stylePrompt);
    expect(pagePrompt).toContain("<custom_wiki_format>");
    expect(pagePrompt).toContain(stylePrompt);
    expect(pagePrompt).toContain("Follow the user's custom wiki format brief as the editorial lens for this page.");
  });

  test("knowledge profile prompts expose curated CE lenses without workflow utilities", () => {
    const askPrompt = knowledgeProfilePrompt({
      mode: "compound",
      packId: "every-compound-engineering",
      packName: "Compound Engineering",
      capabilities: [
        {
          id: "ce-plan",
          command: "/ce-plan",
          label: "Plan",
          surfaces: ["ask", "wiki"],
          outputKind: "implementation plan",
          promptContract: "Produce a bounded plan.",
          provenance: {
            kind: "bundled-snapshot",
            label: "Bundled Compound Engineering SKILL.md snapshot",
            sourceRepo: "EveryInc/compound-engineering-plugin",
            sourceCommit: "fd88fd8fd71ccba9d12e9f33a8c1dc99709c6d02",
            sourcePath: "plugins/compound-engineering/skills/ce-plan/SKILL.md",
          },
        },
      ],
      activeCapability: {
        id: "ce-plan",
        command: "/ce-plan",
        label: "Plan",
        surfaces: ["ask", "wiki"],
        promptContract: "Produce a bounded plan.",
        authoredDescription: "Create structured plans for multi-step tasks.",
        provenance: {
          kind: "bundled-snapshot",
          label: "Bundled Compound Engineering SKILL.md snapshot",
          sourceRepo: "EveryInc/compound-engineering-plugin",
          sourceCommit: "fd88fd8fd71ccba9d12e9f33a8c1dc99709c6d02",
          sourcePath: "plugins/compound-engineering/skills/ce-plan/SKILL.md",
        },
      },
    }, "ask");

    expect(askPrompt).toContain("Selected CE lens");
    expect(askPrompt).toContain("/ce-plan");
    expect(askPrompt).toContain("Bundled Compound Engineering SKILL.md snapshot");
    expect(askPrompt).toContain("plugins/compound-engineering/skills/ce-plan/SKILL.md");
    expect(askPrompt).toContain("Do not use workflow/action skills");
    expect(askPrompt).toContain("session-history search");
    expect(askPrompt).not.toContain("/ce-test-browser");
    expect(askPrompt).not.toContain("/ce-sessions");
  });

  test("wiki prompts include selected output language", () => {
    const structurePrompt = buildStructurePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      pageCount: 1,
      languages: ["es", "zh-Hans", "id"],
    });
    const pagePrompt = buildPagePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      languages: ["es", "zh-Hans", "id"],
      page: {
        id: "page-overview",
        title: "Overview",
        description: "What this repo is and how it works.",
        filePaths: ["README.md"],
      },
    });

    expect(structurePrompt).toContain("Spanish");
    expect(structurePrompt).not.toContain("Mandarin 简体");
    expect(structurePrompt).not.toContain("Bahasa Indonesia");
    expect(pagePrompt).toContain("Write all human-facing wiki content in Spanish");
  });

  test("Mandarin wiki prompts localize page scaffolding", () => {
    const structurePrompt = buildStructurePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      pageCount: 1,
      languages: ["zh-Hans"],
    });
    const pagePrompt = buildPagePrompt({
      owner: "AsyncFuncAI",
      repo: "AsyncReview",
      languages: ["zh-Hans"],
      page: {
        id: "page-overview",
        title: "系统概览",
        description: "这个仓库是什么以及它如何工作。",
        filePaths: ["README.md"],
      },
    });

    expect(structurePrompt).toContain("Write all human-facing wiki content in Mandarin 简体");
    expect(structurePrompt).toContain("translate every human-facing text value into the selected language");
    expect(pagePrompt).toContain("<summary>相关源文件</summary>");
    expect(pagePrompt).toContain("以下文件用于生成此维基页面：");
    expect(pagePrompt).toContain("# 系统概览");
    expect(pagePrompt).not.toContain("<summary>Relevant source files</summary>");
  });
});

describe("wiki code-kb wiring", () => {
  const structureArgs = {
    owner: "AsyncFuncAI",
    repo: "grok-wiki",
    pageCount: 6,
  };
  const pageArgs = {
    owner: "AsyncFuncAI",
    repo: "grok-wiki",
    page: {
      id: "page-overview",
      title: "Overview",
      description: "What this repo is and how it works.",
      filePaths: ["README.md", "src/index.ts"],
    },
  };
  const kbRef: RepoRef = {
    owner: "AsyncFuncAI",
    repo: "grok-wiki",
    url: "https://github.com/AsyncFuncAI/grok-wiki",
    branch: null,
  };
  const kbSession: CodeKbSession = {
    sessionId: "kb-test-session",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:asyncfuncai/grok-wiki@default",
    ref: kbRef,
  };

  test("structure and page prompts include the codeKb block verbatim at the end", () => {
    const block = "<code-kb>\nsession kb-test-session at https://sharenow.today\n</code-kb>";
    const structurePrompt = buildStructurePrompt({ ...structureArgs, codeKb: block });
    const pagePrompt = buildPagePrompt({ ...pageArgs, codeKb: block });

    expect(structurePrompt.endsWith(`\n\n${block}`)).toBe(true);
    expect(pagePrompt.endsWith(`\n\n${block}`)).toBe(true);
  });

  test("prompts without codeKb are byte-identical to the pre-change output", () => {
    const structureBaseline = buildStructurePrompt(structureArgs);
    const pageBaseline = buildPagePrompt(pageArgs);

    // Pre-change snapshot: the prompts still end on their original final lines
    // with nothing appended, and carry no code-kb material anywhere.
    expect(structureBaseline.endsWith("**Do not finalize until the full XML is inside \`<ANSWER>\` tags.**")).toBe(true);
    expect(pageBaseline.endsWith("Budget: up to 15 focused investigation/writing steps. Submit once the page is grounded and complete.")).toBe(true);
    expect(structureBaseline).not.toContain("<code-kb>");
    expect(pageBaseline).not.toContain("<code-kb>");

    expect(buildStructurePrompt({ ...structureArgs, codeKb: undefined })).toBe(structureBaseline);
    expect(buildStructurePrompt({ ...structureArgs, codeKb: "" })).toBe(structureBaseline);
    expect(buildPagePrompt({ ...pageArgs, codeKb: undefined })).toBe(pageBaseline);
    expect(buildPagePrompt({ ...pageArgs, codeKb: "" })).toBe(pageBaseline);
  });

  test("prefetch with a ready session and architecture renders both prompt blocks", async () => {
    const queried: Array<{ sessionId: string; tool: string }> = [];
    const result = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => kbSession,
      query: async (session, tool) => {
        queried.push({ sessionId: session.sessionId, tool });
        return { nodes: [{ id: "src/index.ts" }], edges: [] };
      },
    });

    expect(queried).toEqual([{ sessionId: "kb-test-session", tool: "get_architecture" }]);
    expect(result).not.toBeNull();
    expect(result!.structureCodeKb).toContain("kb-test-session");
    expect(result!.structureCodeKb).toContain("https://sharenow.today");
    expect(result!.structureCodeKb).toContain("## Architecture code map (from get_architecture)");
    expect(result!.structureCodeKb).toContain("## How to query the code graph");
    // Page block is instructions-only: no architecture code map.
    expect(result!.pageCodeKb).toContain("kb-test-session");
    expect(result!.pageCodeKb).toContain("## How to query the code graph");
    expect(result!.pageCodeKb).not.toContain("## Architecture code map");

    const structurePrompt = buildStructurePrompt({ ...structureArgs, codeKb: result!.structureCodeKb });
    const pagePrompt = buildPagePrompt({ ...pageArgs, codeKb: result!.pageCodeKb });
    expect(structurePrompt).toContain("## Architecture code map (from get_architecture)");
    expect(structurePrompt).toContain("## How to query the code graph");
    expect(pagePrompt).toContain("## How to query the code graph");
  });

  test("request-scoped disable returns before status, cache, ensure, or query work", async () => {
    const calls: string[] = [];
    const states: string[] = [];

    const result = await prefetchWikiCodeKbPrompts(
      kbRef,
      {
        enabled: () => false,
        peek: async () => {
          calls.push("peek");
          return null;
        },
        ensure: async () => {
          calls.push("ensure");
          return kbSession;
        },
        query: async () => {
          calls.push("query");
          return {};
        },
      },
      (state) => states.push(state),
    );

    expect(result).toBeNull();
    expect(calls).toEqual([]);
    expect(states).toEqual([]);
  });

  test("throwing or hanging kb clients leave prompts byte-identical (fallback invariant)", async () => {
    const throwing = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => {
        throw new Error("sharenow unreachable");
      },
    });
    const hangingEnsure = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: () => new Promise<CodeKbSession | null>(() => {}),
      budgetMs: 25,
    });
    const hangingQuery = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => kbSession,
      query: () => new Promise<unknown | null>(() => {}),
      budgetMs: 25,
    });

    expect(throwing).toBeNull();
    expect(hangingEnsure).toBeNull();
    expect(hangingQuery).toBeNull();

    const structureBaseline = buildStructurePrompt(structureArgs);
    const pageBaseline = buildPagePrompt(pageArgs);
    expect(buildStructurePrompt({ ...structureArgs, codeKb: throwing?.structureCodeKb })).toBe(structureBaseline);
    expect(buildStructurePrompt({ ...structureArgs, codeKb: hangingEnsure?.structureCodeKb })).toBe(structureBaseline);
    expect(buildPagePrompt({ ...pageArgs, codeKb: hangingQuery?.pageCodeKb })).toBe(pageBaseline);
  });

  test("prefetch resolves null when ensure yields no session or query yields no architecture", async () => {
    const noSession = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => null,
      query: async () => ({ nodes: [] }),
    });
    const noArchitecture = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => kbSession,
      query: async () => null,
    });
    const throwingQuery = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => kbSession,
      query: async () => {
        throw new Error("query exploded");
      },
    });

    expect(noSession).toBeNull();
    expect(noArchitecture).toBeNull();
    expect(throwingQuery).toBeNull();
  });

  test("prefetch emits instruction-only blocks when peek finds a provisioning session (R2)", async () => {
    const peekedRefs: RepoRef[] = [];
    const result = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => null,
      query: async () => {
        throw new Error("must not query without a session");
      },
      peek: async (ref) => {
        peekedRefs.push(ref);
        return { session: kbSession, state: "provisioning" };
      },
    });

    expect(peekedRefs).toEqual([kbRef]);
    expect(result).not.toBeNull();
    expect(result!.structureCodeKb).toContain("kb-test-session");
    expect(result!.structureCodeKb).toContain("## How to query the code graph");
    expect(result!.structureCodeKb).not.toContain("## Architecture code map");
    // Both blocks are the same instructions-only material: no architecture yet.
    expect(result!.pageCodeKb).toBe(result!.structureCodeKb);
  });

  test("ready path never consults peek and keeps the full blocks (unchanged)", async () => {
    let peekCalls = 0;
    const result = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => kbSession,
      query: async () => ({ nodes: [{ id: "src/index.ts" }], edges: [] }),
      peek: async () => {
        peekCalls++;
        return { session: kbSession, state: "ready" };
      },
    });

    expect(peekCalls).toBe(0);
    expect(result!.structureCodeKb).toContain("## Architecture code map (from get_architecture)");
    expect(result!.pageCodeKb).not.toContain("## Architecture code map");
  });

  test("code-graph status: cold ensure reports indexing then ready", async () => {
    const states: string[] = [];
    const result = await prefetchWikiCodeKbPrompts(
      kbRef,
      {
        // No cached entry yet, so the upfront peek reports indexing.
        peek: async () => null,
        ensure: async () => kbSession,
        query: async () => ({ nodes: [{ id: "src/index.ts" }], edges: [] }),
      },
      (state) => states.push(state),
    );

    expect(result).not.toBeNull();
    expect(states).toEqual(["indexing", "ready"]);
  });

  test("code-graph status: an already-ready session skips the indexing notice", async () => {
    const states: string[] = [];
    await prefetchWikiCodeKbPrompts(
      kbRef,
      {
        peek: async () => ({ session: kbSession, state: "ready" }),
        ensure: async () => kbSession,
        query: async () => ({ nodes: [{ id: "src/index.ts" }], edges: [] }),
      },
      (state) => states.push(state),
    );

    expect(states).toEqual(["ready"]);
  });

  test("code-graph status: the 64 MiB local cap surfaces too-large", async () => {
    const states: string[] = [];
    const result = await prefetchWikiCodeKbPrompts(
      kbRef,
      {
        peek: async () => null,
        // The real client fires onSkip("too-large") when the archive cap trips
        // and then resolves null; the ensure seam mirrors that contract here.
        ensure: async (_ref, opts) => {
          opts?.onSkip?.("too-large");
          return null;
        },
        query: async () => ({ nodes: [] }),
      },
      (state) => states.push(state),
    );

    expect(result).toBeNull();
    expect(states).toContain("too-large");
    expect(states).not.toContain("ready");
  });

  test("code-graph status: a status listener that throws never fails the prefetch", async () => {
    const result = await prefetchWikiCodeKbPrompts(
      kbRef,
      {
        peek: async () => null,
        ensure: async () => kbSession,
        query: async () => ({ nodes: [{ id: "src/index.ts" }], edges: [] }),
      },
      () => {
        throw new Error("status listener exploded");
      },
    );

    expect(result).not.toBeNull();
  });

  test("hanging ensure with a throwing or empty peek still resolves null (Covers R8)", async () => {
    const throwingPeek = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: () => new Promise<CodeKbSession | null>(() => {}),
      peek: async () => {
        throw new Error("peek exploded");
      },
      budgetMs: 25,
    });
    const emptyPeek = await prefetchWikiCodeKbPrompts(kbRef, {
      ensure: async () => null,
      peek: async () => null,
    });

    expect(throwingPeek).toBeNull();
    expect(emptyPeek).toBeNull();
  });

  test("disabled flag: prefetch with the default client resolves null with no network (Covers R8)", async () => {
    const previous = process.env.GROK_WIKI_CODE_KB;
    process.env.GROK_WIKI_CODE_KB = "0";
    try {
      expect(await prefetchWikiCodeKbPrompts(kbRef)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GROK_WIKI_CODE_KB;
      else process.env.GROK_WIKI_CODE_KB = previous;
    }
  });

  test("primary budget defaults to 20s and stays env-tunable (source pin)", () => {
    const generator = readFileSync(new URL("./generator.ts", import.meta.url), "utf8");
    expect(generator).toContain('envPositiveInt("GROK_WIKI_CODE_KB_WIKI_BUDGET_MS", 20_000)');
  });
});

describe("wiki code-kb evidence pre-fetch (U2)", () => {
  const kbRef: RepoRef = {
    owner: "AsyncFuncAI",
    repo: "grok-wiki",
    url: "https://github.com/AsyncFuncAI/grok-wiki",
    branch: null,
  };
  const kbSession: CodeKbSession = {
    sessionId: "kb-evidence-session",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:asyncfuncai/grok-wiki@default",
    ref: kbRef,
  };
  const makeKbPage = (id: string, filePaths: string[]): WikiPage => ({
    id,
    title: id,
    description: "",
    importance: "medium",
    filePaths,
    relatedPages: [],
    parentSection: "section-overview",
  });

  test("structure evidence issues only the two graph queries and renders their sections", async () => {
    const queries: Array<{ tool: string; args: Record<string, unknown> | undefined }> = [];
    const reads: string[] = [];
    const evidence = await fetchWikiStructureEvidence(kbSession, {
      query: async (_session, tool, args) => {
        queries.push({ tool, args });
        if (args?.label === "File") return { results: [{ file_path: "src/index.ts" }, { file_path: "src/server.ts" }] };
        return { results: [{ qualified_name: "server.handleRequest", degree: 42 }] };
      },
      readFile: async (_session, path) => {
        reads.push(path);
        return { path, content: "# Grok Wiki\nGenerates grounded wikis.", truncated: false };
      },
    });

    // The kb query route expects the client's camelCase arg names verbatim.
    // The structure-evidence path is trimmed to the file inventory + hotspots:
    // the README head and manifest probe fetches were dropped, so readFile is
    // never called from this path.
    expect(queries).toEqual([
      { tool: "search_graph", args: { label: "File", limit: 200 } },
      { tool: "search_graph", args: { minDegree: 10, limit: 30 } },
    ]);
    expect(reads).toEqual([]);
    expect(evidence).toContain("## File inventory (from search_graph)");
    expect(evidence).toContain("src/server.ts");
    expect(evidence).toContain("server.handleRequest (degree 42)");
    // No README head or manifest sections in the trimmed evidence.
    expect(evidence).not.toContain("## README head");
    expect(evidence).not.toContain("## Manifest head");
  });

  test("structure evidence with failing or hanging fetches resolves to empty string (Covers R8)", async () => {
    const allNull = await fetchWikiStructureEvidence(kbSession, {
      query: async () => null,
      readFile: async () => null,
    });
    const throwing = await fetchWikiStructureEvidence(kbSession, {
      query: async () => {
        throw new Error("query exploded");
      },
      readFile: async () => {
        throw new Error("read exploded");
      },
    });
    const hanging = await fetchWikiStructureEvidence(kbSession, {
      query: () => new Promise<unknown | null>(() => {}),
      readFile: () => new Promise<unknown | null>(() => {}),
      budgetMs: 25,
    });

    expect(allNull).toBe("");
    expect(throwing).toBe("");
    expect(hanging).toBe("");
  });

  test("page packs match their page's filePaths, cap at four files, and dedupe shared paths", async () => {
    const pages = [
      makeKbPage("page-overview", ["README.md", "src/shared.ts"]),
      makeKbPage("page-runtime", ["src/shared.ts", "src/runtime.ts", "src/extra1.ts", "src/extra2.ts", "src/extra3.ts"]),
      makeKbPage("page-empty", ["src/missing.ts"]),
      makeKbPage("page-nofiles", []),
    ];
    const fetched: Array<{ path: string; startLine?: number; endLine?: number }> = [];
    const packs = await fetchWikiPageEvidencePacks(kbSession, pages, {
      readFile: async (_session, path, range) => {
        fetched.push({ path, ...range });
        if (path === "src/missing.ts") return null;
        return { path, content: `head of ${path}`, truncated: false };
      },
    });

    // Shared paths fetch once, at the page head range; the fifth filePath of
    // page-runtime is beyond the four-file cap and never fetched.
    expect(fetched).toEqual([
      { path: "README.md", startLine: 1, endLine: 80 },
      { path: "src/shared.ts", startLine: 1, endLine: 80 },
      { path: "src/runtime.ts", startLine: 1, endLine: 80 },
      { path: "src/extra1.ts", startLine: 1, endLine: 80 },
      { path: "src/extra2.ts", startLine: 1, endLine: 80 },
      { path: "src/missing.ts", startLine: 1, endLine: 80 },
    ]);
    const overview = packs.get("page-overview")!;
    expect(overview).toContain("## README.md (head)");
    expect(overview).toContain("head of src/shared.ts");
    expect(overview).not.toContain("src/runtime.ts");
    const runtime = packs.get("page-runtime")!;
    expect(runtime).toContain("## src/shared.ts (head)");
    expect(runtime).toContain("head of src/runtime.ts");
    expect(runtime).toContain("head of src/extra2.ts");
    expect(runtime).not.toContain("src/extra3.ts");
    expect(runtime).not.toContain("README.md");
    expect(packs.has("page-empty")).toBe(false);
    expect(packs.has("page-nofiles")).toBe(false);
  });

  test("page pack fetches share one in-flight cap of eight across all pages (KTD-4)", async () => {
    const pages = Array.from({ length: 8 }, (_, p) =>
      makeKbPage(`page-${p}`, Array.from({ length: 4 }, (_, f) => `src/p${p}/f${f}.ts`)),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    let fetchCount = 0;
    const packs = await fetchWikiPageEvidencePacks(kbSession, pages, {
      readFile: async (_session, path) => {
        fetchCount++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return { path, content: `head of ${path}`, truncated: false };
      },
    });

    expect(fetchCount).toBe(32);
    expect(maxInFlight).toBe(8);
    expect(packs.size).toBe(8);
  });

  test("page packs with failing or hanging reads resolve to an empty map (Covers R8)", async () => {
    const pages = [makeKbPage("page-overview", ["README.md"])];
    const allNull = await fetchWikiPageEvidencePacks(kbSession, pages, {
      readFile: async () => null,
    });
    const throwing = await fetchWikiPageEvidencePacks(kbSession, pages, {
      readFile: async () => {
        throw new Error("read exploded");
      },
    });
    const hanging = await fetchWikiPageEvidencePacks(kbSession, pages, {
      readFile: () => new Promise<unknown | null>(() => {}),
      budgetMs: 25,
    });

    expect(allNull.size).toBe(0);
    expect(throwing.size).toBe(0);
    expect(hanging.size).toBe(0);
  });

  test("direct page evidence normalizes paths, caps each page at six files, and omits incomplete pages", async () => {
    const pages = [
      makeKbPage("page-complete", [" ./README.md ", "src\\shared.ts", "src/shared.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
      makeKbPage("page-incomplete", ["src/shared.ts", " src/missing.ts "]),
    ];
    const fetched: Array<{ path: string; startLine?: number; endLine?: number }> = [];
    const packs = await fetchWikiDirectPageEvidencePacks(kbSession, pages, {
      readFile: async (_session, path, range) => {
        fetched.push({ path, ...range });
        if (path === "src/missing.ts") return null;
        return { path, content: `complete ${path}`, truncated: false };
      },
    });

    expect(fetched).toEqual([
      { path: "README.md", startLine: 1, endLine: 320 },
      { path: "src/shared.ts", startLine: 1, endLine: 320 },
      { path: "src/a.ts", startLine: 1, endLine: 320 },
      { path: "src/b.ts", startLine: 1, endLine: 320 },
      { path: "src/c.ts", startLine: 1, endLine: 320 },
      { path: "src/d.ts", startLine: 1, endLine: 320 },
      { path: "src/missing.ts", startLine: 1, endLine: 320 },
    ]);
    const complete = packs.get("page-complete")!;
    expect(complete).toContain("# Direct page evidence");
    expect(complete).toContain("## README.md");
    expect(complete).toContain("## src/d.ts");
    expect(complete).toContain("1 | complete src/shared.ts");
    expect(complete).not.toContain("src/missing.ts");
    expect(packs.has("page-incomplete")).toBe(false);
  });

  test("direct page evidence fetches share one in-flight cap of eight across the whole run", async () => {
    const pages = Array.from({ length: 8 }, (_, pageIndex) =>
      makeKbPage(`page-${pageIndex}`, Array.from({ length: 6 }, (_, fileIndex) => `src/p${pageIndex}/f${fileIndex}.ts`)),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    let fetchCount = 0;
    const packs = await fetchWikiDirectPageEvidencePacks(kbSession, pages, {
      readFile: async (_session, path) => {
        fetchCount++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return { path, content: `complete ${path}`, truncated: false };
      },
    });

    expect(fetchCount).toBe(48);
    expect(maxInFlight).toBe(8);
    expect(packs.size).toBe(8);
  });

  test("direct page evidence resolves scoped-agent paths inside the requested folder", async () => {
    const fetched: string[] = [];
    const packs = await fetchWikiDirectPageEvidencePacks(kbSession, [
      makeKbPage("page-scoped", ["src/index.ts", "packages/sdk/src/config.ts"]),
    ], {
      readFile: async (_session, path) => {
        fetched.push(path);
        return { path, content: `complete ${path}`, truncated: false };
      },
    }, "packages/sdk");

    expect(fetched).toEqual([
      "packages/sdk/src/index.ts",
      "packages/sdk/src/config.ts",
    ]);
    expect(packs.get("page-scoped")).toContain("## packages/sdk/src/index.ts");
    expect(packs.get("page-scoped")).not.toContain("## src/index.ts");
  });

  test("direct page evidence settles immediately when the parent run is canceled", async () => {
    const controller = new AbortController();
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const pending = fetchWikiDirectPageEvidencePacks(kbSession, [
      makeKbPage("page-hanging", ["src/hanging.ts"]),
    ], {
      readFile: () => {
        markReadStarted();
        return new Promise<unknown | null>(() => {});
      },
      budgetMs: 5_000,
    }, null, controller.signal);

    await readStarted;
    const canceledAt = performance.now();
    controller.abort("stopped");
    const packs = await pending;

    expect(packs.size).toBe(0);
    expect(performance.now() - canceledAt).toBeLessThan(250);
  });

  test("direct page evidence treats read failures and budget expiry as best-effort", async () => {
    const partial = await fetchWikiDirectPageEvidencePacks(kbSession, [
      makeKbPage("page-complete", ["src/complete.ts"]),
      makeKbPage("page-failed", ["src/failed.ts"]),
    ], {
      readFile: async (_session, path) => {
        if (path === "src/failed.ts") throw new Error("read exploded");
        return { path, content: `complete ${path}`, truncated: false };
      },
    });
    const expired = await fetchWikiDirectPageEvidencePacks(kbSession, [
      makeKbPage("page-hanging", ["src/hanging.ts"]),
    ], {
      readFile: () => new Promise<unknown | null>(() => {}),
      budgetMs: 25,
    });

    expect(partial.has("page-complete")).toBe(true);
    expect(partial.has("page-failed")).toBe(false);
    expect(expired.size).toBe(0);
  });
});

describe("generateWiki code-kb wiring (through the GenerateOptions.codeKb seam)", () => {
  const kbRef: RepoRef = {
    owner: "AsyncFuncAI",
    repo: "grok-wiki",
    url: "https://github.com/AsyncFuncAI/grok-wiki",
    branch: null,
  };
  const kbSession: CodeKbSession = {
    sessionId: "kb-generate-session",
    baseUrl: "https://sharenow.today",
    cacheKey: "github:asyncfuncai/grok-wiki@default",
    ref: kbRef,
  };

  const structureAnswer = [
    "<ANSWER>",
    "<wiki_structure>",
    "  <title>Grok Wiki</title>",
    "  <description>Test wiki for the code-kb seam.</description>",
    "  <sections>",
    '    <section id="section-overview">',
    "      <title>Overview</title>",
    "      <pages>",
    "        <page_ref>page-overview</page_ref>",
    "      </pages>",
    "    </section>",
    "  </sections>",
    "  <pages>",
    '    <page id="page-overview">',
    "      <title>Overview</title>",
    "      <description>What this repository does.</description>",
    "      <importance>high</importance>",
    "      <relevant_files>",
    "        <file_path>src/index.ts</file_path>",
    "      </relevant_files>",
    "    </page>",
    "  </pages>",
    "</wiki_structure>",
    "</ANSWER>",
  ].join("\n");

  const pageAnswer = [
    "<details>",
    "<summary>Relevant source files</summary>",
    "The following files were used as context for generating this wiki page:",
    "- [src/index.ts](src/index.ts)",
    "</details>",
    "",
    "# Overview",
    "",
    "The repository exposes a wiki generation pipeline built around a structure agent and page agents. " +
      "The entry point wires the CLI arguments into the generator module, resolves the model channel, and " +
      "hands the repository reference to the structure phase. Each page is then written by a dedicated agent " +
      "that reads the indexed source files, grounds every claim in the code, and returns markdown with precise " +
      "line citations for the reviewer to verify. Sources: [src/index.ts:1-40]()",
  ].join("\n");

  // Fake the whole local CLI sidecar over HTTP: capture every run's prompt and
  // answer the structure/page agents from canned, quality-passing outputs so
  // generateWiki runs its real pipeline with zero spawned processes. Optional
  // overrides swap the structure answer or pick a page answer per prompt.
  function withFakeSidecar<T>(
    run: () => Promise<T>,
    answers?: { structure?: string; pageAnswerFor?: (prompt: string) => string },
  ): Promise<{ result: T; prompts: Array<{ contextLabel: string; prompt: string }> }> {
    const previousFetch = globalThis.fetch;
    const previousLocalCli = process.env.GROK_WIKI_LOCAL_CLI;
    const prompts: Array<{ contextLabel: string; prompt: string }> = [];
    const runs = new Map<string, { contextLabel: string; prompt: string }>();
    let runCounter = 0;

    process.env.GROK_WIKI_LOCAL_CLI = "1";
    __setLocalCliSidecarStarterForTests(async () => ({
      baseUrl: "http://127.0.0.1:1",
      token: "token",
      stampPath: join(tmpdir(), "grok-wiki-generate-test-sidecar.json"),
    }));
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { prompt?: string; contextLabel?: string };
        const runId = `run-${++runCounter}`;
        prompts.push({ contextLabel: body.contextLabel ?? "", prompt: body.prompt ?? "" });
        runs.set(runId, { contextLabel: body.contextLabel ?? "", prompt: body.prompt ?? "" });
        return new Response(JSON.stringify({ runId }), { status: 200 });
      }
      const eventsMatch = url.match(/\/v1\/runs\/([^/]+)\/events$/);
      if (eventsMatch) {
        const runId = decodeURIComponent(eventsMatch[1]);
        const started = runs.get(runId);
        const answer = started?.contextLabel === "wiki-structure"
          ? (answers?.structure ?? structureAnswer)
          : (answers?.pageAnswerFor?.(started?.prompt ?? "") ?? pageAnswer);
        const metadata = { runId, workspacePath: "", baseHead: "", answer, sources: [], rawText: answer };
        return new Response(`event: done\ndata: ${JSON.stringify(metadata)}\n\n`, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    return run()
      .then((result) => ({ result, prompts }))
      .finally(() => {
        globalThis.fetch = previousFetch;
        __resetLocalCliSidecarForTests();
        if (previousLocalCli === undefined) delete process.env.GROK_WIKI_LOCAL_CLI;
        else process.env.GROK_WIKI_LOCAL_CLI = previousLocalCli;
      });
  }

  test("throwing or never-resolving kb clients still complete generation with no <code-kb> block (Covers R4)", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-kb-fallback-"));
    try {
      const store = new WikiStore(storeRoot);
      const { result, prompts } = await withFakeSidecar(async () => {
        const throwing = await generateWiki(kbRef, {
          store,
          pageCount: 1,
          codeKb: {
            ensure: async () => {
              throw new Error("sharenow unreachable");
            },
          },
        });
        const hanging = await generateWiki(kbRef, {
          store,
          pageCount: 1,
          codeKb: {
            ensure: () => new Promise<CodeKbSession | null>(() => {}),
            budgetMs: 20,
          },
        });
        return { throwing, hanging };
      });

      for (const record of [result.throwing, result.hanging]) {
        expect(record.structure.pages.length).toBe(1);
        expect(record.pages["page-overview"]?.status).toBe("generated");
      }
      // Two runs x (1 structure + 1 page) agents, none of them saw kb material.
      expect(prompts.length).toBe(4);
      for (const entry of prompts) {
        expect(entry.prompt).not.toContain("<code-kb>");
        expect(entry.prompt).not.toContain("kb-generate-session");
      }
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  test("a ready kb session puts the code map in the structure prompt and instructions-only in page prompts", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-kb-ready-"));
    // This test pins the structure-AGENT prompt wiring; keep the B7 direct
    // path (own suite below) out of the way.
    const previousFastStructure = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
    process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = "0";
    const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
    process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
    try {
      const store = new WikiStore(storeRoot);
      const ensuredRefs: RepoRef[] = [];
      const { result, prompts } = await withFakeSidecar(() =>
        generateWiki(kbRef, {
          store,
          pageCount: 1,
          codeKb: {
            ensure: async (ref) => {
              ensuredRefs.push(ref);
              return kbSession;
            },
            query: async (_session, tool) =>
              tool === "get_architecture" ? { nodes: [{ id: "src/index.ts" }], edges: [] } : null,
          },
        }),
      );

      expect(ensuredRefs).toEqual([kbRef]);
      expect(result.pages["page-overview"]?.status).toBe("generated");

      const structurePrompts = prompts.filter((entry) => entry.contextLabel === "wiki-structure");
      const pagePrompts = prompts.filter((entry) => entry.contextLabel === "wiki-page");
      expect(structurePrompts.length).toBe(1);
      expect(pagePrompts.length).toBe(1);

      for (const entry of structurePrompts) {
        expect(entry.prompt).toContain("<code-kb>");
        expect(entry.prompt).toContain("kb-generate-session");
        expect(entry.prompt).toContain("## Architecture code map (from get_architecture)");
        expect(entry.prompt).toContain("## How to query the code graph");
      }
      for (const entry of pagePrompts) {
        expect(entry.prompt).toContain("<code-kb>");
        expect(entry.prompt).toContain("kb-generate-session");
        expect(entry.prompt).toContain("## How to query the code graph");
        expect(entry.prompt).not.toContain("## Architecture code map");
      }
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
      if (previousFastStructure === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
      else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = previousFastStructure;
      if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
    }
  });

  const twoPageStructureAnswer = [
    "<ANSWER>",
    "<wiki_structure>",
    "  <title>Grok Wiki</title>",
    "  <description>Test wiki for the code-kb evidence seam.</description>",
    "  <sections>",
    '    <section id="section-overview">',
    "      <title>Overview</title>",
    "      <pages>",
    "        <page_ref>page-overview</page_ref>",
    "        <page_ref>page-runtime</page_ref>",
    "      </pages>",
    "    </section>",
    "  </sections>",
    "  <pages>",
    '    <page id="page-overview">',
    "      <title>Overview</title>",
    "      <description>What this repository does.</description>",
    "      <importance>high</importance>",
    "      <relevant_files>",
    "        <file_path>src/index.ts</file_path>",
    "      </relevant_files>",
    "    </page>",
    '    <page id="page-runtime">',
    "      <title>Runtime</title>",
    "      <description>How the runtime works.</description>",
    "      <importance>medium</importance>",
    "      <relevant_files>",
    "        <file_path>src/runtime.ts</file_path>",
    "      </relevant_files>",
    "    </page>",
    "  </pages>",
    "</wiki_structure>",
    "</ANSWER>",
  ].join("\n");

  test("evidence pre-fetch seeds the structure prompt and threads each page's pack into only its prompt (Covers U2 R3+R4)", async () => {
    // Page packs are off by default (token-tax trim); this test exercises the
    // wiring, so opt in via the env flag and restore it afterward. The B7
    // direct path (own suite below) is disabled to pin the agent path.
    const previousPageEvidence = process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE;
    process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE = "1";
    const previousFastStructure = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
    process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = "0";
    const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
    process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
    const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-kb-evidence-"));
    try {
      const store = new WikiStore(storeRoot);
      const { result, prompts } = await withFakeSidecar(
        () =>
          generateWiki(kbRef, {
            store,
            pageCount: 2,
            codeKb: {
              ensure: async () => kbSession,
              query: async (_session, tool, args) => {
                if (tool === "get_architecture") return { nodes: [{ id: "src/index.ts" }], edges: [] };
                if (tool === "search_graph" && args?.label === "File") {
                  return { results: [{ file_path: "src/index.ts" }, { file_path: "src/runtime.ts" }] };
                }
                if (tool === "search_graph") return { results: [{ qualified_name: "server.handleRequest", degree: 42 }] };
                return null;
              },
              readFile: async (_session, path) => {
                if (path === "src/index.ts") return { path, content: "head of src/index.ts", truncated: false };
                if (path === "src/runtime.ts") return { path, content: "head of src/runtime.ts", truncated: false };
                return null;
              },
            },
          }),
        {
          structure: twoPageStructureAnswer,
          pageAnswerFor: (prompt) =>
            prompt.includes("- src/runtime.ts") ? pageAnswer.replace("# Overview", "# Runtime") : pageAnswer,
        },
      );

      expect(result.pages["page-overview"]?.status).toBe("generated");
      expect(result.pages["page-runtime"]?.status).toBe("generated");

      const structurePrompt = prompts.find((entry) => entry.contextLabel === "wiki-structure")!.prompt;
      expect(structurePrompt).toContain("# Code graph evidence (pre-fetched)");
      expect(structurePrompt).toContain("## File inventory (from search_graph)");
      expect(structurePrompt).toContain("## Hotspot symbols (highest graph degree)");
      expect(structurePrompt).toContain("server.handleRequest (degree 42)");
      // The structure evidence is trimmed to graph queries: no README/manifest.
      expect(structurePrompt).not.toContain("## README head");
      expect(structurePrompt).not.toContain("## Manifest head");

      const pagePrompts = prompts.filter((entry) => entry.contextLabel === "wiki-page").map((entry) => entry.prompt);
      expect(pagePrompts.length).toBe(2);
      const overviewPrompt = pagePrompts.find((prompt) => prompt.includes("- src/index.ts"))!;
      const runtimePrompt = pagePrompts.find((prompt) => prompt.includes("- src/runtime.ts"))!;
      expect(overviewPrompt).toContain("# Page evidence pack (pre-fetched file heads)");
      expect(overviewPrompt).toContain("## src/index.ts (head)");
      expect(overviewPrompt).toContain("head of src/index.ts");
      expect(overviewPrompt).not.toContain("head of src/runtime.ts");
      expect(runtimePrompt).toContain("# Page evidence pack (pre-fetched file heads)");
      expect(runtimePrompt).toContain("## src/runtime.ts (head)");
      expect(runtimePrompt).toContain("head of src/runtime.ts");
      expect(runtimePrompt).not.toContain("head of src/index.ts");
      // Neither page prompt carries the structure-only evidence.
      expect(overviewPrompt).not.toContain("# Code graph evidence (pre-fetched)");
      expect(runtimePrompt).not.toContain("# Code graph evidence (pre-fetched)");
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
      if (previousPageEvidence === undefined) delete process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE;
      else process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE = previousPageEvidence;
      if (previousFastStructure === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
      else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = previousFastStructure;
      if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
    }
  });

  test("all evidence fetches failing leaves prompts byte-identical to the pre-evidence blocks (Covers R8)", async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-kb-evidence-r8-"));
    try {
      const store = new WikiStore(storeRoot);
      const architecture = { nodes: [{ id: "src/index.ts" }], edges: [] };
      const evidenceQuery = (behavior: "null" | "throw" | "hang") =>
        async (_session: CodeKbSession, tool: string): Promise<unknown | null> => {
          if (tool === "get_architecture") return architecture;
          if (behavior === "throw") throw new Error("query exploded");
          if (behavior === "hang") return new Promise<unknown | null>(() => {});
          return null;
        };
      const readFileFor = (behavior: "null" | "throw" | "hang") =>
        async (): Promise<unknown | null> => {
          if (behavior === "throw") throw new Error("read exploded");
          if (behavior === "hang") return new Promise<unknown | null>(() => {});
          return null;
        };
      const { prompts } = await withFakeSidecar(async () => {
        for (const behavior of ["null", "throw", "hang"] as const) {
          await generateWiki(kbRef, {
            store,
            pageCount: 1,
            codeKb: {
              ensure: async () => kbSession,
              query: evidenceQuery(behavior),
              readFile: readFileFor(behavior),
              ...(behavior === "hang" ? { budgetMs: 50 } : {}),
            },
          });
        }
      });

      // Three runs x (1 structure + 1 page) agents.
      expect(prompts.length).toBe(6);
      const expectedStructureBlock = renderCodeKbBlock({ session: kbSession, architecture, includeToolInstructions: true });
      const expectedPageBlock = renderCodeKbBlock({ session: kbSession, includeToolInstructions: true });
      for (const entry of prompts) {
        // The prompt ends with the exact pre-evidence (U1) block: nothing appended.
        const expected = entry.contextLabel === "wiki-structure" ? expectedStructureBlock : expectedPageBlock;
        expect(entry.prompt.endsWith(expected)).toBe(true);
        expect(entry.prompt).not.toContain("# Code graph evidence (pre-fetched)");
        expect(entry.prompt).not.toContain("# Page evidence pack (pre-fetched file heads)");
      }
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  test("page packs are off by default: page prompts carry the instructions block but no evidence pack (Covers page-evidence flag)", async () => {
    // The flag must be unset for the default-off path even if the ambient env set
    // it; save and restore so the assertion is deterministic. The B7 direct path
    // (own suite below) is disabled because its evidence gather issues README and
    // manifest reads that would confound the zero-page-head-reads assertion.
    const previousPageEvidence = process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE;
    delete process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE;
    const previousFastStructure = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
    process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = "0";
    const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
    process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
    const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-kb-page-off-"));
    try {
      const store = new WikiStore(storeRoot);
      let pageHeadReads = 0;
      const { result, prompts } = await withFakeSidecar(() =>
        generateWiki(kbRef, {
          store,
          pageCount: 1,
          codeKb: {
            ensure: async () => kbSession,
            query: async (_session, tool, args) => {
              if (tool === "get_architecture") return { nodes: [{ id: "src/index.ts" }], edges: [] };
              if (tool === "search_graph" && args?.label === "File") return { results: [{ file_path: "src/index.ts" }] };
              if (tool === "search_graph") return { results: [{ qualified_name: "server.handleRequest", degree: 42 }] };
              return null;
            },
            // The fake would happily return a head for every path; the default-off
            // gate must mean this reader is never reached for the page-pack path.
            readFile: async (_session, path) => {
              pageHeadReads++;
              return { path, content: `head of ${path}`, truncated: false };
            },
          },
        }),
      );

      expect(result.pages["page-overview"]?.status).toBe("generated");
      const pagePrompt = prompts.find((entry) => entry.contextLabel === "wiki-page")!.prompt;
      // The page prompt still carries the code-kb instructions (query cheat-sheet)
      // but no evidence-pack section, even though readFile would return content.
      expect(pagePrompt).toContain("## How to query the code graph");
      expect(pagePrompt).not.toContain("# Page evidence pack (pre-fetched file heads)");
      expect(pagePrompt).not.toContain("head of src/index.ts");
      // Structure evidence (graph queries only) is unaffected by the page flag.
      const structurePrompt = prompts.find((entry) => entry.contextLabel === "wiki-structure")!.prompt;
      expect(structurePrompt).toContain("# Code graph evidence (pre-fetched)");
      // With page packs off, no page-head reads were issued (structure path does
      // not read files anymore either).
      expect(pageHeadReads).toBe(0);
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
      if (previousPageEvidence === undefined) delete process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE;
      else process.env.GROK_WIKI_CODE_KB_PAGE_EVIDENCE = previousPageEvidence;
      if (previousFastStructure === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
      else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = previousFastStructure;
      if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
    }
  });

  describe("fast-depth direct structure (B7)", () => {
    const directStructureAnswer = [
      "<ANSWER>",
      "<wiki_structure>",
      "  <title>Grok Wiki</title>",
      "  <description>Fast structure via the code-kb direct call.</description>",
      "  <sections>",
      '    <section id="section-overview">',
      "      <title>Overview</title>",
      "      <pages>",
      "        <page_ref>page-overview</page_ref>",
      "      </pages>",
      "    </section>",
      "  </sections>",
      "  <pages>",
      '    <page id="page-overview">',
      "      <title>Overview</title>",
      "      <description>What this repository does.</description>",
      "      <importance>high</importance>",
      "      <relevant_files>",
      "        <file_path>src/index.ts</file_path>",
      "      </relevant_files>",
      "    </page>",
      "  </pages>",
      "</wiki_structure>",
      "</ANSWER>",
    ].join("\n");

    const directStructureAnswerForPages = (pageCount: number): string => {
      const pages = Array.from({ length: pageCount }, (_, index) => ({
        id: index === 0 ? "page-overview" : `page-${index + 1}`,
        title: index === 0 ? "Overview" : `Page ${index + 1}`,
      }));
      return [
        "<ANSWER>",
        "<wiki_structure>",
        "  <title>Grok Wiki</title>",
        "  <description>Manifest-sized direct structure.</description>",
        "  <sections>",
        '    <section id="section-overview">',
        "      <title>Overview</title>",
        "      <pages>",
        ...pages.map((page) => `        <page_ref>${page.id}</page_ref>`),
        "      </pages>",
        "    </section>",
        "  </sections>",
        "  <pages>",
        ...pages.flatMap((page) => [
          `    <page id="${page.id}">`,
          `      <title>${page.title}</title>`,
          `      <description>Source-grounded documentation for ${page.title}.</description>`,
          "      <importance>high</importance>",
          "      <relevant_files>",
          "        <file_path>src/index.ts</file_path>",
          "      </relevant_files>",
          "    </page>",
        ]),
        "  </pages>",
        "</wiki_structure>",
        "</ANSWER>",
      ].join("\n");
    };

    const documentationPageAnswer = [
      "---",
      'title: "Generated reference"',
      'description: "Source-grounded repository documentation."',
      "---",
      "",
      "The generator coordinates repository analysis, structure planning, and page writing through provider-neutral local CLI configuration. The accepted manifest determines how much context each page writer receives while persisted request fields continue to identify the original generation request. Direct evidence is bounded to selected source files and normal repository agents remain the quality fallback when that evidence is incomplete or a direct response fails validation.",
      "",
      "## Generation flow",
      "",
      "A ready code-graph session supplies verified file paths and source contents. Each page is validated against the same documentation contract before it is checkpointed, emitted through page lifecycle events, and stored in the final record. Cancellation propagates from the parent run, while direct-call failures return to the existing repository page agent without creating a failed page or consuming an auto-recovery round.",
    ].join("\n");

    // Ready session + full evidence set; the inventory path carries a leading
    // "./" so the happy path also covers path normalization.
    const fastKbClient = (overrides: WikiCodeKbOptions = {}): WikiCodeKbOptions => ({
      ensure: async () => kbSession,
      query: async (_session, tool, args) => {
        if (tool === "get_architecture") return { nodes: [{ id: "src/index.ts" }], edges: [] };
        if (tool === "search_graph" && args?.label === "File") return { results: [{ file_path: "./src/index.ts" }] };
        if (tool === "search_graph") return { results: [{ qualified_name: "server.handleRequest", degree: 42 }] };
        return null;
      },
      readFile: async (_session, path) =>
        path === "README.md" ? { path, content: "# Grok Wiki\nGenerates grounded wikis.", truncated: false } : null,
      ...overrides,
    });

    test("fast depth plans the structure from ONE direct call and never spawns the structure agent", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-b7-happy-"));
      try {
        const store = new WikiStore(storeRoot);
        const directPrompts: string[] = [];
        const events: GenerationEvent[] = [];
        const { result, prompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            onEvent: (ev) => events.push(ev),
            codeKb: fastKbClient({
              directCall: async (prompt) => {
                directPrompts.push(prompt);
                return directStructureAnswer;
              },
            }),
          }),
        );

        // ONE direct call; only the page agent ever reached the sidecar.
        expect(directPrompts.length).toBe(1);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-structure")).toEqual([]);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(1);
        expect(result.structure.pages.length).toBe(1);
        expect(result.pages["page-overview"]?.status).toBe("generated");

        // The direct prompt carries the agent's exact structure contract plus
        // the evidence block, with the exploration instructions swapped out.
        const directPrompt = directPrompts[0]!;
        expect(directPrompt).toContain("Repository: **AsyncFuncAI/grok-wiki**");
        expect(directPrompt).toContain("## Required shape of the output");
        expect(directPrompt).toContain("exactly 1 total page");
        expect(directPrompt).toContain("# Repository evidence (code graph snapshot)");
        expect(directPrompt).toContain("## File inventory (every <file_path> must come from this list)");
        expect(directPrompt).toContain("src/index.ts");
        expect(directPrompt).toContain("## Architecture code map (from get_architecture)");
        expect(directPrompt).toContain("## README head");
        expect(directPrompt).not.toContain("## How to explore (BEFORE deciding)");

        // Same structure events as the agent path, plus the distinguishable
        // phase note and one synthetic iteration for the harness counters.
        expect(events.some((ev) => ev.type === "phase" && ev.message === "Planning structure via code graph.")).toBe(true);
        expect(events.some((ev) => ev.type === "structure-start")).toBe(true);
        expect(events.some((ev) => ev.type === "structure-done")).toBe(true);
        const agentEvents = events.filter((ev) => ev.type === "structure-agent");
        expect(agentEvents.length).toBe(1);
        const step = agentEvents[0]!;
        expect(step.type === "structure-agent" && step.event.type === "step" && step.event.step === 1 && step.event.resultType === "code-kb-direct").toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("writes a page from one direct call", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-happy-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      try {
        const store = new WikiStore(storeRoot);
        const directPagePrompts: string[] = [];
        const directPageResults: Array<{ pageId: string; state: string; attempted: boolean; durationMs: number; reason?: string }> = [];
        const events: GenerationEvent[] = [];
        const localCli = { agentId: "claude" };
        let directPageCalls = 0;
        let forwardedLocalCli: unknown;
        const { result, prompts: sidecarPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            localCli,
            onEvent: (event) => events.push(event),
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({
                path,
                content: path === "src/index.ts"
                  ? "export function generateWiki() { return 'grounded'; }"
                  : "# Grok Wiki\nGenerates grounded wikis.",
                truncated: false,
              }),
              directPageCall: async (prompt, receivedLocalCli) => {
                directPageCalls++;
                directPagePrompts.push(prompt);
                forwardedLocalCli = receivedLocalCli;
                return `<ANSWER>\n${pageAnswer}\n</ANSWER>`;
              },
              onDirectPageResult: (entry) => {
                directPageResults.push(entry);
              },
            }),
          }),
        );

        expect(directPageCalls).toBe(1);
        expect(sidecarPrompts.filter((entry) => entry.contextLabel === "wiki-page")).toEqual([]);
        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(result.pages["page-overview"]?.content).toBe(pageAnswer);
        expect(directPagePrompts[0]).toContain("# Direct page evidence");
        expect(forwardedLocalCli).toEqual(localCli);

        const pageAgentSteps = events.filter((event) =>
          event.type === "page-agent" &&
          event.pageId === "page-overview" &&
          event.event.type === "step" &&
          event.event.resultType === "code-kb-direct-page"
        );
        expect(pageAgentSteps.length).toBe(1);
        expect(events.some((event) => event.type === "page-error")).toBe(false);
        expect(directPageResults.length).toBe(1);
        expect(directPageResults[0]?.pageId).toBe("page-overview");
        expect(directPageResults[0]?.state).toBe("success");
        expect(directPageResults[0]?.attempted).toBe(true);
        expect(directPageResults[0]?.durationMs).toBeGreaterThanOrEqual(0);
        expect(directPageResults[0]?.reason).toBeUndefined();
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("writes and saves a direct page through the default chat runner", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-default-runner-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      try {
        const store = new WikiStore(storeRoot);
        const { result, prompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
            }),
          }),
        );

        expect(prompts.filter((entry) => entry.contextLabel === "chat").length).toBe(1);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-page")).toEqual([]);
        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(result.pages["page-overview"]?.content).toBe(pageAnswer);
        const saved = store.loadById(result.id!);
        expect(saved?.pages["page-overview"]?.status).toBe("generated");
        expect(saved?.pages["page-overview"]?.content).toBe(pageAnswer);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("does not direct-call pages when the per-run opt-in is omitted or false", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-default-off-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      try {
        const store = new WikiStore(storeRoot);
        let directPageCalls = 0;
        const outcomes: Array<{ state: string; attempted: boolean; reason?: string }> = [];
        const run = (preferDirectPages?: boolean) => withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            ...(preferDirectPages === undefined ? {} : { preferDirectPages }),
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => {
                directPageCalls++;
                return `<ANSWER>\n${pageAnswer}\n</ANSWER>`;
              },
              onDirectPageResult: (outcome) => {
                outcomes.push(outcome);
              },
            }),
          }),
        );

        const omitted = await run();
        const explicitlyFalse = await run(false);

        expect(directPageCalls).toBe(0);
        for (const completed of [omitted, explicitlyFalse]) {
          expect(completed.prompts.filter((entry) => entry.contextLabel === "chat")).toEqual([]);
          expect(completed.prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(1);
          expect(completed.result.pages["page-overview"]?.status).toBe("generated");
        }
        expect(outcomes.length).toBe(2);
        expect(outcomes.every((outcome) => outcome.state === "fallback" && outcome.reason?.includes("not requested"))).toBe(true);
        expect(outcomes.every((outcome) => outcome.attempted === false)).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("reports disabled, workspace, and missing-evidence pages as one-agent fallbacks", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-gates-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      try {
        const store = new WikiStore(storeRoot);
        const outcomes: Array<{ scenario: string; state: string; attempted: boolean; reason?: string }> = [];
        let directPageCalls = 0;
        const directPageCall = async (): Promise<string> => {
          directPageCalls++;
          return `<ANSWER>\n${pageAnswer}\n</ANSWER>`;
        };

        process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
        const { prompts: disabledPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              directPageCall,
              onDirectPageResult: (result) => {
                outcomes.push({ scenario: "disabled", ...result });
              },
            }),
          }),
        );

        delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        const workspaceRefs = [
          { ...kbRef, id: "primary", label: "primary" },
          { ...kbRef, id: "extra", repo: "grok-wiki-extra", url: "https://github.com/AsyncFuncAI/grok-wiki-extra", label: "extra" },
        ];
        const { prompts: workspacePrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            refs: workspaceRefs,
            codeKb: fastKbClient({
              directPageCall,
              onDirectPageResult: (result) => {
                outcomes.push({ scenario: "workspace", ...result });
              },
            }),
          }),
        );

        const { prompts: missingPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) =>
                path === "README.md"
                  ? { path, content: "# Grok Wiki", truncated: false }
                  : null,
              directPageCall,
              onDirectPageResult: (result) => {
                outcomes.push({ scenario: "missing", ...result });
              },
            }),
          }),
        );

        expect(directPageCalls).toBe(0);
        for (const prompts of [disabledPrompts, workspacePrompts, missingPrompts]) {
          expect(prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(1);
        }
        expect(outcomes.map(({ scenario, state }) => ({ scenario, state }))).toEqual([
          { scenario: "disabled", state: "fallback" },
          { scenario: "workspace", state: "fallback" },
          { scenario: "missing", state: "fallback" },
        ]);
        expect(outcomes.every((outcome) => Boolean(outcome.reason) && outcome.reason!.length < 120)).toBe(true);
        expect(outcomes.every((outcome) => outcome.attempted === false)).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("falls back once without page errors when a direct call throws or fails quality", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-invalid-"));
      try {
        const store = new WikiStore(storeRoot);
        const outcomes: Array<{ scenario: string; state: string; attempted: boolean; reason?: string }> = [];
        const events: Array<{ scenario: string; event: GenerationEvent }> = [];
        let thrownCalls = 0;
        let invalidCalls = 0;
        const runScenario = (scenario: "thrown" | "invalid") => withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            onEvent: (event) => events.push({ scenario, event }),
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => {
                if (scenario === "thrown") {
                  thrownCalls++;
                  throw new Error("direct page exploded");
                }
                invalidCalls++;
                return "too short";
              },
              onDirectPageResult: (result) => {
                outcomes.push({ scenario, ...result });
              },
            }),
          }),
        );

        const thrown = await runScenario("thrown");
        const invalid = await runScenario("invalid");

        expect(thrownCalls).toBe(1);
        expect(invalidCalls).toBe(1);
        for (const run of [thrown, invalid]) {
          expect(run.prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(1);
          expect(run.result.pages["page-overview"]?.status).toBe("generated");
        }
        expect(events.some(({ event }) => event.type === "page-error")).toBe(false);
        expect(outcomes.map(({ scenario, state }) => ({ scenario, state }))).toEqual([
          { scenario: "thrown", state: "fallback" },
          { scenario: "invalid", state: "fallback" },
        ]);
        expect(outcomes[0]?.reason).toContain("direct page exploded");
        expect(outcomes[1]?.reason).toContain("too short");
        expect(outcomes.every((outcome) => outcome.attempted === true)).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("does not repeat a direct miss when the repository page succeeds during outer recovery", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-outer-recovery-"));
      try {
        const store = new WikiStore(storeRoot);
        const outcomes: Array<{ state: string; reason?: string }> = [];
        const events: GenerationEvent[] = [];
        let directPageCalls = 0;
        let repositoryPageCalls = 0;
        const { result, prompts } = await withFakeSidecar(
          () => generateWiki(kbRef, {
            store,
            style: "documentation",
            pageCount: 1,
            preferDirectPages: true,
            onEvent: (event) => events.push(event),
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => {
                directPageCalls++;
                return "too short";
              },
              onDirectPageResult: (outcome) => {
                outcomes.push(outcome);
              },
            }),
          }),
          {
            pageAnswerFor: () => {
              repositoryPageCalls++;
              return repositoryPageCalls <= 2 ? "too short" : documentationPageAnswer;
            },
          },
        );

        expect(directPageCalls).toBe(1);
        expect(outcomes.length).toBe(1);
        expect(outcomes[0]?.state).toBe("fallback");
        expect(repositoryPageCalls).toBe(3);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(3);
        expect(events.filter((event) => event.type === "page-error").length).toBe(1);
        expect(events.some((event) => event.type === "phase" && event.message.includes("Auto-recovering 1 failed page"))).toBe(true);
        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(result.pages["page-overview"]?.content).toBe(documentationPageAnswer);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("times out a direct page below agent latency and falls back exactly once", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-timeout-"));
      const previousTimeout = process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS;
      process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS = "20";
      try {
        const store = new WikiStore(storeRoot);
        let directSignal: AbortSignal | undefined;
        const outcomes: Array<{ state: string; durationMs: number; reason?: string }> = [];
        const { result, prompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: (_prompt, _localCli, signal) => {
                directSignal = signal;
                return new Promise<string>((resolve, reject) => {
                  const timer = setTimeout(() => resolve(`<ANSWER>\n${pageAnswer}\n</ANSWER>`), 80);
                  signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new DOMException("direct call aborted", "AbortError"));
                  }, { once: true });
                });
              },
              onDirectPageResult: (outcome) => {
                outcomes.push(outcome);
              },
            }),
          }),
        );

        expect(prompts.filter((entry) => entry.contextLabel === "wiki-page").length).toBe(1);
        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(directSignal?.aborted).toBe(true);
        expect(outcomes.length).toBe(1);
        expect(outcomes[0]?.state).toBe("timeout");
        expect(outcomes[0]?.durationMs).toBeGreaterThanOrEqual(15);
        expect(outcomes[0]?.reason).toContain("timed out");
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousTimeout === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS = previousTimeout;
      }
    });

    test("uses distinct direct-page timeout defaults below normal page-agent latency", () => {
      expect(fastPageTimeoutDefaultMs("basic")).toBe(90_000);
      expect(fastPageTimeoutDefaultMs("documentation")).toBe(120_000);
      expect(fastPageTimeoutDefaultMs("hidden-quirks")).toBe(90_000);
      expect(fastPageTimeoutDefaultMs("basic")).toBeLessThan(1_800_000);
      expect(fastPageTimeoutDefaultMs("documentation")).toBeLessThan(1_800_000);
    });

    test("parent cancellation aborts the direct page and never starts fallback", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-cancel-"));
      try {
        const store = new WikiStore(storeRoot);
        const controller = new AbortController();
        const outcomes: Array<{ state: string }> = [];
        const run = withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            signal: controller.signal,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: (_prompt, _localCli, signal) => new Promise<string>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
                controller.abort("stopped");
              }),
              onDirectPageResult: (outcome) => {
                outcomes.push(outcome);
              },
            }),
          }),
        );

        await expect(run).rejects.toThrow("Stopped by user.");
        const observed = await run.catch(() => null);
        expect(observed).toBeNull();
        expect(outcomes).toEqual([]);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("parent cancellation settles even when the direct page runner ignores abort", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-noncooperative-cancel-"));
      const previousTimeout = process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS;
      process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS = "250";
      try {
        const store = new WikiStore(storeRoot);
        const controller = new AbortController();
        let markDirectStarted = () => {};
        const directStarted = new Promise<void>((resolve) => {
          markDirectStarted = resolve;
        });
        const outcomes: Array<{ state: string }> = [];
        const run = withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            signal: controller.signal,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: () => {
                markDirectStarted();
                return new Promise<string>(() => {});
              },
              onDirectPageResult: (outcome) => {
                outcomes.push(outcome);
              },
            }),
          }),
        );

        await directStarted;
        const canceledAt = Date.now();
        controller.abort("stopped");
        await expect(run).rejects.toThrow("Stopped by user.");
        expect(Date.now() - canceledAt).toBeLessThan(100);
        expect(outcomes).toEqual([]);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousTimeout === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGE_TIMEOUT_MS = previousTimeout;
      }
    });

    test("ignores direct-page metric callback failures", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-metric-"));
      try {
        const store = new WikiStore(storeRoot);
        let directPageCalls = 0;
        const run = (failure: "sync" | "rejected") => withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => {
                directPageCalls++;
                return `<ANSWER>\n${pageAnswer}\n</ANSWER>`;
              },
              onDirectPageResult: () => {
                if (failure === "sync") throw new Error("metrics unavailable");
                return Promise.reject(new Error("metrics rejected"));
              },
            }),
          }),
        );

        const sync = await run("sync");
        const rejected = await run("rejected");

        expect(directPageCalls).toBe(2);
        for (const completed of [sync, rejected]) {
          expect(completed.prompts.filter((entry) => entry.contextLabel === "wiki-page")).toEqual([]);
          expect(completed.result.pages["page-overview"]?.status).toBe("generated");
        }
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("does not wait for a delayed direct-page metric callback", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-metric-delay-"));
      try {
        const store = new WikiStore(storeRoot);
        let callbackSettled = false;
        let callbackPromise: Promise<void> = Promise.resolve();
        const { result } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => `<ANSWER>\n${pageAnswer}\n</ANSWER>`,
              onDirectPageResult: () => {
                callbackPromise = new Promise((resolve) => setTimeout(() => {
                  callbackSettled = true;
                  resolve();
                }, 60));
                return callbackPromise;
              },
            }),
          }),
        );
        const settledWhenGenerationCompleted = callbackSettled;
        await callbackPromise;

        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(settledWhenGenerationCompleted).toBe(false);
        expect(callbackSettled).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("a never-settling direct-page metric callback cannot block parent cancellation", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-metric-cancel-"));
      try {
        const store = new WikiStore(storeRoot);
        const controller = new AbortController();
        let releaseCallback!: () => void;
        const callbackPromise = new Promise<void>((resolve) => {
          releaseCallback = resolve;
        });
        const generation = withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            preferDirectPages: true,
            signal: controller.signal,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswer,
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async () => `<ANSWER>\n${pageAnswer}\n</ANSWER>`,
              onDirectPageResult: () => {
                queueMicrotask(() => controller.abort("stopped"));
                return callbackPromise;
              },
            }),
          }),
        );
        const observed = generation.then(
          () => "resolved",
          (error: unknown) => error instanceof Error ? error.name : String(error),
        );
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const winner = await Promise.race([
          observed,
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve("blocked"), 40);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (winner === "blocked") {
          releaseCallback();
          await observed;
        }

        expect(winner).toBe("AbortError");
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("accepts compact documentation auto manifests while preserving basic auto and fixed bounds", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-structure-doc-bounds-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
      try {
        const store = new WikiStore(storeRoot);
        const run = (style: "basic" | "documentation", pageCount: number, pageCountMode: "auto" | "fixed") =>
          withFakeSidecar(
            () => generateWiki(kbRef, {
              store,
              style,
              pageCount,
              pageCountMode,
              codeKb: fastKbClient({ directCall: async () => directStructureAnswerForPages(3) }),
            }),
            { pageAnswerFor: () => style === "documentation" ? documentationPageAnswer : pageAnswer },
          );

        const docsAuto = await run("documentation", 30, "auto");
        const basicAuto = await run("basic", 30, "auto");
        const fixedMatch = await run("basic", 3, "fixed");
        const fixedMismatch = await run("basic", 4, "fixed");

        expect(docsAuto.result.structure.pages.length).toBe(3);
        expect(docsAuto.prompts.filter((entry) => entry.contextLabel === "wiki-structure")).toEqual([]);
        expect(basicAuto.prompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);
        expect(fixedMatch.result.structure.pages.length).toBe(3);
        expect(fixedMatch.prompts.filter((entry) => entry.contextLabel === "wiki-structure")).toEqual([]);
        expect(fixedMismatch.prompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("uses accepted auto manifest size for repository page-agent depth without changing request identity", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-page-agent-manifest-depth-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      process.env.GROK_WIKI_CODE_KB_FAST_PAGES = "0";
      try {
        const store = new WikiStore(storeRoot);
        const run = (actualPages: number, pageCount: number, pageCountMode: "auto" | "fixed") =>
          withFakeSidecar(
            () => generateWiki(kbRef, {
              store,
              style: "documentation",
              pageCount,
              pageCountMode,
              codeKb: fastKbClient({ directCall: async () => directStructureAnswerForPages(actualPages) }),
            }),
            { pageAnswerFor: () => documentationPageAnswer },
          );

        const compactAuto = await run(3, 30, "auto");
        const regularAuto = await run(13, 30, "auto");
        const fixed = await run(13, 13, "fixed");
        const compactPrompts = compactAuto.prompts.filter((entry) => entry.contextLabel === "wiki-page");
        const regularPrompts = regularAuto.prompts.filter((entry) => entry.contextLabel === "wiki-page");
        const fixedPrompts = fixed.prompts.filter((entry) => entry.contextLabel === "wiki-page");

        expect(compactPrompts.length).toBe(3);
        expect(compactPrompts.every((entry) => entry.prompt.includes("Fast wiki: be concise and selective."))).toBe(true);
        expect(regularPrompts.length).toBe(13);
        expect(regularPrompts.every((entry) => entry.prompt.includes("Regular wiki: verify the central claims"))).toBe(true);
        expect(fixedPrompts.length).toBe(13);
        expect(fixedPrompts.every((entry) => entry.prompt.includes("Regular wiki: verify the central claims"))).toBe(true);
        expect(compactAuto.result.wikiDepth).toBe("deep");
        expect(regularAuto.result.wikiDepth).toBe("deep");
        expect(compactAuto.result.wikiPageCount).toBe(30);
        expect(regularAuto.result.wikiPageCount).toBe(30);
        expect(compactAuto.result.variantKey).toBe(regularAuto.result.variantKey);
        expect(fixed.result.wikiDepth).toBe("regular");
        expect(fixed.result.wikiPageCount).toBe(13);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("uses accepted auto manifest size for direct page prompt depth without changing request identity", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-page-manifest-depth-"));
      const previousFastPages = process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
      try {
        const store = new WikiStore(storeRoot);
        const run = (actualPages: number) => {
          const directPagePrompts: string[] = [];
          return withFakeSidecar(() => generateWiki(kbRef, {
            store,
            style: "documentation",
            pageCount: 30,
            pageCountMode: "auto",
            preferDirectPages: true,
            codeKb: fastKbClient({
              directCall: async () => directStructureAnswerForPages(actualPages),
              readFile: async (_session, path) => ({ path, content: `complete ${path}`, truncated: false }),
              directPageCall: async (prompt) => {
                directPagePrompts.push(prompt);
                return `<ANSWER>\n${documentationPageAnswer}\n</ANSWER>`;
              },
            }),
          })).then((runResult) => ({ ...runResult, directPagePrompts }));
        };

        const compactAuto = await run(3);
        const regularAuto = await run(13);

        expect(compactAuto.directPagePrompts.length).toBe(3);
        expect(compactAuto.directPagePrompts.every((prompt) => prompt.includes("Fast wiki: be concise and selective."))).toBe(true);
        expect(regularAuto.directPagePrompts.length).toBe(13);
        expect(regularAuto.directPagePrompts.every((prompt) => prompt.includes("Regular wiki: cover the central claims"))).toBe(true);
        expect(compactAuto.prompts.filter((entry) => entry.contextLabel === "wiki-page")).toEqual([]);
        expect(regularAuto.prompts.filter((entry) => entry.contextLabel === "wiki-page")).toEqual([]);
        expect(compactAuto.result.wikiDepth).toBe("deep");
        expect(regularAuto.result.wikiDepth).toBe("deep");
        expect(compactAuto.result.wikiPageCount).toBe(30);
        expect(regularAuto.result.wikiPageCount).toBe(30);
        expect(compactAuto.result.variantKey).toBe(regularAuto.result.variantKey);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFastPages === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_PAGES;
        else process.env.GROK_WIKI_CODE_KB_FAST_PAGES = previousFastPages;
      }
    });

    test("an unparseable direct reply falls back to the structure agent", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-b7-badxml-"));
      try {
        const store = new WikiStore(storeRoot);
        let directCalls = 0;
        const events: GenerationEvent[] = [];
        const { result, prompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            onEvent: (ev) => events.push(ev),
            codeKb: fastKbClient({
              directCall: async () => {
                directCalls++;
                return "Here are my thoughts about the repository, with no XML at all.";
              },
            }),
          }),
        );

        expect(directCalls).toBe(1);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);
        expect(result.pages["page-overview"]?.status).toBe("generated");
        expect(events.some((ev) => ev.type === "code-graph" && ev.state === "skipped" && ev.message === "Code graph shortcut skipped. Using the thorough planner.")).toBe(true);
        expect(events.some((ev) => ev.type === "phase" && ev.message === "Code graph shortcut skipped. Using the thorough planner.")).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("a page path missing from the inventory or an out-of-bounds page count falls back", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-b7-validate-"));
      try {
        const store = new WikiStore(storeRoot);
        let directCalls = 0;
        const badPathAnswer = directStructureAnswer.replace(
          "<file_path>src/index.ts</file_path>",
          "<file_path>src/missing.ts</file_path>",
        );
        const { result, prompts } = await withFakeSidecar(async () => {
          const badPath = await generateWiki(kbRef, {
            store,
            pageCount: 1,
            codeKb: fastKbClient({
              directCall: async () => {
                directCalls++;
                return badPathAnswer;
              },
            }),
          });
          // Fixed mode demands exactly 2 pages; the one-page direct reply is
          // out of bounds, so the agent path must run.
          const badCount = await generateWiki(kbRef, {
            store,
            pageCount: 2,
            pageCountMode: "fixed",
            codeKb: fastKbClient({
              directCall: async () => {
                directCalls++;
                return directStructureAnswer;
              },
            }),
          });
          return { badPath, badCount };
        });

        expect(directCalls).toBe(2);
        expect(prompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(2);
        for (const record of [result.badPath, result.badCount]) {
          expect(record.pages["page-overview"]?.status).toBe("generated");
        }
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    test("scoped direct structure excludes repository evidence outside the requested folder", async () => {
      const directPrompts: string[] = [];
      const readPaths: string[] = [];
      const scopedRef = { ...kbRef, sourcePath: "packages/sdk" };
      const outsideAnswer = directStructureAnswer.replace(
        "<file_path>src/index.ts</file_path>",
        "<file_path>apps/web/outside.ts</file_path>",
      );

      const structure = await structureFromCodeKb(scopedRef, kbSession, {
        depth: "fast",
        pageCount: 1,
        pageCountMode: "fixed",
        style: "basic",
        languages: ["en"],
        knowledgeProfile: normalizeKnowledgeProfile({ mode: "basic" }),
        codeKb: {
          query: async (_session, tool) => {
            if (tool === "search_graph") {
              return {
                results: [
                  { file_path: "packages/sdk/src/index.ts" },
                  { file_path: "apps/web/outside.ts" },
                ],
              };
            }
            if (tool === "get_architecture") return { marker: "OUTSIDE_ARCHITECTURE" };
            return null;
          },
          readFile: async (_session, path) => {
            readPaths.push(path);
            return { path, content: `content for ${path}`, truncated: false };
          },
          directCall: async (prompt) => {
            directPrompts.push(prompt);
            return outsideAnswer;
          },
        },
      });

      expect(structure).toBeNull();
      expect(directPrompts).toHaveLength(1);
      expect(directPrompts[0]).toContain("packages/sdk/src/index.ts");
      expect(directPrompts[0]).not.toContain("apps/web/outside.ts");
      expect(directPrompts[0]).not.toContain("OUTSIDE_ARCHITECTURE");
      expect(readPaths).toContain("packages/sdk/README.md");
      expect(readPaths).toContain("packages/sdk/package.json");
      expect(readPaths).not.toContain("README.md");
      expect(readPaths).not.toContain("package.json");
    });

    test("flag off and no ready session take the agent path with zero direct-call attempts; non-fast depths now attempt the direct path (Covers R8)", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-b7-gates-"));
      const previousFlag = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
      try {
        const store = new WikiStore(storeRoot);
        let directCalls = 0;
        const directCall = async (): Promise<string> => {
          directCalls++;
          return directStructureAnswer;
        };

        process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = "0";
        const { prompts: flagOffPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, { store, pageCount: 1, codeKb: fastKbClient({ directCall }) }),
        );
        if (previousFlag === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
        else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = previousFlag;
        expect(directCalls).toBe(0);
        expect(flagOffPrompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);

        // pageCount 13 resolves to regular depth: the direct path now runs at
        // every depth (Docs submits deep). The canned one-page reply fails the
        // auto-range page-count validation for 13, so the agent fallback still
        // produces the structure — the attempt happens, quality gating holds.
        const { prompts: regularPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, { store, pageCount: 13, codeKb: fastKbClient({ directCall }) }),
        );
        expect(directCalls).toBe(1);
        expect(regularPrompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);

        // A provisioning-only session (instruction blocks, no ready session)
        // must not trigger the direct path.
        const { prompts: provisioningPrompts } = await withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            codeKb: fastKbClient({
              ensure: async () => null,
              peek: async () => ({ session: kbSession, state: "provisioning" }),
              directCall,
            }),
          }),
        );
        // Still 1 from the regular-depth attempt above: a provisioning-only
        // session must add no direct-call attempt.
        expect(directCalls).toBe(1);
        expect(provisioningPrompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(1);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousFlag === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE;
        else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE = previousFlag;
      }
    });

    test("a direct call hanging past the env-tunable budget or throwing falls back to the agent", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-b7-hang-"));
      const previousTimeout = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS;
      process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS = "40";
      try {
        const store = new WikiStore(storeRoot);
        let hangingSignal: AbortSignal | undefined;
        const { result, prompts } = await withFakeSidecar(async () => {
          const hanging = await generateWiki(kbRef, {
            store,
            pageCount: 1,
            codeKb: fastKbClient({
              directCall: (_prompt, _localCli, signal) => {
                hangingSignal = signal;
                return new Promise<string>(() => {});
              },
            }),
          });
          const throwing = await generateWiki(kbRef, {
            store,
            pageCount: 1,
            codeKb: fastKbClient({
              directCall: async () => {
                throw new Error("direct call exploded");
              },
            }),
          });
          return { hanging, throwing };
        });

        expect(prompts.filter((entry) => entry.contextLabel === "wiki-structure").length).toBe(2);
        for (const record of [result.hanging, result.throwing]) {
          expect(record.pages["page-overview"]?.status).toBe("generated");
        }
        // The bounded budget also aborts the hung call so a real CLI dies.
        expect(hangingSignal?.aborted).toBe(true);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousTimeout === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS;
        else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS = previousTimeout;
      }
    });

    test("parent cancellation settles when the direct structure runner ignores abort", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "grok-wiki-generate-direct-structure-parent-abort-"));
      const previousTimeout = process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS;
      process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS = "500";
      try {
        const store = new WikiStore(storeRoot);
        const controller = new AbortController();
        let markDirectStarted!: () => void;
        const directStarted = new Promise<void>((resolve) => {
          markDirectStarted = resolve;
        });
        const run = withFakeSidecar(() =>
          generateWiki(kbRef, {
            store,
            pageCount: 1,
            signal: controller.signal,
            codeKb: fastKbClient({
              directCall: () => {
                markDirectStarted();
                return new Promise<string>(() => {});
              },
            }),
          }),
        );

        await directStarted;
        const canceledAt = performance.now();
        controller.abort("stopped");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const winner = await Promise.race([
          run.then(() => "resolved", (error) => error?.name || "rejected"),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("blocked"), 250);
          }),
        ]);
        if (timer) clearTimeout(timer);

        expect(winner).toBe("AbortError");
        expect(performance.now() - canceledAt).toBeLessThan(250);
        await run.catch(() => undefined);
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
        if (previousTimeout === undefined) delete process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS;
        else process.env.GROK_WIKI_CODE_KB_FAST_STRUCTURE_TIMEOUT_MS = previousTimeout;
      }
    });

    test("the fast-structure timeout default scales with page count and clamps to 180s", () => {
      // 60s floor plus 4s per page: a small wiki keeps the old 60s, a deep Docs
      // run gets a longer budget instead of timing out at exactly 60s.
      expect(fastStructureTimeoutDefaultMs(0)).toBe(60_000);
      expect(fastStructureTimeoutDefaultMs(1)).toBe(64_000);
      expect(fastStructureTimeoutDefaultMs(6)).toBe(84_000);
      expect(fastStructureTimeoutDefaultMs(30)).toBe(180_000);
      // Clamp holds past the ceiling; non-numeric input floors to the base.
      expect(fastStructureTimeoutDefaultMs(60)).toBe(180_000);
      expect(fastStructureTimeoutDefaultMs(undefined)).toBe(60_000);
    });
  });
});

describe("wiki page count options", () => {
  test("derives conservative auto page-count ranges from the max-page ceiling", () => {
    expect(wikiAutoPageCountRange(1)).toEqual({ min: 1, max: 1 });
    expect(wikiAutoPageCountRange(6)).toEqual({ min: 2, max: 6 });
    expect(wikiAutoPageCountRange(12)).toEqual({ min: 3, max: 12 });
    expect(wikiAutoPageCountRange(24)).toEqual({ min: 6, max: 24 });
    expect(wikiAutoPageCountRange(30)).toEqual({ min: 10, max: 30 });
  });
});

describe("wiki structure normalization", () => {
  test("moves an existing opening page to the first page and keeps its format-specific title", () => {
    const structure = ensureOpeningPageFirstWikiStructure({
      title: "Repo Wiki",
      description: "A wiki",
      sections: [
        { id: "section-architecture", title: "Architecture", pages: ["page-runtime"], subsections: [] },
        { id: "section-start", title: "Start", pages: ["page-repository-overview"], subsections: [] },
      ],
      pages: [
        {
          id: "page-runtime",
          title: "Runtime",
          description: "Runtime internals",
          importance: "medium",
          filePaths: ["src/runtime.ts"],
          relatedPages: ["page-repository-overview"],
          parentSection: "section-architecture",
        },
        {
          id: "page-repository-overview",
          title: "Repository Overview",
          description: "What this repo is.",
          importance: "high",
          filePaths: ["README.md", "package.json"],
          relatedPages: ["page-runtime"],
          parentSection: "section-start",
        },
      ],
    });

    expect(structure.pages[0]?.id).toBe("page-overview");
    expect(structure.pages[0]?.title).toBe("Repository Overview");
    expect(structure.sections[0]?.id).toBe("section-start");
    expect(structure.sections[0]?.pages[0]).toBe("page-overview");
    expect(structure.pages[1]?.relatedPages).toContain("page-overview");
  });

  test("uses the agent's first page as the opening instead of injecting generic Overview", () => {
    const structure = ensureOpeningPageFirstWikiStructure({
      title: "Repo Wiki",
      description: "A wiki",
      sections: [
        { id: "section-architecture", title: "Architecture", pages: ["page-runtime"], subsections: [] },
      ],
      pages: [
        {
          id: "page-runtime",
          title: "What Is Worth Stealing",
          description: "Runtime internals",
          importance: "medium",
          filePaths: ["README.md", "src/runtime.ts", "src/worker.ts"],
          relatedPages: [],
          parentSection: "section-architecture",
        },
      ],
    });

    expect(structure.pages[0]).toMatchObject({
      id: "page-overview",
      title: "What Is Worth Stealing",
      importance: "medium",
      parentSection: "section-architecture",
    });
    expect(structure.pages[0]?.filePaths).toContain("README.md");
    expect(structure.pages[0]?.relatedPages).toEqual([]);
    expect(structure.sections[0]?.pages).toEqual(["page-overview"]);
    expect(structure.pages).toHaveLength(1);
  });

  test("falls back to a style-specific opening title when the first page is untitled", () => {
    const structure = ensureOpeningPageFirstWikiStructure({
      title: "Repo Wiki",
      description: "A wiki",
      sections: [
        { id: "section-architecture", title: "Architecture", pages: ["page-runtime"], subsections: [] },
      ],
      pages: [
        {
          id: "page-runtime",
          title: "",
          description: "",
          importance: "medium",
          filePaths: ["README.md", "src/runtime.ts"],
          relatedPages: [],
          parentSection: "section-architecture",
        },
      ],
    }, { style: "first-30" });

    expect(structure.pages[0]).toMatchObject({
      id: "page-overview",
      title: "Start Here",
      description: "What this repository is, what to read first, and what should make sense in the first 30 minutes.",
    });
  });

  test("keeps legacy overview normalizer export compatible", () => {
    const structure = ensureOverviewFirstWikiPage({
      title: "Repo Wiki",
      description: "A wiki",
      sections: [
        { id: "section-start", title: "Start", pages: ["page-intro"], subsections: [] },
      ],
      pages: [
        {
          id: "page-intro",
          title: "Repository Guide",
          description: "Opening page.",
          importance: "high",
          filePaths: ["README.md"],
          relatedPages: [],
          parentSection: "section-start",
        },
      ],
    });

    expect(structure.pages[0]?.id).toBe("page-overview");
    expect(structure.pages[0]?.title).toBe("Repository Guide");
  });
});
