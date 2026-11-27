/**
 * Small dependency-free helpers shared across modules.
 *
 * Kept separate from `timer-engine.ts` so the engine stays purely about timing.
 */

/** Collapse whitespace and trim, so cosmetic markup changes do not matter. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, ' ').trim();
}

/** Locally generated unique id for a record. */
export function uniqueId(prefix = 'r'): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return `${prefix}_${globalCrypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Clamp a possibly-untrusted number from storage into a sane range. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a stored boolean, accepting the stringy forms storage may hold. */
export function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Milliseconds from seconds, clamped to a sane per-question range. */
export function secondsToMs(seconds: number, min = 5, max = 3600): number {
  return Math.round(clampNumber(seconds, min, max, 60) * 1000);
}
