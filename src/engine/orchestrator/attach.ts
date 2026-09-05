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
import type { RunStatus } from "../../types";
import { BranchCiStatus } from "./branchCi";
import type { BlockedNote } from "./evaluate";
import { RulePreview, previewFlow } from "./preview";
import { Flow, isPlace, isPlanned, isSettled, retryPending } from "./model";

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
  /** `expired` is the third settled state, beside `done` and `fail`: the rule's
   * deadline passed with its condition unmet (`expiredAt`, model.ts). Not a
   * failure — nothing ran and nothing broke, and a sibling `deadline-passed`
   * rule may be the one that acts on it — so it neither stops the workflow nor
   * takes the failure hue. */
  state: "done" | "now" | "waiting" | "you" | "fail" | "expired";
  /** Text the engine actually RECORDED — the edge's own `firedNote` or `error`, or
   * `previewFlow`'s `blank`. Never a sentence this module composes: wording is the
   * webview's job, and an engine module has no business holding English the UI
   * then has to match. */
  receipt?: string;
  /** Why this step cannot advance, as `previewFlow`'s own code rather than prose —
   * `"gone"`, `"agent-state-unknown"`, `"awaiting-answer"`. The block turns it into
   * a sentence. */
  reason?: BlockedNote["reason"];
  /** When this step's deadline runs out — `RulePreview.deadlineAt`, carried
   * through for a pending step whose clock is running. The block turns it into
   * "expires in 12m"; the engine only knows the moment. */
  deadlineAt?: number;
  /** When a failed step may be tried again — the edge's own `retryAt`, carried
   * on a pending step whose `receipt` is then the error it is recovering from.
   * The block turns it into "retry 1 of 3 in 40s". */
  retryAt?: number;
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
  /** `command-printed` verdicts for EVERY flow, keyed flow id → rule edge id —
   * the shape `deck:flows` carries — so a caller with many flows passes the one
   * map and this picks its own flow's slice. */
  printed?: Record<string, Record<string, boolean>>,
): WorkflowState {
  const previews = new Map<string, RulePreview>();
  // `previewFlow` evaluates as if armed, which is what makes it answer for a
  // disarmed workflow too: the steps still say what WOULD happen, greyed.
  for (const p of previewFlow(flow, runs, nowMs, branchCi, printed?.[flow.id])) previews.set(p.edgeId, p);

  let firstPending = true;
  const steps: StepState[] = flow.edges.map((e) => {
    // A failure pending retry is NOT a `fail`: it is still in play (`isSettled`
    // says so) and the workflow has not stopped. It takes the ordinary pending
    // path below, carrying its error as the receipt and its schedule as
    // `retryAt`, so the stepper can say "retry 1 of 3 in 40s" under the words.
    if (e.error !== undefined && !retryPending(e)) return { edgeId: e.id, state: "fail" as const, receipt: e.error };
    if (e.firedAt !== undefined) return { edgeId: e.id, state: "done" as const, receipt: e.firedNote };
    // No receipt: an expiry records nothing but the moment, and the sentence
    // for it is the webview's to write (see `receipt`'s own doc comment).
    if (e.expiredAt !== undefined) return { edgeId: e.id, state: "expired" as const };

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
    return {
      edgeId: e.id, state, reason: p?.reason,
      // The engine's own words first: a pending retry's error outranks a blank
      // (a rule that failed did fire, so its parameter was not blank).
      receipt: retryPending(e) ? e.error : p?.blank ?? undefined,
      ...(p?.deadlineAt !== undefined ? { deadlineAt: p.deadlineAt } : {}),
      ...(retryPending(e) ? { retryAt: e.retryAt } : {}),
    };
  });

  const done = flow.edges.filter(isSettled).length;
  const base = { done, total: flow.edges.length, steps };

  // Order matters and is the precedence rule: a failure the user can act on
  // outranks a question, because the failure is what actually halted the
  // workflow. Both outrank "advancing".
  if (steps.some((s) => s.state === "fail")) return { ...base, status: "stopped" };
  if (steps.some((s) => s.state === "you")) return { ...base, status: "waiting-on-you" };
  if (!flow.armed) return { ...base, status: "disarmed" };
  // `done` is the absence of a pending rule, and an expired rule is not pending:
  // it settled without arriving, and whatever was meant to act on that has by
  // now either fired (done) or is itself still pending (not done).
  if (steps.every((s) => s.state === "done" || s.state === "expired")) return { ...base, status: "done" };
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
  printed?: Record<string, Record<string, boolean>>,
): Flow[] {
  return [...flows].sort((a, b) => {
    const ra = RANK[workflowState(a, runs, nowMs, branchCi, printed).status];
    const rb = RANK[workflowState(b, runs, nowMs, branchCi, printed).status];
    return ra !== rb ? ra - rb : a.createdAt - b.createdAt;
  });
}

/** Which ticket key a PLANNED node binds this run by, and the webview's HALF of
 * a two-sided derivation: this must equal `ticketKeyFor(run, connector)`
 * (types.ts) — the value `deckView.ts`'s `flow:attach` writes into the planned
 * node it creates — for every run shape, or the host binds a workflow by one key
 * while the card looks for it under another and the attachment is invisible on
 * the very card that asked for it.
 *
 * The webview has no connector, so it cannot parse a ticket out of a url. It
 * does not have to: `inferredTicketKey` is `ticketKeyFor`'s answer, computed
 * host-side and put on the wire for exactly this reason, and present precisely
 * when that answer differs from the record's own key (see `RunStatus`'s own doc
 * comment, and `deckView.ts`'s `ticketKeyPatch`). So `inferredTicketKey ??
 * run.key` IS `ticketKeyFor`, reconstructed — for a launched task run (whose key
 * IS its ticket), a local card with a ticket-named branch, a local card with no
 * ticket at all, a Track-it card still keyed by its place hash, and a review run
 * whose url is a PR's. `test/unit/engine/orchestrator/attach.test.ts` pins that
 * equality against `ticketKeyFor` itself, on all five.
 *
 * NOT `isTicketRun(run) ? run.key : …`, which is what this used to be: that
 * excludes only review runs, so a LOCAL card — which has a real url and a
 * `local-<hash>` key — read as a ticket run and bound by its hash, while the
 * host bound by the ticket. Attaching a workflow to a local card then did
 * nothing visible, and pressing Attach again produced the host's refusal naming
 * the hash. The `inferredTicketKey` branch was unreachable besides: it is only
 * set when the url resolved, and `isTicketRun` was only false when there was no
 * url.
 *
 * A place binds by the run key every card has regardless — this only matters for
 * the planned half of `bindsRun`, which is the ONLY binding a freshly attached
 * workflow has, since a template carries no place nodes. */
export function boundTicketKeyOf(status: RunStatus): string {
  return status.inferredTicketKey ?? status.run.key;
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
  printed?: Record<string, Record<string, boolean>>,
): CardWorkflow | undefined {
  const attached = attachedWorkflows(flows, status.run.key, boundTicketKeyOf(status));
  const wf = rankByState(attached, runs, nowMs, branchCi, printed)[0];
  if (!wf) return undefined;
  return {
    flow: wf, state: workflowState(wf, runs, nowMs, branchCi, printed), extraCount: Math.max(attached.length - 1, 0),
  };
}
