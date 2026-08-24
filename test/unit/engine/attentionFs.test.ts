import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { AttentionDeps, NEEDS_STATES, gatherAttention } from "../../../src/engine/attentionFs";
import { AgentActivity, OpenSession, RepoGit, Run } from "../../../src/types";
import { PresenceRecord } from "../../../src/engine/presence";

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

beforeEach(() => {
  gitState = vi.fn((name: string, repoPath: string) => repoGit({ name, path: repoPath }));
  prEntries = vi.fn(() => ({}));
  sessionActivity = vi.fn(() => activity({ state: "working" }));
  repoActivity = vi.fn(() => activity({ state: "unknown" }));
});

const deps = (over: Partial<AttentionDeps> = {}): AttentionDeps => ({
  runs: () => [],
  sessions: () => [],
  windows: () => [],
  prEntries: prEntries as unknown as AttentionDeps["prEntries"],
  sessionActivity: sessionActivity as unknown as AttentionDeps["sessionActivity"],
  repoActivity: repoActivity as unknown as AttentionDeps["repoActivity"],
  gitState: gitState as unknown as AttentionDeps["gitState"],
  repoRootOf: (dir: string) => dir,
  nowMs: 1_000_000_000,
  showAll: false,
  openAgents: true,
  ...over,
});

describe("NEEDS_STATES", () => {
  it("names exactly deriveBucket's needs rung", () => {
    expect([...NEEDS_STATES].sort()).toEqual(["exited", "needs-you", "stalled"]);
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

  it("reaches no forge module at all", () => {
    // Asserted on the import graph, not a mocked call site: a mocked call site
    // would not catch a new import.
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/engine/attentionFs.ts"), "utf8");
    expect(src).not.toMatch(/forge|child_process|execFile|spawnSync/);
  });
});
