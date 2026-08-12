# Notepad: drag to reorder

Date: 2026-08-12
Status: approved design, not yet planned

## Problem

The Notepad list has one order and the user cannot change it: `Notepad.tsx` sorts
every render by `createdAt` descending. A notepad is a working queue — the note
you care about most is rarely the one you wrote most recently — so the order the
user wants and the order the panel shows drift apart immediately.

The Tasks tab already solved the same problem for My-sprint cards: a grip on each
card, an HTML5 drag with before/after drop hints, and a persisted list of keys the
host sorts by. This design reuses that machinery rather than inventing a second
drag language in the same webview.

## Scope

In scope: manual reordering of notes by pointer drag, persisted per user; a Reset
order control; the host-side sort that makes the order real.

Out of scope: keyboard reordering (the Tasks card drag has none either — adding it
here would put two different accessibility stories in one panel); dragging a note
between filters to change its done state; dragging notes across panels.

## Behaviour

- Every note row carries a grip. Pressing the grip and dragging moves the note;
  pressing anywhere else on the row does not start a drag, so title selection, the
  done checkbox, and the Start/edit/delete cluster keep working unchanged.
- While dragging, the source row dims and the row under the pointer shows a line
  at its top or bottom edge — whichever half the pointer is in — marking where the
  note lands on release.
- Dropping writes the new order and the list re-renders in it. The order survives
  reloads and applies in every filter (All / Active / Done).
- Reordering inside a filtered view moves the note relative to its *visible*
  neighbours. Notes hidden by the current filter keep their absolute slots.
- A new note goes to the top of the list, matching what newest-first shows today.
- Deleting a note, or clearing completed notes, removes those ids from the order.
- A "Reset order" control appears in the lens row only once a manual order exists.
  It clears the order; the list falls back to newest-first.
- A user who never drags sees exactly today's list. The feature ships inert.

## Design

### Storage

A new key `agentFlow.notepadOrder` holds a `string[]` of note ids, in
`globalState` — the same scope as `agentFlow.notepad`, because a notepad belongs
to the user rather than to a workspace. (The sprint order key lives in
`workspaceState` for the opposite reason: its keys are project tickets.)

`NotepadItem` gains no field and `sanitizeNotes` is unchanged. An absent or empty
order means "no manual order", which is the state every existing install starts
in — so no migration exists to get wrong.

The order list is allowed to name ids that no longer exist only between a delete
and the next save; both delete paths prune it (see below).

### Sorting

The host sorts, not the webview. `postNotepad` already derives run status
host-side and posts a finished array; it applies the saved order to that array
before posting. `Notepad.tsx` drops its `.sort((a, b) => b.createdAt - a.createdAt)`
and renders the array as given.

Sorting reuses `sortBySavedOrder` from `src/engine/order.ts`, which today is typed
to `Task[]` and reads `t.key`. It becomes generic over the item with a `keyOf`
accessor, so Tasks (`t => t.key`) and Notepad (`n => n.id`) share one
implementation and its existing unit tests. Ranked items come first in saved
order, unranked keep their incoming order — and the incoming order for notes is
`createdAt` descending, which is what makes an untouched notepad look identical to
today's.

### The drop

The webview sends `notepad:reorder { order: string[] }` — the ids of the currently
visible notes, in the order the drop produced. The host applies

    applyReorder(saved, order, new Set(order))

which is exactly the function the sprint reorder uses, and gives the filtered-view
rule for free: visible ids follow `order`, hidden ids keep their slots, ids not in
`saved` are appended.

A note added while a manual order exists is unshifted onto the front of the order,
so it ranks first. With no manual order, nothing is written and newest-first
already puts it on top.

`deleteNote` and `clearCompletedNotes` call `pruneOrder(saved, remainingIds)` and
save the result, so the order cannot grow forever behind the panel.

`notepad:resetOrder` clears the key and reposts.

### UI

The affordance is copied from the Tasks card, not re-designed:

- `<span className="grip" title="Drag to reorder">⠿</span>` as the first child of
  `.np-top`, before the checkbox. `onMouseDown` sets an `armed` ref;
  `onMouseDown` on the row clears it.
- The `<li className="np-item">` gets `draggable`, and `onDragStart` calls
  `preventDefault()` unless `armed` — so only the grip arms a drag.
- `onDragOver` computes before/after from `clientY` against the row's midpoint;
  `onDrop` commits; `onDragEnd` clears.
- The list container clears the hint on `dragLeave` when the pointer leaves it.

CSS adds `.np-item.dragging` and `.np-item.drop-before` / `.drop-after` beside the
existing `.card.*` rules, using the same `opacity: .45` and
`inset 0 ±2px 0 0 var(--vscode-focusBorder)`. The existing `.grip` rules are reused
unchanged apart from neutralising their Tasks-specific `margin-left`. The Reset
control sits in the `.lenses` row next to "Clear completed" and takes that
button's `quiet dim` styling rather than the sprint bar's `.reset-order` pill —
inside the Notepad, the two controls read as a pair.

The webview cannot know whether an order exists (it never sees the order key), so
`notepad:notes` carries an `ordered: boolean` and the control renders only when it
is true.

The rail (`.np-item::before`) and the grip share the row's left edge: the grip goes
inside `.np-top`, so the rail's 2px column is untouched and no new gutter is
introduced.

### Message types

Added to `InboundMessage` in `src/types.ts`:

    | { type: "notepad:reorder"; order: string[] }
    | { type: "notepad:resetOrder" }

Neither gets a `MESSAGE_OPS` entry, matching every other `notepad:*` message
except `notepad:run`: they touch only the user's own globalState, so a failure has
no task-source or workspace op to attribute itself to.

## Testing

- `test/unit/engine/order.test.ts` — the generic `sortBySavedOrder` keeps its
  current cases (with `t => t.key`) and gains note-shaped ones (`n => n.id`).
- `test/unit/notepad.test.ts` — no change: the pure notepad module is untouched.
- `test/unit/tasksView*.test.ts` — the reorder handler rewrites the order; add
  unshifts; delete and clear-completed prune; reset clears; a first-ever drag with
  an empty saved order produces exactly the dropped sequence.
- `test/webview/Notepad.test.tsx` — dragging from the grip posts
  `notepad:reorder` with the visible ids in the new order; a dragStart that did
  not pass through the grip posts nothing (mirrors the existing App.test.tsx
  case); the drop hint lands on the correct half; Reset order is absent until an
  order exists.

Coverage bar is the repo's usual ≥95% on changed files, and the existing suite
must pass unmodified.

## Risks

- **Two sources of truth.** Notes and their order live in separate keys, so a
  missed prune leaves stale ids. Mitigated by pruning in both delete paths and by
  `sortBySavedOrder` ignoring ids it cannot resolve.
- **Host-side sorting moves behaviour out of the webview.** Any future caller that
  posts notes without going through `postNotepad` would post them unsorted;
  `postNotepad` is the single poster today and stays so.
- **No keyboard path.** Reordering is pointer-only, matching Tasks. If the panel
  ever gains a keyboard story it should be added to both surfaces at once.
