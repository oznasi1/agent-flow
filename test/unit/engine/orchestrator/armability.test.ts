import { describe, it, expect } from "vitest";
import { unfirableRules, SourceState } from "../../../../src/engine/orchestrator/armability";
import { Condition, Flow, FlowEdge, emptyFlow } from "../../../../src/engine/orchestrator/model";

const edge = (id: string, cond: Condition): FlowEdge =>
  ({ id, from: "a", to: "z", cond, action: "notify" });
const flowOf = (...edges: FlowEdge[]): Flow => ({ ...emptyFlow("f1", "f", 0), edges });
const ALL_ON: SourceState = { liveSignal: true, prFacts: true };

describe("unfirableRules", () => {
  it("is empty when every source is on", () => {
    const flow = flowOf(edge("e1", { kind: "pr-merged" }), edge("e2", { kind: "agent-ended-turn" }));
    expect(unfirableRules(flow, ALL_ON)).toEqual([]);
  });

  it("names an agent rule when the Live signal is off", () => {
    const flow = flowOf(edge("e1", { kind: "agent-ended-turn" }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([
      { edgeId: "e1", needs: "live-signal", label: expect.any(String) },
    ]);
  });

  it("names agent-idle-over too", () => {
    const flow = flowOf(edge("e1", { kind: "agent-idle-over", minutes: 10 }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true }).map((r) => r.edgeId)).toEqual(["e1"]);
  });

  it("does NOT name no-agent-left — it reads the session registry, not a transcript", () => {
    const flow = flowOf(edge("e1", { kind: "no-agent-left" }));
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([]);
  });

  it("names every PR condition when PR facts is off", () => {
    const kinds: Condition["kind"][] = [
      "pr-merged", "ci-passed", "ci-failed", "review-approved",
      "changes-requested", "threads-resolved", "pr-conflicting",
    ];
    const flow = flowOf(...kinds.map((k, i) => edge(`e${i}`, { kind: k } as Condition)));
    const out = unfirableRules(flow, { liveSignal: true, prFacts: false });
    expect(out).toHaveLength(kinds.length);
    expect(out.every((r) => r.needs === "pr-facts")).toBe(true);
  });

  it("never names a git or ticket condition — their data is always there", () => {
    const flow = flowOf(
      edge("e1", { kind: "tree-clean" }),
      edge("e2", { kind: "has-uncommitted" }),
      edge("e3", { kind: "nothing-to-push" }),
      edge("e4", { kind: "ticket-done" }),
      edge("e5", { kind: "ticket-status-is", status: "Done" }),
    );
    expect(unfirableRules(flow, { liveSignal: false, prFacts: false })).toEqual([]);
  });

  it("reports both kinds at once, in flow order", () => {
    const flow = flowOf(edge("e1", { kind: "pr-merged" }), edge("e2", { kind: "agent-ended-turn" }));
    const out = unfirableRules(flow, { liveSignal: false, prFacts: false });
    expect(out.map((r) => [r.edgeId, r.needs])).toEqual([
      ["e1", "pr-facts"],
      ["e2", "live-signal"],
    ]);
  });

  it("skips an edge that has already fired — it is not waiting on anything", () => {
    const flow = flowOf({ ...edge("e1", { kind: "pr-merged" }), firedAt: 1 });
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false })).toEqual([]);
  });

  it("gives each rule a human label naming its condition", () => {
    const flow = flowOf(edge("e1", { kind: "ci-failed" }));
    const [only] = unfirableRules(flow, { liveSignal: true, prFacts: false });
    expect(only.label.toLowerCase()).toContain("ci");
  });
});
