import { describe, it, expect } from "vitest";
import {
  renderDashboard, parseMarketplaceJsonl, sliceDays, availablePresets, deltaWithin,
} from "../../../scripts/reach/render.mjs";

const DATA = {
  meta: { firstCollected: "2026-08-22T06:17:00Z", lastRun: "2026-08-22T06:17:00Z", schemaVersion: 1 },
  views: { "2026-08-20": { count: 10, uniques: 2 }, "2026-08-21": { count: 18, uniques: 3 } },
  clones: { "2026-08-21": { count: 20, uniques: 7 } },
  stars: ["2026-07-23T08:46:16Z"],
  marketplace: [
    { ts: "2026-08-22T06:17:00Z", openvsx: { downloads: 18596, reviews: 4, version: "0.36.0" },
      vsmarketplace: { downloads: 1066, installs: 11, updates: 77, rating: 4.45, version: "0.36.0" } },
  ],
};

describe("renderDashboard", () => {
  it("returns a complete standalone HTML document", () => {
    const html = renderDashboard(DATA);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("</html>");
  });

  it("embeds no external resources — the CSP-safe, offline-safe requirement", () => {
    const html = renderDashboard(DATA);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
  });

  it("states when recording began, so a short series is not read as all-time", () => {
    expect(renderDashboard(DATA)).toContain("2026-08-22");
    expect(renderDashboard(DATA)).toMatch(/recording since/i);
  });

  it("labels Open VSX as downloads and never as users", () => {
    const html = renderDashboard(DATA);
    expect(html).toContain("18,596");
    expect(html).toMatch(/downloads/i);
    expect(html).not.toMatch(/18,596\s*users/i);
  });

  it("warns rather than drawing a trend when only one sample exists", () => {
    expect(renderDashboard(DATA)).toMatch(/not enough history|single sample|one sample/i);
  });

  it("does not warn once several samples exist", () => {
    const many = {
      ...DATA,
      marketplace: [
        { ...DATA.marketplace[0], ts: "2026-08-22T06:17:00Z" },
        { ...DATA.marketplace[0], ts: "2026-08-23T06:17:00Z" },
        { ...DATA.marketplace[0], ts: "2026-08-24T06:17:00Z" },
      ],
    };
    expect(renderDashboard(many)).not.toMatch(/not enough history/i);
  });

  it("escapes values that came from a remote service", () => {
    const hostile = {
      ...DATA,
      marketplace: [{ ...DATA.marketplace[0], openvsx: { downloads: 1, reviews: 0, version: "<script>x</script>" } }],
    };
    expect(renderDashboard(hostile)).not.toContain("<script>x</script>");
  });

  describe("chart legibility", () => {
    const withTraffic = {
      ...DATA,
      views: {
        "2026-08-19": { count: 18, uniques: 4 },
        "2026-08-20": { count: 0, uniques: 0 },
        "2026-08-21": { count: 12, uniques: 3 },
      },
    };

    it("prints the value above every bar while they are wide enough", () => {
      const html = renderDashboard(withTraffic);
      expect(html).toMatch(/<text class="val"[^>]*>18<\/text>/);
      expect(html).toMatch(/<text class="val"[^>]*>12<\/text>/);
    });

    it("labels the date axis", () => {
      const html = renderDashboard(withTraffic);
      expect(html).toMatch(/<text class="tick"[^>]*>08-19<\/text>/);
      expect(html).toMatch(/<text class="tick"[^>]*>08-21<\/text>/);
    });

    it("draws a recorded zero as a visible bar labelled 0, not as a gap", () => {
      // A zero day and an unrecorded day are different facts. GitHub really
      // reports count: 0 on quiet days, so the chart must show one.
      const html = renderDashboard(withTraffic);
      expect(html).toMatch(/class="bar zero"/);
      expect(html).toMatch(/<text class="val"[^>]*>0<\/text>/);
    });

    it("states the total, the peak and the recorded span", () => {
      const html = renderDashboard(withTraffic);
      expect(html).toContain("30 total");
      expect(html).toContain("peak 18/day");
      expect(html).toContain("3 days");
      expect(html).toContain("2026-08-19");
    });

    it("never sums daily uniques — they double-count and the sum is false", () => {
      // Regression guard. Daily uniques cannot be added: a visitor who comes on
      // three days counts once per day. On the live data the daily figures sum
      // to 21 where GitHub reports 9 unique viewers, and to 136 where it
      // reports 105 unique cloners. Printing the sum states a false number.
      const html = renderDashboard(withTraffic);
      expect(html).not.toMatch(/\bunique\b/i);
    });

    it("keeps chart text in ink tokens rather than the series colour", () => {
      const html = renderDashboard(withTraffic);
      expect(html).toMatch(/\.chart \.val \{[^}]*fill:var\(--fg\)/);
      expect(html).toMatch(/\.chart \.tick \{[^}]*fill:var\(--muted\)/);
      expect(html).not.toMatch(/\.chart \.val \{[^}]*fill:var\(--bar\)/);
    });
  });

  it("renders an empty store without throwing", () => {
    const empty = { meta: {}, views: {}, clones: {}, stars: [], marketplace: [] };
    expect(() => renderDashboard(empty)).not.toThrow();
  });
});

describe("parseMarketplaceJsonl", () => {
  it("parses every well-formed line", () => {
    const text = '{"ts":"2026-08-22T06:17:00Z","n":1}\n{"ts":"2026-08-23T06:17:00Z","n":2}\n';
    const { records, skipped } = parseMarketplaceJsonl(text);
    expect(records).toEqual([{ ts: "2026-08-22T06:17:00Z", n: 1 }, { ts: "2026-08-23T06:17:00Z", n: 2 }]);
    expect(skipped).toBe(0);
  });

  it("skips a torn final line rather than throwing, and reports the count", () => {
    // Simulates appendJsonl's one non-atomic write getting cut mid-record.
    const text = '{"ts":"2026-08-22T06:17:00Z","n":1}\n{"ts":"2026-08-23T06:17:00Z","n":2';
    const { records, skipped } = parseMarketplaceJsonl(text);
    expect(records).toEqual([{ ts: "2026-08-22T06:17:00Z", n: 1 }]);
    expect(skipped).toBe(1);
  });

  it("returns no records and no skips for an empty file", () => {
    expect(parseMarketplaceJsonl("")).toEqual({ records: [], skipped: 0 });
  });
});

const REFERRERS = {
  date: "2026-08-23",
  rows: [
    { referrer: "Google", count: 22, uniques: 4 },
    { referrer: "github.com", count: 15, uniques: 1 },
  ],
};
const PATHS = {
  date: "2026-08-23",
  rows: [{ path: "/oznasi1/agent-flow/pulls", title: "/pulls", count: 44, uniques: 2 }],
};

describe("ranking sections", () => {
  it("renders the referrers and paths recorded in the latest snapshot", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS, paths: PATHS });
    expect(html).toContain("Google");
    expect(html).toContain("github.com");
    expect(html).toContain("/pulls");
    expect(html).toContain("22");
  });

  it("prefers a path's title over its raw path", () => {
    const html = renderDashboard({ ...DATA, paths: PATHS });
    expect(html).toContain("<td>/pulls</td>");
    expect(html).not.toContain("/oznasi1/agent-flow/pulls");
  });

  it("falls back to the raw path when GitHub sends no title", () => {
    const paths = { date: "2026-08-23", rows: [{ path: "/raw/only", count: 3, uniques: 1 }] };
    expect(renderDashboard({ ...DATA, paths })).toContain("<td>/raw/only</td>");
  });

  it("dates the ranking and says it is not a total — it sits beside two time series", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS });
    expect(html).toContain("Ranking on 2026-08-23");
    expect(html).toMatch(/two snapshots do not add up/i);
  });

  it("says nothing was recorded rather than rendering an empty table", () => {
    const html = renderDashboard({ ...DATA, referrers: null, paths: null });
    expect(html).toContain("No snapshot recorded yet.");
    expect(html).not.toContain('<table class="rank"');
  });

  it("treats a snapshot with zero rows as nothing recorded", () => {
    const html = renderDashboard({ ...DATA, referrers: { date: "2026-08-23", rows: [] } });
    expect(html).toContain("No snapshot recorded yet.");
  });

  it("caps the table at ten rows even if the payload grows", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ referrer: `r${i}`, count: 1, uniques: 1 }));
    const html = renderDashboard({ ...DATA, referrers: { date: "2026-08-23", rows } });
    expect(html).toContain("<td>r9</td>");
    expect(html).not.toContain("<td>r10</td>");
  });

  it("escapes a hostile referrer — the value is attacker-controlled", () => {
    const rows = [{ referrer: "<img src=x onerror=alert(1)>", count: 1, uniques: 1 }];
    const html = renderDashboard({ ...DATA, referrers: { date: "2026-08-23", rows } });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("staleness stamp", () => {
  it("carries the last run as a data attribute the viewer can check", () => {
    expect(renderDashboard(DATA)).toContain('data-last-run="2026-08-22T06:17:00Z"');
  });

  it("omits the attribute entirely when nothing has ever run", () => {
    // The script still *references* the attribute, so match the attribute
    // itself — a bare substring check passes even when the stamp is emitted.
    const html = renderDashboard({ ...DATA, meta: {} });
    expect(html).not.toMatch(/data-last-run="/);
    expect(renderDashboard(DATA)).toMatch(/data-last-run="/);
  });

  it("ships the warning box hidden — JS off must not mean a false alarm", () => {
    expect(renderDashboard(DATA)).toContain('<div id="stale" class="stale" hidden></div>');
  });

  it("keeps the page offline-safe despite the added script", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS, paths: PATHS });
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});

const DAYS = (n: number, from = 1) => {
  const out: Record<string, { count: number; uniques: number }> = {};
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 7, from + i)).toISOString().slice(0, 10);
    out[d] = { count: i + 1, uniques: 1 };
  }
  return out;
};

describe("sliceDays", () => {
  it("counts back from the newest recorded day, not from the clock", () => {
    // Anchoring to the clock would empty every range the moment the collector
    // stalls; "the last 7 recorded days" is always answerable.
    const kept = Object.keys(sliceDays(DAYS(20), 7));
    expect(kept).toHaveLength(7);
    expect(kept[kept.length - 1]).toBe("2026-08-20");
    expect(kept[0]).toBe("2026-08-14");
  });

  it("returns everything for the all-time range", () => {
    expect(Object.keys(sliceDays(DAYS(20), null))).toHaveLength(20);
  });

  it("returns everything when the range is longer than the record", () => {
    expect(Object.keys(sliceDays(DAYS(5), 90))).toHaveLength(5);
  });

  it("survives an empty store", () => {
    expect(sliceDays({}, 7)).toEqual({});
  });
});

describe("availablePresets", () => {
  it("enables only the presets the record can actually answer", () => {
    expect(availablePresets(DAYS(15))).toEqual([
      { days: 7, enabled: true }, { days: 30, enabled: false }, { days: 90, enabled: false },
    ]);
  });

  it("disables a preset equal to the span — it would silently mean all-time", () => {
    expect(availablePresets(DAYS(7))).toContainEqual({ days: 7, enabled: false });
  });
});

const SAMPLES = [
  { ts: "2026-08-01T06:00:00Z", openvsx: { downloads: 100, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 10, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
  { ts: "2026-08-18T06:00:00Z", openvsx: { downloads: 180, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 14, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
  { ts: "2026-08-20T06:00:00Z", openvsx: { downloads: 200, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 15, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
];

describe("deltaWithin", () => {
  it("reports the change across every sample for the all-time range", () => {
    expect(deltaWithin(SAMPLES, null, "2026-08-20")).toEqual({ vsx: 100, vsm: 5 });
  });

  it("counts only samples inside the range", () => {
    expect(deltaWithin(SAMPLES, 7, "2026-08-20")).toEqual({ vsx: 20, vsm: 1 });
  });

  it("says nothing rather than inventing a zero from one sample", () => {
    // A lone sample is a level, not a change. A fabricated 0 would be
    // indistinguishable from a genuinely flat week.
    expect(deltaWithin(SAMPLES, 2, "2026-08-20")).toBeNull();
    expect(deltaWithin([SAMPLES[0]], null, "2026-08-20")).toBeNull();
    expect(deltaWithin([], null, "2026-08-20")).toBeNull();
  });
});

describe("the range filter", () => {
  const withDays = { ...DATA, views: DAYS(15), clones: DAYS(15) };

  it("offers all-time plus every preset, in one row above the content", () => {
    const html = renderDashboard(withDays);
    expect(html).toContain('data-range="all"');
    expect(html).toContain('data-range="7"');
    expect(html).toContain('aria-label="Date range"');
  });

  it("disables a preset the store cannot satisfy and says why", () => {
    const html = renderDashboard(withDays);
    expect(html).toMatch(/data-range="30"[^>]*disabled/);
    expect(html).toContain("Only 15 days recorded so far");
    expect(html).not.toMatch(/data-range="7"[^>]*disabled/);
  });

  it("pre-renders a block per satisfiable range, all but all-time hidden", () => {
    const html = renderDashboard(withDays);
    expect(html).toMatch(/data-view="all" data-metric="views"[^>]*>(?!.*hidden)/);
    expect(html).toMatch(/data-view="7" data-metric="views"[^>]*hidden/);
    // 30 and 90 are unsatisfiable, so they are never rendered at all.
    expect(html).not.toContain('data-view="30"');
  });

  it("carries each block's own total, so the client never does arithmetic", () => {
    const html = renderDashboard(withDays);
    // DAYS(15) counts 1..15 → all-time 120; the last 7 are 9..15 → 84.
    expect(html).toMatch(/data-view="all" data-metric="views" data-total="120"/);
    expect(html).toMatch(/data-view="7" data-metric="views" data-total="84"/);
  });

  it("seeds the scoped tiles with the all-time figures for a JS-off reader", () => {
    const html = renderDashboard(withDays);
    expect(html).toMatch(/data-tile="views">120</);
    expect(html).toContain("Views, all time");
  });

  it("puts the range's own delta on the button that selects it", () => {
    const html = renderDashboard({ ...withDays, marketplace: SAMPLES });
    expect(html).toMatch(/data-range="all"[^>]*data-vsx="\+100 since recording began"/);
    expect(html).toMatch(/data-range="7"[^>]*data-vsx="\+20 in the last 7 days"/);
  });

  it("renders no filter row values that require fetching anything", () => {
    expect(renderDashboard(withDays)).not.toMatch(/<script[^>]+src=/i);
  });
});

describe("layout fixes", () => {
  it("heads the ranking column with the column's name, not the section's", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS, paths: PATHS });
    expect(html).toContain("<th>Referrer</th>");
    expect(html).toContain("<th>Path</th>");
  });

  it("puts the two rankings side by side", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS, paths: PATHS });
    expect(html).toContain('<div class="cols">');
  });

  it("says a ranking does not follow the range, since it cannot", () => {
    const html = renderDashboard({ ...DATA, referrers: REFERRERS });
    expect(html).toMatch(/does not follow the range/i);
  });
});
