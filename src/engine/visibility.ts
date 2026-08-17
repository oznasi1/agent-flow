import { PrEntryMap, PrFacts, Shelf } from "../types";

/**
 * Has this run's work landed? Either every PR-bearing repo merged, or the ticket
 * is done and no PR is still open. `state === "OPEN"` deliberately rather than
 * `prSignals().open`, which excludes drafts: a draft PR is unmerged work.
 *
 * Lifted out of retire.ts so the board rule and the retire sweep cannot drift
 * apart — "landed" must mean one thing.
 */
export function landed(prs: PrEntryMap, ticketCategory: string | null): boolean {
  const all = Object.values(prs)
    .map((e) => e.facts)
    .filter((f): f is PrFacts => f !== null);
  if (all.length > 0 && all.every((f) => f.state === "MERGED")) return true;
  return ticketCategory === "done" && !all.some((f) => f.state === "OPEN");
}

/** Every field observable, none required. */
export interface VisibilityInput {
  /** A Claude Code session open in a path this run OWNS. Ownership-scoped on
   * purpose — see the note in retire.ts about why the retire veto is not. */
  hasLiveSession: boolean;
  /** Any PR still OPEN, draft included: a draft is unmerged work in flight. */
  prOpen: boolean;
  /** A ticket run whose category is not "done". */
  ticketActive: boolean;
  /** dirty || ahead > 0, counted on OWNED paths only. Without the ownership
   * scope, one dirty checkout shared by four notepad runs reads as live work on
   * all four and nothing ever leaves the board. */
  hasWorkToLose: boolean;
}

/**
 * Board or strip. Any single signal of live work is enough — this decides
 * *membership* only. `deriveBucket` still decides which of the four columns a
 * board card lands in.
 *
 * `landed()` above is deliberately NOT one of these signals. The board has no
 * finished column to hold landed work in: a merged run, and a ticket someone
 * marked done, go straight to the Recently closed strip, which offers the only
 * two things left to do with them (reopen, forget). The strip is where they wait
 * out the retire sweep's grace window.
 *
 * Landing still does not *always* close a run, and that is the point of listing
 * the signals separately: a merged PR whose ticket nobody has moved yet keeps
 * `ticketActive`, and an agent still open in the worktree keeps `hasLiveSession`.
 * Both are live work that happens to sit behind a merge.
 *
 * Keep this file free of `fs`-touching imports — visibility.test.ts enforces it.
 */
export function shelfFor(i: VisibilityInput): Shelf {
  return i.hasLiveSession || i.prOpen || i.ticketActive || i.hasWorkToLose ? "board" : "closed";
}
