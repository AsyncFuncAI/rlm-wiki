import"./modulepreload-polyfill-B5Qt9EMX.js";import"./vercel-analytics-DchYkPep.js";const x="/assets/rlm-wiki-gallery-archive-BTjgBa9N.jpg",s=document.getElementById("public-wiki-gallery-root");let a=O(),g=0,p=null;N();D();B();m();function D(){s&&(s.innerHTML=`
    <header class="gallery-topbar">
      <a class="gallery-brand" href="/" aria-label="rlm-wiki home">
        <strong>rlm-wiki</strong>
        <span>Public library</span>
      </a>
      <nav class="gallery-nav" aria-label="Public navigation">
        <a class="active" href="${a.surface==="docs"?"/public/docs":"/public/wikis"}">Gallery</a>
        <a href="/episodes">Episodes</a>
        <a href="/changelog">Changelog</a>
        <a href="/">Download</a>
      </nav>
    </header>
    <main class="gallery-main">
      <section class="gallery-hero" aria-labelledby="gallery-title">
        <img
          class="gallery-hero-art"
          src="${x}"
          alt=""
          decoding="async"
          fetchpriority="high"
        />
        <p class="gallery-kicker">Public library</p>
        <div class="gallery-hero-row">
          <div>
            <h1 id="gallery-title">${l(E(a.surface))}</h1>
            <p class="gallery-copy">
              ${l(H(a.surface))}
            </p>
          </div>
          <div class="gallery-count" data-gallery-count aria-live="polite">-</div>
        </div>
        <div class="gallery-surface-tabs" role="radiogroup" aria-label="Public artifact type">
          ${y("","All")}
          ${y("wiki","Wikis")}
          ${y("docs","Docs")}
        </div>
      </section>

      <form class="gallery-controls" data-gallery-controls role="search">
        <label class="gallery-search">
          ${u("search")}
          <span class="sr-only">Search public wikis and docs</span>
          <input
            type="search"
            name="q"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search wikis and docs"
            value="${l(a.q)}"
            data-gallery-search
          />
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${u("sort")}<b>Sort</b></span>
          <strong data-gallery-select-value="sort">${l(M(a.sort))}</strong>
          <select name="sort" data-gallery-sort>
            ${i("updated","Updated",a.sort)}
            ${i("published","New",a.sort)}
            ${i("title","Title A-Z",a.sort)}
            ${i("pages","Most pages",a.sort)}
          </select>
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${u("tag")}<b>Format</b></span>
          <strong data-gallery-select-value="format">All</strong>
          <select name="format" data-gallery-format>
            <option value="">All formats</option>
          </select>
        </label>
        <label class="gallery-select">
          <span class="gallery-select-label">${u("layers")}<b>Pages</b></span>
          <strong data-gallery-select-value="pages">${l(C(a.pages))}</strong>
          <select name="pages" data-gallery-pages>
            <option value="">Any length</option>
            ${i("compact","1-4 pages",a.pages)}
            ${i("standard","5-8 pages",a.pages)}
            ${i("deep","9+ pages",a.pages)}
          </select>
        </label>
      </form>

      <section class="gallery-results-head">
        <p data-gallery-status>Loading public items...</p>
        <button class="gallery-clear" type="button" data-gallery-clear hidden>Clear filters</button>
      </section>

      <section class="gallery-grid" data-gallery-results aria-live="polite">
        ${G()}
      </section>

      <nav class="gallery-pagination" data-gallery-pagination aria-label="Gallery pagination"></nav>
    </main>
  `)}function B(){s&&(s.addEventListener("submit",e=>{e.preventDefault(),c({page:1})}),s.addEventListener("input",e=>{const t=e.target instanceof HTMLInputElement?e.target:null;t?.matches("[data-gallery-search]")&&(p&&window.clearTimeout(p),p=window.setTimeout(()=>{c({q:t.value,page:1})},180))}),s.addEventListener("change",e=>{const t=e.target instanceof HTMLSelectElement?e.target:null;t&&(t.matches("[data-gallery-sort]")&&c({sort:t.value,page:1}),t.matches("[data-gallery-format]")&&c({format:t.value,page:1}),t.matches("[data-gallery-pages]")&&c({pages:t.value,page:1}))}),s.addEventListener("click",e=>{const t=e.target instanceof Element?e.target:null;if(!t)return;const r=t.closest("[data-gallery-page]");if(r){e.preventDefault(),c({page:Number(r.dataset.galleryPage)||1}),window.scrollTo({top:0,behavior:"smooth"});return}if(t.closest("[data-gallery-clear]")){e.preventDefault(),a={...a,q:"",format:"",pages:"",sort:"updated",page:1},k(),q(),m();return}const o=t.closest("[data-gallery-surface]");o&&(e.preventDefault(),c({surface:o.dataset.gallerySurface||"",page:1}))}))}function N(){document.documentElement.dataset.theme="dark",document.documentElement.dataset.publicTheme="dark",document.querySelector('meta[name="theme-color"]')?.setAttribute("content","#050505")}function c(e){a={...a,...e,q:String(e.q??a.q).trim(),sort:L(String(e.sort??a.sort)),format:String(e.format??a.format).trim(),pages:String(e.pages??a.pages).trim(),surface:T(String(e.surface??a.surface)),page:Math.max(1,Math.trunc(Number(e.page??a.page))||1)},q(),m()}async function m(){const e=++g;v(!0);try{const t=await fetch(`/api/public/wiki?${Z(a)}`,{headers:{accept:"application/json"}}),r=await t.json().catch(()=>({}));if(!t.ok||r.error)throw new Error(r.error||`Could not load gallery (${t.status}).`);if(e!==g)return;F(r)}catch(t){if(e!==g)return;z(t instanceof Error?t.message:String(t))}finally{e===g&&v(!1)}}function F(e){const t=e.items||[],r=e.pagination||{page:1,total:0,pageCount:1,hasNext:!1,hasPrevious:!1};a.page=r.page,j(e.facets||{}),k();const o=s?.querySelector("[data-gallery-count]");o&&(o.innerHTML=`<strong>${r.total}</strong><span>${d(r.total,a.surface)}</span>`);const n=s?.querySelector("[data-gallery-status]");if(n){const S=w(),P=d(r.total,a.surface);n.textContent=r.total?`${r.total} public ${P}${S?" after filters":""}`:S?`No ${d(2,a.surface)} match those filters yet.`:`No public ${d(2,a.surface)} are published yet.`}const h=s?.querySelector("[data-gallery-clear]");h&&(h.hidden=w()===0);const b=s?.querySelector("[data-gallery-results]");b&&(b.innerHTML=t.length?t.map(U).join(""):I());const $=s?.querySelector("[data-gallery-pagination]");$&&($.innerHTML=R(r))}function j(e){const t=s?.querySelector("[data-gallery-format]");if(!t)return;const r=e?.formats||[],o=!a.format||r.some(n=>n.value===a.format);t.innerHTML=['<option value="">All formats</option>',...r.map(n=>i(n.value,`${n.label} (${n.count})`,a.format)),o?"":i(a.format,a.format,a.format)].join("")}function U(e){const t=X(e.updatedAt||e.publishedAt);return`
    <a class="gallery-card" href="${l(e.href)}" aria-label="Open ${l(e.title)}">
      <div class="gallery-thumb" aria-hidden="true">
        <div class="gallery-thumb-meta">
          <span>${u("book")}${e.pages||0}</span>
          <span>${l(e.surface==="docs"?"Docs":e.formatLabel)}</span>
        </div>
        <strong>${l(K(e.title))}</strong>
        <small>${l(e.repository)}</small>
      </div>
      <div class="gallery-card-body">
        <div class="gallery-repo">
          <span>${l(e.owner)}</span>
          <span>${l(e.repo)}</span>
        </div>
        <h2>${l(e.title)}</h2>
        <p>${l(e.description)}</p>
        <div class="gallery-card-foot">
          <span>${t?`Updated ${l(t)}`:"Recently published"}</span>
          <span>${e.surface==="docs"?"Docs":"Wiki"}</span>
          <span>${e.sourceFiles||0} source ${e.sourceFiles===1?"file":"files"}</span>
        </div>
      </div>
    </a>
  `}function R(e){return e.pageCount<=1?"":`
    <button type="button" data-gallery-page="${e.page-1}" ${e.hasPrevious?"":"disabled"}>
      ${u("arrowLeft")} Previous
    </button>
    <span>Page ${e.page} of ${e.pageCount}</span>
    <button type="button" data-gallery-page="${e.page+1}" ${e.hasNext?"":"disabled"}>
      Next ${u("arrowRight")}
    </button>
  `}function z(e){const t=s?.querySelector("[data-gallery-count]");t&&(t.textContent="-");const r=s?.querySelector("[data-gallery-status]");r&&(r.textContent="Gallery took a tiny detour.");const o=s?.querySelector("[data-gallery-results]");o&&(o.innerHTML=`
      <div class="gallery-empty" role="alert">
        <strong>Could not load public items.</strong>
        <p>${l(e)}</p>
      </div>
    `);const n=s?.querySelector("[data-gallery-pagination]");n&&(n.innerHTML="")}function v(e){s?.querySelector("[data-gallery-results]")?.classList.toggle("loading",e)}function G(){return Array.from({length:6},()=>`
    <div class="gallery-card gallery-card-skeleton" aria-hidden="true">
      <div class="gallery-thumb"></div>
      <div class="gallery-card-body">
        <span></span>
        <strong></strong>
        <p></p>
      </div>
    </div>
  `).join("")}function I(){return`
    <div class="gallery-empty">
      <strong>No matching wikis.</strong>
      <p>Try a softer search or clear a filter.</p>
    </div>
  `}function k(){const e=s?.querySelector("[data-gallery-search]");e&&e.value!==a.q&&document.activeElement!==e&&(e.value=a.q);const t=s?.querySelector("[data-gallery-sort]");t&&(t.value=a.sort);const r=s?.querySelector("[data-gallery-format]");r&&(r.value=a.format);const o=s?.querySelector("[data-gallery-pages]");o&&(o.value=a.pages),Q(),W()}function q(){const e=new URLSearchParams;a.q&&e.set("q",a.q),a.sort!=="updated"&&e.set("sort",a.sort),a.format&&e.set("format",a.format),a.pages&&e.set("pages",a.pages),a.surface&&a.surface!==A()&&e.set("surface",a.surface),a.page>1&&e.set("page",String(a.page));const t=e.toString(),r=a.surface==="docs"?"/public/docs":"/public/wikis";window.history.replaceState(null,"",`${r}${t?`?${t}`:""}`)}function Z(e){const t=new URLSearchParams;return t.set("page",String(e.page)),t.set("pageSize",String(e.pageSize)),e.q&&t.set("q",e.q),e.sort&&t.set("sort",e.sort),e.format&&t.set("format",e.format),e.pages&&t.set("pages",e.pages),e.surface&&t.set("surface",e.surface),t.toString()}function O(){const e=new URLSearchParams(window.location.search);return{q:String(e.get("q")||"").trim(),sort:L(e.get("sort")||"updated"),format:String(e.get("format")||"").trim(),pages:String(e.get("pages")||"").trim(),surface:T(e.get("surface")||A()),page:Math.max(1,Math.trunc(Number(e.get("page")||"1"))||1),pageSize:12}}function w(){return[a.q,a.format,a.pages,a.surface].filter(Boolean).length+(a.sort==="updated"?0:1)}function L(e){return["updated","published","title","pages"].includes(e)?e:"updated"}function W(){f("sort",M(a.sort)),f("format",J(a.format,V("[data-gallery-format]","All"))),f("pages",C(a.pages))}function Q(){s?.querySelectorAll("[data-gallery-surface]").forEach(r=>{const o=(r.dataset.gallerySurface||"")===a.surface;r.classList.toggle("active",o),r.setAttribute("aria-checked",o?"true":"false")});const e=s?.querySelector("#gallery-title");e&&(e.textContent=E(a.surface));const t=s?.querySelector(".gallery-copy");t&&(t.textContent=H(a.surface))}function f(e,t){const r=s?.querySelector(`[data-gallery-select-value="${e}"]`);r&&(r.textContent=t)}function V(e,t){return s?.querySelector(e)?.selectedOptions?.[0]?.textContent?.replace(/\s+\(\d+\)$/,"").trim()||t}function M(e){return e==="published"?"New":e==="title"?"A-Z":e==="pages"?"Pages":"Updated"}function C(e){return e==="compact"?"1-4":e==="standard"?"5-8":e==="deep"?"9+":"Any"}function J(e,t){return e?{basic:"Basic",technical:"Technical","first-30":"First 30",eli5:"ELI5","mental-model":"Mental","socratic-exploration":"Socratic","feature-scout":"Scout","worth-stealing":"Steal","hidden-quirks":"Quirks","pattern-discovery":"Patterns","repo-comparison":"Compare","debugging-atlas":"Debug","tech-reader":"Brief",documentation:"Docs",custom:"Custom"}[e]||t:"All"}function y(e,t){const r=e===a.surface;return`<button class="${r?"active":""}" type="button" role="radio" aria-checked="${r?"true":"false"}" data-gallery-surface="${l(e)}">${l(t)}</button>`}function T(e){const t=String(e||"").trim().toLowerCase();return t==="wiki"||t==="docs"?t:""}function A(){return window.location.pathname.replace(/\/+$/,"")==="/public/docs"?"docs":""}function E(e){return e==="docs"?"Browse generated docs.":e==="wiki"?"Browse repo wikis.":"Browse repo knowledge."}function H(e){return e==="docs"?"Functional technical docs generated from repositories and folders.":e==="wiki"?"Source-grounded repository wikis published from rlm-wiki.":"Source-grounded wikis and technical docs published from rlm-wiki."}function d(e,t){return t==="docs"?e===1?"doc":"docs":t==="wiki"?e===1?"wiki":"wikis":e===1?"item":"items"}function i(e,t,r){return`<option value="${l(e)}" ${e===r?"selected":""}>${l(t)}</option>`}function K(e){const t=String(e||"Wiki").replace(/\s+Wiki$/i,"");return t.length>42?`${t.slice(0,39).trim()}...`:t}function X(e){const t=Date.parse(String(e||""));return Number.isFinite(t)?new Intl.DateTimeFormat([],{month:"short",day:"numeric",year:"numeric"}).format(new Date(t)):""}function u(e){const r={arrowLeft:'<path d="m15 18-6-6 6-6"/><path d="M21 12H9"/>',arrowRight:'<path d="m9 18 6-6-6-6"/><path d="M3 12h12"/>',book:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',layers:'<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',moon:'<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"/>',search:'<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="8"/>',sort:'<path d="m7 15 5 5 5-5"/><path d="M12 20V4"/><path d="m17 9-5-5-5 5"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',tag:'<path d="M12.6 2.6H4.5a2 2 0 0 0-2 2v8.1a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l8.2-8.2a2 2 0 0 0 0-2.8L14 3.2a2 2 0 0 0-1.4-.6Z"/><path d="M7.5 7.5h.01"/>'}[e]||"";return r?`<svg class="gallery-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${r}</svg>`:""}function l(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
