import { describe, it, expect } from "vitest";
import { deriveStatuses, fmtEst, isPrReviewStatus, matchesStatus, moveKey, prioClass } from "../../src/webview/helpers";
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

describe("prioClass", () => {
  it("maps highest/high to p-high", () => {
    expect(prioClass("Highest")).toBe("p-high");
    expect(prioClass("High")).toBe("p-high");
  });

  it("maps medium to p-med", () => {
    expect(prioClass("Medium")).toBe("p-med");
  });

  it("maps anything else (incl. empty) to p-low", () => {
    expect(prioClass("Low")).toBe("p-low");
    expect(prioClass("")).toBe("p-low");
  });
});

describe("deriveStatuses", () => {
  const s = (name: string, category: string) => mkTask({ status: name, statusCategory: category });

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
