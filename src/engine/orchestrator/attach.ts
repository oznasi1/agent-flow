// Which workflow belongs to a card.
//
// Attachment is DERIVED, never stored. A workflow is attached to a card when its
// flow contains a node bound to that run — a place with the card's run key, or a
// planned node with its ticket key. That binding already exists and is already how
// the engine finds the card.
//
// The alternative, an `attachedTo` field on `Flow`, can disagree with the graph:
// delete the place node and the field still claims attachment. It would also need
// a migration, and would leave every flow drawn before this shipped invisible to
// the card until re-saved. Deriving cannot lie, because it IS the graph.
//
// The cost is that "one workflow per card" is a display rule rather than an
// enforced invariant — hence `attachedWorkflows` returning a sorted list rather
// than a single flow. State-based precedence on top of that list arrives in a
// later task's `rankByState`.
//
// PURE LEAF: `model.ts`, `preview.ts`, `evaluate.ts`, `branchCi.ts` and
// `../../types` only — no Node builtins, directly or transitively. The Deck's
// card drawer imports this file, and the webview bundles for a browser target
// where esbuild resolves imports statically.
import { isTicketRun, RunStatus } from "../../types";
import { BranchCiStatus } from "./branchCi";
import type { BlockedNote } from "./evaluate";
import { RulePreview, previewFlow } from "./preview";
import { Flow, isPlace, isPlanned, isSettled } from "./model";

/** Does this flow name the given run?
 *
 * Both halves are exact string matches on purpose. A card's `runKey` is what a
 * place stores; its ticket key is what a planned node stores, and a planned node
 * whose ticket key is still blank (a shape mid-authoring) binds nothing. */
export function bindsRun(flow: Flow, runKey: string, ticketKey: string | undefined): boolean {
  return flow.nodes.some((n) => {
    if (isPlace(n)) return n.runKey === runKey;
    if (isPlanned(n)) return n.ticketKey !== "" && n.ticketKey === ticketKey;
    return false;
  });
}

/** Every workflow bound to this run, oldest first.
 *
 * Sorted by `createdAt` here; a later task re-ranks by state on top of this —
 * the two are kept separate so the ordering rule is testable without a board. */
export function attachedWorkflows(flows: Flow[], runKey: string, ticketKey: string | undefined): Flow[] {
  return flows.filter((f) => bindsRun(f, runKey, ticketKey)).sort((a, b) => a.createdAt - b.createdAt);
}

/** What the card chip and the block header say. Six states, and each is a
 * different sentence rather than a shade of the same one — see the design doc's
 * state table. `none` is the absence of a workflow and so has no value here. */
export type WorkflowStatus = "disarmed" | "advancing" | "waiting-on-you" | "stopped" | "done";

/** One rule, as the stepper draws it. `receipt` is the engine's own words — the
 * edge's `firedNote` or `error`, or the reason `previewFlow` gives for waiting —
 * never a sentence this module invents. */
export interface StepState {
  edgeId: string;
  state: "done" | "now" | "waiting" | "you" | "fail";
  /** Text the engine actually RECORDED — the edge's own `firedNote` or `error`, or
   * `previewFlow`'s `blank`. Never a sentence this module composes: wording is the
   * webview's job, and an engine module has no business holding English the UI
   * then has to match. */
  receipt?: string;
  /** Why this step cannot advance, as `previewFlow`'s own code rather than prose —
   * `"gone"`, `"agent-state-unknown"`, `"awaiting-answer"`. The block turns it into
   * a sentence. */
  reason?: BlockedNote["reason"];
}

export interface WorkflowState {
  status: WorkflowStatus;
  /** Settled rules, and how many there are in total — the block header's "2 of 5". */
  done: number;
  total: number;
  /** Every rule, in `flow.edges` order. */
  steps: StepState[];
}

/** Where this workflow is, right now.
 *
 * Pure and total, like `previewFlow` itself, and safe to call on every render:
 * the card drawer calls it for one workflow, the board calls it once per card
 * with a chip. Everything it reads is already on the wire — the edges' own stamps
 * come with `deck:flows`, and `previewFlow` needs only `runs` and `branchCi`,
 * which `DeckApp` holds. */
export function workflowState(
  flow: Flow,
  runs: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): WorkflowState {
  const previews = new Map<string, RulePreview>();
  // `previewFlow` evaluates as if armed, which is what makes it answer for a
  // disarmed workflow too: the steps still say what WOULD happen, greyed.
  for (const p of previewFlow(flow, runs, nowMs, branchCi)) previews.set(p.edgeId, p);

  let firstPending = true;
  const steps: StepState[] = flow.edges.map((e) => {
    if (e.error !== undefined) return { edgeId: e.id, state: "fail" as const, receipt: e.error };
    if (e.firedAt !== undefined) return { edgeId: e.id, state: "done" as const, receipt: e.firedNote };

    const p = previews.get(e.id);
    if (p?.reason === "awaiting-answer") {
      // A gate IS pending — it still latches `firstPending` off, or a later
      // pending edge would also read `now` and the workflow would look like it
      // is doing two things at once.
      firstPending = false;
      return { edgeId: e.id, state: "you" as const, reason: "awaiting-answer" };
    }
    // The first rule still in play is the one the reader is waiting on; the rest
    // are simply "not yet", and marking them all as current would say the
    // workflow is doing five things at once.
    const state = firstPending ? ("now" as const) : ("waiting" as const);
    firstPending = false;
    return { edgeId: e.id, state, receipt: p?.blank ?? undefined, reason: p?.reason };
  });

  const done = flow.edges.filter(isSettled).length;
  const base = { done, total: flow.edges.length, steps };

  // Order matters and is the precedence rule: a failure the user can act on
  // outranks a question, because the failure is what actually halted the
  // workflow. Both outrank "advancing".
  if (steps.some((s) => s.state === "fail")) return { ...base, status: "stopped" };
  if (steps.some((s) => s.state === "you")) return { ...base, status: "waiting-on-you" };
  if (!flow.armed) return { ...base, status: "disarmed" };
  if (steps.every((s) => s.state === "done")) return { ...base, status: "done" };
  return { ...base, status: "advancing" };
}

/** Rank order for the one-workflow-per-card display rule: the workflow that most
 * needs a human comes first, ties broken by `createdAt` so two hand-drawn
 * candidates always resolve the same way. */
const RANK: Record<WorkflowStatus, number> = {
  stopped: 0, "waiting-on-you": 1, advancing: 2, disarmed: 3, done: 4,
};

export function rankByState(
  flows: Flow[],
  runs: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): Flow[] {
  return [...flows].sort((a, b) => {
    const ra = RANK[workflowState(a, runs, nowMs, branchCi).status];
    const rb = RANK[workflowState(b, runs, nowMs, branchCi).status];
    return ra !== rb ? ra - rb : a.createdAt - b.createdAt;
  });
}

/** Which ticket key a PLANNED node would bind this run by: the run's own key
 * once it is a tracked ticket, else whatever the host could infer off a local
 * card's branch (absent when neither exists). A place binds by the run key
 * every card has regardless — this only matters for the planned half of
 * `bindsRun` — but it is real logic (not a passthrough), so it gets its own
 * name rather than being re-typed at each call site: `DeckDetail.tsx`'s card
 * drawer and `DeckApp.tsx`'s board both need this SAME answer for the SAME
 * card, and a second, differently-worded copy of it is exactly how the two
 * could quietly disagree about which workflow a card carries. */
export function boundTicketKeyOf(status: RunStatus): string | undefined {
  return isTicketRun(status.run) ? status.run.key : status.inferredTicketKey;
}

/** The one workflow a card's chip or drawer shows, and where it stands — the
 * exact `attachedWorkflows` → `rankByState` → `workflowState` chain, run
 * against the ticket key `boundTicketKeyOf` derives, with the top-ranked
 * flow's own state already attached. `undefined` when nothing binds this run.
 *
 * The single call both `DeckDetail.tsx` (one card, on open) and `DeckApp.tsx`
 * (every card, every board render) make, so neither can drift from the other
 * about which workflow — or which STATE — a card's own UI is showing. Callers
 * still own the `agentFlow.orchestrator` gate: this function does not know
 * about that setting, and returns a real answer even while it is off. */
export interface CardWorkflow {
  flow: Flow;
  state: WorkflowState;
  /** How many OTHER workflows also bind this card — `attachedWorkflows`'s own
   * list, minus the one shown. The board's chip has no use for it; the card
   * drawer's block header reads it to say there is more than the one on
   * screen. */
  extraCount: number;
}

export function cardWorkflow(
  flows: Flow[],
  status: RunStatus,
  runs: RunStatus[],
  nowMs: number,
  branchCi?: Record<string, BranchCiStatus>,
): CardWorkflow | undefined {
  const attached = attachedWorkflows(flows, status.run.key, boundTicketKeyOf(status));
  const wf = rankByState(attached, runs, nowMs, branchCi)[0];
  if (!wf) return undefined;
  return { flow: wf, state: workflowState(wf, runs, nowMs, branchCi), extraCount: Math.max(attached.length - 1, 0) };
}
