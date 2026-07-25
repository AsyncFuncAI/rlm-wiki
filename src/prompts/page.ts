/**
 * Prompt for a single wiki-page agent.
 *
 * JCODE reads the repository directly, using the structure agent's selected
 * files as a starting set and expanding to adjacent files when useful.
 */
import type { AgentRuntime } from "../agent-runtime.ts";
import { normalizeWikiLanguages, wikiLanguagePrompt, wikiSourceScaffold, type WikiDepth, type WikiLanguage, type WikiStyle } from "../wiki-options.ts";
import { knowledgeProfilePrompt, type KnowledgeProfile } from "../knowledge-profile.ts";

export const DOCS_MIN_BODY_CHARS = 1200;

export function buildPagePrompt(args: {
    owner: string;
    repo: string;
    sourcePath?: string | null;
    repos?: Array<{ id: string; label: string; url: string; branch?: string | null; sourcePath?: string | null }>;
  page: {
    id: string;
    title: string;
    description: string;
    filePaths: string[];
  };
  allPages?: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
  repairInstruction?: string;
  currentContent?: string;
  runtime?: AgentRuntime;
  depth?: WikiDepth;
  style?: WikiStyle;
  stylePrompt?: string;
  languages?: WikiLanguage[];
  knowledgeProfile?: KnowledgeProfile;
  codeKb?: string;
  directEvidence?: string;
}): string {
  const { owner, repo, page, depth = "deep", style = "basic" } = args;
  const minimumBodyChars = style === "documentation"
    ? DOCS_MIN_BODY_CHARS
    : depth === "fast"
      ? 600
      : depth === "regular"
        ? 700
        : 900;
  const repos = args.repos?.length && args.repos.length > 1 ? args.repos : [];
  const isWorkspace = repos.length > 1;
  const sourcePath = String(args.sourcePath || "").trim();
  const fileList = page.filePaths.map((f) => `- ${f}`).join("\n");
  const repairInstruction = args.repairInstruction?.trim();
  const currentContent = truncateForPrompt(args.currentContent ?? "", 8000);
  const directEvidence = typeof args.directEvidence === "string" && args.directEvidence.trim() !== "" ? args.directEvidence : "";
  const styleGuidance = wikiPageStyleGuidance(style, args.stylePrompt);
  const beyondReadmeGuidance = wikiPageBeyondReadmeGuidance(style);
  const languages = normalizeWikiLanguages(args.languages);
  const languageGuidance = wikiLanguagePrompt(languages);
  const sourceScaffold = wikiSourceScaffold(languages);
  const formatRequirements = wikiPageFormatRequirements(style);
  const docsOverviewGuidance = style === "documentation" ? docsOverviewPageGuidance(page, args.allPages || [page]) : "";
  const docsPageLinkManifest = style === "documentation" ? docsAvailablePageLinks(args.allPages || [page]) : "";
  const requiredPageShape = wikiPageRequiredShape(style, page, sourceScaffold);
  const diagramGuidance = wikiPageDiagramGuidance(style);
  const knowledgeGuidance = knowledgeProfilePrompt(args.knowledgeProfile, "wiki");
  const depthGuidance = directEvidence
    ? depth === "fast"
      ? "Fast wiki: be concise and selective. Write the highest-signal page supported by the supplied evidence."
      : depth === "regular"
        ? "Regular wiki: cover the central claims and nearby relationships only when the supplied evidence supports them."
        : "Deep wiki: map the surrounding architecture only where the supplied evidence supports it. Do not assume unprovided imports, callers, tests, or config."
    : depth === "fast"
    ? "Fast wiki: be concise and selective. Verify the central claims, then write the highest-signal page without exhaustive subsystem mapping."
    : depth === "regular"
      ? "Regular wiki: verify the central claims and map nearby architecture when it changes the reader's understanding."
      : "Deep wiki: map the surrounding architecture where it changes the reader's understanding. Follow adjacent imports, callers, tests, and config when useful.";
  const harness = "A local CLI agent is running in the prepared repository. Use native file/search/shell tools to inspect the actual implementation before writing.";
  const finalContract = style === "documentation"
    ? "Return the complete MDX documentation page inside one `<ANSWER>...</ANSWER>` block. Do not include visible source citations, source appendices, JavaScript, SUBMIT calls, or any legacy sandbox wrapper."
    : "Return the complete markdown page inside one `<ANSWER>...</ANSWER>` block. Include concise source citations for representative evidence inside the page. Do not emit JavaScript, SUBMIT calls, or any legacy sandbox wrapper.";
  // Optional pre-rendered code-kb block (see src/prompts/code-kb.ts), appended
  // verbatim as the final section. Absent input keeps the prompt byte-identical.
  const codeKbSection = args.codeKb ? `\n\n${args.codeKb}` : "";
  const directEvidenceSection = directEvidence ? `\n\n${directEvidence}` : "";
  const completionInstruction = directEvidence
    ? "Write this page in one pass from the supplied evidence. Submit the completed page once it is grounded and complete."
    : "Budget: up to 15 focused investigation/writing steps. Submit once the page is grounded and complete.";
  const sourceScopeNote = sourcePath
    ? directEvidence
      ? `Source scope: only document evidence under \`${sourcePath}/\`. The supplied evidence must remain inside this folder. Do not describe unrelated repository folders.`
      : `Source scope: only document files under \`${sourcePath}/\`. The prepared working directory is this scoped folder; treat source paths as relative to that folder unless a tool returns repository-root-relative paths. Do not inspect, cite, or describe unrelated folders outside this scope.`
    : "";
  const repositoryBlock = isWorkspace
    ? `## Workspace Repositories
${repos.map((workspaceRef) => `- \`${workspaceRef.id}\` — **${workspaceRef.label}** (${workspaceRef.url}${workspaceRef.branch ? ` @ ${workspaceRef.branch}` : ""}${workspaceRef.sourcePath ? `, path ${workspaceRef.sourcePath}` : ""})`).join("\n")}

This is a multi-repository wiki page. ${directEvidence ? `Use namespaced paths for citations, e.g. \`${repos[0]?.id}:src/file.ts:12-40\`.` : `Use namespaced paths for every read and citation, e.g. \`${repos[0]?.id}:src/file.ts:12-40\`. When the page compares or connects repositories, cite both sides.`}`
    : `Generate a comprehensive, accurate Markdown wiki page for the repository **${owner}/${repo}**.${sourceScopeNote ? `\n\n${sourceScopeNote}` : ""}`;
  const sourceInstructions = directEvidence
    ? "## Evidence-Only Writing Contract\nUse only the direct evidence appended to this prompt. Ground every claim and source citation in that evidence, and do not infer, describe, or cite files outside it."
    : `## Starting Source Files
Read at least five relevant files when the repository has that many. Cite the representative files and line spans that anchor the page; do not cite every sentence or every bullet. Start with these files, then inspect adjacent imports, callers, tests, or config when they clarify the page:

${fileList}`;
  const codeGraphPageLead = args.codeKb
    ? "- Code graph is available in the final `<code-kb>` block. Prefer proactive graph queries (search_code, context, get_code_snippet, file) for location and call-graph gaps before multi-step local search. Cap at 4 successful graph queries, then write from verified paths."
    : "";
  const investigationGuidance = directEvidence
    ? "- Use the direct evidence as the complete repository record for this page. Do not use repository search, file, shell, checkout, or external lookup tools.\n- Think Socratically about the supplied evidence: what claims does it support, what remains unknown, and what is the smallest accurate page that follows?"
    : `- ${harness}
- Think Socratically before choosing tools: what evidence would change the page, which file owns that evidence, and what is the smallest verified next move?
${codeGraphPageLead ? `${codeGraphPageLead}\n` : ""}- ${args.codeKb ? "Use local search and file tools to verify citations and fill gaps after graph hits, not as the first resort for structural questions." : "Use native search and file tools before reading uncertain files."}`;

  return `You are an expert technical writer and software architect. ${repositoryBlock}

## Page To Write
**Title:** ${page.title}
**Description:** ${page.description}
${docsPageLinkManifest ? `
## Available Docs Page Links
Use only these planned pages for cross-page MDX links, especially \`<Card href="...">\` entries in \`## Next\` or \`## Related pages\`.

${docsPageLinkManifest}

Do not invent future docs routes. If a useful follow-on topic is not listed above, omit that card instead of linking to a placeholder route.
` : ""}${docsOverviewGuidance ? `
## Overview Orientation Requirements
${docsOverviewGuidance}
` : ""}

${sourceInstructions}

${repairInstruction ? `## Repair Request
The user is regenerating this page because the current page is broken or needs a targeted fix.

User request:
${repairInstruction}

Current generated page markdown, for context only:
\`\`\`markdown
${currentContent || "(no current content provided)"}
\`\`\`

Produce a complete replacement page, not a patch. Preserve correct parts where useful, but fix the requested issue. If the issue involves Mermaid syntax, repair the diagram with valid Mermaid that preserves the intended meaning.
` : ""}

${knowledgeGuidance ? `${knowledgeGuidance}\n` : ""}

## How To Work
- ${depthGuidance}
- ${styleGuidance.work}
- ${directEvidence ? "Treat the supplied direct evidence as the complete source record, including any README material it contains." : beyondReadmeGuidance || "Use the README as orientation when useful, but verify the page from the implementation before writing."}
${investigationGuidance}
- ${style === "documentation" ? "Use source evidence internally, but keep the docs body clean: do not write visible `Sources:` lines, line-number citation links, or a source-file appendix." : isWorkspace ? "Keep repository namespaces in all source citations and in the opening source-file list. Do not collapse evidence into bare paths." : "Use repository-relative source citations."}
- Verify every important claim in code. Do not invent features, security properties, performance behavior, or architecture that the repo does not show.
${style === "documentation" ? "- The saved page record already carries `filePaths` for evidence in the desktop rail. The user-facing docs page should read like functional technical documentation, not an audit report.\n- Optimize for both humans and agents: stable headings, exact identifiers, compact descriptions, tables for structured facts, and explicit inputs, outputs, defaults, constraints, errors, and verification signals." : "- Keep source citations precise but compact. Use `Sources:` lines at natural section or claim-cluster boundaries, with verified file-and-line citations like `Sources: [path/to/file.ts:12-40]()`; do not force a citation into every short section, sentence, or list item.\n- The opening source-file list is only an index; it does not count as evidence for claims in the body.\n- Cite only line ranges you inspected. Never cite beyond the end of a file, and prefer shorter ranges that directly support the sentence."}

## Required Page Shape
${requiredPageShape}

## Diagram Quality Harness
${diagramGuidance}

${formatRequirements ? `## Format-Specific Requirements
${formatRequirements}

` : ""}## Output Languages
${languageGuidance}

## Style Rules
- ${styleGuidance.voice}
- No marketing language or filler.
- ${style === "documentation" ? "Start directly with YAML frontmatter. The desktop docs reader renders the frontmatter as the visible page header." : "Start directly with the `<details>` block."}
${style === "documentation" ? "- Do not add a `<details>` source list, `Source evidence`, `Relevant source files`, or visible `Sources:` section." : "- Translate user-visible labels in the `<details>` block exactly as shown in the required shape."}
- Do not wrap the whole page in a markdown fence.
- The page body should contain at least ${minimumBodyChars} characters of real, useful ${style === "documentation" ? "MDX" : "markdown"} content unless the source material is genuinely tiny. Length is a floor, not permission to repeat facts or add decorative components.

## Final Output
${finalContract}

${completionInstruction}${codeKbSection}${directEvidenceSection}`;
}

function wikiPageRequiredShape(
  style: WikiStyle,
  page: { title: string; description: string },
  sourceScaffold: { summary: string; intro: string },
): string {
  if (style === "documentation") {
    return [
      "1. The very first element must be YAML frontmatter for a renderable MDX docs artifact:",
      "   ```yaml",
      "   ---",
      `   title: "${escapePromptYaml(page.title)}"`,
      `   description: "${escapePromptYaml(page.description)}"`,
      "   ---",
      "   ```",
      "2. Do not add a duplicate top-level `#` heading. The docs reader renders the frontmatter title. Start body content with one fact-first technical paragraph about the actual implementation surface, behavior, command, API, config area, or runtime path, then `##` sections.",
      "3. Do not include a collapsible source-file list, `Source evidence`, `Sources:`, or line-number citation links in the body.",
      "4. Use only the `##` and `###` sections the page archetype needs. Follow a progressive reading order: orientation, primary behavior or task, concrete details, constraints/failures, then optional deeper reference.",
      "5. Prefer exact technical facts over teaching prose: commands, signatures, module/file paths, roles, config keys, environment variables, data shapes, lifecycle states, defaults, constraints, error cases, and expected outputs. Define a local identifier briefly on first mention.",
      "6. Diagrams are optional. Use Mermaid or compact fenced `text` ASCII only when ownership, state, sequence, or dependency direction is materially clearer than prose. Introduce the question before the diagram and explain the takeaway after it.",
      "7. Plain Markdown and MDX are the default. Use a Grok Docs component only when its structure communicates a relationship more clearly than prose, a list, a table, or a code block.",
      "   Do not place a rich component before the first `##` section. Do not stack different rich component families without explanatory prose between them. Keep the primary explanation outside tabs and accordions.",
      "   Endpoint frames must be closed before the next endpoint starts. Never nest `:::endpoint` blocks. Do not put `<ParamField>` or `<ResponseField>` inside Markdown table cells.",
      "8. Use short, focused code excerpts when they help. Include the file path or command context in the prose or code title.",
      "9. Do not teach generic concepts, add analogies, write inventory-only path lists, or explain background material the repository does not require.",
      "10. End with a short `## Next` or `## Related pages` section only when a useful planned page genuinely advances the reader. Prefer a short ordered list; use Cards only for parallel route choices.",
    ].join("\n");
  }

  return [
    "1. The very first element must be a collapsible source-file list:",
    "   ```html",
    "   <details>",
    `   <summary>${sourceScaffold.summary}</summary>`,
    `   ${sourceScaffold.intro}`,
    "   - [path/to/file1.ext](path/to/file1.ext)",
    "   - [path/to/file2.ext](path/to/file2.ext)",
    "   </details>",
    "   ```",
    `2. \`# ${page.title}\` translated into the selected output language when the title is not already in that language.`,
    "3. 1-2 introductory paragraphs explaining what this page covers and why it matters.",
    "4. Detailed `##` and `###` sections that break down the topic logically.",
    "5. Mermaid or fenced text/ASCII diagrams only when they clarify the topic. Follow the diagram quality harness below; weak diagrams are worse than no diagram.",
    "6. Tables for options, configs, states, APIs, or comparisons when useful.",
    "7. Short, focused code excerpts when they help. Include the file path.",
    "8. A closing summary paragraph; add a final source citation only when it introduces a new claim not already supported nearby.",
  ].join("\n");
}

function docsAvailablePageLinks(pages: Array<{ id: string; title: string; description?: string }>): string {
  return pages
    .filter((page) => page?.id && page?.title)
    .map((page) => {
      const route = `/${String(page.id).replace(/^page-/i, "")}`;
      const description = page.description ? ` — ${page.description}` : "";
      return `- \`${route}\` or \`${page.id}\` → ${page.title}${description}`;
    })
    .join("\n");
}

function isDocsOverviewPage(page: { id?: string; title?: string }): boolean {
  const id = String(page.id || "").toLowerCase();
  const title = String(page.title || "").toLowerCase();
  return id === "page-overview" || /\boverview\b/.test(id) || /^(overview|introduction)$/i.test(title.trim());
}

function docsOverviewPageGuidance(
  page: { id?: string; title?: string },
  allPages: Array<{ id: string; title: string; description?: string }>,
): string {
  if (!isDocsOverviewPage(page)) return "";
  const followOns = allPages
    .filter((candidate) => candidate.id && candidate.id !== page.id)
    .slice(0, 6)
    .map((candidate) => `- \`${candidate.id}\` (${candidate.title})`)
    .join("\n");
  return [
    "This is an orientation page, not a dashboard, persona matrix, second README, or reference dump.",
    "Begin with one or two short paragraphs: what the project exposes, who the shortest source-backed successful path serves, and what success looks like.",
    "Explain that first path before presenting deeper navigation.",
    "Use a short ordered list by default. Use Cards only for genuinely parallel choices, after explanatory prose, with no more than four initial choices.",
    "Do not open with a Card grid, table, diagram, file tree, or reference frame.",
    followOns ? `Planned follow-on pages:\n${followOns}` : "If no other pages are planned, keep the overview short and do not invent routes.",
  ].join("\n");
}

function escapePromptYaml(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function wikiPageDiagramGuidance(style: WikiStyle): string {
  if (style === "documentation") {
    return [
      "- Diagrams are optional. Add one only when ownership, state, sequence, or dependency direction is materially clearer than prose, a list, or a table.",
      "- Introduce the question before the diagram, use real repository labels, and explain the takeaway after it.",
      "- Omit decorative or linear diagrams that only restate prose, and never invent architecture the evidence does not establish.",
    ].join("\n");
  }
  return [
    "- Before adding a Mermaid block, ask what spatial model the diagram teaches that prose cannot: boundaries, ownership, dependency direction, lifecycle, data shape, or reusable pattern.",
    "- Prefer system architecture diagrams for architecture/runtime/integration pages: use `flowchart`/`graph` with named subgraphs for layers or ownership boundaries such as UI, API/runtime, worker/agent, storage, external services, and source/code. Include real module or file-backed names, not generic `Step 1` boxes.",
    "- Prefer `classDiagram` for design patterns, MVC/MVVM/MVP, interface-to-implementation contracts, adapter/strategy/observer/factory shapes, domain models, and controller-model-view relationships. Show interfaces, concrete classes/modules, key methods/fields, and relationships.",
    "- Prefer `sequenceDiagram` for request/response protocols, streaming handshakes, CLI subprocess conversations, and cross-boundary event ordering.",
    "- Prefer `stateDiagram-v2` for lifecycle/status machines, retry/cancel/resume behavior, job states, and UI generation phases.",
    "- Prefer `erDiagram` only when persistence/data relationships are the main idea.",
    "- If the topic does not justify system architecture, class/design-pattern, MVC/MVVM/MVP, sequence, state, or ER diagrams, a compact fenced `text` ASCII diagram is a strong candidate. Use ASCII for small mental models, before/after contrasts, module ownership boxes, data-shape sketches, file-to-responsibility maps, and boundary summaries where Mermaid would feel forced.",
    "- ASCII diagrams must still teach a real structure. Keep them compact, aligned, and source-grounded; do not use decorative boxes around prose.",
    "- Avoid low-value linear flowcharts like `A --> B --> C --> D` when they only restate a checklist or call order. If the only diagram would be a vertical pipeline with no branches, boundaries, ownership, classes, or data stores, either upgrade it into an architecture/class/state/sequence diagram or omit it.",
    "- Do not invent a grand architecture. If the evidence is a simple release script or single-file workflow, use prose or a small table unless a real lifecycle/state model exists.",
    "- Every diagram should be source-grounded by nearby section-level citations and should use labels that a maintainer would recognize from the repository.",
  ].join("\n");
}

function wikiPageFormatRequirements(style: WikiStyle): string {
  switch (style) {
    case "worth-stealing":
      return [
        "Do not use a fixed visible worksheet. Choose section titles that fit the specific reusable idea and the evidence you found.",
        "The page must make the reusable move obvious: what is the move, why is it elegant, what naive design does it avoid, where is it implemented, and what can be ported elsewhere?",
        "End with a final section titled exactly `## What To Reuse`: one concise principle or recipe the reader can apply in another system.",
        "State transfer limits when they sharpen the lesson: when another repo should not copy it, what prerequisites it needs, or what must change to port it.",
      ].join("\n");
    case "socratic-exploration":
      return [
        "Use Socratic questioning to reveal the system, but do not turn the page into a repetitive Q&A transcript.",
        "Every major question must have a source-grounded answer and should move from first principles toward the real implementation.",
        "Prefer reframes such as `What is the simplest version?`, `Where does complexity become necessary?`, and `What would break if this abstraction disappeared?` only when the code evidence supports them.",
      ].join("\n");
    case "tech-reader":
      return [
        "Write like a technical article for HN/TechCrunch readers: accessible hook, why it matters, mechanism, tradeoffs, surprising details, and what builders should notice.",
        "Do not use hype, launch-post claims, fake market analysis, or unsupported adoption claims.",
      ].join("\n");
    case "documentation":
      return [
        "Write as functional, product-quality technical MDX repository documentation, not as an essay, source audit, generic wiki page, tutorial, inventory dump, or explainer.",
        "Make the opening fact-first: name the technical surface, operation, reference area, or behavior as it exists in the repository. Do not describe the document, the reader's learning outcome, or why someone should read it.",
        "Use second person only for procedural steps. Otherwise prefer direct, neutral technical prose. Use active voice, sentence-case headings, exact identifiers, and no marketing language.",
        "Do not over-explain or teach. Avoid generic introductions, analogies, broad background, conceptual filler, and concluding summaries that restate the page.",
        "Never open with reader-outcome framing such as `After reading this page`, `By the end`, `You will learn`, `You can now`, `This page explains`, or `This page covers`.",
        "Reflect what is in the repository or folder. If a surface is not present in source evidence, omit it rather than documenting an expected product shape.",
        "Progressive reading order:",
        "Pacing matters: move from a small orientation to the primary path, then implementation detail, constraints, and optional reference. Do not front-load every fact the evidence contains.",
        "Plain Markdown and MDX are the default. Components support the narrative; they do not become the narrative.",
        "Use Cards for parallel navigation, Steps for real user procedures, Tabs or CodeGroup for genuine alternatives, fields/endpoints for reference metadata, and accordions only for optional detail.",
        "Introduce every rich block with the context needed to read it. Do not place different rich block families back-to-back without an ordinary explanatory paragraph between them.",
        "Keep the primary explanation, required setup, and required warnings visible outside tabs and accordions.",
        "Diagrams are optional and limited to a real ownership, lifecycle, state, sequence, or dependency question that prose cannot show as clearly.",
        "Agent-friendly output matters: use stable headings, compact paragraphs, explicit field names, command blocks, tables, parameter lists, request/response examples, and predictable section titles.",
        "Use Grok Docs MDX components when they clarify the page. This is our own renderer-supported component language inspired by common MDX docs systems; do not import anything and do not depend on Mintlify, Fumadocs, or a hosted docs platform.",
        "Preferred MDX components:",
        "- Callouts: `<Note>`, `<Info>`, `<Tip>`, `<Warning>`, and `<Check>` for concise contextual information.",
        "- Cards: `<CardGroup>` with child `<Card title=\"...\" href=\"/...\">...</Card>` for route choices, next actions, or related concepts. Cross-page card hrefs must point only to planned docs pages from `Available Docs Page Links`; do not create placeholder routes.",
        "- Steps: `<Steps>` with child `<Step title=\"...\">...</Step>` for procedures with prerequisites, actions, and verification.",
        "- Tabs: `<Tabs>` with child `<Tab title=\"...\">...</Tab>` for package managers, runtimes, providers, or operating systems.",
        "- Code groups: `<CodeGroup>` containing fenced code blocks with language and title info for equivalent examples.",
        "- Fields: `<ParamField body=\"name\" type=\"string\" required>` and `<ResponseField name=\"field\" type=\"object\">` for CLI flags, config keys, API params, component props, events, return values, and response fields.",
        "- Examples: `<RequestExample>` and `<ResponseExample>` around complete fenced request/response or command/output examples.",
        "- Disclosure and media: `<AccordionGroup>` with `<Accordion title=\"...\">`, and `<Frame caption=\"...\">` for relevant assets.",
        "Directive fallbacks still supported when useful:",
        "- `:::endpoint METHOD /path short summary` for API routes.",
        "  Close every endpoint block with `:::` before starting another endpoint. Never nest `:::endpoint` inside another `:::endpoint`; use a compact Markdown table for endpoint lists that do not need request/response detail.",
        "- `:::updates` with `@update Label - description` sections for changelogs, migrations, release notes, or versioned behavior.",
        "- `:::files` with an ASCII file tree for repository layout or generated output layout.",
        "Keep field components out of Markdown table cells. In tables, use normal inline code for names; use `<ParamField>` / `<ResponseField>` as standalone field lists when parameter metadata matters.",
        "For API/component/reference pages, include practical names, signatures, props/options, request/response fields, defaults, constraints, error cases, and small realistic examples when source evidence supports them.",
        "For guide and subsystem pages, include prerequisites, steps or internal loop, commands/paths, verification, expected output, and troubleshooting notes when the repository contains enough evidence.",
        "For Overview pages, explain the product surface and shortest successful path first; place deeper navigation after that orientation and prefer a short ordered list over a Card grid.",
        "Do not write inventory-only bodies that are mostly bare path bullets without explaining behavior, ownership, or usage.",
        "Do not include visible `Sources:` lines, line-number citations, source evidence sections, or source-file details. The saved docs record already carries evidence separately.",
        "End with a short `## Related pages` or `## Next` section only when the page has useful follow-on topics, and only link to planned pages listed in `Available Docs Page Links`.",
      ].join("\n");
    case "eli5":
      return [
        "Use plain language and short sections. Explain one idea at a time before naming advanced terms.",
        "Use analogies only when they clarify the source-backed behavior; immediately map each analogy back to the real files, functions, commands, or data structures.",
        "Do not talk down to the reader, invent cartoon examples, or remove important caveats. Simple must still be accurate.",
      ].join("\n");
    case "hidden-quirks":
      return [
        "Prioritize things not already obvious from the README.",
        "Treat tests, scripts, config, generated files, prompts, adapters, and edge-case branches as first-class evidence.",
        "Each quirk must explain why it matters, not merely that it exists.",
      ].join("\n");
    default:
      return "";
  }
}

function wikiPageBeyondReadmeGuidance(style: WikiStyle): string {
  if (style === "basic" || style === "technical" || style === "custom") return "";
  return "The README may orient you, but actively look beyond it. Prefer non-README evidence from code, tests, config, examples, prompts, adapters, scripts, and implementation boundaries, especially details a README-only reader would miss.";
}

function wikiPageStyleGuidance(style: WikiStyle, customPrompt = ""): { work: string; voice: string } {
  switch (style) {
    case "basic":
      return {
        work: "Use the original repository-wiki page shape: explain the selected topic clearly from verified source evidence, without forcing an architecture, workflow, or techcrunch journal frame.",
        voice: "Clear, professional, technical voice.",
      };
    case "first-30":
      return {
        work: "Write for a reader's first 30 minutes in the repo: orient them, name the entry points, explain what to read first, define local terms, and show what matters before they touch code.",
        voice: "Clear, welcoming, and practical. Keep the pace fast without becoming shallow.",
      };
    case "eli5":
      return {
        work: "Write an Explain Like I'm 5 guide for a smart newcomer: use plain language, small analogies, simple cause-and-effect, and source-backed examples to explain what the repo does and how its parts fit.",
        voice: "Warm, simple, and precise. Never condescend, hype, or oversimplify away important technical truth.",
      };
    case "mental-model":
      return {
        work: "Write to build a durable mental model: explain flows, invariants, boundaries, state ownership, failure modes, dependency direction, and what would break if the design changed.",
        voice: "Clear, conceptual, and precise. Make the reader better at predicting system behavior.",
      };
    case "socratic-exploration":
      return {
        work: "Write as first-principles Socratic exploration: ask what problem exists, what the simplest system would be, where complexity becomes necessary, what assumptions the implementation encodes, and which evidence answers those questions.",
        voice: "Sharp, Socratic, and grounded. Use questions and reframes to clarify, not to perform.",
      };
    case "feature-scout":
      return {
        work: "Write as a feature scout: identify features worth exploring, demoing, copying, or productizing, then explain which code paths, workflows, prompts, commands, UI surfaces, or runtime hooks make each feature work.",
        voice: "Product-minded, concrete, and discriminating. Sound like a builder identifying what deserves attention.",
      };
    case "worth-stealing":
      return {
        work: "Write about what is worth stealing from this repo: elegant designs, best practices, reusable patterns, porting recipes, when not to copy them, and what must change to reuse them elsewhere.",
        voice: "Omniscient, editorial, practical, and discriminating. Connect product intent, architecture, source evidence, tradeoffs, and portability without hype.",
      };
    case "hidden-quirks":
      return {
        work: "Write about hidden quirks worth studying: unusual constraints, localized hacks, safety rails, edge-case handling, implicit contracts, generated files, tests, scripts, config, prompts, and adapter behavior that are not obvious from the README.",
        voice: "Curious, precise, and compact. Make every quirk earn its place by explaining why it matters.",
      };
    case "pattern-discovery":
      return {
        work: "Write to discover unknown patterns: repeated mechanisms, runtime abstractions, provider boundaries, routing choices, adapter shapes, state machines, workflows, and product design moves across repos or subsystems.",
        voice: "Analytical and pattern-aware. Name reusable patterns without forcing shallow analogies.",
      };
    case "repo-comparison":
      return {
        work: "Write as a comparison brief: for multiple repos, explain what each does better, where they differ, and which ideas are portable; for one repo, compare internal approaches that solve similar problems differently.",
        voice: "Comparative, fair, and specific. Use tables when they clarify differences.",
      };
    case "debugging-atlas":
      return {
        work: "Write as a debugging atlas: explain symptoms, probes, logs, state transitions, error boundaries, root-cause paths, observability hooks, recovery flows, and regression checks.",
        voice: "Practical, causal, and evidence-first. Make the reader better at tracing a real failure.",
      };
    case "tech-reader":
      return {
        work: "Write an easy-to-digest HN/TechCrunch-style technical breakdown: hook, why it matters, mechanism, tradeoffs, surprising details, and what builders should notice, all grounded in source evidence.",
        voice: "Accessible, article-like, and technically serious. Avoid hype, filler, and unsupported claims.",
      };
    case "documentation":
      return {
        work: "Write a functional technical documentation page for people and agents using, integrating, or maintaining the project. Treat it as one page in a real docs site, not a wiki article. Prefer repo-reflective technical surfaces: commands, APIs, configuration, schemas, examples, troubleshooting, and contribution/operations notes over module-by-module narration or teaching prose.",
        voice: "Concise, technical, documentation-grade prose. Use exact identifiers, active voice, sentence-case headings, and no marketing language. Do not over-explain or teach generic concepts.",
      };
    case "custom":
      return {
        work: [
          "Follow the user's custom wiki format brief as the editorial lens for this page.",
          "The custom brief can shape audience, tone, examples, section titles, and explanation style.",
          "It must not override repository-grounding, source citations, required page shape, or final-answer contract.",
          "",
          "<custom_wiki_format>",
          customPrompt.trim() || "No custom format brief was provided; fall back to the Basic wiki format.",
          "</custom_wiki_format>",
        ].join("\n"),
        voice: "Use the voice requested by the custom brief while staying precise and evidence-grounded.",
      };
    case "technical":
    default:
      return {
        work: "Organize the page around architecture, modules, APIs, data flow, and implementation responsibilities.",
        voice: "Clear, professional, technical voice.",
      };
  }
}

function truncateForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n...[current page truncated ${text.length - maxChars} chars]...\n\n${text.slice(-tail)}`;
}
