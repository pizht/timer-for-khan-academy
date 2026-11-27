/**
 * Centralised Khan Academy adaptation rules.
 *
 * Spec 2.4 requires every site selector to live in one place rather than being
 * scattered through the modules, and the pre-implementation research phase
 * requires that selectors come from real observation rather than guesswork.
 *
 * Every entry below is marked with how it was established:
 *
 *   [OBS] observed in real DOM captured from khanacademy.org with headless
 *         Edge (re-capture it yourself with scripts/capture/ — see AGENTS.md).
 *   [VER] verified by driving the live page over the DevTools Protocol and
 *         comparing behaviour before/after an interaction.
 *   [STD] a platform-standard hook (ARIA role, element semantics) rather than
 *         a site-specific guess, used purely as a defensive fallback.
 *
 * Deliberately avoided:
 *   - hashed CSS class names such as `_7zhre1` / `_xa8e8o1`. Emotion and
 *     styled-components hashes change on every Khan Academy build.
 *   - `[data-testid="content-panel-wrapper"]` as the question region: it
 *     [VER] grows to include the "Related content" sidebar after an answer is
 *     submitted, so its text is not stable across answering.
 *   - the full `exercise-progress-<i>-<state>[-current]` testid as an identity:
 *     the <state> segment [VER] changes from `incomplete` to `incorrect` the
 *     moment an answer is submitted, which would look like a question change.
 */

import type { FirstSubmissionOutcome } from './types.js';

/**
 * The page is read through `readPage` (end of this file), from markers the page
 * maintains itself. The question region used to be fingerprinted instead (stem
 * text, answer-widget shape, hint and feedback subtrees removed); those
 * selectors went with that approach. The facts behind them explain why
 * content was never a usable identity: [VER] opening hints grew the answer
 * form's text from ~3.5 KB to ~23 KB (kept as a regression test in
 * tests/question-detector.test.ts), and [VER] `content-panel-wrapper` grows a
 * "Related content" sidebar after an answer. Neither moves the progress
 * position, which is why the position is the identity.
 */

/** A named selector strategy. The `name` appears in diagnostic output. */
export interface SelectorStrategy {
  /** Stable identifier shown in the popup's diagnostics list. */
  name: string;
  select: (root: ParentNode) => Element | null;
}

const first = (selector: string) => (root: ParentNode): Element | null =>
  root.querySelector(selector);

/** Submit / check-answer control, also used to timestamp the first submission. */
export const SUBMIT_BUTTON: SelectorStrategy[] = [
  // [OBS] The exercise's primary "Check" button.
  { name: 'exercise-check-answer', select: first('[data-testid="exercise-check-answer"]') },
];

/**
 * Has the current question been finished?
 *
 * [VER] Khan Academy REPLACES the Check button with the advance control once a
 * question is done, and this is the only reliable signal for a correct answer
 * on a RETRY.
 *
 * Why the progress state word is not enough: the marker keeps the FIRST
 * attempt's verdict. Observed directly — a question answered wrong and then
 * right stayed `exercise-progress-0-incorrect-current` for the rest of the
 * question, while the buttons swapped to `exercise-next-question`:
 *
 *     after a wrong answer:  check-answer present, next-question ABSENT
 *     after a correct retry: check-answer ABSENT,  next-question present
 *
 * So `completionTriggerFor()` (which reads the state word) handles a first-try
 * correct answer promptly, and this predicate catches the retry case. Both are
 * idempotent: whichever fires first sets the held record, and the other is then
 * a no-op.
 */
export function isQuestionFinished(doc: ParentNode): boolean {
  return (
    doc.querySelector('[data-testid="exercise-next-question"]') !== null &&
    doc.querySelector('[data-testid="exercise-check-answer"]') === null
  );
}

/** Skip control. Advancing this way opens a confirmation dialog [VER]. */
export const SKIP_BUTTON: SelectorStrategy[] = [
  { name: 'exercise-skip-button', select: first('[data-testid="exercise-skip-button"]') },
];

/** Start-over control, which resets the whole exercise. */
export const START_OVER_BUTTON: SelectorStrategy[] = [
  { name: 'start-over-button', select: first('[data-testid="start-over-button"]') },
];

/**
 * Correct / incorrect markers.
 *
 * The primary marker is the *state segment* of the current progress cell
 * (`...-incorrect-current` [VER]), because it is structural, locale-independent
 * and does not depend on hashed class names. The dialog text is a secondary
 * fallback for page types without a progress indicator.
 */
export const CORRECT_INDICATORS: SelectorStrategy[] = [
  { name: 'dialog-correct-text', select: (root) =>
      matchDialogText(root, /there you go|keep it up|nice work|correct/i) },
];

export const INCORRECT_INDICATORS: SelectorStrategy[] = [
  { name: 'dialog-incorrect-text', select: (root) =>
      matchDialogText(root, /not quite|try again|incorrect|not right/i) },
];

function matchDialogText(root: ParentNode, pattern: RegExp): Element | null {
  const dialogs = root.querySelectorAll('[role="dialog"]');
  for (const dialog of Array.from(dialogs)) {
    const text = dialog.textContent ?? '';
    // Skip the cookie-consent dialog, which is also role="dialog" [OBS].
    if (/cookie|privacy|隐私/i.test(text)) continue;
    if (pattern.test(text)) return dialog;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Derived signals
 * ------------------------------------------------------------------ */

export interface ProgressInfo {
  /** Zero-based question position within the exercise. */
  index: number;
  /** Total number of questions, when the page exposes it. */
  total: number | null;
  /** The site's own state word, e.g. "incomplete", "incorrect". */
  state: string;
  /** The raw testid, kept for diagnostics only. */
  raw: string;
}

/**
 * Read the progress marker.
 *
 * [VER] Critically, only the numeric index is used downstream. The state word
 * changes as soon as an answer is submitted, so including it in a question's
 * identity would make every submission look like a new question.
 */
export function readProgress(doc: ParentNode): ProgressInfo | null {
  const cells = Array.from(doc.querySelectorAll('[data-testid^="exercise-progress-"]'));
  if (cells.length === 0) return null;
  // [VER] The total is the number of DISTINCT question indices, not the number
  // of cells: from its second question on, a unit test renders the progress
  // bar TWICE inside `content-library-footer` - once inside a "Show all
  // exercise progress" link and once inside `[data-testid="progress-wrapper"]`,
  // both with a "3 of 10" label and identical cells, `-current` included.
  // Counting cells read "3 of 20" on a 10-question test (question 1 had read
  // "1 of 10"), so one test changed its own identity half-way. Observed live
  // on an Algebra 1 unit test; quizzes (5) and course challenges (30) render
  // one copy.
  const indices = new Set<number>();
  let current: ProgressInfo | null = null;
  for (const cell of cells) {
    const raw = cell.getAttribute('data-testid') ?? '';
    const match = raw.match(/^exercise-progress-(\d+)-(.+?)(-current)?$/);
    if (!match) continue;
    const index = Number(match[1]);
    indices.add(index);
    if (match[3] && current === null) {
      current = { index, total: null, state: match[2] ?? 'unknown', raw };
    }
  }
  if (current === null) return null;
  return { ...current, total: indices.size };
}

/**
 * A locale-independent progress label such as "3 of 7" used as the question's
 * identity, so that two questions with similar stems are still distinguished
 * (spec 12.3).
 */
export function progressLabel(progress: ProgressInfo | null): string | null {
  if (!progress) return null;
  const total = progress.total ?? 0;
  return total > 0 ? `${progress.index + 1} of ${total}` : `#${progress.index + 1}`;
}

/**
 * Stable key for "which exercise/quiz is this", used to group records and to
 * key the resumable session.
 *
 * The URL shape is `/math/<course>/<unit>/<type>/<slug>` where <type> is one of
 * `e` (exercise), `quiz` or `test` [OBS]; a course challenge is
 * `/math/<course>/test/<slug>` [VER].
 *
 * The key is derived from the URL ONLY. The page's `data-exercise-id` is
 * deliberately not used: [VER] on a unit test it names the exercise the
 * CURRENT QUESTION was drawn from (x799738ed, x6a27f53ef2d0c175, x7a036a2f,
 * 3033 on four consecutive questions), and on the end screen of a unit test,
 * course challenge and quiz it changed again. Keyed on it, one test would be
 * split into one "practice" per question and its end-of-test card would find
 * none of them.
 */
export function exerciseKeyFromUrl(rawUrl: string): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    /* keep the raw string */
  }
  const trimmed = pathname.replace(/\/+$/, '');
  const match = trimmed.match(/^(.*\/(?:e|quiz|test)\/[^/]+)/);
  return match?.[1] ?? trimmed;
}

/* ------------------------------------------------------------------ *
 * End-of-exercise summary
 * ------------------------------------------------------------------ */

/**
 * The end-of-exercise summary screen ("Exercise complete! 4/4 correct").
 *
 * [VER] Detection is structural and was checked against every captured stage of
 * a full 4-question run: the summary is the ONLY state in which the question
 * form is gone while the exercise chrome is still present.
 *
 *     stage              answerform  progress  -> summary?
 *     q1..q4 answered    present     4 marks   -> false
 *     show summary       ABSENT      0 marks   -> true
 *
 * This is deliberately NOT keyed on the summary card's own testid, because that
 * testid (`eot-phantom-user-registration`) names the *logged-out* registration
 * prompt and is therefore not expected to exist for a signed-in learner. The
 * structural check holds either way.
 */
export function isSummaryPage(doc: ParentNode): boolean {
  // [VER] The intro card that quiz / unit-test / course-challenge pages show
  // BEFORE the questions looks exactly like the summary from the outside: the
  // exercise chrome is present, but there is no answer form and no progress
  // marker. Observed on all three page types, where a naive check reported
  // "summary" on a page where the learner had not even started. Excluding the
  // card by its own testid keeps the two apart.
  if (doc.querySelector('[data-testid="start-task-card-summary"]')) return false;
  if (doc.querySelector('form[name="answerform"]')) return false;
  if (doc.querySelectorAll('[data-testid^="exercise-progress-"]').length > 0) return false;
  return doc.querySelector('.bibliotron-exercise') !== null;
}

/**
 * The control that begins a quiz / unit test / course challenge.
 *
 * Those page types put an intro card in front of the questions ("Time for a
 * quiz? … 5 questions • 5-10 minutes" / "Ready for a challenge? …") whose button
 * is labelled "Let's go" with a typographic apostrophe [OBS]. Recognised so the
 * extension can tell "not started yet" apart from "nothing to time here".
 */
export function isStartCardPresent(doc: ParentNode): boolean {
  return doc.querySelector('[data-testid="start-task-card-summary"]') !== null;
}

/* ------------------------------------------------------------------ *
 * The whole page, read at once
 * ------------------------------------------------------------------ */

/**
 * Which screen of an exercise / quiz / unit test / course challenge is up.
 *
 *  - `start-card` the intro card in front of the questions ("Let's go")
 *  - `question`   a question is being solved and the page says which one
 *  - `summary`    the end screen after the last question
 *  - `other`      anything else: a page with nothing to time, or one of the
 *                 short in-between frames listed on `readPage`
 */
export type PageScreen = 'start-card' | 'question' | 'summary' | 'other';

/** The question on screen, as the progress bar reports it. */
export interface PageQuestion {
  /** Zero-based position in the set. */
  index: number;
  /** Number of questions in the set. */
  total: number | null;
  /** The progress cell's state word: `incomplete`, `correct`, `incorrect`. */
  state: string;
  /** The page has closed the question: Next is offered, Check is gone. */
  finished: boolean;
}

export interface PageState {
  screen: PageScreen;
  /** Which exercise / quiz / test this is (see `exerciseKeyFromUrl`). */
  exerciseKey: string;
  /** Set exactly when `screen` is `question`. */
  question: PageQuestion | null;
}

/**
 * Everything the timer needs to know about the page, as one small value.
 *
 * Meant to be read again on every change and compared with the previous
 * reading: the differences ARE the events (a new index is a new question, a
 * state word leaving `incomplete` is an answer, `finished` turning true is the
 * question being done, `summary` is the end of the set). No fingerprinting and
 * no settle time are involved, because every input is a discrete marker the
 * page itself maintains.
 *
 * [VER] Walked from start card to end screen, logged out, on a math quiz
 * (5 questions), a biology quiz (5), a math unit test (10) and a math course
 * challenge (30); timed by sampling every 25 ms on Let's go, Next and a reload
 * in the middle of a quiz and a unit test:
 *
 *     start card  start-task-card-summary present, no form, no progress
 *     question    answerform AND an `exercise-progress-*-current` cell; on every
 *                 test page both appeared in the SAME 25 ms sample, and a
 *                 reload mid-test came back straight to the same question
 *     answered    a wrong answer turns the state word to `incorrect` and keeps
 *                 Check (relabelled "Try again"); a confirmed skip ALSO reads
 *                 `incorrect`, but replaces Check with Next
 *     end screen  form and progress gone, exercise chrome still there
 *
 * In-between frames read as `other`, never as a question or the end:
 *   - a form without a progress cell: seen only on an ordinary exercise's first
 *     render, for at most 71 ms before the cell (0 ms in most loads);
 *   - progress cells without a form: on the way into the end screen the form
 *     goes before the cells do (see `isSummaryPage`).
 */
export function readPage(doc: ParentNode, url: string): PageState {
  const exerciseKey = exerciseKeyFromUrl(url);
  if (isStartCardPresent(doc)) return { screen: 'start-card', exerciseKey, question: null };
  if (isSummaryPage(doc)) return { screen: 'summary', exerciseKey, question: null };
  const progress = readProgress(doc);
  if (progress && doc.querySelector('form[name="answerform"]')) {
    return {
      screen: 'question',
      exerciseKey,
      question: {
        index: progress.index,
        total: progress.total,
        state: progress.state,
        finished: isQuestionFinished(doc),
      },
    };
  }
  return { screen: 'other', exerciseKey, question: null };
}

/**
 * Why the current question stopped being timed, or null if it should keep
 * running.
 *
 * Requirement 1 and 2 live here, in one testable place:
 *   - the page graded the answer CORRECT      -> the learner is done: stop
 *   - the page left "incomplete" after a Skip -> the skip was confirmed: stop
 *   - the page left "incomplete" any other way (a wrong answer) -> keep timing,
 *     because the learner is allowed to try again
 *
 * @param state          the progress state word now, e.g. "correct"
 * @param previous       the state word before, e.g. "incomplete"
 * @param skipInitiated  the Skip control was clicked and not cancelled
 */
export function completionTriggerFor(
  state: string,
  previous: string | null,
  skipInitiated: boolean,
): 'answered-correct' | 'skipped' | null {
  // Nothing moved: this is not a completion, whatever the flags say. The
  // detector only reports genuine transitions, but the guard keeps this rule
  // correct on its own terms.
  if (state === previous) return null;
  if (state === 'correct') return 'answered-correct';
  if (skipInitiated && previous === 'incomplete') return 'skipped';
  return null;
}

/**
 * Should the summary view be torn down?
 *
 * Leaving requires a POSITIVE signal, never merely the absence of the summary
 * marker. The transition INTO the summary is not atomic (the answer form is
 * removed before the progress markers are), and Khan Academy re-renders parts of
 * the summary while it is up. Treating any non-summary frame as "the learner
 * left" destroyed the injected card and cleared the run — and because that also
 * reset the "a question has been timed" latch, the card was then never
 * re-injected. Observed live as the summary card intermittently going missing.
 *
 * So: leave only when a question is genuinely on screen again (the learner
 * started another attempt) or the page moved somewhere else entirely.
 */
export function shouldLeaveSummary(input: {
  onSummary: boolean;
  questionFormPresent: boolean;
  urlChanged: boolean;
  /**
   * The exercise's intro card is on screen ("Ready to practice?"). It is a
   * POSITIVE signal that the learner is not looking at a summary any more, so
   * the card has to go even though no question is on screen yet - otherwise a
   * card injected a moment early would sit on top of the intro screen forever
   * (observed on a real page: the card stayed above "Ready to practice?").
   */
  startCardPresent?: boolean;
}): boolean {
  if (input.onSummary) return false;
  return input.questionFormPresent || input.urlChanged || input.startCardPresent === true;
}

/**
 * Where to put the per-question timing card on the summary screen.
 *
 * `insert` says how to place the card relative to the host:
 *   'before-host' — immediately before the host, as its sibling. Used with the
 *                   exercise footer, which is the last thing in the content
 *                   column: the card therefore lands in normal flow BELOW every
 *                   piece of the page's own summary content and pushes the
 *                   footer down instead of covering it.
 *   'append'      — at the end of the host. The structural fallbacks.
 */
export interface SummaryHostStrategy extends SelectorStrategy {
  insert: 'before-host' | 'append';
}

export const SUMMARY_HOST: SummaryHostStrategy[] = [
  {
    // [OBS][MEASURED] Inserted BEFORE the exercise chrome's content area.
    //
    // This placement was chosen by measurement, not by reading class names.
    // The summary screen is a fixed-height app layout: the exercise chrome is
    // built from zero-height flex items whose content is absolutely positioned,
    // so almost every in-flow position paints over the results. Each candidate
    // was injected with a card-sized probe and the overlap with the exercise
    // panel's OWN text was counted:
    //
    //   before exercise-chrome-content      0 overlaps   (visible, y 503..713)
    //   append to exercise-chrome-content   0 overlaps   (below the fold)
    //   append to .bibliotron-exercise     10 overlaps
    //   append to content-panel-wrapper     9 overlaps
    //   before content-library-footer      12 overlaps
    //   after  content-panel-wrapper        9 overlaps
    //
    // The primary therefore shows none of the page's result information being
    // covered, AND lands inside the viewport so no scrolling is needed.
    // (The chrome's own content is pushed down inside its scrollable area.)
    name: 'before-exercise-chrome-content',
    select: first('[class*="exercise-chrome-content"]'),
    insert: 'before-host',
  },
  {
    // Fallback for a layout where the content area exists but is not a suitable
    // anchor: the end of that same scrollable area. Measured 0 overlaps too,
    // but sits below the fold.
    name: 'append-exercise-chrome-content',
    select: first('[class*="exercise-chrome-content"]'),
    insert: 'append',
  },
  {
    name: 'bibliotron-exercise',
    select: first('.bibliotron-exercise'),
    insert: 'append',
  },
  {
    name: 'content-panel-wrapper',
    select: first('[data-testid="content-panel-wrapper"]'),
    insert: 'append',
  },
];

/**
 * Decide the outcome of the learner's first submission.
 *
 * Prefers the structural progress state [VER]; falls back to the feedback
 * dialog's wording.
 */
export function readSubmissionOutcome(doc: ParentNode): FirstSubmissionOutcome {
  const progress = readProgress(doc);
  if (progress) {
    if (/incorrect/i.test(progress.state)) return 'incorrect';
    if (/correct/i.test(progress.state)) return 'correct';
  }
  return 'unknown';
}
