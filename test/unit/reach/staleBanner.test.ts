// @vitest-environment jsdom
//
// The banner is the only part of the dashboard that runs in the viewer's
// browser, and it exists for a failure nothing else can see: a cron that
// simply stops. Asserting the markup would not prove it fires, so this mounts
// the real rendered page and executes the real inline script against a
// controlled clock.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderDashboard } from "../../../scripts/reach/render.mjs";

const AT = (lastRun: string) =>
  renderDashboard({
    meta: { firstCollected: "2026-08-01T06:17:00Z", lastRun, schemaVersion: 1 },
    views: {}, clones: {}, stars: [], marketplace: [],
  });

/** Mount the rendered body and run its inline script — innerHTML never
 * executes scripts, so the page's own code has to be invoked deliberately. */
function view(html: string): string {
  const body = /<body>([\s\S]*)<\/body>/i.exec(html);
  if (!body) throw new Error("rendered page has no body");
  document.body.innerHTML = body[1];
  const script = /<script>([\s\S]*?)<\/script>/i.exec(html);
  if (!script) throw new Error("rendered page has no inline script");
  new Function(script[1])();
  const box = document.getElementById("stale") as HTMLElement;
  return box.hidden ? "" : box.textContent ?? "";
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-23T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("the staleness banner", () => {
  it("stays hidden on a page generated today", () => {
    expect(view(AT("2026-08-23T07:00:00Z"))).toBe("");
  });

  it("stays hidden at one day — a single late cron is not a dead collector", () => {
    expect(view(AT("2026-08-22T07:00:00Z"))).toBe("");
  });

  it("warns once the data is two days old, naming the age", () => {
    const text = view(AT("2026-08-21T07:00:00Z"));
    expect(text).toContain("2 days old");
    expect(text).toMatch(/collector/i);
  });

  it("counts up as the collector stays dead", () => {
    expect(view(AT("2026-08-03T07:00:00Z"))).toContain("20 days old");
  });

  it("stays silent when nothing has ever run — absent is not stale", () => {
    const html = renderDashboard({ meta: {}, views: {}, clones: {}, stars: [], marketplace: [] });
    expect(view(html)).toBe("");
  });

  it("stays silent on an unparseable timestamp rather than showing NaN days", () => {
    expect(view(AT("not-a-date"))).toBe("");
  });

  it("does not warn on a clock skewed into the future", () => {
    expect(view(AT("2026-09-01T07:00:00Z"))).toBe("");
  });
});
