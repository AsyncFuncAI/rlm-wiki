export type AskLike = {
  status?: string;
  updatedAt?: string | number;
};

export type AskTurnClarification = {
  question?: string;
  answer?: string;
};

export type AskTurnLike = {
  question?: string;
  answer?: string;
  status?: string;
  updatedAt?: string | number;
  updated_at?: string | number;
  clarifications?: AskTurnClarification[];
};

export type RenderAskTurnsOptions = {
  widget?: boolean;
};

export type AskThreadCopy = {
  workingThroughEvidence: string;
  runIncomplete: string;
  canceled: string;
  copyQuestion: string;
  copyAnswer: string;
  copy: string;
  working: string;
  answeredAt: (time: string) => string;
  answeredLocally: string;
  clarified: (count: number) => string;
  clarifiedExpandHint: string;
};

const DEFAULT_ASK_THREAD_COPY: AskThreadCopy = {
  workingThroughEvidence: "Working through the repository evidence...",
  runIncomplete: "The run did not complete.",
  canceled: "Canceled.",
  copyQuestion: "Copy question",
  copyAnswer: "Copy answer",
  copy: "Copy",
  working: "Working",
  answeredAt: (time) => `Answered at ${time}`,
  answeredLocally: "Answered locally",
  clarified: (count) => `Clarified · ${count}`,
  clarifiedExpandHint: "Show the clarifying questions you answered",
};

export type RenderAskTurnsDeps<TAsk extends AskLike, TTurn extends AskTurnLike> = {
  askTurns: (ask: TAsk) => TTurn[];
  answerPreview: (answer: string) => string;
  copy?: Partial<AskThreadCopy>;
  copyIcon: string;
  escape: (value: string) => string;
  isWorkingAnswer: (answer: string) => boolean;
  processStream: (ask: TAsk, turn: TTurn, options: RenderAskTurnsOptions) => string;
  renderMarkdown: (answer: string, ask: TAsk, stream: { key: string } | null) => string;
  streamKey: (ask: TAsk, turn: TTurn) => string;
  turnStamp: (turn: TTurn, ask: TAsk, index: number) => string;
  // Optional extra hover chips rendered beside the answer copy button on the
  // desktop thread (e.g. "Extract tasks"). Skipped for the floating widget.
  answerActions?: (turn: TTurn, index: number) => string;
};

export function renderAskTurns<TAsk extends AskLike, TTurn extends AskTurnLike>(
  ask: TAsk,
  options: RenderAskTurnsOptions,
  deps: RenderAskTurnsDeps<TAsk, TTurn>,
): string {
  const turns = deps.askTurns(ask);
  const copy = askThreadCopy(deps.copy);
  let lastDoneIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "done" && !!turns[index]?.answer) {
      lastDoneIndex = index;
      break;
    }
  }
  const lastIndex = turns.length - 1;
  return turns
    .map((turn, index) => {
      // Every answered turn renders FULLY EXPANDED. The conversation outline already
      // solves long-thread navigation, so folding earlier answers behind a
      // click-to-expand disclosure (the old behavior) was redundant friction: the
      // user had to keep clicking to read prior answers (ChatGPT shows them all in
      // full). We keep the <details> element for structure but force every turn open.
      const open = true;
      const answer = turn.answer ||
        (turn.status === "running"
          ? copy.workingThroughEvidence
          : turn.status === "error"
          ? copy.runIncomplete
          : turn.status === "canceled"
          ? copy.canceled
          : "");
      const workingAnswer = !turn.answer || deps.isWorkingAnswer(answer);
      const showProcess = turn.status === "running" && workingAnswer;
      const showLiveProcessWithAnswer = turn.status === "running" && !showProcess && !options.widget;
      const stream = turn.status === "running" && !workingAnswer ? { key: deps.streamKey(ask, turn) } : null;
      const question = renderQuestionTurn(turn, index, deps, copy);
      if (showProcess && !options.widget) {
        return `
          ${question}
          <section class="chat-message chat-message-assistant answer-block ask-turn is-process" data-chat-message-from="assistant" data-turn-index="${index}">
            <div class="answer-content">
              ${deps.processStream(ask, turn, options)}
            </div>
          </section>`;
      }
      if (showLiveProcessWithAnswer) {
        return `
          ${question}
          <section class="chat-message chat-message-assistant answer-block ask-turn is-live-answer" data-chat-message-from="assistant" data-turn-index="${index}">
            <div class="answer-content">
              ${deps.processStream(ask, turn, options)}
              ${deps.renderMarkdown(answer, ask, stream)}
            </div>
          </section>`;
      }
      const answerCopyButton = showProcess
        ? ""
        : `<button class="turn-copy-button answer-copy-button" type="button" data-copy-answer data-turn-index="${index}" aria-label="${deps.escape(copy.copyAnswer)}" data-label="${deps.escape(copy.copy)}">${deps.copyIcon}</button>`;
      // The floating widget keeps the compact <details> disclosure (its running
      // state collapses into a single bar). The desktop thread shows every answer in
      // full, so the disclosure summary (timestamp + chevron) and the masked preview
      // were dead chrome hidden by CSS: render .answer-content directly instead. The
      // outer .answer-block.ask-turn[data-turn-index] wrapper and .answer-content stay
      // identical so the targeted live/done patch selectors keep matching.
      if (options.widget) {
        return `
          ${question}
          <section class="chat-message chat-message-assistant answer-block ask-turn" data-chat-message-from="assistant" data-turn-index="${index}">
            <details class="answer-disclosure"${open ? " open" : ""}>
              <summary>${deps.escape(deps.turnStamp(turn, ask, index))}</summary>
              <div class="answer-content">
                ${showProcess ? deps.processStream(ask, turn, options) : ""}
                ${showProcess ? "" : deps.renderMarkdown(answer, ask, stream)}
                ${answerCopyButton}
              </div>
            </details>
            <div class="answer-preview">${deps.answerPreview(turn.answer || "")}</div>
          </section>`;
      }
      return `
          ${question}
          <section class="chat-message chat-message-assistant answer-block ask-turn" data-chat-message-from="assistant" data-turn-index="${index}">
            <div class="answer-content">
              ${showProcess ? deps.processStream(ask, turn, options) : ""}
              ${showProcess ? "" : deps.renderMarkdown(answer, ask, stream)}
              ${showProcess ? "" : deps.answerActions?.(turn, index) || ""}
              ${answerCopyButton}
            </div>
          </section>`;
    })
    .join("");
}

function renderQuestionTurn<TAsk extends AskLike, TTurn extends AskTurnLike>(
  turn: TTurn,
  index: number,
  deps: RenderAskTurnsDeps<TAsk, TTurn>,
  copy: AskThreadCopy,
): string {
  return `
          <section class="chat-message chat-message-user prompt-block user-message ask-turn" data-chat-message-from="user" data-turn-index="${index}">
            <div class="chat-message-inner question-wrap">
              <div class="question-bubble chat-message-bubble">${deps.escape(turn.question || "")}</div>
              <div class="chat-message-meta question-meta-row">
                ${renderClarifiedPill(turn, deps, copy)}
                <button class="turn-copy-button question-copy-button" type="button" data-copy-question data-turn-index="${index}" aria-label="${deps.escape(copy.copyQuestion)}" data-label="${deps.escape(copy.copy)}">${deps.copyIcon}</button>
              </div>
            </div>
          </section>`;
}

// The clarified pill: a quiet marker that THIS turn was preceded by a Clarify
// ("grill me") interview, with the answered Q&A revealed on demand. Native
// <details> so it's keyboard/AT-accessible and needs no JS state. Rendered only
// when there is at least one non-empty clarification.
function renderClarifiedPill<TAsk extends AskLike, TTurn extends AskTurnLike>(
  turn: TTurn,
  deps: RenderAskTurnsDeps<TAsk, TTurn>,
  copy: AskThreadCopy,
): string {
  const items = (turn.clarifications || []).filter(
    (entry) => entry && String(entry.question || "").trim(),
  );
  if (!items.length) return "";
  const rows = items
    .map(
      (entry) => `
              <li class="clarified-row">
                <span class="clarified-q">${deps.escape(String(entry.question || "").trim())}</span>
                <span class="clarified-a">${deps.escape(String(entry.answer || "").trim())}</span>
              </li>`,
    )
    .join("");
  return `<details class="clarified-pill">
                <summary class="clarified-summary" aria-label="${deps.escape(copy.clarifiedExpandHint)}" title="${deps.escape(copy.clarifiedExpandHint)}">
                  <span class="clarified-dot" aria-hidden="true"></span>
                  <span class="clarified-label">${deps.escape(copy.clarified(items.length))}</span>
                </summary>
                <ul class="clarified-list">${rows}</ul>
              </details>`;
}

export function askThreadCopy(copy?: Partial<AskThreadCopy>): AskThreadCopy {
  return {
    ...DEFAULT_ASK_THREAD_COPY,
    ...(copy || {}),
    answeredAt: copy?.answeredAt || DEFAULT_ASK_THREAD_COPY.answeredAt,
  };
}

export type AskOutlineCopy = {
  heading: string;
  ariaLabel: string;
  untitledTurn: (position: number) => string;
};

const DEFAULT_ASK_OUTLINE_COPY: AskOutlineCopy = {
  heading: "Outline",
  ariaLabel: "Conversation outline",
  untitledTurn: (position) => `Question ${position}`,
};

export function askOutlineCopy(copy?: Partial<AskOutlineCopy>): AskOutlineCopy {
  return {
    ...DEFAULT_ASK_OUTLINE_COPY,
    ...(copy || {}),
    untitledTurn: copy?.untitledTurn || DEFAULT_ASK_OUTLINE_COPY.untitledTurn,
  };
}

export function outlineTurnLabel(question: string, max = 80): string {
  const text = String(question || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export type RenderAskOutlineDeps<TAsk extends AskLike, TTurn extends AskTurnLike> = {
  askTurns: (ask: TAsk) => TTurn[];
  escape: (value: string) => string;
  copy?: Partial<AskOutlineCopy>;
  /**
   * Optional trailing control rendered in the heading row (e.g. the distill
   * lightbulb). MUST be state-INVARIANT html: its live state (idle/distilling)
   * is toggled via a class on the persistent node by the shell, NOT by changing
   * this string, so PatchAskOutline's innerHTML diff never destroys the node the
   * user is clicking.
   */
  headingSlot?: string;
};

/**
 * Builds a ChatGPT-style conversation outline: one clickable entry per turn,
 * in order. Each entry carries `data-outline-turn="${index}"` so the shell can
 * scroll to the matching `.ask-turn[data-turn-index="${index}"]` anchor. Returns
 * an empty string for conversations with fewer than two turns (nothing to jump
 * between). The renderer is pure so it can be unit-tested like renderAskTurns.
 */
export function renderAskOutline<TAsk extends AskLike, TTurn extends AskTurnLike>(
  ask: TAsk,
  deps: RenderAskOutlineDeps<TAsk, TTurn>,
): string {
  const turns = deps.askTurns(ask);
  if (turns.length < 2) return "";
  const copy = askOutlineCopy(deps.copy);
  // Reuse the documentation page rail (docs-page-rail): collapsed to a stack of
  // tick marks at the right edge, revealing the full outline popover on hover.
  // This stops the always-on panel from covering the answer text (the user's ask)
  // and keeps the Ask outline visually consistent with the docs reader rail. We
  // keep the Ask-specific hooks the shell depends on: data-ask-outline on the root
  // (PatchAskOutline), and ask-outline-link + data-outline-turn on each row
  // (scrollspy highlight + click-to-scroll).
  const ticks = turns
    .map((turn, index) => {
      const label = outlineTurnLabel(turn.question || "") || copy.untitledTurn(index + 1);
      return `<button type="button" class="docs-page-rail-tick ask-outline-tick" data-outline-turn="${index}" title="${deps.escape(label)}" aria-label="${deps.escape(label)}"></button>`;
    })
    .join("");
  const rows = turns
    .map((turn, index) => {
      const label = outlineTurnLabel(turn.question || "") || copy.untitledTurn(index + 1);
      return `<button type="button" class="docs-page-rail-row ask-outline-link" data-outline-turn="${index}" title="${deps.escape(label)}">
              <span class="ask-outline-row-main"><span class="ask-outline-index">${index + 1}</span><span class="ask-outline-text">${deps.escape(label)}</span></span>
            </button>`;
    })
    .join("");
  const headingSlot = deps.headingSlot || "";
  return `
        <nav class="ask-outline docs-page-rail" aria-label="${deps.escape(copy.ariaLabel)}" data-ask-outline>
          <div class="docs-page-rail-zone">
            <div class="docs-page-rail-ticks ask-outline-ticks">${ticks}</div>
          </div>
          <div class="docs-page-rail-popover ask-outline-popover">
            <div class="docs-page-rail-heading ask-outline-heading-row">
              <span class="ask-outline-heading">${deps.escape(copy.heading)}</span>
              ${headingSlot}
            </div>
            <div class="docs-page-rail-list ask-outline-list">${rows}
            </div>
          </div>
        </nav>`;
}

export function answerTurnStamp<TAsk extends AskLike, TTurn extends AskTurnLike>(
  turn: TTurn,
  ask: TAsk,
  index: number,
  turns: TTurn[],
  copyInput?: Partial<AskThreadCopy>,
): string {
  const copy = askThreadCopy(copyInput);
  if (turn.status === "running" || (ask.status === "running" && index === turns.length - 1)) return copy.working;
  const timestamp = Number(turn.updatedAt || turn.updated_at || ask.updatedAt);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  return date ? copy.answeredAt(date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : copy.answeredLocally;
}

export function answerStamp(ask: AskLike, copyInput?: Partial<AskThreadCopy>): string {
  const copy = askThreadCopy(copyInput);
  if (ask.status === "running") return copy.working;
  const timestamp = Number(ask.updatedAt);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
  return date ? copy.answeredAt(date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : copy.answeredLocally;
}
