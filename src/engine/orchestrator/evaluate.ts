// The verdict function, in the shape of `engine/retire.ts`: pure, total, and
// acting on nothing. It answers one question per pass — which edges should fire
// right now — and leaves performing them, and stamping `firedAt`, to the runner.
// Keeping the decision separate from the action is what makes the latch, the join
// and the cap testable without launching a window.
import { RunStatus } from "../../types";
import { CondContext, evalCond, placeActivity } from "./conditions";
import {
  Condition, Flow, FlowAction, FlowEdge, edgeAction, findNode, incomingEdges, isPlace, isSettled, isSpendAction,
} from "./model";

/** How many acting edges (`launch` or `seed`) may fire in one pass. A badly wired
 * graph should not be able to storm your window manager; the remainder is reported
 * as `deferred` and fires on later passes. */
export const MAX_LAUNCHES_PER_PASS = 3;

/** Conditions that can only ever be true when the Live signal is readable, because
 * they ask what an agent is *doing*. `no-agent-left` is deliberately NOT here: it
 * counts sessions in the registry, which is populated whether or not any transcript
 * is read — and it is exactly the condition that should fire when nothing is there,
 * so blocking it on an unknown state would invert it. */
const AGENT_CONDS: Set<Condition["kind"]> = new Set(["agent-ended-turn", "agent-idle-over"]);

/** Whether the command a `command-succeeded` rule depends on actually ran and
 * succeeded. Lives here, not in `conditions.ts`, because a command node is not
 * a place: `evalCond`'s `CondContext` is built around a live `RunStatus` — an
 * agent, its repos, its PR — and a command node has none of those for it to
 * read (see that kind's own documented, unreachable arm in `conditions.ts`).
 * The verdict instead lives on the command node's INCOMING edge, which
 * `applyFired` (runner.ts) stamps with `firedAt` plus either an `error` or a
 * success note — and reading that needs the whole `Flow` in scope, which only
 * this module has.
 *
 * Two guards, both load-bearing:
 *
 * `commandNodeId`'s own kind must actually be `"command"`. Nothing stops a
 * rule wired FROM a place (or any other node) with this cond — the picker
 * does not filter by source kind yet, and a hand-edited flow file never did —
 * and without this check `incomingEdges` would read THAT node's incoming
 * edges instead, which for a promoted `place` are typically already fired,
 * reporting "succeeded" for a rule with no command anywhere near it.
 *
 * The performer must be found by `e.performed`, not inferred from the
 * absence of an error anywhere. An EARLIER version of this function reasoned
 * "a demoted per-target-dedupe sibling never gets `error`, so an `error`
 * anywhere can only be the real performer's" — true within one pass, but
 * Reset is PER EDGE: resetting only the errored performer (the one the
 * drawer highlights and offers Reset for) leaves the sibling's bare,
 * unrelated `firedAt` behind with nothing to contradict it, and "no error
 * anywhere" then reads as success for a command that has only ever failed.
 * `e.performed` is the fact that inference was reconstructing without ever
 * being told: it is set on the performer alone (see its own doc comment in
 * model.ts) and is cleared by that same Reset, so a Reset performer
 * correctly becomes "no performer", not "no evidence of failure". */
function commandSucceeded(flow: Flow, commandNodeId: string): boolean {
  if (findNode(flow, commandNodeId)?.kind !== "command") return false;
  const performer = incomingEdges(flow, commandNodeId).find((e) => e.performed === true);
  return performer !== undefined && performer.firedAt !== undefined;
}

export interface EvalInput {
  flow: Flow;
  /** Every status the Deck built this pass, in any order. */
  statuses: RunStatus[];
  nowMs: number;
  /** Defaults to `MAX_LAUNCHES_PER_PASS`. */
  maxLaunches?: number;
}

export interface FiredEdge {
  edge: FlowEdge;
  /** Should the runner perform this edge's action, or only stamp it as fired? An
   * "all" junction stamps every incoming edge but acts once. */
  perform: boolean;
  /** The action this edge performs, derived ONCE here from the target node.
   * Carried rather than re-derived downstream so `applyFired` and `notifyLines`
   * answer the same question against the same copy of the graph — the
   * discipline `notifyLines` already spells out. `undefined` when the target
   * is missing or of an unknown kind.
   *
   * `deckView.ts`'s spend gate, its dispatch check, `spendTarget` and
   * `performEdge` all read THIS field — it is passed to them as a parameter, so
   * they cannot re-derive a different verb than the one stamped for the pass.
   * The only edit that can change an action is a change to the TARGET NODE's
   * kind, and for the two verbs that SPEND — `launch` and `seed` — one whose
   * target changed kind under the pass resolves to no target and is refused with
   * an `error` and no `firedAt`. That is the whole safety argument: the carried
   * value being evaluation's vintage cannot cost money.
   *
   * It is scoped to those two on purpose. The non-spending verbs settle
   * differently, and neither is a hole: a carried `notify` never reaches
   * `performEdge` at all (the dispatch guards on `isSpendAction`) and is stamped
   * `firedAt` plus a receipt — the generic "told you" when the target is no
   * longer a notify node, which `deckView.test.ts`'s "stands by a notify
   * decision" case pins — and a carried `run` has nothing performing it yet, so
   * `applyFired`'s fail-closed arm stamps it as an unperformed action. */
  action: FlowAction | undefined;
}

/** Why an armed flow is not advancing — surfaced in the drawer's footer, because
 * a flow that silently waits on something impossible looks like patience. */
export interface BlockedNote {
  nodeId: string;
  reason: "gone" | "agent-state-unknown";
}

export interface EvalResult {
  fired: FiredEdge[];
  blocked: BlockedNote[];
  deferred: number;
}

export function evaluateFlow(i: EvalInput): EvalResult {
  // A fresh object rather than a shared constant: a caller that mutates the result
  // must not be able to poison every later disarmed pass.
  if (!i.flow.armed) return { fired: [], blocked: [], deferred: 0 };

  const byKey = new Map(i.statuses.map((s) => [s.run.key, s]));
  const blocked: BlockedNote[] = [];
  const seenBlocked = new Set<string>();
  const note = (nodeId: string, reason: BlockedNote["reason"]) => {
    // One note per node, not per edge leaving it: two edges from a forgotten run
    // are one problem, and the footer should say it once.
    const at = `${nodeId}:${reason}`;
    if (seenBlocked.has(at)) return;
    seenBlocked.add(at);
    blocked.push({ nodeId, reason });
  };

  /** Is this edge's condition true right now? `undefined` means "cannot say". */
  const isMet = (e: FlowEdge): boolean | undefined => {
    // Answered from the whole flow, not from a place's `RunStatus` — see
    // `commandSucceeded`'s own doc comment. Intercepted before the place/status
    // lookup below, which a command node's incoming edges have no use for and
    // would otherwise report as an unhelpful "gone" or a silent never-fires.
    if (e.cond.kind === "command-succeeded") return commandSucceeded(i.flow, e.from);
    const from = findNode(i.flow, e.from);
    // A planned source has no run to observe yet. Not a problem — just not ready.
    if (!from || !isPlace(from)) return undefined;
    const status = byKey.get(from.runKey);
    if (!status) {
      note(from.id, "gone");
      return undefined;
    }
    const c: CondContext = { status, repo: from.repo, nowMs: i.nowMs };
    // Read the same per-place activity `evalCond` itself will use — not the
    // unfiltered run aggregate. `placeActivity` only borrows the run aggregate
    // for a single-repo run, where it genuinely IS this place's state; for any
    // other run, a place whose own repo has no readable agent reads as unknown
    // here even while a different repo's agent in the same run is live, and
    // this guard blocks on exactly that.
    if (AGENT_CONDS.has(e.cond.kind) && placeActivity(c).state === "unknown") {
      note(from.id, "agent-state-unknown");
      return undefined;
    }
    return evalCond(e.cond, c);
  };

  // Memoised so an "all" junction re-reading its siblings costs nothing and cannot
  // record a blocked note twice.
  const metCache = new Map<string, boolean | undefined>();
  const met = (e: FlowEdge): boolean | undefined => {
    if (!metCache.has(e.id)) metCache.set(e.id, isMet(e));
    return metCache.get(e.id);
  };

  // A launch or seed is what costs something — a window, an agent session. A
  // notify is a toast, never capped. Only ever asked of the edge that performs.
  // `isSpendAction` is the one place this question is answered — see its own
  // comment in `model.ts` for why it must not be re-spelled here. The action
  // itself comes from `edgeAction`, the target's derivation, not the edge's own
  // (possibly stale) stored copy — see `FiredEdge.action`'s doc comment.
  const costsSlot = (e: FlowEdge) => isSpendAction(edgeAction(i.flow, e));

  // Cap decisions are made in the same pass as candidate selection, in flow
  // order, so an "all" junction can see how many slots are already spent by
  // earlier edges before it decides its own fate — see below.
  const cap = i.maxLaunches ?? MAX_LAUNCHES_PER_PASS;
  const fired: FiredEdge[] = [];
  let acting = 0;
  let deferred = 0;
  const handledTargets = new Set<string>();

  for (const edge of i.flow.edges) {
    if (isSettled(edge)) continue;
    const target = findNode(i.flow, edge.to);
    if (!target) continue;

    const incoming = incomingEdges(i.flow, edge.to);
    const isAllJoin = target.join === "all" && incoming.length > 1;

    if (!isAllJoin) {
      if (met(edge) !== true) continue;
      if (costsSlot(edge) && acting >= cap) {
        deferred++;
        continue;
      }
      if (costsSlot(edge)) acting++;
      fired.push({ edge, perform: true, action: edgeAction(i.flow, edge) });
      continue;
    }

    // An "all" junction is decided once, for the whole junction.
    if (handledTargets.has(edge.to)) continue;
    handledTargets.add(edge.to);

    // An error on any incoming edge stops the junction dead until that edge is
    // reset. Without this, the settled performer's slot in `pending` opens up
    // and a different sibling becomes the performer next pass — silently
    // re-routing a failed action through a different edge. Bail before ever
    // calling `met` on a sibling, too: an errored junction reports nothing,
    // not even a stale "gone" note for whichever edge happened to error.
    if (incoming.some((e) => e.error !== undefined)) continue;

    // Already-settled siblings count as satisfied: the junction closes over
    // time, not in one instant, and a flow that forgot its earlier arrivals
    // would never close. `isSettled(e)` (not just `e.firedAt`) also means a
    // settled edge is never handed to `met` again.
    const allMet = incoming.every((e) => isSettled(e) || met(e) === true);
    if (!allMet) continue;

    // The first still-*pending* edge in flow order performs — a settled edge
    // cannot perform again, which is why this is not simply "first incoming".
    const pending = incoming.filter((e) => !isSettled(e));
    const performer = pending[0];

    // Decide the junction's fate BEFORE any of its edges enter `fired`. If the
    // performer would be capped, fire NONE of them this pass: nothing gets
    // stamped, so there is nothing to strand if the condition stops holding
    // before a later pass frees a slot. The whole junction counts as one
    // deferred unit, not one per stranded sibling.
    if (costsSlot(performer) && acting >= cap) {
      deferred++;
      continue;
    }
    if (costsSlot(performer)) acting++;
    for (const e of pending) fired.push({ edge: e, perform: e === performer, action: edgeAction(i.flow, e) });
  }

  return { fired, blocked, deferred };
}
