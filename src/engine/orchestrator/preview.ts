// The dry run: what an armed flow would do to the board as it stands, per rule,
// without doing any of it. Pure and total, like `evaluate.ts` itself — this module
// performs nothing, writes nothing, and is safe to call on every render.
//
// It answers a question `evaluateFlow` deliberately does not. That function reports
// what to DO — the edges to fire, a count of what the cap held back, and notes for
// the sources it cannot observe — and stays silent about every rule that is simply
// not ready, because the runner has nothing to do with those. A reader deciding
// whether to arm needs the opposite: a verdict for every rule still in play,
// including "this one is waiting" and "this one is waiting on something that can
// never arrive".
import { RunStatus } from "../../types";
import { BranchCiStatus } from "./branchCi";
import { BlockedNote, evaluateDeadlines, evaluateFlow } from "./evaluate";
import { condIncomplete, deadlineAt, Flow, isSettled } from "./model";

/** One pending rule's fate, if the flow were armed right now. */
export interface RulePreview {
  edgeId: string;
  /**  - `fire` — its condition is met and this pass would stamp it.
   *   - `defer` — met, but the launch cap is already spent; a later pass fires it.
   *   - `blocked` — its source cannot be observed at all, so it can never be met
   *     while that stays true. `reason` says which way.
   *   - `unset` — its own condition names a blank branch, repo or status, so
   *     nothing on any board could satisfy it. `blank` says which. Distinct from
   *     `blocked`, which is about the SOURCE: a blocked rule fires once the card
   *     is back, an unset one never fires until the rule itself is edited.
   *   - `expire` — its deadline has run out with the condition still unmet, so
   *     this pass would settle it as expired rather than fire it. Outranks
   *     `blocked`, `unset` and `waiting` for the same reason `fire` does: it is
   *     what the engine would actually DO. A sibling `deadline-passed` rule is
   *     what then acts.
   *   - `waiting` — answerable and false. The ordinary resting state. */
  verdict: "fire" | "defer" | "expire" | "blocked" | "unset" | "waiting";
  /** Whether this edge would perform its action, or only be stamped. `false` on
   * the non-performing siblings of an "all" junction, which close the join while
   * one edge acts for all of them — so a caller can say "would close" where it
   * would otherwise promise three windows and open one. Carried on `defer` too:
   * it is still which edge acts once a slot frees. Always `false` where nothing
   * would happen at all. */
  perform: boolean;
  /** Set on `blocked` alone. */
  reason?: BlockedNote["reason"];
  /** Set on `unset` alone: which parameter is blank, in `condIncomplete`'s own
   * words — the same string the inspector marks the field with and the arm
   * warning counts. One predicate behind all three, so a dry run cannot call a
   * rule ordinary that arming then calls dead. */
  blank?: string;
  /** When this rule's clock runs out — `deadlineAt` (model.ts) — carried on a
   * still-pending verdict (`waiting`, `blocked`, `unset`) whose deadline is set
   * and whose clock is running. Absent on `fire`/`defer`/`expire` (decided) and
   * on any rule with no deadline or no clock yet. The drawer and the card's
   * stepper turn it into "expires in 12m". */
  deadlineAt?: number;
}

/** Every rule still in play, with what would become of it. Settled rules are
 * absent: they are not waiting on anything.
 *
 * `flow.armed` is forced true on a COPY, never on the caller's object. A dry run
 * is the thing you read *before* arming, so the common case is a disarmed flow —
 * and `evaluateFlow` short-circuits one to an empty result. Arming the caller's
 * own object instead would arm it for real the moment anything wrote that object
 * back to disk.
 *
 * The two `evaluateFlow` calls are the whole trick, and are not redundant. The cap
 * is reported by `EvalResult.deferred` as a COUNT, which cannot name the rules it
 * covers — and for an "all" junction deliberately counts the entire junction as
 * one unit, so even a correct count is not a number of edges. Running the same
 * evaluation a second time with the cap lifted answers it exactly: an edge that
 * fires with no cap and does not fire with one was held back by the cap, and
 * nothing else. Junctions included, since a capped junction contributes none of
 * its edges to `fired` and all of them to the uncapped run.
 *
 * Do NOT "simplify" this into a single call plus a re-derivation of the cap
 * arithmetic here. That arithmetic is subtle — flow order, which sibling performs,
 * a junction firing as one unit or not at all — and a second copy of it in a
 * module whose only job is to DESCRIBE the first would drift, quietly, into
 * telling the user something the runner does not do. Two passes over a graph of a
 * dozen edges cost nothing worth having. */
export function previewFlow(
  flow: Flow,
  statuses: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): RulePreview[] {
  const i = { flow: { ...flow, armed: true }, statuses, nowMs, branchCi };
  const capped = evaluateFlow(i);
  const uncapped = evaluateFlow({ ...i, maxLaunches: Number.POSITIVE_INFINITY });

  const firing = new Map(capped.fired.map((f) => [f.edge.id, f.perform]));
  const uncappedFiring = new Map(uncapped.fired.map((f) => [f.edge.id, f.perform]));
  // Keyed by node, exactly as `evaluateFlow` reports it: one forgotten run is one
  // problem, however many rules watch it. Read from the capped pass, and the two
  // agree — a note is recorded while answering a condition, which happens before
  // any cap decision.
  const blockedNodes = new Map(capped.blocked.map((b) => [b.nodeId, b.reason]));
  // The clocks, from the same oracle the two passes above used — so "would
  // expire" can never sit beside a "would fire" for the same rule: expiry is
  // only ever reported for a rule whose condition was NOT met.
  const expiring = new Set(evaluateDeadlines(i).expired);

  const out: RulePreview[] = [];
  for (const e of flow.edges) {
    if (isSettled(e)) continue;
    /** `deadlineAt` for a pending verdict, spread in only when there is one so a
     * rule with no deadline previews exactly as it always has. */
    const clock = (() => { const at = deadlineAt(e); return at === undefined ? {} : { deadlineAt: at }; })();
    // Ordered: fired beats held-by-the-cap beats blocked. `blocked` is per-node
    // and cannot coexist with either — a source nobody can observe answers no
    // condition — but reading it last keeps that an observation rather than a
    // dependency.
    const perform = firing.get(e.id);
    if (perform !== undefined) {
      out.push({ edgeId: e.id, verdict: "fire", perform });
      continue;
    }
    const held = uncappedFiring.get(e.id);
    if (held !== undefined) {
      out.push({ edgeId: e.id, verdict: "defer", perform: held });
      continue;
    }
    // AFTER fire and defer — a met rule fires, however late — and BEFORE every
    // still-pending verdict, because it is not pending: this pass settles it.
    if (expiring.has(e.id)) {
      out.push({ edgeId: e.id, verdict: "expire", perform: false });
      continue;
    }
    // AFTER fire and defer, deliberately. `evalCond` compares a ticket status by
    // equality, so a rule waiting on the empty string does match a run whose
    // `ticketStatus` is itself `""` — vanishingly rare, but real, and if the
    // engine says it would fire then "never fires" is the wrong answer. What the
    // engine actually decided always wins here.
    //
    // BEFORE blocked, matching `unfirableRules`' own precedence (armability.ts)
    // for the same reason: when a rule is both, the blank is the half the user
    // can fix, and putting the card back would still leave it dead.
    const blank = condIncomplete(e.cond);
    if (blank !== undefined) {
      out.push({ edgeId: e.id, verdict: "unset", perform: false, blank, ...clock });
      continue;
    }
    const reason = blockedNodes.get(e.from);
    if (reason !== undefined) {
      out.push({ edgeId: e.id, verdict: "blocked", perform: false, reason, ...clock });
      continue;
    }
    out.push({ edgeId: e.id, verdict: "waiting", perform: false, ...clock });
  }
  return out;
}
