import * as React from "react";
import { flushSync } from "react-dom";
import { send } from "./vscodeApi";
import { NotepadItemView, NotepadRunStatus } from "../types";

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

const EMPTY: Record<NoteFilter, string> = {
  active: "Nothing active. Add a note above.",
  done: "Nothing done yet.",
  all: "No notes yet. Add one above.",
};

// The Web Speech API, as the two engines that ship it actually expose it. Typed
// here rather than pulled from `lib.dom` because TypeScript's DOM lib does not
// declare SpeechRecognition at all — it is not a standard, only widely shipped.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechResultLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
interface SpeechResultLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

function speechCtor(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

/** Dictation into a text field. Returns undefined when the engine has no speech
 * recognition — the caller renders no mic at all rather than a button that cannot
 * work. All client-side: no API key, no network call from the extension host, and
 * nothing crosses the message protocol until the note itself is saved. */
function useDictation(append: (text: string) => void): { listening: boolean; toggle: () => void } | undefined {
  const [listening, setListening] = React.useState(false);
  const ref = React.useRef<SpeechRecognitionLike | null>(null);
  const appendRef = React.useRef(append);
  React.useEffect(() => { appendRef.current = append; }, [append]);
  const supported = !!speechCtor();

  // Never leave the microphone open when the view goes away.
  React.useEffect(() => () => ref.current?.stop(), []);

  if (!supported) return undefined;

  const toggle = () => {
    if (ref.current) {
      // A user-initiated stop runs inside React's own click handling, which is
      // already a batched update in progress — flushSync there would nest inside
      // it. Detach onend first so the engine's stop doesn't also try to flush;
      // the plain setState below is enough because the click handler's own
      // batch will commit it.
      const rec = ref.current;
      ref.current = null;
      rec.onend = null;
      rec.stop();
      setListening(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = false; // only settled text lands in the field
    rec.lang = navigator.language || "en-US";
    // The engine dispatches these outside React's own event system, so a plain
    // setState here would only surface on the next unrelated render. flushSync
    // keeps the transcript and button label in step with each event as it fires.
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) text += r[0].transcript;
      }
      if (text.trim()) flushSync(() => appendRef.current(text.trim()));
    };
    // Both paths land on onend, which is the single place listening is released —
    // an error that did not also end the session would strand the button on "Stop".
    rec.onerror = () => { rec.stop(); };
    rec.onend = () => { ref.current = null; flushSync(() => setListening(false)); };
    ref.current = rec;
    rec.start();
    setListening(true);
  };

  return { listening, toggle };
}

export function Notepad({ notes }: { notes: NotepadItemView[] }): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const dictation = useDictation(
    React.useCallback((text: string) => setBody((prev) => (prev ? `${prev} ${text}` : text)), []),
  );

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
        <input
          className="np-title-input"
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          // Enter commits from the title, where a newline means nothing anyway.
          // The body deliberately does not: it is multi-line by design.
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <div className="np-body-row">
          <textarea
            className="np-body-input"
            placeholder="Any detail the agent should know (optional)"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {dictation && (
            <button
              className={`np-mic ${dictation.listening ? "on" : ""}`}
              aria-label={dictation.listening ? "Stop dictating" : "Dictate the note body"}
              title={dictation.listening ? "Stop dictating" : "Dictate the note body"}
              onClick={dictation.toggle}
            >
              {dictation.listening ? "◼" : "🎤"}
            </button>
          )}
        </div>
        <button className="btn np-add-btn" disabled={!canAdd} onClick={add}>Add note</button>
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
          <button className="np-clear" onClick={() => send({ type: "notepad:clearCompleted" })}>
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
      <li className="np-row editing">
        <input className="np-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="np-body-input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="np-actions">
          <button className="btn" onClick={() => { send({ type: "notepad:update", id: note.id, title, body }); onDone(); }}>
            Save
          </button>
          <button className="np-ghost" onClick={() => { setTitle(note.title); setBody(note.body); onDone(); }}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`np-row ${note.done ? "is-done" : ""}`}>
      <div className="np-head">
        <input
          type="checkbox"
          checked={note.done}
          aria-label={`Done: ${note.title || "untitled note"}`}
          onChange={() => send({ type: "notepad:toggleDone", id: note.id })}
        />
        <span className="np-title">{note.title}</span>
        {note.runStatus && (
          <span className={`np-status st-${note.runStatus}`}>{STATUS_LABEL[note.runStatus]}</span>
        )}
      </div>
      {note.body && <div className="np-body">{note.body}</div>}
      <div className="np-actions">
        <button className="np-ghost" onClick={() => send({ type: "notepad:run", id: note.id })}>Run agent</button>
        <button className="np-ghost" aria-label="Edit note" onClick={onEdit}>Edit</button>
        <button className="np-ghost danger" aria-label="Delete note" onClick={() => send({ type: "notepad:delete", id: note.id })}>
          Delete
        </button>
      </div>
    </li>
  );
}
