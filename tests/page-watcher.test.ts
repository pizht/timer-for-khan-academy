/**
 * `PageWatcher` (`src/page-watcher.ts`): re-reads the page with `readPage` on
 * every document change and hands on each NEW reading. What a reading means is
 * decided by `src/flow.ts` (tests/flow.test.ts); here the question is only
 * "is a reading handed on exactly when, and only when, the page changed in a
 * way `readPage` can see?".
 *
 * The regression block encodes the two most important empirical findings from
 * live observation, both cases where a content-based detector reset the timer:
 * submitting an answer moves only the progress marker's STATE word, and opening
 * hints grew the question region's text from ~3.5 KB to ~23 KB. Neither may
 * look like another question.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OVERLAY_HOST_ID } from '../src/overlay.js';
import { PageWatcher } from '../src/page-watcher.js';
import type { PageState } from '../src/site-profile.js';

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
  watcher: PageWatcher;
  readings: PageState[];
  last(): PageState;
}

let harness: Harness | null = null;

function start(html: string): Harness {
  document.body.innerHTML = html;
  const readings: PageState[] = [];
  const watcher = new PageWatcher({ onReading: (page) => readings.push(page) });
  watcher.start();
  harness = {
    watcher,
    readings,
    last() {
      const reading = readings[readings.length - 1];
      if (!reading) throw new Error('no reading handed on');
      return reading;
    },
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
  harness?.watcher.stop();
  harness = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/');
});

describe('PageWatcher', () => {
  it('hands on the first reading as soon as it starts', () => {
    const h = start(khanDom());
    expect(h.readings).toHaveLength(1);
    expect(h.last()).toMatchObject({ screen: 'question', question: { index: 0, total: 4, state: 'incomplete' } });
  });

  it('hands on a new position from the DOM alone, within the throttle', async () => {
    const h = start(khanDom({ progressIndex: 0 }));
    advanceMarker(0, 1);
    await settle(120);
    expect(h.last().question).toMatchObject({ index: 1 });
  });

  it('hands on nothing while the reading does not change', async () => {
    const h = start(khanDom());
    await settle(30_000);
    expect(h.readings).toHaveLength(1);
  });

  it("ignores the extension's own panel", async () => {
    const h = start(khanDom());
    const host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    document.body.append(host);
    host.setAttribute('data-khan-timer-diagnostics', '{"tick":1}');
    await settle();
    expect(h.readings).toHaveLength(1);
  });

  it('hands on the question area disappearing and coming back', async () => {
    const h = start(khanDom());
    removeQuestionArea();
    await settle();
    expect(h.last().screen).toBe('other');
    document.body.innerHTML = khanDom();
    await settle();
    expect(h.last()).toMatchObject({ screen: 'question', question: { index: 0 } });
    expect(h.readings).toHaveLength(3);
  });

  it('notices a URL change with no DOM change at all (the poll)', async () => {
    const h = start(khanDom());
    window.history.pushState({}, '', '/math/x/e/other-practice');
    await settle(800);
    expect(h.readings).toHaveLength(2);
    expect(h.last().exerciseKey).toBe('/math/x/e/other-practice');
  });

  it('reread hands the reading on even when nothing changed', () => {
    const h = start(khanDom());
    h.watcher.reread('start-over');
    expect(h.readings).toHaveLength(2);
    expect(h.readings[1]).toEqual(h.readings[0]);
  });

  it('reads a unit test as "N of 10" although its progress bar is rendered twice', () => {
    const cells = (current: number): string =>
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
    expect(h.last().question).toMatchObject({ index: 2, total: 10 });
  });

  it('stops handing on readings once stopped', async () => {
    const h = start(khanDom());
    h.watcher.stop();
    advanceMarker(0, 1);
    await settle(2000);
    expect(h.readings).toHaveLength(1);
  });
});

describe('REGRESSION - auxiliary content is not another question (spec 2.4, 8.3)', () => {
  it('hint expansion that grows the region 3.5 KB -> 23 KB hands on nothing', async () => {
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
    await settle(2000);
    expect(h.readings).toHaveLength(1);
  });

  it('an incorrect-answer popover hands on nothing', async () => {
    const h = start(khanDom());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h4>Not quite yet...</h4><span>Give it another try!</span>';
    document.querySelector('form[name="answerform"]')?.appendChild(dialog);
    await settle(2000);
    expect(h.readings).toHaveLength(1);
  });

  it('typing an answer hands on nothing', async () => {
    const h = start(khanDom());
    const input = document.querySelector<HTMLInputElement>('[data-testid="input-with-examples"]');
    if (input) input.value = '859';
    await settle(2000);
    expect(h.readings).toHaveLength(1);
  });

  it('submitting an answer hands on the SAME position with a new state word', async () => {
    const h = start(khanDom());
    setCurrentState('incorrect');
    await settle();
    expect(h.readings).toHaveLength(2);
    expect(h.last().question).toMatchObject({ index: 0, state: 'incorrect' });
  });
});
