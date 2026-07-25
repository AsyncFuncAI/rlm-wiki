import { extractMarkdownFrontmatter } from "./markdown-renderer";
import {
  renderAskUserQuestions,
  DEFAULT_ASK_QUESTIONS_COPY,
  type AskUserQuestion,
  type AskUserAnswer,
  type AskUserInterview,
  type AskQuestionsCopy,
} from "./ask-user-questions";

export type { AskUserQuestion, AskUserAnswer, AskUserInterview, AskQuestionsCopy };

export type WikiRecord = Record<string, any>;
export type WikiPage = Record<string, any>;
const WIKI_PAGE_COUNT_MAX = 30;

export type WikiWorkspaceState = {
  activeWiki: WikiRecord | null;
  activeWikiPageId: string | null;
  wikiGenerating: boolean;
  wikiProgress: Record<string, any> | null;
  wikiRuns: WikiRecord[];
  wikiAskDraft?: string;
  docsAskDraft?: string;
  docsAskThreadHtml?: string;
  docsAskOverlayOpen?: boolean;
  docsAskRunning?: boolean;
  wikiReusePublic?: Record<string, any> | null;
  wikiSearch: string;
  wikiSort: string;
  wikiSourcesInput: string;
  wikiStyle: string;
  wikiStylePrompt?: string;
  wikiStylePromptName?: string;
  wikiStylePresets?: Array<Record<string, string>>;
  wikiLanguages?: string[];
  wikiHotkeyMode?: "confirm" | "instant";
  wikiHotkeyRequest?: Record<string, any> | null;
  knowledgeMode?: string;
  wikiFormatOpen?: boolean;
  wikiBranchMenuOpen?: boolean;
  wikiPageCount: number;
  wikiReaderMode?: "continuous" | "paged";
  wikiViewMode: string;
  wikiSourceViewerHtml?: string;
  wikiRegenerateOpen?: boolean;
  wikiRegenerateInstruction?: string;
  wikiRegeneratePrompt?: string;
  wikiSlidesLatest?: Record<string, any> | null;
  wikiSlidesViewer?: Record<string, any> | null;
  wikiPublication?: Record<string, any> | null;
  wikiShareOpen?: boolean;
  wikiPublishing?: boolean;
  wikiReadOnly?: boolean;
  workspaceKind?: "wiki" | "docs";
  wikiAgentMode?: "manual" | "agent"; // DEFAULT "agent"
  wikiAgentIntent?: string; // intent textarea value
  wikiAgentBusy?: boolean; // interview/enhance in flight (thinking state)
  wikiAgentError?: string; // surfaced error copy
  wikiAgentInterview?: AskUserInterview | null;
  wikis: WikiRecord[];
};

type WorkspaceKind = "wiki" | "docs";
type WorkspaceCopy = {
  eyebrow: string;
  title: string;
  description: string;
  savedCount: (count: number) => string;
  count: (count: number) => string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  noMatchTitle: string;
  noMatchBody: string;
  submitLabel: string;
  sourcePlaceholder: string;
  refresh: string;
  library: string;
  sortAria: string;
  sortUpdated: string;
  sortTitle: string;
  sortPageCount: string;
  view: string;
  gridView: string;
  listView: string;
  maxPages: string;
  pageLimitTitle: string;
  quotaTitle: string;
  quotaSuffix: string;
  format: string;
  docsFormatTitle: string;
  docsFormatDetail: string;
  chooseFormatTitle: string;
  formatAria: string;
  savedPrompts: string;
  custom: string;
  editFormatPrompt: string;
  languages: string;
  selectedLanguage: string;
  generatedLanguage: string;
  startAnother: string;
};

type WikiReaderCopy = {
  back: string;
  wiki: string;
  share: string;
  close: string;
  copy: string;
  open: string;
  download: string;
  regenerate: string;
  regeneratePage: string;
  regenerating: string;
  updated: (date: string) => string;
  today: string;
  sourceFiles: (count: number) => string;
  pageMissing: string;
  pageUntitled: string;
  previous: string;
  next: string;
  resizeInspectorPanel: string;
  readerOrientation: string;
  readContinuousTitle: string;
  readPagedTitle: string;
  scroll: string;
  pages: string;
  wikiOutline: string;
  onThisPage: string;
  relatedSourceFiles: string;
  noSourceList: string;
  generatedFrom: string;
  model: string;
  format: string;
  getrlm-wiki: string;
  openSlide: string;
  openSlideDeck: string;
  slidesTitle: (title: string) => string;
  regenerateOpenSlideDeck: string;
  openLatestSlideDeck: string;
  generateOpenSlideDeck: string;
  viewSlides: string;
  generateSlides: string;
  documentation: string;
  docs: string;
  docsPages: (count: number, repo: string) => string;
  documentationPages: string;
  docsPageSelector: string;
  goToPage: (index: number, title: string) => string;
  docsConversation: string;
  docsChat: string;
  newQuestion: string;
  startNewDocumentationQuestion: string;
  wikiAskPlaceholder: string;
  docsAskPlaceholder: string;
  wikiAskLabel: string;
  docsAskLabel: string;
  stopDocumentationAnswer: string;
  shareWiki: string;
  shareTitle: string;
  privateLinkTitle: string;
  publicLinkTitle: string;
  shareErrorDetail: string;
  updateLinkDetail: (label: string) => string;
  privatePublishedDetail: string;
  publicPublishedDetail: string;
  createLinkDetail: string;
  updating: string;
  publishing: string;
  updateLink: (label: string) => string;
  refreshLink: (label: string) => string;
  createPrivateLink: string;
  publishToGallery: string;
  makePrivateLink: string;
  privateLink: string;
  publicLink: string;
  publicGallery: string;
  sharedWikiLink: string;
  localExport: string;
  obsidianZip: string;
  exportPdf: string;
  unpublishLink: string;
  shareFootnote: string;
  regenerateWikiPage: string;
  improveQuestion: string;
  regenerateInstructionPlaceholder: string;
  currentRegenerationPrompt: string;
  cancel: string;
  regenerateWholeWiki: string;
  regenerateWholeWikiDetail: string;
  useFullWikiFlow: string;
};

type WikiFormatMetaCopy = { group: string; summary: string; outputs: string[]; badge?: string };
type WikiFormatSampleCopy = { title: string; body: string; lines: string[] };

export type WikiGeneratorCopy = {
  formatLabel: (style: string) => string;
  formatMeta: (style: string, defaults: WikiFormatMetaCopy) => WikiFormatMetaCopy;
  formatSample: (style: string, defaults: WikiFormatSampleCopy) => WikiFormatSampleCopy;
  languageLabel: (id: string, fallback: string) => string;
  languageSummary: (count: number) => string;
  autoPageCount: (count: number) => string;
  reuseSavedMatch: string;
  reusePublicMatch: string;
  reuseNoPublicWikiYet: string;
  reuseSearchBeforeGenerating: string;
  reuseSavedDetail: (label: string) => string;
  reusePublicDetail: (label: string) => string;
  reuseNoPublicDetail: (label: string) => string;
  reuseSearchDetail: string;
  reuseSearching: string;
  reuseRefresh: string;
  reuseSearchAgain: string;
  reuseSearchPublic: string;
  reuseSavedKind: string;
  reusePublicKind: string;
  reuseOpen: string;
  reuseView: string;
  reuseSearchingGallery: string;
  reuseNoPublicWiki: string;
  reuseSearchTitle: (label: string) => string;
  sourceFallback: string;
  hotkeyAria: string;
  hotkeyNoGithubRepoFound: string;
  hotkeyReadyFromBrowser: string;
  generate: string;
  hotkeyModeAria: string;
  hotkeyConfirmTitle: string;
  hotkeyConfirm: string;
  hotkeyAutoRunTitle: string;
  hotkeyAutoRun: string;
  dismiss: string;
  customPromptFallback: string;
  formatPromptAria: string;
  formatEyebrow: string;
  reusableFormatDetail: string;
  close: string;
  wikiFormatsAria: string;
  customGroup: string;
  savedCustomPrompt: string;
  newCustomPrompt: string;
  newCustomPromptDetail: string;
  customPrompt: string;
  promptNamePlaceholder: string;
  selectedFormatOutcome: string;
  whatThisProduces: string;
  sampleOutputShape: string;
  samplePeek: string;
  savePrompt: string;
  saveAsCustom: string;
  useFormat: (label: string) => string;
  artifactWiki: string;
  artifactDocs: string;
  statusSaved: string;
  statusFailed: string;
  statusStopped: string;
  statusRunning: string;
  statusReady: string;
  statusBlocked: string;
  statusNotice: string;
  generatingArtifact: (artifact: string) => string;
  preparingLocalRuntime: string;
  writingPages: (done: number, total: number, active: number) => string;
  savingArtifact: (artifact: string) => string;
  planningStructure: string;
  localCliWorking: string;
  runtimeFallback: string;
  pageTitle: (index: number) => string;
  pageProgressAria: string;
  pageGenerationQueueAria: string;
  pageDotTitle: (index: number) => string;
  waitingForAgent: string;
  agentNotes: string;
  agentNotesForPage: (title: string) => string;
  pageFallback: string;
  codeGraphLabel: string;
  stopGeneration: (artifact: string) => string;
  stop: string;
  waiting: string;
  working: string;
  wikiGenerationPaused: string;
  checkSettingsBeforeGenerating: string;
  today: string;
  updated: (date: string) => string;
  fileCount: (count: number) => string;
  pageCount: (count: number) => string;
  archiveWiki: string;
  archiveWikiConfirmation: string;
  archiveWikiQuestion: string;
  archiveWikiDetail: string;
  cancel: string;
  archive: string;
  generatingWiki: string;
  openTitle: (title: string) => string;
  stopTitle: (title: string) => string;
  partialArtifactSaved: (artifact: string) => string;
  pagesNeedRecovery: string;
  recoveryReadable: (saved: number, planned: number, recoverable: number, artifact: string) => string;
  recoveryFromOutline: (recoverable: number) => string;
  recoverySnapshot: (saved: number, planned: number) => string;
  recoverCount: (count: number) => string;
};

const DEFAULT_WIKI_READER_COPY: WikiReaderCopy = {
  back: "Back",
  wiki: "Wiki",
  share: "Share",
  close: "Close",
  copy: "Copy",
  open: "Open",
  download: "Download",
  regenerate: "Regenerate",
  regeneratePage: "Regenerate page",
  regenerating: "Regenerating…",
  updated: (date) => `Updated ${date}`,
  today: "today",
  sourceFiles: (count) => `${count} source ${count === 1 ? "file" : "files"}`,
  pageMissing: "This page has not been generated yet.",
  pageUntitled: "Untitled page",
  previous: "Previous",
  next: "Next",
  resizeInspectorPanel: "Resize inspector panel",
  readerOrientation: "Wiki reader orientation",
  readContinuousTitle: "Read every page in one continuous scroll",
  readPagedTitle: "Read one wiki page at a time",
  scroll: "Scroll",
  pages: "Pages",
  wikiOutline: "Wiki outline",
  onThisPage: "On this page",
  relatedSourceFiles: "Related source files",
  noSourceList: "No source list was recorded for this page.",
  generatedFrom: "Generated from",
  model: "Model",
  format: "Format",
  getrlm-wiki: "Get rlm-wiki",
  openSlide: "Open Slide",
  openSlideDeck: "Open Slide deck",
  slidesTitle: (title) => `${title} slides`,
  regenerateOpenSlideDeck: "Regenerate this Open Slide deck",
  openLatestSlideDeck: "Open the latest Open Slide deck for this wiki",
  generateOpenSlideDeck: "Generate an Open Slide deck from this wiki",
  viewSlides: "View slides",
  generateSlides: "Generate slides",
  documentation: "Documentation",
  docs: "Docs",
  docsPages: (count, repo) => `${count} ${count === 1 ? "page" : "pages"} · ${repo}`,
  documentationPages: "Documentation pages",
  docsPageSelector: "Documentation page selector",
  goToPage: (index, title) => `Go to page ${index}: ${title}`,
  docsConversation: "Documentation conversation",
  docsChat: "Docs chat",
  newQuestion: "New question",
  startNewDocumentationQuestion: "Start a new documentation question",
  wikiAskPlaceholder: "Ask anything about this wiki...",
  docsAskPlaceholder: "Ask anything about this documentation...",
  wikiAskLabel: "Ask about this wiki",
  docsAskLabel: "Ask about this documentation",
  stopDocumentationAnswer: "Stop documentation answer",
  shareWiki: "Share wiki",
  shareTitle: "Share this wiki",
  privateLinkTitle: "Private link",
  publicLinkTitle: "Public link",
  shareErrorDetail: "Sharing hit a tiny detour.",
  updateLinkDetail: (label) => `Local changes are ready to update the ${label}.`,
  privatePublishedDetail: "Unlisted snapshot. Anyone with this URL can read it.",
  publicPublishedDetail: "Listed in the gallery. Anyone can read it.",
  createLinkDetail: "Create an unlisted link, or publish to the public gallery.",
  updating: "Updating...",
  publishing: "Publishing...",
  updateLink: (label) => `Update ${label}`,
  refreshLink: (label) => `Refresh ${label}`,
  createPrivateLink: "Create private link",
  publishToGallery: "Publish to gallery",
  makePrivateLink: "Make private link",
  privateLink: "private link",
  publicLink: "public link",
  publicGallery: "Public gallery",
  sharedWikiLink: "Shared wiki link",
  localExport: "Local export",
  obsidianZip: "Obsidian ZIP",
  exportPdf: "Export PDF",
  unpublishLink: "Unpublish link",
  shareFootnote: "Local exports stay on this Mac. Private links are hidden from the gallery; public links are listed. Prompts, API keys, and run logs stay on this device.",
  regenerateWikiPage: "Regenerate wiki page",
  improveQuestion: "What should improve?",
  regenerateInstructionPlaceholder: "Example: make installation steps more precise, cite Dockerfile lines, and remove unsupported claims.",
  currentRegenerationPrompt: "Current regeneration prompt",
  cancel: "Cancel",
  regenerateWholeWiki: "Regenerate the whole wiki",
  regenerateWholeWikiDetail: "Return to the generator with this wiki's repository, format, and page count prefilled.",
  useFullWikiFlow: "Use full wiki flow",
};

const DEFAULT_WIKI_GENERATOR_COPY: WikiGeneratorCopy = {
  formatLabel: (style) => wikiStyleLabel(style),
  formatMeta: (_style, defaults) => defaults,
  formatSample: (_style, defaults) => defaults,
  languageLabel: (_id, fallback) => fallback,
  languageSummary: (count) => `${count} languages`,
  autoPageCount: (count) => `Auto ≤ ${count}`,
  reuseSavedMatch: "Saved match",
  reusePublicMatch: "Public match",
  reuseNoPublicWikiYet: "No public wiki yet",
  reuseSearchBeforeGenerating: "Search before generating",
  reuseSavedDetail: (label) => `Public search sends only ${label}.`,
  reusePublicDetail: (label) => `Found public snapshots for ${label}.`,
  reuseNoPublicDetail: (label) => `Nothing public for ${label}.`,
  reuseSearchDetail: "Check the public gallery before spending a run.",
  reuseSearching: "Searching...",
  reuseRefresh: "Refresh",
  reuseSearchAgain: "Search again",
  reuseSearchPublic: "Search public",
  reuseSavedKind: "Saved",
  reusePublicKind: "Public",
  reuseOpen: "Open",
  reuseView: "View",
  reuseSearchingGallery: "Searching gallery...",
  reuseNoPublicWiki: "No public wiki",
  reuseSearchTitle: (label) => `Search the public gallery for ${label}. This sends the repo name.`,
  sourceFallback: "GitHub repository",
  hotkeyAria: "Wiki hotkey",
  hotkeyNoGithubRepoFound: "No GitHub repo found",
  hotkeyReadyFromBrowser: "Ready from browser",
  generate: "Generate",
  hotkeyModeAria: "Wiki hotkey mode",
  hotkeyConfirmTitle: "Ask before generating",
  hotkeyConfirm: "Confirm",
  hotkeyAutoRunTitle: "Generate immediately after resolving a GitHub repo",
  hotkeyAutoRun: "Auto-run",
  dismiss: "Dismiss",
  customPromptFallback: "Custom prompt",
  formatPromptAria: "Wiki format prompt",
  formatEyebrow: "Format",
  reusableFormatDetail: "Tune a reusable format for this workspace.",
  close: "Close",
  wikiFormatsAria: "Wiki formats",
  customGroup: "Custom",
  savedCustomPrompt: "Saved custom prompt",
  newCustomPrompt: "New custom prompt",
  newCustomPromptDetail: "Name it, tune it, and save it for reuse.",
  customPrompt: "Custom prompt",
  promptNamePlaceholder: "Prompt name",
  selectedFormatOutcome: "Selected format outcome",
  whatThisProduces: "What this produces",
  sampleOutputShape: "Sample output shape",
  samplePeek: "Sample peek",
  savePrompt: "Save prompt",
  saveAsCustom: "Save as custom",
  useFormat: (label) => `Use ${label}`,
  artifactWiki: "wiki",
  artifactDocs: "docs",
  statusSaved: "Saved",
  statusFailed: "Failed",
  statusStopped: "Stopped",
  statusRunning: "Running",
  statusReady: "Ready",
  statusBlocked: "Blocked",
  statusNotice: "Notice",
  generatingArtifact: (artifact) => `Generating ${artifact}`,
  preparingLocalRuntime: "Preparing local runtime.",
  writingPages: (done, total, active) => `Writing pages · ${done}/${total} saved${active ? ` · ${active} active` : ""}`,
  savingArtifact: (artifact) => `Saving ${artifact}`,
  planningStructure: "Planning structure",
  localCliWorking: "Local CLI is working.",
  runtimeFallback: "Agent",
  pageTitle: (index) => `Page ${index}`,
  pageProgressAria: "Page progress",
  pageGenerationQueueAria: "Page generation queue",
  pageDotTitle: (index) => `Page ${index}`,
  waitingForAgent: "Waiting for the next agent update",
  agentNotes: "Agent notes",
  agentNotesForPage: (title) => `Agent notes · ${title}`,
  pageFallback: "Page",
  codeGraphLabel: "Code graph",
  stopGeneration: (artifact) => `Stop ${artifact} generation`,
  stop: "Stop",
  waiting: "waiting",
  working: "working",
  wikiGenerationPaused: "Wiki generation paused",
  checkSettingsBeforeGenerating: "Check the current settings before generating again.",
  today: "today",
  updated: (date) => `Updated ${date}`,
  fileCount: (count) => `${count} ${count === 1 ? "file" : "files"}`,
  pageCount: (count) => `${count || "?"} ${count === 1 ? "page" : "pages"}`,
  archiveWiki: "Archive wiki",
  archiveWikiConfirmation: "Archive wiki confirmation",
  archiveWikiQuestion: "Archive wiki?",
  archiveWikiDetail: "Hide it from Library and Recent Wikis.",
  cancel: "Cancel",
  archive: "Archive",
  generatingWiki: "Generating wiki",
  openTitle: (title) => `Open ${title}`,
  stopTitle: (title) => `Stop ${title}`,
  partialArtifactSaved: (artifact) => `Partial ${artifact} saved`,
  pagesNeedRecovery: "Pages need recovery",
  recoveryReadable: (saved, planned, recoverable) => `${saved} of ${planned} pages are readable. Recover ${recoverable} missing or failed ${recoverable === 1 ? "page" : "pages"} without starting over.`,
  recoveryFromOutline: (recoverable) => `Recover ${recoverable} ${recoverable === 1 ? "page" : "pages"} from the saved outline.`,
  recoverySnapshot: (saved, planned) => `${saved} of ${planned} pages are readable in this snapshot.`,
  recoverCount: (count) => `Recover ${count}`,
};

export type WikiWorkspaceDeps = {
  escape: (value: string) => string;
  icon: (name: string, className?: string) => string;
  modelLogo: (agentId: string, className?: string) => string;
  markdown: (
    value: string,
    context: {
      sources: unknown[];
      compactSourceCitations?: boolean;
      cacheKey?: string;
      resolveDocsPageHref?: (href: string, title: string, description: string) => string | null;
    },
  ) => string;
  renderLocalCliControl: () => string;
  renderLegacyModeControl: () => string;
  renderRuntimeControl: () => string;
  scopeLabel: (value: string) => string;
  scopeDisplayLabel?: (value: string) => string;
  scopeBranchLabel?: (value: string) => string;
  scopeBranchDisplay?: (value: string) => string;
  renderScopeBranchPanel?: (sources: string[]) => string;
  scopeCopy?: Partial<{
    defaultBranch: string;
    chooseBranchTitle: string;
    chooseBranchAria: (label: string) => string;
    removeSource: string;
    sourcePlaceholder: string;
    addAnotherPlaceholder: string;
    addSource: string;
    addShort: string;
    openLocalFolder: string;
    local: string;
  }>;
  splitScopeText: (value: string) => string[];
  scopeWithBranch: (value: string, branch: string) => string;
  wikiExportUrl?: (wiki: WikiRecord) => string;
  wikiPdfUrl?: (wiki: WikiRecord) => string;
  wikiSlidesUrl?: (wiki: WikiRecord) => string;
  publicWikiBaseUrl?: string;
  workspaceCopy?: (kind: WorkspaceKind, defaults: WorkspaceCopy) => Partial<WorkspaceCopy>;
  readerCopy?: Partial<WikiReaderCopy>;
  generatorCopy?: Partial<WikiGeneratorCopy>;
  agentCopy?: Partial<WikiAgentCopy>;
  askQuestionsCopy?: AskQuestionsCopy;
};

// Copy for the agent-mode compose surface (toggle + intent textarea + states).
export type WikiAgentCopy = {
  modeAria: string;
  modeAgent: string;
  modeManual: string;
  intentEyebrow: string;
  intentPlaceholder: string;
  start: string;
  thinking: string;
};

export const DEFAULT_WIKI_AGENT_COPY: WikiAgentCopy = {
  modeAria: "Wiki compose mode",
  modeAgent: "Agent",
  modeManual: "Manual",
  intentEyebrow: "What should this wiki do",
  intentPlaceholder:
    "Describe the wiki you want. e.g. focus on the auth flow and break down the tech stack.",
  start: "Start",
  thinking: "Thinking",
};

function wikiAgentCopy(deps: WikiWorkspaceDeps): WikiAgentCopy {
  return { ...DEFAULT_WIKI_AGENT_COPY, ...(deps.agentCopy || {}) };
}

function wikiReaderCopy(deps: WikiWorkspaceDeps): WikiReaderCopy {
  const copy = deps.readerCopy || {};
  return {
    ...DEFAULT_WIKI_READER_COPY,
    ...copy,
    updated: copy.updated || DEFAULT_WIKI_READER_COPY.updated,
    sourceFiles: copy.sourceFiles || DEFAULT_WIKI_READER_COPY.sourceFiles,
    slidesTitle: copy.slidesTitle || DEFAULT_WIKI_READER_COPY.slidesTitle,
    docsPages: copy.docsPages || DEFAULT_WIKI_READER_COPY.docsPages,
    goToPage: copy.goToPage || DEFAULT_WIKI_READER_COPY.goToPage,
    updateLinkDetail: copy.updateLinkDetail || DEFAULT_WIKI_READER_COPY.updateLinkDetail,
    updateLink: copy.updateLink || DEFAULT_WIKI_READER_COPY.updateLink,
    refreshLink: copy.refreshLink || DEFAULT_WIKI_READER_COPY.refreshLink,
  };
}

function wikiGeneratorCopy(deps: WikiWorkspaceDeps): WikiGeneratorCopy {
  const copy = deps.generatorCopy || {};
  return {
    ...DEFAULT_WIKI_GENERATOR_COPY,
    ...copy,
    formatLabel: copy.formatLabel || DEFAULT_WIKI_GENERATOR_COPY.formatLabel,
    formatMeta: copy.formatMeta || DEFAULT_WIKI_GENERATOR_COPY.formatMeta,
    formatSample: copy.formatSample || DEFAULT_WIKI_GENERATOR_COPY.formatSample,
    languageLabel: copy.languageLabel || DEFAULT_WIKI_GENERATOR_COPY.languageLabel,
    languageSummary: copy.languageSummary || DEFAULT_WIKI_GENERATOR_COPY.languageSummary,
    autoPageCount: copy.autoPageCount || DEFAULT_WIKI_GENERATOR_COPY.autoPageCount,
    reuseSavedDetail: copy.reuseSavedDetail || DEFAULT_WIKI_GENERATOR_COPY.reuseSavedDetail,
    reusePublicDetail: copy.reusePublicDetail || DEFAULT_WIKI_GENERATOR_COPY.reusePublicDetail,
    reuseNoPublicDetail: copy.reuseNoPublicDetail || DEFAULT_WIKI_GENERATOR_COPY.reuseNoPublicDetail,
    reuseSearchTitle: copy.reuseSearchTitle || DEFAULT_WIKI_GENERATOR_COPY.reuseSearchTitle,
    useFormat: copy.useFormat || DEFAULT_WIKI_GENERATOR_COPY.useFormat,
    generatingArtifact: copy.generatingArtifact || DEFAULT_WIKI_GENERATOR_COPY.generatingArtifact,
    writingPages: copy.writingPages || DEFAULT_WIKI_GENERATOR_COPY.writingPages,
    savingArtifact: copy.savingArtifact || DEFAULT_WIKI_GENERATOR_COPY.savingArtifact,
    pageTitle: copy.pageTitle || DEFAULT_WIKI_GENERATOR_COPY.pageTitle,
    pageDotTitle: copy.pageDotTitle || DEFAULT_WIKI_GENERATOR_COPY.pageDotTitle,
    agentNotesForPage: copy.agentNotesForPage || DEFAULT_WIKI_GENERATOR_COPY.agentNotesForPage,
    stopGeneration: copy.stopGeneration || DEFAULT_WIKI_GENERATOR_COPY.stopGeneration,
    updated: copy.updated || DEFAULT_WIKI_GENERATOR_COPY.updated,
    fileCount: copy.fileCount || DEFAULT_WIKI_GENERATOR_COPY.fileCount,
    pageCount: copy.pageCount || DEFAULT_WIKI_GENERATOR_COPY.pageCount,
    openTitle: copy.openTitle || DEFAULT_WIKI_GENERATOR_COPY.openTitle,
    stopTitle: copy.stopTitle || DEFAULT_WIKI_GENERATOR_COPY.stopTitle,
    partialArtifactSaved: copy.partialArtifactSaved || DEFAULT_WIKI_GENERATOR_COPY.partialArtifactSaved,
    recoveryReadable: copy.recoveryReadable || DEFAULT_WIKI_GENERATOR_COPY.recoveryReadable,
    recoveryFromOutline: copy.recoveryFromOutline || DEFAULT_WIKI_GENERATOR_COPY.recoveryFromOutline,
    recoverySnapshot: copy.recoverySnapshot || DEFAULT_WIKI_GENERATOR_COPY.recoverySnapshot,
    recoverCount: copy.recoverCount || DEFAULT_WIKI_GENERATOR_COPY.recoverCount,
  };
}

export type WikiReuseQuery = {
  owner: string;
    repo: string;
    branch: string | null;
    sourcePath: string | null;
    key: string;
  label: string;
  url: string;
};

export function filterWikis(wikis: WikiRecord[], search: string, sort: string): WikiRecord[] {
  const query = (search || "").trim().toLowerCase();
  let items = [...(wikis || [])];
  if (query) {
    items = items.filter((wiki) => `${wiki.title} ${wiki.description} ${wiki.owner}/${wiki.repo}`.toLowerCase().includes(query));
  }
  if (sort === "title") return items.sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")));
  if (sort === "pages") return items.sort((left, right) => Number(right.pageCount || 0) - Number(left.pageCount || 0));
  return items.sort((left, right) => Date.parse(right.updatedAt || right.generatedAt || 0) - Date.parse(left.updatedAt || left.generatedAt || 0));
}

export function wikiPages(wiki: WikiRecord | null | undefined): WikiPage[] {
  const pages = wiki?.structure?.pages || [];
  return Array.isArray(pages) ? pages.map((page) => ({ ...page, ...(wiki?.pages?.[page.id] || {}) })) : [];
}

export function wikiActivePage(wiki: WikiRecord | null | undefined, activePageId: string | null | undefined): WikiPage | null {
  const pages = wikiPages(wiki);
  return pages.find((page) => page.id === activePageId) || pages[0] || null;
}

export function wikiPageIndex(wiki: WikiRecord | null | undefined, activePageId: string | null | undefined): number {
  const pages = wikiPages(wiki);
  const index = pages.findIndex((page) => page.id === wikiActivePage(wiki, activePageId)?.id);
  return index < 0 ? 0 : index;
}

export function wikiSections(wiki: WikiRecord | null | undefined, activePageId: string | null | undefined): Array<{ id: string; title: string; active: boolean }> {
  const pages = wikiPages(wiki);
  const activeId = wikiActivePage(wiki, activePageId)?.id;
  return pages.map((page) => ({ id: page.id, title: page.title || page.id, active: page.id === activeId }));
}

type DocsNavGroup = {
  id: string;
  title: string;
  pages: WikiPage[];
};

export type DocsPageLinkEntry = {
  id: string;
  title: string;
  path: string;
  groupTitle: string;
  aliases: string[];
};

function docsNavigationGroups(
  wiki: WikiRecord | null | undefined,
  copy: Pick<WikiReaderCopy, "documentation" | "pages"> = DEFAULT_WIKI_READER_COPY,
): DocsNavGroup[] {
  const pages = wikiPages(wiki);
  const pageById = new Map(pages.map((page) => [String(page.id || ""), page]));
  const groups: DocsNavGroup[] = [];
  const used = new Set<string>();
  const sections = Array.isArray(wiki?.structure?.sections) ? wiki?.structure?.sections : [];
  const documentationTitle = copy.documentation || DEFAULT_WIKI_READER_COPY.documentation;
  const pagesTitle = copy.pages || DEFAULT_WIKI_READER_COPY.pages;

  for (const section of sections) {
    const pageIds = Array.isArray(section?.pages) ? section.pages : [];
    const sectionPages: WikiPage[] = pageIds
      .map((id: unknown) => pageById.get(String(id || "")))
      .filter((page: WikiPage | undefined): page is WikiPage => !!page);
    if (!sectionPages.length) continue;
    sectionPages.forEach((page) => used.add(String(page.id || "")));
    groups.push({
      id: String(section?.id || slugifyDocsSegment(section?.title || "section")),
      title: String(section?.title || documentationTitle),
      pages: sectionPages,
    });
  }

  const remaining = pages.filter((page) => !used.has(String(page.id || "")));
  if (remaining.length) {
    groups.push({ id: "section-pages", title: pagesTitle, pages: remaining });
  }
  return groups.length ? groups : [{ id: "section-pages", title: pagesTitle, pages }];
}

function docsGroupForPage(groups: DocsNavGroup[], page: WikiPage | null | undefined): DocsNavGroup | null {
  const pageId = String(page?.id || "");
  return groups.find((group) => group.pages.some((item) => String(item.id || "") === pageId)) || groups[0] || null;
}

export function docsPageLinkEntries(wiki: WikiRecord | null | undefined): DocsPageLinkEntry[] {
  return docsNavigationGroups(wiki)
    .flatMap((group) =>
      group.pages.map((page) => {
        const meta = docsPageMeta(page);
        return {
          id: String(page.id || ""),
          title: meta.title,
          path: docsPagePath(wiki, page, group),
          groupTitle: group.title,
          aliases: [String(page.title || ""), String(page.slug || "")],
        };
      }),
    )
    .filter((entry) => entry.id && entry.title);
}

export function resolveDocsPageLink(
  wiki: WikiRecord | null | undefined,
  href: string | null | undefined,
  label: string | null | undefined = "",
): string | null {
  if (isExternalDocsHref(href)) return null;
  const targets = docsLinkKeys([href, label]).filter(Boolean);
  if (!targets.length) return null;
  const targetSet = new Set(targets);

  for (const entry of docsPageLinkEntries(wiki)) {
    const entryKeys = docsLinkKeys([
      entry.id,
      entry.title,
      entry.path,
      entry.path.replace(/\.(?:mdx?|html?)$/i, ""),
      entry.path.split("/").pop() || "",
      `${entry.groupTitle}/${entry.title}`,
      ...entry.aliases,
    ]);
    if (entryKeys.some((key) => targetSet.has(key))) return entry.id;
  }

  return null;
}

function isExternalDocsHref(href: string | null | undefined): boolean {
  const value = String(href || "").trim();
  return /^(?:https?:)?\/\//i.test(value) || /^(?:mailto|tel):/i.test(value);
}

function docsLinkKeys(values: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();
  values.forEach((value) => {
    const normalized = normalizeDocsLinkKey(value);
    if (normalized) keys.add(normalized);
  });
  return [...keys];
}

function normalizeDocsLinkKey(value: string | null | undefined): string {
  let raw = String(value || "").trim();
  if (!raw || raw === "#") return "";
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.replace(/\\/g, "/").replace(/^https?:\/\/[^/]+/i, "");
  const hashIndex = raw.indexOf("#");
  if (hashIndex === 0) raw = raw.slice(1);
  else if (hashIndex > 0) raw = raw.slice(0, hashIndex);
  raw = raw
    .replace(/[?].*$/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/index(?:\.(?:mdx?|html?))?$/i, "")
    .replace(/\.(?:mdx?|html?)$/i, "")
    .replace(/\/+$/, "");
  return raw
    .replace(/^page-|^section-/i, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function docsPageMeta(page: WikiPage | null | undefined, fallbackTitle = DEFAULT_WIKI_READER_COPY.pageUntitled): { title: string; description: string; body: string } {
  const content = String(page?.content || "");
  const frontmatter = extractMarkdownFrontmatter(content);
  const title = String(frontmatter.attrs.title || page?.title || page?.id || fallbackTitle).trim();
  const description = String(frontmatter.attrs.description || page?.description || "").trim();
  return {
    title,
    description,
    body: removeOpeningDocsSourceDetails(removeOpeningDocsHeading(frontmatter.body, title)),
  };
}

function removeOpeningDocsSourceDetails(markdown: string): string {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !(lines[index] || "").trim()) index += 1;
  if (!/^\s*<details\b/i.test(lines[index] || "")) return markdown;

  let endIndex = -1;
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 80); cursor += 1) {
    if (/^\s*<\/details>\s*$/i.test(lines[cursor] || "")) {
      endIndex = cursor;
      break;
    }
  }
  if (endIndex < 0) return markdown;

  const block = lines.slice(index, endIndex + 1).join("\n");
  if (!/<summary>[\s\S]*?(?:source|file|evidence)[\s\S]*?<\/summary>/i.test(block)) return markdown;
  lines.splice(index, endIndex - index + 1);
  while (index < lines.length && !(lines[index] || "").trim()) lines.splice(index, 1);
  return lines.join("\n");
}

function removeOpeningDocsHeading(markdown: string, title: string): string {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length && !(lines[index] || "").trim()) index += 1;
  const heading = (lines[index] || "").match(/^#\s+(.+?)\s*$/);
  if (!heading) return markdown;
  const normalizedHeading = normalizeDocsText(heading[1]);
  const normalizedTitle = normalizeDocsText(title);
  if (normalizedHeading && normalizedHeading === normalizedTitle) {
    lines.splice(index, 1);
    while (index < lines.length && !(lines[index] || "").trim()) lines.splice(index, 1);
    return lines.join("\n");
  }
  return markdown;
}

function normalizeDocsText(value: string): string {
  return String(value || "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function docsPagePath(wiki: WikiRecord | null | undefined, page: WikiPage | null | undefined, group: DocsNavGroup | null): string {
  const pageSlug = slugifyDocsSegment(page?.slug || page?.title || page?.id || "page");
  const groupSlug = slugifyDocsSegment(group?.title || wiki?.structure?.title || "docs");
  return `${groupSlug}/${pageSlug}.mdx`;
}

function slugifyDocsSegment(value: unknown): string {
  const slug = String(value || "")
    .replace(/^page-|^section-/i, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "page";
}

export function wikiSources(page: WikiPage | null | undefined): string[] {
  return Array.isArray(page?.filePaths) ? page.filePaths : [];
}

const WIKI_FAILED_PAGE_PATTERNS = [
  /^>\s*⚠️\s*Page generation failed:/i,
  /^>\s*⚠️\s*The agent returned an invalid wiki page\./i,
  /^>\s*⚠️\s*Page needs recovery\./i,
];

export function wikiPageNeedsRecovery(page: WikiPage | null | undefined): boolean {
  if (!page) return false;
  if (String(page.status || "").toLowerCase() === "failed") return true;
  const content = String(page.content || "").trim();
  if (!content) return true;
  return WIKI_FAILED_PAGE_PATTERNS.some((pattern) => pattern.test(content));
}

export function wikiRecoverySummary(wiki: WikiRecord | null | undefined): {
  plannedPageCount: number;
  savedPageCount: number;
  recoverablePageIds: string[];
  failedPageIds: string[];
} {
  const pages = wikiPages(wiki);
  const failedPageIds = pages
    .filter((page) => wikiPageNeedsRecovery(page) && String(page.content || "").trim())
    .map((page) => String(page.id));
  const recoverablePageIds = pages
    .filter(wikiPageNeedsRecovery)
    .map((page) => String(page.id));
  return {
    plannedPageCount: pages.length,
    savedPageCount: Math.max(0, pages.length - recoverablePageIds.length),
    recoverablePageIds,
    failedPageIds,
  };
}

export function wikiReuseQueryForSources(sources: string[]): WikiReuseQuery | null {
  if (sources.length !== 1) return null;
  const raw = String(sources[0] || "").trim();
  if (!raw || raw.startsWith("/") || raw.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(raw)) return null;
  const githubMatch = raw.match(/github\.com[/:]([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^#?\s]+))?(?:[/?#\s]|$)/i);
  if (githubMatch) {
    const owner = githubMatch[1];
    const repo = githubMatch[2].replace(/\.git$/i, "");
    const treeRef = parseGithubTreeRef(githubMatch[3]);
    const branch = treeRef.branch;
    const sourcePath = treeRef.sourcePath;
    return {
      owner,
      repo,
      branch,
      sourcePath,
      key: `${owner}/${repo}${sourcePath ? `#${sourcePath}` : ""}`.toLowerCase(),
      label: sourcePath ? `${owner}/${repo}:${sourcePath}` : `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
    };
  }
  if (/^https?:\/\//i.test(raw)) return null;
  const shorthand = raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@(.+))?$/);
  if (!shorthand) return null;
  const owner = shorthand[1];
  const repo = shorthand[2].replace(/\.git$/i, "");
  const ref = parseGithubShorthandRef(shorthand[3]);
  return {
    owner,
    repo,
    branch: ref.branch,
    sourcePath: ref.sourcePath,
    key: `${owner}/${repo}${ref.sourcePath ? `#${ref.sourcePath}` : ""}`.toLowerCase(),
    label: ref.sourcePath ? `${owner}/${repo}:${ref.sourcePath}` : `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

function safeDecodeGithubPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeGithubSourcePath(value: unknown): string | null {
  const clean = String(value || "").split(/[?#]/)[0] || "";
  const parts = clean
    .split("/")
    .map((part) => safeDecodeGithubPart(part).trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || null;
}

function isGithubBranchNamespace(value: string): boolean {
  return ["feature", "feat", "fix", "bugfix", "hotfix", "release", "chore", "wip"].includes(value);
}

function isLikelyGithubPathRoot(value: string): boolean {
  const clean = safeDecodeGithubPart(value).trim().toLowerCase();
  return [
    ".github",
    "api",
    "app",
    "apps",
    "backend",
    "bin",
    "client",
    "cmd",
    "codex-rs",
    "crates",
    "docs",
    "examples",
    "frontend",
    "internal",
    "lib",
    "libs",
    "packages",
    "pkg",
    "public",
    "scripts",
    "server",
    "src",
    "test",
    "tests",
    "tools",
    "web",
  ].includes(clean);
}

function parseGithubTreeRef(value: unknown): { branch: string | null; sourcePath: string | null } {
  const parts = String(value || "").split(/[?#]/)[0]?.split("/").filter(Boolean) || [];
  if (!parts.length) return { branch: null, sourcePath: null };
  if (parts.length <= 2 && isGithubBranchNamespace(parts[0] || "")) {
    return {
      branch: parts.map((part) => safeDecodeGithubPart(part).trim()).filter(Boolean).join("/") || null,
      sourcePath: null,
    };
  }
  if (
    isGithubBranchNamespace(parts[0] || "") &&
    parts.length > 2 &&
    !isLikelyGithubPathRoot(parts[1] || "")
  ) {
    const branch = parts
      .slice(0, 2)
      .map((part) => safeDecodeGithubPart(part).trim())
      .filter(Boolean)
      .join("/") || null;
    return {
      branch,
      sourcePath: normalizeGithubSourcePath(parts.slice(2).join("/")),
    };
  }
  return {
    branch: parts[0] ? safeDecodeGithubPart(parts[0]) : null,
    sourcePath: normalizeGithubSourcePath(parts.slice(1).join("/")),
  };
}

function parseGithubShorthandRef(value: unknown): { branch: string | null; sourcePath: string | null } {
  const text = String(value || "").trim();
  if (!text) return { branch: null, sourcePath: null };
  const [branch, sourcePath] = text.split(/:(.+)/, 2);
  return {
    branch: branch.trim() || null,
    sourcePath: normalizeGithubSourcePath(sourcePath),
  };
}

export function wikiOpenKey(wiki: WikiRecord): string {
  if (wiki?.id) return ["id", wiki.id].map((part) => encodeURIComponent(String(part || ""))).join("|");
  return [wiki.owner, wiki.repo, wiki.branch || "", wiki.sourcePath || ""].map((part) => encodeURIComponent(part || "")).join("|");
}

export function wikiRepoLabel(wiki: WikiRecord | null | undefined): string {
  if (wiki?.repos && Array.isArray(wiki.repos)) return `${wiki.repos.length} repositories`;
  const base = `${wiki?.owner || ""}/${wiki?.repo || ""}`;
  return wiki?.sourcePath ? `${base}:${wiki.sourcePath}` : base;
}

function wikiSlidesUrl(wiki: WikiRecord, deps: WikiWorkspaceDeps): string {
  if (deps.wikiSlidesUrl) return deps.wikiSlidesUrl(wiki);
  const params: Array<[string, string]> = [];
  if (wiki.id) params.push(["id", String(wiki.id)]);
  else {
    params.push(["owner", String(wiki.owner || "")]);
    params.push(["repo", String(wiki.repo || "")]);
    if (wiki.branch) params.push(["branch", String(wiki.branch)]);
    if (wiki.sourcePath) params.push(["sourcePath", String(wiki.sourcePath)]);
  }
  return `/api/wiki/slides.zip?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

function wikiExportUrl(wiki: WikiRecord, deps: WikiWorkspaceDeps): string {
  if (deps.wikiExportUrl) return deps.wikiExportUrl(wiki);
  const params: Array<[string, string]> = [];
  if (wiki.id) params.push(["id", String(wiki.id)]);
  else {
    params.push(["owner", String(wiki.owner || "")]);
    params.push(["repo", String(wiki.repo || "")]);
    if (wiki.branch) params.push(["branch", String(wiki.branch)]);
    if (wiki.sourcePath) params.push(["sourcePath", String(wiki.sourcePath)]);
  }
  return `/api/wiki/export.zip?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

function wikiPdfUrl(wiki: WikiRecord, deps: WikiWorkspaceDeps): string {
  if (deps.wikiPdfUrl) return deps.wikiPdfUrl(wiki);
  const params: Array<[string, string]> = [];
  if (wiki.id) params.push(["id", String(wiki.id)]);
  else {
    params.push(["owner", String(wiki.owner || "")]);
    params.push(["repo", String(wiki.repo || "")]);
    if (wiki.branch) params.push(["branch", String(wiki.branch)]);
    if (wiki.sourcePath) params.push(["sourcePath", String(wiki.sourcePath)]);
  }
  return `/api/wiki/export.pdf.html?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

export function wikiRefsForAsk(wiki: WikiRecord | null | undefined, scopeWithBranch: (value: string, branch: string) => string): string {
  if (Array.isArray(wiki?.repos) && wiki.repos.length) {
    return wiki.repos
      .map((repo: WikiRecord) => wikiRepoScopeUrl(repo, scopeWithBranch))
      .filter(Boolean)
      .join("\n");
  }
  return wikiRepoScopeUrl({
    owner: wiki?.owner,
    repo: wiki?.repo,
    url: wiki?.repoUrl,
    branch: wiki?.branch,
    sourcePath: wiki?.sourcePath,
  }, scopeWithBranch);
}

export type WikiFullRegenerationDraft = {
  sourcesInput: string;
  pageCount: number;
  style: string;
  stylePrompt: string;
  languages: unknown[];
};

export function wikiFullRegenerationDraft(
  wiki: WikiRecord | null | undefined,
  scopeWithBranch: (value: string, branch: string) => string,
  fallback: { pageCount?: number; style?: string; languages?: unknown[] } = {},
): WikiFullRegenerationDraft {
  const plannedPageCount = Number(wiki?.wikiPageCount || 0);
  const structurePageCount = wikiPages(wiki).length;
  const fallbackPageCount = Number(fallback.pageCount || 0);
  return {
    sourcesInput: wikiRefsForAsk(wiki, scopeWithBranch),
    pageCount: Math.max(1, plannedPageCount || structurePageCount || fallbackPageCount || 1),
    style: String(wiki?.wikiStyle || fallback.style || "technical"),
    stylePrompt: String(wiki?.wikiStylePrompt || ""),
    languages: Array.isArray(wiki?.wikiLanguages)
      ? wiki.wikiLanguages
      : Array.isArray(fallback.languages)
        ? fallback.languages
        : [],
  };
}

function wikiRepoScopeUrl(
  repo: { owner?: unknown; repo?: unknown; url?: unknown; branch?: unknown; sourcePath?: unknown },
  scopeWithBranch: (value: string, branch: string) => string,
): string {
  const rawBase = String(repo.url || `${repo.owner || ""}/${repo.repo || ""}`).trim();
  const parsedBase = parseWikiRepoScopeBase(rawBase);
  const base = parsedBase?.base || rawBase;
  const sourcePath = normalizeGithubSourcePath(repo.sourcePath) || parsedBase?.sourcePath || null;
  const branch = String(repo.branch || parsedBase?.branch || "").trim();
  if (!sourcePath) return branch ? scopeWithBranch(base, branch) : base;
  const ref = branch || "HEAD";
  const githubBase = base.replace(/\/+$/, "");
  return /^https?:\/\//i.test(githubBase)
    ? `${githubBase}/tree/${encodeGithubUrlPath(ref)}/${encodeGithubUrlPath(sourcePath)}`
    : `${githubBase}@${ref}:${sourcePath}`;
}

function parseWikiRepoScopeBase(value: string): { base: string; branch: string | null; sourcePath: string | null } | null {
  const text = String(value || "").trim();
  const githubMatch = text.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^#?\s]+))?(?:[/?#\s]|$)/i,
  );
  if (githubMatch) {
    const parsedRef = parseGithubTreeRef(githubMatch[3]);
    return {
      base: `https://github.com/${githubMatch[1]}/${githubMatch[2].replace(/\.git$/i, "")}`,
      branch: parsedRef.branch,
      sourcePath: parsedRef.sourcePath,
    };
  }
  const shorthandMatch = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@(.+))?$/);
  if (!shorthandMatch) return null;
  const parsedRef = parseGithubShorthandRef(shorthandMatch[3]);
  return {
    base: `${shorthandMatch[1]}/${shorthandMatch[2].replace(/\.git$/i, "")}`,
    branch: parsedRef.branch,
    sourcePath: parsedRef.sourcePath,
  };
}

function encodeGithubUrlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function wikiDate(value: unknown, fallback = DEFAULT_WIKI_READER_COPY.today): string {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : fallback;
}

const WIKI_LEGACY_STYLE_MAP: Record<string, string> = {
  functional: "feature-scout",
  wlog: "socratic-exploration",
  design: "worth-stealing",
};
const WIKI_STYLE_LABELS: Record<string, string> = {
  basic: "Basic",
  technical: "Technical",
  "first-30": "First 30 Minutes",
  eli5: "Explain Like I'm 5",
  "mental-model": "Mental Model",
  "socratic-exploration": "Socratic Exploration",
  "feature-scout": "Feature Scout",
  "worth-stealing": "Worth Stealing",
  "hidden-quirks": "Hidden Quirks",
  "pattern-discovery": "Pattern Discovery",
  "repo-comparison": "Repo Comparison",
  "debugging-atlas": "Debugging Atlas",
  "tech-reader": "Tech Reader Brief",
  documentation: "Documentation",
  custom: "Custom",
};
export const WIKI_BUILTIN_STYLE_OPTIONS = [
  "basic",
  "technical",
  "first-30",
  "eli5",
  "mental-model",
  "socratic-exploration",
  "feature-scout",
  "worth-stealing",
  "hidden-quirks",
  "pattern-discovery",
  "repo-comparison",
  "debugging-atlas",
  "tech-reader",
  "documentation",
] as const;
const WIKI_STYLE_OPTIONS = [...WIKI_BUILTIN_STYLE_OPTIONS, "custom"] as const;
const WIKI_FORMAT_META: Record<string, { group: string; summary: string; outputs: string[]; badge?: string }> = {
  basic: {
    group: "Traditional",
    summary: "A balanced DeepWiki-style guide that lets the repository shape the table of contents.",
    outputs: ["Repository overview", "Major areas and source files", "Grounded explanations"],
  },
  technical: {
    group: "Traditional",
    summary: "A comprehensive developer reference for architecture, APIs, data flows, and operations.",
    outputs: ["Architecture map", "Module responsibilities", "Implementation reference"],
  },
  "first-30": {
    group: "Start",
    summary: "A fast path from cold start to useful repo context.",
    outputs: ["Read order", "Entry points", "Local glossary"],
    badge: "Fast start",
  },
  eli5: {
    group: "Start",
    summary: "A plain-language explanation of what the repo does, using careful analogies without losing source grounding.",
    outputs: ["Simple model", "Everyday analogies", "What to remember"],
    badge: "Plain English",
  },
  "mental-model": {
    group: "Start",
    summary: "A durable model of how the system behaves and where changes are safe.",
    outputs: ["Core flows", "Invariants", "Failure boundaries"],
    badge: "Deep understanding",
  },
  "socratic-exploration": {
    group: "Start",
    summary: "First-principles questions and reframes that reveal why the repo is shaped this way.",
    outputs: ["Sharp questions", "Source-backed answers", "Simplest-system framing"],
  },
  "feature-scout": {
    group: "Discover",
    summary: "A scout report of features worth exploring, demoing, copying, or productizing.",
    outputs: ["Interesting features", "Implementation hooks", "Exploration paths"],
  },
  "worth-stealing": {
    group: "Discover",
    summary: "A reusable-ideas report for elegant designs, best practices, and porting recipes.",
    outputs: ["Reusable moves", "When not to copy", "Porting notes"],
    badge: "Builder favorite",
  },
  "hidden-quirks": {
    group: "Discover",
    summary: "Non-obvious implementation details worth studying.",
    outputs: ["Hidden constraints", "Safety rails", "Tiny high-leverage choices"],
  },
  "pattern-discovery": {
    group: "Compare",
    summary: "Architecture and product patterns the reader may not know to ask for.",
    outputs: ["Repeated mechanisms", "Provider boundaries", "Workflow patterns"],
  },
  "repo-comparison": {
    group: "Compare",
    summary: "A comparison brief across repositories, or across internal approaches in one repo.",
    outputs: ["Strengths by repo", "Tradeoffs", "Portable ideas"],
  },
  "debugging-atlas": {
    group: "Operate / Share",
    summary: "A map of how the system fails and where to inspect first.",
    outputs: ["Symptoms", "Probes and logs", "Root-cause paths"],
  },
  "tech-reader": {
    group: "Operate / Share",
    summary: "An accessible HN/TechCrunch-style technical breakdown without hype.",
    outputs: ["Clear hook", "Mechanism", "Builder takeaways"],
  },
  documentation: {
    group: "Documentation",
    summary: "A technical docs-site structure with exact commands, APIs, configuration, examples, and troubleshooting.",
    outputs: ["Docs manifest", "Technical reference", "Operations"],
    badge: "Docs",
  },
};
const WIKI_FORMAT_GROUPS = ["Traditional", "Start", "Discover", "Compare", "Operate / Share", "Documentation"] as const;
const WIKI_FORMAT_SAMPLE_PEEKS: Record<string, { title: string; body: string; lines: string[] }> = {
  basic: {
    title: "Repository Map",
    body: "A neutral guide that lets the source tree decide what matters first.",
    lines: ["What this repo does", "Main packages and responsibilities", "Source files to open next"],
  },
  technical: {
    title: "Request Lifecycle",
    body: "A developer reference with architecture, contracts, and implementation details.",
    lines: ["Entry point -> router -> worker", "Data model and adapter boundaries", "Operational paths and failure modes"],
  },
  "first-30": {
    title: "Start Here",
    body: "A cold-start path for understanding the repo before you spend the whole afternoon.",
    lines: ["Read these files first", "Words you need to know", "What to ignore for now"],
  },
  eli5: {
    title: "Tiny Mental Picture",
    body: "Plain-language explanations with small analogies, then source-backed details.",
    lines: ["The simple idea", "A careful everyday analogy", "What to remember"],
  },
  "mental-model": {
    title: "One Map of the System",
    body: "A reasoning model for how the system behaves and where changes stay safe.",
    lines: ["Core loop", "State owners and invariants", "Safe changes vs. risky changes"],
  },
  "socratic-exploration": {
    title: "Why Is It Built This Way?",
    body: "A question-led walkthrough that turns source evidence into first-principles understanding.",
    lines: ["What problem forces this shape?", "What would break if it were simpler?", "Which files prove the answer?"],
  },
  "feature-scout": {
    title: "Feature Scout",
    body: "A product-minded scan for features, demos, workflows, and overlooked surfaces.",
    lines: ["Feature worth trying", "Where it lives in code", "How to demo it quickly"],
  },
  "worth-stealing": {
    title: "Reusable Moves",
    body: "A builder's list of patterns worth copying, including when not to copy them.",
    lines: ["The move", "Why it works", "Porting notes and caveats"],
  },
  "hidden-quirks": {
    title: "Things a README Skips",
    body: "A casual read misses the constraints, safety rails, and tiny choices that make the repo work.",
    lines: ["Quiet constraint", "Unexpected edge case", "Small high-leverage detail"],
  },
  "pattern-discovery": {
    title: "Pattern Field Notes",
    body: "A scan for repeated architecture and product patterns you might not know to ask for.",
    lines: ["Repeated mechanism", "Provider or runtime boundary", "Pattern to reuse elsewhere"],
  },
  "repo-comparison": {
    title: "Comparison Brief",
    body: "A side-by-side explanation of strengths, tradeoffs, and portable ideas.",
    lines: ["Where each approach wins", "Tradeoff table", "Ideas worth carrying over"],
  },
  "debugging-atlas": {
    title: "When It Breaks",
    body: "A map from symptoms to probes, logs, likely causes, and regression checks.",
    lines: ["Symptom", "Inspect these files or logs", "What evidence separates causes"],
  },
  "tech-reader": {
    title: "Builder Brief",
    body: "A concise technical story for curious readers without launch-post hype.",
    lines: ["The hook", "How it works", "What builders should notice"],
  },
  documentation: {
    title: "Docs Site Map",
    body: "A functional technical docs set for humans and agents: compact, source-reflective, and reference-oriented.",
    lines: ["Public entry points", "Commands, APIs, and config", "Examples, errors, and operations"],
  },
};

function normalizeWikiStyleForUi(value: string): string {
  const raw = String(value || "").trim();
  if (raw.startsWith("custom:")) return "custom";
  if (WIKI_LEGACY_STYLE_MAP[raw]) return WIKI_LEGACY_STYLE_MAP[raw];
  return WIKI_STYLE_OPTIONS.includes(raw as any) ? raw : "technical";
}

export function wikiStyleLabel(value: string): string {
  return WIKI_STYLE_LABELS[normalizeWikiStyleForUi(value)] || "Technical";
}

export function isDocumentationWiki(wiki: WikiRecord | null | undefined): boolean {
  const style = String(wiki?.wikiStyle || wiki?.input?.style || wiki?.style || "");
  return normalizeWikiStyleForUi(style) === "documentation";
}

export function isDocumentationRun(run: WikiRecord | null | undefined): boolean {
  const style = String(run?.wikiStyle || run?.input?.style || run?.style || "");
  return normalizeWikiStyleForUi(style) === "documentation";
}

export function wikiLibrarySavedCountLabel(count: number): string {
  return `${count} saved wiki${count === 1 ? "" : "s"}`;
}

export function wikiLibraryCountLabel(count: number): string {
  return `${count} wiki${count === 1 ? "" : "s"}`;
}

function workspaceKind(state: Pick<WikiWorkspaceState, "workspaceKind">): WorkspaceKind {
  return state.workspaceKind === "docs" ? "docs" : "wiki";
}

function workspaceCopy(kind: WorkspaceKind): WorkspaceCopy {
  if (kind === "docs") {
    return {
      eyebrow: "Docs",
      title: "Generate repository documentation.",
      description: "Turn a GitHub repo, URL, or local folder into a docs-site structure with quickstarts, guides, references, examples, and source evidence.",
      savedCount: (count) => `${count} saved doc${count === 1 ? "" : "s"}`,
      count: (count) => `${count} doc${count === 1 ? "" : "s"}`,
      searchPlaceholder: "Search docs",
      emptyTitle: "No saved docs yet",
      emptyBody: "Generate documentation from a GitHub repo or local folder.",
      noMatchTitle: "No matching docs",
      noMatchBody: "Try another repo, title, or description.",
      submitLabel: "Generate docs",
      sourcePlaceholder: "Repository URL or local folder",
      refresh: "Refresh",
      library: "Library",
      sortAria: "Sort docs",
      sortUpdated: "Recently updated",
      sortTitle: "Title",
      sortPageCount: "Page count",
      view: "View",
      gridView: "Grid view",
      listView: "List view",
      maxPages: "Max pages",
      pageLimitTitle: "The agent chooses the useful number of pages up to this limit.",
      quotaTitle: "Above 20 pages can consume more provider quota. The agent still chooses the smallest useful count up to this limit.",
      quotaSuffix: " · quota",
      format: "Format",
      docsFormatTitle: "Documentation mode uses the built-in docs generator format",
      docsFormatDetail: "Guides · reference · troubleshooting",
      chooseFormatTitle: "Choose wiki format",
      formatAria: "Wiki format",
      savedPrompts: "Saved prompts",
      custom: "Custom",
      editFormatPrompt: "Edit format prompt",
      languages: "Languages",
      selectedLanguage: "Selected language",
      generatedLanguage: "Generated wiki content uses this language.",
      startAnother: "Start another docs run",
    };
  }
  return {
    eyebrow: "Wiki",
    title: "Generate a repository wiki.",
    description: "Add one or more GitHub repos, URLs, or local paths. Generated pages and source evidence appear in the library below.",
    savedCount: wikiLibrarySavedCountLabel,
    count: wikiLibraryCountLabel,
    searchPlaceholder: "Search wikis",
    emptyTitle: "No saved wikis yet",
    emptyBody: "Generate one from a GitHub repo or local folder.",
    noMatchTitle: "No matching wikis",
    noMatchBody: "Try another repo, title, or description.",
    submitLabel: "Generate wiki",
    sourcePlaceholder: "GitHub repo, URL, or local path",
    refresh: "Refresh",
    library: "Library",
    sortAria: "Sort wikis",
    sortUpdated: "Recently updated",
    sortTitle: "Title",
    sortPageCount: "Page count",
    view: "View",
    gridView: "Grid view",
    listView: "List view",
    maxPages: "Max pages",
    pageLimitTitle: "The agent chooses the useful number of pages up to this limit.",
    quotaTitle: "Above 20 pages can consume more provider quota. The agent still chooses the smallest useful count up to this limit.",
    quotaSuffix: " · quota",
    format: "Format",
    docsFormatTitle: "Documentation mode uses the built-in docs generator format",
    docsFormatDetail: "Guides · reference · troubleshooting",
    chooseFormatTitle: "Choose wiki format",
    formatAria: "Wiki format",
    savedPrompts: "Saved prompts",
    custom: "Custom",
    editFormatPrompt: "Edit format prompt",
    languages: "Languages",
    selectedLanguage: "Selected language",
    generatedLanguage: "Generated wiki content uses this language.",
    startAnother: "Start another wiki",
  };
}

function workspaceCopyFor(kind: WorkspaceKind, deps: WikiWorkspaceDeps): WorkspaceCopy {
  const defaults = workspaceCopy(kind);
  return { ...defaults, ...(deps.workspaceCopy?.(kind, defaults) || {}) };
}

function workspaceRecords(wikis: WikiRecord[], kind: "wiki" | "docs"): WikiRecord[] {
  return (wikis || []).filter((wiki) => (kind === "docs" ? isDocumentationWiki(wiki) : !isDocumentationWiki(wiki)));
}

function workspaceRuns(runs: WikiRecord[], kind: "wiki" | "docs"): WikiRecord[] {
  return (runs || []).filter((run) => (kind === "docs" ? isDocumentationRun(run) : !isDocumentationRun(run)));
}

export function renderWikiLibraryContents(wikis: WikiRecord[], deps: WikiWorkspaceDeps, hasSearch = false, kind: "wiki" | "docs" = "wiki"): string {
  if (wikis.length) return wikis.map((wiki) => renderWikiCard(wiki, deps)).join("");
  const copy = workspaceCopyFor(kind, deps);
  return `<div class="wiki-empty"><span>${deps.icon(hasSearch ? "search" : kind === "docs" ? "page" : "book")}</span><strong>${deps.escape(hasSearch ? copy.noMatchTitle : copy.emptyTitle)}</strong><p>${deps.escape(hasSearch ? copy.noMatchBody : copy.emptyBody)}</p></div>`;
}

function wikiStyleMeta(value: string): { group: string; summary: string; outputs: string[]; badge?: string } {
  return WIKI_FORMAT_META[normalizeWikiStyleForUi(value)] || WIKI_FORMAT_META.technical;
}

function wikiFormatSamplePeek(value: string): { title: string; body: string; lines: string[] } {
  return WIKI_FORMAT_SAMPLE_PEEKS[normalizeWikiStyleForUi(value)] || WIKI_FORMAT_SAMPLE_PEEKS.technical;
}
const WIKI_LANGUAGE_OPTIONS = [
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "pt", label: "Portuguese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "ru", label: "Russian" },
  { id: "ar", label: "Arabic" },
  { id: "he", label: "Hebrew" },
  { id: "id", label: "Bahasa Indonesia" },
  { id: "zh-Hans", label: "Mandarin 简体" },
  { id: "zh-Hant", label: "Mandarin 繁體" },
  { id: "ms", label: "Bahasa Malaysia" },
] as const;

function isCustomWikiStyle(value: string): boolean {
  return value === "custom" || value.startsWith("custom:");
}

function wikiPresetId(value: string): string {
  return value.startsWith("custom:") ? value.slice("custom:".length) : "";
}

function wikiStylePreset(state: WikiWorkspaceState): Record<string, string> | null {
  const id = wikiPresetId(state.wikiStyle || "");
  return id ? (state.wikiStylePresets || []).find((preset) => preset.id === id) || null : null;
}

function wikiStyleSelectionLabel(state: WikiWorkspaceState, copy: WikiGeneratorCopy = DEFAULT_WIKI_GENERATOR_COPY): string {
  const preset = wikiStylePreset(state);
  if (preset?.name) return preset.name;
  return copy.formatLabel(state.wikiStyle || "technical");
}

function selectedWikiLanguages(state: WikiWorkspaceState): string[] {
  const supported = WIKI_LANGUAGE_OPTIONS.map((option) => option.id);
  const selected = (state.wikiLanguages || [])
    .map((language) => (language === "zh" ? "zh-Hans" : language))
    .find((language) => supported.includes(language as any));
  return selected ? [selected] : ["en"];
}

function wikiLanguageSummary(state: WikiWorkspaceState, copy: WikiGeneratorCopy = DEFAULT_WIKI_GENERATOR_COPY): string {
  const selected = selectedWikiLanguages(state);
  if (selected.length === 1) {
    const option = WIKI_LANGUAGE_OPTIONS.find((item) => item.id === selected[0]);
    return copy.languageLabel(selected[0] || "en", option?.label || "English");
  }
  return copy.languageSummary(selected.length);
}

export function wikiStylePromptPreview(value: string, customPrompt = ""): string {
  const custom = customPrompt.trim();
  const style = normalizeWikiStyleForUi(value);
  const prompts: Record<string, string> = {
    basic: [
      "Use the original repository-wiki format: a balanced DeepWiki-style repository guide.",
      "Let the repo shape decide the table of contents instead of forcing an architecture, workflow, or techcrunch journal frame.",
      "Pages should explain selected topics clearly from verified source evidence.",
    ].join("\n"),
    technical: [
      "Design the table of contents as a comprehensive developer reference.",
      "Prefer architecture, module responsibilities, APIs, data flows, integrations, and operational surfaces.",
      "Pages should use a clear, professional technical voice with precise citations.",
    ].join("\n"),
    "first-30": [
      "Design the wiki for a reader's first 30 minutes in the repo.",
      "Prioritize orientation, entry points, what to read first, glossary terms, setup signals, and what matters now.",
      "Use the README as a map, then surface important non-README files that make the system real.",
    ].join("\n"),
    eli5: [
      "Design the wiki as an Explain Like I'm 5 guide for a smart newcomer.",
      "Use plain language, small analogies, and simple cause-and-effect explanations for what the repo does and why it matters.",
      "Stay source-grounded: simplify concepts, but never invent facts or hide important caveats.",
    ].join("\n"),
    "mental-model": [
      "Design the wiki to build a durable mental model of the system.",
      "Prioritize core flows, invariants, boundaries, state ownership, failure modes, and what changes safely.",
      "Prefer explanations that help the reader reason without constantly reopening the repo.",
    ].join("\n"),
    "socratic-exploration": [
      "Design the wiki as first-principles Socratic exploration.",
      "Break the repo down through sharp questions, reframes, simplest-system reasoning, and evidence-backed answers.",
      "Avoid generic Q&A theater; every question should reveal why the system is shaped this way.",
    ].join("\n"),
    "feature-scout": [
      "Design the wiki as a feature scout report.",
      "Find features worth exploring, demoing, copying, or productizing, especially details not advertised in the README.",
      "Tie every feature to the files, workflows, prompts, commands, or UI surfaces that make it work.",
    ].join("\n"),
    "worth-stealing": [
      "Design the wiki around what is worth stealing from this repo.",
      "Extract elegant designs, best practices, reusable patterns, and concrete porting recipes.",
      "Explain why each move works, when not to copy it, and what must change to reuse it elsewhere.",
    ].join("\n"),
    "hidden-quirks": [
      "Design the wiki around hidden quirks worth studying.",
      "Look past the README for unusual implementation details, constraints, hacks, safety rails, edge cases, and tiny high-leverage choices.",
      "Make each page answer: what would a casual reader miss, and why does it matter?",
    ].join("\n"),
    "pattern-discovery": [
      "Design the wiki to discover architecture and product patterns the reader may not know to ask for.",
      "Surface repeated patterns, runtime abstractions, provider boundaries, routing decisions, workflows, and design moves.",
      "When multiple repos are provided, compare patterns across them; otherwise compare patterns within this repo.",
    ].join("\n"),
    "repo-comparison": [
      "Design the wiki as a comparison brief.",
      "For 2+ repos, explain what each repo does better, where they differ, and which ideas are portable.",
      "For one repo, compare internal subsystems or approaches that solve similar problems differently.",
    ].join("\n"),
    "debugging-atlas": [
      "Design the wiki as a debugging atlas.",
      "Prioritize symptoms, probes, logs, state transitions, root-cause paths, observability hooks, and regression checks.",
      "Show where to inspect first and what evidence separates likely causes.",
    ].join("\n"),
    "tech-reader": [
      "Design the wiki as an easy-to-digest TechCrunch/Hacker News-style technical breakdown.",
      "Write for curious technical readers: clear hook, why it matters, mechanism, tradeoffs, surprising details, and what builders should notice.",
      "Keep it source-grounded and avoid hype, launch-post fluff, or unsupported claims.",
    ].join("\n"),
    documentation: [
      "Design the output as a technical repository documentation site artifact.",
      "Infer a docs manifest first: navigation groups, route pages, page archetypes, and the exact page count the repository deserves.",
      "Prioritize public entry points, exact commands, APIs, schemas, configuration, examples, errors, troubleshooting, changelog/migrations, and contributing where the repository supports them.",
      "Keep it functional, agent-friendly, and human-readable. Do not over-explain, teach generic concepts, or add product-shaped pages the repo does not support.",
      "Use frontmatter and Docs MDX components where they clarify the page: callouts, cards, steps, tabs, code groups, fields, request/response examples, endpoint frames, accordions, frames, updates, file trees, tables, code fences, and Mermaid only when useful.",
    ].join("\n"),
    custom: custom || [
      "Write your custom wiki format brief here.",
      "You can shape audience, tone, examples, section titles, and explanation style.",
      "The brief must not override source grounding, citations, page count, or safety requirements.",
    ].join("\n"),
  };
  return prompts[style] || prompts.technical;
}

export function renderWikiWorkspace(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  if (
    state.activeWiki &&
    state.wikiSlidesViewer?.viewerUrl &&
    (!state.wikiSlidesViewer.wikiKey || state.wikiSlidesViewer.wikiKey === wikiOpenKey(state.activeWiki))
  ) {
    return renderWikiSlidesViewer(state.activeWiki, state, deps);
  }
  return state.activeWiki ? renderWikiReader(state.activeWiki, state, deps) : renderWikiGallery(state, deps);
}

export function renderWikiGallery(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const kind = workspaceKind(state);
  const copy = workspaceCopyFor(kind, deps);
  const wikis = filterWikis(workspaceRecords(state.wikis || [], kind), state.wikiSearch || "", state.wikiSort || "updated");
  const runs = workspaceRuns(Array.isArray(state.wikiRuns) ? state.wikiRuns : [], kind);
  const view = state.wikiViewMode === "list" ? "list" : "grid";
  const hasSearch = !!String(state.wikiSearch || "").trim();
  return `
    <section class="wiki-native wiki-gallery-view ${kind === "docs" ? "docs-gallery-view" : ""}" data-workspace-kind="${kind}">
      <div class="wiki-scroll">
        <div class="wiki-page-head surface-memory-cover wiki-memory-cover">
          <div>
            <span class="eyebrow">${deps.escape(copy.eyebrow)}</span>
            <h1>${deps.escape(copy.title)}</h1>
            <p>${deps.escape(copy.description)}</p>
          </div>
        </div>
        ${renderWikiGeneratePanel(state, deps)}
        <div class="wiki-library-head">
          <div>
            <span class="eyebrow">${deps.escape(copy.library)}</span>
            <strong data-wiki-library-count>${deps.escape(copy.savedCount(wikis.length))}</strong>
          </div>
        </div>
        <div class="wiki-toolbar">
          <label class="wiki-search-box">${deps.icon("search")}<input id="wiki-search-input" type="search" value="${deps.escape(state.wikiSearch || "")}" placeholder="${deps.escape(copy.searchPlaceholder)}" autocomplete="off" /></label>
          <div class="wiki-toolbar-actions">
            <select id="wiki-sort-select" aria-label="${deps.escape(copy.sortAria)}">
              <option value="updated" ${state.wikiSort === "updated" ? "selected" : ""}>${deps.escape(copy.sortUpdated)}</option>
              <option value="title" ${state.wikiSort === "title" ? "selected" : ""}>${deps.escape(copy.sortTitle)}</option>
              <option value="pages" ${state.wikiSort === "pages" ? "selected" : ""}>${deps.escape(copy.sortPageCount)}</option>
            </select>
            <div class="wiki-view-toggle" role="group" aria-label="${deps.escape(copy.view)}">
              <button class="${view === "grid" ? "active" : ""}" type="button" data-wiki-view="grid" title="${deps.escape(copy.gridView)}">${deps.icon("book")}</button>
              <button class="${view === "list" ? "active" : ""}" type="button" data-wiki-view="list" title="${deps.escape(copy.listView)}">${deps.icon("more")}</button>
            </div>
          </div>
        </div>
        ${runs.length ? `<div class="wiki-run-strip">${runs.map((run) => renderWikiRunCard(run, deps)).join("")}</div>` : ""}
        <div class="wiki-library ${view === "list" ? "wiki-library-list" : "wiki-library-grid"}" data-wiki-library-results>
          ${renderWikiLibraryContents(wikis, deps, hasSearch, kind)}
        </div>
        <div class="wiki-count" data-wiki-count>${deps.escape(copy.count(wikis.length))}</div>
      </div>
    </section>
  `;
}

// Agent-mode compose surface: the intent textarea (or, once an interview is in
// flight, the AskUserQuestions card). Rendered only in agent mode + wiki route.
// Pure: reads state + deps, returns markup. The single submit button here is the
// ONLY submit affordance in agent mode (the manual controls bar is omitted), so
// the document submit listener can branch on mode without ambiguity.
export function renderWikiAgentSurface(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const interview = state.wikiAgentInterview;
  if (interview && Array.isArray(interview.questions) && interview.questions.length) {
    return renderAskUserQuestions(interview, {
      escape: deps.escape,
      icon: deps.icon,
      copy: deps.askQuestionsCopy || DEFAULT_ASK_QUESTIONS_COPY,
    });
  }
  const copy = wikiAgentCopy(deps);
  const busy = !!state.wikiAgentBusy;
  const err = String(state.wikiAgentError || "").trim();
  return `
    <div class="wiki-agent-intent ${busy ? "is-busy" : ""}" data-wiki-agent-intent-surface>
      <label class="wiki-agent-intent-field">
        <textarea id="wiki-agent-intent-input" rows="3" placeholder="${deps.escape(copy.intentPlaceholder)}" ${busy ? "disabled" : ""}>${deps.escape(state.wikiAgentIntent || "")}</textarea>
      </label>
      ${err ? `<p class="wiki-agent-error" role="alert">${deps.icon("alert")}<span>${deps.escape(err)}</span></p>` : ""}
    </div>
  `;
}

// Whether the agent compose surface is currently showing the AskUserQuestions
// interview card (vs the plain intent textarea). When true, the panel hides the
// scope row + footer so the card stands alone (mirrors the Ask clarify surface).
export function wikiAgentInterviewActive(state: WikiWorkspaceState): boolean {
  const interview = state.wikiAgentInterview;
  return !!(interview && Array.isArray(interview.questions) && interview.questions.length);
}

export function renderWikiGeneratePanel(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const kind = workspaceKind(state);
  const copy = workspaceCopyFor(kind, deps);
  const generatorCopy = wikiGeneratorCopy(deps);
  const isDocs = kind === "docs";
  const scopeCopy = deps.scopeCopy || {};
  const sources = deps.splitScopeText(state.wikiSourcesInput || "");
  const sourceValue = sources.join("\n");
  const pageCount = Math.max(1, Math.min(WIKI_PAGE_COUNT_MAX, Number(state.wikiPageCount || 1)));
  const quotaHeavyPageCount = pageCount > 20;
  const isCustom = !isDocs && isCustomWikiStyle(state.wikiStyle || "");
  const selectedBuiltinStyle = isDocs ? "documentation" : normalizeWikiStyleForUi(state.wikiStyle || "");
  const selectedPresetId = wikiPresetId(state.wikiStyle || "");
  const languages = selectedWikiLanguages(state);
  // Agent mode is the default on the wiki compose surface; docs never uses it.
  const agentMode = !isDocs && (state.wikiAgentMode || "agent") === "agent";
  const agentCopy = wikiAgentCopy(deps);
  // Agent mode mirrors the Ask composer: ONE unified surface - the intent textarea
  // is the borderless primary input at the TOP, the repo/scope sits below it as a
  // thin chip row (not a tall box), and the mode toggle moves into the footer next
  // to submit. Manual mode keeps its original order (toggle -> scope -> controls).
  const modeToggle = isDocs
    ? ""
    : `<div class="wiki-mode-toggle" role="group" aria-label="${deps.escape(agentCopy.modeAria)}">
        <button type="button" class="${agentMode ? "active" : ""}" data-wiki-mode="agent" aria-pressed="${agentMode}"><span>${deps.escape(agentCopy.modeAgent)}</span></button>
        <button type="button" class="${agentMode ? "" : "active"}" data-wiki-mode="manual" aria-pressed="${!agentMode}"><span>${deps.escape(agentCopy.modeManual)}</span></button>
      </div>`;
  // When the agent interview card is showing, it stands alone (scope + footer
  // hidden), mirroring the Ask clarify surface.
  const agentInterview = agentMode && wikiAgentInterviewActive(state);
  const agentBusy = !!state.wikiAgentBusy;
  return `
    <form class="wiki-generate-panel composer large ${isDocs ? "docs-generate-panel" : ""} ${agentMode ? "is-agent-mode" : ""} ${agentInterview ? "is-agent-interview" : ""}" data-wiki-generate-form>
      <input id="wiki-sources-input" type="hidden" value="${deps.escape(sourceValue)}" />
      <input id="wiki-language-value" type="hidden" value="${deps.escape(languages[0] || "en")}" />
      ${agentMode ? renderWikiAgentSurface(state, deps) : modeToggle}
      <div class="wiki-scope-editor scope-editor" data-wiki-scope-editor>
        <div class="scope-token-row wiki-scope-token-row" data-wiki-scope-token-row>
          ${sources
            .map((source, index) => {
              const label = deps.scopeDisplayLabel?.(source) || deps.scopeLabel(source);
              const branch = deps.scopeBranchDisplay?.(source) || deps.scopeBranchLabel?.(source) || scopeCopy.defaultBranch || "default";
              const branchSet = !!deps.scopeBranchLabel?.(source);
              return `<span class="scope-token" title="${deps.escape(source)}"><strong>${deps.escape(label)}</strong><button class="scope-token-branch ${branchSet ? "is-set" : ""}" type="button" data-open-wiki-source-branch-index="${index}" aria-label="${deps.escape(scopeCopy.chooseBranchAria?.(label) || `Choose branch for ${label}`)}" title="${deps.escape(scopeCopy.chooseBranchTitle || "Choose branch or ref")}"><span>${deps.escape(branch)}</span></button><button class="scope-token-remove" type="button" data-remove-wiki-source-index="${index}" aria-label="${deps.escape(scopeCopy.removeSource || `Remove ${label}`)}">${deps.icon("x")}</button></span>`;
            })
            .join("")}
          <input id="wiki-source-entry" value="" placeholder="${deps.escape(sources.length ? scopeCopy.addAnotherPlaceholder || "Add another repo or path" : scopeCopy.sourcePlaceholder || copy.sourcePlaceholder)}" autocomplete="off" spellcheck="false" />
          ${state.wikiBranchMenuOpen && sources.length && deps.renderScopeBranchPanel ? deps.renderScopeBranchPanel(sources) : ""}
        </div>
        <button class="scope-add" type="button" data-add-wiki-source title="${deps.escape(scopeCopy.addSource || "Add source")}">${deps.icon("plus")}<span>${deps.escape(scopeCopy.addShort || "Add")}</span></button>
        <button class="scope-picker" type="button" data-wiki-pick-local title="${deps.escape(scopeCopy.openLocalFolder || "Open local folder")}">${deps.icon("folderOpen")}<span>${deps.escape(scopeCopy.local || "Local")}</span></button>
      </div>
      ${agentMode && !isDocs ? `<div class="wiki-agent-footer">
        ${modeToggle}
        ${deps.renderLocalCliControl()}
        <span class="wiki-agent-footer-spacer"></span>
        ${agentBusy ? `<span class="wiki-agent-thinking"><i class="recent-spinner" aria-hidden="true"></i><span>${deps.escape(agentCopy.thinking)}</span></span>` : ""}
        <button class="wiki-primary-button" type="submit" ${agentBusy ? "disabled" : ""} aria-label="${deps.escape(agentCopy.start)}" title="${deps.escape(agentCopy.start)}">${deps.icon("arrowUp")}</button>
      </div>` : ""}
      ${state.wikiHotkeyRequest ? renderWikiHotkeyConfirmation(state, deps) : ""}
      ${agentMode ? "" : `<div class="wiki-generate-controls">
        ${deps.renderRuntimeControl()}
        ${deps.renderLegacyModeControl()}
        ${deps.renderLocalCliControl()}
        ${isDocs ? "" : `<label class="wiki-pages-slider ${quotaHeavyPageCount ? "is-quota-heavy" : ""}" title="${deps.escape(quotaHeavyPageCount ? copy.quotaTitle : copy.pageLimitTitle)}"><span>${deps.escape(copy.maxPages)}</span><input id="wiki-page-count-input" type="range" min="1" max="${WIKI_PAGE_COUNT_MAX}" step="1" value="${pageCount}" /><output id="wiki-page-count-output" for="wiki-page-count-input">${deps.escape(generatorCopy.autoPageCount(pageCount))}${quotaHeavyPageCount ? deps.escape(copy.quotaSuffix) : ""}</output></label>`}
        ${isDocs ? `<div class="wiki-format-control docs-format-static" title="${deps.escape(copy.docsFormatTitle)}">
          <span>${deps.escape(copy.format)}</span>
          <strong>${deps.escape(generatorCopy.formatLabel("documentation"))}</strong>
          <small>${deps.escape(copy.docsFormatDetail)}</small>
        </div>` : `<div class="wiki-format-control ${isCustom ? "is-custom" : ""}">
          <label class="wiki-format-select" title="${deps.escape(copy.chooseFormatTitle)}">
            <span>${deps.escape(copy.format)}</span>
            <select id="wiki-style-select" aria-label="${deps.escape(copy.formatAria)}">
              ${WIKI_BUILTIN_STYLE_OPTIONS.map((style) => `<option value="${style}" ${selectedBuiltinStyle === style ? "selected" : ""}>${deps.escape(generatorCopy.formatLabel(style))}</option>`).join("")}
              ${(state.wikiStylePresets || []).length ? `<optgroup label="${deps.escape(copy.savedPrompts)}">${(state.wikiStylePresets || []).map((preset) => `<option value="custom:${deps.escape(preset.id)}" ${selectedPresetId === preset.id ? "selected" : ""}>${deps.escape(preset.name)}</option>`).join("")}</optgroup>` : ""}
              <option value="custom" ${state.wikiStyle === "custom" ? "selected" : ""}>${deps.escape(copy.custom)}</option>
            </select>
            <span class="wiki-format-chevron" aria-hidden="true">${deps.icon("chevronDown")}</span>
          </label>
          <button class="wiki-format-edit-button" type="button" data-wiki-format-open title="${deps.escape(copy.editFormatPrompt)}" aria-label="${deps.escape(copy.editFormatPrompt)}">${deps.icon("edit")}</button>
          ${state.wikiFormatOpen ? renderWikiFormatModal(state, deps) : ""}
        </div>`}
        <details class="wiki-language-control">
          <summary><span>${deps.escape(copy.languages)}</span><strong>${deps.escape(wikiLanguageSummary(state, generatorCopy))}</strong></summary>
          <div class="wiki-language-popover">
            <div class="wiki-language-head"><strong>${deps.escape(copy.selectedLanguage)}</strong><span>${deps.escape(copy.generatedLanguage)}</span></div>
            <div class="wiki-language-grid">
              ${WIKI_LANGUAGE_OPTIONS.map((language) => `<label><input type="radio" name="wiki-language" data-wiki-language="${deps.escape(language.id)}" ${languages.includes(language.id) ? "checked" : ""} /> <span>${deps.escape(generatorCopy.languageLabel(language.id, language.label))}</span></label>`).join("")}
            </div>
          </div>
        </details>
        <button class="wiki-primary-button" type="submit" aria-label="${deps.escape(state.wikiGenerating ? copy.startAnother : copy.submitLabel)}" title="${deps.escape(state.wikiGenerating ? copy.startAnother : copy.submitLabel)}">${deps.icon("arrowUp")}</button>
      </div>`}
      ${isDocs ? "" : renderWikiReusePanel(state, deps, sources)}
      ${state.wikiProgress && wikiProgressIsDocs(state.wikiProgress) === isDocs ? renderWikiProgress(state.wikiProgress, deps) : ""}
    </form>
  `;
}
// A run's progress only renders on the surface that owns it (docs run on the
// docs panel, wiki run on the wiki panel), keyed off the workspaceKind stamped
// at run start — prevents a docs generation bleeding into the wiki surface.
function wikiProgressIsDocs(progress: Record<string, any>): boolean {
  return /doc/i.test(String(progress?.kind || progress?.workspaceKind || progress?.surfaceKind || ""));
}

function renderWikiReusePanel(state: WikiWorkspaceState, deps: WikiWorkspaceDeps, sources: string[]): string {
  const copy = wikiGeneratorCopy(deps);
  const query = wikiReuseQueryForSources(sources);
  if (!query) return "";
    const localMatches = (state.wikis || [])
      .filter((wiki) => String(wiki.owner || "").toLowerCase() === query.owner.toLowerCase())
      .filter((wiki) => String(wiki.repo || "").toLowerCase() === query.repo.toLowerCase())
      .filter((wiki) => !query.branch || !wiki.branch || String(wiki.branch || "") === query.branch)
      .filter((wiki) => !query.sourcePath || String(wiki.sourcePath || "") === query.sourcePath)
      .slice(0, 2);
  const publicState = state.wikiReusePublic || {};
  const publicMatches = publicState.key === query.key && Array.isArray(publicState.items) ? publicState.items.slice(0, 3) : [];
  const loading = publicState.key === query.key && publicState.loading === true;
  const error = publicState.key === query.key && typeof publicState.error === "string" ? publicState.error : "";
  const searched = publicState.key === query.key && publicState.searched === true;
  const noPublicMatch = searched && !publicMatches.length && !loading && !error;
  const publicBaseUrl = String(publicState.publicWikiBaseUrl || publicState.baseUrl || deps.publicWikiBaseUrl || "").replace(/\/+$/, "");
  const hasMatches = localMatches.length > 0 || publicMatches.length > 0;
  const heading = localMatches.length
    ? copy.reuseSavedMatch
    : publicMatches.length
      ? copy.reusePublicMatch
      : noPublicMatch
        ? copy.reuseNoPublicWikiYet
        : copy.reuseSearchBeforeGenerating;
  const detail = localMatches.length
    ? copy.reuseSavedDetail(query.label)
    : publicMatches.length
      ? copy.reusePublicDetail(query.label)
      : noPublicMatch
        ? copy.reuseNoPublicDetail(query.label)
        : copy.reuseSearchDetail;
  const publicActionLabel = loading
    ? copy.reuseSearching
    : publicMatches.length
      ? copy.reuseRefresh
      : noPublicMatch
        ? copy.reuseSearchAgain
        : copy.reuseSearchPublic;
  return `
    <section class="wiki-reuse-panel ${hasMatches ? "has-matches" : "is-search-only"}" data-wiki-reuse-panel>
      <div class="wiki-reuse-summary">
        <span class="wiki-reuse-icon">${deps.icon(localMatches.length ? "book" : publicMatches.length ? "globe" : "search")}</span>
        <div>
          <strong>${deps.escape(heading)}</strong>
          <p>${deps.escape(detail)}</p>
        </div>
      </div>
      ${hasMatches ? `<div class="wiki-reuse-list">
        ${localMatches.map((wiki) => {
          const openKey = wikiOpenKey(wiki);
          const pages = Number(wiki.pageCount || Object.keys(wiki.pages || {}).length || 0);
          return `<button class="wiki-reuse-row" type="button" data-wiki-open="${deps.escape(openKey)}">
            <span class="wiki-reuse-kind">${deps.escape(copy.reuseSavedKind)}</span>
            <span class="wiki-reuse-main"><strong>${deps.escape(wiki.title || wiki.structure?.title || query.label)}</strong><small>${deps.escape(`${copy.pageCount(pages)} · ${copy.formatLabel(wiki.wikiStyle || "technical")}`)}</small></span>
            <span class="wiki-reuse-action">${deps.escape(copy.reuseOpen)}</span>
          </button>`;
        }).join("")}
        ${publicMatches.map((item) => {
          const href = String(item.href || item.publicUrl || "");
          const url = href.startsWith("http")
            ? href
            : publicBaseUrl
              ? `${publicBaseUrl}${href.startsWith("/") ? href : `/${href}`}`
              : href.startsWith("/") ? href : `/${href}`;
          return `<a class="wiki-reuse-row" href="${deps.escape(url)}" target="_blank" rel="noreferrer" data-open-external-url="${deps.escape(url)}">
            <span class="wiki-reuse-kind">${deps.escape(copy.reusePublicKind)}</span>
            <span class="wiki-reuse-main"><strong>${deps.escape(String(item.title || item.repository || query.label))}</strong><small>${deps.escape(`${copy.pageCount(Number(item.pages || 0))} · ${String(item.formatLabel || item.format || "wiki")}`)}</small></span>
            <span class="wiki-reuse-action">${deps.escape(copy.reuseView)}</span>
          </a>`;
        }).join("")}
      </div>` : ""}
      <div class="wiki-reuse-public-slot">
        ${loading ? `<span class="wiki-reuse-status is-loading">${deps.icon("globe")}<span>${deps.escape(copy.reuseSearchingGallery)}</span></span>` : ""}
        ${error ? `<span class="wiki-reuse-status is-error">${deps.icon("alert")}<span>${deps.escape(error)}</span></span>` : ""}
        ${noPublicMatch && !error ? `<span class="wiki-reuse-status">${deps.icon("globe")}<span>${deps.escape(copy.reuseNoPublicWiki)}</span></span>` : ""}
        <button class="wiki-reuse-public" type="button" data-wiki-reuse-public data-wiki-reuse-key="${deps.escape(query.key)}" data-wiki-reuse-label="${deps.escape(query.label)}" title="${deps.escape(copy.reuseSearchTitle(query.label))}" ${loading ? "disabled" : ""}>
          ${deps.icon("globe")}<span>${deps.escape(publicActionLabel)}</span>
        </button>
      </div>
    </section>
  `;
}

function renderWikiHotkeyConfirmation(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const request = state.wikiHotkeyRequest || {};
  const mode = state.wikiHotkeyMode === "instant" ? "instant" : "confirm";
  const error = String(request.error || "").trim();
  const sourceLabel = String(request.sourceLabel || request.sourceUrl || copy.sourceFallback);
  const sourceBranch = String(request.sourceBranch || "").trim();
  const detail = error
    ? error
    : sourceBranch
      ? `${sourceLabel} · ${sourceBranch}`
      : sourceLabel;
  return `
    <section class="wiki-hotkey-confirm ${error ? "is-error" : ""}" aria-label="${deps.escape(copy.hotkeyAria)}">
      <span class="wiki-hotkey-confirm-icon">${deps.icon(error ? "alert" : "key")}</span>
      <div class="wiki-hotkey-confirm-copy">
        <strong>${deps.escape(error ? copy.hotkeyNoGithubRepoFound : copy.hotkeyReadyFromBrowser)}</strong>
        <span>${deps.escape(detail)}</span>
      </div>
      <div class="wiki-hotkey-confirm-actions">
        ${error ? "" : `<button class="wiki-hotkey-generate" type="submit" data-wiki-hotkey-generate>${deps.icon("arrowUp")}<span>${deps.escape(copy.generate)}</span></button>`}
        <div class="wiki-hotkey-mode-toggle" role="group" aria-label="${deps.escape(copy.hotkeyModeAria)}">
          <button type="button" class="${mode === "confirm" ? "active" : ""}" data-wiki-hotkey-mode="confirm" title="${deps.escape(copy.hotkeyConfirmTitle)}">${deps.escape(copy.hotkeyConfirm)}</button>
          <button type="button" class="${mode === "instant" ? "active" : ""}" data-wiki-hotkey-mode="instant" title="${deps.escape(copy.hotkeyAutoRunTitle)}">${deps.escape(copy.hotkeyAutoRun)}</button>
        </div>
        <button class="wiki-hotkey-dismiss" type="button" data-wiki-hotkey-dismiss aria-label="${deps.escape(copy.dismiss)}">${deps.icon("x")}</button>
      </div>
    </section>
  `;
}

function renderWikiFormatModal(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const selected = isCustomWikiStyle(state.wikiStyle || "") ? "custom" : normalizeWikiStyleForUi(state.wikiStyle || "");
  const preset = wikiStylePreset(state);
  const promptName = state.wikiStylePromptName || preset?.name || copy.customPromptFallback;
  const prompt = selected === "custom"
    ? (state.wikiStylePrompt || preset?.prompt || wikiStylePromptPreview("custom"))
    : wikiStylePromptPreview(selected, state.wikiStylePrompt || "");
  const selectedMeta = copy.formatMeta(selected, wikiStyleMeta(selected));
  const samplePeek = copy.formatSample(selected, wikiFormatSamplePeek(selected));
  return `
    <div class="wiki-format-popover">
      <section class="wiki-format-modal" role="dialog" aria-modal="true" aria-label="${deps.escape(copy.formatPromptAria)}">
        <div class="wiki-format-head">
          <div>
            <span class="eyebrow">${deps.escape(copy.formatEyebrow)}</span>
            <h2>${deps.escape(selected === "custom" ? wikiStyleSelectionLabel(state, copy) : copy.formatLabel(selected))}</h2>
            <p>${deps.escape(selected === "custom" ? copy.reusableFormatDetail : selectedMeta.summary)}</p>
          </div>
          <button class="wiki-quiet-button" type="button" data-wiki-format-close aria-label="${deps.escape(copy.close)}">${deps.icon("x")}</button>
        </div>
        <div class="wiki-format-body">
          <div class="wiki-format-options" role="listbox" aria-label="${deps.escape(copy.wikiFormatsAria)}">
            ${WIKI_FORMAT_GROUPS.map((group) => {
              const options = WIKI_BUILTIN_STYLE_OPTIONS.filter((style) => wikiStyleMeta(style).group === group);
              return `<div class="wiki-format-group">
                <div class="wiki-format-group-label">${deps.escape(copy.formatMeta(options[0] || "technical", wikiStyleMeta(options[0] || "technical")).group)}</div>
                ${options.map((style) => {
                  const meta = copy.formatMeta(style, wikiStyleMeta(style));
                  return `<button class="${selected === style ? "active" : ""}" type="button" data-wiki-style-choice="${deps.escape(style)}">
                    <span><strong>${deps.escape(copy.formatLabel(style))}</strong>${meta.badge ? `<em>${deps.escape(meta.badge)}</em>` : ""}</span>
                    <small>${deps.escape(meta.summary)}</small>
                  </button>`;
                }).join("")}
              </div>`;
            }).join("")}
            <div class="wiki-format-group">
              <div class="wiki-format-group-label">${deps.escape(copy.customGroup)}</div>
              ${(state.wikiStylePresets || []).map((preset) => `<button class="${wikiPresetId(state.wikiStyle || "") === preset.id ? "active" : ""}" type="button" data-wiki-style-choice="custom:${deps.escape(preset.id)}">
                <span><strong>${deps.escape(preset.name)}</strong></span>
                <small>${deps.escape((preset.prompt || "").split("\n")[0] || copy.savedCustomPrompt)}</small>
              </button>`).join("")}
              <button class="${state.wikiStyle === "custom" ? "active" : ""}" type="button" data-wiki-style-choice="custom">
                <span><strong>${deps.escape(copy.newCustomPrompt)}</strong></span>
                <small>${deps.escape(copy.newCustomPromptDetail)}</small>
              </button>
            </div>
          </div>
          ${selected === "custom"
            ? `<label class="wiki-format-prompt">
                <span>${deps.escape(copy.customPrompt)}</span>
                <input id="wiki-style-preset-name-input" value="${deps.escape(promptName)}" placeholder="${deps.escape(copy.promptNamePlaceholder)}" autocomplete="off" spellcheck="false" />
                <textarea id="wiki-style-prompt-input" rows="11" spellcheck="false">${deps.escape(prompt)}</textarea>
              </label>`
            : `<section class="wiki-format-preview" aria-label="${deps.escape(copy.selectedFormatOutcome)}">
                <span class="eyebrow">${deps.escape(copy.whatThisProduces)}</span>
                <h3>${deps.escape(copy.formatLabel(selected))}</h3>
                <p>${deps.escape(selectedMeta.summary)}</p>
                <ul>
                  ${selectedMeta.outputs.map((item) => `<li>${deps.escape(item)}</li>`).join("")}
                </ul>
                <div class="wiki-format-sample" aria-label="${deps.escape(copy.sampleOutputShape)}">
                  <span>${deps.escape(copy.samplePeek)}</span>
                  <strong>${deps.escape(samplePeek.title)}</strong>
                  <p>${deps.escape(samplePeek.body)}</p>
                  <div>
                    ${samplePeek.lines.map((line) => `<small>${deps.escape(line)}</small>`).join("")}
                  </div>
                </div>
                <textarea id="wiki-style-prompt-input" class="wiki-format-hidden-prompt" readonly tabindex="-1" aria-hidden="true">${deps.escape(prompt)}</textarea>
              </section>`}
        </div>
        <div class="wiki-format-actions">
          <button class="wiki-quiet-button" type="button" data-wiki-format-save-custom>${deps.escape(selected === "custom" ? copy.savePrompt : copy.saveAsCustom)}</button>
          <button class="wiki-primary-button" type="button" data-wiki-format-use>${deps.escape(copy.useFormat(copy.formatLabel(selected)))}</button>
        </div>
      </section>
    </div>
  `;
}

export function renderWikiProgress(progress: Record<string, any>, deps: WikiWorkspaceDeps): string {
  if (progress.kind === "notice" || progress.compact) return renderWikiProgressNotice(progress, deps);
  const copy = wikiGeneratorCopy(deps);
  const runId = String(progress.runId || "").trim();
  const runIdAttr = runId ? ` data-wiki-progress-run-id="${deps.escape(runId)}"` : "";
  const progressKind = /doc/i.test(String(progress.kind || progress.workspaceKind || progress.surfaceKind || ""))
    ? "docs"
    : "wiki";
  const artifactLabel = progressKind === "docs" ? copy.artifactDocs : copy.artifactWiki;
  const phase = String(progress.activePhase || "structure");
  const status = String(progress.status || "running");
  const statusLabel = status === "done" ? copy.statusSaved : status === "error" ? copy.statusFailed : status === "canceled" ? copy.statusStopped : copy.statusRunning;
  const pagesDone = Number(progress.pagesDone || 0);
  const pagesTotal = Math.max(0, Number(progress.pagesTotal || 0));
  const pageItems = Array.isArray(progress.pageItems) ? progress.pageItems : [];
  const activePages = pageItems.filter((page) => page?.state === "active").length;
  const selectedPage = pageItems.find((page) => String(page?.id || "") === String(progress.selectedPageId || "")) ||
    pageItems.find((page) => page?.state === "active") ||
    pageItems[0] ||
    null;
  const running = status !== "done" && status !== "error" && status !== "canceled";
  const activePageNumber = pagesTotal ? Math.min(pagesTotal, Math.max(1, pagesDone + 1)) : 0;
  const pagePercent = pagesTotal ? Math.min(100, Math.max(4, (pagesDone / pagesTotal) * 100)) : 4;
  const liveLabel = phase === "pages" && pagesTotal
    ? copy.writingPages(pagesDone, pagesTotal, activePages)
    : phase === "save"
      ? copy.savingArtifact(artifactLabel)
      : copy.planningStructure;
  const liveDetail = phase === "pages" && progress.currentPage
    ? String(progress.currentPage)
    : String(progress.detail || progress.structureDetail || copy.localCliWorking);
  const pageDots = pagesTotal > 1
    ? Array.from({ length: Math.min(pagesTotal, 12) }, (_, index) => {
        const dotState = index < pagesDone ? "done" : index === activePageNumber - 1 ? "active" : "waiting";
        return `<span class="${dotState}" title="${deps.escape(copy.pageDotTitle(index + 1))}"></span>`;
      }).join("")
    : "";
  const thought = String((phase === "pages" && selectedPage ? selectedPage.thoughtText : progress.thoughtText) || "").trim();
  const formattedThought = formatWikiThoughtCreditText(thought || copy.waitingForAgent);
  const thoughtLabel = phase === "pages" && selectedPage
    ? copy.agentNotesForPage(String(selectedPage.title || selectedPage.id || copy.pageFallback))
    : copy.agentNotes;
  const runtimeAgentId = String(progress.runtimeAgentId || "").trim();
  const runtimeLabel = String(progress.runtimeLabel || copy.runtimeFallback);
  const codeGraph = renderWikiCodeGraphRow(progress, deps);
  return `
    <div class="wiki-progress wiki-progress-rich ${deps.escape(status)}"${runIdAttr}>
      <div class="wiki-progress-head" data-wiki-progress-head>
        <span class="wiki-live-dot" aria-hidden="true"></span>
        <div>
          <strong data-wiki-progress-label>${deps.escape(String(progress.label || copy.generatingArtifact(artifactLabel)))}</strong>
          <span data-wiki-progress-detail>${deps.escape(`${statusLabel} · ${String(progress.detail || copy.preparingLocalRuntime)}`)}</span>
        </div>
        <div class="wiki-progress-head-actions" data-wiki-progress-head-actions>
          <em>${runtimeAgentId ? deps.modelLogo(runtimeAgentId, "model-logo wiki-progress-runtime-logo") : ""}<span>${deps.escape(runtimeLabel)}</span></em>
          ${running ? `<button class="wiki-progress-stop" type="button" data-stop-wiki title="${deps.escape(copy.stopGeneration(artifactLabel))}" aria-label="${deps.escape(copy.stopGeneration(artifactLabel))}">${deps.icon("stop")}<span>${deps.escape(copy.stop)}</span></button>` : ""}
        </div>
      </div>
      ${codeGraph}
      ${running
        ? `<div class="wiki-live-strip" data-wiki-live-strip>
            <div class="wiki-live-copy">
              <span data-wiki-live-label><i></i>${deps.escape(liveLabel)}</span>
              <strong data-wiki-live-detail>${deps.escape(liveDetail)}</strong>
            </div>
            <div class="wiki-live-meter" aria-hidden="true" data-wiki-live-meter><span data-wiki-live-meter-bar style="width: ${pagePercent}%"></span></div>
            ${pageDots ? `<div class="wiki-page-dots" aria-label="${deps.escape(copy.pageProgressAria)}" data-wiki-page-dots>${pageDots}</div>` : ""}
          </div>`
        : ""}
      ${pageItems.length
        ? `<div class="wiki-page-queue" aria-label="${deps.escape(copy.pageGenerationQueueAria)}" data-wiki-page-queue>
            ${pageItems
              .map((page, index) => {
                const pageState = String(page?.state || "waiting");
                const selected = selectedPage && String(selectedPage.id || "") === String(page?.id || "");
                return `<button class="wiki-page-queue-row ${deps.escape(pageState)} ${selected ? "selected" : ""}" type="button" data-wiki-progress-page="${deps.escape(String(page?.id || ""))}" data-wiki-progress-page-index="${index}">
                  <span>${pageState === "done" ? "✓" : pageState === "active" ? "●" : pageState === "failed" ? "!" : "○"}</span>
                  <strong>${deps.escape(String(page?.title || copy.pageTitle(index + 1)))}</strong>
                  <small>${deps.escape(String(page?.detail || (pageState === "waiting" ? copy.waiting : copy.working)))}</small>
                </button>`;
              })
              .join("")}
          </div>`
        : ""}
      <div class="wiki-thought-stream ${thought ? "" : "is-waiting"}" data-wiki-thought-stream>
        <span data-wiki-thought-label>${deps.escape(thoughtLabel)}</span>
        <p data-wiki-thought-text><span data-wiki-thought-roll>${deps.escape(formattedThought)}</span></p>
      </div>
    </div>
  `;
}

const WIKI_CODE_GRAPH_STATES = new Set(["indexing", "ready", "too-large", "skipped"]);

/**
 * The single "Code graph" status row (shared by wiki and docs generation). The
 * row element is always emitted so its height is reserved from generation start
 * (no layout shift when the first status lands); it stays visually empty until a
 * code-graph event sets progress.codeGraph. While indexing it shows the shared
 * recent-spinner; ready is a muted check; too-large and skipped are muted,
 * persistent text (terminal states do not disappear). NO sparkles, NO color.
 */
function renderWikiCodeGraphRow(progress: Record<string, any>, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const codeGraph = progress.codeGraph && typeof progress.codeGraph === "object" ? progress.codeGraph : null;
  const state = String(codeGraph?.state || "");
  const active = WIKI_CODE_GRAPH_STATES.has(state);
  const message = String(codeGraph?.message || "");
  const glyph = state === "indexing"
    ? '<i class="recent-spinner" aria-hidden="true"></i>'
    : `<span class="wiki-code-graph-glyph" aria-hidden="true">${state === "ready" ? "✓" : "•"}</span>`;
  const stateAttr = active ? deps.escape(state) : "";
  const live = state === "indexing" || state === "ready";
  return `<div class="wiki-code-graph ${active ? "is-active" : "is-idle"}${live ? " is-live" : ""}" data-wiki-code-graph data-wiki-code-graph-state="${stateAttr}" role="status">
      ${active ? glyph : ""}
      <span data-wiki-code-graph-text>${active ? deps.escape(message || copy.codeGraphLabel) : ""}</span>
    </div>`;
}

function renderWikiProgressNotice(progress: Record<string, any>, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const status = String(progress.status || "error");
  const statusLabel = status === "done" ? copy.statusReady : status === "error" ? copy.statusBlocked : status === "canceled" ? copy.statusStopped : copy.statusNotice;
  const runId = String(progress.runId || "").trim();
  const runIdAttr = runId ? ` data-wiki-progress-run-id="${deps.escape(runId)}"` : "";
  return `
    <div class="wiki-progress wiki-progress-notice ${deps.escape(status)}"${runIdAttr} role="${status === "error" ? "alert" : "status"}">
      <div class="wiki-progress-head">
        <span class="wiki-run-state">${deps.escape(statusLabel)}</span>
        <div>
          <strong>${deps.escape(String(progress.label || copy.wikiGenerationPaused))}</strong>
          <span>${deps.escape(String(progress.detail || copy.checkSettingsBeforeGenerating))}</span>
        </div>
      </div>
    </div>
  `;
}

function formatWikiThoughtCreditText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([.!?])\s+(?=(?:[A-Z]|\d))/g, "$1\n")
    .replace(/\s+-\s+(?=[A-Z])/g, "\n- ");
}

export function renderWikiCard(wiki: WikiRecord, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const openKey = wikiOpenKey(wiki);
  const title = wiki.title || wiki.structure?.title || `${wiki.owner}/${wiki.repo}`;
  const pageCount = Number(wiki.pageCount || Object.keys(wiki.pages || {}).length || 0);
  return `
    <div class="wiki-card-shell">
      <button class="wiki-card" type="button" data-wiki-open="${deps.escape(openKey)}">
        <div class="wiki-card-preview">
          <span class="wiki-card-preview-count">${deps.icon("book")}<strong>${deps.escape(String(pageCount))}</strong></span>
          <strong class="wiki-card-preview-title">${deps.escape(title)}</strong>
        </div>
        <div class="wiki-card-body">
          <h2>${deps.escape(title)}</h2>
          <p>${deps.escape(wiki.description || wikiRepoLabel(wiki))}</p>
          <div>
            <span class="wiki-card-format">${deps.escape(copy.formatLabel(wiki.wikiStyle || "technical"))}</span>
            <span>${deps.escape(copy.updated(wikiDate(wiki.updatedAt || wiki.generatedAt, copy.today)))}</span>
            <span>${deps.escape(copy.fileCount(Number(wiki.sourceCount || 0)))}</span>
          </div>
        </div>
      </button>
      <div class="wiki-card-actions">
        <button class="wiki-card-archive-trigger" type="button" data-wiki-archive-open aria-label="${deps.escape(copy.archiveWiki)}" title="${deps.escape(copy.archiveWiki)}">${deps.icon("archive")}</button>
        <div class="wiki-card-confirm" role="dialog" aria-label="${deps.escape(copy.archiveWikiConfirmation)}">
          <strong>${deps.escape(copy.archiveWikiQuestion)}</strong>
          <p>${deps.escape(copy.archiveWikiDetail)}</p>
          <div>
            <button type="button" data-wiki-card-cancel>${deps.escape(copy.cancel)}</button>
            <button type="button" data-archive-wiki-key="${deps.escape(openKey)}">${deps.escape(copy.archive)}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderWikiRunCard(run: WikiRecord, deps: WikiWorkspaceDeps): string {
  const copy = wikiGeneratorCopy(deps);
  const runId = String(run.id || "");
  const title = run.sidebarTitle || run.displayTitle || run.title || copy.generatingWiki;
  const progress = run.progressLabel || run.lastEventType || run.status || "running";
  return `
    <div class="wiki-run-card">
      <button class="wiki-run-main" type="button" data-wiki-run-id="${deps.escape(runId)}" title="${deps.escape(copy.openTitle(title))}" ${runId ? "" : "disabled"}>
        <span class="wiki-run-dot"></span>
        <div><strong>${deps.escape(title)}</strong><small>${deps.escape(progress)}</small></div>
        <span class="wiki-run-action">${deps.icon("arrowUp")}</span>
      </button>
      <button class="wiki-run-stop" type="button" data-stop-wiki-run-id="${deps.escape(runId)}" title="${deps.escape(copy.stopTitle(title))}" aria-label="${deps.escape(copy.stopTitle(title))}" ${runId ? "" : "disabled"}>${deps.icon("stop")}<span>${deps.escape(copy.stop)}</span></button>
    </div>
  `;
}

function renderWikiSlidesViewer(wiki: WikiRecord, state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiReaderCopy(deps);
  const viewer = state.wikiSlidesViewer || {};
  const title = String(viewer.title || wiki.structure?.title || wikiRepoLabel(wiki));
  const deckLabel = String(viewer.deckId || copy.openSlideDeck);
  const viewerUrl = String(viewer.viewerUrl || "");
  const downloadUrl = String(viewer.downloadUrl || wikiSlidesUrl(wiki, deps));
  const fileName = String(viewer.fileName || `${wiki.id || wiki.repo || "wiki"}-slides.zip`);
  return `
    <section class="wiki-slides-viewer">
      <header class="wiki-slides-viewer-bar">
        <button class="wiki-quiet-button" type="button" data-wiki-slides-close>${deps.icon("arrowLeft")}<span>${deps.escape(copy.wiki)}</span></button>
        <div class="wiki-slides-viewer-title">
          <span>${deps.escape(copy.openSlide)}</span>
          <strong>${deps.escape(title)}</strong>
          <small>${deps.escape(deckLabel)}</small>
        </div>
        <div class="wiki-slides-viewer-actions">
          <button class="wiki-quiet-button" type="button" data-wiki-slides-download data-wiki-slides-download-url="${deps.escape(downloadUrl)}" data-wiki-slides-file-name="${deps.escape(fileName)}">${deps.icon("slides")}<span>${deps.escape(copy.download)}</span></button>
          <button class="wiki-quiet-button" type="button" data-wiki-generate-slides data-wiki-slides-url="${deps.escape(wikiSlidesUrl(wiki, deps))}" title="${deps.escape(copy.regenerateOpenSlideDeck)}">${deps.icon("statusCheck")}<span>${deps.escape(copy.regenerate)}</span></button>
        </div>
      </header>
      <iframe class="wiki-slides-frame" src="${deps.escape(viewerUrl)}" title="${deps.escape(copy.slidesTitle(title))}" loading="eager" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-forms"></iframe>
    </section>
  `;
}

export function renderWikiReader(wiki: WikiRecord, state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  if (isDocumentationWiki(wiki) || workspaceKind(state) === "docs") {
    return renderDocsReader(wiki, state, deps);
  }

  const copy = wikiReaderCopy(deps);
  const generatorCopy = wikiGeneratorCopy(deps);
  const pages = wikiPages(wiki);
  const readerMode = state.wikiReaderMode === "paged" ? "paged" : "continuous";
  const readOnly = state.wikiReadOnly === true;
  const activePage = wikiActivePage(wiki, state.activeWikiPageId);
  const activePageId = activePage?.id || pages[0]?.id || "";
  const pageIndex = wikiPageIndex(wiki, activePageId);
  const previousPage = pages[pageIndex - 1];
  const nextPage = pages[pageIndex + 1];
  const sources = wikiSources(activePage);
  const sections = wikiSections(wiki, activePageId);
  const sourceViewerOpen = Boolean(state.wikiSourceViewerHtml);
  const readerProgress = wikiReaderProgress(wiki, state);
  const latestSlides = state.wikiSlidesLatest?.wikiKey === wikiOpenKey(wiki) ? state.wikiSlidesLatest : null;
  const title = activePage?.title || wiki.structure?.title || wikiRepoLabel(wiki);
  const lede = activePage?.description || wiki.structure?.description || "";
  const continuousTitle = wiki.structure?.title || wikiRepoLabel(wiki);
  const continuousLede = wiki.structure?.description || activePage?.description || "";
  const recovery = wikiRecoverySummary(wiki);
  const topBack = readOnly
    ? `<a class="wiki-quiet-button" href="/" data-public-home>${deps.icon("arrowLeft")}<span>rlm-wiki</span></a>`
    : `<button class="wiki-quiet-button" type="button" data-wiki-back>${deps.icon("arrowLeft")}<span>${deps.escape(copy.back)}</span></button>`;
  const topShare = readOnly
    ? ""
    : `<button class="wiki-quiet-button wiki-share-trigger" type="button" data-wiki-share-open>${deps.icon("share")}<span>${deps.escape(copy.share)}</span></button>`;
  return `
    <section class="companion-layout wiki-reader-layout wiki-reader-${readerMode} ${sourceViewerOpen ? "wiki-source-open" : ""}">
      <div class="center-pane wiki-reader-main">
        <div class="wiki-reader-mode-toggle" role="radiogroup" aria-label="${deps.escape(copy.readerOrientation)}">
          <button class="${readerMode === "continuous" ? "active" : ""}" type="button" role="radio" aria-checked="${readerMode === "continuous" ? "true" : "false"}" data-wiki-reader-mode="continuous" title="${deps.escape(copy.readContinuousTitle)}">${deps.icon("list")}<span>${deps.escape(copy.scroll)}</span></button>
          <button class="${readerMode === "paged" ? "active" : ""}" type="button" role="radio" aria-checked="${readerMode === "paged" ? "true" : "false"}" data-wiki-reader-mode="paged" title="${deps.escape(copy.readPagedTitle)}">${deps.icon("page")}<span>${deps.escape(copy.pages)}</span></button>
        </div>
        <article class="wiki-article">
          <div class="wiki-reader-top">
            <div class="wiki-reader-top-actions">${topBack}${topShare}</div>
            <div><span>${deps.escape(copy.updated(wikiDate(wiki.generatedAt, copy.today)))}</span><span>${deps.escape(copy.sourceFiles(pages.length))}</span></div>
          </div>
          <h1>${deps.escape(readerMode === "continuous" ? continuousTitle : title)}</h1>
          <p class="wiki-lede">${deps.escape(readerMode === "continuous" ? continuousLede : lede)}</p>
          ${recovery.recoverablePageIds.length ? renderWikiRecoveryBanner(recovery, readOnly, deps) : ""}
          ${readerProgress ? renderWikiProgress(readerProgress, deps) : ""}
          ${
            readerMode === "continuous"
              ? `<div class="wiki-continuous-pages">
                  ${pages.map((page, index) => `<section class="wiki-continuous-page ${page.id === activePageId ? "active" : ""}" id="wiki-page-${deps.escape(page.id)}" data-wiki-page-section="${deps.escape(page.id)}">
                    <div class="wiki-continuous-page-kicker"><span>${String(index + 1).padStart(2, "0")}</span><i></i></div>
                    <div class="wiki-markdown markdown-preview">${deps.markdown(page.content || copy.pageMissing, { sources: [], compactSourceCitations: true })}</div>
                  </section>`).join("")}
                </div>`
              : `<div class="wiki-markdown markdown-preview">${deps.markdown(activePage?.content || copy.pageMissing, { sources: [], compactSourceCitations: true })}</div>`
          }
        </article>
        ${readerMode === "paged" ? `<div class="wiki-page-nav">
          ${previousPage ? `<button type="button" data-wiki-page="${deps.escape(previousPage.id)}">${deps.icon("arrowLeft")}<span><small>${deps.escape(copy.previous)}</small>${deps.escape(previousPage.title)}</span></button>` : "<span></span>"}
          ${nextPage ? `<button type="button" data-wiki-page="${deps.escape(nextPage.id)}"><span><small>${deps.escape(copy.next)}</small>${deps.escape(nextPage.title)}</span>${deps.icon("arrowRight")}</button>` : "<span></span>"}
        </div>` : ""}
        ${readOnly ? "" : renderWikiAskIsland(state, deps)}
      </div>
      <button class="panel-resizer inspector-resizer" type="button" data-resize-inspector aria-label="${deps.escape(copy.resizeInspectorPanel)}"></button>
      <aside class="inspector-pane wiki-reader-rail">
        ${
          state.wikiSourceViewerHtml
            ? `<div class="wiki-source-drawer">
                <div class="wiki-source-drawer-head">
                  <button class="wiki-quiet-button" type="button" data-wiki-source-close>${deps.icon("arrowLeft")}<span>${deps.escape(copy.wikiOutline)}</span></button>
                </div>
                ${state.wikiSourceViewerHtml}
              </div>`
            : `<div class="wiki-rail-section">
                <span>${deps.escape(copy.onThisPage)}</span>
                <div class="wiki-outline">${sections.map((section) => `<button class="${section.active ? "active" : ""}" type="button" ${readerMode === "continuous" ? `data-wiki-scroll-page="${deps.escape(section.id)}"` : `data-wiki-page="${deps.escape(section.id)}"`}>${deps.escape(section.title)}</button>`).join("")}</div>
              </div>
              <details class="wiki-rail-section wiki-rail-disclosure">
                <summary>${deps.escape(copy.relatedSourceFiles)}</summary>
                <div class="wiki-source-list">${sources.length ? sources.map((source) => `<button type="button" data-wiki-source="${deps.escape(source)}">${deps.icon("code")}<span>${deps.escape(source)}</span></button>`).join("") : `<p>${deps.escape(copy.noSourceList)}</p>`}</div>
              </details>
              <div class="wiki-rail-section wiki-meta-box">
                <span>${deps.escape(copy.generatedFrom)}</span>
                <dl><dt>${deps.escape(copy.model)}</dt><dd>${deps.escape(wiki.runtimeModelLabel || wiki.pageModel || wiki.structureModel || wiki.model || "runtime")}</dd><dt>${deps.escape(copy.format)}</dt><dd>${deps.escape(generatorCopy.formatLabel(wiki.wikiStyle || "technical"))}</dd><dt>${deps.escape(copy.pages)}</dt><dd>${recovery.recoverablePageIds.length ? `${recovery.savedPageCount}/${recovery.plannedPageCount}` : Object.keys(wiki.pages || {}).length}</dd></dl>
              </div>
              ${readOnly ? `<div class="wiki-rail-actions wiki-public-rail-actions">
                <a class="wiki-ask-button wiki-ask-primary" href="/" data-public-home>${deps.icon("download")}<span>${deps.escape(copy.getrlm-wiki)}</span></a>
              </div>` : `<div class="wiki-rail-actions">
                <button class="wiki-ask-button wiki-slides-button" type="button" ${latestSlides ? "data-wiki-view-slides" : "data-wiki-generate-slides"} data-wiki-slides-url="${deps.escape(wikiSlidesUrl(wiki, deps))}" title="${deps.escape(latestSlides ? copy.openLatestSlideDeck : copy.generateOpenSlideDeck)}">${deps.icon("slides")}<span>${deps.escape(latestSlides ? copy.viewSlides : copy.generateSlides)}</span></button>
                <button class="wiki-ask-button wiki-regenerate-button" type="button" data-wiki-regenerate-open title="${deps.escape(copy.regenerateWikiPage)}">${deps.icon("statusCheck")}<span>${deps.escape(copy.regeneratePage)}</span></button>
              </div>`}`
        }
      </aside>
      ${state.wikiRegenerateOpen ? renderWikiRegenerateModal(wiki, activePage, state, deps) : ""}
      ${state.wikiShareOpen && !readOnly ? renderWikiShareDialog(wiki, state, deps) : ""}
    </section>
  `;
}

export function renderDocsReader(wiki: WikiRecord, state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiReaderCopy(deps);
  const pages = wikiPages(wiki);
  const readOnly = state.wikiReadOnly === true;
  const activePage = wikiActivePage(wiki, state.activeWikiPageId);
  const activePageId = activePage?.id || pages[0]?.id || "";
  const groups = docsNavigationGroups(wiki, copy);
  const activeGroup = docsGroupForPage(groups, activePage);
  const pageMeta = docsPageMeta(activePage, copy.pageUntitled);
  const pageBody = pageMeta.body || copy.pageMissing;
  const pageTitle = pageMeta.title;
  const pageDescription = pageMeta.description || wiki.structure?.description || "";
  const pagePath = docsPagePath(wiki, activePage, activeGroup);
  const readerProgress = wikiReaderProgress(wiki, state);
  const recovery = wikiRecoverySummary(wiki);
  const title = wiki.structure?.title || wiki.title || wikiRepoLabel(wiki);
  const repoLabel = wikiRepoLabel(wiki);
  const topBack = readOnly
    ? `<a class="wiki-quiet-button" href="/" data-public-home>${deps.icon("arrowLeft")}<span>rlm-wiki</span></a>`
    : `<button class="wiki-quiet-button" type="button" data-wiki-back>${deps.icon("arrowLeft")}<span>${deps.escape(copy.back)}</span></button>`;
  const topShare = readOnly
    ? ""
    : `<button class="wiki-quiet-button wiki-share-trigger" type="button" data-wiki-share-open>${deps.icon("share")}<span>${deps.escape(copy.share)}</span></button>`;
  const topRegenerate = readOnly
    ? ""
    : `<button class="wiki-quiet-button wiki-regenerate-button" type="button" data-wiki-regenerate-open title="${deps.escape(copy.regenerateWikiPage)}">${deps.icon("statusCheck")}<span>${deps.escape(copy.regenerate)}</span></button>`;

  return `
    <section class="companion-layout docs-reader-layout" data-docs-reader>
      <aside class="docs-nav-pane">
        <div class="docs-nav-top">${topBack}</div>
        <div class="docs-nav-title">
          <span>${deps.escape(copy.documentation)}</span>
          <strong>${deps.escape(title)}</strong>
          <small>${deps.escape(copy.docsPages(pages.length, repoLabel))}</small>
        </div>
        <nav class="docs-nav" aria-label="${deps.escape(copy.documentationPages)}">
          ${groups.map((group) => `<section class="docs-nav-group">
            <div class="docs-nav-group-title">${deps.escape(group.title)}</div>
            ${group.pages.map((page) => {
              const meta = docsPageMeta(page, copy.pageUntitled);
              const active = String(page.id || "") === activePageId;
              return `<button class="docs-nav-page ${active ? "active" : ""}" type="button" data-wiki-page="${deps.escape(String(page.id || ""))}">
                <span>${deps.escape(meta.title)}</span>
              </button>`;
            }).join("")}
          </section>`).join("")}
        </nav>
      </aside>
      <div class="center-pane docs-reader-main">
        ${renderDocsPageRail(groups, activePageId, title, deps)}
        <article class="docs-article">
          <div class="docs-reader-top">
            <div class="docs-breadcrumb"><span>${deps.escape(copy.docs)}</span><i></i><span>${deps.escape(activeGroup?.title || copy.pages)}</span></div>
            <div class="docs-reader-actions">${topRegenerate}${topShare}</div>
          </div>
          <header class="docs-page-hero">
            <span class="docs-page-path">${deps.escape(pagePath)}</span>
            <h1>${deps.escape(pageTitle)}</h1>
            ${pageDescription ? `<p>${deps.escape(pageDescription)}</p>` : ""}
          </header>
          ${recovery.recoverablePageIds.length ? renderWikiRecoveryBanner(recovery, readOnly, deps, "docs") : ""}
          ${readerProgress ? renderWikiProgress(readerProgress, deps) : ""}
          <div class="docs-markdown wiki-markdown markdown-preview">${deps.markdown(pageBody, {
            sources: [],
            compactSourceCitations: true,
            cacheKey: docsMarkdownCacheKey(wiki, activePageId, pageBody),
            resolveDocsPageHref: (href: string, label: string, description: string) =>
              resolveDocsPageLink(wiki, href, label) || resolveDocsPageLink(wiki, href, description),
          })}</div>
        </article>
        ${readOnly ? "" : renderDocsAskOverlay(state, deps)}
      </div>
      ${state.wikiRegenerateOpen ? renderWikiRegenerateModal(wiki, activePage, state, deps) : ""}
      ${state.wikiShareOpen && !readOnly ? renderWikiShareDialog(wiki, state, deps) : ""}
    </section>
  `;
}

function docsMarkdownCacheKey(wiki: WikiRecord, pageId: string, body: string): string {
  return `docs:${wikiOpenKey(wiki)}:${pageId}:${stableTextHash(body)}`;
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function renderDocsPageRail(
  groups: DocsNavGroup[],
  activePageId: string,
  title: string,
  deps: WikiWorkspaceDeps,
): string {
  const copy = wikiReaderCopy(deps);
  const entries = groups.flatMap((group) =>
    group.pages.map((page) => {
      const meta = docsPageMeta(page, copy.pageUntitled);
      return {
        group: group.title,
        id: String(page.id || ""),
        title: meta.title,
      };
    }),
  ).filter((entry) => entry.id && entry.title);
  if (entries.length < 2) return "";

  return `<nav class="docs-page-rail" aria-label="${deps.escape(copy.docsPageSelector)}">
    <div class="docs-page-rail-zone">
      <div class="docs-page-rail-ticks">
        ${entries.map((entry, index) => {
          const active = entry.id === activePageId;
          return `<button class="docs-page-rail-tick ${active ? "active" : ""}" type="button" data-wiki-page="${deps.escape(entry.id)}" title="${deps.escape(entry.title)}" aria-label="${deps.escape(copy.goToPage(index + 1, entry.title))}"></button>`;
        }).join("")}
      </div>
    </div>
    <div class="docs-page-rail-popover">
      <div class="docs-page-rail-heading">${deps.escape(title)}</div>
      <div class="docs-page-rail-list">
        ${entries.map((entry, index) => {
          const active = entry.id === activePageId;
          return `<button class="docs-page-rail-row ${active ? "active" : ""}" type="button" data-wiki-page="${deps.escape(entry.id)}" ${active ? 'aria-current="page"' : ""}>
            <span>${index + 1}. ${deps.escape(entry.title)}</span>
            <small>${deps.escape(entry.group)}</small>
          </button>`;
        }).join("")}
      </div>
    </div>
  </nav>`;
}

export function renderDocsAskOverlay(state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiReaderCopy(deps);
  const threadHtml = (state.docsAskThreadHtml || "").trim();
  const hasThread = Boolean(threadHtml) && state.docsAskOverlayOpen !== false;
  const running = Boolean(state.docsAskRunning);
  return `
    <section class="docs-ask-overlay ${hasThread ? "has-thread" : ""} ${running ? "is-running" : ""}" data-docs-ask-overlay aria-label="${deps.escape(copy.docsConversation)}">
      ${hasThread ? `<div class="docs-ask-dismiss-layer" data-docs-ask-dismiss aria-hidden="true"></div>` : ""}
      <div class="docs-ask-popover" data-docs-ask-popover>
        ${hasThread ? `<div class="docs-ask-popover-head">
          <span>${deps.icon("messageCircle")}<strong>${deps.escape(copy.docsChat)}</strong></span>
          ${running ? "" : `<button class="docs-ask-new-button" type="button" data-docs-ask-new title="${deps.escape(copy.startNewDocumentationQuestion)}">${deps.icon("plus")}<span>${deps.escape(copy.newQuestion)}</span></button>`}
        </div>
        <div class="docs-ask-popover-body" data-docs-ask-panel>
          ${threadHtml}
        </div>` : ""}
        ${renderWikiAskIsland(state, deps, "docs")}
      </div>
    </section>
  `;
}

function renderWikiAskIsland(state: WikiWorkspaceState, deps: WikiWorkspaceDeps, kind: "wiki" | "docs" = "wiki"): string {
  const copy = wikiReaderCopy(deps);
  const placeholder = kind === "docs" ? copy.docsAskPlaceholder : copy.wikiAskPlaceholder;
  const label = kind === "docs" ? copy.docsAskLabel : copy.wikiAskLabel;
  const running = kind === "docs" && Boolean(state.docsAskRunning);
  const draft = kind === "docs" ? state.docsAskDraft || "" : state.wikiAskDraft || "";
  return `
    <form class="composer wiki-ask-island" data-wiki-ask-composer aria-label="${deps.escape(label)}">
      <textarea id="wiki-ask-input" data-wiki-ask-input rows="1" placeholder="${deps.escape(placeholder)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">${deps.escape(draft)}</textarea>
      <button class="wiki-ask-island-submit" type="${running ? "button" : "submit"}" ${running ? "data-stop-ask" : "data-wiki-ask-submit"} aria-label="${deps.escape(running ? copy.stopDocumentationAnswer : label)}" title="${deps.escape(running ? copy.stopDocumentationAnswer : label)}">${deps.icon(running ? "stop" : "arrowUp")}</button>
    </form>
  `;
}

function renderWikiRecoveryBanner(
  recovery: ReturnType<typeof wikiRecoverySummary>,
  readOnly: boolean,
  deps: WikiWorkspaceDeps,
  kind: "wiki" | "docs" = "wiki",
): string {
  const copy = wikiGeneratorCopy(deps);
  const recoverableCount = recovery.recoverablePageIds.length;
  const saved = recovery.savedPageCount;
  const planned = recovery.plannedPageCount;
  const artifact = kind === "docs" ? copy.artifactDocs : copy.artifactWiki;
  const label = saved > 0 ? copy.partialArtifactSaved(artifact) : copy.pagesNeedRecovery;
  const detail = saved > 0
    ? copy.recoveryReadable(saved, planned, recoverableCount, artifact)
    : copy.recoveryFromOutline(recoverableCount);
  return `
    <section class="wiki-recovery-banner" role="status">
      <span class="wiki-recovery-icon">${deps.icon("alert")}</span>
      <div>
        <strong>${deps.escape(label)}</strong>
        <p>${deps.escape(readOnly ? copy.recoverySnapshot(saved, planned) : detail)}</p>
      </div>
      ${readOnly ? "" : `<button class="wiki-quiet-button" type="button" data-wiki-recover-pages data-wiki-page-ids="${deps.escape(recovery.recoverablePageIds.join(","))}">${deps.icon("statusCheck")}<span>${deps.escape(copy.recoverCount(recoverableCount))}</span></button>`}
    </section>
  `;
}

function renderWikiShareDialog(wiki: WikiRecord, state: WikiWorkspaceState, deps: WikiWorkspaceDeps): string {
  const copy = wikiReaderCopy(deps);
  const publication = state.wikiPublication || {};
  const published = publication.published === true;
  const visibility = published && publication.visibility !== "private" ? "public" : "private";
  const privateLink = visibility === "private";
  const publicUrl = String(publication.publicUrl || "");
  const needsUpdate = publication.needsUpdate === true;
  const busy = state.wikiPublishing === true;
  const error = typeof publication.error === "string" ? publication.error : "";
  const linkLabel = privateLink ? copy.privateLink : copy.publicLink;
  const title = published ? privateLink ? copy.privateLinkTitle : copy.publicLinkTitle : copy.shareTitle;
  const detail = error ? copy.shareErrorDetail : published
    ? needsUpdate
      ? copy.updateLinkDetail(linkLabel)
      : privateLink
        ? copy.privatePublishedDetail
        : copy.publicPublishedDetail
    : copy.createLinkDetail;
  const primaryLabel = busy
    ? published ? copy.updating : copy.publishing
    : published ? needsUpdate ? copy.updateLink(linkLabel) : copy.refreshLink(linkLabel) : copy.createPrivateLink;
  const primaryVisibility = published ? visibility : "private";
  const secondaryVisibility = published ? privateLink ? "public" : "private" : "public";
  const secondaryLabel = published ? privateLink ? copy.publishToGallery : copy.makePrivateLink : copy.publishToGallery;
  const secondaryIcon = secondaryVisibility === "private" ? "lock" : "globe";
  const exportUrl = wikiExportUrl(wiki, deps);
  const pdfUrl = wikiPdfUrl(wiki, deps);
  return `
    <div class="wiki-share-backdrop" data-wiki-share-close>
      <section class="wiki-share-dialog" role="dialog" aria-modal="true" aria-label="${deps.escape(copy.shareWiki)}">
        <div class="wiki-share-head">
          <div>
            <span class="eyebrow">${deps.escape(copy.share)}</span>
            <h2>${deps.escape(title)}</h2>
            <p>${deps.escape(detail)}</p>
          </div>
          <button class="wiki-quiet-button" type="button" data-wiki-share-close aria-label="${deps.escape(copy.close)}">${deps.icon("x")}</button>
        </div>
        ${published && publicUrl ? `<div class="wiki-share-link-row">
          <input class="wiki-share-link" readonly value="${deps.escape(publicUrl)}" aria-label="${deps.escape(copy.sharedWikiLink)}" />
          <button class="wiki-quiet-button" type="button" data-wiki-share-copy>${deps.icon("copy")}<span>${deps.escape(copy.copy)}</span></button>
          <a class="wiki-quiet-button" href="${deps.escape(publicUrl)}" target="_blank" rel="noreferrer" data-open-external-url="${deps.escape(publicUrl)}">${deps.icon("external")}<span>${deps.escape(copy.open)}</span></a>
        </div>` : ""}
        ${published ? `<div class="wiki-share-visibility">
          ${deps.icon(privateLink ? "lock" : "globe")}
          <span>${deps.escape(privateLink ? copy.privateLinkTitle : copy.publicGallery)}</span>
        </div>` : ""}
        <div class="wiki-share-actions">
          <button class="wiki-ask-button wiki-ask-primary" type="button" data-wiki-share-publish data-wiki-share-visibility="${deps.escape(primaryVisibility)}" ${busy ? "disabled" : ""}>${deps.icon(privateLink ? "lock" : "globe")}<span>${deps.escape(primaryLabel)}</span></button>
          <button class="wiki-ask-button wiki-share-secondary" type="button" data-wiki-share-publish data-wiki-share-visibility="${deps.escape(secondaryVisibility)}" ${busy ? "disabled" : ""}>${deps.icon(secondaryIcon)}<span>${deps.escape(secondaryLabel)}</span></button>
        </div>
        <div class="wiki-share-local">
          <span>${deps.escape(copy.localExport)}</span>
          <div class="wiki-share-local-actions">
            <a class="wiki-ask-button wiki-regenerate-button wiki-share-export" href="${deps.escape(exportUrl)}" download data-no-router="true" data-wiki-share-export data-wiki-export-url="${deps.escape(exportUrl)}">${deps.icon("download")}<span>${deps.escape(copy.obsidianZip)}</span></a>
            <a class="wiki-ask-button wiki-regenerate-button wiki-share-pdf" href="${deps.escape(pdfUrl)}" target="_blank" rel="noreferrer" data-no-router="true" data-wiki-share-pdf data-wiki-pdf-url="${deps.escape(pdfUrl)}">${deps.icon("external")}<span>${deps.escape(copy.exportPdf)}</span></a>
          </div>
        </div>
        ${error ? `<p class="wiki-share-error">${deps.escape(error)}</p>` : ""}
        ${published ? `<button class="wiki-share-danger" type="button" data-wiki-share-unpublish ${busy ? "disabled" : ""}>${deps.escape(copy.unpublishLink)}</button>` : ""}
        <p class="wiki-share-footnote">${deps.escape(copy.shareFootnote)}</p>
      </section>
    </div>
  `;
}

function wikiReaderProgress(wiki: WikiRecord, state: WikiWorkspaceState): Record<string, any> | null {
  const progress = state.wikiProgress;
  if (!progress || progress.surface !== "wiki-reader") return null;
  return progress.wikiKey && progress.wikiKey === wikiOpenKey(wiki) ? progress : null;
}

function renderWikiRegenerateModal(
  wiki: WikiRecord,
  activePage: WikiPage | null,
  state: WikiWorkspaceState,
  deps: WikiWorkspaceDeps,
): string {
  const copy = wikiReaderCopy(deps);
  const pageTitle = activePage?.title || wiki.structure?.title || wikiRepoLabel(wiki);
  const progressStatus = String(state.wikiProgress?.status || "");
  const currentPageRegenerating =
    !!state.wikiGenerating &&
    state.wikiProgress?.surface === "wiki-reader" &&
    String(state.wikiProgress?.pageId || "") === String(activePage?.id || "") &&
    !["done", "error", "canceled"].includes(progressStatus);
  return `
    <div class="wiki-regen-backdrop" data-wiki-regenerate-close>
      <section class="wiki-regen-modal" role="dialog" aria-modal="true" aria-label="${deps.escape(copy.regenerateWikiPage)}">
        <div class="wiki-regen-head">
          <div>
            <span class="eyebrow">${deps.escape(copy.regenerate)}</span>
            <h2>${deps.escape(pageTitle)}</h2>
          </div>
          <button class="wiki-quiet-button" type="button" data-wiki-regenerate-close aria-label="${deps.escape(copy.close)}">${deps.icon("x")}</button>
        </div>
        <form class="wiki-regen-form" data-wiki-regenerate-page-form>
          <label>
            <span>${deps.escape(copy.improveQuestion)}</span>
            <textarea id="wiki-regenerate-instruction" rows="4" placeholder="${deps.escape(copy.regenerateInstructionPlaceholder)}">${deps.escape(state.wikiRegenerateInstruction || "")}</textarea>
          </label>
          <label>
            <span>${deps.escape(copy.currentRegenerationPrompt)}</span>
            <textarea id="wiki-regenerate-prompt" rows="9" spellcheck="false">${deps.escape(state.wikiRegeneratePrompt || "")}</textarea>
          </label>
          <div class="wiki-regen-actions">
            <button class="wiki-quiet-button" type="button" data-wiki-regenerate-close>${deps.escape(copy.cancel)}</button>
            <button class="wiki-primary-button" type="button" data-wiki-regenerate-submit ${currentPageRegenerating ? "disabled" : ""}>${deps.escape(currentPageRegenerating ? copy.regenerating : copy.regeneratePage)}</button>
          </div>
        </form>
        <div class="wiki-regen-divider"></div>
        <div class="wiki-regen-all">
          <div>
            <strong>${deps.escape(copy.regenerateWholeWiki)}</strong>
            <p>${deps.escape(copy.regenerateWholeWikiDetail)}</p>
          </div>
          <button class="wiki-quiet-button" type="button" data-wiki-regenerate-all>${deps.escape(copy.useFullWikiFlow)}</button>
        </div>
      </section>
    </div>
  `;
}
