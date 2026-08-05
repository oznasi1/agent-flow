import { describe, it, expect } from "vitest";
import {
  anchor, edgePath, labelPoint, snap, tidy, NODE_W, NODE_H, COL_GAP, ROW_GAP, GRID, Box,
} from "../../../../src/engine/orchestrator/layout";
import { Flow, FlowEdge, FlowNode, emptyFlow, isPlanned } from "../../../../src/engine/orchestrator/model";

const box = (x: number, y: number, w = NODE_W, h = NODE_H): Box => ({ x, y, w, h });

const node = (id: string, x = 0, y = 0): FlowNode =>
  ({ id, kind: "place", x, y, join: "any", runKey: id, repo: "r" });
const edge = (id: string, from: string, to: string): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify" });
const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ ...emptyFlow("f1", "f", 0), nodes, edges });

describe("anchor", () => {
  it("puts the out port on the right edge, vertically centred", () => {
    expect(anchor(box(10, 20), "out")).toEqual({ x: 10 + NODE_W, y: 20 + NODE_H / 2 });
  });

  it("puts the in port on the left edge, vertically centred", () => {
    expect(anchor(box(10, 20), "in")).toEqual({ x: 10, y: 20 + NODE_H / 2 });
  });

  it("uses the box's own height, not the constant", () => {
    expect(anchor(box(0, 0, NODE_W, 100), "in").y).toBe(50);
  });
});

describe("edgePath", () => {
  it("is a cubic bezier from a to b with horizontal control points", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 100 })).toBe("M0,0 C100,0 100,100 200,100");
  });

  it("keeps a minimum horizontal reach so a short hop still curves", () => {
    // dx would be 10; the floor keeps the curve readable instead of a kink.
    expect(edgePath({ x: 0, y: 0 }, { x: 20, y: 60 })).toBe("M0,0 C28,0 -8,60 20,60");
  });

  it("handles a backwards edge by swinging its control points outward", () => {
    expect(edgePath({ x: 300, y: 0 }, { x: 0, y: 0 })).toBe("M300,0 C450,0 -150,0 0,0");
  });
});

describe("labelPoint", () => {
  it("is the midpoint of the two anchors", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });
});

describe("snap", () => {
  it("rounds to the grid and never goes negative", () => {
    expect(snap(11)).toBe(8);
    expect(snap(13)).toBe(16);
    expect(snap(-40)).toBe(0);
    expect(snap(GRID * 3)).toBe(GRID * 3);
  });
});

describe("tidy", () => {
  it("puts a root in the first column", () => {
    const [n] = tidy(flowWith([node("a", 999, 999)], []));
    expect(n).toMatchObject({ id: "a", x: GRID * 3, y: GRID * 3 });
  });

  it("puts a target one column right of its source", () => {
    const out = tidy(flowWith([node("a"), node("b")], [edge("e1", "a", "b")]));
    const [a, b] = out;
    expect(b.x - a.x).toBe(COL_GAP);
    expect(b.y).toBe(a.y);
  });

  it("stacks siblings in the same column", () => {
    const out = tidy(flowWith([node("a"), node("b"), node("c")],
      [edge("e1", "a", "b"), edge("e2", "a", "c")]));
    const b = out.find((n) => n.id === "b")!;
    const c = out.find((n) => n.id === "c")!;
    expect(b.x).toBe(c.x);
    expect(c.y - b.y).toBe(ROW_GAP);
  });

  it("uses the longest path, so a node behind two hops lands in column three", () => {
    const out = tidy(flowWith([node("a"), node("b"), node("z")],
      [edge("e1", "a", "b"), edge("e2", "b", "z"), edge("e3", "a", "z")]));
    const a = out.find((n) => n.id === "a")!;
    const z = out.find((n) => n.id === "z")!;
    expect(z.x - a.x).toBe(COL_GAP * 2);
  });

  it("terminates on a cycle and still assigns finite coordinates", () => {
    const out = tidy(flowWith([node("a"), node("b")], [edge("e1", "a", "b"), edge("e2", "b", "a")]));
    expect(out).toHaveLength(2);
    for (const n of out) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("returns new node objects and leaves the flow untouched", () => {
    const flow = flowWith([node("a", 999, 999)], []);
    const out = tidy(flow);
    expect(flow.nodes[0]).toMatchObject({ x: 999, y: 999 });
    expect(out[0]).not.toBe(flow.nodes[0]);
  });

  it("preserves every non-positional field", () => {
    const flow = flowWith([node("a", 5, 5)], []);
    expect(tidy(flow)[0]).toMatchObject({ id: "a", kind: "place", join: "any", runKey: "a", repo: "r" });
  });

  it("does not share mutable substructure (repos array) with the original", () => {
    const plannedNode: FlowNode = {
      id: "p",
      kind: "planned",
      x: 0,
      y: 0,
      join: "any",
      ticketKey: "PROJ-1",
      repos: ["repo1", "repo2"],
      mode: "default",
      dest: "worktree",
    };
    const flow = flowWith([plannedNode], []);
    const out = tidy(flow);
    expect(out[0]).not.toBe(flow.nodes[0]);
    // Verify repos array is not shared
    if (isPlanned(out[0]) && isPlanned(flow.nodes[0])) {
      expect(out[0].repos).not.toBe(flow.nodes[0].repos);
      // Mutate the tidied repos and verify the original is unchanged
      out[0].repos.push("repo3");
      expect(flow.nodes[0].repos).toEqual(["repo1", "repo2"]);
    }
  });

  it("is empty for an empty flow", () => {
    expect(tidy(flowWith([], []))).toEqual([]);
  });

  it("ignores an edge referencing a node not in the flow, and still places the real nodes finitely", () => {
    const out = tidy(flowWith([node("a"), node("b")],
      [edge("e1", "a", "b"), edge("e2", "a", "ghost"), edge("e3", "ghost", "b")]));
    expect(out).toHaveLength(2);
    for (const n of out) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
