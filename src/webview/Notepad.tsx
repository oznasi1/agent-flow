import * as React from "react";
import { send } from "./vscodeApi";
import { NotepadItemView, NotepadRunStatus } from "../types";
import { PenIcon, PlayIcon, TrashIcon } from "./icons";
import { moveKey } from "./helpers";

/** Which notes the list shows. Local state, defaulting to Active on every mount:
 * a persisted "Done" selection would greet the user with an empty-looking notepad
 * one session later, with no obvious cause. */
type NoteFilter = "active" | "done" | "all";

const FILTERS: { id: NoteFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
];

const STATUS_LABEL: Record<NotepadRunStatus, string> = {
  running: "Running",
  stale: "Stale",
  finished: "Finished",
};

// A run status maps onto the rail's three hues; "finished" reads as "done" there,
// matching the Tasks tab's own rail convention (s-progress / s-done / a dim idle).
const RAIL_CLASS: Record<NotepadRunStatus, string> = {
  running: "r-running",
  stale: "r-stale",
  finished: "r-done",
};

const EMPTY: Record<NoteFilter, string> = {
  active: "Nothing active. Add a note above.",
  done: "Nothing done yet.",
  all: "No notes yet. Add one above.",
};

export function Notepad({ notes, ordered }: { notes: NotepadItemView[]; ordered: boolean }): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; pos: "before" | "after" } | null>(null);
  // The id also lives in a ref: onDrop fires in the same tick as the state update
  // that would otherwise still read null.
  const dragIdRef = React.useRef<string | null>(null);

  const shown = notes.filter((n) => (filter === "all" ? true : filter === "done" ? n.done : !n.done));
  const anyDone = notes.some((n) => n.done);
  const canAdd = title.trim().length > 0 || body.trim().length > 0;

  const add = () => {
    if (!canAdd) return;
    send({ type: "notepad:add", title, body });
    setTitle("");
    setBody("");
  };

  const endDrag = () => { dragIdRef.current = null; setDragId(null); setDropTarget(null); };
  const beginDrag = (id: string) => { dragIdRef.current = id; setDragId(id); };
  const commitDrop = (targetId: string, pos: "before" | "after") => {
    const from = dragIdRef.current;
    if (from && from !== targetId) {
      // Only the visible notes are named: the host keeps every hidden note in its
      // own slot, so a drop under a filter cannot disturb what it cannot see.
      const next = moveKey(shown, from, targetId, pos, (n) => n.id);
      send({ type: "notepad:reorder", order: next.map((n) => n.id) });
    }
    endDrag();
  };

  return (
    <div className="notepad">
      <div className="np-add">
        <div className="np-field-row">
          <input
            className="np-title-input"
            placeholder="What needs doing?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            // Enter commits from the title, where a newline means nothing anyway.
            // The body deliberately does not: it is multi-line by design.
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          />
        </div>
        <div className="np-field-row">
          <textarea
            className="np-body-input"
            placeholder="Any detail the agent should know (optional)"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <button className="quiet np-add-btn" disabled={!canAdd} onClick={add}>Add note</button>
      </div>

      <div className="lenses">
        <div className="lens">
          <div className="seg" role="group" aria-label="Note filter">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {/* Wrapped in its own .lens (a flex row, content-width) rather than left as
            direct children of .lenses (a flex COLUMN): unwrapped, each button
            stretched to the panel's full width and stacked, one bar per button,
            instead of sitting beside "Clear completed" the way the spec asks. The
            wrapper itself is conditional so an all-false case adds no empty row. */}
        {(anyDone || ordered) && (
          <div className="lens">
            {anyDone && (
              <button className="quiet dim np-clear" onClick={() => send({ type: "notepad:clearCompleted" })}>
                Clear completed
              </button>
            )}
            {ordered && (
              <button className="quiet dim np-clear" onClick={() => send({ type: "notepad:resetOrder" })}>
                Reset order
              </button>
            )}
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="np-empty">{EMPTY[filter]}</div>
      ) : (
        <ul
          className="np-list"
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
        >
          {shown.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              editing={editing === n.id}
              onEdit={() => setEditing(n.id)}
              onDone={() => setEditing(null)}
              dnd={{
                onBegin: () => beginDrag(n.id),
                onHover: (pos) => setDropTarget({ id: n.id, pos }),
                onDrop: (pos) => commitDrop(n.id, pos),
                onEnd: endDrag,
                dragging: dragId === n.id,
                hint: dropTarget && dropTarget.id === n.id && dragId && dragId !== n.id ? dropTarget.pos : null,
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface NoteDnd {
  onBegin: () => void;
  onHover: (pos: "before" | "after") => void;
  onDrop: (pos: "before" | "after") => void;
  onEnd: () => void;
  dragging: boolean;
  hint: "before" | "after" | null;
}

function NoteRow({ note, editing, onEdit, onDone, dnd }: {
  note: NotepadItemView;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  dnd: NoteDnd;
}): JSX.Element {
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body);
  // State, not a ref: `draggable` below reads it directly, so the row must
  // already be undraggable in the DOM before the browser's own drag threshold
  // (a few pixels of mousemove past mousedown) fires — cancelling dragstart
  // with preventDefault after the fact does NOT hand the gesture back to text
  // selection (Blink treats "drag" and "select" as a fork made at mousedown,
  // not one it revisits once dragstart has already been dispatched). A
  // same-tick React state update flushes before that threshold, since the
  // threshold needs a further mousemove event the render beats to the queue.
  const [armed, setArmed] = React.useState(false);
  // Re-sync when the host sends a changed copy of this note while the row sits
  // open — otherwise Save would write back a value the user never saw.
  React.useEffect(() => { setTitle(note.title); setBody(note.body); }, [note.title, note.body]);

  if (editing) {
    return (
      <li className="np-item">
        <div className="edit">
          <input className="np-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="np-body-input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="row">
            <button className="quiet" onClick={() => { send({ type: "notepad:update", id: note.id, title, body }); onDone(); }}>
              Save
            </button>
            <button className="quiet dim" onClick={() => { setTitle(note.title); setBody(note.body); onDone(); }}>
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  const railClass = note.runStatus ? RAIL_CLASS[note.runStatus] : "";
  const dropPos = (e: React.DragEvent): "before" | "after" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };
  const cls = [
    "np-item", railClass, note.done ? "is-done" : "",
    dnd.dragging ? "dragging" : "",
    dnd.hint === "before" ? "drop-before" : dnd.hint === "after" ? "drop-after" : "",
  ].filter(Boolean).join(" ");

  return (
    <li
      className={cls}
      draggable={armed}
      onMouseDown={() => setArmed(false)}
      // A grip press with no drag following (e.g. a click) must not leave the
      // row armed for whatever unrelated gesture comes next.
      onMouseUp={() => setArmed(false)}
      onDragStart={(e) => {
        // `draggable={armed}` is the real fix (see the comment on `armed` above) —
        // this check is a backstop for whatever dispatches dragstart without the
        // browser's own draggable gating in the way (jsdom's fireEvent, notably).
        if (!armed) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", note.id);
        dnd.onBegin();
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.onHover(dropPos(e)); }}
      onDrop={(e) => { e.preventDefault(); dnd.onDrop(dropPos(e)); }}
      onDragEnd={() => { setArmed(false); dnd.onEnd(); }}
    >
      <div className="np-top">
        <span
          className="grip"
          title="Drag to reorder"
          onMouseDown={(e) => { e.stopPropagation(); setArmed(true); }}
        >⠿</span>
        <input
          className="cb"
          type="checkbox"
          checked={note.done}
          aria-label={`Done: ${note.title || "untitled note"}`}
          onChange={() => send({ type: "notepad:toggleDone", id: note.id })}
        />
        <span className="np-title">{note.title}</span>
        {note.runStatus && (
          <span className="status">{STATUS_LABEL[note.runStatus]}</span>
        )}
      </div>
      {note.body && <div className="np-body">{note.body}</div>}
      <div className="np-acts">
        <button className="take" onClick={() => send({ type: "notepad:run", id: note.id })} title="Start this note as an agent run">
          <PlayIcon /> Start
        </button>
        <button className="quiet icon-only dim" aria-label="Edit note" title="Edit note" onClick={onEdit}>
          <PenIcon />
        </button>
        <button className="quiet icon-only dim" aria-label="Delete note" title="Delete note" onClick={() => send({ type: "notepad:delete", id: note.id })}>
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}
