import { AgentState, DeckColumn, PrEntryMap } from "../types";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  ticketStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean; // an open, non-draft PR exists
  prBlocked?: boolean; // a PR needs a human decision: CI, changes requested, or a conflict
  prReady?: boolean; // every open PR approved, clean and green — nothing left to look at
}

function isReviewStatus(name?: string | null): boolean {
  return !!name && /review|qa|verif/i.test(name);
}

/**
 * Decide which board column a run belongs in. Precedence, most-decisive first:
 *   "waiting on a human" (the agent's needs-you signal, a stalled or exited
 *   agent, or a blocked PR) → ready to merge → the live "working" signal →
 *   review (an open PR / Jira review status) → else "progress" as the in-flight
 *   catch-all.
 *
 * Nothing routes to a finished column, because there isn't one: a merged run or a
 * done ticket leaves the board entirely (`shelfFor`). Neither `prMerged` nor
 * `ticketCategory` is read here at all — a run that reaches this function is one
 * the board still holds, and for those two the answer would always be the same.
 *
 * Three rungs are worth spelling out. A **blocked PR outranks a working agent**:
 * an agent cannot know CI failed until something tells it, so the card belongs
 * where you will see it, green dot and all. **Ready to merge outranks a working
 * agent** for the mirror-image reason — `ready` and `blocked` are the two sides
 * of the same PR read, and the merge is the one action on this board you can
 * finish in five seconds. It must not hide behind an agent doing follow-up work
 * in a run whose PR is already approved and green. A working agent still
 * outranks the *review stage*, so an agent addressing feedback reads as In
 * progress rather than parked in Review.
 *
 * Lives here rather than in status.ts so `src/webview/deckCards.ts` can import it:
 * status.ts reaches for git, the transcript and paths, none of which exist in a
 * browser bundle. Keep this file free of `fs`-touching imports — bucket.test.ts
 * enforces it.
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  // stalled and exited join needs-you here: all three mean a human has to do
  // something, and all three used to arrive as "idle" and land in progress.
  if (i.agentState === "needs-you" || i.agentState === "stalled" || i.agentState === "exited" || i.prBlocked) {
    return "needs";
  }
  if (i.prReady) return "merge";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.ticketStatus)) return "review";
  return "progress";
}

/** What a run's PRs say, reduced across every repo it touches. */
export interface PrSignals {
  open: boolean;
  blocked: boolean;
  ready: boolean;
}

/**
 * Reduce a run's per-repo PR entries to the booleans the ladder needs, each the
 * worst state across the run. `blocked` only considers OPEN PRs — a closed PR's
 * stale red checks must not pin a card in Needs you forever.
 *
 * There is deliberately no `merged` here. "Did this run land" is `landed()` in
 * visibility.ts, which the board's membership rule and the retire sweep both
 * call, and which must mean exactly one thing; a second reduction saying nearly
 * the same over the same map is how those two come apart.
 *
 * `ready` is the mirror image of `blocked` and deliberately stricter: every open
 * PR approved, mergeable clean, and nothing red or still running. Where `blocked`
 * forgives an advisory failure — a flaky optional check is not worth pinning a
 * card in Action required — `ready` does not, because it promises there is
 * nothing left to look at before you press merge. It needs an open PR to be true
 * at all: a merged run has nothing left to merge, and a run with no PR has
 * nothing to be ready about. Pure.
 */
export function prSignals(prs: PrEntryMap): PrSignals {
  const all = Object.values(prs)
    .map((e) => e.facts)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (all.length === 0) return { open: false, blocked: false, ready: false };
  const openPrs = all.filter((f) => f.state === "OPEN" && !f.isDraft);
  const blocked = all.some(
    (f) =>
      f.state === "OPEN" &&
      ((f.ci.failing.length > 0 && !f.ciAdvisory) || f.review === "changes_requested" || f.mergeable === "conflicting"),
  );
  const ready =
    openPrs.length > 0 &&
    openPrs.every(
      (f) => f.review === "approved" && f.mergeable === "clean" && f.ci.failing.length === 0 && f.ci.pending === 0,
    );
  return { open: openPrs.length > 0, blocked, ready };
}
