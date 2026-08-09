import * as React from "react";
import { placeActivity } from "../engine/orchestrator/conditions";
import { anchor, edgePath, labelPoint, NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Condition, Flow, FlowAction, FlowEdge, FlowNode, isSettled, LaunchDest, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { AgentState, FlowPromptMode, PendingResume, RunStatus } from "../types";
import { FlowList } from "./flowList";
import {
  ACTION_LABEL,
  actionMismatch,
  COND_LABEL,
  endLabel,
  launchDestOf,
  modeValueOf,
  notifyMessageOf,
  observationOf,
  OFFERED_CONDS,
  withAction,
  withCond,
  withDest,
  withMode,
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

/** The next unused `${prefix}N` id, scanning past whatever is already taken
 * rather than trusting the live count. A count alone drifts the moment
 * anything is deleted: three edges minus the middle one is a list of length
 * two, so `length + 1` mints the id the untouched third edge already has.
 * One minting strategy for both node and edge ids — see `nextNodeId` and
 * `nextEdgeId` below — so this file never mints an id two different ways. */
function nextId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** An id unique within this flow. Node ids are local to a flow. */
function nextNodeId(flow: Flow): string {
  return nextId("n", new Set(flow.nodes.map((x) => x.id)));
}

/** An id unique within this flow. Edge ids are local to a flow, and must stay
 * unique even after a delete: `deleteEdge`, `setCond` and the inspector's own
 * `flow.edges.find` all key off this id, so two edges sharing one silently
 * merge into whichever the code touches first. */
function nextEdgeId(flow: Flow): string {
  return nextId("e", new Set(flow.edges.map((x) => x.id)));
}

/** The tray shows what a condition can attach to: a place already on disk, or
 * work not yet launched. A pure `notify` terminal is neither, so it never
 * appears here. */
function isAgentNode(n: FlowNode): n is PlaceNode | PlannedNode {
  return n.kind !== "notify";
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
  const flow = p.flows.find((f) => f.id === p.openId);
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

  const places = flow.nodes.filter((n) => n.kind !== "notify").length;
  /** How many rules cannot advance. Driven by the edges' own `error` — the half of
   * `isSettled` that means "tried and failed" rather than "ran". An armed flow with
   * one of these is not simply watching, and the footer must not say it is. */
  const stalled = flow.edges.filter((e) => e.error !== undefined).length;
  // Reported by the host on `deck:flows`, keyed by flow id — never a second
  // source of truth for whether rules are met, only for whether the user has
  // yet said "go" on what already is.
  const resume = p.pendingResume.find((r) => r.flowId === flow.id) ?? null;

  const attachAt = (raw: string, x: number, y: number) => {
    const parsed = parseDrag(raw);
    if (!parsed) return;
    // The same place twice would give two nodes that can never disagree.
    const dup = flow.nodes.some(
      (n) => n.kind === "place" && n.runKey === parsed.runKey && n.repo === parsed.repo,
    );
    if (dup) return;
    p.onSave({
      ...flow,
      nodes: [
        ...flow.nodes,
        { id: nextNodeId(flow), kind: "place", x, y, join: "any", ...parsed },
      ],
    });
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
    setSel(id);
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

  const finishWire = (toId: string) => {
    const from = wiring;
    setWiring(null);
    if (!from || from === toId) return;
    if (flow.edges.some((e) => e.from === from && e.to === toId)) return;
    const id = nextEdgeId(flow);
    const edge: FlowEdge = { id, from, to: toId, cond: { kind: "pr-merged" }, action: "notify" };
    setSelEdge(id);
    p.onSave({ ...flow, edges: [...flow.edges, edge] });
  };

  const addNotify = () =>
    p.onSave({
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

  const onTidy = () => p.onSave({ ...flow, nodes: tidy(flow) });

  const edge = flow.edges.find((e) => e.id === selEdge) ?? null;
  // Computed once here, not inline in the JSX below: it needs `edge` narrowed
  // to non-null, which the ternary in the render already does, but a `const`
  // cannot be declared in the middle of a JSX expression.
  const mismatch = edge ? actionMismatch(flow, edge) : null;
  /** The destination select's value, resolved without a non-null assertion:
   * this is only ever rendered once `mismatch` is null and `edge.action` is
   * `launch`, which together guarantee a planned target exists — but nothing
   * in the type system knows that at the render site, so the fallback is
   * purely to satisfy `LaunchDest`'s type, never a value the user can see. */
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

  const setCond = (e: FlowEdge, kind: Condition["kind"]) => {
    const next = withCond(flow, e.id, kind);
    // `withCond` returns `flow` itself (the same reference) for the two
    // parameterised kinds the dropdown never offers — see its own doc
    // comment. Checking identity here, rather than re-deriving the guard,
    // is what keeps that one rule living in exactly one place.
    if (next !== flow) p.onSave(next);
  };

  const setAction = (e: FlowEdge, action: FlowAction) => p.onSave(withAction(flow, e.id, action, p.promptModes));

  const setMode = (e: FlowEdge, mode: string) => p.onSave(withMode(flow, e, mode));

  const setDest = (e: FlowEdge, dest: LaunchDest) => p.onSave(withDest(flow, e, dest));

  const setNotifyMessage = (e: FlowEdge, message: string) => p.onSave(withNotifyMessage(flow, e, message));

  const deleteEdge = (e: FlowEdge) => {
    setSelEdge(null);
    p.onSave(withoutEdge(flow, e.id));
  };

  /** What actually renders. Expand does not touch `width` — see the
   * `expanded` state's own doc comment — so this ternary IS the whole
   * mechanism: collapsing needs no separate "restore" step because `width`
   * was never overwritten to begin with. */
  const renderWidth = expanded ? fullOrchWidth() : width;

  return (
    <aside className="orch" aria-label="Orchestrator" style={{ ["--orch-w" as any]: `${renderWidth}px` }}>
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
            {places} {places === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
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
          // The keyboard path — see flowList.tsx's own header comment for why
          // it exists and what it deliberately does not (yet) do. Same `flow`
          // prop, same `onSave`/`onResetEdge` this canvas already uses: no
          // second model, no second write path.
          <FlowList
            flow={flow}
            runs={p.runs}
            promptModes={p.promptModes}
            onSave={p.onSave}
            onResetEdge={(edgeId) => p.onResetEdge(flow.id, edgeId)}
          />
        ) : (
          <>
        <div className="orch-sect">
          <div className="orch-sect-hd">
            <span className="t">Agents</span>
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
              <span className="hint">Drag a card from the board to attach an agent.</span>
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
        <div className="orch-bar">
          <span className="t" style={{ fontSize: "var(--t-micro)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--dim)" }}>
            Graph
          </span>
          <div className="sp" />
          <button type="button" className="orch-mini" onClick={onTidy}>Tidy</button>
          <button type="button" className="orch-mini" onClick={addNotify}>+ Notify</button>
          <button type="button" className="orch-mini" onClick={addPlanned}>+ Add planned work</button>
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
                  <span className="k">
                    {n.kind === "place" ? n.runKey : n.kind === "planned" ? n.ticketKey : "notify"}
                  </span>
                </div>
                <div className="st">
                  {n.kind === "place" ? n.repo : n.kind === "planned" ? "not taken" : n.message}
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
            const mid = labelPoint(anchor(boxOf(a), "out"), anchor(boxOf(b), "in"), obstacles);
            return (
              <button
                type="button"
                key={e.id}
                data-testid={`orch-edge-${e.id}`}
                className={`orch-edge${selEdge === e.id ? " sel" : ""}${BAD_CONDS.has(e.cond.kind) ? " bad" : ""}`}
                style={{ left: `${mid.x}px`, top: `${mid.y}px` }}
                onClick={() => setSelEdge(e.id)}
              >
                {COND_LABEL[e.cond.kind]}
              </button>
            );
          })}
        </div>
        {!edge ? (
          <div className="orch-insp none" data-testid="orch-inspector">
            Select a connection to set its condition.
          </div>
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
                {OFFERED_CONDS.map((k) => (
                  <option key={k} value={k}>{COND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div className="orch-clause">
              <span className="orch-kw">THEN</span>
              <select
                className="orch-sel"
                aria-label="Action"
                value={edge.action}
                onChange={(ev) => setAction(edge, ev.currentTarget.value as FlowAction)}
              >
                <option value="launch">{ACTION_LABEL.launch}</option>
                <option value="seed">{ACTION_LABEL.seed}</option>
                <option value="notify">{ACTION_LABEL.notify}</option>
              </select>
              {/* The target's name — an identifier, so mono — is part of the
                  sentence for the two acting verbs ("THEN launch ASM-12"), but
                  notify already reads complete on its own ("THEN notify me"). */}
              {edge.action !== "notify" && (
                <span className="k" style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, edge.to)}</span>
              )}
            </div>
            {edge.action === "notify" ? (
              <div className="orch-clause">
                <input
                  className="orch-msg"
                  aria-label="Notify message"
                  key={edge.id}
                  defaultValue={notifyMessageOf(flow, edge)}
                  onBlur={(ev) => setNotifyMessage(edge, ev.currentTarget.value)}
                />
              </div>
            ) : mismatch ? (
              // Say so now, rather than let the user build a rule the engine
              // will always refuse later — see `actionMismatch`'s own doc
              // comment. Not red: nothing has tried and failed yet, so
              // `--c-danger` (reserved for exactly that, in `.orch-obs .err`
              // below) would be a claim this state does not make.
              <div className="orch-clause">
                <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>{mismatch}</span>
              </div>
            ) : (
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
                {edge.action === "launch" && (
                  <>
                    <span style={{ fontSize: "var(--t-body)" }}>in a</span>
                    <select
                      className="orch-sel"
                      aria-label="Destination"
                      value={launchDest ?? "worktree"}
                      onChange={(ev) => setDest(edge, ev.currentTarget.value as LaunchDest)}
                    >
                      <option value="worktree">worktree</option>
                      <option value="new-window">new window</option>
                      <option value="current-window">current window</option>
                    </select>
                  </>
                )}
              </div>
            )}
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
                    <span className="err">{edge.error}</span>
                  ) : (
                    <span className="fired">{edge.firedNote ?? "fired"}</span>
                  )}
                  <div className="sp" />
                  <button type="button" className="orch-mini" onClick={() => p.onResetEdge(flow.id, edge.id)}>Reset</button>
                </>
              ) : (
                <span>{observationOf(flow, edge, p.runs) ?? "this card is not on the board right now"}</span>
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
            Disarmed is left alone: "Not armed" makes no claim to correct. */}
        <span className={`live${flow.armed ? " on" : ""}${flow.armed && stalled > 0 ? " stalled" : ""}`}>
          <span className="d" />
          {!flow.armed
            ? "Not armed"
            : stalled > 0
              ? `Armed · ${stalled} ${stalled === 1 ? "rule" : "rules"} stalled`
              : `Armed · watching ${places} ${places === 1 ? "node" : "nodes"}`}
        </span>
        <div className="sp" />
        <span>
          {places} {places === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
          {flow.edges.length === 1 ? "rule" : "rules"}
        </span>
      </div>
    </aside>
  );
}
