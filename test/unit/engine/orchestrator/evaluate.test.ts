import { describe, it, expect } from "vitest";
import { evaluateDeadlines, evaluateFlow, MAX_LAUNCHES_PER_PASS } from "../../../../src/engine/orchestrator/evaluate";
import { BranchCiStatus } from "../../../../src/engine/orchestrator/branchCi";
import {
  CommandNode, Flow, FlowEdge, FlowNode, GateNode, JoinMode, NotifyNode, PlaceNode, PlannedNode, emptyFlow,
} from "../../../../src/engine/orchestrator/model";
import { CardAgent, PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";

const NOW = 1_800_000_000_000;

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

/** A status for `key` whose single repo is named after the key, merged or not. */
const status = (key: string, over: { merged?: boolean; agents?: CardAgent[]; unknownAgent?: boolean } = {}): RunStatus => {
  const repo = `repo-${key}`;
  const git: RepoGit = { name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 };
  const run: Run = { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] };
  const prs: PrEntryMap = { [repo]: { facts: facts({ state: over.merged ? "MERGED" : "OPEN" }), fetchedAt: NOW } };
  return {
    run, column: "progress", ticketStatus: null, ticketCategory: null, repos: [git],
    agent: { state: over.unknownAgent ? "unknown" : "working", lastActivityMs: NOW, slug: null },
    windowOpen: false, prs, agents: over.agents ?? [],
    shelf: "board",
  };
};

// Concrete node types with an explicit join, so no test needs a cast to reach it.
const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const planned = (id: string, join: JoinMode = "any"): PlannedNode =>
  ({ id, kind: "planned", x: 0, y: 0, join, ticketKey: "PROJ-99", repos: ["r"], mode: "tdd", dest: "worktree" });
const notify = (id: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message: "done" });
const command = (id: string, join: JoinMode = "any"): CommandNode =>
  ({ id, kind: "command", x: 0, y: 0, join, run: "deploy.sh" });

const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[], armed = true): Flow =>
  ({ ...emptyFlow("f1", "f", 0), armed, nodes, edges });

const run = (flow: Flow, statuses: RunStatus[], maxLaunches?: number) =>
  evaluateFlow({ flow, statuses, nowMs: NOW, maxLaunches });

describe("evaluateFlow — a condition kind this build does not know", () => {
  it("reads a newer build's unknown kind as not met, and does not throw", () => {
    // The forward-compat contract the store already tests from its side: an
    // unknown `cond.kind` is KEPT on read, so an armed flow written by a newer
    // build hands this pass one every 6s. It must wait — not fire, not crash.
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "moon-is-full" } as unknown as FlowEdge["cond"] })]);
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — arming and the latch", () => {
  it("yields nothing for a disarmed flow, even when the condition is met", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")], false);
    expect(run(flow, [status("PROJ-1", { merged: true })])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("fires a met edge exactly once", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    const first = run(flow, [status("PROJ-1", { merged: true })]);
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e1"]);

    // The runner stamps firedAt; the next pass must skip it.
    flow.edges[0].firedAt = NOW;
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired).toEqual([]);
  });

  it("never re-evaluates an edge whose action errored", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z", { error: "worktree exists" })]);
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired).toEqual([]);
  });

  it("does not fire an unmet edge", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("PROJ-1", { merged: false })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — nodes it cannot evaluate", () => {
  it("blocks an edge whose source run is gone", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, []); // no status for PROJ-1 — the run was forgotten
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("does not block an edge from a planned node — it is simply not launched yet", () => {
    const flow = flowWith([planned("p"), notify("z")], [edge("e1", "p", "z")]);
    expect(run(flow, [])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("blocks an agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "agent-ended-turn" } })]);
    const r = run(flow, [status("PROJ-1", { unknownAgent: true })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "agent-state-unknown" }]);
  });

  it("blocks an agent condition when the place's own repo has no agent, even while a different repo's agent in the same run is live", () => {
    // The guard must read the SAME per-place activity `evalCond` uses, not the
    // unfiltered run aggregate — otherwise a live agent in a different repo
    // masks the fact that this place's own repo has nothing readable, and the
    // condition waits forever with no note explaining why.
    const otherRepoAgent: CardAgent = {
      session: { pid: 1, sessionId: "s-1", cwd: "/r/repo-other", startedAt: 1, name: "af-1" },
      activity: { state: "working", lastActivityMs: NOW, slug: null },
      repo: "repo-other",
    };
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "agent-ended-turn" } })]);
    const r = run(flow, [status("PROJ-1", { unknownAgent: true, agents: [otherRepoAgent] })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "agent-state-unknown" }]);
  });

  it("blocks an agent condition for a multi-repo run whose place has no agent, even when the run-level aggregate is a live needs-you from another repo", () => {
    // The bug this pins: `status.agent` is `mostActive` over EVERY repo in the
    // run (`buildRunStatus`). A two-repo run ("api", "web") with a live
    // needs-you session in "web" only, and a place node bound to "api", must
    // not fire "api"'s launch edge just because "web" ended its turn — that is
    // a wrong, paid launch. It must block with `agent-state-unknown` instead.
    const apiAgent: CardAgent = {
      session: { pid: 1, sessionId: "s-web", cwd: "/r/web", startedAt: 1, name: "af-1" },
      activity: { state: "needs-you", lastActivityMs: NOW, slug: null },
      repo: "web",
    };
    const s = status("PROJ-1");
    const multiRepoStatus: RunStatus = {
      ...s,
      run: { ...s.run, repos: [{ name: "api", path: "/r/api", isGit: true }, { name: "web", path: "/r/web", isGit: true }] },
      agent: { state: "needs-you", lastActivityMs: NOW, slug: null }, // web's activity, aggregated
      agents: [apiAgent],
    };
    const flow = flowWith([{ ...place("a", "PROJ-1"), repo: "api" }, notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "agent-ended-turn" }, action: "launch", mode: "tdd" })]);
    const r = run(flow, [multiRepoStatus]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "agent-state-unknown" }]);
  });

  it("does not block a non-agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, [status("PROJ-1", { merged: true, unknownAgent: true })]);
    expect(r.blocked).toEqual([]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("reports a gone node once, not once per edge leaving it", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("y"), notify("z")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    expect(run(flow, []).blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("ignores an edge whose target does not exist", () => {
    const flow = flowWith([place("a", "PROJ-1")], [edge("e1", "a", "missing")]);
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — join", () => {
  const twoIn = (join: "any" | "all") =>
    flowWith([place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", join)],
      [edge("e1", "a", "z"), edge("e2", "b", "z")]);

  it("with join any, each met edge fires on its own", () => {
    const r = run(twoIn("any"), [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: false })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("with join all, one met edge fires nothing", () => {
    const r = run(twoIn("all"), [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: false })]);
    expect(r.fired).toEqual([]);
  });

  it("with join all, every edge fires once the last one is met", () => {
    const r = run(twoIn("all"), [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
  });

  it("with join all, an already-fired edge counts as met, and the first still-pending edge performs", () => {
    const flow = twoIn("all");
    flow.edges[0].firedAt = NOW - 1;
    const r = run(flow, [status("PROJ-1", { merged: false }), status("PROJ-2", { merged: true })]);
    // e1 is settled and cannot perform again; e2, the first still-pending edge,
    // both fires and performs.
    expect(r.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([
      { id: "e2", perform: true },
    ]);
  });

  it("with join all, an error on any incoming edge stops the junction dead, with no blocked note from it", () => {
    // "a" has no status at all, which would normally be a "gone" blocked note —
    // but the errored edge must never even reach `met`, so no note appears, and
    // the junction (including its non-errored sibling) fires nothing until the
    // errored edge is reset. Otherwise the next-pending edge would quietly take
    // over as performer, re-running the action under a different edge.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "all")],
      [edge("e1", "a", "z", { error: "worktree exists" }), edge("e2", "b", "z")]);
    const r = run(flow, [status("PROJ-2", { merged: true })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  it("with join all, the action performed is the first incoming edge's", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "seed", mode: "plan" })]);
    const r = run(flow, [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })]);
    expect(r.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([
      { id: "e1", perform: true },
      { id: "e2", perform: false },
    ]);
  });

  it("join is irrelevant to a target with a single incoming edge", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "all")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });
});

describe("evaluateFlow — the launch cap", () => {
  const manyLaunches = (n: number) => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < n; i++) {
      nodes.push(place(`a${i}`, `PROJ-${i}`), planned(`p${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `p${i}`, { action: "launch", mode: "tdd" }));
    }
    return { flow: flowWith(nodes, edges), statuses: Array.from({ length: n }, (_, i) => status(`PROJ-${i}`, { merged: true })) };
  };

  it("caps acting edges at the default and counts the rest as deferred", () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS + 2);
    const r = run(flow, statuses);
    expect(r.fired).toHaveLength(MAX_LAUNCHES_PER_PASS);
    expect(r.deferred).toBe(2);
  });

  it("caps in flow order, so a deferred edge is the last one", () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS + 1);
    const r = run(flow, statuses);
    expect(r.fired.map((f) => f.edge.id)).toEqual(
      Array.from({ length: MAX_LAUNCHES_PER_PASS }, (_, i) => `e${i}`));
  });

  it("honours an explicit cap", () => {
    const { flow, statuses } = manyLaunches(3);
    const r = run(flow, statuses, 1);
    expect(r.fired).toHaveLength(1);
    expect(r.deferred).toBe(2);
  });

  it("never caps notify edges", () => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < MAX_LAUNCHES_PER_PASS + 3; i++) {
      nodes.push(place(`a${i}`, `PROJ-${i}`), notify(`z${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `z${i}`));
    }
    const statuses = Array.from({ length: MAX_LAUNCHES_PER_PASS + 3 }, (_, i) => status(`PROJ-${i}`, { merged: true }));
    const r = run(flowWith(nodes, edges), statuses);
    expect(r.fired).toHaveLength(MAX_LAUNCHES_PER_PASS + 3);
    expect(r.deferred).toBe(0);
  });

  it("counts a capped all-join's non-performing edges against nothing", () => {
    // Only the performing edge of an "all" junction consumes a launch slot.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "launch", mode: "tdd" })]);
    const r = run(flow, [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })], 1);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
    expect(r.deferred).toBe(0);
  });

  it("a cap-deferred all-join performer strands nothing: the junction fires as one unit or not at all", () => {
    // A cap-deferred performer must not leave its siblings stamped `fired`: if
    // the performer's condition then stops holding, a half-stamped junction
    // would be stuck forever, with nothing reported. The junction's fate is
    // decided before any of its edges enter `fired` — either all of them do,
    // or none of them do, and only the whole junction counts as one deferred.
    const flow = flowWith(
      [place("a", "PROJ-1"), planned("p", "any"),
       place("b", "PROJ-2"), place("c", "PROJ-3"), planned("z", "all")],
      [edge("e0", "a", "p", { action: "launch", mode: "tdd" }),
       edge("e1", "b", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "c", "z", { action: "launch", mode: "tdd" })]);
    const statuses = [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true }), status("PROJ-3", { merged: true })];

    const first = run(flow, statuses, 1);
    // e0 takes the only slot. The junction's performer (e1) would be capped,
    // so the whole junction — e1 AND e2 — contributes nothing to `fired`.
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e0"]);
    expect(first.deferred).toBe(1);

    // The runner stamps only what fired: e0.
    flow.edges.find((e) => e.id === "e0")!.firedAt = NOW;
    const second = run(flow, statuses, 1);
    // The slot is free; nothing was stamped last pass, so the junction
    // re-decides from scratch and fires in full.
    expect(second.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([
      { id: "e1", perform: true },
      { id: "e2", perform: false },
    ]);
    expect(second.deferred).toBe(0);
  });
});

describe("evaluateFlow — the carried action", () => {
  it("carries the action derived from each fired edge's target", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    const out = run(flow, [status("PROJ-1", { merged: true })]);
    expect(out.fired).toHaveLength(1);
    expect(out.fired[0].action).toBe("notify");
  });

  // The derivation, not the record: `edge`'s default `action` is "notify", so an
  // edge pointing at PLANNED work must still come back as a launch.
  it("ignores the edge's stored action when deriving", () => {
    const flow = flowWith([place("a", "PROJ-1"), planned("z")], [edge("e1", "a", "z")]);
    const out = run(flow, [status("PROJ-1", { merged: true })]);
    expect(out.fired[0].action).toBe("launch");
  });

  // A dangling edge (target does not exist) is neither fired nor blocked —
  // `evaluateFlow`'s main loop `continue`s past it before it ever reaches
  // `fired` — so `action` is never even asked about that shape; the existing
  // "ignores an edge whose target does not exist" test above already pins
  // that. The reachable half of `FiredEdge.action`'s doc comment — "undefined
  // when the target is ... of an unknown kind" — is this one instead:
  // `store.ts`'s `validNode` admits an unknown `kind` string on purpose, so a
  // flow written by a NEWER build still renders here rather than losing the
  // node. Such a target passes the `!target` check, is not a spend action,
  // and must land in `fired` with `action: undefined` rather than guess.
  it("carries undefined for a target of an unknown kind", () => {
    const unknown = { id: "z", kind: "teleport", x: 0, y: 0, join: "any" } as unknown as FlowNode;
    const flow = flowWith([place("a", "PROJ-1"), unknown], [edge("e1", "a", "z")]);
    const out = run(flow, [status("PROJ-1", { merged: true })]);
    expect(out.fired).toHaveLength(1);
    expect(out.fired[0].action).toBeUndefined();
  });

  it("caps by the derived action, not the edge's stored one", () => {
    // Both edges keep `edge()`'s default stored action, "notify" — deliberately
    // mismatched with their `planned` targets, which derive "launch". The cap
    // must see the DERIVED action, or an edge that spends nothing on paper
    // (because its stored field says so) dodges the cap entirely.
    const flow = flowWith(
      [place("a", "PROJ-1"), planned("z1"), place("b", "PROJ-2"), planned("z2")],
      [edge("e1", "a", "z1"), edge("e2", "b", "z2")],
    );
    const r = run(flow, [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })], 1);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
    expect(r.deferred).toBe(1);
  });

  it("carries the derived action for every edge of an \"all\" junction, not just the performer", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = run(flow, [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })]);
    expect(out.fired.map((f) => f.action)).toEqual(["notify", "notify"]);
  });
});

// `command-succeeded` is a rule wired FROM a command node onward ("deploy, then
// verify, then message me"). It is answered in `evaluate.ts`, not `evalCond` —
// see `commandSucceeded`'s own doc comment there — by reading the command
// node's INCOMING edge(s), which is why every fixture here needs a command node
// with edges pointing INTO it, stamped exactly the way `applyFired` (runner.ts)
// stamps them — including `performed`, the field that names which incoming
// edge actually ran — rather than a `RunStatus`.
describe("evaluateFlow — command-succeeded", () => {
  it("is met when the edge into the command node succeeded", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), command("cmd"), notify("z")],
      [edge("in", "a", "cmd", { firedAt: NOW - 1_000, firedNote: "ran deploy.sh in repo-PROJ-1", performed: true }),
       edge("e1", "cmd", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, []).fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("is not met when that edge errored", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), command("cmd"), notify("z")],
      [edge("in", "a", "cmd", { error: "\"deploy.sh\" exited with code 1.", performed: true }),
       edge("e1", "cmd", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, []).fired).toEqual([]);
  });

  it("is not met before the command has run at all", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), command("cmd"), notify("z")],
      // The incoming edge is wired but neither fired nor errored yet.
      [edge("in", "a", "cmd"), edge("e1", "cmd", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("reads the edge that actually performed, not a stamped-only sibling", () => {
    // Two rules trigger the same command node. Only one performs — here it
    // errored — and its sibling is demoted to a stamped-only latch, exactly
    // the shape `applyFired`'s per-target dedupe gives it: `firedAt` set, no
    // `error`, no `performed`, and a note that says nothing ran.
    // Indistinguishable from a genuine success by `firedAt`/`error` alone in
    // isolation — which is exactly why the performer must be named by
    // `performed`, not inferred from the absence of an error anywhere.
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), command("cmd"), notify("z")],
      [edge("perf", "a", "cmd", { error: "\"deploy.sh\" exited with code 1.", performed: true }),
       edge("sib", "b", "cmd", { firedAt: NOW - 1_000, firedNote: "another edge into this target already acted" }),
       edge("e1", "cmd", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, []).fired).toEqual([]);
  });

  it("stays NOT met after a partial Reset clears only the errored performer, leaving the sibling's bare firedAt behind", () => {
    // The scenario review flagged: two rules into one command node, the
    // performer errored, its sibling carries a bare `firedAt`. The drawer
    // offers Reset for the red, errored edge — nothing invites a click on the
    // sibling, which looks fine. `flow:resetEdge` (deckView.ts) rebuilds the
    // RESET edge from `{ id, from, to, cond, mode }` alone, dropping
    // `firedAt`/`error`/`firedNote`/`performed` — exactly what this fixture's
    // "perf" edge models below, already reset. If `commandSucceeded` still
    // inferred success from "no error anywhere" (the pre-review reasoning),
    // this would now read as succeeded: no incoming edge carries `error`, and
    // the sibling's `firedAt` is still set. `performed` is what keeps it
    // correct — a Reset performer means there is no performer, not "no
    // evidence of failure".
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), command("cmd"), notify("z")],
      [edge("perf", "a", "cmd"), // reset: unsettled again, carries no `performed`
       edge("sib", "b", "cmd", { firedAt: NOW - 1_000, firedNote: "another edge into this target already acted" }),
       edge("e1", "cmd", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, [status("PROJ-1"), status("PROJ-2")]).fired).toEqual([]);
  });

  it("is not met for a rule wired off a PLACE, even when that place's own incoming edge has fired", () => {
    // The picker does not filter by source kind (Tasks 9/10's job, per the
    // review), so nothing stops `e1` below from pointing out of a place
    // rather than a command node. `commandSucceeded` must refuse such a
    // source rather than read ITS incoming edges — "p" here is a promoted
    // place whose own incoming edge ("in") is a perfectly ordinary fired
    // seed/launch edge, wholly unrelated to any command, and it must not be
    // read as a command's success just because it carries `firedAt`.
    const flow = flowWith(
      [place("a", "PROJ-1"), place("p", "PROJ-2"), notify("z")],
      [edge("in", "a", "p", { firedAt: NOW - 1_000, firedNote: "opened bite-me-2", performed: true }),
       edge("e1", "p", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, [status("PROJ-1"), status("PROJ-2")]).fired).toEqual([]);
  });

  it("scopes to its OWN command node — a sibling command node's success does not leak in", () => {
    // Kills a mutant that reads `flow.edges` wholesale instead of this node's
    // own incoming edges: cmd1 has genuinely succeeded, cmd2 has never run,
    // and a rule wired off cmd2 must answer for cmd2 alone.
    const flow = flowWith(
      [place("a", "PROJ-1"), command("cmd1"), command("cmd2"), notify("z")],
      [edge("in1", "a", "cmd1", { firedAt: NOW - 1_000, firedNote: "ran deploy.sh in repo-PROJ-1", performed: true }),
       edge("in2", "a", "cmd2"), // cmd2's own incoming edge has not fired
       edge("e1", "cmd2", "z", { cond: { kind: "command-succeeded" } })],
    );
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });
});

// `branch-ci-passed` is the one condition whose fact is not in any `RunStatus`: it
// names a repo and branch nothing on the board need have checked out, so the
// verdicts are fetched host-side (deckView.ts, once per distinct `repo#branch` per
// poll) and handed to `evaluateFlow` as one map for the whole pass. What is pinned
// here is the THREADING — that the map reaches every `CondContext` this function
// builds, and that a pass without one cannot fire a deploy.
describe("evaluateFlow — branch-CI verdicts arrive from outside the status", () => {
  // The condition's repo is deliberately NOT the source place's repo
  // (`repo-PROJ-1`): it is a branch of another repo entirely, which is the whole
  // point of the kind.
  const onMaster = (): Flow =>
    flowWith(
      [place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "branch-ci-passed", repo: "bite-me", branch: "master" } })],
    );

  it("fires only when this pass fetched a pass for that repo and branch", () => {
    const out = evaluateFlow({
      flow: onMaster(), statuses: [status("PROJ-1")], nowMs: NOW,
      branchCi: { "bite-me#master": "passed" },
    });
    expect(out.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("does not fire on a failure, on pending, on unknown, or with no map at all", () => {
    // The last case is the one that matters most: a pass whose `gh` call failed,
    // timed out or never ran must not deploy. `undefined` is not green.
    const maps: (Record<string, BranchCiStatus> | undefined)[] = [
      { "bite-me#master": "failed" },
      { "bite-me#master": "pending" },
      { "bite-me#master": "unknown" },
      { "api#master": "passed" }, // a different repo's master
      {},
      undefined,
    ];
    for (const branchCi of maps) {
      const out = evaluateFlow({ flow: onMaster(), statuses: [status("PROJ-1")], nowMs: NOW, branchCi });
      expect(out.fired).toEqual([]);
    }
  });

  it("serves every rule that names the same branch from the one map", () => {
    // Two rules, two source places, one fetch — the shape that makes "ten rules on
    // main is not ten API calls" possible at all.
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z1"), notify("z2")],
      [edge("e1", "a", "z1", { cond: { kind: "branch-ci-passed", repo: "bite-me", branch: "master" } }),
       edge("e2", "b", "z2", { cond: { kind: "branch-ci-passed", repo: "bite-me", branch: "master" } })],
    );
    const out = evaluateFlow({
      flow, statuses: [status("PROJ-1"), status("PROJ-2")], nowMs: NOW,
      branchCi: { "bite-me#master": "passed" },
    });
    expect(out.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
  });
});

const gate = (id: string, join: JoinMode = "any"): GateNode =>
  ({ id, kind: "gate", x: 0, y: 0, join, question: "deploy to prod?" });

/** A gate that has been ASKED: the ask edge fired and is the performer. */
const asked = (over: Partial<FlowEdge> = {}): FlowEdge =>
  edge("ask1", "a", "g", { cond: { kind: "pr-merged" }, action: "ask",
    firedAt: NOW - 1000, performed: true, ...over });

describe("evaluateFlow — a gate", () => {
  it("does not fire a gate-approved rule while the gate is unanswered", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [asked(), edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("fires a gate-approved rule once the gate is approved", () => {
    // Also pins the gate interception's POSITION in `isMet`, not just its
    // existence: move it below the `isPlace` guard and this goes red, because
    // a gate node fails `isPlace` and the guard returns `undefined` before the
    // interception is ever reached — the fired edge disappears. (A dedicated
    // "never reports a gate source as gone" test tried to cover that ordering
    // risk directly and was deleted: a gate can never reach the `isPlace` ===
    // false branch's `note(..., "gone")` call in any ordering, so it could not
    // fail no matter where the interception sat.)
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [asked({ gateAnswer: "approved" }), edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("fires a gate-rejected rule once the gate is rejected, and not the approved one", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("y"), notify("z")],
      [asked({ gateAnswer: "rejected" }),
       edge("ok", "g", "y", { cond: { kind: "gate-approved" } }),
       edge("no", "g", "z", { cond: { kind: "gate-rejected" } })]);
    expect(run(flow, [status("PROJ-1")]).fired.map((f) => f.edge.id)).toEqual(["no"]);
  });

  it("refuses a gate condition whose source is not a gate node", () => {
    // A hand-edited flow file, or one written by another build: it never went
    // through a picker. Without the kind guard, `incomingEdges` would read the
    // COMMAND node's already-fired edges and report an approval nobody gave.
    const flow = flowWith([place("a", "PROJ-1"), command("c"), notify("z")],
      [edge("ask1", "a", "c", { action: "run", firedAt: NOW - 1000, performed: true, gateAnswer: "approved" }),
       edge("e2", "c", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("reads no answer off a sibling that did not perform", () => {
    // The demoted per-target-dedupe sibling carries `firedAt` and no error, and
    // reads exactly like a performer unless `performed` is what names one.
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [edge("sib", "a", "g", { action: "ask", firedAt: NOW - 1000, gateAnswer: "approved" }),
       edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("reads no answer off a performer that errored instead of asking", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [edge("ask1", "a", "g", { action: "ask", performed: true, error: "boom", gateAnswer: "approved" }),
       edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("finds the real answer past an older-build errored performer that sits first in flow order", () => {
    // The exact downgrade scenario the fix in `gateAnswer` (evaluate.ts) exists
    // for: an older build with no gate support stamped rule A's edge
    // `performed: true` plus an `error` and no `firedAt` — the fail-closed shape
    // `applyFired` gives an unknown action. A stays first in flow order. The
    // user upgrades, Resets only rule B, and B re-fires properly with a real
    // `firedAt` and `gateAnswer`. A `find` that stops at `performed === true`
    // alone would land on A, see no `firedAt`, and return `undefined` forever —
    // the node reads "answered" with no downstream rule ever firing. Folding
    // `firedAt !== undefined` into the `find` predicate is what lets the search
    // continue past A to B.
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [edge("A", "a", "g", { action: "ask", performed: true, error: "unknown action \"gate\"" }),
       asked({ id: "B", gateAnswer: "approved" }),
       edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("notes that it is waiting on you once the question has been asked", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [asked(), edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).blocked).toEqual([{ nodeId: "g", reason: "awaiting-answer" }]);
  });

  it("says nothing while no rule has reached the gate yet", () => {
    // Not-there-yet is ordinary, and already reads correctly as silence. A note
    // here would tell you to answer a question nobody has asked.
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [edge("ask1", "a", "g", { action: "ask" }), edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).blocked).toEqual([]);
  });

  it("says nothing once the gate is answered", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [asked({ gateAnswer: "rejected" }), edge("e2", "g", "z", { cond: { kind: "gate-approved" } })]);
    expect(run(flow, [status("PROJ-1")]).blocked).toEqual([]);
  });

  it("notes an unanswered gate once, not once per waiting rule", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("y"), notify("z")],
      [asked(), edge("e2", "g", "y", { cond: { kind: "gate-approved" } }),
       edge("e3", "g", "z", { cond: { kind: "gate-rejected" } })]);
    expect(run(flow, [status("PROJ-1")]).blocked).toEqual([{ nodeId: "g", reason: "awaiting-answer" }]);
  });

  it("never spends a launch slot on an ask", () => {
    // Three planned launches plus a gate: the gate must not be the one deferred.
    const flow = flowWith(
      [place("a", "PROJ-1"), gate("g"), planned("p1"), planned("p2"), planned("p3")],
      [edge("ask1", "a", "g", { action: "ask" }),
       edge("l1", "a", "p1"), edge("l2", "a", "p2"), edge("l3", "a", "p3")]);
    const r = run(flow, [status("PROJ-1", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id).sort()).toEqual(["ask1", "l1", "l2", "l3"]);
    expect(r.deferred).toBe(0);
  });
});

describe("evaluateDeadlines — starting the clock", () => {
  const clocks = (flow: Flow, statuses: RunStatus[], nowMs = NOW) =>
    evaluateDeadlines({ flow, statuses, nowMs });

  it("starts the clock on a rule with a deadline whose source is a place on the board", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z", { timeoutMinutes: 10 })]);
    expect(clocks(flow, [status("PROJ-1")]).wentLive).toEqual(["e1"]);
  });

  it("starts no clock on a rule without a deadline — a flow that never opted in is never written for this", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z")]);
    expect(clocks(flow, [status("PROJ-1")])).toEqual({ wentLive: [], expired: [] });
  });

  it("does not restart a clock that is already running", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 1 })]);
    expect(clocks(flow, [status("PROJ-1")]).wentLive).toEqual([]);
  });

  it("does not start a clock while the source is planned work, or a place that is gone", () => {
    const fromPlanned = flowWith([planned("p"), notify("z")], [edge("e1", "p", "z", { timeoutMinutes: 10 })]);
    expect(clocks(fromPlanned, []).wentLive).toEqual([]);
    const gone = flowWith([place("a", "PROJ-1"), notify("z")], [edge("e1", "a", "z", { timeoutMinutes: 10 })]);
    expect(clocks(gone, []).wentLive).toEqual([]);
  });

  it("starts the clock on a rule out of a command node once the command has performed, not before", () => {
    const flow = flowWith([place("a", "PROJ-1"), command("c"), notify("z")],
      [edge("e1", "a", "c", { action: "run" }),
       edge("e2", "c", "z", { cond: { kind: "command-succeeded" }, timeoutMinutes: 30 })]);
    expect(clocks(flow, [status("PROJ-1")]).wentLive).toEqual([]);
    flow.edges[0].performed = true;
    flow.edges[0].error = "exit 1";
    // Ran and failed still counts as performed: the rule is now waiting on a
    // command that will never succeed, which is exactly what a deadline is for.
    expect(clocks(flow, [status("PROJ-1")]).wentLive).toEqual(["e2"]);
  });

  it("starts the clock on a rule out of a gate once the question has been asked", () => {
    const flow = flowWith([place("a", "PROJ-1"), gate("g"), notify("z")],
      [edge("ask", "a", "g", { action: "ask" }),
       edge("e2", "g", "z", { cond: { kind: "gate-approved" }, timeoutMinutes: 60 })]);
    expect(clocks(flow, [status("PROJ-1")]).wentLive).toEqual([]);
    const posed = flowWith(flow.nodes, [asked({ id: "ask" }), flow.edges[1]]);
    expect(clocks(posed, [status("PROJ-1")]).wentLive).toEqual(["e2"]);
  });

  it("does nothing at all for a disarmed flow", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 60 * 60_000 })], false);
    expect(clocks(flow, [status("PROJ-1")])).toEqual({ wentLive: [], expired: [] });
  });

  it("never touches a settled rule", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z"), notify("y")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, firedAt: 1 }),
       edge("e2", "a", "y", { timeoutMinutes: 10, liveSince: NOW - 60 * 60_000, error: "boom" })]);
    expect(clocks(flow, [status("PROJ-1")])).toEqual({ wentLive: [], expired: [] });
  });
});

describe("evaluateDeadlines — running out", () => {
  const clocks = (flow: Flow, statuses: RunStatus[], nowMs = NOW) =>
    evaluateDeadlines({ flow, statuses, nowMs });

  it("expires a rule whose deadline has passed with its condition still unmet", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 10 * 60_000 })]);
    expect(clocks(flow, [status("PROJ-1")]).expired).toEqual(["e1"]);
  });

  it("does not expire a rule whose deadline has not passed yet", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 10 * 60_000 + 1 })]);
    expect(clocks(flow, [status("PROJ-1")]).expired).toEqual([]);
  });

  it("a met rule fires rather than expires, even past its deadline — the condition arrived", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 60 * 60_000 })]);
    const statuses = [status("PROJ-1", { merged: true })];
    expect(clocks(flow, statuses).expired).toEqual([]);
    expect(run(flow, statuses).fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("expires past the deadline even when the card has since gone from the board", () => {
    // The clock started while the card was observable; the condition then did
    // not arrive in time. That the card is now gone does not make it arrive.
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { timeoutMinutes: 10, liveSince: NOW - 60 * 60_000 })]);
    expect(clocks(flow, []).expired).toEqual(["e1"]);
  });

  it("does not expire a rule with a running clock but no deadline any more — the user removed it", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { liveSince: NOW - 60 * 60_000 })]);
    expect(clocks(flow, [status("PROJ-1")]).expired).toEqual([]);
  });
});

describe("evaluateFlow — expired edges", () => {
  it("never re-evaluates an expired edge", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")],
      [edge("e1", "a", "z", { expiredAt: NOW - 1 })]);
    expect(run(flow, [status("PROJ-1", { merged: true })]).fired).toEqual([]);
  });

  it("with join all, an expired incoming edge stops the junction dead — a settled edge that never arrived is not an arrival", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "all")],
      [edge("e1", "a", "z", { expiredAt: NOW - 1 }), edge("e2", "b", "z")],
    );
    const r = run(flow, [status("PROJ-1", { merged: true }), status("PROJ-2", { merged: true })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([]);
  });
});

describe("evaluateFlow — deadline-passed", () => {
  const passed = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}) =>
    edge(id, from, to, { cond: { kind: "deadline-passed" }, ...over });

  it("fires once a sibling out of the same source has expired", () => {
    const flow = flowWith([place("a", "PROJ-1"), planned("p"), notify("z")],
      [edge("e1", "a", "p", { timeoutMinutes: 60, expiredAt: NOW - 1 }), passed("e2", "a", "z")]);
    expect(run(flow, [status("PROJ-1")]).fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("does not fire while the sibling is still waiting", () => {
    const flow = flowWith([place("a", "PROJ-1"), planned("p"), notify("z")],
      [edge("e1", "a", "p", { timeoutMinutes: 60, liveSince: NOW - 1 }), passed("e2", "a", "z")]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("does not fire on a sibling that fired or errored — only an expiry is a deadline passing", () => {
    const flow = flowWith([place("a", "PROJ-1"), planned("p"), planned("q"), notify("z")],
      [edge("e1", "a", "p", { firedAt: NOW - 1 }), edge("e3", "a", "q", { error: "boom" }), passed("e2", "a", "z")]);
    expect(run(flow, [status("PROJ-1")]).fired).toEqual([]);
  });

  it("reads only siblings out of its OWN source — another node's expiry does not leak in", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2"), planned("p"), notify("z")],
      [edge("e1", "b", "p", { expiredAt: NOW - 1 }), passed("e2", "a", "z")]);
    expect(run(flow, [status("PROJ-1"), status("PROJ-2")]).fired).toEqual([]);
  });

  it("is answered from the flow, so it works off a source whose card is gone and reports no blocked note", () => {
    const flow = flowWith([place("a", "PROJ-1"), planned("p"), notify("z")],
      [edge("e1", "a", "p", { expiredAt: NOW - 1 }), passed("e2", "a", "z")]);
    const r = run(flow, []);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e2"]);
    expect(r.blocked).toEqual([]);
  });
});

describe("evaluateFlow — command-printed", () => {
  const printedRule = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}) =>
    edge(id, from, to, { cond: { kind: "command-printed", text: "DEPLOYED" }, ...over });
  /** place → command (performed, succeeded) → notify, the rule under test on the last hop. */
  const ran = (performerOver: Partial<FlowEdge> = { firedAt: NOW - 1, performed: true }) =>
    flowWith([place("a", "PROJ-1"), command("c"), notify("z")],
      [edge("e1", "a", "c", { action: "run", ...performerOver }), printedRule("e2", "c", "z")]);

  it("fires when the host says the command printed the text and the command has performed", () => {
    const r = evaluateFlow({ flow: ran(), statuses: [status("PROJ-1")], nowMs: NOW, printed: { e2: true } });
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("fires on a command that ran and FAILED too — a failure's output is often the text worth acting on", () => {
    const r = evaluateFlow({ flow: ran({ error: "exit 1", performed: true }), statuses: [status("PROJ-1")], nowMs: NOW, printed: { e2: true } });
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("does not fire without a verdict, or with a false one — an absent map is waiting, never a match", () => {
    expect(evaluateFlow({ flow: ran(), statuses: [status("PROJ-1")], nowMs: NOW }).fired).toEqual([]);
    expect(evaluateFlow({ flow: ran(), statuses: [status("PROJ-1")], nowMs: NOW, printed: { e2: false } }).fired).toEqual([]);
    expect(evaluateFlow({ flow: ran(), statuses: [status("PROJ-1")], nowMs: NOW, printed: {} }).fired).toEqual([]);
  });

  it("does not fire before the command has performed, whatever the host's verdict says", () => {
    // A stale `true` — computed off last cycle's journal line, before a Reset cleared
    // the performer — must not fire this cycle's rule.
    const r = evaluateFlow({ flow: ran({}), statuses: [status("PROJ-1")], nowMs: NOW, printed: { e2: true } });
    expect(r.fired).toEqual([]);
  });

  it("refuses a rule of this kind wired off a place, with no blocked note", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z")], [printedRule("e1", "a", "z", { firedAt: undefined })]);
    const r = evaluateFlow({ flow, statuses: [status("PROJ-1")], nowMs: NOW, printed: { e1: true } });
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  it("reads the verdict keyed by the RULE's edge, not the command's", () => {
    const r = evaluateFlow({ flow: ran(), statuses: [status("PROJ-1")], nowMs: NOW, printed: { e1: true } });
    expect(r.fired).toEqual([]);
  });
});
