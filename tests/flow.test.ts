/**
 * The timing flow (`src/flow.ts`): every timing decision as one pure function.
 *
 * Example scenarios first - each one a behaviour that was established on the
 * live site and used to live somewhere in the controller - then properties
 * over random sequences of page readings, clicks and panel actions.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_FLOW,
  isTimingOnScreen,
  step,
  type FlowEffect,
  type FlowInput,
  type FlowState,
} from '../src/flow.js';
import type { PageState } from '../src/site-profile.js';

const A = '/math/x/e/practice-a';
const B = '/math/x/e/practice-b';
const URL_A = `https://www.khanacademy.org${A}`;
const URL_B = `https://www.khanacademy.org${B}`;

function question(
  index: number,
  { state = 'incomplete', finished = false, exerciseKey = A, total = 4 } = {},
): PageState {
  return { screen: 'question', exerciseKey, question: { index, total, state, finished } };
}
const screen = (kind: 'start-card' | 'summary' | 'other', exerciseKey = A): PageState => ({
  screen: kind,
  exerciseKey,
  question: null,
});
const page = (p: PageState, url = p.exerciseKey === B ? URL_B : URL_A): FlowInput => ({ type: 'page', page: p, url });

/** Run inputs from a state, returning the final state and every effect type in order. */
function run(inputs: FlowInput[], from: FlowState = INITIAL_FLOW): { state: FlowState; effects: FlowEffect[] } {
  let state = from;
  const effects: FlowEffect[] = [];
  for (const input of inputs) {
    const next = step(state, input);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}
const types = (effects: FlowEffect[]): string[] =>
  effects.map((e) => (e.type === 'complete' || e.type === 'finalize' ? `${e.type}:${e.reason}` : e.type));

describe('flow - answering', () => {
  it('starts timing a question once the page says which one it is', () => {
    const { effects, state } = run([page(screen('other')), page(question(0))]);
    expect(effects).toEqual([
      { type: 'begin', restore: true, question: { exerciseKey: A, index: 0, total: 4, key: 'id:progress:1 of 4' } },
    ]);
    expect(isTimingOnScreen(state)).toBe(true);
  });

  it('a correct first answer stops the clock and holds the record', () => {
    const { effects } = run([page(question(0)), { type: 'submit' }, page(question(0, { state: 'correct' }))]);
    expect(types(effects)).toEqual(['begin', 'outcome', 'complete:answered-correct']);
  });

  it('a wrong answer does not stop the clock; the correct retry does (Next replaces Check)', () => {
    const { effects } = run([
      page(question(0)),
      { type: 'submit' },
      page(question(0, { state: 'incorrect' })),
      { type: 'submit' },
      // The state word keeps the FIRST verdict; only the controls change.
      page(question(0, { state: 'incorrect', finished: true })),
    ]);
    expect(types(effects)).toEqual(['begin', 'outcome', 'complete:answered-correct']);
  });

  it('a confirmed skip is a skip, however it shows up', () => {
    const viaState = run([page(question(0)), { type: 'skip' }, page(question(0, { state: 'incorrect' }))]);
    expect(types(viaState.effects)).toEqual(['begin', 'outcome', 'complete:skipped']);
    const viaControls = run([page(question(0)), { type: 'skip' }, page(question(0, { finished: true }))]);
    expect(types(viaControls.effects)).toEqual(['begin', 'complete:skipped']);
  });

  it('a Check after opening Skip cancels the skip', () => {
    const { effects } = run([
      page(question(0)),
      { type: 'skip' },
      { type: 'submit' },
      page(question(0, { state: 'incorrect' })),
    ]);
    expect(types(effects)).toEqual(['begin', 'outcome']);
  });

  it('moving to the next question records the previous one and starts the next', () => {
    const { effects } = run([
      page(question(0)),
      page(question(0, { state: 'correct', finished: true })),
      page(question(1)),
    ]);
    expect(types(effects)).toEqual(['begin', 'outcome', 'complete:answered-correct', 'finalize:question-change', 'begin']);
    expect(effects.at(-1)).toMatchObject({ type: 'begin', restore: false });
  });

  it('arriving on a question that is already over (a reload after answering) stops its clock', () => {
    const { effects } = run([page(question(2, { state: 'correct', finished: true }))]);
    expect(types(effects)).toEqual(['begin', 'complete:answered-correct']);
  });

  it('hints, popovers and typing change nothing it reads: no effect at all', () => {
    const start = run([page(question(0))]).state;
    expect(step(start, page(question(0))).effects).toEqual([]);
  });
});

describe('flow - the question leaving the screen', () => {
  it('freezes an unfinished question and resumes it when it comes back', () => {
    const { effects } = run([page(question(0)), page(screen('other')), page(screen('other')), page(question(0))]);
    expect(types(effects)).toEqual(['begin', 'freeze', 'unfreeze']);
  });

  it('never resumes a pause the learner chose', () => {
    const { effects } = run([
      page(question(0)),
      { type: 'learner-pause', paused: true },
      page(screen('other')),
      page(question(0)),
    ]);
    expect(types(effects)).toEqual(['begin']);
  });

  it('does not freeze a finished question', () => {
    const { effects } = run([page(question(0)), page(question(0, { state: 'correct' })), page(screen('other'))]);
    expect(types(effects)).toEqual(['begin', 'outcome', 'complete:answered-correct']);
  });

  it('parks the question when the learner moves to another practice', () => {
    const { effects, state } = run([page(question(2)), page(screen('start-card', B)), page(question(0, { exerciseKey: B }))]);
    expect(types(effects)).toEqual(['begin', 'park', 'begin']);
    expect(effects.at(-1)).toMatchObject({ type: 'begin', restore: true, question: { exerciseKey: B } });
    expect(state.question?.exerciseKey).toBe(B);
  });

  it('Start over finalizes the question; the regenerated one at the same position starts afresh', () => {
    const { effects } = run([page(question(1)), { type: 'start-over' }, page(question(1))]);
    expect(types(effects)).toEqual(['begin', 'finalize:manual-reset', 'begin']);
  });

  it('a reset reopens a finished question, and re-freezes one that is off screen', () => {
    const onScreen = run([page(question(0)), page(question(0, { state: 'correct' })), { type: 'reset' }]);
    expect(onScreen.state.question?.done).toBe(false);
    const offScreen = run([page(question(0)), page(screen('other')), { type: 'reset' }]);
    expect(types(offScreen.effects)).toEqual(['begin', 'freeze', 'freeze']);
  });

  it('a restored finished question counts as finished', () => {
    const { state } = run([page(question(3)), { type: 'restored', submitted: true, finished: true, paused: false }]);
    expect(state.question).toMatchObject({ done: true, submitted: true });
  });
});

describe('flow - the summary', () => {
  it('opens on the end screen right after the last question was finished', () => {
    const { effects, state } = run([
      page(question(3)),
      page(question(3, { state: 'correct', finished: true })),
      page(screen('other')), // the form goes before the progress cells do
      page(screen('summary')),
    ]);
    expect(types(effects)).toEqual(['begin', 'outcome', 'complete:answered-correct', 'enter-summary']);
    expect(state.summary).not.toBeNull();
  });

  it('a loading frame with the summary structure is not the summary', () => {
    expect(types(run([page(screen('summary'))]).effects)).toEqual([]);
  });

  it('an unfinished question dropped for a moment is not the summary', () => {
    const { effects } = run([page(question(1)), page(screen('summary'))]);
    expect(types(effects)).toEqual(['begin', 'freeze']);
  });

  it("the torn-down frame of the practice being left is not the new practice's summary", () => {
    const { effects } = run([
      page(question(3, { state: 'correct' })),
      page(screen('summary', B)),
    ]);
    expect(types(effects)).toEqual(['begin', 'park']);
  });

  it('stays up through re-renders, and goes when a question or the intro card comes back', () => {
    const atSummary = run([page(question(3, { state: 'correct', finished: true })), page(screen('summary'))]).state;
    expect(run([page(screen('other')), page(screen('summary'))], atSummary).effects).toEqual([]);
    expect(types(run([page(screen('start-card'))], atSummary).effects)).toEqual(['leave-summary']);
    expect(types(run([page(question(0))], atSummary).effects)).toEqual(['leave-summary', 'begin']);
  });
});

/* ------------------------------------------------------------------ *
 * Properties over random sequences
 * ------------------------------------------------------------------ */

const pageArb: fc.Arbitrary<FlowInput> = fc
  .record({
    exerciseKey: fc.constantFrom(A, A, A, B),
    kind: fc.constantFrom('question', 'question', 'question', 'start-card', 'summary', 'other'),
    index: fc.integer({ min: 0, max: 3 }),
    state: fc.constantFrom('incomplete', 'incomplete', 'correct', 'incorrect'),
    finished: fc.boolean(),
  })
  .map(({ exerciseKey, kind, index, state, finished }) =>
    page(kind === 'question' ? question(index, { exerciseKey, state, finished }) : screen(kind as 'other', exerciseKey)),
  );

const inputArb: fc.Arbitrary<FlowInput> = fc.oneof(
  { weight: 6, arbitrary: pageArb },
  { weight: 1, arbitrary: fc.constant<FlowInput>({ type: 'submit' }) },
  { weight: 1, arbitrary: fc.constant<FlowInput>({ type: 'skip' }) },
  { weight: 1, arbitrary: fc.constant<FlowInput>({ type: 'start-over' }) },
  { weight: 1, arbitrary: fc.constant<FlowInput>({ type: 'reset' }) },
  { weight: 1, arbitrary: fc.boolean().map<FlowInput>((paused) => ({ type: 'learner-pause', paused })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ submitted: fc.boolean(), finished: fc.boolean(), paused: fc.boolean() })
      .map<FlowInput>((r) => ({ type: 'restored', ...r })),
  },
);

/** What the controller would be doing, rebuilt from the effects alone. */
interface Tracker {
  live: { exerciseKey: string; index: number } | null;
  completed: boolean;
  frozen: boolean;
  summary: boolean;
}

function apply(tracker: Tracker, effect: FlowEffect, input: FlowInput, before: FlowState): Tracker {
  switch (effect.type) {
    case 'begin':
      expect(tracker.live, 'a question is started while another is still being timed').toBeNull();
      expect(tracker.summary, 'a question is started under the summary').toBe(false);
      return { ...tracker, live: { exerciseKey: effect.question.exerciseKey, index: effect.question.index }, completed: false, frozen: false };
    case 'complete':
      expect(tracker.live, 'complete without a question').not.toBeNull();
      expect(tracker.completed, 'a question completed twice').toBe(false);
      return { ...tracker, completed: true };
    case 'finalize':
    case 'park':
      expect(tracker.live, `${effect.type} without a question`).not.toBeNull();
      return { ...tracker, live: null, completed: false, frozen: false };
    case 'freeze':
      expect(tracker.live, 'freeze without a question').not.toBeNull();
      // A reset restarts the clock, so re-freezing a frozen question is right there.
      if (input.type !== 'reset') expect(tracker.frozen, 'frozen twice').toBe(false);
      return { ...tracker, frozen: true };
    case 'unfreeze':
      expect(tracker.frozen, 'unfreeze of a clock that was not frozen').toBe(true);
      return { ...tracker, frozen: false };
    case 'outcome':
      expect(tracker.live, 'an outcome without a question').not.toBeNull();
      return tracker;
    case 'enter-summary': {
      expect(tracker.live, 'the summary without a question to finish').not.toBeNull();
      expect(tracker.completed, 'the summary after an UNFINISHED question').toBe(true);
      const p = input.type === 'page' ? input.page : null;
      expect(p?.screen).toBe('summary');
      expect(tracker.live?.exerciseKey, "another practice's summary").toBe(p?.exerciseKey);
      expect(before.summary).toBeNull();
      return { live: null, completed: false, frozen: false, summary: true };
    }
    case 'leave-summary':
      expect(tracker.summary, 'leaving a summary that is not up').toBe(true);
      return { ...tracker, summary: false };
  }
}

describe('flow - properties', () => {
  it('keeps every invariant over any sequence of readings, clicks and panel actions', () => {
    fc.assert(
      fc.property(fc.array(inputArb, { maxLength: 80 }), (inputs) => {
        let state = INITIAL_FLOW;
        let tracker: Tracker = { live: null, completed: false, frozen: false, summary: false };
        for (const input of inputs) {
          const { state: next, effects } = step(state, input);
          if (state.summary && effects.length > 0) {
            expect(effects[0]?.type, 'anything but leaving while the summary is up').toBe('leave-summary');
          }
          for (const effect of effects) tracker = apply(tracker, effect, input, state);
          // A restored session tells the flow what the controller's timer is.
          if (input.type === 'restored' && tracker.live && input.finished) {
            tracker = { ...tracker, completed: true };
          }
          if (input.type === 'reset' && tracker.live) tracker = { ...tracker, completed: false };
          // Pause / Resume from the panel acts on the clock directly: whatever
          // the flow had frozen is now the learner's to control.
          if (input.type === 'learner-pause') tracker = { ...tracker, frozen: false };
          state = next;

          // The state and the effects tell the same story.
          expect(state.question === null).toBe(tracker.live === null);
          expect(state.summary !== null).toBe(tracker.summary);
          if (state.question) expect(state.question.done).toBe(tracker.completed);

          if (input.type === 'page' && input.page.screen === 'question') {
            // A question on screen is always the one being timed.
            expect(isTimingOnScreen(state)).toBe(true);
            expect(tracker.live).toEqual({ exerciseKey: input.page.exerciseKey, index: input.page.question!.index });
            expect(tracker.frozen).toBe(false);
            // Reading the same page again changes nothing.
            expect(step(state, input).effects).toEqual([]);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});
