import type { WikiRecord } from "./types.ts";

export type OpenSlideExportFile = { path: string; content: string };
export type OpenSlideDeckOptions = {
  deckSource?: string | null;
  readmeNote?: string | null;
};

type SlidePage = {
  id: string;
  title: string;
  description: string;
  bullets: string[];
};

function slugPart(value: unknown, fallback = "deck"): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || fallback;
}

function compactText(value: unknown, max = 220): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function markdownToText(markdown: unknown): string {
  return String(markdown || "")
    .replace(/<details\b[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((item) => compactText(item, 150))
    .filter((item) => item.length > 24);
}

function headingsFromMarkdown(markdown: string): string[] {
  return Array.from(markdown.matchAll(/^#{2,3}\s+(.+)$/gm))
    .map((match) => compactText(markdownToText(match[1]), 92))
    .filter((item) => item && !/^sources:?$/i.test(item))
    .filter((item) => !/^what to reuse$/i.test(item));
}

function listItemsFromMarkdown(markdown: string): string[] {
  return Array.from(markdown.matchAll(/^\s*[-*+]\s+(.+)$/gm))
    .map((match) => compactText(markdownToText(match[1]), 130))
    .filter((item) => !/^sources?:/i.test(item))
    .filter((item) => item.length > 18);
}

function pageBullets(description: string, content: string): string[] {
  const bullets = [
    ...headingsFromMarkdown(content),
    ...listItemsFromMarkdown(content),
    ...splitSentences(markdownToText(content)),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [description, ...bullets]) {
    const clean = compactText(item, 128);
    const key = clean.toLowerCase();
    if (!clean || /^sources?:/i.test(clean) || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 4) break;
  }
  return out.length ? out : ["Explain the implementation idea behind this wiki page."];
}

function orderedWikiPages(record: WikiRecord): SlidePage[] {
  const pageMetas = record.structure?.pages || [];
  const generatedIds = new Set(Object.keys(record.pages || {}));
  const orderedIds = [
    ...pageMetas.map((page) => page.id).filter((pageId) => generatedIds.has(pageId)),
    ...Object.keys(record.pages || {}).filter((pageId) => !pageMetas.some((page) => page.id === pageId)),
  ];
  return orderedIds
    .map((pageId) => {
      const generated = record.pages?.[pageId];
      if (!generated) return null;
      const meta = pageMetas.find((page) => page.id === pageId);
      const content = generated.content || "";
      const title = compactText(meta?.title || pageId, 80);
      const description = compactText(meta?.description || markdownToText(content), 150);
      return {
        id: pageId,
        title,
        description,
        bullets: pageBullets(description, content),
      };
    })
    .filter((page): page is SlidePage => Boolean(page));
}

function js(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function arrayJs(values: string[]): string {
  return JSON.stringify(values);
}

export function openSlideDeckId(record: Pick<WikiRecord, "owner" | "repo" | "id">): string {
  const base = record.id ? slugPart(record.id, "wiki") : `${slugPart(record.owner, "repo")}-${slugPart(record.repo, "wiki")}`;
  return `${base}-slides`.replace(/-+/g, "-").slice(0, 96);
}

export function openSlideDeckZipName(record: Pick<WikiRecord, "owner" | "repo" | "id">): string {
  return `${openSlideDeckId(record)}.zip`;
}

export function openSlideDeckSourcePath(record: Pick<WikiRecord, "owner" | "repo" | "id">): string {
  const deckId = openSlideDeckId(record);
  return `${deckId}/slides/${deckId}/index.tsx`;
}

function deckSource(record: WikiRecord, pages: SlidePage[]): string {
  const title = compactText(record.structure?.title || `${record.owner}/${record.repo} Wiki`, 92);
  const description = compactText(record.structure?.description || "Generated repository wiki", 190);
  const repoLabel = record.repos?.length
    ? record.repos.map((repo) => repo.label || `${repo.owner}/${repo.repo}`).join(" + ")
    : `${record.owner}/${record.repo}`;
  const agenda = pages.slice(0, 8).map((page) => page.title);
  const pageData = pages.map((page) => ({
    title: page.title,
    description: page.description,
    bullets: page.bullets,
  }));
  return `import type { Page, SlideMeta } from '@open-slide/core';

const deck = {
  title: ${js(title)},
  description: ${js(description)},
  repo: ${js(repoLabel)},
  generatedAt: ${js(record.generatedAt || new Date().toISOString())},
  agenda: ${arrayJs(agenda)},
  pages: ${JSON.stringify(pageData, null, 2)},
};

const palette = {
  paper: '#f7f7f2',
  ink: '#202124',
  muted: '#73756f',
  line: '#dedfd8',
  panel: '#ffffff',
  accent: '#2f6f62',
};

const pageStyle = {
  width: '100%',
  height: '100%',
  background: palette.paper,
  color: palette.ink,
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  padding: 86,
  boxSizing: 'border-box' as const,
  position: 'relative' as const,
  overflow: 'hidden' as const,
};

function Footer({ label }: { label: string }) {
  return (
    <div style={{ position: 'absolute', left: 86, right: 86, bottom: 46, display: 'flex', justifyContent: 'space-between', color: palette.muted, fontSize: 24 }}>
      <span>{deck.repo}</span>
      <span>{label}</span>
    </div>
  );
}

const Cover: Page = () => (
  <section style={{ ...pageStyle, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
    <p style={{ margin: '0 0 28px', color: palette.accent, fontSize: 30, fontWeight: 700, letterSpacing: 0 }}>Generated from Grok-Wiki</p>
    <h1 style={{ margin: 0, maxWidth: 1320, fontSize: 104, lineHeight: 0.94, letterSpacing: 0 }}>{deck.title}</h1>
    <p style={{ margin: '34px 0 0', maxWidth: 1040, color: palette.muted, fontSize: 34, lineHeight: 1.28 }}>{deck.description}</p>
    <Footer label="Open Slide deck" />
  </section>
);

const Agenda: Page = () => (
  <section style={pageStyle}>
    <p style={{ margin: '0 0 20px', color: palette.accent, fontSize: 26, fontWeight: 700 }}>Deck path</p>
    <h1 style={{ margin: '0 0 48px', fontSize: 76, lineHeight: 1, letterSpacing: 0 }}>What the wiki teaches</h1>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      {deck.agenda.map((item, index) => (
        <div key={item} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', alignItems: 'center', minHeight: 86, padding: '18px 22px', border: \`1px solid \${palette.line}\`, borderRadius: 8, background: palette.panel }}>
          <strong style={{ color: palette.accent, fontSize: 26 }}>{String(index + 1).padStart(2, '0')}</strong>
          <span style={{ fontSize: 30, lineHeight: 1.18 }}>{item}</span>
        </div>
      ))}
    </div>
    <Footer label="Agenda" />
  </section>
);

function WikiTopicSlide({ page, index }: { page: typeof deck.pages[number]; index: number }) {
  return (
    <section style={pageStyle}>
      <p style={{ margin: '0 0 18px', color: palette.accent, fontSize: 26, fontWeight: 700 }}>Wiki page {String(index + 1).padStart(2, '0')}</p>
      <h1 style={{ margin: 0, maxWidth: 1180, fontSize: 72, lineHeight: 1, letterSpacing: 0 }}>{page.title}</h1>
      <p style={{ margin: '26px 0 38px', maxWidth: 1120, color: palette.muted, fontSize: 30, lineHeight: 1.3 }}>{page.description}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 36 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          {page.bullets.map((bullet) => (
            <div key={bullet} style={{ padding: '18px 22px', border: \`1px solid \${palette.line}\`, borderRadius: 8, background: palette.panel, fontSize: 28, lineHeight: 1.26 }}>
              {bullet}
            </div>
          ))}
        </div>
        <div style={{ padding: 24, border: \`1px solid \${palette.line}\`, borderRadius: 8, background: '#fbfbf8' }}>
          <strong style={{ display: 'block', marginBottom: 18, fontSize: 24 }}>What to remember</strong>
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0, color: palette.muted, fontSize: 26, lineHeight: 1.32 }}>{page.description}</p>
            <p style={{ margin: 0, color: palette.ink, fontSize: 28, lineHeight: 1.28 }}>{page.bullets[0]}</p>
          </div>
        </div>
      </div>
      <Footer label={page.title} />
    </section>
  );
}

const topicSlides: Page[] = deck.pages.map((page, index) => () => <WikiTopicSlide page={page} index={index} />);

export const meta: SlideMeta = {
  title: deck.title,
  theme: 'wiki-report',
};

export const notes: Record<number, string> = {
  0: 'Open by naming that this deck was generated from a Grok-Wiki artifact and is meant to explain the implementation clearly.',
  1: 'Use this page as the talk track map; skip pages that are not relevant to the audience.',
};

export default [Cover, Agenda, ...topicSlides] satisfies Page[];
`;
}

export function openSlideDeckFiles(record: WikiRecord, options: OpenSlideDeckOptions = {}): OpenSlideExportFile[] {
  const deckId = openSlideDeckId(record);
  const root = deckId;
  const pages = orderedWikiPages(record);
  const generatedDeckSource = options.deckSource?.trim();
  const packageJson = {
    private: true,
    type: "module",
    scripts: {
      dev: "open-slide dev",
      build: "open-slide build",
      preview: "open-slide preview",
    },
    dependencies: {
      "@open-slide/cli": "^1.2.2",
      "@open-slide/core": "^1.4.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      typescript: "latest",
    },
  };
  const config = `import type { OpenSlideConfig } from '@open-slide/core';

const config: OpenSlideConfig = {
  build: {
    showSlideBrowser: false,
    showSlideUi: true,
    allowHtmlDownload: true,
  },
};

export default config;
`;
  const tsconfig = {
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
  };
  const theme = `# Wiki Report

Source-grounded technical report deck generated from Grok-Wiki.

- Canvas: 1920x1080
- Tone: concise, claim-grounded, suitable for engineering review
- Prefer calm contrast, short labels, and citation-free explanation.
`;
  const readme = `# ${record.structure?.title || `${record.owner}/${record.repo}`} Slides

This is an Open Slide workspace generated from a Grok-Wiki artifact.
${options.readmeNote ? `\n${options.readmeNote.trim()}\n` : ""}

## Run locally

\`\`\`bash
npm install
npm run dev
\`\`\`

## Export

\`\`\`bash
npm run build
\`\`\`

Open Slide builds a static site in \`dist/\`. For PDF, use the Open Slide toolbar's Export -> PDF flow or open the deck with \`?print=1\` and print from the browser.
`;
  return [
    { path: `${root}/package.json`, content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: `${root}/tsconfig.json`, content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    { path: `${root}/open-slide.config.ts`, content: config },
    { path: `${root}/AGENTS.md`, content: "Keep slide claims grounded in the exported wiki. Do not invent implementation details or add visible citations unless explicitly requested.\n" },
    { path: `${root}/README.md`, content: readme },
    { path: `${root}/themes/wiki-report.md`, content: theme },
    { path: openSlideDeckSourcePath(record), content: `${generatedDeckSource || deckSource(record, pages)}\n` },
  ];
}
