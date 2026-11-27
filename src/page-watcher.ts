/**
 * Watches the page and hands every NEW reading of it to the controller.
 *
 * The page maintains its own discrete markers - which question of the set is
 * current (`exercise-progress-<index>-<state>-current`), whether the answer form
 * is up, the start card, the end screen - and `readPage` (in `site-profile.ts`)
 * turns them into one small value. This module re-reads that value whenever the
 * document changes and passes it on when it differs from the last one. What a
 * difference MEANS (a new question, an answer, the end of the set) is decided
 * by `src/flow.ts`, not here.
 *
 * One MutationObserver on the document triggers a reading (throttled), and a
 * slow poll catches URL changes that touch nothing the observer watches.
 *
 * What this replaced [VER], see `readPage`: identity by fingerprinting the
 * question region, a 400 ms de-bounce and 1200 ms cooldown before committing a
 * change, and three observers bound to individual subtrees that had to be
 * re-bound whenever the SPA replaced one. The position the page reports is
 * discrete and never flapped in any walk; hints, feedback popovers and typing
 * change the region's content, never the reading.
 */

import { progressLabel, readPage, readProgress, type PageState } from './site-profile.js';

export interface WatcherDiagnostics {
  /** The answer form is on the page. */
  regionFound: boolean;
  /** Which screen the last reading was. */
  screen: PageState['screen'] | 'unread';
  /** Position of the last reading, e.g. "3 of 10". */
  progress: string | null;
  /** The raw `-current` test id, for support. */
  progressRaw: string | null;
  /** How many readings were handed on, and why the last one was taken. */
  evaluateCount: number;
  lastEvaluateAt: number;
  lastReason: string;
  stopped: boolean;
  pollTicks: number;
  mutationCallbacks: number;
}

export interface WatcherCallbacks {
  onReading: (page: PageState, url: string) => void;
  onDiagnostics?: (info: WatcherDiagnostics) => void;
}

/** How often the URL is checked, and the page re-read as a safety net. */
const POLL_INTERVAL_MS = 700;
/** Minimum spacing between readings triggered by mutations. */
const EVALUATE_THROTTLE_MS = 100;
/** Minimum spacing between diagnostics emissions to the popup and the page. */
const DIAGNOSTICS_INTERVAL_MS = 1000;
/** The only attributes whose changes can move a reading. */
const WATCHED_ATTRIBUTES = ['data-testid', 'name'];

export class PageWatcher {
  private readonly callbacks: WatcherCallbacks;
  private observer: MutationObserver | null = null;
  private pollTimer: number | null = null;
  private throttleTimer: number | null = null;
  private stopped = true;

  private lastReading = '';
  private lastPage: PageState | null = null;
  private pollTicks = 0;
  private mutationCallbacks = 0;
  private evaluateCount = 0;
  private lastEvaluateAt = 0;
  private lastReason = 'none';
  private lastDiagnosticsAt = 0;

  constructor(callbacks: WatcherCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.observer = new MutationObserver(() => this.onMutation());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    this.pollTimer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.read('start', true);
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.throttleTimer !== null) window.clearTimeout(this.throttleTimer);
    this.pollTimer = null;
    this.throttleTimer = null;
    this.emitDiagnostics(true);
  }

  /** Read the page now and hand the reading on even if it did not change. */
  reread(reason: string): void {
    this.read(reason, true);
  }

  /** Refresh diagnostics without re-reading. Called on a slow cadence. */
  refreshDiagnostics(): void {
    this.emitDiagnostics(false);
  }

  private onMutation(): void {
    this.mutationCallbacks += 1;
    if (this.stopped) return;
    const elapsed = Date.now() - this.lastEvaluateAt;
    if (elapsed >= EVALUATE_THROTTLE_MS) {
      this.read('mutation', false);
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null;
      this.read('mutation-throttled', false);
    }, EVALUATE_THROTTLE_MS - elapsed);
  }

  private poll(): void {
    this.pollTicks += 1;
    if (this.stopped) return;
    this.read('poll', false);
    this.emitDiagnostics(false);
  }

  private read(reason: string, always: boolean): void {
    if (this.stopped) return;
    const url = location.href;
    const page = readPage(document, url);
    const reading = JSON.stringify([url, page]);
    this.lastEvaluateAt = Date.now();
    if (!always && reading === this.lastReading) return;
    this.lastReading = reading;
    this.lastPage = page;
    this.evaluateCount += 1;
    this.lastReason = reason;
    this.callbacks.onReading(page, url);
    this.emitDiagnostics(true);
  }

  private emitDiagnostics(force: boolean): void {
    if (!this.callbacks.onDiagnostics) return;
    const now = Date.now();
    if (!force && now - this.lastDiagnosticsAt <= DIAGNOSTICS_INTERVAL_MS) return;
    this.lastDiagnosticsAt = now;
    const question = this.lastPage?.question ?? null;
    this.callbacks.onDiagnostics({
      regionFound: document.querySelector('form[name="answerform"]') !== null,
      screen: this.lastPage?.screen ?? 'unread',
      progress: question ? progressLabel({ ...question, raw: '' }) : null,
      progressRaw: readProgress(document)?.raw ?? null,
      evaluateCount: this.evaluateCount,
      lastEvaluateAt: this.lastEvaluateAt,
      lastReason: this.lastReason,
      stopped: this.stopped,
      pollTicks: this.pollTicks,
      mutationCallbacks: this.mutationCallbacks,
    });
  }
}
