import { describe, it, expect } from "vitest";
import { mergeDaily, toDailyMap } from "../../../scripts/reach/merge.mjs";

// Real payload shape, captured from the live API on 2026-08-22.
const LIVE_BUCKETS = [
  { timestamp: "2026-08-08T00:00:00Z", count: 1, uniques: 1 },
  { timestamp: "2026-08-15T00:00:00Z", count: 0, uniques: 0 },
  { timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 },
];

describe("toDailyMap", () => {
  it("keys buckets by calendar date, dropping the time component", () => {
    expect(toDailyMap(LIVE_BUCKETS)).toEqual({
      "2026-08-08": { count: 1, uniques: 1 },
      "2026-08-15": { count: 0, uniques: 0 },
      "2026-08-21": { count: 18, uniques: 3 },
    });
  });

  it("keeps genuine zero-count days — a quiet day is real data", () => {
    expect(toDailyMap(LIVE_BUCKETS)["2026-08-15"]).toEqual({ count: 0, uniques: 0 });
  });

  it("skips malformed buckets rather than inventing a date", () => {
    expect(toDailyMap([{ count: 5, uniques: 1 }, null, { timestamp: 7 }])).toEqual({});
  });

  it("returns an empty map for an empty payload", () => {
    expect(toDailyMap([])).toEqual({});
  });
});

describe("mergeDaily", () => {
  it("overwrites any date the incoming payload reports", () => {
    const existing = { "2026-08-21": { count: 4, uniques: 1 } };
    const incoming = { "2026-08-21": { count: 18, uniques: 3 } };
    expect(mergeDaily(existing, incoming)["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("keeps dates the incoming payload no longer mentions", () => {
    const existing = { "2026-07-20": { count: 9, uniques: 2 } };
    const incoming = { "2026-08-21": { count: 18, uniques: 3 } };
    const merged = mergeDaily(existing, incoming);
    expect(merged["2026-07-20"]).toEqual({ count: 9, uniques: 2 });
    expect(Object.keys(merged)).toHaveLength(2);
  });

  it("is idempotent — merging the same payload twice equals merging it once", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = toDailyMap(LIVE_BUCKETS);
    const once = mergeDaily(existing, incoming);
    const twice = mergeDaily(once, incoming);
    expect(twice).toEqual(once);
  });

  it("backfills a fourteen-day gap without losing anything", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = toDailyMap(LIVE_BUCKETS);
    const merged = mergeDaily(existing, incoming);
    expect(Object.keys(merged).sort()).toEqual([
      "2026-08-01", "2026-08-08", "2026-08-15", "2026-08-21",
    ]);
  });

  it("never deletes a date, even when incoming is empty", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    expect(mergeDaily(existing, {})).toEqual(existing);
  });

  it("does not mutate either argument", () => {
    const existing = { "2026-08-01": { count: 3, uniques: 1 } };
    const incoming = { "2026-08-01": { count: 99, uniques: 9 } };
    mergeDaily(existing, incoming);
    expect(existing["2026-08-01"]).toEqual({ count: 3, uniques: 1 });
    expect(incoming["2026-08-01"]).toEqual({ count: 99, uniques: 9 });
  });
});
