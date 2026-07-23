# Multi-select & parallel launch

## Problem

Today the task pool launches exactly one task at a time. A "Take" click sends a
single `{ type: "take" }` message ([`App.tsx`](../../../src/webview/App.tsx)
`TaskCard.take`), and the host walks an interactive chain of pickers — prompt
mode → destination → repo confirm → worktree → workspace mode — before
`openWorkspace` opens the window(s) and seeds one Claude Code agent
([`tasksView.ts`](../../../src/tasksView.ts) `takeTask` → `resolveKickoff` →
`launch`). There is no way to grab several related tasks in one repo and spin
them up **together**, each in its own isolated Claude session running in
parallel.

When you have narrowed the pool to a single repo, the tasks in view are all
touching the same codebase — a natural batch. Running several agents on that
repo at once is exactly what the existing git-worktree machinery
([`worktree.ts`](../../../src/engine/worktree.ts) `createWorktrees`) exists to
make safe: a per-task branch and working directory so parallel sessions never
collide.

## Goal

When the repo filter is narrowed to **exactly one repo**, let the user
multi-select tasks and launch them **in parallel** — each task in its own git
worktree (its own branch) with its own seeded Claude Code session. Ask the
shared "how should the agent start?" and "where should I open these?" questions
**once** for the whole batch; never per task.

## Scope

- A gated multi-select UI in the task pool: checkboxes on cards + a launch
  action bar, shown only when the repo filter resolves to one repo.
- A batch orchestrator on the host that hoists the two shared questions, forces
  worktrees, and launches every selected task.
- Two launch layouts, chosen once:
  - **Separate windows** — one window per task (the parallel core; reuses the
    existing per-window launch path essentially unchanged).
  - **One shared window** — all worktrees in a single multi-root window, with
    N Claude sessions seeded into it (behind a feasibility spike + fallback).
- Deck integration: each launched task records its own `Run` (already produced
  by `openWorkspace`).

Out of scope (decided during brainstorming):

- **Availability beyond a single filtered repo.** The feature is *only* offered
  when `selectedRepos.size === 1`. Zero repos or 2+ repos → no multi-select.
  Rationale: same-repo parallelism is the coherent, worktree-safe case, and it
  matches the mental model ("these tasks, that repo").
- **Per-task repo sets.** Each launched task opens a worktree in **only** the
  filtered repo, even if a task is inferred to touch others. Uniform and
  predictable; multi-repo-per-task is deferred.
- **A per-task prompt-mode or destination choice.** Both are asked once and
  applied to the whole batch.
- **Non-worktree parallel launch.** Worktrees are mandatory for the batch —
  they are what keep the per-task `.pick-task/TASK.md` briefs (and branches)
  from clobbering each other in the shared repo.

## Design

### 1. Selection UI (`src/webview/App.tsx`)

**Gate.** A derived `batchMode = selectedRepos.size === 1`. All the additions
below render only when `batchMode` is true; otherwise the pool looks and behaves
exactly as it does today.

**Checkboxes.** When `batchMode`, each visible `TaskCard` renders a checkbox at
the left of `.card-top` (before the chevron). Clicking it toggles the task in
the batch selection and must `stopPropagation()` so it does **not** expand the
card or start a drag.

**State.**

- Add `batchSelected: Set<string>` (task keys).
- Toggle helper mirrors the existing `toggleRepo`/`toggleStatus` pattern.
- **Pruning:** `batchSelected` is intersected with the currently-visible keys
  and cleared whenever the pool changes. Specifically: cleared on every `tasks`
  message (like `expanded`), and pruned to `visibleTasks` so a selection can
  never include a task the user can no longer see. Leaving single-repo mode
  (repo count → 0 or ≥2) hides the UI and the stale set is inert; clearing it on
  the next `tasks` message keeps it from resurfacing.

**Action bar.** A sticky bar at the bottom of the panel, shown when
`batchMode && batchSelected.size ≥ 1`:

```
┌──────────────────────────────────────────────┐
│  3 selected   [Clear]   [ Launch in parallel ▸ ] │
└──────────────────────────────────────────────┘
```

- **Launch in parallel** posts `{ type: "takeBatch", keys: [...batchSelected],
  repo: <the one selected repo> }`.
- **Clear** empties `batchSelected`.
- A **Select all visible** affordance sets `batchSelected` to the visible keys.

**No conflict with reorder.** `canReorder` already requires
`selectedRepos.size === 0`, so drag-reorder is inactive whenever `batchMode` is
on. No change needed there.

### 2. Message protocol (`src/types.ts`)

Add to `InboundMessage`:

```ts
| { type: "takeBatch"; keys: string[]; repo: string }
```

`repo` is the single selected repo's name (the webview already holds it in
`selectedRepos`). No new outbound message type — progress and results reuse the
existing `toast` / `loading` messages.

### 3. Host orchestration (`src/tasksView.ts`)

New handler `takeBatch(keys, repo)`, dispatched from `onMessage`. It hoists the
shared decisions, then launches each task:

1. **Auth gate** — reuse the `resolveKickoff` sign-in check.
2. **Resolve the repo** — `discoverRepos(...)`, find the `ServiceRef` whose
   `name === repo`. If not found, error toast and abort.
3. **Git guard** — if that repo is not a git repo (`!ref.isGit`), abort with
   `Batch launch needs a git repo (it opens a worktree per task).` Worktrees are
   mandatory (§4).
4. **Large-batch confirm** — if `keys.length >
   cfg.batchLaunchConfirmThreshold` (§7), a `showQuickPick`/`showWarningMessage`
   confirm: `Launch N parallel sessions?`. Abort on dismiss.
5. **Prompt mode — once.** Reuse the `takeTask` prompt-mode resolution (use
   `cfg.taskMode` if it names a known mode, else the existing picker). Applied
   to every task.
6. **Where — once.** A purpose-built two-option `showQuickPick`:
   - `$(multiple-windows) Separate windows` — one window per task *(default /
     recommended)* → per-task `openWorkspace(..., mode: "per-window", openIn:
     "new")`.
   - `$(window) One shared window` — all worktrees in a single multi-root
     window (§4, shared-window path).
7. **Launch loop** — for each key, resolve the ticket and launch (§4),
   collecting `{ key, ok, error? }`. One task's failure never aborts the rest.
8. **Summary toast** — `Launched 4 of 5 in parallel.` plus, when any failed,
   `Failed: API-18 (<reason>).`

The prompt-mode and destination picks happen **before** the loop, so the loop
itself is non-interactive (VS Code shows one modal at a time; interactive
per-task prompts would serialize the whole batch).

### 4. Launch mechanics (`src/engine/worktree.ts`, `src/engine/workspace.ts`)

**Worktrees are forced.** For every task: `createWorktrees([repoRef], key,
summary)` produces a `ServiceRef` pointing at `.claude/worktrees/<KEY>` on
branch `<KEY>-<slug>`. Because each key yields a distinct worktree directory,
each task's brief (`<worktree>/.pick-task/TASK.md`) is isolated — the
single-brief-per-repo collision that would otherwise break same-repo parallel
launches cannot happen.

**Separate windows (no new engine code).** The loop calls the existing
`openWorkspace` once per task:

```ts
openWorkspace({
  ticket, planMd: buildBrief(detail), descriptionText: detail.descriptionText,
  services: [worktreeRef], mode: "per-window", promptTemplate,
  workspaceDir: cfg.workspaceDir, seedAgent: cfg.seedAgent, openIn: "new",
});
```

Each worktree folder is its own window identity, so each opened window matches
its own plan file (keyed `<KEY>-<createdAt>`) and self-seeds its own Claude
session through the existing `maybeSeedAgent` / `watchPlansAndSeed` handshake.
Opens are **staggered ~250 ms** between iterations to reduce focus-stealing and
`open -a` thrash when many windows launch at once.

This path delivers the full parallel vision (N worktrees, N windows, N sessions)
using only machinery that already works and is already tested.

**One shared window (feasibility spike).** Create all N worktrees, open **one**
multi-root workspace whose folders are the N worktree dirs, then seed **N**
Claude sessions into that single window.

- **Spike:** the current seeder calls `claude-vscode.primaryEditor.open(session,
  prompt)` once per window and `maybeSeedAgent` returns after the first matching
  plan ([`workspace.ts`](../../../src/engine/workspace.ts) `seedClaudeCode`,
  `maybeSeedAgent`). Verify whether calling that command N times with distinct
  `session` arguments opens N distinct sessions, or whether a dedicated
  "new session" command exists. This is the sole unknown in the design.
- **Plan-file shape:** the shared-window plan needs to carry N prompts for one
  `matchPath` (the `.code-workspace` file). Extend a match to an optional
  `prompts: string[]` (or add a sibling field) and have `maybeSeedAgent`, when
  it matches a multi-prompt plan, call a new `seedManyClaudeSessions(prompts)`
  that loops the verified open command. Keep the existing single-prompt path
  untouched.
- **Fallback (if N-per-window is not reliable):** open all N worktrees in the
  shared window and auto-seed the **first** task's session; surface an info
  message noting each remaining worktree's prompt is in its
  `.pick-task/TASK.md`, ready to start with one click. The window layout still
  delivers; only the auto-start of the extra sessions degrades.

**Deck.** `openWorkspace` already calls `writeRun` per invocation, so the
separate-windows loop records one `Run` per task with no extra work. The
shared-window path must call `writeRun` **per task** as well (one window, N
runs) so every launched task appears on the Deck.

### 5. Failure & edge-case handling

- **Per-task isolation:** each launch is wrapped in `try/catch`; the loop
  continues past a failure and the summary toast reports it.
- **Non-git repo:** blocked up front (§3 step 3) — the checkboxes still render,
  but launch explains why it cannot proceed.
- **Empty selection:** the action bar only appears at `size ≥ 1`, and
  `takeBatch` no-ops on an empty `keys`.
- **Re-take:** relaunching a key overwrites its worktree / plan / `Run`, exactly
  as a repeated single Take does today.
- **Selection hygiene:** pruning to visible keys (§1) means a task filtered out
  by a status lens or title search after selection cannot be launched.

### 6. Styles (`src/webview/styles.ts`)

- `.card-check` — the per-card checkbox, aligned in `.card-top`.
- `.batch-bar` — the sticky action bar (count text, Clear, Launch button),
  matching the existing sidebar button/`.tab` visual language and theme
  variables.

### 7. Settings (`package.json` → `contributes.configuration`)

One new optional key:

| Setting | Default | Controls |
| --- | --- | --- |
| `agentFlow.batchLaunchConfirmThreshold` | `6` | Batch sizes strictly greater than this prompt a confirmation before launching, to prevent an accidental swarm of windows. |

Read in `config.ts` with a numeric fallback (`?? 6`). Everything else reuses
existing settings (`agentFlow.worktree` is effectively forced-on for the batch;
`agentFlow.seedAgent`, `agentFlow.workspaceDir` apply unchanged).

## Files touched

- `src/webview/App.tsx` — `batchMode` gate, per-card checkbox, `batchSelected`
  state + pruning, action bar, `takeBatch` send.
- `src/webview/styles.ts` — `.card-check`, `.batch-bar`.
- `src/types.ts` — `takeBatch` inbound message; (shared-window) optional
  `prompts` on a plan match.
- `src/tasksView.ts` — `takeBatch` handler: repo/git guards, large-batch
  confirm, once-only prompt-mode + destination picks, launch loop, summary
  toast.
- `src/engine/workspace.ts` — (shared-window) `seedManyClaudeSessions` and the
  multi-prompt plan branch in `maybeSeedAgent`; per-task `writeRun` in the
  shared-window layout.
- `src/config.ts` — read `batchLaunchConfirmThreshold`.
- `package.json` — `agentFlow.batchLaunchConfirmThreshold` contribution.

## Testing

- **`src/config.ts`** — `batchLaunchConfirmThreshold` defaults to `6`, honours
  an explicit value.
- **`src/webview/App.tsx`** (`test/webview/App.test.tsx`):
  - Checkboxes render only when exactly one repo is selected; absent at 0 or ≥2.
  - Toggling checkboxes builds `batchSelected`; the action bar shows the count.
  - **Launch in parallel** posts `takeBatch` with the selected keys and the one
    repo name.
  - Selection is pruned/cleared when the pool changes (new `tasks` message) and
    when a status/title filter hides a selected task.
  - Clicking a checkbox does not expand the card.
- **`src/tasksView.ts`** (`test/unit/tasksView.test.ts`):
  - `takeBatch` resolves the repo `ServiceRef`; aborts with a clear message when
    the repo is missing or non-git.
  - Prompt mode and destination are each requested **once**, not per task.
  - The launch loop invokes the launch path once per key; a thrown failure on
    one key still launches the others and is reported in the summary.
  - Large-batch confirmation triggers above the threshold and is skipped at/below
    it.
- **Engine** (`test/unit/engine/*`):
  - Worktree-per-key isolation: two keys in the same repo produce distinct
    worktree dirs and briefs (no clobber).
  - (Shared-window, if it lands) the multi-prompt plan branch and
    `seedManyClaudeSessions`; per-task `writeRun`.

## Non-goals / YAGNI

- No multi-select outside a single filtered repo.
- No per-task repo sets, prompt modes, or destinations.
- No non-worktree batch launch.
- No new outbound message types — progress/results reuse `toast` / `loading`.
- No live config-change watcher — settings apply on refresh/reload, like every
  other Agent Flow setting.

## Sequencing

The **separate-windows** path is fully deliverable with essentially no engine
change and delivers the parallel vision on its own; build it first. The
**shared-window** path depends on the seeding spike (§4); build it second within
the same effort, and fall back gracefully if the spike shows N-per-window
seeding is unreliable.
