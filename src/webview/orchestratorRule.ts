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
import { MAX_LAUNCHES_PER_PASS } from "../engine/orchestrator/evaluate";
import { RulePreview } from "../engine/orchestrator/preview";
import {
  ACTION_MISMATCH_PREFIX,
  CommandNode,
  CondKind,
  Condition,
  edgeAction,
  Flow,
  FlowAction,
  FlowEdge,
  JoinMode,
  LaunchDest,
  PlannedNode,
} from "../engine/orchestrator/model";
import { hasNote } from "../engine/prompt";
import { BranchCiStatus, FlowCommand, FlowPromptMode, RunStatus } from "../types";

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
  "agent-ended-turn": "session ended its turn",
  "agent-idle-over": "session idle over…",
  "no-agent-left": "no sessions left",
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
  // No trailing ellipsis: both are bare, and the ellipsis in this list means
  // "carries a parameter". Second person on purpose — a gate is the one
  // condition about something YOU did rather than something the world did.
  "gate-approved": "you approved",
  "gate-rejected": "you rejected",
};

/** Every condition kind that carries a parameter, and so needs a seed value the
 * moment a picker names it. One list, in one place, because `withCond` and
 * `CondParams.tsx`'s own controls have to agree about exactly which kinds have a
 * parameter row at all.
 *
 * A `Record` over `Exclude<Condition["kind"], CondKind>` rather than a hand-typed
 * `Set`, so the list cannot fall behind the model: `CondKind` (model.ts) is by its
 * own definition every kind that needs NO parameter, which makes that `Exclude`
 * exactly the parameterised ones, and a `Record` over it must be exhaustive to
 * typecheck. Add a fifth parameterised kind to `Condition` and this object stops
 * compiling until it is named here — instead of silently becoming a picker entry
 * `withCond` cannot construct. */
const PARAMETERISED_CONDS: Record<Exclude<Condition["kind"], CondKind>, true> = {
  "agent-idle-over": true,
  "ticket-status-is": true,
  "branch-ci-passed": true,
};

/** Can `{ kind }` alone be a complete `Condition`? A type guard, not a bare
 * boolean, so `withCond`'s seeding switch gets the narrowing out of it rather
 * than reaching for a cast. It no longer filters `OFFERED_CONDS` — every kind is
 * offered now, and the parameters are asked for inline. */
export function isBareCond(kind: Condition["kind"]): kind is CondKind {
  return !(kind in PARAMETERISED_CONDS);
}

/** What either presentation offers in a condition picker: every kind the model
 * has. The parameterised three used to be filtered out of this list because
 * neither picker had anywhere to ask for a minute count, a status name or a repo
 * and a branch — offering them then would have created a rule waiting on a fixed
 * 10 minutes, on the empty string, or on `undefined#undefined`, none of which
 * ever matches. `CondParams.tsx` is the input that was missing, so the filter is
 * gone: `withCond` seeds each parameterised kind (see its own comment) and the
 * param row asks for the rest.
 *
 * A blank parameter is still a rule that can never fire, and is still said out
 * loud rather than left to be discovered: `condIncomplete` (model.ts) marks the
 * field in the panel AND names the rule in the arm warning, so the honesty the
 * old filter bought is kept without the capability it cost. `branch-ci-passed`
 * is the kind this mattered most for — it is what makes "wait for the build to
 * pass on master, then deploy to staging" expressible, and until now the only
 * way to write one was by hand in the flow file.
 *
 * Not offered per SOURCE — that is `offeredConds` below, which every picker
 * should call instead. This list stays exported because it is the whole set,
 * and that filter needs it. */
export const OFFERED_CONDS: Condition["kind"][] = Object.keys(COND_LABEL) as Condition["kind"][];

/** What a condition picker offers for a rule leaving `fromId` — the same list
 * as `OFFERED_CONDS`, split by the one thing that makes a condition answerable
 * at all: what kind of node is watching.
 *
 * `evaluate.ts`'s `isMet` has exactly three answers. `command-succeeded` it reads
 * off the FLOW (the receipt on the command node's own incoming edge),
 * `gate-approved`/`gate-rejected` it reads off the gate node's own incoming edge
 * the same way, and every other kind it reads off the source's `RunStatus` —
 * returning `undefined` forever for a source that is neither. So the THREE sets
 * are disjoint, not nested: on a rule out of a command node every place-shaped or
 * gate-shaped condition is inert, on a rule out of a gate node every place-shaped
 * or command-shaped condition is inert, and on a rule out of anything else both
 * `command-succeeded` and the two gate kinds are. Task 7 shipped
 * `command-succeeded` offered on every rule regardless of source, which the
 * engine's guard makes safe (never wrongly true) but which still put a choice
 * that provably cannot work in front of the user.
 *
 * A PLANNED source keeps the place-shaped list, and that is CORRECT rather than
 * a gap: `isMet` cannot answer for it *yet*, but `promoteToPlace` (promote.ts)
 * rewrites a launched planned node into a `place` WITH THE SAME ID, so every one
 * of those conditions becomes answerable the moment the launch succeeds. That is
 * the whole point of promotion — "PROJ-1 merged -> launch PROJ-12 -> PROJ-12's CI
 * passes -> launch PROJ-15" needs the second link to be expressible before the
 * first has run. An earlier version of this comment called it "a known omission",
 * which is worse than merely wrong on the one function that decides what both
 * pickers offer: a reader trusting it would strip every condition from rules out
 * of planned work and break the chain this phase exists to support. */
export function offeredConds(flow: Flow, fromId: string): Condition["kind"][] {
  const kind = flow.nodes.find((n) => n.id === fromId)?.kind;
  if (kind === "command") return ["command-succeeded"];
  if (kind === "gate") return ["gate-approved", "gate-rejected"];
  return OFFERED_CONDS.filter(
    (k) => k !== "command-succeeded" && k !== "gate-approved" && k !== "gate-rejected",
  );
}

/** Is this rule's own condition one the picker for it offers? When it is not —
 * `command-succeeded` on a rule out of a place, or a place-shaped kind on a rule
 * out of a command node — an open `<select>` whose `value` matches none of its
 * `<option>`s renders BLANK (`selectedIndex` is -1). Callers pair this with
 * `condOptionLabel` to add the missing option.
 *
 * No longer excludes parameterised kinds: they are offered now, and their
 * parameters are shown by the row below rather than crammed into the option
 * text. A rule whose kind IS offered therefore reads as its bare label here and
 * says the branch it is about in its own field, which is where that fact is
 * editable. */
export function condOffered(flow: Flow, e: FlowEdge): boolean {
  return offeredConds(flow, e.from).includes(e.cond.kind);
}

/** A condition as one `<option>`'s text — including the parameters `COND_LABEL`
 * cannot show, because it is keyed by kind alone and a kind does not know which
 * branch or which status a given rule is about. Its trailing "…" is this
 * codebase's own mark for "carries a parameter"; this function is what fills
 * that ellipsis in for a rule that actually has one. */
export function condOptionLabel(cond: Condition): string {
  switch (cond.kind) {
    case "agent-idle-over": return `session idle over ${cond.minutes}m`;
    case "ticket-status-is": return `ticket status is ${cond.status}`;
    case "branch-ci-passed": return `CI passed on ${cond.repo}#${cond.branch}`;
    default: return COND_LABEL[cond.kind];
  }
}

/** The condition a BRAND NEW rule out of `fromId` starts on. Keyed off the
 * source node's kind for the same reason `offeredConds` is: `evaluate.ts`'s
 * `isMet` answers `command-succeeded` and the two gate kinds from the flow
 * itself and every other kind from the source's `RunStatus`, so a place-shaped
 * condition on a rule out of a COMMAND or GATE node can never be met — a new
 * wire out of a gate seeded with `pr-merged` would be inert from the moment it
 * was drawn. Every other source keeps `pr-merged`, which is what the drawer has
 * always seeded and what `OFFERED_CONDS` lists first. */
export function defaultCondFor(flow: Flow, fromId: string): Condition {
  const kind = flow.nodes.find((n) => n.id === fromId)?.kind;
  if (kind === "command") return { kind: "command-succeeded" };
  if (kind === "gate") return { kind: "gate-approved" };
  return { kind: "pr-merged" };
}

/** What a join mode means, in the words the panel says it in. "any one rule"
 * rather than a bare "any", because the choice is between two readings of the
 * SAME picture — several arrows into one node — and a one-word option leaves the
 * user to supply the noun themselves. Keyed by `JoinMode` so the picker is built
 * from the model rather than from a hand-typed pair that could fall behind it. */
export const JOIN_LABEL: Record<JoinMode, string> = {
  any: "any one rule",
  all: "all rules",
};

/** How the node inspector names the kind it is about. A `Partial` over `string`
 * rather than a `Record<FlowNode["kind"], string>` on purpose: `store.ts`'s
 * `validNode` admits a kind this build does not know, so a flow written by a
 * NEWER build still renders — and such a node reaching this panel must fall back
 * to a neutral word rather than be typed away. That is the same trap `endLabel`
 * below documents, where naming `notify` as the fallthrough had a command node
 * read as one. */
export const NODE_KIND_LABEL: Partial<Record<string, string>> = {
  place: "Place",
  planned: "Planned",
  notify: "Notify",
  command: "Command",
  gate: "Gate",
};

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
  ask: "Ask me to approve",
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

/** A command node that names nothing runnable yet, in words — the not-set voice
 * every value beside it already has ("(no mode set)", "(not configured)"). ONE
 * string, because three surfaces say it: the Command select's own fallback option
 * in both presentations, and `commandLabel` below.
 *
 * It is the shape the picker actually CREATES — "Free-text command…" writes
 * `run: ""` for the inspector to fill in — and `resolveCommand` refuses to execute
 * it, so an armed flow latches such a rule errored. Until now it was the one shape
 * with no not-set voice at all: the node read "command" in every sentence and
 * "runs a command" on the canvas, i.e. as though it were configured. */
export const COMMAND_NOT_SET = "(no command set)";

/** A command node's `cwdRepo` picker's first option — the MODEL'S OWN DEFAULT,
 * spelled out. An absent `cwdRepo` means "the repo of the place the incoming
 * edge came from" (see `CommandNode`), which is the common case and the one that
 * needs no configuration; a picker that offered only repo names would make the
 * default reachable exactly once, before anything was chosen. Worded as what it
 * DOES rather than as "(default)", which says only that somebody else decided. */
export const CWD_REPO_DEFAULT = "the repo the rule came from";

/** How a command node names itself: its configured id, else the free text it
 * carries (elided), else `COMMAND_NOT_SET`. Never blank, and never the other
 * field's value — a node carrying BOTH is `resolveCommand`'s refusal to make,
 * not this function's; it only has to name the node, not validate it.
 *
 * The empty case says so out loud rather than answering the bare word "command":
 * this is the single place every surface reads a command node's name from (the
 * canvas chip, both rule sentences, the inspector's title, the Actions tray), so
 * one edit here is what stops a node with nothing typed from reading as
 * configured everywhere at once. */
export function commandLabel(n: CommandNode): string {
  const id = usableText(n.commandId);
  if (id) return id;
  const run = usableText(n.run);
  if (!run) return COMMAND_NOT_SET;
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
  if (n.kind === "gate") return "gate";
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

// `actionMismatch` lived here — "why `launch` or `seed` on this rule would
// never run, given the kind of node it points at". It answered a question that
// can no longer be ASKED: an action was chosen, separately from the target, and
// the two could disagree. The action is now derived from the target in every
// presentation (`edgeAction`), so the pairing it refused is unconstructible: the
// canvas's `finishWire`, the list's new-rule bar and both inspectors read the
// verb off the node. What remains of the same guarantee lives in two other
// places — `performEdge`/`performSeed` still refuse a wrong-kind target at
// evaluation time (a hand-edited flow file can still hold one), and
// `latchActionMismatches` (store.ts) reports a STORED action that disagrees, in
// the one direction still possible: a file written by an older build.

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
  // has no place-shaped observation to make regardless of what `e.from` turns
  // out to be. Still reachable with a place source even though `offeredConds`
  // now refuses to OFFER this kind on a rule out of anything but a command node
  // — a hand-edited flow file, or one written by another build, arrives here
  // having never been through a picker, which is the same tolerance
  // `store.ts`'s `validEdge` extends to an unrecognised `cond.kind`. (An
  // earlier version of this comment blamed an unfiltered picker; that stopped
  // being the reason in the same commit that added the filter, while the guard
  // itself stayed just as necessary.) A place source would otherwise reach
  // `describeCond`'s matching arm, which throws — see that arm's own doc
  // comment for why throwing there is the right failure mode as long as this
  // guard keeps it unreachable.
  //
  // `gate-approved`/`gate-rejected` join it here for the identical reason: a
  // gate's verdict lives on its own incoming edge (`gateAnswer`, model.ts), not
  // in a place-shaped `CondContext`, so `describeCond`'s matching arms throw too
  // — this guard is what keeps them unreachable, same as it always has for
  // `command-succeeded`.
  if (e.cond.kind === "command-succeeded" || e.cond.kind === "gate-approved" || e.cond.kind === "gate-rejected") {
    return null;
  }
  const from = flow.nodes.find((n) => n.id === e.from);
  if (!from || from.kind !== "place") return null;
  const status = runs.find((r) => r.run.key === from.runKey);
  if (!status) return null;
  return describeCond(e.cond, { status, repo: from.repo, nowMs: Date.now(), branchCi });
}

/** What a rule's observation line reads when `observationOf` has nothing to say.
 * It returns `null` for TWO different reasons and a caller that cannot tell them
 * apart says the wrong thing about one of them:
 *  - the source's run is not on this board (or the source is not a place at all),
 *    which is what "this card is not on the board right now" is about;
 *  - the condition is `command-succeeded`, which HAS no place-shaped observation
 *    to make — see `observationOf`'s own first guard. Nothing is missing here: the
 *    rule is waiting, exactly as intended.
 *
 * The second was deferred as an edge case while `command-succeeded` was one
 * condition among many. Tasks 9 and 10 made it the default AND only condition
 * offered off a command node, so "this card is not on the board right now" became
 * the guaranteed steady state of this phase's headline shape
 * (`place -> deploy.sh -> smoke.sh`) — a sentence claiming something is missing,
 * on the one rule where nothing is.
 *
 * A source that is not a command node cannot answer this condition at all
 * (`evaluate.ts`'s `commandSucceeded` checks the kind first, and answers `false`
 * forever otherwise), and only a hand-edited file or another build can produce
 * one — so it gets its own sentence rather than a wait that will never end. */
export function observationFallback(flow: Flow, e: FlowEdge): string {
  if (e.cond.kind !== "command-succeeded") return "this card is not on the board right now";
  const from = flow.nodes.find((n) => n.id === e.from);
  return from && from.kind === "command"
    ? `waiting for ${commandLabel(from)} to succeed`
    : "this rule waits on a command, but it does not come from one";
}

/** How long a freshly-picked `agent-idle-over` waits. A real number rather than
 * a blank, because unlike a status name or a branch there is no wrong default
 * here — every value is a working rule, and a picker that produced `0` would fire
 * the instant a session stopped typing. Thirty minutes is the span at which a
 * session that has gone quiet is worth acting on rather than waiting out; the
 * control beside it is what a user who disagrees changes. Exported so the test
 * and the control's own `min` do not each hand-type it. */
export const DEFAULT_IDLE_MINUTES = 30;

/** Set a rule's condition, seeding a parameterised kind with somewhere to start.
 *
 * Every kind is reachable from both pickers now (see `OFFERED_CONDS`), so this
 * can no longer refuse the parameterised three — but a `{ kind }` alone would not
 * even typecheck for them, and a value invented at random would be worse: a
 * condition is what the rule WAITS on, and a wrong branch waits just as patiently
 * as a blank one while looking configured. So the seeds split by whether a
 * default can be RIGHT:
 *
 * - `agent-idle-over` gets a real span. Complete on arrival — see
 *   `DEFAULT_IDLE_MINUTES`.
 * - `ticket-status-is` gets `""`. There is no status every project shares, and
 *   guessing "In Review" would produce a rule that silently watches for a status
 *   the board may not have.
 * - `branch-ci-passed` gets the SOURCE PLACE's own repo and a blank branch. The
 *   repo is the one half a guess can get right: the rule is being drawn out of a
 *   node that is already narrowed to a checkout, and that is nearly always the
 *   checkout whose branch the user means to watch. The branch is not guessable —
 *   "main" is a guess that reads as a configured answer — so it stays blank.
 *
 * A blank half is not left to be discovered. `condIncomplete` (model.ts) reports
 * it, which is what marks the field in the panel and names the rule in the arm
 * warning, so the seeding above never quietly ships a rule that cannot fire.
 *
 * Still returns `flow` UNCHANGED (the same reference) when nothing moved — an
 * edge that is not there, or a re-pick of the kind it already has. That second
 * case is new and it matters: without it, reselecting the open `<option>` would
 * wipe the branch the user just typed back to the seed. Callers keep their
 * `next !== flow` check and skip `onSave` on it, exactly as before. */
export function withCond(flow: Flow, edgeId: string, kind: Condition["kind"]): Flow {
  const edge = flow.edges.find((x) => x.id === edgeId);
  if (!edge || edge.cond.kind === kind) return flow;
  const cond = seedCond(kind, sourceRepoOf(flow, edge));
  return { ...flow, edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, cond } : x)) };
}

/** A complete `Condition` from a kind alone — the seeds `withCond`'s own comment
 * above describes, factored out because a SECOND picker builds a condition from
 * nothing: flowList.tsx's new-rule bar, which has no edge for `withCond` to
 * rewrite. Both must seed identically or the same choice would produce two
 * different rules depending on which surface it was made from.
 *
 * `repo` is the checkout to seed a `branch-ci-passed` rule with — the source
 * node's own, when it has one (`sourceRepoOf`) — and is ignored for every other
 * kind. Absent leaves the repo blank, which `condIncomplete` then reports. */
export function seedCond(kind: Condition["kind"], repo?: string): Condition {
  if (isBareCond(kind)) return { kind };
  if (kind === "agent-idle-over") return { kind, minutes: DEFAULT_IDLE_MINUTES };
  if (kind === "ticket-status-is") return { kind, status: "" };
  return { kind, repo: repo ?? "", branch: "" };
}

/** `sourceRepoOf`, addressed by node id rather than by edge — what flowList's
 * new-rule bar has in hand, since its draft names a `from` before any edge
 * exists. `withCond`'s path keeps the edge-shaped one above it. */
export function sourceRepoOfNode(flow: Flow, fromId: string): string | undefined {
  const from = flow.nodes.find((n) => n.id === fromId);
  if (from?.kind === "place") return from.repo;
  if (from?.kind === "planned" && from.repos.length === 1) return from.repos[0];
  return undefined;
}

/** The checkout a rule's SOURCE node is narrowed to, when it has one. A place
 * stores its `repo` outright; a planned node carries a whole list and only
 * answers when that list names exactly one, because picking the first of several
 * would be a guess dressed as a fact. Everything else — notify, command, a kind
 * this build does not know — answers `undefined`, and the caller falls back to a
 * blank the user fills in. */
function sourceRepoOf(flow: Flow, e: FlowEdge): string | undefined {
  return sourceRepoOfNode(flow, e.from);
}

/** Edit ONE parameter of a rule's condition, leaving its kind and its other
 * parameters alone. One writer for all four fields rather than four near-identical
 * ones, because every caller is the same shape — a control's `onChange` handing
 * back the one value it owns — and four copies of this spread is four places for a
 * `{ ...cond }` to be forgotten and a sibling parameter to be dropped.
 *
 * Refuses a patch whose keys do not belong to the condition it lands on, by
 * construction rather than by checking: `Partial<Extract<Condition, { kind: K }>>`
 * is resolved from the edge's OWN kind at the call site, so passing `{ branch }`
 * to an `agent-idle-over` rule does not compile. That is the guard that matters
 * here — a mismatched patch would not throw at runtime, it would quietly write a
 * field nothing reads onto a condition that then still looks fine.
 *
 * Returns `flow` unchanged for a missing edge, matching `withCond`. */
export function withCondParams<K extends Condition["kind"]>(
  flow: Flow,
  edgeId: string,
  patch: Partial<Extract<Condition, { kind: K }>>,
): Flow {
  const edge = flow.edges.find((x) => x.id === edgeId);
  if (!edge) return flow;
  const cond = { ...edge.cond, ...patch } as Condition;
  return { ...flow, edges: flow.edges.map((x) => (x.id === edgeId ? { ...x, cond } : x)) };
}

// `withAction` lived here — the writer behind both presentations' action
// `<select>`. Neither control exists any more (Task 9 removed the inspector's,
// this task the list's), and it is the ONE mutation in this module that must not
// come back: writing a stored action is precisely what
// `latchActionMismatches` (store.ts) stamps an edge dead for, since the value it
// wrote could disagree with the target on the very next read. Changing what a
// rule does means pointing it at a different node. Its housekeeping is not lost
// — `withMode` still keeps a launch's mode on the node and a seed's on the edge,
// which is the fact `withAction`'s clearing existed to protect.

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
 * for this fact regardless of what the rule DOES — a launch's mode moves to its
 * target node because a place has no mode field to share, but nothing about a
 * note is ever read from a node: `composeAgentPrompt` (prompt.ts) and
 * `command.ts`'s own `withNote` each take it as an argument, wherever the caller
 * read it from. So this always writes the edge, for `launch`, `seed` and `run`
 * alike, and it has no verb to check: it writes whatever it is given.
 *
 * Nothing clears it when a rule's meaning changes any more, and nothing needs
 * to. Clearing a note for `notify` was `withAction`'s job (deleted — see the
 * comment where it stood), and a note is only ever READ for a verb that spends
 * one, so a leftover note on a rule now pointing at a notify terminal is inert
 * rather than wrong. The one way to change what a rule does is to point it at a
 * different node, which no longer rewrites the edge at all. */
export function withNote(flow: Flow, edge: FlowEdge, note: string): Flow {
  return { ...flow, edges: flow.edges.map((x) => (x.id === edge.id ? { ...x, note } : x)) };
}

/** The picker value that means "I will type the command myself", as opposed to
 * naming one of `agentFlow.commands`. A NUL inside it is what makes it
 * unmistakable: a configured id comes from a settings file and cannot contain
 * one, so this sentinel can never collide with a real command's id — the same
 * trick `DRAG_SEP` uses for the Deck's drag payload. */
export const COMMAND_FREE_TEXT = "\u0000free-text";

/** The Add-command picker's value for the line it shows when `agentFlow.commands`
 * is EMPTY — no longer the default (one inert example ships), but still reachable
 * for a user who clears the list on purpose. Same NUL trick as `COMMAND_FREE_TEXT`
 * above, for the same reason, and
 * for one more: this value must never be mistaken for a command id by
 * `addCommand`, which guards it as well as rendering its option `disabled`. A
 * `<select>`'s `value` setter honours a disabled option (jsdom's does too), so
 * "not selectable" has to be true in the HANDLER, not only in the markup. */
export const COMMAND_NONE = "\u0000none";

/** What that line SAYS. Without it the picker's whole story, for a user who has
 * configured nothing, is "+ Add command…" and "Free-text command…" — two entries
 * that between them never mention that named, reusable commands exist at all, or
 * where they would come from. The setting's own id is the only actionable thing
 * to say, so it is what this says; the not-set voice ("(no command set)",
 * "(not configured)") is the register it says it in. */
export const COMMAND_NONE_LABEL = "(none configured — set agentFlow.commands)";

/** The inspector's empty state, when nothing is selected. Names BOTH selectable
 * things, because both now open a panel: a connection (its condition, and what
 * the rule does with it) and an action node (a command node's command, a notify
 * node's message — node data, see `withNodeCommandId` below). It used to name a
 * connection alone, which is what made a freshly added command node look like
 * something the inspector had nothing to say about: the panel actively told the
 * user their only move was to wire it up first. */
export const INSPECTOR_NONE =
  "Select a connection to set its condition, or a command or notify node to set what it does.";

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

/** Name a configured command on a command node, clearing any free text that was
 * there — see `addCommandNode` on why both can never be set at once.
 *
 * Keyed on the NODE's own id, because that is whose field this is. The edge-shaped
 * `withCommandId` below is a thin call through to this one, and that is the whole
 * guarantee the two surfaces that write a command need: the inspector reached from
 * a selected RULE and the inspector reached from a selected NODE cannot disagree
 * about what "set this command" means, because there is one implementation of it.
 * They used to be one function only because there was one caller — an edge — and
 * that accident is what made a command node unconfigurable until it was wired
 * into a rule (the picker creates `run: ""` for the user to fill in, and every
 * control that could fill it in was keyed on `edge.id`). */
export function withNodeCommandId(flow: Flow, nodeId: string, commandId: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === nodeId && n.kind === "command" ? { ...n, commandId, run: undefined } : n,
    ),
  };
}

/** Put free text on a command node, clearing any configured id. A BLANK string is
 * a legitimate value here — it is what "free text, nothing typed yet" looks like,
 * and `resolveCommand` refuses to run it (see its "run is blank" arm) rather than
 * execute an empty shell line. Node-keyed for the same reason as
 * `withNodeCommandId` above. */
export function withNodeCommandRun(flow: Flow, nodeId: string, run: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) =>
      n.id === nodeId && n.kind === "command" ? { ...n, run, commandId: undefined } : n,
    ),
  };
}

/** A notify node's own message, keyed on the node — `withNotifyMessage` below is
 * the edge-shaped call through to it, exactly as with the two command writers. */
export function withNodeNotifyMessage(flow: Flow, nodeId: string, message: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId && n.kind === "notify" ? { ...n, message } : n)),
  };
}

/** The question a gate asks. The same shape as `withNodeNotifyMessage` — a node
 * builder that rewrites one field and leaves the rest of the flow alone. */
export function withNodeGateQuestion(flow: Flow, id: string, question: string): Flow {
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === id && n.kind === "gate" ? { ...n, question } : n)) };
}

/** Which repo's checkout a command node runs in. `""` CLEARS the field rather
 * than storing an empty string, because absent is a meaning in the model — "the
 * repo of the place the incoming edge came from", the common case that needs no
 * configuration (see `CommandNode.cwdRepo`). Storing `""` instead would send
 * `resolveCommand` looking for a checkout named the empty string, which is the
 * one thing the default was written to avoid. The picker's own first option is
 * what a user selects to get back here.
 *
 * `delete` on a copy rather than `{ ...n, cwdRepo: undefined }`: `writeFlow`
 * serializes the node to JSON, where an explicit `undefined` and an absent key
 * round-trip the same — but `store.ts` reads the record back with `in` checks in
 * places, and a key that is present-but-undefined is a shape no other writer in
 * this file produces. Keeping the record to the two shapes the model documents
 * is cheaper than proving every reader tolerates a third. */
export function withNodeCwdRepo(flow: Flow, nodeId: string, cwdRepo: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if (n.id !== nodeId || n.kind !== "command") return n;
      if (cwdRepo === "") {
        const next = { ...n };
        delete next.cwdRepo;
        return next;
      }
      return { ...n, cwdRepo };
    }),
  };
}

/** What several incoming rules mean where they meet — "any one" fires on the
 * first met, "all" waits for every one. Written on the TARGET node, which is
 * where the model puts it and for the reason `JoinMode`'s own comment gives: it
 * is a property of the junction, not of any one arrow into it. Every node kind
 * carries the field, so this does not narrow by kind the way the writers above
 * do — a place, a planned node, a notify terminal and a command node can each be
 * a junction. */
export function withNodeJoin(flow: Flow, nodeId: string, join: JoinMode): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId ? { ...n, join } : n)),
  };
}

/** Every checkout name the board can currently see, deduped and sorted. What the
 * repo pickers offer — `branch-ci-passed`'s repo half and a command node's
 * `cwdRepo` — and the reason both are a `<select>` rather than a text field: this
 * is Agent Flow's own name for a checkout (`run.repos[].name`), not a GitHub
 * `owner/name`, and a user typing the latter would get a rule that never fires
 * and no hint as to why.
 *
 * Derived from what is on the board rather than from settings, because the board
 * is what the conditions are answered against. It is therefore INCOMPLETE by
 * nature — a repo with no card on the deck right now is a perfectly valid thing
 * for a `branch-ci-passed` rule to name — which is why both callers pair it with
 * the same extra-`<option>` pattern this file already uses for an unconfigured
 * command or mode, rather than treating a name that is missing here as wrong.
 *
 * Sorted so the list does not reshuffle as cards come and go: the order of
 * `runs` is the board's, and a picker whose options move between renders is one
 * a user cannot build muscle memory for. */
export function repoOptions(runs: { repos: { name: string }[] }[]): string[] {
  const seen = new Set<string>();
  for (const r of runs) for (const repo of r.repos) if (repo.name !== "") seen.add(repo.name);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Name a configured command on this rule's target node. Written on the NODE, not
 * the edge, for the same reason a launch's mode and destination are: the command
 * is the node's own configuration, and `performEdge` resolves it from there. */
export function withCommandId(flow: Flow, edge: FlowEdge, commandId: string): Flow {
  return withNodeCommandId(flow, edge.to, commandId);
}

/** Put free text on this rule's target command node. See `withNodeCommandRun`. */
export function withCommandRun(flow: Flow, edge: FlowEdge, run: string): Flow {
  return withNodeCommandRun(flow, edge.to, run);
}

/** The target command node of this rule, or `undefined` when it points at
 * anything else — the `run` counterpart of `plannedTargetOf`. */
export function commandTargetOf(flow: Flow, e: FlowEdge): CommandNode | undefined {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "command" ? n : undefined;
}

export function withNotifyMessage(flow: Flow, edge: FlowEdge, message: string): Flow {
  return withNodeNotifyMessage(flow, edge.to, message);
}

/** What a command node's two controls read, for whichever node they are about —
 * the node a selected rule points at, or the selected node itself. THREE surfaces
 * derived these same three values from the same fields by hand (the canvas
 * inspector, the list's open row, and now the node inspector), which is three
 * chances for one node to be described two ways; `commandLabel` above already
 * lives here for the identical reason. */
export interface CommandFields {
  /** The Command select's value: a configured id, `COMMAND_FREE_TEXT` when the
   * node is in the free-text shape, or `""` for a node carrying neither (only a
   * hand-edited file — every picker sets one). `commandId` wins when a file
   * somehow carries both, matching `commandLabel`; `resolveCommand` is what
   * refuses that shape at fire time rather than picking a side. */
  value: string;
  /** Does the select already have an option for `value`? Free text always does
   * (its option is unconditional), and so does a configured id still in the
   * setting. When it does not, the caller renders the extra option that says so —
   * a `<select>` whose value matches none of its options shows its FIRST one
   * instead, which would read as a command that exists. */
  idExists: boolean;
  /** The free-text field's value, and — by being `undefined` for a configured
   * command — whether that field renders at all. */
  run: string | undefined;
}

export function commandFieldsOf(node: CommandNode | undefined, commands: FlowCommand[]): CommandFields {
  const value = node?.commandId ?? (node?.run !== undefined ? COMMAND_FREE_TEXT : "");
  return {
    value,
    idExists: value === COMMAND_FREE_TEXT || commands.some((c) => c.id === value),
    run: node?.commandId === undefined ? node?.run : undefined,
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

/** A rule as one compact line, for a presentation with no room for the open
 * row's controls — the dry-run panel. Spends `endLabel`, `condOptionLabel` and
 * `ACTION_LABEL`, the same three the closed row and the inspector spend, rather
 * than a fourth hand-typed phrasing of the same sentence (see this file's own
 * header comment for why that matters).
 *
 * `notify` deliberately drops its target's name: `ACTION_LABEL.notify` is
 * already a whole clause ("Notify me in VS Code") and `endLabel` answers
 * "notify" for that node, so spelling both would read "Notify me in VS Code
 * notify". A target whose kind this build cannot derive an action for says so
 * instead of silently reading as a rule that does nothing. */
export function ruleOneLine(flow: Flow, e: FlowEdge): string {
  const action = edgeAction(flow, e);
  const then = action === undefined
    ? "its target is gone"
    : action === "notify"
      ? ACTION_LABEL.notify
      : `${ACTION_LABEL[action]} ${endLabel(flow, e.to)}`;
  return `${endLabel(flow, e.from)} · ${condOptionLabel(e.cond)} → ${then}`;
}

/** A dry-run verdict in words.
 *
 * A `fire` row reads differently depending on `perform`, and that is the whole
 * reason `RulePreview` carries the flag: the non-performing edges of an "all"
 * junction ARE stamped this pass, so "would fire" is true of them, but the
 * junction's action happens ONCE. Three siblings each reading "would launch"
 * promises three windows where one opens — the exact overclaim a dry run exists
 * to prevent. */
export function verdictLabel(v: RulePreview): string {
  switch (v.verdict) {
    case "fire": return v.perform ? "would fire" : "would close the join";
    case "defer": return "deferred";
    case "blocked": return "blocked";
    // Not "blocked": that says something outside the rule is in the way and will
    // pass. This one is a property of the rule itself and outlasts any board.
    case "unset": return "never fires";
    case "waiting": return "waiting";
  }
}

/** Why a rule is in the state `verdictLabel` names, or `null` where the verdict
 * says everything there is to say. `waiting` is deliberately absent: its reason
 * is what the source place currently LOOKS like, which is `observationOf`'s
 * question, and the caller already has that pair to hand.
 *
 * `blocked`'s three reasons get their first user-facing wording here.
 * `BlockedNote` has been computed on every armed pass since the orchestrator
 * shipped and read by nothing — `evaluate.ts`'s own doc comment claims the
 * drawer's footer surfaces it, which was never true. The dry run is its first
 * consumer, so these two strings are new copy, not a move. */
export function verdictWhy(v: RulePreview): string | null {
  if (v.verdict === "defer") {
    return `met, but ${MAX_LAUNCHES_PER_PASS} is this pass's cap — fires on a later pass`;
  }
  // `condIncomplete`'s own words, unchanged — the inspector marks the field with
  // this exact string and the arm warning counts the rules it applies to, so a
  // third phrasing here would be a third claim about one fact.
  if (v.verdict === "unset") return v.blank ?? null;
  if (v.verdict !== "blocked") return null;
  if (v.reason === "gone") return "its card is not on the board right now";
  if (v.reason === "awaiting-answer") return "it is waiting on your answer";
  return "its session activity cannot be read";
}
