/**
 * Read the timing records out of a raw `chrome.storage.local.get(null)` dump.
 *
 * Mirrors `loadRecords` in `src/storage.ts`: records live under
 * one `rec:<written-at>:<seq>:<id>` key each (sorted = write order); an older
 * version's shared `records` list, if still present, comes first.
 *
 * `STORED_RECORDS_FN` is the same function as source text, for the
 * verification scripts that evaluate code inside the extension's popup page.
 */

export function storedRecords(all) {
  const legacy = all && all.records && Array.isArray(all.records.records) ? all.records.records : [];
  const perKey = Object.keys(all || {})
    .filter((key) => key.startsWith('rec:'))
    .sort()
    .map((key) => all[key]);
  return [...legacy, ...perKey];
}

export const STORED_RECORDS_FN = storedRecords.toString();
