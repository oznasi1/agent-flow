// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowBlock, WorkflowBlockProps } from "../../src/webview/WorkflowBlock";
import type { Flow, FlowEdge, FlowNode } from "../../src/engine/orchestrator/model";
import type { StepState } from "../../src/engine/orchestrator/attach";

// Same minimal fixture shape test/unit/engine/orchestrator/attach.test.ts already
// uses: a place feeding a notify terminal is enough for `ruleOneLine` and
// `edgeAction` to read a real sentence off every edge, and nothing this block
// renders cares what the rule actually does.
const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "ingest-worker" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const edge = (id: string): FlowEdge => ({ id, from: "n1", to: "n2", cond: { kind: "pr-merged" } });

// Five edges — enough for every fixture below (`twoDone`, `twoWaiting`, and the
// single-step gate/fail cases) to name real edges without each test having to
// mint its own flow. A `state.steps` array that omits some of these edges is
// exactly the "not asked about" case: the block renders one row per matched
// step, in `flow.edges` order, and simply has nothing to say about an edge no
// `StepState` describes.
const flow: Flow = {
  id: "f1",
  name: "Ship it",
  armed: true,
  createdAt: 0,
  nodes: [place("n1", "PROJ-142"), notify("n2")],
  edges: [edge("e1"), edge("e2"), edge("e3"), edge("e4"), edge("e5")],
};

const twoDone: StepState[] = [
  { edgeId: "e1", state: "done", receipt: "launched · claude · worktree" },
  { edgeId: "e2", state: "done", receipt: "ran · exit 0 · 41s" },
];

const twoWaiting: StepState[] = [
  { edgeId: "e1", state: "now", receipt: "1 of 2 approvals" },
  { edgeId: "e2", state: "waiting" },
];

function makeBase(): WorkflowBlockProps {
  return {
    flow,
    state: { status: "advancing", done: 2, total: 5, steps: [...twoDone, { edgeId: "e3", state: "now" }] },
    extraCount: 0,
    onAttach: vi.fn(),
    onArm: vi.fn(),
    onDetach: vi.fn(),
    onAnswerGate: vi.fn(),
    onResetEdge: vi.fn(),
    onOpenInWorkflows: vi.fn(),
  };
}

describe("WorkflowBlock", () => {
  it("offers Attach workflow when nothing is attached", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={undefined} state={undefined} />);
    expect(screen.getByText("No workflow attached")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    expect(base.onAttach).toHaveBeenCalled();
  });

  it("shows Arm and greys the steps when disarmed", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{ status: "disarmed", done: 0, total: 2, steps: twoWaiting }} />);
    await waitFor(() => expect(screen.getByText("disarmed")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(base.onArm).toHaveBeenCalledWith(true);
  });

  it("rings the current step and prints why it waits", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "advancing", done: 2, total: 5,
      steps: [...twoDone, { edgeId: "e3", state: "now", receipt: "1 of 2 approvals" }],
    }} />);
    await waitFor(() => {
      expect(screen.getByText("2 of 5")).toBeTruthy();
      expect(screen.getByText("1 of 2 approvals")).toBeTruthy();
    });
  });

  it("offers Approve and Reject on a gate, and answers it", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "waiting-on-you", done: 1, total: 3,
      steps: [{ edgeId: "e2", state: "you", receipt: "waiting for your answer" }],
    }} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(base.onAnswerGate).toHaveBeenCalledWith("e2", "approved");
  });

  it("offers Reject on a gate, and answers it", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "waiting-on-you", done: 1, total: 3,
      steps: [{ edgeId: "e2", state: "you", reason: "awaiting-answer" }],
    }} />);
    // No receipt on this fixture — `attach.ts` never sets one for `you`, only
    // `reason`. The block must turn that code into the same sentence on its own.
    await waitFor(() => expect(screen.getByText("waiting for your answer")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(base.onAnswerGate).toHaveBeenCalledWith("e2", "rejected");
  });

  it("says a step whose source is gone can never be met, not merely waiting", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "advancing", done: 0, total: 1,
      steps: [{ edgeId: "e1", state: "waiting", reason: "gone" }],
    }} />);
    await waitFor(() => expect(screen.getByText(/can never be met/)).toBeTruthy());
  });

  it("offers Reset on a failed step and prints the error verbatim", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "stopped", done: 1, total: 2,
      steps: [{ edgeId: "e2", state: "fail", receipt: "exit 1 · 3 assertions failed" }],
    }} />);
    await waitFor(() => expect(screen.getByText("exit 1 · 3 assertions failed")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(base.onResetEdge).toHaveBeenCalledWith("e2");
  });

  it("offers Detach when every rule has settled", () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{ status: "done", done: 2, total: 2, steps: twoDone }} />);
    expect(screen.getByRole("button", { name: "Detach" })).toBeTruthy();
  });

  it("offers Disarm on an advancing workflow, not Arm or Detach", () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} />);
    expect(screen.getByRole("button", { name: "Disarm" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Arm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Detach" })).toBeNull();
  });

  it("disarms through the callback", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} />);
    await userEvent.click(screen.getByRole("button", { name: "Disarm" }));
    expect(base.onArm).toHaveBeenCalledWith(false);
  });

  it("opens the Workflows drawer from the header", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} />);
    await userEvent.click(screen.getByRole("button", { name: "Open in Workflows ↗" }));
    expect(base.onOpenInWorkflows).toHaveBeenCalled();
  });

  it("says how many other workflows bind this card", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} extraCount={1} />);
    await waitFor(() => expect(screen.getByText("+1 more")).toBeTruthy());
  });

  it("says nothing about other workflows when there are none", () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} />);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it("keeps Approve buttons distinguishable when two gates are on screen", async () => {
    // Two `you` steps at once: a screen reader hearing "Approve" twice with no
    // further context is the defect the brief calls out. Each button's own
    // rule sentence must reach the accessible tree as its description, without
    // changing the plain "Approve" name a caller queries by. e4 targets a
    // SECOND place node with a different condition so its sentence genuinely
    // differs from e1's — reusing the shared `edge()` helper for both would
    // make them read identically and prove nothing.
    const twoFlow: Flow = {
      ...flow,
      nodes: [...flow.nodes, place("n3", "PROJ-9")],
      edges: [edge("e1"), { id: "e4", from: "n3", to: "n2", cond: { kind: "ci-passed" } }],
    };
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={twoFlow} state={{
      status: "waiting-on-you", done: 0, total: 2,
      steps: [{ edgeId: "e1", state: "you", reason: "awaiting-answer" }, { edgeId: "e4", state: "you", reason: "awaiting-answer" }],
    }} />);
    const approves = screen.getAllByRole("button", { name: "Approve" });
    expect(approves).toHaveLength(2);
    const names = approves.map((btn) => {
      const descId = btn.getAttribute("aria-describedby");
      return descId ? document.getElementById(descId)?.textContent : undefined;
    });
    // Both point at a real description, and the two are the two DIFFERENT rule
    // sentences (e1's, e4's) rather than the same node twice.
    expect(names[0]).toBeTruthy();
    expect(names[1]).toBeTruthy();
    expect(names[0]).not.toBe(names[1]);
  });
});
