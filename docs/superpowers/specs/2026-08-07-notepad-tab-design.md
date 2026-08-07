# Design: Notepad tab in the Tasks panel

**Date:** 2026-08-07
**Status:** Approved, ready for planning

## Summary

The Tasks sidebar webview (`agentFlow.tasks`, `src/tasksView.ts` + `src/webview/App.tsx`) currently shows one view: the task list with its filter pills. This adds a second, independent view reachable via a small tab bar at the top of the same panel — **Notepad** — a local scratchpad of freeform items unconnected to any task source (Jira or otherwise). Each note is a structured `{ title, body }` item the user types or dictates. A note can be run as an agent directly from the list, reusing the same "no ticket yet" kickoff path that Explore's ad hoc actions already use.

## Decisions

| Question | Decision |
|----------|----------|
| Where does Notepad live? | A tab inside the existing Tasks webview panel, not a separate sidebar view (rejected: mirroring Deck/Marketplace as standalone views — doesn't match "another tab in our main tab"). |
| Note shape? | Structured: `{ id, title, body, createdAt }` — not a single freeform blob. Closer to a lightweight task, easier to seed a kickoff brief from. |
| Where are notes persisted? | `context.workspaceState`, new key `agentFlow.notepad`, plain array — same pattern as `SPRINT_ORDER_KEY` in `tasksView.ts`. Per-workspace, not synced across repos or machines. |
| How does a note become an agent run? | Reuses `explore()`'s internals in `tasksView.ts` (repo/destination resolution → `createWorktrees` → `openWorkspace`) via a new `runNotepadItem(id)` method — skips the `showInputBox` prompt since the note already supplies the topic/brief text. Same "no ticket yet" brief framing Explore already uses. |
| How is speech captured? | Browser `SpeechRecognition` / `webkitSpeechRecognition` (Web Speech API), used entirely client-side inside the webview's `Notepad.tsx` — no new extension-host code or message-protocol traffic for transcription itself. |
| Does this touch the existing Tasks list, filters, or connectors? | No. Tasks view, `EXPLORE_ACTION_DEFS`, Jira/task connector code, worktree/workspace engine internals are unchanged except for the new `runNotepadItem` entry point, which is additive. |

## Approach rationale

- **Reuse, don't reinvent, the kickoff path.** `explore()` already has a fully-working "ad hoc, no ticket" flow: pick repos/destination, build a slug + brief, call `createWorktrees`/`openWorkspace`, optionally seed the agent. A notepad item is exactly that same case, just with the topic/brief supplied up front instead of via `showInputBox`. Factoring the shared tail of `explore()` into a small helper avoids a second, parallel kickoff implementation.
- **Persistence mirrors an existing pattern.** `sprintOrder` is already the precedent for "small piece of webview-adjacent state living in `workspaceState`." Notes follow the same shape: host owns storage, webview is a thin renderer that round-trips through `postMessage`.
- **No new file-based persistence.** Unlike task briefs (`.pick-task/`) or plan handoff (`~/.agentflow/plans/`), notes are pure local UI state — they don't need to survive being read by a spawned agent process before the kickoff happens, so `workspaceState` is sufficient and keeps this feature's blast radius small.
- **STT stays client-side.** The Web Speech API needs no API key, no network call from the extension host, and no new dependency — it runs inside the webview's Chromium engine. This trades some accuracy for zero setup, which is the right trade for dictating short note text.

## Tab bar & Notepad view

`App.tsx` gains a small segmented control above the existing filter pills, with two entries: **Tasks** (default) and **Notepad**. This is local `useState`, not persisted — the panel always opens on Tasks. Switching tabs swaps the content area; the existing task list/filter-pill UI is otherwise untouched.

`Notepad.tsx` (new) renders:
- An "add note" form: title input + body textarea, with a mic icon button beside the textarea.
- A list of existing notes, newest first, each with a "Run agent" button and a delete button. Clicking a note allows inline editing of title/body.

## Message protocol

New `InboundMessage` variants (webview → host), added alongside the existing union in `src/types.ts`:
- `{ type: "notepad:add", title: string, body: string }`
- `{ type: "notepad:update", id: string, title: string, body: string }`
- `{ type: "notepad:delete", id: string }`
- `{ type: "notepad:run", id: string }`

New `OutboundMessage` variant (host → webview):
- `{ type: "notepad:state", notes: NotepadItem[] }` — sent on `ready` and after every mutation, mirroring how task state already round-trips after writes.

`TasksViewProvider.onMessage` gets four new `case` branches following the existing dispatch style (each delegating to a small private method: `addNote`, `updateNote`, `deleteNote`, `runNotepadItem`).

## Kickoff flow (`runNotepadItem`)

1. Look up the note by `id` in the stored array; if missing, toast an error (same defensive pattern as other key-based operations).
2. Resolve repos/destination the same way `explore()` does today (existing repo-discovery + destination-picker code, unchanged).
3. Build `topic` from the note's `title` (fallback to a generic label if empty, matching `explore()`'s `raw.trim() || ...` fallback idiom) and slug via `slugify(topic)`.
4. Build the brief markdown from the note's `body`, framed the same way Explore's "no ticket yet" notes are (`## Exploration: ${topic}` style header + body content).
5. Call the same `createWorktrees` / `openWorkspace` sequence `explore()` uses, including optional agent seeding.
6. Existing note stays in the list after a run (not auto-deleted) — the user can re-run or delete manually.

## Speech-to-text

The mic button in `Notepad.tsx` toggles a `SpeechRecognition` instance (feature-detected as `window.SpeechRecognition || window.webkitSpeechRecognition`; if neither exists, the mic button is hidden). While listening, interim and final results append into the body textarea. No changes to `package.json` webview CSP are anticipated since `SpeechRecognition` runs in-process in the webview's Chromium engine, but this will be verified during implementation — if the webview's `retainContextWhenHidden`/CSP setup blocks microphone access, a minimal permissions adjustment will be added then.

## Testing

- Unit tests for the new `TasksViewProvider` methods (`addNote`/`updateNote`/`deleteNote`/`runNotepadItem`) following the existing test patterns for `tasksView.ts` (mocked `workspaceState`, mocked `createWorktrees`/`openWorkspace`).
- Component test for `Notepad.tsx` covering add/edit/delete/run interactions via the message protocol (mocked `vscodeApi.send`), following existing `App.tsx` test conventions.
- Speech-to-text is not unit-testable in a meaningful way (browser API, no jsdom support) — verified manually during implementation instead.
