// A planned node has no run, so no condition on it can be evaluated. The moment a
// launch succeeds it must become a real place, or a chain dies at its second step:
// "ASM-1 merged -> launch ASM-12 -> ASM-12's CI passes -> launch ASM-15" would
// never reach the third link.
//
// Same id, position and join, so every downstream edge keeps pointing at it.
import { Flow, FlowEdge, PlaceNode } from "./model";

export function promoteToPlace(flow: Flow, nodeId: string, runKey: string, repo: string): Flow {
  // Only a planned node is promoted (see the guard inside the map below), and the
  // edge rewrite must be gated on the same answer: a call naming a node that is
  // already a place, or one that is not there at all, changes nothing and must
  // not clear anything either.
  const promoting = flow.nodes.some((n) => n.id === nodeId && n.kind === "planned");
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      // Only a planned node is promoted. Re-promoting a place would rewrite the
      // repo it is bound to, silently changing what every condition on it means.
      if (n.id !== nodeId || n.kind !== "planned") return n;
      const promoted: PlaceNode = {
        id: n.id, kind: "place", x: n.x, y: n.y, join: n.join, runKey, repo,
      };
      return promoted;
    }),
    // Promotion moves a node `planned` -> `place`, which is the other direction
    // `edgeAction` moves: every edge INTO this node meant `launch` a moment ago
    // and means `seed` now. A stored `action: "launch"` left behind on one is
    // exactly the disagreement `latchActionMismatches` (store.ts) stamps an edge
    // dead for on the next read — and in a fan-in (two rules into one planned
    // node, the default `join: "any"`, one condition met) the SIBLING that did
    // not trigger is still unsettled, so the engine would latch a rule the user
    // never touched, blaming them for an edit that was ours. Worse, the remedy
    // that error names is Reset, which drops the stored action and re-derives
    // `seed` anyway — so the conversion happened either way, just via an error
    // first.
    //
    // Clearing it here is the exact analogue of what Reset does, and it rests on
    // the same justification: promotion IS the user's own consent — they approved
    // the launch that caused it. `writeFlow` then fills the field from the target
    // (`e.action ?? edgeAction(...)`), so the file still carries the `action` an
    // older build's `validEdge` requires, now agreeing with where the edge points.
    //
    // Every incoming edge, not just the unsettled ones: a settled edge is skipped
    // by `latchActionMismatches` today, but leaving a stale `launch` on it would
    // keep a wrong claim on the record for anything that reads the field later.
    edges: promoting ? flow.edges.map((e) => clearActionInto(e, nodeId)) : flow.edges,
  };
}

/** An edge into `nodeId` with its stored `action` deleted — the field removed, not
 * set to `undefined`, so the record this writes is the same shape as an edge that
 * never carried one (which is what `writeFlow` and `validEdge` both reason about).
 * Every other edge is handed back untouched, by reference. */
function clearActionInto(e: FlowEdge, nodeId: string): FlowEdge {
  if (e.to !== nodeId || e.action === undefined) return e;
  const cleared: FlowEdge = { ...e };
  delete cleared.action;
  return cleared;
}
