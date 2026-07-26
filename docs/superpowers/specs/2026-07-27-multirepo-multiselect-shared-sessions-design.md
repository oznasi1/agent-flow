# Multi-repo multi-select & N sessions at the chosen destination

## Problem

Multi-select parallel launch shipped with two deliberate restrictions
([2026-07-23 spec](2026-07-23-multiselect-parallel-launch-design.md), "Out of
scope"):

1. **One repo only.** `batchMode = selectedRepos.size === 1`
   ([`App.tsx`](../../../src/webview/App.tsx)) hides the checkboxes and the
   launch bar unless the repo filter resolves to exactly one repo. Narrow the
   pool to two repos and multi-select disappears.
2. **One destination only.** `takeBatch`
   ([`tasksView.ts`](../../../src/tasksView.ts)) never calls
   `chooseOpenTarget`. It hardcodes `mode: "per-window", openIn: "new"`, so a
   batch always fans out to one new window per task. The `agentFlow.openIn`
   setting and the "Open the task where?" pick that every single Take honours
   are silently ignored for batches.

The shared-window layout the original spec sketched ("all worktrees in a single
window, N Claude sessions seeded into it") was gated behind a feasibility
spike that was never run, and the fallback — seed only the first task — was
never built either.

**The spike is now resolved.** Claude Code 2.1.220 registers
`claude-vscode.editor.open(sessionId, prompt, viewColumn)`, which calls
`createPanel(sessionId, prompt, viewColumn)`. `createPanel` reuses an existing
panel *only* when `sessionId` names one it already tracks; with `sessionId`
undefined it calls `vscode.window.createWebviewPanel` unconditionally — a fresh
Claude session per call. It also resolves its column by looking for a tab group
whose tabs are all `claudeVSCodePanel` webviews, so the second and later calls
land as extra tabs in the *same* Claude group. N calls = N sessions, N tabs, one
column, one window.

## Goal

- Offer multi-select whenever **one or more** repos are selected in the filter,
  mapping each task to the repos it actually touches.
- Make a batch honour the **destination pick**. Where the destination is a
  single window, pre-seed **one Claude Code session per selected task** in it.

## Scope

- Widen the multi-select gate to `selectedRepos.size >= 1`.
- Per-task repo resolution: inferred repos ∩ the filter set.
- `takeBatch` walks the standard destination chain, then a layout pick.
- A new shared-window engine path: N tasks → one window → N seeded sessions.
- Seeder support for more than one session per window.

Out of scope:

- **Multi-select with no repo filter.** Zero selected repos still means no
  checkboxes. Without a bounded repo set there is nothing to intersect a task's
  inferred repos against, and "launch everything in the pool" is not a coherent
  action.
- **Per-task prompt modes or destinations.** Both stay batch-wide, as today.
- **Non-worktree batches.** Worktrees remain mandatory (§4) — they are what
  keeps N agents from colliding, and in the shared window they are the folder
  roots.
- **Remote Control for N > 1.** One clipboard cannot serve N sessions. The
  existing rule and its toast note carry over unchanged.

## Design

### 1. Selection UI (`src/webview/App.tsx`)

`batchMode` becomes `selectedRepos.size >= 1`. `theRepo` is deleted; the launch
button sends the whole filter set:

```ts
send({ type: "takeBatch", keys: selectedVisible.map((t) => t.key), repos: [...selectedRepos] })
```

The button's `title` changes from the single-repo phrasing to
`Open N task(s) across <repos, joined>, each with its own Claude Code session` —
"worktrees in <repo>" is no longer accurate now that a task's repo set is
per-task.

Everything else in the selection UI is unchanged: checkbox rendering,
`batchSelected` state and its pruning, "Select all visible", "Clear selection",
and the `canReorder` interaction (already disabled whenever any repo is
selected, so still inactive in batch mode).

### 2. Message protocol (`src/types.ts`)

```diff
-| { type: "takeBatch"; keys: string[]; repo: string }
+| { type: "takeBatch"; keys: string[]; repos: string[] }
```

A breaking shape change with no compatibility shim: host and webview ship in one
bundle and always deploy together.

### 3. Host orchestration (`src/tasksView.ts`)

`takeBatch(keys, repos)` runs:

1. **No keys** → return.
2. **Auth gate** — unchanged.
3. **Resolve the filter set.** `discoverRepos(...)`, map each name to its
   `ServiceRef`. Names that resolve to nothing are dropped and named in a
   warning toast; if none resolve, abort.
4. **Git guard.** Non-git repos are **dropped from the set** with an info note
   naming them, rather than aborting the batch — with several repos selected,
   one non-git folder should not block the rest. Abort only if the set empties.
   (Today's single-repo behaviour aborts; this is the multi-repo generalisation.)
5. **Large-batch confirm.** Unchanged position — before any picker, so the
   escape hatch comes first. Wording becomes layout-neutral, since the layout
   is not known yet: `Launch N tasks in parallel? That's N Claude Code sessions.`
6. **Prompt mode — once.** `choosePromptMode`, unchanged.
7. **Destination — once.** `chooseOpenTarget(cfg)`, the same call `resolveKickoff`
   makes. Honours `agentFlow.openIn` and offers live windows when
   `trackOpenWindows` is on. Cancel aborts the batch.
8. **Layout — once, conditionally.** A two-option QuickPick, shown **only** when
   `target.kind === "new"` and `keys.length > 1`:
   - `$(multiple-windows) Separate windows` — one window per task.
   - `$(window) One shared window` — one window, N sessions.

   For `current`, `existing`, and `live-folder` the destination *is* a single
   window, so the layout is forced to shared with no modal. A one-key batch is an
   ordinary single-window launch and skips the pick entirely.
9. **Resolve tasks.** For each key: `getDetail(key)`, then `inferServices` over
   the detail, intersected with the *resolved, git* filter set from steps 3–4; an
   empty intersection falls back to that whole set, so a task never launches with
   zero repos. Then
   `createWorktrees(taskRepos, key, summary)`. A worktree that falls back to the
   main checkout (`createWorktrees` returns the original ref on failure) fails
   that task, as today — a shared checkout would clobber another task's brief.
10. **Dispatch.**
    - *Separate windows* → today's loop: `openWorkspace` per task with
      `mode: "per-window", openIn: "new"`, staggered by `BATCH_STAGGER_MS`.
    - *Shared window* → one `openSharedWorkspace` call (§4).
11. **Summary toast.** `Launched N of M …` plus per-task failures, as today, with
    the layout named so the user knows what to expect.

Steps 5–8 are all resolved before any ticket is read, so the launch loop stays
non-interactive.

### 4. Shared-window assembly (new `src/engine/batchWorkspace.ts`)

`openWorkspace` cannot be called N times against one destination: each call
would rewrite and reopen the same `.code-workspace`. A sibling entry point does
the whole batch in one pass.

`workspace.ts` is already ~500 lines; rather than grow it, the batch path lives
in its own module and imports the pieces it reuses. `briefMarkdown`,
`agentPrompt`, `writePlanFile`, `openInEditor`, `mergeReposIntoWorkspace`, the
`PlanFile` type and the `BRIEF_DIR`/`BRIEF_FILE` constants become exported from
`workspace.ts`.

```ts
export interface BatchTask {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  services: ServiceRef[]; // already worktrees
}

export type SharedTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

export interface SharedOpenRequest {
  tasks: BatchTask[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  target: SharedTarget;
}

export interface SharedOpenResult {
  workspaceFile?: string;
  opened: boolean;
  briefs: { key: string; repo: string; path: string; gitExcluded: boolean; files: number }[];
  mergedFolders?: string[];   // folders added to an existing workspace
  mergeFailed?: boolean;      // existing workspace unparseable; opened as-is
  unaddedFolders?: string[];  // live-folder: roots that couldn't be injected
  seeded: number;             // plan files written
}
```

**Steps.**

1. **Briefs.** For every task × every service: resolve file hints, write
   `<worktree>/.pick-task/TASK.md` via the existing `briefMarkdown`, git-exclude
   the directory. Because every service is a per-task worktree, no two tasks
   share a brief path — the collision that forces worktrees in the first place.
2. **Folder set.** One workspace folder per task-service pair:

   ```ts
   tasks.flatMap((t) => t.services.map((s) => ({ name: `${t.ticket.key}-${s.name}`, path: s.path })))
   ```

   The `<KEY>-<repo>` name is required, not cosmetic: two worktrees of the same
   repo would otherwise present as two identically-named roots, and the folder
   name is what `@`-mentions resolve against — hence no spaces or separators
   beyond `-`.
3. **Target resolution.**
   - `new` / `current` → write `<workspaceDir>/<KEY1>+<N-1>.code-workspace` (e.g.
     `API-1+2.code-workspace`) holding the folder set; `openIn` is `new` or
     `current` respectively.
   - `existing` → `mergeReposIntoWorkspace(file, folderSet)`; it already merges
     additively, dedupes by canonical path, and reports `ok: false` without
     writing when the file cannot be parsed. `workspaceFile = file`.
   - `live-folder` → the folder set is **not** applied. VS Code offers no way to
     inject roots into another window, so `unaddedFolders` lists every folder and
     the caller warns. Sessions still seed into that window.
4. **Match path.** `workspaceFile ?? folder`. A saved `.code-workspace` is
   exactly what `windowIdentity()` reports for a workspace window
   ([`presence.ts`](../../../src/engine/presence.ts)), so the seed handshake
   matches without change.
5. **Plan files — one per task.** Each carries a single match
   `{ matchPath, prompt }`. Keeping one plan (and one `seeded:<key>:<identity>`
   guard) per task means re-taking a single task later behaves identically
   whether or not it was originally part of a batch. Plans gain an optional
   `seq?: number` (the task's index in the batch) so the seeder can order tabs by
   selection order even when N files share a `createdAt` millisecond.
6. **Prompts.** Built with `agentPrompt`, with two shared-window adjustments:
   - **`{brief}` is absolute.** `agentPrompt` hardcodes the relative
     `.pick-task/TASK.md`; with N worktree roots each holding that exact path, a
     relative reference is ambiguous. The shared path passes the absolute path of
     the task's **first** service's brief (every service's brief for a task has
     identical content).
   - **Mentions use the qualified folder name** rather than the bare repo name,
     so `@API-1-api/src/foo.ts` resolves to the right root:

     ```ts
     mention("multiroot", `${t.ticket.key}-${s.name}`, rel)
     ```
7. **Runs.** `writeRun` per task, so the Deck shows N cards for one window.
   `mode` is `"multiroot"` when there is a `workspaceFile`, else `"per-window"`;
   `repos` are the task's worktree refs.
8. **Open once.** A single `openInEditor(target, newWindow)`.

Remote Control is not offered on this path when there is more than one task; the
caller passes it through the existing `remoteControlNote` so the user is told it
was skipped.

### 5. Seeding N sessions (`src/engine/workspace.ts`)

Two changes to the seeder, both additive:

**`maybeSeedAgent` seeds every match, not the first.** It currently `return`s
after the first matching plan. It becomes: collect all plans whose match equals
this window's identity and whose `seeded:` guard is unset, sort by
`(createdAt, seq)`, then seed each in turn with a ~600 ms stagger. The consumed
guard is already keyed per ticket, so it needs no change; expired plans are still
pruned in the same pass. This covers both entry points unchanged — activation
(the `current`-window reload, and a brand-new window) and the plan-dir watcher
(an already-open `existing` or `live-folder` window).

**`seedClaudeCode` prefers the new-tab command when seeding a multi-session
batch.** A `multi` flag (true when this pass is seeding more than one plan)
makes it try `claude-vscode.editor.open(undefined, prompt)` first — which
stacks each session as a tab in the locked Claude editor group — before the
existing `claude-vscode.primaryEditor.open` → URI-handler chain. The final
clipboard fallback is **dropped when `multi`**: one clipboard cannot carry N
prompts, so instead the user gets a single message naming the briefs, which
carry the same context and are one click away in the folder roots.

### 6. Failure & edge cases

| Case | Behaviour |
| --- | --- |
| Some filter repos unresolvable | Dropped, named in a warning; abort only if none resolve. |
| Some filter repos non-git | Dropped, named in an info note; abort only if the set empties. |
| A task infers no repo in the set | Falls back to the whole (resolved, git) filter set. |
| `createWorktrees` falls back to the main checkout | That task fails and is reported; the rest launch. |
| Existing workspace unparseable | Opened as-is, folders not merged, `mergeFailed` reported — matches the single-task path. |
| Live-window destination | Sessions seed; folders are not added; `unaddedFolders` reported. Briefs are absolute, so the agents can still read them. |
| Claude Code missing / commands unregistered | URI handler, then (single only) clipboard, then the brief-pointer message. |
| Re-taking a key already in a batch | Overwrites its worktree, plan, and `Run`, exactly as a repeated single Take does. |

### 7. Settings

None added. `agentFlow.openIn`, `agentFlow.workspaceDir`, `agentFlow.seedAgent`,
`agentFlow.batchLaunchConfirmThreshold`, `agentFlow.trackOpenWindows` and
`agentFlow.remoteControl` all apply unchanged. `agentFlow.worktree` remains
overridden (forced on) for batches, as it is today.

## Files touched

- `src/webview/App.tsx` — gate to `>= 1`, drop `theRepo`, send `repos[]`, button
  title copy.
- `src/types.ts` — `takeBatch` message shape.
- `src/tasksView.ts` — `takeBatch` rewrite: repo-set resolution and guards,
  destination + layout picks, per-task repo inference, dispatch, toasts.
- `src/engine/workspace.ts` — export the shared helpers/constants/`PlanFile`;
  `maybeSeedAgent` seeds all matches with ordering + stagger; `seedClaudeCode`
  gains the `multi` path; `PlanFile.seq`.
- `src/engine/batchWorkspace.ts` — **new**: `openSharedWorkspace`.

## Testing

**`src/webview/App.tsx`** (`test/webview/App.test.tsx`)

- Checkboxes and the launch bar render with 1 repo selected *and* with 2+;
  absent with 0.
- Launch posts `takeBatch` with the selected keys and every selected repo name.
- Existing pruning/clearing assertions still hold when 2+ repos are selected.

**`src/tasksView.ts`** (`test/unit/tasksView.test.ts`)

- Unresolvable and non-git repo names are dropped with a message; the batch
  proceeds on the remainder; aborts when the set empties.
- Per-task repos are the inferred set ∩ the filter set; a task with no
  intersection gets the whole set.
- `chooseOpenTarget` is called exactly once for a batch.
- The layout pick appears for `new` + N > 1 and **not** for `current`,
  `existing`, `live-folder`, or a one-key batch.
- Prompt mode is asked once, not per task.
- A thrown failure on one key still launches the others and is reported.
- The confirm threshold fires above the limit and is skipped at/below it.

**`src/engine/batchWorkspace.ts`** (`test/unit/engine/batchWorkspace.test.ts`)

- One brief per task-service pair, each in its own worktree, none overwritten.
- Folder names are `<KEY>-<repo>` and are unique across two tasks in one repo.
- `new`/`current` writes `<KEY1>+<N-1>.code-workspace` containing every folder.
- `existing` merges additively and reports `mergeFailed` on an unparseable file
  without writing.
- `live-folder` adds no folders and reports every folder in `unaddedFolders`.
- One plan file **and** one `Run` per task, all sharing one `matchPath`; plans
  carry ascending `seq`.
- Prompts contain the absolute brief path and folder-qualified mentions.
- `openInEditor` is invoked exactly once.

**`src/engine/workspace.ts`** (`test/unit/engine/workspace.test.ts`)

- `maybeSeedAgent` seeds every matching plan, in `(createdAt, seq)` order, not
  just the first.
- An already-consumed plan is skipped while its siblings still seed.
- Expired plans are pruned in the same pass.
- `multi` prefers `claude-vscode.editor.open` and falls back to
  `primaryEditor.open` when it is unregistered.
- With `multi`, the clipboard fallback is not taken.

## Non-goals / YAGNI

- No multi-select with an empty repo filter.
- No per-task prompt mode or destination.
- No non-worktree batch launch.
- No Remote Control for N > 1.
- No new settings, and no new outbound message types — results still reuse
  `toast` / `loading`.
