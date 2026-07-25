import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSlideDeckFiles } from "./open-slide-export.ts";
import {
  buildOpenSlideViewer,
  openSlideViewerFilePath,
  openSlideViewerSourceHash,
} from "./slides-viewer.ts";
import type { WikiRecord } from "./types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const wiki: WikiRecord = {
  id: "viewer-demo",
  repoUrl: "https://github.com/acme/demo",
  owner: "acme",
  repo: "demo",
  branch: null,
  generatedAt: "2026-05-18T12:00:00.000Z",
  model: "local-cli",
  structure: {
    title: "Viewer Demo",
    description: "A small demo wiki.",
    sections: [{ id: "core", title: "Core", pages: ["overview"], subsections: [] }],
    pages: [{
      id: "overview",
      title: "Overview",
      description: "What matters",
      importance: "high",
      filePaths: ["README.md"],
      relatedPages: [],
    }],
  },
  pages: {
    overview: {
      id: "overview",
      generatedAt: "2026-05-18T12:01:00.000Z",
      content: "The repository has a clear entry point.",
    },
  },
};

describe("Open Slide viewer builder", () => {
  test("materializes a controlled viewer workspace and rewrites static asset paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-slides-viewer-"));
    roots.push(root);
    const files = openSlideDeckFiles(wiki);
    const commands: string[][] = [];

    const result = await buildOpenSlideViewer({
      root,
      slidesRunId: "slides-run-1",
      files,
      commandRunner: async (command, options) => {
        commands.push(command);
        const packageJson = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
        expect(packageJson.dependencies["@open-slide/core"]).toBeTruthy();
        expect(packageJson.dependencies["@open-slide/cli"]).toBeUndefined();
        if (command.includes("build")) {
          await mkdir(join(options.cwd, "dist", "assets"), { recursive: true });
          await writeFile(join(options.cwd, "dist", "index.html"), '<html><head><script src="/assets/app.js"></script></head><body></body></html>');
          await writeFile(join(options.cwd, "dist", "assets", "app.js"), 'console.log("/assets/font.woff2")');
        }
      },
    });

    expect(result.viewerUrl).toBe(`/api/wiki/slides/viewer/${result.viewerId}/`);
    expect(result.sourceHash).toBe(openSlideViewerSourceHash(files));
    expect(commands.map((command) => command.join(" "))).toEqual([
      "bun install --ignore-scripts --silent",
      "bunx tsc -p tsconfig.json --noEmit",
      "bun run build -- --out-dir dist",
    ]);
    const indexPath = await openSlideViewerFilePath(root, result.viewerId, "");
    expect(indexPath).toBeTruthy();
    const indexHtml = await readFile(indexPath!, "utf8");
    expect(indexHtml).toContain(`/api/wiki/slides/viewer/${result.viewerId}/assets/app.js`);
    expect(indexHtml).toContain("data-rlm-wiki-open-slide-router-fix");
    expect(indexHtml).toContain("rlmWikiTheme");
    expect(indexHtml).toContain('localStorage.setItem("theme",h)');
    expect(indexHtml).toContain('classList.add(h)');
    expect(indexHtml).toContain(`"/api/wiki/slides/viewer/${result.viewerId}"`);
    expect(indexHtml).toContain('"/s/viewer-demo-slides"');
    expect(indexHtml.indexOf("data-rlm-wiki-open-slide-router-fix")).toBeLessThan(indexHtml.indexOf(`src="/api/wiki/slides/viewer/${result.viewerId}/assets/app.js"`));
    const appPath = await openSlideViewerFilePath(root, result.viewerId, "assets/app.js");
    expect(await readFile(appPath!, "utf8")).toContain(`/api/wiki/slides/viewer/${result.viewerId}/assets/font.woff2`);

    const cached = await buildOpenSlideViewer({
      root,
      slidesRunId: "slides-run-1",
      files,
      commandRunner: async () => {
        throw new Error("cached build should not run commands");
      },
    });
    expect(cached.cached).toBe(true);
    const cachedHtml = await readFile(indexPath!, "utf8");
    expect(cachedHtml).toContain(`/api/wiki/slides/viewer/${result.viewerId}/assets/app.js`);
    expect(cachedHtml).not.toContain(`/api/wiki/slides/viewer/${result.viewerId}/api/wiki/slides/viewer/${result.viewerId}/assets/`);
  });

  test("rejects TypeScript-invalid viewer sources before bundling", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-slides-viewer-"));
    roots.push(root);
    const files = openSlideDeckFiles(wiki, {
      deckSource: [
        "import type { Page, SlideMeta } from '@open-slide/core';",
        "export const meta: SlideMeta = { title: 'Broken' };",
        "const Cover: Page = () => <section style={{ background }} />;",
        "export default [Cover] satisfies Page[];",
      ].join("\n"),
    });
    const commands: string[][] = [];

    await expect(buildOpenSlideViewer({
      root,
      slidesRunId: "slides-run-bad",
      files,
      commandRunner: async (command) => {
        commands.push(command);
        if (command[0] === "bunx") throw new Error("typecheck failed");
      },
    })).rejects.toThrow("typecheck failed");

    expect(commands.map((command) => command.join(" "))).toEqual([
      "bun install --ignore-scripts --silent",
      "bunx tsc -p tsconfig.json --noEmit",
    ]);
  });
});
