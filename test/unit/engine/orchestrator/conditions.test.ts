import { describe, it, expect } from "vitest";
import { evalCond, CondContext, describeCond, placeActivity } from "../../../../src/engine/orchestrator/conditions";
import { Condition } from "../../../../src/engine/orchestrator/model";
import { AgentState, CardAgent, PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";

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
  key: "ASM-1", summary: "s", url: "https://j/browse/ASM-1", createdAt: 1,
  mode: "multiroot", repos: [{ name: REPO, path: `/r/${REPO}`, isGit: true }], briefPaths: [],
};

const ctx = (over: Partial<RunStatus> = {}, prs: PrEntryMap = {}): CondContext => ({
  repo: REPO,
  nowMs: NOW,
  status: {
    run, column: "progress", jiraStatus: null, jiraCategory: null,
    repos: [git()], agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs, agents: [], ...over,
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
        run: multiRepoRun, column: "progress", jiraStatus: null, jiraCategory: null,
        repos: [git({ name: "api" }), git({ name: "web" })],
        agent: { state: "needs-you", lastActivityMs: NOW, slug: null }, // the web agent, aggregated
        windowOpen: false, prs: {},
        agents: [cardAgent("needs-you", NOW, "web")],
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

describe("evalCond — Jira", () => {
  it("ticket-done reads the category", () => {
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: "done" }))).toBe(true);
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: "indeterminate" }))).toBe(false);
    expect(met({ kind: "ticket-done" }, ctx({ jiraCategory: null }))).toBe(false);
  });

  it("ticket-status-is matches the exact status", () => {
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "PR initiated" }))).toBe(true);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "In Progress" }))).toBe(false);
    expect(met({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: null }))).toBe(false);
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
      .toBe("agent state unknown");
  });

  it("describes agent-idle-over while the agent is still working, not idle", () => {
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("working", NOW, REPO)] })))
      .toBe("working");
  });

  it("describes agent-idle-over the same as agent-ended-turn for needs-you and unknown", () => {
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("needs-you", NOW, REPO)] })))
      .toBe("ended turn");
    expect(describeCond({ kind: "agent-idle-over", minutes: 10 }, ctx({ agents: [cardAgent("unknown", null, REPO)] })))
      .toBe("agent state unknown");
  });

  it("describes how many agents are in the place", () => {
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [] }))).toBe("no agent");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO)] }))).toBe("1 agent open");
    expect(describeCond({ kind: "no-agent-left" }, ctx({ agents: [cardAgent("idle", NOW, REPO), cardAgent("working", NOW, REPO)] })))
      .toBe("2 agents open");
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

  it("describes Jira", () => {
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: "In Progress" }))).toBe("In Progress");
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: null }))).toBe("no Jira status");
  });

  it("ticket-done reflects the category when the status text disagrees with it — same class of bug as ci-failed/ci-passed above", () => {
    // The predicate reads jiraCategory, not jiraStatus. A status literally
    // named "Done" under a non-"done" category must not describe as plain
    // "Done" (eval is false), and a "done" category with no status text must
    // not describe as plain "no Jira status" (eval is true).
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "Done", jiraCategory: "indeterminate" })))
      .toBe("Done (indeterminate)");
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: null, jiraCategory: "done" })))
      .toBe("no Jira status (done)");
    // Agreement needs no adornment.
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "In Progress", jiraCategory: "indeterminate" })))
      .toBe("In Progress");
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "Done", jiraCategory: "done" })))
      .toBe("Done");
    // A mismatch with no category at all still says so, rather than omitting it.
    expect(describeCond({ kind: "ticket-done" }, ctx({ jiraStatus: "Done", jiraCategory: null })))
      .toBe("Done (no category)");
  });

  it("ticket-status-is falls back to 'no Jira status' too, same as ticket-done", () => {
    expect(describeCond({ kind: "ticket-status-is", status: "PR initiated" }, ctx({ jiraStatus: null })))
      .toBe("no Jira status");
  });
});
