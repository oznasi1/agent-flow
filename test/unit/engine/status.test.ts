import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { mostActive, buildRunStatus } from "../../../src/engine/status";
import { encodeProjectDir } from "../../../src/engine/transcript";
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
    const s = buildRunStatus({ run, jira: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW, liveSignal: true });
    expect(s.column).toBe("progress");
    expect(s.agent.state).toBe("working");
    expect(s.repos[0].dirty).toBe(true);
  });

  it("keeps the git backbone when the live signal is off (agent unknown)", () => {
    const s = buildRunStatus({ run, jira: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW, liveSignal: false });
    expect(s.agent.state).toBe("unknown");
    expect(s.repos[0].dirty).toBe(true);
    expect(s.column).toBe("progress");
  });

  it("puts a Jira-done run in Done despite a working agent", () => {
    const s = buildRunStatus({ run, jira: { status: "Done", category: "done" }, projectsRoot: projRoot, nowMs: NOW, liveSignal: true });
    expect(s.column).toBe("done");
  });

  it("still renders the backbone with no Jira info", () => {
    const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true });
    expect(s.repos[0].name).toBe("repo");
    expect(s.jiraStatus).toBeNull();
  });

  it("marks windowOpen when the run's target is an open window identity", () => {
    const ids = new Set([fs.realpathSync(repoPath)]);
    const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true, openIdentities: ids });
    expect(s.windowOpen).toBe(true);
  });

  it("leaves windowOpen false when no identity matches", () => {
    const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true, openIdentities: new Set(["/somewhere/else"]) });
    expect(s.windowOpen).toBe(false);
  });

  it("defaults windowOpen to false when no identities are passed", () => {
    expect(buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true }).windowOpen).toBe(false);
  });

  it("defaults prs to an empty map when none are passed", () => {
    expect(buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true }).prs).toEqual({});
  });

  it("threads PR entries through onto the status", () => {
    const prs = entries(prFacts());
    const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: true, openIdentities: new Set(), prs });
    expect(s.prs).toBe(prs);
  });

  it("promotes a run with a conflicting PR into Needs you despite a working agent", () => {
    const s = buildRunStatus({
      run, jira: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW,
      liveSignal: true, openIdentities: new Set(), prs: entries(prFacts({ mergeable: "conflicting" })),
    });
    expect(s.agent.state).toBe("working");
    expect(s.column).toBe("needs");
  });

  it("puts a run whose PR merged into Done even when Jira says in progress", () => {
    const s = buildRunStatus({
      run, jira: { status: "In Progress", category: "indeterminate" }, projectsRoot: projRoot, nowMs: NOW,
      liveSignal: true, openIdentities: new Set(), prs: entries(prFacts({ state: "MERGED" })),
    });
    expect(s.column).toBe("done");
  });

  describe("buildRunStatus with open sessions", () => {
    it("is decided by the sessions, not by the newest transcript", () => {
      const s = buildRunStatus({
        run, jira: null, projectsRoot: projRoot, nowMs: NOW,
        agents: [agent("working", NOW - 1_000), agent("needs-you", NOW - 60_000)],
      });
      expect(s.agent.state).toBe("needs-you");
      expect(s.column).toBe("needs");
      expect(s.agents).toHaveLength(2);
    });

    it("keeps a card's per-repo state when no session is open for it", () => {
      // A tracked run whose agent has since exited must not drop to parked.
      const s = buildRunStatus({ run, jira: null, projectsRoot: projRoot, nowMs: NOW, agents: [] });
      expect(s.agent.state).not.toBe("unknown");
      expect(s.agents).toEqual([]);
    });

    it("reports every session as unknown with the live signal off", () => {
      const s = buildRunStatus({
        run, jira: null, projectsRoot: projRoot, nowMs: NOW, liveSignal: false,
        agents: [agent("working", NOW - 1_000)],
      });
      expect(s.agent.state).toBe("unknown");
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
        run: localRun, jira: null, projectsRoot: localProjRoot, nowMs: NOW,
        agents: [agent("idle", NOW - 5_000)],
      });
      // A "sessions-only when present" fallback would stop at the idle session
      // and never read the per-repo signal at all, reporting idle instead.
      expect(s.agent.state).toBe("needs-you");
      fs.rmSync(localRoot, { recursive: true, force: true });
    });
  });
});
