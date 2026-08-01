# Design: Never silently add repos to an existing workspace

**Date:** 2026-08-02
**Status:** Approved, ready for planning

## Summary

When the destination is an existing `.code-workspace`, Agent Flow currently appends any
repo that isn't already a declared folder — silently, on every launch. The two cases that
trigger it are **worktrees** (created *after* the destination is chosen, so their paths are
never in the workspace) and **in-card preselection**; batch take hits it on every task.
Because [`createWorktrees`](../../../src/engine/worktree.ts) keeps the bare repo name, the
appended root is *also named* `api` — so a workspace with `api` grows a second root called
`api`, nested inside the first, and a third on the next take.

This change makes the file **write-only-on-approval**: a repo is never added when the
workspace already has a folder by that name, and anything genuinely new is added only
after an explicit prompt. Not adding roots breaks two things that today rely on the merge
having happened (`@mention` targeting and the relative brief path), so both are fixed here.

No new configuration key. No change to the destination picker, the repo picker, or the
new / this-window / live-folder destinations.

## Decisions

| Question | Decision |
|----------|----------|
| What happens instead of appending? | **Ask first.** A prompt appears only when at least one genuinely new repo remains after dedup; declining opens the workspace untouched. |
| What counts as "already in the workspace"? | **Any folder with that repo's name**, case-insensitive, regardless of path. Not path equality (today's rule) and not path containment. |
| Are name-duplicates surfaced? | **No prompt** — skipped silently, named in the success toast. |
| Does the worktree still happen? | **Yes.** The worktree question is untouched; the worktree is created and the task runs in it. Only the *workspace folder list* is left alone. |
| Which name does dedup compare? | The **bare repo name**, not the folder label. Batch labels are key-qualified (`PROJ-9-api`) and must still dedup against an existing `api`. |
| Does dismissing the prompt abort the launch? | **No** — it means "leave the workspace as-is". By then the worktrees exist and the launch is committed; the precedent is `resolveRemoteControl`. |
| New config key? | **No.** The prompt is unconditional when something new would be added. |
| Ever remove or rewrite an existing folder? | **Never.** The operation stays strictly additive-or-nothing. |

## Approach rationale

- **The workspace file is the user's artifact.** A saved `.code-workspace` is hand-curated
  state that outlives any single task. Mutating it as a side effect of taking a ticket is
  the defect; approval is the fix, and "no approval" must leave it byte-identical.
- **Name-dedup, not path-dedup, is what the user sees.** VS Code renders roots by name.
  Two roots called `api` are indistinguishable in the explorer and make `@api/…`
  ambiguous, which is precisely the harm — so the guard has to be the *name*, even though
  the paths genuinely differ.
- **A worktree needs no root of its own.** Worktrees live at
  `<repo>/.claude/worktrees/<KEY>`, i.e. *inside* the repo. If the main checkout is already
  a root, the worktree is already reachable and visible beneath it. Adding it as a sibling
  root buys nothing and costs a duplicate name.
- **Silence for duplicates, a prompt for new repos.** A duplicate has an unambiguous right
  answer (skip — the repo is there), so asking is noise. A genuinely new repo is a real
  change to the user's file, so it always asks.
- **Fix mentions rather than accept a wrong one.** Emitting `@api/src/foo.ts` when `api`
  resolves to the main checkout is worse than emitting nothing: it silently points the
  agent at the wrong tree and defeats the worktree isolation the user asked for.

## Behavior & flow

### Take / Address PR into an existing workspace

```
resolveKickoff:  destination = existing  →  services = the workspace's own folders
launch():
  → worktree?                     (unchanged)
  → services = createWorktrees(…) (unchanged; paths move into .claude/worktrees/<KEY>)
  → targetToOpenArgs              (unchanged → existingWorkspaceFile)
  → NEW: resolveWorkspaceAdditions
        plan = planWorkspaceMerge(file, candidates)
        plan.add empty          → no prompt, foldersToAdd = []
        plan.ok === false       → no prompt, foldersToAdd = []  (openWorkspace reports mergeFailed)
        otherwise               → prompt; "Add"  → foldersToAdd = plan.add
                                            "Leave as-is" / Esc → foldersToAdd = []
  → resolveRemoteControl          (unchanged)
  → openWorkspace({ …, foldersToAdd })
```

Worked example — `mine.code-workspace` declares `api` (`~/dev/api`) and `web` (`~/dev/web`);
take `PROJ-9` with a worktree across `api` + `infra`:

```
api    worktree ~/dev/api/.claude/worktrees/PROJ-9    → name "api" is taken  → duplicate, skipped
infra  worktree ~/dev/infra/.claude/worktrees/PROJ-9  → no root named infra  → new, offered
```

```
┌ Add infra to mine.code-workspace? ──────────────────────────────────┐
│ ▸ Add infra              Becomes a folder in the workspace, pointing│
│                          at this task's worktree                   │
│ ▸ Leave the workspace as-is                                         │
│     Opens in its worktree; the brief uses absolute paths            │
└──────────────────────────────────────────────────────────────────────┘
```

With more than one new repo the title pluralizes to the count and the affirmative item
lists them: `Add 2 folders to mine.code-workspace?` / `▸ Add infra, tooling`. It stays a
single-select yes/no — there is no per-repo toggle (that was considered and rejected: the
duplicates are the only thing worth per-item control, and they are never offered).

Toast on "Add": `Added infra. api is already in the workspace — its worktree wasn't added as a folder.`
Toast on "Leave as-is": `Left mine.code-workspace unchanged.`
The duplicates clause is omitted when `skipped` is empty, and the whole line is omitted
when nothing was offered.

### Explore into an existing workspace

Unchanged in effect. Explore has no worktrees and no preselection, and its services are
derived from the destination, so every candidate lands in `present` — no prompt, no write.
It goes through the same path for consistency.

### Batch take into an existing workspace

Same prompt, once, before opening. Candidates carry key-qualified labels
(`PROJ-9-api`) and bare repo names for dedup.

**Accepted consequence:** three tasks taken into a workspace that already has `api` yield
three `api` name-duplicates, all skipped, so the window keeps only its original roots. The
three sessions still seed correctly and their mentions resolve through the nested worktree
path, but the worktrees don't appear as roots. This follows directly from the name rule and
is accepted.

## Surfaces (functions, signatures)

### `src/engine/workspace.ts`

```ts
/** A folder that might be added to an existing workspace. `label` is the folder name
 *  written into the file; `repoName` is the bare repo name dedup compares on — batch
 *  labels are key-qualified (PROJ-9-api) but must still dedup against an existing `api`. */
export interface MergeCandidate { label: string; repoName: string; path: string }

export interface WorkspaceMergePlan {
  add: MergeCandidate[];        // neither path nor name present — offer these
  duplicates: MergeCandidate[]; // a folder with this repo's name exists at another path
  present: MergeCandidate[];    // already a declared folder by canonical path
  ok: boolean;                  // false when the file can't be read or safely parsed
}

/** Classify `candidates` against the folders `file` already declares. Reads only;
 *  never writes. On ok:false every bucket is empty — nothing can be safely added. */
export function planWorkspaceMerge(file: string, candidates: MergeCandidate[]): WorkspaceMergePlan;

/** A declared folder: its canonical absolute path and its `name` field when present. */
export interface WorkspaceFolder { name?: string; path: string }

/** The folders `file` declares. **`undefined`** if it can't be read or safely parsed —
 *  distinct from a valid file with no folders, which is `[]`. That distinction is the
 *  only thing that lets `planWorkspaceMerge` tell `ok:false` from "empty, add everything". */
export function workspaceFolders(file: string): WorkspaceFolder[] | undefined;

/** The @mention for `rel` inside the repo at `repoPath`, given the workspace's roots.
 *  Exact root match → `@<root>/<rel>`. Inside root R → `@<R>/<path from R>/<rel>` (the
 *  worktree case). Inside no root → undefined, and the caller drops the mention rather
 *  than emit one that resolves against a different checkout. */
export function mentionInWorkspace(
  roots: WorkspaceFolder[], repoPath: string, rel: string,
): string | undefined;
```

- **`workspaceFolderPaths`** becomes `(workspaceFolders(file) ?? []).map((f) => f.path)` —
  one reader, so "which folders does this workspace have" can't drift between the plan, the
  merge and `prefillPathsForTarget`. Its own `[]`-on-failure contract is unchanged, so
  `prefillPathsForTarget` needs no edit.
- **A root's name** is `name ?? path.basename(path)` — what VS Code displays and what
  `asRelativePath` prefixes.
- **The existing-name set** for dedup is, per declared folder, its `name` field **and** its
  path's basename, lowercased. A root `{"name": "API", "path": "~/dev/api"}` must dedup a
  candidate called `API` or `api`; comparing only one of the two would let a custom `name`
  field defeat the rule.
- **Containment picks the deepest root** when a path sits inside more than one, matching
  VS Code's most-specific-root behavior.
- **`mergeReposIntoWorkspace(file, folders)`** — parameter type widens from `ServiceRef[]`
  to `{ name: string; path: string }[]`. `ServiceRef` is structurally assignable, so both
  existing call sites compile unchanged. Its body is otherwise untouched: still additive,
  still `ok:false`-without-writing on a parse failure.
- **`OpenRequest`** gains `foldersToAdd?: { name: string; path: string }[]` — the approved
  folders, and the **only** thing merged. Absent or empty and the file is byte-identical.
  `openWorkspace` passes it straight to `mergeReposIntoWorkspace`; it no longer derives the
  list from `services`.
- **Mentions for the `existingWorkspaceFile` branch** read the roots *after* the merge and
  map through `mentionInWorkspace`, dropping `undefined`. This also fixes today's
  `mergeFailed` case, which emits `@name/…` mentions that resolve nowhere.
- **`{brief}` for the `existingWorkspaceFile` branch** becomes the absolute path of the
  first brief instead of the relative `.pick-task/TASK.md`, which names nothing when the
  repo isn't a root. Matches what `batchWorkspace` already does, for the same reason.

### `src/engine/batchWorkspace.ts`

- **`SharedOpenRequest`** gains `foldersToAdd?: { name: string; path: string }[]`; the
  `target.kind === "existing"` branch merges exactly that instead of every task's worktree.
- **`folderName(key, repo)`** is exported so `tasksView` can build candidate labels that
  match what the merge will write.
- **Mentions for the `existing` target** use `mentionInWorkspace` against the post-merge
  roots. The new-workspace and live-folder targets keep today's behavior: every folder in a
  freshly written workspace *is* a root, so `@<label>/<rel>` is already correct there.

### `src/tasksView.ts`

```ts
/** Resolve which folders (if any) the user wants added to an existing workspace
 *  destination. Never returns undefined: dismissing the prompt means "leave the
 *  workspace as-is", not "abort the launch" — see resolveRemoteControl. */
private async resolveWorkspaceAdditions(
  file: string, candidates: MergeCandidate[],
): Promise<{ foldersToAdd: { name: string; path: string }[]; skipped: string[] }>;
```

- Called from **`launch()`** (candidates: `{ label: s.name, repoName: s.name, path: s.path }`)
  and from the **batch** flow (candidates: `{ label: folderName(key, s.name), repoName: s.name, path: s.path }`).
- `skipped` is `plan.duplicates` repo names, for the toast. `present` contributes nothing to
  the toast — those repos are simply already there.
- **`prefillPathsForTarget`**, **`servicesFromExistingDestination`**, **`chooseOpenTarget`**,
  **`targetToOpenArgs`**, **`pickExistingWorkspace`** — unchanged.

## Edge cases

- **Unparseable / unreadable workspace file** → `planWorkspaceMerge` returns `ok:false`
  with empty buckets → no prompt, `foldersToAdd = []`. `openWorkspace` still calls
  `mergeReposIntoWorkspace`, which re-reads, fails to parse, and returns `ok:false` → the
  existing `mergeFailed` toast fires as today. No new plumbing.
- **Empty `folders` array** → no existing names, so every candidate is `new` and the prompt
  lists them all.
- **Custom folder `name` differing from its basename** → both strings join the dedup set
  (see Surfaces). Note `servicesFromExistingDestination` derives an unmatched folder's name
  from its *basename*, so without the basename half of the set a custom-named root wouldn't
  dedup against its own derived service.
- **Two batch tasks in the same repo, none of it in the workspace** → both are `new` and
  both are added, under distinct key-qualified labels. Dedup guards against duplicating what
  the workspace *already has*; key-qualified labels exist precisely so two tasks in one repo
  present as distinct roots (documented in `batchWorkspace`).
- **Worktree creation fell back to the main checkout** (non-git repo, or `git worktree add`
  failed) → the candidate path is the main checkout. If it's already a root it lands in
  `present`; if a *different* root shares its name it lands in `duplicates`. Either way,
  nothing is written.
- **Repo inside no root at all** (declined, or a duplicate name at an unrelated path) → its
  mentions are dropped. The brief's "Repos in scope" section still carries its absolute
  path, and `{brief}` is absolute, so the agent can still reach it.
- **`live-folder` destination** → untouched; VS Code can't inject roots into another window
  and the existing `unaddedRepos` reporting already covers it.

## Testing

**`test/unit/engine/workspace.test.ts`** — `planWorkspaceMerge`:

- exact canonical path already declared → `present`
- same repo name at a different path (the worktree case) → `duplicates`
- neither → `add`
- a root with a custom `name` dedups a candidate matching **either** that `name` or the
  path's basename
- case-insensitive: root `API` dedups candidate `api`
- unreadable / unparseable / `folders` not an array → `ok:false`, all buckets empty
- empty `folders` → every candidate in `add`
- batch-shaped candidates: label `PROJ-9-api`, `repoName` `api` → dedups against a root
  named `api`

`mentionInWorkspace`: exact root → `@api/src/foo.ts`; worktree inside the `api` root →
`@api/.claude/worktrees/PROJ-9/src/foo.ts`; nested roots → the deepest wins; inside no root
→ `undefined`.

`workspaceFolders` / `workspaceFolderPaths`: relative folder paths resolve against the
file's directory; the paths reader still agrees with the folders reader.

**`test/unit/tasksView.test.ts`** — this suite `vi.mock`s `src/engine/workspace` wholesale,
so it asserts on the **arguments** `openWorkspace` receives, not on file bytes. The
file-integrity assertions live in `workspace.test.ts` (above); here, `foldersToAdd: []` is
the observable proxy for "the file is not written". Its `vi.mock` factory must gain
`planWorkspaceMerge`, or every existing test in the file throws.

- **existing + worktree, all names already present** → the add-prompt `showQuickPick` is
  **not** shown, and `openWorkspace` receives `foldersToAdd: []`
- **existing + a genuinely new repo, "Leave the workspace as-is"** → prompt shown,
  `foldersToAdd: []`, launch still completes (`openWorkspace` called)
- **existing + a genuinely new repo, Esc** → same as "leave as-is"; the launch is not aborted
- **existing + a genuinely new repo, "Add"** → `foldersToAdd` is exactly that repo
- **existing + preselected repos already in the workspace** → no prompt, `foldersToAdd: []`
- **`planWorkspaceMerge` returns `ok:false`** → no prompt, `foldersToAdd: []`
- **duplicates reach the toast** → the success message names them as already present
- **batch + existing workspace where every repo name is present** → no prompt,
  `openSharedWorkspace` receives `foldersToAdd: []`
- **regression:** `new` / `current` / `live-folder` destinations show no add-prompt and pass
  no `foldersToAdd`

**`test/unit/engine/workspace.test.ts`** (same file, `openWorkspace` group):

- `foldersToAdd` absent/empty + `existingWorkspaceFile` → file byte-identical
- `foldersToAdd` merges exactly its own list, never anything derived from `services`
- mentions for a repo that isn't a root resolve through its containing root; a repo inside
  no root contributes no mention
- `{brief}` is the absolute brief path for the `existingWorkspaceFile` branch

## Non-goals (YAGNI)

- No new configuration key — the prompt is unconditional when something new would be added.
- No removing, reordering or rewriting existing workspace folders. Additive or nothing.
- No change to the destination picker, the repo picker, `servicesFromExistingDestination`,
  or the worktree question.
- No change to the `new` / `current` / `live-folder` destinations.
- No `files.exclude` management to surface or hide `.claude/worktrees/` in the explorer.
- No per-workspace memory of the answer, and no "ask once and remember".
- No key-qualified renaming of single-task folder labels (batch keeps its own).
