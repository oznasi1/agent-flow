import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AttentionCandidate, attentionKeys, attentionLabel, nextAnnouncements, ownsWorkToLose, sameAnnounced } from "../../../src/engine/attention";
import { AgentState, PrEntryMap, PrFacts, Run } from "../../../src/types";
import { deriveBucket, prSignals } from "../../../src/engine/bucket";
import { shelfFor } from "../../../src/engine/visibility";

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

describe("attentionKeys agrees with the column the Deck draws", () => {
  it("selects exactly the boarded candidates deriveBucket calls needs", () => {
    // What this actually guards, since both sides below call the same
    // `deriveBucket`/`shelfFor` from this same file — it is NOT a guard
    // against a future `deriveBucket` precedence change, and `deckView.ts`
    // is not even imported here. The real thing it pins is the one place
    // `attentionKeys`'s own shelf check reads a DIFFERENT field than the
    // column check right below it: `shelfFor`'s `prOpen` counts a draft PR as
    // open (unmerged work in flight), while `prSignals(c.prs).open` — what
    // feeds the column check — does not. The `isDraft: true` entry in
    // `prSets` below exists to exercise exactly that seam; swap which of the
    // two `prOpen`s attentionKeys reads and this fails.
    const states: AgentState[] = ["needs-you", "stalled", "exited", "working", "idle", "unknown"];
    const prSets: PrEntryMap[] = [
      {},
      prs(facts()),
      prs(facts({ state: "MERGED" })),
      prs(facts({ isDraft: true })),
      prs(facts({ review: "changes_requested" })),
      prs(facts({ review: "approved" })),
    ];
    const all: AttentionCandidate[] = [];
    let n = 0;
    for (const agentState of states) {
      for (const p of prSets) {
        for (const hasLiveSession of [true, false]) {
          for (const hasWorkToLose of [true, false]) {
            all.push(cand({ key: `k${n++}`, agentState, prs: p, hasLiveSession, hasWorkToLose }));
          }
        }
      }
    }

    // `attentionKeys`'s own two-step logic, restated inline rather than called.
    // Independent of `attentionKeys`'s CONTROL FLOW (its early `continue`, its
    // one loop over `candidates`), but not of `deriveBucket`/`shelfFor`
    // themselves — see the note above on what that does and does not prove.
    const expected = all
      .filter((c) => {
        const pr = prSignals(c.prs);
        return shelfFor({
          hasLiveSession: c.hasLiveSession,
          prOpen: Object.values(c.prs).some((e) => e.facts?.state === "OPEN"),
          merged: pr.merged,
          justLaunched: c.justLaunched,
          hasWorkToLose: c.hasWorkToLose,
        }) === "board";
      })
      .filter((c) => {
        const pr = prSignals(c.prs);
        return deriveBucket({
          ticketStatus: c.ticketStatus, agentState: c.agentState,
          prOpen: pr.open, prBlocked: pr.blocked, prReady: pr.ready, prMerged: pr.merged,
        }) === "needs";
      })
      .map((c) => c.key);

    expect(attentionKeys(all)).toEqual(expected);
    // A parity test that compares two empty arrays proves nothing.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.length);
  });
});

describe("attentionLabel", () => {
  it("names a ticket run by the ticket key its caller resolved", () => {
    // The design doc's promise: "BITE-42 is waiting on you".
    expect(attentionLabel(run({ key: "BITE-42", summary: "isolate the renew queue" }), "BITE-42")).toBe("BITE-42");
  });

  it("prefers the resolved ticket key over the record key", () => {
    // A local card promoted with Track it keeps its place-hash key and carries
    // the ticket only in its url, so the key is not the name even here.
    const promoted = run({ key: "local-centaur-3f2a91bc", summary: "centaur", url: "https://jira/browse/BITE-9" });
    expect(attentionLabel(promoted, "BITE-9")).toBe("BITE-9");
  });

  it("names a ticketless run by its summary — the key is a generated slug", () => {
    const explore = run({ key: "explore-why-the-queue-stalls", summary: "why the queue stalls", url: "", kind: "explore" });
    expect(attentionLabel(explore, "explore-why-the-queue-stalls")).toBe("why the queue stalls");
  });

  it("names an untracked local card by its summary, never by localKey's hash", () => {
    // The bug: "local-agent-flow-3f2a91bc is waiting on you".
    const local = run({ key: "local-agent-flow-3f2a91bc", summary: "agent-flow", url: "", kind: "local" });
    expect(attentionLabel(local, "local-agent-flow-3f2a91bc")).toBe("agent-flow");
  });

  it("names a notepad run by its summary — its key carries a hash suffix", () => {
    const notepad = run({ key: "notepad-check-the-copy-mt45dsy5-t2wu9y", summary: "check the copy", url: "", kind: "notepad" });
    expect(attentionLabel(notepad, "notepad-check-the-copy-mt45dsy5-t2wu9y")).toBe("check the copy");
  });
});

describe("sameAnnounced", () => {
  it("is true for the same keys carrying the same stamps", () => {
    expect(sameAnnounced({ A: 1, B: 2 }, { A: 1, B: 2 })).toBe(true);
  });

  it("ignores key order — a parsed record and a rebuilt one differ in it", () => {
    expect(sameAnnounced({ A: 1, B: 2 }, { B: 2, A: 1 })).toBe(true);
  });

  it("is true for two empty records", () => {
    expect(sameAnnounced({}, {})).toBe(true);
  });

  it("is false when a key entered", () => {
    expect(sameAnnounced({ A: 1 }, { A: 1, B: 2 })).toBe(false);
  });

  it("is false when a key left", () => {
    expect(sameAnnounced({ A: 1, B: 2 }, { A: 1 })).toBe(false);
  });

  it("is false when a key was swapped for another — same size, different set", () => {
    expect(sameAnnounced({ A: 1 }, { B: 1 })).toBe(false);
  });

  it("is false when a stamp moved", () => {
    // A re-announce rewrites the stamp with the same key set; that has to persist.
    expect(sameAnnounced({ A: 1 }, { A: 2 })).toBe(false);
  });
});
