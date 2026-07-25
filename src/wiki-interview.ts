import type { LocalCliConfig } from "./local-cli-events.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import { extractDecision } from "./local-cli-parsers.ts";
import type { CodeScreenshotAttachment } from "./vision.ts";

export interface AskUserOption {
  id: string;
  title: string;
  description?: string;
}
export interface AskUserQuestion {
  id: string;
  title: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  skippable?: boolean;
  otherPlaceholder?: string;
  nextLabel?: string;
}

export const WIKI_INTERVIEW_MAX_QUESTIONS = 3;
export const WIKI_INTERVIEW_TIMEOUT_MS = Math.max(
  5_000,
  Number(
    process.env.GROK_WIKI_INTERVIEW_TIMEOUT_MS ||
      process.env.GROK_WIKI_ROUTE_TIMEOUT_MS ||
      process.env.RLM_WIKI_ROUTE_TIMEOUT_MS ||
      30_000,
  ),
);

export function buildWikiInterviewPrompt(intent: string, source: string | null): string {
  return [
    "You are the interview brain for Grok-Wiki, a tool that generates explanatory wikis for code repositories.",
    "The user has described, in their own words, the wiki they want generated.",
    `Produce 2 to ${WIKI_INTERVIEW_MAX_QUESTIONS} SHORT clarifying questions that lock the user's intent to`,
    "crystal clarity BEFORE generation begins. Each question must materially change how the wiki is",
    "written: its scope, target audience, depth, focus areas, or format/tone. Do NOT ask about things the",
    "agent can decide on its own (page count, languages). Keep every question title under 90 characters.",
    "Provide 2 to 4 concrete options per question, each with a bold leading label and a one-line description.",
    "Make every question skippable. On at least the last question, allow a free-text 'other' answer.",
    "",
    source ? `Repository / source under discussion: ${source}` : "No repository was provided yet.",
    `User intent: ${intent}`,
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "questions": [',
    "    {",
    '      "id": "scope",',
    '      "title": "short clarifying question",',
    '      "multiSelect": false,',
    '      "allowOther": true,',
    '      "skippable": true,',
    '      "options": [',
    '        { "id": "opt1", "title": "Bold label", "description": "one line" },',
    '        { "id": "opt2", "title": "Bold label", "description": "one line" }',
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

export function normalizeWikiInterview(parsed: unknown): AskUserQuestion[] {
  const raw =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).questions
      : parsed;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestion[] = [];
  for (const [qi, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const q = entry as Record<string, unknown>;
    const title = coerceNullableString(q.title);
    const optsRaw = Array.isArray(q.options) ? q.options : [];
    const options = optsRaw
      .map((o, oi): AskUserOption | null => {
        if (!o || typeof o !== "object" || Array.isArray(o)) return null;
        const oo = o as Record<string, unknown>;
        const ot = coerceNullableString(oo.title);
        if (!ot) return null;
        const description = coerceNullableString(oo.description);
        return {
          id: coerceNullableString(oo.id) || `opt-${qi}-${oi}`,
          title: ot,
          ...(description ? { description } : {}),
        };
      })
      .filter((o): o is AskUserOption => o !== null)
      .slice(0, 5);
    if (!title || options.length < 2) continue;
    const otherPlaceholder = coerceNullableString(q.otherPlaceholder);
    const nextLabel = coerceNullableString(q.nextLabel);
    out.push({
      id: coerceNullableString(q.id) || `q-${qi}`,
      title,
      options,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther !== false,
      skippable: q.skippable !== false,
      ...(otherPlaceholder ? { otherPlaceholder } : {}),
      ...(nextLabel ? { nextLabel } : {}),
    });
    if (out.length >= WIKI_INTERVIEW_MAX_QUESTIONS) break;
  }
  return out;
}

export interface WikiInterviewRunner {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal, screenshots?: CodeScreenshotAttachment[]): Promise<string>;
}

async function defaultWikiInterviewRunner(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
  screenshots?: CodeScreenshotAttachment[],
): Promise<string> {
  const agent = new LocalCliAgent({
    mode: "chat",
    contextLabel: "chat",
    localCli,
    ...(screenshots?.length ? { screenshots } : {}),
  });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

export async function runWikiInterview(
  intent: string,
  source: string | null,
  localCli: LocalCliConfig,
  runner: WikiInterviewRunner = defaultWikiInterviewRunner,
  timeoutMs: number = WIKI_INTERVIEW_TIMEOUT_MS,
): Promise<AskUserQuestion[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("wiki-interview timeout"), timeoutMs);
  try {
    const rawText = await runner(buildWikiInterviewPrompt(intent, source), localCli, controller.signal);
    return normalizeWikiInterview(extractDecision(rawText));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Ask-flavored interview: clarifies what the user wants to UNDERSTAND about the
// repo before the ask is sent to the agent. Reuses the same question shape +
// normalizer + runner as the wiki interview (only the prompt differs).
export function buildAskInterviewPrompt(question: string, source: string | null): string {
  return [
    "You are the interview brain for Grok-Wiki's Ask, a tool that answers questions about code repositories.",
    "The user has typed a question they want answered about the repository.",
    `Produce 2 to ${WIKI_INTERVIEW_MAX_QUESTIONS} SHORT clarifying questions that sharpen the user's intent to`,
    "crystal clarity BEFORE the question is sent to the answering agent. Each question must materially change",
    "the answer: which subsystem/files to focus on, the desired depth (overview vs deep trace), the audience,",
    "or what specifically they are trying to do or decide. Do NOT ask about output format or runtime settings.",
    "Keep every question title under 90 characters.",
    "Provide 2 to 4 concrete options per question. Each option label is a SHORT plain",
    "noun phrase (no markdown, no bold) that reads as the user's own answer, plus a one-line description.",
    "Make every question skippable. On at least the last question, allow a free-text 'other' answer.",
    "",
    source ? `Repository / source under discussion: ${source}` : "No repository was provided yet.",
    `User question: ${question}`,
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "questions": [',
    "    {",
    '      "id": "focus",',
    '      "title": "short clarifying question",',
    '      "multiSelect": false,',
    '      "allowOther": true,',
    '      "skippable": true,',
    '      "options": [',
    '        { "id": "opt1", "title": "the auth flow", "description": "one line" },',
    '        { "id": "opt2", "title": "the data layer", "description": "one line" }',
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

export async function runAskInterview(
  question: string,
  source: string | null,
  localCli: LocalCliConfig,
  runner: WikiInterviewRunner = defaultWikiInterviewRunner,
  timeoutMs: number = WIKI_INTERVIEW_TIMEOUT_MS,
  screenshots?: CodeScreenshotAttachment[],
): Promise<AskUserQuestion[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("ask-interview timeout"), timeoutMs);
  try {
    const rawText = await runner(buildAskInterviewPrompt(question, source), localCli, controller.signal, screenshots);
    return normalizeWikiInterview(extractDecision(rawText));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
