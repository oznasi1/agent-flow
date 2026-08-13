import { PrEntryMap, RepoGit, Run, isTicketRun } from "../types";
import { landed } from "./visibility";

/** Why a run was retired. Reaches the log, never the user. */
export type RetireReason = "unreachable" | "finished" | "abandoned";

/** What the sweep should do with one run this pass. `stamp` and `unstamp` are
 * writes to the record, not deletions: they only move `finishedAt`, which is how
 * the finished window is timed across panel reloads. */
export type RetireVerdict =
  | { action: "keep" }
  | { action: "stamp"; finishedAt: number }
  | { action: "unstamp" }
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

  // Somebody is working in here. Clear any stamp: a window that started while
  // the run sat idle should not keep running once you reopen an agent in it.
  if (i.hasLiveSession) return stamped !== null ? { action: "unstamp" } : { action: "keep" };

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
