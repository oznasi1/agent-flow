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
  const boxAt = (x: number, y: number): Box => ({ x, y, w: NODE_W, h: NODE_H });
  const inside = (p: { x: number; y: number }, b: Box) =>
    p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

  it("is the midpoint of the two anchors", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual({ x: 50, y: 25 });
  });

  it("is the chord midpoint when nothing is in the way", () => {
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 40 })).toEqual({ x: 50, y: 20 });
  });

  it("is the chord midpoint when no obstacles are given at all", () => {
    // The argument is optional so existing callers keep working unchanged.
    expect(labelPoint({ x: 0, y: 0 }, { x: 200, y: 0 }, [])).toEqual({ x: 100, y: 0 });
  });

  it("steps off a node that sits on the midpoint", () => {
    // A long edge passing a same-row node: the midpoint lands inside it.
    const blocker = boxAt(60, -22); // straddles y=0, centred near x=144
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(inside(p, blocker)).toBe(false);
  });

  it("stays as close to its own line as clearing allows", () => {
    // Nudged, not relocated: the whole point is the label still reads as
    // belonging to this edge. One node's height is the ceiling on the detour.
    const blocker = boxAt(60, -22);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(NODE_H + 16);
    expect(p.x).toBe(144); // unchanged along the chord
  });

  it("clears every obstacle, not just the first", () => {
    // `b` sits exactly where escaping `a` upward would land, so an implementation
    // that stopped at the first box it cleared would come to rest inside the
    // second. That is the whole property under test: the escape has to be clear
    // of ALL of them, not merely of the one that pushed it.
    const a = boxAt(60, -22);
    const b = boxAt(60, 22);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [a, b]);
    expect(inside(p, a)).toBe(false);
    expect(inside(p, b)).toBe(false);
  });

  it("ignores obstacles the midpoint was never on", () => {
    const far = boxAt(1000, 1000);
    expect(labelPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, [far])).toEqual({ x: 50, y: 0 });
  });

  it("terminates on a pathological pile of obstacles rather than looping", () => {
    // A render path must not hang. Boxed in on purpose: it returns SOMETHING,
    // promptly. `tidy` in this file is bounded for the same reason.
    const wall = Array.from({ length: 40 }, (_, i) => boxAt(60, -22 - i * 8));
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, wall);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it("offsets perpendicular to a diagonal chord, not merely vertically", () => {
    // The normal of a sloped edge is sloped: a vertical-only nudge would drift
    // off the line and orphan the label, which is the defect being fixed.
    const p = labelPoint({ x: 0, y: 0 }, { x: 200, y: 200 }, [boxAt(16, 78)]);
    expect(p.x).not.toBe(100);
  });

  it("returns from negative direction when it clears first", () => {
    // Obstacle positioned so that stepping in negative direction clears before positive.
    // For a horizontal chord, we try: positive then negative at each distance.
    // With blocker at y=-10, effective range is y in [-18, 42].
    // Negative direction: -8, -16, -24 (escapes at -24 < -18)
    // Positive direction: 8, 16, 24, 32, 40, 48 (escapes at 48 > 42)
    // So negative escapes first.
    const blocker = boxAt(60, -10);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(inside(p, blocker)).toBe(false);
    expect(p.y).toBeLessThan(0);
  });

  it("returns after hitting the step limit rather than hanging", () => {
    // Create obstacles dense enough that we might exceed the step limit.
    // With step size 8 and 24 boxes at 8-pixel spacing, we have 192 pixels of obstacles.
    // After maxSteps iterations, we return what we have even if still colliding.
    const wall = Array.from({ length: 24 }, (_, i) => boxAt(60, -22 - i * 8));
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, wall);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    // Should have stepped significantly to avoid at least one obstacle
    expect(Math.abs(p.y)).toBeGreaterThan(0);
  });

  it("clears the box for where the label is PAINTED, not for its anchor", () => {
    // The defect: `labelPoint` stepped the ANCHOR 8px clear of a box while
    // `.orch-edge` painted the chip ~19px above that anchor, so every DOWNWARD
    // escape deterministically re-entered the box it had just escaped — over a
    // node's only status word. `paintDy` is the vertical distance to the painted
    // chip's own centre.
    const paintDy = -19;
    // Mostly ABOVE the chord, so escaping DOWNWARD is the nearest way out — which
    // is the direction the paint offset then undoes.
    const blocker = boxAt(60, -50);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker], paintDy);
    // What the user sees is clear of the node.
    expect(inside({ x: p.x, y: p.y + paintDy }, blocker)).toBe(false);
    // And the fixture is not vacuous: the SAME escape, judged at the anchor, is
    // one this box would have admitted — which is exactly what used to be painted
    // back inside it.
    const anchorOnly = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker]);
    expect(inside({ x: anchorOnly.x, y: anchorOnly.y + paintDy }, blocker)).toBe(true);
  });

  it("keeps the label on its own line while clearing the painted box", () => {
    // The detour is still perpendicular and still bounded — `paintDy` changes
    // WHERE the collision is judged, never how far the label may wander.
    const blocker = boxAt(60, -22);
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, [blocker], -19);
    expect(p.x).toBe(144); // unchanged along the chord
    expect(Math.abs(p.y)).toBeLessThanOrEqual(NODE_H + 16 + 19);
  });

  it("handles a zero-length chord gracefully", () => {
    // Degenerate case: both points are the same, so the chord has no direction.
    // The function should return the midpoint (which is the same point).
    const p = labelPoint({ x: 100, y: 50 }, { x: 100, y: 50 }, [boxAt(50, 0)]);
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it("bounds stepping and returns a finite point even if trapped", () => {
    // Create a wall so dense that stepping alone can't escape within maxSteps.
    // With step size 8 and maxSteps=16, we can reach ±128 pixels.
    // A wall spanning from y=-140 to y=+152 (boxes spaced 8 pixels apart, 32 boxes)
    // ensures that even the maximum step can't escape.
    const wall = Array.from({ length: 32 }, (_, i) => boxAt(20, -140 + i * 8));
    const p = labelPoint({ x: 0, y: 0 }, { x: 288, y: 0 }, wall);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
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
