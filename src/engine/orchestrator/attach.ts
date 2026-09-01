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
// PURE LEAF: `model.ts` only, no other imports — no Node builtins, directly or
// transitively. The Deck's card drawer imports this file, and the webview
// bundles for a browser target where esbuild resolves imports statically.
import { Flow, isPlace, isPlanned } from "./model";

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
