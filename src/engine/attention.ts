// What "Action required" means, in one place. The Deck's `buildAll` and the
// extension host's attention tick are its two input paths, so a badge can never
// disagree with the column it is counting.
//
// Keep this file importing nothing but `../types`, `./bucket` and `./visibility`
// — all three are leaves that touch no Node builtin. attention.test.ts asserts
// the specifier list.
import { AgentState, PrEntryMap, Run, isTicketRun, runKind } from "../types";
import { deriveBucket, prSignals } from "./bucket";
import { shelfFor } from "./visibility";

/** Everything the reduction needs about one run, and nothing it does not.
 *
 * `prOpen` and `merged` are deliberately NOT fields: `shelfFor`'s prOpen counts
 * drafts and `prSignals().open` does not, and a caller that has to remember
 * which is which is a caller that will get it wrong. Both are derived from
 * `prs` below.
 *
 * `ticketStatus` is carried and passed to `deriveBucket` even though nothing
 * above `needs` in its ladder reads it: the Deck supplies the real value, the
 * gatherer supplies null (Jira on the hidden path is forbidden), and a test
 * asserts the two can never diverge. */
export interface AttentionCandidate {
  key: string;
  agentState: AgentState;
  prs: PrEntryMap;
  ticketStatus: string | null;
  hasLiveSession: boolean;
  justLaunched: boolean;
  hasWorkToLose: boolean;
  /** `agentFlow.inflightShowAll` — puts every run on the board unconditionally. */
  showAll: boolean;
}

/** Does this run's dirty/ahead state count as work it would be a shame to lose?
 *
 * An in-place run — Explore or Notepad — opened your checkout rather than
 * creating a worktree, so its dirty state is your own work in progress far more
 * often than the session's, and ownership hands it to whichever record happens
 * to be newest. Counting it pinned such a card to the board for as long as the
 * checkout stayed dirty, which for a repo you work in is forever. Ticketless on
 * purpose: a task run launched in place (`agentFlow.worktree: "never"`) does own
 * its branch and keeps the veto. */
export function ownsWorkToLose(run: Run): boolean {
  const kind = runKind(run);
  return !((kind === "explore" || kind === "notepad") && !isTicketRun(run));
}

/** The keys of every candidate the Deck would draw in Action required, in the
 * order they were handed in. Keys rather than a count: the badge needs only
 * cardinality, but the toast needs to name what parked. */
export function attentionKeys(candidates: readonly AttentionCandidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const pr = prSignals(c.prs);
    const shelf = c.showAll
      ? "board"
      : shelfFor({
          hasLiveSession: c.hasLiveSession,
          // Drafts included — a draft PR is unmerged work in flight.
          prOpen: Object.values(c.prs).some((e) => e.facts?.state === "OPEN"),
          merged: pr.merged,
          justLaunched: c.justLaunched,
          hasWorkToLose: c.hasWorkToLose,
        });
    if (shelf !== "board") continue;
    const column = deriveBucket({
      ticketStatus: c.ticketStatus,
      agentState: c.agentState,
      prOpen: pr.open,
      prBlocked: pr.blocked,
      prReady: pr.ready,
      prMerged: pr.merged,
    });
    if (column === "needs") out.push(c.key);
  }
  return out;
}

/**
 * Which of `current` has not been announced yet, and the record to persist.
 *
 * Level-triggered, unlike the flow engine's `firedAt` (a permanent stamp cleared
 * only by Reset): a stamp survives exactly as long as its key stays in
 * `current`. So a run that parks, gets answered, and parks again is announced
 * twice — the second parking is new news — and the record prunes itself without
 * needing to be told which runs still exist.
 *
 * Pure and total: the caller owns reading and writing the record, and owns the
 * decision about whether this window is the one that gets to announce.
 */
export function nextAnnouncements(
  current: readonly string[],
  announced: Record<string, number>,
  nowMs: number,
): { toAnnounce: string[]; announced: Record<string, number> } {
  const live = new Set(current);
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(announced)) {
    if (live.has(key)) next[key] = at;
  }
  const toAnnounce = current.filter((key) => !(key in next));
  for (const key of toAnnounce) next[key] = nowMs;
  return { toAnnounce, announced: next };
}
