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
// What IS this file's own job: turning `StepState.reason` — a CODE
// (`"gone" | "agent-state-unknown" | "awaiting-answer"`) — into a sentence.
// `attach.ts` deliberately stops at the code: an engine module holding English
// the UI then has to match is how two presentations drift, so the wording
// lives here, once, in `REASON_TEXT`.
//
// Pure presentation: every effect a click has leaves through a prop. This
// component sends no host message itself — wiring it into `DeckDetail` (which
// message each callback posts) is the next task's job, not this one's.
import * as React from "react";
import { Flow, FlowEdge } from "../engine/orchestrator/model";
import { StepState, WorkflowState, WorkflowStatus } from "../engine/orchestrator/attach";
import { ruleOneLine } from "./orchestratorRule";

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
  onOpenInWorkflows: () => void;
}

/** The block header's status chip. Prose, not a re-spelling of the status id —
 * `waiting-on-you` reads as a class name, not a sentence a reader should see. */
const STATUS_LABEL: Record<WorkflowStatus, string> = {
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

/** `StepState.reason` in words. `attach.ts`'s own doc comment names these three
 * codes and hands the sentence to "the block" — this is that sentence, written
 * once, here, rather than re-derived at each call site.
 *
 * `gone` is deliberately not softened into another flavor of "waiting": the
 * engine's own doc comment on `RulePreview.blocked` says the source "cannot be
 * observed at all, so it can never be met while that stays true" — that is a
 * dead end, not a queue, and reads honestly only if it says so.
 *
 * `awaiting-answer` here reads identically to a gate's own receiptless "you"
 * step, because `workflowState` only ever attaches this reason where the state
 * IS `you` — the two are the same fact, not two different ones needing two
 * sentences. */
const REASON_TEXT: Record<NonNullable<StepState["reason"]>, string> = {
  gone: "its card isn't on the board — this can never be met while that stays true",
  "agent-state-unknown": "can't tell what the session is doing right now",
  "awaiting-answer": "waiting for your answer",
};

/** The receipt line under a step's rule sentence: the engine's own recorded
 * words if it has any, else this file's sentence for why it is stuck, else
 * nothing — a `waiting` step with neither is simply next in line, and says so
 * by staying quiet rather than manufacturing a reason it doesn't have. */
function stepText(step: StepState): string | undefined {
  if (step.receipt !== undefined) return step.receipt;
  if (step.reason !== undefined) return REASON_TEXT[step.reason];
  return undefined;
}

function WorkflowStep({
  flow,
  edge,
  step,
  onAnswerGate,
  onResetEdge,
}: {
  flow: Flow;
  edge: FlowEdge;
  step: StepState;
  onAnswerGate: (edgeId: string, answer: "approved" | "rejected") => void;
  onResetEdge: (edgeId: string) => void;
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

  return (
    <li className={`wf-step wf-${step.state}`}>
      <span className="wf-mark" aria-hidden="true">{MARK[step.state]}</span>
      <div className="wf-body">
        <span id={descId} className="wf-rule">{sentence}</span>
        {text !== undefined && <span className="wf-receipt">{text}</span>}
      </div>
      {step.state === "you" && (
        <div className="wf-step-acts">
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onAnswerGate(step.edgeId, "approved")}
          >
            Approve
          </button>
          <button
            type="button"
            className="dd-pact"
            aria-describedby={descId}
            onClick={() => onAnswerGate(step.edgeId, "rejected")}
          >
            Reject
          </button>
        </div>
      )}
      {step.state === "fail" && (
        <div className="wf-step-acts">
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
  // Anything in between (advancing, waiting on you, stopped) is still an armed
  // workflow doing something, and the one action that applies to all three
  // alike is the ability to pause it.
  const headerAction = state.status === "disarmed"
    ? <button type="button" className="dd-pact" onClick={() => onArm(true)}>Arm</button>
    : state.status === "done"
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
            />
          );
        })}
      </ol>
    </div>
  );
}
