import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { evalCond, CondContext, describeCond, placeActivity } from "../../../../src/engine/orchestrator/conditions";
import { BranchCiStatus, branchCiKey } from "../../../../src/engine/orchestrator/branchCi";
import { Condition } from "../../../../src/engine/orchestrator/model";
import { AgentState, CardAgent, PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";
import { deriveActivity, encodeProjectDir, TranscriptLine } from "../../../../src/engine/transcript";
import { buildRunStatus } from "../../../../src/engine/status";

const NOW = 1_800_000_000_000;
const REPO = "agent-flow";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "https://github.com/o/r/pull/1", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

const git = (over: Partial<RepoGit> = {}): RepoGit => ({
  name: REPO, path: `/r/${REPO}`, branch: "main", dirty: false, ahead: 0,
  added: 0, removed: 0, files: 0, ...over,
});

const cardAgent = (state: AgentState, lastActivityMs: number | null, repo?: string): CardAgent => ({
  session: { pid: 1, sessionId: `s-${state}`, cwd: `/r/${REPO}`, startedAt: 1, name: "af-7e" },
  activity: { state, lastActivityMs, slug: null },
  repo,
});

const run: Run = {
  key: "PROJ-1", summary: "s", url: "https://j/browse/PROJ-1", createdAt: 1,
  mode: "multiroot", repos: [{ name: REPO, path: `/r/${REPO}`, isGit: true }], briefPaths: [],
};

const ctx = (over: Partial<RunStatus> = {}, prs: PrEntryMap = {}): CondContext => ({
  repo: REPO,
  nowMs: NOW,
  status: {
    run, column: "progress", ticketStatus: null, ticketCategory: null,
    repos: [git()], agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs, agents: [], shelf: "board", ...over,
  },
});

const pr = (over: Partial<PrFacts> = {}): PrEntryMap => ({ [REPO]: { facts: facts(over), fetchedAt: NOW } });
const met = (cond: Condition, c: CondContext) => evalCond(cond, c);

describe("evalCond — PR and CI", () => {
  it("pr-merged is true only for a merged PR", () => {
    expect(met({ kind: "pr-merged" }, ctx({}, pr({ state: "MERGED" })))).toBe(true);
    expect(met({ kind: "pr-merged" }, ctx({}, pr({ state: "OPEN" })))).toBe(false);
  });

  it("pr-merged is false when the repo has no PR at all", () => {
    expect(met({ kind: "pr-merged" }, ctx())).toBe(false);
    expect(met({ kind: "pr-merged" }, ctx({}, { [REPO]: { facts: null, fetchedAt: NOW } }))).toBe(false);
  });

  it("ci-passed needs at least one passing check and nothing failing or pending", () => {
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [] } })))).toBe(true);
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 4, pending: 3, failing: [] } })))).toBe(false);
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [{ name: "lint", url: "" }] } })))).toBe(false);
  });

  it("ci-passed is false when no check has reported yet", () => {
    expect(met({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 0, pending: 0, failing: [] } })))).toBe(false);
  });

  it("ci-failed fires on a required failure", () => {
    expect(met({ kind: "ci-failed" }, ctx({}, pr({ ci: { passing: 1, pending: 0, failing: [{ name: "build", url: "" }] } })))).toBe(true);
  });

  it("ci-failed does NOT fire when the only failures are advisory", () => {
    // Every required check passed and something optional did not. It does not
    // block a merge, so it must not trigger a fix agent.
    const c = ctx({}, pr({ ci: { passing: 9, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true }));
    expect(met({ kind: "ci-failed" }, c)).toBe(false);
  });

  it("review-approved and changes-requested read the review decision", () => {
    expect(met({ kind: "review-approved" }, ctx({}, pr({ review: "approved" })))).toBe(true);
    expect(met({ kind: "review-approved" }, ctx({}, pr({ review: "review_required" })))).toBe(false);
    expect(met({ kind: "changes-requested" }, ctx({}, pr({ review: "changes_requested" })))).toBe(true);
    expect(met({ kind: "changes-requested" }, ctx({}, pr({ review: "approved" })))).toBe(false);
  });

  it("threads-resolved is true at zero and false when the count was never fetched", () => {
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 0 })))).toBe(true);
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 2 })))).toBe(false);
    // null means the GraphQL call was skipped — absence of evidence, not zero.
    expect(met({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: null })))).toBe(false);
  });

  it("pr-conflicting reads mergeability", () => {
    expect(met({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "conflicting" })))).toBe(true);
    expect(met({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "clean" })))).toBe(false);
  });

  it("reads the node's own repo, not the run's first PR", () => {
    const prs: PrEntryMap = {
      other: { facts: facts({ state: "MERGED" }), fetchedAt: NOW },
      [REPO]: { facts: facts({ state: "OPEN" }), fetchedAt: NOW },
    };
    expect(met({ kind: "pr-merged" }, ctx({}, prs))).toBe(false);
  });
});

describe("evalCond — agent state", () => {
  it("agent-ended-turn is true when the place's agent needs you", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] }))).toBe(true);
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("working", NOW, REPO)] }))).toBe(false);
  });

  it("an agent with no repo belongs to the place anyway", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW)] }))).toBe(true);
  });

  it("ignores an agent that belongs to a different repo", () => {
    expect(met({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, "elsewhere")] }))).toBe(false);
  });

  it("falls back to the run-level state when no agent is attached to the place, for a single-repo run", () => {
    const c = ctx({ agents: [], agent: { state: "needs-you", lastActivityMs: NOW, slug: null } });
    expect(met({ kind: "agent-ended-turn" }, c)).toBe(true);
  });

  it("does NOT fall back to the run-level aggregate for a multi-repo run — that aggregate can be a different repo's agent entirely", () => {
    // A two-repo run ("api", "web") with a live needs-you session in "web" only.
    // The run-level aggregate (`status.agent`, `mostActive` over every repo —
    // see `buildRunStatus`) reads "needs-you" because of the web agent, but a
    // place node bound to "api" has nothing of its own and must read as
    // unknown, not borrow web's state and fire an "api" launch.
    const multiRepoRun: Run = {
      ...run,
      repos: [{ name: "api", path: "/r/api", isGit: true }, { name: "web", path: "/r/web", isGit: true }],
    };
    const c: CondContext = {
      repo: "api",
      nowMs: NOW,
      status: {
        run: multiRepoRun, column: "progress", ticketStatus: null, ticketCategory: null,
        repos: [git({ name: "api" }), git({ name: "web" })],
        agent: { state: "needs-you", lastActivityMs: NOW, slug: null }, // the web agent, aggregated
        windowOpen: false, prs: {},
        agents: [cardAgent("needs-you", NOW, "web")],
        shelf: "board",
      },
    };
    expect(met({ kind: "agent-ended-turn" }, c)).toBe(false);
    expect(placeActivity(c).state).toBe("unknown");
    // The same place simultaneously reads no-agent-left as true — consistent
    // readings of one place, not two contradictory ones.
    expect(met({ kind: "no-agent-left" }, c)).toBe(true);
  });

  it("agent-idle-over compares against the parameterised window", () => {
    const idleFor = (ms: number) => ctx({ agents: [cardAgent("idle", NOW - ms, REPO)] });
    expect(met({ kind: "agent-idle-over", minutes: 10 }, idleFor(11 * 60_000))).toBe(true);
    expect(met({ kind: "agent-idle-over", minutes: 10 }, idleFor(9 * 60_000))).toBe(false);
  });

  it("agent-idle-over is false for an agent that is working, however long ago", () => {
    expect(met({ kind: "agent-idle-over", minutes: 1 }, ctx({ agents: [cardAgent("working", NOW - 99 * 60_000, REPO)] }))).toBe(false);
  });

  it("agent-idle-over is false when the last activity is unknown", () => {
    expect(met({ kind: "agent-idle-over", minutes: 1 }, ctx({ agents: [cardAgent("idle", null, REPO)] }))).toBe(false);
  });

  it("no agent condition can fire while the state is unknown", () => {
    // What the Live signal toggle being off looks like from here.
    const off = ctx({ agents: [cardAgent("unknown", null, REPO)] });
    expect(met({ kind: "agent-ended-turn" }, off)).toBe(false);
    expect(met({ kind: "agent-idle-over", minutes: 0 }, off)).toBe(false);
  });

  it("no-agent-left does not need the Live signal — it reads the session registry", () => {
    // The registry knows a session is open whether or not its transcript is read,
    // so this condition is meaningful even when every state is unknown.
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("unknown", null, REPO)] }))).toBe(false);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe(true);
  });

  it("no-agent-left is true only when the place has no session", () => {
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe(true);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO)] }))).toBe(false);
    expect(met({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, "elsewhere")] }))).toBe(true);
  });

  // Pinning a decision, not a bug fix: `blocked` is deliberately absent from
  // `IDLE_LIKE` (see its doc comment in activity.ts) because a session
  // waiting on your approval is not idle, and this rule auto-nudging past a
  // modal dialog would be worse than not firing at all. That is correct, but
  // it is also a real behaviour change for two released conditions — a stale
  // `Edit`/`Write`/`NotebookEdit`/`Bash`/`AskUserQuestion`/`ExitPlanMode`
  // pending used to read `stalled` (idle-like) and now reads `blocked`
  // (not). These tests exist so a future change to `IDLE_LIKE` or
  // `STATE_RANK` has to consciously break them rather than silently restoring
  // the old firing behaviour.
  it("agent-idle-over does NOT fire on a blocked reading, however stale", () => {
    const c = ctx({ agents: [cardAgent("blocked", NOW - 999 * 60_000, REPO)] });
    expect(met({ kind: "agent-idle-over", minutes: 10 }, c)).toBe(false);
  });

  it("agent-ended-turn does not fire when the place's reduction lands on blocked", () => {
    // One session that ended its turn, one frozen at a gated tool. `blocked`
    // (rank 6) outranks `needs-you` (rank 5) in `mostActive`'s reduction, so
    // the place reads `blocked`, not `needs-you` — and `agent-ended-turn`
    // must not fire on that, even though a `needs-you` session is genuinely
    // present in the same place.
    const c = ctx({
      agents: [cardAgent("needs-you", NOW, REPO), cardAgent("blocked", NOW - 5_000, REPO)],
    });
    expect(placeActivity(c).state).toBe("blocked");
    expect(met({ kind: "agent-ended-turn" }, c)).toBe(false);
  });
});

// Regression for C1: `agent-idle-over` used to compare `state !== "idle"`
// directly, so it silently stopped firing the moment `AgentState` widened to
// name `stalled` and `exited` separately — both used to arrive as plain "idle"
// before that. States here are DERIVED from a transcript (via `deriveActivity`
// and, for "exited", the real `buildRunStatus` promotion), not hand-picked
// literals — a literal `{ state: "stalled", ... }` would keep passing even if
// the fix regressed back to `=== "idle"`, since nothing would ever produce that
// literal through the real pipeline the bug lived in.
describe("evalCond — agent-idle-over treats every idle-like state alike (C1)", () => {
  const line = (o: Partial<TranscriptLine>): TranscriptLine => o;
  const userMsg = line({ type: "user" });
  const asstTool = line({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use" } });

  it("fires for a stalled agent (a stuck tool call), derived from a real transcript reading", () => {
    // Same fixture shape transcript.test.ts uses to pin "a stale tool_use reads
    // as stalled" — reused here rather than asserted again, so this test stays
    // honest about what actually produces the state it exercises.
    const activity = deriveActivity([userMsg, asstTool], NOW - 11 * 60_000, NOW);
    expect(activity.state).toBe("stalled");
    const agent: CardAgent = {
      session: { pid: 1, sessionId: "s-stalled", cwd: `/r/${REPO}`, startedAt: 1, name: "af-7e" },
      activity,
      repo: REPO,
    };
    expect(met({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [agent] }))).toBe(true);
    // Not yet past the threshold: the window comparison itself still applies to
    // a stalled reading exactly as it does to an idle one.
    const fresh = deriveActivity([userMsg, asstTool], NOW - 2 * 60_000, NOW);
    expect(fresh.state).toBe("stalled");
    const freshAgent: CardAgent = { ...agent, activity: fresh };
    expect(met({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [freshAgent] }))).toBe(false);
  });

  describe("an exited agent", () => {
    let projectsRoot: string;
    const cwd = `/r/${REPO}`;

    beforeAll(() => {
      // "exited" is not something `deriveActivity` ever returns on its own — it
      // is `buildRunStatus`'s promotion of a stale midWork reading with no live
      // session behind it (see status.ts). Exercising the real function against
      // a real transcript on disk is what makes this a derived reading rather
      // than a literal nothing in production ever assigns.
      projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flow-cond-idle-"));
      const dir = path.join(projectsRoot, encodeProjectDir(cwd));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "s.jsonl");
      fs.writeFileSync(file, [userMsg, asstTool].map((l) => JSON.stringify(l)).join("\n") + "\n");
      const mtimeMs = NOW - 11 * 60_000;
      fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    });

    afterAll(() => fs.rmSync(projectsRoot, { recursive: true, force: true }));

    it("fires past the threshold", () => {
      const status: RunStatus = buildRunStatus({
        run: { ...run, repos: [{ name: REPO, path: cwd, isGit: true }] },
        ticket: null,
        projectsRoot,
        nowMs: NOW,
        agents: [], // no live session — the fact that promotes the reading to "exited"
      });
      expect(status.agent.state).toBe("exited");
      const c: CondContext = { repo: REPO, nowMs: NOW, status };
      expect(met({ kind: "agent-idle-over", minutes: 10 }, c)).toBe(true);
    });
  });
});

describe("evalCond — git", () => {
  it("tree-clean and has-uncommitted are opposites over a known repo", () => {
    expect(met({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: false })] }))).toBe(true);
    expect(met({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: false })] }))).toBe(false);
    expect(met({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: true })] }))).toBe(false);
    expect(met({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: true })] }))).toBe(true);
  });

  it("both are false when the node's repo is not in the status at all", () => {
    const c = ctx({ repos: [git({ name: "elsewhere" })] });
    expect(met({ kind: "tree-clean" }, c)).toBe(false);
    expect(met({ kind: "has-uncommitted" }, c)).toBe(false);
  });

  it("nothing-to-push is true at zero commits ahead", () => {
    expect(met({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 0 })] }))).toBe(true);
    expect(met({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 2 })] }))).toBe(false);
  });
});

describe("evalCond — ticket source", () => {
  it("ticket-done reads the category", () => {
    expect(met({ kind: "ticket-done" }, ctx({ ticketCategory: "done" }))).toBe(true);
    expect(met({ kind: "ticket-done" }, ctx({ ticketCategory: "indeterminate" }))).toBe(false);
    expect(met({ kind: "ticket-done" }, ctx({ ticketCategory: null }))).toBe(false);
  });

  it("ticket-status-is matches the exact status", () => {
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ ticketStatus: "PR initiated" }))).toBe(true);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ ticketStatus: "In Progress" }))).toBe(false);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ ticketStatus: null }))).toBe(false);
  });
});

describe("evalCond — branch CI", () => {
  // The one condition whose fact does not come out of the `RunStatus`: it names a
  // repo and branch nothing on the board need be sitting on, and the verdicts arrive
  // pre-fetched on `branchCi`. Deliberately a repo that is NOT this context's own
  // (`REPO`), to pin that the condition reads its own `repo`, not the place's.
  const withCi = (branchCi: Record<string, BranchCiStatus>): CondContext => ({ ...ctx(), branchCi });
  const onMaster: Condition = { kind: "branch-ci-passed", repo: "bite-me", branch: "master" };

  it("is met only when that repo and branch passed", () => {
    expect(met(onMaster, withCi({ "bite-me#master": "passed" }))).toBe(true);
    expect(met(onMaster, withCi({ "bite-me#master": "failed" }))).toBe(false);
    expect(met(onMaster, withCi({ "bite-me#master": "pending" }))).toBe(false);
    // Another repo's master being green says nothing about this one.
    expect(met(onMaster, withCi({ "api#master": "passed" }))).toBe(false);
  });

  // The worst outcome available: deploying because an API call failed.
  it("is NOT met when the branch status is unknown or absent", () => {
    expect(met(onMaster, withCi({ "bite-me#master": "unknown" }))).toBe(false);
    expect(met(onMaster, withCi({}))).toBe(false);
    // No map at all — a pass that fetched nothing, e.g. with PR facts off.
    expect(met(onMaster, ctx())).toBe(false);
  });

  it("does not confuse two branches of the same repo", () => {
    // Keyed through `branchCiKey` — the same function `deckView.ts` writes with —
    // rather than with two hand-written strings, so a key that dropped its branch
    // half would make these two entries COLLIDE here exactly as they would in the
    // real cache (the second write winning), instead of merely missing.
    const both = withCi({
      [branchCiKey("bite-me", "main")]: "passed",
      [branchCiKey("bite-me", "release")]: "failed",
    });
    expect(met({ kind: "branch-ci-passed", repo: "bite-me", branch: "main" }, both)).toBe(true);
    expect(met({ kind: "branch-ci-passed", repo: "bite-me", branch: "release" }, both)).toBe(false);
  });

  it("is not fooled by a key that only looks right", () => {
    // `main` must not read `main-2`'s verdict, in either direction.
    expect(met({ kind: "branch-ci-passed", repo: "bite-me", branch: "main" }, withCi({ "bite-me#main-2": "passed" })))
      .toBe(false);
    expect(met({ kind: "branch-ci-passed", repo: "bite", branch: "me#main" }, withCi({ "bite-me#main": "passed" })))
      .toBe(false);
  });
});

describe("describeCond", () => {
  it("describes CI progress rather than the condition's name", () => {
    expect(describeCond({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 4, pending: 3, failing: [] } }))))
      .toBe("CI running, 4 of 7");
  });

  it("names the failing checks", () => {
    const c = ctx({}, pr({ ci: { passing: 5, pending: 0, failing: [{ name: "build", url: "" }, { name: "lint", url: "" }] } }));
    expect(describeCond({ kind: "ci-failed" }, c)).toBe("build, lint failing");
  });

  it("marks ci-failed's description advisory when that is the only reason it won't fire, but leaves ci-passed's wording alone", () => {
    // Same fixture, both kinds: ci-failed's predicate is false here (advisory
    // failures don't block a merge), and its description must say so or the
    // drawer shows "waiting · lint failing" beside a rule that will never fire
    // on that basis. ci-passed's predicate is also false here, for the same
    // "X failing" reason either way, so its wording is correct unchanged.
    const c = ctx({}, pr({ ci: { passing: 9, pending: 0, failing: [{ name: "flaky-e2e", url: "" }] }, ciAdvisory: true }));
    expect(describeCond({ kind: "ci-failed" }, c)).toBe("flaky-e2e failing (advisory)");
    expect(describeCond({ kind: "ci-passed" }, c)).toBe("flaky-e2e failing");
  });

  it("counts passing checks when nothing is failing or pending", () => {
    expect(describeCond({ kind: "ci-passed" }, ctx({}, pr({ ci: { passing: 7, pending: 0, failing: [] } }))))
      .toBe("7 checks passing");
  });

  it("says no checks yet when nothing has reported at all", () => {
    const c = ctx({}, pr({ ci: { passing: 0, pending: 0, failing: [] } }));
    expect(describeCond({ kind: "ci-passed" }, c)).toBe("no checks yet");
    expect(describeCond({ kind: "ci-failed" }, c)).toBe("no checks yet");
  });

  it("says so when there is no PR to describe", () => {
    expect(describeCond({ kind: "pr-merged" }, ctx())).toBe("no PR yet");
  });

  it("says so when there is no PR to describe, for every other PR-gated condition", () => {
    expect(describeCond({ kind: "ci-passed" }, ctx())).toBe("no PR yet");
    expect(describeCond({ kind: "review-approved" }, ctx())).toBe("no PR yet");
    expect(describeCond({ kind: "threads-resolved" }, ctx())).toBe("no PR yet");
    expect(describeCond({ kind: "pr-conflicting" }, ctx())).toBe("no PR yet");
  });

  it("describes a closed (not merged) PR", () => {
    expect(describeCond({ kind: "pr-merged" }, ctx({}, pr({ state: "CLOSED" })))).toBe("PR closed");
  });

  it("describes a PR with no review activity yet", () => {
    expect(describeCond({ kind: "review-approved" }, ctx({}, pr({ review: "none" })))).toBe("no review yet");
  });

  it("describes a PR's state and review", () => {
    expect(describeCond({ kind: "pr-merged" }, ctx({}, pr({ state: "MERGED" })))).toBe("merged");
    expect(describeCond({ kind: "pr-merged" }, ctx({}, pr({ state: "OPEN" })))).toBe("PR open");
    expect(describeCond({ kind: "review-approved" }, ctx({}, pr({ review: "approved" })))).toBe("approved");
    expect(describeCond({ kind: "review-approved" }, ctx({}, pr({ review: "review_required" })))).toBe("review required");
    expect(describeCond({ kind: "changes-requested" }, ctx({}, pr({ review: "changes_requested" })))).toBe("changes requested");
  });

  it("describes threads and mergeability", () => {
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 2 })))).toBe("2 unresolved");
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: 0 })))).toBe("no unresolved threads");
    expect(describeCond({ kind: "threads-resolved" }, ctx({}, pr({ unresolved: null })))).toBe("threads not checked");
    expect(describeCond({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "conflicting" })))).toBe("conflicting");
    expect(describeCond({ kind: "pr-conflicting" }, ctx({}, pr({ mergeable: "clean" })))).toBe("mergeable: clean");
  });

  it("describes agent state, and admits when it cannot see one", () => {
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("working", NOW, REPO)] }))).toBe("working");
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] }))).toBe("ended turn");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("idle", NOW - 4 * 60_000, REPO)] })))
      .toBe("idle 4m of 10m");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("idle", null, REPO)] })))
      .toBe("last activity unknown");
    expect(describeCond({ kind: "agent-ended-turn" }, ctx({ agents: [cardAgent("unknown", null, REPO)] })))
      .toBe("session state unknown");
  });

  it("describes agent-idle-over while the agent is still working, not idle", () => {
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("working", NOW, REPO)] })))
      .toBe("working");
  });

  it("describes agent-idle-over the same as agent-ended-turn for needs-you and unknown", () => {
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] })))
      .toBe("ended turn");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("unknown", null, REPO)] })))
      .toBe("session state unknown");
  });

  it("describes how many agents are in the place", () => {
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe("no sessions");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO)] }))).toBe("1 session open");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO), cardAgent("working", NOW, REPO)] })))
      .toBe("2 sessions open");
  });

  it("describes git state", () => {
    expect(describeCond({ kind: "tree-clean" }, ctx({ repos: [git({ dirty: false })] }))).toBe("clean");
    expect(describeCond({ kind: "has-uncommitted" }, ctx({ repos: [git({ dirty: true, added: 412, removed: 38, files: 9 })] })))
      .toBe("+412 −38 · 9 files");
    expect(describeCond({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 2 })] }))).toBe("2 to push");
    expect(describeCond({ kind: "nothing-to-push" }, ctx({ repos: [git({ ahead: 0 })] }))).toBe("nothing to push");
    expect(describeCond({ kind: "tree-clean" }, ctx({ repos: [git({ name: "elsewhere" })] }))).toBe("repo not found");
    expect(describeCond({ kind: "nothing-to-push" }, ctx({ repos: [git({ name: "elsewhere" })] }))).toBe("repo not found");
  });

  it("describes the ticket status", () => {
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ ticketStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: null }))).toBe("no ticket status");
  });

  it("ticket-done reflects the category when the status text disagrees with it — same class of bug as ci-failed/ci-passed above", () => {
    // The predicate reads ticketCategory, not ticketStatus. A status literally
    // named "Done" under a non-"done" category must not describe as plain
    // "Done" (eval is false), and a "done" category with no status text must
    // not describe as plain "no ticket status" (eval is true).
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: "Done", ticketCategory: "indeterminate" })))
      .toBe("Done (indeterminate)");
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: null, ticketCategory: "done" })))
      .toBe("no ticket status (done)");
    // Agreement needs no adornment.
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: "In Progress", ticketCategory: "indeterminate" })))
      .toBe("In Progress");
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: "Done", ticketCategory: "done" })))
      .toBe("Done");
    // A mismatch with no category at all still says so, rather than omitting it.
    expect(describeCond({ kind: "ticket-done" }, ctx({ ticketStatus: "Done", ticketCategory: null })))
      .toBe("Done (no category)");
  });

  it("ticket-status-is falls back to 'no ticket status' too, same as ticket-done", () => {
    expect(describeCond({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ ticketStatus: null })))
      .toBe("no ticket status");
  });

  it("branch-ci-passed names the branch, because the rule's own label cannot", () => {
    const cond: Condition = { kind: "branch-ci-passed", repo: "bite-me", branch: "master" };
    const withCi = (branchCi: Record<string, BranchCiStatus>): CondContext => ({ ...ctx(), branchCi });
    expect(describeCond(cond, withCi({ "bite-me#master": "passed" }))).toBe("master passed");
    expect(describeCond(cond, withCi({ "bite-me#master": "failed" }))).toBe("master failed");
    expect(describeCond(cond, withCi({ "bite-me#master": "pending" }))).toBe("master CI running");
  });

  it("branch-ci-passed tells 'nobody fetched it' apart from 'nobody could read it'", () => {
    const cond: Condition = { kind: "branch-ci-passed", repo: "bite-me", branch: "master" };
    // Equally not-met, different next step for the reader: an absent key is what the
    // webview always sees (the verdicts never cross the wire), while an explicit
    // `unknown` means a call was made and came back unreadable.
    expect(describeCond(cond, ctx())).toBe("master not checked yet");
    expect(describeCond(cond, { ...ctx(), branchCi: {} })).toBe("master not checked yet");
    expect(describeCond(cond, { ...ctx(), branchCi: { "bite-me#master": "unknown" } })).toBe("master status unreadable");
  });
});

describe("evalCond and describeCond — command-succeeded is unreachable here, loudly", () => {
  // Neither function can answer this kind from one place's `CondContext` — the
  // verdict lives on a command node's incoming edge, which needs the whole
  // `Flow` (see `evaluate.ts`'s `commandSucceeded`, and this kind's own arm
  // comments in conditions.ts). Both arms throw rather than guess, so a future
  // second caller gets a loud failure instead of a confidently wrong answer.
  it("evalCond throws for command-succeeded", () => {
    expect(() => evalCond({ kind: "command-succeeded" }, ctx())).toThrow();
  });

  it("describeCond throws for command-succeeded", () => {
    expect(() => describeCond({ kind: "command-succeeded" }, ctx())).toThrow();
  });
});
