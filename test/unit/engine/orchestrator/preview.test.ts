import { describe, it, expect } from "vitest";
import { previewFlow } from "../../../../src/engine/orchestrator/preview";
import { MAX_LAUNCHES_PER_PASS } from "../../../../src/engine/orchestrator/evaluate";
import {
  Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, PlannedNode, emptyFlow,
} from "../../../../src/engine/orchestrator/model";
import { PrEntryMap, PrFacts, RepoGit, Run, RunStatus } from "../../../../src/types";

const NOW = 1_800_000_000_000;

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

const status = (key: string, over: { merged?: boolean } = {}): RunStatus => {
  const repo = `repo-${key}`;
  const git: RepoGit = { name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 };
  const run: Run = { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
    repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] };
  const prs: PrEntryMap = { [repo]: { facts: facts({ state: over.merged ? "MERGED" : "OPEN" }), fetchedAt: NOW } };
  return {
    run, column: "progress", ticketStatus: null, ticketCategory: null, repos: [git],
    agent: { state: "working", lastActivityMs: NOW, slug: null },
    windowOpen: false, prs, agents: [], shelf: "board",
  };
};

const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const planned = (id: string, join: JoinMode = "any"): PlannedNode =>
  ({ id, kind: "planned", x: 0, y: 0, join, ticketKey: "ASM-99", repos: ["r"], mode: "tdd", dest: "worktree" });
const notify = (id: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message: "done" });

const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

/** Disarmed by default, deliberately: the preview's whole job is to answer for a
 * flow nobody has armed yet, so every case here proves the forced arm. */
const flowWith = (nodes: FlowNode[], edges: FlowEdge[], armed = false): Flow =>
  ({ ...emptyFlow("f1", "f", 0), armed, nodes, edges });

/** `n` met launches into planned work, each from its own place — the shape that
 * outruns the cap. Mirrors `evaluate.test.ts`'s own `manyLaunches`. */
const manyLaunches = (n: number) => {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(place(`a${i}`, `ASM-${i}`), planned(`p${i}`));
    edges.push(edge(`e${i}`, `a${i}`, `p${i}`, { action: "launch", mode: "tdd" }));
  }
  return { flow: flowWith(nodes, edges), statuses: Array.from({ length: n }, (_, i) => status(`ASM-${i}`, { merged: true })) };
};

const verdictOf = (rows: ReturnType<typeof previewFlow>, edgeId: string) =>
  rows.find((r) => r.edgeId === edgeId)?.verdict;

describe("previewFlow — the cap", () => {
  it("names the rules the cap held back, rather than only counting them", () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS + 2);
    const rows = previewFlow(flow, statuses, NOW);
    const deferred = rows.filter((r) => r.verdict === "defer").map((r) => r.edgeId);
    expect(deferred).toEqual([`e${MAX_LAUNCHES_PER_PASS}`, `e${MAX_LAUNCHES_PER_PASS + 1}`]);
  });
});

describe("previewFlow — a source that cannot be observed", () => {
  it("reads a rule whose source card is off the board as blocked, and says why", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    // ASM-1's card is not among the statuses: the run is gone from the board.
    expect(previewFlow(flow, [], NOW)).toEqual([
      { edgeId: "e1", verdict: "blocked", perform: false, reason: "gone" },
    ]);
  });
});

describe("previewFlow — the rules it says nothing about", () => {
  it("reads an unmet rule as waiting, with no reason to give", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    // ASM-1's PR is open, so `pr-merged` is answerable and false — not blocked.
    expect(previewFlow(flow, [status("ASM-1")], NOW)).toEqual([
      { edgeId: "e1", verdict: "waiting", perform: false },
    ]);
  });

  it("leaves a settled rule out entirely — it is not waiting on anything", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z"), notify("y")],
      [edge("e1", "a", "z", { firedAt: NOW }), edge("e2", "a", "y", { error: "boom" })]);
    expect(previewFlow(flow, [status("ASM-1", { merged: true })], NOW)).toEqual([]);
  });
});

describe("previewFlow — the forced arm", () => {
  it("answers for a disarmed flow without arming it", () => {
    const flow = flowWith([place("a", "ASM-1"), notify("z")], [edge("e1", "a", "z")]);
    const rows = previewFlow(flow, [status("ASM-1", { merged: true })], NOW);
    expect(rows).toEqual([{ edgeId: "e1", verdict: "fire", perform: true }]);
    // The whole point of a dry run: the flow on disk is untouched. A preview that
    // armed the caller's own object would arm it for real on the next `flow:save`.
    expect(flow.armed).toBe(false);
  });
});

describe("previewFlow — an all-join", () => {
  /** Three met launches to eat the default cap, then a two-edge "all" junction
   * whose performer can only be capped. */
  const cappedJunction = () => {
    const { flow, statuses } = manyLaunches(MAX_LAUNCHES_PER_PASS);
    const nodes: FlowNode[] = [...flow.nodes, place("b", "ASM-b"), place("c", "ASM-c"), planned("j", "all")];
    const edges: FlowEdge[] = [...flow.edges,
      edge("j1", "b", "j", { action: "launch", mode: "tdd" }),
      edge("j2", "c", "j", { action: "launch", mode: "tdd" })];
    return {
      flow: flowWith(nodes, edges),
      statuses: [...statuses, status("ASM-b", { merged: true }), status("ASM-c", { merged: true })],
    };
  };

  it("names every pending edge of a capped junction, not just the one that would act", () => {
    // `evaluateFlow` counts a capped junction as ONE deferred unit, so the count
    // alone can never name both of these. Both are held back and both must say so.
    const { flow, statuses } = cappedJunction();
    const rows = previewFlow(flow, statuses, NOW);
    // `perform` survives the defer: it is which edge will act once a slot frees,
    // so the wording for a deferred junction can stay as honest as a fired one's.
    expect(rows.filter((r) => r.verdict === "defer")).toEqual([
      { edgeId: "j1", verdict: "defer", perform: true },
      { edgeId: "j2", verdict: "defer", perform: false },
    ]);
  });

  it("marks the sibling that gets stamped without acting as not performing", () => {
    // Under no cap the junction fires in full: `j1` performs the launch and `j2`
    // is only stamped. A preview that called both "would launch" would promise
    // two windows where one opens.
    const flow = flowWith(
      [place("b", "ASM-b"), place("c", "ASM-c"), planned("j", "all")],
      [edge("j1", "b", "j", { action: "launch", mode: "tdd" }),
       edge("j2", "c", "j", { action: "launch", mode: "tdd" })]);
    const statuses = [status("ASM-b", { merged: true }), status("ASM-c", { merged: true })];
    expect(previewFlow(flow, statuses, NOW)).toEqual([
      { edgeId: "j1", verdict: "fire", perform: true },
      { edgeId: "j2", verdict: "fire", perform: false },
    ]);
  });
});
