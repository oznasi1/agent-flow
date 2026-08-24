import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AttentionCandidate, attentionKeys, nextAnnouncements, ownsWorkToLose } from "../../../src/engine/attention";
import { PrEntryMap, PrFacts, Run } from "../../../src/types";
import { deriveBucket } from "../../../src/engine/bucket";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 1, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const prs = (...f: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(f.map((x, i) => [`repo${i}`, { facts: x, fetchedAt: 0 }]));

const cand = (over: Partial<AttentionCandidate> = {}): AttentionCandidate => ({
  key: "BITE-1", agentState: "needs-you", prs: {}, ticketStatus: null,
  hasLiveSession: true, justLaunched: false, hasWorkToLose: false, showAll: false, ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  key: "BITE-1", summary: "s", url: "https://jira/BITE-1", createdAt: 0,
  mode: "per-window", repos: [], briefPaths: [], ...over,
});

describe("attention.ts stays a leaf", () => {
  it("imports nothing that could reach a Node builtin", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/engine/attention.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(["../types", "./bucket", "./visibility"]);
  });
});

describe("attentionKeys", () => {
  it("counts every state that means a human has to do something", () => {
    const keys = attentionKeys([
      cand({ key: "A", agentState: "needs-you" }),
      cand({ key: "B", agentState: "stalled" }),
      cand({ key: "C", agentState: "exited", hasLiveSession: false, justLaunched: true }),
    ]);
    expect(keys).toEqual(["A", "B", "C"]);
  });

  it("ignores a run nobody is waiting on", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "working" }),
      cand({ key: "B", agentState: "idle" }),
      cand({ key: "C", agentState: "unknown" }),
    ])).toEqual([]);
  });

  it("drops a merged run — the merge is the answer to the question it asked", () => {
    expect(attentionKeys([cand({ prs: prs(facts({ state: "MERGED" })) })])).toEqual([]);
  });

  it("drops a run the board would have shelved", () => {
    // Exited, nobody in it, no PR, nothing to lose, not just launched: this card
    // is on the Recently closed strip, not in Action required.
    expect(attentionKeys([
      cand({ agentState: "exited", hasLiveSession: false }),
    ])).toEqual([]);
  });

  it("keeps a shelvable run when inflightShowAll is on", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, showAll: true }),
    ])).toEqual(["A"]);
  });

  it("keeps an exited run held on the board by work you could lose", () => {
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, hasWorkToLose: true }),
    ])).toEqual(["A"]);
  });

  it("treats a draft PR as work in flight, so an exited run with one stays countable", () => {
    // shelfFor's prOpen counts drafts; prSignals().open does not. Reading the
    // wrong one here would shelve this card and lose the badge.
    expect(attentionKeys([
      cand({ key: "A", agentState: "exited", hasLiveSession: false, prs: prs(facts({ isDraft: true })) }),
    ])).toEqual(["A"]);
  });

  it("never lets the ticket status change an attention verdict", () => {
    // The gatherer passes null because reading Jira on the hidden path is
    // forbidden; the Deck passes the real value. Nothing above `needs` in
    // deriveBucket's ladder reads ticketStatus today, so this cannot fail now —
    // it exists to fail the day something above `needs` starts reading it, which
    // is exactly when the gatherer's null would start diverging from the Deck.
    // See the positive control below for why that premise is not vacuous.
    for (const ticketStatus of [null, "In Review", "Done", "In Progress", "QA"]) {
      expect(attentionKeys([cand({ ticketStatus })])).toEqual(["BITE-1"]);
      expect(attentionKeys([cand({ ticketStatus, agentState: "working" })])).toEqual([]);
    }
  });

  it("guards a parameter that deriveBucket really does read", () => {
    // The positive control for the test above. Without this, "ticketStatus never
    // changes an attention verdict" is trivially true and proves nothing: the
    // review rung that reads it sits below `needs`, so attentionKeys can never
    // see it matter. This asserts it is a live input one rung down — which is
    // what makes the guard above meaningful the day someone reorders the ladder.
    const quiet = { agentState: "idle" as const, prOpen: false, prBlocked: false, prReady: false, prMerged: false };
    expect(deriveBucket({ ...quiet, ticketStatus: "In Review" })).toBe("review");
    expect(deriveBucket({ ...quiet, ticketStatus: null })).toBe("progress");
  });

  it("keeps input order, so the count and the board agree on which card is first", () => {
    expect(attentionKeys([cand({ key: "Z" }), cand({ key: "A" })])).toEqual(["Z", "A"]);
  });
});

describe("ownsWorkToLose", () => {
  it("refuses a ticketless Explore run — that dirty checkout is your own work", () => {
    expect(ownsWorkToLose(run({ kind: "explore", url: "" }))).toBe(false);
  });

  it("refuses a ticketless Notepad run for the same reason", () => {
    expect(ownsWorkToLose(run({ kind: "notepad", url: "" }))).toBe(false);
  });

  it("allows an Explore run taken against a ticket — it owns its branch", () => {
    expect(ownsWorkToLose(run({ kind: "explore", url: "https://jira/BITE-1" }))).toBe(true);
  });

  it("allows a plain task run", () => {
    expect(ownsWorkToLose(run())).toBe(true);
  });
});

describe("nextAnnouncements", () => {
  it("announces a run that just entered Action required", () => {
    const out = nextAnnouncements(["A"], {}, 100);
    expect(out.toAnnounce).toEqual(["A"]);
    expect(out.announced).toEqual({ A: 100 });
  });

  it("says nothing on the next pass — level-triggered, not repeated every tick", () => {
    const first = nextAnnouncements(["A"], {}, 100);
    const second = nextAnnouncements(["A"], first.announced, 200);
    expect(second.toAnnounce).toEqual([]);
    expect(second.announced).toEqual({ A: 100 });
  });

  it("re-announces a run that parked, was answered, and parked again", () => {
    const parked = nextAnnouncements(["A"], {}, 100);
    const answered = nextAnnouncements([], parked.announced, 200);
    expect(answered.toAnnounce).toEqual([]);
    const again = nextAnnouncements(["A"], answered.announced, 300);
    expect(again.toAnnounce).toEqual(["A"]);
    expect(again.announced).toEqual({ A: 300 });
  });

  it("prunes itself — a stamp survives only while its run is still waiting", () => {
    const out = nextAnnouncements([], { GONE: 1, ALSO_GONE: 2 }, 300);
    expect(out.announced).toEqual({});
  });

  it("hands back every new key at once, so the caller can raise one toast", () => {
    const out = nextAnnouncements(["A", "B", "C"], { B: 50 }, 100);
    expect(out.toAnnounce).toEqual(["A", "C"]);
    expect(out.announced).toEqual({ A: 100, B: 50, C: 100 });
  });

  it("does not mutate the record it was given", () => {
    const announced = { A: 1 };
    nextAnnouncements(["B"], announced, 100);
    expect(announced).toEqual({ A: 1 });
  });
});
