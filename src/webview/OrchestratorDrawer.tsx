import * as React from "react";
import { NODE_H, NODE_W, snap, tidy } from "../engine/orchestrator/layout";
import { Flow, FlowNode, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
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
 * width in orchestratorStyles.ts — the anchor maths needs the real box, and the
 * two are the same number in two languages. */
const NOTIFY_W = 138;

const STATE_HUE: Record<AgentState, string> = {
  working: "var(--c-progress)",
  "needs-you": "var(--c-attn)",
  idle: "var(--c-idle)",
  unknown: "var(--dim)",
};

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

  const addNotify = () =>
    p.onSave({
      ...flow,
      nodes: [...flow.nodes, { id: nextNodeId(flow), kind: "notify", x: 320, y: 24, join: "any", message: "say something" }],
    });

  const onTidy = () => p.onSave({ ...flow, nodes: tidy(flow) });

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
          className={`orch-graph${overGraph ? " over" : ""}`}
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
        >
          {flow.nodes.length === 0 && (
            <div className="orch-empty" style={{ border: 0, position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              Drag a card from the board to add a node,<br />
              then connect two nodes to put a condition between them.
            </div>
          )}
          {flow.nodes.map((n) => {
            const pos = posOf(n);
            const st = nodeState(n, p.runs);
            return (
              <div
                key={n.id}
                data-testid={`orch-node-${n.id}`}
                className={`orch-node${n.kind === "planned" ? " plan" : ""}${n.kind === "notify" ? " notify" : ""}${sel === n.id ? " sel" : ""}`}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                onPointerDown={(e) => startDrag(n.id, e)}
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
              </div>
            );
          })}
        </div>
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
