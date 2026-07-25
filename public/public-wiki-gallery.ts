import "./public-wiki-gallery.css";
import galleryHeroArtUrl from "./editorial/rlm-wiki-gallery-archive.jpg";

type GalleryFacet = {
  value: string;
  label: string;
  count: number;
};

type GalleryItem = {
  publicId: string;
  href: string;
  surface: "wiki" | "docs";
  title: string;
  description: string;
  owner: string;
  repo: string;
  repository: string;
  repoUrl: string;
  branch: string | null;
  format: string;
  formatLabel: string;
  runtime: string;
  pages: number;
  sourceFiles: number;
  publishedAt: string | null;
  updatedAt: string | null;
};

type GalleryResponse = {
  ok?: boolean;
  items?: GalleryItem[];
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
  facets?: {
    formats?: GalleryFacet[];
    pageRanges?: GalleryFacet[];
  };
  filters?: {
    q?: string;
    format?: string;
    pages?: string;
    surface?: string;
  };
  sort?: string;
  error?: string;
};

type GalleryState = {
  q: string;
  sort: string;
  format: string;
  pages: string;
  surface: string;
  page: number;
  pageSize: number;
};

const root = document.getElementById("public-wiki-gallery-root");
let state = readState();
let requestSerial = 0;
let searchTimer: ReturnType<typeof window.setTimeout> | null = null;

applyGalleryTheme();
renderShell();
bindEvents();
void loadGallery();

function renderShell(): void {
  if (!root) return;
  root.innerHTML = `
    <header class="gallery-topbar">
      <a class="gallery-brand" href="/" aria-label="rlm-wiki home">
        <strong>rlm-wiki</strong>
        <span>Public library</span>
      </a>
      <nav class="gallery-nav" aria-label="Public navigation">
        <a class="active" href="${state.surface === "docs" ? "/public/docs" : "/public/wikis"}">Gallery</a>
        <a href="/episodes">Episodes</a>
        <a href="/changelog">Changelog</a>
        <a href="/">Download</a>
      </nav>
    </header>
    <main class="gallery-main">
      <section class="gallery-hero" aria-labelledby="gallery-title">
        <img
          class="gallery-hero-art"
          src="${galleryHeroArtUrl}"
          alt=""
          decoding="async"
          fetchpriority="high"
        />
        <p class="gallery-kicker">Public library</p>
        <div class="gallery-hero-row">
          <div>
            <h1 id="gallery-title">${escapeHtml(galleryHeroTitle(state.surface))}</h1>
            <p class="gallery-copy">
              ${escapeHtml(galleryHeroCopy(state.surface))}
            </p>
          </div>
          <div class="gallery-count" data-gallery-count aria-live="polite">-</div>
        </div>
        <div class="gallery-surface-tabs" role="radiogroup" aria-label="Public artifact type">
          ${surfaceButton("", "All")}
          ${surfaceButton("wiki", "Wikis")}
          ${surfaceButton("docs", "Docs")}
        </div>
      </section>

      <form class="gallery-controls" data-gallery-controls role="search">
        <label class="gallery-search">
          ${icon("search")}
          <span class="sr-only">Search public wikis and docs</span>
          <input
            type="search"
            name="q"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search wikis and docs"
            value="${escapeHtml(state.q)}"
            data-gallery-search
          />
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${icon("sort")}<b>Sort</b></span>
          <strong data-gallery-select-value="sort">${escapeHtml(sortLabel(state.sort))}</strong>
          <select name="sort" data-gallery-sort>
            ${selectOption("updated", "Updated", state.sort)}
            ${selectOption("published", "New", state.sort)}
            ${selectOption("title", "Title A-Z", state.sort)}
            ${selectOption("pages", "Most pages", state.sort)}
          </select>
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${icon("tag")}<b>Format</b></span>
          <strong data-gallery-select-value="format">All</strong>
          <select name="format" data-gallery-format>
            <option value="">All formats</option>
          </select>
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${icon("layers")}<b>Pages</b></span>
          <strong data-gallery-select-value="pages">${escapeHtml(pageRangeShortLabel(state.pages))}</strong>
          <select name="pages" data-gallery-pages>
            <option value="">Any length</option>
            ${selectOption("compact", "1-4 pages", state.pages)}
            ${selectOption("standard", "5-8 pages", state.pages)}
            ${selectOption("deep", "9+ pages", state.pages)}
          </select>
        </label>
      </form>

      <section class="gallery-results-head">
        <p data-gallery-status>Loading public items...</p>
        <button class="gallery-clear" type="button" data-gallery-clear hidden>Clear filters</button>
      </section>

      <section class="gallery-grid" data-gallery-results aria-live="polite">
        ${renderSkeletonCards()}
      </section>

      <nav class="gallery-pagination" data-gallery-pagination aria-label="Gallery pagination"></nav>
    </main>
  `;
}

function bindEvents(): void {
  if (!root) return;

  root.addEventListener("submit", (event) => {
    event.preventDefault();
    applyControlState({ page: 1 });
  });

  root.addEventListener("input", (event) => {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    if (!target?.matches("[data-gallery-search]")) return;
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      applyControlState({ q: target.value, page: 1 });
    }, 180);
  });

  root.addEventListener("change", (event) => {
    const target = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!target) return;
    if (target.matches("[data-gallery-sort]")) applyControlState({ sort: target.value, page: 1 });
    if (target.matches("[data-gallery-format]")) applyControlState({ format: target.value, page: 1 });
    if (target.matches("[data-gallery-pages]")) applyControlState({ pages: target.value, page: 1 });
  });

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const pageButton = target.closest<HTMLButtonElement>("[data-gallery-page]");
    if (pageButton) {
      event.preventDefault();
      applyControlState({ page: Number(pageButton.dataset.galleryPage) || 1 });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (target.closest("[data-gallery-clear]")) {
      event.preventDefault();
      state = { ...state, q: "", format: "", pages: "", sort: "updated", page: 1 };
      syncControls();
      syncUrl();
      void loadGallery();
      return;
    }
    const surfaceButton = target.closest<HTMLButtonElement>("[data-gallery-surface]");
    if (surfaceButton) {
      event.preventDefault();
      applyControlState({ surface: surfaceButton.dataset.gallerySurface || "", page: 1 });
    }
  });
}

function applyGalleryTheme(): void {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.publicTheme = "dark";
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", "#050505");
}

function applyControlState(next: Partial<GalleryState>): void {
  state = {
    ...state,
    ...next,
    q: String(next.q ?? state.q).trim(),
    sort: normalizeSort(String(next.sort ?? state.sort)),
    format: String(next.format ?? state.format).trim(),
    pages: String(next.pages ?? state.pages).trim(),
    surface: normalizeSurface(String(next.surface ?? state.surface)),
    page: Math.max(1, Math.trunc(Number(next.page ?? state.page)) || 1),
  };
  syncUrl();
  void loadGallery();
}

async function loadGallery(): Promise<void> {
  const serial = ++requestSerial;
  setLoading(true);
  try {
    const response = await fetch(`/api/public/wiki?${galleryQuery(state)}`, {
      headers: { accept: "application/json" },
    });
    const data = await response.json().catch(() => ({})) as GalleryResponse;
    if (!response.ok || data.error) throw new Error(data.error || `Could not load gallery (${response.status}).`);
    if (serial !== requestSerial) return;
    renderGallery(data);
  } catch (error) {
    if (serial !== requestSerial) return;
    renderError(error instanceof Error ? error.message : String(error));
  } finally {
    if (serial === requestSerial) setLoading(false);
  }
}

function renderGallery(data: GalleryResponse): void {
  const items = data.items || [];
  const pagination = data.pagination || { page: 1, pageSize: 12, total: 0, pageCount: 1, hasNext: false, hasPrevious: false };
  state.page = pagination.page;
  renderFacets(data.facets || {});
  syncControls();

  const count = root?.querySelector<HTMLElement>("[data-gallery-count]");
  if (count) {
    count.innerHTML = `<strong>${pagination.total}</strong><span>${galleryItemLabel(pagination.total, state.surface)}</span>`;
  }

  const status = root?.querySelector<HTMLElement>("[data-gallery-status]");
  if (status) {
    const active = activeFilterCount();
    const itemLabel = galleryItemLabel(pagination.total, state.surface);
    status.textContent = pagination.total
      ? `${pagination.total} public ${itemLabel}${active ? " after filters" : ""}`
      : active ? `No ${galleryItemLabel(2, state.surface)} match those filters yet.` : `No public ${galleryItemLabel(2, state.surface)} are published yet.`;
  }

  const clear = root?.querySelector<HTMLButtonElement>("[data-gallery-clear]");
  if (clear) clear.hidden = activeFilterCount() === 0;

  const results = root?.querySelector<HTMLElement>("[data-gallery-results]");
  if (results) results.innerHTML = items.length ? items.map(renderCard).join("") : renderEmptyState();

  const pager = root?.querySelector<HTMLElement>("[data-gallery-pagination]");
  if (pager) pager.innerHTML = renderPagination(pagination);
}

function renderFacets(facets: GalleryResponse["facets"]): void {
  const formatSelect = root?.querySelector<HTMLSelectElement>("[data-gallery-format]");
  if (!formatSelect) return;
  const formats = facets?.formats || [];
  const hasSelected = !state.format || formats.some((facet) => facet.value === state.format);
  formatSelect.innerHTML = [
    `<option value="">All formats</option>`,
    ...formats.map((facet) => selectOption(facet.value, `${facet.label} (${facet.count})`, state.format)),
    hasSelected ? "" : selectOption(state.format, state.format, state.format),
  ].join("");
}

function renderCard(item: GalleryItem): string {
  const updated = formatDate(item.updatedAt || item.publishedAt);
  return `
    <a class="gallery-card" href="${escapeHtml(item.href)}" aria-label="Open ${escapeHtml(item.title)}">
      <div class="gallery-thumb" aria-hidden="true">
        <div class="gallery-thumb-meta">
          <span>${icon("book")}${item.pages || 0}</span>
          <span>${escapeHtml(item.surface === "docs" ? "Docs" : item.formatLabel)}</span>
        </div>
        <strong>${escapeHtml(shortTitle(item.title))}</strong>
        <small>${escapeHtml(item.repository)}</small>
      </div>
      <div class="gallery-card-body">
        <div class="gallery-repo">
          <span>${escapeHtml(item.owner)}</span>
          <span>${escapeHtml(item.repo)}</span>
        </div>
        <h2>${escapeHtml(item.title)}</h2>
        <p>${escapeHtml(item.description)}</p>
        <div class="gallery-card-foot">
          <span>${updated ? `Updated ${escapeHtml(updated)}` : "Recently published"}</span>
          <span>${item.surface === "docs" ? "Docs" : "Wiki"}</span>
          <span>${item.sourceFiles || 0} source ${item.sourceFiles === 1 ? "file" : "files"}</span>
        </div>
      </div>
    </a>
  `;
}

function renderPagination(pagination: NonNullable<GalleryResponse["pagination"]>): string {
  if (pagination.pageCount <= 1) return "";
  return `
    <button type="button" data-gallery-page="${pagination.page - 1}" ${pagination.hasPrevious ? "" : "disabled"}>
      ${icon("arrowLeft")} Previous
    </button>
    <span>Page ${pagination.page} of ${pagination.pageCount}</span>
    <button type="button" data-gallery-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>
      Next ${icon("arrowRight")}
    </button>
  `;
}

function renderError(message: string): void {
  const count = root?.querySelector<HTMLElement>("[data-gallery-count]");
  if (count) count.textContent = "-";
  const status = root?.querySelector<HTMLElement>("[data-gallery-status]");
  if (status) status.textContent = "Gallery took a tiny detour.";
  const results = root?.querySelector<HTMLElement>("[data-gallery-results]");
  if (results) {
    results.innerHTML = `
      <div class="gallery-empty" role="alert">
        <strong>Could not load public items.</strong>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }
  const pager = root?.querySelector<HTMLElement>("[data-gallery-pagination]");
  if (pager) pager.innerHTML = "";
}

function setLoading(loading: boolean): void {
  root?.querySelector<HTMLElement>("[data-gallery-results]")?.classList.toggle("loading", loading);
}

function renderSkeletonCards(): string {
  return Array.from({ length: 6 }, () => `
    <div class="gallery-card gallery-card-skeleton" aria-hidden="true">
      <div class="gallery-thumb"></div>
      <div class="gallery-card-body">
        <span></span>
        <strong></strong>
        <p></p>
      </div>
    </div>
  `).join("");
}

function renderEmptyState(): string {
  return `
    <div class="gallery-empty">
      <strong>No matching wikis.</strong>
      <p>Try a softer search or clear a filter.</p>
    </div>
  `;
}

function syncControls(): void {
  const search = root?.querySelector<HTMLInputElement>("[data-gallery-search]");
  if (search && search.value !== state.q && document.activeElement !== search) search.value = state.q;
  const sort = root?.querySelector<HTMLSelectElement>("[data-gallery-sort]");
  if (sort) sort.value = state.sort;
  const format = root?.querySelector<HTMLSelectElement>("[data-gallery-format]");
  if (format) format.value = state.format;
  const pages = root?.querySelector<HTMLSelectElement>("[data-gallery-pages]");
  if (pages) pages.value = state.pages;
  syncSurfaceTabs();
  syncSelectLabels();
}

function syncUrl(): void {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.sort !== "updated") params.set("sort", state.sort);
  if (state.format) params.set("format", state.format);
  if (state.pages) params.set("pages", state.pages);
  if (state.surface && state.surface !== surfaceFromPath()) params.set("surface", state.surface);
  if (state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  const path = state.surface === "docs" ? "/public/docs" : "/public/wikis";
  window.history.replaceState(null, "", `${path}${query ? `?${query}` : ""}`);
}

function galleryQuery(value: GalleryState): string {
  const params = new URLSearchParams();
  params.set("page", String(value.page));
  params.set("pageSize", String(value.pageSize));
  if (value.q) params.set("q", value.q);
  if (value.sort) params.set("sort", value.sort);
  if (value.format) params.set("format", value.format);
  if (value.pages) params.set("pages", value.pages);
  if (value.surface) params.set("surface", value.surface);
  return params.toString();
}

function readState(): GalleryState {
  const params = new URLSearchParams(window.location.search);
  return {
    q: String(params.get("q") || "").trim(),
    sort: normalizeSort(params.get("sort") || "updated"),
    format: String(params.get("format") || "").trim(),
    pages: String(params.get("pages") || "").trim(),
    surface: normalizeSurface(params.get("surface") || surfaceFromPath()),
    page: Math.max(1, Math.trunc(Number(params.get("page") || "1")) || 1),
    pageSize: 12,
  };
}

function activeFilterCount(): number {
  return [state.q, state.format, state.pages, state.surface].filter(Boolean).length + (state.sort === "updated" ? 0 : 1);
}

function normalizeSort(value: string): string {
  return ["updated", "published", "title", "pages"].includes(value) ? value : "updated";
}

function syncSelectLabels(): void {
  setSelectLabel("sort", sortLabel(state.sort));
  setSelectLabel("format", formatShortLabel(state.format, selectedOptionText("[data-gallery-format]", "All")));
  setSelectLabel("pages", pageRangeShortLabel(state.pages));
}

function syncSurfaceTabs(): void {
  root?.querySelectorAll<HTMLElement>("[data-gallery-surface]").forEach((button) => {
    const active = (button.dataset.gallerySurface || "") === state.surface;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", active ? "true" : "false");
  });
  const title = root?.querySelector<HTMLElement>("#gallery-title");
  if (title) title.textContent = galleryHeroTitle(state.surface);
  const copy = root?.querySelector<HTMLElement>(".gallery-copy");
  if (copy) copy.textContent = galleryHeroCopy(state.surface);
}

function setSelectLabel(name: string, value: string): void {
  const target = root?.querySelector<HTMLElement>(`[data-gallery-select-value="${name}"]`);
  if (target) target.textContent = value;
}

function selectedOptionText(selector: string, fallback: string): string {
  const select = root?.querySelector<HTMLSelectElement>(selector);
  const text = select?.selectedOptions?.[0]?.textContent?.replace(/\s+\(\d+\)$/, "").trim();
  return text || fallback;
}

function sortLabel(value: string): string {
  if (value === "published") return "New";
  if (value === "title") return "A-Z";
  if (value === "pages") return "Pages";
  return "Updated";
}

function pageRangeShortLabel(value: string): string {
  if (value === "compact") return "1-4";
  if (value === "standard") return "5-8";
  if (value === "deep") return "9+";
  return "Any";
}

function formatShortLabel(value: string, fallback: string): string {
  if (!value) return "All";
  return {
    basic: "Basic",
    technical: "Technical",
    "first-30": "First 30",
    eli5: "ELI5",
    "mental-model": "Mental",
    "socratic-exploration": "Socratic",
    "feature-scout": "Scout",
    "worth-stealing": "Steal",
    "hidden-quirks": "Quirks",
    "pattern-discovery": "Patterns",
    "repo-comparison": "Compare",
    "debugging-atlas": "Debug",
    "tech-reader": "Brief",
    documentation: "Docs",
    custom: "Custom",
  }[value] || fallback;
}

function surfaceButton(value: string, label: string): string {
  const active = value === state.surface;
  return `<button class="${active ? "active" : ""}" type="button" role="radio" aria-checked="${active ? "true" : "false"}" data-gallery-surface="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function normalizeSurface(value: string): string {
  const clean = String(value || "").trim().toLowerCase();
  return clean === "wiki" || clean === "docs" ? clean : "";
}

function surfaceFromPath(): string {
  return window.location.pathname.replace(/\/+$/, "") === "/public/docs" ? "docs" : "";
}

function galleryHeroTitle(surface: string): string {
  if (surface === "docs") return "Browse generated docs.";
  if (surface === "wiki") return "Browse repo wikis.";
  return "Browse repo knowledge.";
}

function galleryHeroCopy(surface: string): string {
  if (surface === "docs") return "Functional technical docs generated from repositories and folders.";
  if (surface === "wiki") return "Source-grounded repository wikis published from rlm-wiki.";
  return "Source-grounded wikis and technical docs published from rlm-wiki.";
}

function galleryItemLabel(count: number, surface: string): string {
  if (surface === "docs") return count === 1 ? "doc" : "docs";
  if (surface === "wiki") return count === 1 ? "wiki" : "wikis";
  return count === 1 ? "item" : "items";
}

function selectOption(value: string, label: string, selected: string): string {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function shortTitle(value: string): string {
  const title = String(value || "Wiki").replace(/\s+Wiki$/i, "");
  return title.length > 42 ? `${title.slice(0, 39).trim()}...` : title;
}

function formatDate(value: string | null | undefined): string {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" }).format(new Date(time));
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    arrowLeft: '<path d="m15 18-6-6 6-6"/><path d="M21 12H9"/>',
    arrowRight: '<path d="m9 18 6-6-6-6"/><path d="M3 12h12"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"/>',
    search: '<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="8"/>',
    sort: '<path d="m7 15 5 5 5-5"/><path d="M12 20V4"/><path d="m17 9-5-5-5 5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    tag: '<path d="M12.6 2.6H4.5a2 2 0 0 0-2 2v8.1a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l8.2-8.2a2 2 0 0 0 0-2.8L14 3.2a2 2 0 0 0-1.4-.6Z"/><path d="M7.5 7.5h.01"/>',
  };
  const body = paths[name] || "";
  return body
    ? `<svg class="gallery-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
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
