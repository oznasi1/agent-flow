import { describe, it, expect } from "vitest";
import { addOnce, deriveStatuses, effectiveFilter, fmtEst, isPrReviewStatus, isTopPriority, matchesStatus, moveKey, railClass, visibleFilters } from "../../src/webview/helpers";
import type { Filter, Task } from "../../src/types";
import { mkTask } from "../_helpers/factories";

const tasks = (...keys: string[]) => keys.map((k) => mkTask({ key: k }));
const keys = (ts: { key: string }[]) => ts.map((t) => t.key);

describe("fmtEst", () => {
  it("shows whole hours below a workday", () => {
    expect(fmtEst(3600)).toBe("1h");
    expect(fmtEst(4 * 3600)).toBe("4h");
  });

  it("rounds hours to the nearest whole hour", () => {
    expect(fmtEst(90 * 60)).toBe("2h"); // 1.5h → 2h
  });

  it("shows whole days at or above 8h", () => {
    expect(fmtEst(8 * 3600)).toBe("1d");
    expect(fmtEst(16 * 3600)).toBe("2d");
  });

  it("shows a fractional day to one decimal", () => {
    expect(fmtEst(12 * 3600)).toBe("1.5d");
  });
});

describe("railClass", () => {
  it("maps Jira's three status categories onto the three rail hues", () => {
    expect(railClass("new")).toBe("s-new");
    expect(railClass("indeterminate")).toBe("s-progress");
    expect(railClass("done")).toBe("s-done");
  });

  it("treats an unknown or missing category as not started", () => {
    expect(railClass(undefined)).toBe("s-new");
    expect(railClass("")).toBe("s-new");
    expect(railClass("wat")).toBe("s-new");
  });
});

describe("isTopPriority", () => {
  it("is true for Highest only", () => {
    expect(isTopPriority("Highest")).toBe(true);
    expect(isTopPriority("highest")).toBe(true);
  });

  it("is false for every other level, including High", () => {
    for (const p of ["High", "Medium", "Low", "Lowest", ""]) {
      expect(isTopPriority(p)).toBe(false);
    }
  });
});

describe("deriveStatuses", () => {
  const s = (name: string, category: Task["statusCategory"]) => mkTask({ status: name, statusCategory: category });

  it("returns the distinct statuses present in the pool", () => {
    const got = deriveStatuses([s("To Do", "new"), s("To Do", "new"), s("In Progress", "indeterminate")]);
    expect(got.map((x) => x.name)).toEqual(["To Do", "In Progress"]);
  });

  it("orders by workflow category (new → indeterminate → done) then alphabetically", () => {
    const got = deriveStatuses([
      s("In Review", "indeterminate"),
      s("Done", "done"),
      s("To Do", "new"),
      s("Blocked", "indeterminate"),
    ]);
    expect(got.map((x) => x.name)).toEqual(["To Do", "Blocked", "In Review", "Done"]);
  });

  it("skips tasks with no status", () => {
    expect(deriveStatuses([mkTask({ status: "" }), s("To Do", "new")]).map((x) => x.name)).toEqual(["To Do"]);
  });

  it("carries each status's category through", () => {
    expect(deriveStatuses([s("In Progress", "indeterminate")])).toEqual([
      { name: "In Progress", category: "indeterminate" },
    ]);
  });
});

describe("matchesStatus", () => {
  const t = mkTask({ status: "In Progress" });

  it("passes everything when nothing is selected", () => {
    expect(matchesStatus(t, new Set())).toBe(true);
  });

  it("passes a task whose status is selected", () => {
    expect(matchesStatus(t, new Set(["To Do", "In Progress"]))).toBe(true);
  });

  it("rejects a task whose status is not selected", () => {
    expect(matchesStatus(t, new Set(["To Do"]))).toBe(false);
  });
});

describe("isPrReviewStatus", () => {
  it("matches the configured status exactly", () => {
    expect(isPrReviewStatus("PR initiated", "PR initiated")).toBe(true);
  });

  it("matches case-insensitively and ignoring surrounding whitespace", () => {
    expect(isPrReviewStatus("pr initiated", "PR initiated")).toBe(true);
    expect(isPrReviewStatus("  PR Initiated  ", "PR initiated")).toBe(true);
  });

  it("does not match a different status", () => {
    expect(isPrReviewStatus("In Progress", "PR initiated")).toBe(false);
  });

  it("is false when either the status or the configured value is empty", () => {
    expect(isPrReviewStatus("", "PR initiated")).toBe(false);
    expect(isPrReviewStatus("PR initiated", "")).toBe(false);
  });
});

describe("moveKey", () => {
  it("moves a key before a target", () => {
    expect(keys(moveKey(tasks("A", "B", "C"), "C", "A", "before"))).toEqual(["C", "A", "B"]);
  });

  it("moves a key after a target", () => {
    expect(keys(moveKey(tasks("A", "B", "C"), "A", "B", "after"))).toEqual(["B", "A", "C"]);
  });

  it("is a no-op when from === to", () => {
    const list = tasks("A", "B");
    expect(moveKey(list, "A", "A", "before")).toBe(list);
  });

  it("returns the list unchanged when the from key is missing", () => {
    const list = tasks("A", "B");
    expect(moveKey(list, "Z", "A", "before")).toBe(list);
  });

  it("returns the list unchanged when the to key is missing", () => {
    const list = tasks("A", "B");
    expect(moveKey(list, "A", "Z", "before")).toBe(list);
  });

  it("does not mutate the input list", () => {
    const list = tasks("A", "B", "C");
    const snapshot = keys(list);
    moveKey(list, "C", "A", "before");
    expect(keys(list)).toEqual(snapshot);
  });
});

describe("addOnce", () => {
  it("appends a value that is absent", () => {
    expect(addOnce(["a"], "b")).toEqual(["a", "b"]);
  });

  it("returns the same array reference when the value is already present", () => {
    const xs = ["a", "b"];
    expect(addOnce(xs, "a")).toBe(xs);
  });
});

describe("effectiveFilter", () => {
  const ALL: Filter[] = ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"];

  it("keeps a configured lens the source supports", () => {
    expect(effectiveFilter("mysprint", ALL)).toBe("mysprint");
    expect(effectiveFilter("backlog", ALL)).toBe("backlog");
    expect(effectiveFilter("mine", ["mine", "all"])).toBe("mine");
  });

  // The pre-capability code was `(cfg.defaultFilter as Filter) || "mysprint"`, so an
  // unrecognized or empty setting on a source that supports the shipped default must
  // still land on it — an already-configured user's opening lens does not move.
  it("falls back to the shipped default when the setting is unrecognized", () => {
    expect(effectiveFilter("", ALL)).toBe("mysprint");
    expect(effectiveFilter("nonsense", ALL)).toBe("mysprint");
  });

  it("falls back to the source's first lens when it has no sprints", () => {
    // Four of the six filters are sprint-scoped, including the shipped default.
    expect(effectiveFilter("mysprint", ["mine", "all"])).toBe("mine");
    // "all" sorts first in the connector's own array here, but it is never a
    // rendered tab (see FILTER_ORDER in helpers.ts) — the tail fallback must read
    // positionally off `visibleFilters(supported)`, not the raw connector array, or
    // this returns "all" and the tab bar shows nothing active. This assertion used
    // to expect "all"; that was the bug pinned as correct, not a passing test.
    expect(effectiveFilter("sprint", ["all", "mine"])).toBe("mine");
  });

  it("still returns a Filter for a source that declares none", () => {
    // It can answer nothing either way; the only obligation is the return type.
    expect(effectiveFilter("mine", [])).toBe("mysprint");
  });

  // The narrower case that first exposed this: a single-element array containing
  // only "all". `supported[0]` would return "all" directly; `visibleFilters(["all"])`
  // renders nothing (FILTER_ORDER has no "all" entry) and falls back to all five real
  // tabs, so the correct answer is the shipped default, which every one of those five
  // includes.
  it("does not return 'all' from a source that declares only 'all'", () => {
    expect(effectiveFilter("mine", ["all"])).toBe("mysprint");
  });

  // The property, not just instances of it: effectiveFilter must never hand back a
  // filter the tab bar doesn't render, whatever `supported` and `configured` are —
  // otherwise the tab bar shows nothing pressed. Pinning this stops the tail
  // fallback's class of bug (an unrendered filter reached positionally off the raw
  // connector array) from recurring by any route through that branch.
  //
  // NOT exhaustive: `effectiveFilter("all", ["all", "unassigned"])` still returns
  // "all" — unrendered — via the FIRST branch ("keeps a configured lens the source
  // supports"), which returns `configured` verbatim whenever `supported` contains it
  // literally, with no visibleFilters check at all. That branch is untouched by this
  // fix round and predates it; it is reachable only via a hand-edited
  // `agentFlow.defaultFilter` set to the literal string "all" (the setting's manifest
  // `enum` never offers it), paired with a connector whose `supportedFilters`
  // includes "all" — which Jira's always has. Deliberately excluded from the cases
  // below rather than asserted as correct; see the Task 13 fix-round report.
  it("only ever returns a filter visibleFilters(supported) actually renders", () => {
    const cases: { configured: string; supported: Filter[] }[] = [
      { configured: "mysprint", supported: ALL },
      { configured: "sprint", supported: ["all", "mine"] },
      { configured: "mine", supported: ["all"] },
      { configured: "backlog", supported: [] },
      { configured: "nonsense", supported: ["backlog", "all"] },
      { configured: "all", supported: ["mine", "backlog"] },
    ];
    for (const { configured, supported } of cases) {
      expect(visibleFilters(supported)).toContain(effectiveFilter(configured, supported));
    }
  });
});
