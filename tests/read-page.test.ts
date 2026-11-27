/**
 * `readPage`: the whole page as one small value.
 *
 * Every fixture below mirrors the structure captured from the live site on a
 * math quiz, a biology quiz, a math unit test and a math course challenge
 * (logged out, walked from the start card to the end screen). Only the
 * structural contract is kept - test ids, `name`, roles, the stable class
 * names - exactly what `src/site-profile.ts` reads:
 *
 *     div[data-testid=content-panel-wrapper]
 *       div.bibliotron-exercise.task-container
 *         div.exercise-chrome-content-for-mobile-zoom
 *           div[data-testid=start-task-card-summary]      (start card only)
 *           div.framework-perseus > form[name=answerform]  (question only)
 *       div[data-testid=content-library-footer]
 *         start-over / progress cells / skip / check-or-next (question only)
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { readPage, type PageState } from '../src/site-profile.js';

const QUIZ =
  'https://www.khanacademy.org/math/algebra/x2f8bb11595b61c86:solve-equations-inequalities/' +
  'x2f8bb11595b61c86:linear-equations-parentheses/quiz/x2f8bb11595b61c86:solve-equations-inequalities-quiz-1';
const UNIT_TEST =
  'https://www.khanacademy.org/math/algebra/x2f8bb11595b61c86:solve-equations-inequalities/' +
  'x2f8bb11595b61c86:compound-inequalities/test/x2f8bb11595b61c86:solve-equations-inequalities-unit-test';
const COURSE_CHALLENGE = 'https://www.khanacademy.org/math/algebra/test/x2f8bb11595b61c86:course-challenge';

interface Cells {
  total: number;
  current: number;
  /** State word of the current cell. */
  state?: string;
}

function progressBar({ total, current, state = 'incomplete' }: Cells): string {
  return Array.from({ length: total }, (_, i) => {
    const word = i < current ? 'incorrect' : i === current ? state : 'incomplete';
    const testid = `exercise-progress-${i}-${word}${i === current ? '-current' : ''}`;
    return `<div><div data-testid="${testid}" role="img"></div></div>`;
  }).join('');
}

interface Screen {
  startCard?: boolean;
  form?: boolean;
  cells?: Cells | null;
  /** The bar rendered twice, as on a unit test from question 2 on. */
  doubleBar?: boolean;
  /** Which footer control closes the question: Check (open) or Next (closed). */
  control?: 'check' | 'next' | null;
  /** The page's own per-question attributes, which must not leak into the key. */
  exerciseId?: string;
  chrome?: boolean;
}

function render({
  startCard = false,
  form = false,
  cells = null,
  doubleBar = false,
  control = null,
  exerciseId = 'x799738ed',
  chrome = true,
}: Screen): void {
  const content = startCard
    ? `<div data-testid="start-task-card-summary"><h1>Time for a quiz?</h1>
         <p>5 questions · 5-10 minutes</p></div>`
    : form
      ? `<div class="framework-perseus"><form name="answerform">
           <div class="perseus-renderer"><p>Solve for f.</p><input type="text"></div>
         </form></div>`
      : '';
  const bar = cells ? progressBar(cells) : '';
  const bars = cells
    ? doubleBar
      ? `<a title="Show all exercise progress"><span aria-label="x of y problems"></span>${bar}</a>
         <div data-testid="progress-wrapper">${bar}</div>`
      : `<div>${bar}</div>`
    : '';
  const footer = startCard
    ? '<button type="button"><span>Let’s go</span></button>'
    : `${cells ? '<button data-testid="start-over-button"></button>' : ''}${bars}
       ${cells ? '<button data-testid="exercise-skip-button">Skip</button>' : ''}
       ${control === 'check' ? '<button data-testid="exercise-check-answer">Check</button>' : ''}
       ${control === 'next' ? '<button data-testid="exercise-next-question">Next question</button>' : ''}`;
  document.body.innerHTML = chrome
    ? `<div data-testid="content-panel-wrapper">
         <div class="bibliotron-exercise task-container">
           <div class="exercise-chrome-content-for-mobile-zoom" data-exercise-id="${exerciseId}">${content}</div>
         </div>
         <div data-testid="content-library-footer">${footer}</div>
       </div>`
    : '<main><h1>Algebra 1</h1><a href="/math/algebra/test/course-challenge">Course challenge</a></main>';
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('readPage - the screens of a test, start to end', () => {
  it('reads the intro card as the start card, with no question', () => {
    render({ startCard: true });
    expect(readPage(document, QUIZ)).toEqual<PageState>({
      screen: 'start-card',
      exerciseKey: new URL(QUIZ).pathname,
      question: null,
    });
  });

  it('reads the first question with its position and the open state', () => {
    render({ form: true, cells: { total: 5, current: 0 }, control: 'check' });
    expect(readPage(document, QUIZ).question).toEqual({
      index: 0,
      total: 5,
      state: 'incomplete',
      finished: false,
    });
  });

  it('a wrong answer changes the state word but leaves the question open (Try again)', () => {
    render({ form: true, cells: { total: 5, current: 0, state: 'incorrect' }, control: 'check' });
    expect(readPage(document, QUIZ)).toMatchObject({
      screen: 'question',
      question: { index: 0, state: 'incorrect', finished: false },
    });
  });

  it('a confirmed skip reads incorrect too, but closes the question (Next replaces Check)', () => {
    render({ form: true, cells: { total: 5, current: 0, state: 'incorrect' }, control: 'next' });
    expect(readPage(document, QUIZ).question).toMatchObject({ state: 'incorrect', finished: true });
  });

  it('a correct answer reads correct', () => {
    render({ form: true, cells: { total: 5, current: 2, state: 'correct' }, control: 'next' });
    expect(readPage(document, QUIZ).question).toMatchObject({
      index: 2,
      state: 'correct',
      finished: true,
    });
  });

  it('reads the end screen as the summary', () => {
    render({ form: false, cells: null, exerciseId: '13179406' });
    expect(readPage(document, UNIT_TEST)).toEqual<PageState>({
      screen: 'summary',
      exerciseKey: new URL(UNIT_TEST).pathname,
      question: null,
    });
  });

  it('reads a course challenge (30 questions, directly under the course)', () => {
    render({ form: true, cells: { total: 30, current: 6 }, control: 'check' });
    expect(readPage(document, COURSE_CHALLENGE)).toMatchObject({
      screen: 'question',
      exerciseKey: '/math/algebra/test/x2f8bb11595b61c86:course-challenge',
      question: { index: 6, total: 30 },
    });
  });

  it('reads a page with nothing to time as other', () => {
    render({ chrome: false });
    expect(readPage(document, 'https://www.khanacademy.org/math/algebra').screen).toBe('other');
  });
});

describe('readPage - regressions observed on the live site', () => {
  it('a unit test keeps its total when the progress bar is rendered twice', () => {
    render({ form: true, cells: { total: 10, current: 2 }, doubleBar: true, control: 'check' });
    expect(readPage(document, UNIT_TEST).question).toMatchObject({ index: 2, total: 10 });
  });

  it('a unit test keeps ONE key although every question carries its own exercise id', () => {
    // Observed on four consecutive questions of one unit test, and again
    // (different) on its end screen.
    const keys = ['x799738ed', 'x6a27f53ef2d0c175', 'x7a036a2f', '3033'].map((exerciseId, index) => {
      render({ form: true, cells: { total: 10, current: index }, control: 'check', exerciseId });
      return readPage(document, UNIT_TEST).exerciseKey;
    });
    render({ exerciseId: '13179406' });
    keys.push(readPage(document, UNIT_TEST).exerciseKey);
    expect(new Set(keys)).toEqual(new Set([new URL(UNIT_TEST).pathname]));
  });

  it('a form without a progress cell yet is not a question (exercise first render, <= 71 ms)', () => {
    render({ form: true, cells: null, control: 'check' });
    expect(readPage(document, QUIZ)).toMatchObject({ screen: 'other', question: null });
  });

  it('progress cells without a form are not the summary yet (on the way into the end screen)', () => {
    render({ form: false, cells: { total: 5, current: 4, state: 'incorrect' } });
    expect(readPage(document, QUIZ)).toMatchObject({ screen: 'other', question: null });
  });
});

describe('readPage - properties over any combination of markers', () => {
  const screens = fc.record({
    startCard: fc.boolean(),
    form: fc.boolean(),
    cells: fc.option(
      fc
        .integer({ min: 1, max: 30 })
        .chain((total) =>
          fc.record({
            total: fc.constant(total),
            current: fc.integer({ min: 0, max: total - 1 }),
            state: fc.constantFrom('incomplete', 'correct', 'incorrect'),
          }),
        ),
      { nil: null },
    ),
    doubleBar: fc.boolean(),
    control: fc.constantFrom<'check' | 'next' | null>('check', 'next', null),
    exerciseId: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/["<>&]/.test(s)),
    chrome: fc.boolean(),
  });

  it('a question is reported exactly when the page shows both a form and a position', () => {
    fc.assert(
      fc.property(screens, (screen) => {
        render(screen);
        const page = readPage(document, UNIT_TEST);
        const solving = screen.chrome && !screen.startCard && screen.form && screen.cells !== null;
        expect(page.screen === 'question').toBe(solving);
        expect(page.question !== null).toBe(page.screen === 'question');
        if (page.question && screen.cells) {
          expect(page.question.index).toBe(screen.cells.current);
          expect(page.question.total).toBe(screen.cells.total);
          expect(page.question.state).toBe(screen.cells.state);
          expect(page.question.finished).toBe(screen.control === 'next');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('the key depends on the URL only, never on what the page renders', () => {
    fc.assert(
      fc.property(screens, (screen) => {
        render(screen);
        expect(readPage(document, UNIT_TEST).exerciseKey).toBe(new URL(UNIT_TEST).pathname);
      }),
      { numRuns: 100 },
    );
  });
});
