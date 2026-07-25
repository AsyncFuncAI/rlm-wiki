export type PublicAgentPromptInput = {
  artifactLabel?: "wiki" | "docs" | string | null;
  title: string;
  description?: string | null;
  pageUrl: string;
  llmsUrl: string;
  llmsFullUrl: string;
  markdownUrl?: string | null;
  repository?: string | null;
  repoUrl?: string | null;
  branch?: string | null;
  pageCount?: number | null;
  generatedAt?: string | null;
  updatedAt?: string | null;
};

export function publicAgentPrompt(input: PublicAgentPromptInput): string {
  const artifact = normalizeArtifactLabel(input.artifactLabel);
  const titleLabel = artifact === "docs" ? "Docs" : "Wiki";
  const contextSubject = artifact === "docs" ? "these rlm-wiki docs" : "this rlm-wiki wiki";
  const treatSubject = artifact === "docs" ? "these docs" : "this wiki";
  const pageLabel = artifact === "docs" ? "docs page" : "wiki page";
  const wholeContext = artifact === "docs" ? "whole-docs context" : "whole-wiki context";
  const lines = [
    `Use ${contextSubject} as source-grounded context for the task in this chat.`,
    "",
    `${titleLabel}: ${lineValue(input.title, artifact === "docs" ? "Untitled Docs" : "Untitled rlm-wiki")}`,
    input.description ? `Summary: ${lineValue(input.description)}` : "",
    `Human page: ${lineValue(input.pageUrl)}`,
    `Agent index (read first): ${lineValue(input.llmsUrl)}`,
    `Full Markdown (fetch only if needed): ${lineValue(input.llmsFullUrl)}`,
    input.markdownUrl ? `Markdown alias: ${lineValue(input.markdownUrl)}` : "",
    input.repoUrl
      ? `Repository: ${lineValue(input.repository || input.repoUrl)} (${lineValue(input.repoUrl)})`
      : input.repository
      ? `Repository: ${lineValue(input.repository)}`
      : "",
    input.branch ? `Branch: ${lineValue(input.branch)}` : "",
    typeof input.pageCount === "number" && Number.isFinite(input.pageCount) ? `Pages: ${input.pageCount}` : "",
    input.updatedAt || input.generatedAt ? `Snapshot: ${lineValue(input.updatedAt || input.generatedAt)}` : "",
    "",
    "Instructions:",
    "1. Start with the agent index. It is the compact map of pages, source files, and per-page Markdown links.",
    `2. Fetch the smallest relevant page from the index before loading the full Markdown. Use the full Markdown only when the task needs ${wholeContext}.`,
    `3. Treat ${treatSubject} as a read-only generated snapshot. Prefer source-grounded claims, cite the ${pageLabel} or source file you used, and inspect the live repository when code changes or freshness matter.`,
    "4. Keep provider-specific assumptions out of your plan. Use whatever fetch, browser, file, and shell tools your agent environment provides.",
    "5. After reading the relevant context, summarize what you will rely on and then proceed with my task.",
  ];
  return lines.filter(Boolean).join("\n");
}

function normalizeArtifactLabel(value: unknown): "wiki" | "docs" {
  return String(value || "").trim().toLowerCase() === "docs" ? "docs" : "wiki";
}

function lineValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

export type PublicAskAgentPromptInput = {
  title: string;
  description?: string | null;
  pageUrl: string;
  llmsUrl: string;
  llmsFullUrl: string;
  repoName?: string | null;
  turnCount?: number | null;
  updatedAt?: string | null;
};

export function publicAskAgentPrompt(input: PublicAskAgentPromptInput): string {
  const lines = [
    "Use this shared rlm-wiki Ask conversation as source-grounded context for the task in this chat.",
    "",
    `Conversation: ${lineValue(input.title, "Shared Ask conversation")}`,
    input.description ? `First question: ${lineValue(input.description)}` : "",
    `Human page: ${lineValue(input.pageUrl)}`,
    `Agent index (read first): ${lineValue(input.llmsUrl)}`,
    `Full Markdown transcript (fetch only if needed): ${lineValue(input.llmsFullUrl)}`,
    input.repoName ? `Repository scope: ${lineValue(input.repoName)}` : "",
    typeof input.turnCount === "number" && Number.isFinite(input.turnCount) ? `Turns: ${input.turnCount}` : "",
    input.updatedAt ? `Snapshot: ${lineValue(input.updatedAt)}` : "",
    "",
    "Instructions:",
    "1. Start with the agent index. It lists every question in the conversation with links.",
    "2. Fetch the full Markdown transcript when you need the complete answers.",
    "3. Treat the transcript as a read-only snapshot of a past Q&A session. Cite the question you relied on, and verify against the live repository when code changes or freshness matter.",
    "4. Keep provider-specific assumptions out of your plan. Use whatever fetch, browser, file, and shell tools your agent environment provides.",
    "5. After reading the relevant context, summarize what you will rely on and then proceed with my task.",
  ];
  return lines.filter(Boolean).join("\n");
}
