// What a rule (a `FlowEdge`) means, in words, and how editing it is written
// back to the model. Shared by BOTH presentations of a flow — the canvas's
// inspector in OrchestratorDrawer.tsx and the keyboard list in flowList.tsx —
// because "one model, two presentations" (the design doc's own words for why
// the list exists at all) only holds if the sentence and its mutations live
// in exactly one place that both import. A second copy of either, even a
// faithful one, is the drift the design doc is warning against: the day one
// side gains a wrinkle (a new condition, a new mismatch reason) the other
// silently stops agreeing with it.
//
// Pure and React-free on purpose, same as model.ts: every `with*` function
// here takes a `Flow` and returns the next `Flow`, never touching `onSave`
// or any component state itself, so both files' event handlers stay a thin
// `onSave(withX(flow, ...))` and nothing about EITHER presentation needs to
// know how the other renders a control.
import { describeCond } from "../engine/orchestrator/conditions";
import {
  Condition,
  Flow,
  FlowAction,
  FlowEdge,
  LaunchDest,
  PlannedNode,
} from "../engine/orchestrator/model";
import { hasNote } from "../engine/prompt";
import { FlowPromptMode, RunStatus } from "../types";

/** The drawer's own wording for a condition. `describeCond` says what a place
 * currently looks like; this says what the rule is. Both are needed and they
 * are not the same sentence. */
export const COND_LABEL: Record<Condition["kind"], string> = {
  "pr-merged": "PR is merged",
  "ci-passed": "CI passed",
  "ci-failed": "CI failed",
  "review-approved": "review approved",
  "changes-requested": "changes requested",
  "threads-resolved": "0 unresolved threads",
  "pr-conflicting": "branch conflicts",
  "agent-ended-turn": "agent ended its turn",
  "agent-idle-over": "agent idle over…",
  "no-agent-left": "no agent left",
  "tree-clean": "tree is clean",
  "has-uncommitted": "has uncommitted work",
  "nothing-to-push": "nothing to push",
  "ticket-done": "ticket reached done",
  "ticket-status-is": "ticket status is…",
  "command-succeeded": "the command succeeded",
};

/** What either presentation offers in a condition picker. `agent-idle-over`
 * and `ticket-status-is` each carry a parameter (a minute count, a status
 * name) and this phase has no input for either — offering them would create
 * a rule waiting on a fixed 10 minutes or on the empty string, which never
 * matches. They stay in `COND_LABEL` because a flow hand-edited on disk can
 * still hold one and its rule must still render, in both presentations.
 * `command-succeeded` carries no parameter, so unlike those two it is NOT
 * filtered out below — the drawer can offer it on any rule, though only one
 * pointing out of a command node ever does anything once armed (see
 * `evaluate.ts`'s `commandSucceeded`). */
export const OFFERED_CONDS: Condition["kind"][] = (
  Object.keys(COND_LABEL) as Condition["kind"][]
).filter((k) => k !== "agent-idle-over" && k !== "ticket-status-is");

/** The verb (and, for `notify`, the whole rest of the clause) a rule's action
 * reads as. Both the inspector's `<option>` text and the list's closed-row
 * text spend the exact same three strings — a second hand-typed "notify me"
 * is exactly the kind of copy that quietly stops matching its twin. */
export const ACTION_LABEL: Record<FlowAction, string> = {
  launch: "launch",
  seed: "seed",
  notify: "notify me",
  // Inert until Task 4 gives a command node somewhere to point at — nothing
  // offers this action yet, but `FlowAction` is a `Record` key here and must
  // stay exhaustive.
  run: "run",
};

/** How a launch destination reads as words — the closed row's own text and
 * every open Destination `<select>`'s `<option>` text spend this exact
 * `Record`, not three hand-typed copies of it. Before this lived here, it
 * was written out four times across two files (a closed row's own text,
 * two open Destination selects in flowList.tsx, and the inspector's in
 * OrchestratorDrawer.tsx) — exactly the drift this module exists to stop
 * (see this file's own header comment). */
export const DEST_LABEL: Record<LaunchDest, string> = {
  worktree: "worktree",
  "new-window": "new window",
  "current-window": "current window",
};

/** What every open Destination `<select>` offers, in order — paired with
 * `DEST_LABEL` so a caller renders `OFFERED_DESTS.map(d => <option value={d}>
 * {DEST_LABEL[d]}</option>)` instead of writing out the same three
 * `<option>`s by hand. */
export const OFFERED_DESTS: LaunchDest[] = ["worktree", "new-window", "current-window"];

/** The aria-label both presentations' note `<input>` shares — see `withNote`'s
 * own doc comment for why this field exists at all. Centralised for the same
 * reason `ACTION_LABEL` is: a second, hand-typed "Note" in the other file is
 * exactly the copy this module exists to keep from drifting. */
export const NOTE_ARIA_LABEL = "Note";

/** The note input's placeholder, in both presentations — the one place this
 * phase's whole burden of explaining "mode" vs. "note" gets paid. `mode`
 * sits right beside this field and means something a user can easily
 * mistake this for: a reusable, named instruction, configured once in
 * `agentFlow.promptModes` and shared by every rule that picks it. A note is
 * the opposite of that — typed here, once, for exactly this transition, and
 * never offered anywhere else. Saying only "note" or "optional note" leaves
 * that distinction to be guessed, and a user who guesses wrong either
 * retypes the same sentence into twenty rules' notes, or reaches for
 * settings to say something they needed only once.
 *
 * Measured, not guessed: a first draft here ("Specific to this rule, once —
 * the mode beside it is the reusable part", 69 chars) read fine in the
 * inspector's own dedicated row but truncated mid-word in the LIST's tighter
 * one — the note `<input>` there shares one flex row with WHEN/THEN/the mode
 * select/"in a"/the destination select, not a row of its own. It cut off as
 * "…the mode beside it is", losing exactly the half that names what "mode"
 * actually is — worse than a short placeholder, since it reads as having
 * finished explaining when it didn't. This 44-char version keeps the same
 * specific/reusable contrast and was screenshotted at the drawer's default
 * 560px width, in the LIST's own row (the binding constraint — the
 * inspector's row has room to spare), to confirm it renders in full. */
export const NOTE_PLACEHOLDER = "Specific to this rule — the mode is reusable";

/** How many characters of a note a CLOSED row shows before an ellipsis takes
 * over. A closed row is for scanning a flow's rules at a glance — see this
 * file's own header comment on why the sentence is spent on `THEN`/`USING`
 * words, not a form — and a note long enough to wrap a row onto three lines
 * would defeat that. The inspector's own input, and an OPEN list row's, are
 * where the whole note actually lives, uncut. */
const NOTE_TRUNCATE_AT = 40;

/** A rule's note, as a closed row shows it — empty when there is none, by
 * `hasNote`'s own rule (a whitespace-only note counts as none, the same test
 * `composeAgentPrompt` uses to decide whether to spend it on the prompt at
 * all; showing one here while the engine silently drops it there would be
 * its own small drift). */
export function truncatedNote(note: string | undefined): string {
  if (!hasNote(note)) return "";
  const trimmed = note.trim();
  return trimmed.length > NOTE_TRUNCATE_AT ? `${trimmed.slice(0, NOTE_TRUNCATE_AT)}…` : trimmed;
}

/** How a node's end reads in a rule's sentence. Named per kind rather than by
 * a fallthrough default: a command node used to fall into the same "notify"
 * string a genuine notify node gets, which — paired with `ACTION_LABEL.run`
 * — would have a rule that executes shell read as "THEN run notify". Its own
 * identifier is whichever of `commandId`/`run` the node actually carries;
 * Task 5 owns refusing a node with both or neither, so this only has to
 * degrade, not validate. */
export function endLabel(flow: Flow, id: string): string {
  const n = flow.nodes.find((x) => x.id === id);
  if (!n) return "?";
  if (n.kind === "place") return n.runKey;
  if (n.kind === "planned") return n.ticketKey;
  if (n.kind === "command") return n.commandId ?? n.run ?? "command";
  return "notify";
}

/** The message the rule's notify target carries, or empty when the target is
 * not a notify node. */
export function notifyMessageOf(flow: Flow, e: FlowEdge): string {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "notify" ? n.message : "";
}

/** The rule's target, narrowed to a planned node — or `undefined` when it
 * points at anything else. A launch's prompt mode and destination live on
 * exactly this node (see `PlannedNode`'s own doc comment: "an armed launch
 * cannot stop to ask"), never on the edge, so every read of them goes
 * through here rather than a cast at each call site. */
function plannedTargetOf(flow: Flow, e: FlowEdge): PlannedNode | undefined {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "planned" ? n : undefined;
}

/** Why `launch` or `seed` on this rule would never run, given the kind of
 * node it actually points at — or `null` when the pairing is fine. This is
 * exactly what `deckView.ts`'s `performEdge`/`performSeed` refuse at
 * evaluation time ("a launch rule must point at planned work" / "a seed rule
 * must point at a place"); saying it here means a mis-wired rule is visible
 * the moment it is made, in whichever presentation made it, not only once
 * armed and it comes back as a stalled edge. */
export function actionMismatch(flow: Flow, e: FlowEdge): string | null {
  if (e.action === "launch" && !plannedTargetOf(flow, e)) {
    return "a launch needs planned work — this points at something already there.";
  }
  if (e.action === "seed" && flow.nodes.find((x) => x.id === e.to)?.kind !== "place") {
    return "a seed needs a place that already exists — this points at planned work.";
  }
  return null;
}

/** The USING clause's value. A launch's mode lives on its target planned node
 * (never on the edge — see `withMode`'s own doc comment below); a seed's
 * lives on the edge, because a place has no mode field of its own. */
export function modeValueOf(flow: Flow, e: FlowEdge): string {
  return (e.action === "launch" ? plannedTargetOf(flow, e)?.mode : e.mode) ?? "";
}

/** The launch destination clause's value — `undefined` for anything that
 * isn't a launch, since only a launch opens a destination at all. */
export function launchDestOf(flow: Flow, e: FlowEdge): LaunchDest | undefined {
  return e.action === "launch" ? plannedTargetOf(flow, e)?.dest : undefined;
}

/** How `modeValueOf` reads as words, for a closed row or as the fallback
 * option in an open one. Mirrors the inspector's own reasoning: a `<select>`
 * whose `value` matches none of its `<option>`s falls back to showing its
 * FIRST option, selected — silently showing a mode that will run while the
 * store actually holds one `modeFor` will refuse. Saying so in words, rather
 * than only via that extra `<option>`, is what lets the CLOSED row (which
 * renders no `<select>` at all) tell the same truth. */
export function modeDisplayLabel(promptModes: FlowPromptMode[], modeValue: string): string {
  if (!modeValue) return "(no mode set)";
  const found = promptModes.find((m) => m.id === modeValue);
  return found ? found.label : `${modeValue} (not configured)`;
}

/** What the rule's source place looks like right now, in `describeCond`'s
 * words. `null` when the node's run is not on the board — a claim neither
 * presentation can make. */
export function observationOf(flow: Flow, e: FlowEdge, runs: RunStatus[]): string | null {
  const from = flow.nodes.find((n) => n.id === e.from);
  if (!from || from.kind !== "place") return null;
  const status = runs.find((r) => r.run.key === from.runKey);
  if (!status) return null;
  return describeCond(e.cond, { status, repo: from.repo, nowMs: Date.now() });
}

/** Set a rule's condition. Only bare kinds are ever reachable from either
 * presentation's picker (see `OFFERED_CONDS`), so the parameterised arms
 * cannot be constructed here without a value to put in them — this returns
 * `flow` UNCHANGED (the same reference, not an equal-looking copy) for that
 * case, which is what lets a caller skip `onSave` entirely by checking
 * `next !== flow` rather than re-deriving the same guard itself. */
export function withCond(flow: Flow, edgeId: string, kind: Condition["kind"]): Flow {
  if (kind === "agent-idle-over" || kind === "ticket-status-is") return flow;
  const cond: Condition = { kind };
  return { ...flow, edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, cond } : x)) };
}

/** Change what a rule does. `notify` and `launch` both clear `edge.mode` —
 * `FlowEdge.mode` belongs to `seed` alone (see its own doc comment in
 * model.ts): a launch's mode already lives on the target `PlannedNode`,
 * which is never created without one, so there is nothing to write there
 * just for switching the verb. Clearing it here matters for the same reason
 * `notify`'s clear does: a launch edge left carrying a `mode` would be a
 * second, unread source of truth for a fact the node alone owns.
 *
 * `note`, unlike `mode`, is cleared for `notify` ALONE — `launch` and `seed`
 * both spend a note (see `FlowEdge.note`'s own doc comment: "for `launch`
 * and `seed` only"), so switching between the two acting verbs must not
 * throw away text the user just typed for the other one. Only `notify` has
 * nowhere to spend it — its own words live on its notify node — which is
 * exactly the persisted-but-unread state this clears, the same reasoning
 * `mode`'s own clear already follows. */
export function withAction(
  flow: Flow,
  edgeId: string,
  action: FlowAction,
  promptModes: FlowPromptMode[],
): Flow {
  if (action === "seed") {
    const edge = flow.edges.find((x) => x.id === edgeId);
    const mode = edge?.mode ?? promptModes[0]?.id;
    return { ...flow, edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, action, mode } : x)) };
  }
  if (action === "notify") {
    return {
      ...flow,
      edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, action, mode: undefined, note: undefined } : x)),
    };
  }
  return {
    ...flow,
    edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, action, mode: undefined } : x)),
  };
}

/** Write a chosen prompt mode where the engine actually spends it — and ONLY
 * there, never in both places. `performSeed` in deckView.ts reads
 * `edge.mode`, because a place has no mode field of its own for a seed's
 * mode to live in instead. `performEdge` reads a launch's mode from
 * `node.mode` on the target PLANNED node, never from the edge — so a
 * launch's selection is written to the node alone. Mirroring it onto
 * `edge.mode` too was tried and reverted once already: two homes for one
 * fact is a bug class this codebase has already paid for. */
export function withMode(flow: Flow, edge: FlowEdge, mode: string): Flow {
  if (edge.action === "launch") {
    return {
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === edge.to && n.kind === "planned" ? { ...n, mode } : n)),
    };
  }
  return { ...flow, edges: flow.edges.map((x) => (x.id === edge.id ? { ...x, mode } : x)) };
}

/** A launch's destination lives on its target planned node — `LaunchDest` has
 * no edge-level counterpart in the model (`FlowEdge` carries no `dest` field
 * at all), because it is the node's own launch configuration, not a property
 * of any one rule that triggers it. */
export function withDest(flow: Flow, edge: FlowEdge, dest: LaunchDest): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === edge.to && n.kind === "planned" ? { ...n, dest } : n)),
  };
}

/** Write a rule's once-off note. Unlike `withMode`, there is exactly ONE home
 * for this fact regardless of `edge.action` — a launch's mode moves to its
 * target node because a place has no mode field to share, but nothing about
 * a note is ever read from a node: `composeAgentPrompt` (prompt.ts) takes it
 * only as its own second argument, wherever the caller reads it from. So
 * this always writes the edge, for both `launch` and `seed` alike — the one
 * thing `withAction` still has to do on its own is clear it for `notify`
 * (see that function's own doc comment), since this function has no action
 * to check and just writes whatever it is given. */
export function withNote(flow: Flow, edge: FlowEdge, note: string): Flow {
  return { ...flow, edges: flow.edges.map((x) => (x.id === edge.id ? { ...x, note } : x)) };
}

export function withNotifyMessage(flow: Flow, edge: FlowEdge, message: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === edge.to && n.kind === "notify" ? { ...n, message } : n)),
  };
}

/** Remove a rule. Callers own clearing whatever selection/open state pointed
 * at it — that state lives in each presentation's own component, not here. */
export function withoutEdge(flow: Flow, edgeId: string): Flow {
  return { ...flow, edges: flow.edges.filter((x) => x.id !== edgeId) };
}

/** The next unused `${prefix}N` id, scanning past whatever is already taken
 * rather than trusting the live count. A count alone drifts the moment
 * anything is deleted: three edges minus the middle one is a list of length
 * two, so `length + 1` mints the id the untouched third edge already has.
 * One minting strategy for both node and edge ids — see `nextNodeId` and
 * `nextEdgeId` below — shared by both presentations so a node or edge minted
 * from the canvas and one minted from the list can never collide. */
function nextId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** An id unique within this flow. Node ids are local to a flow. */
export function nextNodeId(flow: Flow): string {
  return nextId("n", new Set(flow.nodes.map((x) => x.id)));
}

/** An id unique within this flow. Edge ids are local to a flow, and must stay
 * unique even after a delete: `deleteEdge`, `setCond` and the inspector's own
 * `flow.edges.find` all key off this id, so two edges sharing one silently
 * merge into whichever the code touches first. */
export function nextEdgeId(flow: Flow): string {
  return nextId("e", new Set(flow.edges.map((x) => x.id)));
}
