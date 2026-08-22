import { describe, it, expect } from "vitest";
import { renderDashboard } from "../../../scripts/reach/render.mjs";

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

  it("renders an empty store without throwing", () => {
    const empty = { meta: {}, views: {}, clones: {}, stars: [], marketplace: [] };
    expect(() => renderDashboard(empty)).not.toThrow();
  });
});
