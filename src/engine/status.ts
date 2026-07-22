import * as fs from "fs";
import { AgentActivity, AgentState, DeckColumn, Run, RunStatus } from "../types";
import { gitState } from "./git";
import { runTarget } from "./runs";
import { readAgentActivity } from "./transcript";

/** Inputs to the column decision — every field observable, none required. */
export interface BucketInput {
  jiraCategory?: string | null; // "new" | "indeterminate" | "done"
  jiraStatus?: string | null; // status name, e.g. "In Review"
  agentState?: AgentState;
  prOpen?: boolean;
}

function isReviewStatus(name?: string | null): boolean {
  return !!name && /review|qa|verif/i.test(name);
}

/**
 * Decide which board column a run belongs in. Precedence, most-decisive first:
 *   done (Jira done) → the live "needs-you" signal → the live "working" signal →
 *   review (PR open / Jira review status) → else "progress" as the in-flight catch-all
 *   (idle / unknown / just-launched).
 * The live agent signals outrank the Jira review stage on purpose: an agent actively
 * addressing review feedback reads as In progress, not parked in Review.
 */
export function deriveBucket(i: BucketInput): DeckColumn {
  if (i.jiraCategory === "done") return "done";
  if (i.agentState === "needs-you") return "needs";
  if (i.agentState === "working") return "progress";
  if (i.prOpen || isReviewStatus(i.jiraStatus)) return "review";
  return "progress";
}

const UNKNOWN_AGENT: AgentActivity = { state: "unknown", lastActivityMs: null, slug: null };

/** Resolve symlinks so a run's target compares equal to a presence identity
 * across /var↔/private/var etc. Presence identities are already canonical. */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
const STATE_RANK: Record<AgentState, number> = { working: 3, "needs-you": 2, idle: 1, unknown: 0 };

/** The liveliest agent across a run's repos — a multi-repo task's session may live
 * in any of them. Ties broken by most-recent activity. Pure. */
export function mostActive(activities: AgentActivity[]): AgentActivity {
  if (activities.length === 0) return UNKNOWN_AGENT;
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

/** Reconcile a durable Run with every observable source into the status a card
 * renders. `liveSignal` off (or no transcript) leaves the git + Jira backbone. */
export function buildRunStatus(
  run: Run,
  jira: JiraInfo | null,
  projectsRoot: string,
  nowMs: number,
  liveSignal = true,
  openIdentities: ReadonlySet<string> = new Set(),
): RunStatus {
  const repos = run.repos.map((r) => gitState(r.name, r.path));
  const agent = liveSignal
    ? mostActive(run.repos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)))
    : UNKNOWN_AGENT;
  const column = deriveBucket({
    jiraCategory: jira?.category ?? null,
    jiraStatus: jira?.status ?? null,
    agentState: agent.state,
  });
  const target = runTarget(run);
  const windowOpen = target ? openIdentities.has(canon(target)) : false;
  return { run, column, jiraStatus: jira?.status ?? null, jiraCategory: jira?.category ?? null, repos, agent, windowOpen };
}
