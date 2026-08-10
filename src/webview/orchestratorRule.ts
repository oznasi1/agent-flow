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
  ACTION_MISMATCH_PREFIX,
  CommandNode,
  CondKind,
  Condition,
  edgeAction,
  Flow,
  FlowAction,
  FlowEdge,
  LaunchDest,
  PlannedNode,
} from "../engine/orchestrator/model";
import { hasNote } from "../engine/prompt";
import { BranchCiStatus, FlowPromptMode, RunStatus } from "../types";

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
  // The trailing ellipsis is this list's own mark for "carries a parameter", the
  // same one `agent-idle-over` and `ticket-status-is` wear — and for the same
  // reason: neither presentation has an input for the repo and branch it names,
  // so it is filtered out of the picker below. `describeCond` is what says WHICH
  // branch a given rule is about; a `Record` keyed by kind cannot.
  "branch-ci-passed": "branch CI passed…",
  "command-succeeded": "the command succeeded",
};

/** Every condition kind that carries a parameter, and so cannot be built from a
 * picker that knows only a kind. One list, in one place, because FOUR things have
 * to agree about it and each used to say it for itself: `OFFERED_CONDS` and
 * `withCond` here, and both of flowList.tsx's pieces of picker state.
 *
 * A `Record` over `Exclude<Condition["kind"], CondKind>` rather than a hand-typed
 * `Set`, so the list cannot fall behind the model: `CondKind` (model.ts) is by its
 * own definition every kind that needs NO parameter, which makes that `Exclude`
 * exactly the parameterised ones, and a `Record` over it must be exhaustive to
 * typecheck. Add a fifth parameterised kind to `Condition` and this object stops
 * compiling until it is named here — instead of silently becoming an
 * unconstructible picker entry. */
const PARAMETERISED_CONDS: Record<Exclude<Condition["kind"], CondKind>, true> = {
  "agent-idle-over": true,
  "ticket-status-is": true,
  "branch-ci-passed": true,
};

/** Can `{ kind }` alone be a complete `Condition`? A type guard, not a bare
 * boolean, so `withCond` and the `OFFERED_CONDS` filter both get the narrowing
 * out of it rather than reaching for a cast. */
export function isBareCond(kind: Condition["kind"]): kind is CondKind {
  return !(kind in PARAMETERISED_CONDS);
}

/** What either presentation offers in a condition picker. `agent-idle-over`,
 * `ticket-status-is` and `branch-ci-passed` each carry a parameter (a minute
 * count, a status name, a repo AND a branch) and this phase has no input for
 * any of them — offering them would create a rule waiting on a fixed 10
 * minutes, on the empty string, or on `undefined#undefined`, none of which
 * ever matches. They stay in `COND_LABEL` because a flow hand-edited on disk
 * can still hold one and its rule must still render, in both presentations.
 * `branch-ci-passed` is the one filtered kind whose absence a user can FEEL —
 * it is the condition that makes "wait for the build to pass on master, then
 * deploy to staging" expressible, and until a picker can ask for a repo and a
 * branch, the only way to write one is by hand in the flow file. An unusable
 * picker entry would be worse than none: it would silently produce a rule
 * that can never fire, on the one condition built to gate a deploy. A rule
 * hand-authored with one still RENDERS in either presentation's open picker —
 * see `condOffered`/`condOptionLabel` below, which exist so a `<select>` whose
 * value is not in this list does not come up blank.
 *
 * Not offered per SOURCE — that is `offeredConds` below, which every picker
 * should call instead. This list stays exported because it is the whole set,
 * and one of the two filters needs it. */
export const OFFERED_CONDS: CondKind[] = (Object.keys(COND_LABEL) as Condition["kind"][]).filter(isBareCond);

/** What a condition picker offers for a rule leaving `fromId` — the same list
 * as `OFFERED_CONDS`, split by the one thing that makes a condition answerable
 * at all: what kind of node is watching.
 *
 * `evaluate.ts`'s `isMet` has exactly two answers. `command-succeeded` it reads
 * off the FLOW (the receipt on the command node's own incoming edge), and every
 * other kind it reads off the source's `RunStatus` — returning `undefined`
 * forever for a source that is not a place. So the two sets are disjoint, not
 * nested: on a rule out of a command node every place-shaped condition is inert,
 * and on a rule out of anything else `command-succeeded` is. Task 7 shipped
 * `command-succeeded` offered on every rule regardless of source, which the
 * engine's guard makes safe (never wrongly true) but which still put a choice
 * that provably cannot work in front of the user.
 *
 * A PLANNED source keeps the place-shaped list even though `isMet` cannot
 * answer for it either — that gap is older than this phase and narrowing the
 * picker for it would silently remove the only conditions such a rule has ever
 * offered. Named here so it is a known omission rather than an oversight. */
export function offeredConds(flow: Flow, fromId: string): CondKind[] {
  const fromCommand = flow.nodes.find((n) => n.id === fromId)?.kind === "command";
  // One predicate, both directions: keep `command-succeeded` exactly when the
  // source IS a command node, and every other kind exactly when it is not.
  return OFFERED_CONDS.filter((k) => (k === "command-succeeded") === fromCommand);
}

/** Is this rule's own condition one the picker for it offers? When it is not —
 * a parameterised kind, or `command-succeeded` on a rule out of a place — an
 * open `<select>` whose `value` matches none of its `<option>`s renders BLANK
 * (`selectedIndex` is -1), which is how a hand-authored `branch-ci-passed`
 * rule showed an empty Condition control in the inspector and the open row: the
 * one condition built to gate a deploy, displayed as nothing at all. Callers
 * pair this with `condOptionLabel` to add the missing option. */
export function condOffered(flow: Flow, e: FlowEdge): boolean {
  return isBareCond(e.cond.kind) && offeredConds(flow, e.from).includes(e.cond.kind);
}

/** A condition as one `<option>`'s text — including the parameters `COND_LABEL`
 * cannot show, because it is keyed by kind alone and a kind does not know which
 * branch or which status a given rule is about. Its trailing "…" is this
 * codebase's own mark for "carries a parameter"; this function is what fills
 * that ellipsis in for a rule that actually has one. */
export function condOptionLabel(cond: Condition): string {
  switch (cond.kind) {
    case "agent-idle-over": return `agent idle over ${cond.minutes}m`;
    case "ticket-status-is": return `ticket status is ${cond.status}`;
    case "branch-ci-passed": return `CI passed on ${cond.repo}#${cond.branch}`;
    default: return COND_LABEL[cond.kind];
  }
}

/** The condition a BRAND NEW rule out of `fromId` starts on. Keyed off the
 * source node's kind for the same reason `offeredConds` is: `evaluate.ts`'s
 * `isMet` answers `command-succeeded` from the flow itself and every other
 * kind from the source's `RunStatus`, so a place-shaped condition on a rule
 * out of a COMMAND node can never be met — a new wire out of a command node
 * seeded with `pr-merged` would be inert from the moment it was drawn. Every
 * other source keeps `pr-merged`, which is what the drawer has always seeded
 * and what `OFFERED_CONDS` lists first. */
export function defaultCondFor(flow: Flow, fromId: string): Condition {
  return flow.nodes.find((n) => n.id === fromId)?.kind === "command"
    ? { kind: "command-succeeded" }
    : { kind: "pr-merged" };
}

/** The verb (and, for `notify`, the whole rest of the clause) a rule's action
 * reads as. Both presentations' rule sentence spends the exact same four
 * strings — a second hand-typed "notify me" is exactly the kind of copy that
 * quietly stops matching its twin.
 *
 * `notify` says WHERE it notifies, per the spec's rename: "notify me" alone
 * reads as if it messages somebody, which is the exact confusion that started
 * this phase ("I don't understand the notify node"). Messaging somebody is a
 * command node against a webhook now, so the one that only raises a VS Code
 * toast has to say so. */
export const ACTION_LABEL: Record<FlowAction, string> = {
  launch: "launch",
  seed: "seed",
  notify: "Notify me in VS Code",
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

/** The note placeholder for a rule that runs a COMMAND. `NOTE_PLACEHOLDER`
 * above spends its whole width contrasting "note" with "mode", and a command
 * rule has no mode at all — the sentence would be explaining a control that
 * isn't on screen. What a user needs to know here instead is that the note is
 * not appended: `withNote` (command.ts) substitutes it at `{note}` and a
 * template without one drops it entirely, which is the opposite of how
 * `composeAgentPrompt` treats a launch's note. */
export const NOTE_COMMAND_PLACEHOLDER = "Substituted at {note} in the command";

/** Said where the note is TYPED, because this is the field that makes it true.
 * `command.ts`'s `withNote` splices a note into the command string unquoted and
 * untouched, so `deploy.sh --env={note}` with a note of `prod; rm -rf ~`
 * produces a shell line carrying both commands. That is inherent to letting a
 * user type a free-text command at all — the user chose that over a config-only
 * list, and neutralising it would mean rewriting or rejecting their own shell
 * syntax — but until now it was said only in `command.ts`'s source and in the
 * `agentFlow.commands` setting description, i.e. everywhere except the one
 * place a person actually types the thing. Deliberately not red and not a
 * warning icon: nothing has failed, and this is how the feature works. */
export const NOTE_COMMAND_HINT =
  "Spliced into the command unquoted, exactly as typed — a note can extend what runs.";

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

/** How long a free-text command may be before a rule's sentence elides it. A
 * `.orch-node` chip is 168px wide and a rule's sentence shares one flex row,
 * so a 200-character `gh workflow run …` pasted into a node would push either
 * out of shape — the same reason `truncatedNote` exists for a closed row's
 * note. The whole text is still readable where it is EDITED (the inspector's
 * own command field), which is the same division of labour a note already
 * follows. */
const COMMAND_LABEL_MAX = 24;

/** Present, a string, and not just whitespace. The runtime check `resolveCommand`
 * (command.ts) makes for the same fields, restated here because this module
 * renders a hand-edited flow file's nodes too: `"run": 42` and `"run": "  "`
 * both reach the drawer, and `commandId ?? run ?? "command"` rendered the
 * second as an EMPTY chip label — the shape a node created for a free-text
 * command starts in, before the user has typed anything. */
function usableText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** How a command node names itself: its configured id, else the free text it
 * carries (elided), else the bare word. Never blank, and never the other
 * field's value — a node carrying BOTH is `resolveCommand`'s refusal to make,
 * not this function's; it only has to name the node, not validate it. */
export function commandLabel(n: CommandNode): string {
  const id = usableText(n.commandId);
  if (id) return id;
  const run = usableText(n.run);
  if (!run) return "command";
  return run.length > COMMAND_LABEL_MAX ? `${run.slice(0, COMMAND_LABEL_MAX)}…` : run;
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
  if (n.kind === "command") return commandLabel(n);
  if (n.kind === "notify") return "notify";
  // A kind this build does not know — `store.ts`'s `validNode` admits one on
  // purpose so a flow written by a NEWER build still renders. It has no
  // identifier to show, and it is certainly not a notify terminal: naming
  // `notify` as the fallthrough here is exactly how a command node once read
  // as one, and the same trap is still open for whatever kind comes next.
  return "?";
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
 * lives on the edge, because a place has no mode field of its own.
 *
 * Which of the two it is comes from `edgeAction` — the action the TARGET
 * implies — not from `e.action`. Keying off the stored field made an edge with
 * no stored action (every edge this build creates: see `finishWire`) read as
 * neither a launch nor a seed, so a launch rule pointing at real planned work
 * showed "(no mode set)" while the node beside it carried the mode the engine
 * will actually spend. */
export function modeValueOf(flow: Flow, e: FlowEdge): string {
  return (edgeAction(flow, e) === "launch" ? plannedTargetOf(flow, e)?.mode : e.mode) ?? "";
}

/** The launch destination clause's value — `undefined` for anything that
 * isn't a launch, since only a launch opens a destination at all. Derived from
 * the target, for the same reason `modeValueOf` above is: read off `e.action`,
 * an actionless launch edge answered `undefined` and every caller then fell
 * back to `"worktree"`, silently contradicting a target node whose `dest` says
 * `new-window` — and that node is what `performEdge` actually reads. */
export function launchDestOf(flow: Flow, e: FlowEdge): LaunchDest | undefined {
  return edgeAction(flow, e) === "launch" ? plannedTargetOf(flow, e)?.dest : undefined;
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
export function observationOf(
  flow: Flow,
  e: FlowEdge,
  runs: RunStatus[],
  /** The host's branch-CI verdicts, keyed `repo#branch`. Optional so a caller
   * with no access to them (a presentation that shows no observation line)
   * needs no second prop — but an absent map is exactly what made every
   * `branch-ci-passed` rule read "not checked yet" forever, so the drawer
   * passes the real one. `describeCond` tells the two apart deliberately: an
   * ABSENT key means nothing fetched it, an explicit `"unknown"` means a call
   * was made and could not be read. */
  branchCi?: Record<string, BranchCiStatus>,
): string | null {
  // Refused before the source-kind check below, not caught by it: this kind
  // has no place-shaped observation to make regardless of what `e.from`
  // turns out to be, and nothing today stops a `command-succeeded` rule from
  // being wired off a PLACE (the picker does not filter by source kind yet —
  // see `evaluate.ts`'s own `commandSucceeded`, which guards the read side
  // instead). A place source would otherwise pass the check below and reach
  // `describeCond`'s matching arm, which throws — see that arm's own doc
  // comment for why throwing there is the right failure mode as long as this
  // guard keeps it unreachable.
  if (e.cond.kind === "command-succeeded") return null;
  const from = flow.nodes.find((n) => n.id === e.from);
  if (!from || from.kind !== "place") return null;
  const status = runs.find((r) => r.run.key === from.runKey);
  if (!status) return null;
  return describeCond(e.cond, { status, repo: from.repo, nowMs: Date.now(), branchCi });
}

/** Set a rule's condition. Only bare kinds are ever reachable from either
 * presentation's picker (see `OFFERED_CONDS`), so the parameterised arms
 * cannot be constructed here without a value to put in them — this returns
 * `flow` UNCHANGED (the same reference, not an equal-looking copy) for that
 * case, which is what lets a caller skip `onSave` entirely by checking
 * `next !== flow` rather than re-deriving the same guard itself. */
export function withCond(flow: Flow, edgeId: string, kind: Condition["kind"]): Flow {
  // `isBareCond`, not a hand-listed pair of kinds: this guard and `OFFERED_CONDS`
  // must refuse exactly the same set, or a kind the picker somehow offers gets
  // silently dropped here instead (or, worse, one it refuses gets built).
  if (!isBareCond(kind)) return flow;
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
 * fact is a bug class this codebase has already paid for.
 *
 * WHICH home is decided by `edgeAction`, not by `edge.action` — the same
 * reasoning `modeValueOf` above spells out, and here it is worse than a
 * display bug: an edge with no stored action pointing at planned work wrote
 * the chosen mode onto the EDGE, where `performEdge` never looks, so the USING
 * select accepted a choice the launch would then silently ignore. */
export function withMode(flow: Flow, edge: FlowEdge, mode: string): Flow {
  if (edgeAction(flow, edge) === "launch") {
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

/** The picker value that means "I will type the command myself", as opposed to
 * naming one of `agentFlow.commands`. A NUL inside it is what makes it
 * unmistakable: a configured id comes from a settings file and cannot contain
 * one, so this sentinel can never collide with a real command's id — the same
 * trick `DRAG_SEP` uses for the Deck's drag payload. */
export const COMMAND_FREE_TEXT = "\u0000free-text";

/** Add a command node. `seed` is exactly what the picker chose: a configured
 * command's id, or the free-text shape — an EMPTY `run`, which is the node
 * saying "free text, not yet typed". Never both fields: `resolveCommand`
 * (command.ts) refuses a node carrying a usable `commandId` AND a usable `run`
 * rather than guess which one executes, so the two writers below each clear
 * the other's field and this builder only ever sets one.
 *
 * Placed in the right-hand column like a notify terminal — a command is
 * something a rule points AT, never a source of observations — and stepped
 * down by the node count so two added in a row don't land exactly on top of
 * each other. `tidy()` is still the thing that lays a graph out properly. */
export function addCommandNode(flow: Flow, seed: { commandId: string } | { run: string }): Flow {
  return {
    ...flow,
    nodes: [
      ...flow.nodes,
      { id: nextNodeId(flow), kind: "command", x: 320, y: 24 + flow.nodes.length * 88, join: "any", ...seed },
    ],
  };
}

/** Name a configured command on this rule's target node, clearing any free text
 * that was there — see `addCommandNode` on why both can never be set at once.
 * Written on the NODE, not the edge, for the same reason a launch's mode and
 * destination are: the command is the node's own configuration, and
 * `performEdge` resolves it from there. */
export function withCommandId(flow: Flow, edge: FlowEdge, commandId: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === edge.to && n.kind === "command" ? { ...n, commandId, run: undefined } : n,
    ),
  };
}

/** Put free text on this rule's target command node, clearing any configured id.
 * A BLANK string is a legitimate value here — it is what "free text, nothing
 * typed yet" looks like, and `resolveCommand` refuses to run it (see its
 * "run is blank" arm) rather than execute an empty shell line. */
export function withCommandRun(flow: Flow, edge: FlowEdge, run: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === edge.to && n.kind === "command" ? { ...n, run, commandId: undefined } : n,
    ),
  };
}

/** The target command node of this rule, or `undefined` when it points at
 * anything else — the `run` counterpart of `plannedTargetOf`. */
export function commandTargetOf(flow: Flow, e: FlowEdge): CommandNode | undefined {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "command" ? n : undefined;
}

export function withNotifyMessage(flow: Flow, edge: FlowEdge, message: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === edge.to && n.kind === "notify" ? { ...n, message } : n)),
  };
}

/** Is this edge's `error` the store's own MIGRATION notice, rather than a report
 * of something that tried and failed? `latchActionMismatches` (store.ts) stamps
 * an edge whose stored action disagrees with the action its target now implies,
 * to stop an armed flow silently reinterpreting a `notify` rule as a paid
 * `seed`. Nothing ran, nothing broke, and no money was spent — the rule is
 * waiting for the user to accept a new reading, which is what Reset does.
 *
 * It matters because of a house rule this codebase keeps deliberately narrow:
 * `--c-danger` is spent on a real failure and nothing else (see
 * `orchestratorStyles.ts`'s own comments on `.orch-obs .err` and
 * `.orch-edge.bad`). A migration notice painted red claims the flow broke, when
 * what happened is that this build reads an old file more carefully than the one
 * that wrote it. Both presentations still SETTLE such an edge and still offer
 * Reset — the only thing that changes is the colour of the sentence.
 *
 * Matched on `ACTION_MISMATCH_PREFIX` (model.ts), which exists so the migration,
 * the drawer's copy and the tests all name it once rather than three times. */
export function isMigrationNotice(error: string | undefined): boolean {
  return error !== undefined && error.startsWith(ACTION_MISMATCH_PREFIX);
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
