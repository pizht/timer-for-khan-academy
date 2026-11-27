/**
 * Property tests for storage (fast-check): async interleavings and corrupted
 * input.
 *
 * Interleavings. `chrome.storage.local` is message-passing: every `get` / `set`
 * / `remove` resolves on some later turn, and when several writers are in
 * flight - two operations of one tab, two TABS, or a tab and the popup - the
 * order in which those calls land is up to the browser. `fc.scheduler()` takes
 * over that order: every storage call becomes a task the scheduler releases in
 * a random order, so each run explores another interleaving and a failure is
 * reported (and shrunk) as the exact order that broke it.
 *
 * Corrupted input. Everything read back from storage goes through a
 * `sanitize*` function, because storage may hold data from an older version, a
 * half-written value, or anything else. Those functions must never throw, and
 * must be idempotent: sanitising already-sanitised data changes nothing.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clearRecords,
  createRecordQueue,
  loadRecords,
  sanitizeAttemptWindow,
  sanitizeRecords,
  sanitizeRun,
  sanitizeSession,
  sanitizeSettings,
  type StorageArea,
} from '../src/storage.js';
import type { QuestionRecord } from '../src/types.js';

/** In-memory storage; values are structured-cloned like the real thing. */
class MemoryArea implements StorageArea {
  data: Record<string, unknown> = {};

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const list = keys === null ? Object.keys(this.data) : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in this.data) out[key] = structuredClone(this.data[key]);
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }
}

/**
 * A view of `backing` whose every call is released by the fast-check
 * scheduler. Several views over ONE backing area are several extension
 * contexts (tabs, the popup) sharing one `chrome.storage.local`.
 */
function scheduledArea(s: fc.Scheduler, backing: MemoryArea): StorageArea {
  return {
    get: s.scheduleFunction((keys: string | string[] | null) => backing.get(keys)),
    set: s.scheduleFunction((items: Record<string, unknown>) => backing.set(items)),
    remove: s.scheduleFunction((keys: string | string[]) => backing.remove(keys)),
  };
}

function makeRecord(id: string, exerciseKey: string, position: number): QuestionRecord {
  return {
    id,
    questionKey: `id:progress:${position} of 8`,
    exerciseKey,
    startedAt: 1_700_000_000_000 + position * 60_000,
    endedAt: 1_700_000_000_000 + position * 60_000 + 30_000,
    durationMs: 30_000,
    pausedMs: 0,
    mode: 'countup',
    limitMs: null,
    timedOut: false,
    firstSubmissionAt: null,
    firstSubmissionOutcome: null,
    endReason: 'question-change',
    status: 'completed',
    detectionConfidence: 'stable-id',
    wasPaused: false,
    runId: 'run_prop',
    questionIndex: position - 1,
    questionTotal: 8,
  };
}

describe('record writes under any interleaving', () => {
  it('one tab: every record is kept, in the order it was asked for', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.integer({ min: 1, max: 8 }), async (s, n) => {
        const backing = new MemoryArea();
        const queue = createRecordQueue(scheduledArea(s, backing));
        const ids = Array.from({ length: n }, (_, i) => `rec_${i + 1}`);

        // Fired back to back without awaiting, like the held record flushed
        // when the learner leaves a practice.
        const writes = ids.map((id, i) => queue.add(makeRecord(id, '/x/e/one', i + 1)));
        await s.waitFor(Promise.all(writes));
        await s.waitFor(queue.flush());

        expect((await loadRecords(backing)).map((record) => record.id)).toEqual(ids);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * KNOWN BUG - records are lost across tabs.
   *
   * `createRecordQueue` serialises the read-modify-write of the shared
   * `records` key within ONE content script. Every tab has its own controller
   * and therefore its own queue, so two tabs finishing a question at about the
   * same time both read the old list and the second `set` overwrites the
   * first: one question disappears from the end-of-exercise card.
   *
   * fast-check finds it immediately (tab A get, tab B get, A set, B set). Fix
   * by removing the shared read-modify-write, e.g. one storage key per record,
   * then change `it.fails` to `it`.
   */
  it.fails('two tabs: a record written by each tab at the same time is kept', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 4 }),
        async (s, nA, nB) => {
          const backing = new MemoryArea();
          const tabA = createRecordQueue(scheduledArea(s, backing));
          const tabB = createRecordQueue(scheduledArea(s, backing));
          const idsA = Array.from({ length: nA }, (_, i) => `a_${i + 1}`);
          const idsB = Array.from({ length: nB }, (_, i) => `b_${i + 1}`);

          const writes = [
            ...idsA.map((id, i) => tabA.add(makeRecord(id, '/x/e/one', i + 1))),
            ...idsB.map((id, i) => tabB.add(makeRecord(id, '/x/e/two', i + 1))),
          ];
          await s.waitFor(Promise.all(writes));

          const stored = (await loadRecords(backing)).map((record) => record.id).sort();
          expect(stored).toEqual([...idsA, ...idsB].sort());
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * KNOWN BUG - "Clear records" in the popup can be undone by a tab.
   *
   * Same root cause as above: a tab that read the list just before the popup
   * removed it writes the old list back, plus its new record. The learner
   * pressed Clear and the old history reappears.
   */
  it.fails('a tab writing while the popup clears never brings cleared records back', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        const backing = new MemoryArea();
        await backing.set({
          records: { version: 1, records: [makeRecord('old', '/x/e/one', 1)] },
        });
        const tab = createRecordQueue(scheduledArea(s, backing));
        const popup = scheduledArea(s, backing);

        // The moment the learner presses Clear is itself scheduled, so it can
        // land before, between or after the tab's read and write.
        const clearPressed = s.schedule(Promise.resolve('clear pressed'));
        await s.waitFor(
          Promise.all([
            tab.add(makeRecord('new', '/x/e/one', 2)),
            clearPressed.then(() => clearRecords(popup)),
          ]),
        );

        // `new` may or may not survive (it raced with Clear); `old` must not.
        const stored = (await loadRecords(backing)).map((record) => record.id);
        expect(stored).not.toContain('old');
      }),
      { numRuns: 100 },
    );
  });
});

/* ------------------------------------------------------------------ *
 * Corrupted / foreign storage contents
 * ------------------------------------------------------------------ */

/** Values that look like a stored record, with any field possibly junk. */
const junk = fc.oneof(fc.anything(), fc.constant(undefined), fc.constant(null), fc.double());
const recordLike = fc.record(
  {
    id: fc.oneof(fc.string(), junk),
    questionKey: fc.oneof(fc.constantFrom('id:progress:1 of 4', 'fp:abc', ''), junk),
    exerciseKey: fc.oneof(fc.constant('/x/e/one'), junk),
    startedAt: fc.oneof(fc.integer({ min: 0, max: 2_000_000_000_000 }), junk),
    endedAt: fc.oneof(fc.integer(), junk),
    durationMs: fc.oneof(fc.integer(), junk),
    pausedMs: fc.oneof(fc.integer(), junk),
    mode: fc.oneof(fc.constantFrom('countup', 'countdown'), junk),
    limitMs: fc.oneof(fc.integer(), junk),
    timedOut: fc.oneof(fc.boolean(), fc.constantFrom('true', 'false'), junk),
    firstSubmissionOutcome: fc.oneof(fc.constantFrom('correct', 'incorrect', 'unknown'), junk),
    endReason: fc.oneof(fc.constantFrom('question-change', 'skipped'), junk),
    status: fc.oneof(fc.constantFrom('completed', 'expired', 'partial', 'skipped'), junk),
    wasPaused: fc.oneof(fc.boolean(), junk),
    runId: fc.oneof(fc.string(), junk),
    questionIndex: fc.oneof(fc.nat(), junk),
    questionTotal: fc.oneof(fc.nat(), junk),
  },
  { requiredKeys: [] },
);
const storedRecords = fc.oneof(
  fc.anything(),
  fc.record({ version: fc.anything(), records: fc.array(fc.oneof(recordLike, fc.anything())) }),
);

describe('sanitising whatever storage holds', () => {
  it('records: never throws, and sanitising twice changes nothing', () => {
    fc.assert(
      fc.property(storedRecords, (raw) => {
        const once = sanitizeRecords(raw);
        const twice = sanitizeRecords(structuredClone({ version: 1, records: once }));
        expect(twice).toEqual(once);
      }),
      { numRuns: 1_000 },
    );
  });

  it('records: every sanitised record has the shape the UI relies on', () => {
    fc.assert(
      fc.property(storedRecords, (raw) => {
        for (const record of sanitizeRecords(raw)) {
          expect(typeof record.id).toBe('string');
          expect(record.questionKey).not.toBe('');
          expect(Number.isFinite(record.startedAt)).toBe(true);
          expect(record.durationMs).toBeGreaterThanOrEqual(0);
          expect(record.pausedMs).toBeGreaterThanOrEqual(0);
          expect(['countup', 'countdown']).toContain(record.mode);
          expect(['completed', 'expired', 'partial', 'skipped']).toContain(record.status);
          expect(typeof record.wasPaused).toBe('boolean');
          expect(typeof record.timedOut).toBe('boolean');
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it('settings: never throws, and sanitising twice changes nothing', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const once = sanitizeSettings(raw);
        expect(sanitizeSettings(structuredClone(once))).toEqual(once);
      }),
      { numRuns: 1_000 },
    );
  });

  it('session, run and attempt window: never throw, and are idempotent', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        for (const sanitize of [sanitizeSession, sanitizeRun, sanitizeAttemptWindow] as Array<
          (value: unknown) => unknown
        >) {
          const once = sanitize(raw);
          if (once !== null) expect(sanitize(structuredClone(once))).toEqual(once);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
