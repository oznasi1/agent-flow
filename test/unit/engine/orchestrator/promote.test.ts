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

  it("clears the stored action on every edge into the promoted node", () => {
    // Promotion flips the node `planned` -> `place`, which is the other direction
    // `edgeAction` moves: an edge into it meant `launch` and means `seed` now. A
    // stored `launch` left behind is the disagreement `latchActionMismatches`
    // stamps an edge dead for on the very next read — and in a fan-in the sibling
    // that did NOT trigger is still unsettled, so the engine would latch a rule
    // the user never touched.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [
        { id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch" },
        { id: "e2", from: "n2", to: "n3", cond: { kind: "ci-passed" }, action: "launch" },
      ],
    };
    const out = promoteToPlace(flow, "n3", "ASM-12", "bite-me");
    expect(out.edges[0].action).toBeUndefined();
    expect(out.edges[1].action).toBeUndefined();
    // The FIELD is removed, not set to `undefined`: that is the shape an edge
    // this build creates has, and the one `writeFlow`'s `e.action ?? derived`
    // and an older build's `validEdge` both reason about.
    expect(out.edges[0]).not.toHaveProperty("action");
  });

  it("keeps every other field on an edge whose action it clears", () => {
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{
        id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" },
        action: "launch", mode: "tdd", note: "staging", firedAt: 5, firedNote: "launched ASM-12",
      }],
    };
    const e = promoteToPlace(flow, "n3", "ASM-12", "bite-me").edges[0];
    expect(e).toMatchObject({
      id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" },
      mode: "tdd", note: "staging", firedAt: 5, firedNote: "launched ASM-12",
    });
  });

  it("leaves an edge OUT of the promoted node untouched", () => {
    // A rule leaving the promoted node still means whatever ITS own target
    // implies; nothing about that changed here.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n3", to: "n9", cond: { kind: "ci-passed" }, action: "notify" }],
    };
    const out = promoteToPlace(flow, "n3", "ASM-12", "bite-me");
    expect(out.edges[0]).toBe(flow.edges[0]);
  });

  it("clears nothing when nothing was promoted", () => {
    // Same gate as the node rewrite: a call naming a node that is already a place
    // changes no kind, so no edge's meaning moved and no stored action is stale.
    const place: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "ASM-1", repo: "api" };
    const flow: Flow = {
      ...flowWith([place]),
      edges: [{ id: "e1", from: "n0", to: "n1", cond: { kind: "pr-merged" }, action: "seed" }],
    };
    expect(promoteToPlace(flow, "n1", "ASM-9", "web").edges[0].action).toBe("seed");
  });
});
