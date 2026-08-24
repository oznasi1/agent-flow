// The cheap half of the attention badge: build `AttentionCandidate`s without
// touching a forge, a ticket tracker, or the network.
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
import { groupPlacesByWindow, localKey } from "./localRuns";
import { PresenceRecord, readLiveWindows, defaultWindowsDir } from "./presence";
import { readAgentActivity, readSessionActivity } from "./transcript";
import { gitState as realGitState, prEligible as realPrEligible, repoRoot } from "./git";
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
  /** `git.ts`'s own rule for whether a repo's branch can own a pull request of
   * its own, injected rather than re-implemented: a local copy of this rule
   * already dropped a clause once (round 1's filter forgot `defaultBranch`
   * can return "", which never equals a branch name) — one definition, every
   * caller, is the whole reason this module exists. Spawns a git process, so
   * it is spent under the same discipline as `gitState`: the cost test at
   * `attentionFs.test.ts` asserts it is never called for a run nobody is
   * waiting on. */
  prEligible: (repo: { path: string; isGit: boolean; branch?: string }) => boolean;
  repoRootOf: (dir: string) => string;
  nowMs: number;
  showAll: boolean;
  /** `agentFlow.openAgents` — the Deck's display toggle for session cards. It
   * must not change whether a run counts as having a live session (`ownership`
   * is resolved from every place regardless), only whether a session's own
   * transcript reading joins the state union — exactly `deckView.ts`'s
   * `places = this.openAgents ? allPlaces : new Map()`. */
  openAgents: boolean;
  /** `agentFlow.prFacts` — off means no PR cache read at all, mirroring
   * `deckView.ts`'s `stored = this.prFacts && !prLess ? readPrEntries(...) : {}`.
   * Defaults true, but turning it off does not delete what is already on disk
   * (`onConfigChanged` only clears the branch-CI caches), so without this gate
   * the badge would keep reading stale entries the Deck itself has stopped
   * showing. */
  prFacts: boolean;
}

export function defaultAttentionDeps(opts: {
  nowMs: number;
  showAll: boolean;
  openAgents: boolean;
  prFacts: boolean;
}): AttentionDeps {
  const { nowMs, showAll, openAgents, prFacts } = opts;
  const projectsRoot = claudeProjectsRoot();
  return {
    runs: () => readRuns(defaultRunsDir()),
    sessions: () => readOpenSessions(defaultSessionsDir()),
    windows: () => readLiveWindows(defaultWindowsDir()),
    prEntries: (key) => readPrEntries(defaultPrFactsDir(), key),
    sessionActivity: (cwd, sessionId) => readSessionActivity(projectsRoot, cwd, sessionId, nowMs),
    repoActivity: (repoPath, branch) => readAgentActivity(projectsRoot, repoPath, branch, nowMs),
    gitState: (name, repoPath) => realGitState(name, repoPath),
    prEligible: (repo) => realPrEligible(repo),
    // `repoRoot` (git.ts) already memoizes per path for the life of the
    // extension host (its own `rootMemo`) — a second cache layer here bought
    // nothing but a copy that can never be invalidated, which is worse than no
    // cache at all.
    repoRootOf: (dir) => repoRoot(dir),
    nowMs,
    showAll,
    openAgents,
    prFacts,
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
      // `openAgents` off is a display toggle, not "nobody is here" — ownership
      // above is resolved from every place regardless — but the Deck itself
      // never builds a CardAgent (and never reads its transcript) for a hidden
      // place, so the state union must not see it either.
      if (!deps.openAgents) continue;
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
    // A notepad run owns no pull request — see deckView.ts's `prLess` for why a
    // stranger's branch cannot be attributed to a note — and `prFacts` off
    // means the cache is not read for anything at all. Reading it anyway would
    // be wasted work as well as wrong, so both are skipped entirely, not
    // fetched-then-discarded.
    const stored = waiting && deps.prFacts && runKind(run) !== "notepad" ? deps.prEntries(run.key) : {};
    // Filtered exactly as deckView.ts filters `readPrEntries`'s result before a
    // card ever sees it: `deps.prEligible` is the real `prEligible` from
    // git.ts, not a local copy, so a repo on its default branch owns no PR of
    // its own here for the identical reason it owns none there. A repo that
    // has since left the run — re-taken with a different repo selection — is
    // dropped simply by never being looked up, rather than carried forward as
    // an orphaned entry that could still vote `prMerged` or `prOpen` on a run
    // it no longer belongs to. `stored[r.name] &&` short-circuits first, so
    // `prEligible` — which spawns git — is never reached for an entry that
    // was never there.
    const prs: PrEntryMap = Object.fromEntries(
      run.repos
        .filter((r) => stored[r.name] && deps.prEligible(r))
        .map((r) => [r.name, stored[r.name]]),
    );
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
  // Whatever no tracked run claimed is a place you are working in that the Deck
  // has never heard of. `openAgents` gates this exactly as buildAll does — with
  // the display toggle off, `places` is empty there, so no local card is ever
  // built; here there is no `places`/`allPlaces` split to lean on, so the whole
  // half returns early instead. `claimed` was populated above regardless of the
  // toggle (a hidden place is still owned), which is exactly why this can't
  // reuse it as the gate — it has to be `deps.openAgents` itself.
  //
  // A local card always has a live session by construction, so its shelf is
  // `board` without asking git anything, and there is no PR cache for a key the
  // Deck never launched. The only git this pass can reach is the memoized
  // `repoRootOf` normalization.
  if (!deps.openAgents) return out;
  const unclaimed = [...allPlaces.keys()].filter((place) => !claimed.has(place));
  for (const group of groupPlacesByWindow(unclaimed, deps.windows())) {
    const isGitByRoot = new Map<string, boolean>();
    for (const root of group.roots) {
      const rr = deps.repoRootOf(root);
      const norm = canon(rr || root);
      if (!isGitByRoot.has(norm)) isGitByRoot.set(norm, rr !== "");
    }
    const roots = [...isGitByRoot.keys()].filter(
      (root) => !claimed.has(root) && (isGitByRoot.get(root) || allPlaces.has(root)),
    );
    if (roots.length === 0) continue;
    const sessions = group.places.flatMap((place) => allPlaces.get(place) ?? []);
    const reduced = mostActive(sessions.map((s) => deps.sessionActivity(s.cwd, s.sessionId)));
    out.push({
      // `roots[0]`, the loop's own post-normalization list, not the LocalGroup's
      // raw `group.roots[0]` — deckView.ts's `localRunFor` is handed `liveGroup`
      // (roots already normalized the identical way), so its fallback key reads
      // the normalized root too. The two are the same string in practice, since
      // `allPlaces`/`unclaimed` are already repo-root-normalized by the real
      // (uninjected) `repoRoot` inside `groupByPlace` — but matching the literal
      // line the Deck runs is what keeps a future divergence from being silent.
      key: localKey(group.workspaceFile ?? roots[0]),
      // Called even though it cannot fire here (the sessions exist), so both
      // paths in this file read identically.
      agentState: promoteExited(reduced, sessions.length).state,
      prs: {},
      ticketStatus: null,
      hasLiveSession: true,
      justLaunched: false,
      hasWorkToLose: false,
      showAll: deps.showAll,
    });
  }
  return out;
}
