import "../src/ui/styles.css";
import "./public-wiki.css";
import "./public-ask.css";
import { renderMarkdownPreview } from "../src/ui/markdown-renderer.ts";
import {
  renderAskOutline,
  renderAskTurns,
  type AskTurnLike,
} from "../src/ui/ask-thread.ts";
import { publicAskAgentPrompt } from "../src/public-agent-prompt.ts";

type PublicAskTurn = {
  question: string;
  answer: string;
  askedAt?: string;
  clarifications?: { question: string; answer: string }[];
};

type PublicAskSource = {
  path: string;
  label?: string;
  detail?: string;
  excerpt?: string;
};

type PublicAskRecord = {
  title: string;
  description?: string;
  repoName?: string;
  scopes?: string[];
  runtime?: string;
  model?: string;
  askedAt?: string;
  turns: PublicAskTurn[];
  sources?: PublicAskSource[];
};

type PublicAskResponse = {
  ask: PublicAskRecord;
  snapshot?: Record<string, any>;
  publication: Record<string, any>;
};

type BeautifulMermaidModule = {
  renderMermaidSVG?: (source: string, theme: Record<string, unknown>) => string;
  THEMES?: Record<string, Record<string, unknown>>;
};

let currentAsk: PublicAskRecord | null = null;
let currentSnapshot: Record<string, any> | null = null;
let currentPublication: Record<string, any> | null = null;
let publicTheme = readPublicTheme();
let agentPopoverOpen = false;
let agentPopoverReturnFocus: HTMLElement | null = null;
let agentPromptCopyResetTimer = 0;
let beautifulMermaidPromise: Promise<BeautifulMermaidModule | null> | null = null;
const copyButtonResetTimers = new WeakMap<HTMLElement, number>();

const root = document.getElementById("public-ask-root");
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
void loadPublicAsk();

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (handlePublicAgentClick(event, target)) return;

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

  if (!currentAsk) return;

  const outlineLink = target.closest<HTMLElement>("[data-outline-turn]");
  if (outlineLink) {
    event.preventDefault();
    scrollToTurn(Number(outlineLink.dataset.outlineTurn));
    return;
  }

  const copyAnswer = target.closest<HTMLElement>("[data-copy-answer]");
  if (copyAnswer) {
    event.preventDefault();
    void copyTurnText(copyAnswer, "answer");
    return;
  }

  const copyQuestion = target.closest<HTMLElement>("[data-copy-question]");
  if (copyQuestion) {
    event.preventDefault();
    void copyTurnText(copyQuestion, "question");
  }
});

document.addEventListener("keydown", (event) => {
  if (agentPopoverOpen && event.key === "Escape") {
    event.preventDefault();
    closePublicAgentPopover();
  }
});

async function loadPublicAsk(): Promise<void> {
  try {
    const publicId = publicIdFromPath();
    if (!publicId) throw new Error("Shared conversation link is missing.");
    const response = await fetch(`/api/public/ask/${encodeURIComponent(publicId)}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json().catch(() => ({})) as Partial<PublicAskResponse> & { error?: string };
    if (!response.ok || !data.ask) throw new Error(data.error || `Could not load shared conversation (${response.status}).`);
    currentAsk = data.ask;
    currentSnapshot = data.snapshot || null;
    currentPublication = data.publication || null;
    document.title = `${currentAsk.title || "Shared Ask"} · rlm-wiki Ask`;
    render();
  } catch (error) {
    if (!root) return;
    root.innerHTML = `<div class="public-wiki-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function render(): void {
  if (!root || !currentAsk) return;
  const ask = currentAsk;
  const privateLink = currentPublication?.visibility === "private";
  const markdownUrl = `${canonicalPath()}.md`;
  const llmsUrl = `${canonicalPath()}/llms.txt`;
  root.innerHTML = `
    <header class="public-wiki-topbar public-ask-topbar">
      <a class="public-wiki-brand" href="/">
        <strong>rlm-wiki</strong>
        <span>${escapeHtml(ask.title || "Shared conversation")}</span>
      </a>
      <nav class="public-wiki-actions" aria-label="Shared conversation links">
        ${renderPublicThemeToggle()}
        ${renderPublicAgentButton()}
        <a class="public-wiki-cta" href="${escapeHtml(markdownUrl)}" title="Markdown transcript for agents" aria-label="Markdown transcript for agents">${icon("page")}<span>Markdown</span></a>
        <a class="public-wiki-cta" href="${escapeHtml(llmsUrl)}" title="llms.txt agent index" aria-label="llms.txt agent index">${icon("list")}<span>llms.txt</span></a>
        ${privateLink ? `<span class="public-wiki-private-badge">${icon("lock")}Private link</span>` : ""}
      </nav>
    </header>
    <main class="public-ask-main">
      <section class="asks-layout ask-session-layout public-ask-layout">
        <div class="center-pane">
          ${renderOutline()}
          <article class="ask-thread" data-public-ask-thread>
            ${renderHeader()}
            ${renderThread()}
            ${renderSources()}
          </article>
        </div>
      </section>
    </main>
  `;
  void renderPublicMermaids(root);
  syncOutlineFromScroll();
}

function renderHeader(): string {
  const ask = currentAsk;
  if (!ask) return "";
  const scopes = (ask.scopes && ask.scopes.length ? ask.scopes : [ask.repoName]).filter(Boolean) as string[];
  const sharedAt = formatDate(String(currentSnapshot?.publishedAt || currentPublication?.publishedAt || ""));
  const pills = [
    ...scopes.slice(0, 4).map((scope) => `<span class="ask-meta-pill" title="${escapeHtml(scope)}">${escapeHtml(scope)}</span>`),
    ask.runtime ? `<span class="ask-meta-pill">${escapeHtml(ask.runtime)}</span>` : "",
    ask.model ? `<span class="ask-meta-pill">${escapeHtml(ask.model)}</span>` : "",
    sharedAt ? `<span class="ask-meta-pill">Shared ${escapeHtml(sharedAt)}</span>` : "",
  ].filter(Boolean);
  return `
    <header class="public-ask-header">
      <span class="eyebrow">Shared Ask conversation</span>
      <h1>${escapeHtml(ask.title || "Shared conversation")}</h1>
      ${pills.length ? `<div class="public-ask-meta-row">${pills.join("")}</div>` : ""}
    </header>
  `;
}

function renderThread(): string {
  const ask = currentAsk;
  if (!ask) return "";
  return renderAskTurns(
    { status: "done", updatedAt: ask.askedAt },
    { widget: false },
    {
      askTurns: () => threadTurns(),
      answerPreview: () => "",
      copyIcon: icon("copy"),
      escape: escapeHtml,
      isWorkingAnswer: () => false,
      processStream: () => "",
      renderMarkdown: (answer: string) => renderAnswerMarkdown(answer),
      streamKey: () => "",
      turnStamp: (turn) => formatDate(String(turn.updatedAt || "")) || "Answered",
    },
  );
}

function renderOutline(): string {
  const ask = currentAsk;
  if (!ask) return "";
  return renderAskOutline(
    { status: "done", updatedAt: ask.askedAt },
    {
      askTurns: () => threadTurns(),
      escape: escapeHtml,
      copy: { heading: "Outline", ariaLabel: "Conversation outline" },
    },
  );
}

function threadTurns(): AskTurnLike[] {
  return (currentAsk?.turns || []).map((turn) => ({
    question: turn.question,
    answer: turn.answer,
    status: "done",
    updatedAt: turn.askedAt,
    clarifications: turn.clarifications,
  }));
}

// renderMarkdownPreview (not renderMarkdownBlocks): the .markdown-preview wrapper it
// adds is the scope for the desktop's markdown CSS, including the "N sources"
// citation pill. Without it the citation <details> degrades to a native triangle.
function renderAnswerMarkdown(answer: string): string {
  return renderMarkdownPreview(String(answer || ""), true, null, {
    escape: escapeHtml,
    sourceTextLabel: (source: string) => source,
    sourceLink,
    isSourceReference: (source: string) => /^[A-Za-z0-9._/-]+(?::\d+(?:-\d+)?)?$/.test(source),
    renderMermaidBlock,
    icon,
    compactSourceCitations: true,
    resolveMediaSrc: (src: string) => {
      const value = String(src || "").trim();
      return /^(?:https?:|data:image\/|\/)/i.test(value) ? value : "";
    },
  });
}

function renderSources(): string {
  const sources = currentAsk?.sources || [];
  if (!sources.length) return "";
  const rows = sources
    .map((source) => `
      <li>
        <code>${escapeHtml(source.path)}</code>
        ${source.label && source.label !== source.path ? `<span class="public-ask-source-detail">${escapeHtml(source.label)}</span>` : ""}
        ${source.detail ? `<span class="public-ask-source-detail">${escapeHtml(source.detail)}</span>` : ""}
        ${source.excerpt ? `<pre class="public-ask-source-excerpt">${escapeHtml(source.excerpt)}</pre>` : ""}
      </li>`)
    .join("");
  return `
    <details class="public-ask-sources">
      <summary>Sources cited in this conversation (${sources.length})</summary>
      <ul class="public-ask-source-list">${rows}</ul>
    </details>
  `;
}

function scrollToTurn(index: number): void {
  if (!Number.isFinite(index)) return;
  const thread = root?.querySelector<HTMLElement>("[data-public-ask-thread]");
  const turn = thread?.querySelector<HTMLElement>(`.ask-turn[data-chat-message-from="user"][data-turn-index="${index}"]`);
  if (!thread || !turn) return;
  thread.scrollTo({ top: Math.max(0, turn.offsetTop - 18), behavior: "smooth" });
  highlightOutlineTurn(index);
}

function syncOutlineFromScroll(): void {
  const thread = root?.querySelector<HTMLElement>("[data-public-ask-thread]");
  if (!thread) return;
  const onScroll = () => highlightOutlineTurn(activeOutlineTurnIndex(thread));
  thread.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

function activeOutlineTurnIndex(thread: HTMLElement): number {
  const anchors = Array.from(thread.querySelectorAll<HTMLElement>('.ask-turn[data-chat-message-from="user"]'));
  if (!anchors.length) return 0;
  const threshold = thread.scrollTop + 90;
  let active = 0;
  for (const anchor of anchors) {
    if (anchor.offsetTop <= threshold) active = Number(anchor.dataset.turnIndex || 0);
  }
  return active;
}

function highlightOutlineTurn(index: number): void {
  root?.querySelectorAll<HTMLElement>(".ask-outline-link, .ask-outline-tick").forEach((node) => {
    node.classList.toggle("is-active", Number(node.dataset.outlineTurn) === index);
  });
}

async function copyTurnText(button: HTMLElement, kind: "answer" | "question"): Promise<void> {
  const index = Number(button.dataset.turnIndex);
  const turn = currentAsk?.turns?.[index];
  if (!turn) return;
  try {
    await copyText(kind === "answer" ? turn.answer : turn.question);
    markCopyButton(button, "Copied");
  } catch {
    markCopyButton(button, "Copy failed");
  }
}

function markCopyButton(button: HTMLElement, label: string): void {
  const previous = button.dataset.label || "";
  button.dataset.label = label;
  button.classList.add("is-copied");
  window.clearTimeout(copyButtonResetTimers.get(button));
  copyButtonResetTimers.set(button, window.setTimeout(() => {
    button.dataset.label = previous;
    button.classList.remove("is-copied");
  }, 1600));
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
  const button = root?.querySelector<HTMLElement>("[data-public-theme-toggle]");
  const next = publicTheme === "light" ? "dark" : "light";
  button?.setAttribute("aria-label", `Switch to ${next} mode`);
  button?.setAttribute("title", `Switch to ${next} mode`);
}

function applyPublicTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.publicTheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f7f5" : "#08090a");
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
  if (!currentAsk) return;
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
  if (!host || !currentAsk) return;
  const pageUrl = `${window.location.origin}${canonicalPath()}`;
  const prompt = publicAskAgentPrompt({
    title: currentAsk.title || "Shared Ask conversation",
    description: currentAsk.description || currentAsk.turns[0]?.question || "",
    pageUrl,
    llmsUrl: `${pageUrl}/llms.txt`,
    llmsFullUrl: `${pageUrl}/llms-full.txt`,
    repoName: currentAsk.repoName || (currentAsk.scopes || [])[0] || "",
    turnCount: currentAsk.turns.length,
    updatedAt: String(currentPublication?.updatedAt || ""),
  });
  host.innerHTML = `
    <div class="public-agent-layer" data-public-agent-layer>
      <section class="public-agent-popover" role="dialog" aria-modal="true" aria-labelledby="public-agent-title" aria-describedby="public-agent-description">
        <button class="public-agent-close" type="button" data-public-agent-close aria-label="Close">${icon("x")}</button>
        <div class="public-agent-kicker">Works with any coding agent</div>
        <h2 id="public-agent-title">Bring your agent into this conversation</h2>
        <p id="public-agent-description">Copy one prompt that tells your agent to read the question index first, fetch the full transcript only if needed, and stay grounded in this shared Q&amp;A.</p>
        <pre class="public-agent-prompt" tabindex="0"><code data-public-agent-prompt>${escapeHtml(prompt)}</code></pre>
        <p class="public-agent-note">The prompt is vendor-agnostic. It points agents at <code>llms.txt</code> first so they can load the smallest useful context before using the full Markdown transcript.</p>
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

async function copyPublicAgentPrompt(button: HTMLElement): Promise<void> {
  const prompt = publicAgentPopoverHost()?.querySelector<HTMLElement>("[data-public-agent-prompt]")?.textContent || "";
  if (!prompt.trim()) return;
  try {
    await copyText(prompt);
    markPublicAgentCopyButton(button, "Copied");
  } catch {
    markPublicAgentCopyButton(button, "Copy failed");
  }
}

function markPublicAgentCopyButton(button: HTMLElement, label: string): void {
  const previous = button.dataset.defaultLabel || button.textContent || "Copy for agent";
  button.dataset.defaultLabel = previous;
  button.textContent = label;
  window.clearTimeout(agentPromptCopyResetTimer);
  agentPromptCopyResetTimer = window.setTimeout(() => {
    button.textContent = button.dataset.defaultLabel || "Copy for agent";
  }, 1600);
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
    markCopyButton(button, "Copied");
  } catch {
    markCopyButton(button, "Copy failed");
  }
}

// Mirrors public-wiki's sourceLink: cited files become GitHub blob links when the
// ask's scope identifies a repo, otherwise they stay as code pills (same CSS family
// as the desktop citation list).
function publicAskRepoUrl(): string {
  const candidates = [currentAsk?.repoName, ...(currentAsk?.scopes || [])];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim().replace(/\/$/, "");
    if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/i.test(text)) return text;
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return `https://github.com/${text}`;
  }
  return "";
}

function sourceLink(label: string, ref: string): string {
  const source = String(ref || label || "").replace(/^`|`$/g, "");
  const match = source.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/);
  const file = match?.[1] || source;
  const line = match?.[2] ? `#L${match[2]}` : "";
  const repoUrl = publicAskRepoUrl();
  const href = repoUrl && file && !file.includes("…")
    ? `${repoUrl}/blob/HEAD/${file.split("/").map(encodeURIComponent).join("/")}${line}`
    : "";
  return href
    ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<code>${escapeHtml(label)}</code>`;
}

function renderMermaidBlock(code: string): string {
  const encoded = safeEncode(code);
  return `<div class="mermaid desktop-mermaid mermaid-loading" data-mermaid-source="${escapeHtml(encoded)}" aria-label="Mermaid diagram">${escapeHtml(code)}</div>`;
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
      node.dataset.mermaidRendered = "1";
      node.classList.remove("mermaid-loading", "mermaid-error");
      node.classList.add("beautiful-mermaid");
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

function publicIdFromPath(): string {
  const parts = window.location.pathname.split("/").filter(Boolean);
  return (parts[0] === "public" || parts[0] === "share") && parts[1] === "ask" ? decodeURIComponent(parts[2] || "") : "";
}

function canonicalPath(): string {
  const publicId = String(currentPublication?.publicId || publicIdFromPath());
  const privateLink = currentPublication?.visibility === "private";
  return `/${privateLink ? "share" : "public"}/ask/${encodeURIComponent(publicId)}`;
}

function readPublicTheme(): "dark" | "light" {
  return localStorage.getItem("rlm-wiki-public:theme") === "light" ? "light" : "dark";
}

function formatDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
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

function icon(name: string, className = "app-icon"): string {
  const paths: Record<string, string> = {
    arrowRight: '<path d="m9 18 6-6-6-6"/><path d="M3 12h12"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"/>',
    page: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    statusCheck: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const body = paths[name] || "";
  return body
    ? `<svg class="${escapeHtml(className)}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    : "";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
