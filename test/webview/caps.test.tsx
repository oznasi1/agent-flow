// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { visibleFilters, gateCopy } from "../../src/webview/helpers";
import type { Filter } from "../../src/types";

// Every Filter the type permits, including "all" — the JQL builder's fallback
// default, which Jira's own `supportedFilters` includes but which no UI has ever
// rendered as a tab (the pre-seam `FILTERS` array in App.tsx had exactly the other
// five; `agentFlow.defaultFilter`'s manifest `enum` and `DEFAULT_FILTER_VALUES`
// in settingsSnapshot.ts agree). A connector declaring support for it must not
// make it appear.
const ALL_SIX: Filter[] = ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"];

describe("visibleFilters", () => {
  it("keeps the shipped tab order, not the connector's array order", () => {
    expect(visibleFilters(["backlog", "mine"])).toEqual(["mine", "backlog"]);
  });

  it("drops tabs the source does not support", () => {
    expect(visibleFilters(["mine", "all"])).not.toContain("mysprint");
  });

  it("falls back to every tab when a source declares none", () => {
    // An empty tab bar is a dead end with no in-product way out.
    expect(visibleFilters([]).length).toBeGreaterThan(1);
  });

  // The brief's own FILTER_ORDER draft copied types.ts's declaration order
  // (unassigned, mine, mysprint, sprint, backlog, all), which is NOT the order the
  // tab bar has rendered since the "reorder task filter tabs" commit (My sprint,
  // Mine, Sprint, Backlog, Unassigned) — and it included "all", which has never
  // been a rendered tab at all. Wiring the draft verbatim would have both
  // reordered Jira's existing five tabs AND added a sixth one, on every existing
  // user's very next paint. Pin the real shipped order exactly, so a future
  // addition to the `Filter` type cannot silently gain a tab the same way.
  it("renders Jira's full capability set as exactly the five shipped tabs, in the shipped order — never a sixth 'all' tab", () => {
    expect(visibleFilters(ALL_SIX)).toEqual(["mysprint", "mine", "sprint", "backlog", "unassigned"]);
  });
});

describe("gateCopy", () => {
  it("names the configured source", () => {
    expect(gateCopy("Fixture").connecting).toBe("Connecting to Fixture…");
    expect(gateCopy("Fixture").signIn).toBe("Sign in to Fixture");
  });

  it("reads identically to the pre-seam copy for Jira", () => {
    const c = gateCopy("Jira");
    expect(c.connecting).toBe("Connecting to Jira…");
    expect(c.signIn).toBe("Sign in to Jira");
    expect(c.unconfigured).toBe(
      "Agent Flow Deck isn't connected to Jira yet — add your site URL and project to get started.",
    );
    expect(c.unauthed).toBe("Connect Agent Flow Deck to your Jira to see your task pool.");
    expect(c.openIn).toBe("Open in Jira");
  });
});
