// What an armed flow's fired edges MEAN: the latches to stamp, and the sentences
// to show. Pure and total, so both decisions are testable from fixtures without a
// panel, a filesystem or a clock — the panel does the I/O.
import { FiredEdge } from "./evaluate";
import { Flow, findNode } from "./model";

/** What actually happened when the caller performed one acting edge. Only the
 * caller can know — a `launch` either opened a window or explained why it did not —
 * so this is reported IN rather than guessed here. */
export type ActOutcome =
  | { ok: true; note: string }
  | { ok: false; error: string };

/** Stamp `firedAt` and a receipt on every fired edge. Returns a new flow.
 *
 * Every fired edge is stamped, including the `perform: false` ones: an "all"
 * junction stamps its whole set and acts once, and a sibling left unstamped would
 * be re-evaluated on every pass forever. The note distinguishes them, because
 * "this ran" and "this junction closed" are different claims and the drawer shows
 * whichever it is told.
 *
 * A PERFORMED edge whose action is not `notify` — a `launch` or a `seed` — is
 * stamped from `outcomes`, keyed by edge id. A success takes `firedAt` and the
 * caller's note; a failure takes `error` and NO `firedAt`, and the difference
 * matters in three ways:
 *  - `isSettled` counts `error`, so it still cannot re-fire in a loop;
 *  - the drawer surfaces an errored edge and offers Reset for it, so it is not a
 *    dead end the user cannot clear;
 *  - a `firedAt` would consume the latch AS A SUCCESS, so a failed launch would
 *    look already-done and never run. An `error` needs one Reset to become live.
 * An acting edge with no outcome fails closed the same way, because the honest
 * reading of "the caller said nothing" is that nothing was performed — never a
 * success stamp for an action that may never have happened.
 *
 * A `perform: false` non-notify edge is NOT an error: it genuinely did nothing,
 * and its junction genuinely closed. */
export function applyFired(
  flow: Flow, fired: FiredEdge[], nowMs: number, outcomes?: ReadonlyMap<string, ActOutcome>,
): Flow {
  if (fired.length === 0) return { ...flow, edges: flow.edges.map((e) => ({ ...e })) };
  const byId = new Map(fired.map((f) => [f.edge.id, f]));
  return {
    ...flow,
    edges: flow.edges.map((e) => {
      const hit = byId.get(e.id);
      if (!hit) return { ...e };
      if (hit.perform && e.action !== "notify") {
        const outcome = outcomes?.get(e.id);
        if (!outcome) return { ...e, error: `${e.action} was not performed` };
        if (!outcome.ok) return { ...e, error: outcome.error };
        return { ...e, firedAt: nowMs, firedNote: outcome.note };
      }
      return {
        ...e,
        firedAt: nowMs,
        firedNote: hit.perform ? performedNote(flow, hit) : "closed with its junction",
      };
    }),
  };
}

/** Only ever asked of a performed `notify` edge — the caller above routes every
 * other action through its outcome instead, so there is no acting arm here. */
function performedNote(flow: Flow, hit: FiredEdge): string {
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
