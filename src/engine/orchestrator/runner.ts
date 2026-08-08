// What an armed flow's fired edges MEAN: the latches to stamp, and the sentences
// to show. Pure and total, so both decisions are testable from fixtures without a
// panel, a filesystem or a clock — the panel does the I/O.
import { FiredEdge } from "./evaluate";
import { Flow, findNode } from "./model";

/** Stamp `firedAt` and a receipt on every fired edge. Returns a new flow.
 *
 * Every fired edge is stamped, including the `perform: false` ones: an "all"
 * junction stamps its whole set and acts once, and a sibling left unstamped would
 * be re-evaluated on every pass forever. The note distinguishes them, because
 * "this ran" and "this junction closed" are different claims and the drawer shows
 * whichever it is told. */
export function applyFired(flow: Flow, fired: FiredEdge[], nowMs: number): Flow {
  if (fired.length === 0) return { ...flow, edges: flow.edges.map((e) => ({ ...e })) };
  const byId = new Map(fired.map((f) => [f.edge.id, f]));
  return {
    ...flow,
    edges: flow.edges.map((e) => {
      const hit = byId.get(e.id);
      if (!hit) return { ...e };
      return {
        ...e,
        firedAt: nowMs,
        firedNote: hit.perform ? performedNote(flow, hit) : "closed with its junction",
      };
    }),
  };
}

function performedNote(flow: Flow, hit: FiredEdge): string {
  if (hit.edge.action !== "notify") return `${hit.edge.action} — not available in this build`;
  const target = findNode(flow, hit.edge.to);
  return target && target.kind === "notify" ? `told you: ${target.message}` : "told you";
}

/** One sentence per PERFORMED notify edge, for a toast. A stamped-only edge did
 * nothing, so it says nothing — a toast for it would claim an action that never
 * happened. */
export function notifyLines(flow: Flow, fired: FiredEdge[]): string[] {
  const out: string[] = [];
  for (const f of fired) {
    if (!f.perform || f.edge.action !== "notify") continue;
    const target = findNode(flow, f.edge.to);
    const message = target && target.kind === "notify" ? target.message : null;
    out.push(message ? `${flow.name}: ${message}` : `${flow.name}: a rule fired.`);
  }
  return out;
}
