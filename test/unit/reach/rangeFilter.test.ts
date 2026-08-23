// @vitest-environment jsdom
//
// The filter is progressive enhancement: the served page is the all-time view,
// and this script only chooses which pre-rendered block is visible. These tests
// mount the real rendered page and run its real inline script, because the
// thing worth proving is that a filtered view and the initial view can never
// disagree — every number the filter shows was computed at render time.
import { describe, it, expect } from "vitest";
import { renderDashboard } from "../../../scripts/reach/render.mjs";

const DAYS = (n: number) => {
  const out: Record<string, { count: number; uniques: number }> = {};
  for (let i = 0; i < n; i += 1) {
    out[new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)] =
      { count: i + 1, uniques: 1 };
  }
  return out;
};
const SAMPLES = [
  { ts: "2026-08-01T06:00:00Z", openvsx: { downloads: 100, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 10, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
  { ts: "2026-08-13T06:00:00Z", openvsx: { downloads: 180, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 14, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
  { ts: "2026-08-15T06:00:00Z", openvsx: { downloads: 200, reviews: 0, version: "0.1.0" },
    vsmarketplace: { downloads: 15, installs: 1, updates: 0, rating: null, version: "0.1.0" } },
];

function mount() {
  const html = renderDashboard({
    meta: { firstCollected: "2026-08-01T06:00:00Z", lastRun: "2026-08-15T06:00:00Z", schemaVersion: 1 },
    views: DAYS(15), clones: DAYS(15), stars: [], marketplace: SAMPLES,
  });
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/i.exec(html)![1];
  const script = /<script>([\s\S]*?)<\/script>/i.exec(html)![1];
  new Function(script)();
  return {
    visible: () => Array.from(document.querySelectorAll("[data-view]"))
      .filter((e) => !(e as HTMLElement).hidden)
      .map((e) => e.getAttribute("data-metric") + ":" + e.getAttribute("data-view")),
    tile: (m: string) => document.querySelector(`[data-tile="${m}"]`)!.textContent,
    scope: () => document.querySelector("[data-scope]")!.textContent,
    delta: () => document.querySelector('[data-delta="vsx"]')!.textContent,
    press: (r: string) => (document.querySelector(`[data-range="${r}"]`) as HTMLButtonElement).click(),
    pressed: () => document.querySelector('[data-range][aria-pressed="true"]')!.getAttribute("data-range"),
  };
}

describe("the range filter", () => {
  it("serves the all-time view before anything is clicked", () => {
    const p = mount();
    expect(p.visible()).toEqual(["views:all", "clones:all"]);
    expect(p.tile("views")).toBe("120");
    expect(p.scope()).toBe("Views, all time");
    expect(p.pressed()).toBe("all");
  });

  it("swaps every block, tile and label together, so nothing disagrees", () => {
    const p = mount();
    p.press("7");
    expect(p.visible()).toEqual(["views:7", "clones:7"]);
    expect(p.tile("views")).toBe("84");   // days 9..15
    expect(p.tile("clones")).toBe("84");
    expect(p.scope()).toBe("Views, the last 7 days");
    expect(p.pressed()).toBe("7");
  });

  it("moves the delta to the one recorded for that range", () => {
    const p = mount();
    expect(p.delta()).toBe("+100 since recording began");
    p.press("7");
    expect(p.delta()).toBe("+20 in the last 7 days");
  });

  it("returns to all-time without losing anything", () => {
    const p = mount();
    p.press("7");
    p.press("all");
    expect(p.visible()).toEqual(["views:all", "clones:all"]);
    expect(p.tile("views")).toBe("120");
    expect(p.scope()).toBe("Views, all time");
  });

  it("cannot be moved to a preset the store does not cover", () => {
    // The protection is the `disabled` attribute — a disabled button fires no
    // click — so that attribute is what this asserts. A JS guard here would be
    // unreachable code; the mutation that removed one changed no behaviour.
    const p = mount();
    expect((document.querySelector('[data-range="30"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-range="7"]') as HTMLButtonElement).disabled).toBe(false);
    p.press("30");
    expect(p.visible()).toEqual(["views:all", "clones:all"]);
    expect(p.pressed()).toBe("all");
  });

  it("shows exactly one block per metric at all times", () => {
    const p = mount();
    for (const r of ["7", "all", "7", "30", "all"]) {
      p.press(r);
      expect(p.visible().filter((v) => v.startsWith("views:"))).toHaveLength(1);
      expect(p.visible().filter((v) => v.startsWith("clones:"))).toHaveLength(1);
    }
  });
});
