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

import { AttentionDeps, NEEDS_STATES, defaultAttentionDeps, gatherAttention } from "../../../src/engine/attentionFs";
import * as transcript from "../../../src/engine/transcript";

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
let defaultBranch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  gitState = vi.fn((name: string, repoPath: string) => repoGit({ name, path: repoPath }));
  prEntries = vi.fn(() => ({}));
  sessionActivity = vi.fn(() => activity({ state: "working" }));
  repoActivity = vi.fn(() => activity({ state: "unknown" }));
  // "main", never "feat" — the fixture run's repo sits on "feat", so the
  // default-branch eligibility rule (finding 1) does not accidentally filter
  // out every existing fixture's PR entries.
  defaultBranch = vi.fn(() => "main");
});

const deps = (over: Partial<AttentionDeps> = {}): AttentionDeps => ({
  runs: () => [],
  sessions: () => [],
  windows: () => [],
  prEntries: prEntries as unknown as AttentionDeps["prEntries"],
  sessionActivity: sessionActivity as unknown as AttentionDeps["sessionActivity"],
  repoActivity: repoActivity as unknown as AttentionDeps["repoActivity"],
  gitState: gitState as unknown as AttentionDeps["gitState"],
  defaultBranch: defaultBranch as unknown as AttentionDeps["defaultBranch"],
  repoRootOf: (dir: string) => dir,
  nowMs: 1_000_000_000,
  showAll: false,
  openAgents: true,
  ...over,
});

describe("NEEDS_STATES", () => {
  it("tracks deriveBucket's needs rung itself, rather than restating it", () => {
    // Derived from deriveBucket, not a copy of its literals: add a state to its
    // needs rung and this fails, where asserting NEEDS_STATES against its own
    // contents would not.
    const ALL_STATES: AgentState[] = ["working", "needs-you", "stalled", "exited", "idle", "unknown"];
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
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
    const [c] = gatherAttention(deps({
      runs: () => [run()],
      sessions: () => [session()],
    }));
    expect(c.agentState).toBe("needs-you");
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
    // and nothing else. If someone hoists either reader out of the needs branch,
    // this fails.
    repoActivity.mockReturnValue(activity({ state: "working" }));
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(gitState).not.toHaveBeenCalled();
    expect(prEntries).not.toHaveBeenCalled();
    expect(c.prs).toEqual({});
  });

  it("reads the PR cache for a run that IS waiting", () => {
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
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
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
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
    // through `deps.gitState`/`deps.defaultBranch`, entirely on purpose.
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/engine/attentionFs.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual([
      "../types", "./activity", "./attention", "./git", "./ownership", "./paths",
      "./pr/store", "./presence", "./runs", "./sessions", "./transcript", "./visibility",
    ]);
  });
});

describe("gatherAttention: PR facts filtered the way the Deck filters them", () => {
  it("empties the PR map for a notepad run, and never reads the cache for it, even though it is waiting", () => {
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
    const [c] = gatherAttention(deps({ runs: () => [run({ kind: "notepad" })] }));
    expect(c.prs).toEqual({});
    expect(prEntries).not.toHaveBeenCalled();
  });

  it("drops a PR entry for a repo sitting on its own default branch", () => {
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
    prEntries.mockReturnValue({ api: { facts: null, fetchedAt: 0 } });
    defaultBranch.mockReturnValue("feat"); // same as the fixture repo's branch
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({});
  });

  it("drops an entry for a repo that has since left the run, instead of carrying the orphan forward", () => {
    // The reachable failure this guards: a task re-taken with a different repo
    // selection leaves a stale MERGED entry keyed by the OLD repo name. Left in
    // place, it would vote prMerged on a run whose merge column outranks needs.
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
    prEntries.mockReturnValue({ web: { facts: null, fetchedAt: 0 } }); // "web" is not in run().repos
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({});
  });

  it("keeps a PR entry for a repo that is eligible and still in the run", () => {
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
    const entry = { facts: null, fetchedAt: 0 };
    prEntries.mockReturnValue({ api: entry });
    defaultBranch.mockReturnValue("main"); // fixture repo's branch is "feat"
    const [c] = gatherAttention(deps({ runs: () => [run()] }));
    expect(c.prs).toEqual({ api: entry });
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
    sessionActivity.mockReturnValue(activity({ state: "needs-you" }));
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

    expect(olderCand.agentState).toBe("needs-you"); // owns the session
    expect(newerCand.agentState).toBe("idle");       // sees no session at all
  });

  it("gives a shared checkout's dirty state to only the run that owns the path", () => {
    // No live session anywhere, so pathOwner falls back to the newest holder.
    repoActivity.mockReturnValue(activity({ state: "needs-you" }));
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
    const wired = defaultAttentionDeps(nowMs, false, true);

    wired.sessionActivity("/repo/api", "sess-1");
    expect(transcript.readSessionActivity).toHaveBeenCalledWith(
      expect.any(String), "/repo/api", "sess-1", nowMs,
    );

    wired.repoActivity("/repo/api", "feat");
    expect(transcript.readAgentActivity).toHaveBeenCalledWith(
      expect.any(String), "/repo/api", "feat", nowMs,
    );
  });
});
