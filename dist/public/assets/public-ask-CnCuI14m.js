import"./modulepreload-polyfill-B5Qt9EMX.js";import{p as F,r as V}from"./public-agent-prompt-37QLkfx1.js";import"./vercel-analytics-DchYkPep.js";const x={workingThroughEvidence:"Working through the repository evidence...",runIncomplete:"The run did not complete.",canceled:"Canceled.",copyQuestion:"Copy question",copyAnswer:"Copy answer",copy:"Copy",working:"Working",answeredAt:e=>`Answered at ${e}`,answeredLocally:"Answered locally",clarified:e=>`Clarified · ${e}`,clarifiedExpandHint:"Show the clarifying questions you answered"};function z(e,t,a){const n=a.askTurns(e),r=K(a.copy);for(let s=n.length-1;s>=0&&!(n[s]?.status==="done"&&n[s]?.answer);s-=1);return n.length-1,n.map((s,c)=>{const u=s.answer||(s.status==="running"?r.workingThroughEvidence:s.status==="error"?r.runIncomplete:s.status==="canceled"?r.canceled:""),p=!s.answer||a.isWorkingAnswer(u),l=s.status==="running"&&p,_=s.status==="running"&&!l&&!t.widget,y=s.status==="running"&&!p?{key:a.streamKey(e,s)}:null,b=W(s,c,a,r);if(l&&!t.widget)return`
          ${b}
          <section class="chat-message chat-message-assistant answer-block ask-turn is-process" data-chat-message-from="assistant" data-turn-index="${c}">
            <div class="answer-content">
              ${a.processStream(e,s,t)}
            </div>
          </section>`;if(_)return`
          ${b}
          <section class="chat-message chat-message-assistant answer-block ask-turn is-live-answer" data-chat-message-from="assistant" data-turn-index="${c}">
            <div class="answer-content">
              ${a.processStream(e,s,t)}
              ${a.renderMarkdown(u,e,y)}
            </div>
          </section>`;const C=l?"":`<button class="turn-copy-button answer-copy-button" type="button" data-copy-answer data-turn-index="${c}" aria-label="${a.escape(r.copyAnswer)}" data-label="${a.escape(r.copy)}">${a.copyIcon}</button>`;return t.widget?`
          ${b}
          <section class="chat-message chat-message-assistant answer-block ask-turn" data-chat-message-from="assistant" data-turn-index="${c}">
            <details class="answer-disclosure" open>
              <summary>${a.escape(a.turnStamp(s,e,c))}</summary>
              <div class="answer-content">
                ${l?a.processStream(e,s,t):""}
                ${l?"":a.renderMarkdown(u,e,y)}
                ${C}
              </div>
            </details>
            <div class="answer-preview">${a.answerPreview(s.answer||"")}</div>
          </section>`:`
          ${b}
          <section class="chat-message chat-message-assistant answer-block ask-turn" data-chat-message-from="assistant" data-turn-index="${c}">
            <div class="answer-content">
              ${l?a.processStream(e,s,t):""}
              ${l?"":a.renderMarkdown(u,e,y)}
              ${l?"":a.answerActions?.(s,c)||""}
              ${C}
            </div>
          </section>`}).join("")}function W(e,t,a,n){return`
          <section class="chat-message chat-message-user prompt-block user-message ask-turn" data-chat-message-from="user" data-turn-index="${t}">
            <div class="chat-message-inner question-wrap">
              <div class="question-bubble chat-message-bubble">${a.escape(e.question||"")}</div>
              <div class="chat-message-meta question-meta-row">
                ${Q(e,a,n)}
                <button class="turn-copy-button question-copy-button" type="button" data-copy-question data-turn-index="${t}" aria-label="${a.escape(n.copyQuestion)}" data-label="${a.escape(n.copy)}">${a.copyIcon}</button>
              </div>
            </div>
          </section>`}function Q(e,t,a){const n=(e.clarifications||[]).filter(s=>s&&String(s.question||"").trim());if(!n.length)return"";const r=n.map(s=>`
              <li class="clarified-row">
                <span class="clarified-q">${t.escape(String(s.question||"").trim())}</span>
                <span class="clarified-a">${t.escape(String(s.answer||"").trim())}</span>
              </li>`).join("");return`<details class="clarified-pill">
                <summary class="clarified-summary" aria-label="${t.escape(a.clarifiedExpandHint)}" title="${t.escape(a.clarifiedExpandHint)}">
                  <span class="clarified-dot" aria-hidden="true"></span>
                  <span class="clarified-label">${t.escape(a.clarified(n.length))}</span>
                </summary>
                <ul class="clarified-list">${r}</ul>
              </details>`}function K(e){return{...x,...e||{},answeredAt:e?.answeredAt||x.answeredAt}}const M={heading:"Outline",ariaLabel:"Conversation outline",untitledTurn:e=>`Question ${e}`};function Z(e){return{...M,...e||{},untitledTurn:e?.untitledTurn||M.untitledTurn}}function L(e,t=80){const a=String(e||"").replace(/\s+/g," ").trim();return a?a.length<=t?a:`${a.slice(0,t-1).trimEnd()}…`:""}function G(e,t){const a=t.askTurns(e);if(a.length<2)return"";const n=Z(t.copy),r=a.map((u,p)=>{const l=L(u.question||"")||n.untitledTurn(p+1);return`<button type="button" class="docs-page-rail-tick ask-outline-tick" data-outline-turn="${p}" title="${t.escape(l)}" aria-label="${t.escape(l)}"></button>`}).join(""),s=a.map((u,p)=>{const l=L(u.question||"")||n.untitledTurn(p+1);return`<button type="button" class="docs-page-rail-row ask-outline-link" data-outline-turn="${p}" title="${t.escape(l)}">
              <span class="ask-outline-row-main"><span class="ask-outline-index">${p+1}</span><span class="ask-outline-text">${t.escape(l)}</span></span>
            </button>`}).join(""),c=t.headingSlot||"";return`
        <nav class="ask-outline docs-page-rail" aria-label="${t.escape(n.ariaLabel)}" data-ask-outline>
          <div class="docs-page-rail-zone">
            <div class="docs-page-rail-ticks ask-outline-ticks">${r}</div>
          </div>
          <div class="docs-page-rail-popover ask-outline-popover">
            <div class="docs-page-rail-heading ask-outline-heading-row">
              <span class="ask-outline-heading">${t.escape(n.heading)}</span>
              ${c}
            </div>
            <div class="docs-page-rail-list ask-outline-list">${s}
            </div>
          </div>
        </nav>`}let o=null,H=null,f=null,h=$e(),g=!1,$=null,w=0,v=null;const P=new WeakMap,d=document.getElementById("public-ask-root"),Y="https://esm.sh/beautiful-mermaid@1.1.3/es2022/beautiful-mermaid.bundle.mjs",q={bg:"var(--mermaid-bg)",fg:"var(--mermaid-fg)",line:"var(--mermaid-line)",accent:"var(--mermaid-accent)",muted:"var(--mermaid-muted)",surface:"var(--mermaid-surface)",border:"var(--mermaid-border)",transparent:!0};D(h);J();document.addEventListener("click",e=>{const t=e.target instanceof Element?e.target:null;if(!t||de(e,t))return;if(t.closest("[data-public-theme-toggle]")){e.preventDefault(),ue();return}const n=t.closest("[data-code-viewer-copy]");if(n){e.preventDefault(),e.stopImmediatePropagation(),ge(n);return}if(!o)return;const r=t.closest("[data-outline-turn]");if(r){e.preventDefault(),se(Number(r.dataset.outlineTurn));return}const s=t.closest("[data-copy-answer]");if(s){e.preventDefault(),E(s,"answer");return}const c=t.closest("[data-copy-question]");c&&(e.preventDefault(),E(c,"question"))});document.addEventListener("keydown",e=>{g&&e.key==="Escape"&&(e.preventDefault(),U())});async function J(){try{const e=N();if(!e)throw new Error("Shared conversation link is missing.");const t=await fetch(`/api/public/ask/${encodeURIComponent(e)}`,{headers:{accept:"application/json"}}),a=await t.json().catch(()=>({}));if(!t.ok||!a.ask)throw new Error(a.error||`Could not load shared conversation (${t.status}).`);o=a.ask,H=a.snapshot||null,f=a.publication||null,document.title=`${o.title||"Shared Ask"} · rlm-wiki Ask`,X()}catch(e){if(!d)return;d.innerHTML=`<div class="public-wiki-error">${i(e instanceof Error?e.message:String(e))}</div>`}}function X(){if(!d||!o)return;const e=o,t=f?.visibility==="private",a=`${A()}.md`,n=`${A()}/llms.txt`;d.innerHTML=`
    <header class="public-wiki-topbar public-ask-topbar">
      <a class="public-wiki-brand" href="/">
        <strong>rlm-wiki</strong>
        <span>${i(e.title||"Shared conversation")}</span>
      </a>
      <nav class="public-wiki-actions" aria-label="Shared conversation links">
        ${le()}
        ${ce()}
        <a class="public-wiki-cta" href="${i(a)}" title="Markdown transcript for agents" aria-label="Markdown transcript for agents">${m("page")}<span>Markdown</span></a>
        <a class="public-wiki-cta" href="${i(n)}" title="llms.txt agent index" aria-label="llms.txt agent index">${m("list")}<span>llms.txt</span></a>
        ${t?`<span class="public-wiki-private-badge">${m("lock")}Private link</span>`:""}
      </nav>
    </header>
    <main class="public-ask-main">
      <section class="asks-layout ask-session-layout public-ask-layout">
        <div class="center-pane">
          ${ae()}
          <article class="ask-thread" data-public-ask-thread>
            ${ee()}
            ${te()}
            ${re()}
          </article>
        </div>
      </section>
    </main>
  `,ye(d),ie()}function ee(){const e=o;if(!e)return"";const t=(e.scopes&&e.scopes.length?e.scopes:[e.repoName]).filter(Boolean),a=O(String(H?.publishedAt||f?.publishedAt||"")),n=[...t.slice(0,4).map(r=>`<span class="ask-meta-pill" title="${i(r)}">${i(r)}</span>`),e.runtime?`<span class="ask-meta-pill">${i(e.runtime)}</span>`:"",e.model?`<span class="ask-meta-pill">${i(e.model)}</span>`:"",a?`<span class="ask-meta-pill">Shared ${i(a)}</span>`:""].filter(Boolean);return`
    <header class="public-ask-header">
      <span class="eyebrow">Shared Ask conversation</span>
      <h1>${i(e.title||"Shared conversation")}</h1>
      ${n.length?`<div class="public-ask-meta-row">${n.join("")}</div>`:""}
    </header>
  `}function te(){const e=o;return e?z({status:"done",updatedAt:e.askedAt},{widget:!1},{askTurns:()=>R(),answerPreview:()=>"",copyIcon:m("copy"),escape:i,isWorkingAnswer:()=>!1,processStream:()=>"",renderMarkdown:t=>ne(t),streamKey:()=>"",turnStamp:t=>O(String(t.updatedAt||""))||"Answered"}):""}function ae(){const e=o;return e?G({status:"done",updatedAt:e.askedAt},{askTurns:()=>R(),escape:i,copy:{heading:"Outline",ariaLabel:"Conversation outline"}}):""}function R(){return(o?.turns||[]).map(e=>({question:e.question,answer:e.answer,status:"done",updatedAt:e.askedAt,clarifications:e.clarifications}))}function ne(e){return V(String(e||""),!0,null,{escape:i,sourceTextLabel:t=>t,sourceLink:we,isSourceReference:t=>/^[A-Za-z0-9._/-]+(?::\d+(?:-\d+)?)?$/.test(t),renderMermaidBlock:ke,icon:m,compactSourceCitations:!0,resolveMediaSrc:t=>{const a=String(t||"").trim();return/^(?:https?:|data:image\/|\/)/i.test(a)?a:""}})}function re(){const e=o?.sources||[];if(!e.length)return"";const t=e.map(a=>`
      <li>
        <code>${i(a.path)}</code>
        ${a.label&&a.label!==a.path?`<span class="public-ask-source-detail">${i(a.label)}</span>`:""}
        ${a.detail?`<span class="public-ask-source-detail">${i(a.detail)}</span>`:""}
        ${a.excerpt?`<pre class="public-ask-source-excerpt">${i(a.excerpt)}</pre>`:""}
      </li>`).join("");return`
    <details class="public-ask-sources">
      <summary>Sources cited in this conversation (${e.length})</summary>
      <ul class="public-ask-source-list">${t}</ul>
    </details>
  `}function se(e){if(!Number.isFinite(e))return;const t=d?.querySelector("[data-public-ask-thread]"),a=t?.querySelector(`.ask-turn[data-chat-message-from="user"][data-turn-index="${e}"]`);!t||!a||(t.scrollTo({top:Math.max(0,a.offsetTop-18),behavior:"smooth"}),B(e))}function ie(){const e=d?.querySelector("[data-public-ask-thread]");if(!e)return;const t=()=>B(oe(e));e.addEventListener("scroll",t,{passive:!0}),t()}function oe(e){const t=Array.from(e.querySelectorAll('.ask-turn[data-chat-message-from="user"]'));if(!t.length)return 0;const a=e.scrollTop+90;let n=0;for(const r of t)r.offsetTop<=a&&(n=Number(r.dataset.turnIndex||0));return n}function B(e){d?.querySelectorAll(".ask-outline-link, .ask-outline-tick").forEach(t=>{t.classList.toggle("is-active",Number(t.dataset.outlineTurn)===e)})}async function E(e,t){const a=Number(e.dataset.turnIndex),n=o?.turns?.[a];if(n)try{await T(t==="answer"?n.answer:n.question),k(e,"Copied")}catch{k(e,"Copy failed")}}function k(e,t){const a=e.dataset.label||"";e.dataset.label=t,e.classList.add("is-copied"),window.clearTimeout(P.get(e)),P.set(e,window.setTimeout(()=>{e.dataset.label=a,e.classList.remove("is-copied")},1600))}function ce(){return`
    <button
      class="public-wiki-cta public-wiki-agent-button"
      type="button"
      data-public-agent-open
      aria-haspopup="dialog"
      aria-expanded="${g?"true":"false"}"
      title="Copy an agent handoff prompt"
    >
      ${m("plus")}
      <span>Add Agent</span>
    </button>
  `}function le(){const e=h==="light"?"dark":"light";return`
    <button
      class="public-theme-toggle"
      type="button"
      data-public-theme-toggle
      aria-label="Switch to ${e} mode"
      title="Switch to ${e} mode"
    >
      <span class="public-theme-toggle-track" aria-hidden="true">
        ${m("sun","public-theme-icon public-theme-sun")}
        ${m("moon","public-theme-icon public-theme-moon")}
      </span>
    </button>
  `}function ue(){h=h==="light"?"dark":"light",localStorage.setItem("rlm-wiki-public:theme",h),D(h);const e=d?.querySelector("[data-public-theme-toggle]"),t=h==="light"?"dark":"light";e?.setAttribute("aria-label",`Switch to ${t} mode`),e?.setAttribute("title",`Switch to ${t} mode`)}function D(e){document.documentElement.dataset.theme=e,document.documentElement.dataset.publicTheme=e,document.querySelector('meta[name="theme-color"]')?.setAttribute("content",e==="light"?"#f6f7f5":"#08090a")}function de(e,t){const a=t.closest("[data-public-agent-open]");if(a)return e.preventDefault(),pe(a),!0;const n=t.closest("[data-public-agent-layer]");if(!n)return!1;const r=t.closest("[data-public-agent-copy]");return r?(e.preventDefault(),he(r),!0):((t.closest("[data-public-agent-close]")||t===n)&&(e.preventDefault(),U()),!0)}function pe(e){o&&(g=!0,$=e,e.setAttribute("aria-expanded","true"),me(!0))}function U(){if(!g)return;g=!1,window.clearTimeout(w),w=0,d?.querySelector("[data-public-agent-open]")?.setAttribute("aria-expanded","false");const e=S();e&&(e.innerHTML="");const t=$;$=null,t?.focus({preventScroll:!0})}function me(e=!1){const t=S();if(!t||!o)return;const a=`${window.location.origin}${A()}`,n=F({title:o.title||"Shared Ask conversation",description:o.description||o.turns[0]?.question||"",pageUrl:a,llmsUrl:`${a}/llms.txt`,llmsFullUrl:`${a}/llms-full.txt`,repoName:o.repoName||(o.scopes||[])[0]||"",turnCount:o.turns.length,updatedAt:String(f?.updatedAt||"")});t.innerHTML=`
    <div class="public-agent-layer" data-public-agent-layer>
      <section class="public-agent-popover" role="dialog" aria-modal="true" aria-labelledby="public-agent-title" aria-describedby="public-agent-description">
        <button class="public-agent-close" type="button" data-public-agent-close aria-label="Close">${m("x")}</button>
        <div class="public-agent-kicker">Works with any coding agent</div>
        <h2 id="public-agent-title">Bring your agent into this conversation</h2>
        <p id="public-agent-description">Copy one prompt that tells your agent to read the question index first, fetch the full transcript only if needed, and stay grounded in this shared Q&amp;A.</p>
        <pre class="public-agent-prompt" tabindex="0"><code data-public-agent-prompt>${i(n)}</code></pre>
        <p class="public-agent-note">The prompt is vendor-agnostic. It points agents at <code>llms.txt</code> first so they can load the smallest useful context before using the full Markdown transcript.</p>
        <button class="public-agent-copy" type="button" data-public-agent-copy>Copy for agent</button>
        <button class="public-agent-skip" type="button" data-public-agent-close>Close</button>
      </section>
    </div>
  `,e&&requestAnimationFrame(()=>t.querySelector("[data-public-agent-copy]")?.focus())}function S(){let e=document.getElementById("public-agent-popover-root");return e||(e=document.createElement("div"),e.id="public-agent-popover-root",document.body.appendChild(e)),e}async function he(e){const t=S()?.querySelector("[data-public-agent-prompt]")?.textContent||"";if(t.trim())try{await T(t),I(e,"Copied")}catch{I(e,"Copy failed")}}function I(e,t){const a=e.dataset.defaultLabel||e.textContent||"Copy for agent";e.dataset.defaultLabel=a,e.textContent=t,window.clearTimeout(w),w=window.setTimeout(()=>{e.textContent=e.dataset.defaultLabel||"Copy for agent"},1600)}async function T(e){let t=null;if(navigator.clipboard?.writeText)try{await navigator.clipboard.writeText(e);return}catch(n){t=n}const a=document.createElement("textarea");a.value=e,a.setAttribute("readonly",""),a.style.position="fixed",a.style.left="-9999px",a.style.top="0",document.body.appendChild(a),a.focus({preventScroll:!0}),a.select(),a.setSelectionRange(0,a.value.length);try{if(!document.execCommand("copy"))throw t||new Error("Copy command failed.")}finally{a.remove()}}function fe(e){const t=e.closest(".code-viewer");if(!t)return"";const a=t.dataset.codeViewerCopyCode||t.dataset.codeFull||"";return a?j(a):t.querySelector("pre code")?.textContent||""}async function ge(e){const t=fe(e);if(t.length)try{await T(t),k(e,"Copied")}catch{k(e,"Copy failed")}}function be(){const e=[o?.repoName,...o?.scopes||[]];for(const t of e){const a=String(t||"").trim().replace(/\/$/,"");if(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/i.test(a))return a;if(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a))return`https://github.com/${a}`}return""}function we(e,t){const a=String(t||e||"").replace(/^`|`$/g,""),n=a.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/),r=n?.[1]||a,s=n?.[2]?`#L${n[2]}`:"",c=be(),u=c&&r&&!r.includes("…")?`${c}/blob/HEAD/${r.split("/").map(encodeURIComponent).join("/")}${s}`:"";return u?`<a class="source-link" href="${i(u)}" target="_blank" rel="noreferrer">${i(e)}</a>`:`<code>${i(e)}</code>`}function ke(e){const t=Ae(e);return`<div class="mermaid desktop-mermaid mermaid-loading" data-mermaid-source="${i(t)}" aria-label="Mermaid diagram">${i(e)}</div>`}async function ye(e){const t=Array.from(e.querySelectorAll(".mermaid")).filter(r=>r.isConnected&&r.dataset.mermaidRendered!=="1"&&r.dataset.mermaidRendering!=="1");if(!t.length)return;t.forEach(r=>{r.dataset.mermaidRendering="1"});const a=await ve();if(!a?.renderMermaidSVG){t.forEach(r=>{delete r.dataset.mermaidRendering,r.classList.remove("mermaid-loading"),r.classList.add("mermaid-error")});return}const n={...a.THEMES?.["zinc-light"]||q,...q};t.forEach(r=>{const s=j(r.dataset.mermaidSource||"")||r.textContent||"";if(!s.trim()){delete r.dataset.mermaidRendering;return}try{r.innerHTML=a.renderMermaidSVG?.(s,n)||i(s),r.dataset.mermaidRendered="1",r.classList.remove("mermaid-loading","mermaid-error"),r.classList.add("beautiful-mermaid")}catch{r.textContent=s,r.classList.remove("mermaid-loading"),r.classList.add("mermaid-error")}finally{delete r.dataset.mermaidRendering}})}function ve(){return v||(v=import(Y).then(e=>{const t=e;return t.renderMermaidSVG?t:t.default||null}).catch(e=>(console.warn("beautiful-mermaid unavailable; keeping Mermaid source visible.",e),null))),v}function N(){const e=window.location.pathname.split("/").filter(Boolean);return(e[0]==="public"||e[0]==="share")&&e[1]==="ask"?decodeURIComponent(e[2]||""):""}function A(){const e=String(f?.publicId||N());return`/${f?.visibility==="private"?"share":"public"}/ask/${encodeURIComponent(e)}`}function $e(){return localStorage.getItem("rlm-wiki-public:theme")==="light"?"light":"dark"}function O(e){if(!e)return"";const t=new Date(e);return Number.isNaN(t.getTime())?"":t.toLocaleDateString([],{year:"numeric",month:"short",day:"numeric"})}function Ae(e){try{return encodeURIComponent(e)}catch{return e}}function j(e){try{return decodeURIComponent(e)}catch{return e}}function m(e,t="app-icon"){const n={arrowRight:'<path d="m9 18 6-6-6-6"/><path d="M3 12h12"/>',book:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',chevronDown:'<path d="m6 9 6 6 6-6"/>',copy:'<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',list:'<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',moon:'<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z"/>',page:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',plus:'<path d="M12 5v14"/><path d="M5 12h14"/>',search:'<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',statusCheck:'<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'}[e]||"";return n?`<svg class="${i(t)}" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${n}</svg>`:""}function i(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
