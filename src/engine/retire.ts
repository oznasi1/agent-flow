import { PrEntryMap, RepoGit, Run, Shelf, isTicketRun } from "../types";
import { landed } from "./visibility";

/** Why a run was retired. Reaches the log, never the user. */
export type RetireReason = "unreachable" | "finished" | "abandoned" | "closed";

/** What the sweep should do with one run this pass. The four stamp actions are
 * writes to the record, not deletions: they only move `finishedAt` / `closedAt`,
 * which is how each window is timed across panel reloads. */
export type RetireVerdict =
  | { action: "keep" }
  | { action: "stamp"; finishedAt: number }
  | { action: "unstamp" }
  | { action: "stampClosed"; closedAt: number }
  | { action: "unstampClosed" }
  | { action: "retire"; reason: RetireReason };

export interface RetireInput {
  run: Run;
  /** Live git state per repo, as `buildRunStatus` already computed it. The
   * source of the veto, and the reason the sweep runs after statuses are built. */
  repos: RepoGit[];
  ticketCategory: string | null;
  prs: PrEntryMap;
  /** Any Claude Code session open in one of this run's directories. */
  hasLiveSession: boolean;
  /** Is an empty `prs` trustworthy as "this run has no PR"? False when PR facts
   * are switched off, where empty means "never asked" — and the difference decides
   * whether rule 3 may fire at all. */
  prsAuthoritative: boolean;
  /** `agentFlow.retireFinishedAfterHours` in ms. 0 retires on sight. */
  finishedAfterMs: number;
  /** `agentFlow.retireAbandonedAfterDays` in ms. 0 disables rule 3. */
  abandonedAfterMs: number;
  /** Which shelf the board put this run on. Passed in rather than recomputed, so
   * exactly one place decides what "closed" means. Always "board" for a review
   * run, which never renders a card and keeps its pre-existing rules. */
  shelf: Shelf;
  /** `agentFlow.retireClosedAfterHours` in ms. 0 retires on sight. */
  closedAfterMs: number;
  nowMs: number;
  /** Injected rather than imported, so every rule is testable without a temp
   * directory — and so this module stays free of `fs`. */
  exists: (p: string) => boolean;
}

/**
 * What to do with one run. Three rules, every one of them requiring that no agent
 * is open in the run — see the design spec for the full rationale.
 *
 * The veto is the load-bearing safety property: a record is the only pointer back
 * to its worktree, so uncommitted or unpushed work blocks rules 2 and 3 outright.
 * Rule 1 is exempt because a directory that no longer exists has neither.
 *
 * Pure. Every filesystem question is asked through `exists`.
 */
export function retireVerdict(i: RetireInput): RetireVerdict {
  const stamped = typeof i.run.finishedAt === "number" ? i.run.finishedAt : null;
  const closedStamp = typeof i.run.closedAt === "number" ? i.run.closedAt : null;

  // Somebody is working in here. Clear any stamp: a window that started while
  // the run sat idle should not keep running once you reopen an agent in it.
  // `finishedAt` first, since rule 2 outranks 2b.
  if (i.hasLiveSession) {
    if (stamped !== null) return { action: "unstamp" };
    if (closedStamp !== null) return { action: "unstampClosed" };
    return { action: "keep" };
  }

  // Rule 1 — unreachable. `repos.length > 0` so a malformed record with no repos
  // is never vacuously "all gone", and `workspaceFile` is not consulted: several
  // runs share one, so its survival says nothing about any single run.
  if (i.run.repos.length > 0 && i.run.repos.every((r) => !i.exists(r.path))) {
    return { action: "retire", reason: "unreachable" };
  }

  const hasWorkToLose = i.repos.some((r) => r.dirty || r.ahead > 0);

  // Rule 2 — finished, after its grace window.
  if (landed(i.prs, i.ticketCategory) && !hasWorkToLose) {
    if (i.finishedAfterMs <= 0) return { action: "retire", reason: "finished" };
    if (stamped === null) return { action: "stamp", finishedAt: i.nowMs };
    if (i.nowMs - stamped >= i.finishedAfterMs) return { action: "retire", reason: "finished" };
    return { action: "keep" };
  }
  // No longer finished (a PR reopened, a ticket moved back, work appeared): the
  // window restarts from scratch next time rather than resuming mid-count.
  if (stamped !== null) return { action: "unstamp" };

  // Rule 2b — closed. No agent of its own, no PR, no active ticket, nothing to
  // lose. The dirty/ahead veto below rule 2 already guarantees `hasWorkToLose`
  // is false whenever the board shelved this run as closed, but the test is
  // repeated here rather than assumed: the two rules must not be coupled by an
  // invariant that lives in another file.
  if (i.shelf === "closed" && !hasWorkToLose) {
    if (i.closedAfterMs <= 0) return { action: "retire", reason: "closed" };
    if (closedStamp === null) return { action: "stampClosed", closedAt: i.nowMs };
    if (i.nowMs - closedStamp >= i.closedAfterMs) return { action: "retire", reason: "closed" };
    return { action: "keep" };
  }
  // Back on the board: the window restarts from scratch next time. Scoped to
  // "board" on purpose — a run the veto above just spared is still closed, and
  // dropping its stamp would erase the "closed 3h ago" the strip shows and
  // restart the window on every sweep.
  if (i.shelf === "board" && closedStamp !== null) return { action: "unstampClosed" };

  // Rule 3 — abandoned. Needs a trustworthy empty `prs`, or "no PR" is a guess.
  if (
    i.abandonedAfterMs > 0 &&
    i.prsAuthoritative &&
    i.nowMs - i.run.createdAt >= i.abandonedAfterMs &&
    !isTicketRun(i.run) &&
    Object.keys(i.prs).length === 0 &&
    !hasWorkToLose
  ) {
    return { action: "retire", reason: "abandoned" };
  }

  return { action: "keep" };
}
