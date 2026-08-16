import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { deriveBucket, deriveLane, prSignals } from "../../../src/engine/bucket";
import { PrEntryMap, PrFacts } from "../../../src/types";

const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const entries = (...facts: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(facts.map((f, i) => [`repo${i}`, { facts: f, fetchedAt: 0 }]));

describe("bucket.ts is webview-safe", () => {
  it("imports nothing but ../types, so the browser bundle can include it", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/bucket.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../types"]);
  });
});

describe("deriveBucket", () => {
  it("puts a Jira-done ticket in Done even if the agent is working", () => {
    expect(deriveBucket({ ticketCategory: "done", agentState: "working" })).toBe("done");
  });

  it("surfaces a needs-you agent even while Jira is in progress", () => {
    expect(deriveBucket({ ticketCategory: "indeterminate", agentState: "needs-you" })).toBe("needs");
  });

  it("keeps a working agent in In-progress even in a review status (live beats review)", () => {
    expect(deriveBucket({ ticketStatus: "In Review", agentState: "working" })).toBe("progress");
  });

  it("puts an idle agent in a review status into In review", () => {
    expect(deriveBucket({ ticketStatus: "In Review", agentState: "idle" })).toBe("review");
  });

  it("treats an open PR as In review when the agent is idle", () => {
    expect(deriveBucket({ prOpen: true, agentState: "idle" })).toBe("review");
  });

  it("keeps a working agent in In-progress even with an open PR", () => {
    expect(deriveBucket({ prOpen: true, agentState: "working" })).toBe("progress");
  });

  it("falls back to In-progress (in-flight) for an idle, plain in-progress task", () => {
    expect(deriveBucket({ ticketCategory: "indeterminate", ticketStatus: "In Progress", agentState: "idle" })).toBe("progress");
  });

  it("falls back to In-progress for an unknown agent with nothing else", () => {
    expect(deriveBucket({ ticketCategory: "new", agentState: "unknown" })).toBe("progress");
  });
});

describe("deriveBucket with PR signals", () => {
  it("promotes a blocked PR into Needs you even while the agent is working", () => {
    expect(deriveBucket({ agentState: "working", prBlocked: true })).toBe("needs");
  });

  it("puts a merged PR in Done even when Jira has not caught up", () => {
    expect(deriveBucket({ ticketCategory: "indeterminate", prMerged: true })).toBe("done");
  });

  it("lets Done outrank a blocked PR", () => {
    expect(deriveBucket({ prMerged: true, prBlocked: true })).toBe("done");
  });

  it("still treats an idle agent with an open, unblocked PR as In review", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true })).toBe("review");
  });
});

describe("prSignals", () => {
  it("is all false for no entries", () => {
    expect(prSignals({})).toEqual({ open: false, blocked: false, merged: false, ready: false });
  });

  it("is all false when every entry resolved to no PR", () => {
    expect(prSignals(entries(null, null))).toEqual({ open: false, blocked: false, merged: false, ready: false });
  });

  it("reports open for an open non-draft PR", () => {
    expect(prSignals(entries(prFacts())).open).toBe(true);
  });

  it("does not report open for a draft PR", () => {
    expect(prSignals(entries(prFacts({ isDraft: true }))).open).toBe(false);
  });

  it("does not report open for a closed or merged PR", () => {
    expect(prSignals(entries(prFacts({ state: "CLOSED" }))).open).toBe(false);
    expect(prSignals(entries(prFacts({ state: "MERGED" }))).open).toBe(false);
  });

  it("blocks on a failing check", () => {
    expect(prSignals(entries(prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } }))).blocked).toBe(true);
  });

  it("does not block on a failing check that is only advisory (UNSTABLE)", () => {
    const f = prFacts({ ci: { passing: 0, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true });
    expect(prSignals(entries(f)).blocked).toBe(false);
  });

  it("blocks on requested changes and on a conflict", () => {
    expect(prSignals(entries(prFacts({ review: "changes_requested" }))).blocked).toBe(true);
    expect(prSignals(entries(prFacts({ mergeable: "conflicting" }))).blocked).toBe(true);
  });

  it("does not block on a closed PR's stale failures", () => {
    const f = prFacts({ state: "CLOSED", ci: { passing: 0, pending: 0, failing: [{ name: "build", url: "" }] } });
    expect(prSignals(entries(f)).blocked).toBe(false);
  });

  it("blocks the whole run when any one repo is blocked", () => {
    expect(prSignals(entries(prFacts(), prFacts({ mergeable: "conflicting" }))).blocked).toBe(true);
  });

  it("reports merged only when every PR-bearing repo has merged", () => {
    expect(prSignals(entries(prFacts({ state: "MERGED" }))).merged).toBe(true);
    expect(prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "OPEN" }))).merged).toBe(false);
  });

  it("ignores PR-less repos when deciding merged", () => {
    expect(prSignals(entries(prFacts({ state: "MERGED" }), null)).merged).toBe(true);
  });
});

describe("prSignals.ready", () => {
  it("is false with no PR at all", () => {
    expect(prSignals({}).ready).toBe(false);
  });

  it("is true for an approved, clean, green open PR", () => {
    expect(prSignals(entries(prFacts({ review: "approved" }))).ready).toBe(true);
  });

  it("is false while review is still pending or required", () => {
    expect(prSignals(entries(prFacts({ review: "none" }))).ready).toBe(false);
    expect(prSignals(entries(prFacts({ review: "review_required" }))).ready).toBe(false);
  });

  it("is false on a conflict, and on a branch merely behind its base", () => {
    expect(prSignals(entries(prFacts({ review: "approved", mergeable: "conflicting" }))).ready).toBe(false);
    expect(prSignals(entries(prFacts({ review: "approved", mergeable: "behind" }))).ready).toBe(false);
    expect(prSignals(entries(prFacts({ review: "approved", mergeable: "unknown" }))).ready).toBe(false);
  });

  it("is false on a failing check even when that check is only advisory", () => {
    // `blocked` forgives an advisory failure — a red check is not worth pinning a
    // card in Action required. "Ready to merge" is the stricter claim: it promises
    // there is nothing left to look at, so any red at all disqualifies.
    const f = prFacts({ review: "approved", ciAdvisory: true, ci: { passing: 0, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] } });
    expect(prSignals(entries(f)).blocked).toBe(false);
    expect(prSignals(entries(f)).ready).toBe(false);
  });

  it("is false while a check is still running", () => {
    expect(prSignals(entries(prFacts({ review: "approved", ci: { passing: 1, pending: 1, failing: [] } }))).ready).toBe(false);
  });

  it("is false for a draft PR, however green", () => {
    expect(prSignals(entries(prFacts({ review: "approved", isDraft: true }))).ready).toBe(false);
  });

  it("is false once the PR has merged — there is nothing left to merge", () => {
    expect(prSignals(entries(prFacts({ review: "approved", state: "MERGED" }))).ready).toBe(false);
  });

  it("needs every open PR in the run, not just one", () => {
    const approved = prFacts({ review: "approved" });
    expect(prSignals(entries(approved, prFacts({ review: "none" }))).ready).toBe(false);
    expect(prSignals(entries(approved, prFacts({ review: "approved" }))).ready).toBe(true);
  });

  it("ignores a repo whose PR already merged while another is still open", () => {
    expect(prSignals(entries(prFacts({ review: "approved" }), prFacts({ state: "MERGED" }))).ready).toBe(true);
  });

  it("ignores a repo with no PR at all", () => {
    expect(prSignals(entries(prFacts({ review: "approved" }), null)).ready).toBe(true);
  });
});

describe("deriveLane", () => {
  const signals = (over: Partial<ReturnType<typeof prSignals>> = {}) => ({
    open: false, blocked: false, merged: false, ready: false, ...over,
  });

  it("splits In review into ready-to-merge and waiting-on-review", () => {
    expect(deriveLane("review", signals({ open: true, ready: true }))).toBe("ready");
    expect(deriveLane("review", signals({ open: true }))).toBe("waiting");
  });

  it("waits when the column came from a Jira review status with no PR", () => {
    expect(deriveLane("review", signals())).toBe("waiting");
  });

  it("splits Done into merged and not-merged", () => {
    expect(deriveLane("done", signals({ merged: true }))).toBe("merged");
    expect(deriveLane("done", signals())).toBe("unmerged");
  });

  it("leaves the single-lane columns unlaned", () => {
    expect(deriveLane("progress", signals({ ready: true }))).toBeNull();
    expect(deriveLane("needs", signals({ merged: true }))).toBeNull();
  });
});
