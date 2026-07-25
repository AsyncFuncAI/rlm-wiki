export const WIKI_DEPTHS = ["fast", "regular", "deep"] as const;
export type WikiDepth = typeof WIKI_DEPTHS[number];
export const WIKI_PAGE_COUNT_MODES = ["auto", "fixed"] as const;
export type WikiPageCountMode = typeof WIKI_PAGE_COUNT_MODES[number];

export const WIKI_PAGE_COUNT_MIN = 1;
export const WIKI_PAGE_COUNT_MAX = 30;

export const WIKI_BUILTIN_STYLES = [
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

export const WIKI_STYLES = [...WIKI_BUILTIN_STYLES, "custom"] as const;
export type WikiStyle = typeof WIKI_STYLES[number];

export const WIKI_LEGACY_STYLE_MAP = {
  functional: "feature-scout",
  wlog: "socratic-exploration",
  design: "worth-stealing",
} as const satisfies Record<string, WikiStyle>;
export const WIKI_LEGACY_STYLES = Object.keys(WIKI_LEGACY_STYLE_MAP) as Array<keyof typeof WIKI_LEGACY_STYLE_MAP>;
export const WIKI_RECORD_STYLES = [...WIKI_STYLES, ...WIKI_LEGACY_STYLES] as const;

export const WIKI_LANGUAGES = [
  "en",
  "es",
  "pt",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "fr",
  "de",
  "ru",
  "ar",
  "he",
  "id",
  "ms",
] as const;
export type WikiLanguage = typeof WIKI_LANGUAGES[number];

const WIKI_LANGUAGE_LABELS: Record<WikiLanguage, string> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  ja: "Japanese",
  "zh-Hans": "Mandarin 简体",
  "zh-Hant": "Mandarin 繁體",
  ko: "Korean",
  fr: "French",
  de: "German",
  ru: "Russian",
  ar: "Arabic",
  he: "Hebrew",
  id: "Bahasa Indonesia",
  ms: "Bahasa Malaysia",
};

const WIKI_SOURCE_SCAFFOLD: Record<WikiLanguage, { summary: string; intro: string }> = {
  en: {
    summary: "Relevant source files",
    intro: "The following files were used as context for generating this wiki page:",
  },
  es: {
    summary: "Archivos fuente relevantes",
    intro: "Los siguientes archivos se usaron como contexto para generar esta página wiki:",
  },
  pt: {
    summary: "Arquivos-fonte relevantes",
    intro: "Os seguintes arquivos foram usados como contexto para gerar esta página wiki:",
  },
  ja: {
    summary: "関連するソースファイル",
    intro: "このWikiページの生成に使用したファイル:",
  },
  "zh-Hans": {
    summary: "相关源文件",
    intro: "以下文件用于生成此维基页面：",
  },
  "zh-Hant": {
    summary: "相關原始碼檔案",
    intro: "以下檔案用於生成此維基頁面：",
  },
  ko: {
    summary: "관련 소스 파일",
    intro: "이 위키 페이지를 생성하는 데 사용된 파일:",
  },
  fr: {
    summary: "Fichiers sources pertinents",
    intro: "Les fichiers suivants ont servi de contexte pour générer cette page wiki :",
  },
  de: {
    summary: "Relevante Quelldateien",
    intro: "Die folgenden Dateien wurden als Kontext für diese Wiki-Seite verwendet:",
  },
  ru: {
    summary: "Релевантные исходные файлы",
    intro: "Следующие файлы использовались как контекст для создания этой wiki-страницы:",
  },
  ar: {
    summary: "ملفات المصدر ذات الصلة",
    intro: "استُخدمت الملفات التالية كسياق لإنشاء صفحة الويكي هذه:",
  },
  he: {
    summary: "קובצי מקור רלוונטיים",
    intro: "הקבצים הבאים שימשו כהקשר ליצירת דף הוויקי הזה:",
  },
  id: {
    summary: "Berkas sumber relevan",
    intro: "Berkas berikut digunakan sebagai konteks untuk menghasilkan halaman wiki ini:",
  },
  ms: {
    summary: "Fail sumber berkaitan",
    intro: "Fail berikut digunakan sebagai konteks untuk menjana halaman wiki ini:",
  },
};

export function normalizeWikiDepth(value: unknown, fallback: WikiDepth = "deep"): WikiDepth {
  return value === "fast" || value === "regular" || value === "deep" ? value : fallback;
}

export function normalizeWikiPageCount(value: unknown, fallback = 18): number {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  const rounded = Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.max(WIKI_PAGE_COUNT_MIN, Math.min(WIKI_PAGE_COUNT_MAX, rounded));
}

export function normalizeWikiPageCountMode(value: unknown, fallback: WikiPageCountMode = "auto"): WikiPageCountMode {
  return value === "fixed" || value === "auto" ? value : fallback;
}

export function wikiAutoPageCountRange(maxPageCount: number): { min: number; max: number } {
  const max = normalizeWikiPageCount(maxPageCount);
  if (max <= 1) return { min: 1, max };
  if (max <= 6) return { min: Math.min(2, max), max };
  if (max <= 12) return { min: 3, max };
  if (max <= 24) return { min: 6, max };
  return { min: 10, max };
}

export function wikiDepthForPageCount(pageCount: number): WikiDepth {
  if (pageCount <= 12) return "fast";
  if (pageCount <= 24) return "regular";
  return "deep";
}

export function defaultWikiPageCountForDepth(depth: unknown): number {
  const normalized = normalizeWikiDepth(depth, "regular");
  if (normalized === "fast") return 10;
  if (normalized === "deep") return 30;
  return 18;
}

export function normalizeWikiStyle(value: unknown, fallback: WikiStyle = "basic"): WikiStyle {
  const style = typeof value === "string" ? value.trim() : "";
  if ((WIKI_STYLES as readonly string[]).includes(style)) return style as WikiStyle;
  if (style in WIKI_LEGACY_STYLE_MAP) return WIKI_LEGACY_STYLE_MAP[style as keyof typeof WIKI_LEGACY_STYLE_MAP];
  return fallback;
}

export function normalizeWikiStylePrompt(value: unknown, maxChars = 2400): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxChars);
}

export function wikiLanguageLabel(value: unknown): string {
  const language = WIKI_LANGUAGES.find((item) => item === value);
  return language ? WIKI_LANGUAGE_LABELS[language] : WIKI_LANGUAGE_LABELS.en;
}

export function normalizeWikiLanguages(value: unknown): WikiLanguage[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  const selected = raw
    .map((item) => {
      const language = String(item || "").trim();
      return language === "zh" ? "zh-Hans" : language;
    })
    .filter((item): item is WikiLanguage => (WIKI_LANGUAGES as readonly string[]).includes(item));
  return selected.length ? [selected[0]] : ["en"];
}

export function wikiLanguagePrompt(languages: WikiLanguage[]): string {
  const normalized = normalizeWikiLanguages(languages);
  const label = wikiLanguageLabel(normalized[0]);
  return [
    `Write all human-facing wiki content in ${label}.`,
    `This is mandatory: the final generated wiki page must be in ${label}, including the title, descriptions, headings, prose, table labels, diagram labels, summary text, and closing sections.`,
    "English prose is allowed only when it is copied from source code/comments or when it is part of source-accurate identifiers.",
    "Keep code symbols, file paths, API names, package names, citations, XML tag names, and XML ids exactly as source-accurate identifiers.",
  ].join("\n");
}

export function wikiSourceScaffold(languages: WikiLanguage[]): { summary: string; intro: string } {
  const [language] = normalizeWikiLanguages(languages);
  return WIKI_SOURCE_SCAFFOLD[language] || WIKI_SOURCE_SCAFFOLD.en;
}
