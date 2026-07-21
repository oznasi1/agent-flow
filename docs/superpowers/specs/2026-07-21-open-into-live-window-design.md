# Open a task into an already-open window (+ Explore parity)

- **Date:** 2026-07-21
- **Branch:** `worktree-choose-workspace-on-start`
- **Status:** Draft for review

## Problem

When you take a task, Agent Flow lets you open it in a **New window**, **This window**,
or an **Existing workspace…** (`.code-workspace` file picked from `workspaceDir`, repos
merged in). See `chooseOpenTarget` / `pickExistingWorkspace` in
[`src/tasksView.ts`](../../../src/tasksView.ts).

Two gaps remain:

1. **You can't target a window that's already open.** If you already have a VS Code
   window running (a bare repo folder, or a saved workspace), there is no way to say
   "drop this task *there*." Your only choices spawn a new window or reload a file from
   disk. This matters even — especially — when the task touches **one** repo that you
   already have open.

2. **The Explore flow doesn't ask where to open.** `explore()` only asks multi-root vs
   per-window (`chooseWorkspaceMode`) and never offers New / This / Existing / live
   window. It should have the same "open where?" choice as taking a task.

## Constraint that shapes the design

VS Code gives an extension **no API to enumerate or target other windows**. Each window
is its own extension-host process; `vscode.workspace` only sees the current window. So
"open into an already-open window" is only possible if the extension **tracks what is
open itself**.

The codebase already has the pattern for cross-window coordination: the
`~/.agentflow/plans/` directory + `fs.watch` handshake that `maybeSeedAgent` and
`watchPlansAndSeed` use to seed the Claude Code agent in whichever window (re)opens
([`src/engine/workspace.ts`](../../../src/engine/workspace.ts#L311-L388)). The window
registry is the same idea applied to presence.

## Chosen approach: a filesystem window-presence registry

Every window the extension activates in records its presence on disk. The take/Explore
flows read that registry to list live windows as open targets.

### Rejected alternative

**Track only saved `.code-workspace` windows and annotate the existing picker.** Lighter
and reuses the merge logic, but a bare-repo-folder window (the exact single-repo case in
gap #1) is not a saved workspace file, so it would not be targetable. Rejected because it
misses the stated case.

## Architecture

### New module: `src/engine/presence.ts`

A window's **identity** is exactly the value `maybeSeedAgent` already computes for seed
matching, so a targeted window is guaranteed to seed:

- a `.code-workspace` file open in the window → its canonical file path (`kind: "workspace"`)
- otherwise a single folder open → that canonical folder path (`kind: "folder"`)
- otherwise (empty window, or untitled multi-root with no saved file) → **no identity**;
  the window is not trackable or targetable (and was never seedable either)

Presence record (`~/.agentflow/windows/<pid>.json`):

```jsonc
{
  "pid": 12345,            // this window's extension-host process id (process.pid)
  "identity": "/Users/…/foo.code-workspace" | "/Users/…/repo",
  "kind": "workspace" | "folder",
  "label": "foo.code-workspace",   // basename for display
  "folders": 3,                    // folder count (workspace) or 1 (folder)
  "updatedAt": 1699999999999       // stamped by the caller; presence.ts takes it as an arg
}
```

Pure/testable functions:

- `windowIdentity(): { identity, kind, label, folders } | undefined` — mirrors the
  identity logic in `maybeSeedAgent` (which will be refactored to call a shared helper so
  the two never drift).
- `writePresence(dir, record)` — best-effort write of this window's record.
- `readLiveWindows(dir): PresenceRecord[]` — read all records, **drop entries whose
  `pid` is dead** (`process.kill(pid, 0)` throws `ESRCH` for a dead pid), pruning the
  dead files as a side effect. Newest first.
- `removePresence(dir, pid)` — delete this window's file (deactivate cleanup).

Staleness is self-healing via pid-liveness — no timers or TTLs needed. A window that
crashed leaves a file whose pid no longer resolves, and the next `readLiveWindows` prunes
it.

### Wiring in `src/extension.ts`

Guarded by the new `agentFlow.trackOpenWindows` setting (default `true`):

- On `activate`: `writePresence(...)` for this window (inside the existing best-effort
  `try` block that already guards `maybeSeedAgent`, so a failure never breaks activation).
- Refresh on focus: `vscode.window.onDidChangeWindowState` → rewrite this window's record
  (bumps `updatedAt`, and re-asserts presence if the file was pruned). Registered as a
  disposable.
- On `deactivate`: best-effort `removePresence(dir, process.pid)`.

`Date.now()` is stamped in `extension.ts` and passed into `writePresence`, keeping
`presence.ts` free of ambient clock/IO where practical.

### Open-target picker: `src/tasksView.ts`

`OpenTarget` gains a variant:

```ts
type OpenTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }               // saved .code-workspace
  | { kind: "live"; identity: string; asWorkspace: boolean }; // already-open window
```

`chooseOpenTarget` (default `openIn: "ask"`) appends a **live windows** section built from
`readLiveWindows(...)`, excluding the current window's own identity (the existing "This
window" option already covers it). Each entry shows its label + folder count, e.g.
`$(window) foo.code-workspace — 3 folders` or `$(folder) my-repo`. If tracking is off or
no live windows exist, the section is simply absent — the picker is unchanged.

### Opening: `src/engine/workspace.ts`

- **Live window whose identity is a `.code-workspace`** → identical to the existing
  `existingWorkspaceFile` path: merge the task's repos into the file
  (`mergeReposIntoWorkspace`; VS Code live-reloads the file so the new folders appear),
  then open it with `open -a` (which **focuses** the already-open window, per the existing
  `openInEditor` new-window path), then seed. No code change beyond routing the identity
  into `existingWorkspaceFile`.
- **Live window whose identity is a folder** → new small case. `OpenRequest` gains
  `existingFolder?: string`. When set: `effMode` is per-window against that one folder;
  Agent Flow writes the task brief into that folder (so the seeded prompt's relative
  `{brief}` = `.pick-task/TASK.md` resolves there), opens it with `open -a` to focus the
  window, and seeds with `matchPath` = the folder identity. Briefs are still written into
  every selected service repo as today.

### Explore parity: `src/tasksView.ts`

`explore()` calls `chooseOpenTarget(cfg)` (same as `takeTask`) and passes the result into
`openWorkspace`, so Explore now offers New / This / Existing workspace / **Live window**
and honors `openIn`. The multi-root-vs-per-window question (`chooseWorkspaceMode`) still
applies only when opening a *new* window with more than one repo.

### Settings: `package.json` + `src/config.ts`

Add:

```jsonc
"agentFlow.trackOpenWindows": {
  "type": "boolean",
  "default": true,
  "description": "Track open Agent Flow windows so a task can be opened into a window you already have open."
}
```

`AgentFlowConfig` gains `trackOpenWindows: boolean`. `openIn`'s enum and default are
unchanged — a specific live window is inherently a per-take choice, not a static default.

## Behavior summary

| Target | Roots change? | How it opens | Seed |
|---|---|---|---|
| New window | per `workspaceMode` | new window / new workspace file | on activation |
| This window | reloads current | `vscode.openFolder` (reuse) | on activation reload |
| Existing workspace file | merged into file | `open -a` (may open/focus) | via `fs.watch` |
| **Live window — workspace** | merged into its file | `open -a` **focuses** it | via `fs.watch` |
| **Live window — folder** | none (can't inject roots) | `open -a` **focuses** it | via `fs.watch` |

## Edge cases

- **Target folder isn't one of the selected repos.** Allowed. We focus it and seed there
  (brief written into the folder). We toast which selected repos were *not* added as roots
  (a folder window can't gain roots remotely), so the outcome is never silently wrong.
- **A tracked window was closed between listing and picking.** `open -a <path>` simply
  opens it fresh; the seed still fires via the plan handshake. No error.
- **Stale/crashed window records.** Pruned on read via pid-liveness. `deactivate` also
  best-effort deletes.
- **Tracking disabled (`trackOpenWindows: false`).** No presence writes, no live-window
  section. Everything else behaves exactly as today.
- **Duplicate identities (same folder open twice).** Deduped by identity in the list.

## Testing

Vitest, matching the existing `test/unit/engine/*` and `test/unit/tasksView.test.ts`
style (the `vscode` mock lives in `test/_mocks/vscode.ts`):

- `presence.test.ts`: `windowIdentity` for workspace/folder/empty/untitled; `writePresence`
  round-trips; `readLiveWindows` drops dead pids and prunes their files, sorts newest
  first, dedupes identities; `removePresence`.
- `workspace.test.ts`: `existingFolder` path writes a brief into the folder, sets
  per-window mode + a matching seed `matchPath`; the workspace-identity path reuses the
  existing merge behavior.
- `tasksView.test.ts`: `chooseOpenTarget` appends live windows, excludes the current
  window, and is empty/hidden when tracking is off; `explore()` now routes through
  `chooseOpenTarget`.
- Refactor guard: `maybeSeedAgent` and `windowIdentity` share one helper (test that both
  agree on workspace/folder/empty identities).

## Out of scope (YAGNI)

- Enumerating windows via any private/unsupported VS Code API — we only track our own.
- Injecting root folders into an already-open **folder** window (VS Code offers no remote
  API; focus + seed is the behavior).
- A setting to make a specific live window the default target (it's inherently dynamic).
- Cross-machine / remote-SSH window tracking.

## Files touched

- **new** `src/engine/presence.ts` (+ `test/unit/engine/presence.test.ts`)
- `src/extension.ts` — presence lifecycle
- `src/tasksView.ts` — `OpenTarget` live variant, `chooseOpenTarget`, `explore()` parity
- `src/engine/workspace.ts` — `existingFolder` open path; share identity helper with
  `maybeSeedAgent`
- `src/config.ts` + `package.json` — `agentFlow.trackOpenWindows`
- `README.md` — document the live-window target + new setting
