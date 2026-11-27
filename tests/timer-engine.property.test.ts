/**
 * Model-based property tests for the timer engine (fast-check).
 *
 * The example tests in `timer-engine.test.ts` pin down individual scenarios.
 * These generate random sequences of everything that can happen to one
 * question - time passing, the learner pausing and resuming, automatic freezes,
 * resets, mode/limit changes from the popup, answer submissions, ticks and page
 * reloads - and after every step compare the engine against a deliberately
 * naive model that just adds up time. A failure is shrunk to the shortest
 * sequence that breaks it, and prints a seed + path to replay it:
 *
 *   fc.assert(..., { seed, path })
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeSession } from '../src/storage.js';
import { TimerEngine, formatDuration } from '../src/timer-engine.js';
import type { FirstSubmissionOutcome, TimerMode, TimerPhase } from '../src/types.js';

const T0 = 1_700_000_000_000;

/** What the engine should report, computed the simplest possible way. */
interface Model {
  now: number;
  phase: TimerPhase;
  mode: TimerMode;
  limitMs: number | null;
  elapsedMs: number;
  pausedMs: number;
  /** The learner (not the extension) pressed Pause since the last reset. */
  sawPause: boolean;
  /**
   * A reload happened since the last reset. `sawPause` is not persisted across
   * a reload (KNOWN BUG, see the `it.fails` below), so the main property only
   * checks it until the first reload.
   */
  reloaded: boolean;
  /** A beep was already emitted for the current expiry. */
  beeped: boolean;
  submission: { at: number; outcome: FirstSubmissionOutcome } | null;
}

interface Real {
  engine: TimerEngine;
}

type Cmd = fc.Command<Model, Real>;

/** Every observable the model predicts, checked after each command. */
function checkAgainstModel(m: Model, r: Real): void {
  const { engine } = r;
  expect(engine.getPhase()).toBe(m.phase);
  expect(engine.getMode()).toBe(m.mode);
  expect(engine.getLimitMs()).toBe(m.limitMs);
  expect(engine.elapsedMs(m.now)).toBe(m.elapsedMs);
  expect(engine.totalPausedMs(m.now)).toBe(m.pausedMs);
  expect(engine.getFirstSubmission()).toEqual(m.submission);
  if (!m.reloaded) expect(engine.hasSeenPause()).toBe(m.sawPause);

  const snap = engine.snapshot(m.now);
  expect(snap.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(snap.pausedMs).toBeGreaterThanOrEqual(0);
  if (m.limitMs !== null) {
    expect(snap.remainingMs).toBe(Math.max(0, m.limitMs - m.elapsedMs));
  } else {
    expect(snap.remainingMs).toBeNull();
    expect(snap.expired).toBe(false);
  }
  if (snap.expiredAt !== null) expect(snap.expiredAt).toBeLessThanOrEqual(m.now);
}

class Advance implements Cmd {
  constructor(readonly dt: number) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    m.now += this.dt;
    if (m.phase === 'running') m.elapsedMs += this.dt;
    if (m.phase === 'paused') m.pausedMs += this.dt;
    checkAgainstModel(m, r);
  }
  toString = (): string => `advance(${this.dt})`;
}

class Pause implements Cmd {
  constructor(readonly automatic: boolean) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const changed = r.engine.pause(m.now, this.automatic);
    expect(changed).toBe(m.phase === 'running');
    if (changed) {
      m.phase = 'paused';
      if (!this.automatic) m.sawPause = true;
    }
    checkAgainstModel(m, r);
  }
  toString = (): string => `pause(${this.automatic ? 'auto' : 'learner'})`;
}

class Resume implements Cmd {
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const changed = r.engine.resume(m.now);
    expect(changed).toBe(m.phase === 'paused');
    if (changed) m.phase = 'running';
    checkAgainstModel(m, r);
  }
  toString = (): string => 'resume';
}

class Start implements Cmd {
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const changed = r.engine.start(m.now);
    expect(changed).toBe(m.phase === 'idle' || m.phase === 'paused');
    if (changed) m.phase = 'running';
    checkAgainstModel(m, r);
  }
  toString = (): string => 'start';
}

class Reset implements Cmd {
  constructor(readonly restart: boolean) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    r.engine.reset(m.now, this.restart);
    m.phase = this.restart ? 'running' : 'idle';
    m.elapsedMs = 0;
    m.pausedMs = 0;
    m.sawPause = false;
    m.reloaded = false;
    m.beeped = false;
    m.submission = null;
    checkAgainstModel(m, r);
  }
  toString = (): string => `reset(${this.restart})`;
}

class Finish implements Cmd {
  check = (m: Model): boolean => m.phase !== 'finished';
  run(m: Model, r: Real): void {
    const snap = r.engine.finish(m.now, 'question-change');
    m.phase = 'finished';
    expect(snap.elapsedMs).toBe(m.elapsedMs);
    expect(snap.pausedMs).toBe(m.pausedMs);
    checkAgainstModel(m, r);
  }
  toString = (): string => 'finish';
}

class SetMode implements Cmd {
  constructor(
    readonly mode: TimerMode,
    readonly limitMs: number,
  ) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const limit = this.mode === 'countdown' ? this.limitMs : null;
    const unchanged = this.mode === m.mode && (this.mode === 'countup' || limit === m.limitMs);
    r.engine.setMode(this.mode, limit, m.now);
    if (!unchanged) {
      m.mode = this.mode;
      m.limitMs = limit;
      // A limit that is still in the future starts a fresh expiry; so does
      // leaving countdown altogether.
      if (limit === null || m.elapsedMs < limit) m.beeped = false;
    }
    checkAgainstModel(m, r);
  }
  toString = (): string =>
    this.mode === 'countdown' ? `setMode(countdown, ${this.limitMs})` : 'setMode(countup)';
}

class Tick implements Cmd {
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const tick = r.engine.tick(m.now);
    if (m.limitMs !== null) {
      // Once a tick has looked, "expired" means exactly "used up the limit".
      expect(tick.snapshot.expired).toBe(m.elapsedMs >= m.limitMs);
    }
    // The beep fires at most once per expiry.
    if (tick.expiredJustNow) {
      expect(m.beeped).toBe(false);
      m.beeped = true;
    }
    checkAgainstModel(m, r);
  }
  toString = (): string => 'tick';
}

class Submit implements Cmd {
  constructor(readonly outcome: FirstSubmissionOutcome) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const changed = r.engine.markFirstSubmission(m.now, this.outcome);
    expect(changed).toBe(m.submission === null);
    if (m.submission === null) m.submission = { at: m.now, outcome: this.outcome };
    checkAgainstModel(m, r);
  }
  toString = (): string => `submit(${this.outcome})`;
}

class RefineOutcome implements Cmd {
  constructor(readonly outcome: FirstSubmissionOutcome) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    r.engine.setFirstSubmissionOutcome(this.outcome);
    // Only an unknown outcome is ever upgraded, and never to "unknown".
    if (m.submission && m.submission.outcome === 'unknown' && this.outcome !== 'unknown') {
      m.submission = { ...m.submission, outcome: this.outcome };
    }
    checkAgainstModel(m, r);
  }
  toString = (): string => `refine(${this.outcome})`;
}

/**
 * The page is closed and reopened `gap` ms later. The session goes through the
 * same path as in production: serialise, storage (structured clone), sanitise,
 * restore. Time while the page was closed is not answer time and not pause
 * time (spec 2.2).
 */
class Reload implements Cmd {
  constructor(readonly gap: number) {}
  check = (): boolean => true;
  run(m: Model, r: Real): void {
    const stored = structuredClone(r.engine.serialize(m.now));
    const session = sanitizeSession(stored);
    expect(session).not.toBeNull();
    m.now += this.gap;
    r.engine = TimerEngine.restore(session!, m.now);
    // A question left idle (reset without restart) comes back counting.
    if (m.phase === 'idle') m.phase = 'running';
    m.reloaded = true;
    checkAgainstModel(m, r);
  }
  toString = (): string => `reload(gap=${this.gap})`;
}

const outcome = fc.constantFrom<FirstSubmissionOutcome>('correct', 'incorrect', 'unknown');
const limitMs = fc.integer({ min: 1, max: 120_000 });

const commands = fc.commands(
  [
    fc.integer({ min: 0, max: 90_000 }).map((dt) => new Advance(dt)),
    fc.boolean().map((automatic) => new Pause(automatic)),
    fc.constant(new Resume()),
    fc.constant(new Start()),
    fc.boolean().map((restart) => new Reset(restart)),
    fc.constant(new Finish()),
    fc
      .tuple(fc.constantFrom<TimerMode>('countup', 'countdown'), limitMs)
      .map(([mode, limit]) => new SetMode(mode, limit)),
    fc.constant(new Tick()),
    outcome.map((o) => new Submit(o)),
    outcome.map((o) => new RefineOutcome(o)),
    fc.integer({ min: 0, max: 3_600_000 }).map((gap) => new Reload(gap)),
  ],
  { maxCommands: 60 },
);

const initial = fc.record({
  mode: fc.constantFrom<TimerMode>('countup', 'countdown'),
  limitMs,
});

describe('TimerEngine - model-based properties', () => {
  it('matches a naive add-up-the-time model for any sequence of events', () => {
    fc.assert(
      fc.property(initial, commands, (init, cmds) => {
        const limit = init.mode === 'countdown' ? init.limitMs : null;
        const real: Real = {
          engine: new TimerEngine({
            mode: init.mode,
            limitMs: limit,
            questionKey: 'id:progress:1 of 4',
            exerciseKey: '/math/x/e/addition_4',
            now: T0,
          }),
        };
        const model: Model = {
          now: T0,
          phase: 'running',
          mode: init.mode,
          limitMs: limit,
          elapsedMs: 0,
          pausedMs: 0,
          sawPause: false,
          reloaded: false,
          beeped: false,
          submission: null,
        };
        fc.modelRun(() => ({ model, real }), cmds);
      }),
      { numRuns: 500 },
    );
  });
});

describe('TimerEngine - known bugs found by the properties above', () => {
  /**
   * KNOWN BUG. `wasPaused` on a record means "the learner pressed Pause on this
   * question", but `sawPause` is not part of `TimerSerialized`, so a reload (or
   * leaving and coming back to the practice) forgets it and the record says the
   * question was never paused. Minimal counterexample found by fast-check:
   * `pause(learner), reload(gap=0)`.
   *
   * `it.fails` keeps the suite green while the bug exists and turns RED once it
   * is fixed - then change this to `it` and drop the `reloaded` escape hatch in
   * the model.
   */
  it.fails('remembers that the learner paused the question across a reload', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600_000 }), (gap) => {
        const engine = new TimerEngine({
          mode: 'countup',
          limitMs: null,
          questionKey: 'id:progress:1 of 4',
          exerciseKey: '/math/x/e/addition_4',
          now: T0,
        });
        engine.pause(T0 + 1_000);
        const session = sanitizeSession(structuredClone(engine.serialize(T0 + 2_000)));
        const restored = TimerEngine.restore(session!, T0 + 2_000 + gap);
        expect(restored.hasSeenPause()).toBe(true);
      }),
    );
  });
});

describe('formatDuration - properties', () => {
  const parse = (text: string): number =>
    text.split(':').reduce((total, part) => total * 60 + Number(part), 0);

  it('always shows the whole seconds it was given', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * 3_600_000 }), (ms) => {
        expect(parse(formatDuration(ms))).toBe(Math.floor(ms / 1000));
      }),
    );
  });

  it('never goes backwards as time passes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10 * 3_600_000 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        (a, dt) => {
          expect(parse(formatDuration(a + dt))).toBeGreaterThanOrEqual(parse(formatDuration(a)));
        },
      ),
    );
  });
});
