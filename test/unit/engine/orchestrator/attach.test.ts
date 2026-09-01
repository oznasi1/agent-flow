import { describe, expect, it } from "vitest";
import type { Flow, FlowNode } from "../../../../src/engine/orchestrator/model";
import { attachedWorkflows, bindsRun } from "../../../../src/engine/orchestrator/attach";

const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "ingest-worker" });
const planned = (id: string, ticketKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "planned", ticketKey, repos: ["ingest-worker"], mode: "plan", dest: "worktree" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const flow = (id: string, nodes: FlowNode[], createdAt = 0): Flow =>
  ({ id, name: "Ship it", armed: false, createdAt, nodes, edges: [] });

describe("bindsRun", () => {
  it("binds by a place's run key", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-142")]), "PROJ-142", "PROJ-142")).toBe(true);
  });

  it("binds by a planned node's ticket key", () => {
    expect(bindsRun(flow("f1", [planned("n1", "PROJ-142")]), "local-branch-key", "PROJ-142")).toBe(true);
  });

  it("does not bind a flow that names neither", () => {
    expect(bindsRun(flow("f1", [place("n1", "PROJ-9"), notify("n2")]), "PROJ-142", "PROJ-142")).toBe(false);
  });

  it("does not bind a planned node with a blank ticket key to a card with no ticket", () => {
    // A template's planned node carries "" until instantiate binds one. An
    // undefined ticket key on the card must not match it, or every untracked
    // card would claim every half-built workflow.
    expect(bindsRun(flow("f1", [planned("n1", "")]), "local-key", undefined)).toBe(false);
  });

  it("ignores case-insensitive near-misses — keys are exact", () => {
    expect(bindsRun(flow("f1", [place("n1", "proj-142")]), "PROJ-142", "PROJ-142")).toBe(false);
  });
});

describe("attachedWorkflows", () => {
  it("returns nothing when no flow binds the run", () => {
    expect(attachedWorkflows([flow("f1", [place("n1", "PROJ-9")])], "PROJ-142", "PROJ-142")).toEqual([]);
  });

  it("returns the one flow that binds it", () => {
    const flows = [flow("f1", [place("n1", "PROJ-9")]), flow("f2", [place("n1", "PROJ-142")])];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f2"]);
  });

  it("returns two hand-drawn matches oldest first", () => {
    // Nothing stops somebody hand-drawing two flows that touch one card. The
    // drawer must resolve deterministically rather than pick whichever the
    // filesystem listed first.
    const flows = [flow("f2", [place("n1", "PROJ-142")], 200), flow("f1", [place("n1", "PROJ-142")], 100)];
    expect(attachedWorkflows(flows, "PROJ-142", "PROJ-142").map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

import { rankByState, workflowState } from "../../../../src/engine/orchestrator/attach";
import type { FlowEdge } from "../../../../src/engine/orchestrator/model";

const edge = (over: Partial<FlowEdge> & { id: string }): FlowEdge =>
  ({ from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...over });

/** A flow whose place names a run no board has — every condition on it reads
 * nothing, which `evaluate.ts` reports as blocked "gone". */
const withEdges = (edges: FlowEdge[], armed = true, createdAt = 0): Flow => ({
  id: "f1", name: "Ship it", armed, createdAt,
  nodes: [place("n1", "PROJ-142"), notify("n2")],
  edges,
});

describe("workflowState", () => {
  it("is disarmed when the flow is not armed, whatever the rules say", () => {
    const s = workflowState(withEdges([edge({ id: "e1" })], false), [], 1000);
    expect(s.status).toBe("disarmed");
  });

  it("is stopped when any edge carries an error, and names the failed step", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 1, firedNote: "ran · exit 0" }),
      edge({ id: "e2", error: "exit 1 · 3 assertions failed" }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
    expect(s.steps.find((x) => x.edgeId === "e2")).toMatchObject({
      state: "fail", receipt: "exit 1 · 3 assertions failed",
    });
  });

  it("prefers stopped over waiting-on-you", () => {
    // A failure the user can act on outranks a question, because the failure is
    // what actually halted the workflow.
    const s = workflowState(withEdges([
      edge({ id: "e1", error: "exit 1" }),
      edge({ id: "e2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
  });

  it("reports a fired edge as done, with its receipt", () => {
    const s = workflowState(withEdges([edge({ id: "e1", firedAt: 5, firedNote: "told you" })]), [], 1000);
    expect(s.steps[0]).toMatchObject({ state: "done", receipt: "told you" });
    expect(s.done).toBe(1);
    expect(s.total).toBe(1);
  });

  it("is done when no rule is left in play", () => {
    // `done` is the ABSENCE of a pending rule, not a stored flag — same
    // reasoning as attachment itself.
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
    ]), [], 1000);
    expect(s.status).toBe("done");
    expect(s.done).toBe(2);
  });

  it("counts done out of total for the header", () => {
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2", firedAt: 6 }),
      edge({ id: "e3" }),
    ]), [], 1000);
    expect([s.done, s.total]).toEqual([2, 3]);
  });
});

describe("rankByState", () => {
  const armedWith = (id: string, edges: FlowEdge[], createdAt: number): Flow =>
    ({ ...withEdges(edges, true, createdAt), id });

  it("puts a stopped workflow ahead of an advancing one", () => {
    const stopped = armedWith("f-stop", [edge({ id: "e1", error: "exit 1" })], 200);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 100);
    expect(rankByState([advancing, stopped], [], 1000).map((f) => f.id)).toEqual(["f-stop", "f-adv"]);
  });

  it("puts a done workflow last", () => {
    const done = armedWith("f-done", [edge({ id: "e1", firedAt: 1 })], 100);
    const advancing = armedWith("f-adv", [edge({ id: "e1" })], 200);
    expect(rankByState([done, advancing], [], 1000).map((f) => f.id)).toEqual(["f-adv", "f-done"]);
  });

  it("breaks a tie by createdAt, oldest first", () => {
    const a = armedWith("f-old", [edge({ id: "e1" })], 100);
    const b = armedWith("f-new", [edge({ id: "e1" })], 200);
    expect(rankByState([b, a], [], 1000).map((f) => f.id)).toEqual(["f-old", "f-new"]);
  });
});
