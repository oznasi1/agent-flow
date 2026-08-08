# Design: Notepad tab in the Tasks panel

**Date:** 2026-08-07
**Status:** Approved, ready for planning

## Summary

The Tasks sidebar webview (`agentFlow.tasks`, `src/tasksView.ts` + `src/webview/App.tsx`) currently shows one view: the task list with its filter pills. This adds a second, independent view reachable via a small tab bar at the top of the same panel — **Notepad** — a scratchpad of freeform items unconnected to any task source (Jira or otherwise), shared globally across every workspace/repo the extension runs in. Each note is a structured `{ title, body, done }` item the user types or dictates, can mark done/undone, filter by status, and bulk-clear once done. A note can be run as an agent directly from the list, reusing the same "no ticket yet" kickoff path that Explore's ad hoc actions already use. Once run, the note shows that run's live status (running / stale / finished) directly in the Notepad list, and the run itself shows up on the Deck ("in-flight") board alongside task-originated runs — Deck's board becomes fed by two origins, task kickoffs and notepad kickoffs, both landing in the same run store it already reads.

## Decisions

| Question | Decision |
|----------|----------|
| Where does Notepad live? | A tab inside the existing Tasks webview panel, not a separate sidebar view (rejected: mirroring Deck/Marketplace as standalone views — doesn't match "another tab in our main tab"). |
| Note shape? | Structured: `{ id, title, body, done, createdAt, lastRunKey? }` — not a single freeform blob. Closer to a lightweight task, easier to seed a kickoff brief from. `lastRunKey` is set on kickoff and drives the status badge; it's the only run-related field stored on the note itself, everything else (running/stale/finished) is derived at read time. |
| Where are notes persisted? | `context.globalState`, new key `agentFlow.notepad`, plain array. Deliberately **global**, not `workspaceState` — the user wants the same notepad regardless of which workspace/repo the panel is open in (e.g. same list in Cursor and in a plain VS Code window on a different repo), so notes are not scoped per-workspace the way `sprintOrder` is. |
| Can a note be marked done? | Yes — a checkbox toggles `done` on each note. Done notes stay in the list (not auto-removed) until explicitly cleared. |
| How does the user manage done vs. not-done? | A filter control (All / Active / Done) above the note list, and a "Clear completed" button that removes every `done: true` note in one action. |
| How does a note become an agent run? | Reuses `explore()`'s internals in `tasksView.ts` (repo/destination resolution → `createWorktrees` → `openWorkspace`) via a new `runNotepadItem(id)` method — skips the `showInputBox` prompt since the note already supplies the topic/brief text. Same "no ticket yet" brief framing Explore already uses. |
| How is speech captured? | Browser `SpeechRecognition` / `webkitSpeechRecognition` (Web Speech API), used entirely client-side inside the webview's `Notepad.tsx` — no new extension-host code or message-protocol traffic for transcription itself. |
| Does this touch the existing Tasks list, filters, or connectors? | No. Tasks view, `EXPLORE_ACTION_DEFS`, Jira/task connector code, worktree/workspace engine internals are unchanged except for the new `runNotepadItem` entry point, which is additive. |
| How does a notepad run show up on the Deck board? | `runNotepadItem` calls `openWorkspace({ ..., kind: "notepad" })` exactly like `explore()` does with `kind: "explore"` — this writes a normal `Run` record via `writeRun(defaultRunsDir(), run)` (`src/engine/workspace.ts`) into the same `~/.agentflow/runs` store Deck already reads via `readRuns()`. `"notepad"` is added to `RUN_KINDS` (`src/types.ts`) alongside `"task" \| "explore" \| "review" \| "local"`, so it survives `runKind()`'s clamp instead of silently becoming `"task"`. No new merge/aggregation logic is needed in `deckView.ts` — it was already reading one run store; the "two sources" are two origins that both write into it. |
| How does the note know its own run's status? | Each note gains an optional `lastRunKey` (the synthetic ticket key `openWorkspace` generates, e.g. `notepad-<slug>`), set when "Run agent" is clicked. `TasksViewProvider` computes a small `NotepadRunStatus` (`running \| stale \| finished \| none`) per note by looking up that key in the same `readRuns()`/`readOpenSessions()`/retire-verdict data Deck already computes from, and includes it in the `notepad:state` payload. Re-running a note overwrites `lastRunKey` — history of earlier runs from the same note isn't tracked, only the most recent. |

## Approach rationale

- **Reuse, don't reinvent, the kickoff path.** `explore()` already has a fully-working "ad hoc, no ticket" flow: pick repos/destination, build a slug + brief, call `createWorktrees`/`openWorkspace`, optionally seed the agent. A notepad item is exactly that same case, just with the topic/brief supplied up front instead of via `showInputBox`. Factoring the shared tail of `explore()` into a small helper avoids a second, parallel kickoff implementation.
- **Persistence follows the existing storage split, but on the global side.** `INSTALLED_KEY` in `extension.ts` is already the precedent for "small piece of state living in `context.globalState`" — data the user thinks of as belonging to *them*, not to a particular repo. A notepad is exactly that: scratch items the user wants available no matter which workspace the panel happens to be open against. `sprintOrder`'s `workspaceState` pattern is the wrong precedent here because it's deliberately per-repo ordering, the opposite of what's being asked for.
- **No new file-based persistence.** Unlike task briefs (`.pick-task/`) or plan handoff (`~/.agentflow/plans/`), notes are pure UI state — they don't need to survive being read by a spawned agent process before the kickoff happens, so `globalState` is sufficient and keeps this feature's blast radius small.
- **STT stays client-side.** The Web Speech API needs no API key, no network call from the extension host, and no new dependency — it runs inside the webview's Chromium engine. This trades some accuracy for zero setup, which is the right trade for dictating short note text.
- **Deck integration is "join the existing store," not "build a merge."** Deck already treats `~/.agentflow/runs` as the single source of truth for board cards, with `kind` as the only thing that varies per origin (`task`/`explore`/`review`/`local`). Adding `"notepad"` as a fifth `kind` and writing through the same `openWorkspace`/`writeRun` path `explore()` already uses means Deck picks up notepad runs automatically on its next poll (`POLL_MS = 6000` in `deckView.ts`) — no second data path, no notepad-specific fetch inside Deck.
- **Status shown in Notepad reuses Deck's own verdict logic, not a parallel implementation.** `retire.ts`'s `retireVerdict` (stale/abandoned/finished) and the live-session lookup (`readOpenSessions`/`groupByPlace`) are already the mechanism Deck uses to answer "is this run alive." The Notepad's per-note status is a read-only projection of that same logic onto the note's `lastRunKey`, not a second staleness heuristic.

## Tab bar & Notepad view

`App.tsx` gains a small segmented control above the existing filter pills, with two entries: **Tasks** (default) and **Notepad**. This is local `useState`, not persisted — the panel always opens on Tasks. Switching tabs swaps the content area; the existing task list/filter-pill UI is otherwise untouched.

`Notepad.tsx` (new) renders:
- An "add note" form: title input + body textarea, with a mic icon button beside the textarea.
- A filter control (All / Active / Done) plus a "Clear completed" button (disabled/hidden when there are no done notes), mirroring the existing task filter-pill styling for visual consistency with the Tasks tab.
- A list of notes matching the current filter, newest first, each with: a done/undone checkbox, a "Run agent" button, a delete button, and — once a note has been run — a small status badge (Running / Stale / Finished) reflecting its `lastRunKey`'s current state. Clicking a note allows inline editing of title/body. Done notes render with a struck-through or dimmed title (styling detail, decided during implementation) but remain fully interactive (still runnable, editable, deletable individually).

## Message protocol

New `InboundMessage` variants (webview → host), added alongside the existing union in `src/types.ts`:
- `{ type: "notepad:add", title: string, body: string }`
- `{ type: "notepad:update", id: string, title: string, body: string }`
- `{ type: "notepad:toggleDone", id: string }`
- `{ type: "notepad:delete", id: string }`
- `{ type: "notepad:clearCompleted" }`
- `{ type: "notepad:run", id: string }`

New `OutboundMessage` variant (host → webview):
- `{ type: "notepad:state", notes: NotepadItem[] }` — sent on `ready`, after every mutation, and on the same poll cadence Deck uses (`POLL_MS`) so run status badges stay current without user action. Each `NotepadItem` sent to the webview includes a derived `runStatus?: "running" | "stale" | "finished"` alongside the persisted fields — computed server-side, not stored.

`TasksViewProvider.onMessage` gets six new `case` branches following the existing dispatch style (each delegating to a small private method: `addNote`, `updateNote`, `toggleNoteDone`, `deleteNote`, `clearCompletedNotes`, `runNotepadItem`).

## Kickoff flow (`runNotepadItem`)

1. Look up the note by `id` in the stored array; if missing, toast an error (same defensive pattern as other key-based operations).
2. Resolve repos/destination the same way `explore()` does today (existing repo-discovery + destination-picker code, unchanged).
3. Build `topic` from the note's `title` (fallback to a generic label if empty, matching `explore()`'s `raw.trim() || ...` fallback idiom) and slug via `slugify(topic)`.
4. Build the brief markdown from the note's `body`, framed the same way Explore's "no ticket yet" notes are (`## Exploration: ${topic}` style header + body content).
5. Call the same `createWorktrees` / `openWorkspace` sequence `explore()` uses, passing `kind: "notepad"`, including optional agent seeding.
6. `openWorkspace` returns/derives the run's key (the same key it wrote into the `Run` record); store it on the note as `lastRunKey` and persist.
7. Existing note stays in the list after a run (not auto-deleted, not auto-marked done) — the user decides separately whether/when to check it off or delete it.

## Done / filter / cleanup

- `toggleNoteDone(id)` flips the note's `done` flag in `globalState` and re-posts `notepad:state`.
- The filter (All / Active / Done) is purely client-side in `Notepad.tsx` — the host always sends the full note array; the webview decides what to render, matching how task filters already work as a client-side view over host-sent data.
- `clearCompletedNotes()` removes every note with `done: true` from the stored array in one `globalState` write, then re-posts `notepad:state`. No per-note confirmation; the button itself is the confirming action (consistent with it only being enabled when there's at least one done note to clear).

## Deck integration ("notepad" run kind)

- `RUN_KINDS` and the `Run["kind"]` union in `src/types.ts` (~lines 75/89/93) gain `"notepad"` alongside the existing `"task" | "explore" | "review" | "local"`; `runKind()` no longer needs to clamp it to `"task"`.
- `deckView.ts`'s board-vs-strip filter (`runKind(r) !== "review"`, line ~583) already lets any non-`"review"` kind through, so notepad runs appear on the board with no change there. The abandoned/stale sweep (`applyVerdict`/`sweepReviewRuns`, lines ~687-703) currently special-cases only `"local"` and `"review"`; `"notepad"` is treated like `"explore"` — a ticketless, ad hoc run, eligible for the same `retireAbandonedAfterDays` rule since it has no PR/ticket to anchor "finished" on.
- `src/webview/DeckApp.tsx` (~lines 211-270) gets a `"notepad"` branch in the same place it currently special-cases `"explore"`/`"local"` key-label rendering — shows something like "From Notepad" instead of a ticket key, consistent with how "explore" runs already render without a real ticket link.
- No changes to `readRuns`, `readOpenSessions`, or `groupByPlace` — they're kind-agnostic already; this is purely a "add a literal, teach two call sites how to label/retire it" change.

## Speech-to-text

The mic button in `Notepad.tsx` toggles a `SpeechRecognition` instance (feature-detected as `window.SpeechRecognition || window.webkitSpeechRecognition`; if neither exists, the mic button is hidden). While listening, interim and final results append into the body textarea. No changes to `package.json` webview CSP are anticipated since `SpeechRecognition` runs in-process in the webview's Chromium engine, but this will be verified during implementation — if the webview's `retainContextWhenHidden`/CSP setup blocks microphone access, a minimal permissions adjustment will be added then.

## Testing

- Unit tests for the new `TasksViewProvider` methods (`addNote`/`updateNote`/`toggleNoteDone`/`deleteNote`/`clearCompletedNotes`/`runNotepadItem`) following the existing test patterns for `tasksView.ts` (mocked `globalState`, mocked `createWorktrees`/`openWorkspace`).
- Unit test that a note's derived `runStatus` tracks the same `readRuns`/`readOpenSessions`/`retireVerdict` inputs Deck's own tests already fixture, for each of running/stale/finished/none.
- Unit test that a run written with `kind: "notepad"` survives `runKind()` unchanged (doesn't clamp to `"task"`) and is included by Deck's board filter and excluded correctly from the review strip.
- Component test for `Notepad.tsx` covering add/edit/toggle-done/delete/run/clear-completed interactions, the All/Active/Done filter, and the status badge rendering for each `runStatus` value, via the message protocol (mocked `vscodeApi.send`), following existing `App.tsx` test conventions.
- Speech-to-text is not unit-testable in a meaningful way (browser API, no jsdom support) — verified manually during implementation instead.
