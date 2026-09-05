// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowBlock, WorkflowBlockProps } from "../../src/webview/WorkflowBlock";
import { DECK_CSS } from "../../src/webview/deckStyles";
import type { Flow, FlowEdge, FlowNode } from "../../src/engine/orchestrator/model";
import type { StepState, WorkflowStatus } from "../../src/engine/orchestrator/attach";

// Same minimal fixture shape test/unit/engine/orchestrator/attach.test.ts already
// uses: a place feeding a notify terminal is enough for `ruleOneLine` and
// `edgeAction` to read a real sentence off every edge, and nothing this block
// renders cares what the rule actually does.
const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "ingest-worker" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });

const edge = (id: string): FlowEdge => ({ id, from: "n1", to: "n2", cond: { kind: "pr-merged" } });

// A run-action fixture, for the Output button: it is offered only on a `run`
// rule (see `WorkflowBlock`'s own `canShowOutput`), so the shared `flow`
// above — every edge into a notify terminal — can never exercise it.
const command = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "command", run: "deploy.sh" });
const runFlow: Flow = {
  id: "f1",
  name: "Ship it",
  armed: true,
  createdAt: 0,
  nodes: [place("n1", "PROJ-142"), command("n2")],
  edges: [edge("e1"), edge("e2")],
};

// A GATE-shaped fixture, and the only honest one for the Approve/Reject rows.
//
// The shared `flow` below has no gate in it at all — every node is a place or a
// notify — so a "you" step against it was never a real waiting gate, and a test
// built on it could only ever assert that the step's own edge id was forwarded
// verbatim. That is exactly the defect that shipped: a "you" step carries the
// edge pointing AWAY from the gate, while the answer must go to the edge that
// ASKED, so forwarding verbatim made both buttons a silent no-op. These tests
// asserted the bug, and passed.
//
// Shape: place --ask--> gate --answered--> notify. `gAsk` carries `performed`
// and `firedAt` because that pair is what `gateAskEdge` looks for — the receipt
// of a question actually posed. `gYou` is the outgoing edge a "you" step names.
const gate = (id: string, question: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "gate", question });
const gAsk: FlowEdge = {
  id: "g-ask", from: "n1", to: "g1", cond: { kind: "pr-merged" },
  performed: true, firedAt: 1_000,
};
const gYou: FlowEdge = { id: "g-you", from: "g1", to: "n2", cond: { kind: "gate-approved" } };
const gateFlow: Flow = {
  id: "f1",
  name: "Ship it",
  armed: true,
  createdAt: 0,
  nodes: [place("n1", "PROJ-142"), gate("g1", "Deploy to prod?"), notify("n2")],
  edges: [gAsk, gYou],
};

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
    onOutput: vi.fn(),
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
    const { container } = render(
      <WorkflowBlock {...base} state={{ status: "disarmed", done: 0, total: 2, steps: twoWaiting }} />,
    );
    await waitFor(() => expect(screen.getByText("disarmed")).toBeTruthy());
    // The greying itself, which this test's own name had always promised and
    // never checked: `.wf-greyed` on the list is the whole mechanism (it drops
    // every step's opacity — see deckStyles.ts), so its absence would leave a
    // disarmed workflow looking exactly like a running one.
    expect(container.querySelector("ol.wf-steps")!.className).toBe("wf-steps wf-greyed");
    await userEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(base.onArm).toHaveBeenCalledWith(true);
  });

  it("greys nothing while the workflow is actually running", () => {
    // The pair to the assertion above: without this, a `wf-greyed` that had
    // become unconditional would still pass it.
    const { container } = render(<WorkflowBlock {...makeBase()} />);
    expect(container.querySelector("ol.wf-steps")!.className).toBe("wf-steps");
  });

  it("rings the current step and prints why it waits", async () => {
    const base = makeBase();
    const { container } = render(<WorkflowBlock {...base} state={{
      status: "advancing", done: 2, total: 5,
      steps: [...twoDone, { edgeId: "e3", state: "now", receipt: "1 of 2 approvals" }],
    }} />);
    await waitFor(() => {
      expect(screen.getByText("2 of 5")).toBeTruthy();
      expect(screen.getByText("1 of 2 approvals")).toBeTruthy();
    });
    // WHICH step is ringed, which this test's own name had always promised and
    // never checked: the third, the two before it settled. All five edges read
    // the same rule sentence (they share one condition), so position is the only
    // honest way to ask — and the ring is `.wf-now`, so ringing the wrong step,
    // or all three, changes this list.
    const marks = [...container.querySelectorAll("li.wf-step")].map((li) => li.className);
    expect(marks).toEqual(["wf-step wf-done", "wf-step wf-done", "wf-step wf-now"]);
  });

  it("offers Approve and Reject on a gate, and answers the edge that ASKED", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={gateFlow} state={{
      status: "waiting-on-you", done: 1, total: 3,
      steps: [{ edgeId: gYou.id, state: "you", receipt: "waiting for your answer" }],
    }} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    // `gAsk`, NOT the step's own `gYou`: `flow:answerGate` accepts only the
    // performer, so sending the step's edge writes to an edge nothing reads and
    // the click does nothing at all. Asserted by id, so a regression to
    // forwarding `step.edgeId` fails here rather than in a real editor.
    expect(base.onAnswerGate).toHaveBeenCalledWith(gAsk.id, "approved");
    expect(base.onAnswerGate).not.toHaveBeenCalledWith(gYou.id, "approved");
  });

  it("offers no gate buttons at all while the question is unasked", async () => {
    // Nothing to answer yet: no incoming edge carries `performed` + `firedAt`,
    // so `gateAskEdge` finds no performer. Buttons that rendered here could only
    // ever produce a refusal, which is the silent no-op this whole seam was.
    const base = makeBase();
    render(<WorkflowBlock {...base}
      flow={{ ...gateFlow, edges: [{ ...gAsk, performed: undefined, firedAt: undefined }, gYou] }}
      state={{
        status: "waiting-on-you", done: 0, total: 2,
        steps: [{ edgeId: gYou.id, state: "you", receipt: "waiting for your answer" }],
      }} />);
    await waitFor(() => expect(screen.getByText("waiting for your answer")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("offers Reject on a gate, and answers it", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={gateFlow} state={{
      status: "waiting-on-you", done: 1, total: 3,
      steps: [{ edgeId: gYou.id, state: "you", reason: "awaiting-answer" }],
    }} />);
    // No receipt on this fixture — `attach.ts` never sets one for `you`, only
    // `reason`. The block must turn that code into the same sentence on its own.
    await waitFor(() => expect(screen.getByText("waiting for your answer")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(base.onAnswerGate).toHaveBeenCalledWith(gAsk.id, "rejected");
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

  it("does not offer Output on a failed step whose target isn't a run rule", () => {
    // `flow`'s edges all point at a notify terminal — only a `run` rule ever
    // captures command output, so a click here could only ever be met with a
    // refusal. The Reset test above already covers this exact fixture; this
    // pins the absence the Output feature must not disturb.
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "stopped", done: 1, total: 2,
      steps: [{ edgeId: "e2", state: "fail", receipt: "exit 1 · 3 assertions failed" }],
    }} />);
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
  });

  it("offers Output alongside Reset on a failed run rule, and calls back with the edge id", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={runFlow} state={{
      status: "stopped", done: 0, total: 2,
      steps: [{ edgeId: "e1", state: "fail", receipt: "exit 1" }],
    }} />);
    await userEvent.click(screen.getByRole("button", { name: "Output" }));
    expect(base.onOutput).toHaveBeenCalledWith("e1");
    // Reset survives right beside it — Output is additive, not a replacement.
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });

  it("offers Output on a run rule that succeeded, not just one that failed", async () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={runFlow} state={{
      status: "done", done: 1, total: 1,
      steps: [{ edgeId: "e1", state: "done", receipt: "ran · exit 0 · 12s" }],
    }} />);
    await userEvent.click(screen.getByRole("button", { name: "Output" }));
    expect(base.onOutput).toHaveBeenCalledWith("e1");
  });

  it("does not offer Output on a run rule that hasn't fired yet", () => {
    // The JSX only renders Output inside its `step.state === "done"` and
    // `step.state === "fail"` branches — `canShowOutput` itself only checks
    // the TARGET (a `run` rule), not the state — so a step still `now`/
    // `waiting` has no journal line at all, and offering the button would
    // only ever earn the user a "hasn't run yet" refusal.
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={runFlow} state={{
      status: "advancing", done: 0, total: 2,
      steps: [{ edgeId: "e1", state: "now" }],
    }} />);
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
  });

  it("does not offer Output on a done step whose target isn't a run rule", () => {
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{ status: "done", done: 2, total: 2, steps: twoDone }} />);
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
  });

  it("keeps two Output buttons distinguishable when a done and a failed run step are both on screen", async () => {
    // Same reasoning `WorkflowStep`'s own `aria-describedby` comment gives for
    // Approve/Reject: several identically-named buttons on one screen need a
    // per-step DESCRIPTION, not a different accessible NAME, or a screen
    // reader announces "Output" twice with nothing to tell them apart.
    const twoRuns: Flow = {
      id: "f2", name: "Two runs", armed: true, createdAt: 0,
      nodes: [place("n1", "PROJ-1"), command("n2"), command("n3")],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } },
        { id: "e2", from: "n1", to: "n3", cond: { kind: "ci-passed" } },
      ],
    };
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={twoRuns} state={{
      status: "stopped", done: 1, total: 2,
      steps: [
        { edgeId: "e1", state: "done", receipt: "ran · exit 0 · 12s" },
        { edgeId: "e2", state: "fail", receipt: "exit 1" },
      ],
    }} />);
    const outputs = screen.getAllByRole("button", { name: "Output" });
    expect(outputs).toHaveLength(2);
    // Resolved through the DOM, not just compared as raw attribute strings —
    // the sibling Approve test above (`document.getElementById(descId)?.
    // textContent`) is what actually proves each `aria-describedby` points at
    // a REAL, DIFFERENT description; two different-looking ids that both
    // point at nothing (or at the same node) would pass a bare string
    // comparison and still leave a screen reader with nothing to tell the
    // two buttons apart.
    const descriptions = outputs.map((btn) => {
      const descId = btn.getAttribute("aria-describedby");
      return descId ? document.getElementById(descId)?.textContent : undefined;
    });
    expect(descriptions[0]).toBeTruthy();
    expect(descriptions[1]).toBeTruthy();
    expect(descriptions[0]).not.toBe(descriptions[1]);
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

  it("offers Detach, not Disarm, on a stopped workflow", async () => {
    // `workflowState` (attach.ts) checks `stopped` BEFORE `!armed`, so a failed
    // edge reports "stopped" no matter what `flow.armed` says — a Disarm button
    // here would flip a flag that changes nothing visible, and Detach was
    // previously reachable only once `done`, which a failed edge cannot reach
    // without a successful Reset first. That left a stopped workflow with no
    // drawer-level way off the card at all, contradicting the design's own
    // claim that both stalls are actionable from the drawer without opening
    // the canvas.
    const base = makeBase();
    render(<WorkflowBlock {...base} state={{
      status: "stopped", done: 1, total: 2,
      steps: [{ edgeId: "e2", state: "fail", receipt: "exit 1 · 3 assertions failed" }],
    }} />);
    expect(screen.queryByRole("button", { name: "Disarm" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(base.onDetach).toHaveBeenCalled();
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
    // TWO real gates, each with its own asked edge — a `you` step only renders
    // buttons when `gateAskEdge` finds a performer, so a gate-less flow (as this
    // test used to use) shows none at all.
    //
    // The two rules are differentiated by their CONDITION (one fires on your
    // approval, one on your rejection), not by the gates' questions: `endLabel`
    // returns the bare word "gate" for every gate node, so two gates asking
    // different things produce the same sentence. That is a real gap in the
    // promise this test exists to keep — but naming a gate would change every
    // rule sentence on four surfaces, so it is reported rather than widened into
    // this fix. Approve-vs-reject is an ordinary flow shape and differentiates
    // honestly.
    const twoFlow: Flow = {
      ...flow,
      nodes: [place("n1", "PROJ-142"), gate("g1", "Deploy to prod?"), gate("g2", "Roll back?"),
        notify("n2"), place("n3", "PROJ-9")],
      edges: [
        gAsk,
        gYou,
        { id: "g2-ask", from: "n3", to: "g2", cond: { kind: "ci-passed" }, performed: true, firedAt: 2_000 },
        { id: "g2-you", from: "g2", to: "n2", cond: { kind: "gate-rejected" } },
      ],
    };
    const base = makeBase();
    render(<WorkflowBlock {...base} flow={twoFlow} state={{
      status: "waiting-on-you", done: 0, total: 2,
      steps: [{ edgeId: gYou.id, state: "you", reason: "awaiting-answer" },
        { edgeId: "g2-you", state: "you", reason: "awaiting-answer" }],
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

// The state → appearance mapping, which nothing asserted: every hue in this block
// is applied by a class name (`deckStyles.ts` holds the colours), so a swap
// between two of them — advancing painted with the failure's red, a stopped
// workflow painted with the quiet blue — is invisible to every other test in this
// suite and to the whole 6,000-test run. The design doc's §6 rule is what is at
// stake: AMBER MEANS EXACTLY ONE THING AND RED MEANS A REAL FAILURE, so a
// workflow that is merely attached and fine must be neither.
//
// These are class assertions, not visual ones — jsdom can hold the whole claim,
// because the class IS the mapping. Each is asserted as the COMPLETE className
// rather than with `toContain`, so a step carrying two state classes at once
// fails too.
describe("WorkflowBlock — state to appearance", () => {
  const oneStep = (state: StepState["state"], status: WorkflowStatus = "advancing") =>
    render(<WorkflowBlock {...makeBase()} state={{ status, done: 0, total: 1, steps: [{ edgeId: "e1", state }] }} />);

  it.each([
    ["done", "wf-done"],
    ["now", "wf-now"],
    ["waiting", "wf-waiting"],
    ["you", "wf-you"],
    ["fail", "wf-fail"],
  ] as [StepState["state"], string][])("marks a %s step with .%s and nothing else", (state, cls) => {
    const { container } = oneStep(state);
    expect(container.querySelector("li.wf-step")!.className).toBe(`wf-step ${cls}`);
  });

  it.each([
    ["disarmed", "wf-disarmed"],
    ["advancing", "wf-advancing"],
    ["waiting-on-you", "wf-waiting-on-you"],
    ["stopped", "wf-stopped"],
    ["done", "wf-done"],
  ] as [WorkflowStatus, string][])("hues the header chip of a %s workflow with .%s", (status, cls) => {
    const { container } = oneStep("waiting", status);
    expect(container.querySelector(".wf-chip")!.className).toBe(`wf-chip ${cls}`);
  });

  // The hue rule itself, read off the stylesheet rather than trusted: the two
  // attention colours must be spent on the two states that genuinely want a
  // human, and nowhere else in this block. A class swap in the TSX is caught
  // above; this catches the same swap made in the CSS.
  it("spends --c-attn and --c-danger only on the states that need a human", () => {
    const rules = [...DECK_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(\.(?:wf-chip|wf-step)\.wf-[\w-]+[^{]*)\{([^}]*)\}/g)]
      .map(([, sel, body]) => [sel.trim(), body] as const);
    const usersOf = (token: string) => rules.filter(([, body]) => body.includes(token)).map(([sel]) => sel);
    expect(usersOf("--c-attn")).toEqual([".wf-chip.wf-waiting-on-you", ".wf-step.wf-you .wf-mark"]);
    expect(usersOf("--c-danger"))
      .toEqual([".wf-chip.wf-stopped", ".wf-step.wf-fail .wf-mark", ".wf-step.wf-fail .wf-receipt"]);
    // And the rules really were found — an expression that matched nothing would
    // satisfy every `toEqual([])` above if the selectors were ever renamed.
    expect(rules.length).toBeGreaterThan(6);
  });
});

describe("WorkflowBlock — a step with a deadline", () => {
  it("marks an expired step .wf-expired, words it as expired, and offers Reset but never Output", async () => {
    const base = makeBase();
    const expiredFlow: Flow = {
      ...runFlow,
      edges: [{ ...edge("e1"), timeoutMinutes: 30, liveSince: 1_000, expiredAt: 1_000 + 30 * 60_000 }],
    };
    render(<WorkflowBlock {...base} flow={expiredFlow} state={{
      status: "advancing", done: 1, total: 1,
      steps: [{ edgeId: "e1", state: "expired" }],
    }} />);
    const li = document.querySelector("li.wf-step")!;
    expect(li.className).toBe("wf-step wf-expired");
    expect(screen.getByText("expired — waited 30m")).toBeTruthy();
    // A `run` rule's target — and still no Output: an expiry ran nothing.
    expect(screen.queryByRole("button", { name: "Output" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(base.onResetEdge).toHaveBeenCalledWith("e1");
  });

  it("counts down on the current step while its clock is running", () => {
    render(<WorkflowBlock {...makeBase()} state={{
      status: "advancing", done: 0, total: 1,
      steps: [{ edgeId: "e1", state: "now", deadlineAt: Date.now() + 12 * 60_000 + 5_000 }],
    }} />);
    expect(screen.getByText("expires in 12m")).toBeTruthy();
  });

  it("lets a recorded receipt win over the countdown — the engine's words come first", () => {
    render(<WorkflowBlock {...makeBase()} state={{
      status: "advancing", done: 0, total: 1,
      steps: [{ edgeId: "e1", state: "now", receipt: "no branch set", deadlineAt: Date.now() + 12 * 60_000 }],
    }} />);
    expect(screen.getByText("no branch set")).toBeTruthy();
    expect(screen.queryByText(/expires in/)).toBeNull();
  });

  it("spends neither attention colour on an expired step", () => {
    // The hue rule again, for the new state: an expiry is not a failure and does
    // not want a human, so it gets the dim default and nothing more.
    const rules = [...DECK_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(\.wf-step\.wf-expired[^{]*)\{([^}]*)\}/g)];
    for (const [, , body] of rules) {
      expect(body).not.toContain("--c-danger");
      expect(body).not.toContain("--c-attn");
    }
  });
});

describe("WorkflowBlock — a failure pending retry", () => {
  it("reads as the current step with the error and the schedule, and offers Reset and Output", async () => {
    const base = makeBase();
    const retryingFlow: Flow = {
      ...runFlow,
      edges: [{ ...edge("e1"), retry: { max: 3, backoffMs: 60_000 }, retryOk: true, error: "exit 1", attempts: 1, retryAt: Date.now() + 30_000, performed: true }],
    };
    render(<WorkflowBlock {...base} flow={retryingFlow} state={{
      status: "advancing", done: 0, total: 1,
      steps: [{ edgeId: "e1", state: "now", receipt: "exit 1", retryAt: Date.now() + 30_000 }],
    }} />);
    expect(document.querySelector("li.wf-step")!.className).toBe("wf-step wf-now");
    expect(screen.getByText(/exit 1 · retry 1 of 3 in (29|30)s/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Output" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(base.onResetEdge).toHaveBeenCalledWith("e1");
  });

  it("a terminal failure after retries says what it cost", () => {
    const failedFlow: Flow = {
      ...runFlow,
      edges: [{ ...edge("e1"), retry: { max: 2, backoffMs: 1 }, retryOk: true, error: "exit 1", attempts: 3, performed: true }],
    };
    render(<WorkflowBlock {...makeBase()} flow={failedFlow} state={{
      status: "stopped", done: 1, total: 1, steps: [{ edgeId: "e1", state: "fail", receipt: "exit 1" }],
    }} />);
    expect(screen.getByText("exit 1 · gave up after 2 retries")).toBeTruthy();
  });
});
