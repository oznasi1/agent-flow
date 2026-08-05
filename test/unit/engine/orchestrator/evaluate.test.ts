import { describe, it, expect } from "vitest";
import { evaluateFlow, MAX_LAUNCHES_PER_PASS } from "../../../../src/engine/orchestrator/evaluate";
import {
  Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, PlannedNode, emptyFlow,
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
    run, column: "progress", jiraStatus: null, jiraCategory: null, repos: [git],
    agent: { state: over.unknownAgent ? "unknown" : "working", lastActivityMs: NOW, slug: null },
    windowOpen: false, prs, agents: over.agents ?? [],
  };
};

// Concrete node types with an explicit join, so no test needs a cast to reach it.
const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const planned = (id: string, join: JoinMode = "any"): PlannedNode =>
  ({ id, kind: "planned", x: 0, y: 0, join, ticketKey: "ASM-99", repos: ["r"], mode: "tdd", dest: "worktree" });
const notify = (id: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message: "done" });

const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[], armed = true): Flow =>
  ({ ...emptyFlow("f1", "f", 0), armed, nodes, edges });

const run = (flow: Flow, statuses: RunStatus[], maxLaunches?: number) =>
  evaluateFlow({ flow, statuses, nowMs: NOW, maxLaunches });

describe("evaluateFlow — arming and the latch", () => {
  it("yields nothing for a disarmed flow, even when the condition is met", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")], false);
    expect(run(flow, [status("ASM-1", { merged: true })])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("fires a met edge exactly once", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const first = run(flow, [status("ASM-1", { merged: true })]);
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e1"]);

    // The runner stamps firedAt; the next pass must skip it.
    flow.edges[0].firedAt = NOW;
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });

  it("never re-evaluates an edge whose action errored", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z", { error: "worktree exists" })]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });

  it("does not fire an unmet edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("ASM-1", { merged: false })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — nodes it cannot evaluate", () => {
  it("blocks an edge whose source run is gone", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, []); // no status for ASM-1 — the run was forgotten
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("does not block an edge from a planned node — it is simply not launched yet", () => {
    const flow = flowWith([planned("p"), notify("z")], [edge("e1", "p", "z")]);
    expect(run(flow, [])).toEqual({ fired: [], blocked: [], deferred: 0 });
  });

  it("blocks an agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")],
      [edge("e1", "a", "z", { cond: { kind: "agent-ended-turn" } })]);
    const r = run(flow, [status("ASM-1", { unknownAgent: true })]);
    expect(r.fired).toEqual([]);
    expect(r.blocked).toEqual([{ nodeId: "a", reason: "agent-state-unknown" }]);
  });

  it("does not block a non-agent condition when the agent state is unknown", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const r = run(flow, [status("ASM-1", { merged: true, unknownAgent: true })]);
    expect(r.blocked).toEqual([]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("reports a gone node once, not once per edge leaving it", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("y"), notify("z")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    expect(run(flow, []).blocked).toEqual([{ nodeId: "a", reason: "gone" }]);
  });

  it("ignores an edge whose target does not exist", () => {
    const flow = flowWith([place("a", "ASM-1")], [edge("e1", "a", "missing")]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired).toEqual([]);
  });
});

describe("evaluateFlow — join", () => {
  const twoIn = (join: "any" | "all") =>
    flowWith([place("a", "ASM-1"), place("b", "ASM-2"), notify("z", join)],
      [edge("e1", "a", "z"), edge("e2", "b", "z")]);

  it("with join any, each met edge fires on its own", () => {
    const r = run(twoIn("any"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: false })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });

  it("with join all, one met edge fires nothing", () => {
    const r = run(twoIn("all"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: false })]);
    expect(r.fired).toEqual([]);
  });

  it("with join all, every edge fires once the last one is met", () => {
    const r = run(twoIn("all"), [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
  });

  it("with join all, an already-fired edge counts as met", () => {
    const flow = twoIn("all");
    flow.edges[0].firedAt = NOW - 1;
    const r = run(flow, [status("ASM-1", { merged: false }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e2"]);
  });

  it("with join all, the action performed is the first incoming edge's", () => {
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "seed", mode: "plan" })]);
    const r = run(flow, [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })]);
    expect(r.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([
      { id: "e1", perform: true },
      { id: "e2", perform: false },
    ]);
  });

  it("join is irrelevant to a target with a single incoming edge", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z", "all")], [edge("e1", "a", "z")]);
    expect(run(flow, [status("ASM-1", { merged: true })]).fired.map((f) => f.edge.id)).toEqual(["e1"]);
  });
});

describe("evaluateFlow — the launch cap", () => {
  const manyLaunches = (n: number) => {
    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    for (let i = 0; i < n; i++) {
      nodes.push(place(`a${i}`, `ASM-${i}`), planned(`p${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `p${i}`, { action: "launch", mode: "tdd" }));
    }
    return { flow: flowWith(nodes, edges), statuses: Array.from({ length: n }, (_, i) => status(`ASM-${i}`, { merged: true })) };
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
      nodes.push(place(`a${i}`, `ASM-${i}`), notify(`z${i}`));
      edges.push(edge(`e${i}`, `a${i}`, `z${i}`));
    }
    const statuses = Array.from({ length: MAX_LAUNCHES_PER_PASS + 3 }, (_, i) => status(`ASM-${i}`, { merged: true }));
    const r = run(flowWith(nodes, edges), statuses);
    expect(r.fired).toHaveLength(MAX_LAUNCHES_PER_PASS + 3);
    expect(r.deferred).toBe(0);
  });

  it("counts a capped all-join's non-performing edges against nothing", () => {
    // Only the performing edge of an "all" junction consumes a launch slot.
    const flow = flowWith([place("a", "ASM-1"), place("b", "ASM-2"), planned("z", "all")],
      [edge("e1", "a", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "b", "z", { action: "launch", mode: "tdd" })]);
    const r = run(flow, [status("ASM-1", { merged: true }), status("ASM-2", { merged: true })], 1);
    expect(r.fired.map((f) => f.edge.id)).toEqual(["e1", "e2"]);
    expect(r.deferred).toBe(0);
  });

  it("a deferred all-join performer still performs on the next pass", () => {
    // The cap can strand a junction half-stamped: its performer is deferred while
    // its siblings are stamped fired. That must resolve on a later pass, not leave
    // a junction that is fully stamped and never acted on.
    const flow = flowWith(
      [place("a", "ASM-1"), planned("p", "any"),
       place("b", "ASM-2"), place("c", "ASM-3"), planned("z", "all")],
      [edge("e0", "a", "p", { action: "launch", mode: "tdd" }),
       edge("e1", "b", "z", { action: "launch", mode: "tdd" }),
       edge("e2", "c", "z", { action: "launch", mode: "tdd" })]);
    const statuses = [status("ASM-1", { merged: true }), status("ASM-2", { merged: true }), status("ASM-3", { merged: true })];

    const first = run(flow, statuses, 1);
    expect(first.fired.filter((f) => f.perform).map((f) => f.edge.id)).toEqual(["e0"]);
    expect(first.deferred).toBe(1);
    // e2 was stamped without performing; e1, the performer, was held back.
    expect(first.fired.map((f) => f.edge.id)).toEqual(["e0", "e2"]);

    // The runner stamps what fired. Next pass, with the slot free:
    for (const id of ["e0", "e2"]) flow.edges.find((e) => e.id === id)!.firedAt = NOW;
    const second = run(flow, statuses, 1);
    expect(second.fired.map((f) => ({ id: f.edge.id, perform: f.perform }))).toEqual([{ id: "e1", perform: true }]);
  });
});
