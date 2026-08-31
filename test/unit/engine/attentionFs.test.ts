import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AgentActivity, AgentState, OpenSession, RepoGit, Run } from "../../../src/types";
import { PresenceRecord } from "../../../src/engine/presence";
import { deriveBucket } from "../../../src/engine/bucket";

// `readAgentActivity`/`readSessionActivity` real behaviour is exercised only by
// the `defaultAttentionDeps` wiring test below; every other test drives
// `gatherAttention` through its own injected spies and never reaches this
// module for real. Mocked once, at file scope, so the wiring test can assert
// call arguments without touching a real ~/.claude/projects.
vi.mock("../../../src/engine/transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/engine/transcript")>();
  return {
    ...actual,
    readAgentActivity: vi.fn(() => actual.UNKNOWN_ACTIVITY),
    readSessionActivity: vi.fn(() => actual.UNKNOWN_ACTIVITY),
  };
});

// Same wiring-test purpose as the transcript mock above: prove
// `defaultAttentionDeps`'s `branchOf` and `prEligible` really are `currentBranch`
// and `prEligible` from git.ts, without letting a real `git rev-parse` run (or
// matter) in this file's other tests, which never touch `defaultAttentionDeps` at
// all — every `gatherAttention` test injects its own readers. `gitState` and
// `repoRoot` — also imported from `./git` by attentionFs.ts — are left as
// `actual` so nothing else in this file's wiring changes shape.
vi.mock("../../../src/engine/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/engine/git")>();
  return {
    ...actual,
    currentBranch: vi.fn(() => "mocked-branch"),
    prEligible: vi.fn(() => true),
  };
});

import { AttentionDeps, NEEDS_STATES, defaultAttentionDeps, gatherAttention } from "../../../src/engine/attentionFs";
import * as transcript from "../../../src/engine/transcript";
import * as git from "../../../src/engine/git";
import { localKey } from "../../../src/engine/localRuns";

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  state: "idle", lastActivityMs: 1, slug: null, ...over,
});

const repoGit = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: "api", path: "/repo/api", branch: "feat", dirty: false,
  ahead: 0, added: 0, removed: 0, files: 0, ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  key: "BITE-1", summary: "s", url: "https://jira/BITE-1", createdAt: 0,
  mode: "per-window",
  repos: [{ name: "api", path: "/repo/api", isGit: true, branch: "feat" }],
  briefPaths: [], ...over,
});

const session = (over: Partial<OpenSession> = {}): OpenSession => ({
  pid: 1, sessionId: "sess-1", cwd: "/repo/api",
  startedAt: 1_700_000_000_000, name: "api-1", ...over,
});

let gitState: ReturnType<typeof vi.fn>;
let prEntries: ReturnType<typeof vi.fn>;
let sessionActivity: ReturnType<typeof vi.fn>;
let repoActivity: ReturnType<typeof vi.fn>;
let prEligible: ReturnType<typeof vi.fn>;
let branchOf: ReturnType<typeof vi.fn>;

beforeEach(() => {
  gitState = vi.fn((name: string, repoPath: string) => repoGit({ name, path: repoPath }));
  prEntries = vi.fn(() => ({}));
  sessionActivity = vi.fn(() => activity({ state: "working" }));
  repoActivity = vi.fn(() => activity({ state: "unknown" }));
  // Eligible by default, so an existing fixture's PR entry survives filtering
  // unless a test says otherwise — the real rule (git.ts's `prEligible`) is
  // exercised by git.test.ts; this module only has to prove it is CALLED and
  // OBEYED, never re-derive it.
  prEligible = vi.fn(() => true);
  branchOf = vi.fn(() => "feat");
});

const deps = (over: Partial<AttentionDeps> = {}): AttentionDeps => ({
  runs: () => [],
  sessions: () => [],
  windows: () => [],
  prEntries: prEntries as unknown as AttentionDeps["prEntries"],
  sessionActivity: sessionActivity as unknown as AttentionDeps["sessionActivity"],
  repoActivity: repoActivity as unknown as AttentionDeps["repoActivity"],
  gitState: gitState as unknown as AttentionDeps["gitState"],
  prEligible: prEligible as unknown as AttentionDeps["prEligible"],
  branchOf: branchOf as unknown as AttentionDeps["branchOf"],
  repoRootOf: (dir: string) => dir,
  nowMs: 1_000_000_000,
  showAll: false,
  openAgents: true,
  prFacts: true,
  ...over,
});

describe("NEEDS_STATES", () => {
  it("tracks deriveBucket's needs rung itself, rather than restating it", () => {
    // Derived from deriveBucket, not a copy of its literals: add a state to its
    // needs rung and this fails, where asserting NEEDS_STATES against its own
    // contents would not.
    const ALL_STATES: AgentState[] = ["blocked", "working", "needs-you", "stalled", "exited", "idle", "unknown"];
    for (const state of ALL_STATES) {
      expect(NEEDS_STATES.has(state)).toBe(deriveBucket({ agentState: state }) === "needs");
    }
  });
});

describe("gatherAttention: tracked runs", () => {
  it("returns nothing when there are no runs and no sessions", () => {
    expect(gatherAttention(deps())).toEqual([]);
  });

  it("skips review runs — they live on the strip, never in a column", () => {
    expect(gatherAttention(deps({ runs: () => [run({ key: "PR-1", kind: "review" })] }))).toEqual([]);
  });

  it("carries a run through with the fields the reduction needs", () => {
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.key).toBe("BITE-1");
    expect(c.ticketStatus).toBeNull();   // Jira on the hidden path is forbidden
    expect(c.showAll).toBe(false);
    expect(c.hasLiveSession).toBe(false);
  });

  it("takes the liveliest reading across a run's sessions and repos", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    const [c] = gatherAttention(deps({
      runs: () => [run()],
      sessions: () => [session()],
    }));
    expect(c.agentState).toBe("blocked");
    expect(c.hasLiveSession).toBe(true);
  });

  it("promotes a transcript that died holding the work to exited", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.agentState).toBe("exited");
  });

  it("passes inflightShowAll straight through", () => {
    expect(gatherAttention(deps({ runs: () => [run()], showAll: true }))[0].showAll).toBe(true);
  });

  it("marks a run created moments ago as just launched", () => {
    const [c] = gatherAttention(deps({ runs: () => [run({ createdAt: 1_000_000_000 - 1000 })] }));
    expect(c.justLaunched).toBe(true);
  });

  it("does not mark a run launched an hour ago as just launched", () => {
    const [c] = gatherAttention(deps({ runs: () => [run({ createdAt: 1_000_000_000 - 3_600_000 })] }));
    expect(c.justLaunched).toBe(false);
  });
});

describe("gatherAttention: the cost ladder", () => {
  it("spends no git call and no PR read on a run nobody is waiting on", () => {
    // The whole point of the hidden path: a quiet machine costs transcript reads
    // and nothing else. If someone hoists a reader out of the needs branch, or
    // reorders the `prs` filter's short-circuit so `prEligible` runs before
    // `stored[r.name]`, this fails.
    repoActivity.mockReturnValue(activity({ state: "working" }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(gitState).not.toHaveBeenCalled();
    expect(prEntries).not.toHaveBeenCalled();
    expect(prEligible).not.toHaveBeenCalled();
    expect(c.prs).toEqual({});
  });

  it("reads the PR cache for a run that IS waiting", () => {
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    gatherAttention(deps({ runs: () => [run()] }));
    expect(prEntries).toHaveBeenCalledWith("BITE-1");
  });

  it("spends git on an exited run with nobody in it — the shelf turns on dirty state", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    gitState.mockReturnValue(repoGit({ dirty: true }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(gitState).toHaveBeenCalledTimes(1);
    expect(c.hasWorkToLose).toBe(true);
  });

  it("spends no git on a waiting run that already has a live session", () => {
    // A live session boards the card on its own, so the answer could not change.
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    gatherAttention(deps({ runs: () => [run()], sessions: () => [session()] }));
    expect(gitState).not.toHaveBeenCalled();
  });

  it("refuses to count a ticketless Explore run's dirty checkout as work to lose", () => {
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));
    gitState.mockReturnValue(repoGit({ dirty: true }));
    const [c] = gatherAttention(deps({
      runs: () => [run({ kind: "explore", url: "" })],
    }));
    expect(c.hasWorkToLose).toBe(false);
    expect(gitState).not.toHaveBeenCalled();
  });

  it("imports nothing beyond its declared specifiers, so a new dependency (a forge included) cannot land unnoticed", () => {
    // A prose grep for the word "forge" scans comments as much as imports, and
    // is blind to a transitive reach through a helper module. An exact
    // specifier-list assertion catches a new import and documents every
    // existing one — `./git` included, which really does spawn a subprocess
    // through `deps.gitState`/`deps.prEligible`/`deps.branchOf`, entirely on
    // purpose. `path` is a bare Node builtin (basename only, no fs/network) —
    // it names a local card's repo the same way `deckView.ts`'s `localRunFor`
    // does, so a stored PR entry's key can be found at all.
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/engine/attentionFs.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual([
      "../types", "./activity", "./attention", "./git", "./localRuns", "./ownership",
      "./paths", "./pr/store", "./presence", "./runs", "./sessions", "./transcript",
      "./visibility", "path",
    ]);
  });
});

describe("gatherAttention: PR facts filtered the way the Deck filters them", () => {
  it("empties the PR map for a notepad run, and never reads the cache for it, even though it is waiting", () => {
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    const [c] = gatherAttention(deps({ runs: () => [run({ kind: "notepad" })] }));
    expect(c.prs).toEqual({});
    expect(prEntries).not.toHaveBeenCalled();
  });

  it("drops a PR entry the injected prEligible rejects — the case round 1's local copy missed", () => {
    // Round 1 re-implemented prEligible's rule locally and dropped its
    // `def !== ""` clause: a repo whose default branch cannot be resolved (no
    // `origin/HEAD` — very common in a fresh clone) has `defaultBranch(...)`
    // return "", which never equals a real branch name, so the copy called it
    // eligible when the Deck's own `prEligible` (git.test.ts's "no origin"
    // case) calls it ineligible. Injecting the real function rather than a
    // local rule is the fix; this test locks in that gatherAttention actually
    // calls `deps.prEligible` with the real repo shape and obeys a `false`.
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({ api: { facts: null, fetchedAt: 0 } });
    prEligible.mockReturnValue(false);
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({});
    expect(prEligible).toHaveBeenCalledWith(run().repos[0]);
  });

  it("drops an entry for a repo that has since left the run, instead of carrying the orphan forward", () => {
    // The reachable failure this guards: a task re-taken with a different repo
    // selection leaves a stale MERGED entry keyed by the OLD repo name. Left in
    // place, it would vote prMerged on a run whose merge column outranks needs.
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({ web: { facts: null, fetchedAt: 0 } }); // "web" is not in run().repos
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({});
  });

  it("keeps a PR entry for a repo the injected prEligible accepts and that is still in the run", () => {
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    const entry = { facts: null, fetchedAt: 0 };
    prEntries.mockReturnValue({ api: entry });
    prEligible.mockReturnValue(true);
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({ api: entry });
  });

  it("never reads the PR cache when agentFlow.prFacts is off, even with entries already on disk and the run waiting", () => {
    // `prFacts` off does not delete what is on disk — deckView.ts's
    // `onConfigChanged` only clears the branch-CI caches — so without this
    // gate the badge would keep reading stale entries the Deck itself has
    // stopped showing.
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({ api: { facts: null, fetchedAt: 0 } }); // entries ARE on disk
    const [c] = gatherAttention(deps({ runs: () => [run()], prFacts: false }));
    expect(c.prs).toEqual({});
    expect(prEntries).not.toHaveBeenCalled();
  });
});

describe("gatherAttention: openAgents gates the session half of the state union", () => {
  it("flips the promoteExited verdict exactly the way the Deck's display toggle does", () => {
    // A transcript that died mid-work with nobody live reads as `exited`; the
    // same transcript with one live session in the run reads as merely `idle`.
    // openAgents must reproduce this without the Deck's own `places` map: hiding
    // the session must feel, to the reduction, exactly like it was never there.
    sessionActivity.mockReturnValue(activity({ state: "idle" }));
    repoActivity.mockReturnValue(activity({ state: "idle", midWork: true }));

    const off = gatherAttention(deps({
      runs: () => [run()], sessions: () => [session()], openAgents: false,
    }));
    expect(off[0].agentState).toBe("exited");

    const on = gatherAttention(deps({
      runs: () => [run()], sessions: () => [session()], openAgents: true,
    }));
    expect(on[0].agentState).toBe("idle");

    // Ownership itself must not move: a hidden session is still a live one.
    expect(off[0].hasLiveSession).toBe(true);
    expect(on[0].hasLiveSession).toBe(true);
  });

  it("never reads a hidden session's transcript at all", () => {
    gatherAttention(deps({ runs: () => [run()], sessions: () => [session()], openAgents: false }));
    expect(sessionActivity).not.toHaveBeenCalled();
  });
});

describe("gatherAttention: ownership across a shared checkout", () => {
  it("gives a shared checkout's live session to only the run that owns it", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    repoActivity.mockReturnValue(activity({ state: "idle" }));
    // `older` already existed when the session started; `newer` did not, so
    // ownership must go to `older` — see ownership.ts's `resolveOwnership`.
    const older = run({ key: "BITE-1", createdAt: 100 });
    const newer = run({ key: "BITE-2", createdAt: 1_700_000_000_500 });
    const shared = session({ sessionId: "sess-shared", startedAt: 1_700_000_000_000 });

    const [olderCand, newerCand] = gatherAttention(deps({
      runs: () => [older, newer],
      sessions: () => [shared],
    }));

    expect(olderCand.agentState).toBe("blocked"); // owns the session
    expect(newerCand.agentState).toBe("idle");       // sees no session at all
  });

  it("gives a shared checkout's dirty state to only the run that owns the path", () => {
    // No live session anywhere, so pathOwner falls back to the newest holder.
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    gitState.mockReturnValue(repoGit({ dirty: true }));
    const older = run({ key: "BITE-1", createdAt: 100 });
    const newer = run({ key: "BITE-2", createdAt: 200 });

    const [olderCand, newerCand] = gatherAttention(deps({ runs: () => [older, newer] }));

    expect(gitState).toHaveBeenCalledTimes(1); // spent for the owner only, never twice
    expect(newerCand.hasWorkToLose).toBe(true);
    expect(olderCand.hasWorkToLose).toBe(false);
  });
});

describe("defaultAttentionDeps: real readers wired in the right argument order", () => {
  it("calls the transcript readers with (projectsRoot, place, id-or-branch, nowMs)", () => {
    // All-string argument lists compile clean no matter the order; only a call-
    // site assertion catches two positions swapped.
    const nowMs = 1_234_567;
    const wired = defaultAttentionDeps({ nowMs, showAll: false, openAgents: true, prFacts: true });

    wired.sessionActivity("/repo/api", "sess-1");
    expect(transcript.readSessionActivity).toHaveBeenCalledWith(
      expect.any(String), "/repo/api", "sess-1", nowMs,
    );

    wired.repoActivity("/repo/api", "feat");
    expect(transcript.readAgentActivity).toHaveBeenCalledWith(
      expect.any(String), "/repo/api", "feat", nowMs,
    );
  });

  it("calls the branch reader with the plain root — mis-wiring this to () => null would silently revert prEligible's fix", () => {
    // Wiring `branchOf` to a stub that always returns null would make every
    // repo look branchless, and `prEligible` returns false on `!repo.branch`
    // for every one of them — so every PR entry would be dropped and a
    // merged local card would start being counted again, with every other
    // test in this file (which injects its own `branchOf`) still green.
    // Only a call-site assertion against the real wiring catches that.
    const wired = defaultAttentionDeps({ nowMs: 1, showAll: false, openAgents: true, prFacts: true });
    wired.branchOf("/repo/api");
    expect(git.currentBranch).toHaveBeenCalledWith("/repo/api");
  });
});

describe("defaultAttentionDeps: the wiring nothing else in this file can see", () => {
  // Every gatherAttention test above injects its own `prEligible`, so mis-wiring
  // the real one to `() => true` here would leave this whole file green while
  // reproducing exactly the orphan-entry divergence two rounds were spent
  // closing: an entry for a repo on its default branch, or one that has left the
  // run, voting `prMerged`/`prOpen` on a card it no longer belongs to.
  it("wires prEligible to git.ts's own rule, repo object and all", () => {
    const wired = defaultAttentionDeps({ nowMs: 1, showAll: false, openAgents: true, prFacts: true });
    const repo = { path: "/repo/api", isGit: true, branch: "feat" };
    wired.prEligible(repo);
    expect(git.prEligible).toHaveBeenCalledWith(repo);
  });

  it("returns what git.ts's prEligible answered, rather than a hardcoded verdict", () => {
    vi.mocked(git.prEligible).mockReturnValueOnce(false);
    const wired = defaultAttentionDeps({ nowMs: 1, showAll: false, openAgents: true, prFacts: true });
    expect(wired.prEligible({ path: "/repo/api", isGit: true, branch: "main" })).toBe(false);
  });

  it("carries each config field to its own field — these are adjacent booleans a swap would typecheck", () => {
    // `openAgents` and `prFacts` sit next to each other in the returned object
    // and mean different things: one gates the session half of the state union,
    // the other the PR-cache read. Asymmetric values, or the swap is invisible.
    const wired = defaultAttentionDeps({ nowMs: 77, showAll: false, openAgents: true, prFacts: false });
    expect({ nowMs: wired.nowMs, showAll: wired.showAll, openAgents: wired.openAgents, prFacts: wired.prFacts })
      .toEqual({ nowMs: 77, showAll: false, openAgents: true, prFacts: false });
  });

  it("carries them the other way round too", () => {
    const wired = defaultAttentionDeps({ nowMs: 78, showAll: true, openAgents: false, prFacts: true });
    expect({ nowMs: wired.nowMs, showAll: wired.showAll, openAgents: wired.openAgents, prFacts: wired.prFacts })
      .toEqual({ nowMs: 78, showAll: true, openAgents: false, prFacts: true });
  });
});

const windowRec = (over: Partial<PresenceRecord> = {}): PresenceRecord => ({
  identity: "/ws/team.code-workspace", kind: "workspace", label: "team.code-workspace",
  folders: 2, roots: ["/repo/a", "/repo/b"], pid: 4242, updatedAt: 1_700_000_000_000, ...over,
});

describe("gatherAttention: local session cards", () => {
  it("makes no local candidate when openAgents is off", () => {
    expect(gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo" })],
      openAgents: false,
    }))).toEqual([]);
  });

  it("makes a candidate for a session in a place no run claims", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    const got = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(got.length).toBe(1);
    expect(got[0].agentState).toBe("blocked");
    expect(got[0].hasLiveSession).toBe(true);
    expect(got[0].hasWorkToLose).toBe(false);
    expect(got[0].prs).toEqual({});
  });

  it("does not double-count a place a tracked run already owns", () => {
    const got = gatherAttention(deps({
      runs: () => [run()],
      sessions: () => [session({ cwd: "/repo/api" })],
    }));
    expect(got.map((c) => c.key)).toEqual(["BITE-1"]);
  });

  it("folds two roots of one multi-root window into a single card", () => {
    const got = gatherAttention(deps({
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/b" }),
      ],
      windows: () => [windowRec()],
    }));
    expect(got.length).toBe(1);
  });

  it("keeps two unrelated places as two cards", () => {
    const got = gatherAttention(deps({
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/c" }),
      ],
    }));
    expect(got.length).toBe(2);
  });

  it("spends no gitState call on a local card — a live session already boards it", () => {
    gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(gitState).not.toHaveBeenCalled();
  });

  it("gives a local card a stable key across passes, so the latch holds", () => {
    const d = { sessions: () => [session({ cwd: "/repo/solo" })] };
    const first = gatherAttention(deps(d)).map((c) => c.key);
    const second = gatherAttention(deps({ ...d, nowMs: 2_000_000_000 })).map((c) => c.key);
    expect(second).toEqual(first);
    expect(first[0]).toBeTruthy();
  });

  it("passes inflightShowAll to a local card too", () => {
    const got = gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo" })], showAll: true,
    }));
    expect(got[0].showAll).toBe(true);
  });

  it("does not leak a claimed root's session activity into an unclaimed sibling's local card", () => {
    // The outer `unclaimed` filter (over allPlaces, before grouping) and the
    // inner `roots` filter (over the window's full declared root list, after
    // normalization) both check `claimed`, mirroring deckView.ts's own
    // double-check exactly. A standalone group's inner filter alone is enough
    // to keep a claimed place from becoming its own card (see the
    // double-count test above) — but only the OUTER filter keeps a claimed
    // root's session out of `group.places`, and so out of the reduction, for
    // an unclaimed SIBLING root sharing its multi-root window. Drop the outer
    // filter and "/repo/a"'s loud "blocked" session would leak into "/repo/b"'s
    // card even though "/repo/a" belongs to run BITE-1.
    sessionActivity.mockImplementation((_cwd: string, sessionId: string) =>
      sessionId === "s1" ? activity({ state: "blocked" }) : activity({ state: "idle" }));
    const got = gatherAttention(deps({
      runs: () => [run({ key: "BITE-1", repos: [{ name: "a", path: "/repo/a", isGit: true }] })],
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/b" }),
      ],
      windows: () => [windowRec()],
    }));
    const local = got.find((c) => c.key !== "BITE-1");
    expect(local?.agentState).toBe("idle");
  });

  it("keys a standalone place by its normalized repo root, not the raw place string — matching deckView.ts's liveGroup.roots[0], not the pre-normalization group.roots[0]", () => {
    // groupByPlace already normalizes every session's cwd through the real
    // (uninjected) repoRoot before it ever reaches attentionFs, so in
    // production repoRootOf (which wraps that same real function) can never
    // disagree with it. Diverging deps.repoRootOf from what groupByPlace saw
    // is the only way to exercise the line in isolation — it proves the key
    // is built from the loop's own normalized `roots[0]`, not the LocalGroup's
    // raw `group.roots[0]`, the way deckView.ts's `liveGroup.roots[0]` is.
    const got = gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo/nested" })],
      repoRootOf: () => "/repo/solo",
    }));
    expect(got.length).toBe(1);
    expect(got[0].key).toBe(localKey("/repo/solo"));
  });

  it("counts a local card the repo-directory reading would show even if its own session transcript reads unknown", () => {
    // The reachable failure this guards: readSessionActivity returns
    // UNKNOWN_ACTIVITY with no directory fallback when a session's own
    // <sessionId>.jsonl is missing or unreadable (transcript.ts:154-160),
    // while the same project directory holds a louder transcript
    // readAgentActivity's directory scan would find. Without the per-place
    // repo reading in the union, this session would board the badge as
    // "unknown" while the Deck's own card — which takes the identical
    // union, per status.ts's `activityRepos` — shows blocked.
    sessionActivity.mockReturnValue(activity({ state: "unknown" }));
    repoActivity.mockReturnValue(activity({ state: "blocked" }));
    const got = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(got.length).toBe(1);
    expect(got[0].agentState).toBe("blocked");
    // The per-place reading added for this is `deps.repoActivity` — a
    // transcript read — never `deps.gitState`, which is what keeps this
    // affordable on every tick regardless of whether anyone is waiting.
    expect(gitState).not.toHaveBeenCalled();
  });

  it("keeps a non-git place alive by its live session — the `|| allPlaces.has(root)` half of the disjunction", () => {
    // Every other fixture in this file leaves repoRootOf returning something
    // non-empty, so `isGitByRoot.get(root)` is always true and this half of
    // the OR is never load-bearing. Only a place that is BOTH not-git AND
    // has a live session exercises it: drop this clause (keep only
    // `isGitByRoot.get(root)`) and this is the test that fails — `roots`
    // empties out and the whole group is skipped.
    //
    // There is deliberately no sibling test for "a workspace's OTHER
    // declared root, non-git and session-less, gets dropped": `roots` is
    // used for exactly two things past this point — the length-zero skip
    // and (only when `workspaceFile` is null) `roots[0]` as the key
    // fallback. A real multi-root window always sets `workspaceFile`, so
    // that fallback is dead for it; and the window's OTHER declared roots
    // can never be the ones deciding `roots.length`, because the group
    // exists at all only because `group.places` — always a subset of
    // `group.roots` — already contains a live-session place, which trivially
    // satisfies `allPlaces.has`. So a sibling root's membership in `roots`
    // cannot change anything `gatherAttention` returns; a fixture built to
    // "prove" it is dropped would pass identically whether it actually was.
    // Confirmed by mutation: replacing `allPlaces.has(root)` with the literal
    // `true` — the broadest possible break of this clause — passed every
    // test in this file, including this one.
    const got = gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/solo" })],
      repoRootOf: () => "",
    }));
    expect(got.length).toBe(1);
  });
});

describe("gatherAttention: PR facts for a local card, filtered the way the Deck filters them", () => {
  it("spends no PR read and no branch call on a local card nobody is waiting on", () => {
    // The same promise the tracked half's cost-ladder test makes: a quiet
    // machine costs transcript reads and nothing else.
    const [c] = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(prEntries).not.toHaveBeenCalled();
    expect(prEligible).not.toHaveBeenCalled();
    expect(branchOf).not.toHaveBeenCalled();
    expect(c.prs).toEqual({});
  });

  it("reads the PR cache for a local card that IS waiting", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(prEntries).toHaveBeenCalledWith(localKey("/repo/solo"));
  });

  it("spends no branch call on a waiting local card with nothing cached", () => {
    // Different from the "nobody is waiting on" cost test above: this card IS
    // waiting and the PR cache IS read, but comes back empty, so
    // `stored[r.name] &&` short-circuits before `deps.prEligible`/`branchOf`
    // are ever reached — the same short-circuit order the tracked half's
    // "drops an entry for a repo that has since left the run" test locks in.
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    // prEntries's default beforeEach mock already returns {} — nothing cached.
    gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(prEntries).toHaveBeenCalled();
    expect(branchOf).not.toHaveBeenCalled();
  });

  it("keeps a PR entry for the live-session root, filtered exactly like the tracked half", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    const entry = { facts: null, fetchedAt: 0 };
    prEntries.mockReturnValue({ solo: entry });
    const [c] = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(c.prs).toEqual({ solo: entry });
    // `branchOf`, not a static field — a local card has no run record to hold
    // one, unlike a tracked run's `run.repos[i].branch`.
    expect(prEligible).toHaveBeenCalledWith({ path: "/repo/solo", isGit: true, branch: "feat" });
  });

  it("drops a local PR entry the injected prEligible rejects", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({ solo: { facts: null, fetchedAt: 0 } });
    prEligible.mockReturnValue(false);
    const [c] = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(c.prs).toEqual({});
  });

  it("never reads the PR cache for a local card when agentFlow.prFacts is off", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({ solo: { facts: null, fetchedAt: 0 } }); // entry IS on disk
    const [c] = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })], prFacts: false }));
    expect(c.prs).toEqual({});
    expect(prEntries).not.toHaveBeenCalled();
  });

  it("drops a stored entry for a sibling root nobody has a live session in", () => {
    // deckView.ts's own local PR-facts filter is scoped to `activeRoots` — the
    // roots with a live session — not the window's full declared root list.
    // A stale or stranger's PR fact under the sibling's name must not vote on
    // this card just because that root happens to share the workspace.
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    prEntries.mockReturnValue({
      a: { facts: null, fetchedAt: 0 },
      b: { facts: null, fetchedAt: 0 }, // "/repo/b" has no live session
    });
    const got = gatherAttention(deps({
      sessions: () => [session({ cwd: "/repo/a" })],
      windows: () => [windowRec()],
    }));
    expect(got.length).toBe(1);
    expect(got[0].prs).toEqual({ a: { facts: null, fetchedAt: 0 } });
  });
});

describe("gatherAttention: what a candidate is called", () => {
  // `key` is the identity the badge counts and the latch stamps; `label` is the
  // only thing a notification should ever say out loud. For a local card the two
  // are not the same string at all — `localKey` is a slug plus a sha1 — and
  // announcing the key gave "local-solo-<hash> is waiting on you".
  it("labels a local card with its folder name, not localKey's hash", () => {
    sessionActivity.mockReturnValue(activity({ state: "blocked" }));
    const [c] = gatherAttention(deps({ sessions: () => [session({ cwd: "/repo/solo" })] }));
    expect(c.key).toBe(localKey("/repo/solo"));
    expect(c.key).toContain("local-");
    expect(c.label).toBe("solo");
  });

  it("labels a multi-root card with its workspace's name, .code-workspace stripped", () => {
    const [c] = gatherAttention(deps({
      sessions: () => [
        session({ pid: 1, sessionId: "s1", cwd: "/repo/a" }),
        session({ pid: 2, sessionId: "s2", cwd: "/repo/b" }),
      ],
      windows: () => [windowRec()],
    }));
    expect(c.label).toBe("team");
  });

  it("labels a task run with its key — which IS its ticket key", () => {
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.label).toBe("BITE-1");
  });

  it("labels a ticketless Explore run with its summary, not its slug key", () => {
    const [c] = gatherAttention(deps({
      runs: () => [run({ key: "explore-why-the-queue-stalls", summary: "why the queue stalls", url: "", kind: "explore" })],
    }));
    expect(c.label).toBe("why the queue stalls");
  });
});
