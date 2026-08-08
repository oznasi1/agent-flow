import * as React from "react";
import { describeCond, placeActivity } from "../engine/orchestrator/conditions";
import { anchor, edgePath, labelPoint, NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Condition, Flow, FlowAction, FlowEdge, FlowNode, isSettled, LaunchDest, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { AgentState, FlowPromptMode, PendingResume, RunStatus } from "../types";

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

/** The drawer's own wording for a condition. `describeCond` says what a place
 * currently looks like; this says what the rule is. Both are needed and they are
 * not the same sentence. */
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
};

/** Conditions that describe something being wrong. The only edges allowed a
 * danger tint — colour here is attention debt, not decoration. */
const BAD_CONDS = new Set<Condition["kind"]>(["ci-failed", "changes-requested", "pr-conflicting"]);

/** What the inspector offers. `agent-idle-over` and `ticket-status-is` each carry
 * a parameter (a minute count, a status name) and this phase has no input for
 * one — offering them would create a rule waiting on a fixed 10 minutes or on the
 * empty string, which never matches. They stay in `COND_LABEL` because a flow
 * hand-edited on disk can still hold one and its edge must still render. */
export const OFFERED_CONDS: Condition["kind"][] = (
  Object.keys(COND_LABEL) as Condition["kind"][]
).filter((k) => k !== "agent-idle-over" && k !== "ticket-status-is");

/** How a node's end reads in the inspector's title. */
function endLabel(flow: Flow, id: string): string {
  const n = flow.nodes.find((x) => x.id === id);
  if (!n) return "?";
  return n.kind === "place" ? n.runKey : n.kind === "planned" ? n.ticketKey : "notify";
}

/** The message the edge's notify target carries, or empty when the target is
 * not a notify node. */
function notifyMessageOf(flow: Flow, e: FlowEdge): string {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "notify" ? n.message : "";
}

/** The edge's target, narrowed to a planned node — or `undefined` when it
 * points at anything else. A launch's prompt mode and destination live on
 * exactly this node (see `PlannedNode`'s own doc comment: "an armed launch
 * cannot stop to ask"), never on the edge, so every read and write of them
 * goes through here rather than a cast at each call site. */
function plannedTargetOf(flow: Flow, e: FlowEdge): PlannedNode | undefined {
  const n = flow.nodes.find((x) => x.id === e.to);
  return n && n.kind === "planned" ? n : undefined;
}

/** Why `launch` or `seed` on this edge would never run, given the kind of node
 * it actually points at — or `null` when the pairing is fine. This is exactly
 * what `deckView.ts`'s `performEdge`/`performSeed` refuse at evaluation time
 * ("a launch rule must point at planned work" / "a seed rule must point at a
 * place"); saying it here means a mis-wired rule is visible the moment it is
 * made, not only once armed and it comes back as a stalled edge. */
function actionMismatch(flow: Flow, e: FlowEdge): string | null {
  if (e.action === "launch" && !plannedTargetOf(flow, e)) {
    return "a launch needs planned work — this points at something already there.";
  }
  if (e.action === "seed" && flow.nodes.find((x) => x.id === e.to)?.kind !== "place") {
    return "a seed needs a place that already exists — this points at planned work.";
  }
  return null;
}

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
  const launchDest = edge && edge.action === "launch" ? plannedTargetOf(flow, edge)?.dest : undefined;

  /** What the source place looks like right now, in `describeCond`'s words. Null
   * when the node's run is not on the board — a claim we cannot make. */
  const observation = (e: FlowEdge): string | null => {
    const from = flow.nodes.find((n) => n.id === e.from);
    if (!from || from.kind !== "place") return null;
    const status = p.runs.find((r) => r.run.key === from.runKey);
    if (!status) return null;
    return describeCond(e.cond, { status, repo: from.repo, nowMs: Date.now() });
  };

  const setCond = (e: FlowEdge, kind: Condition["kind"]) => {
    // Only bare kinds are reachable from the dropdown (see OFFERED_CONDS), so the
    // parameterised arms cannot be constructed here without a value to put in them.
    if (kind === "agent-idle-over" || kind === "ticket-status-is") return;
    const cond: Condition = { kind };
    p.onSave({ ...flow, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, cond } : x)) });
  };

  /** Change what the edge does. `notify` clears `mode` — the only field a
   * verb switch can leave stale, since a `notify` edge spends nothing and the
   * engine would otherwise carry forward a value it never reads again.
   * Switching TO `launch` or `seed` seeds `mode` from whatever is already
   * live for this pairing (the edge's own value, or — for a launch — its
   * target's, since a planned node is never created without one) rather than
   * leaving the selector on nothing the instant the verb changes. */
  const setAction = (e: FlowEdge, action: FlowAction) => {
    if (action === "notify") {
      p.onSave({ ...flow, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, action, mode: undefined } : x)) });
      return;
    }
    const target = plannedTargetOf(flow, e);
    const mode = e.mode ?? target?.mode ?? p.promptModes[0]?.id;
    p.onSave({ ...flow, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, action, mode } : x)) });
  };

  /** Write a chosen prompt mode where the engine actually spends it.
   * `performSeed` in deckView.ts reads `edge.mode` — a place has no mode
   * field of its own, so the edge is the only place a seed's mode CAN live.
   * `performEdge` reads a launch's mode from `node.mode` on the target
   * PLANNED node instead, never from the edge — so a launch's selection is
   * written there too, kept in step with `edge.mode` rather than landing
   * somewhere the engine silently ignores (the same trap `notify`'s clear,
   * above, closes from the other side). */
  const setMode = (e: FlowEdge, mode: string) => {
    const target = plannedTargetOf(flow, e);
    const nodes = e.action === "launch" && target
      ? flow.nodes.map((n) => (n.id === target.id ? { ...n, mode } : n))
      : flow.nodes;
    p.onSave({ ...flow, nodes, edges: flow.edges.map((x) => (x.id === e.id ? { ...x, mode } : x)) });
  };

  /** A launch's destination lives on its target planned node — `LaunchDest`
   * has no edge-level counterpart in the model (`FlowEdge` carries no `dest`
   * field at all), because it is the node's own launch configuration, not a
   * property of any one rule that triggers it. */
  const setDest = (e: FlowEdge, dest: LaunchDest) =>
    p.onSave({
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === e.to && n.kind === "planned" ? { ...n, dest } : n)),
    });

  const setNotifyMessage = (e: FlowEdge, message: string) =>
    p.onSave({
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === e.to && n.kind === "notify" ? { ...n, message } : n)),
    });

  const deleteEdge = (e: FlowEdge) => {
    setSelEdge(null);
    p.onSave({ ...flow, edges: flow.edges.filter((x) => x.id !== e.id) });
  };

  return (
    <aside className="orch" aria-label="Orchestrator">
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
          <button type="button" className="orch-x" aria-label="Close" onClick={p.onClose}>✕</button>
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
            const mid = labelPoint(anchor(boxOf(a), "out"), anchor(boxOf(b), "in"));
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
                <option value="launch">launch</option>
                <option value="seed">seed</option>
                <option value="notify">notify me</option>
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
                  value={edge.mode ?? ""}
                  onChange={(ev) => setMode(edge, ev.currentTarget.value)}
                >
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
                <span>{observation(edge) ?? "this card is not on the board right now"}</span>
              )}
            </div>
          </div>
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
