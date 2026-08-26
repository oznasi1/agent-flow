import { AgentState, DeckColumn, DeckLane, PrEntryMap, PrFacts } from "../types";

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
 *   the landed merge → an agent waiting on you (needs-you, stalled, exited) → a
 *   blocked PR → the merge you have yet to press → the live "working" signal →
 *   review (an open PR / Jira review status) → else "progress" as the in-flight
 *   catch-all.
 *
 * `needs` is agent-driven and nothing else: the column means a session stopped
 * and wants you. A PR that needs a human is the review column's business, in its
 * `fixes` lane — the two used to share a column, which put "Claude is asking you
 * something" and "GitHub is asking you something" under one header.
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
 * and all — which is why In review can hold a live agent, and why its rung sits
 * where it does rather than below `working`. Its own rung is also what catches a
 * blocked *draft*: `prSignals.blocked` counts drafts and `prSignals.open` does
 * not, so the `prOpen` rung below would let a red draft fall through to progress.
 * **The merge you have yet to press outranks a working agent** for the
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
  if (i.agentState === "needs-you" || i.agentState === "stalled" || i.agentState === "exited") {
    return "needs";
  }
  // Same rung a blocked PR always held — above the merge you have yet to press,
  // above the live agent — pointed at the column that owns PR trouble. `prOpen`
  // below would miss a red *draft*: prSignals.blocked counts drafts, .open does
  // not, so without this the draft falls all the way to progress's parked lane.
  if (i.prBlocked) return "review";
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
 * The repos whose PR state this run could not read, sorted.
 *
 * `PrEntry.error` means the last fetch attempt failed — the CLI is missing, the
 * account cannot see the repo, the network was down. `facts` is then the PREVIOUS
 * value carried forward, or null when there never was one, and BOTH shapes lie to
 * a reader that does not check `error`:
 *
 *  - `facts: null` is indistinguishable from a repo that genuinely has no PR, so
 *    every reduction here reads it as "nothing open" — which is how a landed run
 *    stayed pinned in Action required, `prSignals.merged` never able to go true.
 *  - stale facts are worse than absent ones: the card draws `#863 ✓ ci approved`
 *    about a PR that may have merged an hour ago.
 *
 * So both count as unread. `mergeTarget` already refuses such an entry on the
 * same reasoning — unreadable is not merged, and stale facts do not authorize a
 * write however green they look. This is that rule pointed at what the card SAYS
 * rather than what it lets you press.
 *
 * Sorted because `Object.entries` follows insertion order, which the host does
 * not promise: an unsorted list would reshuffle a card's tooltip between renders.
 * Deliberately NOT a field on `PrSignals` — that reduction drops null-facts
 * entries before it counts anything, and those are half the cases here. Pure.
 */
export function unreadRepos(prs: PrEntryMap): string[] {
  return Object.entries(prs)
    .filter(([, e]) => e.error === true)
    .map(([repo]) => repo)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Which band inside `column` a run belongs to, or null on `needs`, the column
 * that means one thing. Reads the same signals the column itself was derived
 * from, so a lane can never contradict the column above it.
 *
 * Every laned column must answer for every route into it: DeckApp renders a
 * laned column entirely out of its lanes, so a null here would drop the card off
 * the board rather than merely mis-file it. Hence the fallbacks below are
 * fallbacks and not `null` — `agentState` is optional because an agentless run
 * reaches this through `laneOf` with nothing but the run's own reduction, and
 * that run is parked by definition.
 *
 * `merged` is tested rather than `ready`, and the fallback is `ready`: the merge
 * column is reachable on either signal, and `prSignals.ready` is false once a PR
 * has merged — asking "is it ready" first would send every landed run to the
 * wrong lane.
 */
export function deriveLane(column: DeckColumn, s: PrSignals, agentState?: AgentState): DeckLane | null {
  if (column === "progress") return agentState === "working" ? "working" : "parked";
  // Not `s.open && s.blocked`: `blocked` already requires an open PR of its own,
  // and a card can reach review off a Jira status with no PR at all — that one
  // has nothing to fix and waits.
  if (column === "review") return s.blocked ? "fixes" : "waiting";
  if (column === "merge") return s.merged ? "merged" : "ready";
  return null;
}

/** The one PR a card may merge, named for the host that will do the merging. */
export interface MergeTarget {
  repo: string; // the PrEntryMap key — how the host finds the checkout
  number: number;
  url: string; // for the failure toast's "Open PR" action
}

/** Is every fact standing between this PR and its base branch green AND readable?
 *
 * Deliberately stricter than `prSignals.ready`, in two ways that matter:
 *
 *  - `unresolved === 0`, so `null` — the GraphQL/discussions call failed or was
 *    skipped — withholds the button. That is the exact case where "no comments
 *    open" is unproven, and it is the fact `ready` does not read at all.
 *  - No forgiveness for `ciAdvisory`. `prSignals.blocked` forgives a flaky
 *    optional check because it is not worth pinning a card in Action required;
 *    this cannot, because the button promises there is nothing left to look at.
 *
 * Every unknown fails, matching the rule `branchCi` already states for itself:
 * "unknown" is NOT green. `review === "none"` fails too — on GitHub it covers
 * both "no reviewers required" and "nobody has reviewed yet", and `PrFacts`
 * cannot tell them apart, so treating it as approved would put a Merge button on
 * an unreviewed PR.
 */
function isMergeReady(f: PrFacts): boolean {
  return (
    f.state === "OPEN" &&
    !f.isDraft &&
    f.ci.failing.length === 0 &&
    f.ci.pending === 0 &&
    f.review === "approved" &&
    f.unresolved === 0 &&
    f.mergeable === "clean"
  );
}

/**
 * The single PR this run can merge right now, or null.
 *
 * `prSignals.ready` is NOT reused: it drives column placement, so tightening it
 * would move existing users' cards between columns on upgrade. The two are
 * allowed to disagree — a card can sit in the Merge column's `ready` lane with
 * no Merge button (unreadable review threads, say). That is the honest pair: the
 * lane says "nothing looks wrong", the button says "I can prove nothing is wrong".
 *
 * Exactly ONE ready PR, and every other PR-bearing repo already merged. Not a
 * "lead PR" like `cardActions` picks: that function's buttons only seed a
 * session, so an arbitrary choice among several is harmless, whereas merging one
 * half of a coupled pair of PRs on a single click is the specific mistake worth
 * designing out. A card with two ready PRs therefore gets nothing.
 *
 * An entry whose last fetch failed (`error: true`) is refused outright, and on
 * BOTH sides of the test: such an entry cannot be the candidate, and it cannot be
 * one of the already-merged siblings either. Its facts are the PREVIOUS value
 * carried forward, so a sibling whose fetches are failing can go on saying MERGED
 * about a first PR while a second, coupled one sits open and unread — which is the
 * exact pair this function exists to refuse. Stale facts do not authorize a write
 * however green they look. Pure.
 */
export function mergeTarget(prs: PrEntryMap): MergeTarget | null {
  const withFacts = Object.entries(prs)
    .map(([repo, e]) => ({ repo, facts: e.facts, failed: e.error === true }))
    .filter((x): x is { repo: string; facts: PrFacts; failed: boolean } => x.facts !== null);
  const ready = withFacts.filter((x) => !x.failed && isMergeReady(x.facts));
  // `!== 1` covers both "nothing to merge" and "two, and picking is not ours".
  if (ready.length !== 1) return null;
  const rest = withFacts.filter((x) => x.repo !== ready[0].repo);
  // `!x.failed` here as well as in `ready` above: a sibling whose last fetch failed
  // is carrying forward whatever it said before, and "it said MERGED an hour ago"
  // is not "it is merged". Unreadable is not merged, the same way unreadable is not
  // green in `isMergeReady`.
  if (!rest.every((x) => !x.failed && x.facts.state === "MERGED")) return null;
  return { repo: ready[0].repo, number: ready[0].facts.number, url: ready[0].facts.url };
}
