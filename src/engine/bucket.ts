import { AgentState, DeckColumn, DeckLane, PrEntryMap } from "../types";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  ticketCategory?: string | null; // "new" | "indeterminate" | "done"
  ticketStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean; // an open, non-draft PR exists
  prBlocked?: boolean; // a PR needs a human decision: CI, changes requested, or a conflict
  prMerged?: boolean; // every PR-bearing repo has merged
}

function isReviewStatus(name?: string | null): boolean {
  return !!name && /review|qa|verif/i.test(name);
}

/**
 * Decide which board column a run belongs in. Precedence, most-decisive first:
 *   done (a merged PR, or Jira done) → "waiting on a human" (the agent's needs-you
 *   signal, a stalled or exited agent, or a blocked PR) → the live "working"
 *   signal → review (an open PR /
 *   Jira review status) → else "progress" as the in-flight catch-all.
 *
 * Two rungs are worth spelling out. A **blocked PR outranks a working agent**: an
 * agent cannot know CI failed until something tells it, so the card belongs where
 * you will see it, green dot and all. A working agent still outranks the *review
 * stage*, so an agent addressing feedback reads as In progress rather than parked
 * in Review.
 *
 * Lives here rather than in status.ts so `src/webview/deckCards.ts` can import it:
 * status.ts reaches for git, the transcript and paths, none of which exist in a
 * browser bundle. Keep this file free of `fs`-touching imports — bucket.test.ts
 * enforces it.
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.prMerged || i.ticketCategory === "done") return "done";
  // stalled and exited join needs-you here: all three mean a human has to do
  // something, and all three used to arrive as "idle" and land in progress.
  if (i.agentState === "needs-you" || i.agentState === "stalled" || i.agentState === "exited" || i.prBlocked) {
    return "needs";
  }
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.ticketStatus)) return "review";
  return "progress";
}

/** What a run's PRs say, reduced across every repo it touches. */
export interface PrSignals {
  open: boolean;
  blocked: boolean;
  merged: boolean;
  ready: boolean;
}

/**
 * Reduce a run's per-repo PR entries to the booleans the ladder and the lanes
 * need, each the worst state across the run. `blocked` only considers OPEN PRs —
 * a closed PR's stale red checks must not pin a card in Needs you forever.
 * `merged` needs *every* PR-bearing repo: a run whose backend landed and whose
 * frontend has not is not done.
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
  if (all.length === 0) return { open: false, blocked: false, merged: false, ready: false };
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
  return { open: openPrs.length > 0, blocked, merged: all.every((f) => f.state === "MERGED"), ready };
}

/**
 * Which band inside `column` a run belongs to, or null on a column that means one
 * thing. Reads the same signals the column itself was derived from, so a lane can
 * never contradict the column above it.
 *
 * Done's second lane is `unmerged` rather than "closed without merge": a ticket
 * someone marked done with no PR at all lands there too, and it was never closed.
 */
export function deriveLane(column: DeckColumn, s: PrSignals): DeckLane | null {
  if (column === "review") return s.ready ? "ready" : "waiting";
  if (column === "done") return s.merged ? "merged" : "unmerged";
  return null;
}
