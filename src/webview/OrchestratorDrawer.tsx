import * as React from "react";
import { Flow, FlowNode, PlaceNode, PlannedNode } from "../engine/orchestrator/model";
import { RunStatus } from "../types";

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
  if (!flow) return null;

  const places = flow.nodes.filter((n) => n.kind !== "notify").length;

  const attach = (raw: string) => {
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
        { id: nextNodeId(flow), kind: "place", x: 24, y: 24 + flow.nodes.length * 88, join: "any", ...parsed },
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
            onDrop={(e) => { e.preventDefault(); setOver(false); attach(e.dataTransfer.getData("text/plain")); }}
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
        {flow.nodes.length === 0 ? (
          <div className="orch-empty">
            Drag a card from the board to add it to this flow,<br />
            then connect two nodes to put a condition between them.
          </div>
        ) : null}
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
