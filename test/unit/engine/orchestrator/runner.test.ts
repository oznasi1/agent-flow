import { describe, it, expect } from "vitest";
import { applyFired, notifyLines } from "../../../../src/engine/orchestrator/runner";
import { Flow, FlowEdge, FlowNode, JoinMode, NotifyNode, PlaceNode, emptyFlow } from "../../../../src/engine/orchestrator/model";
import { FiredEdge } from "../../../../src/engine/orchestrator/evaluate";

const NOW = 1_800_000_000_000;

const place = (id: string, runKey: string, join: JoinMode = "any"): PlaceNode =>
  ({ id, kind: "place", x: 0, y: 0, join, runKey, repo: `repo-${runKey}` });
const notify = (id: string, message: string, join: JoinMode = "any"): NotifyNode =>
  ({ id, kind: "notify", x: 0, y: 0, join, message });
const edge = (id: string, from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge =>
  ({ id, from, to, cond: { kind: "pr-merged" }, action: "notify", ...over });

const flowWith = (nodes: FlowNode[], edges: FlowEdge[]): Flow =>
  ({ ...emptyFlow("f1", "Ship the migration", 0), armed: true, nodes, edges });

describe("applyFired", () => {
  it("stamps firedAt and a note on a performed edge", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }], NOW);
    expect(out.edges[0].firedAt).toBe(NOW);
    expect(out.edges[0].firedNote).toBeTruthy();
  });

  it("does not mutate the flow it is given", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const before = JSON.stringify(flow);
    applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }], NOW);
    expect(JSON.stringify(flow)).toBe(before);
  });

  it("stamps a perform:false edge too — an unstamped junction sibling re-evaluates forever", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "notify" }, { edge: flow.edges[1], perform: false, action: "notify" }],
      NOW,
    );
    expect(out.edges.map((e) => e.firedAt)).toEqual([NOW, NOW]);
  });

  it("distinguishes a performed note from a stamped-only one", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "notify" }, { edge: flow.edges[1], perform: false, action: "notify" }],
      NOW,
    );
    expect(out.edges[0].firedNote).not.toBe(out.edges[1].firedNote);
    // The stamped-only one must not claim it did something.
    expect(out.edges[1].firedNote).toMatch(/already acted|another edge/i);
  });

  it("leaves an edge that did not fire completely alone", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("y", "one"), notify("z", "two")], [edge("e1", "a", "y"), edge("e2", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }], NOW);
    expect(out.edges[1].firedAt).toBeUndefined();
    expect(out.edges[1].firedNote).toBeUndefined();
  });

  it("keeps every other field of the flow and of each edge", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "done")], [edge("e1", "a", "z", { cond: { kind: "ci-failed" } })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }], NOW);
    expect(out.name).toBe("Ship the migration");
    expect(out.armed).toBe(true);
    expect(out.edges[0].cond).toEqual({ kind: "ci-failed" });
    expect(out.nodes).toEqual(flow.nodes);
  });

  it("returns an equal flow when nothing fired", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    expect(applyFired(flow, [], NOW)).toEqual(flow);
  });

  it("ignores a fired edge whose id is not in the flow", () => {
    // Defensive: the runner is handed edges by the evaluator, but a stale
    // EvalResult must not be able to invent an edge.
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "done")], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: edge("ghost", "a", "z"), perform: true, action: "notify" }], NOW);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].firedAt).toBeUndefined();
  });

  it("records an ERROR, not a firedAt, for a performed acting edge the caller reported nothing about", () => {
    // The caller performs a `launch` or a `seed` and says what happened. When it
    // says nothing, this must fail CLOSED rather than stamp a success: `firedAt`
    // consumes the latch AS A SUCCESS, so an edge nobody actually performed would
    // look already-done forever and never run. `error` is settled too (see
    // isSettled), so it still cannot re-fire in a loop, but the drawer surfaces it
    // and offers Reset, and a Reset makes it genuinely run later.
    // The target `b` is a `place`, whose derived action is `seed` — see
    // `actionFor` in model.ts — regardless of the edge's own stored `action`.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "launch" })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "seed" }], NOW);
    expect(out.edges[0].error).toBeTruthy();
    // The latch must NOT read as a success.
    expect(out.edges[0].firedAt).toBeUndefined();
    expect(out.edges[0].firedNote).toBeUndefined();
  });

  it("names the action it could not perform, and never claims it ran", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "seed" })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "seed" }], NOW);
    expect(out.edges[0].error).toBe("seed was not performed");
    expect(out.edges[0].error).not.toMatch(/success|ran|done|told you/i);
  });

  it("takes the note from the caller for an acting edge that succeeded", () => {
    // The whole point of the outcome argument: only the caller knows whether a
    // launch opened a window, and what to call it. `applyFired` must not pre-judge.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "launch" })]);
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "launch" }],
      NOW,
      new Map([["e1", { ok: true, note: "launched PROJ-12 in aws-ops" } as const]]),
    );
    expect(out.edges[0].firedAt).toBe(NOW);
    expect(out.edges[0].firedNote).toBe("launched PROJ-12 in aws-ops");
    expect(out.edges[0].error).toBeUndefined();
  });

  it("takes the error from the caller for an acting edge that failed, and stamps no firedAt", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "launch" })]);
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "seed" }],
      NOW,
      new Map([["e1", { ok: false, error: "Couldn't launch PROJ-12: no worktree" } as const]]),
    );
    expect(out.edges[0].error).toBe("Couldn't launch PROJ-12: no worktree");
    expect(out.edges[0].firedAt).toBeUndefined();
    expect(out.edges[0].firedNote).toBeUndefined();
  });

  it("keeps a notify edge's own note even when the caller reports an outcome for it", () => {
    // A caller only ever performs the acting verbs, but an outcome keyed to a
    // notify edge must not be able to rewrite what the toast already said.
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "notify" }],
      NOW,
      new Map([["e1", { ok: false, error: "nonsense" } as const]]),
    );
    expect(out.edges[0].error).toBeUndefined();
    expect(out.edges[0].firedNote).toBe("told you: the migration has landed");
  });

  it("branches on the action it actually performed, not on the flow's current copy of it", () => {
    // `hit.action` is the vintage the caller (`deckView.ts`) carried from
    // evaluation, before ever calling `performEdge` — the vintage `outcomes` is
    // keyed to, and the vintage a launch or seed actually ran against. `flow`,
    // this function's own first argument, can be a LATER read (`atWrite` in
    // `deckView.ts`, re-read after the act so a concurrent edit's other fields
    // pass through) — and if that concurrent edit ALSO changed this exact
    // edge's action, `flow`'s copy and `hit.action` disagree about what kind of
    // edge this is. Trusting `flow`'s copy here would silently discard a real
    // launch's outcome for a generic "told you" note, because the flow now says
    // this edge is a `notify`. `e1`'s stored `action` fields (on both `flow`'s
    // edge and `performed`) are the legacy mirror and are irrelevant to this
    // branch — only `hit.action`, set explicitly below to `seed`, decides it.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "notify" })]);
    const performed = edge("e1", "a", "b", { action: "launch" }); // same id, the earlier (acted-on) vintage
    const out = applyFired(
      flow,
      [{ edge: performed, perform: true, action: "seed" }],
      NOW,
      new Map([["e1", { ok: true, note: "launched PROJ-12 in aws-ops" } as const]]),
    );
    expect(out.edges[0].firedAt).toBe(NOW);
    expect(out.edges[0].firedNote).toBe("launched PROJ-12 in aws-ops");
    expect(out.edges[0].error).toBeUndefined();
  });

  it("marks the performer performed:true and leaves the demoted sibling's performed unset", () => {
    // `evaluate.ts`'s `commandSucceeded` reads exactly this field to tell a
    // performer apart from a stamped-only sibling — `firedAt`/`error` alone
    // cannot, because a demoted sibling gets the identical `firedAt`-set,
    // `error`-absent shape a successful performer gets. This is the field
    // that fix depends on, asserted directly against `applyFired`'s real
    // output rather than a hand-constructed fixture.
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), notify("z", "both landed", "all")],
      [edge("e1", "a", "z"), edge("e2", "b", "z")],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "notify" }, { edge: flow.edges[1], perform: false, action: "notify" }],
      NOW,
    );
    expect(out.edges[0].performed).toBe(true);
    expect(out.edges[1].performed).toBeUndefined();
  });

  it("marks a FAILED performer performed:true too — the one that ran and failed is still the one that ran", () => {
    // If a failed performer did not carry `performed`, `commandSucceeded`
    // would find no performer at all for a command that genuinely tried and
    // failed, inverting the bug the field exists to fix: the sibling's own
    // `performed` was already undefined either way, so silence here would
    // read as "never ran" instead of "ran and failed" — both wrong, but the
    // second is the one Task 7's condition must distinguish.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "launch" })]);
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "seed" }],
      NOW,
      new Map([["e1", { ok: false, error: "Couldn't launch PROJ-12: no worktree" } as const]]),
    );
    expect(out.edges[0].error).toBe("Couldn't launch PROJ-12: no worktree");
    expect(out.edges[0].performed).toBe(true);
  });

  it("marks a fail-closed performer (no outcome reported at all) performed:true as well", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "seed" })]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "seed" }], NOW);
    expect(out.edges[0].error).toBe("seed was not performed");
    expect(out.edges[0].performed).toBe(true);
  });

  it("says what is wrong with the GRAPH for an edge whose action could not be derived", () => {
    // Reachable: `store.ts`'s `validNode` admits an unknown node kind on purpose so
    // a flow written by a newer build still renders, `actionFor` derives nothing for
    // it, and `evaluateFlow` still fires the edge. This arm used to fall in with the
    // acting ones and stamp the literal string "undefined was not performed", while
    // the sentence written for exactly this case sat unreachable in `performEdge`
    // (the dispatch there only ever calls it for a spending verb).
    const unknown = { id: "z", kind: "webhook", x: 0, y: 0, join: "any" } as unknown as FlowNode;
    const flow = flowWith([place("a", "PROJ-1"), unknown], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: undefined }], NOW);
    expect(out.edges[0].error).toBe(
      "this rule points at z, which is not a place, planned work, a notification, or a command.",
    );
    expect(out.edges[0].error).not.toContain("undefined");
    // Settled, but never as a success: the drawer surfaces it and offers Reset.
    expect(out.edges[0].firedAt).toBeUndefined();
    expect(out.edges[0].performed).toBe(true);
  });

  it("does not claim a derivable-action rule was told to anybody", () => {
    // The same edge, `perform: false` — a sibling that did nothing. It closes with
    // the junction's own note rather than the refusal above, which is about an
    // action that was attempted.
    const unknown = { id: "z", kind: "webhook", x: 0, y: 0, join: "any" } as unknown as FlowNode;
    const flow = flowWith([place("a", "PROJ-1"), unknown], [edge("e1", "a", "z")]);
    const out = applyFired(flow, [{ edge: flow.edges[0], perform: false, action: undefined }], NOW);
    expect(out.edges[0].error).toBeUndefined();
    expect(out.edges[0].firedNote).toBe("another edge into this target already acted");
  });

  it("stamps a NON-performed non-notify edge as fired, not errored — it did nothing, and its junction closed", () => {
    // The distinction the error must not swallow: a perform:false sibling never
    // attempted its action, so there is nothing to have failed. Recording an error
    // for it would stall the junction it just legitimately closed.
    const flow = flowWith(
      [place("a", "PROJ-1"), place("b", "PROJ-2"), place("c", "PROJ-3", "all")],
      [edge("e1", "a", "c"), edge("e2", "b", "c", { action: "launch" })],
    );
    const out = applyFired(
      flow,
      [{ edge: flow.edges[0], perform: true, action: "seed" }, { edge: flow.edges[1], perform: false, action: "seed" }],
      NOW,
    );
    expect(out.edges[1].error).toBeUndefined();
    expect(out.edges[1].firedAt).toBe(NOW);
    expect(out.edges[1].firedNote).toBe("another edge into this target already acted");
    expect(out.edges[1].performed).toBeUndefined();
  });
});

describe("notifyLines", () => {
  it("names the flow and the notify node's own message", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "the migration has landed")], [edge("e1", "a", "z")]);
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
    expect(lines[0]).toContain("the migration has landed");
  });

  it("says nothing for a stamped-only edge — it performed nothing", () => {
    const flow = flowWith([place("a", "PROJ-1"), notify("z", "done", "all")], [edge("e1", "a", "z")]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: false, action: "notify" }])).toEqual([]);
  });

  it("says nothing for an action that is not notify", () => {
    // The target `b` is a `place`, whose derived action is `seed`; if one
    // appears in a hand-edited flow it must not produce a toast claiming it ran.
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b", { action: "launch" })]);
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: true, action: "seed" }])).toEqual([]);
  });

  it("falls back gracefully when the target is not a notify node", () => {
    const flow = flowWith([place("a", "PROJ-1"), place("b", "PROJ-2")], [edge("e1", "a", "b")]);
    // The carried action is notify but the target is a place — a hand-edited
    // flow, since a `place` target would normally derive `seed`. One line, no
    // crash, and no invented message.
    const lines = notifyLines(flow, [{ edge: flow.edges[0], perform: true, action: "notify" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ship the migration");
  });

  it("returns one line per performed notify edge", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), notify("y", "first"), notify("z", "second")],
      [edge("e1", "a", "y"), edge("e2", "a", "z")],
    );
    const lines = notifyLines(flow, [
      { edge: flow.edges[0], perform: true, action: "notify" },
      { edge: flow.edges[1], perform: true, action: "notify" },
    ]);
    expect(lines).toHaveLength(2);
  });

  // The whole point of carrying the action: `notifyLines` must announce what was
  // DECIDED, not re-derive it from a copy that may have changed underneath.
  it("announces a notify from the carried action, not the current graph", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), notify("z", "the migration has landed")],
      [edge("e1", "a", "z")],
    );
    const fired: FiredEdge[] = [{ edge: flow.edges[0], perform: true, action: "notify" }];
    // The graph now says z is a place — a concurrent edit between the decision and
    // this call. The decision stands, and the message is gone with the node.
    const edited: Flow = { ...flow, nodes: [flow.nodes[0], place("z", "PROJ-9")] };
    expect(notifyLines(edited, fired)).toEqual(["Ship the migration: a rule fired."]);
  });

  // The inverse, so the test above cannot pass by ignoring `action` altogether.
  it("says nothing for a carried action that is not notify", () => {
    const flow = flowWith(
      [place("a", "PROJ-1"), notify("z", "the migration has landed")],
      [edge("e1", "a", "z")],
    );
    const fired: FiredEdge[] = [{ edge: flow.edges[0], perform: true, action: "launch" }];
    expect(notifyLines(flow, fired)).toEqual([]);
  });
});

describe("applyFired — an ask edge", () => {
  const gateFlow = (): Flow => ({
    ...emptyFlow("f1", "f", 0),
    nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" }],
    edges: [{ id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" } }],
  });

  it("stamps a receipt naming the question, and needs no outcome", () => {
    const flow = gateFlow();
    const next = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "ask" }], 99);
    expect(next.edges[0].firedAt).toBe(99);
    expect(next.edges[0].firedNote).toBe("asked you: deploy to prod?");
    expect(next.edges[0].performed).toBe(true);
    expect(next.edges[0].error).toBeUndefined();
  });

  it("isSpendAction must not admit ask — it is never dispatched or subjected to spending constraints", () => {
    // Architectural guard: this guards the most consequential single line in the whole feature.
    // `isSpendAction` (model.ts) must never admit "ask", because a gate is not a spending action.
    // If it did, a gate would compete for the three-per-pass launch cap and, worse, fall under
    // the spend-consent modal — a question costs nothing and must never trigger paid-session guards.
    // This test does NOT exercise performedNote (Task 3's code); it enforces isSpendAction's
    // allowlist in model.ts. `run`, `launch` and `seed` all fail closed with "was not performed"
    // when the caller reports nothing. An ask is never dispatched, so it never goes through
    // that branch — and if isSpendAction ever admitted it, this test would fail.
    const flow = gateFlow();
    const next = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "ask" }], 99);
    expect(next.edges[0].error).toBeUndefined();
  });

  it("falls back to a neutral receipt when the target is no longer a gate", () => {
    const flow = { ...gateFlow(), nodes: [] };
    const next = applyFired(flow, [{ edge: flow.edges[0], perform: true, action: "ask" }], 99);
    expect(next.edges[0].firedNote).toBe("asked you");
  });

  it("says nothing in a toast — a gate is not a notify", () => {
    // Architectural guard: the spec rejected posting an unawaited toast for a gate. A promise
    // can resolve an hour later into a flow that has since been disarmed, deleted, renamed or
    // Reset, and every one of those needs a guard. The drawer is the only answering surface.
    // This does NOT exercise `performedNote` (Task 3's code); it exercises `notifyLines`'s
    // action guard that prevents non-notify actions from producing toast lines.
    const flow = gateFlow();
    expect(notifyLines(flow, [{ edge: flow.edges[0], perform: true, action: "ask" }])).toEqual([]);
  });
});
