// Canvas geometry, kept out of the component on purpose: this is where the bugs
// live, and none of it needs a DOM. The drawer's canvas imports all of it.
import { Flow, FlowNode } from "./model";

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** Wide enough for a state dot, a ticket key and the one fact the rules read.
 * Narrower and a node degenerates into a bare key. */
export const NODE_W = 168;
/** The two-line default. `anchor` reads the measured box instead wherever a real
 * element is available, so a taller node still ports from its own middle. */
export const NODE_H = 44;
/** A gate node's height. Taller than `NODE_H` because it carries a row of
 * Approve / Reject buttons under the question.
 *
 * Constant for the KIND, not for the state. An answered gate keeps this height,
 * with its verdict line occupying the row the buttons had — a height that changed
 * with the answer would make every wire into and out of the gate jump the moment
 * it was answered. `boxOf` (OrchestratorDrawer.tsx) is the one place it is applied,
 * beside the width ternary that already switches on `notify`. */
export const GATE_H = 70;
/** Column pitch. Wider than NODE_W by enough that a condition label sitting over
 * the connector does not span the whole gap. */
export const COL_GAP = 296;
export const ROW_GAP = 88;
export const GRID = 8;

export function anchor(b: Box, side: "in" | "out"): Point {
  return { x: side === "out" ? b.x + b.w : b.x, y: b.y + b.h / 2 };
}

/** A cubic bezier with horizontal control points, so every edge leaves and enters
 * its ports level. The floor on the reach keeps a short hop curved rather than
 * kinked — two nodes in adjacent columns are the common case. */
export function edgePath(a: Point, b: Point): string {
  const dx = Math.max(28, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/**
 * Position of an edge label: starts at the chord midpoint, then steps
 * perpendicular to the chord to avoid obstacles.
 *
 * Why perpendicular: the normal to a chord keeps the label visually attached
 * to its edge. A vertical-only nudge on a diagonal edge would drift off the
 * line and orphan the label from the edge it names — which is the defect
 * being fixed.
 *
 * Why bounded: `tidy` in this file bounds its relaxation by node count
 * rather than "until fixed", because a graph with cycles needs to terminate
 * instead of hanging the webview. The same reasoning applies here: a dense
 * graph can have obstacles stacked taller than expected. The loop checks
 * both directions equally at each distance, keeping the label as close to
 * the line as possible before giving up.
 *
 * `paintDy` is what makes the avoidance describe the thing the user actually
 * sees. The point returned here is an ANCHOR, and the caller's CSS may paint the
 * label somewhere else relative to it — `.orch-edge` (orchestratorStyles.ts) is
 * `translate(-50%, -150%)` over a 16px chip, so its centre lands 16px ABOVE its
 * anchor (the measured figure lives with that rule, as `ORCH_EDGE_PAINT_DY`).
 * Testing collisions at the anchor while painting the chip elsewhere made every
 * DOWNWARD escape deterministically re-enter the box it had just escaped, sitting
 * on top of a node's only status word. Pass the vertical distance from the anchor
 * to the painted chip's own centre (negative for "above") and the search clears
 * the box for the CHIP, not for the anchor; the default of 0 is for a caller that
 * paints exactly on the point it is given.
 *
 * Still a POINT, not the chip's full rect: its width depends on the text inside
 * it, which lives in the DOM this module deliberately knows nothing about. The
 * existing `margin` below is what stands in for that width, unchanged.
 */
export function labelPoint(a: Point, b: Point, obstacles?: Box[], paintDy = 0): Point {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  if (!obstacles || obstacles.length === 0) {
    return mid;
  }

  // Margin around boxes when checking for collision
  const margin = 8;

  // Where an anchor's label is actually PAINTED — the only position worth
  // testing, see `paintDy`.
  const painted = (p: Point): Point => ({ x: p.x, y: p.y + paintDy });

  // Check if an anchor's painted label is inside any obstacle (with margin inflated)
  const pointInObstacle = (anchorPoint: Point): boolean => {
    const p = painted(anchorPoint);
    for (const box of obstacles) {
      if (p.x >= box.x - margin && p.x <= box.x + box.w + margin &&
          p.y >= box.y - margin && p.y <= box.y + box.h + margin) {
        return true;
      }
    }
    return false;
  };

  // If the midpoint is clear, return it
  if (!pointInObstacle(mid)) {
    return mid;
  }

  // Calculate the normal to the chord (perpendicular direction)
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  // Avoid division by zero for zero-length chords
  if (length === 0) {
    return mid;
  }

  // Normal vector perpendicular to chord direction.
  // If chord direction is (dx, dy), perpendicular is (-dy, dx).
  const nx = -dy / length;
  const ny = dx / length;

  // Step size (matching GRID = 8 pixels)
  const stepSize = GRID;

  // Maximum steps to prevent infinite loops. Similar to tidy(), this is
  // bounded to handle pathological cases instead of hanging the webview.
  // With step size 8, 16 steps = 128 pixels, enough for several overlapping nodes.
  const maxSteps = 16;

  // Try increasingly large offsets, alternating directions.
  // This keeps the label as close to its line as possible by checking
  // both directions at each distance.
  for (let i = 1; i <= maxSteps; i++) {
    // Try positive direction
    let candidate: Point = {
      x: mid.x + nx * stepSize * i,
      y: mid.y + ny * stepSize * i
    };
    if (!pointInObstacle(candidate)) {
      return candidate;
    }

    // Try negative direction
    candidate = {
      x: mid.x - nx * stepSize * i,
      y: mid.y - ny * stepSize * i
    };
    if (!pointInObstacle(candidate)) {
      return candidate;
    }
  }

  // If still colliding after max steps, return the last candidate
  // to ensure we always return a finite point.
  return {
    x: mid.x + nx * stepSize * maxSteps,
    y: mid.y + ny * stepSize * maxSteps
  };
}

/** Snap a dragged coordinate to the grid, clamped at the canvas edge. */
export function snap(v: number): number {
  return Math.max(0, Math.round(v / GRID) * GRID);
}

/**
 * Auto-layout: depth-major columns, siblings stacked. Depth is the LONGEST path
 * to a node, so a node reachable in one hop and in two sits in column three and
 * no edge ever points backwards.
 *
 * The relaxation is bounded by the node count rather than run to a fixed point,
 * which is what makes a cycle terminate: a graph the drawer should not have let
 * you build still gets finite coordinates instead of hanging the webview.
 *
 * Returns new nodes; the flow is untouched, so the caller decides whether a tidy
 * is a saved change.
 */
export function tidy(flow: Flow): FlowNode[] {
  const depth = new Map<string, number>(flow.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < flow.nodes.length; pass++) {
    let moved = false;
    for (const e of flow.edges) {
      if (!depth.has(e.from) || !depth.has(e.to)) continue;
      const want = depth.get(e.from)! + 1;
      if (want > depth.get(e.to)!) {
        depth.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const filled = new Map<number, number>();
  return flow.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = filled.get(d) ?? 0;
    filled.set(d, row + 1);
    const clone = structuredClone(n);
    clone.x = GRID * 3 + d * COL_GAP;
    clone.y = GRID * 3 + row * ROW_GAP;
    return clone;
  });
}
