// Which of a flow's rules cannot fire given what the board is currently allowed to
// observe. Arming warns and names them rather than refusing: a flow with one dead
// rule and three live ones is still worth arming, and silence is how a user ends up
// waiting forever on something that can never happen.
import { Condition, condIncomplete, Flow, isSettled } from "./model";

/** The Deck toggles and forge fact a condition can depend on. */
export interface SourceState {
  liveSignal: boolean;
  prFacts: boolean;
  /** What the configured forge can answer. Plain data, deliberately: this module
   *  is bundled into the webview and must not import `../forge/`. Absent means a
   *  fully capable forge — which is GitHub, the default — so every pre-existing
   *  caller keeps its meaning. */
  forge?: { changesRequested: boolean };
}

export interface UnfirableRule {
  edgeId: string;
  /** `unset-parameter` is the one reason here that is not about a toggle: the
   * rule's own condition names a blank branch, repo or status, so no setting the
   * user could turn on would let it fire. See `condIncomplete` (model.ts), which
   * is also what marks the field in the inspector while the blank is being made
   * — one predicate, so the panel and the arm warning cannot disagree about
   * which rules are dead. */
  needs: "live-signal" | "pr-facts" | "forge-unsupported" | "unset-parameter";
  /** The condition, in the words the drawer uses. */
  label: string;
}

/** Conditions that read transcript-derived session activity. With the Live signal
 * off, every activity is `unknown`, which neither of these can ever satisfy.
 * `no-agent-left` is deliberately absent: it counts sessions in the registry,
 * which is populated whether or not any transcript is read. */
const NEEDS_LIVE = new Set<Condition["kind"]>(["agent-ended-turn", "agent-idle-over"]);

/** Conditions that read a pull request. With PR facts off, `prs` is `{}` for every
 * run, so all of these read a missing entry and stay false forever.
 *
 * `branch-ci-passed` reads no pull request at all, and belongs here anyway: the
 * toggle governs the forge path, not the PR shape. `deckView.ts` gates its branch-CI
 * fetch on the same `forgeReady()` every PR fetch goes through — which folds in the
 * `agentFlow.prFacts` setting AND the configured forge's own `probe()` (`gh auth
 * status` / `glab auth status`) — so with PR facts off `CondContext.branchCi` is
 * empty for every pass, every verdict reads `"unknown"`, and a rule of this kind
 * waits forever. Named here so arming SAYS so. */
const NEEDS_PR = new Set<Condition["kind"]>([
  "pr-merged",
  "ci-passed",
  "ci-failed",
  "review-approved",
  "changes-requested",
  "threads-resolved",
  "pr-conflicting",
  "branch-ci-passed",
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
  "agent-ended-turn": "session ended its turn",
  "agent-idle-over": "session idle over…",
  "no-agent-left": "no sessions left",
  "tree-clean": "tree is clean",
  "has-uncommitted": "has uncommitted work",
  "nothing-to-push": "nothing to push",
  "ticket-done": "ticket reached done",
  "ticket-status-is": "ticket status is…",
  "branch-ci-passed": "branch CI passed…",
  // Present here only because this `Record` must cover every `Condition["kind"]`
  // to typecheck — NOT because this condition needs a toggle. It needs neither
  // PR facts nor the Live signal: its verdict comes from the command node's own
  // incoming edge, stamped straight onto the flow regardless of what the board
  // can currently observe (see `evaluate.ts`'s `commandSucceeded`). Deliberately
  // absent from both `NEEDS_LIVE` and `NEEDS_PR` below for that reason.
  "command-succeeded": "the command succeeded",
  // Same reason and same absence from NEEDS_LIVE/NEEDS_PR below as
  // command-succeeded above: a gate's verdict comes from its own incoming
  // edge (`gateAnswer`), not from any toggleable signal.
  "gate-approved": "you approved",
  "gate-rejected": "you rejected",
  // Same reason and same absence from NEEDS_LIVE/NEEDS_PR as the three above:
  // answered off a sibling edge's `expiredAt`, never off a toggleable signal.
  "deadline-passed": "a deadline here passed",
  // Answered from the command's journaled output, host-side — no toggle governs
  // it, so absent from NEEDS_LIVE/NEEDS_PR like `command-succeeded`. The
  // trailing ellipsis is the drawer's own mark for "carries a parameter"; the
  // blank-text case is `condIncomplete`'s, reported as `unset-parameter`.
  "command-printed": "the command printed…",
  // Same channel as `command-printed`; the blank-field case is `condIncomplete`'s.
  "command-result": "the command reported…",
  // Answered off the child flow's own file — no toggle governs it either.
  "subflow-done": "the subflow finished",
};

export function unfirableRules(flow: Flow, sources: SourceState): UnfirableRule[] {
  const out: UnfirableRule[] = [];
  for (const e of flow.edges) {
    // A settled edge is not waiting on anything. `isSettled` — the same notion
    // `evaluate.ts` skips on — rather than `firedAt` alone: an edge carrying an
    // `error` will never be evaluated again either, so naming it here would blame
    // a toggle for a rule whose real reason is a failure the drawer already shows.
    if (isSettled(e)) continue;
    const label = LABEL[e.cond.kind];
    // Checked BEFORE every toggle reason, because it outranks them: a rule
    // waiting on a blank status cannot fire with PR facts and the Live signal
    // both on, so blaming a toggle for it would send the user to fix the one
    // thing that would not help. Every branch here is an `else if` chain that
    // reports one reason per edge, and this is the reason that is actually
    // actionable when it applies.
    if (condIncomplete(e.cond) !== undefined) out.push({ edgeId: e.id, needs: "unset-parameter", label });
    else if (!sources.prFacts && NEEDS_PR.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "pr-facts", label });
    // Ordered after pr-facts on purpose: with PR facts off, that is the bigger and
    // more actionable reason, and reporting both for one edge would list the same
    // rule in the warning twice.
    else if (sources.forge?.changesRequested === false && e.cond.kind === "changes-requested") {
      out.push({ edgeId: e.id, needs: "forge-unsupported", label });
    }
    else if (!sources.liveSignal && NEEDS_LIVE.has(e.cond.kind)) out.push({ edgeId: e.id, needs: "live-signal", label });
  }
  return out;
}
