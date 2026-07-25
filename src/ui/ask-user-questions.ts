// Vanilla (non-React) port of the Fluid AskUserQuestions component, rendered as
// HTML strings to match the rest of the monochrome desktop app. The render
// function is PURE: it takes the interview state + a small deps surface (escape
// + icon + copy) and returns markup. All interactivity is wired by the host
// (desktop-runtime.ts) via delegated [data-ask-*] click/input handlers.

export type AskUserOption = {
  id: string;
  title: string;
  description?: string;
};

export type AskUserQuestion = {
  id: string;
  title: string;
  options: AskUserOption[]; // 2-5
  multiSelect?: boolean; // default false
  allowOther?: boolean; // default false
  otherPlaceholder?: string; // default "Describe in your own words…"
  skippable?: boolean; // default true
  nextLabel?: string;
  layout?: "inline" | "stacked";
  chipPosition?: "left" | "right"; // default "right"
};

export type AskUserAnswer = {
  questionId: string;
  selectedIds: string[];
  otherText: string;
  skipped: boolean;
};

export type AskUserInterview = {
  questions: AskUserQuestion[];
  answers: Record<string, AskUserAnswer>;
  currentIndex: number;
};

export type AskQuestionsCopy = {
  stepLabel: (current: number, total: number) => string;
  next: string;
  skip: string;
  skipAll: string;
  otherDefaultPlaceholder: string;
};

export const DEFAULT_ASK_QUESTIONS_COPY: AskQuestionsCopy = {
  stepLabel: (current, total) => `Question ${current} of ${total}`,
  next: "Next",
  skip: "Skip",
  skipAll: "Skip all and generate now",
  otherDefaultPlaceholder: "Describe in your own words…",
};

export type AskUserQuestionsDeps = {
  escape: (value: string) => string;
  icon: (name: string, className?: string) => string;
  copy?: AskQuestionsCopy;
};

const OTHER_OPTION_ID = "__other__";

export function emptyAskUserAnswer(questionId: string): AskUserAnswer {
  return { questionId, selectedIds: [], otherText: "", skipped: false };
}

// Pure render: a focused single-moment interview card. One question at a time,
// stepped "Question X of N", bold title, option rows = bold label + muted
// description + a right-aligned number chip. allowOther adds a final inline
// textarea. Single-select submits on click; multi-select shows an explicit Next.
export function renderAskUserQuestions(
  interview: AskUserInterview | null | undefined,
  deps: AskUserQuestionsDeps,
): string {
  if (!interview || !Array.isArray(interview.questions) || !interview.questions.length) return "";
  const copy = deps.copy || DEFAULT_ASK_QUESTIONS_COPY;
  const total = interview.questions.length;
  const index = Math.max(0, Math.min(total - 1, interview.currentIndex || 0));
  const q = interview.questions[index];
  if (!q) return "";
  const multi = q.multiSelect === true;
  const skippable = q.skippable !== false; // default true
  const allowOther = q.allowOther === true;
  const chipPos = q.chipPosition === "left" ? "left" : "right";
  const layout = q.layout === "stacked" ? "stacked" : "inline";
  const ans = interview.answers[q.id] || emptyAskUserAnswer(q.id);
  const selected = new Set(ans.selectedIds || []);
  const otherSelected = selected.has(OTHER_OPTION_ID) || !!String(ans.otherText || "").trim();
  const hasOtherText = !!String(ans.otherText || "").trim();
  return `
    <div class="wiki-ask-card ${hasOtherText ? "has-other-text" : ""}" data-wiki-ask-card data-ask-question-id="${deps.escape(q.id)}" data-ask-multi="${multi ? "1" : "0"}" data-ask-index="${index}">
      <div class="wiki-ask-head">
        <span class="wiki-ask-step">${deps.escape(copy.stepLabel(index + 1, total))}</span>
        ${skippable ? `<button type="button" class="wiki-ask-skipall" data-ask-skip-all>${deps.escape(copy.skipAll)}</button>` : ""}
      </div>
      <h3 class="wiki-ask-title">${deps.escape(q.title)}</h3>
      <div class="wiki-ask-options chip-${chipPos} layout-${layout}">
        ${q.options
          .map((opt, i) => {
            const on = selected.has(opt.id);
            return `<button type="button" class="wiki-ask-option ${on ? "is-selected" : ""}" data-ask-option="${deps.escape(opt.id)}" aria-pressed="${on}">
            <span class="wiki-ask-chip">${i + 1}</span>
            <span class="wiki-ask-option-main"><strong>${deps.escape(opt.title)}</strong>${opt.description ? `<small>${deps.escape(opt.description)}</small>` : ""}</span>
          </button>`;
          })
          .join("")}
        ${
          allowOther
            ? `<label class="wiki-ask-other ${otherSelected ? "is-selected" : ""}">
          <span class="wiki-ask-chip">${q.options.length + 1}</span>
          <textarea id="wiki-ask-other-input" rows="2" placeholder="${deps.escape(q.otherPlaceholder || copy.otherDefaultPlaceholder)}">${deps.escape(ans.otherText || "")}</textarea>
        </label>`
            : ""
        }
      </div>
      <div class="wiki-ask-foot">
        ${skippable ? `<button type="button" class="wiki-ask-skip" data-ask-skip><span>${deps.escape(copy.skip)}</span>${deps.icon("arrowRight")}</button>` : "<span></span>"}
        ${
          // Next is always shown for multi-select. For single-select with free-text,
          // the button is rendered but gated (CSS hides it until the card has the
          // .has-other-text class, toggled live by the input handler without a
          // re-render so the textarea keeps focus). Without this, a typed free-text
          // answer is a dead-end (only Skip), which discards the user's text.
          multi
            ? `<button type="button" class="wiki-ask-next" data-ask-next><span>${deps.escape(q.nextLabel || copy.next)}</span>${deps.icon("arrowRight")}</button>`
            : allowOther
              ? `<button type="button" class="wiki-ask-next wiki-ask-next-other" data-ask-next><span>${deps.escape(q.nextLabel || copy.next)}</span>${deps.icon("arrowRight")}</button>`
              : ""
        }
      </div>
    </div>
  `;
}
