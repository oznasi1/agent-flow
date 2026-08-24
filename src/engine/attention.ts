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
  /** What to call this candidate out loud, when the key is not a name.
   *
   * `key` stays the identity — the announcement latch, the badge count, every
   * comparison. This is display text and nothing else, and the toast reads
   * `label ?? key`, so a producer that sets nothing keeps the released wording.
   *
   * It exists because only SOME keys are names. A task run's key IS its ticket
   * key, which is exactly what the notification should say; a local card's is
   * `localKey`'s slug + sha1, so without this the first toast anyone with an
   * unclaimed Claude Code session ever sees reads
   * "local-agent-flow-3f2a91bc is waiting on you". `attentionLabel` below is the
   * rule both producers use. */
  label?: string;
  agentState: AgentState;
  prs: PrEntryMap;
  ticketStatus: string | null;
  hasLiveSession: boolean;
  justLaunched: boolean;
  hasWorkToLose: boolean;
  /** `agentFlow.inflightShowAll` — puts every run on the board unconditionally. */
  showAll: boolean;
}

/**
 * The name to say out loud for a run, given the ticket key its caller resolved.
 *
 * A run that has a ticket announces its ticket key — "BITE-42 is waiting on
 * you", which is what the design doc promises and what the Deck's own card says
 * in its head. Everything else announces its summary, because everything else
 * keys off a generated string: Explore and Notepad slugs, and a local card's
 * `local-<slug>-<sha1>`. A hash is an identity, not a name, and a notification
 * naming one tells the reader nothing about which window to go to.
 *
 * `ticketKey` rather than `run.key` for the ticket case: a local card promoted
 * with **Track it** keeps its place-hash key and carries the ticket only in its
 * url, so the caller that has a connector (`ticketKeyFor`) resolves a real key
 * where a caller reading raw records can only pass `run.key` through.
 */
export function attentionLabel(run: Pick<Run, "key" | "summary" | "url" | "kind">, ticketKey: string): string {
  return isTicketRun(run as Run) ? ticketKey : run.summary;
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
 * Is this announcement record the one already on disk?
 *
 * The latch is level-triggered, so on almost every pass `nextAnnouncements`
 * returns the record it was handed with nothing added and nothing pruned — the
 * same keys carrying the same stamps. Writing that back costs an mkdir, a write
 * and a rename in ~/.agentflow every 12 seconds in every focused window, forever,
 * to produce a byte-identical file. Compared field by field rather than by
 * serializing both: key ORDER differs between a freshly-built record and a parsed
 * one, and JSON.stringify would call that a change.
 */
export function sameAnnounced(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
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
