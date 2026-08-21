# Notepad bulk select: move many, invoke many

_Design — 2026-08-14. Source: a notepad item, "Add bulk update for notpad list and bulk
invoke like the tasks", with two use cases named in the note: multi-select and move to
another section, and invoke several notes together in the same window._

## Goal

The notepad list gets a selection: pick several notes, then either refile all of them
into one section, or launch all of them as agent runs in a single window. Both actions
already exist one note at a time (`notepad:setSection`, `notepad:run`) and both already
exist in bulk on the Tasks tab (the `.batch-*` bar feeding `takeBatch`). This is the
notepad's version of that bar, not a new mechanism.

## Non-goals

- No bulk delete and no bulk mark-done. The note names two use cases; the bar ships
  exactly those two actions.
- No change to single-note Start. It keeps launching into the chosen folder without a
  worktree; only the batch path creates worktrees (see "Why the batch needs worktrees").
- No per-note repo targeting. One repo pick applies to the whole batch.
- No new persisted state. Selection and select mode are webview-local and die with the
  panel, the way the note filter already does.

## Decisions

| Decision | Chosen | Why |
|---|---|---|
| Invoke shape | One window, one agent session per note, one git worktree per note | Mirrors `takeBatch`'s shared-window path. N notes in one shared checkout would overwrite each other's `.pick-task/TASK.md`. |
| Repo scope | One `canPickMany` pick for the whole batch | One decision, one picker; matches how `takeBatch` applies one repo filter to every task. |
| Selection UI | An explicit Select mode, off by default | The only shape where selection never competes with the row's drag/text-selection fork (see the `armed` comment in `Notepad.tsx`). Off by default means a resting notepad is unchanged for every existing user. |
| Move UI | A `Move to ▾` popover listing sections plus Ungrouped | Scales past a few sections and reaches collapsed ones, which chips in a narrow panel and drag-onto-header both fail at. |

Mockups behind the UI decisions: `preview/np-bulk-options.html`, shot at
`preview/_np-bulk-options.png` (both git-ignored).

## Webview: `src/webview/Notepad.tsx`

Two pieces of local state, same shape as the Tasks tab's `batchSelected`:

```ts
const [selectMode, setSelectMode] = React.useState(false);
const [picked, setPicked] = React.useState<Set<string>>(new Set());
```

**Mode off (default).** The component renders exactly today's tree: no select boxes, no
bar, grips present, `.np-acts` at full strength. This is a hard requirement, not a nicety
— every existing `Notepad.test.tsx` case must pass unmodified.

**Mode on.**

- A `Select` toggle joins the existing filter `.lens` row, `aria-pressed={selectMode}`.
- Each `NoteRow` renders `<input type="checkbox" className="cb np-sel">` in the grip's
  slot, and no grip: reorder-drag is unavailable while selecting. `aria-label` is
  `Select: <title or "untitled note">`, distinct from the done checkbox's existing
  `Done: <title>` — two checkboxes in one row must not read alike to a screen reader or
  to `getByLabelText`.
- A picked row gets `.picked`: a brand-tinted background and a brand rail overlay. The
  run-status rail keeps its own 2px column; the selection rail is a separate `::after`,
  so a running note reads as both.
- `.np-acts` dims (opacity, still clickable) — per-row Start is not the action the user
  is reaching for in this mode.
- Leaving the mode clears `picked`. Toggling a filter does not: ids survive, but see
  visibility below. A successful `Start together` also clears the selection and leaves the
  mode — those notes are running now.

**The bar.** Reuses `.batch-bar`, `.batch-count`, `.batch-selectall`, `.batch-clear`,
`.batch-launch` unchanged from `styles.ts`, plus one new `.batch-move`. Contents:

`N selected` · `Select all` · `Clear` · `Move to ▾` · `▶ Start together`

- Rendered only when at least one *visible* note is picked. Visibility is the filter's
  `shown` list, exactly as `selectedVisible` gates the Tasks bar: a note hidden under
  Active/Done must never be launched or refiled by an action whose count did not include
  it.
- `Select all` picks every visible note; `Clear` empties the set (mode stays on).
- `Move to ▾` opens a popover built on the existing `.repo-pop` language: one row per
  section, plus `Ungrouped` first. Choosing one sends `notepad:moveMany` and closes.
- `▶ Start together` sends `notepad:runMany`. Its `title` names what will happen, the
  way the Tasks bar's does: N notes, one window, a session and a worktree each.
- Done notes may be selected and launched. Per-row Start already allows that today;
  silently excluding them would be a second, invisible filter.

Both sends carry only visible-and-picked ids, in the list's display order — the order the
user sees is the order the sessions are seeded in.

## Message contracts: `src/types.ts`

```ts
| { type: "notepad:moveMany"; ids: string[]; sectionId?: string }
| { type: "notepad:runMany"; ids: string[] }
```

`sectionId` absent means Ungrouped, matching `notepad:setSection`'s existing convention.

`notepad:runMany` joins `MESSAGE_OPS` as `workspace_write`, beside `notepad:run` — a
failed batch must report under the op that describes it. `notepad:moveMany` stays out of
that map, exactly like every other note-state write (`notepad:add`, `notepad:setSection`,
…): it touches no engine operation worth attributing.

A notepad batch never edits the user's `.code-workspace` file. `takeBatch` offers to merge
worktrees into an existing workspace as roots; this path passes no `foldersToAdd`, which
leaves that file byte-identical. The worktrees then aren't roots of that window, and the
seeded prompts carry absolute brief paths — the same trade `openSharedWorkspace` already
makes for its live-folder destination.

## Host: `src/tasksView.ts`

**`moveMany`.** One `saveNotes` pass over the whole set, then one `postNotepad`. Not N
calls to `setNoteSection`: that would be N disk writes and N posts, and a partial failure
would leave the list half-refiled with no single state to reason about. Unknown ids are
dropped, not an error — a stale webview naming a deleted note must be inert.

**`runNotepadBatch(ids)`.** Modelled on `takeBatch`, with the task-source steps removed
(a note has no ticket to fetch, and the notepad needs no auth):

1. Resolve `ids` to notes; drop unknown ones; return if none remain.
2. `remoteControlBlocksLaunch(cfg)` gate.
3. `discoverRepos`; toast and return if the root holds none.
4. Over `cfg.batchLaunchConfirmThreshold` notes, the modal warning `takeBatch` shows.
   Not "Launch" ⇒ return.
5. `chooseOpenTarget(cfg)`. Cancel ⇒ return. For `kind: "current"`, re-read
   `currentWindow()` immediately before the launch and fail the batch if this window has
   lost its identity in the meantime — the same guard, for the same reason, as
   `takeBatch`'s shared path.
6. One `canPickMany` repo picker — "Notepad batch — pick the repos to open". Cancel ⇒
   return. Asked for *every* destination, unlike `resolveKickoffTarget`, which lets an
   existing workspace or this window supply its own repo set: worktrees have to be cut
   from discovered repos, and the folders a destination already holds are checkouts, not
   somewhere a batch may safely put N sessions.
7. Per note: `createWorktrees(picked, key, note.title, this.log)` where
   `key = notepad-${slugify(title) || "note"}-${id}`, the same key the single-note path
   uses (so re-running a note replaces its own prior run record rather than accumulating
   orphans). Detect the returned-original-ref collision case and fail *that note*,
   collecting it into `failed` — one bad repo must not sink the batch.
8. One `openSharedWorkspace` call with every resolved note as a `BatchTask`,
   `kind: "notepad"`, and the generic explore action's prompt as the template — the same
   `exploreActions.find(a => a.id === "general")` lookup, by stable id, that the single
   path uses.
9. Write `lastRunKey` on each launched note in one `saveNotes` pass, *after* the launch:
   a cancelled or failed batch must leave no pointer to a run that was never created.
10. One summary toast: launched count, where, seeding note, and any `failed` entries
    named with their reason.

Remote Control is never resolved here and never applied: one clipboard cannot serve N
sessions, and a shared window seeds each session from its own plan file. The log line
`takeBatch` writes for this has a sibling here.

## Engine: `src/engine/batchWorkspace.ts`

Two gaps that reuse exposes. Both are additive and both keep `takeBatch` byte-identical
in behavior.

**1 — `kind` passthrough.** `openSharedWorkspace` writes its `Run` records without a
`kind` field, which `runKind()` reads as `"task"`. A notepad run must be
`kind: "notepad"`: the Deck treats notepad runs as structurally PR-less, because a note
launches onto whatever branch was already there and a PR found on that branch belongs to
someone else's work. Without this, every batched note would inherit a stranger's PR, be
voted into Needs-you or Done by `prSignals`, and leave Forget as the only escape — the
exact defect `prLess` exists to prevent.

```ts
export interface SharedOpenRequest {
  // ...
  /** What launched this batch. Omitted means a task, as today. */
  kind?: Run["kind"];
}
```

Set on each written `Run` as `kind: req.kind`.

**2 — per-task prompt suffix.** The single-note path passes the note's body as
`promptSuffix` because the generic template carries only `{summary}`: without it the
detail the user typed reaches the agent only if the agent opens `TASK.md` first, which a
freshly seeded session is least likely to do. The shared path has no equivalent —
`agentPrompt(t, mentions, template, briefPath)` takes no suffix.

```ts
export interface BatchTask {
  // ...
  /** Appended verbatim after the rendered template, never interpolated into it —
   *  the user's own words must never be read as placeholders. */
  promptSuffix?: string;
}
```

`agentPrompt` gains an optional trailing `suffix` parameter, applied exactly as
`openWorkspace` applies its own (`\n\n${suffix.trim()}` when non-empty). Absent ⇒ output
unchanged, so every existing caller and its tests are unaffected.

## Edge cases

| Case | Behavior |
|---|---|
| One note selected | A one-note batch still goes down the shared path: one worktree, one session. Consistent, and the confirm threshold never trips. |
| A picked note is hidden by the filter | Excluded from the count and from both actions. |
| A picked note is deleted by another window | Dropped host-side; the rest proceed. |
| `Move to` a section deleted under the panel | The note lands with a `sectionId` no section owns, which the list already renders as ungrouped rather than vanishing. |
| Any picker cancelled | Nothing opened, no worktree created past that point, no `lastRunKey` written. Steps 1–6 create nothing at all. |
| A repo's worktree collides | That note fails and is named in the toast; the others launch. |
| Worktree folder names | `folderName(key, repo)` yields `notepad-<slug>-<id>-<repo>`, which is long. Accepted: it is a workspace-folder label, and the key qualifier is what keeps two notes in one repo from presenting as identical roots. |
| Notes still selected after launch | Selection clears and select mode exits on a successful launch — the pile has moved on. |

## Testing

Unit — `test/unit/tasksView.test.ts`, `test/unit/notepad.test.ts`:

- `moveMany` writes once, posts once, and refiles exactly the named ids; unknown ids are
  inert.
- `runNotepadBatch` cancellation at each of the repo picker, the threshold modal, and the
  destination picker leaves zero worktrees, zero runs, and no `lastRunKey`.
- Every run written by a batch carries `kind: "notepad"`.
- Each note's body reaches its own session's prompt (suffix threading), and a note with
  an empty body produces a prompt byte-identical to the no-suffix render.
- A worktree collision fails one note and launches the rest.

Unit — `test/unit/engine/`: `openSharedWorkspace` with no `kind` still writes what it
writes today; with `kind` it stamps every record.

Webview — `test/webview/Notepad.test.tsx`:

- Mode off renders no select boxes and no bar.
- The toggle enters and leaves the mode; leaving clears the selection.
- `Select all` picks visible notes only; switching the filter drops a now-hidden note
  from the count.
- `moveMany` and `runMany` payloads carry the right ids in display order.
- The two checkboxes in a row are reachable by distinct accessible labels.

Gates, all required before this is done: `npm run typecheck`, `npm test`,
`npm run test:cov` (thresholds enforced), and `npm run build` — the last because the
webview must not reach `fs`, and only the bundle catches that.

## Risks

- **Select mode takes the grip**, so reorder-drag is unavailable while selecting. A
  deliberate trade for a gesture that has already caused one Blink drag/selection defect
  in this file. If it grates in use, the fallback is a narrow gutter holding both.
- **Notepad batches create worktrees** where single notepad runs never have. This is the
  price of N sessions in one window; the toast should say where the worktrees went so the
  user is never surprised by them.
