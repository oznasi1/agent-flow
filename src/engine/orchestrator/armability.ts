// Which of a flow's rules cannot fire given what the board is currently allowed to
// observe. Arming warns and names them rather than refusing: a flow with one dead
// rule and three live ones is still worth arming, and silence is how a user ends up
// waiting forever on something that can never happen.
import { Condition, Flow } from "./model";

/** The two Deck toggles a condition can depend on. */
export interface SourceState {
  liveSignal: boolean;
  prFacts: boolean;
}

export interface UnfirableRule {
  edgeId: string;
  needs: "live-signal" | "pr-facts";
  /** The condition, in the words the drawer uses. */
  label: string;
}

/** Conditions that read transcript-derived agent activity. With the Live signal
 * off, every activity is `unknown`, which neither of these can ever satisfy.
 * `no-agent-left` is deliberately absent: it counts sessions in the registry,
 * which is populated whether or not any transcript is read. */
const NEEDS_LIVE = new Set<Condition["kind"]>(["agent-ended-turn", "agent-idle-over"]);

/** Conditions that read a pull request. With PR facts off, `prs` is `{}` for every
 * run, so all of these read a missing entry and stay false forever. */
const NEEDS_PR = new Set<Condition["kind"]>([
  "pr-merged",
  "ci-passed",
  "ci-failed",
  "review-approved",
  "changes-requested",
  "threads-resolved",
  "pr-conflicting",
]);

/** The drawer's own wording, kept here so the warning reads like the rule does.
 * Deliberately a plain record rather than an import from the webview: this module
 * must stay free of anything a browser bundle cannot take. */
const LABEL: Record<Condition["kind"], string> = {
  "pr-merged": "PR is merged",
  "ci-passed": "CI passed",
  "ci-failed": "CI failed",
  "review-approved": "review approved",
  "changes-requested": "changes requested",
  "threads-resolved": "0 unresolved threads",
  "pr-conflicting": "branch conflicts",
  "agent-ended-turn": "agent ended its turn",
  "agent-idle-over": "agent idle over…",
  "no-agent-left": "no agent left",
  "tree-clean": "tree is clean",
  "has-uncommitted": "has uncommitted work",
  "nothing-to-push": "nothing to push",
  "ticket-done": "ticket reached done",
  "ticket-status-is": "ticket status is…",
};

export function unfirableRules(flow: Flow, sources: SourceState): UnfirableRule[] {
  const out: UnfirableRule[] = [];
  for (const e of flow.edges) {
    // An edge that already fired is not waiting on anything.
    if (e.firedAt !== undefined) continue;
    const label = LABEL[e.cond.kind];
    if (!sources.prFacts && NEEDS_PR.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "pr-facts", label });
    else if (!sources.liveSignal && NEEDS_LIVE.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "live-signal", label });
  }
  return out;
}
