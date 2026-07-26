# Design: Remove from sprint

**Date:** 2026-07-26
**Status:** Approved, ready for planning

## Summary

Add a per-card **Remove from sprint** action on the **My sprint** tab of the Flow
Deck sidebar. Clicking it moves the ticket to the backlog — removing it from the
active sprint — while leaving assignee, status, and everything else untouched. The
card slides out of the list, and a native VS Code notification offers a one-click
**Undo** that puts the ticket back in the active sprint. It is the mirror of the
existing **Add to my sprint** action.

## Decisions

| Question | Decision |
|----------|----------|
| What does the write do? | **Remove from sprint only** — move the issue to the backlog. No unassign, no status change. |
| Where does it appear? | **My sprint tab only** (`filter === "mysprint"`). Not on Sprint/All/other tabs. |
| Safety model? | **Instant + Undo.** No confirmation dialog; the removal happens on click and an Undo affordance follows. |
| How does Undo surface? | **Native VS Code notification** (`showInformationMessage(msg, "Undo")`) — the only toast type that natively supports an action button. |
| Optimistic or host-confirmed? | **Host-confirmed** (like `addToMySprint`): the card is removed only after the write succeeds, so a failed write leaves it in place. |
| Provenance label? | **Stamp `cfg.provenanceLabel`** (`claude-code`) when `cfg.stampLabelOnWrite`, consistent with every other write. |

## Approach rationale

- **Move to backlog** (`POST /rest/agile/1.0/backlog/issue`) is Jira Agile's
  documented way to strip an issue from its active/future sprints. It touches
  nothing else on the issue, which matches the "remove from sprint only" decision.
- **Native notification for Undo** over extending the in-panel toast: VS Code
  notifications are the only toast that natively supports an action button, and the
  extension already uses `showInformationMessage`. This keeps the entire Undo flow
  host-side and the webview a pure renderer — no new toast state, no extra message
  types for the action. The cost is that the Undo appears as a standard VS Code
  notification in the corner rather than inside the sidebar panel.
- **Host-confirmed removal** mirrors `addToMySprint`: the webview sends an intent
  and the card is removed only when the host posts back success. A failed backlog
  write therefore leaves the card visible with an error toast, rather than
  optimistically vanishing and needing to be restored.
- **Deferred active-sprint lookup**: the backlog write itself needs no sprint id.
  `getActiveSprintId()` is only called on the Undo path, so the common
  (no-undo) case costs no extra API round-trip.

## Components

### 1. Jira client — `src/jira/client.ts`

New method mirroring `addIssueToSprint`:

```ts
/** Move an issue to the backlog — removes it from any active/future sprint (Jira Agile WRITE). */
async removeIssueFromSprint(key: string): Promise<void> {
  await this.request(`/rest/agile/1.0/backlog/issue`, {
    method: "POST",
    body: JSON.stringify({ issues: [key] }),
  });
}
```

### 2. Host handler — `src/tasksView.ts`

- New `case "removeFromSprint"` in `onMessage` → `await this.removeFromSprint(m.key)`.
- New `removeFromSprint(key)` method, shaped like `addToMySprint`:
  1. Auth guard (re-gate to sign-in on failure).
  2. `await client.removeIssueFromSprint(key)`.
  3. Stamp `cfg.provenanceLabel` when `cfg.stampLabelOnWrite` (best-effort; log on failure).
  4. Prune `key` from the saved sprint order (`saveOrder(saved without key)`) so no
     ghost rank lingers.
  5. `this.post({ type: "removedFromSprint", key })`.
  6. Undo: `const c = await vscode.window.showInformationMessage(\`${key} removed from your sprint\`, "Undo")`.
     If `c === "Undo"`: `getActiveSprintId()` → `addIssueToSprint(sprintId, key)` →
     refetch the My sprint list so the card returns (at the bottom, unranked). If
     there is no active sprint at that point, toast an error and stop.

### 3. Messages — `src/types.ts`

- Add to `InboundMessage`: `{ type: "removeFromSprint"; key: string }`.
- Add to `OutboundMessage`: `{ type: "removedFromSprint"; key: string }`.

### 4. Webview — `src/webview/App.tsx` + `src/webview/styles.ts`

- A **Remove from sprint** button in `card-actions`, rendered only when
  `filter === "mysprint"`. Quiet/secondary styling (mirrors `sprint-add`), placed
  alongside Take. `onClick` stops propagation and sends
  `{ type: "removeFromSprint", key: task.key }`.
- Handle `removedFromSprint` by filtering the card out of `tasks` — the same
  one-line pattern as `statusChanged`/`movedToSprint` with `removed: true`:
  `setTasks((prev) => prev.filter((t) => t.key !== m.key))`.

```
My sprint tab card:
┌───────────────────────────────────────────────┐
│ ⠿ ABC-12 [In Progress ▾]   ⊘ Remove   ▶ Take   │
│   Wire up the sprint endpoint                   │
└───────────────────────────────────────────────┘
        click Remove → card slides out
        ↳ VS Code notification: "ABC-12 removed from your sprint  [Undo]"
```

## Testing

- **Client unit** (`test/unit/jira/client.test.ts`): `removeIssueFromSprint` POSTs to
  `/rest/agile/1.0/backlog/issue` with body `{ issues: [key] }`.
- **Host unit** (`test/unit/tasksView.test.ts`):
  - `removeFromSprint` calls `client.removeIssueFromSprint`, posts
    `removedFromSprint`, and prunes the saved order.
  - Stamps the provenance label when `stampLabelOnWrite` is on; skips it when off.
  - Undo path (notification resolves to "Undo") re-adds via `getActiveSprintId` +
    `addIssueToSprint` and refetches My sprint.
  - Write failure surfaces an error and does **not** post `removedFromSprint`.
- **Webview** (`test/webview/App.test.tsx`): the Remove button renders only on the My
  sprint tab; clicking sends `removeFromSprint`; a `removedFromSprint` message
  removes the card.
- **Manual / end-to-end:**
  1. Remove a ticket → card slides out; VS Code notification appears.
  2. Click Undo → ticket returns to My sprint.
  3. Let the notification dismiss without Undo → ticket stays in the backlog.
  4. Simulate a write failure → card stays, error toast shown.

## Out of scope

- No unassigning, no status change, no rank/backlog-position control.
- No bulk / multi-select removal.
- No removal affordance on any tab other than My sprint.
- No cross-workspace or cloud state.
