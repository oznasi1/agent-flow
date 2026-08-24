// The cheap half of the attention badge: build `AttentionCandidate`s without
// touching gh/glab, a ticket tracker, or the network.
//
// Every reader is injected rather than imported at the call site. The cost ladder
// below is the reason: "no git call for a run nobody is waiting on" is a promise
// about behaviour, and a promise about behaviour needs a spy to hold it.
// `defaultAttentionDeps` wires the real ones.
import { AgentActivity, AgentState, OpenSession, PrEntryMap, RepoGit, Run, runKind } from "../types";
import { AttentionCandidate, ownsWorkToLose } from "./attention";
import { mostActive, promoteExited } from "./activity";
import { canon, claudeProjectsRoot } from "./paths";
import { resolveOwnership } from "./ownership";
import { groupByPlace, readOpenSessions, defaultSessionsDir } from "./sessions";
import { readPrEntries, defaultPrFactsDir } from "./pr/store";
import { readRuns, defaultRunsDir } from "./runs";
import { PresenceRecord, readLiveWindows, defaultWindowsDir } from "./presence";
import { readAgentActivity, readSessionActivity } from "./transcript";
import { gitState as realGitState, repoRoot } from "./git";
import { JUST_LAUNCHED_MS } from "./visibility";

/** `deriveBucket`'s needs rung, named once so the cost ladder and its test agree. */
export const NEEDS_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "needs-you", "stalled", "exited",
]);

export interface AttentionDeps {
  runs: () => Run[];
  sessions: () => OpenSession[];
  windows: () => PresenceRecord[];
  prEntries: (key: string) => PrEntryMap;
  sessionActivity: (cwd: string, sessionId: string) => AgentActivity;
  repoActivity: (repoPath: string, branch: string | null) => AgentActivity;
  /** The expensive one: three git calls per repo. The tests assert it is never
   * called for a run nobody is waiting on. */
  gitState: (name: string, repoPath: string) => RepoGit;
  repoRootOf: (dir: string) => string;
  nowMs: number;
  showAll: boolean;
  openAgents: boolean;
}

/** A directory's repo root does not change under us, and the alternative is one
 * `git rev-parse --show-toplevel` per unclaimed session place per tick, forever,
 * in every open window. Module-level so it survives across ticks. */
const repoRootMemo = new Map<string, string>();

export function defaultAttentionDeps(nowMs: number, showAll: boolean, openAgents: boolean): AttentionDeps {
  const projectsRoot = claudeProjectsRoot();
  return {
    runs: () => readRuns(defaultRunsDir()),
    sessions: () => readOpenSessions(defaultSessionsDir()),
    windows: () => readLiveWindows(defaultWindowsDir()),
    prEntries: (key) => readPrEntries(defaultPrFactsDir(), key),
    sessionActivity: (cwd, sessionId) => readSessionActivity(projectsRoot, cwd, sessionId, nowMs),
    repoActivity: (repoPath, branch) => readAgentActivity(projectsRoot, repoPath, branch, nowMs),
    gitState: (name, repoPath) => realGitState(name, repoPath),
    repoRootOf: (dir) => {
      const hit = repoRootMemo.get(dir);
      if (hit !== undefined) return hit;
      const resolved = repoRoot(dir);
      repoRootMemo.set(dir, resolved);
      return resolved;
    },
    nowMs,
    showAll,
    openAgents,
  };
}

export function gatherAttention(deps: AttentionDeps): AttentionCandidate[] {
  const runs = deps.runs().filter((r) => runKind(r) !== "review");
  const allPlaces = groupByPlace(deps.sessions());
  const ownership = resolveOwnership({
    runs: runs.map((r) => ({
      key: r.key, createdAt: r.createdAt, paths: r.repos.map((repo) => canon(repo.path)),
    })),
    sessionsByPlace: allPlaces,
  });

  const out: AttentionCandidate[] = [];
  const claimed = new Set<string>();
  for (const run of runs) {
    // Rung 2: transcripts. One read per owned session plus one per repo — the
    // same union buildRunStatus takes, so the state matches the card.
    const owned: AgentActivity[] = [];
    for (const repo of run.repos) {
      const place = canon(repo.path);
      const sessions = allPlaces.get(place);
      if (!sessions) continue;
      claimed.add(place);
      for (const s of sessions) {
        if (ownership.sessionOwner.get(s.sessionId) !== run.key) continue;
        owned.push(deps.sessionActivity(s.cwd, s.sessionId));
      }
    }
    const reduced = mostActive([
      ...owned,
      ...run.repos.map((r) => deps.repoActivity(r.path, r.branch ?? null)),
    ]);
    const agentState = promoteExited(reduced, owned.length).state;
    const hasLiveSession = ownership.runsWithSession.has(run.key);

    // Rungs 3 and 4, spent ONLY where they could change the answer. A quiet
    // machine reaches neither. Do NOT hoist either out of this branch —
    // attentionFs.test.ts asserts both spies stay untouched otherwise.
    const waiting = NEEDS_STATES.has(agentState);
    const prs = waiting ? deps.prEntries(run.key) : {};
    // `!hasLiveSession`: with a session open the shelf is already `board`, so
    // git could only confirm what is settled. Task 7's parity test is what
    // proves this skip changes no verdict — if it ever could, delete it.
    const hasWorkToLose =
      waiting && !hasLiveSession && ownsWorkToLose(run)
        ? run.repos.some((r) => {
            if (ownership.pathOwner.get(canon(r.path)) !== run.key) return false;
            const g = deps.gitState(r.name, r.path);
            return g.dirty || g.ahead > 0;
          })
        : false;

    out.push({
      key: run.key,
      agentState,
      prs,
      // Forbidden on the hidden path; attention.test.ts proves it cannot change
      // a verdict.
      ticketStatus: null,
      hasLiveSession,
      justLaunched: deps.nowMs - run.createdAt < JUST_LAUNCHED_MS,
      hasWorkToLose,
      showAll: deps.showAll,
    });
  }
  // Task 6 appends local session candidates here, using `claimed`.
  return out;
}
