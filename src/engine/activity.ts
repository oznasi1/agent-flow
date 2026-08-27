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
//
// blocked outranks needs-you for the same reason needs-you outranks working: a
// session stopped at a permission prompt cannot make progress at all, and a run
// holding one alongside a session that ended its turn is a run about the frozen
// one. Letting the polite session bury it is the identical bug.
const STATE_RANK: Record<AgentState, number> = {
  blocked: 6,
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

/** The states that mean "not doing anything right now" for a rule like
 * `agent-idle-over` — as opposed to `working` (in flight) or `needs-you` (control
 * already handed back, which fires its own condition instead). `stalled` and
 * `exited` were both folded into a single `idle` reading before the state union
 * grew to name them separately; a caller that means "idle-like" must read this
 * set (or `isIdleLike` below) rather than compare `state === "idle"` directly, or
 * it silently drops back to pre-widening behaviour the next time the union grows
 * — see conditions.ts's `agent-idle-over`, which did exactly that until this set
 * was introduced. `needs-you`, `working` and `unknown` are deliberately absent:
 * each already means something an idle-style rule must not fire on. `blocked`
 * must not join this set either: a session waiting on your approval is not
 * idle, and `agent-idle-over` firing on it would auto-nudge past a modal
 * dialog. */
export const IDLE_LIKE: ReadonlySet<AgentState> = new Set<AgentState>(["idle", "stalled", "exited"]);

/** Is this state "idle-like" — see `IDLE_LIKE` above for what that means and why
 * a bare `state === "idle"` comparison is the wrong tool for this question. */
export function isIdleLike(state: AgentState): boolean {
  return IDLE_LIKE.has(state);
}

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

/**
 * A transcript that stops mid-work with no live session behind it did not finish
 * — the agent died holding the work. "idle" renders that in the calmest tone on
 * the board, which is exactly backwards.
 *
 * Liveness is invisible to a per-file reducer, which is why this is a separate
 * step applied against the session registry rather than a rank in `mostActive`.
 * Deliberately narrow: "has a transcript, no live session" would be half the
 * board on a working machine. `state !== "working"` is also required —
 * `deriveActivity` stamps `midWork` on a transcript written moments ago with a
 * pending tool call, and that reading is alive, however sparse the caller's
 * session list happens to be.
 *
 * Lives here rather than in status.ts so `attentionFs.ts` derives the same state
 * the Deck does. Two copies of this rule is the fork the attention badge exists
 * to avoid.
 *
 * `liveSessionCount` is `null` when the sessions registry could not be READ, as
 * opposed to read and found empty. `readOpenSessions` returns `[]` for an
 * unreadable directory, which is indistinguishable from "nothing is running", so
 * the caller passes null instead and this refuses to promote — no single failed
 * probe may call a card dead. The test for it is `=== 0`, which null already
 * fails, so the guard is the type rather than a new branch.
 */
export function promoteExited(reduced: AgentActivity, liveSessionCount: number | null): AgentActivity {
  return reduced.midWork && reduced.state !== "working" && liveSessionCount === 0
    ? { ...reduced, state: "exited" }
    : reduced;
}
