# Deck (In-flight) polish — design

**Date:** 2026-07-22
**Status:** Approved pending user review
**Area:** The Deck — `src/deckView.ts`, `src/webview/DeckApp.tsx`, `src/webview/deckStyles.ts`, `src/engine/status.ts`, `src/types.ts`

## Problem

The Deck's board has four columns — **Working · Needs you · In review · Done** — filled by
`deriveBucket` in [status.ts](../../../src/engine/status.ts). Its final clause returns
`"working"` as a catch-all:

```
done   → Jira category "done"
needs  → agent ended a turn (needs-you)
working→ transcript touched < 45s ago
review → PR open or Jira status ~ review/qa
else   → "working"    ← catch-all
```

Consequences the user hit:

1. **"Working" is a dumping ground.** Idle sessions, just-launched tasks, and — when **Live
   signal is off** — *every* non-done/non-review task collapse into "Working," because with no
   agent state the row falls straight to the catch-all. The user "keeps seeing tasks in working
   mode" that nobody is actively working.
2. **Label ≠ column.** A card prints `idle · 4h ago` while sitting under a header that says
   **Working**. The two disagree.
3. **`Open` is presence-blind.** [deckView.ts `inspect`](../../../src/deckView.ts) shells out to
   `open -a <app> <path>` and never consults the presence registry
   ([presence.ts](../../../src/engine/presence.ts)) that already tracks open windows. It can't
   distinguish "already open → focus it" from "open fresh," and there's no way to tell which
   happened. The tasks view already uses `readLiveWindows()` for exactly this.

## Goals

- Stop conflating "an agent is typing right now" with "this task is in flight." The column
  becomes a neutral bucket; the **card** carries the true live state.
- Make `Open` presence-aware: an already-open window is silently focused, never duplicated.
- A broader visual/UX refresh of the board: a summary strip, richer cards, a per-card overflow
  menu, and a status vocabulary that reads clearly with Live signal on **or** off.

## Non-goals

- No change to how activity is *inferred* from transcripts ([transcript.ts](../../../src/engine/transcript.ts))
  — the 45s working window and the needs-you/idle/unknown derivation stay as-is.
- No new Jira writes; the Deck stays read-only against Jira.
- Live GitHub PR lookup is **out of scope** (see "Deferred" below).

## Decisions (from brainstorming)

- **Column model:** rename **Working → In progress**; the per-card status line carries the state.
- **Column order:** classic pipeline — **In progress → Needs you → In review → Done**, equal weight.
- **Open behavior:** silently focus an already-open window (no toast); open fresh otherwise.
- **Card actions:** include a `⋯` overflow with **Forget** (remove the run record) and **Open in Jira**.

## Design

### 1. Status vocabulary (the core fix)

The column no longer encodes activity. Live state is derived from `agent.state` +
`liveSignal` and rendered on the card:

| Agent state (source)            | Dot            | Card status text            |
| ------------------------------- | -------------- | --------------------------- |
| `working` (transcript < 45s)    | green, pulsing | `working · Ns ago`          |
| `idle` (transcript, gone quiet) | amber, solid   | `idle · Xh ago`             |
| `needs-you` (turn ended)        | red, solid     | `ended turn · Xm ago`       |
| `unknown` / live off / no file  | hollow gray    | `parked · git + Jira only`  |
| column === `done`               | hollow gray    | `merged`                    |

The **dot color is driven by agent state**, not by the column accent (today it's the column
accent). The card's left-edge accent bar and column tint remain column-driven.

Net effect: an idle task *says* "idle"; with Live signal off, cards read "parked" and still
distribute across In progress / In review / Done by the git+Jira backbone, instead of all
piling into one column.

### 2. Column model

- `DeckColumn` type: rename the member `"working"` → `"progress"`. Label: **"In progress"**.
- `deriveBucket`: the two `return "working"` become `return "progress"`. Logic is otherwise
  unchanged (done → needs → working-agent → review → progress).
- `COLUMNS` in `DeckApp.tsx`: reorder to `progress, needs, review, done`; relabel; the CSS var
  `--c-working` is renamed `--c-progress` (a calm blue) so the accent no longer reads as "amber =
  working."

### 3. Layout

- **Summary strip** in the header, computed in the webview from `runs`: `In progress` ·
  `Need you` (accented) · `In review` · `Total`. The existing **Live signal** toggle and
  **refresh / synced Ns ago** control stay on the right.
- **Board:** four equal-weight columns in pipeline order. Within a column, cards sort by
  `agent.lastActivityMs` desc, then `run.createdAt` desc, so the most recently active float up.
- **Empty & loading states:** keep the existing empty state ("No tasks in flight"); the
  `deck:loading` message already exists — render a subtle top progress hint while true.

### 4. Cards

Top: ticket key (clickable → Jira) + status (dot + text from §1).
Title.
Meta chips: **branch** (`⎇ fix/…`), **diff stat** (`＋add −del · N files`, with a `●` dirty
marker), and — when known — a **PR chip** (see Deferred).
Foot: Jira **status pill**, **launched Xago** (from `run.createdAt`), and actions:
**Open** (primary) · **Diff** · **⋯**.

**`⋯` overflow menu** (webview popover):

- **Forget** — removes the run record. New inbound message `{ type: "deck:forget"; key }`;
  host calls `removeRun(defaultRunsDir(), key)` then refreshes. This is the first way to clear a
  merged/stale card off the board.
- **Open in Jira** — reuses the existing `openExternal` message with `run.url`.

Cards whose window is currently open show a subtle inline hint — `open now — Open will focus
this window` — driven by a new `windowOpen` field (§6).

### 5. `Open` = silent focus

`inspect(key, "open")` becomes presence-aware:

1. Resolve the target as today (`run.workspaceFile ?? repo path`).
2. Check the presence registry: `readLiveWindows(defaultWindowsDir())`, compare **canonicalized**
   paths (reuse the `canon` helper) against the target.
3. **Already open** → focus it via the `open -a <app> <path>` path (macOS brings the matching
   window forward). **No success toast.**
4. **Not open** → open as today (`open -a`, falling back to `vscode.openFolder` with a new
   window). **No success toast.**
5. **Failure** (both paths error) → error toast, as today.

Success is silent in both cases (matches the "focus silently" decision and reduces noise); only
failures toast. `Diff` is unchanged.

### 6. Data-flow & type changes

- **`src/types.ts`**
  - `DeckColumn`: `"working"` → `"progress"`.
  - `RunStatus`: add `windowOpen: boolean`.
  - `InboundMessage`: add `{ type: "deck:forget"; key: string }`.
- **`src/engine/status.ts`**
  - `deriveBucket`: return `"progress"` in place of `"working"`.
  - `buildRunStatus`: accept the set of open window identities (canonical paths) and set
    `windowOpen` by matching the run's target path. Signature gains one parameter
    (e.g. `openIdentities: Set<string>`), defaulted to an empty set for existing callers/tests.
- **`src/deckView.ts`**
  - `buildAll`: read `readLiveWindows(defaultWindowsDir())` once per refresh, build the identity
    set, pass it to `buildRunStatus`.
  - `onMessage`: handle `deck:forget`.
  - `inspect` open branch: the presence-aware, silent-focus flow from §5.
- **`src/webview/DeckApp.tsx`**: `COLUMNS` reorder/rename; summary strip; `statusLabel` +
  dot-color rewritten to the §1 vocabulary; card meta (branch, dirty, launched-ago); `⋯` menu;
  inline `windowOpen` hint; per-column sort.
- **`src/webview/deckStyles.ts`**: styles for the summary strip, chips, hollow/pulse dots,
  overflow popover, and the `--c-working` → `--c-progress` rename.

### 7. Error handling & edge cases

- Presence read is best-effort (already is) — a failure yields an empty set, so `windowOpen`
  is simply `false` everywhere and `Open` still works (it just always takes the open path).
- `Forget` on a race (file already gone) is a no-op via `removeRun`'s `force: true`.
- The overflow popover closes on outside-click / Escape and on any action.
- Per-window runs with multiple repos: `windowOpen` and focus target use the primary target
  (the same one `inspect` already opens) — the first repo / the workspace file.

## Testing

- **`test/unit/engine/status.test.ts`** — update `"working"` expectations to `"progress"`;
  add cases for `buildRunStatus` setting `windowOpen` true/false from the identity set.
- **`test/unit/deckView.test.ts`** — the fixture `column: "working"` → `"progress"`; add a
  `deck:forget` → `removeRun` test and an open-focus (already-open → no success toast) test.
- **`test/webview/DeckApp.test.tsx`** — fixture `column: "working"` → `"progress"`; assert the
  new status-line text per agent state and that the `⋯` menu emits `deck:forget`.
- Full `npm test` green; changed files at ≥95% coverage.

## Deferred

- **Live PR chip / link.** The run record carries no PR reference today, and the review column
  keys off Jira status only. A real PR chip needs a stored PR URL (the "Address PR" flow finds
  one but doesn't persist it to the run). The mockup shows the intended end-state; wiring it is a
  follow-up. Until then the PR chip renders only if a `run` gains a PR field.
- Collapsible / archivable Done column beyond `Forget`.
