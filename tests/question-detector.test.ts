/**
 * Question detection tests.
 *
 * `QuestionDetector` reads the page with `readPage` and reports what changed.
 * It is driven here against a synthetic DOM that mirrors the structure actually
 * observed on Khan Academy. Before changing any selector, re-capture the live
 * DOM with scripts/capture/ - see AGENTS.md. Never infer a selector.
 *
 * The regression block encodes the two most important empirical findings from
 * live observation. Both are cases where a naive implementation would wrongly
 * reset the timer:
 *
 *   - submitting an answer changes the progress marker's STATE segment
 *     (`incomplete` -> `correct`), which must NOT count as a question change;
 *   - opening hints/solutions exploded the question region's text from ~3.5 KB
 *     to ~23 KB, which must NOT count as a question change either.
 *
 * With identity taken from the progress POSITION both hold by construction;
 * the tests keep it that way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OVERLAY_HOST_ID,
  QuestionDetector,
  identityKeyOf,
  isPositionedQuestionKey,
  type ProgressStateChange,
} from '../src/question-detector.js';
import {
  completionTriggerFor,
  exerciseKeyFromUrl,
  isQuestionFinished,
  isStartCardPresent,
  isSummaryPage,
  progressLabel,
  shouldLeaveSummary,
  readProgress,
  readSubmissionOutcome,
} from '../src/site-profile.js';
import type { DetectionEvent, QuestionSnapshot } from '../src/types.js';

const T0 = 1_700_000_000_000;

/**
 * Synthetic page mirroring the real structure. The testids, class names and
 * nesting were all taken from captured Khan Academy DOM.
 */
function khanDom({
  progressIndex = 0,
  progressState = 'incomplete',
  progressTotal = 4,
  stem = 'Add. 608+251',
  withProgress = true,
  withForm = true,
  withFeedbackDialog = false,
} = {}): string {
  const cells = Array.from({ length: progressTotal }, (_, i) => {
    const state = i === progressIndex ? `${progressState}-current` : 'incomplete';
    return `<div><div data-testid="exercise-progress-${i}-${state}"></div></div>`;
  }).join('');

  return `
    <div data-testid="content-panel-wrapper">
      <div class="bibliotron-exercise">
        ${
          withForm
            ? `<div class="framework-perseus">
          <h2 class="sr-only">Problem</h2>
          <form name="answerform">
            <div class="perseus-renderer perseus-renderer-responsive">
              <div class="paragraph" data-perseus-paragraph-index="0">${stem}</div>
              <div class="perseus-widget-container widget-inline-block">
                <input type="text" class="perseus-input" data-testid="input-with-examples" />
              </div>
            </div>
          </form>
        </div>`
            : ''
        }
      </div>
      ${
        withFeedbackDialog
          ? `<div role="dialog"><h4>Not quite yet...</h4><span>Give it another try!</span></div>`
          : ''
      }
      <div data-testid="content-library-footer">
        ${withProgress ? `<div class="progress">${cells}</div>` : ''}
        <div>
          <button data-testid="exercise-skip-button">Skip</button>
          <button data-testid="exercise-check-answer"><span>Check</span></button>
        </div>
      </div>
    </div>
  `;
}

/** Move the current marker from `from` to `to`, as the page does on Next. */
function advanceMarker(from: number, to: number, fromState = 'correct'): void {
  document
    .querySelector(`[data-testid^="exercise-progress-${from}-"][data-testid$="-current"]`)
    ?.setAttribute('data-testid', `exercise-progress-${from}-${fromState}`);
  document
    .querySelector(`[data-testid^="exercise-progress-${to}-"]`)
    ?.setAttribute('data-testid', `exercise-progress-${to}-incomplete-current`);
}

/** Change the current question's state word, as the page does on Check. */
function setCurrentState(state: string): void {
  const cell = document.querySelector('[data-testid$="-current"]');
  const index = cell?.getAttribute('data-testid')?.match(/^exercise-progress-(\d+)-/)?.[1];
  cell?.setAttribute('data-testid', `exercise-progress-${index}-${state}-current`);
}

function removeQuestionArea(): void {
  document.querySelector('.framework-perseus')?.remove();
}

interface Harness {
  detector: QuestionDetector;
  events: DetectionEvent[];
  snapshots: QuestionSnapshot[];
  stateChanges: Array<Pick<ProgressStateChange, 'state' | 'previous' | 'index'>>;
  last(): DetectionEvent;
  changes(): DetectionEvent[];
}

let harness: Harness | null = null;

function start(html: string): Harness {
  document.body.innerHTML = html;
  const events: DetectionEvent[] = [];
  const snapshots: QuestionSnapshot[] = [];
  const stateChanges: Harness['stateChanges'] = [];
  const detector = new QuestionDetector({
    onEvent: (event, snapshot) => {
      events.push(event);
      snapshots.push(snapshot);
    },
    onProgressStateChange: ({ state, previous, index }) => stateChanges.push({ state, previous, index }),
  });
  detector.start();
  harness = {
    detector,
    events,
    snapshots,
    stateChanges,
    last() {
      const event = events[events.length - 1];
      if (!event) throw new Error('no detection event recorded');
      return event;
    },
    changes: () => events.filter((event) => event.type === 'question-changed'),
  };
  return harness;
}

/** Let the observer, the throttle and the poll run. */
async function settle(ms = 150): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  harness?.detector.stop();
  harness = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/');
});

/* ================================================================== *
 * Identity helpers kept for the controller
 * ================================================================== */

describe('identityKeyOf / isPositionedQuestionKey', () => {
  const snap = (overrides: Partial<QuestionSnapshot>): QuestionSnapshot => ({
    at: T0,
    stableId: null,
    fingerprint: null,
    stemFingerprint: null,
    progress: null,
    url: 'https://www.khanacademy.org/math/x/e/addition_4',
    regionFound: true,
    strategy: 'perseus-answerform',
    confidence: 'none',
    ...overrides,
  });

  it('builds the key from the reported position', () => {
    expect(identityKeyOf(snap({ stableId: 'progress:3 of 7' }))).toBe('id:progress:3 of 7');
    expect(identityKeyOf(snap({}))).toBeNull();
  });

  it('treats only an id key as positioned (a fingerprint key from an old session is not)', () => {
    expect(isPositionedQuestionKey('id:progress:1 of 4')).toBe(true);
    expect(isPositionedQuestionKey('fp:abc123')).toBe(false);
    expect(isPositionedQuestionKey(null)).toBe(false);
  });
});

/* ================================================================== *
 * The detector
 * ================================================================== */

describe('QuestionDetector', () => {
  it('reports the first question with its position as its identity', () => {
    const h = start(khanDom());
    expect(h.last()).toMatchObject({ type: 'question-changed', from: null, to: 'id:progress:1 of 4', reason: 'initial' });
    expect(h.snapshots.at(-1)).toMatchObject({
      stableId: 'progress:1 of 4',
      progress: '1 of 4',
      regionFound: true,
      confidence: 'stable-id',
    });
  });

  it('commits a new position on the reading that shows it - no pending state, no settle time', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    advanceMarker(0, 1);
    await settle();
    expect(h.last()).toMatchObject({
      type: 'question-changed',
      from: 'id:progress:1 of 4',
      to: 'id:progress:2 of 4',
      reason: 'position-changed',
    });
    expect(h.events.some((event) => event.type === 'pending')).toBe(false);
  });

  it('notices a change from the DOM alone, within the throttle', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    advanceMarker(0, 1);
    await settle(120);
    expect(h.detector.getCurrentKey()).toBe('id:progress:2 of 4');
  });

  it('reports nothing while the reading does not change', async () => {
    const h = start(khanDom());
    const seen = h.events.length;
    await settle(30_000);
    expect(h.events).toHaveLength(seen);
  });

  it("ignores the extension's own overlay", async () => {
    const h = start(khanDom());
    const seen = h.events.length;
    const host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    document.body.append(host);
    host.setAttribute('data-khan-timer-diagnostics', '{"tick":1}');
    await settle();
    expect(h.events).toHaveLength(seen);
  });

  it('does not time a question area that has no position yet, then starts on the position', async () => {
    // An exercise's first render: the form can precede the progress cell (by at
    // most 71 ms, measured live). No identity, so no clock - and once the
    // position appears it is the FIRST question, not a change from anything.
    const h = start(khanDom({ withProgress: false }));
    expect(h.last()).toMatchObject({ type: 'uncertain', reason: 'no stable identity signal for this question' });
    expect(h.detector.getCurrentKey()).toBeNull();

    document.body.innerHTML = khanDom({ progressIndex: 0 });
    await settle();
    expect(h.last()).toMatchObject({ type: 'question-changed', from: null, to: 'id:progress:1 of 4' });
  });

  it('goes uncertain, keeping the identity, when the question area disappears', async () => {
    const h = start(khanDom());
    removeQuestionArea();
    await settle();
    expect(h.last()).toMatchObject({ type: 'uncertain', reason: 'question region not found' });
    expect(h.detector.getCurrentKey()).toBe('id:progress:1 of 4');
    expect(h.changes()).toHaveLength(1);
  });

  it('reports the same question when the same question area comes back', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    removeQuestionArea();
    await settle();
    expect(h.last()).toMatchObject({ type: 'uncertain' });

    document.body.innerHTML = khanDom({ progressIndex: 0 });
    await settle();
    expect(h.last()).toMatchObject({ type: 'same-question', key: 'id:progress:1 of 4' });
    expect(h.changes()).toHaveLength(1);
  });

  it('a start card is not a question, even with a leftover question area', async () => {
    const h = start(`
      <div class="bibliotron-exercise">
        <div data-testid="start-task-card-summary"><button>Let’s go</button></div>
        ${khanDom()}
      </div>`);
    expect(h.last()).toMatchObject({ type: 'uncertain' });
    expect(h.detector.getCurrentKey()).toBeNull();
  });

  /*
   * Switching practice A -> practice B inside the SPA.
   *
   * B's first question very often sits at the same "1 of N" as A's question,
   * so its identity string is byte-identical. Unless the URL change drops A's
   * identity, B's first question is reported as "same question" and A's clock
   * keeps running into B.
   */
  it('treats an SPA move to another exercise as a new question, not a continuation', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    window.history.pushState({}, '', '/math/cc-third-grade-math/e/other-practice');
    document.body.innerHTML =
      '<div class="bibliotron-exercise"><div data-testid="start-task-card-summary">Ready to practice?</div></div>';
    await settle();
    expect(h.detector.getCurrentKey()).toBeNull();
    expect(h.last()).toMatchObject({ type: 'uncertain' });

    document.body.innerHTML = khanDom({ progressIndex: 0, stem: 'Multiply. 12x4' });
    await settle();
    expect(h.last()).toMatchObject({ type: 'question-changed', from: null, to: 'id:progress:1 of 4' });
    expect(h.events.some((event) => event.type === 'same-question')).toBe(false);
  });

  it('notices a URL change with no DOM change at all (the poll)', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    window.history.pushState({}, '', '/math/x/e/addition_4?referrer=upsell');
    await settle(800);
    expect(h.last()).toMatchObject({ type: 'question-changed', from: null, to: 'id:progress:1 of 4' });
  });

  it('reseed reports a change for the same position ("Start over")', () => {
    const h = start(khanDom());
    vi.setSystemTime(T0 + 20_000);
    h.detector.reseed('start-over');
    expect(h.last()).toMatchObject({ type: 'question-changed', reason: 'reseeded', to: 'id:progress:1 of 4' });
    expect(h.changes()).toHaveLength(2);
  });

  it('keeps a unit test at "N of 10" when its progress bar is rendered twice', () => {
    const cells = (current: number) =>
      Array.from({ length: 10 }, (_, i) =>
        `<div><div data-testid="exercise-progress-${i}-${i < current ? 'incorrect' : 'incomplete'}${i === current ? '-current' : ''}"></div></div>`,
      ).join('');
    const h = start(
      khanDom({ withProgress: false }).replace(
        '<div data-testid="content-library-footer">',
        `<div data-testid="content-library-footer">
           <a title="Show all exercise progress">${cells(2)}</a>
           <div data-testid="progress-wrapper">${cells(2)}</div>`,
      ),
    );
    expect(h.detector.getCurrentKey()).toBe('id:progress:3 of 10');
  });
});

/* ================================================================== *
 * Regressions from live observation
 * ================================================================== */

describe('REGRESSION - auxiliary content must not reset the timer (spec 2.4, 8.3)', () => {
  it('hint expansion that grows the region 3.5 KB -> 23 KB is NOT a question change', async () => {
    // Observed for real: after confirming "Yes, skip", all hints for the
    // current question expanded INSIDE form[name="answerform"], and the region
    // text grew from ~3.5 KB to ~23 KB while the progress index stayed put.
    const h = start(khanDom());
    const hints = document.createElement('div');
    hints.className = 'hints-container';
    hints.innerHTML = Array.from(
      { length: 40 },
      (_, i) =>
        `<div>Hint #${i + 1} ${i + 1}/4 Step ${i}: 608 + 251 = 859 with a long explanation of place value regrouping.</div>`,
    ).join('');
    document.querySelector('form[name="answerform"]')?.appendChild(hints);
    await settle();
    vi.setSystemTime(T0 + 15_000);
    h.detector.reevaluate('hints-open');
    expect(h.last()).toMatchObject({ type: 'same-question' });
    expect(h.changes()).toHaveLength(1);
  });

  it('an incorrect-answer popover is NOT a question change', async () => {
    const h = start(khanDom());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h4>Not quite yet...</h4><span>Give it another try!</span>';
    document.querySelector('form[name="answerform"]')?.appendChild(dialog);
    await settle();
    h.detector.reevaluate('feedback-shown');
    expect(h.last()).toMatchObject({ type: 'same-question' });
    expect(h.changes()).toHaveLength(1);
  });

  it('typing an answer into the widget is NOT a question change', async () => {
    const h = start(khanDom());
    const input = document.querySelector<HTMLInputElement>('[data-testid="input-with-examples"]');
    if (input) input.value = '859';
    await settle();
    h.detector.reevaluate('answer-typed');
    expect(h.last()).toMatchObject({ type: 'same-question' });
    expect(h.changes()).toHaveLength(1);
  });

  it('submitting an answer moves the state word only: NOT a question change', async () => {
    const h = start(khanDom());
    setCurrentState('incorrect');
    await settle();
    expect(h.changes()).toHaveLength(1);
    expect(h.detector.getCurrentKey()).toBe('id:progress:1 of 4');
  });
});

/* ================================================================== *
 * Progress STATE changes (same question, different state word)
 * ================================================================== */

describe('QuestionDetector - progress state changes', () => {
  it('does not report a change for the first observation (baseline only)', () => {
    expect(start(khanDom()).stateChanges).toHaveLength(0);
  });

  it('reports an answered-correct state change on the same question', async () => {
    const h = start(khanDom());
    setCurrentState('correct');
    await settle();
    expect(h.stateChanges).toEqual([{ state: 'correct', previous: 'incomplete', index: 0 }]);
  });

  it('reports an incorrect state change (wrong answer) on the same question', async () => {
    const h = start(khanDom());
    setCurrentState('incorrect');
    await settle();
    expect(h.stateChanges).toEqual([{ state: 'incorrect', previous: 'incomplete', index: 0 }]);
  });

  it('reports each state transition once, however often the page is read', async () => {
    const h = start(khanDom());
    setCurrentState('correct');
    await settle();
    h.detector.reevaluate('again-1');
    h.detector.reevaluate('again-2');
    await settle(5000);
    expect(h.stateChanges).toHaveLength(1);
  });

  it('picks up a footer that renders after the question area', async () => {
    // On a real page load the footer holding the progress marker can come
    // after the question area. The first reading is then a baseline, and the
    // later state change must still be reported.
    const h = start(khanDom({ withProgress: false }));
    document.body.innerHTML = khanDom({ progressIndex: 0 });
    await settle();
    expect(h.stateChanges).toHaveLength(0);
    setCurrentState('correct');
    await settle();
    expect(h.stateChanges).toEqual([{ state: 'correct', previous: 'incomplete', index: 0 }]);
  });

  it('does not report a state change when the question INDEX moves', async () => {
    // The new question's "incomplete" is a new baseline, not a state change.
    const h = start(khanDom());
    advanceMarker(0, 1);
    await settle();
    expect(h.changes()).toHaveLength(2);
    expect(h.stateChanges).toHaveLength(0);
  });
});

/* ================================================================== *
 * Site profile helpers
 * ================================================================== */

describe('site-profile: readProgress / progressLabel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the index and ignores the state word', () => {
    document.body.innerHTML = khanDom({ progressIndex: 2, progressState: 'incorrect' });
    const progress = readProgress(document);
    expect(progress).toMatchObject({ index: 2, total: 4, state: 'incorrect' });
    expect(progressLabel(progress)).toBe('3 of 4');
  });

  it('returns null when there is no progress marker', () => {
    document.body.innerHTML = khanDom({ withProgress: false });
    expect(readProgress(document)).toBeNull();
    expect(progressLabel(null)).toBeNull();
  });

  it('REGRESSION: counts questions, not cells, when the bar is rendered twice', () => {
    // Structure observed live on a 10-question unit test from question 2 on:
    // the same bar twice in the footer, once inside a "Show all exercise
    // progress" link and once in `progress-wrapper`, `-current` in both.
    // Counting cells read "3 of 20" while question 1 had read "1 of 10".
    const bar = Array.from({ length: 10 }, (_, i) => {
      const state = i < 2 ? 'incorrect' : 'incomplete';
      const testid = `exercise-progress-${i}-${state}${i === 2 ? '-current' : ''}`;
      return `<div><div data-testid="${testid}" role="img"></div></div>`;
    }).join('');
    const copy = `<div><span aria-label="3 of 10 problems"><span>3 of 10</span></span><div>${bar}</div></div>`;
    document.body.innerHTML = `
      <div data-testid="content-library-footer">
        <a title="Show all exercise progress" href="javascript: void 0">${copy}</a>
        <div data-testid="progress-wrapper">${copy}</div>
      </div>`;
    const progress = readProgress(document);
    expect(progress).toMatchObject({ index: 2, total: 10, state: 'incomplete' });
    expect(progressLabel(progress)).toBe('3 of 10');
  });

  it('labels a lone progress cell without a total', () => {
    document.body.innerHTML = khanDom({ progressTotal: 1, progressIndex: 0 });
    expect(progressLabel(readProgress(document))).toBe('1 of 1');
  });
});

describe('site-profile: readSubmissionOutcome', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads "incorrect" from the progress state', () => {
    document.body.innerHTML = khanDom({ progressState: 'incorrect' });
    expect(readSubmissionOutcome(document)).toBe('incorrect');
  });

  it('reads "correct" from the progress state', () => {
    document.body.innerHTML = khanDom({ progressState: 'correct' });
    expect(readSubmissionOutcome(document)).toBe('correct');
  });

  it('is unknown while the question is still unattempted', () => {
    document.body.innerHTML = khanDom({ progressState: 'incomplete' });
    expect(readSubmissionOutcome(document)).toBe('unknown');
  });
});

describe('site-profile: exerciseKeyFromUrl', () => {
  const base = 'https://www.khanacademy.org';

  it('keeps the course/unit/type/slug path for an exercise', () => {
    expect(
      exerciseKeyFromUrl(
        `${base}/math/cc-third-grade-math/imp-adding-with-regrouping-within-1000/e/addition_4`,
      ),
    ).toBe('/math/cc-third-grade-math/imp-adding-with-regrouping-within-1000/e/addition_4');
  });

  it('handles quiz and unit-test paths', () => {
    expect(exerciseKeyFromUrl(`${base}/math/x/imp-rounding/quiz/quiz-1`)).toBe('/math/x/imp-rounding/quiz/quiz-1');
    expect(exerciseKeyFromUrl(`${base}/math/x/test/unit-test`)).toBe('/math/x/test/unit-test');
  });

  it('drops query strings and fragments (e.g. ?referrer=upsell)', () => {
    expect(exerciseKeyFromUrl(`${base}/math/x/quiz/quiz-1?referrer=upsell`)).toBe('/math/x/quiz/quiz-1');
  });

  it('handles a course challenge, which sits directly under the course', () => {
    expect(exerciseKeyFromUrl(`${base}/math/algebra/test/x2f8bb11595b61c86:course-challenge`)).toBe(
      '/math/algebra/test/x2f8bb11595b61c86:course-challenge',
    );
  });

  it('falls back to the path for non-exercise pages', () => {
    expect(exerciseKeyFromUrl(`${base}/math/cc-third-grade-math`)).toBe('/math/cc-third-grade-math');
  });

  it('does not throw on an unparseable URL', () => {
    expect(exerciseKeyFromUrl('not a url')).toBe('not a url');
  });
});

/* ================================================================== *
 * Summary page detection
 * ================================================================== */

describe('site-profile: isSummaryPage', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false while a question is showing', () => {
    document.body.innerHTML = khanDom({ progressIndex: 0 });
    expect(isSummaryPage(document)).toBe(false);
  });

  it('is false after answering while the question is still on screen', () => {
    document.body.innerHTML = khanDom({ progressIndex: 3, progressState: 'correct' });
    expect(isSummaryPage(document)).toBe(false);
  });

  it('is true on the end-of-exercise summary screen', () => {
    // The shape actually captured from the live site after the last question:
    // no answer form, no progress markers, exercise chrome still present.
    document.body.innerHTML = `
      <div data-testid="content-panel-wrapper">
        <div class="bibliotron-exercise">
          <div class="exercise-chrome-content-for-mobile-zoom">
            <div data-testid="eot-phantom-user-registration">
              <div><h1>Exercise complete!</h1><span>4/4 correct</span></div>
              <div><h3>Want to save your progress?</h3></div>
            </div>
          </div>
          <div data-testid="drawing-area"></div>
        </div>
      </div>
    `;
    expect(isSummaryPage(document)).toBe(true);
  });

  it('is false when the exercise chrome is gone entirely (e.g. a course page)', () => {
    document.body.innerHTML = '<div><h1>Course page</h1></div>';
    expect(isSummaryPage(document)).toBe(false);
  });

  it('is false on the intro card that quiz / test / challenge pages show first', () => {
    // Regression: these pages put a start card in front of the questions. From
    // the outside it looks exactly like the summary - exercise chrome present,
    // no answer form, no progress marker - and a naive check reported "summary"
    // on a page where the learner had not even started.
    document.body.innerHTML = `
      <div data-testid="content-panel-wrapper">
        <div class="bibliotron-exercise">
          <div data-testid="start-task-card-summary">
            <h1>Time for a quiz?</h1>
            <p>Get ready for questions on the unit so far. 5 questions · 5-10 minutes</p>
            <button>Let\u2019s go</button>
          </div>
        </div>
      </div>
    `;
    expect(isStartCardPresent(document)).toBe(true);
    expect(isSummaryPage(document)).toBe(false);
  });

  it('is false when only the answer form is missing but progress markers remain', () => {
    // Guards against treating a transient mid-render state as the summary.
    document.body.innerHTML = `
      <div class="bibliotron-exercise">
        <div data-testid="exercise-progress-0-incomplete-current"></div>
      </div>
    `;
    expect(isSummaryPage(document)).toBe(false);
  });
});

/* ================================================================== *
 * When the current question stops being timed (requirements 1 and 2)
 * ================================================================== */

describe('site-profile: completionTriggerFor', () => {
  it('stops on a correct answer, whether or not Skip was ever opened', () => {
    expect(completionTriggerFor('correct', 'incomplete', false)).toBe('answered-correct');
    expect(completionTriggerFor('correct', 'incomplete', true)).toBe('answered-correct');
    expect(completionTriggerFor('correct', 'incorrect', false)).toBe('answered-correct');
  });

  it('does NOT stop on a wrong answer, so the learner can retry', () => {
    expect(completionTriggerFor('incorrect', 'incomplete', false)).toBeNull();
  });

  it('stops when a skip is confirmed', () => {
    // Khan Academy marks a skipped question "incorrect" without a submission.
    expect(completionTriggerFor('incorrect', 'incomplete', true)).toBe('skipped');
  });

  it('does not stop when a skip dialog was opened and then cancelled', () => {
    // Cancelling leaves the question untouched: the state never moved.
    expect(completionTriggerFor('incomplete', 'incomplete', true)).toBeNull();
  });

  it('does not re-stop a question that already moved on', () => {
    // previous is no longer "incomplete", so this is not a fresh completion.
    expect(completionTriggerFor('incorrect', 'incorrect', true)).toBeNull();
    expect(completionTriggerFor('skipped', 'incorrect', true)).toBeNull();
  });

  it('ignores states it does not know', () => {
    expect(completionTriggerFor('incomplete', 'incomplete', false)).toBeNull();
    expect(completionTriggerFor('unseen', 'incomplete', false)).toBeNull();
  });
});


/* ================================================================== *
 * Finishing a question by a correct RETRY (reported bug)
 * ================================================================== */

describe('site-profile: isQuestionFinished', () => {
  const dom = (buttons: string): string => `
    <div data-testid="content-panel-wrapper">
      <div class="bibliotron-exercise"><form name="answerform">
        <div class="perseus-renderer"><div data-perseus-paragraph-index="0">Add. 1+1</div></div>
      </form></div>
      <div data-testid="content-library-footer">${buttons}</div>
    </div>`;

  const CHECK = '<button data-testid="exercise-check-answer">Check</button>';
  const NEXT = '<button data-testid="exercise-next-question">Next question</button>';

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false while the question is still answerable', () => {
    document.body.innerHTML = dom(CHECK);
    expect(isQuestionFinished(document)).toBe(false);
  });

  it('is false right after a WRONG answer (Check becomes "Check again")', () => {
    // The status word goes to "incorrect" but the advance control does not
    // appear, so the clock must keep running for the retry.
    document.body.innerHTML = dom('<button data-testid="exercise-check-answer">Check again</button>');
    expect(isQuestionFinished(document)).toBe(false);
  });

  it('is true after a correct FIRST answer', () => {
    document.body.innerHTML = dom(NEXT);
    expect(isQuestionFinished(document)).toBe(true);
  });

  it('is true after a correct RETRY, where the status word stays "incorrect"', () => {
    // This is the reported bug: Khan Academy keeps the first attempt's verdict
    // in the progress marker, so only the button swap reveals that the learner
    // eventually got it right.
    document.body.innerHTML = dom(NEXT);
    expect(isQuestionFinished(document)).toBe(true);
  });

  it('is false on the summary screen, where neither control exists', () => {
    document.body.innerHTML = '<div class="bibliotron-exercise"></div>';
    expect(isQuestionFinished(document)).toBe(false);
  });

  it('is false in a transitional state where both controls exist', () => {
    document.body.innerHTML = dom(`${CHECK}${NEXT}`);
    expect(isQuestionFinished(document)).toBe(false);
  });
});

describe('completionTriggerFor + isQuestionFinished cover both answer paths', () => {
  it('first-try correct is caught by the status word', () => {
    expect(completionTriggerFor('correct', 'incomplete', false)).toBe('answered-correct');
  });

  it('correct retry is NOT caught by the status word, which is why the button check exists', () => {
    // Khan Academy never reports "correct" here: the marker stays "incorrect".
    expect(completionTriggerFor('incorrect', 'incomplete', false)).toBeNull();
    // ...so the button swap has to be the signal.
    document.body.innerHTML = `
      <div class="bibliotron-exercise"><form name="answerform"></form></div>
      <button data-testid="exercise-next-question">Next question</button>`;
    expect(isQuestionFinished(document)).toBe(true);
    document.body.innerHTML = '';
  });
});

describe('site-profile: shouldLeaveSummary', () => {
  it('stays put on any frame that is not the summary, as long as no question is showing', () => {
    // REGRESSION: the transition into the summary is not atomic, and the page
    // re-renders while the summary is up. Tearing down on a bare "not summary"
    // frame destroyed the injected card and cleared the run, and the card was
    // then never re-injected.
    expect(
      shouldLeaveSummary({ onSummary: false, questionFormPresent: false, urlChanged: false }),
    ).toBe(false);
  });

  it('never leaves while the summary is actually showing', () => {
    expect(
      shouldLeaveSummary({ onSummary: true, questionFormPresent: true, urlChanged: true }),
    ).toBe(false);
  });

  it('leaves when a question is on screen again (another attempt)', () => {
    expect(
      shouldLeaveSummary({ onSummary: false, questionFormPresent: true, urlChanged: false }),
    ).toBe(true);
  });

  it('leaves when the intro card comes up, even though no question is on screen yet', () => {
    // Measured on a real page: the card was injected a moment before the
    // "Ready to practice?" screen finished rendering, and then sat on top of it
    // forever, because neither a question form nor a URL change ever appeared.
    expect(
      shouldLeaveSummary({
        onSummary: false,
        questionFormPresent: false,
        urlChanged: false,
        startCardPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldLeaveSummary({
        onSummary: false,
        questionFormPresent: false,
        urlChanged: false,
      }),
    ).toBe(false);
  });

  it('leaves when the page navigated somewhere else', () => {
    expect(
      shouldLeaveSummary({ onSummary: false, questionFormPresent: false, urlChanged: true }),
    ).toBe(true);
  });
});

/* ================================================================== *
 * Quiz / unit test / course challenge intro card
 * ================================================================== */

describe('site-profile: isStartCardPresent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is false on an ordinary question page', () => {
    document.body.innerHTML = khanDom({ progressIndex: 0 });
    expect(isStartCardPresent(document)).toBe(false);
  });

  it('is false on the end-of-exercise summary', () => {
    document.body.innerHTML = `
      <div class="bibliotron-exercise">
        <div data-testid="eot-phantom-user-registration"><h1>Exercise complete!</h1></div>
      </div>`;
    expect(isStartCardPresent(document)).toBe(false);
  });

  it('is true on the intro card', () => {
    document.body.innerHTML =
      '<div data-testid="start-task-card-summary"><button>Let\u2019s go</button></div>';
    expect(isStartCardPresent(document)).toBe(true);
  });
});
