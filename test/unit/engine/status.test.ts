import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { deriveBucket, mostActive, buildRunStatus } from "../../../src/engine/status";
import { encodeProjectDir } from "../../../src/engine/transcript";
import { AgentActivity, Run } from "../../../src/types";

describe("deriveBucket", () => {
  it("puts a Jira-done ticket in Done even if the agent is working", () => {
    expect(deriveBucket({ jiraCategory: "done", agentState: "working" })).toBe("done");
  });

  it("surfaces a needs-you agent even while Jira is in progress", () => {
    expect(deriveBucket({ jiraCategory: "indeterminate", agentState: "needs-you" })).toBe("needs");
  });

  it("keeps a working agent in Working even in a review status (live beats review)", () => {
    expect(deriveBucket({ jiraStatus: "In Review", agentState: "working" })).toBe("working");
  });

  it("puts an idle agent in a review status into In review", () => {
    expect(deriveBucket({ jiraStatus: "In Review", agentState: "idle" })).toBe("review");
  });

  it("treats an open PR as In review when the agent is idle", () => {
    expect(deriveBucket({ prOpen: true, agentState: "idle" })).toBe("review");
  });

  it("keeps a working agent in Working even with an open PR", () => {
    expect(deriveBucket({ prOpen: true, agentState: "working" })).toBe("working");
  });

  it("falls back to Working (in-flight) for an idle, plain in-progress task", () => {
    expect(deriveBucket({ jiraCategory: "indeterminate", jiraStatus: "In Progress", agentState: "idle" })).toBe("working");
  });

  it("falls back to Working for an unknown agent with nothing else", () => {
    expect(deriveBucket({ jiraCategory: "new", agentState: "unknown" })).toBe("working");
  });
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

  it("combines a live working agent + in-progress Jira into the Working column", () => {
    const s = buildRunStatus(run, { status: "In Progress", category: "indeterminate" }, projRoot, NOW, true);
    expect(s.column).toBe("working");
    expect(s.agent.state).toBe("working");
    expect(s.repos[0].dirty).toBe(true);
  });

  it("keeps the git backbone when the live signal is off (agent unknown)", () => {
    const s = buildRunStatus(run, { status: "In Progress", category: "indeterminate" }, projRoot, NOW, false);
    expect(s.agent.state).toBe("unknown");
    expect(s.repos[0].dirty).toBe(true);
    expect(s.column).toBe("working");
  });

  it("puts a Jira-done run in Done despite a working agent", () => {
    const s = buildRunStatus(run, { status: "Done", category: "done" }, projRoot, NOW, true);
    expect(s.column).toBe("done");
  });

  it("still renders the backbone with no Jira info", () => {
    const s = buildRunStatus(run, null, projRoot, NOW, true);
    expect(s.repos[0].name).toBe("repo");
    expect(s.jiraStatus).toBeNull();
  });
});
