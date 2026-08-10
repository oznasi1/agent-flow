// A planned node has no run, so no condition on it can be evaluated. The moment a
// launch succeeds it must become a real place, or a chain dies at its second step:
// "ASM-1 merged -> launch ASM-12 -> ASM-12's CI passes -> launch ASM-15" would
// never reach the third link.
//
// Same id, position and join, so every downstream edge keeps pointing at it.
import { Flow, FlowEdge, PlaceNode, PlannedNode, isSettled } from "./model";

/** Promote `nodeId` to a place, and settle the rules that pointed at it as planned
 * work. `nowMs` is the pass's own clock, threaded in for the same reason
 * `applyFired`'s is: this function stamps `firedAt`, and a stamp needs a time the
 * caller owns rather than one this module reads. */
export function promoteToPlace(
  flow: Flow, nodeId: string, runKey: string, repo: string, nowMs: number,
): Flow {
  // Only a planned node is promoted (see the guard inside the map below), and the
  // edge rewrite must be gated on the same answer: a call naming a node that is
  // already a place, or one that is not there at all, changes nothing and must
  // not clear or stamp anything either.
  const target = flow.nodes.find((n) => n.id === nodeId);
  const planned: PlannedNode | undefined =
    target !== undefined && target.kind === "planned" ? target : undefined;
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
    // and means `seed` now. Two things follow from that, and this function owes
    // both — see `settleInto` below.
    edges: planned ? flow.edges.map((e) => settleInto(e, nodeId, planned.ticketKey, nowMs)) : flow.edges,
  };
}

/** What promotion owes an edge that pointed at the node it just rewrote. Every
 * other edge is handed back untouched, by reference.
 *
 * TWO changes, for two different reasons.
 *
 * 1. The stored `action` is DELETED (the field removed, not set to `undefined`, so
 *    the record matches an edge that never carried one — which is what `writeFlow`
 *    and `validEdge` both reason about). A stale `action: "launch"` is exactly the
 *    disagreement `latchActionMismatches` (store.ts) stamps an edge dead for on the
 *    next read, and in a fan-in the sibling that did not trigger is still unsettled
 *    — so the engine would latch a rule the user never touched, blaming them for an
 *    edit that was ours. `writeFlow` refills the field from the target, so the file
 *    still carries the `action` an older build's `validEdge` requires. Done for
 *    EVERY incoming edge, settled ones included: a settled edge is skipped by the
 *    latch today, but leaving a wrong claim on the record is not free for whatever
 *    reads the field next.
 *
 * 2. An UNSETTLED incoming edge is stamped SATISFIED — `firedAt` plus a receipt,
 *    and deliberately no `performed`. Clearing the action alone stopped the false
 *    latch but left the rule live with a changed VERB: a `launch` rule silently
 *    became a `seed`, so a condition coming true later would open an ADDITIONAL
 *    paid agent session the user never wrote, under a consent stamped for a launch.
 *    Such a sibling exists only in a `join: "any"` fan-in, which by construction
 *    means "any one of these reasons is enough to get this node running" — and it
 *    is running now, so the rule's purpose is served. This is the exact stamp
 *    `applyFired` (runner.ts) already writes for a demoted sibling of an `"all"`
 *    junction: `firedAt` set, `error` absent, `performed` absent, which
 *    `FlowEdge.performed`'s own doc comment describes as "this did not run,
 *    something else did". `commandSucceeded` therefore never reads one as a
 *    performer, and the drawer shows the receipt with a Reset beside it — which is
 *    the way out if the user genuinely wanted a seed. The action stays cleared
 *    either way, so that Reset lands on a live rule rather than back inside the
 *    conversion.
 *
 *    An edge that already carries `firedAt` or an `error` is left alone: it is
 *    history, and rewriting its receipt would blame this promotion for it — the
 *    same rule `latchActionMismatches` follows. */
function settleInto(e: FlowEdge, nodeId: string, ticketKey: string, nowMs: number): FlowEdge {
  if (e.to !== nodeId) return e;
  if (e.action === undefined && isSettled(e)) return e;
  const next: FlowEdge = { ...e };
  delete next.action;
  if (!isSettled(e)) {
    next.firedAt = nowMs;
    next.firedNote = `${ticketKey} was already launched by another rule`;
  }
  return next;
}
