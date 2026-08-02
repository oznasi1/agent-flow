import { AgentActivity, AgentState, CardAgent, DeckColumn, Run, RunStatus, PrEntryMap } from "../types";
import { gitState } from "./git";
import { runTarget } from "./runs";
import { readAgentActivity, UNKNOWN_ACTIVITY } from "./transcript";
import { canon } from "./paths";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  jiraCategory?: string | null; // "new" | "indeterminate" | "done"
  jiraStatus?: string | null; // status name, e.g. "In Review"
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
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.prMerged || i.jiraCategory === "done") return "done";
  if (i.agentState === "needs-you" || i.prBlocked) return "needs";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.jiraStatus)) return "review";
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

// needs-you outranks working: deriveBucket's ladder tests needs-you first, and
// with the old order it never saw one — any working session in the run buried
// the agent that was actually waiting on a human.
const STATE_RANK: Record<AgentState, number> = { "needs-you": 3, working: 2, idle: 1, unknown: 0 };

/** The liveliest agent across a run's repos — a multi-repo task's session may live
 * in any of them. Ties broken by most-recent activity. Pure. */
export function mostActive(activities: AgentActivity[]): AgentActivity {
  if (activities.length === 0) return UNKNOWN_ACTIVITY;
  return [...activities].sort((a, b) => {
    const byRank = STATE_RANK[b.state] - STATE_RANK[a.state];
    if (byRank !== 0) return byRank;
    return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
  })[0];
}

export interface JiraInfo {
  status: string | null;
  category: string | null;
}

/** Inputs to `buildRunStatus`, gathered in one place now that the function reads
 * from git, Jira, the transcript, PR facts, presence, and open sessions. */
export interface BuildRunStatusInput {
  run: Run;
  jira: JiraInfo | null;
  projectsRoot: string;
  nowMs: number;
  /** Off → no transcript is read and every agent reads as unknown. */
  liveSignal?: boolean;
  openIdentities?: ReadonlySet<string>;
  prs?: PrEntryMap;
  /** Open sessions in this run's directories. */
  agents?: CardAgent[];
}

/** Reconcile a durable Run with every observable source into the status a card
 * renders. `liveSignal` off (or no transcript) leaves the git + Jira backbone. */
export function buildRunStatus(i: BuildRunStatusInput): RunStatus {
  const { run, jira, projectsRoot, nowMs } = i;
  const liveSignal = i.liveSignal ?? true;
  const agents = i.agents ?? [];
  const prs = i.prs ?? {};
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  // The union of both readings. An open session is exact — addressed by its own
  // sessionId, so two in one worktree report two states — and the per-repo read
  // covers a repo with no session open, which is what stops a tracked card whose
  // agent has since exited from dropping to parked.
  const agent = liveSignal
    ? mostActive([
        ...agents.map((a) => a.activity),
        ...run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
      ])
    : UNKNOWN_ACTIVITY;
  const pr = prSignals(prs);
  const column = deriveBucket({
    jiraCategory: jira?.category ?? null,
    jiraStatus: jira?.status ?? null,
    agentState: agent.state,
    prOpen: pr.open,
    prBlocked: pr.blocked,
    prMerged: pr.merged,
  });
  const target = runTarget(run);
  const windowOpen = target ? (i.openIdentities ?? new Set<string>()).has(canon(target)) : false;
  return {
    run,
    column,
    jiraStatus: jira?.status ?? null,
    jiraCategory: jira?.category ?? null,
    repos,
    agent,
    windowOpen,
    prs,
    agents,
  };
}
