import { describe, it, expect } from "vitest";
import {
  emptyFlow, isPlace, isPlanned, isNotify, isSettled, findNode, incomingEdges,
  Flow, FlowEdge, FlowNode, PlaceNode, PlannedNode, NotifyNode,
} from "../../../../src/engine/orchestrator/model";

const place = (id: string, over: Partial<PlaceNode> = {}): PlaceNode => ({
  id, kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "agent-flow", ...over,
});
const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 0, y: 0, join: "any",
  ticketKey: "ASM-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
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
});

describe("node guards", () => {
  it("identifies each kind and rejects the others", () => {
    const p = place("n1"), pl = planned("n2"), nt = notify("n3");
    expect([isPlace(p), isPlanned(p), isNotify(p)]).toEqual([true, false, false]);
    expect([isPlace(pl), isPlanned(pl), isNotify(pl)]).toEqual([false, true, false]);
    expect([isPlace(nt), isPlanned(nt), isNotify(nt)]).toEqual([false, false, true]);
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
    expect(isSettled(edge("e1", "a", "z", { error: "launch is not available in this build" }))).toBe(true);
  });

  it("is true when both are set", () => {
    expect(isSettled(edge("e1", "a", "z", { firedAt: 1, error: "boom" }))).toBe(true);
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
