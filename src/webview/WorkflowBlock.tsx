// The card drawer's live stepper: which of a workflow's rules is done, which one
// it is on right now, why that one is not moving, and what the reader can do
// about it — without opening the Workflows drawer.
//
// This is a THIRD presentation of the rule model `orchestratorRule.ts` already
// gives two others (`flowList.tsx`'s keyboard list, `OrchestratorDrawer.tsx`'s
// canvas inspector). Every reading of what a rule MEANS — its condition, its
// action, its target's name — comes from `ruleOneLine`, imported below, not a
// second copy written here. A faithful copy today is exactly the drift "one
// model, two presentations" warns about; this file adds a third reader of the
// same one, nothing more.
//
// `StepState.reason` — a CODE (`"gone" | "agent-state-unknown" |
// "awaiting-answer"`) — is turned into a sentence by `reasonWhy`, imported
// below from `orchestratorRule.ts`: it already had to say the same three
// things for the dry-run panel's `verdictWhy`, and an EARLIER version of this
// file wrote its own second copy, which drifted from that one in the meaning
// of `"gone"`, not just its phrasing — this file's own review caught it.
// `attach.ts` deliberately stops at the code; the wording is now the ONE
// place both readers call, not two that happen to agree today.
//
// Pure presentation: every effect a click has leaves through a prop. This
// component sends no host message itself — wiring it into `DeckDetail` (which
// message each callback posts) is the next task's job, not this one's.
import * as React from "react";
import { Flow, FlowEdge, edgeAction, gateAskEdge } from "../engine/orchestrator/model";
import { StepState, WorkflowState, WorkflowStatus } from "../engine/orchestrator/attach";
import { reasonWhy, ruleOneLine } from "./orchestratorRule";

export interface WorkflowBlockProps {
  /** `undefined` — nothing binds this card — is a state in its own right, not an
   * absence to guard against: the design's "none" row. */
  flow: Flow | undefined;
  state: WorkflowState | undefined;
  /** How many OTHER workflows also bind this card. The board shows one at a
   * time (`rankByState`'s job); this is what tells the reader there is more
   * than the one on screen. */
  extraCount: number;
  onAttach: () => void;
  onArm: (armed: boolean) => void;
  onDetach: () => void;
  onAnswerGate: (edgeId: string, answer: "approved" | "rejected") => void;
  onResetEdge: (edgeId: string) => void;
  /** Open this edge's most recent captured command output in an editor tab.
   * Offered only on a `run` rule that has actually fired — see `WorkflowStep`'s
   * own gate on `edgeAction`. A missing or empty result is the host's refusal
   * to report, as a toast; this component sends the click and nothing else. */
  onOutput: (edgeId: string) => void;
  onOpenInWorkflows: () => void;
}

/** The block header's status chip. Prose, not a re-spelling of the status id —
 * `waiting-on-you` reads as a class name, not a sentence a reader should see.
 *
 * Exported so `WorkflowList.tsx` (the Active list's row) reads the same
 * mapping rather than writing a second English spelling of the same five
 * statuses — the wording drift this file's own header warns about applies to
 * a status label exactly as much as to a step's receipt. */
export const STATUS_LABEL: Record<WorkflowStatus, string> = {
  disarmed: "disarmed",
  advancing: "advancing",
  "waiting-on-you": "waiting on you",
  stopped: "stopped",
  done: "done",
};

/** One glyph per step state, echoing the card chip's own marks (design doc §6:
 * `⟳`/`!`/`✕`/`✓`) so the drawer and the board agree on what each state looks
 * like. `waiting` gets a plain dot on purpose — see the hue rule below, the
 * same restraint applies to shape, not just color. */
const MARK: Record<StepState["state"], string> = {
  done: "✓",
  now: "⟳",
  waiting: "·",
  you: "!",
  fail: "✕",
};

/** The receipt line under a step's rule sentence: the engine's own recorded
 * words if it has any, else `reasonWhy`'s sentence for why it is stuck, else
 * nothing — a `waiting` step with neither is simply next in line, and says so
 * by staying quiet rather than manufacturing a reason it doesn't have. */
function stepText(step: StepState): string | undefined {
  if (step.receipt !== undefined) return step.receipt;
  if (step.reason !== undefined) return reasonWhy(step.reason);
  return undefined;
}

function WorkflowStep({
  flow,
  edge,
  step,
  onAnswerGate,
  onResetEdge,
  onOutput,
}: {
  flow: Flow;
  edge: FlowEdge;
  step: StepState;
  onAnswerGate: (edgeId: string, answer: "approved" | "rejected") => void;
  onResetEdge: (edgeId: string) => void;
  onOutput: (edgeId: string) => void;
}): JSX.Element {
  const sentence = ruleOneLine(flow, edge);
  const text = stepText(step);
  // Referenced by this step's own buttons via `aria-describedby` below, NOT
  // folded into their accessible name. Several gates or failures can be on
  // screen at once, and a screen reader reading "Approve" four times with
  // nothing else is exactly the defect the brief calls out — but the
  // NAME still has to stay the plain verb: that is the string a caller
  // driving this component by role/name (as this file's own tests do) looks
  // for, and it is also the shorter, more familiar announcement. A
  // `aria-describedby` pointing at this rule's own sentence gives the
  // longer, per-step context as a DESCRIPTION, read right after the name,
  // without changing what the name is.
  const descId = `wf-rule-${step.edgeId}`;

  // The edge to answer, which is NOT this step's own edge. A "you" step carries
  // the edge pointing AWAY from the gate (`evaluate.ts` posts `awaiting-answer`
  // against an outgoing edge's `from`), while the answer is stamped on the edge
  // that ASKED — the only one `flow:answerGate` accepts. Sending `step.edgeId`
  // made both buttons here a silent no-op: the host refused the write and the
  // question stayed open, with nothing on screen to say so. `gateAskEdge` is the
  // engine's own definition of that edge, shared with the Orchestrator drawer,
  // which is why the drawer's identical buttons always worked.
  const askEdgeId = step.state === "you" ? gateAskEdge(flow, edge.from)?.id : undefined;

  // Whether this rule's TARGET can ever have captured output — only a `run`
  // rule does (a launch, a seed, a notify, or a gate's `ask` have no command
  // to capture), so gating on the target rather than on outcome keeps the
  // button from appearing where a click could only ever be met with a
  // refusal. Combined below with `step.state`, which is what actually decides
  // whether the button renders: `done` and `fail` are the only states with a
  // journal line to read at all, and a succeeded command is exactly as often
  // worth reading back as a failed one — the design doc's own "Output on a
  // failed step" was the smaller of the two asks, not the only one.
  const canShowOutput = edgeAction(flow, edge) === "run";

  return (
    <li className={`wf-step wf-${step.state}`}>
      <span className="wf-mark" aria-hidden="true">{MARK[step.state]}</span>
      <div className="wf-body">
        <span id={descId} className="wf-rule">{sentence}</span>
        {text !== undefined && <span className="wf-receipt">{text}</span>}
      </div>
      {step.state === "you" && askEdgeId !== undefined && (
        <div className="wf-step-acts">
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onAnswerGate(askEdgeId, "approved")}
          >
            Approve
          </button>
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onAnswerGate(askEdgeId, "rejected")}
          >
            Reject
          </button>
        </div>
      )}
      {step.state === "done" && canShowOutput && (
        <div className="wf-step-acts">
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onOutput(step.edgeId)}
          >
            Output
          </button>
        </div>
      )}
      {step.state === "fail" && (
        <div className="wf-step-acts">
          {canShowOutput && (
            <button
              type="button"
              className="dd-pact"
              aria-describedby={descId}
              onClick={() => onOutput(step.edgeId)}
            >
              Output
            </button>
          )}
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onResetEdge(step.edgeId)}
          >
            Reset
          </button>
        </div>
      )}
    </li>
  );
}

export function WorkflowBlock({
  flow,
  state,
  extraCount,
  onAttach,
  onArm,
  onDetach,
  onAnswerGate,
  onResetEdge,
  onOutput,
  onOpenInWorkflows,
}: WorkflowBlockProps): JSX.Element {
  if (flow === undefined || state === undefined) {
    return (
      <div className="wf-block wf-none">
        <span className="wf-dash">No workflow attached</span>
        <button type="button" className="dd-pact" onClick={onAttach}>Attach workflow…</button>
      </div>
    );
  }

  const stepsByEdge = new Map(state.steps.map((s) => [s.edgeId, s]));

  // Exactly one contextual toggle in the header, mirroring the design doc's own
  // language: "a SINGLE Arm button" while disarmed, "Detach OFFERED" once done.
  // `stopped` gets Detach too, not Disarm: `workflowState` (attach.ts) checks
  // `stopped` BEFORE `!armed`, so a failed edge reports "stopped" whatever its
  // armed flag says — a Disarm button here would flip `flow.armed` and change
  // nothing the reader can see, while Detach is the one drawer-level action
  // that actually gets a user who has given up on a failed workflow off this
  // card without opening the canvas, which is the design's own promise for
  // both stalls ("actionable from the card drawer"). A stopped-and-armed
  // workflow can still only be Detached or Reset from here — Reset (on the
  // failed step itself) is exactly what you press when you DO want it to
  // resume, so nothing about recovery is lost.
  const headerAction = state.status === "disarmed"
    ? <button type="button" className="dd-pact" onClick={() => onArm(true)}>Arm</button>
    : state.status === "done" || state.status === "stopped"
      ? <button type="button" className="dd-pact" onClick={onDetach}>Detach</button>
      : <button type="button" className="dd-pact" onClick={() => onArm(false)}>Disarm</button>;

  return (
    <div className="wf-block">
      <div className="wf-hd">
        <span className="wf-name">{flow.name}</span>
        <span className={`wf-chip wf-${state.status}`}>{STATUS_LABEL[state.status]}</span>
        <span className="wf-count">{state.done} of {state.total}</span>
        {extraCount > 0 && <span className="wf-extra">+{extraCount} more</span>}
        <div className="wf-hd-acts">
          {headerAction}
          <button type="button" className="dd-pact" onClick={onOpenInWorkflows}>Open in Workflows ↗</button>
        </div>
      </div>
      <ol className={`wf-steps${state.status === "disarmed" ? " wf-greyed" : ""}`}>
        {flow.edges.map((e) => {
          const step = stepsByEdge.get(e.id);
          if (!step) return null;
          return (
            <WorkflowStep
              key={e.id}
              flow={flow}
              edge={e}
              step={step}
              onAnswerGate={onAnswerGate}
              onResetEdge={onResetEdge}
              onOutput={onOutput}
            />
          );
        })}
      </ol>
    </div>
  );
}
