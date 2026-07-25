import type { AgentRuntime } from "../agent-runtime.ts";
import { defaultWikiPageCountForDepth, normalizeWikiLanguages, normalizeWikiPageCount, normalizeWikiPageCountMode, wikiAutoPageCountRange, wikiDepthForPageCount, wikiLanguagePrompt, type WikiDepth, type WikiLanguage, type WikiPageCountMode, type WikiStyle } from "../wiki-options.ts";
import { knowledgeProfilePrompt, type KnowledgeProfile } from "../knowledge-profile.ts";

/**
 * Prompt for the wiki-structure agent.
 *
 * Adapted from deepwiki-open's structure-determination prompt
 * (src/app/[owner]/[repo]/page.tsx:574-689) and tuned to produce a
 * DeepWiki-style hierarchy: 3-6 top-level sections, up to 30 pages, sub-pages
 * grouped under their sections.
 */
export function buildStructurePrompt(args: { owner: string; repo: string; sourcePath?: string | null; repos?: Array<{ id: string; label: string; url: string; branch?: string | null; sourcePath?: string | null }>; runtime?: AgentRuntime; depth?: WikiDepth; pageCount?: number; pageCountMode?: WikiPageCountMode | string; style?: WikiStyle; stylePrompt?: string; languages?: WikiLanguage[]; knowledgeProfile?: KnowledgeProfile; codeKb?: string; directEvidence?: string }): string {
  const { owner, repo, depth = "deep", style = "basic" } = args;
  // B7 fast-structure direct call: when pre-fetched evidence is provided the
  // prompt becomes a single-reply completion (no repo access, no tools). Only
  // the exploration sections change; the format contract stays byte-identical
  // so parseWikiStructureXml accepts the output verbatim.
  const directEvidence = String(args.directEvidence || "").trim();
  const docsMode = style === "documentation";
  const repos = args.repos?.length && args.repos.length > 1 ? args.repos : [];
  const isWorkspace = repos.length > 1;
  const sourcePath = String(args.sourcePath || "").trim();
  const targetPageCount = normalizeWikiPageCount(args.pageCount, defaultWikiPageCountForDepth(depth));
  const pageCountMode = normalizeWikiPageCountMode(args.pageCountMode);
  const autoRange = wikiAutoPageCountRange(targetPageCount);
  const pageCountRule = pageCountMode === "fixed"
    ? {
        pageCount: targetPageCount === 1 ? "exactly 1 total page" : `exactly ${targetPageCount} total pages`,
        targetLine: `${targetPageCount} pages`,
        hardRule: `This is a hard target; emit exactly ${targetPageCount} <page> ${targetPageCount === 1 ? "entry" : "entries"}.`,
        recap: `exactly ${targetPageCount} total ${targetPageCount === 1 ? "page" : "pages"}`,
      }
    : targetPageCount === 1
      ? {
          pageCount: "exactly 1 total page",
          targetLine: "1 page",
          hardRule: "This is a hard target; emit exactly 1 <page> entry.",
          recap: "exactly 1 total page",
        }
      : {
          pageCount: docsMode ? `3-${targetPageCount} route pages` : `${autoRange.min}-${autoRange.max} total pages`,
          targetLine: docsMode ? `auto docs manifest, hidden ceiling ${targetPageCount}` : `auto, up to ${targetPageCount} pages`,
          hardRule: docsMode
            ? `Predetermine the exact docs page count before writing XML, choosing the smallest useful number between 3 and ${targetPageCount}; then emit exactly that chosen number of <page> entries. Do not fill all ${targetPageCount} slots unless the repository genuinely needs that many distinct docs routes.`
            : `Choose the smallest useful number of pages between ${autoRange.min} and ${autoRange.max}. Do not fill all ${targetPageCount} slots unless the repository genuinely needs that many distinct pages.`,
          recap: docsMode ? `3-${targetPageCount} route pages, chosen by repository complexity` : `${autoRange.min}-${autoRange.max} total pages, chosen by repository complexity`,
        };
  const countDepth = wikiDepthForPageCount(targetPageCount);
  const shape = docsMode
    ? {
        sectionCount: "2-7 navigation groups",
        pageCount: pageCountRule.pageCount,
        pagesPerSection: "1-8 route pages per group, with no filler pages",
        explorationIntro: "Explore until you can name the product surface, install/first-use path, public APIs or commands, configuration model, examples, and real troubleshooting surfaces.",
        budget: "Budget: up to 35 iterations, but stop once another read would not change the docs manifest.",
      }
    : targetPageCount === 1
    ? {
        sectionCount: "1 top-level section",
        pageCount: pageCountRule.pageCount,
        pagesPerSection: "1 page in the section",
        explorationIntro: "Explore just enough to avoid a README-only overview — usually 1 targeted investigation step.",
        budget: "Budget: 1-2 exploration steps before drafting the single-page structure.",
      }
    : countDepth === "fast"
    ? {
        sectionCount: "2-4 top-level sections",
        pageCount: pageCountRule.pageCount,
        pagesPerSection: "1-4 pages per section",
        explorationIntro: "Explore just enough to avoid a README-only wiki — usually 1-2 targeted investigation steps.",
        budget: "Budget: up to 12 iterations, but most repos should need only 1-2 exploration steps before drafting.",
      }
    : countDepth === "regular"
      ? {
          sectionCount: "3-5 top-level sections",
          pageCount: pageCountRule.pageCount,
          pagesPerSection: "2-6 pages per section",
          explorationIntro: "Explore until you can name the entry points, core abstractions, major module groups, and runtime surfaces.",
          budget: "Budget: up to 20 iterations, but most repos should need only 2-4 exploration steps before drafting.",
        }
    : {
        sectionCount: "4-8 top-level sections",
        pageCount: pageCountRule.pageCount,
        pagesPerSection: "3-8 pages per section",
        explorationIntro: "Explore until you can name the entry points, core abstractions, major module groups, and runtime surfaces.",
        budget: "Budget: up to 35 iterations, but most repos should need only 4-8 exploration steps before drafting.",
      };
  const styleGuidance = wikiStyleGuidance(style, args.stylePrompt);
  const beyondReadmeGuidance = wikiBeyondReadmeGuidance(style);
  const languageGuidance = wikiLanguagePrompt(normalizeWikiLanguages(args.languages));
  const knowledgeGuidance = knowledgeProfilePrompt(args.knowledgeProfile, "wiki");
  const hierarchyGoal = wikiHierarchyGoal(style);
  const bookends = wikiBookendGuidance(style, targetPageCount);
  const depthLabel = docsMode
    ? `${countDepth === "fast" ? "Small" : countDepth === "regular" ? "Medium" : "Large"} docs generation budget`
    : `${depth === "fast" ? "Fast wiki" : depth === "regular" ? "Regular wiki" : "Deep wiki"}`;
  const decomposeGuidance = docsMode ? docsDecomposeGuidance() : wikiDecomposeGuidance();
  const sectionPatterns = docsMode ? docsSectionPatterns() : wikiSectionPatterns();
  const xmlExample = docsMode ? docsXmlExample(pageCountRule.recap) : wikiXmlExample(bookends, pageCountRule.recap);
  const exploration = isWorkspace
    ? docsMode
      ? [
          `${shape.explorationIntro} Do NOT settle on README-only structure from one repo.`,
          "",
          "1. List every repository directory in the workspace root.",
          "2. Search across repository subdirectories for manifests, commands, public APIs, examples, config schemas, providers/adapters, and shared terms.",
          "3. Read only files that change the docs manifest or page archetypes.",
        "4. Design docs pages around the shared technical surface first, then repo-specific reference pages where needed.",
          "5. Use namespaced paths in every `<file_path>`: `repoId:path/to/file.ext`.",
        ].join("\n")
      : [
        `${shape.explorationIntro} Do NOT settle on README-only structure from one repo.`,
        "",
        "1. List every repository directory in the workspace root.",
        "2. Search across repository subdirectories to compare entry points, manifests, commands, adapters, protocols, and shared concepts.",
        "3. Read only the load-bearing files.",
        "4. Design pages that explain each repo and the cross-repo relationship: overlap, contrast, integration opportunities, and what each project teaches.",
        "5. Use namespaced paths in every `<file_path>`: `repoId:path/to/file.ext`.",
      ].join("\n")
    : docsMode
      ? [
          `${shape.explorationIntro} Do NOT settle on a docs manifest from just the README.`,
          "",
          "1. Inspect `README.md` and the manifest (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`).",
          "2. List and search files to find public entry points, commands, examples, tests, configuration, route handlers, exported components, providers, and troubleshooting signals.",
          "3. Read load-bearing files that prove install, quickstart, guides, reference, examples, and operations pages.",
          "4. Prefer user-facing APIs, commands, schemas, examples, and tests over private internals.",
          "5. Expand only where another read would change the docs navigation or page archetype.",
        ].join("\n")
      : [
        `${shape.explorationIntro} Do NOT settle on a structure from just the README.`,
        "",
        "1. Inspect `README.md` and the manifest (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`).",
        "2. List and search files to see the real layout.",
        "3. Use repository search to get a structural outline before reading bodies: class/function/export definitions, route declarations, commands, plugin registrations, or config keys.",
        "4. Prefer clear entry points and load-bearing directories over mechanical repository metrics.",
        "5. Read a few load-bearing files carefully, then expand only where imports, exports, or search results point.",
      ].join("\n");
  const stopExploringLine = docsMode
    ? "Stop exploring when you can name the docs manifest, public entry points, setup path, task guides, reference surfaces, examples, and troubleshooting/operations pages that source evidence supports."
    : "Stop exploring when you can name the entry points, core abstractions, major module groups, and build/deploy/runtime surfaces.";
  const finalContract =
    "Your final message must contain one `<ANSWER>...</ANSWER>` block with the complete XML document. The XML must not go inside JavaScript, a markdown fence, or any legacy wrapper.";
  const finalChecklist = [
    "1. One `<ANSWER>...</ANSWER>` block.",
    "2. Inside it, one complete `<wiki_structure>` XML document.",
  ].join("\n");
  const workspaceNote = docsMode
    ? `This is a multi-repository docs artifact. The docs manifest should explain the product/workspace relationship, shared setup, integration paths, and repo-specific reference where useful. All source paths in \`relevant_files\` MUST use the repo namespace, e.g. \`${repos[0]?.id}:README.md\`.`
    : `This is a multi-repository wiki. The table of contents should explain both individual repositories and the relationship between them. All source paths in \`relevant_files\` MUST use the repo namespace, e.g. \`${repos[0]?.id}:README.md\`.`;
  const sourceScopeNote = sourcePath
    ? `Source scope: only document files under \`${sourcePath}/\`. The prepared working directory is this scoped folder; treat paths in \`<file_path>\` as relative to that folder unless a tool returns a repository-root-relative path. Do not plan pages for unrelated folders outside this scope.`
    : "";
  // Optional pre-rendered code-kb block (see src/prompts/code-kb.ts), appended
  // verbatim as the final section. Absent input keeps the prompt byte-identical.
  const codeKbSection = args.codeKb ? `\n\n${args.codeKb}` : "";
  const codeGraphExploreLead = args.codeKb
    ? [
        "Code graph is available in the final `<code-kb>` block. Prefer it first for inventory, hotspots, callers/callees, and symbol location (budget: at most 4 successful graph queries, then decide). Use local search/read only to verify paths you will put in `relevant_files` or when the graph is unhealthy.",
        "",
      ].join("\n")
    : "";
  const explorationSection = directEvidence
    ? `## Pre-fetched repository evidence (no exploration in this run)

This is a single-reply task: you have no repository access and no tools. Plan the structure only from the evidence below; do not invent files, commands, or subsystems it does not support.

${directEvidence}`
    : `## How to explore (BEFORE deciding)

${codeGraphExploreLead}${exploration}

${stopExploringLine}`;
  const filePathsRule = directEvidence
    ? "- Each page's `relevant_files` must be **3-6 real paths copied verbatim from the file inventory above** (fewer, sharply relevant paths beat broad coverage: every extra file slows that page's writing pass). Never invent or guess a path."
    : "- Each page's `relevant_files` must be **3-8 real paths** (verify with `await readFile` or `await glob`).";
  const budgetRecapLine = directEvidence
    ? "Single reply: emit the complete XML in this response. There are no exploration steps."
    : `${shape.budget} Continue only when another read would change the section/page split.`;
  const repositoryBlock = isWorkspace
    ? `Workspace repositories:
${repos.map((workspaceRef) => `- \`${workspaceRef.id}\` — **${workspaceRef.label}** (${workspaceRef.url}${workspaceRef.branch ? ` @ ${workspaceRef.branch}` : ""}${workspaceRef.sourcePath ? `, path ${workspaceRef.sourcePath}` : ""})`).join("\n")}

${workspaceNote}`
    : `Repository: **${owner}/${repo}**.${sourceScopeNote ? `\n\n${sourceScopeNote}` : ""}`;

  return `${styleGuidance.opening}

${repositoryBlock}

## Selected format mission

- Format: **${styleGuidance.label}**

- Depth: **${depthLabel}**
- Page target: **${pageCountRule.targetLine} (${countDepth === "fast" ? "Fast" : countDepth === "regular" ? "Regular" : "Deep / expensive"})**

${styleGuidance.structure}

${beyondReadmeGuidance ? `${beyondReadmeGuidance}\n` : ""}

${knowledgeGuidance ? `${knowledgeGuidance}\n` : ""}

## Output Languages

${languageGuidance}

For the structure XML, translate every human-facing text value into the selected language: title elements, description elements, section titles, page titles, and page descriptions. XML tag names, page ids, section ids, file paths, repo ids, and source identifiers remain source-accurate. The English examples below show XML shape only; do not copy their English prose into the actual wiki structure.

${hierarchyGoal}

## Required shape of the output

- **${shape.sectionCount}** (broad areas).
- **${shape.pageCount}** across all sections. ${pageCountRule.hardRule}
- The first page in \`<pages>\` must use the stable internal id \`id="page-overview"\` and must be the first \`<page_ref>\` in the first section.
- That first page is the ${docsMode ? "docs site's root page" : "wiki's introductory opening"}. Its visible \`<title>\` and \`<description>\` must match the selected format; ${docsMode ? "prefer `Overview`, `Introduction`, or the project name only when it is the strongest docs route." : "do not call it \"Overview\" unless that is genuinely the strongest title."}
- Opening page suggestion for this format: \`${bookends.openingTitle}\` — ${bookends.openingDescription}
${bookends.closingRule}
- **${shape.pagesPerSection}** (avoid orphan sections unless the repo is genuinely tiny; no mega-sections).
- Every page has \`parent_section\` set to a real section id.
- Use kebab-case ids: \`page-routing\`, \`daemon-and-profiles\`, \`skills-input-navigation\`.

${decomposeGuidance}

${sectionPatterns}

${explorationSection}

### File assignment rules
${filePathsRule}
- Prefer actual implementation files over docs.
- Shared, load-bearing files (e.g. a core utility) MAY appear in more than one page — that's fine.
${isWorkspace ? "- For multi-repo pages, include files from every relevant repo. Use namespaced paths exactly as shown in the repository list." : ""}

## Output — STRICT XML answer

${finalContract}

${xmlExample}

## Rules recap
- ${shape.sectionCount}, ${shape.pageCount}, ${shape.pagesPerSection}. Do not emit more than ${targetPageCount} pages.
- The first emitted page always uses internal id \`page-overview\`, but its visible title should be format-specific.
${targetPageCount > 1 && !docsMode ? "- The final emitted page should close the wiki with synthesis, next steps, reusable lessons, or a final map that fits the selected format." : ""}
- XML goes in the \`<ANSWER>\` block only. No markdown prose outside the XML answer.
- Escape \`&\` as \`&amp;\`, \`<\` as \`&lt;\`, \`>\` as \`&gt;\` inside XML text.
- ${budgetRecapLine}

## Critical Failure Mode

Do not finish with notes, a file list, or a summary of what you would generate. The parser needs the actual \`<wiki_structure>\` XML.

Your FINAL message must be:

${finalChecklist}

**Do not finalize until the full XML is inside \`<ANSWER>\` tags.**${codeKbSection}`;
}

function wikiHierarchyGoal(style: WikiStyle): string {
  const discoveryStyles: WikiStyle[] = [
    "feature-scout",
    "worth-stealing",
    "hidden-quirks",
    "pattern-discovery",
    "repo-comparison",
    "tech-reader",
  ];
  if (discoveryStyles.includes(style)) {
    return "Your structural goal is a navigable discovery wiki: a small number of broad sections that group focused, specific pages. Readers drill in; each page should expose one source-backed feature, pattern, quirk, comparison, or reusable idea rather than a module inventory.";
  }
  if (style === "eli5") {
    return "Your structural goal is a navigable plain-language wiki: a small number of broad sections that group focused, specific pages. Readers drill in; each page should turn one source-backed concept, actor, flow, or responsibility into the simplest useful explanation without losing important caveats.";
  }
  if (style === "socratic-exploration" || style === "mental-model") {
    return "Your structural goal is a navigable learning wiki: a small number of broad sections that group focused, specific pages. Readers drill in; each page should help them reason from first principles about one flow, boundary, invariant, question, or tradeoff.";
  }
  if (style === "documentation") {
    return "Your structural goal is a technical documentation-site artifact, not a wiki and not a tutorial. Infer a docs manifest first: adaptive themed navigation groups, one-concern route pages, page archetypes, and source-backed scope. The result must be agent- and human-friendly: themed groups (not directory inventories), stable route titles, exact identifiers, compact descriptions, and pages organized around public behavior, commands, APIs, schemas, configuration, constraints, and operational facts reflected by the repository. Use Orient → Use → Understand → Deepen when the evidence supports it, collapse stages the repository does not justify, and never substitute a module or package listing.";
  }
  return "Your goal is a **DeepWiki-style hierarchy** — a small number of broad *sections* that group a larger number of *focused, specific pages*. Readers drill in; each page is a deep-dive on a single concern, not a sprawling survey.";
}

function docsDecomposeGuidance(): string {
  return [
    "## How to decompose documentation (this is the important part)",
    "",
    "Do NOT produce a wiki-like code inventory or a directory map as the TOC. Build a docs manifest the way mature MDX docs systems and high-quality repository docs sites do: navigation first, journey order, then one-concern route pages.",
    "",
    "### Adaptive journey order",
    "",
    "Use this progression when the repository supports it: **Orient → Use → Understand → Deepen**.",
    "",
    "1. **Orient** — what the project exposes and the shortest source-backed successful path.",
    "2. **Use** — primary workflows, commands, APIs, and subsystem behaviors.",
    "3. **Understand** — architecture, lifecycle, ownership, and cross-cutting constraints needed to predict behavior.",
    "4. **Deepen** — troubleshooting, operations, contribution, and reference material.",
    "",
    "Small repositories may collapse these stages into one or two themed navigation groups. Larger repositories may split Use and Understand into public capability themes. Never force empty stages or reverse the result into a package inventory.",
    "",
    "- Start with the technical surface: what is exposed, how it is invoked, what inputs/configuration it accepts, and what outputs or side effects it produces.",
    "- Add overview, installation, and quickstart pages only when the repo exposes enough setup and first-use evidence to make them concrete.",
    "- The Overview page is an orientation: describe what the project exposes and the shortest source-backed successful path before pointing to deeper planned routes. Do not paste the README.",
    "- Add concept pages only for repo-specific models, protocols, lifecycle states, or constraints that users must know before using APIs, commands, configuration, or components. Do not teach generic programming concepts.",
    "- Add guide pages for technical operations a real user would perform: configure a provider, generate an artifact, embed a component, deploy, debug, migrate, extend, or contribute.",
    "- Add one-concern subsystem pages for major runtime surfaces (one loop, one protocol, one subsystem behavior) instead of one page per package folder.",
    "- Add reference pages when the repository exposes a schema: CLI flags, config keys, environment variables, API routes, SDK methods, component props, events, or return values.",
    "- Add examples pages only when examples are concrete and copy-pasteable from repo-backed workflows. Do not create a generic examples bucket with no concrete code path.",
    "- Add troubleshooting, migration, changelog, or contributing pages only when source files, scripts, tests, or docs prove those workflows exist.",
    "",
    "### Docs archetypes",
    "",
    "- **Overview / Introduction**: exposed surface, primary entry points, runtime assumptions, and the first useful source-backed path before deeper planned pages.",
    "- **Installation / Quickstart**: prerequisites, install command, first run, expected success signal, and one recovery note.",
    "- **Architecture / core flow**: layered system shape or one end-to-end journey that later pages depend on.",
    "- **Concept**: one repo-specific model, protocol, state machine, or boundary. Keep it factual and compact.",
    "- **Guide / subsystem**: prerequisites, steps or internal loop, verification, and troubleshooting for one technical operation or subsystem.",
    "- **Reference**: signatures, options, fields, defaults, required values, examples, error cases, and constraints.",
    "- **Examples / Recipes**: complete small workflows with realistic values and expected output.",
    "- **Operations / Maintenance**: build, test, release, deploy, observe, migrate, or contribute.",
    "",
    "### Title and grouping rules (cleanliness)",
    "",
    "- Each page title is one reader job: a capability, flow, protocol, command surface, or operational concern.",
    "- Prefer titles like `Agent run loop`, `Configuration merge order`, `One request end-to-end` over `src/runtime package`, `Module inventory`, or `Source tree`.",
    "- Navigation group titles are themes (Get started, Core architecture, Agent runtime, Tools, Cross-cutting, Reference), not bare paths (`src/`, `apps/desktop`, `packages/foo`).",
    "- Prefer fewer deeper routes over many shallow folder summaries.",
    "",
    "### Anti-patterns",
    "",
    "- Bad: `Architecture`, `Maintainer appendix`, `Closing summary`, `Learn the basics`, or `Source evidence` as automatic pages.",
    "- Bad: pages named after directories unless the directory name is already the public concept.",
    "- Bad: one page per file, one page per class, one page per package, or a TOC that is mostly inventory.",
    "- Bad: flat ungrouped page dumps when the repo has multiple capability clusters.",
    "- Bad: tutorial filler, analogies, broad teaching prose, or generic explanations not grounded in this repository.",
  ].join("\n");
}

function docsSectionPatterns(): string {
  return [
    "## Typical docs navigation groups (pick what fits this repo — do NOT force every one)",
    "",
    "Order groups as a reader journey when you include several of them:",
    "",
    "- **Get started** — overview orientation, the first useful source-backed path, installation, and quickstart when supported.",
    "- **Core architecture** — system layers, one end-to-end turn/request/pipeline, session or lifecycle when that unlocks later pages.",
    "- **Subsystem themes** — named capability clusters reflected by the repo (for example UI/rendering, agent runtime, tools/workspace, integrations). Use public concept names, not directory labels.",
    "- **Concepts** — only repo-specific models, terms, protocols, states, and boundaries users need before using the project.",
    "- **Guides** — technical workflows with prerequisites, steps, verification, and troubleshooting.",
    "- **Cross-cutting** — configuration, telemetry, security/sandbox, memory, multi-instance coordination when source-backed.",
    "- **Reference** — API routes, SDK methods, CLI commands, config keys, environment variables, component props, events, return values, schemas, defaults, glossaries.",
    "- **Examples** — complete, realistic recipes backed by example files, tests, or documented workflows.",
    "- **Troubleshooting** — errors, known failure modes, debugging probes, and recovery steps that source evidence supports.",
    "- **Operations / Contributing** — build, test, release, deploy, migrate, observe, or contribute, only when the repo exposes those workflows.",
    "",
    "Ignore groups that do not fit. Do not create a page just to make a group feel complete. Never replace themed groups with a package or folder inventory.",
  ].join("\n");
}

function wikiSectionPatterns(): string {
  return [
    "## Typical section patterns (pick what fits this repo — do NOT force every one)",
    "",
    "- **Getting Started & Installation** — setup, install, first run, CLI usage",
    "- **Core Concepts & Design Philosophy** — the \"why\" and the mental model",
    "- **Architecture & Core Components** — one page per major subsystem/file",
    "- **Public API Reference** — one page per module or logical API group",
    "- **Data Flow & Pipeline** — one page per stage (ingest -> transform -> output)",
    "- **Features / Capabilities** — one page per feature",
    "- **Integration & Extensibility** — adapters, plugins, hooks, providers",
    "- **Skills / Examples / Recipes Library** — one page per category",
    "- **Build, Deploy & Operations** — build, Docker, CI, monitoring",
    "- **Testing & Quality** — only if the test story is non-trivial",
    "",
    "Ignore patterns that don't fit (e.g. no \"Deployment\" for a library; no \"Frontend\" for a CLI).",
  ].join("\n");
}

function wikiDecomposeGuidance(): string {
  return [
    "## How to decompose (this is the important part)",
    "",
    "Do NOT create one giant page per subsystem. **SPLIT** by concern:",
    "",
    "- A subsystem with multiple distinct files or responsibilities -> one **section**, and one **page per file / concern / responsibility**.",
    "- A multi-step data pipeline -> one page per stage.",
    "- A plugin / skill / adapter system -> one section \"X Library\" with one sub-page *per category or adapter*.",
    "- An API surface -> group endpoints into logical pages (e.g. \"Navigation API\", \"Input API\"), one page per group — not one page for the whole API.",
    "- Domain-specific patterns (e.g. \"how to scrape LinkedIn\") -> one section with one sub-page per pattern or category.",
    "",
    "### Concrete examples of good splitting",
    "",
    "- Bad: `\"Interaction Skills\"` — one page containing everything.",
    "- Good: section `\"Interaction Skills\"` -> sub-pages `\"Input & Navigation\"`, `\"Frames, Shadow DOM & Multi-Tab\"`, `\"Dialogs, Downloads & Network\"`.",
    "",
    "- Bad: `\"Architecture\"` — one page for the whole system.",
    "- Good: section `\"Architecture & Core Components\"` -> sub-pages `\"Daemon & CDP Connection Layer\"`, `\"run.py & admin.py — Execution and Lifecycle Management\"`, `\"helpers.py — Browser Automation API\"`, `\"Cloud Browser & Profile Sync\"`.",
    "",
    "- Bad: `\"Domain Skills\"` — one page listing everything.",
    "- Good: section `\"Domain Skills Library\"` -> sub-pages `\"Public Data APIs — Science, Finance & Geography\"`, `\"E-Commerce & Marketplace Platforms\"`, `\"Developer & Professional Platforms\"`, `\"Media, Entertainment & Social Platforms\"`, ...",
  ].join("\n");
}

function docsXmlExample(pageCountRecap: string): string {
  return `<ANSWER>
<wiki_structure>
  <title>{Concise docs title, e.g. "Browser Harness Documentation"}</title>
  <description>{1-2 sentences: what technical surface the project exposes and who needs the reference}</description>
  <sections>
    <section id="section-get-started">
      <title>Get started</title>
      <pages>
        <page_ref>page-overview</page_ref>
        <page_ref>page-installation</page_ref>
        <page_ref>page-quickstart</page_ref>
      </pages>
      <subsections></subsections>
    </section>
    <section id="section-core-architecture">
      <title>Core architecture</title>
      <pages>
        <page_ref>page-system-layers</page_ref>
        <page_ref>page-one-request-end-to-end</page_ref>
      </pages>
      <subsections></subsections>
    </section>
    <section id="section-runtime">
      <title>Runtime</title>
      <pages>
        <page_ref>page-configure-runtime</page_ref>
        <page_ref>page-generate-docs</page_ref>
      </pages>
      <subsections></subsections>
    </section>
    <section id="section-reference">
      <title>Reference</title>
      <pages>
        <page_ref>page-configuration-reference</page_ref>
        <page_ref>page-cli-reference</page_ref>
      </pages>
      <subsections></subsections>
    </section>
  </sections>
  <pages>
    <page id="page-overview">
      <title>Overview</title>
      <description>What the project exposes, the shortest source-backed successful path, and which planned pages deepen that first path.</description>
      <relevant_files>
        <file_path>README.md</file_path>
        <file_path>package.json</file_path>
        <file_path>src/index.ts</file_path>
      </relevant_files>
      <related_pages>
        <related>page-installation</related>
        <related>page-quickstart</related>
      </related_pages>
      <parent_section>section-get-started</parent_section>
    </page>
    <page id="page-configuration-reference">
      <title>Configuration reference</title>
      <description>Supported configuration keys, defaults, provider boundaries, and validation rules.</description>
      <relevant_files>
        <file_path>src/config.ts</file_path>
        <file_path>README.md</file_path>
      </relevant_files>
      <related_pages>
        <related>page-configure-runtime</related>
      </related_pages>
      <parent_section>section-reference</parent_section>
    </page>
    <!-- ... more docs route pages until the page-count rule is satisfied: ${pageCountRecap} ... -->
  </pages>
</wiki_structure>
</ANSWER>`;
}

function wikiXmlExample(bookends: ReturnType<typeof wikiBookendGuidance>, pageCountRecap: string): string {
  return `<ANSWER>
<wiki_structure>
  <title>{A concise wiki title, e.g. "Browser Harness Technical Wiki"}</title>
  <description>{1-2 sentences: what this repo is; for Design Ideas, answer what is special and worth studying}</description>
  <sections>
    <section id="section-getting-started">
      <title>Getting Started &amp; Installation</title>
      <pages>
        <page_ref>page-overview</page_ref>
        <page_ref>page-install-guide</page_ref>
      </pages>
      <subsections></subsections>
    </section>
    <section id="section-architecture">
      <title>Architecture &amp; Core Components</title>
      <pages>
        <page_ref>page-daemon</page_ref>
        <page_ref>page-run-and-admin</page_ref>
        <page_ref>page-helpers</page_ref>
        <page_ref>page-cloud-browser</page_ref>
      </pages>
      <subsections></subsections>
    </section>
    <!-- ... more sections ... -->
  </sections>
  <pages>
    <page id="page-overview">
      <title>${bookends.openingTitle}</title>
      <description>${bookends.openingDescription}</description>
      <relevant_files>
        <file_path>README.md</file_path>
        <file_path>pyproject.toml</file_path>
        <file_path>run.py</file_path>
      </relevant_files>
      <related_pages>
        <related>page-install-guide</related>
      </related_pages>
      <parent_section>section-getting-started</parent_section>
    </page>
    <page id="page-daemon">
      <title>Daemon &amp; CDP Connection Layer</title>
      <description>The persistent WebSocket daemon that holds the CDP connection</description>
      <relevant_files>
        <file_path>daemon.py</file_path>
        <file_path>admin.py</file_path>
      </relevant_files>
      <related_pages>
        <related>page-run-and-admin</related>
        <related>page-cloud-browser</related>
      </related_pages>
      <parent_section>section-architecture</parent_section>
    </page>
    <!-- ... more pages until the page-count rule is satisfied: ${pageCountRecap} ... -->
  </pages>
</wiki_structure>
</ANSWER>`;
}

function wikiBookendGuidance(style: WikiStyle, pageCount: number): {
  openingTitle: string;
  openingDescription: string;
  closingRule: string;
} {
  const closingPrefix = pageCount > 1
    ? "- The final page should be a real closing page, not an open-ended leftover topic. "
    : "";
  switch (style) {
    case "first-30":
      return {
        openingTitle: "Start Here",
        openingDescription: "What this repo is, the fastest read order, the entry points to open first, and the vocabulary a new reader needs.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with what the reader should understand or try after the first 30 minutes.`
          : "",
      };
    case "eli5":
      return {
        openingTitle: "Explain It Simply",
        openingDescription: "What this repo does in plain language, the simplest useful analogy, and the few ideas the reader should remember.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with a short plain-English recap: the core idea, the one analogy to keep, and what to read next.`
          : "",
      };
    case "mental-model":
      return {
        openingTitle: "The Mental Model",
        openingDescription: "The simplest useful model of the system, its main flows, boundaries, invariants, and what changes the reader's predictions.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with a synthesis of the core invariants, failure modes, and safe-change rules.`
          : "",
      };
    case "socratic-exploration":
      return {
        openingTitle: "The First Question",
        openingDescription: "The first-principles question that unlocks the repo, why the simple version is insufficient, and which files answer the first reframe.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the final reframe: what the reader can now reason about that was not obvious at the start.`
          : "",
      };
    case "feature-scout":
      return {
        openingTitle: "Feature Scout Brief",
        openingDescription: "The product surface, the features worth exploring first, and why those features deserve attention beyond the README.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the strongest feature opportunities and what to demo, copy, or productize next.`
          : "",
      };
    case "worth-stealing":
      return {
        openingTitle: "What Is Worth Stealing",
        openingDescription: "The strongest reusable moves in the repo, why they are elegant, and what a naive clone would miss.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the transfer recipe: what to reuse, what not to copy, and prerequisites for porting it.`
          : "",
      };
    case "hidden-quirks":
      return {
        openingTitle: "Hidden Quirks Map",
        openingDescription: "The non-obvious implementation details, constraints, tests, scripts, adapters, and edge cases worth studying first.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the quirks that most change how a maintainer should read or modify the repo.`
          : "",
      };
    case "pattern-discovery":
      return {
        openingTitle: "Pattern Discovery Map",
        openingDescription: "The architecture and product patterns that appear across files, subsystems, or repositories, including patterns the reader may not know to ask for.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with named patterns, where they repeat, and when they are portable.`
          : "",
      };
    case "repo-comparison":
      return {
        openingTitle: "Comparison Frame",
        openingDescription: "The comparison lens, what is being compared, and the criteria that make the differences useful.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the comparison verdict: strongest differences, portable ideas, and tradeoffs.`
          : "",
      };
    case "debugging-atlas":
      return {
        openingTitle: "Debugging Map",
        openingDescription: "The failure surfaces, symptoms, probes, logs, and state transitions a maintainer should understand first.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with a root-cause checklist and regression probes.`
          : "",
      };
    case "tech-reader":
      return {
        openingTitle: "Why This Repo Matters",
        openingDescription: "The accessible hook, the mechanism underneath it, and what technical readers should notice before diving into details.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with the builder takeaway: what is surprising, what is hard, and what is worth watching.`
          : "",
      };
    case "documentation":
      return {
        openingTitle: "Overview",
        openingDescription: "What the project exposes, the shortest source-backed successful path, and which deeper planned docs routes follow that orientation.",
        closingRule: "",
      };
    case "custom":
      return {
        openingTitle: "Opening Brief",
        openingDescription: "The opening page should follow the custom format brief while orienting the reader to the repo and the rest of the wiki.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close according to the user's custom brief while giving the wiki a deliberate finish.`
          : "",
      };
    case "technical":
      return {
        openingTitle: "Technical Orientation",
        openingDescription: "What the repo is, its core entry points, main architecture, and how the rest of the developer reference is organized.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with operational boundaries, extension points, and what to inspect next.`
          : "",
      };
    case "basic":
    default:
      return {
        openingTitle: "Repository Guide",
        openingDescription: "What the repo is, who it is for, the core entry points, and how the rest of the wiki is organized.",
        closingRule: closingPrefix
          ? `${closingPrefix}For this format, close with a concise synthesis of the repo and the best next pages or files to read.`
          : "",
      };
  }
}

function wikiBeyondReadmeGuidance(style: WikiStyle): string {
  if (style === "basic" || style === "technical" || style === "custom") return "";
  return [
    "## Beyond README Requirement",
    "The README may orient the table of contents, but it must not dominate this format.",
    "Actively surface source-backed material that is not already obvious from the README: code paths, tests, config, examples, prompts, adapters, generated assets, scripts, hidden constraints, and implementation boundaries.",
    "A page is weak if it merely restates README claims. Prefer non-README evidence unless the README is the only source for a setup or product-positioning fact.",
  ].join("\n");
}

function wikiStyleGuidance(style: WikiStyle, customPrompt = ""): { label: string; opening: string; structure: string } {
  switch (style) {
    case "basic":
      return {
        label: "Basic wiki",
        opening: "You are an expert technical writer designing a balanced repository wiki",
        structure: [
          "Use the original repository-wiki format: a balanced DeepWiki-style repository guide.",
          "Let the repo shape decide the table of contents instead of forcing an architecture, workflow, or techcrunch journal frame.",
        ].join("\n"),
      };
    case "first-30":
      return {
        label: "First 30 Minutes wiki",
        opening: "You are an expert onboarding writer designing a first-30-minutes repository wiki",
        structure: [
          "Design the table of contents for someone trying to become oriented quickly.",
          "Prioritize what the repo is, where to start, core entry points, read order, glossary terms, setup signals, and what matters first.",
          "Use page titles that feel like a guided path from first glance to useful context.",
        ].join("\n"),
      };
    case "eli5":
      return {
        label: "Explain Like I'm 5 wiki",
        opening: "You are an expert plain-language technical explainer designing an Explain Like I'm 5 repository wiki",
        structure: [
          "Design the table of contents for a smart newcomer who wants the simplest useful explanation before the technical deep dive.",
          "Prefer pages that explain what the repo does, who/what the main actors are, what moves where, why each part exists, and what the reader should remember.",
          "Use analogies sparingly and carefully. Every analogy must map back to source evidence and must not erase important technical boundaries or caveats.",
        ].join("\n"),
      };
    case "mental-model":
      return {
        label: "Mental Model wiki",
        opening: "You are an expert systems explainer designing a mental-model repository wiki",
        structure: [
          "Design the table of contents around how the system works in the reader's head.",
          "Prefer flows, invariants, boundaries, state ownership, failure modes, dependency direction, and safe-change reasoning.",
          "Each page should help the reader predict behavior without constantly reopening the code.",
        ].join("\n"),
      };
    case "socratic-exploration":
      return {
        label: "Socratic Exploration wiki",
        opening: "You are an expert Socratic technical explainer designing a first-principles repository wiki",
        structure: [
          "Design the table of contents as first-principles exploration: what problem exists, what is the simplest version, where complexity becomes necessary, and what questions reveal the system.",
          "Prefer pages framed as sharp questions or reframes, but make sure each page still has concrete source files and a clear answerable topic.",
          "Avoid performative question lists. Every page should use Socratic questioning to expose evidence, assumptions, constraints, and tradeoffs.",
        ].join("\n"),
      };
    case "feature-scout":
      return {
        label: "Feature Scout wiki",
        opening: "You are an expert product-minded engineer designing a feature-scout repository wiki",
        structure: [
          "Design the table of contents around features worth exploring, demoing, copying, or productizing.",
          "Prefer pages for user-visible capabilities, agent workflows, CLI commands, UI affordances, hidden power-user moves, automation hooks, and product mechanics.",
          "Each page should answer why the feature is interesting, where it is implemented, and what a builder should inspect next.",
        ].join("\n"),
      };
    case "worth-stealing":
      return {
        label: "Worth Stealing wiki",
        opening: "You are an expert product and architecture critic designing a wiki about what is worth stealing from this repo",
        structure: [
          "Before making the table of contents, identify the repo's strongest reusable moves: elegant designs, best practices, architecture bets, UI/component decisions, infra choices, workflow mechanics, or product constraints.",
          "Use the wiki-level <description> as a sharp thesis that answers: what is worth stealing here, what would a naive clone miss, and why is it worth porting?",
          "Build pages around portable lessons rather than modules. Each page should teach what the move is, why it works, where it is implemented, when not to copy it, and what must change to reuse it elsewhere.",
          "Do not praise ordinary implementation detail. Only allocate pages to ideas that teach durable product or engineering judgment.",
        ].join("\n"),
      };
    case "hidden-quirks":
      return {
        label: "Hidden Quirks wiki",
        opening: "You are an expert code archaeologist designing a wiki of hidden quirks worth studying",
        structure: [
          "Design the table of contents around non-obvious implementation details that are not obvious from the README.",
          "Prefer unusual constraints, localized hacks, safety rails, edge-case handling, tiny high-leverage decisions, implicit contracts, generated files, tests, scripts, config, prompts, and adapter behavior.",
          "Each page should answer: what would a casual reader miss, what evidence reveals it, and why does it matter?",
        ].join("\n"),
      };
    case "pattern-discovery":
      return {
        label: "Pattern Discovery wiki",
        opening: "You are an expert cross-repository pattern scout designing a pattern-discovery wiki",
        structure: [
          "Design the table of contents around unknown architecture or product patterns the reader may not know to ask for.",
          "Prefer repeated mechanisms, runtime abstractions, provider boundaries, routing choices, adapter shapes, state machines, workflows, and product design moves.",
          "When multiple repositories are provided, compare patterns across repositories. With one repository, compare patterns across subsystems and files.",
        ].join("\n"),
      };
    case "repo-comparison":
      return {
        label: "Repo Comparison wiki",
        opening: "You are an expert comparative technical analyst designing a repository-comparison wiki",
        structure: [
          "Design the table of contents around comparison: what each repository or subsystem does better, where they differ, and which ideas are portable.",
          "For 2+ repos, dedicate pages to meaningful cross-repo contrasts rather than isolated summaries.",
          "For one repo, compare internal approaches that solve similar problems differently: adapters, runtimes, routes, UI flows, persistence paths, tests, or configuration surfaces.",
        ].join("\n"),
      };
    case "debugging-atlas":
      return {
        label: "Debugging Atlas wiki",
        opening: "You are an expert production debugger designing a debugging-atlas repository wiki",
        structure: [
          "Design the table of contents around how the system fails and how a maintainer should investigate.",
          "Prefer symptoms, probes, logs, state transitions, error boundaries, root-cause paths, observability hooks, recovery flows, and regression checks.",
          "Each page should make the reader better at tracing a real failure, not just name the component.",
        ].join("\n"),
      };
    case "tech-reader":
      return {
        label: "Tech Reader Brief wiki",
        opening: "You are an expert technical journalist designing an HN/TechCrunch-style source-grounded repository breakdown",
        structure: [
          "Design the table of contents for curious technical readers who want an easy-to-digest but substantive breakdown.",
          "Prefer pages with a clear hook, why it matters, the mechanism, tradeoffs, surprising details, and what builders should notice.",
          "Keep the framing article-like and accessible, but do not invent market claims, hype, or unsupported product impact.",
        ].join("\n"),
      };
    case "documentation":
      return {
        label: "Documentation site",
        opening: "You are an expert technical documentation architect designing a source-grounded repository documentation set",
        structure: [
          "Design the table of contents like a terse technical MDX documentation site with journey-ordered, themed navigation — not a tutorial, code inventory, marketing page, package listing, or DeepWiki chapter list.",
          "First infer a docs manifest in your head: project name, root description, adaptive themed navigation groups, one-concern page paths, page archetypes, overview orientation plus the first useful path, and the exact number of route pages this repository deserves. The final XML still uses the Grok-Wiki storage schema, but sections are docs navigation groups and pages are docs routes.",
          "Use the same durable pattern mature docs systems use: a root manifest like Mintlify `docs.json` or Fumadocs `meta.json`, then frontmatter-bearing MDX pages. Do not output those files directly; encode the manifest into the XML and let the page agents write the MDX pages.",
          "A strong medium-size technical docs set often begins with Overview orientation and the first useful path, then follows with source-backed workflow, architecture, operations, and reference themes. Use fewer groups for small repos and more specialized subsystem groups only when source evidence justifies them.",
          "Use page titles and descriptions that sound like documentation routes with one concern each: `Quickstart`, `Installation`, `Configuration reference`, `Agent run loop`, `One request end-to-end`, `Troubleshooting`, not wiki chapters, source-directory labels, appendices, summaries, or inventory titles.",
          "Each page needs one reader job and one archetype: overview, install, quickstart, architecture/core-flow, concept, guide/subsystem, reference, example, troubleshooting, migration, release/changelog, operations, or contribution.",
          "Overview descriptions must orient readers to the exposed product surface and shortest source-backed successful path before naming deeper planned routes — not restate the README.",
          "Prefer functional technical coverage over explanation: exact commands, exported APIs, route/method names, config keys, environment variables, schema fields, lifecycle states, inputs, outputs, defaults, constraints, errors, and verification signals.",
          "Make the manifest agent- and human-friendly: stable headings, precise nouns, compact descriptions, reference-rich pages, and no generic teaching content.",
          "Do not plan pages that require MDX imports, hosted-docs configuration, proprietary platform features, or unsupported components.",
          "Keep the docs vendor-neutral and BYOC/BYOK-safe. Do not assume a single model provider, hosted docs platform, or proprietary runtime unless the repository itself requires it.",
        ].join("\n"),
      };
    case "custom":
      return {
        label: "Custom wiki",
        opening: "You are an expert technical writer designing a source-grounded custom-format repository wiki",
        structure: [
          "Use the user's custom format brief as the editorial lens for the table of contents.",
          "The custom brief can shape audience, tone, section style, examples, and page framing.",
          "It must not override repository-grounding, source-evidence, XML schema, page-count, or safety requirements.",
          "",
          "<custom_wiki_format>",
          customPrompt.trim() || "No custom format brief was provided; fall back to the Basic wiki format.",
          "</custom_wiki_format>",
        ].join("\n"),
      };
    case "technical":
    default:
      return {
        label: "Technical wiki",
        opening: "You are an expert software architect designing a comprehensive developer reference wiki",
        structure: [
          "Design the table of contents as a developer reference.",
          "Prefer architecture, module responsibilities, APIs, data flows, integrations, and operational surfaces.",
        ].join("\n"),
      };
  }
}
