import "../src/ui/styles.css";
import "./public-wiki.css";
import {
  normalizeCodeLanguage,
  renderCodeLines,
  renderMarkdownBlocks,
} from "../src/ui/markdown-renderer.ts";
import {
  isDocumentationWiki,
  renderWikiReader,
  resolveDocsPageLink,
  wikiPages,
  type WikiRecord,
  type WikiWorkspaceState,
} from "../src/ui/wiki-workspace.ts";
import { publicAgentPrompt } from "../src/public-agent-prompt.ts";

type PublicWikiResponse = {
  wiki: WikiRecord;
  publication: Record<string, any>;
};

type BeautifulMermaidModule = {
  renderMermaidSVG?: (source: string, theme: Record<string, unknown>) => string;
  THEMES?: Record<string, Record<string, unknown>>;
};

let currentWiki: WikiRecord | null = null;
let currentPublication: Record<string, any> | null = null;
let activePageId = "";
let readerMode = readReaderMode();
let diagramZoom: { code: string; lang: string; zoom: number } | null = null;
let beautifulMermaidPromise: Promise<BeautifulMermaidModule | null> | null = null;
let publicTheme = readPublicTheme();
let agentPopoverOpen = false;
let agentPopoverReturnFocus: HTMLElement | null = null;
let agentPromptCopyResetTimer = 0;
const codeViewerCopyResetTimers = new WeakMap<HTMLElement, number>();

const root = document.getElementById("public-wiki-root");
const beautifulMermaidUrl = "https://esm.sh/beautiful-mermaid@1.1.3/es2022/beautiful-mermaid.bundle.mjs";
const beautifulMermaidTheme = {
  bg: "var(--mermaid-bg)",
  fg: "var(--mermaid-fg)",
  line: "var(--mermaid-line)",
  accent: "var(--mermaid-accent)",
  muted: "var(--mermaid-muted)",
  surface: "var(--mermaid-surface)",
  border: "var(--mermaid-border)",
  transparent: true,
};

applyPublicTheme(publicTheme);
void loadPublicWiki();

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (handlePublicAgentClick(event, target)) return;
  if (handleDiagramZoomClick(event, target)) return;
  const themeButton = target.closest<HTMLElement>("[data-public-theme-toggle]");
  if (themeButton) {
    event.preventDefault();
    togglePublicTheme();
    return;
  }
  const codeCopyButton = target.closest<HTMLElement>("[data-code-viewer-copy]");
  if (codeCopyButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void copyCodeViewer(codeCopyButton);
    return;
  }
  if (!currentWiki) return;
  if (handleDiagramOpenClick(event, target)) return;

  const docsKitTab = target.closest<HTMLElement>("[data-doc-tab]");
  if (docsKitTab) {
    event.preventDefault();
    event.stopImmediatePropagation();
    activateDocsKitTab(docsKitTab);
    return;
  }

  const modeButton = target.closest<HTMLElement>("[data-wiki-reader-mode]");
  if (modeButton) {
    event.preventDefault();
    readerMode = modeButton.dataset.wikiReaderMode === "paged" ? "paged" : "continuous";
    localStorage.setItem("rlm-wiki-public:reader-mode", readerMode);
    render();
    return;
  }

  const scrollButton = target.closest<HTMLElement>("[data-wiki-scroll-page]");
  if (scrollButton) {
    event.preventDefault();
    const pageId = scrollButton.dataset.wikiScrollPage || "";
    activePageId = pageId || activePageId;
    document.getElementById(`wiki-page-${CSS.escape(pageId)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    updateOutline();
    return;
  }

  const pageButton = target.closest<HTMLElement>("[data-wiki-page]");
  if (pageButton) {
    event.preventDefault();
    activePageId = pageButton.dataset.wikiPage || activePageId;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (agentPopoverOpen && event.key === "Escape") {
    event.preventDefault();
    closePublicAgentPopover();
    return;
  }

  if (diagramZoom) {
    const key = event.key;
    const code = event.code;
    if (key === "Escape") {
      event.preventDefault();
      closeDiagramZoom();
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    if (key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd") {
      event.preventDefault();
      setDiagramZoom(0.15);
      return;
    }
    if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") {
      event.preventDefault();
      setDiagramZoom(-0.15);
      return;
    }
    if (key === "0" || code === "Digit0" || code === "Numpad0") {
      event.preventDefault();
      resetDiagramZoom();
    }
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(".diagram-zoom-layer")) return;
  const docsKitTab = target.closest<HTMLElement>("[data-doc-tab]");
  if (docsKitTab && handleDocsKitTabKeydown(event, docsKitTab)) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  const mermaid = target.closest<HTMLElement>(".desktop-mermaid-zoomable[data-diagram-code]");
  if (!mermaid || document.activeElement !== mermaid) return;
  openDiagramZoom(event, mermaid, "mermaid");
});

document.addEventListener(
  "wheel",
  (event) => {
    if (!diagramZoom || !(event.metaKey || event.ctrlKey)) return;
    if (!document.querySelector(".diagram-zoom-layer")) return;
    event.preventDefault();
    setDiagramZoom(event.deltaY < 0 ? 0.15 : -0.15);
  },
  { capture: true, passive: false },
);

async function loadPublicWiki(): Promise<void> {
  try {
    const publicId = publicIdFromPath();
    if (!publicId) throw new Error("Public wiki link is missing.");
    const response = await fetch(`/api/public/wiki/${encodeURIComponent(publicId)}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json().catch(() => ({})) as Partial<PublicWikiResponse> & { error?: string };
    if (!response.ok || !data.wiki) throw new Error(data.error || `Could not load public wiki (${response.status}).`);
    currentWiki = data.wiki;
    currentPublication = data.publication || null;
    activePageId = wikiPages(currentWiki)[0]?.id || "";
    const docs = isDocumentationWiki(currentWiki) || publicSurfaceFromPath() === "docs";
    document.title = `${currentWiki.structure?.title || (docs ? "Public Docs" : "Public Wiki")} · ${docs ? "Docs" : "rlm-wiki"}`;
    render();
  } catch (error) {
    if (!root) return;
    root.innerHTML = `<div class="public-wiki-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function render(): void {
  if (!root || !currentWiki) return;
  const privateLink = currentPublication?.visibility === "private";
  const docs = currentPublicSurface() === "docs";
  const publicId = String(currentPublication?.publicId || publicIdFromPath());
  const repoUrl = githubRepoUrl(currentWiki);
  const repoLabel = githubRepoLabel(repoUrl, currentWiki);
  const exportUrl = publicWikiExportUrl(publicId);
  const state: WikiWorkspaceState = {
    activeWiki: currentWiki,
    activeWikiPageId: activePageId,
    wikiGenerating: false,
    wikiProgress: null,
    wikiRuns: [],
    wikiSearch: "",
    wikiSort: "updated",
    wikiSourcesInput: "",
    wikiStyle: String(currentWiki.wikiStyle || "technical"),
    wikiPageCount: wikiPages(currentWiki).length,
    wikiReaderMode: readerMode,
    wikiViewMode: "grid",
    wikiPublication: currentPublication,
    wikiReadOnly: true,
    workspaceKind: docs ? "docs" : "wiki",
    wikis: [currentWiki],
  };
  root.innerHTML = `
    <header class="public-wiki-topbar ${docs ? "public-docs-topbar" : ""}">
      <a class="public-wiki-brand" href="/">
        <strong>${docs ? "Docs" : "rlm-wiki"}</strong>
        <span>${escapeHtml(currentWiki.structure?.title || (docs ? "Public docs" : "Public wiki"))}</span>
      </a>
      <nav class="public-wiki-actions" aria-label="${docs ? "Public docs" : "Public wiki"} links">
        ${renderPublicThemeToggle()}
        ${renderPublicAgentButton()}
        ${repoUrl ? `<a class="public-wiki-cta public-wiki-repo-pill" href="${escapeHtml(repoUrl)}" target="_blank" rel="noreferrer" title="Open ${escapeHtml(repoLabel)} on GitHub" aria-label="Open ${escapeHtml(repoLabel)} on GitHub">${brandIcon("github")}<span>${escapeHtml(repoLabel)}</span></a>` : ""}
        ${publicId ? `<a class="public-wiki-cta public-wiki-obsidian-pill" href="${escapeHtml(exportUrl)}" download data-no-router="true" title="Download Obsidian Markdown ZIP" aria-label="Download Obsidian Markdown ZIP">${brandIcon("obsidian")}<span>Obsidian ZIP</span></a>` : ""}
        ${privateLink ? `<span class="public-wiki-private-badge">${icon("lock")}Private link</span>` : `<a class="public-wiki-cta" href="${docs ? "/public/docs" : "/public/wikis"}">Gallery</a>`}
      </nav>
    </header>
    <main class="public-wiki-reader">
      ${renderWikiReader(currentWiki, state, deps)}
    </main>
  `;
  void renderPublicMermaids(root);
  syncActivePageFromScroll();
  renderDiagramZoomOverlay();
}

function githubRepoUrl(wiki: WikiRecord): string {
  const candidates = [
    String(wiki.repoUrl || ""),
    ...((Array.isArray((wiki as any).repos) ? (wiki as any).repos : []) as Array<{ url?: string }>).map((repo) => String(repo?.url || "")),
  ];
  for (const candidate of candidates) {
    const clean = candidate.trim().replace(/\/$/, "");
    if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/i.test(clean)) return clean;
  }
  return "";
}

function githubRepoLabel(url: string, wiki: WikiRecord): string {
  const match = String(url || "").match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  return `${wiki.owner || "github"}/${wiki.repo || "repo"}`;
}

function publicWikiExportUrl(publicId: string): string {
  return `/api/public/wiki-export?id=${encodeURIComponent(publicId)}`;
}

function renderPublicAgentButton(): string {
  return `
    <button
      class="public-wiki-cta public-wiki-agent-button"
      type="button"
      data-public-agent-open
      aria-haspopup="dialog"
      aria-expanded="${agentPopoverOpen ? "true" : "false"}"
      title="Copy an agent handoff prompt"
    >
      ${icon("plus")}
      <span>Add Agent</span>
    </button>
  `;
}

function renderPublicThemeToggle(): string {
  const next = publicTheme === "light" ? "dark" : "light";
  return `
    <button
      class="public-theme-toggle"
      type="button"
      data-public-theme-toggle
      aria-label="Switch to ${next} mode"
      title="Switch to ${next} mode"
    >
      <span class="public-theme-toggle-track" aria-hidden="true">
        ${icon("sun", "public-theme-icon public-theme-sun")}
        ${icon("moon", "public-theme-icon public-theme-moon")}
      </span>
    </button>
  `;
}

function togglePublicTheme(): void {
  publicTheme = publicTheme === "light" ? "dark" : "light";
  localStorage.setItem("rlm-wiki-public:theme", publicTheme);
  applyPublicTheme(publicTheme);
  syncPublicThemeToggle();
}

function applyPublicTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.publicTheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f7f5" : "#08090a");
}

function syncPublicThemeToggle(): void {
  const button = root?.querySelector<HTMLElement>("[data-public-theme-toggle]");
  if (!button) return;
  const next = publicTheme === "light" ? "dark" : "light";
  button.setAttribute("aria-label", `Switch to ${next} mode`);
  button.setAttribute("title", `Switch to ${next} mode`);
}

function handlePublicAgentClick(event: MouseEvent, target: Element): boolean {
  const openButton = target.closest<HTMLElement>("[data-public-agent-open]");
  if (openButton) {
    event.preventDefault();
    openPublicAgentPopover(openButton);
    return true;
  }

  const layer = target.closest<HTMLElement>("[data-public-agent-layer]");
  if (!layer) return false;

  const copyButton = target.closest<HTMLElement>("[data-public-agent-copy]");
  if (copyButton) {
    event.preventDefault();
    void copyPublicAgentPrompt(copyButton);
    return true;
  }

  if (target.closest("[data-public-agent-close]") || target === layer) {
    event.preventDefault();
    closePublicAgentPopover();
    return true;
  }

  return true;
}

function openPublicAgentPopover(trigger: HTMLElement): void {
  if (!currentWiki) return;
  agentPopoverOpen = true;
  agentPopoverReturnFocus = trigger;
  trigger.setAttribute("aria-expanded", "true");
  renderPublicAgentPopover(true);
}

function closePublicAgentPopover(): void {
  if (!agentPopoverOpen) return;
  agentPopoverOpen = false;
  window.clearTimeout(agentPromptCopyResetTimer);
  agentPromptCopyResetTimer = 0;
  root?.querySelector<HTMLElement>("[data-public-agent-open]")?.setAttribute("aria-expanded", "false");
  const host = publicAgentPopoverHost();
  if (host) host.innerHTML = "";
  const returnTarget = agentPopoverReturnFocus;
  agentPopoverReturnFocus = null;
  returnTarget?.focus({ preventScroll: true });
}

function renderPublicAgentPopover(focus = false): void {
  const host = publicAgentPopoverHost();
  if (!host || !currentWiki) return;
  const docs = currentPublicSurface() === "docs";
  const prompt = publicAgentPrompt(publicAgentPromptInput());
  host.innerHTML = `
    <div class="public-agent-layer" data-public-agent-layer>
      <section class="public-agent-popover" role="dialog" aria-modal="true" aria-labelledby="public-agent-title" aria-describedby="public-agent-description">
        <button class="public-agent-close" type="button" data-public-agent-close aria-label="Close">${icon("x")}</button>
        <div class="public-agent-kicker">Works with any coding agent</div>
        <h2 id="public-agent-title">Bring your agent into ${docs ? "these docs" : "this wiki"}</h2>
        <p id="public-agent-description">Copy one prompt that tells your agent to read the compact index first, fetch full context only if needed, and stay grounded in ${docs ? "these docs" : "this wiki"}.</p>
        <pre class="public-agent-prompt" tabindex="0"><code data-public-agent-prompt>${escapeHtml(prompt)}</code></pre>
        <p class="public-agent-note">The prompt is vendor-agnostic. It points agents at <code>llms.txt</code> first so they can load the smallest useful context before using the full Markdown ${docs ? "docs" : "wiki"}.</p>
        <button class="public-agent-copy" type="button" data-public-agent-copy>Copy for agent</button>
        <button class="public-agent-skip" type="button" data-public-agent-close>Close</button>
      </section>
    </div>
  `;
  if (focus) {
    requestAnimationFrame(() => host.querySelector<HTMLElement>("[data-public-agent-copy]")?.focus());
  }
}

function publicAgentPopoverHost(): HTMLElement | null {
  let host = document.getElementById("public-agent-popover-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "public-agent-popover-root";
    document.body.appendChild(host);
  }
  return host;
}

function publicAgentPromptInput(): Parameters<typeof publicAgentPrompt>[0] {
  const wiki = currentWiki;
  const publicId = String(currentPublication?.publicId || publicIdFromPath());
  const visibility = currentPublication?.visibility === "private" ? "private" : "public";
  const surface = currentPublicSurface();
  const canonicalPath = `/${visibility === "private" ? "share" : "public"}/${surface}/${encodeURIComponent(publicId)}`;
  const pageUrl = `${window.location.origin}${canonicalPath}`;
  const repoUrl = wiki ? githubRepoUrl(wiki) : "";
  return {
    artifactLabel: surface,
    title: wiki?.structure?.title || (surface === "docs" ? "Docs" : "rlm-wiki"),
    description: wiki?.structure?.description || "",
    pageUrl,
    llmsUrl: `${pageUrl}/llms.txt`,
    llmsFullUrl: `${pageUrl}/llms-full.txt`,
    markdownUrl: `${pageUrl}.md`,
    repository: wiki ? githubRepoLabel(repoUrl, wiki) : "",
    repoUrl,
    branch: wiki?.branch || "",
    pageCount: wiki ? wikiPages(wiki).length : 0,
    generatedAt: wiki?.generatedAt || "",
    updatedAt: String(currentPublication?.updatedAt || ""),
  };
}

async function copyPublicAgentPrompt(button: HTMLElement): Promise<void> {
  const prompt = publicAgentPopoverHost()?.querySelector<HTMLElement>("[data-public-agent-prompt]")?.textContent || "";
  if (!prompt.trim()) return;
  try {
    await copyText(prompt);
    markPublicAgentCopyButton(button, "Copied", "copied");
  } catch {
    selectPublicAgentPrompt();
    markPublicAgentCopyButton(button, "Prompt selected", "selected");
  }
}

function markPublicAgentCopyButton(button: HTMLElement, label: string, state: "copied" | "selected"): void {
  const previous = button.dataset.defaultLabel || button.textContent || "Copy for agent";
  button.dataset.defaultLabel = previous;
  button.textContent = label;
  button.dataset.copyState = state;
  window.clearTimeout(agentPromptCopyResetTimer);
  agentPromptCopyResetTimer = window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || "Copy for agent";
    delete button.dataset.copyState;
  }, 1600);
}

function selectPublicAgentPrompt(): void {
  const prompt = publicAgentPopoverHost()?.querySelector<HTMLElement>("[data-public-agent-prompt]");
  if (!prompt) return;
  const range = document.createRange();
  range.selectNodeContents(prompt);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  prompt.closest<HTMLElement>(".public-agent-prompt")?.focus({ preventScroll: true });
}

async function copyText(text: string): Promise<void> {
  let clipboardError: unknown = null;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    if (!document.execCommand("copy")) throw clipboardError || new Error("Copy command failed.");
  } finally {
    textarea.remove();
  }
}

function codeViewerCopyText(button: HTMLElement): string {
  const viewer = button.closest<HTMLElement>(".code-viewer");
  if (!viewer) return "";
  const encoded = viewer.dataset.codeViewerCopyCode || viewer.dataset.codeFull || "";
  if (encoded) return safeDecode(encoded);
  return viewer.querySelector<HTMLElement>("pre code")?.textContent || "";
}

async function copyCodeViewer(button: HTMLElement): Promise<void> {
  const code = codeViewerCopyText(button);
  if (!code.length) return;
  try {
    await copyText(code);
    markCodeViewerCopyButton(button, "Copied", "copied");
  } catch {
    markCodeViewerCopyButton(button, "Copy failed", "failed");
  }
}

function markCodeViewerCopyButton(button: HTMLElement, label: string, state: "copied" | "failed"): void {
  const defaultLabel = button.dataset.defaultLabel || button.getAttribute("aria-label") || "Copy code";
  button.dataset.defaultLabel = defaultLabel;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.classList.toggle("copied", state === "copied");
  button.classList.toggle("failed", state === "failed");
  const existingTimer = codeViewerCopyResetTimers.get(button);
  if (existingTimer) window.clearTimeout(existingTimer);
  codeViewerCopyResetTimers.set(
    button,
    window.setTimeout(() => {
      button.setAttribute("aria-label", defaultLabel);
      button.setAttribute("title", defaultLabel);
      button.classList.remove("copied", "failed");
      codeViewerCopyResetTimers.delete(button);
    }, 1400),
  );
}

function handleDiagramOpenClick(event: MouseEvent, target: Element): boolean {
  if (target.closest(".diagram-zoom-layer")) return false;
  const mermaid = target.closest<HTMLElement>(".desktop-mermaid-zoomable[data-diagram-code]");
  if (mermaid) {
    openDiagramZoom(event, mermaid, "mermaid");
    return true;
  }

  const trigger = target.closest<HTMLElement>("[data-diagram-zoom], .diagram-code-viewer[data-diagram-code]");
  if (!trigger) return false;
  const element = trigger.closest<HTMLElement>("[data-diagram-code]");
  if (!element) return false;
  openDiagramZoom(event, element, element.dataset.diagramLang || "text");
  return true;
}

function handleDiagramZoomClick(event: MouseEvent, target: Element): boolean {
  const layer = target.closest<HTMLElement>(".diagram-zoom-layer");
  if (!layer) return false;

  const stepButton = target.closest<HTMLElement>("[data-diagram-zoom-step]");
  if (stepButton) {
    event.preventDefault();
    setDiagramZoom(Number(stepButton.dataset.diagramZoomStep) || 0);
    return true;
  }

  if (target.closest("[data-diagram-zoom-reset]")) {
    event.preventDefault();
    resetDiagramZoom();
    return true;
  }

  if (target.closest("[data-diagram-close-button]") || target === layer) {
    event.preventDefault();
    closeDiagramZoom();
    return true;
  }

  return false;
}

function openDiagramZoom(event: Event, element: HTMLElement, fallbackLang: string): void {
  if (!(element.matches("[data-diagram-zoom]") || (event.target as Element | null)?.closest?.("[data-diagram-zoom]"))) {
    const selectedText = window.getSelection?.()?.toString();
    if (selectedText) return;
  }
  event.preventDefault();
  event.stopPropagation();
  const encodedCode = element.dataset.diagramCode || element.dataset.mermaidSource || "";
  const code = safeDecode(encodedCode);
  if (!code.trim()) return;
  diagramZoom = {
    code,
    lang: element.dataset.diagramLang || fallbackLang || "text",
    zoom: 1,
  };
  renderDiagramZoomOverlay(true);
}

function closeDiagramZoom(): void {
  diagramZoom = null;
  renderDiagramZoomOverlay();
}

function setDiagramZoom(delta: number): void {
  if (!diagramZoom) return;
  diagramZoom = {
    ...diagramZoom,
    zoom: clampNumber((Number(diagramZoom.zoom) || 1) + delta, 0.5, 3.5),
  };
  applyDiagramZoom();
}

function resetDiagramZoom(): void {
  if (!diagramZoom) return;
  diagramZoom = { ...diagramZoom, zoom: 1 };
  applyDiagramZoom();
}

function applyDiagramZoom(): void {
  if (!diagramZoom) return;
  const value = clampNumber(Number(diagramZoom.zoom) || 1, 0.5, 3.5);
  document.querySelector<HTMLElement>(".diagram-zoom-scroll")?.style.setProperty("--diagram-zoom", String(value));
  const label = document.querySelector<HTMLElement>("[data-diagram-zoom-reset]");
  if (label) label.textContent = `${Math.round(value * 100)}%`;
}

function renderDiagramZoomOverlay(focus = false): void {
  const host = diagramOverlayHost();
  if (!host) return;
  host.innerHTML = diagramZoom ? renderDiagramZoom() : "";
  if (!diagramZoom) return;
  void renderPublicMermaids(host);
  if (focus) requestAnimationFrame(() => host.querySelector<HTMLElement>(".diagram-zoom-scroll")?.focus());
}

function diagramOverlayHost(): HTMLElement | null {
  let host = document.getElementById("public-diagram-zoom-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "public-diagram-zoom-root";
    document.body.appendChild(host);
  }
  return host;
}

function hydrateDocsKitTabPanel(panel: Element): void {
  if (!(panel instanceof HTMLElement) || panel.dataset.docTabLazy !== "1") return;
  const body = safeDecode(panel.dataset.docTabBody || "");
  panel.innerHTML = deps.markdown(body, publicDocsMarkdownContext());
  delete panel.dataset.docTabLazy;
  delete panel.dataset.docTabBody;
  delete panel.dataset.docTabLinkSources;
  void renderPublicMermaids(panel);
}

function publicDocsMarkdownContext(): {
  compactSourceCitations: boolean;
  resolveDocsPageHref?: (href: string, title: string, description: string) => string | null;
} {
  if (!currentWiki || currentPublicSurface() !== "docs") return { compactSourceCitations: true };
  return {
    compactSourceCitations: true,
    resolveDocsPageHref: (href, label, description) =>
      resolveDocsPageLink(currentWiki, href, label) || resolveDocsPageLink(currentWiki, href, description),
  };
}

function activateDocsKitTab(tab: Element, focus = true): void {
  const rootNode = tab.closest("[data-doc-tabs]");
  if (!rootNode || !(tab instanceof HTMLElement)) return;
  const selectedIndex = tab.dataset.docTabIndex || "0";
  rootNode.querySelectorAll<HTMLElement>("[data-doc-tab]").forEach((button) => {
    const active = button.dataset.docTabIndex === selectedIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  rootNode.querySelectorAll<HTMLElement>("[data-doc-tab-panel]").forEach((panel) => {
    const active = panel.dataset.docTabIndex === selectedIndex;
    if (active) hydrateDocsKitTabPanel(panel);
    panel.toggleAttribute("hidden", !active);
  });
  if (focus) tab.focus({ preventScroll: true });
}

function handleDocsKitTabKeydown(event: KeyboardEvent, tab: HTMLElement): boolean {
  const rootNode = tab.closest("[data-doc-tabs]");
  if (!rootNode) return false;
  const tabs = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-doc-tab]"));
  const currentIndex = tabs.indexOf(tab);
  if (currentIndex < 0) return false;

  let nextIndex = currentIndex;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else if (event.key === "Enter" || event.key === " ") nextIndex = currentIndex;
  else return false;

  event.preventDefault();
  event.stopImmediatePropagation();
  activateDocsKitTab(tabs[nextIndex]);
  return true;
}

function renderDiagramZoom(): string {
  const zoom = clampNumber(Number(diagramZoom?.zoom) || 1, 0.5, 3.5);
  const language = normalizeCodeLanguage(diagramZoom?.lang || "text");
  const code = diagramZoom?.code || "";
  const isMermaid = language === "mermaid";
  const content = isMermaid
    ? `<div class="diagram-zoom-mermaid mermaid desktop-mermaid mermaid-loading" data-mermaid-source="${escapeHtml(safeEncode(code))}" data-diagram-lang="mermaid">${escapeHtml(code)}</div>`
    : `<pre><code>${renderCodeLines(code, language, false, escapeHtml)}</code></pre>`;
  return `
    <div class="diagram-zoom-layer" data-diagram-close>
      <section class="diagram-zoom-popover ${isMermaid ? "diagram-zoom-popover-mermaid" : ""}" role="dialog" aria-modal="true" aria-label="Diagram zoom">
        <header class="diagram-zoom-head">
          <div>
            <span>Diagram</span>
            <strong>${escapeHtml(language)}</strong>
          </div>
          <div class="diagram-zoom-controls">
            <button class="diagram-zoom-control" type="button" data-diagram-zoom-step="-0.15" aria-label="Zoom out" title="Cmd -">-</button>
            <button class="diagram-zoom-reset" type="button" data-diagram-zoom-reset title="Cmd 0">${Math.round(zoom * 100)}%</button>
            <button class="diagram-zoom-control" type="button" data-diagram-zoom-step="0.15" aria-label="Zoom in" title="Cmd +">+</button>
            <button class="diagram-zoom-close" type="button" data-diagram-close-button aria-label="Close">${icon("x")}</button>
          </div>
        </header>
        <div class="diagram-zoom-scroll" tabindex="0" style="--diagram-zoom: ${zoom}">
          <div class="diagram-zoom-canvas">
            ${content}
          </div>
        </div>
      </section>
    </div>
  `;
}

function syncActivePageFromScroll(): void {
  if (readerMode !== "continuous") return;
  const reader = root?.querySelector<HTMLElement>(".wiki-reader-main");
  if (!reader) return;
  const sections = Array.from(reader.querySelectorAll<HTMLElement>("[data-wiki-page-section]"));
  if (!sections.length) return;
  const onScroll = () => {
    const readerTop = reader.getBoundingClientRect().top;
    const active = sections
      .map((section) => ({ section, distance: Math.abs(section.getBoundingClientRect().top - readerTop - 36) }))
      .sort((left, right) => left.distance - right.distance)[0]?.section;
    const nextId = active?.dataset.wikiPageSection || activePageId;
    if (nextId && nextId !== activePageId) {
      activePageId = nextId;
      updateOutline();
    }
  };
  reader.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function updateOutline(): void {
  root?.querySelectorAll<HTMLElement>("[data-wiki-scroll-page], [data-wiki-page]").forEach((button) => {
    const pageId = button.dataset.wikiScrollPage || button.dataset.wikiPage || "";
    button.classList.toggle("active", pageId === activePageId);
    if (button.getAttribute("role") === "radio") {
      button.setAttribute("aria-checked", pageId === activePageId ? "true" : "false");
    }
  });
}

const deps = {
  escape: escapeHtml,
  icon,
  modelLogo: () => "",
  markdown(value: string, context?: { compactSourceCitations?: boolean; resolveDocsPageHref?: (href: string, title: string, description: string) => string | null }) {
    return renderMarkdownBlocks(String(value || ""), true, null, {
      escape: escapeHtml,
      sourceTextLabel: (source) => source,
      sourceLink: sourceLink,
      isSourceReference: (source) => /^[A-Za-z0-9._/-]+(?::\d+(?:-\d+)?)?$/.test(source),
      renderMermaidBlock: renderMermaidBlock,
      icon,
      compactSourceCitations: context?.compactSourceCitations !== false,
      resolveMediaSrc: resolvePublicMediaSrc,
      resolveDocsPageHref: context?.resolveDocsPageHref,
    });
  },
  renderLocalCliControl: () => "",
  renderLegacyModeControl: () => "",
  renderRuntimeControl: () => "",
  scopeLabel: (value: string) => value,
  splitScopeText: (value: string) => value.split("\n").filter(Boolean),
  scopeWithBranch: (value: string, branch: string) => `${value}@${branch}`,
};

function publicIdFromPath(): string {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return (parts[0] === "public" || parts[0] === "share") && (parts[1] === "wiki" || parts[1] === "docs") ? decodeURIComponent(parts[2] || "") : "";
}

function publicSurfaceFromPath(): "wiki" | "docs" {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts[1] === "docs" ? "docs" : "wiki";
}

function currentPublicSurface(): "wiki" | "docs" {
  return currentWiki && (isDocumentationWiki(currentWiki) || publicSurfaceFromPath() === "docs") ? "docs" : "wiki";
}

function readReaderMode(): "continuous" | "paged" {
  return localStorage.getItem("rlm-wiki-public:reader-mode") === "paged" ? "paged" : "continuous";
}

function readPublicTheme(): "dark" | "light" {
  return localStorage.getItem("rlm-wiki-public:theme") === "light" ? "light" : "dark";
}

function renderMermaidBlock(code: string): string {
  const encoded = safeEncode(code);
  return `<div class="mermaid desktop-mermaid mermaid-loading" data-mermaid-source="${escapeHtml(encoded)}" data-diagram-code="${escapeHtml(encoded)}" data-diagram-lang="mermaid" tabindex="0" aria-label="Mermaid diagram">${escapeHtml(code)}</div>`;
}

async function renderPublicMermaids(container: ParentNode): Promise<void> {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(".mermaid")).filter(
    (node) =>
      node.isConnected &&
      node.dataset.mermaidRendered !== "1" &&
      node.dataset.mermaidRendering !== "1",
  );
  if (!nodes.length) return;
  nodes.forEach((node) => {
    node.dataset.mermaidRendering = "1";
  });

  const beautifulMermaid = await loadBeautifulMermaid();
  if (!beautifulMermaid?.renderMermaidSVG) {
    nodes.forEach((node) => {
      delete node.dataset.mermaidRendering;
      node.classList.remove("mermaid-loading");
      node.classList.add("mermaid-error");
    });
    return;
  }

  const theme = {
    ...(beautifulMermaid.THEMES?.["zinc-light"] || beautifulMermaidTheme),
    ...beautifulMermaidTheme,
  };
  nodes.forEach((node) => {
    const source = safeDecode(node.dataset.mermaidSource || "") || node.textContent || "";
    if (!source.trim()) {
      delete node.dataset.mermaidRendering;
      return;
    }
    try {
      node.innerHTML = beautifulMermaid.renderMermaidSVG?.(source, theme) || escapeHtml(source);
      node.dataset.mermaidRenderer = "beautiful-mermaid";
      node.dataset.mermaidRendered = "1";
      node.dataset.diagramCode = safeEncode(source);
      node.dataset.diagramLang = "mermaid";
      node.classList.remove("mermaid-loading", "mermaid-error");
      node.classList.add("beautiful-mermaid", "desktop-mermaid-zoomable");
    } catch {
      node.textContent = source;
      node.classList.remove("mermaid-loading");
      node.classList.add("mermaid-error");
    } finally {
      delete node.dataset.mermaidRendering;
    }
  });
}

function loadBeautifulMermaid(): Promise<BeautifulMermaidModule | null> {
  if (!beautifulMermaidPromise) {
    beautifulMermaidPromise = import(/* @vite-ignore */ beautifulMermaidUrl)
      .then((module) => {
        const candidate = module as BeautifulMermaidModule & { default?: BeautifulMermaidModule };
        return candidate.renderMermaidSVG ? candidate : candidate.default || null;
      })
      .catch((error) => {
        console.warn("beautiful-mermaid unavailable; keeping Mermaid source visible.", error);
        return null;
      });
  }
  return beautifulMermaidPromise;
}

function sourceLink(label: string, ref: string): string {
  const wiki = currentWiki;
  const source = String(ref || label || "").replace(/^`|`$/g, "");
  const match = source.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/);
  const file = match?.[1] || source;
  const line = match?.[2] ? `#L${match[2]}` : "";
  const branch = encodeURIComponent(String(wiki?.branch || "HEAD"));
  const repoUrl = String(wiki?.repoUrl || "");
  const href = repoUrl.startsWith("https://github.com/")
    ? `${repoUrl.replace(/\/$/, "")}/blob/${branch}/${file.split("/").map(encodeURIComponent).join("/")}${line}`
    : "";
  return href
    ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<code>${escapeHtml(label)}</code>`;
}

function resolvePublicMediaSrc(src: string): string {
  const value = String(src || "").trim();
  if (!value || /^javascript:/i.test(value)) return "";
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(value)) return value;
  if (value.includes("\\") || value.split(/[?#]/, 1)[0].split("/").some((part) => part === "..")) return value;

  const repoUrl = githubRepoUrl(currentWiki as WikiRecord);
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return value;

  const pathMatch = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const path = pathMatch?.[1] || "";
  if (!path) return value;
  const suffix = `${pathMatch?.[2] || ""}${pathMatch?.[3] || ""}`;
  const owner = encodeURIComponent(match[1]);
  const repo = encodeURIComponent(match[2]);
  const branch = encodeURIComponent(String(currentWiki?.branch || "HEAD"));
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodedPath}${suffix}`;
}

function safeEncode(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function icon(name: string, className = "app-icon"): string {
  const paths: Record<string, string> = {
    arrowLeft: '<path d="m15 18-6-6 6-6"/><path d="M21 12H9"/>',
    arrowRight: '<path d="m9 18 6-6-6-6"/><path d="M3 12h12"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    page: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4"/><path d="M15.4 6.5l-6.8 4"/>',
    slides: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/><path d="M8 9h8"/><path d="M8 13h5"/>',
    statusCheck: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const body = paths[name] || "";
  return body
    ? `<svg class="${escapeHtml(className)}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    : "";
}

function brandIcon(name: "github" | "obsidian", className = "public-brand-icon"): string {
  if (name === "github") {
    return `<svg class="${escapeHtml(className)}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58v-2.24c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z"/></svg>`;
  }
  return `<svg class="${escapeHtml(className)} public-obsidian-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.643 14.012c.615-.183 1.605-.465 2.745-.534-.684-1.725-.849-3.235-.716-4.579.153-1.552.7-2.847 1.234-3.95.114-.235.223-.454.328-.664.149-.297.289-.577.42-.86.217-.47.378-.885.46-1.27.08-.38.08-.719-.014-1.044-.095-.325-.297-.675-.681-1.06a1.6 1.6 0 0 0-1.475.36l-4.95 4.453a1.602 1.602 0 0 0-.512.952l-.427 2.83c.67.592 2.327 2.317 3.335 4.71.09.213.174.432.253.656ZM5.855 9.937c-.024.1-.057.197-.099.29L3.14 16.058a1.602 1.602 0 0 0 .313 1.772l4.117 4.24c2.102-3.102 1.795-6.02.835-8.3-.728-1.73-1.832-3.083-2.55-3.833Z" fill="#A88BFA"/><path d="M8.52 22.57c.073.01.146.018.22.02.781.023 2.095.091 3.16.288.87.16 2.593.642 4.011 1.056 1.082.316 2.197-.548 2.354-1.664.115-.814.33-1.735.725-2.58l-.009.004c-.67-1.87-1.523-3.077-2.417-3.847a5.294 5.294 0 0 0-2.777-1.258c-1.541-.216-2.952.189-3.841.45.532 2.218.368 4.828-1.425 7.53Z" fill="#A88BFA"/><path d="M19.676 18.538a69.072 69.072 0 0 0 1.858-2.952.811.811 0 0 0-.061-.901c-.516-.684-1.504-2.075-2.042-3.362-.554-1.323-.636-3.378-.64-4.378a1.708 1.708 0 0 0-.359-1.051L15.235 1.83a3.757 3.757 0 0 1-.076.545c-.107.503-.307 1.004-.536 1.498-.135.29-.29.601-.446.915-.105.21-.21.42-.31.626-.517 1.068-.998 2.227-1.132 3.59-.125 1.262.046 2.73.814 4.484.128.01.257.025.386.043a6.364 6.364 0 0 1 3.327 1.506c.916.79 1.743 1.921 2.414 3.5Z" fill="#A88BFA"/></svg>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
