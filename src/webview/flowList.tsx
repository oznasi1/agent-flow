// The keyboard path onto a flow. A canvas built from divs and pointer events
// (OrchestratorDrawer.tsx's graph) has no usable keyboard story of its own —
// there is no browser-native tab order over an absolutely-positioned node you
// drag with a pointer. Shipping the graph as the only way to edit a flow
// would make the whole feature unreachable without a mouse, which is why this
// file exists at all (see the design doc's own words, quoted in this phase's
// task brief).
//
// "One model, two presentations": this component takes the SAME `Flow` and
// writes back through the SAME `onSave`/`onResetEdge` the canvas already
// uses. Every read of what a rule means (its condition's wording, whether its
// action is even possible for its target, what a fired rule's receipt says)
// and every write of an edit comes from orchestratorRule.ts, which
// OrchestratorDrawer.tsx's own inspector shares — not a second copy of either
// living in this file. A second copy, even a faithful one today, is exactly
// the drift "one model, two presentations" is warning against.
import * as React from "react";
import { Condition, Flow, FlowAction, FlowEdge, isSettled, LaunchDest } from "../engine/orchestrator/model";
import { FlowPromptMode, RunStatus } from "../types";
import {
  ACTION_LABEL,
  actionMismatch,
  COND_LABEL,
  endLabel,
  launchDestOf,
  modeDisplayLabel,
  modeValueOf,
  notifyMessageOf,
  OFFERED_CONDS,
  withAction,
  withCond,
  withDest,
  withMode,
  withNotifyMessage,
  withoutEdge,
} from "./orchestratorRule";

const DEST_LABEL: Record<LaunchDest, string> = {
  worktree: "worktree",
  "new-window": "new window",
  "current-window": "current window",
};

export interface FlowListProps {
  flow: Flow;
  /** Unused today — kept in the prop list because the canvas's own props
   * carry it (`OrchestratorDrawerProps.runs`) and "same callbacks the canvas
   * already uses" (this task's own brief) means the same SHAPE, not a
   * narrower one invented for this file. A future row that shows what a
   * place currently looks like (the inspector's `observationOf`) reads it
   * from here rather than this file growing a second prop for it later. */
  runs: RunStatus[];
  promptModes: FlowPromptMode[];
  onSave: (flow: Flow) => void;
  onResetEdge: (edgeId: string) => void;
}

/** The sentence a row reads as, and — when `open` — the ordinary form
 * controls that edit it. Not a component of its own: it closes over `flow`/
 * `onSave`/`promptModes` from `FlowList` rather than re-accepting them as
 * props, because nothing else ever renders a rule's sentence on its own. */
function ruleSentence(
  flow: Flow,
  e: FlowEdge,
  open: boolean,
  promptModes: FlowPromptMode[],
  onSave: (f: Flow) => void,
): JSX.Element {
  const mismatch = actionMismatch(flow, e);
  const modeValue = modeValueOf(flow, e);
  const modeExists = modeValue !== "" && promptModes.some((m) => m.id === modeValue);
  const dest = launchDestOf(flow, e) ?? "worktree";

  const setCond = (kind: Condition["kind"]) => {
    const next = withCond(flow, e.id, kind);
    // See `withCond`'s own doc comment: it hands back `flow` itself, the
    // same reference, for the two kinds this picker never offers.
    if (next !== flow) onSave(next);
  };

  return (
    <>
      <span className="orch-kw">WHEN</span>
      {open ? (
        <select
          className="orch-sel"
          aria-label="Condition"
          value={e.cond.kind}
          onChange={(ev) => setCond(ev.currentTarget.value as Condition["kind"])}
        >
          {OFFERED_CONDS.map((k) => (
            <option key={k} value={k}>{COND_LABEL[k]}</option>
          ))}
        </select>
      ) : (
        <span>{COND_LABEL[e.cond.kind]}</span>
      )}

      <span className="orch-kw">THEN</span>
      {open ? (
        <select
          className="orch-sel"
          aria-label="Action"
          value={e.action}
          onChange={(ev) => onSave(withAction(flow, e.id, ev.currentTarget.value as FlowAction, promptModes))}
        >
          <option value="launch">{ACTION_LABEL.launch}</option>
          <option value="seed">{ACTION_LABEL.seed}</option>
          <option value="notify">{ACTION_LABEL.notify}</option>
        </select>
      ) : (
        <span>{ACTION_LABEL[e.action]}</span>
      )}
      {/* Same rule the inspector follows: notify already reads complete on
          its own ("THEN notify me"); the other two verbs need the target's
          identifier — mono, house style for an identifier — to finish the
          clause. */}
      {e.action !== "notify" && <span style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, e.to)}</span>}

      {e.action === "notify" ? (
        open ? (
          <input
            className="orch-msg"
            aria-label="Notify message"
            key={e.id}
            defaultValue={notifyMessageOf(flow, e)}
            onBlur={(ev) => onSave(withNotifyMessage(flow, e, ev.currentTarget.value))}
          />
        ) : (
          <span>&ldquo;{notifyMessageOf(flow, e)}&rdquo;</span>
        )
      ) : mismatch ? (
        // Not red — nothing has tried and failed yet, matching the inspector's
        // own reasoning for the identical case (see actionMismatch's doc
        // comment in orchestratorRule.ts).
        <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>{mismatch}</span>
      ) : (
        <>
          <span className="orch-kw">USING</span>
          {open ? (
            <select
              className="orch-sel"
              aria-label="Mode"
              value={modeValue}
              onChange={(ev) => onSave(withMode(flow, e, ev.currentTarget.value))}
            >
              {!modeExists && <option value={modeValue}>{modeDisplayLabel(promptModes, modeValue)}</option>}
              {promptModes.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          ) : (
            <span>{modeDisplayLabel(promptModes, modeValue)}</span>
          )}
          {/* A place already exists, so `seed` has nothing to pick a
              destination for — only `launch` opens one, same as the
              inspector. */}
          {e.action === "launch" && (
            <>
              <span style={{ fontSize: "var(--t-body)" }}>in a</span>
              {open ? (
                <select
                  className="orch-sel"
                  aria-label="Destination"
                  value={dest}
                  onChange={(ev) => onSave(withDest(flow, e, ev.currentTarget.value as LaunchDest))}
                >
                  <option value="worktree">worktree</option>
                  <option value="new-window">new window</option>
                  <option value="current-window">current window</option>
                </select>
              ) : (
                <span>{DEST_LABEL[dest]}</span>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

export function FlowList(p: FlowListProps): JSX.Element {
  const { flow } = p;

  /** Which row Up/Down currently sits on. Not necessarily in range once a
   * Delete has shrunk `flow.edges` — see `focusedIndex` below, which clamps
   * it for every read. Kept as its own piece of state (rather than always
   * deriving it from DOM focus) so a row still knows which of its siblings
   * to move to on ArrowDown/Up without asking the DOM first. */
  const [focusedIndexRaw, setFocusedIndexRaw] = React.useState(0);
  /** The one row currently open for editing, or `null`. At most one at a
   * time — this is what lets every open-row control below use a plain
   * `aria-label` ("Condition", "Action", ...) without colliding: a list of
   * near-identical rows is exactly where a query for "the" Condition select
   * would otherwise match more than one element. */
  const [openId, setOpenId] = React.useState<string | null>(null);
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const rows = flow.edges;
  // Clamped on every read, not just after a delete: it is cheap, and it means
  // nothing else in this file has to remember to re-clamp it.
  const focusedIndex = Math.min(focusedIndexRaw, Math.max(rows.length - 1, 0));

  /** Roving tabindex: exactly ONE row (`focusedIndex`) carries `tabIndex={0}`;
   * every other row carries `tabIndex={-1}`. Tab lands on the list once, at
   * whichever row is "current"; Up/Down then move `focusedIndex` (and the
   * real DOM focus alongside it, imperatively, in the handlers below) without
   * ever touching the Tab order itself. The alternative — every row
   * `tabIndex={0}` — is what a screen reader or keyboard user would actually
   * feel: a 20-rule flow would cost twenty separate Tab presses just to get
   * past the list to whatever comes after it. One stop in, arrow around
   * inside, one stop out. */
  const rowTabIndex = (i: number): 0 | -1 => (i === focusedIndex ? 0 : -1);

  const onDeleteRule = (i: number, e: FlowEdge) => {
    if (openId === e.id) setOpenId(null);
    // The DOM node that survives the delete — the row sliding UP into this
    // slot (`i + 1`, in the array as it stands right NOW, before removal) if
    // there is one, else the row that was already just above it. Focusing it
    // before calling `onSave` matters: React reconciles the shorter array by
    // key, so this exact node keeps the DOM focus it already has rather than
    // the browser dropping focus to <body> the instant the deleted row's own
    // node unmounts.
    const stays = i + 1 < rows.length ? i + 1 : Math.max(i - 1, 0);
    rowRefs.current[stays]?.focus();
    setFocusedIndexRaw(i + 1 < rows.length ? i : Math.max(i - 1, 0));
    p.onSave(withoutEdge(flow, e.id));
  };

  const onRowKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>, i: number, e: FlowEdge) => {
    // Escape is handled regardless of which descendant inside an OPEN row
    // actually has focus — pressing it while typing the notify message must
    // still close the row, not merely bubble past the input as text. It is
    // the one row-level key that isn't itself a list-navigation action.
    if (ev.key === "Escape") {
      if (openId !== e.id) return;
      ev.preventDefault();
      setOpenId(null);
      rowRefs.current[i]?.focus();
      return;
    }
    // Every key below IS a list-navigation action, and none of them may fire
    // from inside an open row's own controls: ArrowDown/Up inside a <select>
    // changes ITS value (the browser's native behaviour), Delete inside the
    // notify-message <input> deletes a character, and Enter/Space on a
    // <button> activates it. Without this guard, this row-level handler
    // would ALSO treat every one of those as "move to the next row" / "delete
    // the whole rule" / "open (already-open) editing" the moment the bubbled
    // event reached it.
    if (ev.target !== ev.currentTarget) return;
    switch (ev.key) {
      case "ArrowDown": {
        ev.preventDefault();
        const next = Math.min(i + 1, rows.length - 1);
        setFocusedIndexRaw(next);
        rowRefs.current[next]?.focus();
        break;
      }
      case "ArrowUp": {
        ev.preventDefault();
        const prev = Math.max(i - 1, 0);
        setFocusedIndexRaw(prev);
        rowRefs.current[prev]?.focus();
        break;
      }
      case "Enter":
      case " ":
        ev.preventDefault();
        setOpenId(e.id);
        break;
      case "Delete":
        ev.preventDefault();
        onDeleteRule(i, e);
        break;
      default:
        break;
    }
  };

  if (rows.length === 0) {
    // Not a hint line on a card (the house rule those forbid) — an empty
    // state for the list itself, the same job `.orch-empty` does for the
    // canvas when a flow has no nodes yet.
    return (
      <div className="orch-empty" data-testid="flowlist-empty">
        No rules yet. Switch to Canvas and connect two nodes to add one.
      </div>
    );
  }

  return (
    <div className="fl-list" role="list" aria-label="Rules" data-testid="orch-list">
      {rows.map((e, i) => {
        const open = openId === e.id;
        const settled = isSettled(e);
        return (
          <div
            key={e.id}
            ref={(el) => { rowRefs.current[i] = el; }}
            data-testid={`flowlist-row-${e.id}`}
            className={`fl-row${open ? " open" : ""}`}
            role="listitem"
            tabIndex={rowTabIndex(i)}
            onKeyDown={(ev) => onRowKeyDown(ev, i, e)}
            onClick={() => {
              setFocusedIndexRaw(i);
              setOpenId(e.id);
            }}
          >
            {/* Clicks on a control inside an open row (a <select>, the Reset
                button) bubble here too — stopping them keeps a control click
                from also re-running the row's own onClick, which does
                nothing harmful today (it would just re-set state already at
                these values) but would stop being harmless the moment this
                row's onClick grows anything with a side effect beyond
                opening. */}
            <div className="fl-sentence" onClick={(ev) => ev.stopPropagation()}>
              {ruleSentence(flow, e, open, p.promptModes, p.onSave)}
            </div>
            {settled && (
              <div className="fl-receipt" onClick={(ev) => ev.stopPropagation()}>
                {/* Error wins over a receipt when a hand-edited flow somehow
                    carries both — same tie-break as the inspector's, for the
                    same reason: a failure is the more important claim. */}
                {e.error !== undefined ? (
                  <span className="err">{e.error}</span>
                ) : (
                  <span className="fired">{e.firedNote ?? "fired"}</span>
                )}
                <button type="button" className="orch-mini" onClick={() => p.onResetEdge(e.id)}>
                  Reset
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
