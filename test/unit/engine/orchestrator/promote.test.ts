import { describe, it, expect } from "vitest";
import { promoteToPlace } from "../../../../src/engine/orchestrator/promote";
import { Flow, FlowNode, PlannedNode, emptyFlow, isPlace } from "../../../../src/engine/orchestrator/model";

const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 40, y: 80, join: "all",
  ticketKey: "ASM-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
});
const flowWith = (nodes: FlowNode[]): Flow => ({ ...emptyFlow("f1", "f", 0), nodes });

describe("promoteToPlace", () => {
  it("turns the planned node into a place bound to the new run", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    const n = out.nodes[0];
    expect(isPlace(n)).toBe(true);
    expect(n).toMatchObject({ kind: "place", runKey: "ASM-12", repo: "bite-me" });
  });

  it("keeps the id, position and join so downstream edges still point at it", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).toMatchObject({ id: "n3", x: 40, y: 80, join: "all" });
  });

  it("drops the planned-only fields", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).not.toHaveProperty("ticketKey");
    expect(out.nodes[0]).not.toHaveProperty("mode");
    expect(out.nodes[0]).not.toHaveProperty("dest");
    expect(out.nodes[0]).not.toHaveProperty("repos");
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([planned("n3")]);
    const before = JSON.stringify(flow);
    promoteToPlace(flow, "n3", "ASM-12", "bite-me");
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("leaves every other node alone", () => {
    const other: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "r" };
    const out = promoteToPlace(flowWith([other, planned("n3")]), "n3", "ASM-12", "bite-me");
    expect(out.nodes[0]).toEqual(other);
  });

  it("is a no-op for an id that is not in the flow", () => {
    const flow = flowWith([planned("n3")]);
    expect(promoteToPlace(flow, "nope", "ASM-12", "bite-me")).toEqual(flow);
  });

  it("is a no-op for a node that is not planned", () => {
    // Promoting a place again would rewrite the repo it is bound to, which is a
    // silent change of what every condition on it means.
    const place: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "api" };
    const out = promoteToPlace(flowWith([place]), "n1", "ASM-9", "web");
    expect(out.nodes[0]).toEqual(place);
  });

  it("leaves the edges untouched", () => {
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch", mode: "tdd" }],
    };
    expect(promoteToPlace(flow, "n3", "ASM-12", "bite-me").edges).toEqual(flow.edges);
  });
});
