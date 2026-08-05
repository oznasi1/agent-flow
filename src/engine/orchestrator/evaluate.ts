// The verdict function, in the shape of `engine/retire.ts`: pure, total, and
// acting on nothing. It answers one question per pass — which edges should fire
// right now — and leaves performing them, and stamping `firedAt`, to the runner.
// Keeping the decision separate from the action is what makes the latch, the join
// and the cap testable without launching a window.
import { RunStatus } from "../../types";
import { CondContext, evalCond } from "./conditions";
import { Flow, FlowEdge, findNode, incomingEdges, isPlace } from "./model";

/** How many acting edges (`launch` or `seed`) may fire in one pass. A badly wired
 * graph should not be able to storm your window manager; the remainder is reported
 * as `deferred` and fires on later passes. */
export const MAX_LAUNCHES_PER_PASS = 3;

/** Conditions that can only ever be true when the Live signal is readable, because
 * they ask what an agent is *doing*. `no-agent-left` is deliberately NOT here: it
 * counts sessions in the registry, which is populated whether or not any transcript
 * is read — and it is exactly the condition that should fire when nothing is there,
 * so blocking it on an unknown state would invert it. */
const AGENT_CONDS = new Set(["agent-ended-turn", "agent-idle-over"]);

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

/** Has this edge already run? Either verdict is terminal until Reset clears it. */
function settled(e: FlowEdge): boolean {
  return e.firedAt !== undefined || e.error !== undefined;
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
    const from = findNode(i.flow, e.from);
    // A planned source has no run to observe yet. Not a problem — just not ready.
    if (!from || !isPlace(from)) return undefined;
    const status = byKey.get(from.runKey);
    if (!status) {
      note(from.id, "gone");
      return undefined;
    }
    const c: CondContext = { status, repo: from.repo, nowMs: i.nowMs };
    if (AGENT_CONDS.has(e.cond.kind) && status.agent.state === "unknown"
        && status.agents.every((a) => a.activity.state === "unknown")) {
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

  const candidates: FiredEdge[] = [];
  const handledTargets = new Set<string>();

  for (const edge of i.flow.edges) {
    if (settled(edge)) continue;
    const target = findNode(i.flow, edge.to);
    if (!target) continue;

    const incoming = incomingEdges(i.flow, edge.to);
    const isAllJoin = target.join === "all" && incoming.length > 1;

    if (!isAllJoin) {
      if (met(edge) === true) candidates.push({ edge, perform: true });
      continue;
    }

    // An "all" junction is decided once, for the whole junction.
    if (handledTargets.has(edge.to)) continue;
    handledTargets.add(edge.to);
    // Already-fired siblings count as met: the junction closes over time, not in
    // one instant, and a flow that forgot its earlier arrivals would never close.
    const allMet = incoming.every((e) => e.firedAt !== undefined || met(e) === true);
    if (!allMet) continue;
    const pending = incoming.filter((e) => !settled(e));
    // The first incoming edge in flow order performs; the rest are only stamped.
    // Flow order is stable, which is what makes this deterministic.
    pending.forEach((e, idx) => candidates.push({ edge: e, perform: idx === 0 }));
  }

  // Cap only what costs something. A notify is a toast; a launch is a window.
  const cap = i.maxLaunches ?? MAX_LAUNCHES_PER_PASS;
  const fired: FiredEdge[] = [];
  let acting = 0;
  let deferred = 0;
  for (const c of candidates) {
    const costs = c.perform && (c.edge.action === "launch" || c.edge.action === "seed");
    if (costs && acting >= cap) {
      deferred++;
      continue;
    }
    if (costs) acting++;
    fired.push(c);
  }

  return { fired, blocked, deferred };
}
