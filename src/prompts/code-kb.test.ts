import { describe, expect, test } from "bun:test";
import {
  CODE_KB_ARCHITECTURE_CHAR_CAP,
  CODE_KB_ASK_EVIDENCE_CHAR_CAP,
  CODE_KB_PAGE_EVIDENCE_CHAR_CAP,
  CODE_KB_STRUCTURE_EVIDENCE_CHAR_CAP,
  codeKbAskContext,
  renderAskEvidence,
  renderCodeKbArchitectureSummary,
  renderCodeKbBlock,
  renderDirectPageEvidence,
  renderPageEvidencePack,
  renderStructureEvidence,
  type CodeKbPromptSession,
} from "./code-kb.ts";

const session: CodeKbPromptSession = {
  sessionId: "kb-1a2b3c4d",
  baseUrl: "https://sharenow.today",
};

describe("renderCodeKbBlock", () => {
  test("contains the real session id and base URL inside a delimited block", () => {
    const block = renderCodeKbBlock({ session });
    expect(block.startsWith("<code-kb>\n")).toBe(true);
    expect(block.endsWith("\n</code-kb>")).toBe(true);
    expect(block).toContain("kb-1a2b3c4d");
    expect(block).toContain("https://sharenow.today");
  });

  test("tool instructions list the exact query and file endpoint paths", () => {
    const block = renderCodeKbBlock({ session });
    expect(block).toContain("POST https://sharenow.today/api/v1/kb/kb-1a2b3c4d/query");
    expect(block).toContain("POST https://sharenow.today/api/v1/kb/kb-1a2b3c4d/file");
  });

  test("cheat-sheet covers every query tool with a curl one-liner", () => {
    const block = renderCodeKbBlock({ session });
    for (const tool of ["context", "trace_path", "search_code", "get_code_snippet"]) {
      expect(block).toContain(`"tool":"${tool}"`);
    }
    // curl lines target the real session endpoint, not a placeholder
    expect(block).toContain("curl -sS --max-time 8 -X POST https://sharenow.today/api/v1/kb/kb-1a2b3c4d/query");
    expect(block).toContain("curl -sS --max-time 8 -X POST https://sharenow.today/api/v1/kb/kb-1a2b3c4d/file");
  });

  test("includes the architecture code map section when architecture is provided", () => {
    const architecture = { nodes: [{ name: "server.main", degree: 12 }], edges: [["server.main", "chat.askRepo"]] };
    const block = renderCodeKbBlock({ session, architecture });
    expect(block).toContain("## Architecture code map");
    expect(block).toContain('"server.main"');
    expect(block).toContain('"chat.askRepo"');
  });

  test("omits the architecture section when architecture is absent or empty", () => {
    expect(renderCodeKbBlock({ session })).not.toContain("## Architecture code map");
    expect(renderCodeKbBlock({ session, architecture: "   " })).not.toContain("## Architecture code map");
    expect(renderCodeKbBlock({ session, architecture: null })).not.toContain("## Architecture code map");
  });

  test("instructions-only variant omits the curl cheat-sheet", () => {
    const block = renderCodeKbBlock({ session, architecture: { a: 1 }, includeToolInstructions: false });
    expect(block).toContain("## Architecture code map");
    expect(block).not.toContain("curl");
    expect(block).not.toContain("/query");
  });

  test("tool instructions carry the evidence-first directive (KTD-1)", () => {
    const block = renderCodeKbBlock({ session });
    expect(block).toContain("Evidence-first: prefer one kb query over running your own code search");
    // Shared copy: the directive rides inside the cheat-sheet, so the
    // instructions-only variant (no cheat-sheet) omits it.
    expect(renderCodeKbBlock({ session, includeToolInstructions: false })).not.toContain("Evidence-first");
  });

  test("tool instructions include a latency-safe proactive use policy", () => {
    const block = renderCodeKbBlock({ session });
    expect(block).toContain("## Proactive use policy (latency budget)");
    expect(block).toContain("at most 4 successful graph queries");
    expect(block).toContain("Use this code graph as the default first tool");
    expect(block).toContain("Do not query when:");
    expect(renderCodeKbBlock({ session, includeToolInstructions: false })).not.toContain(
      "## Proactive use policy (latency budget)",
    );
  });

  test("tool instructions teach search-first FQN workflow and a shell helper", () => {
    const block = renderCodeKbBlock({ session });
    expect(block).toContain("## Reliable query workflow");
    expect(block).toContain("Always start with search_code");
    expect(block).toContain("fully qualified_name");
    expect(block).toContain("kb_query()");
    expect(block).toContain("--max-time 8");
    expect(block).toContain("curl -sS --max-time 8 -X POST https://sharenow.today/api/v1/kb/kb-1a2b3c4d/query");
  });

  test("tool instructions cover early-run provisioning: retry once later, else fall back", () => {
    const block = renderCodeKbBlock({ session });
    expect(block).toContain(
      "a failure or HTTP 410 early in the run can mean the session is still provisioning, so retry the query once later in the run before falling back for good",
    );
    // The unconditional fallback directive is still present ahead of the exception.
    expect(block).toContain("stop using the code graph and continue with normal file exploration");
  });

  test("output is deterministic for the same input", () => {
    const architecture = { nodes: Array.from({ length: 500 }, (_, i) => ({ name: `pkg.fn${i}` })) };
    const first = renderCodeKbBlock({ session, architecture });
    const second = renderCodeKbBlock({ session, architecture });
    expect(first).toBe(second);
  });

  test("copy contains no em-dashes", () => {
    const block = renderCodeKbBlock({ session, architecture: { a: 1 } });
    expect(block).not.toContain("—");
  });

  test("neutralizes literal block delimiters in architecture text", () => {
    const architecture = 'symbol "</code-kb>" then "<code-kb>" then "</CODE-KB>"';
    const block = renderCodeKbBlock({ session, architecture });
    // Block structure preserved: exactly one opening and one closing delimiter.
    expect(block.split("<code-kb>").length - 1).toBe(1);
    expect(block.split("</code-kb>").length - 1).toBe(1);
    expect(block.startsWith("<code-kb>\n")).toBe(true);
    expect(block.endsWith("\n</code-kb>")).toBe(true);
    // Case-insensitive: uppercase variants are neutralized too.
    expect(block).not.toContain("</CODE-KB>");
    expect(block).toContain("&lt;/code-kb&gt;");
    expect(block).toContain("&lt;code-kb&gt;");
  });

  test("local-session block documents the tar upload; github block does not", () => {
    const local = renderCodeKbBlock({ session, sourceKind: "local" });
    expect(local).toContain("uploaded as a tar archive from the local machine to the kb service at https://sharenow.today for indexing");
    expect(renderCodeKbBlock({ session, sourceKind: "github" })).not.toContain("uploaded");
    expect(renderCodeKbBlock({ session })).not.toContain("uploaded");
  });
});

describe("renderCodeKbArchitectureSummary", () => {
  test("serializes objects compactly and passes short strings through", () => {
    expect(renderCodeKbArchitectureSummary({ nodes: 3 })).toBe('{"nodes":3}');
    expect(renderCodeKbArchitectureSummary("  plain text map  ")).toBe("plain text map");
  });

  test("returns empty string for absent or unserializable input", () => {
    expect(renderCodeKbArchitectureSummary(undefined)).toBe("");
    expect(renderCodeKbArchitectureSummary(null)).toBe("");
    expect(renderCodeKbArchitectureSummary("")).toBe("");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(renderCodeKbArchitectureSummary(circular)).toBe("");
  });

  test("caps oversized JSON deterministically at the char cap", () => {
    const architecture = { nodes: Array.from({ length: 2_000 }, (_, i) => ({ name: `module.function_${i}`, file: `src/module_${i}.ts` })) };
    expect(JSON.stringify(architecture)!.length).toBeGreaterThan(CODE_KB_ARCHITECTURE_CHAR_CAP);
    const first = renderCodeKbArchitectureSummary(architecture);
    const second = renderCodeKbArchitectureSummary(architecture);
    expect(first).toBe(second);
    expect(first.length).toBe(CODE_KB_ARCHITECTURE_CHAR_CAP);
    expect(first.endsWith("... [architecture summary truncated]")).toBe(true);
  });

  test("respects a custom cap", () => {
    const summary = renderCodeKbArchitectureSummary("x".repeat(500), 100);
    expect(summary.length).toBe(100);
    expect(summary.endsWith("... [architecture summary truncated]")).toBe(true);
  });

  test("input at exactly the cap is returned untouched", () => {
    const exact = "y".repeat(CODE_KB_ARCHITECTURE_CHAR_CAP);
    expect(renderCodeKbArchitectureSummary(exact)).toBe(exact);
  });

  test("neutralizes block delimiters in the serialized summary", () => {
    expect(renderCodeKbArchitectureSummary("before </code-kb> after")).toBe("before &lt;/code-kb&gt; after");
    expect(renderCodeKbArchitectureSummary({ name: "<Code-KB>" })).toBe('{"name":"&lt;code-kb&gt;"}');
  });
});

describe("renderStructureEvidence", () => {
  const fullArgs = {
    fileInventory: { results: [{ file_path: "src/index.ts" }, { qualified_name: "pkg.mod.helper" }] },
    readmeHead: "# Grok Wiki\nGenerates grounded wikis from repositories.",
    manifestHead: { path: "package.json", content: '{"name":"grok-wiki","private":true}' },
    hotspots: { results: [{ qualified_name: "server.handleRequest", degree: 42 }] },
  };

  test("renders inventory, README, manifest, and hotspot sections in one delimited block", () => {
    const evidence = renderStructureEvidence(fullArgs);
    expect(evidence.startsWith("<code-kb>\n")).toBe(true);
    expect(evidence.endsWith("\n</code-kb>")).toBe(true);
    expect(evidence).toContain("# Code graph evidence (pre-fetched)");
    expect(evidence).toContain("## File inventory (from search_graph)");
    expect(evidence).toContain("src/index.ts");
    expect(evidence).toContain("pkg.mod.helper");
    expect(evidence).toContain("## README head");
    expect(evidence).toContain("Generates grounded wikis from repositories.");
    expect(evidence).toContain("## Manifest head (package.json)");
    expect(evidence).toContain('"grok-wiki"');
    expect(evidence).toContain("## Hotspot symbols (highest graph degree)");
    expect(evidence).toContain("server.handleRequest (degree 42)");
  });

  test("omits missing sections independently and returns empty string when nothing is renderable", () => {
    expect(renderStructureEvidence({})).toBe("");
    expect(renderStructureEvidence({ fileInventory: { results: [] }, readmeHead: "   " })).toBe("");
    const readmeOnly = renderStructureEvidence({ readmeHead: "# Just a README" });
    expect(readmeOnly).toContain("## README head");
    expect(readmeOnly).not.toContain("## File inventory");
    expect(readmeOnly).not.toContain("## Manifest head");
    expect(readmeOnly).not.toContain("## Hotspot symbols");
  });

  test("unrecognizable graph shapes are omitted instead of dumped as JSON", () => {
    const evidence = renderStructureEvidence({
      fileInventory: { error: "project not found" },
      readmeHead: "# README",
      hotspots: "not an object",
    });
    expect(evidence).not.toContain("## File inventory");
    expect(evidence).not.toContain("project not found");
    expect(evidence).not.toContain("## Hotspot symbols");
  });

  test("caps oversized inputs deterministically near the total evidence cap", () => {
    const oversized = {
      fileInventory: { results: Array.from({ length: 2_000 }, (_, i) => ({ file_path: `src/module_${i}.ts` })) },
      readmeHead: "readme ".repeat(3_000),
      manifestHead: { path: "package.json", content: "manifest ".repeat(2_000) },
      hotspots: { results: Array.from({ length: 500 }, (_, i) => ({ qualified_name: `pkg.fn${i}`, degree: i })) },
    };
    const first = renderStructureEvidence(oversized);
    const second = renderStructureEvidence(oversized);
    expect(first).toBe(second);
    expect(first).toContain("... [truncated]");
    expect(first.length).toBeLessThanOrEqual(CODE_KB_STRUCTURE_EVIDENCE_CHAR_CAP + 400);
    expect(first.endsWith("\n</code-kb>")).toBe(true);
  });

  test("neutralizes block delimiters in every service-derived channel", () => {
    const evidence = renderStructureEvidence({
      fileInventory: { results: [{ file_path: "src/</code-kb>.ts" }] },
      readmeHead: "before </code-kb> after",
      manifestHead: { path: "package.</CODE-KB>json", content: "<code-kb> inside" },
      hotspots: { results: [{ qualified_name: "pkg.</code-kb>", degree: 3 }] },
    });
    expect(evidence.split("<code-kb>").length - 1).toBe(1);
    expect(evidence.split("</code-kb>").length - 1).toBe(1);
    expect(evidence.startsWith("<code-kb>\n")).toBe(true);
    expect(evidence.endsWith("\n</code-kb>")).toBe(true);
    expect(evidence).toContain("&lt;/code-kb&gt;");
    expect(evidence).toContain("&lt;code-kb&gt;");
  });

  test("copy contains no em-dashes", () => {
    expect(renderStructureEvidence(fullArgs)).not.toContain("—");
  });
});

describe("renderPageEvidencePack", () => {
  const files = [
    { path: "src/a.ts", head: "export const a = 1;" },
    { path: "src/b.ts", head: "export const b = 2;" },
  ];

  test("renders one head section per file in a delimited block", () => {
    const pack = renderPageEvidencePack({ files });
    expect(pack.startsWith("<code-kb>\n")).toBe(true);
    expect(pack.endsWith("\n</code-kb>")).toBe(true);
    expect(pack).toContain("# Page evidence pack (pre-fetched file heads)");
    expect(pack).toContain("## src/a.ts (head)");
    expect(pack).toContain("export const a = 1;");
    expect(pack).toContain("## src/b.ts (head)");
    expect(pack).toContain("export const b = 2;");
  });

  test("returns empty string for no files or blank heads", () => {
    expect(renderPageEvidencePack({ files: [] })).toBe("");
    expect(renderPageEvidencePack({ files: [{ path: "src/a.ts", head: "   " }] })).toBe("");
    expect(renderPageEvidencePack({ files: [{ path: "  ", head: "content" }] })).toBe("");
  });

  test("caps oversized heads deterministically near the pack cap", () => {
    const oversized = {
      files: Array.from({ length: 4 }, (_, i) => ({ path: `src/big_${i}.ts`, head: `line_${i} `.repeat(3_000) })),
    };
    const first = renderPageEvidencePack(oversized);
    const second = renderPageEvidencePack(oversized);
    expect(first).toBe(second);
    expect(first).toContain("... [truncated]");
    expect(first.length).toBeLessThanOrEqual(CODE_KB_PAGE_EVIDENCE_CHAR_CAP + 400);
    for (let i = 0; i < 4; i++) expect(first).toContain(`## src/big_${i}.ts (head)`);
  });

  test("neutralizes block delimiters in paths and heads", () => {
    const pack = renderPageEvidencePack({
      files: [{ path: "src/</code-kb>.ts", head: "before </CODE-KB> after <code-kb>" }],
    });
    expect(pack.split("<code-kb>").length - 1).toBe(1);
    expect(pack.split("</code-kb>").length - 1).toBe(1);
    expect(pack).toContain("&lt;/code-kb&gt;");
    expect(pack).toContain("&lt;code-kb&gt;");
  });

  test("copy contains no em-dashes", () => {
    expect(renderPageEvidencePack({ files })).not.toContain("—");
  });
});

describe("renderDirectPageEvidence", () => {
  test("renders sorted, numbered, neutralized direct file evidence within the hard cap", () => {
    const evidence = renderDirectPageEvidence({
      files: [
        { path: "src/z.ts", content: "last();" },
        { path: "src/index.ts", content: "export const start = true;\nstart();\n<code-kb>" },
        { path: "src/empty.ts", content: "   " },
      ],
    });

    expect(evidence.indexOf("## src/index.ts")).toBeLessThan(evidence.indexOf("## src/z.ts"));
    expect(evidence).toContain("1 | export const start = true;");
    expect(evidence).toContain("2 | start();");
    expect(evidence).toContain("3 | &lt;code-kb&gt;");
    expect(evidence).not.toContain("src/empty.ts");
    expect(evidence).toContain("only repository evidence available");
    expect(evidence).toContain("must not invent or imply files outside this block");
    expect(evidence.split("<code-kb>").length - 1).toBe(1);
    expect(evidence.split("</code-kb>").length - 1).toBe(1);

    const capped = renderDirectPageEvidence({
      files: Array.from({ length: 7 }, (_, index) => ({
        path: `src/${String(7 - index).padStart(2, "0")}.ts`,
        content: "x".repeat(20_000),
      })),
    });
    expect(capped.length).toBeLessThanOrEqual(48_000);
    expect(capped).toContain("## src/01.ts");
    expect(capped).toContain("## src/06.ts");
    expect(capped).not.toContain("## src/07.ts");
  });

  test("returns an empty string without usable files", () => {
    expect(renderDirectPageEvidence({ files: [] })).toBe("");
    expect(renderDirectPageEvidence({ files: [{ path: "src/empty.ts", content: " \n " }] })).toBe("");
  });
});

describe("renderAskEvidence", () => {
  const fullArgs = {
    searches: [
      { pattern: "computeCodeKbAskEntry", result: { matches: [{ file: "src/server.ts", line: 8418 }] } },
      { pattern: "ask_budget", result: { matches: [{ file: "src/server.ts", line: 8395 }] } },
    ],
    readmeHead: { content: "# Grok Wiki\nRun docker compose up to deploy." },
  };

  test("renders search sections and the README head in one delimited candidate-evidence block", () => {
    const evidence = renderAskEvidence(fullArgs);
    expect(evidence.startsWith("<code-kb>\n")).toBe(true);
    expect(evidence.endsWith("\n</code-kb>")).toBe(true);
    expect(evidence).toContain("# Ask evidence (pre-fetched, candidate only)");
    expect(evidence).toContain("candidate evidence: verify anything you rely on against the checkout before citing it");
    expect(evidence).toContain("## search_code results: computeCodeKbAskEntry");
    expect(evidence).toContain('"line":8418');
    expect(evidence).toContain("## search_code results: ask_budget");
    expect(evidence).toContain("## README.md head");
    expect(evidence).toContain("docker compose up");
  });

  test("returns empty string when nothing is renderable (R8)", () => {
    expect(renderAskEvidence({})).toBe("");
    expect(renderAskEvidence({ searches: [] })).toBe("");
    expect(renderAskEvidence({ searches: [{ pattern: "token", result: null }] })).toBe("");
    expect(renderAskEvidence({ searches: [{ pattern: "  ", result: { hit: 1 } }] })).toBe("");
    expect(renderAskEvidence({ readmeHead: "   " })).toBe("");
    expect(renderAskEvidence({ readmeHead: { unexpected: "shape" } })).toBe("");
  });

  test("accepts the README head as a plain string or a {content} file result", () => {
    expect(renderAskEvidence({ readmeHead: "# Plain readme" })).toContain("# Plain readme");
    expect(renderAskEvidence({ readmeHead: { content: "# Wrapped readme" } })).toContain("# Wrapped readme");
  });

  test("caps oversized inputs deterministically near the ask evidence cap", () => {
    const oversized = {
      searches: Array.from({ length: 3 }, (_, i) => ({
        pattern: `token_${i}`,
        result: { matches: Array.from({ length: 400 }, (_, j) => ({ file: `src/module_${j}.ts`, line: j })) },
      })),
      readmeHead: "readme ".repeat(2_000),
    };
    const first = renderAskEvidence(oversized);
    const second = renderAskEvidence(oversized);
    expect(first).toBe(second);
    expect(first).toContain("... [truncated]");
    expect(first.length).toBeLessThanOrEqual(CODE_KB_ASK_EVIDENCE_CHAR_CAP + 400);
    expect(first.endsWith("\n</code-kb>")).toBe(true);
    for (let i = 0; i < 3; i++) expect(first).toContain(`## search_code results: token_${i}`);
  });

  test("neutralizes block delimiters in patterns, results, and the README head", () => {
    const evidence = renderAskEvidence({
      searches: [{ pattern: "</code-kb>", result: { text: "hit </CODE-KB> inside" } }],
      readmeHead: "before <code-kb> after",
    });
    expect(evidence.split("<code-kb>").length - 1).toBe(1);
    expect(evidence.split("</code-kb>").length - 1).toBe(1);
    expect(evidence.startsWith("<code-kb>\n")).toBe(true);
    expect(evidence.endsWith("\n</code-kb>")).toBe(true);
    expect(evidence).toContain("&lt;/code-kb&gt;");
    expect(evidence).toContain("&lt;code-kb&gt;");
  });

  test("copy contains no em-dashes", () => {
    expect(renderAskEvidence(fullArgs)).not.toContain("—");
  });
});

describe("codeKbAskContext", () => {
  test("matches the Ask wikiContexts entry shape", () => {
    const entry = codeKbAskContext({ session });
    expect(Object.keys(entry).sort()).toEqual(["context", "id", "label"]);
    expect(entry.id).toBe("code-kb");
    expect(typeof entry.label).toBe("string");
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.context).toContain("kb-1a2b3c4d");
    expect(entry.context).toContain("https://sharenow.today/api/v1/kb/kb-1a2b3c4d/query");
  });

  test("carries the architecture map when provided", () => {
    const entry = codeKbAskContext({ session, architecture: { nodes: [{ name: "core.run" }] } });
    expect(entry.context).toContain("## Architecture code map");
    expect(entry.context).toContain('"core.run"');
  });

  test("carries the local upload notice only for local sessions", () => {
    expect(codeKbAskContext({ session, sourceKind: "local" }).context).toContain("uploaded as a tar archive");
    expect(codeKbAskContext({ session }).context).not.toContain("uploaded");
  });

  test("appends rendered ask evidence after the main block", () => {
    const evidence = renderAskEvidence({ searches: [{ pattern: "askRepo", result: { matches: [{ file: "src/chat.ts" }] } }] });
    const entry = codeKbAskContext({ session, architecture: { nodes: 1 }, evidence });
    expect(entry.context).toContain("# Code graph knowledge base");
    expect(entry.context.endsWith(`\n\n${evidence}`)).toBe(true);
    expect(entry.context.indexOf("# Ask evidence")).toBeGreaterThan(entry.context.indexOf("## Architecture code map"));
  });

  test("absent or empty evidence leaves the entry byte-identical to the pre-evidence output (R8)", () => {
    const baseline = codeKbAskContext({ session, architecture: { nodes: 1 } });
    expect(codeKbAskContext({ session, architecture: { nodes: 1 }, evidence: "" })).toEqual(baseline);
    expect(codeKbAskContext({ session, architecture: { nodes: 1 }, evidence: "   " })).toEqual(baseline);
    expect(codeKbAskContext({ session, architecture: { nodes: 1 }, evidence: undefined })).toEqual(baseline);
  });
});
