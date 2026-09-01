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
import { RunStatus } from "../../types";
import { BranchCiStatus } from "./branchCi";
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
  receipt?: string;
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
      return { edgeId: e.id, state: "you" as const, receipt: "waiting for your answer" };
    }
    // The first rule still in play is the one the reader is waiting on; the rest
    // are simply "not yet", and marking them all as current would say the
    // workflow is doing five things at once.
    const state = firstPending ? ("now" as const) : ("waiting" as const);
    firstPending = false;
    return { edgeId: e.id, state, receipt: p?.blank ?? undefined };
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
