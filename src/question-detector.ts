/**
 * Question detection: reads the page with `readPage` and reports what changed.
 *
 * The page maintains its own discrete markers - which question of the set is
 * current (`exercise-progress-<index>-<state>-current`), whether the answer
 * form is up, the start card, the end screen - and `readPage` (in
 * `site-profile.ts`) turns them into one small value. This module re-reads that
 * value whenever the document changes and turns the DIFFERENCE with the last
 * reading into the events the controller consumes:
 *
 *   a question with a new position           -> `question-changed`
 *   the same question again                  -> `same-question`
 *   no question being solved on the page     -> `uncertain`
 *   the same question, its state word moved  -> `onProgressStateChange`
 *
 * What this replaced, and why it could go [VER], see `readPage`:
 *  - identity by fingerprinting the question region (stem text + widget
 *    shape). It covered the window between the region rendering and the
 *    progress marker rendering; that window is now at most 71 ms on an
 *    ordinary exercise and does not exist on a quiz, unit test or course
 *    challenge, where both appear in the same 25 ms sample. A question is now
 *    timed only once the page says which one it is, as the controller already
 *    required;
 *  - the de-bounce (400 ms) and cooldown (1200 ms) before committing a
 *    change. The marker is discrete and never flapped in any walk, so a new
 *    position is committed on the reading that shows it;
 *  - three MutationObservers bound to individual subtrees, re-bound whenever
 *    the SPA replaced one, plus a pending-confirmation timer. One observer on
 *    the document now triggers a reading; a slow poll catches URL changes.
 *
 * Hints, feedback popovers and typing into a widget change the region's
 * content, never the position, so they cannot look like a question change by
 * construction (locked in by tests/question-detector.test.ts).
 */

import type { DetectionConfidence, DetectionEvent, QuestionSnapshot } from './types.js';
import { normalizeText } from './util.js';
import { progressLabel, readPage, readProgress, type PageState } from './site-profile.js';

/** Extract the identity key a snapshot offers, if any. */
export function identityKeyOf(snapshot: QuestionSnapshot): string | null {
  if (snapshot.stableId) return `id:${normalizeText(snapshot.stableId)}`;
  if (snapshot.fingerprint) return `fp:${snapshot.fingerprint}`;
  return null;
}

/**
 * Does this identity carry the question's POSITION in the set, i.e. is the page
 * saying *which* question is on screen? Every identity this detector produces
 * does (`id:progress:<n> of <m>`); the check stays because sessions saved by
 * earlier versions can still carry a fingerprint key (`fp:<hash>`).
 */
export function isPositionedQuestionKey(key: string | null): boolean {
  return key !== null && key.startsWith('id:');
}

export interface DetectorCallbacks {
  onEvent: (event: DetectionEvent, snapshot: QuestionSnapshot) => void;
  onDiagnostics?: (info: DetectorDiagnostics) => void;
  /**
   * The current question's progress STATE changed while its INDEX did not.
   *
   * On Khan Academy the progress marker is
   * `exercise-progress-<index>-<state>[-current]`, so this fires when the
   * learner answers or skips the question they are already on:
   * `incomplete -> correct`, `incomplete -> incorrect`, and so on.
   * The detector only reports it; deciding what it means for the timer is the
   * controller's job (spec 5.3).
   */
  onProgressStateChange?: (change: ProgressStateChange) => void;
}

export interface ProgressStateChange {
  /** The new state word, e.g. "correct" / "incorrect". */
  state: string;
  /** The previous state word, or null if this is the first observation. */
  previous: string | null;
  /** Zero-based question index the state belongs to. */
  index: number;
  snapshot: QuestionSnapshot;
}

export interface DetectorDiagnostics {
  /** The answer form is on the page. */
  regionFound: boolean;
  strategy: string | null;
  confidence: DetectionConfidence;
  questionKey: string | null;
  progress: string | null;
  progressRaw: string | null;
  evaluateCount: number;
  lastEvaluateAt: number;
  lastReason: string;
  /** True once the detector has been stopped; evaluation is then a no-op. */
  stopped: boolean;
  /** How many times the poll interval has run. */
  pollTicks: number;
  /** How many times the MutationObserver callback has fired. */
  mutationCallbacks: number;
  /** Kept for the diagnostics format; there is no pending state any more. */
  pendingCandidate: boolean;
  regionConnected: boolean;
  progressContainerConnected: boolean;
  /** Kept for the diagnostics format; one document observer replaced them. */
  hasRegionObserver: boolean;
  hasProgressObserver: boolean;
  hasBodyObserver: boolean;
  pollTimerActive: boolean;
  notes: string[];
  errors: string[];
}

/**
 * Accepted for compatibility with stored settings (`detectionDebounceMs`,
 * `detectionCooldownMs`); no longer used, see the header.
 */
export interface DetectorOptions {
  debounceMs: number;
  cooldownMs: number;
}

/** The element our own overlay is mounted in; never treated as page content. */
export const OVERLAY_HOST_ID = 'khan-academy-timer-host';

/** How often the URL is checked, and the page re-read as a safety net. */
const POLL_INTERVAL_MS = 700;
/** Minimum spacing between readings triggered by mutations. */
const EVALUATE_THROTTLE_MS = 100;
/** Minimum spacing between diagnostics emissions to the popup and the page. */
const DIAGNOSTICS_INTERVAL_MS = 1000;
/** The only attributes whose changes can move a reading. */
const WATCHED_ATTRIBUTES = ['data-testid', 'name'];

/** A reading turned into the snapshot shape the controller consumes. */
function snapshotOf(page: PageState, url: string, at: number, formPresent: boolean): QuestionSnapshot {
  const question = page.screen === 'question' ? page.question : null;
  const label = question
    ? progressLabel({ index: question.index, total: question.total, state: question.state, raw: '' })
    : null;
  return {
    at,
    stableId: label ? `progress:${label}` : null,
    fingerprint: null,
    stemFingerprint: null,
    progress: label,
    url,
    regionFound: formPresent,
    strategy: formPresent ? 'perseus-answerform' : null,
    confidence: label ? 'stable-id' : 'none',
  };
}

/**
 * Watches the page and reports question changes.
 */
export class QuestionDetector {
  private readonly callbacks: DetectorCallbacks;
  private observer: MutationObserver | null = null;
  private pollTimer: number | null = null;
  private throttleTimer: number | null = null;
  private stopped = true;

  /** The question the last event committed, as an identity key. */
  private currentKey: string | null = null;
  /** "Start over": the next question reading is a new question, same key or not. */
  private reseedPending = false;
  /** URL and reading of the last evaluation, to report only what changed. */
  private lastUrl = '';
  private lastReading = '';
  private lastSnapshot: QuestionSnapshot | null = null;
  /** Baseline for `onProgressStateChange`. */
  private lastProgressIndex: number | null = null;
  private lastProgressState: string | null = null;

  private pollTicks = 0;
  private mutationCallbacks = 0;
  private evaluateCount = 0;
  private lastEvaluateAt = 0;
  private lastReason = 'none';
  private lastDiagnosticsAt = 0;
  private lastScreen: PageState['screen'] | null = null;

  constructor(callbacks: DetectorCallbacks, _options: Partial<DetectorOptions> = {}) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastUrl = location.href;
    this.observer = new MutationObserver(() => this.onMutation());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    this.pollTimer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.evaluate('start', true);
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.throttleTimer !== null) window.clearTimeout(this.throttleTimer);
    this.pollTimer = null;
    this.throttleTimer = null;
    this.emitDiagnostics(true, 'stop');
  }

  /** Kept for the controller's settings hook; there is nothing to configure. */
  configure(_options: Partial<DetectorOptions>): void {}

  /** Re-read the page and report the result, e.g. after the user clicks "reset". */
  reevaluate(reason: string): void {
    this.evaluate(reason, true);
  }

  /**
   * Mark that the current question was regenerated in place (Khan Academy's
   * "Start over"), so the next question reading starts a fresh timer even
   * though its position is unchanged.
   */
  reseed(reason = 'start-over'): void {
    this.reseedPending = true;
    this.evaluate(reason, true);
  }

  getCurrentKey(): string | null {
    return this.currentKey;
  }

  /* ---------------- internals ---------------- */

  private onMutation(): void {
    this.mutationCallbacks += 1;
    if (this.stopped) return;
    const elapsed = Date.now() - this.lastEvaluateAt;
    if (elapsed >= EVALUATE_THROTTLE_MS) {
      this.evaluate('mutation', false);
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null;
      this.evaluate('mutation-throttled', false);
    }, EVALUATE_THROTTLE_MS - elapsed);
  }

  /**
   * The poll runs whatever the DOM does: an SPA route change does not always
   * mutate anything the observer watches, and a missed mutation must not be
   * able to stall detection.
   */
  private poll(): void {
    this.pollTicks += 1;
    if (this.stopped) return;
    this.evaluate('poll', false);
    this.emitDiagnostics(false, 'poll');
  }

  /**
   * Read the page and report what changed.
   *
   * @param always report the reading even if it equals the previous one (an
   *   explicit request: start, reset, start-over). Otherwise an unchanged
   *   reading produces no event.
   */
  private evaluate(reason: string, always: boolean): void {
    if (this.stopped) return;
    const at = Date.now();
    const url = location.href;
    const navigated = url !== this.lastUrl;
    if (navigated) {
      // Every identity belongs to the page that was left: the next question
      // read is the first question of the new page, never a "change" from the
      // previous page's question.
      this.lastUrl = url;
      this.currentKey = null;
      this.lastProgressIndex = null;
      this.lastProgressState = null;
    }
    const page = readPage(document, url);
    const formPresent = document.querySelector('form[name="answerform"]') !== null;
    const reading = JSON.stringify([url, page, formPresent]);
    this.lastEvaluateAt = at;
    if (!always && !navigated && reading === this.lastReading) return;
    this.lastReading = reading;
    this.evaluateCount += 1;
    this.lastReason = navigated ? 'url-change' : reason;
    this.lastScreen = page.screen;

    const snapshot = snapshotOf(page, url, at, formPresent);
    this.lastSnapshot = snapshot;
    const event = this.decide(snapshot);
    this.callbacks.onEvent(event, snapshot);
    this.reportProgressStateChange(event, page, snapshot);
    this.emitDiagnostics(true, `evaluate: ${this.lastReason}`);
  }

  private decide(snapshot: QuestionSnapshot): DetectionEvent {
    const at = snapshot.at;
    const key = identityKeyOf(snapshot);
    if (key === null) {
      // No question being solved. The current key is KEPT: the controller
      // freezes the question's clock, and the same position coming back is the
      // same question, not a new one.
      return {
        type: 'uncertain',
        at,
        reason: snapshot.regionFound
          ? 'no stable identity signal for this question'
          : 'question region not found',
      };
    }
    const from = this.currentKey;
    if (this.reseedPending) {
      this.reseedPending = false;
      this.currentKey = key;
      return { type: 'question-changed', at, from, to: key, reason: 'reseeded' };
    }
    if (from === null) {
      this.currentKey = key;
      return { type: 'question-changed', at, from: null, to: key, reason: 'initial' };
    }
    if (key === from) return { type: 'same-question', at, key };
    this.currentKey = key;
    return { type: 'question-changed', at, from, to: key, reason: 'position-changed' };
  }

  /**
   * Report a state change on the question we are already on.
   *
   * A change of INDEX is a different question (`question-changed`); this only
   * fires when the index stayed the same but the state word moved, so the two
   * never overlap.
   */
  private reportProgressStateChange(
    event: DetectionEvent,
    page: PageState,
    snapshot: QuestionSnapshot,
  ): void {
    const question = page.screen === 'question' ? page.question : null;
    if (event.type === 'question-changed') {
      // A new question: reseed the baseline without reporting a state change.
      this.lastProgressIndex = question?.index ?? null;
      this.lastProgressState = question?.state ?? null;
      return;
    }
    if (!question) return;
    const previous = this.lastProgressState;
    const previousIndex = this.lastProgressIndex;
    this.lastProgressIndex = question.index;
    this.lastProgressState = question.state;
    // A first observation is a baseline, not a change.
    if (previous === null || previous === question.state) return;
    if (previousIndex !== null && previousIndex !== question.index) return;
    this.callbacks.onProgressStateChange?.({
      state: question.state,
      previous,
      index: question.index,
      snapshot,
    });
  }

  /**
   * Emit a diagnostics snapshot. `force` bypasses the once-per-second throttle,
   * which keeps a stalled detector visible instead of replaying stale counters.
   */
  private emitDiagnostics(force: boolean, note: string): void {
    if (!this.callbacks.onDiagnostics) return;
    const now = Date.now();
    if (!force && now - this.lastDiagnosticsAt <= DIAGNOSTICS_INTERVAL_MS) return;
    this.lastDiagnosticsAt = now;
    const snapshot = this.lastSnapshot;
    const progressPresent = readProgress(document) !== null;
    this.callbacks.onDiagnostics({
      regionFound: snapshot?.regionFound ?? false,
      strategy: snapshot?.strategy ?? null,
      confidence: snapshot?.confidence ?? 'none',
      questionKey: this.currentKey,
      progress: snapshot?.progress ?? null,
      progressRaw: readProgress(document)?.raw ?? null,
      evaluateCount: this.evaluateCount,
      lastEvaluateAt: this.lastEvaluateAt,
      lastReason: this.lastReason,
      stopped: this.stopped,
      pollTicks: this.pollTicks,
      mutationCallbacks: this.mutationCallbacks,
      pendingCandidate: false,
      regionConnected: snapshot?.regionFound ?? false,
      progressContainerConnected: progressPresent,
      hasRegionObserver: false,
      hasProgressObserver: false,
      hasBodyObserver: this.observer !== null,
      pollTimerActive: this.pollTimer !== null,
      notes: [`screen: ${this.lastScreen ?? 'unread'}`, note],
      errors: [],
    });
  }

  /**
   * Refresh diagnostics without re-reading the page. Called on a slow cadence
   * by the controller so the panel's support attribute stays truthful.
   */
  refreshDiagnostics(): void {
    this.emitDiagnostics(false, 'refresh');
  }

  /** Re-read the page and force a diagnostics emission. */
  flushDiagnostics(reason: string): void {
    this.lastDiagnosticsAt = 0;
    this.evaluate(reason, true);
  }
}
