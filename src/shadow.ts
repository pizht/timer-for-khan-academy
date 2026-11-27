/**
 * Shadow comparison: what the controller concludes vs what `readPage` concludes.
 *
 * Introduced to prove `readPage` (see `src/site-profile.ts`) against the old
 * fingerprint detector before replacing it - which it then did. It stays as a
 * guard on the controller's own state handling: on every tick the controller
 * reduces its view (the question being timed, or the end screen) and
 * `readPage`'s view to the same small shape, and this module records where,
 * and for how long, they disagree. The result is published in the page's
 * diagnostics attribute, asserted on by the controller tests and read by the
 * live verification.
 *
 * Disagreeing for a moment is expected: the controller enters the end screen on
 * its own polling interval and both views are sampled on a tick. What matters
 * is how LONG a disagreement lasts, so episodes are measured rather than
 * counted.
 */

import type { PageState } from './site-profile.js';

/** The part of the page both detectors can be compared on. */
export interface DetectionView {
  screen: 'question' | 'summary' | 'none';
  /** Zero-based question index, for `question`. */
  index: number | null;
  total: number | null;
}

export const NO_VIEW: DetectionView = { screen: 'none', index: null, total: null };

/** `readPage`'s reading, reduced to a `DetectionView`. */
export function viewOfPage(page: PageState): DetectionView {
  if (page.screen === 'summary') return { screen: 'summary', index: null, total: null };
  if (page.screen === 'question' && page.question) {
    return { screen: 'question', index: page.question.index, total: page.question.total };
  }
  return NO_VIEW;
}

/**
 * `readPage`'s readings over time, reduced to what the new pipeline would
 * conclude.
 *
 * One rule needs history, and the replacement will need it too: a
 * summary-SHAPED page is the end of a set only when the page came there from a
 * FINISHED question of the same exercise. `readPage` cannot tell on its own,
 * because other frames have exactly the summary's structure (exercise chrome,
 * no form, no progress cell, no start card):
 *
 *  - an exercise's own loading frame, before its first question renders;
 *  - the torn-down frame of the practice being LEFT, which is already under
 *    the new practice's URL;
 *  - an in-app re-render that drops an UNFINISHED question for a moment.
 *
 * "Finished" is `finished` (Next has replaced Check: a skip, or a correct
 * retry, which keeps the first attempt's `incorrect`) or a `correct` state
 * word (the page can go to the summary straight from the last answer).
 *
 * The rule is applied using `readPage`'s own previous readings only; nothing is
 * borrowed from the detector it is being compared with.
 */
export class PageViewer {
  private last: {
    screen: 'question' | 'summary' | 'start-card';
    exerciseKey: string;
    done: boolean;
  } | null = null;

  view(page: PageState): DetectionView {
    if (page.screen === 'question' && page.question) {
      const done = page.question.finished || page.question.state === 'correct';
      this.last = { screen: 'question', exerciseKey: page.exerciseKey, done };
      return viewOfPage(page);
    }
    if (page.screen === 'start-card') {
      this.last = { screen: 'start-card', exerciseKey: page.exerciseKey, done: false };
      return NO_VIEW;
    }
    if (page.screen === 'summary') {
      const fromThisSet =
        this.last !== null &&
        this.last.exerciseKey === page.exerciseKey &&
        (this.last.screen === 'summary' || (this.last.screen === 'question' && this.last.done));
      if (!fromThisSet) return NO_VIEW;
      this.last = { screen: 'summary', exerciseKey: page.exerciseKey, done: true };
      return viewOfPage(page);
    }
    // `other` is transitional (or nothing to time): it neither ends nor starts
    // anything, so it does not move `last`.
    return NO_VIEW;
  }
}

/**
 * The position encoded in a positioned identity key: `id:progress:3 of 10` ->
 * index 2, total 10. Null for any other key (fingerprints, site ids).
 */
export function positionOfKey(key: string | null): { index: number; total: number | null } | null {
  const match = key?.match(/^id:progress:(\d+) of (\d+)$/);
  if (match) return { index: Number(match[1]) - 1, total: Number(match[2]) };
  const lone = key?.match(/^id:progress:#(\d+)$/);
  if (lone) return { index: Number(lone[1]) - 1, total: null };
  return null;
}

export function sameView(a: DetectionView, b: DetectionView): boolean {
  return a.screen === b.screen && a.index === b.index && a.total === b.total;
}

/** One stretch of time during which the two views differed. */
export interface Disagreement {
  since: number;
  durationMs: number;
  detector: DetectionView;
  page: DetectionView;
}

export interface ShadowStats {
  /** How many times the two views were compared. */
  checks: number;
  /** How many separate stretches of disagreement there were. */
  episodes: number;
  /** The disagreement going on right now, if any. */
  current: Disagreement | null;
  /** The longest stretch so far, finished or still going. */
  longest: Disagreement | null;
}

export class ShadowComparison {
  private checks = 0;
  private episodes = 0;
  private current: Disagreement | null = null;
  private longest: Disagreement | null = null;

  observe(detector: DetectionView, page: DetectionView, now: number): void {
    this.checks += 1;
    if (sameView(detector, page)) {
      this.current = null;
      return;
    }
    // A stretch lasts for as long as the views keep disagreeing, even if what
    // they disagree about changes on the way (a detector lagging two questions
    // behind is one long disagreement, not two short ones).
    if (this.current === null) {
      this.episodes += 1;
      this.current = { since: now, durationMs: 0, detector, page };
    }
    const current = this.current;
    current.detector = detector;
    current.page = page;
    current.durationMs = now - current.since;
    if (!this.longest || current.durationMs > this.longest.durationMs) {
      this.longest = { ...current };
    }
  }

  stats(): ShadowStats {
    return {
      checks: this.checks,
      episodes: this.episodes,
      current: this.current ? { ...this.current } : null,
      longest: this.longest ? { ...this.longest } : null,
    };
  }
}
