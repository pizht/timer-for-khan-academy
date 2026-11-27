/**
 * Coordinator: executes the timing flow for the page.
 *
 * Every DECISION - when a question starts, when its clock stops, when it is
 * frozen, parked, recorded, when the end-of-set card opens - is made by
 * `src/flow.ts`, a pure function of the page readings and the learner's
 * clicks. This class feeds it those inputs and carries out the effects it
 * returns:
 *
 *  - owns the single active `TimerEngine` and the storage it writes
 *    (sessions, records, runs, attempt windows),
 *  - drives the overlay render loop from timestamps (never from tick counts),
 *  - checkpoints the in-flight session so closing the page does not lose data,
 *  - applies settings changes arriving from the popup,
 *  - answers popup queries with live status and diagnostics.
 *
 * Effects run one after another on a single chain, each with the time its input
 * happened, so a question can never be completed before it has started or
 * recorded after the next one began, however long a storage call takes.
 *
 * Write policy: storage is written on *state changes* (start, pause, resume,
 * reset, question change) and at most once per `CHECKPOINT_INTERVAL_MS` while
 * running — never once per DOM mutation (spec 5.3).
 */

import { INITIAL_FLOW, isTimingOnScreen, step, type FlowEffect, type FlowInput, type FlowState, type QuestionRef } from './flow.js';
import { PageWatcher, type WatcherDiagnostics } from './page-watcher.js';
import { OVERLAY_HOST_ID, OverlayView, type OverlayState } from './overlay.js';
import { SummaryView, buildSummaryRows } from './summary-view.js';
import { TimerEngine, formatDuration } from './timer-engine.js';
import { render, setLocale, type MessageRef } from './i18n/index.js';
import { disposeAudio, playExpiryTone } from './sound.js';
import {
  chromeStorageArea,
  createRecordQueue,
  ensureAttemptWindow,
  loadAttemptWindow,
  markAttemptSummarized,
  clearRun,
  clearSession,
  loadRecords,
  loadRun,
  loadSession,
  loadSettings,
  parkedSession,
  pruneSessions,
  attemptRecordsFor,
  sanitizeSettings,
  saveRun,
  saveSession,
  saveSettings,
  type RecordQueue,
  type StorageArea,
} from './storage.js';
import {
  CORRECT_INDICATORS,
  INCORRECT_INDICATORS,
  SKIP_BUTTON,
  START_OVER_BUTTON,
  SUBMIT_BUTTON,
  SUMMARY_HOST,
  exerciseKeyFromUrl,
  isStartCardPresent,
  progressLabel,
  readSubmissionOutcome,
  type PageState,
} from './site-profile.js';
import type {
  ActiveRun,
  EndReason,
  FirstSubmissionOutcome,
  QuestionRecord,
  Settings,
  SummaryRow,
  TimerSnapshot,
} from './types.js';
import { secondsToMs, uniqueId } from './util.js';

/** How often the overlay display is refreshed. Values come from timestamps. */
const TICK_INTERVAL_MS = 250;
/** Upper bound on how often a running session is written to storage. */
const CHECKPOINT_INTERVAL_MS = 5000;
/** Sessions shorter than this are treated as detection noise, not records. */
const MIN_RECORD_MS = 1000;
/** Delay before reading the feedback area to decide correct/incorrect. */
const FEEDBACK_SETTLE_MS = 350;
/** Delay after "Start over" before the regenerated question is read. */
const START_OVER_SETTLE_MS = 400;

export class ContentController {
  private area: StorageArea | null = null;
  private settings!: Settings;
  private engine: TimerEngine | null = null;
  /** The question `engine` is timing, as the flow named it when it began. */
  private timed: QuestionRef | null = null;
  private watcher: PageWatcher | null = null;
  private overlay: OverlayView | null = null;

  /** Every timing decision lives here; see `src/flow.ts`. */
  private flow: FlowState = INITIAL_FLOW;
  /** Effects run strictly in order on this chain. */
  private effects: Promise<void> = Promise.resolve();

  private recordsCount = 0;
  private tickTimer: number | null = null;
  private lastCheckpointAt = 0;
  private lastEvent: MessageRef = { key: 'event.initializing' };
  private watcherDiagnostics: WatcherDiagnostics | null = null;
  private currentExerciseKey = '';
  private submissionListenerInstalled = false;
  private started = false;
  private disposed = false;
  private tickCount = 0;

  /** Serialised writer for the saved timing records. */
  private recordQueue: RecordQueue = createRecordQueue(null);
  /** The run (one pass through the exercise) that records are tagged with. */
  private run: ActiveRun | null = null;
  /**
   * The record of the current question once its clock has stopped (answered or
   * skipped), held until the question actually changes. The end-of-exercise
   * summary needs the last question's row, and that question never "changes",
   * so this is what `enter-summary` writes out.
   */
  private pendingRecord: QuestionRecord | null = null;
  /**
   * The last record that reached storage. A question answered and then left on
   * screen is written once - when the learner leaves the page, or when the page
   * moves on - and this is what stops the same stretch being written again when
   * the learner comes back to it (a tab switch, a reload, a detour through
   * another practice): see `isStored`.
   */
  private storedRecord: QuestionRecord | null = null;
  /** Rows of the summary currently on screen, kept so a settings change can re-render it. */
  private summaryRows: SummaryRow[] = [];
  private summaryView: SummaryView | null = null;

  /** The last event, in the locale in force right now. */
  private get lastEventText(): string {
    return render(this.lastEvent);
  }

  /**
   * A question is being timed but the page is not showing it: its clock is
   * frozen and the panel is hidden. Said in the popup, and nowhere once the
   * question is back.
   */
  private get warningText(): string | null {
    const question = this.flow.question;
    if (!question || this.flow.summary || isTimingOnScreen(this.flow)) return null;
    const reason = document.querySelector('form[name="answerform"]')
      ? 'no stable identity signal for this question'
      : 'question region not found';
    return render({ key: 'warning.uncertainPaused', params: { reason } });
  }

  async init(): Promise<void> {
    this.area = chromeStorageArea();
    this.recordQueue = createRecordQueue(this.area);
    this.settings = await loadSettings(this.area);
    // Resolve the language before anything is mounted or rendered, so the panel
    // is born in the right one instead of being re-lettered a frame later.
    setLocale(this.settings.language);

    const now = Date.now();
    this.recordsCount = (await loadRecords(this.area)).length;
    void pruneSessions(this.area, now);

    this.overlay = new OverlayView(
      {
        onTogglePause: () => this.togglePause(),
        onReset: () => this.resetCurrentQuestion(),
        onToggleCollapse: (collapsed) => void this.updateSettings({ overlayCollapsed: collapsed }),
        onPositionChange: (overlayPosition) => void this.updateSettings({ overlayPosition }),
      },
      this.settings,
    );
    this.overlay.mount();

    this.watcher = new PageWatcher({
      onReading: (page, url) => this.dispatch({ type: 'page', page, url }),
      onDiagnostics: (info) => {
        this.watcherDiagnostics = info;
        this.publishDiagnostics();
      },
    });
    this.watcher.start();

    this.tickTimer = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.installSubmissionListener();
    this.installNavigationListener();
    this.installLifecycleHooks();
    this.installExtensionHooks();
    this.started = true;
    this.render();
  }

  /* ------------------------------------------------------------ *
   * The flow: inputs in, effects out
   * ------------------------------------------------------------ */

  private dispatch(input: FlowInput): void {
    if (this.disposed) return;
    const at = Date.now();
    const { state, effects } = step(this.flow, input);
    this.flow = state;
    for (const effect of effects) {
      this.effects = this.effects
        .then(() => this.execute(effect, at))
        .catch(() => undefined)
        .then(() => this.render());
    }
    this.render();
  }

  private async execute(effect: FlowEffect, at: number): Promise<void> {
    switch (effect.type) {
      case 'begin':
        return this.beginQuestion(effect.question, at, effect.restore);
      case 'complete':
        return this.completeCurrentQuestion(at, effect.reason);
      case 'finalize':
        return this.finalizeCurrentQuestion(at, effect.reason);
      case 'park':
        return this.parkCurrentQuestion(at);
      case 'freeze':
        return this.freeze(at);
      case 'unfreeze':
        return this.unfreeze(at);
      case 'outcome':
        return this.applyOutcome(effect.outcome);
      case 'enter-summary':
        return this.enterSummary(at);
      case 'leave-summary':
        return this.leaveSummary();
    }
  }

  /* ------------------------------------------------------------ *
   * Effects
   * ------------------------------------------------------------ */

  private async beginQuestion(question: QuestionRef, now: number, allowRestore: boolean): Promise<void> {
    const exerciseKey = question.exerciseKey;
    this.currentExerciseKey = exerciseKey;
    // Open this attempt's window (or keep it): the card is later built from
    // "everything on this practice since the window opened", which survives the
    // attempt id being lost in the middle.
    await ensureAttemptWindow(this.area, exerciseKey, now);

    // One run per pass through the exercise. Reused across page reloads so the
    // summary still covers the whole attempt; replaced once its summary has
    // been shown, or when it is too old to belong to this attempt.
    let run = await loadRun(this.area, exerciseKey, now);
    if (!run) {
      run = {
        version: 1,
        runId: uniqueId('run'),
        exerciseKey,
        startedAt: now,
        summarizedAt: null,
        lastQuestionIndex: question.index,
      };
      void saveRun(this.area, run);
    }
    this.run = run;

    let engine: TimerEngine | null = null;
    if (allowRestore && this.settings.resumeAcrossReload) {
      const session = await loadSession(this.area, exerciseKey, now);
      if (session && session.questionKey === question.key) {
        engine = TimerEngine.restore(session, now);
      }
    }
    const restored = engine !== null;
    engine ??= new TimerEngine({
      mode: this.settings.defaultMode,
      limitMs:
        this.settings.defaultMode === 'countdown'
          ? secondsToMs(this.settings.countdownLimitSeconds)
          : null,
      questionKey: question.key,
      exerciseKey,
      now,
    });

    this.engine = engine;
    this.timed = question;
    this.lastEvent = { key: restored ? 'event.resumed' : 'event.started' };
    this.lastCheckpointAt = now;
    void saveSession(this.area, engine.serialize(now));

    if (restored) {
      // Tell the flow what the restored clock is: answered already, paused by
      // the learner, or with an answer submitted.
      this.flow = step(this.flow, {
        type: 'restored',
        submitted: engine.getFirstSubmission() !== null,
        finished: engine.getPhase() === 'finished',
        paused: engine.getPhase() === 'paused',
      }).state;
      // A question answered before the reload whose record never reached
      // storage gets it now (and is not written twice if it did).
      if (engine.getPhase() === 'finished') this.completeCurrentQuestion(now, 'answered-correct');
    }
  }

  /**
   * Stop timing the current question the moment the learner is done with it —
   * they answered correctly, or they confirmed a skip.
   *
   * The record is built now (so its duration is frozen at this instant) but is
   * held in `pendingRecord` rather than written, because the end-of-exercise
   * summary needs the last question's row and the question has not changed yet.
   */
  private completeCurrentQuestion(now: number, reason: EndReason): void {
    const engine = this.engine;
    if (!engine) return;

    // Self-heal: a held record belonging to a DIFFERENT question would block
    // this one's completion and silently lose a whole row. Persist it.
    const held = this.pendingRecord;
    if (held !== null && held.questionIndex !== null && held.questionIndex !== (this.timed?.index ?? null)) {
      this.pendingRecord = null;
      void this.queueRecord(held);
    }
    if (this.pendingRecord !== null) return;

    if (engine.getPhase() === 'finished') {
      const final = engine.snapshot(now);
      // The question is finished AND already stored: the learner answered it,
      // left the page (which wrote the held record out) and came back to it. It
      // is one question, timed once, and it already has its record.
      if (this.isStored(engine, final.startedAt)) return;
      this.pendingRecord = this.buildRecord(engine, final, now, reason);
      return;
    }
    const final = engine.finish(now, reason);
    this.pendingRecord = this.buildRecord(engine, final, now, reason);
    this.lastEvent = { key: reason === 'skipped' ? 'event.skipped' : 'event.answeredCorrect' };
    void this.checkpoint(now, true);
  }

  /**
   * Is the stretch the engine is timing already in storage?
   *
   * Compared through the storage layer's own identity for a stretch (practice +
   * question + start), so this can only ever be true for the very same timing of
   * the very same question - see `storedRecord`.
   */
  private isStored(engine: TimerEngine, startedAt: number | null): boolean {
    const stored = this.storedRecord;
    if (stored === null || startedAt === null) return false;
    return (
      stored.exerciseKey === engine.exerciseKey &&
      stored.questionKey === engine.questionKey &&
      stored.startedAt === startedAt
    );
  }

  private async finalizeCurrentQuestion(now: number, reason: EndReason): Promise<void> {
    const engine = this.engine;
    // A question that already completed keeps its frozen duration; the reason
    // recorded is the one that actually stopped the clock.
    const held = this.pendingRecord;
    this.pendingRecord = null;

    if (!engine) {
      if (held) await this.queueRecord(held);
      return;
    }

    const final = engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, reason);
    // A question whose record is already stored (the learner left the page on it
    // and came back) is not recorded a second time - see `storedRecord`.
    const record =
      held ??
      (this.isStored(engine, final.startedAt) ? null : this.buildRecord(engine, final, now, reason));
    this.engine = null;
    this.timed = null;
    await clearSession(this.area, engine.exerciseKey);
    if (record === null) return;

    // A question abandoned almost instantly, with no answer ever submitted, is
    // far more likely to be noise than a real attempt.
    if (
      record.durationMs < MIN_RECORD_MS &&
      record.firstSubmissionAt === null &&
      record.endReason !== 'skipped'
    ) {
      return;
    }
    await this.queueRecord(record);
  }

  /**
   * Append a record through the single serialised writer (see
   * `createRecordQueue`). Landing here is also what marks the question as
   * recorded, which stops the same question from being written again while it
   * is still the one on screen: see `storedRecord`.
   */
  private async queueRecord(record: QuestionRecord): Promise<void> {
    const saved = await this.recordQueue.add(record);
    if (saved) {
      this.recordsCount = saved.length;
      this.storedRecord = record;
    }
  }

  /**
   * The learner left the practice the question belongs to - for another
   * practice, or a page with no question at all.
   *
   *  - a question already answered or skipped, whose record is still held, is
   *    written now: the learner may never come back;
   *  - a question still being timed keeps its accumulated time in a session, so
   *    returning continues from where the learner stopped.
   *
   * The engine itself is dropped, so the previous practice's clock is never
   * rendered on the next page.
   */
  private parkCurrentQuestion(now: number): void {
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    this.timed = null;
    const held = this.pendingRecord;
    this.pendingRecord = null;

    if (held) {
      void clearSession(this.area, engine.exerciseKey);
      void this.queueRecord(held);
      this.lastEvent = { key: 'event.switchedSaved' };
    } else {
      const frozen =
        engine.getPhase() === 'finished' ? engine.snapshot(now) : engine.finish(now, 'navigation');
      void saveSession(this.area, parkedSession(engine.serialize(now), frozen.elapsedMs, now));
      this.lastEvent = { key: 'event.switchedParked' };
    }
  }

  /** The page stopped showing the question: freeze its clock (an automatic pause). */
  private freeze(now: number): void {
    const engine = this.engine;
    if (!engine || engine.getPhase() !== 'running') return;
    // Automatic: the learner did not press Pause, so `wasPaused` stays false.
    engine.pause(now, true);
    this.lastEvent = { key: 'event.unidentifiedPaused' };
    void this.checkpoint(now, true);
  }

  /** The same question is back: carry on from the value it was frozen at. */
  private unfreeze(now: number): void {
    const engine = this.engine;
    if (!engine || engine.getPhase() !== 'paused') return;
    engine.resume(now);
    this.lastEvent = { key: 'event.identityRestored' };
    void this.checkpoint(now, true);
  }

  /**
   * The page graded the first answer. Applied only if an answer was submitted;
   * never overwrites a known outcome (see `setFirstSubmissionOutcome`).
   */
  private applyOutcome(outcome: 'correct' | 'incorrect'): void {
    const engine = this.engine;
    if (engine && engine.setFirstSubmissionOutcome(outcome)) void this.checkpoint(Date.now(), true);
  }

  private buildRecord(
    engine: TimerEngine,
    final: TimerSnapshot,
    now: number,
    reason: EndReason,
  ): QuestionRecord {
    const submission = engine.getFirstSubmission();
    return {
      id: uniqueId('rec'),
      questionKey: engine.questionKey,
      exerciseKey: engine.exerciseKey,
      startedAt: final.startedAt ?? now,
      endedAt: now,
      durationMs: final.elapsedMs,
      pausedMs: final.pausedMs,
      mode: final.mode,
      limitMs: final.limitMs,
      timedOut: final.expired,
      firstSubmissionAt: submission?.at ?? null,
      firstSubmissionOutcome: submission?.outcome ?? null,
      endReason: reason,
      status: reason === 'skipped' ? 'skipped' : final.expired ? 'expired' : reason === 'page-unload' ? 'partial' : 'completed',
      detectionConfidence: 'stable-id',
      wasPaused: engine.hasSeenPause(),
      runId: this.run?.runId ?? '',
      // Bound when the question began, while it was the one on screen: a record
      // written later, when the page has moved on, keeps this number.
      questionIndex: this.timed?.index ?? null,
      questionTotal: this.timed?.total ?? null,
    };
  }

  /* ------------------------------------------------------------ *
   * End-of-exercise summary
   * ------------------------------------------------------------ */

  private async enterSummary(now: number): Promise<void> {
    const questionTotal = this.timed?.total ?? null;
    // The last question never "changed", so its held record is written here.
    // This is also what makes it available as a summary row.
    await this.finalizeCurrentQuestion(now, 'exercise-complete');

    const exerciseKey = this.currentExerciseKey || exerciseKeyFromUrl(location.href);
    const runId = this.run?.runId ?? '';
    if (this.run) {
      this.run = { ...this.run, summarizedAt: now };
      void saveRun(this.area, this.run);
    }
    // The attempt boundary for this practice, independent of the run id: the
    // card lists what the learner did since the previous summary was shown.
    void markAttemptSummarized(this.area, exerciseKey, now);
    this.lastEvent = { key: 'event.summaryShown' };

    // Every row below is read from storage: make sure the record of the last
    // question (and any write still in flight) has landed first.
    await this.recordQueue.flush();
    const records = await loadRecords(this.area);
    // Retrieved by PRACTICE, then by the attempt window, and only then by run
    // id: a card can never show another exercise's rows, and the questions
    // timed before a detour through another practice are found again.
    const window = await loadAttemptWindow(this.area, exerciseKey);
    const attempt = attemptRecordsFor(records, exerciseKey, runId, window?.since ?? null);
    // A table of the exercise's questions in question order, with a "No data"
    // row for a number this attempt never timed.
    const total =
      attempt.reduce((max, record) => Math.max(max, record.questionTotal ?? 0), 0) || questionTotal;
    const rows: SummaryRow[] = buildSummaryRows({ records: attempt, questionTotal: total });

    // The learner may already have left while this was loading.
    if (this.flow.summary === null) return;
    const host = this.findSummaryHost();
    if (!host) {
      this.lastEvent = { key: 'event.summaryNoHost' };
      return;
    }
    this.summaryRows = rows;
    this.summaryView =
      this.summaryView ??
      new SummaryView({
        onToggleCollapsed: (collapsed) => void this.updateSettings({ summaryCollapsed: collapsed }),
      });
    this.summaryView.mount(host.element, host.insert);
    this.renderSummary();
  }

  private leaveSummary(): void {
    this.summaryView?.destroy();
    this.summaryView = null;
    // A new attempt: forget the finished run so records start a fresh one.
    const exerciseKey = this.currentExerciseKey;
    if (exerciseKey) void clearRun(this.area, exerciseKey);
    this.run = null;
    this.pendingRecord = null;
    this.summaryRows = [];
    this.lastEvent = { key: 'event.newAttempt' };
  }

  /** Re-render the card from the last rows and the current settings. */
  private renderSummary(): void {
    this.summaryView?.render({
      rows: this.summaryRows,
      collapsed: this.settings.summaryCollapsed,
    });
  }

  private findSummaryHost(): { element: Element; insert: 'before-host' | 'append' } | null {
    for (const strategy of SUMMARY_HOST) {
      let element: Element | null = null;
      try {
        element = strategy.select(document);
      } catch {
        continue;
      }
      if (element) return { element, insert: strategy.insert };
    }
    return null;
  }

  /* ------------------------------------------------------------ *
   * Learner actions on the panel
   * ------------------------------------------------------------ */

  private togglePause(): void {
    const engine = this.engine;
    if (!engine) return;
    const now = Date.now();
    const pausing = engine.getPhase() !== 'paused';
    if (pausing) {
      // A learner-requested pause is never auto-resumed later.
      engine.pause(now);
      this.lastEvent = { key: 'event.pausedManual' };
    } else {
      engine.resume(now);
      this.lastEvent = { key: 'event.resumedManual' };
    }
    void this.checkpoint(now, true);
    this.dispatch({ type: 'learner-pause', paused: pausing });
  }

  private resetCurrentQuestion(): void {
    const engine = this.engine;
    if (!engine) return;
    const now = Date.now();
    engine.reset(now, true);
    // Resetting after answering correctly puts the question back under timing,
    // so drop the held "completed" record for this question.
    this.pendingRecord = null;
    this.lastEvent = { key: 'event.reset' };
    void this.checkpoint(now, true);
    // The flow re-freezes the clock if the page is not showing the question.
    this.dispatch({ type: 'reset' });
  }

  /* ------------------------------------------------------------ *
   * Diagnostics
   * ------------------------------------------------------------ */

  /**
   * Mirror the extension's view of the page onto the overlay host element as
   * `data-khan-timer-diagnostics`, so "the panel is stuck" is diagnosable from
   * the page itself. It carries no user data - only what was read, the flow's
   * state and counters.
   */
  private publishDiagnostics(): void {
    const host = document.getElementById(OVERLAY_HOST_ID);
    if (!host) return;
    const watcher = this.watcherDiagnostics;
    const question = this.flow.question;
    const summary = {
      evaluateCount: watcher?.evaluateCount ?? 0,
      lastReason: watcher?.lastReason ?? 'init',
      sinceEvaluateMs: watcher?.lastEvaluateAt ? Date.now() - watcher.lastEvaluateAt : null,
      regionFound: watcher?.regionFound ?? false,
      screen: this.flow.page?.screen ?? 'unread',
      progress: watcher?.progress ?? null,
      progressRaw: watcher?.progressRaw ?? null,
      questionKey: question?.key ?? null,
      engineQuestionKey: this.engine?.questionKey ?? null,
      lastEvent: this.lastEventText,
      /**
       * The page is not showing a question being solved, and whether this
       * question's clock was frozen because of it. Readable from the page even
       * while the panel itself is hidden.
       */
      unidentified: this.flow.page?.screen !== 'question',
      autoPausedForIdentity: question?.frozen ?? false,
      enginePhase: this.engine?.getPhase() ?? null,
      flow: {
        summary: this.flow.summary !== null,
        done: question?.done ?? null,
        skipArmed: this.flow.skipArmed,
        learnerPaused: this.flow.learnerPaused,
      },
      stopped: watcher?.stopped ?? true,
      pollTicks: watcher?.pollTicks ?? 0,
      mutationCallbacks: watcher?.mutationCallbacks ?? 0,
      tickCount: this.tickCount,
      disposed: this.disposed,
      visibility: document.visibilityState,
      hidden: document.hidden,
    };
    host.setAttribute('data-khan-timer-diagnostics', JSON.stringify(summary));
  }

  /** The detection details the popup shows. */
  private statusDiagnostics(): Record<string, unknown> {
    const page: PageState | null = this.flow.page;
    const formPresent = document.querySelector('form[name="answerform"]') !== null;
    const position = page?.question ?? null;
    return {
      regionFound: formPresent,
      strategy: formPresent ? 'perseus-answerform' : null,
      confidence: page?.screen === 'question' ? 'stable-id' : 'none',
      questionKey: this.flow.question?.key ?? null,
      progress: position ? progressLabel({ ...position, raw: '' }) : null,
      notes: [`screen: ${page?.screen ?? 'unread'}`],
      errors: [],
    };
  }

  /* ------------------------------------------------------------ *
   * Ticking, checkpointing, rendering
   * ------------------------------------------------------------ */

  private tick(): void {
    this.tickCount += 1;
    if (!this.started) return;
    const now = Date.now();
    const engine = this.engine;
    if (engine && engine.getPhase() === 'running') {
      const result = engine.tick(now);
      if (result.expiredJustNow && this.settings.soundEnabled) {
        if (playExpiryTone()) this.lastEvent = { key: 'event.countdownEndedTone' };
        else this.lastEvent = { key: 'event.countdownEndedToneBlocked' };
      } else if (result.expiredJustNow) {
        this.lastEvent = { key: 'event.countdownEnded' };
      }
      if (now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
        void this.checkpoint(now, false);
      }
    }
    // Refresh the diagnostics roughly once a second so the support attribute
    // reflects reality even when nothing is changing.
    if (this.tickCount % 4 === 0) this.watcher?.refreshDiagnostics();
    this.render();
  }

  private async checkpoint(now: number, force: boolean): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.settings.resumeAcrossReload) return;
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    this.lastCheckpointAt = now;
    await saveSession(this.area, engine.serialize(now));
  }

  /**
   * Should the floating panel be on screen? Only while the question being timed
   * is the one the page is showing - not on start cards, lesson pages, videos,
   * the end screen, while the question is off screen, or on another practice -
   * and the learner has not turned the overlay off.
   */
  private shouldShowPanel(): boolean {
    if (!this.settings.overlayVisible) return false;
    const engine = this.engine;
    if (!engine || engine.questionKey !== this.timed?.key) return false;
    return isTimingOnScreen(this.flow) && this.flow.question?.key === engine.questionKey;
  }

  private render(): void {
    if (!this.overlay) return;
    this.overlay.setVisible(this.shouldShowPanel());
    const now = Date.now();
    const engine = this.engine;
    const snapshot = engine ? engine.snapshot(now) : null;
    const question = this.flow.question;

    const state: OverlayState = {
      mode: snapshot?.mode ?? this.settings.defaultMode,
      phase: snapshot?.phase ?? 'idle',
      expired: snapshot?.expired ?? false,
      elapsedMs: snapshot?.elapsedMs ?? 0,
      remainingMs: snapshot?.remainingMs ?? null,
      limitMs: snapshot?.limitMs ?? null,
      questionKey: engine?.questionKey ?? null,
      progress: question ? progressLabel({ ...question, state: question.state, raw: '' }) : null,
      confidence: question ? 'stable-id' : 'none',
      warning: this.warningText,
      lastEvent: this.lastEventText,
      savedRecords: this.recordsCount,
    };
    this.overlay.render(state);
    this.publishDiagnostics();
  }

  /* ------------------------------------------------------------ *
   * Clicks on the page: Check, Skip, Start over
   * ------------------------------------------------------------ */

  private installSubmissionListener(): void {
    if (this.submissionListenerInstalled) return;
    this.submissionListenerInstalled = true;
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${OVERLAY_HOST_ID}`)) return;
        if (clickedControl(target, SUBMIT_BUTTON) === null) return;
        this.noteSubmission(Date.now());
        // Submitting through Check is not a skip, even if Skip was opened and
        // dismissed earlier.
        this.dispatch({ type: 'submit' });
      },
      true,
    );
  }

  private noteSubmission(at: number): void {
    const engine = this.engine;
    if (!engine) return;
    const isFirst = engine.markFirstSubmission(at, 'unknown');
    if (isFirst) {
      this.lastEvent = { key: 'event.firstSubmission' };
      void this.checkpoint(Date.now(), true);
    }
    // The feedback area renders shortly after the click; read it once settled.
    window.setTimeout(() => {
      const outcome = this.readFeedbackOutcome();
      if (outcome === 'unknown') return;
      const engineNow = this.engine;
      if (!engineNow) return;
      if (engineNow.setFirstSubmissionOutcome(outcome)) {
        this.lastEvent = {
          key:
            outcome === 'correct' ? 'event.firstSubmissionCorrect' : 'event.firstSubmissionIncorrect',
        };
        void this.checkpoint(Date.now(), true);
        this.render();
      }
    }, FEEDBACK_SETTLE_MS);
  }

  private readFeedbackOutcome(): FirstSubmissionOutcome {
    // Primary: the progress marker's state segment, e.g. "...-incorrect-current".
    // Structural and locale-independent (verified by observation).
    const structural = readSubmissionOutcome(document);
    if (structural !== 'unknown') return structural;

    // Fallback for page types without a progress marker: the feedback dialog.
    const test = (strategies: typeof CORRECT_INDICATORS): boolean => {
      for (const strategy of strategies) {
        try {
          if (strategy.select(document)) return true;
        } catch {
          /* invalid selector: skip */
        }
      }
      return false;
    };
    if (test(INCORRECT_INDICATORS)) return 'incorrect';
    if (test(CORRECT_INDICATORS)) return 'correct';
    return 'unknown';
  }

  /**
   * Skip only stops the clock once it is CONFIRMED (the flow sees the page
   * close the question). "Start over" regenerates a fresh problem at the same
   * position, which no reading can tell apart from the old one, so the click
   * itself is the signal.
   */
  private installNavigationListener(): void {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${OVERLAY_HOST_ID}`)) return;
        if (clickedControl(target, SKIP_BUTTON) !== null) {
          this.lastEvent = { key: 'event.skipClicked' };
          this.dispatch({ type: 'skip' });
          return;
        }
        if (clickedControl(target, START_OVER_BUTTON) === null) return;
        // Let the SPA swap the question, then start it from scratch.
        window.setTimeout(() => {
          this.dispatch({ type: 'start-over' });
          this.watcher?.reread('start-over');
        }, START_OVER_SETTLE_MS);
      },
      true,
    );
  }

  /* ------------------------------------------------------------ *
   * Lifecycle and extension hooks
   * ------------------------------------------------------------ */

  private installLifecycleHooks(): void {
    // Persist before the page goes away so closing mid-question is not lossy.
    const flush = (): void => {
      const now = Date.now();
      void this.checkpoint(now, true);
      if (this.engine) void saveSession(this.area, this.engine.serialize(now));
      // A question already finished whose record is still held must be written
      // NOW: the learner is leaving, and nothing else will ever finalise it.
      const held = this.pendingRecord;
      if (held) {
        this.pendingRecord = null;
        void this.queueRecord(held);
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  private installExtensionHooks(): void {
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const change = changes['settings'];
        if (!change) return;
        const previous = this.settings;
        this.settings = sanitizeSettings(change.newValue);
        // A language change must reach everything already on screen. Event and
        // warning text are stored as message references and re-rendered from
        // the catalog on every paint, so a stale translation cannot survive.
        if (previous.language !== this.settings.language) {
          setLocale(this.settings.language);
          this.overlay?.applyLanguage();
          this.summaryView?.applyLanguage();
        }
        this.overlay?.applySettings(this.settings);

        // Apply a mode / limit change to the question being timed, so the user
        // gets immediate feedback. Elapsed time is preserved (spec 2.2).
        const engine = this.engine;
        if (engine && engine.getPhase() !== 'finished') {
          const modeChanged = previous.defaultMode !== this.settings.defaultMode;
          const limitChanged = previous.countdownLimitSeconds !== this.settings.countdownLimitSeconds;
          if (modeChanged || (limitChanged && this.settings.defaultMode === 'countdown')) {
            const now = Date.now();
            engine.setMode(
              this.settings.defaultMode,
              this.settings.defaultMode === 'countdown'
                ? secondsToMs(this.settings.countdownLimitSeconds)
                : null,
              now,
            );
            this.lastEvent = {
              key: this.settings.defaultMode === 'countdown' ? 'event.modeCountdown' : 'event.modeCountup',
            };
            void this.checkpoint(now, true);
          }
        }
        this.render();
      });
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        if (!isStatusRequest(message)) return undefined;
        void this.buildStatusResponse().then(sendResponse);
        return true; // keep the channel open for the async response
      });
    }
  }

  private async buildStatusResponse(): Promise<unknown> {
    const now = Date.now();
    const engine = this.engine;
    const snapshot = engine ? engine.snapshot(now) : null;
    const records = await loadRecords(this.area);
    return {
      ok: true,
      settings: this.settings,
      url: location.href,
      exerciseKey: this.currentExerciseKey,
      questionKey: engine?.questionKey ?? null,
      display: formatDuration(
        snapshot?.mode === 'countdown' && !snapshot.expired
          ? (snapshot.remainingMs ?? 0)
          : (snapshot?.elapsedMs ?? 0),
      ),
      snapshot,
      savedRecords: records.length,
      recent: records.slice(-10),
      diagnostics: this.statusDiagnostics(),
      warning: this.warningText,
      lastEvent: this.lastEventText,
      // The question's clock is frozen because the page stopped showing it. The
      // panel is hidden then, so this is how the learner finds out.
      pausedForUnidentified: this.flow.question?.frozen ?? false,
      // Quiz / unit-test / course-challenge pages sit behind an intro card, so
      // "no question yet" there means "not started", not "unsupported".
      startCard: isStartCardPresent(document),
    };
  }

  private async updateSettings(patch: Partial<Settings>): Promise<void> {
    const next: Settings = { ...this.settings, ...patch };
    this.settings = next;
    this.overlay?.applySettings(next);
    await saveSettings(this.area, next);
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.watcher?.stop();
    this.overlay?.destroy();
    disposeAudio();
  }
}

/**
 * Does a clicked element belong to the control described by one of these
 * strategies? Resolves the strategy's element from the document and checks
 * containment, so a click on an inner `<span>` label still counts.
 */
function clickedControl(target: Element, strategies: typeof SUBMIT_BUTTON): string | null {
  for (const strategy of strategies) {
    let element: Element | null = null;
    try {
      element = strategy.select(document);
    } catch {
      continue;
    }
    if (element && (element === target || element.contains(target))) return strategy.name;
  }
  return null;
}

function isStatusRequest(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'khan-timer:get-status'
  );
}
