# Design: Drag-and-drop reorder for My sprint

**Date:** 2026-07-15
**Status:** Approved, ready for planning

## Summary

Let the user drag task cards to reorder them on the **My sprint** tab of the Flow
Deck sidebar. The order is remembered per-workspace in extension storage and
survives reloads. It is a purely local ordering: nothing is written back to Jira
(no rank API, no `claude-code` label), and no other tab is affected.

## Decisions

| Question | Decision |
|----------|----------|
| Where does the order live? | Local, remembered **per-workspace** (host `workspaceState` Memento). No Jira write. |
| Which tabs? | **My sprint only** (`filter === "mysprint"`). All other tabs keep the default `priority DESC, updated DESC` order. |
| Where do unranked/new tickets go? | **Bottom** — tickets the user hasn't placed yet (newly added to the sprint, or first load) appear at the end, in server order. |
| Drag mechanic? | Native HTML5 drag-and-drop (no new dependency). **Handle-gated**: drag starts from a grip icon so existing click targets keep working. |

## Approach rationale

- **Native HTML5 DnD** over adding `@dnd-kit`/`react-dnd`: the project ships only
  `react` + `react-dom`, and a single vertical list does not justify a DnD
  library. `draggable` + `dragstart/dragover/drop` is sufficient.
- **Host `workspaceState`** over the webview's `getState`: `workspaceState` is the
  durable per-workspace store the user chose, and it keeps the webview a pure
  renderer with the host as the single source of truth for task data and order.
- **Handle-gated drag**: the card already has a click-to-expand region plus Take
  and status buttons. A dedicated grip handle initiates the drag so none of those
  interactions are hijacked.

## Components

### 1. Persistence (host) — `src/tasksView.ts`

- Memento key `agentFlow.sprintOrder` → `string[]` of issue keys in the user's
  order, stored in `context.workspaceState`.
- On a **reorder** message: recompute the saved order and persist silently (the
  webview already updated optimistically, so no echo is posted back).
- On a **resetOrder** message: clear the key and refetch so the list returns to
  the default order.

### 2. Pure ordering helpers (new) — `src/engine/order.ts`

Small, dependency-free, unit-tested module:

- `sortBySavedOrder(tasks, saved)` → returns tasks ordered with saved-ranked keys
  first (by their index in `saved`), then unranked tasks appended at the **bottom**
  in their incoming (server) order.
- `applyReorder(saved, visibleNew, visibleSet)` → rebuilds the full saved order
  from a reordered *visible* subset. Walk the old saved order; each time a key in
  `visibleSet` is encountered, emit the next key from `visibleNew` instead;
  emit non-visible saved keys in place; append brand-new visible keys (not in
  `saved`) at the end. This preserves the relative slots of keys hidden by the
  size lens.
- Prune helper: given the current full-sprint key set, drop saved keys that are no
  longer present. Only applied on a full (`size: "any"`) My-sprint fetch, so keys
  merely hidden by a size lens are never pruned.

### 3. Fetch path — `src/tasksView.ts`

- In the `fetch` handler, only when `filter === "mysprint"`, run the fetched tasks
  through `sortBySavedOrder` before posting them to the webview.
- When the fetch is a full sprint view (`size: "any"`), first prune the saved order
  against the returned keys.
- All other filters are unchanged.

### 4. Messages — `src/types.ts`

Add to `InboundMessage`:

- `{ type: "reorder"; order: string[] }` — the new order of the currently-visible
  keys.
- `{ type: "resetOrder" }` — clear the manual order.

No new `OutboundMessage` variants: reorder is optimistic; reset reuses the existing
`tasks` message from a refetch.

### 5. Webview UI — `src/webview/App.tsx` + `src/webview/styles.ts`

Gated to `filter === "mysprint"`:

- A grip handle (⠿) at the left of `card-top`. The card is `draggable` only when the
  drag is initiated from the handle (mousedown on the handle flips a flag enabling
  `draggable`), so ordinary clicks, expand, Take, and status still work.
- `dragover` computes insert-before/after from pointer Y vs. the row midpoint; a
  thin drop-indicator line marks the target slot.
- On drop: optimistically reorder the local task list and send
  `{ type: "reorder", order }` with the new visible key order.
- A small **"Reset order"** control appears on the My-sprint tab when a manual order
  exists; it sends `{ type: "resetOrder" }`.

```
My sprint tab:
┌───────────────────────────────┐
│ ⠿  ABC-12  [In Progress ▾]  ▶Take │   ← ⠿ = drag handle (only on My sprint)
│    Wire up the sprint endpoint     │
├───────────────────────────────┤
│ ══════════ drop line ══════════ │   ← insertion indicator while dragging
│ ⠿  ABC-8   [To Do ▾]        ▶Take │
└───────────────────────────────┘
        …            [ Reset order ]   ← clears saved order
```

## Testing

- **Unit** (pure helpers in `src/engine/order.ts`, matching the existing `test/`
  setup):
  - `sortBySavedOrder`: ranked-first ordering; unranked tickets land at the bottom
    in server order; empty saved order is a no-op.
  - `applyReorder`: reordering a full list; reordering a size-lens *subset*
    preserves hidden keys' slots; brand-new visible keys append at the end.
  - Prune: keys absent from a full-sprint fetch are dropped; keys hidden by a size
    lens are retained.
- **Manual / end-to-end:**
  1. Drag to reorder → reload the window → order persists.
  2. Switch tabs away and back to My sprint → order retained.
  3. Apply a size lens, reorder the subset, clear the lens → hidden tickets kept
     their slots.
  4. Add a ticket to the sprint → it appears at the bottom.
  5. Reset order → returns to default `priority/updated` order.

## Out of scope

- No Jira writes: no Agile rank API, no `claude-code` label stamped for reorder.
- Reorder disabled on all tabs except My sprint.
- No cross-workspace or cloud-synced ordering.
