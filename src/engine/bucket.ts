import { AgentState, DeckColumn, PrEntryMap } from "../types";

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
 *   signal, or a blocked PR) → the live "working" signal → review (an open PR /
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
  if (i.agentState === "needs-you" || i.prBlocked) return "needs";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.ticketStatus)) return "review";
  return "progress";
}

/**
 * Reduce a run's per-repo PR entries to the three booleans the ladder needs, each
 * the worst state across the run. `blocked` only considers OPEN PRs — a closed
 * PR's stale red checks must not pin a card in Needs you forever. `merged` needs
 * *every* PR-bearing repo: a run whose backend landed and whose frontend has not
 * is not done. Pure.
 */
export function prSignals(prs: PrEntryMap): { open: boolean; blocked: boolean; merged: boolean } {
  const all = Object.values(prs)
    .map((e) => e.facts)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  if (all.length === 0) return { open: false, blocked: false, merged: false };
  const open = all.some((f) => f.state === "OPEN" && !f.isDraft);
  const blocked = all.some(
    (f) =>
      f.state === "OPEN" &&
      ((f.ci.failing.length > 0 && !f.ciAdvisory) || f.review === "changes_requested" || f.mergeable === "conflicting"),
  );
  return { open, blocked, merged: all.every((f) => f.state === "MERGED") };
}
