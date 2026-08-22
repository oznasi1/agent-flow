import { describe, it, expect } from "vitest";
import { renderDashboard, parseMarketplaceJsonl } from "../../../scripts/reach/render.mjs";

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
