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
  DEST_LABEL,
  endLabel,
  launchDestOf,
  modeDisplayLabel,
  modeValueOf,
  nextEdgeId,
  NOTE_ARIA_LABEL,
  NOTE_PLACEHOLDER,
  notifyMessageOf,
  OFFERED_CONDS,
  OFFERED_DESTS,
  truncatedNote,
  withAction,
  withCond,
  withDest,
  withMode,
  withNote,
  withNotifyMessage,
  withoutEdge,
} from "./orchestratorRule";

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
  // Computed once here rather than at each of the two spots below that would
  // otherwise call it themselves — both a closed row's presence check and
  // its rendered text want the exact same string.
  const noteText = truncatedNote(e.note);

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
          {/* The note, right after the mode — a closed row shows it
              truncated (`truncatedNote`, empty for none), an open row edits
              it directly, same `withNote` the inspector writes through.
              Prose, so no mono; never a second filled control. */}
          {open ? (
            <input
              className="orch-msg"
              aria-label={NOTE_ARIA_LABEL}
              key={e.id}
              defaultValue={e.note ?? ""}
              placeholder={NOTE_PLACEHOLDER}
              onBlur={(ev) => onSave(withNote(flow, e, ev.currentTarget.value))}
            />
          ) : (
            noteText && <span>&ldquo;{noteText}&rdquo;</span>
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
                  {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
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

/** Add a rule, from the keyboard: the from-node, the to-node, the condition,
 * the action, and — where the action needs them — the mode and destination.
 * Ordinary form controls, the same as an open row's own.
 *
 * The target-kind guard is the SAME function the inspector and an open row
 * already use to explain a mismatch after the fact (`actionMismatch`) — here
 * it is asked BEFORE the rule exists rather than after, which is what turns
 * an explanation into a refusal: "Add rule" stays disabled and no `onSave`
 * happens while the chosen action and target disagree. Reusing the one
 * function rather than a second copy of the same rule is what keeps this
 * refusal from silently drifting apart from what the open row would say
 * about the very same pairing a moment later. */
function NewRuleBar(p: {
  flow: Flow;
  promptModes: FlowPromptMode[];
  onSave: (f: Flow) => void;
}): JSX.Element | null {
  const { flow, promptModes, onSave } = p;
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  // Narrowed to what `OFFERED_CONDS` actually offers — the two parameterised
  // kinds (`agent-idle-over`, `ticket-status-is`) need a value this bar has no
  // input for, same reason `OFFERED_CONDS` itself excludes them (see its own
  // doc comment in orchestratorRule.ts) — so the type this state can ever
  // hold never includes them, and building `{ kind: cond }` below is always a
  // complete `Condition` with no cast needed.
  const [cond, setCond] = React.useState<Exclude<Condition["kind"], "agent-idle-over" | "ticket-status-is">>(
    "pr-merged",
  );
  const [action, setAction] = React.useState<FlowAction>("notify");
  // Seeded from nothing in particular — there is no `to` chosen yet for
  // either to describe anything about. The moment a `to` (or the action) IS
  // chosen, the "To node"/"New rule action" handlers below reseed both from
  // `modeValueOf`/`launchDestOf` — what that node's own launch config, or
  // this brand-new edge, already says — rather than leaving these generic
  // defaults to be written over it. See `addRule`'s own comment for why that
  // distinction matters.
  const [mode, setMode] = React.useState(promptModes[0]?.id ?? "");
  const [dest, setDest] = React.useState<LaunchDest>("worktree");

  // A half-built rule belongs to the flow you were looking at when you
  // started it — switching flows (the "Flows · N ▾" switcher, still visible
  // while List is open) must not leave a draft's `from`/`to` pointing at node
  // ids that belong to whichever flow was open a moment ago. Keyed on
  // `flow.id`, not `flow` itself: every OTHER edit to the open flow (adding a
  // node, adding a rule) is a new `Flow` object too, and clearing the draft
  // on each of THOSE would undo the very thing this bar just did.
  React.useEffect(() => {
    setFrom("");
    setTo("");
    setCond("pr-merged");
    setAction("notify");
    setMode(promptModes[0]?.id ?? "");
    setDest("worktree");
    // eslint has no opinion in this repo (no config), but the omission of
    // `promptModes` is deliberate anyway: a config push mid-edit changing
    // which modes exist is not "the flow changed", and re-running this on
    // every `promptModes` identity change would be a second, unrelated
    // reason for a draft to reset.
  }, [flow.id]);

  /** What a freshly chosen `to`/`action` pairing already says about its mode
   * and destination — read through the SAME `modeValueOf`/`launchDestOf`
   * every other presentation of a rule uses, on a throwaway edge shaped like
   * the one about to be created. For `launch`, that means the target
   * PLANNED node's own `mode`/`dest` — set once, at Add planned work's four
   * QuickPicks, and never silently overwritten by a hardcoded default just
   * because a NEW rule happened to be the thing that wrote next. For `seed`,
   * there is no pre-existing value to protect (the mode lives on the edge
   * itself, which does not exist yet), so this reduces to the same
   * first-configured-mode fallback `withAction` already uses when an
   * existing edge is switched to `seed`. */
  const seedModeAndDest = (toId: string, act: FlowAction) => {
    const probe: FlowEdge = { id: "draft", from, to: toId, cond: { kind: cond }, action: act };
    setMode(modeValueOf(flow, probe) || promptModes[0]?.id || "");
    setDest(launchDestOf(flow, probe) ?? "worktree");
  };

  // Only a non-`notify` node ever had an out-port on the canvas (see
  // OrchestratorDrawer.tsx's own `orch-port out`, rendered for every node
  // except a notify terminal) — a notify node can never be a rule's source
  // here either, for the identical reason. No nodes at all, or nodes that are
  // ALL notify terminals, leaves nothing to build a rule from; there is
  // nothing useful this bar can offer in that case, so it renders nothing
  // rather than a picker with an empty "From" list and a permanently disabled
  // button.
  const sources = flow.nodes.filter((n) => n.kind !== "notify");
  if (sources.length === 0) return null;

  // Excludes `from` itself (no self-loop) and any node `from` already has an
  // edge to (the exact duplicate `finishWire`'s own wiring already refuses on
  // the canvas) — not by target KIND, which is what `mismatch` below decides
  // instead, with the one shared function, so this list and that guard can
  // never quietly disagree about the same pairing.
  const targets = flow.nodes.filter(
    (n) => n.id !== from && !flow.edges.some((e) => e.from === from && e.to === n.id),
  );

  const draft: FlowEdge | null = from && to ? { id: "draft", from, to, cond: { kind: cond }, action } : null;
  const mismatch = draft ? actionMismatch(flow, draft) : null;

  const addRule = () => {
    // `actionMismatch` only checks the TARGET's kind (a launch needs planned
    // work, a seed needs a place) — it has nothing to say about `from`/`to`
    // naming nodes that are not in THIS flow at all, and `notify` gives it no
    // kind to object to regardless. That gap is real, not hypothetical: `from`
    // and `to` are plain component state, and the effect above only clears
    // them when `flow.id` itself changes — every node/edge id still belongs to
    // whichever flow was open when the select was touched. Checked here again,
    // not folded into `actionMismatch`, because this is a different question
    // (does the node exist at all?) from the one that function answers (is
    // its kind the right one?) — and because a caller of `actionMismatch` for
    // an edge that already exists in `flow.edges` (the inspector, an open
    // list row) can never hit this case: its `from`/`to` are read off that
    // very edge, which cannot reference a node this same flow lacks.
    const fromExists = flow.nodes.some((n) => n.id === from);
    const toExists = flow.nodes.some((n) => n.id === to);
    if (!draft || mismatch || !fromExists || !toExists) return;
    const id = nextEdgeId(flow);
    const finalEdge: FlowEdge = { ...draft, id };
    let next: Flow = { ...flow, edges: [...flow.edges, finalEdge] };
    // `mode`/`dest` are seeded from the target's own truth the moment `to`
    // (or `action`) is chosen — see `seedModeAndDest` — so this write is a
    // no-op in the common case and an explicit, visible override in the
    // uncommon one. It is never a hardcoded default landing on a node whose
    // mode and destination were already chosen at Add planned work's own
    // QuickPicks; that silent overwrite was the bug this replaced.
    if (action === "seed") next = withMode(next, finalEdge, mode);
    if (action === "launch") {
      next = withMode(next, finalEdge, mode);
      next = withDest(next, finalEdge, dest);
    }
    onSave(next);
    setFrom("");
    setTo("");
    setCond("pr-merged");
    setAction("notify");
    // Reset too, not left to carry into the NEXT rule: `to` above always
    // clears back to "", so the next rule's own "To node" pick will reseed
    // these the moment it's made — but resetting here as well means nothing
    // is left showing a stale value in the gap before that pick happens.
    setMode(promptModes[0]?.id ?? "");
    setDest("worktree");
  };

  return (
    <div className="fl-newrule" data-testid="flowlist-newrule">
      <span className="orch-kw">WHEN</span>
      <select
        className="orch-sel"
        aria-label="From node"
        value={from}
        onChange={(ev) => { setFrom(ev.currentTarget.value); setTo(""); }}
      >
        <option value="">choose a node…</option>
        {sources.map((n) => <option key={n.id} value={n.id}>{endLabel(flow, n.id)}</option>)}
      </select>
      <select
        className="orch-sel"
        aria-label="New rule condition"
        value={cond}
        onChange={(ev) =>
          setCond(ev.currentTarget.value as Exclude<Condition["kind"], "agent-idle-over" | "ticket-status-is">)
        }
      >
        {OFFERED_CONDS.map((k) => <option key={k} value={k}>{COND_LABEL[k]}</option>)}
      </select>
      <span className="orch-kw">THEN</span>
      <select
        className="orch-sel"
        aria-label="New rule action"
        value={action}
        onChange={(ev) => {
          const val = ev.currentTarget.value as FlowAction;
          setAction(val);
          seedModeAndDest(to, val);
        }}
      >
        <option value="launch">{ACTION_LABEL.launch}</option>
        <option value="seed">{ACTION_LABEL.seed}</option>
        <option value="notify">{ACTION_LABEL.notify}</option>
      </select>
      <select
        className="orch-sel"
        aria-label="To node"
        value={to}
        onChange={(ev) => {
          const val = ev.currentTarget.value;
          setTo(val);
          seedModeAndDest(val, action);
        }}
      >
        <option value="">choose a node…</option>
        {targets.map((n) => <option key={n.id} value={n.id}>{endLabel(flow, n.id)}</option>)}
      </select>
      {mismatch ? (
        // Not red — see `actionMismatch`'s own doc comment: nothing has tried
        // and failed, there is simply nothing yet to build.
        <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>{mismatch}</span>
      ) : action !== "notify" ? (
        <>
          <span className="orch-kw">USING</span>
          <select
            className="orch-sel"
            aria-label="New rule mode"
            value={mode}
            onChange={(ev) => setMode(ev.currentTarget.value)}
          >
            {promptModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {action === "launch" && (
            <select
              className="orch-sel"
              aria-label="New rule destination"
              value={dest}
              onChange={(ev) => setDest(ev.currentTarget.value as LaunchDest)}
            >
              {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
            </select>
          )}
        </>
      ) : null}
      {/* `disabled` only for an INCOMPLETE draft (no from, or no to) — there is
          nothing yet to attempt. A mismatched one stays clickable, same as the
          tray's own drop handler stays a live target for a payload it is about
          to refuse (see OrchestratorDrawer.tsx's "ignores a malformed payload"
          case): the refusal itself is `addRule`'s own guard just below, right
          before it would ever call `onSave`, not a control disabled out from
          under a reason already printed a few pixels to its left. */}
      <button type="button" className="orch-mini" disabled={!draft} onClick={addRule}>
        + Add rule
      </button>
    </div>
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
  /** Where focus goes once the last rule is deleted and the empty state
   * below replaces the row list entirely. There is no row left to hand
   * focus to at that point — see `onDeleteRule`'s own comment — so this is
   * the deliberate landing spot, focused by the effect right below, rather
   * than letting the browser drop focus to <body> when the row that held it
   * unmounts. */
  const emptyRef = React.useRef<HTMLDivElement | null>(null);
  const wasEmpty = React.useRef(flow.edges.length === 0);

  const rows = flow.edges;
  React.useEffect(() => {
    // Fires only on the transition INTO empty — never on mount with an
    // already-empty flow (nothing to steal focus FROM in that case) and
    // never again while it stays empty (each edge in `rows.length` only
    // changes when a delete — the only mutation this file makes to the
    // edge count — actually happens).
    if (!wasEmpty.current && rows.length === 0) emptyRef.current?.focus();
    wasEmpty.current = rows.length === 0;
  }, [rows.length]);
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
    // Only when a row actually survives: the row sliding UP into this slot
    // (`i + 1`, in the array as it stands right NOW, before removal) if there
    // is one, else the row that was already just above it. Focusing it
    // before calling `onSave` matters: React reconciles the shorter array by
    // key, so this exact node keeps the DOM focus it already has rather than
    // the browser dropping focus to <body> the instant the deleted row's own
    // node unmounts.
    //
    // When this is the LAST row (`rows.length === 1`), that computation
    // degenerates to `i` itself — the very node being deleted — so it is
    // skipped entirely here. There is nothing left to focus among the rows;
    // the list is about to be replaced by the empty state, and the effect
    // above hands focus to THAT once it exists, rather than leaving the
    // about-to-unmount node as the last thing focus touched (which is
    // exactly what silently drops focus to <body> the instant it goes away).
    if (rows.length > 1) {
      const stays = i + 1 < rows.length ? i + 1 : Math.max(i - 1, 0);
      rowRefs.current[stays]?.focus();
      setFocusedIndexRaw(i + 1 < rows.length ? i : Math.max(i - 1, 0));
    }
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

  // Both branches below now sit above the SAME `NewRuleBar` (rendered once,
  // after this `if`) — there being no rows yet is no longer a dead end that
  // sends you back to the canvas to make one, now that a rule can be built
  // right here.
  const body = rows.length === 0 ? (
    // Not a hint line on a card (the house rule those forbid) — an empty
    // state for the list itself, the same job `.orch-empty` does for the
    // canvas when a flow has no nodes yet.
    //
    // `tabIndex={-1}`: focusable by the `emptyRef` effect above (deleting
    // the last rule lands focus here on purpose, deliberately, rather than
    // losing it to <body>), but not a stop an ordinary Tab press should
    // land on — there is nothing here to DO, only something to read.
    <div className="orch-empty" data-testid="flowlist-empty" ref={emptyRef} tabIndex={-1}>
      No rules yet.
    </div>
  ) : (
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
                {/* `tabIndex` follows the SAME roving rule the row itself
                    follows (`rowTabIndex`) — without it, this button is a
                    native Tab stop regardless of whether its row is the
                    current one, which is exactly the cost the roving
                    tabindex exists to avoid (see `rowTabIndex`'s own doc
                    comment): a flow with five fired rules would cost five
                    extra Tab presses just to get past the list, one per
                    Reset button, on top of the one stop the list itself is
                    supposed to cost. */}
                <button
                  type="button"
                  className="orch-mini"
                  tabIndex={rowTabIndex(i)}
                  onClick={() => p.onResetEdge(e.id)}
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {body}
      <NewRuleBar flow={flow} promptModes={p.promptModes} onSave={p.onSave} />
    </>
  );
}
