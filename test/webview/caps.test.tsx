// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { visibleFilters, gateCopy } from "../../src/webview/helpers";
import type { Filter } from "../../src/types";

const ALL: Filter[] = ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"];

describe("visibleFilters", () => {
  it("keeps the shipped tab order, not the connector's array order", () => {
    expect(visibleFilters(["all", "mine"])).toEqual(["mine", "all"]);
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
  // Mine, Sprint, Backlog, Unassigned). Wiring the draft verbatim would silently
  // reorder Jira's existing five tabs on every user's very first paint after the
  // update. Pin the real shipped order — "all" is the only genuinely new tab, so
  // it is appended rather than inserted among the other five.
  it("orders Jira's full filter set the same way the tab bar always has, appending the new 'all' tab last", () => {
    expect(visibleFilters(ALL)).toEqual(["mysprint", "mine", "sprint", "backlog", "unassigned", "all"]);
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
