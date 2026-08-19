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
  it("promotes a blocked PR into In review even while the agent is working", () => {
    // Action required is agent-driven now: a PR that needs a human is the review
    // column's business. The rung keeps its place in the ladder — only the column
    // it returns changed — so a blocked PR still outranks the live agent signal.
    expect(deriveBucket({ agentState: "working", prBlocked: true })).toBe("review");
  });

  it("still treats an idle agent with an open, unblocked PR as In review", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true })).toBe("review");
  });

  it("gives an approved, green PR the merge column of its own", () => {
    expect(deriveBucket({ agentState: "idle", prOpen: true, prReady: true })).toBe("merge");
  });

  it("keeps a merged run in the merge column, where its wrap-up is", () => {
    expect(deriveBucket({ agentState: "idle", prMerged: true })).toBe("merge");
  });

  it("keeps a post-merge agent beside its merge rather than back in In progress", () => {
    expect(deriveBucket({ agentState: "working", prMerged: true })).toBe("merge");
  });

  it("promotes ready to merge over a working agent, mirroring the blocked rung", () => {
    // `ready` and `blocked` are the two sides of the same PR read, and both
    // outrank the live agent signal for the same reason: the agent cannot know.
    expect(deriveBucket({ agentState: "working", prOpen: true, prReady: true })).toBe("merge");
    expect(deriveBucket({ agentState: "working", prOpen: true, prBlocked: true })).toBe("review");
  });

  it("lets a blocked PR outrank a ready one — a run with one of each needs the fix first", () => {
    // prSignals can report both across repos: one PR approved and green, another
    // conflicting. The board must ask for the fix, not offer the merge.
    expect(deriveBucket({ prOpen: true, prReady: true, prBlocked: true })).toBe("review");
  });

  it("keeps a needs-you agent above a merge that has not happened yet", () => {
    // Approved and green is not landed. Work is still in flight, so an agent
    // that ended its turn asking something is still the more urgent signal.
    expect(deriveBucket({ agentState: "needs-you", prOpen: true, prReady: true })).toBe("needs");
    expect(deriveBucket({ agentState: "stalled", prOpen: true, prReady: true })).toBe("needs");
    expect(deriveBucket({ agentState: "exited", prOpen: true, prReady: true })).toBe("needs");
  });

  it("lets a landed merge outrank every needs-you signal", () => {
    // The merge is a fact read from GitHub; the agent state is a transcript
    // reading that nothing invalidates once the work lands. A question asked
    // before the merge is answered by the merge.
    expect(deriveBucket({ agentState: "needs-you", prMerged: true })).toBe("merge");
    expect(deriveBucket({ agentState: "stalled", prMerged: true })).toBe("merge");
    expect(deriveBucket({ agentState: "exited", prMerged: true })).toBe("merge");
  });

  it("puts a landed run in the merged lane, not the ready one", () => {
    // The column is only half the answer: a run that reaches merge off
    // `prMerged` must not read as "ready to press merge".
    const s = { open: false, blocked: false, ready: false, merged: true };
    expect(deriveLane(deriveBucket({ agentState: "needs-you", prMerged: true }), s)).toBe("merged");
  });
});

describe("Action required is agent-driven", () => {
  it("keeps every agent signal there — the column means an agent wants you", () => {
    expect(deriveBucket({ agentState: "needs-you" })).toBe("needs");
    expect(deriveBucket({ agentState: "stalled" })).toBe("needs");
    expect(deriveBucket({ agentState: "exited" })).toBe("needs");
  });

  it("no longer sends a PR-only problem there — nobody asked you anything", () => {
    // The one signal that left: a red PR under an idle agent used to read as
    // "an agent needs you", which it never was. It is the review column's
    // fixes-needed lane now.
    expect(deriveBucket({ agentState: "idle", prOpen: true, prBlocked: true })).toBe("review");
    expect(deriveBucket({ agentState: "unknown", prOpen: true, prBlocked: true })).toBe("review");
  });

  it("still lets an agent that ended its turn outrank its own blocked PR", () => {
    // Both are true at once all the time — the agent stopped *because* CI went
    // red. The agent asking is the more answerable of the two.
    expect(deriveBucket({ agentState: "needs-you", prOpen: true, prBlocked: true })).toBe("needs");
  });

  it("routes a blocked draft PR to In review, which prOpen alone would not", () => {
    // prSignals.blocked counts drafts; prSignals.open does not. Without its own
    // rung a red draft would fall past review into the parked lane of progress.
    expect(deriveBucket({ agentState: "idle", prOpen: false, prBlocked: true })).toBe("review");
  });
});

describe("deriveLane on In progress", () => {
  const none = { open: false, blocked: false, ready: false, merged: false };

  it("puts a live agent in the working lane", () => {
    expect(deriveLane("progress", none, "working")).toBe("working");
  });

  it("puts every other state in the parked lane — nobody is home", () => {
    expect(deriveLane("progress", none, "idle")).toBe("parked");
    expect(deriveLane("progress", none, "unknown")).toBe("parked");
  });

  it("parks a card with no agent state at all rather than leaving it laneless", () => {
    // An agentless run reaches progress through laneOf, which has only the run's
    // own reduction to offer. A null lane would render it outside every lane
    // header, in a column that promises it renders none.
    expect(deriveLane("progress", none, undefined)).toBe("parked");
  });
});

describe("deriveLane on In review", () => {
  const open = { open: true, blocked: false, ready: false, merged: false };

  it("puts a blocked PR in the fixes-needed lane", () => {
    expect(deriveLane("review", { ...open, blocked: true }, "idle")).toBe("fixes");
  });

  it("puts an unblocked PR in the waiting lane — it is somebody else's turn", () => {
    expect(deriveLane("review", open, "idle")).toBe("waiting");
  });

  it("waits rather than claiming fixes for a card that reached review off its ticket status", () => {
    // No PR at all: `prOpen || isReviewStatus` is how a Jira-review ticket gets
    // here, and there is nothing to fix.
    expect(deriveLane("review", { open: false, blocked: false, ready: false, merged: false }, "idle")).toBe("waiting");
  });
});

describe("deriveLane leaves the columns that mean one thing alone", () => {
  const none = { open: false, blocked: false, ready: false, merged: false };

  it("returns null for Action required", () => {
    expect(deriveLane("needs", none, "needs-you")).toBe(null);
  });

  it("still splits merge on the merge signals, ignoring the agent", () => {
    expect(deriveLane("merge", { ...none, merged: true }, "working")).toBe("merged");
    expect(deriveLane("merge", { ...none, ready: true }, "working")).toBe("ready");
  });
});


describe("prSignals", () => {
  it("is all false for no entries", () => {
    expect(prSignals({})).toEqual({ open: false, blocked: false, ready: false, merged: false });
  });

  it("is all false when every entry resolved to no PR", () => {
    expect(prSignals(entries(null, null))).toEqual({ open: false, blocked: false, ready: false, merged: false });
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

  it("splits the merge column into the press and its aftermath", () => {
    expect(deriveLane("merge", signals({ open: true, ready: true }))).toBe("ready");
    expect(deriveLane("merge", signals({ merged: true }))).toBe("merged");
  });

  it("tests merged first — a landed PR is never `ready`, so asking that first would mislane it", () => {
    // prSignals.ready is false once the PR merges (there is nothing left to
    // merge), so a `ready ? "ready" : "merged"` ordering would still work here —
    // what it would NOT survive is a multi-repo run with one landed and one
    // approved-and-open PR, where both flags are set at once.
    expect(deriveLane("merge", signals({ merged: true, ready: true, open: true }))).toBe("merged");
  });

  it("leaves Action required unlaned — it is the one column that means one thing", () => {
    expect(deriveLane("needs", signals({ merged: true }))).toBeNull();
  });

  it("lanes progress and review off their own signals, not the merge ones", () => {
    // Both columns are laned now, and neither reads the merge flags: a stray
    // `ready` cannot pull a progress card into a lane it has no business in.
    expect(deriveLane("progress", signals({ ready: true }))).toBe("parked");
    expect(deriveLane("review", signals({ open: true }))).toBe("waiting");
  });
});

describe("a multi-repo merged run", () => {
  it("takes the merge column and its merged lane, not a column of its own", () => {
    const merged = prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "MERGED" })));
    expect(merged.merged).toBe(true);
    const column = deriveBucket({ prOpen: merged.open, prReady: merged.ready, prMerged: merged.merged });
    expect(column).toBe("merge");
    expect(deriveLane(column, merged)).toBe("merged");
  });

  it("is not merged when one repo landed and another is still open", () => {
    const half = prSignals(entries(prFacts({ state: "MERGED" }), prFacts({ state: "OPEN" })));
    expect(half.merged).toBe(false);
    expect(deriveBucket({ agentState: "idle", prOpen: half.open, prMerged: half.merged })).toBe("review");
  });
});
