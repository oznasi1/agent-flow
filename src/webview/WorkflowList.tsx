// The Active list: every card that carries a workflow, in one place, so a
// reader does not have to open each card's drawer to see where its workflow
// stands. `DeckApp` derives the rows (order is a board concern — precedence
// depends on `workflowState`, computed once per card the same way the board's
// own chip is) and mounts this; this file only renders what it is handed.
//
// Pure presentation, same discipline `WorkflowBlock.tsx` states for itself:
// every effect a click has leaves through a prop, and no wording here is a
// second copy of a sentence the engine or `WorkflowBlock` already spells.
// `STATUS_LABEL` is imported from there rather than re-typed — the same five
// statuses read the same words in the drawer and in this list.
import * as React from "react";
import type { CardWorkflow } from "../engine/orchestrator/attach";
import { STATUS_LABEL } from "./WorkflowBlock";

export interface WorkflowRow {
  /** The card's own id, as `DeckApp` keys cards — what `onOpen` hands back. */
  cardId: string;
  /** The ticket key as the board shows it, already resolved by the caller. */
  ticketKey: string;
  title: string;
  workflow: CardWorkflow;
}

export interface WorkflowListProps {
  /** Already sorted by the caller. Ordering is a board concern that depends on
   * `workflowState`, and a component that both sorts and renders cannot be
   * tested for either alone — see this file's own test for the contract this
   * pins. */
  rows: WorkflowRow[];
  onOpen: (cardId: string) => void;
}

export function WorkflowList({ rows, onOpen }: WorkflowListProps): JSX.Element {
  if (rows.length === 0) {
    return <p className="wfl-empty">No workflows attached anywhere.</p>;
  }

  return (
    <ul role="list" className="wfl-list">
      {rows.map((r) => {
        const { flow, state } = r.workflow;
        return (
          <li key={r.cardId} className="wfl-row" data-status={state.status}>
            <button type="button" className="wfl-open" onClick={() => onOpen(r.cardId)}>
              <span className="wfl-ticket">{r.ticketKey}</span>
              <span className="wfl-title">{r.title}</span>
              <span className="wf-name">{flow.name}</span>
              <span className={`wf-chip wf-${state.status}`}>{STATUS_LABEL[state.status]}</span>
              <span className="wf-count">{state.done} of {state.total}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
