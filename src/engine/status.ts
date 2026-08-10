import { AgentActivity, AgentState, CardAgent, Run, RunStatus, PrEntryMap, runKind } from "../types";
import { gitState } from "./git";
import { runTarget } from "./runs";
import { readAgentActivity, UNKNOWN_ACTIVITY } from "./transcript";
import { canon } from "./paths";
import { deriveBucket, prSignals } from "./bucket";

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

export interface TicketInfo {
  status: string | null;
  category: string | null;
}

/** Inputs to `buildRunStatus`, gathered in one place now that the function reads
 * from git, Jira, the transcript, PR facts, presence, and open sessions. */
export interface BuildRunStatusInput {
  run: Run;
  ticket: TicketInfo | null;
  projectsRoot: string;
  nowMs: number;
  openIdentities?: ReadonlySet<string>;
  prs?: PrEntryMap;
  /** Open sessions in this run's directories. */
  agents?: CardAgent[];
  /** Local-only: restricts the per-repo transcript read (the `readAgentActivity`
   * fallback below) to roots that actually have a live session. `run.repos` on a
   * grouped local card now carries every root of the workspace, sibling folders
   * included — a warm transcript in one a session merely exited from must not
   * hold the whole card in "ended turn" on a sibling's behalf. Absent for every
   * tracked run: this is shared code, and a tracked run's repos are all
   * genuinely its own regardless of whether an agent happens to be open in each
   * one right now — the default (every repo) keeps that path byte-identical. */
  activityRoots?: ReadonlySet<string>;
}

/** Reconcile a durable Run with every observable source into the status a card
 * renders. No transcript (unreadable or missing) leaves the git + Jira backbone. */
export function buildRunStatus(i: BuildRunStatusInput): RunStatus {
  const { run, ticket, projectsRoot, nowMs } = i;
  const agents = i.agents ?? [];
  const prs = i.prs ?? {};
  // A local card's `run.repos[].branch` was just read, in this same refresh tick,
  // by whatever inferred its ticket — handing it back to gitState here skips a
  // second `rev-parse` that could only repeat the same answer. A tracked run's
  // stored branch can be stale (checked out elsewhere since Take), so it always
  // re-reads live.
  const local = runKind(run) === "local";
  const repos = run.repos.map((r) => gitState(r.name, r.path, local ? r.branch ?? null : undefined));
  // The union of both readings. An open session is exact — addressed by its own
  // sessionId, so two in one worktree report two states — and the per-repo read
  // covers a repo with no session open, which is what stops a tracked card whose
  // agent has since exited from dropping to parked. `activityRoots`, when set,
  // narrows the per-repo half to roots with a live session — see its doc comment.
  const activityRepos = i.activityRoots
    ? run.repos.filter((r) => i.activityRoots!.has(canon(r.path)))
    : run.repos;
  const agent = mostActive([
    ...agents.map((a) => a.activity),
    ...activityRepos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
  ]);
  const pr = prSignals(prs);
  const column = deriveBucket({
    ticketCategory: ticket?.category ?? null,
    ticketStatus: ticket?.status ?? null,
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
    ticketStatus: ticket?.status ?? null,
    ticketCategory: ticket?.category ?? null,
    repos,
    agent,
    windowOpen,
    prs,
    agents,
  };
}
