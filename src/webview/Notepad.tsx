import * as React from "react";
import { send } from "./vscodeApi";
import { NotepadItemView, NotepadRunStatus } from "../types";
import { PenIcon, PlayIcon, TrashIcon } from "./icons";

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

export function Notepad({ notes }: { notes: NotepadItemView[] }): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);

  const shown = notes.filter((n) => (filter === "all" ? true : filter === "done" ? n.done : !n.done));
  const anyDone = notes.some((n) => n.done);
  const canAdd = title.trim().length > 0 || body.trim().length > 0;

  const add = () => {
    if (!canAdd) return;
    send({ type: "notepad:add", title, body });
    setTitle("");
    setBody("");
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
        {anyDone && (
          <button className="quiet dim np-clear" onClick={() => send({ type: "notepad:clearCompleted" })}>
            Clear completed
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="np-empty">{EMPTY[filter]}</div>
      ) : (
        <ul className="np-list">
          {[...shown].sort((a, b) => b.createdAt - a.createdAt).map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              editing={editing === n.id}
              onEdit={() => setEditing(n.id)}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({ note, editing, onEdit, onDone }: {
  note: NotepadItemView;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}): JSX.Element {
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body);
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

  return (
    <li className={`np-item ${railClass} ${note.done ? "is-done" : ""}`}>
      <div className="np-top">
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
        <span className="spacer" />
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
