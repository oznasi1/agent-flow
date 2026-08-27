import { describe, it, expect } from "vitest";
import { promoteToPlace } from "../../../../src/engine/orchestrator/promote";
import { Flow, FlowNode, PlannedNode, emptyFlow, isPlace } from "../../../../src/engine/orchestrator/model";

const planned = (id: string, over: Partial<PlannedNode> = {}): PlannedNode => ({
  id, kind: "planned", x: 40, y: 80, join: "all",
  ticketKey: "PROJ-12", repos: ["bite-me"], mode: "tdd", dest: "worktree", ...over,
});
/** A fixed clock for the stamps promotion writes — the pass's own `nowMs` in
 * production (see `promoteToPlace`). */
const NOW = 1_800_000_000_000;

const flowWith = (nodes: FlowNode[]): Flow => ({ ...emptyFlow("f1", "f", 0), nodes });

describe("promoteToPlace", () => {
  it("turns the planned node into a place bound to the new run", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "PROJ-12", "bite-me", NOW);
    const n = out.nodes[0];
    expect(isPlace(n)).toBe(true);
    expect(n).toMatchObject({ kind: "place", runKey: "PROJ-12", repo: "bite-me" });
  });

  it("keeps the id, position and join so downstream edges still point at it", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "PROJ-12", "bite-me", NOW);
    expect(out.nodes[0]).toMatchObject({ id: "n3", x: 40, y: 80, join: "all" });
  });

  it("drops the planned-only fields", () => {
    const out = promoteToPlace(flowWith([planned("n3")]), "n3", "PROJ-12", "bite-me", NOW);
    expect(out.nodes[0]).not.toHaveProperty("ticketKey");
    expect(out.nodes[0]).not.toHaveProperty("mode");
    expect(out.nodes[0]).not.toHaveProperty("dest");
    expect(out.nodes[0]).not.toHaveProperty("repos");
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([planned("n3")]);
    const before = JSON.stringify(flow);
    promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW);
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("leaves every other node alone", () => {
    const other: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "r" };
    const out = promoteToPlace(flowWith([other, planned("n3")]), "n3", "PROJ-12", "bite-me", NOW);
    expect(out.nodes[0]).toEqual(other);
  });

  it("is a no-op for an id that is not in the flow", () => {
    const flow = flowWith([planned("n3")]);
    expect(promoteToPlace(flow, "nope", "PROJ-12", "bite-me", NOW)).toEqual(flow);
  });

  it("is a no-op for a node that is not planned", () => {
    // Promoting a place again would rewrite the repo it is bound to, which is a
    // silent change of what every condition on it means.
    const place: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "api" };
    const out = promoteToPlace(flowWith([place]), "n1", "PROJ-9", "web", NOW);
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
    const out = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW);
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
        action: "launch", mode: "tdd", note: "staging", firedAt: 5, firedNote: "launched PROJ-12",
      }],
    };
    const e = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW).edges[0];
    expect(e).toMatchObject({
      id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" },
      mode: "tdd", note: "staging", firedAt: 5, firedNote: "launched PROJ-12",
    });
  });

  it("leaves an edge OUT of the promoted node untouched", () => {
    // A rule leaving the promoted node still means whatever ITS own target
    // implies; nothing about that changed here.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n3", to: "n9", cond: { kind: "ci-passed" }, action: "notify" }],
    };
    const out = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW);
    expect(out.edges[0]).toBe(flow.edges[0]);
  });

  it("settles an untriggered sibling as satisfied rather than leaving it live", () => {
    // Clearing the action alone stopped the false latch but left the rule LIVE with a
    // changed verb: a `launch` rule silently became a `seed`, so its condition coming
    // true later would open an ADDITIONAL paid agent session the user never wrote,
    // under a consent stamped for a launch. A sibling like this only exists in a
    // `join: "any"` fan-in, which means "any one of these reasons is enough to get
    // this node running" — and it is running now.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [
        // The performer, already stamped by `applyFired` before promotion runs.
        { id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch", firedAt: 5, firedNote: "launched PROJ-12 in bite-me", performed: true },
        // The sibling whose condition never held.
        { id: "e2", from: "n2", to: "n3", cond: { kind: "ci-passed" }, action: "launch" },
      ],
    };
    const e2 = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW).edges[1];
    expect(e2.firedAt).toBe(NOW);
    expect(e2.firedNote).toBe("PROJ-12 was already launched by another rule");
    // NOT `performed`: this rule ran nothing. The exact shape `applyFired` writes for
    // a demoted sibling, which is what keeps `commandSucceeded` from reading it as a
    // performer and what `FlowEdge.performed`'s doc comment describes.
    expect(e2.performed).toBeUndefined();
    // Not an error either — nothing failed, so nothing here may spend `--c-danger`.
    expect(e2.error).toBeUndefined();
    // And the action is still cleared, so the Reset this offers lands on a live rule
    // rather than back inside the conversion.
    expect(e2).not.toHaveProperty("action");
  });

  it("leaves the performer's own receipt alone", () => {
    // It is history: rewriting it would blame the promotion for what the launch did.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch", firedAt: 5, firedNote: "launched PROJ-12 in bite-me", performed: true }],
    };
    const e1 = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW).edges[0];
    expect(e1.firedAt).toBe(5);
    expect(e1.firedNote).toBe("launched PROJ-12 in bite-me");
    expect(e1.performed).toBe(true);
  });

  it("does not overwrite an errored sibling's own failure", () => {
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n1", to: "n3", cond: { kind: "pr-merged" }, action: "launch", error: "Couldn't launch PROJ-12: no worktree" }],
    };
    const e1 = promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW).edges[0];
    expect(e1.error).toBe("Couldn't launch PROJ-12: no worktree");
    expect(e1.firedAt).toBeUndefined();
  });

  it("does not stamp an edge OUT of the promoted node", () => {
    // A rule leaving the node is the chain's next hop — the whole reason promotion
    // exists — and settling it would kill the link it just made possible.
    const flow: Flow = {
      ...flowWith([planned("n3")]),
      edges: [{ id: "e1", from: "n3", to: "n9", cond: { kind: "ci-passed" }, action: "notify" }],
    };
    expect(promoteToPlace(flow, "n3", "PROJ-12", "bite-me", NOW).edges[0]).toBe(flow.edges[0]);
  });

  it("clears nothing when nothing was promoted", () => {
    // Same gate as the node rewrite: a call naming a node that is already a place
    // changes no kind, so no edge's meaning moved and no stored action is stale.
    const place: FlowNode = { id: "n1", kind: "place", x: 0, y: 0, join: "any", runKey: "PROJ-1", repo: "api" };
    const flow: Flow = {
      ...flowWith([place]),
      edges: [{ id: "e1", from: "n0", to: "n1", cond: { kind: "pr-merged" }, action: "seed" }],
    };
    expect(promoteToPlace(flow, "n1", "PROJ-9", "web", NOW).edges[0].action).toBe("seed");
  });
});
