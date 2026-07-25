import { describe, expect, test } from "bun:test";
import { openSlideDeckFiles, openSlideDeckId, openSlideDeckSourcePath, openSlideDeckZipName } from "./open-slide-export.ts";
import {
  buildSlidesPrompt,
  extractOpenSlideSource,
  validateGeneratedOpenSlideSource,
  validateOpenSlideSource,
  wikiRecordSources,
} from "./slides-generator.ts";
import type { WikiRecord } from "./types.ts";

const wiki: WikiRecord = {
  id: "wiki-demo-basic",
  repoUrl: "https://github.com/acme/demo",
  owner: "acme",
  repo: "demo",
  branch: null,
  generatedAt: "2026-05-18T12:00:00.000Z",
  model: "local-cli",
  structure: {
    title: "Demo Technical Wiki",
    description: "A source-grounded map of the demo repository.",
    sections: [{ id: "core", title: "Core", pages: ["overview"], subsections: [] }],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "How the app starts and routes work.",
        importance: "high",
        filePaths: ["README.md", "src/app.ts"],
        relatedPages: [],
        parentSection: "core",
      },
    ],
  },
  pages: {
    overview: {
      id: "overview",
      generatedAt: "2026-05-18T12:01:00.000Z",
      content: [
        "<details><summary>Source files</summary>README.md</details>",
        "# Overview",
        "The app starts from the CLI and mounts routes from source files.",
        "## Runtime entry",
        "The runtime checks config before serving requests.",
        "## Route table",
        "- Requests are normalized before dispatch.",
        "- Sources: [src/app.ts:1-40]()",
      ].join("\n\n"),
    },
  },
};

describe("Open Slide wiki export", () => {
  test("creates an Open Slide-compatible workspace", () => {
    const files = openSlideDeckFiles(wiki);
    const paths = files.map((file) => file.path);
    const source = files.find((file) => file.path.endsWith("/index.tsx"))?.content || "";

    expect(openSlideDeckId(wiki)).toBe("wiki-demo-basic-slides");
    expect(openSlideDeckZipName(wiki)).toBe("wiki-demo-basic-slides.zip");
    expect(paths).toContain("wiki-demo-basic-slides/package.json");
    expect(paths).toContain("wiki-demo-basic-slides/tsconfig.json");
    expect(paths).toContain("wiki-demo-basic-slides/open-slide.config.ts");
    expect(paths).toContain("wiki-demo-basic-slides/themes/wiki-report.md");
    expect(paths).toContain("wiki-demo-basic-slides/slides/wiki-demo-basic-slides/index.tsx");
    expect(source).toContain("import type { Page, SlideMeta } from '@open-slide/core'");
    expect(source).toContain("export default [Cover, Agenda, ...topicSlides] satisfies Page[]");
    expect(source).toContain("Runtime entry");
    expect(source).not.toContain("Files to inspect next");
    expect(source).not.toContain("Source trail");
    expect(source).not.toContain("src/app.ts");
    expect(source).not.toContain("<details>");
  });

  test("can replace the deck source with an agent-authored Open Slide file", () => {
    const agentSource = "import type { Page, SlideMeta } from '@open-slide/core';\nexport const meta: SlideMeta = { title: 'Demo' };\nconst Cover: Page = () => <section />;\nexport default [Cover] satisfies Page[];";
    const files = openSlideDeckFiles(wiki, { deckSource: agentSource });
    const source = files.find((file) => file.path === openSlideDeckSourcePath(wiki))?.content || "";

    expect(source).toContain("export const meta");
    expect(source).toContain("export default [Cover]");
    expect(source).not.toContain("Generated from Grok-Wiki");
  });

  test("extracts and validates agent Open Slide TSX", () => {
    const source = extractOpenSlideSource([
      "Here is the deck:",
      "<ANSWER>",
      "```tsx",
      "import type { Page, SlideMeta } from '@open-slide/core';",
      "export const meta: SlideMeta = { title: 'Demo' };",
      "const Cover: Page = () => <section />;",
      "export default [Cover] satisfies Page[];",
      "```",
      "</ANSWER>",
    ].join("\n"));

    expect(source).toContain("@open-slide/core");
    expect(() => validateOpenSlideSource(source)).not.toThrow();
    expect(() => validateOpenSlideSource("export default [];")).toThrow("import from @open-slide/core");
  });

  test("rejects Open Slide TSX that would crash at browser runtime", async () => {
    const source = [
      "import type { Page, SlideMeta } from '@open-slide/core';",
      "export const meta: SlideMeta = { title: 'Demo', createdAt: 'now' };",
      "const bg = '#fff';",
      "const Cover: Page = () => <section style={{ background }}><div style={{ background: bg }} /></section>;",
      "export default [Cover] satisfies Page[];",
    ].join("\n");

    await expect(validateGeneratedOpenSlideSource(source)).rejects.toThrow("TypeScript-invalid Open Slide TSX");
  });

  test("slides agent prompt asks for an editorial visual system", () => {
    const prompt = buildSlidesPrompt(wiki, {
      deckId: "wiki-demo-basic-slides",
      slideCount: 5,
    });

    expect(prompt).toContain("premium internal engineering brief");
    expect(prompt).toContain("small reusable design system");
    expect(prompt).toContain("one dominant visual structure per slide");
    expect(prompt).toContain("Do not render visible citations");
    expect(prompt).toContain("do not display citations or source paths on the slides");
    expect(prompt).toContain("Use `letterSpacing: 0`; never use negative letter spacing");
    expect(prompt).toContain("architecture maps, flow lanes, comparison matrices");
    expect(prompt).toContain("mechanism stacks");
    expect(prompt).toContain("notes` entry for each slide");
    expect(prompt).toContain("Do not add `createdAt`, `author`, or custom metadata fields");
    expect(prompt).toContain("Do not use shorthand properties unless that exact variable is declared");
  });

  test("preserves scoped wiki source paths for slide agent workspaces", () => {
    expect(wikiRecordSources({
      ...wiki,
      sourcePath: "codex-rs/app-server",
    })).toEqual([
      {
        id: "acme-demo",
        source: "https://github.com/acme/demo",
        branch: null,
        sourcePath: "codex-rs/app-server",
        label: "acme/demo",
      },
    ]);

    expect(wikiRecordSources({
      ...wiki,
      repos: [
        {
          id: "repo-a",
          owner: "acme",
          repo: "demo",
          label: "acme/demo:packages/api",
          url: "https://github.com/acme/demo",
          branch: "main",
          sourcePath: "packages/api",
        },
      ],
    })).toEqual([
      {
        id: "repo-a",
        source: "https://github.com/acme/demo",
        branch: "main",
        sourcePath: "packages/api",
        label: "acme/demo:packages/api",
      },
    ]);

    expect(wikiRecordSources({
      ...wiki,
      repoUrl: "https://github.com/acme/demo/tree/main/packages/api",
      branch: null,
      sourcePath: null,
    })).toEqual([
      {
        id: "acme-demo",
        source: "https://github.com/acme/demo",
        branch: "main",
        sourcePath: "packages/api",
        label: "acme/demo",
      },
    ]);

    expect(wikiRecordSources({
      ...wiki,
      repos: [
        {
          id: "repo-a",
          owner: "acme",
          repo: "demo",
          label: "acme/demo:packages/api",
          url: "https://github.com/acme/demo/tree/main/packages/api",
          branch: "release",
          sourcePath: "packages/web",
        },
      ],
    })).toEqual([
      {
        id: "repo-a",
        source: "https://github.com/acme/demo",
        branch: "release",
        sourcePath: "packages/web",
        label: "acme/demo:packages/api",
      },
    ]);
  });
});
