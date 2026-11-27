/**
 * The timing flow: every decision about WHEN to start, stop, freeze, record and
 * summarise, as one pure function.
 *
 *     step(state, input) -> { state, effects }
 *
 * Inputs are what happened: a new reading of the page (`readPage`, see
 * `src/site-profile.ts`), the learner clicking Check / Skip / Start over, the
 * learner pausing or resetting from the panel, and a session restored from
 * storage. Effects are what the controller must DO about it: start timing a
 * question, stop its clock, write its record, park it, freeze or unfreeze it,
 * enter or leave the end-of-set summary. The controller owns the timer engines
 * and storage and only executes effects; it makes no decisions of its own.
 *
 * Everything here used to be spread over four places in the controller (the
 * detector-event handler, the progress-state handler, a 700 ms page check and a
 * per-tick practice check), each reading the page and holding its own flags.
 * Here the page is read once per change and every rule sees the same reading.
 * `tests/flow.test.ts` drives it with random sequences of readings and inputs.
 */

import type { EndReason } from './types.js';
import { completionTriggerFor, progressLabel, type PageState } from './site-profile.js';

/** The question currently being timed. */
export interface TimedQuestion {
  exerciseKey: string;
  index: number;
  total: number | null;
  /** Identity used by sessions and records: `id:progress:<n> of <m>`. */
  key: string;
  /** Last state word seen for it: the baseline for answer detection. */
  state: string;
  /** Its clock has stopped: answered correctly, or skipped. */
  done: boolean;
  /** Its clock was frozen by us because the page stopped showing it. */
  frozen: boolean;
  /** A first answer was submitted (tells a confirmed skip from a correct retry). */
  submitted: boolean;
}

export interface FlowState {
  /** The last reading of the page, and the URL it was taken on. */
  page: PageState | null;
  url: string | null;
  question: TimedQuestion | null;
  /** The end-of-set summary is up (and on which URL it was entered). */
  summary: { exerciseKey: string; url: string } | null;
  /** Skip was clicked and has not been answered or cancelled by a Check since. */
  skipArmed: boolean;
  /** The learner paused this question from the panel: never auto-resumed. */
  learnerPaused: boolean;
}

export const INITIAL_FLOW: FlowState = {
  page: null,
  url: null,
  question: null,
  summary: null,
  skipArmed: false,
  learnerPaused: false,
};

export type FlowInput =
  | { type: 'page'; page: PageState; url: string }
  | { type: 'submit' }
  | { type: 'skip' }
  /** "Start over" was clicked and the page has had time to regenerate. */
  | { type: 'start-over' }
  /** The learner reset the current question's clock from the panel. */
  | { type: 'reset' }
  | { type: 'learner-pause'; paused: boolean }
  /** `begin` found a saved session for the question and restored it. */
  | { type: 'restored'; submitted: boolean; finished: boolean; paused: boolean };

export interface QuestionRef {
  exerciseKey: string;
  index: number;
  total: number | null;
  key: string;
}

export type FlowEffect =
  /** Start timing a question; `restore` allows resuming a saved session. */
  | { type: 'begin'; question: QuestionRef; restore: boolean }
  /** Stop the clock and hold the record (the question is still on screen). */
  | { type: 'complete'; reason: 'answered-correct' | 'skipped' }
  /** The question is over: write its record and drop its timer. */
  | { type: 'finalize'; reason: EndReason }
  /** The learner left the practice: keep the question resumable, drop its timer. */
  | { type: 'park' }
  | { type: 'freeze' }
  | { type: 'unfreeze' }
  /** The page graded the first answer (applied only if one was submitted). */
  | { type: 'outcome'; outcome: 'correct' | 'incorrect' }
  /** Finalize the last question and show the per-question card. */
  | { type: 'enter-summary' }
  | { type: 'leave-summary' };

export interface FlowStep {
  state: FlowState;
  effects: FlowEffect[];
}

export function questionKeyOf(index: number, total: number | null): string {
  return `id:progress:${progressLabel({ index, total, state: '', raw: '' })}`;
}

/** Is the question being timed the one on screen right now? (The panel's rule.) */
export function isTimingOnScreen(state: FlowState): boolean {
  const { question, page } = state;
  return (
    question !== null &&
    state.summary === null &&
    page?.screen === 'question' &&
    page.exerciseKey === question.exerciseKey &&
    page.question?.index === question.index
  );
}

export function step(state: FlowState, input: FlowInput): FlowStep {
  switch (input.type) {
    case 'page':
      return onPage(state, input.page, input.url);
    case 'submit':
      return {
        state: {
          ...state,
          skipArmed: false,
          question: state.question ? { ...state.question, submitted: true } : null,
        },
        effects: [],
      };
    case 'skip':
      return { state: { ...state, skipArmed: true }, effects: [] };
    case 'start-over':
      // A fresh problem at the same position: the next reading starts it.
      if (!state.question) return { state, effects: [] };
      return {
        state: { ...state, question: null, skipArmed: false, learnerPaused: false },
        effects: [{ type: 'finalize', reason: 'manual-reset' }],
      };
    case 'reset': {
      const question = state.question;
      if (!question) return { state, effects: [] };
      // The clock restarts; on a page that is not showing the question it is
      // frozen again at once, so it does not count unreadable time.
      const hidden = !isTimingOnScreen(state);
      return {
        state: {
          ...state,
          skipArmed: false,
          learnerPaused: false,
          question: { ...question, done: false, frozen: hidden },
        },
        effects: hidden ? [{ type: 'freeze' }] : [],
      };
    }
    case 'learner-pause':
      return {
        state: {
          ...state,
          learnerPaused: input.paused,
          question: state.question ? { ...state.question, frozen: false } : null,
        },
        effects: [],
      };
    case 'restored': {
      const question = state.question;
      if (!question) return { state, effects: [] };
      return {
        state: {
          ...state,
          learnerPaused: input.paused,
          question: { ...question, submitted: input.submitted, done: question.done || input.finished },
        },
        effects: [],
      };
    }
  }
}

function newQuestion(page: PageState): TimedQuestion {
  const q = page.question!;
  return {
    exerciseKey: page.exerciseKey,
    index: q.index,
    total: q.total,
    key: questionKeyOf(q.index, q.total),
    state: q.state,
    done: false,
    frozen: false,
    submitted: false,
  };
}

function refOf(question: TimedQuestion): QuestionRef {
  const { exerciseKey, index, total, key } = question;
  return { exerciseKey, index, total, key };
}

function onPage(previous: FlowState, page: PageState, url: string): FlowStep {
  let state: FlowState = { ...previous, page, url };
  const effects: FlowEffect[] = [];

  // 1. The summary stays until the learner is positively somewhere else: a
  //    question (a new attempt), the intro card, or another URL. Any other
  //    frame - including the summary re-rendering itself - is ignored.
  if (state.summary) {
    const leaving =
      page.screen === 'question' || page.screen === 'start-card' || url !== state.summary.url;
    if (!leaving) return { state, effects };
    effects.push({ type: 'leave-summary' });
    state = { ...state, summary: null, skipArmed: false };
  }

  // 2. The page belongs to another practice: whatever was being timed is
  //    parked, whether or not anything on the new page can be read yet.
  if (state.question && state.question.exerciseKey !== page.exerciseKey) {
    effects.push({ type: 'park' });
    state = { ...state, question: null, skipArmed: false, learnerPaused: false };
  }

  // 3. A question is being solved.
  if (page.screen === 'question' && page.question) {
    const reading = page.question;
    const current = state.question;
    if (!current || current.index !== reading.index) {
      if (current) effects.push({ type: 'finalize', reason: 'question-change' });
      let question = newQuestion(page);
      effects.push({ type: 'begin', question: refOf(question), restore: !current });
      // Arriving on a question that is already over (a reload after answering:
      // Next is showing) stops its clock straight away.
      if (reading.finished) {
        effects.push({ type: 'complete', reason: 'answered-correct' });
        question = { ...question, done: true };
      }
      return {
        state: { ...state, question, skipArmed: false, learnerPaused: false },
        effects,
      };
    }
    // The same question.
    let question = current;
    if (question.frozen) {
      effects.push({ type: 'unfreeze' });
      question = { ...question, frozen: false };
    }
    if (reading.state !== question.state) {
      effects.push({ type: 'outcome', outcome: reading.state === 'correct' ? 'correct' : 'incorrect' });
      if (!question.done) {
        // `correct` -> answered; leaving `incomplete` after a Skip -> skipped;
        // anything else is a wrong answer, and the learner may retry.
        const trigger = completionTriggerFor(reading.state, question.state, state.skipArmed);
        if (trigger) {
          effects.push({ type: 'complete', reason: trigger });
          question = { ...question, done: true };
        }
      }
      question = { ...question, state: reading.state };
    }
    // Next has replaced Check: the question is over even when the state word
    // did not move - a correct RETRY keeps the first attempt's `incorrect`.
    if (reading.finished && !question.done) {
      const reason = !question.submitted && state.skipArmed ? 'skipped' : 'answered-correct';
      effects.push({ type: 'complete', reason });
      question = { ...question, done: true };
    }
    return { state: { ...state, question }, effects };
  }

  // 4. No question on screen. The end screen of THIS practice, right after its
  //    last question was finished, is the summary; nothing else is (a loading
  //    frame or a dropped, unfinished question has the same structure).
  const question = state.question;
  if (page.screen === 'summary' && question?.done && question.exerciseKey === page.exerciseKey) {
    effects.push({ type: 'enter-summary' });
    return {
      state: { ...state, question: null, skipArmed: false, summary: { exerciseKey: page.exerciseKey, url } },
      effects,
    };
  }
  // A question still being worked on, no longer on screen: freeze its clock
  // (never a pause the learner chose, never a question already finished).
  if (question && !question.done && !question.frozen && !state.learnerPaused) {
    effects.push({ type: 'freeze' });
    state = { ...state, question: { ...question, frozen: true } };
  }
  return { state, effects };
}
