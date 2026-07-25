# Changelog

## 2026-07-12

- Prepared Grok-Wiki 0.0.33 with an Orca-style Terminal projects rail, improved TUI fidelity, and project-aware local-agent workspaces.
- Added opt-in Code Graph support so Ask and Wiki generation can use evidence-backed code knowledge without coupling runs to one model provider.
- Added provider account and usage status surfaces, plus refreshed local CLI model catalogs for Grok, Codex, Claude, and Pi while preserving Default and user-owned credential paths.
- Polished Ask with Codex-style send controls, middle-truncated context chips, scroll fades, follow-up queue handling, drag/drop affordances, and steadier process activity UI.
- Aligned Tasks agent terminals with desktop terminal spawning, color, and appearance, and fixed Tasks create/run completion flows.
- Continued the desktop render-boundary refactor with scoped controllers, renderers, runtime facades, and regression coverage for Ask, Wiki, Tasks, terminal, sidebar, settings, and project surfaces.
- Hardened public gallery, sitemap, and crawler routes while keeping public website assets separate from the signed desktop bundle.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.33.

## 2026-06-12

- Released Grok-Wiki 0.0.30 with desktop Ask reliability fixes for Local CLI agents that depend on login-shell proxy and certificate settings.
- Fixed `FailedToOpenSocket` failures where Claude Code or another local CLI worked in Terminal but desktop Ask could not open the provider API socket.
- Imported only network connectivity configuration into the desktop server launch path, including proxy, `NO_PROXY`, and CA bundle variables, while continuing to filter provider API keys from local agent processes.
- Added PostHog Ask failure classification and capture across request failures, terminal stream errors, and streamed agent error text so socket failures are visible in the next release.
- Expanded regression coverage for Local CLI environment filtering and Ask error classification without coupling the product to one model provider.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.30.

## 2026-06-11

- Released Grok-Wiki 0.0.28 with server-side PostHog error capture for the desktop local server and API flows.
- Added redacted, rate-limited exception reporting so paths, URLs, emails, tokens, and long stack traces are scrubbed before leaving the process.
- Synced desktop analytics opt-out state to the bundled server so privacy settings disable both client-side and server-side capture.
- Added hosted/server telemetry controls through `RLM_WIKI_SERVER_TELEMETRY` without coupling runs to a model provider or changing BYOK/BYOC execution paths.
- Refactored Ask outline, Wiki stream, document tabs, and repo route controllers while preserving scoped rendering boundaries for high-frequency streams.
- Refreshed the public product overview with five-surface app visuals and shipped the HyperFrames overview/video project assets.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.28.

## 2026-06-10

- Released Grok-Wiki 0.0.27 with a local-first Tasks board that turns Ask findings into backlog cards, epics, and sub-tasks.
- Added Ask-to-Tasks extraction so local CLI agents can distill engineering answers into actionable work without locking users to one provider.
- Added task running from cards through detected local agents, with watchable terminal transcripts, done-state reconciliation, and change summaries.
- Added screenshot attachments for Ask and Clarify flows on supported local CLI agents, while keeping unsupported runtimes clearly gated.
- Fixed clarified Ask turns so clarification answers are delivered to the model and visible in the thread.
- Kept Docs and Wiki generation progress scoped to the owning surface so a Docs run does not bleed into the Wiki panel.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.27.

## 2026-06-09

- Released Grok-Wiki 0.0.26 with Knowledge Bases that turn Ask sessions into source-backed study cards.
- Added Knowledge Base distillation, merging, publishing, private-link reads, and denser card/list review surfaces.
- Added guided Wiki and Ask interview starts that ask short clarifying questions before generation while preserving skip paths.
- Added Episode 06, "Jealousy-Driven Development," promoting Ask as a multi-repository study partner.
- Expanded regression coverage for Knowledge Base storage, merge, publish, project grouping, Ask clarify, wiki interview, render scope, and desktop routing.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.26.

## 2026-06-07

- Released Grok-Wiki 0.0.25 with a floating outline peek for multi-turn Ask sessions so long answers stay navigable without leaving the current turn.
- Kept Ask streaming scoped to the active outline surface so outline updates do not repaint the broader desktop shell.
- Improved project item rendering and repository grouping coverage so project lists stay stable as repository metadata changes.
- Added focused regression tests for Ask outline render scope and project grouping behavior.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.25.

## 2026-06-07

- Released Grok-Wiki 0.0.24 with warmer 90s memory-style desktop entry surfaces for Projects, Wiki, Ask, Docs, and the launchpad.
- Reworked the Projects page header into an image-backed cover while keeping the dense project list and New Project action close at hand.
- Made Ask, Wiki, and Docs feel more inviting with top-of-page visual treatments, including a standalone Ask hero that no longer wraps the composer.
- Refined the launchpad with a softer office coffee-kitchen banner, no logo mark, clearer explanatory copy, and a sharper placeholder for repo, folder, or question starts.
- Removed the gallery refresh button from Wiki and Docs so the generation surfaces stay calmer and less cluttered.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.24.

## 2026-06-06

- Released Grok-Wiki 0.0.23 with packaged macOS terminal-agent launch fixes for local CLI binaries detected outside the app's narrower GUI PATH.
- Launched local agents through the detected executable path so BYOK/BYOC setups keep working across shell managers, npm install roots, Volta, asdf, mise, nvm, and fnm.
- Kept very fast startup exits visible long enough to show diagnostics instead of flickering the pane closed after a failed launch.
- Preserved Orca-style close-on-exit behavior for established terminal panes.
- Ships signed and notarized macOS Apple Silicon DMG plus Tauri updater artifacts for 0.0.23.

## 2026-06-06

- Released Grok-Wiki 0.0.22 with desktop completion attention for long-running wiki and Ask work: native alerts, optional sound, dock badge counts, and deep links back into the finished item.
- Upgraded the embedded terminal into a calmer local workspace surface with xterm-backed PTYs, compact project/runtime controls, Orca-style `Cmd+D` split-right and `Cmd+Shift+D` split-down shortcuts, and pane close-on-exit behavior.
- Improved terminal reliability by keeping split panes inside one tab, preventing duplicate pane creation, promoting surviving panes when a root PTY exits, and releasing temporary workspaces after terminal sessions close.
- Tightened streaming render boundaries so Ask answer text, wiki generation progress, and local CLI process updates patch their owning surfaces instead of repainting the desktop shell.
- Added regression coverage for desktop attention, terminal split/exit behavior, Ask streaming scope, wiki streaming scope, and terminal workspace preparation while preserving BYOK/BYOC local-agent runtime paths.

## 2026-06-02

- Released Grok-Wiki 0.0.17 with a more capable Docs Chat overlay: answers now stay on the docs page, support follow-up or new questions, and prioritize the current documentation MDX before falling back to repository inspection.
- Fixed Docs Chat runtime selection so the selected local CLI agent and model are preserved for documentation questions instead of being reset by Ask polling.
- Improved Docs Chat streaming and typing responsiveness by scoping high-frequency updates to the docs chat panel and deferring broad library refreshes while the composer is active.
- Fixed generated documentation rendering for public docs and desktop docs, including tab navigation, light-mode text highlights, Python syntax highlighting, Mermaid diagrams, and code block copy controls.
- Added public docs video thumbnail metadata to help Google index documented videos instead of reporting missing thumbnail URLs.
- Strengthened the public GitHub release runbook so `AsyncFuncAI/grok-wiki` main and release tags stay limited to `README.md` and `skills/`.

## 2026-06-01

- Released Grok-Wiki 0.0.16 with first-class documentation support: the desktop app can now generate Grok Docs from repositories, keep docs separated from regular wikis, and render documentation pages with a docs-style reader, navigation, page rail, and supported MDX-style components.
- Added public documentation publishing under `/public/docs`, including canonical public docs pages, docs gallery routing, public Open Graph rendering, sitemap and robots coverage, and agent-readable markdown routes.
- Added docs-aware `llms.txt`, `llms-full.txt`, `.md`, and per-page routes so agents can read compact indexes first, fetch whole-docs context only when needed, and stay grounded in the published documentation snapshot.
- Added the Add Agent handoff prompt for public wikis and public docs. It copies a vendor-agnostic prompt that works with user-chosen agents and BYOK/BYOC runtime paths instead of assuming one model provider.
- Improved the documentation generator contract with docs-specific structure planning, frontmatter validation, planned-route link checks, Grok Docs MDX component guidance, and safeguards against visible source-citation clutter in docs bodies.
- Improved desktop reader and streaming stability for docs, wiki generation, markdown rendering, diagrams, source previews, and public publishing controls while keeping high-frequency updates scoped to their owning components.
- Added bundled Grok-Wiki agent skills and local-first source/runtime documentation for BYOK/BYOC operation.
- Updated desktop updater handling and release verification coverage for signed macOS artifacts and Tauri updater metadata.

## 2026-05-27

- Released Grok-Wiki 0.0.15 with first-class local folder support for wiki generation when a selected folder does not contain a `.git` directory.
- Kept branch and ref selection Git-only while allowing read-only local folder indexing for Ask and Wiki flows.
- Added desktop confirmation copy for non-git local folders so users understand branch/ref selection is disabled before continuing.
- Added actionable local CLI diagnostics, including command and working-directory context when agents exit without useful stderr.
- Added a tunable Antigravity quiet-output timeout and captured Claude Code Agent SDK stderr for clearer failure reports.

## 2026-05-04

- Added public read-only wiki publishing with public wiki pages, public wiki APIs, and Cloudflare Access bypass guidance for public wiki routes and assets.
- Added configurable wiki page counts from 6 to 50 pages, with Fast, Regular, and Deep tiers derived from the selected count.
- Added batch regeneration for multiple selected wiki pages using one shared goal or instruction.
- Added durable wiki generation state: active runs now appear in the wiki library, runs can be resumed by ID, dropped browser streams reconnect to persisted run events, and stalled runs are labeled when no worker heartbeat is present.
- Added draft wiki checkpoints during generation so completed page progress is persisted before the final artifact is written.
- Added final completion reconciliation so wiki runs report planned, generated, and missing page counts at completion.
- Added Railway worker configuration for three worker replicas while preserving BYOK/BYOC, vendor-agnostic model routing.
