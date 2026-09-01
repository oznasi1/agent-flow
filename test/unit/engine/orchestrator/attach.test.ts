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
