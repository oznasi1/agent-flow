// The leaf of the activity graph: what an agent's liveness IS, and how to reduce
// several readings of it to one. Types only, no I/O, no other module — and that
// emptiness is the point.
//
// The webview bundles for a BROWSER target and esbuild resolves imports
// statically, so any module the webview's graph can reach must never touch a Node
// builtin — it does not matter that the `fs` code would never execute. This module
// exists so `orchestrator/conditions.ts` (imported by OrchestratorDrawer.tsx) can
// have `mostActive` and `UNKNOWN_ACTIVITY` without pulling in `status.ts`, whose
// own graph reaches `child_process`, `fs`, `path` and `os` through git.ts, runs.ts,
// transcript.ts and paths.ts. `status.ts` and `transcript.ts` re-export from here,
// so every existing importer of theirs keeps working.
//
// Keep this file importing nothing but `../types`. test/webview/webviewGraph.test.ts
// walks the real import graph from each webview entry point and fails the moment
// anything reachable from it imports a Node builtin.
import { AgentActivity, AgentState } from "../types";

// needs-you outranks working: deriveBucket's ladder tests needs-you first, and
// with the old order it never saw one — any working session in the run buried
// the agent that was actually waiting on a human.
//
// stalled outranks working for that same reason: a run with one working agent
// and one stuck at a tool is a run that needs a human, and letting the working
// agent bury the stuck one is the identical bug. needs-you still outranks
// stalled — a turn that handed control back is more actionable than a tool that
// has not returned. `exited` is assigned by buildRunStatus AFTER this reduction,
// so it never competes as an input; its rank exists only for totality.
const STATE_RANK: Record<AgentState, number> = {
  "needs-you": 5,
  stalled: 4,
  exited: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/** No transcript, or nothing meaningful in it. The one value every reader falls
 * back to, rather than three hand-rolled copies that can drift apart. */
export const UNKNOWN_ACTIVITY: AgentActivity = { state: "unknown", lastActivityMs: null, slug: null };

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
