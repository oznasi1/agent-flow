import { describe, it, expect } from "vitest";
import { mapRollup, mapMergeable, mapReview, toPrFacts, pickPr, parseRepoFromUrl, countUnresolved } from "../../../../src/engine/pr/facts";
import type { GhCheck, GhPr } from "../../../../src/engine/pr/facts";

const checkRun = (over: Partial<GhCheck> = {}): GhCheck => ({
  __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS",
  detailsUrl: "https://ci/build", ...over,
});
const statusCtx = (over: Partial<GhCheck> = {}): GhCheck => ({
  __typename: "StatusContext", context: "legacy/ci", state: "SUCCESS",
  targetUrl: "https://ci/legacy", ...over,
});

describe("mapRollup", () => {
  it("counts an empty or missing rollup as all zeros", () => {
    expect(mapRollup([])).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapRollup(null)).toEqual({ passing: 0, pending: 0, failing: [] });
    expect(mapRollup(undefined)).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it("counts a successful CheckRun as passing", () => {
    expect(mapRollup([checkRun()])).toEqual({ passing: 1, pending: 0, failing: [] });
  });

  it.each(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"])("treats conclusion %s as failing, with its name and url", (conclusion) => {
    const ci = mapRollup([checkRun({ conclusion, name: "lint", detailsUrl: "https://ci/lint" })]);
    expect(ci.failing).toEqual([{ name: "lint", url: "https://ci/lint" }]);
    expect(ci.passing).toBe(0);
  });

  it.each(["CANCELLED", "NEUTRAL", "SKIPPED", "STALE"])("ignores conclusion %s entirely", (conclusion) => {
    expect(mapRollup([checkRun({ conclusion })])).toEqual({ passing: 0, pending: 0, failing: [] });
  });

  it.each(["QUEUED", "IN_PROGRESS"])("counts status %s as pending regardless of conclusion", (status) => {
    expect(mapRollup([checkRun({ status, conclusion: undefined })])).toEqual({ passing: 0, pending: 1, failing: [] });
  });

  it("reads a StatusContext by state, not conclusion", () => {
    expect(mapRollup([statusCtx()])).toEqual({ passing: 1, pending: 0, failing: [] });
    expect(mapRollup([statusCtx({ state: "PENDING" })]).pending).toBe(1);
  });

  it.each(["FAILURE", "ERROR"])("treats StatusContext state %s as failing, named by context", (state) => {
    expect(mapRollup([statusCtx({ state })]).failing).toEqual([{ name: "legacy/ci", url: "https://ci/legacy" }]);
  });

  it("falls back to a placeholder name and an empty url when gh omits them", () => {
    expect(mapRollup([{ __typename: "CheckRun", conclusion: "FAILURE" }]).failing).toEqual([{ name: "check", url: "" }]);
  });

  it("tallies a mixed rollup", () => {
    const ci = mapRollup([checkRun(), checkRun({ name: "lint", conclusion: "FAILURE" }), checkRun({ status: "IN_PROGRESS" }), checkRun({ conclusion: "SKIPPED" })]);
    expect(ci).toEqual({ passing: 1, pending: 1, failing: [{ name: "lint", url: "https://ci/build" }] });
  });
});

describe("mapMergeable", () => {
  it("reports conflicting from either signal", () => {
    expect(mapMergeable("CONFLICTING", "BLOCKED")).toBe("conflicting");
    expect(mapMergeable("MERGEABLE", "DIRTY")).toBe("conflicting");
  });

  it("maps behind and blocked", () => {
    expect(mapMergeable("MERGEABLE", "BEHIND")).toBe("behind");
    expect(mapMergeable("MERGEABLE", "BLOCKED")).toBe("blocked");
  });

  it.each(["CLEAN", "HAS_HOOKS", "UNSTABLE"])("maps %s to clean", (s) => {
    expect(mapMergeable("MERGEABLE", s)).toBe("clean");
  });

  it("maps anything else, including UNKNOWN and DRAFT, to unknown", () => {
    expect(mapMergeable("UNKNOWN", "UNKNOWN")).toBe("unknown");
    expect(mapMergeable(undefined, "DRAFT")).toBe("unknown");
    expect(mapMergeable(undefined, undefined)).toBe("unknown");
  });
});

describe("mapReview", () => {
  it("maps each decision", () => {
    expect(mapReview("APPROVED")).toBe("approved");
    expect(mapReview("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(mapReview("REVIEW_REQUIRED")).toBe("review_required");
  });

  it("maps null, empty and unrecognised to none", () => {
    expect(mapReview(null)).toBe("none");
    expect(mapReview("")).toBe("none");
    expect(mapReview(undefined)).toBe("none");
    expect(mapReview("WAT")).toBe("none");
  });
});

describe("toPrFacts", () => {
  const raw = (over: Partial<GhPr> = {}): GhPr => ({
    number: 4821, url: "https://github.com/o/r/pull/4821", title: "Fix export",
    state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: null, statusCheckRollup: [checkRun()], ...over,
  });

  it("builds a full record", () => {
    expect(toPrFacts(raw(), 3)).toEqual({
      number: 4821, url: "https://github.com/o/r/pull/4821", title: "Fix export",
      state: "OPEN", isDraft: false,
      ci: { passing: 1, pending: 0, failing: [] },
      review: "none", unresolved: 3, mergeable: "clean", ciAdvisory: false,
    });
  });

  it("returns null without a usable number or url", () => {
    expect(toPrFacts(raw({ number: undefined }), null)).toBeNull();
    expect(toPrFacts(raw({ url: undefined }), null)).toBeNull();
  });

  it("keeps MERGED and CLOSED, and normalises anything else to OPEN", () => {
    expect(toPrFacts(raw({ state: "MERGED" }), null)!.state).toBe("MERGED");
    expect(toPrFacts(raw({ state: "CLOSED" }), null)!.state).toBe("CLOSED");
    expect(toPrFacts(raw({ state: undefined }), null)!.state).toBe("OPEN");
  });

  it("sets ciAdvisory only for UNSTABLE", () => {
    expect(toPrFacts(raw({ mergeStateStatus: "UNSTABLE" }), null)!.ciAdvisory).toBe(true);
    expect(toPrFacts(raw({ mergeStateStatus: "BLOCKED" }), null)!.ciAdvisory).toBe(false);
  });

  it("defaults a missing title to empty and a missing isDraft to false", () => {
    const f = toPrFacts(raw({ title: undefined, isDraft: undefined }), null)!;
    expect(f.title).toBe("");
    expect(f.isDraft).toBe(false);
  });
});

describe("pickPr", () => {
  const p = (number: number, state: string): GhPr => ({ number, state, url: `https://github.com/o/r/pull/${number}` });

  it("returns undefined for an empty list", () => {
    expect(pickPr([])).toBeUndefined();
  });

  it("prefers OPEN over MERGED over CLOSED", () => {
    expect(pickPr([p(1, "CLOSED"), p(2, "MERGED"), p(3, "OPEN")])!.number).toBe(3);
    expect(pickPr([p(1, "CLOSED"), p(2, "MERGED")])!.number).toBe(2);
  });

  it("breaks a same-state tie by highest number", () => {
    expect(pickPr([p(7, "OPEN"), p(9, "OPEN")])!.number).toBe(9);
  });

  it("skips entries with no number", () => {
    expect(pickPr([{ state: "OPEN" }, p(4, "CLOSED")])!.number).toBe(4);
  });
});

describe("parseRepoFromUrl", () => {
  it("reads owner and repo from a github.com PR url", () => {
    expect(parseRepoFromUrl("https://github.com/acme/web-ui/pull/12")).toEqual({ owner: "acme", repo: "web-ui" });
  });

  it("works on an enterprise host", () => {
    expect(parseRepoFromUrl("https://git.corp.example/acme/api/pull/3")).toEqual({ owner: "acme", repo: "api" });
  });

  it("returns null for a url with too few segments or a non-url", () => {
    expect(parseRepoFromUrl("https://github.com/acme")).toBeNull();
    expect(parseRepoFromUrl("not a url")).toBeNull();
  });
});

describe("countUnresolved", () => {
  const wrap = (nodes: unknown) => ({
    data: { repository: { pullRequest: { reviewThreads: { nodes } } } },
  });

  it("counts threads that are neither resolved nor outdated", () => {
    expect(countUnresolved(wrap([
      { isResolved: false, isOutdated: false },
      { isResolved: true, isOutdated: false },
      { isResolved: false, isOutdated: true },
      { isResolved: false, isOutdated: false },
    ]))).toBe(2);
  });

  it("counts zero for an empty thread list", () => {
    expect(countUnresolved(wrap([]))).toBe(0);
  });

  it("returns null when the shape is not a thread list", () => {
    expect(countUnresolved(wrap("nope"))).toBeNull();
    expect(countUnresolved({})).toBeNull();
    expect(countUnresolved(null)).toBeNull();
  });

  it("returns null when a null entry sits alongside a valid thread", () => {
    expect(countUnresolved(wrap([null, { isResolved: false, isOutdated: false }]))).toBeNull();
  });

  it("returns null when a non-object entry sits alongside a valid thread", () => {
    expect(countUnresolved(wrap(["nope", { isResolved: false, isOutdated: false }]))).toBeNull();
    expect(countUnresolved(wrap([7, { isResolved: false, isOutdated: false }]))).toBeNull();
  });

  it("counts a thread missing both fields as unresolved, matching the old behaviour", () => {
    expect(countUnresolved(wrap([{}]))).toBe(1);
  });
});
