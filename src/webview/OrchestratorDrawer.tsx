import * as React from "react";
import { describeCond } from "../engine/orchestrator/conditions";
import { anchor, edgePath, labelPoint, NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Condition, Flow, FlowEdge, FlowNode, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { AgentState, RunStatus } from "../types";

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

/** An id unique within this flow. Node ids are local to a flow, so a counter
 * over the existing ids is enough and keeps them readable. */
function nextNodeId(flow: Flow): string {
  let n = flow.nodes.length + 1;
  const taken = new Set(flow.nodes.map((x) => x.id));
  while (taken.has(`n${n}`)) n++;
  return `n${n}`;
}

/** The tray shows what a condition can attach to: a place already on disk, or
 * work not yet launched. A pure `notify` terminal is neither, so it never
 * appears here. */
function isAgentNode(n: FlowNode): n is PlaceNode | PlannedNode {
  return n.kind !== "notify";
}

/** A node's live state, from the card it points at. `undefined` when the node is
 * not a place, or its run is not on the board — the node is still drawn, just
 * without a claim about it. Takes the union directly so no cast is needed. */
function nodeState(node: FlowNode, runs: RunStatus[]): AgentState | undefined {
  if (node.kind !== "place") return undefined;
  return runs.find((r) => r.run.key === node.runKey)?.agent.state;
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

export interface OrchestratorDrawerProps {
  flows: Flow[];
  /** Which flow is open. `null` closes the drawer. */
  openId: string | null;
  /** Every card on the board, so the tray and canvas can resolve a node's live
   * state and the inspector can say what a condition is currently waiting on. */
  runs: RunStatus[];
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: (flow: Flow) => void;
  onDelete: (id: string) => void;
}

export function OrchestratorDrawer(p: OrchestratorDrawerProps): JSX.Element | null {
  const flow = p.flows.find((f) => f.id === p.openId);
  const [picking, setPicking] = React.useState(false);
  const [over, setOver] = React.useState(false);
  const [overGraph, setOverGraph] = React.useState(false);
  const graphRef = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
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
      setDrag((d) => (d ? { ...d, x: snap(e.clientX - ox - d.dx), y: snap(e.clientY - oy - d.dy) } : d));
    };
    const up = () => {
      setDrag((d) => {
        if (d) {
          const orig = flow.nodes.find((n) => n.id === d.id);
          // Only a move that actually moved is worth a write.
          if (orig && (orig.x !== d.x || orig.y !== d.y)) {
            p.onSave({ ...flow, nodes: flow.nodes.map((n) => (n.id === d.id ? { ...n, x: d.x, y: d.y } : n)) });
          }
        }
        return null;
      });
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

  const removeNode = (id: string) =>
    p.onSave({
      ...flow,
      nodes: flow.nodes.filter((n) => n.id !== id),
      // An edge whose end is gone can never be evaluated, so it goes with it.
      edges: flow.edges.filter((e) => e.from !== id && e.to !== id),
    });

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
    const id = `e${flow.edges.length + 1}`;
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
              {/* notify is the only action this phase has. It is stated, not
                  offered as a choice of one. */}
              <span style={{ fontSize: "var(--t-body)" }}>notify me</span>
              <input
                className="orch-msg"
                aria-label="Notify message"
                key={edge.id}
                defaultValue={notifyMessageOf(flow, edge)}
                onBlur={(ev) => setNotifyMessage(edge, ev.currentTarget.value)}
              />
            </div>
            <div className="orch-obs">
              {observation(edge) ?? "this card is not on the board right now"}
            </div>
          </div>
        )}
      </div>

      <div className="orch-ft">
        <span>
          {places} {places === 1 ? "node" : "nodes"} · {flow.edges.length}{" "}
          {flow.edges.length === 1 ? "rule" : "rules"} · not armed
        </span>
        <div className="sp" />
        <span>arming arrives in the next phase</span>
      </div>
    </aside>
  );
}
