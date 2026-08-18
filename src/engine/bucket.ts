import { AgentState, DeckColumn, DeckLane, PrEntryMap } from "../types";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  ticketStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean; // an open, non-draft PR exists
  prBlocked?: boolean; // a PR needs a human decision: CI, changes requested, or a conflict
  prReady?: boolean; // every open PR approved, clean and green — nothing left to look at
  prMerged?: boolean; // every PR-bearing repo has merged
}

function isReviewStatus(name?: string | null): boolean {
  return !!name && /review|qa|verif/i.test(name);
}

/**
 * Decide which board column a run belongs in. Precedence, most-decisive first:
 *   the landed merge → "waiting on a human" (the agent's needs-you signal, a
 *   stalled or exited agent, or a blocked PR) → the merge you have yet to press
 *   → the live "working" signal → review (an open PR / Jira review status) → else
 *   "progress" as the in-flight catch-all.
 *
 * `ticketCategory` is not read here at all. A done ticket that never merged has
 * left the board before this function sees it (`shelfFor`), and one still on the
 * board — an agent open in it, a PR yet to land — deserves the column its live
 * signals say rather than a column named after somebody closing a tab.
 *
 * Three rungs are worth spelling out. A **landed merge outranks everything**,
 * `needs` included. `prMerged` is a fact read from GitHub; every agent state is a
 * reading of a transcript that nothing invalidates once the work lands, so a
 * question asked before the merge sits there unanswered forever — pinning a
 * shipped run in Action required for as long as the card lives. The merge is the
 * answer. A landed run keeps its card, in the merge column's `merged` lane,
 * until the retire sweep takes it: there is still a wrap-up to do (move the
 * ticket, delete the branch, watch the deploy).
 *
 * A **blocked PR outranks a working agent**: an agent cannot know CI failed
 * until something tells it, so the card belongs where you will see it, green dot
 * and all. **The merge you have yet to press outranks a working agent** for the
 * mirror-image reason — `ready` and `blocked` are the two sides of the same PR
 * read, and the merge is the one action on this board you can finish in five
 * seconds. It must not hide behind an agent doing follow-up work in a run whose
 * PR is already approved and green. A working agent still outranks the *review
 * stage*, so an agent addressing feedback reads as In progress rather than
 * parked in Review.
 *
 * What `ready` does NOT outrank is `needs`. Approved and green is not landed:
 * the work is still in flight, so an agent that ended its turn asking something
 * is the more urgent of the two. Only the merge itself settles that.
 *
 * `prMerged` sitting above `prBlocked` is inert rather than a policy: `blocked`
 * requires an OPEN PR and `merged` requires every PR merged, so neither input
 * can be true alongside the other.
 *
 * Lives here rather than in status.ts so `src/webview/deckCards.ts` can import it:
 * status.ts reaches for git, the transcript and paths, none of which exist in a
 * browser bundle. Keep this file free of `fs`-touching imports — bucket.test.ts
 * enforces it.
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.prMerged) return "merge";
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
  merged: boolean;
}

/**
 * Reduce a run's per-repo PR entries to the booleans the ladder needs, each the
 * worst state across the run. `blocked` only considers OPEN PRs — a closed PR's
 * stale red checks must not pin a card in Needs you forever.
 *
 * `merged` needs *every* PR-bearing repo: a run whose backend landed and whose
 * frontend has not has not landed. It is deliberately narrower than `landed()`
 * in visibility.ts, which also counts a done ticket with no PR open — that run
 * produced no merge, so it has no merge column and no wrap-up to sit through.
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
  if (all.length === 0) return { open: false, blocked: false, ready: false, merged: false };
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
  return { open: openPrs.length > 0, blocked, ready, merged: all.every((f) => f.state === "MERGED") };
}

/**
 * Which band inside `column` a run belongs to, or null on a column that means one
 * thing. Reads the same signals the column itself was derived from, so a lane can
 * never contradict the column above it.
 *
 * `merged` is tested rather than `ready`, and the fallback is `ready`: the merge
 * column is reachable on either signal, and `prSignals.ready` is false once a PR
 * has merged — asking "is it ready" first would send every landed run to the
 * wrong lane.
 */
export function deriveLane(column: DeckColumn, s: PrSignals): DeckLane | null {
  if (column !== "merge") return null;
  return s.merged ? "merged" : "ready";
}
