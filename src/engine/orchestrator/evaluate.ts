// The verdict function, in the shape of `engine/retire.ts`: pure, total, and
// acting on nothing. It answers one question per pass — which edges should fire
// right now — and leaves performing them, and stamping `firedAt`, to the runner.
// Keeping the decision separate from the action is what makes the latch, the join
// and the cap testable without launching a window.
import { RunStatus } from "../../types";
import { BranchCiStatus } from "./branchCi";
import { CondContext, evalCond, placeActivity } from "./conditions";
import {
  Condition, Flow, FlowAction, FlowEdge, edgeAction, findNode, incomingEdges, isPlace, isSettled, isSpendAction,
} from "./model";

/** How many SPENDING edges (`launch`, `seed` or `run` — whatever `isSpendAction`
 * admits) may fire in one call. A badly wired graph should not be able to storm
 * your window manager; the remainder is reported as `deferred` and fires on later
 * passes.
 *
 * "PER_PASS" is the Deck's word, not this function's, and the two are not the same
 * unit: `evaluateFlow` is called once PER FLOW, so a poll over N armed flows can
 * spend up to 3N — three windows each, or three shell commands each. That is
 * deliberate (one flow cannot starve another), but it is the number to reason about
 * when asking what one poll can cost. `deckView.ts`'s per-target dedupe and its two
 * consent gates are what bound it in practice. */
export const MAX_LAUNCHES_PER_PASS = 3;

/** Conditions that can only ever be true when the Live signal is readable, because
 * they ask what a session is *doing*. `no-agent-left` is deliberately NOT here: it
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
 * rule wired FROM a place (or any other node) with this cond — both pickers now
 * refuse to OFFER it off a non-command source (`offeredConds`,
 * orchestratorRule.ts), but a hand-edited flow file, or one written by another
 * build, never went through a picker at all — and without this check
 * `incomingEdges` would read THAT node's incoming
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

/** Your answer to a gate, or `undefined` when it has not been given. Carries
 * the same two GUARDS `commandSucceeded` above documents — read that
 * function's comment first — but its `find` predicate is deliberately NOT
 * the same, and the two must stay different.
 *
 * The one difference in what the stamp means: `commandSucceeded` can read the
 * performer's `firedAt` AS the verdict, because "it ran and did not error" is
 * the whole answer. An ask edge's `firedAt` means the question was POSED, which
 * is not an approval, so the answer needs its own field: `gateAnswer`, written
 * by `flow:answerGate` (deckView.ts) and cleared by `flow:resetEdge` alongside
 * the rest of the performer's stamps.
 *
 * That is what lets `e.firedAt !== undefined` live INSIDE this `find`, instead
 * of being checked after it the way `commandSucceeded` checks it. Picture a
 * gate with two incoming rules, one wired under an older build where
 * `actionFor("gate")` was `undefined`: `applyFired` stamped that rule's edge
 * `performed: true` with an `error` and no `firedAt`, and it sits first in
 * flow order. Reset the OTHER rule later and it fires properly — `performed:
 * true` plus a real `firedAt` and `gateAnswer` — and a `find` that stops at
 * `performed === true` alone still lands on the errored edge, sees no
 * `firedAt`, and returns `undefined` forever: a silent, permanent stall,
 * `awaiting-answer` every pass while the node shows nothing. Folding the
 * `firedAt` check into the predicate lets the search continue past that
 * errored sibling to the edge that actually asked.
 *
 * `commandSucceeded` cannot make the same move: skipping an errored performer
 * to read a sibling's bare `firedAt` is exactly the sibling-inference bug its
 * own comment describes, because for a command `firedAt` with no error
 * already IS "succeeded". A gate's `firedAt` is never read as the answer by
 * itself — only `gateAnswer` is — so letting the search continue past one
 * candidate cannot manufacture an approval nobody gave; it can only recover
 * the one the user actually gave on a different edge. Do not "align" this
 * predicate with `commandSucceeded`'s — that reintroduces the bug the older
 * function's comment warns about, on the one node kind it cannot happen to.
 *
 * `firedAt !== undefined` is still required on whichever edge survives the
 * search: a performer that ERRORED carries `performed` with no `firedAt`, and
 * a hand-written `gateAnswer` sitting on such an edge must not read back as an
 * answer to a question that was never asked. */
function gateAnswer(flow: Flow, gateNodeId: string): "approved" | "rejected" | undefined {
  if (findNode(flow, gateNodeId)?.kind !== "gate") return undefined;
  const performer = incomingEdges(flow, gateNodeId).find(
    (e) => e.performed === true && e.firedAt !== undefined,
  );
  return performer?.gateAnswer;
}

export interface EvalInput {
  flow: Flow;
  /** Every status the Deck built this pass, in any order. */
  statuses: RunStatus[];
  nowMs: number;
  /** Defaults to `MAX_LAUNCHES_PER_PASS`. */
  maxLaunches?: number;
  /** Branch-CI verdicts for this pass, keyed `repo#branch` — passed straight through
   * to every `CondContext` this evaluation builds (see that field's own doc comment
   * in `conditions.ts`). One map for the whole pass, not one per node: several rules
   * can name the same branch and they must all read the same fetch.
   *
   * Omitted by every caller that has no branch-CI rule to answer, and by every
   * existing test — which is safe rather than merely convenient: an absent map reads
   * as `"unknown"`, and `"unknown"` is not met. */
  branchCi?: Record<string, BranchCiStatus>;
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
   * kind, and for every verb that SPENDS — `launch`, `seed` and `run` — one whose
   * target changed kind under the pass resolves to no target and is refused with
   * an `error` and no `firedAt`. `performRun` refuses in exactly the same shape
   * `performEdge`/`performSeed` do (`commandTarget` answering nothing), which is
   * what made this paragraph true for `run` as well from Task 6 onwards; an
   * earlier version of this comment still said `run` had "nothing performing it
   * yet" and settled through `applyFired`'s fail-closed arm. That is the whole
   * safety argument: the carried value being evaluation's vintage cannot cost
   * money.
   *
   * The one non-spending verb settles differently and is not a hole either: a
   * carried `notify` never reaches `performEdge` at all (the dispatch guards on
   * `isSpendAction`) and is stamped `firedAt` plus a receipt — the generic
   * "told you" when the target is no longer a notify node, which
   * `deckView.test.ts`'s "stands by a notify decision" case pins. */
  action: FlowAction | undefined;
}

/** Why an armed flow is not advancing. Computed on every armed pass and read
 * by the dry run via `previewFlow` → `RulePreview.reason` → `verdictWhy`
 * (orchestratorRule.ts), which produces user-facing wording for each reason.
 * An unadvancing node needs explanation so it does not silently look like
 * patience. */
export interface BlockedNote {
  nodeId: string;
  reason: "gone" | "agent-state-unknown" | "awaiting-answer";
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
    // Intercepted here, beside `command-succeeded` and before the place/status
    // lookup, for the same reason: a gate has no `runKey`, so falling through
    // would report the node as "gone" every pass instead of as waiting on you.
    if (e.cond.kind === "gate-approved" || e.cond.kind === "gate-rejected") {
      const answer = gateAnswer(i.flow, e.from);
      // Only once the question has actually been ASKED. An unasked gate is
      // ordinary not-there-yet — the same silence a planned source gets — and a
      // note for it would tell you to answer a question nobody posed.
      if (answer === undefined && findNode(i.flow, e.from)?.kind === "gate"
        && incomingEdges(i.flow, e.from).some((a) => a.performed === true && a.firedAt !== undefined)) {
        note(e.from, "awaiting-answer");
      }
      return answer === (e.cond.kind === "gate-approved" ? "approved" : "rejected");
    }
    const from = findNode(i.flow, e.from);
    // A planned source has no run to observe yet. Not a problem — just not ready.
    if (!from || !isPlace(from)) return undefined;
    const status = byKey.get(from.runKey);
    if (!status) {
      note(from.id, "gone");
      return undefined;
    }
    const c: CondContext = { status, repo: from.repo, nowMs: i.nowMs, branchCi: i.branchCi };
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
