// Pure merge arithmetic for the reach store. No I/O, no fetch, no imports —
// this module is the one piece of real logic in the collector and is the only
// part with a test suite behind it.

/** Coerce to a finite number, or 0. Used only on values from a SUCCESSFUL
 * fetch, where a zero is genuine data (GitHub reports quiet days as count: 0).
 * A failed fetch never reaches this module at all. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Convert GitHub's traffic array into a map keyed by calendar date.
 * Buckets without a string `timestamp` are skipped rather than guessed at.
 */
export function toDailyMap(buckets) {
  const out = {};
  if (!Array.isArray(buckets)) return out;
  for (const b of buckets) {
    if (!b || typeof b.timestamp !== "string") continue;
    out[b.timestamp.slice(0, 10)] = { count: num(b.count), uniques: num(b.uniques) };
  }
  return out;
}

/**
 * The merge rule, in full: the API is authoritative for every date it returns,
 * so overwrite those dates, keep every date it does not mention, and never
 * delete one.
 *
 * Those three properties are what make the collector idempotent, make today's
 * partial count self-correcting (tomorrow's window includes today and replaces
 * it), and make a gap of up to fourteen days backfill with no special case.
 *
 * Returns a new object; neither argument is mutated.
 */
export function mergeDaily(existing, incoming) {
  return { ...existing, ...incoming };
}
