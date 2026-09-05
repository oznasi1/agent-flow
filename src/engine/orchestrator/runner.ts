// What an armed flow's fired edges MEAN: the latches to stamp, and the sentences
// to show. Pure and total, so both decisions are testable from fixtures without a
// panel, a filesystem or a clock — the panel does the I/O.
import { ClockResult, FiredEdge } from "./evaluate";
import { Flow, FlowAction, FlowEdge, findNode, isPerformedAction, isSettled, isSpendAction, retryPolicy } from "./model";

/** Stamp the clocks a pass decided about: `liveSince` on every rule that went
 * live, `expiredAt` on every rule that ran out. Returns the SAME flow object when
 * nothing changed, so the caller can skip the write — a pass on a flow with no
 * deadlines must cost no write at all, which is what keeps this feature inert
 * for every flow that never opted in.
 *
 * Reads the edge as the store holds it NOW, not as evaluation saw it a store-read
 * ago, and that is why two of the ids can be ignored: a rule another window has
 * since settled must not gain an expiry on top of its receipt, and a clock the
 * store already holds is not restarted (evaluation named it live because ITS copy
 * had no `liveSince`; the store's copy may, if a parallel pass got there first).
 * Both are the same discipline `advanceUnderLock`'s `unclaimed` filter applies to
 * fired edges. */
export function applyClocks(flow: Flow, clocks: ClockResult, nowMs: number): Flow {
  const live = new Set(clocks.wentLive);
  const out = new Set(clocks.expired);
  let changed = false;
  const edges = flow.edges.map((e) => {
    if (isSettled(e)) return e;
    if (out.has(e.id)) {
      changed = true;
      return { ...e, expiredAt: nowMs };
    }
    if (live.has(e.id) && e.liveSince === undefined) {
      changed = true;
      return { ...e, liveSince: nowMs };
    }
    return e;
  });
  return changed ? { ...flow, edges } : flow;
}

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
 * below) — is one the caller was asked to perform (`isSpendAction`: a `launch`, a
 * `seed` or a `run`) is stamped from `outcomes`, keyed by edge id. A success takes
 * `firedAt` and the caller's note; a failure takes `error`
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
 * and its junction genuinely closed.
 *
 * A performed edge whose carried action is `undefined` — no verb could be derived,
 * because its target is missing or of a kind this build does not know — is
 * stamped with an `error` naming THAT, not with a verb it does not have. */
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
      // `performed: true` on every branch below where `hit.perform` is true, and
      // on NONE where it is false — see `FlowEdge.performed`'s own doc comment
      // for why `firedAt`/`error` alone cannot carry this. It is set
      // regardless of whether the performed action then succeeded or failed,
      // because "was this the one that ran" and "did it succeed" are two
      // different questions; `commandSucceeded` (evaluate.ts) asks them in
      // that order.
      //
      // An UNDEFINED carried action is answered first, and with a sentence about
      // the graph rather than about the verb: evaluation could not derive one at
      // all, because the target is missing or of a kind this build does not know
      // (`validNode` admits an unknown kind on purpose so a newer build's flow
      // still renders). This arm used to fall in with the acting ones and stamp
      // the literal `"undefined was not performed"`, while the carefully worded
      // refusal for the same case in `performEdge` (deckView.ts) was DEAD — the
      // dispatch there only calls it for a spending verb, which `undefined` is
      // not. The sentence lives here now, where the case is actually reachable.
      if (hit.perform && hit.action === undefined) {
        return {
          ...e,
          error: `this rule points at ${e.to}, which is not a place, planned work, a notification, or a command.`,
          performed: true,
        };
      }
      // `isSpendAction`, not a local `!== "notify"`: `model.ts` promises ONE
      // allowlist for "does this spend", written that way so a NEW action defaults
      // to non-spending until someone deliberately adds it — and re-answering the
      // same question here as a negation is exactly how the two drift.
      //
      // It is also the RIGHT predicate for this arm, not merely the shared one:
      // `deckView.ts`'s dispatch calls `performEdge` for `isSpendAction(f.action)`
      // and nothing else, so "the caller was asked to perform this and owes an
      // outcome" IS that allowlist, by construction. A fifth, non-spending verb is
      // never dispatched, so demanding an outcome from it would latch a rule
      // nothing was ever asked to perform.
      // `isPerformedAction`, not `isSpendAction`: `spawn` spends nothing and is
      // neither capped nor consent-gated, but the host DOES perform it (it writes
      // the child flow) and so owes an outcome exactly like a launch does.
      if (hit.perform && isPerformedAction(hit.action)) {
        const outcome = outcomes?.get(e.id);
        // Terminal, and never retried: nothing ran, so there is no failure a
        // second attempt could be a second attempt AT. `retryAt` is dropped in
        // case this is the fail-closed end of a retry that never reached the act.
        if (!outcome) return { ...withoutRetryStamps(e), error: `${hit.action} was not performed`, performed: true };
        if (!outcome.ok) return failedStamp(e, hit.action, outcome.error, nowMs);
        // A success clears the failure it may be recovering from: `error` and
        // `retryAt` go, `attempts` stays so the receipt can say what it took.
        const { error: _cleared, ...recovered } = withoutRetryStamps(e);
        const retries = typeof e.attempts === "number" && e.attempts > 0 ? e.attempts : 0;
        return {
          ...recovered,
          firedAt: nowMs,
          firedNote: retries > 0 ? `${outcome.note} · after ${retries} ${retries === 1 ? "retry" : "retries"}` : outcome.note,
          performed: true,
        };
      }
      return {
        ...e,
        firedAt: nowMs,
        // NOT "closed with its junction": most of the time this is now the
        // per-target dedupe on an ordinary `join: "any"` node, which is not a
        // junction at all — the drawer would show that word for a node that
        // never waited on anything. True for both shapes instead.
        firedNote: hit.perform ? performedNote(flow, hit) : "another edge into this target already acted",
        ...(hit.perform ? { performed: true as const } : {}),
      };
    }),
  };
}

/** `e` with the pending-retry stamp removed. `attempts` is deliberately kept: it
 * is the count, and the count outlives the schedule. */
function withoutRetryStamps(e: FlowEdge): FlowEdge {
  const { retryAt: _drop, ...rest } = e;
  return rest;
}

/** What a FAILED performing edge is stamped with. Counts the failure, then asks
 * `retryPolicy` whether — for this action, with this rule's opt-in — another
 * attempt is allowed. If so the edge keeps its `error` (the drawer shows what
 * went wrong) and gains `retryAt`, which is what keeps it out of `isSettled` and
 * tells `evaluate.ts` when it may be tried again. Otherwise it is the terminal
 * failure it always was, with `attempts` saying how many tries that took.
 *
 * `attempts` counts failures, so after the first failure it is 1 and a policy of
 * `max: 3` schedules retries after failures 1, 2 and 3 — three retries, four
 * attempts in all — and latches on the fourth failure. */
function failedStamp(e: FlowEdge, action: FlowAction | undefined, error: string, nowMs: number): FlowEdge {
  const attempts = (typeof e.attempts === "number" && e.attempts >= 0 ? e.attempts : 0) + 1;
  const policy = retryPolicy(e, action);
  const base = { ...withoutRetryStamps(e), error, performed: true as const, attempts };
  return policy !== undefined && attempts <= policy.max ? { ...base, retryAt: nowMs + policy.backoffMs } : base;
}

/** The receipt for a performed edge the caller reported no outcome for — which,
 * today, is only ever a `notify`: every SPENDING verb goes through `outcomes`
 * above, and an undefined action is refused before this is reached.
 *
 * "told you" is keyed on the carried ACTION, not on the target's current kind: a
 * pass that decided `notify` and then found the node changed under it still
 * stands by that decision (pinned by `deckView.test.ts`'s "stands by a notify
 * decision"). A future NON-SPENDING verb would reach here too, and it must not
 * inherit that sentence — nothing here notified anybody — so it gets the drawer's
 * own neutral default instead of a claim about what happened. */
function performedNote(flow: Flow, hit: FiredEdge): string {
  const target = findNode(flow, hit.edge.to);
  if (hit.action === "notify") {
    return target && target.kind === "notify" ? `told you: ${target.message}` : "told you";
  }
  // The second non-spending verb, and it gets its own sentence for the same
  // reason `notify` does: "fired" tells the drawer nothing about WHAT was asked,
  // and a gate's whole receipt is the question. Keyed on the carried ACTION, not
  // the target's current kind — a pass that decided `ask` stands by that decision
  // even if the node changed under it, which is why the fallback below still says
  // "asked you" rather than reaching for the neutral default.
  if (hit.action === "ask") {
    return target && target.kind === "gate" ? `asked you: ${target.question}` : "asked you";
  }
  return "fired";
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
