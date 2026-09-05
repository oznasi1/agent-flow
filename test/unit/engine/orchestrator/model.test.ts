import { describe, it, expect } from "vitest";
import {
  emptyFlow, isPlace, isPlanned, isNotify, isCommand, isGate, isSettled, isSpendAction, findNode, gateAskEdge,
  incomingEdges, actionFor, edgeAction, condIncomplete, stripHostStamps, nextNodeId, nextEdgeId, hasDeadline, deadlineAt, outputContains, Condition, retryPending, retryPolicy, hasCeiling, overCeiling, spendTotal, hasTokenCeiling, atTokenCeiling, flowRunKeys, isPerformedAction, isSubflow, subflowDone, bindSubflow, subflowDepth, MAX_SUBFLOW_DEPTH, SubflowNode,
  Flow, FlowEdge, FlowNode, PlaceNode, PlannedNode, NotifyNode, GateNode,
} from "../../../../src/engine/orchestrator/model";

const place = (id: string, over: Partial<PlaceNode> = {}): PlaceNode => ({
  id, kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "agent-flow", ...over,
});
const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 0, y: 0, join: "any",
  ticketKey: "PROJ-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
});
const notify = (id: string, over: Partial<NotifyNode> = {}): NotifyNode => ({
  id, kind: "notify", x: 0, y: 0, join: "any", message: "landed", ...over,
});
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({
  id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over,
});

describe("emptyFlow", () => {
  it("is disarmed, named, and empty", () => {
    const f = emptyFlow("f1", "Ship the migration", 1_000);
    expect(f).toEqual({
      id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes: [], edges: [],
    });
  });

  it("emptyFlow has no launch approval yet", () => {
    expect(emptyFlow("f1", "n", 1).launchConfirmedAt).toBeUndefined();
  });
});

describe("node guards", () => {
  it("identifies each kind and rejects the others", () => {
    const p = place("n1"), pl = planned("n2"), nt = notify("n3");
    expect([isPlace(p), isPlanned(p), isNotify(p)]).toEqual([true, false, false]);
    expect([isPlace(pl), isPlanned(pl), isNotify(pl)]).toEqual([false, true, false]);
    expect([isPlace(nt), isPlanned(nt), isNotify(nt)]).toEqual([false, false, true]);
  });

  it("recognises a command node", () => {
    const n: FlowNode = { id: "c", kind: "command", x: 0, y: 0, join: "any", commandId: "deploy" };
    expect(isCommand(n)).toBe(true);
    expect(isCommand({ id: "p", kind: "place", x: 0, y: 0, join: "any", runKey: "K", repo: "r" })).toBe(false);
  });
});

describe("isSettled", () => {
  // The shared notion `evaluate.ts` skips on and `armability.ts` must agree with.
  // It lives in model.ts precisely so those two cannot drift again — armability
  // used to check `firedAt` alone and reported an errored edge as "waiting on a
  // toggle".
  it("is false for an edge that has neither fired nor errored", () => {
    expect(isSettled(edge("e1", "a", "z"))).toBe(false);
  });

  it("is true once firedAt is stamped", () => {
    expect(isSettled(edge("e1", "a", "z", { firedAt: 1 }))).toBe(true);
  });

  it("is true for an error with no firedAt — the half a firedAt-only check misses", () => {
    expect(isSettled(edge("e1", "a", "z", { error: "Couldn't launch PROJ-12: no worktree" }))).toBe(true);
  });

  it("is true when both are set", () => {
    expect(isSettled(edge("e1", "a", "z", { firedAt: 1, error: "boom" }))).toBe(true);
  });
});

describe("isSpendAction", () => {
  // The one place "does this action cost money" is answered — `evaluate.ts`'s
  // launch cap, `deckView.ts`'s once-per-target dedupe and its dispatch check,
  // and `spendTarget()` all defer to this rather than re-spelling `!== "notify"`
  // (or `=== "launch" || === "seed"`) at each site by hand.
  it("is true for launch and seed", () => {
    expect(isSpendAction("launch")).toBe(true);
    expect(isSpendAction("seed")).toBe(true);
  });

  it("is false for notify", () => {
    expect(isSpendAction("notify")).toBe(false);
  });

  // `run` spends: it executes shell on the user's machine unattended.
  // `isSpendAction`'s own comment warns a new action defaults to "free" until
  // added deliberately, and free would mean skipping the consent gate.
  it("treats run as a spending action", () => {
    expect(isSpendAction("run")).toBe(true);
  });

  // `FlowEdge.action` is optional now — an edge with no derivable action
  // cannot spend anything, the same as one with a known non-spending action.
  it("is false for undefined", () => {
    expect(isSpendAction(undefined)).toBe(false);
  });
});

describe("findNode", () => {
  const flow: Flow = { ...emptyFlow("f1", "f", 0), nodes: [place("n1"), notify("n2")] };

  it("finds a node by id", () => {
    expect(findNode(flow, "n2")?.kind).toBe("notify");
  });

  it("is undefined for an id that is not in the flow", () => {
    expect(findNode(flow, "nope")).toBeUndefined();
  });
});

describe("incomingEdges", () => {
  const nodes: FlowNode[] = [place("a"), place("b"), notify("z")];
  const flow: Flow = {
    ...emptyFlow("f1", "f", 0),
    nodes,
    edges: [edge("e1", "a", "z"), edge("e2", "b", "z"), edge("e3", "a", "b")],
  };

  it("returns every edge pointing at the node, in flow order", () => {
    expect(incomingEdges(flow, "z").map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("is empty for a node nothing points at", () => {
    expect(incomingEdges(flow, "a")).toEqual([]);
  });
});

describe("actionFor", () => {
  it("maps every node kind to its action", () => {
    expect(actionFor("planned")).toBe("launch");
    expect(actionFor("place")).toBe("seed");
    expect(actionFor("notify")).toBe("notify");
    expect(actionFor("command")).toBe("run");
  });

  // The store admits an unknown `kind` string on purpose, so a flow written by a
  // NEWER build still renders here. It must derive no action rather than guess.
  it("derives nothing from an unknown kind", () => {
    expect(actionFor("teleport")).toBeUndefined();
    expect(actionFor("")).toBeUndefined();
  });
});

describe("edgeAction", () => {
  const flow: Flow = {
    ...emptyFlow("f1", "f", 0),
    nodes: [planned("n1"), place("n2"), notify("n3")],
  };

  // The action is what the edge's TARGET implies — `e.to`, not `e.from`. A
  // swap of the two here is a mutation that ships green if this is only ever
  // exercised indirectly through `store.ts`'s call sites, both of which
  // happen to read `e.to` correctly; asserting it directly, with `from` and
  // `to` naming DIFFERENT node kinds, pins the direction on its own.
  it("reads the target (e.to), not the source (e.from)", () => {
    expect(edgeAction(flow, edge("e1", "n1", "n2"))).toBe("seed");
    expect(edgeAction(flow, edge("e2", "n2", "n1"))).toBe("launch");
  });

  it("is undefined when the target is missing", () => {
    expect(edgeAction(flow, edge("e1", "n1", "nope"))).toBeUndefined();
  });
});

describe("condIncomplete", () => {
  it("says nothing about a condition that carries no parameter", () => {
    expect(condIncomplete({ kind: "pr-merged" })).toBeUndefined();
  });

  it("says nothing about an idle rule, which is always complete", () => {
    // `withCond` seeds it with a real span and the control cannot produce a
    // blank, so it has no incomplete shape. `minutes: 0` is not incomplete
    // either — "fires as soon as the session is idle" is a rule that works.
    expect(condIncomplete({ kind: "agent-idle-over", minutes: 0 })).toBeUndefined();
  });

  it("names a blank status", () => {
    expect(condIncomplete({ kind: "ticket-status-is", status: "" })).toBe("no status set");
    expect(condIncomplete({ kind: "ticket-status-is", status: "   " })).toBe("no status set");
    expect(condIncomplete({ kind: "ticket-status-is", status: "In Review" })).toBeUndefined();
  });

  it("names the repo before the branch, so one fix is asked for at a time", () => {
    // Both blank is the shape a rule seeded from a source with no repo to lend
    // arrives in. Reporting both at once would put two complaints on one field
    // row; reporting the repo first matches the order the controls sit in.
    expect(condIncomplete({ kind: "branch-ci-passed", repo: "", branch: "" })).toBe("no repo set");
    expect(condIncomplete({ kind: "branch-ci-passed", repo: "api", branch: "" })).toBe("no branch set");
    expect(condIncomplete({ kind: "branch-ci-passed", repo: "api", branch: "main" })).toBeUndefined();
  });

  it("survives a hand-edited flow file that omits the parameter entirely", () => {
    // `store.ts`'s `validEdge` admits an edge on the strength of its `kind`
    // without reading the parameters beside it, so `{"kind":"ticket-status-is"}`
    // reaches here with no `status` at all. A bare `.trim()` throws — and it
    // throws inside `unfirableRules`, which runs while ARMING, so one
    // hand-edited rule would take the whole arm down instead of being reported
    // as the one rule that cannot fire.
    expect(condIncomplete({ kind: "ticket-status-is" } as never)).toBe("no status set");
    expect(condIncomplete({ kind: "branch-ci-passed" } as never)).toBe("no repo set");
    expect(condIncomplete({ kind: "branch-ci-passed", repo: "api" } as never)).toBe("no branch set");
  });
});

describe("a gate node", () => {
  const gate = (id: string): GateNode =>
    ({ id, kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" });

  it("implies the ask verb", () => {
    expect(actionFor("gate")).toBe("ask");
  });

  it("does not spend, so it never competes for a launch slot", () => {
    expect(isSpendAction("ask")).toBe(false);
  });

  it("still admits the three verbs that do spend", () => {
    expect(isSpendAction("launch")).toBe(true);
    expect(isSpendAction("seed")).toBe(true);
    expect(isSpendAction("run")).toBe(true);
  });

  it("derives ask for an edge pointing at one", () => {
    const flow: Flow = { ...emptyFlow("f1", "f", 0), nodes: [gate("g")],
      edges: [{ id: "e1", from: "a", to: "g", cond: { kind: "pr-merged" } }] };
    expect(edgeAction(flow, flow.edges[0])).toBe("ask");
  });

  it("is recognised by isGate and by nothing else", () => {
    expect(isGate(gate("g"))).toBe(true);
    expect(isGate({ id: "n", kind: "notify", x: 0, y: 0, join: "any", message: "m" })).toBe(false);
  });
});

describe("stripHostStamps", () => {
  const stamped: FlowEdge = {
    id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" },
    action: "run", mode: "plan", note: "my own words",
    firedAt: 1756200000000, firedNote: "ran · exit 0", performed: true,
    gateAnswer: "approved", error: "exit 1",
  };

  it("drops every host-owned stamp", () => {
    const out = stripHostStamps(stamped);
    expect(out.firedAt).toBeUndefined();
    expect(out.firedNote).toBeUndefined();
    expect(out.performed).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(out.action).toBeUndefined();
    expect(out.gateAnswer).toBeUndefined();
  });

  it("preserves the user's own configuration", () => {
    // An allow-list implementation of this strip once silently dropped `note`
    // on every Reset. `mode` has nowhere else to live for a seed.
    const out = stripHostStamps(stamped);
    expect(out.note).toBe("my own words");
    expect(out.mode).toBe("plan");
    expect(out.cond).toEqual({ kind: "pr-merged" });
    expect(out.id).toBe("e1");
    expect(out.from).toBe("n1");
    expect(out.to).toBe("n2");
  });

  it("does not mutate its argument", () => {
    stripHostStamps(stamped);
    expect(stamped.firedAt).toBe(1756200000000);
  });
});

describe("id minting", () => {
  const flow = (nodeIds: string[], edgeIds: string[]): Flow => ({
    id: "f1", name: "Ship it", armed: false, createdAt: 0,
    nodes: nodeIds.map((id) => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" })),
    edges: edgeIds.map((id) => ({ id, from: "n1", to: "n2", cond: { kind: "pr-merged" } })),
  });

  it("mints the first free node id, not length + 1", () => {
    // A flow whose n2 was deleted has n1 and n3; length + 1 would mint n3 again.
    expect(nextNodeId(flow(["n1", "n3"], []))).toBe("n2");
  });

  it("mints the first free edge id", () => {
    expect(nextEdgeId(flow([], ["e1", "e2"]))).toBe("e3");
  });

  it("mints n1 and e1 for an empty flow", () => {
    expect(nextNodeId(flow([], []))).toBe("n1");
    expect(nextEdgeId(flow([], []))).toBe("e1");
  });
});

// The one definition of "which edge asked this gate", extracted after a surface
// that answered the WRONG edge shipped as a silent no-op: the card drawer's
// Approve sent the edge LEAVING the gate, `flow:answerGate` accepts only the
// performer, so the write was refused and the question stayed open. Three
// hand-rolled copies of this predicate existed; these tests guard the survivor.
describe("gateAskEdge", () => {
  const gateAt = (edges: FlowEdge[]): Flow => ({
    id: "f1", name: "Ship it", armed: true, createdAt: 0,
    nodes: [
      place("n1"),
      { id: "g1", kind: "gate", x: 0, y: 0, join: "any", question: "Deploy to prod?" } as GateNode,
      { id: "n2", kind: "notify", x: 0, y: 0, join: "any", message: "" } as NotifyNode,
    ],
    edges,
  });
  const ask = (over: Partial<FlowEdge> = {}): FlowEdge =>
    ({ id: "e-ask", from: "n1", to: "g1", cond: { kind: "pr-merged" }, performed: true, firedAt: 1, ...over });
  const outgoing: FlowEdge = { id: "e-you", from: "g1", to: "n2", cond: { kind: "gate-approved" } };

  it("finds the incoming edge that performed the ask", () => {
    expect(gateAskEdge(gateAt([ask(), outgoing]), "g1")?.id).toBe("e-ask");
  });

  it("never answers with the edge leaving the gate — the whole point", () => {
    // The outgoing edge is what a "you" step carries, and answering it is a
    // silent no-op. Asserted as its own case so a rewrite that "simplified" this
    // to any adjacent edge fails here.
    expect(gateAskEdge(gateAt([ask(), outgoing]), "g1")?.id).not.toBe("e-you");
  });

  it("is undefined while the question is unasked", () => {
    expect(gateAskEdge(gateAt([ask({ performed: undefined, firedAt: undefined }), outgoing]), "g1")).toBeUndefined();
  });

  it("ignores an incoming edge that fired without performing", () => {
    // `performed`, never `firedAt` alone: an errored sibling carries a `firedAt`
    // and posed nothing, and stopping at it would read the answer off an edge
    // that never asked.
    expect(gateAskEdge(gateAt([ask({ performed: undefined }), outgoing]), "g1")).toBeUndefined();
  });

  it("carries the answer already stamped on the ask edge", () => {
    expect(gateAskEdge(gateAt([ask({ gateAnswer: "approved" }), outgoing]), "g1")?.gateAnswer).toBe("approved");
  });

  it("is undefined for a node that is not a gate, and for one that does not exist", () => {
    expect(gateAskEdge(gateAt([ask(), outgoing]), "n1")).toBeUndefined();
    expect(gateAskEdge(gateAt([ask(), outgoing]), "nope")).toBeUndefined();
  });
});

describe("a deadline on an edge", () => {
  it("isSettled is true for an edge that expired — the third terminal stamp", () => {
    // Neither `firedAt` nor `error`: an expired rule ran nothing and failed at
    // nothing, and it must still never be evaluated again until Reset.
    expect(isSettled(edge("e1", "a", "z", { expiredAt: 1 }))).toBe(true);
  });

  it("stripHostStamps drops the clock and the expiry, and keeps the deadline itself", () => {
    const out = stripHostStamps(edge("e1", "a", "z", { timeoutMinutes: 45, liveSince: 5, expiredAt: 9 }));
    expect(out.liveSince).toBeUndefined();
    expect(out.expiredAt).toBeUndefined();
    // The deadline is the user's configuration — what the rule IS — like `note`.
    expect(out.timeoutMinutes).toBe(45);
  });

  it("hasDeadline is true only for a positive finite minute count", () => {
    expect(hasDeadline(edge("e1", "a", "z"))).toBe(false);
    expect(hasDeadline(edge("e1", "a", "z", { timeoutMinutes: 0 }))).toBe(false);
    expect(hasDeadline(edge("e1", "a", "z", { timeoutMinutes: -3 }))).toBe(false);
    expect(hasDeadline(edge("e1", "a", "z", { timeoutMinutes: Number.NaN }))).toBe(false);
    // A hand-edited file can carry anything.
    expect(hasDeadline(edge("e1", "a", "z", { timeoutMinutes: "10" as unknown as number }))).toBe(false);
    expect(hasDeadline(edge("e1", "a", "z", { timeoutMinutes: 10 }))).toBe(true);
  });

  it("deadlineAt is the moment the clock runs out, once it is running", () => {
    expect(deadlineAt(edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: 1_000 }))).toBe(1_000 + 10 * 60_000);
    // No clock yet, or no deadline — no moment.
    expect(deadlineAt(edge("e1", "a", "z", { timeoutMinutes: 10 }))).toBeUndefined();
    expect(deadlineAt(edge("e1", "a", "z", { liveSince: 1_000 }))).toBeUndefined();
  });
});

describe("command-printed", () => {
  it("outputContains is a case-insensitive substring match, and blank text matches nothing", () => {
    expect(outputContains("Deploy finished: DEPLOYED to prod\n", "deployed")).toBe(true);
    expect(outputContains("rollback initiated", "ROLLBACK")).toBe(true);
    expect(outputContains("all green", "red")).toBe(false);
    expect(outputContains("anything at all", "")).toBe(false);
    expect(outputContains("anything at all", "   ")).toBe(false);
    // A literal asterisk, not a glob.
    expect(outputContains("3 * 4", "*")).toBe(true);
    expect(outputContains("34", "*")).toBe(false);
  });

  it("condIncomplete reports blank text, in the same voice as a blank status", () => {
    expect(condIncomplete({ kind: "command-printed", text: "" })).toBe("no text set");
    expect(condIncomplete({ kind: "command-printed", text: "ok" })).toBeUndefined();
    expect(condIncomplete({ kind: "command-printed" } as unknown as Condition)).toBe("no text set");
  });
});

describe("opt-in retry", () => {
  const failed = (over: Partial<FlowEdge> = {}) => edge("e1", "a", "z", { error: "boom", ...over });

  it("an errored edge with a retryAt is pending retry, not settled; without one it is settled as always", () => {
    expect(isSettled(failed())).toBe(true);
    expect(retryPending(failed())).toBe(false);
    expect(isSettled(failed({ retryAt: 5 }))).toBe(false);
    expect(retryPending(failed({ retryAt: 5 }))).toBe(true);
    // A retryAt with no error is a hand-edited oddity, not a pending retry.
    expect(retryPending(edge("e1", "a", "z", { retryAt: 5 }))).toBe(false);
  });

  it("retryPolicy honours a well-formed policy on a launch or a seed, and refuses the rest", () => {
    const e = edge("e1", "a", "z", { retry: { max: 3, backoffMs: 60_000 } });
    expect(retryPolicy(e, "launch")).toEqual({ max: 3, backoffMs: 60_000 });
    expect(retryPolicy(e, "seed")).toEqual({ max: 3, backoffMs: 60_000 });
    expect(retryPolicy(e, "notify")).toBeUndefined();
    expect(retryPolicy(e, "ask")).toBeUndefined();
    expect(retryPolicy(e, undefined)).toBeUndefined();
    expect(retryPolicy(edge("e1", "a", "z"), "launch")).toBeUndefined();
    expect(retryPolicy(edge("e1", "a", "z", { retry: { max: 0, backoffMs: 1 } }), "launch")).toBeUndefined();
    expect(retryPolicy(edge("e1", "a", "z", { retry: { max: 2.5, backoffMs: 1 } }), "launch")).toBeUndefined();
    expect(retryPolicy(edge("e1", "a", "z", { retry: { max: 2, backoffMs: -1 } }), "launch")).toBeUndefined();
    expect(retryPolicy(edge("e1", "a", "z", { retry: "3" as unknown as { max: number; backoffMs: number } }), "launch")).toBeUndefined();
  });

  it("retryPolicy refuses a run without the explicit safe-to-re-run tick, and honours it with", () => {
    const e = edge("e1", "a", "z", { retry: { max: 2, backoffMs: 0 } });
    expect(retryPolicy(e, "run")).toBeUndefined();
    expect(retryPolicy({ ...e, retryOk: true }, "run")).toEqual({ max: 2, backoffMs: 0 });
  });

  it("stripHostStamps drops attempts and retryAt, and keeps the policy and the tick", () => {
    const out = stripHostStamps(edge("e1", "a", "z", { retry: { max: 2, backoffMs: 1 }, retryOk: true, attempts: 2, retryAt: 9, error: "x" }));
    expect(out.attempts).toBeUndefined();
    expect(out.retryAt).toBeUndefined();
    expect(out.retry).toEqual({ max: 2, backoffMs: 1 });
    expect(out.retryOk).toBe(true);
  });
});

describe("a flow's spend ceiling", () => {
  const f = (spendCeiling?: number): Flow => ({ ...emptyFlow("f1", "f", 0), ...(spendCeiling === undefined ? {} : { spendCeiling }) });

  it("hasCeiling is true only for a positive finite number — a hand-edited file can carry anything", () => {
    expect(hasCeiling(f())).toBe(false);
    expect(hasCeiling(f(0))).toBe(false);
    expect(hasCeiling(f(-1))).toBe(false);
    expect(hasCeiling({ ...f(), spendCeiling: "5" as unknown as number })).toBe(false);
    expect(hasCeiling(f(5))).toBe(true);
  });

  it("overCeiling asks whether THIS pass's spends would take the lifetime total past the ceiling", () => {
    const tally = { sessions: 3, commands: 1 };
    expect(overCeiling(f(5), tally, 1)).toBe(false); // 4 + 1 = 5, at the ceiling is allowed
    expect(overCeiling(f(5), tally, 2)).toBe(true); // 4 + 2 = 6
    expect(overCeiling(f(), tally, 99)).toBe(false); // no ceiling, nothing to exceed
    expect(overCeiling(f(5), { sessions: 0, commands: 0 }, 0)).toBe(false);
  });

  it("spendTotal adds sessions and commands — one ceiling covers both kinds of spend", () => {
    expect(spendTotal({ sessions: 3, commands: 2 })).toBe(5);
  });
});

describe("a flow's token ceiling", () => {
  const f = (tokenCeiling?: number): Flow => ({ ...emptyFlow("f1", "f", 0), ...(tokenCeiling === undefined ? {} : { tokenCeiling }) });

  it("hasTokenCeiling is true only for a positive finite number, like hasCeiling", () => {
    expect(hasTokenCeiling(f())).toBe(false);
    expect(hasTokenCeiling(f(0))).toBe(false);
    expect(hasTokenCeiling(f(Number.POSITIVE_INFINITY))).toBe(false);
    expect(hasTokenCeiling({ ...f(), tokenCeiling: "1M" as unknown as number })).toBe(false);
    expect(hasTokenCeiling(f(1_000_000))).toBe(true);
  });

  it("atTokenCeiling is reached AT the ceiling, never by an unmeasured tally, and never without a ceiling", () => {
    expect(atTokenCeiling(f(1_000), { sessions: 0, commands: 0, eq: 999 })).toBe(false);
    expect(atTokenCeiling(f(1_000), { sessions: 0, commands: 0, eq: 1_000 })).toBe(true);
    expect(atTokenCeiling(f(1_000), { sessions: 0, commands: 0, eq: 5_000 })).toBe(true);
    // Not measured is not zero: an unreadable transcript is no evidence either way.
    expect(atTokenCeiling(f(1_000), { sessions: 9, commands: 9 })).toBe(false);
    expect(atTokenCeiling(f(), { sessions: 0, commands: 0, eq: 5_000 })).toBe(false);
  });

  it("flowRunKeys names each place's run once, in node order, and skips planned work", () => {
    const flow: Flow = {
      ...emptyFlow("f1", "f", 0),
      nodes: [
        { id: "a", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r1" },
        { id: "b", kind: "planned", x: 0, y: 0, join: "any", ticketKey: "PROJ-2", repos: ["r1"], mode: "plan", dest: "worktree" },
        { id: "c", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r2" },
        { id: "d", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-3", repo: "r1" },
      ],
    };
    expect(flowRunKeys(flow)).toEqual(["PROJ-1", "PROJ-3"]);
    expect(flowRunKeys(emptyFlow("f2", "f", 0))).toEqual([]);
  });
});

describe("a subflow node", () => {
  const sub = (id: string, over: Partial<SubflowNode> = {}): SubflowNode =>
    ({ id, kind: "subflow", x: 0, y: 0, join: "any", templateId: "t-ship", ...over });
  const withNodes = (nodes: FlowNode[], edges: FlowEdge[] = [], over: Partial<Flow> = {}): Flow =>
    ({ ...emptyFlow("f1", "f", 0), nodes, edges, ...over });

  it("derives the spawn verb, which the host performs but nothing spends", () => {
    expect(actionFor("subflow")).toBe("spawn");
    expect(isSpendAction("spawn")).toBe(false);
    expect(isPerformedAction("spawn")).toBe(true);
    expect(isPerformedAction("launch")).toBe(true);
    expect(isPerformedAction("notify")).toBe(false);
    expect(isPerformedAction("ask")).toBe(false);
    expect(isSubflow(sub("s"))).toBe(true);
    expect(isSubflow(place("p"))).toBe(false);
  });

  it("subflowDone reads the CHILD's settledness off the flows it is handed", () => {
    const parent = withNodes([place("p"), sub("s", { childFlowId: "c1" })]);
    const running: Flow = { ...emptyFlow("c1", "child", 0), edges: [edge("e1", "a", "b")] };
    const done: Flow = { ...running, edges: [edge("e1", "a", "b", { firedAt: 1 })] };
    const stopped: Flow = { ...running, edges: [edge("e1", "a", "b", { error: "boom" })] };
    expect(subflowDone(parent, "s", [running])).toBe(false);
    expect(subflowDone(parent, "s", [done])).toBe(true);
    // Settled by error counts: the child has nothing left to do, whatever its outcome.
    expect(subflowDone(parent, "s", [stopped])).toBe(true);
    // No child yet, a missing child, an empty child, a non-subflow node: not done.
    expect(subflowDone(withNodes([sub("s")]), "s", [done])).toBe(false);
    expect(subflowDone(parent, "s", [])).toBe(false);
    expect(subflowDone(parent, "s", [{ ...done, edges: [] }])).toBe(false);
    expect(subflowDone(parent, "p", [done])).toBe(false);
  });

  it("bindSubflow records the child on that node alone, and only on a subflow node", () => {
    const f = withNodes([place("p"), sub("s")]);
    const out = bindSubflow(f, "s", "c9");
    expect((out.nodes[1] as SubflowNode).childFlowId).toBe("c9");
    expect(out.nodes[0]).toEqual(f.nodes[0]);
    expect(bindSubflow(f, "p", "c9")).toEqual(f);
  });

  it("subflowDepth counts ancestors and stops at a cycle or a missing parent", () => {
    const top: Flow = emptyFlow("a", "a", 0);
    const mid: Flow = { ...emptyFlow("b", "b", 0), parentFlow: "a" };
    const leaf: Flow = { ...emptyFlow("c", "c", 0), parentFlow: "b" };
    const all = [top, mid, leaf];
    expect(subflowDepth(top, all)).toBe(0);
    expect(subflowDepth(mid, all)).toBe(1);
    expect(subflowDepth(leaf, all)).toBe(2);
    expect(subflowDepth(leaf, [leaf])).toBe(0);
    const loopA: Flow = { ...emptyFlow("x", "x", 0), parentFlow: "y" };
    const loopB: Flow = { ...emptyFlow("y", "y", 0), parentFlow: "x" };
    expect(subflowDepth(loopA, [loopA, loopB])).toBe(1);
    expect(MAX_SUBFLOW_DEPTH).toBe(3);
  });
});
