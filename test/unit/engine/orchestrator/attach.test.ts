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

/** A flow with a real gate node between the place and the notify terminal, so a
 * `gate-approved` edge can be genuinely posed-and-unanswered rather than merely
 * pending. `evaluate.ts`'s `gateAnswer` only reports `awaiting-answer` once an
 * incoming edge into the gate is itself settled (`performed` and `firedAt` both
 * set) — the caller supplies that "ask" edge. */
const gate = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "gate", question: "Proceed?" });
const withGate = (edges: FlowEdge[], armed = true, createdAt = 0): Flow => ({
  id: "f1", name: "Ship it", armed, createdAt,
  nodes: [place("n1", "PROJ-142"), gate("g1"), notify("n2")],
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
    // what actually halted the workflow. Verified against a REAL awaiting-answer
    // step (a posed, unanswered gate) — not merely an ordinary pending edge that
    // happens to carry a `gate-approved` condition with no gate behind it.
    const s = workflowState(withGate([
      edge({ id: "e-fail", error: "exit 1" }),
      edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: "asked" }),
      edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("stopped");
    expect(s.steps.find((x) => x.edgeId === "e-gate")).toMatchObject({
      state: "you", reason: "awaiting-answer",
    });
  });

  it("reaches waiting-on-you through a real posed, unanswered gate", () => {
    // The gate is asked (an incoming edge settled with `firedAt`) but never
    // answered (no `gateAnswer` on it), which is exactly what `evaluate.ts`
    // reports as blocked `awaiting-answer` — not a hand-built `WorkflowState`.
    const s = workflowState(withGate([
      edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: "asked" }),
      edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
    ]), [], 1000);
    expect(s.status).toBe("waiting-on-you");
    expect(s.steps.find((x) => x.edgeId === "e-gate")).toMatchObject({
      state: "you", reason: "awaiting-answer",
    });
    expect(s.steps.find((x) => x.edgeId === "e-gate")?.receipt).toBeUndefined();
  });

  it("reads a disarmed workflow with a failed edge as stopped", () => {
    // An error is a fact about what already happened, not about what will — so
    // it outranks the disarmed reading rather than being masked by it.
    const s = workflowState(withEdges([edge({ id: "e1", error: "exit 1" })], false), [], 1000);
    expect(s.status).toBe("stopped");
  });

  it("marks only the first pending step as current", () => {
    // Marking every pending step "now" would say the workflow is doing three
    // things at once. Nothing else in this file covers the latch.
    const s = workflowState(withEdges([
      edge({ id: "e1", firedAt: 5 }),
      edge({ id: "e2" }),
      edge({ id: "e3" }),
    ]), [], 1000);
    expect(s.steps.map((x) => x.state)).toEqual(["done", "now", "waiting"]);
  });

  it("carries previewFlow's reason as a code, not as prose", () => {
    // A place naming a run no board has cannot be observed at all, which
    // evaluate.ts reports as blocked "gone". The step hands that code on for
    // the webview to word — it must not invent a sentence itself.
    const s = workflowState(withEdges([edge({ id: "e1" })]), [], 1000);
    expect(s.steps[0].reason).toBe("gone");
    expect(s.steps[0].receipt).toBeUndefined();
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
