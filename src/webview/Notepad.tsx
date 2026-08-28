import * as React from "react";
import { send } from "./vscodeApi";
import { NotepadImage, NotepadItemView, NotepadRunStatus, NotepadSectionView } from "../types";
import { DotsIcon, ImageIcon, PenIcon, PlayIcon, TrashIcon } from "./icons";
import { moveKey } from "./helpers";
import { useOverflowing } from "./useOverflowing";

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

/** The detail field's placeholder. Exported because it is the ONLY thing telling a
 * user that the field takes a screenshot, so its wording is behaviour and the tests
 * assert against this constant rather than a copy of the string. A placeholder was
 * chosen over a line of help text under the field: this panel's rule is that
 * persistent explanatory text is noise, and a placeholder disappears the moment the
 * user starts typing. */
export const DETAIL_PLACEHOLDER = "Any detail — paste a screenshot here too (optional)";

/** An image the add form is holding: what `notepad:add` needs, plus the data URL
 * the thumbnail renders from. Both come out of one read, so the bytes are never
 * decoded twice. */
interface PendingLocal {
  dataBase64: string;
  mime: string;
  name: string;
  dataUrl: string;
}

/** Read one file into what the host needs. Returns null for anything that is not
 * an image, so a pasted text file or a dragged folder is ignored here rather than
 * sent for the host to refuse — the refusal toast is for files the user plainly
 * MEANT as an image, not for every stray clipboard item. */
async function readImage(file: File): Promise<PendingLocal | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // readAsDataURL gives `data:<mime>;base64,<payload>`. The payload is what the
  // host decodes; the whole URL doubles as the pending thumbnail's src.
  return { dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: file.type, name: file.name, dataUrl };
}

const imageFiles = (list: FileList | File[] | null | undefined): File[] =>
  Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));

/** A drag carrying files from outside the webview (Finder, Explorer) rather than a
 * note being dragged to a new position. Checked FIRST in both drag handlers: the
 * reorder path and the attach path share one row, and a file drop that fell through
 * to the reorder path would silently reshuffle the list instead of attaching. */
const isFileDrag = (e: React.DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

const EMPTY: Record<NoteFilter, string> = {
  active: "Nothing active. Add a note above.",
  done: "Nothing done yet.",
  all: "No notes yet. Add one above.",
};

export function Notepad({ notes, ordered, sections = [] }: {
  notes: NotepadItemView[]; ordered: boolean;
  /** User-defined groups notes can be filed under. Absent (or empty) is the
   * legacy case: everything renders as one plain list, exactly as before this
   * existed — sections are opt-in, never required to reach a working notepad. */
  sections?: NotepadSectionView[];
}): JSX.Element {
  const [filter, setFilter] = React.useState<NoteFilter>("active");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  // Attachments for the ADD form only. The note does not exist yet, so there is
  // nothing for the host to file them against; they ride along with notepad:add.
  // If the user never presses Add, the bytes were never written anywhere.
  const [pending, setPending] = React.useState<PendingLocal[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [sectionName, setSectionName] = React.useState("");
  const [editingSection, setEditingSection] = React.useState<string | null>(null);
  // The toolbar's ⋯ menu and the transient section form it can summon. Both are
  // closed on every mount for the same reason the filter resets to Active: a
  // remembered open menu would greet the user with chrome they never asked for.
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [sectionFormOpen, setSectionFormOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; pos: "before" | "after" } | null>(null);
  // The id also lives in a ref: onDrop fires in the same tick as the state update
  // that would otherwise still read null.
  const dragIdRef = React.useRef<string | null>(null);

  const shown = notes.filter((n) => (filter === "all" ? true : filter === "done" ? n.done : !n.done));
  const anyDone = notes.some((n) => n.done);
  // A pasted screenshot is content in its own right, so it alone can make a note
  // worth adding — the host's own guard agrees.
  const canAdd = title.trim().length > 0 || body.trim().length > 0 || pending.length > 0;
  // A note pointing at a section that no longer exists (the section was deleted
  // out from under a stale view, or a corrupt record) renders ungrouped rather
  // than vanishing — same defensive stance as the rest of this file.
  const sectionIds = new Set(sections.map((s) => s.id));
  const ungrouped = shown.filter((n) => !n.sectionId || !sectionIds.has(n.sectionId));

  const add = () => {
    if (!canAdd) return;
    // The `images` key is omitted when nothing is pending, so a plain note's message
    // stays exactly what it was before attachments existed.
    send(pending.length > 0
      ? { type: "notepad:add", title, body, images: pending.map(({ dataBase64, mime, name }) => ({ dataBase64, mime, name })) }
      : { type: "notepad:add", title, body });
    setTitle("");
    setBody("");
    setPending([]);
  };

  /** Read every image among these files into the add form's pending list. Shared by
   * its paste and its drop, which differ only in where the FileList comes from. */
  const holdPending = async (files: File[]): Promise<void> => {
    const read = (await Promise.all(files.map(readImage))).filter((r): r is PendingLocal => r !== null);
    if (read.length > 0) setPending((prev) => [...prev, ...read]);
  };

  const addSection = () => {
    if (!sectionName.trim()) return;
    send({ type: "notepad:addSection", name: sectionName });
    setSectionName("");
    // The form is a one-shot summoned from the menu, not standing chrome —
    // adding puts it away again; the new section's header is the confirmation.
    setSectionFormOpen(false);
  };

  // Click-outside-to-close, same idiom as useComboFilter's (combo.tsx). Not the
  // hook itself: this menu has no query/active-row state to share, and taking
  // the hook for two of its nine returns would be scaffolding without a shape.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const endDrag = () => { dragIdRef.current = null; setDragId(null); setDropTarget(null); };
  const beginDrag = (id: string) => { dragIdRef.current = id; setDragId(id); };
  const commitDrop = (targetId: string, pos: "before" | "after") => {
    const from = dragIdRef.current;
    if (from && from !== targetId) {
      // Only the visible notes are named: the host keeps every hidden note in its
      // own slot, so a drop under a filter cannot disturb what it cannot see.
      const next = moveKey(shown, from, targetId, pos, (n) => n.id);
      send({ type: "notepad:reorder", order: next.map((n) => n.id) });
      // Dropping onto a note in a different section refiles the dragged note
      // too — a drag is the primary way to move a note between sections, so
      // landing it beside a note without adopting that note's section would be
      // a visual lie: the note would appear to move, then snap back on the
      // next render once the flat order regroups by its unchanged sectionId.
      const draggedNote = shown.find((n) => n.id === from);
      const targetNote = shown.find((n) => n.id === targetId);
      if (draggedNote && targetNote && draggedNote.sectionId !== targetNote.sectionId) {
        send({ type: "notepad:setSection", id: from, sectionId: targetNote.sectionId });
      }
    }
    endDrag();
  };
  // Dropping on a section's own header/empty area — no note to anchor a
  // position against, so this only ever refiles, never reorders.
  const dropOnSection = (sectionId: string | undefined) => {
    const from = dragIdRef.current;
    if (from) {
      const draggedNote = shown.find((n) => n.id === from);
      if (draggedNote && draggedNote.sectionId !== sectionId) {
        send({ type: "notepad:setSection", id: from, sectionId });
      }
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
            placeholder={DETAIL_PLACEHOLDER}
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            // A text paste is left completely alone — preventDefault only fires once
            // an image is actually on the clipboard, so pasting a URL or a paragraph
            // behaves exactly as it always has.
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData?.files);
              if (files.length === 0) return;
              e.preventDefault();
              void holdPending(files);
            }}
            onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
            onDrop={(e) => {
              if (!isFileDrag(e)) return;
              e.preventDefault();
              void holdPending(imageFiles(e.dataTransfer.files));
            }}
          />
        </div>
        {pending.length > 0 && (
          <div className="np-images">
            {pending.map((p, i) => (
              <span className="np-thumb-wrap" key={`${p.name}-${i}`}>
                <span className="np-thumb" title={p.name}>
                  <img src={p.dataUrl} alt={p.name} />
                </span>
                <button
                  className="quiet icon-only dim np-thumb-remove"
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  // Local only: nothing is on disk until Add, so there is nothing
                  // for the host to unlink.
                  onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
                >
                  <TrashIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="np-add-row">
          <button className="quiet np-add-btn" disabled={!canAdd} onClick={add}>Add note</button>
          {/* A file input, not a host round trip: the note does not exist yet, so the
              host would have nowhere to put the bytes and would have to hand them
              back across the wire. Reading the File here is the same path paste and
              drop already take. The label IS the button — the input itself is
              off-screen rather than `display: none`, so it keeps its accessible name
              and stays keyboard-reachable. */}
          <label className="quiet dim np-attach" title="Attach an image — or paste one into the detail field">
            <ImageIcon /> Attach image
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              aria-label="Attach image"
              onChange={(e) => {
                const files = imageFiles(e.target.files);
                // A file input fires no change event when the value is unchanged, so
                // without this reset re-picking the SAME screenshot does nothing.
                e.target.value = "";
                if (files.length > 0) void holdPending(files);
              }}
            />
          </label>
        </div>
      </div>

      {/* One toolbar row: the filter, and everything rarer behind ⋯. Clear
          completed and Reset order keep their old visibility conditions as menu
          items; New section… is always there, so the menu is never empty and the
          kebab never has to blink in and out with the list's state. */}
      <div className="lenses">
        <div className="lens">
          <div className="seg" role="group" aria-label="Note filter">
            {FILTERS.map((f) => (
              <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div
            className="np-menu-wrap"
            ref={menuRef}
            onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }}
          >
            <button
              className="quiet icon-only dim np-menu-btn"
              aria-label="Notepad actions"
              title="Notepad actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <DotsIcon />
            </button>
            {menuOpen && (
              <div className="np-menu" role="menu" aria-label="Notepad actions">
                <button
                  role="menuitem"
                  onClick={() => { setSectionFormOpen(true); setMenuOpen(false); }}
                >
                  New section…
                </button>
                {(anyDone || ordered) && <div className="np-menu-sep" />}
                {anyDone && (
                  <button
                    role="menuitem"
                    className="np-clear"
                    onClick={() => { send({ type: "notepad:clearCompleted" }); setMenuOpen(false); }}
                  >
                    Clear completed
                  </button>
                )}
                {ordered && (
                  <button
                    role="menuitem"
                    onClick={() => { send({ type: "notepad:resetOrder" }); setMenuOpen(false); }}
                  >
                    Reset order
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {sectionFormOpen && (
        <div className="np-add-section">
          <input
            className="np-section-input"
            placeholder="New section name"
            value={sectionName}
            // Summoned by an explicit menu choice, so focus follows the intent;
            // the field did not exist a render ago, making this the rare
            // autoFocus that cannot steal from anything.
            autoFocus
            onChange={(e) => setSectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addSection(); }
              else if (e.key === "Escape") { e.preventDefault(); setSectionName(""); setSectionFormOpen(false); }
            }}
          />
          <button className="quiet np-section-add-btn" disabled={!sectionName.trim()} onClick={addSection}>
            Add section
          </button>
        </div>
      )}

      {shown.length === 0 && sections.length === 0 ? (
        <div className="np-empty">{EMPTY[filter]}</div>
      ) : (
        <div
          className="np-list"
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }}
        >
          {ungrouped.length > 0 && (
            <ul className="np-group">
              {ungrouped.map((n) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  sections={sections}
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
          {sections.map((s) => {
            const groupNotes = shown.filter((n) => n.sectionId === s.id);
            return (
              <div className="np-section" key={s.id}>
                <SectionHeader
                  section={s}
                  editing={editingSection === s.id}
                  onEdit={() => setEditingSection(s.id)}
                  onDone={() => setEditingSection(null)}
                  onDropNote={() => dropOnSection(s.id)}
                />
                {!s.collapsed && groupNotes.length > 0 && (
                  <ul className="np-group">
                    {groupNotes.map((n) => (
                      <NoteRow
                        key={n.id}
                        note={n}
                        sections={sections}
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
          })}
        </div>
      )}
    </div>
  );
}

/** A section's header row: collapse toggle, name (or its rename form), delete.
 * Also the drop target for filing a dragged note into this section without
 * anchoring it to another note's position — see `dropOnSection` in Notepad. */
function SectionHeader({ section, editing, onEdit, onDone, onDropNote }: {
  section: NotepadSectionView;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onDropNote: () => void;
}): JSX.Element {
  const [name, setName] = React.useState(section.name);
  // Re-sync when the host sends a changed copy of this section while the header
  // sits open in rename mode — same reasoning as NoteRow's own title/body sync.
  React.useEffect(() => { setName(section.name); }, [section.name]);

  if (editing) {
    return (
      <div className="np-section-head editing">
        <input
          className="np-section-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="quiet"
          onClick={() => { send({ type: "notepad:renameSection", id: section.id, name }); onDone(); }}
        >
          Save section name
        </button>
        <button className="quiet dim" onClick={() => { setName(section.name); onDone(); }}>Cancel</button>
      </div>
    );
  }

  return (
    <div
      className="np-section-head"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => { e.preventDefault(); onDropNote(); }}
    >
      <button
        className="quiet icon-only dim np-section-toggle"
        aria-label={section.collapsed ? `Expand ${section.name}` : `Collapse ${section.name}`}
        onClick={() => send({ type: "notepad:toggleSectionCollapsed", id: section.id })}
      >
        {section.collapsed ? "▸" : "▾"}
      </button>
      <span className="np-section-name">{section.name}</span>
      <button className="quiet icon-only dim" aria-label="Rename section" title="Rename section" onClick={onEdit}>
        <PenIcon />
      </button>
      <button
        className="quiet icon-only dim"
        aria-label="Delete section"
        title="Delete section"
        onClick={() => send({ type: "notepad:deleteSection", id: section.id })}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** A saved note's attachments. `imageUris` is positionally parallel to `images`,
 * both derived host-side from the same array, so index is the only pairing there
 * is — a record without a URI (a poll that reached the webview before the host
 * had a webview to convert against) renders nothing rather than a broken tile.
 * `onRemove` is absent outside edit mode, which is what hides the remove control. */
function ImageStrip({ note, onRemove }: {
  note: NotepadItemView;
  onRemove?: (imageId: string) => void;
}): JSX.Element | null {
  const images = note.images ?? [];
  const uris = note.imageUris ?? [];
  if (images.length === 0 || uris.length === 0) return null;
  return (
    <div className="np-images">
      {images.map((image: NotepadImage, i: number) => {
        const uri = uris[i];
        if (!uri) return null;
        return (
          <span className="np-thumb-wrap" key={image.id}>
            <button
              className="np-thumb"
              title={image.name}
              aria-label={`Open ${image.name}`}
              onClick={() => send({ type: "notepad:openImage", id: note.id, imageId: image.id })}
            >
              <img src={uri} alt={image.name} />
            </button>
            {onRemove && (
              <button
                className="quiet icon-only dim np-thumb-remove"
                aria-label={`Remove ${image.name}`}
                title={`Remove ${image.name}`}
                onClick={() => onRemove(image.id)}
              >
                <TrashIcon />
              </button>
            )}
          </span>
        );
      })}
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

function NoteRow({ note, sections, editing, onEdit, onDone, dnd }: {
  note: NotepadItemView;
  sections: NotepadSectionView[];
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
  // The body is clamped to a few lines until asked otherwise. Local and collapsed
  // on every mount, for the reason the filter and the ⋯ menu are: a remembered
  // expansion would be chrome the user did not ask for on a note they may not
  // even recognise a session later.
  const [expanded, setExpanded] = React.useState(false);
  const [bodyRef, clipped] = useOverflowing<HTMLDivElement>(!expanded);
  // Re-sync when the host sends a changed copy of this note while the row sits
  // open — otherwise Save would write back a value the user never saw.
  React.useEffect(() => { setTitle(note.title); setBody(note.body); }, [note.title, note.body]);

  /** Send every image among these files to the host, which writes them and reposts.
   * Unlike the add form's pending list this needs no local state: the note exists,
   * so an attachment is immediate — like toggleDone, not like the title draft. */
  const attach = async (files: File[]): Promise<void> => {
    for (const file of files) {
      const read = await readImage(file);
      if (read) {
        send({ type: "notepad:addImage", id: note.id, dataBase64: read.dataBase64, mime: read.mime, name: read.name });
      }
    }
  };

  if (editing) {
    return (
      <li className="np-item">
        <div className="edit">
          <input className="np-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className="np-body-input"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData?.files);
              if (files.length === 0) return; // a plain text paste, untouched
              e.preventDefault();
              void attach(files);
            }}
          />
          <ImageStrip note={note} onRemove={(imageId) => send({ type: "notepad:removeImage", id: note.id, imageId })} />
          {sections.length > 0 && (
            // Fires immediately on change, unlike title/body: it is a filing
            // action like toggleDone, not a draft that waits on Save.
            <select
              aria-label="Section"
              className="np-section-select"
              value={note.sectionId ?? ""}
              onChange={(e) => send({ type: "notepad:setSection", id: note.id, sectionId: e.target.value || undefined })}
            >
              <option value="">Ungrouped</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          <div className="row">
            <button
              className="quiet"
              aria-label="Attach image"
              title="Attach an image"
              // The host owns the picker: it hands back a path, and only the host can
              // read one. Paste and drop cover the cases where bytes are already in hand.
              onClick={() => send({ type: "notepad:pickImage", id: note.id })}
            >
              <ImageIcon /> Attach
            </button>
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
      onDragOver={(e) => {
        e.preventDefault();
        // A file drag is not a reorder: it keeps the copy cursor and shows no
        // before/after hint, or the row would advertise a move it will not perform.
        if (isFileDrag(e)) { e.dataTransfer.dropEffect = "copy"; return; }
        e.dataTransfer.dropEffect = "move";
        dnd.onHover(dropPos(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (isFileDrag(e)) { void attach(imageFiles(e.dataTransfer.files)); return; }
        dnd.onDrop(dropPos(e));
      }}
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
      {note.body && (
        <>
          <div ref={bodyRef} className={expanded ? "np-body expanded" : "np-body"}>{note.body}</div>
          {/* Only when the clamp is actually hiding something: a "Show more" under a
              body that already fits would be a standing hint line, which this panel
              does not do. */}
          {clipped && (
            <button
              className="quiet dim np-body-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      <ImageStrip note={note} />
      <div className="np-acts">
        <button className="take" onClick={() => send({ type: "notepad:run", id: note.id })} title="Start this note as a session">
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
