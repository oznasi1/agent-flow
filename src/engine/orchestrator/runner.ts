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
 * junction stamps its whole set and acts once, and so does the per-target dedupe
 * on any OTHER target with more than one incoming edge (the ordinary shape of
 * "when it lands, start the next ticket" wired from two conditions) — either way
 * a sibling left unstamped would be re-evaluated on every pass forever. The note
 * distinguishes the two claims, because "this ran" and "this didn't, because
 * another edge into the same target already did" are different, and the drawer
 * shows whichever it is told.
 *
 * A PERFORMED edge whose CARRIED action — `hit.action`, decided once at
 * evaluation, not necessarily `flow`'s own current copy of it (see the branch
 * below) — is not `notify` — a `launch` or a `seed` — is stamped from
 * `outcomes`, keyed by edge id. A success takes `firedAt` and the caller's
 * note; a failure takes `error`
 * and NO `firedAt`, and the difference matters in three ways:
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
      // Branch on `hit.action` — the action evaluation decided ONCE, and the
      // vintage `outcomes` is keyed to — never on `e.action`, this function's
      // OWN `flow` argument's current copy. In `deckView.ts`, `flow` can be
      // `atWrite`: read AFTER the act, specifically so a concurrent
      // `flow:save`'s other fields pass through to the write. If that same
      // concurrent edit changed THIS edge's action too, `e.action` and
      // `hit.action` disagree about what kind of edge this is — and branching
      // on `e.action` would silently discard a real launch's outcome for a
      // generic "told you" note (if the flow now says `notify`), or mislabel a
      // genuinely-fired notify as an unperformed launch (if the flow now says
      // `launch`). The stamp must describe what evaluation decided, which only
      // `hit.action` — carried from there, once — knows. Every OTHER field
      // below still comes from `e`/`flow` — only which branch to take, and
      // which verb the fallback error below names, come from `hit`.
      //
      // `hit.action` is also what the caller PERFORMED against: `deckView.ts`'s
      // spend gate, its dispatch check and `performEdge` all take this same
      // carried value as a parameter rather than reading `e.action`, so the verb
      // this function stamps is the verb that ran.
      if (hit.perform && hit.action !== "notify") {
        const outcome = outcomes?.get(e.id);
        if (!outcome) return { ...e, error: `${hit.action} was not performed` };
        if (!outcome.ok) return { ...e, error: outcome.error };
        return { ...e, firedAt: nowMs, firedNote: outcome.note };
      }
      return {
        ...e,
        firedAt: nowMs,
        // NOT "closed with its junction": most of the time this is now the
        // per-target dedupe on an ordinary `join: "any"` node, which is not a
        // junction at all — the drawer would show that word for a node that
        // never waited on anything. True for both shapes instead.
        firedNote: hit.perform ? performedNote(flow, hit) : "another edge into this target already acted",
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
  // Reads the action the DECISION carried, not one re-derived from `flow` —
  // `flow` here can be the copy the caller re-read immediately before writing,
  // and re-deriving would let a concurrent edit make this announce one thing
  // while `applyFired` stamps another. Same question, same copy; the copy is
  // now the FiredEdge itself.
  for (const f of fired) {
    if (!f.perform || f.action !== "notify") continue;
    const target = findNode(flow, f.edge.to);
    const message = target && target.kind === "notify" ? target.message : null;
    out.push(message ? `${flow.name}: ${message}` : `${flow.name}: a rule fired.`);
  }
  return out;
}
