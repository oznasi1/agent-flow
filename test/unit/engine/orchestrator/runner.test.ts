import { describe, it, expect } from "vitest";
import { applyFired, notifyLines } from "../../../../src/engine/orchestrator/runner";
import { Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, emptyFlow } from "../../../../src/engine/orchestrator/model";
import { FiredEdge } from "../../../../src/engine/orchestrator/evaluate";

const NOW = 1_800_000_000_000;

const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const notify = (id: string, message: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message });
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ ...emptyFlow("f1", "Ship the migration", 0), armed: true, nodes, edges });

describe("applyFired", () => {
  it("stamps firedAt and a note on a performed edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[0].firedAt).toBe(NOW);
    expect(out.edges[0].firedNote).toBeTruthy();
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const before = JSON.stringify(flow);
    applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("stamps a perform:false edge too — an unstamped junction sibling re-evaluates forever", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), place("b", "ASM-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true }, { edge: flow.edges[1], perform: false }],
      NOW,
    );
    expect(out.edges.map((e) => e.firedAt)).toEqual([NOW, NOW]);
  });

  it("distinguishes a performed note from a stamped-only one", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), place("b", "ASM-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true }, { edge: flow.edges[1], perform: false }],
      NOW,
    );
    expect(out.edges[0].firedNote).not.toBe(out.edges[1].firedNote);
    // The stamped-only one must not claim it did something.
    expect(out.edges[1].firedNote).toMatch(/junction|closed|with/i);
  });

  it("leaves an edge that did not fire completely alone", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("y", "one"), notify("z", "two")], [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[1].firedAt).toBeUndefined();
    expect(out.edges[1].firedNote).toBeUndefined();
  });

  it("keeps every other field of the flow and of each edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z", { cond: { kind: "ci-failed" } })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.name).toBe("Ship the migration");
    expect(out.armed).toBe(true);
    expect(out.edges[0].cond).toEqual({ kind: "ci-failed" });
    expect(out.nodes).toEqual(flow.nodes);
  });

  it("returns an equal flow when nothing fired", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    expect(applyFired(flow, [], NOW)).toEqual(flow);
  });

  it("ignores a fired edge whose id is not in the flow", () => {
    // Defensive: the runner is handed edges by the evaluator, but a stale
    // EvalResult must not be able to invent an edge.
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: edge("ghost", "a", "z"), perform: true }], NOW);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].firedAt).toBeUndefined();
  });

  it("records an ERROR, not a firedAt, on a performed edge whose action is not notify", () => {
    // evaluateFlow does not filter by action, so a launch edge from a hand-edited
    // flow can fire. It must not be stamped as fired: `firedAt` consumes the latch
    // AS A SUCCESS, so the edge never acts and — once a real launch ships — looks
    // already-done forever and needs a manual Reset to ever run. `error` is settled
    // too (see isSettled), so it still cannot re-fire in a loop, but the drawer
    // surfaces it and offers Reset, and a Reset makes it genuinely run later.
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b", { action: "launch" })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[0].error).toContain("not available in this build");
    // The latch must NOT read as a success.
    expect(out.edges[0].firedAt).toBeUndefined();
    expect(out.edges[0].firedNote).toBeUndefined();
  });

  it("names the action it could not perform, and never claims it ran", () => {
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b", { action: "seed" })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true }], NOW);
    expect(out.edges[0].error).toBe("seed is not available in this build");
    expect(out.edges[0].error).not.toMatch(/success|ran|done|told you/i);
  });

  it("stamps a NON-performed non-notify edge as fired, not errored — it did nothing, and its junction closed", () => {
    // The distinction the error must not swallow: a perform:false sibling never
    // attempted its action, so there is nothing to have failed. Recording an error
    // for it would stall the junction it just legitimately closed.
    const flow = flowWith(
      [place("a", "ASM-1"), place("b", "ASM-2"), place("c", "ASM-3", "all")],
      [edge("e1", "a", "c"), edge("e2", "b", "c", { action: "launch" })],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true }, { edge: flow.edges[1], perform: false }],
      NOW,
    );
    expect(out.edges[1].error).toBeUndefined();
    expect(out.edges[1].firedAt).toBe(NOW);
    expect(out.edges[1].firedNote).toBe("closed with its junction");
  });
});

describe("notifyLines", () => {
  it("names the flow and the notify node's own message", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
    expect(lines[0]).toContain("the migration has landed");
  });

  it("says nothing for a stamped-only edge — it performed nothing", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "done", "all")], [edge("e1", "a", "z")]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: false }])).toEqual([]);
  });

  it("says nothing for an action that is not notify", () => {
    // launch and seed do not exist in this phase; if one appears in a
    // hand-edited flow it must not produce a toast claiming it ran.
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b", { action: "launch" })]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: true }])).toEqual([]);
  });

  it("falls back gracefully when the target is not a notify node", () => {
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2")], [edge("e1", "a", "b")]);
    // action is notify but the target is a place — a hand-edited flow. One line,
    // no crash, and no invented message.
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
  });

  it("returns one line per performed notify edge", () => {
    const flow = flowWith(
      [place("a", "ASM-1"), notify("y", "first"), notify("z", "second")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")],
    );
    const lines = notifyLines(flow, [
      { edge: flow.edges[0], perform: true },
      { edge: flow.edges[1], perform: true },
    ]);
    expect(lines).toHaveLength(2);
  });
});
