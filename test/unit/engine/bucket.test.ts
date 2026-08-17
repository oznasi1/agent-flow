import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { deriveBucket, prSignals } from "../../../src/engine/bucket";
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
  it("has no finished column to route to — a done ticket is bucketed on its live signals alone", () => {
    // Jira-done used to short-circuit the whole ladder. It is not an input any
    // more: `shelfFor` takes a landed run off the board before it gets here, and
    // one that is still on the board (an agent open in it, a PR still to merge)
    // deserves the column its live signals say.
    expect(deriveBucket({ agentState: "working" })).toBe("progress");
    expect(deriveBucket({ agentState: "needs-you" })).toBe("needs");
  });

  it("surfaces a needs-you agent even while Jira is in progress", () => {
    expect(deriveBucket({ ticketStatus: "In Progress", agentState: "needs-you" })).toBe("needs");
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
    expect(deriveBucket({ ticketStatus: "In Progress", agentState: "idle" })).toBe("progress");
  });

  it("falls back to In-progress for an unknown agent with nothing else", () => {
    expect(deriveBucket({ agentState: "unknown" })).toBe("progress");
  });

  it("routes a stalled agent to needs — it is stuck, not calm", () => {
    expect(deriveBucket({ ticketStatus: null, agentState: "stalled",
      prOpen: false, prBlocked: false, prReady: false })).toBe("needs");
  });

  it("routes an exited agent to needs — it died with work in flight", () => {
    expect(deriveBucket({ ticketStatus: null, agentState: "exited",
      prOpen: false, prBlocked: false, prReady: false })).toBe("needs");
  });

  it("still does not route an idle agent to needs", () => {
    expect(deriveBucket({ ticketStatus: null, agentState: "idle",
      prOpen: false, prBlocked: false, prReady: false })).not.toBe("needs");
  });
});

describe("deriveBucket with PR signals", () => {
  it("promotes a blocked PR into Needs you even while the agent is working", () => {
    expect(deriveBucket({ agentState: "working", prBlocked: true })).toBe("needs");
  });

  it("still treats an idle agent with an open, unblocked PR as In review", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true })).toBe("review");
  });

  it("gives an approved, green PR the merge column of its own", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true, prReady: true })).toBe("merge");
  });

  it("promotes ready to merge over a working agent, mirroring the blocked rung", () => {
    // `ready` and `blocked` are the two sides of the same PR read, and both
    // outrank the live agent signal for the same reason: the agent cannot know.
    expect(deriveBucket({ agentState: "working", prOpen: true, prReady: true })).toBe("merge");
    expect(deriveBucket({ agentState: "working", prOpen: true, prBlocked: true })).toBe("needs");
  });

  it("lets a blocked PR outrank a ready one — a run with one of each needs you first", () => {
    // prSignals can report both across repos: one PR approved and green, another
    // conflicting. The board must ask for the fix, not offer the merge.
    expect(deriveBucket({ prOpen: true, prReady: true, prBlocked: true })).toBe("needs");
  });

  it("keeps a needs-you agent above the merge, even on a ready PR", () => {
    expect(deriveBucket({ agentState: "needs-you", prOpen: true, prReady: true })).toBe("needs");
  });
});

describe("prSignals", () => {
  it("is all false for no entries", () => {
    expect(prSignals({})).toEqual({ open: false, blocked: false, ready: false });
  });

  it("is all false when every entry resolved to no PR", () => {
    expect(prSignals(entries(null, null))).toEqual({ open: false, blocked: false, ready: false });
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

  it("reports nothing at all for a run whose every PR merged — no open, no ready, no block", () => {
    // Landing is `landed()` in visibility.ts, not a signal here. What this must
    // guarantee is that a merged run trips none of the three rungs that would
    // otherwise hold it on the board.
    expect(prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "MERGED" }))))
      .toEqual({ open: false, blocked: false, ready: false });
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

describe("the merged run takes no column", () => {
  // The migration's load-bearing case, run through the two functions that decide
  // it. `shelfFor` sends this run to the Recently closed strip (visibility.test.ts
  // owns that half); what matters here is that nothing in the ladder would have
  // claimed it either — the fourth column is gone, not renamed.
  it("buckets a multi-repo run whose every PR landed nowhere special", () => {
    const merged = prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "MERGED" })));
    expect(deriveBucket({ prOpen: merged.open, prReady: merged.ready, prBlocked: merged.blocked })).toBe("progress");
  });
});
