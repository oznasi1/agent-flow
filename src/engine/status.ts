import { AgentActivity, AgentState, CardAgent, Run, RunStatus, PrEntryMap } from "../types";
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
}

/** Reconcile a durable Run with every observable source into the status a card
 * renders. No transcript (unreadable or missing) leaves the git + Jira backbone. */
export function buildRunStatus(i: BuildRunStatusInput): RunStatus {
  const { run, ticket, projectsRoot, nowMs } = i;
  const agents = i.agents ?? [];
  const prs = i.prs ?? {};
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  // The union of both readings. An open session is exact — addressed by its own
  // sessionId, so two in one worktree report two states — and the per-repo read
  // covers a repo with no session open, which is what stops a tracked card whose
  // agent has since exited from dropping to parked.
  const agent = mostActive([
    ...agents.map((a) => a.activity),
    ...run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
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
