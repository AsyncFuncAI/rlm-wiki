export type AskHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

const ASK_HISTORY_MAX_MESSAGES = 4;
const ASK_HISTORY_USER_CHARS = 900;
const ASK_HISTORY_ASSISTANT_CHARS = 1400;

export function compactAskHistory(
  history: Array<{ role?: string; content?: string }> = [],
): AskHistoryMessage[] {
  return history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: compactHistoryContent(message.content || "", message.role as "user" | "assistant"),
    }))
    .filter((message) => message.content)
    .slice(-ASK_HISTORY_MAX_MESSAGES);
}

export function renderAskHistoryBlock(
  history: Array<{ role?: string; content?: string }> = [],
): string {
  const compact = compactAskHistory(history);
  if (!compact.length) return "";
  return `## Conversation history
${compact
  .map((message) => `**${message.role === "user" ? "User" : "Assistant"}:** ${message.content}`)
  .join("\n\n")}

`;
}

function compactHistoryContent(content: string, role: "user" | "assistant"): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!normalized) return "";
  const limit = role === "assistant" ? ASK_HISTORY_ASSISTANT_CHARS : ASK_HISTORY_USER_CHARS;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}\n[truncated ${normalized.length - limit} chars]`;
}
