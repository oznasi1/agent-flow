# Notepad: images in a note's description

Date: 2026-08-13
Status: approved design, not yet planned

## Problem

A note's description is a plain string. Most of what a user wants to say about a
UI bug is a screenshot, and today there is nowhere to put it: pasting an image
into the body textarea does nothing, so the user either describes the picture in
words or abandons the notepad and takes the task by hand.

The picture is wanted in two places, not one. In the panel, so the note is
recognisable at a glance; and in the run, so the agent Claude Code launches can
actually look at what the user saw. A design that serves only the panel leaves
the agent guessing; one that serves only the run leaves the notepad unreadable.

## Scope

In scope: attaching image files to a note by paste, by file drop, and by an
explicit Attach button; thumbnails in the note row; the bytes surviving a reload;
and the images reaching the seeded agent as real files it can read.

Out of scope:

- Placing an image *between* paragraphs of the body. The body stays plain text
  and images render as a strip; inline placement would make every existing
  consumer of `note.body` (the brief, the prompt suffix, `extractFileHints`) a
  marker-aware parser for a gain nobody asked for.
- Annotating, cropping, or resizing an attached image.
- Pasting an image *URL*. That is a download, with a network policy of its own.
- Images on sections, on Tasks-tab cards, or anywhere in the Deck. The Notepad
  renders in one webview (`App.tsx`) and this change stays inside it.

## Behaviour

- With the cursor in a description textarea (the add form or a note's edit form),
  Cmd+V of an image on the clipboard attaches it. This is the case the feature
  exists for: a `Cmd+Shift+4` screenshot has no file on disk to reference.
- Dropping an image file from Finder/Explorer onto a note row attaches it to that
  note. A file drop never reorders notes, and a note drag never attaches
  anything — the two gestures share the row and must not be confused.
- A note open for editing shows an Attach button that opens the VS Code file
  picker.
- Attached images render as a row of thumbnails under the body, in both the add
  form (before the note exists) and the saved note row. Clicking one opens it
  full size in an editor tab.
- Editing a note shows a remove control per thumbnail. Removing deletes the file.
- Deleting a note, or clearing completed notes, deletes their image files.
- A file that is not an image, or is larger than the cap, is refused with a toast
  naming the reason. Nothing is silently dropped.
- Pressing Start copies the note's images into each seeded repo beside the brief,
  and both the brief and the seeded prompt name their paths, so the agent reads
  them without being asked twice.
- A user who never attaches an image sees exactly today's notepad: no new row, no
  new control on an unedited note, no new files on disk. The feature ships inert.

## Design

### Storage

Bytes go to `<globalStorageUri>/notepad-images/<imageId>.<ext>`, not into
`globalState`. `globalState` is the notepad's own store and is the wrong place for
blobs three times over: it is serialised into the webview on every poll, it rides
Settings Sync, and it has no eviction. The image directory sits beside it in the
same per-user scope, which is the scope a notepad belongs to.

A new module `src/notepadImages.ts` owns the directory. Its purity bar is the one
`src/notepad.ts` already states: no `vscode`, no mocked extension context; `fs` is
allowed, and the directory path is passed in, so every unit test runs against a
temp dir. It exposes:

- `saveImage(dir, bytes, mime, name)` → `NotepadImage`, or a typed refusal.
  Accepts `image/png`, `image/jpeg`, `image/gif`, `image/webp` — anything else is
  refused by mime, and the extension is derived from the accepted mime rather
  than trusted from the incoming filename. Bytes over the cap (10 MB) are
  refused. `imageId` is minted the way note and section ids already are
  (`Date.now().toString(36)` + a random suffix), injected by the caller so this
  stays clock-free.
- `deleteImages(dir, images)` — unlinks, tolerating a file already gone.
- `sweepOrphans(dir, referencedIds)` — deletes files no note references. Runs once
  on activate. Every other cleanup path is a best-effort write that a crash, a
  hand-edited state file, or an older version can leave half-done; without the
  sweep the directory only ever grows.

### Model

```ts
export interface NotepadImage {
  id: string;     // also the filename stem
  ext: string;    // from the accepted mime, never from the source filename
  name: string;   // the user's own filename, for display and for the brief
}
```

`NotepadItem` gains `images?: NotepadImage[]`. Absent means "no images", which is
what every existing install has — so there is no migration to get wrong.
`sanitizeNotes` coerces the field with the same stance it takes on the rest: not
an array → dropped; an entry missing a usable `id` or `ext` → dropped, not
defaulted, because a record naming no readable file is not an attachment.

`NotepadItemView` gains `imageUris: string[]`, parallel to `runStatus`: derived
host-side per post from `webview.asWebviewUri`, never persisted. The webview
cannot build these itself — it has no `vscode.Uri` and must not reach `fs`.

`imageUris` is positional with `images`, and a note whose file has vanished under
it would break that pairing. `postNotepad` therefore posts one entry per stored
image and lets a missing file render as a broken thumbnail rather than shifting
every later index; the activate-time sweep is what removes files, never the poll.

### Wire

Webview → host:

- `notepad:addImage { id, dataBase64, mime, name }` — paste or drop onto a saved
  note. Base64 because `postMessage` is a JSON channel; this is a one-shot
  message, not something the poll repeats.
- `notepad:pickImage { id }` — the Attach button. The host runs
  `showOpenDialog` and reads the bytes itself, so no base64 crosses the wire.
- `notepad:removeImage { id, imageId }`.
- `notepad:openImage { imageId }` — a thumbnail click; the host resolves the file
  and opens it with the `vscode.open` command.
- `notepad:add` gains `images: { dataBase64, mime, name }[]`.

The add form has no note id to attach to, and giving the host a draft store to
hold pending bytes would add a second lifetime to reason about. Instead the
webview keeps pending images in local state as `data:` URLs and ships them with
the Add message; if the user never presses Add, the bytes were never written.
The Attach button is therefore an edit-mode control only — the add form is served
by paste and drop, which already cover the screenshot case.

### Host

`addNote` takes the pending images, saves each through `saveImage`, and stores the
resulting `NotepadImage[]` on the note. `deleteNote` and `clearCompletedNotes`
call `deleteImages` for the notes they drop, alongside the `pruneNoteOrder` call
they already make. `updateNote` is untouched: title and body are a draft that
waits on Save, while an image is an immediate action like `toggleDone` — it is on
disk the moment it is attached, and Cancel does not take it back.

`localResourceRoots` at `tasksView.ts:182` gains `context.globalStorageUri`.
Without it every thumbnail 404s. The CSP needs no change: `img-src` already allows
`webview.cspSource` and `data:`.

### Webview

- A `.np-images` strip under `.np-body`, thumbnails at a fixed height (~64px),
  `object-fit: cover`. Each is a button — clicking sends `notepad:openImage`,
  which the host opens with `vscode.open`. In edit mode each thumbnail carries a
  remove control.
- `onPaste` on both textareas reads `e.clipboardData.files`, refuses non-images
  locally, and FileReader-encodes the rest.
- The row's drop handling forks on `e.dataTransfer.types.includes("Files")`
  *first*: a file drop attaches and returns, and never reaches `dnd.onDrop`. The
  reorder path is otherwise unchanged, `armed` gate and all — a Finder drop must
  not reorder the list, and the existing drag must not swallow a file.

### Run handoff

`OpenRequest` gains `attachments?: { path: string; name: string }[]`. In step 1 of
`openWorkspace`, where the brief is written per repo, each attachment is copied to
`<repo>/.pick-task/images/<name>` — the directory is already git-excluded by the
`ensureGitExcluded` call on the same line, which excludes `.pick-task/` whole.
Two attachments on one note can share a filename, so the copy disambiguates by
suffixing the image id.

`runNotepadItem` passes the note's stored files as `attachments` and adds an
`## Attached images` section to `planMd` listing repo-relative paths
(`.pick-task/images/foo.png`). Repo-relative, not relative to the brief: the
agent's cwd is the repo root, and `batchWorkspace.ts:173` already records what a
bare relative reference costs. The existing `promptSuffix` gains a line naming the
same paths and telling the agent to read them — the brief alone is what a freshly
seeded session is least likely to open first, which is the reasoning already
written at `tasksView.ts:1202`.

## Testing

Unit, against a temp dir:

- `notepadImages`: accepted mimes, extension derived from mime and not from a
  misleading filename, the size cap, a refusal leaving no file behind, delete
  tolerating a missing file, and `sweepOrphans` deleting exactly the unreferenced
  files.
- `sanitizeNotes`: images coerced, a non-array dropped, a malformed entry dropped
  while its siblings survive, and a legacy note without the field unchanged.
- `tasksView`: `addNote` with pending images writes files and stores records;
  `deleteNote` and `clearCompletedNotes` unlink; `postNotepad` posts one
  `imageUris` entry per stored image.
- `runNotepadItem`: the brief and the prompt suffix both carry the paths, and
  `attachments` reaches `openWorkspace`.
- `workspace`: attachments copied into `.pick-task/images/`, same-name
  disambiguation, and no directory created when there are none.

Webview (`test/webview/Notepad.test.tsx`): paste builds the message, a non-image
paste does not, thumbnails render from `imageUris`, remove sends
`notepad:removeImage`, and a file drop attaches without emitting
`notepad:reorder`.

## Gates

`npm run build` must pass, not just `tsc` — it is the only gate that catches an
`fs`-touching import leaking into `src/webview/`, and this change adds host-side
file code next to webview-side handlers. The existing suite passes unmodified,
and changed files hold ≥95% coverage.
