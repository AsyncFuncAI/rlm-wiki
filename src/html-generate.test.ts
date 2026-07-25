import { describe, expect, test } from "bun:test";
import {
  buildHtmlGeneratePrompt,
  dressCssRootForPrompt,
  extractHtmlFromAgentOutput,
  extractKnownPathsFromEvidence,
  extractPathAnchors,
  htmlArtifactQualityIssue,
  injectHtmlDressCssRoot,
  looksLikePillTabEssay,
  brochureVoiceIssue,
  mapSvgQualityIssue,
  normalizeHtmlGenre,
  pathAnchorExistenceIssue,
  titleFromBrief,
  unifiedSectionQualityIssue,
} from "./html-generate.ts";
import { fetchHtmlEvidencePack } from "./html-evidence.ts";

describe("html-generate", () => {
  test("normalizeHtmlGenre maps legacy and falls back to tour", () => {
    expect(normalizeHtmlGenre("report")).toBe("trace");
    expect(normalizeHtmlGenre("explore")).toBe("tour");
    expect(normalizeHtmlGenre("nope")).toBe("tour");
    expect(normalizeHtmlGenre("impact")).toBe("impact");
    expect(normalizeHtmlGenre("map")).toBe("map");
  });

  test("buildHtmlGeneratePrompt requires single-file HTML and markers", () => {
    const prompt = buildHtmlGeneratePrompt({
      title: "First 30 mins",
      brief: "Onboard me to this repo",
      genre: "tour",
      scope: "https://github.com/mathaix/OpenClawMachines",
    });
    expect(prompt).toContain("self-contained HTML");
    expect(prompt).toContain("<!--GW_HTML_START-->");
    expect(prompt).toContain("OpenClawMachines");
    expect(prompt).toContain("READING EXPERIENCE");
    expect(prompt).toContain("L1");
    expect(prompt).toContain("stack table");
    expect(prompt).toContain("worth borrowing");
    expect(prompt).toContain("JOB");
    expect(prompt).toContain("Onboard me to this repo");
    expect(prompt).not.toContain("Markdown only");
    expect(prompt).toContain("USER NOTE STEERING");
    expect(prompt).toMatch(/L1–L10 still all run|L1-L10 still all run/i);
    expect(prompt).toContain("day-to-day");
  });

  test("buildHtmlGeneratePrompt omits brief steering when brief empty", () => {
    const prompt = buildHtmlGeneratePrompt({
      title: "First 30 mins",
      brief: "   ",
      genre: "tour",
      scope: "https://github.com/mathaix/OpenClawMachines",
    });
    expect(prompt).not.toContain("USER NOTE STEERING");
    expect(prompt).toContain("day-to-day");
  });

  test("buildHtmlGeneratePrompt uses dress tokens without dumping font data-URIs", () => {
    const hugeFont =
      "@font-face{font-family:X;src:url(data:font/woff2;base64," + "A".repeat(50_000) + ")}";
    const cssRoot = `${hugeFont}\n:root { --bg: #0c0c0c; --text: #f2f2f0; }`;
    const prompt = buildHtmlGeneratePrompt({
      title: "Guide",
      brief: "Explain the API",
      genre: "trace",
      scope: "owner/repo",
      dress: {
        id: "geist-pixel",
        label: "Geist Pixel",
        summary: "Vercel geist",
        theme: "dark",
        cssContract: "Background #0c0c0c, text #f2f2f0",
        layoutRules: "Pixel headlines",
        cssRoot,
      },
    });
    expect(prompt).toContain("VISUAL DRESS");
    expect(prompt).toContain("geist-pixel");
    expect(prompt).toContain("--bg");
    expect(prompt).toContain("system-owned");
    expect(prompt).not.toContain("data:font/woff2;base64");
    expect(prompt.length).toBeLessThan(cssRoot.length);
  });

  test("buildHtmlGeneratePrompt tightens tool budget when evidence pack is rich", () => {
    const fat = "x".repeat(2500);
    const prompt = buildHtmlGeneratePrompt({
      title: "Deep",
      brief: "How does auth work?",
      genre: "map",
      scope: "acme/repo",
      codeKbContext: `<code-kb>\n${fat}\n</code-kb>`,
      evidencePackRich: true,
    });
    expect(prompt).toContain("at most 2 high-signal verification lookups");
    expect(prompt).not.toContain("at most 4 high-signal graph/file lookups");
  });

  test("dressCssRootForPrompt strips @font-face and data-URIs", () => {
    const raw =
      '@font-face{font-family:"G";src:url("data:font/woff2;base64,AAAA")}\n:root { --bg: #111; }';
    const out = dressCssRootForPrompt(raw);
    expect(out).toContain("--bg: #111");
    expect(out).not.toContain("@font-face");
    expect(out).not.toContain("data:font");
  });

  test("injectHtmlDressCssRoot inserts dress style after charset meta", () => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>Hi</h1></body></html>';
    const out = injectHtmlDressCssRoot(html, ":root{--bg:#000}", "void-ink");
    expect(out).toContain('data-gw-dress="void-ink"');
    expect(out).toContain(":root{--bg:#000}");
    expect(out.indexOf("charset")).toBeLessThan(out.indexOf("data-gw-dress"));
    expect(out.indexOf("data-gw-dress")).toBeLessThan(out.indexOf("<title>"));
  });

  test("injectHtmlDressCssRoot is idempotent", () => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
    const once = injectHtmlDressCssRoot(html, ":root{--a:1}", "d");
    const twice = injectHtmlDressCssRoot(once, ":root{--a:2}", "d");
    expect(twice.match(/data-gw-dress/g)?.length).toBe(1);
    expect(twice).toContain("--a:2");
  });

  test("buildHtmlGeneratePrompt injects live code-kb block when provided", () => {
    const prompt = buildHtmlGeneratePrompt({
      title: "Deep Dive",
      brief: "Explain data flow",
      genre: "map",
      scope: "https://github.com/acme/repo",
      codeKbContext: "<code-kb>\nsession kb-html at https://sharenow.today\n## How to query the code graph\n</code-kb>",
    });
    expect(prompt).toContain("CODE GRAPH");
    expect(prompt).toContain("<code-kb>");
    expect(prompt).toContain("kb-html");
  });

  test("extractHtmlFromAgentOutput prefers markers", () => {
    const raw = `noise\n<!--GW_HTML_START-->\n<!DOCTYPE html><html><body>hi</body></html>\n<!--GW_HTML_END-->\nmore`;
    expect(extractHtmlFromAgentOutput(raw)).toContain("<!DOCTYPE html>");
  });

  test("titleFromBrief uses first line", () => {
    expect(titleFromBrief("First 30 mins onboard\nmore", "report")).toBe("First 30 mins onboard");
  });
});

describe("htmlArtifactQualityIssue", () => {
  const good = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenClaw Machines</title>
<style>:root{--bg:#111;--text:#eee} body{background:var(--bg);color:var(--text)}</style>
</head><body>
<p class="kicker">L1 · What is this</p>
<h1>OpenClaw Machines</h1>
<p>This product is a local workshop for ticket agents. You open the app when a support queue needs a grounded run.</p>
<p class="kicker">L4 · Tech stack</p>
<table><tr><th>Layer</th><th>Library</th><th>Purpose</th><th>Path</th></tr>
<tr><td>Shell</td><td>Node</td><td>HTTP host</td><td>src/server.ts</td></tr>
<tr><td>Auth</td><td>session</td><td>login cookie</td><td>src/auth/session.ts</td></tr>
<tr><td>Runtime</td><td>local CLI</td><td>agent spawn</td><td>src/local-cli-runtime.ts</td></tr>
</table>
<p class="kicker">L5 · Patterns</p>
<p>Pattern: agent session transaction. The monorepo convention keeps RPC next to the SPA shell.</p>
<svg viewBox="0 0 640 280" width="100%" height="280" aria-label="wiring">
  <rect x="20" y="30" width="110" height="48" rx="8"/><text x="75" y="58">spa</text>
  <rect x="180" y="30" width="110" height="48" rx="8"/><text x="235" y="58">rpc</text>
  <rect x="340" y="30" width="110" height="48" rx="8"/><text x="395" y="58">core</text>
  <rect x="500" y="30" width="110" height="48" rx="8"/><text x="555" y="58">render</text>
  <rect x="180" y="140" width="110" height="48" rx="8"/><text x="235" y="168">worker</text>
  <rect x="340" y="140" width="110" height="48" rx="8"/><text x="395" y="168">collab</text>
  <path d="M130 54 H180"/><path d="M290 54 H340"/><path d="M450 54 H500"/>
  <path d="M235 78 V140"/><path d="M395 78 V140"/><line x1="290" y1="164" x2="340" y2="164"/>
</svg>
<p>Auth starts in <code>src/server.ts</code> and lands in <code>src/auth/session.ts:42</code>.</p>
<p>Also wired through <code>src/local-cli-runtime.ts</code>.</p>
<h2>How tickets flow</h2>
<p>Entry point flow and step-by-step pipeline. Pattern: agent session. Best practice worth borrowing: keep the retry budget next to the session mint in src/server.ts.</p>
</body></html>`;

  test("accepts grounded document", () => {
    expect(
      htmlArtifactQualityIssue(good, {
        genre: "map",
        hadCodeEvidence: true,
        dress: {
          id: "void",
          label: "Void",
          summary: "dark",
          theme: "dark",
          cssContract: "x",
          layoutRules: "y",
          cssRoot: ":root{--bg:#111;--text:#eee}",
        },
        extractedHtml: good,
      }),
    ).toBeNull();
  });

  test("accepts unified tour with stack patterns and landmines", () => {
    expect(
      htmlArtifactQualityIssue(good, {
        genre: "tour",
        hadCodeEvidence: true,
        extractedHtml: good,
      }),
    ).toBeNull();
  });

  test("extractKnownPathsFromEvidence and path existence gate", () => {
    const pack = `
## Inventory
- src/server.ts
- src/auth/session.ts
- src/local-cli-runtime.ts
- src/index.ts
- package.json
- README.md
- apps/web/main.ts
- crates/core/lib.rs
`;
    const known = extractKnownPathsFromEvidence(pack);
    expect(known.length).toBeGreaterThanOrEqual(8);
    expect(extractPathAnchors(good).length).toBeGreaterThanOrEqual(2);
    expect(pathAnchorExistenceIssue(good, known)).toBeNull();
    const ghosts = good
      .replace(/src\/server\.ts/g, "src/totally-fake-a.ts")
      .replace(/src\/auth\/session\.ts/g, "src/totally-fake-b.ts")
      .replace(/src\/local-cli-runtime\.ts/g, "src/totally-fake-c.ts");
    expect(pathAnchorExistenceIssue(ghosts, known)).toMatch(/inventory|not found|none of the cited/i);
  });

  test("unifiedSectionQualityIssue requires stack patterns landmines when evidence present", () => {
    const thin =
      `<!DOCTYPE html><html><head><title>Demo App</title></head><body><h1>Demo App</h1>` +
      `<p>This product is a note taker. You open it on a call.</p>` +
      `<p>See <code>src/a.ts</code> and <code>src/b.ts</code>.</p>` +
      `<p>${"padding ".repeat(40)}</p></body></html>`;
    expect(unifiedSectionQualityIssue(thin, true)).toMatch(/stack|patterns|landmine/i);
    expect(unifiedSectionQualityIssue(good, true)).toBeNull();
    expect(unifiedSectionQualityIssue(thin, false)).toBeNull();
  });

  test("gates pre-dress content even when post-inject html is huge", () => {
    const extracted =
      `<!DOCTYPE html><html><head><title>Real Product</title></head><body><h1>Real Product</h1>` +
      `<h2>Flow</h2><p>padding `.repeat(40) +
      `</p></body></html>`;
    const injected =
      extracted.slice(0, 60) +
      `<style data-gw-dress="x">:root{--bg:#000;--text:#fff} /* ${"A".repeat(5000)} */</style>` +
      extracted.slice(60);
    // Post-inject alone would "use" --bg via cssRoot; gate must still require agent var() use.
    expect(
      htmlArtifactQualityIssue(injected, {
        extractedHtml: extracted,
        dress: {
          id: "x",
          label: "X",
          summary: "x",
          theme: "dark",
          cssContract: "c",
          layoutRules: "l",
          cssRoot: ":root{--bg:#000;--text:#fff}",
        },
      }),
    ).toMatch(/dress CSS variables/i);
  });

  test("rejects genre-only title", () => {
    const bad = good.replace(/OpenClaw Machines/g, "Exploration");
    expect(htmlArtifactQualityIssue(bad, {})).toMatch(/genre word/i);
  });

  test("rejects remote script CDN", () => {
    const bad = good.replace(
      "</head>",
      '<script src="https://cdn.example.com/x.js"></script></head>',
    );
    expect(htmlArtifactQualityIssue(bad, { extractedHtml: bad })).toMatch(/remote script/i);
  });

  test("rejects missing path anchors when evidence was present", () => {
    const thin = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>My Product Guide</title></head>
<body><h1>My Product Guide</h1><h2>Overview</h2>
<p>It works well with architecture and modules across the stack. This paragraph is padding so length checks pass while still having zero real file path anchors for the quality gate.</p>
<p>More filler about how teams collaborate and ship value without naming any source files at all in this document body.</p>
</body></html>`;
    expect(htmlArtifactQualityIssue(thin, { genre: "concepts", hadCodeEvidence: true })).toMatch(
      /path anchors|concepts job/i,
    );
    // No code evidence and non-map job: length + headings only (add pattern words)
    const thinConcepts =
      thin.replace("Overview", "Mental model").replace(
        "collaborate and ship value",
        "pattern and abstraction without paths",
      );
    expect(
      htmlArtifactQualityIssue(thinConcepts, { genre: "concepts", hadCodeEvidence: false }),
    ).toBeNull();
  });

  test("rejects leaked reasoning preamble", () => {
    const raw =
      "Need see output? Wait assistant final. We need produce actual output.\n" + good;
    expect(htmlArtifactQualityIssue(good, { rawText: raw })).toMatch(/leaked/i);
  });

  test("mapSvgQualityIssue rejects stub graphs and pill-tab essays", () => {
    expect(mapSvgQualityIssue("<html><body><svg></svg></body></html>")).toMatch(/too small|requires/i);
    const pillDoc = `<!DOCTYPE html><html><head><title>Penpot wiring</title></head><body>
      <h1>Penpot wiring</h1>
      <button class="pill">Wiring graph</button><button class="pill">Change flow</button>
      <button class="tab">Entry points</button><button class="chip">Tradeoffs</button>
      <p>One ${"padding ".repeat(20)}</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p><p>Six</p>
    </body></html>`;
    expect(looksLikePillTabEssay(pillDoc)).toBe(true);
    expect(htmlArtifactQualityIssue(pillDoc, { genre: "map", extractedHtml: pillDoc })).toMatch(
      /svg|wiring|pill-tab|graph/i,
    );
  });

  test("rejects left/right zigzag beat timeline CSS", () => {
    const zigzag = `<!DOCTYPE html><html><head><title>OpenClaw Machines</title>
<style>.beat:nth-child(even){margin-left:50%}.beat{width:46%}</style></head>
<body><div class="wrap"><article class="beat"><h2>L1</h2><p>This product is a local workshop.
See src/server.ts and src/auth/session.ts and src/local-cli-runtime.ts for stack and patterns.
Worth borrowing: retry budget. Landmine: DO schema.</p></article>
<article class="beat"><h2>L2</h2><p>padding more content with paths.</p></article></div></body></html>`;
    expect(htmlArtifactQualityIssue(zigzag, { extractedHtml: zigzag })).toMatch(
      /zigzag|center-rail|wrap\/hero\/beat|journey shell/i,
    );
  });

  test("brochureVoiceIssue flags the Penpot-style unreadable lede", () => {
    const lede =
      "How the open-source design platform is actually assembled: shared change logic. Built for a senior engineer who asks where do I start.";
    expect(brochureVoiceIssue(`<html><body><p>${lede}</p></body></html>`)).toMatch(/brochure|assembled|senior engineer/i);
    expect(
      brochureVoiceIssue("<html><body><h2>Shape, options, tradeoffs</h2><p>Why monorepo</p></body></html>"),
    ).toMatch(/shape, options/i);
  });
});

describe("fetchHtmlEvidencePack", () => {
  test("builds deterministic pack from stubbed graph + files", async () => {
    const session = { sessionId: "s1", baseUrl: "https://example.test" } as any;
    const pack = await fetchHtmlEvidencePack(session, 30_000, {
      query: async (_s, tool) => {
        if (tool === "search_graph") {
          return {
            results: [
              { file_path: "README.md", name: "README.md" },
              { file_path: "package.json", name: "package.json" },
              { file_path: "src/server.ts", name: "src/server.ts" },
              { file_path: "src/index.ts", name: "src/index.ts" },
            ],
          };
        }
        if (tool === "get_architecture") {
          return { nodes: [{ name: "server.main", degree: 12 }] };
        }
        return null;
      },
      readFile: async (_s, path) => {
        return { content: `// head of ${path}\nexport const x = 1;\n` };
      },
    });
    expect(pack.length).toBeGreaterThan(100);
    expect(pack).toContain("README");
    expect(pack).toMatch(/server\.ts|index\.ts|package\.json/);
  });

  test("returns empty string when graph tools fail", async () => {
    const session = { sessionId: "s1", baseUrl: "https://example.test" } as any;
    const pack = await fetchHtmlEvidencePack(session, 30_000, {
      query: async () => null,
      readFile: async () => null,
    });
    expect(pack).toBe("");
  });
});
