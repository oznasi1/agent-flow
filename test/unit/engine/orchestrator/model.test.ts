import { describe, it, expect } from "vitest";
import {
  emptyFlow, isPlace, isPlanned, isNotify, isCommand, isGate, isSettled, isSpendAction, findNode, gateAskEdge,
  incomingEdges, actionFor, edgeAction, condIncomplete, stripHostStamps, nextNodeId, nextEdgeId, hasDeadline, deadlineAt, outputContains, Condition,
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
