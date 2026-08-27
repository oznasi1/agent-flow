import * as React from "react";
import { placeActivity } from "../engine/orchestrator/conditions";
import { anchor, edgePath, labelPoint, NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Condition, edgeAction, Flow, FlowEdge, FlowNode, isSettled, LaunchDest, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { AgentState, BranchCiStatus, FlowCommand, FlowPromptMode, PendingResume, RunStatus } from "../types";
import { MultiCombo } from "./combo";
import { Drawer, useDrawerExit } from "./Drawer";
import { FlowList } from "./flowList";
import { ORCH_EDGE_PAINT_DY } from "./orchestratorStyles";
import {
  ACTION_LABEL,
  addCommandNode,
  COMMAND_FREE_TEXT,
  COMMAND_NONE_LABEL,
  COMMAND_NOT_SET,
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
  offeredConds,
  OFFERED_DESTS,
  withCommandId,
  withCommandRun,
  withCond,
  withDest,
  withMode,
  withNodeCommandId,
  withNodeCommandRun,
  withNodeNotifyMessage,
  withNote,
  withNotifyMessage,
  withoutEdge,
} from "./orchestratorRule";
import { send, vscodeApi } from "./vscodeApi";

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
 * Ceiling: derived from the viewport, not a fixed pixel, so a maximized
 * editor and a half-screen one don't share one number. `deckStyles.ts`'s
 * board column is 318px wide (`.col { flex: 0 0 318px }`); reserving
 * somewhat more than that keeps at least one board column visible beside the
 * drawer — the whole reason resize won over an expand-only drawer (see this
 * file's own header comment and the mockup it points at). */
const MIN_ORCH_W = 420;
const BOARD_MARGIN = 340;

/** Recomputed on every drag move and every arrow-key press, not cached at
 * mount: the viewport can change (a window resize, a panel dragged wider)
 * while the drawer is open. */
function orchCeiling(): number {
  return Math.max(MIN_ORCH_W, window.innerWidth - BOARD_MARGIN);
}

function clampOrchWidth(w: number): number {
  return Math.min(orchCeiling(), Math.max(MIN_ORCH_W, w));
}

/** What this file persists across a reload — a single small object, not a
 * shared state blob: nothing else in the webview calls `vscodeApi.getState`/
 * `setState` yet, so this is the pattern's first use, not an addition to an
 * existing one. */
interface OrchPersisted {
  orchWidth?: number;
}

/** Read defensively: a value written by a future version of `OrchPersisted`,
 * or one that got corrupted, must fall back to the default rather than throw
 * or hand back garbage for `--orch-w` to render. */
function readPersistedWidth(): number | null {
  let stored: unknown;
  try {
    stored = vscodeApi.getState<OrchPersisted>();
  } catch {
    return null;
  }
  if (!stored || typeof stored !== "object") return null;
  const w = (stored as OrchPersisted).orchWidth;
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

/** Best-effort: a webview host that rejects the write is not a reason to
 * throw out of a keypress or a pointer release. */
function persistWidth(w: number): void {
  try {
    vscodeApi.setState({ orchWidth: w });
  } catch {
    // Losing persistence is not worse than losing the drawer over it.
  }
}

/** Arrow-key step. Two grid units (see `GRID` in layout.ts) — a visible
 * increment without needing many presses to reach a useful width. */
const RESIZE_STEP = 16;

/** "Full panel width" for the Expand toggle. Deliberately `window.innerWidth`
 * itself, not `orchCeiling()`'s clamp: the ceiling's whole job is reserving
 * room for a board column during an ORDINARY resize (see its own doc
 * comment above), and Expand exists precisely to override that reservation
 * when a graph genuinely needs the room — the escape hatch resize alone
 * cannot offer, not a bigger ordinary resize. */
function fullOrchWidth(): number {
  return window.innerWidth;
}

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
  stalled: "var(--c-attn)",
  exited: "var(--c-attn)",
  idle: "var(--c-idle)",
  unknown: "var(--dim)",
};

/** Conditions that describe something being wrong. The only edges allowed a
 * danger tint — colour here is attention debt, not decoration. */
const BAD_CONDS = new Set<Condition["kind"]>(["ci-failed", "changes-requested", "pr-conflicting"]);

export interface OrchestratorDrawerProps {
  flows: Flow[];
  /** Which flow is open. `null` closes the drawer. */
  openId: string | null;
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
}

export function OrchestratorDrawer(p: OrchestratorDrawerProps): JSX.Element | null {
  const openFlow = p.flows.find((f) => f.id === p.openId);
  /** The flow the drawer keeps painting while it slides back out, and whether it
   * is doing that — both from the shared drawer seam, so this drawer and the
   * card detail leave the board the same way. Frozen and unreachable for that
   * span: a drawer on its way out must not answer a role query, a screen
   * reader, or a Tab. The click that closed it has already sent focus back to
   * the chip. `Drawer.tsx` holds the reasoning, including why the hook needs
   * both `openId` and the flow it resolves to. */
  const { shown: flow, closing } = useDrawerExit(p.openId, openFlow);
  /** Canvas ⇄ list. The canvas is a board built from divs and pointer events —
   * no usable keyboard story — so `FlowList` (flowList.tsx) exists as the
   * keyboard path onto the exact same `Flow`. Canvas stays the default: this
   * toggle only ever narrows what a mouse user already had, it does not
   * change it. Never persisted alongside `width` — reopening the drawer in a
   * fresh session should land on the canvas, not silently reopen on whichever
   * view a past session happened to be reading. */
  const [view, setView] = React.useState<"canvas" | "list">("canvas");
  const [picking, setPicking] = React.useState(false);
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
    clampOrchWidth(readPersistedWidth() ?? DEFAULT_ORCH_W),
  );
  /** The escape hatch, for a graph big enough that resize's board-reserving
   * ceiling still clips it. Deliberately NOT persisted alongside `width`
   * (see `readPersistedWidth`/`persistWidth` above, which know nothing of
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
      const next = clampOrchWidth(resizing.startW + (resizing.startX - e.clientX));
      resizeRef.current = next;
      setWidth(next);
    };
    const up = () => {
      const finalWidth = resizeRef.current ?? resizing.startW;
      resizeRef.current = null;
      setResizing(null);
      persistWidth(finalWidth);
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

  if (!flow) return null;

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
  const actionNodes = flow.nodes.filter((n) => n.kind === "notify" || n.kind === "command");
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
  // yet said "go" on what already is.
  const resume = p.pendingResume.find((r) => r.flowId === flow.id) ?? null;

  const attachAt = (raw: string, x: number, y: number) => {
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
   * the picker's own candidate list excludes duplicates anyway. */
  const attachMany = (keys: string[]) => {
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
    const next = clampOrchWidth(e.key === "ArrowLeft" ? width + RESIZE_STEP : width - RESIZE_STEP);
    setWidth(next);
    persistWidth(next);
  };

  /** A pure boolean flip that never touches `width` — the functional-updater
   * form so two activations landing in the same React batch (e.g. a rapid
   * double click) still cancel out correctly instead of both reading the
   * same stale `expanded` and racing to the same answer. Because expanding
   * never writes into `width`, applying it again while already expanded is
   * automatically idempotent: `renderWidth` below always recomputes
   * `fullOrchWidth()` fresh, so there is nothing to compound or drift. */
  const toggleExpanded = () => setExpanded((v) => !v);

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
    return { x: pos.x, y: pos.y, w: n.kind === "notify" ? NOTIFY_W : NODE_W, h: NODE_H };
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

  // Unlike every other node this drawer builds, a `planned` node cannot be
  // assembled here: it names a ticket, and the webview has no task connector
  // to ask for one — it must not import `fs`/`os`/`path`/`child_process`, even
  // transitively, and a connector reaches all four. So this sends only the
  // flow's own id; the host runs the actual picker (a sequence of native
  // QuickPicks) and appends the whole node in one write. See deckView.ts's
  // `addPlanned`.
  const addPlanned = () => send({ type: "flow:addPlanned", id: flow.id });

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

  /** The node the inspector answers to when NO connection is selected — a
   * command node's command and a notify node's message are the node's own data
   * (`withNodeCommandId`, `withNodeNotifyMessage`), and until now the only
   * controls that wrote them were keyed on an edge, so a node had to be wired
   * into a rule before it could be configured at all. A place or a planned node
   * is deliberately not here: neither has a field this panel edits (a launch's
   * mode and destination are set on the rule that spends them), so selecting one
   * leaves the empty state up rather than opening an empty panel. */
  const inspNode = !edge && sel ? flow.nodes.find((n) => n.id === sel) : undefined;
  const nodeInsp = inspNode && (inspNode.kind === "command" || inspNode.kind === "notify") ? inspNode : undefined;
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

  /** What actually renders. Expand does not touch `width` — see the
   * `expanded` state's own doc comment — so this ternary IS the whole
   * mechanism: collapsing needs no separate "restore" step because `width`
   * was never overwritten to begin with. */
  const renderWidth = expanded ? fullOrchWidth() : width;

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
            <span className="sub">{n.kind === "notify" ? n.message : "runs a command"}</span>
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
          {nodeInsp.kind === "command" ? "Command" : "Notify"}
          {/* The identifier, exempt from this row's uppercase (see
              `.orch-insp .t .k`): a free-text command is case-sensitive shell
              text, and "DEPLOY.SH --ENV=STAGING" is not the command that runs.
              A notify node has no identifier to print — its message is prose,
              which this row would shout — so the kind word stands alone. */}
          {nodeInsp.kind === "command" && (
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
        </>
      ) : (
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
      {/* role="separator" + aria-orientation is the ARIA shape App.tsx's own
          controls already use (role="tablist"/"group" with aria-selected/
          -pressed) — a real widget role plus the state attributes that make
          it usable without a mouse, not a bespoke pattern. Keyboard-resizable
          on purpose: this phase's whole point is that the drawer works
          without one, so a grip only a mouse could move would contradict it.
          Hidden rather than merely disabled while expanded — not styled
          inert, not in the DOM at all — because there is nothing to drag TO:
          the drawer is already at its widest legal width, so a grip sitting
          at the very edge of the viewport with nowhere further to go would
          be a control that does nothing, not a quiet one. The Expand toggle
          below (aria-pressed) is the one way back to a custom width. */}
      {!expanded && (
        <div
          className="orch-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Orchestrator drawer"
          aria-valuenow={Math.round(width)}
          aria-valuemin={MIN_ORCH_W}
          aria-valuemax={orchCeiling()}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onGripKeyDown}
        />
      )}
      <div className="orch-hd">
        <div className="row">
          <span className="eyebrow">Orchestrator</span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={() => setPicking((v) => !v)}>
            Flows · {p.flows.length} ▾
          </button>
          {/* Same quiet `orch-mini` as its neighbour, deliberately: a filled or
              accented control is reserved for Arm — the drawer's one filled control,
              shipped in this phase — and red is reserved for a real failure (an
              errored rule, in the inspector below). Deleting closes the drawer rather than
              leaving it aimed at a flow that is gone — the host's `deck:flows` post
              would arrive and close it a round trip later anyway, and a drawer
              rendering a deleted flow in the meantime is a lie. */}
          <button
            type="button"
            className="orch-mini"
            onClick={() => { p.onDelete(flow.id); p.onClose(); }}
          >
            Delete flow
          </button>
          {/* Same quiet `orch-mini` as its neighbours — Arm stays the surface's
              only filled control (see its own comment below). aria-pressed
              is the App.tsx idiom (its filter/size/status `.seg` groups use
              exactly this attribute for on/off state) rather than a bespoke
              one; CONTROLS_CSS's own on-state rule ("weight and foreground,
              never a fill") is the visual language this borrows, even though
              this button lives in a different sheet. The label stays
              "Expand" in both states, the same way those `.seg` buttons never
              rewrite their own text when pressed. */}
          <button type="button" className="orch-mini" aria-pressed={expanded} onClick={toggleExpanded}>
            Expand
          </button>
          <button type="button" className="orch-x" aria-label="Close" onClick={p.onClose}>✕</button>
        </div>
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
              aria-selected={view === "canvas"}
              className="orch-mini"
              onClick={() => setView("canvas")}
            >
              Canvas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "list"}
              className="orch-mini"
              onClick={() => setView("list")}
            >
              List
            </button>
          </span>
        </div>
        {/* Rename on blur, not per keystroke: every keystroke would be a disk
            write and a re-post, and the field would fight the re-render. */}
        <input
          className="orch-name"
          aria-label="Flow name"
          defaultValue={flow.name}
          key={flow.id}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim();
            if (next && next !== flow.name) p.onRename(flow.id, next);
          }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>
            {nodeCount} {nodeCount === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
            {flow.edges.length === 1 ? "rule" : "rules"}
          </span>
          <div className="sp" />
          {/* The drawer's one filled control. Arm is the consent point for
              everything a flow does, so it is the only thing here allowed to
              be filled — armed is a state, not an invitation, so the fill goes
              away and this becomes the quiet way back out (see .orch-arm.on). */}
          <button
            type="button"
            className={`orch-arm${flow.armed ? " on" : ""}`}
            onClick={() => p.onArm(flow.id, !flow.armed)}
          >
            {flow.armed ? "Armed · disarm" : "Arm"}
          </button>
        </div>
        {picking && (
          <div className="orch-flows">
            {p.flows.map((f) => (
              <button type="button" key={f.id} onClick={() => { setPicking(false); p.onOpen(f.id); }}>
                {f.name}
              </button>
            ))}
            <button type="button" onClick={() => { setPicking(false); p.onCreate(); }}>+ New flow</button>
          </div>
        )}
      </div>

      <div className="orch-body">
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
        {view === "list" ? (
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
              <button type="button" className="orch-mini" onClick={addPlanned}>+ Add planned work</button>
              {addCommandPicker}
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
                className={`orch-node${n.kind === "planned" ? " plan" : ""}${n.kind === "notify" ? " notify" : ""}${sel === n.id ? " sel" : ""}${wiring === n.id ? " src" : ""}`}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                onPointerDown={(e) => startDrag(n.id, e)}
                onPointerUp={() => wiring && finishWire(n.id)}
              >
                <div className="l1">
                  <span className="d" style={{ background: st ? STATE_HUE[st] : "var(--dim)" }} />
                  {/* `endLabel` (orchestratorRule.ts), not a second hand-typed
                      ternary: this exact fallthrough used to give a command
                      node the literal word "notify" — a canvas chip lying
                      about what it does — because it fell to the same default
                      a genuine notify node reads correctly. */}
                  <span className="k">{endLabel(flow, n.id)}</span>
                </div>
                <div className="st">
                  {n.kind === "place" ? n.repo : n.kind === "planned" ? "not taken" : n.kind === "notify" ? n.message : n.kind === "command" ? "runs a command" : ""}
                </div>
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
      </div>

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
    </Drawer>
  );
}
