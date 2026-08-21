import { AgentActivity, AgentState, CardAgent, Run, RunStatus, PrEntryMap, runKind } from "../types";
// `mostActive` moved to ./activity on this branch (a leaf that imports types and
// nothing else) so the webview's browser bundle can reach it without dragging in
// this module's child_process/fs/path/os graph. main's own change here only added
// type imports, so the merge is the union of the two.
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
  const reduced = mostActive([
    ...agents.map((a) => a.activity),
    ...activityRepos.map((r) => readAgentActivity(projectsRoot, r.path, r.branch ?? null, nowMs)),
  ]);
  // A transcript that stops mid-work with no live session behind it did not
  // finish — the agent died holding the work. "idle" renders that in the calmest
  // tone on the board, which is exactly backwards. Liveness is invisible to a
  // per-file reducer, so the promotion happens here, against the session
  // registry this function already reads.
  //
  // Deliberately narrow: "has a transcript, no live session" would be half the
  // board on a working machine, and `parked` already says "nothing is running
  // here". This fires only when work was actually in flight.
  //
  // `state !== "working"` is also required: deriveActivity stamps midWork:true
  // on a transcript written moments ago with a pending tool call too — that
  // reading is "working", not dead, however sparse the `agents` list handed in
  // happens to be. Only a reading that has already gone stale (stalled, or an
  // idle/never-answered prompt) with no live session behind it has actually died.
  const agent: AgentActivity =
    reduced.midWork && reduced.state !== "working" && agents.length === 0
      ? { ...reduced, state: "exited" }
      : reduced;
  const pr = prSignals(prs);
  const column = deriveBucket({
    ticketStatus: ticket?.status ?? null,
    agentState: agent.state,
    prOpen: pr.open,
    prBlocked: pr.blocked,
    prReady: pr.ready,
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
    // The board's own membership rule needs path ownership across *every* run,
    // which only `buildAll` can see — it overwrites this before the status
    // reaches a card. "board" is the safe placeholder: it hides nothing.
    shelf: "board",
  };
}
