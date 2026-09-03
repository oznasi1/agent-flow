import * as React from "react";
import { placeActivity } from "../engine/orchestrator/conditions";
import { previewFlow } from "../engine/orchestrator/preview";
import { anchor, edgePath, labelPoint, GATE_H, NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Condition, edgeAction, Flow, FlowEdge, FlowNode, GateNode, incomingEdges, isSettled, JoinMode, LaunchDest, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { isBuiltinTemplateId } from "../engine/orchestrator/starters";
import { canBindTicket, DemotionChoice, FlowTemplate, placesToDemote } from "../engine/orchestrator/templates";
import { CondParams, RepoOptions } from "./CondParams";
import { AgentState, BranchCiStatus, FlowCommand, FlowPromptMode, PendingResume, RunStatus } from "../types";
import { MultiCombo } from "./combo";
import { createDrawerResize, RESIZE_STEP } from "./drawerResize";
import { Drawer, useDrawerExit } from "./Drawer";
import { FlowList } from "./flowList";
import { ORCH_EDGE_PAINT_DY } from "./orchestratorStyles";
import { WorkflowList, WorkflowRow } from "./WorkflowList";
import {
  ACTION_LABEL,
  addCommandNode,
  COMMAND_FREE_TEXT,
  COMMAND_NONE_LABEL,
  COMMAND_NOT_SET,
  CWD_REPO_DEFAULT,
  commandFieldsOf,
  commandTargetOf,
  condOffered,
  condOptionLabel,
  COND_LABEL,
  defaultCondFor,
  DEST_LABEL,
  endLabel,
  INSPECTOR_NONE,
  isMigrationNotice,
  launchDestOf,
  modeValueOf,
  nextEdgeId,
  nextNodeId,
  NOTE_ARIA_LABEL,
  NOTE_COMMAND_HINT,
  NOTE_COMMAND_PLACEHOLDER,
  NOTE_PLACEHOLDER,
  notifyMessageOf,
  observationFallback,
  observationOf,
  isBareCond,
  JOIN_LABEL,
  NODE_KIND_LABEL,
  ruleOneLine,
  offeredConds,
  repoOptions,
  OFFERED_DESTS,
  verdictLabel,
  verdictWhy,
  withCommandId,
  withCommandRun,
  withCond,
  withCondParams,
  withDest,
  withMode,
  withNodeCommandId,
  withNodeCommandRun,
  withNodeCwdRepo,
  withNodeGateQuestion,
  withNodeJoin,
  withNodeNotifyMessage,
  withNote,
  withNotifyMessage,
  withoutEdge,
} from "./orchestratorRule";
import { send } from "./vscodeApi";

/** The width before any drag or arrow-key resize, and the fallback for a
 * missing or corrupt stored value. Matches the default this same figure
 * carries in `--orch-w` (orchestratorStyles.ts), so the very first paint —
 * before this file's state can even be read — already agrees with it. */
const DEFAULT_ORCH_W = 560;

/** Floor: narrow enough to give more room to the board, but the header row —
 * the flow switcher, "Delete flow", the close button, and the name field —
 * must not wrap or clip at it. 420px is the narrowest that still holds that
 * row comfortably.
 *
 * The ceiling (viewport-derived, not a fixed pixel) and the persistence key
 * this width lives under are also this drawer's own — see
 * `createDrawerResize` in `drawerResize.ts` for the shared arithmetic every
 * drawer built on that module reuses. */
const MIN_ORCH_W = 420;

/** This drawer's own instance of the shared width machinery — the ceiling,
 * clamp, "full panel width" escape hatch, and defensive read/write — built
 * once per module, not per render. `key: "orchWidth"` is the persisted
 * shape this file has always used. `persist` (see `drawerResize.ts`) merges
 * into the one shared persisted-state object rather than replacing it, which
 * is what lets a second drawer built on this same factory (`DeckDetail.tsx`'s
 * card drawer, under its own `"ddWidth"` key) coexist with this one for free
 * — neither drawer's resize can wipe out what the other has stored. */
const orchResize = createDrawerResize({ min: MIN_ORCH_W, def: DEFAULT_ORCH_W, key: "orchWidth" });

/** The drag payload a Deck card carries. A NUL separator cannot appear in a
 * ticket key or a repo name, so parsing is unambiguous. */
export const DRAG_SEP = "\0";

function parseDrag(raw: string): { runKey: string; repo: string } | null {
  const i = raw.indexOf(DRAG_SEP);
  if (i <= 0) return null;
  const runKey = raw.slice(0, i);
  const repo = raw.slice(i + 1);
  return runKey && repo ? { runKey, repo } : null;
}

/** The keyboard equivalent of dragging a Deck card onto the tray or canvas —
 * the one node kind Task 6 found with no non-pointer way in. Every repo of
 * every run currently on the board, minus whichever pairs are already a
 * place node in this flow: offering one of those would be a selection that
 * silently does nothing, since `attached` itself refuses the duplicate (see
 * its own dedup check). Keyed in the exact string `attached`/`parseDrag`
 * already agree on — DRAG_SEP-joined `runKey`+`repo` — so the picker built on
 * this list calls `attachMany` (and through it `attached`) rather than a second
 * implementation of what a valid attach is.
 *
 * The two halves are returned separately, not pre-joined into one label: the
 * picker prints the run key as the row and the repo underneath it, the same
 * split the tray's own chips use (`.orch-tchip`'s `.k` and `.sub`), and its
 * search matches across both. */
function placeCandidates(flow: Flow, runs: RunStatus[]): { key: string; runKey: string; repo: string }[] {
  const out: { key: string; runKey: string; repo: string }[] = [];
  for (const r of runs) {
    for (const repo of r.repos) {
      const dup = flow.nodes.some(
        (n) => n.kind === "place" && n.runKey === r.run.key && n.repo === repo.name,
      );
      if (dup) continue;
      out.push({ key: `${r.run.key}${DRAG_SEP}${repo.name}`, runKey: r.run.key, repo: repo.name });
    }
  }
  return out;
}

/** The flow with one more place node in it, at `x`/`y` — or `null` when there is
 * nothing to add: an unparseable drag payload, or a place this flow already has.
 * (The same place twice would give two nodes that can never disagree.)
 *
 * Pure, and returning the next flow rather than saving it, so the batch path
 * (`attachMany`) can fold it over its own output and write once. The single-drop
 * path (`attachAt`) is the same function with an immediate save. */
function attached(flow: Flow, raw: string, x: number, y: number): Flow | null {
  const parsed = parseDrag(raw);
  if (!parsed) return null;
  const dup = flow.nodes.some(
    (n) => n.kind === "place" && n.runKey === parsed.runKey && n.repo === parsed.repo,
  );
  if (dup) return null;
  return {
    ...flow,
    nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "place", x, y, join: "any", ...parsed }],
  };
}

/** "Keep this one": name a free-text command and append it to
 * `agentFlow.commands`, so the next node picks it from the list instead of
 * retyping it. The host owns the write — a webview has no fs and cannot touch
 * settings (see `flow:saveCommand`).
 *
 * `runNow` is a GETTER, not the text: the command field beside this is
 * uncontrolled and commits on blur, so the flow's own copy can be one edit behind
 * what is on screen when Save is pressed. Reading the live field at press time is
 * what makes "type a command, press Save" save the command you typed. (The
 * VISIBILITY of this row keys off the committed value instead — a row that
 * appeared and vanished per keystroke would be worse than one that waits.)
 *
 * Its own state, and its own `key` at the call site, so switching to another node
 * clears a half-typed name rather than offering it for the wrong command. */
function SaveCommandRow({ runNow }: { runNow: () => string }): JSX.Element {
  const [label, setLabel] = React.useState("");
  const clean = label.trim();
  const save = () => {
    const run = runNow().trim();
    if (!run || !clean) return;
    send({ type: "flow:saveCommand", run, label: clean });
    setLabel("");
  };
  return (
    <div className="orch-clause">
      <span className="orch-kw" />
      <input
        className="orch-msg"
        aria-label="Name for settings"
        value={label}
        placeholder="Name it to keep it — e.g. Deploy to staging"
        onChange={(ev) => setLabel(ev.currentTarget.value)}
        // Enter is the gesture a name field invites, and this one has a button
        // right beside it rather than a form to submit — so the key has to be
        // wired by hand or it does nothing at all.
        onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } }}
      />
      <button type="button" className="orch-mini" disabled={clean === ""} onClick={save}>
        Save to settings
      </button>
    </div>
  );
}

/** One row on the Templates tab: a template's name, its rule count, how many
 * live workflows were built from it, and the verbs a TEMPLATE offers —
 * Duplicate always, Rename and Delete only for a template the user owns.
 * Never Arm, disarm or Detach: a template is the reusable SHAPE, not a
 * workflow attached to a card, so those verbs do not exist here (see this
 * task's own vocabulary rule).
 *
 * Built-in-ness is derived from `isBuiltinTemplateId(t.id)` — the same
 * predicate the HOST checks before refusing a rename/delete/overwrite — rather
 * than a prop this component is handed. One source of truth: a second copy of
 * "is this one of the three starters" could drift from the host's own check
 * (e.g. after a duplicate strips the prefix), silently offering a control that
 * fails server-side, or hiding one that would have succeeded.
 *
 * Rename and Delete are ABSENT on a built-in, not disabled: a disabled button
 * still needs a reason shown somewhere (a title attribute, a tooltip) and
 * invites a second copy of that reason to drift from this comment. Duplicate
 * is the one supported path to owning an editable copy, and it stays enabled
 * unconditionally — see its own line below.
 *
 * `onCards` is a lookup the caller already did (`Flow.fromTemplate === t.id`),
 * never a guess from this row: matching on name or rule count would silently
 * merge two unrelated templates that happen to look alike, and a workflow is
 * free to diverge from its template's shape the moment it is instantiated —
 * name and rule count are exactly the two things that can no longer be
 * trusted to agree. Unaffected by built-in-ness: a starter is on cards the
 * same way a user template is, and this row must keep saying so.
 *
 * Its own component, not inlined in the switcher panel below, so Rename and
 * the delete confirmation each get their own local state scoped to one row —
 * a `Record<templateId, …>` living for the switcher's whole lifetime would
 * survive switching tabs and leak a half-confirmed delete onto the wrong
 * template if the list re-orders under it. */
function TemplateRow({
  t, onCards, onDuplicate, onRename, onDelete,
}: {
  t: FlowTemplate;
  onCards: number;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const [renaming, setRenaming] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const ruleCount = t.flow.edges.length;
  const builtin = isBuiltinTemplateId(t.id);
  return (
    <div className="orch-tmpl-row">
      <div className="row">
        {renaming ? (
          <input
            className="orch-name"
            aria-label={`Rename ${t.name}`}
            defaultValue={t.name}
            autoFocus
            onBlur={(ev) => {
              const next = ev.currentTarget.value.trim();
              setRenaming(false);
              if (next && next !== t.name) onRename(next);
            }}
            // Enter commits the same way blur does; Escape backs out without
            // touching the stored name — the same pair of exits the node
            // inspector's own free-text fields (SaveCommandRow, above) offer.
            onKeyDown={(ev) => {
              if (ev.key === "Enter") ev.currentTarget.blur();
              if (ev.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="t">{t.name}</span>
        )}
        {/* `.meta` — the same quiet, muted treatment this row already uses for
            the rule count and card count below, not `--c-attn`/`--c-danger`:
            being built-in is neither a warning nor a failure, just a fact
            about where the template came from. */}
        {builtin && <span className="meta">Built-in</span>}
        <div className="sp" />
        <span className="meta">{ruleCount} {ruleCount === 1 ? "rule" : "rules"}</span>
      </div>
      <div className="row">
        <span className="meta">on {onCards} {onCards === 1 ? "card" : "cards"}</span>
      </div>
      {confirming ? (
        <div className="row">
          {/* Says both halves: what Delete does, and — just as load-bearing —
              what it deliberately leaves alone. `toTemplate`/`instantiate`
              copy the template's shape into a workflow rather than reference
              it, so a workflow already built from this template is its own,
              independent flow the moment it exists; this line is what keeps
              the confirmation from implying otherwise. */}
          <span className="meta">Delete “{t.name}”? Workflows already made from it keep running.</span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="orch-mini" onClick={onDelete}>Confirm delete</button>
        </div>
      ) : (
        <div className="row">
          <button type="button" className="orch-mini" onClick={onDuplicate}>Duplicate</button>
          {/* Rename and Delete: absent, not disabled, on a built-in — see this
              component's own doc comment for why. */}
          {!builtin && (
            <>
              <button type="button" className="orch-mini" onClick={() => setRenaming(true)}>Rename</button>
              <button type="button" className="orch-mini" onClick={() => setConfirming(true)}>Delete</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The tray shows what a condition can attach to: a place already on disk, or
 * work not yet launched. Named by the two kinds it admits, not by the ones it
 * excludes — `!== "notify"` once let a `CommandNode` through too (TypeScript
 * does not check a predicate's body against its claimed type), which the
 * `.ticketKey`/`.runKey` accesses below then read off a node that has
 * neither: a chip with a blank `.k`, "not taken" as its sub, and
 * `aria-label="Remove undefined"`. */
function isAgentNode(n: FlowNode): n is PlaceNode | PlannedNode {
  return n.kind === "place" || n.kind === "planned";
}

/** A node's live state, from the card it points at. `undefined` when the node is
 * not a place, or its run is not on the board — the node is still drawn, just
 * without a claim about it. Takes the union directly so no cast is needed.
 *
 * Resolved through `placeActivity`, NOT through `status.agent`. That aggregate is
 * `mostActive` over every agent in every repo of the run (see `buildRunStatus`), so
 * reading it here would paint this node with another repo's state: a two-worktree
 * run whose `web` agent has ended its turn would put an amber needs-you dot on a
 * node bound to `api` — while the inspector, which goes through `describeCond` →
 * `placeActivity`, correctly said "agent state unknown" two panes below. One panel
 * cannot make two contradictory claims about the same place. */
function nodeState(node: FlowNode, runs: RunStatus[]): AgentState | undefined {
  if (node.kind !== "place") return undefined;
  const status = runs.find((r) => r.run.key === node.runKey);
  if (!status) return undefined;
  return placeActivity({ status, repo: node.repo, nowMs: Date.now() }).state;
}

/** A notify node is narrower than a place. This must match `.orch-node.notify`'s
 * width in orchestratorStyles.ts — the two are the same number in two languages.
 *
 * Correction to an earlier version of this comment: this number is NOT currently
 * load-bearing for the anchor maths, and no test can prove otherwise. `anchor`'s
 * "in" side never reads a box's `w` (only "out" adds it), and a notify node can
 * never be a wiring's source — it has no out-port — so this width only ever
 * reaches `anchor`'s "in" branch, where it is ignored. It stays a real, correct
 * fact about the model (a notify node genuinely IS this narrow) so a terminal
 * that later gains an out-port doesn't silently inherit the wrong box, but treat
 * it as inert today, not protective. */
const NOTIFY_W = 138;

const STATE_HUE: Record<AgentState, string> = {
  working: "var(--c-progress)",
  "needs-you": "var(--c-attn)",
  blocked: "var(--c-attn)",
  stalled: "var(--c-attn)",
  exited: "var(--c-attn)",
  idle: "var(--c-idle)",
  unknown: "var(--dim)",
};

/** Conditions that describe something being wrong. The only edges allowed a
 * danger tint — colour here is attention debt, not decoration. */
const BAD_CONDS = new Set<Condition["kind"]>(["ci-failed", "changes-requested", "pr-conflicting"]);

/** What the drawer is addressed at: a saved `Flow` by id, or a `FlowTemplate`
 * by id. A template's payload IS a `Flow` (`FlowTemplate.flow`), which is what
 * lets one canvas serve both — see `openFlow` below. */
export type OrchTarget = { kind: "flow"; id: string } | { kind: "template"; id: string };

/** The drawer's three top-level screens. Active is every card carrying a
 * workflow (`WorkflowList`, below); Templates is every reusable shape,
 * starters included; Canvas is the flow-graph editor this drawer has always
 * been. Owned by `DeckApp`, not local state — a later task adds two header
 * buttons that set this from outside the drawer, and a screen only this
 * component could change could never be reached from there. */
export type OrchView = "active" | "templates" | "canvas";

export interface OrchestratorDrawerProps {
  flows: Flow[];
  /** Which flow or template Canvas is addressing. `null` there means Canvas
   * has nothing to show (`if (!flow) return null`, below) — but that is no
   * longer the same claim as "the drawer is closed": Active and Templates
   * need no flow addressed at all. See `open`, just below, for the signal
   * that actually answers that question on their behalf. */
  openId: OrchTarget | null;
  /** Which of the three top-level screens is showing. See `OrchView`. */
  view: OrchView;
  onView: (v: OrchView) => void;
  /** Is the drawer showing at all, for the Active/Templates screens
   * specifically — Canvas needs no such signal, since whether a flow
   * resolves already decides its visibility (`openId` above). Active and
   * Templates have no flow to key off, so `DeckApp` hands this over
   * explicitly instead. Optional, and treated as shown when absent
   * (`p.open === false` is the one value that closes it): every test in this
   * file predating the flag exercises Canvas, or an Active/Templates screen
   * with no opinion on open/closed either way, and defaulting to shown keeps
   * every one of them compiling and passing unmodified. */
  open?: boolean;
  /** The Active screen's own rows — one per card carrying a workflow,
   * already sorted by the caller (see `WorkflowList`'s own contract: it
   * renders what it is handed and does not sort). Empty until a later task
   * derives the real rows from the board; this one only builds the shell
   * that renders them. */
  rows: WorkflowRow[];
  /** Opens the card a workflow row named — closes this drawer and selects
   * that card, the mirror image of `DeckDetail`'s own `onOpenWorkflow` (that
   * one opens a workflow FROM a card; this one opens a card FROM its
   * workflow, so the workflow is read where it lives). */
  onOpenCard: (cardId: string) => void;
  /** Every card on the board, so the tray and canvas can resolve a node's live
   * state and the inspector can say what a condition is currently waiting on. */
  runs: RunStatus[];
  /** Rules already met on an armed flow, reported rather than acted on — see
   * `PendingResume`'s own doc comment for why this is a gate, not a courtesy. */
  pendingResume: PendingResume[];
  /** The configured prompt modes, narrowed to what the inspector's USING
   * selector needs. Configuration, not flow data — it comes from the host's
   * `deck:flows` post (`postFlows` in deckView.ts) rather than being
   * hardcoded here, because the webview has no fs access to read it itself. */
  promptModes: FlowPromptMode[];
  /** `agentFlow.commands`, from the same `deck:flows` post and for the same
   * reason as `promptModes`: a command node names one of these, and the webview
   * cannot read the setting itself. An empty list is the ordinary case — no
   * built-ins ship — and the free-text option below is what keeps the command
   * node reachable for a user who has configured none. */
  commands: FlowCommand[];
  /** Branch-CI verdicts the host has fetched, keyed `repo#branch` — the same map
   * `evaluateFlow` is handed. Without it a `branch-ci-passed` rule's own
   * observation line reads "not checked yet" forever, even while the host knows
   * the branch is PENDING or FAILED: a rule whose state is invisible. Empty
   * before the first post, and whenever PR facts are off (the host refuses to
   * serve a verdict it would not act on itself). */
  branchCi: Record<string, BranchCiStatus>;
  /** Every saved template, from the same `deck:flows` post as `flows` itself
   * (`postFlows` in deckView.ts). Rendered on the Templates tab of the flow
   * switcher — never armed, disarmed or detached, because a template is not
   * attached to anything; those are WORKFLOW verbs. A row's own writes
   * (`flow:renameTemplate`, `flow:deleteTemplate`, `flow:duplicateTemplate`)
   * go straight through `send`, the same way `flow:saveCommand` and
   * `flow:addPlanned` already do above — there is no host round trip this
   * file's own closures need to wrap first, so no new prop callback exists
   * for any of the three. */
  templates: FlowTemplate[];
  /** The one in-flight "＋ New template…" draft, or `null` — `DeckApp`'s own
   * state (`mintDraftTemplate`'s own doc comment), handed in as a prop
   * rather than reached for, so `openFlow` below can resolve a template
   * target against it the exact same way it resolves one against
   * `p.templates`: a draft is a `FlowTemplate` like any other, just one
   * `deck:flows` will never carry. Never itself added to `p.templates` —
   * that is what keeps a card's attach picker (`DeckDetail.tsx`, reading the
   * very same `templates` list this drawer does) from ever offering it. */
  draftTemplate: FlowTemplate | null;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (flow: Flow) => void;
  onDelete: (id: string) => void;
  onArm: (id: string, armed: boolean) => void;
  onResumeApprove: (id: string) => void;
  onResumeDisarm: (id: string) => void;
  onResetEdge: (id: string, edgeId: string) => void;
  /** "＋ New template…" — mints a fresh draft (or reopens the one already in
   * flight) and opens it on Canvas. See `DeckApp`'s own `onNewTemplate` for
   * why this is not `onCreate`: that verb mints a WORKFLOW, not a template. */
  onNewTemplate: () => void;
  /** Leave template-editing entirely, back to the Templates screen — the
   * canvas's own Cancel button while `editingTemplate`, and also called
   * right after Save sends `flow:writeTemplate` (see `DeckApp`'s own
   * doc comment on its identical prop). */
  onCancelTemplate: () => void;
}

export function OrchestratorDrawer(p: OrchestratorDrawerProps): JSX.Element | null {
  const target = p.openId;
  /** Editing a template, not a workflow — so every WORKFLOW verb is off.
   *
   * The vocabulary rule this file already states (see `TemplateRow`'s own doc
   * comment on the Templates tab) enforced instead of described: a template
   * has no ticket and nothing to watch, so it cannot be armed, disarmed,
   * detached, approved or dry-run. One boolean rather than a check at each
   * site, because the failure mode is a site nobody remembered — this file is
   * 2,400+ lines and a verb gated by inspection is a verb someone will miss
   * the next time one is added. Declared here, above both early returns
   * (`p.view !== "canvas"` and `!flow`, below), even though it is not itself a
   * hook: every value this component derives from `target` lives in one
   * place, right beside `openKey`. */
  const editingTemplate = target?.kind === "template";
  /** Stable string form of `target`, for every hook below that needs a value
   * to key an effect or `useDrawerExit` on rather than the target object's own
   * identity — `DeckApp` has no reason to hand back the same object reference
   * across renders for "the same" flow or template. */
  const openKey = target && `${target.kind}:${target.id}`;
  /** The flow the canvas is editing, whichever kind of thing the target names.
   *
   * A template's payload IS a `Flow` (`FlowTemplate.flow`), which is what makes
   * one editor enough for both: the canvas never learns there are two kinds of
   * target, and only the VERBS around it change (see `editingTemplate`, Task 12). */
  const openFlow =
    target === null
      ? undefined
      : target.kind === "flow"
        ? p.flows.find((f) => f.id === target.id)
        // A saved template first, and the in-flight draft only as a
        // fallback: a real save always wins, and a draft never collides
        // with one anyway (its id never matches anything `deck:flows` ever
        // posts — see `mintDraftTemplate`'s own doc comment).
        : (p.templates.find((t) => t.id === target.id) ?? (p.draftTemplate?.id === target.id ? p.draftTemplate : undefined))?.flow;
  /** The flow the drawer keeps painting while it slides back out, and whether it
   * is doing that — both from the shared drawer seam, so this drawer and the
   * card detail leave the board the same way. Frozen and unreachable for that
   * span: a drawer on its way out must not answer a role query, a screen
   * reader, or a Tab. The click that closed it has already sent focus back to
   * the chip. `Drawer.tsx` holds the reasoning, including why the hook needs
   * both `openId` and the flow it resolves to. */
  const { shown: flow, closing } = useDrawerExit(openKey, openFlow);
  /** Canvas ⇄ list. The canvas is a board built from divs and pointer events —
   * no usable keyboard story — so `FlowList` (flowList.tsx) exists as the
   * keyboard path onto the exact same `Flow`. Canvas stays the default: this
   * toggle only ever narrows what a mouse user already had, it does not
   * change it. Never persisted alongside `width` — reopening the drawer in a
   * fresh session should land on the canvas, not silently reopen on whichever
   * view a past session happened to be reading. */
  const [canvasView, setCanvasView] = React.useState<"canvas" | "list">("canvas");
  // The dry run is a READ, so it is component state and nothing else: never
  // persisted, never posted, and deliberately not remembered across a reopen —
  // a verdict is about the board as it is right now, and one restored from a
  // previous session would be about a board that has moved.
  const [dryRun, setDryRun] = React.useState(false);

  // Computed on every render while the panel is open, and deliberately NOT
  // memoised. `previewFlow` is two passes over a graph of a dozen edges, so there
  // is nothing to save — and a memo would have to key on time to be correct,
  // since a condition like `agent-idle-over` is answered against `Date.now()`.
  // A stale-by-one-render verdict beside a `waiting` reason line that reads a
  // fresh clock (`observationOf`, below) is two answers about one rule.
  // `!editingTemplate` sits beside `dryRun`/`flow` here, not only at the panel's
  // render site further down: the toggle that sets `dryRun` true is itself
  // hidden while editing a template (see the header block, below), but
  // `dryRun` is local state that outlives an `openKey` change — nothing resets
  // it when the target switches FROM an armed flow with the panel open TO a
  // template. A dry run is a verdict about being armed, and a template cannot
  // be armed, so it has nothing to verdict either way.
  const dry = dryRun && flow && !editingTemplate ? previewFlow(flow, p.runs, Date.now(), p.branchCi) : [];
  const firing = dry.filter((v) => v.verdict === "fire").length;
  /** The Save-as-template dialog's own state: whether it is open, the name
   * typed so far, and one {mode, dest} choice per place node being demoted.
   * Keyed by node id rather than array index, so a re-render between opening
   * the dialog and pressing Save (the flow prop is live, same as everywhere
   * else in this file) cannot silently shift which row a stray edit lands on.
   * Cleared and reseeded every time the dialog opens (`openSaveTemplate`
   * below), and also force-closed the moment `openKey` changes (the effect
   * just below) — the switcher stays reachable while this dialog is open, and
   * without that second clear, switching to another flow mid-type would leave
   * the dialog open over the NEW flow: same typed name, now describing a
   * different flow's places, and Save would write that name against the
   * wrong workflow. A dry run has the identical gap but is a READ that
   * recomputes fresh off whatever flow is current, so it stays open across a
   * switch on purpose (see its own state, below); this is a WRITE, so it does
   * not get the same latitude. */
  const [savingTemplate, setSavingTemplate] = React.useState(false);
  const [templateName, setTemplateName] = React.useState("");
  const [templateChoices, setTemplateChoices] = React.useState<Record<string, { mode: string; dest: LaunchDest }>>({});
  // Keyed on `openKey` alone, deliberately: this exists to catch the target
  // itself changing under an open dialog, not to react to anything else
  // about the flow (an edit to the SAME flow while the dialog is open must
  // not close it). A string key rather than `p.openId` itself, so a caller
  // that hands back a fresh `OrchTarget` object for "the same" flow or
  // template on every render cannot fire this spuriously.
  React.useEffect(() => {
    setSavingTemplate(false);
    setTemplateName("");
    setTemplateChoices({});
  }, [openKey]);
  const [over, setOver] = React.useState(false);
  const [overGraph, setOverGraph] = React.useState(false);
  const graphRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  /** The live drag position, written on every move alongside `setDrag`. `pointermove`
   * is InputContinuous priority and `pointerup` is Discrete, so a release can arrive
   * before React has flushed the final move into `drag` — reading `drag` itself in
   * the release handler would then save the position one move stale. This ref is
   * written synchronously in the same handler that computes the position, so the
   * release handler below always reads what actually happened, not what React has
   * gotten around to committing. */
  const dragRef = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const [sel, setSel] = React.useState<string | null>(null);
  const [wiring, setWiring] = React.useState<string | null>(null);
  const [selEdge, setSelEdge] = React.useState<string | null>(null);
  const [width, setWidth] = React.useState<number>(() =>
    orchResize.clamp(orchResize.read() ?? DEFAULT_ORCH_W),
  );
  /** The escape hatch, for a graph big enough that resize's board-reserving
   * ceiling still clips it. Deliberately NOT persisted alongside `width`
   * (see `orchResize.read`/`orchResize.persist`, which know nothing of
   * this flag) and always starts `false`: reopening the drawer in a fresh
   * session should land on a resized-but-board-visible view, never
   * silently reopen with the board hidden because a PAST session happened
   * to be mid-review of one large flow. Never touched by anything other
   * than `toggleExpanded` below — in particular, expanding never writes
   * into `width` itself, which is exactly what makes collapsing restore the
   * user's own resized value for free (see `renderWidth` near the return). */
  const [expanded, setExpanded] = React.useState(false);
  const [resizing, setResizing] = React.useState<{ startX: number; startW: number } | null>(null);
  /** Mirrors `dragRef` above, for the identical reason: `pointerup` can arrive
   * before React flushes the last `pointermove`'s `setWidth`, so the release
   * handler reads this ref (written synchronously in `move`) rather than the
   * `width` this effect closed over. */
  const resizeRef = React.useRef<number | null>(null);
  /** The node inspector's free-text command field, so the Save-to-settings row can
   * read what is ON SCREEN rather than the copy the flow committed on the last
   * blur. Declared up here with the other hooks, not beside the JSX that uses it:
   * everything below `if (!flow) return null` is past an early return, and a
   * `useRef` there changes the hook count between renders — React's "rendered
   * fewer hooks than expected", which the closing-animation tests caught. */
  const runRef = React.useRef<HTMLInputElement>(null);

  // Same shape as the drag effect above, and for the same reason: one pointer
  // handler pair on `window`, live while a resize is in progress, torn down
  // the moment it ends. The persist happens in `up`, once, not on every move —
  // a disk write per pixel would be as wasteful here as it would be for a
  // dragged node.
  React.useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      // Pulling the left border further LEFT (a smaller clientX) grows the
      // drawer, since it is anchored to the right edge of the panel.
      const next = orchResize.clamp(resizing.startW + (resizing.startX - e.clientX));
      resizeRef.current = next;
      setWidth(next);
    };
    const up = () => {
      const finalWidth = resizeRef.current ?? resizing.startW;
      resizeRef.current = null;
      setResizing(null);
      orchResize.persist(finalWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [resizing]);

  // One pointer handler, and a save only on release — a save per pointermove would
  // be a disk write per pixel. Guarded on `flow` too: hooks must run unconditionally
  // (so this sits above the `!flow` early return below), but its body only ever
  // does anything once a drag has actually started, which cannot happen before a
  // flow is open.
  React.useEffect(() => {
    if (!drag || !flow) return;
    const move = (e: PointerEvent) => {
      const box = graphRef.current?.getBoundingClientRect();
      const ox = box?.left ?? 0;
      const oy = box?.top ?? 0;
      const x = snap(e.clientX - ox - drag.dx);
      const y = snap(e.clientY - oy - drag.dy);
      dragRef.current = { id: drag.id, x, y };
      setDrag((d) => (d ? { ...d, x, y } : d));
    };
    // The save happens OUTSIDE the `setDrag` updater. A state updater must be pure,
    // and this one is not hypothetically impure: with `p.onSave` inside it, React
    // double-invokes the updater under StrictMode and one released drag becomes TWO
    // writes of the user's flow file (measured — see the "exactly once, even under
    // StrictMode" test).
    //
    // Reads `dragRef.current`, not the `drag` this effect closed over: `pointermove`
    // is InputContinuous priority and `pointerup` is Discrete, so a release arriving
    // before React flushes the final move's `setDrag` would otherwise save the
    // position from one move ago. The ref is written synchronously in `move` above,
    // so it always holds the truth regardless of where React's render is.
    const up = () => {
      const live = dragRef.current;
      const orig = flow.nodes.find((n) => n.id === drag.id);
      // Only a move that actually moved is worth a write.
      if (orig && live && (orig.x !== live.x || orig.y !== live.y)) {
        p.onSave({ ...flow, nodes: flow.nodes.map((n) => (n.id === drag.id ? { ...n, x: live.x, y: live.y } : n)) });
      }
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, flow, p]);

  /** Hoisted above the `!flow` check below (their original home was right
   * beside `startDrag`, which does need a flow) because the flow-less
   * Active/Templates shell — the `p.view !== "canvas"` branch just below —
   * needs them too, and none of the three touch `flow` at all: purely
   * `width`/`resizing`/`expanded` state, unaffected by whether a flow is
   * open. */
  const startResize = (e: React.PointerEvent) => {
    setResizing({ startX: e.clientX, startW: width });
  };

  /** ArrowLeft grows the drawer, ArrowRight shrinks it — the same mapping the
   * pointer drag uses (see the resize effect's `move` above): pulling the
   * left border further left is what makes the drawer wider. Persisted
   * immediately, the same as a released drag, rather than waiting for the
   * grip to lose focus — an arrow press IS the whole gesture, there is no
   * separate "release" to persist on. */
  const onGripKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = orchResize.clamp(e.key === "ArrowLeft" ? width + RESIZE_STEP : width - RESIZE_STEP);
    setWidth(next);
    orchResize.persist(next);
  };

  /** A pure boolean flip that never touches `width` — the functional-updater
   * form so two activations landing in the same React batch (e.g. a rapid
   * double click) still cancel out correctly instead of both reading the
   * same stale `expanded` and racing to the same answer. Because expanding
   * never writes into `width`, applying it again while already expanded is
   * automatically idempotent: `renderWidth` below always recomputes
   * `orchResize.full()` fresh, so there is nothing to compound or drift. */
  const toggleExpanded = () => setExpanded((v) => !v);

  /** What actually renders. Computed here, above the flow check below,
   * rather than beside the canvas-only code that used to be its only
   * reader: the flow-less Active/Templates render (just below) needs the
   * exact same drawer width the canvas one does. */
  const renderWidth = expanded ? orchResize.full() : width;

  /** The three top-level tabs plus Expand/Close — identical whichever of
   * the three screens is showing, and read from BOTH this component's
   * flow-less return (just below, for Active/Templates) and its canvas one
   * (further down): a single JSX value here rather than two copies of the
   * same markup that could silently drift apart. `view` is `DeckApp`'s own
   * state (see `OrchView`'s doc comment): the two header buttons `DeckApp`
   * adds land here exactly the way a click on one of these three tabs
   * already does. */
  const topRow = (
    <div className="row">
      <span role="tablist" aria-label="Orchestrator" style={{ display: "flex", gap: 6 }}>
        <button type="button" role="tab" aria-selected={p.view === "active"} className="orch-mini" onClick={() => p.onView("active")}>
          Active
        </button>
        <button type="button" role="tab" aria-selected={p.view === "templates"} className="orch-mini" onClick={() => p.onView("templates")}>
          Templates
        </button>
        <button type="button" role="tab" aria-selected={p.view === "canvas"} className="orch-mini" onClick={() => p.onView("canvas")}>
          Canvas
        </button>
      </span>
      <div className="sp" />
      <button type="button" className="orch-mini" aria-pressed={expanded} onClick={toggleExpanded}>
        Expand
      </button>
      <button type="button" className="orch-x" aria-label="Close" onClick={p.onClose}>✕</button>
    </div>
  );

  /** Same resize grip in both renders, shared for the identical reason
   * `topRow` is: nothing about it depends on a flow being open. See that
   * control's own doc comment (further down, where it used to live alone)
   * for the ARIA shape. */
  const resizeGrip = !expanded && (
    <div
      className="orch-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Orchestrator drawer"
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_ORCH_W}
      aria-valuemax={orchResize.ceiling()}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={onGripKeyDown}
    />
  );

  // Active and Templates are surfaces over the WHOLE workspace and need no flow
  // resolved; only Canvas edits one. A branch above the canvas's own early return,
  // rather than making `flow` optional below it: everything past this point
  // dereferences `flow`, and threading undefined through it buys nothing.
  if (p.view !== "canvas") {
    // `DeckApp`'s own "is the drawer showing at all" signal — see `open`'s own
    // doc comment for why Canvas needs no equivalent check.
    if (p.open === false) return null;
    return (
      <Drawer surface="orch" label="Orchestrator" closing={closing} style={{ ["--orch-w" as any]: `${renderWidth}px` }}>
        {resizeGrip}
        <div className="orch-hd">{topRow}</div>
        <div className="orch-body">
          {/* The Active screen: every card carrying a workflow, in one place.
              Pure presentation — `WorkflowList` renders exactly the rows it is
              handed and does not sort them (see its own contract) — so this
              component's only job is to hand it `p.rows` and wire a click back
              through `p.onOpenCard`. */}
          {p.view === "active" && (
            <div className="orch-active">
              <WorkflowList rows={p.rows} onOpen={p.onOpenCard} />
            </div>
          )}
          {/* The Templates screen: every reusable shape, starters included.
              `.orch-tmpl-list` is the same wrapper class the old Templates tab
              used, kept unchanged so the template/workflow vocabulary gate's
              own region scan (`jsxBlockAround(..., "orch-tmpl-list")`) still
              finds this exact content. */}
          {p.view === "templates" && (
            <div className="orch-tmpl-list">
              {/* A template is never attached from here — one entry point,
                  the card that needs a workflow, and this screen offering a
                  second, worse way to do what the card already does would be
                  a category error this feature's own naming rule calls out by
                  name: this screen offers Duplicate/Rename/Delete and nothing
                  that arms, disarms, or attaches anything. */}
              {p.templates.map((t) => (
                <TemplateRow
                  key={t.id}
                  t={t}
                  onCards={p.flows.filter((f) => f.fromTemplate === t.id).length}
                  onDuplicate={() => send({ type: "flow:duplicateTemplate", templateId: t.id })}
                  onRename={(name) => send({ type: "flow:renameTemplate", templateId: t.id, name })}
                  onDelete={() => send({ type: "flow:deleteTemplate", templateId: t.id })}
                />
              ))}
              {/* A button with this exact name used to live here and was
                  removed (Task 12's own review round) — it called `onCreate`,
                  which mints an ordinary WORKFLOW: the panel would close,
                  this screen would stay exactly as empty as before, and an
                  untitled entry would appear on the board instead. The
                  wrong verb for a first-time user on an empty Templates
                  screen, so it was gone rather than fixed to do something
                  else — building a workflow first and using its own "Save
                  as template…" (below, on Canvas) remained the one way in.
                  `onNewTemplate` is a different verb, not the same one
                  restored: it mints a TEMPLATE, held only in `DeckApp`
                  state (`draftTemplate` — see `mintDraftTemplate`'s own
                  doc comment) and never written anywhere until its own
                  Save is pressed, which is exactly the property that made
                  the old button's `onCreate` wrong here in the first
                  place. */}
              <button type="button" className="orch-mini" onClick={p.onNewTemplate}>＋ New template…</button>
              {/* `.orch-empty` is the same empty-state treatment the canvas
                  itself uses. */}
              {p.templates.length === 0 && (
                <div className="orch-empty">
                  No templates yet. Start with &ldquo;＋ New template&hellip;&rdquo;
                  above, or build a workflow and use its own &ldquo;Save as
                  template&hellip;&rdquo; to keep the shape.
                </div>
              )}
            </div>
          )}
        </div>
      </Drawer>
    );
  }

  /** Canvas with nothing addressed — `target` was `null`, or named a flow or
   * template that is not (or no longer) in the list `deck:flows` posts. This
   * used to be `if (!flow) return null`, which is the exact dead end this
   * whole feature exists to remove: once Active and Templates learned to
   * render without a resolved flow (see `p.view !== "canvas"`'s own return,
   * above), a click on Canvas's own tab with nothing open was the one
   * remaining way to land on a blank drawer with no explanation and no way
   * out. `.orch-empty` is the exact same empty-state treatment the
   * Templates screen (above) and the empty graph (below, once a flow IS
   * open) both use — not a new one invented for this case.
   *
   * The three ways out are the three that already exist elsewhere in this
   * component, not new ones: pick an already-addressed workflow from
   * Active, start a fresh one ("+ New flow", the exact string the
   * flow-switcher row further down already spends — see FLOW_LEGITIMATE in
   * vocabulary.test.ts), or start a template from nothing ("＋ New
   * template…", wired the same way the Templates screen's own button
   * above is).
   *
   * `p.open === false` closes this exactly the way the flow-less
   * Active/Templates return (above) closes on it — required here for the
   * identical reason: `DeckApp`'s own Close button (and Cancel, and a
   * successful Save) clear `openFlowId` and `orchOpen` together but leave
   * `orchView` sitting on whatever it last was, which is "canvas" every
   * time a card's own workflow or a template was the thing just dismissed.
   * Without this check a plain, deliberate Close would leave THIS empty
   * state standing in the drawer's place rather than actually closing it —
   * a new, smaller dead end sitting where the old one used to be. */
  if (!flow) {
    if (p.open === false) return null;
    return (
      <Drawer surface="orch" label="Orchestrator" closing={closing} style={{ ["--orch-w" as any]: `${renderWidth}px` }}>
        {resizeGrip}
        <div className="orch-hd">{topRow}</div>
        <div className="orch-body">
          <div className="orch-empty">
            No workflow is open here. Pick one from{" "}
            <button type="button" className="orch-mini" onClick={() => p.onView("active")}>Active</button>,{" "}
            start a <button type="button" className="orch-mini" onClick={p.onCreate}>+ New flow</button>,{" "}
            or <button type="button" className="orch-mini" onClick={p.onNewTemplate}>＋ New template…</button>.
          </div>
        </div>
      </Drawer>
    );
  }

  /** How many nodes this flow HAS — every one the canvas draws, which is what the
   * header's and the footer's "N nodes" claim to count. It used to be
   * `kind !== "notify"`, a fossil from when non-notify meant place: six nodes drawn
   * and both counters saying five, from the day the command node shipped. */
  const nodeCount = flow.nodes.length;
  /** How many nodes an armed flow is WATCHING — a different question from how many
   * it has, and the only one "Armed · watching N nodes" is about. `isAgentNode` is
   * the same pair the tray admits, and for the same reason: a condition can only be
   * about a place on disk or work not yet launched. A command node is something a
   * rule points AT and a notify terminal is a toast, so neither is ever observed —
   * `evaluate.ts` reads a condition off a place's `RunStatus` and nothing else. */
  const watched = flow.nodes.filter(isAgentNode).length;
  /** The nodes a rule ACTS on rather than watches — a notify terminal or a command
   * node. Named by the two kinds it admits rather than as "not an agent node", the
   * same lesson `isAgentNode`'s own doc comment records: a `!==` filter is what let
   * a command node into a list that then read `.runKey` off it. */
  const actionNodes = flow.nodes.filter((n) => n.kind === "notify" || n.kind === "command" || n.kind === "gate");
  /** How many rules cannot advance. Driven by the edges' own `error` — the half of
   * `isSettled` that means "tried and failed" rather than "ran". An armed flow with
   * one of these is not simply watching, and the footer must not say it is. */
  const stalled = flow.edges.filter((e) => e.error !== undefined).length;
  /** How many of those stalls are a real FAILURE, as opposed to the store's
   * migration notice. Only this count may spend `--c-danger` (see the `.stalled`
   * class below), and the split exists because the alternative was one panel
   * making two severity claims about one edge: the inspector had just
   * deliberately refused to paint a migration notice red (see
   * `isMigrationNotice`), and eleven lines further down the footer's dot painted
   * it red anyway — so a user reads the footer, goes hunting for a failure, and
   * the inspector denies there was one.
   *
   * The SENTENCE still counts every stall, which is honest either way: a
   * migration-latched rule genuinely will not fire until Reset, and the footer
   * is the only place that says so at a glance. This is the same distinction
   * `.orch-resume`'s own comment already draws — "not a courtesy banner, not
   * red — nothing failed, a flow is waiting". */
  const failed = flow.edges.filter((e) => e.error !== undefined && !isMigrationNotice(e.error)).length;
  // Reported by the host on `deck:flows`, keyed by flow id — never a second
  // source of truth for whether rules are met, only for whether the user has
  // yet said "go" on what already is. `editingTemplate` short-circuits this
  // BEFORE the lookup, not just at the render site below: a template's own
  // inner flow has an empty `id` (`toTemplate` mints `id: ""`, templates.ts),
  // and an armed real workflow could in principle report a pending resume
  // keyed by that same empty string. A template has no ticket and nothing to
  // watch, so there is no resume gate to show regardless of what `pendingResume`
  // happens to contain — the rule holds even against a coincidental id match.
  const resume = editingTemplate ? null : (p.pendingResume.find((r) => r.flowId === flow.id) ?? null);

  /** Attaching binds a LIVE running card's repo into the graph as a `place`
   * node — permanently, by that one card's own `runKey`. That is the opposite
   * of what a template is for: a template's whole point is to be instantiated
   * against a DIFFERENT ticket every time (`instantiate` in templates.ts binds
   * a fresh `ticketKey` onto every `planned` node it copies), and a `place`
   * baked into the shape would still name today's card no matter which
   * ticket the template is later attached to. Refused here, at the one
   * function both the tray's drop and the keyboard picker's `onCommit` call
   * through — never at each call site — so a future third way to attach
   * inherits the refusal for free. */
  const attachAt = (raw: string, x: number, y: number) => {
    if (editingTemplate) return;
    const next = attached(flow, raw, x, y);
    if (next) p.onSave(next);
  };

  /** Attach several places in ONE save. Folding `attached` over its own result is
   * the whole point: each step sees the nodes the previous step added, so ids
   * come out distinct and the stack does not pile every new node at one `y`.
   * Calling `attachAt` in a loop instead would hand every iteration the same
   * captured `flow` and save N times, and only the last write would survive.
   *
   * A key that no longer attaches (already a place, or unparseable) is skipped
   * rather than aborting the batch — `attached` already owns that judgement, and
   * the picker's own candidate list excludes duplicates anyway. Same
   * template refusal as `attachAt`, and for the identical reason — see its
   * own comment. */
  const attachMany = (keys: string[]) => {
    if (editingTemplate) return;
    let next = flow;
    for (const raw of keys) {
      next = attached(next, raw, 24, 24 + next.nodes.length * 88) ?? next;
    }
    if (next !== flow) addAndSelect(next);
  };

  const removeNode = (id: string) => {
    // Both selections go, not just the node's own. Ids are re-minted to the lowest
    // free value (see `nextId`), so deleting `n2` and adding a node mints `n2` again
    // — and a stale `sel` would render that brand-new node pre-selected. The same
    // applies to `selEdge`: this delete drops every edge touching the node, and a
    // re-minted edge id would spontaneously open the inspector on a rule the user
    // never clicked.
    setSel(null);
    setSelEdge(null);
    p.onSave({
      ...flow,
      nodes: flow.nodes.filter((n) => n.id !== id),
      // An edge whose end is gone can never be evaluated, so it goes with it.
      edges: flow.edges.filter((e) => e.from !== id && e.to !== id),
    });
  };

  /** Selection is EXCLUSIVE: one connection or one node, never both. It was not,
   * and it did not matter while a node selection did nothing but add a CSS class —
   * `sel` and `selEdge` could both be set and the inspector simply always answered
   * to `selEdge`. Now that a selected node opens the inspector in its own right,
   * two live selections would mean two panels' worth of controls competing for one
   * slot (and two controls sharing one aria-label), with the older selection
   * silently winning. So each setter clears the other, in one pair of functions
   * rather than at each of the four call sites that select something. */
  const selectNode = (id: string) => {
    setSel(id);
    setSelEdge(null);
  };

  const selectEdge = (id: string) => {
    setSelEdge(id);
    setSel(null);
  };

  const startDrag = (id: string, e: React.PointerEvent) => {
    const node = flow.nodes.find((n) => n.id === id);
    if (!node) return;
    const box = graphRef.current?.getBoundingClientRect();
    selectNode(id);
    setDrag({
      id,
      dx: e.clientX - (box?.left ?? 0) - node.x,
      dy: e.clientY - (box?.top ?? 0) - node.y,
      x: node.x,
      y: node.y,
    });
  };

  /** Where a node is right now — the in-flight drag position if it is the one
   * being dragged, else the model's. */
  const posOf = (n: { id: string; x: number; y: number }) =>
    drag && drag.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y };

  /** A node's live box for the anchor maths: its in-flight position, and its real
   * width. The width is a true fact about the model — see `NOTIFY_W` — but is
   * currently unobservable: a notify node is never a wiring's source, so this
   * conditional never affects a rendered edge today. It stays, correctly, for
   * the day a terminal gains an out-port. */
  const boxOf = (n: { id: string; x: number; y: number; kind: string }) => {
    const pos = posOf(n);
    return {
      x: pos.x, y: pos.y,
      w: n.kind === "notify" ? NOTIFY_W : NODE_W,
      // Height switches per kind for the same reason width already does. This one
      // line covers edge anchoring, the obstacle list `tidy` routes around, and
      // the clipped-right check — every consumer goes through this function.
      h: n.kind === "gate" ? GATE_H : NODE_H,
    };
  };

  /** A new rule carries NO stored action at all — not even the one its target
   * implies. The action is derived from the target now (`edgeAction`), and
   * `store.ts`'s `latchActionMismatches` latches any edge whose STORED action
   * disagrees with that derivation; an edge with no stored value is the one
   * shape it can never latch. This used to hardcode `action: "notify"`
   * regardless of the target's kind, which made an ordinary place→planned
   * wiring a mismatch on the very next read: stamped with an error, settled,
   * and — before Task 3's Reset fix — unrepairable. Recording the DERIVED
   * value instead would be correct today and still stores a second copy of a
   * fact the node owns, which is the thing this phase removed.
   *
   * Nothing is lost on disk: `writeFlow` writes `e.action ?? derived`, so the
   * file an older build reads still carries the field its `validEdge`
   * requires (see that function's own doc comment).
   *
   * KNOW THE BOUNDARY, because it is not a property of the shape: an actionless
   * edge is unlatchable only IN MEMORY. `writeFlow` persists the derived value,
   * so the moment this flow is saved the edge does carry a stored action on
   * disk — and a stored action is what `latchActionMismatches` compares. So a
   * stored value only stays in agreement while nothing changes what the edge
   * points at OR what that target IS. Neither presentation can RETARGET an
   * existing edge (no endpoint drag on the canvas, no "To node" select on a rule
   * that already exists, only delete-and-rewire, which mints a fresh actionless
   * edge) — but a target's KIND does change under a live flow, in exactly one
   * place: `promoteToPlace` (promote.ts) rewrites a launched `planned` node into
   * a `place` with the same id, which flips every edge into it from `launch` to
   * `seed`. That is ours, not the user's, and it is why promotion clears
   * `action` on every one of those edges itself — the same thing
   * `flow:resetEdge` does, for the same reason. Anyone adding a retarget
   * affordance, or a second rewrite of a node's kind, owes the retargeted edges
   * the identical clear. */
  const finishWire = (toId: string) => {
    const from = wiring;
    setWiring(null);
    if (!from || from === toId) return;
    if (flow.edges.some((e) => e.from === from && e.to === toId)) return;
    const id = nextEdgeId(flow);
    const edge: FlowEdge = { id, from, to: toId, cond: defaultCondFor(flow, from) };
    selectEdge(id);
    p.onSave({ ...flow, edges: [...flow.edges, edge] });
  };

  /** Add a node and SELECT it, so the inspector below opens on the thing that was
   * just created rather than on nothing. This is the whole shape of the defect
   * this fixes: the picker created a node whose own configuration had no home in
   * the UI until a rule pointed at it, so "add" and "configure" were separated by
   * "wire it up first". Selecting the new node is what closes that gap without the
   * user having to guess that a node is selectable at all.
   *
   * The id comes from the SAVED flow's last node rather than from a second
   * `nextNodeId(flow)` call beside the builder's own: two calls agreeing today is
   * an accident waiting to end, and the builders all append. */
  const addAndSelect = (next: Flow) => {
    const added = next.nodes[next.nodes.length - 1];
    if (added) selectNode(added.id);
    p.onSave(next);
  };

  const addNotify = () =>
    addAndSelect({
      ...flow,
      nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "notify", x: 320, y: 24, join: "any", message: "say something" }],
    });

  const addGate = () =>
    addAndSelect({
      ...flow,
      nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "gate", x: 320, y: 24, join: "any", question: "ok to continue?" }],
    });

  // Unlike every other node this drawer builds, a `planned` node ordinarily
  // cannot be assembled here: it names a ticket, and the webview has no task
  // connector to ask for one — it must not import `fs`/`os`/`path`/
  // `child_process`, even transitively, and a connector reaches all four. So
  // the ordinary path sends only the flow's own id; the host runs the actual
  // picker (a sequence of native QuickPicks) and appends the whole node in
  // one write. See deckView.ts's `addPlanned`.
  //
  // A template draft is the one case that cannot go through that host round
  // trip: its inner `flow.id` is `""` (`mintDraftTemplate`'s own doc
  // comment), and `readFlows(...).find(f => f.id === "")` on the host side
  // can never find it — a click here would authenticate the connector, run
  // four QuickPicks, and then silently do nothing. A template's planned node
  // has no ticket to look up anyway (`instantiate` fills `ticketKey`/`repos`/
  // `mode` in at attach time, the same fallback `mintDraftTemplate` relies
  // on), so this mints the node locally with exactly the blank shape
  // `mintDraftTemplate` seeds, the same way `addNotify`/`addGate` already
  // mint their own nodes without a host round trip.
  const addPlanned = () => {
    if (editingTemplate) {
      addAndSelect({
        ...flow,
        nodes: [
          ...flow.nodes,
          { id: nextNodeId(flow), kind: "planned", x: 320, y: 24, join: "any", ticketKey: "", repos: [], mode: "", dest: "worktree" },
        ],
      });
      return;
    }
    send({ type: "flow:addPlanned", id: flow.id });
  };

  /** Open the Save-as-template dialog, seeded with one row per place this
   * save will have to demote. Prefilled, never invented: the configured
   * default prompt mode (the same `promptModes[0]?.id` fallback flowList.tsx
   * already uses for a fresh rule) and `worktree`, both visible and both
   * changeable before Save — see `placesToDemote`'s own doc comment in
   * templates.ts for why a guessed destination is the one thing this dialog
   * must never do quietly. The name field starts BLANK, not `flow.name`: a
   * template is its own saved thing, and prefilling it with the workflow's
   * current name would make "Ship it" (workflow) and "Ship it" (template)
   * look identical in a list where only one of them can ever be armed. */
  const openSaveTemplate = () => {
    const seed: Record<string, { mode: string; dest: LaunchDest }> = {};
    for (const n of placesToDemote(flow)) {
      seed[n.id] = { mode: p.promptModes[0]?.id ?? "", dest: "worktree" };
    }
    setTemplateChoices(seed);
    setTemplateName("");
    setSavingTemplate(true);
  };

  const setTemplateMode = (nodeId: string, mode: string) =>
    setTemplateChoices((c) => ({ ...c, [nodeId]: { mode, dest: c[nodeId]?.dest ?? "worktree" } }));

  const setTemplateDest = (nodeId: string, dest: LaunchDest) =>
    setTemplateChoices((c) => ({ ...c, [nodeId]: { mode: c[nodeId]?.mode ?? (p.promptModes[0]?.id ?? ""), dest } }));

  /** One `DemotionChoice` per place, read from this dialog's own state rather
   * than re-derived — `placesToDemote(flow)` is read again here (not memoised
   * from `openSaveTemplate`) because the flow itself can change while the
   * dialog is open (canvas edits keep writing through `p.onSave`), and a
   * choice keyed by node id survives that: a node added after the dialog
   * opened gets the same seeded default the row's own render already shows,
   * never a missing entry `toTemplate` would then throw on. */
  const submitSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    const choices: DemotionChoice[] = placesToDemote(flow).map((n) => ({
      nodeId: n.id,
      mode: templateChoices[n.id]?.mode ?? (p.promptModes[0]?.id ?? ""),
      dest: templateChoices[n.id]?.dest ?? "worktree",
    }));
    send({ type: "flow:saveTemplate", id: flow.id, name, choices });
    setSavingTemplate(false);
  };

  /** Add one command node per ticked entry, in ONE save. Same fold, same reason
   * as `attachMany`: `addCommandNode` mints its id and its `y` from the flow it
   * is handed, so each step has to see the previous step's node or two commands
   * added together would collide on both. `addAndSelect` then opens the
   * inspector on the LAST of them.
   *
   * Unlike a `planned` node this needs no host round trip — `agentFlow.commands`
   * is already here as a prop — so it goes through `onSave` like every other
   * node this drawer builds. */
  const addCommands = (ids: string[]) => {
    let next = flow;
    for (const id of ids) next = addCommandNode(next, { commandId: id });
    if (next !== flow) addAndSelect(next);
  };

  /** The one-off: a command that isn't worth naming in settings. Lands as an
   * empty `run` for the node inspector to fill in, which is why it is an ACTION
   * in the picker's footer rather than a tickable row — there is nothing to
   * batch, and ticking it alongside two configured commands would ask what
   * "three commands, one of them blank" means. */
  const addFreeTextCommand = () => addAndSelect(addCommandNode(flow, { run: "" }));

  /** The picker itself, rendered on both the canvas's Graph bar and the list
   * view's Add bar — one element, two call sites, because a node kind reachable
   * from only one of the two views is the gap Task 6 closed for a place and
   * this task must not reopen for a command.
   *
   * A `MultiCombo` rather than the `<select>` this used to be: a select creates
   * exactly one node per trip, so the feature's own headline example (stage a
   * deploy, then a smoke test) meant opening the same menu twice, and it offered
   * no way to find a command by typing once settings hold more than a handful.
   * The empty-state line is a line to READ, not an option — the sentinel value a
   * disabled `<option>` needed (`COMMAND_NONE`) has no counterpart here, because
   * the combo has no value channel to smuggle it through. */
  const addCommandPicker = (
    <MultiCombo
      trigger="+ Add command…"
      ariaLabel="Add a command"
      searchPlaceholder="Filter commands…"
      options={p.commands.map((c) => ({ value: c.id, label: c.label, detail: c.detail }))}
      // For a user who has explicitly cleared `agentFlow.commands` to `[]`. The
      // shipped default holds one example, so an untouched install never sees it.
      emptyLabel={COMMAND_NONE_LABEL}
      onCommit={addCommands}
      extra={{ label: "Free-text command…", onPick: addFreeTextCommand }}
    />
  );

  const onTidy = () => p.onSave({ ...flow, nodes: tidy(flow) });

  const edge = flow.edges.find((e) => e.id === selEdge) ?? null;
  /** What the selected rule DOES — derived from the node it points at, never
   * read off `edge.action`. Computed once here, not inline in the JSX below,
   * because it needs `edge` narrowed to non-null (which the ternary in the
   * render already does) and a `const` cannot be declared mid-JSX-expression.
   *
   * `undefined` means a missing target, or a node kind this build does not
   * know — `store.ts`'s `validNode` admits an unknown kind on purpose so a
   * flow written by a newer build still renders. Every read below treats that
   * as "cannot say" rather than falling through to a wrong verb. */
  const derived = edge ? edgeAction(flow, edge) : undefined;
  /** The destination select's value, resolved without a non-null assertion:
   * this is only ever rendered once `derived` is `launch`, which guarantees a
   * planned target exists — but nothing in the type system knows that at the
   * render site, so the fallback is purely to satisfy `LaunchDest`'s type,
   * never a value the user can see. */
  const launchDest = edge ? launchDestOf(flow, edge) : undefined;
  /** The Mode select's value. A launch's mode lives on its target planned
   * node (never on the edge — see `withMode`'s own doc comment in
   * orchestratorRule.ts); a seed's lives on the edge, because a place has no
   * mode field of its own. */
  const modeValue = edge ? modeValueOf(flow, edge) : "";
  /** Does `modeValue` name a mode that still exists? A `<select>` whose `value`
   * matches none of its `<option>`s does not render blank — the browser falls
   * back to showing its FIRST option, selected, while the store still holds the
   * deleted (or never-set) id. That is not a rendering detail: `modeFor` refuses
   * to launch with a mode that is not configured, so the drawer would show a
   * mode that will run while the flow is actually about to error. See the extra
   * `<option>` this gates, below. */
  const modeExists = modeValue !== "" && p.promptModes.some((m) => m.id === modeValue);
  /** The selected rule's target command node, when it has one, and what its two
   * controls read — through `commandFieldsOf`, the same function the node
   * inspector below and the list's own row spend, so one node cannot be described
   * three ways. */
  const commandNode = edge ? commandTargetOf(flow, edge) : undefined;
  const cmd = commandFieldsOf(commandNode, p.commands);
  /** Every checkout the board can see, for the two repo pickers on this surface:
   * a `branch-ci-passed` rule's repo half and a command node's `cwdRepo`. Derived
   * once here rather than at each `<select>`, so the two cannot offer different
   * lists — and so the sort runs once per render instead of twice. */
  const boardRepos = repoOptions(p.runs);
  /** The selected rule's condition parameters, or `null` when its kind carries
   * none. `isBareCond`, not a truthiness check on the element: `CondParams`
   * renders `null` for a bare kind, but CALLING it as a component yields an
   * element regardless, so the caller cannot learn from the result whether there
   * is a row to draw. The predicate is what `withCond`'s own seeding switch
   * splits on, which is what keeps the two in step. */
  const condParams = edge && !isBareCond(edge.cond.kind) ? (
    <CondParams
      cond={edge.cond}
      repos={boardRepos}
      editKey={edge.id}
      onEdit={(patch) => p.onSave(withCondParams(flow, edge.id, patch))}
    />
  ) : null;

  /** The node the inspector answers to when NO connection is selected — a
   * command node's command and a notify node's message are the node's own data
   * (`withNodeCommandId`, `withNodeNotifyMessage`), and until now the only
   * controls that wrote them were keyed on an edge, so a node had to be wired
   * into a rule before it could be configured at all.
   *
   * A place or a planned node now opens it too, but ONLY as a junction: neither
   * has a field of its own this panel edits (a launch's mode and destination are
   * set on the rule that spends them), so the one thing there is to say about one
   * is what its several incoming rules mean together. `nodeJoins` below is that
   * test, and it is what keeps a one-in place node on the empty state rather than
   * opening a panel with nothing in it. */
  const inspNode = !edge && sel ? flow.nodes.find((n) => n.id === sel) : undefined;
  /** Is this node a JUNCTION — somewhere two or more rules meet? The model is
   * explicit that a node with fewer than two incoming edges is unaffected by its
   * `join` (see `JoinMode`), so this is what decides whether the control below
   * exists at all. Rendering it always would put a `<select>` on screen whose
   * every value provably changes nothing, which is the same objection this file
   * already spends four paragraphs on for the action `<select>` it deleted. */
  const nodeJoins = inspNode !== undefined && incomingEdges(flow, inspNode.id).length > 1;
  const nodeInsp =
    inspNode && (inspNode.kind === "command" || inspNode.kind === "notify"
      || inspNode.kind === "gate" || nodeJoins) ? inspNode : undefined;
  /** How the node inspector names the node it is about — the same `endLabel`
   * every other surface names it with. Also what its controls' aria-labels are
   * scoped by: "Command", bare, is the edge inspector's and an open list row's
   * label, and both can be on screen at the same time as this panel (an open row
   * in the list view, right beside it). One accessible name for two controls is
   * an ambiguity a screen reader cannot resolve — and would break a query for
   * either. */
  const nodeInspName = nodeInsp ? endLabel(flow, nodeInsp.id) : "";
  const nodeCmd = commandFieldsOf(nodeInsp?.kind === "command" ? nodeInsp : undefined, p.commands);
  /** The configured command whose `run` is character-for-character this node's own
   * (trimmed, since that is what the host stores and compares). Its presence is
   * what turns the Save row into "already saved" — matched on the COMMAND, not on
   * a name, because the same command under a second name is the duplicate the host
   * refuses to write. */
  const savedCommand =
    nodeCmd.run !== undefined && nodeCmd.run.trim() !== ""
      ? p.commands.find((c) => c.run.trim() === nodeCmd.run!.trim())
      : undefined;

  const setCond = (e: FlowEdge, kind: Condition["kind"]) => {
    const next = withCond(flow, e.id, kind);
    // `withCond` returns `flow` itself (the same reference) for the two
    // parameterised kinds the dropdown never offers — see its own doc
    // comment. Checking identity here, rather than re-deriving the guard,
    // is what keeps that one rule living in exactly one place.
    if (next !== flow) p.onSave(next);
  };

  const setMode = (e: FlowEdge, mode: string) => p.onSave(withMode(flow, e, mode));

  const setDest = (e: FlowEdge, dest: LaunchDest) => p.onSave(withDest(flow, e, dest));

  const setNotifyMessage = (e: FlowEdge, message: string) => p.onSave(withNotifyMessage(flow, e, message));

  const setNote = (e: FlowEdge, note: string) => p.onSave(withNote(flow, e, note));

  /** One handler for the Command select's two kinds of choice: the free-text
   * sentinel puts the node into the free-text shape with nothing typed yet
   * (`run: ""`, which `resolveCommand` refuses to execute), anything else names
   * a configured command. Each writer clears the other's field, so the node can
   * never reach the "carries both" shape `resolveCommand` refuses. */
  const setCommand = (e: FlowEdge, value: string) =>
    p.onSave(value === COMMAND_FREE_TEXT ? withCommandRun(flow, e, "") : withCommandId(flow, e, value));

  /** The same choice, made about a SELECTED NODE rather than about the node a
   * selected rule points at. Deliberately the node-keyed pair of the very same
   * writers `setCommand` above calls through (`withCommandId` is one line of
   * `withNodeCommandId`), which is what makes "both paths write the same node
   * fields" a property of the code rather than a promise: there is one
   * implementation of each write, and this reaches it by node id directly instead
   * of via `edge.to`. */
  const setNodeCommand = (nodeId: string, value: string) =>
    p.onSave(
      value === COMMAND_FREE_TEXT
        ? withNodeCommandRun(flow, nodeId, "")
        : withNodeCommandId(flow, nodeId, value),
    );

  const deleteEdge = (e: FlowEdge) => {
    setSelEdge(null);
    p.onSave(withoutEdge(flow, e.id));
  };

  /** What `<FlowList>` writes through, below. `removeNode` (above) already
   * clears `selEdge` before deleting a node and every edge touching it — the
   * exact same hazard `nextId`'s re-minting creates: delete a node/edge, add
   * one back, and the LOWEST free id (the one just freed) gets re-minted, so
   * a stale `selEdge`/`sel` would point at whatever brand-new thing happens
   * to land on that id. `deleteEdge` guards the canvas's own Delete button
   * for the identical reason. But `FlowList`'s own Delete key calls `onSave`
   * DIRECTLY — this file's own `p.onSave` prop, not `deleteEdge` — so a rule
   * selected on the canvas, then deleted from the List view, left `selEdge`
   * unguarded: switch back to Canvas, add a rule (re-minting that same
   * freed id), and the inspector opens on a rule nobody clicked. Checked
   * generically, by whether `selEdge` still names an edge in the flow ABOUT
   * to be saved, rather than only for the one call site (`onDeleteRule`)
   * known to remove edges today — the same guard then also covers whatever
   * future control in `FlowList` removes an edge some other way. */
  const onListSave = (next: Flow) => {
    if (selEdge && !next.edges.some((e) => e.id === selEdge)) setSelEdge(null);
    p.onSave(next);
  };

  /** `.orch-body`'s own left+right padding (16px each, see orchestratorStyles.ts)
   * plus `.orch-graph`'s own 1px border on each side — the fixed horizontal
   * cost between the drawer's own width and the graph's actual content box.
   * A formula, not a measurement: `graphRef.current?.getBoundingClientRect()`
   * is genuinely 0×0 under jsdom (every other use of that ref in this file
   * already works around the same fact — see `startDrag`'s and the drop
   * handlers' own comments), so a DOM-measured width would make this cue
   * untestable rather than merely imprecise. `renderWidth` already IS the
   * one true width — resize and Expand both write into it — so deriving the
   * graph's inner width from it, once, is exact today and stays exact the
   * day either changes without this cue silently going stale. */
  const GRAPH_H_INSET = 34;
  /** Does any node's own right edge fall past the graph's visible width? Not
   * "is the drawer narrow" — a flow with every node comfortably left of the
   * fold is not clipping anything just because the drawer itself is narrow,
   * and resize/Expand already exist for the case where nodes genuinely don't
   * fit. This is the one thing resize and Expand fix the FITTING of but not
   * the SILENCE of (see this file's own task brief): a clipped node with no
   * cue at all that anything is hidden. */
  const clippedRight = flow.nodes.some((n) => posOf(n).x + boxOf(n).w > renderWidth - GRAPH_H_INSET);

  /** What a gate node currently is, from the flow alone. `undefined` for every
   * other kind. The performer is found the same way `gateAnswer` (evaluate.ts)
   * finds it — by `performed`, never by `firedAt` alone — so the canvas and the
   * engine can never disagree about which edge posed the question. */
  const gateStateOf = (n: FlowNode): { asked: boolean; answer?: "approved" | "rejected"; edgeId?: string } | undefined => {
    if (n.kind !== "gate") return undefined;
    const performer = flow.edges.find((e) => e.to === n.id && e.performed === true && e.firedAt !== undefined);
    if (!performer) return { asked: false };
    return { asked: true, answer: performer.gateAnswer, edgeId: performer.id };
  };

  const answerGate = (edgeId: string, answer: "approved" | "rejected") =>
    send({ type: "flow:answerGate", id: flow.id, edgeId, answer });

  /** The question, prefixed by the verdict once there is one. The question stays
   * visible in every state on purpose: a node that showed only "approved" would
   * make you select it to find out what you had approved. */
  const gateBody = (n: GateNode, st: ReturnType<typeof gateStateOf>): string =>
    st?.answer ? `${st.answer} — ${n.question}` : n.question;

  /** Rejected is `--dim`, NOT `--c-danger`. Red on a card means something is
   * broken; a rejection is a decision you made. `--c-attn` is the same amber
   * `STATE_HUE` already spends on "needs-you", which is exactly what an
   * unanswered gate is. */
  const gateHue = (st: ReturnType<typeof gateStateOf>): string =>
    st?.answer === "approved" ? "var(--c-done)"
      : st?.asked && !st.answer ? "var(--c-attn)"
      : "var(--dim)";

  /** The nodes a rule ACTS on, and — new here — the way to SELECT one. Written
   * once and rendered by BOTH views, rather than left in the canvas branch where
   * it was: the list view is the keyboard path, its rows are one per RULE, and a
   * node that no rule points at yet appears in none of them. Without this section
   * the list could create a command node (its own Add bar does) and then offer no
   * way to configure it — precisely the gap this fix is about, reopened for
   * keyboard users only.
   *
   * The identifier is a `<button>` for that reason: it is a real, natively
   * focusable Tab stop in both views, so reaching a node's own configuration never
   * requires a pointer on a div-and-pointer-events canvas. */
  const actionsSection = actionNodes.length > 0 ? (
    <div className="orch-sect">
      <div className="orch-sect-hd">
        <span className="t">Actions</span>
        <span className="rule" />
      </div>
      <div className="orch-tray" data-testid="orch-actions">
        {actionNodes.map((n) => (
          <span className={`orch-tchip${sel === n.id ? " on" : ""}`} key={n.id}>
            {/* `endLabel`, the same function the canvas chip and both rule
                sentences spend, so one node is never named two ways.
                `aria-pressed` is the App.tsx idiom for on/off state (its
                filter/size/status groups all use it), and the accessible name
                says what pressing does rather than repeating the identifier
                alone. */}
            <button
              type="button"
              className="k"
              aria-pressed={sel === n.id}
              aria-label={`Configure ${endLabel(flow, n.id)}`}
              onClick={() => selectNode(n.id)}
            >
              {endLabel(flow, n.id)}
            </button>
            <span className="sub">
              {n.kind === "notify" ? n.message
                : n.kind === "gate" ? gateBody(n, gateStateOf(n))
                : "runs a command"}
            </span>
            {(() => {
              const st = gateStateOf(n);
              // List-only: the canvas node itself carries its own Approve/Reject
              // (see the `.gbtns` block in the node render below), so the tray
              // must not offer a second, simultaneous pair for the same gate in
              // canvas view. List has no graph node to click, so the tray chip
              // is its only route to answering at all.
              if (n.kind !== "gate" || canvasView !== "list" || !st?.asked || st.answer || !st.edgeId) return null;
              const edgeId = st.edgeId;
              return (
                <>
                  <button type="button" className="gbtn ok"
                    aria-label={`Approve ${n.question}`}
                    onClick={() => answerGate(edgeId, "approved")}>Approve</button>
                  <button type="button" className="gbtn"
                    aria-label={`Reject ${n.question}`}
                    onClick={() => answerGate(edgeId, "rejected")}>Reject</button>
                </>
              );
            })()}
            <button
              type="button"
              className="rm"
              aria-label={`Remove ${endLabel(flow, n.id)}`}
              onClick={() => removeNode(n.id)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  ) : null;

  /** The inspector, opened on a selected NODE rather than on a rule. The fields
   * are the node's own (`withNodeCommandId`/`withNodeCommandRun`/
   * `withNodeNotifyMessage`) — the same writers the edge inspector reaches through
   * `edge.to`, called here by id — so the two paths cannot disagree about what
   * they set. There is no note row and no condition row: a note lives on the EDGE
   * (`withNote`), and a node has no condition.
   *
   * Rendered by both views. On the canvas it replaces the empty state whenever a
   * command or notify node is selected and no rule is; in the list it sits under
   * the Actions section whose buttons select one. */
  const nodeInspector = nodeInsp ? (
    <div className="orch-insp" data-testid="orch-node-inspector">
      <div className="t">
        <span>
          {NODE_KIND_LABEL[nodeInsp.kind] ?? "Node"}
          {/* The identifier, exempt from this row's uppercase (see
              `.orch-insp .t .k`): a free-text command is case-sensitive shell
              text, and "DEPLOY.SH --ENV=STAGING" is not the command that runs.
              A notify node has no identifier to print — its message is prose,
              which this row would shout — so the kind word stands alone, and
              `endLabel` returns the bare word "notify" for it, which repeated
              here would read as "Notify · notify". A place and a planned node
              each have one (a run key, a ticket key) and it is the only way to
              tell two junctions apart. */}
          {nodeInsp.kind !== "notify" && (
            <>
              {" · "}
              <span className="k" style={{ fontFamily: "var(--mono)" }}>{nodeInspName}</span>
            </>
          )}
        </span>
      </div>
      {nodeInsp.kind === "command" ? (
        <>
          <div className="orch-clause">
            <span className="orch-kw">RUNS</span>
            <select
              className="orch-sel"
              aria-label={`Command for ${nodeInspName}`}
              value={nodeCmd.value}
              onChange={(ev) => setNodeCommand(nodeInsp.id, ev.currentTarget.value)}
            >
              {/* The same extra option the edge inspector renders, for the same
                  reason: a `<select>` whose value matches none of its options
                  shows its FIRST one instead, so a node naming a command that is
                  not (or no longer) configured would read as one that is. */}
              {!nodeCmd.idExists && (
                <option value={nodeCmd.value}>
                  {nodeCmd.value === "" ? COMMAND_NOT_SET : `${nodeCmd.value} (not configured)`}
                </option>
              )}
              {p.commands.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
              <option value={COMMAND_FREE_TEXT}>Free-text command…</option>
            </select>
          </div>
          {/* THE field this whole fix exists for: shown whenever the node is IN
              the free-text shape (`run` present, even blank), which is exactly
              what "Free-text command…" creates. Before this it rendered only
              inside the edge inspector, so a node with no rule pointing at it had
              nowhere to type at all. */}
          {nodeCmd.run !== undefined && (
            <div className="orch-clause">
              <span className="orch-kw" />
              <input
                className="orch-msg"
                aria-label={`Command to run for ${nodeInspName}`}
                key={nodeInsp.id}
                ref={runRef}
                defaultValue={nodeCmd.run}
                placeholder="deploy.sh --env=staging"
                onBlur={(ev) => p.onSave(withNodeCommandRun(flow, nodeInsp.id, ev.currentTarget.value))}
              />
            </div>
          )}
          {/* Keeping a one-off. Offered only for a command that is actually free
              text and actually typed — there is nothing to save about a blank
              field, and a node already naming a configured command is already
              saved. Lives HERE, in the node's own panel, rather than beside all
              three places a command can be typed: the Actions tray selects a node
              from either view, so this is reachable from both without three copies
              of the same affordance.
              Once the run text matches an entry in `agentFlow.commands`, the row
              gives way to a line saying so — the honest end state, and the reason
              pressing Save twice cannot fill the picker with duplicates. */}
          {nodeCmd.run !== undefined && nodeCmd.run.trim() !== "" && (
            savedCommand ? (
              <div className="orch-savedline" data-testid="orch-command-saved">
                Saved in settings as “{savedCommand.label}”
              </div>
            ) : (
              <SaveCommandRow key={nodeInsp.id} runNow={() => runRef.current?.value ?? nodeCmd.run ?? ""} />
            )
          )}
          {/* Which checkout the command runs in. Last of the command's own rows,
              because it is the qualifier on everything above it rather than a
              fact of its own — "run deploy.sh, in the payments-api checkout".

              Its first option is the model's DEFAULT, not a repo: absent
              `cwdRepo` means "the repo of the place the incoming edge came
              from", which is the common case and the one that needs no
              configuration (see `CommandNode.cwdRepo`). Naming that default out
              loud is what makes it choosable again — `withNodeCwdRepo` deletes
              the field for `""` rather than storing one. */}
          <div className="orch-clause">
            <span className="orch-kw">IN</span>
            <select
              className="orch-sel"
              aria-label={`Repo for ${nodeInspName}`}
              value={nodeInsp.cwdRepo ?? ""}
              onChange={(ev) => p.onSave(withNodeCwdRepo(flow, nodeInsp.id, ev.currentTarget.value))}
            >
              <option value="">{CWD_REPO_DEFAULT}</option>
              <RepoOptions value={nodeInsp.cwdRepo ?? ""} repos={boardRepos} />
            </select>
          </div>
        </>
      ) : nodeInsp.kind === "notify" ? (
        <div className="orch-clause">
          <span className="orch-kw">SAYS</span>
          <input
            className="orch-msg"
            aria-label={`Message for ${nodeInspName}`}
            key={nodeInsp.id}
            defaultValue={nodeInsp.message}
            onBlur={(ev) => p.onSave(withNodeNotifyMessage(flow, nodeInsp.id, ev.currentTarget.value))}
          />
        </div>
      ) : nodeInsp.kind === "gate" ? (
        <>
          <div className="orch-clause">
            <span className="orch-kw">ASKS</span>
            <input
              className="orch-msg"
              aria-label={`Question for ${nodeInspName}`}
              key={nodeInsp.id}
              defaultValue={nodeInsp.question}
              onBlur={(ev) => p.onSave(withNodeGateQuestion(flow, nodeInsp.id, ev.currentTarget.value))}
            />
          </div>
          {(() => {
            const st = gateStateOf(nodeInsp);
            if (!st?.answer || !st.edgeId) return null;
            const edgeId = st.edgeId;
            return (
              <div className="orch-clause">
                <span className="orch-kw">ANSWERED</span>
                <span>{st.answer}</span>
                <button type="button" className="orch-mini"
                  onClick={() => p.onResetEdge(flow.id, edgeId)}>
                  Reset to ask again
                </button>
              </div>
            );
          })()}
        </>
      ) : null}
      {/* What several incoming rules mean where they meet. Last, after whatever
          the node's own kind had to say, because it is a fact about the WIRING
          rather than about the node — and it is the only row a place or a
          planned node ever shows, which is why those kinds open this panel at
          all now (see `nodeJoins`).

          Rendered only for a real junction. The model is explicit that a node
          with fewer than two incoming edges is unaffected by its `join`, and a
          control that provably changes nothing is the thing this file already
          deleted an action `<select>` over. */}
      {nodeJoins && (
        <div className="orch-clause">
          <span className="orch-kw">JOINS</span>
          <select
            className="orch-sel"
            aria-label={`Join for ${nodeInspName}`}
            value={nodeInsp.join}
            onChange={(ev) => p.onSave(withNodeJoin(flow, nodeInsp.id, ev.currentTarget.value as JoinMode))}
          >
            {(Object.keys(JOIN_LABEL) as JoinMode[]).map((j) => (
              <option key={j} value={j}>{JOIN_LABEL[j]}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  ) : null;

  return (
    <Drawer
      surface="orch"
      label="Orchestrator"
      closing={closing}
      style={{ ["--orch-w" as any]: `${renderWidth}px` }}
    >
      {/* Shared with the flow-less (Active/Templates) return above — see
          `resizeGrip`'s own doc comment for the ARIA shape and why it is
          hidden rather than disabled while expanded. */}
      {resizeGrip}
      <div className="orch-hd">
        {/* `topRow` (shared with the flow-less return above) is the three
            top-level screens plus Expand/Close. `view` is `DeckApp`'s state,
            not local: the two header buttons `DeckApp` adds land here the
            same way a click on one of the three tabs does. */}
        {topRow}
        {p.view === "canvas" && (
          <>
            {/* The keyboard path onto this same flow: a canvas built from divs and
                pointer events has no usable keyboard story on its own (see
                flowList.tsx's own header comment), so List is not a second editor,
                it is the other way to reach the one this drawer already has.
                `role="tablist"`/`role="tab"`/`aria-selected` is App.tsx's own idiom
                for exactly this shape (see its Tasks/Notepad tabbar) — followed
                here rather than invented fresh. Quiet `orch-mini` styling, same as
                every neighbouring control on this header: Arm alone is filled. */}
            <div className="row" style={{ marginTop: 6 }}>
              <span role="tablist" aria-label="Flow view" style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={canvasView === "canvas"}
                  className="orch-mini"
                  onClick={() => setCanvasView("canvas")}
                >
                  Canvas
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={canvasView === "list"}
                  className="orch-mini"
                  onClick={() => setCanvasView("list")}
                >
                  List
                </button>
              </span>
            </div>
            {/* The flow switcher: pick another open flow, start a new one, or
                delete this one — the old "Flows · N ▾" disclosure's own job,
                moved here and left open rather than behind a click, now that
                Templates has its own top-level screen and no longer shares
                this panel with it. Deleting closes the WHOLE drawer rather
                than merely leaving Canvas, same as it always has: the host's
                `deck:flows` post would arrive and close it a round trip later
                anyway, and a drawer painting a deleted flow in the meantime
                is a lie. A separate row from Save-as-template/Arm below on
                purpose — see that row's own test for why sharing a parent
                with either would be the wrong claim.

                Hidden while `editingTemplate`: every control here is a bare
                `Flow` object's own verb — switch to another OPEN FLOW, start
                one, delete this one — and a template's inner flow is none of
                those things; it has no membership in `p.flows` at all (a
                template lives in `p.templates`, or, for the draft, nowhere
                `deck:flows` reaches yet — see `draftTemplate`'s own doc
                comment), so `p.onDelete(flow.id)` here would ask the host to
                delete a flow id that is either someone else's or nothing on
                disk at all. */}
            {!editingTemplate && (
              <div className="row" style={{ marginTop: 6 }}>
                {p.flows.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    className="orch-mini"
                    aria-pressed={f.id === flow.id}
                    onClick={() => p.onOpen(f.id)}
                  >
                    {f.name}
                  </button>
                ))}
                <button type="button" className="orch-mini" onClick={p.onCreate}>+ New flow</button>
                <div className="sp" />
                <button
                  type="button"
                  className="orch-mini"
                  onClick={() => { p.onDelete(flow.id); p.onClose(); }}
                >
                  Delete flow
                </button>
              </div>
            )}
            {/* Rename on blur, not per keystroke: every keystroke would be a disk
                write and a re-post, and the field would fight the re-render.
                The SAME field doubles as the template's own name while
                `editingTemplate` — `flow:writeTemplate`'s `name` (below) reads
                it straight off `flow.name` — rather than a second input with
                a second piece of state: `p.onRename` sends `flow:rename`,
                which only ever finds a `Flow` already on disk (the same
                membership check `flow:save` makes), so it cannot be what
                names a template. `p.onSave` already IS the draft's own edit
                path (see `DeckApp`'s doc comment on that prop) — a plain
                object-spread rename is nothing more than one more field
                changing on the same graph. `key={openKey}` (not `flow.id`,
                which is always `""` for EVERY template's inner flow — see
                `normalizedTemplateFlow`) so this remounts, and its
                uncontrolled value resets, across two different templates or
                two separate drafts rather than carrying the last one's typed
                text into the next. */}
            <input
              className="orch-name"
              aria-label="Flow name"
              defaultValue={flow.name}
              key={openKey}
              onBlur={(e) => {
                const next = e.currentTarget.value.trim();
                if (next === flow.name) return;
                if (editingTemplate) {
                  p.onSave({ ...flow, name: next });
                } else if (next) {
                  p.onRename(flow.id, next);
                }
              }}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>
                {nodeCount} {nodeCount === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
                {flow.edges.length === 1 ? "rule" : "rules"}
              </span>
              <div className="sp" />
              {/* Every control in the `!editingTemplate` branch below is a
                  WORKFLOW verb — Save-as-template makes a NEW template from
                  an attached, ticket-bound flow; dry run and Arm both act on
                  a live watch that a template has none of (see
                  `editingTemplate`'s own doc comment). None of the three
                  render at all while editing a template, rather than being
                  disabled: a disabled-with-title control still answers a
                  `getByRole("button", { name })` query, and this file's own
                  vocabulary rule is that these verbs do not exist for a
                  template, not that they exist and refuse.
                  `editingTemplate`'s OWN two controls — Cancel and Save — take
                  their place instead of sitting alongside them: nothing here
                  arms, dry-runs or renames a bare flow, so nothing from that
                  branch belongs beside them. */}
              {editingTemplate ? (
                <>
                  <button type="button" className="orch-mini" onClick={p.onCancelTemplate}>Cancel</button>
                  {/* Same `canBindTicket` gate `flow:writeTemplate`'s own host
                      handler re-checks (deckView.ts) and `toTemplate`'s save
                      dialog gates its own Save with, below — a disabled
                      control with a `title` is a clearer no before the click
                      than a toast the user has to read to learn the same
                      thing after it. The typed name is read straight off
                      `flow.name` (see the input above), so an untouched
                      draft — blank by construction, `mintDraftTemplate`'s own
                      doc comment — cannot be saved either, same reasoning. */}
                  <button
                    type="button"
                    className="orch-mini"
                    disabled={!flow.name.trim() || !canBindTicket(flow)}
                    title={
                      !canBindTicket(flow)
                        ? "Add a step (or a place) this template can bind a ticket to first"
                        : !flow.name.trim()
                          ? "Name this template first"
                          : undefined
                    }
                    onClick={() => {
                      const name = flow.name.trim();
                      if (!name || !canBindTicket(flow)) return;
                      // `templateId` present only when this target already
                      // names a SAVED template — the draft never does (its id
                      // never appears in `p.templates`; see
                      // `mintDraftTemplate`'s own doc comment), so this is
                      // always the "create" branch for it, exactly the "no
                      // `templateId`" shape this task's own tests pin.
                      const templateId = p.templates.some((t) => t.id === target!.id) ? target!.id : undefined;
                      send(
                        templateId
                          ? { type: "flow:writeTemplate", templateId, name, flow }
                          : { type: "flow:writeTemplate", name, flow },
                      );
                      p.onCancelTemplate();
                    }}
                  >
                    Save
                  </button>
                </>
              ) : (
                <>
                  {/* Beside the flow's own Arm control, because saving a
                      template is a thing the OPEN WORKFLOW does. Quiet
                      `orch-mini`, same as every neighbour: Arm alone is
                      filled. Disabled whenever `canBindTicket` says the saved
                      template could never be attached — an empty flow (`toTemplate`
                      itself refuses that one), or one built only of command / gate /
                      notify nodes, which `toTemplate` would save cleanly but
                      `instantiate` would then refuse at every attach forever. A
                      disabled control with a `title` is a clearer no, before the
                      click, than a toast the user has to read to learn the same
                      thing after it. */}
                  <button
                    type="button"
                    className="orch-mini"
                    disabled={!canBindTicket(flow)}
                    title={canBindTicket(flow) ? undefined : "Add a step (or a place) this template can bind a ticket to first"}
                    onClick={openSaveTemplate}
                  >
                    Save as template…
                  </button>
                  {/* The drawer's one filled control. Arm is the consent point for
                      everything a flow does, so it is the only thing here allowed to
                      be filled — armed is a state, not an invitation, so the fill goes
                      away and this becomes the quiet way back out (see .orch-arm.on). */}
                  {/* The dry run sits immediately before Arm because that is the decision
                      it serves: arming is the consent point for everything a flow does,
                      and until now the only thing standing behind it was a hold-on-first-
                      look. Quiet `orch-mini` like every other control on this header —
                      Arm stays the surface's one filled control (see below) — and
                      `aria-pressed` for its on/off state, the App.tsx idiom the Expand
                      button beside it already follows. */}
                  <button
                    type="button"
                    className="orch-mini"
                    aria-pressed={dryRun}
                    onClick={() => {
                      // Told to the host on the way IN, once, and never on the way out:
                      // closing the panel is not a dry run. Deliberately not posted from
                      // the `dry` computation above either — that recomputes on every
                      // render (see its comment), so a post from there would be a message
                      // per frame for as long as the panel stays open. `previewFlow` is
                      // pure and cheap enough to call a second time here rather than
                      // reach for a render-order dependency to reuse the first result.
                      //
                      // Counts only, and no telemetry import: the webview cannot reach
                      // the host's event catalog and has no business deciding what is
                      // recorded — it reports what it did, the host decides. `blocked` is
                      // every PENDING rule that would not fire on this pass — waiting,
                      // held by the cap, unobservable or blank alike — which is why it and
                      // `fired` need not add up to `edges`: a settled rule is in neither.
                      if (!dryRun) {
                        const rows = previewFlow(flow, p.runs, Date.now(), p.branchCi);
                        send({
                          type: "flow:dryRun",
                          edges: flow.edges.length,
                          fired: rows.filter((r) => r.verdict === "fire").length,
                          blocked: rows.filter((r) => r.verdict !== "fire").length,
                        });
                      }
                      setDryRun((v) => !v);
                    }}
                  >
                    What would fire?
                  </button>
                  <button
                    type="button"
                    className={`orch-arm${flow.armed ? " on" : ""}`}
                    onClick={() => p.onArm(flow.id, !flow.armed)}
                  >
                    {flow.armed ? "Armed · disarm" : "Arm"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="orch-body">
        {/* Active and Templates are handled by the flow-less return above —
            reaching this point at all means `p.view === "canvas"` (see the
            early return's own comment). No `p.view` check needed here for
            that reason, but the canvas content below is still wrapped in one
            for symmetry with the header's own `p.view === "canvas"` block. */}
        {p.view === "canvas" && (
          <>
        {savingTemplate && !editingTemplate && (
          // `!editingTemplate` is belt-and-suspenders here, not the primary
          // gate: the button that calls `openSaveTemplate` is itself hidden
          // in the header block above, and the `[openKey]` effect near the
          // top of this component already forces `savingTemplate` back to
          // `false` the moment the target changes kind. Kept anyway, for the
          // same reason `resume` and `dry` are gated at their own source
          // rather than trusted to stay false by construction — a save-as-
          // template dialog open over a TEMPLATE would create a template
          // from a template, which is not a concept this feature has.
          //
          // Same slot the resume banner and the dry-run panel below use for a
          // thing that briefly takes over this body without leaving the
          // drawer — first among them, since saving IS the reason the panel
          // opened and a stale resume banner underneath it should not shift
          // the moment the dialog closes. `role` and `aria-label` name what
          // this actually is, the same as every other control on this
          // surface.
          <div className="orch-tmpl-dialog" role="group" aria-label="Save as template" data-testid="orch-save-template">
            <div className="orch-clause">
              <span className="orch-kw" />
              <input
                className="orch-msg"
                aria-label="Name"
                value={templateName}
                placeholder="Name this template"
                onChange={(ev) => setTemplateName(ev.currentTarget.value)}
              />
            </div>
            {/* One row per place this save has to demote back to `planned` —
                see `placesToDemote`'s own doc comment for why `mode` and
                `dest` cannot be read off the place itself and must be asked. */}
            {placesToDemote(flow).map((n) => {
              const label = endLabel(flow, n.id);
              const choice = templateChoices[n.id] ?? { mode: p.promptModes[0]?.id ?? "", dest: "worktree" as LaunchDest };
              return (
                <div className="orch-clause" key={n.id}>
                  <span className="orch-kw" style={{ fontFamily: "var(--mono)" }}>{label}</span>
                  <select
                    className="orch-sel"
                    aria-label={`Prompt mode for ${label}`}
                    value={choice.mode}
                    onChange={(ev) => setTemplateMode(n.id, ev.currentTarget.value)}
                  >
                    {p.promptModes.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: "var(--t-body)" }}>in a</span>
                  <select
                    className="orch-sel"
                    aria-label={`Destination for ${label}`}
                    value={choice.dest}
                    onChange={(ev) => setTemplateDest(n.id, ev.currentTarget.value as LaunchDest)}
                  >
                    {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
                  </select>
                </div>
              );
            })}
            <div className="row">
              <button type="button" className="orch-mini" onClick={() => setSavingTemplate(false)}>Cancel</button>
              <button
                type="button"
                className="orch-mini"
                disabled={templateName.trim() === ""}
                onClick={submitSaveTemplate}
              >
                Save
              </button>
            </div>
          </div>
        )}
        {resume && (
          // The gate the user asked for: an armed flow does not spend anything
          // a condition made true while they were away without this "go" first.
          // Not a courtesy banner, not red — nothing failed, a flow is waiting.
          <div className="orch-resume" data-testid="orch-resume">
            <div className="t">
              {resume.lines.length === 1 ? "1 rule is ready" : `${resume.lines.length} rules are ready`}
            </div>
            <ul>{resume.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="row">
              <button type="button" className="orch-mini" onClick={() => p.onResumeApprove(flow.id)}>Go</button>
              <button type="button" className="orch-mini" onClick={() => p.onResumeDisarm(flow.id)}>Disarm</button>
            </div>
          </div>
        )}
        {dryRun && !editingTemplate && (
          // `!editingTemplate` here for the same reason `dry` itself is gated
          // at its source, above: `dryRun` is local state that can outlive an
          // `openKey` switch from an armed flow straight onto a template.
          //
          // Between the resume gate and the graph, and above BOTH views on
          // purpose: a verdict about the graph should not cost you sight of it,
          // and it is the same answer whether you are editing on the canvas or in
          // the list. Recomputed on every render rather than fetched — every
          // input is already a prop (`flow`, `p.runs`, `p.branchCi`), so the
          // panel tracks your edits live instead of answering about a graph you
          // have since changed. See `previewFlow`: pure, and it acts on nothing.
          <div className="orch-dry" data-testid="orch-dryrun">
            <div className="hd">
              <span>If you armed this now</span>
              <div className="sp" />
              {dry.length === 0
                ? <span>no rules left to judge</span>
                : (
                  <span className={firing > 0 ? "n on" : "n"}>
                    {firing} of {dry.length} {dry.length === 1 ? "rule" : "rules"}
                  </span>
                )}
            </div>
            {/* The rows scroll, the footer below does NOT. A flow with six rules
                already overflows this panel's height, and the footer is the one
                line that must never fall below a fold: it is what keeps the
                verdict from being read as a promise. */}
            <div className="rows">
            {dry.length === 0 ? (
              // Every rule has fired or failed — there is nothing an arm would do.
              // Said plainly rather than shown as an empty list, which reads as a
              // panel that failed to load.
              <div className="why">Nothing is pending. Reset a rule to run it again.</div>
            ) : dry.map((v) => {
              const e = flow.edges.find((x) => x.id === v.edgeId);
              if (!e) return null;
              // A `waiting` rule's reason is what its source place looks like
              // right now, which is the inspector's own question — asked through
              // the same pair, not a second phrasing of it.
              const why = v.verdict === "waiting"
                ? (observationOf(flow, e, p.runs, p.branchCi) ?? observationFallback(flow, e))
                : verdictWhy(v);
              return (
                <div className="r" key={v.edgeId} data-testid={`orch-dryrun-${v.edgeId}`}>
                  <span className={`v ${v.verdict}`}><span className="d" />{verdictLabel(v)}</span>
                  <span className="s">
                    {ruleOneLine(flow, e)}
                    {why !== null && <span className="why"> · {why}</span>}
                  </span>
                </div>
              );
            })}
            </div>
            {/* The honesty line, and not decoration. `previewFlow` answers for
                `evaluateFlow` alone, which knows nothing about deckView's
                per-target dedupe, its resume gate, or the ask on a flow's first
                spend — so this panel is what the DECISION function says, not a
                promise about the pass. Saying so is what keeps a dry run from
                becoming the thing a user trusts instead of the gates. */}
            <div className="ft">Arming re-checks this every 6s. The first spend still asks.</div>
          </div>
        )}
        {canvasView === "list" ? (
          <>
            {/* Add a node, from the keyboard. Notify and planned work already had
                an ordinary button each (see the identical bar in the canvas
                branch below) — they just never rendered here, since this whole
                bar was canvas-only before Task 6. A place had no keyboard route
                at all: `attachAt` is reachable ONLY by drag-and-drop otherwise,
                so this select is the one new thing here, and it calls that exact
                function rather than a second copy of what a valid attach is
                (see `placeCandidates`'s own doc comment). */}
            <div className="orch-bar">
              <span style={{ fontSize: "var(--t-micro)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dim)" }}>
                Add
              </span>
              <div className="sp" />
              <button type="button" className="orch-mini" onClick={addNotify}>+ Notify</button>
              <button type="button" className="orch-mini" onClick={addGate}>+ Gate</button>
              <button type="button" className="orch-mini" onClick={addPlanned}>+ Add planned work</button>
              {addCommandPicker}
              {/* A place binds a LIVE running card's `runKey` into the graph —
                  see `attachAt`'s own comment for why that is the opposite of
                  what a template is for. Hidden rather than left to hit
                  `attachMany`'s own no-op refusal: an empty-looking picker
                  that quietly does nothing on commit is worse than one that
                  is not offered. */}
              {!editingTemplate && (
                <MultiCombo
                  trigger="+ Add place…"
                  ariaLabel="Add a place"
                  searchPlaceholder="Filter places…"
                  options={placeCandidates(flow, p.runs).map((c) => ({
                    value: c.key,
                    label: c.runKey,
                    detail: c.repo,
                    // A ticket key is an identifier; a command's label is not. See
                    // `ComboOption.mono`.
                    mono: true,
                  }))}
                  // Every board run is already attached, or the board is empty. Both
                  // are answered by the board, not in here, so the line says what is
                  // true rather than offering a search over nothing.
                  emptyLabel="Nothing left to attach — every place is already here"
                  onCommit={attachMany}
                />
              )}
            </div>
            {/* The same two blocks the canvas renders, in the same order they read
                in: what the flow's rules ACT on, and the panel that configures
                whichever of them is selected. They belong here because this view's
                rows are one per RULE — a command node no rule points at yet shows
                up in none of them, so "+ Add command…" one bar above could create
                a node this view could never finish. That is the canvas's own defect
                (nowhere to type until you wire something) in the presentation whose
                whole reason for existing is that it works from the keyboard. */}
            {actionsSection}
            {nodeInspector}
            {/* The keyboard path onto the same rules the canvas draws — see
                flowList.tsx's own header comment for why it exists and what it
                deliberately does not (yet) do. Same `flow` prop, same
                `onSave`/`onResetEdge` this canvas already uses: no second
                model, no second write path. Task 6 adds its own rule-building
                controls inside FlowList itself, since building a RULE needs
                nothing this file's closures hold that FlowList doesn't already
                have in its props (`flow`, `promptModes`, `onSave`). */}
            <FlowList
              flow={flow}
              runs={p.runs}
              promptModes={p.promptModes}
              // The same `agentFlow.commands` this file's own inspector reads —
              // one list, both presentations, so a command rule's picker cannot
              // offer one set of commands on the canvas and another in the list.
              commands={p.commands}
              onSave={onListSave}
              onResetEdge={(edgeId) => p.onResetEdge(flow.id, edgeId)}
            />
          </>
        ) : (
          <>
        <div className="orch-sect">
          <div className="orch-sect-hd">
            <span className="t">Sessions</span>
            <span className="rule" />
          </div>
          <div
            data-testid="orch-tray"
            className={`orch-tray${over ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              attachAt(e.dataTransfer.getData("text/plain"), 24, 24 + flow.nodes.length * 88);
            }}
          >
            {flow.nodes.filter(isAgentNode).length === 0 ? (
              <span className="hint">Drag a card from the board to attach a session.</span>
            ) : (
              flow.nodes.filter(isAgentNode).map((n) => (
                <span className="orch-tchip" key={n.id}>
                  <span className="k">{n.kind === "place" ? n.runKey : n.ticketKey}</span>
                  <span className="sub">{n.kind === "place" ? n.repo : "not taken"}</span>
                  <button
                    type="button"
                    className="rm"
                    aria-label={`Remove ${n.kind === "place" ? n.runKey : n.ticketKey}`}
                    onClick={() => removeNode(n.id)}
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>
        </div>
        {/* The other half of the tray, and the ONLY way to delete either kind of
            node a rule ACTS on. `removeNode` was reachable from the Agents tray
            alone, and that tray is `isAgentNode` — place|planned — so a notify
            terminal could not be removed at all, and this phase's command node
            joined it in the same hole. A command node is created by a `<select>`
            that fires on change, so one accidental pick was permanent short of
            hand-editing the flow file.
            Its own section rather than more chips in the tray above: that tray is a
            DROP TARGET with its own empty-state hint, and the two lists answer
            different questions — "Agents" is what conditions are about, "Actions"
            is what rules do (`ACTION_LABEL`'s `notify` and `run`). Rendered only
            when there is something in it, so a flow with no terminals gains no
            empty box. Built above (`actionsSection`) rather than inline here,
            because the list view renders the same section. */}
        {actionsSection}
        <div className="orch-bar">
          <span className="t" style={{ fontSize: "var(--t-micro)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dim)" }}>
            Graph
          </span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={onTidy}>Tidy</button>
          <button type="button" className="orch-mini" onClick={addNotify}>+ Notify</button>
          <button type="button" className="orch-mini" onClick={addGate}>+ Gate</button>
          <button type="button" className="orch-mini" onClick={addPlanned}>+ Add planned work</button>
          {addCommandPicker}
        </div>
        <div
          ref={graphRef}
          data-testid="orch-canvas"
          className={`orch-graph${overGraph ? " over" : ""}${wiring ? " wiring" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOverGraph(true); }}
          onDragLeave={() => setOverGraph(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOverGraph(false);
            const box = graphRef.current?.getBoundingClientRect();
            attachAt(
              e.dataTransfer.getData("text/plain"),
              snap(e.clientX - (box?.left ?? 0) - NODE_W / 2),
              snap(e.clientY - (box?.top ?? 0) - NODE_H / 2),
            );
          }}
          onPointerUp={() => setWiring(null)}
        >
          {flow.nodes.length === 0 && (
            <div className="orch-empty" style={{ border: 0, position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              Drag a card from the board to add a node,<br />
              then connect two nodes to put a condition between them.
            </div>
          )}
          <svg>
            {flow.edges.map((e) => {
              const a = flow.nodes.find((n) => n.id === e.from);
              const b = flow.nodes.find((n) => n.id === e.to);
              if (!a || !b) return null;
              const from = anchor(boxOf(a), "out");
              const to = anchor(boxOf(b), "in");
              const bad = BAD_CONDS.has(e.cond.kind);
              const on = selEdge === e.id;
              return (
                <path
                  key={e.id}
                  d={edgePath(from, to)}
                  fill="none"
                  strokeWidth={on ? 1.8 : 1.4}
                  strokeDasharray={bad ? "4 3" : undefined}
                  stroke={bad ? "var(--c-danger)" : on ? "var(--brand)" : "var(--edge)"}
                />
              );
            })}
          </svg>
          {flow.nodes.map((n) => {
            const pos = posOf(n);
            const st = nodeState(n, p.runs);
            return (
              <div
                key={n.id}
                data-testid={`orch-node-${n.id}`}
                className={`orch-node${n.kind === "planned" ? " plan" : ""}${n.kind === "notify" ? " notify" : ""}${n.kind === "gate" ? " gate" : ""}${sel === n.id ? " sel" : ""}${wiring === n.id ? " src" : ""}`}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                onPointerDown={(e) => startDrag(n.id, e)}
                onPointerUp={() => wiring && finishWire(n.id)}
              >
                <div className="l1">
                  <span className="d" style={{
                    background: n.kind === "gate" ? gateHue(gateStateOf(n))
                      : st ? STATE_HUE[st] : "var(--dim)",
                  }} />
                  {/* `endLabel` (orchestratorRule.ts), not a second hand-typed
                      ternary: this exact fallthrough used to give a command
                      node the literal word "notify" — a canvas chip lying
                      about what it does — because it fell to the same default
                      a genuine notify node reads correctly. */}
                  <span className="k">{endLabel(flow, n.id)}</span>
                </div>
                <div className="st">
                  {n.kind === "place" ? n.repo
                    : n.kind === "planned" ? "not taken"
                    : n.kind === "notify" ? n.message
                    : n.kind === "command" ? "runs a command"
                    : n.kind === "gate" ? gateBody(n, gateStateOf(n))
                    : ""}
                </div>
                {n.kind === "gate" && (() => {
                  const st2 = gateStateOf(n);
                  if (!st2?.asked || st2.answer || !st2.edgeId) return null;
                  const edgeId = st2.edgeId;
                  const question = n.question;
                  return (
                    // stopPropagation on pointerDown is what keeps `startDrag`
                    // from ever seeing this pointer — the same idiom `.orch-port`
                    // uses below, and the reason a press-then-move on a button
                    // can never become an approve. `.orch-node` is a
                    // `cursor: grab` surface built to swallow pointer events.
                    <div className="gbtns" onPointerDown={(e) => e.stopPropagation()}>
                      <button type="button" className="gbtn ok"
                        aria-label={`Approve ${question}`}
                        onClick={() => answerGate(edgeId, "approved")}>Approve</button>
                      <button type="button" className="gbtn"
                        aria-label={`Reject ${question}`}
                        onClick={() => answerGate(edgeId, "rejected")}>Reject</button>
                    </div>
                  );
                })()}
                <span
                  className="orch-port in"
                  data-testid={`orch-port-in-${n.id}`}
                  onPointerDown={(e) => e.stopPropagation()}
                />
                {n.kind !== "notify" && (
                  <span
                    className="orch-port out"
                    data-testid={`orch-port-out-${n.id}`}
                    onPointerDown={(e) => { e.stopPropagation(); setWiring(n.id); }}
                  />
                )}
              </div>
            );
          })}
          {flow.edges.map((e) => {
            const a = flow.nodes.find((n) => n.id === e.from);
            const b = flow.nodes.find((n) => n.id === e.to);
            if (!a || !b) return null;
            // Every other node is a potential obstacle for this edge's label —
            // except the edge's own two endpoints. A label is allowed to sit
            // near the nodes it is about; excluding them keeps a short edge's
            // label where it belongs instead of shoving it off its own line.
            const obstacles = flow.nodes
              .filter((n) => n.id !== e.from && n.id !== e.to)
              .map((n) => boxOf(n));
            // `ORCH_EDGE_PAINT_DY`: this chip is painted well ABOVE the point
            // positioned below (`.orch-edge`'s own transform), so the avoidance has
            // to be told where it actually lands — see that constant, and
            // `labelPoint`'s `paintDy`.
            const mid = labelPoint(
              anchor(boxOf(a), "out"), anchor(boxOf(b), "in"), obstacles, ORCH_EDGE_PAINT_DY,
            );
            return (
              <button
                type="button"
                key={e.id}
                data-testid={`orch-edge-${e.id}`}
                className={`orch-edge${selEdge === e.id ? " sel" : ""}${BAD_CONDS.has(e.cond.kind) ? " bad" : ""}`}
                style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
                onClick={() => selectEdge(e.id)}
              >
                {/* `condOptionLabel`, not `COND_LABEL`: the closed list row, the
                    list's own options and this inspector's options all spend the
                    former, and the canvas was the last surface still spending a
                    `Record` keyed by KIND alone. A kind cannot know which branch a
                    given rule is about, so the chip read "branch CI passed…" where
                    the list read "CI passed on agent-flow#master" — for one rule,
                    in one panel. The trailing ellipsis is this codebase's own mark
                    for "carries a parameter", and a chip that wears it and then
                    never shows one is the exact defect the list already fixed. */}
                {condOptionLabel(e.cond)}
              </button>
            );
          })}
          {/* Resize and Expand fix the FITTING of a graph too wide for the
              drawer; neither fixes the SILENCE when one still doesn't fit —
              "clips with no affordance" was half of the original defect (see
              this task's own brief). Shown only when `clippedRight` says a
              node's own right edge genuinely falls past the graph's visible
              width, never as decoration on a graph that already fits.
              `aria-hidden`: purely a visual cue about layout, nothing a
              screen reader has a node-level fact to announce. */}
          {clippedRight && <div className="orch-graph-fade" data-testid="orch-graph-fade" aria-hidden="true" />}
        </div>
        {!edge ? (
          // A selected command or notify node opens the inspector in its own
          // right — its command, or its message, is the node's own data. The
          // empty state is only for a selection that has nothing to configure
          // (nothing selected at all, or a place/planned node, whose launch
          // settings belong to the rule that spends them).
          nodeInspector ?? (
            <div className="orch-insp none" data-testid="orch-inspector">
              {INSPECTOR_NONE}
            </div>
          )
        ) : (
          <div className="orch-insp" data-testid="orch-inspector">
            <div className="t">
              <span>
                Connection ·{" "}
                <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.from)}</span>
                {" → "}
                <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.to)}</span>
              </span>
              <span className="sp" />
              <button type="button" className="orch-mini" aria-label="Delete connection" onClick={() => deleteEdge(edge)}>
                Delete
              </button>
            </div>
            <div className="orch-clause">
              <span className="orch-kw">WHEN</span>
              <select
                className="orch-sel"
                aria-label="Condition"
                value={edge.cond.kind}
                onChange={(ev) => setCond(edge, ev.currentTarget.value as Condition["kind"])}
              >
                {/* An option for whatever this rule's condition actually IS,
                    when the picker does not offer that kind — a parameterised
                    one, or `command-succeeded` on a rule out of a place. The
                    same defect the Mode select's own extra option exists for,
                    but one step worse: a `<select>` whose `value` matches no
                    option has `selectedIndex` -1 and renders BLANK, which is
                    how a hand-authored `branch-ci-passed` rule showed an empty
                    Condition control — the one condition built to gate a
                    deploy, displayed as nothing at all. `condOptionLabel` is
                    what names the repo and branch a `Record` keyed by kind
                    cannot. Selectable, not disabled: switching away to a bare
                    kind (and losing the parameters with it) is a real edit a
                    user is allowed to make. */}
                {!condOffered(flow, edge) && (
                  <option value={edge.cond.kind}>{condOptionLabel(edge.cond)}</option>
                )}
                {/* Offered per SOURCE, not the whole list: `evaluate.ts` answers
                    `command-succeeded` from the flow and every other kind from
                    the source place's `RunStatus`, so each set is inert on the
                    other's source — see `offeredConds`. */}
                {offeredConds(flow, edge.from).map((k) => (
                  <option key={k} value={k}>{COND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            {/* The condition's own parameters, on a row of their own under the
                kind that needs them. An empty keyword cell rather than no cell:
                `.orch-kw`'s 40px column is what makes every value in this panel
                start at the same x, and a parameter that began at the panel edge
                would read as a new clause rather than as part of WHEN.

                `CondParams` renders NOTHING for a bare kind, so this row is
                absent — not empty — for the thirteen conditions that carry no
                parameter, and the panel is byte-identical to what it was for
                them. The same component fills the same hole in a flowList row,
                which is the whole reason it is a component: see its header. */}
            {condParams !== null && (
              <div className="orch-clause" data-testid="orch-cond-params">
                <span className="orch-kw" />
                {condParams}
              </div>
            )}
            {/* THEN is a STATEMENT, not a choice. The action is whatever the
                node this rule points at implies (`edgeAction`), so a `<select>`
                here could not decide anything: the pick was silently overridden
                by the target on the next read, and — worse — it was STORED,
                which is precisely the disagreement `latchActionMismatches`
                stamps an edge dead for. A control whose choice is overridden is
                worse than no control. The way to change what a rule does is to
                point it at a different node. */}
            {/* `data-testid`, unlike every other clause in this inspector, because
                the verb is the one thing here that is pure derived TEXT rather
                than a labelled control — and a test scoped to the whole
                inspector cannot pin it: "run" is a substring of the note hint's
                own "…a note can extend what runs", so an assertion on the
                panel's text passed even with the verb rendered as nothing at
                all (measured). This is the handle that makes the verb
                assertable on its own. */}
            <div className="orch-clause" data-testid="orch-then">
              <span className="orch-kw">THEN</span>
              {derived === undefined ? (
                // flowList.tsx's wording for this exact state, verbatim: two
                // presentations of one model must not describe it two ways.
                <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>
                  this rule&rsquo;s action can&rsquo;t be determined
                </span>
              ) : (
                <>
                  <span style={{ fontSize: "var(--t-body)" }}>{ACTION_LABEL[derived]}</span>
                  {/* The target's name — an identifier, so mono — is part of the
                      sentence for launch and seed ("THEN launch PROJ-12"). Notify
                      already reads complete on its own, and a `run`'s target is
                      named by the USING picker right below, which is a control
                      rather than a label: printing it here too would give one
                      rule's own name twice in three lines. */}
                  {derived !== "notify" && derived !== "run" && (
                    <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.to)}</span>
                  )}
                </>
              )}
            </div>
            {derived === "notify" ? (
              <div className="orch-clause">
                <input
                  className="orch-msg"
                  aria-label="Notify message"
                  key={edge.id}
                  defaultValue={notifyMessageOf(flow, edge)}
                  onBlur={(ev) => setNotifyMessage(edge, ev.currentTarget.value)}
                />
              </div>
            ) : derived === "run" ? (
              <>
                <div className="orch-clause">
                  <span className="orch-kw">USING</span>
                  <select
                    className="orch-sel"
                    aria-label="Command"
                    value={cmd.value}
                    onChange={(ev) => setCommand(edge, ev.currentTarget.value)}
                  >
                    {/* Same reasoning as the Mode select's own extra option
                        below: a `<select>` whose value matches none of its
                        options silently shows the FIRST one instead, so a node
                        naming a command that is not (or no longer) in
                        `agentFlow.commands` would read as "Deploy to staging"
                        while `resolveCommand` refuses it outright. And a node
                        with neither field — a hand-edited file, since the
                        picker never builds one — must say so rather than look
                        like the first configured command. */}
                    {!cmd.idExists && (
                      <option value={cmd.value}>
                        {cmd.value === "" ? COMMAND_NOT_SET : `${cmd.value} (not configured)`}
                      </option>
                    )}
                    {p.commands.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                    <option value={COMMAND_FREE_TEXT}>Free-text command…</option>
                  </select>
                </div>
                {/* Free text gets its own row and its own field. Shown whenever
                    the node is IN the free-text shape (`run` present, even
                    blank) — which is exactly what the picker's own option
                    creates — so a user who chooses it has somewhere to type,
                    and a node already carrying free text shows it in full
                    rather than eliding it the way the sentence does. */}
                {cmd.run !== undefined && (
                  <div className="orch-clause">
                    <span className="orch-kw" />
                    <input
                      className="orch-msg"
                      aria-label="Command to run"
                      key={edge.id}
                      defaultValue={cmd.run}
                      placeholder="deploy.sh --env=staging"
                      onBlur={(ev) => p.onSave(withCommandRun(flow, edge, ev.currentTarget.value))}
                    />
                  </div>
                )}
                {/* A command's note is read by `resolveCommand`, exactly like a
                    launch's is read by `composeAgentPrompt` — so the field
                    belongs here too, with its own placeholder (a command rule
                    has no mode for `NOTE_PLACEHOLDER` to contrast itself
                    with). */}
                <div className="orch-clause">
                  <span className="orch-kw" />
                  <input
                    className="orch-msg"
                    aria-label={NOTE_ARIA_LABEL}
                    key={edge.id}
                    defaultValue={edge.note ?? ""}
                    placeholder={NOTE_COMMAND_PLACEHOLDER}
                    onBlur={(ev) => setNote(edge, ev.currentTarget.value)}
                  />
                </div>
                {/* The one place a person typing a note actually reads what
                    happens to it: `command.ts` splices it in unquoted, so a note
                    can extend the command. Dim, not red and not a warning icon —
                    nothing has failed, this is how a feature the user chose
                    works. */}
                <div className="orch-clause">
                  <span className="orch-kw" />
                  <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>{NOTE_COMMAND_HINT}</span>
                </div>
              </>
            ) : derived === "launch" || derived === "seed" ? (
              <>
                <div className="orch-clause">
                  <span className="orch-kw">USING</span>
                  <select
                    className="orch-sel"
                    aria-label="Mode"
                    value={modeValue}
                    onChange={(ev) => setMode(edge, ev.currentTarget.value)}
                  >
                    {/* An option for whatever the store actually holds, when it names
                        no configured mode — an absent one, or one since deleted. Without
                        this, a `<select>` whose value matches no option falls back to
                        showing its first option selected, which would show a mode that
                        will run while the one on disk is the one `modeFor` will refuse. */}
                    {!modeExists && (
                      <option value={modeValue}>
                        {modeValue ? `${modeValue} (not configured)` : "(no mode set)"}
                      </option>
                    )}
                    {p.promptModes.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  {/* A place already exists, so `seed` has nothing to pick a
                      destination for — only `launch` opens one. */}
                  {derived === "launch" && (
                    <>
                      <span style={{ fontSize: "var(--t-body)" }}>in a</span>
                      <select
                        className="orch-sel"
                        aria-label="Destination"
                        value={launchDest ?? "worktree"}
                        onChange={(ev) => setDest(edge, ev.currentTarget.value as LaunchDest)}
                      >
                        {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
                      </select>
                    </>
                  )}
                </div>
                {/* The note: a second row under USING, not squeezed onto the
                    mode/destination line — a blank `.orch-kw` spacer (same
                    40px width, no text) lines this input up under the
                    select above it rather than under the WHEN/THEN keywords.
                    Prose, so no mono; and never a second filled control —
                    Arm alone earns that (see the house rule this file's own
                    header, and orchestratorStyles.ts's `.orch-arm`, both
                    say). `key={edge.id}` matches the notify-message input
                    just above: an uncontrolled field that must reset to the
                    NEW edge's own value the moment `selEdge` changes, rather
                    than keep showing whatever the previous edge's input last
                    held. */}
                <div className="orch-clause">
                  <span className="orch-kw" />
                  <input
                    className="orch-msg"
                    aria-label={NOTE_ARIA_LABEL}
                    key={edge.id}
                    defaultValue={edge.note ?? ""}
                    placeholder={NOTE_PLACEHOLDER}
                    onBlur={(ev) => setNote(edge, ev.currentTarget.value)}
                  />
                </div>
              </>
            ) : null}
            {/* Reset is offered for an ERRORED edge, not only a fired one. An edge
                carrying `error` with no `firedAt` is settled in `evaluate.ts`, so it
                never fires again — offering Reset only for `firedAt` made it an
                unresettable dead end that still rendered the *waiting* line, as if
                it were patiently watching. Error wins over a receipt when a
                hand-edited flow somehow carries both: a failure is the more
                important claim. And this is the one place in the drawer red is
                right — a rule that tried and failed is a real failure, which is
                exactly what `--c-danger` is for. */}
            <div className="orch-obs">
              {isSettled(edge) ? (
                <>
                  {edge.error !== undefined ? (
                    // Red for a rule that TRIED AND FAILED — and only that.
                    // The store's migration notice is settled the same way and
                    // gets the same Reset, but nothing ran and nothing broke, so
                    // it reads in the row's own dim voice instead of claiming a
                    // failure. See `isMigrationNotice`.
                    <span className={isMigrationNotice(edge.error) ? undefined : "err"}>{edge.error}</span>
                  ) : (
                    <span className="fired">{edge.firedNote ?? "fired"}</span>
                  )}
                  <div className="sp" />
                  <button type="button" className="orch-mini" onClick={() => p.onResetEdge(flow.id, edge.id)}>Reset</button>
                </>
              ) : (
                // `observationFallback`, not a literal: `observationOf` answers
                // `null` for two different reasons, and "this card is not on the
                // board right now" is true of only one of them. A waiting
                // `command-succeeded` rule — the default and only condition off a
                // command node, so the steady state of this phase's headline shape
                // — has no place-shaped observation to make and nothing missing.
                <span>{observationOf(flow, edge, p.runs, p.branchCi) ?? observationFallback(flow, edge)}</span>
              )}
            </div>
          </div>
        )}
          </>
        )}
          </>
        )}
      </div>

      {p.view === "canvas" && (
      <div className="orch-ft">
        {/* An armed flow with an errored rule must not claim it is watching: that
            rule is settled and will never be evaluated again until Reset. It says
            how many rules are stalled instead — "N rules stalled", not "this flow
            is stalled", because the flow's OTHER rules genuinely are still live.
            The node and rule counts stay on the footer's right-hand side either
            way, so nothing is lost by spending the left side on the failure.
            Disarmed is left alone: "Not armed" makes no claim to correct.

            The DOT is gated on `failed`, not on `stalled`: `.orch-ft
            .live.stalled .d` is `--c-danger`, and this codebase spends red on a
            real failure and nothing else. A flow stalled only by the store's
            migration notice has not failed — see `failed`'s own doc comment
            above for why one panel must not make two severity claims about one
            edge. The sentence keeps counting every stall. */}
        <span className={`live${flow.armed ? " on" : ""}${flow.armed && failed > 0 ? " stalled" : ""}`}>
          <span className="d" />
          {!flow.armed
            ? "Not armed"
            : stalled > 0
              ? `Armed · ${stalled} ${stalled === 1 ? "rule" : "rules"} stalled`
              : `Armed · watching ${watched} ${watched === 1 ? "node" : "nodes"}`}
        </span>
        <div className="sp" />
        <span>
          {nodeCount} {nodeCount === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
          {flow.edges.length === 1 ? "rule" : "rules"}
        </span>
      </div>
      )}
    </Drawer>
  );
}
