# Design: "Existing workspace" as a third open target

**Date:** 2026-07-19
**Status:** Approved, ready for planning

## Summary

When taking a task, the user can currently open it in a **new window** or the
**current window**. This adds a third target: **pick an existing
`.code-workspace`**. Agent Flow writes the task briefs into the inferred repos as
it does today, **adds any of those repos that are missing** to the picked
workspace (non-destructively), opens it, and seeds the Claude Code agent — even
when that workspace is **already open** in a live window.

## Decisions

| Question | Decision |
|----------|----------|
| What does "existing workspace" list? | Existing `*.code-workspace` files under `agentFlow.workspaceDir`, newest first, plus a **Browse…** escape hatch (native dialog) for one that lives elsewhere. Not live OS windows, not a "recents" list. |
| Inferred repos not in the picked workspace? | **Add the missing ones** as folders, non-destructively (preserve comments, ordering, `settings`). Only degrade to "open as-is" if the file can't be parsed safely. |
| Seed a workspace that is already open? | **Yes.** Add a watcher on the plan dir so any already-open Agent Flow window seeds itself as soon as a matching task is taken — no reload required. |
| Workspace model for this path? | Always **multi-root** (a `.code-workspace` is inherently multi-root); the per-window question is skipped. |

## Approach rationale

- **List files, not live windows.** The VS Code extension API can't enumerate or
  inject into another window's extension host. Listing `.code-workspace` files is
  precise, and opening one that's already open makes VS Code focus that window —
  which, combined with the plan-dir watcher below, delivers "target an existing
  window" without any cross-window IPC.
- **`jsonc-parser` for the merge.** `.code-workspace` files are JSONC (comments
  allowed), so `JSON.parse` is unsafe. We add
  [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser) (tiny; the same lib
  VS Code uses) and edit with its **format-preserving `modify` / `applyEdits`**,
  so the user's comments, folder ordering, and `settings` survive untouched.
- **Plan-dir watcher over reload.** Seeding today only fires on extension
  *activation*. An already-open workspace won't reactivate, so a `fs.watch` on the
  plan dir lets every open window re-check and seed itself when a matching plan
  appears. Reuses the existing single-seed guard, so it can't double-seed.

## Behavior & flow

Extends [`chooseOpenTarget()`](../../../src/tasksView.ts) with a third item,
**`$(folder-library) Existing workspace…`**. Selecting it:

1. Shows a second quick-pick listing every `*.code-workspace` file under
   `agentFlow.workspaceDir`, sorted by mtime (newest first), each labelled with its
   filename and folder count, plus **`$(folder-opened) Browse…`** (native open
   dialog filtered to `.code-workspace`). Cancelling either pick aborts the take.
2. Writes briefs into the inferred repos (unchanged from today).
3. **Merges** missing repos into the picked workspace (§ Merge).
4. Opens the picked workspace (new window; VS Code focuses it if already open).
5. Seeds the agent via the plan handshake, matched on the picked workspace's path
   (§ Live seeding).

`mode` is forced to `multiroot` for this path.

## Merge: repos into the picked workspace (non-destructive)

New pure helper `mergeReposIntoWorkspace(file, repos)`:

- Parse the file tolerantly with `jsonc-parser`.
- Resolve each existing `folders[].path` against the workspace-file directory,
  canonicalize (`fs.realpathSync`), and build the set of paths already present.
- For each inferred repo whose canonical path is **not** in that set, append a
  `{ name, path }` folder entry (absolute path) using `jsonc-parser`'s `modify` +
  `applyEdits` so surrounding comments/formatting are preserved.
- **Idempotent**: re-taking a task already represented in the workspace adds
  nothing.
- **Safety valve**: if parsing fails, do **not** write — open the file as-is and
  toast a warning that repos weren't added. This is the only case where "add
  missing repos" degrades to "open as-is".

## Live seeding: plan-dir watcher

- In [`activate()`](../../../src/extension.ts), after the initial
  `maybeSeedAgent`, `fs.watch(PLAN_DIR)` (`~/.agentflow/plans`, created if absent).
- On change, debounced ~300 ms, call `maybeSeedAgent(context, log)` again.
- Every open Agent Flow window runs this; only the window whose identity matches
  the new plan seeds. The existing `seeded:<key>:<identity>` `globalState` guard
  prevents double-seeding.
- Registered as a disposable; closed in `deactivate()`.
- Side benefit: makes **new window** / **this window** seeding more robust too.

## Surfaces (config, types, functions)

- **`agentFlow.openIn`** enum gains `"pick-existing"` (with an `enumDescription`) so
  it can be a sticky default that jumps straight to the workspace list.
- **`chooseOpenTarget`** returns a union:
  `{ kind: "new" } | { kind: "current" } | { kind: "existing"; file: string }`.
- **`OpenRequest`** gains `existingWorkspaceFile?: string`. When set,
  `openWorkspace` skips generating `<KEY>.code-workspace`, runs the merge, and sets
  `workspaceFile` and the plan `matchPath` to the picked path. The `Run` record is
  stored as a normal multi-root run, so the Deck reopens it correctly.
- New pure helpers, kept unit-testable: `listWorkspaceFiles(dir)` and
  `mergeReposIntoWorkspace(file, repos)` (in `engine/workspace.ts` or a small
  `engine/existingWorkspace.ts`).
- New runtime dependency: `jsonc-parser`.

## Testing

- `mergeReposIntoWorkspace`: adds only-missing folders; preserves comments +
  `settings` + ordering; is idempotent; degrades safely (no write) on unparseable
  input; resolves relative existing-folder paths correctly.
- `listWorkspaceFiles`: scans + sorts by mtime, filters to `.code-workspace`
  (mocked fs).
- Both helpers are pure; the quick-pick wiring, watcher, and VS Code command paths
  stay thin around them.

## Non-goals (YAGNI)

- Enumerating live OS windows or a VS Code "recently opened" list — Browse covers
  the "anywhere on disk" case.
- Per-window mode for a picked workspace — a `.code-workspace` is always
  multi-root.
- Cloning or creating a workspace that doesn't exist yet.
