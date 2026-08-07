import * as React from "react";
import { Flow } from "../engine/orchestrator/model";
import { RunStatus } from "../types";

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
  if (!flow) return null;

  const places = flow.nodes.filter((n) => n.kind !== "notify").length;

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
