# "This window" seeds in place instead of replacing the window

- **Date:** 2026-08-08
- **Branch:** `this-window-seeds-in-place`
- **Status:** Draft for review

## Problem

Taking a task offers four destinations — **New window**, **This window**, **Existing
workspace…**, and any live Agent Flow window (`chooseOpenTarget` in
[`src/tasksView.ts`](../../../src/tasksView.ts)). Three of them are additive: they open or
focus a window and seed a Claude Code session into it.

**This window** is the odd one out. It resolves to `openIn: "current"`, which calls
[`openInEditor`](../../../src/engine/workspace.ts) with `forceNewWindow: false` —
`vscode.openFolder` against the current window. That **swaps the window's folder set and
reloads the extension host**. Your open editors, terminals, and any running Claude session
in that window are gone. The picker's own copy admits it: *"replaces what's here."*

That is not what "this window" should mean. Picking the window you are already sitting in
should start a session *here*, in the window as it stands — the same additive act every
other destination performs.

## Chosen approach: route "current" through the existing live-window seeding path

The machinery already exists. A plan file in `~/.agentflow/plans/` names a `matchPath`;
every window runs a watcher (`watchPlansAndSeed`) that seeds Claude Code when a plan's
`matchPath` equals that window's identity (`windowIdentity()` in
[`src/engine/presence.ts`](../../../src/engine/presence.ts)). That is how the
`existing` and `live-folder` targets seed an already-open window with no reload.

`{ kind: "current" }` becomes the same thing pointed at **this** window: write a plan whose
single match is this window's own identity, and **skip `openInEditor` entirely**. The
watcher already running in this extension host picks the plan up and seeds. The `seeded:`
guard prevents a double-seed. No new seeding mechanism.

### Rejected alternatives

- **Merge the task's repos into this window first (workspace windows) / warn about
  unadded repos (folder windows)** — mirrors what a *live* window target does. Rejected:
  the point of "this window" is that the window is left alone. A folder-set mismatch is the
  user's call, and they already know what is open here.
- **Replace only when this window doesn't contain the task's repos.** Rejected: keeps the
  destructive reload reachable and makes it unpredictable — the same menu item would
  sometimes wipe the window and sometimes not.

## Behavior

| Target | Roots change? | Window reload? | Seed |
|---|---|---|---|
| New window | per `workspaceMode` | n/a (new) | on activation |
| **This window** | **none** | **none** | **via `fs.watch`, in place** |
| Existing workspace file | merged into file | none | via `fs.watch` |
| Live window — workspace | merged into its file | none | via `fs.watch` |
| Live window — folder | none | none | via `fs.watch` |

"This window" is now the only destination that changes nothing at all about the window it
targets.

## Architecture

### `src/engine/workspace.ts`

`OpenRequest` gains a `currentWindow` field, supplied by the caller so the engine stays
free of ambient `vscode.window` state and remains unit-testable:

```ts
currentWindow?: { identity: string; kind: "workspace" | "folder"; roots: WorkspaceFolder[] };
```

`openWorkspace` gains a branch for `openIn === "current"`, taken **before** the existing
`existingWorkspaceFile` / `existingFolder` / `mode` branches:

- `effMode` = the window's own shape — `"workspace"` → `multiroot`, `"folder"` →
  `per-window`. It describes the window rather than choosing one, so the repo count no
  longer decides it and **no `.code-workspace` file is generated**.
- Exactly **one match**, with `matchPath` = `currentWindow.identity`.
- The prompt gets the **absolute** brief path (`briefs[0].path`) rather than the default
  relative `.agentflow/BRIEF.md`, so `{brief}` resolves whether or not the task's repo is a
  root of this window. Same reasoning as the existing-workspace branch, which already does
  this for exactly this reason.
- File `@mentions` are emitted through `mentionInWorkspace(currentWindow.roots, …)` and
  dropped for files not under a root of this window. A mention naming a non-root repo
  resolves against a different checkout — worse than no mention.
- **No `openInEditor` call.** `opened` is `[currentWindow.identity]`.

Briefs are still written into every selected service repo, as with every other destination.

`openInEditor` loses its `newWindow` parameter entirely — after this change no caller
passes `false`, so the signature becomes `openInEditor(target: string)` with only the
new-window/focus behavior. Deleting the branch rather than leaving it unused is what makes
the folder-replacing reload unreachable.

**Side effect worth stating:** the current-window take now always produces one match, so
Remote Control — gated on `matches.length === 1` — becomes available for multi-repo
current-window takes, where it was previously withheld.

### `src/engine/batchWorkspace.ts`

`SharedTarget`'s `{ kind: "current" }` gets the same treatment: every task's plan names this
window's identity as its `matchPath` (the batch path already points all N plans at one
window, so this is a change of *which* path, not of shape), and the
`openInEditor(openTarget, target.kind !== "current")` call at line 189 is skipped for
`current`. `maybeSeedAgent` then seeds all N sessions here, staggered by the existing
`SEED_STAGGER_MS`.

### `src/tasksView.ts`

- `chooseOpenTarget` — the "This window" item's detail changes from *"Open it in the
  current window (replaces what's here)"* to *"Start a session here — keeps this window's
  folders"*. The item is **omitted when `windowIdentity()` is undefined** (see Edge cases).
- `chooseOpenTarget` — `cfg.openIn === "this-window"` with no window identity falls back to
  `{ kind: "new" }` and toasts why.
- `targetToOpenArgs` — `{ kind: "current" }` returns `mode` derived from the window's kind
  rather than `count === 1 ? "per-window" : "multiroot"`, and passes `currentWindow` through
  to `openWorkspace`.
- `prefillPathsForTarget` is unchanged: a current window still contributes nothing to
  prefill, because nothing is merged into it.
- Toast copy: `result.opened.length` renders as `"1 window(s)"` today. `OpenResult` gains
  `seededInPlace?: boolean`, set on the current-window branch, so the toast reads *"Seeded
  in this window"* instead.

Telemetry is unchanged — `DestinationProp` already has `"current"`, and it still means the
same destination.

## Edge cases

- **Empty windows and untitled multi-root windows have no identity.**
  [`presence.ts`](../../../src/engine/presence.ts) already states these are "neither
  trackable nor seedable" — a plan match cannot name them, so nothing would seed. Rather
  than add a second, direct-seeding code path for them, "This window" is omitted from the
  picker there, and the `this-window` setting falls back to a new window with a toast. An
  empty window has nothing to preserve, so nothing is lost by opening a new one.
- **This window doesn't contain the task's repos.** Allowed and expected — the destination
  is the window, not the repos. Mentions for those files are dropped and `{brief}` is
  absolute, so the seeded prompt is coherent rather than silently wrong.
- **A session is already running here.** Claude Code opens another session; this is exactly
  what the live-window destinations already do.
- **Same task taken into this window twice.** The `seeded:` guard is keyed on
  `key:createdAt:identity`, and each take writes a new `createdAt`, so a deliberate re-take
  seeds again while a watcher re-fire does not.
- **`seedAgent` off.** No plan file is written, so nothing seeds — and now nothing opens
  either, since the window is untouched. The toast must say the brief was written without
  claiming a window was opened.

## Testing

Vitest, matching `test/unit/engine/*` and `test/unit/tasksView.test.ts` (the `vscode` mock
lives in `test/_mocks/vscode.ts`):

- `workspace.test.ts` — the `current` branch: one match at the window identity; **no**
  `vscode.openFolder` / `open -a` invocation; no `.code-workspace` written for a multi-repo
  take; `effMode` from window kind; absolute `{brief}`; mentions filtered to files under
  this window's roots; `remoteControl` survives a multi-repo take.
- `workspace.test.ts` — `openInEditor` no longer accepts or performs a same-window reuse.
- `batchWorkspace.test.ts` — a `current` batch writes N plans all matching this window's
  identity and opens nothing.
- `tasksView.test.ts` — "This window" is present with the new copy when an identity exists
  and absent when it doesn't; `openIn: "this-window"` falls back to a new window with no
  identity; `targetToOpenArgs` derives mode from window kind.

Coverage on changed files must clear the repo's ≥95% bar; `npm run build` must pass in
addition to `tsc` and the suite.

## Out of scope (YAGNI)

- Adding roots to this window as part of a take (that is what the *Existing workspace* and
  live-window destinations are for).
- A direct, plan-file-free seeding path for identity-less windows.
- Changing what New window / Existing workspace / live-window targets do.
- Any change to `openIn`'s enum or default.

## Files touched

- `src/engine/workspace.ts` — `currentWindow` on `OpenRequest`; the `current` branch in
  `openWorkspace`; delete `openInEditor`'s reuse branch
- `src/engine/batchWorkspace.ts` — `current` target seeds in place
- `src/tasksView.ts` — picker copy + omission, `this-window` fallback, `targetToOpenArgs`,
  toast copy
- `test/unit/engine/workspace.test.ts`, `test/unit/engine/batchWorkspace.test.ts`,
  `test/unit/tasksView.test.ts`
- `README.md` — the "This window" destination no longer replaces the window
