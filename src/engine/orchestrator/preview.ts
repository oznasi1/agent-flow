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
import { BlockedNote, evaluateFlow } from "./evaluate";
import { Flow, isSettled } from "./model";

/** One pending rule's fate, if the flow were armed right now. */
export interface RulePreview {
  edgeId: string;
  /**  - `fire` — its condition is met and this pass would stamp it.
   *   - `defer` — met, but the launch cap is already spent; a later pass fires it.
   *   - `blocked` — its source cannot be observed at all, so it can never be met
   *     while that stays true. `reason` says which way.
   *   - `waiting` — answerable and false. The ordinary resting state. */
  verdict: "fire" | "defer" | "blocked" | "waiting";
  /** Whether this edge would perform its action, or only be stamped. `false` on
   * the non-performing siblings of an "all" junction, which close the join while
   * one edge acts for all of them — so a caller can say "would close" where it
   * would otherwise promise three windows and open one. Carried on `defer` too:
   * it is still which edge acts once a slot frees. Always `false` where nothing
   * would happen at all. */
  perform: boolean;
  /** Set on `blocked` alone. */
  reason?: BlockedNote["reason"];
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

  const out: RulePreview[] = [];
  for (const e of flow.edges) {
    if (isSettled(e)) continue;
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
    const reason = blockedNodes.get(e.from);
    if (reason !== undefined) {
      out.push({ edgeId: e.id, verdict: "blocked", perform: false, reason });
      continue;
    }
    out.push({ edgeId: e.id, verdict: "waiting", perform: false });
  }
  return out;
}
