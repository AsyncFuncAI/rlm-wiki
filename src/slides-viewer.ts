import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { OpenSlideExportFile } from "./open-slide-export.ts";

export const WIKI_SLIDES_VIEWER_ARTIFACT_KIND = "wiki_slides_viewer";

export type OpenSlideViewerBuildResult = {
  viewerId: string;
  viewerUrl: string;
  sourceHash: string;
  outputDir: string;
  fileCount: number;
  cached: boolean;
};

export type OpenSlideCommandRunner = (
  command: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
) => Promise<void>;

export type BuildOpenSlideViewerOptions = {
  root: string;
  slidesRunId: string;
  files: OpenSlideExportFile[];
  signal?: AbortSignal;
  commandRunner?: OpenSlideCommandRunner;
};

const BUILD_TIMEOUT_MS = 120_000;
const VIEWER_ROUTE_PREFIX = "/api/wiki/slides/viewer";
const TYPECHECK_MARKER = ".grok-wiki-open-slide-typecheck-ok";
const CONTROLLED_PACKAGE_JSON = `${JSON.stringify({
  private: true,
  type: "module",
  scripts: {
    build: "open-slide build",
  },
  dependencies: {
    "@open-slide/core": "^1.4.0",
    react: "^19.0.0",
    "react-dom": "^19.0.0",
  },
  devDependencies: {
    typescript: "latest",
  },
}, null, 2)}\n`;

const CONTROLLED_TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    useDefineForClassFields: true,
    lib: ["DOM", "DOM.Iterable", "ES2022"],
    allowJs: false,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: true,
    forceConsistentCasingInFileNames: true,
    module: "ESNext",
    moduleResolution: "Bundler",
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    jsx: "react-jsx",
  },
  include: ["slides", "themes", "open-slide.config.ts"],
}, null, 2)}\n`;

const CONTROLLED_CONFIG = `import type { OpenSlideConfig } from '@open-slide/core';

const config: OpenSlideConfig = {
  build: {
    showSlideBrowser: false,
    showSlideUi: true,
    allowHtmlDownload: true,
  },
};

export default config;
`;

function safePath(value: unknown): string {
  const clean = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!clean || clean.includes("\0")) return "";
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function stripCommonRoot(files: OpenSlideExportFile[]): OpenSlideExportFile[] {
  const cleaned = files
    .map((file) => ({ path: safePath(file.path), content: String(file.content || "") }))
    .filter((file) => file.path);
  if (!cleaned.length) return [];
  const firstSegments = cleaned.map((file) => file.path.split("/")[0]).filter(Boolean);
  const commonRoot = firstSegments.length && firstSegments.every((part) => part === firstSegments[0])
    ? firstSegments[0]
    : "";
  if (!commonRoot) return cleaned;
  return cleaned
    .map((file) => ({ ...file, path: file.path.slice(commonRoot.length).replace(/^\/+/, "") }))
    .filter((file) => file.path);
}

function materializedFiles(files: OpenSlideExportFile[]): OpenSlideExportFile[] {
  const stripped = stripCommonRoot(files);
  const allowedPrefixes = ["slides/", "themes/", "assets/"];
  const materialized = stripped.filter((file) => allowedPrefixes.some((prefix) => file.path.startsWith(prefix)));
  return [
    { path: "package.json", content: CONTROLLED_PACKAGE_JSON },
    { path: "tsconfig.json", content: CONTROLLED_TSCONFIG },
    { path: "open-slide.config.ts", content: CONTROLLED_CONFIG },
    ...materialized,
  ];
}

function sourceHashFor(files: OpenSlideExportFile[]): string {
  const hash = createHash("sha256");
  const clean = materializedFiles(files).sort((left, right) => left.path.localeCompare(right.path));
  for (const file of clean) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function viewerIdFor(sourceHash: string): string {
  return `open-slide-${sourceHash.slice(0, 24)}`;
}

function slideIdForFiles(files: OpenSlideExportFile[]): string {
  const match = materializedFiles(files)
    .map((file) => file.path.match(/^slides\/([^/]+)\/index\.tsx$/)?.[1] || "")
    .find(Boolean);
  return match || "";
}

export function openSlideViewerUrl(viewerId: string): string {
  return `${VIEWER_ROUTE_PREFIX}/${encodeURIComponent(viewerId)}/`;
}

export function openSlideViewerRoot(root: string, viewerId: string): string {
  return join(root, "slide-viewers", viewerId);
}

export function openSlideViewerDistDir(root: string, viewerId: string): string {
  return join(openSlideViewerRoot(root, viewerId), "workspace", "dist");
}

export function openSlideViewerArtifactKey(slidesRunId: string, sourceHash: string): string {
  return `${slidesRunId}:${sourceHash.slice(0, 24)}`;
}

export function openSlideViewerSourceHash(files: OpenSlideExportFile[]): string {
  return sourceHashFor(files);
}

async function inferSlideIdFromWorkspace(root: string, viewerId: string): Promise<string> {
  const slidesDir = join(openSlideViewerRoot(root, viewerId), "workspace", "slides");
  try {
    const entries = await readdir(slidesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(slidesDir, entry.name, "index.tsx"))) return entry.name;
    }
  } catch {}
  return "";
}

export async function prepareOpenSlideViewerDist(root: string, viewerId: string, slideId = ""): Promise<void> {
  if (!/^open-slide-[a-f0-9]{24}$/.test(viewerId)) return;
  const distDir = openSlideViewerDistDir(root, viewerId);
  if (!existsSync(join(distDir, "index.html"))) return;
  const resolvedSlideId = slideId || await inferSlideIdFromWorkspace(root, viewerId);
  await rewriteViewerAssetPaths(distDir, viewerId);
  if (resolvedSlideId) await rewriteViewerEntryHtml(distDir, viewerId, resolvedSlideId);
}

async function writeWorkspaceFiles(workspaceDir: string, files: OpenSlideExportFile[]): Promise<number> {
  const clean = materializedFiles(files);
  if (!clean.some((file) => /^slides\/[^/]+\/index\.tsx$/.test(file.path))) {
    throw new Error("Open Slide viewer build requires a slides/<id>/index.tsx file.");
  }
  for (const file of clean) {
    const filePath = join(workspaceDir, file.path);
    const rel = relative(workspaceDir, filePath);
    if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) {
      throw new Error(`Unsafe Open Slide file path: ${file.path}`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
  }
  return clean.length;
}

function typecheckMarkerPath(workspaceRoot: string): string {
  return join(workspaceRoot, TYPECHECK_MARKER);
}

async function typecheckOpenSlideWorkspace(
  workspaceRoot: string,
  workspaceDir: string,
  sourceHash: string,
  run: OpenSlideCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  const markerPath = typecheckMarkerPath(workspaceRoot);
  if (existsSync(markerPath)) {
    const marker = await readFile(markerPath, "utf8").catch(() => "");
    if (marker.trim() === sourceHash) return;
  }
  if (!existsSync(join(workspaceDir, "node_modules"))) {
    await run(["bun", "install", "--ignore-scripts", "--silent"], {
      cwd: workspaceDir,
      signal,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  }
  await run(["bunx", "tsc", "-p", "tsconfig.json", "--noEmit"], {
    cwd: workspaceDir,
    signal,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  await writeFile(markerPath, `${sourceHash}\n`, "utf8");
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await visit(dir);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeViewerAssetPaths(source: string, viewerId: string): string {
  const prefix = `${VIEWER_ROUTE_PREFIX}/${viewerId}`;
  const protectedToken = `__GROK_WIKI_OPEN_SLIDE_ASSET_PREFIX_${viewerId.replace(/[^a-z0-9]/gi, "_")}__`;
  const repeatedPrefix = new RegExp(`(?:${escapeRegExp(prefix)}){2,}/assets/`, "g");
  return source
    .replace(repeatedPrefix, `${prefix}/assets/`)
    .replaceAll(`${prefix}/assets/`, protectedToken)
    .replaceAll("/assets/", `${prefix}/assets/`)
    .replaceAll(protectedToken, `${prefix}/assets/`);
}

async function rewriteViewerAssetPaths(distDir: string, viewerId: string): Promise<void> {
  const textExtensions = new Set([".html", ".css", ".js", ".mjs"]);
  const files = await collectFiles(distDir);
  for (const filePath of files) {
    const extension = filePath.slice(filePath.lastIndexOf("."));
    if (!textExtensions.has(extension)) continue;
    const source = await readFile(filePath, "utf8");
    const rewritten = normalizeViewerAssetPaths(source, viewerId);
    if (rewritten !== source) await writeFile(filePath, rewritten, "utf8");
  }
}

async function rewriteViewerEntryHtml(distDir: string, viewerId: string, slideId: string): Promise<void> {
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath)) return;
  const marker = "data-grok-wiki-open-slide-router-fix";
  const source = await readFile(indexPath, "utf8");
  const prefix = `${VIEWER_ROUTE_PREFIX}/${viewerId}`;
  const targetPath = `/s/${encodeURIComponent(slideId)}`;
  const bootScript = `<script ${marker}>(()=>{const p=${JSON.stringify(prefix)};const t=${JSON.stringify(targetPath)};const q=new URLSearchParams(location.search);const m=q.get("grokWikiTheme");const h=m==="light"||m==="dark"?m:"";if(h){try{localStorage.setItem("theme",h)}catch{}document.documentElement.classList.remove("light","dark");document.documentElement.classList.add(h);document.documentElement.style.colorScheme=h}if(location.pathname===p||location.pathname.startsWith(p+"/"))history.replaceState(null,"",t+location.search+location.hash);})();</script>`;
  const withoutOldFix = source.replace(new RegExp(`<script ${marker}>[\\s\\S]*?<\\/script>`, "g"), "");
  let rewritten = `${bootScript}${withoutOldFix}`;
  if (/<head[^>]*>/i.test(withoutOldFix)) {
    rewritten = withoutOldFix.replace(/<head([^>]*)>/i, `<head$1>${bootScript}`);
  } else if (withoutOldFix.includes("</head>")) {
    rewritten = withoutOldFix.replace("</head>", `${bootScript}</head>`);
  }
  await writeFile(indexPath, rewritten, "utf8");
}

async function defaultCommandRunner(
  command: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, CI: "1", OPEN_SLIDE_SKIP_SKILLS_CHECK: "1" },
  });
  const onAbort = () => proc.kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (options.signal?.aborted) throw new Error("Open Slide viewer build was canceled.");
    if (exitCode !== 0) {
      const output = `${stdout}\n${stderr}`.trim().slice(-4000);
      throw new Error(`Open Slide command failed: ${command.join(" ")}\n${output}`);
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function buildOpenSlideViewer(options: BuildOpenSlideViewerOptions): Promise<OpenSlideViewerBuildResult> {
  if (!options.files.length) throw new Error("Open Slide viewer build requires slide files.");
  const sourceHash = sourceHashFor(options.files);
  const viewerId = viewerIdFor(sourceHash);
  const slideId = slideIdForFiles(options.files);
  if (!slideId) throw new Error("Open Slide viewer build requires a slides/<id>/index.tsx file.");
  const workspaceRoot = openSlideViewerRoot(options.root, viewerId);
  const workspaceDir = join(workspaceRoot, "workspace");
  const distDir = join(workspaceDir, "dist");
  const indexPath = join(distDir, "index.html");
  const run = options.commandRunner ?? defaultCommandRunner;
  if (existsSync(indexPath)) {
    await typecheckOpenSlideWorkspace(workspaceRoot, workspaceDir, sourceHash, run, options.signal);
    await prepareOpenSlideViewerDist(options.root, viewerId, slideId);
    return {
      viewerId,
      viewerUrl: openSlideViewerUrl(viewerId),
      sourceHash,
      outputDir: distDir,
      fileCount: 0,
      cached: true,
    };
  }

  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  const fileCount = await writeWorkspaceFiles(workspaceDir, options.files);
  await typecheckOpenSlideWorkspace(workspaceRoot, workspaceDir, sourceHash, run, options.signal);
  await run(["bun", "run", "build", "--", "--out-dir", "dist"], {
    cwd: workspaceDir,
    signal: options.signal,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (!existsSync(indexPath)) throw new Error("Open Slide build finished without dist/index.html.");
  await prepareOpenSlideViewerDist(options.root, viewerId, slideId);
  return {
    viewerId,
    viewerUrl: openSlideViewerUrl(viewerId),
    sourceHash,
    outputDir: distDir,
    fileCount,
    cached: false,
  };
}

export async function openSlideViewerFilePath(
  root: string,
  viewerId: string,
  requestPath: string,
): Promise<string | null> {
  if (!/^open-slide-[a-f0-9]{24}$/.test(viewerId)) return null;
  const distDir = openSlideViewerDistDir(root, viewerId);
  const clean = safePath(requestPath) || "index.html";
  const candidate = join(distDir, clean);
  const rel = relative(distDir, candidate);
  if (rel.startsWith("..") || rel.startsWith("/") || rel === "") return null;
  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
    if (info.isDirectory()) {
      const indexPath = join(candidate, "index.html");
      return existsSync(indexPath) ? indexPath : null;
    }
  } catch {
    if (!clean.includes(".")) {
      const indexPath = join(distDir, "index.html");
      return existsSync(indexPath) ? indexPath : null;
    }
  }
  return null;
}

export function openSlideViewerContentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
