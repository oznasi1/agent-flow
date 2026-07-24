# Design: Skip the repo picker when the destination is an existing workspace

**Date:** 2026-07-24
**Status:** Approved, ready for planning

## Summary

Today, after choosing a destination (`chooseOpenTarget`: New window · This window ·
Existing workspace… · live windows), both **Take** and **Explore** show a repo/service
multiselect quick-pick. When the destination is one the user *already has* — an existing
`.code-workspace` (the "Existing workspace…" file pick or a live workspace window) or a
live single-folder window — that picker is redundant: the destination already defines its
repos. This change **skips the picker for those destinations** and uses the repos already
present in the destination. New window / This window are unchanged (the picker still shows,
with Take pre-checking the ticket's inferred repos and Explore pre-checking nothing).

No config changes, no new message types, no change to the destination picker itself or to
the non-destructive `mergeReposIntoWorkspace`.

## Decisions

| Question | Decision |
|----------|----------|
| Which destinations skip the picker? | `target.kind === "existing"` (a `.code-workspace` file / live workspace window) **and** `target.kind === "live-folder"` (a live single-folder window). `new` and `current` keep the picker. |
| Which repos are used when the picker is skipped? | The repos **already in the destination** — the workspace's declared folders (`existing`) or the single folder (`live-folder`). Not inference. (Preselection, when present, takes precedence over this whole branch — see the preselection row below.) |
| Applies to both Take and Explore? | **Yes.** Take skips the picker for existing/live-folder; Explore does the same. New/This window keep the picker in both (Take pre-checks inferred; Explore pre-checks nothing) — unchanged. |
| Briefs when the picker is skipped? | The task brief is written into **each** current destination repo (they become the `services`, and `services` drives brief writing + @mentions), matching today's "whatever you picked gets briefed." |
| In-card preselection + an existing destination? | **Preselection still wins** and is untouched. The in-card path already skips the picker and merges the preselected repos into the destination non-destructively. The new "use current repos" behavior applies only when there is *no* preselection. |
| Repos in the destination that live outside `reposRoot`? | **Included.** The old picker only listed `reposRoot` repos and thus hid these; "use the current workspace repos" honors them. They are already in the workspace, so the merge is a no-op for them. |

## Approach rationale

- **The destination already answers "which repos".** For an existing workspace or a live
  folder window, the repo set is a property of the destination, not a fresh choice. Asking
  again only invites the user to re-confirm a list the destination already fixed.
- **Reuse `prefillPathsForTarget`.** It already returns the destination's canonical folder
  paths (via `workspaceFolderPaths` for `existing`, `[canon(folder)]` for `live-folder`).
  Deriving `ServiceRef`s from those paths keeps a single source of truth for "what does
  this destination contain."
- **Match discovered repos, fall back to the path.** A derived path that matches a repo
  from `discoverRepos` keeps that repo's `name`/`isGit`; an unmatched path (outside
  `reposRoot`) becomes `{ name: basename(path), path, isGit: has .git }`. This is why
  outside-`reposRoot` folders now participate, which the picker never allowed.
- **Leave preselection alone.** The in-card preselected path is a distinct, explicit user
  choice that already bypasses the picker; folding it into the new branch would discard an
  intentional selection. The new branch is strictly the "no preselection + existing/live
  destination" case.

## Behavior & flow

### Take a task (no in-card preselection)

```
→ how should the agent start?   (prompt mode, only when taskMode = "ask")
  read ticket · discover repos
  → Open where?   [New · This · Existing workspace… · live windows]
  → IF destination is existing / live-folder:  use its current repos   (NO picker)
    ELSE (new / current):                       pick services (inferred pre-checked)
  → worktree?
  → multi-root vs per-window   ONLY when destination = new window + >1 repo
  → open + seed
```

In-card preselected repos still skip the service pick as today, for every destination.

### Explore

```
pick action → topic
  → Open where?
  → IF destination is existing / live-folder:  use its current repos   (NO picker)
    ELSE (new / current):                       pick repos (nothing pre-checked)
  → multi-root vs per-window   ONLY when destination = new window + >1 repo
  → open + seed
```

## Deriving the repos: `servicesFromExistingDestination`

New private helper in `tasksView.ts`, thin glue over existing pure code:

```
servicesFromExistingDestination(target, repos): ServiceRef[]
```

- `paths = prefillPathsForTarget(target)` — canonical folder paths of the destination
  (`existing` → `workspaceFolderPaths(file)`; `live-folder` → `[canon(folder)]`).
- Build a `Map<canon(path), ServiceRef>` from the already-discovered `repos`.
- For each path: return the matched discovered `ServiceRef`, else construct
  `{ name: path.basename(p), path: p, isGit: fs.existsSync(join(p, ".git")) }`.
- Returns `ServiceRef[]` (may be empty if the workspace file is empty/unparseable — see
  edge cases).

Called only for `target.kind === "existing" | "live-folder"`; `new`/`current` never reach
it.

## Edge cases

- **Empty / unparseable existing workspace** → `workspaceFolderPaths` returns `[]` →
  derived `services` is `[]` → the existing `services.length === 0` guard toasts an error
  and aborts. Acceptable: there is nothing to seed.
- **`live-folder`** → always exactly one repo; never empty.
- **`targetToOpenArgs`** already forces `multiroot` for `existing` and `per-window` for
  `live-folder` and skips the multi-root-vs-per-window question for both, so passing the
  derived `services.length` changes nothing there.

## Surfaces (functions, signatures)

- **`resolveKickoff`** — branch order becomes: preselected (unchanged) → **existing /
  live-folder: `services = servicesFromExistingDestination(target, repos)`, no picker** →
  else (new / current): the existing service quick-pick (unchanged).
- **`explore()`** — same branch: existing / live-folder skip the repo quick-pick and use
  `servicesFromExistingDestination(target, repos)`; new / current keep the quick-pick with
  nothing pre-checked (unchanged).
- **New private helper** `servicesFromExistingDestination(target, repos)` in `tasksView.ts`.
- **`prefillPathsForTarget`**, **`chooseOpenTarget`**, **`targetToOpenArgs`**,
  **`mergeReposIntoWorkspace`**, **`workspaceFolderPaths`** — unchanged.
- No config changes; no `types.ts` message changes.

## Testing

`tasksView.test.ts` already mocks `window.showQuickPick` sequentially and asserts on the
`openWorkspace` call.

- **Take → existing workspace:** the service `showQuickPick` is **not** called; `openWorkspace`
  receives `services` equal to the workspace's folders. (Set the destination via
  `openIn: "pick-existing"` / a mocked existing target; mock `workspaceFolderPaths`.)
- **Take → live-folder:** picker not called; `services` is the single folder.
- **Take → new / current:** the service picker **is** shown (inferred pre-checked) — regression guard.
- **Preselection + existing:** picker not called; `openWorkspace` receives the *preselected*
  repos (not the workspace's), confirming preselection still wins.
- **Explore → existing / live-folder:** repo picker not called; `services` from the destination.
- **Explore → new / current:** repo picker shown, nothing pre-checked — regression guard.
- **Empty existing workspace:** derived `services` empty → aborts with the error toast, no
  `openWorkspace` call.
- Optionally unit-test `servicesFromExistingDestination` directly: matched paths reuse the
  discovered `ServiceRef`; unmatched paths are built from the path with the correct
  basename/`isGit`.

## Non-goals (YAGNI)

- No change to the destination picker's contents or ordering.
- No change to `mergeReposIntoWorkspace` or its safety valve.
- No change to the New / This window flows (picker still shown; Take still pre-checks inferred).
- No preservation of custom `.code-workspace` folder `name` fields — derived names use the
  discovered repo name or the folder basename.
- No new configuration keys.
