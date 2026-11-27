/**
 * Site profile helpers (`src/site-profile.ts`), driven against a synthetic DOM
 * that mirrors the structure actually observed on Khan Academy. Before changing
 * any selector, re-capture the live DOM with scripts/capture/ - see AGENTS.md.
 * Never infer a selector. `readPage` itself is covered by tests/read-page.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  completionTriggerFor,
  exerciseKeyFromUrl,
  isQuestionFinished,
  isStartCardPresent,
  isSummaryPage,
  progressLabel,
  readProgress,
  readSubmissionOutcome,
} from '../src/site-profile.js';

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
