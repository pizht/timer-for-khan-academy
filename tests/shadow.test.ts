/**
 * Shadow comparison between `readPage` and the current detector (step 2 of
 * replacing the detector). Pure logic: no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_VIEW,
  PageViewer,
  ShadowComparison,
  positionOfKey,
  type DetectionView,
} from '../src/shadow.js';
import type { PageQuestion, PageState } from '../src/site-profile.js';

const A = '/math/x/quiz/quiz-1';
const B = '/math/x/test/unit-test';

const q = (index: number, total: number): DetectionView => ({ screen: 'question', index, total });
const SUMMARY: DetectionView = { screen: 'summary', index: null, total: null };

function question(
  index: number,
  { state = 'incomplete', finished = false, exerciseKey = A }: Partial<PageQuestion> & { exerciseKey?: string } = {},
): PageState {
  return { screen: 'question', exerciseKey, question: { index, total: 5, state, finished } };
}
const summary = (exerciseKey = A): PageState => ({ screen: 'summary', exerciseKey, question: null });
const other = (exerciseKey = A): PageState => ({ screen: 'other', exerciseKey, question: null });
const startCard = (exerciseKey = A): PageState => ({ screen: 'start-card', exerciseKey, question: null });

describe('positionOfKey', () => {
  it('reads the position out of a positioned identity', () => {
    expect(positionOfKey('id:progress:3 of 10')).toEqual({ index: 2, total: 10 });
    expect(positionOfKey('id:progress:#4')).toEqual({ index: 3, total: null });
  });

  it('has no position for fingerprints, site ids or nothing', () => {
    expect(positionOfKey('fp:abc123')).toBeNull();
    expect(positionOfKey('id:item-42')).toBeNull();
    expect(positionOfKey(null)).toBeNull();
  });
});

describe('ShadowComparison', () => {
  it('records nothing while the two views agree', () => {
    const shadow = new ShadowComparison();
    shadow.observe(q(0, 5), q(0, 5), 0);
    shadow.observe(NO_VIEW, NO_VIEW, 250);
    expect(shadow.stats()).toEqual({ checks: 2, episodes: 0, current: null, longest: null });
  });

  it('measures how long one disagreement lasts', () => {
    const shadow = new ShadowComparison();
    shadow.observe(q(0, 5), q(1, 5), 1000);
    shadow.observe(q(0, 5), q(1, 5), 1250);
    shadow.observe(q(0, 5), q(1, 5), 1500);
    expect(shadow.stats().current).toMatchObject({ since: 1000, durationMs: 500 });
    shadow.observe(q(1, 5), q(1, 5), 1750);
    expect(shadow.stats()).toMatchObject({ episodes: 1, current: null, longest: { durationMs: 500 } });
  });

  it('keeps one stretch while the views keep disagreeing, whatever about', () => {
    // A detector lagging two questions behind is ONE long disagreement.
    const shadow = new ShadowComparison();
    shadow.observe(q(0, 5), q(1, 5), 0);
    shadow.observe(q(0, 5), q(2, 5), 1000);
    shadow.observe(q(1, 5), q(2, 5), 2000);
    expect(shadow.stats()).toMatchObject({
      episodes: 1,
      longest: { durationMs: 2000, detector: q(1, 5), page: q(2, 5) },
    });
  });

  it('keeps the longest stretch across several', () => {
    const shadow = new ShadowComparison();
    shadow.observe(q(0, 5), q(1, 5), 0);
    shadow.observe(q(0, 5), q(1, 5), 300);
    shadow.observe(q(1, 5), q(1, 5), 400);
    shadow.observe(NO_VIEW, SUMMARY, 1000);
    shadow.observe(NO_VIEW, SUMMARY, 1100);
    shadow.observe(SUMMARY, SUMMARY, 1200);
    expect(shadow.stats()).toMatchObject({ episodes: 2, longest: { durationMs: 300 } });
  });
});

describe('PageViewer - what the readPage pipeline concludes', () => {
  it('passes questions through with their position', () => {
    expect(new PageViewer().view(question(2))).toEqual(q(2, 5));
  });

  it('a start card and in-between frames are nothing to time', () => {
    const viewer = new PageViewer();
    expect(viewer.view(startCard())).toEqual(NO_VIEW);
    expect(viewer.view(other())).toEqual(NO_VIEW);
  });

  it('the summary after a finished question (Next shown) is the summary', () => {
    const viewer = new PageViewer();
    viewer.view(question(4, { state: 'incorrect', finished: true }));
    expect(viewer.view(other())).toEqual(NO_VIEW); // form gone, cells not yet
    expect(viewer.view(summary())).toEqual(SUMMARY);
    expect(viewer.view(summary())).toEqual(SUMMARY); // re-renders stay the summary
  });

  it('the summary straight after a correct answer is the summary', () => {
    const viewer = new PageViewer();
    viewer.view(question(4, { state: 'correct' }));
    expect(viewer.view(summary())).toEqual(SUMMARY);
  });

  it('a summary-shaped loading frame, before any question, is not the summary', () => {
    expect(new PageViewer().view(summary())).toEqual(NO_VIEW);
  });

  it('dropping an UNFINISHED question for a moment is not the summary', () => {
    const viewer = new PageViewer();
    viewer.view(question(1, { state: 'incorrect', finished: false }));
    expect(viewer.view(summary())).toEqual(NO_VIEW);
  });

  it("the torn-down frame of the practice being left is not the new practice's summary", () => {
    const viewer = new PageViewer();
    viewer.view(question(4, { state: 'correct', exerciseKey: A }));
    expect(viewer.view(summary(B))).toEqual(NO_VIEW);
  });

  it('after a start card, a summary-shaped frame is not the summary', () => {
    const viewer = new PageViewer();
    viewer.view(question(4, { state: 'correct' }));
    viewer.view(summary());
    viewer.view(startCard()); // "Try again" brings the intro card back
    expect(viewer.view(summary())).toEqual(NO_VIEW);
  });
});
