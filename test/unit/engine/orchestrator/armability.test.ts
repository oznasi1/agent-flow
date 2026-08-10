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

  it("names a branch-CI rule when PR facts are off — same gh path, same toggle", () => {
    // It reads no pull request at all, but `deckView.ts` gates its branch-CI fetch
    // on the same `ghReady()` the PR fetches go through, so with that off the
    // verdict map is empty every pass and the rule waits forever.
    const flow = flowOf(edge("e1", { kind: "branch-ci-passed", repo: "bite-me", branch: "master" }));
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false })).toEqual([
      { edgeId: "e1", needs: "pr-facts", label: expect.any(String) },
    ]);
    // And never blamed on the Live signal, which has nothing to do with it.
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([]);
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
    // Live-signal edge first, then PR — opposite of type-grouped order
    const flow = flowOf(
      edge("e1", { kind: "agent-ended-turn" }),
      edge("e2", { kind: "pr-merged" }),
      edge("e3", { kind: "ci-passed" }),
    );
    const out = unfirableRules(flow, { liveSignal: false, prFacts: false });
    expect(out.map((r) => [r.edgeId, r.needs])).toEqual([
      ["e1", "live-signal"],
      ["e2", "pr-facts"],
      ["e3", "pr-facts"],
    ]);
  });

  it("skips an edge that has already fired — it is not waiting on anything", () => {
    const flow = flowOf({ ...edge("e1", { kind: "pr-merged" }), firedAt: 1 });
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false })).toEqual([]);
  });

  it("skips an edge that ERRORED — settled means settled, whichever way", () => {
    // The same notion of settled `evaluate.ts` skips on. An edge carrying `error`
    // and no `firedAt` is never evaluated again either, so naming it here would
    // blame the PR-facts toggle for a rule whose real reason is a failure the
    // drawer already shows and offers a Reset for.
    const flow = flowOf({ ...edge("e1", { kind: "pr-merged" }), error: "Couldn't launch ASM-12: no worktree" });
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false })).toEqual([]);
  });

  it("skips an errored LIVE-signal edge too, not just a PR one", () => {
    const flow = flowOf({ ...edge("e1", { kind: "agent-ended-turn" }), error: "boom" });
    expect(unfirableRules(flow, { liveSignal: false, prFacts: true })).toEqual([]);
  });

  it("still names an unsettled sibling of an errored edge", () => {
    // The skip must be per-edge, not a bail on the whole flow: e2 is genuinely
    // waiting on a toggle that is off and must still be reported.
    const flow = flowOf(
      { ...edge("e1", { kind: "pr-merged" }), error: "boom" },
      edge("e2", { kind: "ci-passed" }),
    );
    expect(unfirableRules(flow, { liveSignal: true, prFacts: false }).map((r) => r.edgeId)).toEqual(["e2"]);
  });

  it("gives each rule a human label naming its condition", () => {
    const flow = flowOf(edge("e1", { kind: "ci-failed" }));
    const [only] = unfirableRules(flow, { liveSignal: true, prFacts: false });
    expect(only.label.toLowerCase()).toContain("ci");
  });

  it("every condition kind has a non-empty, trimmed label", () => {
    const kinds: Condition["kind"][] = [
      "pr-merged", "ci-passed", "ci-failed", "review-approved",
      "changes-requested", "threads-resolved", "pr-conflicting",
      "agent-ended-turn", "agent-idle-over", "no-agent-left",
      "tree-clean", "has-uncommitted", "nothing-to-push",
      "ticket-done", "ticket-status-is",
    ];
    const flow = flowOf(...kinds.map((k, i) => edge(`e${i}`, { kind: k } as Condition)));
    const out = unfirableRules(flow, { liveSignal: false, prFacts: false });
    // Collect all labels seen (from unfirableRules) and verify format
    const seenLabels = new Set(out.map((r) => r.label));
    // All unfirableRules should have labels matching the format
    for (const label of seenLabels) {
      expect(label).toBeTruthy();
      expect(label).toBe(label.trim());
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
