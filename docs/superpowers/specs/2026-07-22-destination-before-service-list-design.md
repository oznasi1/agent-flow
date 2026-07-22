# Design: Choose the destination before the service list

**Date:** 2026-07-22
**Status:** Approved, ready for planning

## Summary

Today, when you **Take** a task or **Explore**, you pick the repos (the "service
list") first and only afterwards choose where they open. This reorders both flows
so the **destination** is chosen first — the existing `chooseOpenTarget` picker
(New window · This window · Existing workspace… · live windows) runs **before**
the service list. Because the destination is now known up front, the service list
**pre-checks the repos the destination already contains** (an existing
`.code-workspace` or a live folder window), on top of Take's inferred repos.
Additionally, for **Take**, the prompt-mode question ("how should the agent
start?") moves to the very top of the flow.

No new configuration, no change to the destination picker's contents, and no
change to the non-destructive merge into an existing workspace.

## Decisions

| Question | Decision |
|----------|----------|
| What moves ahead of the service list? | The **whole** `chooseOpenTarget` picker (all four kinds), for both Take and Explore. Not a separate yes/no prompt. |
| Service list when the destination already has repos? | **Reorder + prefill.** Pre-check the repos already present in the chosen existing workspace / live folder window, in addition to Take's inferred repos. |
| Order of "how should the agent start?" (Take)? | **First** — before the destination and service list. Still shown only when `agentFlow.taskMode` is `"ask"` (a configured fixed mode skips it, as today). Explore has no prompt-mode pick, so it is unchanged. |
| Multi-root vs per-window question? | **Unchanged trigger** — already asked only for a brand-new window opening >1 repo. Existing workspace is always multi-root (no prompt); "this window" and live windows are derived silently. This spec only reorders it relative to the service list, not its trigger condition. |
| Prefill for New / This window? | **None.** New has nothing to prefill; "this window" *replaces* its folders rather than merging, so it is not an additive target. |

## Approach rationale

- **Destination-first is the natural decision order.** "Where am I landing" is a
  coarser choice than "which repos"; knowing it lets the service list reflect the
  target instead of being picked blind and then re-reconciled by the merge.
- **Prefill reuses existing parsing.** `mergeReposIntoWorkspace` already parses a
  `.code-workspace` with `jsonc-parser` and canonicalizes each `folders[].path`
  against the workspace-file directory. The prefill extracts the same set through a
  small pure helper, so the two stay consistent.
- **Only the additive targets prefill.** An existing `.code-workspace` and a live
  *folder* window are merge targets whose current contents matter; New and This
  window are not, so they prefill nothing.
- **Structure stays shared.** `resolveKickoff` (shared by Take and Address PR)
  absorbs the destination step so both kick-offs reorder identically; Explore
  reorders inline. Moving Take's prompt-mode pick above `resolveKickoff` keeps
  Address PR (which has no prompt-mode step) untouched.

## Behavior & flow

### Take a task (no in-card preselection)

```
→ how should the agent start?   (prompt mode)      ← NOW FIRST (only when taskMode = "ask")
  read ticket
  → Open where?   [New · This · Existing workspace… · live windows]
  → pick services   (inferred pre-checked ∪ destination's repos pre-checked)
  → worktree?
  → multi-root vs per-window   ONLY when destination = new window + >1 repo
  → open + seed
```

When services are **preselected in the expanded card**, the service quick-pick is
skipped as today; the destination is still chosen in `resolveKickoff` and prefill
is moot.

### Explore

```
pick action → topic
  → Open where?
  → pick repos   (destination's repos pre-checked; nothing else, as Explore has no inference)
  → multi-root vs per-window   ONLY when destination = new window + >1 repo
  → open + seed
```

## Prefill: repos the destination already contains

New pure helper in `engine/workspace.ts`:

```
workspaceFolderPaths(file: string): string[]
```

- Parse `file` tolerantly with `jsonc-parser`; read `folders[].path`.
- Resolve each path against the workspace-file directory and canonicalize
  (`canon`/`realpathSync`), mirroring `mergeReposIntoWorkspace`.
- Return canonical absolute paths; `[]` on unreadable/unparseable input.

Destination → prefill set (computed in `tasksView`):

| Destination kind | Prefill source |
|------------------|----------------|
| `existing` (a `.code-workspace` file — incl. a live *workspace* window) | `workspaceFolderPaths(file)` |
| `live-folder` (a live single-folder window) | `[canon(folder)]` |
| `new`, `current` | `[]` |

**Matching in the service quick-pick:** a discovered repo is pre-checked when its
`canon(path)` is in the destination's prefill set **or** (Take only) it is
inferred. Repos in the prefill set get a description tag — `in this workspace` (for
`existing`) / `open here` (for `live-folder`) — composed with any existing
`inferred (<reason>)` tag. Repos in the destination that live outside
`agentFlow.reposRoot` simply do not appear in the list; that is fine — the merge is
non-destructive and never removes them.

## Surfaces (functions, signatures)

- **`resolveKickoff(key, preselected)`** — adds the destination step: auth → read
  ticket → discover repos → `chooseOpenTarget` → compute prefill → service pick
  (prefilled) → returns `{ detail, services, target }` (was `{ detail, services }`).
  Cancelling the destination pick aborts (returns `undefined`) before any service
  pick.
- **`launch(detail, services, template, forceWorktree, target)`** — takes the
  resolved `target` as a parameter; no longer calls `chooseOpenTarget` itself; goes
  worktree decision → `targetToOpenArgs(target, …)` → `openWorkspace`.
- **`takeTask(key, preselected)`** — asks the prompt-mode pick **first**, then calls
  `resolveKickoff`, then `launch(…, target)`.
- **`explore()`** — moves `chooseOpenTarget` above the repo quick-pick; computes the
  prefill set and passes it into the pick; `targetToOpenArgs` is called after the
  repo pick as today.
- **`chooseOpenTarget`**, **`targetToOpenArgs`**, **`chooseWorkspaceMode`**,
  **`pickExistingWorkspace`**, **`mergeReposIntoWorkspace`** — unchanged.
- **New pure helper** `workspaceFolderPaths(file)` in `engine/workspace.ts`.
- No config changes; no `types.ts` message changes.

## Testing

- **`workspaceFolderPaths`** (unit, mocked fs — mirrors `listWorkspaceFiles` /
  `mergeReposIntoWorkspace` tests): reads folder paths; resolves relative paths
  against the file's directory; canonicalizes; returns `[]` on unparseable input and
  on a missing `folders` array.
- **`tasksView`**: the destination is chosen before the service quick-pick (both
  Take and Explore); destination folders are pre-checked in that pick; a cancelled
  destination pick aborts before any service pick; the in-card-preselected Take path
  still opens without a service quick-pick; Take's prompt-mode pick is asked first
  and a cancel there aborts cleanly; the multi-root-vs-per-window question fires only
  for a new-window, >1-repo destination.

## Non-goals (YAGNI)

- No change to the destination picker's contents or ordering of its items.
- No change to the non-destructive merge or its safety valve.
- No prefill for New / This window.
- No new configuration keys.
- No change to the trigger condition of the multi-root-vs-per-window question — only
  its position relative to the service list.
