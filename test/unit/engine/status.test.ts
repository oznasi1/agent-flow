import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { mostActive, buildRunStatus } from "../../../src/engine/status";
import { encodeProjectDir } from "../../../src/engine/transcript";
import { currentBranch } from "../../../src/engine/git";
import { canon } from "../../../src/engine/paths";
import { AgentActivity, AgentState, CardAgent, Run, PrEntryMap, PrFacts } from "../../../src/types";

const prFacts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});
const entries = (...facts: (PrFacts | null)[]): PrEntryMap =>
  Object.fromEntries(facts.map((f, i) => [`repo${i}`, { facts: f, fetchedAt: 0 }]));

const agent = (state: AgentState, lastActivityMs: number): CardAgent => ({
  session: { pid: 1, sessionId: `s-${state}-${lastActivityMs}`, cwd: "/r/svc", startedAt: 1, name: "svc-7e" },
  activity: { state, lastActivityMs, slug: null },
});

describe("mostActive", () => {
  const act = (state: AgentActivity["state"], lastActivityMs: number | null = null): AgentActivity => ({ state, lastActivityMs, slug: null });

  it("is unknown for an empty list", () => {
    expect(mostActive([]).state).toBe("unknown");
  });

  it("ranks working over idle", () => {
    expect(mostActive([act("idle"), act("working")]).state).toBe("working");
  });

  it("ranks needs-you over unknown", () => {
    expect(mostActive([act("unknown"), act("needs-you")]).state).toBe("needs-you");
  });

  it("breaks ties by most-recent activity", () => {
    expect(mostActive([act("idle", 100), act("idle", 200)]).lastActivityMs).toBe(200);
  });

  it("prefers an agent that needs you over one still working", () => {
    // deriveBucket's ladder tests needs-you first and never used to see it: the
    // old rank discarded it in favour of any working session. Three agents busy
    // and one waiting on you is Action required, not In progress.
    const picked = mostActive([
      { state: "working", lastActivityMs: 9_000, slug: null },
      { state: "needs-you", lastActivityMs: 1_000, slug: null },
    ]);
    expect(picked.state).toBe("needs-you");
  });

  it("prefers a stalled agent over a working one — the stuck one needs a human", () => {
    expect(mostActive([
      { state: "working", lastActivityMs: 200, slug: null },
      { state: "stalled", lastActivityMs: 100, slug: null },
    ]).state).toBe("stalled");
  });

  it("still prefers needs-you over stalled", () => {
    expect(mostActive([
      { state: "stalled", lastActivityMs: 200, slug: null },
      { state: "needs-you", lastActivityMs: 100, slug: null },
    ]).state).toBe("needs-you");
  });

  it("carries midWork through the reduction on the reading that won", () => {
    expect(mostActive([
      { state: "idle", lastActivityMs: 200, slug: null, midWork: false },
      { state: "stalled", lastActivityMs: 100, slug: null, midWork: true },
    ]).midWork).toBe(true);
  });
});

describe("buildRunStatus", () => {
  const NOW = 1_800_000_000_000;
  let root: string;
  let repoPath: string;
  let projRoot: string;
  let run: Run;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-"));
    repoPath = path.join(root, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    const g = (...a: string[]) => execFileSync("git", ["-C", repoPath, ...a], { stdio: ["ignore", "pipe", "ignore"] });
    g("init", "-q");
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "T");
    fs.writeFileSync(path.join(repoPath, "f.txt"), "a\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    fs.appendFileSync(path.join(repoPath, "f.txt"), "b\n"); // dirty

    projRoot = path.join(root, "projects");
    const tdir = path.join(projRoot, encodeProjectDir(repoPath));
    fs.mkdirSync(tdir, { recursive: true });
    const tfile = path.join(tdir, "s.jsonl");
    fs.writeFileSync(tfile, JSON.stringify({ type: "assistant", slug: "wip", message: { stop_reason: "tool_use" } }) + "\n");
    fs.utimesSync(tfile, NOW / 1000, NOW / 1000); // fresh → working

    run = {
      key: "ASM-9", summary: "do a thing", url: "https://x/ASM-9", createdAt: 1, mode: "per-window",
      repos: [{ name: "repo", path: repoPath, isGit: true, branch: "main" }], briefPaths: [],
    };
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("combines a live working agent + in-progress Jira into the In-progress column", () => {
    const s = buildRunStatus({ run, ticket: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW });
    expect(s.column).toBe("progress");
    expect(s.agent.state).toBe("working");
    expect(s.repos[0].dirty).toBe(true);
  });

  it("keeps a Jira-done run with a working agent in In progress — there is no Done column", () => {
    // The board holds live work only. A done ticket somebody still has an agent
    // running against is live work; `shelfFor` is what takes it off the board
    // once the agent closes, not a column here.
    const s = buildRunStatus({ run, ticket: { status: "Done", category: "done" }, projectsRoot: projRoot, nowMs: NOW });
    expect(s.column).toBe("progress");
  });

  it("still renders the backbone with no Jira info", () => {
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW });
    expect(s.repos[0].name).toBe("repo");
    expect(s.ticketStatus).toBeNull();
  });

  it("marks windowOpen when the run's target is an open window identity", () => {
    const ids = new Set([fs.realpathSync(repoPath)]);
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW, openIdentities: ids });
    expect(s.windowOpen).toBe(true);
  });

  it("leaves windowOpen false when no identity matches", () => {
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW, openIdentities: new Set(["/somewhere/else"]) });
    expect(s.windowOpen).toBe(false);
  });

  it("defaults windowOpen to false when no identities are passed", () => {
    expect(buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW }).windowOpen).toBe(false);
  });

  it("defaults prs to an empty map when none are passed", () => {
    expect(buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW }).prs).toEqual({});
  });

  it("threads PR entries through onto the status", () => {
    const prs = entries(prFacts());
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW, openIdentities: new Set(), prs });
    expect(s.prs).toBe(prs);
  });

  it("promotes a run with a conflicting PR into Needs you despite a working agent", () => {
    const s = buildRunStatus({
      run, ticket: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW,
      openIdentities: new Set(), prs: entries(prFacts({ mergeable: "conflicting" })),
    });
    expect(s.agent.state).toBe("working");
    expect(s.column).toBe("needs");
  });

  it("gives a run whose PR is approved and green the Ready-to-merge column, over its working agent", () => {
    const s = buildRunStatus({
      run, ticket: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW,
      openIdentities: new Set(), prs: entries(prFacts({ review: "approved" })),
    });
    expect(s.agent.state).toBe("working");
    expect(s.column).toBe("merge");
  });

  it("claims no column for a merged PR — the run leaves the board instead", () => {
    const s = buildRunStatus({
      run, ticket: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW,
      openIdentities: new Set(), prs: entries(prFacts({ state: "MERGED" })),
    });
    expect(s.column).toBe("progress");
  });

  describe("buildRunStatus with open sessions", () => {
    it("is decided by the sessions, not by the newest transcript", () => {
      const s = buildRunStatus({
        run, ticket: null, projectsRoot: projRoot, nowMs: NOW,
        agents: [agent("working", NOW - 1_000), agent("needs-you", NOW - 60_000)],
      });
      expect(s.agent.state).toBe("needs-you");
      expect(s.column).toBe("needs");
      expect(s.agents).toHaveLength(2);
    });

    it("keeps a card's per-repo state when no session is open for it", () => {
      // A tracked run whose agent has since exited must not drop to parked.
      const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: NOW, agents: [] });
      expect(s.agent.state).not.toBe("unknown");
      expect(s.agents).toEqual([]);
    });

    it("unions the per-session and per-repo signals rather than using the per-repo read only when no session is open", () => {
      // Its own repo and transcript, isolated from the outer `run`/`repoPath`
      // fixture (shared "working" reading every other case here depends on):
      // this one needs its per-repo signal to resolve to needs-you specifically.
      const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-union-"));
      const localRepo = path.join(localRoot, "repo");
      fs.mkdirSync(localRepo, { recursive: true });
      const g = (...a: string[]) => execFileSync("git", ["-C", localRepo, ...a], { stdio: ["ignore", "pipe", "ignore"] });
      g("init", "-q");
      g("config", "user.email", "t@t.dev");
      g("config", "user.name", "T");
      fs.writeFileSync(path.join(localRepo, "f.txt"), "a\n");
      g("add", "-A");
      g("commit", "-q", "-m", "init");

      const localProjRoot = path.join(localRoot, "projects");
      const tdir = path.join(localProjRoot, encodeProjectDir(localRepo));
      fs.mkdirSync(tdir, { recursive: true });
      const tfile = path.join(tdir, "s.jsonl");
      // end_turn → readAgentActivity reads this repo's own signal as needs-you,
      // regardless of age (deriveActivity treats end_turn as actionable at any age).
      fs.writeFileSync(tfile, JSON.stringify({ type: "assistant", slug: "wip", message: { stop_reason: "end_turn" } }) + "\n");
      fs.utimesSync(tfile, NOW / 1000, NOW / 1000);

      const localRun: Run = {
        key: "ASM-10", summary: "x", url: "https://x/ASM-10", createdAt: 1, mode: "per-window",
        repos: [{ name: "repo", path: localRepo, isGit: true, branch: "main" }], briefPaths: [],
      };
      const s = buildRunStatus({
        run: localRun, ticket: null, projectsRoot: localProjRoot, nowMs: NOW,
        agents: [agent("idle", NOW - 5_000)],
      });
      // A "sessions-only when present" fallback would stop at the idle session
      // and never read the per-repo signal at all, reporting idle instead.
      expect(s.agent.state).toBe("needs-you");
      fs.rmSync(localRoot, { recursive: true, force: true });
    });
  });

  describe("buildRunStatus's branch reuse (F3)", () => {
    it("reuses a local card's already-known branch instead of re-reading it", () => {
      // A local card's `run.repos[].branch` was read moments earlier, in this
      // same refresh tick, by whatever inferred its ticket. gitState must reuse
      // it rather than pay for a second, redundant `rev-parse` — proven by
      // declaring a branch that is NOT the repo's real one and getting it back
      // unchanged.
      const localRun: Run = { ...run, kind: "local", repos: [{ ...run.repos[0], branch: "stale-declared-branch" }] };
      const s = buildRunStatus({ run: localRun, ticket: null, projectsRoot: projRoot, nowMs: NOW });
      expect(s.repos[0].branch).toBe("stale-declared-branch");
    });

    it("still reads a tracked run's branch live, never trusting the stored one", () => {
      // The byte-identical guarantee: a stored branch can go stale the moment
      // somebody checks out something else, so only a LOCAL run's own reuse
      // (above) may shortcut it. `run` here carries no `kind`, same as every
      // record written before local cards existed.
      const trackedRun: Run = { ...run, repos: [{ ...run.repos[0], branch: "stale-declared-branch" }] };
      const s = buildRunStatus({ run: trackedRun, ticket: null, projectsRoot: projRoot, nowMs: NOW });
      expect(s.repos[0].branch).toBe(currentBranch(repoPath));
      expect(s.repos[0].branch).not.toBe("stale-declared-branch");
    });
  });

  describe("buildRunStatus's activityRoots (F2)", () => {
    it("withholds a sibling root's transcript vote when activityRoots omits it, and votes with it when absent", () => {
      // F2, human ruling: a local grouped run's repos now include idle sibling
      // roots. A warm "ended turn" transcript sitting in one must not out-rank
      // the signal from the root the session is actually in. `activityRoots`
      // absent — a tracked run's default — must still read every repo, exactly
      // as before this field existed.
      const own = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-own-"));
      const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-sibling-"));
      const activityProjRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-activity-"));
      const writeTranscript = (repoDir: string, stopReason: string): void => {
        const tdir = path.join(activityProjRoot, encodeProjectDir(repoDir));
        fs.mkdirSync(tdir, { recursive: true });
        const tfile = path.join(tdir, "s.jsonl");
        fs.writeFileSync(tfile, JSON.stringify({ type: "assistant", slug: "wip", message: { stop_reason: stopReason } }) + "\n");
        fs.utimesSync(tfile, NOW / 1000, NOW / 1000);
      };
      writeTranscript(sibling, "end_turn"); // reads needs-you (rank 3) if it gets to vote
      writeTranscript(own, "tool_use"); // reads working (rank 2)

      const localRun: Run = {
        key: "local-x", summary: "x", url: "", createdAt: 1, mode: "multiroot", kind: "local",
        repos: [
          { name: "own", path: own, isGit: false },
          { name: "sibling", path: sibling, isGit: false },
        ],
        briefPaths: [],
      };
      // canon(own), not `own` itself: buildRunStatus compares against
      // `canon(r.path)` (a real repo path can resolve through a symlinked temp
      // dir — /tmp -> /private/tmp on macOS), and deckView.ts's own caller
      // builds this same set from already-canonicalized places.
      const restricted = buildRunStatus({
        run: localRun, ticket: null, projectsRoot: activityProjRoot, nowMs: NOW,
        activityRoots: new Set([canon(own)]),
      });
      expect(restricted.agent.state).toBe("working"); // sibling's needs-you never got a vote

      const unrestricted = buildRunStatus({ run: localRun, ticket: null, projectsRoot: activityProjRoot, nowMs: NOW });
      expect(unrestricted.agent.state).toBe("needs-you"); // no restriction: the sibling votes and wins

      fs.rmSync(own, { recursive: true, force: true });
      fs.rmSync(sibling, { recursive: true, force: true });
      fs.rmSync(activityProjRoot, { recursive: true, force: true });
    });
  });

  const LATER = NOW + 10 * 60_000; // the shared tool_use transcript is now stale

  it("promotes a stale mid-work transcript with no live session to exited", () => {
    const s = buildRunStatus({ run, ticket: null, projectsRoot: projRoot, nowMs: LATER });
    expect(s.agent.state).toBe("exited");
  });

  it("leaves a stale mid-work transcript as stalled while a session is still live", () => {
    // stalled (4) outranks working (2), so the reduction keeps the per-repo
    // reading — and its midWork is not promoted, because an agent is open.
    const s = buildRunStatus({
      run, ticket: null, projectsRoot: projRoot, nowMs: LATER,
      agents: [agent("working", LATER)],
    });
    expect(s.agent.state).toBe("stalled");
  });

  describe("buildRunStatus and a finished turn", () => {
    let endRoot: string;
    let endProj: string;
    let endRun: Run;

    beforeAll(() => {
      endRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-status-end-"));
      const repo = path.join(endRoot, "repo");
      fs.mkdirSync(repo, { recursive: true });
      endProj = path.join(endRoot, "projects");
      const tdir = path.join(endProj, encodeProjectDir(repo));
      fs.mkdirSync(tdir, { recursive: true });
      const tfile = path.join(tdir, "s.jsonl");
      fs.writeFileSync(tfile, JSON.stringify({ type: "assistant", slug: "done", message: { stop_reason: "end_turn" } }) + "\n");
      fs.utimesSync(tfile, NOW / 1000, NOW / 1000);
      endRun = {
        key: "ASM-10", summary: "finished", url: "https://x/ASM-10", createdAt: 1, mode: "per-window",
        repos: [{ name: "repo", path: repo, isGit: true, branch: "main" }], briefPaths: [],
      };
    });

    afterAll(() => fs.rmSync(endRoot, { recursive: true, force: true }));

    // An agent that handed control back and closed is not "exited" — it finished.
    it("does not promote a finished turn to exited, however old", () => {
      const s = buildRunStatus({ run: endRun, ticket: null, projectsRoot: endProj, nowMs: NOW + 6 * 60 * 60_000 });
      expect(s.agent.state).toBe("needs-you");
    });
  });
});
