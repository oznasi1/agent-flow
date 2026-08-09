import { CardAgent, Run, RunStatus, PrEntryMap } from "../types";
import { mostActive, UNKNOWN_ACTIVITY } from "./activity";
import { gitState } from "./git";
import { runTarget } from "./runs";
import { readAgentActivity } from "./transcript";
import { canon } from "./paths";
import { deriveBucket, prSignals } from "./bucket";

// `mostActive` lives in ./activity now — a leaf that imports types and nothing
// else — so the webview's browser bundle can reach it without reaching this
// module's `child_process`/`fs`/`path`/`os` graph. Re-exported here because it
// has always been part of this module's surface and its callers (and
// test/unit/engine/status.test.ts) address it here.
export { mostActive };

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
