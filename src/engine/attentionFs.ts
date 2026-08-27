// The cheap half of the attention badge: build `AttentionCandidate`s without
// touching a forge, a ticket tracker, or the network.
//
// Every reader is injected rather than imported at the call site. The cost ladder
// below is the reason: "no git call for a run nobody is waiting on" is a promise
// about behaviour, and a promise about behaviour needs a spy to hold it.
// `defaultAttentionDeps` wires the real ones.
import * as path from "path";
import { AgentActivity, AgentState, OpenSession, PrEntryMap, RepoGit, Run, runKind } from "../types";
import { AttentionCandidate, attentionLabel, ownsWorkToLose } from "./attention";
import { mostActive, promoteExited } from "./activity";
import { canon, claudeProjectsRoot } from "./paths";
import { resolveOwnership } from "./ownership";
import { groupByPlace, readOpenSessions, defaultSessionsDir } from "./sessions";
import { readPrEntries, defaultPrFactsDir } from "./pr/store";
import { readRuns, defaultRunsDir } from "./runs";
import { groupPlacesByWindow, localFallbackName, localKey } from "./localRuns";
import { PresenceRecord, readLiveWindows, defaultWindowsDir } from "./presence";
import { readAgentActivity, readSessionActivity } from "./transcript";
import { currentBranch, gitState as realGitState, prEligible as realPrEligible, repoRoot } from "./git";
import { JUST_LAUNCHED_MS } from "./visibility";

/** `deriveBucket`'s needs rung, named once so the cost ladder and its test agree. */
export const NEEDS_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "blocked", "needs-you", "stalled", "exited",
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
  /** The branch a live-session root is currently on — the one thing a local
   * candidate cannot get for free the way a tracked run's `prEligible` check
   * does (`run.repos[i].branch` is a static field written once at launch, no
   * git spawn needed to read it back). A local card has no run record to hold
   * that snapshot, so this is a real, unmemoized git spawn — `git.ts`'s
   * `currentBranch` is not cached the way `repoRootOf` is. Spent under the
   * same discipline as `gitState`/`prEligible`: only for a root that is
   * already both waiting and has a cached PR entry to judge — see the cost
   * test in `attentionFs.test.ts`. */
  branchOf: (root: string) => string | null;
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
    branchOf: (root) => currentBranch(root),
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
    // machine reaches none of them. Do NOT hoist any of them out of this branch —
    // attentionFs.test.ts's "spends no git call and no PR read on a run nobody is
    // waiting on" asserts that all three costly readers this branch can reach
    // stay untouched: `prEntries` (a file read), and `gitState` and `prEligible`
    // (each a git process). The local half below has a fourth, `branchOf`, under
    // the same discipline and its own cost test.
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
      // Display text for the toast, never the identity. A task run's key already
      // IS its ticket key, so this changes nothing for the common case; it names
      // the records whose key is generated instead — an Explore or Notepad slug.
      // `run.key` rather than a resolved ticket key: this path has no connector
      // to parse `run.url` with (and must not acquire one — no Jira on the hidden
      // path), so a Track it card announces its hash here where the Deck's own
      // candidates, preferred whenever a panel is open, announce its ticket.
      label: attentionLabel(run, run.key),
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
  // half is skipped instead. `claimed` was populated above regardless of the
  // toggle (a hidden place is still owned), which is exactly why this can't
  // reuse it as the gate — it has to be `deps.openAgents` itself. An `if` rather
  // than an early `return out`: a later addition after this block must not be
  // silently skipped just because this half happens to be gated off.
  //
  // A local card always has a live session by construction, so its shelf is
  // `board` without asking git anything. It DOES have a PR cache, though:
  // deckView.ts's `prLess` gate is notepad-only, so a local run reads and
  // writes `readPrEntries`/`enqueuePr` under its own `localKey` exactly like a
  // tracked one (deckView.ts's PR-facts section makes no `kind === "local"`
  // exception). An earlier version of this comment claimed otherwise and
  // shipped `prs: {}` unconditionally, which cannot see a merge that already
  // landed — the badge would then count a card the column shows as `merge`,
  // and the count would visibly change the moment the Deck panel closed.
  if (deps.openAgents) {
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
      // The union of both readings, exactly the shape buildRunStatus's own
      // reduction takes for a local run (status.ts: agents' own activity plus
      // `activityRepos.map((r) => readAgentActivity(...))`, with
      // `activityRoots` narrowing that second half to roots with a live
      // session — here, `group.places`). Skipping the per-place half would
      // undercount: `readSessionActivity` returns UNKNOWN_ACTIVITY with no
      // fallback when a session's own `<sessionId>.jsonl` is missing or
      // unreadable (transcript.ts:154-160), and that can leave a session
      // reading "unknown" while a louder transcript sits beside it in the
      // same project directory — one `readAgentActivity` directory scan away.
      //
      // `branch: null` rather than `currentBranch(root)`: this read runs for
      // every unclaimed place on every tick, whether or not the card ends up
      // waiting — a card boards unconditionally here regardless of the
      // answer — and the cost ladder forbids an unmemoized git spawn at that
      // frequency. That is not a ban on this file ever spawning
      // `currentBranch`: see `deps.branchOf` ~45 lines below, spent only once
      // this same card is already waiting, `prFacts` is on, AND a PR entry is
      // already cached for it — three gates, not zero. The ban is on paying
      // the spawn here, per place, per tick, for an answer nobody may ever
      // need.
      // `readAgentActivity` already falls back to the newest transcript
      // overall when nothing matches a branch (transcript.ts:135-137), so a
      // null branch agrees with the real one whenever the branch-matched
      // transcript IS the newest — the ordinary case. It can only disagree
      // when one directory holds transcripts for several branches and an
      // older branch-matched one reads a different needs-state than a newer,
      // unrelated one — and only in the direction of counting a card the
      // Deck's own branch-aware read would not have shown, never the
      // reverse: `mostActive` only ever raises the reading toward the
      // liveliest input, so adding this half can't lower a count either way.
      const reduced = mostActive([
        ...sessions.map((s) => deps.sessionActivity(s.cwd, s.sessionId)),
        ...group.places.map((p) => deps.repoActivity(p, null)),
      ]);
      // Called even though it cannot fire here (the sessions exist), so both
      // paths in this file read identically.
      const agentState = promoteExited(reduced, sessions.length).state;
      // `roots[0]`, the loop's own post-normalization list, not the LocalGroup's
      // raw `group.roots[0]` — deckView.ts's `localRunFor` is handed `liveGroup`
      // (roots already normalized the identical way), so its fallback key reads
      // the normalized root too. The two are the same string in practice, since
      // `allPlaces`/`unclaimed` are already repo-root-normalized by the real
      // (uninjected) `repoRoot` inside `groupByPlace` — but matching the literal
      // line the Deck runs is what keeps a future divergence from being silent.
      const key = localKey(group.workspaceFile ?? roots[0]);
      const waiting = NEEDS_STATES.has(agentState);
      // The tracked half's exact gates, restated for a card with no run record
      // to read a repo name or a launch-time branch off of: `waiting`,
      // `deps.prFacts`, then `stored[name] &&` before `deps.prEligible` is ever
      // reached — never the other order, or an ineligible repo's git spawn
      // would be paid for nothing. Scoped to `group.places`, not the wider
      // `roots`: deckView.ts's own local PR-facts filter is `activeRoots`-gated
      // to roots with a live session (see its `localActiveRootsByKey`), so a
      // sibling root nobody is sitting in must not vote here either — matching
      // the Deck's own card exactly, not just its shelf.
      const stored = waiting && deps.prFacts ? deps.prEntries(key) : {};
      const placeSet = new Set(group.places);
      const prs: PrEntryMap = Object.fromEntries(
        roots
          .filter((root) => placeSet.has(root) && isGitByRoot.get(root))
          .map((root) => ({ name: path.basename(root) || root, path: root }))
          .filter((r) => stored[r.name])
          .filter((r) => deps.prEligible({ path: r.path, isGit: true, branch: deps.branchOf(r.path) ?? undefined }))
          .map((r) => [r.name, stored[r.name]]),
      );
      out.push({
        key,
        // `localKey`'s output is a slug plus a sha1 — an identity, not something
        // to put in a notification. The same string `localRunFor` gives the card
        // the Deck draws, through the one shared helper, so the two paths cannot
        // announce the same place under two different names. No inferred ticket
        // here: that needs the project key and base url from config, which this
        // path does not read.
        label: localFallbackName(group.workspaceFile, roots[0]),
        agentState,
        prs,
        ticketStatus: null,
        hasLiveSession: true,
        justLaunched: false,
        hasWorkToLose: false,
        showAll: deps.showAll,
      });
    }
  }
  return out;
}
