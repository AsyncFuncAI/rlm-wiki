import type { LocalCliConfig } from "./local-cli-events.ts";
import { LocalCliAgent } from "./local-cli-runtime.ts";
import { extractDecision } from "./local-cli-parsers.ts";

// Tasks-board extraction brain: turn a cooled Ask answer into a clean list of
// actionable backlog items. Mirrors the wiki/ask interview pipeline
// (LocalCliAgent chat query -> fenced-JSON decision -> normalize); the desktop
// falls back to its structured markdown parse when this returns nothing.
export interface ExtractedTask {
  title: string;
  brief: string;
}

// Grouped output: the answer is split into a few epics, each holding its related
// granular sub-tasks. A single-theme answer yields one epic; a sprawling
// "10 ways to improve X" answer yields several epics by theme.
export interface ExtractedEpic {
  title: string;
  summary: string;
  tasks: ExtractedTask[];
}

export const TASK_EXTRACT_MAX_TASKS = 12;
export const TASK_EXTRACT_MAX_EPICS = 5;
export const TASK_EXTRACT_MAX_TASKS_PER_EPIC = 8;
export const TASK_EXTRACT_TIMEOUT_MS = Math.max(
  5_000,
  Number(
    process.env.RLM_WIKI_TASK_EXTRACT_TIMEOUT_MS ||
      process.env.RLM_WIKI_ROUTE_TIMEOUT_MS ||
      45_000,
  ),
);

export function buildTaskExtractPrompt(answer: string, question: string | null): string {
  return [
    "You are the task-extraction brain for rlm-wiki's Tasks board (a kanban backlog).",
    "Below is an assistant answer from a conversation about a code repository. Distill it into a",
    `clean list of 1 to ${TASK_EXTRACT_MAX_TASKS} actionable engineering tasks.`,
    "Rules:",
    "- Each task is one unit of work someone could pick up and execute. Merge fragments of the same",
    "  piece of work; drop prose, explanations, status-column names, headings, and anything that is",
    "  not actual work to do. Fewer well-formed tasks beat many noisy ones.",
    "- title: imperative and specific, under 90 characters, plain text (no markdown).",
    "- brief: short markdown that a product manager can scan in seconds AND a coding agent can",
    "  execute without reading this conversation. Format, in this order:",
    "  1. One plain-language sentence stating the outcome (what is true once this is done).",
    "  2. 2 to 5 bullet points (lines starting with '- '), one concrete step or requirement each,",
    "     kept short. Keep the file paths, function names, commands, and constraints the answer",
    "     mentions, wrapped in backticks.",
    "  3. When the answer implies an acceptance criterion, end with a final bullet starting",
    "     with 'Done when:'.",
    "- Preserve the answer's own ordering and priorities. Do NOT invent work the answer does not describe.",
    "",
    question ? `The user's question was: ${question}` : "",
    "Assistant answer:",
    "----",
    answer,
    "----",
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "tasks": [',
    "    {",
    '      "title": "short imperative title",',
    '      "brief": "One-sentence outcome.\\n- concrete step referencing `path/to/file.ts`\\n- another concrete step\\n- Done when: observable criterion"',
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

function coerceTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeTaskExtract(parsed: unknown): ExtractedTask[] {
  const raw =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).tasks
      : parsed;
  if (!Array.isArray(raw)) return [];
  const out: ExtractedTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const task = entry as Record<string, unknown>;
    const title = coerceTrimmedString(task.title).slice(0, 120);
    if (!title) continue;
    const brief = coerceTrimmedString(task.brief) || title;
    out.push({ title, brief });
    if (out.length >= TASK_EXTRACT_MAX_TASKS) break;
  }
  return out;
}

// Epic-grouped prompt: group the answer's work into a FEW epics by theme, each
// with its granular sub-tasks. One epic for a single coherent feature; several
// when the answer spans distinct areas (e.g. "10 ways to improve the codebase").
export function buildEpicExtractPrompt(answer: string, question: string | null): string {
  return [
    "You are a senior product manager turning an engineering discussion into a clean backlog of",
    "EPICS and the implementation tasks inside them. You read the answer below and decide, with",
    "judgment, what real work it actually proposes.",
    "",
    "THINK FIRST (do not output this): What is the answer genuinely recommending be BUILT or CHANGED?",
    "What are the distinct themes? An item is a real task only if an engineer could open the repo and",
    "DO it. Everything else is context, not a task.",
    "",
    "HARD RULES — what is NOT a task (exclude these entirely):",
    "- Descriptions, explanations, background, tradeoffs, or 'here is how X works today'.",
    "- Enumerations of existing things: status names, column names, states, options, config values,",
    "  list items that merely NAME something rather than ask for work (e.g. 'Backlog', 'Done',",
    "  'In progress', 'Code Anything (disabled)'). These are NEVER tasks.",
    "- Headings, section titles, the user's question restated, or meta commentary.",
    "- Anything phrased as a fact or observation rather than an action to take.",
    "If you are unsure whether a line is a real task, LEAVE IT OUT. A short list of real work beats a",
    "long list padded with non-tasks. It is acceptable to return very few tasks, or even refuse a line.",
    "",
    "GROUPING INTO EPICS:",
    `- Split the work into 1 to ${TASK_EXTRACT_MAX_EPICS} epics BY THEME. If the answer covers several`,
    "  distinct areas, you MUST return several epics, one per coherent theme — do not lump unrelated",
    "  work together. If it is genuinely one feature, return one epic.",
    "- An epic is a GROUP of related tasks. If a theme has only ONE task, it is NOT an epic — return that",
    "  epic with its single task and the system will surface it as a standalone task. Do NOT invent extra",
    "  sub-tasks just to justify an epic; only group work the answer actually describes.",
    "- An epic.title is a descriptive feature/theme name in the PRODUCT's own terms",
    "  (e.g. 'Per-turn Ask regenerate', 'Local CLI task runner', 'KB distill caching').",
    "- NEVER use the user's question as an epic title. NEVER include slash-commands, 'What are...',",
    "  or question phrasing in a title. Name the deliverable, not the prompt.",
    `- Each epic holds 1 to ${TASK_EXTRACT_MAX_TASKS_PER_EPIC} substantial sub-tasks; merge fragments`,
    "  of the same work into one task rather than splitting hairs.",
    "",
    "FIELD RULES:",
    "- task.title: imperative and specific ('Add X', 'Wire Y to Z'), under 90 chars, plain text.",
    "- task.brief: short markdown a PM can scan AND an agent can execute without this conversation —",
    "  one outcome sentence, then 2-5 '- ' bullets with concrete steps (keep file paths / functions /",
    "  commands in backticks), optionally a final '- Done when:' acceptance bullet. The brief must add",
    "  real implementation detail beyond the title; if you can only restate the title, it is not a task.",
    "- Do NOT invent work the answer does not describe.",
    "",
    "GOOD vs BAD examples:",
    '- BAD task: { "title": "Done", "brief": "Done" }  (names a status, not work)',
    '- BAD task: { "title": "Backlog (extracted or manually created)", "brief": "Backlog ..." }  (a column name)',
    '- BAD epic title: "/ce-ideate What are the highest-leverage improvements"  (echoes the question)',
    '- GOOD epic: title "Tasks board execution", with tasks like',
    '    { "title": "Run tasks as headless local-CLI agents", "brief": "Tasks run detached...\\n- spawn via `agent_headless_open`\\n- Done when: card flips to Done on exit 0" }',
    "",
    question ? `For context, the user's question was: ${question} (DO NOT use this as a title).` : "",
    "Assistant answer to extract from:",
    "----",
    answer,
    "----",
    "",
    "Output ONLY a single fenced JSON block, nothing else, exactly in this shape:",
    "```json",
    "{",
    '  "epics": [',
    "    {",
    '      "title": "Descriptive theme name (never the question)",',
    '      "summary": "one-sentence deliverable",',
    '      "tasks": [',
    '        { "title": "imperative task title", "brief": "Outcome.\\n- concrete step referencing `path/to/file.ts`\\n- Done when: criterion" }',
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
}

export function normalizeEpicExtract(parsed: unknown): ExtractedEpic[] {
  const raw =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).epics
      : parsed;
  if (!Array.isArray(raw)) return [];
  const out: ExtractedEpic[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const epic = entry as Record<string, unknown>;
    const title = coerceTrimmedString(epic.title).slice(0, 120);
    const tasks = normalizeTaskExtract(epic.tasks).slice(0, TASK_EXTRACT_MAX_TASKS_PER_EPIC);
    if (!title || !tasks.length) continue;
    out.push({
      title,
      summary: coerceTrimmedString(epic.summary),
      tasks,
    });
    if (out.length >= TASK_EXTRACT_MAX_EPICS) break;
  }
  return out;
}

export interface TaskExtractRunner {
  (prompt: string, localCli: LocalCliConfig, signal?: AbortSignal): Promise<string>;
}

async function defaultTaskExtractRunner(
  prompt: string,
  localCli: LocalCliConfig,
  signal?: AbortSignal,
): Promise<string> {
  const agent = new LocalCliAgent({
    mode: "chat",
    contextLabel: "chat",
    localCli,
  });
  const result = await agent.query(prompt, signal);
  return result.rawText ?? result.answer ?? "";
}

export async function runTaskExtract(
  answer: string,
  question: string | null,
  localCli: LocalCliConfig,
  runner: TaskExtractRunner = defaultTaskExtractRunner,
  timeoutMs: number = TASK_EXTRACT_TIMEOUT_MS,
): Promise<ExtractedTask[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("task-extract timeout"), timeoutMs);
  try {
    const rawText = await runner(buildTaskExtractPrompt(answer, question), localCli, controller.signal);
    return normalizeTaskExtract(extractDecision(rawText));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function runEpicExtract(
  answer: string,
  question: string | null,
  localCli: LocalCliConfig,
  runner: TaskExtractRunner = defaultTaskExtractRunner,
  timeoutMs: number = TASK_EXTRACT_TIMEOUT_MS,
): Promise<ExtractedEpic[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("epic-extract timeout"), timeoutMs);
  try {
    const rawText = await runner(buildEpicExtractPrompt(answer, question), localCli, controller.signal);
    return normalizeEpicExtract(extractDecision(rawText));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
